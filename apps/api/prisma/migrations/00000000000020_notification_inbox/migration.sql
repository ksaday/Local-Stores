-- The in-app inbox (ADR 0001).
--
-- Communications happen inside the app: customers and staff learn what they
-- need from their own dashboard rather than from somebody else's mail server.
-- This table is that dashboard's source.
--
-- A notification is a *record*, not a message in flight. It is written once,
-- read whenever somebody looks, and never edited except to mark it read — so
-- there is no delivery state, no retry, and no queue. That is the whole
-- advantage of not leaving the building.

CREATE TABLE "notifications" (
  "id"      TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,

  -- Which shop it concerns, so a customer of four shops can tell them apart
  -- and a member of staff sees only the shop they are looking at. Null for
  -- anything about the account itself rather than a shop.
  --
  -- Cascades, unlike most references to stores here. A notice about a shop
  -- that no longer exists says nothing to anybody, and the alternative is that
  -- every caller which removes a store has to remember this table — which is a
  -- rule that has already been forgotten three times in this codebase, each
  -- time surfacing as a foreign-key error in a teardown nobody had touched.
  "store_id" TEXT REFERENCES "stores"("id") ON DELETE CASCADE,

  "event" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body"  TEXT NOT NULL,

  -- Where to go to act on it. A notification that cannot be acted on is a
  -- diary entry.
  "link"  TEXT,

  "read_at"    TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two queries the shell makes on every page: the unread badge, and the
-- list itself. Partial on unread because that one runs constantly and the read
-- ones are the overwhelming majority after a week.
CREATE INDEX "notifications_unread"
  ON "notifications" ("user_id", "created_at" DESC) WHERE "read_at" IS NULL;
CREATE INDEX "notifications_feed"
  ON "notifications" ("user_id", "created_at" DESC);

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;

-- Owned by the person. A shop writes notifications *to* its staff and
-- customers but must never read somebody's inbox back — what a customer has
-- been told by another shop is none of this one's business.
--
-- Writes come from the platform context (a sweep, a status change made by
-- somebody else), which is why the write branch is super-admin rather than
-- "user_id = me": the sender is almost never the recipient.
CREATE POLICY notifications_read_own ON "notifications" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR user_id = NULLIF(current_setting('app.user_id', true), '')
);
CREATE POLICY notifications_mark_read ON "notifications" FOR UPDATE
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY notifications_write ON "notifications" FOR INSERT
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON "notifications" TO bba_app;

-- Never deleted by the application. Somebody's record of what they were told
-- is not ours to tidy away; old rows are a housekeeping job's problem, run
-- deliberately, not a DELETE somewhere in a request path.
REVOKE DELETE ON "notifications" FROM bba_app;
