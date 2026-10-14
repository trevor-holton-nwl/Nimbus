-- migrations/2026-10-15-2-orders-run-time-bounds-336.sql
-- Run-time cap (backward-scheduling OQ28). Destructive by text (DROP CONSTRAINT, then re-ADD).
--
-- chk_orders_run_time_bounds changes meaning: it was the 168-hour LIMIT on an order's run time
-- (added by 2026-09-25-orders-run-time-bounds.sql, validated by 2026-09-26-...-validate.sql); it
-- becomes a pure REPRESENTATION bound (0 <= run_time < 8760, the hours in a year), which still
-- rejects NaN and +/-Infinity (Postgres sorts NaN above every number, so "NaN < 8760" is false).
-- The LIMIT an order is scheduled with is now enforced in the application: 336 hours, or the plant's
-- visibility horizon when that is shorter (db.cap_hours). A longer order is queued in Needs Planning
-- (reason code run_time_over_cap) at upload, rejected per id on a planner edit.
--
-- Widening a bound can never fail validation, so (unlike the 2026-09-25/26 pair) the NOT VALID add and
-- the VALIDATE share this one file/transaction on purpose: splitting them would leave a window with
-- no constraint at all between the DROP and the ADD. The brief for this task asked for exactly this.
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
