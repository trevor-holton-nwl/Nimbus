-- Effective-dated plant calendar periods (additive only).
-- Creates one table and one index and nothing else. The foreign-key cascade clause below
-- matches the promote tool's destructive-word filter, so apply with
-- `-Only 2026-10-16-3 -AllowDestructive` after confirming this file creates one table and
-- one index and nothing else.

CREATE TABLE IF NOT EXISTS plant_calendar_period (
    subnetwork  TEXT      NOT NULL,
    plant       TEXT      NOT NULL,
    period_id   TEXT      NOT NULL,
    name        TEXT      NOT NULL DEFAULT '',
    valid_from  DATE      NOT NULL,
    valid_to    DATE,
    work_hours  JSONB     NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, period_id),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT chk_plant_calendar_period_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
    CONSTRAINT chk_plant_calendar_period_hours CHECK (jsonb_typeof(work_hours) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_plant_calendar_period_plant ON plant_calendar_period(plant, valid_from);
