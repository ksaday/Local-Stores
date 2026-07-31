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
