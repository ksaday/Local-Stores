-- Stripe payments (plan §12.10, §18.6).

CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- ---------------------------------------------------------------------------
-- Connected account state on the store
-- ---------------------------------------------------------------------------

-- `stripe_account_id` and `stripe_charges_enabled` already exist. These are the
-- rest of what an owner needs to see to understand why they cannot take money.
ALTER TABLE "stores"
  ADD COLUMN "stripe_payouts_enabled"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stripe_details_submitted" BOOLEAN NOT NULL DEFAULT false,
  -- What Stripe is still waiting for, verbatim. Stored so the settings page can
  -- tell the owner precisely what is outstanding rather than "contact support".
  ADD COLUMN "stripe_requirements"     JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "stripe_disabled_reason"  TEXT,
  ADD COLUMN "stripe_synced_at"        TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Webhook events
-- ---------------------------------------------------------------------------

-- Every webhook Stripe sends us, recorded before it is acted on.
--
-- Stripe guarantees at-least-once delivery and will replay events, sometimes
-- days later and sometimes out of order. The unique constraint on the
-- provider's event id is what makes a replay a no-op instead of a second
-- refund: the insert fails, the handler never runs.
CREATE TABLE "stripe_events" (
  "id"           TEXT PRIMARY KEY,
  -- Stripe's event id (evt_...). The idempotency key for the whole system.
  "event_id"     TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  -- The connected account it happened on, when account-scoped.
  "account_id"   TEXT,
  -- Resolved from the account or the intent metadata, when we can.
  "store_id"     TEXT REFERENCES "stores"("id"),
  "payload"      JSONB NOT NULL,
  "received_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processed_at" TIMESTAMPTZ,
  -- Set when a handler threw, so a failed event is visible rather than lost.
  "error"        TEXT
);

CREATE UNIQUE INDEX "stripe_events_event_id" ON "stripe_events" ("event_id");
CREATE INDEX "stripe_events_unprocessed" ON "stripe_events" ("received_at")
  WHERE "processed_at" IS NULL;
CREATE INDEX "stripe_events_store" ON "stripe_events" ("store_id", "received_at" DESC);

-- ---------------------------------------------------------------------------
-- Refunds
-- ---------------------------------------------------------------------------

CREATE TABLE "refunds" (
  "id"                TEXT PRIMARY KEY,
  "store_id"          TEXT NOT NULL REFERENCES "stores"("id"),
  "payment_id"        TEXT NOT NULL REFERENCES "payments"("id") ON DELETE CASCADE,
  "amount_cents"      INTEGER NOT NULL,
  "reason_code"       TEXT,
  "note"              TEXT,
  "status"            "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "stripe_refund_id"  TEXT,
  "actor_user_id"     TEXT REFERENCES "users"("id"),
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "refunds_amount_positive" CHECK ("amount_cents" > 0)
);

CREATE UNIQUE INDEX "refunds_stripe_id" ON "refunds" ("stripe_refund_id")
  WHERE "stripe_refund_id" IS NOT NULL;
CREATE INDEX "refunds_store" ON "refunds" ("store_id", "created_at" DESC);
CREATE INDEX "refunds_payment" ON "refunds" ("payment_id");

-- Refunds may never exceed what was actually captured.
--
-- A CHECK constraint cannot see sibling rows, so this is a trigger: it sums
-- every non-failed refund against the payment and refuses the one that would
-- tip it over. Without it, two partial refunds issued concurrently each look
-- valid alone and together hand back more than the customer ever paid.
CREATE OR REPLACE FUNCTION check_refund_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  captured INTEGER;
  already  INTEGER;
BEGIN
  -- FOR UPDATE serialises concurrent refunds against the same payment.
  SELECT amount_cents INTO captured FROM payments WHERE id = NEW.payment_id FOR UPDATE;

  IF captured IS NULL THEN
    RAISE EXCEPTION 'Refund references a payment that does not exist';
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO already
  FROM refunds
  WHERE payment_id = NEW.payment_id
    AND status <> 'FAILED'
    AND id <> NEW.id;

  IF already + NEW.amount_cents > captured THEN
    RAISE EXCEPTION 'Refunds (% + %) would exceed the captured amount (%)',
      already, NEW.amount_cents, captured;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER refunds_within_captured
  BEFORE INSERT OR UPDATE OF amount_cents, status ON refunds
  FOR EACH ROW EXECUTE FUNCTION check_refund_total();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE "stripe_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_events" FORCE ROW LEVEL SECURITY;
-- Platform-only. Webhook payloads carry provider internals and, for account
-- events, another business's compliance state — a store owner has no reason to
-- read them, and the store branch exists only so a future support screen can
-- show a store its own payment events.
CREATE POLICY stripe_events_read ON "stripe_events" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR ("store_id" IS NOT NULL AND "store_id" = NULLIF(current_setting('app.store_id', true), ''))
);
CREATE POLICY stripe_events_write ON "stripe_events" FOR ALL
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY;
CREATE POLICY refunds_read ON "refunds" FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  -- A customer sees refunds against their own order.
  OR "payment_id" IN (
    SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE o.customer_id IS NOT NULL
      AND o.customer_id = NULLIF(current_setting('app.user_id', true), '')
  )
);
CREATE POLICY refunds_write ON "refunds" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

GRANT SELECT, INSERT, UPDATE ON "stripe_events" TO bba_app;
GRANT SELECT, INSERT, UPDATE ON "refunds" TO bba_app;

-- A refund is a financial record. It may be created and have its status
-- advanced by the webhook, but never rewritten or removed.
REVOKE DELETE ON "refunds" FROM bba_app;
REVOKE DELETE ON "stripe_events" FROM bba_app;
