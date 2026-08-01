import { ConfigService } from "@nestjs/config";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { validateEnv } from "../../config/env.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { MfaService } from "./mfa.service.js";
import { OAuthService, type OAuthProfile } from "./oauth.service.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";

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

const EMAIL = "oauth-test@example.com";
const PASSWORD = "the quiet bakery on morse avenue";

let prisma: PrismaService;
let oauth: OAuthService;
let auth: AuthService;
let repo: AuthRepository;

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  const tokens = new TokenService(config as never);
  await tokens.onModuleInit();
  const passwords = new PasswordService(config as never);
  repo = new AuthRepository(prisma);
  const mfa = new MfaService(prisma, config as never);
  auth = new AuthService(prisma, repo, passwords, tokens, mfa, config as never);
  oauth = new OAuthService(prisma, repo);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(cleanup);

async function cleanup(): Promise<void> {
  const admin = new PrismaService();
  try {
    await admin.$executeRaw`
      DELETE FROM auth_identities WHERE user_id IN (
        SELECT id FROM users WHERE email = ${EMAIL}::citext)`;
    await admin.$executeRaw`
      DELETE FROM refresh_tokens WHERE user_id IN (
        SELECT id FROM users WHERE email = ${EMAIL}::citext)`;
    await admin.$executeRaw`DELETE FROM users WHERE email = ${EMAIL}::citext`;
  } finally {
    await admin.$disconnect();
  }
}

const verifiedProfile: OAuthProfile = {
  provider: "GOOGLE",
  providerUid: "google-uid-12345",
  email: EMAIL,
  emailVerified: true,
  name: "OAuth Test",
};

const unverifiedProfile: OAuthProfile = { ...verifiedProfile, emailVerified: false };

describe("first sign-in", () => {
  it("creates an account when nobody holds the address", async () => {
    const result = await oauth.resolveProfile(verifiedProfile);
    expect(result.created).toBe(true);

    const user = await repo.findUserByEmail(EMAIL);
    expect(user?.id).toBe(result.userId);
    // No password: this account signs in through the provider.
    expect(user?.passwordHash).toBeNull();
  });

  it("marks the address verified without a separate round-trip", async () => {
    const { userId } = await oauth.resolveProfile(verifiedProfile);
    const admin = new PrismaService();
    try {
      const user = await admin.user.findUnique({
        where: { id: userId },
        select: { emailVerifiedAt: true },
      });
      expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    } finally {
      await admin.$disconnect();
    }
  });

  it("refuses to create an account from an unverified address", async () => {
    // Otherwise someone could squat an address they do not control, and block
    // its real owner from ever registering it.
    await expect(oauth.resolveProfile(unverifiedProfile)).rejects.toBeInstanceOf(AppError);
  });
});

describe("returning sign-in", () => {
  it("resolves to the same account without relinking", async () => {
    const first = await oauth.resolveProfile(verifiedProfile);
    const second = await oauth.resolveProfile(verifiedProfile);

    expect(second.userId).toBe(first.userId);
    expect(second.created).toBe(false);
    expect(second.linked).toBe(false);
  });

  it("matches on provider uid, not email", async () => {
    // A Google account whose address changed must still resolve to the same
    // local user — the uid is the stable identifier.
    const first = await oauth.resolveProfile(verifiedProfile);
    const renamed = { ...verifiedProfile, email: "renamed@example.com" };

    const second = await oauth.resolveProfile(renamed);
    expect(second.userId).toBe(first.userId);
  });
});

describe("linking to an existing password account", () => {
  beforeEach(async () => {
    await auth.register({ email: EMAIL, password: PASSWORD, name: "Password User" });
  });

  it("links when the provider verified the address", async () => {
    const existing = await repo.findUserByEmail(EMAIL);
    const result = await oauth.resolveProfile(verifiedProfile);

    expect(result.userId).toBe(existing!.id);
    expect(result.linked).toBe(true);
    expect(result.created).toBe(false);
  });

  it("refuses to link an unverified address — the takeover vector", async () => {
    // Anyone able to create a provider account carrying an arbitrary
    // unverified address could otherwise claim a victim's local account.
    // Google reports email_verified: false for some Workspace setups, so this
    // is a real case rather than a theoretical one.
    const err = await expectRejection(oauth.resolveProfile(unverifiedProfile));
    expect(err.code).toBe("FORBIDDEN");

    const identities = await countIdentities();
    expect(identities).toBe(0);
  });

  it("leaves the password login working after linking", async () => {
    await oauth.resolveProfile(verifiedProfile);
    const outcome = await auth.login({ email: EMAIL, password: PASSWORD }, { ip: "127.0.0.1" });
    expect(outcome.kind).toBe("session");
  });
});

describe("unlinking", () => {
  it("refuses to remove the only sign-in method", async () => {
    // An account with no password and no identities is unreachable.
    const { userId } = await oauth.resolveProfile(verifiedProfile);
    const [identity] = await oauth.listIdentities(userId);

    await expect(oauth.unlinkIdentity(userId, identity!.id)).rejects.toBeInstanceOf(AppError);
  });

  it("allows removal when a password remains", async () => {
    await auth.register({ email: EMAIL, password: PASSWORD, name: "Password User" });
    const { userId } = await oauth.resolveProfile(verifiedProfile);
    const [identity] = await oauth.listIdentities(userId);

    await expect(oauth.unlinkIdentity(userId, identity!.id)).resolves.toBeUndefined();
    expect(await oauth.listIdentities(userId)).toHaveLength(0);
  });

  it("treats another user's identity as not found", async () => {
    const { userId } = await oauth.resolveProfile(verifiedProfile);
    await expect(
      oauth.unlinkIdentity(userId, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(AppError);
  });
});

async function countIdentities(): Promise<number> {
  const admin = new PrismaService();
  try {
    return admin.authIdentity.count({
      where: { user: { email: EMAIL } },
    });
  } finally {
    await admin.$disconnect();
  }
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
