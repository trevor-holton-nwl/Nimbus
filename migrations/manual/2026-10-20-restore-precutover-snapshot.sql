-- migrations/manual/2026-10-20-restore-precutover-snapshot.sql
-- nimbus-migration: manual-only
-- ROLLBACK for the backward-scheduling cutover (migrations/2026-10-20-1-backward-cutover.sql).
-- Not applied by any routine deploy: it lives under migrations/manual/ (the runner lists migrations/*.sql
-- non-recursively) and carries the manual-only marker. To run it, copy it next to a scratch -MigrationsDir or
-- run it with psql --single-transaction -f; see docs/DEPLOYMENT.md, "Backward-scheduling cutover" rollback matrix.
--
-- What it restores, from the three snapshot tables taken by 2026-10-20-0:
--   * orders: scheduled_start, scheduled_end, manual_firmed, firming_indicator, runtime_schedule_mismatch,
--     placement_exception, for every order that is in the snapshot (matched by id). updated_at is set to now()
--     (NOT the snapshot value) so client caches that key on it re-read the restored rows.
--   * order_schedule_segments: for every order in the snapshot, current fragments are deleted and the snapshot
--     fragments re-inserted.
--   * order_sap_sent is not touched: the cutover never writes it, so it needs no restore.
-- Orders created after the snapshot are left exactly as they are.
-- WARNING: anything a planner saved after the cutover (placements, firm flags, segments) on the restored
-- columns is OVERWRITTEN. Restore only inside the rollback window, before planners start saving, and with the
-- previous image rolled back first (the old image is forward-scheduling and needs these columns as they were).
-- Run it in ONE transaction (the deploy runner and psql --single-transaction both do).
DO $mig$
BEGIN
  IF to_regclass('orders_precutover_snapshot') IS NULL
     OR to_regclass('order_schedule_segments_precutover_snapshot') IS NULL THEN
    RAISE EXCEPTION 'pre-cutover snapshot tables not found; nothing to restore from';
  END IF;

  UPDATE orders o SET
    scheduled_start = s.scheduled_start,
    scheduled_end = s.scheduled_end,
    manual_firmed = s.manual_firmed,
    firming_indicator = s.firming_indicator,
    runtime_schedule_mismatch = s.runtime_schedule_mismatch,
    placement_exception = s.placement_exception,
    updated_at = now()
  FROM orders_precutover_snapshot s
  WHERE o.id = s.id;

  DELETE FROM order_schedule_segments g
   USING orders_precutover_snapshot s WHERE g.order_id = s.id;
  INSERT INTO order_schedule_segments
    SELECT (jsonb_populate_record(NULL::order_schedule_segments, to_jsonb(g))).*
    FROM order_schedule_segments_precutover_snapshot g;
END
$mig$;
