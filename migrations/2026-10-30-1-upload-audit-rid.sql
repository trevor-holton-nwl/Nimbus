-- ============================================================================
-- Migration: upload_audit.rid (Admin Cockpit exact request-id join key)
-- Date: 2026-10-30
-- Purely additive and idempotent: one nullable column; no backfill, no existing
-- data is touched. Mirrors the upload_audit block in schema.sql. Older rows keep
-- rid NULL and simply fall back to the Logs timeline's "possible" correlation.
-- ============================================================================

ALTER TABLE upload_audit ADD COLUMN IF NOT EXISTS rid TEXT;
