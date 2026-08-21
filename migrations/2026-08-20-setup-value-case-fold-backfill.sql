-- ============================================================================
-- Migration: Setup attribute value case-fold backfill (Azure cutover — HAND-APPLIED ONCE)
-- Date: 2026-08-20
-- ============================================================================
-- WHAT THIS IS
-- ------------
-- setup_data._normalise_value (Python) and web/setup-domain.mts's
-- normalizedValue (TS) now canonicalize every setup-attribute state value
-- (color / prt01 / prt02 / productionVersion) to uppercase-and-trimmed,
-- except the literal booleans "true"/"false" which stay lowercase. Before
-- this fold shipped, a hand-typed "Black" and an ingested "BLACK" were two
-- distinct JSONB values, which produced false "no setup defined" alerts
-- whenever the two paths disagreed on case for what is really one state.
--
-- The local Postgres DB was rebuilt from scratch for workstream A and has no
-- mixed-case rows to fix. The live Azure pilot database (rg-nimbus-dev) was
-- NOT rebuilt and may hold real setup_matrix / machine_setup_state /
-- setup_occurrence_override rows written before this fold shipped, with
-- mixed-case values sitting inside their JSONB state-key columns. Once the
-- application code folds every lookup to uppercase, those old mixed-case
-- rows become permanently unreachable — the code will never again construct
-- a lookup key that matches them byte-for-byte — UNLESS this script folds
-- the stored values in place first (see docs/multi_change_spec_08.20.26.md
-- §D1, OD-D1a).
--
-- HOW THIS FILE IS DIFFERENT FROM EVERYTHING ELSE IN migrations/
-- ----------------------------------------------------------------------------
-- Every other file in this directory is, per CLAUDE.md, "dated, additive,
-- idempotent" — safe to re-run, and applied automatically by the
-- `promote-azure` skill's migration-ledger flow (apply-migrations.ps1).
--
-- THIS FILE IS THE DELIBERATE EXCEPTION, matching the conventions
-- established by migrations/2026-08-20-line-to-machine.sql:
--   * It must be applied BY HAND, EXACTLY ONCE, at a deliberate cutover
--     moment (immediately alongside — never before — the deploy that ships
--     the application-code fold in setup_data.py / web/setup-domain.mts;
--     running this backfill against code that still writes mixed-case keys
--     would just let new mixed-case duplicates accumulate again) — NOT via
--     the `promote-azure` skill and NOT via apply-migrations.ps1's automated
--     ledger sweep. Do not wire it into that tooling.
--   * It must NOT be recorded in the `schema_migrations` table, for the same
--     reason the rename migration is not: that ledger guards one-time
--     DATA-MUTATING steps embedded in the idempotent schema.sql, a different
--     mechanism than this hand-applied, cutover-only backfill.
--   * Unlike the rename migration, every statement below happens to be
--     naturally safe to re-run (UPPER() is idempotent, and a second pass
--     over already-folded data finds zero duplicates and updates zero
--     rows) — but it still gets the same hand-applied-once operational
--     discipline as the rename migration: run it with no planner actively
--     working the plant(s) in question, and only as part of the deliberate
--     cutover, not routine maintenance.
--   * DO NOT RUN THIS FILE. DO NOT INVOKE ANY DEPLOY TOOLING FOR IT. It is
--     authored for the eventual Azure cutover, per the task that produced it.
--
-- WHAT "PK-COLLIDING" MEANS FOR EACH OF THE 3 TABLES
-- ----------------------------------------------------------------------------
-- setup_matrix's PRIMARY KEY is (plant, machine, signature_version, from_key,
-- to_key) — the JSONB state-key columns are literally inside the primary
-- key, so two rows that differ only by the case of a value inside from_key
-- or to_key are, today, two distinct rows. Folding them to the same
-- uppercase key would collide; the oldest-updated_at row of each colliding
-- group is discarded so the table keeps exactly one row per post-fold key.
--
-- machine_setup_state's PRIMARY KEY is (plant, machine) ONLY — state_key is
-- NOT part of it, so there is structurally only ever one row per
-- (plant, machine) already, and case-folding it can never collide with
-- another row. This table's section is therefore a plain in-place UPPER()
-- fold with no possible discards (the audit row below always reports 0).
--
-- setup_occurrence_override's PRIMARY KEY is a surrogate `id` — folding the
-- JSONB columns cannot violate that PK either. The JSONB-inclusive
-- uniqueness constraint that CAN be violated post-fold is the partial
-- unique index uq_setup_occurrence_override_active_adjacency (plant,
-- machine, signature_version, predecessor_order_id, successor_order_id,
-- predecessor_state_key, successor_state_key), which only applies WHERE
-- status = 'active'. Only active rows are therefore candidates for a
-- post-fold collision; historical inactive/cleared/replaced rows are left
-- alone even if two happen to fold to the same key, since nothing requires
-- them to stay distinct.
--
-- TRANSACTION SAFETY
-- -------------------
-- Every statement below is ordinary transactional DML (DELETE, UPDATE,
-- INSERT via CTEs) — none of it is a CONCURRENTLY operation or other
-- construct Postgres forbids inside a transaction block. The whole file is
-- wrapped in a single BEGIN/COMMIT so it applies atomically: either the
-- entire backfill lands, or (on any error) the whole thing rolls back and
-- Azure is left exactly as it was pre-backfill.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. setup_matrix
--    PK (plant, machine, signature_version, from_key, to_key) includes the
--    JSONB columns being folded, so a real dedup pass is required: for each
--    group of rows that share the same plant/machine/signature_version and
--    would fold to the same from_key/to_key, keep only the most recently
--    updated row and discard the rest, THEN fold every surviving row's
--    from_key/to_key to canonical uppercase.
-- ----------------------------------------------------------------------------
WITH folded AS (
    SELECT
        plant, machine, signature_version, from_key, to_key, updated_at,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                    FROM jsonb_array_elements(from_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb) AS folded_from_key,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                    FROM jsonb_array_elements(to_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb) AS folded_to_key
    FROM setup_matrix
),
ranked AS (
    SELECT plant, machine, signature_version, from_key, to_key,
           ROW_NUMBER() OVER (
               PARTITION BY plant, machine, signature_version, folded_from_key, folded_to_key
               ORDER BY updated_at DESC
           ) AS keep_rank
    FROM folded
),
losers AS (
    SELECT plant, machine, signature_version, from_key, to_key
    FROM ranked
    WHERE keep_rank > 1
),
deleted_setup_matrix AS (
    DELETE FROM setup_matrix sm
    USING losers l
    WHERE sm.plant = l.plant AND sm.machine = l.machine AND sm.signature_version = l.signature_version
      AND sm.from_key = l.from_key AND sm.to_key = l.to_key
    RETURNING 1
)
INSERT INTO admin_audit (table_name, action, details, user_email)
SELECT 'setup_matrix', 'setup_value_case_fold_backfill',
       jsonb_build_object('discarded_duplicate_rows', COUNT(*)),
       'system-migration'
FROM deleted_setup_matrix;

UPDATE setup_matrix
   SET from_key = COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                               FROM jsonb_array_elements(from_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb),
       to_key   = COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                               FROM jsonb_array_elements(to_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb);

-- ----------------------------------------------------------------------------
-- 2. machine_setup_state
--    PK (plant, machine) does NOT include state_key, so there is no dedup
--    step here — only ever one row per (plant, machine) is structurally
--    possible. Pure in-place fold; the audit row's discarded_duplicate_rows
--    is always 0 by construction.
-- ----------------------------------------------------------------------------
WITH updated_machine_setup_state AS (
    UPDATE machine_setup_state
       SET state_key = COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                                    FROM jsonb_array_elements(state_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb)
     WHERE state_key <> COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                                    FROM jsonb_array_elements(state_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb)
    RETURNING 1
)
INSERT INTO admin_audit (table_name, action, details, user_email)
SELECT 'machine_setup_state', 'setup_value_case_fold_backfill',
       jsonb_build_object('discarded_duplicate_rows', 0, 'folded_rows', COUNT(*)),
       'system-migration'
FROM updated_machine_setup_state;

-- ----------------------------------------------------------------------------
-- 3. setup_occurrence_override
--    Surrogate `id` PK can't collide from this fold; the real JSONB-
--    inclusive uniqueness constraint is the partial unique index
--    uq_setup_occurrence_override_active_adjacency, scoped to
--    status = 'active'. Dedup only among active rows sharing a post-fold
--    key (keep the most recently updated), then fold every remaining row's
--    (active or not) predecessor/successor state key.
-- ----------------------------------------------------------------------------
WITH folded AS (
    SELECT id, plant, machine, signature_version, predecessor_order_id, successor_order_id, updated_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                       FROM jsonb_array_elements(predecessor_state_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb) AS folded_pred,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                       FROM jsonb_array_elements(successor_state_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb) AS folded_succ
      FROM setup_occurrence_override
     WHERE status = 'active'
),
ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY plant, machine, signature_version, predecessor_order_id, successor_order_id,
                            folded_pred, folded_succ
               ORDER BY updated_at DESC
           ) AS keep_rank
      FROM folded
),
deleted_setup_occurrence_override AS (
    DELETE FROM setup_occurrence_override soo
    USING ranked r
    WHERE soo.id = r.id AND r.keep_rank > 1
    RETURNING 1
)
INSERT INTO admin_audit (table_name, action, details, user_email)
SELECT 'setup_occurrence_override', 'setup_value_case_fold_backfill',
       jsonb_build_object('discarded_duplicate_rows', COUNT(*)),
       'system-migration'
FROM deleted_setup_occurrence_override;

UPDATE setup_occurrence_override
   SET predecessor_state_key = COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                                            FROM jsonb_array_elements(predecessor_state_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb),
       successor_state_key   = COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldKey', e ->> 'fieldKey', 'value', upper(e ->> 'value')) ORDER BY ord)
                                            FROM jsonb_array_elements(successor_state_key) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb);

COMMIT;

-- ============================================================================
-- Deliberately NOT done here (see header): no schema_migrations ledger row is
-- inserted for this file — that ledger is reserved for one-time data-mutating
-- steps embedded in the idempotent schema.sql, a different mechanism than
-- this hand-applied, cutover-only backfill.
-- ============================================================================
