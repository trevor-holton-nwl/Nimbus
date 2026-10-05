-- Stable line identity required by orders ingestion.  Safe to apply repeatedly:
-- these columns were added to schema.sql after the pilot database was created.
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS line_key TEXT
    GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || production_line) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lines_line_key ON production_lines(line_key);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS line_key TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_line_key ON orders(line_key);
CREATE INDEX IF NOT EXISTS idx_orders_line_key_null
    ON orders(production_line, plant) WHERE line_key IS NULL;
