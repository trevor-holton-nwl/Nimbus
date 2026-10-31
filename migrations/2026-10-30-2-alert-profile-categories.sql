-- ============================================================================
-- Migration: alert_profile.categories (per-group on/off + colour for Alert Profiles)
-- Date: 2026-10-30  |  Design of record: docs/superpowers/specs/2026-10-30-alert-profiles-revamp-design.md (W3)
-- ============================================================================
-- Additive ALTER; trips the deploy runner's -AllowDestructive filter -- verified additive
-- (one nullable JSONB column plus a CHECK that NULL satisfies; nothing dropped, rewritten or backfilled).
-- NULL = a legacy profile whose groups are derived from its rules. Re-running is a no-op.
-- Rollback hazard: rows saved with `rules: []` match nothing on the previous image.
-- ============================================================================

ALTER TABLE alert_profile ADD COLUMN IF NOT EXISTS categories JSONB NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_alert_profile_categories'
  ) THEN
    ALTER TABLE alert_profile
      ADD CONSTRAINT chk_alert_profile_categories
      CHECK (categories IS NULL OR jsonb_typeof(categories) = 'object');
  END IF;
END $$;
