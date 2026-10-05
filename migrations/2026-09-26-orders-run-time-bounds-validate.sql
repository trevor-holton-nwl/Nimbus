-- H8, step 2 of 2 (Wave-0 final review, Finding 1): VALIDATE CONSTRAINT for
-- chk_orders_run_time_bounds, added NOT VALID by
-- migrations/2026-09-25-orders-run-time-bounds.sql. Deliberately a SEPARATE,
-- LATER-dated file (not the same file, and NOT
-- "2026-09-25-orders-run-time-bounds-validate.sql" -- that name would sort
-- BEFORE "2026-09-25-orders-run-time-bounds.sql" itself under this repo's
-- migration runner, which does plain Sort-Object Name over filenames: '-'
-- (0x2D) sorts before '.' (0x2E), so the "-validate" suffix loses to the
-- shorter base name and would run first, before the constraint it's meant to
-- validate even exists). A later calendar date avoids that trap entirely.
--
-- Running this as its own file/transaction means the ADD CONSTRAINT step's
-- ACCESS EXCLUSIVE lock is already long released by the time this scan
-- starts -- this step only takes SHARE UPDATE EXCLUSIVE, so it doesn't block
-- concurrent reads/writes on the actively-written `orders` table. If this
-- step fails (existing data violates the bound), the NOT VALID constraint
-- from the other file is UNAFFECTED and keeps blocking new bad writes; only
-- this file needs re-running (after data cleanup) -- see docs/MIGRATION.md's
-- H8 section for the pre-deploy data check.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_orders_run_time_bounds' AND NOT convalidated
  ) THEN
    ALTER TABLE orders VALIDATE CONSTRAINT chk_orders_run_time_bounds;
  END IF;
END $$;
