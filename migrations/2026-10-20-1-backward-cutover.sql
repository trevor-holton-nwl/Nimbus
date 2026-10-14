-- migrations/2026-10-20-1-backward-cutover.sql
-- Backward-scheduling global cutover (OQ3, OQ5, OQ52, OQ53). Destructive by text (UPDATE, DELETE).
-- Apply AFTER migrations/2026-10-20-0-orders-precutover-snapshot.sql, in its own deploy run.
--
-- Every non-queued order loses its placed start and end (so it reads as never placed and re-derives from
-- its due date on first load under the new image) and is flagged runtime_schedule_mismatch. A RUNNING row
-- keeps its start AND its old end. Placement markers are cleared, schedule segments of non-queued orders
-- are removed, and every touched row's updated_at moves. Queued rows are untouched.
-- Guarded by the schema_migrations ledger id 'backward_scheduling_cutover': a re-run is a no-op.
-- schema.sql mirrors this block, so a developer database that re-applies schema.sql loses its local
-- placed finishes once.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'backward_scheduling_cutover') THEN
    -- running = a planner-placed start at or before plant-local now and the old effective end after it
    -- (Task 0 ruling: real column names — plants.plant (PK is (subnetwork, plant); MIN(timezone) per plant as
    --  sap_staging.py does, a plant may sit in two subnetworks), orders.planning_status = 'needs_planning',
    --  order_schedule_segments.scheduled_end; plant-local naive now is simply now() AT TIME ZONE tz.)
    WITH plant_now AS (
      SELECT p.plant, now() AT TIME ZONE COALESCE(NULLIF(MIN(p.timezone),''),'UTC') AS pnow
      FROM plants p GROUP BY p.plant
    ), old_end AS (
      SELECT o.id, COALESCE(MAX(s.scheduled_end), o.scheduled_start + (o.run_time * INTERVAL '1 hour'), o.scheduled_end) AS old_end
      FROM orders o LEFT JOIN order_schedule_segments s ON s.order_id = o.id GROUP BY o.id
    ), running AS (
      SELECT o.id, e.old_end FROM orders o JOIN plant_now pn ON pn.plant = o.plant JOIN old_end e ON e.id = o.id
      WHERE o.scheduled_start IS NOT NULL AND o.scheduled_start <= pn.pnow AND e.old_end > pn.pnow
    )
    UPDATE orders o SET
      -- Task 0 ruling B4 (OQ3/OQ5): a running row keeps BOTH its start and its old forward end so it still
      -- reads as running (server _order_is_running needs both edges; client isInProgress needs now < end)
      -- even when its due date is already past. Every other row loses both edges and re-derives from its due date.
      scheduled_start = CASE WHEN r.id IS NOT NULL THEN o.scheduled_start ELSE NULL END,
      scheduled_end   = CASE WHEN r.id IS NOT NULL THEN r.old_end        ELSE NULL END,
      placement_exception = NULL,
      runtime_schedule_mismatch = TRUE,
      updated_at = now()
    FROM (SELECT id FROM orders) a LEFT JOIN running r ON r.id = a.id
    WHERE o.id = a.id AND o.planning_status <> 'needs_planning';
    DELETE FROM order_schedule_segments s USING orders o WHERE s.order_id = o.id AND o.planning_status <> 'needs_planning';
    INSERT INTO schema_migrations (id) VALUES ('backward_scheduling_cutover');
  END IF;
END
$mig$;
