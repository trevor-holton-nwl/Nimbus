-- ============================================================================
-- Migration: Changeover Matrix Stage 0 persistence foundation
-- Date: 2026-08-13
-- ============================================================================
-- This migration is additive and idempotent. It persists setup definitions,
-- matrix values, observed line state, and exact occurrence overrides only.
-- It intentionally does not alter order placement, duration, utilization,
-- alerts, or the existing production_lines.excl_optimizer setting.
--
-- Setup minutes are finite INTEGER values from zero through 10080 inclusive
-- (seven days). JSON state keys and definition fields are canonical ordered
-- JSON arrays; application validation supplies their field-level semantics.
-- ============================================================================

-- setup_compatible is deliberately distinct from excl_optimizer. A FALSE value
-- prevents only setup-aware optimization for a signature-incompatible line;
-- setup data and diagnostics remain visible. The reason preserves that choice.
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS setup_compatible BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS setup_compatibility_reason TEXT;

-- One current definition per plant. Increment signature_version whenever the
-- ordered field signature changes; later writes must use that exact version.
CREATE TABLE IF NOT EXISTS setup_definition (
    plant             TEXT PRIMARY KEY,
    fields            JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
    signature_version INTEGER NOT NULL CHECK (signature_version > 0),
    strict_blanks     BOOLEAN NOT NULL DEFAULT TRUE,
    active            BOOLEAN NOT NULL DEFAULT FALSE,
    created_by        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by        TEXT,
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- A blank line scope is the plant-wide value; a nonblank line is a sparse
-- override. JSONB participates in the primary key so canonical array order is
-- significant and duplicate transitions are rejected within each version.
CREATE TABLE IF NOT EXISTS setup_matrix (
    plant             TEXT NOT NULL,
    line              TEXT NOT NULL DEFAULT '',
    signature_version INTEGER NOT NULL CHECK (signature_version > 0),
    from_key          JSONB NOT NULL CHECK (jsonb_typeof(from_key) = 'array'),
    to_key            JSONB NOT NULL CHECK (jsonb_typeof(to_key) = 'array'),
    setup_min         INTEGER NOT NULL CHECK (setup_min BETWEEN 0 AND 10080),
    source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'derived', 'actual')),
    source_metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_reference  TEXT,
    created_by        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by        TEXT,
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plant, line, signature_version, from_key, to_key)
);
CREATE INDEX IF NOT EXISTS idx_setup_matrix_plant_line_version
    ON setup_matrix (plant, line, signature_version);

-- The most recently accepted physical setup state for each plant/line.
CREATE TABLE IF NOT EXISTS line_setup_state (
    plant             TEXT NOT NULL,
    line              TEXT NOT NULL,
    state_key         JSONB NOT NULL CHECK (jsonb_typeof(state_key) = 'array'),
    signature_version INTEGER NOT NULL CHECK (signature_version > 0),
    physical_mold_id  TEXT,
    observed_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    source            TEXT NOT NULL CHECK (source IN ('manual', 'derived', 'actual')),
    reason            TEXT,
    created_by        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by        TEXT,
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plant, line)
);

-- An override represents remaining physical setup work for one exact observed
-- adjacency. It is not a persisted pseudo-order or a dependency relationship.
CREATE TABLE IF NOT EXISTS setup_occurrence_override (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant                TEXT NOT NULL,
    line                 TEXT NOT NULL,
    signature_version    INTEGER NOT NULL CHECK (signature_version > 0),
    predecessor_order_id TEXT NOT NULL,
    successor_order_id   TEXT NOT NULL,
    predecessor_state_key JSONB NOT NULL CHECK (jsonb_typeof(predecessor_state_key) = 'array'),
    successor_state_key   JSONB NOT NULL CHECK (jsonb_typeof(successor_state_key) = 'array'),
    standard_min         INTEGER NOT NULL CHECK (standard_min BETWEEN 0 AND 10080),
    remaining_min        INTEGER NOT NULL CHECK (remaining_min BETWEEN 0 AND 10080),
    status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive', 'cleared', 'replaced')),
    reason               TEXT,
    created_by           TEXT,
    created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by           TEXT,
    updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_setup_occurrence_override_active_adjacency
    ON setup_occurrence_override (
        plant, line, signature_version, predecessor_order_id, successor_order_id,
        predecessor_state_key, successor_state_key
    )
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_setup_occurrence_override_plant_line
    ON setup_occurrence_override (plant, line, signature_version);
