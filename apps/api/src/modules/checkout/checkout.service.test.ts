import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testNotifications } from "../../modules/notifications/test-notifications.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { CartService, type Shopper } from "../cart/cart.service.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { OrdersService } from "../orders/orders.service.js";
import { CheckoutService } from "./checkout.service.js";
import { ConfiguredRateTaxProvider } from "./tax.provider.js";
import { CouponsService } from "../coupons/coupons.service.js";

/**
 * Runs as `bba_app`, the RLS-restricted role. Checkout crosses more policy
 * families than anything else in the codebase — customer-owned carts,
 * store-owned stock, dual-owned orders — so running it as a superuser would
 * prove nothing about whether it works in production.
 */
const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const OWNER = "cc000000-0000-4000-8000-000000000001";
const BUYER = "cc000000-0000-4000-8000-000000000002";
const STORE = "cc000000-0000-4000-8000-00000000000a";

let prisma: PrismaService;
let cart: CartService;
let checkout: CheckoutService;
let orders: OrdersService;

/** 10.25% — Chicago's combined rate, which is the launch market. */
const TAX_BPS = 1025;

beforeAll(() => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  cart = new CartService(prisma);
  const outbox = new OutboxService(prisma);
  checkout = new CheckoutService(
    prisma,
    new ConfiguredRateTaxProvider(async () => ({ rateBps: TAX_BPS, name: "IL sales tax" })),
    outbox,
    new CouponsService(prisma, new AuditService(prisma)),
  );
  orders = new OrdersService(prisma, new AuditService(prisma), outbox, testNotifications(prisma).notifications);
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

let variantId = "";
let secondVariantId = "";

async function seed(): Promise<void> {
  await asAdmin(async (db) => {
    await db.$executeRaw`
      INSERT INTO users (id,email,name,status,created_at,updated_at) VALUES
      (${OWNER},'checkout-owner@example.com'::citext,'Owner','ACTIVE',now(),now()),
      (${BUYER},'checkout-buyer@example.com'::citext,'Buyer','ACTIVE',now(),now())`;

    await db.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,city,state,postal_code,
                          timezone,currency,branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'checkout-test-shop'::citext,'Checkout Test Shop','RETAIL','ACTIVE',${OWNER},
              'Chicago','IL','60626','America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;

    await db.$executeRaw`
      INSERT INTO tax_rates (id,store_id,name,rate_bps,is_default,active,created_at)
      VALUES (gen_random_uuid(),${STORE},'IL sales tax',${TAX_BPS},true,true,now())`;

    for (const [name, slug, price, ref] of [
      ["Sourdough Loaf", "sourdough-loaf", 800, "first"],
      ["Rye Bread", "rye-bread", 650, "second"],
    ] as const) {
      const productId = crypto.randomUUID();
      const vId = crypto.randomUUID();
      if (ref === "first") variantId = vId;
      else secondVariantId = vId;

      await db.$executeRaw`
        INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
        VALUES (${productId},${STORE},${name},${slug},'ACTIVE',now(),now())`;
      await db.$executeRaw`
        INSERT INTO product_variants (id,store_id,product_id,price_cents,is_default,active,attrs,created_at,updated_at)
        VALUES (${vId},${STORE},${productId},${price},true,true,'{}'::jsonb,now(),now())`;
    }
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
    await db.$executeRaw`DELETE FROM delivery_zones WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM tax_rates WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM outbox_events WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await db.$executeRaw`DELETE FROM users WHERE id IN (${OWNER}, ${BUYER})`;
  });
}

/**
 * Puts `qty` on the shelf and turns tracking on.
 *
 * A qty of 0 creates the tracked level directly rather than through the
 * ledger, because a zero-delta movement is not a real event and the CHECK
 * constraint rightly refuses it.
 */
async function stock(vId: string, qty: number): Promise<void> {
  await asAdmin(async (db) => {
    if (qty > 0) {
      await db.$executeRaw`
        INSERT INTO stock_movements (id,store_id,variant_id,type,qty_delta)
        VALUES (gen_random_uuid(),${STORE},${vId},'RECEIVE',${qty})`;
      await db.$executeRaw`UPDATE stock_levels SET tracked = true WHERE variant_id = ${vId}`;
    } else {
      await db.$executeRaw`
        INSERT INTO stock_levels (variant_id,store_id,on_hand,reserved,tracked,updated_at)
        VALUES (${vId},${STORE},0,0,true,now())
        ON CONFLICT (variant_id) DO UPDATE SET tracked = true`;
    }
  });
}

async function readStock(vId: string) {
  return asAdmin(async (db) => {
    const [row] = await db.$queryRaw<{ on_hand: number; reserved: number }[]>`
      SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${vId}`;
    return row ?? { on_hand: 0, reserved: 0 };
  });
}

const buyer: Shopper = { kind: "user", userId: BUYER };

function place(overrides: Partial<Parameters<CheckoutService["placeOrder"]>[2]> = {}) {
  return checkout.placeOrder(STORE, buyer, {
    fulfillment: "PICKUP",
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  });
}

describe("quote", () => {
  it("prices a pickup order with tax", async () => {
    await cart.addItem(STORE, buyer, variantId, 2);

    const quote = await checkout.quote(STORE, buyer, { fulfillment: "PICKUP" });

    expect(quote.subtotalCents).toBe(1600);
    // 1600 * 10.25% = 164
    expect(quote.taxCents).toBe(164);
    expect(quote.totalCents).toBe(1764);
    expect(quote.deliveryFeeCents).toBe(0);
  });

  it("refuses to quote an empty cart", async () => {
    await expect(checkout.quote(STORE, buyer, { fulfillment: "PICKUP" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("adds a tip without taxing it", async () => {
    // Tips are not a taxable sale — taxing a gratuity would be both wrong and
    // the kind of error a shop owner gets a letter about.
    await cart.addItem(STORE, buyer, variantId, 1);

    const quote = await checkout.quote(STORE, buyer, { fulfillment: "PICKUP", tipCents: 200 });

    expect(quote.taxCents).toBe(82);
    expect(quote.totalCents).toBe(800 + 82 + 200);
  });

  it("rejects an absurd tip rather than charging it", async () => {
    await cart.addItem(STORE, buyer, variantId, 1);
    await expect(
      checkout.quote(STORE, buyer, { fulfillment: "PICKUP", tipCents: 5_000_000 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("re-prices from the live catalog, not from what the cart stored", async () => {
    await cart.addItem(STORE, buyer, variantId, 1);
    await asAdmin((db) =>
      db.$executeRaw`UPDATE product_variants SET price_cents = 900 WHERE id = ${variantId}`,
    );

    const quote = await checkout.quote(STORE, buyer, { fulfillment: "PICKUP" });
    expect(quote.subtotalCents).toBe(900);
  });
});

describe("delivery", () => {
  async function addZone(feeCents: number, minOrderCents = 0, radiusMeters = 5000) {
    await asAdmin((db) =>
      db.$executeRaw`
        INSERT INTO delivery_zones (id,store_id,name,center_lat,center_lng,radius_meters,fee_cents,
                                    min_order_cents,eta_minutes,active,created_at,updated_at)
        VALUES (gen_random_uuid(),${STORE},'Zone',42.0,-87.66,${radiusMeters},${feeCents},
                ${minOrderCents},30,true,now(),now())`,
    );
  }

  const nearby = { line1: "1 Main St", city: "Chicago", state: "IL", postalCode: "60626", lat: 42.001, lng: -87.661 };
  const faraway = { line1: "1 Far St", city: "Rockford", state: "IL", postalCode: "61101", lat: 42.27, lng: -89.09 };

  it("charges the zone fee and taxes it", async () => {
    await addZone(500);
    await cart.addItem(STORE, buyer, variantId, 1);

    const quote = await checkout.quote(STORE, buyer, { fulfillment: "DELIVERY", address: nearby });

    expect(quote.deliveryFeeCents).toBe(500);
    // Tax covers goods and the delivery fee: 800 + 500 at 10.25%.
    expect(quote.taxCents).toBe(82 + 51);
    expect(quote.totalCents).toBe(800 + 500 + 133);
  });

  it("says so when an address is outside every zone", async () => {
    await addZone(500);
    await cart.addItem(STORE, buyer, variantId, 1);

    const quote = await checkout.quote(STORE, buyer, { fulfillment: "DELIVERY", address: faraway });
    expect(quote.deliveryProblem).toMatch(/outside/i);
  });

  it("refuses to place an undeliverable order", async () => {
    // The quote is allowed to describe the problem; placing must not succeed
    // with a zero fee and an address nobody will drive to.
    await addZone(500);
    await cart.addItem(STORE, buyer, variantId, 1);

    await expect(place({ fulfillment: "DELIVERY", address: faraway })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("explains a shortfall against the zone minimum", async () => {
    await addZone(500, 5000);
    await cart.addItem(STORE, buyer, variantId, 1);

    const quote = await checkout.quote(STORE, buyer, { fulfillment: "DELIVERY", address: nearby });
    expect(quote.deliveryProblem).toMatch(/minimum order of \$50\.00/);
  });

  it("picks the cheapest covering zone when they overlap", async () => {
    await addZone(900);
    await addZone(400);
    await cart.addItem(STORE, buyer, variantId, 1);

    const quote = await checkout.quote(STORE, buyer, { fulfillment: "DELIVERY", address: nearby });
    expect(quote.deliveryFeeCents).toBe(400);
  });

  it("does not guess a fee for an address it cannot locate", async () => {
    await addZone(500);
    await cart.addItem(STORE, buyer, variantId, 1);

    const quote = await checkout.quote(STORE, buyer, {
      fulfillment: "DELIVERY",
      address: { ...nearby, lat: null, lng: null },
    });
    expect(quote.deliveryProblem).toMatch(/couldn't locate/i);
  });
});

describe("placing an order", () => {
  it("creates the order, items, history and payment", async () => {
    await cart.addItem(STORE, buyer, variantId, 2);
    const order = await place();

    expect(order.orderNumber).toMatch(/^CHE-\d+$/);
    expect(order.totalCents).toBe(1764);

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]!.qty).toBe(2);
    expect(detail.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(["PENDING"]);
    expect(detail.payments[0]).toMatchObject({ provider: "CASH", amountCents: 1764 });
  });

  it("snapshots the product name so the receipt survives a rename", async () => {
    await cart.addItem(STORE, buyer, variantId, 1);
    const order = await place();

    await asAdmin((db) =>
      db.$executeRaw`UPDATE products SET name = 'Renamed Entirely' WHERE store_id = ${STORE}`,
    );

    const detail = await orders.getForStore(STORE, order.id);
    expect(detail.items[0]!.productName).toBe("Sourdough Loaf");
  });

  it("numbers orders sequentially per store", async () => {
    await cart.addItem(STORE, buyer, variantId, 1);
    const first = await place();
    await cart.addItem(STORE, buyer, variantId, 1);
    const second = await place();

    const firstNo = Number(first.orderNumber.split("-")[1]);
    const secondNo = Number(second.orderNumber.split("-")[1]);
    expect(secondNo).toBe(firstNo + 1);
  });

  it("empties the cart by converting it", async () => {
    await cart.addItem(STORE, buyer, variantId, 1);
    await place();

    const after = await cart.getCart(STORE, buyer);
    expect(after.lines).toEqual([]);
  });

  it("returns the same order when the request is retried", async () => {
    // A double-clicked Place Order button must not bill twice.
    await cart.addItem(STORE, buyer, variantId, 1);
    const key = crypto.randomUUID();

    const first = await place({ idempotencyKey: key });
    const second = await checkout.placeOrder(STORE, buyer, {
      fulfillment: "PICKUP",
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);

    const { total } = await orders.listForStore(STORE);
    expect(total).toBe(1);
  });

  it("refuses to sell something that was unpublished after it went in the cart", async () => {
    await cart.addItem(STORE, buyer, variantId, 1);
    await asAdmin((db) =>
      db.$executeRaw`UPDATE products SET status = 'DRAFT' WHERE store_id = ${STORE}`,
    );

    await expect(place()).rejects.toMatchObject({ status: 400 });
  });
});

describe("stock reservation", () => {
  it("reserves stock without decrementing on-hand", async () => {
    // The bread is still on the shelf until the order is confirmed; it is just
    // spoken for.
    await stock(variantId, 5);
    await cart.addItem(STORE, buyer, variantId, 2);
    await place();

    expect(await readStock(variantId)).toMatchObject({ on_hand: 5, reserved: 2 });
  });

  it("refuses an order for more than is available", async () => {
    await stock(variantId, 1);
    await cart.addItem(STORE, buyer, variantId, 2);

    await expect(place()).rejects.toMatchObject({ status: 400 });
  });

  it("leaves no reservation behind when an order fails partway", async () => {
    // The first line reserves, then the second fails. Without transactional
    // rollback the first item would stay held forever by an order that never
    // existed.
    await stock(variantId, 5);
    await stock(secondVariantId, 0);
    await cart.addItem(STORE, buyer, variantId, 1);
    await cart.addItem(STORE, buyer, secondVariantId, 1);

    await expect(place()).rejects.toMatchObject({ status: 400 });
    expect(await readStock(variantId)).toMatchObject({ reserved: 0 });
  });

  it("ignores stock for items the store doesn't track", async () => {
    // A bakery making to order should not have checkout blocked by a count of
    // zero that nobody maintains.
    await cart.addItem(STORE, buyer, variantId, 50);
    const order = await place();
    expect(order.orderNumber).toBeTruthy();
  });

  it("does not oversell the last item under concurrent checkout", async () => {
    // The risk the plan calls the highest in the project. Two shoppers, one
    // loaf; exactly one order must exist afterwards.
    await stock(variantId, 1);

    const shopperA: Shopper = { kind: "guest", sessionKey: "race-a" };
    const shopperB: Shopper = { kind: "guest", sessionKey: "race-b" };
    await cart.addItem(STORE, shopperA, variantId, 1);
    await cart.addItem(STORE, shopperB, variantId, 1);

    const results = await Promise.allSettled([
      checkout.placeOrder(STORE, shopperA, { fulfillment: "PICKUP", idempotencyKey: crypto.randomUUID() }),
      checkout.placeOrder(STORE, shopperB, { fulfillment: "PICKUP", idempotencyKey: crypto.randomUUID() }),
    ]);

    const placed = results.filter((r) => r.status === "fulfilled");
    expect(placed).toHaveLength(1);

    const level = await readStock(variantId);
    expect(level.reserved).toBe(1);
    expect(level.on_hand).toBe(1);
  });
});
