import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service.js";

/**
 * The pre-identity data access for authentication.
 *
 * Login and refresh have to read a credential *before* they know who the caller
 * is, but RLS on `users` and `refresh_tokens` is keyed to the caller's identity
 * (plan §8.6). These two reads go through narrow SECURITY DEFINER functions
 * (migration 00000000000002) rather than direct table access — exact-match only,
 * at most one row, no enumeration.
 *
 * Everything after identity is established goes through `prisma.withTenant`,
 * so this class is the complete inventory of pre-identity reads. Adding a
 * method here deserves the same scrutiny as widening an RLS policy.
 */
@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    const rows = await this.prisma.unscoped().$queryRaw<AuthUserRow[]>`
      SELECT * FROM auth_find_user_by_email(${email}::citext)
    `;
    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.password_hash,
      status: row.status,
      platformRole: row.platform_role,
      deletedAt: row.deleted_at,
    };
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const rows = await this.prisma.unscoped().$queryRaw<RefreshTokenRow[]>`
      SELECT * FROM auth_find_refresh_token(${tokenHash})
    `;
    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      familyId: row.family_id,
      expiresAt: row.expires_at,
      rotatedAt: row.rotated_at,
      revokedAt: row.revoked_at,
    };
  }
}

interface AuthUserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  status: "ACTIVE" | "LOCKED" | "CLOSED";
  platform_role: "SUPER_ADMIN" | null;
  deleted_at: Date | null;
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

export interface AuthUserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  status: "ACTIVE" | "LOCKED" | "CLOSED";
  platformRole: "SUPER_ADMIN" | null;
  deletedAt: Date | null;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}
