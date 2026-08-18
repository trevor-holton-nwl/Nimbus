# Optimizer Reason Codes and Deterministic Schedule Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add versioned, explainable optimizer decisions and deterministic stability/no-op safeguards to NIMBUS without changing manual scheduling semantics or refactoring unrelated application code.

**Architecture:** Keep the existing legacy dispatcher and setup-aware evaluator as the scheduling algorithms. Add a pure `schedule-diagnostics.mts` contract for reason metadata, canonical ordering, movement/objective comparison, bounded evidence, and input fingerprints; adapt both algorithms to emit that contract. Route detached preview Apply and direct optimizer mutation through checked evaluate-then-apply gates, then carry one bounded typed summary through the existing persistence path to a new atomic optimizer batch branch in `/tasks/update`.

**Tech Stack:** TypeScript 5.6 modules compiled with `tsc`, vanilla DOM preview UI, Node `node:test`, FastAPI/Pydantic, psycopg/PostgreSQL `xmin` optimistic concurrency, existing file-backed audit log.

**Spec:** `docs/superpowers/specs/2026-08-18-optimizer-reason-codes-stability-design.md`

## Global Constraints

- Preserve the existing modified `web/schedule-services.mts` and `tests/modules/schedule-services.test.mjs` pull-forward regression changes; do not rewrite or fold them into unrelated optimizer work.
- Do not alter manual drag, editable Orders-grid, calendar-edit, or Remove Backlog behavior except where the spec explicitly requires a shared repair report or a safety check at an automatic optimizer boundary.
- Reason producers emit codes and parameters; planner-facing prose comes from locale maps, and unknown codes render as `data-unknown-reason` rather than arbitrary producer text.
- Use `reasonSchemaVersion: 1`, cap preview reason examples at 8, and persist aggregate counts only; do not add a new database table or persist full candidate schedules/order decisions.
- Compare candidates per line with the existing mode objective first, then fewer moved orders, lower absolute shift minutes, fewer sequence changes, and a locale-independent canonical ID sequence.
- A deterministic work budget may produce an applyable “best found within budget”; an emergency wall-clock cutoff is interrupted and never applyable.
- Apply must validate the complete captured input bundle and every patch before mutating the first Store task; stale, duplicate-ID, invalid, or partial candidates apply zero patches.
- Generate `.mjs` output through `npm run build`; never hand-edit generated module output.
- Do not commit or stage pre-existing user changes. Before any adjacent change not required by this plan, stop and ask the user for approval.

## File Map

| File | Responsibility in this phase |
|---|---|
| `web/schedule-diagnostics.mts` | New pure reason registry, typed summaries, canonical serialization, movement/objective helpers, and input-fingerprint helpers. |
| `web/setup-scheduler.mts` | Re-export the shared reason type, pre-filter setup scope, record search populations/work budgets, and select stable candidates. |
| `web/schedule-services.mts` | Instrument legacy dispatch and repairs, suppress no-op patches, construct common reports, capture guards, and enforce direct optimizer apply gating. |
| `web/schedule-state.mts` | Retain hydration collision state, track optimizer-input revision, and provide checked all-or-nothing local patch application. |
| `web/schedule-workbench.mts` | Store the complete preview guard, render explicit reason/search/stability evidence, and queue the typed optimizer save. |
| `web/schedule-data.mts` / `web/application-shell.mts` | Send optimizer-owned edits as an isolated atomic save, supersede pending summaries on later manual edits, and report durable-save/audit warnings honestly. |
| `web/types.mts` / `web/types/api-generated.d.mts` | Add only the domain/API shapes required by the new typed save contract. Generated API declarations are refreshed by the normal build/type-generation workflow if needed. |
| `web/application-foundation.mts` / `web/index.html` | Add the startup/config selector for stability selection while leaving reason reporting available when the selector is disabled. |
| `web/locales/*.js` | Localize reason/disposition/search/stale-save copy in all five locales. |
| `db.py` | Add the transaction-scoped compare-and-swap optimizer update while leaving ordinary best-effort bulk updates unchanged. |
| `brain.py` | Validate and plant-scope the typed optimizer context, invoke the atomic DB branch, append only server-derived bounded audit summaries, and reject forged generic optimizer audit posts. |
| `tests/modules/schedule-diagnostics.test.mjs` | Pure deterministic contract tests. |
| `tests/modules/setup-scheduler.test.mjs` / `tests/modules/schedule-services.test.mjs` / `tests/modules/schedule-state.test.mjs` / `tests/modules/schedule-workbench.test.mjs` / `tests/modules/schedule-data.test.mjs` | Focused frontend regressions for each integration boundary. |
| `tests/test_optimizer_reason_codes.py` | Backend payload validation, audit restrictions, and atomic-update orchestration tests. Database transaction tests are local-database guarded. |

---

### Task 1: Add the shared diagnostics contract and pure helpers

**Files:**
- Create: `web/schedule-diagnostics.mts`
- Create: `tests/modules/schedule-diagnostics.test.mjs`
- Modify: `web/setup-scheduler.mts:1-410` to import and re-export `CandidateReason` without changing existing consumer imports.

**Interfaces:**
- Consumes: `NimbusTask`, `OrderScheduleSegment`, and `SchedulePatch`-compatible `{ id, changes }` values from `web/types.mts` and `web/setup-scheduler.mts`.
- Produces: `REASON_SCHEMA_VERSION`, `ReasonOutcome`, `ReasonSeverity`, `ReasonBucket`, `ScheduleReasonCode`, `CandidateReason`, `OrderDecision`, `ScheduleStabilitySummary`, `CandidateSearchSummary`, `ObjectiveVector`, `CandidateDisposition`, `RunDisposition`, `CandidateApplyGuard`, `ScheduleMutationReport`, `canonicalCompare`, `canonicalSerialize`, `fingerprintScheduleInputs`, `summarizeMovement`, `compareObjective`, `mergeReasonEvidence`, and `reasonMeta`.

- [ ] **Step 1: Write failing pure-contract tests.** Add tests that prove shuffled task/object input produces the same canonical serialization/fingerprint, movement ignores no-op patches, undated-to-dated work counts as newly scheduled without fabricated shift minutes, split-segment changes count once, DST movement uses elapsed epoch minutes, equal-start sequence comparisons use original position then ID, reason outcomes and severity remain independent, and bounded examples stop at eight.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REASON_SCHEMA_VERSION, canonicalSerialize, summarizeMovement,
  mergeReasonEvidence, reasonMeta,
} from '../../web/schedule-diagnostics.mjs';

test('canonical serialization is invariant to object and input order', () => {
  const left = canonicalSerialize({ b: 2, a: [{ z: 1, y: 0 }, 'x'] });
  const right = canonicalSerialize({ a: [{ y: 0, z: 1 }, 'x'], b: 2 });
  assert.equal(left, right);
});

test('movement ignores unchanged patches and does not invent a shift for new work', () => {
  const summary = summarizeMovement(
    [{ id: 'new', PRODUCTION_LINE: 'L1', start_date: null, end_date: null },
     { id: 'same', PRODUCTION_LINE: 'L1', start_date: new Date('2035-01-01T08:00:00'), end_date: new Date('2035-01-01T09:00:00') }],
    [{ id: 'new', PRODUCTION_LINE: 'L1', start_date: new Date('2035-01-02T08:00:00'), end_date: new Date('2035-01-02T09:00:00') },
     { id: 'same', PRODUCTION_LINE: 'L1', start_date: new Date('2035-01-01T08:00:00'), end_date: new Date('2035-01-01T09:00:00') }],
  );
  assert.equal(summary.newlyScheduledOrderCount, 1);
  assert.equal(summary.totalAbsoluteStartShiftMinutes, 0);
  assert.equal(summary.movedOrderCount, 0);
});

test('reason metadata separates outcome from severity and keeps schema versioned', () => {
  assert.equal(REASON_SCHEMA_VERSION, 1);
  assert.equal(reasonMeta('capacity-forced-placement').defaultOutcome, 'accepted');
  assert.equal(reasonMeta('capacity-forced-placement').defaultSeverity, 'warning');
  const merged = mergeReasonEvidence([
    { code: 'capacity-no-feasible-slot', bucket: 'capacity', outcome: 'rejected', severity: 'warning', source: 'rejected-candidate' },
  ], 8);
  assert.equal(merged.examples.length, 1);
});
```

- [ ] **Step 2: Run the new test file and verify it fails for missing exports.**

Run: `npm run build; node --test tests/modules/schedule-diagnostics.test.mjs`

Expected: FAIL because `web/schedule-diagnostics.mts` does not exist yet.

- [ ] **Step 3: Implement the registry and pure helpers.** Define the exact initial registry with one bucket, default outcome, default severity, localization key, primary precedence, and bounded parameter names per code. Preserve current setup codes (`covered-fixed-boundary-fallback`, `due-date-first-placement`, `due-work-unadmitted`, `fixed-boundary-fallback-ambiguous`, `fixed-boundary-infeasible`, `fixed-incoming-setup`, `initial-state-unknown`, `override-inactive`, `protected-fixed-boundary-outside-horizon`, `rejected-uncovered-transition`, `setup-definition-unavailable`, `setup-incompatible`, `setup-sequence-infeasible`, `spt-sequence-infeasible`, `trailing-fragment-unadmitted`) and add the first-release contract codes `placement-selected`, `fixed-protected`, `horizon-out-of-scope`, `pull-forward-blocked`, `capacity-no-operating-interval`, `capacity-no-feasible-slot`, `capacity-forced-placement`, `data-duplicate-task-id`, `data-invalid-scope`, `data-unknown-reason`, `search-work-budget`, `search-emergency-cutoff`, `stability-no-improvement`, `stability-no-change`, and `repair-required-move`.

  `canonicalSerialize` must sort object keys, sets, task IDs, segments, and reason examples; represent `Date` as epoch milliseconds; and never use locale-sensitive comparison. `summarizeMovement` must implement the spec’s definitions for new/rescheduled/earlier/later/line/segment/sequence movement. `compareObjective` must apply explicit tolerances and then the stability suffix. `fingerprintScheduleInputs` must return a stable string over the captured tasks, fixed IDs, collision state, calendars, blocks, rank maps, setup/config inputs, options, and `runAt`.

- [ ] **Step 4: Re-export the type from `setup-scheduler.mts` and update imports only.** Replace the local four-field `CandidateReason` definition with `export type { CandidateReason } from './schedule-diagnostics.mjs';` while keeping the existing `setup-scheduler.mjs` import surface valid for `schedule-workbench.mts` and tests.

- [ ] **Step 5: Run the pure tests and build.**

Run: `npm run build; node --test tests/modules/schedule-diagnostics.test.mjs`

Expected: PASS with no generated-file hand edits.

---

### Task 2: Make Store snapshots and local Apply safe for optimizer candidates

**Files:**
- Modify: `web/schedule-state.mts:102-340, 570-780`
- Modify: `web/schedule-services.mts:118-205`
- Modify: `tests/modules/schedule-state.test.mjs`
- Modify: `tests/modules/schedule-services.test.mjs`

**Interfaces:**
- Consumes: `CandidateApplyGuard`, `fingerprintScheduleInputs`, and `SchedulePatch` from Task 1.
- Produces: `Store.optimizerInputRevision()`, `Store.optimizerCollisionState()`, `Store.applyCheckedPatches(patches, guard, source)`, `snapshotSchedule()` fields for collision state/input revision, and `captureOptimizerGuard(snapshot, context)` in `schedule-services.mts`.

- [ ] **Step 1: Write failing state/apply tests.** Cover duplicate IDs retained as an active collision state after `setTasks`, optimizer-input revision changing for task/calendar/block/fixed/rank/setup/line-setting changes but not alert-only changes, unknown patch IDs causing zero mutations, duplicate patch IDs causing zero mutations, and a changed fingerprint causing zero mutations.

```js
import { snapshotSchedule, captureOptimizerGuard } from '../../web/schedule-services.mjs';

test('checked optimizer apply is all-or-nothing when one patch id is missing', () => {
  Store.setTasks([{ id: 'known', PRODUCTION_LINE: 'L1', start_date: null, end_date: null }], 'unit-test');
  const before = structuredClone(Store.tasks.known);
  const guard = captureOptimizerGuard(snapshotSchedule(), { plant: null, lines: null, runAt: new Date('2035-01-01T08:00:00') });
  assert.throws(() => Store.applyCheckedPatches([
    { id: 'known', changes: { start_date: new Date('2035-01-01T08:00:00') } },
    { id: 'missing', changes: { start_date: new Date('2035-01-01T09:00:00') } },
  ], guard, 'optimizer'));
  assert.deepEqual(Store.tasks.known, before);
});
```

- [ ] **Step 2: Run the focused tests to confirm the guard APIs are absent.**

Run: `npm run build; node --test tests/modules/schedule-state.test.mjs tests/modules/schedule-services.test.mjs`

Expected: FAIL at the new API references.

- [ ] **Step 3: Add collision and optimizer-input state without changing general Store revision semantics.** Retain a bounded collision sample and count from `setTasks`, expose it read-only, and carry it into `snapshotSchedule`. Add a separate monotonic optimizer-input revision updated only by relevant mutators. `setPriorityRankMaps` and setup replacement must update that revision even though they continue to avoid the general `emit()` behavior that drives autosave.

- [ ] **Step 4: Implement checked Apply.** Validate the captured revision and canonical fingerprint, reject active collisions, require every patch ID to exist exactly once, require every patch to be inside the captured plant/line scope, require finite positive intervals and normalized segments, and validate that all patches are checked before calling the existing one-event `updateMany`. Do not modify `updateMany`’s behavior for ordinary callers; the new helper is the optimizer-only boundary.

- [ ] **Step 5: Run focused state/service tests.**

Run: `npm run build; node --test tests/modules/schedule-state.test.mjs tests/modules/schedule-services.test.mjs`

Expected: PASS, including the existing pull-forward regressions unchanged.

---

### Task 3: Instrument setup-aware search and deterministic candidate selection

**Files:**
- Modify: `web/setup-scheduler.mts:300-410, 1200-3420`
- Modify: `tests/modules/setup-scheduler.test.mjs`

**Interfaces:**
- Consumes: shared reason registry, `summarizeMovement`, `compareObjective`, `canonicalCompare`, and scope/fingerprint types from Task 1.
- Produces: `CandidateResult.reasonSchemaVersion`, explicit `disposition`, `lineDispositions`, `searchSummary`, typed `CandidateReason[]`, and `CandidateResult` diagnostics with separate work/evaluation populations.

- [ ] **Step 1: Add failing setup-search tests.** Add tests for exact and greedy population identities, deterministic per-line budget allocation, fallback/continuation inclusion, pre-generation line/exclusion filtering, stable results under shuffled input, equal-primary selection preferring fewer moves, deterministic work-budget exhaustion, emergency interruption disabling Apply, and equal/worse candidates becoming `no-improvement`.

```js
test('setup search reports separate candidate evaluations and charged work', () => {
  const result = evaluateSchedule(snapshot, {
    mode: 'spt', plant: 'P1', lines: ['L1'], respectFixed: true,
    respectCalendar: true, searchWorkLimit: 4,
  });
  assert.equal(result.searchSummary.candidateEvaluations,
    result.searchSummary.feasibleCandidates + result.searchSummary.infeasibleCandidates);
  assert.equal(result.searchSummary.feasibleCandidates,
    result.searchSummary.scopeWinningCandidates + result.searchSummary.nonWinningFeasibleCandidates);
  assert.ok(result.searchSummary.searchWorkConsumed <= result.searchSummary.searchWorkLimit);
});
```

- [ ] **Step 2: Run focused setup tests and record the existing result shape.**

Run: `npm run build; node --test tests/modules/setup-scheduler.test.mjs`

Expected: the new assertions fail while pre-existing tests remain green; use the failure output to preserve existing mode/objective behavior.

- [ ] **Step 3: Add one shared pre-filtered optimizer scope resolver and use it at both evaluator entry points.** Resolve authoritative task plant first, use line mapping only for missing task plant, reject disagreement/ambiguous fallback with `data-invalid-scope`, and filter `plant`, requested lines, `excludeFromOpt`, horizon, fixed/calendar, split policy, `runAt`, and pull-forward floor before candidate generation. Export `resolveOptimizerScope(snapshot, { plant, lines, excludeFromOpt })` from the shared scheduler boundary and call it from both setup-aware and legacy evaluation. Remove the current post-filter of setup patches in `Engine.runAndApply`; the setup candidate’s score, explanations, and patch set must use the same scope.

- [ ] **Step 4: Replace the local reason shape with the shared metadata while preserving existing messages as developer diagnostics.** Every emitted setup reason receives `bucket`, `outcome`, `severity`, `source`, and bounded parameters. Existing reason codes remain available through compatibility aliases; no UI code infers an outcome from English text.

- [ ] **Step 5: Add deterministic search accounting.** Charge named operations through a per-line budget allocated before search. Count complete evaluations separately from charged work, classify feasible/infeasible/non-winning/scope-winning/pruned/duplicate-skipped populations, assign one primary bucket using registry precedence, and choose representative examples by canonical code/line/task ordering instead of first-observed timing. Keep `performance.now()` only as the emergency cutoff and label it `search-emergency-cutoff`.

- [ ] **Step 6: Apply the stability suffix and no-op disposition.** Keep each existing mode’s primary objective definition, calculate the same named metrics for baseline and candidate, suppress unchanged patches, and only mark a line applyable when the full vector is strictly better under explicit engine tolerances. Preserve required scheduling of undated work instead of allowing the stability suffix to prefer leaving it unscheduled.

- [ ] **Step 7: Run setup tests.**

Run: `npm run build; node --test tests/modules/setup-scheduler.test.mjs`

Expected: PASS with deterministic patches, reasons, counts, and dispositions across repeated/shuffled evaluations.

---

### Task 4: Integrate legacy optimizer, repair reports, and direct mutation gating

**Files:**
- Modify: `web/schedule-services.mts:1355-1525, 1791-3295`
- Modify: `web/application-foundation.mts:12-150` for the startup/config selector.
- Modify: `tests/modules/schedule-services.test.mjs`

**Interfaces:**
- Consumes: Task 1 diagnostics helpers and Task 3 `CandidateResult` contract.
- Produces: legacy `CandidateResult` reason/search summaries, `ScheduleMutationReport` from `Engine.autoReflow`/alert repairs, stable dispatch ordering, one guarded `Engine.applySchedulePatches` boundary, and a startup/config stability-selection flag.

- [ ] **Step 1: Write failing legacy/repair tests.** Cover fixed/horizon/pull-forward/capacity/forced-placement reasons, stable equal-key ordering, no-op patch suppression, repeated optimization producing no additional movement, auto-reflow returning every affected task, alert overlap undo restoring the target plus downstream peers, and overload fixes using the normal optimizer disposition.

- [ ] **Step 2: Run the focused service suite before implementation.**

Run: `npm run build; node --test tests/modules/schedule-services.test.mjs`

Expected: new reason/report assertions fail; existing pull-forward and setup parity assertions continue to identify regressions independently.

- [ ] **Step 3: Add the legacy reason producer at the existing dispatch decisions.** Report fixed protection, horizon exclusion, pull-forward waiting, closed/blackout/no-slot capacity, forced placement, unchanged order, and selected placement without changing the placement loop’s primary policy. Sort groups by canonical plant/line key and equal-key tasks by current start, snapshot position, then canonical ID. Keep the existing pull-forward floor logic intact.

- [ ] **Step 4: Suppress no-op patches and return a mutation report from automatic paths.** Compare dates/segments against the source task before adding a patch. Make `autoReflow` return `ScheduleMutationReport | null` while preserving callers that ignore its return. In `Alerts.applyFix`, snapshot the triggering task plus all tasks returned by auto-reflow, apply one report, and push one undo entry. Do not change manual scheduling or Remove Backlog semantics.

- [ ] **Step 5: Route direct optimizer runs through evaluate-then-apply.** Capture one `runAt` per run and reuse it for primary/alternate/baseline evaluation. Legacy and setup-aware `runAndApply` calls must retain diagnostics but use the same disposition check as preview Apply; a `no-improvement` result performs no mutation, while a repair report may move work when required for legality. Emergency interruption, invalid scope, duplicate IDs, and stale input fail closed for the complete run. Add `Config.OPTIMIZER_STABILITY_SELECTION` as a startup/config value; when false, keep reason reporting and existing scheduling but skip only the new baseline selector/no-op gate and disclose that selector version in preview evidence.

- [ ] **Step 6: Run the service suite and inspect only phase-related diffs.**

Run: `npm run build; node --test tests/modules/schedule-services.test.mjs tests/modules/setup-scheduler.test.mjs`

Expected: PASS; any changed behavior outside reason reporting, deterministic stability, no-op gating, or automatic repair reporting is a stop-and-ask decision rather than an opportunistic fix.

---

### Task 5: Add guarded preview evidence and localized reason rendering

**Files:**
- Modify: `web/schedule-workbench.mts:149, 7600-8500`
- Modify: `web/locales/en.js`, `web/locales/de.js`, `web/locales/es.js`, `web/locales/fr.js`, `web/locales/pt.js`
- Modify: `tests/modules/schedule-workbench.test.mjs`
- Modify: `tests/modules/locale-completeness.test.mjs` only if the existing completeness fixture needs new required keys.

**Interfaces:**
- Consumes: typed `CandidateResult`, `CandidateApplyGuard`, `ScheduleStabilitySummary`, and `CandidateSearchSummary` from Tasks 1–4.
- Produces: explicit-outcome `PreviewExplanation`, guarded `OptimizerPreview.canApply()`, bounded candidate examples, and localized copy for all new reason/disposition/search states.

- [ ] **Step 1: Write failing preview tests.** Verify explicit `reason.outcome` controls accepted/rejected rendering, unknown codes become `data-unknown-reason`, search work/evaluation/prune/duplicate counts remain distinct, examples cap at 8, no-improvement disables Apply, stale revision/fingerprint disables Apply and applies zero patches, markup parameters are escaped, and applied audit data contains aggregate fields only.

- [ ] **Step 2: Run focused workbench/locale tests.**

Run: `npm run build; node --test tests/modules/schedule-workbench.test.mjs tests/modules/locale-completeness.test.mjs`

Expected: new contract assertions fail; current preview and missing-setup tests remain the compatibility baseline.

- [ ] **Step 3: Capture the complete guard at preview evaluation.** In `runWithPreview`, capture one `runAt`, immutable options, selected plant/lines, all scoped and boundary tasks, fixed/collision state, calendars/blocks, rank maps, setup snapshot, line settings, and the canonical fingerprint. Reuse that run context for primary and alternate evaluations and independent deterministic budgets.

- [ ] **Step 4: Replace regex/prune inference in `summarizeCandidate`.** Use `CandidateReason.outcome`, registry localization keys, explicit buckets, order decisions, line dispositions, movement summary, and search summary. Render qualified wording for work-budget exhaustion versus emergency interruption and a clear no-op explanation. Keep missing setup-pair detail bounded and separate from aggregate candidate counts.

- [ ] **Step 5: Enforce checked Apply and preserve preview cleanup.** Revalidate the guard immediately before the one Store mutation; mark the preview stale and apply zero patches on any mismatch. Keep the existing UndoStack snapshot behavior, but include every changed task and clear candidate details on Apply/Discard as before.

- [ ] **Step 6: Add locale keys in all five existing locale maps.** Add reason labels, bucket labels, outcome/severity labels, search accounting labels, no-op/stale/interrupted copy, and audit-save warning text using the existing locale key naming conventions. Do not add English producer prose to the UI.

- [ ] **Step 7: Run focused preview tests.**

Run: `npm run build; node --test tests/modules/schedule-workbench.test.mjs tests/modules/locale-completeness.test.mjs`

Expected: PASS with escaped, bounded, explicit reason evidence and a disabled Apply button for every non-applyable disposition.

---

### Task 6: Carry optimizer saves through an isolated durable-persistence path

**Files:**
- Modify: `web/schedule-data.mts:193-245, 1110-1270`
- Modify: `web/application-shell.mts:2140-2185`
- Modify: `web/types.mts` and generated API declarations only for the typed payload/result fields required by the existing `/tasks/update` contract.
- Modify: `tests/modules/schedule-data.test.mjs`

**Interfaces:**
- Consumes: `CandidateResult` summary, applied patch IDs/value fingerprints, captured base row versions, and `CandidateApplyGuard` from the preview.
- Produces: `Persistence.queueOptimizerSave(context)`, an optional `atomic_optimizer_run` request field, and explicit save result handling that distinguishes local Apply, durable save, stale batch, and audit warning.

- [ ] **Step 1: Write failing persistence tests.** Cover optimizer-owned tasks being sent in their own batch before unrelated dirty edits, no `force=true` on the optimizer branch, exact patch/base-version/summary transmission, a later manual edit superseding the pending optimizer summary, zero success-audit interpretation on partial/stale results, and explicit audit-warning handling after a successful DB commit.

- [ ] **Step 2: Run the existing persistence tests.**

Run: `npm run build; node --test tests/modules/schedule-data.test.mjs`

Expected: new assertions fail while the current ordinary save payload tests pass.

- [ ] **Step 3: Add a typed pending optimizer-save record.** Store only patch IDs, applied-value fingerprints, base row versions, plant/scope/options, `reasonSchemaVersion`, and bounded aggregate summary. Queue it from preview Apply after local mutation; do not POST audit success from the browser.

- [ ] **Step 4: Split `saveAll` into optimizer-first and ordinary-save payloads without changing ordinary-save semantics.** The optimizer payload sends exact schedule segments and `base_version` values under `atomic_optimizer_run`; it never sets the ordinary `force` bypass. If any owned task changed after Apply, mark the pending summary superseded and send it as an ordinary dirty edit only.

- [ ] **Step 5: Update autosave integration.** In `application-shell.mts`, retain the current dirty-ID behavior for ordinary events, but invalidate the pending optimizer summary when a later manual task edit, line change, calendar change, setup write, rank-map change, reload, undo, or sandbox transition supersedes the captured bundle.

- [ ] **Step 6: Handle atomic-save results.** Re-stamp versions only for server-persisted IDs; keep all optimizer IDs dirty on stale/invalid/not-found/rolled-back results; show reload/undo guidance; and report an audit-warning field as a warning without falsely labeling the save failed after the DB commit.

- [ ] **Step 7: Run focused data tests.**

Run: `npm run build; node --test tests/modules/schedule-data.test.mjs`

Expected: PASS; ordinary manual saves continue to use the existing best-effort route and payload.

---

### Task 7: Add backend atomic optimizer update and audit validation

**Files:**
- Modify: `db.py` near `update_task_dates_bulk`
- Modify: `brain.py` near `BulkUpdateResult`, `TaskDateUpdate`, `TasksUpdatePayload`, `/tasks/update`, and `/audit/log`
- Create: `tests/test_optimizer_reason_codes.py`
- Modify: `tests/test_log_event.py` only for shared audit helper behavior if the existing tests require the new rejection rule.

**Interfaces:**
- Consumes: `atomic_optimizer_run` payload with plant, exact scoped task IDs, captured `base_version` values, run options, `reasonSchemaVersion`, and bounded aggregate summary.
- Produces: `db.update_optimizer_batch(items, context, allowed_plants) -> {status, persisted, updated, stale, invalid_ids, not_found_ids, versions, audit_warning?}` and a response body whose optimizer success/audit counts are derived from the locked DB result.

- [ ] **Step 1: Write backend unit tests before implementation.** Use FastAPI test-client fixtures/monkeypatches for: schema/size/unknown-field rejection; reason schema version validation; plant scope enforcement; unknown or cross-plant task rejection; generic client `optimization_run` audit rejection; `unverified_actor` labeling; no audit success on partial/failed update; and server-derived counts overriding client claims.

```python
def test_generic_client_cannot_forge_optimizer_audit(tc):
    response = tc.post('/audit/log', json={
        'action': 'optimization_run', 'plant': '5512',
        'details': {'persisted': 999999},
    })
    assert response.status_code == 400
```

- [ ] **Step 2: Run the backend test file with the database guard respected.**

Run: `pytest tests/test_optimizer_reason_codes.py -q`

Expected: new tests fail at missing models/helper; no test may set `NIMBUS_TEST_DB=1` or use a non-local database unless a separate local integration case explicitly requires it.

- [ ] **Step 3: Add bounded Pydantic models and route validation.** Allow only the summary fields defined in the spec, cap numeric/list/string sizes, require `reason_schema_version == 1`, normalize the selected plant/line scope, require the client task-ID set to equal the update set, and obtain the actor from the current header model as `unverified_actor`. Reject cross-plant and unknown task IDs before invoking the optimizer DB branch.

- [ ] **Step 4: Implement `db.update_optimizer_batch`.** In one transaction, lock every target parent row with `FOR UPDATE`, reject duplicates/missing rows/version mismatches/invalid ranges/invalid segments/plant mismatches before any update, then update all parent rows and child segments or none. Preserve ordinary `update_task_dates_bulk` behavior and its `force` path for non-optimizer callers.

- [ ] **Step 5: Append the bounded audit summary only after commit.** Derive `persisted`, moved count, and success status from the locked update result; append `optimization_run` with schema version, search/stability aggregate fields, request ID, and `unverified_actor`. If the file append fails after commit, return `audit_warning` and log the warning without changing the successful DB result.

- [ ] **Step 6: Restrict the generic audit endpoint.** Reject client-supplied `optimization_run` entries; keep admin read/clear behavior and non-optimizer legacy callers intact. Do not claim authenticated actor identity while the application still trusts spoofable headers.

- [ ] **Step 7: Add guarded local DB transaction tests if the existing DB-test conventions support them.** Verify one stale row causes zero optimizer rows to update and never falls back to `force=true`; verify a valid batch updates parent segments atomically; verify audit append occurs after commit. Keep the collection-time safety guard active.

- [ ] **Step 8: Run backend verification.**

Run: `pytest tests/test_optimizer_reason_codes.py tests/test_log_event.py -q`

Expected: PASS without live/Azure DB access; local integration tests run only under the repository’s explicit `NIMBUS_TEST_DB=1` opt-in.

---

### Task 8: Complete integration verification and review the scope boundary

**Files:**
- Modify only files already listed above if a test exposes a phase-specific defect.
- Do not add unrelated cleanup or broad refactoring.

- [ ] **Step 1: Run pure and focused frontend suites.**

Run: `npm run build; node --test tests/modules/schedule-diagnostics.test.mjs tests/modules/setup-scheduler.test.mjs tests/modules/schedule-services.test.mjs tests/modules/schedule-state.test.mjs tests/modules/schedule-workbench.test.mjs tests/modules/schedule-data.test.mjs`

Expected: PASS, including the existing pull-forward regression tests.

- [ ] **Step 2: Run frontend quality gates.**

Run: `npm run typecheck; npm run lint; npm run build`

Expected: PASS with generated `.mjs` output synchronized from `.mts` sources.

- [ ] **Step 3: Run the complete Node suite.**

Run: `npm test`

Expected: PASS for legacy and module suites.

- [ ] **Step 4: Run backend non-DB tests and the repository safety check.**

Run: `pytest -q`

Expected: either PASS against the explicitly safe local target or collection-time refusal when the environment is not opted into local DB tests; never point the run at Azure/live PostgreSQL.

- [ ] **Step 5: Review the diff against the approved design.** Check every changed hunk against the spec sections and the Global Constraints above. Confirm there are no changes to manual drag semantics, ordinary best-effort save behavior, Remove Backlog policy, unrelated UI modules, database schema, or user-owned pre-existing edits. If a desired correction is adjacent rather than required, stop and ask the user before making it.

- [ ] **Step 6: Report verification and any explicit boundary decisions.** Summarize changed files, focused tests, full gates, generated outputs, and any requirement that remains blocked by external authentication/live-environment constraints. Do not claim durable optimizer success unless the atomic save response confirms it.
