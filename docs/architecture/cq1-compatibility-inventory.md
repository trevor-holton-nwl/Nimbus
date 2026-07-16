# CQ-1 Compatibility Inventory

This document maps every legacy module to its target CQ-1 file, records the
lifecycle choice for each major screen, clarifies the task-reference convention,
and lists every intelligence/private consumer sourced from the generated
`tests/contracts/cq1-legacy-surface.json`.

Update this document as callers migrate. Remove an entry only after its
corresponding consumer has been deleted from the contract and the test suite
re-verified green.

---

## 1. Module Ownership Map

Each NIMBUS module maps to exactly one target CQ-1 file.

| Legacy module | Target file | Notes |
|---|---|---|
| `Config` | `application-foundation.mjs` | Immutable browser/app settings only |
| `Util` | `application-foundation.mjs` | Split: pure helpers → foundation; `fetchTraced`/i18n/pickers → foundation |
| `PerfMonitor` | `application-foundation.mjs` | |
| `VirtualList` | `application-foundation.mjs` | |
| `ErrorLog` | `application-foundation.mjs` | |
| `Toast` | `application-foundation.mjs` | |
| `Modal` | `application-foundation.mjs` | Generic modal only; feature modals stay in owning module |
| `Store` | `schedule-state.mjs` | All private fields become internal; expose via selectors/commands |
| `Selection` | `schedule-state.mjs` | |
| `UndoStack` | `schedule-state.mjs` | |
| `Sandbox` | `schedule-state.mjs` | State + snapshots only (done, Phase 1). DOM banner/buttons/Toast/Confidence/Persistence/CalendarSync side effects live in `app.js`'s `SandboxAdapter` via the `sandbox:entered`/`sandbox:exited` events, pending their real move to `schedule-workbench.mjs` in Phase 3. |
| `Calendar` | `schedule-services.mjs` | Capacity math only; blackout/line-calendar UI → workbench or plant-admin |
| `Compute` | `schedule-services.mjs` | Worker client wrapper |
| `Alerts` | `schedule-services.mjs` | |
| `Utilization` | `schedule-services.mjs` | |
| `Engine` | `schedule-services.mjs` | Optimizer + auto-reflow; no DOM |
| `Persistence` | `schedule-data.mjs` | `scheduleRepository` |
| `CalendarSync` | `schedule-data.mjs` | `calendarRepository` |
| `Session` | `schedule-data.mjs` | `session` API |
| `Timeline` | `schedule-workbench.mjs` | vis-timeline instance stays private |
| `Table` | `schedule-workbench.mjs` | AG Grid instance stays private |
| `Inspector` | `schedule-workbench.mjs` | |
| `Hierarchy` | `schedule-workbench.mjs` | |
| `Dashboard` | `schedule-workbench.mjs` | |
| `UtilStrip` | `schedule-workbench.mjs` | |
| `TimelineNav` | `schedule-workbench.mjs` | |
| `GanttFilter` | `schedule-workbench.mjs` | |
| `DependencyOverlay` | `schedule-workbench.mjs` | |
| `ContextMenu` | `schedule-workbench.mjs` | |
| `Interaction` | `schedule-workbench.mjs` | Full drag/keyboard/hover pipeline |
| `OptimizeDialog` | `schedule-workbench.mjs` | Planner dialog; `OptimizerPreview` co-located |
| `EditCalendar` | `schedule-workbench.mjs` | Per-line working-hours modal |
| `ColorWheelViewer` | `schedule-workbench.mjs` | Color-wheel preview modal |
| `Printer` | `schedule-workbench.mjs` | Print/export; Printer.open() exposed via shell action |
| `Plant` | `plant-and-administration.mjs` | Plant config tab |
| `ProdLines` | `plant-and-administration.mjs` | Production lines tab |
| `LaborPlanning` | `plant-and-administration.mjs` | Labor plan editor |
| `MasterData` | `plant-and-administration.mjs` | CRUD grid + DDL wizard |
| `Interface` | `plant-and-administration.mjs` | SAP sync config/run history |
| `Security` | `plant-and-administration.mjs` | User/role admin |
| `AdminCockpit` | `plant-and-administration.mjs` | DB console, perf profiler, diagnostics bundle |
| `BomItems` | `plant-and-administration.mjs` | Bill of Materials browse/filter/upload |
| `App` | `application-shell.mjs` | Tab/sub-tab routing and lifecycle owner |
| `PlantSelector` | `application-shell.mjs` | |
| `WelcomeSplash` | `application-shell.mjs` | |
| `EmptyState` | `application-shell.mjs` | |

---

## 2. Per-Screen Lifecycle Choice

Each major screen chooses exactly one lifecycle (CQ-1 invariant §5.6).
Do not mix both for the same screen.

| Screen | Lifecycle | Rationale |
|---|---|---|
| Gantt Timeline | Mount-once / show-hide | vis-timeline setup is expensive; plant changes swap the scoped context, not the DOM node |
| Orders table | Mount-once / show-hide | AG Grid setup is expensive; same plant-scoped swap model |
| Dashboard | Mount-once / show-hide | Chart.js instances are retained |
| Plant admin | Mount/unmount with cleanup | Heavy CRUD; must tear down on tab change to avoid stale subscriptions |
| Master Data | Mount/unmount with cleanup | Dynamic DDL columns; no safe keep-alive |
| Labor Planning | Mount/unmount with cleanup | Horizon + group state resets on tab change |
| Admin Cockpit | Mount/unmount with cleanup | DB polling must not run when not visible |
| SAP Interface | Mount/unmount with cleanup | Sync polling must not run when not visible |

Plant changes always create a fresh scoped request/worker context regardless
of lifecycle choice; the distinction only governs tab transitions.

---

## 3. Task Reference Convention

Task IDs are MD5 hashes of `"{PRODUCTION_ORDER}|{MATERIAL_NUMBER}"` computed
by `make_id()` in `db.py`. They are **not** globally unique across plants —
line codes can be reused and the hash excludes plant scope.

CQ-1 adopts `taskRef = { plant, id }` as the standard task reference. No other
module may assume `id` alone is unique. Callers that today pass bare IDs:

- `Store.getTask(id)` → `scheduleState.getTask({ plant, id })`
- `Selection.ids()` → returns `{ plant, id }[]`
- Worker payloads and optimistic-concurrency responses → carry plant scope

Until the separate business-key migration (`MIGRATION.md → task-id`) is
complete, ingest must reject or quarantine duplicate IDs across plants.

---

## 4. Intelligence and Private Consumers

Generated from `tests/contracts/cq1-legacy-surface.json`. Remove an entry
only after its caller in `nimbus-intelligence.js` is migrated to use the
public event/selector API.

### 4.1 Intelligence commands (cross-module calls from `nimbus-intelligence.js`)

These are the `NIMBUS.Module.member` and destructured-module references that
the intelligence layer makes today. Each must be replaced with a documented
event subscription, a public selector, or a compatibility-adapter command
before the adapter is retired in Phase 4.

```
Alerts.focus
Alerts.recompute
Alerts.scheduleRecompute
App.goto
App.gotoGanttTimeline
Compute.available
Compute.utilization
ErrorLog.warn
GanttFilter._buildLineDropdown
GanttFilter._refreshLineBtn
GanttFilter._selectedLines
GanttFilter._active
Inspector.show
Modal.close
Selection.ids
Selection.on
Selection.stats
Sandbox.active
Sandbox.enter
Sandbox.showPanel
Store._rev
Store.alerts
Store.blocks
Store.isFixed
Store.plantBlocks
Store.selectedPlant
Store.tasks
Store.tasksArr
Timeline.focus
UndoStack._entries
UndoStack.push
UndoStack.restoreTasks
UndoStack.snapshotTasks
Util.t
```

### 4.2 Private consumers (cross-module `_` access)

These are the `Module._member` accesses from `index.html` and
`nimbus-intelligence.js`. All must be eliminated before Phase 4 completes.

```
App._renderSettingsPane
CommandPalette._activate
CommandPalette._buildIndex
CommandPalette._buildPanel
CommandPalette._buildSelectionCommands
CommandPalette._cursor
CommandPalette._esc
CommandPalette._fuzzy
CommandPalette._highlight
CommandPalette._index
CommandPalette._lastQuery
CommandPalette._move
CommandPalette._panel
CommandPalette._recent
CommandPalette._render
Confidence._recompute
GanttFilter._active
GanttFilter._buildLineDropdown
GanttFilter._refreshLineBtn
GanttFilter._selectedLines
GanttFilter._toggleColorDropdown
GanttFilter._toggleFormDropdown
GanttFilter._toggleLineDropdown
GanttFilter._togglePoMatDropdown
Store._rev
UndoStack._entries
```

The full machine-readable list (77 entries, including app.js-generated HTML)
lives in `tests/contracts/cq1-legacy-surface.json` under `privateConsumers`.

---

## 5. Bill of Materials

BOM browsing, filtering, and upload belong to `plant-and-administration.mjs`
(see ownership map row `BomItems`). The `POST /bom-items/upload` and
`GET /bom-items` endpoints stay in `brain.py` / `db.py`; the admin UI that
calls them is scoped to the plant-administration module. BOM is not part of
the primary scheduling workflow.

---

## 6. Open Store Encapsulation Exceptions (tracked, not fixed in Phase 1)

`Store._state` and `Store._rev` remain real, physically-present properties on
the exported `Store` object — required for backward compatibility with
consumers not yet migrated. Remove each row below only when its owning
module migrates in a later phase and stops touching these fields directly.

| Consumer | Touches | Migrates in |
|---|---|---|
| `Alerts` | `Store._rev`, `Store._state` | Phase 2 (schedule-services.mjs) |
| `Utilization` | `Store._rev` | Phase 2 (schedule-services.mjs) |
| `Engine` | `Store._state` | Phase 2 (schedule-services.mjs) |
| `Persistence` | `Store._state` | Phase 2 (schedule-data.mjs) |
| `CalendarSync` | `Store._state` | Phase 2 (schedule-data.mjs) |
| `Timeline` | `Store._state` | Phase 3 (schedule-workbench.mjs) |
| `Hierarchy` | `Store._rev` | Phase 3 (schedule-workbench.mjs) |
| `Dashboard` | `Store._rev`, `Store._state` | Phase 3 (schedule-workbench.mjs) |
| `GanttFilter` | `Store._state` | Phase 3 (schedule-workbench.mjs) |
| `DependencyOverlay` | `Store._state` | Phase 3 (schedule-workbench.mjs) |
| `MasterData` | `Store._state` | Phase 3 (plant-and-administration.mjs) |
| `App` | `Store._state` | Phase 4 (application-shell.mjs) |
| `nimbus-intelligence.js` | `Store._rev`, `Store._state` | Phase 4 (intelligence bridge) |

`Store.rev()` and the new `Store.replace*` setters are available now as the
migration target for each row above — use them instead of `_rev`/`_state`
when a consumer's turn comes.

`Store.mode()` now resolves the real `Sandbox.active` flag (Phase 1, Task 5):
`Sandbox` is a sibling top-level export in `schedule-state.mjs`, so `mode()`
reads it directly with no seam — `'draft'` while a What-If session is active,
`'live'` otherwise.

`Store.removeTask()` calls an injected `_selectionRemoveHook` (wired via
`Store.setSelectionRemoveHook(fn)`) instead of a bare `Selection.remove(...)`
reference, for the same reason `Util`/`ErrorLog` use resolver seams for
not-yet-extracted modules — except here the risk is sharper than a lint
error: browsers define a real, unrelated global `Selection` (the DOM
Selection API, `window.Selection`), so an unguarded reference would silently
resolve to the wrong thing and throw `Selection.remove is not a function` at
runtime instead of failing fast. `app.js` wires
`Store.setSelectionRemoveHook(id => Selection.remove(id))` once, alongside
the other DI seams. Remove this seam once `Selection` itself moves into
`schedule-state.mjs` and `removeTask()` can reference it directly.
