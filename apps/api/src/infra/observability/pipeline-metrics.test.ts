import { beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "./metrics.js";
import { PipelineMetrics } from "./pipeline-metrics.js";

/**
 * A PrismaService stand-in whose `withTenant` hands the callback a `tx` whose
 * `$queryRaw` returns whatever the test queued. Enough to drive the collectors
 * without a database, which is what makes the failure paths testable at all —
 * those are the ones that matter and the hardest to produce for real.
 */
function fakePrisma(answers: unknown[] | (() => never)) {
  const queue = Array.isArray(answers) ? [...answers] : answers;
  return {
    withTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: () => {
          if (typeof queue === "function") return queue();
          return Promise.resolve(queue.shift() ?? []);
        },
      }),
  } as never;
}

function fakeQueue(counts: Record<string, number> | (() => never)) {
  return {
    jobCounts: () => (typeof counts === "function" ? counts() : Promise.resolve(counts)),
  } as never;
}

/** The rendered value of a single-series gauge, or undefined when absent. */
async function gaugeValue(name: string): Promise<number | undefined> {
  const metric = await registry.getSingleMetric(name)?.get();
  return metric?.values[0]?.value;
}

async function seriesFor(name: string): Promise<{ labels: Record<string, unknown>; value: number }[]> {
  const metric = await registry.getSingleMetric(name)?.get();
  return (metric?.values ?? []) as { labels: Record<string, unknown>; value: number }[];
}

const healthy = () => [
  [{ pending: 7n, dead: 2n }], // outbox
  [{ age_seconds: 120.5 }], // rollup
  [
    { job_name: "sales-rollup", age_seconds: 61 },
    { job_name: "dead-letter-check", age_seconds: 12 },
  ],
];

describe("pipeline metrics", () => {
  beforeEach(() => {
    // `remove()` for the unlabelled gauges: `reset()` would set them to zero
    // rather than clearing them. See CLEAR_BY_COLLECTOR.
    for (const name of ["outbox_pending", "outbox_dead_lettered", "rollup_staleness_seconds"]) {
      (registry.getSingleMetric(name) as { remove: () => void } | undefined)?.remove();
    }
    for (const name of ["job_last_run_age_seconds", "queue_depth"]) {
      registry.getSingleMetric(name)?.reset();
    }
  });

  it("reads the outbox counts, both from one pass", async () => {
    const metrics = new PipelineMetrics(fakePrisma(healthy()), fakeQueue({}), fakeQueue({}));
    await metrics.refresh();

    expect(await gaugeValue("outbox_pending")).toBe(7);
    expect(await gaugeValue("outbox_dead_lettered")).toBe(2);
  });

  it("reports rollup staleness in seconds", async () => {
    const metrics = new PipelineMetrics(fakePrisma(healthy()), fakeQueue({}), fakeQueue({}));
    await metrics.refresh();

    expect(await gaugeValue("rollup_staleness_seconds")).toBe(120.5);
  });

  it("labels queue depth by queue and state", async () => {
    const metrics = new PipelineMetrics(
      fakePrisma(healthy()),
      fakeQueue({ waiting: 4, active: 1, delayed: 0, failed: 3 }),
      fakeQueue({ waiting: 0, active: 0, delayed: 0, failed: 0 }),
    );
    await metrics.refresh();

    const series = await seriesFor("queue_depth");
    expect(series).toContainEqual(
      expect.objectContaining({ labels: { queue: "mail", state: "failed" }, value: 3 }),
    );
    expect(series).toContainEqual(
      expect.objectContaining({ labels: { queue: "mail", state: "waiting" }, value: 4 }),
    );
    // Bounded: two queues, four states, and nothing per-store or per-job.
    expect(series).toHaveLength(8);
  });

  it("gives every scheduled job its own age", async () => {
    const metrics = new PipelineMetrics(fakePrisma(healthy()), fakeQueue({}), fakeQueue({}));
    await metrics.refresh();

    const series = await seriesFor("job_last_run_age_seconds");
    expect(series).toContainEqual(
      expect.objectContaining({ labels: { job: "sales-rollup" }, value: 61 }),
    );
  });

  it("drops a job that is no longer scheduled instead of ageing it forever", async () => {
    // Otherwise a job removed from the schedule keeps reporting a number that
    // climbs until somebody is paged about work that no longer exists.
    const prisma = fakePrisma([
      ...healthy(),
      [{ pending: 0n, dead: 0n }],
      [{ age_seconds: 1 }],
      [{ job_name: "sales-rollup", age_seconds: 5 }],
    ]);
    const metrics = new PipelineMetrics(prisma, fakeQueue({}), fakeQueue({}));

    await metrics.refresh();
    expect(await seriesFor("job_last_run_age_seconds")).toHaveLength(2);

    await metrics.refresh();
    const series = await seriesFor("job_last_run_age_seconds");
    expect(series).toHaveLength(1);
    expect(series[0]!.labels).toEqual({ job: "sales-rollup" });
  });

  it("removes the series when a collector fails, rather than holding a stale value", async () => {
    // The whole point of collecting at scrape time. A retained value claims a
    // freshness it does not have and a zero claims health, so "I could not find
    // out" has to render as absence — which is what `absent()` alerts on.
    const metrics = new PipelineMetrics(fakePrisma(healthy()), fakeQueue({}), fakeQueue({}));
    await metrics.refresh();
    expect(await gaugeValue("outbox_pending")).toBe(7);

    const broken = new PipelineMetrics(
      fakePrisma(() => {
        throw new Error("connection refused");
      }),
      fakeQueue({}),
      fakeQueue({}),
    );
    await broken.refresh();

    expect(await gaugeValue("outbox_pending")).toBeUndefined();
    expect(await gaugeValue("rollup_staleness_seconds")).toBeUndefined();
  });

  it("keeps one broken collector from taking down the others", async () => {
    // A failed scrape loses every metric in the registry, including the HTTP
    // ones, at precisely the moment somebody is looking at them.
    const metrics = new PipelineMetrics(
      fakePrisma(healthy()),
      fakeQueue(() => {
        throw new Error("redis is gone");
      }),
      fakeQueue({}),
    );

    await expect(metrics.refresh()).resolves.toBeUndefined();
    expect(await gaugeValue("outbox_pending")).toBe(7);
    expect(await seriesFor("queue_depth")).toHaveLength(0);
  });

  it("counts a collector failure so the blind spot is itself visible", async () => {
    const before = (await seriesFor("pipeline_metrics_collect_failures_total")).length;
    const metrics = new PipelineMetrics(
      fakePrisma(() => {
        throw new Error("nope");
      }),
      fakeQueue({}),
      fakeQueue({}),
    );
    await metrics.refresh();

    const failures = await seriesFor("pipeline_metrics_collect_failures_total");
    expect(failures.length).toBeGreaterThan(before - 1);
    expect(failures.some((f) => f.labels.collector === "outbox" && f.value > 0)).toBe(true);
  });

  it("reports no rollup rather than a rollup from a moment ago on an empty platform", async () => {
    const metrics = new PipelineMetrics(
      fakePrisma([[{ pending: 0n, dead: 0n }], [{ age_seconds: null }], []]),
      fakeQueue({}),
      fakeQueue({}),
    );
    await metrics.refresh();

    expect(await gaugeValue("rollup_staleness_seconds")).toBeUndefined();
  });

  it("abandons a collector that hangs instead of holding the scrape open", async () => {
    vi.useFakeTimers();
    try {
      const metrics = new PipelineMetrics(
        fakePrisma(healthy()),
        fakeQueue({}),
        { jobCounts: () => new Promise(() => {}) } as never,
      );

      const done = metrics.refresh();
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(done).resolves.toBeUndefined();

      expect(await seriesFor("queue_depth")).toHaveLength(0);
      expect(await gaugeValue("outbox_pending")).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });
});
