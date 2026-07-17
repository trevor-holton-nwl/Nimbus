# CQ-1 Compatibility Inventory

**Phase 1 status (complete):** `application-foundation.mjs` (Config, Util,
PerfMonitor, VirtualList, ErrorLog, Toast, Modal) and `schedule-state.mjs`
(Store, Selection, UndoStack, Sandbox) are real ES modules, bridged into
`app.js` via `app-entry.mjs` + `window.__NIMBUS_FOUNDATION`/`__NIMBUS_STATE`.
See §6 for the still-open `Store._state`/`_rev` exceptions carried into
Phase 2/3/4.

**Phase 2 status (complete):** `schedule-services.mjs` (Calendar capacity math,
Compute, Alerts computation, Utilization, Engine) and `schedule-data.mjs`
(Persistence, CalendarSync, Session state/API) are real ES modules. DOM/UI
code stays in app.js as `CalendarUI`, `AlertsUIAdapter`, and
`SessionUIAdapter`, following the Phase 1 `SandboxAdapter` precedent. The
`schedule:hydrated` and `session:changed` events and the
`Persistence.setCalendarService` seam resolve the two real
data→services dependencies found during Phase 2 research.

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
| `Config` | `application-foundation.mjs` | Immutable browser/app settings only. Migrated Phase 1. |
| `Util` | `application-foundation.mjs` | Split: pure helpers → foundation; `fetchTraced`/i18n/pickers → foundation. Migrated Phase 1. |
| `PerfMonitor` | `application-foundation.mjs` | Migrated Phase 1. |
| `VirtualList` | `application-foundation.mjs` | Migrated Phase 1. |
| `ErrorLog` | `application-foundation.mjs` | Migrated Phase 1. |
| `Toast` | `application-foundation.mjs` | Migrated Phase 1. |
| `Modal` | `application-foundation.mjs` | Generic modal only; feature modals stay in owning module. Migrated Phase 1. |
| `Store` | `schedule-state.mjs` | All private fields become internal; expose via selectors/commands. Migrated Phase 1 (`_state`/`_rev` exceptions tracked in §6). |
| `Selection` | `schedule-state.mjs` | Migrated Phase 1. |
| `UndoStack` | `schedule-state.mjs` | Migrated Phase 1. |
| `Sandbox` | `schedule-state.mjs` | State + snapshots only (done, Phase 1). DOM banner/buttons/Toast/Confidence/Persistence/CalendarSync side effects live in `app.js`'s `SandboxAdapter` via the `sandbox:entered`/`sandbox:exited`/`sandbox:reverted` events (the last emitted from `exit()`'s promote-then-undo closure when a promoted scenario is undone), pending their real move to `schedule-workbench.mjs` in Phase 3. |
| `Calendar` | `schedule-services.mjs` | Capacity math only; blackout/line-calendar UI → workbench or plant-admin |
| `Compute` | `schedule-services.mjs` | Worker client wrapper |
| `Alerts` | `schedule-services.mjs` | Split: computation → schedule-services.mjs; drawer/bell/cell-briefing modal → app.js's AlertsUIAdapter. |
| `Utilization` | `schedule-services.mjs` | |
| `Engine` | `schedule-services.mjs` | Optimizer + auto-reflow; genuinely DOM-free after Phase 2 removed a checkbox-read fallback (see Task 3 Step 4). |
| `Persistence` | `schedule-data.mjs` | Migrated Phase 2 Task 4, name unchanged (no DOM half — pure backend fetch/localStorage cache). |
| `CalendarSync` | `schedule-data.mjs` | Migrated Phase 2 Task 4, name unchanged (no DOM half — pure backend-authoritative calendar/blackout sync). |
| `Session` | `schedule-data.mjs` | Split: pure state/API (currentUser/actor/isAdmin/allowedPlants/pref/setPref/flushPrefs/signIn/signOut/refresh/onAuthDenied/updateCachedUser) → schedule-data.mjs; gates/user-settings modal/profile/password self-service → app.js's `SessionUIAdapter`. Migrated Phase 2 Task 5. |
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
GanttFilter.isolateLine
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
GanttFilter._toggleColorDropdown
GanttFilter._toggleFormDropdown
GanttFilter._toggleLineDropdown
GanttFilter._togglePoMatDropdown
Store._rev
UndoStack._entries
```

The full machine-readable list (74 entries, including app.js-generated HTML)
lives in `tests/contracts/cq1-legacy-surface.json` under `privateConsumers`.

**GanttFilter's private-consumer debt (Phase 3 Task 3, partially closed):** the
plan that drove this task described "8 `GanttFilter._*` private-consumer
rows (all from nimbus-intelligence.js)" closing once GanttFilter got a public
API. Re-verifying against the actual scanner and source (not the plan's
summary) found this was only true for 4 of the 8: `_active`, `_selectedLines`,
`_refreshLineBtn`, and `_buildLineDropdown` were reached from
`nimbus-intelligence.js` (the isolate-line command and the confidence-score
`anyFilterActive` computation) and are now closed — replaced with
`GanttFilter.isolateLine(line)` / `.selectedLines()` / `.activeFilter()`. The
other 4 — `_toggleLineDropdown`/`_toggleColorDropdown`/`_toggleFormDropdown`/
`_togglePoMatDropdown` — are reached exclusively from `index.html`'s inline
`onclick="NIMBUS.GanttFilter._toggle*Dropdown()"` attributes on the filter
bar's dropdown-toggle buttons, never from `nimbus-intelligence.js`. This
phase's Global Constraints forbid touching any inline-onclick string not
explicitly named (only `Interaction._showMultiInspector`'s three onclick
strings are in scope, in Task 5), so these 4 stay open here — a genuine,
documented scope boundary, not an oversight. Closing them requires adding
public toggle methods and updating `index.html`'s onclick attributes, which
is appropriately deferred to whichever future phase migrates `index.html`'s
inline handlers wholesale.

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
| `Dashboard` | `Store._rev`, `Store._state` | Phase 3 (schedule-workbench.mjs) |
| `MasterData` | `Store._state` | Phase 3 (plant-and-administration.mjs) |
| `App` | `Store._state` | Phase 4 (application-shell.mjs) |
| `nimbus-intelligence.js` | `Store._rev`, `Store._state` | Phase 4 (intelligence bridge) |

**`Timeline`/`DependencyOverlay` closed (Phase 3 Task 1):** both moved into
`schedule-workbench.mjs` verbatim. `DependencyOverlay.render`'s one
`Store._state.dependencies` read became `Store.dependencies` (the public
getter already existed — added by Phase 2 Task 4, see below — so no new
getter was needed). `Timeline` had two direct `Store._state.masterData`
reads (the live ticker's alert-horizon check in `init()`, and the
alert-horizon-zone block in `rebuild()`) that were not previously tracked
as a distinct row but are the same class of exception; both became
`Store.masterData` (the existing Phase 1 public getter). Neither module
had a `Store._rev` touch.

**`Hierarchy`/`GanttFilter` closed (Phase 3 Task 3):** both moved into
`schedule-workbench.mjs` verbatim. `Hierarchy.render`'s one
`Store._rev || 0` read (inside its local `_utilMKey` memo-key computation)
became `Store.rev()` (the existing Phase 1 public getter — `rev() { return
this._rev || 0; }` — so no new getter was needed; the `|| 0` fallback moved
into the getter itself, already there). `GanttFilter`, by contrast, was
re-verified against its actual source rather than the row's original
description and does **not** touch `Store._state` anywhere in its code —
the row was carried into this table speculatively before Task 3 actually
read the module; it closes here with no code change needed for that
specific claim. (GanttFilter's real Task 3 debt was its nimbus-intelligence.js
private-consumer surface, not a `Store._state` touch — see §4.2 above.)

**Timeline's five forward references into app.js (Phase 3 Task 1, one
temporary group + one permanent):** `Timeline` was the first Phase 3 module
moved, so it now carries five cross-references into code that has not
(`App.gotoGanttTimeline`, `EmptyState.render`) or has not yet
(`Inspector.show`, `Interaction.DEBUG`, `GanttFilter._selectedLines`) moved
into `schedule-workbench.mjs`. All five were bare identifiers in the
original app.js code (safe there — same IIFE scope) but would be
`ReferenceError`s (and `no-undef` lint failures — `web/**/*.mjs`'s ESLint
block does not include `NIMBUS`/`t`/module names in its globals, unlike
`web/app.js`'s block) once lifted into a real module. All five now go
through the shared `NIMBUS` binding (`NIMBUS.App.gotoGanttTimeline()`,
`NIMBUS.EmptyState.render(...)`, `NIMBUS.Inspector.show(...)`,
`NIMBUS.Interaction.DEBUG`, `NIMBUS.GanttFilter._selectedLines`) — the same
idiom already used elsewhere in app.js for cross-file calls into
`nimbus-intelligence.js`'s `Confidence` (`NIMBUS.Confidence?.snapshot()`).
`NIMBUS` is declared via an in-file `/* global NIMBUS */` comment in
`schedule-workbench.mjs` (no `eslint.config.js` change). `Inspector`
(Task 2), `GanttFilter` (Task 3), and `Interaction` (Task 5) become
same-module lexical references once those tasks land in this same file —
the `NIMBUS.X` indirection stays correct either way, so no further change
is needed there when that happens. `App.gotoGanttTimeline` and
`EmptyState.render` stay indirected permanently: `App` never moves into
this file (Phase 4, `application-shell.mjs`) and `EmptyState` is boot UI
that stays in `app.js` (not part of this plan's module list at all). Two
bare `t(...)` i18n calls in `Timeline._itemForBlock` also became
`Util.t(...)` (the established Phase 2 convention for the same lint
reason — see `schedule-services.mjs`'s header comment).

`Store.rev()` and the new `Store.replace*` setters are available now as the
migration target for each row above — use them instead of `_rev`/`_state`
when a consumer's turn comes.

**Temporary Engine seam (Phase 2 Task 2, resolved by Task 3):** `Alerts` moved
to `schedule-services.mjs` in Task 2, but `Engine` — which `Alerts.applyFix`
calls into for its overlap/overload auto-fix paths (`autoReflow`/
`runAndApply`) — did not move until Task 3, one commit later. During that
one-commit gap, `Alerts` carried a private seam (`Alerts.setEngineService({
autoReflow, runAndApply })`, wired once from `app.js` boot glue) so
`applyFix` never held a bare, undeclared `Engine` reference. Task 3 moved
`Engine` into `schedule-services.mjs` as a real sibling export and deleted
the seam (`Alerts._engine`/`setEngineService`) and both wiring sites —
`applyFix` now calls `Engine.autoReflow`/`Engine.runAndApply` directly, the
same pattern `Store.mode()` already used for a forward reference to
`Sandbox` (a `const` declared later in the same file resolves fine, because
the reference is only read inside a function body invoked long after module
evaluation completes).

**Engine's `_state`/DOM closures (Phase 2 Task 3):** moving `Engine` closed
its `Store._state` §6 row two ways: `constraintsFor(plant)` now reads
`Store.masterData` (the Phase 1 public getter) instead of
`Store._state.masterData`, and `runAndApply`'s post-run bookkeeping calls the
new `Store.setLastOptimize(date, source)` setter instead of writing
`Store._state.meta.lastOptimize` directly. Task 3 also found and removed
Engine's one DOM read: `runAndApply`'s `respectFixed`/`respectCalendar`
fallback read `document.getElementById('chk-respect-fixed'/'chk-respect-calendar')`
— by inspection, **neither id exists anywhere in `index.html`'s rendered
markup**, so the lookup always returned `null` and the `?? true` default
always applied. The replacement (`opts.respectFixed ?? true`) reproduces
that real runtime behavior exactly while making `Engine` genuinely DOM-free.

**Persistence/CalendarSync's `_state` touches and the two real data→services
seams (Phase 2 Task 4):** moving `Persistence` and `CalendarSync` into
`schedule-data.mjs` closed both `_state` §6 rows. Every direct
`Store._state.X` read/write inside the two modules was replaced with the
equivalent public getter (`Store.blocks`, `Store.plantBlocks`, `Store.plants`,
`Store.calendars`, `Store.lineSettings`, `Store.fixedIds`, `Store.tasks`,
`Store.tasksArr`) mutated in place — preserving the exact same backing
object's identity and therefore the exact same (lack of) event emissions —
plus two small additions: a `Store.dependencies` getter (no prior public
accessor existed for the dependency graph) and `Store.setMasterData(masterData,
source)`, which bundles the `_state.masterData = {...}` write with the
`rebuildPlantIndex()` + `master-data-changed` emit every one of its 3 call
sites already repeated verbatim (mirroring `setLastOptimize`'s precedent from
Task 3). Two wholesale-reassignment sites inside `CalendarSync._applyConfig`/
`_fanOutLegacyGlobal{Line,Plant}Blocks` (`Store._state.blocks = kept` /
`Store._state.plantBlocks = kept`) became in-place `length = 0; push(...)`
rewrites instead of a `replaceBlocks`/`replacePlantBlocks` call, specifically
to avoid firing an extra, previously-nonexistent `blocks:replace`/
`plantBlocks:replace` event in the middle of a hydration pass that already
emits its own `blocks:change`/`plantBlocks:change` right after — byte-for-byte
event-sequence preservation took priority over reusing the wholesale-replace
helper here.

Research at the start of this task confirmed the design's assumed reverse
dependency (`schedule-data.mjs` calling into `schedule-services.mjs`) is real
in the pre-Phase-2 code, at two distinct call shapes, both resolved without a
static import:
- **`Persistence.setCalendarService({ beginRun, endRun, nextAvailable,
  workWindow })`** — an injected-callback seam replacing 5 direct
  `Calendar._beginRun`/`_endRun`/`nextAvailable`/`workWindow` calls inside
  `Persistence._snapToWorkingHours`/`_dueEndOfShift`. Wired once in `app.js`
  boot glue immediately after the `schedule-services.mjs` bridge destructure
  resolves `Calendar`, using arrow-function wrappers (not bare method
  references) since `Calendar`'s methods read `this._runCache`/`_runBlocks`
  and must be invoked with `Calendar` as the receiver. Until wired (e.g. a
  standalone unit test that imports `schedule-data.mjs` directly),
  `_snapToWorkingHours` no-ops rather than throwing — snapping is skipped,
  not the load.
- **`{ type: 'schedule:hydrated', source }`** — a new `Store` event replacing
  5 direct `Alerts.scheduleRecompute()` calls inside `Persistence.load()`'s
  two branches, `_loadCache()`, and `_loadDemo()`. `schedule-services.mjs`
  subscribes to it once (added right after `Alerts` in that file, since Task 2
  already put `Alerts` there): `Store.subscribe(evt => { if (evt.type ===
  'schedule:hydrated') Alerts.scheduleRecompute(); }, 'schedule-services.hydrated')`.
  This is the "a post-commit event or a small public method" resolution the
  approved design prescribes for exactly this situation — `schedule-data.mjs`
  never imports `schedule-services.mjs`; it only emits a fact through `Store`,
  which `schedule-services.mjs` (a legitimate importer of `schedule-state.mjs`)
  is free to subscribe to.

Both `CalendarSync._deferredHydrationPlant` (read/written by `app.js`'s
`SandboxAdapter`) and `Persistence._dirtyIds`/`_forceIds`/`_autosave`/
`_rememberedPlant` (read/written by `app.js`'s boot section) continued to
resolve correctly against the now-imported objects with no code changes at
those call sites — they were already real, intentional same-worktree
cross-module reaches before this task, not `_state`-style leaks, and the
`window.__NIMBUS_DATA` bridge destructure preserves the same bound
identifiers those call sites already close over.

`Store.mode()` now resolves the real `Sandbox.active` flag (Phase 1, Task 5):
`Sandbox` is a sibling top-level export in `schedule-state.mjs`, so `mode()`
reads it directly with no seam — `'draft'` while a What-If session is active,
`'live'` otherwise.

`Store.removeTask()` now references `Selection` directly (a `typeof
Selection !== 'undefined'` guard, same pattern as `Store.mode()`'s reference
to `Sandbox`) instead of the injected `_selectionRemoveHook` seam this
document previously described. That seam existed only because `Selection`
didn't yet live in this file (Task 3); it was co-located here in Task 4 of
this same Phase 1 diff, and the indirection has since been removed — there is
no live `_selectionRemoveHook`/`setSelectionRemoveHook` in `schedule-state.mjs`
or `app.js` anymore.

**Boot-timing change (script-load path, not app behavior):** pre-CQ-1, `app.js`
loaded via a parser-blocking `document.write('<script src="app.js">')`, so its
cache-bust guard (the redirect-on-stale-build check formerly at the very top
of `app.js`) ran near-instantly, mid-HTML-parse. Under the CQ-1 entry point,
`app.js` is instead fetched by a dynamically-created `<script>` from inside
`app-entry.mjs`'s `bootEntry()`, itself only reached after this deferred
`type="module"` entry point runs (post-full-parse) and its own static
imports (`application-foundation.mjs`, `schedule-state.mjs`) resolve. Left
alone, that would delay the redirect check until after app.js's own network
fetch completed too — a real (if low-severity) window for a user to see a
flash of stale UI on deploy day before the reload fires. The guard was moved
to `app-entry.mjs`'s `runCacheBustGuard()`, which runs as soon as this
module's top-level code executes, before app.js/nimbus-intelligence.js are
even requested — recovering most of that gap, though not the parser-blocking
timing itself (accepted cost of the ESM entry point). See `app-entry.mjs` and
`tests/modules/app-entry.test.mjs` for the implementation and tests.

**`Session`/`SessionUIAdapter` split and the `session:changed` event (Phase 2
Task 5):** `Session` had no `Store._state`/`_rev` touches to close (it only
ever used the public `Store.setUserSettings`/`setRoleDefaults`/
`setSelectedPlant`/`selectedPlant` surface), so this task closes no §6 row —
it is a pure DOM/state split, mirroring the Phase 1 `Sandbox`/`SandboxAdapter`
precedent exactly. `Session`'s pure state/API (`currentUser`, `actor`,
`isAdmin`, `allowedPlants`, `pref`/`setPref`/`flushPrefs`, `signIn`, `signOut`,
`refresh`, `onAuthDenied`) moved into `schedule-data.mjs`; the ~600 lines of
DOM/settings-pane code that used to run inline inside the same IIFE (gates,
the header user-settings button, the User Settings modal's tab switching and
Personalization/Workflow panes, profile self-service, password change) stayed
in `app.js` as a new `SessionUIAdapter`, the sole subscriber to a new `Store`
event:
- **`{ type: 'session:changed', kind: 'signin'|'signout'|'refresh', plantAccessChanged? }`**
  — replaces every inline `_applyGates()`/DOM call that used to live inside
  `signIn`/`signOut`/`refresh`. `refresh()` still performs its own Store-only
  business logic (clearing `Store.selectedPlant` when the reconciled
  `allowed_plants` no longer includes it) and reports the fact via
  `plantAccessChanged` on the emitted event — the actual `PlantSelector`
  DOM refresh, the plant-access-changed toast, and the admin-tab eviction
  (`App._currentTab === 'admin'` is UI state `Session` must never read) all
  moved into `SessionUIAdapter.init()`'s subscriber. `SessionUIAdapter.init()`
  is called once from `_bootMain()`, immediately followed by an explicit
  `SessionUIAdapter._applyGates()` call — this explicit call is what actually
  applies gates for both the "already signed in" resume path (which never
  calls `signIn()` and so never emits `session:changed`) and, in practice, the
  fresh-sign-in path too (`signIn()`'s emit fires before `_bootMain()` — and
  therefore before `SessionUIAdapter.init()` — ever subscribes, since
  `showLoginScreen`'s success handler calls `App._bootMain()` only after
  `Session.signIn()` already resolved; `_applyGates` is idempotent, so this
  reduces the pre-split code's two gate-applications for a fresh sign-in to
  one, with no observable behavior difference).
- **`Session.updateCachedUser(patch)`** — a small public method added for a
  reverse-direction need the plan's own interface list didn't spell out:
  `SessionUIAdapter.saveProfile` (app.js) needs to merge `{first_name,
  last_name}` into the cached `nimbus.session` blob after a successful
  `PATCH /security/me`, but that blob's localStorage key (`KEY`) is
  intentionally private to `schedule-data.mjs`. Same "small public method"
  resolution CLAUDE.md's Global Constraints prescribe for a reverse-direction
  need — never a bare `KEY` export or a `window`/`globalThis` reach-around.

**`Sandbox.exit(false)` (What-If discard) event contract:** the discard path
calls `Store.setTasks`/`replaceBlocks`/`replaceCalendars`/`replacePlants`/
`replacePlantBlocks`/`replaceFixedIds`, each of which fires its own event
(`tasks:bulk`, `blocks:replace`, `calendar:replace`, `plants:replace`,
`plantBlocks:replace`, `fixed:replace`) before the final `sandbox:exited`.
Nothing subscribes to the five `*:replace` event types today, so this is
inert — but any **future** consumer of `blocks:change` / `calendar:change` /
`plants:change` / `plantBlocks:change` / `fixed:change` must also handle the
matching `*:replace` variant, or it will silently miss the state changes a
What-If discard makes. The exact event sequence is pinned by a test in
`tests/modules/schedule-state.test.mjs` so a future change to it (batching,
renaming, dropping events) is a deliberate edit, not silent drift.
