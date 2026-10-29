-- ============================================================================
-- Migration: job templates (job_template)
-- Date: 2026-11-01
-- Purely additive and idempotent: one new table and one index; no existing data is touched.
-- Mirrors the block in schema.sql and backend/jobs/data.py::ensure_job_tables().
-- A template is a named, versioned, ordered step list. A job made from one stores
-- its own COPY of the steps plus the template id and version (columns added by the
-- startup hook, never by a migration), so editing a template never changes a job
-- or a run silently.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_template (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    steps        JSONB NOT NULL DEFAULT '[]'::jsonb,     -- ordered [{type, params, label, continue_on_failure, run_on}]
    defaults     JSONB NOT NULL DEFAULT '{}'::jsonb,     -- optional {retry_max, timeout_s} a new job starts with
    version      INTEGER NOT NULL DEFAULT 1,             -- raised by every change to steps or defaults
    created_by   TEXT,
    modified_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    archived     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_job_template_name ON job_template (lower(name)) WHERE NOT archived;
