-- 2026-07-08 — first_name / last_name on user_security
--
-- Why: adds two optional profile columns so a user can identify themselves
-- beyond a bare username. Self-service editable via PATCH /security/me
-- (auth.update_own_name) and admin-editable via the Security tab's users
-- table (auth.bulk_upsert_users). Both columns are nullable — no backfill,
-- no required-ness anywhere.
--
-- auth.ensure_user_security_table() also self-bootstraps these columns at
-- app startup (mirrors how it self-bootstraps the table/index), so a running
-- app never lacks them — but this file (or a schema.sql re-apply, which
-- carries the same statements) is the explicit migration + record of drift.
ALTER TABLE user_security ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE user_security ADD COLUMN IF NOT EXISTS last_name  TEXT;
