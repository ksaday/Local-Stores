-- Sales rollup (plan §8.2, Phase 10).
--
-- One row per store per trading day. Reports read this instead of aggregating
-- `orders` live, because the question "how did the shop do last quarter" is a
-- scan of every order ever placed, and it gets slower every day the shop stays
-- open. This table does not.
--
-- ── What a "day" is ────────────────────────────────────────────────────────
-- The store's own day, not UTC. A bakery in Chicago closing at 11pm files
-- those takings under that Tuesday; bucketing on UTC would move the last hour
-- of trade into Wednesday and make every daily figure wrong by one evening.
-- Every date here is `(timestamp AT TIME ZONE stores.timezone)::date`.
--
-- ── What the money columns mean ────────────────────────────────────────────
-- Stated because "sales" is ambiguous and a report nobody can reconcile is
-- worse than no report:
--
--   gross_cents      merchandise at list price, before discounts (subtotal)
--   discounts_cents  coupons and manual reductions
--   tax_cents        collected for the state — never the shop's money
--   refunds_cents    refunds *issued that day*, whenever the sale happened
--   net_cents        gross - discounts - refunds
--
-- Tax is excluded from net on purpose: it is passed through. Delivery fees and
-- tips are excluded too — a tip belongs to whoever earned it, and neither is
-- merchandise revenue. They stay on `orders`, which remains the source of
-- truth for anything this summary does not carry.
--
-- Refunds are dated by when the refund was issued rather than by the original
-- sale, which is what makes a month's figures stop moving once the month is
-- over. A refund in March against a February sale is March's problem.

CREATE TABLE "daily_store_sales" (
  "store_id" TEXT NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "date"     DATE NOT NULL,

  "orders_count"        INTEGER NOT NULL DEFAULT 0,
  -- BIGINT, not INTEGER: a day fits comfortably, but these get summed over a
  -- year in the reports, and 2.1 billion cents is only $21m.
  "gross_cents"         BIGINT  NOT NULL DEFAULT 0,
  "discounts_cents"     BIGINT  NOT NULL DEFAULT 0,
  "tax_cents"           BIGINT  NOT NULL DEFAULT 0,
  "refunds_cents"       BIGINT  NOT NULL DEFAULT 0,
  "net_cents"           BIGINT  NOT NULL DEFAULT 0,
  "pos_orders_count"    INTEGER NOT NULL DEFAULT 0,
  "online_orders_count" INTEGER NOT NULL DEFAULT 0,

  -- When this row was last recomputed. The rollup revisits recent days, so
  -- this is how anyone can tell a stale figure from a quiet one.
  "computed_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY ("store_id", "date")
);

-- The primary key already serves `WHERE store_id = ? AND date BETWEEN ? AND ?`,
-- which is every report query. No second index: this table is written by a
-- sweep and read by date range, and an unused index is just write cost.

ALTER TABLE "daily_store_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "daily_store_sales" FORCE ROW LEVEL SECURITY;

-- Readable by the shop it belongs to, and by the platform.
CREATE POLICY daily_store_sales_read ON "daily_store_sales" FOR SELECT
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

-- Written only by the rollup, which runs as the platform. Derived data: a
-- store admin who could write here could edit their own takings without
-- touching a single order, and the audit trail would show nothing.
CREATE POLICY daily_store_sales_write ON "daily_store_sales" FOR ALL
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

-- No DELETE: the rollup only ever upserts, and a row it can't delete is a row
-- it can't quietly lose.
GRANT SELECT, INSERT, UPDATE ON "daily_store_sales" TO bba_app;
