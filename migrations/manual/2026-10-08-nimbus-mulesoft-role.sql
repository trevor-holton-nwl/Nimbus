-- ============================================================================
-- Hand-applied: least-privilege login for Mulesoft (SAP staging)
-- Date: 2026-10-08  |  Design of record: docs/SAP_STAGING_DESIGN.md
-- ============================================================================
-- ENVIRONMENT-SPECIFIC. Run by hand by a DB admin against the target server,
-- after migrations/2026-10-08-sap-staging-tables.sql. Never applied by the
-- deploy runner (migrations/manual/ is not listed).
--
-- Mulesoft writes inbound snapshots into the staging tables and reads/updates
-- the outbound queue; it has no access to any live NIMBUS table.
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

-- Inbound: header + the four staging tables (insert rows, read back for checks).
GRANT SELECT, INSERT ON sap_stage_batch,
                        sap_stage_material_plant,
                        sap_stage_planned_order,
                        sap_stage_production_version,
                        sap_stage_routing_operation
    TO nimbus_mulesoft;

-- Mulesoft may only flip a batch to 'ready' (and say how many rows it sent).
GRANT UPDATE (status, ready_at, row_count_expected, error) ON sap_stage_batch TO nimbus_mulesoft;

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
