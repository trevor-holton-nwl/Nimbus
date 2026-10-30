// app.js — CQ-1 launcher.
//
// Every module this file used to define now lives in one of the six real
// ES modules bridged in frontend/app-entry.mjs. This file exists only because
// nimbus-intelligence.js accesses NIMBUS as a bare identifier through
// classic-script shared lexical scope (confirmed: converting it to a real
// ES module would sever that access — see docs/architecture/
// cq1-compatibility-inventory.md). This IS "app.js is gone or a documented
// small launcher" per the CQ-1 design's completion criteria: nothing below
// is a module body — it is boot orchestration and the compatibility
// namespace this project's other consumers (index.html inline handlers,
// nimbus-intelligence.js) still read. `_bootMain()`/`_domReadyGate()` stay
// here (not in application-shell.mjs) because by the time they run, every
// module they call `.init()` on is already available in this file's own
// scope via its seven bridge destructures below — see
// application-shell.mjs's header comment for the full rationale.

/* =============================================================================
   N.I.M.B.U.S. 2.0 — Application
   Organised as modules inside a single `NIMBUS` namespace.

   CQ-1 Phase 1 moved 11 of these modules out of this file into two real ES
   modules, bridged in via app-entry.mjs (window.__NIMBUS_FOUNDATION /
   __NIMBUS_STATE — see the destructure at the top of this IIFE):
     Config, Util, PerfMonitor, VirtualList, ErrorLog, Toast, Modal
                       — now defined in application-foundation.mjs
     Store, Selection, UndoStack, Sandbox
                       — now defined in schedule-state.mjs
   CQ-1 Phase 2 Task 1 moved Calendar's capacity-math half and Compute out
   into a third real ES module, bridged the same way (window.__NIMBUS_SERVICES):
     Calendar (capacity math only), Compute
                       — now defined in schedule-services.mjs
   Calendar's blackout-block-tab UI half stayed here, renamed `CalendarUI`.
   CQ-1 Phase 2 Task 2 moved Alerts' computation half and Utilization into the
   same schedule-services.mjs module:
     Alerts (computation only), Utilization
                       — now defined in schedule-services.mjs
   Alerts' drawer/bell-badge/cell-briefing-modal UI half stayed here, renamed
   `AlertsUIAdapter`.
   CQ-1 Phase 2 Task 3 moved Engine (optimizer + auto-reflow) into the same
   schedule-services.mjs module, verbatim — Engine has no DOM half, so
   nothing stayed behind in app.js besides consumers of `Engine.*`.
   CQ-1 Phase 2 Task 4 moved Persistence and CalendarSync into a fourth real
   ES module, bridged the same way (window.__NIMBUS_DATA):
     Persistence, CalendarSync
                       — now defined in schedule-data.mjs
   Neither has a DOM half — both are pure backend-fetch/localStorage-cache/
   backend-sync logic — so nothing stayed behind in app.js besides consumers
   of `Persistence.*`/`CalendarSync.*`. The two real data→services dependencies
   found during Phase 2 research (Persistence calling into Calendar's capacity
   math, and Persistence calling Alerts.scheduleRecompute()) were resolved by
   an injected seam (`Persistence.setCalendarService`, removed with the load-time
   re-snap in backward scheduling Task 2.5) and a
   Store event (`schedule:hydrated`, subscribed to once in schedule-services.mjs)
   respectively — schedule-data.mjs still never imports schedule-services.mjs.
   CQ-1 Phase 2 Task 5 moved Session's pure state/API half into the same
   schedule-data.mjs module (window.__NIMBUS_DATA):
     Session (currentUser/actor/isAdmin/allowedPlants/pref/setPref/flushPrefs/
              signIn/signOut/refresh/onAuthDenied/updateCachedUser)
                       — now defined in schedule-data.mjs
   Session's DOM/settings-pane half (~600 lines: gates, the user-settings
   modal, profile/password self-service, personalization/workflow panes)
   stayed here, renamed `SessionUIAdapter` — mirrors the Phase 1
   Sandbox/SandboxAdapter split exactly. `signIn`/`signOut`/`refresh` now emit
   `{type:'session:changed', kind}` instead of calling `_applyGates()`/DOM code
   inline; `SessionUIAdapter.init()` (called from `_bootMain()`, alongside
   `SandboxAdapter.init()`) is the sole subscriber.
   CQ-1 Phase 3 Task 1 moved Timeline, TimelineNav, and DependencyOverlay into
   a fifth real ES module, bridged the same way (window.__NIMBUS_WORKBENCH):
     Timeline, TimelineNav, DependencyOverlay
                       — now defined in schedule-workbench.mjs
   None of the three has a DOM-remnant half — all three moved whole. Timeline
   still has five genuine cross-references into app.js-resident code that
   hasn't moved into schedule-workbench.mjs yet (App.gotoGanttTimeline,
   Inspector.show, Interaction.DEBUG, GanttFilter._selectedLines,
   EmptyState.render) — all reached via the shared `NIMBUS` binding rather
   than as bare identifiers; see the header comment in schedule-workbench.mjs.
   CQ-1 Phase 3 Task 2 moved Table, Inspector, and ContextMenu into the same
   schedule-workbench.mjs module:
     Table, Inspector, ContextMenu
                       — now defined in schedule-workbench.mjs
   None of the three has a DOM-remnant half — all three moved whole. Table's
   `_showAlertPopup` still calls `AlertsUIAdapter.focus` (via the shared
   `NIMBUS` binding, same rationale as Timeline's five above) — a genuine
   cross-file reference in the wrong direction (schedule-workbench.mjs calling
   into app.js) until `AlertsUIAdapter` itself moves into schedule-workbench.mjs
   in Task 7; Table's `_renderEmptyState`/`_NoRowsOverlay` similarly reach
   `EmptyState.render` via `NIMBUS` (EmptyState stays in app.js — boot UI, not
   part of this phase's module list). Timeline's `Inspector.show` cross-
   reference above is unaffected by Inspector's move — it is left calling
   through `NIMBUS.Inspector` rather than simplified to a same-module bare
   reference, since both forms are equivalent at runtime and Task 2 doesn't
   require touching Timeline's code. Likewise, Timeline's `GanttFilter.
   _selectedLines` cross-reference above is unaffected by GanttFilter's Task 3
   move into schedule-workbench.mjs — it is left calling through
   `NIMBUS.GanttFilter` rather than simplified to a same-module bare
   reference, for the identical reason.
   CQ-1 Phase 3 Task 3 moved Hierarchy and GanttFilter into the same
   schedule-workbench.mjs module:
     Hierarchy, GanttFilter
                       — now defined in schedule-workbench.mjs
   Neither has a DOM-remnant half — both moved whole, plus the
   `VL_HIER_LINE_H`/`VL_HIER_TASK_H` VirtualList row-height consts they use
   (`VL_ALERT_ROW_H` stays here, travelling with AlertsUIAdapter in a later
   task; `VL_LS_ROW_H` moves with Dashboard in Task 4 — see below). Task 3
   also closed GanttFilter's nimbus-intelligence.js private-consumer debt:
   `GanttFilter._selectedLines`/`_active`/`_refreshLineBtn`/`_buildLineDropdown`
   direct reaches became `GanttFilter.selectedLines()`/`.activeFilter()`/
   `.isolateLine(line)`/`.restoreAllLines()` — see nimbus-intelligence.js and
   docs/architecture/cq1-compatibility-inventory.md §4 for the remaining
   `GanttFilter._toggle*Dropdown` private-consumer rows (reached only from
   index.html's inline onclick attributes, out of scope for this phase's
   inline-handler migration mandate, so they stay open).
   CQ-1 Phase 3 Task 4 moved Dashboard into the same schedule-workbench.mjs
   module, plus its `VL_LS_ROW_H` VirtualList row-height const (see above).
   No DOM-remnant half — it moved whole. Dashboard had two direct
   `Store._rev`/`Store._state` touches (a memo-key read and a
   `masterData.plants` lookup) that became `Store.rev()`/`Store.masterData`
   (both pre-existing Phase 1 public getters), closing Dashboard's §6 row.
   It also had three bare cross-references into app.js-resident code that
   hasn't moved yet — `AlertsUIAdapter.renderBell()`, `EmptyState.render(...)`,
   `App.goto(...)`/`App.gotoGanttTimeline()` — rewritten through the shared
   `NIMBUS` binding, same rationale as Timeline's/Table's cross-references
   above. Dashboard's module-map entry below used to read "home KPIs +
   Chart.js charts" — stale: Dashboard has always been a hand-rolled DOM/CSS
   heatmap, and grepping the whole codebase for real `Chart(` instantiations
   turns up none (`AdminCockpit._dbHBarChart`/`nimbus-intelligence.js`'s
   `Confidence._drawChart` are unrelated same-named helpers, not the CDN
   `Chart` global), so Task 4 also removes the dead Chart.js `<script>` tag
   from index.html.
   CQ-1 Phase 3 Task 5 moved Interaction into the same schedule-workbench.mjs
   module — the densest (~1,140 lines) and, before this task, the only module
   in the whole migration with zero test coverage anywhere in the codebase.
   Task 5 added characterization tests first, then an install()/uninstall()
   pair: install()'s three unconditional document-level listeners
   (mousemove/mouseleave/keydown) plus _installHoverPreview()'s separate
   document keydown were refactored into named, stored bound references so
   uninstall() — new, purely additive, and intentionally unwired (Gantt
   Timeline has no unmount trigger today) — has concrete references to remove;
   it deliberately leaves every #vis-timeline-container-scoped listener
   attached (see the header comment on uninstall() in schedule-workbench.mjs).
   The plan's inline-handler-migration mandate's one concrete instance —
   _showMultiInspector's inline onclick strings — turned out to be four call
   sites, not the three originally named (_bulkFirm(true), _bulkFirm(false),
   Selection.clear(), and a fourth, _unscheduleSelected(), missed by the
   plan's prose); all four now wire through real addEventListener calls
   instead. Writing the first-ever test for _onDataSetUpdate also found the
   module's own header comment describing firmed-order drag protection didn't
   match the code — the comment was corrected, the logic (correctly) left
   unchanged. One same-phase forward reference, AlertsUIAdapter.showForCell
   (...), is left calling through the shared NIMBUS binding until
   AlertsUIAdapter itself moves in Task 7 (same rationale as Timeline's/
   Table's/Dashboard's forward references above). See
   docs/architecture/cq1-compatibility-inventory.md §6 for the full writeup.
   CQ-1 Phase 3 Task 6 moved OptimizeDialog and OptimizerPreview into the same
   schedule-workbench.mjs module, verbatim — including OptimizerPreview's
   _installAbandonGuard() MutationObserver and its optional-chained
   NIMBUS.Confidence?.snapshot()/.restore() cross-file call into
   nimbus-intelligence.js, which is unaffected by which file OptimizerPreview
   lives in and so was left exactly as-is. Neither module had a DOM-remnant
   half or a Store._state/_rev touch to close.
   CQ-1 Phase 3 Task 7 moved EditCalendar, ColorWheelViewer, Printer,
   SandboxAdapter, and AlertsUIAdapter into the same schedule-workbench.mjs
   module. `SandboxAdapter`'s move is the design doc's explicit mandate;
   `AlertsUIAdapter`'s is a deliberate, documented scope decision based on its
   coupling to Timeline/Inspector/Table/Dashboard/Interaction — see
   docs/architecture/cq1-compatibility-inventory.md. `VL_ALERT_ROW_H`
   (AlertsUIAdapter's VirtualList row-height const) travels with it. The
   shared hour-conversion helpers previously duplicated as `CalendarUI`'s
   private `_hToT`/`_tToH` moved to `Util.hoursToTimeString`/
   `.timeStringToHours` in application-foundation.mjs — `CalendarUI` (which
   stayed here through Phase 3) and `Plant` (which also stayed here through
   Phase 3) called the shared helper instead of `CalendarUI`'s own private
   copy.
   CQ-1 Phase 4 Task 1 moved CalendarUI, Plant, and ProdLines into a sixth
   real ES module, bridged the same way (window.__NIMBUS_PLANT_ADMIN):
     CalendarUI, Plant, ProdLines
                       — now defined in plant-and-administration.mjs
   `Plant`'s `App._renderSettingsPane()` call site was eliminated, not carried
   forward: `_renderSettingsPane`'s entire body (per-plant scheduling-
   constraint list, color-wheel enable toggle) was per-plant-admin content
   that only ever rendered into Plant's own `#plant-tab-settings` DOM and was
   only ever triggered from `Plant.gotoTab('settings')` — it moved bodily
   into `Plant._renderSettingsPane()` in plant-and-administration.mjs this
   task, even though the rest of `App` doesn't move until Task 4. The old
   call site below is now a one-line stub, removed entirely when Task 4
   deletes the rest of `App`. `Plant`'s Store-subscribe callback's read of
   `App._currentTab`/`_currentMasterSub` became
   `_activeTabResolvers.currentTab()`/`.currentMasterSub()` (an injected
   getter seam, `PlantAdmin.setActiveTabResolvers(...)`, wired once below
   immediately after this task's bridge destructure — the same one-directional
   "am I currently visible?" pattern used throughout this migration).
   CQ-1 Phase 4 Task 2 moved MasterData and LaborPlanning into the same
   plant-and-administration.mjs module:
     MasterData, LaborPlanning
                       — now defined in plant-and-administration.mjs
   `Plant`'s/`ProdLines`' `MasterData.syncLineSettings(...)` call sites are
   left going through the shared `NIMBUS` binding
   (`NIMBUS.MasterData.syncLineSettings(...)`) rather than simplified to a
   same-module bare reference now that `MasterData` lives in the same file —
   both forms are equivalent at runtime, and Task 2 doesn't require touching
   Plant/ProdLines' code, the same reasoning Phase 3 used once its own
   forward references' targets landed in the same file. `LaborPlanning`'s
   `App._laborSub`/`App._currentTab` reads became `_activeTabResolvers.
   laborSub()`/`.currentTab()` (the same injected getter seam Task 1
   established for `Plant`). `MasterData`'s one `Store._state.masterData = {
   ...}; Store.rebuildPlantIndex();` write became `Store.setMasterData(...)`
   (the existing public setter from Phase 2 Task 4), closing `MasterData`'s
   tracked §6 exception for real rather than carrying it forward by
   relocation. `LaborPlanning` itself still has six direct
   `Store._state.masterData` *reads*, not in this task's stated scope to
   close — tracked as a new §6 row rather than silently dropped; see
   docs/architecture/cq1-compatibility-inventory.md §6.
   CQ-1 Phase 4 Task 3 moved Interface, Security, and AdminCockpit into the
   same plant-and-administration.mjs module:
     Interface, Security, AdminCockpit
                       — now defined in plant-and-administration.mjs
   All three moved verbatim, no changes. Research confirmed Interface and
   Security are fully self-contained (zero cross-references to any other of
   the 14 modules moved across this migration). AdminCockpit — by far the
   largest single module moved in this entire migration (~2,260 lines) — has
   a dispatch to MasterData.render()/Interface.render()/Security.render() in
   its _setSub that is now a same-file bare reference: all four already
   lived behind the same __NIMBUS_PLANT_ADMIN bridge destructure in this
   file before this task (extended in Task 2), so there was no seam to
   close here.
   CQ-1 Phase 4 Task 4 moved SessionUIAdapter, showLoginScreen, EmptyState,
   PlantSelector, and App into a seventh and final real ES module, bridged
   the same way (window.__NIMBUS_SHELL):
     Settings, SessionUIAdapter, showLoginScreen, EmptyState, PlantSelector, App
                       — now defined in application-shell.mjs
   (WelcomeSplash also moved here at the time, then was retired outright —
   overlay, arrow SVG, and all — by the Command Band re-skin's chrome-wiring
   task; App.registerPausable/_pausables stayed, since that's generic App
   infrastructure, not WelcomeSplash-specific.)
   `Settings` (the per-user settings catalog) travels with this move too —
   see application-shell.mjs's header comment for why, since it was never
   one of CQ-1's 14 tracked modules. `_bootMain()` and `_domReadyGate()`
   deliberately stay in THIS file (see the launcher note at the very top) —
   they are boot orchestration, not module bodies, and by the time they run
   every `.init()` target they call is already resolvable through this
   file's own bridge destructures. This is the last bridge: app.js now
   contains no module bodies of its own.
   See docs/architecture/cq1-compatibility-inventory.md §1 for the full
   ownership map.

   Module map (load order) — modules still defined in THIS file: none. Every
   module has moved into one of the seven real ES modules bridged above; what
   remains below is boot orchestration (`_bootMain`/`_domReadyGate`), the
   DI-seam wiring, and the compatibility namespace `return {...}` at the
   bottom of this IIFE.
   ========================================================================== */

// CACHE-BUST GUARD moved to frontend/app-entry.mjs's runCacheBustGuard() (CQ-1): it
// now runs before app.js is even requested, off `NIMBUS_BUILD_ID` instead of a
// second, separately-bumped `APP_VERSION` constant here. See that file for the
// full rationale.

const NIMBUS = (function () {
  'use strict';

  // nimbus-compute-core.js is the single source of truth for the capacity engine,
  // alert rules, and utilization matrix; the Calendar/Alerts/Utilization modules below
  // delegate to it (the same module the worker importScripts). index.html injects it
  // just above app.js. Fail fast with a clear message rather than throwing cryptically
  // deep inside Alerts/Utilization on first compute.
  if (typeof NimbusComputeCore === 'undefined') {
    throw new Error('NIMBUS boot error: nimbus-compute-core.js did not load before app.js — check index.html script order / deploy.');
  }

  if (typeof window === 'undefined' || !window.__NIMBUS_FOUNDATION || !window.__NIMBUS_STATE || !window.__NIMBUS_SERVICES || !window.__NIMBUS_DATA || !window.__NIMBUS_WORKBENCH || !window.__NIMBUS_PLANT_ADMIN || !window.__NIMBUS_SHELL || !window.__NIMBUS_MATERIAL_GRIDS) {
    throw new Error('NIMBUS boot error: application-foundation.mjs/schedule-state.mjs/schedule-services.mjs/schedule-data.mjs/schedule-workbench.mjs/plant-and-administration.mjs/application-shell.mjs/master-data-grids.mjs did not load before app.js — check app-entry.mjs.');
  }
  const { Config, Util, PerfMonitor, VirtualList, ErrorLog, Toast, Modal } = window.__NIMBUS_FOUNDATION;
  const { Store, Selection, UndoStack, Sandbox } = window.__NIMBUS_STATE;
  const { Calendar, Compute, Alerts, Utilization, Engine } = window.__NIMBUS_SERVICES;
  const { Persistence, CalendarSync, Session } = window.__NIMBUS_DATA;
  const { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter, Dashboard, Interaction, OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer, PriorityListViewer, Printer, SandboxAdapter, AlertsUIAdapter } = window.__NIMBUS_WORKBENCH;
  const { CalendarUI, Plant, ProdLines, MasterData, LaborPlanning, Interface, Security, SystemConfig, AdminCockpit, PriorityListMapping, setActiveTabResolvers: _setPlantAdminTabResolvers } = window.__NIMBUS_PLANT_ADMIN;
  const { Settings, SessionUIAdapter, showLoginScreen, EmptyState, PlantSelector, App } = window.__NIMBUS_SHELL;
  const { MaterialGrids } = window.__NIMBUS_MATERIAL_GRIDS;
  // Injected getter seam so plant-and-administration.mjs's Plant/LaborPlanning
  // can ask "am I currently the visible tab/sub-tab?" without a bare reference
  // to `App`. `App` is now imported from application-shell.mjs via the bridge
  // destructure immediately above, resolved lazily at call time, same as
  // every other seam in this migration.
  _setPlantAdminTabResolvers({
    currentTab: () => App._currentTab,
    currentMasterSub: () => App._currentMasterSub,
    laborSub: () => App._laborSub,
  });
  window.t = (key, vars) => Util.t(key, vars);
  Util.setPreferenceResolver(key => Store.pref(key));
  Util.setActorResolver(() => Session.actor());
  Util.setUtilizationResolver((from, days, tasks, snapshot) => Utilization.computeMatrix(from, days, tasks, snapshot));
  // What counts as a changeover follows the plant's OWN active priority fields
  // (Stage 3), not a hardcoded COLOR/FORM_SIZE pair — so the Optimizer Preview's
  // changeover KPI measures the same thing Engine._sortTerms sequences on.
  // Resolved off Store.selectedPlant with no argument for the same reason
  // Engine.hasPriorityRanks takes no plant: every runAndApply caller's effective
  // plant IS Store.selectedPlant, and the KPI is always about the run in front
  // of the user.
  Util.setChangeoverFieldsResolver(() => Engine.changeoverTaskFields(Store.selectedPlant));
  // A date-only SAP due date (exact midnight) reads as the end of that date's working window;
  // the window comes from the line's calendar rows in Store (platform may not import Store).
  // A line with no calendar row resolves to null -> "no calendar" (raw + 23:59:59).
  Util.setDueCalendarResolver(line => {
    const row = Store.calendars[line];
    if (!row) return null;
    const plant = Store.getPlantForLine(line);
    // An inherited line is open all day and relies on the plant's hours bounding it; this reader only intersects
    // when the plant has a calendar entry, so without one fall back to the default week instead.
    const lineHours = row.inherited && !(plant && Store.plants[plant]) ? Store.effectiveLineHours(line) : row.workHours;
    return { lineHours, plantHours: plant ? (Store.plants[plant]?.workHours ?? null) : null, plantPeriods: plant ? (Store.plants[plant]?.periods ?? null) : null, plant, rev: Store.rev() };
  });
  ErrorLog.setPlantResolver(() => Store.selectedPlant);
  ErrorLog.setRouteResolver(() => ({ tab: App._currentTab, ganttSub: App._ganttSub }));
  ErrorLog.setAdminGate(() => Session.isAdmin());
  ErrorLog.setBadgeClickHandler(() => { App.goto('admin'); AdminCockpit.gotoSub('logs'); });
  Store.setAllowedPlantsResolver(() => Session.allowedPlants());
  Store.setSettingsDefaultsResolver(() => Settings.DEFAULTS);

  // SETTINGS — moved to application-shell.mjs (CQ-1 Phase 4 Task 4), alongside
  // SessionUIAdapter/showLoginScreen/EmptyState/PlantSelector/App — see
  // application-shell.mjs's header comment for why this per-user
  // settings catalog travels with that move even though it isn't one of
  // CQ-1's 14 tracked modules. Imported via the __NIMBUS_SHELL bridge
  // destructure at the top of this IIFE.

  // VL_ALERT_ROW_H moved to schedule-workbench.mjs (CQ-1 Phase 3 Task 7),
  // travelling with AlertsUIAdapter.

  // CalendarUI, Plant, and ProdLines moved to plant-and-administration.mjs
  // (CQ-1 Phase 4 Task 1); MasterData and LaborPlanning moved to the same
  // file (CQ-1 Phase 4 Task 2) — see the bridge destructure above and the
  // header comment at the top of this file.

  // LABOR PLANNING — moved to plant-and-administration.mjs (CQ-1 Phase 4
  // Task 2), minus its App._laborSub/App._currentTab reads, which became
  // _activeTabResolvers.laborSub()/.currentTab(). Imported via the
  // __NIMBUS_PLANT_ADMIN bridge destructure at the top of this IIFE.

  // EDIT CALENDAR — moved to schedule-workbench.mjs (CQ-1 Phase 3 Task 7).
  // Imported via the __NIMBUS_WORKBENCH bridge destructure at the top of
  // this IIFE.

  // COLOR WHEEL VIEWER — moved to schedule-workbench.mjs (CQ-1 Phase 3
  // Task 7). Imported via the __NIMBUS_WORKBENCH bridge destructure at the
  // top of this IIFE.

  /* =============================================================================
     COMPUTE — moved to schedule-services.mjs (CQ-1 Phase 2 Task 1). Imported
     via the __NIMBUS_SERVICES bridge destructure at the top of this IIFE.
     ========================================================================== */

  // ALERTS UI ADAPTER — moved to schedule-workbench.mjs (CQ-1 Phase 3 Task 7,
  // a deliberate, documented scope decision — see
  // docs/architecture/cq1-compatibility-inventory.md for the coupling
  // evidence). Imported via the __NIMBUS_WORKBENCH bridge destructure at the
  // top of this IIFE. `VL_ALERT_ROW_H` travels with it.

  /* =============================================================================
     UTILIZATION — moved to schedule-services.mjs (CQ-1 Phase 2 Task 2). Imported
     via the __NIMBUS_SERVICES bridge destructure at the top of this IIFE.
     ========================================================================== */

  /* =============================================================================
     ENGINE — moved to schedule-services.mjs (CQ-1 Phase 2 Task 3). Imported via
     the __NIMBUS_SERVICES bridge destructure at the top of this IIFE.
     ========================================================================== */


  // SESSION UI ADAPTER — moved to application-shell.mjs (CQ-1 Phase 4
  // Task 4), alongside Settings/showLoginScreen/EmptyState/PlantSelector/App.
  // Imported via the __NIMBUS_SHELL bridge destructure at the top of this IIFE.

  // AUTH (LOGIN SCREEN) — showLoginScreen() moved to application-shell.mjs
  // (CQ-1 Phase 4 Task 4). Imported via the __NIMBUS_SHELL bridge
  // destructure at the top of this IIFE.

  // SANDBOX ADAPTER — moved to schedule-workbench.mjs (CQ-1 Phase 3 Task 7,
  // the design doc's explicitly-mandated move). Imported via the
  // __NIMBUS_WORKBENCH bridge destructure at the top of this IIFE.

  // ADMIN COCKPIT — moved to plant-and-administration.mjs (CQ-1 Phase 4 Task
  // 3), verbatim — the single largest module moved in this entire migration
  // (~2,260 lines). Its dispatch to MasterData.render()/Interface.render()/
  // Security.render() in _setSub is a same-file bare reference there (no
  // seam — all four already lived behind the same __NIMBUS_PLANT_ADMIN
  // bridge destructure in this file before this task). Imported via that
  // bridge destructure at the top of this IIFE.

  // PRINTER — moved to schedule-workbench.mjs (CQ-1 Phase 3 Task 7). Imported
  // via the __NIMBUS_WORKBENCH bridge destructure at the top of this IIFE.

  // EMPTY STATE — moved to application-shell.mjs (CQ-1 Phase 4 Task 4).
  // Imported via the __NIMBUS_SHELL bridge destructure at the top of this
  // IIFE.

  // PLANT SELECTOR — moved to application-shell.mjs (CQ-1 Phase 4 Task 4).
  // Imported via the __NIMBUS_SHELL bridge destructure at the top of this
  // IIFE.

  // WELCOME SPLASH — moved to application-shell.mjs (CQ-1 Phase 4 Task 4).
  // Imported via the __NIMBUS_SHELL bridge destructure at the top of this
  // IIFE.

  // APP — moved to application-shell.mjs (CQ-1 Phase 4 Task 4), minus
  // _renderSettingsPane (relocated to Plant in Task 1). Imported via the
  // __NIMBUS_SHELL bridge destructure at the top of this IIFE.

  // MASTER DATA — moved to plant-and-administration.mjs (CQ-1 Phase 4 Task
  // 2). Its one Store._state.masterData write became Store.setMasterData(...)
  // (closing MasterData's tracked §6 exception). Imported via the
  // __NIMBUS_PLANT_ADMIN bridge destructure at the top of this IIFE.

  // INTERFACE — moved to plant-and-administration.mjs (CQ-1 Phase 4 Task 3),
  // verbatim — fully self-contained, zero cross-references to any other of
  // the 14 modules. Imported via the __NIMBUS_PLANT_ADMIN bridge destructure
  // at the top of this IIFE.

  // SECURITY — moved to plant-and-administration.mjs (CQ-1 Phase 4 Task 3),
  // verbatim — fully self-contained, zero cross-references to any other of
  // the 14 modules. Imported via the __NIMBUS_PLANT_ADMIN bridge destructure
  // at the top of this IIFE.

  /* =============================================================================
     BOOTSTRAP
     _bootMain() is the real boot sequence — everything that used to run directly
     inside the DOMContentLoaded handler. It is gated behind Session: the listener
     below only calls it immediately when a session is already cached (page
     reload while signed in); otherwise it shows the mandatory login screen first,
     and showLoginScreen's own sign-in success handler calls App._bootMain() once
     authenticated, so the exact same boot path runs either way.
     ========================================================================== */
  function _bootMain() {
    // Subscribe SessionUIAdapter to session:changed FIRST (CQ-1 Phase 2 Task 5 —
    // Session.signIn/signOut/refresh now emit that event instead of calling
    // _applyGates()/DOM code inline). Then re-apply session-driven UI gates
    // explicitly — this covers the "already signed in on page load" resume path,
    // which never goes through signIn() and so never fires session:changed. The
    // "just signed in" path is covered too: showLoginScreen's signIn() already
    // fired the event (with nobody subscribed yet, since init() hadn't run), so
    // this explicit call is what actually applies the gates for that path as
    // well — a harmless, idempotent single application either way (the pre-split
    // code applied gates twice for a fresh sign-in; _applyGates is idempotent,
    // so once is behaviorally equivalent).
    SessionUIAdapter.init();
    SessionUIAdapter._applyGates();
    // N2: Config.CONCURRENCY_CHECK=false makes every manual save force:true
    // (last-write-wins). Documented escape hatch, but nobody should run the
    // pilot in that mode without seeing it. Logged once per boot + a
    // persistent banner (same chrome band as the What-If sandbox banner).
    if (Config.CONCURRENCY_CHECK === false) {
      ErrorLog.warn('concurrency', 'Config.CONCURRENCY_CHECK is false — task saves run last-write-wins');
      const _ccBanner = document.getElementById('concurrency-banner');
      if (_ccBanner) {
        _ccBanner.textContent = Util.t('ui.concurrency_off_banner');
        _ccBanner.hidden = false;
        document.body.classList.add('concurrency-off');
      }
    }
    // Hydrate per-user settings + role defaults from the cached session blob so the
    // app reflects the user's prefs immediately AND works offline. Session.refresh()
    // below overwrites these with DB truth from /security/me when the network is up.
    try {
      const _u = Session.currentUser();
      if (_u) {
        Store.setUserSettings(_u.settings || {}, 'session-cache');
        Store.setRoleDefaults(_u.role_settings || {}, 'session-cache');
      }
    } catch {}
    // Now that Store carries the resolved per-user prefs, apply the display-scoped
    // ones that must be settled BEFORE the first render (App.init's data-i18n sweep
    // and DarkMode). Both fall back to their offline localStorage caches when no
    // explicit user/role value exists, so a legacy nimbus.locale/nimbus.theme is
    // preserved rather than clobbered by a system default.
    try {
      const us = Store.userSettings || {}, rd = Store.roleDefaults || {};
      const lang = (us.language != null) ? us.language : (rd.language != null ? rd.language : null);
      if (lang && lang !== Util.locale()) {
        Util.setLocale(lang);
        try { localStorage.setItem('nimbus.locale', lang); } catch {}
      }
    } catch {}
    // Re-apply the theme from the resolved pref. Covers the just-signed-in path
    // (DarkMode.init already ran off the offline cache before settings loaded) and
    // is idempotent for the resume path (DarkMode.init runs again right after).
    try { if (typeof NIMBUS !== 'undefined' && NIMBUS.DarkMode?.init) NIMBUS.DarkMode.init(); } catch {}
    // Feed the resolved firstDayOfWeek pref into Flatpickr's default locale so every
    // calendar-style picker created afterwards renders weeks starting on the chosen day.
    App._applyFirstDayOfWeek();
    // Reconcile the cached session role against backend truth (a stale cache is
    // what leaves the admin UI visible while every admin request 403s). Fire-and-
    // forget — it re-applies the gates when it resolves.
    try { Session.refresh(); } catch {}

    // Global hard-error net (captures stack traces, normalized through ErrorLog).
    ErrorLog.installGlobalHandlers();
    // Restore the persisted error-log ring from the previous page load (best-effort).
    try { ErrorLog.restore(); } catch {}
    // Defensively unregister any legacy service workers — none should be installed
    // but a prior experiment could leave one resident.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(rs => {
        if (rs.length) {
          ErrorLog.warn('boot', `Unregistering ${rs.length} legacy service worker(s)`);
          rs.forEach(r => r.unregister());
        }
      }).catch(() => {});
    }

    /* ---- Performance watchdogs (long-task, JS heap, main-thread freeze) ---- */
    try {
      if ('PerformanceObserver' in window &&
          PerformanceObserver.supportedEntryTypes &&
          PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 250) {
              const attr = entry.attribution?.[0]?.name || 'n/a';
              ErrorLog.warn('perf', `longtask ${Math.round(entry.duration)}ms (attribution: ${attr})`);
            }
          }
        }).observe({ entryTypes: ['longtask'] });
      }
    } catch { /* longtask API not supported */ }

    setInterval(() => {
      if (document.hidden) return; // skip heap sampling while the tab is backgrounded
      const m = performance && performance.memory;
      if (!m) return;
      const usedMB  = m.usedJSHeapSize  / 1048576;
      const limitMB = m.jsHeapSizeLimit / 1048576;
      const ratio   = usedMB / limitMB;
      if (ratio > 0.85) {
        ErrorLog.warn('memory',
          `JS heap ${usedMB.toFixed(0)}/${limitMB.toFixed(0)} MB (${Math.round(ratio * 100)}%)`);
      }
    }, 30_000);

    // Freeze watchdog: a setInterval that records actual elapsed time. If the
    // gap is much larger than the schedule, the main thread was blocked.
    // Caveat: hidden-tab timers are throttled (Chrome/Edge: ~1 tick/min under
    // intensive throttling, and Windows window occlusion counts as hidden), so
    // the in-tick hidden guard alone can't keep _lastTick fresh across a
    // background stint — the visibilitychange reset below handles resume.
    let _lastTick = Date.now();
    document.addEventListener('visibilitychange', () => { _lastTick = Date.now(); });
    setInterval(() => {
      const now   = Date.now();
      // Belt-and-suspenders alongside the visibilitychange reset, in case a
      // throttled tick races the event on resume.
      if (document.hidden) { _lastTick = now; return; }
      const drift = now - _lastTick;
      _lastTick = now;
      if (drift > 2000) {
        const blockedMs = drift - 1000;
        if (drift > 15_000) {
          // A real synchronous block this long is implausible (and would show up
          // as a longtask entry) — this is system sleep / lock screen / residual
          // background-tab throttling.
          ErrorLog.info('freeze', `~${blockedMs}ms timer gap — likely system sleep or background-tab throttling, not a JS block`);
        } else {
          ErrorLog.warn('freeze', `Main thread blocked ~${blockedMs}ms`);
        }
      }
    }, 1000);

    // Ctrl+Alt+L → open Admin Cockpit log tab (gated by the same per-role page
    // access as the Admin Cockpit tab itself; App.goto('admin') already guards
    // this, but the early-return here is a redundant defense-in-depth check).
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (!Session.canAccessTab('admin')) return;
        App.goto('admin'); AdminCockpit.gotoSub('logs');
      }
    });

    // ` (backtick) → go back to previous tab  |  Alt+H → Dashboard
    document.addEventListener('keydown', e => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.activeElement?.isContentEditable) return;
      if (e.key === '`' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (App._prevTab) App.goto(App._prevTab);
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        App.goto('home');
      }
    });

    try { Timeline.init();    } catch (e) { ErrorLog.error('boot', `Timeline.init: ${e.message}`); }
    try { Table.init();       } catch (e) { ErrorLog.error('boot', `Table.init: ${e.message}`); }
    try { Inspector.init();   } catch (e) { ErrorLog.error('boot', `Inspector.init: ${e.message}`); }
    try { Hierarchy.init();   } catch (e) { ErrorLog.error('boot', `Hierarchy.init: ${e.message}`); }
    try { Dashboard.init();   } catch (e) { ErrorLog.error('boot', `Dashboard.init: ${e.message}`); }
    try { ContextMenu.init(); } catch (e) { ErrorLog.error('boot', `ContextMenu.init: ${e.message}`); }
    try { GanttFilter.init();     } catch (e) { ErrorLog.error('boot', `GanttFilter.init: ${e.message}`); }
    try { AdminCockpit.init();    } catch (e) { ErrorLog.error('boot', `AdminCockpit.init: ${e.message}`); }
    try { LaborPlanning.init();   } catch (e) { ErrorLog.error('boot', `LaborPlanning.init: ${e.message}`); }

    // Refresh plant-aware modules when master data changes.
    // Writes lineSettings directly (no per-line emit) and fires a single coalesced
    // 'lineSettings:change' at the end to avoid an O(N*M) fan-out at boot.
    Store.subscribe(evt => {
      if (evt.type === 'master-data-changed') {
        let touched = 0;
        try {
          touched = Store.applyMasterLinesToSettings();
        } catch (e) { ErrorLog.error('boot', `master-data lineSettings sync: ${e.message}`); }
        if (touched) {
          // lineSettings[].plant was just rewritten in bulk above via direct writes
          // (not setLineSetting), so the plant index is stale — rebuild it before the
          // emit so tasksForSelectedPlant / _tasksByPlant reflect the new assignments.
          Store.rebuildPlantIndex();
          Store.emit({ type: 'lineSettings:change', line: null, source: 'master-data-bulk' });
        }
        try { if (typeof Hierarchy !== 'undefined') Hierarchy.render(); } catch {}
        try { if (typeof ProdLines !== 'undefined' && App._currentTab === 'masterdata' && App._currentMasterSub === 'lines') ProdLines.render(); } catch {}
      }
    }, 'App.masterData');
    try { Plant.init();       } catch (e) { ErrorLog.error('boot', `Plant.init: ${e.message}`); }
    try { MaterialGrids.init(); } catch (e) { ErrorLog.error('boot', `MaterialGrids.init: ${e.message}`); }
    try { PlantSelector.init();  } catch (e) { ErrorLog.error('boot', `PlantSelector.init: ${e.message}`); }
    try { App.init();            } catch (e) { ErrorLog.error('boot', `App.init: ${e.message}`); }
    // ProdLines has no async init — it renders on-demand when its tab is activated.
    // TimelineNav init deferred until after first Timeline render
    setTimeout(() => { try { TimelineNav.init(); } catch (e) { ErrorLog.error('boot', `TimelineNav.init: ${e.message}`); } }, 150);
    // DependencyOverlay init deferred similarly
    setTimeout(() => { try { DependencyOverlay.init(); } catch (e) { ErrorLog.error('boot', `DependencyOverlay.init: ${e.message}`); } }, 160);
    // Sandbox init
    try { SandboxAdapter.init(); } catch (e) { ErrorLog.error('boot', `SandboxAdapter.init: ${e.message}`); }

    // Install the unified input pipeline AFTER Timeline + Table are up so
    // their internal DataSet / grid API exist when we wire the listeners.
    // Brief delay lets vis-timeline finish its first layout.
    setTimeout(() => {
      try { Interaction.install(); }
      catch (e) { ErrorLog.error('boot', `Interaction.install: ${e.message}`); }
    }, 80);

    ErrorLog.renderBadge();

    // Navigate to home only after the first task payload arrives so charts
    // have data on their first render (Persistence.load is async).
    const _firstLoad = Store.subscribe(evt => {
      if (evt.type === 'tasks:bulk') {
        _firstLoad();
        // Land on the user's saved default landing view (pref('landingView')),
        // falling back to the Dashboard. Auth + plant resolution have completed
        // by now (session hydrated above; first task payload has arrived).
        App._gotoLanding();
        // Anchor Gantt to today as the leftmost column on first visit (3-day Day view).
        setTimeout(() => Timeline.setView('day'), 200);
      }
    }, 'App.firstLoad');
    // One-shot: apply the user's defaultPlant preference once plant metadata is
    // authoritative (the first master-data load — knownPlants() prefers master-data
    // plants). This is what makes the defaultPlant SETTING actually impact the app:
    //   • an explicit defaultPlant (known + allowed) → auto-select it. An explicit,
    //     cross-device preference beats the per-browser "last-used" plant, so a
    //     returning user lands on their default instead of re-picking manually;
    //   • else a valid remembered plant from a prior session → leave the existing
    //     flow (selection stays null → the user picks a plant manually via the
    //     header plant selector, as before);
    //   • else, when the user can see exactly ONE plant → auto-select that one.
    // Setting the plant (source 'default-plant') triggers Persistence.loadForPlant
    // via the usual 'plant:selected' subscribers.
    let _defaultPlantApplied = false;
    const _offDefaultPlant = Store.subscribe(evt => {
      if (evt.type !== 'master-data-changed') return;
      _offDefaultPlant();
      if (_defaultPlantApplied) return;
      _defaultPlantApplied = true;
      try {
        if (Store.selectedPlant) return;                 // already selected — never override
        const known = Store.knownPlants();               // already allowedPlants()-scoped
        // An explicit default plant wins over the per-browser "last-used" plant so a
        // returning user lands on their configured default rather than picking manually.
        const dp = Store.pref('defaultPlant');
        if (dp && known.includes(dp)) { Store.setSelectedPlant(dp, 'default-plant'); return; }
        // No explicit default → preserve the existing flow: a valid remembered plant
        // leaves selection null so the user picks a plant manually (unchanged behavior).
        const cached = Persistence._rememberedPlant();
        if (cached && known.includes(cached)) return;
        // Neither a default nor a remembered plant, but the user can see exactly one.
        if (!dp && known.length === 1) Store.setSelectedPlant(known[0], 'default-plant');
      } catch (e) { ErrorLog.warn('boot', `default-plant apply failed: ${e.message}`); }
    }, 'App.defaultPlant');

    // Stateless backend: scope the first load to the remembered plant so boot
    // doesn't pull every plant's order book. We intentionally do NOT set
    // Store.selectedPlant here — that keeps selectedPlant null so the user still
    // makes the explicit selection via the header plant selector. When they pick
    // the same plant as last time, loadForPlant() no-ops (data already loaded);
    // if they pick a different one, it re-scopes. No remembered plant → unscoped.
    // (The defaultPlant one-shot above may set a selection after master data loads.)
    const _bootPlant = Persistence._rememberedPlant();
    Persistence.load(_bootPlant ? { plant: _bootPlant } : {});
  }
  App._bootMain = _bootMain;

  function _loadApiKey(attempt) {
    const bust = `_=${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    fetch(`${Config.API_BASE}/security/client-config?${bust}`, { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => Util.setApiKey(d.apiKey))
      .catch(() => {
        if (attempt < 3) setTimeout(() => _loadApiKey(attempt + 1), 1000 * 2 ** (attempt - 1));
      });
  }

  function _domReadyGate() {
    // Learn the NIMBUS_API_KEY deployment-config stopgap (see backend/security/
    // CLAUDE.md) as early as possible, in parallel with everything below — the
    // route is public/same-origin, so by the time a signed-in admin reaches the
    // Security or Table Browser tabs this has long since resolved. Fire-and-
    // forget, same pattern as ErrorLog._shipNow's own infra calls; a failure
    // here just leaves Util's api-key empty, matching the pre-existing no-op
    // behavior when NIMBUS_API_KEY is unset on the backend.
    // One blip at page load used to leave admin calls 401-ing until a manual refresh, so:
    // check r.ok (a 5xx HTML body is not config), bypass the corporate proxy's URL-keyed
    // cache, and retry 3x with backoff (1s, 2s, 4s). Still fire-and-forget.
    _loadApiKey(1);

    // Mandatory login gate — blocks the whole app until authenticated against
    // user_security. A cached session (page reload while signed in) skips
    // straight to _bootMain(); otherwise showLoginScreen() takes over and calls
    // App._bootMain() itself once Session.signIn() resolves.
    //
    // The 12h local cache lifetime is checked ONLY here, at boot — not via a
    // live in-tab timer — so a session older than Config.SESSION_MAX_AGE_MS
    // is cleared and treated exactly like "not logged in" on the next reload.
    if (Session.isExpired()) { Session.clearExpired(); showLoginScreen({ expired: true }); return; }
    if (!Session.currentUser()) { showLoginScreen(); return; }
    _bootMain();
  }

  // app.js is now loaded via a dynamically-injected <script> (see app-entry.mjs),
  // which is NOT parser-blocking — the DOMContentLoaded event can (and in
  // practice does) fire before this file is even fetched. A bare
  // addEventListener('DOMContentLoaded', ...) would then never run. Mirror the
  // readyState fallback already used in nimbus-intelligence.js's boot gate.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _domReadyGate);
  } else {
    // readyState is already past 'loading' here (the common case, since this
    // script is fetched/injected well after the HTML shell parses) — calling
    // _domReadyGate() synchronously would run _bootMain()/Table.init() etc.
    // BEFORE this IIFE reaches its own `return {...}` below, i.e. before the
    // `const NIMBUS = ...` assignment above has actually completed. Any boot
    // code that reads the bare `NIMBUS` global (schedule-workbench.mts and
    // friends do) throws "NIMBUS is not defined" in that case — caught and
    // merely logged by each module's boot try/catch, so it fails silently
    // (e.g. Table.init() aborts before subscribing to Store, so the Orders
    // grid never repopulates even though data loads fine). Deferring to a
    // microtask guarantees this script's synchronous execution — including
    // the IIFE's return — has fully finished first, matching the safety the
    // DOMContentLoaded-listener branch above already has.
    queueMicrotask(_domReadyGate);
  }

  /* Public namespace for inline onclick handlers in index.html */
  return {
    App, Engine, Alerts, AlertsUIAdapter, Timeline, Table, Inspector,
    Dashboard, Calendar, CalendarUI, Plant, ProdLines, Persistence, Modal, Toast, Store, Util, Config, Settings,
    Utilization, ContextMenu, Hierarchy,
    Selection, UndoStack, Interaction,
    ErrorLog, AdminCockpit,
    TimelineNav, GanttFilter, DependencyOverlay, Sandbox, SandboxAdapter, Printer,
    OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer, PriorityListViewer,
    PlantSelector, EmptyState, MasterData, PriorityListMapping,
    LaborPlanning, Interface, Security, SystemConfig, CalendarSync,
    Session, SessionUIAdapter, showLoginScreen, MaterialGrids
  };
})();

// Expose the namespace for ES modules (Alert Monitor pane reads globalThis.NIMBUS);
// `const NIMBUS` is a script-scope lexical binding and is NOT a window property.
globalThis.NIMBUS = NIMBUS;
