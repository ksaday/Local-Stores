import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "./inventory.service.js";
import { LowStockAlerts } from "./low-stock-alerts.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "fb000000-0000-4000-8000-00000000000a";
const OWNER = "fb000000-0000-4000-8000-000000000001";
const MANAGER = "fb000000-0000-4000-8000-000000000002";
const CLERK = "fb000000-0000-4000-8000-000000000003";
const PRODUCT = "fb000000-0000-4000-8000-000000000010";
const VARIANT = "fb000000-0000-4000-8000-000000000011";

const config = { get: () => "http://localhost:3100" } as never;

let prisma: PrismaService;
let inventory: InventoryService;
let notifications: NotificationsService;
let alerts: LowStockAlerts;

beforeEach(async () => {
  prisma = prisma ?? new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  inventory = new InventoryService(prisma, new AuditService(prisma));
  notifications = new NotificationsService(prisma, { send: async () => {} } as never, config);
  alerts = new LowStockAlerts(prisma, inventory, notifications, config);
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
    for (const [id, email, name] of [
      [OWNER, "ls-owner@example.com", "Olive Owner"],
      [MANAGER, "ls-manager@example.com", "Mo Manager"],
      [CLERK, "ls-clerk@example.com", "Cal Clerk"],
    ] as const) {
      await a.$executeRaw`
        INSERT INTO users (id,email,name,status,created_at,updated_at)
        VALUES (${id},${email}::citext,${name},'ACTIVE',now(),now())`;
    }
    await a.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                          branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'ls-store'::citext,'Low Stock Bakery','RETAIL','ACTIVE',${OWNER},
              'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    for (const [user, role] of [
      [MANAGER, "INVENTORY_MANAGER"],
      [CLERK, "CLERK"],
    ] as const) {
      await a.$executeRaw`
        INSERT INTO store_memberships (id,store_id,user_id,role,status,created_at,updated_at)
        VALUES (gen_random_uuid(),${STORE},${user},${role}::"MembershipRole",'ACTIVE',now(),now())`;
    }
    await a.$executeRaw`
      INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
      VALUES (${PRODUCT},${STORE},'Rye Bread','rye-bread'::citext,'ACTIVE',now(),now())`;
    await a.$executeRaw`
      INSERT INTO product_variants (id,store_id,product_id,attrs,sku,price_cents,is_default,created_at,updated_at)
      VALUES (${VARIANT},${STORE},${PRODUCT},'{"size":"Large"}'::jsonb,'RYE-1',650,true,now(),now())`;
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (a) => {
    await a.$executeRaw`DELETE FROM notifications WHERE user_id = ANY(${[OWNER, MANAGER, CLERK]})`;
    await a.$executeRaw`DELETE FROM stock_movements WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM stock_levels WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await a.$executeRaw`DELETE FROM users WHERE id = ANY(${[OWNER, MANAGER, CLERK]})`;
  });
}

/**
 * What this store's people were told.
 *
 * Filtered rather than counted whole: the sweep looks at every store in the
 * database, and other suites (and the seeded development shop) legitimately
 * have low stock too. Asserting on a global total makes this suite fail for
 * reasons that have nothing to do with it.
 */
async function mine() {
  const rows = await asAdmin(
    (a) => a.$queryRaw<{ user_id: string; title: string; body: string; link: string | null }[]>`
      SELECT user_id, title, body, link FROM notifications
      WHERE user_id = ANY(${[OWNER, MANAGER, CLERK]}) ORDER BY created_at`,
  );
  return rows;
}


/** Puts the one tracked line below its reorder point. */
async function makeLow(): Promise<void> {
  await inventory.setTracking(STORE, OWNER, VARIANT, {
    tracked: true,
    reorderPoint: 10,
    reorderQty: 40,
  });
  await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 3 });
}

describe("low-stock alerts", () => {
  it("writes to the people who can actually order more", async () => {
    await makeLow();

    await alerts.run();

    const told = (await mine()).map((m) => m.user_id).sort();
    // The owner and the inventory manager. Not the clerk — being able to sell
    // a loaf is not being able to order more of them.
    expect(told).toEqual([OWNER, MANAGER].sort());
  });

  it("says what is left, what triggered it, and how many to order", async () => {
    await makeLow();
    await alerts.run();

    const body = (await mine())[0]!.body;
    expect(body).toContain("Rye Bread");
    expect(body).toContain("Large");
    expect(body).toContain("RYE-1");
    // Judgeable without opening anything.
    expect(body).toMatch(/3 left, reorder at 10/);
    expect(body).toContain("usually order 40");
    expect(body).toContain(`/store/${STORE}/ops/inventory`);
  });

  it("says nothing when nothing is low", async () => {
    await inventory.setTracking(STORE, OWNER, VARIANT, { tracked: true, reorderPoint: 10 });
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 50 });

    await alerts.run();
    expect(await mine()).toHaveLength(0);
  });

  it("ignores lines nobody asked it to track", async () => {
    // Untracked and at zero. A made-to-order line must not generate mail.
    await inventory.setTracking(STORE, OWNER, VARIANT, { tracked: false, reorderPoint: 10 });

    await alerts.run();
    expect(await mine()).toHaveLength(0);
  });

  it("leaves a suspended shop alone", async () => {
    await makeLow();
    await asAdmin((a) => a.$executeRaw`
      UPDATE stores SET status = 'SUSPENDED' WHERE id = ${STORE}`);

    // A shop that has been taken offline is not reordering anything, and the
    // owner has a more pressing email already.
    await alerts.run();
    expect(await mine()).toHaveLength(0);
  });

  it("counts stock promised to orders as gone", async () => {
    await inventory.setTracking(STORE, OWNER, VARIANT, { tracked: true, reorderPoint: 10 });
    await inventory.receive(STORE, OWNER, { variantId: VARIANT, qty: 12 });
    await alerts.run();
    expect(await mine()).toHaveLength(0);

    // Twelve on the shelf, but eight are spoken for: four are sellable, which
    // is under the line.
    await asAdmin((a) => a.$executeRaw`
      UPDATE stock_levels SET reserved = 8 WHERE variant_id = ${VARIANT}`);

    await alerts.run();
    expect((await mine())[0]!.body).toMatch(/4 left/);
  });

  it("one digest per store, however many lines are low", async () => {
    await makeLow();
    const second = "fb000000-0000-4000-8000-000000000012";
    await asAdmin((a) => a.$executeRaw`
      INSERT INTO product_variants (id,store_id,product_id,attrs,sku,price_cents,is_default,created_at,updated_at)
      VALUES (${second},${STORE},${PRODUCT},'{"size":"Small"}'::jsonb,'RYE-2',450,false,now(),now())`);
    await inventory.setTracking(STORE, OWNER, second, { tracked: true, reorderPoint: 5 });

    await alerts.run();

    // Two recipients, one message each — not one per low line.
    const told = await mine();
    expect(told).toHaveLength(2);
    expect(told[0]!.title).toContain("2 items");
  });
});
