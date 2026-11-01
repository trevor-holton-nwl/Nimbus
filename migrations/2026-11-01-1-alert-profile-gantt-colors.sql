-- ============================================================================
-- Migration: alert_profile.gantt_colors (per-profile "Colour the Gantt" setting)
-- Date: 2026-11-01  |  Design of record: C:\Users\PJ29587\.claude\plans\rosy-puzzling-naur.md (Gantt follows the active alert profile)
-- ============================================================================
-- Additive ALTER; trips the deploy runner's -AllowDestructive filter -- verified additive
-- (one BOOLEAN column with a constant default; nothing dropped, rewritten or backfilled beyond the default).
-- TRUE = the profile fills its matched bars on the Gantt and minimap (the pre-existing behaviour). Re-running is a no-op.
-- Rollback: the previous image ignores the column.
-- ============================================================================

ALTER TABLE alert_profile ADD COLUMN IF NOT EXISTS gantt_colors BOOLEAN NOT NULL DEFAULT TRUE;
