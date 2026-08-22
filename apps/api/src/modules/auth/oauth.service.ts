import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import type { Env } from "../../config/env.js";
import { AuthRepository } from "./auth.repository.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/** Provider calls get a hard ceiling: a hung Google must not hang a sign-in. */
const PROVIDER_TIMEOUT_MS = 10_000;

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
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Whether Google sign-in is configured at all.
   *
   * Checked before the button is offered rather than after it is pressed: an
   * install with no credentials is a normal install, and password sign-in works
   * exactly as before. Offering a button that can only fail is worse than not
   * offering one.
   */
  isGoogleConfigured(): boolean {
    return Boolean(this.googleClientId() && this.googleClientSecret());
  }

  /**
   * The redirect Google sends the browser back to.
   *
   * The *web* origin, not this API's: the browser only ever talks to the
   * Next.js BFF, which forwards the code here. This value is also what must be
   * registered in the Google Console — the two are compared byte for byte at
   * both the authorise and the token-exchange step, so they are built from one
   * expression rather than written down twice.
   */
  googleRedirectUri(): string {
    return `${this.config.get("WEB_ORIGIN", { infer: true })}/auth/oauth/google/callback`;
  }

  /**
   * Step one: where to send the browser, and the secrets to remember while it
   * is gone.
   *
   * PKCE (RFC 7636) is used even though this is a confidential client with a
   * secret. It costs one hash and closes the window where an authorisation code
   * leaked from a redirect — browser history, a proxy log, a referrer header —
   * can be redeemed by anyone but the tab that started the flow.
   */
  buildGoogleAuthorization(redirectTo: string): {
    authorizeUrl: string;
    nonce: string;
    codeVerifier: string;
  } {
    const clientId = this.googleClientId();
    if (!clientId) throw AppError.validation("Google sign-in isn't configured.");

    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.googleRedirectUri(),
      response_type: "code",
      scope: "openid email profile",
      state: nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      // Ask every time rather than silently reusing whichever account the
      // browser happens to be signed into — on a shared machine that is how
      // one person ends up in another's orders.
      prompt: "select_account",
    });

    return { authorizeUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`, nonce, codeVerifier };
  }

  /**
   * Step two: redeem the authorisation code for a profile.
   *
   * The profile comes from the userinfo endpoint over a fresh TLS connection
   * rather than by decoding the id_token: both are fine, and this avoids
   * carrying a JWKS cache for one provider.
   */
  async exchangeGoogleCode(code: string, codeVerifier: string): Promise<OAuthProfile> {
    const clientId = this.googleClientId();
    const clientSecret = this.googleClientSecret();
    if (!clientId || !clientSecret) throw AppError.validation("Google sign-in isn't configured.");

    const tokenRes = await this.fetchProvider(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.googleRedirectUri(),
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!tokenRes.ok) {
      // The body can quote the code and the client_id back at us; it goes to the
      // log, never to the caller.
      this.logger.warn(`Google token exchange failed (${tokenRes.status}): ${await safeBody(tokenRes)}`);
      throw AppError.unauthenticated("That sign-in didn't complete. Please try again.");
    }

    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) {
      throw AppError.unauthenticated("That sign-in didn't complete. Please try again.");
    }

    const profileRes = await this.fetchProvider(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });

    if (!profileRes.ok) {
      this.logger.warn(`Google userinfo failed (${profileRes.status})`);
      throw AppError.unauthenticated("That sign-in didn't complete. Please try again.");
    }

    const profile = (await profileRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };

    if (!profile.sub || !profile.email) {
      throw AppError.unauthenticated("Google didn't return an email address for that account.");
    }

    return {
      provider: "GOOGLE",
      providerUid: profile.sub,
      email: profile.email,
      // Absent is not verified. Defaulting the other way would hand the
      // account-linking decision to a field the provider chose to omit.
      emailVerified: profile.email_verified === true,
      name: profile.name,
    };
  }

  private googleClientId(): string | undefined {
    return this.config.get("GOOGLE_CLIENT_ID", { infer: true });
  }

  private googleClientSecret(): string | undefined {
    return this.config.get("GOOGLE_CLIENT_SECRET", { infer: true });
  }

  private async fetchProvider(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    } catch (err) {
      this.logger.warn(`Google request to ${url} failed: ${String(err)}`);
      throw AppError.unauthenticated("Couldn't reach Google just now. Please try again.");
    }
  }

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
        select: { id: true },
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
    // The hash through a SECURITY DEFINER function: `bba_app` has no SELECT on
    // that column (migration 26), and all this needs to know is whether one
    // exists at all.
    const [rows, identities] = await Promise.all([
      this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
        tx.$queryRaw<{ auth_self_password_hash: string | null }[]>`
          SELECT auth_self_password_hash()`,
      ),
      this.listIdentities(userId),
    ]);

    const passwordHash = rows[0]?.auth_self_password_hash ?? null;
    const isLast = identities.length <= 1;
    if (isLast && !passwordHash) {
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

/** Error bodies are for the log; a failed read of one must not mask the failure. */
async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
