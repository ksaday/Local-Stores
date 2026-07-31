import { Injectable } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaService } from "../../infra/prisma/prisma.service.js";

export type VerificationTokenType = "EMAIL_VERIFY" | "PW_RESET" | "INVITE";

export interface InvitePayload {
  storeId: string;
  role: "STORE_ADMIN" | "INVENTORY_MANAGER" | "CLERK" | "DELIVERY";
  invitedBy: string;
}

export interface ResolvedToken {
  id: string;
  userId: string | null;
  email: string;
  type: VerificationTokenType;
  payload: InvitePayload | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

/**
 * Lifetimes per plan §13.1. Each is a tradeoff between how long a leaked link
 * stays dangerous and how long a real person plausibly takes to act:
 * a password reset is used within minutes, so an hour is generous; an
 * invitation may sit in an inbox over a weekend.
 */
const TTL_SECONDS: Record<VerificationTokenType, number> = {
  EMAIL_VERIFY: 24 * 60 * 60,
  PW_RESET: 60 * 60,
  INVITE: 7 * 24 * 60 * 60,
};

@Injectable()
export class VerificationTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mints a token and returns the plaintext, which is the only time it exists
   * in readable form — only the hash is stored, so a database read cannot
   * yield a usable link.
   */
  async issue(input: {
    type: VerificationTokenType;
    email: string;
    userId?: string | null;
    payload?: InvitePayload;
  }): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + TTL_SECONDS[input.type] * 1000);

    // Raw INSERT rather than prisma.create, deliberately: Prisma always emits
    // `INSERT ... RETURNING`, and Postgres applies the *SELECT* policy to the
    // returned row. An invitation row has a NULL user_id (the invitee has no
    // account yet), which the read policy does not match — so create() fails
    // with an RLS violation even though the write itself is permitted.
    //
    // The alternative, widening the SELECT policy to allow `user_id IS NULL`,
    // would let any authenticated user read every pending invitation on the
    // platform, including which store and role each names. Not returning the
    // row is much cheaper: nothing here needs it back.
    const id = randomUUID();
    const payloadJson = input.payload ? JSON.stringify(input.payload) : null;

    await this.prisma.withTenant(
      { userId: input.userId ?? undefined, isSuperAdmin: false },
      (tx) => tx.$executeRaw`
        INSERT INTO verification_tokens
          (id, user_id, email, type, token_hash, payload, expires_at, created_at)
        VALUES (
          ${id},
          ${input.userId ?? null},
          ${input.email.toLowerCase()}::citext,
          ${input.type}::"VerificationTokenType",
          ${hashToken(token)},
          ${payloadJson}::jsonb,
          ${expiresAt},
          now()
        )
      `,
    );

    return { token, expiresAt };
  }

  /** Read without consuming — used to show an invitation's details before acceptance. */
  async resolve(token: string): Promise<ResolvedToken | null> {
    const rows = await this.prisma.unscoped().$queryRaw<TokenRow[]>`
      SELECT * FROM auth_find_verification_token(${hashToken(token)})
    `;
    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      email: row.email,
      type: row.type,
      payload: (row.payload as InvitePayload | null) ?? null,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  }

  /**
   * Atomically marks a token used, returning false if it was already consumed
   * or has expired.
   *
   * Single-use is enforced by the database (the UPDATE only matches an
   * unconsumed, unexpired row), not by a read-then-write in application code —
   * two concurrent redemptions of the same link cannot both succeed.
   */
  async consume(token: string): Promise<boolean> {
    const rows = await this.prisma.unscoped().$queryRaw<{ id: string }[]>`
      SELECT * FROM auth_consume_verification_token(${hashToken(token)})
    `;
    return rows.length > 0;
  }

  /**
   * Invalidates outstanding tokens of a type for an address — used when
   * reissuing, so an older link in the same inbox stops working.
   *
   * Goes through a SECURITY DEFINER function rather than a direct UPDATE: an
   * invitation row has a NULL user_id, so no RLS policy keyed to the caller's
   * identity matches it. A plain UPDATE silently affects zero rows and the
   * superseded link keeps working — a failure with no error to notice.
   */
  async invalidateOutstanding(email: string, type: VerificationTokenType): Promise<number> {
    const rows = await this.prisma.unscoped().$queryRaw<{ count: number }[]>`
      SELECT auth_invalidate_verification_tokens(
        ${email.toLowerCase()}::citext,
        ${type}::"VerificationTokenType"
      ) AS count
    `;
    return Number(rows[0]?.count ?? 0);
  }
}

interface TokenRow {
  id: string;
  user_id: string | null;
  email: string;
  type: VerificationTokenType;
  payload: unknown;
  expires_at: Date;
  consumed_at: Date | null;
}

/**
 * SHA-256, matching the refresh-token rationale: the input is 256 bits of
 * system entropy rather than a human-chosen secret, so there is no dictionary
 * for a slow hash to defend against.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
