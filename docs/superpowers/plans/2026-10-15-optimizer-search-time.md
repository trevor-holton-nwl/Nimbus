# Optimizer Search Time (Normal 8 s / Exhaustive background run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a planner choose the optimizer's search time: Normal (8 s, in the dialog as today) or Exhaustive (up to 3 min, running in the background with a finish popup offering View preview / Apply without preview / cancel).

**Architecture:** The preview computation already runs in a dedicated Web Worker (`frontend/optimization/optimizer-worker-client.mts`). The work is (1) plumbing a caller-chosen budget through `EvaluationRequest` into the engine's search bounds so the deadline, iteration cap, gap-fill budget and (for Exhaustive) the exact-search/convergence knobs scale together; (2) splitting `OptimizerPreview.runWithPreview` into a DOM-free `computePreview` and a `present` step so a run can finish with the modal closed; (3) a background-run lifecycle with a finish popup and a partial-apply path for results that went stale.

**Tech Stack:** TypeScript (`.mts` compiled in place by `tsc`), node:test (`tests/modules`), static HTML/CSS in `frontend/index.html` / `frontend/styles.css`, locale maps in `frontend/locales/*.js`.

**Spec:** the approved plan-mode plan (copied into this file's Context). Owner decisions 2026-10-15: Normal = 8 s; Exhaustive = up to 3 min, background, finish popup; "Apply without preview" lands unsaved changes (planner saves); stale result → warn, allow both, skip orders that no longer fit and list them.

## Global Constraints

- `.mts` edits require `npm run build` before tests run (`npm test` runs it via pretest). Scoped test command for this plan: `node --test tests/modules/optimization/optimize-ui.test.mjs tests/modules/optimization/engine.test.mjs tests/modules/optimization/optimizer-worker.test.mjs tests/modules/setup-scheduler.test.mjs`.
- Gates before any task is complete: scoped tests green, `npm run typecheck`, `npm run lint`. Final: `npm run check:legacy-surface`, `npm run check:static-assets`, full `npm test`.
- All new user-facing text goes through `data-i18n` / `Util.t()` keys; English in `frontend/locales/en.js`, the other four files (`de`, `es`, `fr`, `pt`) get translations in Task 4.
- Existing tests must stay green; the refactor of `runWithPreview` must not change foreground behavior.
- No new worker, no new Store subscription for the run; reuse `runOptimizerPreview` and `AbortController`.
- Exhaustive is never persisted as a user default: the Search time select always reopens on Normal.
- Budget table (exact values):

| Choice | `searchBudgetMs` | `exhaustive` | Primary deadline | `iterationCap` | `gapFillBudgetMs` | `exactSearchThreshold` | `exactSearchLeafCap` | `convergenceWindow` |
|---|---|---|---|---|---|---|---|---|
| Normal | 8000 | false | 8 000 ms | 32 000 × lines | 2 000 | 8 (today) | 500 (today) | 2 000 (today) |
| Exhaustive | 180000 | true | 180 000 ms | 720 000 × lines | 36 000 | 10 | 5 000 | 10 000 |
| absent (tests, legacy callers) | undefined | false | 5 000 ms | 20 000 × lines | 1 000 | 8 | 500 | 2 000 |

Alternate (comparison) plans always use 8 000 ms (`SETUP_AWARE_NORMAL_BUDGET_MS`) regardless of the choice.

## Review Focus

1. A Normal run must look and behave exactly as today (spinner, single reveal, Apply all-or-nothing) apart from the 8 s / 2 s budgets.
2. A background run must never set `OptimizerPreview.active` or open a modal while computing (Confidence stays live, `nimbus-intelligence.js:1510,1606`).
3. Closing the Optimize dialog, switching NIMBUS tabs, or switching plants during a background run must not abort it; only Cancel does.
4. Partial apply must never apply half of a distributed sub-order group and must never apply a patch for an order the planner edited during the run.
5. The worker boundary must still round-trip: `iterationCap`, `deadline`, `exactSearchThreshold` are serialized (`optimizer-worker-contract.mts`), `gapFillBudgetMs`/`exactSearchLeafCap`/`convergenceWindow` are consumed inside the run.

## Context (from the approved plan)

Plant 1008 orders carry the reason "Capacity check incomplete: time limit reached before all available gaps were checked." The optimizer's limits are hard-coded: primary search 5 000 ms (`SETUP_AWARE_DEADLINE_MS`, `frontend/optimization/engine.mts:644`, used at `optimize-ui.mts:1425` and per alternate plan at `:1547`), iteration cap 20 000 × lines (`engine.mts:2749`), gap-fill "capacity check" 1 000 ms (`setup-scheduler.mts:7047`, called without a budget at `engine.mts:975`). The message is the gap-fill budget expiring (`setup-scheduler.mts:7196`, code `search_limit`).

Current code facts (verified):
- `runWithPreview` (`optimize-ui.mts:1351-1611`) force-opens the preview modal (`:1366`), sets `active = true` before computing (`:1393`), the abandon guard turns any modal hide into `discard()` which aborts the worker (`:1339-1347`, `:2221-2223`); alternates tick with rAF (`:1533`).
- Task watch `_startTaskWatch` (`:1275-1293`), baseline `taskBaseline` (`:1019-1031`); `saveAll` re-stamps `row_version` silently (`persistence.mts:1292-1299`); plant switch reloads tasks; `validateCandidateForApply` (`setup-scheduler.mts:6715`) emits candidate-wide `stale_candidate`; `ValidationFinding` has `taskId?`, `parents?`.
- `apply()` (`:2085-2209`): `canApply` → validate → drop running (`Engine.isInProgress`) → audit POST → `Engine.applySchedulePatches` → `Store.setLastOptimize` → `Alerts.clearDismissed` → `UndoStack.push` → toasts → `_clear` → Confidence recompute → `Modal.close` → alert recompute.
- `Modal` (`frontend/platform/foundation.mts:1730-1910`): `open/close/confirm`; three-button modals are static markup (`index.html:2414-2418` `#modal-print`). `Toast.show(msg, type, ms?, action?)` one action.
- Toolbar Optimize button has no id (`index.html:1235`); `#opt-run-btn` managed at `optimize-ui.mts:494, 670-680, 612-613`; `OptimizeDialog.run()` at `:639-788`; `OptimizerDefaults` at `:45`; `optsForEngine` at `:757-775`.
- Quality knobs already on `DueDateFirstBounds` (`setup-scheduler.mts:476-517`): `exactSearchThreshold`, `exactSearchLeafCap?` (default `EXACT_SEARCH_LEAF_CAP = 500`, `:2093`), `convergenceWindow?` (default `SETUP_AWARE_CONVERGENCE_WINDOW = 2000`, `:813`). Engine sets them at `engine.mts:2744, 2769`.
- Test harnesses: `tests/modules/optimization/optimize-ui.test.mjs` `openTaskBaselinePreview` (:153-201) and `openSingleRevealFixture` (:801-848); worker transport assertions in `optimizer-worker.test.mjs:74,103`; `fillPlanningGaps` pins in `tests/modules/setup-scheduler.test.mjs:593-622`.

---

### Task 1: Budget plumbing in the engine and scheduler

**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts` (`EvaluationRequest` ~:434, `DueDateFirstBounds` ~:481, `fillPlanningGaps` ~:7045, `search_limit` message ~:7196)
- Modify: `frontend/optimization/engine.mts` (constants ~:637-644, bounds ~:2744-2769, `evaluateSetupAware` ~:975)
- Test: `tests/modules/optimization/engine.test.mjs`, `tests/modules/setup-scheduler.test.mjs`

**Interfaces:**
- Produces: `EvaluationRequest.searchBudgetMs?: number`, `EvaluationRequest.exhaustive?: boolean`; `DueDateFirstBounds.gapFillBudgetMs?: number`; exported constants `SETUP_AWARE_NORMAL_BUDGET_MS = 8000`, `SETUP_AWARE_EXHAUSTIVE_BUDGET_MS = 180000` from `engine.mts` (Task 3 imports them).

- [ ] **Step 1: Write the failing engine pins** in `engine.test.mjs`. Find how existing tests obtain the bounds the engine builds (search for `iterationCap` or `evaluateSchedule` with a captured `bounds`; if no hook exists, test through `Engine.evaluateSchedule(mode, opts, snapshot)` with a stubbed `Engine.evaluateSetupAware` that records its `bounds` argument and returns a minimal `CandidateResult`). Three cases on a snapshot with 2 lines in scope:
  - `{ searchBudgetMs: 8000 }` → `bounds.iterationCap === 64000`, `bounds.gapFillBudgetMs === 2000`, `bounds.exactSearchThreshold === 8`, `bounds.exactSearchLeafCap === undefined`, `bounds.convergenceWindow === 2000`, `bounds.deadline - clockAtCall ≈ 8000` (within 500 ms) when no `deadlineAt` is passed.
  - `{ searchBudgetMs: 180000, exhaustive: true }` → `iterationCap === 1440000`, `gapFillBudgetMs === 36000`, `exactSearchThreshold === 10`, `exactSearchLeafCap === 5000`, `convergenceWindow === 10000`.
  - `{}` → `iterationCap === 40000`, `gapFillBudgetMs === 1000`, knobs at today's values, deadline ≈ 5000.
- [ ] **Step 2: Run** `npm run build && node --test tests/modules/optimization/engine.test.mjs` → the new pins FAIL.
- [ ] **Step 3: Scheduler types and gap-fill default.** In `setup-scheduler.mts`: add to `EvaluationRequest` (after `deadlineAt`):
  ```ts
  /** Caller-chosen primary search budget in ms (Normal 8000, Exhaustive 180000). Drives the
   *  iteration cap and the gap-fill budget through the engine's bounds builder; absent = 5000. */
  searchBudgetMs?: number;
  /** Exhaustive mode: also raises exactSearchThreshold / exactSearchLeafCap / convergenceWindow. */
  exhaustive?: boolean;
  ```
  Add to `DueDateFirstBounds` (after `iterationCap`): `/** Soft wall-clock budget for fillPlanningGaps; absent = 1000. */ gapFillBudgetMs?: number;`. Change `fillPlanningGaps(snapshot, bounds, candidate, budgetMs = bounds.gapFillBudgetMs ?? 1000)`. Change the `search_limit` message at ~:7196 to `'Capacity check incomplete: time limit reached before all available gaps were checked. Choose Exhaustive search time in the Optimize dialog to check every gap.'`.
- [ ] **Step 4: Engine constants and bounds.** In `engine.mts` next to `SETUP_AWARE_DEADLINE_MS`:
  ```ts
  export const SETUP_AWARE_NORMAL_BUDGET_MS = 8000;
  export const SETUP_AWARE_EXHAUSTIVE_BUDGET_MS = 180000;
  const SETUP_AWARE_EXHAUSTIVE_EXACT_SEARCH_THRESHOLD = 10;
  const SETUP_AWARE_EXHAUSTIVE_EXACT_LEAF_CAP = 5000;
  const SETUP_AWARE_EXHAUSTIVE_CONVERGENCE_WINDOW = 10000;
  function gapFillBudgetFor(searchBudgetMs: number | undefined): number {
    if (searchBudgetMs === undefined) return 1000;
    if (searchBudgetMs >= SETUP_AWARE_EXHAUSTIVE_BUDGET_MS) return 36000;
    if (searchBudgetMs >= SETUP_AWARE_NORMAL_BUDGET_MS) return 2000;
    return 1000;
  }
  ```
  In the setup-aware bounds builder (~:2744-2769): `const budgetMs = typeof opts.searchBudgetMs === 'number' && Number.isFinite(opts.searchBudgetMs) && opts.searchBudgetMs > 0 ? opts.searchBudgetMs : SETUP_AWARE_DEADLINE_MS; const scale = Math.max(1, budgetMs / SETUP_AWARE_DEADLINE_MS); const exhaustive = opts.exhaustive === true;` then `exactSearchThreshold: exhaustive ? SETUP_AWARE_EXHAUSTIVE_EXACT_SEARCH_THRESHOLD : SETUP_AWARE_EXACT_SEARCH_THRESHOLD`, `...(exhaustive ? { exactSearchLeafCap: SETUP_AWARE_EXHAUSTIVE_EXACT_LEAF_CAP } : {})`, `iterationCap: Math.round(SETUP_AWARE_ITERATION_CAP * Math.max(1, linesInScope) * scale)`, `gapFillBudgetMs: gapFillBudgetFor(opts.searchBudgetMs)`, `deadline: (opts.deadlineAt as number | undefined) ?? performance.now() + budgetMs`, `convergenceWindow: exhaustive ? SETUP_AWARE_EXHAUSTIVE_CONVERGENCE_WINDOW : SETUP_AWARE_CONVERGENCE_WINDOW`. Leave the backlog bounds (~:2558) untouched. In `evaluateSetupAware` (~:975): `return fillPlanningGaps(snapshot, bounds, candidate, bounds.gapFillBudgetMs);` (explicit). Confirm the serialized-bounds guard (~:3188) still accepts the scaled values (it validates `exactSearchThreshold ≥ 0`, `iterationCap` positive integer) and that `rehydrate` (~:3220) carries `exactSearchThreshold`; `gapFillBudgetMs`, `exactSearchLeafCap` and `convergenceWindow` are consumed inside the run and need no serialization (verify by reading `optimizer-worker-contract.mts` `serializeOptimizerBounds`).
- [ ] **Step 5: Scheduler pins** in `tests/modules/setup-scheduler.test.mjs` next to the existing `fillPlanningGaps` tests (~:593-622): (a) with `bounds.gapFillBudgetMs = 0` and the parameter omitted, a candidate with pending orders returns `gapFill.complete === false` and the `search_limit` message contains `'Exhaustive'`; (b) the same call with `bounds.gapFillBudgetMs = 60000` returns `gapFill.complete === true`. Use a fake `clock` on bounds if the existing pins do.
- [ ] **Step 6: Run** the scoped command: `npm run build && node --test tests/modules/optimization/engine.test.mjs tests/modules/setup-scheduler.test.mjs tests/modules/optimization/optimizer-worker.test.mjs` → all green. Then `npm run typecheck && npm run lint`.
- [ ] **Step 7: Commit** `feat(optimization): caller-chosen search budget scales deadline, iteration cap, gap-fill and exhaustive search knobs`.

---

### Task 2: Split `runWithPreview` into `computePreview` + `present`, extract `_commitPatches`

**Files:**
- Modify: `frontend/optimization/optimize-ui.mts` (`runWithPreview` ~:1351-1611, `apply` ~:2085-2209)
- Test: `tests/modules/optimization/optimize-ui.test.mjs` (existing tests are the refactor guard; one new pin)

**Interfaces:**
- Produces (module-internal, on `OptimizerPreview`):
  ```ts
  interface PreviewResult {
    runSeq: number; mode: OptimizerMode; plant: string; opts: OptimizerRunOptions;
    snapshot: ScheduleSnapshot; taskBaseline: Map<string, string>;
    candidate: CandidateResult; finalists: Finalist[] | null;   // use the existing _finalists element type
    preKpis: unknown; postKpis: unknown; explanation: unknown; previewDiagnostics: unknown;
    splitOrderPolicy: unknown; backlogResult: unknown; backlogAudit: unknown; auditDetails: unknown; syntheticSetup: unknown;
    startedAt: number; runtimeMs: number;
  }
  computePreview(mode, opts, { signal, tick }: { signal?: AbortSignal; tick: () => Promise<void> }): Promise<PreviewResult>
  present(result: PreviewResult, { open }: { open: boolean }): void
  _commitPatches(kept: SchedulePatch[], skippedIds: string[], snapBeforeApply: NimbusTask[]): Promise<void>  // audit → applySchedulePatches → setLastOptimize → clearDismissed → UndoStack → toasts → _clear → Confidence → Modal.close → alerts
  ```
  Use the real field types already declared on `OptimizerPreview` instead of `unknown` where they exist.

- [ ] **Step 1: Read** `runWithPreview` (:1351-1611) and `apply` (:2085-2209) fully, and the harness `openTaskBaselinePreview` / `openSingleRevealFixture` in the test file.
- [ ] **Step 2: Extract `computePreview`.** Move everything from the snapshot/structuredClone (:1386-1389) through the alternates loop to `_finalists` (:1574) into `computePreview`. It must not touch `active`, `_candidate`, `_snapshot`, `_taskBaseline`, `_finalists`, `_startTaskWatch`, `showLoading`, `_render`, `Modal`, or `document`. Between alternates it awaits `tick()`. Abort checks use `signal.aborted` plus the existing `_runSeq` guard passed in via `runSeq`. Stale truncation inside the loop (`if (OptimizerPreview.stale) ...` ~:1543) applies only to foreground: pass a `shouldStop: () => boolean` in the options (foreground: `() => OptimizerPreview.stale || OptimizerPreview._runSeq !== runSeq`; background: `() => false`).
- [ ] **Step 3: Extract `present`.** Assign every field from the result (including `_taskBaseline`, `_snapshot`, `_candidate`, `_finalists`, `stale = false`, `_staleReason = null`, `_staleMessageKey = null`), set `active = true`, call `_startTaskWatch()`, then if `open`: ensure the modal is open (`showLoading` if hidden, as :1366 does today), re-enable footer buttons, `_syncApplyButton()`, `_render()`, `_endLoadingState()`, focus the head button (:1576-1580).
- [ ] **Step 4: Rewire `runWithPreview`** = abort previous controller + new one, `runSeq`, clear diagnostics (as today :1354-1358), `showLoading` if hidden, double rAF (keep :1376), then `const result = await computePreview(mode, opts, { signal, tick: rafTick, shouldStop, runSeq })`, then `present(result, { open: true })`. Keep the error paths (:1582-1604) byte-for-byte in behavior: AbortError → `_clear()` if current; other → `_clear(true)` + error card.
- [ ] **Step 5: Extract `_commitPatches`** from `apply()` (:2100-2209): everything after the running-order drop. `apply()` becomes: `canApply` → validate → drop running → `_commitPatches(keptPatches, runningSkippedIds, snap)`. The toast for running-skipped stays where it is (inside `_commitPatches` when `skippedIds.length`, using the existing key `toast.opt_apply_running_skipped`; Task 3 adds a second toast key for stale-skipped and passes a `reason` argument — design `_commitPatches(kept, skipped: { ids: string[]; reason: 'running' | 'changed' }, snap)` now so Task 3 does not re-touch the signature).
- [ ] **Step 6: Run** `npm run build && node --test tests/modules/optimization/optimize-ui.test.mjs` → every existing test green (this is the refactor guard). Add one pin: `computePreview` on the sync evaluator resolves with `active === false` and `_candidate === null` until `present` is called; after `present(result, { open: false })`, `active === true`, `_candidate === result.candidate`, no `_render` write to the body (use `openSingleRevealFixture`'s recorded body writes).
- [ ] **Step 7:** `npm run typecheck && npm run lint`.
- [ ] **Step 8: Commit** `refactor(optimization): split runWithPreview into computePreview/present and extract _commitPatches (no behavior change)`.

---

### Task 3: Search time option, background run, finish popup, partial apply

**Files:**
- Modify: `frontend/index.html` (Options row ~:2596-2610; toolbar button :1235; new modal after `#modal-opt-preview` ~:2690)
- Modify: `frontend/styles.css` (one rule for `.btn-optimize.is-running`)
- Modify: `frontend/optimization/optimize-ui.mts` (`OptimizerRunOptions` :71, `previewEvaluationRequest` :82-99, `OptimizeDialog.open` :612, `run` :639-788, `optsForEngine` :757-775, primary deadline :1425, alternates :1547, new background members)
- Modify: `frontend/locales/en.js` (keys below)
- Test: `tests/modules/optimization/optimize-ui.test.mjs`, `tests/modules/optimization/optimizer-worker.test.mjs`

**Interfaces:**
- Consumes: Task 1 constants `SETUP_AWARE_NORMAL_BUDGET_MS`, `SETUP_AWARE_EXHAUSTIVE_BUDGET_MS`; Task 2 `computePreview`, `present`, `_commitPatches(kept, { ids, reason }, snap)`.
- Produces: `OptimizerPreview.runInBackground(mode, opts)`, `backgroundView()`, `backgroundApply()`, `backgroundDismiss()`, `cancelBackground()`, `_backgroundRun`, `_changedSinceBaseline(result)`, `applyPartial(result)`; DOM ids `opt-search-budget`, `btn-optimize`, `modal-opt-background-done`, `opt-bg-done-body`, `opt-bg-view-btn`, `opt-bg-apply-btn`.

- [ ] **Step 1: Markup.** In `index.html` Options section, after the two checkboxes inside `.opt-check-row` (or as a sibling row if the row is flex-wrapped), add:
  ```html
  <label class="opt-check opt-select-row" id="opt-budget-label" for="opt-search-budget">
    <span data-i18n="ui.opt_search_time">Search time</span>
    <select id="opt-search-budget">
      <option value="8" data-i18n="ui.opt_search_time_normal">Normal (8 s)</option>
      <option value="180" data-i18n="ui.opt_search_time_exhaustive">Exhaustive (up to 3 min, runs in the background)</option>
    </select>
  </label>
  <div class="opt-hint" data-i18n="ui.opt_search_time_hint">Exhaustive keeps searching for up to 3 minutes while you keep working and tells you when it is done. Comparison plans always use the normal budget.</div>
  ```
  Reuse the strategy dropdown's classes if it has a `select` style (search `id="opt-strategy"` or the `_initStrategySelectListener` target) so the control matches. Toolbar: `<button class="seg-btn btn-optimize" id="btn-optimize" ...>` (keep the existing `onclick`). New modal after `#modal-opt-preview`, following `#modal-print`'s structure:
  ```html
  <div class="modal-backdrop" id="modal-opt-background-done" hidden>
    <div class="modal modal-sm" role="dialog" aria-labelledby="opt-bg-done-title">
      <div class="modal-head"><h3 id="opt-bg-done-title" data-i18n="ui.opt_bg_done_title">Exhaustive optimization finished</h3>
        <button class="modal-x" aria-label="Close" onclick="NIMBUS.OptimizerPreview.backgroundDismiss()">×</button></div>
      <div class="modal-body" id="opt-bg-done-body"></div>
      <div class="modal-foot">
        <button class="btn" id="opt-bg-view-btn" onclick="NIMBUS.OptimizerPreview.backgroundView()" data-i18n="ui.opt_bg_view">View preview</button>
        <button class="btn btn-primary" id="opt-bg-apply-btn" onclick="NIMBUS.OptimizerPreview.backgroundApply()" data-i18n="ui.opt_bg_apply">Apply without preview</button>
      </div>
    </div>
  </div>
  ```
  Copy the exact class names from `#modal-print` / `#modal-opt-preview` rather than the ones above if they differ. `styles.css`: `.btn-optimize.is-running::after { content:''; display:inline-block; width:8px; height:8px; margin-left:6px; border-radius:50%; background: var(--accent, #3b82f6); animation: opt-bg-pulse 1.2s ease-in-out infinite; } @keyframes opt-bg-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }` using an existing colour token from `DESIGN.md` / `styles.css` `:root`.
- [ ] **Step 2: Dialog wiring.** `OptimizerRunOptions`: add `searchBudgetMs?: number; exhaustive?: boolean`. `previewEvaluationRequest`: forward both. `open()` (:612): `const sel = document.getElementById('opt-search-budget') as HTMLSelectElement | null; if (sel) sel.value = '8';` and reflect a running background run in `#opt-run-btn` (disabled, text `Util.t('btn.opt_run_bg_busy')`). `run()` (:639): read the select; `const exhaustive = sel?.value === '180'`; if `OptimizerPreview._backgroundRun` exists → `Toast.show(Util.t('toast.opt_bg_running', { plant: bgPlant }), 'warn')` and return before any other side effect. `optsForEngine`: add `searchBudgetMs: exhaustive ? SETUP_AWARE_EXHAUSTIVE_BUDGET_MS : SETUP_AWARE_NORMAL_BUDGET_MS, exhaustive`; audit details: add `searchBudgetMs` and `exhaustive`. Branch: if `exhaustive` → `close(true)` the dialog, restore the Run button, then `OptimizerPreview.runInBackground(_mode, optsForEngine)`; else today's path. Primary deadline (:1425): `performance.now() + (opts.searchBudgetMs ?? SETUP_AWARE_NORMAL_BUDGET_MS)`; alternates (:1547): `performance.now() + SETUP_AWARE_NORMAL_BUDGET_MS` and pass `{ ...opts, searchBudgetMs: SETUP_AWARE_NORMAL_BUDGET_MS, exhaustive: false }` to `previewEvaluationRequest` for alternates.
- [ ] **Step 3: Background run.** On `OptimizerPreview`:
  ```ts
  _backgroundRun: null as null | { plant: string; mode: OptimizerMode; startedAt: number; controller: AbortController | null; result: PreviewResult | null; error: string | null },
  async runInBackground(mode, opts) {
    const plant = opts.plant!; const controller = new AbortController();
    OptimizerPreview._backgroundRun = { plant, mode, startedAt: performance.now(), controller, result: null, error: null };
    OptimizerPreview._syncToolbarRunning(); OptimizerPreview._installLeaveGuard();
    Toast.show(Util.t('toast.opt_bg_started', { plant }), 'info', 6000, { label: Util.t('btn.cancel'), run: () => OptimizerPreview.cancelBackground() });
    try {
      const result = await OptimizerPreview.computePreview(mode, opts, { signal: controller.signal, tick: () => new Promise(r => setTimeout(r, 0)), shouldStop: () => false, runSeq: ++OptimizerPreview._runSeq });
      if (OptimizerPreview._backgroundRun?.controller !== controller) return;   // cancelled meanwhile
      OptimizerPreview._backgroundRun.result = result;
      OptimizerPreview._renderBackgroundDone(); Modal.open('modal-opt-background-done');
    } catch (err) {
      if (OptimizerPreview._backgroundRun?.controller !== controller) return;
      if ((err as Error)?.name === 'AbortError') { OptimizerPreview._backgroundRun = null; Toast.show(Util.t('toast.opt_bg_cancelled'), 'info'); }
      else { OptimizerPreview._backgroundRun.error = String((err as Error)?.message ?? err); OptimizerPreview._renderBackgroundDone(); Modal.open('modal-opt-background-done'); }
    } finally { OptimizerPreview._syncToolbarRunning(); OptimizerPreview._removeLeaveGuard(); }
  },
  cancelBackground() { const run = OptimizerPreview._backgroundRun; if (!run) return; run.controller?.abort(); OptimizerPreview._backgroundRun = null; OptimizerPreview._syncToolbarRunning(); OptimizerPreview._removeLeaveGuard(); Toast.show(Util.t('toast.opt_bg_cancelled'), 'info'); },
  ```
  `_syncToolbarRunning()`: toggle class `is-running` and `title` on `#btn-optimize`; while running, the button's click asks `Modal.confirm({ title: Util.t('modal.opt_bg_cancel_confirm', { plant, elapsed }) , tone: 'warn' })` → on true `cancelBackground()`; implement by wrapping: on sync, set `btn.onclick = running ? askCancel : () => OptimizeDialog.open()`. `_installLeaveGuard` / `_removeLeaveGuard`: a single `beforeunload` listener stored on the object that calls `e.preventDefault(); e.returnValue = '';` while `_backgroundRun` is non-null and its result is null.
- [ ] **Step 4: Finish popup.** `_changedSinceBaseline(result)`: for every patch id in `result.candidate.patches`, compare `canonical(Store.getTask(id))` (reuse the baseline canonicalizer at :1019-1027) with `result.taskBaseline.get(id)`; return `{ changed: string[]; missing: string[] }`. `_renderBackgroundDone()`: body shows (a) `ui.opt_bg_done_summary` with `{ plant, placed, queued, seconds }` where placed = patches with a non-null `start_date`, queued = patches with `planning_status === 'needs_planning'`, seconds = `Math.round(result.runtimeMs / 1000)`; (b) if `result.candidate.diagnostics?.limitReached` the existing `ui.opt_pv_diag_limit_reached_note`; (c) if `changed.length + missing.length > 0` → `ui.opt_bg_done_changed` with `{ count }` in a warn block; (d) if `Store.selectedPlant !== result.plant` → `ui.opt_bg_done_other_plant` with `{ current, plant }` and disable `#opt-bg-apply-btn`; (e) if `result.candidate.validationFindings?.some(f => f.severity === 'error' && !f.taskId)` disable apply as well; (f) error variant: the error text, apply disabled, view disabled. `backgroundDismiss()`: `Modal.close`, `_backgroundRun = null`, `Toast.show(Util.t('toast.opt_discarded'), 'info')`. `backgroundView()`: `const run = ...; Modal.close('modal-opt-background-done'); OptimizerPreview._backgroundRun = null; present(run.result, { open: true });` then if `_changedSinceBaseline` was non-empty call `_markTaskStale('background result predates local edits', 'ui.opt_preview_task_stale')` and set `_partialApplyAllowed = true` so `_syncApplyButton` keeps Apply enabled with label `ui.opt_pv_apply_fits` and `apply()` routes to `applyPartial` when `_partialApplyAllowed && stale`. `backgroundApply()`: close the modal, `present(run.result, { open: false })`, `_backgroundRun = null`, then `applyPartial(run.result)`.
- [ ] **Step 5: Partial apply.** `async applyPartial(result)`: (1) if `Store.selectedPlant !== result.plant` → toast `toast.opt_bg_other_plant` and return; (2) `const live = id => Store.getTask(id)`; drop set = ids where `!live(id)` or `Engine.isInProgress(live(id))` (reuse the plant-clock logic from `apply`) or `canonical(live(id)) !== result.taskBaseline.get(id)`; (3) extend the drop set with distribution siblings: for every dropped id whose task has a parent reference (search the task shape for the sub-order parent field used by `distribution_separation`; if the field is `parent_order`/`PARENT_ID`, use that), add every other patch id with the same parent; (4) `let kept = patches.filter(p => !drop.has(p.id))`; run `validateCandidateForApply({ ...result.candidate, patches: kept }, snapshotSchedule(result.plant))`; for each finding with `severity === 'error'`: if `taskId` → add to drop (and its siblings); if `code === 'stale_candidate'` → ignore; else → refuse: `Toast.show(Util.t('toast.opt_apply_stale'), 'warn')` (the existing "no longer valid" key used at :2097), `_clear()`, return; (5) filter again, re-validate once, apply the same rule (a second candidate-wide non-stale error refuses); (6) `_applying = true` and `_commitPatches(kept, { ids: [...drop], reason: 'changed' }, snapBeforeApply)` where `snapBeforeApply` is the same snapshot `apply()` takes for Undo. `_commitPatches` with `reason: 'changed'` toasts `toast.opt_bg_partial_applied` with `{ applied, skipped, list }` (list = first 5 ids joined by ', ' plus ` (+k more)`), and with `reason: 'running'` the existing running-skipped toast.
- [ ] **Step 6: English locale keys** in `frontend/locales/en.js` (place next to the other `ui.opt_*` keys):
  ```js
  'ui.opt_search_time': 'Search time',
  'ui.opt_search_time_normal': 'Normal (8 s)',
  'ui.opt_search_time_exhaustive': 'Exhaustive (up to 3 min, runs in the background)',
  'ui.opt_search_time_hint': 'Exhaustive keeps searching for up to 3 minutes while you keep working and tells you when it is done. Comparison plans always use the normal budget.',
  'btn.opt_run_bg_busy': 'Exhaustive run in progress…',
  'toast.opt_bg_started': 'Exhaustive optimization started for plant {{plant}} (up to 3 min). You can keep working.',
  'toast.opt_bg_running': 'An exhaustive optimization is already running for plant {{plant}}. Wait for it to finish or cancel it from the Optimize button.',
  'toast.opt_bg_cancelled': 'Exhaustive optimization cancelled.',
  'toast.opt_bg_other_plant': 'Switch back to plant {{plant}} to apply this result.',
  'toast.opt_bg_partial_applied': 'Applied {{applied}} orders; {{skipped}} skipped because the schedule changed: {{list}}',
  'modal.opt_bg_cancel_confirm': 'Exhaustive optimization for plant {{plant}} is running ({{elapsed}} elapsed). Cancel it?',
  'ui.opt_bg_done_title': 'Exhaustive optimization finished',
  'ui.opt_bg_done_summary': 'Plant {{plant}}: {{placed}} orders placed, {{queued}} still need planning, searched for {{seconds}} s.',
  'ui.opt_bg_done_changed': '{{count}} proposed order(s) changed or disappeared while the optimizer was running. Those will be skipped; the rest can still be applied.',
  'ui.opt_bg_done_other_plant': 'You are viewing plant {{current}}. Switch back to plant {{plant}} to apply this result.',
  'ui.opt_bg_done_failed': 'The exhaustive run failed: {{error}}',
  'ui.opt_bg_view': 'View preview',
  'ui.opt_bg_apply': 'Apply without preview',
  'ui.opt_pv_apply_fits': 'Apply what still fits',
  'ui.opt_bg_leave_warning': 'An exhaustive optimization is still running. Leaving this page will lose it.',
  ```
  and change `ui.opt_pv_diag_limit_reached_note` to `'The search stopped at a time or iteration limit rather than converging — choose Exhaustive search time in the Optimize dialog for a longer run.'`. Keep the `btn.cancel` key if it exists; otherwise use the existing cancel label key found in `en.js`.
- [ ] **Step 7: Tests** in `optimize-ui.test.mjs` (follow `openTaskBaselinePreview`; stub `Toast.show`, `Modal.open/close` by giving the stub document elements with the ids above where needed; `AbortController` exists in Node):
  1. `runInBackground('spt', opts)` on the sync evaluator: while awaiting (make the sync evaluator stub record a call and return) `active === false`; after resolution `_backgroundRun.result` is set, `Modal.open` was called with `'modal-opt-background-done'`, `#btn-optimize` class list toggled `is-running` on then off.
  2. Edit one proposed order via `Store.update(id, {...}, 'user')` between compute and `backgroundApply()`: `_changedSinceBaseline` reports it; after `backgroundApply()` that order's start is unchanged, the others match the candidate, one `UndoStack.push`, and the toast text contains the skipped id.
  3. `Store.setSelectedPlant('other')` before the popup: `#opt-bg-apply-btn.disabled === true`; `backgroundApply()` toasts `toast.opt_bg_other_plant` and applies nothing.
  4. `cancelBackground()` mid-run aborts the controller (`signal.aborted === true`) and clears `_backgroundRun`; `backgroundDismiss()` after completion clears the result and toasts `toast.opt_discarded`.
  5. `OptimizeDialog.run()` with the select at `'180'` while `_backgroundRun` is set → toast `toast.opt_bg_running`, no new controller.
  6. In `optimizer-worker.test.mjs` next to :103: a primary request built with `searchBudgetMs: 180000` posts `deadlineDurationMs` in `(170000, 180000]`; with `8000` in `(7000, 8000]`.
  7. `OptimizeDialog.open()` resets `#opt-search-budget` to `'8'` after it was `'180'`.
- [ ] **Step 8: Run** the scoped command (all four files) → green; `npm run typecheck && npm run lint && npm run check:legacy-surface && npm run check:static-assets`.
- [ ] **Step 9: Commit** `feat(optimization): Search time option — Normal 8 s or Exhaustive background run with finish popup and partial apply`.

---

### Task 4: Translations and docs

**Files:**
- Modify: `frontend/locales/de.js`, `frontend/locales/es.js`, `frontend/locales/fr.js`, `frontend/locales/pt.js`
- Modify: `frontend/optimization/CLAUDE.md`, `frontend/optimization/AGENTS.md` (twin; keep identical), `docs/architecture/optimizer-dispatch.md`

- [ ] **Step 1: Locales.** For every key Task 3 added to `en.js` (list them with `git diff main -- frontend/locales/en.js`), add the translated entry at the same relative position in the four files, preserving `{{placeholders}}` verbatim, and translate the reworded `ui.opt_pv_diag_limit_reached_note`. Run `npm run lint` (covers locales).
- [ ] **Step 2: Domain doc.** In `frontend/optimization/CLAUDE.md`: update the single-reveal paragraph (~:41) to say each alternate is bounded by `SETUP_AWARE_NORMAL_BUDGET_MS` (8 000); update the budgets paragraphs (~:76-80) with `searchBudgetMs`/`exhaustive`, the scale rule (iteration cap = 20 000 × lines × budget/5 000), `gapFillBudgetMs` (1 000 / 2 000 / 36 000) and the Exhaustive knobs (10 states, 5 000 orderings, convergence 10 000); add a paragraph "Background (Exhaustive) run": `computePreview`/`present` split, `active` stays false while computing, finish popup `#modal-opt-background-done`, `applyPartial` rule (drop edited/missing/running patches plus distribution siblings, ignore `stale_candidate`, per-order errors dropped, candidate-wide non-stale errors refuse), Exhaustive never persisted as a default, one background run at a time, `beforeunload` guard. Mirror the same text into `AGENTS.md`.
- [ ] **Step 3: Dispatch doc.** `docs/architecture/optimizer-dispatch.md` "Search controls" (~:79-88): one bullet for `EvaluationRequest.searchBudgetMs` / `exhaustive` and the derived values table from Global Constraints.
- [ ] **Step 4: Commit** `docs+i18n(optimization): search time option and background run`.
