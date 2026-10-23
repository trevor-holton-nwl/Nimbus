-- ============================================================================
-- Migration: schedule_event (per-order change history, append-only)
-- Date: 2026-10-23
-- Purely additive and idempotent: one new table and two indexes only; no
-- existing data is touched. Mirrors the block appended to schema.sql and
-- backend/schedule_events/data.py::ensure_schedule_event_table().
-- Rows are written in the same transaction as every planner-visible order
-- write and trimmed by a nightly batched sweep (default 14 days).
-- ============================================================================

CREATE TABLE IF NOT EXISTS schedule_event (
    id               BIGSERIAL PRIMARY KEY,
    plant            TEXT NOT NULL,
    order_id         TEXT NOT NULL,          -- orders.id (MD5 of production_order|material); no FK on purpose
    production_order TEXT,
    material_number  TEXT,
    action_id        UUID NOT NULL,          -- one per save / ingest batch / optimizer run / sweep action
    source           TEXT NOT NULL,          -- drag|keyboard|grid|inspector|alert_fix|optimizer|undo|planner|note|
                                             -- distribution|sap_ingest|excel_upload|sap_reset|routing_hold|
                                             -- routing_recompute|purge|sap_vanish|restore|admin|master_data_stamp|unknown
    actor            TEXT,
    client_id        TEXT,                   -- reserved for the future change feed
    op               TEXT NOT NULL CHECK (op IN ('create','modify','remove')),
    changes          JSONB NOT NULL,         -- {"field": [before, after]} - only changed tracked fields
    at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
) WITH (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 10000,
        autovacuum_analyze_scale_factor = 0.05);
CREATE INDEX IF NOT EXISTS idx_schedule_event_order ON schedule_event (plant, order_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_event_at    ON schedule_event (at);
