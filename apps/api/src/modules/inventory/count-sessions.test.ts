import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { CountSessions } from "./count-sessions.service.js";
import { InventoryService } from "./inventory.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "fc000000-0000-4000-8000-00000000000a";
const OWNER = "fc000000-0000-4000-8000-000000000001";
const PRODUCT = "fc000000-0000-4000-8000-000000000010";
const VARIANT = "fc000000-0000-4000-8000-000000000011";
const OTHER = "fc000000-0000-4000-8000-000000000012";

let prisma: PrismaService;
let counts: CountSessions;
let inventory: InventoryService;

beforeEach(async () => {
  prisma = prisma ?? new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  counts = new CountSessions(prisma, new AuditService(prisma));
  inventory = new InventoryService(prisma, new AuditService(prisma));
  await reset();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function asAdmin<T>(work: (a: PrismaService) => Promise<T>): Promise<T> {
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
      VALUES (${OWNER},'count-owner@example.com'::citext,'Cora','ACTIVE',now(),now())`;
    await a.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                          branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'count-store'::citext,'Count Store','RETAIL','ACTIVE',${OWNER},
              'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    await a.$executeRaw`
      INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
      VALUES (${PRODUCT},${STORE},'Baguette','baguette-count'::citext,'ACTIVE',now(),now())`;
    for (const [id, sku] of [[VARIANT, "BAG-1"], [OTHER, "BAG-2"]] as const) {
      await a.$executeRaw`
        INSERT INTO product_variants (id,store_id,product_id,attrs,sku,price_cents,is_default,created_at,updated_at)
        VALUES (${id},${STORE},${PRODUCT},'{}'::jsonb,${sku},375,${id === VARIANT},now(),now())`;
    }
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (a) => {
    await a.$executeRaw`DELETE FROM count_lines WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM count_sessions WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM stock_movements WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM stock_levels WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await a.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
  });
}

async function onHand(variantId = VARIANT): Promise<number> {
  const [row] = await asAdmin(
    (a) => a.$queryRaw<{ on_hand: number }[]>`
      SELECT COALESCE(on_hand, 0) AS on_hand FROM stock_levels WHERE variant_id = ${variantId}`,
  );
  return row?.on_hand ?? 0;
}

describe("opening a count", () => {
  it("allows only one at a time", async () => {
    await counts.open(STORE, OWNER, "Monday count");

    // Two people counting the same shop produce two sets of variances against
    // the same stock, and posting both applies the difference twice.
    await expect(counts.open(STORE, OWNER, "Another")).rejects.toThrow(/already open/);
  });

  it("lets a new one start once the last is finished", async () => {
    const first = await counts.open(STORE, OWNER, "Monday");
    await counts.abandon(STORE, first.id, OWNER);

    const second = await counts.open(STORE, OWNER, "Tuesday");
    expect(second.status).toBe("OPEN");
  });

  it("is what `current` reports, and nothing once closed", async () => {
    const session = await counts.open(STORE, OWNER, "Monday");
    expect((await counts.current(STORE))?.id).toBe(session.id);

    await counts.abandon(STORE, session.id, OWNER);
    expect(await counts.current(STORE)).toBeNull();
  });
});

describe("entering counts", () => {
  it("records what was expected at the moment of counting", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 20 });
    const session = await counts.open(STORE, OWNER, "Monday");

    const line = await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 18 });

    expect(line.expected_qty).toBe(20);
    expect(line.counted_qty).toBe(18);
    expect(line.variance).toBe(-2);
  });

  it("corrects a re-count rather than adding to it", async () => {
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 5 });

    // Walking back to re-check a shelf is normal, and the second look is the
    // better one.
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 7 });

    const lines = await counts.lines(STORE, session.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.counted_qty).toBe(7);
  });

  it("moves no stock while the count is open", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 20 });
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 3 });

    // Nothing is applied until posting: a session can be abandoned at any
    // point and the ledger will not have been touched.
    expect(await onHand()).toBe(20);
  });

  it("refuses a negative count and an unknown variant", async () => {
    const session = await counts.open(STORE, OWNER, "Monday");
    await expect(
      counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: -1 }),
    ).rejects.toThrow();
    await expect(
      counts.enter(STORE, session.id, OWNER, {
        variantId: "fc000000-0000-4000-8000-0000000000ff",
        countedQty: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("drops a line entered against the wrong shelf", async () => {
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 5 });
    await counts.removeLine(STORE, session.id, VARIANT);

    expect(await counts.lines(STORE, session.id)).toHaveLength(0);
  });
});

describe("posting a count", () => {
  it("applies each variance as a COUNT movement", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 20 });
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 18 });

    const result = await counts.post(STORE, session.id, OWNER);

    expect(result).toMatchObject({ applied: 1, unchanged: 0, netUnits: -2 });
    // The counted number becomes true, and the difference is attributable.
    expect(await onHand()).toBe(18);

    const [movement] = await inventory.movements(STORE, VARIANT);
    expect(movement).toMatchObject({ type: "COUNT", qty_delta: -2, reason_code: "COUNT" });
    expect(movement!.note).toContain("Monday");
  });

  it("writes nothing for a shelf that was right", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 12 });
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 12 });

    const result = await counts.post(STORE, session.id, OWNER);

    // A count where everything matched should leave the ledger exactly as it
    // found it, not a hundred zero-quantity entries.
    expect(result).toMatchObject({ applied: 0, unchanged: 1, netUnits: 0 });
    expect(await inventory.movements(STORE, VARIANT)).toHaveLength(1);
  });

  /**
   * The reason expected is captured at entry rather than recomputed. A sale
   * during the count moves stock on its own; folding that into the variance
   * would blame the person holding the clipboard for it.
   */
  it("does not absorb a sale made during the count", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 20 });
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 20 });

    // Someone buys three while the count is still open.
    await inventory.adjust(STORE, OWNER, { variantId: VARIANT, qtyDelta: -3, reason: "OTHER" });
    expect(await onHand()).toBe(17);

    const result = await counts.post(STORE, session.id, OWNER);

    // The shelf agreed when it was counted, so the count contributes nothing
    // and the sale stands on its own.
    expect(result.applied).toBe(0);
    expect(await onHand()).toBe(17);
  });

  it("handles several lines, up and down", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 10 });
    await inventory.receive(STORE, OWNER, { variantId: OTHER, qty: 4 });
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 8 });
    await counts.enter(STORE, session.id, OWNER, { variantId: OTHER, countedQty: 6 });

    const result = await counts.post(STORE, session.id, OWNER);

    expect(result).toMatchObject({ applied: 2, netUnits: 0 });
    expect(await onHand(VARIANT)).toBe(8);
    expect(await onHand(OTHER)).toBe(6);
  });

  it("cannot be posted twice", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 10 });
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 7 });
    await counts.post(STORE, session.id, OWNER);

    await expect(counts.post(STORE, session.id, OWNER)).rejects.toThrow(/already been finished/);
    // And the stock did not move a second time.
    expect(await onHand()).toBe(7);
  });

  it("takes no further entries once posted", async () => {
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.post(STORE, session.id, OWNER);

    await expect(
      counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 1 }),
    ).rejects.toThrow(/already been finished/);
  });
});

describe("abandoning a count", () => {
  it("leaves stock untouched but keeps what was entered", async () => {
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 20 });
    const session = await counts.open(STORE, OWNER, "Monday");
    await counts.enter(STORE, session.id, OWNER, { variantId: VARIANT, countedQty: 2 });

    await counts.abandon(STORE, session.id, OWNER);

    expect(await onHand()).toBe(20);
    // The attempt is still a fact worth keeping.
    expect(await counts.lines(STORE, session.id)).toHaveLength(1);
    expect((await counts.get(STORE, session.id)).status).toBe("ABANDONED");
  });
});
