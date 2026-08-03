import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import type { Env } from "../../config/env.js";
import { Mailer } from "../../infra/mailer/mailer.js";
import { isUniqueViolation } from "../../infra/prisma/prisma-errors.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { GRACE_PERIOD_DAYS } from "./billing.service.js";

export type DunningStage = "PAYMENT_FAILED" | "GRACE_REMINDER" | "FINAL_WARNING" | "SUSPENDED";

const DAY_MS = 86_400_000;

/**
 * When each warning goes out, in days since the first failed payment.
 *
 * Four messages across seven days: enough that an owner on holiday comes back
 * to a warning, few enough that they are still read. The final one lands a day
 * before the storefront goes down, because a warning that arrives the same
 * hour as the outage is not a warning.
 */
const SCHEDULE: { stage: DunningStage; afterDays: number }[] = [
  { stage: "PAYMENT_FAILED", afterDays: 0 },
  { stage: "GRACE_REMINDER", afterDays: 3 },
  { stage: "FINAL_WARNING", afterDays: GRACE_PERIOD_DAYS - 1 },
];

interface Candidate {
  store_id: string;
  store_name: string;
  owner_email: string;
  /**
   * Read only to work out how far into the grace period the store is.
   *
   * Never written back as the episode key. Postgres keeps timestamps to the
   * microsecond and a JavaScript `Date` only to the millisecond, so a value
   * that has been through here no longer equals the one it came from — which
   * made every pass believe nothing had been sent yet, and mail the owner
   * hourly. The insert takes `past_due_since` straight from the subscription
   * row instead.
   */
  past_due_since: Date;
  suspended_at: Date | null;
  sent: string[];
}

/**
 * Tells a store owner their subscription is unpaid, before their shop goes
 * offline (plan §18.5a).
 *
 * The in-app banner warns whoever signs in. The owner who needs warning is the
 * one who does not: nothing looks broken during the grace period, because the
 * shop keeps trading, so there is no reason to go and look. Mail is the only
 * channel that reaches someone who isn't already there.
 *
 * Kept apart from `BillingService` on purpose. That service decides what is
 * true about a subscription — Stripe's word, the grace period, the suspension.
 * This one only reports it. A change to how a shop is told must not be able to
 * change when it gets cut off.
 */
@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Sends whatever is due, once each. Safe to run every hour.
   *
   * Returns the number of messages sent, so the scheduler can stay quiet on
   * the overwhelming majority of passes where nothing is owed.
   */
  async run(now = new Date()): Promise<number> {
    const candidates = await this.candidates();

    let sent = 0;
    for (const candidate of candidates) {
      const stage = this.dueStage(candidate, now);
      if (!stage || candidate.sent.includes(stage)) continue;

      try {
        await this.notify(candidate, stage, now);
        sent += 1;
      } catch (err) {
        // One store's bad address must not stop the sweep: the others are
        // heading for the same cliff.
        this.logger.error(`Dunning failed for store ${candidate.store_id}: ${String(err)}`);
      }
    }

    return sent;
  }

  private async candidates(): Promise<Candidate[]> {
    // Read as the platform. The owner's address is the whole point of this
    // job, and the users policy only exposes members of the current store —
    // an owner has no membership until they accept an invitation, so a
    // store-scoped read here returns a store with no one to write to.
    return this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<Candidate[]>`
        SELECT s.store_id, st.name AS store_name, u.email AS owner_email,
               s.past_due_since, s.suspended_at,
               COALESCE(
                 array_agg(n.stage::text) FILTER (WHERE n.stage IS NOT NULL),
                 ARRAY[]::text[]
               ) AS sent
        FROM store_subscriptions s
        JOIN stores st ON st.id = s.store_id
        JOIN users u ON u.id = st.owner_user_id
        LEFT JOIN billing_notifications n
          ON n.store_id = s.store_id AND n.past_due_since = s.past_due_since
        WHERE s.status = 'PAST_DUE' AND s.past_due_since IS NOT NULL
        GROUP BY s.store_id, st.name, u.email, s.past_due_since, s.suspended_at
        LIMIT 200
      `,
    );
  }

  /**
   * The furthest-along message this store is owed, or null.
   *
   * Only ever one, never a backlog. A worker that was down for four days must
   * not greet the owner with three emails at once — the last one is the only
   * one that still describes their situation, and the earlier two would read
   * as a system that had lost track.
   */
  private dueStage(candidate: Candidate, now: Date): DunningStage | null {
    if (candidate.suspended_at) return "SUSPENDED";

    const elapsedDays = (now.getTime() - candidate.past_due_since.getTime()) / DAY_MS;
    let due: DunningStage | null = null;
    for (const step of SCHEDULE) {
      if (elapsedDays >= step.afterDays) due = step.stage;
    }
    return due;
  }

  private async notify(candidate: Candidate, stage: DunningStage, now: Date): Promise<void> {
    const daysLeft = Math.max(
      0,
      Math.ceil(
        (candidate.past_due_since.getTime() + GRACE_PERIOD_DAYS * DAY_MS - now.getTime()) / DAY_MS,
      ),
    );

    await this.mailer.send({
      to: candidate.owner_email,
      subject: subjectFor(stage, candidate.store_name, daysLeft),
      body: bodyFor(stage, candidate.store_name, daysLeft, this.billingUrl(candidate.store_id)),
      // A warning nobody receives is the failure this whole job exists to
      // prevent, so a bounce here is worth waking someone for.
      critical: true,
    });

    // Recorded after sending, not before: if the write fails, the worst case
    // is a duplicate warning next hour, and if it were the other way round the
    // worst case would be a shop going dark with no warning at all. The unique
    // index still collapses the ordinary duplicate.
    try {
      await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
        tx.$executeRaw`
          INSERT INTO billing_notifications (id, store_id, past_due_since, stage, sent_to)
          SELECT ${randomUUID()}, store_id, past_due_since,
                 ${stage}::"DunningStage", ${candidate.owner_email}
          FROM store_subscriptions
          WHERE store_id = ${candidate.store_id} AND past_due_since IS NOT NULL
        `,
      );
    } catch (err) {
      // Another worker got there first; the owner has been told either way.
      if (!isUniqueViolation(err)) throw err;
    }

    this.logger.log(`Dunning ${stage} sent for store ${candidate.store_id}`);
  }

  /**
   * The owner's own billing page, not a Stripe portal link.
   *
   * A portal session is a bearer credential that expires, so mailing one puts
   * a short-lived key to the shop's billing in an inbox that outlives it. The
   * app makes them sign in first and creates the session on the spot.
   */
  private billingUrl(storeId: string): string {
    const origin = this.config.get("WEB_ORIGIN", { infer: true }).replace(/\/$/, "");
    return `${origin}/store/${storeId}/ops/settings`;
  }
}

function subjectFor(stage: DunningStage, storeName: string, daysLeft: number): string {
  switch (stage) {
    case "PAYMENT_FAILED":
      return `We couldn't take payment for ${storeName}`;
    case "GRACE_REMINDER":
      return `${storeName}: your payment is still outstanding`;
    case "FINAL_WARNING":
      return daysLeft <= 1
        ? `${storeName} goes offline tomorrow`
        : `${storeName} goes offline in ${daysLeft} days`;
    case "SUSPENDED":
      return `${storeName} is now offline`;
  }
}

/**
 * Plain text, and deliberately plain language.
 *
 * The reader is a shop owner who is busy, not a subscriber managing a SaaS
 * account. Every message says the same three things in the same order: what
 * happened, what it will cost them, and the one link that fixes it.
 */
function bodyFor(
  stage: DunningStage,
  storeName: string,
  daysLeft: number,
  billingUrl: string,
): string {
  const fix = `Update your card here:\n${billingUrl}\n\n`;
  const reassurance =
    `Nothing has been deleted. Your products, orders and customers are all ` +
    `exactly as you left them.\n`;

  switch (stage) {
    case "PAYMENT_FAILED":
      return (
        `Your last payment for ${storeName} didn't go through.\n\n` +
        `This is usually an expired or replaced card. ${storeName} is still ` +
        `open and taking orders — nothing has changed for your customers yet.\n\n` +
        fix +
        `If it isn't sorted within ${GRACE_PERIOD_DAYS} days your storefront ` +
        `will be hidden, and we'll write again before that happens.\n`
      );

    case "GRACE_REMINDER":
      return (
        `We still haven't been able to take payment for ${storeName}.\n\n` +
        `Your shop is open as normal for now. ${daysLeft === 1 ? "You have 1 day" : `You have ${daysLeft} days`} ` +
        `left before the storefront is hidden from customers.\n\n` +
        fix
      );

    case "FINAL_WARNING":
      return (
        `This is the last reminder before ${storeName} goes offline.\n\n` +
        `${daysLeft <= 1 ? "Tomorrow" : `In ${daysLeft} days`} your storefront ` +
        `will stop being visible to customers, and your staff won't be able to ` +
        `sign in.\n\n` +
        fix +
        reassurance +
        `Paying puts everything back within a few minutes.\n`
      );

    case "SUSPENDED":
      return (
        `${storeName} is no longer visible to customers, because the ` +
        `subscription is unpaid.\n\n` +
        reassurance +
        `\n` +
        fix +
        `As soon as the payment goes through your shop comes back on, exactly ` +
        `as it was.\n`
      );
  }
}
