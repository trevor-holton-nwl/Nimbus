# Changeover Stage 2 Release-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the technical release gates for Stage 2 without enabling setup-aware scheduling until real-plant approval is recorded.

**Architecture:** Keep policy evaluation detached and policy activation fail-closed. Add a permission-aware plant settings surface that can edit thresholds but cannot enable a policy while Stage 1 validation, safe-local database verification, browser UAT, and representative performance evidence are absent. Preserve the existing setup snapshot/evaluator/preview path; no alternate placement or Store mutation path is permitted.

**Tech Stack:** FastAPI, PostgreSQL, TypeScript ES modules, vanilla DOM, Node test runner, pytest.

**Spec:** `docs/changeover_matrix.md`, `docs/changeover_matrix_stage_2.md`

## Global Constraints

- All policy flags default to `false` and safe disable prevents new runs only.
- Never enable policies from automated tests, migration execution, or UI hydration.
- Min Changeover accepts no newly late order; Throughput checks every delayed order against its configured cap.
- Local DB tests only run with `NIMBUS_TEST_DB=1` against a confirmed local target.
- Real-plant replay, scheduling-owner signoff, and browser/performance UAT are external release evidence; record outcomes but do not fabricate them.

---

### Task 1: Gate policy controls in Plant Settings

**Files:**
- Modify: `web/plant-and-administration.mts`
- Modify: `web/styles.css`
- Modify: `web/locales/en.js`, `de.js`, `es.js`, `fr.js`, `pt.js`
- Test: `tests/modules/plant-and-administration.test.mjs`, `tests/modules/locale-completeness.test.mjs`

**Produces:** A plant-scoped policy panel that hydrates via `Persistence.loadSetupPolicy`, permits authorized threshold edits, and shows a specific disabled reason while any required evidence is missing.

- [ ] Write failing DOM-contract tests for a reader's read-only panel, an owner's threshold validation, blocked activation, and safe disable.
- [ ] Run `node --test tests/modules/plant-and-administration.test.mjs tests/modules/locale-completeness.test.mjs` and confirm the new assertions fail.
- [ ] Render the compact policy panel under Setup Administration using `SetupPolicyConfig`; use existing `panel`, `form-input`, and `setup-status` tokens.
- [ ] Make PUT `/setup/{plant}/policy` use `Util.fetchTraced`, send `expected_version`, retain the last confirmed values on an error, and show the server validation detail.
- [ ] Keep all enable controls disabled until the UI receives explicit validation evidence; deactivation remains available and cannot mutate tasks/setup bars/diagnostics.
- [ ] Add all new locale keys to the five dictionaries and run the focused Node tests, `npm run lint`, `npm run typecheck`, and `npm run build`.
- [ ] Commit with `feat: add setup policy activation controls`.

### Task 2: Complete evaluator boundary coverage

**Files:**
- Modify: `tests/modules/setup-scheduler.test.mjs`
- Modify: `tests/modules/schedule-services.test.mjs`
- Modify: `web/setup-scheduler.mts` only if a failing test exposes a defect.

**Produces:** Regression coverage for 59/60-minute savings, 1439/1440/1441-minute per-order slip limits, fixed/override/missing-edge protection, deterministic runs, and no Store mutation before Apply.

- [ ] Write one failing fixture per threshold boundary and a multi-order fixture that asserts each individual delayed ID.
- [ ] Run the focused scheduler/service tests and confirm each failure identifies the policy boundary.
- [ ] Make the minimal detached-evaluator correction; do not introduce new placement, setup-resolution, or patch-application code.
- [ ] Run the focused suites three times plus `npm run typecheck` and `npm run build`.
- [ ] Commit with `test: cover setup policy boundaries`.

### Task 3: Evidence and release-gate verification

**Files:**
- Modify: `docs/changeover_matrix_stage_2.md`
- Modify: `docs/MIGRATION.md`

**Produces:** An auditable release record that distinguishes passed automated checks from deferred external gates.

- [ ] Confirm a safe local DB target before any schema or `NIMBUS_TEST_DB=1` test; abort this substep if host/database is not local.
- [ ] Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `py -m pytest -m "not pg"`, and `ruff check .`; record inherited failures separately from Stage 2 failures.
- [ ] Run browser UAT for permissions, policy hydration after plant switch, rejected alternatives, dark mode, keyboard access, and safe disable; save screenshots/measurements.
- [ ] Replay a representative plant snapshot through all three policies and obtain scheduling-owner approval for any accepted new-lateness Throughput case.
- [ ] Record exact command outputs, runtime/candidate measurements, external approver, deployment implications, and any unresolved blocker in `docs/changeover_matrix_stage_2.md`.
- [ ] Commit with `docs: record setup stage 2 validation`.
