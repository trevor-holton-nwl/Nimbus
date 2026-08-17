-- System Configuration: global (not per-user, not per-plant) admin-configured
-- settings, singleton row (id always 1). Currently holds orderFields: which
-- optional Orders fields show by default in the AG Grid / Inspector panel.
-- Idempotent — safe to re-apply. Mirrors the table added to schema.sql.
CREATE TABLE IF NOT EXISTS system_settings (
    id         INTEGER PRIMARY KEY DEFAULT 1,
    settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_system_settings_singleton CHECK (id = 1)
);
INSERT INTO system_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
