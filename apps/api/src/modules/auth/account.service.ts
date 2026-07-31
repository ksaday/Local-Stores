import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { Mailer } from "../../infra/mailer/mailer.js";
import type { Env } from "../../config/env.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { PasswordService } from "./password.service.js";
import { VerificationTokenService } from "./verification-token.service.js";

export interface SessionSummary {
  familyId: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  current: boolean;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AuthRepository,
    private readonly tokens: VerificationTokenService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly mailer: Mailer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ── Email verification (FR-AUTH-02) ──────────────────────────────────────

  async sendVerificationEmail(email: string): Promise<void> {
    const user = await this.repo.findUserByEmail(email.trim().toLowerCase());

    // Silently do nothing for unknown or already-verified addresses. Callers
    // always see the same response, so this endpoint cannot be used to test
    // whether an address is registered.
    if (!user || user.deletedAt) return;

    const verified = await this.isVerified(user.id);
    if (verified) return;

    await this.tokens.invalidateOutstanding(user.email, "EMAIL_VERIFY");
    const { token } = await this.tokens.issue({
      type: "EMAIL_VERIFY",
      email: user.email,
      userId: user.id,
    });

    await this.mailer.send({
      to: user.email,
      subject: "Confirm your email address",
      body:
        `Hi ${user.name},\n\n` +
        `Confirm your email address to finish setting up your account:\n\n` +
        `${this.webUrl(`/verify-email?token=${token}`)}\n\n` +
        `This link expires in 24 hours. If you didn't create an account, ignore this message.`,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const resolved = await this.tokens.resolve(token);
    if (!resolved || resolved.type !== "EMAIL_VERIFY" || !resolved.userId) {
      throw invalidLink();
    }

    // Consume first: if the update below fails, the link is spent rather than
    // replayable.
    const consumed = await this.tokens.consume(token);
    if (!consumed) throw invalidLink();

    const userId = resolved.userId;
    await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } }),
    );
  }

  // ── Password reset (FR-AUTH-05) ──────────────────────────────────────────

  /**
   * Always succeeds from the caller's point of view, whether or not the address
   * is registered — otherwise this endpoint enumerates accounts.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const user = await this.repo.findUserByEmail(normalized);
    if (!user || user.deletedAt || user.status === "CLOSED") return;

    await this.tokens.invalidateOutstanding(normalized, "PW_RESET");
    const { token } = await this.tokens.issue({
      type: "PW_RESET",
      email: normalized,
      userId: user.id,
    });

    await this.mailer.send({
      to: normalized,
      subject: "Reset your password",
      critical: true,
      body:
        `Hi ${user.name},\n\n` +
        `Use this link to choose a new password:\n\n` +
        `${this.webUrl(`/reset-password?token=${token}`)}\n\n` +
        `The link expires in 1 hour and can only be used once. If you didn't ask ` +
        `to reset your password, you can ignore this — your current password still works.`,
    });
  }

  /**
   * Completing a reset revokes every session (plan §13.1). Someone resetting a
   * password is often doing so *because* they believe an account is
   * compromised; leaving the attacker's session alive would defeat the point.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const resolved = await this.tokens.resolve(token);
    if (!resolved || resolved.type !== "PW_RESET" || !resolved.userId) throw invalidLink();

    // Validate the new password before spending the token, so a rejected
    // password doesn't force the user back to their inbox for a fresh link.
    await this.passwords.assertAcceptable(newPassword, resolved.email);

    const consumed = await this.tokens.consume(token);
    if (!consumed) throw invalidLink();

    const userId = resolved.userId;
    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.update({ where: { id: userId }, data: { passwordHash } }),
    );

    const revoked = await this.auth.revokeAllSessions(userId);
    this.logger.log(`Password reset for user=${userId}; revoked ${revoked} session(s)`);

    await this.mailer.send({
      to: resolved.email,
      subject: "Your password was changed",
      critical: true,
      body:
        `Your password was just changed, and you've been signed out everywhere.\n\n` +
        `If this wasn't you, reset your password immediately and contact support.`,
    });
  }

  /** Authenticated change: requires the current password, then re-secures the account. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.findUnique({ where: { id: userId } }),
    );
    if (!user?.passwordHash) throw AppError.unauthenticated();

    const ok = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!ok) {
      throw AppError.validation("Your current password is incorrect.", [
        { field: "currentPassword", code: "INCORRECT", message: "That password is incorrect." },
      ]);
    }

    await this.passwords.assertAcceptable(newPassword, user.email);
    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.update({ where: { id: userId }, data: { passwordHash } }),
    );

    await this.auth.revokeAllSessions(userId);
  }

  // ── Sessions (FR-AUTH-06) ────────────────────────────────────────────────

  /**
   * One entry per family rather than per token: a family is a device's session,
   * and rotation means a single device accumulates many token rows. Showing
   * those individually would be meaningless to a user trying to spot a device
   * they don't recognise.
   */
  async listSessions(userId: string, currentFamilyId?: string): Promise<SessionSummary[]> {
    const tokens = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.refreshToken.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
      }),
    );

    const families = new Map<string, SessionSummary>();
    for (const t of tokens) {
      const existing = families.get(t.familyId);
      if (!existing) {
        families.set(t.familyId, {
          familyId: t.familyId,
          ip: t.ip,
          userAgent: t.userAgent,
          createdAt: t.createdAt,
          lastUsedAt: t.createdAt,
          current: t.familyId === currentFamilyId,
        });
      } else if (t.createdAt > existing.lastUsedAt) {
        existing.lastUsedAt = t.createdAt;
      }
    }

    return [...families.values()].sort(
      (a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime(),
    );
  }

  async revokeSession(userId: string, familyId: string): Promise<void> {
    const { count } = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.refreshToken.updateMany({
        // userId in the filter as well as familyId: without it, knowing another
        // user's familyId would be enough to sign them out.
        where: { userId, familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    if (count === 0) throw AppError.notFound("That session no longer exists.");
  }

  async revokeAllSessions(userId: string): Promise<number> {
    return this.auth.revokeAllSessions(userId);
  }

  private async isVerified(userId: string): Promise<boolean> {
    const user = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } }),
    );
    return Boolean(user?.emailVerifiedAt);
  }

  private webUrl(path: string): string {
    return `${this.config.get("WEB_ORIGIN", { infer: true }).replace(/\/$/, "")}${path}`;
  }
}

/**
 * One message for every failure mode — wrong type, expired, already used,
 * never existed. Distinguishing them tells someone holding a stale link
 * whether it was ever valid.
 */
function invalidLink(): AppError {
  return AppError.validation("That link is invalid or has expired.");
}
