-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_enabled_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_uid" TEXT NOT NULL,
    "email" CITEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_provider_uid_key" ON "auth_identities"("provider", "provider_uid");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_id_used_at_idx" ON "mfa_recovery_codes"("user_id", "used_at");

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Both tables are strictly own-user. Neither has a store dimension.
ALTER TABLE auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_identities_own ON auth_identities
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));

ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY mfa_recovery_codes_own ON mfa_recovery_codes
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));

-- Sign-in by Google identity, and redeeming a recovery code, both happen
-- before a session exists — the same pre-identity problem as password login.
-- Narrow SECURITY DEFINER lookups, exact-match only.
CREATE OR REPLACE FUNCTION auth_find_identity(p_provider text, p_provider_uid text)
RETURNS TABLE (id text, user_id text, provider text, provider_uid text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE
AS $$
  SELECT i.id, i.user_id, i.provider, i.provider_uid
  FROM auth_identities i
  WHERE i.provider = p_provider AND i.provider_uid = p_provider_uid
  LIMIT 1;
$$;

-- Redeems a recovery code atomically. Single-use is enforced by the UPDATE
-- matching only an unused row, so two concurrent attempts cannot both succeed.
CREATE OR REPLACE FUNCTION auth_consume_recovery_code(p_user_id text, p_code_hash text)
RETURNS TABLE (id text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp VOLATILE
AS $$
  UPDATE mfa_recovery_codes
  SET used_at = now()
  WHERE user_id = p_user_id AND code_hash = p_code_hash AND used_at IS NULL
  RETURNING mfa_recovery_codes.id;
$$;

REVOKE ALL ON FUNCTION auth_find_identity(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_consume_recovery_code(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_identity(text, text) TO bba_app;
GRANT EXECUTE ON FUNCTION auth_consume_recovery_code(text, text) TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_identities TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_codes TO bba_app;
