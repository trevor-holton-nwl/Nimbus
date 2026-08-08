-- ============================================================================
-- Migration: material_plants planner attributes (prt_01, prt_02, color) +
--            their column_metadata rows + plant-leading grid index
-- Date: 2026-08-07
-- ============================================================================
-- SAFE TO RUN against the live Azure Postgres. Verbatim copy of the block
-- appended to schema.sql at the material_plants drift section, isolated so you
-- do NOT have to re-run the full schema.sql. Strictly idempotent:
-- ADD COLUMN IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING +
-- CREATE INDEX IF NOT EXISTS. ZERO UPDATEs. Re-running is a no-op, and no
-- schema_migrations ledger entry is needed (nothing here mutates data).
--
-- Background: prt_01/prt_02/color were added to LIVE Azure via the Admin ->
-- Manage Data Tables "Add Column" wizard and never reached git. On Azure the
-- three ALTERs are already-satisfied no-ops and the INSERT is a no-op; the only
-- statement that actually does work there is the new index. On a fresh/local DB
-- all five statements matter.
--
-- NOTE: this migration contains ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
-- which is purely additive but WILL trip apply-migrations.ps1's blind
-- destructive-verb keyword match on "ALTER". Confirm via -DryRun that this
-- file contains only ADD COLUMN IF NOT EXISTS / INSERT ... ON CONFLICT DO
-- NOTHING / CREATE INDEX IF NOT EXISTS, then apply with -AllowDestructive.
--
-- Apply (from a host with psql + DB firewall access, e.g. the dev laptop):
--   $env:PGPASSWORD='<DB_PASSWORD>'
--   & ".claude\skills\promote-azure\scripts\apply-migrations.ps1" -DryRun
--   & ".claude\skills\promote-azure\scripts\apply-migrations.ps1" -AllowDestructive
--   Remove-Item Env:\PGPASSWORD
-- ============================================================================

ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS prt_01 TEXT;
ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS prt_02 TEXT;
ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS color  TEXT;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('material_plants', 'prt_01', 'Prod. Resource Tool (01)', FALSE,  8),
    ('material_plants', 'prt_02', 'Prod. Resource Tool (02)', FALSE,  9),
    ('material_plants', 'color',  'Color',                    FALSE, 10)
ON CONFLICT (table_name, column_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_material_plants_plant_material
    ON material_plants(plant, material_id);
