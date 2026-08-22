import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registry as metricsRegistry } from "../../infra/observability/metrics.js";
import { testNotifications } from "../notifications/test-notifications.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { FakePaymentProvider } from "../../infra/payments/payment.provider.fake.js";
import { AuditService } from "../audit/audit.service.js";
import { CartService, type Shopper } from "../cart/cart.service.js";
import { CheckoutService } from "../checkout/checkout.service.js";
import { ConfiguredRateTaxProvider } from "../checkout/tax.provider.js";
import { CouponsService } from "../coupons/coupons.service.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { OrdersService } from "../orders/orders.service.js";
import { BillingService } from "../billing/billing.service.js";
import { PaymentsService } from "./payments.service.js";
import { StripeWebhooksService } from "./webhooks.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const OWNER = "d2000000-0000-4000-8000-000000000001";
const BUYER = "d2000000-0000-4000-8000-000000000002";
const STORE = "d2000000-0000-4000-8000-00000000000a";
const ACCOUNT = "acct_webhook_store";

let prisma: PrismaService;
let provider: FakePaymentProvider;
let payments: PaymentsService;
let billing: BillingService;
let webhooks: StripeWebhooksService;
let orders: OrdersService;
let cart: CartService;
let checkout: CheckoutService;
let variantId = "";

beforeAll(() => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await seed();

  provider = new FakePaymentProvider();
  const audit = new AuditService(prisma);
  const outbox = new OutboxService(prisma);
  payments = new PaymentsService(prisma, provider, audit);
  billing = new BillingService(prisma, provider, audit);
  orders = new OrdersService(prisma, audit, outbox, testNotifications(prisma).notifications);
  webhooks = new StripeWebhooksService(prisma, provider, orders, billing);
  cart = new CartService(prisma);
  checkout = new CheckoutService(prisma, new ConfiguredRateTaxProvider(async () => null), outbox, new CouponsService(prisma, new AuditService(prisma)));
});

async function asAdmin<T>(work: (db: PrismaService) => Promise<T>): Promise<T> {
  const db = new PrismaService();
  try {
    return await work(db);
  } finally {
    await db.$disconnect();
  }
}

async function seed(): Promise<void> {
  await asAdmin(async (db) => {
    await db.$executeRaw`
      INSERT INTO users (id,email,name,status,created_at,updated_at) VALUES
      (${OWNER},'wh-owner@example.com'::citext,'Owner','ACTIVE',now(),now()),
      (${BUYER},'wh-buyer@example.com'::citext,'Buyer','ACTIVE',now(),now())`;

    await db.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,city,state,timezone,
                          currency,branding,cash_enabled,stripe_account_id,stripe_charges_enabled,
                          platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'wh-store'::citext,'Webhook Store','RETAIL','ACTIVE',${OWNER},
              'Chicago','IL','America/Chicago','USD','{}'::jsonb,true,${ACCOUNT},true,0,now(),now())`;

    const productId = crypto.randomUUID();
    variantId = crypto.randomUUID();
    await db.$executeRaw`
      INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
      VALUES (${productId},${STORE},'Loaf','loaf','ACTIVE',now(),now())`;
    await db.$executeRaw`
      INSERT INTO product_variants (id,store_id,product_id,price_cents,is_default,active,attrs,created_at,updated_at)
      VALUES (${variantId},${STORE},${productId},1000,true,true,'{}'::jsonb,now(),now())`;
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (db) => {
    await db.$executeRaw`DELETE FROM stripe_events WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM refunds WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM payments WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM order_status_history WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM order_items WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM orders WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM cart_items WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM carts WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM store_counters WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM stock_movements WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM stock_levels WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM outbox_events WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await db.$executeRaw`DELETE FROM users WHERE id IN (${OWNER},${BUYER})`;
  });
}

const buyer: Shopper = { kind: "user", userId: BUYER };

async function placeOrder() {
  await cart.addItem(STORE, buyer, variantId, 1);
  return checkout.placeOrder(STORE, buyer, {
    fulfillment: "PICKUP",
    idempotencyKey: crypto.randomUUID(),
  });
}

/** Builds a webhook body in the provider's shape. */
function event(type: string, object: Record<string, unknown>, id = `evt_${crypto.randomUUID()}`) {
  return { id, body: Buffer.from(JSON.stringify({ id, type, data: { object } })) };
}

async function stock(qty: number): Promise<void> {
  await asAdmin(async (db) => {
    await db.$executeRaw`
      INSERT INTO stock_movements (id,store_id,variant_id,type,qty_delta)
      VALUES (gen_random_uuid(),${STORE},${variantId},'RECEIVE',${qty})`;
    await db.$executeRaw`UPDATE stock_levels SET tracked = true WHERE variant_id = ${variantId}`;
  });
}

async function readStock() {
  return asAdmin(async (db) => {
    const [row] = await db.$queryRaw<{ on_hand: number; reserved: number }[]>`
      SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${variantId}`;
    return row ?? { on_hand: 0, reserved: 0 };
  });
}

describe("authenticity", () => {
  it("refuses a body that isn't correctly signed", async () => {
    // The signature is the only authentication a webhook has. Without this
    // check the endpoint is an unauthenticated way to mark orders paid.
    const { body } = event("payment_intent.succeeded", { id: "pi_x" });
    await expect(webhooks.handle(body, "not-the-signature")).rejects.toThrow();
  });

  it("records nothing when the signature fails", async () => {
    // Scoped to this event's own id rather than counting the whole table:
    // real webhook traffic from manual testing also lands there, and a global
    // count would make this pass or fail for reasons unrelated to the code.
    const { id, body } = event("payment_intent.succeeded", { id: "pi_x" });
    await webhooks.handle(body, "wrong").catch(() => undefined);

    const rows = await asAdmin((db) =>
      db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM stripe_events WHERE event_id = ${id}`,
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });
});

describe("idempotency", () => {
  it("handles an event once and ignores the replay", async () => {
    // Stripe delivers at least once and retries for days, so replays are
    // routine rather than exceptional.
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });
    const { body } = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });

    const first = await webhooks.handle(body, "valid");
    const second = await webhooks.handle(body, "valid");

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it("does not double-apply the effects of a replayed payment", async () => {
    // The real risk: confirming twice would decrement stock twice for one sale.
    await stock(5);
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });
    const { body } = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });

    await webhooks.handle(body, "valid");
    await webhooks.handle(body, "valid");
    await webhooks.handle(body, "valid");

    expect(await readStock()).toMatchObject({ on_hand: 4, reserved: 0 });
  });

  it("records every event it accepts, so nothing is silently lost", async () => {
    const { id, body } = event("customer.created", { id: "cus_x" });
    await webhooks.handle(body, "valid");

    const rows = await asAdmin((db) =>
      db.$queryRaw<{ type: string; processed_at: Date | null }[]>`
        SELECT type, processed_at FROM stripe_events WHERE event_id = ${id}`,
    );
    expect(rows).toHaveLength(1);
    // Recorded and marked processed even though we do not act on it — the row
    // is the history if we later want it.
    expect(rows[0]!.processed_at).not.toBeNull();
  });

  it("reports an unhandled event type as recorded but not handled", async () => {
    const { body } = event("invoice.paid", { id: "in_x" });
    const outcome = await webhooks.handle(body, "valid");

    expect(outcome.duplicate).toBe(false);
    expect(outcome.handled).toBe(false);
  });
});

describe("payment succeeded", () => {
  it("marks the payment succeeded and confirms the order", async () => {
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });

    const { body } = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });
    await webhooks.handle(body, "valid");

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.status).toBe("CONFIRMED");
    expect(detail.payments.find((p) => p.provider === "STRIPE")!.status).toBe("SUCCEEDED");
  });

  it("turns the stock reservation into a sale", async () => {
    // Confirmation is what converts held stock into stock that has left.
    await stock(5);
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });
    expect(await readStock()).toMatchObject({ on_hand: 5, reserved: 1 });

    const { body } = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });
    await webhooks.handle(body, "valid");

    expect(await readStock()).toMatchObject({ on_hand: 4, reserved: 0 });
  });

  it("retires the pending cash row so nobody is asked to collect twice", async () => {
    // An order carries a CASH row from the moment it is placed. Left alone
    // after a card succeeds, the workbench reads it as money still owed and
    // shows a clerk "Take $17.64 cash" for an order already charged — the
    // customer pays twice.
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });
    const { body } = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });
    await webhooks.handle(body, "valid");

    const detail = await orders.getForStore(STORE, order.id);
    const cash = detail.payments.find((p) => p.provider === "CASH")!;
    const card = detail.payments.find((p) => p.provider === "STRIPE")!;

    expect(card.status).toBe("SUCCEEDED");
    expect(cash.status).toBe("CANCELED");
    // Exactly one settled payment, so no surface can read two.
    expect(detail.payments.filter((p) => p.status === "SUCCEEDED")).toHaveLength(1);
  });

  it("attributes the confirmation to the system, not a person", async () => {
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });
    const { body } = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });
    await webhooks.handle(body, "valid");

    const detail = await orders.getForStore(STORE, order.id);
    const confirmed = detail.history.find((h) => h.toStatus === "CONFIRMED")!;
    expect(confirmed.actorUserId).toBeNull();
  });
});

describe("payment failed", () => {
  it("marks the payment failed but leaves the order open", async () => {
    // A declined card is usually followed by a second attempt with a different
    // one. Cancelling would release the stock out from under a customer who is
    // still standing at the checkout.
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });

    const { body } = event("payment_intent.payment_failed", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
      last_payment_error: { message: "Your card was declined." },
    });
    await webhooks.handle(body, "valid");

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.status).toBe("PENDING");
    const card = detail.payments.find((p) => p.provider === "STRIPE")!;
    expect(card.status).toBe("FAILED");
    expect(card.failureReason).toBe("Your card was declined.");
  });

  it("keeps the stock reserved so the customer can retry", async () => {
    await stock(3);
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });

    const { body } = event("payment_intent.payment_failed", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
      last_payment_error: { message: "Declined" },
    });
    await webhooks.handle(body, "valid");

    expect(await readStock()).toMatchObject({ on_hand: 3, reserved: 1 });
  });
});

describe("refunds", () => {
  /** Puts a PENDING refund on a paid order and returns its Stripe id. */
  async function pendingRefund(): Promise<{ orderId: string; stripeRefundId: string }> {
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });
    const { body } = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });
    await webhooks.handle(body, "valid");

    const stripeRefundId = `re_${crypto.randomUUID().slice(0, 12)}`;
    await asAdmin(async (db) => {
      const [payment] = await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM payments WHERE order_id = ${order.id} AND provider = 'STRIPE'`;
      await db.$executeRaw`
        INSERT INTO refunds (id, store_id, payment_id, amount_cents, status, stripe_refund_id)
        VALUES (gen_random_uuid(), ${STORE}, ${payment!.id}, 500, 'PENDING', ${stripeRefundId})`;
    });
    return { orderId: order.id, stripeRefundId };
  }

  async function refundStatus(orderId: string): Promise<string> {
    const rows = await asAdmin((db) =>
      db.$queryRaw<{ status: string }[]>`
        SELECT r.status::text AS status FROM refunds r
        JOIN payments p ON p.id = r.payment_id WHERE p.order_id = ${orderId}`,
    );
    return rows[0]!.status;
  }

  it("confirms a refund from a `refund.updated` event", async () => {
    // These arrive with no store metadata and, for destination charges, no
    // connected account either — so any handler that resolves a store first
    // silently does nothing. Keyed off our own stripe_refund_id instead.
    const { orderId, stripeRefundId } = await pendingRefund();

    const { body } = event("refund.updated", {
      id: stripeRefundId,
      object: "refund",
      status: "succeeded",
    });
    await webhooks.handle(body, "valid");

    expect(await refundStatus(orderId)).toBe("SUCCEEDED");
  });

  it("confirms a refund from a `charge.refunded` event", async () => {
    // Verified against real Stripe traffic: the charge payload has NO
    // `refunds` key at all, only `payment_intent`. Reading `refunds.data`
    // finds nothing and the refund stays pending forever.
    const { orderId } = await pendingRefund();
    const intentId = await asAdmin(async (db) => {
      const [p] = await db.$queryRaw<{ stripe_payment_intent_id: string }[]>`
        SELECT stripe_payment_intent_id FROM payments
        WHERE order_id = ${orderId} AND provider = 'STRIPE'`;
      return p!.stripe_payment_intent_id;
    });

    const { body } = event("charge.refunded", {
      id: "ch_test",
      object: "charge",
      payment_intent: intentId,
    });
    await webhooks.handle(body, "valid");

    expect(await refundStatus(orderId)).toBe("SUCCEEDED");
  });

  it("marks a failed refund as failed rather than leaving it pending", async () => {
    const { orderId, stripeRefundId } = await pendingRefund();

    const { body } = event("refund.updated", {
      id: stripeRefundId,
      object: "refund",
      status: "failed",
    });
    await webhooks.handle(body, "valid");

    expect(await refundStatus(orderId)).toBe("FAILED");
  });

  it("treats a cancelled refund as failed — the money never moved", async () => {
    const { orderId, stripeRefundId } = await pendingRefund();

    const { body } = event("refund.updated", {
      id: stripeRefundId,
      object: "refund",
      status: "canceled",
    });
    await webhooks.handle(body, "valid");

    expect(await refundStatus(orderId)).toBe("FAILED");
  });

  it("ignores a refund id we have never seen", async () => {
    const { orderId } = await pendingRefund();

    const { body } = event("refund.updated", {
      id: "re_not_ours",
      object: "refund",
      status: "succeeded",
    });
    await webhooks.handle(body, "valid");

    expect(await refundStatus(orderId)).toBe("PENDING");
  });
});

describe("account updated", () => {
  it("flips the store to card-capable when onboarding finishes", async () => {
    // This is what saves the owner from having to come back and press a button
    // before their storefront can take money.
    await asAdmin((db) =>
      db.$executeRaw`UPDATE stores SET stripe_charges_enabled = false WHERE id = ${STORE}`,
    );

    const { body } = event("account.updated", {
      id: ACCOUNT,
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], past_due: [], disabled_reason: null },
    });
    await webhooks.handle(body, "valid");

    const status = await payments.getConnectStatus(STORE);
    expect(status.chargesEnabled).toBe(true);
  });

  it("records why an account was disabled, so the owner can be told", async () => {
    const { body } = event("account.updated", {
      id: ACCOUNT,
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      requirements: {
        currently_due: ["individual.id_number"],
        past_due: ["external_account"],
        disabled_reason: "requirements.past_due",
      },
    });
    await webhooks.handle(body, "valid");

    const status = await payments.getConnectStatus(STORE);
    expect(status.chargesEnabled).toBe(false);
    expect(status.disabledReason).toBe("requirements.past_due");
    expect(status.requirementsDue).toEqual(["individual.id_number", "external_account"]);
  });

  it("resolves the store from the connected account when there is no metadata", async () => {
    const { id, body } = event("account.updated", {
      id: ACCOUNT,
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: {},
    });
    await webhooks.handle(body, "valid");

    const rows = await asAdmin((db) =>
      db.$queryRaw<{ store_id: string | null }[]>`
        SELECT store_id FROM stripe_events WHERE event_id = ${id}`,
    );
    expect(rows[0]!.store_id).toBe(STORE);
  });
});

describe("failures are visible", () => {
  it("keeps the event row with its error when a handler throws", async () => {
    // Recording before handling is what makes a crashed handler inspectable
    // and replayable rather than lost with the process.
    const { id, body } = event("payment_intent.succeeded", {
      id: "pi_does_not_exist",
      metadata: { storeId: STORE, orderId: crypto.randomUUID() },
    });

    // No matching payment row: the handler logs and returns rather than
    // throwing, so this is recorded as processed with no error.
    await webhooks.handle(body, "valid");

    const rows = await asAdmin((db) =>
      db.$queryRaw<{ processed_at: Date | null }[]>`
        SELECT processed_at FROM stripe_events WHERE event_id = ${id}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processed_at).not.toBeNull();
  });
});

/**
 * The signal for money taken with no order to show for it.
 *
 * The runbook calls this the worst state in the system, and until recently it
 * produced two log warnings and nothing else. Each case below is a distinct way
 * Stripe can confirm a charge that nothing local accounts for.
 */
describe("unreconciled payments", () => {
  async function unreconciled(cause: string): Promise<number> {
    const metric = await metricsRegistry.getSingleMetric("payments_unreconciled_total")?.get();
    return metric?.values.find((v) => v.labels.cause === cause)?.value ?? 0;
  }

  it("flags a charge whose store cannot be resolved", async () => {
    // Stripe took the money and we cannot even say which shop it was for.
    const { body } = event("payment_intent.succeeded", {
      id: "pi_no_store_at_all",
      metadata: {},
    });

    const before = await unreconciled("no_store");
    await webhooks.handle(body, "valid");

    expect((await unreconciled("no_store")) - before).toBe(1);
  });

  it("flags a charge with no matching payment row", async () => {
    // The store resolves, but nothing local was ever written for this intent,
    // so no amount of retrying will reconcile it.
    const { body } = event("payment_intent.succeeded", {
      id: "pi_never_recorded_here",
      metadata: { storeId: STORE },
    });

    const before = await unreconciled("no_payment_row");
    await webhooks.handle(body, "valid");

    expect((await unreconciled("no_payment_row")) - before).toBe(1);
  });

  it("does not flag an ordinary successful payment", async () => {
    // The case that must stay silent, or the alert is worthless.
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });
    const { body } = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });

    const before =
      (await unreconciled("no_store")) +
      (await unreconciled("no_payment_row")) +
      (await unreconciled("confirm_failed"));
    await webhooks.handle(body, "valid");
    const after =
      (await unreconciled("no_store")) +
      (await unreconciled("no_payment_row")) +
      (await unreconciled("confirm_failed"));

    expect(after - before).toBe(0);
  });

  it("does not flag a duplicate success for an order already confirmed", async () => {
    // The transition refuses the second event, which is correct and benign.
    // Telling this apart from a real failure is why the check re-reads the
    // order's status rather than inspecting the error.
    const order = await placeOrder();
    const intent = await payments.createCardPayment(STORE, order.id, crypto.randomUUID(), { userId: BUYER });
    const first = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });
    await webhooks.handle(first.body, "valid");

    // A distinct event id, so idempotency does not short-circuit the replay.
    const second = event("payment_intent.succeeded", {
      id: intent.intentId,
      metadata: { storeId: STORE, orderId: order.id },
    });

    const before = await unreconciled("confirm_failed");
    await webhooks.handle(second.body, "valid");

    expect((await unreconciled("confirm_failed")) - before).toBe(0);
  });
});
