-- ============================================================================
-- Migration: alert_profile.show_acknowledged (per-profile "Include acknowledged alerts" setting)
-- Date: 2026-11-01  |  Owner decision 2026-11-01 (acknowledgement visibility moves from a per-user pref onto the profile)
-- ============================================================================
-- Additive ALTER; trips the deploy runner's -AllowDestructive filter -- verified additive
-- (one BOOLEAN column with a constant default; nothing dropped, rewritten or backfilled beyond the default).
-- FALSE = acknowledged alerts stay hidden (the pre-existing default). TRUE = the profile lists and counts them. Re-running is a no-op.
-- Rollback: the previous image ignores the column.
-- ============================================================================

ALTER TABLE alert_profile ADD COLUMN IF NOT EXISTS show_acknowledged BOOLEAN NOT NULL DEFAULT FALSE;
