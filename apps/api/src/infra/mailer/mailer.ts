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
 * Outbound mail (plan §12.10, FR-NOTIF-01).
 *
 * Phase 9 replaces this with SES behind a BullMQ queue. Until then the
 * interface exists so verification, reset, and invitation flows are written
 * against their final shape, and the dev implementation logs rather than
 * pretending mail was delivered.
 */
export abstract class Mailer {
  abstract send(email: OutboundEmail): Promise<void>;
}

/**
 * Development implementation: writes the message — including the action link —
 * to the application log so flows are testable without a mail provider.
 *
 * The link is a live credential. This is acceptable in local development, where
 * the alternative is not being able to complete the flow at all, but it is why
 * this class refuses to run in production.
 */
@Injectable()
export class LogMailer extends Mailer {
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

/** Captures sent mail for assertions. Test use only. */
export class InMemoryMailer extends Mailer {
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
