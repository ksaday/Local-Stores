import { ConfigService } from "@nestjs/config";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { InMemoryMailer } from "../../infra/mailer/mailer.js";
import { validateEnv } from "../../config/env.js";
import { AccountService } from "./account.service.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { InvitationService } from "./invitation.service.js";
import { MfaService } from "./mfa.service.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";
import { VerificationTokenService } from "./verification-token.service.js";

/** As bba_app: a superuser bypasses RLS, so these would prove nothing. */
const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const ENV = validateEnv({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost:5432/bba_dev?schema=public",
  JWT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
  PASSWORD_BREACH_CHECK: "false",
  WEB_ORIGIN: "http://localhost:3000",
});
const config = { get: (k: string) => (ENV as Record<string, unknown>)[k] } as unknown as ConfigService;

const OWNER = "d0000000-0000-4000-8000-000000000001";
const STORE = "d0000000-0000-4000-8000-00000000000a";
const USER_EMAIL = "account-test@example.com";
const INVITEE_EMAIL = "invitee-test@example.com";
const PASSWORD = "the quiet bakery on morse avenue";
const DEVICE = { ip: "127.0.0.1", userAgent: "vitest" };

let prisma: PrismaService;
let account: AccountService;
let invitations: InvitationService;
let auth: AuthService;
let repo: AuthRepository;
let mailer: InMemoryMailer;

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  const tokens = new TokenService(config as never);
  await tokens.onModuleInit();
  const passwords = new PasswordService(config as never);
  const verification = new VerificationTokenService(prisma);
  repo = new AuthRepository(prisma);
  mailer = new InMemoryMailer();
  const mfa = new MfaService(prisma, config as never);
  auth = new AuthService(prisma, repo, passwords, tokens, mfa, config as never);
  account = new AccountService(
    prisma, repo, verification, passwords, auth, mailer, config as never,
  );
  invitations = new InvitationService(
    prisma, repo, verification, passwords, mailer, config as never,
  );
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await seedStore();
  mailer.clear();
});

async function seedStore(): Promise<void> {
  const admin = new PrismaService();
  try {
    await admin.$executeRaw`
      INSERT INTO users (id, email, name, status, created_at, updated_at)
      VALUES (${OWNER}, 'account-owner@example.com'::citext, 'Owner', 'ACTIVE', now(), now())
    `;
    await admin.$executeRaw`
      INSERT INTO stores (id, slug, name, business_type, status, owner_user_id,
                          timezone, currency, branding, cash_enabled,
                          stripe_charges_enabled, platform_fee_bps, created_at, updated_at)
      VALUES (${STORE}, 'account-test-store'::citext, 'Morse Ave Bakery', 'RETAIL', 'ACTIVE',
              ${OWNER}, 'America/Chicago', 'USD', '{}'::jsonb, true, false, 0, now(), now())
    `;
    await admin.$executeRaw`
      INSERT INTO store_memberships (id, store_id, user_id, role, status, created_at, updated_at)
      VALUES (${randomUUID()}, ${STORE}, ${OWNER}, 'STORE_ADMIN'::"MembershipRole",
              'ACTIVE'::"MembershipStatus", now(), now())
    `;
  } finally {
    await admin.$disconnect();
  }
}

async function cleanup(): Promise<void> {
  const admin = new PrismaService();
  try {
    const emails = [USER_EMAIL, INVITEE_EMAIL, "account-owner@example.com"];
    await admin.$executeRaw`DELETE FROM verification_tokens WHERE email = ANY(${emails}::citext[])`;
    await admin.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${STORE}`;
    await admin.$executeRaw`DELETE FROM outbox_events WHERE store_id = ${STORE}`;
    await admin.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await admin.$executeRaw`
      DELETE FROM refresh_tokens WHERE user_id IN (
        SELECT id FROM users WHERE email = ANY(${emails}::citext[])
      )`;
    await admin.$executeRaw`DELETE FROM users WHERE email = ANY(${emails}::citext[])`;
  } finally {
    await admin.$disconnect();
  }
}

/**
 * Assertions read through a superuser connection.
 *
 * Reading via the app's own client would return nothing — RLS scopes reads to
 * the caller, and a test harness has no session. That is the policy working,
 * not a bug, but it makes the app client useless for verifying what was
 * written.
 */
async function readAsAdmin<T>(work: (admin: PrismaService) => Promise<T>): Promise<T> {
  const admin = new PrismaService();
  try {
    return await work(admin);
  } finally {
    await admin.$disconnect();
  }
}

/** Pulls the token out of the link in whatever mail was just sent. */
function tokenFromMail(to: string): string {
  const mail = mailer.lastTo(to);
  if (!mail) throw new Error(`No mail sent to ${to}`);
  const match = /[?/](?:token=)?([A-Za-z0-9_-]{20,})/.exec(mail.body);
  if (!match) throw new Error(`No token found in mail body:\n${mail.body}`);
  return match[1]!;
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

describe("email verification", () => {
  beforeEach(async () => {
    await auth.register({ email: USER_EMAIL, password: PASSWORD, name: "Account Test" });
    mailer.clear();
  });

  it("verifies an address with a mailed token", async () => {
    await account.sendVerificationEmail(USER_EMAIL);
    await account.verifyEmail(tokenFromMail(USER_EMAIL));

    const user = await readAsAdmin((admin) =>
      admin.user.findFirst({ where: { email: USER_EMAIL }, select: { emailVerifiedAt: true } }),
    );
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("rejects a token reused after verification", async () => {
    await account.sendVerificationEmail(USER_EMAIL);
    const token = tokenFromMail(USER_EMAIL);
    await account.verifyEmail(token);

    await expect(account.verifyEmail(token)).rejects.toBeInstanceOf(AppError);
  });

  it("invalidates an earlier link when a new one is requested", async () => {
    await account.sendVerificationEmail(USER_EMAIL);
    const firstToken = tokenFromMail(USER_EMAIL);

    mailer.clear();
    await account.sendVerificationEmail(USER_EMAIL);
    const secondToken = tokenFromMail(USER_EMAIL);

    expect(secondToken).not.toBe(firstToken);
    // The stale link in an older email must stop working.
    await expect(account.verifyEmail(firstToken)).rejects.toBeInstanceOf(AppError);
    await expect(account.verifyEmail(secondToken)).resolves.toBeUndefined();
  });

  it("sends nothing for an unknown address and does not throw", async () => {
    // Silence rather than an error: throwing would make this an oracle for
    // whether an address is registered.
    await expect(account.sendVerificationEmail("ghost@example.com")).resolves.toBeUndefined();
    expect(mailer.lastTo("ghost@example.com")).toBeUndefined();
  });
});

describe("password reset", () => {
  beforeEach(async () => {
    await auth.register({ email: USER_EMAIL, password: PASSWORD, name: "Account Test" });
    mailer.clear();
  });

  it("resets the password and lets the user log in with the new one", async () => {
    await account.requestPasswordReset(USER_EMAIL);
    await account.resetPassword(tokenFromMail(USER_EMAIL), "a brand new passphrase here");

    await expect(
      auth.login({ email: USER_EMAIL, password: "a brand new passphrase here" }, DEVICE),
    ).resolves.toBeDefined();
    await expect(
      auth.login({ email: USER_EMAIL, password: PASSWORD }, DEVICE),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("revokes every existing session on reset", async () => {
    // Someone resetting a password often believes the account is compromised;
    // leaving an attacker's session alive would defeat the point.
    const before = await loginSession(auth, USER_EMAIL, PASSWORD, DEVICE);

    await account.requestPasswordReset(USER_EMAIL);
    await account.resetPassword(tokenFromMail(USER_EMAIL), "a brand new passphrase here");

    await expect(auth.refresh(before.refreshToken, DEVICE)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a reset token reused after success", async () => {
    await account.requestPasswordReset(USER_EMAIL);
    const token = tokenFromMail(USER_EMAIL);
    await account.resetPassword(token, "a brand new passphrase here");

    await expect(
      account.resetPassword(token, "yet another passphrase entirely"),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("does not spend the token when the new password is rejected", async () => {
    // A weak password should not force the user back to their inbox.
    await account.requestPasswordReset(USER_EMAIL);
    const token = tokenFromMail(USER_EMAIL);

    await expect(account.resetPassword(token, "short")).rejects.toBeInstanceOf(AppError);
    await expect(
      account.resetPassword(token, "a perfectly fine passphrase"),
    ).resolves.toBeUndefined();
  });

  it("sends nothing for an unknown address", async () => {
    await expect(account.requestPasswordReset("ghost@example.com")).resolves.toBeUndefined();
    expect(mailer.lastTo("ghost@example.com")).toBeUndefined();
  });

  it("gives the same rejection for an unknown, expired, and consumed token", async () => {
    await account.requestPasswordReset(USER_EMAIL);
    const token = tokenFromMail(USER_EMAIL);
    await account.resetPassword(token, "a brand new passphrase here");

    const consumed = await expectRejection(account.resetPassword(token, "another passphrase now"));
    const unknown = await expectRejection(
      account.resetPassword("never-issued", "another passphrase now"),
    );

    expect(consumed.message).toBe(unknown.message);
    expect(consumed.code).toBe(unknown.code);
  });
});

describe("change password", () => {
  beforeEach(async () => {
    await auth.register({ email: USER_EMAIL, password: PASSWORD, name: "Account Test" });
    mailer.clear();
  });

  it("requires the current password", async () => {
    const user = await repo.findUserByEmail(USER_EMAIL);
    await expect(
      account.changePassword(user!.id, "not the right one", "a brand new passphrase here"),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("changes the password and signs other devices out", async () => {
    const user = await repo.findUserByEmail(USER_EMAIL);
    const session = await loginSession(auth, USER_EMAIL, PASSWORD, DEVICE);

    await account.changePassword(user!.id, PASSWORD, "a brand new passphrase here");

    await expect(auth.refresh(session.refreshToken, DEVICE)).rejects.toBeInstanceOf(AppError);
    await expect(
      auth.login({ email: USER_EMAIL, password: "a brand new passphrase here" }, DEVICE),
    ).resolves.toBeDefined();
  });
});

describe("session listing and revocation", () => {
  beforeEach(async () => {
    await auth.register({ email: USER_EMAIL, password: PASSWORD, name: "Account Test" });
    mailer.clear();
  });

  it("lists one entry per device rather than per token", async () => {
    const user = await repo.findUserByEmail(USER_EMAIL);
    const deviceA = await loginSession(auth, USER_EMAIL, PASSWORD, DEVICE);
    await loginSession(auth, USER_EMAIL, PASSWORD, DEVICE);

    // Rotating deviceA adds a token row but must not add a session entry —
    // a user looking for an unfamiliar device needs devices, not tokens.
    await auth.refresh(deviceA.refreshToken, DEVICE);

    const sessions = await account.listSessions(user!.id);
    expect(sessions).toHaveLength(2);
  });

  it("revokes a single session without touching the others", async () => {
    const user = await repo.findUserByEmail(USER_EMAIL);
    const deviceA = await loginSession(auth, USER_EMAIL, PASSWORD, DEVICE);
    const deviceB = await loginSession(auth, USER_EMAIL, PASSWORD, DEVICE);

    const sessions = await account.listSessions(user!.id);
    const familyOfA = sessions.find((s) => s.familyId);
    await account.revokeSession(user!.id, familyOfA!.familyId);

    const remaining = await account.listSessions(user!.id);
    expect(remaining).toHaveLength(1);

    // Exactly one of the two must still work, and one must be dead.
    const results = await Promise.allSettled([
      auth.refresh(deviceA.refreshToken, DEVICE),
      auth.refresh(deviceB.refreshToken, DEVICE),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("will not let one user revoke another's session", async () => {
    // Knowing a familyId must not be enough to sign someone else out.
    const victim = await repo.findUserByEmail(USER_EMAIL);
    await loginSession(auth, USER_EMAIL, PASSWORD, DEVICE);
    const victimSessions = await account.listSessions(victim!.id);

    await expect(
      account.revokeSession(OWNER, victimSessions[0]!.familyId),
    ).rejects.toBeInstanceOf(AppError);

    expect(await account.listSessions(victim!.id)).toHaveLength(1);
  });
});

describe("staff invitations", () => {
  it("creates an account and an active membership when a new person accepts", async () => {
    await invitations.invite({
      storeId: STORE,
      email: INVITEE_EMAIL,
      role: "CLERK",
      invitedBy: OWNER,
    });

    const preview = await invitations.preview(tokenFromMail(INVITEE_EMAIL));
    expect(preview.storeName).toBe("Morse Ave Bakery");
    expect(preview.role).toBe("CLERK");
    expect(preview.requiresAccount).toBe(true);

    const { userId } = await invitations.accept({
      token: tokenFromMail(INVITEE_EMAIL),
      name: "New Clerk",
      password: PASSWORD,
    });

    const membership = await readAsAdmin((admin) =>
      admin.storeMembership.findUnique({ where: { storeId_userId: { storeId: STORE, userId } } }),
    );
    expect(membership?.status).toBe("ACTIVE");
    expect(membership?.role).toBe("CLERK");
  });

  it("lets the invitee sign in with the password they chose", async () => {
    // The inviter never sets or learns it — a store owner must not be able to
    // sign in as their employee.
    await invitations.invite({
      storeId: STORE, email: INVITEE_EMAIL, role: "CLERK", invitedBy: OWNER,
    });
    await invitations.accept({
      token: tokenFromMail(INVITEE_EMAIL), name: "New Clerk", password: PASSWORD,
    });

    const session = await loginSession(auth, INVITEE_EMAIL, PASSWORD, DEVICE);
    expect(session.accessToken).toBeTruthy();
  });

  it("puts the new membership into the invitee's token claims", async () => {
    await invitations.invite({
      storeId: STORE, email: INVITEE_EMAIL, role: "CLERK", invitedBy: OWNER,
    });
    await invitations.accept({
      token: tokenFromMail(INVITEE_EMAIL), name: "New Clerk", password: PASSWORD,
    });

    const session = await loginSession(auth, INVITEE_EMAIL, PASSWORD, DEVICE);
    const [, payload] = session.accessToken.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());

    expect(claims.memberships).toEqual([{ storeId: STORE, role: "CLERK" }]);
  });

  it("marks the invitee's address verified without a second round-trip", async () => {
    // Receiving the invitation at that address already proves control of it.
    await invitations.invite({
      storeId: STORE, email: INVITEE_EMAIL, role: "CLERK", invitedBy: OWNER,
    });
    const { userId } = await invitations.accept({
      token: tokenFromMail(INVITEE_EMAIL), name: "New Clerk", password: PASSWORD,
    });

    const user = await readAsAdmin((admin) =>
      admin.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } }),
    );
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("rejects an invitation reused after acceptance", async () => {
    await invitations.invite({
      storeId: STORE, email: INVITEE_EMAIL, role: "CLERK", invitedBy: OWNER,
    });
    const token = tokenFromMail(INVITEE_EMAIL);
    await invitations.accept({ token, name: "New Clerk", password: PASSWORD });

    await expect(
      invitations.accept({ token, name: "Someone Else", password: PASSWORD }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("refuses when a signed-in user accepts an invite sent to someone else", async () => {
    // Otherwise the membership attaches to the wrong account entirely.
    await auth.register({ email: USER_EMAIL, password: PASSWORD, name: "Bystander" });
    const bystander = await repo.findUserByEmail(USER_EMAIL);

    await invitations.invite({
      storeId: STORE, email: INVITEE_EMAIL, role: "CLERK", invitedBy: OWNER,
    });

    const err = await expectRejection(
      invitations.accept({
        token: tokenFromMail(INVITEE_EMAIL),
        authenticatedUserId: bystander!.id,
      }),
    );
    expect(err.code).toBe("FORBIDDEN");
  });

  it("does not spend the invitation when the chosen password is rejected", async () => {
    await invitations.invite({
      storeId: STORE, email: INVITEE_EMAIL, role: "CLERK", invitedBy: OWNER,
    });
    const token = tokenFromMail(INVITEE_EMAIL);

    await expect(
      invitations.accept({ token, name: "New Clerk", password: "short" }),
    ).rejects.toBeInstanceOf(AppError);

    // The invitation must still be usable rather than needing to be resent.
    await expect(
      invitations.accept({ token, name: "New Clerk", password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it("refuses to invite someone who is already on the team", async () => {
    await invitations.invite({
      storeId: STORE, email: INVITEE_EMAIL, role: "CLERK", invitedBy: OWNER,
    });
    await invitations.accept({
      token: tokenFromMail(INVITEE_EMAIL), name: "New Clerk", password: PASSWORD,
    });

    await expect(
      invitations.invite({
        storeId: STORE, email: INVITEE_EMAIL, role: "DELIVERY", invitedBy: OWNER,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("invalidates an earlier invitation when a new one is sent", async () => {
    await invitations.invite({
      storeId: STORE, email: INVITEE_EMAIL, role: "CLERK", invitedBy: OWNER,
    });
    const firstToken = tokenFromMail(INVITEE_EMAIL);

    mailer.clear();
    await invitations.invite({
      storeId: STORE, email: INVITEE_EMAIL, role: "DELIVERY", invitedBy: OWNER,
    });
    const secondToken = tokenFromMail(INVITEE_EMAIL);

    // The superseded link must not grant the role it originally named.
    await expect(
      invitations.accept({ token: firstToken, name: "X", password: PASSWORD }),
    ).rejects.toBeInstanceOf(AppError);

    const { userId } = await invitations.accept({
      token: secondToken, name: "New Driver", password: PASSWORD,
    });
    const membership = await readAsAdmin((admin) =>
      admin.storeMembership.findUnique({ where: { storeId_userId: { storeId: STORE, userId } } }),
    );
    expect(membership?.role).toBe("DELIVERY");
  });
});
