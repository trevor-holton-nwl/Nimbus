-- migrations/2026-10-16-2-orders-original-finish-date-only.sql
-- Backward scheduling D10 (validation finding VI12): whether the SAP finish arrived as a date with no time.
-- Send to SAP reads it to transmit the close of the plant's working window on that date instead of a
-- zone-converted midnight (which moved the date for any plant east of the SAP system zone).
-- Additive and idempotent. New ingests write the flag from what SAP sent; the one-time backfill below marks
-- existing rows whose locked finish sits at exact midnight (the only evidence available for old rows).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_finish_date_only BOOLEAN NOT NULL DEFAULT FALSE;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'orders_original_finish_date_only_backfill') THEN
    UPDATE orders SET original_finish_date_only = TRUE
     WHERE original_finish_received IS NOT NULL AND original_finish_received::time = TIME '00:00:00';
    INSERT INTO schema_migrations (id) VALUES ('orders_original_finish_date_only_backfill');
  END IF;
END
$mig$;
