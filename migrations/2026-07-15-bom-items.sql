-- ============================================================================
-- Migration: Bill of Materials (bom_items table)
-- Date: 2026-07-15
-- ============================================================================
-- SAFE TO RUN against the live Azure Postgres. This file is a verbatim copy of
-- the bom_items additions appended to schema.sql, isolated so you do NOT have
-- to re-run the full schema.sql. It is strictly additive/idempotent: one
-- CREATE TABLE IF NOT EXISTS, two CREATE INDEX IF NOT EXISTS, and one
-- INSERT ... ON CONFLICT DO NOTHING — zero UPDATEs, so it auto-applies
-- through the promote-azure guarded runner with no -AllowDestructive.
-- Re-running is a no-op.
--
-- Ordering matters and must be preserved: material_plants must already exist
-- (base schema) — bom_items FKs to material_plants(material_id, plant) twice
-- (once for the parent material, once for the component; component is always
-- sourced from the same plant as the parent, so both FKs share the `plant`
-- column rather than carrying a separate component_plant).
--
-- What it adds: one row per component per level per material/plant/alternative
-- BOM. Backs the new POST /bom/upload ingest endpoint (master_data.py
-- ingest_bom_from_excel) and the Master Data BOM tab. ON DELETE RESTRICT:
-- removing a material_plants row is blocked while bom_items still references
-- it either way, so BOM data must be cleaned up first (see
-- master_data.cascade_preview).
--
-- Apply (from a host with psql + DB firewall access, e.g. the dev laptop):
--   $env:PGPASSWORD='<DB_PASSWORD>'
--   psql "host=pgdb-nimbus-dev.postgres.database.azure.com port=5432 dbname=nimbus user=TempAdmin sslmode=require" -f migrations/2026-07-15-bom-items.sql
-- ============================================================================

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

INSERT INTO column_metadata (table_name, column_name, display_label, is_key_column, sort_order) VALUES
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
