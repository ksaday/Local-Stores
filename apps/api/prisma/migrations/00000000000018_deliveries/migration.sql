-- Delivery records (plan Phase 9).
--
-- Deliberately *not* a second state machine. The order already moves
-- READY → OUT_FOR_DELIVERY → DELIVERED, gated to the DELIVERY role, and that
-- is the status customers and staff both read. A parallel delivery status
-- would be a second answer to "where is this order", and the two would
-- disagree the first time one write succeeded and the other did not.
--
-- What lives here is everything the order has no business carrying: who is
-- taking it, when they picked it up, what proof they left, and why it came
-- back if it did.

CREATE TYPE "DeliveryFailureReason" AS ENUM (
  'NOBODY_HOME',
  'ADDRESS_NOT_FOUND',
  'REFUSED',
  'UNSAFE_TO_LEAVE',
  'VEHICLE_PROBLEM',
  'OTHER'
);

CREATE TABLE "deliveries" (
  "id"          TEXT PRIMARY KEY,
  "store_id"    TEXT NOT NULL REFERENCES "stores"("id"),
  -- One delivery per order. A second row would mean two drivers each believing
  -- the parcel is theirs.
  "order_id"    TEXT NOT NULL UNIQUE REFERENCES "orders"("id"),

  "driver_user_id" TEXT REFERENCES "users"("id"),
  "assigned_at"    TIMESTAMPTZ,
  "assigned_by"    TEXT REFERENCES "users"("id"),

  "picked_up_at"   TIMESTAMPTZ,
  "delivered_at"   TIMESTAMPTZ,

  -- Proof lives in the private media prefix and is served only by short-lived
  -- presigned URL: these are photographs of somebody's doorway and their
  -- handwriting (§13.7).
  "proof_media_asset_id"     TEXT REFERENCES "media_assets"("id"),
  "signature_media_asset_id" TEXT REFERENCES "media_assets"("id"),

  "failure_reason" "DeliveryFailureReason",
  "failure_note"   TEXT,
  "failed_at"      TIMESTAMPTZ,
  -- How many times somebody has been out with this. A second attempt is
  -- ordinary; a fourth is a conversation with the customer.
  "attempts"       INTEGER NOT NULL DEFAULT 0,

  "notes"      TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "deliveries_attempts_nonneg" CHECK ("attempts" >= 0)
);

-- The driver's own queue: "what am I taking out today".
CREATE INDEX "deliveries_driver" ON "deliveries" ("driver_user_id", "delivered_at");
-- The dispatcher's view: what still has nobody on it.
CREATE INDEX "deliveries_unassigned" ON "deliveries" ("store_id")
  WHERE "driver_user_id" IS NULL;

ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deliveries" FORCE ROW LEVEL SECURITY;

-- Store-scoped like everything operational. A driver reads their own queue
-- through the same store scope they already have as a member — the narrowing
-- to "own" deliveries is the service's job, because a driver covering for a
-- colleague still needs to see the round.
CREATE POLICY deliveries_tenant ON "deliveries" FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

GRANT SELECT, INSERT, UPDATE ON "deliveries" TO bba_app;

-- A delivery record outlives the delivery: it is the evidence that something
-- was handed over, and a failed attempt is as much a fact as a successful one.
REVOKE DELETE ON "deliveries" FROM bba_app;
