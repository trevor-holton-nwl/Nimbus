-- Registers plants.horizon_roll_hour_utc in column_metadata so it renders as
-- an editable column in the generic Admin > Manage Data Tables grid for
-- `plants`, completing the set its two siblings joined in
-- migrations/2026-08-21-plants-grid-visibility.sql.
--
-- That earlier migration deliberately left this column out, on the reasoning
-- that it was "a companion field of the dedicated visibility-horizon route
-- only". That reasoning expired the same day: the Scheduling Rules pane
-- (Plant > Settings) dropped its rows for Visibility Horizon, Roll-Forward
-- Hour and Setup-Aware Optimization, so POST /master-data/plants/{plant}/
-- visibility-horizon no longer has a frontend caller and this column was left
-- with no editable surface at all — pinned at its NOT NULL DEFAULT 19 for
-- every plant, reachable only by direct SQL. Registering it here makes the
-- grid the single, intended place to maintain all three.
--
-- The column already exists physically (schema.sql /
-- migrations/2026-08-20-plant-visibility-horizon.sql / the
-- ensure_plant_visibility_horizon_columns boot hook), as does its
-- plants_horizon_roll_hour_utc_range CHECK (0-23) — which is what keeps an
-- out-of-range grid edit honest, since the generic bulk-upsert path has no
-- per-column validation of its own. This migration only adds the metadata row
-- list_rows' INNER JOIN requires to surface it.
INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
    ('plants', 'horizon_roll_hour_utc',    'Roll-Forward Hour (UTC)',   FALSE, 10)
ON CONFLICT (table_name, column_name) DO NOTHING;
