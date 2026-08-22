import { Injectable, Logger } from "@nestjs/common";
import { declineReason, paymentOutcomes } from "../../infra/observability/payment-metrics.js";
import { randomUUID } from "node:crypto";
import { isUniqueViolation } from "../../infra/prisma/prisma-errors.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { PaymentProvider, type ProviderEvent } from "../../infra/payments/payment.provider.js";
import { BillingService } from "../billing/billing.service.js";
import { OrdersService } from "../orders/orders.service.js";

export interface WebhookOutcome {
  eventId: string;
  type: string;
  /** True when this event had already been recorded and was skipped. */
  duplicate: boolean;
  handled: boolean;
}

@Injectable()
export class StripeWebhooksService {
  private readonly logger = new Logger(StripeWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly orders: OrdersService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Verifies, records, and acts on a provider webhook.
   *
   * The order of operations is the whole design:
   *
   * 1. **Verify the signature.** An unverified body is an unauthenticated
   *    request to mark orders paid.
   * 2. **Record the event.** The unique index on the provider's event id is
   *    what makes this idempotent — a replayed event loses the insert and is
   *    never handled twice. Stripe delivers at least once and retries for days,
   *    so replays are routine rather than exceptional.
   * 3. **Handle it**, then mark it processed.
   *
   * Recording *before* handling matters: if the handler crashes, the event is
   * still on disk with its error, so it can be inspected and replayed rather
   * than vanishing with the process.
   */
  async handle(rawBody: Buffer, signature: string): Promise<WebhookOutcome> {
    // Throws on a bad signature — deliberately before anything is written.
    const event = await this.provider.parseWebhook(rawBody, signature);

    const storeId = await this.resolveStore(event);
    const recorded = await this.record(event, storeId);
    if (!recorded) {
      this.logger.log(`Ignoring replayed event ${event.id} (${event.type})`);
      return { eventId: event.id, type: event.type, duplicate: true, handled: false };
    }

    try {
      const handled = await this.dispatch(event, storeId);
      await this.markProcessed(event.id, null);
      return { eventId: event.id, type: event.type, duplicate: false, handled };
    } catch (err) {
      // Recorded rather than swallowed, and rethrown so the provider retries.
      await this.markProcessed(event.id, String(err).slice(0, 1000));
      this.logger.error(`Webhook ${event.id} (${event.type}) failed: ${String(err)}`);
      throw err;
    }
  }

  /**
   * Inserts the event, returning false if it was already there.
   *
   * Super-admin scope because a webhook arrives with no session and may
   * concern any store — this is the platform acting on its own integration,
   * not a tenant acting on their data.
   */
  private async record(event: ProviderEvent, storeId: string | null): Promise<boolean> {
    try {
      await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
        tx.$executeRaw`
          INSERT INTO stripe_events (id, event_id, type, account_id, store_id, payload)
          VALUES (${randomUUID()}, ${event.id}, ${event.type}, ${event.accountId},
                  ${storeId}, ${JSON.stringify(event.data)}::jsonb)
        `,
      );
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  private async markProcessed(eventId: string, error: string | null): Promise<void> {
    await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$executeRaw`
        UPDATE stripe_events SET processed_at = now(), error = ${error} WHERE event_id = ${eventId}
      `,
    );
  }

  /**
   * Works out which store an event belongs to.
   *
   * Metadata first — we set `storeId` on every intent we create, so it is the
   * most direct answer. Falls back to the connected account, which is how
   * account-level events (onboarding progress) arrive.
   */
  private async resolveStore(event: ProviderEvent): Promise<string | null> {
    const metadata = event.data.metadata as Record<string, string> | undefined;
    if (metadata?.storeId) return metadata.storeId;

    const accountId = event.accountId ?? (event.data.id as string | undefined);
    if (!accountId) return null;

    const store = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.store.findFirst({ where: { stripeAccountId: accountId }, select: { id: true } }),
    );
    return store?.id ?? null;
  }

  /** Returns true when the event type was one we act on. */
  private async dispatch(event: ProviderEvent, storeId: string | null): Promise<boolean> {
    switch (event.type) {
      case "payment_intent.succeeded":
        await this.onPaymentSucceeded(event, storeId);
        return true;

      case "payment_intent.payment_failed":
        await this.onPaymentFailed(event, storeId);
        return true;

      case "charge.refunded":
      case "refund.updated":
      case "charge.refund.updated":
        await this.onRefundUpdated(event, storeId);
        return true;

      case "account.updated":
        await this.onAccountUpdated(event, storeId);
        return true;

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await this.onSubscriptionChanged(event);
        return true;

      default:
        // Stripe sends far more than we subscribe to. Recording and ignoring
        // is correct — and the row is there if we later want the history.
        return false;
    }
  }

  /**
   * The money arrived.
   *
   * Marks the payment succeeded and confirms the order, which is what converts
   * the stock reservation into an actual sale. Both go through the existing
   * order transition so the state machine, the stock ledger and the history
   * are all maintained by the one code path staff actions use.
   */
  private async onPaymentSucceeded(event: ProviderEvent, storeId: string | null): Promise<void> {
    const intentId = event.data.id as string;

    // Counted before anything can return early. The money moved at Stripe
    // whatever we manage to do about it locally, and a metric that only counts
    // the payments we successfully recorded would understate takings in exactly
    // the situation worth knowing about.
    paymentOutcomes.inc({ provider: "STRIPE", outcome: "succeeded", reason: "none" });

    if (!storeId) {
      this.logger.warn(`payment_intent.succeeded ${intentId} has no resolvable store`);
      return;
    }

    const orderId = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      const [payment] = await tx.$queryRaw<{ order_id: string }[]>`
        UPDATE payments SET status = 'SUCCEEDED', updated_at = now()
        WHERE stripe_payment_intent_id = ${intentId} AND store_id = ${storeId}
        RETURNING order_id
      `;
      if (!payment) return null;

      // The order has carried a pending CASH row since it was placed. Left
      // alone it reads as money still owed, and the workbench asks a clerk to
      // collect cash for an order the customer has already paid by card.
      await this.orders.retireSupersededPayments(tx, storeId, payment.order_id);

      return payment.order_id;
    });

    if (!orderId) {
      this.logger.warn(`No payment row for intent ${intentId}`);
      return;
    }

    try {
      await this.orders.transition(storeId, orderId, "CONFIRMED", { userId: null, role: "SYSTEM" }, "Card payment received");
    } catch (err) {
      // A confirmed order that receives a duplicate success event is fine —
      // the transition refuses and there is nothing more to do. Anything else
      // is worth surfacing.
      this.logger.warn(`Could not confirm order ${orderId} after payment: ${String(err)}`);
    }
  }

  private async onPaymentFailed(event: ProviderEvent, storeId: string | null): Promise<void> {
    const intentId = event.data.id as string;

    const error = event.data.last_payment_error as
      | { message?: string; code?: unknown; decline_code?: unknown }
      | undefined;

    // The decline code, not the message: the code is a bounded set Stripe
    // documents, the message is free text that varies by card and issuer and
    // would be an unbounded label. See `declineReason`.
    paymentOutcomes.inc({
      provider: "STRIPE",
      outcome: "failed",
      reason: declineReason(error),
    });

    if (!storeId) return;


    // The order is deliberately left PENDING rather than cancelled: a declined
    // card is usually followed by a second attempt with a different one, and
    // cancelling would release the stock out from under a customer who is
    // still standing at the checkout. The expiry sweeper handles the case
    // where they truly give up.
    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        UPDATE payments
        SET status = 'FAILED', failure_reason = ${error?.message ?? "Card declined"}, updated_at = now()
        WHERE stripe_payment_intent_id = ${intentId} AND store_id = ${storeId}
      `,
    );
  }

  /**
   * Confirms a refund we already recorded as pending.
   *
   * Keyed off our own `stripe_refund_id`, not off the store — which is the
   * only thing that actually works here. A refund object carries no store
   * metadata, and with destination charges these arrive as platform-level
   * events with no connected account either, so store resolution yields null
   * and any handler that needs it first will silently do nothing.
   *
   * Two payload shapes reach this:
   *   - `refund.updated` — the refund itself, so `id` is the refund id.
   *   - `charge.refunded` — the charge. Stripe does NOT expand `refunds.data`
   *     in webhooks (verified against real traffic: the key is absent), so the
   *     only usable handle is `payment_intent`.
   */
  private async onRefundUpdated(event: ProviderEvent, _storeId: string | null): Promise<void> {
    const data = event.data as {
      id?: string;
      object?: string;
      status?: string;
      payment_intent?: string;
    };

    // Super-admin scope: a webhook has no session, and the refund row is what
    // tells us which store this belongs to — so we cannot scope by store
    // before finding it.
    await this.prisma.withTenant({ isSuperAdmin: true }, async (tx) => {
      if (data.object === "refund" && data.id) {
        const status = mapRefundStatus(data.status);
        await tx.$executeRaw`
          UPDATE refunds SET status = ${status}::"RefundStatus", updated_at = now()
          WHERE stripe_refund_id = ${data.id}
        `;
        return;
      }

      // A charge: reconcile every refund we hold against that payment by
      // asking the payment row, which we own, rather than the payload.
      if (data.payment_intent) {
        await tx.$executeRaw`
          UPDATE refunds r
          SET status = 'SUCCEEDED', updated_at = now()
          FROM payments p
          WHERE r.payment_id = p.id
            AND p.stripe_payment_intent_id = ${data.payment_intent}
            AND r.status = 'PENDING'
            AND r.stripe_refund_id IS NOT NULL
        `;
      }
    });
  }

  /**
   * The store's own subscription to the platform changed.
   *
   * Stripe is the authority on whether a shop has paid us; this mirrors what
   * it says and lets the billing service decide the consequences. Note this is
   * entirely separate from a store's Connect account — a shop with flawless
   * payment processing can still stop paying its own bill.
   */
  private async onSubscriptionChanged(event: ProviderEvent): Promise<void> {
    const sub = event.data as {
      id?: string;
      status?: string;
      trial_end?: number;
      current_period_end?: number;
      items?: { data?: { current_period_end?: number }[] };
    };
    if (!sub.id || !sub.status) return;

    // Stripe moved the period end onto subscription items; read both so a
    // version change does not silently null out every renewal date.
    const periodEnd = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;

    const result = await this.billing.applyProviderStatus({
      subscriptionId: sub.id,
      status: sub.status,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    });

    if (result) {
      this.logger.log(`Store ${result.storeId} subscription -> ${result.status}`);
    }
  }

  /**
   * Onboarding progressed, or the account lost a capability.
   *
   * This is the event that flips a store from "cannot take cards" to "can",
   * without the owner having to come back and press anything.
   */
  private async onAccountUpdated(event: ProviderEvent, storeId: string | null): Promise<void> {
    if (!storeId) return;

    const account = event.data as {
      id: string;
      charges_enabled?: boolean;
      payouts_enabled?: boolean;
      details_submitted?: boolean;
      requirements?: { currently_due?: string[]; past_due?: string[]; disabled_reason?: string | null };
    };

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.update({
        where: { id: storeId },
        data: {
          stripeChargesEnabled: account.charges_enabled ?? false,
          stripePayoutsEnabled: account.payouts_enabled ?? false,
          stripeDetailsSubmitted: account.details_submitted ?? false,
          stripeRequirements: [
            ...(account.requirements?.currently_due ?? []),
            ...(account.requirements?.past_due ?? []),
          ],
          stripeDisabledReason: account.requirements?.disabled_reason ?? null,
          stripeSyncedAt: new Date(),
        },
      }),
    );

    this.logger.log(
      `Store ${storeId} connect status: charges=${account.charges_enabled} payouts=${account.payouts_enabled}`,
    );
  }
}


/** Stripe's refund states, narrowed to ours. */
function mapRefundStatus(status: string | undefined): "SUCCEEDED" | "FAILED" | "PENDING" {
  if (status === "succeeded") return "SUCCEEDED";
  // `canceled` means the refund will never land, which for our books is the
  // same outcome as failing — the money stayed where it was.
  if (status === "failed" || status === "canceled") return "FAILED";
  return "PENDING";
}
