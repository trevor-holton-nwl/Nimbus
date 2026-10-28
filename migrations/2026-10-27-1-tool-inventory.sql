-- ============================================================================
-- Migration: tool_inventory (per-plant tool copy counts for PRT 1 / PRT 2)
-- Date: 2026-10-27
-- Purely additive and idempotent: one new table plus its column_metadata seed;
-- no existing data is touched. Mirrors the block added to schema.sql and
-- master_data.ensure_tool_inventory_table() (the boot hook, so an image that
-- rolls before this file is applied still finds the table).
-- A tool id is a TYPE; the plant owns several interchangeable copies. A tool
-- with no row counts as 1 copy. Available = total_qty - out_of_service_qty.
-- To fix a typo in a tool id, remove the row and re-add it in one save.
-- ============================================================================

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
