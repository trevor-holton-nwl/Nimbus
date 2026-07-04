-- ============================================================================
-- Migration: production_lines optimizer-flag columns (bottleneck, excl_optimizer,
--            buffer_type, buffer_percent, buffer_hours) + their column_metadata rows
-- Date: 2026-07-03
-- ============================================================================
-- SAFE TO RUN against the live Azure Postgres. This file is a verbatim copy of
-- the block appended to schema.sql, isolated so you do NOT have to re-run the
-- full schema.sql (which carries the `plants` horizon ×1440 data migration
-- that re-multiplies on every run). Every statement here is strictly
-- idempotent: ADD COLUMN IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING,
-- with zero UPDATEs. Re-running it is a no-op.
--
-- Background: these 5 columns were added to local `production_lines` via the
-- Admin -> Manage Data Tables "Add Column" DDL wizard at some point, but never
-- backfilled into schema.sql (unlike `pl_group`, which got the same treatment
-- earlier). Because `master_data.list_rows` INNER JOINs column_metadata against
-- information_schema.columns, a column that's missing its column_metadata row
-- is invisible to GET /master-data/production_lines even if the physical
-- column exists -- so the ProdLines "Bottleneck"/"Excl. Optimizer" checkboxes
-- silently reset to unchecked on every master-data reload. This migration
-- brings Azure up to a fully-correct state (columns + metadata together).
--
-- NOTE: this migration contains ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
-- which is purely additive (no existing column touched, nothing dropped/
-- renamed/retyped) but WILL trip apply-migrations.ps1's blind destructive-verb
-- keyword match on "ALTER". Confirm via -DryRun that this file contains only
-- ADD COLUMN IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING, then apply
-- with -AllowDestructive.
--
-- Apply (from a host with psql + DB firewall access, e.g. the dev laptop):
--   $env:PGPASSWORD='<DB_PASSWORD>'
--   & ".claude\skills\promote-azure\scripts\apply-migrations.ps1" -DryRun
--   & ".claude\skills\promote-azure\scripts\apply-migrations.ps1" -AllowDestructive
--   Remove-Item Env:\PGPASSWORD
-- ============================================================================

ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS bottleneck      TEXT;
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS excl_optimizer  TEXT;
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS buffer_type     TEXT;
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS buffer_percent  NUMERIC;
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS buffer_hours    NUMERIC;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('production_lines', 'bottleneck',     'Bottleneck',             FALSE, 5),
    ('production_lines', 'excl_optimizer', 'Exclude from Optimizer', FALSE, 6),
    ('production_lines', 'buffer_type',    'Buffer Type',            FALSE, 7),
    ('production_lines', 'buffer_percent', 'Buffer %',               FALSE, 8),
    ('production_lines', 'buffer_hours',   'Buffer Hours',           FALSE, 9)
ON CONFLICT (table_name, column_name) DO NOTHING;
