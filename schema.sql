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
    color                 TEXT,
    order_quantity        NUMERIC,
    form_size             TEXT,
    notes                 TEXT,                -- user annotations; max 500 chars enforced at app layer
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

-- Defense-in-depth: reject inverted user-scheduled ranges at the DB layer too
-- (the app already validates in update_task_dates_bulk). NOT VALID so the
-- migration never fails on pre-existing rows; still enforced on all new writes.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_sched_range;
ALTER TABLE orders ADD CONSTRAINT chk_orders_sched_range
    CHECK (scheduled_start IS NULL OR scheduled_end IS NULL OR scheduled_end > scheduled_start)
    NOT VALID;

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
-- Convert existing day-valued rows to minutes (safe: day values are always <= 365)
UPDATE plants SET alt_flag_horizon   = alt_flag_horizon   * 1440 WHERE alt_flag_horizon   <= 365;
UPDATE plants SET conf_score_horizon = conf_score_horizon * 1440 WHERE conf_score_horizon <= 365;

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
CREATE INDEX IF NOT EXISTS idx_material_plants_material ON material_plants(material_id);

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
-- Labor Planning — planned headcount by line group × ISO week
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_plan (
    subnetwork  TEXT    NOT NULL,
    plant       TEXT    NOT NULL,
    pl_group    TEXT    NOT NULL,
    period      TEXT    NOT NULL,   -- ISO week key: 'YYYY-Www'
    headcount   NUMERIC,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, pl_group, period),
    FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_labor_plan_plant ON labor_plan(plant);

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
    ('material_plants',  'incremental_lot_size',       'Incremental Lot Size',         FALSE, 7)
ON CONFLICT (table_name, column_name) DO NOTHING;
