-- 2026-09-18: allow unconfigured SAP work centers
--
-- Drops sap_workcenter's table-level CHECK
--   (distribution_mode = 'distribute' OR default_machine IS NOT NULL)
-- so a work center can be created with only (plant, sap_workcenter, description).
-- distribution_mode defaults to 'single', which made that minimal insert violate the
-- CHECK, so there was previously no valid three-field row at all. SAP work centers are
-- source data: they arrive via the SAP interface or by hand in Manage Plant Data, and
-- the policy fields (mode, default machine, max separation, ...) get filled in later.
--
-- The rule itself is NOT lost. It stays enforced where a human configures policy:
--   * PUT /distribution/{plant}/workcenters/{wc} still raises
--     single_mode_without_default (backend/distribution/data.py).
--   * The Work Centers tab pre-flight-gates the write client-side (_wcBlockReason).
--   * The generic grid emits a single_mode_without_default warning
--     (backend/master_data/routes.py).
-- Ingest already treats an unconfigured work center as a first-class state:
-- service.classify_row leaves the order as a plain order carrying a
-- default_machine_invalid warning.
--
-- Status: Idempotent, metadata-only. Touches no row data and needs no backfill; no
-- existing row can violate the constraint being removed, since such a row could never
-- have been inserted. Contains DROP/ALTER, so it trips apply-migrations.ps1's
-- destructive-verb gate -- apply with -AllowDestructive as its own deliberate step,
-- never folded into a routine roll.

DO $$
DECLARE cname TEXT;
BEGIN
  IF to_regclass('sap_workcenter') IS NULL THEN
    RETURN;
  END IF;

  -- NOTE: this predicate assumes exactly ONE check constraint on sap_workcenter
  -- mentions default_machine. That is true today -- the only other CHECKs are the
  -- column-level distribution_mode IN (...) and max_separation IN (...), neither of
  -- which names default_machine. If a future schema change adds a second table-level
  -- CHECK referencing that column, this block would drop an arbitrary one of them.
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'sap_workcenter'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%default_machine%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sap_workcenter DROP CONSTRAINT %I', cname);
  END IF;
END $$;
