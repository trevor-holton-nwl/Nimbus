-- B3 (2026-08-21): plant-configurable productive-segment floor. Both the
-- non-setup-aware split allocator (Calendar.allocateRuntime) and the
-- setup-aware placeWithSetup primitive previously enforced a fixed
-- system-wide 30-minute floor (web/schedule-services.mjs's
-- MIN_PRODUCTIVE_SEGMENT_MINUTES). NOT NULL DEFAULT 30 preserves that exact
-- behavior for every existing plant until an admin opts into a different
-- floor via the validated
-- POST /master-data/plants/{plant}/min-productive-segment-minutes route.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS min_productive_segment_minutes INTEGER NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plants_min_productive_segment_minutes_positive'
  ) THEN
    ALTER TABLE plants
      ADD CONSTRAINT plants_min_productive_segment_minutes_positive
      CHECK (min_productive_segment_minutes > 0);
  END IF;
END $$;
