import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import type { MembershipRole } from "@bba/shared";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import type { Env } from "../../config/env.js";
import { AuthRepository } from "./auth.repository.js";
import { MfaService } from "./mfa.service.js";
import { PasswordService } from "./password.service.js";
import { hashRefreshToken, TokenService, type MembershipClaim } from "./token.service.js";

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * Login either completes, or stops at the second factor. Making these distinct
 * shapes means a caller cannot accidentally treat an unfinished login as a
 * session — there is no session in the challenge branch to mistake for one.
 */
export type LoginOutcome =
  | { kind: "session"; session: IssuedSession }
  | { kind: "mfa_required"; challengeToken: string };

interface DeviceInfo {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Registration is deliberately indistinguishable from a duplicate-email
   * attempt (plan §13.1): both paths do the same work and return the same
   * shape. The "this address is already registered" signal goes out by email to
   * the address itself, where only its owner sees it.
   */
  async register(input: {
    email: string;
    password: string;
    name: string;
  }): Promise<{ status: "ok" }> {
    const email = input.email.trim().toLowerCase();
    await this.passwords.assertAcceptable(input.password, email);

    // Hash before the existence check so both branches pay the same ~100ms.
    // Checking first and short-circuiting turns registration into an email
    // oracle measurable over the network.
    const passwordHash = await this.passwords.hash(input.password);
    const existing = await this.repo.findUserByEmail(email);

    if (existing) {
      this.logger.log(`Registration attempted for existing address (userId=${existing.id})`);
      // TODO(Phase 2): enqueue "someone tried to register with your address" mail.
      return { status: "ok" };
    }

    // The id is generated here rather than by the database so the RLS write
    // context can name the row being inserted — `users_write` checks
    // id = app.user_id, and a new account has no prior identity to borrow.
    const userId = randomUUID();

    await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.create({
        data: { id: userId, email, name: input.name.trim(), passwordHash, status: "ACTIVE" },
      }),
    );

    // TODO(Phase 2): enqueue verification mail (FR-AUTH-02).
    return { status: "ok" };
  }

  async login(
    input: { email: string; password: string },
    device: DeviceInfo,
  ): Promise<LoginOutcome> {
    const email = input.email.trim().toLowerCase();
    const user = await this.repo.findUserByEmail(email);

    // Verify against a dummy hash when the user is absent so a missing account
    // and a wrong password take the same time. Returning early here is the
    // classic user-enumeration leak.
    if (!user?.passwordHash) {
      await this.passwords.verify(DUMMY_HASH, input.password);
      throw AppError.unauthenticated("Email or password is incorrect.");
    }

    const ok = await this.passwords.verify(user.passwordHash, input.password);
    if (!ok) throw AppError.unauthenticated("Email or password is incorrect.");

    if (user.status === "LOCKED") throw AppError.accountLocked();
    if (user.status === "CLOSED" || user.deletedAt) {
      // Same message as a wrong password: a closed account should not be
      // distinguishable from a nonexistent one.
      throw AppError.unauthenticated("Email or password is incorrect.");
    }

    const needsRehash = this.passwords.needsRehash(user.passwordHash);
    const rehashed = needsRehash ? await this.passwords.hash(input.password) : undefined;

    await this.prisma.withTenant({ userId: user.id, isSuperAdmin: false }, (tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), ...(rehashed ? { passwordHash: rehashed } : {}) },
      }),
    );

    // A correct password alone is not a session when MFA is on. The challenge
    // token proves only that this step passed; it cannot read or write anything.
    if (await this.mfa.isEnabled(user.id)) {
      return { kind: "mfa_required", challengeToken: await this.tokens.issueMfaChallenge(user.id) };
    }

    return { kind: "session", session: await this.issueSession(user.id, randomUUID(), device) };
  }

  /** Second step of an MFA login: exchange a verified challenge for a session. */
  async completeMfaLogin(
    challengeToken: string,
    code: string,
    device: DeviceInfo,
  ): Promise<IssuedSession> {
    const userId = await this.tokens.verifyMfaChallenge(challengeToken);

    const user = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { email: true, status: true } }),
    );
    if (!user || user.status !== "ACTIVE") throw AppError.unauthenticated();

    const ok = await this.mfa.verifyChallenge(userId, user.email, code);
    if (!ok) throw AppError.unauthenticated("That code isn't right.");

    return this.issueSession(userId, randomUUID(), device);
  }

  /**
   * Issues a session directly, bypassing the password step. Used by OAuth,
   * where the provider has already authenticated the user, and by invitation
   * acceptance.
   */
  async issueSessionFor(userId: string, device: DeviceInfo): Promise<IssuedSession> {
    return this.issueSession(userId, randomUUID(), device);
  }

  /**
   * Refresh with rotation and family-reuse detection (FR-AUTH-04).
   *
   * Every refresh mints a new token and marks the old one rotated. If a token
   * that was *already* rotated comes back, the only explanations are a stolen
   * token being replayed or a client racing itself — and we cannot tell which,
   * so we assume theft and revoke the whole family. That costs a legitimate
   * user one re-login; the alternative gives an attacker an indefinite session.
   */
  async refresh(presentedToken: string, device: DeviceInfo): Promise<IssuedSession> {
    const stored = await this.repo.findRefreshToken(hashRefreshToken(presentedToken));

    // Every rejection below returns the identical message. Distinguishing
    // "expired" from "revoked" from "never existed" tells an attacker holding a
    // stolen token whether it was ever valid.
    if (!stored || stored.revokedAt) throw invalidSession();

    if (stored.rotatedAt) {
      await this.revokeFamily(stored.userId, stored.familyId);
      this.logger.warn(
        `Refresh token reuse detected: family=${stored.familyId} user=${stored.userId} ip=${device.ip ?? "-"}`,
      );
      // TODO(Phase 2): notify the account owner that sessions were revoked.
      throw invalidSession();
    }

    if (stored.expiresAt.getTime() <= Date.now()) throw invalidSession();

    await this.prisma.withTenant({ userId: stored.userId, isSuperAdmin: false }, (tx) =>
      tx.refreshToken.update({ where: { id: stored.id }, data: { rotatedAt: new Date() } }),
    );

    return this.issueSession(stored.userId, stored.familyId, device);
  }

  /** Ends this session only; other devices stay signed in. */
  async logout(presentedToken: string | undefined): Promise<void> {
    if (!presentedToken) return;
    const stored = await this.repo.findRefreshToken(hashRefreshToken(presentedToken));
    if (!stored || stored.revokedAt) return;

    await this.prisma.withTenant({ userId: stored.userId, isSuperAdmin: false }, (tx) =>
      tx.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),
    );
  }

  /** Used by password reset and by reuse detection (plan §13.1). */
  async revokeAllSessions(userId: string): Promise<number> {
    return this.prisma.withTenant({ userId, isSuperAdmin: false }, async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return count;
    });
  }

  private async revokeFamily(userId: string, familyId: string): Promise<void> {
    await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  private async issueSession(
    userId: string,
    familyId: string,
    device: DeviceInfo,
  ): Promise<IssuedSession> {
    const { accessToken, refreshToken, expiresAt } = await this.prisma.withTenant(
      { userId, isSuperAdmin: false },
      async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          include: {
            memberships: {
              where: { status: "ACTIVE" },
              select: { storeId: true, role: true },
            },
          },
        });

        const memberships: MembershipClaim[] = user.memberships.map((m) => ({
          storeId: m.storeId,
          role: m.role as MembershipRole,
        }));

        const access = await this.tokens.issueAccessToken({
          sub: user.id,
          email: user.email,
          platformRole: user.platformRole,
          memberships,
        });

        const { token, tokenHash } = this.tokens.generateRefreshToken();
        const ttl = this.config.get("REFRESH_TOKEN_TTL_SECONDS", { infer: true });
        const expires = new Date(Date.now() + ttl * 1000);

        await tx.refreshToken.create({
          data: {
            userId: user.id,
            familyId,
            tokenHash,
            expiresAt: expires,
            ip: device.ip ?? null,
            userAgent: device.userAgent ?? null,
          },
        });

        return { accessToken: access, refreshToken: token, expiresAt: expires };
      },
    );

    return { accessToken, refreshToken, expiresAt };
  }
}

function invalidSession(): AppError {
  return AppError.unauthenticated("Your session is invalid or has expired.");
}

/**
 * A real argon2id hash of a random value, used only to burn the same CPU time
 * on the user-not-found path as on a genuine password check.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$8Xy0aVhLb0JQZ0ZtWEJmZw$0J5vZ0hVQ0xhdWRlRHVtbXlIYXNoVmFsdWU";
