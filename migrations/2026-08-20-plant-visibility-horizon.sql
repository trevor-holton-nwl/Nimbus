-- Workstream C1: plant-level visibility horizon — how far into the future a
-- planner can see on the Gantt and Orders tab, enforced server-side on
-- GET /tasks. NULL visibility_horizon_days = unlimited (existing behavior
-- unchanged until an admin opts in). horizon_roll_hour_utc is NOT NULL
-- DEFAULT 19 so every plant has a well-defined roll instant. Deliberately
-- unregistered (no column_metadata row), same as split_order_policy/
-- max_pull_forward_days — changed only through the validated
-- POST /master-data/plants/{plant}/visibility-horizon route.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS visibility_horizon_days INTEGER;
ALTER TABLE plants ADD COLUMN IF NOT EXISTS horizon_roll_hour_utc INTEGER NOT NULL DEFAULT 19;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plants_visibility_horizon_days_nonnegative'
  ) THEN
    ALTER TABLE plants
      ADD CONSTRAINT plants_visibility_horizon_days_nonnegative
      CHECK (visibility_horizon_days IS NULL OR visibility_horizon_days >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plants_horizon_roll_hour_utc_range'
  ) THEN
    ALTER TABLE plants
      ADD CONSTRAINT plants_horizon_roll_hour_utc_range
      CHECK (horizon_roll_hour_utc >= 0 AND horizon_roll_hour_utc <= 23);
  END IF;
END $$;

-- Plant-scoped visibility-horizon bound for GET /tasks' db.query_orders/
-- count_orders. See schema.sql's idx_orders_plant_eff_start comment for why
-- this covers the two-way-coalesce shape only (the segment-bearing minority
-- stays index-assisted via idx_order_schedule_segments_order_start).
CREATE INDEX IF NOT EXISTS idx_orders_plant_eff_start
  ON orders(plant, COALESCE(scheduled_start, basic_start_date));
