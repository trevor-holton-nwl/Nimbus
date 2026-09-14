# Insights — alerts, utilization, and the off-main-thread compute client

## What lives here

- **`services.mts`** (804 lines)
  - `Compute` — singleton `Worker` client (`new Worker('../nimbus-worker.js?v=' + Config.BUILD_ID)`, line ~116). `available()`, `alerts(opts, dismissed)`, `utilization(startMs, days)`.
  - `Alerts` — plain object (patchable property, not a bound function): `recompute`, `_recomputeSync`, `_dismissed`, `dismiss`/`dismissAll`/`clearDismissed`, `applyFix`, `_lastMs`/`_timer`/`_pendingFull`/`_pendingLines`, `_fire`, `_armTimer`, `scheduleRecompute`, `scheduleRecomputeLines`.
  - `scheduleAlertsForPatches(patches, resolveLine)` — schedules an incremental recompute for the lines touched by a patch set.
  - `Utilization` — `_cache`, `computeMatrix`, `sev`, `todayByLine`, `dayByLine`, `_prewarm`.
- **`insights-ui.mts`** (1490 lines)
  - `Dashboard` (line 81) — KPI/heatmap/line-status rendering; keeps its own `_matrix7Cache` field (line 89) in addition to `Utilization._cache`.
  - `AlertsUIAdapter` (line 1090) — despite this file's own header comment (lines 6-8) claiming it "stays in app.js as a thin adapter," it is exported from here. That header line is stale; don't trust it.

## Counterpart

No `backend/` counterpart — Alerts/Utilization are pure frontend derived-state computation over Store data, not a persisted resource with its own endpoints.

## Key invariants & hazards

- **Incremental vs. full recompute.** `Alerts.recompute(opts)` (line 293): when `opts.lines` is a non-empty `Set`, results are **merged** into the existing alert list (`retained.concat(alerts)`, lines 302-308) rather than replacing it; a bare `recompute()` call (no `lines`) does a full-scan replace. `_recomputeSync` (the sync fallback) mirrors this exactly (lines 328, 344-350) — the scoping behavior must survive the worker/sync fork.
- **`tool-conflict` alerts are emitted on the later order's line and can involve a different line than the edited one**; incremental callers therefore escalate to a full recompute whenever a moved order carries a PRT_01/PRT_02 tool id (`taskCarriesTool`, `scheduleAlertsForPatches`, and `Engine.autoReflow`'s two direct `scheduleRecomputeLines` call sites).
- **Adaptive debounce.** `_armTimer` (line ~466-471): `delay = clamp(round(_lastMs * 1.5), 90, 500)` ms — delay scales with the last recompute's measured cost, clamped `[_ALERTS_MIN_DEBOUNCE_MS=90, _ALERTS_MAX_DEBOUNCE_MS=500]`.
- **`Confidence.init` monkey-patch exception.** `nimbus-intelligence.js` (outside this domain, loaded after `app.js`) reassigns `Alerts.recompute` to a wrapped version but forwards all arguments through, so the `{lines}` scope survives the patch. This is a documented, intentional exception to "don't monkey-patch this layer," not a bug — `Alerts` is exported as a plain object literal specifically so `recompute` is a reassignable property.
- **Worker path — verified correct post-move.** `Compute`'s `new Worker(...)` call uses `'../nimbus-worker.js?v=' + Config.BUILD_ID` from `frontend/insights/services.mts`, which correctly resolves to `frontend/nimbus-worker.js` at repo root (one level up from `frontend/insights/`). Phase P4 found and fixed a real bug here (the path needed an extra `../` after this file moved one directory deeper) — the fix is in place and documented in this file's own header (lines 34-45). **Gotcha class to watch for elsewhere:** a moved file with a relative asset/worker path silently 404s with no loud error — nothing throws, the fallback below just engages.
- **Permanent worker fallback.** `onerror` handler (lines 134-158) increments `_crashCount`; at `_crashCount >= 2` it sets `_dead = true` permanently for the session (one retry allowed, no auto-restart after the second crash). Once dead, `Compute.available()` returns false and everything routes through `_recomputeSync`/the synchronous utilization path for the rest of the session.
- **`computeMatrix` memoization — resolved, not the hazard the root doc describes.** The memo key (line ~579) is `` `${start.getTime()}|${days}|${revision}|${scope}` `` where `scope = selectedPlant || 'all'` (line 577) — **plant is part of the key**. `_prewarm` (line ~790) writes under the identical format/order (`` `${startMs}|7|${rev}|${plant}` ``). The two producers now agree and cannot collide. **The root CLAUDE.md's caveat ("the off-thread prewarm writes... under a cache key the synchronous path expects to be global, so whichever producer runs first wins") is stale — that hazard was fixed here.** Update any doc that still repeats it.
- **Unmemoized path.** `Utilization.dayByLine`/`todayByLine` (lines ~686-767) do not touch `Utilization._cache` at all — a separate, unmemoized, non-worker-offloaded code path from `computeMatrix`.
- **Dashboard bypasses the shared memo.** `Dashboard` maintains its own `_matrix7Cache` (line 89) rather than relying solely on `Utilization._cache` — it always passes a filtered task subset per the root doc's description. Verify the exact call site before assuming a single cache invalidation covers both layers; there may effectively be three caching layers in play (`Utilization._cache`, `Dashboard._matrix7Cache`, the worker prewarm).
- **`Store.subscribe(..., 'insights-services.hydrated')`** (line ~526-528): `scheduling/persistence.mts` emits a `schedule:hydrated` Store event instead of calling `Alerts.scheduleRecompute()` directly, specifically so `persistence.mts` never has to import this domain — a documented reverse-dependency-avoidance seam.
- **`_utilizationSnapshotCloneCache`** (`WeakMap`, line ~552): caches structured-clones of the six-pack (lineSettings/calendars/plants/blocks/plantBlocks/masterData) per detached preview snapshot so repeated optimizer-preview KPI calls against the same snapshot don't re-clone every time.

## Integration points

- **Imports in:** `platform/foundation.mjs` (Config, Util, ErrorLog, PerfMonitor, Toast, VirtualList), `platform/store.mjs` (Store, UndoStack), `platform/types.mjs`, `calendar/calendar-engine.mjs` (Calendar), `optimization/engine.mjs` (Engine, `deriveSetupObservation` — see cycle note below), `optimization/setup-scheduler.mjs` (type-only `ScheduleSnapshot`), `scheduling/gantt.mjs` (Timeline), `scheduling/orders.mjs` (Table, Inspector, `notifyResidualFirming`).
- **Imports out (who depends on this domain):** `app-entry.mjs` (bridges `Compute, Alerts, scheduleAlertsForPatches, Utilization, Dashboard, AlertsUIAdapter` onto `window.__NIMBUS_*`), `optimization/optimize-ui.mts`, `optimization/engine.mts`, `scheduling/gantt.mts`, `scheduling/orders.mts`, `shell/application-shell.mts`, `labor/labor-planning.mts`, `master-data/admin-ui.mts` (`AlertsUIAdapter` only).
- **Import cycle:** `insights/services.mts` imports `Engine` from `optimization/engine.mjs` at top level (a real value import, not type-only) — combined with `optimization/scheduler-contract.mts`'s documented 4-file loop (`engine.mts → setup-scheduler.mts → calendar-engine.mts → engine.mts`), this forms one 4-file strongly-connected component: `engine.mts`, `setup-scheduler.mts`, `calendar-engine.mts`, `insights/services.mts`. All cross-references resolve inside function/method bodies, never at module-evaluation time, so there's no TDZ hazard — but reason about the whole loop, not just this file's two neighbors, before adding any new top-level reference here.
- **Store events:** listens for `schedule:hydrated` and `schedule:conflicts` (the latter triggers a scoped recompute for the machines the server reported, or a full recompute when no lines are given); alert/utilization consumers subscribe to `Store` publishes triggered after `Alerts.recompute`/`Utilization.computeMatrix` runs.

## Tests

- `tests/modules/insights/services.test.mjs` — `Compute`, `Alerts`, `Utilization`, `scheduleAlertsForPatches`; includes a test for the `schedule:hydrated` seam.
- `tests/modules/insights/insights-ui.test.mjs` — `Dashboard`, `AlertsUIAdapter` (plus `Alerts` from the sibling file).
- `tests/js/compute-core.test.js` — parity pins for `Core.computeAlerts`/`Core.computeUtilization`, the shared logic both the worker and the sync fallback delegate to. Not in this folder, but the authoritative correctness contract for the sync path.

Run: `node --test tests/modules/insights/services.test.mjs tests/modules/insights/insights-ui.test.mjs`

## Gotchas

- `services.mts`'s own header comment says `AlertsUIAdapter` "stays in app.js" — false as of the live tree; it's exported from `insights-ui.mts`. Leftover prose from an earlier phase's plan.
- The root CLAUDE.md's utilization-cache-collision caveat is resolved in the live code (see above) — don't propagate it as a current risk.
- Three layers of utilization caching may exist simultaneously (`Utilization._cache`, `Dashboard._matrix7Cache`, worker prewarm) — a staleness bug here may need invalidation in more than one place.
