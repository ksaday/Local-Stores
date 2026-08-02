import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { PaymentProvider } from "../../infra/payments/payment.provider.js";
import { AuditService } from "../audit/audit.service.js";

export interface ConnectStatus {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
  syncedAt: Date | null;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly audit: AuditService,
  ) {}

  // ── Connect onboarding ───────────────────────────────────────────────────

  /**
   * Starts or resumes Stripe onboarding for a store.
   *
   * Reuses an existing account id when there is one: onboarding is frequently
   * abandoned halfway and resumed days later, and creating a second account
   * would strand whatever the owner already submitted.
   */
  async startOnboarding(storeId: string, actorUserId: string, origin: string) {
    const store = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.findFirst({
        where: { id: storeId },
        select: { id: true, name: true, stripeAccountId: true, country: true, ownerUserId: true },
      }),
    );
    if (!store) throw AppError.notFound();

    // The owner's email, read deliberately outside store scope.
    //
    // The `users` policy only exposes people who hold a *membership* in the
    // current store, and an owner does not get one until they accept their
    // invitation — so joining `store.owner` from a store-scoped read returns
    // null for any store whose owner hasn't accepted yet, and Prisma throws on
    // the non-nullable relation. Reading it as the platform is both correct
    // and honest about what is happening: registering a payment account for a
    // store is platform work, and this is the address the provider will use
    // for compliance correspondence.
    const owner = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.user.findFirst({ where: { id: store.ownerUserId }, select: { email: true } }),
    );
    if (!owner) throw AppError.internal("This store has no owner on record.");

    const settingsUrl = `${origin}/store/${storeId}/ops/settings`;
    const link = await this.provider.createOnboardingLink({
      storeId,
      email: owner.email,
      returnUrl: `${settingsUrl}?stripe=return`,
      // Stripe sends the owner here if the link expired before they finished,
      // and the settings page starts them again.
      refreshUrl: `${settingsUrl}?stripe=refresh`,
      existingAccountId: store.stripeAccountId,
      country: store.country ?? "US",
    });

    if (store.stripeAccountId !== link.accountId) {
      await this.prisma.withTenant({ storeId, userId: actorUserId, isSuperAdmin: false }, (tx) =>
        tx.store.update({ where: { id: storeId }, data: { stripeAccountId: link.accountId } }),
      );
      await this.audit.record({
        storeId,
        actorUserId,
        action: "payments.connect_started",
        entityType: "store",
        entityId: storeId,
        after: { accountId: link.accountId },
      });
    }

    return { url: link.url, expiresAt: link.expiresAt };
  }

  /** Re-reads the account from the provider and stores what it says. */
  async syncConnectStatus(storeId: string): Promise<ConnectStatus> {
    const store = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.findFirst({ where: { id: storeId }, select: { stripeAccountId: true } }),
    );
    if (!store) throw AppError.notFound();
    if (!store.stripeAccountId) {
      return {
        accountId: null,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirementsDue: [],
        disabledReason: null,
        syncedAt: null,
      };
    }

    const status = await this.provider.getAccountStatus(store.stripeAccountId);
    return this.persistAccountStatus(storeId, status);
  }

  /**
   * Writes provider account state onto the store.
   *
   * Called from both the manual sync and the `account.updated` webhook, so
   * there is one place that decides what "this store can take cards" means.
   */
  private async persistAccountStatus(
    storeId: string,
    status: {
      accountId: string;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      detailsSubmitted: boolean;
      requirementsDue: string[];
      disabledReason: string | null;
    },
  ): Promise<ConnectStatus> {
    const syncedAt = new Date();
    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.update({
        where: { id: storeId },
        data: {
          stripeAccountId: status.accountId,
          stripeChargesEnabled: status.chargesEnabled,
          stripePayoutsEnabled: status.payoutsEnabled,
          stripeDetailsSubmitted: status.detailsSubmitted,
          stripeRequirements: status.requirementsDue,
          stripeDisabledReason: status.disabledReason,
          stripeSyncedAt: syncedAt,
        },
      }),
    );

    return { ...status, syncedAt };
  }

  async getConnectStatus(storeId: string): Promise<ConnectStatus> {
    const store = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.findFirst({
        where: { id: storeId },
        select: {
          stripeAccountId: true, stripeChargesEnabled: true, stripePayoutsEnabled: true,
          stripeDetailsSubmitted: true, stripeRequirements: true,
          stripeDisabledReason: true, stripeSyncedAt: true,
        },
      }),
    );
    if (!store) throw AppError.notFound();

    return {
      accountId: store.stripeAccountId,
      chargesEnabled: store.stripeChargesEnabled,
      payoutsEnabled: store.stripePayoutsEnabled,
      detailsSubmitted: store.stripeDetailsSubmitted,
      requirementsDue: (store.stripeRequirements ?? []) as string[],
      disabledReason: store.stripeDisabledReason,
      syncedAt: store.stripeSyncedAt,
    };
  }

  // ── Taking a card payment ────────────────────────────────────────────────

  /**
   * Creates a card payment for an existing order.
   *
   * The amount comes from the order row, never from the caller: a client that
   * can name its own amount can pay a penny for a hundred-pound basket.
   *
   * Called after the order transaction has committed, never inside it —
   * holding a database transaction open across a call to Stripe is how
   * connection pools die (plan §12.6).
   */
  async createCardPayment(
    storeId: string,
    orderId: string,
    idempotencyKey: string,
    /**
     * Who is asking. A customer pays for their own order, a guest presents the
     * claim token from their receipt, and staff may take payment over the
     * counter.
     */
    caller: { userId?: string; guestToken?: string; isStaff?: boolean },
  ) {
    // Proves the caller is entitled to this order *before* anything is done
    // with store scope.
    //
    // Without this the endpoint is public and store-scoped at once: anyone who
    // guessed an order id would get back a client secret for a stranger's
    // order. RLS decides here — a caller with neither identity sees no row.
    if (!caller.isStaff) {
      const visible = await this.prisma.withTenant(
        { userId: caller.userId, guestToken: caller.guestToken, isSuperAdmin: false },
        (tx) => tx.order.findFirst({ where: { id: orderId, storeId }, select: { id: true } }),
      );
      if (!visible) throw AppError.notFound();
    }

    const context = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, storeId },
        select: {
          id: true, orderNumber: true, totalCents: true, currency: true,
          status: true, contactEmail: true,
          store: { select: { stripeAccountId: true, stripeChargesEnabled: true } },
          payments: { select: { id: true, provider: true, status: true, stripePaymentIntentId: true } },
        },
      });
      return order;
    });

    if (!context) throw AppError.notFound();
    if (context.status !== "PENDING") {
      throw AppError.validation("This order is no longer awaiting payment.");
    }

    const { stripeAccountId, stripeChargesEnabled } = context.store;
    if (!stripeAccountId || !stripeChargesEnabled) {
      // Surfaced as a validation error rather than a 500: the shop simply is
      // not set up for cards yet, which is a state the checkout page should
      // have avoided offering in the first place.
      throw AppError.validation("This store can't take card payments yet.");
    }

    // An intent already exists for this order — return it rather than creating
    // a second one. A customer who reloads checkout must not produce two
    // charges sitting against one order.
    const existing = context.payments.find(
      (p) => p.provider === "STRIPE" && p.stripePaymentIntentId,
    );
    if (existing?.stripePaymentIntentId) {
      const intent = await this.provider.createIntent({
        storeId,
        orderId,
        orderNumber: context.orderNumber,
        amountCents: context.totalCents,
        currency: context.currency,
        destinationAccountId: stripeAccountId,
        idempotencyKey,
        customerEmail: context.contactEmail,
      });
      return { clientSecret: intent.clientSecret, intentId: intent.intentId, amountCents: context.totalCents };
    }

    const intent = await this.provider.createIntent({
      storeId,
      orderId,
      orderNumber: context.orderNumber,
      amountCents: context.totalCents,
      currency: context.currency,
      destinationAccountId: stripeAccountId,
      idempotencyKey,
      customerEmail: context.contactEmail,
    });

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        INSERT INTO payments (id, store_id, order_id, provider, stripe_payment_intent_id,
                              amount_cents, application_fee_cents, status)
        VALUES (${randomUUID()}, ${storeId}, ${orderId}, 'STRIPE', ${intent.intentId},
                ${context.totalCents}, 0, 'REQUIRES_ACTION')
      `,
    );

    return { clientSecret: intent.clientSecret, intentId: intent.intentId, amountCents: context.totalCents };
  }

  // ── Refunds ──────────────────────────────────────────────────────────────

  /**
   * Refunds a payment, in whole or in part.
   *
   * The refund row is written PENDING *before* the provider is called and only
   * confirmed by the webhook. Marking it succeeded on the optimistic path
   * would mean a network timeout after Stripe accepted the refund leaves the
   * books saying the money never went back (plan §12.6).
   */
  async refund(
    storeId: string,
    orderId: string,
    actorUserId: string,
    input: { amountCents?: number; reasonCode?: string; note?: string },
  ) {
    const payment = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      const [row] = await tx.$queryRaw<
        { id: string; provider: string; status: string; amount_cents: number; intent_id: string | null; account_id: string | null }[]
      >`
        SELECT p.id, p.provider::text AS provider, p.status::text AS status, p.amount_cents,
               p.stripe_payment_intent_id AS intent_id, s.stripe_account_id AS account_id
        FROM payments p
        JOIN orders o ON o.id = p.order_id
        JOIN stores s ON s.id = p.store_id
        WHERE p.order_id = ${orderId} AND p.store_id = ${storeId} AND p.status = 'SUCCEEDED'
        ORDER BY p.created_at DESC
        LIMIT 1
      `;
      return row;
    });

    if (!payment) throw AppError.notFound("No completed payment to refund for this order.");

    const amountCents = input.amountCents ?? payment.amount_cents;
    if (amountCents <= 0) throw AppError.validation("A refund must be for more than zero.");
    if (amountCents > payment.amount_cents) {
      throw AppError.validation("You can't refund more than was paid.");
    }

    const refundId = randomUUID();

    // Written first. The database trigger refuses anything that would take the
    // total past what was captured, including two concurrent partial refunds
    // that each look fine alone.
    await this.prisma.withTenant({ storeId, userId: actorUserId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        INSERT INTO refunds (id, store_id, payment_id, amount_cents, reason_code, note, status, actor_user_id)
        VALUES (${refundId}, ${storeId}, ${payment.id}, ${amountCents},
                ${input.reasonCode ?? null}, ${input.note ?? null}, 'PENDING', ${actorUserId})
      `,
    );

    // Cash never went through a provider, so there is nothing to call: the
    // record of the till being opened is the whole transaction.
    if (payment.provider === "CASH") {
      await this.prisma.withTenant({ storeId, userId: actorUserId, isSuperAdmin: false }, (tx) =>
        tx.$executeRaw`UPDATE refunds SET status = 'SUCCEEDED', updated_at = now() WHERE id = ${refundId}`,
      );
      await this.audit.record({
        storeId, actorUserId,
        action: "payments.cash_refunded",
        entityType: "refund", entityId: refundId,
        after: { orderId, amountCents },
      });
      return { refundId, amountCents, status: "SUCCEEDED" as const, provider: "CASH" as const };
    }

    if (!payment.intent_id || !payment.account_id) {
      throw AppError.internal("That payment is missing its provider references.");
    }

    try {
      const result = await this.provider.refund({
        intentId: payment.intent_id,
        amountCents,
        // The account that took the original payment. Passing the wrong one is
        // the single worst bug available here, so it comes from the payment's
        // own store row rather than from anything the caller supplied.
        accountId: payment.account_id,
        reason: mapReason(input.reasonCode),
        idempotencyKey: refundId,
      });

      await this.prisma.withTenant({ storeId, userId: actorUserId, isSuperAdmin: false }, (tx) =>
        tx.$executeRaw`
          UPDATE refunds SET stripe_refund_id = ${result.refundId}, updated_at = now()
          WHERE id = ${refundId}
        `,
      );

      await this.audit.record({
        storeId, actorUserId,
        action: "payments.refund_requested",
        entityType: "refund", entityId: refundId,
        after: { orderId, amountCents, stripeRefundId: result.refundId },
      });

      // Still PENDING: the webhook confirms it. See the note on this method.
      return { refundId, amountCents, status: "PENDING" as const, provider: "STRIPE" as const };
    } catch (err) {
      await this.prisma.withTenant({ storeId, userId: actorUserId, isSuperAdmin: false }, (tx) =>
        tx.$executeRaw`
          UPDATE refunds SET status = 'FAILED', note = ${String(err).slice(0, 500)}, updated_at = now()
          WHERE id = ${refundId}
        `,
      );
      throw err;
    }
  }

  async listRefunds(storeId: string, orderId: string) {
    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<
        { id: string; amount_cents: number; status: string; reason_code: string | null; created_at: Date }[]
      >`
        SELECT r.id, r.amount_cents, r.status::text AS status, r.reason_code, r.created_at
        FROM refunds r JOIN payments p ON p.id = r.payment_id
        WHERE r.store_id = ${storeId} AND p.order_id = ${orderId}
        ORDER BY r.created_at DESC
      `,
    );
  }
}

/** Maps our reason codes onto the provider's fixed vocabulary. */
function mapReason(code?: string): "duplicate" | "fraudulent" | "requested_by_customer" | undefined {
  switch (code) {
    case "duplicate":
      return "duplicate";
    case "fraud":
    case "fraudulent":
      return "fraudulent";
    case "customer_request":
    case "requested_by_customer":
      return "requested_by_customer";
    default:
      // Stripe rejects anything outside its enum, and a shop's own reason
      // ("burnt the bread") is kept on our row rather than forced into theirs.
      return undefined;
  }
}
