-- Add a covering index for order_distribution's list/summary read path
--
-- Why: _fetch_header_rows (backend/distribution/data.py) filters on `plant`
-- and orders by `basic_start_date ASC NULLS LAST, reviewed ASC,
-- production_order ASC, material_number ASC` (D42 -- the trailing two
-- columns are a stable tiebreaker so paging never reorders same-start-date
-- rows between pages). The only existing index, idx_order_distribution_wc
-- (plant, sap_workcenter, reviewed), doesn't serve that query's WHERE/ORDER
-- BY shape. This index does, matching the ORDER BY column-for-column so
-- Postgres can satisfy the sort from the index instead of a sort node.
--
CREATE INDEX IF NOT EXISTS idx_order_distribution_plant_start
    ON order_distribution (plant, basic_start_date, reviewed, production_order, material_number);
