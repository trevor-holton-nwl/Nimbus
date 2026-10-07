# Optimizer Update — 2026-10-06

**Scope.** A performance and quality sweep of the NIMBUS optimizer as it exists on `main` today (HEAD `8de0414`, plus the uncommitted doc edits in the working tree). The three planner-facing modes (Min Changeover, Due Date, SPT), the preview flow that wraps them, and the pieces of the calendar and setup code they lean on. Remove Backlog is covered only where it shares code.

**Stance.** Improve what is there. No new solver, no new objective, no new UI. Every recommendation below is a change to an existing function, measured against the existing code with a throwaway benchmark harness (described in §3). Nothing in the repo was modified during this sweep; the harness and prototype live in the session scratchpad only.

**Status.** Findings and recommendations. No code changes have been made. **Owner decisions recorded 2026-10-07 and an F1–F4 implementation plan added: see Part 3.** Where Part 3 differs from Parts 1–2 (F3 scope, F4 shape, F6 placement), Part 3 wins.

---

## 1. Executive summary

The optimizer is architecturally sound: one detached snapshot in, one patch set out, a worker so the UI never freezes, hard date windows, never-freeze placement, and a validated Apply. The search *inside* that frame is where the time goes, and it is both slower and weaker than it needs to be, for four concrete reasons that are each cheap to fix:

1. **The wrong lines get the search budget.** The "exact" search is chosen by *how many distinct setup states* a line has (8 or fewer), not by *how many orderings* that implies. A line with 12 orders in 4 colors has 369,600 orderings; the search burns the whole plant's 20,000-iteration allowance on that one line, and every remaining line is laid out in priority-list order with no search at all. On a 70-line test plant, 63 of 70 lines got no search. (§4, F1)
2. **80% of the CPU rebuilds the same calendar.** Every time the search places one order it walks the calendar day by day from the cursor to the end of the horizon, allocating Date objects for each day, then re-sorts and re-merges the result. The free windows of a line never change during a run. A per-line index built once makes the same search 2.5× faster with byte-identical results. (F2)
3. **Min Changeover never starts from a due-date order.** Its seeds are setup-nearest, grouped, priority, and runtime. Its comparator is lateness-first, so it has nothing lateness-friendly to pick from. Adding the existing due-ordered seed took a 10-line test plant from 50 late orders to 2. (F3)
4. **The local search is 16 moves around the first order, once.** It explores only sequences that differ in position 0 or 1, then stops, leaving most of the budget unused. A real first-improvement pass (iterated, budget-shared per line) is a moderate change but needs F1, F2, F4 and F5 first, or it makes things worse (measured). (F6)

Measured on synthetic plants with the prototype (all of F1–F5 applied, same 5-second budget):

| Plant shape | Mode | Today | Prototype |
|---|---|---|---|
| 5 lines × 12 orders (pilot-like) | Due Date | 3.0 s, 2 of 5 lines unsearched, **7 late** | 0.2 s, all lines searched, **0 late** |
| 5 lines × 12 orders | Min Changeover | 3.4 s, 7 late, 1,290 setup min | 0.3 s, 0 late, 570 setup min |
| 10 lines × 36 orders | Due Date | 5.2 s (timed out), 9 of 10 lines unsearched, 60 late | 0.8 s, 1 late |
| 10 lines × 36 orders | Min Changeover | 5.2 s (timed out), 73 late | 1.3 s, 2 late |
| 70 lines × 8 orders (target scale) | Min Changeover | 2.4 s, 63 of 70 lines unsearched, 10 late, 23,490 setup min | 2.7 s, 0 late, 11,340 setup min |
| 70 lines × 30 orders (target scale) | Due Date | 6.4 s (timed out), 368 late, 32 left unplanned | 4.3 s, 0 late, 0 unplanned |

The lateness magnitudes are artifacts of random synthetic demand; only the comparisons matter. Full tables in Appendix C.

**Recommended order of work** (§5): F1 gate fix → F2 interval index → F4 iteration cap → F3 seed → F5 objective charge → F7 single-pass Min Changeover → F6 local search → F8/F9 trims. The first four are each under a day and are where almost all of the win is.

**Part 2 (added the same day)** designs a planner-facing **Deep search** option: up to one minute, runs in the background, notifies with a toast that opens the normal preview. Worth adding after the first four fixes, three to four days of work, built entirely from existing NIMBUS patterns. See Part 2 for the verdict, the screens, and the rules.

---

## 2. How the optimizer works today (orientation)

Read this once; every finding points back into it.

**Entry.** The Optimize dialog (`frontend/optimization/optimize-ui.mts`) collects plant, optional line subset, a date window (default: now to now + 28 days), and Respect firmed / Respect calendar. `OptimizerPreview.runWithPreview` (optimize-ui.mts:1316) takes a detached snapshot of the plant (`snapshotSchedule`, engine.mts:148), runs the chosen mode in a Worker with a 5-second budget, shows before/after KPIs, then runs the two alternate modes one after another (each with its own fresh 5 seconds) for the comparison table. Apply re-validates the candidate against a fresh snapshot and commits one `Store.updateMany`.

**Dispatch.** `Engine.runAndApply` (engine.mts:1929) builds the search bounds, folds running and frozen orders into the immovable set, and calls `Engine.evaluateSetupAware` (engine.mts:871). Plants with no active setup definition get a synthetic zero-cost matrix so the same evaluator runs for everyone. The result passes through `fillPlanningGaps` (setup-scheduler.mts:6574), a 1-second insertion pass for anything still queued.

**Evaluators** (`frontend/optimization/setup-scheduler.mts`). Due Date and SPT run `evaluateDueDateFirst` / `evaluateSptWithSetup`; Min Changeover (`evaluateMinChangeover`, line 5714) runs `evaluateDueDateFirst` **twice**, once as a due-date-first baseline and once with the min-changeover comparator, then keeps the better one. Lines are processed one at a time in alphabetical order, all sharing one `SearchBudget` (20,000 iterations, one absolute deadline).

**Per line.** `evaluateLineWithFirmedBoundaries` (line 4504) splits the line into fragments between immovable orders and calls `searchFragment` (line 3386) on each. `searchFragment` groups the fragment's orders by setup state and picks the search: `exactSearch` (line 2937, a depth-first enumeration of every ordering of the state groups) when the number of groups is at most 8, otherwise `greedySearch` (line 3140: a few deterministic seed orders plus 16 insertion and 16 swap moves each). Every candidate ordering is scored by `candidateForSequence` (line 2498), which simulates placing each order in turn through `placeWithSetup` (line 254) against the free calendar windows from `freeIntervalsFor` (line 2282).

**Scoring.** A candidate's score is an 8-wide vector (feasibility, priority score, late count, lateness minutes, −placed, setup minutes, uncovered edges, over-cap) plus a policy key, compared lexicographically in a mode-specific order (`compareCandidate`, `compareObjectiveFacts`). Min Changeover and Due Date compare lateness before setup minutes; the baseline mode ('due-date-first') compares the priority-list key before lateness.

**Finish.** `finalizeCandidate` (line 6413) assigns a disposition to every scoped order, validates (`validateCandidate`, line 6114), builds an incumbent from the current schedule, keeps whichever admits more urgent work, then recomputes the final objective facts.

---

## 3. How this was measured

A scratchpad harness (`bench.mjs`, `bench-bounds.mjs`, `bench-proto.mjs`, `make-proto.mjs`; not in the repo) builds a synthetic plant and calls the compiled evaluators directly, exactly as the unit tests do:

- Weekday hours 06:00–22:00, Saturday 06:00–14:00, Sunday closed; 2–3 four-hour blackout blocks per line.
- Orders of 0.5–8 h, random color from K colors, random due date inside the 28-day horizon, 80% already scheduled back-to-back from "now", 20% queued (Needs Planning).
- A full plant setup matrix (every color pair 30–120 minutes), a recorded current state per line, a color priority list.
- Four shapes: **small** 5×12/4 colors (pilot-like), **medium** 10×36/8 colors (the "machine-700" shape from the dispatch doc), **wide** 70×8/4 colors and **large** 70×30/6 colors (target plant scale per the root `CLAUDE.md`).
- Node 24, 14-core laptop, single runs; wall times are approximate (±10%). Deadline 5,000 ms and cap 20,000 iterations unless stated.

The prototype is a copy of the compiled `setup-scheduler.mjs` with four env-gated patches (index, gate, charge, seeds, plus an experimental local search). Equivalence was checked: with only the index enabled, every run produced the same candidate count, same winners and same objective totals as the unpatched module.

CPU profiles (`node --cpu-prof`) were aggregated by self time per function.

---

## 4. Findings

Ranked by expected value. Each one says what happens, a concrete example, why it matters, the evidence, the change, and the cost.

### F1 — The exact search is gated on state count, not ordering count, and it starves every other line  **(critical, cheap)**

**What happens.** `searchFragment` (setup-scheduler.mts, the `groups.length <= bounds.exactSearchThreshold` branch near line 3557, threshold 8 from engine.mts:556) chooses the depth-first exact enumeration whenever a fragment has 8 or fewer distinct setup states, regardless of how many orders are in those states. The number of orderings is N! / ∏(group sizes)!, so 12 orders in 4 colors is 369,600 leaves and 36 orders in 8 colors is astronomically more. The enumeration consumes one shared iteration per tree node, so the first such line eats the entire plant allowance (20,000), and every later line immediately reports `iteration-cap` and is laid out as a tail in priority-list-then-due order with no search.

**Example.** Small plant, Due Date mode: 3 of 5 lines searched, 2 laid out untouched, 7 late orders, 2.96 s. Wide plant (70 lines of 8 orders): 7 lines searched, 63 untouched. Medium plant, Due Date: **1** line searched, 9 untouched, 5.2 s, 60 late orders. The depth-first order also means the budget is spent permuting the *last* positions of the one sequence it does explore, which is the least valuable part of a setup-sequencing problem.

**Why it matters.** This is the single biggest reason both Changeover and Due Date come back slow *and* worse than SPT on lateness (SPT always uses the bounded heuristic and so covers every line). It also means the 20,000-iteration cap and the 5-second deadline are both being hit for a reason that has nothing to do with problem difficulty.

**Evidence.** Forcing the heuristic path for every fragment (`exactSearchThreshold: 0`) on the current code, no other change:

| Shape, mode | Current | Heuristic forced |
|---|---|---|
| small, Changeover | 2.9 s, 7 late, 1,290 setup min, 3/5 lines searched | 0.6 s, 0 late, 570 setup min, 5/5 |
| small, Due Date | 2.7 s, 7 late | 0.4 s, 0 late |
| medium, Due Date | 5.3 s, 60 late, 1/10 lines | 1.9 s, 1 late, 10/10 |
| wide, Changeover | 2.5 s, 10 late, 23,490 setup min, 7/70 lines | 4.6 s, 0 late, 11,370 setup min, 70/70 |

Repeated with two other random seeds with the same outcome (Appendix C). Raising the cap tenfold (200,000 iterations, 30 s) let the exact search converge on the small plant in 9.5 s with 750 setup minutes, still worse than the 0.6 s heuristic result.

**Change.** Keep the exact search for fragments where it is genuinely cheap and let everything else use the heuristic path. Compute the multiset leaf count (a 5-line helper) and use exact search only when it is at most ~500 leaves (about 6–7 distinct orders). Tested rule set: `groups.length <= 8 && leaves <= 500`. A budget-aware variant (leaves × 3 ≤ remaining iterations ÷ lines remaining) also worked but interacts badly with F4, so prefer the fixed cap. `SETUP_AWARE_EXACT_SEARCH_THRESHOLD` can stay as the outer guard.

**Cost.** Under half a day including tests. Tests that pin the exact/greedy choice: `tests/modules/setup-scheduler.test.mjs` around lines 1360, 1405, 1850 (exact traversal bounds), 320 and 1430 (heuristic seeds/local search), 3534 (shared budget); `engine.test.mjs` references the threshold twice. Expect a handful of fixtures to switch from exact to heuristic labels (`method`, `quality`, `exhaustive`).

### F2 — Free calendar windows are rebuilt from scratch for every placement  **(critical for speed, moderate effort, no behavior change)**

**What happens.** `candidateForSequence` places each order by calling `freeIntervalsFor` (setup-scheduler.mts:2282) from the current cursor to the horizon end. That function walks the calendar one day at a time (28 days by default), allocating several Date objects per day, intersecting line and plant hours, subtracting blackout blocks, and then `placeWithSetup` re-sorts and re-merges the result in `normalizedIntervals` (line 130). For a 36-order candidate that is roughly 1,000 day-steps and a few thousand allocations, repeated for every one of the thousands of candidates a search evaluates. The free windows of a line do not change during a run.

**Evidence.** CPU profile of a current-code run (small, Changeover): `freeIntervalsFor` 32%, `jointWindowForDay` 22%, `normalizedIntervals` 12% plus its lambda 6%, `lineBlocksFor`/`overlapBlocks`/`floorMinute`/`ceilMinute` ~6%, garbage collector 3%. About **79% of all CPU time** is building and normalizing the same interval list. The actual search and setup logic (`candidateForSequence` self time, `exactSearch`, `resolveSetup`, policy keys) is under 10%. The heuristic path profiles the same way (80%).

Prototype: build the merged free-interval list once per (plant, line) on first use, store it on the existing run context as two integer arrays (start ms, end ms), and serve each request by binary search plus clipping. Same search, same results, byte-identical candidate counts and objectives:

| Shape, mode (same iterations) | Current | Indexed |
|---|---|---|
| small, Changeover (iteration-capped) | 2.74 s | 1.05 s |
| wide, Changeover (iteration-capped) | 2.42 s | 1.13 s |
| small / medium / wide / large, SPT | 0.36 / 1.57 / 2.71 / 6.9 s | 0.17 / 0.68 / 1.11 / 4.4 s |

On the large plant SPT also went from 39 of 70 lines searched to all 70, because the same budget now covers more candidates.

**Change.** Add a `_freeIndex` map to `SetupRunContext` (built in `buildRunContext`, line 538) and make `freeIntervalsFor` consult it when a context is present; keep the day-walk as the builder and as the fallback for callers without a context. Validation and gap fill already go through the same function and benefit for free. Second step, worth doing in the same change: let `placeWithSetup` accept intervals that are already minute-aligned, sorted and disjoint and skip `normalizedIntervals` for them. After the index, `normalizedIntervals` and its helpers are the next 40% of the profile (§4 F8).

**Cost.** One to two days including the equivalence test (compare index output to the walk on seeded random calendars; there is already a test of that shape at `setup-scheduler.test.mjs:5261` for the availability prefix-max index).

### F3 — Min Changeover has no due-ordered seed, so its lateness-first comparator has nothing to choose  **(high, trivial)**

> **Dropped 2026-10-07 (Part 3, D1).** The owner wants Min Changeover to minimize setup inside the pull/push date limits, not to be lateness-first, so Part 3 Step 4 replaces this finding with a ranking change.

**What happens.** `heuristicSeedOrders` (setup-scheduler.mts:2019) seeds Min Changeover with setup-nearest, grouped-by-state, priority order and runtime order. Its comparator (`compareObjectiveFacts` for 'min-changeover', line 6768) ranks late count, lateness minutes and worst lateness before setup minutes. The 32 local moves around a setup-grouped seed cannot repair lateness, so the mode ends up with a schedule that is setup-tight but late, and then its own comparator cannot prefer anything better because nothing better was generated. Due Date mode seeds with due order and slack order, which is why it does well once F1 is fixed.

**Example.** Medium plant, with F1 and F2 applied: 50 late orders and 10,440 setup minutes. Adding the due-ordered seed (one array entry, the seed is already computed): **2 late orders**, 20,880 setup minutes. That is the lateness-first trade the mode is supposed to make. Small plant: unchanged (already 0 late). Large plant, with the budget it needs (F7): 3 late versus 371.

**Change.** Prepend `due` to the Min Changeover seed list; consider `slack` as well (it is only computed for Due Date today). One line plus one test fixture at `setup-scheduler.test.mjs:320`.

### F4 — The 20,000-iteration cap is now the binding limit, and it is shared by the whole plant  **(high, trivial)**

**What happens.** `SETUP_AWARE_ITERATION_CAP` (engine.mts:557) was a safety net for the days when one iteration cost a day-walk. With F2, an iteration on a 36-order fragment costs ~75 µs and on an 8-order fragment ~20 µs, so 20,000 iterations is 0.4–1.5 s of a 5 s budget. The cap is shared across all lines, so on a 70-line plant each line gets ~285 iterations before the plant is cut off.

**Evidence.** Wide plant, Changeover, with F1–F3 and F5: cap 20,000 → `iteration-cap` after 1.2 s, 23 of 70 lines untouched, 7 late; cap 200,000 → converged at 2.7 s, 0 late, 11,340 setup minutes (the best wide result in the sweep). `greedySearch` also consumes an iteration *before* checking its `seen` set (line 3204), so duplicate neighbors burn budget.

**Change.** Either make the cap a per-line share (`cap × linesInScope`, which keeps the stack-safety intent) or raise it to ~200,000 and let the wall-clock deadline be the real limit. Move the `seen` check ahead of `consumeSearchIteration`. Tests at `setup-scheduler.test.mjs:1405` and 3534 pin the shared-cap behavior and will need their expectations adjusted, not their intent.

### F5 — Fragment scoring ignores orders the sequence failed to admit  **(medium now, prerequisite for F6)**

**What happens.** `candidateForSequence` counts lateness only for orders it placed. An order that does not fit before the fragment end goes to `unadmitted` and is tail-placed or queued later, but at scoring time it is neither late nor missing: `-patches.length` (scheduled count) is compared *after* setup minutes in Min Changeover. The final objective (`objectiveFactsForCandidate`, line 6823) does charge queued orders as late with lateness = horizon end − due. So the search and the final verdict disagree, and any search strong enough to exploit the gap will learn to leave hard orders out.

**Evidence.** With an iterated local search (F6) and no charge, medium Changeover went from 50 to **76** late orders while setup minutes fell from 10,440 to 5,880: the search was dropping late orders to buy setup. With the charge (count each unadmitted order as late by max(0, fragment end − due), a valid lower bound for any later placement), the same search produced **48** late and 9,570 setup minutes. The seeds-plus-32-moves path of today is too weak to trigger the pathology, which is why nobody has seen it.

**Change.** Add the lower-bound charge for `unadmitted` in `candidateForSequence` just before `deferredAdjacencyFailure` (line 2770). Ten lines. It is a behavior change for Min Changeover and Due Date only in cases where a sequence leaves orders unadmitted, which is exactly where today's answer is wrong.

### F6 — The "local search" is 16 insertion moves and 16 swaps around the first order, run once  **(medium, moderate effort, do after F1/F2/F4/F5)**

**What happens.** `boundedLocalMoveSequences` (setup-scheduler.mts:2033) generates insertion moves in `from`/`to` order and stops after 16, and swaps in `left`/`right` order and stops after 16. For any fragment longer than ~5 orders every generated neighbor differs from the seed only in position 0 (or 1). It runs once per seed; the best neighbor's own neighbors are never explored. The 2,000-candidate convergence window and the deadline are effectively never reached by the heuristic path: it gives up after ~165 candidates per fragment.

**Evidence.** Prototype: evaluate all seeds, take the best, then first-improvement over the full insertion and swap neighborhoods, repeating until a pass finds no improvement, with each fragment limited to an equal share of the remaining time and iterations across the lines (and passes) still to run.

| Shape, mode (F1–F5 applied) | Without local search | With local search |
|---|---|---|
| small, Due Date | 0.19 s, 0 late, 1,320 setup min | 1.0 s, 0 late, 1,080 setup min |
| medium, Due Date | 0.8 s, 1 late (5,011 min) | 5.0 s, 0 late |
| medium, Changeover (+F3) | 1.3 s, 2 late (5,657 min), 20,880 setup | 5.0 s, 1 late (616 min), 19,920 setup |
| wide, Changeover | 2.7 s, 0 late, 11,340 setup | no gain (iteration-bound) |
| large, Changeover | 371 late (budget-starved, see F7) | 359 late |

It is a genuine quality lever on medium-sized fragments and neutral elsewhere, but only with budget fairness: without the per-line time share the first lines ate the deadline and later lines were tail-placed (measured: medium Due Date went from 1 late to 5 late). It also costs the whole budget by design, so the preview gets slower (up to the 5 s) on plants that previously finished in 1 s.

**Change.** Replace the fixed 16/16 generator with an iterated first-improvement loop over the full neighborhoods, bounded by (a) the shared `SearchBudget`, (b) a per-fragment slice = remaining time ÷ (lines remaining × passes remaining), and (c) a per-fragment move cap. Keep the two-state adjacent-swap path as is. Report `localMoveCount` as today. Tests at `setup-scheduler.test.mjs:320` and 1430 pin the current bounded behavior and will need rewriting around "strict improvement, budget-bounded" rather than "16 moves".

### F7 — Min Changeover runs two complete searches that share one budget  **(high at target scale, moderate effort)**

**What happens.** `evaluateMinChangeover` (setup-scheduler.mts:5714) runs `evaluateDueDateFirst` as a baseline and again with the min-changeover comparator, both over every line, sharing the 5 s and the iteration cap. The baseline exists as a safety reference, but `finalizeCandidate` already builds an incumbent from the current schedule and keeps it when it admits more urgent work, so the baseline search is partly redundant. Its comparator ('due-date-first') also ranks the priority-list key before lateness, so it is not the due-safe reference its name suggests.

**Evidence.** Large plant (70×30): Due Date alone converges in 4.3 s with 0 late orders. Min Changeover with the same fixes times out at 5 s with 371 late; given 10 s it converges at 8.4 s with 3 late. The second pass is exactly the missing half.

**Change.** Simplest: one search, two incumbents. The candidate pass already visits every sequence; keep a second winner per fragment under the due-date-first comparator (one extra `compareCandidate` call per candidate) and build the baseline result from those winners. The accept/reject arbitration at the end stays as it is. Alternative, even simpler but a bigger behavior change: drop the baseline pass and rely on `finalizeCandidate`'s incumbent comparison. Prefer the first. Tests: `setup-scheduler.test.mjs:3534` and 3685 (budget sharing and starvation guard).

### F8 — Post-index hot spots: re-normalization, structuredClone, Date allocation  **(medium, cheap, do with F2)**

After F2 the profile is: `normalizedIntervals` 27% + lambda 12% + `floorMinute`/`ceilMinute` 5% (re-normalizing already-normalized intervals, see F2's second step), `freeIntervalsFor` 12% (now mostly Date allocation for the clipped slice), `candidateForSequence` 7%, GC 4%. On the large plant `structuredClone` adds 8.7% and `timestamp` 3%.

- `applyPatchesToSnapshot` (setup-scheduler.mts:5870) deep-clones every patched task and its changes on every call; it is called per line in gap fill, in validation, in objective facts and in the preview. A shallow `{ ...task, ...changes }` is sufficient because the contract already says consumers treat tasks as read-only; only `scheduleSegments` needs a fresh array.
- `timestamp(task.original_end_date)` allocates a new Date on every call and is called inside comparators and per task per candidate. Memoize due-ms, start-ms and runtime-minutes per task on the run context (there are already memo maps for state, ranks and date bounds).
- `planningDefect` → `allowedPlanningWindow` does a `masterData.plants.find` plus Date math per task per candidate; memoize per task.
- `urgencyOrder` (line 5987) is a full sort with a heavy comparator and is invoked by `admissionKey` (line 6740) for **every candidate**; compute a per-fragment urgency rank once (as `exactSearch` already does) and build the key in O(n).
- `compareCandidate` for Min Changeover/SPT allocates two `fragmentObjectiveFacts` objects and a terms array per comparison; minor, but free to fix.

Together these are a further ~2× on the search loop at target scale. None change results.

### F9 — The preview boots three Workers and clones the snapshot three times per run  **(medium, cheap)**

`runOptimizerPreview` (optimizer-worker-client.mts:48–50) creates a fresh module Worker for every candidate and terminates it when done. Each boot loads the compute core plus the whole engine/scheduler graph (~0.6 MB of JS) and receives its own structured clone of the snapshot (1.2 MB of JSON at the large shape). The two alternates (`runNextAlt`, optimize-ui.mts:1557) run strictly one after the other, each with a fresh full 5-second budget (optimize-ui.mts:1534), so a comparison table can take 10 extra seconds on a busy plant.

**Change.** Keep one warm Worker per preview session and terminate only on abort (the runId check already handles stale responses). Give alternates a smaller fixed budget (they are a KPI comparison, not the plan the planner applies). Since lines are independent, the two alternates could also run concurrently in two Workers on a multi-core machine. Keep the synchronous fallback.

### F10 — Lines are independent, but a plant run is strictly serial  **(structural, moderate, target-scale lever)**

Every mode loops lines alphabetically (`orderedLines`, setup-scheduler.mts:5348 and 5537) sharing one budget. Nothing in the search crosses lines; the only cross-line facts (distribution separation) are computed after the fact. At 70 lines the per-line share of 5 s is ~70 ms, which is why the large shapes time out even after F1–F5.

**Change (later, after F1–F7).** Partition the selected lines across N Workers (the request contract already carries `lines`), run them concurrently, and merge: patches concatenate, `termination` folds through `worseTermination`, counts add. Validation and gap fill stay single-pass on the merged result. With four Workers the large shape fits in the existing 5 s. This is the only item here that touches the UI/worker plumbing beyond a few lines; keep it for when a 50+-line plant is actually onboarded.

### F11 — Observability gaps  **(low, cheap)**

- The Worker's `PerfMonitor` buckets (`Engine.evaluateSchedule`, `Engine.runAndApply`) live in the Worker realm and never reach the Admin "Thread" tab; the main thread only sees `Optimize.evaluate.primary` (which includes Worker boot and clone). Return the Worker's buckets in the response and merge them.
- `SearchDiagnostics` has `seedCount`/`localMoveCount` but not per-line coverage. A `linesSearched` / `linesTailPlaced` pair (what the harness derived from explanation codes) would have made F1 visible in the preview months ago. Cheap to add in the per-line loop.
- The explanation list grows with every candidate's failure entries even with `suppressExplanations`; on the large shape the final `explanation` array is thousands of entries. Not a time problem; a memory and readability one.

### F12 — autoReflow and the legacy calendar path skip the run cache  **(low)**

`Engine.autoReflow` (engine.mts:2608) wraps only its split-policy branch in `Calendar._beginRun`; the default 'never' branch (engine.mts:2703) calls `Calendar.placeWithSetup` → `Calendar._freeIntervals` per peer, which walks 90 days and re-parses every blackout block each call. Only the alert auto-fix path calls `autoReflow` today (insights/services.mts:449), so this is a latency nit, not a user-facing freeze. Wrap both branches.

### F13 — Checked and not a problem

- **Apply-time staleness check** serializes the whole snapshot to JSON twice (`validateCandidate`, line 6114). Measured at ~10 ms for 2,100 tasks / 1.2 MB. Fine; leave it.
- **Setup resolution index** (`buildSetupResolutionIndex`) and the Phase 1a memo maps (state, ranks, date bounds, day windows, line blocks) all work as described; `resolveSetup` is ~1–2% of the profile.
- **Gap fill** stays within its 1 s budget (0.7–1.1 s at the large shape, 2–20 ms elsewhere) and is correctly excluded from `searchComplete`.
- **The 'converged' / `limitReached` semantics** behave as documented; the harness never saw a converged run reported as a cutoff or vice versa.
- **Earlier memory notes** that `setup-scheduler.mts` contained NUL bytes and that the 2026-08 speedup branch was unmerged are both stale: the file is clean and the convergence/index/deadline work is on `main`.

---

## 5. Recommended sequence

Each step is independently shippable and testable with the scoped command in `frontend/optimization/CLAUDE.md`.

| Step | Change | Effort | Expected effect |
|---|---|---|---|
| 1 | F1: gate exact search on multiset leaf count (≤ ~500) | ½ day | Every line gets searched; Due Date and Changeover stop timing out on normal plants; large quality gain |
| 2 | F2: per-line free-interval index on the run context; skip re-normalization of indexed intervals | 1–2 days | 2.5× faster search, identical results; SPT covers all lines at target scale |
| 3 | F4: iteration cap per line (or ~200k); check `seen` before consuming an iteration | ½ day | Removes the new binding limit after step 2 |
| 4 | F3: add the due-ordered seed to Min Changeover | ½ day | Min Changeover becomes due-safe in practice (50 → 2 late on the medium shape) |
| 5 | F5: charge unadmitted orders at fragment level | ½ day | Search objective agrees with the final objective; required before step 7 |
| 6 | F7: single-pass Min Changeover (two incumbents from one search) | 1–2 days | Halves Min Changeover cost; large plants fit the 5 s budget |
| 7 | F6: iterated first-improvement local search with per-line budget share | 2 days | Further lateness/setup gains on 20–40-order fragments |
| 8 | F8, F9, F11: allocation trims, warm Worker, smaller alternate budgets, worker perf buckets, per-line coverage diagnostics | 1–2 days | Snappier preview; the next-level profile |
| 9 | F10: per-line Worker fan-out | 2–3 days | Target-scale plants (50–70 lines) within budget; do when such a plant is onboarded |
| 10 | Part 2: Deep search option (background run up to 60 s, toast with Review, parked result) | 3–4 days | Planners keep working during long runs; extra time becomes better plans once steps 1–3 (and ideally 7) are in |

**Deliberately not recommended.** A different algorithm (MIP/CP, tabu, genetic): the current seeds + local search structure is the right shape for per-line sequence-dependent setup with a lexicographic objective, and the measured gap is budget misuse, not algorithm choice. Cross-line reassignment, labor capacity, precedence: documented roadmap items, out of scope. Changing the objective tiers (for example letting setup savings outrank small lateness): a product decision, not a performance one; the existing 'throughput' evaluator with its savings/slip thresholds already exists for that conversation. Touching the day-integrity/legacy walk: it is not on the planner path.

---

## 6. Verification plan

- **Equivalence for F2/F8:** a seeded-random test comparing indexed `freeIntervalsFor` to the day-walk over random calendars and blackouts (same shape as the existing prefix-max index test, `setup-scheduler.test.mjs:5261`), plus a run-level assertion that candidate count and objective totals match with the index on and off.
- **Behavior for F1/F3/F4/F5/F6/F7:** update the pinned expectations in `tests/modules/setup-scheduler.test.mjs` (the heuristic/exact labels, seed counts, shared-cap tests listed under each finding) and add one end-to-end case per finding at the small shape (5×12/4 colors) asserting all lines searched and zero late orders, which the prototype achieves in every mode.
- **Performance gate:** keep a throwaway harness like the one described in §3 (it can be reconstructed from this document) and record, per step, wall time and lines-searched for the four shapes. Acceptance: no shape slower than today, small/medium/wide converge within budget, large Due Date converges within 5 s after step 6.
- **Live check after deploy:** the Admin "Thread" tab's `Optimize.evaluate.primary` p50/p95 for a real plant before and after; the preview's search diagnostics (`termination`, `iterationsUsed`, and the proposed `linesSearched`).

---

---

# Part 2 — Background deep search (planner option)

**Added 2026-10-06 (same day), on the owner's question:** "Is it worth adding a selection that runs in the background for up to one minute and notifies via an interactive pop-up?"

## 2.1 Verdict

**Yes, worth adding, as a companion to Part 1, not a substitute for it.** Today the five-second budget is mostly wasted (F1, F2), so giving the current search a minute buys little: the exhaustive search on a pilot-sized plant was given ten times its normal allowance and still came back worse and sixteen times slower than the quick path. Once the Part 1 fixes land, extra time does pay, in exactly the cases planners feel: many-order lines (the iterated local search used its whole budget on the 36-order test plant and still had improvements to find) and 50–70-line plants (Min Changeover's two passes needed 8.4 s on the 70×30 shape).

**One minute is enough.** After the fixes, every tested shape converges in 0.2–8.4 s, so a 60-second ceiling is roughly seven times the slowest measured case. The ceiling is a cap, not a duration: the search stops as soon as it converges, so most deep runs will notify within ten seconds. Longer ceilings are not useful; the longer a run takes, the more likely the planner has moved something in the meantime, which makes the result view-only (see 2.5).

**Effort: three to four days**, because almost every piece already exists: the Worker that runs the search off the main thread, the request field that carries a time budget, the toast with an action button, the What-If pattern of turning a context-bar button into a status indicator, the saved optimizer defaults, and the preview's stale-detection. The only real engineering is separating "compute the preview" from "show the preview" so a result can be parked and opened later.

**Sequencing: after F1–F4** (so the minute is spent on a useful search; today the 20,000-iteration cap would stop a deep run after about two seconds anyway), and ideally together with F6, which is what turns extra time into better schedules.

## 2.2 What the planner experiences

1. In the Optimize dialog there is a new **Search** row under Strategy: a dropdown with two choices, **Quick** (about 5 seconds, shows the preview right away; the default) and **Deep** (up to 1 minute, runs in the background and notifies you). A one-line hint under the dropdown explains the choice, exactly like the Strategy hint does today. The choice is remembered with the planner's other optimizer defaults.
2. With Deep selected, the Run button reads **Start deep search**. Clicking it closes the dialog immediately. No preview modal opens, and nothing is blurred or blocked.
3. The **Optimize** button in the scheduling context bar becomes the status indicator while the search runs, the same way the What-If button turns into "Scenario ON": it reads **Optimizing · 0:42** with a mono timer, counting up toward 1:00, and, once the Worker reports progress, **Optimizing · line 23 of 70**. Clicking it reopens the dialog in its "in progress" state with one action, **Cancel deep search**.
4. When the search finishes, a toast appears top-right, the standard solid Signal Info toast with an action button: **"Deep search finished for P1: 0 late orders, 570 setup minutes. Review"** (the numbers are the same KPI facts the preview shows). The toast stays 20 seconds; it is the pop-up. Its **Review** button opens the usual Optimization impact preview with Apply and Discard, identical to the quick path.
5. If the toast is missed, nothing is lost: the Optimize button reads **Result ready** with the small count badge the alert bell uses, and the Optimize dialog shows a **Result ready: Review / Discard** row until the planner acts. The result is parked, not applied; nothing changes on the schedule until Apply.
6. If the planner moved orders while the search ran, the toast says so (**"Deep search finished for P1. The schedule changed while it ran, so this result is view-only. Review"**), the preview opens with its existing stale banner, and Apply is disabled with the existing message "Run optimization again before applying." This is the same protection the quick preview already has; it only matters more here because a minute is long enough to drag something.

Concrete example: a planner at a 60-line plant picks Deep at 09:00:00, keeps fixing an overlap alert on line 12, and at 09:00:07 the toast says the search found a plan with two fewer late orders. They click Review, read the comparison, click Apply. Total attention cost: one click more than today, with no waiting.

## 2.3 Design direction (per PRODUCT.md and DESIGN.md)

- **Register:** product, Restrained. No new component vocabulary, no new colors, no new surface. The feature is one dropdown row, two button states, one toast variant and one dialog row, all built from existing tokens and classes.
- **Scene:** a scheduler in a plant office, daylight, mid-task, glancing at the band between drags. The feedback has to be legible at a glance and never block the Gantt. That rules out a modal "progress" dialog and rules in the context-bar button and a toast.
- **Anchors:** the existing What-If mode (button-as-state plus banner), the existing unsaved-count pill in the command band (`#schedule-unsaved`), and the alert-bell count badge. The deep search borrows those three, nothing else.
- **Color rule:** the in-progress and ready states live on a `.seg-btn` in the light content area, so they use text and badge treatments, not a blue fill. In progress: Ink Navy label, Mute Steel Blue mono timer. Ready: Signal Info text with the `.badge` count (soft-tint badge = status, per the Toasts / Badges rule). The completion toast is the solid `info` toast with the standard `.toast-action` button. Cancel in the dialog is a ghost button; Review in the dialog is the navy `.btn-primary` (content-area CTA).
- **Typography:** the timer and the line counter are machine-generated numbers, so they render in JetBrains Mono (the Mono-Means-Machine rule); everything else is Control-size Public Sans like the rest of the dialog.
- **Motion:** none added. The toast keeps its slide-and-fade; the button label changes instantly; the timer ticks once a second with no animation. Reduced-motion users see exactly the same thing.
- **Accessibility:** the toast stack is already `role="status" aria-live="polite"`, so the completion message is announced; the action button is a real `<button>`. The Optimize button's `aria-label` and `title` change with its state ("Deep search running, 42 seconds, click to cancel" / "Deep search result ready, click to review"). The dropdown has `aria-describedby` on its hint, as the Strategy select does. Contrast is unchanged because no new colors are introduced.

## 2.4 Screens and states

**Optimize dialog, new Search section** (between Strategy and Options, same `.opt-section` / `.opt-section-key` / `.opt-section-ctrl` layout):

```
Search    [ Quick · about 5 seconds            ▾ ]
          Shows the preview as soon as the search finishes.

Search    [ Deep · up to 1 minute, in the background ▾ ]
          Runs in the background while you keep working and
          notifies you when the result is ready. Most runs finish
          well under a minute.
```

Rules: hidden (and forced to Quick) when Strategy is Remove Backlog, because that mode is a repair pass, not a search, using the same `_applyModeOptions` hook that already disables options per mode. Disabled with the hint "A deep search is already running for P1. Cancel it to start another." while a deep run is active (one deep run per session; starting a Quick run meanwhile is allowed and does not disturb the deep one).

**Run button:** "Run Optimization" (Quick) / "Start deep search" (Deep). After the click: dialog closes at once; no spinner modal.

**Context-bar Optimize button states:**

| State | Label | Treatment | Click |
|---|---|---|---|
| Idle | 📈 Optimize | today's `.btn-optimize` | opens the dialog |
| Running | ⏳ Optimizing · `0:42` | mono timer, `title` explains, `aria-busy="true"` | opens the dialog in "in progress" state |
| Running, with progress | ⏳ Optimizing · `line 23 of 70` | mono counter | same |
| Ready | 📈 Result ready `1` | `.badge` count like the alert bell, Signal Info text | opens the preview |
| Ready, view-only | 📈 Result ready `1` (title: "schedule changed; view-only") | same badge, warn-tinted title only | opens the preview with the stale banner |

The button is visible only on the Scheduling tab (existing behavior). On other tabs the toast still fires; the dialog row and the button state are there when the planner returns.

**Optimize dialog, "in progress" state** (replaces the body when a deep run is active for the selected plant):

```
⏳  Deep search running on P1 · Min Changeover · 0:42 of 1:00
    Keep working; you will be notified when it finishes.
                                      [ Cancel deep search ]
```

**Optimize dialog, "result ready" row** (shown above the Window section when a parked result exists):

```
📈  Deep search result ready for P1 · finished 09:00:07
    0 late orders · 570 setup minutes · 5 of 5 lines searched
                                      [ Discard ]  [ Review ]
```

**Completion toast** (solid `info`, 20 s, one action): "Deep search finished for P1: 0 late orders, 570 setup min." + **Review**. View-only variant: "Deep search finished for P1. The schedule changed while it ran, so this result is view-only." + **Review**. Cancelled: a plain 1.5 s info toast "Deep search cancelled." Failed: the existing error toast wording with "Deep search failed: <message>".

**Preview modal:** unchanged. Opening a parked result is the same `_render` with the same Apply / Discard footer, the same KPI comparison, the same finalists table, and the same stale banner when applicable.

## 2.5 Rules for the awkward cases

- **Schedule edits during the run.** Detected the same way the quick preview detects them today (`taskBaseline` comparison against the plant's tasks). A changed baseline makes the parked result view-only: Review works, Apply does not, and the stale message tells the planner to run again. No attempt is made to "re-base" the result onto the new schedule; that would be a new algorithm.
- **Plant switch during or after the run.** The result stays parked and tagged with its plant. Review first switches the header plant selector back to that plant (the normal plant load), then opens the preview; the baseline check decides whether it is still applyable. The dialog's "result ready" row names the plant so there is no ambiguity.
- **Second run.** One deep run per session. Starting a Quick run while a deep run is active is allowed; a new deep run requires cancelling the active one. Opening a Quick preview does not discard a parked deep result; the parked result survives until Review+Apply, Discard, or sign-out.
- **What-If (sandbox) session.** A deep run started inside a What-If session belongs to it. Leaving the session (apply or discard) cancels a running deep search and discards a parked one, with a short toast, because the snapshot it was computed from no longer exists.
- **Page reload or sign-out.** The result lives in memory only and is lost. Accepted for the first version; persisting a candidate across reloads would mean storing a full snapshot and is not worth it.
- **Alternates (Plan B/C).** The deep job computes them too, after the primary, with the quick budget each, so the comparison table is complete when the toast fires. The whole job is capped at 60 s: primary up to 50 s, then alternates while time remains; a missing alternate just leaves its column out, as today.
- **Remove Backlog.** Not offered in Deep (see 2.4).
- **Tab in the background.** The Worker keeps running; the toast appears when the planner returns. Browser-level notifications (the Notification API) are deliberately not part of this version: they need a permission prompt and most planners keep NIMBUS in the foreground.

## 2.6 Engineering changes (file by file)

| Area | Change |
|---|---|
| `frontend/index.html` (Optimize dialog, `#modal-optimize`) | New `.opt-section` "Search" with `<select id="opt-search-select" class="input">` and `<p id="opt-search-hint" class="opt-strategy-hint">`; a "result ready" row container above Window; the "in progress" body variant. Run button label is set from code as it is today. |
| `optimize-ui.mts` — `OptimizeDialog` | `_search: 'quick' \| 'deep'` state, listener like `_initStrategySelectListener`, saved/loaded through the existing `optimizerDefaults` pref (add `search` to `OptimizerDefaults` here and `OptimizerDefaultsPref` in `shell/application-shell.mts`). `run()` branches: Deep calls `OptimizerPreview.startBackground(mode, opts)` instead of `showLoading` + `runWithPreview`. Render the in-progress / result-ready states from `OptimizerPreview.background` on `open()`. |
| `optimize-ui.mts` — `OptimizerPreview` | The one real refactor: split `runWithPreview` into `evaluateForPreview(mode, opts, { deadlineMs, signal, onProgress })` (pure async: snapshot, primary, KPIs, explanation, alternates; returns a `PreviewResult` object and touches no DOM) and `present(result)` (what the second half of `runWithPreview` does today: set the `_snapshot`/`_candidate`/`_preKpis`… fields from the result, start the task watch, `_render`). `runWithPreview` becomes evaluate-then-present. New: `startBackground` (evaluate with a 60 s budget, park the result, fire the toast, update the button), `openParked()` (present the parked result, switching plant first if needed), `cancelBackground()`, `discardParked()`. The existing `_workerAbortController` / `_runSeq` race guards carry over unchanged. |
| `optimize-ui.mts` — context-bar button | A small `OptimizeButtonState` helper that rewrites the `.btn-optimize` label, `title`, `aria-label`, and badge from the background state, mirroring how `SandboxAdapter` rewrites `.sandbox-btn`. One `setInterval` for the timer while running. |
| `optimizer-worker-client.mts` / `optimizer-worker.mts` | No contract change needed for the budget: `deadlineDurationMs` already carries the remaining budget to the Worker. Optional progress: the Worker posts `{ runId, progress: { linesDone, linesTotal } }` at most twice a second; the client exposes it through `onProgress`. |
| `setup-scheduler.mts` | Optional progress hook only: the per-line loops in `evaluateDueDateFirst` / `evaluateSptWithSetup` call `bounds.onLineComplete?.(index, total)` if supplied. Nothing else; the deep budget arrives through the existing `deadlineAt`. Prerequisite from Part 1: F4, otherwise the iteration cap ends a deep run after about two seconds. |
| `engine.mts` | None. `SETUP_AWARE_DEADLINE_MS` stays the Quick budget; Deep passes an explicit `deadlineAt`, which `runAndApply` already honors. |
| `styles.css` | `.btn-optimize.is-running` / `.is-ready` (label color, mono timer span, badge reuse); the dialog's two extra states reuse `.opt-section`, `.opt-strategy-hint`, `.btn`, `.btn-ghost`, `.btn-primary`. No new tokens. |
| Locales (`de/en/es/fr/pt.js`) | `ui.opt_search_label`, `us.opt_search_quick`, `us.opt_search_deep`, `tip.opt_search_quick`, `tip.opt_search_deep`, `tip.opt_search_busy`, `btn.start_deep_search`, `btn.cancel_deep_search`, `btn.opt_review`, `ui.opt_bg_running`, `ui.opt_bg_running_sub`, `ui.opt_bg_ready`, `ui.opt_bg_ready_sub`, `toast.opt_deep_ready`, `toast.opt_deep_ready_stale`, `toast.opt_deep_cancelled`, `toast.opt_deep_failed`, `toast.opt_deep_discarded_sandbox`. The locale-completeness test pins all five files. |
| Tests | `tests/modules/optimization/optimize-ui.test.mjs`: pref round-trip, Run routing by search mode, parked result present / discard, stale-on-change, plant-switch-then-review, sandbox exit discards, one-deep-run rule. `optimizer-worker.test.mjs`: budget pass-through for 60 s, optional progress message. Locale completeness. Existing `runWithPreview` tests keep passing because its external behavior is unchanged. |

## 2.7 Effort, risk, impact

| | |
|---|---|
| Effort | 3–4 days: 1 day evaluate/present split, 1 day control + pref + button state + toast + parking rules, ½ day styles and locales, ½–1 day tests and doc updates. |
| Risk | Low to medium. The split of `runWithPreview` is the only non-trivial change, and it sits under 1,500 lines of existing tests. Everything else reuses shipped patterns. The main product risk is a planner applying a minute-old result after editing; the existing baseline check already blocks that. |
| Impact | Planners at large plants stop waiting on the modal and get a better plan when the search can use the time. Pilot-sized plants will mostly see the toast within seconds, so the feature costs them nothing. The Quick path and the preview are untouched. |
| Depends on | Part 1 steps 1–3 (F1, F2, F4). Best with step 7 (F6). |

## 2.8 Not recommended

A progress bar with percentages (the search has no honest percentage; the line counter is honest), a separate notification center or inbox (the button state plus the dialog row already hold the one parked result), auto-applying a deep result (never; Apply stays an explicit click), and a "run every N minutes" scheduler (a different feature with different staleness problems).

---

---

# Part 3 — Decisions and F1–F4 implementation plan (2026-10-07)

## 3.1 Owner decisions (settled, don't re-ask)

| # | Question | Decision | What it means in practice |
|---|---|---|---|
| D1 | What does Min Changeover promise? | **Least setup time, inside the date limits.** *(Revised 2026-10-07; this replaces the first answer, "on-time first".)* Due date is not an objective. It matters only through the plant's pull-forward floor and push-forward limit. | **F3 is dropped.** Min Changeover's ranking changes (Step 4): setup minutes move above lateness, and lateness becomes a tie-breaker only. The due-date-ordered baseline search is removed. Lateness can rise where it saves setup, which is intended. |
| D2 | Where does the stronger local search (F6) run? | **Deep search only.** | Quick keeps today's bounded 16/16 neighborhood and stays fast (pilot plants ~0.2 s after F1/F2). F6's iterated first-improvement loop is enabled only when the run is a Deep run (Part 2), and that gives Deep its reason to exist. §5 step 7 moves into Part 2's scope. |
| D3 | F4 cap shape | **Per-line share.** | The plant-wide iteration cap becomes `SETUP_AWARE_ITERATION_CAP × lines in scope`. See 3.3 Step 3 for why this sizes the pool rather than slicing it, and why that is enough until F6. |
| D4 | Validate on a real plant before F1–F4? | **No; synthetic is enough.** | Gate on the committed benchmark script (D6) plus the existing unit suite. After deploy, compare the Admin "Thread" tab's `Optimize.evaluate.primary` p50/p95 on the pilot. |
| D5 | F3 and the `throughput` evaluator (they share one seed list) | ~~Min Changeover only.~~ **Moot: F3 dropped (D1).** | Seed lists are unchanged for both modes. `throughput` is untouched by this work. |
| D6 | Benchmark harness | **Commit a small script.** | `scripts/bench-optimizer.mjs`, one file, not part of `npm test`. Reusable for F5–F10 and Deep tuning. |
| D7 | Part 2 defaults (one deep run per session, in-memory parking lost on reload, Remove Backlog excluded, toast only and no browser notifications) | **Accepted as written.** | Part 2 still waits for F1–F4. |
| D8 | Plant with no push-forward limit configured | **No limit means no limit.** | Min Changeover may place an order anywhere in the planning window. Plants that care set `max_push_forward_days` in master data. No system default, no dialog hint. |
| D9 | An order that can't fit inside its pull/push window | **Keep today's behavior: place it, flag it.** | The pull-forward floor stays a true hard floor (placement is clamped). The push-forward limit stays the top-ranked "over cap" tier: avoided whenever any in-window plan exists, but as a last resort the order is placed past the limit and counted, per the never-freeze rule. |
| D10 | Tie-break when setup minutes are equal | **Priority list, then lateness.** | Min Changeover's ranking: hard errors → orders admitted (count) → over cap → uncovered transitions → **setup minutes** → priority list → late count → late minutes → worst lateness → instability → sequence key. |
| D11 | The due-date-ordered baseline search inside Min Changeover | **Removed.** | One search per run. The final "keep the current schedule if the new plan schedules fewer orders" check stays, by **order count**, not urgency. This also makes F7 unnecessary for Min Changeover. |

## 3.2 Gaps found in review (fold into the steps below)

- **G1. F1 has a second gate site.** `setup-scheduler.mts:3423` repeats `groupsByState.size > bounds.exactSearchThreshold` to label an adjacency-issue fragment `completed` vs `converged`. Both sites must use the same predicate or labels drift.
- **G2. F3's seed list is shared with `throughput`** (`setup-scheduler.mts:2018`). Resolved by D5.
- **G3. The sweep's harness lived in a session scratchpad and is gone.** Resolved by D6 (Step 0).

## 3.3 Steps

One feature branch, `feature/optimizer-f1-f4`, cut from `main`. Steps 1–4 all edit `frontend/optimization/setup-scheduler.mts`, so they run **sequentially** (one agent at a time, one commit per step). Step 0 touches only a new file and runs in parallel with Step 1. Delegation follows the standing rule: Haiku for pinned-spec mechanical edits, Sonnet for logic-heavy ones; the orchestrator writes no code.

Scoped checks after every step: `npm run build`, `node --test tests/modules/setup-scheduler.test.mjs tests/modules/engine.test.mjs`, `npm run lint`, then the benchmark (Step 0) on all four shapes. Full `npm run test` once at the end.

### Step 0 — Benchmark script (Haiku, parallel with Step 1)

- New file `scripts/bench-optimizer.mjs`. It imports the compiled `frontend/optimization/setup-scheduler.mjs` the way the unit tests do (set `globalThis.NimbusComputeCore = require('../frontend/nimbus-compute-core.js')` first) and builds the synthetic plants from §3: weekday 06:00–22:00, Saturday 06:00–14:00, Sunday closed, 2–3 four-hour blackouts per line; orders 0.5–8 h, random color, random due date inside a 28-day horizon, 80% scheduled back-to-back from "now", 20% queued; full color-pair matrix 30–120 min; a recorded current state per line; a color priority list. Seeded PRNG (mulberry32) so runs repeat.
- Shapes: `small` 5×12/4, `medium` 10×36/8, `wide` 70×8/4, `large` 70×30/6. Modes: `min-changeover`, `due-date`, `spt`. CLI: `node scripts/bench-optimizer.mjs [--shape small] [--mode due-date] [--seed 42]`, default all × all.
- Prints one row per run: shape, mode, wall ms, termination, candidates, lines searched / tail-only (derived from explanation codes, as the sweep did), late count, late minutes, setup minutes.
- Not wired into `npm test`. Lint must pass (scripts are in the lint set).
- **Acceptance:** on unmodified `main`, the numbers are in the same ballpark as Appendix C's "current code" table (exact match is not expected, since the generator is rebuilt from the description). Record the baseline table in the PR description.

### Step 1 — F1: gate exact search on ordering count (Sonnet)

- Add `function exactSearchEligible(groupSizes: ReadonlyArray<number>, bounds): boolean` returning `groupSizes.length <= bounds.exactSearchThreshold && multisetLeafCount(groupSizes, cap) <= cap`, where `cap = bounds.exactSearchLeafCap ?? EXACT_SEARCH_LEAF_CAP` and `EXACT_SEARCH_LEAF_CAP = 500`. `multisetLeafCount` computes N! / ∏ kᵢ! incrementally as a product of binomials and returns `cap + 1` as soon as the running value exceeds `cap`, so it never overflows.
- Add optional `exactSearchLeafCap?: number` to `DueDateFirstBounds`. Engine does not set it (the default applies). Tests that deliberately pin exact traversal pass `exactSearchLeafCap: Infinity` instead of having their intent rewritten.
- Use the predicate at **both** sites: the `run` choice near line 3559 and the adjacency-issue label at line 3423 (G1). SPT's `mode === 'spt'` short-circuit at 3423 stays.
- Update `bounds` validation near line 5241 to accept the new optional field (finite positive or `Infinity`).
- Tests: expect fixtures that ran exact search on many-order fragments to switch labels (`method`, `quality`, `exhaustive`). For each one, decide: pinning exact traversal → add `exactSearchLeafCap: Infinity`; pinning end-to-end outcome → update the expectation. Add one test: a fragment of 12 orders in 4 states with `exactSearchThreshold: 8` takes the heuristic path; 5 orders in 3 states takes exact.
- **Acceptance:** small shape, Due Date and Changeover: all 5 lines searched, no `iteration-cap`.

### Step 2 — F2 (+ F8's first bullet): per-line free-interval index (Sonnet)

- Add `_freeIndex: Map<string, { starts: Float64Array; ends: Float64Array; from: number; through: number }>` to `SetupRunContext` (key: plant + NUL + line, same reuse-across-plants reason as `_lineBlocks`). Initialize empty in `buildRunContext`.
- In `freeIntervalsFor`, when `ctx` is present and `ctx.respectCalendar !== false`: build the index on first use by running today's day-walk once over the run's full span (from the run's `planningStart` floored to local midnight, through `horizonEnd`), store the merged, minute-aligned, disjoint intervals, and serve each request by binary search plus clipping to `[from, through]`. **If a request falls outside the indexed span, fall back to the day-walk unchanged.** That keeps validation and gap-fill calls with wider spans exact. Without `ctx`, behavior is untouched.
- Second half (F2's "skip re-normalization"): give the returned array a marker (for example a non-enumerable symbol property, or a separate internal entry point) that `placeWithSetup` checks so it skips `normalizedIntervals` for intervals already minute-aligned, sorted and disjoint. It still applies the `earliestStart` clip. External callers of the exported `placeWithSetup` keep full normalization.
- Tests: a seeded-random equivalence test beside the prefix-max index test (`setup-scheduler.test.mjs:5261`) comparing indexed vs day-walk output over random calendars, blackouts and `[from, through]` windows, including ones outside the indexed span and across a DST change. Plus one run-level assertion: candidate count and objective totals identical with the index on and off (expose a test-only off switch, for example `bounds.disableFreeIndex`).
- **Acceptance:** byte-identical benchmark results to Step 1 (same candidates, winners, objectives), with wall time down ~2× or more on capped shapes.

### Step 3 — F4: per-line cap share + `seen` before consume (Haiku; pinned spec)

- `engine.mts`, the setup-aware bounds at line ~2151: `iterationCap: SETUP_AWARE_ITERATION_CAP * Math.max(1, linesInScope)`, where `linesInScope` = `opts.lines.length` when a subset is given, else the count of distinct lines among the snapshot's plant tasks. Leave the Remove Backlog bounds (line ~1973) unchanged. Comment why: the cap is a stack-safety net, and after F2 one shared 20,000 starves later lines on big plants.
- **Why scaling the pool counts as a per-line share here:** after F1 no exact search can exceed ~500 leaves, and the bounded heuristic tops out around 165 candidates per fragment, so no single line can drain a pool sized at 20,000 per line. True per-fragment slicing is only needed once F6's open-ended local search exists, and F6 already specifies its own per-fragment slice (Deep only, per D2).
- `setup-scheduler.mts` `greedySearch.evaluate` (line ~3201): move the `seen` check (`key` build, `seen.has`, `seen.add`) **above** `consumeSearchIteration`, so duplicate neighbors don't burn budget. The deadline check stays first.
- Tests: `setup-scheduler.test.mjs` 1405, 3534–3551 (shared-cap behavior) exercise the scheduler directly with tiny caps and should keep passing. Fix any that counted duplicate-neighbor iterations. Add an `engine.test.mjs` assertion that a 3-line run's bounds carry `3 × SETUP_AWARE_ITERATION_CAP`.
- **Acceptance:** wide shape, Changeover: 70/70 lines searched, `converged`, under 5 s.

### Step 4 — Min Changeover: least setup inside the date limits (Sonnet) *(replaces F3, per D1/D8–D11)*

Due date leaves Min Changeover's objective. It stays only as the pull-forward floor (already a hard placement clamp, `notBeforeFor`, line ~2572) and the push-forward "over cap" tier (unchanged, D9). Four edits, all in `setup-scheduler.mts`. `due-date`, `spt`, `throughput` and the `due-date-first` baseline mode must be byte-identical before and after.

1. **Ranking** (`compareObjectiveFacts`, `'min-changeover'` branch, line ~6778). New term order (D10): `hardErrors, overCap, uncoveredEdges, setupMinutes, policyKey, lateCount, latenessMinutes, maxLatenessMinutes, scheduledCount↓, instabilityMinutes, sequenceKey`. `scheduledCount` stays as a term, but admission (item 2) already settles "more orders scheduled" before any of these.
2. **Admission by count, not urgency.** Today three places rank "which orders got scheduled" in due-urgency order, so a plan that schedules an earlier-due order beats one that schedules a later-due order even when both schedule the same number. For `'min-changeover'` only, compare **how many** orders were admitted:
   - fragment level: `compareCandidate` (line ~2447), where `admissionKey` (line 6740) is an urgency-ordered 0/1 string. For min-changeover, compare the count of `'0'`s (more admitted wins), then fall through to the terms in item 1;
   - finalize level: `finalizeCandidate`'s incumbent check (line ~6459–6461, `admitted(...)` urgency string). When `bounds.strategy === 'min-changeover'`, compare queued counts instead. Other strategies are untouched;
   - the arbitration inside `evaluateMinChangeover` disappears with item 3.
3. **Remove the due-date baseline search** (D11). `evaluateMinChangeover` (line 5714) runs only `evaluateDueDateFirst(..., 'min-changeover')` and returns it. The final keep-the-current-schedule check in `finalizeCandidate` (item 2) remains the safety net. Keep the explanation code `min-changeover-due-safe` → rename to `min-changeover-selected` (grep locales/UI for the old code first; if anything displays it, keep the old code). Termination folding simplifies to the single run's.
4. **Seeds unchanged.** `heuristicSeedOrders` keeps `[setupNearest, grouped, policy, runtime]` for min-changeover. No due seed (F3 dropped).

- **Guard against "drop orders to save setup."** Ranking setup above lateness is safe only because admission (item 2) is compared first: a plan that leaves an order unscheduled can never win on setup minutes. F5's planned "charge unadmitted as lateness" therefore does **not** apply to min-changeover. Its count-based admission already covers it (see 3.4).
- Tests: `setup-scheduler.test.mjs` 3534–3551 (`evaluateMinChangeover` with `iterationCap: 2`, sized for two passes) and 3685 (starvation guard across baseline + candidate) need re-expectation for one pass. Any fixture asserting Min Changeover picks the on-time plan over the lower-setup plan flips by design. Update it and name the decision in the test title. Add three focused tests: (a) two plans of equal admission, the lower-setup one wins even though it is later; (b) a plan that admits one fewer order loses even with far less setup; (c) an order with a pull-forward floor is never placed before it, and a push-forward limit is respected whenever an in-window plan exists.
- **Acceptance:** benchmark, Changeover mode, every shape: setup minutes ≤ Step 3's figure; lateness may rise (intended); admitted-order count ≥ Step 3's; no shape slower. Due Date and SPT rows identical to Step 3.

### Step 5 — Close-out (orchestrator)

- Full `npm run test`, lint, typecheck. Benchmark table for all shapes × modes before (Step 0 baseline) and after, in the merge commit or PR body.
- Doc hygiene: one sentence each in `docs/architecture/optimizer-dispatch.md` and `frontend/optimization/CLAUDE.md` (exact search gated on leaf count; per-line cap scaling; Min Changeover = least setup inside the date limits, admission by count, single search). Also correct the optimizer dialog's Min Changeover hint text if it promises on-time delivery (check the `tip.*` locale keys in all five locales).. Mark F1–F4 as shipped in this doc's §5 table.
- Review pass (`/code-review` on the branch) before merging into `main`. Deploy via `promote-azure` is a separate, explicitly requested step.

## 3.4 Revised roadmap after these decisions

1. **F1–F4** (this plan, ~2.5–3.5 days).
2. **F5** (unadmitted charge), next, **for Due Date only.** Min Changeover's count-based admission (Step 4) already stops the search from buying setup by dropping orders. **F7 is retired:** Step 4 removes the second search outright.
3. **F8, F9, F11**: trims, warm Worker, diagnostics (`linesSearched`).
4. **Part 2 Deep search, now including F6** (D2): F6's iterated local search runs only when `bounds.deep === true` (or an equivalent flag carried by the Deep request). F5 remains its prerequisite.
5. **F10**: when a 50+-line plant is onboarded.

---

## Appendix A — Context

**Brief.** "Improve the performance of the optimizer. Comprehensive sweep, findings in `Optimizer_Update_10_06.MD`, senior architect plus OR scientist lens, stay within improving what is there; new functionality allowed but nothing overbaked; faster/better while still good." Follow-up the same day: "Is it worth adding a selection that runs in the background for up to one minute and notifies via an interactive pop-up? Thoughts on effort; if agreed, add comprehensive UI updates in line with the current NIMBUS design." Part 2 answers that; the design choices there (dropdown with hint rather than a checkbox, button-as-state rather than a new notification center, in-memory parking, no browser notifications, one deep run per session, Remove Backlog excluded) are asserted defaults, open to override.

**Questions I would have asked, and the assumption taken.**

- *Which plant shapes matter most?* Assumed the pilot (a few lines, ~10–15 orders each) is what planners see today and the 50–70-line plant from the root `CLAUDE.md` is the target; both are in the measurements.
- *Is the 5-second budget a product constraint?* Assumed yes; every recommendation keeps it. The findings show it is ample once it is spent on the right things.
- *May Min Changeover trade lateness for setup?* Assumed no (the code is explicit that it is due-safe); F3 and F5 make that promise real rather than relaxing it.

**Rejected alternatives.**

- Replacing the search with a constraint solver or metaheuristic library: not needed, and the current contract (detached snapshot, patches, never-freeze, explanations) would have to be rebuilt around it.
- Raising the iteration cap and deadline alone: measured, 10× cap on the small shape still gave a worse and 16× slower answer than the heuristic path.
- Keeping the exact search but pruning (branch-and-bound with incremental prefix simulation): sound, but the lexicographic objective with a non-monotone scheduled-count tier makes correct bounds fiddly; the leaf-count gate gets the same practical outcome for a tenth of the work. Revisit only if someone needs provably optimal tiny fragments faster.
- Per-line Worker fan-out first: the biggest structural lever, but F1–F7 deliver most of the benefit without touching the plumbing; fan-out is sequenced last.

**Doc hygiene.** `docs/architecture/optimizer-dispatch.md` and `frontend/optimization/CLAUDE.md` describe the heuristic search as "bounded insertion/swap neighborhoods" and the exact search as gated on the threshold; both will need a sentence updated after steps 1, 4 and 7. `docs/MIGRATION.md` already lists the duplicate unknown-state diagnostics and `_setupExclusions` scoping as deferred; nothing here contradicts them.

## Appendix B — Things learned along the way

- `frontend/optimization/setup-scheduler.mts` and `orders.mts` no longer contain NUL bytes; the earlier Grep blind-spot note is stale.
- The 2026-08-22 optimizer-speedup work (convergence window, run-context memos, deadline control) is merged into `main`; the memory note saying it was unmerged is stale.
- The Optimize dialog's internal preset label is `'2w'` but the default end date is now + 28 days (`optimize-ui.mts` run options); the search horizon used in the measurements is therefore 28 days.
- `PerfMonitor` records from inside the Worker never reach the main thread; the Admin "Thread" tab's optimizer numbers include Worker boot and snapshot clone and exclude the search breakdown.
- The compiled `.mjs` twins can be imported directly in Node for benchmarking exactly as the unit tests do (`globalThis.NimbusComputeCore = require('frontend/nimbus-compute-core.js')` first). The repo's `.mjs` files are gitignored build output; the scratchpad prototype is a patched copy that rewrites three relative imports to absolute paths.
- `greedySearch.evaluate` consumes a budget iteration before checking its duplicate-sequence set, so duplicate neighbors cost budget.
- Alphabetical line order plus one shared budget means line naming decides which lines get optimized when the budget is short; that was invisible because nothing reports per-line coverage.
- The synthetic harness builds overloaded plants on purpose (random due dates inside the horizon with back-to-back incumbents), so absolute lateness figures are not meaningful; relative comparisons on the same seed are.
- `Toast.show` already accepts an action (`{ label, run }`, rendered as `.toast-action`), so an "interactive pop-up" needs no new component; the earlier note that toasts are text-only is stale. Toasts auto-dismiss and are evicted past three visible, which is why Part 2 parks the durable state on the Optimize button and in the dialog rather than in the toast.
- The Worker request contract already carries `deadlineDurationMs`, so a 60-second budget is a parameter, not a plumbing change.
- The preview's stale detection (`taskBaseline` comparison plus `canApply`) is the mechanism that makes a long background run safe to apply later; nothing new is needed there.
- *(2026-10-07 review)* Re-verified against `main` at `e6567a0` (docs-only since `8de0414`, so no optimizer drift): threshold 8 and cap 20,000 at `engine.mts:556-557`; Min Changeover seeds `[setupNearest, grouped, policy, runtime]` shared with `throughput` (`setup-scheduler.mts:2018`); the 16/16 bounded neighborhood; `consumeSearchIteration` before the `seen` check in `greedySearch.evaluate`; the baseline + candidate double search in `evaluateMinChangeover`.
- *(2026-10-07)* `exactSearch` enumerates individual orders across state groups (an occurrence can be picked independently, e.g. BLUE → RED → BLUE), so F1's multiset leaf count N!/∏kᵢ! over group sizes is the right measure.
- *(2026-10-07)* `freeIntervalsFor` depends only on calendars and blackout blocks, not on other orders' placements, which is what makes a per-run index safe. Callers can ask for spans outside the run horizon (validation, gap fill), hence the out-of-span fallback in Step 2.
- *(2026-10-07)* Due urgency enters Min Changeover in four places, not one: the lateness-above-setup ranking (`compareObjectiveFacts`), the urgency-ordered `admissionKey` compared before every tier in `compareCandidate`, the due-date-first baseline search plus its urgency-string arbitration in `evaluateMinChangeover`, and the urgency-string incumbent check in `finalizeCandidate` (shared by all strategies). Step 4 handles all four.
- *(2026-10-07)* The pull-forward floor is a true hard clamp on placement (`notBeforeFor`). The push-forward limit is a scored tier (`SCORE_OVER_CAP`) ranked just below hard errors: avoided whenever possible, but not absolute. The owner kept that (D9).
- *(2026-10-07)* Many `setup-scheduler.test.mjs` fixtures set `exactSearchThreshold: 6` with `iterationCap: 100000` (around lines 3584–3871) to pin exact-search behavior. An optional `exactSearchLeafCap` lets them keep their intent without being rewritten.

## Appendix C — Measurements

Current code, engine path (`evaluateSchedule`), 5 s deadline, 20,000-iteration cap, seed 42. "Lines" = lines with at least one searched placement / lines laid out as a tail only.

| Shape | Mode | Wall | Termination | Candidates | Lines | Late | Late min | Setup min |
|---|---|---|---|---|---|---|---|---|
| small 5×12/4 | Changeover | 3.36 s | iteration-cap | 5,850 | 3 / 2 | 7 | 11,137 | 1,290 |
| small | Due Date | 2.96 s | iteration-cap | 5,850 | 3 / 2 | 7 | 16,762 | 1,560 |
| small | SPT | 0.29 s | converged | 600 | 5 / 0 | 2 | 4,502 | 2,160 |
| medium 10×36/8 | Changeover | 5.23 s | deadline | 4,609 | 3 / 7 | 73 | 568,288 | 7,740 |
| medium | Due Date | 5.24 s | deadline | 4,792 | 1 / 9 | 60 | 390,060 | 10,890 |
| medium | SPT | 1.46 s | converged | 1,280 | 10 / 0 | 66 | 615,321 | 21,090 |
| wide 70×8/4 | Changeover | 2.42 s | iteration-cap | 6,498 | 7 / 63 | 10 | 27,010 | 23,490 |
| wide | Due Date | 2.25 s | iteration-cap | 6,498 | 7 / 63 | 9 | 24,204 | 23,250 |
| wide | SPT | 2.50 s | converged | 7,989 | 70 / 0 | 7 | 16,297 | 27,630 |
| large 70×30/6 | Changeover | 7.18 s | deadline | 5,031 | n/a | 370 | 2,604,715 | 69,840 |
| large | Due Date | 6.41 s | deadline | 5,271 | n/a | 368 (+32 unplanned) | 1,982,858 | 69,030 |
| large | SPT | 6.38 s | deadline | 5,226 | 39 / 31 | 359 | 2,643,704 | 90,090 |

Prototype, direct evaluator path, same bounds unless stated. "All" = index + gate (leaf cap) + charge, plus the due seed for Changeover; "LS" adds the iterated local search.

| Shape | Mode | Variant | Wall | Termination | Lines | Late | Late min | Setup min |
|---|---|---|---|---|---|---|---|---|
| small | Changeover | heuristic forced only | 0.58 s | converged | 5 / 0 | 0 | 0 | 570 |
| small | Changeover | exact, 200k cap, 30 s | 9.53 s | converged | 5 / 0 | 0 | 0 | 750 |
| small | Changeover | all | 0.27 s | converged | 5 / 0 | 0 | 0 | 570 |
| small | Due Date | all | 0.19 s | converged | 5 / 0 | 0 | 0 | 1,320 |
| small | Due Date | all + LS | 1.04 s | converged | 5 / 0 | 0 | 0 | 1,080 |
| medium | Changeover | index + gate (no due seed) | 1.19 s | converged | 10 / 0 | 50 | 363,245 | 10,440 |
| medium | Changeover | all | 1.27 s | converged | 10 / 0 | 2 | 5,657 | 20,880 |
| medium | Changeover | all + LS | 5.06 s | deadline | 10 / 0 | 1 | 616 | 19,920 |
| medium | Due Date | all | 0.81 s | converged | 10 / 0 | 1 | 5,011 | 21,660 |
| medium | Due Date | all + LS | 5.04 s | deadline | 10 / 0 | 0 | 0 | 20,640 |
| wide | Changeover | all, 20k cap | 1.16 s | iteration-cap | 47 / 23 | 7 | 18,982 | 17,580 |
| wide | Changeover | all, 200k cap | 2.74 s | converged | 70 / 0 | 0 | 0 | 11,340 |
| wide | Due Date | index + gate | 1.38 s | converged | 70 / 0 | 0 | 0 | 16,620 |
| large | Due Date | index + gate | 4.29 s | converged | 70 / 0 | 0 | 0 | 126,390 |
| large | Changeover | all, 5 s | 6.17 s | deadline | 70 / 0 | 371 | 1,947,116 | 32,190 |
| large | Changeover | all, 10 s, 200k cap | 8.42 s | converged | 70 / 0 | 3 | 7,353 | 119,850 |
| small / medium / wide / large | SPT | index only | 0.17 / 0.68 / 1.11 / 4.39 s | converged | all searched | unchanged on small–wide | | |

Other seeds (current code vs heuristic forced): seed 7 small Changeover 3.1 s / 0 late / 1,230 setup vs 0.6 s / 0 late / 1,020; seed 7 medium Due Date 5.3 s / 86 late vs 2.0 s / 3 late; seed 99 small Changeover 2.8 s / 2 late / 1,590 vs 0.5 s / 0 late / 990; seed 99 medium Due Date 5.3 s / 65 late vs 1.9 s / 5 late.

CPU profile, current code, small Changeover (2.76 s sampled): `freeIntervalsFor` 32.1%, `jointWindowForDay` 22.0%, `normalizedIntervals` 12.0%, interval lambda 6.3%, `candidateForSequence` 5.7%, GC 3.0%, `lineBlocksFor` 2.1%, `overlapBlocks` 1.5%, `floorMinute` 1.4%, `ceilMinute` 1.3%, `placeWithSetup` + `place` 2.5%, `resolveSetup` 1.1%, `exactSearch` 0.7%.

CPU profile, prototype (index + gate + charge), medium Changeover (1.25 s sampled): `normalizedIntervals` 26.8%, interval lambda 12.0%, `freeIntervalsFor` 11.7%, `candidateForSequence` 6.9%, GC 4.4%, `floorMinute`/`ceilMinute` 5.0%, `policyKeyForTask` 2.5%, `resolveSetup` 2.5%, `placeWithSetup` 2.0%, `timestamp` 1.8%. Large Changeover adds `structuredClone` 8.7% and `timestamp` 3.0%.
