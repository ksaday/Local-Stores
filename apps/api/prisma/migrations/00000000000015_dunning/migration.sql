-- Dunning: the mail sent while a store's subscription is unpaid (plan §18.5a).
--
-- Until now the grace-period warning existed only inside the app, which warns
-- exactly the owner who was going to sign in anyway. The one who needs telling
-- is the one who is not looking — the card expired, nothing appears broken
-- because the shop keeps trading through the grace period, and the first they
-- learn of it is a customer saying the site is gone.
--
-- This table is what makes the sweep safe to run every hour: it records what
-- has already been said, so a job that runs 168 times during a seven-day grace
-- period sends four emails rather than 168.

CREATE TYPE "DunningStage" AS ENUM (
  'PAYMENT_FAILED', 'GRACE_REMINDER', 'FINAL_WARNING', 'SUSPENDED'
);

CREATE TABLE "billing_notifications" (
  "id"             TEXT PRIMARY KEY,
  "store_id"       TEXT NOT NULL REFERENCES "stores"("id"),

  -- Which unpaid episode this belongs to, not merely which store. A shop that
  -- lapses in March, pays, and lapses again in September must receive the whole
  -- sequence the second time — keying on the store alone would leave them
  -- silently unwarned forever after their first lapse. `past_due_since` is
  -- stamped once per episode and cleared on recovery, so it names the episode
  -- exactly.
  "past_due_since" TIMESTAMPTZ NOT NULL,
  "stage"          "DunningStage" NOT NULL,

  -- The address as it was at the time. An owner who changes their email should
  -- still be able to find out where a warning actually went.
  "sent_to"        TEXT NOT NULL,
  "sent_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The whole idempotency guarantee, and it must be a database constraint rather
-- than a check in application code: two workers sweeping at once would both
-- read "not yet sent" before either wrote.
CREATE UNIQUE INDEX "billing_notifications_once"
  ON "billing_notifications" ("store_id", "past_due_since", "stage");

-- The sweep's own lookup: everything already sent for one episode.
CREATE INDEX "billing_notifications_episode"
  ON "billing_notifications" ("store_id", "past_due_since");

ALTER TABLE "billing_notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_notifications" FORCE ROW LEVEL SECURITY;

-- A store can see what it was sent, which is the honest answer to "you never
-- told me". Only the platform writes.
CREATE POLICY billing_notifications_read ON "billing_notifications" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
);
CREATE POLICY billing_notifications_write ON "billing_notifications" FOR ALL
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

GRANT SELECT, INSERT ON "billing_notifications" TO bba_app;

-- Migration 1 grants full DML on every future table by default, so append-only
-- has to be taken back explicitly. A record of what was sent that can be edited
-- or deleted is not a record of anything.
REVOKE UPDATE, DELETE ON "billing_notifications" FROM bba_app;
