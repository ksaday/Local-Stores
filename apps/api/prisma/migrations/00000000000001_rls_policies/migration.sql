-- Row-Level Security for tenant isolation. See docs/plan/08-database-schema.md §8.6
-- and docs/plan/13-security-design.md §13.2-§13.3.
--
-- Context is set per-transaction by the API's tenant-context Prisma extension
-- (docs/plan/12-backend-architecture.md §12.4) via set_config(..., true) —
-- NEVER by client input. The app connects as a role WITHOUT BYPASSRLS.

-- A dedicated, restricted application role. Superusers (incl. the migration
-- user) always bypass RLS regardless of policy — this is what makes the
-- isolation tests meaningful: they must run as bba_app, not as the migration
-- user, or they will silently pass for the wrong reason.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bba_app') THEN
    CREATE ROLE bba_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bba_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bba_app;

-- store_memberships: staff see their own store's memberships; users see their own row.
ALTER TABLE store_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY store_memberships_tenant ON store_memberships
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

-- member_permission_overrides: scoped through the parent membership's store.
ALTER TABLE member_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_permission_overrides FORCE ROW LEVEL SECURITY;

CREATE POLICY member_permission_overrides_tenant ON member_permission_overrides
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR membership_id IN (
      SELECT id FROM store_memberships
      WHERE store_id = NULLIF(current_setting('app.store_id', true), '')
    )
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR membership_id IN (
      SELECT id FROM store_memberships
      WHERE store_id = NULLIF(current_setting('app.store_id', true), '')
    )
  );

-- stores: platform sees all; anyone can read an ACTIVE store (public storefront);
-- only the tenant's own context can write.
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores FORCE ROW LEVEL SECURITY;

CREATE POLICY stores_read ON stores FOR SELECT
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR status = 'ACTIVE'
    OR id = NULLIF(current_setting('app.store_id', true), '')
  );

CREATE POLICY stores_write ON stores FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR id = NULLIF(current_setting('app.store_id', true), '')
  );

-- users: customer-owned. A user reads/writes their own row; platform sees all;
-- store staff can read (not write) users who hold a membership at their store.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_read ON users FOR SELECT
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR id = NULLIF(current_setting('app.user_id', true), '')
    OR id IN (
      SELECT user_id FROM store_memberships
      WHERE store_id = NULLIF(current_setting('app.store_id', true), '')
    )
  );

CREATE POLICY users_write ON users FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR id = NULLIF(current_setting('app.user_id', true), '')
  );

-- refresh_tokens: strictly own-user, no store or platform override needed at this table.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY refresh_tokens_own ON refresh_tokens
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
