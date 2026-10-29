-- ============================================================================
-- Migration: material description + material type on the Material Plant staging table
-- Date: 2026-10-29  |  Design of record: docs/SAP_STAGING_DESIGN.md (D30)
-- ============================================================================
-- Additive ALTER; trips the deploy runner's -AllowDestructive filter -- verified additive
-- (two nullable TEXT columns, nothing dropped, rewritten or backfilled).
-- Also seeds the two sap_field_map rows (SAP field -> NIMBUS materials column). Re-running is a no-op.
-- After deploy re-run migrations/manual/2026-10-08-nimbus-mulesoft-role.sql so the Mulesoft role
-- gets INSERT on the two new columns.
-- ============================================================================

ALTER TABLE sap_stage_material_plant ADD COLUMN IF NOT EXISTS maktx TEXT, ADD COLUMN IF NOT EXISTS mtart TEXT;

INSERT INTO sap_field_map (object_key, sap_field, nimbus_column, transform, field_order) VALUES
    ('stage_material_plants', 'MAKTX', 'material_description', 'none', 7),
    ('stage_material_plants', 'MTART', 'material_type', 'none', 8)
ON CONFLICT DO NOTHING;
