-- Authentication lookups that must run BEFORE an identity exists.
--
-- The problem: RLS on `users` and `refresh_tokens` is keyed to
-- current_setting('app.user_id'), but login and refresh are precisely the
-- operations where we do not yet know who the caller is. Connecting as the
-- RLS-restricted role, the credential lookup returns zero rows and login is
-- impossible; connecting as a superuser to work around it disables RLS for the
-- entire application, which defeats the tenancy model (plan §8.6).
--
-- The fix: two SECURITY DEFINER functions with deliberately narrow signatures.
-- They run with the definer's privileges (so RLS does not apply inside them),
-- but each takes an exact-match credential and returns at most one row. There
-- is no wildcard, no LIKE, no list — they cannot be used to enumerate users or
-- tokens, only to resolve a credential the caller already possesses.
--
-- Everything after identity is established runs through the normal tenant
-- context, so this is the complete set of pre-identity reads. Adding a third
-- function here should require the same scrutiny as widening an RLS policy.

-- Look up a login candidate by exact email. Returns only what authentication
-- needs — deliberately not the whole row, so this cannot become a general
-- user-reading backdoor.
CREATE OR REPLACE FUNCTION auth_find_user_by_email(p_email citext)
RETURNS TABLE (
  id            text,
  email         citext,
  name          text,
  password_hash text,
  status        "UserStatus",
  platform_role "PlatformRole",
  deleted_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT u.id, u.email, u.name, u.password_hash, u.status, u.platform_role, u.deleted_at
  FROM users u
  WHERE u.email = p_email
  LIMIT 1;
$$;

-- Resolve a presented refresh token by its SHA-256 hash. The caller must
-- already hold the token; this cannot be used to list or search tokens.
CREATE OR REPLACE FUNCTION auth_find_refresh_token(p_token_hash text)
RETURNS TABLE (
  id         text,
  user_id    text,
  family_id  text,
  expires_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT t.id, t.user_id, t.family_id, t.expires_at, t.rotated_at, t.revoked_at
  FROM refresh_tokens t
  WHERE t.token_hash = p_token_hash
  LIMIT 1;
$$;

-- Not executable by the world; only the application role may call them.
REVOKE ALL ON FUNCTION auth_find_user_by_email(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_refresh_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(citext) TO bba_app;
GRANT EXECUTE ON FUNCTION auth_find_refresh_token(text) TO bba_app;
