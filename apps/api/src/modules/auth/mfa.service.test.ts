import { ConfigService } from "@nestjs/config";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { validateEnv } from "../../config/env.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { MfaService } from "./mfa.service.js";
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
  MFA_ENCRYPTION_KEY: "test-key-for-mfa-encryption-only",
});
const config = { get: (k: string) => (ENV as Record<string, unknown>)[k] } as unknown as ConfigService;

const EMAIL = "mfa-test@example.com";
const PASSWORD = "the quiet bakery on morse avenue";
const DEVICE = { ip: "127.0.0.1", userAgent: "vitest" };

let prisma: PrismaService;
let mfa: MfaService;
let auth: AuthService;
let repo: AuthRepository;

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  const tokens = new TokenService(config as never);
  await tokens.onModuleInit();
  const passwords = new PasswordService(config as never);
  repo = new AuthRepository(prisma);
  mfa = new MfaService(prisma, config as never);
  auth = new AuthService(prisma, repo, passwords, tokens, mfa, config as never);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await auth.register({ email: EMAIL, password: PASSWORD, name: "MFA Test" });
});

async function cleanup(): Promise<void> {
  const admin = new PrismaService();
  try {
    await admin.$executeRaw`
      DELETE FROM mfa_recovery_codes WHERE user_id IN (
        SELECT id FROM users WHERE email = ${EMAIL}::citext)`;
    await admin.$executeRaw`
      DELETE FROM refresh_tokens WHERE user_id IN (
        SELECT id FROM users WHERE email = ${EMAIL}::citext)`;
    await admin.$executeRaw`DELETE FROM users WHERE email = ${EMAIL}::citext`;
  } finally {
    await admin.$disconnect();
  }
}

async function userId(): Promise<string> {
  return (await repo.findUserByEmail(EMAIL))!.id;
}

/** Generates the code an authenticator app would show right now. */
function currentCode(secretBase32: string): string {
  return new OTPAuth.TOTP({
    issuer: "Local Stores",
    label: EMAIL,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

async function enrol(): Promise<{ id: string; secret: string; recoveryCodes: string[] }> {
  const id = await userId();
  const { secretBase32 } = await mfa.beginEnrollment(id, EMAIL);
  const { recoveryCodes } = await mfa.confirmEnrollment(id, EMAIL, currentCode(secretBase32));
  return { id, secret: secretBase32, recoveryCodes };
}

describe("enrollment", () => {
  it("returns a scannable otpauth URI", async () => {
    const id = await userId();
    const { otpauthUri, secretBase32 } = await mfa.beginEnrollment(id, EMAIL);

    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(otpauthUri).toContain("Local%20Stores");
    expect(secretBase32.length).toBeGreaterThan(20);
  });

  it("is not active until a code is verified", async () => {
    // A user who scans the QR then loses their phone before confirming must not
    // be locked out by a factor they never proved they had.
    const id = await userId();
    await mfa.beginEnrollment(id, EMAIL);
    expect(await mfa.isEnabled(id)).toBe(false);
  });

  it("activates and issues recovery codes once a code is verified", async () => {
    const { id, recoveryCodes } = await enrol();
    expect(await mfa.isEnabled(id)).toBe(true);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
  });

  it("rejects a wrong code at confirmation", async () => {
    const id = await userId();
    await mfa.beginEnrollment(id, EMAIL);
    await expect(mfa.confirmEnrollment(id, EMAIL, "000000")).rejects.toBeInstanceOf(AppError);
    expect(await mfa.isEnabled(id)).toBe(false);
  });

  it("stores the secret encrypted, not in the clear", async () => {
    // The TOTP secret is a bearer credential — anyone holding it generates
    // valid codes forever — so a read-only database leak must not defeat it.
    const { id, secret } = await enrol();
    const admin = new PrismaService();
    try {
      const user = await admin.user.findUnique({
        where: { id },
        select: { mfaTotpSecret: true },
      });
      expect(user?.mfaTotpSecret).toBeTruthy();
      expect(user!.mfaTotpSecret).not.toContain(secret);
      // iv.ciphertext.tag
      expect(user!.mfaTotpSecret!.split(".")).toHaveLength(3);
    } finally {
      await admin.$disconnect();
    }
  });
});

describe("login with MFA", () => {
  it("does not issue a session on password alone", async () => {
    const { secret } = await enrol();

    const outcome = await auth.login({ email: EMAIL, password: PASSWORD }, DEVICE);
    expect(outcome.kind).toBe("mfa_required");

    // The challenge carries no session — there is nothing to mistake for one.
    expect(outcome).not.toHaveProperty("session");
    expect(secret).toBeTruthy();
  });

  it("issues a session once the code is supplied", async () => {
    const { secret } = await enrol();
    const outcome = await auth.login({ email: EMAIL, password: PASSWORD }, DEVICE);
    if (outcome.kind !== "mfa_required") throw new Error("expected a challenge");

    const session = await auth.completeMfaLogin(
      outcome.challengeToken,
      currentCode(secret),
      DEVICE,
    );
    expect(session.accessToken.split(".")).toHaveLength(3);
  });

  it("rejects a wrong code at the second step", async () => {
    await enrol();
    const outcome = await auth.login({ email: EMAIL, password: PASSWORD }, DEVICE);
    if (outcome.kind !== "mfa_required") throw new Error("expected a challenge");

    await expect(
      auth.completeMfaLogin(outcome.challengeToken, "000000", DEVICE),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("will not accept a challenge token as an access token", async () => {
    // A token authorising "finish logging in" must not also authorise reading
    // a store's orders — hence the separate audience.
    const { secret } = await enrol();
    const outcome = await auth.login({ email: EMAIL, password: PASSWORD }, DEVICE);
    if (outcome.kind !== "mfa_required") throw new Error("expected a challenge");

    const tokens = new TokenService(config as never);
    await tokens.onModuleInit();
    await expect(tokens.verifyAccessToken(outcome.challengeToken)).rejects.toBeInstanceOf(AppError);
    expect(secret).toBeTruthy();
  });

  it("still logs in normally when MFA is off", async () => {
    const outcome = await auth.login({ email: EMAIL, password: PASSWORD }, DEVICE);
    expect(outcome.kind).toBe("session");
  });
});

describe("recovery codes", () => {
  it("accepts a recovery code in place of a TOTP code", async () => {
    const { recoveryCodes } = await enrol();
    const outcome = await auth.login({ email: EMAIL, password: PASSWORD }, DEVICE);
    if (outcome.kind !== "mfa_required") throw new Error("expected a challenge");

    const session = await auth.completeMfaLogin(
      outcome.challengeToken,
      recoveryCodes[0]!,
      DEVICE,
    );
    expect(session.accessToken).toBeTruthy();
  });

  it("burns a recovery code after one use", async () => {
    const { id, recoveryCodes } = await enrol();
    expect(await mfa.verifyChallenge(id, EMAIL, recoveryCodes[0]!)).toBe(true);
    expect(await mfa.verifyChallenge(id, EMAIL, recoveryCodes[0]!)).toBe(false);
  });

  it("leaves the other codes usable", async () => {
    const { id, recoveryCodes } = await enrol();
    await mfa.verifyChallenge(id, EMAIL, recoveryCodes[0]!);
    expect(await mfa.verifyChallenge(id, EMAIL, recoveryCodes[1]!)).toBe(true);
  });

  it("stores codes hashed", async () => {
    const { id, recoveryCodes } = await enrol();
    const admin = new PrismaService();
    try {
      const stored = await admin.mfaRecoveryCode.findMany({ where: { userId: id } });
      for (const row of stored) {
        expect(recoveryCodes).not.toContain(row.codeHash);
      }
      expect(stored).toHaveLength(10);
    } finally {
      await admin.$disconnect();
    }
  });

  it("invalidates old codes when regenerated", async () => {
    const { id, recoveryCodes } = await enrol();
    await mfa.regenerateRecoveryCodes(id);
    expect(await mfa.verifyChallenge(id, EMAIL, recoveryCodes[0]!)).toBe(false);
  });
});

describe("disabling MFA", () => {
  it("removes the factor and its recovery codes", async () => {
    const { id, recoveryCodes } = await enrol();
    await mfa.disable(id);

    expect(await mfa.isEnabled(id)).toBe(false);
    expect(await mfa.verifyChallenge(id, EMAIL, recoveryCodes[0]!)).toBe(false);

    // Login goes back to single-factor.
    const outcome = await auth.login({ email: EMAIL, password: PASSWORD }, DEVICE);
    expect(outcome.kind).toBe("session");
  });

  it("verifyChallenge returns false for a user without MFA", async () => {
    const id = await userId();
    expect(await mfa.verifyChallenge(id, EMAIL, "123456")).toBe(false);
  });

  it("does not accept a code from a different user's secret", async () => {
    const { secret } = await enrol();
    const strangerId = randomUUID();
    expect(await mfa.verifyChallenge(strangerId, EMAIL, currentCode(secret))).toBe(false);
  });
});
