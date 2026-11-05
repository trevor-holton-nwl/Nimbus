-- ============================================================================
-- Migration: base unit of measure on the Material Plant staging table
-- Date: 2026-11-04  |  Design of record: docs/SAP_STAGING_DESIGN.md (D30)
-- ============================================================================
-- Additive ALTER; may trip the deploy runner's -AllowDestructive filter -- verified additive
-- (one nullable TEXT column, nothing dropped, rewritten or backfilled).
-- Also seeds the sap_field_map row (SAP field -> materials.base_uom). Re-running is a no-op.
-- After deploy re-run migrations/manual/2026-10-08-nimbus-mulesoft-role.sql so the Mulesoft role
-- gets INSERT on the new column.
-- ============================================================================

ALTER TABLE sap_stage_material_plant ADD COLUMN IF NOT EXISTS meins TEXT;

INSERT INTO sap_field_map (object_key, sap_field, nimbus_column, transform, field_order) VALUES
    ('stage_material_plants', 'MEINS', 'base_uom', 'none', 9)
ON CONFLICT DO NOTHING;
