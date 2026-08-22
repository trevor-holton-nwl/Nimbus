-- Registers plants.setup_active and plants.visibility_horizon_days in
-- column_metadata so they render as editable columns in the generic
-- Admin > Manage Data Tables grid for `plants`, alongside the existing
-- validated routes (PUT /plant/{plant}/setup-active,
-- POST /master-data/plants/{plant}/visibility-horizon), which remain in
-- place for the dedicated Settings-pane UI. Both columns already exist
-- physically (schema.sql / migrations/2026-08-20-plant-visibility-horizon.sql
-- / the ensure_plant_setup_active_column boot hook) — this migration only
-- adds the metadata rows list_rows' INNER JOIN requires to surface them.
-- horizon_roll_hour_utc is intentionally NOT registered here — it stays a
-- companion field of the dedicated visibility-horizon route only.
INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('plants', 'setup_active',             'Setup-Aware Optimization',  FALSE, 8),
    ('plants', 'visibility_horizon_days',  'Visibility Horizon (days)', FALSE, 9)
ON CONFLICT (table_name, column_name) DO NOTHING;
