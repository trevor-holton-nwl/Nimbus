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
   math, and Persistence calling Alerts.scheduleRecompute()) are resolved by
   an injected seam (`Persistence.setCalendarService`, wired below) and a
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
   sites, not the three originally named (_bulkFix(true), _bulkFix(false),
   Selection.clear(), and a fourth, _unscheduleSelected(), missed by the
   plan's prose); all four now wire through real addEventListener calls
   instead. Writing the first-ever test for _onDataSetUpdate also found the
   module's own header comment describing fixed-order drag protection didn't
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
   See docs/architecture/cq1-compatibility-inventory.md §1 for the full
   ownership map, including where the modules below are headed in Phase 4.

   Module map (load order) — modules still defined in THIS file:
     SessionUIAdapter   — session gates / user-settings modal / profile /
                         password self-service remnant (pure state/API moved
                         to schedule-data.mjs's Session)
     showLoginScreen    — standalone login-screen function (moves Phase 4 Task 4)
     EmptyState         — reusable "select a plant" prompt (moves Phase 4 Task 4)
     PlantSelector      — global plant combobox (moves Phase 4 Task 4)
     WelcomeSplash      — first-run splash screen (moves Phase 4 Task 4)
     App                — bootstrap + tab switching (moves Phase 4 Task 4)
   ========================================================================== */

// CACHE-BUST GUARD moved to web/app-entry.mjs's runCacheBustGuard() (CQ-1): it
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

  if (typeof window === 'undefined' || !window.__NIMBUS_FOUNDATION || !window.__NIMBUS_STATE || !window.__NIMBUS_SERVICES || !window.__NIMBUS_DATA || !window.__NIMBUS_WORKBENCH || !window.__NIMBUS_PLANT_ADMIN) {
    throw new Error('NIMBUS boot error: application-foundation.mjs/schedule-state.mjs/schedule-services.mjs/schedule-data.mjs/schedule-workbench.mjs/plant-and-administration.mjs did not load before app.js — check app-entry.mjs.');
  }
  const { Config, Util, PerfMonitor, VirtualList, ErrorLog, Toast, Modal } = window.__NIMBUS_FOUNDATION;
  const { Store, Selection, UndoStack, Sandbox } = window.__NIMBUS_STATE;
  const { Calendar, Compute, Alerts, Utilization, Engine } = window.__NIMBUS_SERVICES;
  const { Persistence, CalendarSync, Session } = window.__NIMBUS_DATA;
  const { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter, Dashboard, Interaction, OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, AlertsUIAdapter } = window.__NIMBUS_WORKBENCH;
  const { CalendarUI, Plant, ProdLines, MasterData, LaborPlanning, Interface, Security, AdminCockpit, setActiveTabResolvers: _setPlantAdminTabResolvers } = window.__NIMBUS_PLANT_ADMIN;
  // Inject the calendar-capacity seam schedule-data.mjs's Persistence needs (it may never
  // statically import schedule-services.mjs — see that file's header). Arrow-function
  // wrappers, not bare method references: Calendar's methods read `this._runCache`/
  // `this._runBlocks` internally, so they must be invoked with Calendar as the receiver.
  Persistence.setCalendarService({
    beginRun: (plant) => Calendar._beginRun(plant),
    endRun: () => Calendar._endRun(),
    nextAvailable: (line, from, durationMs) => Calendar.nextAvailable(line, from, durationMs),
    workWindow: (line, date) => Calendar.workWindow(line, date),
  });
  // Injected getter seam so plant-and-administration.mjs's Plant/LaborPlanning
  // can ask "am I currently the visible tab/sub-tab?" without a bare reference
  // to `App` (which stays in app.js until Phase 4 Task 4 — see this phase's
  // plan's Architecture section, seam #2). `App` is still a local app.js
  // const at this point in the file, resolved lazily at call time, same as
  // every other seam in this migration.
  _setPlantAdminTabResolvers({
    currentTab: () => App._currentTab,
    currentMasterSub: () => App._currentMasterSub,
    laborSub: () => App._laborSub,
  });
  window.t = (key, vars) => Util.t(key, vars);
  Util.setPreferenceResolver(key => Store.pref(key));
  Util.setActorResolver(() => Session.actor());
  Util.setUtilizationResolver((from, days, tasks) => Utilization.computeMatrix(from, days, tasks));
  ErrorLog.setPlantResolver(() => Store.selectedPlant);
  ErrorLog.setRouteResolver(() => ({ tab: App._currentTab, ganttSub: App._ganttSub }));
  ErrorLog.setAdminGate(() => Session.isAdmin());
  ErrorLog.setBadgeClickHandler(() => { App.goto('admin'); AdminCockpit.gotoOvTab('logs'); });
  Store.setAllowedPlantsResolver(() => Session.allowedPlants());
  Store.setSettingsDefaultsResolver(() => Settings.DEFAULTS);

  /* =============================================================================
     SETTINGS — per-user settings catalog + system defaults (single source of
     truth on the frontend; mirrors the backend contract). Placed AFTER Util and
     BEFORE Store so Store.pref() can resolve defaults at runtime.

     CATALOG entry shape: { key, category, type, default, tier, region }
       category : 'personalization' | 'workflow' | 'profile'
       type     : coarse editor/value hint for the (later) settings UI
       default  : the SYSTEM default — last link in the resolution chain
       tier     : the LOWEST tier that may SET the key ('user' | 'role' | 'system').
                  Every key here is user-settable, so all are 'user'; roles supply
                  defaults for all EXCEPT the three "user tier only" workflow keys
                  (gridLayout / pinnedPlants / pinnedLines), which are inherently
                  per-person and never role-overridable.
       region   : true only for keys eligible for the (NO-OP today) {plant} region
                  fallback — timezone & firstDayOfWeek.
     timeFormat / dateFormat / timezone are DISPLAY-ONLY (they change how values
     render, never the stored data).
     ========================================================================== */
  const Settings = (() => {
    const CATALOG = [
      // ── Personalization ────────────────────────────────────────────────
      // (category MUST match the modal pane the control renders in — see
      //  _renderPersonalizationPane / _renderWorkflowPane below.)
      { key: 'theme',        category: 'personalization', type: 'enum',   default: 'light', tier: 'user', region: false },
      { key: 'language',     category: 'personalization', type: 'enum',   default: 'en',    tier: 'user', region: false },
      { key: 'defaultPlant', category: 'personalization', type: 'plant',  default: null,    tier: 'user', region: false },
      { key: 'landingView',  category: 'personalization', type: 'object', default: null,    tier: 'user', region: false },
      // gridLayout / pinnedPlants / pinnedLines are USER-TIER ONLY — inherently
      // per-person, so roles never supply defaults for them.
      { key: 'gridLayout',   category: 'personalization', type: 'object', default: null, tier: 'user', region: false },
      { key: 'pinnedPlants', category: 'personalization', type: 'array',  default: [],   tier: 'user', region: false },
      { key: 'pinnedLines',  category: 'personalization', type: 'array',  default: [],   tier: 'user', region: false },
      // ── Workflow ───────────────────────────────────────────────────────
      { key: 'timeFormat',        category: 'workflow', type: 'enum',     default: '12h',              tier: 'user', region: false },
      { key: 'dateFormat',        category: 'workflow', type: 'enum',     default: 'M j, Y',           tier: 'user', region: false },
      { key: 'timezone',          category: 'workflow', type: 'timezone', default: 'America/New_York', tier: 'user', region: true  },
      { key: 'firstDayOfWeek',    category: 'workflow', type: 'enum',     default: 0,                  tier: 'user', region: true  },
      { key: 'optimizerDefaults', category: 'workflow', type: 'object',   default: null,               tier: 'user', region: false },
    ];

    // { key: default } map derived from CATALOG (last link in Store.pref precedence).
    const DEFAULTS = {};
    for (const e of CATALOG) DEFAULTS[e.key] = e.default;

    const _byKey = {};
    for (const e of CATALOG) _byKey[e.key] = e;

    return {
      CATALOG,
      DEFAULTS,
      isRegion(key)   { return !!(_byKey[key] && _byKey[key].region); },
      byCategory(cat) { return CATALOG.filter(e => e.category === cat); },
    };
  })();

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


  /* =============================================================================
     SESSION UI ADAPTER — DOM/settings-pane remnant of the mandatory-login client
     session (CQ-1 Phase 2 Task 5). Session's pure state/API half (currentUser/
     actor/isAdmin/allowedPlants/pref/setPref/flushPrefs/signIn/signOut/refresh/
     onAuthDenied/updateCachedUser) moved to schedule-data.mjs, bridged in as the
     `Session` const above. This adapter owns everything that touches the DOM:
     gates (Admin tab visibility, header user-settings button, error-log badge),
     the User Settings modal (tab switching, Personalization/Workflow panes,
     Profile self-service, password change), all built on top of Session's
     public API. Mirrors the Phase 1 Sandbox/SandboxAdapter split exactly:
     `Session.signIn`/`signOut`/`refresh` now emit `{type:'session:changed', kind}`
     instead of calling `_applyGates()`/DOM code inline; `SessionUIAdapter.init()`
     (called once from `_bootMain()`, alongside `SandboxAdapter.init()`) is the
     sole subscriber.
       SessionUIAdapter.init()        — subscribe to session:changed (call once, at boot)
       SessionUIAdapter._applyGates() — re-hides the Admin tab button / header
                                         user-settings button / error-log badge for
                                         non-admins; called after every session:changed
                                         AND once explicitly at boot (see _bootMain) so
                                         a resumed cached session (which never fires
                                         signIn(), so never emits) re-gates too.
     ========================================================================== */
  const SessionUIAdapter = {
    init() {
      Store.subscribe(evt => {
        if (evt.type !== 'session:changed') return;
        SessionUIAdapter._applyGates();
        if (evt.kind === 'refresh') {
          // Mirrors the pre-split refresh()'s own DOM-adjacent tail exactly — Session
          // (schedule-data.mjs) only reports the FACTS (isAdmin(), plantAccessChanged);
          // every actual DOM/tab-navigation effect happens here.
          try { if (typeof PlantSelector !== 'undefined') PlantSelector._refreshOptions(); } catch {}
          // If we just lost admin while sitting on the Admin tab, leave it.
          if (!Session.isAdmin() && typeof App !== 'undefined' && App._currentTab === 'admin') {
            try { App.goto('home'); } catch {}
          }
          try {
            if (evt.plantAccessChanged) Toast.show(t('sec.plant_access_changed'), 'warn');
            if (typeof PlantSelector !== 'undefined') PlantSelector._reflectSelection();
          } catch {}
        }
      }, 'SessionUIAdapter');
    },

    _applyGates() {
      const adminBtn = document.querySelector('.tab-btn[data-tab="admin"]');
      if (adminBtn) adminBtn.hidden = !Session.isAdmin();
      SessionUIAdapter._renderUserButton();
      try { ErrorLog.renderBadge(); } catch {}
    },

    // Populates/hides the header user-settings icon button (#user-settings-btn, static
    // markup in index.html) and wires its click (once) to open the User Settings modal.
    _renderUserButton() {
      const btn = document.getElementById('user-settings-btn');
      if (!btn) return;
      const u = Session.currentUser();
      btn.hidden = !u;
      if (!u) return;
      if (!btn._wired) {
        btn._wired = true;
        btn.addEventListener('click', () => {
          const current = Session.currentUser();
          if (!current) return;
          const signedInEl = document.getElementById('us-signed-in-as');
          const roleEl = document.getElementById('us-role');
          const firstEl = document.getElementById('us-first-name');
          const lastEl = document.getElementById('us-last-name');
          if (signedInEl) signedInEl.textContent = t('sec.signed_in_as', { username: current.username });
          if (roleEl) roleEl.textContent = current.role;
          if (firstEl) firstEl.value = current.first_name || '';
          if (lastEl) lastEl.value = current.last_name || '';
          // Build the Personalization / Workflow controls fresh so they reflect
          // the current resolved prefs each time the modal opens.
          try { SessionUIAdapter._renderSettingsPanes(); } catch (e) { ErrorLog.error('settings', `Render settings panes failed: ${e.message}`); }
          Modal.open('modal-user-settings');
        });
      }
      const signOutBtn = document.getElementById('us-signout-btn');
      if (signOutBtn && !signOutBtn._wired) {
        signOutBtn._wired = true;
        signOutBtn.addEventListener('click', Session.signOut);
      }
      const saveBtn = document.getElementById('us-save-btn');
      if (saveBtn && !saveBtn._wired) {
        saveBtn._wired = true;
        saveBtn.addEventListener('click', SessionUIAdapter.saveProfile);
      }
      const changePwBtn = document.getElementById('us-change-password-btn');
      if (changePwBtn && !changePwBtn._wired) {
        changePwBtn._wired = true;
        changePwBtn.addEventListener('click', SessionUIAdapter.changePassword);
      }
      // Wire the User Settings tab bar (Personalization / Workflow / Profile).
      // _renderSettingsPanes() populates the Personalization/Workflow panes on
      // modal open; this only toggles which pane + button is active. Wired once.
      document.querySelectorAll('#modal-user-settings [data-us-tab]').forEach(tabBtn => {
        if (tabBtn._wired) return;
        tabBtn._wired = true;
        tabBtn.addEventListener('click', () => SessionUIAdapter._showUserTab(tabBtn.getAttribute('data-us-tab')));
      });
    },

    // Toggle the active User Settings tab: highlight the button and reveal only
    // the matching pane (#us-tab-<name>). Names mirror Settings category ids.
    _showUserTab(name) {
      document.querySelectorAll('#modal-user-settings [data-us-tab]').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-us-tab') === name);
      });
      ['personalization', 'workflow', 'profile'].forEach(n => {
        const body = document.getElementById('us-tab-' + n);
        if (body) body.hidden = (n !== name);
      });
    },

    /* ── Personalization + Workflow panes (Phase-1 self-service settings) ─────
       Rebuilt each time the modal opens so every control reflects the current
       resolved pref (Store.pref = user ?? role ?? system default). Labels use
       t() inline — App.init()'s one-shot [data-i18n] sweep never runs over these
       dynamically-inserted nodes. Each control persists via Session.setPref()
       and, where it changes the running app, applies the effect immediately. */
    _optTag(value, label, selected) {
      const v = String(value);
      return `<option value="${v}"${v === String(selected) ? ' selected' : ''}>${label}</option>`;
    },

    // Repaint the display surfaces whose datetime labels are baked at render time,
    // so a timeFormat/dateFormat change is reflected without waiting for the next
    // natural re-render. Best-effort — never throws into the change handler.
    _repaintDisplayFormat() {
      if (typeof NIMBUS === 'undefined') return;
      // Timeline bar tooltips + blackout titles are baked at build time.
      try { if (NIMBUS.Timeline?.rebuild) NIMBUS.Timeline.rebuild(); } catch {}
      try { if (NIMBUS.TimelineNav?.render) NIMBUS.TimelineNav.render(); } catch {}
      // AG Grid date columns render through pref-aware valueFormatters — force a
      // cell repaint so the new format shows without an edit/scroll.
      try { if (NIMBUS.Table?._api) NIMBUS.Table._api.refreshCells({ force: true }); } catch {}
      // Inspector schedule rows are baked into innerHTML — re-render the current
      // selection so its dates repaint too.
      try {
        const id = NIMBUS.Inspector?._currentId;
        if (id && NIMBUS.Inspector?._render) {
          const task = NIMBUS.Store?.tasks?.[id];
          if (task) NIMBUS.Inspector._render(task);
        }
      } catch {}
    },

    _htmlEsc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    // Landing-view tab choices (admin tab only for admins) and their sub-views.
    _landingTabDefs() {
      const defs = [
        ['home',       t('tab.home')],
        ['gantt',      t('tab.gantt')],
        ['labor',      t('us.tab_labor')],
        ['masterdata', t('tab.masterdata')],
      ];
      if (Session.isAdmin()) defs.push(['admin', t('tab.admin')]);
      return defs;
    },
    _landingSubDefs(tab) {
      if (tab === 'gantt')      return [['timeline', t('us.landing_timeline')], ['orders', t('tab.table')]];
      if (tab === 'masterdata') return [['lines', t('tab.production_lines')], ['plant', t('tab.plant')]];
      return null;   // home / labor / admin land on the tab with no sub-view here
    },

    // Render the small removable list of pinned values below a pinned combobox.
    _renderPinnedList(listEl, key) {
      if (!listEl) return;
      const items = (Session.pref(key) || []).slice();
      if (!items.length) {
        listEl.innerHTML = `<div class="us-pinned-empty">${t('us.pinned_none')}</div>`;
        return;
      }
      listEl.innerHTML = items.map(v => {
        const safe = SessionUIAdapter._htmlEsc(v);
        return `<span class="us-pinned-item"><span class="us-pinned-name">${safe}</span>` +
          `<button type="button" class="us-pin-remove" data-val="${safe}" title="${t('us.pin_remove')}" aria-label="${t('us.pin_remove')}">×</button></span>`;
      }).join('');
    },

    /* Searchable pin picker (scale-safe — never a chip selector). optionsFn()
       supplies the full candidate list; already-pinned values are filtered out.
       Choosing appends to Session.pref(key) via setPref; the removable list
       handles unpin. afterChange() lets the caller refresh the affected surface
       immediately. */
    _initPinnedCombo({ inputId, dropdownId, listId, key, optionsFn, noneMsg, afterChange }) {
      const input    = document.getElementById(inputId);
      const dropdown = document.getElementById(dropdownId);
      const listEl   = document.getElementById(listId);
      if (!input || !dropdown || !listEl) return;
      let filtered = [];
      let activeIdx = -1;

      const open  = () => { dropdown.hidden = false; input.setAttribute('aria-expanded', 'true'); };
      const close = () => { dropdown.hidden = true; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); };
      const highlight = () => {
        const els = dropdown.querySelectorAll('.us-combo-option');
        els.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        const a = els[activeIdx]; if (a) a.scrollIntoView({ block: 'nearest' });
      };
      const add = (val) => {
        if (val == null) return;
        const cur = Session.pref(key) || [];
        if (!cur.includes(val)) Session.setPref(key, [...cur, val]);
        input.value = '';
        SessionUIAdapter._renderPinnedList(listEl, key);
        close();
        try { afterChange && afterChange(); } catch {}
      };
      const renderList = (query) => {
        const already = new Set(Session.pref(key) || []);
        const all = (optionsFn() || []).filter(o => !already.has(o));
        const q = (query || '').trim().toLowerCase();
        filtered = q ? all.filter(o => o.toLowerCase().includes(q)) : all.slice();
        if (!filtered.length) {
          dropdown.innerHTML = `<div class="us-combo-empty">${all.length ? t('us.no_matches') : noneMsg}</div>`;
          activeIdx = -1;
          return;
        }
        dropdown.innerHTML = filtered.map((o, i) => {
          const safe = SessionUIAdapter._htmlEsc(o);
          return `<div class="us-combo-option" role="option" data-val="${safe}" data-idx="${i}"><span>${safe}</span></div>`;
        }).join('');
        activeIdx = 0;
        highlight();
        dropdown.querySelectorAll('.us-combo-option').forEach(el => {
          el.addEventListener('mousedown', e => { e.preventDefault(); add(el.dataset.val); });
        });
      };

      input.addEventListener('focus', () => { renderList(input.value); open(); });
      input.addEventListener('input', () => { renderList(input.value); open(); });
      input.addEventListener('keydown', e => {
        if (dropdown.hidden) {
          if (e.key === 'ArrowDown' || e.key === 'Enter') { renderList(input.value); open(); e.preventDefault(); }
          return;
        }
        if (e.key === 'ArrowDown')    { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); highlight(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(); }
        else if (e.key === 'Enter')   { e.preventDefault(); const v = filtered[activeIdx]; if (v != null) add(v); }
        else if (e.key === 'Escape')  { close(); input.blur(); }
      });
      input.addEventListener('blur', () => setTimeout(close, 120));

      SessionUIAdapter._renderPinnedList(listEl, key);
      listEl.addEventListener('click', e => {
        const btn = e.target.closest('.us-pin-remove');
        if (!btn) return;
        const val = btn.dataset.val;
        Session.setPref(key, (Session.pref(key) || []).filter(x => x !== val));
        SessionUIAdapter._renderPinnedList(listEl, key);
        try { afterChange && afterChange(); } catch {}
      });
    },

    _renderSettingsPanes() {
      SessionUIAdapter._renderPersonalizationPane();
      SessionUIAdapter._renderWorkflowPane();
    },

    _renderPersonalizationPane() {
      const pane = document.getElementById('us-tab-personalization');
      if (!pane) return;
      // Seed from the ACTUALLY-applied theme (body.dark) so the control matches what
      // the user sees: DarkMode may have applied 'dark' from the legacy nimbus.theme
      // cache even when no user_settings.theme pref exists yet (pref() → 'light').
      const theme = document.body.classList.contains('dark') ? 'dark' : (Session.pref('theme') || 'light');
      const lang  = Session.pref('language');
      const langOpts = [
        ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'],
      ].map(([c, n]) => SessionUIAdapter._optTag(c, n, lang)).join('');
      // Landing view — tab select + (dependent) sub-view select.
      const lv       = Session.pref('landingView') || {};
      const lvTab    = SessionUIAdapter._landingTabDefs().some(([v]) => v === lv.tab) ? lv.tab : 'home';
      const landingTabOpts = SessionUIAdapter._landingTabDefs().map(([v, n]) => SessionUIAdapter._optTag(v, n, lvTab)).join('');
      const lvSubDefs = SessionUIAdapter._landingSubDefs(lvTab);
      const landingSubOpts = lvSubDefs
        ? lvSubDefs.map(([v, n]) => SessionUIAdapter._optTag(v, n, lv.sub)).join('')
        : '';
      // Saved grid layout — the on/off toggle mirrors Session.pref('gridLayout') null-ness.
      const gridLayoutOn = Session.pref('gridLayout') != null;
      pane.innerHTML = `
        <div class="form-row">
          <label data-i18n="us.theme">${t('us.theme')}</label>
          <select id="us-pref-theme">
            ${SessionUIAdapter._optTag('light', t('us.theme_light'), theme)}
            ${SessionUIAdapter._optTag('dark',  t('us.theme_dark'),  theme)}
          </select>
        </div>
        <div class="form-row">
          <label data-i18n="us.language">${t('us.language')}</label>
          <select id="us-pref-language">${langOpts}</select>
        </div>
        <div class="form-row">
          <label data-i18n="us.default_plant">${t('us.default_plant')}</label>
          <div class="us-combo" id="us-plant-combo">
            <input type="text" id="us-plant-input" class="us-combo-input" autocomplete="off" spellcheck="false"
                   placeholder="${t('us.default_plant_ph')}" role="combobox" aria-haspopup="listbox" aria-expanded="false">
            <button type="button" class="us-combo-clear" id="us-plant-clear" title="${t('us.default_plant_clear')}" hidden>×</button>
            <div class="us-combo-dropdown" id="us-plant-dropdown" role="listbox" hidden></div>
          </div>
          <p class="us-field-hint">${t('us.default_plant_hint')}</p>
        </div>
        <div class="form-row">
          <label data-i18n="us.landing_view">${t('us.landing_view')}</label>
          <div class="us-landing-row">
            <select id="us-landing-tab">${landingTabOpts}</select>
            <select id="us-landing-sub"${landingSubOpts ? '' : ' hidden'}>${landingSubOpts || ''}</select>
          </div>
          <p class="us-field-hint">${t('us.landing_view_hint')}</p>
        </div>
        <div class="form-row">
          <label data-i18n="us.grid_layout">${t('us.grid_layout')}</label>
          <label class="us-toggle-row">
            <input type="checkbox" id="us-grid-layout-toggle"${gridLayoutOn ? ' checked' : ''}>
            <span>${t('us.grid_layout_toggle')}</span>
          </label>
          <button type="button" class="btn btn-ghost sm" id="us-grid-layout-reset" style="margin-top:8px">${t('us.grid_layout_reset')}</button>
          <p class="us-field-hint">${t('us.grid_layout_hint')}</p>
        </div>
        <div class="form-row">
          <label data-i18n="us.pinned_plants">${t('us.pinned_plants')}</label>
          <div class="us-combo" id="us-pinplant-combo">
            <input type="text" id="us-pinplant-input" class="us-combo-input" autocomplete="off" spellcheck="false"
                   placeholder="${t('us.pinned_plants_ph')}" role="combobox" aria-haspopup="listbox" aria-expanded="false">
            <div class="us-combo-dropdown" id="us-pinplant-dropdown" role="listbox" hidden></div>
          </div>
          <div class="us-pinned-list" id="us-pinplant-list"></div>
          <p class="us-field-hint">${t('us.pinned_plants_hint')}</p>
        </div>
        <div class="form-row">
          <label data-i18n="us.pinned_lines">${t('us.pinned_lines')}</label>
          <div class="us-combo" id="us-pinline-combo">
            <input type="text" id="us-pinline-input" class="us-combo-input" autocomplete="off" spellcheck="false"
                   placeholder="${t('us.pinned_lines_ph')}" role="combobox" aria-haspopup="listbox" aria-expanded="false">
            <div class="us-combo-dropdown" id="us-pinline-dropdown" role="listbox" hidden></div>
          </div>
          <div class="us-pinned-list" id="us-pinline-list"></div>
          <p class="us-field-hint">${t('us.pinned_lines_hint')}</p>
        </div>`;

      const themeSel = pane.querySelector('#us-pref-theme');
      themeSel.addEventListener('change', () => {
        const isDark = themeSel.value === 'dark';
        // DarkMode.set() does the write-through (Session.setPref + nimbus.theme cache
        // + repaint); fall back to a bare persist if the intelligence layer is absent.
        try {
          if (typeof NIMBUS !== 'undefined' && NIMBUS.DarkMode?.set) NIMBUS.DarkMode.set(isDark);
          else Session.setPref('theme', isDark ? 'dark' : 'light');
        } catch { Session.setPref('theme', isDark ? 'dark' : 'light'); }
      });

      const langSel = pane.querySelector('#us-pref-language');
      langSel.addEventListener('change', () => {
        // LangSwitcher.set() persists via Session.setPref, keeps nimbus.locale in
        // sync, and reloads so the whole UI re-renders in the chosen locale.
        try {
          if (typeof NIMBUS !== 'undefined' && NIMBUS.LangSwitcher?.set) NIMBUS.LangSwitcher.set(langSel.value);
          else { Session.setPref('language', langSel.value); location.reload(); }
        } catch { Session.setPref('language', langSel.value); location.reload(); }
      });

      SessionUIAdapter._initDefaultPlantCombo(pane);

      // ── Default landing view (tab + dependent sub-view) ──────────────────
      const landingTabSel = pane.querySelector('#us-landing-tab');
      const landingSubSel = pane.querySelector('#us-landing-sub');
      const _persistLanding = () => {
        const tab = landingTabSel.value;
        const subs = SessionUIAdapter._landingSubDefs(tab);
        const sub  = (subs && landingSubSel && !landingSubSel.hidden) ? landingSubSel.value : null;
        Session.setPref('landingView', { tab, sub });
      };
      if (landingTabSel) {
        landingTabSel.addEventListener('change', () => {
          const subs = SessionUIAdapter._landingSubDefs(landingTabSel.value);
          if (landingSubSel) {
            if (subs) {
              landingSubSel.innerHTML = subs.map(([v, n]) => SessionUIAdapter._optTag(v, n, subs[0][0])).join('');
              landingSubSel.hidden = false;
            } else {
              landingSubSel.innerHTML = '';
              landingSubSel.hidden = true;
            }
          }
          _persistLanding();
        });
      }
      if (landingSubSel) landingSubSel.addEventListener('change', _persistLanding);

      // ── Saved grid layout (toggle + reset) ───────────────────────────────
      const gridToggle = pane.querySelector('#us-grid-layout-toggle');
      if (gridToggle) {
        gridToggle.addEventListener('change', () => {
          try { Table._setLayoutEnabled(gridToggle.checked); } catch {}
        });
      }
      const gridReset = pane.querySelector('#us-grid-layout-reset');
      if (gridReset) {
        gridReset.addEventListener('click', () => {
          let ok = false;
          try { ok = Table._resetGridLayout(); } catch {}
          Toast.show(ok ? t('us.grid_layout_reset_done') : t('us.grid_layout_no_grid'), ok ? 'success' : 'warn');
        });
      }

      // ── Pinned plants / lines ─────────────────────────────────────────────
      SessionUIAdapter._initPinnedCombo({
        inputId: 'us-pinplant-input', dropdownId: 'us-pinplant-dropdown', listId: 'us-pinplant-list',
        key: 'pinnedPlants', optionsFn: () => Store.knownPlants(), noneMsg: t('us.no_plants'),
        afterChange: () => { try { PlantSelector._reflectSelection(); } catch {} },
      });
      SessionUIAdapter._initPinnedCombo({
        inputId: 'us-pinline-input', dropdownId: 'us-pinline-dropdown', listId: 'us-pinline-list',
        key: 'pinnedLines', optionsFn: () => Store.allLines().slice().sort((a, b) => a.localeCompare(b)),
        noneMsg: t('us.no_lines'),
        afterChange: () => { try { Hierarchy.render(); } catch {} },
      });
    },

    // Searchable plant combobox (scale-safe — never a chip list). Bound to
    // Session.pref('defaultPlant'); writes via Session.setPref('defaultPlant',
    // code|null). Modeled on the header PlantSelector, scoped to this modal instance.
    _initDefaultPlantCombo(pane) {
      const input    = pane.querySelector('#us-plant-input');
      const dropdown = pane.querySelector('#us-plant-dropdown');
      const clearBtn = pane.querySelector('#us-plant-clear');
      const combo    = pane.querySelector('#us-plant-combo');
      if (!input || !dropdown || !combo) return;
      let filtered = [];
      let activeIdx = -1;

      const options = () => Store.knownPlants();          // already allowedPlants()-scoped
      const current = () => Session.pref('defaultPlant') || null;

      const reflect = () => {
        const dp = current();
        input.value = dp ? `${dp}` : '';
        combo.classList.toggle('has-value', !!dp);
        clearBtn.hidden = !dp;
      };
      const open  = () => { dropdown.hidden = false; input.setAttribute('aria-expanded', 'true'); };
      const close = () => { dropdown.hidden = true; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); };
      const highlight = () => {
        const items = dropdown.querySelectorAll('.us-combo-option');
        items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        const a = items[activeIdx]; if (a) a.scrollIntoView({ block: 'nearest' });
      };
      const choose = (plant) => { Session.setPref('defaultPlant', plant || null); reflect(); close(); input.blur(); };

      const renderList = (query) => {
        const all = options();
        const q = (query || '').trim().toLowerCase();
        const looksLikeLabel = current() && q === `${current()}`.toLowerCase();
        const fq = looksLikeLabel ? '' : q;
        filtered = fq ? all.filter(p => p.toLowerCase().includes(fq)) : all.slice();
        if (!filtered.length) {
          dropdown.innerHTML = `<div class="us-combo-empty">${all.length ? t('us.no_matches') : t('us.no_plants')}</div>`;
          activeIdx = -1;
          return;
        }
        const sel = current();
        dropdown.innerHTML = filtered.map((p, i) =>
          `<div class="us-combo-option${p === sel ? ' selected' : ''}" role="option" data-plant="${p}" data-idx="${i}">
             <span class="us-combo-option-prefix">${t('ui.plant_label')}</span><span>${p}</span>
           </div>`).join('');
        activeIdx = Math.max(0, filtered.indexOf(sel));
        highlight();
        dropdown.querySelectorAll('.us-combo-option').forEach(el => {
          el.addEventListener('mousedown', e => { e.preventDefault(); choose(el.dataset.plant); });
        });
      };

      input.addEventListener('focus', () => { renderList(input.value); open(); });
      input.addEventListener('input', () => { renderList(input.value); open(); });
      input.addEventListener('keydown', e => {
        if (dropdown.hidden) {
          if (e.key === 'ArrowDown' || e.key === 'Enter') { renderList(input.value); open(); e.preventDefault(); }
          return;
        }
        if (e.key === 'ArrowDown')      { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); highlight(); }
        else if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(); }
        else if (e.key === 'Enter')     { e.preventDefault(); const p = filtered[activeIdx]; if (p) choose(p); }
        else if (e.key === 'Escape')    { close(); reflect(); input.blur(); }
      });
      input.addEventListener('blur', () => setTimeout(() => { close(); reflect(); }, 120));
      clearBtn.addEventListener('mousedown', e => e.preventDefault());
      clearBtn.addEventListener('click', () => { choose(null); input.focus(); });
      reflect();
    },

    _renderWorkflowPane() {
      const pane = document.getElementById('us-tab-workflow');
      if (!pane) return;
      const tf = Session.pref('timeFormat');
      const df = Session.pref('dateFormat');
      const now = new Date();
      const sample = (tok) => {
        try { if (typeof flatpickr !== 'undefined' && flatpickr.formatDate) return flatpickr.formatDate(now, tok); } catch {}
        return tok;
      };
      const dfTokens = ['M j, Y', 'm/d/Y', 'd/m/Y', 'Y-m-d', 'j M Y'];
      if (df && !dfTokens.includes(df)) dfTokens.unshift(df);   // keep a role/legacy value selectable
      const dfOpts = dfTokens.map(tok => SessionUIAdapter._optTag(tok, sample(tok), df)).join('');
      const fdow = Number(Session.pref('firstDayOfWeek'));
      const fdowSel = (fdow === 1) ? 1 : 0;
      // Optimizer defaults — seed the strategy + option toggles the dialog opens with.
      const od      = Session.pref('optimizerDefaults');
      const odMode  = (od && ['spt', 'changeover', 'combined'].includes(od.mode)) ? od.mode : 'changeover';
      const odFixed = od ? od.respectFixed !== false : true;
      const odCal   = od ? od.respectCalendar !== false : true;
      pane.innerHTML = `
        <div class="form-row">
          <label data-i18n="us.time_format">${t('us.time_format')}</label>
          <select id="us-pref-timeformat">
            ${SessionUIAdapter._optTag('12h', t('us.time_12h'), tf)}
            ${SessionUIAdapter._optTag('24h', t('us.time_24h'), tf)}
          </select>
        </div>
        <div class="form-row">
          <label data-i18n="us.date_format">${t('us.date_format')}</label>
          <select id="us-pref-dateformat">${dfOpts}</select>
          <p class="us-field-hint">${t('us.date_format_hint')}</p>
        </div>
        <div class="form-row">
          <label data-i18n="us.first_day">${t('us.first_day')}</label>
          <select id="us-pref-firstday">
            ${SessionUIAdapter._optTag(0, t('us.first_day_sun'), fdowSel)}
            ${SessionUIAdapter._optTag(1, t('us.first_day_mon'), fdowSel)}
          </select>
          <p class="us-field-hint">${t('us.first_day_hint')}</p>
        </div>
        <div class="form-row">
          <label data-i18n="us.opt_defaults">${t('us.opt_defaults')}</label>
          <select id="us-opt-mode">
            ${SessionUIAdapter._optTag('spt',        t('us.opt_mode_spt'),        odMode)}
            ${SessionUIAdapter._optTag('changeover', t('us.opt_mode_changeover'), odMode)}
            ${SessionUIAdapter._optTag('combined',   t('us.opt_mode_smart'),      odMode)}
          </select>
          <label class="us-toggle-row" style="margin-top:8px">
            <input type="checkbox" id="us-opt-fixed"${odFixed ? ' checked' : ''}>
            <span>${t('us.opt_respect_fixed')}</span>
          </label>
          <label class="us-toggle-row">
            <input type="checkbox" id="us-opt-calendar"${odCal ? ' checked' : ''}>
            <span>${t('us.opt_respect_calendar')}</span>
          </label>
          <button type="button" class="btn btn-ghost sm" id="us-opt-clear" style="margin-top:8px"${od ? '' : ' hidden'}>${t('us.opt_defaults_clear')}</button>
          <p class="us-field-hint">${t('us.opt_defaults_hint')}</p>
        </div>`;

      const tfSel = pane.querySelector('#us-pref-timeformat');
      tfSel.addEventListener('change', () => { Session.setPref('timeFormat', tfSel.value); SessionUIAdapter._repaintDisplayFormat(); });
      const dfSel = pane.querySelector('#us-pref-dateformat');
      dfSel.addEventListener('change', () => { Session.setPref('dateFormat', dfSel.value); SessionUIAdapter._repaintDisplayFormat(); });

      const fdSel = pane.querySelector('#us-pref-firstday');
      if (fdSel) fdSel.addEventListener('change', () => {
        const v = fdSel.value === '1' ? 1 : 0;
        Session.setPref('firstDayOfWeek', v);
        try { App._applyFirstDayOfWeek(); } catch {}
      });

      // Optimizer defaults — preserve any stored preset; the dialog's run() keeps
      // it fresh from the user's last actual run.
      const modeSel  = pane.querySelector('#us-opt-mode');
      const fixedChk = pane.querySelector('#us-opt-fixed');
      const calChk   = pane.querySelector('#us-opt-calendar');
      const writeOpt = () => {
        const existing = Session.pref('optimizerDefaults') || {};
        Session.setPref('optimizerDefaults', {
          mode: modeSel.value,
          preset: ['horizon', '2w'].includes(existing.preset) ? existing.preset : 'horizon',
          respectFixed: fixedChk.checked,
          respectCalendar: calChk.checked,
        });
        const clr = pane.querySelector('#us-opt-clear');
        if (clr) clr.hidden = false;
      };
      if (modeSel)  modeSel.addEventListener('change', writeOpt);
      if (fixedChk) fixedChk.addEventListener('change', writeOpt);
      if (calChk)   calChk.addEventListener('change', writeOpt);
      const optClear = pane.querySelector('#us-opt-clear');
      if (optClear) optClear.addEventListener('click', () => {
        Session.setPref('optimizerDefaults', null);
        SessionUIAdapter._renderWorkflowPane();
      });
    },

    // Self-service: PATCH /security/me with just this user's own name fields.
    // Keeps the modal open with the typed values on failure so the user can
    // retry; on success, updates the local cache (via Session.updateCachedUser —
    // the private nimbus.session KEY constant lives only in schedule-data.mjs)
    // and closes.
    async saveProfile() {
      const firstEl = document.getElementById('us-first-name');
      const lastEl = document.getElementById('us-last-name');
      const first_name = firstEl ? firstEl.value.trim() : '';
      const last_name = lastEl ? lastEl.value.trim() : '';
      try {
        const r = await Util.fetchTraced(`${Config.API_BASE}/security/me`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ first_name, last_name }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.detail || `HTTP ${r.status}`);
        }
        const updated = await r.json();
        Session.updateCachedUser({ first_name: updated.first_name || null, last_name: updated.last_name || null });
        Modal.close('modal-user-settings');
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Save profile failed: ${e.message}`);
      }
    },

    // Self-service: PATCH /security/me/password. Unlike saveProfile(), the
    // caller's identity header alone isn't enough here — the backend re-verifies
    // current_password (auth.change_own_password) since there's no session token
    // binding the header to a prior login. Fields are cleared on success but the
    // modal stays open (mirrors the admin panel's non-closing _savePassword).
    async changePassword() {
      const curEl = document.getElementById('us-current-password');
      const newEl = document.getElementById('us-new-password');
      const confEl = document.getElementById('us-confirm-password');
      const current_password = curEl ? curEl.value : '';
      const new_password = newEl ? newEl.value : '';
      const confirm_password = confEl ? confEl.value : '';
      if (!new_password || new_password.length < 4) {
        Toast.show(t('sec.password_too_short'), 'error');
        return;
      }
      if (new_password !== confirm_password) {
        Toast.show(t('sec.password_mismatch'), 'error');
        return;
      }
      try {
        const r = await Util.fetchTraced(`${Config.API_BASE}/security/me/password`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ current_password, new_password }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.detail || `HTTP ${r.status}`);
        }
        if (curEl) curEl.value = '';
        if (newEl) newEl.value = '';
        if (confEl) confEl.value = '';
        Toast.show(t('sec.password_updated'), 'success');
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Change password failed: ${e.message}`);
      }
    },
  };

  /* =============================================================================
     AUTH (LOGIN SCREEN) — mandatory full-screen gate, JS-built only (no static
     index.html markup for the overlay itself — mirrors WelcomeSplash's technique:
     build a full-viewport overlay, append to document.body, call t(...) inline for
     every label rather than relying on the [data-i18n] sweep, which only runs
     inside App.init() — i.e. AFTER this gate has already decided whether to run it).
     showLoginScreen() is called from the DOMContentLoaded gate (see _bootMain below)
     when no session is cached; on successful sign-in it tears itself down and calls
     App._bootMain() — the same boot path a resumed session takes.
     ========================================================================== */
  function showLoginScreen() {
    const root = document.createElement('div');
    root.className = 'login-screen';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', t('sec.login_title'));

    const card = document.createElement('div');
    card.className = 'login-card';
    card.innerHTML = `
      <div class="login-title">${t('sec.login_title')}</div>
      <form id="login-form" style="display:flex;flex-direction:column;gap:10px;">
        <input type="text" id="login-username" autocomplete="username" autocapitalize="off"
               placeholder="${t('sec.username')}" aria-label="${t('sec.username')}">
        <input type="password" id="login-password" autocomplete="current-password"
               placeholder="${t('sec.password')}" aria-label="${t('sec.password')}">
        <button type="submit" class="btn btn-primary" id="login-submit-btn">${t('sec.sign_in')}</button>
      </form>
      <div class="login-error" id="login-error"></div>`;

    root.appendChild(card);
    document.body.appendChild(root);

    const userInp   = card.querySelector('#login-username');
    const passInp   = card.querySelector('#login-password');
    const errEl     = card.querySelector('#login-error');
    const submitBtn = card.querySelector('#login-submit-btn');

    userInp.addEventListener('input', () => {
      const pos = userInp.selectionStart;
      userInp.value = userInp.value.toLowerCase();
      userInp.setSelectionRange(pos, pos);
    });

    async function _submit() {
      errEl.textContent = '';
      submitBtn.disabled = true;
      try {
        await Session.signIn(userInp.value.trim().toLowerCase(), passInp.value);
        root.remove();
        App._bootMain();
      } catch (e) {
        // Deliberately generic — never reveal whether the username itself was wrong.
        errEl.textContent = t('sec.login_invalid');
        submitBtn.disabled = false;
      }
    }

    card.querySelector('#login-form').addEventListener('submit', e => { e.preventDefault(); _submit(); });

    userInp.focus();
  }

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

  /* =============================================================================
     EMPTY STATE — reusable "select a plant" prompt rendered into a container
     whenever Store.selectedPlant is null. Each module that scopes by plant
     calls EmptyState.render(el, opts) instead of its normal render path.
     ========================================================================== */
  const EmptyState = {
    render(container, opts = {}) {
      if (!container) return;
      const title = opts.title || t('empty.select_plant_title');
      const msg = opts.msg || t('empty.select_plant_msg');
      const icon = opts.icon || '◨';
      container.innerHTML =
        `<div class="nimbus-empty-state">
           <div class="nes-icon">${icon}</div>
           <div class="nes-title">${title}</div>
           <div class="nes-msg">${msg}</div>
         </div>`;
    }
  };

  /* =============================================================================
     PLANT SELECTOR — global, searchable combobox in the topbar.
     Owns the selected-plant UI; writes to Store.selectedPlant; subscribes to
     'plant:selected' so external mutations (e.g. OptimizeDialog) stay in sync.
     ========================================================================== */
  const PlantSelector = {
    _root:     null,
    _input:    null,
    _dropdown: null,
    _clearBtn: null,
    _combobox: null,
    _options:  [],
    _filtered: [],
    _activeIdx: -1,
    _open:     false,

    init() {
      PlantSelector._root     = document.getElementById('header-plant-selector');
      PlantSelector._input    = document.getElementById('hps-input');
      PlantSelector._dropdown = document.getElementById('hps-dropdown');
      PlantSelector._clearBtn = document.getElementById('hps-clear');
      PlantSelector._combobox = document.getElementById('hps-combobox');
      if (!PlantSelector._root) return;

      PlantSelector._input.addEventListener('focus', () => {
        PlantSelector._refreshOptions();
        PlantSelector._renderDropdown(PlantSelector._input.value);
        PlantSelector._openDropdown();
      });
      PlantSelector._input.addEventListener('input', () => {
        PlantSelector._renderDropdown(PlantSelector._input.value);
        PlantSelector._openDropdown();
      });
      PlantSelector._input.addEventListener('keydown', PlantSelector._onKeydown);
      PlantSelector._input.addEventListener('blur', () => {
        // Defer close so clicks on dropdown items can fire first.
        setTimeout(() => {
          PlantSelector._closeDropdown();
          PlantSelector._restoreLabel();
        }, 120);
      });
      PlantSelector._clearBtn.addEventListener('mousedown', e => e.preventDefault());
      PlantSelector._clearBtn.addEventListener('click', () => {
        Store.setSelectedPlant(null, 'header');
        PlantSelector._input.value = '';
        PlantSelector._reflectSelection();
        PlantSelector._input.focus();
      });

      document.addEventListener('click', e => {
        if (!PlantSelector._root.contains(e.target)) PlantSelector._closeDropdown();
      });

      Store.subscribe(evt => {
        if (evt.type === 'plant:selected') {
          if (evt.source !== 'header') PlantSelector._reflectSelection();
        }
        if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate' || evt.type === 'lineSettings:change') {
          PlantSelector._refreshOptions();
        }
      }, 'PlantSelector');

      PlantSelector._refreshOptions();
      PlantSelector._reflectSelection();
    },

    _refreshOptions() {
      PlantSelector._options = Store.knownPlants();
    },

    _reflectSelection() {
      const plant = Store.selectedPlant;
      const isSet = !!plant;
      PlantSelector._input.value = isSet ? `${plant}` : '';
      PlantSelector._combobox.classList.toggle('has-value', isSet);
      PlantSelector._clearBtn.hidden = !isSet;
    },

    _restoreLabel() {
      // After blur, reset the typed query back to the canonical "Plant <id>" label.
      PlantSelector._reflectSelection();
    },

    _openDropdown() {
      PlantSelector._dropdown.hidden = false;
      PlantSelector._open = true;
      PlantSelector._input.setAttribute('aria-expanded', 'true');
    },
    _closeDropdown() {
      PlantSelector._dropdown.hidden = true;
      PlantSelector._open = false;
      PlantSelector._activeIdx = -1;
      PlantSelector._input.setAttribute('aria-expanded', 'false');
    },

    _renderDropdown(query) {
      const q = (query || '').trim().toLowerCase();
      // If the input still holds the canonical plant label, do not use
      // it as a filter — show the full list.
      const looksLikeLabel = Store.selectedPlant
        && query.trim().toLowerCase() === `${Store.selectedPlant}`.toLowerCase();
      const filterQ = looksLikeLabel ? '' : q;
      const base = filterQ
        ? PlantSelector._options.filter(p => p.toLowerCase().includes(filterQ))
        : PlantSelector._options.slice();

      // Surface the user's pinned plants at the top (scale-safe quick access at
      // 50+ plants). _filtered order MUST match the rendered option order so
      // keyboard nav (data-idx) stays correct.
      let pinnedSet;
      try { pinnedSet = new Set(Store.pref('pinnedPlants') || []); } catch { pinnedSet = new Set(); }
      const pinned = base.filter(p => pinnedSet.has(p));
      const rest   = base.filter(p => !pinnedSet.has(p));
      PlantSelector._filtered = [...pinned, ...rest];

      if (!PlantSelector._filtered.length) {
        PlantSelector._dropdown.innerHTML =
          `<div class="hps-empty">${PlantSelector._options.length ? 'No matches' : 'No plant data loaded'}</div>`;
        PlantSelector._activeIdx = -1;
        return;
      }
      const sel = Store.selectedPlant;
      const optHtml = (p, i) => {
        const isSel = p === sel;
        const isPin = pinnedSet.has(p);
        return `<div class="hps-option${isSel ? ' selected' : ''}" role="option" data-plant="${p}" data-idx="${i}">
          <span class="hps-option-prefix">${t('ui.plant_label')}</span><span>${p}</span>
          ${isPin ? '<span class="hps-pin-ico" aria-hidden="true">📌</span>' : ''}
        </div>`;
      };
      let ddHtml = '';
      PlantSelector._filtered.forEach((p, i) => {
        if (pinned.length && i === 0) ddHtml += `<div class="hps-section">${t('us.pinned_section')}</div>`;
        if (pinned.length && rest.length && i === pinned.length) ddHtml += `<div class="hps-section">${t('us.all_plants_section')}</div>`;
        ddHtml += optHtml(p, i);
      });
      PlantSelector._dropdown.innerHTML = ddHtml;
      PlantSelector._activeIdx = Math.max(0, PlantSelector._filtered.indexOf(sel));
      PlantSelector._highlightActive();
      PlantSelector._dropdown.querySelectorAll('.hps-option').forEach(el => {
        el.addEventListener('mousedown', e => {
          e.preventDefault();
          PlantSelector._select(el.dataset.plant);
        });
      });
    },

    _highlightActive() {
      const items = PlantSelector._dropdown.querySelectorAll('.hps-option');
      items.forEach((el, i) => el.classList.toggle('active', i === PlantSelector._activeIdx));
      const active = items[PlantSelector._activeIdx];
      if (active) active.scrollIntoView({ block: 'nearest' });
    },

    _onKeydown(e) {
      if (!PlantSelector._open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') {
          PlantSelector._renderDropdown(PlantSelector._input.value);
          PlantSelector._openDropdown();
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        PlantSelector._activeIdx = Math.min(PlantSelector._activeIdx + 1, PlantSelector._filtered.length - 1);
        PlantSelector._highlightActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        PlantSelector._activeIdx = Math.max(PlantSelector._activeIdx - 1, 0);
        PlantSelector._highlightActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = PlantSelector._filtered[PlantSelector._activeIdx];
        if (pick) PlantSelector._select(pick);
      } else if (e.key === 'Escape') {
        PlantSelector._closeDropdown();
        PlantSelector._restoreLabel();
        PlantSelector._input.blur();
      }
    },

    _select(plant) {
      Store.setSelectedPlant(plant, 'header');
      PlantSelector._reflectSelection();
      PlantSelector._closeDropdown();
      PlantSelector._input.blur();
    }
  };

  /* =============================================================================
     WELCOME SPLASH — one-time page-load overlay directing the user to pick a plant.
     Shows on boot (only when selectedPlant is null) and self-dismisses on
     plant:selected. Never re-shows mid-session even if the plant is cleared.
     ========================================================================== */
  const WelcomeSplash = (() => {
    let _el    = null;   // root overlay element
    let _svg   = null;   // arrow SVG element
    let _rafId = null;   // rAF loop id for live arrow positioning
    let _shown = false;  // one-shot guard

    function _buildDOM() {
      const root = document.createElement('div');
      root.className = 'welcome-splash';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', t('aria.welcome_dialog'));

      const card = document.createElement('div');
      card.className = 'welcome-splash-card';

      card.innerHTML = `
        <div class="ws-orb">🧹</div>
        <div class="ws-title">${t('ui.welcome_title')}</div>
        <p class="ws-subtitle">${t('ui.welcome_subtitle')}</p>`;

      root.appendChild(card);
      return root;
    }

    function _buildArrowSVG() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ws-arrow-svg');
      svg.setAttribute('aria-hidden', 'true');

      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      defs.innerHTML = `
        <filter id="ws-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>`;
      svg.appendChild(defs);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'rgba(184,121,26,0.70)');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-dasharray', '5 4');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('filter', 'url(#ws-glow)');
      svg.appendChild(path);

      const arrowHead = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      arrowHead.setAttribute('class', 'ws-arrow-tip');
      arrowHead.setAttribute('fill', 'rgba(184,121,26,0.90)');
      arrowHead.setAttribute('filter', 'url(#ws-glow)');
      svg.appendChild(arrowHead);

      svg._path      = path;
      svg._arrowHead = arrowHead;
      return svg;
    }

    function _positionArrow() {
      if (!_el || !_svg) return;
      const plantEl = document.getElementById('header-plant-selector');
      const card    = _el.querySelector('.welcome-splash-card');
      if (!plantEl || !card) return;

      const pr = plantEl.getBoundingClientRect();
      const cr = card.getBoundingClientRect();

      // Arrow base: left-center of card
      const x0 = cr.left - 10;
      const y0 = cr.top + cr.height / 2;

      // Arrow tip: bottom-middle of plant selector
      const x1 = pr.left + pr.width * 0.25;
      const y1 = pr.bottom + 6;

      // L-shaped path: go left to plant selector's X, then straight up to its bottom
      const cornerX = x1;
      const cornerY = y0;
      _svg._path.setAttribute('d', `M ${x0} ${y0} L ${cornerX} ${cornerY} L ${x1} ${y1}`);

      // Arrowhead: pointing along the final vertical segment (upward)
      const angle = Math.atan2(y1 - cornerY, x1 - cornerX);
      const hs = 8; // half-spread of arrowhead base
      const al = 14; // length of arrowhead
      const bx = x1 - Math.cos(angle) * al;
      const by = y1 - Math.sin(angle) * al;
      const lx = bx + Math.cos(angle + Math.PI / 2) * hs;
      const ly = by + Math.sin(angle + Math.PI / 2) * hs;
      const rx = bx - Math.cos(angle + Math.PI / 2) * hs;
      const ry = by - Math.sin(angle + Math.PI / 2) * hs;
      _svg._arrowHead.setAttribute('points', `${x1},${y1} ${lx},${ly} ${rx},${ry}`);
    }

    function _startArrowLoop() {
      function tick() {
        _positionArrow();
        _rafId = requestAnimationFrame(tick);
      }
      _rafId = requestAnimationFrame(tick);
    }

    function _stopArrowLoop() {
      if (_rafId != null) { cancelAnimationFrame(_rafId); _rafId = null; }
    }

    return {
      init() {
        if (_shown) return;
        _shown = true;

        _el  = _buildDOM();
        _svg = _buildArrowSVG();
        document.body.appendChild(_el);
        document.body.appendChild(_svg);
        document.body.classList.add('welcome-active');

        // Position arrow immediately, then keep it live as viewport changes.
        requestAnimationFrame(() => { _positionArrow(); _startArrowLoop(); });

        Store.subscribe(evt => {
          if (evt.type === 'plant:selected' && evt.plant) WelcomeSplash.dismiss();
        }, 'WelcomeSplash');

        // Pause the rAF loop when the tab is hidden so we're not burning CPU
        // doing layout thrash for a viewport nobody is looking at.
        if (typeof App !== 'undefined' && App.registerPausable) {
          App.registerPausable(WelcomeSplash);
        }
      },

      pause() { _stopArrowLoop(); },
      resume() { if (_el && _rafId == null) _startArrowLoop(); },

      dismiss() {
        if (!_el) return;
        _stopArrowLoop();
        document.body.classList.remove('welcome-active');
        _el.classList.add('ws-dismissing');
        if (_svg) _svg.style.opacity = '0';
        if (_svg) _svg.style.transition = 'opacity 0.35s ease-in';
        setTimeout(() => {
          _el?.remove();  _el  = null;
          _svg?.remove(); _svg = null;
        }, 460);
      },
    };
  })();

  /* =============================================================================
     APP — bootstrap, tab switching, side-panel + resize handles.
     ========================================================================== */
  const App = {
    _currentTab: 'home',
    _currentMasterSub: 'lines',
    _ganttSub: 'timeline',
    _laborSub: 'aggregate',
    _pausables: new Set(),

    // Register any object with pause()/resume() to be auto-paused on tab hide.
    registerPausable(obj) {
      if (obj && (typeof obj.pause === 'function' || typeof obj.resume === 'function')) {
        App._pausables.add(obj);
      }
    },

    init() {
      /* Apply locale translations to static HTML elements */
      document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
      });
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.dataset.i18nTitle);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
      });

      /* Tab buttons */
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => App.goto(btn.dataset.tab);
      });

      /* Manage Master Data sub-tabs (Production Lines / Plant) */
      document.querySelectorAll('.md-master-subtabs .admin-subtab').forEach(btn => {
        btn.onclick = () => App.gotoMasterSub(btn.dataset.mdMaster);
      });

      /* Timeline toolbar view buttons */
      document.querySelectorAll('.gantt-toolbar .seg-btn[data-view]').forEach(btn => {
        btn.onclick = () => Timeline.setView(btn.dataset.view);
      });

      /* Alert bell */
      document.getElementById('alert-bell').onclick = () => AlertsUIAdapter.toggleDrawer();

      /* Resize handles for side panels */
      App._wireResize('left',  document.getElementById('left-sidebar'));
      App._wireResize('right', document.getElementById('right-sidebar'));

      /* Right inspector collapsed on load — reopens automatically when an order is clicked */
      document.getElementById('right-sidebar').classList.add('collapsed');

      /* Modal backdrop click = close */
      document.querySelectorAll('.modal-backdrop').forEach(b => {
        b.addEventListener('click', e => { if (e.target === b) Modal.close(b.id); });
      });

      /* Autosave on store mutations. Skip 'refresh' — those rows came FROM the server
         during conflict reconciliation, so writing them back would be a pointless echo. */
      Store.subscribe(evt => { if (evt.source !== 'refresh') Persistence._autosave(); }, 'Persistence.autosave');

      /* Track which tasks need to be written to the backend on next saveAll(). Optimize
         ('engine' source) marks its ids force so the authoritative reschedule bypasses
         the version check. 'refresh' is ignored — _refreshTasks already reconciled those. */
      Store.subscribe(evt => {
        if (evt.source === 'refresh') return;
        const force = evt.source === 'engine';
        if (evt.type === 'task:update') {
          Persistence._dirtyIds.add(String(evt.id));
          if (force) Persistence._forceIds.add(String(evt.id));
        }
        if (evt.type === 'tasks:bulkUpdate') evt.ids.forEach(id => {
          Persistence._dirtyIds.add(String(id));
          if (force) Persistence._forceIds.add(String(id));
        });
        if (evt.type === 'tasks:bulk') { Persistence._dirtyIds.clear(); Persistence._forceIds.clear(); }
      }, 'Persistence.dirty');

      /* Reload tasks when the user switches to a different plant */
      Store.subscribe(evt => {
        if (evt.type === 'plant:selected' && evt.plant && evt.source !== 'restore') {
          Persistence.loadForPlant(evt.plant);
        }
      }, 'Persistence.plantLoad');

      /* Keep alerts + dashboard in sync */
      Store.subscribe(evt => {
        // Any change touching schedule/fixed/calendar → recompute alerts.
        if (evt.type === 'task:update' || evt.type === 'tasks:bulk'
            || evt.type === 'tasks:bulkUpdate' || evt.type === 'fixed:change'
            || evt.type === 'calendar:change' || evt.type === 'blocks:change'
            || evt.type === 'plantBlocks:change') {
            Alerts.scheduleRecompute();
        }
        // Alert drawer always reflects current state if open
        if (evt.type === 'alerts:change') {
          const d = document.getElementById('alert-drawer');
          if (d && d.classList.contains('open') && typeof AlertsUIAdapter.renderDrawer === 'function') AlertsUIAdapter.renderDrawer();
          AlertsUIAdapter.renderBell();
        }
        // Blocks / calendar changes → re-render whichever sub-tab is active
        const onMaster = (sub) => App._currentTab === 'masterdata' && App._currentMasterSub === sub;
        if (evt.type === 'blocks:change' || evt.type === 'calendar:change') {
          if (onMaster('plant')) Plant.render();
          if (onMaster('lines')) ProdLines.render();
        }
        if (evt.type === 'plantBlocks:change') {
          if (onMaster('plant')) Plant.render();
          if (onMaster('lines')) ProdLines.render();
        }
        if (evt.type === 'lineSettings:change') {
          if (onMaster('plant')) Plant.render();
          if (onMaster('lines')) ProdLines.render();
        }
        if (evt.type === 'plant:selected') {
          ProdLines._lineFilter = '';
          if (onMaster('lines')) ProdLines.render();
        }
      }, 'App.sync');

      /* Redraw on window resize */
      window.addEventListener('resize', Util.debounce(() => {
        if (App._currentTab === 'gantt') Timeline.redraw();
        if (App._currentTab === 'home') {
          if (Dashboard._chartToday) Dashboard._chartToday.resize();
        }
      }, 120));

      /* Pause rAF loops and admin polling when the tab is hidden — saves CPU
         when the user has the app open but is in a different tab. */
      document.addEventListener('visibilitychange', () => {
        const hidden = document.hidden;
        App._pausables.forEach(p => {
          try { hidden ? p.pause?.() : p.resume?.(); }
          catch (e) { ErrorLog.warn('visibility', `Pausable threw: ${e.message}`); }
        });
        if (hidden) {
          try { AdminCockpit._stopHealthPolling?.(); } catch {}
        } else if (App._currentTab === 'admin') {
          try { AdminCockpit._startHealthPolling?.(); } catch {}
        }
      });
    },

    goto(tab) {
      // Admin Cockpit is admin-only — blocks the tab button, the Log button's click
      // handler, and the Ctrl+Alt+L shortcut simultaneously (all three route through here).
      if (tab === 'admin' && !Session.isAdmin()) return;

      // Redirect legacy 'table' references to the Orders sub-tab inside Scheduling Board
      if (tab === 'table') { App.goto('gantt'); App.gotoGanttSub('orders'); return; }

      // Collapse line accordions when leaving the masterdata tab entirely
      if (App._currentTab === 'masterdata' && tab !== 'masterdata') {
        document.querySelectorAll('details.line-accordion[open]').forEach(d => d.removeAttribute('open'));
      }
      if (App._currentTab === 'admin' && tab !== 'admin') {
        try { AdminCockpit._stopHealthPolling(); } catch {}
      }
      if (App._currentTab && App._currentTab !== tab) App._prevTab = App._currentTab;
      App._currentTab = tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(tab + '-tab').classList.add('active');
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
      });
      if (tab === 'gantt') {
        App.gotoGanttSub(App._ganttSub || 'timeline');
      } else if (tab === 'home') {
        setTimeout(() => Dashboard.render(), 30);
      } else if (tab === 'masterdata') {
        setTimeout(() => {
          if (App._currentMasterSub === 'plant') Plant.render();
          else ProdLines.render();
        }, 30);
      } else if (tab === 'admin') {
        setTimeout(() => AdminCockpit.render(), 30);
      } else if (tab === 'labor') {
        setTimeout(() => App.gotoLaborSub(App._laborSub || 'aggregate'), 30);
      }
    },

    gotoGanttSub(sub) {
      if (!['timeline', 'orders'].includes(sub)) return;
      App._ganttSub = sub;
      document.querySelectorAll('.gantt-toolbar .seg-btn[data-gantt-sub]').forEach(b => {
        b.classList.toggle('active', b.dataset.ganttSub === sub);
      });
      const timelinePane = document.getElementById('gantt-sub-timeline');
      const ordersPane   = document.getElementById('gantt-sub-orders');
      if (timelinePane) timelinePane.style.display = sub === 'timeline' ? 'flex' : 'none';
      if (ordersPane)   ordersPane.style.display   = sub === 'orders'   ? 'flex' : 'none';
      const show = sub === 'timeline';
      ['gantt-zoom-controls', 'gantt-zoom-sep', 'gantt-fit-controls'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = show ? '' : 'none';
      });
      if (sub === 'orders') {
        setTimeout(() => Table._api && Table._api.sizeColumnsToFit(), 30);
      } else {
        setTimeout(() => {
          Timeline.redraw(); Timeline.rebuild(); Hierarchy.render();
          GanttFilter._apply();
          TimelineNav.render();
          if (DependencyOverlay._enabled) DependencyOverlay.render();
        }, 30);
      }
    },

    // Convenience combinator for every "go to a specific order/line" entry
    // point (AlertsUIAdapter.focus, Dashboard._gotoLine/_jumpToOrder, Timeline.gotoLineDay,
    // Command Palette handlers in nimbus-intelligence.js) that must manipulate
    // Timeline right after navigating. Plain App.goto('gantt') alone preserves
    // whatever Gantt sub-tab (timeline vs orders) was last active — if the
    // user was last on the Orders AG-Grid sub-tab, the Timeline pan/selection
    // happens invisibly behind it. Force 'timeline' explicitly instead. Do NOT
    // change App.goto('gantt') itself — that preservation behavior is correct
    // for plain top-nav tab switches.
    gotoGanttTimeline() {
      App.goto('gantt');
      App.gotoGanttSub('timeline');
    },

    // Push pref('firstDayOfWeek') into Flatpickr's default l10n so calendar pickers
    // start the week on the user's chosen day. Flatpickr reads firstDayOfWeek at
    // construction time, so this affects pickers created AFTER the call (all NIMBUS
    // pickers are lazily built on first open). Safe no-op if Flatpickr isn't loaded.
    _applyFirstDayOfWeek() {
      try {
        let fdow = Store.pref('firstDayOfWeek');
        fdow = Number(fdow);
        if (fdow !== 0 && fdow !== 1) fdow = 0;
        if (typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.default) {
          flatpickr.l10ns.default.firstDayOfWeek = fdow;
        }
      } catch {}
    },

    // Navigate to the user's saved default landing view (pref('landingView') =
    // { tab, sub }), falling back to the Dashboard. Called once on boot after the
    // first task payload arrives. Guards the admin tab against non-admins and only
    // applies a sub-view for tabs that have one.
    _gotoLanding() {
      let lv = null;
      try { lv = Store.pref('landingView'); } catch {}
      const validTabs = ['home', 'gantt', 'masterdata', 'labor', 'admin'];
      let tab = (lv && validTabs.includes(lv.tab)) ? lv.tab : 'home';
      if (tab === 'admin' && !Session.isAdmin()) tab = 'home';
      App.goto(tab);
      const sub = lv && lv.sub;
      if (sub) {
        try {
          if (tab === 'gantt')           App.gotoGanttSub(sub);
          else if (tab === 'masterdata') App.gotoMasterSub(sub);
          else if (tab === 'labor')      App.gotoLaborSub(sub);
        } catch {}
      }
    },

    gotoLaborSub(sub) {
      const valid = ['aggregate','line-plan','capacity','exceptions','inputs'];
      if (!valid.includes(sub)) return;
      App._laborSub = sub;
      document.querySelectorAll('.labor-toolbar .seg-btn[data-labor-sub]').forEach(b => {
        b.classList.toggle('active', b.dataset.laborSub === sub);
      });
      valid.forEach(s => {
        const el = document.getElementById(`labor-sub-${s}`);
        if (el) el.style.display = s === sub ? 'flex' : 'none';
      });
      if (App._currentTab === 'labor') {
        const plant = Store.selectedPlant;
        if (plant) setTimeout(() => LaborPlanning.render(), 30);
      }
    },

    gotoMasterSub(sub) {
      if (!['lines', 'plant'].includes(sub)) return;
      // Collapse line accordions when switching away from the lines sub-tab
      if (App._currentMasterSub === 'lines' && sub !== 'lines') {
        document.querySelectorAll('details.line-accordion[open]').forEach(d => d.removeAttribute('open'));
      }
      App._currentMasterSub = sub;
      document.querySelectorAll('.md-master-subtabs .admin-subtab').forEach(b => {
        b.classList.toggle('active', b.dataset.mdMaster === sub);
      });
      const linesPane = document.getElementById('md-master-lines-pane');
      const plantPane = document.getElementById('md-master-plant-pane');
      if (linesPane) linesPane.hidden = (sub !== 'lines');
      if (plantPane) {
        if (sub === 'plant') { plantPane.style.display = 'flex'; plantPane.removeAttribute('hidden'); }
        else { plantPane.style.display = ''; plantPane.setAttribute('hidden', ''); }
      }
      // Only trigger render when the masterdata tab is currently visible
      if (App._currentTab === 'masterdata') {
        setTimeout(() => {
          if (sub === 'plant') Plant.render();
          else ProdLines.render();
        }, 30);
      }
    },

    // _renderSettingsPane() relocated to Plant._renderSettingsPane() in
    // plant-and-administration.mjs (CQ-1 Phase 4 Task 1) — this eliminated
    // the Plant -> App -> back-into-Plant's-own-DOM seam rather than
    // carrying it forward. This stub is removed entirely when Task 4
    // deletes the rest of App.

    toggleSide(which) {
      const el = document.getElementById(which === 'left' ? 'left-sidebar' : 'right-sidebar');
      if (el) {
        el.classList.toggle('collapsed');
        if (which === 'left') {
          const btn = el.querySelector('.side-head .icon-btn');
          if (btn) btn.textContent = el.classList.contains('collapsed') ? '▶' : '◀';
        }
      }
      setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, Config.ANIM_MS);
    },

    _wireResize(side, el) {
      const handle = el.querySelector('.resize-handle');
      if (!handle) return;
      let dragging = false;
      handle.addEventListener('mousedown', e => {
        dragging = true; document.body.style.cursor = 'ew-resize'; e.preventDefault();
      });
      window.addEventListener('mousemove', e => {
        if (!dragging) return;
        const w = side === 'left' ? e.clientX : window.innerWidth - e.clientX;
        if (w > 60 && w < 600) el.style.width = w + 'px';
      });
      window.addEventListener('mouseup', () => {
        if (dragging) { dragging = false; document.body.style.cursor = ''; Timeline.redraw(); }
      });
    }
  };

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
      const us = Store._state.userSettings || {}, rd = Store._state.roleDefaults || {};
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

    // Ctrl+Alt+L → open Admin Cockpit log tab (admin-only; App.goto('admin') already
    // guards this, but the early-return here is a redundant defense-in-depth check).
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (!Session.isAdmin()) return;
        App.goto('admin'); AdminCockpit.gotoOvTab('logs');
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
          const mdLines = Store._state.masterData?.lines;
          if (mdLines?.length) {
            mdLines.forEach(row => {
              const line = row.production_line;
              if (!line) return;
              Store.ensureLineSettings(line);
              const ls = Store._state.lineSettings[line];
              const before = JSON.stringify(ls);
              ls.excludeFromOpt = row.excl_optimizer === 'X';
              ls.bottleneck     = row.bottleneck === 'X';
              if (row.buffer_type === '%')        ls.bufferUnit = 'pct';
              else if (row.buffer_type === 'hrs') ls.bufferUnit = 'hours';
              if (row.buffer_percent != null && row.buffer_percent !== '')
                ls.bufferPct = parseFloat(row.buffer_percent) || 0;
              if (row.buffer_hours != null && row.buffer_hours !== '')
                ls.bufferHours = parseFloat(row.buffer_hours) || 0;
              ls.plGroup = row.pl_group || '';
              ls.plant   = row.plant    || null;
              if (JSON.stringify(ls) !== before) touched++;
            });
          }
        } catch (e) { ErrorLog.error('boot', `master-data lineSettings sync: ${e.message}`); }
        if (touched) {
          // lineSettings[].plant was just rewritten in bulk above via direct writes
          // (not setLineSetting), so the plant index is stale — rebuild it before the
          // emit so tasksForSelectedPlant / _tasksByPlant reflect the new assignments.
          Store.rebuildPlantIndex();
          Store.emit({ type: 'lineSettings:change', line: null, source: 'master-data-bulk' });
        }
        try { if (typeof Hierarchy !== 'undefined') Hierarchy.render(); } catch {}
        try { if (typeof ProdLines !== 'undefined' && App._currentTab === 'masterdata' && App._currentMasterSub !== 'plant') ProdLines.render(); } catch {}
      }
    }, 'App.masterData');
    try { Plant.init();       } catch (e) { ErrorLog.error('boot', `Plant.init: ${e.message}`); }
    try { PlantSelector.init();  } catch (e) { ErrorLog.error('boot', `PlantSelector.init: ${e.message}`); }
    try { WelcomeSplash.init();  } catch (e) { ErrorLog.error('boot', `WelcomeSplash.init: ${e.message}`); }
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
    //     returning user lands on their default instead of re-picking at WelcomeSplash;
    //   • else a valid remembered plant from a prior session → leave the existing
    //     flow (selection stays null → WelcomeSplash prompts, as before);
    //   • else, when the user can see exactly ONE plant → auto-select that one.
    // Setting the plant (source 'default-plant') triggers Persistence.loadForPlant
    // and dismisses WelcomeSplash via the usual 'plant:selected' subscribers.
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
        // returning user lands on their configured default rather than the splash.
        const dp = Store.pref('defaultPlant');
        if (dp && known.includes(dp)) { Store.setSelectedPlant(dp, 'default-plant'); return; }
        // No explicit default → preserve the existing flow: a valid remembered plant
        // leaves selection null so WelcomeSplash prompts (unchanged behavior).
        const cached = Persistence._rememberedPlant();
        if (cached && known.includes(cached)) return;
        // Neither a default nor a remembered plant, but the user can see exactly one.
        if (dp == null && known.length === 1) Store.setSelectedPlant(known[0], 'default-plant');
      } catch (e) { ErrorLog.warn('boot', `default-plant apply failed: ${e.message}`); }
    }, 'App.defaultPlant');

    // Stateless backend: scope the first load to the remembered plant so boot
    // doesn't pull every plant's order book. We intentionally do NOT set
    // Store.selectedPlant here — that keeps selectedPlant null so WelcomeSplash
    // still shows and the user still makes the explicit selection. When they pick
    // the same plant as last time, loadForPlant() no-ops (data already loaded);
    // if they pick a different one, it re-scopes. No remembered plant → unscoped.
    // (The defaultPlant one-shot above may set a selection after master data loads.)
    const _bootPlant = Persistence._rememberedPlant();
    Persistence.load(_bootPlant ? { plant: _bootPlant } : {});
  }
  App._bootMain = _bootMain;

  function _domReadyGate() {
    // Mandatory login gate — blocks the whole app until authenticated against
    // user_security. A cached session (page reload while signed in) skips
    // straight to _bootMain(); otherwise showLoginScreen() takes over and calls
    // App._bootMain() itself once Session.signIn() resolves.
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
    _domReadyGate();
  }

  /* Public namespace for inline onclick handlers in index.html */
  return {
    App, Engine, Alerts, AlertsUIAdapter, Timeline, Table, Inspector,
    Dashboard, Calendar, CalendarUI, Plant, ProdLines, Persistence, Modal, Toast, Store, Util, Config, Settings,
    Utilization, ContextMenu, Hierarchy,
    Selection, UndoStack, Interaction,
    ErrorLog, AdminCockpit,
    TimelineNav, GanttFilter, DependencyOverlay, Sandbox, SandboxAdapter, Printer,
    OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer,
    PlantSelector, EmptyState, MasterData, WelcomeSplash,
    LaborPlanning, Interface, Security, CalendarSync,
    Session, SessionUIAdapter, showLoginScreen
  };
})();
