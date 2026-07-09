-- ============================================================================
-- Migration: per-user settings (user_settings table + roles.settings column)
-- Date: 2026-07-09
-- ============================================================================
-- SAFE TO RUN against the live Azure Postgres. This file is a verbatim copy of
-- the two user-settings additions appended to schema.sql, isolated so you do
-- NOT have to re-run the full schema.sql. It is strictly additive/idempotent:
-- one CREATE TABLE IF NOT EXISTS and one ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS — zero UPDATEs, so it auto-applies through the promote-azure guarded
-- runner with no -AllowDestructive. Re-running is a no-op.
--
-- Ordering matters and must be preserved: user_security and roles must already
-- exist (from migrations/2026-07-07-security-tables.sql) — user_settings FKs to
-- user_security(username), and the settings column is added to roles.
--
-- What it adds: backing storage for NIMBUS per-user settings. `user_settings`
-- holds one JSONB blob per user (theme, language, defaultPlant, date/time
-- display prefs, saved grid layout, optimizer defaults, pinned plants/lines,
-- landing view), read/written ONLY through auth.py (get_user_settings /
-- upsert_user_settings) and the /security/me* endpoints, never the generic
-- master_data CRUD path. `roles.settings` holds per-role DEFAULT settings,
-- shallow-merged UNDER each user's own blob by the frontend (resolution:
-- userSettings[key] ?? roleSettings[key] ?? SYSTEM_DEFAULT[key]); never applied
-- to admins. Both are also self-bootstrapped at startup by
-- auth.ensure_user_settings_table() / auth.ensure_role_settings_column().
--
-- Apply (from a host with psql + DB firewall access, e.g. the dev laptop):
--   $env:PGPASSWORD='<DB_PASSWORD>'
--   psql "host=pgdb-nimbus-dev.postgres.database.azure.com port=5432 dbname=nimbus user=TempAdmin sslmode=require" -f migrations/2026-07-09-user-settings.sql
-- ============================================================================

ALTER TABLE roles ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS user_settings (
    username   TEXT PRIMARY KEY REFERENCES user_security(username) ON DELETE CASCADE ON UPDATE CASCADE,
    settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
