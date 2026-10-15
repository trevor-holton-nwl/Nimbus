# Fix: Optimize preview Apply rejected with "This proposal is no longer valid" (v117, post-cutover)

## Context

Right after the backward-scheduling cutover (nimbus:v117, commit 06bb2fc, 2026-10-15), every Optimize preview on plant 1008 fails at Apply: toast "This proposal is no longer valid. Run optimization again before applying.", the Apply button greys out, and two lines "Production lies outside its allowed planning window." appear in the preview banner (lines 20STA02 and 20STA24). Reproduced in the browser against the live pilot and traced to the code.

**What is happening (verified on the live page, not inferred):**

1. The preview runs in the optimizer Web Worker. The search itself is correct: it placed the two orders on Wed 11 Nov, which is legal (plant 1008 has `max_pull_forward_days = 1`, the orders' due date is a date-only Fri 13 Nov, the lines are closed on Fridays, so the due instant is Thursday 12 Nov 19:00 and the pull-forward floor is Wed 11 Nov 00:00).
2. When the worker returns, `buildOptimizerWorkerResponse` (`frontend/optimization/optimizer-worker.mts:39-40`) calls `serializeOptimizerValidation` **after** `evaluateSchedule` has returned, i.e. after `_candidateSnapshot` was reset to null (`engine.mts:943`).
3. The engine-supplied bounds closures (`engine.mts:2755-2756`) call `Engine.earliestAllowedStart` / `latestAllowedEnd`, which read the due instant through `sourceDueInstant` (`engine.mts:858-863`): `_candidateSnapshot ?? live Store`. In the worker realm the Store is empty, so the line has no calendar row, `dueDateInstant` (`nimbus-compute-core.js:447-459`) finds no open day in 30 days and falls back to end-of-day of the raw date: Fri 13 Nov 23:59:59. That shifts the due day to the 13th, so the serialized floor becomes Thu 12 Nov 00:00 (checked: with empty calendars the page computes exactly the serialized floor 12 Nov 05:00Z and ceiling 14 Nov 05:00Z, via `hardBounds` max/min in `setup-scheduler.mts:6351-6363`).
4. Apply re-validates on the main thread with the rehydrated per-task tables (`engine.mts:3221-3222`), so the two legally placed orders now start before the (wrong) floor and `validateCandidate` emits `date_window` errors (`setup-scheduler.mts:6654`). `OptimizerPreview.apply` (`optimize-ui.mts:2092-2098`) then shows the toast and disables the button. Deterministic on every run.

**Why it only appeared now:** Phase 1 of backward scheduling made a date-only due on a closed day resolve to the previous open day's close (`dueInstant`, `setup-scheduler.mts:1247-1280`). Before, raw midnight was used in and out of the run, so the post-run serialization agreed with the search. The bug fires for any order with a date-only due date on a closed day (weekend/holiday) on a plant with pull/push limits, which is most of plant 1008's orders.

Not involved (ruled out by two independent traces and the live check): the read-model revision (removed from `stale_candidate` in 681f7aa), the reconcile re-running under an open preview (no timer or poll exists; the task baseline check passed), the stale banner path (`canApply()` was true).

Note for the owner: the first Save after the cutover (19:30 UTC) persisted 872 orders on plant 1008 and queued 197 as `overlong_never`; 2757 orders still flagged are outside the visibility horizon and are untouched by design. Not part of this bug.

## Fix (root cause, not symptom)

Make the engine-supplied bounds closures **snapshot-bound** so they give the same answer inside the run, in the worker's post-run serialization, and on the main thread at Apply. This also matches the documented intent that "candidate validation and Apply use the captured snapshot".

**File: `frontend/optimization/engine.mts`**

1. `sourceDueInstant(task, plant, view?)` (`:858`): add an optional third parameter `view?: Pick<ScheduleSnapshot, 'calendars' | 'plants' | 'lineSettings' | 'masterData'> | null`; use `view ?? _candidateSnapshot ?? { ...live Store }`.
2. `Engine.earliestAllowedStart(task, plant, frozenHorizonEnd?, masterDataOverride?, view?)` (`:1189`) and `Engine.latestAllowedEnd(task, plant, masterDataOverride?, view?)` (`:1217`): accept the optional `view` and pass it to `sourceDueInstant`. Existing callers unchanged (parameter is optional).
3. The setup-aware bounds (`:2755-2756`): pass `baseSnapshot` as the view:
   ```ts
   notBefore: (task) => Engine.earliestAllowedStart(task, plant, baseSnapshot.frozenHorizonEnd, baseSnapshot.masterData, baseSnapshot),
   notAfter:  (task) => Engine.latestAllowedEnd(task, plant, baseSnapshot.masterData, baseSnapshot),
   ```
   The backlog path (`:2560`, `notBefore: () => null`) needs nothing.
4. Comment on `sourceDueInstant` and on the closures: the worker serializes these closures after the run ends (`optimizer-worker.mts:39-40`), so they must never depend on the ambient `_candidateSnapshot` or the realm's Store.

No change to `optimizer-worker.mts`, the contract, `setup-scheduler.mts` or the UI. No migration. Code-only release.

**Docs (same commit):**
- `frontend/optimization/CLAUDE.md`: in "Hard-bound candidate and Apply contract", replace the stale sentence "a revision mismatch produces `stale_candidate` before mutation" with the real rule (a structural diff of the two snapshots minus `readModelVersion`), and add one line: engine-supplied `notBefore`/`notAfter` closures are snapshot-bound because the worker serializes them after the run.
- `frontend/optimization/setup-scheduler.mts:396` comment ("used to reject stale Apply operations") → "diagnostics only".

## Tests (repair-only + pins)

**`tests/modules/optimization/optimizer-worker.test.mjs`** (existing `buildOptimizerWorkerResponse` fixtures at ~:176, :201): add one pin:
- Snapshot: plant `P` with `max_pull_forward_days: 1`, `max_push_forward_days: 1`, `timezone` set; line `L` whose calendar has Friday `null` (closed) and Mon–Thu open 07–19; one task on `L` with `original_end_date` = a Friday at exact local midnight (date-only), RUN_TIME 2.
- Call `buildOptimizerWorkerResponse(request)` in the test realm (its Store is empty, like the worker).
- Assert `response.validation.notBeforeById[id]` equals the Wednesday 00:00 before that Friday (previous open day Thursday, minus one day) and `notAfterById[id]` equals Saturday 00:00 (Thursday + 1 + 1 days), i.e. the in-run values. Before the fix the floor comes back as Thursday 00:00 and the ceiling as Saturday 00:00 (min with the own ceiling), so the test fails on the floor.
- Then `rehydrateOptimizerCandidate` + `validateCandidateForApply` on a candidate that places the task on the Wednesday: assert no `date_window` error.

**`tests/modules/optimization/optimize-ui.test.mjs`** (or `engine.test.mjs` if the sync evaluator is easier to drive there): one sync-path pin. Build a preview candidate with the synchronous evaluator (`evaluateSchedule`) on a snapshot whose line calendar closes Friday; then change the live Store's calendar for that line (open Friday) and call `validateCandidateForApply(candidate, snapshotSchedule(plant))`. Assert the floors still come from the captured snapshot (no `date_window` error for an order placed the Wednesday before a Friday date-only due). Before the fix the closure reads the live Store and the floor moves.

**`tests/modules/optimization/engine.test.mjs`**: one pin that `Engine.earliestAllowedStart(task, plant, null, md, view)` reads the given view's calendars and ignores the live Store (Store with Friday open, view with Friday closed → floor differs by one day).

Scoped run: `npm run build && node --test tests/modules/optimization/optimizer-worker.test.mjs tests/modules/optimization/engine.test.mjs tests/modules/optimization/optimize-ui.test.mjs tests/modules/setup-scheduler.test.mjs`, then `npm run typecheck && npm run lint`.

## Execution

- Branch from main (`a178c69`): `fix/optimizer-worker-due-window`. Sonnet implements (one task, files above), fresh Sonnet reviews the diff against this plan, then merge to main. Orchestrator writes no code.
- Commit: `fix(optimization): snapshot-bound due-window floors so the worker's Apply table matches the search (post-cutover Apply rejected)`.
- Release: code-only, `/promote-azure` as nimbus:v118 (no pending migrations; rollback target v117). The pre-cutover image v116 is not a valid rollback any more, so this is a fix-forward.

## Verification (end to end)

1. Unit pins above red before / green after.
2. Local server against the local DB: Optimize (Due Date) on a plant with pull/push limits and a date-only due on a closed day → Apply succeeds.
3. On the pilot after v118: plant 1008, Optimize → Due Date → Apply; expect the "applied" toast, no `date_window` lines; then Discard or Save at the owner's choice. Also re-run once with the preview left open two minutes to confirm it still applies.
4. Separate data finding for the owner, not part of this fix: plant 1008 (Mexicali) has `timezone = America/New_York` in master data; every plant-zone placement rule now live uses it. Correct it in Master Data in its own window (it changes derived starts for the whole plant).
5. Residual to log in `docs/MIGRATION.md`: the sync (no-worker) path validates Apply against the live Store's calendars rather than the captured snapshot; after this fix both paths use the snapshot, which closes that gap too.
