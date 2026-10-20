-- migrations/2026-10-19-2-rounding-value-label.sql
-- Display-label rename: material_plants.incremental_lot_size is now shown as "Rounding Value".
-- schema.sql seeds column_metadata with ON CONFLICT DO NOTHING, so existing databases keep the old
-- label; this updates it. The display_label guard leaves an admin-customized label alone.
-- Idempotent (a second run matches no rows), so it needs no schema_migrations ledger entry.
-- Contains UPDATE: deploy with -Only 2026-10-19-2-rounding-value-label -AllowDestructive.
UPDATE column_metadata
   SET display_label = 'Rounding Value'
 WHERE table_name = 'material_plants'
   AND column_name = 'incremental_lot_size'
   AND display_label = 'Incremental Lot Size';
