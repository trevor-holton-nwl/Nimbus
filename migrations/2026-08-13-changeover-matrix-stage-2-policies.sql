-- Changeover Matrix Stage 2: typed plant-scoped setup policy sidecar.
-- Policies are intentionally disabled by default; this migration does not
-- enable scheduling behavior or mutate existing schedules.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS setup_policy_config JSONB NOT NULL DEFAULT
  '{"dueDateFirstEnabled": false, "minChangeoverEnabled": false, "throughputEnabled": false, "throughputMinSavingsMin": 60, "throughputMaxSlipMin": 1440, "version": 1}'::jsonb;
