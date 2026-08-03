import type { JobsOptions } from "bullmq";

/** BullMQ queue name (plan §7.6 lists media as its own queue, separate from notifications). */
export const MEDIA_QUEUE_NAME = "media";

export const PROCESS_IMAGE_JOB = "process-image";

/**
 * A job carries an id, never the bytes.
 *
 * The image is already in the quarantine prefix and can be several megabytes;
 * putting it in the payload would push the whole file through Redis and keep a
 * copy of it there for as long as the job is retained.
 */
export interface MediaJob {
  assetId: string;
  quarantineKey: string;
}

/**
 * Retry policy.
 *
 * Fewer attempts than mail, and for a different reason. Mail fails because
 * somebody else's server is briefly unhappy, which passes. Image processing
 * fails because the file is corrupt, which does not — and every retry decodes
 * the image again, so a decompression bomb that gets through the pixel check
 * would be paid for five times over. Three covers a transient storage read.
 */
export const MEDIA_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { count: 1_000 },
  // Kept: a failed job is an image an owner is waiting to see appear.
  removeOnFail: false,
};
