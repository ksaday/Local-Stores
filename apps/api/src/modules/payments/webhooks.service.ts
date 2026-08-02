import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isUniqueViolation } from "../../infra/prisma/prisma-errors.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { PaymentProvider, type ProviderEvent } from "../../infra/payments/payment.provider.js";
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
        await this.onRefundUpdated(event, storeId);
        return true;

      case "account.updated":
        await this.onAccountUpdated(event, storeId);
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
      return payment?.order_id ?? null;
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
    if (!storeId) return;

    const error = event.data.last_payment_error as { message?: string } | undefined;

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

  /** Confirms a refund we already recorded as pending. */
  private async onRefundUpdated(event: ProviderEvent, storeId: string | null): Promise<void> {
    if (!storeId) return;

    // `charge.refunded` carries the charge with a refunds list; `refund.updated`
    // carries the refund itself. Both reach the same place.
    const refunds = (event.data.refunds as { data?: { id: string; status: string }[] } | undefined)?.data
      ?? [{ id: event.data.id as string, status: event.data.status as string }];

    for (const refund of refunds) {
      if (!refund?.id) continue;
      const status = refund.status === "succeeded" ? "SUCCEEDED" : refund.status === "failed" ? "FAILED" : "PENDING";

      await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
        tx.$executeRaw`
          UPDATE refunds SET status = ${status}::"RefundStatus", updated_at = now()
          WHERE stripe_refund_id = ${refund.id} AND store_id = ${storeId}
        `,
      );
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

