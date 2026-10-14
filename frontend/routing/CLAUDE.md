# frontend/routing — client-side rate-map mirror (P3 slice)

## What lives here

`runtime-client.mts` — `Runtime`, the per-plant read-only mirror of `backend/routing/resolver.py`'s rate map (`GET /routing/{plant}/rate-map`, `ROUTING_RUNTIME_DESIGN.md` §8.1).

- `Runtime.load(plant)` fetches and caches the rate map, but ONLY for a plant whose `routing_runtime_enabled` switch is on (`Store.masterData.plants[].routing_runtime_enabled` — §3.6). A falsy plant, an unknown plant, or a disabled plant all clear the cache and skip the fetch. Never throws/rejects to its caller — same never-reject contract as `Persistence.loadPriorityRankMaps` (`frontend/scheduling/persistence.mts`), which this module's shape deliberately mirrors (D11: "same pattern as priority rank maps").
- `Runtime.resolve(task, machine?)` is a pure, synchronous mirror of `resolver.py`'s `resolve_one` (§5.2 steps 1-6 collapsed against the already-filtered `ops` map, + §5.4's formula), reading only the cached map — no fetch, no Store mutation. Rounds `minutes_per_unit * order_quantity` to the nearest MINUTE before dividing by 60, matching the server's own rounding point exactly (§5.4/§8.1).
- `Runtime.eligible(task, machine)` / `Runtime.hoursFor(task, machine?)` are thin boolean/number wrappers over `resolve()`.
- The cache is a plain module-private state pair (`_rateMap`, `_rateMapPlant`), not a `Store` field — nothing outside this module reads it directly (unlike `Store.priorityRankMaps`, which several unrelated modules read), so there's no reactive-state reason to route it through `Store`.

Depends on: `GET /routing/{plant}/rate-map` (`backend/routing/routes.py`), `NimbusMasterPlant.routing_runtime_enabled` (`frontend/platform/types.mts`), `Store.masterData` (`frontend/platform/store.mts`), `Util.fetchTraced`/`Config.API_BASE`/`ErrorLog` (`frontend/platform/foundation.mts`).

Wired from:
- `frontend/scheduling/persistence.mts`'s `Persistence.load()` — calls `Runtime.load(plant)` at the same point/condition it already calls `loadPriorityRankMaps` (plant switch, inside the same `Promise.all` after `/tasks` resolves).
- `frontend/master-data/admin-ui.mts`'s routing-table (`production_version`/`routing_operation`/`routing_rules`) upload and delete-filtered handlers — refreshes the cache after a write that could change the plant's rate map (`Runtime` holds ONE plant's map, the Gantt's, and `load()` drops it before fetching; so every write refreshes it only when the plant the write touched is `Store.selectedPlant` — the upload checks the plants in its result, falling back to the filtered plant when the result names none), mirroring the existing `Persistence.loadPriorityRankMaps(plantName)` call sites' placement.

## Consumers (§8.2/§8.3, shipped)

All six re-place call sites guard with `Runtime.eligible` before calling `Engine.manualRoutingSchedulePatchFor` (`frontend/optimization/engine.mts`). Routing-derived machine moves resolve the target duration before placement. Unchanged split durations translate their segments; changed productive totals use the plant's split policy:
- `frontend/scheduling/gantt.mts`'s `Interaction._onDataSetUpdate`: single-item drag drop, multi-drag drop (dragged item + each companion), split-order re-place. Ineligible → revert via `Timeline._scheduleRebuild()` (the existing spring-back mechanism, same as the sub-order machine lock) + `toast.no_routing_at_workcenter`; a multi-drag reverts the whole selection on the first offender.
- `frontend/scheduling/orders.mts`'s `Table._onCellChanged` (grid), `Inspector._onFieldChange`, `Table.applyOverride`: same MACHINE guard; a `PRODUCTION_VERSION` edit additionally calls `Runtime.resolve` to update `RUN_TIME`/`run_time_source`/`run_time_basis` locally (ok) or hold the task locally with `planning_reason.code = 'runtime_unknown'` (not ok) — server confirms/corrects on save (`backend/routing/resolver.py`'s `check_eligibility` + `db.py`'s `update_task_dates_bulk`, §8.5). `RUN_TIME` itself is editable client-side only while a task is so held (`Table._runTimeEditable`).

## Gotchas

- Rate-map routing keys include material: `material|type|group|counter`, with `|workcenter` appended in `ops`. Both producer and consumer share a tested wire fixture; groups reused across materials must remain distinct.
- Schedule saves resolve changed routing candidates inside the schedule transaction and return that transaction's version. A differing submitted duration is rejected as `runtime_preview_changed`; the browser reloads rates and uses guarded conflict recovery. Explicit PV edits opt back into routing; machine-only moves preserve manual/SAP/distributed runtimes.

- The rate map's `ops` key already encodes §5.2 step 6/7's filtering (deleted/sequence/control-key/header-status) — `resolve()` therefore has no separate "no_routing" step; a missing routing and an empty-after-filtering routing both surface here as `no_operation_at_workcenter`, since the client never sees individual operation rows.
- Never render/fetch a full plant matrix or an all-plants map — the rate map is fetched only for the selected, enabled plant (root `CLAUDE.md`'s Production Scale Roadmap applies here too).
- `RUN_TIME` on the task DTO stays the materialized truth for every existing consumer (`Util.runHours`, `nimbus-compute-core.js`, the worker); this module's output is local-preview-only and never assigned onto a task's persisted fields directly.

## Counterpart

Backend half: `backend/routing/CLAUDE.md`.
