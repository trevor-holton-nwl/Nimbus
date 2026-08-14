-- ============================================================================
-- NIMBUS 2.0 — Postgres schema
-- Run once against the local DB:
--     psql -U postgres -c "CREATE DATABASE nimbus;"
--     psql -U postgres -d nimbus -f schema.sql
--
-- Same file is intended to apply against Azure Postgres later (no PG-only
-- syntax used beyond JSONB + UUID + ON CONFLICT, all of which Azure supports).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- schema_migrations: ledger of one-time, DATA-MUTATING migrations so that
-- re-applying schema.sql never re-runs them. schema.sql must otherwise stay
-- pure idempotent DDL (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
-- INSERT ... ON CONFLICT DO NOTHING). Any statement that MUTATES existing row
-- data must be recorded here and guarded, mirroring the promote-azure
-- migration-ledger model. See the plants horizon note below for why an
-- unguarded data mutation in this file is dangerous.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- orders: SAP-source columns + user-scheduling overrides
--
-- The columns prefixed `basic_*` are owned by the SAP export and overwritten
-- on every upload.  The `scheduled_*` columns are owned by the user (drag-
-- drop / override) and are deliberately untouched by the upsert.  brain.py
-- serves COALESCE(scheduled_start, basic_start_date) so existing app code
-- only ever sees a single start/end per order.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id                    TEXT PRIMARY KEY,         -- MD5(production_order|material_number) from make_id()
    production_order      TEXT NOT NULL,
    material_number       TEXT NOT NULL,
    material_description  TEXT,
    production_line       TEXT,
    -- SAP-source dates
    basic_start_date      TIMESTAMP,
    basic_finish_date     TIMESTAMP,
    -- User scheduling overrides (NULL until first manual edit)
    scheduled_start       TIMESTAMP,
    scheduled_end         TIMESTAMP,
    run_time              NUMERIC,
    -- Set only when an authoritative source RUN_TIME changes after a NIMBUS
    -- schedule exists. The browser clears it by persisting a regenerated
    -- complete parent aggregate; source dates alone never rewrite that plan.
    runtime_schedule_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
    color                 TEXT,
    order_quantity        NUMERIC,
    form_size             TEXT,
    notes                 TEXT,                -- user annotations; max 500 chars enforced at app layer
    firming_indicator     TEXT,                -- SAP firming indicator (FIXKZ); read by query_orders + written by ingest upsert
    upload_batch_id       UUID,
    uploaded_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_basic_start  ON orders(basic_start_date);
CREATE INDEX IF NOT EXISTS idx_orders_upload_batch ON orders(upload_batch_id);
CREATE INDEX IF NOT EXISTS idx_orders_line         ON orders(production_line);
-- Serves the stateless /tasks read path: per-line scan ordered by start date
-- (db.query_orders ORDER BY production_line, effective start). Supersedes
-- relying on the two single-column indexes above for that access pattern.
CREATE INDEX IF NOT EXISTS idx_orders_line_start   ON orders(production_line, basic_start_date);
-- Matches db.query_orders() ORDER BY exactly: per-line scan ordered by effective start.
-- Supersedes idx_orders_line_start for the /tasks read path when scheduled_start is set.
CREATE INDEX IF NOT EXISTS idx_orders_line_eff_start
  ON orders(production_line, COALESCE(scheduled_start, basic_start_date));

-- Defense-in-depth: reject inverted user-scheduled ranges at the DB layer too
-- (the app already validates in update_task_dates_bulk). NOT VALID so the
-- migration never fails on pre-existing rows; still enforced on all new writes.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_sched_range;
ALTER TABLE orders ADD CONSTRAINT chk_orders_sched_range
    CHECK (scheduled_start IS NULL OR scheduled_end IS NULL OR scheduled_end > scheduled_start)
    NOT VALID;

-- Productive schedule pieces for a logical order. No segment is individually
-- addressable by the API: callers replace the complete ordered aggregate while
-- the parent orders.xmin remains the optimistic-concurrency token.
CREATE TABLE IF NOT EXISTS order_schedule_segments (
    order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    segment_no       INTEGER NOT NULL CHECK (segment_no > 0),
    scheduled_start  TIMESTAMP NOT NULL,
    scheduled_end    TIMESTAMP NOT NULL,
    PRIMARY KEY (order_id, segment_no),
    CHECK (scheduled_end > scheduled_start)
);
CREATE INDEX IF NOT EXISTS idx_order_schedule_segments_order_start
    ON order_schedule_segments(order_id, scheduled_start);

-- Migration for databases created before firming_indicator existed. db.py both
-- reads (query_orders SELECT) and writes (ingest upsert) this column; without it
-- GET /tasks fails with UndefinedColumn. ADD COLUMN IF NOT EXISTS is idempotent.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS firming_indicator TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS runtime_schedule_mismatch BOOLEAN NOT NULL DEFAULT FALSE;

-- ----------------------------------------------------------------------------
-- upload_audit: one row per /upload call so the Admin Cockpit can show a
-- history of uploads with insert/update counts and any parser warnings.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS upload_audit (
    batch_id        UUID PRIMARY KEY,
    filename        TEXT,
    row_count       INTEGER,
    inserted_count  INTEGER,
    updated_count   INTEGER,
    uploaded_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    warnings        JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_uploaded_at ON upload_audit(uploaded_at DESC);

-- ============================================================================
-- MASTER DATA — Subnetwork → Plant → Production Line hierarchy
-- ============================================================================

CREATE TABLE IF NOT EXISTS subnetworks (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plants (
    subnetwork         TEXT NOT NULL REFERENCES subnetworks(code)
                           ON DELETE CASCADE ON UPDATE CASCADE,
    plant              TEXT NOT NULL,
    timezone           TEXT,
    alt_flag_horizon   INTEGER NOT NULL DEFAULT 43200,
    conf_score_horizon INTEGER NOT NULL DEFAULT 20160,
    created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant)
);
CREATE INDEX IF NOT EXISTS idx_plants_subnetwork ON plants(subnetwork);
-- Migrations for existing databases
ALTER TABLE plants ADD COLUMN IF NOT EXISTS alt_flag_horizon   INTEGER NOT NULL DEFAULT 43200;
ALTER TABLE plants ADD COLUMN IF NOT EXISTS conf_score_horizon INTEGER NOT NULL DEFAULT 20160;
-- Plant identity & personalization (2026-08-11): human name, product focus,
-- IANA timezone. Additive, nullable — no schema_migrations ledger entry needed.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS description   TEXT;
ALTER TABLE plants ADD COLUMN IF NOT EXISTS product_focus TEXT;
ALTER TABLE plants ADD COLUMN IF NOT EXISTS timezone      TEXT;
-- Kept separate from the ordered priority constraint tree: this is an
-- allocation policy, not a priority term. Existing plants default to exact
-- legacy behavior until an admin deliberately opts in.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS split_order_policy TEXT NOT NULL DEFAULT 'never';
-- Changeover Matrix Stage 2 policy sidecar. Kept separate from the priority
-- tree; all policies start disabled until plant validation gates are met.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS setup_policy_config JSONB NOT NULL DEFAULT
  '{"dueDateFirstEnabled": false, "minChangeoverEnabled": false, "throughputEnabled": false, "throughputMinSavingsMin": 60, "throughputMaxSlipMin": 1440, "version": 1}'::jsonb;
ALTER TABLE plants ADD COLUMN IF NOT EXISTS setup_release_evidence JSONB NOT NULL DEFAULT
  '{"stage1Validated": false, "localDbVerified": false, "performanceVerified": false, "browserUatVerified": false, "representativeReplayVerified": false, "nullPredecessorVerified": false, "ownerApproved": false, "ownerEmail": null, "approvedAt": null, "notes": "", "version": 1}'::jsonb;
-- Legacy day→minute horizon conversion — ONE-TIME, now recorded in the ledger
-- and NO LONGER re-run on apply.
--
-- History: these horizon columns store MINUTES (defaults 43200 / 20160). An early
-- schema stored days, and a migration multiplied any value <= 365 (a day count) by
-- 1440. That UPDATE was left UNGUARDED, so it re-ran on EVERY schema.sql apply and
-- silently re-multiplied any legitimate sub-365-MINUTE horizon edit (e.g. a 300-min
-- horizon → 432000) — a live data-corruption landmine. The conversion cannot be made
-- safely idempotent by value alone: a sub-365 number is ambiguous (a day-count to
-- convert vs. an already-correct small minute value).
--
-- Resolution: every live database was converted long ago (the old UPDATE ran on
-- every apply), so their horizons are already minutes. We therefore record the
-- migration as applied WITHOUT re-running it — protecting any current sub-365-minute
-- value from a final erroneous ×1440. The ONLY scenario that could still need the
-- conversion is restoring from a pre-minutes (day-valued) dump; handle that as an
-- explicit, backup-first one-off, running exactly these two statements once:
--     UPDATE plants SET alt_flag_horizon   = alt_flag_horizon   * 1440 WHERE alt_flag_horizon   <= 365;
--     UPDATE plants SET conf_score_horizon = conf_score_horizon * 1440 WHERE conf_score_horizon <= 365;
-- then INSERT the ledger row below so it is never repeated. See MIGRATION.md.
INSERT INTO schema_migrations (id) VALUES ('plants_horizon_minutes') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS production_lines (
    subnetwork       TEXT NOT NULL,
    plant            TEXT NOT NULL,
    production_line  TEXT NOT NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, production_line),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lines_plant ON production_lines(subnetwork, plant);
-- Plant-only index: the stateless /tasks join filters by plant alone, which the
-- composite above (subnetwork-leading) can't serve efficiently.
CREATE INDEX IF NOT EXISTS idx_lines_plant_only ON production_lines(plant);
-- Line-code index: the order->plant derivation (ingest, backfill, re-attribution)
-- looks up production_lines by production_line alone, which the subnetwork-leading
-- composite PK cannot serve efficiently.
CREATE INDEX IF NOT EXISTS idx_lines_production_line ON production_lines(production_line);

-- ----------------------------------------------------------------------------
-- line_key: stable, human-readable composite identity string for a production
-- line, e.g. "HMF_5512_LINE01". GENERATED so it can never drift from the
-- natural PK (subnetwork, plant, production_line) — never write to it
-- directly, and never register it in column_metadata (it would make the
-- Add-Column wizard / export_schema_sql / bulk_apply try to write a value
-- into a generated column, which Postgres rejects outright).
-- Soft reference only: indexed for identity/joins, NOT a hard FK from
-- orders/labor_plan_line/line_calendar/line_blackout — those tables can
-- reference a plant+line combo before it's registered here, same as today.
-- Must precede the orders.plant/line_key blocks below in file order: the
-- orders.line_key backfill selects this column, so it has to exist first.
-- ----------------------------------------------------------------------------
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS line_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || production_line) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lines_line_key ON production_lines(line_key);

-- ----------------------------------------------------------------------------
-- orders.plant — per-order plant attribution. Placed AFTER production_lines so the
-- backfill below can resolve the line→plant mapping. The /tasks read path now selects
-- o.plant directly instead of LEFT JOINing production_lines on the line code alone,
-- which fanned out / mis-attributed orders when a line code is reused across plants.
-- Ingest sets plant from a WERKS/PLANT upload column when present, else derives it from
-- the line→plant mapping (db.ingest_orders_from_excel). Idempotent: ADD COLUMN IF NOT
-- EXISTS + a NULL-only backfill, safe to re-run.
--   ⚠ Re-run schema.sql after deploying this change, or GET /tasks errors on the
--     missing orders.plant column (the read path references o.plant). See MIGRATION.md.
-- ----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plant TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_plant ON orders(plant);
-- Partial index: the post-line-change re-attribution and ingest derivation scan
-- orders WHERE plant IS NULL; a plain btree won't serve IS NULL efficiently, so
-- index just the NULL-plant rows by line (kept tiny — most rows are attributed).
CREATE INDEX IF NOT EXISTS idx_orders_plant_null ON orders(production_line) WHERE plant IS NULL;
-- Only derive plant when the line code maps to EXACTLY ONE plant. A line code shared
-- across plants cannot be attributed from the code alone, so those rows are left NULL
-- (the app surfaces this) instead of being silently assigned to the lowest plant code.
UPDATE orders o
   SET plant = (
       SELECT MIN(pl.plant) FROM production_lines pl
        WHERE pl.production_line = o.production_line
   )
 WHERE o.plant IS NULL
   AND (
       SELECT COUNT(DISTINCT pl.plant) FROM production_lines pl
        WHERE pl.production_line = o.production_line
   ) = 1;

-- ----------------------------------------------------------------------------
-- orders.line_key — soft-reference identity string mirroring production_lines
-- line_key. Plain TEXT (not generated — orders has no subnetwork column, and
-- adding one would be redundant; plant is already enforced ~globally unique
-- via ensure_unique_plant(), so a (plant, production_line) lookup against
-- production_lines is sufficient). Populated by copying production_lines.
-- line_key for the matching (plant, production_line) pair. Kept in sync by
-- db.py (ingest upsert CASE + reattribution), not by the DB.
-- Strictly downstream of orders.plant: a line code ambiguous across >1 plant
-- (left plant NULL above) stays line_key NULL too — this does not resolve
-- that pre-existing ambiguity, it inherits it (see MIGRATION.md).
-- ----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS line_key TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_line_key ON orders(line_key);
CREATE INDEX IF NOT EXISTS idx_orders_line_key_null ON orders(production_line, plant) WHERE line_key IS NULL;

UPDATE orders o
   SET line_key = (
       SELECT pl.line_key FROM production_lines pl
        WHERE pl.plant = o.plant AND pl.production_line = o.production_line
   )
 WHERE o.line_key IS NULL
   AND o.plant IS NOT NULL
   AND (
       SELECT COUNT(*) FROM production_lines pl
        WHERE pl.plant = o.plant AND pl.production_line = o.production_line
   ) = 1;

-- ============================================================================
-- MATERIAL MASTER DATA
-- ============================================================================

CREATE TABLE IF NOT EXISTS materials (
    material_id           VARCHAR(18)  PRIMARY KEY,
    material_description  VARCHAR(60)  NOT NULL DEFAULT '',
    material_type         VARCHAR(4)   NOT NULL DEFAULT '',
    base_uom              VARCHAR(3)   NOT NULL DEFAULT '',
    created_at            TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS material_plants (
    material_id                  VARCHAR(18)  NOT NULL
                                     REFERENCES materials(material_id)
                                     ON DELETE CASCADE ON UPDATE CASCADE,
    plant                        VARCHAR(10)  NOT NULL,
    subnetwork                   VARCHAR(3)   NOT NULL DEFAULT '',
    status_pl                    VARCHAR(2)   NOT NULL DEFAULT '',
    default_production_version   VARCHAR(4)   NOT NULL DEFAULT '',
    min_lot_size                 INTEGER      NOT NULL DEFAULT 0,
    incremental_lot_size         INTEGER      NOT NULL DEFAULT 0,
    created_at                   TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMP    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (material_id, plant)
);
-- Redundant with the (material_id, plant) PK's left prefix for any
-- material_id-only lookup — left in place; dropping it is unrelated cleanup
-- (see idx_material_plants_plant_material below for the index this schema
-- actually needed: a plant-LEADING composite for plant-scoped grid reads).
CREATE INDEX IF NOT EXISTS idx_material_plants_material ON material_plants(material_id);

-- ----------------------------------------------------------------------------
-- Bill of Materials — one row per component per level per material/plant/alt
-- BOM. True row-unique key is (material_id, plant, alternative_bom, level,
-- item_number, component_id); (material_id, plant, alternative_bom) is the
-- natural "BOM header" grouping but not a separate DB key. Both the parent
-- material and the component must already exist at this plant in
-- material_plants — component is always sourced from the SAME plant as the
-- parent material, so both FKs share the `plant` column rather than
-- carrying a separate component_plant. ON DELETE RESTRICT: removing a
-- material_plants row is blocked while bom_items still references it either
-- way, so BOM data must be cleaned up first (see master_data.cascade_preview).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bom_items (
    material_id           TEXT      NOT NULL,
    plant                 TEXT      NOT NULL,
    alternative_bom       TEXT      NOT NULL,
    level                 INTEGER   NOT NULL,
    item_number           TEXT      NOT NULL,
    component_id          TEXT      NOT NULL,
    base_quantity         NUMERIC,
    item_category         TEXT      NOT NULL DEFAULT '',
    assembly              TEXT      NOT NULL DEFAULT '',
    component_quantity    NUMERIC,
    base_unit_of_measure  TEXT      NOT NULL DEFAULT '',
    valid_from            DATE,
    valid_to              DATE,
    changed_on            DATE,
    change_number         TEXT      NOT NULL DEFAULT '',
    created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (material_id, plant, alternative_bom, level, item_number, component_id),
    FOREIGN KEY (material_id, plant) REFERENCES material_plants(material_id, plant)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (component_id, plant) REFERENCES material_plants(material_id, plant)
        ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bom_items_material_plant ON bom_items(material_id, plant);
CREATE INDEX IF NOT EXISTS idx_bom_items_component_plant ON bom_items(component_id, plant);

-- column_metadata: display labels + whether a column is a locked key column.
-- System columns (created_at, updated_at) are never inserted here — the
-- backend filters them out before returning column lists to the UI.
CREATE TABLE IF NOT EXISTS column_metadata (
    table_name      TEXT NOT NULL,
    column_name     TEXT NOT NULL,
    display_label   TEXT NOT NULL,
    is_locked       BOOLEAN NOT NULL DEFAULT FALSE,
    column_order    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (table_name, column_name)
);

-- admin_audit: every DDL change (add/drop/rename column) and bulk data
-- operation writes one row here for compliance and troubleshooting.
CREATE TABLE IF NOT EXISTS admin_audit (
    id          BIGSERIAL PRIMARY KEY,
    table_name  TEXT NOT NULL,
    action      TEXT NOT NULL,
    column_name TEXT,
    details     JSONB,
    user_email  TEXT,
    occurred_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_occurred_at ON admin_audit(occurred_at DESC);

-- ----------------------------------------------------------------------------
-- Production Line Group column (added via Admin DDL; schema.sql ensures it
-- survives a fresh-DB migration without requiring a manual ALTER TABLE).
-- ----------------------------------------------------------------------------
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS pl_group TEXT;
INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order)
VALUES ('production_lines', 'pl_group', 'Production Line Group', FALSE, 4)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Optimizer-flag columns (added via Admin DDL at some point; the physical
-- columns and/or their column_metadata rows never made it into schema.sql,
-- so `list_rows`'s INNER JOIN against column_metadata silently hid them from
-- GET /master-data/production_lines — the ProdLines "Bottleneck"/"Excl.
-- Optimizer" checkboxes therefore reset to unchecked on every master-data
-- reload even after being toggled. ADD COLUMN IF NOT EXISTS covers the case
-- where the physical column is already there; the INSERT closes the metadata
-- gap either way.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- material_plants planner-attribute columns (prt_01, prt_02, color) — added via
-- the Admin -> Manage Data Tables "Add Column" DDL wizard against the live Azure
-- DB, never backfilled into schema.sql. Same failure mode as the optimizer flags
-- above: list_rows INNER JOINs column_metadata against information_schema, so
-- the physical column AND its metadata row must BOTH exist or the column is
-- invisible to the API. These three are the ONLY columns writable through
-- POST /master-data/material-plants/attributes
-- (master_data.EDITABLE_MATERIAL_PLANT_ATTRS).
-- Verbatim copy in migrations/2026-08-07-material-plant-attributes.sql.
-- ----------------------------------------------------------------------------
ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS prt_01 TEXT;
ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS prt_02 TEXT;
ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS color  TEXT;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('material_plants', 'prt_01', 'Prod. Resource Tool (01)', FALSE,  8),
    ('material_plants', 'prt_02', 'Prod. Resource Tool (02)', FALSE,  9),
    ('material_plants', 'color',  'Color',                    FALSE, 10)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- Plant-leading index for the plant-scoped Master Data > Material / Material
-- Plant grids: both filter material_plants by `plant` ALONE, which the
-- (material_id, plant) PK cannot serve efficiently (material_id leads it), so
-- a ?plant= filter would seq-scan the whole table. Same reasoning as
-- idx_lines_plant_only on production_lines above. Composite (plant,
-- material_id) rather than plant-only: it also satisfies the grid's
-- ORDER BY material_id within a plant, and lets the Material grid's
-- EXISTS(...) semi-join run as an index-only probe.
-- (idx_material_plants_material above is redundant with the PK's left prefix
-- but is left in place — dropping it is an unrelated cleanup, not bundled here.)
CREATE INDEX IF NOT EXISTS idx_material_plants_plant_material
    ON material_plants(plant, material_id);

-- ----------------------------------------------------------------------------
-- material_plants.default_workcenter — same drift-repair pattern as prt_01/
-- prt_02/color above: added directly to schema.sql + a standalone migration
-- (migrations/2026-08-10-material-plant-default-workcenter.sql) rather than
-- via the Add Column wizard, to avoid the same backfill gap. Editable
-- through POST /master-data/material-plants/attributes alongside
-- prt_01/prt_02/color (master_data.EDITABLE_MATERIAL_PLANT_ATTRS).
-- ----------------------------------------------------------------------------
ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS default_workcenter TEXT;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('material_plants', 'default_workcenter', 'Default Workcenter', FALSE, 11)
ON CONFLICT (table_name, column_name) DO NOTHING;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('plants', 'description',   'Description',     FALSE, 5),
    ('plants', 'product_focus', 'Product Focus',   FALSE, 6),
    ('plants', 'timezone',      'Timezone (IANA)', FALSE, 7)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Live-schema catch-up: column_metadata rows restating columns already
-- declared in this file's CREATE TABLE statements above (harmless — table_name
-- lookups in list_rows/export_schema_sql only ever query registered columns
-- that also physically exist; ON CONFLICT DO NOTHING makes re-running this a
-- no-op). Captured from a live-DB schema export so a from-scratch DB and the
-- deployed Azure DB agree on what's registered.
-- ----------------------------------------------------------------------------
INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('subnetworks',       'code',                         'Subnetwork',                   TRUE,  1),
    ('subnetworks',       'name',                          'Subnetwork Name',              FALSE, 2),
    ('plants',            'subnetwork',                    'Subnetwork',                   TRUE,  1),
    ('plants',            'plant',                         'Plant',                        TRUE,  2),
    ('plants',            'alt_flag_horizon',              'Alert Flag Horizon (days)',    FALSE, 3),
    ('plants',            'conf_score_horizon',            'Conf Score Horizon (days)',    FALSE, 4),
    ('plants',            'timezone',                       'Plant Timezone (IANA)',         FALSE, 5),
    ('production_lines',  'subnetwork',                    'Subnetwork',                   TRUE,  1),
    ('production_lines',  'plant',                         'Plant',                        TRUE,  2),
    ('production_lines',  'production_line',               'Production Line',              TRUE,  3),
    ('roles',             'role',                          'Role',                         TRUE,  1),
    ('roles',             'description',                   'Description',                  FALSE, 2),
    ('role_plants',       'role',                          'Role',                         TRUE,  1),
    ('role_plants',       'plant',                         'Plant',                        TRUE,  2)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- KNOWN, DELIBERATELY-UNMIRRORED inert drift: a live-DB schema export also
-- carried column_metadata rows for an `orders` table (id, production_order,
-- material_number, ... 28 columns). `orders` is NOT in
-- master_data.ALLOWED_TABLES, so these rows are inert today — list_rows,
-- export_schema_sql, and every other column_metadata reader gate on
-- ALLOWED_TABLES first (master_data.py _assert_table / the ALLOWED_TABLES
-- loop in export_schema_sql) and never reach them. They are deliberately NOT
-- inserted here: if `orders` is ever added to ALLOWED_TABLES in the future,
-- these stale rows would instantly materialize a live, ungated, editable
-- CRUD grid over the orders table with whatever is_locked flags happen to be
-- on record, which is a footgun with zero present benefit. If you need to
-- confirm what's live on Azure, use GET /master-data/_schema-export against
-- Azure directly rather than assuming this comment is current.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- Labor Planning — aggregate available labor hours by line group × ISO week
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_plan (
    subnetwork  TEXT    NOT NULL,
    plant       TEXT    NOT NULL,
    pl_group    TEXT    NOT NULL,
    period      TEXT    NOT NULL,   -- ISO week key: 'YYYY-Www'
    avail_hours NUMERIC,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, pl_group, period),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_labor_plan_plant ON labor_plan(plant);

-- Migrate from old headcount column if it still exists.
-- Guarded with a DO block + dynamic SQL: on a fresh DB the `headcount` column
-- does not exist, and referencing it directly in a plain UPDATE would raise
-- "column does not exist" at plan time (before WHERE is evaluated), aborting
-- the script. EXECUTE defers parsing until we've confirmed the column exists.
ALTER TABLE labor_plan ADD COLUMN IF NOT EXISTS avail_hours NUMERIC;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'labor_plan' AND column_name = 'headcount'
  ) THEN
    EXECUTE 'UPDATE labor_plan SET avail_hours = headcount WHERE avail_hours IS NULL AND headcount IS NOT NULL';
  END IF;
END $$;

-- Labor Plan Line — available labor hours per production line per calendar day
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_plan_line (
    subnetwork      TEXT    NOT NULL,
    plant           TEXT    NOT NULL,
    production_line TEXT    NOT NULL,
    day             TEXT    NOT NULL,   -- ISO date 'YYYY-MM-DD'
    avail_hours     NUMERIC,
    source          TEXT    NOT NULL DEFAULT 'auto_split',  -- 'auto_split'|'calendar'|'override'
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, production_line, day)
);
CREATE INDEX IF NOT EXISTS idx_labor_plan_line_plant ON labor_plan_line(plant);
CREATE INDEX IF NOT EXISTS idx_labor_plan_line_plant_line ON labor_plan_line(plant, production_line);
-- line_key: same generated identity string as production_lines.line_key (see
-- above). This table already carries its own subnetwork/plant/production_line,
-- so it self-populates on ALTER — no lookup/backfill needed. NOT a startup-hook
-- table for this column: schema.sql only reaches a pre-existing prod DB once at
-- provisioning (see master_data.py's ensure_line_key_columns() for the
-- redeploy-safe path that also covers this table).
ALTER TABLE labor_plan_line ADD COLUMN IF NOT EXISTS line_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || production_line) STORED;
CREATE INDEX IF NOT EXISTS idx_lpl_line_key ON labor_plan_line(line_key);

-- ----------------------------------------------------------------------------
-- Plant / line calendars (working hours) + blackout blocks
--   Fresh-DB parity for the idempotent ensure_* startup migrations in
--   master_data.py (which are authoritative for prod). Additive only — no
--   data re-mutation on re-run (like the now-ledger-guarded plants horizon
--   conversion above, which no longer re-mutates).
--   Working-hours shape mirrors the frontend Store: {"0".."6": [h1,h2]|null}.
-- ----------------------------------------------------------------------------
-- Plant-level weekly working hours (kept out of column_metadata like constraints).
ALTER TABLE plants ADD COLUMN IF NOT EXISTS work_hours JSONB;

-- Enforce the global plant-code uniqueness the app already assumes
-- (getPlantForLine, /tasks?plant=, plant-only constraint updates). Skip if
-- duplicate plant codes already exist across subnetworks.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_plants_plant')
     AND NOT EXISTS (SELECT plant FROM plants GROUP BY plant HAVING COUNT(*) > 1) THEN
    ALTER TABLE plants ADD CONSTRAINT uq_plants_plant UNIQUE (plant);
  END IF;
END $$;

-- Line-level working hours. No FK to production_lines (like labor_plan_line) so
-- order-derived lines that lag master data still persist; only the plants FK.
CREATE TABLE IF NOT EXISTS line_calendar (
    subnetwork      TEXT NOT NULL,
    plant           TEXT NOT NULL,
    production_line TEXT NOT NULL,
    work_hours      JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, production_line),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_line_calendar_plant ON line_calendar(plant);
-- line_key: same generated identity string as production_lines.line_key.
-- See master_data.py's ensure_line_key_columns() for the redeploy-safe path
-- (this table is startup-hook-authoritative for prod, not schema.sql).
ALTER TABLE line_calendar ADD COLUMN IF NOT EXISTS line_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || production_line) STORED;
CREATE INDEX IF NOT EXISTS idx_line_calendar_line_key ON line_calendar(line_key);

-- Line blackout blocks. production_line NULL = all lines in this plant.
-- block_id is client-supplied (Util.uid 'blk'). Delta writes only.
CREATE TABLE IF NOT EXISTS line_blackout (
    subnetwork      TEXT      NOT NULL,
    plant           TEXT      NOT NULL,
    production_line TEXT,
    block_id        TEXT      NOT NULL,
    start_ts        TIMESTAMP NOT NULL,
    end_ts          TIMESTAMP NOT NULL,
    reason          TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, block_id),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT chk_line_blackout_range CHECK (end_ts > start_ts)
);
CREATE INDEX IF NOT EXISTS idx_line_blackout_plant ON line_blackout(plant);
-- line_key: same generated identity string as production_lines.line_key.
-- production_line is nullable here (NULL = all lines in plant) — '||'
-- propagates NULL automatically, so line_key correctly comes out NULL for
-- plant-wide blocks with no special-casing. See master_data.py's
-- ensure_line_key_columns() for the redeploy-safe path (startup-hook table).
ALTER TABLE line_blackout ADD COLUMN IF NOT EXISTS line_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || production_line) STORED;
CREATE INDEX IF NOT EXISTS idx_line_blackout_line_key ON line_blackout(line_key);

-- Plant-level blackout blocks. block_id is client-supplied (Util.uid 'pblk').
CREATE TABLE IF NOT EXISTS plant_blackout (
    subnetwork  TEXT      NOT NULL,
    plant       TEXT      NOT NULL,
    block_id    TEXT      NOT NULL,
    start_ts    TIMESTAMP NOT NULL,
    end_ts      TIMESTAMP NOT NULL,
    reason      TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, block_id),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT chk_plant_blackout_range CHECK (end_ts > start_ts)
);
CREATE INDEX IF NOT EXISTS idx_plant_blackout_plant ON plant_blackout(plant);

-- ----------------------------------------------------------------------------
-- Seed data (idempotent — safe to re-run)
-- ----------------------------------------------------------------------------
INSERT INTO subnetworks (code, name) VALUES
    ('WTG', 'Writing'),
    ('FOD', 'Food'),
    ('HAP', 'Home Appliances'),
    ('BBY', 'Baby'),
    ('OAR', 'Outdoor & Recreation'),
    ('HMF', 'Home Fragrance'),
    ('CCS', 'Commercial')
ON CONFLICT (code) DO NOTHING;

INSERT INTO plants (subnetwork, plant) VALUES
    ('WTG', '1006'),
    ('HMF', '5512')
ON CONFLICT (subnetwork, plant) DO NOTHING;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('subnetworks',      'code',            'Subnetwork',      TRUE,  1),
    ('subnetworks',      'name',            'Subnetwork Name', FALSE, 2),
    ('plants',           'subnetwork',        'Subnetwork',              TRUE,  1),
    ('plants',           'plant',             'Plant',                   TRUE,  2),
    ('plants',           'alt_flag_horizon',  'Alert Flag Horizon (days)',  FALSE, 3),
    ('plants',           'conf_score_horizon','Conf Score Horizon (days)', FALSE, 4),
    ('plants',           'timezone',          'Plant Timezone (IANA)',      FALSE, 5),
    ('production_lines', 'subnetwork',      'Subnetwork',      TRUE,  1),
    ('production_lines', 'plant',           'Plant',           TRUE,  2),
    ('production_lines', 'production_line', 'Production Line', TRUE,  3),
    ('materials',        'material_id',                'Material ID',                  TRUE,  1),
    ('materials',        'material_description',       'Material Description',         FALSE, 2),
    ('materials',        'material_type',              'Material Type',                FALSE, 3),
    ('materials',        'base_uom',                   'Base UoM',                     FALSE, 4),
    ('material_plants',  'material_id',                'Material ID',                  TRUE,  1),
    ('material_plants',  'plant',                      'Plant',                        TRUE,  2),
    ('material_plants',  'subnetwork',                 'Subnetwork',                   FALSE, 3),
    ('material_plants',  'status_pl',                  'Status PL',                    FALSE, 4),
    ('material_plants',  'default_production_version', 'Default Production Version',   FALSE, 5),
    ('material_plants',  'min_lot_size',               'Minimum Lot Size',             FALSE, 6),
    ('material_plants',  'incremental_lot_size',       'Incremental Lot Size',         FALSE, 7),
    ('bom_items',        'material_id',                'Material',                     TRUE,  1),
    ('bom_items',        'plant',                      'Plant',                        TRUE,  2),
    ('bom_items',        'alternative_bom',            'Alternative BOM',              TRUE,  3),
    ('bom_items',        'level',                      'Level',                        TRUE,  4),
    ('bom_items',        'item_number',                'Item Number',                  TRUE,  5),
    ('bom_items',        'component_id',               'Component',                    TRUE,  6),
    ('bom_items',        'base_quantity',               'Base Quantity',               FALSE, 7),
    ('bom_items',        'item_category',               'Item Category',               FALSE, 8),
    ('bom_items',        'assembly',                    'Assembly',                    FALSE, 9),
    ('bom_items',        'component_quantity',          'Component Quantity',          FALSE, 10),
    ('bom_items',        'base_unit_of_measure',        'Base Unit of Measure',        FALSE, 11),
    ('bom_items',        'valid_from',                  'Valid From',                  FALSE, 12),
    ('bom_items',        'valid_to',                    'Valid To',                    FALSE, 13),
    ('bom_items',        'changed_on',                  'Changed On',                  FALSE, 14),
    ('bom_items',        'change_number',               'Change Number',               FALSE, 15)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- SAP Interface (sap_sync) tables -- idempotent, append-only
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sap_sync_config (
    object_key     TEXT PRIMARY KEY,
    enabled        BOOLEAN NOT NULL DEFAULT FALSE,
    transport      TEXT NOT NULL DEFAULT 'file_drop',
    schedule_cron  TEXT,
    source_params  JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_watermark TEXT,
    updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sap_sync_run (
    id               BIGSERIAL PRIMARY KEY,
    object_key       TEXT NOT NULL,
    started_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at         TIMESTAMP,
    status           TEXT NOT NULL DEFAULT 'running',
    rows_read        INT NOT NULL DEFAULT 0,
    rows_inserted    INT NOT NULL DEFAULT 0,
    rows_updated     INT NOT NULL DEFAULT 0,
    rows_failed      INT NOT NULL DEFAULT 0,
    error            TEXT,
    watermark_before TEXT,
    watermark_after  TEXT,
    triggered_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sap_run_object_started ON sap_sync_run(object_key, started_at DESC);

CREATE TABLE IF NOT EXISTS sap_field_map (
    object_key    TEXT NOT NULL,
    sap_field     TEXT NOT NULL,
    nimbus_column TEXT NOT NULL,
    transform     TEXT NOT NULL DEFAULT 'none',
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    field_order   INT NOT NULL DEFAULT 0,
    PRIMARY KEY (object_key, sap_field)
);
CREATE INDEX IF NOT EXISTS idx_sap_field_map_object ON sap_field_map(object_key, field_order);

-- Seed one config row per object_key (transport file_drop, disabled by default)
INSERT INTO sap_sync_config (object_key, transport) VALUES
    ('subnetworks',      'file_drop'),
    ('plants',           'file_drop'),
    ('production_lines', 'file_drop'),
    ('materials',        'file_drop'),
    ('material_plants',  'file_drop'),
    ('orders',           'file_drop')
ON CONFLICT (object_key) DO NOTHING;

-- Starter orders field-map rows
INSERT INTO sap_field_map (object_key, sap_field, nimbus_column, transform, field_order) VALUES
    ('orders', 'AUFNR', 'production_order',     'strip_zeros', 1),
    ('orders', 'MATNR', 'material_number',      'alpha',       2),
    ('orders', 'GSTRP', 'basic_start_date',     'dats',        3),
    ('orders', 'GLTRP', 'basic_finish_date',    'dats',        4),
    ('orders', 'GAMNG', 'order_quantity',       'decimal',     5)
ON CONFLICT (object_key, sap_field) DO NOTHING;

-- ----------------------------------------------------------------------------
-- color_wheel: durable per-plant uploaded color wheels
--
-- Replaces the ephemeral COLOR_WHEEL_DIR/color_wheel_<SAFE>.xlsx + _meta.json
-- files (Container Apps /data is wiped on every restart/redeploy). One row per
-- plant. `entries` is the parsed {COLOR: ORDER_Y} priority map (COLOR upper/
-- stripped; ORDER_Y numeric, NULL for a blank/unparseable rank — treated as
-- last priority 999999 on read, matching apply_color_merge()).
--
-- plant_key = _cw_safe_name(plant) (uppercase, non-word chars -> '_'): the same
-- key used for the on-disk filename stem and the PLANT_CWS cache, so the
-- collision profile is byte-for-byte unchanged. No FK to plants — like
-- line_calendar, a wheel may exist for an order-derived plant that lags master
-- data, and wheels are plant-keyed, not subnetwork-scoped. plant_label keeps the
-- raw plant code as typed (for the /color-wheels listing).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS color_wheel (
    plant_key   TEXT PRIMARY KEY,
    plant_label TEXT NOT NULL,
    entries     JSONB NOT NULL,
    filename    TEXT,
    row_count   INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT,
    uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- SECURITY / RBAC scaffolding — roles, role_plants, user_security
--
-- roles + role_plants are generic-CRUD backed via master_data.py (registered
-- in ALLOWED_TABLES), same as subnetworks/plants/production_lines above.
-- user_security is credentials storage — deliberately NEVER registered in
-- master_data's ALLOWED_TABLES; it is only ever read/written through the
-- dedicated auth.py functions and the /security/* endpoints in brain.py, not
-- the generic /master-data/{table} CRUD path. password_hash is never
-- selected back to the frontend (see auth.list_users).
--
-- Table order matters: roles must exist before role_plants and
-- user_security, which both FK to roles(role).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    role        TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
-- Per-role DEFAULT settings blob — shallow-merged UNDER each user's own
-- user_settings by the frontend (resolution precedence:
-- userSettings[key] ?? roleSettings[key] ?? SYSTEM_DEFAULT[key]). Added after
-- the roles table, hence ALTER rather than inline. Never applied to admins.
-- See migrations/2026-07-09-user-settings.sql.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS role_plants (
    role        TEXT NOT NULL REFERENCES roles(role) ON DELETE CASCADE ON UPDATE CASCADE,
    plant       TEXT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (role, plant)
);
CREATE INDEX IF NOT EXISTS idx_role_plants_plant ON role_plants(plant);

CREATE TABLE IF NOT EXISTS user_security (
    username      TEXT PRIMARY KEY,
    password_hash TEXT,
    role          TEXT REFERENCES roles(role) ON DELETE RESTRICT ON UPDATE CASCADE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
-- First/last name are optional profile fields, self-service editable via
-- PATCH /security/me and admin-editable via the Security tab — added after
-- the initial table, hence ALTER TABLE rather than inline above. See
-- migrations/2026-07-08-user-name-fields.sql.
ALTER TABLE user_security ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE user_security ADD COLUMN IF NOT EXISTS last_name  TEXT;

-- last_login is a server-set audit timestamp, updated only by
-- auth.authenticate() on a SUCCESSFUL login. Nullable — NULL means "never
-- logged in since this column existed," shown as "Never" in the admin
-- Security tab. Unrelated to the frontend's local 12h session expiry (a
-- purely client-side localStorage check) — this is just an audit trail.
-- See migrations/2026-08-03-user-last-login.sql.
ALTER TABLE user_security ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;

-- Case-insensitive uniqueness on username. The PK stays case-sensitive (so
-- display case like 'PJ29587' is preserved), but login + require_admin match on
-- lower(username), and the auth.py user upserts infer ON CONFLICT (lower(username))
-- from this index. Also self-bootstrapped by auth.ensure_user_security_table().
-- See migrations/2026-07-08-username-ci-index.sql for the case-collision pre-check.
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_security_lower_username
    ON user_security (lower(username));

-- NOTE: the 'admin' row in `roles` and a bootstrap admin user ('PJ29587') in `user_security`
-- are NOT seeded here. They are seeded idempotently (ON CONFLICT DO NOTHING) at app startup
-- by auth.ensure_bootstrap_admin(), called from brain.py's lifespan hook right after
-- auth.ensure_user_security_table() — see MIGRATION.md (Workstream 3 section, "Mandatory
-- login + require_admin"). If you're looking for an INSERT that creates the first admin,
-- it lives in Python, not in this file.

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('roles', 'role', 'Role', TRUE, 1),
    ('roles', 'description', 'Description', FALSE, 2),
    ('role_plants', 'role', 'Role', TRUE, 1),
    ('role_plants', 'plant', 'Plant', TRUE, 2)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Per-user settings — one JSONB blob per user (theme, language, defaultPlant,
-- date/time display prefs, saved grid layout, optimizer defaults, pinned
-- plants/lines, landing view). Read/written ONLY through auth.py
-- (get_user_settings / upsert_user_settings) and the /security/me* endpoints,
-- never the generic master_data CRUD path. FK to user_security so a deleted
-- user's settings are cleaned up automatically. Self-bootstrapped at startup by
-- auth.ensure_user_settings_table(). See migrations/2026-07-09-user-settings.sql.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_settings (
    username   TEXT PRIMARY KEY REFERENCES user_security(username) ON DELETE CASCADE ON UPDATE CASCADE,
    settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SCHEDULING PRIORITY LISTS (docs/scheduling_priority.md, Stage 1 — data
-- plumbing only: no upload UI, no optimizer change yet)
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
-- Verbatim copy in migrations/2026-08-11-priority-lists.sql.
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
-- default_production_version (the material_plants base table above) — NOT
-- material_plants.default_workcenter, which stays a plain admin-editable
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
-- which are repointed at priority_list in brain.py.
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

-- ============================================================================
-- CHANGEOVER MATRIX STAGE 0 PERSISTENCE FOUNDATION
-- Verbatim copy of migrations/2026-08-13-changeover-matrix-stage-0.sql.
-- Additive, idempotent storage only: no schedule, utilization, or alert changes.
-- ============================================================================
-- Setup minutes are finite INTEGER values from zero through 10080 inclusive
-- (seven days). JSON state keys and definition fields are canonical ordered
-- JSON arrays; application validation supplies their field-level semantics.

-- setup_compatible is deliberately distinct from excl_optimizer. A FALSE value
-- prevents only setup-aware optimization for a signature-incompatible line;
-- setup data and diagnostics remain visible. The reason preserves that choice.
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS setup_compatible BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS setup_compatibility_reason TEXT;

-- One current definition per plant. Increment signature_version whenever the
-- ordered field signature changes; later writes must use that exact version.
CREATE TABLE IF NOT EXISTS setup_definition (
    plant             TEXT PRIMARY KEY,
    fields            JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
    signature_version INTEGER NOT NULL CHECK (signature_version > 0),
    strict_blanks     BOOLEAN NOT NULL DEFAULT TRUE,
    active            BOOLEAN NOT NULL DEFAULT FALSE,
    created_by        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by        TEXT,
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- A blank line scope is the plant-wide value; a nonblank line is a sparse
-- override. JSONB participates in the primary key so canonical array order is
-- significant and duplicate transitions are rejected within each version.
CREATE TABLE IF NOT EXISTS setup_matrix (
    plant             TEXT NOT NULL,
    line              TEXT NOT NULL DEFAULT '',
    signature_version INTEGER NOT NULL CHECK (signature_version > 0),
    from_key          JSONB NOT NULL CHECK (jsonb_typeof(from_key) = 'array'),
    to_key            JSONB NOT NULL CHECK (jsonb_typeof(to_key) = 'array'),
    setup_min         INTEGER NOT NULL CHECK (setup_min BETWEEN 0 AND 10080),
    source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'derived', 'actual')),
    source_metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_reference  TEXT,
    created_by        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by        TEXT,
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plant, line, signature_version, from_key, to_key)
);
CREATE INDEX IF NOT EXISTS idx_setup_matrix_plant_line_version
    ON setup_matrix (plant, line, signature_version);

-- The most recently accepted physical setup state for each plant/line.
CREATE TABLE IF NOT EXISTS line_setup_state (
    plant             TEXT NOT NULL,
    line              TEXT NOT NULL,
    state_key         JSONB NOT NULL CHECK (jsonb_typeof(state_key) = 'array'),
    signature_version INTEGER NOT NULL CHECK (signature_version > 0),
    physical_mold_id  TEXT,
    observed_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    source            TEXT NOT NULL CHECK (source IN ('manual', 'derived', 'actual')),
    reason            TEXT,
    created_by        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by        TEXT,
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plant, line)
);

-- An override represents remaining physical setup work for one exact observed
-- adjacency. It is not a persisted pseudo-order or a dependency relationship.
CREATE TABLE IF NOT EXISTS setup_occurrence_override (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant                TEXT NOT NULL,
    line                 TEXT NOT NULL,
    signature_version    INTEGER NOT NULL CHECK (signature_version > 0),
    -- NULL is the explicit initial-state predecessor; an omitted API key is
    -- rejected before this column is reached.
    predecessor_order_id TEXT,
    successor_order_id   TEXT NOT NULL,
    predecessor_state_key JSONB NOT NULL CHECK (jsonb_typeof(predecessor_state_key) = 'array'),
    successor_state_key   JSONB NOT NULL CHECK (jsonb_typeof(successor_state_key) = 'array'),
    standard_min         INTEGER NOT NULL CHECK (standard_min >= 0),
    remaining_min        INTEGER NOT NULL CHECK (remaining_min >= 0),
    status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive', 'cleared', 'replaced')),
    reason               TEXT,
    created_by           TEXT,
    created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by           TEXT,
    updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE setup_occurrence_override
    ALTER COLUMN predecessor_order_id DROP NOT NULL;
DROP INDEX IF EXISTS uq_setup_occurrence_override_active_adjacency;
CREATE UNIQUE INDEX IF NOT EXISTS uq_setup_occurrence_override_active_adjacency
    ON setup_occurrence_override (
        plant, line, signature_version, predecessor_order_id, successor_order_id,
        predecessor_state_key, successor_state_key
    )
    NULLS NOT DISTINCT
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_setup_occurrence_override_plant_line
    ON setup_occurrence_override (plant, line, signature_version);

-- Occurrence overrides represent remaining physical work, which need not fit
-- the setup-matrix seven-day standard cap. Existing Stage 0 databases may
-- retain the earlier named CHECK constraints, so replace them idempotently.
ALTER TABLE setup_occurrence_override
    DROP CONSTRAINT IF EXISTS setup_occurrence_override_standard_min_check;
ALTER TABLE setup_occurrence_override
    DROP CONSTRAINT IF EXISTS setup_occurrence_override_remaining_min_check;
ALTER TABLE setup_occurrence_override
    ADD CONSTRAINT setup_occurrence_override_standard_min_check CHECK (standard_min >= 0);
ALTER TABLE setup_occurrence_override
    ADD CONSTRAINT setup_occurrence_override_remaining_min_check CHECK (remaining_min >= 0);

-- ----------------------------------------------------------------------------
-- One-time CONVENIENCE backfill of orders.{color,prt_01,prt_02,
-- production_version} from material_plants (the last one sourced from
-- material_plants.default_production_version), keyed (plant,
-- material_number = material_id). This is NOT the mechanism — POST
-- /master-data/resync-order-attributes is (db._stamp_order_attributes,
-- called with a plant rather than a batch_id). If this runs before a
-- plant's material_plants rows are populated, it finds no matches, records
-- itself applied anyway, and will NEVER run again for that plant even after
-- the data shows up later — the inverse of the historical plants-horizon
-- x1440 ledger trap (:123 above: that one re-ran forever and corrupted data;
-- this one can permanently no-op instead). Call the resync endpoint for any
-- plant populated after this ran.
--
-- ANY UPDATE to `orders` bumps every touched row's xmin, which IS the
-- optimistic-concurrency base_version (db.py ROW_VERSION) — a bumped xmin
-- makes the row come back `stale` on the next save and the frontend discards
-- the planner's unsaved edit (last-writer-loses). Apply this migration (and
-- call the resync endpoint) at deploy time only, never mid-shift.
--
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
