import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testNotifications } from "../../modules/notifications/test-notifications.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { LocalDiskStorage } from "../../infra/storage/storage.provider.js";
import { testStorage } from "../../infra/storage/test-storage.js";
import { AuditService } from "../audit/audit.service.js";
import { OrdersService } from "../orders/orders.service.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { DeliveryService } from "./delivery.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "fd000000-0000-4000-8000-00000000000a";
/** Somebody else's shop, so "belongs to this store" can be shown to mean it. */
const OTHER_STORE = "fd000000-0000-4000-8000-00000000000b";
const ADMIN = "fd000000-0000-4000-8000-000000000001";
const DRIVER = "fd000000-0000-4000-8000-000000000002";
const OTHER_DRIVER = "fd000000-0000-4000-8000-000000000003";
const CLERK = "fd000000-0000-4000-8000-000000000004";

let prisma: PrismaService;
let delivery: DeliveryService;
let storage: LocalDiskStorage;

beforeEach(async () => {
  prisma = prisma ?? new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  const audit = new AuditService(prisma);
  const orders = new OrdersService(prisma, audit, new OutboxService(prisma), testNotifications(prisma).notifications);
  storage = storage ?? new LocalDiskStorage(testStorage(mkdtempSync(join(tmpdir(), "bba-delivery-"))));
  delivery = new DeliveryService(prisma, orders, audit, storage);
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
    for (const [id, slug, name] of [
      [STORE, "dl-store", "Delivery Store"],
      [OTHER_STORE, "dl-other-store", "Somebody Else"],
    ] as const) {
      await a.$executeRaw`
        INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                            branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
        VALUES (${id},${slug}::citext,${name},'RETAIL','ACTIVE',${ADMIN},
                'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    }
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
    // After deliveries, which reference them.
    await a.$executeRaw`DELETE FROM media_assets WHERE store_id = ANY(${[STORE, OTHER_STORE]})`;
    await a.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${STORE}`;
    await a.$executeRaw`DELETE FROM stores WHERE id = ANY(${[STORE, OTHER_STORE]})`;
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

/**
 * A photograph the driver has already uploaded.
 *
 * Written straight to the table rather than through the upload pipeline: what
 * is under test here is what the delivery does with a finished asset, and the
 * three-step upload has its own suite.
 */
async function proofAsset(
  overrides: { storeId?: string; kind?: string; status?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const { storeId = STORE, kind = "PROOF", status = "READY" } = overrides;
  await asAdmin((a) => a.$executeRaw`
    INSERT INTO media_assets (id,store_id,owner_user_id,kind,status,storage_key,mime,bytes,
                              is_private,created_at,updated_at)
    VALUES (${id},${storeId},${DRIVER},${kind}::"MediaKind",${status}::"MediaStatus",
            ${`proof/${id}`},'image/webp',2048,true,now(),now())`);
  return id;
}

async function storageKeyOf(assetId: string): Promise<string> {
  const [row] = await asAdmin(
    (a) => a.$queryRaw<{ storage_key: string }[]>`
      SELECT storage_key FROM media_assets WHERE id = ${assetId}`,
  );
  return row!.storage_key;
}

/** The signed part of a presigned URL. */
function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
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

describe("the doorstep photograph", () => {
  /** A delivery out on the road, ready to be completed. */
  async function outForDelivery(number = "DL-P"): Promise<string> {
    const orderId = await readyOrder(number);
    await delivery.board(STORE);
    await delivery.assign(STORE, orderId, ADMIN, DRIVER);
    await delivery.pickUp(STORE, orderId, DRIVER);
    return orderId;
  }

  it("gives whoever reads the order a URL they can put in an img tag", async () => {
    const orderId = await outForDelivery();
    const assetId = await proofAsset();

    await delivery.complete(STORE, orderId, DRIVER, { proofMediaAssetId: assetId });

    const row = await delivery.one(STORE, orderId);
    expect(row.proof_url).toContain("/api/v1/media/private/");
    // The `medium` variant, not the original: this is looked at on a phone,
    // and a doorstep at full camera resolution is megabytes to answer a
    // question the smaller one answers.
    expect(storage.verifyReadGrant(tokenOf(row.proof_url!)).key).toBe(
      `${await storageKeyOf(assetId)}/medium.webp`,
    );
    expect(row.signature_url).toBeNull();
  });

  it("refuses a photo belonging to another shop", async () => {
    const orderId = await outForDelivery();
    const foreign = await proofAsset({ storeId: OTHER_STORE });

    await expect(
      delivery.complete(STORE, orderId, DRIVER, { proofMediaAssetId: foreign }),
    ).rejects.toThrow(/isn't one this shop can use/);

    // And the delivery is untouched — a rejected photo must not half-complete
    // the handover.
    expect(await orderStatus(orderId)).toBe("OUT_FOR_DELIVERY");
  });

  it("refuses one the worker has not finished with", async () => {
    const orderId = await outForDelivery();
    const pending = await proofAsset({ status: "PENDING" });

    await expect(
      delivery.complete(STORE, orderId, DRIVER, { proofMediaAssetId: pending }),
    ).rejects.toThrow(/still uploading/);
  });

  it("refuses a product photo passed off as proof", async () => {
    const orderId = await outForDelivery();
    const product = await proofAsset({ kind: "PRODUCT" });

    await expect(
      delivery.complete(STORE, orderId, DRIVER, { proofMediaAssetId: product }),
    ).rejects.toThrow(/isn't one this shop can use/);
  });

  it("mints a fresh URL each read, rather than storing one that expires", async () => {
    const orderId = await outForDelivery();
    await delivery.complete(STORE, orderId, DRIVER, { proofMediaAssetId: await proofAsset() });

    const first = await delivery.one(STORE, orderId);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await delivery.one(STORE, orderId);

    // Different token, same object: the expiry moves with the read.
    expect(second.proof_url).not.toBe(first.proof_url);
    expect(storage.verifyReadGrant(tokenOf(second.proof_url!)).key).toBe(
      storage.verifyReadGrant(tokenOf(first.proof_url!)).key,
    );
  });

  it("will not let a read token be spent as an upload token, or the reverse", async () => {
    const read = tokenOf(await storage.presignRead("private/thing/medium.webp"));
    const { url } = await storage.presignUpload("quarantine/thing.bin", "image/webp", 1000);
    const upload = tokenOf(url);

    // Both are HMACs over a JSON payload, so one key would make each verify as
    // the other and leave only the field names to notice.
    expect(() => storage.verifyGrant(read)).toThrow();
    expect(() => storage.verifyReadGrant(upload)).toThrow();
  });

  it("stops working after it expires", async () => {
    const token = tokenOf(await storage.presignRead("private/thing/medium.webp", -1));
    expect(() => storage.verifyReadGrant(token)).toThrow(/expired/);
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
