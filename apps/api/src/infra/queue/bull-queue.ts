import { Logger, type OnModuleDestroy } from "@nestjs/common";
import { Queue, type Job, type JobsOptions } from "bullmq";
import Redis from "ioredis";

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
 * The producer half of a BullMQ queue.
 *
 * A class rather than a bare `Queue` provider so the connection has an owner.
 * BullMQ holds an open Redis socket, and something has to close it — otherwise
 * the API lingers on shutdown and a test run hangs after its last assertion has
 * already passed.
 */
export abstract class BullQueue<T> implements OnModuleDestroy {
  private readonly connection: Redis;
  /**
   * Untyped on purpose. BullMQ derives its job-name and result types through
   * conditional types over the data parameter, and those cannot be resolved
   * against a generic the base class has not pinned down. The type safety
   * callers rely on lives on the methods below instead, where `T` is concrete.
   */
  protected readonly queue: Queue;

  constructor(redisUrl: string, name: string) {
    this.connection = createQueueConnection(redisUrl);
    this.queue = new Queue(name, { connection: this.connection });
  }

  /** Enqueue with non-default options. Tests use it to avoid real backoff waits. */
  async enqueueWith(jobName: string, data: T, options: JobsOptions): Promise<void> {
    await this.queue.add(jobName, data, options);
  }

  /** Jobs waiting to be picked up. Test inspection. */
  async waiting(): Promise<Job<T>[]> {
    return (await this.queue.getWaiting()) as unknown as Job<T>[];
  }

  /** Jobs that exhausted every attempt: work that never happened. */
  async deadLettered(): Promise<number> {
    return this.queue.getFailedCount();
  }

  /**
   * Depth by state, for the `queue_depth` gauge.
   *
   * One round trip for all four: BullMQ issues these as a pipeline, and a
   * gauge read on every scrape should not be four sequential calls to Redis.
   *
   * `completed` is deliberately not asked for. It is bounded by the retention
   * policy rather than by anything happening now, so it measures the retention
   * setting rather than the queue.
   */
  async jobCounts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts("waiting", "active", "delayed", "failed");
  }

  /** Removes the queue entirely, including its job history. Test teardown. */
  async obliterate(): Promise<void> {
    await this.queue.obliterate({ force: true }).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await this.connection.quit().catch(() => undefined);
  }
}
