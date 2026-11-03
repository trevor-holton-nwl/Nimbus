# Optimizer measurements 2, 2026-11-03

Branch `chore/opt-measure2` at main `78d51bf`. No product code touched; the only repo file added is this one. Machine: Windows 11, Node 24, OneDrive checkout (noisy; medians of 9-15 runs for micro timings, so treat anything under ~20 ms as noise). Scratch scripts (not committed) are in the session scratchpad: `fixture.mjs` (fixture lifted from `scripts/bench-optimizer.mjs`), `m1.mjs`/`m1b.mjs` (run-context counts), `m2.mjs` (unit costs), `m3.mjs` (stringify costs), `m4.mjs` (worker payload), `m5.mjs` (DST), `m6.mjs` (live source writes), `m7.mjs` (scheduleKpis).

Fixture: 70 lines x 71 orders = 4,970 orders, one plant, weekday 06-22 / Sat 06-14 calendar, 2-3 blackouts per line, 8 colours (56 plant matrix rows) unless stated; the same plant re-run with 40 colours (1,560 rows) and 150 colours (22,350 rows) because matrix size is what the run-context build cost scales with. "Evaluate" below is `evaluateMinChangeover` then `fillPlanningGaps` (exactly the body of `Engine.evaluateSchedule`, which itself needs a live Store; the Store-free pair is what the bench uses).

## 1. P2-2 run-context reuse: not worth doing for performance

`runContextBuildCount()` (an existing test hook in `setup-scheduler.mts`) gives builds per phase; unit cost came from calling `buildRunContext` and `buildSetupResolutionIndex` directly on the 5k snapshot (300 calls each, warmed). `buildSetupResolutionIndex` runs exactly once per `buildRunContext` when a definition exists, so its count equals the build count.

| Matrix | builds in search (whole evaluateMinChangeover) | builds in gap fill | unit `buildRunContext` | of which `buildSetupResolutionIndex` | search wall | build share of search | gap-fill wall | build share of gap fill |
|---|---|---|---|---|---|---|---|---|
| 8 colours, 56 rows | 175 | 24-33 | 0.09 ms | 0.05 ms | 10.0-10.8 s | 16 ms = 0.15% | 1.4-1.55 s | ~3 ms = 0.2% |
| 40 colours, 1,560 rows | 347 | 21 | 1.45 ms | 1.24 ms | 11.7-12.2 s | ~500 ms = 4.1% | 1.45-1.53 s | ~30 ms = 2% |

Search is deterministic (8,960 candidates, `converged`) so the counts repeat exactly; the gap-fill count varies (24 vs 33) because that pass is budget-capped at about 1 s wall (builds per gap-fill line were not separately attributed). A 150-colour matrix would cost about 20 ms per build (extrapolated, not run end to end).

Verdict: not worth doing as a performance item. The build is a rounding error at realistic matrix sizes (0.15% at 8 states, 4% only at a 1,560-row matrix). The only remaining reason for P2-2 is correctness: step 1 of the plan (the `{...snapshot, tasks}` identity guard that also ignores `bounds.setup` and the date bounds, V-S1-04) is a guard hardening, not a speed-up, and can stand alone without the rebind/hoist steps.

## 2. P2-5 and P2-6: stale-check stringify and task-watch recanonicalisation

Replicated exactly: `validateCandidate`'s two `JSON.stringify` calls over the snapshot minus `readModelVersion`/`frozenHorizonEnd` (plus the `firmedIds` sort), and `optimize-ui.mts` `taskBaseline` (`canonicalTaskBaselineValue` + `JSON.stringify` per task, into a Map). Fixture tasks have 17 fields; the second row pads to 42 fields (text, numbers, Dates) as a guess at production rows.

| Task width | snapshot JSON | P2-5 stale check (2 stringifies) | one stringify | P2-6 one `taskBaseline` pass (current side of one `_revalidateTaskBaseline`) | both sides incl. Map compare |
|---|---|---|---|---|---|
| 17 fields | 2.2 MB | 107 ms | 46 ms | 52 ms | 97 ms |
| 42 fields | 5.4 MB | 385 ms | 159 ms | 56 ms | 155 ms |

- P2-5: `validateCandidateForApply` is called once per Apply on the main thread (`optimize-ui.mts` 2531; headless paths already pass `skipStale: true`). Cost is 0.1-0.4 s, once, per Apply, scaling with the whole read model (calendars, master data), not just tasks. Caching the baseline string would remove about half of it (one of two stringifies). Verdict: low value, not worth a staleness-safety change on its own. If done, the baseline-string WeakMap is the safe half; skipping sections is the risky half.
- P2-6: each task event while a preview is open costs about 52-56 ms of main-thread time for 5k tasks (one full recanonicalise-and-stringify; it is skipped when `Store.rev()` has not moved since the last verified check). One edit is invisible, but a burst of N events with distinct revs is N x ~55 ms: 20 events is about 1.1 s of jank. Verdict: worth doing only if bursts are real. Measured: 55 ms per event at 5k orders. Not measured: how many task events a realistic interaction emits (needs the browser). A microtask coalesce (one pass per tick) bounds any burst to one pass and is the cheap, low-risk half of the plan item; the per-id compare is optional.

## 3. P2-3 worker response payload

Built the real response shape (`candidate` without `validationContext`, `validation` from `serializeOptimizerValidation`) from the 5k evaluate result, then timed `structuredClone` (a proxy for postMessage serialise + deserialise) and `v8.serialize`.

| Matrix | full response | minus `setup` | minus `setup` and date maps | `setup` alone | date maps alone |
|---|---|---|---|---|---|
| 8 colours | 2,371 KB, clone 37 ms | 2,353 KB, 48 ms | 2,015 KB, 47 ms | 19 KB | 338 KB |
| 40 colours | 2,716 KB, clone 66 ms | 2,457 KB, 54 ms | 2,119 KB, 41 ms | 259 KB | 338 KB |
| 150 colours | 6,191 KB, clone 136 ms | 2,584 KB, 26 ms | 2,247 KB, 19 ms | 3,606 KB | 338 KB |

The candidate itself (4,970 patches, explanations, dispositions) is 2.0-2.2 MB and dominates; it is unavoidable. The date maps are ~340 KB (14-17% of the payload, about 10-20 ms of clone). Making them sparse (null entries dropped) saves little here because none are null in this fixture; an all-null map is still ~190 KB. `serializeOptimizerValidation` itself costs 14-17 ms. Timings are noisy (non-monotonic between rows), so only the 150-colour row, where `setup` is 58% of bytes and the clone drops from 136 to 26 ms, is a clear signal.

Verdict: not worth doing for pilot-sized matrices (8-40 states): saves about 0.3-0.6 MB and 10-25 ms against a 5-12 s run, under 0.5%. Worth doing only if a plant carries on the order of 100+ distinct states (22k plant rows, 3.6 MB); then it saves ~100 ms per response. Missing to settle that: the real row count of the largest pilot plant's matrix (needs the DB or an owner number). Do not do it speculatively; the validation-input risk in the plan outweighs the gain.

## 4. V-E1-22 DST subtraction in setup availability: not reproducible, drop

Ran `TZ=America/New_York` with a 24/7 line and plant (the only calendar shape where a setup can sit across 02:00), one machine with state A, order A1 then B1 needing a transition A->B, optimizer placing both, then `deriveSetupObservation` with the availability context on the placed result. Cases: spring-forward 2026-03-08 with setup 180 min starting 23:00 (crosses the gap), 90 min (ends 04:30 EDT), 400 min, and fall-back 2026-11-01 with 240, 30 and 360 min (crosses the repeated hour). In every case the optimizer gap between A1 end and B1 start equals the setup minutes in elapsed time (e.g. A1 ends 23:00 EST, B1 starts 03:00 EDT = 180 elapsed minutes), and the observed setup bar spans exactly that interval with `requiredMinutes == availableMinutes == setup_min`. The UTC control gives the same elapsed minutes. The derive uses absolute-millisecond subtraction and the optimizer also places in elapsed time, so they agree across both transitions. Caveat: not tested on a calendar with closed windows adjacent to 02:00 (a weekday 06-22 line cannot hold a setup across the DST hour anyway). Verdict: drop.

## 5. V-E1-21 live `source*` writes: confirmed, a real side effect

`Calendar.workWindow` on the live (non-detached) path calls `sourceLineWorkHours` -> `Store.ensureCalendar(line)` and `sourcePlantWorkHours` -> `Store.ensurePlant(plant)` (`engine.mts` 1016-1053), which write into `Store.calendars` / `Store.plants` directly. Experiment: Store with line L1 (has a calendar), LNEW (plant P1, no entry) and LX (plant NOP, no plants entry); snapshot the maps and `snapshotSchedule()` JSON, call `Calendar.workWindow('LNEW', monday)` and `('LX', monday)`, snapshot again.

- `Store.calendars` gained `LNEW` and `LX` (`{workHours: all-day 0-24 for every weekday, inherited: true}`); `Store.plants` gained `NOP` (default shift week, weekends null).
- `Store.rev()` did not move (6 -> 6) and no event was emitted, so nothing downstream is told.
- `JSON.stringify(snapshotSchedule())` differs before and after. That is the object `validateCandidate`'s stale check stringifies, so if a Gantt/KPI render calls `workWindow` for a line or plant that had no entry between the evaluation snapshot and Apply, Apply sees a different calendar section and reports `stale_candidate` with no real edit.
- `Calendar.nextAvailable` on an already-seeded line added nothing further (3 -> 3 keys).

Verdict: confirmed as mechanism. Not settled: how often production hits it, because hydration may already seed every line via `inheritPlantHours` (then `ensureCalendar` is a no-op). Missing: a logged-in browser check of whether any scoped line lacks a `Store.calendars` entry after load, or any plant in `Store.masterData.lines` lacks a `Store.plants` entry. Cheapest durable fix if needed: make the live source readers non-mutating (return the seed without storing), as the detached branch already does.

## 6. V-X-16 does `scheduleKpis` mutate tasks: no

Reading: `scheduleKpis` is in `frontend/platform/foundation.mts` 996 (not the compute core). It calls `countChangeovers` (builds fresh per-line arrays, sorts those, never the input array or the rows), reads `start_date`/`scheduledEnd`/`latenessHours`/`plantClock` (pure reads), then the injected utilization resolver. With a candidate snapshot, `Utilization.computeMatrix` `structuredClone`s tasks and the calendar/plant context before handing them to the compute core (so the core's `ensureCalendar`/`ensurePlant` default-seeding cannot reach live data); on the live path it passes the caller's task array to the core.

Executed check: 160 fixture tasks deep-frozen (any write throws in strict ESM), `Util.scheduleKpis(frozen, 14, snapshot, null)` and the no-snapshot call, plus `Utilization.computeMatrix` directly on the frozen tasks with and without snapshot: no throw, task array order and serialised content unchanged. The KPI peak read 0 only because the fixture schedule is in August and the plant-clock window starts today; the matrix itself computed (8 lines, max pct 0.91 and 1.22 on an August window). Verdict: no mutation of tasks (the one mutated surface is Store calendars/plants, item 5, on the live path only).

## Summary

| Item | Verdict |
|---|---|
| P2-2 run-context reuse | Not worth it for speed: 0.15% (8 states) to 4% (1,560-row matrix) of search; keep only the guard-hardening step as correctness |
| P2-5 stale-check stringify | 107-385 ms once per Apply; low value; baseline cache would halve it |
| P2-6 task watch | ~55 ms per task event at 5k orders; worth a microtask coalesce only if event bursts are real; burst size needs the browser |
| P2-3 payload | 0.3-0.6 MB / 10-25 ms at 8-40 states (under 0.5% of run); worth doing only for ~100+ state matrices (3.6 MB, ~100 ms); largest pilot matrix size is the missing number |
| V-E1-22 DST | Not reproducible; drop |
| V-E1-21 source* writes | Confirmed silent writes to Store.calendars/plants that change the snapshot JSON; production frequency unsettled (needs browser/Store inspection) |
| V-X-16 scheduleKpis | Does not mutate tasks |
