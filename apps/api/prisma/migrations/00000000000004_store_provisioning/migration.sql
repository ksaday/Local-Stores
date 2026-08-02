-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "store_applications" (
    "id" TEXT NOT NULL,
    "applicant_name" TEXT NOT NULL,
    "applicant_email" CITEXT NOT NULL,
    "applicant_phone" TEXT,
    "business_name" TEXT NOT NULL,
    "business_type" "BusinessType" NOT NULL,
    "address_line1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "pitch" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "store_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_hours" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "opens" TEXT,
    "closes" TEXT,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "store_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "store_id" TEXT,
    "severity" "AuditSeverity" NOT NULL DEFAULT 'MEDIUM',
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_applications_store_id_key" ON "store_applications"("store_id");

-- CreateIndex
CREATE INDEX "store_applications_status_created_at_idx" ON "store_applications"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_hours_store_id_weekday_key" ON "store_hours"("store_id", "weekday");

-- CreateIndex
CREATE INDEX "tax_rates_store_id_active_idx" ON "tax_rates"("store_id", "active");

-- CreateIndex
CREATE INDEX "audit_logs_store_id_created_at_idx" ON "audit_logs"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_severity_created_at_idx" ON "audit_logs"("severity", "created_at");

-- AddForeignKey
ALTER TABLE "store_hours" ADD CONSTRAINT "store_hours_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- RLS for the Phase 4 tables.
-- ---------------------------------------------------------------------------

-- store_applications: platform-only. An application is a request from someone
-- with no account and no store, reviewed by platform staff — no tenant has any
-- claim on it.
ALTER TABLE store_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_applications FORCE ROW LEVEL SECURITY;

CREATE POLICY store_applications_platform ON store_applications
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

-- Public intake: applying is an unauthenticated action, so the INSERT cannot be
-- expressed as a policy keyed to identity. Same pattern as the auth lookups —
-- a narrow SECURITY DEFINER function rather than a permissive policy.
CREATE OR REPLACE FUNCTION public_submit_store_application(
  p_applicant_name  text,
  p_applicant_email citext,
  p_applicant_phone text,
  p_business_name   text,
  p_business_type   "BusinessType",
  p_address_line1   text,
  p_city            text,
  p_state           text,
  p_postal_code     text,
  p_pitch           text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
VOLATILE
AS $$
DECLARE
  new_id text := gen_random_uuid()::text;
BEGIN
  INSERT INTO store_applications (
    id, applicant_name, applicant_email, applicant_phone, business_name,
    business_type, address_line1, city, state, postal_code, pitch,
    status, created_at, updated_at
  ) VALUES (
    new_id, p_applicant_name, p_applicant_email, p_applicant_phone, p_business_name,
    p_business_type, p_address_line1, p_city, p_state, p_postal_code, p_pitch,
    'PENDING', now(), now()
  );
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public_submit_store_application(text, citext, text, text, "BusinessType", text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_submit_store_application(text, citext, text, text, "BusinessType", text, text, text, text, text) TO bba_app;

-- store_hours and tax_rates: ordinary tenant tables.
ALTER TABLE store_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY store_hours_tenant ON store_hours
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_rates_tenant ON tax_rates
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

-- audit_logs: readable by the store it concerns and by the platform; writable
-- by anyone (the interceptor runs under whatever context the request has), but
-- NEVER updatable or deletable.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_read ON audit_logs FOR SELECT
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

-- Inserts are unconditional on purpose. An audit entry must be written even
-- when the action it records was rejected, and even when the actor's context
-- is partial — a policy that could block the write would let an attacker
-- suppress their own trail.
CREATE POLICY audit_logs_append ON audit_logs FOR INSERT WITH CHECK (true);

-- The teeth: no UPDATE or DELETE policy exists, and the privilege is revoked
-- outright. Evidence the application can rewrite is not evidence.
REVOKE UPDATE, DELETE ON audit_logs FROM bba_app;
GRANT SELECT, INSERT ON audit_logs TO bba_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON store_applications TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON store_hours TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tax_rates TO bba_app;
