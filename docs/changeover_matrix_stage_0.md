# Changeover Matrix Stage 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish trustworthy, versioned setup data and shadow diagnostics without changing any production-order placement, duration, utilization, or alerts.

**Architecture:** PostgreSQL owns setup definitions, matrix rows, physical line state, and occurrence overrides. A focused `setup_data.py` module owns persistence and validation; `brain.py` exposes plant-gated APIs. A pure `web/setup-domain.mts` module owns canonical state keys and transition resolution, while existing data/admin modules hydrate and edit plant-scoped data. Shadow diagnostics may observe schedules but must never mutate them.

**Tech Stack:** PostgreSQL, psycopg 3, FastAPI, Python 3.10, TypeScript ES modules, vanilla DOM, Node test runner, pytest.

## Global Constraints

- `docs/changeover_matrix.md` is authoritative. If this plan conflicts with it, stop and reconcile the plan before coding.
- Stage 0 is observation-only: no setup time may alter order dates, segments, utilization, alerts, optimization, reflow, or persistence.
- All records and endpoints are plant-scoped. Line scope must be validated against plant ownership.
- Use searchable plant/line comboboxes; never add plant or line chips.
- Matrix resolution is override occurrence -> line row -> plant row -> valid identical-state zero -> uncovered.
- A blank or incomplete signature is never a valid identical state.
- Signature field order is canonical and versioned. A definition change increments the version and invalidates old rows, states, overrides, coverage, and previews.
- All write routes require the existing API-key guard where applicable, authenticated authorization, audit metadata, and per-user plant authorization.
- All plant-gated client calls use `Util.fetchTraced`; do not use bare `fetch`.
- Never run PostgreSQL tests unless the target is confirmed local and `NIMBUS_TEST_DB=1` is explicitly set.
- Do not bump `NIMBUS_BUILD_ID`; that is a deployment action, not Stage 0 implementation.

## Stage Boundary

**Consumes:** Existing rankable-field registry (`master_data.RANKABLE_FIELDS`), materialized order attributes, plant/line master data, authenticated user/role/plant scope, and current schedules.

**Produces for Stage 1:**

- `SetupDefinition`, `SetupMatrixRow`, `LineSetupState`, `SetupOccurrenceOverride`, `ResolvedSetup`, and coverage contracts.
- Version-matched, plant-scoped hydration through one frontend setup snapshot.
- Pure canonicalization and resolution functions usable by the scheduler and renderer.
- Measured state/group counts and interaction budgets used to choose bounded-search limits.

**Explicitly excluded:** Changing schedule dates, derived setup bars, setup alerts, setup capacity, optimizer candidates, manual reflow, or enabling any setup-aware scheduling mode.

---

### Task 1: Add the additive setup schema and migration

**Files:**
- Create: `migrations/2026-08-13-changeover-matrix-stage-0.sql`
- Modify: `schema.sql`
- Modify: `tests/test_schema_idempotent.py`

**Interfaces:**
- Produces tables `setup_definition`, `setup_matrix`, `line_setup_state`, and `setup_occurrence_override`, plus a setup-specific compatibility flag on `production_lines`.
- Uses `signature_version INTEGER`, canonical JSON state arrays, finite integer minutes, and database timestamps.

- [ ] **Step 1: Add static schema tests that require all four tables and the key constraints in both SQL files.**

  Assert that definitions are unique by plant, matrix rows by `(plant, line, signature_version, from_key, to_key)`, line state by `(plant, line)`, active occurrence bindings cannot duplicate the same exact adjacency/version, and setup optimization is enabled by default only when a line is compatible with the plant signature.

- [ ] **Step 2: Run `pytest tests/test_schema_idempotent.py -q` and confirm the new assertions fail.**

- [ ] **Step 3: Add the migration and mirror it in `schema.sql`.**

  Required columns:

  - `setup_definition`: `plant`, ordered `fields JSONB`, `signature_version`, `strict_blanks`, `active`, audit actor/timestamps.
  - `setup_matrix`: `plant`, `line` default `''`, `signature_version`, `from_key JSONB`, `to_key JSONB`, `setup_min`, source metadata, audit actor/timestamps.
  - `line_setup_state`: `plant`, `line`, `state_key JSONB`, `signature_version`, optional `physical_mold_id`, `observed_at`, `source`, `reason`, actor/timestamps.
  - `setup_occurrence_override`: stable ID, plant, line, signature version, predecessor/successor order IDs and state keys, `standard_min`, `remaining_min`, `status`, reason, actor/timestamps.
  - `production_lines.setup_compatible`: boolean default `TRUE`; `FALSE` opts only that line out of setup-aware optimization when the plant signature does not describe its equipment, without hiding setup truth or changing the existing global optimizer-exclusion setting.

  Enforce nonnegative minutes with a documented maximum of `10080` minutes (seven days), sources `manual|derived|actual`, and override status `active|inactive|cleared|replaced`.

- [ ] **Step 4: Re-run the static schema test and `ruff check tests/test_schema_idempotent.py`.**

- [ ] **Step 5: With an explicitly safe local DB only, reapply `schema.sql` twice and run the `@pytest.mark.pg` idempotency test.**

- [ ] **Step 6: Commit with `feat: add setup matrix persistence schema`.**

### Task 2: Implement persistence and validation in a focused backend module

**Files:**
- Create: `setup_data.py`
- Create: `tests/test_setup_data.py`
- Modify: `sap_sync.py`
- Modify: the upload/purge call sites in `brain.py`
- Modify: `db.py` only if a shared pool accessor is required; do not duplicate connection configuration.

**Interfaces:**
- Produces `get_setup_snapshot(plant: str) -> dict`.
- Produces `save_definition(plant, fields, strict_blanks, actor) -> dict`.
- Produces `replace_plant_matrix(...)`, `upsert_line_matrix_rows(...)`, `delete_line_matrix_rows(...)`.
- Produces `set_line_state(...)`, `derive_line_state_before_replacement(...)`, `upsert_occurrence_override(...)`, and `clear_occurrence_override(...)`.
- Produces `canonical_state_key(fields, values) -> list[dict[str, str]]`; canonical keys retain field order and normalized values without ambiguous delimiter joining.

- [ ] **Step 1: Write unit tests for field registration, canonical order, finite integer minutes, maximum minutes, duplicate rows, line ownership, and signature-version rejection.**

- [ ] **Step 2: Write tests proving a definition edit increments the version and deactivates setup optimization without rewriting old keys.**

- [ ] **Step 3: Write monotonic state tests: older derived state cannot replace newer manual/actual state, and derived snapshots may use only the last planned order completed by the captured plant-local time.**

- [ ] **Step 4: Write integration tests proving upload replacement, SAP replacement, and purge capture the controlled derived snapshot immediately before removing/replacing the source schedule, while failed ingest/purge cannot advance state from future work.**

- [ ] **Step 5: Run `pytest tests/test_setup_data.py -q` and confirm failures identify the missing module/functions.**

- [ ] **Step 6: Implement parameterized SQL and transactions in `setup_data.py`; use `psycopg.sql.Identifier` only for identifiers and never interpolate user values. Wire controlled snapshot calls immediately before the existing upload, SAP replacement, and purge mutations.**

- [ ] **Step 7: Re-run `pytest tests/test_setup_data.py -q` and `ruff check setup_data.py tests/test_setup_data.py`.**

- [ ] **Step 8: Commit with `feat: add setup matrix data service`.**

### Task 3: Expose authorized plant-scoped setup APIs

**Files:**
- Modify: `brain.py`
- Modify: `auth.py` only if named permissions cannot be expressed by existing role settings.
- Create: `tests/test_setup_endpoints.py`

**Interfaces:**
- `GET /setup/{plant}` returns one versioned snapshot containing definition, plant rows, sparse line rows, line states, active/inactive overrides, and freshness metadata.
- `PUT /setup/{plant}/definition` changes fields/strictness and invalidates activation.
- `POST /setup/{plant}/matrix/import` accepts canonical long-form rows with deterministic duplicate rejection.
- `DELETE /setup/{plant}/matrix` deletes a specified plant row or sparse line override; deleting a line row reveals inheritance.
- `PUT /setup/{plant}/lines/{line}/state` manages scheduler-owned state.
- `PUT|DELETE /setup/{plant}/overrides/{override_id}` manages occurrence-specific remaining setup.
- Matrix/definition writes require master-data-owner authorization; line-state/override writes require authorized plant-scheduler permission.

- [ ] **Step 1: Write endpoint tests for unauthorized, wrong-plant, wrong-line, stale-version, invalid-minute, and successful requests.**

- [ ] **Step 2: Test that `GET /setup/{plant}` never leaks another plant and that successful writes return the new freshness/version marker.**

- [ ] **Step 3: Test audit details include actor, operation, plant, line where applicable, outcome, and request ID without storing full uploaded files.**

- [ ] **Step 4: Run `pytest tests/test_setup_endpoints.py -q` and confirm the routes are initially absent.**

- [ ] **Step 5: Implement routes using `Depends(auth.get_allowed_plants_for_request)`, `md._assert_plant_allowed`, existing API-key/admin patterns, and `setup_data.py`.**

- [ ] **Step 6: Re-run the endpoint tests plus `pytest tests/test_logs_endpoints.py tests/test_data_integrity.py -q`.**

- [ ] **Step 7: Commit with `feat: expose setup matrix APIs`.**

### Task 4: Implement pure setup-state and resolution semantics

**Files:**
- Create: `web/setup-domain.mts`
- Create: `tests/modules/setup-domain.test.mjs`
- Modify: `web/types.mts`

**Interfaces:**

```ts
export type SetupStateKey = ReadonlyArray<{ fieldKey: string; value: string }>;
export type SetupResolutionSource = 'occurrence' | 'line' | 'plant' | 'implicit-zero' | 'uncovered';
export interface ResolvedSetup {
  covered: boolean;
  requiredMin: number | null;
  effectiveMin: number | null;
  standardMin: number | null;
  source: SetupResolutionSource;
  reason: string;
  signatureVersion: number;
  overrideId?: string;
}
export function stateForOrder(order: Task, definition: SetupDefinition): SetupStateKey | null;
export function resolveSetup(input: ResolveSetupInput): ResolvedSetup;
```

- [ ] **Step 1: Write tests for canonical field order, strict blanks, explicit diagonal, implicit diagonal, line-over-plant precedence, occurrence precedence, and uncovered non-diagonal pairs.**

- [ ] **Step 2: Write tests proving incomplete equal-looking states remain uncovered and stale-version rows/overrides never resolve.**

- [ ] **Step 3: Run `npm run build` and `node --test tests/modules/setup-domain.test.mjs`; confirm failure because the module is absent.**

- [ ] **Step 4: Implement only pure functions—no DOM, Store, fetch, localStorage, or mutable module cache.**

- [ ] **Step 5: Re-run the focused test, `npm run typecheck`, and `npm run lint:errors`.**

- [ ] **Step 6: Commit with `feat: add setup transition domain model`.**

### Task 5: Hydrate and invalidate plant-scoped setup data

**Files:**
- Modify: `web/schedule-data.mts`
- Modify: `web/schedule-state.mts`
- Modify: `web/types.mts`
- Modify: `tests/modules/schedule-data.test.mjs`
- Modify: `tests/modules/schedule-state.test.mjs`

**Interfaces:**
- `Persistence.loadSetupSnapshot(plant: string): Promise<SetupSnapshot>` uses `Util.fetchTraced`.
- `Store.setupSnapshot` contains only the active plant's setup data.
- Plant switching clears the old snapshot before the new request starts and sets freshness only after success.

- [ ] **Step 1: Add failing tests for clear-before-hydrate, failed-fetch freshness, stale response suppression, and no cross-plant retention.**

- [ ] **Step 2: Implement typed Store replacement/publication and traced loading without changing schedule persistence payloads.**

- [ ] **Step 3: Add the setup-domain module to the static import/build path without adding a new classic-script global bridge.**

- [ ] **Step 4: Run focused state/data tests, `npm run typecheck`, and `npm run build`.**

- [ ] **Step 5: Commit with `feat: hydrate plant setup data`.**

### Task 6: Add setup administration and long-form import/export

**Files:**
- Modify: `web/plant-and-administration.mts`
- Modify: `web/styles.css`
- Modify: `web/locales/en.js`, `de.js`, `es.js`, `fr.js`, `pt.js`
- Modify: `tests/modules/plant-and-administration.test.mjs`
- Modify: `tests/modules/locale-completeness.test.mjs`

**Interfaces:**
- One plant-scoped setup editor with searchable line scope, ordered registered-field selection, activation status, canonical long-form matrix rows, inherited-value display, line override deletion, state source/timestamp, and occurrence override audit detail.
- Lines expose a setup-specific compatibility control. An incompatible line remains visible in coverage/diagnostics but is excluded from setup-aware optimization with an explicit reason.
- CSV columns are exactly `From setup state`, `To setup state`, `Setup minutes`, plus plant/line/version metadata in exports.

- [ ] **Step 1: Add failing UI contract tests for permissions, inherited plant values, sparse line deletion, version mismatch, and non-writer read/copy/export access.**

- [ ] **Step 2: Implement the editor using existing admin components, Flatpickr for timestamps, existing tokens, and searchable combobox patterns.**

- [ ] **Step 3: Ensure a definition change visibly disables activation and explains that a version-matched matrix and coverage pass are required.**

- [ ] **Step 4: Ensure marking a line incompatible requires a reason, does not alter its matrix/state history, and cannot be mistaken for the existing global optimizer exclusion.**

- [ ] **Step 5: Add locale strings and run locale completeness, focused module tests, lint, typecheck, and build.**

- [ ] **Step 6: Commit with `feat: add setup matrix administration`.**

### Task 7: Add shadow coverage, missing-pair export, and bounded measurement

**Files:**
- Modify: `setup_data.py`
- Modify: `brain.py`
- Modify: `web/setup-domain.mts`
- Modify: `web/plant-and-administration.mts`
- Create: `tests/test_setup_coverage.py`
- Modify: `tests/modules/setup-domain.test.mjs`

**Interfaces:**
- `GET /setup/{plant}/coverage` returns observed and reachable pair totals/missing pairs by line and scope.
- `GET /setup/{plant}/missing-pairs.csv?kind=observed|reachable` returns stable, selectable long-form rows.
- `computeShadowDiagnostics(snapshot, tasks, policy)` returns counts only: covered/uncovered transitions, total standard minutes, distinct states by plant/line/day-or-fragment, median, max, percentile, and derivation runtime.

- [ ] **Step 1: Write tests for observed versus reachable coverage, deduplication by pair/scope, missing-edge exclusion, and invalid/incomplete state treatment.**

- [ ] **Step 2: Write tests proving diagnostics do not mutate tasks, Store, schedule segments, or persistence payloads.**

- [ ] **Step 3: Implement server-side pagination/filtering for missing-pair data; do not return unbounded plant-wide datasets by default.**

- [ ] **Step 4: Instrument derivation and aggregation with `PerfMonitor`; record representative task/state densities without claiming redraw performance yet.**

- [ ] **Step 5: Run focused Python/Node tests and full non-DB gates: `pytest -m "not pg"`, `npm test`, `npm run lint`, `npm run typecheck`, `ruff check .`.**

- [ ] **Step 6: Commit with `feat: add setup shadow diagnostics`.**

### Task 8: Stage 0 activation review and handoff

**Files:**
- Modify: `docs/changeover_matrix_stage_0.md` only to record measured results and checked boxes during execution.
- Modify: `docs/MIGRATION.md` with migration/application ordering and rollback behavior.

- [ ] **Step 1: Verify no schedule-facing code consumes setup minutes by searching Engine, Calendar, Alerts, Utilization, Timeline, Interaction, and persistence save paths.**

- [ ] **Step 2: Verify version-matched validation, acceptable reachable coverage, acknowledged unknown initial states, clear derived/manual/actual labels, and representative performance measurements for the pilot plant.**

- [ ] **Step 3: Confirm deactivation preserves all setup truth and only prevents future setup-aware optimizer activation.**

- [ ] **Step 4: Capture the selected exact-search fragment threshold, greedy/local iteration cap, wall-clock budget, and interaction budget as measured constants for Stage 1.**

- [ ] **Step 5: Run all quality gates and record command outputs in the PR description; include screenshots of the setup editor and coverage states.**

- [ ] **Step 6: Commit with `docs: record setup stage 0 readiness`.**

## Stage 0 Exit Gate

## Execution record — 2026-08-13

- [x] Tasks 1–6 implemented and reviewed: additive schema, persistence, authorized APIs, pure resolver,
  active-plant hydration, and the setup administration surface.
- [x] Task 7 code diagnostics implemented: observed/reachable coverage, bounded missing-pair CSV pages,
  pure shadow transition/state-density measurement, and an admin coverage readout. Focused verification
  passed: Node setup-domain tests (11), Python setup coverage/endpoints tests (20), TypeScript build.
- [x] Observation-only audit: setup minutes occur only in setup persistence/API/admin/diagnostic paths;
  no Engine, Calendar, Alerts, Utilization, Timeline, Interaction, worker, or schedule-save code consumes
  them for placement, capacity, alerts, reflow, or persistence.
- [ ] Safe local PostgreSQL reapply/idempotency verification is pending an explicitly confirmed local target
  with `NIMBUS_TEST_DB=1`.
- [ ] Pilot-plant reachable-coverage acceptance, unknown-current-state acknowledgement, and representative
  interaction/search performance measurements remain operational activation work. Stage 1 must not begin
  until they are recorded for the activation plant.
- [ ] Full repository Node/lint gates remain blocked by pre-existing baseline failures: the legacy-surface
  contract snapshot, auto-reflow regression, duplicate locale keys, and legacy `localStorage` lint globals.

Do not begin Stage 1 until all are true:

- Schema is additive/idempotent and successfully re-applied to a safe local database.
- Every write is version checked, authorized, audited, and plant/line scoped.
- Signature-incompatible lines have an explicit setup-only opt-out and diagnostic reason.
- Plant switching cannot retain or display the prior plant's setup data.
- Explicit/implicit diagonal and resolution precedence tests pass.
- Reachable coverage is calculated and accepted for the activation plant.
- Unknown current states are visible and acknowledged; derived state is never labeled verified.
- Shadow diagnostics prove they do not mutate schedules.
- Search and UI performance budgets are based on representative measurements, not guesses.
- No setup capacity, bar, alert, reflow, or optimizer behavior is active.

## Recovery / Token-Limit Handoff

On a new session, read only:

1. This file.
2. `docs/changeover_matrix.md` sections 1-5, 9, and 11-14 when resolving ambiguity.
3. The latest checked task and `git status`/recent commits.

Resume at the first unchecked step. Never infer completion from files existing; rerun that task's focused verification first.
