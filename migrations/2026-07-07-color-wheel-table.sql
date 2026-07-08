-- ============================================================================
-- Migration: color_wheel table (durable per-plant color wheels)
-- Date: 2026-07-07
-- ============================================================================
-- SAFE TO RUN against the live Azure Postgres. This file is a verbatim copy of
-- the color_wheel block appended to schema.sql, isolated so you do NOT have to
-- re-run the full schema.sql. It is strictly additive/idempotent: a single
-- CREATE TABLE IF NOT EXISTS with zero UPDATEs, so it auto-applies through the
-- promote-azure guarded runner with no -AllowDestructive. Re-running is a no-op.
--
-- What it replaces: uploaded per-plant color wheels used to live only as
-- COLOR_WHEEL_DIR/color_wheel_<SAFE>.xlsx + _meta.json on the ephemeral
-- Container Apps /data volume (wiped on every restart). They now persist here.
--
-- Apply (from a host with psql + DB firewall access, e.g. the dev laptop):
--   $env:PGPASSWORD='<DB_PASSWORD>'
--   psql "host=pgdb-nimbus-dev.postgres.database.azure.com port=5432 dbname=nimbus user=TempAdmin sslmode=require" -f migrations/2026-07-07-color-wheel-table.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS color_wheel (
    plant_key   TEXT PRIMARY KEY,
    plant_label TEXT NOT NULL,
    entries     JSONB NOT NULL,
    filename    TEXT,
    row_count   INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT,
    uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
