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
    machine               TEXT,
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

-- orders.plant — per-order plant attribution. Added here (immediately after
-- CREATE TABLE orders) so every index/constraint below that references
-- orders.plant can rely on the column already existing on a fresh bootstrap.
-- See the backfill UPDATE further down (after the machine table exists) for
-- how existing rows get this populated from machine→plant.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plant TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_basic_start  ON orders(basic_start_date);
CREATE INDEX IF NOT EXISTS idx_orders_upload_batch ON orders(upload_batch_id);
CREATE INDEX IF NOT EXISTS idx_orders_machine       ON orders(machine);
-- Serves the stateless /tasks read path: per-machine scan ordered by start date
-- (db.query_orders ORDER BY machine, effective start). Supersedes
-- relying on the two single-column indexes above for that access pattern.
CREATE INDEX IF NOT EXISTS idx_orders_machine_start ON orders(machine, basic_start_date);
-- Matches db.query_orders() ORDER BY exactly: per-machine scan ordered by effective start (a finish-anchored row can store only scheduled_end, so it sorts by its SAP start here; the browser derives the real start from the stored finish).
-- Supersedes idx_orders_machine_start for the /tasks read path when scheduled_start is set.
CREATE INDEX IF NOT EXISTS idx_orders_machine_eff_start
  ON orders(machine, COALESCE(scheduled_start, basic_start_date));
-- Workstream C1 (2026-08-20): plant-scoped visibility-horizon bound. Neither
-- index above leads with `plant`, and this file's expression indexes can only
-- reference physical `orders` columns — not `seg.first_start`, a
-- LATERAL-join alias resolved per-query in db.py's _SCHEDULE_SEGMENTS_LATERAL_SQL,
-- not a column any btree expression index could name. This covers the
-- two-way-coalesce shape that dominates (orders with no schedule segments);
-- the segment-bearing minority stays index-assisted via
-- idx_order_schedule_segments_order_start (order_id-keyed) once the planner
-- reaches that LATERAL subquery.
CREATE INDEX IF NOT EXISTS idx_orders_plant_eff_start
  ON orders(plant, COALESCE(scheduled_start, basic_start_date));

-- Defense-in-depth: reject inverted user-scheduled ranges at the DB layer too
-- (the app already validates in update_task_dates_bulk). NOT VALID so the
-- migration never fails on pre-existing rows; still enforced on all new writes.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_sched_range;
ALTER TABLE orders ADD CONSTRAINT chk_orders_sched_range
    CHECK (scheduled_start IS NULL OR scheduled_end IS NULL OR scheduled_end > scheduled_start)
    NOT VALID;

-- H8 (2026-09-25): bound run_time so a non-finite/out-of-range value (e.g. a
-- crafted NaN RUN_TIME, or a bad SAP/Excel ingest row — both bypass the API's
-- pydantic model) can never reach db.py's SQL interval arithmetic and crash a
-- plant's board. Postgres's float/numeric total ordering (NaN sorts greater
-- than Infinity) makes this two-sided bound reject NaN and +/-Infinity with
-- no separate isfinite-style check.
--
-- schema.sql is the always-current, fresh-bootstrap end state (an empty
-- `orders` table on a brand-new database), so this is a single, plain
-- validating CHECK -- no NOT VALID/VALIDATE CONSTRAINT split needed here;
-- that two-step lock-avoidance pattern only matters for the live, large,
-- actively-written `orders` table on Azure, which is why the deploy path
-- (migrations/2026-09-25-orders-run-time-bounds.sql +
-- migrations/2026-09-26-orders-run-time-bounds-validate.sql) splits it into
-- two separate files/transactions instead.
--
-- Run-time cap (OQ28): the bound is now a pure REPRESENTATION bound (< 8760 hours); the LIMIT an order
-- is scheduled with (a flat 336 hours, no per-plant horizon term) is enforced in the
-- application. An initialised database still carries the old < 168 constraint under the SAME name, so
-- this block drops and re-adds it exactly once, guarded by the schema_migrations ledger id
-- 'orders_run_time_bounds_8760' (mirrors migrations/2026-10-15-2-orders-run-time-bounds-336.sql;
-- destructive by text: DROP CONSTRAINT, then re-ADD). Widening can never fail validation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'orders_run_time_bounds_8760') THEN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_run_time_bounds;
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_run_time_bounds
      CHECK (run_time IS NULL OR (run_time >= 0 AND run_time < 8760));
    INSERT INTO schema_migrations (id) VALUES ('orders_run_time_bounds_8760') ON CONFLICT DO NOTHING;
  END IF;
END $$;

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

-- ----------------------------------------------------------------------------
-- sap_workcenter: SAP work center policy and membership weights (2026-09-17).
-- Per-plant table; work-center codes aggregate multiple NIMBUS machines.
-- distribution_mode: 'single' = all orders land on default_machine;
--   'distribute' = orders split across members by weight.
-- max_separation: ISO week (Monday start) / day / hour / none; applies in
--   distribute mode only (§3.1). review_required: default headers start as
--   reviewed = FALSE when TRUE, as reviewed = TRUE when FALSE.
-- distribute_tooled: when FALSE, tooled materials default to single 100% share.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sap_workcenter (
    plant              TEXT NOT NULL,
    sap_workcenter     TEXT NOT NULL,
    description        TEXT,
    distribution_mode  TEXT NOT NULL DEFAULT 'single'
                       CHECK (distribution_mode IN ('single','distribute')),
    default_machine    TEXT,
    max_separation     TEXT NOT NULL DEFAULT 'none'
                       CHECK (max_separation IN ('none','hour','day','week')),
    review_required    BOOLEAN NOT NULL DEFAULT TRUE,
    distribute_tooled  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, sap_workcenter)
);

-- ----------------------------------------------------------------------------
-- order_distribution (header) and order_distribution_share: SAP aggregate
-- work center distribution across NIMBUS machines (2026-09-17).
-- Transactional tables, never grid-editable. Written solely by
-- backend/distribution/. Header + shares are replaced wholesale in one
-- transaction; header.xmin is the optimistic-concurrency token (base_version
-- on wire, 409 stale on mismatch).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_distribution (
    plant              TEXT NOT NULL,
    production_order   TEXT NOT NULL,
    material_number    TEXT NOT NULL,
    sap_workcenter     TEXT NOT NULL,
    order_quantity     NUMERIC,
    run_time           NUMERIC,
    basic_start_date   TIMESTAMP,
    basic_finish_date  TIMESTAMP,
    firming_indicator  TEXT,
    sap_facts          JSONB,
    source             TEXT NOT NULL DEFAULT 'default' CHECK (source IN ('default','manual')),
    default_basis      TEXT NOT NULL DEFAULT 'workcenter_weights'
                       CHECK (default_basis IN ('material_default','tooled_single','workcenter_weights')),
    reviewed           BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_by        TEXT,
    reviewed_at        TIMESTAMPTZ,
    reviewed_quantity  NUMERIC,
    updated_by         TEXT,
    last_batch_id      UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, production_order, material_number),
    FOREIGN KEY (plant, sap_workcenter)
        REFERENCES sap_workcenter (plant, sap_workcenter) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_order_distribution_wc
    ON order_distribution(plant, sap_workcenter, reviewed);
CREATE INDEX IF NOT EXISTS idx_order_distribution_plant_start
    ON order_distribution (plant, basic_start_date, reviewed, production_order, material_number);

CREATE TABLE IF NOT EXISTS order_distribution_share (
    plant            TEXT NOT NULL,
    production_order TEXT NOT NULL,
    material_number  TEXT NOT NULL,
    machine          TEXT NOT NULL,
    letter           TEXT NOT NULL,
    weight           NUMERIC NOT NULL DEFAULT 0 CHECK (weight >= 0),
    child_id         TEXT,
    purged_at        TIMESTAMPTZ,
    PRIMARY KEY (plant, production_order, material_number, machine),
    UNIQUE (plant, production_order, material_number, letter),
    FOREIGN KEY (plant, production_order, material_number)
        REFERENCES order_distribution (plant, production_order, material_number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ods_machine ON order_distribution_share(plant, machine);

-- Migration for databases created before firming_indicator existed. db.py both
-- reads (query_orders SELECT) and writes (ingest upsert) this column; without it
-- GET /tasks fails with UndefinedColumn. ADD COLUMN IF NOT EXISTS is idempotent.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS firming_indicator TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS runtime_schedule_mismatch BOOLEAN NOT NULL DEFAULT FALSE;

-- Order Distribution columns (2026-09-17): sub-order identification and parent link.
-- NULL for plain orders. No stored share (would drift on SAP parent qty change);
-- client derives share % from sibling quantities and "machine locked" from parent_production_order != NULL.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS parent_production_order TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS distribution_letter     TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_parent
    ON orders(plant, parent_production_order, material_number)
    WHERE parent_production_order IS NOT NULL;

-- SAP-is-truth firming (2026-10-06): planner firm flag + SAP baselines written only by ingest.
-- NULL baselines = unknown, never an SAP change. Mirrors migrations/2026-10-06-sap-truth-firming.sql.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_firmed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_workcenter TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_production_version TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_basic_start_date TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_basic_finish_date TIMESTAMP;

-- Locked copies of the SAP start/finish as received (backward scheduling Phase 1, OQ31 b / OQ26).
-- GET /tasks serves original_start_date/original_end_date as COALESCE(original_*_received, basic_*).
-- Mirrors migrations/2026-10-15-1-orders-original-dates.sql; the one-time backfill is at the end of this file.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_start_received  TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_finish_received TIMESTAMP;
-- Backward scheduling D10 (VI12): whether the SAP finish arrived as a date with no time (Send transmits the
-- working-window close instead of a zone-converted midnight). Mirrors migrations/2026-10-16-2-*.sql.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_finish_date_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_distribution ADD COLUMN IF NOT EXISTS original_finish_received TIMESTAMP;

-- Placement-exception marker (backward scheduling OQ50): 'overtime' / 'overlong' = the planner placed this bar
-- off its run-time width on purpose; NULL = a normal bar. Mirrors migrations/2026-10-16-1-orders-placement-exception.sql.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS placement_exception TEXT NULL
    CONSTRAINT chk_orders_placement_exception CHECK (placement_exception IN ('overtime', 'overlong'));

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
-- MASTER DATA — Subnetwork → Plant → Machine hierarchy
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
ALTER TABLE plants ADD COLUMN IF NOT EXISTS max_pull_forward_days INTEGER;
ALTER TABLE plants ADD COLUMN IF NOT EXISTS max_push_forward_days INTEGER;
-- B3 (2026-08-21): the productive-segment floor (minutes) both the
-- non-setup-aware split allocator (Calendar.allocateRuntime) and the
-- setup-aware placeWithSetup primitive enforce — "no split piece shorter
-- than this, except one complete unsplit order below the boundary". Was a
-- fixed system-wide 30 in code (web/schedule-services.mjs's
-- MIN_PRODUCTIVE_SEGMENT_MINUTES); NOT NULL DEFAULT 30 here preserves that
-- exact behavior for every existing plant until an admin opts into a
-- different floor via the validated
-- POST /master-data/plants/{plant}/min-productive-segment-minutes route.
-- Deliberately unregistered (no column_metadata row), same as
-- split_order_policy/max_pull_forward_days above.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS min_productive_segment_minutes INTEGER NOT NULL DEFAULT 30;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_min_productive_segment_minutes_positive') THEN
    ALTER TABLE plants ADD CONSTRAINT plants_min_productive_segment_minutes_positive
      CHECK (min_productive_segment_minutes > 0);
  END IF;
END $$;
-- Workstream D2 (2026-08-20): the "include setup times in optimizer" flag,
-- relocated off the per-signature-version setup_definition.active (which
-- reset to FALSE on every signature bump — see that table's comment below).
-- Registered in column_metadata (2026-08-21, see the INSERT below and
-- migrations/2026-08-21-plants-grid-visibility.sql) so it's also editable
-- from the generic Admin > Manage Data Tables grid, alongside the validated
-- PUT /plant/{plant}/setup-active route (following the machine.
-- setup_compatible precedent) that the dedicated Settings-pane checkbox uses.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS setup_active BOOLEAN NOT NULL DEFAULT FALSE;
-- Off (default) leaves a plant's ingest and scheduling exactly as they are
-- today. On hands the plant to the routing resolver (ROUTING_RUNTIME_DESIGN.md
-- §3.6) from that point on.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS routing_runtime_enabled BOOLEAN NOT NULL DEFAULT FALSE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_max_pull_forward_days_nonnegative') THEN
    ALTER TABLE plants ADD CONSTRAINT plants_max_pull_forward_days_nonnegative
      CHECK (max_pull_forward_days IS NULL OR max_pull_forward_days >= 0);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_max_push_forward_days_nonnegative') THEN
    ALTER TABLE plants ADD CONSTRAINT plants_max_push_forward_days_nonnegative
      CHECK (max_push_forward_days IS NULL OR max_push_forward_days >= 0);
  END IF;
END $$;
-- Workstream C1 (2026-08-20): plant-level visibility horizon — how far into the
-- future a planner can see on the Gantt and Orders tab. NULL days = unlimited
-- (existing behavior unchanged until an admin opts in), mirroring
-- max_pull_forward_days' nullable-optional shape above. horizon_roll_hour_utc
-- is NOT NULL DEFAULT 19 (mirrors setup_active's NOT NULL DEFAULT shape) so
-- every plant has a well-defined roll instant even before an admin ever visits
-- the Scheduling Rules panel. BOTH columns are registered in column_metadata
-- (see the INSERTs below and migrations/2026-08-21-plants-grid-visibility.sql
-- + migrations/2026-08-21-plants-grid-roll-hour.sql), because the Manage Data
-- Tables grid is now their ONLY editable surface: the Scheduling Rules pane's
-- rows for both were removed on 2026-08-21, so the dedicated
-- POST /master-data/plants/{plant}/visibility-horizon route still exists but
-- has no frontend caller. horizon_roll_hour_utc was briefly left unregistered
-- earlier the same day, which left it with no UI at all. See
-- docs/multi_change_spec_08.20.26.md's C1 section for the plant-local-midnight-
-- with-a-UTC-roll-hour design and its three implementation corrections
-- (three-way coalesce, count_orders' separate WHERE builder, indexing).
ALTER TABLE plants ADD COLUMN IF NOT EXISTS visibility_horizon_days INTEGER;
ALTER TABLE plants ADD COLUMN IF NOT EXISTS horizon_roll_hour_utc INTEGER NOT NULL DEFAULT 19;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_visibility_horizon_days_nonnegative') THEN
    ALTER TABLE plants ADD CONSTRAINT plants_visibility_horizon_days_nonnegative
      CHECK (visibility_horizon_days IS NULL OR visibility_horizon_days >= 0);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_horizon_roll_hour_utc_range') THEN
    ALTER TABLE plants ADD CONSTRAINT plants_horizon_roll_hour_utc_range
      CHECK (horizon_roll_hour_utc >= 0 AND horizon_roll_hour_utc <= 23);
  END IF;
END $$;
-- Workstream C2 (2026-08-20): plant-level frozen horizon — the near-term
-- window (same anchor-day/UTC-roll-hour clock as visibility_horizon_days
-- above, via db.compute_frozen_horizon_end / db._horizon_boundary_core)
-- inside which the optimizer may not place or move any order (an order is frozen when its planned FINISH falls inside it, since 2026-10-27). UNLIKE
-- visibility_horizon_days, NULL *and* 0 both mean "off" — a 0-day frozen
-- window is meaningless, so it must disable the feature outright rather than
-- resolve to a same-instant boundary. Deliberately unregistered (no
-- column_metadata row), same as its horizon siblings above — never appears
-- in the generic Master Data grid; changed only through the validated
-- POST /master-data/plants/{plant}/frozen-horizon-days route. See
-- docs/multi_change_spec_08.20.26.md's C2 section.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS frozen_horizon_days INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_frozen_horizon_days_nonnegative') THEN
    ALTER TABLE plants ADD CONSTRAINT plants_frozen_horizon_days_nonnegative
      CHECK (frozen_horizon_days IS NULL OR frozen_horizon_days >= 0);
  END IF;
END $$;
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

CREATE TABLE IF NOT EXISTS machine (
    subnetwork       TEXT NOT NULL,
    plant            TEXT NOT NULL,
    machine          TEXT NOT NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, machine),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lines_plant ON machine(subnetwork, plant);
-- Plant-only index: the stateless /tasks join filters by plant alone, which the
-- composite above (subnetwork-leading) can't serve efficiently.
CREATE INDEX IF NOT EXISTS idx_lines_plant_only ON machine(plant);
-- Machine-code index: the order->plant derivation (ingest, backfill, re-attribution)
-- looks up machine by machine alone, which the subnetwork-leading
-- composite PK cannot serve efficiently.
CREATE INDEX IF NOT EXISTS idx_lines_machine ON machine(machine);

-- ----------------------------------------------------------------------------
-- machine_key: stable, human-readable composite identity string for a
-- machine, e.g. "HMF_5512_LINE01". GENERATED so it can never drift from the
-- natural PK (subnetwork, plant, machine) — never write to it
-- directly, and never register it in column_metadata (it would make the
-- Add-Column wizard / export_schema_sql / bulk_apply try to write a value
-- into a generated column, which Postgres rejects outright).
-- Soft reference only: indexed for identity/joins, NOT a hard FK from
-- orders/labor_plan_machine/machine_calendar/machine_blackout — those tables can
-- reference a plant+machine combo before it's registered here, same as today.
-- Must precede the orders.plant/machine_key blocks below in file order: the
-- orders.machine_key backfill selects this column, so it has to exist first.
-- ----------------------------------------------------------------------------
ALTER TABLE machine DROP COLUMN IF EXISTS line_key;
DROP INDEX IF EXISTS uq_lines_line_key;
ALTER TABLE machine ADD COLUMN IF NOT EXISTS machine_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS uq_machine_machine_key ON machine(machine_key);

-- ----------------------------------------------------------------------------
-- workcenter_mapping: per-plant mapping of a NIMBUS machine to its SAP
-- workcenter code. No FK to machine/plants — soft reference by convention,
-- same as material_plants.default_machine and the other plant-scoped tables
-- above; a mapping may exist for an order-derived machine that lags master
-- data.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workcenter_mapping (
    plant           TEXT NOT NULL,
    machine         TEXT NOT NULL,
    sap_workcenter  TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, machine)
);

-- column_metadata: display labels + whether a column is a locked key column.
-- System columns (created_at, updated_at) are never inserted here — the
-- backend filters them out before returning column lists to the UI.
-- Moved here (was originally declared much further down, after several
-- INSERT INTO column_metadata statements that ran before it — a fresh-
-- bootstrap "relation does not exist" regression caught by
-- scripts/schema_bootstrap_smoke.py) so every later INSERT INTO
-- column_metadata in this file has the table available.
CREATE TABLE IF NOT EXISTS column_metadata (
    table_name      TEXT NOT NULL,
    column_name     TEXT NOT NULL,
    display_label   TEXT NOT NULL,
    is_locked       BOOLEAN NOT NULL DEFAULT FALSE,
    column_order    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (table_name, column_name)
);

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('workcenter_mapping', 'plant',          'Plant',            TRUE,  1),
    ('workcenter_mapping', 'machine',        'Machine',          TRUE,  2),
    ('workcenter_mapping', 'sap_workcenter', 'SAP Workcenter',   FALSE, 3)
ON CONFLICT (table_name, column_name) DO NOTHING;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('sap_workcenter', 'plant',             'Plant',               TRUE,  1),
    ('sap_workcenter', 'sap_workcenter',    'SAP Work Center',     TRUE,  2),
    ('sap_workcenter', 'description',       'Description',         FALSE, 3),
    ('sap_workcenter', 'distribution_mode', 'Distribution Mode',   FALSE, 4),
    ('sap_workcenter', 'default_machine',   'Default Machine',     FALSE, 5),
    ('sap_workcenter', 'max_separation',    'Max Separation',      FALSE, 6),
    ('sap_workcenter', 'review_required',   'Review Required',     FALSE, 7),
    ('sap_workcenter', 'distribute_tooled', 'Distribute Tooled',   FALSE, 8)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Routing & Production Version — data-model foundation for computing
-- orders.run_time from routings/production versions (ROUTING_RUNTIME_DESIGN.md
-- §3, migrations/2026-09-24-routing-production-version-structure.sql).
-- production_version: one row per (plant, material, production version) —
-- the repetitive-manufacturing routing link. There is no production-order
-- concept in NIMBUS; this table and routing_operation are the whole of
-- "routing" as NIMBUS understands it.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_version (
    plant                    TEXT        NOT NULL,
    material_id              VARCHAR(18) NOT NULL,
    production_version       VARCHAR(4)  NOT NULL,
    valid_from               DATE,
    valid_to                 DATE,
    alternative_bom          VARCHAR(2),   -- carried as delivered; not used in the calculation
    bom_usage                VARCHAR(1),   -- carried as delivered; not used in the calculation
    task_list_type           VARCHAR(1),   -- identifies which routing this version uses
    routing_group            VARCHAR(8),   -- together with task_list_type + group_counter
    group_counter            VARCHAR(2),   -- (see routing_operation's own key below)
    procurement_type         VARCHAR(1),   -- carried as delivered; not used in the calculation
    special_procurement_type VARCHAR(2),   -- carried as delivered; not used in the calculation
    costing_lot_size         NUMERIC(13,3), -- carried as delivered; not used in the calculation
    sap_workcenter           TEXT,         -- the work center this version nominally runs at
    production_version_text  VARCHAR(40),
    repetitive_mfg           BOOLEAN NOT NULL DEFAULT FALSE,
    -- Lot-size range is a warning only — never a hold, never a routing choice.
    lot_size_from            NUMERIC(13,3),
    lot_size_to              NUMERIC(13,3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, material_id, production_version)
);
CREATE INDEX IF NOT EXISTS idx_pv_routing_key
    ON production_version (plant, task_list_type, routing_group, group_counter);

-- routing_operation: one row per operation of one routing, for one material.
-- `group` is a reserved word in Postgres, so the column is routing_group
-- everywhere in this design.
CREATE TABLE IF NOT EXISTS routing_operation (
    plant                 TEXT        NOT NULL,
    material_id           VARCHAR(18) NOT NULL,
    task_list_type        VARCHAR(1)  NOT NULL,   -- a routing is only unique together
    routing_group         VARCHAR(8)  NOT NULL,   -- with its type, so it's in the key
    group_counter         VARCHAR(2)  NOT NULL,
    sequence_no           VARCHAR(6)  NOT NULL DEFAULT '0',
    activity               VARCHAR(4)  NOT NULL,   -- the operation number within the routing
    sap_workcenter        TEXT,                    -- where this operation runs
    -- 0001 = Machine, 0003 = Labor. Fixed logic reads this value and picks
    -- the matching value/unit pair below; any other category is skipped.
    workcenter_category   VARCHAR(4),
    base_quantity         NUMERIC(13,3),
    control_key           VARCHAR(4),
    operation_text        VARCHAR(40),
    operation_unit        VARCHAR(3),
    activity_type_machine VARCHAR(6), std_value_machine NUMERIC(9,3), std_value_unit_machine VARCHAR(3),
    activity_type_labor   VARCHAR(6), std_value_labor NUMERIC(9,3), std_value_unit_labor VARCHAR(3),
    required_overlap      BOOLEAN NOT NULL DEFAULT FALSE,
    optional_overlap      BOOLEAN NOT NULL DEFAULT FALSE,
    required_split        BOOLEAN NOT NULL DEFAULT FALSE,
    field_key             VARCHAR(7),
    num_splits            INTEGER,
    task_list_text        VARCHAR(40),
    sequence_category     VARCHAR(1) NOT NULL DEFAULT '0',  -- '0' = standard sequence
    sequence_text          VARCHAR(40),
    num_employees          NUMERIC(5,2),   -- stored, never used in the calculation
    setup_group_category   VARCHAR(6),
    setup_group_key        VARCHAR(6),
    deleted                BOOLEAN NOT NULL DEFAULT FALSE,
    header_status          VARCHAR(3),
    header_valid_from      DATE,
    header_valid_to        DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, material_id, task_list_type, routing_group, group_counter, sequence_no, activity)
);
CREATE INDEX IF NOT EXISTS idx_routing_op_lookup
    ON routing_operation (plant, task_list_type, routing_group, group_counter, sap_workcenter);

-- routing_rules (per plant): only two kinds of rule exist. Which time an
-- operation contributes (machine or labor) is fixed logic read from the
-- operation's own category — it is never a rule here.
CREATE TABLE IF NOT EXISTS routing_rules (
    plant     TEXT NOT NULL,
    rule_kind TEXT NOT NULL CHECK (rule_kind IN ('control_key','header_status')),
    code      TEXT NOT NULL,
    action    TEXT NOT NULL CHECK (action IN ('exclude','include')),
    note      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, rule_kind, code)
);

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('production_version', 'plant',                    'Plant',                     TRUE,  1),
    ('production_version', 'material_id',               'Material',                  TRUE,  2),
    ('production_version', 'production_version',        'Production Version',        TRUE,  3),
    ('production_version', 'valid_from',                 'Valid From',                FALSE, 4),
    ('production_version', 'valid_to',                   'Valid To',                  FALSE, 5),
    ('production_version', 'alternative_bom',            'Alternative BOM',           FALSE, 6),
    ('production_version', 'bom_usage',                  'BOM Usage',                 FALSE, 7),
    ('production_version', 'task_list_type',             'Task List Type',            FALSE, 8),
    ('production_version', 'routing_group',               'Group',                     FALSE, 9),
    ('production_version', 'group_counter',               'Group Counter',             FALSE, 10),
    ('production_version', 'procurement_type',           'Procurement Type',          FALSE, 11),
    ('production_version', 'special_procurement_type',   'Special Procurement Type',  FALSE, 12),
    ('production_version', 'costing_lot_size',           'Costing Lot Size',          FALSE, 13),
    ('production_version', 'sap_workcenter',              'SAP Work Center',           FALSE, 14),
    ('production_version', 'production_version_text',    'Description',               FALSE, 15),
    ('production_version', 'repetitive_mfg',              'Repetitive Mfg',            FALSE, 16),
    ('production_version', 'lot_size_from',               'Lot Size From',             FALSE, 17),
    ('production_version', 'lot_size_to',                 'Lot Size To',               FALSE, 18)
ON CONFLICT (table_name, column_name) DO NOTHING;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('routing_operation', 'plant',                 'Plant',                     TRUE,  1),
    ('routing_operation', 'material_id',            'Material',                  TRUE,  2),
    ('routing_operation', 'task_list_type',         'Task List Type',            TRUE,  3),
    ('routing_operation', 'routing_group',           'Group',                     TRUE,  4),
    ('routing_operation', 'group_counter',           'Group Counter',             TRUE,  5),
    ('routing_operation', 'sequence_no',             'Sequence No',               TRUE,  6),
    ('routing_operation', 'activity',                'Operation',                 TRUE,  7),
    ('routing_operation', 'sap_workcenter',          'SAP Work Center',           FALSE, 8),
    ('routing_operation', 'workcenter_category',     'Work Center Category',      FALSE, 9),
    ('routing_operation', 'base_quantity',           'Base Quantity',             FALSE, 10),
    ('routing_operation', 'control_key',             'Control Key',               FALSE, 11),
    ('routing_operation', 'operation_text',          'Operation Description',     FALSE, 12),
    ('routing_operation', 'operation_unit',          'Operation Unit',            FALSE, 13),
    ('routing_operation', 'activity_type_machine',   'Activity Type (Machine)',   FALSE, 14),
    ('routing_operation', 'std_value_machine',       'Std Value (Machine)',       FALSE, 15),
    ('routing_operation', 'std_value_unit_machine',  'Std Value Unit (Machine)',  FALSE, 16),
    ('routing_operation', 'activity_type_labor',     'Activity Type (Labor)',     FALSE, 17),
    ('routing_operation', 'std_value_labor',         'Std Value (Labor)',         FALSE, 18),
    ('routing_operation', 'std_value_unit_labor',    'Std Value Unit (Labor)',    FALSE, 19),
    ('routing_operation', 'required_overlap',        'Required Overlap',         FALSE, 20),
    ('routing_operation', 'optional_overlap',        'Optional Overlap',          FALSE, 21),
    ('routing_operation', 'required_split',           'Required Split',           FALSE, 22),
    ('routing_operation', 'field_key',                'Field Key',                FALSE, 23),
    ('routing_operation', 'num_splits',               'Number of Splits',         FALSE, 24),
    ('routing_operation', 'task_list_text',           'Task List Description',    FALSE, 25),
    ('routing_operation', 'sequence_category',         'Sequence Category',        FALSE, 26),
    ('routing_operation', 'sequence_text',             'Sequence Description',     FALSE, 27),
    ('routing_operation', 'num_employees',             'Number of Employees',      FALSE, 28),
    ('routing_operation', 'setup_group_category',      'Setup Group Category',     FALSE, 29),
    ('routing_operation', 'setup_group_key',           'Setup Group Key',          FALSE, 30),
    ('routing_operation', 'deleted',                    'Deleted',                  FALSE, 31),
    ('routing_operation', 'header_status',              'Header Status',            FALSE, 32),
    ('routing_operation', 'header_valid_from',          'Header Valid From',        FALSE, 33),
    ('routing_operation', 'header_valid_to',            'Header Valid To',          FALSE, 34)
ON CONFLICT (table_name, column_name) DO NOTHING;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('routing_rules', 'plant',     'Plant',     TRUE,  1),
    ('routing_rules', 'rule_kind', 'Rule Kind', TRUE,  2),
    ('routing_rules', 'code',      'Code',      TRUE,  3),
    ('routing_rules', 'action',    'Action',    FALSE, 4),
    ('routing_rules', 'note',      'Note',      FALSE, 5)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- tool_inventory (per plant): how many physical copies of each tool id (PRT 1 / PRT 2
-- production resource tool) the plant owns. A tool id is a TYPE; the plant owns several
-- interchangeable copies. A tool with no row here counts as 1 copy. Available copies =
-- total_qty - out_of_service_qty (qty 0 = unavailable). tool_id is stored trimmed and
-- upper-cased (the /tasks wire upper-cases PRT values, so a mixed-case id would never match).
-- No plant FK on purpose (same posture as schedule_event). To fix a typo in a tool id, remove
-- the row and re-add it in one save: the id is part of the key and is never renamed in place.
-- Mirrors migrations/2026-10-27-1-tool-inventory.sql and master_data.ensure_tool_inventory_table().
CREATE TABLE IF NOT EXISTS tool_inventory (
    plant              TEXT NOT NULL,
    tool_id            TEXT NOT NULL,
    total_qty          INTEGER NOT NULL DEFAULT 1,
    out_of_service_qty INTEGER NOT NULL DEFAULT 0,
    note               TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, tool_id),
    CONSTRAINT chk_tool_inventory_total CHECK (total_qty >= 0),
    CONSTRAINT chk_tool_inventory_qty   CHECK (out_of_service_qty >= 0 AND out_of_service_qty <= total_qty),
    CONSTRAINT chk_tool_inventory_id    CHECK (tool_id = upper(btrim(tool_id)) AND tool_id <> '')
);

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('tool_inventory', 'plant',              'Plant',           TRUE,  1),
    ('tool_inventory', 'tool_id',            'Tool ID',         TRUE,  2),
    ('tool_inventory', 'total_qty',          'Total Inventory', FALSE, 3),
    ('tool_inventory', 'out_of_service_qty', 'Out of Service',  FALSE, 4),
    ('tool_inventory', 'note',               'Note',            FALSE, 5)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- orders.plant backfill — the column itself is now added immediately after
-- CREATE TABLE orders (see above) so bootstrap-order dependents (e.g.
-- idx_orders_plant_eff_start) never hit "column does not exist". The indexes
-- and backfill below stay here because they depend on the machine table
-- (created above, well before this point). The /tasks read path now selects
-- o.plant directly instead of LEFT JOINing machine on the machine code alone,
-- which fanned out / mis-attributed orders when a machine code is reused across plants.
-- Ingest sets plant from a WERKS/PLANT upload column when present, else derives it from
-- the machine→plant mapping (db.ingest_orders_from_excel). Idempotent: ADD COLUMN IF NOT
-- EXISTS + a NULL-only backfill, safe to re-run.
--   ⚠ Re-run schema.sql after deploying this change, or GET /tasks errors on the
--     missing orders.plant column (the read path references o.plant). See MIGRATION.md.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_plant ON orders(plant);
-- Partial index: the post-machine-change re-attribution and ingest derivation scan
-- orders WHERE plant IS NULL; a plain btree won't serve IS NULL efficiently, so
-- index just the NULL-plant rows by machine (kept tiny — most rows are attributed).
CREATE INDEX IF NOT EXISTS idx_orders_plant_null ON orders(machine) WHERE plant IS NULL;
-- Only derive plant when the machine code maps to EXACTLY ONE plant. A machine code shared
-- across plants cannot be attributed from the code alone, so those rows are left NULL
-- (the app surfaces this) instead of being silently assigned to the lowest plant code.
UPDATE orders o
   SET plant = (
       SELECT MIN(pl.plant) FROM machine pl
        WHERE pl.machine = o.machine
   )
 WHERE o.plant IS NULL
   AND (
       SELECT COUNT(DISTINCT pl.plant) FROM machine pl
        WHERE pl.machine = o.machine
   ) = 1;

-- ----------------------------------------------------------------------------
-- orders.machine_key — soft-reference identity string mirroring machine.
-- machine_key. Plain TEXT (not generated — orders has no subnetwork column, and
-- adding one would be redundant; plant is already enforced ~globally unique
-- via ensure_unique_plant(), so a (plant, machine) lookup against
-- machine is sufficient). Populated by copying machine.
-- machine_key for the matching (plant, machine) pair. Kept in sync by
-- db.py (ingest upsert CASE + reattribution), not by the DB.
-- Strictly downstream of orders.plant: a machine code ambiguous across >1 plant
-- (left plant NULL above) stays machine_key NULL too — this does not resolve
-- that pre-existing ambiguity, it inherits it (see MIGRATION.md).
-- ----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS machine_key TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_machine_key ON orders(machine_key);
CREATE INDEX IF NOT EXISTS idx_orders_machine_key_null ON orders(machine, plant) WHERE machine_key IS NULL;

UPDATE orders o
   SET machine_key = (
       SELECT pl.machine_key FROM machine pl
        WHERE pl.plant = o.plant AND pl.machine = o.machine
   )
 WHERE o.machine_key IS NULL
   AND o.plant IS NOT NULL
   AND (
       SELECT COUNT(*) FROM machine pl
        WHERE pl.plant = o.plant AND pl.machine = o.machine
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
-- Workcenter Group column (added via Admin DDL; schema.sql ensures it
-- survives a fresh-DB migration without requiring a manual ALTER TABLE).
-- ----------------------------------------------------------------------------
ALTER TABLE machine ADD COLUMN IF NOT EXISTS wc_group TEXT;
INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order)
VALUES ('machine', 'wc_group', 'Workcenter Group', FALSE, 4)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Optimizer-flag columns (added via Admin DDL at some point; the physical
-- columns and/or their column_metadata rows never made it into schema.sql,
-- so `list_rows`'s INNER JOIN against column_metadata silently hid them from
-- GET /master-data/machine — the ProdLines "Bottleneck"/"Excl.
-- Optimizer" checkboxes therefore reset to unchecked on every master-data
-- reload even after being toggled. ADD COLUMN IF NOT EXISTS covers the case
-- where the physical column is already there; the INSERT closes the metadata
-- gap either way.
-- ----------------------------------------------------------------------------
ALTER TABLE machine ADD COLUMN IF NOT EXISTS bottleneck      TEXT;
ALTER TABLE machine ADD COLUMN IF NOT EXISTS excl_optimizer  TEXT;
ALTER TABLE machine ADD COLUMN IF NOT EXISTS buffer_type     TEXT;
ALTER TABLE machine ADD COLUMN IF NOT EXISTS buffer_percent  NUMERIC;
ALTER TABLE machine ADD COLUMN IF NOT EXISTS buffer_hours    NUMERIC;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('machine', 'bottleneck',     'Bottleneck',             FALSE, 5),
    ('machine', 'excl_optimizer', 'Exclude from Optimizer', FALSE, 6),
    ('machine', 'buffer_type',    'Buffer Type',            FALSE, 7),
    ('machine', 'buffer_percent', 'Buffer %',               FALSE, 8),
    ('machine', 'buffer_hours',   'Buffer Hours',           FALSE, 9)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Order Distribution columns (2026-09-17): SAP work center link and weight.
-- sap_workcenter: one work center per machine (soft ref to sap_workcenter table).
-- distribution_weight: relative weight in work-center distribution; NULL = even
-- (with all other members NULL) or 0 (some member has weight). Enforced at
-- Work Centers tab route; hard FK on (plant, sap_workcenter).
-- ----------------------------------------------------------------------------
ALTER TABLE machine ADD COLUMN IF NOT EXISTS sap_workcenter      TEXT;
ALTER TABLE machine ADD COLUMN IF NOT EXISTS distribution_weight NUMERIC
    CHECK (distribution_weight IS NULL OR distribution_weight >= 0);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_machine_sap_workcenter') THEN
        ALTER TABLE machine ADD CONSTRAINT fk_machine_sap_workcenter
            FOREIGN KEY (plant, sap_workcenter) REFERENCES sap_workcenter (plant, sap_workcenter)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_machine_sap_workcenter ON machine(plant, sap_workcenter);
INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('machine', 'sap_workcenter',      'SAP Work Center',     FALSE, 10),
    ('machine', 'distribution_weight', 'Distribution Weight', FALSE, 11)
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
-- idx_lines_plant_only on machine above. Composite (plant,
-- material_id) rather than plant-only: it also satisfies the grid's
-- ORDER BY material_id within a plant, and lets the Material grid's
-- EXISTS(...) semi-join run as an index-only probe.
-- (idx_material_plants_material above is redundant with the PK's left prefix
-- but is left in place — dropping it is an unrelated cleanup, not bundled here.)
CREATE INDEX IF NOT EXISTS idx_material_plants_plant_material
    ON material_plants(plant, material_id);

-- ----------------------------------------------------------------------------
-- material_plants.default_machine — same drift-repair pattern as prt_01/
-- prt_02/color above: added directly to schema.sql + a standalone migration
-- (migrations/2026-08-10-material-plant-default-workcenter.sql) rather than
-- via the Add Column wizard, to avoid the same backfill gap. Editable
-- through POST /master-data/material-plants/attributes alongside
-- prt_01/prt_02/color (master_data.EDITABLE_MATERIAL_PLANT_ATTRS).
-- No FK to machine — soft reference by convention, matching the other
-- material_plants attribute columns.
-- ----------------------------------------------------------------------------
ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS default_machine TEXT;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('material_plants', 'default_machine', 'Default Machine', FALSE, 11)
ON CONFLICT (table_name, column_name) DO NOTHING;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('plants', 'description',   'Description',     FALSE, 5),
    ('plants', 'product_focus', 'Product Focus',   FALSE, 6),
    ('plants', 'timezone',      'Timezone (IANA)', FALSE, 7)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- 2026-08-21: expose setup_active, visibility_horizon_days and
-- horizon_roll_hour_utc as editable Manage Data Tables grid columns. Verbatim
-- copies in migrations/2026-08-21-plants-grid-visibility.sql (first two) and
-- migrations/2026-08-21-plants-grid-roll-hour.sql (the third, added once the
-- Scheduling Rules pane's rows for all three were removed and the grid became
-- their only editable surface).
INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('plants', 'setup_active',            'Setup-Aware Optimization',  FALSE, 8),
    ('plants', 'visibility_horizon_days', 'Visibility Horizon (days)', FALSE, 9),
    ('plants', 'horizon_roll_hour_utc',   'Roll-Forward Hour (UTC)',   FALSE, 10)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- 2026-09-24: expose routing_runtime_enabled as an editable Manage Data
-- Tables grid column (ROUTING_RUNTIME_DESIGN.md §3.6, D14). Verbatim copy in
-- migrations/2026-09-24-routing-production-version-structure.sql.
INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('plants', 'routing_runtime_enabled', 'Routing Runtime Enabled', FALSE, 11)
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
    ('machine',            'subnetwork',                    'Subnetwork',                   TRUE,  1),
    ('machine',            'plant',                         'Plant',                        TRUE,  2),
    ('machine',            'machine',                       'Machine',                      TRUE,  3),
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
-- Labor Planning — aggregate available labor hours by workcenter group × ISO week
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_plan (
    subnetwork  TEXT    NOT NULL,
    plant       TEXT    NOT NULL,
    wc_group    TEXT    NOT NULL,
    period      TEXT    NOT NULL,   -- ISO week key: 'YYYY-Www'
    avail_hours NUMERIC,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, wc_group, period),
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

-- Labor Plan Machine — available labor hours per machine per calendar day
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_plan_machine (
    subnetwork      TEXT    NOT NULL,
    plant           TEXT    NOT NULL,
    machine         TEXT    NOT NULL,
    day             TEXT    NOT NULL,   -- ISO date 'YYYY-MM-DD'
    avail_hours     NUMERIC,
    source          TEXT    NOT NULL DEFAULT 'auto_split',  -- 'auto_split'|'calendar'|'override'
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, machine, day)
);
CREATE INDEX IF NOT EXISTS idx_labor_plan_machine_plant ON labor_plan_machine(plant);
CREATE INDEX IF NOT EXISTS idx_labor_plan_machine_plant_machine ON labor_plan_machine(plant, machine);
-- machine_key: same generated identity string as machine.machine_key (see
-- above). This table already carries its own subnetwork/plant/machine,
-- so it self-populates on ALTER — no lookup/backfill needed. NOT a startup-hook
-- table for this column: schema.sql only reaches a pre-existing prod DB once at
-- provisioning (see master_data.py's ensure_machine_key_columns() for the
-- redeploy-safe path that also covers this table).
ALTER TABLE labor_plan_machine DROP COLUMN IF EXISTS line_key;
DROP INDEX IF EXISTS idx_lpl_line_key;
ALTER TABLE labor_plan_machine ADD COLUMN IF NOT EXISTS machine_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED;
CREATE INDEX IF NOT EXISTS idx_lpl_machine_key ON labor_plan_machine(machine_key);

-- ----------------------------------------------------------------------------
-- Plant / machine calendars (working hours) + blackout blocks
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

-- Machine-level working hours. No FK to machine (like labor_plan_machine) so
-- order-derived machines that lag master data still persist; only the plants FK.
CREATE TABLE IF NOT EXISTS machine_calendar (
    subnetwork      TEXT NOT NULL,
    plant           TEXT NOT NULL,
    machine         TEXT NOT NULL,
    work_hours      JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, machine),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_machine_calendar_plant ON machine_calendar(plant);
-- machine_key: same generated identity string as machine.machine_key.
-- See master_data.py's ensure_machine_key_columns() for the redeploy-safe path
-- (this table is startup-hook-authoritative for prod, not schema.sql).
ALTER TABLE machine_calendar DROP COLUMN IF EXISTS line_key;
DROP INDEX IF EXISTS idx_line_calendar_line_key;
ALTER TABLE machine_calendar ADD COLUMN IF NOT EXISTS machine_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS uq_machine_calendar_machine_key ON machine_calendar(machine_key);

-- Machine blackout blocks. machine NULL = all machines in this plant.
-- block_id is client-supplied (Util.uid 'blk'). Delta writes only.
CREATE TABLE IF NOT EXISTS machine_blackout (
    subnetwork      TEXT      NOT NULL,
    plant           TEXT      NOT NULL,
    machine         TEXT,
    block_id        TEXT      NOT NULL,
    start_ts        TIMESTAMP NOT NULL,
    end_ts          TIMESTAMP NOT NULL,
    reason          TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, block_id),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT chk_machine_blackout_range CHECK (end_ts > start_ts)
);
CREATE INDEX IF NOT EXISTS idx_machine_blackout_plant ON machine_blackout(plant);
-- machine_key: same generated identity string as machine.machine_key.
-- machine is nullable here (NULL = all machines in plant) — '||'
-- propagates NULL automatically, so machine_key correctly comes out NULL for
-- plant-wide blocks with no special-casing. See master_data.py's
-- ensure_machine_key_columns() for the redeploy-safe path (startup-hook table).
-- NOTE: unlike machine/machine_calendar, this index is deliberately NOT unique
-- (kept as the original non-unique index, just renamed) — machine_blackout's
-- real PK is (subnetwork, plant, block_id), and multiple blackout blocks
-- legitimately share one machine (or share machine IS NULL for plant-wide
-- blocks), so a UNIQUE index on machine_key would reject that valid case.
ALTER TABLE machine_blackout DROP COLUMN IF EXISTS line_key;
DROP INDEX IF EXISTS idx_line_blackout_line_key;
ALTER TABLE machine_blackout ADD COLUMN IF NOT EXISTS machine_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED;
CREATE INDEX IF NOT EXISTS idx_machine_blackout_machine_key ON machine_blackout(machine_key);

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

-- Effective-dated plant calendar periods: each overrides plants.work_hours for an inclusive
-- date range (valid_to NULL = no end). Non-overlap is enforced by the write function.
CREATE TABLE IF NOT EXISTS plant_calendar_period (
    subnetwork  TEXT      NOT NULL,
    plant       TEXT      NOT NULL,
    period_id   TEXT      NOT NULL,
    name        TEXT      NOT NULL DEFAULT '',
    valid_from  DATE      NOT NULL,
    valid_to    DATE,
    work_hours  JSONB     NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, period_id),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT chk_plant_calendar_period_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
    CONSTRAINT chk_plant_calendar_period_hours CHECK (jsonb_typeof(work_hours) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_plant_calendar_period_plant ON plant_calendar_period(plant, valid_from);

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
    ('machine',           'subnetwork',      'Subnetwork',      TRUE,  1),
    ('machine',           'plant',           'Plant',           TRUE,  2),
    ('machine',           'machine',         'Machine',         TRUE,  3),
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
    ('material_plants',  'incremental_lot_size',       'Rounding Value',               FALSE, 7),
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
    ('machine',          'file_drop'),
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
    ('orders', 'GAMNG', 'order_quantity',       'decimal',     5),
    ('orders', 'ARBPL', 'machine',              'none',        6),
    ('orders', 'WERKS', 'plant',                'none',        7)
ON CONFLICT (object_key, sap_field) DO NOTHING;

-- ----------------------------------------------------------------------------
-- SAP staging (2026-10-08): mirrors migrations/2026-10-08-sap-staging-tables.sql
-- and migrations/2026-10-08-sap-staging-columns.sql. Design: docs/SAP_STAGING_DESIGN.md
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sap_stage_batch (
    batch_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_key         TEXT NOT NULL,
    plant              TEXT NOT NULL,
    source             TEXT NOT NULL CHECK (source IN ('mulesoft','upload')),
    status             TEXT NOT NULL DEFAULT 'loading' CHECK (status IN ('loading','ready','validated','held','applying','applied','error','rejected','superseded','discarded')),
    row_count_expected INTEGER,
    received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ready_at           TIMESTAMPTZ,
    validated_at       TIMESTAMPTZ,
    applied_at         TIMESTAMPTZ,
    applied_by         TEXT,
    created_by         TEXT,
    counts             JSONB NOT NULL DEFAULT '{}'::jsonb,
    warnings           JSONB NOT NULL DEFAULT '[]'::jsonb,
    error              TEXT
);
CREATE INDEX IF NOT EXISTS idx_sap_stage_batch_lookup ON sap_stage_batch (object_key, plant, status, received_at DESC);

CREATE TABLE IF NOT EXISTS sap_stage_material_plant (
    id            BIGSERIAL PRIMARY KEY,
    batch_id      UUID NOT NULL REFERENCES sap_stage_batch(batch_id) ON DELETE CASCADE,
    row_status    TEXT NOT NULL DEFAULT 'new' CHECK (row_status IN ('new','valid','rejected','applied','superseded')),
    reject_reason TEXT,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at    TIMESTAMPTZ,
    matnr                    TEXT,
    werks                    TEXT,
    mmsta                    TEXT,
    webaz                    NUMERIC(3,0),
    verkz                    TEXT,
    stlal                    TEXT,
    stlan                    TEXT,
    plnnr                    TEXT,
    aplal                    TEXT,
    minls                    NUMERIC(13,3),
    ltinc                    NUMERIC(13,3),
    zz_subnet                TEXT,
    sauft                    TEXT,
    material_id              TEXT,
    plant                    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sap_stage_material_plant_batch ON sap_stage_material_plant (batch_id, row_status);

CREATE TABLE IF NOT EXISTS sap_stage_planned_order (
    id            BIGSERIAL PRIMARY KEY,
    batch_id      UUID NOT NULL REFERENCES sap_stage_batch(batch_id) ON DELETE CASCADE,
    row_status    TEXT NOT NULL DEFAULT 'new' CHECK (row_status IN ('new','valid','rejected','applied','superseded')),
    reject_reason TEXT,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at    TIMESTAMPTZ,
    plnum                    TEXT,
    mdv01                    TEXT,
    psttr                    TEXT,
    pedtr                    TEXT,
    gsmng                    NUMERIC(13,3),
    matnr                    TEXT,
    verid                    TEXT,
    prvbe                    TEXT,
    plwrk                    TEXT,
    paart                    TEXT,
    umskz                    TEXT,
    auffx                    TEXT,
    kdauf                    TEXT,
    rsnum                    TEXT,
    stlan                    TEXT,
    stalt                    TEXT,
    abmng                    NUMERIC(13,3),
    pstti                    TEXT,
    pedti                    TEXT,
    knttp                    TEXT,
    vfmng                    NUMERIC(13,3),
    gsbtr                    TEXT,
    kzavc                    TEXT,
    badi                     TEXT,
    dac_creation_date        TEXT,
    production_order         TEXT,
    material_id              TEXT,
    plant                    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sap_stage_planned_order_batch ON sap_stage_planned_order (batch_id, row_status);

CREATE TABLE IF NOT EXISTS sap_stage_production_version (
    id            BIGSERIAL PRIMARY KEY,
    batch_id      UUID NOT NULL REFERENCES sap_stage_batch(batch_id) ON DELETE CASCADE,
    row_status    TEXT NOT NULL DEFAULT 'new' CHECK (row_status IN ('new','valid','rejected','applied','superseded')),
    reject_reason TEXT,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at    TIMESTAMPTZ,
    plant                    TEXT,
    material_id              VARCHAR(18),
    production_version       VARCHAR(4),
    valid_from               DATE,
    valid_to                 DATE,
    alternative_bom          VARCHAR(2),
    bom_usage                VARCHAR(1),
    task_list_type           VARCHAR(1),
    routing_group            VARCHAR(8),
    group_counter            VARCHAR(2),
    procurement_type         VARCHAR(1),
    special_procurement_type VARCHAR(2),
    costing_lot_size         NUMERIC(13,3),
    sap_workcenter           TEXT,
    production_version_text  VARCHAR(40),
    repetitive_mfg           BOOLEAN,
    lot_size_from            NUMERIC(13,3),
    lot_size_to              NUMERIC(13,3)
);
CREATE INDEX IF NOT EXISTS idx_sap_stage_production_version_batch ON sap_stage_production_version (batch_id, row_status);

CREATE TABLE IF NOT EXISTS sap_stage_routing_operation (
    id            BIGSERIAL PRIMARY KEY,
    batch_id      UUID NOT NULL REFERENCES sap_stage_batch(batch_id) ON DELETE CASCADE,
    row_status    TEXT NOT NULL DEFAULT 'new' CHECK (row_status IN ('new','valid','rejected','applied','superseded')),
    reject_reason TEXT,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at    TIMESTAMPTZ,
    plant                    TEXT,
    material_id              VARCHAR(18),
    task_list_type           VARCHAR(1),
    routing_group            VARCHAR(8),
    group_counter            VARCHAR(2),
    sequence_no              VARCHAR(6),
    activity                 VARCHAR(4),
    sap_workcenter           TEXT,
    workcenter_category      VARCHAR(4),
    base_quantity            NUMERIC(13,3),
    control_key              VARCHAR(4),
    operation_text           VARCHAR(40),
    operation_unit           VARCHAR(3),
    activity_type_machine    VARCHAR(6),
    std_value_machine        NUMERIC(9,3),
    std_value_unit_machine   VARCHAR(3),
    activity_type_labor      VARCHAR(6),
    std_value_labor          NUMERIC(9,3),
    std_value_unit_labor     VARCHAR(3),
    required_overlap         BOOLEAN,
    optional_overlap         BOOLEAN,
    required_split           BOOLEAN,
    field_key                VARCHAR(7),
    num_splits               INTEGER,
    task_list_text           VARCHAR(40),
    sequence_category        VARCHAR(1),
    sequence_text            VARCHAR(40),
    num_employees            NUMERIC(5,2),
    setup_group_category     VARCHAR(6),
    setup_group_key          VARCHAR(6),
    deleted                  BOOLEAN,
    header_status            VARCHAR(3),
    header_valid_from        DATE,
    header_valid_to          DATE
);
CREATE INDEX IF NOT EXISTS idx_sap_stage_routing_operation_batch ON sap_stage_routing_operation (batch_id, row_status);

CREATE TABLE IF NOT EXISTS sap_stage_planned_order_out (
    id               BIGSERIAL PRIMARY KEY,
    send_batch_id    UUID NOT NULL,
    plant            TEXT NOT NULL,
    matnr            TEXT NOT NULL,
    plwrk            TEXT NOT NULL,
    plnum            TEXT NOT NULL,
    verid            TEXT,
    pedtr            DATE,
    pedti            TIME,
    auffx            TEXT,
    row_status       TEXT NOT NULL DEFAULT 'ready' CHECK (row_status IN ('ready','sent','error')),
    queued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    queued_by        TEXT,
    sent_at          TIMESTAMPTZ,
    error_text       TEXT,
    nimbus_order_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sap_stage_planned_order_out_status ON sap_stage_planned_order_out (row_status);
CREATE INDEX IF NOT EXISTS idx_sap_stage_planned_order_out_send_batch ON sap_stage_planned_order_out (send_batch_id);
CREATE INDEX IF NOT EXISTS idx_sap_stage_planned_order_out_plant_status ON sap_stage_planned_order_out (plant, row_status);

CREATE TABLE IF NOT EXISTS sap_stage_vanished_order (
    id           BIGSERIAL PRIMARY KEY,
    batch_id     UUID,
    plant        TEXT NOT NULL,
    order_id     TEXT NOT NULL,
    order_row    JSONB NOT NULL,
    segments     JSONB NOT NULL DEFAULT '[]'::jsonb,
    shares       JSONB NOT NULL DEFAULT '[]'::jsonb,
    deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_by   TEXT,
    restored_at  TIMESTAMPTZ,
    restored_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sap_stage_vanished_order_plant_deleted ON sap_stage_vanished_order (plant, deleted_at DESC);

-- What NIMBUS last sent to SAP per order (D20 echo suppression). A side table, NOT
-- columns on orders: remembering a send must never write an orders row (xmin is the
-- planners' optimistic-concurrency base_version).
CREATE TABLE IF NOT EXISTS order_sap_sent (
    order_id     TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    plant        TEXT NOT NULL,
    sent_finish  TIMESTAMP,
    sent_version TEXT,
    sent_firm    BOOLEAN,
    sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_sap_sent_plant ON order_sap_sent (plant);

-- Seed one disabled config row per inbound staging object
INSERT INTO sap_sync_config (object_key, transport) VALUES
    ('stage_material_plants',    'file_drop'),
    ('stage_planned_orders',     'file_drop'),
    ('stage_production_version', 'file_drop'),
    ('stage_routing_operation',  'file_drop')
ON CONFLICT (object_key) DO NOTHING;

-- Field-map seeds (SAP column -> live column); see docs/SAP_STAGING_DESIGN.md Appendix C
INSERT INTO sap_field_map (object_key, sap_field, nimbus_column, transform, field_order) VALUES
    ('stage_material_plants', 'MATNR', 'material_id', 'alpha_strip', 1),
    ('stage_material_plants', 'WERKS', 'plant', 'none', 2),
    ('stage_material_plants', 'MMSTA', 'status_pl', 'none', 3),
    ('stage_material_plants', 'MINLS', 'min_lot_size', 'decimal', 4),
    ('stage_material_plants', 'LTINC', 'incremental_lot_size', 'decimal', 5),
    ('stage_material_plants', 'ZZ_SUBNET', 'subnetwork', 'none', 6),
    ('stage_planned_orders', 'PLNUM', 'production_order', 'strip_zeros', 1),
    ('stage_planned_orders', 'MATNR', 'material_number', 'alpha_strip', 2),
    ('stage_planned_orders', 'PLWRK', 'plant', 'none', 3),
    ('stage_planned_orders', 'MDV01', 'machine', 'none', 4),
    ('stage_planned_orders', 'PSTTR', 'basic_start_date', 'dats', 5),
    ('stage_planned_orders', 'PSTTI', 'basic_start_time', 'tims', 6),
    ('stage_planned_orders', 'PEDTR', 'basic_finish_date', 'dats', 7),
    ('stage_planned_orders', 'PEDTI', 'basic_finish_time', 'tims', 8),
    ('stage_planned_orders', 'GSMNG', 'order_quantity', 'decimal', 9),
    ('stage_planned_orders', 'ABMNG', 'reduced_quantity', 'decimal', 10),
    ('stage_planned_orders', 'VERID', 'production_version', 'none', 11),
    ('stage_planned_orders', 'AUFFX', 'firming_indicator', 'none', 12),
    ('stage_planned_orders', 'STLAN', 'bom_usage', 'none', 13),
    ('stage_planned_orders', 'STALT', 'bom_alternative', 'none', 14),
    ('stage_production_version', 'PLANT', 'plant', 'none', 1),
    ('stage_production_version', 'MATERIAL_ID', 'material_id', 'none', 2),
    ('stage_production_version', 'PRODUCTION_VERSION', 'production_version', 'none', 3),
    ('stage_production_version', 'VALID_FROM', 'valid_from', 'none', 4),
    ('stage_production_version', 'VALID_TO', 'valid_to', 'none', 5),
    ('stage_production_version', 'ALTERNATIVE_BOM', 'alternative_bom', 'none', 6),
    ('stage_production_version', 'BOM_USAGE', 'bom_usage', 'none', 7),
    ('stage_production_version', 'TASK_LIST_TYPE', 'task_list_type', 'none', 8),
    ('stage_production_version', 'ROUTING_GROUP', 'routing_group', 'none', 9),
    ('stage_production_version', 'GROUP_COUNTER', 'group_counter', 'none', 10),
    ('stage_production_version', 'PROCUREMENT_TYPE', 'procurement_type', 'none', 11),
    ('stage_production_version', 'SPECIAL_PROCUREMENT_TYPE', 'special_procurement_type', 'none', 12),
    ('stage_production_version', 'COSTING_LOT_SIZE', 'costing_lot_size', 'none', 13),
    ('stage_production_version', 'SAP_WORKCENTER', 'sap_workcenter', 'none', 14),
    ('stage_production_version', 'PRODUCTION_VERSION_TEXT', 'production_version_text', 'none', 15),
    ('stage_production_version', 'REPETITIVE_MFG', 'repetitive_mfg', 'none', 16),
    ('stage_production_version', 'LOT_SIZE_FROM', 'lot_size_from', 'none', 17),
    ('stage_production_version', 'LOT_SIZE_TO', 'lot_size_to', 'none', 18),
    ('stage_routing_operation', 'PLANT', 'plant', 'none', 1),
    ('stage_routing_operation', 'MATERIAL_ID', 'material_id', 'none', 2),
    ('stage_routing_operation', 'TASK_LIST_TYPE', 'task_list_type', 'none', 3),
    ('stage_routing_operation', 'ROUTING_GROUP', 'routing_group', 'none', 4),
    ('stage_routing_operation', 'GROUP_COUNTER', 'group_counter', 'none', 5),
    ('stage_routing_operation', 'SEQUENCE_NO', 'sequence_no', 'none', 6),
    ('stage_routing_operation', 'ACTIVITY', 'activity', 'none', 7),
    ('stage_routing_operation', 'SAP_WORKCENTER', 'sap_workcenter', 'none', 8),
    ('stage_routing_operation', 'WORKCENTER_CATEGORY', 'workcenter_category', 'none', 9),
    ('stage_routing_operation', 'BASE_QUANTITY', 'base_quantity', 'none', 10),
    ('stage_routing_operation', 'CONTROL_KEY', 'control_key', 'none', 11),
    ('stage_routing_operation', 'OPERATION_TEXT', 'operation_text', 'none', 12),
    ('stage_routing_operation', 'OPERATION_UNIT', 'operation_unit', 'none', 13),
    ('stage_routing_operation', 'ACTIVITY_TYPE_MACHINE', 'activity_type_machine', 'none', 14),
    ('stage_routing_operation', 'STD_VALUE_MACHINE', 'std_value_machine', 'none', 15),
    ('stage_routing_operation', 'STD_VALUE_UNIT_MACHINE', 'std_value_unit_machine', 'none', 16),
    ('stage_routing_operation', 'ACTIVITY_TYPE_LABOR', 'activity_type_labor', 'none', 17),
    ('stage_routing_operation', 'STD_VALUE_LABOR', 'std_value_labor', 'none', 18),
    ('stage_routing_operation', 'STD_VALUE_UNIT_LABOR', 'std_value_unit_labor', 'none', 19),
    ('stage_routing_operation', 'REQUIRED_OVERLAP', 'required_overlap', 'none', 20),
    ('stage_routing_operation', 'OPTIONAL_OVERLAP', 'optional_overlap', 'none', 21),
    ('stage_routing_operation', 'REQUIRED_SPLIT', 'required_split', 'none', 22),
    ('stage_routing_operation', 'FIELD_KEY', 'field_key', 'none', 23),
    ('stage_routing_operation', 'NUM_SPLITS', 'num_splits', 'none', 24),
    ('stage_routing_operation', 'TASK_LIST_TEXT', 'task_list_text', 'none', 25),
    ('stage_routing_operation', 'SEQUENCE_CATEGORY', 'sequence_category', 'none', 26),
    ('stage_routing_operation', 'SEQUENCE_TEXT', 'sequence_text', 'none', 27),
    ('stage_routing_operation', 'NUM_EMPLOYEES', 'num_employees', 'none', 28),
    ('stage_routing_operation', 'SETUP_GROUP_CATEGORY', 'setup_group_category', 'none', 29),
    ('stage_routing_operation', 'SETUP_GROUP_KEY', 'setup_group_key', 'none', 30),
    ('stage_routing_operation', 'DELETED', 'deleted', 'none', 31),
    ('stage_routing_operation', 'HEADER_STATUS', 'header_status', 'none', 32),
    ('stage_routing_operation', 'HEADER_VALID_FROM', 'header_valid_from', 'none', 33),
    ('stage_routing_operation', 'HEADER_VALID_TO', 'header_valid_to', 'none', 34)
ON CONFLICT (object_key, sap_field) DO NOTHING;

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
-- machine_calendar, a wheel may exist for an order-derived plant that lags master
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
-- in ALLOWED_TABLES), same as subnetworks/plants/machine above.
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

-- ----------------------------------------------------------------------------
-- system_settings — global (not per-user, not per-plant) admin-configured
-- settings, singleton row (id always 1). Currently holds orderFields: which
-- optional Orders fields show by default in the AG Grid / Inspector panel
-- ({"orderFields": {"<FIELD_KEY>": {"grid": bool, "inspector": bool}}}).
-- Read/written ONLY through master_data.py (get_system_settings /
-- upsert_system_settings) and the /system-settings endpoints. Self-bootstrapped
-- at startup by master_data.ensure_system_settings_table().
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
    id         INTEGER PRIMARY KEY DEFAULT 1,
    settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_system_settings_singleton CHECK (id = 1)
);
INSERT INTO system_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- SCHEDULING PRIORITY LISTS (docs/scheduling_priority.md, Stage 1 — data
-- plumbing only: no upload UI, no optimizer change yet)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- priority_list: one row per (plant, machine-scope, rankable field). Generalizes
-- color_wheel to any field in master_data.RANKABLE_FIELDS. machine = '' means
-- plant-wide; a specific machine value overrides the plant-wide list
-- for that machine only (mirrors machine_calendar / machine_blackout's machine: null
-- convention). entries is {NORMALIZED_VALUE: RANK}, same shape color_wheel
-- already uses for {COLOR: ORDER_Y}.
--
-- No FK to plants/machine — like color_wheel, a list may exist for
-- an order-derived plant/machine that lags master data. value_column/rank_column
-- are upload provenance only (which uploaded headers were mapped); they are
-- never re-parsed from — master_data.RANKABLE_FIELDS is the sole source of
-- truth for a field's DB source column (N19 in docs/scheduling_priority.md).
-- Verbatim copy in migrations/2026-08-11-priority-lists.sql.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS priority_list (
    plant         TEXT NOT NULL,
    machine       TEXT NOT NULL DEFAULT '',
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
    PRIMARY KEY (plant, machine, field_key)
);

-- ----------------------------------------------------------------------------
-- orders.{prt_01,prt_02,production_version} — materialized copies of the
-- matching material_plants planner attributes (seam 2:
-- db._stamp_order_attributes), read directly by db._ORDERS_SELECT with no
-- JOIN on the hot /tasks path. orders.color already exists (added long before
-- this feature); Stage 1 changes what populates it, not its column
-- definition. production_version sources from material_plants.
-- default_production_version (the material_plants base table above) — NOT
-- material_plants.default_machine, which stays a plain admin-editable
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
-- 9 SAP COOIS extract fields, upload-sourced (no post-upsert stamping like
-- prt_01/prt_02 above). Hidden by default in web/order-field-catalog.mjs;
-- an admin opts them into the grid/Inspector via System Configuration.
-- ----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS planned_order_initial_quantity NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reduced_quantity               NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_category                 TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type                     TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bom_alternative                INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bom_usage                      INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS labor_hours                    NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS machine_hours                  NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS no_of_fte                      NUMERIC;

-- ----------------------------------------------------------------------------
-- One-time: copy every existing color_wheel row into priority_list as a
-- plant-wide (machine = '') 'colorWheel' entry. Keyed on plant_label (the raw
-- plant name as typed), NOT plant_key (a _cw_safe_name() slug) — priority_list
-- is keyed by raw plant name throughout. color_wheel itself is left in place,
-- unread from here on except by the legacy-compat /color-wheel/* endpoints,
-- which are repointed at priority_list in brain.py.
-- ----------------------------------------------------------------------------
DO $mig$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'priority_list_from_color_wheel') THEN
        INSERT INTO priority_list
            (plant, machine, field_key, entries, source_column, value_column, rank_column,
             filename, row_count, uploaded_by, uploaded_at, updated_at)
        SELECT plant_label, '', 'colorWheel', entries, 'color', NULL, NULL,
               filename, row_count, uploaded_by, uploaded_at, updated_at
          FROM color_wheel
        ON CONFLICT (plant, machine, field_key) DO NOTHING;

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
-- prevents only setup-aware optimization for a signature-incompatible machine;
-- setup data and diagnostics remain visible. The reason preserves that choice.
ALTER TABLE machine ADD COLUMN IF NOT EXISTS setup_compatible BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE machine ADD COLUMN IF NOT EXISTS setup_compatibility_reason TEXT;

-- One current definition per plant. Increment signature_version whenever the
-- ordered field signature changes; later writes must use that exact version.
CREATE TABLE IF NOT EXISTS setup_definition (
    plant             TEXT PRIMARY KEY,
    fields            JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
    signature_version INTEGER NOT NULL CHECK (signature_version > 0),
    strict_blanks     BOOLEAN NOT NULL DEFAULT TRUE,
    -- Workstream D2 (2026-08-20): VESTIGIAL BUT RETAINED. The real "include
    -- setup times in optimizer" gate is now plants.setup_active (see
    -- schema.sql's plants block above) — no optimizer/UI gate reads this
    -- column any more. Kept, with its force-reset-to-FALSE-on-signature-bump
    -- write path (setup_data.save_definition) untouched, because ripping out
    -- PUT /setup/{plant}/active and every reader was judged higher blast
    -- radius than leaving one harmless unread column. Do not repurpose this
    -- for anything new — plants.setup_active is the single source of truth.
    active            BOOLEAN NOT NULL DEFAULT FALSE,
    created_by        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by        TEXT,
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- A blank machine scope is the plant-wide value; a nonblank machine is a sparse
-- override. JSONB participates in the primary key so canonical array order is
-- significant and duplicate transitions are rejected within each version.
CREATE TABLE IF NOT EXISTS setup_matrix (
    plant             TEXT NOT NULL,
    machine           TEXT NOT NULL DEFAULT '',
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
    PRIMARY KEY (plant, machine, signature_version, from_key, to_key)
);

-- Default changeover minutes charged when a transition arrives at a signature
-- value (value defaults); resolved below exact rows, carried across signature bumps.
CREATE TABLE IF NOT EXISTS setup_value_default (
    plant             TEXT NOT NULL,
    signature_version INTEGER NOT NULL CHECK (signature_version > 0),
    field_key         TEXT NOT NULL,
    value             TEXT NOT NULL,
    setup_min         INTEGER NOT NULL CHECK (setup_min BETWEEN 0 AND 10080),
    created_by        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by        TEXT,
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plant, signature_version, field_key, value)
);

-- The most recently accepted physical setup state for each plant/machine.
CREATE TABLE IF NOT EXISTS machine_setup_state (
    plant             TEXT NOT NULL,
    machine           TEXT NOT NULL,
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
    PRIMARY KEY (plant, machine)
);

-- An override represents remaining physical setup work for one exact observed
-- adjacency. It is not a persisted pseudo-order or a dependency relationship.
CREATE TABLE IF NOT EXISTS setup_occurrence_override (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant                TEXT NOT NULL,
    machine              TEXT NOT NULL,
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
        plant, machine, signature_version, predecessor_order_id, successor_order_id,
        predecessor_state_key, successor_state_key
    )
    NULLS NOT DISTINCT
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_setup_occurrence_override_plant_machine
    ON setup_occurrence_override (plant, machine, signature_version);

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

-- Durable optimizer exceptions. Apply before deploying dependent application.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS planning_status TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS planning_reason JSONB;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_planning_state_check'
                   AND conrelid = 'orders'::regclass) THEN
        ALTER TABLE orders ADD CONSTRAINT orders_planning_state_check CHECK (
            (planning_status = 'scheduled' AND planning_reason IS NULL)
            OR (planning_status = 'needs_planning'
                AND scheduled_start IS NULL AND scheduled_end IS NULL
                AND planning_reason IS NOT NULL
                AND jsonb_typeof(planning_reason) = 'object'
                AND planning_reason ? 'code' AND planning_reason ? 'message'
                AND jsonb_typeof(planning_reason->'code') = 'string'
                AND jsonb_typeof(planning_reason->'message') = 'string')
        );
    END IF;
END $$;

-- Routing-runtime provenance for orders.run_time (ROUTING_RUNTIME_DESIGN.md
-- §3.5). run_time_source: which mechanism last set run_time ('routing',
-- 'manual', 'legacy', 'distributed', 'sap_order'); run_time_basis: JSONB
-- detail (production version, routing identifiers, per-operation hours,
-- fallback used) shown read-only in the Inspector, never used for placement.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS run_time_source TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS run_time_basis JSONB;

-- A named constraint (rather than an inline CHECK) so a future value can be
-- added the same idempotent way: drop it if present, then re-add it.
DO $$
BEGIN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_run_time_source_check;
    ALTER TABLE orders ADD CONSTRAINT orders_run_time_source_check
        CHECK (run_time_source IS NULL OR run_time_source IN
            ('routing', 'manual', 'legacy', 'distributed', 'sap_order'));
END $$;

-- Backfill of the locked original SAP dates (mirrors migrations/2026-10-15-1-orders-original-dates.sql).
-- Placed last because it reads order_sap_sent. Ledger-guarded so a re-apply never re-runs it. The UPDATE
-- rewrites every orders row (bumps xmin / base_version): apply at deploy time, never mid-shift.
-- A row with no order_sap_sent row takes the as-received sap_basic_* dates when present, else basic_*;
-- a row with a sent row had its original overwritten by NIMBUS's own send, so original_* = basic_*.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'orders_original_dates_backfill') THEN
    UPDATE orders o SET
      original_finish_received = CASE WHEN s.order_id IS NULL THEN COALESCE(o.sap_basic_finish_date, o.basic_finish_date) ELSE o.basic_finish_date END,
      original_start_received  = CASE WHEN s.order_id IS NULL THEN COALESCE(o.sap_basic_start_date,  o.basic_start_date)  ELSE o.basic_start_date  END
    FROM orders o2 LEFT JOIN order_sap_sent s ON s.order_id = o2.id
    WHERE o2.id = o.id;
    UPDATE order_distribution SET original_finish_received = basic_finish_date WHERE original_finish_received IS NULL;
    INSERT INTO schema_migrations (id) VALUES ('orders_original_dates_backfill');
  END IF;
END
$mig$;

-- Backward scheduling D10 (VI12): mirrors migrations/2026-10-16-2-orders-original-finish-date-only.sql. Marks existing
-- rows whose locked finish sits at exact midnight (the only evidence old rows carry); ledger-guarded.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'orders_original_finish_date_only_backfill') THEN
    UPDATE orders SET original_finish_date_only = TRUE
     WHERE original_finish_received IS NOT NULL AND original_finish_received::time = TIME '00:00:00';
    INSERT INTO schema_migrations (id) VALUES ('orders_original_finish_date_only_backfill');
  END IF;
END
$mig$;

-- Backward-scheduling cutover (mirrors migrations/2026-10-20-0-orders-precutover-snapshot.sql and
-- migrations/2026-10-20-1-backward-cutover.sql). Placed last: it reads orders, segments and order_sap_sent.
-- Each block is ledger-guarded, so a re-apply never repeats it. NOTE: a developer database that re-applies
-- schema.sql runs the cutover ONCE and nulls its local placed finishes and segments (running rows keep theirs).
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'backward_cutover_snapshot') THEN
    CREATE TABLE orders_precutover_snapshot AS
      SELECT id, plant, machine, planning_status, run_time,
             basic_start_date, basic_finish_date,
             scheduled_start, scheduled_end,
             manual_firmed, firming_indicator,
             runtime_schedule_mismatch, placement_exception,
             updated_at
      FROM orders;
    CREATE TABLE order_schedule_segments_precutover_snapshot AS
      SELECT * FROM order_schedule_segments;
    CREATE TABLE order_sap_sent_precutover_snapshot AS
      SELECT * FROM order_sap_sent;
    INSERT INTO schema_migrations (id) VALUES ('backward_cutover_snapshot');
  END IF;
END
$mig$;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'backward_scheduling_cutover') THEN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'backward_cutover_snapshot') THEN
      RAISE EXCEPTION 'backward cutover: apply migrations/2026-10-20-0-orders-precutover-snapshot.sql first (no snapshot in the ledger)';
    END IF;
    -- running = a planner-placed start at or before plant-local now and the old effective end after it
    -- (Task 0 ruling: real column names — plants.plant (PK is (subnetwork, plant); MIN(timezone) per plant as
    --  sap_staging.py does, a plant may sit in two subnetworks), orders.planning_status = 'needs_planning',
    --  order_schedule_segments.scheduled_end; plant-local naive now is simply now() AT TIME ZONE tz.)
    WITH plant_now AS (
      SELECT p.plant, now() AT TIME ZONE COALESCE(NULLIF(MIN(p.timezone),''),'UTC') AS pnow
      FROM plants p GROUP BY p.plant
    ), old_end AS (
      SELECT o.id, COALESCE(MAX(s.scheduled_end), o.scheduled_end, o.scheduled_start + (o.run_time * INTERVAL '1 hour')) AS old_end
      FROM orders o LEFT JOIN order_schedule_segments s ON s.order_id = o.id GROUP BY o.id
    ), running AS (
      SELECT o.id, e.old_end FROM orders o LEFT JOIN plant_now pn ON pn.plant = o.plant JOIN old_end e ON e.id = o.id
      WHERE o.scheduled_start IS NOT NULL
        AND o.scheduled_start <= COALESCE(pn.pnow, now() AT TIME ZONE 'UTC')
        AND e.old_end > COALESCE(pn.pnow, now() AT TIME ZONE 'UTC')
    )
    UPDATE orders o SET
      -- Task 0 ruling B4 (OQ3/OQ5, D15): a running row keeps BOTH its start and its STORED end so it still
      -- reads as running (server _order_is_running needs both edges; client isInProgress needs now < end)
      -- even when its due date is already past. Every other row loses both edges and re-derives from its due date.
      scheduled_start = CASE WHEN r.id IS NOT NULL THEN o.scheduled_start ELSE NULL END,
      scheduled_end   = CASE WHEN r.id IS NOT NULL THEN r.old_end        ELSE NULL END,
      placement_exception = NULL,
      runtime_schedule_mismatch = TRUE,
      updated_at = now()
    FROM (SELECT id FROM orders) a LEFT JOIN running r ON r.id = a.id
    WHERE o.id = a.id AND o.planning_status <> 'needs_planning';
    -- Segments are removed for every non-queued row EXCEPT a running one (a running row kept its start above, so
    -- scheduled_start IS NULL here marks exactly the rows that lost their placement); a running split order keeps
    -- its fragments and so its closed-hours gaps.
    DELETE FROM order_schedule_segments s USING orders o
     WHERE s.order_id = o.id AND o.planning_status <> 'needs_planning' AND o.scheduled_start IS NULL;
    INSERT INTO schema_migrations (id) VALUES ('backward_scheduling_cutover');
  END IF;
END
$mig$;

-- Same-ID machine <-> SAP work center auto-link backfill (mirrors migrations/2026-10-19-1-machine-workcenter-autolink.sql).
-- Ledger-guarded; fills only EMPTY links, never re-points one. See that file for the full rule.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'machine_workcenter_autolink_backfill') THEN
    UPDATE machine m SET sap_workcenter = m.machine, updated_at = NOW()
      FROM sap_workcenter w
     WHERE w.plant = m.plant AND w.sap_workcenter = m.machine
       AND m.sap_workcenter IS NULL AND w.distribution_mode = 'single'
       AND NOT EXISTS (SELECT 1 FROM machine o WHERE o.plant = m.plant AND o.sap_workcenter = w.sap_workcenter)
       AND (SELECT count(*) FROM machine d WHERE d.plant = m.plant AND d.machine = m.machine) = 1;
    INSERT INTO schema_migrations (id) VALUES ('machine_workcenter_autolink_backfill');
  END IF;
END
$mig$;

-- Display-label rename "Incremental Lot Size" -> "Rounding Value" (mirrors migrations/2026-10-19-2-rounding-value-label.sql).
-- Idempotent; leaves an admin-customized label alone.
UPDATE column_metadata
   SET display_label = 'Rounding Value'
 WHERE table_name = 'material_plants'
   AND column_name = 'incremental_lot_size'
   AND display_label = 'Incremental Lot Size';

-- Reset every stored `dateFormat` preference (user_settings, roles.settings) to 'm/d/Y' (mirrors
-- migrations/2026-10-20-3-reset-date-format.sql). Ledger-guarded, so it never overwrites a later choice.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'reset_date_format_mdy') THEN
    UPDATE user_settings
       SET settings = jsonb_set(settings, '{dateFormat}', '"m/d/Y"'::jsonb), updated_at = NOW()
     WHERE settings->'dateFormat' IS NOT NULL AND settings->'dateFormat' <> '"m/d/Y"'::jsonb;
    UPDATE roles
       SET settings = jsonb_set(settings, '{dateFormat}', '"m/d/Y"'::jsonb), updated_at = NOW()
     WHERE settings->'dateFormat' IS NOT NULL AND settings->'dateFormat' <> '"m/d/Y"'::jsonb;
    INSERT INTO schema_migrations (id) VALUES ('reset_date_format_mdy');
  END IF;
END
$mig$;

-- Alert Monitor: alert_profile + alert_ack (mirrors migrations/2026-10-20-2-alert-profiles.sql). Idempotent.
CREATE TABLE IF NOT EXISTS alert_profile (
    id TEXT PRIMARY KEY, plant TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    ranking TEXT NOT NULL DEFAULT 'impact' CHECK (ranking IN ('impact','time','severity','orders')),
    created_by TEXT, updated_by TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_alert_profile_rules CHECK (jsonb_typeof(rules) = 'array'),
    CONSTRAINT uq_alert_profile_plant_name UNIQUE (plant, name));
CREATE INDEX IF NOT EXISTS idx_alert_profile_plant ON alert_profile(plant, name);

CREATE TABLE IF NOT EXISTS alert_ack (
    plant TEXT NOT NULL, alert_id TEXT NOT NULL, acknowledged_by TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', until TIMESTAMP NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plant, alert_id));

-- schedule_event: append-only per-order change history (mirrors migrations/2026-10-23-1-schedule-event.sql). Idempotent.
CREATE TABLE IF NOT EXISTS schedule_event (
    id               BIGSERIAL PRIMARY KEY,
    plant            TEXT NOT NULL,
    order_id         TEXT NOT NULL,          -- orders.id (MD5 of production_order|material); no FK on purpose
    production_order TEXT,
    material_number  TEXT,
    action_id        UUID NOT NULL,          -- one per save / ingest batch / optimizer run / sweep action
    source           TEXT NOT NULL,          -- drag|keyboard|grid|inspector|alert_fix|optimizer|undo|planner|note|
                                             -- distribution|sap_ingest|excel_upload|sap_reset|routing_hold|
                                             -- routing_recompute|purge|sap_vanish|restore|admin|master_data_stamp|unknown
    actor            TEXT,
    client_id        TEXT,                   -- reserved for the future change feed
    op               TEXT NOT NULL CHECK (op IN ('create','modify','remove')),
    changes          JSONB NOT NULL,         -- {"field": [before, after]} - only changed tracked fields
    at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
) WITH (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 10000,
        autovacuum_analyze_scale_factor = 0.05);
CREATE INDEX IF NOT EXISTS idx_schedule_event_order ON schedule_event (plant, order_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_event_at    ON schedule_event (at);
-- Plant-level change listing in time order (also created by backend/schedule_events/data.py ensure_schedule_event_table).
CREATE INDEX IF NOT EXISTS idx_schedule_event_plant_at ON schedule_event (plant, at DESC);

-- job scheduler: definitions, schedules, runs and run logs (mirrors migrations/2026-10-29-1-job-scheduler.sql). Idempotent.
CREATE TABLE IF NOT EXISTS job_definition (
    id            BIGSERIAL PRIMARY KEY,
    plant         TEXT NOT NULL,             -- no FK on purpose (same posture as schedule_event)
    job_type      TEXT NOT NULL,             -- registry key, e.g. optimizer.plant
    name          TEXT NOT NULL,
    params        JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    archived      BOOLEAN NOT NULL DEFAULT FALSE,   -- a removed job stays for its run history
    retry_max     INTEGER NOT NULL DEFAULT 0 CHECK (retry_max BETWEEN 0 AND 5),
    timeout_s     INTEGER CHECK (timeout_s IS NULL OR timeout_s BETWEEN 10 AND 21600),
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    modified_by   TEXT,
    modified_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_definition_plant ON job_definition (plant, id DESC);

CREATE TABLE IF NOT EXISTS job_schedule (
    id               BIGSERIAL PRIMARY KEY,
    job_id           BIGINT NOT NULL REFERENCES job_definition (id),
    kind             TEXT NOT NULL CHECK (kind IN ('once','hourly','daily','weekdays','weekly','monthly','cron')),
    cron_expr        TEXT,                   -- compiled 5-field cron (presets and custom); null for once
    time_of_day      TEXT,                   -- HH:MM plant-local, presets only
    days_of_week     SMALLINT[],             -- 0 = Monday .. 6 = Sunday, weekly only
    day_of_month     SMALLINT CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
    run_at           TIMESTAMP,              -- naive plant-local, once only
    timezone         TEXT NOT NULL,          -- IANA name copied from the plant when saved
    valid_from       TIMESTAMP,              -- naive plant-local
    valid_until      TIMESTAMP,              -- naive plant-local
    paused           BOOLEAN NOT NULL DEFAULT FALSE,
    retired          BOOLEAN NOT NULL DEFAULT FALSE,   -- a removed or spent schedule
    misfire_grace_s  INTEGER NOT NULL DEFAULT 300 CHECK (misfire_grace_s BETWEEN 1 AND 86400),
    skip_if_running  BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    modified_by      TEXT,
    modified_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_schedule_job ON job_schedule (job_id, id);

CREATE TABLE IF NOT EXISTS job_run (
    id               BIGSERIAL PRIMARY KEY,
    job_id           BIGINT NOT NULL REFERENCES job_definition (id),
    schedule_id      BIGINT REFERENCES job_schedule (id),
    plant            TEXT NOT NULL,          -- copied from the definition so history survives edits
    job_type         TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN
                       ('scheduled','running','succeeded','warning','failed','cancelled','skipped')),
    trigger          TEXT NOT NULL CHECK (trigger IN ('schedule','manual','retry')),
    attempt          INTEGER NOT NULL DEFAULT 1,
    scheduled_for    TIMESTAMPTZ,
    started_at       TIMESTAMPTZ,
    ended_at         TIMESTAMPTZ,
    triggered_by     TEXT,
    summary          JSONB,                  -- e.g. late, changeovers, moved, applied, dropped
    error            TEXT,
    log_truncated    BOOLEAN NOT NULL DEFAULT FALSE,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_run_plant   ON job_run (plant, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_run_job     ON job_run (job_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_run_created ON job_run (created_at);

CREATE TABLE IF NOT EXISTS job_run_log (
    run_id       BIGINT NOT NULL REFERENCES job_run (id),
    seq          INTEGER NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    level        TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
    step         TEXT,
    msg          TEXT NOT NULL,
    duration_ms  INTEGER,
    data         JSONB,
    PRIMARY KEY (run_id, seq)
);

-- Read-path indexes for GET /jobs/summary (also created by backend/jobs/data.py ensure_job_tables).
CREATE INDEX IF NOT EXISTS idx_job_run_ended  ON job_run (ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_run_active ON job_run (status) WHERE status IN ('scheduled','running');

-- job run artifacts: stored report results (mirrors migrations/2026-10-30-1-job-artifacts.sql). Idempotent.
CREATE TABLE IF NOT EXISTS job_run_artifact (
    run_id        BIGINT PRIMARY KEY REFERENCES job_run (id),
    content_type  TEXT NOT NULL DEFAULT 'application/json',
    filename      TEXT,
    body          TEXT NOT NULL,             -- JSON text: {sections:[{key,title,columns,rows}], summary}
    row_count     INTEGER NOT NULL DEFAULT 0,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
