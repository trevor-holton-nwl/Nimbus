-- H8: orders.run_time has no bounds/finiteness check anywhere. A crafted
-- RUN_TIME (e.g. NaN, sent through a path that bypasses the new
-- TaskDateUpdate.RUN_TIME field_validator — Excel/SAP ingest writes run_time
-- through db.py's bulk upsert, a separate code path) reaches SQL interval
-- arithmetic in db.py (_EFF_END_SQL et al.) and crashes GET /tasks,
-- /tasks/refresh, and the save-lock query for the whole plant. This
-- constraint is the backstop for every write path, not just the API model.
--
-- Step 1 of 2 (Wave-0 final review, Finding 1): ADD CONSTRAINT ... NOT VALID
-- only. Step 2 (the VALIDATE CONSTRAINT scan) lives in its own, LATER-dated
-- file -- migrations/2026-09-26-orders-run-time-bounds-validate.sql -- so the
-- two steps run as two SEPARATE transactions under this repo's per-file
-- migration runner (.claude/skills/promote-azure/scripts/apply-migrations.ps1
-- runs each file with its own --single-transaction). Splitting them is what
-- actually achieves the lock-avoidance the two-step pattern is meant to
-- provide: had both steps stayed in one file, the ACCESS EXCLUSIVE lock this
-- ALTER TABLE takes would have been held for the ENTIRE VALIDATE CONSTRAINT
-- scan too (same transaction), defeating the pattern; and a VALIDATE
-- CONSTRAINT failure would have rolled back this ADD CONSTRAINT right along
-- with it, leaving NO constraint in place at all.
--
-- With the split: this file's own ACCESS EXCLUSIVE lock is brief (NOT VALID
-- takes it only long enough to add the constraint, no table scan) and is
-- released the moment THIS file's transaction commits. The constraint then
-- stays in place blocking new bad writes from the moment this file commits,
-- REGARDLESS of whether the later VALIDATE CONSTRAINT file ever succeeds. If
-- that later file fails (existing data violates the bound), only IT needs to
-- be re-run after data cleanup -- this file never needs to be touched again.
--
-- The bound is deliberately two-sided (>= 0 AND < 168, not an explicit
-- isfinite-style check) because Postgres's documented float/numeric total
-- ordering makes NaN sort greater than every other value including Infinity
-- — so "NaN >= 0" is true but "NaN < 168" is false, and the compound
-- condition rejects NaN and +/-Infinity for free. Proved against live
-- Postgres in tests/test_task_response_models.py (not just asserted here).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_run_time_bounds'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_run_time_bounds
      CHECK (run_time IS NULL OR (run_time >= 0 AND run_time < 168))
      NOT VALID;
  END IF;
END $$;
