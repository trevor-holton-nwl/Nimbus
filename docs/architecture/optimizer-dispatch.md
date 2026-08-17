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

## Deliberately out of scope (see `docs/MIGRATION.md`)

A release-date floor on pull-forward, and auto-pinning (in-progress orders, SAP-firmed/FIXKZ orders, a frozen near-term fence) — manual pinning (`Store.isFixed`) is the only protection an order has from being moved. Sequence-dependent setup-time minutes are **implemented**, not out of scope — `Engine.runAndApply` routes `spt`/`changeover` through `Engine.evaluateSetupAware` (`web/setup-scheduler.mts`) whenever a plant's `setup_definition.active` is set via the "Include setup times in optimizer" checkbox (`docs/Setup_matrix_redesign.md` §15); see `docs/changeover_matrix.md` for the full setup-aware design.
