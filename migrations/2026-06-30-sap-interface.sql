-- ============================================================================
-- Migration: SAP Interface (sap_sync) tables
-- Date: 2026-06-30  |  Ships with build 2026-06-30-b
-- ============================================================================
-- SAFE TO RUN against the live Azure Postgres. This file is a verbatim copy of
-- the SAP-interface block appended to schema.sql, isolated so you do NOT have to
-- re-run the full schema.sql (which carries the `plants` horizon ×1440 data
-- migration that re-multiplies on every run). Every statement here is strictly
-- idempotent: CREATE ... IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING, with
-- zero UPDATEs. Re-running it is a no-op.
--
-- Apply (from a host with psql + DB firewall access, e.g. the dev laptop):
--   $env:PGPASSWORD='<DB_PASSWORD>'
--   psql "host=pgdb-nimbus-dev.postgres.database.azure.com port=5432 dbname=nimbus user=TempAdmin sslmode=require" -f migrations/2026-06-30-sap-interface.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS sap_sync_config (
    object_key     TEXT PRIMARY KEY,
    enabled        BOOLEAN NOT NULL DEFAULT FALSE,
    transport      TEXT NOT NULL DEFAULT 'file_drop',
    schedule_cron  TEXT,
    source_params  JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_watermark TEXT,
    updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sap_sync_run (
    id               BIGSERIAL PRIMARY KEY,
    object_key       TEXT NOT NULL,
    started_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at         TIMESTAMP,
    status           TEXT NOT NULL DEFAULT 'running',
    rows_read        INT NOT NULL DEFAULT 0,
    rows_inserted    INT NOT NULL DEFAULT 0,
    rows_updated     INT NOT NULL DEFAULT 0,
    rows_failed      INT NOT NULL DEFAULT 0,
    error            TEXT,
    watermark_before TEXT,
    watermark_after  TEXT,
    triggered_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sap_run_object_started ON sap_sync_run(object_key, started_at DESC);

CREATE TABLE IF NOT EXISTS sap_field_map (
    object_key    TEXT NOT NULL,
    sap_field     TEXT NOT NULL,
    nimbus_column TEXT NOT NULL,
    transform     TEXT NOT NULL DEFAULT 'none',
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    field_order   INT NOT NULL DEFAULT 0,
    PRIMARY KEY (object_key, sap_field)
);
CREATE INDEX IF NOT EXISTS idx_sap_field_map_object ON sap_field_map(object_key, field_order);

-- Seed one config row per object_key (transport file_drop, disabled by default)
INSERT INTO sap_sync_config (object_key, transport) VALUES
    ('subnetworks',      'file_drop'),
    ('plants',           'file_drop'),
    ('production_lines', 'file_drop'),
    ('materials',        'file_drop'),
    ('material_plants',  'file_drop'),
    ('orders',           'file_drop')
ON CONFLICT (object_key) DO NOTHING;

-- Starter orders field-map rows
INSERT INTO sap_field_map (object_key, sap_field, nimbus_column, transform, field_order) VALUES
    ('orders', 'AUFNR', 'production_order',     'strip_zeros', 1),
    ('orders', 'MATNR', 'material_number',      'alpha',       2),
    ('orders', 'GSTRP', 'basic_start_date',     'dats',        3),
    ('orders', 'GLTRP', 'basic_finish_date',    'dats',        4),
    ('orders', 'GAMNG', 'order_quantity',       'decimal',     5)
ON CONFLICT (object_key, sap_field) DO NOTHING;
