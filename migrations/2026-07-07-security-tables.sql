-- ============================================================================
-- Migration: roles, role_plants, user_security tables (NIMBUS security admin)
-- Date: 2026-07-07
-- ============================================================================
-- SAFE TO RUN against the live Azure Postgres. This file is a verbatim copy of
-- the roles / role_plants / user_security block appended to schema.sql,
-- isolated so you do NOT have to re-run the full schema.sql. It is strictly
-- additive/idempotent: three CREATE TABLE IF NOT EXISTS statements, one
-- CREATE INDEX IF NOT EXISTS, and a column_metadata seed INSERT guarded by
-- ON CONFLICT DO NOTHING — zero UPDATEs, so it auto-applies through the
-- promote-azure guarded runner with no -AllowDestructive. Re-running is a
-- no-op.
--
-- Ordering matters and must be preserved: roles must be created before
-- role_plants and user_security, since both carry a FOREIGN KEY REFERENCES
-- roles(role).
--
-- What it adds: the backing tables for the new Security admin sub-tab —
-- `roles` (named roles + free-text description), `role_plants` (per-role
-- plant scoping, many-to-many), and `user_security` (username -> role +
-- PBKDF2 password hash, written only via auth.py — never plaintext, never
-- read back by the API). `roles` and `role_plants` are also registered in
-- master_data.ALLOWED_TABLES, so they ride the generic "Manage Data Tables"
-- grid; the column_metadata rows below are required for that grid's
-- list_rows() (it INNER JOINs column_metadata, so without these rows the
-- grid reads back empty).
--
-- Apply (from a host with psql + DB firewall access, e.g. the dev laptop):
--   $env:PGPASSWORD='<DB_PASSWORD>'
--   psql "host=pgdb-nimbus-dev.postgres.database.azure.com port=5432 dbname=nimbus user=TempAdmin sslmode=require" -f migrations/2026-07-07-security-tables.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS roles (
    role        TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

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

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('roles', 'role', 'Role', TRUE, 1),
    ('roles', 'description', 'Description', FALSE, 2),
    ('role_plants', 'role', 'Role', TRUE, 1),
    ('role_plants', 'plant', 'Plant', TRUE, 2)
ON CONFLICT (table_name, column_name) DO NOTHING;
