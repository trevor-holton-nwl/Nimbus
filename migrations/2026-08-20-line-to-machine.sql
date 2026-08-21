-- ============================================================================
-- Migration: Line -> Machine domain rename (Azure cutover — HAND-APPLIED ONCE)
-- Date: 2026-08-20
-- ============================================================================
-- WHAT THIS IS
-- ------------
-- NIMBUS's "Production Line" domain concept has been renamed to "Machine"
-- throughout the application code and the LOCAL dev schema (schema.sql).
-- The local Postgres DB was rebuilt from scratch against the rewritten
-- schema.sql, so locally there was nothing to migrate in place.
--
-- The live Azure pilot database (rg-nimbus-dev) was NOT touched by that
-- rebuild and still has real data under the OLD table/column names
-- (production_lines, line_calendar, line_blackout, labor_plan_line,
-- line_setup_state, orders.production_line, etc.). This file is the
-- hand-applied, one-time DDL + data-repoint script that renames Azure's
-- existing objects and data IN PLACE (never drop/recreate — Azure's rows
-- must be preserved) so the live schema matches current schema.sql exactly.
--
-- HOW THIS FILE IS DIFFERENT FROM EVERYTHING ELSE IN migrations/
-- ----------------------------------------------------------------------------
-- Every other file in this directory is, per CLAUDE.md, "dated, additive,
-- idempotent" — safe to re-run, and applied automatically by the
-- `promote-azure` skill's migration-ledger flow (apply-migrations.ps1).
--
-- THIS FILE IS THE DELIBERATE EXCEPTION:
--   * It is a PLAIN, NON-IDEMPOTENT script. Re-running it will error (e.g.
--     "table production_lines does not exist", "column line does not
--     exist") because the RENAMEs it performs are not repeatable — by
--     design, since the whole point is a one-way cutover.
--   * It must be applied BY HAND, EXACTLY ONCE, at a deliberate cutover
--     moment — NOT via the `promote-azure` skill and NOT via
--     apply-migrations.ps1's automated ledger sweep. Do not wire it into
--     that tooling.
--   * It must NOT be recorded in the `schema_migrations` table. That ledger
--     exists to guard one-time DATA-MUTATING steps that are otherwise
--     embedded in the idempotent schema.sql (see schema.sql's
--     `schema_migrations` header comment and docs/MIGRATION.md's "Schema
--     migration ledger" section) — a different category of migration than
--     this one-shot, hand-run cutover rename. Adding a ledger row here would
--     be meaningless (nothing ever checks it) and could confuse a future
--     reader into thinking this file participates in that guarded-repeat
--     mechanism.
--   * Run it with no planner actively working the plant(s) in question —
--     it renames orders.production_line/orders.line_key, and while column
--     renames do not themselves bump `xmin`/ROW_VERSION the way an UPDATE
--     would, this is still a schema change best made during a maintenance
--     window, not mid-shift.
--
-- ORDERING
-- --------
-- Table renames happen first, then column renames (referencing tables by
-- their NEW names throughout, for internal consistency), then the four
-- GENERATED machine_key columns are rebuilt (they must come after their
-- table's own machine column has already been renamed from
-- production_line, since the generated expression references it), then the
-- new workcenter_mapping table, then data-only repoints of column_metadata
-- and the SAP interface tables.
--
-- TRANSACTION SAFETY
-- -------------------
-- Every statement below is ordinary transactional DDL/DML (ALTER TABLE
-- RENAME, ALTER TABLE ADD/DROP COLUMN, CREATE INDEX, DROP INDEX, CREATE
-- TABLE, UPDATE, INSERT) — none of it is a CONCURRENTLY operation or other
-- construct Postgres forbids inside a transaction block. The whole file is
-- wrapped in a single BEGIN/COMMIT so it applies atomically: either the
-- entire cutover lands, or (on any error) the whole thing rolls back and
-- Azure is left exactly as it was pre-cutover.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. RENAME TABLES
-- ----------------------------------------------------------------------------
ALTER TABLE production_lines  RENAME TO machine;
ALTER TABLE line_calendar     RENAME TO machine_calendar;
ALTER TABLE line_blackout     RENAME TO machine_blackout;
ALTER TABLE labor_plan_line   RENAME TO labor_plan_machine;
ALTER TABLE line_setup_state  RENAME TO machine_setup_state;

-- ----------------------------------------------------------------------------
-- 2. RENAME COLUMNS
--    Tables are referenced by their NEW (just-renamed) names above; Postgres
--    resolves table renames immediately within the same transaction, so this
--    is safe. Column PKs/FKs/CHECKs/plain indexes that reference a renamed
--    column are automatically repointed by Postgres to the new column name
--    and KEEP THEIR EXISTING NAMES (e.g. idx_orders_line stays named
--    idx_orders_line even though it now indexes orders.machine) — this file
--    does not rename those purely-cosmetic index/constraint names to match
--    current schema.sql, only the table/column names that the application
--    and schema.sql's CREATE statements actually reference by name. The one
--    exception (generated machine_key identity columns) is handled
--    separately in section 3 below, because those columns cannot survive a
--    plain RENAME COLUMN.
-- ----------------------------------------------------------------------------
ALTER TABLE machine               RENAME COLUMN production_line TO machine;
ALTER TABLE machine               RENAME COLUMN pl_group        TO wc_group;

ALTER TABLE machine_calendar      RENAME COLUMN production_line TO machine;

ALTER TABLE machine_blackout      RENAME COLUMN production_line TO machine;

ALTER TABLE labor_plan_machine    RENAME COLUMN production_line TO machine;

ALTER TABLE labor_plan            RENAME COLUMN pl_group        TO wc_group;

ALTER TABLE machine_setup_state   RENAME COLUMN line TO machine;

ALTER TABLE orders                RENAME COLUMN production_line TO machine;
ALTER TABLE orders                RENAME COLUMN line_key        TO machine_key;

ALTER TABLE priority_list         RENAME COLUMN line TO machine;

ALTER TABLE setup_matrix          RENAME COLUMN line TO machine;

ALTER TABLE setup_occurrence_override RENAME COLUMN line TO machine;

ALTER TABLE material_plants       RENAME COLUMN default_workcenter TO default_machine;

-- ----------------------------------------------------------------------------
-- 3. REBUILD THE 4 GENERATED machine_key IDENTITY COLUMNS
--
--    A GENERATED ALWAYS AS (...) STORED column's expression is baked in at
--    creation time and cannot be retargeted by RENAME COLUMN alone (the old
--    line_key columns' expressions still literally say `... || production_line`
--    / `... || line` against columns that themselves no longer exist under
--    those names after section 2, and Postgres has no "ALTER COLUMN ...
--    generation expression" facility). Each of the 4 affected tables is
--    therefore handled as: drop the dependent index (defensive — DROP COLUMN
--    would cascade-drop a plain index automatically, but we do this
--    explicitly per the standing convention in schema.sql's own line_key ->
--    machine_key blocks), drop the generated column, re-add it generated
--    against the now-renamed `machine` column, then recreate the index under
--    its schema.sql-current name and uniqueness.
--
--    Uniqueness is NOT uniform across these four — matched exactly to what
--    schema.sql has today:
--      machine            -> UNIQUE  (uq_machine_machine_key)
--      machine_calendar   -> UNIQUE  (uq_machine_calendar_machine_key) —
--                             note this WIDENS the constraint: the
--                             pre-cutover Azure index (idx_line_calendar_line_key)
--                             was plain/non-unique. Safe: machine_key is
--                             functionally derived from this table's own
--                             (subnetwork, plant, machine) primary key, so a
--                             duplicate machine_key value is already
--                             impossible.
--      machine_blackout   -> plain, non-unique (idx_machine_blackout_machine_key)
--                             — machine is nullable here (NULL = plant-wide
--                             block) and multiple blackout rows legitimately
--                             share one machine or share machine IS NULL.
--      labor_plan_machine -> plain, non-unique (idx_lpl_machine_key)
-- ----------------------------------------------------------------------------

-- machine (was production_lines)
DROP INDEX IF EXISTS uq_lines_line_key;
ALTER TABLE machine DROP COLUMN line_key;
ALTER TABLE machine ADD COLUMN machine_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED;
CREATE UNIQUE INDEX uq_machine_machine_key ON machine(machine_key);

-- machine_calendar (was line_calendar)
DROP INDEX IF EXISTS idx_line_calendar_line_key;
ALTER TABLE machine_calendar DROP COLUMN line_key;
ALTER TABLE machine_calendar ADD COLUMN machine_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED;
CREATE UNIQUE INDEX uq_machine_calendar_machine_key ON machine_calendar(machine_key);

-- machine_blackout (was line_blackout)
DROP INDEX IF EXISTS idx_line_blackout_line_key;
ALTER TABLE machine_blackout DROP COLUMN line_key;
ALTER TABLE machine_blackout ADD COLUMN machine_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED;
CREATE INDEX idx_machine_blackout_machine_key ON machine_blackout(machine_key);

-- labor_plan_machine (was labor_plan_line)
DROP INDEX IF EXISTS idx_lpl_line_key;
ALTER TABLE labor_plan_machine DROP COLUMN line_key;
ALTER TABLE labor_plan_machine ADD COLUMN machine_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED;
CREATE INDEX idx_lpl_machine_key ON labor_plan_machine(machine_key);

-- Note: orders.machine_key (renamed in section 2 above) is NOT part of this
-- section — it is a plain backfilled TEXT column, not GENERATED, so a
-- straight RENAME COLUMN was sufficient for it.

-- ----------------------------------------------------------------------------
-- 4. NEW TABLE: workcenter_mapping
--    Brand-new on Azure — mirrors schema.sql's current definition verbatim.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workcenter_mapping (
    plant           TEXT NOT NULL,
    machine         TEXT NOT NULL,
    sap_workcenter  TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, machine)
);

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('workcenter_mapping', 'plant',          'Plant',            TRUE,  1),
    ('workcenter_mapping', 'machine',        'Machine',          TRUE,  2),
    ('workcenter_mapping', 'sap_workcenter', 'SAP Workcenter',   FALSE, 3)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 5. column_metadata — repoint DATA rows that named the old table/column
--    (schema, i.e. the table/column identifiers themselves, was already
--    handled by sections 1-3; this is the admin-editable-grid metadata that
--    describes those columns to the Master Data UI and must keep pointing at
--    a table_name/column_name pair that actually exists post-rename).
--
--    Every row updated below has a verified counterpart in schema.sql's
--    current (post-rename) column_metadata seed INSERTs — see the file
--    header of the surrounding docs for provenance; each UPDATE's WHERE
--    clause names the exact old (table_name, column_name) pair schema.sql
--    used before this rename (confirmed via `git diff HEAD -- schema.sql`,
--    since the rename in this repo is still uncommitted working-tree state).
-- ----------------------------------------------------------------------------

-- machine's own identity columns (subnetwork/plant unchanged; production_line
-- both renames and relabels to machine/'Machine').
UPDATE column_metadata
   SET table_name = 'machine'
 WHERE table_name = 'production_lines' AND column_name = 'subnetwork';

UPDATE column_metadata
   SET table_name = 'machine'
 WHERE table_name = 'production_lines' AND column_name = 'plant';

UPDATE column_metadata
   SET table_name = 'machine', column_name = 'machine', display_label = 'Machine'
 WHERE table_name = 'production_lines' AND column_name = 'production_line';

-- Workcenter Group (was Production Line Group / pl_group)
UPDATE column_metadata
   SET table_name = 'machine', column_name = 'wc_group', display_label = 'Workcenter Group'
 WHERE table_name = 'production_lines' AND column_name = 'pl_group';

-- Optimizer-flag columns: table_name only, names/labels unchanged.
UPDATE column_metadata
   SET table_name = 'machine'
 WHERE table_name = 'production_lines'
   AND column_name IN ('bottleneck', 'excl_optimizer', 'buffer_type', 'buffer_percent', 'buffer_hours');

-- material_plants.default_workcenter -> default_machine
UPDATE column_metadata
   SET column_name = 'default_machine', display_label = 'Default Machine'
 WHERE table_name = 'material_plants' AND column_name = 'default_workcenter';

-- ----------------------------------------------------------------------------
-- 6. SAP interface tables — repoint DATA VALUES that reference old
--    table/column names as strings (sap_sync_config.object_key,
--    sap_field_map.object_key, sap_field_map.nimbus_column). These are
--    schema-agnostic config rows sap_sync.py reads by string key
--    (SAP_OBJECTS / _MASTER_KEY_COLUMNS in sap_sync.py), so nothing here
--    fails if a given row doesn't exist on Azure — every statement is a safe
--    no-op WHERE clause in that case.
-- ----------------------------------------------------------------------------
UPDATE sap_sync_config
   SET object_key = 'machine'
 WHERE object_key = 'production_lines';

UPDATE sap_field_map
   SET object_key = 'machine'
 WHERE object_key = 'production_lines';

UPDATE sap_field_map
   SET nimbus_column = 'machine'
 WHERE nimbus_column = 'production_line';

UPDATE sap_field_map
   SET nimbus_column = 'wc_group'
 WHERE nimbus_column = 'pl_group';

UPDATE sap_field_map
   SET nimbus_column = 'default_machine'
 WHERE nimbus_column = 'default_workcenter';

UPDATE sap_field_map
   SET nimbus_column = 'machine_key'
 WHERE nimbus_column = 'line_key';

COMMIT;

-- ============================================================================
-- Deliberately NOT done here (see header): no schema_migrations ledger row is
-- inserted for this file — that ledger is reserved for one-time data-mutating
-- steps embedded in the idempotent schema.sql, a different mechanism than
-- this hand-applied, non-repeatable cutover script.
-- ============================================================================
