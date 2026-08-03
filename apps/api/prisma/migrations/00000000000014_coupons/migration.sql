-- Coupons (FR-CAT-06).

CREATE TYPE "CouponKind" AS ENUM ('PERCENT', 'FIXED');

CREATE TABLE "coupons" (
  "id"                 TEXT PRIMARY KEY,
  "store_id"           TEXT NOT NULL REFERENCES "stores"("id"),
  -- citext: shoppers type coupon codes by hand, from memory, off a flyer.
  -- Case-sensitivity here would be a support burden and nothing else.
  "code"               CITEXT NOT NULL,
  "kind"               "CouponKind" NOT NULL,
  -- Basis points for PERCENT, cents for FIXED. One column because a coupon is
  -- never both, and two nullable columns would let it be neither.
  "value"              INTEGER NOT NULL,
  "min_order_cents"    INTEGER NOT NULL DEFAULT 0,
  "starts_at"          TIMESTAMPTZ,
  "ends_at"            TIMESTAMPTZ,
  "max_redemptions"    INTEGER,
  "per_customer_limit" INTEGER,
  "active"             BOOLEAN NOT NULL DEFAULT true,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deleted_at"         TIMESTAMPTZ,

  CONSTRAINT "coupons_value_positive" CHECK ("value" > 0),
  -- A percentage over 100 would pay the customer to shop. Guarded in the
  -- database because it is the kind of typo an owner makes at 6am.
  CONSTRAINT "coupons_percent_sane" CHECK (
    "kind" <> 'PERCENT' OR "value" <= 10000
  ),
  CONSTRAINT "coupons_min_order_nonneg" CHECK ("min_order_cents" >= 0),
  CONSTRAINT "coupons_window_ordered" CHECK (
    "starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" < "ends_at"
  ),
  CONSTRAINT "coupons_limits_positive" CHECK (
    ("max_redemptions" IS NULL OR "max_redemptions" > 0)
    AND ("per_customer_limit" IS NULL OR "per_customer_limit" > 0)
  )
);

-- Partial, so a deleted code can be reissued later.
CREATE UNIQUE INDEX "coupons_store_code" ON "coupons" ("store_id", "code")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "coupons_store_active" ON "coupons" ("store_id", "active")
  WHERE "deleted_at" IS NULL;

CREATE TABLE "coupon_redemptions" (
  "id"         TEXT PRIMARY KEY,
  "coupon_id"  TEXT NOT NULL REFERENCES "coupons"("id"),
  "store_id"   TEXT NOT NULL REFERENCES "stores"("id"),
  "order_id"   TEXT NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  -- NULL for a guest. The per-customer limit can only be enforced for someone
  -- we can identify, which is a real limitation and not a bug: a guest can
  -- reuse a code by checking out as a guest again.
  "user_id"    TEXT REFERENCES "users"("id"),
  "amount_cents" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "coupon_redemptions_amount_positive" CHECK ("amount_cents" > 0)
);

-- One redemption per order. This is what makes the usage count trustworthy —
-- without it a retried checkout could count the same order twice against a
-- limited coupon.
CREATE UNIQUE INDEX "coupon_redemptions_order" ON "coupon_redemptions" ("coupon_id", "order_id");
CREATE INDEX "coupon_redemptions_per_customer" ON "coupon_redemptions" ("coupon_id", "user_id");

ALTER TABLE "orders" ADD COLUMN "coupon_id" TEXT REFERENCES "coupons"("id");
ALTER TABLE "orders" ADD COLUMN "coupon_code" TEXT;

ALTER TABLE "coupons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coupons" FORCE ROW LEVEL SECURITY;
-- Store-scoped for management, plus a public read branch so a shopper can
-- have their code validated at checkout without an account. Only live coupons
-- on live stores are visible that way — an expired or disabled code is
-- indistinguishable from one that never existed.
CREATE POLICY coupons_read ON "coupons" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR (
    deleted_at IS NULL
    AND active
    AND store_id IN (SELECT id FROM stores WHERE status = 'ACTIVE' AND deleted_at IS NULL)
  )
);
CREATE POLICY coupons_write ON "coupons" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE "coupon_redemptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coupon_redemptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY coupon_redemptions_read ON "coupon_redemptions" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR ("user_id" IS NOT NULL AND "user_id" = NULLIF(current_setting('app.user_id', true), ''))
);
CREATE POLICY coupon_redemptions_write ON "coupon_redemptions" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

GRANT SELECT, INSERT, UPDATE ON "coupons" TO bba_app;
GRANT SELECT, INSERT ON "coupon_redemptions" TO bba_app;

-- A redemption is the record that a discount was given. It accumulates and is
-- never rewritten — the usage count depends on that.
REVOKE UPDATE, DELETE ON "coupon_redemptions" FROM bba_app;
REVOKE DELETE ON "coupons" FROM bba_app;
