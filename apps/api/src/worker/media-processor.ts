import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Job } from "bullmq";
import type { Env } from "../config/env.js";
import { MEDIA_QUEUE_NAME, type MediaJob } from "../infra/queue/media-queue.js";
import { MediaService } from "../modules/media/media.service.js";
import { QueueProcessor } from "./queue-processor.js";

/**
 * Validates and re-encodes uploaded images (plan §7.6, media queue).
 *
 * Concurrency is deliberately low, unlike mail. This is the one queue whose
 * work is CPU-bound: sharp decodes an image into a full raster, and several
 * ten-megapixel photos at once is hundreds of megabytes of resident memory and
 * every core busy. Two at a time keeps the worker responsive to the queues
 * whose jobs are only waiting on somebody else's network.
 */
@Injectable()
export class MediaProcessor extends QueueProcessor<MediaJob> {
  constructor(
    private readonly media: MediaService,
    config: ConfigService<Env, true>,
    /** Overridden only by tests — see `MailProcessor` for why `@Optional()`. */
    @Optional() queueName: string = MEDIA_QUEUE_NAME,
  ) {
    super(config.get("REDIS_URL", { infer: true }), queueName, 2);
  }

  protected async handle(job: Job<MediaJob>): Promise<void> {
    const result = await this.media.processQueued(job.data.assetId, job.data.quarantineKey);
    // A rejected file is a completed job, not a failed one: the file is what it
    // is, and decoding it three more times reaches the same verdict while
    // paying the CPU cost again. The verdict is on the asset row for whoever
    // uploaded it to read.
    if (result.status === "REJECTED") {
      this.logger.warn(`Media ${job.data.assetId} rejected: ${result.reason ?? "no reason given"}`);
    }
  }

  protected describe(job: Job<MediaJob> | undefined): string {
    return `Media ${job?.data.assetId ?? "unknown"}`;
  }
}
