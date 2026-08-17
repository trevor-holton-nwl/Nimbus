-- Per-plant due-date pull-forward guardrail. NULL retains existing behavior.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS max_pull_forward_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plants_max_pull_forward_days_nonnegative'
  ) THEN
    ALTER TABLE plants
      ADD CONSTRAINT plants_max_pull_forward_days_nonnegative
      CHECK (max_pull_forward_days IS NULL OR max_pull_forward_days >= 0);
  END IF;
END $$;
