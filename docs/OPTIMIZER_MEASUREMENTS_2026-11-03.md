# Optimizer measurements, 2026-11-03

Measured on branch `chore/opt-measure` at main `c93010d` (no product code touched). Machine: Windows 11, 14 logical CPUs, OneDrive checkout (noisy).

## 1. Dead-code coverage of the firmed-boundary fallback

Command: `npx c8 --reporter=lcovonly --include='frontend/optimization/setup-scheduler.m*' node --test tests/modules/setup-scheduler.test.mjs tests/modules/optimization/order-rules-matrix.test.mjs tests/modules/optimization/tool-overflow-oracle.test.mjs`. c8 is installed locally. Coverage maps to the compiled `setup-scheduler.mjs` (no source map), so line numbers below are `.mjs` lines with the `.mts` line in brackets. Note: the run exited non-zero because of one failing test in `order-rules-matrix.test.mjs` (the `direct:spt` case at line 431, `allScheduled`, expected 3 got 1). It is unrelated to coverage and was observed on the unmodified tip; it is not investigated here.

| Function (`.mts` line) | `.mjs` line | Executed by any test? |
|---|---|---|
| `supportsBoundaryFallback` (4678) | 3678 | Called (gate evaluated), but never returns true: the guarded body is never entered |
| `candidateEntersBoundaryUncovered` (4696) | 3693 | NEVER (entry line count 0) |
| `boundaryFallbackComponentPlan` (4714) | 3700 | NEVER |
| `sptBoundaryFallbackOptions` (4771) | 3744 | NEVER |
| `dueDateBoundaryFallbackCursor` (4824) | 3785 | NEVER |
| `completeFinalBoundaryCandidate` (4901) | 3843 | NEVER |
| `compareBoundaryFallback` (4955) | 3887 | NEVER |

The consuming branch inside the line evaluator: the gate `if (!winner && run.termination === 'completed' && supportsBoundaryFallback(run))` at `.mts` 5674 (`.mjs` 4485) is evaluated 2,884 times; every line inside it through the end of the non-terminal fallback (`.mjs` 4486-4718, `.mts` ~5675-5933) has a hit count of 0. That covers all three `covered-firmed-boundary-fallback` push sites (`.mts` 5692, 5810, 5926). `if (!winner) {` at `.mts` 5934 is the first live code after the dead span.

Size of the deletable span: the seven helpers `.mts` 4678-~4978 (~300 lines) plus the branch body `.mts` 5675-~5933 (~260 lines); the plan's "~260" matches the branch only. Caveat for the lcov per-line counts: comment and brace lines inside those ranges show small nonzero counts (V8 block artefacts); the function-entry and statement lines are the reliable signal.

The test file already says why: `tests/modules/setup-scheduler.test.mjs` ~4004-4030 argues, from reading `candidateForSequence`, that `supportsBoundaryFallback` is "unconditionally false whenever `run.winner === null`", so these branches are "unreachable dead code today". The coverage run confirms it empirically for this test set. Line 4530 of that test says it is "Not a behavioral pin on `compareBoundaryFallback`/`dueDateBoundaryFallbackCursor`".

Is `'covered-firmed-boundary-fallback'` asserted anywhere? No. It appears only in `setup-scheduler.mts` (comments plus the three push sites) and in a comment at `optimize-ui.mts:1094` (a code list), plus their compiled twins. No file under `tests/` contains it. `tests/` mentions of `BoundaryFallback` are comments or the pinned `isSearchConclusive` predicate only (which is exported and live; keep it, or keep its test).

Caveat for the delete decision: this is three test files only. The full suite (`npm test`) and the headless/scale tests were not run under coverage. Before deleting, either run the full suite under c8 or accept the owner's reading that the gate is provably unreachable. If deleted, the `fallbackRuns`/`continuationRuns`/`deferredAcrossFirmed` locals at `.mjs` 4481-4484 and their uses at 4720-4725 become dead too, and `isSearchConclusive` loses its only production consumer.

## 2. Bench baseline (current main, `node scripts/bench-optimizer.mjs --no-deadline`, 3 runs)

Min wall seconds per row (candidates, late, digests identical across all 3 runs, so results are deterministic; only timing is noisy):

| Shape | min-changeover | due-date | spt |
|---|---|---|---|
| small | 0.07 | 0.07 | 0.06 |
| medium | 0.41 | 0.30 | 0.24 |
| wide | 0.56 | 0.50 | 0.32 |
| large | 1.83 | 1.83 | 1.38 |

Raw per-run walls (run1 / run2 / run3): small 0.12/0.10/0.07, 0.13/0.12/0.07, 0.15/0.12/0.06; medium 0.85/0.44/0.41, 0.98/0.45/0.30, 0.61/0.35/0.24; wide 1.39/0.99/0.56, 1.07/1.09/0.50, 0.66/0.47/0.32; large 2.40/4.31/1.83, 1.83/2.83/3.16, 2.10/1.38/2.44. Spread is up to 2.3x within a row (run 1 is slow from cold caches, OneDrive and other load), so use min-of-N and treat sub-20% deltas as noise. Digests for regression comparison: small `2b9fdad20f / 13d5723106 / 5dac57136c`, medium `04caaaeffd / 758e58284e / 078735ac90`, wide `2f4d48f037 / 7ef9ce3824 / 839c914d7b`, large `2a61d115c0 / 70f122b98a / ddb397b037`.

## 3. Is worker boot charged to the search budget? (V-X-05 vs V-M2-12)

Settled by reading: no, worker boot and compute-core load are NOT charged to the worker's search budget.

- `optimizer-worker-client.mts` 31-44 (`workerRequestWithRemainingDeadline`): the main thread converts the absolute `deadlineAt` into a relative `deadlineDurationMs = max(0, deadlineAt - performance.now())` and blanks `deadlineAt`. Line 91 computes it BEFORE the worker is spawned (line 93-ish `factory(...)`), so only time spent on the main thread before spawn is charged.
- `optimizer-worker.mts` 10-23 (`localizeOptimizerDeadline`): the worker rebuilds `deadlineAt = clock() + max(0, deadlineDurationMs)` using its own `performance.now()`. This runs inside `buildOptimizerWorkerResponse` (28-30, 34-37), called from the handler at lines 53-57 only AFTER `await corePromise` (line 55). `corePromise` is the dynamic `import()` of `nimbus-compute-core.js` (line 89).
- So the clock starts after worker script fetch/parse, module graph load, core import, and structured-clone receipt of the snapshot (deserialisation happens before `onmessage` fires). All of that boot time is outside the budget; the search gets the full duration. The wall time the user sees is therefore budget + boot + postMessage cost (+ result clone back).
- The client has no `setTimeout` or other wall-clock guard (`grep` of `optimizer-worker-client.mts` finds none), so nothing re-charges boot on the main side either. Pre-spawn main-thread work (snapshot build etc.) IS charged only if it happens before line 91 reads `performance.now()` against an already-stamped `deadlineAt`.
- Residual: V-X-05 (boot not charged) is correct; V-M2-12's concern (budget eaten by boot) does not apply to the worker path. The synchronous fallback (worker could not be created) uses the original absolute `deadlineAt`, so it is charged for everything since stamping. If an end-to-end figure is wanted, add `Optimize.workerBoot` PerfMonitor marks at (a) `factory()` call, (b) first line of `localizeOptimizerDeadline`, (c) first search iteration; none of that is needed to answer the budget question.

## 4. Other "Needs measurement" rows that a cheap script can settle (not done)

Cheap (a node script, no browser, no DB):
- V-M1-19 `process.exit(0)` after a multi-MB write: child writes a 20 MB JSON line then exits, parent reads slowly, compare bytes (Windows here; the plan wants Linux, so run in the container or WSL for a faithful answer).
- V-M1-20 apply timeout margin: per-step `ms` logging around `scheduler-plant-scale.test.mjs` versus the 60 s apply / `budget + 60` run limits.
- V-E1-22 DST subtraction in setup availability: derive on a US spring-forward date with `TZ=America/New_York` and compare the setup bar against the optimizer's placed setup.
- V-E1-21 live `source*` writes: snapshot, call `Calendar.workWindow` on a line with no calendar entry, snapshot again, diff.
- V-E1-08/20 setup availability rescans: PerfMonitor timing of `Setup.deriveObservation` on a 24/7 line plus blackouts (synthetic fixture).
- V-S3-04 / V-S4-22: placements-per-leaf from the existing bench (counter only).
- V-S3-20, V-S6-23/24, V-S7-27, V-S5-19: synthetic fixtures (2,000 blocks, one tool shared by 2,000 orders, 300 stacked orders, 130k infeasible edges) timed in node; V-X-16 is a read of the compute core to prove `scheduleKpis` does not mutate tasks.
- V-S7-29: Hard-tool fixture with a split order and a nested order, run through the validator chain.
- V-U3-20 and V-M1-21: node sequences (promote/enter/discard/undo in a sandbox test; derive A then B in one process vs B fresh).
- Magnitudes P2-1/2/3/5/6 and V-X-11/12/13/15: bench on a synthetic 5k-order plant plus a `buildRunContext` call counter; V-U3-17 heap snapshot of a retained 5k-order result via `v8.writeHeapSnapshot`.
- V-M2-21 / V-X-13(d) / V-E3-11 masterData-plants projection: timing `Optimize.snapshotSchedule` at roster scale is scriptable; the proposal itself stays unstarted until measured.

Not cheap:
- stateKey jsonb order (V-S4-02): needs a live Postgres (SQL one-liner plus `GET /setup/{plant}`); local DB is often down and `.env` may point at Azure.
- P0-20 Sandbox plant switch: owner browser repro.
