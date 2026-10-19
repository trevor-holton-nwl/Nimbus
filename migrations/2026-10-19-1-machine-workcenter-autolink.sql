-- migrations/2026-10-19-1-machine-workcenter-autolink.sql
-- Backfill: link each machine to the SAP work center that shares its ID (owner decision 2026-10-19;
-- the live rule is master_data._autolink_same_named_machines, which this mirrors in SQL).
-- Contains UPDATE: deploy with -Only 2026-10-19-1-machine-workcenter-autolink -AllowDestructive.
-- It touches only machines whose link is EMPTY; an existing link is never re-pointed. Ledger id
-- 'machine_workcenter_autolink_backfill' keeps a re-apply (this file or schema.sql, which mirrors it)
-- from running it twice; going forward the application does it on every machine / work center write.
--
-- A machine is linked (machine.sap_workcenter = machine) only when ALL hold:
--   * a work center with the same plant and code exists (exact text match);
--   * the work center is 'single' mode (an aggregate is skipped);
--   * no machine is a member of that work center yet;
--   * exactly one machine of that name exists in the plant (the key is subnetwork + plant + machine,
--     so a name repeated across subnetworks is skipped, never guessed).
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'machine_workcenter_autolink_backfill') THEN
    UPDATE machine m SET sap_workcenter = m.machine, updated_at = NOW()
      FROM sap_workcenter w
     WHERE w.plant = m.plant AND w.sap_workcenter = m.machine
       AND m.sap_workcenter IS NULL AND w.distribution_mode = 'single'
       AND NOT EXISTS (SELECT 1 FROM machine o WHERE o.plant = m.plant AND o.sap_workcenter = w.sap_workcenter)
       AND (SELECT count(*) FROM machine d WHERE d.plant = m.plant AND d.machine = m.machine) = 1;
    INSERT INTO schema_migrations (id) VALUES ('machine_workcenter_autolink_backfill');
  END IF;
END
$mig$;
