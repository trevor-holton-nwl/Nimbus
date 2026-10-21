-- ============================================================================
-- Migration: alert_profile + alert_ack (Alert Monitor: per-plant shared alert
--            profiles and alert acknowledgements)
-- Date: 2026-10-20
-- Purely additive and idempotent: new tables and one index only; no existing
-- data is touched. Mirrors the block appended to schema.sql and
-- backend/alert_profiles/data.py::ensure_alert_profile_tables().
-- ============================================================================

CREATE TABLE IF NOT EXISTS alert_profile (
    id TEXT PRIMARY KEY, plant TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    ranking TEXT NOT NULL DEFAULT 'impact' CHECK (ranking IN ('impact','time','severity','orders')),
    created_by TEXT, updated_by TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_alert_profile_rules CHECK (jsonb_typeof(rules) = 'array'),
    CONSTRAINT uq_alert_profile_plant_name UNIQUE (plant, name));
CREATE INDEX IF NOT EXISTS idx_alert_profile_plant ON alert_profile(plant, name);

CREATE TABLE IF NOT EXISTS alert_ack (
    plant TEXT NOT NULL, alert_id TEXT NOT NULL, acknowledged_by TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', until TIMESTAMP NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plant, alert_id));
