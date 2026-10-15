-- migrations/2026-10-20-0-orders-precutover-snapshot.sql
-- nimbus-migration: manual-only
-- (the deploy runner SKIPS this file in every mode, -AllowDestructive included; apply it deliberately with
--  -Only 2026-10-20-0 in the cutover window, immediately before the cutover -- see docs/DEPLOYMENT.md)
-- Pre-cutover snapshot for the backward-scheduling cutover (migrations/2026-10-20-1-backward-cutover.sql).
-- Plain copies of the order dates and flags, the schedule segments and the SAP-sent rows, taken once
-- BEFORE the cutover rewrites placed finishes. It is the recovery path if the cutover must be reviewed.
--
-- The orders copy holds the columns the cutover writes or reads (the SAP originals are never touched by it).
-- Read-only on existing data: three CREATE TABLE ... AS SELECT statements, no indexes, no constraints.
-- Guarded by the schema_migrations ledger id 'backward_cutover_snapshot', so a re-run (this file, or
-- schema.sql which mirrors it) takes no second snapshot and never overwrites the first. Apply this file
-- BEFORE the cutover file; the cutover file is the destructive one and ships in its own deploy run.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'backward_cutover_snapshot') THEN
    CREATE TABLE orders_precutover_snapshot AS
      SELECT id, plant, machine, planning_status, run_time,
             basic_start_date, basic_finish_date,
             scheduled_start, scheduled_end,
             manual_firmed, firming_indicator,
             runtime_schedule_mismatch, placement_exception,
             updated_at
      FROM orders;
    CREATE TABLE order_schedule_segments_precutover_snapshot AS
      SELECT * FROM order_schedule_segments;
    CREATE TABLE order_sap_sent_precutover_snapshot AS
      SELECT * FROM order_sap_sent;
    INSERT INTO schema_migrations (id) VALUES ('backward_cutover_snapshot');
  END IF;
END
$mig$;
