# CQ-1 Compatibility Inventory

> **Historical (P6, 2026-09-01):** this inventory documents the seven CQ-1 mega-modules (`application-foundation.mjs`, `schedule-state.mjs`, `schedule-services.mjs`, `schedule-data.mjs`, `schedule-workbench.mjs`, `plant-and-administration.mjs`, `application-shell.mjs`) as they existed before the domain refactor split each of them into per-domain files under `web/<domain>/`. It also carries known drift predating that split (a phantom `UtilStrip` row, a retired `WelcomeSplash` row, and several newer modules missing from its tables) — not corrected here. **For current module ownership, see the per-domain `CLAUDE.md` network** (root `CLAUDE.md`'s directory table is the index). Kept for its still-relevant history on the inline-handler backlog and the honest final-criteria accounting (§6-§8).

## CQ-1 status: COMPLETE (as of Phase 4 Task 7) — module extraction is done; several deliberately deferred/open items remain (see §6-§8)

The seven-file module extraction itself is finished and verified. It ships
with a known, itemized set of gaps — none silently dropped, all detailed in
the sections below: two open `Store` encapsulation exceptions (`Plant`,
`LaborPlanning` — §6), 91 remaining static inline-handler attributes in
`index.html` (§7), three design-doc completion criteria that are not met or
only partially met — global task-ID uniqueness (not met), `hydrate` mode
(never implemented), inline-handler elimination (not met) — and a
Docker/browser boot smoke test that has never been run in any of CQ-1's four
phases (§8). Read §6-§8 for the full, honest accounting before treating this
branch as ready to promote.

All four phases of the CQ-1 frontend module migration are committed. The
monolithic `app.js` has been replaced by seven real, coarse ES modules, each
with a single clear owner, bridged into the classic-script world via
`app-entry.mjs` and `window.__NIMBUS_*`:

| File | Lines | Owns |
|---|---:|---|
| `application-foundation.mjs` | 1,118 | Config, Util, PerfMonitor, VirtualList, ErrorLog, Toast, Modal |
| `schedule-state.mjs` | 811 | Store, Selection, UndoStack, Sandbox |
| `schedule-services.mjs` | 1,426 | Calendar (capacity math), Compute, Alerts (computation), Utilization, Engine |
| `schedule-data.mjs` | 1,734 | Persistence, CalendarSync, Session |
| `schedule-workbench.mjs` | 7,517 | Timeline, Table, Inspector, Hierarchy, Dashboard, TimelineNav, GanttFilter, DependencyOverlay, ContextMenu, Interaction, OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, AlertsUIAdapter |
| `plant-and-administration.mjs` | 6,916 | CalendarUI, Plant, ProdLines, MasterData, LaborPlanning, Interface, Security, AdminCockpit |
| `application-shell.mjs` | 1,552 | SessionUIAdapter, showLoginScreen, PlantSelector, WelcomeSplash, EmptyState, App, Settings |

`web/app.js` is now 731 lines and contains **no module bodies of its own** —
only the `NimbusComputeCore` guard, the seven-bridge destructure, the DI-seam
wiring (`Persistence.setCalendarService`, `setActiveTabResolvers`,
`Util`/`ErrorLog`/`Store` resolver injections), `_bootMain()`/
`_domReadyGate()` boot orchestration, and the final compatibility `return
{...}` namespace `index.html`'s inline handlers and `nimbus-intelligence.js`
still read. `web/app-entry.mjs` (103 lines) imports and bridges all seven.
`nimbus-intelligence.js` (2,321 lines) remains a classic script — a
deliberate, documented constraint (it accesses `NIMBUS` as a bare identifier
via classic-script shared lexical scope; converting it to `type="module"`
would sever that, and a full intelligence-layer rewrite was never in this
migration's scope) — but its two runtime monkey-patches (`UndoStack.push`,
`Alerts.recompute` reassignment) are gone, replaced by `Store` event
subscriptions (Phase 4 Task 5). `grep -n "UndoStack\.push\s*=\|Alerts\.recompute\s*="
web/nimbus-intelligence.js` returns zero matches, confirmed at Task 7.

**§6 is NOT empty — this corrects an inaccurate claim in this phase's own
plan text.** This phase's Global Constraints stated "this phase closes the
final 3 rows... after Task 6, that table should be empty," and Task 7's own
Step 1 instruction says to confirm §6 is empty. Neither is true at the close
of Phase 4: §6 carries **2 open rows** — `Plant` (one
`Store._state.masterData?.plants?.find(...)` read inside
`_renderSettingsPane`, carried over verbatim when the method relocated from
`App` in Task 1) and `LaborPlanning` (six `Store._state.masterData` reads,
carried over verbatim when the module moved in Task 2). Both rows were added
*by* Tasks 1 and 2 respectively, after each task's own move — neither was
anticipated by the Global Constraints' 3-row enumeration (`MasterData`, `App`,
`nimbus-intelligence.js`), and Task 6's own Step 1 instruction named only
`app.js` and `nimbus-intelligence.js` as its reading targets, not
`plant-and-administration.mjs`. Followed literally, Task 6 closed exactly the
2 rows it named (`app.js (_bootMain)` and `nimbus-intelligence.js`) and left
these 2 open — see the "§6 status after Phase 4 Task 6" note below for the
detailed reconciliation. This report states that plainly rather than
overwriting the table's own accurate record to match the plan's inaccurate
prediction. Both remaining rows have a known, trivial fix available (the same
`Store.masterData` public getter already used to close every other row in
this table) — closing them is small, well-scoped follow-up work, not an
architectural gap requiring a new seam.

**§7 (inline-handler backlog) stands at 91,** down from the 123 present at
the start of this phase — deliberately incomplete by this migration's own
Global Constraints, tracked in full in §7 below, and the acknowledged blocker
to ever promoting the new Report-Only CSP (§7's closing paragraphs, `index.html`)
to enforcing mode.

See §8 at the end of this document for the full, honest accounting against
`docs/superpowers/specs/archive/2026-07-16-cq1-frontend-module-migration-design.md`'s
"Verification and completion" paragraph — including the criteria this
migration does **not** fully satisfy (inline-handler elimination, `hydrate`
mode, global-ID-uniqueness enforcement) and what each would take to close.

---

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
data→services dependencies found during Phase 2 research. **Update (Phase 3
Task 7):** `AlertsUIAdapter` has since moved into `schedule-workbench.mjs`
(a deliberate, documented scope decision — see its §1 row below); `CalendarUI`
and `SessionUIAdapter` remain in `app.js`, deliberately, targeting
`plant-and-administration.mjs`/`application-shell.mjs` respectively in
Phase 4 — `CalendarUI` because it is plant-admin UI (blackout-block-tab
management, shared with `Plant`/`ProdLines`, both Phase 4 modules) and
`SessionUIAdapter` because login gating belongs with the application shell,
per this phase's plan's Architecture section.

**Phase 3 status (complete):** `schedule-workbench.mjs` is a real ES module,
bridged into `app.js` via `app-entry.mjs` + `window.__NIMBUS_WORKBENCH`,
carrying the 15 real workbench modules (`Timeline`, `Table`, `Inspector`,
`Hierarchy`, `Dashboard`, `TimelineNav`, `GanttFilter`, `DependencyOverlay`,
`ContextMenu`, `Interaction`, `OptimizeDialog`, `OptimizerPreview`,
`EditCalendar`, `ColorWheelViewer`, `Printer` — `UtilStrip` never existed
anywhere in the codebase, see this phase's plan's Architecture section) plus
the `SandboxAdapter`/`AlertsUIAdapter` DOM adapters relocated here in Task 7
(see their own §1 rows for the coupling rationale). `CalendarUI` and
`SessionUIAdapter` remain in `app.js`, deliberately, targeting
`plant-and-administration.mjs`/`application-shell.mjs` respectively in
Phase 4. This phase closed the 5 §6 exception rows it owned (`Timeline`,
`Hierarchy`, `Dashboard`, `GanttFilter`, `DependencyOverlay` — see the
per-task notes in §6 below) and 4 of `GanttFilter`'s 8 tracked
private-consumer rows (the other 4 stay open, deliberately — see §4.2).
`Interaction` gained a real, tested `uninstall()` teardown method: additive
and intentionally unwired, since Gantt Timeline's mount-once/show-hide
lifecycle has no unmount trigger today (§2). **A note on §6's row count:**
this plan's own Global Constraints explicitly excluded `MasterData` from
this phase's scope ("closes in a different Phase 3 target file,
`plant-and-administration.mjs`, out of scope for this plan") — its §6 row
therefore stays open after this phase, alongside the two genuine Phase 4
rows (`App`, `nimbus-intelligence.js`). §6 lists **3** open rows at the close
of Phase 3, not 2; `MasterData`'s row closes only when the sibling
`plant-and-administration.mjs` migration lands, which is a different plan.

**Phase 4 Task 1 status (complete):** `plant-and-administration.mjs` is a real
ES module, bridged into `app.js` via `app-entry.mjs` +
`window.__NIMBUS_PLANT_ADMIN`, carrying `CalendarUI`, `Plant`, and
`ProdLines` — moved verbatim except two seams identified in this phase's
research, both resolved rather than carried forward:
- `Plant.gotoTab('settings')`'s call into `App._renderSettingsPane()` was
  eliminated by relocating `_renderSettingsPane`'s entire body bodily into
  `Plant._renderSettingsPane()` (per-plant scheduling-constraint list,
  color-wheel enable toggle — content that only ever rendered into Plant's
  own `#plant-tab-settings` DOM and was only ever triggered from `Plant`
  itself). `app.js`'s old call site is now a one-line stub, removed entirely
  when Task 4 deletes the rest of `App`. This method's one
  `Store._state.masterData` direct touch is untouched, verbatim — it is not
  one of this task's targets; see §6 for that ongoing exception.
- `Plant.init()`'s Store-subscribe callback's read of
  `App._currentTab`/`_currentMasterSub` became
  `_activeTabResolvers.currentTab()`/`.currentMasterSub()`, fed by a new
  `PlantAdmin.setActiveTabResolvers(...)` injected-getter seam wired once in
  `app.js` boot glue immediately after this task's bridge destructure — the
  same one-directional "am I currently visible?" pattern used throughout this
  migration. `LaborPlanning`'s equivalent reads (`App._laborSub`/
  `._currentTab`) are wired through the same seam when `LaborPlanning` itself
  moves in Task 2.

`MasterData` has not moved yet (Task 2) — `Plant`'s/`ProdLines`' bare
`MasterData.syncLineSettings(...)` calls (7 call sites) are therefore genuine
forward references into `app.js`-resident code that hasn't moved into this
file yet, rewritten through the shared `NIMBUS` binding
(`NIMBUS.MasterData.syncLineSettings(...)`), the same idiom Phase 3 used for
its own forward references into not-yet-moved modules (Timeline's/Table's/
Dashboard's/Interaction's). They become ordinary same-module references with
no further code change once Task 2 lands `MasterData` in this same file.

Eight static `onclick=` attributes in `index.html` targeting `CalendarUI`/
`Plant`/`ProdLines` (the plant-inner-tabs strip's 3 tab buttons, the plant
blackout "+ Add" button, the roster-list toggle, and the three modal "Save
block" buttons) were converted to real `addEventListener` wiring, following
the Phase 3 `Interaction._showMultiInspector` precedent. Since `CalendarUI`
has no `init()` at all and `ProdLines` deliberately has none (renders
on-demand), `Plant.init()` — the one boot-time entry point already guaranteed
to run once at boot, per `_bootMain()` — is the single wiring point for this
whole family's static markup, via a new `Plant._wireStaticHandlers()`. The
JS-template-generated `onclick="NIMBUS.CalendarUI/Plant/ProdLines..."` strings
inside `CalendarUI`/`Plant`/`ProdLines`'s own re-rendered HTML (blackout-row
remove buttons, color-wheel preview/remove, plant-hours pill click/right-click,
etc.) are **not** in this task's scope — the plan's inline-handler mandate
only applies to `index.html`'s static attributes, not app-generated markup —
and are left exactly as-is (they resolve normally via the global `NIMBUS`
binding regardless of which file defines the target module). A stale
`index.html` HTML comment referencing `App._renderSettingsPane` by name was
also corrected (to describe behavior without naming a `Module._member` path)
since the regex-based legacy-surface scanner treated the comment text itself
as a private-consumer access — this closes that one phantom `§4.2` row (see
below) as a side effect of the relocation, not a semantic private-access fix.

**Phase 4 Task 2 status (complete):** `MasterData` and `LaborPlanning` moved
verbatim into `plant-and-administration.mjs`, extending the `app.js` →
`window.__NIMBUS_PLANT_ADMIN` destructure. Two fixes, both named by this
task's plan:
- `MasterData`'s one `Store._state.masterData = {...}; Store.rebuildPlantIndex();`
  write (inside its bulk-paste-save success handler) became
  `Store.setMasterData({...}, 'master-data-save')` — the existing public
  setter added in Phase 2 Task 4 (`schedule-state.mjs`), which performs the
  identical assign-then-rebuild-then-emit sequence. The prior code emitted
  `{type:'master-data-changed', table, source}` unconditionally after the
  conditional write; `Store.setMasterData` emits its own
  `{type:'master-data-changed', source}` (no `table` field — confirmed unused
  by every subscriber, `Store.subscribe` callsites in `app.js`/
  `plant-and-administration.mjs` only branch on `evt.type`) as part of the
  write itself, so the manual `table`-carrying emit now only fires on the
  no-rows-returned branch — preserving the original one-emit-per-call shape
  with no behavior change apart from the unused field. This closes
  `MasterData`'s tracked §6 exception for real, not just by relocation — see
  §6 below.
- `LaborPlanning`'s five direct `App._laborSub`/`App._currentTab` reads
  became `_activeTabResolvers.laborSub()`/`.currentTab()`, the same injected
  getter seam Task 1 wired for `Plant`. Its one `NIMBUS.App.gotoLaborSub(...)`
  inline-onclick-generated string (in an Exceptions-tab HTML template) is
  unaffected — a forward reference into `App`, still in `app.js` until Task 4,
  through the shared `NIMBUS` binding, same idiom as Task 1's/Phase 3's
  forward references.

**New row added (Phase 4 Task 2):** `LaborPlanning` carries six direct
`Store._state.masterData` *reads* (`_subnetwork`, `_disaggregate`,
`_renderKPIs`, `_renderLinePlan`'s group lookup, `init()`'s Store-subscribe
callback) that moved verbatim along with the rest of the module. This task's
plan named only `MasterData`'s one *write* as its Store-exception target
(`LaborPlanning`'s `Interfaces` bullet named only its `App._laborSub`/
`_currentTab` reads) — closing these reads was not this task's stated job.
Tracked here under `LaborPlanning` rather than silently left unattributed or
dropped, the same honesty precedent Task 1 set for `Plant`'s carried-forward
`Store._state.masterData` read in `_renderSettingsPane`. Four static
`onclick=`/`onchange=` attributes in `index.html` target `LaborPlanning`
(`toggleGroupDropdown`, `prevHorizon`, `nextHorizon`, `setSpan`) — this task's
Files list does not include `index.html`, so unlike Task 1's CalendarUI/
Plant/ProdLines conversions, these were left as inline attributes; they
resolve correctly regardless of which file defines `LaborPlanning` (same
`NIMBUS` binding), and are folded into Task 6's precise inline-handler count
rather than silently converted out of scope or silently omitted from that
count.

**Phase 4 Task 4 status (complete):** `application-shell.mjs` is a real ES
module, bridged into `app.js` via `app-entry.mjs` + `window.__NIMBUS_SHELL` —
the seventh and final bridge — carrying `SessionUIAdapter`, `showLoginScreen`,
`EmptyState`, `PlantSelector`, `WelcomeSplash`, and `App` (minus
`_renderSettingsPane`, relocated to `Plant` in Task 1). This closes out the
module-extraction work: `app.js` now defines zero module bodies of its own.

- **A discrepancy this task had to reconcile: `Settings`.** The per-user
  settings catalog (`Settings.CATALOG`/`.DEFAULTS`/`.isRegion`/`.byCategory`)
  sat in `app.js` between the bridge-wiring block and `SessionUIAdapter`, but
  it is **not** one of CQ-1's 14 tracked modules and this task's own
  Interfaces list never names it. It has exactly one real caller left in
  `app.js` — the DI-seam wiring line `Store.setSettingsDefaultsResolver(()
  => Settings.DEFAULTS)` — and no state or behavior beyond the static
  catalog itself. Leaving it in `app.js` would have contradicted this task's
  own mandate (the file "contains no module bodies of its own" after this
  task): a 60-line object with two methods is a module body by any
  reasonable reading. `Settings` therefore moved into
  `application-shell.mjs` alongside the six named items, exported the same
  way, and imported back into `app.js`'s bridge destructure for the wiring
  line to use — the same "small public reach-back" pattern every other
  cross-file seam in this migration uses. `SessionUIAdapter`'s
  Personalization/Workflow panes are its only real reader.
- **`_bootMain()`/`_domReadyGate()` stay in `app.js`, not
  `application-shell.mjs`, on close reading of this task's own Step 3.** The
  plan's Task 4 Step 3 explicitly lists `_bootMain()`'s orchestration
  sequence and `_domReadyGate()` as content that stays in `app.js`
  ("calling `.init()` on modules now imported from the other six files, in
  the same order as before"). Both functions' `Store._state.userSettings`/
  `.roleDefaults`/`.masterData`/`.lineSettings` touches (inside `_bootMain`'s
  session-hydration and master-data-sync subscribers) are consequently
  **not** closed by this task — despite living textually where `App` used
  to — because they were never part of the `App` object literal that moved;
  `App` itself (the object with `.goto`/`.init`/etc.) has **zero**
  `Store._state`/`_rev` touches. This distinction matters for Task 6, whose
  own Step 1 already anticipates "app.js's remaining `Store._state`/`_rev`
  touches (now much smaller since most of `App`'s body moved to
  `application-shell.mjs` in Task 4)" — those touches are exactly the ones
  inside `_bootMain`, tracked below in §6 rather than silently assumed
  closed by this task.
- **Import list correction against the plan's illustrative snippet.** The
  plan's Task 4 Step 2 code sample suggested importing `PerfMonitor` and
  `Sandbox` into `application-shell.mjs` and `Alerts`/`Engine` alongside
  `Inspector`/`ContextMenu`/`Interaction`/`SandboxAdapter` being left out of
  its `schedule-workbench.mjs` import line. Re-checked against the actual
  moved code: `PerfMonitor` and `Sandbox` are never referenced bare inside
  `SessionUIAdapter`/`showLoginScreen`/`EmptyState`/`PlantSelector`/
  `WelcomeSplash`/`App` (both only appear in `app.js`'s own bridge
  destructure and its final `return {...}`, which stay in `app.js`, not this
  file) — so they are not imported here. `Engine` is likewise never
  referenced bare in the moved code (only in `app.js`'s own wiring/return),
  so it is not imported either. `Alerts` **is** used
  (`Alerts.scheduleRecompute()` inside `App.init`'s Store-subscribe
  callback) and **is** imported. `Inspector`, `ContextMenu`, `SandboxAdapter`,
  and `Interaction` are called only from `_bootMain` (which stays in
  `app.js`, already having them via the `__NIMBUS_WORKBENCH` bridge) — not
  from the `App` object itself — so `application-shell.mjs` does not import
  them; only `Timeline`, `TimelineNav`, `DependencyOverlay`, `Table`,
  `Hierarchy`, `GanttFilter`, `Dashboard`, and `AlertsUIAdapter` (all
  referenced bare inside `App`'s own methods) are imported from
  `schedule-workbench.mjs`.
- **Ten static `onclick=` attributes in `index.html` targeting `App`**
  (the work-header "Open schedule" CTA, the two Gantt-sub toggle buttons,
  the two sidebar collapse icon buttons, and the five Labor Planning
  sub-tab buttons) were converted to real `addEventListener`/`.onclick=`
  wiring inside `App.init()`, following the Phase 3
  `Interaction._showMultiInspector` / Phase 4 Task 1 `Plant.init()`
  precedent — this task's own module's static handlers, per the plan's
  Architecture point 5. `PlantSelector`/`WelcomeSplash`/`EmptyState`/
  `SessionUIAdapter`/`showLoginScreen` have zero `index.html` onclick
  references (confirmed by scan) — nothing to convert for those five.
- **All bare `t(...)` i18n calls (85 call sites) became `Util.t(...)`,**
  the same established Phase 2+ convention every other extracted module in
  this migration follows (`web/**/*.mjs`'s ESLint block does not declare
  `t` as a global, unlike `web/app.js`'s block) — the plan's "moved
  verbatim" language did not anticipate this file being a real ES module
  needing the same lint-driven rewrite every prior task already made;
  reconciled the same way `Timeline`/`Table`/`Dashboard`/every other module
  in `schedule-workbench.mjs`/`plant-and-administration.mjs` did.
- **`tests/modules/helpers/load-legacy-app.mjs`** (the Node VM harness for
  `legacy-app-characterization.test.mjs`) was updated to import
  `application-shell.mjs` and populate `window.__NIMBUS_SHELL` before
  evaluating `app.js` — required because `app.js` now throws if that bridge
  is missing, mirroring the same fix Task 1's commit made for
  `__NIMBUS_PLANT_ADMIN`.

**Phase 4 Task 5 status (complete): `nimbus-intelligence.js`'s two remaining
runtime monkey-patches converted to `Store` events.** `nimbus-intelligence.js`
stays a classic script this phase (see the Architecture note above) — this
task did not attempt the ES-module conversion, only the two behavioral
reassignments the design doc calls out by name:

- **`{ type: 'undo:pushed', label }`** — a new `Store` event emitted at the
  end of `UndoStack.push(label, undoFn)` (`schedule-state.mjs`), right after
  the entry is appended and the MAX(10) trim runs. `TimeMachine.init()`
  (`nimbus-intelligence.js`) used to do `const origPush =
  UndoStack.push.bind(UndoStack); UndoStack.push = (label, undoFn) => {
  origPush(label, undoFn); TimeMachine._snapshotAuto(label); };` — reassigning
  the shared singleton's method at runtime, so every caller of `UndoStack.push`
  anywhere in the codebase (`schedule-services.mjs`'s auto-fix undo entries,
  `schedule-workbench.mjs`'s drag/unschedule/optimize undo entries,
  `plant-and-administration.mjs`'s labor-plan undo entries,
  `schedule-state.mjs`'s own `Sandbox.exit(true)` promote path) silently ran
  through intelligence-layer code the moment `nimbus-intelligence.js` loaded,
  with no indication at any call site. It is now `Store.subscribe(evt => { if
  (evt.type === 'undo:pushed') TimeMachine._snapshotAuto(evt.label); },
  'TimeMachine.autoSnapshot')` — `UndoStack.push` itself is never reassigned;
  it unconditionally emits the fact through `Store`, and
  `nimbus-intelligence.js` (a legitimate consumer of the global `NIMBUS`
  namespace) subscribes to it like any other event. No behavior change: the
  auto-snapshot still fires once per push, still receives the same `label`,
  still runs through the same debounced `_snapshotAuto`.
- **`{ type: 'alerts:change', source, changedIds? }`** — already existed
  (`Store.setAlerts`/`dismissAlert`/`dismissAllAlerts`, all in
  `schedule-state.mjs`, confirmed emitting it since Phase 1; no
  `schedule-state.mjs` change was needed for this half of the task).
  `Confidence.init()` used to do `const origRecompute =
  Alerts.recompute.bind(Alerts); Alerts.recompute = (...args) => { const r =
  origRecompute(...args); Confidence._recomputeDebounced(); return r; };` —
  the same runtime-reassignment pattern, this time on `Alerts.recompute`. It
  is now `Store.subscribe(evt => { if (evt.type === 'alerts:change')
  Confidence._recomputeDebounced(); }, 'Confidence.autoRecompute')`.
  **This is a deliberate, documented behavior improvement, not a pure
  refactor:** the old wrap only fired when something called
  `Alerts.recompute()` directly. `Alerts.dismissAlert()`/`dismissAllAlerts()`
  mutate `Store.alerts` through `Store.dismissAlert`/`dismissAllAlerts` (which
  already emit `alerts:change` themselves) without ever calling
  `Alerts.recompute()` — so dismissing an alert or clearing all alerts
  previously left the Confidence score stale until the next unrelated
  recompute trigger (a task mutation, a plant switch). Subscribing to
  `alerts:change` directly means a dismiss now also triggers a debounced
  confidence recompute, which is strictly more correct (the score should
  reflect the alert list actually on screen) and was called out explicitly in
  this task's plan as an intentional improvement to document, not silently
  slip in.

Both replacements were verified with `node scripts/legacy-surface.mjs
--write`: the literal text `Alerts.recompute` no longer appears anywhere in
`nimbus-intelligence.js` (source code or comments) after this task, so it
dropped out of the generated `intelligenceCommands` list. `UndoStack.push`
still appears in that list — the scanner (`scripts/legacy-surface.mjs`) does
plain text/regex matching for `Module.member` occurrences; it has no concept
of "reassignment target" versus "ordinary method call," and a comment inside
`TimeMachine.init()` (`"...write IndexedDB synchronously on EVERY
UndoStack.push."`) still contains that literal substring, as do the many
legitimate `UndoStack.push(...)` call sites across the other six extracted
modules. Its continued presence in the contract is not a sign the monkey-patch
survived — `UndoStack.push` is never reassigned anywhere in the tree after
this task (confirmed by `grep -n "UndoStack\.push\s*="` returning zero
matches) — it is simply the scanner's known text-matching limitation, noted
here per this task's own Step 4 instruction rather than assuming a diff that
was never going to happen.

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
| `Sandbox` | `schedule-state.mjs` | State + snapshots only (done, Phase 1). DOM banner/buttons/Toast/Confidence/Persistence/CalendarSync side effects live in `SandboxAdapter` via the `sandbox:entered`/`sandbox:exited`/`sandbox:reverted` events (the last emitted from `exit()`'s promote-then-undo closure when a promoted scenario is undone) — `SandboxAdapter` itself moved into `schedule-workbench.mjs` in Phase 3 Task 7 (see its own row below). |
| `Calendar` | `schedule-services.mjs` | Capacity math only; blackout/line-calendar UI → workbench or plant-admin |
| `Compute` | `schedule-services.mjs` | Worker client wrapper |
| `Alerts` | `schedule-services.mjs` | Split: computation → schedule-services.mjs; drawer/bell/cell-briefing modal → `AlertsUIAdapter`, which moved into `schedule-workbench.mjs` in Phase 3 Task 7 (see its own row below). |
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
| `SandboxAdapter` | `schedule-workbench.mjs` | Moved Phase 3 Task 7 — the design doc's **explicitly-mandated** move (thin DOM/cross-module layer over the state-only `Sandbox`). |
| `AlertsUIAdapter` | `schedule-workbench.mjs` | Moved Phase 3 Task 7 — **not** an explicit design-doc mandate; a deliberate, documented scope decision based on real coupling evidence (bidirectional references to/from `Timeline`, `Inspector`, `Table`, `Dashboard`, and `Interaction` — all already in this file — stronger than `Sandbox`'s coupling was before its mandated move). `VL_ALERT_ROW_H` travels with it. |
| `CalendarUI` | `plant-and-administration.mjs` | Blackout-block-tab UI remnant (capacity math stayed in `schedule-services.mjs`'s `Calendar`). Moved Phase 4 Task 1. |
| `Plant` | `plant-and-administration.mjs` | Plant config tab. Moved Phase 4 Task 1 — now also owns `_renderSettingsPane` (relocated bodily from `App`, see the Phase 4 Task 1 status note above). |
| `ProdLines` | `plant-and-administration.mjs` | Production lines tab. Moved Phase 4 Task 1 — no `.init()` (renders on-demand, unchanged). |
| `LaborPlanning` | `plant-and-administration.mjs` | Labor plan editor. Moved Phase 4 Task 2 — `App._laborSub`/`_currentTab` reads now go through the `_activeTabResolvers` seam. |
| `MasterData` | `plant-and-administration.mjs` | CRUD grid + DDL wizard, plus Bill-of-Materials browse/filter/upload (private helpers within the module — see below). Moved Phase 4 Task 2 — its one `Store._state.masterData` write became `Store.setMasterData(...)`, closing its §6 exception. |
| `Interface` | `plant-and-administration.mjs` | SAP sync config/run history |
| `Security` | `plant-and-administration.mjs` | User/role admin |
| `AdminCockpit` | `plant-and-administration.mjs` | DB console, perf profiler, diagnostics bundle |
| `App` | `application-shell.mjs` | Tab/sub-tab routing and lifecycle owner. Moved Phase 4 Task 4, minus `_renderSettingsPane` (relocated to `Plant` in Task 1). `_bootMain()`/`_domReadyGate()` deliberately stay in `app.js` — see the Phase 4 Task 4 status note above. |
| `PlantSelector` | `application-shell.mjs` | Global plant combobox. Moved Phase 4 Task 4. |
| `WelcomeSplash` | `application-shell.mjs` | First-run splash screen. Moved Phase 4 Task 4. |
| `EmptyState` | `application-shell.mjs` | Reusable "select a plant" prompt. Moved Phase 4 Task 4. |
| `SessionUIAdapter` | `application-shell.mjs` | Login gates / User Settings modal / profile / password self-service. Moved Phase 4 Task 4 (previously missing from this table — see the Phase 3 Task 7 note above documenting why it stayed in `app.js` until now). |
| `showLoginScreen` | `application-shell.mjs` | Standalone mandatory-login-screen function (not a module object). Moved Phase 4 Task 4 (previously missing from this table). |
| `Settings` | `application-shell.mjs` | Per-user settings catalog (personalization/workflow keys + system defaults). Not one of CQ-1's 14 tracked modules — moved here in Phase 4 Task 4 as a judgment call; see the Phase 4 Task 4 status note above. |

---

## 2. Per-Screen Lifecycle Choice

Each major screen chooses exactly one lifecycle (CQ-1 invariant §5.6).
Do not mix both for the same screen.

| Screen | Lifecycle | Rationale |
|---|---|---|
| Gantt Timeline | Mount-once / show-hide | vis-timeline setup is expensive; plant changes swap the scoped context, not the DOM node |
| Interaction | Mount-once / show-hide (shares Gantt Timeline's) | No independent lifecycle of its own — it is the input layer (click/dblclick/contextmenu/drag/keyboard) for the one Gantt Timeline screen, installed once via `Interaction.install()` from boot. See the `uninstall()` note below §6 for the new, currently-unwired teardown method this row's "no unmount trigger today" implies. |
| Orders table | Mount-once / show-hide | AG Grid setup is expensive; same plant-scoped swap model |
| Dashboard | Mount-once / show-hide | `Dashboard._lsVL` (Line Status `VirtualList`) and its rendered DOM are retained across tab switches; the Chart.js rationale this row previously cited was stale — Dashboard is a hand-rolled DOM/CSS heatmap and never instantiated `Chart.js` (removed Phase 3 Task 4) |
| Plant admin | Mount/unmount with cleanup | Heavy CRUD; must tear down on tab change to avoid stale subscriptions |
| Master Data | Mount/unmount with cleanup | Dynamic DDL columns; no safe keep-alive |
| Labor Planning | Mount/unmount with cleanup | Horizon + group state resets on tab change |
| Admin Cockpit | Mount/unmount with cleanup | DB polling must not run when not visible |
| SAP Interface | Mount/unmount with cleanup | Sync polling must not run when not visible |

Plant changes always create a fresh scoped request/worker context regardless
of lifecycle choice; the distinction only governs tab transitions.

**Phase 3 completion check (Task 8):** of the 15 real workbench modules plus
`SandboxAdapter`/`AlertsUIAdapter`, only `Interaction` warranted a new row
above (added Task 5) — it is the only one that gained new lifecycle-relevant
machinery (`uninstall()`). `Inspector`, `Hierarchy`, `GanttFilter`,
`DependencyOverlay`, `ContextMenu`, and `TimelineNav` are sub-components
rendered inside the Gantt Timeline screen and share its row's mount-once /
show-hide choice with nothing further to say; `OptimizeDialog`,
`OptimizerPreview`, `EditCalendar`, `ColorWheelViewer`, `Printer`,
`SandboxAdapter`, and `AlertsUIAdapter` are modals/drawers opened and closed
on demand, not independently-tabbed screens, so CQ-1 invariant §5.6 does not
apply to them the way it does to a tab-level screen. No further rows added.

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

The full machine-readable list (73 entries, including app.js-generated HTML)
lives in `tests/contracts/cq1-legacy-surface.json` under `privateConsumers`.
**`App._renderSettingsPane` closed (Phase 4 Task 1):** this was a phantom
entry — the scanner's `Module._member` regex matched an `index.html` HTML
comment mentioning the method by name (`<!-- ... injected by
App._renderSettingsPane -->`), not a real code access. Relocating the method
into `Plant` (see the Phase 4 Task 1 status note above) and rewording the
comment to describe behavior without naming a `Module._member` path dropped
the entry count from 74 to 73 as a side effect, not a semantic fix to a real
private-access pattern.

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

**Correction (Phase 4 Task 2 research):** there is no separate `BomItems`
module — this section previously carried a `BomItems` row in §1's ownership
map speculatively, before any Phase 4 task had actually read the code. BOM
browsing, filtering, and upload are a set of private helper functions living
*inside* `MasterData` (the `bom_items` table gate, upload flow, and
component-picker logic) — they moved into `plant-and-administration.mjs` as
part of `MasterData` in Task 2, not as their own extraction. The `POST
/bom-items/upload` and `GET /bom-items` endpoints stay in `brain.py` / `db.py`;
the admin UI that calls them is `MasterData`'s own code. BOM is not part of
the primary scheduling workflow.

---

## 6. Open Store Encapsulation Exceptions (tracked, not fixed in Phase 1)

`Store._state` and `Store._rev` remain real, physically-present properties on
the exported `Store` object — required for backward compatibility with
consumers not yet migrated. Remove each row below only when its owning
module migrates in a later phase and stops touching these fields directly.

| Consumer | Touches | Migrates in |
|---|---|---|
| `Plant` | `Store._state` | Not yet scheduled — see note below |
| `LaborPlanning` | `Store._state` | Not yet scheduled — see note below |

**`app.js` (`_bootMain`) closed (Phase 4 Task 6):** the three real touches
this row referred to — the session-hydration read of
`Store._state.userSettings`/`.roleDefaults`, and the master-data-changed
subscriber's read of `Store._state.masterData?.lines` plus its per-line
write-then-read of `Store._state.lineSettings[line]` — all had existing
public alternatives from earlier phases (`Store.userSettings`/
`Store.roleDefaults`/`Store.masterData`/`Store.lineSettings`, all Phase 1
getters), so this task switched to them rather than adding anything new.
`Store.lineSettings` returns the same live object as `Store._state
.lineSettings` (a getter, not a copy), so the subsequent
`ls.excludeFromOpt = ...`/etc. in-place mutations inside the `forEach`
still write through to the real Store state exactly as before —
confirmed no behavior change, just no direct `_state` reach-through.

**`nimbus-intelligence.js` closed (Phase 4 Task 6):** re-read the full file
(all 2,321 lines, not just the ~1,300 unread ones this task's plan text
estimated remained) and found seven `Store._rev`/`Store._state` touches, all
in `Confidence`/`DarkMode` — no others existed anywhere else in the file.
All seven had an existing public alternative and needed no new getter:
- Five `Store._rev || 0` reads (`Confidence._readState`'s peak-utilization
  memo-key build and its worker-refresh staleness check; `Confidence
  ._recompute`'s R21 skip-check and its worker-refresh staleness check;
  `Confidence.showBreakdown`'s matrix memo-key build) became `Store.rev()` —
  the same Phase 1 getter `Hierarchy` and `Dashboard` already switched to in
  Phase 3. The `|| 0` fallback is redundant after this change (the getter
  already applies it) and was dropped at each call site.
- One pair, `DarkMode._resolve`'s `Store && Store._state &&
  Store._state.userSettings` / `.roleDefaults` defensive reads, became
  `Store && Store.userSettings` / `Store && Store.roleDefaults` — the
  `Store &&` guard (Store itself possibly not yet loaded) is preserved;
  only the redundant inner `_state` reach-through is removed, since the
  getter itself is safe to call the moment `Store` exists (`_state` is
  always initialized in the `Store` object literal, never lazily created).

`node scripts/legacy-surface.mjs --write` confirms zero remaining
`Store._state`/`Store._rev` matches in `app.js` or `nimbus-intelligence.js`
(both files' generated `intelligenceCommands`/comment text were checked by
hand, since the scanner's `Module.member` regex does not specifically
flag `_state`/`_rev` as forbidden — see the Phase 4 Task 5 status note above
for the same scanner-limitation caveat).

**§6 status after Phase 4 Task 6: 2 open rows, not 0.** This phase's Task 6
plan text (Files list: "close the final 2 §6 rows") and Global Constraints
("this phase closes the final 3 rows... MasterData, App,
nimbus-intelligence.js — after Task 6, that table should be empty")
disagree with each other once Tasks 1/2's own status notes are taken into
account: Task 1 added a `Plant` row and Task 2 added a `LaborPlanning` row,
neither anticipated by the Global Constraints' original 3-row enumeration,
and both of those tasks' own status notes explicitly said "whether Task 6
closes this specific row is not certain from the plan text alone... 'Not yet
scheduled' means exactly that." Task 6's own Step 1 instruction names only
`app.js` and `nimbus-intelligence.js` as its reading targets — it does not
mention `Plant`/`LaborPlanning` or `plant-and-administration.mjs` at all.
Followed literally, Task 6 closes exactly the 2 rows its own Step 1 names.
`Plant`'s `_renderSettingsPane` `Store._state.masterData?.plants?.find(...)`
read and `LaborPlanning`'s six `Store._state.masterData` reads remain open,
tracked here, not silently closed to satisfy the Global Constraints' claim.
Closing them is a small, well-scoped follow-up (both already have a public
`Store.masterData` getter available — the same one-line fix pattern used
above — nothing architecturally blocks it), but making that edit was not
this task's stated job and doing it anyway would have gone beyond "close the
final 2 §6 rows."

**`App` row renamed, not closed (Phase 4 Task 4):** re-checked against the
actual moved code — the `App` object literal (`.init`/`.goto`/`.gotoGanttSub`/
etc.) that moved into `application-shell.mjs` this task has **zero**
`Store._state`/`_rev` touches. The three real touches this row always
referred to (`_bootMain`'s session-hydration read of
`Store._state.userSettings`/`.roleDefaults`, and its master-data-changed
subscriber's reads/writes of `Store._state.masterData`/`.lineSettings`) live
inside `_bootMain()`, which this task's own plan (Step 3) keeps in `app.js`
as boot orchestration, not inside the `App` object that moved. The row is
renamed to `app.js (_bootMain)` to reflect where the code actually lives
after this task, rather than closed — Task 6's own Step 1 explicitly expects
to find and close these ("app.js's remaining `Store._state`/`_rev` touches,
now much smaller since most of `App`'s body moved to `application-shell.mjs`
in Task 4"), so "Migrates in: Phase 4 Task 6" is precise, not a guess.

**`MasterData` closed (Phase 4 Task 2):** its one
`Store._state.masterData = {...}; Store.rebuildPlantIndex();` write (inside
the bulk-paste-save success handler) became `Store.setMasterData({...},
'master-data-save')` — the existing public setter added in Phase 2 Task 4,
which performs the identical assign/rebuild/emit sequence. See the Phase 4
Task 2 status note above for the emit-shape nuance (the `table` field is
dropped from the write-triggered emit, confirmed unused by any subscriber).
This closes the row for real, not just by relocation, per this task's
explicit mandate.

**New row added (Phase 4 Task 1):** `Plant._renderSettingsPane`'s one
`Store._state.masterData?.plants?.find(...)` read moved verbatim along with
the rest of the method's body when it relocated from `App` into `Plant` (see
the Phase 4 Task 1 status note above) — closing this §6 exception was
explicitly not this task's job (the plan's Interfaces section for this task
only names moving the method, not fixing its internals). It is tracked here
under its new owner, `Plant`, rather than silently left attributed to `App`
(which no longer contains this code) or silently dropped. This phase's Task 6
plan text names only `App` and `nimbus-intelligence.js` as its remaining-
touches targets — `plant-and-administration.mjs` is not explicitly named — so
whether Task 6 closes this specific row is not yet certain from the plan text
alone; "Not yet scheduled" here means exactly that, not that it never will be.

**New row added (Phase 4 Task 2):** `LaborPlanning` carries six direct
`Store._state.masterData` *reads* (`_subnetwork`, `_disaggregate`,
`_renderKPIs`'s plant-lines lookup, `_renderLinePlan`'s group lookup, a
group-lookup inside its cell-edit handler, and `init()`'s Store-subscribe
callback filter) that moved verbatim along with the rest of the module —
this task's Interfaces section named only its `App._laborSub`/`_currentTab`
reads as its scope, not these. Tracked here under its owner, `LaborPlanning`,
rather than silently left unattributed or dropped — the same precedent as
`Plant`'s row above. As with `Plant`'s row, whether Task 6 closes this
specific row is not certain from the plan text alone (Task 6 names only
`App` and `nimbus-intelligence.js`); "Not yet scheduled" means exactly that.

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

**`Dashboard` closed (Phase 3 Task 4):** moved into `schedule-workbench.mjs`
verbatim. Dashboard's `render()` had one `Store._rev || 0` read (inside its
7-day-matrix memo-key computation) that became `Store.rev()` (the existing
Phase 1 public getter, same idiom as `Hierarchy` above), and
`_renderAlertSummary`'s one `Store._state.masterData?.plants?.find(...)`
read that became `Store.masterData?.plants?.find(...)` (the existing Phase 1
public getter used by `Timeline`/`Engine` above) — no new getters needed for
either. Dashboard also carried three bare cross-references into app.js-
resident code that hasn't moved yet — `AlertsUIAdapter.renderBell()`,
`EmptyState.render(...)`, and `App.goto(...)`/`App.gotoGanttTimeline()` — all
rewritten through the shared `NIMBUS` binding, the same idiom as Timeline's
five and Table's two forward references. All bare `t(...)` i18n calls in the
moved block became `Util.t(...)` for the same lint reason as before.

`Store.rev()` and the new `Store.replace*` setters are available now as the
migration target for each row above — use them instead of `_rev`/`_state`
when a consumer's turn comes.

**`Interaction` moved (Phase 3 Task 5) — no `Store._state`/`_rev` row to
close (it never touched either), but it is the module this phase's own
"verify lifecycle teardown" mandate targets.** `Interaction` had **zero test
coverage anywhere in the codebase** before this task — the densest (~1,140
lines including its header comment) and highest-risk module in the whole
migration (the Gantt drag/keyboard input pipeline). Task 5 added
characterization tests before moving it, in this order:

- **Idempotent `install()` and the new `uninstall()`.** `install()`'s three
  unconditional `document`-level listeners (`mousemove` edge-scroll tracking,
  `mouseleave` tooltip hiding, `keydown` for `_onKeyDown`) plus a fourth,
  separate `document` `keydown` listener inside `_installHoverPreview()` (a
  dismiss-on-any-key handler, gated behind a truthy `#vis-timeline` container
  — real in production, so a test harness must stub the container far enough
  for it to register, not just assume it as one of the "always on" three) were
  mechanically refactored from inline arrow functions into named, stored bound
  references (`_edgeScrollTrackBound`, `_hideTooltipBound`, `_onKeyDownBound`,
  `_hoverDismissBound`) — a structural change with no behavior change, needed
  so a new `uninstall()` method has concrete references to remove. Two tests
  pin this with a counting `document.addEventListener`/`removeEventListener`
  stub (verified against negative controls — deliberately breaking the
  `install()` idempotency guard and deliberately dropping one
  `removeEventListener` call from `uninstall()` both made the corresponding
  test fail with the expected count mismatch before the fix was restored):
  `install()` called twice attaches exactly 2 `keydown` / 1 `mousemove` / 1
  `mouseleave` listener (not 4/2/2), and `uninstall()` returns all three types
  to zero. `uninstall()` reverses only the 4 `document`-level listeners and
  cancels any live `_marqueeRAF`/`_edgeScrollRAF` — it deliberately does
  **not** remove the container-scoped listeners bound to `#vis-timeline`
  (click/contextmenu/pointerdown/dblclick &c. across `install()`,
  `_installMarquee()`, `_installLabelDblclick()`, `_installHoverPreview()`) or
  the vis-timeline/DataSet subscriptions (`Timeline._tl.on`/`_items.on`),
  matching the plan's own scoping of the teardown to the `document`-level
  surface — vis-timeline itself is never torn down under the Gantt Timeline
  mount-once/show-hide lifecycle (§2), so there is nothing else to unwind yet.
  **`uninstall()` is purely additive and intentionally unwired** — nothing
  calls it. It exists as tested, correct, dormant machinery satisfying this
  phase's teardown mandate without inventing an unmount trigger the Gantt
  Timeline screen doesn't otherwise have.
- **The inline-handler migration mandate's one concrete instance, corrected.**
  This plan's own Architecture section named **three** inline `onclick`
  strings inside `_showMultiInspector`'s generated multi-select panel HTML
  (`NIMBUS.Interaction._bulkFix(true)`, `_bulkFix(false)`,
  `NIMBUS.Selection.clear()`) — re-reading the actual panel markup during this
  task found a **fourth**, `NIMBUS.Interaction._unscheduleSelected()`, which
  the plan's prose missed but its own Interfaces line already implied
  ("`._unscheduleSelected()` stay as-is (still called via real event listeners
  now, not inline strings)"). All four buttons now carry `data-action`
  attributes instead, wired to real `addEventListener` calls immediately after
  the panel HTML is inserted. `node scripts/legacy-surface.mjs --write`
  confirms all 4 `app.js`-sourced `inlineHandlers` entries disappear (not 3);
  no other surface (`htmlCommands`/`intelligenceCommands`/`privateConsumers`)
  changed.
- **One same-phase forward reference, same idiom as Timeline's/Table's/
  Dashboard's.** `AlertsUIAdapter.showForCell(...)` (inside the alertcell-click
  delegate installed in `install()`) is a bare reference into app.js-resident
  code that hasn't moved yet — rewritten to `NIMBUS.AlertsUIAdapter
  .showForCell(...)`, resolving normally once `AlertsUIAdapter` itself moves
  into this file in Task 7. All bare `t(...)` i18n calls (9 call sites) became
  `Util.t(...)`, the same established convention as every prior task in this
  file. `Interaction.DEBUG` and `GanttFilter._selectedLines`/
  `._buildLineDropdown()`/`._refreshLineBtn()` — Timeline's and Interaction's
  own pre-existing bare references to these same-file siblings — were left
  untouched, per the existing note above (no further change needed once the
  referenced module lands in this same file).
- **A real doc/behavior discrepancy the new tests uncovered.** The module's
  own header comment claimed "a user-drag on a fixed task is REVERTED in the
  vis DataSet before it can reach the Store." Writing the first-ever
  characterization test for `_onDataSetUpdate` (arguably the single most
  safety-critical function in this module) found this is **not what the code
  does and, per the codebase's single-commit history, never has been**: fixed
  orders carry no per-item `editable:false` (only blackout blocks do), so
  vis-timeline lets a user actually drag one, and `Store.updateTask` itself
  has no fixed-aware guard. Inside `_onDataSetUpdate`, the
  `Store.isFixed(id)` branch's `noActualChange` guard only distinguishes a
  genuine drag from a programmatic echo (`Timeline.rebuild`/
  `_applyTaskPatch` calling `_items.update()` inside `_suppressEvents`, or a
  redraw racing a drag-commit) — a real position change on a fixed order
  **falls through to the same commit path as a non-fixed drag** (the code's
  own inline comment, left in place, already said as much: "Fixed items are
  user-draggable — fall through to normal update path"). Two tests now pin
  this precisely: a fixed task with an unchanged position is a no-op, and a
  fixed task with a genuine position change commits to the Store exactly like
  a non-fixed drag would. This phase's Global Constraints require preserving
  current behavior byte-for-byte during a "verbatim move," so **the logic is
  unchanged** — only the misleading header comment and the
  `_onDataSetUpdate` doc-comment were corrected to describe reality. Whether
  fixed orders should in fact be un-draggable (making the header comment's
  original claim true) is a product/behavior question out of this phase's
  scope — flagged here for a future task, not fixed in this one.

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
  `Persistence._snapToWorkingHours` (its second caller, a due-end helper, was removed in Phase 1 of the backward-scheduling migration). Wired once in `app.js`
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

**`SessionUIAdapter` stays in `app.js` (confirmed Phase 3 Task 7):** re-checked
against the actual coupling during Task 7 (which moved `AlertsUIAdapter` and
`SandboxAdapter` out of `app.js`) — `SessionUIAdapter` has **zero** coupling to
any `schedule-workbench.mjs` module (`Timeline`, `Table`, `Inspector`,
`Dashboard`, `Interaction`, etc.); it only touches `Session`, `Store`, `App`,
and DOM. It matches `application-shell.mjs`'s described "login gating"
ownership far better than `schedule-workbench.mjs`'s planner-workspace
ownership, so it deliberately stays here, targeting `application-shell.mjs`
in Phase 4 — the design doc's own resolution, restated in this plan's
Architecture section.

**`CalendarUI` stays in `app.js` (confirmed Phase 3 Task 7):** re-checked
against the actual coupling during Task 7 — `CalendarUI` has exactly one
`schedule-workbench.mjs` consumer, `EditCalendar` (which moved into
`schedule-workbench.mjs` this task), and that consumer only ever called two
trivial pure hour↔string conversions (`CalendarUI._hToT`/`_tToH`), not any
DOM/state surface. Rather than leave a cross-module reach in either
direction, both helpers moved to `Util.hoursToTimeString(h)`/
`.timeStringToHours(t)` in `application-foundation.mjs` — `CalendarUI`'s own
internal call sites, `Plant`'s two call sites (also in `app.js`; found during
Task 7's re-verification — the original research undercounted `CalendarUI`'s
consumers to "only `EditCalendar`," missing that `Plant` also called
`CalendarUI._hToT`/`_tToH` directly), and `EditCalendar`'s five call sites all
now call the shared `Util` helper instead. `CalendarUI._hToT`/`_tToH`
themselves were deleted (no callers left). `CalendarUI` otherwise stays in
`app.js`, deliberately, targeting `plant-and-administration.mjs` in Phase 4 —
it is blackout-block-tab UI shared with `Plant`/`ProdLines`, both Phase 4
modules, per this plan's Architecture section.

**`EditCalendar`/`ColorWheelViewer`/`Printer`/`SandboxAdapter`/
`AlertsUIAdapter` moved (Phase 3 Task 7):** all five moved into
`schedule-workbench.mjs` verbatim, plus `AlertsUIAdapter`'s
`VL_ALERT_ROW_H` VirtualList row-height const. None of the five had a
`Store._state`/`_rev` touch among this phase's 5 tracked §6 exceptions
(Timeline/Hierarchy/Dashboard/GanttFilter/DependencyOverlay), so none close a
§6 row here — `AlertsUIAdapter.renderDrawer`/`.renderBell`'s
`Store._state.masterData` reads and `SandboxAdapter`'s `Store._state.blocks`/
`.plantBlocks` reads are left untouched, verbatim, same rationale as
`OptimizeDialog.applyPreset`'s in Task 6. Two genuine same-phase forward
references now resolve as normal same-module references with no code change
needed: `Table`'s `_showAlertPopup` → `AlertsUIAdapter.focus`/`.showForCell`
(accepted as temporary in Task 2) and `Interaction`'s
`AlertsUIAdapter.showForCell(...)` (accepted as temporary in Task 5) — both
call sites are left exactly as `NIMBUS.AlertsUIAdapter...`, which resolves
identically whether or not the target is a same-module bare identifier.
`AlertsUIAdapter.focus`'s one `App.gotoGanttTimeline()` call became
`NIMBUS.App.gotoGanttTimeline()` — a **permanent** indirection (like
Dashboard's in Task 4), since `App` never moves into `schedule-workbench.mjs`
(Phase 4, `application-shell.mjs`). `EditCalendar`'s `save()` method's calls
into `Plant._persistPlantHours`/`Plant.render()`/`ProdLines.render()` (both
modules stay in `app.js`, targeting `plant-and-administration.mjs` in Phase 4)
similarly became `NIMBUS.Plant.../NIMBUS.ProdLines...` — new forward
references this task introduced by moving `EditCalendar` out from alongside
`Plant`/`ProdLines`, resolved the same way as every other cross-file
reference in this file. All bare `t(...)` i18n calls across the five modules
became `Util.t(...)`, the same established convention as every other module
in this file. `node scripts/legacy-surface.mjs --write` confirms the 5
`app.js`-sourced `inlineHandlers` entries generated from `AlertsUIAdapter`'s
and `ColorWheelViewer`'s templates (`Alerts.applyFix`, `Alerts.dismiss`,
`AlertsUIAdapter.focus`, the `toggleDrawer();Table._openOverrideModalForId`
combo, and `ColorWheelViewer._toggleExpand`) simply move to a
`schedule-workbench.mjs` file attribution — same expressions, same count, no
new entries and none removed.

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

---

## 7. Inline Handler Backlog (deliberately incomplete)

This phase's Architecture point 5 was explicit up front: "123 inline
event-handler attributes exist in `index.html` today... Converting all 123 in
one task would be the single riskiest, least-tested change of the entire
migration — this phase does not attempt that." Each task (1, 4) converted
only the `onclick=`/`onchange=` attributes calling that task's own moved
module, following the Phase 3 `Interaction._showMultiInspector` precedent.
This section quantifies exactly what is left, rather than letting CQ-1 close
with an implied (and false) zero.

**Fresh count, taken at the close of Phase 4 Task 6** (`on\w+="..."` in
`web/index.html`, the same sweep this phase's research used, deduplicated by
`(attribute, expression)` pair — the same dedup `scripts/legacy-surface.mjs`
already applies): **91 unique inline handlers**, down from the 123 present
at the start of this phase. `scripts/legacy-surface.mjs`'s existing
`--write` output already reports this exact number as part of its combined
`inlineHandlers.length` (136 across `index.html` + the four `.mjs` module
files that generate HTML strings with inline handlers of their own —
`plant-and-administration.mjs` and `schedule-workbench.mjs`, both expected:
JS-generated HTML written by an already-migrated module is not the same
debt as a static attribute sitting in `index.html` itself); no change to the
scanner was needed to get the `index.html`-only figure below — it is a
by-file breakdown of the same contract already checked in at
`tests/contracts/cq1-legacy-surface.json`, not a new capability.

By target module (static `index.html` attributes only):

| Module | Count | Note |
|---|---:|---|
| `OptimizeDialog` | 25 | Optimize modal — largest single concentration; entirely modal-internal form controls, never converted by any task since no task's Files list ever named `OptimizeDialog`/`index.html` together |
| `EditCalendar` | 14 | Working-hours modal (14 Flatpickr-adjacent pickers' surrounding buttons) |
| `Table` | 11 | AG Grid toolbar/override-modal buttons |
| `Modal` | 9 | Generic modal chrome (close/confirm/cancel), shared across every feature modal |
| `ColorWheelViewer` | 5 | Color-wheel preview modal |
| `AdminCockpit` | 4 | Admin Cockpit sub-tab/console buttons |
| `GanttFilter` | 4 | The 4 `_toggle*Dropdown` handlers already tracked since Phase 3 Task 3 (§4.2) — carried forward unchanged, not newly discovered |
| `LaborPlanning` | 4 | `toggleGroupDropdown`/`prevHorizon`/`nextHorizon`/`setSpan` — flagged as this section's target back in the Phase 4 Task 2 status note above |
| `Printer` | 4 | Print/export modal |
| `Dashboard` | 3 | Home KPI drill-down buttons |
| `OptimizerPreview` | 2 | Before/after preview modal |
| `Timeline` | 2 | Gantt toolbar buttons |
| `Alerts` | 1 | Alert drawer fix/dismiss action (computation-half naming; resolves to `AlertsUIAdapter`'s DOM code at runtime) |
| `AlertsUIAdapter` | 1 | Alert drawer focus action |
| `Persistence` | 1 | Save button |
| `SandboxAdapter` | 1 | What-If banner action |
| **Total** | **91** | |

Every one of these 91 resolves correctly today regardless of which of the
seven real `.mjs` files defines its target module — all seven are
destructured into the same `NIMBUS` object `index.html` calls through
(`NIMBUS.Module.method(...)`), so none of them are *broken*; they are a
maintainability and future-CSP-enforcement debt, not a functional bug. The
**91-count already includes** `LaborPlanning`'s 4 and `GanttFilter`'s 4 —
both were explicitly named as "folded into Task 6's precise inline-handler
count rather than silently converted out of scope" by earlier tasks' status
notes, and this section is where that promise is kept.

**This is deliberately incomplete, and CQ-1 ends with it incomplete.**
Per this plan's Architecture point 5 and Global Constraints, full inline-
handler elimination was never in scope for CQ-1 — only the module extraction
plus each task's own converted subset. Eliminating the remaining 91 (mostly
concentrated in three modal-heavy modules — `OptimizeDialog`, `EditCalendar`,
`Table` — plus the always-present `Modal` chrome) is tracked here as
explicit follow-up work, not a silently-dropped requirement. It is also the
blocker for ever promoting the Report-Only CSP below to enforcing mode:
`'unsafe-inline'` cannot be dropped from `script-src` while any of these 91
attributes still exist.

**Report-only CSP (Phase 4 Task 6):** `index.html`'s `<head>` now carries a
`Content-Security-Policy-Report-Only` meta tag. It logs violations without
blocking anything — `'unsafe-inline'` stays in both `script-src` and
`style-src` for exactly the reason above. `script-src`/`style-src`/`font-src`
are scoped to the CDN origins this app actually loads from today
(`unpkg.com`, `cdn.jsdelivr.net` for scripts and the Flatpickr/vis-timeline/
AG Grid stylesheets; `fonts.googleapis.com`/`fonts.gstatic.com` for the
Google Fonts `<link>`) — the plan's own illustrative CSP string omitted the
three stylesheet origins and the Google Fonts `font-src` from `style-src`/
`font-src` even though its own rationale said the policy should reflect "the
exact CDN/self allowlist this app actually uses"; reconciled here by adding
those origins rather than shipping a report-only policy that would
immediately report violations for every legitimate existing page load.
`report-uri /csp-report` is **not** a real working endpoint yet — wiring up
an actual collection endpoint (and, eventually, promoting the policy to
enforcing once the table above reaches zero) is a follow-up beyond this
task's scope, not part of Task 6.

---

## 8. CQ-1 Completion — Final Criteria Report (Phase 4 Task 7)

This section is the whole-migration completion gate, checked against
`docs/superpowers/specs/archive/2026-07-16-cq1-frontend-module-migration-design.md`'s
own "Verification and completion" paragraph — not against this plan's stated
intentions. Each criterion below is reported honestly: fully met, partially
met, or not met, with what closing the gap would take.

| Criterion (design doc's own wording) | Status | Evidence / gap |
|---|---|---|
| "`app.js` is gone or a documented small launcher" | **Met** | `web/app.js` is 731 lines: `NimbusComputeCore` guard, 7-bridge destructure, DI-seam wiring, `_bootMain`/`_domReadyGate`, final `return {...}`. Grep for `const ModuleName = {`/`(function`/`(() =>` across all ~51 extracted names returns zero matches (see the "grep for module names" note below) — no module body remains. |
| "the seven files are clear owners" | **Met** | §1's ownership map assigns every one of the 14 tracked modules (plus `Settings`) to exactly one of the seven files; `scripts/legacy-surface.mjs`/`check:static-assets` confirm no cross-file duplication or leakage. |
| "no task API assumes global ID uniqueness" | **Not met — deliberately deferred, unchanged since Phase 1.** | `Store.tasks`/`Store.tasksArr` remain keyed by the bare MD5 `id` (no `getTask({plant,id})` exists anywhere in `schedule-state.mjs`); only `Selection.selectedRefs()` returns `{plant,id}` pairs. §3 has said this since Phase 1 and it is still true: `make_id()` (`db.py`) excludes plant from the hash, so a reused line code across plants can still collide. Closing this needs the separate business-key migration tracked in `MIGRATION.md → task-id` (a `make_id` plant-arg change plus a `Store` re-key), out of CQ-1's scope by design. |
| "live/draft/hydrate semantics are isolated" | **Partially met.** | `Store.mode()` exists and correctly distinguishes `'live'` vs `'draft'` (`Sandbox.active`) at every emit — draft mutations never write remotely (`Sandbox`'s own state, promote-then-Save flow unchanged). But a distinct `'hydrate'` mode was **never implemented** — `mode()` has exactly two possible return values, not three, despite the design doc naming `hydrate` as a mode alongside `live`/`draft`. Hydration today is a plain `Store.setTasks`/`replace*` call sequence plus a `schedule:hydrated` event, with no dedicated in-flight-hydration flag guarding it from a concurrent draft. Confirmed no regression (Contract 8, "Hydration cannot overwrite an active draft," has no code path that hydrates while `Sandbox.active` is true in current usage), but the three-mode isolation the design doc specifies is not literally built. |
| "late async results cannot overwrite a newer plant/revision" | **Met** | `Alerts.recompute`'s worker path captures `reqRev = Store.rev()` before posting and checks `Store.rev() !== reqRev` on resolve (`schedule-services.mjs`); the utilization prewarm path does the same, keyed additionally on `plant`. `Store.emit()` bumps `_rev` unconditionally on every mutation, including `plant:selected`, so a plant switch is itself a revision bump — the rev-only check also catches a stale cross-plant response. |
| "worker/core parity remains green" | **Met** | `tests/js/*.test.js` (the legacy CommonJS compute-core/timezone suite) is unmodified across all 4 phases and passes (`npm run test:legacy`, part of the 104-test `npm test` green run at Task 7). |
| "intelligence no longer monkey-patches behavior" | **Met** | Phase 4 Task 5. `grep -n "UndoStack\.push\s*=\|Alerts\.recompute\s*=" web/nimbus-intelligence.js` returns zero matches; both are now `Store.subscribe` callbacks. |
| "inline compatibility is removed" | **Not met — deliberately incomplete, quantified, not silently dropped.** | 91 static `index.html` `onclick=`/`onchange=` attributes remain (down from 123 at the start of this phase) — see §7's full by-module table. This was an explicit, up-front scope decision (this phase's own Architecture point 5: converting all 123 in one pass was judged the single riskiest, least-tested change in the whole migration), not an oversight. Closing this needs a dedicated follow-up phase converting the remaining `OptimizeDialog`(25)/`EditCalendar`(14)/`Table`(11)/`Modal`(9) chrome plus the smaller remainder to real listeners, one module at a time, the same pattern this migration used throughout. |
| "the container reliably ships a coherent module graph" | **Unverified — no Docker/browser environment available in this session, and (see below) this gate has never actually been exercised in any of CQ-1's 4 phases.** | `npm run check:static-assets` (import-closure/no-backend-leak check) is green, and the Node-level static-import-closure tests pass, but neither substitutes for the real browser-boot/container smoke test the design doc's own completion criterion asks for. Flagged prominently below. |

**Grep for extracted module names across `web/app.js` — a literal reading of
this phase's own gate instruction does not hold, reported rather than
silently reinterpreted.** Task 7's gate literally says to grep `web/app.js`
for the ~51 module names extracted across all 4 phases and "expect zero
matches." Run literally, every one of the 51 names has multiple bare-word
matches in `app.js` (e.g. `Store` × 34, `App` × 35, `Session` × 16) — this is
expected and correct, not a failure: `app.js` is the launcher that
*references* every module by its bridged binding (the 7-bridge destructure)
and *calls* its `.init()`/methods from `_bootMain()`/the DI-seam wiring/the
final `return {...}`; a launcher with zero references to the things it
launches would be useless. The gate's actual intent — confirmed by cross-
checking it against the design doc's real completion criterion ("`app.js` is
gone or a documented small launcher") — is that no module **body**
(`const ModuleName = { ... }` / `= (function () {...})()` / `= (() => {...})()`
declarations) remains. That check *does* return zero matches for all 51
names (verified via `grep -Ec "const ${name} = (\{|\(function|\(\(\) =>)"`
against every one), confirmed at Task 7. This document records the
distinction rather than reporting a false "zero matches" against the
literal, impossible-to-satisfy instruction.

**Docker/browser boot smoke test — never run across any of CQ-1's 4
phases.** This is flagged prominently per this phase's own explicit
instruction ("this is the last chance in CQ-1 to actually exercise this, flag
it prominently if it's still never been run by the time this phase closes").
Checking every phase's own plan file:
- **Phase 0:** "Build smoke: `docker build...`. If Docker is unavailable,
  record that as an unverified environment gate" — the plan's own completion
  checklist item ("Run container/static smoke when Docker is available")
  was left unchecked (`- [ ]`), with no retroactive note added.
- **Phase 1:** Same unchecked pattern (`- [ ] Docker/browser boot smoke test`,
  `- [ ] Docker/browser smoke test run if available this session`).
- **Phase 2:** Same (`- [ ] Docker/browser boot smoke test if available`).
- **Phase 3:** The only phase that retroactively documented this — its own
  plan text states plainly: "**Not run — recorded as an unverified
  environment gate, not a pass.** No Docker/browser environment was
  available during this phase's execution sessions... the original gate was
  silently left unchecked with no explanation [until this retroactive note]."
  Phase 3 also flagged that `npm test` passing is not a substitute, since the
  Node VM harness (`load-legacy-app.mjs`) cannot populate a real `NIMBUS`
  global and so cannot exercise `schedule-workbench.mjs`'s `NIMBUS.X` forward
  references at all.
- **Phase 4 (this phase, Task 7):** `docker --version` was attempted in this
  execution's environment and returned "command not found" — Docker is
  unavailable in this session too. This is therefore recorded as an
  unverified environment gate, consistent with Phases 0-2's precedent and
  Phase 3's explicit retroactive note.

**Net: the real-browser/container boot path — `app-entry.mjs`'s dynamic
`<script>` injection sequence, the classic-script hand-off to `app.js` then
`nimbus-intelligence.js`, real `<script type="module">` timing, the
version-guard redirect, and a live click-through of login → plant selection →
Gantt Timeline → Save — has never been exercised by a real browser or a
built container at any point across all four phases of CQ-1.** Every other
gate in this document (ESLint, the 104-test Node suite, the legacy-surface
contract diff, the static-import-closure check, the offline pytest suite) is
green and gives real confidence in the pieces it can reach, but none of them
substitutes for this one. This is the single largest verification gap CQ-1
closes with, and it should be the first thing run — by whoever has a Docker
environment available — before this branch is promoted to `main` or shipped
via the `promote-azure` skill.

**Offline pytest suite — command and output, same evidentiary bar as the
Docker gate above.** Python was not on `PATH` in this session (`python -m
pytest` / bare `pytest` both fail to resolve), so the suite was run via the
project's `.venv` interpreter directly: `.venv\Scripts\pytest.exe -q` from
the repo root. Result: **90 passed, 27 skipped**, zero failures. All 27
skips are the expected `NIMBUS_TEST_DB=1` guard (Postgres unavailable in
this session — see `nimbus-local-env` project note); no test was skipped
for any other reason. This is a real, executed result, not a carried-forward
assumption — recorded here with the same command-and-output rigor as the
Docker check immediately above, since Phase 4 touched no `.py` files and a
reader should not have to guess whether that made the claim untested.
