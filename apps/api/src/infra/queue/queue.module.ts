import { Global, Injectable, Logger, Module, Optional, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, type Job, type JobsOptions } from "bullmq";
import Redis from "ioredis";
import type { Env } from "../../config/env.js";
import { MAIL_JOB_OPTIONS, MAIL_QUEUE_NAME, SEND_EMAIL_JOB, type MailJob } from "./mail-queue.js";

/**
 * Builds the Redis connection BullMQ needs.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ rather than a preference:
 * its blocking commands sit open for many seconds, and ioredis' default would
 * abort them as failed requests.
 */
export function createQueueConnection(url: string): Redis {
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  // Without a handler ioredis emits `error` as an unhandled event, which takes
  // the process down over a blip it was going to recover from.
  connection.on("error", (err) => new Logger("Queue").warn(`Redis error: ${err.message}`));
  return connection;
}

/**
 * The notifications queue (plan §7.6).
 *
 * A thin class rather than a bare `Queue` provider so the connection has an
 * owner. BullMQ holds an open Redis socket, and something has to close it —
 * otherwise the API lingers on shutdown and a test run hangs after its last
 * assertion has already passed.
 */
@Injectable()
export class MailQueue implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<MailJob>;

  /**
   * `name` is overridden only by tests, so a suite does not enqueue into the
   * queue a developer's worker is draining — which would either deliver test
   * mail for real or consume theirs.
   */
  constructor(
    config: ConfigService<Env, true>,
    // @Optional() is load-bearing: without it Nest reads the parameter's type
    // as `String`, looks for a provider of that, and refuses to start.
    @Optional() name: string = MAIL_QUEUE_NAME,
  ) {
    this.connection = createQueueConnection(config.get("REDIS_URL", { infer: true }));
    this.queue = new Queue<MailJob>(name, { connection: this.connection });
  }

  /** Enqueue with non-default options. Tests use it to avoid real backoff waits. */
  async enqueueWith(job: MailJob, options: JobsOptions): Promise<void> {
    await this.queue.add(SEND_EMAIL_JOB, job, options);
  }

  /** Removes the queue entirely, including its job history. Test teardown. */
  async obliterate(): Promise<void> {
    await this.queue.obliterate({ force: true }).catch(() => undefined);
  }

  async enqueue(job: MailJob): Promise<void> {
    await this.queue.add(SEND_EMAIL_JOB, job, MAIL_JOB_OPTIONS);
  }

  /** Jobs waiting to be delivered. Test inspection. */
  async waiting(): Promise<Job<MailJob>[]> {
    return this.queue.getWaiting();
  }

  /** Jobs that exhausted every attempt: mail that never arrived. */
  async deadLettered(): Promise<number> {
    return this.queue.getFailedCount();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await this.connection.quit().catch(() => undefined);
  }
}

/**
 * Global because mail is sent from all over the application, and threading a
 * queue import through every module that happens to send an email would say
 * nothing useful about those modules.
 */
@Global()
@Module({
  providers: [MailQueue],
  exports: [MailQueue],
})
export class QueueModule {}
