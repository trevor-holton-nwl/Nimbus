-- ============================================================================
-- Migration: SAP staging tables, outbound queue and vanished-order archive
-- Date: 2026-10-08  |  Design of record: docs/SAP_STAGING_DESIGN.md
-- ============================================================================
-- Purpose: Mulesoft (or the Excel upload path) writes SAP snapshots into the
-- sap_stage_* inbound tables under a sap_stage_batch header; NIMBUS validates
-- and applies a batch into the live tables. sap_stage_planned_order_out is the
-- outbound queue Mulesoft polls, and sap_stage_vanished_order archives orders
-- deleted at apply time so they can be restored.
--
-- ADDITIVE ONLY. Strictly idempotent: CREATE ... IF NOT EXISTS and
-- INSERT ... ON CONFLICT DO NOTHING; no ALTER/UPDATE/DELETE. Re-running is a
-- no-op. The column additions live in 2026-10-08-sap-staging-columns.sql.
-- ============================================================================

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
