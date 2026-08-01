import { ConfigService } from "@nestjs/config";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { MfaService } from "./mfa.service.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";

/**
 * Runs against the RLS-restricted `bba_app` role, not the migration superuser.
 *
 * This is deliberate and load-bearing: a superuser bypasses RLS entirely, so
 * these tests would pass against a configuration that cannot actually work in
 * production. Running as bba_app is what proves the SECURITY DEFINER auth
 * lookups (migration 00000000000002) genuinely solve the pre-identity problem.
 */
const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const env: Record<string, unknown> = {
  JWT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
  JWT_ISSUER: "bba-test",
  JWT_AUDIENCE: "bba-api-test",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 2592000,
  PASSWORD_BREACH_CHECK: false,
};
const config = { get: (k: string) => env[k] } as unknown as ConfigService;

let prisma: PrismaService;
let auth: AuthService;

const EMAIL = "rotation-test@example.com";
const PASSWORD = "the quiet bakery on morse avenue";
const DEVICE = { ip: "127.0.0.1", userAgent: "vitest" };

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  const tokens = new TokenService(config as never);
  await tokens.onModuleInit();
  const passwords = new PasswordService(config as never);
  const mfa = new MfaService(prisma, config as never);
  auth = new AuthService(prisma, new AuthRepository(prisma), passwords, tokens, mfa, config as never);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(cleanup);

/**
 * Awaits a call that must reject, and returns the AppError it threw. Fails the
 * test if it resolves — so a security assertion can never silently pass because
 * the operation unexpectedly succeeded.
 */
async function expectRejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("Expected the call to reject, but it resolved.");
}

/**
 * Unwraps a login expected to complete without a second factor, so a test can
 * never quietly assert against an unfinished login.
 */
async function loginSession(email: string, password: string) {
  const outcome = await auth.login({ email, password }, DEVICE);
  if (outcome.kind !== "session") throw new Error("Expected a session, got an MFA challenge.");
  return outcome.session;
}

/** Superuser connection: fixtures must not be subject to the policies under test. */
async function cleanup(): Promise<void> {
  const admin = new PrismaService();
  try {
    const users = await admin.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${EMAIL}::citext
    `;
    for (const u of users) {
      await admin.$executeRaw`DELETE FROM refresh_tokens WHERE user_id = ${u.id}`;
      await admin.$executeRaw`DELETE FROM users WHERE id = ${u.id}`;
    }
  } finally {
    await admin.$disconnect();
  }
}

describe("registration and login as the RLS-restricted role", () => {
  it("registers a user and logs them in", async () => {
    await auth.register({ email: EMAIL, password: PASSWORD, name: "Rotation Test" });
    const session = await loginSession(EMAIL, PASSWORD);

    expect(session.accessToken.split(".")).toHaveLength(3);
    expect(session.refreshToken.length).toBeGreaterThan(20);
  });

  it("rejects a wrong password", async () => {
    await auth.register({ email: EMAIL, password: PASSWORD, name: "Rotation Test" });
    await expect(
      loginSession(EMAIL, "wrong password entirely"),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("gives the same error for an unknown account as for a wrong password", async () => {
    // User enumeration check: the two paths must be indistinguishable.
    await auth.register({ email: EMAIL, password: PASSWORD, name: "Rotation Test" });

    const wrongPassword = await expectRejection(
      loginSession(EMAIL, "wrong password entirely"),
    );
    const noSuchUser = await expectRejection(
      loginSession("ghost@example.com", PASSWORD),
    );

    expect(noSuchUser.message).toBe(wrongPassword.message);
    expect(noSuchUser.status).toBe(wrongPassword.status);
    expect(noSuchUser.code).toBe(wrongPassword.code);
  });

  it("does not reveal that an email is already registered", async () => {
    await auth.register({ email: EMAIL, password: PASSWORD, name: "First" });
    // A second registration for the same address returns the same shape as the
    // first rather than an error, so the endpoint is not an email oracle.
    await expect(
      auth.register({ email: EMAIL, password: "a completely different passphrase", name: "Second" }),
    ).resolves.toEqual({ status: "ok" });

    // ...and the original account is untouched.
    await expect(loginSession(EMAIL, PASSWORD)).resolves.toBeDefined();
  });
});

describe("refresh token rotation", () => {
  beforeEach(async () => {
    await auth.register({ email: EMAIL, password: PASSWORD, name: "Rotation Test" });
  });

  it("issues a new refresh token on every use", async () => {
    const first = await loginSession(EMAIL, PASSWORD);
    const second = await auth.refresh(first.refreshToken, DEVICE);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).toBeTruthy();
  });

  it("rejects a token that has already been rotated", async () => {
    const first = await loginSession(EMAIL, PASSWORD);
    await auth.refresh(first.refreshToken, DEVICE);

    await expect(auth.refresh(first.refreshToken, DEVICE)).rejects.toBeInstanceOf(AppError);
  });

  it("revokes the entire family when a rotated token is replayed", async () => {
    // The theft scenario: an attacker captures token A, the legitimate client
    // rotates it to B, then the attacker replays A. We cannot tell which party
    // is which, so both are cut off and the user re-authenticates.
    const first = await loginSession(EMAIL, PASSWORD);
    const second = await auth.refresh(first.refreshToken, DEVICE);

    await expect(auth.refresh(first.refreshToken, DEVICE)).rejects.toBeInstanceOf(AppError);

    // The still-valid successor must now also be dead.
    await expect(auth.refresh(second.refreshToken, DEVICE)).rejects.toBeInstanceOf(AppError);
  });

  it("leaves other login sessions alive when one family is revoked", async () => {
    // Two independent logins are separate families — a compromise of one
    // device must not sign the user out everywhere.
    const deviceA = await loginSession(EMAIL, PASSWORD);
    const deviceB = await loginSession(EMAIL, PASSWORD);

    await auth.refresh(deviceA.refreshToken, DEVICE);
    await expect(auth.refresh(deviceA.refreshToken, DEVICE)).rejects.toBeInstanceOf(AppError);

    await expect(auth.refresh(deviceB.refreshToken, DEVICE)).resolves.toBeDefined();
  });

  it("rejects a token that was never issued", async () => {
    await expect(auth.refresh("not-a-real-token", DEVICE)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a token after logout", async () => {
    const session = await loginSession(EMAIL, PASSWORD);
    await auth.logout(session.refreshToken);

    await expect(auth.refresh(session.refreshToken, DEVICE)).rejects.toBeInstanceOf(AppError);
  });

  it("revokeAllSessions kills every family for the user", async () => {
    const a = await loginSession(EMAIL, PASSWORD);
    const b = await loginSession(EMAIL, PASSWORD);

    const user = await loginSession(EMAIL, PASSWORD)
      .then(() => new AuthRepository(prisma).findUserByEmail(EMAIL));

    const revoked = await auth.revokeAllSessions(user!.id);
    expect(revoked).toBeGreaterThanOrEqual(3);

    await expect(auth.refresh(a.refreshToken, DEVICE)).rejects.toBeInstanceOf(AppError);
    await expect(auth.refresh(b.refreshToken, DEVICE)).rejects.toBeInstanceOf(AppError);
  });

  it("gives an identical error for replayed, unknown, and revoked tokens", async () => {
    // A stolen token must not reveal whether it was ever valid.
    const session = await loginSession(EMAIL, PASSWORD);
    await auth.refresh(session.refreshToken, DEVICE);

    const replayed = await expectRejection(auth.refresh(session.refreshToken, DEVICE));
    const unknown = await expectRejection(auth.refresh("never-issued-token", DEVICE));

    expect(replayed.message).toBe(unknown.message);
    expect(replayed.code).toBe(unknown.code);
    expect(replayed.status).toBe(unknown.status);
  });
});
