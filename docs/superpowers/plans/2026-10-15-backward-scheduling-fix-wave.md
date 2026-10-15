# Backward Scheduling: Validation Fix Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Doc of record:** Step 0 copies this file verbatim to `docs/superpowers/plans/2026-10-15-backward-scheduling-fix-wave.md`; every later edit goes there. This `~/.claude/plans` copy is the approval artifact only.

**Goal:** Fix every confirmed Critical and Important defect from the 2026-10-15 validation run, apply the owner's decisions D1–D21, and bundle the Minor findings that live in the same files, so `feature/backward-scheduling` is ready to merge to `main` and cut over in one release.

**Architecture:** Targeted edits on the existing branch, no redesign. Six sequential batches (0, A, B, C, D, F), each implemented by one Sonnet (or Haiku, where marked) subagent working task by task with a commit per task, then a fresh Sonnet reviewer per batch, then one whole-branch review and gate. The orchestrator writes briefs and rulings only; it never edits code, runs the suite, or reads diffs.

**Tech Stack:** TypeScript `.mts` compiled in place by `tsc` (`npm run build`), Python 3 / FastAPI / psycopg (repo `.venv`), Postgres (local scratch DB only), node `--test` module tests, pytest.

**Spec:** `docs/superpowers/plans/2026-10-15-backward-scheduling-validation-findings.md` — §3 (finding lines, file:line anchors), §7a (owner decisions D1–D21), §8 (inputs). The change doc of record is `BACKWARD_SCHEDULING_MIGRATION.md`; gap decisions made during this run are appended to its "Implementation log and gap decisions (2026-10)" section (last subsection currently at line 5609; append a new `### Validation fix wave (2026-10-15)` after it).

## Context

The validation run (fifteen reviewer agents, fourteen checkers, full gate plus a trial merge) found the branch stable and its core design sound, but not mergeable: 1 Critical, 19 Important and 29 Minor confirmed defects. The owner read the findings and answered all 22 open questions on 2026-10-15 (findings §7a). This plan turns those findings and decisions into a fix wave on the same branch, in the style of the two earlier waves (Sonnet implements, Sonnet reviews, autonomous, nothing merged or deployed). Scope agreed with the owner: the must-fix set, every decision-driven change, and the Minors that share a file with a fix; repair-only tests plus one pinning test per fixed Critical/Important; the ten browser checks and the cutover rehearsal stay on the owed list.

**Two scope cuts the owner should know about (made here, not in §7a):**
1. **Optimizer evaluators keep viewer-zone elapsed time** (part of VI3). The setup-scheduler measures every candidate as `start + minutes` on naive Dates in a dozen places; moving it onto plant-zone instants is a rewrite of its time arithmetic. This plan fixes every engine-level forward path (manual edits, running holds, auto-reflow, Remove Backlog, overlong tests) and makes the server width check tolerant of the repeated hour. Residual: an optimizer placement that straddles the plant's spring-forward gap on the DST day, viewed from a browser in a different DST calendar, is rejected at Save with a width toast and re-runs correctly afterwards. Twice a year, one hour, rare viewer mix. Recorded in the gap log.
2. **The date-only flag backfill for existing rows is a midnight heuristic** (D10). New ingests store the flag from what SAP actually sent; rows already in the database have no such record, so the migration marks `original_finish_received` at exact midnight as date-only once. A genuine midnight due date on an existing row would be read as date-only until SAP next sends it.

## Global Constraints

- Branch: all work on `feature/backward-scheduling` from tip `69df633`. **Nothing is merged, pushed or deployed.** `main` is at `62d786e`; do not fork from or merge into it. `feature/backward-scheduling-phase1` is left in place and not touched.
- Delegation: **Sonnet implements and reviews every package; Haiku only Batch 0 (locale rows) and Task D2 (doc drift); never Opus, never Fable.** The orchestrator writes no code, runs no suite, reads no diff; a Sonnet reviewer does and the orchestrator relays the verdict.
- Token discipline for subagents: each brief carries the task text below verbatim (it pins file:line and before/after). Implementers do not grep repo-wide, do not read files they do not own beyond the lines named, do not run the full suite (scoped commands only). Line numbers are from tip `69df633`; re-locate by the quoted text if they drifted.
- Tests: repair-only plus one pinning test per fixed Critical/Important, in the existing test file named in the task. No new suites. Scoped runs per task; the full gate runs once per batch (reviewer) and once at the end (Task F1).
- pytest needs a local Postgres: `PG_HOST=localhost PG_DB=nimbus_sdd PG_USER=postgres PG_SSLMODE=disable NIMBUS_TEST_DB=1 PG_PASS=<ask the owner at run start; never write it to any file>`. `python` is not on PATH: use `.venv/Scripts/python.exe`. `.env` is not read or edited. The pg-marked tests seed and roll back; nothing persists.
- Every `.mts` edit is followed by `npm run build` before any node test (tests import compiled `.mjs` twins, gitignored).
- All new UI text goes through `Util.t('key')` with rows in all five locales (`frontend/locales/{en,de,es,fr,pt}.js`). No SAP field codes in docs or UI copy.
- Commit per task: `fix(<domain>): …` / `test(...)` / `docs(...)`, body naming the finding ids and decision ids, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ledger: `.superpowers/sdd/2026-10-13-backward-scheduling-implementation/progress.md`, append-only, **subagents write their own lines**: `Fixwave2 <task>: <sha> <one-line summary>`, `Fixwave2 <task>: gap filled: <what, choice, why>`, `Fixwave2 <batch> review: <verdict; ids>`, `Fixwave2 <task>: fix round N: <sha> …`. The orchestrator writes only `- Ruling (...)` bullets and `Fixwave2 BATCH <X> START/COMPLETE` markers.
- Autonomous run: no pause for owner review. Small gaps are filled on the implementer's judgement and logged (ledger + spec log). Only a truly large deviation stops the run: a §7a decision that cannot be implemented as written, a schema change beyond the one planned column, or a test that cannot go green without changing a decided behaviour.

## Owner decisions this plan implements (findings §7a)

| Id | Decision (short) | Closes | Task |
|---|---|---|---|
| D1 | Minute precision everywhere except a horizontal Gantt drag | VI1 | A2 |
| D2 | No manual bar resize; run-time edit is the only resize; finish edits on a running order refused | VI7 | A3 |
| D3 | Running order with unreproducible start: walk the remaining run forward through working time | VU1 | A3 |
| D4 | Hand placement unchanged (default calendars always exist) | VI4 closed | — |
| D5 | Approved over-cap order on a never plant releases as one marked bar | VI6 | A4 |
| D6 | A changeover never splits an order that fits one window | VM9 | B3 |
| D7 | Rigid shift on all surfaces | VU9 closed | — |
| D8 | Day caps unchanged; fix help text | VM5 | 0 |
| D9/D9a | Floats deferred; no reduction step | VM1 closed | — |
| D9b | Minute flip stays; warning unless beyond the push cap | matrix row 4 | B4 |
| D9c | Date-only due on a holiday resolves silently | VP1 | A7 |
| D10 | Persist date-only flag; Send transmits the working-window close | VI12 | C2 |
| D11 | Echo truncation waits for A9 | VU6 closed | — |
| D12 | Marker change counts as a move | VM15 | C1 |
| D13 | Cheap external-writer fixes; `trust_start` default kept | VM2, VM3, VM16 | C1 |
| D14 | Cutover excludes no line; `line_no_calendar` relaxed to the default calendar | VI14, VM21 | A5, B5, D1 |
| D15 | Running order keeps its stored end at cutover | L10-7 | C4, D1 |
| D16 | One release from the single merge; Phase-1-first dropped | VI18, VI19 | D1 |
| D17 | Fix VC1, VI2 (+VI3/VM17), VI17 before cutover | VC1, VI2, VI3, VI17, VM17 | A1, B1, C1 |
| D18 | Snapshot-before-cutover precondition; restore skips orphaned segments | VI15, VI16 | C4 |
| D19 | Frozen-window warning only on a real crossing for firmed rows | VU17 | A7 |
| D20 | Approved exception = amber, not blocking, sticky marker | VM14 | B5 |
| D21 | Remove Backlog 'run time grew' note kept in the browser cache | VM8 | A6 |

Also must-fix, no decision needed: VI5 (A2), VI8 (A6), VI9 (A6), VI10 (B3), VI11 (C3), VI13 (C2). Bundled Minors: VM3, VM4, VM6, VM7, VM12, VM13, VM16, VM22, VM23, VM24, VM26, VM27, VM28, VM29 (VM25 and VM10/VM11 are in untouched files and stay deferred; listed in Task F3's residual list).

## Work packages

| Batch | Task | Model | Files owned (nothing else) | Findings |
|---|---|---|---|---|
| 0 | 0.1 locale rows | Haiku | `frontend/locales/{en,de,es,fr,pt}.js` | D8/VM5, new key for A3, missing `ui.opt_pv_split_overlong` |
| A | A1 | Sonnet | `frontend/scheduling/persistence.mts`, `tests/modules/scheduling/persistence.test.mjs` | VC1 |
| A | A2 | Sonnet | `frontend/optimization/engine.mts`, `frontend/scheduling/orders.mts`, `frontend/scheduling/gantt.mts`, `tests/modules/optimization/engine.test.mjs` | VI1, VI5 (D1) |
| A | A3 | Sonnet | same as A2 | VI7 (D2), VU1 (D3) |
| A | A4 | Sonnet | `engine.mts`, `engine.test.mjs` | VI6 (D5) |
| A | A5 | Sonnet | `engine.mts`, `engine.test.mjs` | VI14 client half (D14) |
| A | A6 | Sonnet | `frontend/platform/store.mts`, `persistence.mts`, `tests/modules/platform/store.test.mjs`, `persistence.test.mjs` | VI8, VI9, VM8 (D21) |
| A | A7 | Sonnet | `engine.mts`, `engine.test.mjs` | VU17 (D19), VP1 (D9c) |
| B | B1 | Sonnet | `frontend/calendar/calendar-engine.mts`, `engine.mts`, the calendar test file under `tests/modules/calendar/`, `engine.test.mjs` | VI3, VM17, VI17 (D17) |
| B | B2 | Sonnet | `frontend/optimization/setup-scheduler.mts`, `calendar-engine.mts`, `frontend/insights/services.mts`, `engine.mts`, `tests/modules/setup-scheduler.test.mjs`, calendar test | VI10, VM9 (D6), VM6, VM7 |
| B | B3 | Sonnet | `frontend/nimbus-compute-core.js`, `frontend/insights/insights-ui.mts`, their tests under `tests/modules/insights/` and `tests/js/` | D9b, D20, VM12, VM13, VI14 alert half |
| C | C1 | Sonnet | `db.py`, `backend/scheduling/routes.py`, `backend/scheduling/models.py`, `tests/test_task_concurrency.py` | VI2 server, D12, D13 (VM2, VM3, VM16) |
| C | C2 | Sonnet | `backend/integration/sap_staging.py`, `db.py` (ingest sites only), `backend/distribution/data.py` (child upsert only), `migrations/2026-10-16-2-orders-original-finish-date-only.sql` (new), `schema.sql`, `tests/test_sap_staging.py` | VI12 (D10), VI13 |
| C | C3 | Sonnet | `backend/distribution/data.py`, `tests/test_distribution.py` | VI11 |
| C | C4 | Sonnet | `migrations/2026-10-20-1-backward-cutover.sql`, `migrations/manual/2026-10-20-restore-precutover-snapshot.sql`, `migrations/2026-10-15-2-orders-run-time-bounds-336.sql`, `schema.sql`, `tests/test_backward_cutover.py` | VI15, VI16, D15, D18, VM4 |
| D | D1 runbooks | Sonnet | `docs/DEPLOYMENT.md`, `docs/MIGRATION.md`, `docs/superpowers/plans/2026-10-14-backward-scheduling-final-report.md` | VI18, VI19, D14, D15, D16, VM22, VM29, VU25 |
| D | D2 drift | Haiku | `backend/distribution/CLAUDE.md`, `frontend/scheduling/CLAUDE.md` (+ AGENTS.md twin), `frontend/optimization/CLAUDE.md`, `frontend/calendar/CLAUDE.md`, `backend/scheduling/CLAUDE.md`, `.claude/skills/promote-azure/SKILL.md`, `.agents/skills/promote-azure/SKILL.md` | VM23, VM24, VM26, VM27, VM28 |
| F | F1 gate + trial merge | Sonnet | read-only + logs under `.superpowers/sdd/.../fixwave2/` | — |
| F | F2 whole-branch review (+ fix round by a fresh Sonnet) | Sonnet | any file a finding names | — |
| F | F3 wrap-up docs | Sonnet | `BACKWARD_SCHEDULING_MIGRATION.md` (log append), findings doc §8 addendum, final report addendum, `docs/MIGRATION.md` owed list | — |

Batches run in order 0 → A → B → C → D → F. Tasks inside a batch run in order by one implementer (A and B share `engine.mts`, so no two tasks run at once). Each batch ends with a fresh Sonnet reviewer running the batch gate (below) and reading the batch diff; a failed review goes back to a fresh implementer with the reviewer's findings, at most three rounds.

**Batch gate (reviewer runs, implementer does not):** `npm run build && npm run typecheck && npm run lint && npm run check:static-assets && npm run check:legacy-surface && npm test`, then `.venv/Scripts/python.exe -m pytest tests/ -q -ra` with the env above. Baseline to compare against (tip `69df633`): lint 0 errors / 34 warnings; legacy 73/73; modules 1454 pass / 0 fail / 3 todo; pytest 1797 passed, 2 failed (the two `test_scale_catalog_paging` collation cases), 1 skipped, 13 xfailed. Only those two pytest failures are allowed.

## Review Focus

Five inputs the findings imply but no finding's own reproduction exercises; each has a pin test in the task named.
1. An attribute-only save (firm, PRT, version) of a never-placed row must be accepted by the server once the browser stops sending a status (A1 pin; C1 keeps the server test `test_a_status_only_scheduled_save_on_a_never_placed_row_is_rejected_and_writes_nothing` green, proving the server rule stands).
2. A run-time edit on a running order whose start sits in closed time (D3): the finish must land after the next open window, never `start + run time` across the closed night (A3 pin).
3. A bar that lies entirely inside the second 01:00–02:00 hour on the fall-back day must save (C1 pin on the width validator, both fold readings).
4. Send of a date-only due date on a plant whose line closes at 24:00: the transmitted time must be 23:59:59 of the due date, never 00:00:00 of the next day (C2 pin).
5. Release of a `run_time_over_cap` order whose due date is already past on a never plant: one marked bar, reversed from now, with the `due_date_past` note (A4 pin).

---

## Step 0: Doc of record and run setup (orchestrator, before Batch 0)

- [ ] Copy this plan to `docs/superpowers/plans/2026-10-15-backward-scheduling-fix-wave.md` (Haiku: `cp` + one commit `docs(plan): backward-scheduling validation fix wave plan`).
- [ ] Ask the owner for the local Postgres password once; hold it in session only.
- [ ] Append `Fixwave2 BATCH 0 START (base 69df633 + plan commit)` to progress.md.
- [ ] Create `.superpowers/sdd/2026-10-13-backward-scheduling-implementation/fixwave2/` for briefs, reports, gate logs and review diffs (same layout as `senior-review/`).

---

## Batch 0: locale rows (Haiku)

### Task 0.1: Locale rows for the wave

**Files:**
- Modify: `frontend/locales/en.js:759` (`ui.max_push_forward_help`), plus the matching `ui.max_pull_forward_help` row if one exists in en.js (search only inside en.js); add two new keys; `frontend/locales/{de,es,fr,pt}.js` same keys.

**Interfaces:**
- Produces: i18n keys `toast.running_finish_locked` (used by A3), `ui.opt_pv_split_overlong` in de/es/fr/pt (missing today; en has it at en.js:1923).

- [ ] **Step 1: Edit en.js**

Replace the `ui.max_push_forward_help` value (en.js:759) with:
```js
  'ui.max_push_forward_help':          'Leave blank for no limit. The optimizer treats this as a hard limit: it will not place a dated order to finish more than this many calendar days after its due-date day. When the due date falls on a closed day (for example a Sunday), the count starts from the last open day before it, so a closed gap uses up part of the allowance. Orders that cannot meet the limit are counted in the preview and in a warning after the run. Remove Backlog ignores this limit.',
```
If `ui.max_pull_forward_help` exists, add the same sentence ("When the due date falls on a closed day … part of the allowance.") to it after its first sentence.

Add, next to `toast.finish_cannot_hold` (en.js:46):
```js
  'toast.running_finish_locked':  'Order {{order}} has already started, so its finish cannot be dragged or typed. Change its run time to move the finish.',
```

- [ ] **Step 2: Edit de/es/fr/pt**

Add `toast.running_finish_locked` (translated, same placeholders) next to each file's `toast.finish_cannot_hold`; update each file's `ui.max_push_forward_help` (and pull, if present) with the translated sentence; add `ui.opt_pv_split_overlong` next to each file's `ui.opt_pv_backlog_overlong` (en value: 'Split overlong only'; use the same term the file already uses for "overlong" in `ui.opt_pv_backlog_overlong`).

- [ ] **Step 3: Verify**

Run: `npm run lint` (locales are in its scope) and `npm run test:legacy` (`tests/js/locale-keys.test.js` plus the five-locale guard). Expected: 0 lint errors, legacy tests green.

- [ ] **Step 4: Commit**

```bash
git add frontend/locales
git commit -m "i18n(locales): day-cap help text names the closed-day rule (D8/VM5); running-finish toast; split-overlong label in four locales"
```

**Batch 0 review:** Sonnet reviewer runs `npm run lint` and `npm run test:legacy` (`tests/js/locale-keys.test.js` checks literal keys exist in en.js; the branch's own five-locale guard added in commit d75e552 runs with it), checks every new key is present and non-empty in all five files, appends `Fixwave2 batch 0 review: …`.

---

## Batch A: frontend placement (Sonnet, one implementer, tasks in order)

### Task A1: VC1 — a never-placed row's save carries no planning status

**Files:**
- Modify: `frontend/scheduling/persistence.mts:1093-1123` (`_taskEditSnapshot`)
- Test: `tests/modules/scheduling/persistence.test.mjs`

**Why:** the display-only branch sends `planning_status: 'scheduled'` with no dates; `db.py:1703` rejects that as `single_edge` (stored edges NULL, no segments). Firm/PRT/version edits on every not-yet-placed order vanish after cutover.

- [ ] **Step 1: Write the failing test**

In `persistence.test.mjs`, next to the existing `_taskEditSnapshot` tests (search the file for `_taskEditSnapshot`), add:
```js
test('VC1: a never-placed (display-only) row sends attributes only: no planning status, no dates, no segments', () => {
  const t = { id: 'vc1', user_scheduled: false, planning_status: 'scheduled', planning_reason: null,
    start_date: new Date('2026-09-01T06:00:00'), end_date: new Date('2026-09-01T10:00:00'),
    PRT_01: 'P1', PRT_02: null, PRODUCTION_VERSION: '0001', RUN_TIME: 4, MACHINE: 'L1', scheduleSegments: [] };
  const snap = Persistence._taskEditSnapshot(t);
  assert.equal('planning_status' in snap, false);
  assert.equal('planning_reason' in snap, false);
  assert.equal('start_date' in snap, false);
  assert.equal('end_date' in snap, false);
  assert.equal('schedule_segments' in snap, false);
  assert.equal(snap.PRT_01, 'P1');
  assert.equal(snap.MACHINE, 'L1');
});
test('VC1: a queued row still sends its planning status and reason', () => {
  const t = { id: 'vc1q', user_scheduled: false, planning_status: 'needs_planning',
    planning_reason: { code: 'overlong_never', message: 'x' }, start_date: null, end_date: null, scheduleSegments: [] };
  const snap = Persistence._taskEditSnapshot(t);
  assert.equal(snap.planning_status, 'needs_planning');
  assert.equal(snap.planning_reason.code, 'overlong_never');
});
```
Use the file's existing import of `Persistence` and `assert`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test tests/modules/scheduling/persistence.test.mjs`
Expected: the first new test FAILS on `'planning_status' in snap`.

- [ ] **Step 3: Implement**

In `_taskEditSnapshot`, replace
```ts
      planning_status: t.planning_status ?? 'scheduled',
      planning_reason: t.planning_reason ?? null,
```
with
```ts
      // VC1: a display-only row has no placement to describe; sending a status with no edges is rejected by the
      // server (single_edge). Its save carries attributes only; the stored status is already 'scheduled'.
      ...(displayOnly ? {} : {
        planning_status: t.planning_status ?? 'scheduled',
        planning_reason: t.planning_reason ?? null,
      }),
```
Update the F10 comment above it to add: "and no planning status (VC1)".

- [ ] **Step 4: Run tests**

Run: `npm run build && node --test tests/modules/scheduling/persistence.test.mjs`
Expected: PASS. If an existing test asserts `planning_status` on a display-only snapshot, update that assertion (repair) and say so in the ledger line.

- [ ] **Step 5: Commit**

```bash
git add frontend/scheduling/persistence.mts tests/modules/scheduling/persistence.test.mjs
git commit -m "fix(scheduling): display-only rows save attributes only, no planning status (VC1, D17)"
```

### Task A2: D1 — minute precision for held finishes; manual placement clears the stale flag (VI1, VI5)

**Files:**
- Modify: `frontend/optimization/engine.mts:1415-1502` (`manualSchedulePatchFor`), `frontend/scheduling/orders.mts:1336`, `:1567`, `:2479`, `frontend/scheduling/gantt.mts:4419-4420`
- Test: `tests/modules/optimization/engine.test.mjs:3193-3201` (repair) + two pins

**Interfaces:**
- Produces: every patch returned by `manualSchedulePatchFor` carries `runtime_schedule_mismatch: false`.

- [ ] **Step 1: Repair and pin tests**

Replace the test at engine.test.mjs:3193-3201 with:
```js
test('D1: Engine.manualSchedulePatchFor holds an off-grid finish to the minute (no 15-minute snap)', () => {
  const fx = manualFixture();
  try {
    const task = { id: 'm25-minute', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '2' };
    const patch = Engine.manualSchedulePatchFor(task, fx.line, new Date('2026-08-24T14:07:30'));
    assert.equal(patch.end_date.getTime(), new Date('2026-08-24T14:07:00').getTime());   // floored to the minute
    assert.equal(patch.end_date.getTime() - patch.start_date.getTime(), 2 * Config.MS_HOUR);
    assert.equal(patch.runtime_schedule_mismatch, false);   // VI5: a manual placement is not stale
  } finally { fx.restore(); }
});
test('D1: pushFinishPatches moves the finish by exactly the requested milliseconds', () => {
  const fx = manualFixture();
  try {
    const task = { id: 'm25-push', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '2',
      start_date: new Date('2026-08-24T12:07:00'), end_date: new Date('2026-08-24T14:07:00'), user_scheduled: true };
    const [p] = Engine.pushFinishPatches([task], 3600000);
    assert.equal(p.changes.end_date.getTime(), new Date('2026-08-24T15:07:00').getTime());
  } finally { fx.restore(); }
});
```
(`manualFixture` is the helper the replaced test already used; keep its window open at 14:07–15:07 or widen the fixture hours if it is closed then — read the fixture 20 lines above line 3178.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && node --test tests/modules/optimization/engine.test.mjs`
Expected: both new tests FAIL (end snapped to 14:00 / 15:00; `runtime_schedule_mismatch` undefined).

- [ ] **Step 3: Implement in engine.mts**

In `manualSchedulePatchFor` (engine.mts:1421) replace
```ts
    const finish = Util.snap(requestedFinish);
```
with
```ts
    // D1 (VI1): a held finish keeps its exact minute; only a horizontal Gantt drag snaps, and it does so before
    // reaching this function. Floor to the minute so the server's minute-granular width check sees whole minutes.
    const finish = Calendar._floorMinute(requestedFinish);
```
Then make every successful return carry `runtime_schedule_mismatch: false` (VI5). The cleanest edit: rename the existing body to `_manualSchedulePatchForInner(task, line, requestedFinish, policy, opts)` and add
```ts
  manualSchedulePatchFor(task: NimbusTask, line: string, requestedFinish: Date,
                         policy?: SplitOrderPolicy, opts: ManualPlacementOptions = {}): Partial<NimbusTask> | null {
    const patch = Engine._manualSchedulePatchForInner(task, line, requestedFinish, policy, opts);
    // VI5: a manual placement is the planner's own truth; the stale flag is cleared with it (the server clears
    // it too on a width-checked save; the client copy must not keep the "start may be out of date" alert alive).
    return patch ? { ...patch, runtime_schedule_mismatch: false } : null;
  },
```
Keep the doc comment on the public name. Also update the `heldStartPatchFor` doc comment sentence "`never` snaps it to the 15-minute step" to "`never` may move it to the next open minute" (A3 changes that function anyway).

- [ ] **Step 4: Callers that pre-snap**

- orders.mts:1336 `requestedFinish = Util.snap(d);` → `requestedFinish = d;`
- orders.mts:2479 `requestedFinish = Util.snap(d);` → `requestedFinish = d;`
- orders.mts:1567 `Util.snap(newFinish)` → `newFinish`
- gantt.mts:4419-4420: keep `deltaMs` on the snapped grid; change
  ```ts
        const deltaMs  = newEnd.getTime() - expectedEnd.getTime();
        const requestedFinish = new Date(t.end_date.getTime() + deltaMs);
  ```
  to
  ```ts
        const deltaMs  = newEnd.getTime() - expectedEnd.getTime();
        // D1: a horizontal drag lands the finish on the 15-minute grid; a line-only drag (endMoved false) holds
        // the finish exactly, so an off-grid SAP finish survives a vertical move.
        const requestedFinish = endMoved ? Util.snap(new Date(t.end_date.getTime() + deltaMs)) : new Date(t.end_date.getTime());
  ```
  The multi-drag companions at gantt.mts:4512 and the ghost at 4693 stay as they are (they add the grid delta to each companion's own finish; the engine no longer re-snaps).

- [ ] **Step 5: Build and run**

Run: `npm run build && node --test tests/modules/optimization/engine.test.mjs tests/modules/scheduling/gantt.test.mjs tests/modules/scheduling/orders.test.mjs`
Expected: PASS. Any test that pinned a snapped manual finish is repaired to the exact minute; name each in the ledger line.

- [ ] **Step 6: Commit**

```bash
git add frontend/optimization/engine.mts frontend/scheduling/orders.mts frontend/scheduling/gantt.mts tests/modules/optimization/engine.test.mjs
git commit -m "fix(optimization): held finishes keep the exact minute, manual placement clears the stale flag (VI1 D1, VI5)"
```

### Task A3: D2/D3 — finish edits on a running order are refused; a running order's fallback finish walks forward through working time (VI7, VU1)

**Files:**
- Modify: `engine.mts:129` (`FinishRefusal`/`ManualRefusal` types), `:1285-1295` (`heldStartPatchFor`), `:1428-1431` (running branch of the inner manual function), `orders.mts:1291-1305` (`_explainManualRefusal`), `gantt.mts:4251-4261` (`_rejectManualPlacement`)
- Test: `engine.test.mjs`

**Interfaces:**
- Produces: `ManualRefusal` gains `'running_finish_locked'`; `Engine.lastManualRefusal === 'running_finish_locked'` after a refused running-order finish edit; toast key `toast.running_finish_locked` (Batch 0).

- [ ] **Step 1: Pin tests**

Add to engine.test.mjs near the `manualFixture` tests:
```js
test('D2: a typed End or drag on a RUNNING order is refused with running_finish_locked', () => {
  const fx = manualFixture();
  try {
    const now = fx.now ?? new Date();   // the fixture's plant clock; see how the fixture sets Store.plantNow
    const task = { id: 'm25-run', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '4', user_scheduled: true,
      start_date: new Date(now.getTime() - Config.MS_HOUR), end_date: new Date(now.getTime() + 3 * Config.MS_HOUR) };
    const patch = Engine.manualSchedulePatchFor(task, fx.line, new Date(now.getTime() + 5 * Config.MS_HOUR));
    assert.equal(patch, null);
    assert.equal(Engine.lastManualRefusal, 'running_finish_locked');
  } finally { fx.restore(); }
});
test('D3: a running order whose start sits in closed time finishes after the next open window, not start + run time', () => {
  const fx = manualFixture();   // line hours 06:00-22:00 Mon-Fri in this fixture; adjust the dates below to its week
  try {
    // started 21:00 Tuesday (inside the window) with 3 h to run: 1 h to the 22:00 close, 2 h after 06:00 Wednesday
    const start = new Date('2026-08-25T21:00:00');
    const task = { id: 'm25-held', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '3', user_scheduled: true,
      start_date: start, end_date: new Date(start.getTime() + 3 * Config.MS_HOUR) };
    fx.setNow?.(new Date('2026-08-25T21:30:00'));   // use whatever the fixture offers to set the plant clock
    const patch = Engine.manualSchedulePatchFor(task, fx.line, task.end_date, undefined, { holdStartIfRunning: true });
    assert.equal(patch.start_date.getTime(), start.getTime());
    assert.equal(patch.end_date.getTime(), new Date('2026-08-26T08:00:00').getTime());
  } finally { fx.restore(); }
});
```
If the fixture has no clock setter, set `Store._serverNowOffset`/`Store.setServerNow` the way the nearby `isInProgress` tests do (search the file for `setServerNow`).

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && node --test tests/modules/optimization/engine.test.mjs`
Expected: both FAIL (first: a patch is returned; second: end = start + 3 h = 00:00).

- [ ] **Step 3: Implement**

engine.mts:129:
```ts
export type ManualRefusal = FinishRefusal | 'finish_cannot_hold' | 'needs_overtime_confirm' | 'running_finish_locked';
```
In the inner manual function, replace the running branch (engine.mts:1428-1431):
```ts
    if (opts.holdStartIfRunning && task.start_date && Engine.isInProgress(task)) {
      // OQ3: it is already producing, so its start cannot move; the finish follows from the new run time.
      const held = Engine.heldStartPatchFor(task, line, policy ?? Engine.splitOrderPolicyFor(plant));
      return held ? { ...held, MACHINE: line } : refuse('no_operating_window');
    }
```
with
```ts
    if (task.start_date && Engine.isInProgress(task)) {
      if (!opts.holdStartIfRunning) {
        // D2 (VI7): a started order's bar is not resized or moved by hand; the run-time edit is the only way to
        // change its finish, and it holds the real start (below).
        return refuse('running_finish_locked');
      }
      // OQ3: it is already producing, so its start cannot move; the finish follows from the new run time.
      const held = Engine.heldStartPatchFor(task, line, policy ?? Engine.splitOrderPolicyFor(plant));
      return held ? { ...held, MACHINE: line } : refuse('no_operating_window');
    }
```
Replace `heldStartPatchFor` (engine.mts:1289-1295) with:
```ts
  heldStartPatchFor(task: NimbusTask, line: string, policy: SplitOrderPolicy): Partial<NimbusTask> | null {
    if (!task.start_date) return null;
    const held = Engine.schedulePatchFor(task, line, task.start_date, policy);
    if (!held?.start_date || !held.end_date) return null;
    if (held.start_date.getTime() === task.start_date.getTime()) return held;
    // D3 (VU1): the allocator could not keep the real start (closed time, or a `never` window too short), so the
    // remaining run is walked forward through working time from that start and the bar is one continuous piece
    // from the held start to the calendar-aware finish. The old start + run time as plain elapsed time is gone.
    const plant = task.PLANT || Store.getPlantForLine(line) || Store.selectedPlant;
    const plantTz = Store.masterData?.plants?.find(row => row.plant === plant)?.timezone?.trim() || null;
    const runtimeMinutes = Math.round(Util.runHours(task) * 60);
    const forward = Calendar.allocateRuntime(line, task.start_date, runtimeMinutes, 'partial_allowed', plantTz);
    if (forward.kind !== 'allocated') return null;
    return { start_date: task.start_date, end_date: forward.end, scheduleSegments: [] };
  },
```
Update its doc comment (engine.mts:1285-1288) to describe the forward walk. Note for the implementer: `Calendar.allocateRuntime(line, from, minutes, policy, plantTz)` returns `{ kind: 'allocated', start, end, scheduleSegments }` or `{ kind: 'exhausted' }` (calendar-engine.mts:811-826); `partial_allowed` is used deliberately so the remaining minutes are summed across windows; the segments are dropped because the piece boundaries are not planner placements and the start is held (log this as a gap decision).

orders.mts `_explainManualRefusal` (1291-1305): before the `if (reason !== 'finish_cannot_hold')` line add
```ts
    if (reason === 'running_finish_locked') {
      Toast.show(Util.t('toast.running_finish_locked', { order: Util.orderNumber(task) }), 'warn', 6000);
      return;
    }
```
gantt.mts `_rejectManualPlacement` (4251-4261): read it; where it decides which toast to show, add the same branch for `Engine.lastManualRefusal === 'running_finish_locked'` (same toast, then spring back as it does today). If it delegates to `Table._explainManualRefusal`, nothing more is needed.

- [ ] **Step 4: Build and run**

Run: `npm run build && node --test tests/modules/optimization/engine.test.mjs tests/modules/scheduling/orders.test.mjs tests/modules/scheduling/gantt.test.mjs`
Expected: PASS. Tests that relied on the old running fallback (`start + run time`) are repaired to the forward-walk result; name them.

- [ ] **Step 5: Commit**

```bash
git add frontend/optimization/engine.mts frontend/scheduling/orders.mts frontend/scheduling/gantt.mts tests/modules/optimization/engine.test.mjs
git commit -m "fix(optimization): running orders refuse finish edits; held-start fallback walks forward through working time (VI7 D2, VU1 D3)"
```

### Task A4: D5 — over-cap release on a never plant places as one marked bar (VI6)

**Files:**
- Modify: `engine.mts:1456-1476` (inner manual function, refusal branch)
- Test: `engine.test.mjs`

- [ ] **Step 1: Pin tests**
```js
test('D5: a queued run_time_over_cap row on a never plant releases as one marked bar', () => {
  const fx = manualFixture({ splitPolicy: 'never' });   // or set the plant policy the way nearby overlong_never tests do
  try {
    const task = { id: 'm25-cap', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '400', planning_status: 'needs_planning',
      planning_reason: { code: 'run_time_over_cap', message: 'x' } };
    const finish = new Date('2026-09-30T14:00:00');
    const patch = Engine.manualSchedulePatchFor(task, fx.line, finish);
    assert.equal(patch.placement_exception, 'overlong');
    assert.equal(patch.planning_status, 'scheduled');
    assert.equal(patch.end_date.getTime(), finish.getTime());
    assert.equal(patch.end_date.getTime() - patch.start_date.getTime(), 400 * Config.MS_HOUR);
  } finally { fx.restore(); }
});
test('Review focus 5: the same release with a past due date reverses from now and keeps the marker', () => {
  const fx = manualFixture({ splitPolicy: 'never' });
  try {
    const task = { id: 'm25-cap-past', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '400', planning_status: 'needs_planning',
      planning_reason: { code: 'run_time_over_cap', message: 'x' } };
    const patch = Engine.manualSchedulePatchFor(task, fx.line, new Date('2020-01-01T14:00:00'));
    assert.equal(patch.placement_exception, 'overlong');
    assert.equal(patch.derivationIssue?.code, 'reversal_forward');
    assert.equal(patch.derivationIssue?.detail, 'due_date_past');
  } finally { fx.restore(); }
});
```
Search the file for `overlong_never` to copy how existing tests put the plant on the `never` policy.

- [ ] **Step 2: Run to verify failure** — `npm run build && node --test tests/modules/optimization/engine.test.mjs`; expected: both FAIL (patch null).

- [ ] **Step 3: Implement**

engine.mts:1458, replace
```ts
      if (result.reason === 'overlong_never' && queuedCode === 'overlong_never') {
```
with
```ts
      // D5 (VI6): an approved release of an over-cap order on a never plant has the same shape as an overlong
      // release: one continuous marked bar. OQ28 says a planner may approve and release it.
      if (result.reason === 'overlong_never' && (queuedCode === 'overlong_never' || queuedCode === 'run_time_over_cap')) {
```
Update the doc comment at 1410-1412 to say both queue codes release as a marked bar when the walk refuses them as overlong.

- [ ] **Step 4: Run** — same command; expected PASS.
- [ ] **Step 5: Commit** — `fix(optimization): run_time_over_cap releases as one marked bar on never plants (VI6 D5)`

### Task A5: D14 — the reconcile derives on the default calendar when a line has no server row (VI14 client half)

**Files:**
- Modify: `engine.mts:1702-1707` (per-line guard), `engine.mts:3080-3081`
- Test: `engine.test.mjs`

- [ ] **Step 1: Repair and pin**

Search engine.test.mjs for `line_no_calendar`. Each test that expects a `line_no_calendar` note for a line with no server calendar row is rewritten to expect a derived placement on the client default hours (07:00–19:00 Mon–Fri) and no note. Add one pin:
```js
test('D14: a line with no server calendar row derives on the default calendar instead of being blocked', () => {
  // use the same fixture the former line_no_calendar test used, minus the server line row
  // assert: after reconcileRuntimeSchedules(plant), the task has start_date and end_date and derivationIssue is null
});
```
(Write the body from the test you repaired; it is the same setup with the expectation inverted.)

- [ ] **Step 2: Run** — expect the repaired tests to FAIL before the change.

- [ ] **Step 3: Implement**

engine.mts:1702-1707: delete the two lines
```ts
        // OQ62: a line on the client default hours has no server calendar to derive from.
        ...
        if (!CalendarSync.hasServerLineCalendar(plant, line)) { noteOnly(task, { code: 'line_no_calendar' }); tally(stale, 'blocked'); continue; }
```
and keep `const stale = !!task.runtime_schedule_mismatch;`. Add the comment: `// D14: every line has a calendar (its own row or the plant default), so nothing is blocked here any more.`
engine.mts:3080-3081: read the predicate; remove the `|| CalendarSync.hasServerLineCalendar(plant, task.MACHINE)` term so only `calendarState(plant) !== 'hydrated'` remains. If `CalendarSync` becomes unused in engine.mts, remove the import.
Keep `noteOnly`, the `'blocked'` tally and the `line_no_calendar` type (B3 retires the alert).

- [ ] **Step 4: Run** — `npm run build && npm run typecheck && node --test tests/modules/optimization/engine.test.mjs`; PASS.
- [ ] **Step 5: Commit** — `fix(optimization): reconcile derives on the default calendar for lines without a server row (VI14 D14)`

### Task A6: VI8, VI9, D21 — Time Machine restore is not a placement; the cached-edit overlay restores attributes and the run-time-grew note

**Files:**
- Modify: `frontend/platform/store.mts:413-417` (`_markPlaced`), `persistence.mts:844-876` (`_overlayUserMoves`), `persistence.mts:1642-1644` (cache strip)
- Test: `tests/modules/platform/store.test.mjs`, `tests/modules/scheduling/persistence.test.mjs`

- [ ] **Step 1: Pin tests**

store.test.mjs:
```js
test('VI8: a time-machine write never marks a row as placed', () => {
  // seed one task with user_scheduled false; Store.updateMany([{ id, changes: { start_date, end_date } }], 'time-machine')
  // assert task.user_scheduled === false
});
```
persistence.test.mjs (next to the existing overlay tests, search `_overlayUserMoves`):
```js
test('VI9: the cached-edit overlay restores the run time, machine, PRTs and version with the dates', () => {
  // backend row RUN_TIME 4 / MACHINE 'L1'; cached row with a moved start/end, RUN_TIME 6, MACHINE 'L2', PRT_01 'P9', PRODUCTION_VERSION '0002', same row_version
  // assert after overlay: t.RUN_TIME === 6, t.MACHINE === 'L2', t.PRT_01 === 'P9', t.PRODUCTION_VERSION === '0002'
});
test('D21: the overlay revives a cached run-time-grew note', () => {
  // cached row additionally carries derivationIssue: { code: 'reversal_forward', detail: 'run_time_grew', from: '2026-09-01T10:00:00', to: '2026-09-01T12:00:00' }
  // assert t.derivationIssue.code === 'reversal_forward' and t.derivationIssue.from instanceof Date
});
```
Fill each body from the neighbouring overlay test's setup (same helpers, same shape).

- [ ] **Step 2: Run** — expect all three to FAIL.

- [ ] **Step 3: Implement**

store.mts:415-416:
```ts
    if (source === 'refresh' || source === 'engine-runtime-reconcile-display' || source === 'undo'
      || source === 'sandbox' || source === 'distribution' || source === 'note' || source === 'time-machine') return;
```
with a comment: `// VI8: a Time Machine restore replays display-derived dates; reconcileRestored decides what is a placement.`

persistence.mts `_overlayUserMoves`, after `t.placement_exception = ...;` add:
```ts
      // VI9: the unsaved edit that moved the dates may also have changed the run time, machine, tooling or
      // version; a bar restored on the old run time fails the server width check and the edit is lost.
      for (const key of ['RUN_TIME', 'MACHINE', 'PRT_01', 'PRT_02', 'PRODUCTION_VERSION', 'run_time_source'] as const) {
        if (key in cached) (t as Record<string, unknown>)[key] = cached[key];
      }
      // D21 (VM8): the "run time grew" note survives a reload until the row is saved or re-placed.
      const issue = cached.derivationIssue as { code?: string; detail?: string; from?: unknown; to?: unknown } | null | undefined;
      if (issue?.code) {
        t.derivationIssue = { code: issue.code, ...(issue.detail ? { detail: issue.detail } : {}),
          ...(issue.from ? { from: Util.parseDate(issue.from as string) ?? undefined } : {}),
          ...(issue.to ? { to: Util.parseDate(issue.to as string) ?? undefined } : {}) };
      }
```
persistence.mts:1644: stop stripping `derivationIssue` (keep stripping `systemMove` and `firmed`):
```ts
        tasks:          Store.tasksArr.map(({ firmed: _firmed, systemMove: _move, ...rest }) => rest as Record<string, unknown>),
```
and rewrite the comment above it: the `reversal_forward/run_time_grew` note is cached so Remove Backlog's count survives a reload (D21); it is revived only through the overlay (an unsaved placement edit) and cleared by the next schedule edit or refresh as before.

- [ ] **Step 4: Run** — `npm run build && node --test tests/modules/platform/store.test.mjs tests/modules/scheduling/persistence.test.mjs`; PASS (repair any test asserting the cache has no `derivationIssue`).
- [ ] **Step 5: Commit** — `fix(platform,scheduling): time-machine writes are not placements; overlay restores attributes and the run-time-grew note (VI8, VI9, VM8 D21)`

### Task A7: D19 and D9c — firmed frozen-window warning only on a real crossing; holiday date-only due resolves silently (VU17, VP1)

**Files:**
- Modify: `engine.mts:1761-1775` (issue selection in the reconcile)
- Test: `engine.test.mjs`

- [ ] **Step 1: Pin tests**
```js
test('D19: a firmed row already inside the frozen window gets no frozen_window_crossed note', () => {
  // firmed task, never placed (start_date null), due inside the frozen window; after reconcile: derivationIssue is null (or not frozen_window_crossed)
});
test('D19: a firmed row whose derived start moves from outside to inside the window is warned with from/to', () => {
  // firmed, placed row with start outside the window; a longer run time pulls the derived start inside; expect code frozen_window_crossed with from and to
});
test('D9c: a never-placed order with a date-only due on a full-day blackout resolves silently to the previous working close', () => {
  // date-only due (exact midnight) on a day fully covered by a blackout block for the line; after reconcile:
  // end_date is before the blackout and derivationIssue is null (no finish_moved_earlier)
});
```
Build the setups from the nearest existing `frozen_window_crossed` and `finish_moved_earlier` tests (search the file).

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement**

engine.mts:1764-1775, replace the `if (result.finishMoved) ... else if (orphaned) ... else if (Store.isFirmed...) {...} else if (placed && !Store.isFirmed ...) {...}` chain head with:
```ts
        // D9c (VP1): a date-only due that lands on a blackout day is read as that day's close and the walk
        // moves it before the blackout; that is the due date resolving, not a finish the planner lost. Silent.
        const dueOnBlackout = !placed && result.moveReason === 'blackout' && Util.isDateOnlyDue(task);
        if (result.finishMoved && !dueOnBlackout) issue = { code: 'finish_moved_earlier', from: anchor, to: result.changes.end_date! };
        else if (orphaned) issue = { code: 'setup_override_orphaned' };
        else if (task.start_date
          && !Engine.isFrozenHorizon(task, plantNow) && Engine.isFrozenHorizon({ ...task, start_date: derivedStart, user_scheduled: true }, plantNow)) {
          // D19 (VU17) + R26: a row (firmed or not) whose start moves from OUTSIDE to INSIDE the frozen window in
          // this reconcile is warned; one already inside, or never placed, is silent (no cutover-morning flood).
          issue = { code: 'frozen_window_crossed', from: task.start_date, to: derivedStart };
        } else {
```
and delete the old firmed branch and the old `placed && !Store.isFirmed(task.id)` branch (the new single branch covers both; the `placed` qualifier is dropped because `task.start_date` being set on a non-placed row only happens for display-derived rows, whose start is also a real "from" the planner saw). `Util.isDateOnlyDue(task)`: if no such helper exists in foundation.mts, add one next to `Util.sapDueDate`:
```ts
  /** True when the SAP finish on the wire is an exact-midnight value, i.e. a date-only due date (OQ23). */
  isDateOnlyDue(task: Pick<NimbusTask, 'original_end_date'>): boolean {
    const raw = task.original_end_date;
    return raw instanceof Date && raw.getHours() === 0 && raw.getMinutes() === 0 && raw.getSeconds() === 0 && raw.getMilliseconds() === 0;
  },
```
(`foundation.mts` is then also in this task's file set; add it to the commit.)

- [ ] **Step 4: Run** — `npm run build && npm run typecheck && node --test tests/modules/optimization/engine.test.mjs`; PASS (repair tests that expected the firmed-inside warning).
- [ ] **Step 5: Commit** — `fix(optimization): frozen-window warning only on a real crossing; holiday date-only due resolves silently (VU17 D19, VP1 D9c)`

**Batch A review:** fresh Sonnet runs the batch gate, reads `git diff 69df633..HEAD -- frontend/optimization/engine.mts frontend/scheduling frontend/platform/store.mts`, checks each task against its finding line in the findings doc §3 and its decision in §7a, and appends `Fixwave2 batch A review: …`. Blocking: any decision implemented differently from §7a, any gate regression, any test deleted rather than repaired.

---

## Batch B: calendar, optimizer, alerts (Sonnet)

### Task B1: D17 — plant-zone forward paths (VI3, VM17) and the look-back retry (VI17)

**Files:**
- Modify: `frontend/calendar/calendar-engine.mts:148-150`, `:494-507` (`hasNominalWindow`), `:709-786` (`_backwardFrame`), `:952-1024` (`allocateRuntimeBackward`), `:811-826` (`allocateRuntime` non-tz path); `engine.mts:1269-1279` (`schedulePatchFor`), `:2007-2011` (`removeBacklog` → `placeForwardSequence`), `autoReflow` call sites that call `allocateRuntime` without a zone (grep `allocateRuntime(` inside engine.mts only)
- Test: the calendar-engine test file under `tests/modules/calendar/` (run `ls tests/modules/calendar` to get its name), `engine.test.mjs`

**Interfaces:**
- Produces: `Calendar.hasNominalWindow(line, from, durationMs, plantTz?: string | null)`; `BackwardResult` gains `{ kind: 'lookback_exhausted' }` (treated by the engine as `no_operating_window`); `Engine.schedulePatchFor` resolves and passes the plant zone.

- [ ] **Step 1: Pin tests**

Calendar test file:
```js
test('VI17: a 100-day shutdown before a far due date places the order before the shutdown, finish moved, not reached_now', () => {
  // line open 06:00-22:00 Mon-Fri; blackout block (or null work hours) covering due-100d .. due-1d; run 8 h; floor = now (long before)
  // r = Calendar.allocateRuntimeBackward(line, due, 480, 'never', { floor, minSegmentMinutes: 60, plantTz: null })
  // assert r.kind === 'placed' && r.finishMoved === true && r.end < shutdownStart
});
test('VI17: with no open time inside 400 days the walk reports lookback_exhausted, never reached_now', () => {
  // same, blackout covering due-400d .. due; assert r.kind === 'lookback_exhausted'
});
test('VM17: hasNominalWindow judges a plant-zone day across the spring-forward gap by real elapsed time', () => {
  // plantTz 'America/Chicago'; line 00:00-08:00 (24:00 close not needed); from = 2026-03-08 (US spring-forward); durationMs = 8 h
  // assert hasNominalWindow(line, from, 8*MS_HOUR, 'America/Chicago') === false (the window is 7 real hours that day)
  // and === true on 2026-03-09
});
```
engine.test.mjs:
```js
test('VI3: schedulePatchFor measures the run in the plant zone (8 h across the spring-forward gap ends 09:00 wall, not 08:00)', () => {
  // plant 'America/Chicago' timezone in masterData; 24/7 line; requested start 2026-03-08T00:00; RUN_TIME 8
  // assert patch.end_date wall time === 2026-03-08T09:00 (the walk ran on instants)
});
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement the look-back retry (calendar-engine.mts)**

`BackwardResult` (line 95-98): add `| { kind: 'lookback_exhausted' }` with the doc note "no open time inside BACKWARD_MAX_DAYS before the finish; the caller must not reverse from now".
`BackwardFrame` ok variant: add `boundedByLookback: boolean`. In `_backwardFrame` (line 770):
```ts
    const bound = opts.floor && opts.floor.getTime() > lookbackStart.getTime() ? opts.floor : lookbackStart;
    const boundedByLookback = bound === lookbackStart;
```
and return it in the ok object. In `allocateRuntimeBackward`, wrap the existing body as `const attempt = (frameOpts: BackwardLookupOptions & BackwardAllocationOptions): BackwardResult | 'retry' => { ... }` where every `return { kind: 'reached_now' }` becomes `return frame.boundedByLookback ? 'retry' : { kind: 'reached_now' }`. Then:
```ts
    const first = attempt(opts);
    if (first !== 'retry') return first;
    // VI17: the 90-day look-back, not the plant's now, stopped the walk (a long shutdown before a far due date).
    // Look back the full BACKWARD_MAX_DAYS once; if that still finds nothing the order has no legal finish in
    // range and the caller reports it rather than reversing from now (OQ13/OQ55).
    const second = attempt({ ...opts, lookbackDays: BACKWARD_MAX_DAYS });
    return second === 'retry' ? { kind: 'lookback_exhausted' } : second;
```
engine.mts `finishAnchoredPatchFor` (1350-1352): add `if (result.kind === 'lookback_exhausted') return { kind: 'refuse', reason: 'no_operating_window' };` before the `unavailable` line. The reconcile then notes `no_operating_window` for such a row and the planner sees the existing alert; the moved-earlier case gets the existing `finish_moved_earlier` with from/to (that is the distance alert).

- [ ] **Step 4: Implement plant-zone forward paths**

`hasNominalWindow(line, from, durationMs, plantTz: string | null = null)` (494-507): when `plantTz` is given, convert each window's edges with `core.plantInstantFromWallClock(plantTz, win[0])` / `win[1]` before yielding `{ s, e }` (same `toMs` idiom as `_allocateForwardInPlantZone`, lines 879-883). Update its callers at 565, 822, 906 and 1037 to pass the zone they have in scope (`plantTz` where the enclosing function has one; 822 is the non-tz `allocateRuntime` path and stays null).
engine.mts `schedulePatchFor` (1269-1279): resolve `const plantTz = Store.masterData?.plants?.find(row => row.plant === plant)?.timezone?.trim() || null;` (same idiom as line 1338) and pass it as the fifth argument of `Calendar.allocateRuntime(...)`; for the `never` branch that computes `end_date: new Date(start.getTime() + runtimeMinutes * Config.MS_MIN)` (1277), replace the elapsed add with the allocator's `end` when a zone is present (call `Calendar.allocateRuntime(line, start, runtimeMinutes, 'never', plantTz)` and use its `end`).
engine.mts `removeBacklog` (2007-2011): add `plantTz` to the `placeForwardSequence` options the way the reconcile does at 1785 (`{ plantTz }`), resolving it from the plant in scope.
`autoReflow`: grep `allocateRuntime(` and `schedulePatchFor(` inside engine.mts; any call that lacks the zone gets it the same way.

- [ ] **Step 5: Run** — `npm run build && npm run typecheck && node --test tests/modules/calendar/*.test.mjs tests/modules/optimization/engine.test.mjs`; PASS. Then `node --test tests/modules/optimization/scheduler-plant-scale.test.mjs` to confirm no timing blow-up (the retry runs only on the rare lookback case).
- [ ] **Step 6: Gap log** — append to the spec log and ledger: optimizer evaluators (setup-scheduler) keep viewer-zone elapsed time (Context cut 1).
- [ ] **Step 7: Commit** — `fix(calendar,optimization): forward paths run on plant-zone instants; look-back retries to 400 days before giving up (VI3, VM17, VI17 D17)`

### Task B2: VI10, D6, VM6, VM7 — gap-fill keeps the overlong reason; setup never splits a fitting order; overload Fix refuses an unzoned plant; marked bars are obstacles

**Files:**
- Modify: `setup-scheduler.mts:997-1017` (`noFitReason`), `:7179-7196` (`fillPlanningGaps` tail); `calendar-engine.mts:984-987`; `services.mts:471-491`; `engine.mts:2043-2056`
- Test: `tests/modules/setup-scheduler.test.mjs` (the file CLAUDE.md names; if it lives under `tests/modules/optimization/`, use that path), calendar test file

- [ ] **Step 1: Pin tests**
```js
// setup-scheduler test
test('VI10: fillPlanningGaps with a zero budget keeps overlong_never for an overlong order on a never plant', () => {
  // snapshot with a never plant, a line 06:00-22:00, one pending order RUN_TIME 20; budgetMs 0
  // assert the disposition reason code === 'overlong_never' (not 'search_limit')
});
// calendar test
test('D6: under partial_allowed a run that fits one window is not clipped to make room for the changeover', () => {
  // line 06:00-22:00; run 930 min (15.5 h); setupMinutes 60; finish 22:00
  // r = Calendar.allocateRuntimeBackward(line, finish, 930, 'partial_allowed', { floor, minSegmentMinutes: 60, plantTz: null, setupMinutes: 60 })
  // assert r.scheduleSegments.length === 0 && r.start === 06:30 same day
});
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement**

setup-scheduler.mts:7189-7190: compute the overlong reason independent of `complete`:
```ts
    const overlong = prior?.code !== 'setup_transition_unrecorded' ? neverOverlongReason(snapshot, bounds, task) : null;
    const reason = complete && prior?.code === 'setup_transition_unrecorded'
      ? prior
      : overlong ?? (complete
      ? { code: 'no_fit_found', ... }
      : { code: 'search_limit', ... });
```
(keep the two message strings as they are). Add the comment: `// VI10: overlong is a calendar fact, not a search result; a budget expiry must not relabel it.`
`noFitReason` (997-1017): read it; where `limitReached` yields `search_limit`, test `neverOverlongReason` first and return it when non-null.
calendar-engine.mts:984-987: change the clip condition to
```ts
        // D6 (VM9): the changeover is reserved by clipping the EARLIEST piece only when the order is already split;
        // an order that fits this one fragment stays whole and the setup is simply not reserved (setup alert).
        if (setupMs && picked.length > 0 && take === remaining && take * Config.MS_MIN + setupMs > capacity * Config.MS_MIN) {
```
services.mts overload branch (471): after `const line = a.line`, add
```ts
      const plant = Store.getPlantForLine(line) || Store.selectedPlant;
      if (!plant || !Store.plantNow(plant)) {   // VM6 (OQ52): no clock, no placement; same refusal as the Optimize dialog
        Toast.show(Util.t('toast.optimize_plant_no_timezone', { plant: plant ?? '' }), 'error', 9000);
        return;
      }
```
(`Store`, `Toast`, `Util` are already imported in services.mts; confirm by reading its import block.)
engine.mts:2049: `if (protectedTask.start_date <= to || patchById.has(protectedTask.id)) continue;` → `if ((protectedTask.start_date <= to && !protectedTask.placement_exception) || patchById.has(protectedTask.id)) continue;` with the comment `// VM7: a marked bar inside the window is an obstacle too`.

- [ ] **Step 4: Run** — `npm run build && npm run typecheck && node --test tests/modules/setup-scheduler.test.mjs tests/modules/calendar/*.test.mjs tests/modules/optimization/engine.test.mjs tests/modules/insights/*.test.mjs`; PASS.
- [ ] **Step 5: Commit** — `fix(optimization,calendar,insights): gap-fill keeps overlong_never; setup never splits a fitting order; overload Fix refuses an unzoned plant; marked bars are obstacles (VI10, VM9 D6, VM6, VM7)`

### Task B3: D9b, D20, VM12, VM13, D14 alert half — alert severities, categories and finish-only rows

**Files:**
- Modify: `frontend/nimbus-compute-core.js:567-571`, `:977-1007`, `:1016`, `:1056-1061`, `:1064-1093`, `:1265-1285` (`computeUtilization` row skip); `frontend/insights/insights-ui.mts:1255-1264`, `:1287-1304`
- Test: the compute-core / alerts test files (run `ls tests/js tests/modules/insights` and pick the ones that assert `placement_exception`, `reversal_forward`, `CAT_MAP`/`showForCell`, `computeUtilization`)

- [ ] **Step 1: Pin tests**
```js
test('D20: an approved placement exception is a warning, not an error', ...);           // sev === 'warn'
test('D9b: reversal_forward is a warning unless the reversed finish is beyond the plant push cap', ...); // two tasks: one within cap (warn), one beyond (err)
test('VM13: line_no_calendar is no longer emitted and new alert types file under their categories', ...); // showForCell: late -> exceptions, finish_moved_earlier -> calendar
test('VM12: a finish-only row contributes its hours to computeUtilization', ...);          // end_date only + RUN_TIME 4 -> 240 min on that day
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement**

- core:1000 `sev: 'err'` → `sev: 'warn'` with comment `// D20 (VM14): approved by the planner; visible, not blocking`.
- core:1016 remove `'reversal_forward'` from `ISSUE_SEV_ERR`; in the `reversal_forward` case (1071-1082) set `sev` to `'err'` when the task's end is beyond the push cap, reusing the same `beyondCap` computation the late alert makes at 977-979 (extract it into a small `beyondPushCap(t)` closure above line 977 and call it from both places).
- core:1056-1061 (`line_no_calendar` emission): delete the emission (D14; the type stays in the unions). Also `dayWindowForLine(line, true)` call sites that pass `requireRow = true` for the due-date read: change to `false` so a date-only due on a line without its own row resolves on the default window (search the core for `, true)` near 567-571 and 971).
- core `computeUtilization` (~1272): a row with no `start_date` but an `end_date` and a run time contributes `[end - run_time, end]` (the same rule `workingMinutesByDay` already applies at 414-417); read the function and apply the same derivation to the row it currently skips.
- insights-ui.mts:1262 `const sortAt = onDay[0]?.start ?? task.start_date;` → `?? task.start_date ?? (task.end_date ? new Date(task.end_date.getTime() - Util.runHours(task) * Config.MS_HOUR) : null)`.
- insights-ui.mts `CAT_MAP` add:
```ts
      late: 'exceptions', reversal_forward: 'exceptions', placement_exception: 'exceptions',
      frozen_window_crossed: 'exceptions', pull_floor_crossed: 'exceptions', setup_override_orphaned: 'exceptions',
      no_anchor: 'exceptions', derivation_issue: 'exceptions',
      finish_moved_earlier: 'calendar', plant_no_timezone: 'calendar', line_no_calendar: 'calendar',
      run_time_zero: 'exceptions', no_operating_window: 'calendar',
```

- [ ] **Step 4: Run** — `npm run build && npm run typecheck && node --test tests/modules/insights/*.test.mjs && npm run test:legacy`; PASS (repair tests that pinned `err` for these two types or expected `line_no_calendar`).
- [ ] **Step 5: Commit** — `fix(insights): approved exceptions and in-cap reversals are warnings; new alert types categorised; finish-only rows counted; line_no_calendar retired (VM14 D20, D9b, VM13, VM12, D14)`

**Batch B review:** as Batch A, over `frontend/calendar`, `frontend/optimization/setup-scheduler.mts`, `frontend/insights`, `frontend/nimbus-compute-core.js`, `engine.mts`.

---

## Batch C: backend (Sonnet)

### Task C1: VI2 server, D12, D13 — fold-tolerant width check; marker change counts as a move; run-time-only saves flag the row; single-task route reports reasons; docstrings (VM2, VM3, VM16)

**Files:**
- Modify: `db.py:1140-1164`, `:1695`, `:1719-1724`, `:1741-1783` and the UPDATE SQL that consumes `clear_runtime_mismatch` (read from 1783 down to the `UPDATE orders` statement); `backend/scheduling/routes.py:446-465`, `:495-506`, `:554-571`; `backend/scheduling/models.py:135-144`
- Test: `tests/test_task_concurrency.py` (`TestSaveContractWidthValidator` at 792; `test_mixed_batch_leaves_seeded_unset_columns_untouched` at 214)

- [ ] **Step 1: Pin tests (pg-marked, inside the existing classes, using their `_order`/`_save`/`_state` helpers)**
```python
def test_a_bar_inside_the_repeated_fall_back_hour_saves_under_either_reading(self, pg):
    # America/Chicago plant; order run_time 1; start 2026-11-01 01:15, end 2026-11-01 02:15 (second reading: 1 h; first reading: 2 h)
    # assert persisted == 1 and no rejection_reasons
def test_a_zero_wall_width_bar_across_the_fall_back_hour_is_a_real_hour(self, pg):
    # start 2026-11-01 01:30 (first), end 2026-11-01 01:30 (second) run_time 1 -> persisted, not "end <= start"
def test_clearing_the_exception_marker_on_an_unmoved_off_width_bar_is_judged(self, pg):
    # stored bar 20 h with placement_exception 'overtime', run_time 4; save same edges with placement_exception None -> rejection width_mismatch
def test_a_run_time_only_save_on_a_placed_continuous_row_flags_it_stale(self, pg):
    # stored 4 h bar, mismatch False; save {"id": oid, "RUN_TIME": 6} -> persisted 1 and runtime_schedule_mismatch TRUE, edges unchanged
```
Also extend `test_mixed_batch_leaves_seeded_unset_columns_untouched` (line 214): after `assert snap(oids[2]) == (...)`, select `runtime_schedule_mismatch` for `oids[2]` and assert it is `True` (D13).

- [ ] **Step 2: Run** — `.venv/Scripts/python.exe -m pytest tests/test_task_concurrency.py -q -k "fall_back or marker or run_time_only or mixed_batch"` with the env; expect the new ones FAIL.

- [ ] **Step 3: Implement**

db.py, replace `_elapsed_seconds` with:
```python
def _elapsed_seconds_readings(start: datetime, end: datetime, plant_tz: str | None) -> list[float]:
    """Every real duration two NAIVE plant-local edges can mean. With a zone, each edge is read as the instant
    it names there; inside the repeated fall-back hour a naive wall time names two instants (fold 0 and 1), so
    the readings are returned for every fold pair and the caller accepts a bar that fits under any of them
    (VI2). Outside that hour all readings are equal. No zone: the plain wall-clock difference."""
    zone = None
    if plant_tz:
        try:
            zone = ZoneInfo(plant_tz)
        except (ZoneInfoNotFoundError, ValueError):
            zone = None
    if zone is None:
        return [(end - start).total_seconds()]
    out: list[float] = []
    for fs in (0, 1):
        for fe in (0, 1):
            s = start.replace(tzinfo=zone, fold=fs).astimezone(timezone.utc)
            e = end.replace(tzinfo=zone, fold=fe).astimezone(timezone.utc)
            out.append((e - s).total_seconds())
    return sorted(set(out))


```
Then grep `_elapsed_seconds(` inside db.py only: if `_validate_continuous_width` is its only caller, delete the old `_elapsed_seconds`; otherwise leave it exactly as it is and add the new function beside it. In `_validate_continuous_width`:
```python
    target = float(run_time) * 3600.0
    return any(abs(v - target) <= WIDTH_TOLERANCE_SECONDS for v in _elapsed_seconds_readings(start, end, plant_tz))
```
db.py:1695 `if new_start is not None and new_end is not None and new_end <= new_start:` → `if new_start is not None and new_end is not None and max(_elapsed_seconds_readings(new_start, new_end, current["timezone"])) <= 0:` with the comment `# a bar whose wall edges coincide can still be the real repeated hour (VI2)`.
db.py:1719-1724 (`unmoved`): add `and not marker_changed` where, just above, `marker_changed = has_exception and exception_value != current["placement_exception"]` with the comment `# D12 (VM15): changing or clearing the marker is a move; the width gate must see it`.
db.py update_rows (1741-1783): add `"stale_runtime": (runtime_changed and not queued and start is None and end is None and not segment_rows and current["stored_start"] is not None and current["stored_end"] is not None)` and consume it in the UPDATE SQL next to `clear_runtime_mismatch`: the flag becomes `CASE WHEN force_mismatch OR stale_runtime THEN TRUE WHEN clear THEN FALSE ELSE runtime_schedule_mismatch END` (adapt to the statement's existing parameter style). Comment: `# D13 (VM2): a run time changed with no edges leaves the stored bar wrong; flag it so the browser re-derives`.
routes.py `/task/update` (446-465): add `rejection_reasons: dict[str, str] = Field(default_factory=dict)` and `start_derived: dict[str, bool] = Field(default_factory=dict)` to `TaskUpdateResult` (models.py:135-144); return them on the 200 path; on `invalid` raise `HTTPException(400, detail={"error": "invalid", "rejection_reasons": res.get("rejection_reasons", {})})` and fix the docstring's `Response:` line. Docstrings at 495-506 and 554-571: replace `start_date?, end_date?` with `start_date and end_date (both, or neither; a single edge is rejected as single_edge)`.

- [ ] **Step 4: Run** — `.venv/Scripts/python.exe -m pytest tests/test_task_concurrency.py tests/test_scheduling_routes.py -q` (second file only if it exists; `ls tests | grep -i rout`); PASS; the server test named in Review Focus 1 stays green.
- [ ] **Step 5: Commit** — `fix(scheduling): width check accepts either reading of the repeated hour; marker change is a move; run-time-only saves flag the row; single-task route reports reasons (VI2, VM15 D12, VM2/VM3/VM16 D13)`

### Task C2: D10 and VI13 — persisted date-only flag, Send transmits the working-window close; Send and ingest refuse a plant without a time zone (VI12, VI13)

**Files:**
- Create: `migrations/2026-10-16-2-orders-original-finish-date-only.sql`
- Modify: `schema.sql` (orders ADD COLUMN block near line 253-254 and the mirrored backfill), `db.py:3467-3511` (`_locked_originals`, `_patch_locked_originals`) and the post-upsert point at `:3878-3882`, `backend/distribution/data.py:1664-1665` (child path, same flag), `backend/integration/sap_staging.py:2221-2234`, `:2253-2276`, the ingest entry where `plant_tz` is resolved (~`:380-401`)
- Test: `tests/test_sap_staging.py`

**Interfaces:**
- Produces: column `orders.original_finish_date_only BOOLEAN NOT NULL DEFAULT FALSE`; helper `sap_staging._working_window_close(cur, plant, machine, day: date) -> datetime` (naive plant-local).

- [ ] **Step 1: Pin tests (pg, in test_sap_staging.py using `stg_plant`)**
```python
def test_a_date_only_due_on_a_never_placed_firmed_order_is_sent_as_the_working_window_close(pg, stg_plant):
    # set the plant timezone to 'Europe/Berlin' (UPDATE plants), a machine_calendar row for 'ZZSTG-M1' closing 22:00,
    # order firmed, never placed, original_finish_received 2030-02-05 00:00, original_finish_date_only TRUE, machine 'ZZSTG-M1'
    # queue_send_to_sap -> outbound row pedtr/pedti == plant_local_to_sap(datetime(2030,2,5,22,0), 'Europe/Berlin')
def test_review_focus_4_a_24_00_close_sends_23_59_59_of_the_due_date(pg, stg_plant):
    # same with a 24/7 machine -> pedti 23:59:59 of 2030-02-05 in plant time before conversion
def test_send_refuses_a_plant_with_no_time_zone(pg, stg_plant):
    # UPDATE plants SET timezone = NULL; pytest.raises(ValueError, match="time zone")
def test_ingest_marks_rows_of_a_plant_with_no_time_zone_as_errors(pg, stg_plant):
    # stage one planned order for an unzoned plant; run the ingest apply; the stage row's status is 'error' with error_text naming the time zone, and no orders row is written
def test_ingest_stores_the_date_only_flag_from_the_sap_time(pg, stg_plant):
    # pedti '000000' -> original_finish_date_only TRUE; pedti '180000' -> FALSE
```

- [ ] **Step 2: Run** — expect FAIL (`original_finish_date_only` column missing → run the new migration file against the scratch DB first with psql, as the cutover tests do; then the behaviour fails).

- [ ] **Step 3: Migration + schema**

`migrations/2026-10-16-2-orders-original-finish-date-only.sql`:
```sql
-- migrations/2026-10-16-2-orders-original-finish-date-only.sql
-- Backward scheduling D10 (validation finding VI12): whether the SAP finish arrived as a date with no time.
-- Send to SAP reads it to transmit the close of the plant's working window on that date instead of a
-- zone-converted midnight (which moved the date for any plant east of the SAP system zone).
-- Additive and idempotent. New ingests write the flag from what SAP sent; the one-time backfill below marks
-- existing rows whose locked finish sits at exact midnight (the only evidence available for old rows).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_finish_date_only BOOLEAN NOT NULL DEFAULT FALSE;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'orders_original_finish_date_only_backfill') THEN
    UPDATE orders SET original_finish_date_only = TRUE
     WHERE original_finish_received IS NOT NULL AND original_finish_received::time = TIME '00:00:00';
    INSERT INTO schema_migrations (id) VALUES ('orders_original_finish_date_only_backfill');
  END IF;
END
$mig$;
```
Mirror both statements in `schema.sql` right after the `original_finish_received` ADD COLUMN (line 254).

- [ ] **Step 4: Ingest flag**

db.py `_locked_originals` returns a third value, the flag: when the echo branch keeps the stored original, return `b.get("original_finish_date_only")` (None → keep stored); otherwise return `bool(row.get("_finish_date_only"))` if that key is present, else `True` when `in_f` is a datetime at exact midnight (Excel path). `_patch_locked_originals` collects `(id, flag)` pairs into a list it returns alongside the chunk; at db.py:3878-3882 after the executemany, run one `cur.executemany("UPDATE orders SET original_finish_date_only = %s WHERE id = %s", [(flag, oid) for oid, flag in pairs if flag is not None])`. Read `_ingest_originals` (data.py:1587) and add `original_finish_date_only` to its SELECT so the child path (data.py:1664) gets the same decision; apply the same post-upsert UPDATE there.

- [ ] **Step 5: Send**

`_outbound_candidate_rows`: add `o.machine, o.scheduled_end, seg.segment_count, o.original_finish_date_only` to the SELECT and names tuple (`"machine", "scheduled_end", "segment_count", "date_only"`). In `queue_send_to_sap`, before `build_outbound_groups`, map each candidate: if `row["planning_status"] != 'needs_planning' and row["scheduled_end"] is None and (row["segment_count"] or 0) < 2 and row["date_only"] and row["eff_end"] is not None`, replace `row["eff_end"]` with `_working_window_close(cur, plant, row["machine"], row["eff_end"].date())`. Write `_working_window_close`: read `machine_calendar.work_hours` for the machine (fall back to `plant_work_hours`; read the JSON shape from `backend/calendars/` routes, which is the only extra file you may open, read-only), resolve the day's window; a closed day walks back up to 30 days to the previous open day's close (mirrors `dueDateInstant`, `frontend/nimbus-compute-core.js:438-459`); a close at or after next midnight sends `23:59:59` of the due date; no calendar at all sends `23:59:59`. After that, `tz = _plant_info(cur, plant)["timezone"]`: add
```python
                if _zone(tz) is None:
                    raise ValueError(f"plant {plant} has no valid time zone; set it in Master Data before sending to SAP (VI13)")
```
Ingest: at the point the stage rows' `plant_tz` is resolved (~sap_staging.py:380), rows of a plant whose `_zone(plant_tz) is None` are marked `row_status='error', error_text='plant has no valid time zone'` the way `invalid_date` rows are, and skipped.

- [ ] **Step 6: Run** — `.venv/Scripts/python.exe -m pytest tests/test_sap_staging.py tests/test_domain_sap_staging_edges_coverage.py -q`; PASS (repair the existing `test_a_firmed_never_placed_order_is_sent_with_its_sap_finish_and_the_echo_of_it_matches` if its timed due now reads differently; it uses 14:30 so it should not).
- [ ] **Step 7: Commit** — `fix(integration): persisted date-only flag, Send transmits the working-window close; Send and ingest refuse a plant without a time zone (VI12 D10, VI13)`

### Task C3: VI11 — the header echo accepts an echo of any member's sent finish

**Files:**
- Modify: `backend/distribution/data.py:1181-1207`
- Test: `tests/test_distribution.py`

- [ ] **Step 1: Pin test** (pg, inside the class that already tests header echo / `_write_header_facts`; find it with `grep -n "header" tests/test_distribution.py | head`):
```python
def test_header_echo_matches_any_member_sent_finish_not_only_the_largest(self, pg):
    # family with two children; child A sent_finish 2030-03-01 10:00 (stale, larger), child B sent_finish 2030-02-20 16:00 (latest send)
    # incoming SAP finish 2030-02-20 16:00 timed -> _header_finish_echo(...) is True and original_finish_received is kept
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement** — replace the `SELECT MAX(s.sent_finish), ...` with `SELECT s.sent_finish, (SELECT MIN(p.timezone) ...) FROM ... ` returning all rows; `sents = [r[0] for r in rows if r[0] is not None]`; return `any(db._row_finish_echo({"sap_sent_finish": s, "tz": tz}, judged, parent.get("_sap_tz"), finish_key="sap_basic_finish_date") for s in sents)`. Update the docstring: "judged on the sent finish of any live member (U11 rule), so a stale larger row on a sibling cannot hide a genuine echo (VI11)".

- [ ] **Step 4: Run** — `.venv/Scripts/python.exe -m pytest tests/test_distribution.py -q -k "echo or header"`; PASS.
- [ ] **Step 5: Commit** — `fix(distribution): header echo accepts an echo of any member's sent finish (VI11)`

### Task C4: D15, D18, VM4 — cutover keeps a running order's stored end and requires the snapshot first; restore skips orphaned segments; cap comments

**Files:**
- Modify: `migrations/2026-10-20-1-backward-cutover.sql:17-18`, `:28-29`; `migrations/manual/2026-10-20-restore-precutover-snapshot.sql:44-47`; `migrations/2026-10-15-2-orders-run-time-bounds-336.sql:11-12`; `schema.sql:116` and its mirrored cutover block
- Test: `tests/test_backward_cutover.py`

- [ ] **Step 1: Pin tests**
```python
def test_cutover_before_snapshot_raises_and_writes_nothing(pg):
    # fresh seed, ledger ids cleared; run only 2026-10-20-1 -> psycopg raises (RAISE EXCEPTION); orders unchanged; no ledger row
def test_restore_skips_segments_of_orders_deleted_since_the_snapshot(pg):
    # seed, snapshot, cutover, DELETE one snapshotted split order; run the restore -> succeeds; its segments absent; other rows restored
```
Repair `test_backward_cutover_write_set_and_idempotence`: `zzcut-run-pastdue` (stored end a+3h, run 4) now keeps `a + 3h` (D15), not `start + run_time`.

- [ ] **Step 2: Run** — expect the new tests to FAIL and the repaired assertion to FAIL.

- [ ] **Step 3: Implement**

Cutover SQL: inside the `IF NOT EXISTS (... 'backward_scheduling_cutover')` block, first statement:
```sql
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'backward_cutover_snapshot') THEN
      RAISE EXCEPTION 'backward cutover: apply migrations/2026-10-20-0-orders-precutover-snapshot.sql first (no snapshot in the ledger)';
    END IF;
```
`old_end` CTE (line 28): `COALESCE(MAX(s.scheduled_end), o.scheduled_end, o.scheduled_start + (o.run_time * INTERVAL '1 hour'))` (stored end wins, D15) and rewrite the header comment lines 9-10 and the B4 comment to say "a running row keeps its start and its STORED end (D15)". Mirror both edits in `schema.sql`'s copy of the block.
Restore script (44-47):
```sql
  INSERT INTO order_schedule_segments
    SELECT (jsonb_populate_record(NULL::order_schedule_segments, to_jsonb(g))).*
    FROM order_schedule_segments_precutover_snapshot g
    WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = g.order_id);   -- VI16: an order purged since the snapshot has nothing to restore
  GET DIAGNOSTICS n = ROW_COUNT;   -- declare n INTEGER; raise a NOTICE with the restored count and the skipped count
```
(declare `n INTEGER` alongside `t TEXT`; compute skipped as the snapshot row count minus `n`; `RAISE NOTICE 'restored % segment rows, skipped % whose order no longer exists', n, skipped;`).
VM4: both comments say "flat 336 hours (no per-plant horizon term)".

- [ ] **Step 4: Run** — `.venv/Scripts/python.exe -m pytest tests/test_backward_cutover.py -q`; PASS.
- [ ] **Step 5: Commit** — `fix(migrations): cutover requires the snapshot and keeps a running order's stored end; restore skips orphaned segments; cap comments (VI15, VI16 D18, D15, VM4)`

**Batch C review:** as before, over `db.py`, `backend/`, `migrations/`, `schema.sql`, `tests/test_*.py`; the reviewer also re-runs `schema.sql` on a fresh scratch DB (`createdb nimbus_fw2 && psql -d nimbus_fw2 -f schema.sql`, then drop it) to prove the mirrored blocks parse.

---

## Batch D: documents

### Task D1: Runbooks and release model (Sonnet) — VI18, VI19, D14, D15, D16, VM22, VM29, VU25

**Files:** `docs/DEPLOYMENT.md:103-263`, `docs/MIGRATION.md:1391-1459`, `docs/superpowers/plans/2026-10-14-backward-scheduling-final-report.md:404-409`

- [ ] **Step 1: One release model (D16, VI18, VI19).** MIGRATION.md step 4 (line 1424) becomes "Merge `feature/backward-scheduling` into `main` by pull request (one merge; the retired `feature/backward-scheduling-phase1` branch is not merged on its own: it predates the fix waves)". The intro sentence that said Phase 1 ships first is rewritten the same way. DEPLOYMENT.md step 1 (130): drop "Nothing from this branch deploys before that" and say "one merge, one image, one cutover window". Final report section 6: replace items 1-2 with the single-merge text and point at this plan.
- [ ] **Step 2: Pending set (D10).** DEPLOYMENT.md step 2 list (138-142): now four files, adding `2026-10-16-2-orders-original-finish-date-only.sql` (additive, routine) before the two manual-only ones, and the Phase 1 pair note stays.
- [ ] **Step 3: Snapshot-first (D18).** Step 2/3 text and the rollback matrix: the cutover file now refuses to run without the snapshot ledger id; say so where the order is described.
- [ ] **Step 4: Running rows (D15).** Everywhere the runbook says start + run time replaces the stored end, say "keeps its stored end".
- [ ] **Step 5: Lines without a calendar (D14).** Step 3.4 (153): drop "or a line without a calendar" (no such alert any more); add to "What the cutover does": every line derives, a line without its own hours row uses the plant default.
- [ ] **Step 6: Gate Q15 (VU25).** Step 4 query: `HAVING COALESCE(NULLIF(MIN(timezone), ''), '') = '' OR MIN(timezone) NOT IN (SELECT name FROM pg_timezone_names)`.
- [ ] **Step 7: Summary toast (VM29).** Steps 3.4/3.5/13: "the summary toast appears only for a plant with at least 10 non-queued orders where more than half carry the cutover signature; a smaller plant shows ordinary per-row toasts, so the pass bar for it is the step 9 / G-6 SQL counts".
- [ ] **Step 8: Planner notice (VM22).** MIGRATION.md (c): the Send result count IS shown on screen (delete "The screen does not show that count yet"); "Original End column" → "Due Date column".
- [ ] **Step 9: Commit** — `docs(deploy): one-release model, four-file pending set, snapshot-first gate, stored-end rule, calendar and toast corrections (VI18, VI19, D14-D16, VM22, VM29, VU25)`

### Task D2: Doc drift (Haiku) — VM23, VM24, VM26, VM27, VM28

- [ ] `backend/distribution/CLAUDE.md:33`: survivor with no run time carries `scheduled_end = scheduled_start + 1 minute` (the strict range check), not equal edges.
- [ ] `frontend/scheduling/CLAUDE.md:48` (+ AGENTS.md twin): `Engine.autoReflow()` is called only from the overload-alert Fix (`insights/services.mts`), never from drag handlers; a drop runs no reflow cascade.
- [ ] Line anchors (VM26): refresh the cited line numbers in `frontend/optimization/CLAUDE.md:21`, `frontend/scheduling/CLAUDE.md:44-48`, `frontend/calendar/CLAUDE.md:22`, `backend/scheduling/CLAUDE.md:22` against HEAD after Batch C (grep each cited symbol in its own file; do not browse).
- [ ] `.claude/skills/promote-azure/SKILL.md:44` and the `.agents` twin: a BLOCKED file is forced with `-AllowDestructive` only when the runbook names it; Phase 1's `2026-10-15-1` is a backfill UPDATE of every orders row and is applied with `-Only` per file as DEPLOYMENT.md says. The Codex twin: replace "confirm before each prod mutation" with the same wording as the Claude copy and fix the `.Codex\skills` paths to `.agents/skills`; drop the `scripts/apply-migrations.ps1` reference (the runner lives under the skill folders).
- [ ] Commit — `docs: distribution survivor end, autoReflow caller, CLAUDE.md anchors, promote-azure skill wording (VM23, VM24, VM26, VM27, VM28)`

**Batch D review:** Sonnet reads the three runbook diffs against decisions D14/D15/D16/D18 and the C2/C4 code; appends the review line.

---

## Batch F: gate, whole-branch review, wrap-up

### Task F1: Full gate and trial merge (Sonnet, read-only)

- [ ] Run the batch gate on HEAD; save logs under `fixwave2/gate-final/`.
- [ ] `git worktree add ../nimbus-merge-check main` (outside OneDrive if the admin dir lock bites: use the scratchpad path), `git merge --no-commit --no-ff feature/backward-scheduling` there; must be clean; run `npm run build && npm run typecheck && npm test` in the merged tree; then `git merge --abort`, remove the worktree, `git worktree prune`.
- [ ] Ledger: `Fixwave2 F1: gate <numbers> vs baseline; merge-tree clean/conflicts: …`.

### Task F2: Whole-branch review (fresh Sonnet) and fix round

- [ ] Reviewer reads `git diff 69df633..HEAD` in file order, with the findings doc §3/§7a and this plan open. Reports: for each finding id and decision id, `implemented | partial | missing | deviates`, plus any regression it can name with a repro. Blocking = any `missing`/`deviates`, any gate regression.
- [ ] A fresh Sonnet implementer fixes blocking items (same rules: pin test, scoped run, commit); the reviewer re-checks; at most three rounds, then the orchestrator rules.

### Task F3: Wrap-up docs (Sonnet)

- [ ] Append `### Validation fix wave (2026-10-15)` to `BACKWARD_SCHEDULING_MIGRATION.md`'s implementation log: one line per task (id, commit, finding/decision ids), the gap decisions collected from the ledger, the two Context scope cuts, and the final gate numbers.
- [ ] Append `## 9. Fix wave (2026-10-15)` to the findings doc: tip sha, table finding id → status (fixed | deferred | closed by decision), residual list: VM10, VM11, VM25, VU2–VU8, VU10–VU16, VU18–VU24, VU26–VU29, the optimizer viewer-zone residual, the browser checks (final report §5 list plus the four added in the fix-wave residuals), the cutover rehearsal (G-10), the SAP echo test (A9), the `/tasks/bulk_update` caller list.
- [ ] Final report: one paragraph under section 6 pointing at the fix wave and the single-release model.
- [ ] `docs/MIGRATION.md` owed list: same residuals in one bullet each.
- [ ] Commit — `docs(backward-scheduling): record the validation fix wave, residuals and owed checks`
- [ ] Orchestrator: `Fixwave2 COMPLETE: tip <sha>` in the ledger; update memory `nimbus-backward-scheduling-validation-run` (tip, status, residuals) and `nimbus-backward-scheduling-implementation-plan` (one line).

## Verification (end to end)

- Automated: Task F1's gate numbers against the baseline; the pin tests named per task; the trial merge clean.
- Not run here, listed as owed (owner's choice): the ten browser checks, the cutover rehearsal on a restored pilot copy, the SAP echo test against a real SAP system.
- Manual spot-check the owner can do after merge, in a browser against a local server: firm an unplaced order and save (VC1); type an End of 14:37 and save (D1); drag a running order's finish (D2 toast); open a plant with a line that has no calendar row (derives, no red card).
