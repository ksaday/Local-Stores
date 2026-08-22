import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { PlatformReportsService } from "./platform-reports.service.js";
import { ReportsService } from "./reports.service.js";
import { SalesRollupService } from "./sales-rollup.service.js";

/**
 * What the rollup counts, and which day it files it under.
 *
 * Both are the kind of thing that is wrong silently: the figures still add up,
 * still look plausible, and nobody notices until an owner reconciles a month
 * against their bank and finds it short.
 */

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "5a1e5000-0000-4000-8000-00000000000a";
const OWNER = "5a1e5000-0000-4000-8000-000000000001";

let prisma: PrismaService;
let admin: PrismaService;
let rollup: SalesRollupService;
let reports: ReportsService;
let platform: PlatformReportsService;

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  admin = new PrismaService();
  rollup = new SalesRollupService(prisma);
  reports = new ReportsService(prisma);
  platform = new PlatformReportsService(prisma);
  await seed();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await admin.$disconnect();
});

beforeEach(async () => {
  await admin.$executeRaw`DELETE FROM stock_levels WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM store_subscriptions WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM store_customers WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM daily_store_product_sales WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM daily_store_sales WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM refunds WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM payments WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM order_items WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM orders WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
});

async function seed(): Promise<void> {
  await cleanup();
  await admin.$executeRaw`
    INSERT INTO users (id,email,name,status,created_at,updated_at)
    VALUES (${OWNER},'rollup-owner@example.test'::citext,'Rollup Owner','ACTIVE',now(),now())`;
  // Chicago on purpose: far enough from UTC that an evening sale lands on the
  // next UTC day, which is the case the date bucketing has to get right.
  await admin.$executeRaw`
    INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                        branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,
                        created_at,updated_at)
    VALUES (${STORE},'rollup-store'::citext,'Rollup Store','RETAIL','ACTIVE',${OWNER},
            'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
}

async function cleanup(): Promise<void> {
  await admin.$executeRaw`DELETE FROM stock_levels WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM store_subscriptions WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM store_customers WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM daily_store_product_sales WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM daily_store_sales WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM refunds WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM payments WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM order_items WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM orders WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM users WHERE email LIKE 'rollup-%@example.test'`;
  await admin.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
}

async function order(input: {
  placedAt: string;
  status?: string;
  channel?: string;
  subtotal?: number;
  discount?: number;
  tax?: number;
  customerId?: string;
}): Promise<string> {
  const id = randomUUID();
  const subtotal = input.subtotal ?? 1000;
  const discount = input.discount ?? 0;
  const tax = input.tax ?? 0;
  await admin.$executeRawUnsafe(
    `INSERT INTO orders (id,store_id,order_number,channel,fulfillment,status,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,
       currency,customer_id,placed_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4::"OrderChannel",'PICKUP',$5::"OrderStatus",$6,$7,$8,0,0,$9,'USD',
             $10,$11::timestamptz,now(),now())`,
    id,
    STORE,
    `R-${id.slice(0, 8)}`,
    input.channel ?? "ONLINE",
    input.status ?? "DELIVERED",
    subtotal,
    discount,
    tax,
    subtotal - discount + tax,
    input.customerId ?? null,
    input.placedAt,
  );
  return id;
}

async function refund(orderId: string, amount: number, createdAt: string): Promise<void> {
  const paymentId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO payments (id,store_id,order_id,provider,amount_cents,application_fee_cents,
       status,created_at,updated_at)
     VALUES ($1,$2,$3,'STRIPE',$4,0,'SUCCEEDED'::"PaymentStatus",now(),now())`,
    paymentId,
    STORE,
    orderId,
    amount,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO refunds (id,store_id,payment_id,amount_cents,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'SUCCEEDED'::"RefundStatus",$5::timestamptz,now())`,
    randomUUID(),
    STORE,
    paymentId,
    amount,
    createdAt,
  );
}

async function line(
  orderId: string,
  input: { variantId?: string | null; name: string; sku?: string; qty: number; unit: number },
): Promise<void> {
  await admin.$executeRawUnsafe(
    `INSERT INTO order_items (id,order_id,store_id,variant_id,product_name,variant_attrs,
       sku,unit_price_cents,qty,line_total_cents,tax_cents)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8,$9,0)`,
    randomUUID(),
    orderId,
    STORE,
    input.variantId ?? null,
    input.name,
    input.sku ?? null,
    input.unit,
    input.qty,
    input.unit * input.qty,
  );
}

/**
 * A real product and variant, because `order_items.variant_id` is a foreign
 * key — an invented id fails the constraint rather than standing in for a
 * deleted line. Variants are soft-deleted (`deleted_at`), so the reference
 * stays valid for the life of the order anyway; a NULL variant is the ad-hoc
 * line a POS sale can carry, not a deleted one.
 */
async function variant(name: string, price: number): Promise<string> {
  const productId = randomUUID();
  const variantId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'ACTIVE'::"ProductStatus",now(),now())`,
    productId,
    STORE,
    name,
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${productId.slice(0, 6)}`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO product_variants (id,product_id,store_id,sku,attrs,price_cents,
       is_default,active,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,true,true,now(),now())`,
    variantId,
    productId,
    STORE,
    `SKU-${variantId.slice(0, 6)}`,
    price,
  );
  return variantId;
}

/** An account holder, so an order can belong to somebody. */
async function customer(name: string): Promise<string> {
  const id = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO users (id,email,name,status,created_at,updated_at)
     VALUES ($1,$2::citext,$3,'ACTIVE',now(),now())`,
    id,
    `rollup-${id.slice(0, 8)}@example.test`,
    name,
  );
  return id;
}

/** Puts stock on the shelf for a variant, optionally with a cost. */
async function stock(
  variantId: string,
  input: { onHand: number; cost?: number | null; tracked?: boolean },
): Promise<void> {
  if (input.cost !== undefined) {
    await admin.$executeRawUnsafe(
      `UPDATE product_variants SET cost_cents = $2 WHERE id = $1`,
      variantId,
      input.cost,
    );
  }
  await admin.$executeRawUnsafe(
    `INSERT INTO stock_levels (variant_id,store_id,on_hand,reserved,tracked,updated_at)
     VALUES ($1,$2,$3,0,$4,now())
     ON CONFLICT (variant_id) DO UPDATE SET on_hand = EXCLUDED.on_hand, tracked = EXCLUDED.tracked`,
    variantId,
    STORE,
    input.onHand,
    input.tracked ?? true,
  );
}

/**
 * Noon in the store's own timezone, N days ago, as an instant.
 *
 * Not `new Date()` minus days: that anchors on UTC, and this shop is in
 * Chicago. Between UTC midnight and dawn the two calendars disagree, so a test
 * built on the UTC date files "today" under the store's tomorrow and reads
 * zero. Postgres does the conversion so daylight saving is handled too.
 */
async function storeNoon(daysAgo: number): Promise<string> {
  const [row] = await admin.$queryRawUnsafe<{ t: Date }[]>(
    `SELECT ((((now() AT TIME ZONE s.timezone)::date - $2::int) + time '12:00')
             AT TIME ZONE s.timezone) AS t
     FROM stores s WHERE s.id = $1`,
    STORE,
    daysAgo,
  );
  return row!.t.toISOString();
}

const WINDOW = { from: "2026-03-01", to: "2026-03-31" };

function read(date: string) {
  return admin.$queryRawUnsafe<Record<string, bigint | number>[]>(
    `SELECT * FROM daily_store_sales WHERE store_id = $1 AND date = $2::date`,
    STORE,
    date,
  );
}

describe("which day a sale belongs to", () => {
  it("files an evening sale under the store's day, not UTC's", async () => {
    // 2026-03-10 23:30 in Chicago is 2026-03-11 04:30 UTC. The shop counts it
    // as Tuesday's takings; bucketing on UTC would move their whole evening
    // into Wednesday.
    await order({ placedAt: "2026-03-11T04:30:00Z", subtotal: 2500 });
    await rollup.recomputeStore(STORE, WINDOW);

    const [tuesday] = await read("2026-03-10");
    const wednesday = await read("2026-03-11");

    expect(Number(tuesday?.gross_cents)).toBe(2500);
    expect(wednesday).toHaveLength(0);
  });

  it("keeps a morning sale on its own day", async () => {
    await order({ placedAt: "2026-03-12T15:00:00Z", subtotal: 700 });
    await rollup.recomputeStore(STORE, WINDOW);

    const [day] = await read("2026-03-12");
    expect(Number(day?.gross_cents)).toBe(700);
  });
});

describe("what counts as trade", () => {
  it("counts orders that happened and ignores those that did not", async () => {
    await order({ placedAt: "2026-03-05T18:00:00Z", status: "DELIVERED", subtotal: 1000 });
    await order({ placedAt: "2026-03-05T18:00:00Z", status: "PICKED_UP", subtotal: 2000 });
    await order({ placedAt: "2026-03-05T18:00:00Z", status: "CONFIRMED", subtotal: 500 });
    // Neither of these is money.
    await order({ placedAt: "2026-03-05T18:00:00Z", status: "PENDING", subtotal: 9999 });
    await order({ placedAt: "2026-03-05T18:00:00Z", status: "CANCELLED", subtotal: 8888 });

    await rollup.recomputeStore(STORE, WINDOW);
    const [day] = await read("2026-03-05");

    expect(Number(day?.orders_count)).toBe(3);
    expect(Number(day?.gross_cents)).toBe(3500);
  });

  it("still counts a refunded sale, and records the refund separately", async () => {
    // The sale happened. Removing it would make a finished month change after
    // the fact, which is the one thing a set of books must not do.
    const id = await order({ placedAt: "2026-03-06T18:00:00Z", status: "REFUNDED", subtotal: 4000 });
    await refund(id, 4000, "2026-03-06T19:00:00Z");

    await rollup.recomputeStore(STORE, WINDOW);
    const [day] = await read("2026-03-06");

    expect(Number(day?.orders_count)).toBe(1);
    expect(Number(day?.gross_cents)).toBe(4000);
    expect(Number(day?.refunds_cents)).toBe(4000);
    expect(Number(day?.net_cents)).toBe(0);
  });

  it("splits the count by channel", async () => {
    await order({ placedAt: "2026-03-07T18:00:00Z", channel: "POS" });
    await order({ placedAt: "2026-03-07T18:00:00Z", channel: "POS" });
    await order({ placedAt: "2026-03-07T18:00:00Z", channel: "ONLINE" });

    await rollup.recomputeStore(STORE, WINDOW);
    const [day] = await read("2026-03-07");

    expect(Number(day?.pos_orders_count)).toBe(2);
    expect(Number(day?.online_orders_count)).toBe(1);
  });

  it("nets discounts off but leaves tax out of net", async () => {
    // Tax is collected for the state. Counting it as takings would overstate
    // every shop's earnings by the local rate.
    await order({
      placedAt: "2026-03-08T18:00:00Z",
      subtotal: 10_000,
      discount: 1_000,
      tax: 900,
    });
    await rollup.recomputeStore(STORE, WINDOW);
    const [day] = await read("2026-03-08");

    expect(Number(day?.gross_cents)).toBe(10_000);
    expect(Number(day?.discounts_cents)).toBe(1_000);
    expect(Number(day?.tax_cents)).toBe(900);
    expect(Number(day?.net_cents)).toBe(9_000);
  });
});

describe("refunds", () => {
  it("dates a refund by when it was issued, not when the sale was", async () => {
    // A February sale refunded in March is March's problem. Dating it back
    // would reopen a month somebody has already reconciled.
    const id = await order({ placedAt: "2026-03-02T18:00:00Z", subtotal: 5000 });
    await refund(id, 1500, "2026-03-20T18:00:00Z");

    await rollup.recomputeStore(STORE, WINDOW);
    const [saleDay] = await read("2026-03-02");
    const [refundDay] = await read("2026-03-20");

    expect(Number(saleDay?.refunds_cents)).toBe(0);
    expect(Number(saleDay?.gross_cents)).toBe(5000);
    expect(Number(refundDay?.refunds_cents)).toBe(1500);
    // A day with a refund and no sales still gets a row — it is exactly the
    // day an owner goes looking for.
    expect(Number(refundDay?.orders_count)).toBe(0);
  });

  it("ignores a refund that never succeeded", async () => {
    const id = await order({ placedAt: "2026-03-09T18:00:00Z", subtotal: 3000 });
    const paymentId = randomUUID();
    await admin.$executeRawUnsafe(
      `INSERT INTO payments (id,store_id,order_id,provider,amount_cents,application_fee_cents,
         status,created_at,updated_at)
       VALUES ($1,$2,$3,'STRIPE',3000,0,'SUCCEEDED'::"PaymentStatus",now(),now())`,
      paymentId,
      STORE,
      id,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO refunds (id,store_id,payment_id,amount_cents,status,created_at,updated_at)
       VALUES ($1,$2,$3,3000,'FAILED'::"RefundStatus",$4::timestamptz,now())`,
      randomUUID(),
      STORE,
      paymentId,
      "2026-03-09T19:00:00Z",
    );

    await rollup.recomputeStore(STORE, WINDOW);
    const [day] = await read("2026-03-09");
    expect(Number(day?.refunds_cents)).toBe(0);
  });
});

describe("recomputing", () => {
  it("replaces a day rather than adding to it", async () => {
    await order({ placedAt: "2026-03-15T18:00:00Z", subtotal: 1000 });
    await rollup.recomputeStore(STORE, WINDOW);
    await rollup.recomputeStore(STORE, WINDOW);
    await rollup.recomputeStore(STORE, WINDOW);

    const [day] = await read("2026-03-15");
    // Three passes, one sale. A rollup that accumulated would read 3000 here
    // and nothing downstream would ever notice.
    expect(Number(day?.gross_cents)).toBe(1000);
  });

  it("picks up a status change on the next pass", async () => {
    const id = await order({ placedAt: "2026-03-16T18:00:00Z", status: "PENDING", subtotal: 2000 });
    await rollup.recomputeStore(STORE, WINDOW);
    expect(await read("2026-03-16")).toHaveLength(0);

    await admin.$executeRawUnsafe(
      `UPDATE orders SET status = 'CONFIRMED'::"OrderStatus" WHERE id = $1`,
      id,
    );
    await rollup.recomputeStore(STORE, WINDOW);

    const [day] = await read("2026-03-16");
    expect(Number(day?.gross_cents)).toBe(2000);
  });
});

describe("reading the report", () => {
  beforeEach(async () => {
    await order({ placedAt: "2026-03-02T18:00:00Z", subtotal: 1000 });
    await order({ placedAt: "2026-03-03T18:00:00Z", subtotal: 2000 });
    await order({ placedAt: "2026-03-17T18:00:00Z", subtotal: 4000 });
    await rollup.recomputeStore(STORE, WINDOW);
  });

  it("returns a point per day, with totals", async () => {
    const report = await reports.sales(STORE, { from: "2026-03-01", to: "2026-03-31" });
    expect(report.points).toHaveLength(3);
    expect(report.totals.grossCents).toBe(7000);
    expect(report.totals.ordersCount).toBe(3);
  });

  it("groups by month when asked", async () => {
    const report = await reports.sales(STORE, {
      from: "2026-03-01",
      to: "2026-03-31",
      grain: "month",
    });
    expect(report.points).toHaveLength(1);
    expect(report.points[0]!.date).toBe("2026-03-01");
    expect(report.points[0]!.grossCents).toBe(7000);
  });

  it("groups by week when asked", async () => {
    const report = await reports.sales(STORE, {
      from: "2026-03-01",
      to: "2026-03-31",
      grain: "week",
    });
    // Two distinct weeks: the 2nd/3rd fall together, the 17th does not.
    expect(report.points).toHaveLength(2);
  });

  it("refuses a grain it did not define", async () => {
    // This value is concatenated into SQL, so the check is not cosmetic.
    await expect(
      reports.sales(STORE, {
        from: "2026-03-01",
        to: "2026-03-31",
        grain: "day'); DROP TABLE daily_store_sales; --" as never,
      }),
    ).rejects.toMatchObject({ status: 400 });

    // And the table is still there.
    const rows = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) FROM daily_store_sales WHERE store_id = $1`,
      STORE,
    );
    expect(Number(rows[0]!.count)).toBe(3);
  });

  it("refuses a date that is not a date", async () => {
    await expect(
      reports.sales(STORE, { from: "yesterday", to: "2026-03-31" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a range that ends before it starts", async () => {
    await expect(
      reports.sales(STORE, { from: "2026-03-31", to: "2026-03-01" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("what sold most", () => {
  it("ranks by revenue and counts units and orders", async () => {
    const sourdough = await variant("Sourdough", 500);
    const brownie = await variant("Brownie", 300);

    const a = await order({ placedAt: "2026-03-04T18:00:00Z" });
    await line(a, { variantId: sourdough, name: "Sourdough", sku: "SD-1", qty: 2, unit: 500 });
    await line(a, { variantId: brownie, name: "Brownie", sku: "BR-1", qty: 1, unit: 300 });

    const b = await order({ placedAt: "2026-03-05T18:00:00Z" });
    await line(b, { variantId: sourdough, name: "Sourdough", sku: "SD-1", qty: 1, unit: 500 });

    await rollup.recomputeStoreProducts(STORE, WINDOW);
    const top = await reports.topProducts(STORE, WINDOW);

    expect(top).toHaveLength(2);
    expect(top[0]).toMatchObject({
      name: "Sourdough",
      sku: "SD-1",
      units: 3,
      revenueCents: 1500,
    });
    expect(top[1]).toMatchObject({ name: "Brownie", units: 1, revenueCents: 300 });
  });

  it("ignores lines on orders that never became trade", async () => {
    const v = await variant("Sourdough", 500);
    const cancelled = await order({ placedAt: "2026-03-06T18:00:00Z", status: "CANCELLED" });
    await line(cancelled, { variantId: v, name: "Sourdough", qty: 99, unit: 500 });

    await rollup.recomputeStoreProducts(STORE, WINDOW);
    expect(await reports.topProducts(STORE, WINDOW)).toHaveLength(0);
  });

  it("counts a refunded sale, because a refund names no line", async () => {
    // Refunds are recorded against a payment, so there is no honest way to say
    // which item came back. This report answers what left the shelves; the
    // takings report answers what the shop kept.
    const v = await variant("Sourdough", 500);
    const id = await order({ placedAt: "2026-03-07T18:00:00Z", status: "REFUNDED" });
    await line(id, { variantId: v, name: "Sourdough", qty: 4, unit: 500 });

    await rollup.recomputeStoreProducts(STORE, WINDOW);
    expect(await reports.topProducts(STORE, WINDOW)).toMatchObject([
      { units: 4, revenueCents: 2000 },
    ]);
  });

  it("keeps the name the customer was sold, not the catalog's current one", async () => {
    const v = await variant("Sourdough", 500);
    const id = await order({ placedAt: "2026-03-08T18:00:00Z" });
    await line(id, { variantId: v, name: "Sourdough (old recipe)", qty: 1, unit: 500 });

    // The line is a snapshot: renaming the product must not rewrite history.
    await admin.$executeRawUnsafe(
      `UPDATE products SET name = 'Sourdough (new recipe)' WHERE store_id = $1`,
      STORE,
    );

    await rollup.recomputeStoreProducts(STORE, WINDOW);
    const top = await reports.topProducts(STORE, WINDOW);
    expect(top[0]!.name).toBe("Sourdough (old recipe)");
  });

  it("keeps an ad-hoc line that names no variant at all", async () => {
    const id = await order({ placedAt: "2026-03-09T18:00:00Z" });
    await line(id, { variantId: null, name: "Counter special", qty: 2, unit: 250 });

    await rollup.recomputeStoreProducts(STORE, WINDOW);
    expect(await reports.topProducts(STORE, WINDOW)).toMatchObject([
      { variantId: null, name: "Counter special", units: 2 },
    ]);
  });

  it("leaves out anything outside the window", async () => {
    const a = await variant("Inside", 100);
    const b = await variant("Outside", 900);
    const inside = await order({ placedAt: "2026-03-10T18:00:00Z" });
    await line(inside, { variantId: a, name: "Inside", qty: 1, unit: 100 });
    const outside = await order({ placedAt: "2026-04-10T18:00:00Z" });
    await line(outside, { variantId: b, name: "Outside", qty: 50, unit: 900 });

    await rollup.recomputeStoreProducts(STORE, WINDOW);
    expect((await reports.topProducts(STORE, WINDOW)).map((t) => t.name)).toEqual(["Inside"]);
  });

  it("answers a window longer than a quarter, now that it reads the rollup", async () => {
    // The 92-day cap existed because the live query fell out of budget past
    // it. Off the rollup the cost is days, not orders, so it is gone.
    const v = await variant("Sourdough", 500);
    const id = await order({ placedAt: "2026-03-12T18:00:00Z" });
    await line(id, { variantId: v, name: "Sourdough", qty: 1, unit: 500 });
    await rollup.recomputeStoreProducts(STORE, { from: "2025-03-01", to: "2026-03-31" });

    const top = await reports.topProducts(STORE, { from: "2025-03-01", to: "2026-03-31" });
    expect(top).toMatchObject([{ name: "Sourdough", units: 1 }]);
  });

  it("does not double-count when the window is rebuilt", async () => {
    const v = await variant("Sourdough", 500);
    const id = await order({ placedAt: "2026-03-13T18:00:00Z" });
    await line(id, { variantId: v, name: "Sourdough", qty: 2, unit: 500 });

    await rollup.recomputeStoreProducts(STORE, WINDOW);
    await rollup.recomputeStoreProducts(STORE, WINDOW);
    await rollup.recomputeStoreProducts(STORE, WINDOW);

    expect(await reports.topProducts(STORE, WINDOW)).toMatchObject([{ units: 2 }]);
  });

  it("drops a line whose order stopped being trade", async () => {
    // A day here is many rows, so an upsert alone would leave the old one
    // behind — still counted, with nothing to overwrite it.
    const v = await variant("Sourdough", 500);
    // CONFIRMED, because the state machine refuses DELIVERED -> CANCELLED:
    // a parcel that has been handed over cannot be un-sold, which is the
    // trigger doing its job.
    const id = await order({ placedAt: "2026-03-14T18:00:00Z", status: "CONFIRMED" });
    await line(id, { variantId: v, name: "Sourdough", qty: 3, unit: 500 });
    await rollup.recomputeStoreProducts(STORE, WINDOW);
    expect(await reports.topProducts(STORE, WINDOW)).toHaveLength(1);

    await admin.$executeRawUnsafe(
      `UPDATE orders SET status = 'CANCELLED'::"OrderStatus" WHERE id = $1`,
      id,
    );
    await rollup.recomputeStoreProducts(STORE, WINDOW);

    expect(await reports.topProducts(STORE, WINDOW)).toHaveLength(0);
  });

  it("shows the most recent name when a line was renamed mid-window", async () => {
    const v = await variant("Sourdough", 500);
    const early = await order({ placedAt: "2026-03-15T18:00:00Z" });
    await line(early, { variantId: v, name: "Sourdough", qty: 1, unit: 500 });
    const late = await order({ placedAt: "2026-03-20T18:00:00Z" });
    await line(late, { variantId: v, name: "Sourdough (new recipe)", qty: 1, unit: 500 });
    await rollup.recomputeStoreProducts(STORE, WINDOW);

    const top = await reports.topProducts(STORE, WINDOW);
    // One line, both sales, called what it is called now.
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ name: "Sourdough (new recipe)", units: 2 });
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      const v = await variant(`P${i}`, 100 * (i + 1));
      const id = await order({ placedAt: "2026-03-11T18:00:00Z" });
      await line(id, { variantId: v, name: `P${i}`, qty: 1, unit: 100 * (i + 1) });
    }
    await rollup.recomputeStoreProducts(STORE, WINDOW);
    expect(await reports.topProducts(STORE, { ...WINDOW, limit: 3 })).toHaveLength(3);
  });
});

describe("the dashboard summary", () => {
  it("totals today, the last seven days and the last thirty", async () => {
    // Dated relative to now, because the summary's windows are anchored to the
    // store's today rather than to a fixed date.
    await order({ placedAt: await storeNoon(0), subtotal: 1000 });
    await order({ placedAt: await storeNoon(3), subtotal: 2000 });
    await order({ placedAt: await storeNoon(20), subtotal: 4000 });
    // Outside every window.
    await order({ placedAt: await storeNoon(60), subtotal: 8000 });

    const from = new Date(Date.now() - 70 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await rollup.recomputeStore(STORE, { from, to });

    const summary = await reports.summary(STORE);

    expect(summary.today.netCents).toBe(1000);
    expect(summary.last7.netCents).toBe(3000);
    expect(summary.last30.netCents).toBe(7000);
    expect(summary.last30.ordersCount).toBe(3);
  });

  it("reports zeroes and no timestamp for a shop that has sold nothing", async () => {
    const summary = await reports.summary(STORE);

    expect(summary.today).toEqual({ netCents: 0, ordersCount: 0 });
    expect(summary.last30).toEqual({ netCents: 0, ordersCount: 0 });
    // Null rather than "now": the dashboard says "no figures yet" instead of
    // claiming it is up to date with nothing behind it.
    expect(summary.computedAt).toBeNull();
  });
});

describe("the customer list", () => {
  it("totals a customer's whole history, not just the window rolled up", async () => {
    // The point of the design: a lifetime figure is not confined to a window,
    // so recomputing three days must still re-add everything before it.
    const who = await customer("Regular Rita");
    await order({ placedAt: "2026-01-05T18:00:00Z", subtotal: 1000, customerId: who });
    await order({ placedAt: "2026-02-05T18:00:00Z", subtotal: 2000, customerId: who });
    await order({ placedAt: "2026-03-05T18:00:00Z", subtotal: 3000, customerId: who });

    // Only March is in the window, and Rita ordered in it.
    await rollup.recomputeStoreCustomers(STORE, WINDOW);

    const { rows } = await reports.customers(STORE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Regular Rita",
      ordersCount: 3,
      lifetimeCents: 6000,
    });
    expect(rows[0]!.firstOrderAt?.slice(0, 10)).toBe("2026-01-05");
    expect(rows[0]!.lastOrderAt?.slice(0, 10)).toBe("2026-03-05");
  });

  it("leaves out guest orders entirely", async () => {
    await order({ placedAt: "2026-03-06T18:00:00Z", subtotal: 5000 });
    await rollup.recomputeStoreCustomers(STORE, WINDOW);

    const { rows, total } = await reports.customers(STORE);
    expect(rows).toHaveLength(0);
    expect(total).toBe(0);
  });

  it("nets discounts off the lifetime figure", async () => {
    const who = await customer("Discount Dan");
    await order({
      placedAt: "2026-03-07T18:00:00Z",
      subtotal: 10_000,
      discount: 2_500,
      tax: 900,
      customerId: who,
    });
    await rollup.recomputeStoreCustomers(STORE, WINDOW);

    // Tax is not the shop's money and is not the customer's spend with them.
    expect((await reports.customers(STORE)).rows[0]!.lifetimeCents).toBe(7_500);
  });

  it("ignores orders that never became trade", async () => {
    const who = await customer("Browsing Bob");
    await order({ placedAt: "2026-03-08T18:00:00Z", status: "CANCELLED", customerId: who });
    await order({ placedAt: "2026-03-08T18:00:00Z", status: "PENDING", customerId: who });
    await rollup.recomputeStoreCustomers(STORE, WINDOW);

    expect((await reports.customers(STORE)).rows).toHaveLength(0);
  });

  it("stops counting somebody whose only order was cancelled", async () => {
    const who = await customer("Changed Their Mind");
    const id = await order({
      placedAt: "2026-03-09T18:00:00Z",
      status: "CONFIRMED",
      customerId: who,
    });
    await rollup.recomputeStoreCustomers(STORE, WINDOW);
    expect((await reports.customers(STORE)).rows).toHaveLength(1);

    await admin.$executeRawUnsafe(
      `UPDATE orders SET status = 'CANCELLED'::"OrderStatus" WHERE id = $1`,
      id,
    );
    await rollup.recomputeStoreCustomers(STORE, WINDOW);

    // Not left behind with stale totals: the sweep clears what it rebuilds.
    expect((await reports.customers(STORE)).rows).toHaveLength(0);
  });

  it("does not double-count when the window is rebuilt", async () => {
    const who = await customer("Repeat Recompute");
    await order({ placedAt: "2026-03-10T18:00:00Z", subtotal: 1500, customerId: who });

    await rollup.recomputeStoreCustomers(STORE, WINDOW);
    await rollup.recomputeStoreCustomers(STORE, WINDOW);
    await rollup.recomputeStoreCustomers(STORE, WINDOW);

    expect((await reports.customers(STORE)).rows[0]).toMatchObject({
      ordersCount: 1,
      lifetimeCents: 1500,
    });
  });

  it("sorts by spend, and by recency when asked", async () => {
    const big = await customer("Big Spender");
    const recent = await customer("Recent Visitor");
    await order({ placedAt: "2026-03-01T18:00:00Z", subtotal: 90_000, customerId: big });
    await order({ placedAt: "2026-03-30T18:00:00Z", subtotal: 100, customerId: recent });
    await rollup.recomputeStoreCustomers(STORE, WINDOW);

    const bySpend = await reports.customers(STORE, { sort: "spend" });
    expect(bySpend.rows[0]!.name).toBe("Big Spender");

    const byRecent = await reports.customers(STORE, { sort: "recent" });
    expect(byRecent.rows[0]!.name).toBe("Recent Visitor");
  });
});

describe("the platform console's figures", () => {
  it("counts a shop's trade as GMV, and does not call it revenue", async () => {
    // BBA takes no cut (§18.6), so this figure is the shops doing well rather
    // than the platform earning. The test exists so that stays true in code.
    await order({ placedAt: await storeNoon(1), subtotal: 5000 });
    await order({ placedAt: await storeNoon(2), subtotal: 3000 });

    const from = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await rollup.recomputeStore(STORE, { from, to });

    const summary = await platform.summary(30);
    expect(summary.gmvCents).toBeGreaterThanOrEqual(8000);
    expect(summary.ordersCount).toBeGreaterThanOrEqual(2);
  });

  it("counts only billing subscriptions as MRR", async () => {
    // A trial is not recurring revenue however likely it looks, and counting
    // it is the oldest way to flatter a dashboard.
    const before = await platform.summary(30);

    await admin.$executeRawUnsafe(
      `INSERT INTO store_subscriptions (id,store_id,plan_code,status,created_at,updated_at)
       SELECT $1,$2,code,'TRIALING'::"SubscriptionStatus",now(),now() FROM plans LIMIT 1`,
      randomUUID(),
      STORE,
    );

    const after = await platform.summary(30);
    expect(after.mrrCents).toBe(before.mrrCents);
    expect(after.trialingCount).toBe(before.trialingCount + 1);

    await admin.$executeRawUnsafe(
      `UPDATE store_subscriptions SET status='ACTIVE'::"SubscriptionStatus" WHERE store_id=$1`,
      STORE,
    );

    const billing = await platform.summary(30);
    expect(billing.mrrCents).toBeGreaterThan(before.mrrCents);
    expect(billing.trialingCount).toBe(before.trialingCount);
  });

  it("counts the shops by status", async () => {
    const summary = await platform.summary(30);
    // The fixture store is ACTIVE, so at minimum it is in there.
    expect(summary.stores.active).toBeGreaterThanOrEqual(1);
  });
});

describe("what the shelves are worth", () => {
  it("values stock at cost and at retail", async () => {
    const bread = await variant("Sourdough", 500);
    await stock(bread, { onHand: 10, cost: 200 });

    const v = await reports.stockValuation(STORE);
    expect(v.linesCounted).toBe(1);
    expect(v.unitsOnHand).toBe(10);
    expect(v.costCents).toBe(2000);
    expect(v.retailCents).toBe(5000);
  });

  it("says what it could not value rather than quietly omitting it", async () => {
    // Cost is optional in the catalogue. A total that skipped the uncosted
    // lines would read as complete and be wrong by however much they are worth.
    const costed = await variant("Costed", 500);
    const uncosted = await variant("Uncosted", 900);
    await stock(costed, { onHand: 4, cost: 100 });
    await stock(uncosted, { onHand: 7, cost: null });

    const v = await reports.stockValuation(STORE);
    expect(v.costCents).toBe(400);
    expect(v.linesWithoutCost).toBe(1);
    expect(v.unitsWithoutCost).toBe(7);
    // Retail is whole, because every line has a price.
    expect(v.retailCents).toBe(4 * 500 + 7 * 900);
  });

  it("ignores untracked lines and empty shelves", async () => {
    const untracked = await variant("Made to order", 500);
    const empty = await variant("Sold out", 500);
    await stock(untracked, { onHand: 99, cost: 100, tracked: false });
    await stock(empty, { onHand: 0, cost: 100 });

    // A shop selling made-to-order items keeps no count, and nothing on the
    // shelf is worth nothing — neither belongs in a valuation.
    expect((await reports.stockValuation(STORE)).linesCounted).toBe(0);
  });

  it("ranks on retail, so costed and uncosted lines compare fairly", async () => {
    const small = await variant("Cheap", 100);
    const big = await variant("Dear", 5000);
    const uncostedBig = await variant("Dear but uncosted", 4000);
    await stock(small, { onHand: 5, cost: 50 });
    await stock(big, { onHand: 20, cost: 2500 });
    await stock(uncostedBig, { onHand: 10, cost: null });

    const v = await reports.stockValuation(STORE);
    // Ranking on "cost where known, retail otherwise" mixes two measures that
    // differ by the margin, and floats every uncosted line to the top.
    // "Dear" is worth 100,000 at retail, the uncosted line 40,000.
    expect(v.top.map((t) => t.name)).toEqual(["Dear", "Dear but uncosted", "Cheap"]);
  });
});
