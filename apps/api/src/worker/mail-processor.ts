import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker } from "bullmq";
import type Redis from "ioredis";
import type { Env } from "../config/env.js";
import { MailDelivery } from "../infra/mailer/mailer.js";
import { MAIL_QUEUE_NAME, type MailJob } from "../infra/queue/mail-queue.js";
import { createQueueConnection } from "../infra/queue/queue.module.js";

/**
 * Delivers queued mail (plan §7.6, notifications queue).
 *
 * The only place in the system that talks to a mail provider. Everything else
 * hands a message to the queue and moves on, which is what keeps a slow or
 * failing provider out of a user's request.
 *
 * Retries are BullMQ's, configured where jobs are added. A job that exhausts
 * its attempts stays in the failed set rather than being discarded — mail that
 * never arrived is precisely what someone needs to be able to look at.
 */
@Injectable()
export class MailProcessor {
  private readonly logger = new Logger(MailProcessor.name);
  private worker?: Worker<MailJob>;
  private connection?: Redis;

  constructor(
    private readonly delivery: MailDelivery,
    private readonly config: ConfigService<Env, true>,
    /**
     * Overridden only by tests — see `MailQueue`. `@Optional()` is load-bearing:
     * without it Nest tries to inject a `String` provider and refuses to start.
     */
    @Optional() private readonly queueName: string = MAIL_QUEUE_NAME,
  ) {}

  start(): void {
    if (this.worker) return;

    // Its own connection, not the producer's: BullMQ's blocking reads occupy a
    // connection for seconds at a time, so sharing one would stall every
    // enqueue behind a poll that is doing nothing.
    this.connection = createQueueConnection(this.config.get("REDIS_URL", { infer: true }));

    this.worker = new Worker<MailJob>(
      this.queueName,
      async (job) => {
        await this.delivery.send(job.data);
      },
      {
        connection: this.connection,
        // Mail is IO-bound and providers are happy with parallelism; five at a
        // time drains a burst without looking like an attack to a rate limiter.
        concurrency: 5,
      },
    );

    this.worker.on("failed", (job, err) => {
      const attempts = job?.attemptsMade ?? 0;
      const allowed = job?.opts.attempts ?? 0;
      const exhausted = attempts >= allowed;
      const to = job?.data.to ?? "unknown";
      // Escalated only once there is nothing left to try. Warning on every
      // intermediate retry would page someone about a blip BullMQ is already
      // handling, and the log would stop being worth reading.
      const message = `Mail to ${to} failed (attempt ${attempts}/${allowed}): ${err.message}`;
      if (exhausted) this.logger.error(`${message} — giving up, message not delivered`);
      else this.logger.warn(message);
    });

    this.worker.on("error", (err) => {
      this.logger.warn(`Mail worker error: ${err.message}`);
    });

    this.logger.log(`Processing ${this.queueName} queue`);
  }

  /** Finishes jobs in flight, then lets go of the connection. */
  async stop(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
    this.worker = undefined;
    this.connection = undefined;
  }
}
