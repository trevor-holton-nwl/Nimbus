# NIMBUS workload relief (2026-10-22)

## Context
An Opus deep-dive (plan `are-there-any-new-generic-cook.md`) found that no new worker type is the first move. Two workers already exist (alerts/utilization/leverage `nimbus-worker.ts`, optimizer `optimizer-worker.mts`). The largest waste is: (a) `resolveSetup` called without the resolution index (linear scans per call), (b) an over-coarse utilization cache, (c) the pandas row builder in `GET /tasks`, (d) leverage batches blocking the shared worker. All timings are estimates from reading code; nothing is measured at full scale, hence the `PerfMonitor` timing keys.

## Decided scope
- Wave A (frontend, branch `feature/workload-relief-fe`): timing keys; setup-resolution index in `deriveSetupObservation` and `reconcileRuntimeSchedules`; setup mass-upload validation cache + debounce; worker hygiene 6a/6d/6e; leverage trivia.
- Next: dedicated leverage worker (timeout => stop worker, show quick alerts-removed ranking, never rerun on main thread; sync path only when `Worker` is unavailable), then utilization cache fix + Dashboard filter-after + Labor async.
- Separate backend track for `/tasks` (own branch `feature/workload-relief-be`).
- Out / measure first: optimizer worker KPIs, shared derivation cache, 6b/6c/6f, leverage delta variants, ETag.

## Status ledger
(one line per completed step; append below)
- Wave A step 1 (c3a9644): PerfMonitor keys `Setup.deriveObservation`, `Engine.reconcileRuntimeSchedules`, `Leverage.buildPlantSnapshot`.
- Wave A step 2 (2ea55d8): `deriveSetupObservation` resolves through a `WeakMap`-memoised `buildSetupResolutionIndex` (`setupResolutionIndexFor`); parity + counted tests in `tests/modules/optimization/derive-setup-observation-index.test.mjs`.
- Wave A step 3 (ace1b01): `reconcileRuntimeSchedules` builds one index, one orphan map, one line grouping per pass; `orphanedAt` reuses the first `setupBefore` verdict; plant-scale counted test in `engine.test.mjs` (fails without the index, passes with).
- Wave A step 4 (f96febd): setup mass-upload `resolveFromKey` cache, 150 ms debounce with flush, cell lookup once per modal; docs/MIGRATION.md path fixed and item marked done.
- Wave A step 5 (d493bba): worker hygiene 6a (setup clone removed), 6d (dead Confidence branch removed), 6e (shallow per-variant copies in worker and `runLeverageBatchSync`) with a no-plant guard test.
- Wave A step 6 (e8885c4): `analyzeLeverage(input, runner, groups?)` and `LeverageInput.setupTasks`; two additive tests.
- Wave A step 7: CLAUDE.md updates in frontend/optimization, frontend/setup, frontend/insights.

## Deviations / additions
(append below)
- Branch name: `feature/workload-relief-fe` already exists and is checked out in the separate worktree `.claude/worktrees/workload-relief-fe` (same base 4c37368), so it could not be switched to from this worktree. Work was done on `feature/workload-relief-fe-agent` (from 4c37368); the caller should fast-forward `feature/workload-relief-fe` to it.
- Parity oracle: added exported `deriveSetupObservationUnindexed` (engine.mts) so the indexed and linear paths can be compared by JSON equality; the staleness guard on the memoised index (definition, row arrays and their lengths) is an addition beyond the plan, so an in-place edit can never serve a stale index.
- Test placement: the step-2 parity/counted tests live in a new file `tests/modules/optimization/derive-setup-observation-index.test.mjs` (engine.test.mjs is 5.5k lines); the step-3 plant-scale test lives inside `describe('reconcile (finish-anchored)')` in engine.test.mjs rather than scheduler-plant-scale.test.mjs, because it needs that describe's Store/clock fixtures (recFixture, withSetup). Existing reconcile fixtures pass unchanged as the parity check.
- Timing: `Engine.reconcileRuntimeSchedules` is now a thin timed wrapper over `Engine._reconcileRuntimeSchedulesPass` (the former body). No per-variant timing key in alert-leverage.mts (it is a pure module with no PerfMonitor import); each variant already records `Setup.deriveObservation`.
- Step 4: `resolveFromKey` and `parseMassUploadText` gained an optional trailing `lineScope` parameter (default the module's `_lineScope`) so tests can exercise scope invalidation without a DOM; `parseMassUploadText` also takes an optional prebuilt cell lookup. The debounce is the exported pure `createDebouncedValidator` with injectable timers.
- Step 6: `analyzeLeverage` copies caller-supplied groups (`{...item}`) because the replay mutates items (`confidenceAfter`, `method`, `capped`) and the Alert Monitor has painted the same objects. `setupTasks` is optional and falls back to `Object.values(tasksById)`.
- Step 5 (6d): the dead branch was verified dead (it repeated the outer `available() && plant` test inside its own else) before deletion.
- Hook noise: the post-edit design hook reported ~99 findings on `frontend/nimbus-intelligence.js` (CSS-in-JS strings, bounce easing, side-tab borders), all pre-existing and unrelated to the deleted dead branch; left unchanged.
- Final gate (Wave A): build, typecheck, lint (0 errors), check:static-assets and check:legacy-surface green. `npm run test`: 3,023 of 3,031 passed; the failures were the known styles.css CRLF test plus four `engine.test.mjs` cases that shell out to a node probe (`spawnSync ... ETIMEDOUT`, load-sensitive when the whole suite runs in parallel). `engine.test.mjs` re-run alone: 196/196 on the second run (first run 3 probe timeouts), so treat the probe timeouts as a load flake, not a regression. The new 2,000-candidate plant-scale test takes about 4 s.

## Wave B ledger (dedicated leverage worker, items 4 + 6b; branch `feature/workload-relief-fe-b`, from f97048c)
- B1 (38028f4): `Compute.leverageBatch(base, variants, {signal?})` uses a per-call short-lived worker; timeout/abort terminate it and reject `TimeoutError`/`AbortError`; no main-thread rerun after either; sync core only for no `Worker`, constructor throw, worker crash or `ERROR` reply.
- B2 (e28edf4): optional `{signal}` threaded through `LeverageRunner`/`analyzeLeverage`/`replayWithMinutes`; the pane holds one `AbortController` per run (and per minutes replay), aborted on plant change, `setActive(false)` and plan-move events (abort, then the existing 400 ms debounce re-queue).
- B3 (a29f750): tests in `compute-transport.test.mjs` (own worker, shared worker unaffected, timeout, abort, crash fallback, ctor failure / no Worker), `leverage-batch.test.mjs` (timeout test now expects `TimeoutError`; vm parity test untouched) and `alert-monitor-leverage-pane.test.mjs` (abort on tab leave / plan move / plant change; timeout keeps phase-1 cards).
- B4: docs in frontend/insights/CLAUDE.md, frontend/alert-monitor/CLAUDE.md and the 2026-10-20 alert-monitor design.

### Wave B deviations
- Timeout feedback is log-only (`ErrorLog.warn`), with no inline status string: the vocabulary rule and a 5-locale addition were not worth a status line for a rare 30 s case; the removal-only cards already read as the quick ranking.
- Worker `onerror` / `ERROR` reply on the leverage worker: one sync-core fallback (a crash, not a timeout), logged with `ErrorLog.warn`. A `postMessage` failure (e.g. DataCloneError) is handled the same way.
- The leverage path does not consult the shared `_dead` flag: if the shared worker is dead because workers are blocked, the dedicated constructor throws and the sync fallback applies; if only the shared worker crashed twice, leverage can still use a dedicated worker.
- Small robustness addition in `_levRun`'s `finally`: a queued `_levRerun` calls `_levRun()` directly when `_levHave` is false (a plant-change reset), because the debounced re-run is gated on `_levHave` and would drop it.
- Pane aborts also cover plant change through `_levReset` (called by `resetView` and by `_renderLeverage` on a plant mismatch), so no separate listener was added.
- The leverage-batch timeout constant keeps its name `LEVERAGE_BATCH_TIMEOUT_MS`.
- Identity parity test (replaying the baseline setup reproduces the baseline score): skipped, not cheap in the existing fixtures; the vm parity test against `runLeverageBatchSync` stays green.
- Deferred as instructed: the scores-only worker reply, 6c/6f, the utilization cache.

### Wave B fix wave (Opus validator)
- Typed-minutes replay timeout is logged (`leverage replay timed out`); only `AbortError` is silent.
- Leverage-worker crash latch: after 2 crashes (`_leverageCrashes`, separate from `Compute._crashCount`/`_dead`) batches skip worker creation and use the main-thread path until reload.
- The leverage reply is accepted only as `LEVERAGE_BATCH_RESULT` with an array `results`; anything else rejects (then sync fallback). Removed `'LEVERAGE_BATCH'` from `_post`'s union and the always-undefined `jobId` log field; doc comment lists the real fallback cases.
- Tests added: ERROR reply, postMessage throw, late reply after timeout, abort/timeout after success are no-ops, crash latch, malformed reply (compute-transport); plant change starts the new run, `alerts:change` aborts, signal passes through `analyzeLeverage`/`replayWithMinutes` (pane/leverage tests).
- Deferred follow-up: each typed-minutes key starts its own worker (a replay per key); fold into one batch together with the deferred scores-only reply.
