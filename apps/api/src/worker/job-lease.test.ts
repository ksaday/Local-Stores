import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../infra/prisma/prisma.service.js";
import { JobLease } from "./job-lease.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const JOB = "test-sweep";

/**
 * Four clients standing in for four worker processes.
 *
 * Each gets its *own* `PrismaService`, and therefore its own connection pool.
 * That detail is the test: sharing one pool lets the claims queue up behind
 * each other, and a read-then-write implementation passes — verified by
 * writing one and watching this suite stay green. Separate pools let the
 * statements genuinely overlap, which is what two workers do.
 */
const pools: PrismaService[] = [];
let workers: JobLease[] = [];
let workerA: JobLease;
let workerB: JobLease;

beforeAll(() => {
  for (let i = 0; i < 4; i += 1) {
    pools.push(new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never));
  }
  workers = pools.map((pool) => new JobLease(pool));
  [workerA, workerB] = workers as [JobLease, JobLease];
});

beforeEach(async () => {
  await reset();
});

afterAll(async () => {
  await reset();
  await Promise.all(pools.map((pool) => pool.$disconnect()));
});

async function reset(): Promise<void> {
  const admin = new PrismaService();
  try {
    await admin.$executeRaw`DELETE FROM scheduled_job_runs WHERE job_name LIKE 'test-%'`;
  } finally {
    await admin.$disconnect();
  }
}

/** Pretends the last claim happened `ms` ago, without waiting that long. */
async function ageClaim(ms: number): Promise<void> {
  const admin = new PrismaService();
  try {
    await admin.$executeRaw`
      UPDATE scheduled_job_runs
      SET last_started_at = now() - make_interval(secs => ${ms / 1000}::double precision)
      WHERE job_name = ${JOB}`;
  } finally {
    await admin.$disconnect();
  }
}

describe("claiming a scheduled pass", () => {
  it("lets the first worker through and turns the second away", async () => {
    expect(await workerA.claim(JOB, 60_000)).toBe(true);
    expect(await workerB.claim(JOB, 60_000)).toBe(false);
  });

  it("gives exactly one winner when both arrive at once", async () => {
    // The real shape of it: every worker's timer fires on the same beat, so
    // the claims are genuinely concurrent rather than one-then-the-other.
    const results = await Promise.all(workers.map((w) => w.claim(JOB, 60_000)));

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("hands the job back once the interval has passed", async () => {
    expect(await workerA.claim(JOB, 60_000)).toBe(true);
    await ageClaim(61_000);

    // A different worker may take the next pass. Nothing pins a job to the
    // process that ran it last.
    expect(await workerB.claim(JOB, 60_000)).toBe(true);
  });

  it("does not free the job early", async () => {
    expect(await workerA.claim(JOB, 60_000)).toBe(true);
    await ageClaim(30_000);

    expect(await workerB.claim(JOB, 60_000)).toBe(false);
  });

  /**
   * A worker that is killed mid-sweep holds nothing: what it took was a
   * timestamp, and the next interval hands the job to whoever is still alive.
   * A held lock would have needed releasing by a process that no longer exists.
   */
  it("recovers from a worker that never came back", async () => {
    expect(await workerA.claim(JOB, 60_000)).toBe(true);
    // …worker A dies here, having done nothing to tidy up.
    await ageClaim(61_000);

    expect(await workerB.claim(JOB, 60_000)).toBe(true);
  });

  it("keeps separate jobs out of each other's way", async () => {
    expect(await workerA.claim(JOB, 60_000)).toBe(true);
    // A busy sweep must not hold back an unrelated one.
    expect(await workerB.claim("test-other-sweep", 60_000)).toBe(true);
  });

  it("records who ran it, for reading afterwards", async () => {
    await workerA.claim(JOB, 60_000);

    const runs = await workerA.lastRuns();
    const mine = runs.find((r) => r.job_name === JOB);
    expect(mine?.owner).toMatch(/:\d+$/);
    expect(mine?.last_started_at.getTime()).toBeCloseTo(Date.now(), -4);
  });
});
