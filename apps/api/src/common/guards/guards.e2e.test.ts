import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Public } from "../decorators/public.decorator.js";
import { RequirePermission } from "../decorators/require-permission.decorator.js";
import { ProblemDetailsFilter } from "../filters/problem-details.filter.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { PermissionsGuard } from "./permissions.guard.js";
import { StoreScopeGuard } from "./store-scope.guard.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { PrismaModule } from "../../infra/prisma/prisma.module.js";
import { AuthModule } from "../../modules/auth/auth.module.js";
import { TokenService } from "../../modules/auth/token.service.js";
import { validateEnv } from "../../config/env.js";

/**
 * Exercises the guard stack over real HTTP, as the RLS-restricted role.
 *
 * The routes below exist only for this suite: they are the decorator
 * combinations the guards must distinguish, which no production controller
 * exhibits all at once.
 */
@Controller("guard-test")
class GuardTestController {
  @Public()
  @Get("public")
  publicRoute() {
    return { reached: "public" };
  }

  /** Authenticated but declares no permission — own-resource routes look like this. */
  @Get("authed")
  authedRoute() {
    return { reached: "authed" };
  }

  @Get("stores/:storeId/read")
  @RequirePermission("catalog:read")
  storeRead() {
    return { reached: "store-read" };
  }

  @Get("stores/:storeId/refund")
  @RequirePermission("orders:refund")
  storeRefund() {
    return { reached: "store-refund" };
  }

  /** Declares a store-scoped permission but exposes no :storeId to scope it to. */
  @Get("no-store-scope")
  @RequirePermission("catalog:read")
  danglingPermission() {
    return { reached: "dangling" };
  }
}

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

// Run the test config through the real validator rather than hand-rolling an
// object: the suite then inherits the same defaults (token TTLs, cookie flags)
// as production, instead of silently diverging from it.
const TEST_ENV = validateEnv({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost:5432/bba_dev?schema=public",
  DATABASE_URL_APP: APP_DATABASE_URL,
  JWT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
  JWT_ISSUER: "bba-test",
  JWT_AUDIENCE: "bba-api-test",
  PASSWORD_BREACH_CHECK: "false",
});

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => TEST_ENV] }),
    PrismaModule,
    AuthModule,
  ],
  controllers: [GuardTestController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: StoreScopeGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
class GuardTestModule {}

// Fixture ids, distinct from the isolation suite's so the two cannot collide.
const STORE_A = "c0000000-0000-4000-8000-00000000000a";
const STORE_B = "c0000000-0000-4000-8000-00000000000b";
const CLERK = "c0000000-0000-4000-8000-0000000000c1";
const CLERK_WITH_REFUND = "c0000000-0000-4000-8000-0000000000c2";
const OUTSIDER = "c0000000-0000-4000-8000-0000000000c3";
const SUSPENDED_CLERK = "c0000000-0000-4000-8000-0000000000c4";
const SUPER_ADMIN = "c0000000-0000-4000-8000-0000000000c9";

let app: INestApplication;
let tokens: TokenService;

beforeAll(async () => {
  await seed();

  const moduleRef = await Test.createTestingModule({ imports: [GuardTestModule] })
    // Connect as the restricted role: with a superuser the permission lookup
    // would succeed regardless of RLS, and the suite would prove nothing.
    .overrideProvider(PrismaService)
    .useValue(new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never))
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();

  tokens = moduleRef.get(TokenService);
});

afterAll(async () => {
  await app?.close();
  await cleanup();
});

/** Fixtures are written with the superuser so they aren't subject to the policies under test. */
async function seed(): Promise<void> {
  const admin = new PrismaService();
  try {
    await cleanupWith(admin);

    for (const [id, email, name, platformRole] of [
      [CLERK, "guard-clerk@example.com", "Clerk", null],
      [CLERK_WITH_REFUND, "guard-clerk-refund@example.com", "Clerk Refund", null],
      [OUTSIDER, "guard-outsider@example.com", "Outsider", null],
      [SUSPENDED_CLERK, "guard-suspended@example.com", "Suspended", null],
      [SUPER_ADMIN, "guard-super@example.com", "Super", "SUPER_ADMIN"],
    ] as const) {
      await admin.$executeRaw`
        INSERT INTO users (id, email, name, platform_role, status, created_at, updated_at)
        VALUES (${id}, ${email}::citext, ${name},
                ${platformRole}::"PlatformRole", 'ACTIVE', now(), now())
      `;
    }

    for (const [id, slug, name] of [
      [STORE_A, "guard-store-a", "Guard Store A"],
      [STORE_B, "guard-store-b", "Guard Store B"],
    ] as const) {
      await admin.$executeRaw`
        INSERT INTO stores (id, slug, name, business_type, status, owner_user_id,
                            timezone, currency, branding, cash_enabled,
                            stripe_charges_enabled, platform_fee_bps, created_at, updated_at)
        VALUES (${id}, ${slug}::citext, ${name}, 'RETAIL', 'ACTIVE', ${CLERK},
                'America/Chicago', 'USD', '{}'::jsonb, true, false, 0, now(), now())
      `;
    }

    const memberships = [
      [randomUUID(), STORE_A, CLERK, "CLERK", "ACTIVE"],
      [randomUUID(), STORE_A, CLERK_WITH_REFUND, "CLERK", "ACTIVE"],
      [randomUUID(), STORE_A, SUSPENDED_CLERK, "CLERK", "SUSPENDED"],
      [randomUUID(), STORE_B, OUTSIDER, "CLERK", "ACTIVE"],
    ] as const;

    for (const [id, storeId, userId, role, status] of memberships) {
      await admin.$executeRaw`
        INSERT INTO store_memberships (id, store_id, user_id, role, status, created_at, updated_at)
        VALUES (${id}, ${storeId}, ${userId}, ${role}::"MembershipRole",
                ${status}::"MembershipStatus", now(), now())
      `;
    }

    // The guardrailed grant from plan §4.4: a Store Admin may extend a clerk
    // with orders:refund. This is the row that should flip a 403 into a 200.
    const refundMembership = memberships[1][0];
    await admin.$executeRaw`
      INSERT INTO member_permission_overrides (id, membership_id, permission_code, effect, created_at)
      VALUES (${randomUUID()}, ${refundMembership}, 'orders:refund', 'GRANT'::"PermissionEffect", now())
    `;
  } finally {
    await admin.$disconnect();
  }
}

async function cleanup(): Promise<void> {
  const admin = new PrismaService();
  try {
    await cleanupWith(admin);
  } finally {
    await admin.$disconnect();
  }
}

async function cleanupWith(admin: PrismaService): Promise<void> {
  const users = [CLERK, CLERK_WITH_REFUND, OUTSIDER, SUSPENDED_CLERK, SUPER_ADMIN];
  const stores = [STORE_A, STORE_B];
  await admin.$executeRaw`
    DELETE FROM member_permission_overrides
    WHERE membership_id IN (SELECT id FROM store_memberships WHERE store_id = ANY(${stores}))
  `;
  await admin.$executeRaw`DELETE FROM store_memberships WHERE store_id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM stores WHERE id = ANY(${stores})`;
  await admin.$executeRaw`DELETE FROM refresh_tokens WHERE user_id = ANY(${users})`;
  await admin.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`;
}

async function tokenFor(
  userId: string,
  memberships: { storeId: string; role: "CLERK" | "STORE_ADMIN" }[] = [],
  platformRole: "SUPER_ADMIN" | null = null,
): Promise<string> {
  return tokens.issueAccessToken({
    sub: userId,
    email: `${userId}@example.com`,
    platformRole,
    memberships,
  });
}

describe("JwtAuthGuard — default deny", () => {
  it("allows a @Public() route with no token", async () => {
    await request(app.getHttpServer()).get("/guard-test/public").expect(200);
  });

  it("rejects an undecorated route with no token", async () => {
    // The important property: protection is the default, so a route added
    // without a decorator is locked rather than open.
    await request(app.getHttpServer()).get("/guard-test/authed").expect(401);
  });

  it("rejects a malformed token", async () => {
    await request(app.getHttpServer())
      .get("/guard-test/authed")
      .set("authorization", "Bearer not.a.jwt")
      .expect(401);
  });

  it("rejects a token signed by a different key", async () => {
    const foreign = generateKeyPairSync("ed25519");
    const { SignJWT, importPKCS8 } = await import("jose");
    const key = await importPKCS8(
      foreign.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "EdDSA",
    );
    const forged = await new SignJWT({ email: "x@example.com", memberships: [] })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(CLERK)
      .setIssuer("bba-test")
      .setAudience("bba-api-test")
      .setExpirationTime("15m")
      .sign(key);

    await request(app.getHttpServer())
      .get("/guard-test/authed")
      .set("authorization", `Bearer ${forged}`)
      .expect(401);
  });

  it("accepts a valid token", async () => {
    const token = await tokenFor(CLERK);
    await request(app.getHttpServer())
      .get("/guard-test/authed")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
  });
});

describe("StoreScopeGuard — cross-tenant access", () => {
  it("allows a member into their own store", async () => {
    const token = await tokenFor(CLERK, [{ storeId: STORE_A, role: "CLERK" }]);
    await request(app.getHttpServer())
      .get(`/guard-test/stores/${STORE_A}/read`)
      .set("authorization", `Bearer ${token}`)
      .expect(200);
  });

  it("returns 404 — not 403 — for a store the caller does not belong to", async () => {
    // A 403 would confirm the store exists, letting an attacker enumerate
    // tenants by probing ids (plan §13.2). The response must be identical to
    // one for a store that does not exist at all.
    const token = await tokenFor(OUTSIDER, [{ storeId: STORE_B, role: "CLERK" }]);
    const res = await request(app.getHttpServer())
      .get(`/guard-test/stores/${STORE_A}/read`)
      .set("authorization", `Bearer ${token}`)
      .expect(404);

    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns the same response for a foreign store and a nonexistent one", async () => {
    const token = await tokenFor(OUTSIDER, [{ storeId: STORE_B, role: "CLERK" }]);
    const nonexistent = "c0000000-0000-4000-8000-0000000000ff";

    const foreign = await request(app.getHttpServer())
      .get(`/guard-test/stores/${STORE_A}/read`)
      .set("authorization", `Bearer ${token}`);
    const missing = await request(app.getHttpServer())
      .get(`/guard-test/stores/${nonexistent}/read`)
      .set("authorization", `Bearer ${token}`);

    expect(foreign.status).toBe(missing.status);
    expect(foreign.body.code).toBe(missing.body.code);
    expect(foreign.body.title).toBe(missing.body.title);
  });

  it("does not trust membership claims absent from the token", async () => {
    // A token minted without a membership must not reach that store even if
    // the membership exists in the database.
    const token = await tokenFor(CLERK, []);
    await request(app.getHttpServer())
      .get(`/guard-test/stores/${STORE_A}/read`)
      .set("authorization", `Bearer ${token}`)
      .expect(404);
  });
});

describe("PermissionsGuard — role defaults and guardrailed grants", () => {
  it("allows a clerk a permission their role includes", async () => {
    const token = await tokenFor(CLERK, [{ storeId: STORE_A, role: "CLERK" }]);
    await request(app.getHttpServer())
      .get(`/guard-test/stores/${STORE_A}/read`)
      .set("authorization", `Bearer ${token}`)
      .expect(200);
  });

  it("denies a clerk a permission their role excludes", async () => {
    // orders:refund is not a CLERK default — it is an optional grant a Store
    // Admin must make deliberately.
    const token = await tokenFor(CLERK, [{ storeId: STORE_A, role: "CLERK" }]);
    const res = await request(app.getHttpServer())
      .get(`/guard-test/stores/${STORE_A}/refund`)
      .set("authorization", `Bearer ${token}`)
      .expect(403);

    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("allows the same action once the guardrailed grant exists", async () => {
    // Same role, same route — the only difference is the override row, which
    // is the mechanism plan §4.4 specifies.
    const token = await tokenFor(CLERK_WITH_REFUND, [{ storeId: STORE_A, role: "CLERK" }]);
    await request(app.getHttpServer())
      .get(`/guard-test/stores/${STORE_A}/refund`)
      .set("authorization", `Bearer ${token}`)
      .expect(200);
  });

  it("grants nothing to a suspended membership", async () => {
    // Suspension must revoke access without deleting the user (FR-AUTHZ-07).
    const token = await tokenFor(SUSPENDED_CLERK, [{ storeId: STORE_A, role: "CLERK" }]);
    await request(app.getHttpServer())
      .get(`/guard-test/stores/${STORE_A}/read`)
      .set("authorization", `Bearer ${token}`)
      .expect(403);
  });

  it("refuses a route that declares a store permission but has no store to scope to", async () => {
    // Passing here would make the decorator decorative — the permission would
    // be declared but never actually checked against anything.
    const token = await tokenFor(CLERK, [{ storeId: STORE_A, role: "CLERK" }]);
    await request(app.getHttpServer())
      .get("/guard-test/no-store-scope")
      .set("authorization", `Bearer ${token}`)
      .expect(403);
  });

  it("lets a super admin traverse any store", async () => {
    const token = await tokenFor(SUPER_ADMIN, [], "SUPER_ADMIN");
    await request(app.getHttpServer())
      .get(`/guard-test/stores/${STORE_A}/refund`)
      .set("authorization", `Bearer ${token}`)
      .expect(200);
  });
});
