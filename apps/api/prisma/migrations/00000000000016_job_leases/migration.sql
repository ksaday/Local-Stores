-- Leases for scheduled jobs, so a second worker does not double the sweeps
-- (plan §7.6, §12.9).
--
-- The scheduler has always been plain `setInterval` in every worker process,
-- which is correct with one worker and quietly wrong with two: both would run
-- every sweep. Most of those are idempotent enough to survive it, but dunning
-- is not — two workers reaching the same past-due store in the same second
-- both send before either records, and the owner gets the same warning twice.
--
-- A lease rather than a mutex. There is nothing to hold and release: a worker
-- claims the *tick*, and the claim expires on its own. A process that dies
-- mid-job therefore blocks nothing, which a held lock would.

CREATE TABLE "scheduled_job_runs" (
  "job_name"        TEXT PRIMARY KEY,
  "last_started_at" TIMESTAMPTZ NOT NULL,
  -- Which process claimed it. Only for reading logs afterwards — nothing keys
  -- off this, because a worker must never depend on being the same one twice.
  "owner"           TEXT NOT NULL
);

ALTER TABLE "scheduled_job_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_job_runs" FORCE ROW LEVEL SECURITY;

-- Platform infrastructure, not tenant data: no store can see it, and the
-- table carries no store_id to scope by even if one tried.
CREATE POLICY scheduled_job_runs_platform ON "scheduled_job_runs" FOR ALL
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON "scheduled_job_runs" TO bba_app;

-- Rows are one per job and are updated in place forever; deleting one would
-- silently hand out a free extra run of whatever it was holding back.
REVOKE DELETE ON "scheduled_job_runs" FROM bba_app;
