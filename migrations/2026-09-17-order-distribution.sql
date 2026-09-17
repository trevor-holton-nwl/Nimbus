-- ============================================================================
-- Order Distribution — SAP aggregate work center split across NIMBUS machines
-- Date: 2026-09-17
-- Status: Additive + idempotent. ALTER TABLE statements will trigger the
--         promote-azure -AllowDestructive verb as per skill/promote-azure/SKILL.md.
-- ============================================================================

-- §3.1: sap_workcenter (per plant)
CREATE TABLE IF NOT EXISTS sap_workcenter (
    plant              TEXT NOT NULL,
    sap_workcenter     TEXT NOT NULL,
    description        TEXT,
    distribution_mode  TEXT NOT NULL DEFAULT 'single'
                       CHECK (distribution_mode IN ('single','distribute')),
    default_machine    TEXT,   -- soft ref machine(plant, machine); required in single mode, recommended in distribute mode (tooled fallback, §5.2)
    max_separation     TEXT NOT NULL DEFAULT 'none'
                       CHECK (max_separation IN ('none','hour','day','week')),
    review_required    BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE: default headers are created already reviewed
    distribute_tooled  BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE: tooled materials follow the weights (machines hold their own tool copies)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, sap_workcenter),
    CHECK (distribution_mode = 'distribute' OR default_machine IS NOT NULL)
);
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

-- §3.2: machine table additions
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

-- §3.3: orders table additions
ALTER TABLE orders ADD COLUMN IF NOT EXISTS parent_production_order TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS distribution_letter     TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_parent
    ON orders(plant, parent_production_order, material_number)
    WHERE parent_production_order IS NOT NULL;

-- §3.4: order_distribution (header) and order_distribution_share tables
CREATE TABLE IF NOT EXISTS order_distribution (
    plant              TEXT NOT NULL,
    production_order   TEXT NOT NULL,    -- SAP parent key as uploaded (planned or production order)
    material_number    TEXT NOT NULL,
    sap_workcenter     TEXT NOT NULL,    -- current work center as last uploaded; the previous one lives in sap_facts.previous_workcenter after a reroute
    order_quantity     NUMERIC,          -- parent facts as last ingested
    run_time           NUMERIC,          -- parent hours as uploaded; informational once routing resolves children (§5.8)
    basic_start_date   TIMESTAMP,
    basic_finish_date  TIMESTAMP,
    firming_indicator  TEXT,
    sap_facts          JSONB,            -- remaining copied SAP columns (description, color, form size, categories, BOM keys, planned-order quantities, no_of_fte…) plus previous_workcenter, runtime_defaulted
    source             TEXT NOT NULL DEFAULT 'default' CHECK (source IN ('default','manual')),
    default_basis      TEXT NOT NULL DEFAULT 'workcenter_weights'
                       CHECK (default_basis IN ('material_default','tooled_single','workcenter_weights')),
    reviewed           BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_by        TEXT,
    reviewed_at        TIMESTAMPTZ,
    reviewed_quantity  NUMERIC,          -- parent qty at approval → "qty changed since review"
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

CREATE TABLE IF NOT EXISTS order_distribution_share (
    plant            TEXT NOT NULL,
    production_order TEXT NOT NULL,
    material_number  TEXT NOT NULL,
    machine          TEXT NOT NULL,
    letter           TEXT NOT NULL,
    weight           NUMERIC NOT NULL DEFAULT 0 CHECK (weight >= 0),
    child_id         TEXT,                             -- orders.id currently materialized; NULL when weight = 0 or purged; soft ref
    purged_at        TIMESTAMPTZ,                      -- set by purge; only a fresh upload of the parent clears it (§5.7)
    PRIMARY KEY (plant, production_order, material_number, machine),
    UNIQUE (plant, production_order, material_number, letter),
    FOREIGN KEY (plant, production_order, material_number)
        REFERENCES order_distribution (plant, production_order, material_number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ods_machine ON order_distribution_share(plant, machine);

-- §3.6: sap_field_map seeds for SAP order sync (ARBPL→machine, WERKS→plant)
INSERT INTO sap_field_map (object_key, sap_field, nimbus_column, transform, field_order) VALUES
    ('orders', 'ARBPL', 'machine',              'none',        6),
    ('orders', 'WERKS', 'plant',                'none',        7)
ON CONFLICT (object_key, sap_field) DO NOTHING;
