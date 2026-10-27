-- Workstream C2: plant-level frozen horizon — a near-term window (same
-- anchor-day/UTC-roll-hour clock as the C1 visibility horizon, via
-- db.compute_frozen_horizon_end) inside which the optimizer may not place or
-- move any order; an order whose planned FINISH falls inside it (finish-based since 2026-10-27, was start-based) is
-- treated as implicitly pinned. UNLIKE visibility_horizon_days, NULL *and* 0
-- both mean "off". Deliberately unregistered (no column_metadata row), same
-- as its horizon siblings — changed only through the validated
-- POST /master-data/plants/{plant}/frozen-horizon-days route.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS frozen_horizon_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plants_frozen_horizon_days_nonnegative'
  ) THEN
    ALTER TABLE plants
      ADD CONSTRAINT plants_frozen_horizon_days_nonnegative
      CHECK (frozen_horizon_days IS NULL OR frozen_horizon_days >= 0);
  END IF;
END $$;
