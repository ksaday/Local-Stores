import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuthRepository } from "./auth.repository.js";

/**
 * A profile as returned by an identity provider, normalised.
 *
 * `emailVerified` is the field that matters: it is what decides whether this
 * identity may be linked to an existing local account.
 */
export interface OAuthProfile {
  provider: "GOOGLE";
  providerUid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AuthRepository,
  ) {}

  /**
   * Resolve a provider profile to a local user, creating or linking as needed
   * (FR-AUTH-07).
   *
   * The security of this whole flow rests on one rule: **link to an existing
   * account only when the provider asserts the email is verified.** Otherwise
   * anyone who can create an account at a provider with an unverified address
   * of their choosing could type a victim's email and be handed their account.
   * Google sets `email_verified: false` for some Workspace configurations, so
   * this is a real case, not a theoretical one.
   */
  async resolveProfile(
    profile: OAuthProfile,
  ): Promise<{ userId: string; created: boolean; linked: boolean }> {
    // 1. Already linked — the common path on every login after the first.
    const existingIdentity = await this.findIdentity(profile.provider, profile.providerUid);
    if (existingIdentity) {
      return { userId: existingIdentity.userId, created: false, linked: false };
    }

    const email = profile.email.trim().toLowerCase();
    const localUser = await this.repo.findUserByEmail(email);

    // 2. A local account exists for this address.
    if (localUser) {
      if (!profile.emailVerified) {
        // Refuse rather than link. This is the account-takeover vector.
        this.logger.warn(
          `Refused to link ${profile.provider} identity to ${localUser.id}: provider did not verify the address`,
        );
        throw AppError.forbidden(
          "We couldn't verify that email with your provider. Sign in with your password instead.",
        );
      }

      if (localUser.status !== "ACTIVE" || localUser.deletedAt) {
        throw AppError.unauthenticated();
      }

      await this.linkIdentity(localUser.id, profile);
      this.logger.log(`Linked ${profile.provider} identity to existing user ${localUser.id}`);
      return { userId: localUser.id, created: false, linked: true };
    }

    // 3. Nobody here yet — create an account.
    //
    // An unverified address is still refused: creating an account for an
    // address the applicant may not control would let them squat it, and would
    // block the real owner from ever registering it later.
    if (!profile.emailVerified) {
      throw AppError.forbidden(
        "Your provider hasn't verified that email address, so we can't create an account with it.",
      );
    }

    const userId = randomUUID();
    await this.prisma.withTenant({ userId, isSuperAdmin: false }, async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          email,
          name: profile.name?.trim() || email.split("@")[0]!,
          // No password: this account signs in through the provider. A local
          // password can be set later via the reset flow, which proves control
          // of the address independently.
          passwordHash: null,
          status: "ACTIVE",
          // The provider asserted it, and we checked.
          emailVerifiedAt: new Date(),
        },
      });
      await tx.authIdentity.create({
        data: {
          userId,
          provider: profile.provider,
          providerUid: profile.providerUid,
          email,
        },
      });
    });

    this.logger.log(`Created user ${userId} from ${profile.provider} sign-in`);
    return { userId, created: true, linked: false };
  }

  /** Identities visible to the signed-in user, for an account-settings screen. */
  async listIdentities(userId: string) {
    return this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.authIdentity.findMany({
        where: { userId },
        select: { id: true, provider: true, email: true, createdAt: true },
      }),
    );
  }

  /**
   * Unlink a provider. Refused when it would leave the account with no way in
   * — an account with no password and no identities is unreachable, and
   * recovering it needs support intervention.
   */
  async unlinkIdentity(userId: string, identityId: string): Promise<void> {
    const [user, identities] = await Promise.all([
      this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
        tx.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }),
      ),
      this.listIdentities(userId),
    ]);

    if (!user) throw AppError.notFound();

    const isLast = identities.length <= 1;
    if (isLast && !user.passwordHash) {
      throw AppError.validation(
        "Set a password before removing your last sign-in method, or you won't be able to get back in.",
      );
    }

    const { count } = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.authIdentity.deleteMany({ where: { id: identityId, userId } }),
    );
    if (count === 0) throw AppError.notFound();
  }

  private async findIdentity(provider: string, providerUid: string) {
    // Pre-identity: the caller has no session yet, so this goes through the
    // SECURITY DEFINER lookup like every other sign-in path.
    const rows = await this.prisma.unscoped().$queryRaw<
      { id: string; user_id: string; provider: string; provider_uid: string }[]
    >`SELECT * FROM auth_find_identity(${provider}, ${providerUid})`;

    const row = rows[0];
    return row ? { id: row.id, userId: row.user_id } : null;
  }

  private async linkIdentity(userId: string, profile: OAuthProfile): Promise<void> {
    await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.authIdentity.create({
        data: {
          userId,
          provider: profile.provider,
          providerUid: profile.providerUid,
          email: profile.email.trim().toLowerCase(),
        },
      }),
    );
  }
}
