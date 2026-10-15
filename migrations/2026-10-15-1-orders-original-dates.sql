-- migrations/2026-10-15-1-orders-original-dates.sql
-- Locked copies of the SAP start/finish as received (OQ31 b, OQ26). Destructive by text (ALTER, UPDATE).
--
-- The backfill UPDATE rewrites EVERY orders row, which bumps each row's xmin (the
-- optimistic-concurrency base_version): apply at deploy time, never mid-shift. It is guarded by the
-- schema_migrations ledger id 'orders_original_dates_backfill', so a re-apply (this file or schema.sql,
-- which mirrors it) never runs it twice.
--
-- Backfill rule: a row with NO order_sap_sent row still holds what SAP last sent, so
-- original_* = sap_basic_* when present, else basic_*. A row WITH a sent row has had its original
-- overwritten by NIMBUS's own send, so original_* = basic_* (the original is lost; the owner list query
-- in docs/MIGRATION.md names those rows). order_distribution has no sent-row distinction: finish only.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_start_received  TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_finish_received TIMESTAMP;
ALTER TABLE order_distribution ADD COLUMN IF NOT EXISTS original_finish_received TIMESTAMP;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'orders_original_dates_backfill') THEN
    UPDATE orders o SET
      original_finish_received = CASE WHEN s.order_id IS NULL THEN COALESCE(o.sap_basic_finish_date, o.basic_finish_date) ELSE o.basic_finish_date END,
      original_start_received  = CASE WHEN s.order_id IS NULL THEN COALESCE(o.sap_basic_start_date,  o.basic_start_date)  ELSE o.basic_start_date  END
    FROM orders o2 LEFT JOIN order_sap_sent s ON s.order_id = o2.id
    WHERE o2.id = o.id;
    UPDATE order_distribution SET original_finish_received = basic_finish_date WHERE original_finish_received IS NULL;
    INSERT INTO schema_migrations (id) VALUES ('orders_original_dates_backfill');
  END IF;
END
$mig$;
