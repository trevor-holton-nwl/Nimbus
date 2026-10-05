-- ============================================================================
-- Routing & Production Version — data-model foundation for computing
-- orders.run_time from routings/production versions (ROUTING_RUNTIME_DESIGN.md)
-- Date: 2026-09-24
-- Status: Additive + idempotent, EXCEPT the orders_run_time_source_check
--         constraint below, which touches the existing (populated) orders
--         table and so ships through the standard destructive-change
--         approval path per promote-azure -AllowDestructive
--         (skill/promote-azure/SKILL.md), same as order-distribution's
--         ALTER TABLE statements.
-- Backfill (routing_runtime_legacy_backfill) is a SEPARATE, ledger-guarded
-- migration file, never mirrored in schema.sql — see
-- migrations/2026-09-25-routing-production-version-backfill.sql and root
-- CLAUDE.md's rule on data-mutating one-time steps.
-- ============================================================================

-- §3.1: production_version — one row per (plant, material, production
-- version), the repetitive-manufacturing routing link. There is no
-- production-order concept in NIMBUS; this table and routing_operation are
-- the whole of "routing" as NIMBUS understands it.
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

-- §3.2: routing_operation — one row per operation of one routing, for one
-- material. `group` is a reserved word in Postgres, so the column is
-- routing_group everywhere in this design.
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

-- §3.4: routing_rules (per plant) — only two kinds of rule exist. Which time
-- an operation contributes (machine or labor) is fixed logic read from the
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

-- §3.5: orders additions — provenance for orders.run_time.
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

-- §3.6: plants — the routing-runtime switch. Off (default) leaves a plant's
-- ingest and scheduling exactly as they are today. On hands the plant to the
-- routing resolver from that point on.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS routing_runtime_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ----------------------------------------------------------------------------
-- column_metadata seeds — §3.7. Without these the generic grid renders empty.
-- PK columns are is_locked = TRUE. routing_group is labelled "Group" per the
-- design doc (§2 D1's `group` reserved-word rename).
-- ----------------------------------------------------------------------------
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

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('plants', 'routing_runtime_enabled', 'Routing Runtime Enabled', FALSE, 11)
ON CONFLICT (table_name, column_name) DO NOTHING;
