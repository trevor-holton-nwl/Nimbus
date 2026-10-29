-- ============================================================================
-- Migration: job chain steps (job_step_run)
-- Date: 2026-11-01
-- Purely additive and idempotent: one new table; no existing data is touched.
-- Mirrors the block in schema.sql and backend/jobs/data.py::ensure_job_tables().
-- One row per step of a chain run: its type, the params snapshot the run started
-- it with, its own status, summary, error and schedule-event action id.
-- No cascading foreign keys on purpose: the retention sweep removes step rows by
-- run id in code, before the run rows (see backend/jobs/CLAUDE.md).
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_step_run (
    run_id               BIGINT NOT NULL REFERENCES job_run (id),
    seq                  INTEGER NOT NULL,
    step_type            TEXT NOT NULL,              -- registry key of the step's job type
    label                TEXT,
    run_on               TEXT NOT NULL DEFAULT 'success' CHECK (run_on IN ('success','failure','always')),
    continue_on_failure  BOOLEAN NOT NULL DEFAULT FALSE,
    params               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- the snapshot this run started the step with
    status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','running','succeeded','warning','failed','skipped','cancelled')),
    started_at           TIMESTAMPTZ,
    ended_at             TIMESTAMPTZ,
    summary              JSONB,
    error                TEXT,
    error_kind           TEXT CHECK (error_kind IN ('config','system','transient')),
    action_id            TEXT,                       -- schedule-event history id of the step's own write
    PRIMARY KEY (run_id, seq)
);
