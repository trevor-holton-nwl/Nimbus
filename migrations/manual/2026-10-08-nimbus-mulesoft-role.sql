-- ============================================================================
-- Hand-applied: least-privilege login for Mulesoft (SAP staging)
-- Date: 2026-10-08  |  Design of record: docs/SAP_STAGING_DESIGN.md
-- ============================================================================
-- ENVIRONMENT-SPECIFIC. Run by hand by a DB admin against the target server,
-- after migrations/2026-10-08-sap-staging-tables.sql. Never applied by the
-- deploy runner (migrations/manual/ is not listed). Idempotent: safe to re-run.
--
-- Mulesoft writes inbound snapshots into the staging tables and reads/updates
-- the outbound queue; it has no access to any live NIMBUS table. It can only
-- INSERT the columns SAP supplies: NIMBUS-owned housekeeping (row_status,
-- reject_reason, received_at, applied_at), the key columns NIMBUS resolves at
-- validation, and the batch header's status / counts / warnings are out of
-- reach, and a trigger pins the batch status machine for this login.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nimbus_mulesoft') THEN
    CREATE ROLE nimbus_mulesoft LOGIN;
  END IF;
END $$;

-- The password is set out of band and NEVER committed:
--   ALTER ROLE nimbus_mulesoft PASSWORD '<set-by-DB-admin>';

GRANT USAGE ON SCHEMA public TO nimbus_mulesoft;

-- Reads (to check what it loaded). A re-run first drops any older, broader
-- table-level INSERT so only the column-level grants below remain.
REVOKE INSERT ON sap_stage_batch,
                 sap_stage_material_plant,
                 sap_stage_planned_order,
                 sap_stage_production_version,
                 sap_stage_routing_operation
    FROM nimbus_mulesoft;
GRANT SELECT ON sap_stage_batch,
                sap_stage_material_plant,
                sap_stage_planned_order,
                sap_stage_production_version,
                sap_stage_routing_operation
    TO nimbus_mulesoft;

-- Inbound row tables: INSERT every column EXCEPT the housekeeping ones and the
-- resolved key columns (generated from the live column list, so it follows the
-- table). material_id / plant / production_order are resolved by NIMBUS on the
-- material-plant and planned-order tables; on the two routing tables plant and
-- material_id are SAP-supplied, so only the housekeeping columns are excluded.
DO $$
DECLARE
  spec  RECORD;
  cols  TEXT;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('sap_stage_material_plant',       ARRAY['id','row_status','reject_reason','received_at','applied_at','material_id','plant','production_order']),
      ('sap_stage_planned_order',        ARRAY['id','row_status','reject_reason','received_at','applied_at','material_id','plant','production_order']),
      ('sap_stage_production_version',   ARRAY['id','row_status','reject_reason','received_at','applied_at']),
      ('sap_stage_routing_operation',    ARRAY['id','row_status','reject_reason','received_at','applied_at'])
    ) AS v(tbl, excluded)
  LOOP
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = spec.tbl
       AND NOT (column_name = ANY (spec.excluded));
    IF cols IS NOT NULL THEN
      EXECUTE format('GRANT INSERT (%s) ON %I TO nimbus_mulesoft', cols, spec.tbl);
    END IF;
  END LOOP;
END $$;

-- Batch header: Mulesoft states what it is sending; status takes its DEFAULT
-- ('loading'), and validated_at / applied_at / applied_by / counts / warnings
-- stay NIMBUS-owned.
REVOKE UPDATE ON sap_stage_batch FROM nimbus_mulesoft;
-- received_at / created_by are NOT grantable: received_at is the server's DEFAULT now() (a future-dated header
-- would otherwise be the "newest" batch forever and supersede every real one); created_by is NIMBUS's.
GRANT INSERT (batch_id, object_key, plant, source, row_count_expected, error)
    ON sap_stage_batch TO nimbus_mulesoft;
-- Mulesoft may only flip a batch to 'ready' / 'rejected' (and say how many rows it sent).
GRANT UPDATE (status, ready_at, row_count_expected, error) ON sap_stage_batch TO nimbus_mulesoft;

-- Status guard for this login: a new batch is always 'loading' (and 'mulesoft'
-- sourced, so it cannot pose as an upload to skip the completeness gate); an
-- update may only move 'loading' -> 'ready' or 'rejected' (or touch a batch that
-- is still 'loading'). Every other role (NIMBUS itself) is unaffected.
CREATE OR REPLACE FUNCTION sap_stage_batch_mulesoft_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_user = 'nimbus_mulesoft' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.status := 'loading';
      NEW.source := 'mulesoft';
      NEW.received_at := now();
      NEW.ready_at := NULL;
    ELSIF NOT (OLD.status = 'loading' AND NEW.status IN ('loading', 'ready', 'rejected')) THEN
      RAISE EXCEPTION 'nimbus_mulesoft may only move a batch from loading to ready or rejected (batch %, % -> %)',
        OLD.batch_id, OLD.status, NEW.status;
    ELSE
      -- Timestamps are server time: the UPDATE grant still lists ready_at (Mulesoft's documented
      -- `SET ready_at = now()` keeps working) but the value is forced, so a client clock can never reorder batches.
      NEW.received_at := OLD.received_at;
      IF NEW.status = 'ready' THEN
        NEW.ready_at := now();
      ELSE
        NEW.ready_at := OLD.ready_at;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_sap_stage_batch_mulesoft_guard ON sap_stage_batch;
CREATE TRIGGER trg_sap_stage_batch_mulesoft_guard
    BEFORE INSERT OR UPDATE ON sap_stage_batch
    FOR EACH ROW EXECUTE FUNCTION sap_stage_batch_mulesoft_guard();

-- Outbound queue: read ready rows, report sent / error per row.
GRANT SELECT ON sap_stage_planned_order_out TO nimbus_mulesoft;
GRANT UPDATE (row_status, sent_at, error_text) ON sap_stage_planned_order_out TO nimbus_mulesoft;

-- BIGSERIAL sequences behind the inbound id columns.
GRANT USAGE, SELECT ON SEQUENCE sap_stage_material_plant_id_seq,
                                sap_stage_planned_order_id_seq,
                                sap_stage_production_version_id_seq,
                                sap_stage_routing_operation_id_seq,
                                sap_stage_planned_order_out_id_seq
    TO nimbus_mulesoft;

-- Re-run this file if a staging table is ever dropped and recreated (grants go
-- with the table). Network side: a firewall rule for the Mulesoft egress IPs and
-- sslmode=require are documented in docs/DEPLOYMENT.md.
