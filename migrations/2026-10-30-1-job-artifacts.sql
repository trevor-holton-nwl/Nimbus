-- ============================================================================
-- Migration: job run artifacts (job_run_artifact)
-- Date: 2026-10-30
-- Purely additive and idempotent: one new table; no existing data is touched.
-- Mirrors the block appended to schema.sql and backend/jobs/data.py::ensure_job_tables().
-- Holds the stored result of a report job (JSON text, size capped in code).
-- No cascading foreign keys on purpose: the retention sweep removes the
-- artifact by run id in code, before the run row (see backend/jobs/CLAUDE.md).
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_run_artifact (
    run_id        BIGINT PRIMARY KEY REFERENCES job_run (id),
    content_type  TEXT NOT NULL DEFAULT 'application/json',
    filename      TEXT,
    body          TEXT NOT NULL,             -- JSON text: {sections:[{key,title,columns,rows}], summary}
    row_count     INTEGER NOT NULL DEFAULT 0,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
