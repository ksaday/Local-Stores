import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { OrdersService } from "../orders/orders.service.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { DeliveryService } from "./delivery.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "fd000000-0000-4000-8000-00000000000a";
const ADMIN = "fd000000-0000-4000-8000-000000000001";
const DRIVER = "fd000000-0000-4000-8000-000000000002";
const OTHER_DRIVER = "fd000000-0000-4000-8000-000000000003";
const CLERK = "fd000000-0000-4000-8000-000000000004";

let prisma: PrismaService;
let delivery: DeliveryService;

beforeEach(async () => {
  prisma = prisma ?? new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  const audit = new AuditService(prisma);
  const orders = new OrdersService(prisma, audit, new OutboxService(prisma));
  delivery = new DeliveryService(prisma, orders, audit);
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
      [ADMIN, "dl-admin@example.com", "Ada Admin"],
      [DRIVER, "dl-driver@example.com", "Dev Driver"],
      [OTHER_DRIVER, "dl-driver2@example.com", "Dot Driver"],
      [CLERK, "dl-clerk@example.com", "Cal Clerk"],
    ] as const) {
      await a.$executeRaw`
        INSERT INTO users (id,email,name,status,created_at,updated_at)
        VALUES (${id},${email}::citext,${name},'ACTIVE',now(),now())`;
    }
    await a.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                          branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'dl-store'::citext,'Delivery Store','RETAIL','ACTIVE',${ADMIN},
              'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    for (const [user, role] of [
      [ADMIN, "STORE_ADMIN"],
      [DRIVER, "DELIVERY"],
      [OTHER_DRIVER, "DELIVERY"],
      [CLERK, "CLERK"],
    ] as const) {
      await a.$executeRaw`
        INSERT INTO store_memberships (id,store_id,user_id,role,status,created_at,updated_at)
        VALUES (gen_random_uuid(),${STORE},${user},${role}::"MembershipRole",'ACTIVE',now(),now())`;
    }
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (a) => {
    await a.$executeRaw`DELETE FROM deliveries WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM order_status_history WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM outbox_events WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM orders WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await a.$executeRaw`DELETE FROM users WHERE id = ANY(${[ADMIN, DRIVER, OTHER_DRIVER, CLERK]})`;
  });
}

/** A delivery order sitting on the shelf, ready to go out. */
async function readyOrder(number = "DL-1"): Promise<string> {
  const id = randomUUID();
  await asAdmin((a) => a.$executeRaw`
    INSERT INTO orders (id,store_id,order_number,fulfillment,status,contact_phone,
                        delivery_address,subtotal_cents,total_cents,currency,placed_at,created_at,updated_at)
    VALUES (${id},${STORE},${number},'DELIVERY','READY','+1 773 555 0142',
            '{"line1":"1423 W Morse Ave","city":"Chicago"}'::jsonb,
            1000,1000,'USD',now(),now(),now())`);
  return id;
}

async function orderStatus(orderId: string): Promise<string> {
  const [row] = await asAdmin(
    (a) => a.$queryRaw<{ status: string }[]>`
      SELECT status::text FROM orders WHERE id = ${orderId}`,
  );
  return row!.status;
}

describe("the dispatch board", () => {
  it("picks up delivery orders that are ready, without anyone creating a record", async () => {
    const orderId = await readyOrder();

    // Records are made lazily: checkout should not write rows for a workflow
    // that may never start.
    const board = await delivery.board(STORE);

    expect(board.map((d) => d.order_id)).toContain(orderId);
    expect(board[0]!.driver_user_id).toBeNull();
    // The phone number, because that is what a driver reaches for when
    // nobody answers the door.
    expect(board[0]!.contact_phone).toBe("+1 773 555 0142");
  });

  it("leaves collection orders off it", async () => {
    await asAdmin((a) => a.$executeRaw`
      INSERT INTO orders (id,store_id,order_number,fulfillment,status,subtotal_cents,
                          total_cents,currency,placed_at,created_at,updated_at)
      VALUES (${randomUUID()},${STORE},'PU-1','PICKUP','READY',500,500,'USD',now(),now(),now())`);

    const board = await delivery.board(STORE);
    expect(board).toHaveLength(0);
  });
});

describe("assigning a driver", () => {
  it("puts the order on that driver's round", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);

    const row = await delivery.assign(STORE, orderId, ADMIN, DRIVER);

    expect(row.driver_user_id).toBe(DRIVER);
    // Resolved as the platform: a driver has no membership visible to a
    // store-scoped read of `users` until they accept their invitation.
    expect(row.driver_name).toBe("Dev Driver");

    const mine = await delivery.queueFor(STORE, DRIVER);
    expect(mine.map((d) => d.order_id)).toEqual([orderId]);
    expect(await delivery.queueFor(STORE, OTHER_DRIVER)).toHaveLength(0);
  });

  it("refuses somebody who does not drive for this shop", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);

    await expect(delivery.assign(STORE, orderId, ADMIN, CLERK)).rejects.toThrow(
      /isn't set up to make deliveries/,
    );
  });

  it("hands a round over when somebody goes home", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);

    await delivery.assign(STORE, orderId, ADMIN, OTHER_DRIVER);

    expect(await delivery.queueFor(STORE, DRIVER)).toHaveLength(0);
    expect(await delivery.queueFor(STORE, OTHER_DRIVER)).toHaveLength(1);
  });
});

describe("taking it out", () => {
  it("moves the order through the real state machine", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);

    await delivery.pickUp(STORE, orderId, DRIVER);

    // The order's own status stays the single answer to "where is this".
    expect(await orderStatus(orderId)).toBe("OUT_FOR_DELIVERY");
    expect((await delivery.one(STORE, orderId)).picked_up_at).not.toBeNull();
  });

  it("will not let a driver move somebody else's parcel", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);

    await expect(delivery.pickUp(STORE, orderId, OTHER_DRIVER)).rejects.toMatchObject({
      status: 403,
    });
    expect(await orderStatus(orderId)).toBe("READY");
  });

  it("lets a store admin close out a round the driver left open", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);

    await delivery.pickUp(STORE, orderId, ADMIN);
    expect(await orderStatus(orderId)).toBe("OUT_FOR_DELIVERY");
  });
});

describe("handing it over", () => {
  it("marks it delivered and keeps the proof", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);
    await delivery.pickUp(STORE, orderId, DRIVER);

    const row = await delivery.complete(STORE, orderId, DRIVER, { notes: "Left with neighbour" });

    expect(await orderStatus(orderId)).toBe("DELIVERED");
    expect(row.delivered_at).not.toBeNull();
    expect(row.notes).toBe("Left with neighbour");
    // Off the board and off the round once it is done.
    expect(await delivery.board(STORE)).toHaveLength(0);
    expect(await delivery.queueFor(STORE, DRIVER)).toHaveLength(0);
  });
});

describe("coming back with it", () => {
  it("returns the order to READY and counts the attempt", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);
    await delivery.pickUp(STORE, orderId, DRIVER);

    const row = await delivery.fail(STORE, orderId, DRIVER, {
      reason: "NOBODY_HOME",
      note: "No answer, no safe place",
    });

    // READY is the state machine's own answer: it is prepared, it is back in
    // the shop, and somebody will take it out again.
    expect(await orderStatus(orderId)).toBe("READY");
    expect(row.failure_reason).toBe("NOBODY_HOME");
    expect(row.attempts).toBe(1);
    expect(row.picked_up_at).toBeNull();
    // Still on the board — it has not been delivered.
    expect(await delivery.board(STORE)).toHaveLength(1);
  });

  it("counts repeat attempts, so a pattern is visible", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);

    for (let i = 0; i < 3; i += 1) {
      await delivery.pickUp(STORE, orderId, DRIVER);
      await delivery.fail(STORE, orderId, DRIVER, { reason: "NOBODY_HOME" });
    }

    expect((await delivery.one(STORE, orderId)).attempts).toBe(3);
  });

  it("clears the failure once it finally gets there", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);
    await delivery.pickUp(STORE, orderId, DRIVER);
    await delivery.fail(STORE, orderId, DRIVER, { reason: "NOBODY_HOME" });

    await delivery.pickUp(STORE, orderId, DRIVER);
    const row = await delivery.complete(STORE, orderId, DRIVER);

    // A delivery that succeeded on the second attempt is not a failed
    // delivery, and leaving the reason behind would read as one.
    expect(row.failure_reason).toBeNull();
    // The attempt count stays: it is still true that somebody went twice.
    expect(row.attempts).toBe(1);
  });

  it("refuses a reason that is not one of the offered ones", async () => {
    const orderId = await readyOrder();
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);

    await expect(
      delivery.fail(STORE, orderId, DRIVER, { reason: "BAD_WEATHER" as never }),
    ).rejects.toThrow();
  });
});
