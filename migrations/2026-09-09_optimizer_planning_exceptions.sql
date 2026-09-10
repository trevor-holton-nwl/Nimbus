-- Durable optimizer exceptions. Apply before deploying dependent application.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS planning_status TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS planning_reason JSONB;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_planning_state_check'
                   AND conrelid = 'orders'::regclass) THEN
        ALTER TABLE orders ADD CONSTRAINT orders_planning_state_check CHECK (
            (planning_status = 'scheduled' AND planning_reason IS NULL)
            OR (planning_status = 'needs_planning'
                AND scheduled_start IS NULL AND scheduled_end IS NULL
                AND planning_reason IS NOT NULL
                AND jsonb_typeof(planning_reason) = 'object'
                AND planning_reason ? 'code' AND planning_reason ? 'message'
                AND jsonb_typeof(planning_reason->'code') = 'string'
                AND jsonb_typeof(planning_reason->'message') = 'string')
        );
    END IF;
END $$;
