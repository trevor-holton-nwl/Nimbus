-- migrations/2026-10-16-1-orders-placement-exception.sql
-- Placement-exception marker on a placed order (backward scheduling OQ50). Destructive by text (ALTER).
--
-- A planner may deliberately place a bar off its run-time width: 'overtime' (on non-working time) or
-- 'overlong' (wider than the run time). The marker tells the save path's width check to stand down for
-- that bar. NULL = a normal bar. Adding a nullable column rewrites no rows and bumps no xmin.
--
-- The inline CHECK is created only when the column is, so the statement is idempotent (a re-run, or
-- schema.sql which mirrors this file, finds the column and does nothing).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS placement_exception TEXT NULL
  CONSTRAINT chk_orders_placement_exception CHECK (placement_exception IN ('overtime', 'overlong'));
