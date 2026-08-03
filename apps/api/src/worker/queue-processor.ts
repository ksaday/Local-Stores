import { Logger } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import { createQueueConnection } from "../infra/queue/bull-queue.js";

/**
 * The consumer half of a BullMQ queue.
 *
 * Retry policy lives with the producer, where jobs are added — a consumer that
 * decided its own would silently disagree with whatever the enqueuing side
 * asked for.
 */
export abstract class QueueProcessor<T> {
  protected readonly logger = new Logger(this.constructor.name);
  private worker?: Worker<T>;
  private connection?: Redis;

  protected constructor(
    private readonly redisUrl: string,
    private readonly queueName: string,
    private readonly concurrency: number,
  ) {}

  /** The work itself. Throwing hands the job back to BullMQ to retry. */
  protected abstract handle(job: Job<T>): Promise<void>;

  /** How a job is named in a log line — an address, an asset id. */
  protected abstract describe(job: Job<T> | undefined): string;

  start(): void {
    if (this.worker) return;

    // Its own connection, not the producer's: BullMQ's blocking reads occupy a
    // connection for seconds at a time, so sharing one would stall every
    // enqueue behind a poll that is doing nothing.
    this.connection = createQueueConnection(this.redisUrl);

    this.worker = new Worker<T>(this.queueName, (job) => this.handle(job), {
      connection: this.connection,
      concurrency: this.concurrency,
    });

    this.worker.on("failed", (job, err) => {
      const attempts = job?.attemptsMade ?? 0;
      const allowed = job?.opts.attempts ?? 0;
      const message = `${this.describe(job)} failed (attempt ${attempts}/${allowed}): ${err.message}`;
      // Escalated only once there is nothing left to try. Warning on every
      // intermediate retry would page someone about a blip BullMQ is already
      // handling, and the log would stop being worth reading.
      if (attempts >= allowed) this.logger.error(`${message} — giving up`);
      else this.logger.warn(message);
    });

    this.worker.on("error", (err) => this.logger.warn(`Worker error: ${err.message}`));

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
