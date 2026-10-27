-- ============================================================================
-- Migration: setup_value_default (default changeover minutes by signature value)
-- Date: 2026-10-27
-- Purely additive and idempotent: one new table only; no existing data is
-- touched. Mirrors the block that follows setup_matrix in schema.sql.
-- A row says: a transition that arrives at <value> of <field_key> is charged
-- <setup_min> minutes when no exact matrix row exists. Storage is O(values),
-- never O(states squared). Values are stored in the client canonical form
-- (trimmed; lowercase for true/false; otherwise uppercase). No foreign key,
-- like the sibling setup tables (plants has a composite key).
-- ============================================================================

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
