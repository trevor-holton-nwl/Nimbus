-- ============================================================================
-- Migration: priority_list table, orders.{prt_01,prt_02,production_version},
--            color_wheel -> priority_list migration, orders attribute backfill
-- Date: 2026-08-11
-- Stage 1 of docs/scheduling_priority.md ("data plumbing" — no UI, no
-- optimizer change yet). Verbatim copy of the block appended to schema.sql.
-- ============================================================================
-- NOT purely additive. The CREATE TABLE / ADD COLUMN statements are idempotent
-- and safe to re-run at any time. The two DO blocks below are DATA-MUTATING
-- one-time steps guarded by the schema_migrations ledger (schema.sql:20) —
-- each runs at most once per database, recording itself in schema_migrations
-- so a second apply is a no-op.
--
-- Both guarded steps write orders.* columns, and ANY UPDATE to `orders` bumps
-- every touched row's xmin — which IS the optimistic-concurrency base_version
-- surfaced as ROW_VERSION (db.py:215). A bumped xmin makes the next
-- POST /tasks/update for that row come back in the `stale` list, and the
-- frontend reconciles by LAST-WRITER-LOSES: a planner's unsaved drag on an
-- affected order is silently discarded. Apply this migration at deploy time,
-- with no planner actively working the affected plant(s) — never mid-shift.
--
-- orders_mp_attrs_backfill is CONVENIENCE ONLY, not the mechanism (R3 in
-- docs/scheduling_priority.md). If it runs before material_plants is
-- populated for a plant, it finds no matches, does nothing useful, and still
-- records itself applied — it will NEVER run again for that plant, even
-- after material_plants is filled in later (the inverse of the historical
-- plants-horizon x1440 ledger trap: that one re-ran forever and corrupted
-- data; this one can permanently no-op instead). The real mechanism is
-- POST /master-data/resync-order-attributes, which re-stamps a plant on
-- demand with no ledger gate. Run it after this migration for any plant
-- whose material_plants rows were populated later than this migration ran.
--
-- NOTE: this migration contains ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
-- which is purely additive but WILL trip apply-migrations.ps1's blind
-- destructive-verb keyword match on "ALTER". Confirm via -DryRun, then apply
-- with -AllowDestructive — same as the two existing material_plants
-- migrations.
--
-- Apply to local Postgres directly:
--   & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -d nimbus -f migrations\2026-08-11-priority-lists.sql
--
-- Apply to Azure (from a host with psql + DB firewall access):
--   $env:PGPASSWORD='<DB_PASSWORD>'
--   & ".claude\skills\promote-azure\scripts\apply-migrations.ps1" -DryRun
--   & ".claude\skills\promote-azure\scripts\apply-migrations.ps1" -AllowDestructive
--   Remove-Item Env:\PGPASSWORD
-- ============================================================================

-- ----------------------------------------------------------------------------
-- priority_list: one row per (plant, line-scope, rankable field). Generalizes
-- color_wheel to any field in master_data.RANKABLE_FIELDS. line = '' means
-- plant-wide; a specific production_line value overrides the plant-wide list
-- for that line only (mirrors line_calendar / line_blackout's line: null
-- convention). entries is {NORMALIZED_VALUE: RANK}, same shape color_wheel
-- already uses for {COLOR: ORDER_Y}.
--
-- No FK to plants/production_lines — like color_wheel, a list may exist for
-- an order-derived plant/line that lags master data. value_column/rank_column
-- are upload provenance only (which uploaded headers were mapped); they are
-- never re-parsed from — master_data.RANKABLE_FIELDS is the sole source of
-- truth for a field's DB source column (N19 in docs/scheduling_priority.md).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS priority_list (
    plant         TEXT NOT NULL,
    line          TEXT NOT NULL DEFAULT '',
    field_key     TEXT NOT NULL,
    entries       JSONB NOT NULL,
    source_column TEXT NOT NULL,
    value_column  TEXT,
    rank_column   TEXT,
    filename      TEXT,
    row_count     INTEGER NOT NULL DEFAULT 0,
    uploaded_by   TEXT,
    uploaded_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plant, line, field_key)
);

-- ----------------------------------------------------------------------------
-- orders.{prt_01,prt_02,production_version} — materialized copies of the
-- matching material_plants planner attributes (seam 2:
-- db._stamp_order_attributes), read directly by db._ORDERS_SELECT with no
-- JOIN on the hot /tasks path. orders.color already exists (added long before
-- this feature); Stage 1 changes what populates it, not its column
-- definition. production_version sources from material_plants.
-- default_production_version (schema.sql, the material_plants base table) —
-- NOT material_plants.default_workcenter, which stays a plain admin-editable
-- material_plants column and is deliberately not part of this feature.
-- production_version is also the eventual PRT_02 join anchor once PRT_02
-- moves from a single TEXT value to a production-version-keyed table (see
-- docs/scheduling_priority.md's "PRT_02" decision) — materializing it now
-- costs nothing and the column name already exists as a dead entry in
-- web/order-field-catalog.mjs, so this is fixing pre-existing drift, not
-- adding new.
-- ----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS prt_01             TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS prt_02             TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS production_version TEXT;

-- ----------------------------------------------------------------------------
-- One-time: copy every existing color_wheel row into priority_list as a
-- plant-wide (line = '') 'colorWheel' entry. Keyed on plant_label (the raw
-- plant name as typed), NOT plant_key (a _cw_safe_name() slug) — priority_list
-- is keyed by raw plant name throughout. color_wheel itself is left in place,
-- unread from here on except by the legacy-compat /color-wheel/* endpoints,
-- which are repointed at priority_list in brain.py (Task 4).
-- ----------------------------------------------------------------------------
DO $mig$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'priority_list_from_color_wheel') THEN
        INSERT INTO priority_list
            (plant, line, field_key, entries, source_column, value_column, rank_column,
             filename, row_count, uploaded_by, uploaded_at, updated_at)
        SELECT plant_label, '', 'colorWheel', entries, 'color', NULL, NULL,
               filename, row_count, uploaded_by, uploaded_at, updated_at
          FROM color_wheel
        ON CONFLICT (plant, line, field_key) DO NOTHING;

        INSERT INTO schema_migrations (id) VALUES ('priority_list_from_color_wheel');
    END IF;
END
$mig$;

-- ----------------------------------------------------------------------------
-- One-time CONVENIENCE backfill (see the file header — this is not the
-- mechanism, POST /master-data/resync-order-attributes is). Copies
-- color/prt_01/prt_02/default_production_version from material_plants onto
-- every matching order (the last one landing as orders.production_version —
-- see the column note above), keyed (plant, material_number = material_id).
-- Unmatched orders (no material_plants row at that plant) are left exactly
-- as they were — this statement only touches rows that join successfully.
-- ----------------------------------------------------------------------------
DO $mig$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'orders_mp_attrs_backfill') THEN
        UPDATE orders o
           SET color              = mp.color,
               prt_01             = mp.prt_01,
               prt_02             = mp.prt_02,
               production_version = mp.default_production_version,
               updated_at         = NOW()
          FROM material_plants mp
         WHERE mp.plant = o.plant
           AND mp.material_id = o.material_number
           AND o.plant IS NOT NULL;

        INSERT INTO schema_migrations (id) VALUES ('orders_mp_attrs_backfill');
    END IF;
END
$mig$;
