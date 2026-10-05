-- ============================================================================
-- Migration: material_plants.default_workcenter + its column_metadata row
-- Date: 2026-08-10
-- ============================================================================
-- SAFE TO RUN against the live Azure Postgres. Verbatim copy of the block
-- appended to schema.sql at the material_plants drift section, isolated so you
-- do NOT have to re-run the full schema.sql. Strictly idempotent:
-- ADD COLUMN IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING. ZERO UPDATEs.
-- Re-running is a no-op, and no schema_migrations ledger entry is needed
-- (nothing here mutates data).
--
-- Background: same drift-repair pattern as prt_01/prt_02/color
-- (migrations/2026-08-07-material-plant-attributes.sql) — this column is also
-- backed by master_data.ensure_material_plant_attributes(), an idempotent
-- bootstrap called from brain.py's FastAPI lifespan hook on every app boot,
-- so a running app will self-heal this column even without this file being
-- applied by hand; this migration exists so it can be applied ahead of an app
-- restart, or to a DB nothing is currently booting against.
--
-- NOTE: this migration contains ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
-- which is purely additive but WILL trip apply-migrations.ps1's blind
-- destructive-verb keyword match on "ALTER". Confirm via -DryRun that this
-- file contains only ADD COLUMN IF NOT EXISTS / INSERT ... ON CONFLICT DO
-- NOTHING, then apply with -AllowDestructive.
--
-- Apply (from a host with psql + DB firewall access, e.g. the dev laptop):
--   $env:PGPASSWORD='<DB_PASSWORD>'
--   & ".claude\skills\promote-azure\scripts\apply-migrations.ps1" -DryRun
--   & ".claude\skills\promote-azure\scripts\apply-migrations.ps1" -AllowDestructive
--   Remove-Item Env:\PGPASSWORD
-- ============================================================================

ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS default_workcenter TEXT;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('material_plants', 'default_workcenter', 'Default Workcenter', FALSE, 11)
ON CONFLICT (table_name, column_name) DO NOTHING;
