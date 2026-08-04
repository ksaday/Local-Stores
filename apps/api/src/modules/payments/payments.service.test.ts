import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testNotifications } from "../../modules/notifications/test-notifications.js";
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

const OWNER_A = "cf000000-0000-4000-8000-000000000001";
const OWNER_B = "cf000000-0000-4000-8000-000000000002";
const BUYER = "cf000000-0000-4000-8000-000000000003";
const STAFF = "cf000000-0000-4000-8000-000000000004";
const STORE_A = "cf000000-0000-4000-8000-00000000000a";
const STORE_B = "cf000000-0000-4000-8000-00000000000b";

const ACCOUNT_A = "acct_store_a";
const ACCOUNT_B = "acct_store_b";

let prisma: PrismaService;
let provider: FakePaymentProvider;
let payments: PaymentsService;
let billing: BillingService;
let webhooks: StripeWebhooksService;
let orders: OrdersService;
let cart: CartService;
let checkout: CheckoutService;
let variantA = "";
let variantB = "";

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
      (${OWNER_A},'pay-owner-a@example.com'::citext,'Owner A','ACTIVE',now(),now()),
      (${OWNER_B},'pay-owner-b@example.com'::citext,'Owner B','ACTIVE',now(),now()),
      (${BUYER},'pay-buyer@example.com'::citext,'Buyer','ACTIVE',now(),now()),
      (${STAFF},'pay-staff@example.com'::citext,'Staff','ACTIVE',now(),now())`;

    for (const [id, slug, owner, account] of [
      [STORE_A, "pay-store-a", OWNER_A, ACCOUNT_A],
      [STORE_B, "pay-store-b", OWNER_B, ACCOUNT_B],
    ] as const) {
      await db.$executeRaw`
        INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,city,state,timezone,
                            currency,branding,cash_enabled,stripe_account_id,stripe_charges_enabled,
                            platform_fee_bps,created_at,updated_at)
        VALUES (${id},${slug}::citext,${slug},'RETAIL','ACTIVE',${owner},
                'Chicago','IL','America/Chicago','USD','{}'::jsonb,true,${account},true,0,now(),now())`;

      const productId = crypto.randomUUID();
      const vId = crypto.randomUUID();
      if (id === STORE_A) variantA = vId;
      else variantB = vId;

      await db.$executeRaw`
        INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
        VALUES (${productId},${id},'Loaf','loaf','ACTIVE',now(),now())`;
      await db.$executeRaw`
        INSERT INTO product_variants (id,store_id,product_id,price_cents,is_default,active,attrs,created_at,updated_at)
        VALUES (${vId},${id},${productId},1000,true,true,'{}'::jsonb,now(),now())`;
    }
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (db) => {
    const stores = [STORE_A, STORE_B];
    await db.$executeRaw`DELETE FROM stripe_events WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM stripe_events WHERE store_id IS NULL`;
    await db.$executeRaw`DELETE FROM refunds WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM audit_logs WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM payments WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM order_status_history WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM order_items WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM orders WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM cart_items WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM carts WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM store_counters WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM stock_movements WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM stock_levels WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM product_variants WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM products WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM outbox_events WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM stores WHERE id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM users WHERE id IN (${OWNER_A},${OWNER_B},${BUYER},${STAFF})`;
  });
}

const buyer: Shopper = { kind: "user", userId: BUYER };

/** Places an order and returns it. */
async function placeOrder(storeId = STORE_A, variantId = variantA) {
  await cart.addItem(storeId, buyer, variantId, 1);
  return checkout.placeOrder(storeId, buyer, {
    fulfillment: "PICKUP",
    idempotencyKey: crypto.randomUUID(),
  });
}

/** Takes an order all the way to paid, the way a real card payment would. */
async function payFor(orderId: string, storeId = STORE_A) {
  const intent = await payments.createCardPayment(storeId, orderId, crypto.randomUUID(), { userId: BUYER });
  await webhooks.handle(
    Buffer.from(
      JSON.stringify({
        id: `evt_${crypto.randomUUID()}`,
        type: "payment_intent.succeeded",
        data: { object: { id: intent.intentId, metadata: { storeId, orderId } } },
      }),
    ),
    "valid",
  );
  return intent;
}

describe("connect onboarding", () => {
  it("returns a link the owner completes at the provider", async () => {
    await asAdmin((db) =>
      db.$executeRaw`UPDATE stores SET stripe_account_id = NULL WHERE id = ${STORE_A}`,
    );

    const result = await payments.startOnboarding(STORE_A, OWNER_A, "http://localhost:3100");
    expect(result.url).toContain("connect.stripe.test");
  });

  it("reuses the existing account when onboarding is resumed", async () => {
    // Abandoning halfway and coming back days later is the normal path.
    // Creating a second account would strand whatever was already submitted.
    await payments.startOnboarding(STORE_A, OWNER_A, "http://localhost:3100");
    await payments.startOnboarding(STORE_A, OWNER_A, "http://localhost:3100");

    expect(provider.onboardingCalls[1]!.existingAccountId).toBe(ACCOUNT_A);
  });

  it("reports a fresh account as unable to take money", async () => {
    await asAdmin((db) =>
      db.$executeRaw`UPDATE stores SET stripe_account_id = NULL, stripe_charges_enabled = false WHERE id = ${STORE_A}`,
    );
    await payments.startOnboarding(STORE_A, OWNER_A, "http://localhost:3100");

    const status = await payments.syncConnectStatus(STORE_A);
    expect(status.chargesEnabled).toBe(false);
    // The owner needs to know *what* is outstanding, not just that something is.
    expect(status.requirementsDue.length).toBeGreaterThan(0);
  });

  it("flips the store to card-capable once onboarding completes", async () => {
    provider.completeOnboarding(ACCOUNT_A);
    const status = await payments.syncConnectStatus(STORE_A);

    expect(status.chargesEnabled).toBe(true);
    expect(status.requirementsDue).toEqual([]);
  });
});

describe("taking a card payment", () => {
  it("creates an intent for the order total", async () => {
    const order = await placeOrder();
    const result = await payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), { userId: BUYER });

    expect(result.amountCents).toBe(order.totalCents);
    expect(result.clientSecret).toBeTruthy();
  });

  it("charges the order's amount, never one supplied by the caller", async () => {
    // A client that can name its own amount can pay a penny for a full basket.
    const order = await placeOrder();
    await payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), { userId: BUYER });

    expect(provider.intentCalls[0]!.amountCents).toBe(order.totalCents);
  });

  it("sends the money to that store's own connected account", async () => {
    const order = await placeOrder();
    await payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), { userId: BUYER });

    expect(provider.intentCalls[0]!.destinationAccountId).toBe(ACCOUNT_A);
  });

  it("refuses when the store hasn't finished Stripe onboarding", async () => {
    await asAdmin((db) =>
      db.$executeRaw`UPDATE stores SET stripe_charges_enabled = false WHERE id = ${STORE_A}`,
    );
    const order = await placeOrder();

    await expect(
      payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), { userId: BUYER }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to charge an order that is already paid", async () => {
    const order = await placeOrder();
    await payFor(order.id);

    await expect(
      payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), { userId: BUYER }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("records the payment as awaiting the customer, not as succeeded", async () => {
    // Nothing has been paid until the webhook says so.
    const order = await placeOrder();
    await payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), { userId: BUYER });

    const detail = await orders.getForStore(STORE_A, order.id);
    const card = detail.payments.find((p) => p.provider === "STRIPE")!;
    expect(card.status).toBe("REQUIRES_ACTION");
    expect(detail.status).toBe("PENDING");
  });

  it("never records a platform fee", async () => {
    const order = await placeOrder();
    await payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), { userId: BUYER });

    const detail = await orders.getForStore(STORE_A, order.id);
    expect(detail.payments.every((p) => p.applicationFeeCents === 0)).toBe(true);
  });
});

describe("who may pay for an order", () => {
  it("lets the customer who placed it pay", async () => {
    const order = await placeOrder();
    const result = await payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), {
      userId: BUYER,
    });
    expect(result.clientSecret).toBeTruthy();
  });

  it("refuses a stranger who guessed the order id", async () => {
    // The endpoint is public so guests can pay, and it runs with store scope
    // to write the payment row. Without an entitlement check first, guessing
    // an order id would hand out a client secret for someone else's order.
    const order = await placeOrder();

    await expect(
      payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), { userId: OWNER_B }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a caller presenting no identity at all", async () => {
    const order = await placeOrder();

    await expect(
      payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), {}),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("lets a guest pay with the claim token from their receipt", async () => {
    const guest: Shopper = { kind: "guest", sessionKey: crypto.randomUUID() };
    await cart.addItem(STORE_A, guest, variantA, 1);
    const order = await checkout.placeOrder(STORE_A, guest, {
      fulfillment: "PICKUP",
      idempotencyKey: crypto.randomUUID(),
    });

    const result = await payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), {
      guestToken: order.guestToken!,
    });
    expect(result.clientSecret).toBeTruthy();
  });

  it("refuses a guest presenting the wrong token", async () => {
    const guest: Shopper = { kind: "guest", sessionKey: crypto.randomUUID() };
    await cart.addItem(STORE_A, guest, variantA, 1);
    const order = await checkout.placeOrder(STORE_A, guest, {
      fulfillment: "PICKUP",
      idempotencyKey: crypto.randomUUID(),
    });

    await expect(
      payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), {
        guestToken: "not-the-right-token",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("lets staff take payment without an order-owner identity", async () => {
    // Over the counter, the person paying is standing there and the clerk is
    // the one operating the till.
    const order = await placeOrder();
    const result = await payments.createCardPayment(STORE_A, order.id, crypto.randomUUID(), {
      isStaff: true,
    });
    expect(result.clientSecret).toBeTruthy();
  });
});

describe("connected-account isolation", () => {
  it("refunds store A's payment out of store A's account", async () => {
    // The worst available bug in this system is money moving out of the wrong
    // shop's account, so the destination is asserted explicitly.
    const order = await placeOrder(STORE_A, variantA);
    await payFor(order.id, STORE_A);

    await payments.refund(STORE_A, order.id, STAFF, { amountCents: 500 });

    expect(provider.refundCalls[0]!.accountId).toBe(ACCOUNT_A);
  });

  it("will not refund one store's order through another store's scope", async () => {
    const order = await placeOrder(STORE_A, variantA);
    await payFor(order.id, STORE_A);

    // Store B asking to refund store A's order finds nothing: RLS scopes the
    // payment lookup, so this is a 404 rather than a cross-tenant refund.
    await expect(
      payments.refund(STORE_B, order.id, STAFF, { amountCents: 500 }),
    ).rejects.toMatchObject({ status: 404 });

    expect(provider.refundCalls).toHaveLength(0);
  });

  it("does not let one store see another's refunds", async () => {
    const order = await placeOrder(STORE_A, variantA);
    await payFor(order.id, STORE_A);
    await payments.refund(STORE_A, order.id, STAFF, { amountCents: 200 });

    expect(await payments.listRefunds(STORE_A, order.id)).toHaveLength(1);
    expect(await payments.listRefunds(STORE_B, order.id)).toHaveLength(0);
  });
});

describe("refunds", () => {
  it("records a refund as pending until the provider confirms it", async () => {
    // Marking it succeeded optimistically means a network timeout after Stripe
    // accepted leaves the books claiming the money never went back.
    const order = await placeOrder();
    await payFor(order.id);

    const result = await payments.refund(STORE_A, order.id, STAFF, { amountCents: 300 });
    expect(result.status).toBe("PENDING");
  });

  it("confirms the refund when the webhook arrives", async () => {
    const order = await placeOrder();
    await payFor(order.id);
    await payments.refund(STORE_A, order.id, STAFF, { amountCents: 300 });

    // Read the id we actually stored rather than asking the provider again —
    // a second `refund()` call would mint a different id and prove nothing.
    const stored = await prisma.withTenant({ storeId: STORE_A, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<{ stripe_refund_id: string }[]>`
        SELECT stripe_refund_id FROM refunds WHERE store_id = ${STORE_A}`,
    );

    await webhooks.handle(
      Buffer.from(
        JSON.stringify({
          id: `evt_${crypto.randomUUID()}`,
          type: "refund.updated",
          // `object: "refund"` is what real Stripe payloads carry, and what
          // tells the handler which shape it is looking at.
          data: { object: { id: stored[0]!.stripe_refund_id, object: "refund", status: "succeeded" } },
        }),
      ),
      "valid",
    );

    const refunds = await payments.listRefunds(STORE_A, order.id);
    expect(refunds[0]!.status).toBe("SUCCEEDED");
  });

  it("refuses to refund more than was paid", async () => {
    const order = await placeOrder();
    await payFor(order.id);

    await expect(
      payments.refund(STORE_A, order.id, STAFF, { amountCents: order.totalCents + 1 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a second refund that would exceed the total", async () => {
    // The database trigger is the backstop, and it is what makes two
    // concurrent partial refunds safe.
    const order = await placeOrder();
    await payFor(order.id);

    await payments.refund(STORE_A, order.id, STAFF, { amountCents: order.totalCents });
    await expect(
      payments.refund(STORE_A, order.id, STAFF, { amountCents: 1 }),
    ).rejects.toThrow();
  });

  it("settles a cash refund immediately, with no provider call", async () => {
    // Cash never went through Stripe; the till being opened is the whole
    // transaction.
    const order = await placeOrder();
    await orders.transition(STORE_A, order.id, "CONFIRMED", { userId: STAFF, role: "CLERK" });
    await orders.recordCashPayment(STORE_A, order.id, STAFF);

    const result = await payments.refund(STORE_A, order.id, STAFF, { amountCents: 100 });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.provider).toBe("CASH");
    expect(provider.refundCalls).toHaveLength(0);
  });

  it("refuses to refund an order that was never paid", async () => {
    const order = await placeOrder();
    await expect(
      payments.refund(STORE_A, order.id, STAFF, { amountCents: 100 }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
