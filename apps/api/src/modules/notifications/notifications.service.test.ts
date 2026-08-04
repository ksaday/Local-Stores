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
    await a.$executeRaw`DELETE FROM notifications WHERE user_id = ANY(${[CUSTOMER, OWNER]})`;
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

/** What landed in the customer's inbox. */
async function inbox() {
  return notifications.inbox(CUSTOMER);
}

describe("telling a customer about their order", () => {
  it("writes to them, naming the shop rather than the platform", async () => {
    const orderId = await makeOrder();

    expect(await notifications.notifyOrder("order.placed", STORE, orderId)).toBe(true);

    const [item] = await inbox();
    // Nothing left the building: this is a row in their inbox, not a message
    // handed to somebody else's mail server (ADR 0001).
    expect(mailer.sent).toHaveLength(0);
    // A customer buying from four local shops should be able to tell them
    // apart, which is what the shop name and store_id are for.
    expect(item!.title).toContain("Morse Ave Bakery");
    expect(item!.store_name).toBe("Morse Ave Bakery");
    expect(item!.body).toContain("$17.50");
    // The address goes in the link, not the prose: there is a button for it,
    // and a pasted URL underneath is a habit from email.
    expect(item!.body).not.toContain("http");
    expect(item!.link).toBe(`/orders/${orderId}`);
    expect(item!.read_at).toBeNull();
  });

  it("says 'packed' rather than 'ready' for a delivery order", async () => {
    // READY on a delivery order means it is waiting for a driver. Telling the
    // customer it is "ready" would read as "come and get it".
    const orderId = await makeOrder({ fulfillment: "DELIVERY" });

    await notifications.notifyOrder("order.ready", STORE, orderId);

    const [item] = await inbox();
    expect(item!.title).toContain("packed");
    expect(item!.body).toContain("waiting for a driver");
  });

  it("says plainly what happens to the money when an order is cancelled", async () => {
    const orderId = await makeOrder();

    await notifications.notifyOrder("order.cancelled", STORE, orderId);

    expect((await inbox())[0]!.body).toMatch(/refunded to the card you used/);
  });

  it("stays quiet for a guest, who has no inbox", async () => {
    // A guest checkout has no account to write to. They follow their order by
    // the claim link on their receipt instead, and that is not a failure.
    const orderId = await makeOrder({ customerId: null });

    expect(await notifications.notifyOrder("order.placed", STORE, orderId)).toBe(false);
    expect(await inbox()).toHaveLength(0);
  });
});

describe("the inbox", () => {
  it("counts what has not been read, and stops counting once it has", async () => {
    await notifications.notifyOrder("order.placed", STORE, await makeOrder());
    await notifications.notifyOrder("order.ready", STORE, await makeOrder());
    expect(await notifications.unreadCount(CUSTOMER)).toBe(2);

    const [first] = await inbox();
    await notifications.markRead(CUSTOMER, first!.id);
    expect(await notifications.unreadCount(CUSTOMER)).toBe(1);

    await notifications.markRead(CUSTOMER);
    expect(await notifications.unreadCount(CUSTOMER)).toBe(0);
  });

  it("filters to unread on request", async () => {
    await notifications.notifyOrder("order.placed", STORE, await makeOrder());
    await notifications.notifyOrder("order.ready", STORE, await makeOrder());
    const [first] = await inbox();
    await notifications.markRead(CUSTOMER, first!.id);

    expect(await notifications.inbox(CUSTOMER, { unreadOnly: true })).toHaveLength(1);
    expect(await notifications.inbox(CUSTOMER)).toHaveLength(2);
  });

  it("shows nobody else's", async () => {
    // The owner and the customer are different people, and an inbox is
    // personal — RLS says so too.
    await notifications.notifyOrder("order.placed", STORE, await makeOrder());

    expect(await notifications.inbox(OWNER)).toHaveLength(0);
    expect(await notifications.unreadCount(OWNER)).toBe(0);
  });
});

describe("preferences", () => {
  it("sends when nobody has expressed a preference", async () => {
    // Absence of a row means the default, which is on — storing every default
    // would mean a row per user per event at signup.
    const orderId = await makeOrder();

    expect(await notifications.wants(CUSTOMER, STORE, "order.placed", "IN_APP")).toBe(true);
    expect(await notifications.notifyOrder("order.placed", STORE, orderId)).toBe(true);
  });

  it("honours a switch-off", async () => {
    await notifications.setPreference(CUSTOMER, {
      event: "order.placed",
      channel: "IN_APP",
      enabled: false,
    });
    const orderId = await makeOrder();

    expect(await notifications.notifyOrder("order.placed", STORE, orderId)).toBe(false);
    expect(await inbox()).toHaveLength(0);
  });

  it("lets a per-shop choice beat a blanket one", async () => {
    // Somebody who wants none of this except from their local bakery.
    await notifications.setPreference(CUSTOMER, {
      event: "order.placed",
      channel: "IN_APP",
      enabled: false,
    });
    await notifications.setPreference(CUSTOMER, {
      event: "order.placed",
      channel: "IN_APP",
      storeId: STORE,
      enabled: true,
    });

    expect(await notifications.wants(CUSTOMER, STORE, "order.placed", "IN_APP")).toBe(true);
    expect(await notifications.wants(CUSTOMER, OTHER_STORE, "order.placed", "IN_APP")).toBe(false);
  });

  it("changes an existing choice rather than stacking another", async () => {
    await notifications.setPreference(CUSTOMER, {
      event: "order.ready",
      channel: "IN_APP",
      enabled: false,
    });
    await notifications.setPreference(CUSTOMER, {
      event: "order.ready",
      channel: "IN_APP",
      enabled: true,
    });

    const prefs = await notifications.preferencesFor(CUSTOMER);
    expect(prefs.filter((p) => p.event === "order.ready")).toHaveLength(1);
    expect(await notifications.wants(CUSTOMER, STORE, "order.ready", "IN_APP")).toBe(true);
  });

  it("refuses to switch off something the account depends on", async () => {
    // A switch that does nothing is worse than no switch, so this is a refusal
    // rather than a preference silently ignored at send time.
    await expect(
      notifications.setPreference(CUSTOMER, {
        event: "order.cancelled",
        channel: "IN_APP",
        enabled: false,
      }),
    ).rejects.toThrow();

    const orderId = await makeOrder();
    expect(await notifications.notifyOrder("order.cancelled", STORE, orderId)).toBe(true);
  });

  it("treats somebody with no account as having no objection", async () => {
    // There are no preferences to consult without an account. Nothing is
    // written either — see the guest case above — but the decision itself
    // must not be "no" for want of a row.
    expect(await notifications.wants(null, STORE, "order.placed", "IN_APP")).toBe(true);
  });
});
