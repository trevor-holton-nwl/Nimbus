-- NIMBUS performance migration
-- Run once against the nimbus Postgres database.
-- Safe to re-run (IF NOT EXISTS guard).
--
-- What this does:
--   Creates a composite expression index on
--   (production_line, COALESCE(scheduled_start, basic_start_date)).
--
--   PostgreSQL recognises this as matching the ORDER BY expression in
--   query_orders() and uses the index automatically — no code change needed,
--   no schema column added. The index eliminates the full seq-scan + sort on
--   every /tasks request.
--
-- When to run: any time after the server is up. The index build takes a few
-- seconds on current data size and does NOT lock the table (no CONCURRENTLY
-- needed for a small table, but safe to add if desired).

CREATE INDEX IF NOT EXISTS idx_orders_line_eff_start
  ON orders(production_line, COALESCE(scheduled_start, basic_start_date));
