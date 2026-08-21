-- Customer rollup (Phase 10, ADR 0003) — the shop's CRM-lite.
--
-- One row per account that has ordered from this shop: how many times, what
-- they have spent, when they first came and when they last did.
--
-- The third rollup, and the one with the least choice about it. "Who are my
-- best customers" is an aggregate over every order the shop has ever taken,
-- grouped fifty thousand ways — unbounded by any date range, so it grows
-- forever and spills to disk on the way. Measured at ~1s as the table owner
-- before RLS is applied, on a query that a shop would run from a screen.
--
-- Guests are deliberately absent. A checkout without an account has only a
-- contact email, and treating two orders from the same address as the same
-- person is a guess — one this table does not make. The shop still sees those
-- orders in the queue; they are simply not a customer record.

CREATE TABLE "store_customers" (
  "store_id"    TEXT NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "customer_id" TEXT NOT NULL REFERENCES "users"("id")  ON DELETE CASCADE,

  -- Name and email are copied here rather than joined from `users`.
  --
  -- Not an optimisation: `users_read` admits a store to its *staff* records,
  -- not to its customers', so a store-scoped join returns nothing at all. The
  -- rollup runs as the platform and can read them, so it snapshots what the
  -- shop is entitled to see about the people who shopped there.
  --
  -- It is also the same shape as the rest of the system: an order snapshots
  -- `contact_email`, an order line snapshots the product name. A shop's record
  -- of a customer is who they were when they shopped, and the cascade below
  -- means closing an account still removes it.
  "name"  TEXT NOT NULL,
  "email" CITEXT NOT NULL,

  "orders_count"   INTEGER NOT NULL DEFAULT 0,
  -- Merchandise net of discounts, matching `daily_store_sales.net_cents` minus
  -- its refund handling: a refund is recorded against a payment rather than a
  -- customer, so subtracting it here would need a guess about whose it was.
  "lifetime_cents" BIGINT  NOT NULL DEFAULT 0,

  "first_order_at" TIMESTAMPTZ,
  "last_order_at"  TIMESTAMPTZ,

  "computed_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY ("store_id", "customer_id")
);

-- The list is read ordered by spend, and by recency for "who has not been in
-- lately". Both are per store, so both ride this index; the primary key serves
-- the lookup of one customer.
CREATE INDEX "store_customers_lifetime" ON "store_customers" ("store_id", "lifetime_cents" DESC);
CREATE INDEX "store_customers_last_order" ON "store_customers" ("store_id", "last_order_at" DESC);

ALTER TABLE "store_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_customers" FORCE ROW LEVEL SECURITY;

CREATE POLICY store_customers_read ON "store_customers" FOR SELECT
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

CREATE POLICY store_customers_write ON "store_customers" FOR ALL
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

-- DELETE, for the same reason the product rollup has it: the sweep clears the
-- customers it is about to rebuild, so somebody whose only order was cancelled
-- stops being a customer instead of sitting here with stale totals.
GRANT SELECT, INSERT, UPDATE, DELETE ON "store_customers" TO bba_app;
