-- migrations/2026-10-20-3-reset-date-format.sql
-- Owner decision 2026-10-20: every numeric date is shown MM/DD/YYYY. The per-user `dateFormat`
-- display preference (user_settings.settings JSONB) and the per-role default (roles.settings JSONB)
-- are reset to 'm/d/Y' wherever one is stored. Rows without a stored dateFormat key are left alone
-- (the app default is already 'm/d/Y'). Contains UPDATE: deploy with
-- -Only 2026-10-20-3-reset-date-format -AllowDestructive. Ledger id 'reset_date_format_mdy' keeps a
-- re-apply (this file or schema.sql, which mirrors it) from overwriting a preference chosen afterwards.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'reset_date_format_mdy') THEN
    UPDATE user_settings
       SET settings = jsonb_set(settings, '{dateFormat}', '"m/d/Y"'::jsonb), updated_at = NOW()
     WHERE settings->'dateFormat' IS NOT NULL AND settings->'dateFormat' <> '"m/d/Y"'::jsonb;
    UPDATE roles
       SET settings = jsonb_set(settings, '{dateFormat}', '"m/d/Y"'::jsonb), updated_at = NOW()
     WHERE settings->'dateFormat' IS NOT NULL AND settings->'dateFormat' <> '"m/d/Y"'::jsonb;
    INSERT INTO schema_migrations (id) VALUES ('reset_date_format_mdy');
  END IF;
END
$mig$;
