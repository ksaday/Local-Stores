-- Physical count sessions (plan Phase 6: open → enter → review → post variances).
--
-- Counting a shelf and typing the answer straight into stock would destroy the
-- thing that makes the ledger worth having: you would know the level changed
-- but not that it changed *because somebody counted*, nor by how much they were
-- out. A session keeps the count and the correction as separate facts — what
-- was expected, what was found, and the movement that reconciled them.
--
-- It is also the only inventory operation with a middle. Receiving is one
-- moment; counting a shop takes an afternoon, gets interrupted, and must
-- survive somebody closing the laptop.

CREATE TYPE "CountSessionStatus" AS ENUM ('OPEN', 'POSTED', 'ABANDONED');

CREATE TABLE "count_sessions" (
  "id"          TEXT PRIMARY KEY,
  "store_id"    TEXT NOT NULL REFERENCES "stores"("id"),
  "name"        TEXT NOT NULL,
  "status"      "CountSessionStatus" NOT NULL DEFAULT 'OPEN',
  "opened_by"   TEXT NOT NULL REFERENCES "users"("id"),
  "opened_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "posted_by"   TEXT REFERENCES "users"("id"),
  "posted_at"   TIMESTAMPTZ,
  "note"        TEXT
);

CREATE INDEX "count_sessions_store_status" ON "count_sessions" ("store_id", "status");

-- One open session per store, enforced rather than checked in code. Two people
-- counting the same shop at once produce two sets of variances against the same
-- stock, and posting both applies the difference twice.
CREATE UNIQUE INDEX "count_sessions_one_open_per_store"
  ON "count_sessions" ("store_id") WHERE "status" = 'OPEN';

CREATE TABLE "count_lines" (
  "id"            TEXT PRIMARY KEY,
  "session_id"    TEXT NOT NULL REFERENCES "count_sessions"("id") ON DELETE CASCADE,
  "store_id"      TEXT NOT NULL REFERENCES "stores"("id"),
  "variant_id"    TEXT NOT NULL REFERENCES "product_variants"("id"),

  -- What the system believed when the line was entered, captured at that
  -- moment. Recomputing it at posting time would quietly absorb every sale
  -- made during the count into the variance, and blame the counter for it.
  "expected_qty"  INTEGER NOT NULL,
  "counted_qty"   INTEGER NOT NULL,
  "note"          TEXT,
  "counted_by"    TEXT NOT NULL REFERENCES "users"("id"),
  "counted_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "count_lines_counted_nonneg" CHECK ("counted_qty" >= 0)
);

-- Counting the same shelf twice in one session should correct the first
-- answer, not add a second. The service upserts on this.
CREATE UNIQUE INDEX "count_lines_one_per_variant"
  ON "count_lines" ("session_id", "variant_id");
CREATE INDEX "count_lines_store" ON "count_lines" ("store_id");

ALTER TABLE "count_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "count_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY count_sessions_tenant ON "count_sessions" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE "count_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "count_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY count_lines_tenant ON "count_lines" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

GRANT SELECT, INSERT, UPDATE ON "count_sessions" TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "count_lines" TO bba_app;

-- A session is never deleted: it is the record of who counted what, and an
-- abandoned one is as much a fact as a posted one. Lines *are* deletable,
-- because removing a line entered against the wrong shelf before posting is
-- ordinary work rather than a rewrite of history — nothing has moved yet.
REVOKE DELETE ON "count_sessions" FROM bba_app;
