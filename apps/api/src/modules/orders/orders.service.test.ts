import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { CartService, type Shopper } from "../cart/cart.service.js";
import { CheckoutService } from "../checkout/checkout.service.js";
import { ConfiguredRateTaxProvider } from "../checkout/tax.provider.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { OrdersService } from "./orders.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const OWNER = "cd000000-0000-4000-8000-000000000001";
const BUYER = "cd000000-0000-4000-8000-000000000002";
const OTHER_BUYER = "cd000000-0000-4000-8000-000000000003";
const CLERK = "cd000000-0000-4000-8000-000000000004";
const STORE = "cd000000-0000-4000-8000-00000000000a";

let prisma: PrismaService;
let cart: CartService;
let checkout: CheckoutService;
let orders: OrdersService;
let outbox: OutboxService;
let variantId = "";

beforeAll(() => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  cart = new CartService(prisma);
  outbox = new OutboxService(prisma);
  checkout = new CheckoutService(prisma, new ConfiguredRateTaxProvider(async () => null), outbox);
  orders = new OrdersService(prisma, new AuditService(prisma), outbox);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await seed();
});

async function asAdmin<T>(work: (admin: PrismaService) => Promise<T>): Promise<T> {
  const admin = new PrismaService();
  try {
    return await work(admin);
  } finally {
    await admin.$disconnect();
  }
}

async function seed(): Promise<void> {
  await asAdmin(async (db) => {
    await db.$executeRaw`
      INSERT INTO users (id,email,name,status,created_at,updated_at) VALUES
      (${OWNER},'orders-owner@example.com'::citext,'Owner','ACTIVE',now(),now()),
      (${BUYER},'orders-buyer@example.com'::citext,'Buyer','ACTIVE',now(),now()),
      (${OTHER_BUYER},'orders-other@example.com'::citext,'Other','ACTIVE',now(),now()),
      (${CLERK},'orders-clerk@example.com'::citext,'Clerk','ACTIVE',now(),now())`;

    await db.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,city,state,timezone,
                          currency,branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'orders-test-shop'::citext,'Orders Test Shop','RETAIL','ACTIVE',${OWNER},
              'Chicago','IL','America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;

    const productId = crypto.randomUUID();
    variantId = crypto.randomUUID();
    await db.$executeRaw`
      INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
      VALUES (${productId},${STORE},'Sourdough Loaf','sourdough-loaf','ACTIVE',now(),now())`;
    await db.$executeRaw`
      INSERT INTO product_variants (id,store_id,product_id,price_cents,is_default,active,attrs,created_at,updated_at)
      VALUES (${variantId},${STORE},${productId},800,true,true,'{}'::jsonb,now(),now())`;
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (db) => {
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
    await db.$executeRaw`DELETE FROM users WHERE id IN (${OWNER},${BUYER},${OTHER_BUYER},${CLERK})`;
  });
}

const buyer: Shopper = { kind: "user", userId: BUYER };
const clerk = { userId: CLERK, role: "CLERK" as const };

async function placeOrder(shopper: Shopper = buyer, qty = 1) {
  await cart.addItem(STORE, shopper, variantId, qty);
  return checkout.placeOrder(STORE, shopper, {
    fulfillment: "PICKUP",
    idempotencyKey: crypto.randomUUID(),
  });
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

describe("guest checkout", () => {
  it("lets a guest place an order without an account", async () => {
    // Requiring sign-in to buy is how a corner shop loses the sale. This is
    // also the path where a missing session key in the checkout transaction
    // silently produced "your cart is empty" — for guests only.
    const guest: Shopper = { kind: "guest", sessionKey: crypto.randomUUID() };
    const order = await placeOrder(guest);

    expect(order.orderNumber).toBeTruthy();
    expect(order.guestToken).toBeTruthy();
  });

  it("lets the guest read that order back with their claim token", async () => {
    const guest: Shopper = { kind: "guest", sessionKey: crypto.randomUUID() };
    const order = await placeOrder(guest);

    const fetched = await orders.getForCustomer(order.id, { guestToken: order.guestToken! });
    expect(fetched.orderNumber).toBe(order.orderNumber);
  });

  it("hides the order from someone holding the wrong token", async () => {
    const guest: Shopper = { kind: "guest", sessionKey: crypto.randomUUID() };
    const order = await placeOrder(guest);

    await expect(
      orders.getForCustomer(order.id, { guestToken: "not-the-right-token" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("hides the order from a signed-in stranger", async () => {
    const guest: Shopper = { kind: "guest", sessionKey: crypto.randomUUID() };
    const order = await placeOrder(guest);

    await expect(
      orders.getForCustomer(order.id, { userId: OTHER_BUYER }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("customer access", () => {
  it("shows a customer their own order", async () => {
    const order = await placeOrder();
    const fetched = await orders.getForCustomer(order.id, { userId: BUYER });
    expect(fetched.id).toBe(order.id);
  });

  it("does not show one customer another's order", async () => {
    const order = await placeOrder();
    await expect(
      orders.getForCustomer(order.id, { userId: OTHER_BUYER }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("lists only the customer's own orders", async () => {
    await placeOrder();
    const mine = await orders.listForCustomer(BUYER);
    const theirs = await orders.listForCustomer(OTHER_BUYER);

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});

describe("status transitions", () => {
  it("moves an order through the happy path", async () => {
    const order = await placeOrder();

    for (const status of ["CONFIRMED", "PREPARING", "READY", "PICKED_UP"] as const) {
      await orders.transition(STORE, order.id, status, clerk);
    }

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.status).toBe("PICKED_UP");
    expect(detail.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      "PENDING", "CONFIRMED", "PREPARING", "READY", "PICKED_UP",
    ]);
  });

  it("refuses to skip states", async () => {
    const order = await placeOrder();
    await expect(
      orders.transition(STORE, order.id, "DELIVERED", clerk),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("stops a delivery driver from cancelling", async () => {
    // The driver may mark an order delivered, but cancelling is a decision
    // about the shop's money, not about the drop-off.
    const order = await placeOrder();
    await orders.transition(STORE, order.id, "CONFIRMED", clerk);

    await expect(
      orders.transition(STORE, order.id, "CANCELLED", { userId: CLERK, role: "DELIVERY" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("treats a repeated transition as a no-op rather than an error", async () => {
    // A clerk tapping "Ready" twice on a busy counter should not see a red
    // error for something that is already true.
    const order = await placeOrder();
    await orders.transition(STORE, order.id, "CONFIRMED", clerk);

    const again = await orders.transition(STORE, order.id, "CONFIRMED", clerk);
    expect(again.unchanged).toBe(true);
  });

  it("records who made the change", async () => {
    const order = await placeOrder();
    await orders.transition(STORE, order.id, "CONFIRMED", clerk, "Called the customer");

    const detail = await orders.getForStore(STORE, order.id);
    const confirmed = detail.history.find((h: { toStatus: string }) => h.toStatus === "CONFIRMED")!;
    expect(confirmed.actorUserId).toBe(CLERK);
    expect(confirmed.note).toBe("Called the customer");
  });
});

describe("stock through the order lifecycle", () => {
  it("turns a reservation into a sale on confirmation", async () => {
    await stock(5);
    const order = await placeOrder(buyer, 2);
    expect(await readStock()).toMatchObject({ on_hand: 5, reserved: 2 });

    await orders.transition(STORE, order.id, "CONFIRMED", clerk);

    // The loaves have left the shelf, and nothing is still held for them.
    expect(await readStock()).toMatchObject({ on_hand: 3, reserved: 0 });
  });

  it("writes a ledger entry for the sale", async () => {
    await stock(5);
    const order = await placeOrder(buyer, 2);
    await orders.transition(STORE, order.id, "CONFIRMED", clerk);

    const movements = await asAdmin((db) =>
      db.$queryRaw<{ type: string; qty_delta: number }[]>`
        SELECT type::text, qty_delta FROM stock_movements
        WHERE variant_id = ${variantId} ORDER BY created_at`,
    );
    expect(movements).toEqual([
      { type: "RECEIVE", qty_delta: 5 },
      { type: "SALE", qty_delta: -2 },
    ]);
  });

  it("releases the hold when a pending order is cancelled", async () => {
    await stock(5);
    const order = await placeOrder(buyer, 2);
    await orders.transition(STORE, order.id, "CANCELLED", clerk);

    // Never sold, so nothing goes back on the shelf — the hold just ends.
    expect(await readStock()).toMatchObject({ on_hand: 5, reserved: 0 });
  });

  it("puts stock back when a confirmed order is cancelled", async () => {
    await stock(5);
    const order = await placeOrder(buyer, 2);
    await orders.transition(STORE, order.id, "CONFIRMED", clerk);
    await orders.transition(STORE, order.id, "CANCELLED", clerk);

    expect(await readStock()).toMatchObject({ on_hand: 5, reserved: 0 });
  });

  it("puts stock back on a return", async () => {
    await stock(5);
    const order = await placeOrder(buyer, 2);
    for (const s of ["CONFIRMED", "PREPARING", "READY", "PICKED_UP", "RETURNED"] as const) {
      await orders.transition(STORE, order.id, s, clerk);
    }

    expect(await readStock()).toMatchObject({ on_hand: 5, reserved: 0 });
  });
});

describe("cash payment", () => {
  it("records collection against the order", async () => {
    const order = await placeOrder();
    const result = await orders.recordCashPayment(STORE, order.id, CLERK);

    expect(result.amountCents).toBe(order.totalCents);

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.payments[0]).toMatchObject({ status: "SUCCEEDED", cashReceivedBy: CLERK });
  });

  it("is safe to tap twice", async () => {
    const order = await placeOrder();
    await orders.recordCashPayment(STORE, order.id, CLERK);
    const second = await orders.recordCashPayment(STORE, order.id, CLERK);

    expect(second.alreadyRecorded).toBe(true);
  });

  it("retires an abandoned card attempt when cash is taken instead", async () => {
    // The mirror case: a customer gives up on the card form and pays at the
    // counter. Leaving the intent live would let it settle later against an
    // order already paid.
    const order = await placeOrder();
    await asAdmin((db) =>
      db.$executeRaw`
        INSERT INTO payments (id, store_id, order_id, provider, stripe_payment_intent_id,
                              amount_cents, application_fee_cents, status)
        VALUES (gen_random_uuid(), ${STORE}, ${order.id}, 'STRIPE', ${"pi_abandoned"},
                ${order.totalCents}, 0, 'REQUIRES_ACTION')`,
    );

    await orders.transition(STORE, order.id, "CONFIRMED", clerk);
    await orders.recordCashPayment(STORE, order.id, CLERK);

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.payments.find((p) => p.provider === "CASH")!.status).toBe("SUCCEEDED");
    expect(detail.payments.find((p) => p.provider === "STRIPE")!.status).toBe("CANCELED");
  });

  it("never records a platform fee", async () => {
    // The no-cut promise, checked where the money actually is.
    const order = await placeOrder();
    await orders.recordCashPayment(STORE, order.id, CLERK);

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.payments[0]!.applicationFeeCents).toBe(0);
  });
});

describe("expiry sweeper", () => {
  it("cancels stale pending orders and frees their stock", async () => {
    // Without this an abandoned checkout holds the last loaf off the shelf
    // indefinitely.
    await stock(3);
    const order = await placeOrder(buyer, 2);
    expect(await readStock()).toMatchObject({ reserved: 2 });

    await asAdmin((db) =>
      db.$executeRaw`UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = ${order.id}`,
    );

    // Asserted on *this* order rather than on the sweeper's total: the sweep is
    // global by design, so any other stale order in the database — from another
    // suite or from manual testing — would change a global count without
    // saying anything about whether this one was handled.
    const expired = await orders.expireStaleOrders();
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await readStock()).toMatchObject({ on_hand: 3, reserved: 0 });

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.status).toBe("CANCELLED");
  });

  it("leaves orders that haven't expired alone", async () => {
    const order = await placeOrder();
    await orders.expireStaleOrders();

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.status).toBe("PENDING");
  });

  it("attributes the cancellation to the system, not a person", async () => {
    const order = await placeOrder();
    await asAdmin((db) =>
      db.$executeRaw`UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = ${order.id}`,
    );
    await orders.expireStaleOrders();

    const detail = await orders.getForStore(STORE, order.id);
    const cancelled = detail.history.find((h: { toStatus: string }) => h.toStatus === "CANCELLED")!;
    expect(cancelled.actorUserId).toBeNull();
  });
});

describe("store isolation", () => {
  it("does not show one store another store's orders", async () => {
    await placeOrder();
    const otherStoreId = crypto.randomUUID();
    const { orders: visible } = await orders.listForStore(otherStoreId);
    expect(visible).toEqual([]);
  });
});
