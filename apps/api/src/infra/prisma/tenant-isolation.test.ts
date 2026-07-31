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
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantContext } from "./tenant-context.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const prisma = new PrismaClient({ datasources: { db: { url: APP_DATABASE_URL } } });

const STORE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STORE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OWNER_A = "11111111-1111-1111-1111-111111111111";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("cross-tenant isolation (RLS)", () => {
  it("lets store A read its own membership", async () => {
    const rows = await withTenantContext(
      prisma,
      { userId: OWNER_A, storeId: STORE_A, isSuperAdmin: false },
      (tx) => tx.storeMembership.findMany({ where: { storeId: STORE_A } }),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("hides store B's memberships from a store-A-scoped request", async () => {
    const rows = await withTenantContext(
      prisma,
      { userId: OWNER_A, storeId: STORE_A, isSuperAdmin: false },
      (tx) => tx.storeMembership.findMany({ where: { storeId: STORE_B } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("hides a suspended, foreign store from a store-A-scoped request", async () => {
    const rows = await withTenantContext(
      prisma,
      { userId: OWNER_A, storeId: STORE_A, isSuperAdmin: false },
      (tx) => tx.store.findMany({ where: { id: STORE_B } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects a write into store B's memberships while scoped to store A", async () => {
    await expect(
      withTenantContext(prisma, { userId: OWNER_A, storeId: STORE_A, isSuperAdmin: false }, (tx) =>
        tx.storeMembership.create({
          data: {
            storeId: STORE_B,
            userId: OWNER_A,
            role: "CLERK",
            status: "ACTIVE",
          },
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
});
