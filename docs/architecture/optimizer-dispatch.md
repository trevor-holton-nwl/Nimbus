# Optimizer Dispatch — `Engine.runAndApply` internals

Full mechanics behind the summary in `CLAUDE.md` → Key Patterns → Optimization. Read this before touching `Engine._dispatchDayIntegrity`, `Engine._sortTerms`, or anything that reads `Store.priorityRankMaps`.

## Modes

`Engine.runAndApply(mode)` where `mode ∈ {'spt', 'changeover', 'backlog'}`. These are **dispatching heuristics, not true optimization** — there is no changeover-cost matrix, no finite-capacity constraint, and finish-to-start precedence is not consulted.

- `'spt'` sorts by run-hours ascending across the whole horizon (via `Engine._sortTerms` + a greedy back-to-back placement walk, jumping fixed orders and calendar/blackout-closed windows, with a 200-iteration guard that logs via `ErrorLog.warn` if it fails to converge) — this is the only mode still on that legacy single-sort walk.
- `'changeover'` routes through `Engine._dispatchDayIntegrity`.

## Day-integrity dispatch (`changeover`)

A calendar day's own orders (its "native" set — orders whose `Util.sapDueDate` falls on that day) get first refusal on every fragment of their day before any other order is considered, so a native order can never be pushed to a *later* day while its own day still has room for it (it can only be pulled *earlier* by an emptier prior day, or bumped by a genuinely overdue arrival from a prior day that needs the room).

The dispatch walks calendar days forward; per day it ranks the remaining queue into 4 tiers:
0. native (due today)
1. carry (overdue from a prior day, due-date-ascending)
2. pull-in (due later, color-first then due-date)
3. floater (no due date)

Then it runs the same admit-then-resequence two-phase placement as the old bucket mechanism, bounded to that day's window so nothing bleeds past midnight (or shift close, under `respectCalendar`) into a day it doesn't belong to:

- **Phase 1** admits ranked candidates by concrete `fitsAt` simulation (fixed order / blackout / shift close are hard obstacles — a day can fragment into multiple sub-bucket admission passes).
- **Phase 2** resequences each admitted fragment by the full `_sortTerms` term list (configured priority fields first, then the intrinsic `FORM_SIZE`/`MATERIAL_NUMBER`/run-hours tail) and places it.

An unplaced native simply stays in the queue — on the next day's ranking pass its due day is now in the past, so it becomes tier-1 carry automatically; no separate bookkeeping.

A day-integrity guarantee is **per-fragment best-effort**: a mid-day fixed order or blackout can still fragment a day so a native fits no single fragment even though the day's total hours would have covered it — that native spills to the next day.

If an order's `RUN_TIME` can never fit any day's capacity at all (a data problem), the dispatch would otherwise spin forever advancing one calendar day per outer iteration with zero admissions; after 90 consecutive zero-admission days it force-places the top-ranked remaining order at the cursor (bypassing `fitsAt`) and warns via `ErrorLog.warn`, one order at a time, so the loop always terminates.

## `_sortTerms` — the single source of truth for ordering

Which sort terms exist at all is `Engine._sortTerms(mode, { plant })`'s decision, and both dispatch phases reuse its output verbatim — it is the single source of truth for optimizer ordering, and `_dispatchDayIntegrity` makes no assumption about how many terms there are or what they read (its 252-line body was byte-identical before and after the priority-lists work that generalized the terms).

Since Stage 3 of `docs/scheduling_priority.md`, `_sortTerms` is a **generic term factory**, not a hardcoded color branch: it walks `Engine.activeConstraintKeys(plant)` → `Engine.flattenConstraints(plant)`, a pre-order DFS of the plant's `plants.constraints` JSONB **tree** (a disabled node skips its entire subtree; a duplicate key collapses to its first occurrence and the UI marks it "(no effect)"; a plant with no stored tree falls back to `CONSTRAINT_CATALOG`'s enabled defaults), and pushes one `{get, cmp}` term per key, in tree order, ahead of the intrinsic tail.

Each term's `get()` reads the order's own value for that field — `Engine._taskFieldFor(key)` maps `colorWheel`→`COLOR`, `prt01`→`PRT_01`, `prt02`→`PRT_02`, `productionVersion`→`PRODUCTION_VERSION`, hardcoded as offline defaults that `GET /priority-fields` **merges** over rather than replaces (a `key.toUpperCase()` guess is wrong for 3 of the 4 and would silently rank every order 999999) — and resolves that value's rank **per task, at compare time**, out of `Store.priorityRankMaps`: shape `{line|'': {field_key: {VALUE: RANK}}}`, loaded by `Persistence.loadPriorityRankMaps` from `GET /priority-rank-maps?plant=` (served straight from the in-process `brain.PLANT_LISTS`, zero DB hit).

A line-scoped map wins over the plant-wide `''` map **for the order's current `PRODUCTION_LINE`** — which is exactly why a cross-line drag or an Orders-grid line edit picks up the destination line's ranks with no refetch: **no rank is ever stamped on the order row or the task DTO.**

The sort key is `pad(rank,7) + '|' + normalizedValue` (rank rounded and clamped to `[0, 9999999]` so a fractional or oversized rank can't defeat the fixed width; a non-finite one falls back to unranked), so unranked values — rank `999999` — **group by value after all ranked ones** instead of scattering under later terms. No term is created for a disabled or unconfigured field, so the cost is opt-in: 1 configured field is 4 terms, all 4 fields is 7, measured at ~1.5x end-to-end `runAndApply` time.

## Rank-cache freshness (load-bearing)

`OptimizeDialog.run()` awaits `Persistence.loadPriorityRankMaps(plant)` whenever `Persistence._rankMapsPlant` doesn't match (that marker is set only on a true 2xx) and confirms with the user if it still isn't fresh; `Alerts.applyFix`'s overload branch **cannot** await it (`schedule-services.mts` must not import `schedule-data.mts` — layer direction), so it uses whatever is cached. That is safe only because `Persistence.load()` (plus `_loadCache`/`_loadDemo`) **clears the cache and the marker the moment a plant change is detected** — before `/tasks`, before the master-data fetches, and so before the first `schedule:hydrated` emit renders any Fix button.

**Do not remove that clear**: without it the auto-fix path sequences the newly-loaded plant's orders against the *previous* plant's ranks, which is far harder to spot than the unranked fallback.

`GET /priority-rank-maps` is plant-gated server-side, so `loadPriorityRankMaps` must keep using `Util.fetchTraced` (bare `fetch` sends no identity header and 403s for plant-restricted users).

`Engine._comparator('changeover', …)` no longer reflects the mode's actual placement order (kept only for hypothetical external callers) — see `_dispatchDayIntegrity` for the real logic.

## Constraint registry

`CONSTRAINT_CATALOG`, populated at boot from `GET /priority-fields` with a hardcoded `colorWheel` offline fallback, plus `constraintsFor` / `constraintEnabled` / `flattenConstraints` / `activeConstraintKeys` / `hasPriorityRanks`, is surfaced as an indented, reorderable tree with a live effective-sequence panel in the per-plant System Settings pane (`Plant._renderSettingsPane`).

All four registered fields are wired into the optimizer; adding a fifth means registering it in `master_data.RANKABLE_FIELDS` on the backend — the frontend picks it up from the registry with no code change, and `Engine._fieldTaskFields`/`_fieldDescriptions` want a matching entry so it survives a failed registry fetch.

## Setup-aware dispatch (`web/setup-scheduler.mts`)

When a plant's `setup_definition.active` is set via the "Include setup times in optimizer" checkbox (`docs/Setup_matrix_redesign.md` §15), `Engine.runAndApply` bypasses `_dispatchDayIntegrity` entirely and routes `spt`/`changeover` through `Engine.evaluateSetupAware`. Full setup-matrix design and semantics live in `docs/changeover_matrix.md`; this section covers the dispatch/control-flow mechanics.

**Never-freeze rule.** The setup-aware evaluator never returns an empty patch set for a line because setup data is incomplete. `searchFragment` partitions each fragment's orders into `known` (a resolvable setup state) and `SearchRun.unknownTail` (blank or unresolvable signatures); the min-changeover permutation search runs over `known` only, so unknown orders are never charged a fake zero-minute setup. Orders with known signatures but uncovered transitions (missing matrix pairs) are admitted *in sequence* within the `known` set, charged zero setup minutes, and de-preferred by a coverage-tier score comparison that counts uncovered edges — fewer is better. This tier is compared immediately after policy key and outside the mode-permuted terms list, ensuring fully-covered sequences still win whenever one exists and that same-signature orders tend to cluster together. Once search completes, `placeUnknownTail(...)` appends the truly unknown orders (blank signatures) *after* the core, ordered by the same `orderedByPolicyThenDue` (SPT: `orderedByProductiveRuntime`) tail ordering used elsewhere, never interleaved — placing each via the real `freeIntervalsFor` capacity and split policy but charging zero minutes to setup/score, and tagging each with the dedicated `'scheduled-without-setup'` missingEdge reason the live-run toast and OptimizerPreview tally consume. A completed `searchFragment` produces a winner in every case except an active-override conflict (`adjacency.issue`) — fail closed by design, not frozen by omission. The line itself is never frozen in the ordinary case; the missing-setup case surfaces as a derived alert instead (see below), not as an unchanged line.

**Coverage-tier score comparison.** The candidate score vector carries a coverage tier (index 6, `SCORE_UNCOVERED`) that counts uncovered edges in a candidate sequence; fewer is better. It is compared immediately after policy key and *outside* the mode-permuted terms list, so a fully-covered candidate always beats an otherwise-identical uncovered one. Because identical complete states resolve to implicit-zero (and thus a covered edge), minimizing uncovered edges is equivalent to minimizing state changes — orders with the same signature tend to cluster together, providing both better behavior (fewer edge gaps) and a principled tie-break when multiple local routes exist. This tier is load-bearing for fixed boundaries — see below.

**Coverage tier and fixed boundaries.** When a fixed boundary exists, `evaluateLineWithFixedBoundaries` enumerates the locally-feasible routes — candidates whose incoming transition and required-last placement both satisfy the boundary's constraints. The coverage tier (counting uncovered edges) breaks ties among multiple feasible routes, preferring the sequence with fewer uncovered edges. A secondary hardening (`candidateEntersBoundaryUncovered`) also excludes a fallback option whose *incoming* transition into the fixed boundary is only "feasible" because of the boundary-leniency in `candidateForSequence` (below) from counting as a genuine covered route, so a single order that can never really enter the boundary doesn't manufacture a false tie-break. This tier is load-bearing: it provides the principled ranking among local routes that a per-line evaluator needs without requiring a full branching planner.

**Ambiguous fixed-boundary routes now tail-place.** When a fixed boundary has multiple locally-feasible routes, the coverage tier (above) provides a principled tie-break: the sequence with fewer uncovered edges wins. If all routes have identical coverage (e.g., all fully covered or all equally uncovered), the coverage tier defers to the next sort term (policy key, then the configured priority fields). If even that produces no winner, `evaluateLineWithFixedBoundaries` tail-places the fragment instead of freezing it — the orders place via the normal tail ordering and real capacity constraints, with zero setup minutes and alerts. This supersedes the earlier scope cut that left such fragments frozen: the coverage tier + tail-place mechanism now provides a principled resolution that respects capacity and prioritization without requiring a full branching planner.

**Unknown initial line state.** `FragmentContext.predecessorState` is nullable. Both evaluators try the scheduled-anchor fallback first; if no anchor exists, the fragment proceeds with `predecessorState = null` instead of skipping the line — the first order places via the zero-minute tail mechanism with an `initial-state-unknown` edge, and chaining continues normally from that order's own (known) state onward. `signature-incompatible` lines route the same way (kept as a diagnostic, not a skip). This does *not* weaken the fixed-boundary/override guards protecting pinned orders — those stay fail-closed: `override-inactive`, `fixed-boundary-invalid`, and protected-fixed-boundary-outside-horizon still preserve the affected run rather than moving it.

**Per-line iteration budget.** `SETUP_AWARE_ITERATION_CAP` (20,000) is constructed **per line**, inside `evaluateDueDateFirst`'s and `evaluateSptWithSetup`'s per-line loop — not once for the whole plant-wide run. A line that exhausts its cap or deadline with no winner falls back to whole-fragment tail placement rather than freezing every line behind it in iteration order.

**Min-changeover per-pass deadlines and starvation guard.** `evaluateMinChangeover` no longer runs its due-safe baseline pass and its candidate pass against one shared wall-clock deadline. The baseline pass gets half the remaining time; the candidate pass runs against the caller's own unmodified `bounds.deadline` — i.e. whatever remains in the original budget, not a fresh half-split of it. If the candidate pass is starved (hits its deadline/iteration limit) and produces no patches — or strictly fewer patched lines — while the baseline has patches, **or the candidate pass completes with zero patches** (no starvation signal, but still nothing gained), the evaluator returns the baseline with reason `min-changeover-starved`: a starved or empty candidate can never beat a non-empty baseline.

**Live-run diagnostics.** `Engine.runAndApply` nulls `Engine.lastSetupAwareResult` at the top of every non-candidate run, then stores the setup-aware result there on a setup-aware apply (mirroring `lastBacklogResult`'s clear-then-set lifecycle), and warns via `Toast` with a summary of distinct orders scheduled without setup data and the affected lines (i18n key `toast.optimize_missing_setup_summary`), counted from the dedicated `'scheduled-without-setup'` missingEdge reason. No new alert wiring is needed — alerts are derived, not evaluator-produced: `deriveSetupObservation` re-derives intervals/diagnostics from the *applied* schedule, and `Alerts.scheduleRecompute()` picks up the resulting `successor-state-unknown` / `setup-uncovered` / `initial-state-unknown` diagnostics as user-facing alerts over the newly applied schedule.

## Deliberately out of scope (see `docs/MIGRATION.md`)

A release-date floor on pull-forward, and auto-pinning (in-progress orders, SAP-firmed/FIXKZ orders, a frozen near-term fence) — manual pinning (`Store.isFixed`) is the only protection an order has from being moved. Sequence-dependent setup-time minutes are **implemented**, not out of scope — see "Setup-aware dispatch" above and `docs/changeover_matrix.md` for the full setup-aware design.
