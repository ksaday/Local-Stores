import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
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

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  admin = new PrismaService();
  rollup = new SalesRollupService(prisma);
  reports = new ReportsService(prisma);
  await seed();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await admin.$disconnect();
});

beforeEach(async () => {
  await admin.$executeRaw`DELETE FROM daily_store_sales WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM refunds WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM payments WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM orders WHERE store_id = ${STORE}`;
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
  await admin.$executeRaw`DELETE FROM daily_store_sales WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM refunds WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM payments WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM orders WHERE store_id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
  await admin.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
}

async function order(input: {
  placedAt: string;
  status?: string;
  channel?: string;
  subtotal?: number;
  discount?: number;
  tax?: number;
}): Promise<string> {
  const id = randomUUID();
  const subtotal = input.subtotal ?? 1000;
  const discount = input.discount ?? 0;
  const tax = input.tax ?? 0;
  await admin.$executeRawUnsafe(
    `INSERT INTO orders (id,store_id,order_number,channel,fulfillment,status,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,
       currency,placed_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4::"OrderChannel",'PICKUP',$5::"OrderStatus",$6,$7,$8,0,0,$9,'USD',$10::timestamptz,now(),now())`,
    id,
    STORE,
    `R-${id.slice(0, 8)}`,
    input.channel ?? "ONLINE",
    input.status ?? "DELIVERED",
    subtotal,
    discount,
    tax,
    subtotal - discount + tax,
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
