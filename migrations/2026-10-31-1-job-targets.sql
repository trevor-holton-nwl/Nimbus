-- ============================================================================
-- Migration: job targets and batches (job_target, job_batch)
-- Date: 2026-10-31
-- Purely additive and idempotent: two new tables; no existing data is touched.
-- Mirrors the block appended to schema.sql and backend/jobs/data.py::ensure_job_tables().
-- job_target: which plants one job definition runs for (explicit plants, a
-- subnetwork, or all). job_batch: one fan-out of a job over its plants; its
-- child runs point at it through job_run.batch_id, a column added by the
-- startup hook together with job_schedule.tz_mode / fixed_timezone and
-- job_definition.fan_out (columns on existing tables are not migrated here).
-- No cascading foreign keys on purpose: the retention sweep removes batches in
-- code, after their runs (see backend/jobs/CLAUDE.md).
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_target (
    id               BIGSERIAL PRIMARY KEY,
    job_id           BIGINT NOT NULL REFERENCES job_definition (id),
    kind             TEXT NOT NULL CHECK (kind IN ('explicit','subnetwork','all')),
    value            TEXT NOT NULL DEFAULT '',   -- plant code | subnetwork code | '*' or a plant list for 'all'
    excluded         BOOLEAN NOT NULL DEFAULT FALSE,
    params_override  JSONB,                      -- deep-merged over the job params for the plants this row adds
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_target_job ON job_target (job_id, id);

CREATE TABLE IF NOT EXISTS job_batch (
    id             BIGSERIAL PRIMARY KEY,
    job_id         BIGINT NOT NULL REFERENCES job_definition (id),
    schedule_id    BIGINT REFERENCES job_schedule (id),
    scheduled_for  TIMESTAMPTZ,
    trigger        TEXT NOT NULL CHECK (trigger IN ('schedule','manual','restart')),
    triggered_by   TEXT,
    status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','warning','failed')),
    counts         JSONB,                        -- {total, <status>: n}
    started_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    ended_at       TIMESTAMPTZ,
    summary        JSONB
);
CREATE INDEX IF NOT EXISTS idx_job_batch_job ON job_batch (job_id, id DESC);
