-- SAP-is-truth firming: planner firm flag + SAP baseline columns on orders.
-- Additive + idempotent; ALTERs trip -AllowDestructive — verified additive.
-- No backfill: NULL baselines = unknown, never an SAP change.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_firmed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_workcenter TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_production_version TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_basic_start_date TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_basic_finish_date TIMESTAMP;
