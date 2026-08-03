import { Injectable, Logger } from "@nestjs/common";
import { hostname } from "node:os";
import { PrismaService } from "../infra/prisma/prisma.service.js";

/**
 * Decides which worker runs a given tick of a scheduled job (plan §12.9).
 *
 * Every worker keeps its own timers; they all wake up at roughly the same
 * moment and race to claim. Exactly one wins, the rest skip that pass. There is
 * no coordinator and no leader — a worker that dies has no lock to release,
 * because what it held was a timestamp that was going to expire anyway.
 *
 * Postgres rather than Redis, though both are available. The claim has to be
 * atomic against a row, which is one statement here; the Redis equivalent is a
 * lock with a TTL that has to outlive the job but not the interval, which is a
 * number that is wrong the first time anything gets slower.
 */
@Injectable()
export class JobLease {
  private readonly logger = new Logger(JobLease.name);

  /** Only ever read by a human looking at why a job did or did not run. */
  private readonly owner = `${hostname()}:${process.pid}`;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tries to claim this pass of `jobName`.
   *
   * One statement, so the race is settled by Postgres' row lock rather than by
   * anything in this process. `ON CONFLICT DO UPDATE ... WHERE` returns no row
   * when the guard fails, which is precisely "somebody else has it".
   *
   * `claimAfterMs` is how stale the previous claim must be. It is a little
   * under the job's interval: timers drift, and requiring the full interval to
   * have elapsed would make a worker that woke a few milliseconds early skip
   * the pass and stretch the period towards double.
   */
  async claim(jobName: string, claimAfterMs: number): Promise<boolean> {
    const seconds = claimAfterMs / 1000;

    const rows = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ job_name: string }[]>`
        INSERT INTO scheduled_job_runs (job_name, last_started_at, owner)
        VALUES (${jobName}, now(), ${this.owner})
        ON CONFLICT (job_name) DO UPDATE
          SET last_started_at = now(), owner = ${this.owner}
          WHERE scheduled_job_runs.last_started_at
                < now() - make_interval(secs => ${seconds}::double precision)
        RETURNING job_name
      `,
    );

    return rows.length > 0;
  }

  /** Who ran what, and when. For the platform health surface and for support. */
  async lastRuns(): Promise<{ job_name: string; last_started_at: Date; owner: string }[]> {
    return this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw`SELECT job_name, last_started_at, owner FROM scheduled_job_runs ORDER BY job_name`,
    );
  }
}
