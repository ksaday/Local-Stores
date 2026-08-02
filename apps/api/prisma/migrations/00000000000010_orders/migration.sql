-- Cart, checkout, orders and cash payments (plan §8.2 Shopping / Orders & payments).
--
-- Stock lives here too, because checkout cannot be correct without it: an order
-- that does not reserve stock oversells the moment two people check out at
-- once. The inventory *management* surfaces (receiving, counts, low-stock) are
-- a separate phase; the ledger and reservation semantics they will build on are
-- established now.

CREATE TYPE "CartStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'ABANDONED');
CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'PICKED_UP',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURNED', 'REFUNDED'
);
CREATE TYPE "OrderChannel" AS ENUM ('ONLINE', 'POS');
CREATE TYPE "Fulfillment" AS ENUM ('PICKUP', 'DELIVERY');
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'CASH');
CREATE TYPE "PaymentStatus" AS ENUM (
  'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELED'
);
CREATE TYPE "StockMovementType" AS ENUM (
  'RECEIVE', 'SALE', 'RETURN', 'ADJUSTMENT', 'DAMAGE', 'COUNT'
);

-- ---------------------------------------------------------------------------
-- Inventory: a ledger, plus a derived current-state row.
-- ---------------------------------------------------------------------------

CREATE TABLE "stock_levels" (
  "variant_id"     TEXT PRIMARY KEY REFERENCES "product_variants"("id") ON DELETE CASCADE,
  "store_id"       TEXT NOT NULL REFERENCES "stores"("id"),
  "on_hand"        INTEGER NOT NULL DEFAULT 0,
  "reserved"       INTEGER NOT NULL DEFAULT 0,
  "reorder_point"  INTEGER,
  "reorder_qty"    INTEGER,
  -- Whether this variant is stock-tracked at all. A bakery selling made-to-order
  -- items should not have checkout blocked by a number nobody maintains.
  "tracked"        BOOLEAN NOT NULL DEFAULT false,
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The two invariants that make overselling impossible. Reserved may not
  -- exceed on-hand, so a reservation that would oversell aborts the
  -- transaction rather than quietly producing a negative number later.
  CONSTRAINT "stock_levels_nonneg" CHECK ("on_hand" >= 0 AND "reserved" >= 0),
  CONSTRAINT "stock_levels_reserved_lte_on_hand" CHECK ("reserved" <= "on_hand")
);
CREATE INDEX "stock_levels_low" ON "stock_levels" ("store_id")
  WHERE "reorder_point" IS NOT NULL AND "on_hand" - "reserved" <= "reorder_point";

CREATE TABLE "stock_movements" (
  "id"            TEXT PRIMARY KEY,
  "store_id"      TEXT NOT NULL REFERENCES "stores"("id"),
  "variant_id"    TEXT NOT NULL REFERENCES "product_variants"("id"),
  "type"          "StockMovementType" NOT NULL,
  "qty_delta"     INTEGER NOT NULL,
  "reason_code"   TEXT,
  "note"          TEXT,
  "order_id"      TEXT,
  "actor_user_id" TEXT REFERENCES "users"("id"),
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "stock_movements_nonzero" CHECK ("qty_delta" <> 0)
);
CREATE INDEX "stock_movements_variant" ON "stock_movements" ("store_id", "variant_id", "created_at" DESC);

-- On-hand is never written by application code — it is derived from the ledger
-- in the same transaction as the movement. That is what keeps the two from
-- drifting apart.
CREATE OR REPLACE FUNCTION apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Update first, insert only if there was nothing to update.
  --
  -- The obvious `INSERT ... ON CONFLICT DO UPDATE` is wrong here: PostgreSQL
  -- evaluates CHECK constraints on the proposed row BEFORE it detects the
  -- conflict, so a negative delta (every sale) trips `on_hand >= 0` against an
  -- insert row that would never have been stored. That failure looks like a
  -- corrupt stock level rather than a trigger-ordering problem.
  UPDATE stock_levels
    SET on_hand = on_hand + NEW.qty_delta, updated_at = now()
    WHERE variant_id = NEW.variant_id;

  IF NOT FOUND THEN
    -- First movement for this variant. A negative delta here still fails the
    -- constraint, which is correct: you cannot sell what was never received.
    INSERT INTO stock_levels (variant_id, store_id, on_hand, updated_at)
    VALUES (NEW.variant_id, NEW.store_id, NEW.qty_delta, now());
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_movements_apply
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- ---------------------------------------------------------------------------
-- Carts
-- ---------------------------------------------------------------------------

CREATE TABLE "carts" (
  "id"          TEXT PRIMARY KEY,
  "store_id"    TEXT NOT NULL REFERENCES "stores"("id"),
  "user_id"     TEXT REFERENCES "users"("id"),
  -- Guests get an opaque server-generated key held in a cookie. A cart must
  -- belong to exactly one of a user or a guest session, never both or neither.
  "session_key" TEXT,
  "status"      "CartStatus" NOT NULL DEFAULT 'ACTIVE',
  "expires_at"  TIMESTAMPTZ NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "carts_owner" CHECK (num_nonnulls("user_id", "session_key") = 1)
);

-- One active cart per shopper per store. Partial, so converted and abandoned
-- carts accumulate as history without blocking the next one.
CREATE UNIQUE INDEX "carts_active_user" ON "carts" ("store_id", "user_id")
  WHERE "status" = 'ACTIVE' AND "user_id" IS NOT NULL;
CREATE UNIQUE INDEX "carts_active_session" ON "carts" ("store_id", "session_key")
  WHERE "status" = 'ACTIVE' AND "session_key" IS NOT NULL;
CREATE INDEX "carts_expiry" ON "carts" ("expires_at") WHERE "status" = 'ACTIVE';

CREATE TABLE "cart_items" (
  "id"                  TEXT PRIMARY KEY,
  "cart_id"             TEXT NOT NULL REFERENCES "carts"("id") ON DELETE CASCADE,
  "store_id"            TEXT NOT NULL REFERENCES "stores"("id"),
  "variant_id"          TEXT NOT NULL REFERENCES "product_variants"("id"),
  "qty"                 INTEGER NOT NULL,
  -- What the shopper saw when they added it. Display only: checkout re-quotes
  -- from the live variant, so a stale cart can never lock in an old price.
  "price_at_add_cents"  INTEGER NOT NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "cart_items_qty_positive" CHECK ("qty" > 0),
  CONSTRAINT "cart_items_price_nonneg" CHECK ("price_at_add_cents" >= 0)
);
CREATE UNIQUE INDEX "cart_items_unique_variant" ON "cart_items" ("cart_id", "variant_id");

-- ---------------------------------------------------------------------------
-- Per-store counters (order numbers)
-- ---------------------------------------------------------------------------

CREATE TABLE "store_counters" (
  "store_id" TEXT NOT NULL REFERENCES "stores"("id"),
  "key"      TEXT NOT NULL,
  "value"    BIGINT NOT NULL DEFAULT 0,

  PRIMARY KEY ("store_id", "key")
);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

CREATE TABLE "orders" (
  "id"                 TEXT PRIMARY KEY,
  "store_id"           TEXT NOT NULL REFERENCES "stores"("id"),
  "order_number"       TEXT NOT NULL,
  -- NULL for a walk-in POS sale, where there is no account to attach.
  "customer_id"        TEXT REFERENCES "users"("id"),
  "channel"            "OrderChannel" NOT NULL DEFAULT 'ONLINE',
  "fulfillment"        "Fulfillment" NOT NULL,
  "status"             "OrderStatus" NOT NULL DEFAULT 'PENDING',

  "subtotal_cents"     INTEGER NOT NULL,
  "discount_cents"     INTEGER NOT NULL DEFAULT 0,
  "tax_cents"          INTEGER NOT NULL DEFAULT 0,
  "delivery_fee_cents" INTEGER NOT NULL DEFAULT 0,
  "tip_cents"          INTEGER NOT NULL DEFAULT 0,
  "total_cents"        INTEGER NOT NULL,
  "currency"           TEXT NOT NULL DEFAULT 'USD',

  "delivery_address"   JSONB,
  "customer_note"      TEXT,
  "contact_email"      TEXT,
  "contact_phone"      TEXT,

  -- Guests can place orders, so a claim token is what lets them come back to
  -- the order later without an account.
  "guest_token"        TEXT,

  -- Client-supplied key that makes order placement safe to retry. A
  -- double-clicked Place Order button, or a retry after a dropped response,
  -- must return the original order rather than create a second one.
  "idempotency_key"    TEXT,

  "placed_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at"         TIMESTAMPTZ,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The service computes totals; the database refuses to store an inconsistent
  -- one. A rounding bug becomes a failed request rather than a wrong charge.
  CONSTRAINT "orders_total_consistent" CHECK (
    "total_cents" = "subtotal_cents" - "discount_cents" + "tax_cents"
                    + "delivery_fee_cents" + "tip_cents"
  ),
  CONSTRAINT "orders_amounts_nonneg" CHECK (
    "subtotal_cents" >= 0 AND "discount_cents" >= 0 AND "tax_cents" >= 0
    AND "delivery_fee_cents" >= 0 AND "tip_cents" >= 0 AND "total_cents" >= 0
  ),
  -- A delivery order without an address cannot be delivered.
  CONSTRAINT "orders_delivery_has_address" CHECK (
    "fulfillment" <> 'DELIVERY' OR "delivery_address" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "orders_store_number" ON "orders" ("store_id", "order_number");
-- Scoped per store: two shops may independently generate the same client key,
-- and one must not block the other's order.
CREATE UNIQUE INDEX "orders_idempotency" ON "orders" ("store_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE UNIQUE INDEX "orders_guest_token" ON "orders" ("guest_token") WHERE "guest_token" IS NOT NULL;
CREATE INDEX "orders_store_status" ON "orders" ("store_id", "status", "placed_at" DESC);
CREATE INDEX "orders_customer" ON "orders" ("customer_id", "placed_at" DESC);
CREATE INDEX "orders_expiry" ON "orders" ("expires_at") WHERE "status" = 'PENDING';

CREATE TABLE "order_items" (
  "id"                TEXT PRIMARY KEY,
  "order_id"          TEXT NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "store_id"          TEXT NOT NULL REFERENCES "stores"("id"),
  -- Nullable on purpose: an order line must survive the product being deleted.
  -- Everything needed to read the receipt is snapshotted alongside it.
  "variant_id"        TEXT REFERENCES "product_variants"("id") ON DELETE SET NULL,
  "product_name"      TEXT NOT NULL,
  "variant_attrs"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "sku"               TEXT,
  "unit_price_cents"  INTEGER NOT NULL,
  "qty"               INTEGER NOT NULL,
  "line_total_cents"  INTEGER NOT NULL,
  "tax_cents"         INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "order_items_qty_positive" CHECK ("qty" > 0),
  CONSTRAINT "order_items_line_total" CHECK ("line_total_cents" = "unit_price_cents" * "qty")
);
CREATE INDEX "order_items_order" ON "order_items" ("order_id");

CREATE TABLE "order_status_history" (
  "id"            TEXT PRIMARY KEY,
  "order_id"      TEXT NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "store_id"      TEXT NOT NULL REFERENCES "stores"("id"),
  "from_status"   "OrderStatus",
  "to_status"     "OrderStatus" NOT NULL,
  -- NULL actor means the system did it (expiry sweeper, webhook).
  "actor_user_id" TEXT REFERENCES "users"("id"),
  "note"          TEXT,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "order_status_history_order" ON "order_status_history" ("order_id", "created_at");

-- Backstop for the state machine in packages/shared. The service is
-- authoritative and gives good error messages; this catches the case where
-- some future code path updates status without going through it.
CREATE OR REPLACE FUNCTION check_order_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'PENDING'          AND NEW.status IN ('CONFIRMED', 'CANCELLED')) OR
    (OLD.status = 'CONFIRMED'        AND NEW.status IN ('PREPARING', 'CANCELLED')) OR
    (OLD.status = 'PREPARING'        AND NEW.status IN ('READY', 'CANCELLED')) OR
    (OLD.status = 'READY'            AND NEW.status IN ('PICKED_UP', 'OUT_FOR_DELIVERY', 'CANCELLED')) OR
    (OLD.status = 'OUT_FOR_DELIVERY' AND NEW.status IN ('DELIVERED', 'READY')) OR
    (OLD.status = 'PICKED_UP'        AND NEW.status = 'RETURNED') OR
    (OLD.status = 'DELIVERED'        AND NEW.status = 'RETURNED') OR
    (OLD.status = 'CANCELLED'        AND NEW.status = 'REFUNDED') OR
    (OLD.status = 'RETURNED'         AND NEW.status = 'REFUNDED')
  ) THEN
    RAISE EXCEPTION 'Illegal order transition % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_transition_check
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION check_order_transition();

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

CREATE TABLE "payments" (
  "id"                       TEXT PRIMARY KEY,
  "store_id"                 TEXT NOT NULL REFERENCES "stores"("id"),
  "order_id"                 TEXT NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "provider"                 "PaymentProvider" NOT NULL,
  "stripe_payment_intent_id" TEXT,
  "amount_cents"             INTEGER NOT NULL,
  -- Always zero: the platform takes no cut of any sale. Kept as a column
  -- because Stripe's API has the field and a future plan tier might use it —
  -- but the pricing promise is $49/month and nothing per transaction.
  "application_fee_cents"    INTEGER NOT NULL DEFAULT 0,
  "status"                   "PaymentStatus" NOT NULL,
  "cash_received_by"         TEXT REFERENCES "users"("id"),
  "cash_received_at"         TIMESTAMPTZ,
  "failure_reason"           TEXT,
  "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "payments_amount_nonneg" CHECK ("amount_cents" >= 0),
  CONSTRAINT "payments_fee_zero" CHECK ("application_fee_cents" = 0)
);
CREATE UNIQUE INDEX "payments_intent" ON "payments" ("stripe_payment_intent_id")
  WHERE "stripe_payment_intent_id" IS NOT NULL;
CREATE INDEX "payments_order" ON "payments" ("order_id");

-- ---------------------------------------------------------------------------
-- Customer/store relationship rollup
-- ---------------------------------------------------------------------------

CREATE TABLE "customer_store_relations" (
  "id"                   TEXT PRIMARY KEY,
  "store_id"             TEXT NOT NULL REFERENCES "stores"("id"),
  "user_id"              TEXT NOT NULL REFERENCES "users"("id"),
  "first_order_at"       TIMESTAMPTZ,
  "order_count"          INTEGER NOT NULL DEFAULT 0,
  "lifetime_spend_cents" BIGINT NOT NULL DEFAULT 0,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "customer_store_relations_unique" ON "customer_store_relations" ("store_id", "user_id");

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE "stock_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_levels" FORCE ROW LEVEL SECURITY;
-- Stock counts are the store's business, not the public's. The storefront
-- shows availability through the order path, never by reading these rows.
CREATE POLICY stock_levels_tenant ON "stock_levels" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_tenant ON "stock_movements" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE "carts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carts" FORCE ROW LEVEL SECURITY;
-- Customer-owned: a shopper reaches their own cart, the store never browses
-- other people's carts through this path.
CREATE POLICY carts_owner ON "carts" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR ("user_id" IS NOT NULL AND "user_id" = NULLIF(current_setting('app.user_id', true), ''))
    OR ("session_key" IS NOT NULL AND "session_key" = NULLIF(current_setting('app.session_key', true), ''))
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR ("user_id" IS NOT NULL AND "user_id" = NULLIF(current_setting('app.user_id', true), ''))
    OR ("session_key" IS NOT NULL AND "session_key" = NULLIF(current_setting('app.session_key', true), ''))
  );

ALTER TABLE "cart_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cart_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY cart_items_owner ON "cart_items" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "cart_id" IN (
      SELECT id FROM carts
      WHERE ("user_id" IS NOT NULL AND "user_id" = NULLIF(current_setting('app.user_id', true), ''))
         OR ("session_key" IS NOT NULL AND "session_key" = NULLIF(current_setting('app.session_key', true), ''))
    )
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "cart_id" IN (
      SELECT id FROM carts
      WHERE ("user_id" IS NOT NULL AND "user_id" = NULLIF(current_setting('app.user_id', true), ''))
         OR ("session_key" IS NOT NULL AND "session_key" = NULLIF(current_setting('app.session_key', true), ''))
    )
  );

ALTER TABLE "store_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY store_counters_tenant ON "store_counters" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
-- Dual-ownership: the store that must fulfil it, and the customer who placed
-- it. Split read/write so the customer branch cannot be used to delete.
CREATE POLICY orders_read ON "orders" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR ("customer_id" IS NOT NULL AND "customer_id" = NULLIF(current_setting('app.user_id', true), ''))
  -- A guest holding the claim token from their receipt. Exact-match on a
  -- server-generated random token, so it cannot be enumerated.
  OR ("guest_token" IS NOT NULL AND "guest_token" = NULLIF(current_setting('app.guest_token', true), ''))
);
CREATE POLICY orders_write ON "orders" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
    OR ("customer_id" IS NOT NULL AND "customer_id" = NULLIF(current_setting('app.user_id', true), ''))
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
    OR ("customer_id" IS NOT NULL AND "customer_id" = NULLIF(current_setting('app.user_id', true), ''))
  );

ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_items_read ON "order_items" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR "order_id" IN (
    SELECT id FROM orders
    WHERE ("customer_id" IS NOT NULL AND "customer_id" = NULLIF(current_setting('app.user_id', true), ''))
       OR ("guest_token" IS NOT NULL AND "guest_token" = NULLIF(current_setting('app.guest_token', true), ''))
  )
);
CREATE POLICY order_items_write ON "order_items" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
    OR "order_id" IN (
      SELECT id FROM orders
      WHERE "customer_id" IS NOT NULL AND "customer_id" = NULLIF(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
    OR "order_id" IN (
      SELECT id FROM orders
      WHERE "customer_id" IS NOT NULL AND "customer_id" = NULLIF(current_setting('app.user_id', true), '')
    )
  );

ALTER TABLE "order_status_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_status_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_status_history_read ON "order_status_history" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR "order_id" IN (
    SELECT id FROM orders
    WHERE ("customer_id" IS NOT NULL AND "customer_id" = NULLIF(current_setting('app.user_id', true), ''))
       OR ("guest_token" IS NOT NULL AND "guest_token" = NULLIF(current_setting('app.guest_token', true), ''))
  )
);
CREATE POLICY order_status_history_write ON "order_status_history" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
    OR "order_id" IN (
      SELECT id FROM orders
      WHERE "customer_id" IS NOT NULL AND "customer_id" = NULLIF(current_setting('app.user_id', true), '')
    )
  );

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
-- Payment rows are the store's and the platform's. A customer sees payment
-- state through their order, not by reading this table.
CREATE POLICY payments_read ON "payments" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR "order_id" IN (
    SELECT id FROM orders
    WHERE "customer_id" IS NOT NULL AND "customer_id" = NULLIF(current_setting('app.user_id', true), '')
  )
);
CREATE POLICY payments_write ON "payments" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE "customer_store_relations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_store_relations" FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_store_relations_read ON "customer_store_relations" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')
);
CREATE POLICY customer_store_relations_write ON "customer_store_relations" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

-- `ALTER DEFAULT PRIVILEGES` in migration 1 grants bba_app full DML on every
-- table created afterwards, so a narrower GRANT here would add nothing — it is
-- additive, and revokes nothing. Append-only means an explicit REVOKE, which is
-- the same shape audit_logs uses.
GRANT SELECT, INSERT, UPDATE, DELETE ON "stock_levels" TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "carts" TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "cart_items" TO bba_app;
GRANT SELECT, INSERT, UPDATE ON "store_counters" TO bba_app;
GRANT SELECT, INSERT, UPDATE ON "orders" TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "order_items" TO bba_app;
GRANT SELECT, INSERT, UPDATE ON "payments" TO bba_app;
GRANT SELECT, INSERT, UPDATE ON "customer_store_relations" TO bba_app;

-- The stock ledger is the record of what physically happened. If the
-- application can rewrite it, reconciling it against on-hand proves nothing.
REVOKE UPDATE, DELETE ON "stock_movements" FROM bba_app;
GRANT SELECT, INSERT ON "stock_movements" TO bba_app;

-- Order history is evidence in a chargeback or a dispute; it must accumulate,
-- never be edited.
REVOKE UPDATE, DELETE ON "order_status_history" FROM bba_app;
GRANT SELECT, INSERT ON "order_status_history" TO bba_app;

-- Deliberately NOT revoked: `orders` and `payments` legitimately change state,
-- and `store_counters` must increment. Their integrity comes from the
-- transition trigger and the CHECK constraints, not from immutability.
