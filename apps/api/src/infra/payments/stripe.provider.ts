import { Injectable, Logger } from "@nestjs/common";
import { timeStripeCall } from "../observability/payment-metrics.js";
import Stripe from "stripe";
import { AppError } from "../../common/errors/app-error.js";
import {
  PaymentProvider,
  type AccountStatus,
  type BillingCustomerRequest,
  type SubscriptionRequest,
  type SubscriptionResult,
  type CreateIntentRequest,
  type OnboardingLink,
  type OnboardingRequest,
  type PaymentIntentResult,
  type ProviderEvent,
  type RefundRequest,
  type RefundResult,
} from "./payment.provider.js";

/**
 * Stripe implementation of the payment seam.
 *
 * Uses **destination charges**: the payment is created on the platform account
 * with `transfer_data.destination` set to the store's connected account, so
 * funds settle to the store. The platform is liable for disputes and the store
 * sees a clean statement.
 *
 * `application_fee_amount` is **never set** — see `createIntent`.
 */
@Injectable()
export class StripePaymentProvider extends PaymentProvider {
  private readonly logger = new Logger(StripePaymentProvider.name);
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    /**
     * Test seam. Supplying an HTTP client keeps requests off the network so
     * the suite can assert on what we *send* — which is the only way to prove
     * `application_fee_amount` is absent (plan §18.6). Never set in production.
     */
    httpClient?: Stripe.HttpClient,
  ) {
    super();
    this.stripe = new Stripe(secretKey, {
      ...(httpClient ? { httpClient } : {}),
      // Pinned rather than floating: Stripe ships breaking changes behind
      // version dates, and an unpinned client changes behaviour on their
      // schedule instead of ours.
      apiVersion: "2026-07-29.dahlia",
      typescript: true,
      // Stripe's client retries idempotently on network failure. Two is enough
      // to ride out a blip without holding a checkout request open for long.
      maxNetworkRetries: 2,
      timeout: 15_000,
    });
  }

  async createOnboardingLink(input: OnboardingRequest): Promise<OnboardingLink> {
    return timeStripeCall("createOnboardingLink", async () => {
      const accountId = input.existingAccountId ?? (await this.createExpressAccount(input));

      const link = await this.stripe.accountLinks.create({
        account: accountId,
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
        type: "account_onboarding",
      });

      return { accountId, url: link.url, expiresAt: new Date(link.expires_at * 1000) };
    });
  }

  /**
   * Express accounts, deliberately.
   *
   * Stripe hosts onboarding and owns the KYC, identity and bank details. The
   * owner gives those to Stripe directly and they never touch our
   * infrastructure, which is what keeps the platform in PCI SAQ-A scope
   * (plan §13) and keeps us out of holding anyone's identity documents.
   */
  private async createExpressAccount(input: OnboardingRequest): Promise<string> {
    const account = await this.stripe.accounts.create({
      type: "express",
      email: input.email,
      country: input.country ?? "US",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: "individual",
      metadata: { storeId: input.storeId },
    });
    this.logger.log(`Created Stripe Express account ${account.id} for store ${input.storeId}`);
    return account.id;
  }

  async getAccountStatus(accountId: string): Promise<AccountStatus> {
    return timeStripeCall("getAccountStatus", async () => {
      const account = await this.stripe.accounts.retrieve(accountId);
      const requirements = account.requirements;

      return {
        accountId: account.id,
        chargesEnabled: account.charges_enabled ?? false,
        payoutsEnabled: account.payouts_enabled ?? false,
        detailsSubmitted: account.details_submitted ?? false,
        // Both lists: `currently_due` is blocking now, `past_due` has already
        // tripped a deadline. An owner needs to see both to understand why they
        // cannot take money.
        requirementsDue: [
          ...(requirements?.currently_due ?? []),
          ...(requirements?.past_due ?? []),
        ],
        disabledReason: requirements?.disabled_reason ?? null,
      };
    });
  }

  async createIntent(input: CreateIntentRequest): Promise<PaymentIntentResult> {
    return timeStripeCall("createIntent", async () => {
      if (input.amountCents <= 0) {
        throw AppError.validation("A payment must be for more than zero.");
      }

      const intent = await this.stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: input.currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },

          // Destination charge. The money settles to the store's account.
          transfer_data: { destination: input.destinationAccountId },

          // `application_fee_amount` is deliberately absent, and must stay that
          // way. BBA takes no cut of any sale (plan §18.6), and passing an
          // explicit zero is NOT equivalent: a zero fee still prints a fee line
          // on the store owner's Stripe statement, which contradicts a promise
          // we make publicly. `stripe.provider.test.ts` asserts the field never
          // appears in the request.

          // Shown on the customer's card statement. The order number is what
          // they will quote when they ring the shop about a charge.
          statement_descriptor_suffix: input.orderNumber.slice(0, 22),
          receipt_email: input.customerEmail ?? undefined,
          metadata: {
            storeId: input.storeId,
            orderId: input.orderId,
            orderNumber: input.orderNumber,
          },
        },
        // Stripe deduplicates on this key for 24h, so a retried checkout returns
        // the original intent rather than charging twice.
        { idempotencyKey: input.idempotencyKey },
      );

      if (!intent.client_secret) {
        throw AppError.internal("Stripe did not return a client secret.");
      }

      return { intentId: intent.id, clientSecret: intent.client_secret, status: intent.status };
    });
  }

  async refund(input: RefundRequest): Promise<RefundResult> {
    return timeStripeCall("refund", async () => {
      // `stripeAccount` scopes the call to the connected account that took the
      // original payment. Without it the refund is attempted on the platform
      // account and either fails or — far worse — refunds from the wrong place.
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: input.intentId,
          ...(input.amountCents !== undefined ? { amount: input.amountCents } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          // Pulls the money back out of the connected account rather than
          // leaving the platform to absorb it.
          refund_application_fee: false,
          reverse_transfer: true,
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return {
        refundId: refund.id,
        status: refund.status ?? "unknown",
        amountCents: refund.amount,
      };
    });
  }

  // ── SaaS billing ─────────────────────────────────────────────────────────

  async ensureBillingCustomer(input: BillingCustomerRequest): Promise<string> {
    return timeStripeCall("ensureBillingCustomer", async () => {
      if (input.existingCustomerId) return input.existingCustomerId;

      const customer = await this.stripe.customers.create({
        email: input.email,
        name: input.storeName,
        // The link back to the store, so a subscription webhook can find it
        // without us keeping a second lookup table in step.
        metadata: { storeId: input.storeId },
      });
      this.logger.log(`Created billing customer ${customer.id} for store ${input.storeId}`);
      return customer.id;
    });
  }

  async createSubscription(input: SubscriptionRequest): Promise<SubscriptionResult> {
    return timeStripeCall("createSubscription", async () => {
      const subscription = await this.stripe.subscriptions.create(
        {
          customer: input.customerId,
          items: [{ price: input.priceId }],
          trial_period_days: input.trialDays,

          // What happens when the trial ends and no card was ever added. Left to
          // Stripe's default the subscription would silently cancel; `pause`
          // keeps it recoverable so an owner who adds a card in week five gets
          // their shop back rather than starting again.
          trial_settings: {
            end_behavior: { missing_payment_method: "pause" },
          },
          // Bill the card on file rather than emailing an invoice to chase.
          collection_method: "charge_automatically",
          payment_behavior: "default_incomplete",
          payment_settings: { save_default_payment_method: "on_subscription" },
          metadata: { storeId: input.storeId },
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return {
        subscriptionId: subscription.id,
        status: subscription.status,
        trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        currentPeriodEnd: currentPeriodEnd(subscription),
      };
    });
  }

  async createBillingPortalSession(customerId: string, returnUrl: string): Promise<string> {
    return timeStripeCall("createBillingPortalSession", async () => {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      return session.url;
    });
  }

  async parseWebhook(rawBody: Buffer, signature: string): Promise<ProviderEvent> {
    let event: Stripe.Event;
    try {
      // Throws on a bad signature, a replayed timestamp outside tolerance, or
      // a body that was re-serialised anywhere in transit.
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      // Deliberately not logged with the body: a failed verification is either
      // a misconfiguration or someone probing, and neither is worth writing
      // attacker-controlled JSON into our logs for.
      this.logger.warn(`Rejected webhook: ${err instanceof Error ? err.message : "bad signature"}`);
      throw AppError.forbidden("Invalid webhook signature.");
    }

    return {
      id: event.id,
      type: event.type,
      accountId: event.account ?? null,
      data: event.data.object as unknown as Record<string, unknown>,
      createdAt: new Date(event.created * 1000),
    };
  }
}

/**
 * The end of the current billing period.
 *
 * Stripe moved this from the subscription to its items, so it is read from the
 * first item with a fallback — a version bump should not silently produce a
 * subscription whose renewal date is null everywhere in the UI.
 */
function currentPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const item = subscription.items?.data?.[0] as { current_period_end?: number } | undefined;
  const seconds =
    item?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end;
  return seconds ? new Date(seconds * 1000) : null;
}
