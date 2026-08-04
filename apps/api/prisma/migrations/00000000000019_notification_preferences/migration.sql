-- Notification preferences (plan §5.9).
--
-- A row is an explicit *choice*, and its absence means the default. Storing
-- every default would mean writing a row per user per event on signup, and then
-- migrating all of them the first time the catalog changes — so what is stored
-- is only what somebody actually decided.
--
-- Transactional mail is not represented here at all and never will be. Email
-- verification, password resets and staff invitations are not notifications
-- somebody may switch off; they are how the account works. A preference table
-- that could suppress a password reset is a support ticket waiting to happen.

CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'IN_APP', 'PUSH', 'SMS');

CREATE TABLE "notification_preferences" (
  "id"       TEXT PRIMARY KEY,
  "user_id"  TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,

  -- Null means "everywhere". A customer of four shops who wants to hear from
  -- one of them sets a row per store; somebody who wants none of it sets one
  -- row with no store at all.
  "store_id" TEXT REFERENCES "stores"("id"),

  -- Matches the event catalog in code rather than an enum here: adding an
  -- event should not need a migration, and an old preference for an event that
  -- no longer exists is inert rather than broken.
  "event"    TEXT NOT NULL,
  "channel"  "NotificationChannel" NOT NULL,
  "enabled"  BOOLEAN NOT NULL,

  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One choice per person per event per channel per scope. `store_id` is
-- nullable, and NULL is not distinct in a unique index by default — so it is
-- spelled out, or a person could end up with two contradictory global rows.
CREATE UNIQUE INDEX "notification_preferences_one_choice"
  ON "notification_preferences" ("user_id", COALESCE("store_id", ''), "event", "channel");

CREATE INDEX "notification_preferences_lookup"
  ON "notification_preferences" ("user_id", "event");

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;

-- Owned by the person, not the store: these are somebody's choices about their
-- own inbox, and a shop has no business reading — let alone changing — them.
CREATE POLICY notification_preferences_own ON "notification_preferences" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_preferences" TO bba_app;
