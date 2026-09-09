-- Per-plant due-date push-forward (max lateness) guardrail. NULL retains existing behavior.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS max_push_forward_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plants_max_push_forward_days_nonnegative'
  ) THEN
    ALTER TABLE plants
      ADD CONSTRAINT plants_max_push_forward_days_nonnegative
      CHECK (max_push_forward_days IS NULL OR max_push_forward_days >= 0);
  END IF;
END $$;
