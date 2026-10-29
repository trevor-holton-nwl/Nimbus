-- ============================================================================
-- Migration: job scheduler (job_definition, job_schedule, job_run, job_run_log)
-- Date: 2026-10-29
-- Purely additive and idempotent: four new tables and their indexes only; no
-- existing data is touched. Mirrors the block appended to schema.sql and
-- backend/jobs/data.py::ensure_job_tables().
-- No cascading foreign keys on purpose: the retention sweep removes log lines
-- by run id in code, then the run rows (see backend/jobs/CLAUDE.md).
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_definition (
    id            BIGSERIAL PRIMARY KEY,
    plant         TEXT NOT NULL,             -- no FK on purpose (same posture as schedule_event)
    job_type      TEXT NOT NULL,             -- registry key, e.g. optimizer.plant
    name          TEXT NOT NULL,
    params        JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    archived      BOOLEAN NOT NULL DEFAULT FALSE,   -- a removed job stays for its run history
    retry_max     INTEGER NOT NULL DEFAULT 0 CHECK (retry_max BETWEEN 0 AND 5),
    timeout_s     INTEGER CHECK (timeout_s IS NULL OR timeout_s BETWEEN 10 AND 21600),
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    modified_by   TEXT,
    modified_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_definition_plant ON job_definition (plant, id DESC);

CREATE TABLE IF NOT EXISTS job_schedule (
    id               BIGSERIAL PRIMARY KEY,
    job_id           BIGINT NOT NULL REFERENCES job_definition (id),
    kind             TEXT NOT NULL CHECK (kind IN ('once','hourly','daily','weekdays','weekly','monthly','cron')),
    cron_expr        TEXT,                   -- compiled 5-field cron (presets and custom); null for once
    time_of_day      TEXT,                   -- HH:MM plant-local, presets only
    days_of_week     SMALLINT[],             -- 0 = Monday .. 6 = Sunday, weekly only
    day_of_month     SMALLINT CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
    run_at           TIMESTAMP,              -- naive plant-local, once only
    timezone         TEXT NOT NULL,          -- IANA name copied from the plant when saved
    valid_from       TIMESTAMP,              -- naive plant-local
    valid_until      TIMESTAMP,              -- naive plant-local
    paused           BOOLEAN NOT NULL DEFAULT FALSE,
    retired          BOOLEAN NOT NULL DEFAULT FALSE,   -- a removed or spent schedule
    misfire_grace_s  INTEGER NOT NULL DEFAULT 300 CHECK (misfire_grace_s BETWEEN 1 AND 86400),
    skip_if_running  BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    modified_by      TEXT,
    modified_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_schedule_job ON job_schedule (job_id, id);

CREATE TABLE IF NOT EXISTS job_run (
    id               BIGSERIAL PRIMARY KEY,
    job_id           BIGINT NOT NULL REFERENCES job_definition (id),
    schedule_id      BIGINT REFERENCES job_schedule (id),
    plant            TEXT NOT NULL,          -- copied from the definition so history survives edits
    job_type         TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN
                       ('scheduled','running','succeeded','warning','failed','cancelled','skipped')),
    trigger          TEXT NOT NULL CHECK (trigger IN ('schedule','manual','retry')),
    attempt          INTEGER NOT NULL DEFAULT 1,
    scheduled_for    TIMESTAMPTZ,
    started_at       TIMESTAMPTZ,
    ended_at         TIMESTAMPTZ,
    triggered_by     TEXT,
    summary          JSONB,                  -- e.g. late, changeovers, moved, applied, dropped
    error            TEXT,
    log_truncated    BOOLEAN NOT NULL DEFAULT FALSE,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_run_plant   ON job_run (plant, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_run_job     ON job_run (job_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_run_created ON job_run (created_at);

CREATE TABLE IF NOT EXISTS job_run_log (
    run_id       BIGINT NOT NULL REFERENCES job_run (id),
    seq          INTEGER NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    level        TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
    step         TEXT,
    msg          TEXT NOT NULL,
    duration_ms  INTEGER,
    data         JSONB,
    PRIMARY KEY (run_id, seq)
);
