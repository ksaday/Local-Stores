import { ConfigService } from "@nestjs/config";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { InMemoryMailer } from "../../infra/mailer/mailer.js";
import { validateEnv } from "../../config/env.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import { InvitationService } from "../auth/invitation.service.js";
import { MfaService } from "../auth/mfa.service.js";
import { PasswordService } from "../auth/password.service.js";
import { TokenService } from "../auth/token.service.js";
import { VerificationTokenService } from "../auth/verification-token.service.js";
import { StaffService } from "./staff.service.js";
import { StoreApplicationService } from "./store-application.service.js";
import { StoreService } from "./store.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const ENV = validateEnv({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost:5432/bba_dev?schema=public",
  JWT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
  PASSWORD_BREACH_CHECK: "false",
});
const config = { get: (k: string) => (ENV as Record<string, unknown>)[k] } as unknown as ConfigService;

const REVIEWER = "e0000000-0000-4000-8000-000000000001";
const APPLICANT_EMAIL = "applicant-test@example.com";
const SLUG = "phase4-test-store";
const PASSWORD = "the quiet bakery on morse avenue";

let prisma: PrismaService;
let applications: StoreApplicationService;
let stores: StoreService;
let staff: StaffService;
let auth: AuthService;
let invitations: InvitationService;
let mailer: InMemoryMailer;

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  const tokens = new TokenService(config as never);
  await tokens.onModuleInit();
  const passwords = new PasswordService(config as never);
  const repo = new AuthRepository(prisma);
  const verification = new VerificationTokenService(prisma);
  const audit = new AuditService(prisma);
  mailer = new InMemoryMailer();
  const mfa = new MfaService(prisma, config as never);
  auth = new AuthService(prisma, repo, passwords, tokens, mfa, config as never);
  invitations = new InvitationService(prisma, repo, verification, passwords, mailer, config as never);
  applications = new StoreApplicationService(prisma, audit, invitations);
  stores = new StoreService(prisma, audit, auth);
  staff = new StaffService(prisma, audit, auth);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await seedReviewer();
  mailer.clear();
});

async function seedReviewer(): Promise<void> {
  await asAdmin((admin) =>
    admin.$executeRaw`
      INSERT INTO users (id, email, name, platform_role, status, created_at, updated_at)
      VALUES (${REVIEWER}, 'phase4-reviewer@example.com'::citext, 'Reviewer',
              'SUPER_ADMIN'::"PlatformRole", 'ACTIVE', now(), now())
    `,
  );
}

async function asAdmin<T>(work: (admin: PrismaService) => Promise<T>): Promise<T> {
  const admin = new PrismaService();
  try {
    return await work(admin);
  } finally {
    await admin.$disconnect();
  }
}

async function cleanup(): Promise<void> {
  await asAdmin(async (admin) => {
    const emails = [APPLICANT_EMAIL, "phase4-reviewer@example.com", "phase4-clerk@example.com"];
    await admin.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (SELECT id FROM stores WHERE slug = ${SLUG}::citext)`;
    await admin.$executeRaw`DELETE FROM verification_tokens WHERE email = ANY(${emails}::citext[])`;
    await admin.$executeRaw`
      DELETE FROM member_permission_overrides WHERE membership_id IN (
        SELECT id FROM store_memberships WHERE store_id IN (SELECT id FROM stores WHERE slug = ${SLUG}::citext)
      )`;
    await admin.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (SELECT id FROM stores WHERE slug = ${SLUG}::citext)`;
    await admin.$executeRaw`DELETE FROM store_hours WHERE store_id IN (SELECT id FROM stores WHERE slug = ${SLUG}::citext)`;
    await admin.$executeRaw`DELETE FROM delivery_zones WHERE store_id IN (SELECT id FROM stores WHERE slug = ${SLUG}::citext)`;
    await admin.$executeRaw`DELETE FROM tax_rates WHERE store_id IN (SELECT id FROM stores WHERE slug = ${SLUG}::citext)`;
    await admin.$executeRaw`UPDATE store_applications SET store_id = NULL WHERE applicant_email = ${APPLICANT_EMAIL}::citext`;
    await admin.$executeRaw`DELETE FROM stores WHERE slug = ${SLUG}::citext`;
    await admin.$executeRaw`DELETE FROM store_applications WHERE applicant_email = ${APPLICANT_EMAIL}::citext`;
    await admin.$executeRaw`DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ANY(${emails}::citext[]))`;
    await admin.$executeRaw`DELETE FROM users WHERE email = ANY(${emails}::citext[])`;
  });
}

async function submitApplication() {
  return applications.submit({
    applicantName: "Maria Vasquez",
    applicantEmail: APPLICANT_EMAIL,
    businessName: "Morse Ave Bakery",
    businessType: "RETAIL",
    city: "Chicago",
    state: "IL",
  });
}

/**
 * Unwraps a login that is expected to complete without a second factor.
 * Fails loudly if MFA intervened, rather than letting a test quietly assert
 * against an unfinished login.
 */
async function loginSession(
  auth: AuthService,
  email: string,
  password: string,
  device: { ip?: string; userAgent?: string },
) {
  const outcome = await auth.login({ email, password }, device);
  if (outcome.kind !== "session") throw new Error("Expected a session, got an MFA challenge.");
  return outcome.session;
}

async function expectRejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("Expected the call to reject, but it resolved.");
}

describe("store application intake", () => {
  it("accepts a public application without any account", async () => {
    const { id } = await submitApplication();
    const application = await applications.get(id);

    expect(application.status).toBe("PENDING");
    expect(application.businessName).toBe("Morse Ave Bakery");
    // Nothing is provisioned by applying — a store only exists after review.
    expect(application.storeId).toBeNull();
  });

  it("records the submission in the audit log with no actor", async () => {
    const { id } = await submitApplication();
    const entries = await asAdmin((admin) =>
      admin.auditLog.findMany({ where: { entityType: "store_application", entityId: id } }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("store_application.submitted");
    expect(entries[0]!.actorUserId).toBeNull();
  });
});

describe("application review", () => {
  it("provisions a store and invites the applicant as owner", async () => {
    const { id } = await submitApplication();
    const { storeId } = await applications.approve(id, REVIEWER, { slug: SLUG });

    const store = await asAdmin((admin) => admin.store.findUnique({ where: { id: storeId } }));
    expect(store?.slug).toBe(SLUG);
    // APPROVED, not ACTIVE — the owner still has to set the store up, and a
    // half-built storefront must not be publicly reachable.
    expect(store?.status).toBe("APPROVED");

    const invite = mailer.lastTo(APPLICANT_EMAIL);
    expect(invite?.subject).toContain("Morse Ave Bakery");
  });

  it("is idempotent — a retried approval does not provision a second store", async () => {
    const { id } = await submitApplication();
    const first = await applications.approve(id, REVIEWER, { slug: SLUG });
    const second = await applications.approve(id, REVIEWER, { slug: SLUG });

    expect(second.storeId).toBe(first.storeId);
    expect(second.alreadyApproved).toBe(true);

    const count = await asAdmin((admin) => admin.store.count({ where: { slug: SLUG } }));
    expect(count).toBe(1);
  });

  it("rejects a slug that is already taken", async () => {
    const first = await submitApplication();
    await applications.approve(first.id, REVIEWER, { slug: SLUG });

    const second = await applications.submit({
      applicantName: "Someone Else",
      applicantEmail: APPLICANT_EMAIL,
      businessName: "Another Bakery",
      businessType: "RETAIL",
    });

    await expect(
      applications.approve(second.id, REVIEWER, { slug: SLUG }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a slug that would shadow a platform route", async () => {
    const { id } = await submitApplication();
    const err = await expectRejection(applications.approve(id, REVIEWER, { slug: "platform" }));
    expect(err.fieldErrors?.[0]?.code).toBe("RESERVED");
  });

  it("rejects a malformed slug rather than silently rewriting it", async () => {
    // The slug becomes a public URL — quietly changing what a reviewer typed
    // would produce a different address than intended.
    const { id } = await submitApplication();
    await expect(
      applications.approve(id, REVIEWER, { slug: "Not A Valid Slug!" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("will not approve an application that was already rejected", async () => {
    const { id } = await submitApplication();
    await applications.reject(id, REVIEWER, "Outside our launch area.");
    await expect(applications.approve(id, REVIEWER, { slug: SLUG })).rejects.toBeInstanceOf(AppError);
  });
});

describe("store lifecycle", () => {
  let storeId: string;

  beforeEach(async () => {
    const { id } = await submitApplication();
    ({ storeId } = await applications.approve(id, REVIEWER, { slug: SLUG }));
  });

  it("allows APPROVED to ACTIVE", async () => {
    await stores.transition(storeId, "ACTIVE", REVIEWER);
    const store = await asAdmin((a) => a.store.findUnique({ where: { id: storeId } }));
    expect(store?.status).toBe("ACTIVE");
    expect(store?.approvedAt).toBeInstanceOf(Date);
  });

  it("refuses APPROVED straight to SUSPENDED", async () => {
    // A store that was never live cannot be suspended; the reviewer means CLOSED.
    const err = await expectRejection(stores.transition(storeId, "SUSPENDED", REVIEWER));
    expect(err.status).toBe(409);
  });

  it("refuses any transition out of CLOSED", async () => {
    await stores.transition(storeId, "CLOSED", REVIEWER, "Owner withdrew.");
    const err = await expectRejection(stores.transition(storeId, "ACTIVE", REVIEWER));
    expect(err.status).toBe(409);
  });

  it("is idempotent for a no-op transition", async () => {
    await stores.transition(storeId, "ACTIVE", REVIEWER);
    await expect(stores.transition(storeId, "ACTIVE", REVIEWER)).resolves.toBeUndefined();
  });

  it("signs out staff when the store is suspended", async () => {
    // FR-PLAT-02: suspension must take effect quickly. Access tokens live 15
    // minutes, so revoking refresh families is what actually closes the window.
    await stores.transition(storeId, "ACTIVE", REVIEWER);

    await invitations.invite({
      storeId, email: "phase4-clerk@example.com", role: "CLERK", invitedBy: REVIEWER,
    });
    const inviteMail = mailer.lastTo("phase4-clerk@example.com")!;
    const token = /invite\/([A-Za-z0-9_-]{20,})/.exec(inviteMail.body)![1]!;
    await invitations.accept({ token, name: "Clerk", password: PASSWORD });

    const session = await loginSession(auth, "phase4-clerk@example.com", PASSWORD, { ip: "127.0.0.1" });

    await stores.transition(storeId, "SUSPENDED", REVIEWER, "Payment dispute.");

    await expect(auth.refresh(session.refreshToken, { ip: "127.0.0.1" })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("records lifecycle changes as HIGH severity with the reason", async () => {
    await stores.transition(storeId, "ACTIVE", REVIEWER);
    await stores.transition(storeId, "SUSPENDED", REVIEWER, "Payment dispute.");

    const entries = await asAdmin((admin) =>
      admin.auditLog.findMany({
        where: { storeId, action: "store.suspended" },
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.severity).toBe("HIGH");
    expect(entries[0]!.actorUserId).toBe(REVIEWER);
    expect((entries[0]!.after as Record<string, unknown>).reason).toBe("Payment dispute.");
  });
});

describe("staff management guardrails", () => {
  let storeId: string;
  let clerkMembershipId: string;

  beforeEach(async () => {
    const { id } = await submitApplication();
    ({ storeId } = await applications.approve(id, REVIEWER, { slug: SLUG }));
    await stores.transition(storeId, "ACTIVE", REVIEWER);

    // Approval provisions the store and sends the owner invitation, but the
    // STORE_ADMIN membership only exists once the applicant accepts. Between
    // those two points the store deliberately has no staff at all.
    const ownerToken = /invite\/([A-Za-z0-9_-]{20,})/.exec(
      mailer.lastTo(APPLICANT_EMAIL)!.body,
    )![1]!;
    await invitations.accept({ token: ownerToken, name: "Maria Vasquez", password: PASSWORD });

    await invitations.invite({
      storeId, email: "phase4-clerk@example.com", role: "CLERK", invitedBy: REVIEWER,
    });
    const token = /invite\/([A-Za-z0-9_-]{20,})/.exec(
      mailer.lastTo("phase4-clerk@example.com")!.body,
    )![1]!;
    await invitations.accept({ token, name: "Clerk", password: PASSWORD });

    const membership = await asAdmin((admin) =>
      admin.storeMembership.findFirst({ where: { storeId, role: "CLERK" } }),
    );
    clerkMembershipId = membership!.id;
  });

  it("accepts a grant inside the role's allowed superset", async () => {
    await expect(
      staff.setOverrides(storeId, clerkMembershipId, { grants: ["orders:refund"], denies: [] }, REVIEWER),
    ).resolves.toBeUndefined();
  });

  it("rejects a grant outside the superset with 422", async () => {
    // The guardrail is server-side: a compromised owner session must not be
    // able to mint a clerk who can manage staff.
    const err = await expectRejection(
      staff.setOverrides(storeId, clerkMembershipId, { grants: ["staff:manage"], denies: [] }, REVIEWER),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe("PERMISSION_GRANT_OUT_OF_SUPERSET");
  });

  it("rejects a permission that is both granted and denied", async () => {
    await expect(
      staff.setOverrides(
        storeId, clerkMembershipId,
        { grants: ["orders:refund"], denies: ["orders:refund"] },
        REVIEWER,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("clears overrides when the role changes", async () => {
    // Grants were scoped to the old role's guardrails; carrying them into a
    // new role could silently widen access beyond what that role permits.
    await staff.setOverrides(storeId, clerkMembershipId, { grants: ["orders:refund"], denies: [] }, REVIEWER);
    await staff.changeRole(storeId, clerkMembershipId, "DELIVERY", REVIEWER);

    const overrides = await asAdmin((admin) =>
      admin.memberPermissionOverride.findMany({ where: { membershipId: clerkMembershipId } }),
    );
    expect(overrides).toHaveLength(0);
  });

  it("will not demote the last active owner", async () => {
    const owner = await asAdmin((admin) =>
      admin.storeMembership.findFirst({ where: { storeId, role: "STORE_ADMIN" } }),
    );
    await expect(
      staff.changeRole(storeId, owner!.id, "CLERK", REVIEWER),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("will not suspend the last active owner", async () => {
    const owner = await asAdmin((admin) =>
      admin.storeMembership.findFirst({ where: { storeId, role: "STORE_ADMIN" } }),
    );
    await expect(
      staff.changeStatus(storeId, owner!.id, "SUSPENDED", REVIEWER),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("treats a membership from another store as not found", async () => {
    const foreign = randomUUID();
    await expect(
      staff.changeRole(storeId, foreign, "CLERK", REVIEWER),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("signs a member out when suspended", async () => {
    const session = await loginSession(auth, "phase4-clerk@example.com", PASSWORD, { ip: "127.0.0.1" });
    await staff.changeStatus(storeId, clerkMembershipId, "SUSPENDED", REVIEWER);

    await expect(auth.refresh(session.refreshToken, { ip: "127.0.0.1" })).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe("delivery zones", () => {
  let storeId: string;

  // Chicago Loop, roughly.
  const LOOP = { lat: 41.8827, lng: -87.6233 };

  beforeEach(async () => {
    const { id } = await submitApplication();
    ({ storeId } = await applications.approve(id, REVIEWER, { slug: SLUG }));
    await stores.transition(storeId, "ACTIVE", REVIEWER);
  });

  it("reports an address inside the radius as serviceable", async () => {
    await stores.createZone(storeId, {
      name: "Near", centerLat: LOOP.lat, centerLng: LOOP.lng,
      radiusMeters: 5000, feeCents: 499, minOrderCents: 1500, etaMinutes: 30,
    });

    // ~1.1 km north.
    const result = await stores.checkServiceability(storeId, LOOP.lat + 0.01, LOOP.lng);
    expect(result.serviceable).toBe(true);
    expect(result.zone?.feeCents).toBe(499);
    expect(result.distanceMeters).toBeGreaterThan(900);
    expect(result.distanceMeters).toBeLessThan(1300);
  });

  it("reports an address outside every radius as not serviceable", async () => {
    await stores.createZone(storeId, {
      name: "Near", centerLat: LOOP.lat, centerLng: LOOP.lng,
      radiusMeters: 2000, feeCents: 499, minOrderCents: 0, etaMinutes: 30,
    });

    // ~11 km north — well outside.
    const result = await stores.checkServiceability(storeId, LOOP.lat + 0.1, LOOP.lng);
    expect(result.serviceable).toBe(false);
    expect(result.zone).toBeUndefined();
  });

  it("picks the cheapest zone when several overlap", async () => {
    // A store drawing a small cheap zone inside a large expensive one means
    // the inner one to win — the customer should get the better price.
    await stores.createZone(storeId, {
      name: "Wide", centerLat: LOOP.lat, centerLng: LOOP.lng,
      radiusMeters: 20000, feeCents: 999, minOrderCents: 0, etaMinutes: 60,
    });
    await stores.createZone(storeId, {
      name: "Close", centerLat: LOOP.lat, centerLng: LOOP.lng,
      radiusMeters: 3000, feeCents: 299, minOrderCents: 0, etaMinutes: 20,
    });

    const result = await stores.checkServiceability(storeId, LOOP.lat + 0.005, LOOP.lng);
    expect(result.zone?.name).toBe("Close");
    expect(result.zone?.feeCents).toBe(299);
  });

  it("rejects a radius large enough to be a units mistake", async () => {
    // 50 miles entered as metres would silently promise deliveries the store
    // cannot make.
    await expect(
      stores.createZone(storeId, {
        name: "Oops", centerLat: LOOP.lat, centerLng: LOOP.lng,
        radiusMeters: 500_000, feeCents: 499, minOrderCents: 0, etaMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("treats a zone from another store as not found on delete", async () => {
    await expect(stores.deleteZone(storeId, randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

describe("branding contrast validation", () => {
  let storeId: string;

  beforeEach(async () => {
    const { id } = await submitApplication();
    ({ storeId } = await applications.approve(id, REVIEWER, { slug: SLUG }));
  });

  it("accepts a theme that meets AA", async () => {
    await expect(
      stores.updateProfile(storeId, {
        branding: {
          theme: { primary: "#1a3d5c", background: "#ffffff", text: "#1a1a1a", accent: "#8a4b08" },
        },
      }),
    ).resolves.toBeDefined();
  });

  it("rejects light grey body text on white and says by how much", async () => {
    // Rejected at save time rather than warned about: once a storefront is
    // live, nobody goes back to fix a dismissed warning.
    const err = await expectRejection(
      stores.updateProfile(storeId, {
        branding: {
          theme: { primary: "#1a3d5c", background: "#ffffff", text: "#cccccc", accent: "#8a4b08" },
        },
      }),
    );

    expect(err.status).toBe(422);
    expect(err.fieldErrors?.[0]?.code).toBe("LOW_CONTRAST");
    expect(err.fieldErrors?.[0]?.message).toMatch(/needs at least/);
  });

  it("rejects an unparseable colour rather than treating it as black", async () => {
    const err = await expectRejection(
      stores.updateProfile(storeId, {
        branding: {
          theme: { primary: "rebeccapurple", background: "#ffffff", text: "#000000", accent: "#8a4b08" },
        },
      }),
    );
    expect(err.fieldErrors?.[0]?.code).toBe("INVALID_COLOR");
  });

  it("leaves non-branding profile updates unaffected", async () => {
    const updated = await stores.updateProfile(storeId, { name: "Renamed Bakery" });
    expect(updated.name).toBe("Renamed Bakery");
  });
});
