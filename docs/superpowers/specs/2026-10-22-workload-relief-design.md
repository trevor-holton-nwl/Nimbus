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


## Wave C ledger (utilization cache, Dashboard filter-after, Labor async; items 5 + 6c; branch `feature/workload-relief-fe-c`, from `feature/workload-relief-fe-b`)
- C1 (0f4f191): `Store.dataRev()` (exclusion list `alerts:change`, `lines:selected`, `distribution:summary`, `undo:pushed`, `settings:change`); private per-plant LRU (6 entries) in `services.mts` with exact-window and day-slice hits; null path reads `Store.tasksForSelectedPlant()` with a plant selected; `Utilization.computeMatrixAsync` (cache, in-flight share, one posted + one queued/merged, dataRev/plant staleness, rejection and 3 s timeout fall back to sync, id re-hydration); `_prewarm`, NeedsEngine, Confidence and the breakdown repointed (fixes 6c: no more raw worker ids in the cache); old `Utilization._cache` removed, test hooks `_cacheEntries`/`_cacheClear` added.
- C2 (Dashboard commit): `render()` calls `computeMatrix(start, 7)` with no subset and filters rows via `_visibleLines`; the per-filter `_matrix7Cache` memo is gone (the field stays as the day-stepper's holder).
- C3 (Labor commit): `_renderKPIs` and the three sub-tab renders await `computeMatrixAsync` behind the existing loading placeholder and generation guards.
- C4 (Gantt commit): the hierarchy strip calls `computeMatrix(todayStart, 1)` with no subset (full-plant, shared cache, day-0 slice of any cached longer window); `Hierarchy._todayCache` removed.
- C5: tests (`utilization-cache.test.mjs`, additions to store/confidence-lifecycle/insights-ui/labor-planning tests; existing tests that poked `Utilization._cache` now use the hooks), legacy-surface contract regenerated, docs.

### Wave C deviations
- Queue semantics: the task said a newer queued request supersedes the older one before it is posted. A dropped request would leave its callers hanging (Labor wants 112 days, Confidence 14, NeedsEngine 7), so a newer request is MERGED into the queued one (union window, all waiters resolved by slicing) instead. At most one is queued and one in flight, as intended.
- A request whose in-flight predecessor is stale (dataRev or plant moved) is answered from the synchronous `computeMatrix` rather than re-posted; this bounds work during a drag storm and keeps the promise resolving with current data.
- `Dashboard._matrix7Cache` kept as a single-slot holder for `_lsStep` (and the existing tests) rather than deleted; its key now carries `dataRev()` and no filter scope. With no plant selected the Dashboard returns before computing, so the old "no plant => empty task subset" difference does not show.
- Gantt strip: not gated on Gantt-tab visibility (the strip can render while another tab is active and the sidebar needs correct heights on return) and not tied to the 7-day matrix: it requests a 1-day window and the cache slices it from any cached longer window; on a cold cache it computes one cheap 1-day matrix and stores it. Skipped as unsafe: visibility gating.
- Alert Monitor baseline (`alert-monitor-pane.mts`, 14 days) left on the sync `computeMatrix`; it now hits the shared cache (the same entry Confidence fills) and is no longer evicted by `alerts:change`.
- `Utilization._cache` was a legacy-surface "private consumer" of `nimbus-intelligence.js`; the contract was regenerated with `--write --allow-growth` because `Utilization.computeMatrixAsync` is a deliberate new intelligence command (net: 3 entries removed, 1 added).
- Existing tests changed: `services.test.mjs` (I13 prewarm test checks `_cacheEntries()`), `confidence-lifecycle.test.mjs` (I13 test: NeedsEngine no longer posts to the worker, so only Confidence is expected to), `capacity-allocation-integration.test.mjs` (`_cacheClear()`).
- `computeMatrixAsync` rounds the start with `Util.startOfDay` and sends that to the worker; before, Confidence sent `_plantToday()` to the worker but `horizonStart` to the sync fallback (identical in practice: `plantToday = startOfDay(plantClock)`).

### Wave B fix wave (Opus validator)
- Typed-minutes replay timeout is logged (`leverage replay timed out`); only `AbortError` is silent.
- Leverage-worker crash latch: after 2 crashes (`_leverageCrashes`, separate from `Compute._crashCount`/`_dead`) batches skip worker creation and use the main-thread path until reload.
- The leverage reply is accepted only as `LEVERAGE_BATCH_RESULT` with an array `results`; anything else rejects (then sync fallback). Removed `'LEVERAGE_BATCH'` from `_post`'s union and the always-undefined `jobId` log field; doc comment lists the real fallback cases.
- Tests added: ERROR reply, postMessage throw, late reply after timeout, abort/timeout after success are no-ops, crash latch, malformed reply (compute-transport); plant change starts the new run, `alerts:change` aborts, signal passes through `analyzeLeverage`/`replayWithMinutes` (pane/leverage tests).
- Deferred follow-up: each typed-minutes key starts its own worker (a replay per key); fold into one batch together with the deferred scores-only reply.

### Wave C fix wave (Opus validator, 2026-10-23; same branch, after merging `feature/workload-relief-fe-b`)
- F0: merged `feature/workload-relief-fe-b` (merge commit; both ledgers kept, gate re-run green on the merged tree).
- F1 stale replies: a reply the data moved under is re-posted once (no main-thread compute); `computeMatrixAsync(start, days, { syncFallback })`: `false` (used by `_prewarm` and Confidence; the breakdown tries it and then computes synchronously because a user clicked) rejects with a named error (`UtilizationStale`, `UtilizationTimeout`, `UtilizationWorkerError`, `UtilizationMalformed`) instead of computing; default `true` keeps the sync fallback for Labor. Confidence resets `_lastRev` on a non-stale failure so the next call retries.
- F2 timeout budget 3 s -> 20 s; a late reply is cached if dataRev and plant still match.
- F3 worker line set: the UTILIZATION payload carries `lines` = task lines + plant lines (the sync set); real-core parity test (worker vs sync, idle line with no orders and no calendar entry). The golden `_snap` payload test now lists `lines`.
- F4 slicing requires the cached day instants to equal a fresh walk (DST at midnight => clean miss); subprocess test under TZ=America/Santiago (`tests/modules/helpers/utilization-dst-probe.mjs`).
- F5 queue: merge only overlapping or adjacent windows; separate FIFO jobs otherwise (max 4; a full queue settles the new waiter like a stale one).
- F6 `finish` catches: an exception while settling rejects the waiters, always resolves the in-flight promise and pumps the queue; joiners re-enqueue instead of hanging; test with a throwing `PerfMonitor.record`.
- F7 I13 test now asserts a cache entry starting at plant-today exists after `NeedsEngine._readState()`. Deviation: `days >= 7`, not `=== 7`: after Confidence fills the 14-day window the 7-day read is a slice of it and (correctly) creates no new entry.
- F9/F10 docs: calendar CLAUDE.md/AGENTS.md, CALENDAR_PERIODS_DESIGN.md, the store.mts comment and insights CLAUDE.md corrected (cache keyed on `dataRev()`; slice and parity claims).
- F11 Labor `_renderKPIs` on the save path has a `.catch` (clears the strip, logs).
- F12 `Dashboard._lsStep` now calls `Utilization.computeMatrix(plantClock, 7)` (a cache hit); `Dashboard._matrix7Cache` and the stale-cache W6 test are removed (the stepping test stubs `computeMatrix`).


## Autonomous run: final log

Integration branch `feature/workload-relief`, based on main `4c37368`, built from four finished branches by real merges (no rebase, no squash). Nothing pushed or deployed.

### The four pieces
| Piece | Branch | Tip | Notes |
|---|---|---|---|
| Frontend Wave A (items 1-3, 6a/6d/6e, leverage trivia) | `feature/workload-relief-fe-agent` | `7818855` | from `4c37368`; Opus validator verdict SHIP AFTER FIXES, fixes in 6c777c0, cb32c0d, 4108ffa, 963e98f, 80d8226 |
| Leverage worker (items 4 + 6b) | `feature/workload-relief-fe-b` | `ffc9dcf` | from `f97048c` (a Wave A docs commit); Opus validator fix wave c0ac895 (crash latch, strict reply check, timeout logging) then ffc9dcf (tests); the verdict word is not recorded in the ledger |
| Utilization cache, Dashboard filter-after, Labor async (items 5 + 6c) | `feature/workload-relief-fe-c` | `9ae4bae` | merged fe-b itself; Opus validator fix wave F0-F12 (7fecfe3, 2890792, 9ae4bae); the verdict word is not recorded in the ledger |
| Backend `GET /tasks` | `worktree-agent-a31525a1a839c0b9b` | `7075dda` | from `4c37368`; Opus validator verdict SHIP AFTER FIXES, fix wave F1-F10 (86e26eb, 7075dda) |

Merge order on this branch: fe-agent (7818855), fe-c (9ae4bae, contains fe-b), backend (7075dda). The only conflicts were documentation: this file (the Wave A ledger lines and the Wave B/C ledgers, all kept) and `frontend/insights/CLAUDE.md` (the "Leverage transport" paragraph: the fe-c text was kept and Wave A's `deriveSetupObservation` edge note was re-added to it). `tests/contracts/cq1-legacy-surface.json`, `services.mts` and the alert-monitor docs merged without conflict; `check:legacy-surface` passes on the merged tree. fe-b's fix commits c0ac895 and ffc9dcf are in the result.

### Integration gate (merged tree)
build, typecheck, check:static-assets, check:legacy-surface green; lint 0 errors, 35 warnings (34 before the merge); `npm run test`: legacy 105/105, modules 3,079 tests, 3,075 pass, 1 fail (the known `alert-monitor-overview-css.test.mjs` styles.css line-ending test), 2 skipped; `python -m pytest tests/ -q`: 1,464 passed, 626 skipped (no usable local Postgres), 13 xfailed, 2 failed (`test_integration_routes.py::test_lifespan_*`, DB authentication; known). `generate:api-types`: the only `/tasks` line that differs from main is the one docstring line (`query_orders_rows`); the other regenerated differences are pre-existing staleness of the committed file and were not committed. Cross-branch checks: the leverage worker's crash latch (`_leverageCrashes`, a dedicated worker per call) is separate from the shared worker's `_crashCount`/`_dead` that `computeMatrixAsync` uses; the memoised setup resolution index lives in `engine.mts` and the leverage replay reaches it only through `buildPlantSnapshot` (`opts.setupObservation`), so fe-c does not touch it; the `/tasks` response shape is unchanged for the frontend (no change to the `/tasks` types beyond that docstring).

### Minor deviations and additions versus the plan (collected from the ledgers)
- Branch names differ from the plan: `feature/workload-relief-fe` and `-be` were already checked out in other worktrees, so the work is on `feature/workload-relief-fe-agent` and `worktree-agent-a31525a1a839c0b9b`; those two plan branches (and their worktrees) are unused, still at `4c37368`.
- Backend: `gzip;q=0` handling skipped (the starlette middleware would compress regardless; fixing it means replacing the middleware); the timing log goes to `nimbus.perf` and enters the `_BACKEND_LOG` ring only above 1,500 ms; `/tasks` handler gzip skip below 1,000 bytes and `mtime=0`; pandas-3 null behaviour pinned (a null `MATERIAL_DESCRIPTION` still yields the text "None", flagged for a product decision); `build_tasks_payload`/`encode_tasks_response` public helpers; `query_orders` delegates to `_fetch_orders`; the benchmark "before" whole-path figure is a reconstruction. Backend owed items: the DB-backed pytest set, real-row parity of the golden test against live rows, and a cache-busted `GET /tasks` with and without gzip (see "Owner-owed checks").
- Wave A: `deriveSetupObservationUnindexed` exported as the parity oracle; staleness guard on the memoised index; the plant-scale reconcile test cut from 2,000 to 400 candidates (about 1.1 s alone, verified to fail without the index); the `orphanedAt` miss-path test could not be forced and is not covered; the engine node-probe `spawnSync` timeout raised from 1,500 to 10,000 ms (a pre-existing load flake); the mass-upload modal has no DOM harness, so the Stage/Download-after-debounce fix is pinned by a source-shape test.
- Wave B: timeout feedback is log-only; one sync-core fallback on a worker crash or `ERROR` reply; the identity parity test was skipped (not cheap in the fixtures); the scores-only worker reply and folding typed-minutes keys into one batch are deferred.
- Wave C: a newer queued utilization request is merged rather than dropping the older one (later refined to merge only overlapping or adjacent windows, max 4 queued jobs); the Gantt strip is not gated on tab visibility; the Alert Monitor baseline stays on sync `computeMatrix` (now a cache hit); `Dashboard._matrix7Cache` was removed in the fix wave (F12); the legacy-surface contract was regenerated with `--allow-growth` for the new `Utilization.computeMatrixAsync`; the I13 test asserts `days >= 7`.

### Deferred
Optimizer worker KPIs (item 3); a shared derivation cache; the 6f crash-count decay; leverage delta variants; ETag on `/tasks`; the scores-only leverage reply with typed-minutes batch folding.

### OPEN go-live question
Is a single replica acceptable for go-live? If not, the in-process state must move to Postgres first: the color-wheel cache, `_BACKEND_LOG`, the login throttle, the lifespan scheduler jobs and `PLANT_LISTS`. This run did not change any of it.

### Owner-owed checks (browser and database)
1. Setup mass-upload debounce, including Stage and Download right after clearing the text, and Escape during the debounce.
2. Alert Monitor Top fixes: worker count before and after a forced timeout, and leaving the tab or switching plants mid-run.
3. Labor sub-tabs and horizons.
4. Dashboard filter toggles (no recompute).
5. Gantt hierarchy strip numbers versus the Dashboard today column.
6. Gantt setup bars, and the reconcile `setup_override_orphaned` notes on a setup-active plant.
7. `GET /tasks` against the real DB: parity of the pandas-free builder with the legacy one, and the gzip checks (`Content-Encoding`, a single `Vary`, identical decoded JSON, a `tasks.timing` event), plus the DB-backed pytest set listed in the backend log.
8. PerfMonitor: the new keys visible and the `Worker.setupClone:*` keys gone.

### Merge onto main 21ba680 (2026-10-23)

Branch `feature/workload-relief-on-main` = `feature/workload-relief` (ea6fa10) plus a real `git merge main` (21ba680).

- Conflicts (3, all keep-both): `frontend/platform/store.mts` (`_dataRev` and `_lastEvent` fields side by side), `tests/modules/platform/store.test.mjs` (the `dataRev` test and main's two ErrorLog tests, both kept), `frontend/insights/CLAUDE.md` (utilization-cache bullets and main's worker-error / memoization bullets, both kept). `frontend/insights/services.mts` and `frontend/nimbus-worker.ts` auto-merged (main's worker-global error handling and the leverage per-call worker, `computeMatrixAsync` and crash latch coexist); no contract regeneration was needed.
- New Store events: main added none (no new `type:` strings under `frontend/` since 4c37368). Main's `emit()` change (per-subscriber try/catch, `_lastEvent`) is orthogonal; `dataRev` bumps before listeners run and still excludes the same five events, so the exclusion list is unchanged.
- Line endings: the committed blob of this doc is already LF only (index `i/lf`); the "mixed" state was the CRLF working copy under `core.autocrlf`, so no normalisation commit was needed.
- Gate: build, typecheck, check:static-assets, check:legacy-surface clean; lint 0 errors (35 pre-existing warnings); `test:legacy` 105/105; `test:modules` 3102 tests, 3098 pass, 2 skipped, 1 fail (the known styles.css LF test in alert-monitor-overview-css); pytest 1471 passed, 626 skipped (no local Postgres, DB-backed tests skip), 13 xfailed, 2 failed (the known `test_lifespan_*` pair). No new failures.