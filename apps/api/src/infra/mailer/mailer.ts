import { Injectable, Logger } from "@nestjs/common";

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain text body. Templated HTML with store branding arrives in Phase 9. */
  body: string;
  /** Set for mail whose delivery failure should page someone. */
  critical?: boolean;
}

/**
 * Outbound mail, from a caller's point of view (plan §12.10, FR-NOTIF-01).
 *
 * `send` means "this will be delivered", not "this has been delivered". In the
 * API it puts the message on the notifications queue and returns; the worker
 * does the talking to the mail provider. Callers should not care, and none of
 * them do — the seam has not changed since the flows were written against it.
 */
export abstract class Mailer {
  abstract send(email: OutboundEmail): Promise<void>;
}

/**
 * The other half: what actually hands a message to a provider.
 *
 * Split from `Mailer` so the two can differ per process. Everything that sends
 * mail depends on `Mailer` and gets the queue. Only the worker's processor
 * depends on `MailDelivery`, and it is the one place a slow or failing
 * provider can block — which is the entire point of moving it off the request.
 */
export abstract class MailDelivery {
  abstract send(email: OutboundEmail): Promise<void>;
}

/**
 * Development delivery: writes the message — including the action link — to
 * the application log so flows are testable without a mail provider.
 *
 * The link is a live credential. This is acceptable in local development, where
 * the alternative is not being able to complete the flow at all, but it is why
 * this class refuses to run in production.
 */
@Injectable()
export class LogMailer extends MailDelivery {
  private readonly logger = new Logger("Mailer");

  constructor(nodeEnv: string) {
    super();
    if (nodeEnv === "production") {
      throw new Error(
        "LogMailer writes action links to the log and must not run in production. " +
          "Wire the SES mailer before deploying.",
      );
    }
  }

  async send(email: OutboundEmail): Promise<void> {
    this.logger.log(
      `\n─── email ───────────────────────────────\n` +
        `To:      ${email.to}\n` +
        `Subject: ${email.subject}\n\n` +
        `${email.body}\n` +
        `─────────────────────────────────────────`,
    );
  }
}

/**
 * Captures mail for assertions. Test use only.
 *
 * Extends `MailDelivery` and satisfies `Mailer` too — the two have the same
 * shape, so a test can stand in for either end of the queue.
 */
export class InMemoryMailer extends MailDelivery implements Mailer {
  readonly sent: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<void> {
    this.sent.push(email);
  }

  lastTo(address: string): OutboundEmail | undefined {
    return [...this.sent].reverse().find((e) => e.to.toLowerCase() === address.toLowerCase());
  }

  clear(): void {
    this.sent.length = 0;
  }
}
