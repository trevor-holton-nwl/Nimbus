-- ============================================================================
-- Migration: SAP staging columns (apply mode, missing-since markers)
-- Date: 2026-10-08  |  Design of record: docs/SAP_STAGING_DESIGN.md
-- ============================================================================
-- Additive ALTERs; trips the deploy runner's -AllowDestructive filter -- verified additive.
-- Every statement is ADD COLUMN IF NOT EXISTS (nullable or defaulted) plus one
-- guarded CHECK constraint; nothing is dropped, rewritten or backfilled.
-- Run after 2026-10-08-sap-staging-tables.sql (sap_sync_config already exists
-- from 2026-06-30-sap-interface.sql). Re-running is a no-op.
-- ============================================================================

ALTER TABLE sap_sync_config ADD COLUMN IF NOT EXISTS apply_mode TEXT NOT NULL DEFAULT 'manual';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sap_sync_config_apply_mode') THEN
    ALTER TABLE sap_sync_config ADD CONSTRAINT chk_sap_sync_config_apply_mode
      CHECK (apply_mode IN ('manual','auto'));
  END IF;
END $$;

ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS sap_missing_since TIMESTAMPTZ;
ALTER TABLE production_version ADD COLUMN IF NOT EXISTS sap_missing_since TIMESTAMPTZ;
