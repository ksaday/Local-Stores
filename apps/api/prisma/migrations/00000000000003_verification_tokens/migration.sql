-- CreateEnum
CREATE TYPE "VerificationTokenType" AS ENUM ('EMAIL_VERIFY', 'PW_RESET', 'INVITE');

-- AlterTable
ALTER TABLE "stores" ALTER COLUMN "platform_fee_bps" SET DEFAULT 0;

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "email" CITEXT NOT NULL,
    "type" "VerificationTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "payload" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_hash_key" ON "verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "verification_tokens_user_id_type_idx" ON "verification_tokens"("user_id", "type");

-- CreateIndex
CREATE INDEX "verification_tokens_email_type_idx" ON "verification_tokens"("email", "type");

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- RLS + pre-identity lookup for verification tokens.
--
-- Consuming one of these tokens is inherently a pre-identity operation: the
-- user is clicking a link in an email and has no session. Same shape as the
-- auth lookups in migration 00000000000002 — a narrow SECURITY DEFINER function
-- taking an exact token hash and returning at most one row.
-- ---------------------------------------------------------------------------

ALTER TABLE verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_tokens FORCE ROW LEVEL SECURITY;

-- A user may see their own tokens (for "resend" and audit); nobody may read
-- another's. Invites with a NULL user_id are reachable only via the function.
CREATE POLICY verification_tokens_own ON verification_tokens
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
    -- Invitations are written before the invitee has an account, so the row
    -- legitimately has no user_id to match against. The inviter's authority is
    -- checked in the application layer (staff:manage / platform:stores).
    OR user_id IS NULL
  );

-- Resolve a token the caller already holds. Exact-match only: this cannot list
-- or search tokens, only redeem one that was mailed out.
CREATE OR REPLACE FUNCTION auth_find_verification_token(p_token_hash text)
RETURNS TABLE (
  id          text,
  user_id     text,
  email       citext,
  type        "VerificationTokenType",
  payload     jsonb,
  expires_at  timestamptz,
  consumed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT v.id, v.user_id, v.email, v.type, v.payload, v.expires_at, v.consumed_at
  FROM verification_tokens v
  WHERE v.token_hash = p_token_hash
  LIMIT 1;
$$;

-- Mark a token consumed. SECURITY DEFINER for the same reason as the read: the
-- redeemer has no identity yet. Single-use is enforced here rather than in the
-- application — the UPDATE only matches a row that is not already consumed, so
-- two concurrent redemptions cannot both succeed.
CREATE OR REPLACE FUNCTION auth_consume_verification_token(p_token_hash text)
RETURNS TABLE (id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
VOLATILE
AS $$
  UPDATE verification_tokens
  SET consumed_at = now()
  WHERE token_hash = p_token_hash
    AND consumed_at IS NULL
    AND expires_at > now()
  RETURNING verification_tokens.id;
$$;

REVOKE ALL ON FUNCTION auth_find_verification_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_consume_verification_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_verification_token(text) TO bba_app;
GRANT EXECUTE ON FUNCTION auth_consume_verification_token(text) TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON verification_tokens TO bba_app;

-- Supersede outstanding tokens of a type for an address, so that reissuing a
-- link stops the older one in the same inbox from working.
--
-- SECURITY DEFINER for the same reason as the other two: an invitation row has
-- a NULL user_id (the invitee has no account yet), so no RLS policy keyed to
-- the caller's identity can match it. Scoped to one address and one type — it
-- cannot invalidate tokens broadly.
CREATE OR REPLACE FUNCTION auth_invalidate_verification_tokens(
  p_email citext,
  p_type  "VerificationTokenType"
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
VOLATILE
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE verification_tokens
  SET consumed_at = now()
  WHERE email = p_email
    AND type = p_type
    AND consumed_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION auth_invalidate_verification_tokens(citext, "VerificationTokenType") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_invalidate_verification_tokens(citext, "VerificationTokenType") TO bba_app;
