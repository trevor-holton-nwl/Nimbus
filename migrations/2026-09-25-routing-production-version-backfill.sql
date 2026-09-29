-- ---------------------------------------------------------------------------
-- One-time BACKFILL of orders.run_time_source for legacy orders.
--
-- When an order has a non-NULL run_time but no run_time_source, it came from
-- a pre-2026-09-24 schedule (before the routing-runtime feature existed). This
-- migration marks such orders as 'legacy' source, so the optimizer and Inspector
-- can distinguish them from routing-computed, manual, distributed, or SAP-owned
-- run_time values. This is a ledger-guarded, one-time, deploy-time-only
-- migration that must never re-run for a given deployment.
-- ---------------------------------------------------------------------------
DO $mig$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'routing_runtime_legacy_backfill') THEN
        UPDATE orders SET run_time_source = 'legacy'
         WHERE run_time IS NOT NULL AND run_time_source IS NULL;
        INSERT INTO schema_migrations (id) VALUES ('routing_runtime_legacy_backfill');
    END IF;
END
$mig$;
