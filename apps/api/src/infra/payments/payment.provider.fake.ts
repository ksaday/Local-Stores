import { randomUUID } from "node:crypto";
import {
  PaymentProvider,
  type AccountStatus,
  type CreateIntentRequest,
  type OnboardingLink,
  type OnboardingRequest,
  type BillingCustomerRequest,
  type PaymentIntentResult,
  type SubscriptionRequest,
  type SubscriptionResult,
  type ProviderEvent,
  type RefundRequest,
  type RefundResult,
} from "./payment.provider.js";

/**
 * In-memory payment provider for tests.
 *
 * Records every call verbatim so a test can assert on what *would* have been
 * sent to Stripe. That is the only way to prove the platform-fee promise
 * (plan §18.6) without a network: the assertion is about the absence of a
 * field in the request, which no amount of inspecting the response can show.
 *
 * Deliberately not a mocking-library stub. The behaviours that matter here —
 * idempotency keys returning the first result, account status changing after
 * onboarding — are stateful, and expressing them as a small real
 * implementation is clearer than a pile of `mockReturnValueOnce`.
 */
export class FakePaymentProvider extends PaymentProvider {
  readonly intentCalls: CreateIntentRequest[] = [];
  readonly refundCalls: RefundRequest[] = [];
  readonly onboardingCalls: OnboardingRequest[] = [];

  /** Raw arguments as the Stripe adapter would build them, for fee assertions. */
  readonly rawIntentParams: Record<string, unknown>[] = [];

  private readonly accounts = new Map<string, AccountStatus>();
  private readonly intentsByKey = new Map<string, PaymentIntentResult>();
  private readonly refundsByKey = new Map<string, RefundResult>();

  /** Makes the next call of each kind fail, for testing the error paths. */
  failNextIntent: Error | null = null;

  async createOnboardingLink(input: OnboardingRequest): Promise<OnboardingLink> {
    this.onboardingCalls.push(input);
    const accountId = input.existingAccountId ?? `acct_${randomUUID().slice(0, 12)}`;

    if (!this.accounts.has(accountId)) {
      // A fresh account can do nothing until the owner finishes onboarding,
      // which is exactly the state the UI has to handle well.
      this.accounts.set(accountId, {
        accountId,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirementsDue: ["individual.verification.document", "external_account"],
        disabledReason: "requirements.past_due",
      });
    }

    return {
      accountId,
      url: `https://connect.stripe.test/setup/${accountId}`,
      expiresAt: new Date(Date.now() + 300_000),
    };
  }

  async getAccountStatus(accountId: string): Promise<AccountStatus> {
    return (
      this.accounts.get(accountId) ?? {
        accountId,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirementsDue: [],
        disabledReason: "account.not_found",
      }
    );
  }

  /** Test helper: pretend the owner finished Stripe's onboarding. */
  completeOnboarding(accountId: string): void {
    this.accounts.set(accountId, {
      accountId,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsDue: [],
      disabledReason: null,
    });
  }

  async createIntent(input: CreateIntentRequest): Promise<PaymentIntentResult> {
    if (this.failNextIntent) {
      const err = this.failNextIntent;
      this.failNextIntent = null;
      throw err;
    }

    this.intentCalls.push(input);

    // Mirrors the shape the Stripe adapter builds, so a test asserting that
    // `application_fee_amount` is absent is asserting about the real request.
    this.rawIntentParams.push({
      amount: input.amountCents,
      currency: input.currency.toLowerCase(),
      transfer_data: { destination: input.destinationAccountId },
      metadata: { storeId: input.storeId, orderId: input.orderId },
    });

    const existing = this.intentsByKey.get(input.idempotencyKey);
    if (existing) return existing;

    const result: PaymentIntentResult = {
      intentId: `pi_${randomUUID().slice(0, 12)}`,
      clientSecret: `pi_${randomUUID().slice(0, 12)}_secret_${randomUUID().slice(0, 8)}`,
      status: "requires_payment_method",
    };
    this.intentsByKey.set(input.idempotencyKey, result);
    return result;
  }

  async refund(input: RefundRequest): Promise<RefundResult> {
    this.refundCalls.push(input);

    const existing = this.refundsByKey.get(input.idempotencyKey);
    if (existing) return existing;

    const result: RefundResult = {
      refundId: `re_${randomUUID().slice(0, 12)}`,
      status: "succeeded",
      amountCents: input.amountCents ?? 0,
    };
    this.refundsByKey.set(input.idempotencyKey, result);
    return result;
  }

  // ── SaaS billing ─────────────────────────────────────────────────────────

  readonly subscriptionCalls: SubscriptionRequest[] = [];
  private readonly customersByStore = new Map<string, string>();
  private readonly subscriptionsByKey = new Map<string, SubscriptionResult>();

  async ensureBillingCustomer(input: BillingCustomerRequest): Promise<string> {
    if (input.existingCustomerId) return input.existingCustomerId;

    // Stable per store, so calling twice does not silently create a second
    // customer and bill the same shop twice.
    const existing = this.customersByStore.get(input.storeId);
    if (existing) return existing;

    const id = `cus_${randomUUID().slice(0, 12)}`;
    this.customersByStore.set(input.storeId, id);
    return id;
  }

  async createSubscription(input: SubscriptionRequest): Promise<SubscriptionResult> {
    this.subscriptionCalls.push(input);

    const existing = this.subscriptionsByKey.get(input.idempotencyKey);
    if (existing) return existing;

    const trialEndsAt = new Date(Date.now() + input.trialDays * 86_400_000);
    const result: SubscriptionResult = {
      subscriptionId: `sub_${randomUUID().slice(0, 12)}`,
      status: input.trialDays > 0 ? "trialing" : "active",
      trialEndsAt,
      currentPeriodEnd: trialEndsAt,
    };
    this.subscriptionsByKey.set(input.idempotencyKey, result);
    return result;
  }

  async createBillingPortalSession(customerId: string, returnUrl: string): Promise<string> {
    return `https://billing.stripe.test/p/${customerId}?return=${encodeURIComponent(returnUrl)}`;
  }

  /**
   * Accepts anything signed with the literal string `valid`, and rejects
   * everything else. Real signature verification is Stripe's code and is
   * tested in `stripe.provider.test.ts` against their own construction.
   */
  async parseWebhook(rawBody: Buffer, signature: string): Promise<ProviderEvent> {
    if (signature !== "valid") throw new Error("Invalid webhook signature.");

    const parsed = JSON.parse(rawBody.toString("utf8")) as {
      id: string;
      type: string;
      account?: string;
      data: { object: Record<string, unknown> };
    };

    return {
      id: parsed.id,
      type: parsed.type,
      accountId: parsed.account ?? null,
      data: parsed.data.object,
      createdAt: new Date(),
    };
  }
}
