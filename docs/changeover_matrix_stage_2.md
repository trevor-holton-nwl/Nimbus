# Changeover Matrix Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the validated setup-aware scheduler from Due-date first to Min Changeover / available slack and Throughput first with explicit, testable savings and lateness limits.

**Architecture:** Stage 2 reuses Stage 1's immutable evaluator, feasibility rules, lexicographic scorer, diagnostics, and single-commit preview. Policy modules may change candidate eligibility and score thresholds only; they must not create separate placement, setup resolution, alert, utilization, rendering, or mutation paths.

**Tech Stack:** TypeScript ES modules, existing setup scheduler/services/workbench, Node test runner, existing FastAPI-backed plant settings.

## Global Constraints

- `docs/changeover_matrix.md` remains authoritative.
- Stage 1 must be active and validated with real plant data before Stage 2 policy activation.
- All modes charge the same covered setup capacity and obey the same fixed, split, override, calendar, missing-edge, and preview rules.
- Min Changeover may pull future work only when it creates no new lateness.
- Throughput first defaults require at least 60 setup minutes saved and no order slipping more than one day.
- Thresholds are explicit plant policy configuration, validated server-side and shown in preview explanations.
- Missing setup edges never win; infeasible lines remain unchanged without blocking unaffected lines.
- Candidate evaluation remains immutable, bounded, deterministic, and one-commit-per-user-action.
- No policy may introduce an alert-to-optimizer feedback loop.
- Do not add shared molds, global mathematical solving, material-pair exceptions, or other deferred scope.

## Stage Boundary

**Consumes from Stage 1:** `evaluateSchedule`, shared placement/feasibility, lexicographic score, structured explanation/diagnostics, preview/apply lifecycle, setup alert/utilization parity, and accepted performance budgets.

**Produces:** Two additional setup-aware policy families with explicit activation, thresholds, UAT evidence, and rollback controls.

**Explicitly excluded:** SPT semantic changes (it remains pure shortest productive processing time), new setup signatures, new matrix key kinds, shared physical-asset scheduling, or a global solver.

---

### Task 1: Generalize policy configuration without duplicating scheduling logic

**Files:**
- Modify: `schema.sql`
- Create: `migrations/2026-08-13-changeover-matrix-stage-2-policies.sql`
- Modify: `master_data.py`
- Modify: `brain.py`
- Modify: `web/types.mts`
- Modify: `web/schedule-data.mts`
- Create: `tests/test_setup_policy_config.py`
- Modify: `tests/modules/schedule-data.test.mjs`

**Interfaces:**

```ts
export interface SetupPolicyConfig {
  dueDateFirstEnabled: boolean;
  minChangeoverEnabled: boolean;
  throughputEnabled: boolean;
  throughputMinSavingsMin: number; // default 60
  throughputMaxSlipMin: number;    // default 1440
}
```

- [ ] **Step 1: Add failing schema/API tests for defaults, nonnegative savings, positive slip cap, authorization, plant scope, and stale-version writes.**

- [ ] **Step 2: Persist policy configuration as a typed per-plant sidecar consistent with existing plant optimization settings; do not overload the ordered priority constraint tree.**

- [ ] **Step 3: Add plant-gated GET/PUT behavior and hydrate it with `Util.fetchTraced`; failed hydration must not retain another plant's policy.**

- [ ] **Step 4: Run focused Python/Node tests, schema idempotency, lint, and typecheck.**

- [ ] **Step 5: Commit with `feat: add setup optimization policy settings`.**

### Task 2: Enable Min Changeover / Use available slack

**Files:**
- Modify: `web/setup-scheduler.mts`
- Modify: `web/schedule-services.mts`
- Modify: `web/schedule-workbench.mts`
- Modify: `tests/modules/setup-scheduler.test.mjs`
- Modify: `tests/modules/schedule-services.test.mjs`
- Modify: `tests/modules/schedule-workbench.test.mjs`

**Interfaces:**
- Policy request kind `min-changeover` reuses shared feasibility and permits future-work pull-forward only if `after.newLateCount <= before.lateCount` and no previously on-time order becomes late.

- [ ] **Step 1: Add failing tests where setup savings are accepted only within available due-date slack.**

- [ ] **Step 2: Add rejection tests for a lower-setup candidate that creates any new lateness, violates a fixed/override edge, uses a missing transition, or changes a protected tier outcome.**

- [ ] **Step 3: Implement policy-specific candidate eligibility and score terms on top of the shared evaluator; do not fork placement or patch application.**

- [ ] **Step 4: Add preview reasons that name setup minutes saved and the due-safe constraint, including meaningful rejected alternatives.**

- [ ] **Step 5: Run deterministic/bounded tests repeatedly and commit with `feat: enable due-safe min changeover`.**

### Task 3: Enable Throughput first with explicit savings and slip caps

**Files:**
- Modify: `web/setup-scheduler.mts`
- Modify: `web/schedule-services.mts`
- Modify: `web/schedule-workbench.mts`
- Modify: `tests/modules/setup-scheduler.test.mjs`
- Modify: `tests/modules/schedule-services.test.mjs`
- Modify: `tests/modules/schedule-workbench.test.mjs`

**Interfaces:**
- Policy request kind `throughput` may accept new bounded lateness only when setup savings meet `throughputMinSavingsMin` and every slipped order remains within `throughputMaxSlipMin`.

- [ ] **Step 1: Add boundary tests at 59/60 setup minutes and 1439/1440/1441 slip minutes using default configuration.**

- [ ] **Step 2: Add multi-order tests proving every slipped order—not an average or only the worst-ranked order—is checked against the cap.**

- [ ] **Step 3: Add tests proving hard feasibility, policy tiers, missing edges, fixed orders, and override protection outrank throughput savings.**

- [ ] **Step 4: Implement threshold evaluation in the shared lexicographic framework and expose exact savings/slip math in preview reasons.**

- [ ] **Step 5: Run deterministic, time-limit, candidate-limit, and no-alert-loop tests; commit with `feat: enable bounded throughput setup policy`.**

### Task 4: Add permission-aware policy controls and activation gates

**Files:**
- Modify: `web/plant-and-administration.mts`
- Modify: `web/styles.css`
- Modify: `web/locales/en.js`, `de.js`, `es.js`, `fr.js`, `pt.js`
- Modify: `tests/modules/plant-and-administration.test.mjs`
- Modify: `tests/modules/locale-completeness.test.mjs`

**Interfaces:**
- Master-data owners can configure/activate policies only after version, reachable coverage, unknown-state acknowledgement, Stage 1 validation, and performance gates pass.
- Preview users see active thresholds and explanations but cannot change standards/policy configuration without permission.

- [ ] **Step 1: Add failing tests for disabled-state reasons, unauthorized controls, safe disable, and threshold validation copy.**

- [ ] **Step 2: Implement compact content-area controls using existing tokens and searchable plant scope; do not add plant/line chips or a new visual language.**

- [ ] **Step 3: Ensure deactivation prevents new runs only and leaves existing setup bars, truth, diagnostics, and schedule untouched.**

- [ ] **Step 4: Add locale strings and run UI/locale tests, lint, typecheck, and build.**

- [ ] **Step 5: Commit with `feat: add setup policy activation controls`.**

### Task 5: Real-plant validation, performance regression, and release gate

**Files:**
- Modify: `docs/changeover_matrix_stage_2.md` only to record checked gates and measurements during execution.
- Modify: `docs/MIGRATION.md` with activation/rollback procedures.

- [ ] **Step 1: Replay representative real-plant schedules through Due-date first, Min Changeover, and Throughput first using identical immutable snapshots.**

- [ ] **Step 2: Review every accepted new-lateness Throughput candidate with plant scheduling owners and verify the configured savings/slip thresholds match operational intent.**

- [ ] **Step 3: Benchmark candidate counts, runtime, termination reason, setup derivation, worker clone, preview rendering, and rapid drag against Stage 1 budgets.**

- [ ] **Step 4: Verify deterministic results across repeated runs and no Store mutation before Apply for every enabled policy.**

- [ ] **Step 5: Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `pytest -m "not pg"`, and `ruff check .`; then run safe-local DB tests with explicit opt-in.**

- [ ] **Step 6: Perform browser UAT for configuration, permissions, missing edges, stale previews, safe disable, rejected-alternative copy/export, plant switch, keyboard access, and dark mode.**

- [ ] **Step 7: Record results/screenshots/deployment implications in the PR and commit with `docs: record setup stage 2 validation`.**

## Stage 2 Exit Gate

- Due-date first remains behaviorally unchanged from Stage 1.
- Min Changeover creates no new lateness and explains accepted/rejected savings.
- Throughput first enforces the configured minimum savings and per-order slip cap exactly.
- All policies share setup resolution, placement, fixed/override protection, capacity, alerts, rendering, preview, and one-commit mutation behavior.
- Real-plant owners validate thresholds and representative outcomes.
- Determinism and performance remain within accepted budgets.
- Safe disable and rollback procedures are documented and tested.
- All automated gates and browser UAT pass before activation.

## Execution record (2026-08-14)

- Task 1 configuration sidecar landed in `c9803c6`: every policy defaults to
  disabled, is plant-scoped, version-checked, and is cleared on failed or
  cross-plant frontend hydration. Focused Python and Node contracts pass.
- Detached evaluator foundations for Min Changeover and Throughput landed in
  `c3c1aa7`. They reuse the Stage 1 evaluator and remain unreachable from the
  normal optimizer UI; no setup-aware policy has been activated.
- The following release gates remain deliberately incomplete: safe-local DB
  schema verification, persistence of null-predecessor overrides, real-plant
  replay/owner approval, browser UAT, and representative performance UAT.
  These are activation blockers, not conditions that may be bypassed by the
  policy flags.

### Release-readiness evidence update (2026-08-14)

**Implemented, still disabled**

- `98ea7b8` adds the Plant Settings policy panel. It hydrates through
  `Persistence.loadSetupPolicy`, uses optimistic `expected_version` writes,
  validates whole-minute thresholds, and renders policy switches disabled.
  Every threshold save sends a safe-disable payload; the only available state
  action for a pre-existing enabled record is disable-all. No task, setup-bar,
  setup-truth, alert, or preview mutation is performed by policy maintenance.
- `bdbae77` adds a pure throughput-policy selector and boundary contracts.
  It rejects 59 minutes of savings at the default 60-minute floor, accepts 60,
  accepts individual 1439/1440-minute slips, and rejects a 1441-minute slip
  while naming the violating order. The comparison remains detached from Store
  and patch application.
- `1f3f10c` restores the response from `set_setup_line_compatibility` that the
  Stage 2 sidecar insertion had accidentally stranded after a return. Its
  focused regression test passes.

**Automated checks run**

- `node --test tests/modules/plant-and-administration.test.mjs
  tests/modules/locale-completeness.test.mjs`: 22 passing.
- `node --test tests/modules/setup-scheduler.test.mjs
  tests/modules/schedule-services.test.mjs`: 131 passing, repeated three
  times with the same result.
- `py -m pytest -q -p no:cacheprovider tests/test_master_data_setup_policy.py
  tests/test_setup_policy_config.py`: 5 passing.
- `npm run build` and `npm run typecheck`: passing after each Stage 2 code
  change.
- `npm test`: one inherited CQ-1 contract-snapshot failure; legacy tests and
  all other module tests passed. It is unrelated to the Stage 2 policy changes.
- `npm run lint`: blocked by 49 pre-existing repository errors (including
  duplicate locale keys and legacy test globals); no new policy-panel lint
  error was reported.
- `py -m ruff check .`: blocked by 10 pre-existing errors. The Stage 2
  unreachable return / undefined-name finding was corrected in `1f3f10c`.
- `py -m pytest -m "not pg"`: 193 passed and 70 deselected, but three
  `test_db_safety.py` tests fail because the process inherits the Azure host;
  this is the expected guard refusing a non-local database, not a bypassable
  Stage 2 result.

**External evidence not available in this environment — activation blocked**

- The configured `PG_HOST` is `pgdb-nimbus-dev.postgres.database.azure.com`.
  A loopback PostgreSQL listener is accepting connections, but no safe local
  credential was available (`psql -w` rejected the connection), so no schema
  action and no `NIMBUS_TEST_DB=1` test was run.
- No controllable browser session was available, so permission/hydration,
  plant-switch, keyboard, dark-mode, safe-disable, and screenshot UAT have
  not been performed.
- No representative real-plant snapshot replay, candidate/runtime measurement,
  or scheduling-owner approval has been recorded.
- Null-predecessor initial-state override persistence remains unresolved.

**Release decision:** Stage 2 is code-complete and remains observation/preview
only. Do not enable any setup policy or deploy this work until every external
gate above is recorded as passed.

### Release-readiness completion pass (2026-08-14)

The activation gate is now persisted and server-authoritative, but it remains
fail-closed until real evidence is recorded:

- `88520e8` adds the plant-scoped `setup_release_evidence` JSONB sidecar,
  optimistic versioning, admin audit metadata, GET/PUT routes, and a server
  check requiring all seven evidence flags plus owner email, approval time, and
  notes before any policy mode can be enabled.
- `cf9d97f` hydrates the evidence sidecar on plant switch, adds the
  permission-aware evidence editor and policy controls, and keeps switches
  disabled until the server-visible evidence is complete. Focused UI,
  hydration, locale, build, and typecheck checks pass.
- `e44a669` localizes the setup review/status surface, limits evidence editing
  to administrators, coalesces setup-panel loads, and hardens setup-bar
  accessibility/contrast. `1a22dee` keeps the exported status evaluators
  usable in Node-side tests without a browser global. The focused
  SetupAdmin/locale suite passes 23/23.
- Null-predecessor initial overrides now preserve explicit JSON `null` through
  validation, null-safe replacement matching, and parameterized SQL. The
  schema/migration allow the nullable initial binding and use `NULLS NOT
  DISTINCT` for active-adjacency uniqueness; omitted predecessor keys are
  rejected. Static schema contracts and Python compilation pass.
- `ruff check .` passes with no findings. `npm run lint` passes with zero
  errors (31 inherited warnings). `npm test` remains at 312 passing / 1
  inherited CQ-1 snapshot failure.
- With the project root virtual environment and an explicitly local-only
  `PG_HOST=127.0.0.1` override (without `NIMBUS_TEST_DB=1`), the focused setup
  Python contracts pass 57/57 and the complete non-Postgres suite passes
  201/201 (70 Postgres tests deselected). This is unit/contract verification,
  not a schema round-trip against a local database.

The following release blockers are still intentionally unresolved because this
workspace has neither a safe local PostgreSQL target nor a controllable browser
session: local-DB schema/round-trip verification, browser/performance UAT,
representative-plant replay, scheduling-owner approval, and recording the
corresponding evidence flags. No policy activation or deployment was performed.

## Recovery / Token-Limit Handoff

On a new session, read only:

1. This file.
2. Stage 1's exit-gate/results section.
3. `docs/changeover_matrix.md` sections 7, 8, and 12-14 when resolving ambiguity.
4. The latest checked task and recent commits.

Resume at the first unchecked step and rerun its focused verification before editing.
