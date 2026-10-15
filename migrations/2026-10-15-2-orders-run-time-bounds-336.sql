-- migrations/2026-10-15-2-orders-run-time-bounds-336.sql
-- NAMING NOTE: the file name says 336 (the application-enforced scheduling cap), but the constraint this
-- file installs is the 8760-hour REPRESENTATION bound (run_time < 8760). The name stays because the deploy
-- ledger (migration_files_applied) is keyed by file name; the schema_migrations id says 8760.
-- Run-time cap (backward-scheduling OQ28). Destructive by text (DROP CONSTRAINT, then re-ADD).
--
-- chk_orders_run_time_bounds changes meaning: it was the 168-hour LIMIT on an order's run time
-- (added by 2026-09-25-orders-run-time-bounds.sql, validated by 2026-09-26-...-validate.sql); it
-- becomes a pure REPRESENTATION bound (0 <= run_time < 8760, the hours in a year), which still
-- rejects NaN and +/-Infinity (Postgres sorts NaN above every number, so "NaN < 8760" is false).
-- The LIMIT an order is scheduled with is now enforced in the application: a flat 336 hours
-- (no per-plant horizon term; db.cap_hours). A longer order is queued in Needs Planning
-- (reason code run_time_over_cap) at upload, rejected per id on a planner edit.
--
-- Widening a bound can never fail validation, so (unlike the 2026-09-25/26 pair) the NOT VALID add and
-- the VALIDATE share this one file/transaction on purpose: splitting them would leave a window with
-- no constraint at all between the DROP and the ADD. If `orders` grows large enough for the VALIDATE scan
-- under that lock to matter, split the ADD and the VALIDATE into two files, as the 2026-09-25/26 pair does.
--
-- Mirrored by schema.sql under the ledger id 'orders_run_time_bounds_8760' so re-applying schema.sql
-- to an already-initialised database raises the bound exactly once. The ledger row is also written
-- here, so the two paths agree whichever ran first. Safe to re-run.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_run_time_bounds;
ALTER TABLE orders
  ADD CONSTRAINT chk_orders_run_time_bounds
  CHECK (run_time IS NULL OR (run_time >= 0 AND run_time < 8760))
  NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT chk_orders_run_time_bounds;
INSERT INTO schema_migrations (id) VALUES ('orders_run_time_bounds_8760') ON CONFLICT DO NOTHING;
