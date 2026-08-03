import { Injectable } from "@nestjs/common";
import { MailQueue } from "../queue/queue.module.js";
import { Mailer, type OutboundEmail } from "./mailer.js";

/**
 * The `Mailer` every caller gets: hands the message to the notifications
 * queue and returns.
 *
 * What this buys is not speed for its own sake. Delivering inline put a
 * third-party network call inside a database-backed request — a rate-limited
 * or briefly down provider turned "reset my password" into a request that hung
 * and then failed, having already consumed the token. Off the request, the
 * same failure is a retry nobody sees.
 *
 * It deliberately does *not* swallow a failure to enqueue. Accepting mail we
 * have no way to deliver is exactly the silence this change exists to remove:
 * a caller that cannot queue an email should hear about it, rather than a user
 * waiting for a message that was dropped on the floor.
 */
@Injectable()
export class QueueMailer extends Mailer {
  constructor(private readonly queue: MailQueue) {
    super();
  }

  async send(email: OutboundEmail): Promise<void> {
    await this.queue.enqueue(email);
  }
}
