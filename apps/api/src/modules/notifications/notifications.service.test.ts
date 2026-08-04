import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryMailer } from "../../infra/mailer/mailer.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { NotificationsService } from "./notifications.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "fe000000-0000-4000-8000-00000000000a";
const OTHER_STORE = "fe000000-0000-4000-8000-00000000000b";
const OWNER = "fe000000-0000-4000-8000-000000000001";
const CUSTOMER = "fe000000-0000-4000-8000-000000000002";
const CUSTOMER_EMAIL = "shopper@example.com";

const config = { get: () => "http://localhost:3100" } as never;

let prisma: PrismaService;
let mailer: InMemoryMailer;
let notifications: NotificationsService;

beforeEach(async () => {
  prisma = prisma ?? new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  mailer = new InMemoryMailer();
  notifications = new NotificationsService(prisma, mailer, config);
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
      [OWNER, "notif-owner@example.com", "Otto Owner"],
      [CUSTOMER, CUSTOMER_EMAIL, "Sam Shopper"],
    ] as const) {
      await a.$executeRaw`
        INSERT INTO users (id,email,name,status,created_at,updated_at)
        VALUES (${id},${email}::citext,${name},'ACTIVE',now(),now())`;
    }
    for (const [id, slug, name] of [
      [STORE, "notif-store", "Morse Ave Bakery"],
      [OTHER_STORE, "notif-store-b", "Other Shop"],
    ] as const) {
      await a.$executeRaw`
        INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                            branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
        VALUES (${id},${slug}::citext,${name},'RETAIL','ACTIVE',${OWNER},
                'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    }
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (a) => {
    await a.$executeRaw`DELETE FROM notification_preferences WHERE user_id = ${CUSTOMER}`;
    await a.$executeRaw`DELETE FROM orders WHERE store_id = ANY(${[STORE, OTHER_STORE]})`;
    await a.$executeRaw`DELETE FROM stores WHERE id = ANY(${[STORE, OTHER_STORE]})`;
    await a.$executeRaw`DELETE FROM users WHERE id = ANY(${[OWNER, CUSTOMER]})`;
  });
}

async function makeOrder(
  opts: { storeId?: string; customerId?: string | null; email?: string | null; fulfillment?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const fulfillment = opts.fulfillment ?? "PICKUP";
  await asAdmin((a) => a.$executeRaw`
    INSERT INTO orders (id,store_id,order_number,fulfillment,status,customer_id,contact_email,
                        delivery_address,subtotal_cents,total_cents,currency,placed_at,created_at,updated_at)
    VALUES (${id},${opts.storeId ?? STORE},${`N-${id.slice(0, 6)}`},${fulfillment}::"Fulfillment",
            'READY',${opts.customerId === undefined ? CUSTOMER : opts.customerId},
            ${opts.email === undefined ? CUSTOMER_EMAIL : opts.email},
            ${fulfillment === "DELIVERY" ? '{"line1":"1 Test St"}' : null}::jsonb,
            1750,1750,'USD',now(),now(),now())`);
  return id;
}

describe("telling a customer about their order", () => {
  it("writes to them, naming the shop rather than the platform", async () => {
    const orderId = await makeOrder();

    expect(await notifications.notifyOrder("order.placed", STORE, orderId)).toBe(true);

    const [mail] = mailer.sent;
    expect(mail!.to).toBe(CUSTOMER_EMAIL);
    // A customer buying from four local shops should see four shops in their
    // inbox, not four instances of the same platform.
    expect(mail!.subject).toContain("Morse Ave Bakery");
    expect(mail!.body).toContain("$17.50");
    expect(mail!.body).toContain(`/orders/${orderId}`);
  });

  it("says 'packed' rather than 'ready' for a delivery order", async () => {
    // READY on a delivery order means it is waiting for a driver. Telling the
    // customer it is "ready" would read as "come and get it".
    const orderId = await makeOrder({ fulfillment: "DELIVERY" });

    await notifications.notifyOrder("order.ready", STORE, orderId);

    expect(mailer.sent[0]!.subject).toContain("packed");
    expect(mailer.sent[0]!.body).toContain("waiting for a driver");
  });

  it("says plainly what happens to the money when an order is cancelled", async () => {
    const orderId = await makeOrder();

    await notifications.notifyOrder("order.cancelled", STORE, orderId);

    expect(mailer.sent[0]!.body).toMatch(/refunded to the card you used/);
  });

  it("stays quiet when there is nobody to write to", async () => {
    // A counter sale has no email address, and that is not a failure.
    const orderId = await makeOrder({ email: null, customerId: null });

    expect(await notifications.notifyOrder("order.placed", STORE, orderId)).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("preferences", () => {
  it("sends when nobody has expressed a preference", async () => {
    // Absence of a row means the default, which is on — storing every default
    // would mean a row per user per event at signup.
    const orderId = await makeOrder();

    expect(await notifications.wants(CUSTOMER, STORE, "order.placed", "EMAIL")).toBe(true);
    expect(await notifications.notifyOrder("order.placed", STORE, orderId)).toBe(true);
  });

  it("honours a switch-off", async () => {
    await notifications.setPreference(CUSTOMER, {
      event: "order.placed",
      channel: "EMAIL",
      enabled: false,
    });
    const orderId = await makeOrder();

    expect(await notifications.notifyOrder("order.placed", STORE, orderId)).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("lets a per-shop choice beat a blanket one", async () => {
    // Somebody who wants none of this except from their local bakery.
    await notifications.setPreference(CUSTOMER, {
      event: "order.placed",
      channel: "EMAIL",
      enabled: false,
    });
    await notifications.setPreference(CUSTOMER, {
      event: "order.placed",
      channel: "EMAIL",
      storeId: STORE,
      enabled: true,
    });

    expect(await notifications.wants(CUSTOMER, STORE, "order.placed", "EMAIL")).toBe(true);
    expect(await notifications.wants(CUSTOMER, OTHER_STORE, "order.placed", "EMAIL")).toBe(false);
  });

  it("changes an existing choice rather than stacking another", async () => {
    await notifications.setPreference(CUSTOMER, {
      event: "order.ready",
      channel: "EMAIL",
      enabled: false,
    });
    await notifications.setPreference(CUSTOMER, {
      event: "order.ready",
      channel: "EMAIL",
      enabled: true,
    });

    const prefs = await notifications.preferencesFor(CUSTOMER);
    expect(prefs.filter((p) => p.event === "order.ready")).toHaveLength(1);
    expect(await notifications.wants(CUSTOMER, STORE, "order.ready", "EMAIL")).toBe(true);
  });

  it("refuses to switch off something the account depends on", async () => {
    // A switch that does nothing is worse than no switch, so this is a refusal
    // rather than a preference silently ignored at send time.
    await expect(
      notifications.setPreference(CUSTOMER, {
        event: "order.cancelled",
        channel: "EMAIL",
        enabled: false,
      }),
    ).rejects.toThrow();

    const orderId = await makeOrder();
    expect(await notifications.notifyOrder("order.cancelled", STORE, orderId)).toBe(true);
  });

  it("gives a guest the transactional minimum", async () => {
    // No account means no preferences to consult, and a guest still has to
    // hear that their order was cancelled.
    const orderId = await makeOrder({ customerId: null });

    expect(await notifications.wants(null, STORE, "order.placed", "EMAIL")).toBe(true);
    expect(await notifications.notifyOrder("order.placed", STORE, orderId)).toBe(true);
  });
});
