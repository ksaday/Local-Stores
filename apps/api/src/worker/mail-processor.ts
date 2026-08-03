import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Job } from "bullmq";
import type { Env } from "../config/env.js";
import { MailDelivery } from "../infra/mailer/mailer.js";
import { MAIL_QUEUE_NAME, type MailJob } from "../infra/queue/mail-queue.js";
import { QueueProcessor } from "./queue-processor.js";

/**
 * Delivers queued mail (plan §7.6, notifications queue).
 *
 * The only place in the system that talks to a mail provider. Everything else
 * hands a message to the queue and moves on, which is what keeps a slow or
 * failing provider out of a user's request.
 */
@Injectable()
export class MailProcessor extends QueueProcessor<MailJob> {
  constructor(
    private readonly delivery: MailDelivery,
    config: ConfigService<Env, true>,
    /**
     * Overridden only by tests — see `MailQueue`. `@Optional()` is load-bearing:
     * without it Nest tries to inject a `String` provider and refuses to start.
     */
    @Optional() queueName: string = MAIL_QUEUE_NAME,
  ) {
    // Mail is IO-bound and providers are happy with parallelism; five at a time
    // drains a burst without looking like an attack to a rate limiter.
    super(config.get("REDIS_URL", { infer: true }), queueName, 5);
  }

  protected async handle(job: Job<MailJob>): Promise<void> {
    await this.delivery.send(job.data);
  }

  protected describe(job: Job<MailJob> | undefined): string {
    return `Mail to ${job?.data.to ?? "unknown"}`;
  }
}
