-- Remove Backlog requires a plant-authoritative IANA timezone. Keep this
-- additive: existing plants remain schedulable by legacy modes until a planner
-- fills the value, while Remove Backlog blocks rather than guessing a browser
-- timezone.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS timezone TEXT;

INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order)
VALUES ('plants', 'timezone', 'Plant Timezone (IANA)', FALSE, 5)
ON CONFLICT (table_name, column_name) DO NOTHING;
