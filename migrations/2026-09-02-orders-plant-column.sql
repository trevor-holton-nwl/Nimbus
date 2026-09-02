-- orders.plant — per-order plant attribution, plus its two supporting indexes
-- and a NULL-only backfill. Ledger-only rebuilds (the documented Azure deploy
-- path — migrations/ applied via promote-azure, schema.sql never re-run
-- there) previously had no path to this column: schema.sql originally added
-- it far too late (after several dependents already referenced orders.plant),
-- and no migrations/ file carried it at all. schema.sql has since been fixed
-- to add the column immediately after CREATE TABLE orders; this file gives
-- the migration-ledger path the same column + indexes + backfill,
-- independent of schema.sql ever having been run. Idempotent: ADD COLUMN IF
-- NOT EXISTS, CREATE INDEX IF NOT EXISTS, and a NULL-only backfill — safe to
-- re-run.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plant TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_plant ON orders(plant);
-- Partial index: the post-machine-change re-attribution and ingest derivation scan
-- orders WHERE plant IS NULL; a plain btree won't serve IS NULL efficiently, so
-- index just the NULL-plant rows by machine (kept tiny — most rows are attributed).
CREATE INDEX IF NOT EXISTS idx_orders_plant_null ON orders(machine) WHERE plant IS NULL;

-- Only derive plant when the machine code maps to EXACTLY ONE plant. A machine code shared
-- across plants cannot be attributed from the code alone, so those rows are left NULL
-- (the app surfaces this) instead of being silently assigned to the lowest plant code.
UPDATE orders o
   SET plant = (
       SELECT MIN(pl.plant) FROM machine pl
        WHERE pl.machine = o.machine
   )
 WHERE o.plant IS NULL
   AND (
       SELECT COUNT(DISTINCT pl.plant) FROM machine pl
        WHERE pl.machine = o.machine
   ) = 1;
