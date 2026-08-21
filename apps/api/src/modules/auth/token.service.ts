import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from "jose";
import type { MembershipRole } from "@bba/shared";
import { AppError } from "../../common/errors/app-error.js";
import type { Env } from "../../config/env.js";

export interface MembershipClaim {
  storeId: string;
  role: MembershipRole;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  platformRole: "SUPER_ADMIN" | null;
  memberships: MembershipClaim[];
  jti: string;
}

const ALG = "EdDSA";
const MFA_AUDIENCE = "bba-mfa-challenge";
const OAUTH_STATE_AUDIENCE = "bba-oauth-state";

export interface OAuthStateClaims {
  /** The nonce echoed back by the provider in `?state=`. */
  nonce: string;
  /** PKCE verifier. Never leaves the server; only its hash goes to Google. */
  codeVerifier: string;
  /** Where to send the browser once the session exists. */
  redirectTo: string;
}

@Injectable()
export class TokenService implements OnModuleInit {
  private privateKey!: CryptoKey;
  private publicKey!: CryptoKey;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onModuleInit(): Promise<void> {
    // Env carries PEMs as single lines with escaped newlines; restore them.
    const priv = this.config.get("JWT_PRIVATE_KEY", { infer: true }).replace(/\\n/g, "\n");
    const pub = this.config.get("JWT_PUBLIC_KEY", { infer: true }).replace(/\\n/g, "\n");
    this.privateKey = await importPKCS8(priv, ALG);
    this.publicKey = await importSPKI(pub, ALG);
  }

  /**
   * Short-lived access token carrying membership summaries (plan §10.1).
   *
   * Effective *permissions* are deliberately not in the token — they change
   * when an owner edits a staff member's access, and a token minted before that
   * edit would keep the old set until expiry. Permissions are resolved per
   * request instead; the 15-minute TTL bounds how long a revoked membership
   * stays usable (FR-AUTHZ-07).
   */
  async issueAccessToken(claims: Omit<AccessTokenClaims, "jti">): Promise<string> {
    const ttl = this.config.get("ACCESS_TOKEN_TTL_SECONDS", { infer: true });
    return new SignJWT({
      email: claims.email,
      platformRole: claims.platformRole,
      memberships: claims.memberships,
    })
      .setProtectedHeader({ alg: ALG })
      .setSubject(claims.sub)
      .setJti(randomUUID())
      .setIssuedAt()
      .setIssuer(this.config.get("JWT_ISSUER", { infer: true }))
      .setAudience(this.config.get("JWT_AUDIENCE", { infer: true }))
      .setExpirationTime(`${ttl}s`)
      .sign(this.privateKey);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALG], // pinned: never let the token's own header pick the algorithm
        issuer: this.config.get("JWT_ISSUER", { infer: true }),
        audience: this.config.get("JWT_AUDIENCE", { infer: true }),
      });

      return {
        sub: payload.sub!,
        email: payload.email as string,
        platformRole: (payload.platformRole as "SUPER_ADMIN" | null) ?? null,
        memberships: (payload.memberships as MembershipClaim[]) ?? [],
        jti: payload.jti!,
      };
    } catch {
      // Expired, wrong signature, wrong audience — all the same to the caller.
      // Distinguishing them tells an attacker which part of the token to fix.
      throw AppError.unauthenticated("Your session is invalid or has expired.");
    }
  }

  /**
   * A short-lived token proving the password step succeeded, exchanged for a
   * session once the second factor is verified.
   *
   * Scoped to its own audience so it can never be presented as an access
   * token: a token that authorises "finish logging in" must not also authorise
   * "read this store's orders".
   */
  async issueMfaChallenge(userId: string): Promise<string> {
    return new SignJWT({ purpose: "mfa_challenge" })
      .setProtectedHeader({ alg: ALG })
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt()
      .setIssuer(this.config.get("JWT_ISSUER", { infer: true }))
      .setAudience(MFA_AUDIENCE)
      .setExpirationTime("5m")
      .sign(this.privateKey);
  }

  async verifyMfaChallenge(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALG],
        issuer: this.config.get("JWT_ISSUER", { infer: true }),
        audience: MFA_AUDIENCE,
      });
      if (payload.purpose !== "mfa_challenge") throw new Error("wrong purpose");
      return payload.sub!;
    } catch {
      throw AppError.unauthenticated("That sign-in attempt expired. Please start again.");
    }
  }

  /**
   * Signs the one-time state for an OAuth authorisation round-trip.
   *
   * This travels as an httpOnly cookie while the browser is away at Google, and
   * is what makes the callback verifiable: the `state` Google echoes back must
   * match the nonce sealed in here. Without that pairing, anyone could send a
   * victim a callback URL carrying *their* authorisation code and silently land
   * the victim in the attacker's account — login CSRF, and the reason `state`
   * is not optional.
   *
   * Its own audience, like the MFA challenge: a token that authorises
   * "finish this sign-in round-trip" must never be presentable as an access token.
   */
  async issueOAuthState(claims: OAuthStateClaims): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: ALG })
      .setJti(randomUUID())
      .setIssuedAt()
      .setIssuer(this.config.get("JWT_ISSUER", { infer: true }))
      .setAudience(OAUTH_STATE_AUDIENCE)
      // Long enough to pick an account and type a password, short enough that a
      // cookie left behind on a shared machine is inert by the time it is found.
      .setExpirationTime("10m")
      .sign(this.privateKey);
  }

  async verifyOAuthState(token: string): Promise<OAuthStateClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALG],
        issuer: this.config.get("JWT_ISSUER", { infer: true }),
        audience: OAUTH_STATE_AUDIENCE,
      });
      return {
        nonce: payload.nonce as string,
        codeVerifier: payload.codeVerifier as string,
        redirectTo: payload.redirectTo as string,
      };
    } catch {
      throw AppError.unauthenticated("That sign-in attempt expired. Please start again.");
    }
  }

  /**
   * Refresh tokens are opaque 256-bit random values, not JWTs — they must be
   * revocable, and a self-contained token cannot be revoked before it expires.
   * Only the SHA-256 hash is stored, so a database read does not yield usable
   * tokens (plan §13.1).
   */
  generateRefreshToken(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, tokenHash: hashRefreshToken(token) };
  }
}

/**
 * SHA-256 rather than argon2 here on purpose: the input is 256 bits of system
 * entropy, not a human-chosen secret, so there is no dictionary to slow down —
 * and refresh happens on a hot path where argon2's cost would be felt.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
