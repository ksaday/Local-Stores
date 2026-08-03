import { Global, Injectable, Module, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../config/env.js";
import { BullQueue } from "./bull-queue.js";
import { MAIL_JOB_OPTIONS, MAIL_QUEUE_NAME, SEND_EMAIL_JOB, type MailJob } from "./mail-queue.js";
import {
  MEDIA_JOB_OPTIONS,
  MEDIA_QUEUE_NAME,
  PROCESS_IMAGE_JOB,
  type MediaJob,
} from "./media-queue.js";

export { createQueueConnection } from "./bull-queue.js";

/**
 * `name` is overridden only by tests, so a suite does not enqueue into the
 * queue a developer's worker is draining — which would either do the work for
 * real or consume theirs.
 *
 * `@Optional()` is load-bearing on that parameter: without it Nest reads the
 * type as `String`, looks for a provider of that, and refuses to start.
 */
@Injectable()
export class MailQueue extends BullQueue<MailJob> {
  constructor(config: ConfigService<Env, true>, @Optional() name: string = MAIL_QUEUE_NAME) {
    super(config.get("REDIS_URL", { infer: true }), name);
  }

  async enqueue(job: MailJob): Promise<void> {
    await this.enqueueWith(SEND_EMAIL_JOB, job, MAIL_JOB_OPTIONS);
  }
}

/** See `MailQueue` for why `name` is optional. */
@Injectable()
export class MediaQueue extends BullQueue<MediaJob> {
  constructor(config: ConfigService<Env, true>, @Optional() name: string = MEDIA_QUEUE_NAME) {
    super(config.get("REDIS_URL", { infer: true }), name);
  }

  /**
   * One asset, one processing job — ever.
   *
   * The job id is the asset id, which BullMQ treats as a deduplication key:
   * adding it again while the first is queued or retained is ignored. The
   * asset row cannot carry this, because it reads PENDING both before the
   * client has uploaded anything and while the worker is working, so a
   * double-tapped "done" would otherwise run sharp over the same file twice.
   */
  async enqueue(job: MediaJob): Promise<void> {
    await this.enqueueWith(PROCESS_IMAGE_JOB, job, { ...MEDIA_JOB_OPTIONS, jobId: job.assetId });
  }
}

/**
 * The async job seam (plan §7.6).
 *
 * Global because work is enqueued from all over the application, and threading
 * a queue import through every module that happens to send an email or accept
 * an image would say nothing useful about those modules.
 */
@Global()
@Module({
  providers: [MailQueue, MediaQueue],
  exports: [MailQueue, MediaQueue],
})
export class QueueModule {}
