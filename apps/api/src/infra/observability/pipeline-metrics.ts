import { Injectable } from "@nestjs/common";
import { Counter, Gauge } from "prom-client";
import { MailQueue, MediaQueue } from "../queue/queue.module.js";
import { OUTBOX_MAX_ATTEMPTS } from "../outbox/outbox.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { registry } from "./metrics.js";

/**
 * The pipeline gauges (docs/ops/observability.md §2, item 3 of its build order).
 *
 * These describe state that lives in Postgres and Redis — rows in an outbox, a
 * queue's depth, how old the newest rollup is — rather than events this process
 * counted. That difference decides everything about how they are collected.
 *
 * ## Why these are read at scrape time and not written by the worker
 *
 * The obvious implementation is to have the five-minute `dead-letter-check` job
 * compute these and `.set()` them. It is also wrong, in a way that is invisible
 * until the day it matters.
 *
 * A gauge set by a job reports the last value that job wrote. If the worker
 * dies, nothing overwrites them, and `outbox_dead_lettered` sits at 0 and
 * `queue_depth` sits at whatever was true at the moment the process stopped.
 * The dashboard stays green. The alerts stay quiet. And the specific failure
 * these metrics exist to catch — the pipeline stopping — is the exact failure
 * that would prevent them from being updated. A metric that reports health by
 * not being written is not a monitor, it is a decoration.
 *
 * Reading at scrape time inverts that. The value is computed by whoever is
 * being asked, so it is true as of the question. The API can answer for the
 * worker because all of this state is shared, and an outside observer is the
 * right one to ask anyway: "is the worker keeping up" answered by the worker is
 * a question that stops being answered at the moment the answer becomes
 * interesting.
 *
 * ## Why this is affordable
 *
 * Every scrape runs these queries, so cheap is a correctness property, not an
 * optimisation. Both are index reads, measured rather than assumed:
 *
 *   outbox counts    3 buffers, 0.04ms against 500,000 rows of history
 *                    — the `outbox_unpublished` partial index holds only the
 *                      backlog, so the cost tracks the backlog and not history
 *   rollup staleness 4 buffers, 0.04ms against 241,000 rollup rows
 *                    — see migration 27, which exists purely for this and
 *                      replaced a 15ms parallel seq scan
 */

/** How long any one collector may take before it is abandoned for this scrape. */
const COLLECT_TIMEOUT_MS = 2_000;

const outboxPending = new Gauge({
  name: "outbox_pending",
  help: "Outbox events written but not yet published.",
  registers: [registry],
});

const outboxDeadLettered = new Gauge({
  name: "outbox_dead_lettered",
  help: `Outbox events parked after ${OUTBOX_MAX_ATTEMPTS} failed publishes. Non-zero means staff screens have stopped hearing about something.`,
  registers: [registry],
});

const queueDepth = new Gauge({
  name: "queue_depth",
  help: "BullMQ jobs by queue and state.",
  // `state` is not in the spec's table, which asks only for a depth per queue.
  // It is here because one number cannot tell apart the three ways a queue goes
  // wrong: backed up (waiting climbing), stuck (active flat and non-zero while
  // waiting climbs), and failing (failed climbing). Two queues by four states
  // is eight series, which is not a cardinality problem by any measure.
  labelNames: ["queue", "state"],
  registers: [registry],
});

const rollupStaleness = new Gauge({
  name: "rollup_staleness_seconds",
  help: "Age of the newest row in daily_store_sales. Every reporting screen reads a rollup; if the sweep stops the figures do not go missing, they go quietly stale.",
  registers: [registry],
});

const jobLastRunAge = new Gauge({
  name: "job_last_run_age_seconds",
  help: "Time since a scheduled job last claimed a pass. Only jobs that take a lease appear — see the note in PipelineMetrics.",
  labelNames: ["job"],
  registers: [registry],
});

const collectFailures = new Counter({
  name: "pipeline_metrics_collect_failures_total",
  help: "Scrapes where a pipeline collector failed or timed out.",
  labelNames: ["collector"],
  registers: [registry],
});

@Injectable()
export class PipelineMetrics {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailQueue,
    private readonly media: MediaQueue,
  ) {}

  /**
   * Refreshes every gauge. Called immediately before a scrape is served.
   *
   * The collectors are independent and run together: one of them being slow
   * should cost the scrape its latency, not its other metrics. Each is
   * separately guarded, because an unhandled rejection here would reject
   * `registry.metrics()` and take down the *whole* scrape — losing
   * `http_request_duration` too, at exactly the moment something is wrong.
   */
  async refresh(): Promise<void> {
    await Promise.all([
      this.guard("outbox", () => this.collectOutbox()),
      this.guard("rollup", () => this.collectRollup()),
      this.guard("jobs", () => this.collectJobRuns()),
      this.guard("queues", () => this.collectQueues()),
    ]);
  }

  /**
   * Runs one collector, bounded, and reports "I do not know" as absence.
   *
   * On failure the gauges are cleared rather than left where they were or
   * zeroed. Both alternatives state something false: a retained value claims a
   * freshness it does not have, and zero claims positive health. Removing the
   * series makes the gap visible to `absent()` and leaves a hole in the graph
   * that reads as a hole rather than as good news.
   *
   * How to clear differs per gauge, and getting it wrong reintroduces exactly
   * the false zero this avoids — see `CLEAR_BY_COLLECTOR`.
   */
  private async guard(collector: string, run: () => Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${collector} collector timed out`)),
            COLLECT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      collectFailures.inc({ collector });
      CLEAR_BY_COLLECTOR[collector]?.();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Both outbox counts in one statement.
   *
   * `count(*) FILTER` rather than two queries: they are answered by the same
   * index scan over the same rows, and splitting them would double the round
   * trips to disagree with itself between them.
   */
  private async collectOutbox(): Promise<void> {
    const [row] = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ pending: bigint; dead: bigint }[]>`
        SELECT count(*) FILTER (WHERE attempts < ${OUTBOX_MAX_ATTEMPTS}) AS pending,
               count(*) FILTER (WHERE attempts >= ${OUTBOX_MAX_ATTEMPTS}) AS dead
        FROM outbox_events
        WHERE published_at IS NULL
      `,
    );

    outboxPending.set(Number(row?.pending ?? 0));
    outboxDeadLettered.set(Number(row?.dead ?? 0));
  }

  /**
   * How old the newest rollup row is.
   *
   * `max()` answers "did the sweep stop", which is the condition worth paging
   * for. It deliberately does not answer "did the sweep fail for some stores":
   * that would need a reading per store, which is a series per shop and the
   * cardinality problem the HTTP metrics went out of their way to avoid.
   *
   * It has one honest false alarm. `runIncremental` only writes rows for stores
   * with trade in the window, so a platform-wide quiet spell ages this gauge
   * even though nothing is broken. `job_last_run_age_seconds{job="sales-rollup"}`
   * is what tells the two apart, which is why it is collected next to this one:
   * stale data plus a recent pass is a quiet weekend, stale data plus no pass is
   * a stopped worker.
   */
  private async collectRollup(): Promise<void> {
    const [row] = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ age_seconds: number | null }[]>`
        SELECT EXTRACT(EPOCH FROM (now() - max(computed_at)))::float8 AS age_seconds
        FROM daily_store_sales
      `,
    );

    // No rows at all on a platform that has never traded. Absent rather than
    // zero: zero would claim a rollup ran a moment ago.
    if (row?.age_seconds == null) rollupStaleness.remove();
    else rollupStaleness.set(row.age_seconds);
  }

  /**
   * Time since each scheduled job last took a pass.
   *
   * Only jobs marked `exclusive` appear, because only those claim a lease —
   * `outbox-relay` runs on every worker at once by design and writes no row.
   * That is not a gap worth closing: a relay that has stopped shows up
   * immediately as `outbox_pending` climbing, which is the symptom rather than
   * the proxy.
   */
  private async collectJobRuns(): Promise<void> {
    const rows = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ job_name: string; age_seconds: number }[]>`
        SELECT job_name,
               EXTRACT(EPOCH FROM (now() - last_started_at))::float8 AS age_seconds
        FROM scheduled_job_runs
      `,
    );

    // Cleared first so a job that is removed from the schedule stops reporting
    // an age that grows forever and eventually pages somebody about a job that
    // no longer exists.
    jobLastRunAge.reset();
    for (const row of rows) jobLastRunAge.set({ job: row.job_name }, row.age_seconds);
  }

  /**
   * Depth of both BullMQ queues.
   *
   * A mail queue that stops draining withholds password resets and suspension
   * warnings, and does it silently — the send is asynchronous, so nothing in
   * the request path notices.
   */
  private async collectQueues(): Promise<void> {
    const queues: [string, MailQueue | MediaQueue][] = [
      ["mail", this.mail],
      ["media", this.media],
    ];

    await Promise.all(
      queues.map(async ([name, queue]) => {
        const counts = await queue.jobCounts();
        for (const [state, count] of Object.entries(counts)) {
          queueDepth.set({ queue: name, state }, count);
        }
      }),
    );
  }
}

/**
 * How to make each collector's gauges absent when it cannot answer. See `guard`.
 *
 * `remove()` for the unlabelled gauges and `reset()` for the labelled ones, and
 * the difference is not stylistic. In prom-client `reset()` on a gauge with no
 * labels re-initialises it to **zero** — it does not remove the series — so
 * clearing `outbox_dead_lettered` that way would publish a confident 0 during a
 * database outage, which is the precise false reassurance this whole class is
 * built to avoid. `remove()` deletes the sample so nothing is rendered at all.
 *
 * For labelled gauges the reverse holds: `reset()` drops every series, whereas
 * `remove()` needs the exact label values, which are not known here.
 *
 * Verified against prom-client rather than assumed, after the tests below
 * caught the unlabelled case reporting zero.
 */
const CLEAR_BY_COLLECTOR: Record<string, () => void> = {
  outbox: () => {
    outboxPending.remove();
    outboxDeadLettered.remove();
  },
  rollup: () => rollupStaleness.remove(),
  jobs: () => jobLastRunAge.reset(),
  queues: () => queueDepth.reset(),
};
