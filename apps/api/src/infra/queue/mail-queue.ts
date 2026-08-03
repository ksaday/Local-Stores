import type { JobsOptions } from "bullmq";
import type { OutboundEmail } from "../mailer/mailer.js";

/** BullMQ queue name. Shared by the producer in the API and the worker's processor. */
export const MAIL_QUEUE_NAME = "notifications";

/** The only job this queue carries today. Named so a second kind can join it. */
export const SEND_EMAIL_JOB = "send-email";

export type MailJob = OutboundEmail;

/**
 * Retry policy (plan §7.6: "retry ×5 exponential").
 *
 * Mail providers fail in bursts — a rate limit, a brief outage, a DNS blip —
 * and all of those recover on their own. Five attempts backing off from four
 * seconds reaches roughly a minute of patience, which covers the common case
 * without holding a job for hours.
 */
export const MAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 4_000 },

  // Completed jobs are noise once delivered; a thousand is enough to answer
  // "did it go out?" for the recent past without growing without limit.
  removeOnComplete: { count: 1_000 },

  // Failures are kept deliberately. A job that has exhausted its attempts is
  // mail that never arrived — someone's password reset, or a warning that a
  // shop was about to go offline — and it has to remain visible rather than
  // disappearing at the moment it becomes important.
  removeOnFail: false,
};
