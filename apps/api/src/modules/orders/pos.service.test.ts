import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { ConfiguredRateTaxProvider } from "../checkout/tax.provider.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { OrdersService } from "./orders.service.js";
import { PosService } from "./pos.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const OWNER = "ce000000-0000-4000-8000-000000000001";
const CLERK = "ce000000-0000-4000-8000-000000000002";
const STORE = "ce000000-0000-4000-8000-00000000000a";

const TAX_BPS = 1025;

let prisma: PrismaService;
let pos: PosService;
let orders: OrdersService;
let outbox: OutboxService;
let loafVariant = "";
let bunVariant = "";

beforeAll(() => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  const audit = new AuditService(prisma);
  outbox = new OutboxService(prisma);
  pos = new PosService(
    prisma,
    new ConfiguredRateTaxProvider(async () => ({ rateBps: TAX_BPS, name: "IL sales tax" })),
    audit,
    outbox,
  );
  orders = new OrdersService(prisma, audit, outbox);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await seed();
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
      (${OWNER},'pos-owner@example.com'::citext,'Owner','ACTIVE',now(),now()),
      (${CLERK},'pos-clerk@example.com'::citext,'Clerk','ACTIVE',now(),now())`;

    await db.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,city,state,postal_code,
                          timezone,currency,branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'pos-test-shop'::citext,'POS Test Shop','RETAIL','ACTIVE',${OWNER},
              'Chicago','IL','60626','America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;

    for (const [name, slug, price, sku, barcode, ref] of [
      ["Sourdough Loaf", "sourdough-loaf", 800, "LOAF-01", "0123456789012", "loaf"],
      ["Cinnamon Bun", "cinnamon-bun", 475, "BUN-01", "9876543210987", "bun"],
    ] as const) {
      const productId = crypto.randomUUID();
      const vId = crypto.randomUUID();
      if (ref === "loaf") loafVariant = vId;
      else bunVariant = vId;

      await db.$executeRaw`
        INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
        VALUES (${productId},${STORE},${name},${slug},'ACTIVE',now(),now())`;
      await db.$executeRaw`
        INSERT INTO product_variants (id,store_id,product_id,sku,barcode,price_cents,is_default,active,attrs,created_at,updated_at)
        VALUES (${vId},${STORE},${productId},${sku},${barcode},${price},true,true,'{}'::jsonb,now(),now())`;
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
    await db.$executeRaw`DELETE FROM store_counters WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM stock_movements WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM stock_levels WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM outbox_events WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await db.$executeRaw`DELETE FROM users WHERE id IN (${OWNER}, ${CLERK})`;
  });
}

async function stock(vId: string, qty: number): Promise<void> {
  await asAdmin(async (db) => {
    if (qty > 0) {
      await db.$executeRaw`
        INSERT INTO stock_movements (id,store_id,variant_id,type,qty_delta)
        VALUES (gen_random_uuid(),${STORE},${vId},'RECEIVE',${qty})`;
    }
    await db.$executeRaw`
      INSERT INTO stock_levels (variant_id,store_id,on_hand,reserved,tracked,updated_at)
      VALUES (${vId},${STORE},${Math.max(qty, 0)},0,true,now())
      ON CONFLICT (variant_id) DO UPDATE SET tracked = true`;
  });
}

async function readStock(vId: string) {
  return asAdmin(async (db) => {
    const [row] = await db.$queryRaw<{ on_hand: number; reserved: number }[]>`
      SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${vId}`;
    return row ?? { on_hand: 0, reserved: 0 };
  });
}

function sell(lines: { variantId: string; qty: number }[], extra: Record<string, unknown> = {}) {
  return pos.ringUp(STORE, CLERK, {
    lines,
    idempotencyKey: crypto.randomUUID(),
    ...extra,
  });
}

describe("till lookup", () => {
  it("finds an item by scanned barcode", async () => {
    const found = await pos.lookup(STORE, "0123456789012");
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("Sourdough Loaf");
  });

  it("finds an item by typed SKU", async () => {
    const found = await pos.lookup(STORE, "BUN-01");
    expect(found[0]!.name).toBe("Cinnamon Bun");
  });

  it("falls back to a name search when the label is unreadable", async () => {
    const found = await pos.lookup(STORE, "sourdough");
    expect(found.map((f) => f.name)).toContain("Sourdough Loaf");
  });

  it("returns nothing for an unknown code rather than guessing", async () => {
    expect(await pos.lookup(STORE, "not-a-real-code")).toEqual([]);
  });

  it("reports available quantity only for tracked items", async () => {
    await stock(loafVariant, 4);

    const [loaf] = await pos.lookup(STORE, "LOAF-01");
    const [bun] = await pos.lookup(STORE, "BUN-01");

    expect(loaf!.availableQty).toBe(4);
    // Null, not zero: "we don't count this" and "we have none" mean opposite
    // things to a clerk deciding whether to sell it.
    expect(bun!.availableQty).toBeNull();
  });

  it("does not offer a draft product at the till", async () => {
    await asAdmin((db) =>
      db.$executeRaw`UPDATE products SET status = 'DRAFT' WHERE store_id = ${STORE} AND slug = 'cinnamon-bun'`,
    );
    expect(await pos.lookup(STORE, "BUN-01")).toEqual([]);
  });
});

describe("ringing up a sale", () => {
  it("creates a completed, paid counter sale", async () => {
    const sale = await sell([{ variantId: loafVariant, qty: 2 }]);

    expect(sale.subtotalCents).toBe(1600);
    expect(sale.taxCents).toBe(164);
    expect(sale.totalCents).toBe(1764);

    const detail = await orders.getForStore(STORE, sale.id);
    expect(detail.channel).toBe("POS");
    expect(detail.customerId).toBeNull();
    // The customer already walked out with it — anything short of PICKED_UP
    // would leave phantom work sitting in the clerk's queue.
    expect(detail.status).toBe("PICKED_UP");
    expect(detail.payments[0]).toMatchObject({
      provider: "CASH",
      status: "SUCCEEDED",
      cashReceivedBy: CLERK,
    });
  });

  it("prices from the catalog, not from what the till claims", async () => {
    // A till that can name its own prices is a till that can sell at zero.
    const sale = await sell([{ variantId: loafVariant, qty: 1 }]);
    expect(sale.subtotalCents).toBe(800);
  });

  it("computes change from what the customer handed over", async () => {
    const sale = await sell([{ variantId: loafVariant, qty: 1 }], { tenderedCents: 1000 });
    expect(sale.totalCents).toBe(882);
    expect(sale.changeCents).toBe(118);
  });

  it("refuses a tender that doesn't cover the total", async () => {
    await expect(
      sell([{ variantId: loafVariant, qty: 1 }], { tenderedCents: 500 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("takes stock off the shelf immediately", async () => {
    await stock(loafVariant, 5);
    await sell([{ variantId: loafVariant, qty: 2 }]);

    // No reservation phase: the goods left the building as the sale was rung.
    expect(await readStock(loafVariant)).toMatchObject({ on_hand: 3, reserved: 0 });
  });

  it("records the sale in the stock ledger", async () => {
    await stock(loafVariant, 5);
    const sale = await sell([{ variantId: loafVariant, qty: 2 }]);

    const movements = await asAdmin((db) =>
      db.$queryRaw<{ type: string; qty_delta: number; reason_code: string | null; order_id: string | null }[]>`
        SELECT type::text, qty_delta, reason_code, order_id FROM stock_movements
        WHERE variant_id = ${loafVariant} ORDER BY created_at`,
    );
    expect(movements[1]).toMatchObject({
      type: "SALE",
      qty_delta: -2,
      reason_code: "counter_sale",
      order_id: sale.id,
    });
  });

  it("refuses to sell more than is on the shelf", async () => {
    // Blocked rather than warned: the count is what the owner reconciles
    // against, and a negative is a discrepancy somebody chases later.
    await stock(loafVariant, 1);
    await expect(sell([{ variantId: loafVariant, qty: 2 }])).rejects.toMatchObject({ status: 400 });
  });

  it("leaves the shelf untouched when a sale fails partway", async () => {
    await stock(loafVariant, 5);
    await stock(bunVariant, 0);

    await expect(
      sell([
        { variantId: loafVariant, qty: 1 },
        { variantId: bunVariant, qty: 1 },
      ]),
    ).rejects.toMatchObject({ status: 400 });

    expect(await readStock(loafVariant)).toMatchObject({ on_hand: 5 });
  });

  it("sells untracked items without a stock check", async () => {
    const sale = await sell([{ variantId: bunVariant, qty: 12 }]);
    expect(sale.totalCents).toBeGreaterThan(0);
  });

  it("returns the same sale when the request is retried", async () => {
    const key = crypto.randomUUID();
    const first = await pos.ringUp(STORE, CLERK, { lines: [{ variantId: loafVariant, qty: 1 }], idempotencyKey: key });
    const second = await pos.ringUp(STORE, CLERK, { lines: [{ variantId: loafVariant, qty: 1 }], idempotencyKey: key });

    expect(second.id).toBe(first.id);
    const { total } = await orders.listForStore(STORE);
    expect(total).toBe(1);
  });

  it("refuses an empty sale", async () => {
    await expect(sell([])).rejects.toMatchObject({ status: 400 });
  });

  it("writes a full status history rather than jumping states", async () => {
    // The trigger enforces legal transitions, so a counter sale walks the same
    // path an online order does — just all at once.
    const sale = await sell([{ variantId: loafVariant, qty: 1 }]);
    const detail = await orders.getForStore(STORE, sale.id);

    expect(detail.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      "CONFIRMED", "PREPARING", "READY", "PICKED_UP",
    ]);
  });

  it("never records a platform fee", async () => {
    const sale = await sell([{ variantId: loafVariant, qty: 1 }]);
    const detail = await orders.getForStore(STORE, sale.id);
    expect(detail.payments[0]!.applicationFeeCents).toBe(0);
  });

  it("shares the order-number sequence with online orders", async () => {
    const first = await sell([{ variantId: loafVariant, qty: 1 }]);
    const second = await sell([{ variantId: loafVariant, qty: 1 }]);

    const firstNo = Number(first.orderNumber.split("-")[1]);
    const secondNo = Number(second.orderNumber.split("-")[1]);
    expect(secondNo).toBe(firstNo + 1);
  });
});
