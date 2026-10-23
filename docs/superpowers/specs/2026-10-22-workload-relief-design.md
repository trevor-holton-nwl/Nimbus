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
- Fix wave (Opus validator, SHIP AFTER FIXES), one commit each: (1) Stage and Download-rejected return on an empty outcome after the debounce flush (6c777c0; the modal is not exported and there is no DOM harness, so the test pins the handler source shape rather than driving clicks); (2) plant-scale test cut to 400 candidates (matrix still 9,900 rows), about 1.1 s alone, re-verified to FAIL (2.8 s) without the `index:` argument and pass with it (cb32c0d; the earlier "about 4 s" figure was wrong, it was ~6 s); (3) override build-time filter parity tests: inactive status, mismatched signature version, invalid minutes, initial-state override, first-in-bucket wins and an invalid first override skipped (4108ffa); (4) added an orphan-verdict-at-final-start reconcile test, but the setup-reserved second walk kept the start unchanged in every scenario tried (4 h, 12 h and 14 h orders), so the `orphanedAt` miss path is NOT forced by it; it pins the hit path only; (5) frontend/insights/CLAUDE.md notes the `setupTasks` vs PLANT filter edge; (6) `deriveSetupObservationUnindexed` marked @internal (963e98f); (8) probe `spawnSync` timeout 1500 to 10000 ms at six sites, a pre-existing load flake since loading engine.mjs takes 0.8-4.6 s here (80d8226).
- Final gate after the fix wave: build, typecheck, lint (0 errors, 34 pre-existing warnings), check:static-assets, check:legacy-surface green. `npm run test`: 3,034 tests, 3,030 passed, 1 failed (the known styles.css "block is LF only" test); the engine.test.mjs probe timeouts did not recur.
