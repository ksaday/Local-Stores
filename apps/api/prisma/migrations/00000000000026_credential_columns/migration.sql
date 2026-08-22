-- Take the credential columns away from the application role.
--
-- `password_hash` and `mfa_totp_secret` sit on `users` beside the name and
-- email a shop legitimately reads. RLS is row-level: once migration 25 let a
-- store see its customers' rows — which it should — every column on those rows
-- became readable by anything that selected it.
--
-- Nothing does. Every store-scoped read names its columns, and the credential
-- reads that exist are a user's own. But "no current code does the wrong
-- thing" is a property of today's code, and the fix for that is to make the
-- wrong thing impossible rather than absent: after this, `bba_app` cannot
-- select these two columns at all, from any row, in any context.
--
-- What still needs them, and how it gets them:
--
--   * login — `auth_find_user_by_email` (migration 2), already SECURITY
--     DEFINER, and necessarily pre-identity: there is no session yet to scope
--     to. Unchanged.
--   * a user reading their own — the two functions below. They take no user
--     id: they read `app.user_id` and answer only for the authenticated
--     caller, so a store-scoped request cannot ask about anybody, including
--     itself.
--   * writing them — INSERT and UPDATE are untouched. Registration still
--     stores a hash and a password change still replaces one. Only reading
--     back is withdrawn, which is why every write in the auth module now names
--     what it returns.
--
-- Column grants rather than a separate credentials table: the table split is
-- tidier in the abstract, but this needs no data migration and it fails in the
-- right direction — a column added to `users` later is unreadable until
-- somebody grants it, rather than exposed until somebody notices.

-- The caller's own password hash, or NULL if they sign in only through a
-- provider. Used to decide whether unlinking the last identity would lock them
-- out, and to check the current password before changing it.
CREATE OR REPLACE FUNCTION auth_self_password_hash()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT u.password_hash
  FROM users u
  WHERE u.id = NULLIF(current_setting('app.user_id', true), '')
  LIMIT 1;
$$;

-- The caller's own TOTP secret and whether enrolment finished. Two values
-- because every caller wants both, and asking twice would mean two round trips
-- for one decision.
CREATE OR REPLACE FUNCTION auth_self_totp()
RETURNS TABLE (mfa_totp_secret text, mfa_enabled_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT u.mfa_totp_secret, u.mfa_enabled_at
  FROM users u
  WHERE u.id = NULLIF(current_setting('app.user_id', true), '')
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION auth_self_password_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_self_totp() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_self_password_hash() TO bba_app;
GRANT EXECUTE ON FUNCTION auth_self_totp() TO bba_app;

-- Column-level SELECT. A table-level grant covers every column, so it has to
-- go before the per-column grants mean anything.
REVOKE SELECT ON users FROM bba_app;
GRANT SELECT (
  id,
  email,
  name,
  phone,
  platform_role,
  status,
  email_verified_at,
  mfa_enabled_at,
  last_login_at,
  created_at,
  updated_at,
  deleted_at
) ON users TO bba_app;

-- Writes are unchanged: registration sets a hash, a password change replaces
-- one, enrolling in MFA stores a secret.
GRANT INSERT, UPDATE, DELETE ON users TO bba_app;
