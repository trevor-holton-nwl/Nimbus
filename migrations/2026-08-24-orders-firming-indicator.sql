-- orders.firming_indicator (SAP FIXKZ) — already in schema.sql; this makes it deployable via the migrations ledger.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS firming_indicator TEXT;
