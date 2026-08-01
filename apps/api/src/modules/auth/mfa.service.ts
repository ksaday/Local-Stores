import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as OTPAuth from "otpauth";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import type { Env } from "../../config/env.js";

export interface MfaEnrollment {
  /** Shown as a QR code; also printable for manual entry. */
  otpauthUri: string;
  secretBase32: string;
}

const ISSUER = "Local Stores";
const RECOVERY_CODE_COUNT = 10;

/**
 * Allow one step either side of now (±30s). Phone clocks drift, and a user who
 * types a correct code that is rejected because their clock is 20 seconds fast
 * will conclude MFA is broken and turn it off.
 */
const WINDOW = 1;

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Begin enrollment. The secret is stored immediately but `mfaEnabledAt` stays
   * null until a code is verified — otherwise a user who scans the QR and then
   * loses their phone before confirming would be locked out by a factor they
   * never proved they had.
   */
  async beginEnrollment(userId: string, email: string): Promise<MfaEnrollment> {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      label: email,
      algorithm: "SHA1", // what every authenticator app implements
      digits: 6,
      period: 30,
      secret,
    });

    await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { mfaTotpSecret: this.encrypt(secret.base32), mfaEnabledAt: null },
      }),
    );

    return { otpauthUri: totp.toString(), secretBase32: secret.base32 };
  }

  /** Confirms the user can actually generate codes, then activates MFA. */
  async confirmEnrollment(
    userId: string,
    email: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { mfaTotpSecret: true } }),
    );
    if (!user?.mfaTotpSecret) throw AppError.validation("Start MFA setup first.");

    if (!this.verifyCode(this.decrypt(user.mfaTotpSecret), email, code)) {
      throw AppError.validation("That code isn't right. Check your authenticator app and try again.");
    }

    const recoveryCodes = await this.regenerateRecoveryCodes(userId);

    await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.update({ where: { id: userId }, data: { mfaEnabledAt: new Date() } }),
    );

    this.logger.log(`MFA enabled for user=${userId}`);
    return { recoveryCodes };
  }

  async isEnabled(userId: string): Promise<boolean> {
    const user = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { mfaEnabledAt: true } }),
    );
    return Boolean(user?.mfaEnabledAt);
  }

  /**
   * Verify a login challenge: either a TOTP code or a recovery code.
   *
   * Recovery codes are checked second and consumed atomically, so a code that
   * happens to look like a TOTP digit string cannot burn a recovery code.
   */
  async verifyChallenge(userId: string, email: string, code: string): Promise<boolean> {
    const user = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { mfaTotpSecret: true, mfaEnabledAt: true },
      }),
    );
    if (!user?.mfaEnabledAt || !user.mfaTotpSecret) return false;

    if (this.verifyCode(this.decrypt(user.mfaTotpSecret), email, code)) return true;

    return this.consumeRecoveryCode(userId, code);
  }

  async disable(userId: string): Promise<void> {
    await this.prisma.withTenant({ userId, isSuperAdmin: false }, async (tx) => {
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: { mfaTotpSecret: null, mfaEnabledAt: null },
      });
    });
    this.logger.warn(`MFA disabled for user=${userId}`);
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      // Base32-ish, grouped for legibility when written down.
      randomBytes(5).toString("hex").toUpperCase().match(/.{1,5}/g)!.join("-"),
    );

    await this.prisma.withTenant({ userId, isSuperAdmin: false }, async (tx) => {
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      for (const code of codes) {
        await tx.mfaRecoveryCode.create({ data: { userId, codeHash: hashCode(code) } });
      }
    });

    // Returned once, in plaintext, and never again — same rule as the secret.
    return codes;
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const normalized = code.trim().toUpperCase();
    const rows = await this.prisma.unscoped().$queryRaw<{ id: string }[]>`
      SELECT * FROM auth_consume_recovery_code(${userId}, ${hashCode(normalized)})
    `;
    if (rows.length > 0) {
      this.logger.warn(`Recovery code used for user=${userId}`);
      return true;
    }
    return false;
  }

  private verifyCode(secretBase32: string, email: string, code: string): boolean {
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      label: email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    // `validate` returns the time-step delta, or null. Anything within ±1 step
    // is accepted; null means no match.
    return totp.validate({ token: code.trim(), window: WINDOW }) !== null;
  }

  /**
   * AES-256-GCM. The TOTP secret is a bearer credential — anyone holding it can
   * generate valid codes forever — so it does not sit in the database in the
   * clear, where a read-only leak would silently defeat the second factor.
   */
  private encrypt(plaintext: string): string {
    const key = this.encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
  }

  private decrypt(payload: string): string {
    const [ivB64, dataB64, tagB64] = payload.split(".");
    if (!ivB64 || !dataB64 || !tagB64) throw new Error("Malformed MFA secret payload");

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey(),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  private encryptionKey(): Buffer {
    // Derived rather than used raw so the env value can be any length; in
    // production this comes from KMS/Secrets Manager (plan §13.6).
    return createHash("sha256")
      .update(this.config.get("MFA_ENCRYPTION_KEY", { infer: true }))
      .digest();
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/** Exported for the login flow's constant-time comparisons. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
