-- Transactional outbox (plan §12.8).
--
-- Domain events are written here *inside* the transaction that caused them, so
-- an event can never describe a change that rolled back, and can never be lost
-- because the database committed while the message broker was down. A relay
-- publishes unpublished rows and marks them.
--
-- This replaces emitting events straight from the service into an in-process
-- bus, which had two failure modes: nothing survived a restart, and a second
-- API instance never saw the first one's events.

CREATE TABLE "outbox_events" (
  "id"            BIGSERIAL PRIMARY KEY,
  "type"          TEXT NOT NULL,
  -- Nullable: some events are platform-wide. Present on everything a store's
  -- staff can be shown, which is what the relay filters on.
  "store_id"      TEXT REFERENCES "stores"("id"),
  "aggregate_id"  TEXT,
  "payload"       JSONB NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "published_at"  TIMESTAMPTZ,
  -- Counted so a permanently poisonous event can be parked rather than
  -- blocking the relay behind it forever.
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "last_error"    TEXT
);

-- The relay's only query: oldest unpublished first. Partial, so the index stays
-- the size of the backlog rather than the size of all history.
CREATE INDEX "outbox_unpublished" ON "outbox_events" ("id")
  WHERE "published_at" IS NULL;
CREATE INDEX "outbox_store" ON "outbox_events" ("store_id", "created_at" DESC);

-- BIGSERIAL rather than a uuid: the relay depends on publishing in the order
-- events happened, and a monotonic key is what gives it that. Order matters
-- here — "confirmed" arriving before "placed" would show staff nonsense.

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;

-- Platform-only. The relay runs as the platform, and no tenant has a reason to
-- read the raw event log; staff see the *effects* of events through their own
-- store-scoped tables.
CREATE POLICY outbox_events_platform ON "outbox_events" FOR ALL
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    -- A store-scoped transaction must be able to write its own events without
    -- escalating: checkout emits `order.created` while scoped to the store.
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

GRANT SELECT, INSERT, UPDATE ON "outbox_events" TO bba_app;
GRANT USAGE ON SEQUENCE "outbox_events_id_seq" TO bba_app;

-- Published rows are history and are purged on a retention schedule, never
-- edited. The relay only ever sets published_at, attempts and last_error.
REVOKE DELETE ON "outbox_events" FROM bba_app;
