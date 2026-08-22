import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../infra/prisma/prisma.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { OutboxRelay } from "./outbox-relay.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const OWNER = "d1000000-0000-4000-8000-000000000001";
const STORE = "d1000000-0000-4000-8000-00000000000a";

let prisma: PrismaService;
let outbox: OutboxService;
let relay: OutboxRelay;

/** Records what the relay published instead of reaching Redis. */
const published: { channel: string; message: string }[] = [];

beforeAll(() => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  outbox = new OutboxService(prisma);

  relay = new OutboxRelay(prisma, {
    get: () => "redis://localhost:6379",
  } as never);

  // Swap the Redis publisher for a recorder. The relay's contract is "each
  // unpublished row is published once, in order, then marked" — provable
  // without a broker, and the broker is not what this test is about.
  (relay as unknown as { publisher: unknown }).publisher = {
    publish: async (channel: string, message: string) => {
      published.push({ channel, message });
      return 1;
    },
    quit: async () => "OK",
  };
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await seed();
  published.length = 0;
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
      INSERT INTO users (id,email,name,status,created_at,updated_at)
      VALUES (${OWNER},'outbox-owner@example.com'::citext,'Owner','ACTIVE',now(),now())`;
    await db.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                          branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'outbox-store'::citext,'Outbox Store','RETAIL','ACTIVE',${OWNER},
              'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (db) => {
    await db.$executeRaw`DELETE FROM outbox_events WHERE store_id = ${STORE} OR store_id IS NULL`;
    await db.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await db.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
  });
}

/** Writes an event through the service, as domain code does. */
async function emit(type: string, payload: Record<string, unknown> = {}): Promise<void> {
  await prisma.withTenant({ storeId: STORE, isSuperAdmin: false }, (tx) =>
    outbox.emitIn(tx, { type, storeId: STORE, aggregateId: "agg-1", payload }),
  );
}

/**
 * What the relay published *for this store*.
 *
 * The relay is global by design: it drains every unpublished row in the
 * database, which is the whole point of it. So `published` also collects
 * whatever else happened to be pending — another suite's events, or an order
 * somebody placed by hand against the shared dev database — and asserting on
 * the raw list makes this file fail for reasons that have nothing to do with
 * the relay. It did exactly that, with "expected 2 to be 1".
 *
 * The same reasoning as the expiry-sweeper tests in `orders.service.test.ts`:
 * assert on the rows this test created, not on a total the test does not own.
 */
function mine(): { type: string; storeId: string | null; payload: Record<string, unknown> }[] {
  return published
    .map((p) => JSON.parse(p.message) as { type: string; storeId: string | null; payload: Record<string, unknown> })
    .filter((event) => event.storeId === STORE);
}

async function readRows() {
  return asAdmin((db) =>
    db.$queryRaw<{ type: string; published_at: Date | null; attempts: number }[]>`
      SELECT type, published_at, attempts FROM outbox_events
      WHERE store_id = ${STORE} ORDER BY id`,
  );
}

describe("writing events", () => {
  it("lets a store-scoped transaction write its own event", async () => {
    // Checkout runs scoped to the store, not as the platform. If the policy
    // required super-admin to insert, every order would fail to emit.
    await emit("order.created", { orderNumber: "OUT-1" });

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.published_at).toBeNull();
  });

  it("rolls the event back with the transaction that wrote it", async () => {
    // The entire point of an outbox. An event describing a change that never
    // committed would tell staff about work that does not exist.
    await prisma
      .withTenant({ storeId: STORE, isSuperAdmin: false }, async (tx) => {
        await outbox.emitIn(tx, {
          type: "order.created",
          storeId: STORE,
          payload: { orderNumber: "DOOMED" },
        });
        throw new Error("the domain operation failed");
      })
      .catch(() => undefined);

    expect(await readRows()).toHaveLength(0);
  });
});

describe("relaying", () => {
  it("publishes an unpublished event and marks it", async () => {
    await emit("order.created", { orderNumber: "OUT-1" });

    const count = await relay.runOnce();

    // At least ours: the return is a count of everything the pass drained.
    expect(count).toBeGreaterThanOrEqual(1);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ type: "order.created", storeId: STORE });
    expect((await readRows())[0]!.published_at).not.toBeNull();
  });

  it("publishes each event exactly once across repeated passes", async () => {
    // The relay runs every second forever; re-publishing on each pass would
    // make every screen flicker and every downstream consumer duplicate work.
    await emit("order.created");

    await relay.runOnce();
    await relay.runOnce();
    await relay.runOnce();

    expect(mine()).toHaveLength(1);
  });

  it("publishes in the order the events happened", async () => {
    // "Confirmed" arriving before "placed" would show staff nonsense.
    await emit("order.created", { seq: 1 });
    await emit("order.status_changed", { seq: 2 });
    await emit("order.payment_recorded", { seq: 3 });

    await relay.runOnce();

    expect(mine().map((event) => event.type)).toEqual([
      "order.created",
      "order.status_changed",
      "order.payment_recorded",
    ]);
  });

  it("does nothing when there is nothing to publish", async () => {
    // Scoped to this store rather than asserting the pass drained nothing at
    // all: the relay is global, so an unrelated pending row elsewhere would
    // make a zero-total assertion fail without saying anything about this.
    await relay.runOnce();

    expect(mine()).toHaveLength(0);
  });

  it("carries the payload through untouched", async () => {
    await emit("order.created", { orderNumber: "OUT-9", status: "PENDING", orderId: "abc" });

    await relay.runOnce();

    expect(mine()[0]!.payload).toEqual({
      orderNumber: "OUT-9",
      status: "PENDING",
      orderId: "abc",
    });
  });
});

describe("failure handling", () => {
  it("leaves an event unpublished and counts the attempt when publishing fails", async () => {
    await emit("order.created");
    const original = (relay as unknown as { publisher: { publish: unknown } }).publisher.publish;
    (relay as unknown as { publisher: { publish: unknown } }).publisher.publish = async () => {
      throw new Error("redis is down");
    };

    const count = await relay.runOnce();

    expect(count).toBe(0);
    const rows = await readRows();
    // Still pending, so it goes out when Redis comes back — the event is not
    // lost just because the broker was.
    expect(rows[0]!.published_at).toBeNull();
    expect(rows[0]!.attempts).toBe(1);

    (relay as unknown as { publisher: { publish: unknown } }).publisher.publish = original;
  });

  it("publishes the rest of the batch when one event fails", async () => {
    // One unpublishable row must not hold up everything behind it.
    await emit("order.created", { seq: 1 });
    await emit("order.status_changed", { seq: 2 });

    // Fails one identified event rather than "whichever call comes first".
    // The pass drains every pending row in the database, so a first-call rule
    // sabotages whatever happened to be at the front of the queue — which on a
    // shared dev database is often not this test's event at all.
    const original = (relay as unknown as { publisher: { publish: unknown } }).publisher.publish;
    (relay as unknown as { publisher: { publish: unknown } }).publisher.publish = async (
      _c: string,
      m: string,
    ) => {
      const event = JSON.parse(m) as { storeId: string | null; payload: { seq?: number } };
      if (event.storeId === STORE && event.payload.seq === 1) throw new Error("transient");
      published.push({ channel: "x", message: m });
      return 1;
    };

    const count = await relay.runOnce();

    expect(count).toBeGreaterThanOrEqual(1);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.type).toBe("order.status_changed");

    (relay as unknown as { publisher: { publish: unknown } }).publisher.publish = original;
  });

  it("retries a previously failed event on the next pass", async () => {
    await emit("order.created");
    const original = (relay as unknown as { publisher: { publish: unknown } }).publisher.publish;
    (relay as unknown as { publisher: { publish: unknown } }).publisher.publish = async () => {
      throw new Error("down");
    };
    await relay.runOnce();

    (relay as unknown as { publisher: { publish: unknown } }).publisher.publish = original;
    const count = await relay.runOnce();

    expect(count).toBeGreaterThanOrEqual(1);
    expect((await readRows())[0]!.published_at).not.toBeNull();
  });

  it("counts events parked after too many failures", async () => {
    await emit("order.created");
    await asAdmin((db) =>
      db.$executeRaw`UPDATE outbox_events SET attempts = 10 WHERE store_id = ${STORE}`,
    );

    // Skipped rather than retried forever: one poisonous row must not block
    // every event behind it. Asserted as "ours was not published" rather than
    // "nothing was", since the pass also drains unrelated rows.
    await relay.runOnce();

    expect(mine()).toHaveLength(0);
    expect((await readRows())[0]!.published_at).toBeNull();
    expect(await relay.deadLettered()).toBeGreaterThanOrEqual(1);
  });
});
