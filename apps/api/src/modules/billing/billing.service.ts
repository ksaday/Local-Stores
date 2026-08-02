import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { PaymentProvider } from "../../infra/payments/payment.provider.js";
import { AuditService } from "../audit/audit.service.js";

export type SubscriptionStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED";

export interface SubscriptionView {
  status: SubscriptionStatus | null;
  planCode: string | null;
  planName: string | null;
  priceCents: number | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /** Days left before the storefront is hidden, when past due. */
  graceDaysRemaining: number | null;
  hasPaymentMethod: boolean;
}

/**
 * How long a store keeps trading after a payment fails (plan §18.5a).
 *
 * Deliberately generous. The common cause is an expired card, not a shop that
 * has stopped paying — and taking a working business offline over a card
 * rotation is a far worse error than carrying a week of unpaid service.
 */
export const GRACE_PERIOD_DAYS = 7;

/**
 * The subscription that is the platform's revenue (plan §18.5a).
 *
 * Not to be confused with anything in `PaymentsService`: that is a store
 * receiving money from its customers through Connect. This is the store owner
 * paying us $49 a month. They share a provider and a webhook stream and
 * nothing else — in particular, a store whose Connect account is perfect can
 * still be suspended for not paying us, and vice versa.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly audit: AuditService,
  ) {}

  /** The single plan v2.0 ships. */
  async currentPlan() {
    const plan = await this.prisma.withTenant({ isSuperAdmin: false }, (tx) =>
      tx.plan.findFirst({ where: { active: true }, orderBy: { priceCents: "asc" } }),
    );
    if (!plan) throw AppError.internal("No active plan is configured.");
    return plan;
  }

  async getSubscription(storeId: string): Promise<SubscriptionView> {
    const row = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.storeSubscription.findFirst({
        where: { storeId },
        include: { plan: true },
      }),
    );

    if (!row) {
      return {
        status: null, planCode: null, planName: null, priceCents: null,
        trialEndsAt: null, currentPeriodEnd: null, graceDaysRemaining: null,
        hasPaymentMethod: false,
      };
    }

    return {
      status: row.status as SubscriptionStatus,
      planCode: row.planCode,
      planName: row.plan.name,
      priceCents: row.plan.priceCents,
      trialEndsAt: row.trialEndsAt,
      currentPeriodEnd: row.currentPeriodEnd,
      graceDaysRemaining: graceRemaining(row.status, row.pastDueSince),
      // A customer only exists once billing has been started, and a card is
      // only attached through the portal — so this is "billing set up", not
      // "we hold a card", which we deliberately never do.
      hasPaymentMethod: Boolean(row.stripeCustomerId),
    };
  }

  /**
   * Starts the store's subscription, trial included.
   *
   * Idempotent by store: calling twice returns the existing subscription
   * rather than creating a second one. Two live subscriptions would bill a
   * shop twice for the same month, which is the kind of error that loses a
   * customer permanently.
   */
  async startSubscription(storeId: string, actorUserId: string) {
    const existing = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.storeSubscription.findFirst({ where: { storeId } }),
    );
    if (existing?.stripeSubscriptionId) {
      return { subscriptionId: existing.stripeSubscriptionId, status: existing.status, alreadyStarted: true };
    }

    const plan = await this.currentPlan();
    if (!plan.stripePriceId) {
      // A configuration error, and worth saying plainly: without a price in
      // Stripe there is nothing to subscribe anyone to.
      throw AppError.validation(
        "Billing isn't configured on this platform yet — no Stripe price is set for the plan.",
      );
    }

    const store = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.findFirst({ where: { id: storeId }, select: { id: true, name: true, ownerUserId: true } }),
    );
    if (!store) throw AppError.notFound();

    // Read as the platform: the users policy only exposes members of the
    // current store, and an owner has no membership until they accept their
    // invitation. Same reasoning as Connect onboarding.
    const owner = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.user.findFirst({ where: { id: store.ownerUserId }, select: { email: true } }),
    );
    if (!owner) throw AppError.internal("This store has no owner on record.");

    const customerId = await this.provider.ensureBillingCustomer({
      storeId,
      storeName: store.name,
      email: owner.email,
      existingCustomerId: existing?.stripeCustomerId ?? null,
    });

    const subscription = await this.provider.createSubscription({
      customerId,
      priceId: plan.stripePriceId,
      trialDays: plan.trialDays,
      storeId,
      // Keyed on the store, so a double-clicked "Start subscription" returns
      // the first one rather than creating a second.
      idempotencyKey: `sub-${storeId}`,
    });

    await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$executeRaw`
        INSERT INTO store_subscriptions
          (id, store_id, plan_code, stripe_customer_id, stripe_subscription_id,
           status, trial_ends_at, current_period_end)
        VALUES (${randomUUID()}, ${storeId}, ${plan.code}, ${customerId},
                ${subscription.subscriptionId}, ${mapStatus(subscription.status)}::"SubscriptionStatus",
                ${subscription.trialEndsAt}, ${subscription.currentPeriodEnd})
        ON CONFLICT (store_id) DO UPDATE SET
          stripe_customer_id = EXCLUDED.stripe_customer_id,
          stripe_subscription_id = EXCLUDED.stripe_subscription_id,
          status = EXCLUDED.status,
          trial_ends_at = EXCLUDED.trial_ends_at,
          current_period_end = EXCLUDED.current_period_end,
          updated_at = now()
      `,
    );

    await this.audit.record({
      storeId,
      actorUserId,
      action: "billing.subscription_started",
      entityType: "store",
      entityId: storeId,
      after: { planCode: plan.code, trialDays: plan.trialDays },
    });

    this.logger.log(`Subscription ${subscription.subscriptionId} started for store ${storeId}`);
    return { subscriptionId: subscription.subscriptionId, status: mapStatus(subscription.status), alreadyStarted: false };
  }

  /**
   * A link to Stripe's hosted billing portal.
   *
   * Everything about the card happens there — adding, updating, cancelling.
   * That keeps subscription card details as far from this platform as shopper
   * card details already are.
   */
  async billingPortalUrl(storeId: string, returnUrl: string): Promise<string> {
    const row = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.storeSubscription.findFirst({ where: { storeId }, select: { stripeCustomerId: true } }),
    );
    if (!row?.stripeCustomerId) {
      throw AppError.validation("This store hasn't started a subscription yet.");
    }
    return this.provider.createBillingPortalSession(row.stripeCustomerId, returnUrl);
  }

  // ── Lifecycle, driven by webhooks ────────────────────────────────────────

  /**
   * Records subscription state from the provider.
   *
   * Stripe is the authority on whether a store has paid; this only mirrors
   * what it says. The one piece of local judgement is `pastDueSince`, which is
   * stamped once and left alone — the grace period must run from the first
   * failure, not restart on every card retry.
   */
  async applyProviderStatus(input: {
    subscriptionId: string;
    status: string;
    currentPeriodEnd: Date | null;
    trialEndsAt: Date | null;
  }): Promise<{ storeId: string; status: SubscriptionStatus } | null> {
    const status = mapStatus(input.status);

    const rows = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ store_id: string }[]>`
        UPDATE store_subscriptions
        SET status = ${status}::"SubscriptionStatus",
            current_period_end = COALESCE(${input.currentPeriodEnd}, current_period_end),
            trial_ends_at = COALESCE(${input.trialEndsAt}, trial_ends_at),
            past_due_since = CASE
              WHEN ${status} = 'PAST_DUE' THEN COALESCE(past_due_since, now())
              ELSE NULL
            END,
            updated_at = now()
        WHERE stripe_subscription_id = ${input.subscriptionId}
        RETURNING store_id
      `,
    );

    const storeId = rows[0]?.store_id;
    if (!storeId) {
      this.logger.warn(`No subscription row for ${input.subscriptionId}`);
      return null;
    }

    // Paying up reinstates a store we suspended — but only one we suspended.
    // A Super Admin's manual suspension is a different decision and is not
    // ours to undo.
    if (status === "ACTIVE" || status === "TRIALING") {
      await this.reinstateIfSuspendedForNonPayment(storeId);
    }

    return { storeId, status };
  }

  private async reinstateIfSuspendedForNonPayment(storeId: string): Promise<void> {
    const reinstated = await this.prisma.withTenant({ isSuperAdmin: true }, async (tx) => {
      const [sub] = await tx.$queryRaw<{ suspended_at: Date | null }[]>`
        SELECT suspended_at FROM store_subscriptions WHERE store_id = ${storeId}
      `;
      if (!sub?.suspended_at) return false;

      await tx.$executeRaw`
        UPDATE stores SET status = 'ACTIVE', updated_at = now()
        WHERE id = ${storeId} AND status = 'SUSPENDED'
      `;
      await tx.$executeRaw`
        UPDATE store_subscriptions SET suspended_at = NULL, updated_at = now()
        WHERE store_id = ${storeId}
      `;
      return true;
    });

    if (reinstated) {
      await this.audit.record({
        storeId,
        action: "billing.store_reinstated",
        entityType: "store",
        entityId: storeId,
        severity: "HIGH",
      });
      this.logger.log(`Store ${storeId} reinstated after payment`);
    }
  }

  /**
   * Suspends stores whose grace period has run out.
   *
   * Run from the worker. Hides the storefront and blocks staff logins, and
   * deliberately touches nothing else: the catalog, orders and history all
   * stay. A shop that lapses in month two and comes back in month four should
   * find its products waiting (plan §18.5a).
   */
  async suspendExpiredGracePeriods(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - GRACE_PERIOD_DAYS * 86_400_000);

    const due = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ store_id: string }[]>`
        SELECT s.store_id
        FROM store_subscriptions s
        JOIN stores st ON st.id = s.store_id
        WHERE s.status = 'PAST_DUE'
          AND s.past_due_since IS NOT NULL
          AND s.past_due_since < ${cutoff}
          AND s.suspended_at IS NULL
          AND st.status = 'ACTIVE'
        LIMIT 100
      `,
    );

    let suspended = 0;
    for (const { store_id: storeId } of due) {
      try {
        await this.prisma.withTenant({ isSuperAdmin: true }, async (tx) => {
          await tx.$executeRaw`
            UPDATE stores SET status = 'SUSPENDED', updated_at = now() WHERE id = ${storeId}
          `;
          await tx.$executeRaw`
            UPDATE store_subscriptions SET suspended_at = now(), updated_at = now()
            WHERE store_id = ${storeId}
          `;
        });

        await this.audit.record({
          storeId,
          action: "billing.store_suspended_unpaid",
          entityType: "store",
          entityId: storeId,
          severity: "HIGH",
          after: { graceDays: GRACE_PERIOD_DAYS },
        });

        this.logger.warn(`Store ${storeId} suspended after ${GRACE_PERIOD_DAYS} unpaid days`);
        suspended += 1;
      } catch (err) {
        // One store must not stop the sweep.
        this.logger.error(`Could not suspend ${storeId}: ${String(err)}`);
      }
    }

    return suspended;
  }

  /** Stores in their grace period, for warning them before it runs out. */
  async storesInGracePeriod() {
    return this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ store_id: string; past_due_since: Date }[]>`
        SELECT store_id, past_due_since FROM store_subscriptions
        WHERE status = 'PAST_DUE' AND past_due_since IS NOT NULL AND suspended_at IS NULL
      `,
    );
  }
}

/** Stripe's subscription states, narrowed to the four we act on. */
function mapStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "trialing":
      return "TRIALING";
    case "active":
      return "ACTIVE";
    case "past_due":
    case "unpaid":
    // `incomplete` means the first payment never completed. Treated as unpaid
    // rather than active so the grace clock starts, instead of a store trading
    // indefinitely on a subscription that never began.
    case "incomplete":
    case "paused":
      return "PAST_DUE";
    default:
      // canceled, incomplete_expired, and anything Stripe adds later.
      return "CANCELED";
  }
}

function graceRemaining(status: string, pastDueSince: Date | null): number | null {
  if (status !== "PAST_DUE" || !pastDueSince) return null;
  const elapsedDays = (Date.now() - pastDueSince.getTime()) / 86_400_000;
  return Math.max(0, Math.ceil(GRACE_PERIOD_DAYS - elapsedDays));
}
