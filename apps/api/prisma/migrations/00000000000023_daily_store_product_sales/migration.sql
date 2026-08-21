-- Product rollup (Phase 10, ADR 0003).
--
-- The sibling of `daily_store_sales`, one level finer: what each line sold, per
-- shop, per trading day.
--
-- It exists for the reason set out in ADR 0003. Asking `order_items` directly
-- is not slow because of the aggregation — it is slow because RLS makes the
-- planner estimate the `orders` scan at one row, pick a nested loop, and probe
-- a quarter of a million times. Best sellers was capped at a quarter to stay
-- inside the 2s target. Reading a rollup sidesteps the whole problem: the cost
-- becomes (days × catalog) rows rather than every line the shop has ever sold.
--
-- Dates are the store's own, exactly as in `daily_store_sales` — see that
-- migration for why.

CREATE TABLE "daily_store_product_sales" (
  "store_id" TEXT NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "date"     DATE NOT NULL,

  -- What identifies a line across days.
  --
  -- Not `variant_id` alone, because it is nullable: a POS sale can carry an
  -- ad-hoc line that names no catalogue item, and NULLs cannot key a row. The
  -- fallback keys those by their name, so "Counter special" and "Custom cake"
  -- stay separate instead of collapsing into one nameless bucket.
  "line_key" TEXT NOT NULL,
  "variant_id" TEXT REFERENCES "product_variants"("id") ON DELETE SET NULL,

  -- Snapshots, like the order line they came from: what the customer was sold.
  -- A product renamed next month must not rewrite last month's report.
  "product_name" TEXT NOT NULL,
  "sku"          TEXT,

  "units"         INTEGER NOT NULL DEFAULT 0,
  "revenue_cents" BIGINT  NOT NULL DEFAULT 0,

  "computed_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY ("store_id", "date", "line_key")
);

-- The primary key serves `WHERE store_id = ? AND date BETWEEN ? AND ?`, which
-- is every read. Nothing else is indexed: this table is written by a sweep and
-- read by date range.

ALTER TABLE "daily_store_product_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "daily_store_product_sales" FORCE ROW LEVEL SECURITY;

CREATE POLICY daily_store_product_sales_read ON "daily_store_product_sales" FOR SELECT
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

-- Written only by the rollup, which runs as the platform — derived figures a
-- shop must not be able to edit. Same reasoning as `daily_store_sales`.
CREATE POLICY daily_store_product_sales_write ON "daily_store_product_sales" FOR ALL
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

-- DELETE, unlike the sales rollup, which gets none.
--
-- A day there is exactly one row, so recomputing overwrites it. Here a day is
-- many rows, and a line that stops qualifying — its order cancelled, say —
-- would otherwise sit in the table forever, still counted, with nothing to
-- overwrite it. The rollup clears the window before rebuilding it, inside one
-- transaction so no reader sees the gap.
GRANT SELECT, INSERT, UPDATE, DELETE ON "daily_store_product_sales" TO bba_app;
