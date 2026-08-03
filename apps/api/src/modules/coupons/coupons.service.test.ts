import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { CartService, type Shopper } from "../cart/cart.service.js";
import { CheckoutService } from "../checkout/checkout.service.js";
import { ConfiguredRateTaxProvider } from "../checkout/tax.provider.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { CouponsService, discountFor } from "./coupons.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const OWNER = "d4000000-0000-4000-8000-000000000001";
const BUYER = "d4000000-0000-4000-8000-000000000002";
const OTHER_BUYER = "d4000000-0000-4000-8000-000000000003";
const STORE = "d4000000-0000-4000-8000-00000000000a";

let prisma: PrismaService;
let coupons: CouponsService;
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
  const audit = new AuditService(prisma);
  const outbox = new OutboxService(prisma);
  coupons = new CouponsService(prisma, audit);
  cart = new CartService(prisma);
  checkout = new CheckoutService(
    prisma,
    new ConfiguredRateTaxProvider(async () => null),
    outbox,
    coupons,
  );
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
      (${OWNER},'coupon-owner@example.com'::citext,'Owner','ACTIVE',now(),now()),
      (${BUYER},'coupon-buyer@example.com'::citext,'Buyer','ACTIVE',now(),now()),
      (${OTHER_BUYER},'coupon-other@example.com'::citext,'Other','ACTIVE',now(),now())`;
    await db.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,city,state,timezone,
                          currency,branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'coupon-store'::citext,'Coupon Store','RETAIL','ACTIVE',${OWNER},
              'Chicago','IL','America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;

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
    await db.$executeRaw`DELETE FROM coupon_redemptions WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM outbox_events WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM payments WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM order_status_history WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM order_items WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM orders WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM coupons WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM cart_items WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM carts WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM store_counters WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await db.$executeRaw`DELETE FROM users WHERE id IN (${OWNER},${BUYER},${OTHER_BUYER})`;
  });
}

const buyer: Shopper = { kind: "user", userId: BUYER };

async function placeOrderWith(code: string | null, shopper: Shopper = buyer, qty = 1) {
  await cart.addItem(STORE, shopper, variantId, qty);
  return checkout.placeOrder(STORE, shopper, {
    fulfillment: "PICKUP",
    idempotencyKey: crypto.randomUUID(),
    ...(code ? { couponCode: code } : {}),
  });
}

describe("what a discount is worth", () => {
  it("takes a percentage of the subtotal", () => {
    expect(discountFor("PERCENT", 1000, 5000)).toBe(500);
  });

  it("takes a fixed amount in cents", () => {
    expect(discountFor("FIXED", 500, 5000)).toBe(500);
  });

  it("never exceeds the basket", () => {
    // A $10 coupon on a $6 basket takes it to zero, never below. A negative
    // total would be the shop paying the customer — and since delivery and tax
    // are added afterwards, an uncapped discount could make those free too.
    expect(discountFor("FIXED", 1000, 600)).toBe(600);
  });

  it("rounds a percentage to whole cents", () => {
    // 3.33% of $10.01
    expect(discountFor("PERCENT", 333, 1001)).toBe(33);
  });
});

describe("creating coupons", () => {
  it("normalises the code to upper case", async () => {
    // Shoppers type these off a flyer, from memory.
    const coupon = await coupons.create(STORE, OWNER, { code: " spring24 ", kind: "PERCENT", value: 1000 });
    expect(coupon.code).toBe("SPRING24");
  });

  it("refuses a duplicate code in the same store", async () => {
    await coupons.create(STORE, OWNER, { code: "SAVE10", kind: "FIXED", value: 1000 });
    await expect(
      coupons.create(STORE, OWNER, { code: "save10", kind: "FIXED", value: 500 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a percentage over 100", async () => {
    // The kind of typo an owner makes at 6am, and it would pay customers to shop.
    await expect(
      coupons.create(STORE, OWNER, { code: "OOPS", kind: "PERCENT", value: 15_000 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a zero or negative discount", async () => {
    await expect(
      coupons.create(STORE, OWNER, { code: "ZERO", kind: "FIXED", value: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("lets a deleted code be reissued", async () => {
    // The unique index is partial precisely so a seasonal code can come back.
    const first = await coupons.create(STORE, OWNER, { code: "XMAS", kind: "FIXED", value: 500 });
    await coupons.remove(STORE, first.id, OWNER);

    const second = await coupons.create(STORE, OWNER, { code: "XMAS", kind: "FIXED", value: 700 });
    expect(second.id).not.toBe(first.id);
  });

  it("reports why customers cannot use a code", async () => {
    await coupons.create(STORE, OWNER, {
      code: "PAST", kind: "FIXED", value: 500,
      endsAt: new Date(Date.now() - 86_400_000),
    });
    await coupons.create(STORE, OWNER, { code: "OFF", kind: "FIXED", value: 500, active: false });

    const list = await coupons.list(STORE);
    expect(list.find((c) => c.code === "PAST")!.status).toBe("expired");
    expect(list.find((c) => c.code === "OFF")!.status).toBe("off");
  });
});

describe("validating a code at checkout", () => {
  it("prices a valid percentage code", async () => {
    await coupons.create(STORE, OWNER, { code: "TEN", kind: "PERCENT", value: 1000 });
    const { quote, problem } = await coupons.quote(STORE, "TEN", 5000, BUYER);

    expect(problem).toBeNull();
    expect(quote!.discountCents).toBe(500);
  });

  it("matches the code case-insensitively", async () => {
    await coupons.create(STORE, OWNER, { code: "SUMMER", kind: "FIXED", value: 300 });
    const { quote } = await coupons.quote(STORE, "summer", 5000, BUYER);
    expect(quote).not.toBeNull();
  });

  it("says how much more to spend when under the minimum", async () => {
    // The useful form is the shortfall, not the threshold — they can already
    // see their own total.
    await coupons.create(STORE, OWNER, {
      code: "BIG", kind: "FIXED", value: 1000, minOrderCents: 5000,
    });
    const { problem } = await coupons.quote(STORE, "BIG", 3000, BUYER);

    expect(problem).toMatchObject({ kind: "min_order", shortfallCents: 2000 });
    expect(problem!.message).toContain("$20.00");
  });

  it("rejects an expired code", async () => {
    await coupons.create(STORE, OWNER, {
      code: "OLD", kind: "FIXED", value: 500, endsAt: new Date(Date.now() - 1000),
    });
    expect((await coupons.quote(STORE, "OLD", 5000, BUYER)).problem).toMatchObject({ kind: "expired" });
  });

  it("rejects a code that has not started", async () => {
    await coupons.create(STORE, OWNER, {
      code: "SOON", kind: "FIXED", value: 500, startsAt: new Date(Date.now() + 86_400_000),
    });
    expect((await coupons.quote(STORE, "SOON", 5000, BUYER)).problem).toMatchObject({
      kind: "not_started",
    });
  });

  it("reports a switched-off code as simply unknown", async () => {
    // Saying "that code exists but is disabled" invites a shopper to ring the
    // shop about a promotion the owner deliberately ended.
    await coupons.create(STORE, OWNER, { code: "PAUSED", kind: "FIXED", value: 500, active: false });
    expect((await coupons.quote(STORE, "PAUSED", 5000, BUYER)).problem).toMatchObject({
      kind: "unknown",
    });
  });

  it("rejects a code from another store", async () => {
    await coupons.create(STORE, OWNER, { code: "MINE", kind: "FIXED", value: 500 });
    const { problem } = await coupons.quote(crypto.randomUUID(), "MINE", 5000, BUYER);
    expect(problem).toMatchObject({ kind: "unknown" });
  });
});

describe("using a coupon on an order", () => {
  it("applies the discount to the order total", async () => {
    await coupons.create(STORE, OWNER, { code: "SAVE3", kind: "FIXED", value: 300 });
    const order = await placeOrderWith("SAVE3");

    // 1000 subtotal - 300 discount, no tax configured.
    expect(order.totalCents).toBe(700);
  });

  it("records the redemption against the order", async () => {
    await coupons.create(STORE, OWNER, { code: "SAVE3", kind: "FIXED", value: 300 });
    const order = await placeOrderWith("SAVE3");

    const rows = await asAdmin((db) =>
      db.$queryRaw<{ amount_cents: number; order_id: string }[]>`
        SELECT amount_cents, order_id FROM coupon_redemptions WHERE store_id = ${STORE}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount_cents: 300, order_id: order.id });
  });

  it("snapshots the code on the order", async () => {
    // A receipt should still say which code was used after the coupon itself
    // is deleted.
    await coupons.create(STORE, OWNER, { code: "SAVE3", kind: "FIXED", value: 300 });
    const order = await placeOrderWith("SAVE3");

    const rows = await asAdmin((db) =>
      db.$queryRaw<{ coupon_code: string }[]>`
        SELECT coupon_code FROM orders WHERE id = ${order.id}`,
    );
    expect(rows[0]!.coupon_code).toBe("SAVE3");
  });

  it("refuses the order rather than silently charging full price", async () => {
    // Dropping an invalid coupon and charging more than the shopper agreed to,
    // without saying why, is worse than failing.
    await coupons.create(STORE, OWNER, {
      code: "GONE", kind: "FIXED", value: 500, endsAt: new Date(Date.now() - 1000),
    });
    await expect(placeOrderWith("GONE")).rejects.toMatchObject({ status: 400 });
  });

  it("enforces the total redemption limit", async () => {
    await coupons.create(STORE, OWNER, { code: "ONCE", kind: "FIXED", value: 200, maxRedemptions: 1 });
    await placeOrderWith("ONCE");

    await expect(placeOrderWith("ONCE", { kind: "user", userId: OTHER_BUYER })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("enforces the per-customer limit without blocking other customers", async () => {
    await coupons.create(STORE, OWNER, {
      code: "PERSON", kind: "FIXED", value: 200, perCustomerLimit: 1,
    });
    await placeOrderWith("PERSON", buyer);

    await expect(placeOrderWith("PERSON", buyer)).rejects.toMatchObject({ status: 400 });

    // Someone else is unaffected.
    const other = await placeOrderWith("PERSON", { kind: "user", userId: OTHER_BUYER });
    expect(other.totalCents).toBe(800);
  });

  it("does not let two simultaneous checkouts exceed a one-use limit", async () => {
    // The unique index on (coupon, order) plus the in-transaction re-check is
    // what makes the usage count trustworthy under concurrency.
    await coupons.create(STORE, OWNER, { code: "RACE", kind: "FIXED", value: 200, maxRedemptions: 1 });

    const a: Shopper = { kind: "guest", sessionKey: "coupon-race-a" };
    const b: Shopper = { kind: "guest", sessionKey: "coupon-race-b" };
    await cart.addItem(STORE, a, variantId, 1);
    await cart.addItem(STORE, b, variantId, 1);

    const results = await Promise.allSettled([
      checkout.placeOrder(STORE, a, { fulfillment: "PICKUP", idempotencyKey: crypto.randomUUID(), couponCode: "RACE" }),
      checkout.placeOrder(STORE, b, { fulfillment: "PICKUP", idempotencyKey: crypto.randomUUID(), couponCode: "RACE" }),
    ]);

    const redeemed = await asAdmin((db) =>
      db.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM coupon_redemptions WHERE store_id = ${STORE}`,
    );
    expect(Number(redeemed[0]!.count)).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("places the order normally when no code is given", async () => {
    const order = await placeOrderWith(null);
    expect(order.totalCents).toBe(1000);
  });
});
