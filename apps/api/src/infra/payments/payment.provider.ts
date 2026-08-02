/**
 * The payment seam (plan §12.10).
 *
 * Order logic talks to this, never to Stripe directly. FR-PAY-08 anticipates
 * Square and PayPal; those implement this interface and checkout does not
 * change. It also makes the payment path testable without a network — the
 * fake in `payment.provider.fake.ts` is what the test suite runs against.
 *
 * Every method takes the store's connected account explicitly rather than
 * reading it from ambient state. Money moving to the wrong store is the worst
 * failure this system can have, so the destination is always visible at the
 * call site.
 */
export abstract class PaymentProvider {
  /** Begins onboarding, returning a URL the owner completes at the provider. */
  abstract createOnboardingLink(input: OnboardingRequest): Promise<OnboardingLink>;

  /** Current capability status of a connected account. */
  abstract getAccountStatus(accountId: string): Promise<AccountStatus>;

  abstract createIntent(input: CreateIntentRequest): Promise<PaymentIntentResult>;

  abstract refund(input: RefundRequest): Promise<RefundResult>;

  // ── SaaS billing ─────────────────────────────────────────────────────────
  //
  // The platform charging the store, which is a different relationship from
  // everything above: there the store is the merchant receiving money, here
  // the store owner is the customer paying us. Keeping both on one interface
  // is deliberate — one provider, one set of credentials, one webhook stream —
  // but the two must never be conflated in calling code.

  /** Creates or reuses the billing customer for a store owner. */
  abstract ensureBillingCustomer(input: BillingCustomerRequest): Promise<string>;

  /** Starts the subscription, including its free trial. */
  abstract createSubscription(input: SubscriptionRequest): Promise<SubscriptionResult>;

  /**
   * A link to the provider's hosted billing portal.
   *
   * The owner manages their card, invoices and cancellation there. That is the
   * point: card details for the subscription never reach this platform either,
   * exactly as they do not for a shopper's payment.
   */
  abstract createBillingPortalSession(customerId: string, returnUrl: string): Promise<string>;

  /**
   * Verifies a webhook signature and returns the parsed event.
   *
   * Takes the raw body, not a parsed object: signature verification is over
   * the exact bytes received, and any re-serialisation breaks it.
   */
  abstract parseWebhook(rawBody: Buffer, signature: string): Promise<ProviderEvent>;
}

export interface OnboardingRequest {
  storeId: string;
  email: string;
  /** Where the provider sends the owner when they finish or abandon. */
  returnUrl: string;
  refreshUrl: string;
  /** Reuses an existing account when onboarding was started before. */
  existingAccountId?: string | null;
  country?: string;
}

export interface OnboardingLink {
  accountId: string;
  url: string;
  expiresAt: Date;
}

export interface AccountStatus {
  accountId: string;
  /** Can accept payments. Until this is true, checkout must not offer cards. */
  chargesEnabled: boolean;
  /** Can receive payouts to a bank account. */
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** What the provider still wants, for showing the owner why they are blocked. */
  requirementsDue: string[];
  disabledReason: string | null;
}

export interface CreateIntentRequest {
  storeId: string;
  orderId: string;
  orderNumber: string;
  amountCents: number;
  currency: string;
  /** The store's connected account. The money's destination. */
  destinationAccountId: string;
  /** Makes a retried request return the original intent instead of a second charge. */
  idempotencyKey: string;
  customerEmail?: string | null;
}

export interface PaymentIntentResult {
  intentId: string;
  /** Handed to the browser so the card form can confirm it. Never a secret key. */
  clientSecret: string;
  status: string;
}

export interface RefundRequest {
  /** The intent being refunded, which fixes the account the money comes from. */
  intentId: string;
  /** Omit for a full refund. */
  amountCents?: number;
  /** The connected account that took the original payment. */
  accountId: string;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
  idempotencyKey: string;
}

export interface RefundResult {
  refundId: string;
  status: string;
  amountCents: number;
}

export interface BillingCustomerRequest {
  storeId: string;
  storeName: string;
  email: string;
  existingCustomerId?: string | null;
}

export interface SubscriptionRequest {
  customerId: string;
  /** The provider-side price. Without it there is nothing to subscribe to. */
  priceId: string;
  trialDays: number;
  storeId: string;
  idempotencyKey: string;
}

export interface SubscriptionResult {
  subscriptionId: string;
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

/** A provider event, normalised to what the handlers actually need. */
export interface ProviderEvent {
  /** Provider-assigned, unique. The idempotency key for webhook handling. */
  id: string;
  type: string;
  /** The connected account it happened on, when it is an account-scoped event. */
  accountId: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
}
