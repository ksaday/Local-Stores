// Cross-tenant isolation probe suite. See docs/plan/12-backend-architecture.md §12.12
// and docs/plan/13-security-design.md §13.3.
//
// This is a release gate, not a nice-to-have: any store-A actor reaching
// store-B's rows here means RLS has a hole, and the build must fail.
//
// Runs against the local dev DB as the restricted `bba_app` role (created in
// migration 00000000000001_rls_policies) — never as the migration/superuser,
// which bypasses RLS entirely and would make this suite pass for the wrong
// reason.
//
// The suite seeds its own fixtures. It previously relied on rows that existed
// only in one developer's database, which meant a fresh clone could not run it
// at all — and, worse, that its negative assertions ("store B is invisible")
// passed vacuously when those rows were missing. The first test below exists
// to make that failure mode impossible.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantContext } from "./tenant-context.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

/** RLS-restricted, like the running application. */
const prisma = new PrismaClient({ datasources: { db: { url: APP_DATABASE_URL } } });
/** Bypasses RLS. Used only to build fixtures and to prove they exist. */
const admin = new PrismaClient();

const STORE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STORE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OWNER_A = "11111111-1111-1111-1111-111111111111";
const OWNER_B = "22222222-2222-2222-2222-222222222222";

const scopedToA = { userId: OWNER_A, storeId: STORE_A, isSuperAdmin: false } as const;

beforeAll(async () => {
  await teardown();

  await admin.$executeRaw`
    INSERT INTO users (id,email,name,status,created_at,updated_at) VALUES
    (${OWNER_A},'isolation-a@example.com'::citext,'Owner A','ACTIVE',now(),now()),
    (${OWNER_B},'isolation-b@example.com'::citext,'Owner B','ACTIVE',now(),now())`;

  for (const [id, slug, name, owner, status] of [
    [STORE_A, "isolation-store-a", "Isolation Store A", OWNER_A, "ACTIVE"],
    // Suspended on purpose: a foreign store must be invisible whatever its state.
    [STORE_B, "isolation-store-b", "Isolation Store B", OWNER_B, "SUSPENDED"],
  ] as const) {
    await admin.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                          branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${id},${slug}::citext,${name},'RETAIL',${status}::"StoreStatus",${owner},
              'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
  }

  for (const [storeId, userId] of [
    [STORE_A, OWNER_A],
    [STORE_B, OWNER_B],
  ] as const) {
    await admin.$executeRaw`
      INSERT INTO store_memberships (id,store_id,user_id,role,status,created_at,updated_at)
      VALUES (gen_random_uuid(),${storeId},${userId},'STORE_ADMIN','ACTIVE',now(),now())`;
  }
});

afterAll(async () => {
  await teardown();
  await prisma.$disconnect();
  await admin.$disconnect();
});

async function teardown(): Promise<void> {
  const stores = [STORE_A, STORE_B];
  await admin.$executeRaw`DELETE FROM deliveries WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM orders WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM carts WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM store_memberships WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM outbox_events WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM count_lines WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM count_sessions WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM billing_notifications WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM stores WHERE id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM users WHERE id = ANY(${[OWNER_A, OWNER_B]})`;
}

describe("cross-tenant isolation (RLS)", () => {
  it("has its fixtures in place, so the negative checks below mean something", async () => {
    // Without this, an empty database makes every "cannot see store B" test
    // pass while proving nothing at all.
    const stores = await admin.store.findMany({ where: { id: { in: [STORE_A, STORE_B] } } });
    const memberships = await admin.storeMembership.findMany({
      where: { storeId: { in: [STORE_A, STORE_B] } },
    });
    expect(stores).toHaveLength(2);
    expect(memberships).toHaveLength(2);
  });

  it("lets store A read its own membership", async () => {
    const rows = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.storeMembership.findMany({ where: { storeId: STORE_A } }),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("hides store B's memberships from a store-A-scoped request", async () => {
    const rows = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.storeMembership.findMany({ where: { storeId: STORE_B } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("hides a suspended, foreign store from a store-A-scoped request", async () => {
    const rows = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.store.findMany({ where: { id: STORE_B } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects a write into store B's memberships while scoped to store A", async () => {
    await expect(
      withTenantContext(prisma, scopedToA, (tx) =>
        tx.storeMembership.create({
          data: { storeId: STORE_B, userId: OWNER_A, role: "CLERK", status: "ACTIVE" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("lets a super-admin-scoped request see both stores", async () => {
    const rows = await withTenantContext(prisma, { isSuperAdmin: true }, (tx) =>
      tx.store.findMany({ where: { id: { in: [STORE_A, STORE_B] } } }),
    );
    expect(rows).toHaveLength(2);
  });

  it("hides another shopper's cart", async () => {
    // Carts are customer-owned rather than store-scoped, so they exercise a
    // different policy family from everything above.
    const cartId = crypto.randomUUID();
    await admin.$executeRaw`
      INSERT INTO carts (id,store_id,user_id,status,expires_at,created_at,updated_at)
      VALUES (${cartId},${STORE_A},${OWNER_B},'ACTIVE',now() + interval '1 day',now(),now())`;

    const asOwnerA = await withTenantContext(prisma, { userId: OWNER_A, isSuperAdmin: false }, (tx) =>
      tx.cart.findMany({ where: { id: cartId } }),
    );
    const asOwnerB = await withTenantContext(prisma, { userId: OWNER_B, isSuperAdmin: false }, (tx) =>
      tx.cart.findMany({ where: { id: cartId } }),
    );

    expect(asOwnerA).toHaveLength(0);
    expect(asOwnerB).toHaveLength(1);
  });

  it("hides a guest's cart from a different guest session key", async () => {
    const cartId = crypto.randomUUID();
    await admin.$executeRaw`
      INSERT INTO carts (id,store_id,session_key,status,expires_at,created_at,updated_at)
      VALUES (${cartId},${STORE_A},'guest-key-one','ACTIVE',now() + interval '1 day',now(),now())`;

    const wrongKey = await withTenantContext(
      prisma,
      { sessionKey: "guest-key-two", isSuperAdmin: false },
      (tx) => tx.cart.findMany({ where: { id: cartId } }),
    );
    const rightKey = await withTenantContext(
      prisma,
      { sessionKey: "guest-key-one", isSuperAdmin: false },
      (tx) => tx.cart.findMany({ where: { id: cartId } }),
    );

    expect(wrongKey).toHaveLength(0);
    expect(rightKey).toHaveLength(1);
  });

  it("hides one store's orders from another store", async () => {
    const orderId = crypto.randomUUID();
    await admin.$executeRaw`
      INSERT INTO orders (id,store_id,order_number,fulfillment,subtotal_cents,total_cents,
                          currency,placed_at,created_at,updated_at)
      VALUES (${orderId},${STORE_B},'ISO-1','PICKUP',100,100,'USD',now(),now(),now())`;

    const fromStoreA = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.order.findMany({ where: { id: orderId } }),
    );
    const fromStoreB = await withTenantContext(
      prisma,
      { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
      (tx) => tx.order.findMany({ where: { id: orderId } }),
    );

    expect(fromStoreA).toHaveLength(0);
    expect(fromStoreB).toHaveLength(1);
  });

  it("hides one store's deliveries from another store", async () => {
    // A delivery row points at a customer's home address and phone number.
    // This is the PII-shaped leak, not merely a commercial one.
    const orderId = crypto.randomUUID();
    await admin.$executeRaw`
      INSERT INTO orders (id,store_id,order_number,fulfillment,status,delivery_address,
                          subtotal_cents,total_cents,currency,placed_at,created_at,updated_at)
      VALUES (${orderId},${STORE_B},'ISO-DL','DELIVERY','READY',
              '{"line1":"9 Somewhere St"}'::jsonb,100,100,'USD',now(),now(),now())`;
    await admin.$executeRaw`
      INSERT INTO deliveries (id,store_id,order_id,created_at,updated_at)
      VALUES (${crypto.randomUUID()},${STORE_B},${orderId},now(),now())`;

    const fromStoreA = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.delivery.findMany({ where: { orderId } }),
    );
    const fromStoreB = await withTenantContext(
      prisma,
      { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
      (tx) => tx.delivery.findMany({ where: { orderId } }),
    );

    expect(fromStoreA).toHaveLength(0);
    expect(fromStoreB).toHaveLength(1);
  });

  it("hides one store's stock counts from another store", async () => {
    // A count session's variances are a shop's shrinkage figures. Another
    // shop on the same platform reading them is straightforwardly commercial.
    const sessionId = crypto.randomUUID();
    await admin.$executeRaw`
      INSERT INTO count_sessions (id,store_id,name,status,opened_by,opened_at)
      VALUES (${sessionId},${STORE_B},'B stock count','OPEN',${OWNER_B},now())`;

    const fromStoreA = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.countSession.findMany({ where: { id: sessionId } }),
    );
    const fromStoreB = await withTenantContext(
      prisma,
      { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
      (tx) => tx.countSession.findMany({ where: { id: sessionId } }),
    );

    expect(fromStoreA).toHaveLength(0);
    expect(fromStoreB).toHaveLength(1);
  });

  it("hides one store's billing notices from another store", async () => {
    // Dunning records say when a shop stopped paying and started heading for
    // suspension. A competing shop on the same platform reading that would be
    // a straightforwardly commercial leak.
    const noticeId = crypto.randomUUID();
    await admin.$executeRaw`
      INSERT INTO billing_notifications (id,store_id,past_due_since,stage,sent_to)
      VALUES (${noticeId},${STORE_B},now(),'FINAL_WARNING','owner-b@example.com')`;

    const fromStoreA = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.billingNotification.findMany({ where: { id: noticeId } }),
    );
    const fromStoreB = await withTenantContext(
      prisma,
      { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
      (tx) => tx.billingNotification.findMany({ where: { id: noticeId } }),
    );

    expect(fromStoreA).toHaveLength(0);
    expect(fromStoreB).toHaveLength(1);
  });
});
