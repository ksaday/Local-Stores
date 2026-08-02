-- SaaS billing: the subscription that is the platform's actual revenue
-- (plan §18.5a).
--
-- Entirely separate from Connect. Connect is the *store* receiving money from
-- *its* customers; this is the platform charging the store owner $49/month.
-- Two different Stripe relationships that must never be confused: a store's
-- connected account has nothing to do with whether they have paid us.

CREATE TYPE "SubscriptionStatus" AS ENUM (
  'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'
);

CREATE TABLE "plans" (
  "code"             TEXT PRIMARY KEY,
  "name"             TEXT NOT NULL,
  "price_cents"      INTEGER NOT NULL,
  "interval"         TEXT NOT NULL DEFAULT 'month',
  "trial_days"       INTEGER NOT NULL DEFAULT 30,
  -- Zero, and a CHECK keeps it that way. The public commitment is that BBA
  -- takes no cut of a store's sales; a plan able to express otherwise is a
  -- foot-gun sitting next to a promise.
  "platform_fee_bps" INTEGER NOT NULL DEFAULT 0,
  "limits"           JSONB NOT NULL DEFAULT '{}'::jsonb,
  "stripe_price_id"  TEXT,
  "active"           BOOLEAN NOT NULL DEFAULT true,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "plans_price_nonneg" CHECK ("price_cents" >= 0),
  CONSTRAINT "plans_no_transaction_fee" CHECK ("platform_fee_bps" = 0)
);

-- v2.0 ships exactly one row. The table and the FK exist so a second tier is
-- later a row rather than a migration — but no plan-gating or upgrade logic
-- ships, which is a real scope reduction rather than an oversight.
INSERT INTO "plans" ("code", "name", "price_cents", "interval", "trial_days", "platform_fee_bps")
VALUES ('STANDARD', 'Standard', 4900, 'month', 30, 0);

CREATE TABLE "store_subscriptions" (
  "id"                     TEXT PRIMARY KEY,
  -- One subscription per store, enforced rather than assumed: two live
  -- subscriptions would bill a shop twice for the same month.
  "store_id"               TEXT NOT NULL UNIQUE REFERENCES "stores"("id"),
  "plan_code"              TEXT NOT NULL REFERENCES "plans"("code"),
  "stripe_customer_id"     TEXT,
  "stripe_subscription_id" TEXT,
  "status"                 "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
  "trial_ends_at"          TIMESTAMPTZ,
  "current_period_end"     TIMESTAMPTZ,

  -- When the account first went unpaid. The grace period is measured from
  -- here, so it does not restart every time Stripe retries the card.
  "past_due_since"         TIMESTAMPTZ,
  -- Set when the store was suspended for non-payment, so reinstating it can
  -- be told apart from a suspension a Super Admin applied by hand.
  "suspended_at"           TIMESTAMPTZ,

  "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "store_subscriptions_stripe_sub"
  ON "store_subscriptions" ("stripe_subscription_id")
  WHERE "stripe_subscription_id" IS NOT NULL;
CREATE UNIQUE INDEX "store_subscriptions_stripe_customer"
  ON "store_subscriptions" ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;
-- The grace-period sweep's only query.
CREATE INDEX "store_subscriptions_past_due" ON "store_subscriptions" ("past_due_since")
  WHERE "status" = 'PAST_DUE';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plans" FORCE ROW LEVEL SECURITY;
-- Readable by anyone: the price is public, and a store owner needs to see what
-- they are being charged. Writable only by the platform.
CREATE POLICY plans_read ON "plans" FOR SELECT USING (true);
CREATE POLICY plans_write ON "plans" FOR ALL
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

ALTER TABLE "store_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_subscriptions" FORCE ROW LEVEL SECURITY;
-- A store sees its own billing state; the platform sees everything. Split so
-- the store branch cannot be used to cancel or rewrite a subscription — that
-- happens through Stripe and arrives back as a webhook.
CREATE POLICY store_subscriptions_read ON "store_subscriptions" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
);
CREATE POLICY store_subscriptions_write ON "store_subscriptions" FOR ALL
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

GRANT SELECT ON "plans" TO bba_app;
GRANT SELECT, INSERT, UPDATE ON "store_subscriptions" TO bba_app;

-- A subscription record outlives the subscription: a store that lapses and
-- returns should find its history intact.
REVOKE DELETE ON "store_subscriptions" FROM bba_app;
