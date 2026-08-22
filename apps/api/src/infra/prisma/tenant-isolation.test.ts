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
/** Has ordered from store B, and from nowhere else. */
const CUSTOMER_B = "33333333-3333-3333-3333-333333333333";
/** Has never ordered from anybody. */
const STRANGER = "44444444-4444-4444-4444-444444444444";

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

  // A shopper who has ordered from store B and nowhere else, and a stranger
  // who has never ordered at all. The customer-visibility tests below need
  // both to mean anything.
  await admin.$executeRaw`
    INSERT INTO users (id,email,name,status,created_at,updated_at) VALUES
    (${CUSTOMER_B},'isolation-shopper@example.com'::citext,'Shopper B','ACTIVE',now(),now()),
    (${STRANGER},'isolation-stranger@example.com'::citext,'Stranger','ACTIVE',now(),now())`;
  await admin.$executeRaw`
    INSERT INTO orders (id,store_id,order_number,fulfillment,status,customer_id,
                        subtotal_cents,total_cents,currency,placed_at,created_at,updated_at)
    VALUES (gen_random_uuid(),${STORE_B},'ISO-CUST','PICKUP','DELIVERED',${CUSTOMER_B},
            500,500,'USD',now(),now(),now())`;
});

afterAll(async () => {
  await teardown();
  await prisma.$disconnect();
  await admin.$disconnect();
});

async function teardown(): Promise<void> {
  const stores = [STORE_A, STORE_B];
  await admin.$executeRaw`DELETE FROM deliveries WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM store_customers WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM daily_store_product_sales WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM daily_store_sales WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM orders WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM carts WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM store_memberships WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM outbox_events WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM count_lines WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM count_sessions WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM billing_notifications WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM stores WHERE id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM users WHERE id = ANY(${[OWNER_A, OWNER_B, CUSTOMER_B, STRANGER]})`;
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

  it("lets a store read a customer who has ordered from it", async () => {
    // The policy exists so the order queue can say who placed an order. Before
    // migration 25 this returned nothing and every account order rendered as
    // "Guest" — a shop could not tell a regular from a walk-in.
    const rows = await withTenantContext(
      prisma,
      { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
      (tx) => tx.user.findMany({ where: { id: CUSTOMER_B }, select: { name: true } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Shopper B");
  });

  it("cannot read a customer's credentials, even on a row it may see", async () => {
    // Migration 25 let a shop see its customers' rows, which it should. RLS is
    // row-level, so that made every column on them readable by anything that
    // selected one — including the password hash. Migration 26 takes those two
    // columns away from the application role entirely.
    //
    // Raw SQL on purpose: the point is that the *database* refuses, not that
    // the service layer remembers to ask nicely.
    await expect(
      withTenantContext(
        prisma,
        { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
        (tx) => tx.$queryRawUnsafe(`SELECT password_hash FROM users WHERE id = $1`, CUSTOMER_B),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantContext(
        prisma,
        { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
        (tx) => tx.$queryRawUnsafe(`SELECT mfa_totp_secret FROM users WHERE id = $1`, CUSTOMER_B),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot read its own credentials by column either", async () => {
    // Not even about yourself: the only route to a hash is the SECURITY
    // DEFINER accessor, so there is no context in which the column is readable.
    await expect(
      withTenantContext(prisma, scopedToA, (tx) =>
        tx.$queryRawUnsafe(`SELECT password_hash FROM users WHERE id = $1`, OWNER_A),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("still lets a user reach their own hash through the accessor", async () => {
    // The revoke would be useless if it also broke signing in and changing a
    // password, so the replacement path is asserted beside it.
    await admin.$executeRaw`UPDATE users SET password_hash = 'not-a-real-hash' WHERE id = ${OWNER_A}`;

    const rows = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.$queryRaw<{ auth_self_password_hash: string | null }[]>`SELECT auth_self_password_hash()`,
    );
    expect(rows[0]!.auth_self_password_hash).toBe("not-a-real-hash");
  });

  it("will not hand one user's hash to another through the accessor", async () => {
    // It reads `app.user_id` rather than taking an argument, so there is no
    // parameter to point at somebody else.
    await admin.$executeRaw`UPDATE users SET password_hash = 'owner-b-hash' WHERE id = ${OWNER_B}`;

    const rows = await withTenantContext(
      prisma,
      { userId: OWNER_A, storeId: STORE_B, isSuperAdmin: false },
      (tx) =>
        tx.$queryRaw<{ auth_self_password_hash: string | null }[]>`SELECT auth_self_password_hash()`,
    );
    expect(rows[0]!.auth_self_password_hash).not.toBe("owner-b-hash");
  });

  it("hides another store's customer", async () => {
    // The whole risk of widening `users_read`: it must admit a shop to its own
    // customers and not to everybody's.
    // Naming the columns, because `bba_app` may no longer read the whole row
    // (migration 26) — the same discipline the services keep.
    const rows = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.user.findMany({ where: { id: CUSTOMER_B }, select: { id: true } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("hides somebody who has never ordered from anyone", async () => {
    const fromA = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.user.findMany({ where: { id: STRANGER }, select: { id: true } }),
    );
    const fromB = await withTenantContext(
      prisma,
      { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
      (tx) => tx.user.findMany({ where: { id: STRANGER }, select: { id: true } }),
    );
    expect(fromA).toHaveLength(0);
    expect(fromB).toHaveLength(0);
  });

  it("still refuses to let a store edit a customer it can now read", async () => {
    // Read was widened; write was not.
    await expect(
      withTenantContext(
        prisma,
        { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
        (tx) => tx.user.update({ where: { id: CUSTOMER_B }, data: { name: "Renamed" } }),
      ),
    ).rejects.toThrow();

    const [row] = await admin.$queryRaw<{ name: string }[]>`
      SELECT name FROM users WHERE id = ${CUSTOMER_B}`;
    expect(row!.name).toBe("Shopper B");
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

  it("hides one store's takings from another store", async () => {
    // The rollup is a summary of exactly the number a competitor would want:
    // what this shop turned over, by day. It is derived data, which is the
    // kind that gets a policy written for it last.
    await admin.$executeRaw`
      INSERT INTO daily_store_sales (store_id,date,orders_count,gross_cents,net_cents)
      VALUES (${STORE_B},'2026-03-01'::date,12,50000,45000)`;

    const fromStoreA = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.dailyStoreSales.findMany({ where: { storeId: STORE_B } }),
    );
    const fromStoreB = await withTenantContext(
      prisma,
      { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
      (tx) => tx.dailyStoreSales.findMany({ where: { storeId: STORE_B } }),
    );

    expect(fromStoreA).toHaveLength(0);
    expect(fromStoreB).toHaveLength(1);
  });

  it("hides one store's best sellers from another store", async () => {
    // Finer-grained than the takings rollup and correspondingly more useful to
    // a competitor: not just what a shop turned over, but exactly which lines
    // carry it.
    await admin.$executeRaw`
      INSERT INTO daily_store_product_sales
        (store_id,date,line_key,product_name,units,revenue_cents)
      VALUES (${STORE_B},'2026-03-01'::date,'name:Secret bestseller','Secret bestseller',40,20000)`;

    const fromStoreA = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.dailyStoreProductSales.findMany({ where: { storeId: STORE_B } }),
    );
    const fromStoreB = await withTenantContext(
      prisma,
      { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
      (tx) => tx.dailyStoreProductSales.findMany({ where: { storeId: STORE_B } }),
    );

    expect(fromStoreA).toHaveLength(0);
    expect(fromStoreB).toHaveLength(1);
  });

  it("hides one store's customer list from another store", async () => {
    // Names and email addresses of real people, and the rollup snapshots them
    // rather than joining `users` — so this table has to carry its own policy
    // instead of inheriting the protection the join used to provide.
    await admin.$executeRaw`
      INSERT INTO store_customers
        (store_id,customer_id,name,email,orders_count,lifetime_cents)
      VALUES (${STORE_B},${OWNER_B},'Owner B','isolation-b@example.com'::citext,9,90000)`;

    const fromStoreA = await withTenantContext(prisma, scopedToA, (tx) =>
      tx.storeCustomer.findMany({ where: { storeId: STORE_B } }),
    );
    const fromStoreB = await withTenantContext(
      prisma,
      { userId: OWNER_B, storeId: STORE_B, isSuperAdmin: false },
      (tx) => tx.storeCustomer.findMany({ where: { storeId: STORE_B } }),
    );

    expect(fromStoreA).toHaveLength(0);
    expect(fromStoreB).toHaveLength(1);
  });

  it("refuses to let a store write its own takings", async () => {
    // Only the rollup writes here, and it runs as the platform. A store admin
    // who could insert a row could restate last quarter without touching a
    // single order, and nothing in the order history would contradict them.
    await expect(
      withTenantContext(prisma, scopedToA, (tx) =>
        tx.dailyStoreSales.create({
          data: { storeId: STORE_A, date: new Date("2026-03-02"), grossCents: 999_999n },
        }),
      ),
    ).rejects.toThrow();
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
