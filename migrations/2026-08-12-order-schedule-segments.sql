-- ============================================================================
-- Migration: durable split-order schedule aggregate + plant allocation policy
-- Date: 2026-08-12
--
-- Additive only. Apply before deploying the corresponding application build.
-- Parent orders.xmin is the sole concurrency token; segment rows are never
-- independently exposed or updated by the API.
-- ============================================================================

CREATE TABLE IF NOT EXISTS order_schedule_segments (
    order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    segment_no       INTEGER NOT NULL CHECK (segment_no > 0),
    scheduled_start  TIMESTAMP NOT NULL,
    scheduled_end    TIMESTAMP NOT NULL,
    PRIMARY KEY (order_id, segment_no),
    CHECK (scheduled_end > scheduled_start)
);

CREATE INDEX IF NOT EXISTS idx_order_schedule_segments_order_start
    ON order_schedule_segments(order_id, scheduled_start);

-- An ingest-side RUN_TIME change must not quietly make the prior authoritative
-- NIMBUS timing look valid. The next browser calendar hydration regenerates
-- the complete aggregate or keeps this diagnostic visible on failure.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS runtime_schedule_mismatch BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE plants
    ADD COLUMN IF NOT EXISTS split_order_policy TEXT NOT NULL DEFAULT 'never';
