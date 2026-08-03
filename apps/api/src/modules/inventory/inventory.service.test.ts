import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "./inventory.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "fa000000-0000-4000-8000-00000000000a";
const OWNER = "fa000000-0000-4000-8000-000000000001";
const PRODUCT = "fa000000-0000-4000-8000-000000000010";
const VARIANT = "fa000000-0000-4000-8000-000000000011";
const OTHER_VARIANT = "fa000000-0000-4000-8000-000000000012";

let prisma: PrismaService;
let inventory: InventoryService;

beforeEach(async () => {
  prisma = prisma ?? new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  inventory = new InventoryService(prisma, new AuditService(prisma));
  await reset();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function asAdmin<T>(work: (admin: PrismaService) => Promise<T>): Promise<T> {
  const admin = new PrismaService();
  try {
    return await work(admin);
  } finally {
    await admin.$disconnect();
  }
}

async function reset(): Promise<void> {
  await cleanup();
  await asAdmin(async (a) => {
    await a.$executeRaw`
      INSERT INTO users (id,email,name,status,created_at,updated_at)
      VALUES (${OWNER},'inv-owner@example.com'::citext,'Ivy','ACTIVE',now(),now())`;
    await a.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                          branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'inv-store'::citext,'Inventory Store','RETAIL','ACTIVE',${OWNER},
              'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    await a.$executeRaw`
      INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
      VALUES (${PRODUCT},${STORE},'Sourdough Loaf','sourdough-loaf'::citext,'ACTIVE',now(),now())`;
    for (const [id, sku, size] of [
      [VARIANT, "SOUR-1", "Large"],
      [OTHER_VARIANT, "SOUR-2", "Small"],
    ] as const) {
      await a.$executeRaw`
        INSERT INTO product_variants (id,store_id,product_id,attrs,sku,price_cents,is_default,created_at,updated_at)
        VALUES (${id},${STORE},${PRODUCT},${JSON.stringify({ size })}::jsonb,${sku},800,
                ${id === VARIANT},now(),now())`;
    }
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (a) => {
    await a.$executeRaw`DELETE FROM stock_movements WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM stock_levels WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await a.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
  });
}

describe("receiving stock", () => {
  it("puts stock on the shelf and leaves a movement behind", async () => {
    const row = await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 24, note: "Tuesday delivery" });

    expect(row.on_hand).toBe(24);
    expect(row.available).toBe(24);

    const [movement] = await inventory.movements(STORE, VARIANT);
    expect(movement).toMatchObject({ type: "RECEIVE", qty_delta: 24, note: "Tuesday delivery" });
    // Who took the delivery, not just that one happened.
    expect(movement!.actor_name).toBe("Ivy");
  });

  it("adds to what is already there", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 10 });
    const row = await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 5 });

    expect(row.on_hand).toBe(15);
    expect(await inventory.movements(STORE, VARIANT)).toHaveLength(2);
  });

  it("refuses a receipt that is not a positive whole number", async () => {
    // Negative "receipts" would hide corrections inside deliveries, and the
    // first question of this ledger is how much actually arrived.
    await expect(inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: -5 })).rejects.toThrow();
    await expect(inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 0 })).rejects.toThrow();
    await expect(inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 1.5 })).rejects.toThrow();
  });

  it("will not touch a variant belonging to someone else", async () => {
    await expect(
      inventory.receive(STORE, OWNER, { variantId: randomUUID(), qty: 1 }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("adjusting stock", () => {
  it("records a correction without editing what came before", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 20 });

    const row = await inventory.adjust(STORE, OWNER, {
      variantId: VARIANT,
      qtyDelta: -3,
      reason: "MISCOUNT",
    });

    expect(row.on_hand).toBe(17);
    const movements = await inventory.movements(STORE, VARIANT);
    // Both are still there: the ledger is what makes the level defensible.
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({ type: "ADJUSTMENT", qty_delta: -3, reason_code: "MISCOUNT" });
    expect(movements[1]).toMatchObject({ type: "RECEIVE", qty_delta: 20 });
  });

  it("files damage as its own kind of movement", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 10 });
    await inventory.adjust(STORE, OWNER, { variantId: VARIANT, qtyDelta: -2, reason: "DAMAGE" });

    // "How much did we break" and "how far out was the count" are different
    // questions, and only one of them is a supplier conversation.
    const [movement] = await inventory.movements(STORE, VARIANT);
    expect(movement!.type).toBe("DAMAGE");
  });

  it("refuses to take stock below zero, and says what is there", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 3 });

    await expect(
      inventory.adjust(STORE, OWNER, { variantId: VARIANT, qtyDelta: -5, reason: "MISCOUNT" }),
    ).rejects.toThrow(/3 on hand/);

    // Nothing was written: a refused adjustment must not leave half of itself.
    expect(await inventory.movements(STORE, VARIANT)).toHaveLength(1);
  });

  it("refuses an adjustment of zero", async () => {
    await expect(
      inventory.adjust(STORE, OWNER, { variantId: VARIANT, qtyDelta: 0, reason: "OTHER" }),
    ).rejects.toThrow();
  });
});

describe("what needs reordering", () => {
  it("lists only tracked lines at or below their reorder point", async () => {
    await inventory.setTracking(STORE, OWNER, VARIANT, { tracked: true, reorderPoint: 5, reorderQty: 20 });
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 5 });

    // Untracked, and deliberately at zero: a made-to-order line must not turn
    // up on a reorder list nobody asked it to be on.
    await inventory.setTracking(STORE, OWNER, OTHER_VARIANT, { tracked: false });

    const low = await inventory.lowStock(STORE);
    expect(low.map((r) => r.variant_id)).toEqual([VARIANT]);
  });

  it("stops listing a line once it has been restocked", async () => {
    await inventory.setTracking(STORE, OWNER, VARIANT, { tracked: true, reorderPoint: 5 });
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 4 });
    expect(await inventory.lowStock(STORE)).toHaveLength(1);

    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 20 });
    expect(await inventory.lowStock(STORE)).toHaveLength(0);
  });

  it("counts reserved stock as gone", async () => {
    await inventory.setTracking(STORE, OWNER, VARIANT, { tracked: true, reorderPoint: 5 });
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 10 });
    // Stock held for orders that are placed but not yet collected is not stock
    // anyone can sell, so it must not keep a line off the reorder list.
    await asAdmin((a) => a.$executeRaw`
      UPDATE stock_levels SET reserved = 6 WHERE variant_id = ${VARIANT}`);

    const [low] = await inventory.lowStock(STORE);
    expect(low?.available).toBe(4);
  });
});

describe("the stock list", () => {
  it("shows a variant that has never been counted, as zero", async () => {
    // A line missing from this list because nobody has touched it is exactly
    // how stock goes untracked.
    const rows = await inventory.list(STORE);

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.on_hand === 0 && r.tracked === false)).toBe(true);
  });

  it("searches by product name and SKU", async () => {
    expect(await inventory.list(STORE, { q: "Sourdough" })).toHaveLength(2);
    expect(await inventory.list(STORE, { q: "SOUR-2" })).toHaveLength(1);
    expect(await inventory.list(STORE, { q: "Baguette" })).toHaveLength(0);
  });
});
