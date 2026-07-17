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
   `MasterData` has not moved yet (Task 2) — `Plant`'s/`ProdLines`' bare
   `MasterData.syncLineSettings(...)` calls are therefore genuine forward
   references into this file's still-resident `MasterData`, resolved through
   the shared `NIMBUS` binding (`NIMBUS.MasterData.syncLineSettings(...)`),
   the same idiom Phase 3 used for its own forward references into
   not-yet-moved modules.
   See docs/architecture/cq1-compatibility-inventory.md §1 for the full
   ownership map, including where the modules below are headed in Phase 4.

   Module map (load order) — modules still defined in THIS file:
     SessionUIAdapter   — session gates / user-settings modal / profile /
                         password self-service remnant (pure state/API moved
                         to schedule-data.mjs's Session)
     MasterData        — CRUD grid + DDL wizard (moves Phase 4 Task 2)
     LaborPlanning     — labor plan editor (moves Phase 4 Task 2)
     Interface         — SAP sync config/run history (moves Phase 4 Task 3)
     Security          — user/role admin (moves Phase 4 Task 3)
     AdminCockpit      — upload, data management, integrity check panel
                         (moves Phase 4 Task 3)
     App               — bootstrap + tab switching (moves Phase 4 Task 4)
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
  const { CalendarUI, Plant, ProdLines, setActiveTabResolvers: _setPlantAdminTabResolvers } = window.__NIMBUS_PLANT_ADMIN;
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
  // (CQ-1 Phase 4 Task 1) — see the bridge destructure above and the header
  // comment at the top of this file.

  /* =============================================================================
     LABOR PLANNING — aggregate-to-line available labor hours planning
     Sub-tabs: Aggregate · Line Plan · Capacity · Exceptions · Inputs
     ========================================================================== */
  const LaborPlanning = (() => {
    // ── State ────────────────────────────────────────────────────────────────
    let _horizonOffset  = 0;         // weeks offset from today's Monday
    let _horizonSpan    = 12;        // number of weeks in view
    let _selectedGroups = new Set(); // empty = all groups; used to scope all sub-tabs
    let _aggrData       = {};        // { [plant]: { [grp]: { [period]: avail_hours } } }
    let _lineData       = {};        // { [plant]: { [line]: { [day]: { avail_hours, source } } } }
    let _groups         = [];        // sorted unique pl_group values for current plant
    let _displayGroups  = [];        // currently rendered subset (respects _selectedGroups filter)
    let _weeks         = [];   // [{ key:'YYYY-Www', label:'MM/DD/YY', monday:Date }]
    let _selRange      = null; // { r0,c0,r1,c1 } lasso rectangle, or null
    let _dragging      = false;
    let _dragAnchor    = null;
    let _fpHorizon     = null; // Flatpickr instance for the date-jump input
    let _cellGrid      = null; // [r][c] -> <td> cache for the Aggregate grid (built per render)
    let _selTds        = new Set(); // currently-highlighted <td>s, for incremental lasso diffing

    // ── Date helpers ─────────────────────────────────────────────────────────
    function _isoWeek(date) {
      const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      const dayNum = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil((((d - yearStart) / Config.MS_DAY) + 1) / 7);
      return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    }

    function _weekLabel(monday) {
      const m = String(monday.getMonth() + 1).padStart(2, '0');
      const d = String(monday.getDate()).padStart(2, '0');
      const y = String(monday.getFullYear()).slice(-2);
      return `${m}/${d}/${y}`;
    }

    function _computeWeeks() {
      const now    = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + _horizonOffset * 7);
      const weeks = [];
      for (let i = 0; i < _horizonSpan; i++) {
        const d = new Date(monday); d.setDate(monday.getDate() + i * 7);
        weeks.push({ key: _isoWeek(d), label: _weekLabel(new Date(d)), monday: new Date(d) });
      }
      return weeks;
    }

    function _isoWeekToMonday(isoKey) {
      const [year, week] = isoKey.split('-W');
      const y = parseInt(year, 10), w = parseInt(week, 10);
      const jan4 = new Date(y, 0, 4);
      const dow  = jan4.getDay() || 7;
      const week1Mon = new Date(jan4); week1Mon.setDate(jan4.getDate() - (dow - 1));
      const monday   = new Date(week1Mon); monday.setDate(week1Mon.getDate() + (w - 1) * 7);
      return monday;
    }

    // ── Backend helpers ───────────────────────────────────────────────────────
    function _subnetwork(plant) {
      return (Store._state.masterData?.plants || []).find(p => p.plant === plant)?.subnetwork || '';
    }

    async function _saveAggregate(subnetwork, plant, cells) {
      try {
        const r = await fetch(`${Config.API_BASE}/labor-plan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body: JSON.stringify({ subnetwork, plant, cells }),
        });
        if (!r.ok) { const e = await r.json(); throw new Error(e.detail || `HTTP ${r.status}`); }
      } catch (e) {
        Toast.show(`Labor plan save failed: ${e.message}`, 'error');
        ErrorLog.error('labor', `Save aggregate failed: ${e.message}`);
      }
    }

    async function _saveLines(subnetwork, plant, cells) {
      if (!cells.length) return;
      try {
        const r = await fetch(`${Config.API_BASE}/labor-plan/line`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body: JSON.stringify({ subnetwork, plant, cells }),
        });
        if (!r.ok) { const e = await r.json(); throw new Error(e.detail || `HTTP ${r.status}`); }
      } catch (e) {
        Toast.show(`Line plan save failed: ${e.message}`, 'error');
        ErrorLog.error('labor', `Save lines failed: ${e.message}`);
      }
    }

    async function _fetchAggregate(plant) {
      if (_aggrData[plant]) return _aggrData[plant];
      try {
        const res = await fetch(`${Config.API_BASE}/labor-plan?plant=${encodeURIComponent(plant)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const map = {};
        (json.rows || []).forEach(r => {
          if (!map[r.pl_group]) map[r.pl_group] = {};
          map[r.pl_group][r.period] = r.avail_hours;
        });
        _aggrData[plant] = map;
        return map;
      } catch (e) {
        ErrorLog.warn('labor', `Fetch aggregate failed for ${plant}: ${e.message}`);
        return {};
      }
    }

    async function _fetchLines(plant, group) {
      const w0 = _weeks[0], wN = _weeks[_weeks.length - 1];
      const from_date = Util.dayKey(w0.monday);
      const toDate    = new Date(wN.monday); toDate.setDate(wN.monday.getDate() + 6);
      const to_date   = Util.dayKey(toDate);
      try {
        let url = `${Config.API_BASE}/labor-plan/line?plant=${encodeURIComponent(plant)}&from_date=${from_date}&to_date=${to_date}`;
        if (group) url += `&group=${encodeURIComponent(group)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!_lineData[plant]) _lineData[plant] = {};
        (json.rows || []).forEach(r => {
          if (!_lineData[plant][r.production_line]) _lineData[plant][r.production_line] = {};
          _lineData[plant][r.production_line][r.day] = { avail_hours: r.avail_hours, source: r.source };
        });
      } catch (e) {
        ErrorLog.warn('labor', `Fetch lines failed: ${e.message}`);
      }
    }

    // ── Disaggregation ───────────────────────────────────────────────────────
    function _disaggregate(plant, group, periodKey, groupHours) {
      const lines = (Store._state.masterData?.lines || [])
        .filter(l => l.plant === plant && l.pl_group === group)
        .map(l => l.production_line);
      if (!lines.length) return [];

      const monday = _isoWeekToMonday(periodKey);
      const openSlots = [];
      lines.forEach(line => {
        for (let d = 0; d < 7; d++) {
          const date = new Date(monday); date.setDate(monday.getDate() + d);
          if (Calendar.effectiveCapacityHours(line, date) > 0)
            openSlots.push({ line, date, dayKey: Util.dayKey(date) });
        }
      });
      if (!openSlots.length) return [];

      const perSlot = Math.max(0, (groupHours || 0)) / openSlots.length;
      const rounded = Math.round(perSlot * 10) / 10;
      return openSlots.map(s => ({ production_line: s.line, day: s.dayKey, avail_hours: rounded, source: 'auto_split' }));
    }

    // ── KPI strip ────────────────────────────────────────────────────────────
    function _renderKPIs(plant) {
      const strip = document.getElementById('labor-kpi-strip');
      if (!strip || !plant) { if (strip) strip.innerHTML = ''; return; }

      const planMap = _aggrData[plant] || {};
      let totalAvail = 0;
      _groups.forEach(g => _weeks.forEach(w => {
        const v = planMap[g]?.[w.key]; if (v != null) totalAvail += v;
      }));

      const horizonStart = _weeks[0]?.monday || new Date();
      const horizonDays  = Math.min(_horizonSpan * 7, 90);
      const matrix = Utilization.computeMatrix(horizonStart, horizonDays);
      const plantLines = (Store._state.masterData?.lines || []).filter(r => r.plant === plant).map(r => r.production_line);
      let totalRequired = 0;
      plantLines.forEach(line => {
        const lm = matrix[line]; if (!lm) return;
        Object.values(lm).forEach(cell => { totalRequired += cell.scheduled || 0; });
      });

      const diff     = totalAvail - totalRequired;
      const headroom = totalAvail > 0 ? Math.round((diff / totalAvail) * 100) : 0;
      const hSev     = headroom < 0 ? 'err' : headroom < 15 ? 'warn' : '';

      let shortfalls = 0;
      plantLines.forEach(line => {
        const lm = matrix[line]; if (!lm) return;
        Object.entries(lm).forEach(([dayKey, cell]) => {
          if (!cell.scheduled) return;
          const ld   = _lineData[plant]?.[line]?.[dayKey];
          const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
          if (cell.scheduled > avail + 0.05) shortfalls++;
        });
      });

      const fmtH = h => h >= 1000 ? `${(h / 1000).toFixed(1)}k` : h.toFixed(0);
      strip.innerHTML = `
        <div class="lp-kpi-tile">
          <span class="lp-kpi-label">Available</span>
          <span class="lp-kpi-val">${fmtH(totalAvail)}h</span>
          <span class="lp-kpi-sub">${_horizonSpan} wk horizon</span>
        </div>
        <div class="lp-kpi-tile">
          <span class="lp-kpi-label">Required</span>
          <span class="lp-kpi-val">${fmtH(totalRequired)}h</span>
          <span class="lp-kpi-sub">from scheduled orders</span>
        </div>
        <div class="lp-kpi-tile${hSev ? ' lp-kpi-' + hSev : ''}">
          <span class="lp-kpi-label">Headroom</span>
          <span class="lp-kpi-val">${headroom}%</span>
          <span class="lp-kpi-sub">${fmtH(Math.abs(diff))}h ${diff >= 0 ? 'surplus' : 'deficit'}</span>
        </div>
        <div class="lp-kpi-tile${shortfalls > 0 ? ' lp-kpi-err' : ''}">
          <span class="lp-kpi-label">Shortfalls</span>
          <span class="lp-kpi-val">${shortfalls}</span>
          <span class="lp-kpi-sub">line·day cells</span>
        </div>`;
    }

    // Per-edit/paste KPI refresh is debounced (R12): the strip rebuilds an
    // O(lines × days) matrix walk, and labor editing fires per keystroke/cell —
    // coalesce rapid edits into one recompute instead of one-per-keystroke.
    const _renderKPIsDebounced = Util.debounce(_renderKPIs, 350);

    // ── Aggregate sub-tab ────────────────────────────────────────────────────
    function _clearSelection() {
      _selRange = null; _dragging = false; _dragAnchor = null;
      _selTds.forEach(td => td.classList.remove('lp-selected-td'));
      _selTds.clear();
    }

    // Incremental lasso paint: diff the new rectangle against the previously
    // highlighted set so each mousemove only touches cells whose membership
    // changed (O(changed)), instead of clearing + re-querying the whole grid.
    function _renderSelection() {
      const next = new Set();
      if (_selRange && _cellGrid) {
        const { r0, c0, r1, c1 } = _selRange;
        for (let r = r0; r <= r1; r++) {
          const row = _cellGrid[r]; if (!row) continue;
          for (let c = c0; c <= c1; c++) { const td = row[c]; if (td) next.add(td); }
        }
      }
      _selTds.forEach(td => { if (!next.has(td)) td.classList.remove('lp-selected-td'); });
      next.forEach(td => { if (!_selTds.has(td)) td.classList.add('lp-selected-td'); });
      _selTds = next;
    }

    function _updateAggrTotals(grid) {
      const plant = Store.selectedPlant; if (!plant || !_aggrData[plant]) return;
      const tds = grid.querySelectorAll('tbody tr:last-child td');
      _weeks.forEach((w, i) => {
        const total = Object.values(_aggrData[plant]).reduce((sum, p) => sum + (p[w.key] ?? 0), 0);
        if (tds[i + 1]) tds[i + 1].textContent = total > 0 ? total.toFixed(1) : '—';
      });
    }

    function _deleteSelected() {
      if (!_selRange) return;
      const plant = Store.selectedPlant; if (!plant) return;
      if (!_aggrData[plant]) _aggrData[plant] = {};
      const { r0, c0, r1, c1 } = _selRange;
      const cleared = [], prev = [];
      const g = document.getElementById('labor-grid');
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const grp = _displayGroups[r]; const period = _weeks[c]?.key; if (!grp || !period) continue;
        prev.push({ pl_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
        if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
        delete _aggrData[plant][grp][period];
        cleared.push({ pl_group: grp, period, avail_hours: null });
        const inp = g?.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
        if (inp) inp.value = '';
      }
      if (!cleared.length) return;
      if (g) _updateAggrTotals(g);
      _clearSelection();
      const sn = _subnetwork(plant);
      UndoStack.push(`Delete ${cleared.length} labor cell${cleared.length !== 1 ? 's' : ''}`, () => {
        if (!_aggrData[plant]) _aggrData[plant] = {};
        prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
        });
        const g2 = document.getElementById('labor-grid');
        if (g2) {
          prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
            const el = g2.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
            if (el) el.value = old != null ? old : '';
          });
          _updateAggrTotals(g2);
        }
        _saveAggregate(sn, plant, prev);
      });
      _saveAggregate(sn, plant, cleared);
    }

    function _copySelected() {
      if (!_selRange) return;
      const plant = Store.selectedPlant;
      const { r0, c0, r1, c1 } = _selRange;
      const rows = [];
      for (let r = r0; r <= r1; r++) {
        const cols = [];
        for (let c = c0; c <= c1; c++) {
          const grp = _displayGroups[r]; const period = _weeks[c]?.key;
          const ah = grp && period ? (_aggrData[plant]?.[grp]?.[period] ?? null) : null;
          cols.push(ah != null ? String(ah) : '');
        }
        rows.push(cols.join('\t'));
      }
      const count = (r1 - r0 + 1) * (c1 - c0 + 1);
      navigator.clipboard.writeText(rows.join('\n'))
        .then(() => Toast.show(`Copied ${count} cell${count !== 1 ? 's' : ''}`, 'success'))
        .catch(() => Toast.show('Copy failed — check clipboard permissions', 'error'));
    }

    async function _renderAggregate(plant) {
      const grid = document.getElementById('labor-grid'); if (!grid) return;
      const planMap = await _fetchAggregate(plant);
      _displayGroups = _selectedGroups.size ? _groups.filter(g => _selectedGroups.has(g)) : _groups;
      const totals = {}; _weeks.forEach(w => { totals[w.key] = 0; });
      const groupRows = _displayGroups.map(grp => {
        const cells = _weeks.map(w => {
          const ah = planMap[grp]?.[w.key]; if (ah != null) totals[w.key] += ah;
          return `<td>
            <input type="number" class="lp-cell" data-group="${grp.replace(/"/g,'&quot;')}" data-period="${w.key}" min="0" step="0.5" value="${ah != null ? ah : ''}" placeholder="—">
          </td>`;
        }).join('');
        return `<tr><td>${grp}</td>${cells}</tr>`;
      }).join('');
      const totalCells = _weeks.map(w => {
        const v = totals[w.key];
        return `<td>${v > 0 ? v.toFixed(1) : '—'}</td>`;
      }).join('');
      grid.innerHTML = `
        <div class="lp-card lp-card-scroll">
          <table class="lp-table">
            <thead><tr>
              <th>Group</th>
              ${_weeks.map(w => `<th>${w.label}</th>`).join('')}
            </tr></thead>
            <tbody>
              ${groupRows}
              <tr class="lp-total-row">
                <td>TOTAL</td>${totalCells}
              </tr>
            </tbody>
          </table>
        </div>
        <p class="lp-hint">Ctrl+drag to select · Delete to clear · Ctrl+C to copy · Paste from Excel · Values in hours</p>`;

      // Build [row][col] -> <td> cache so the lasso paint never queries the DOM.
      _cellGrid = _displayGroups.map(grp =>
        _weeks.map(w => grid.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${w.key}"]`)?.closest('td') || null));
      _selTds = new Set();

      const sn = _subnetwork(plant);

      // Lasso drag listeners attach once to the persistent #labor-grid element
      // (innerHTML is replaced on every render but the container is not).
      if (!grid._lpDragWired) {
        grid._lpDragWired = true;
        grid.addEventListener('mousedown', e => {
          if (!e.ctrlKey && !e.metaKey) { if (!e.target.closest('.lp-selected-td')) _clearSelection(); return; }
          const inp = e.target.closest('.lp-cell'); if (!inp) return;
          e.preventDefault();
          const ri = _displayGroups.indexOf(inp.dataset.group), ci = _weeks.findIndex(w => w.key === inp.dataset.period);
          if (ri < 0 || ci < 0) return;
          _dragging = true; _dragAnchor = { row: ri, col: ci };
          _selRange = { r0: ri, c0: ci, r1: ri, c1: ci }; _renderSelection();
        });
        grid.addEventListener('mousemove', e => {
          if (!_dragging) return;
          const td = e.target.closest('td'); if (!td) return;
          const inp = td.querySelector('.lp-cell'); if (!inp) return;
          const ri = _displayGroups.indexOf(inp.dataset.group), ci = _weeks.findIndex(w => w.key === inp.dataset.period);
          if (ri < 0 || ci < 0) return;
          _selRange = { r0: Math.min(_dragAnchor.row, ri), c0: Math.min(_dragAnchor.col, ci), r1: Math.max(_dragAnchor.row, ri), c1: Math.max(_dragAnchor.col, ci) };
          _renderSelection();
        });
      }

      grid.querySelectorAll('.lp-cell').forEach(inp => {
        inp.onchange = async function() {
          const grp = this.dataset.group, period = this.dataset.period;
          const raw = this.value.trim();
          const ah  = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);
          if (ah !== null) this.value = ah;
          const oldAh = _aggrData[plant]?.[grp]?.[period] ?? null;
          if (!_aggrData[plant]) _aggrData[plant] = {};
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (ah === null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = ah;
          _updateAggrTotals(grid);
          _renderKPIsDebounced(plant);
          if (ah !== null) {
            const splits = _disaggregate(plant, grp, period, ah);
            if (splits.length) {
              if (!_lineData[plant]) _lineData[plant] = {};
              splits.forEach(c => {
                if (!_lineData[plant][c.production_line]) _lineData[plant][c.production_line] = {};
                _lineData[plant][c.production_line][c.day] = { avail_hours: c.avail_hours, source: c.source };
              });
              _saveLines(sn, plant, splits);
            }
          }
          UndoStack.push(`Labor: ${grp} / ${period}`, () => {
            if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
            if (oldAh == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = oldAh;
            const el = document.getElementById('labor-grid')?.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
            if (el) el.value = oldAh != null ? oldAh : '';
            _updateAggrTotals(document.getElementById('labor-grid'));
            _saveAggregate(sn, plant, [{ pl_group: grp, period, avail_hours: oldAh }]);
          });
          await _saveAggregate(sn, plant, [{ pl_group: grp, period, avail_hours: ah }]);
        };
      });

      const table = grid.querySelector('table');
      if (table) table.addEventListener('paste', async e => {
        const anchor = document.activeElement?.classList.contains('lp-cell') ? document.activeElement : null;
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain'); if (!text) return;
        const clipRows = text.replace(/\r/g, '').split('\n').filter(r => r !== '').map(r => r.split('\t'));
        const cellMatrix = _displayGroups.map(grp => _weeks.map(w => grid.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${w.key}"]`)));
        let anchorRow = 0, anchorCol = 0;
        if (anchor) {
          anchorRow = Math.max(0, _displayGroups.indexOf(anchor.dataset.group));
          anchorCol = Math.max(0, _weeks.findIndex(w => w.key === anchor.dataset.period));
        }
        if (!_aggrData[plant]) _aggrData[plant] = {};
        const changed = [], prev = [], allSplits = [];
        clipRows.forEach((clipCols, r) => {
          clipCols.forEach((val, c) => {
            const ri = anchorRow + r, ci = anchorCol + c;
            if (ri >= _displayGroups.length || ci >= _weeks.length) return;
            const inp = cellMatrix[ri]?.[ci]; if (!inp) return;
            const raw = val.trim().replace(/,/g, '');
            const ah  = raw === '' ? null : parseFloat(raw);
            if (ah !== null && (isNaN(ah) || ah < 0)) return;
            const grp = inp.dataset.group, period = inp.dataset.period;
            prev.push({ pl_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
            inp.value = ah !== null ? ah : '';
            if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
            if (ah === null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = ah;
            changed.push({ pl_group: grp, period, avail_hours: ah });
            if (ah !== null) allSplits.push(..._disaggregate(plant, grp, period, ah));
          });
        });
        if (!changed.length) return;
        _updateAggrTotals(grid); _renderKPIsDebounced(plant);
        if (allSplits.length) {
          if (!_lineData[plant]) _lineData[plant] = {};
          allSplits.forEach(c => {
            if (!_lineData[plant][c.production_line]) _lineData[plant][c.production_line] = {};
            _lineData[plant][c.production_line][c.day] = { avail_hours: c.avail_hours, source: c.source };
          });
          _saveLines(sn, plant, allSplits);
        }
        UndoStack.push(`Undo paste (${changed.length} labor value${changed.length !== 1 ? 's' : ''})`, () => {
          if (!_aggrData[plant]) _aggrData[plant] = {};
          prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
            if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
            if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
          });
          const g = document.getElementById('labor-grid');
          if (g) {
            prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
              const el = g.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
              if (el) el.value = old != null ? old : '';
            });
            _updateAggrTotals(g);
          }
          _saveAggregate(sn, plant, prev);
        });
        Toast.show(`Pasted ${changed.length} value${changed.length !== 1 ? 's' : ''}`, 'success');
        await _saveAggregate(sn, plant, changed);
      });
    }

    // ── Line Plan sub-tab ────────────────────────────────────────────────────
    async function _renderLinePlan(plant) {
      const grid = document.getElementById('labor-line-grid'); if (!grid) return;
      // Show all groups unless user has filtered to specific ones
      const visibleGroups = _displayGroups.length ? _displayGroups : _groups;
      const fetchGroup = _selectedGroups.size === 1 ? [..._selectedGroups][0] : null;
      const allLinesMeta = Store.masterLinesForPlant(plant)
        .filter(l => visibleGroups.includes(l.pl_group))
        .sort((a, b) => visibleGroups.indexOf(a.pl_group) - visibleGroups.indexOf(b.pl_group) || a.production_line.localeCompare(b.production_line));
      if (!allLinesMeta.length) {
        grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${t('empty.no_production_lines_plant')}</div>`; return;
      }
      await _fetchLines(plant, fetchGroup);

      // Build day columns
      const days = [];
      _weeks.forEach(w => {
        for (let d = 0; d < 7; d++) {
          const date = new Date(w.monday); date.setDate(w.monday.getDate() + d);
          days.push({ date, dayKey: Util.dayKey(date), weekKey: w.key });
        }
      });

      const horizonStart = _weeks[0].monday;
      const utilMatrix   = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
      const sn = _subnetwork(plant);

      const isDark = document.body.classList.contains('dark');
      function lerpRGB(a, b, t) {
        const p = h => [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
        const ca = p(a), cb = p(b);
        return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`;
      }
      const idle = isDark ? '#252730' : '#ede8de', low = isDark ? '#7a5a18' : '#c8a95a',
            mid  = isDark ? '#a8520f' : '#c96a1a', hot = isDark ? '#b32a1f' : '#991b1b';
      function heatBg(ratio) {
        if (ratio <= 0)   return idle;
        if (ratio <= 0.5) return lerpRGB(idle, low, ratio / 0.5);
        if (ratio <= 1.0) return lerpRGB(low, mid, (ratio - 0.5) / 0.5);
        return lerpRGB(mid, hot, Math.min((ratio - 1.0) / 0.25, 1));
      }

      const weekStarts = new Set(_weeks.map(w => Util.dayKey(w.monday)));

      const dayHeaders = days.map(d => {
        const wb = weekStarts.has(d.dayKey) ? 'border-left:2px solid var(--accent-soft);' : '';
        return `<th style="width:52px;min-width:52px;${wb}">${d.date.getMonth()+1}/${d.date.getDate()}</th>`;
      }).join('');

      const showGroupHeaders = visibleGroups.length > 1;
      let lastGroup = null;
      // Memoize calendar capacity per (line|dayKey) for this render pass — the same
      // line/date pair is otherwise recomputed across every row build.
      const _capMemo = new Map();
      const _capFor = (line, date, dayKey) => {
        const k = line + '|' + dayKey;
        let v = _capMemo.get(k);
        if (v === undefined) { v = Calendar.effectiveCapacityHours(line, date); _capMemo.set(k, v); }
        return v;
      };
      const lineRows = allLinesMeta.map(lm => {
        const line = lm.production_line;
        let groupRow = '';
        if (showGroupHeaders && lm.pl_group !== lastGroup) {
          lastGroup = lm.pl_group;
          groupRow = `<tr><td class="lp-group-hdr" colspan="${days.length + 1}">${lm.pl_group}</td></tr>`;
        }
        const cells = days.map(d => {
          const wb   = weekStarts.has(d.dayKey) ? 'border-left:2px solid var(--accent-soft);' : '';
          const ld   = _lineData[plant]?.[line]?.[d.dayKey];
          const calCap = _capFor(line, d.date, d.dayKey);
          const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
          const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
          const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
          const bg     = avail === 0 ? 'var(--bg-subtle)' : heatBg(ratio);
          const isOvr  = ld?.source === 'override';
          const title  = `${line} · ${d.dayKey} | Available: ${avail.toFixed(1)}h | Required: ${req.toFixed(1)}h | Cal cap: ${calCap.toFixed(1)}h${isOvr ? ' | Pinned' : ''}`;
          return `<td class="${isOvr ? 'lp-ovr' : ''}" style="${wb}background:${bg};padding:3px 4px;" title="${title}">
            <input type="number" class="lp-line-cell" data-line="${line.replace(/"/g,'&quot;')}" data-day="${d.dayKey}" min="0" step="0.5"
              value="${avail > 0 ? avail : ''}"></td>`;
        }).join('');
        return groupRow + `<tr><td>${line}</td>${cells}</tr>`;
      }).join('');

      grid.innerHTML = `
        <div class="lp-card lp-card-scroll">
          <table class="lp-table">
            <thead><tr><th>Line</th>${dayHeaders}</tr></thead>
            <tbody>${lineRows}</tbody>
          </table>
        </div>`;

      // Sticky group headers: offset by actual thead height so they dock below column headers
      const theadH = grid.querySelector('thead tr')?.offsetHeight || 27;
      grid.querySelectorAll('.lp-group-hdr').forEach(td => { td.style.top = theadH + 'px'; });

      // Delegated handlers on the grid container — one 'change' + one 'contextmenu'
      // listener instead of two per cell (scales to thousands of line-day cells).
      grid.onchange = async function(e) {
        const inp = e.target.closest('.lp-line-cell'); if (!inp) return;
        const line = inp.dataset.line, day = inp.dataset.day;
        const raw  = inp.value.trim();
        const ah   = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);
        if (ah !== null) inp.value = ah;
        if (!_lineData[plant]) _lineData[plant] = {};
        if (!_lineData[plant][line]) _lineData[plant][line] = {};
        const old    = _lineData[plant][line][day];
        const oldAh  = old?.avail_hours ?? null, oldSrc = old?.source ?? 'auto_split';
        const newSrc = ah !== null ? 'override' : 'auto_split';
        if (ah === null) delete _lineData[plant][line][day]; else _lineData[plant][line][day] = { avail_hours: ah, source: 'override' };
        const td = inp.closest('td');
        if (td) td.classList.toggle('lp-ovr', ah !== null);
        UndoStack.push(`Line plan: ${line} / ${day}`, () => {
          if (!_lineData[plant][line]) _lineData[plant][line] = {};
          if (oldAh == null) delete _lineData[plant][line][day]; else _lineData[plant][line][day] = { avail_hours: oldAh, source: oldSrc };
          const el = grid.querySelector(`.lp-line-cell[data-line="${line.replace(/"/g,'&quot;')}"][data-day="${day}"]`);
          if (el) el.value = oldAh != null ? oldAh : '';
          _saveLines(sn, plant, [{ production_line: line, day, avail_hours: oldAh, source: oldSrc }]);
        });
        await _saveLines(sn, plant, [{ production_line: line, day, avail_hours: ah, source: newSrc }]);
      };

      grid.oncontextmenu = function(e) {
        const inp = e.target.closest('.lp-line-cell'); if (!inp) return;
        e.preventDefault();
        const line = inp.dataset.line, day = inp.dataset.day;
        if (_lineData[plant]?.[line]?.[day]?.source !== 'override') return;
        const grp = (Store._state.masterData?.lines || []).find(l => l.production_line === line && l.plant === plant)?.pl_group;
        if (!grp) return;
        const periodKey = _weeks.find(w => {
          for (let d = 0; d < 7; d++) { const dd = new Date(w.monday); dd.setDate(w.monday.getDate() + d); if (Util.dayKey(dd) === day) return true; }
        })?.key;
        if (!periodKey) return;
        const groupHours = _aggrData[plant]?.[grp]?.[periodKey]; if (groupHours == null) return;
        const splits = _disaggregate(plant, grp, periodKey, groupHours);
        const resetCell = splits.find(c => c.production_line === line && c.day === day); if (!resetCell) return;
        _lineData[plant][line][day] = { avail_hours: resetCell.avail_hours, source: 'auto_split' };
        inp.value = resetCell.avail_hours || '';
        inp.closest('td')?.classList.remove('lp-ovr');
        _saveLines(sn, plant, [{ production_line: line, day, avail_hours: resetCell.avail_hours, source: 'auto_split' }]);
        Toast.show(`Reset ${line} · ${day} to even-split`, 'success');
      };
    }

    // ── Capacity sub-tab ─────────────────────────────────────────────────────
    async function _renderCapacity(plant) {
      const container = document.getElementById('labor-capacity-grid'); if (!container) return;
      const scopeGroup = _selectedGroups.size === 1 ? [..._selectedGroups][0] : null;
      await _fetchLines(plant, scopeGroup);
      const lines = Store.masterLinesForPlant(plant)
        .filter(l => !scopeGroup || l.pl_group === scopeGroup)
        .map(l => l.production_line).sort();
      if (!lines.length) { container.innerHTML = `<div class="empty-state" style="padding:40px 0;">${t('empty.no_production_lines_plant')}</div>`; return; }

      const horizonStart = _weeks[0].monday;
      const utilMatrix   = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
      const displayDays  = Math.min(14, _horizonSpan * 7);
      const days = [];
      for (let i = 0; i < displayDays; i++) {
        const d = new Date(horizonStart); d.setDate(horizonStart.getDate() + i);
        days.push({ date: d, dayKey: Util.dayKey(d) });
      }

      const isDark = document.body.classList.contains('dark');
      function lerpRGB(a, b, t) {
        const p = h => [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
        const ca = p(a), cb = p(b);
        return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`;
      }
      const idle = isDark ? '#252730' : '#ede8de', low = isDark ? '#7a5a18' : '#c8a95a',
            mid  = isDark ? '#a8520f' : '#c96a1a', hot = isDark ? '#b32a1f' : '#991b1b';
      function heatBg(ratio) {
        if (ratio <= 0)   return idle;
        if (ratio <= 0.5) return lerpRGB(idle, low, ratio / 0.5);
        if (ratio <= 1.0) return lerpRGB(low, mid, (ratio - 0.5) / 0.5);
        return lerpRGB(mid, hot, Math.min((ratio - 1.0) / 0.25, 1));
      }
      function heatText(ratio) { return isDark ? (ratio <= 0 ? '#8f909d' : '#fff') : (ratio < 0.45 ? '#3d3628' : '#fff'); }

      const cols = `100px repeat(${days.length}, 1fr)`;
      let html = `<div class="lp-card" style="padding:14px 16px;">
        <p class="lp-cap-note">Req/Avail hours · first ${displayDays} days${scopeGroup ? ' · Group: ' + scopeGroup : ''}</p>
        <div class="lp-hm-wrap"><div class="lp-hm-grid" style="grid-template-columns:${cols}">`;
      html += `<div class="lp-hm-corner"></div>`;
      days.forEach(d => {
        const dow = d.date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
        html += `<div class="lp-hm-head"><span class="lp-hm-dow">${dow}</span><span class="lp-hm-date">${d.date.getMonth()+1}/${d.date.getDate()}</span></div>`;
      });
      lines.forEach((line, li) => {
        const dot = Config.COLORS[li % Config.COLORS.length];
        html += `<div class="lp-hm-label"><span class="lp-hm-dot" style="background:${dot}"></span>${line}</div>`;
        days.forEach(d => {
          const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
          const ld     = _lineData[plant]?.[line]?.[d.dayKey];
          const calCap = utilMatrix[line]?.[d.dayKey]?.effectiveCapacity || 0;
          const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
          const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
          const bg     = heatBg(ratio), tc = heatText(ratio);
          const lbl    = avail > 0 ? `${req.toFixed(0)}/${avail.toFixed(0)}` : '—';
          html += `<div class="lp-hm-cell" style="background:${bg};color:${tc};" title="${line} · ${d.dayKey} | Req: ${req.toFixed(1)}h | Avail: ${avail.toFixed(1)}h | ${Math.round(ratio*100)}%">${lbl}</div>`;
        });
      });
      html += `</div></div><div class="lp-hm-legend"><span>idle</span><div class="lp-hm-grad"></div><span>overload</span></div></div>`;
      container.innerHTML = html;
    }

    // ── Exceptions sub-tab ───────────────────────────────────────────────────
    async function _renderExceptions(plant) {
      const container = document.getElementById('labor-exceptions-list'); if (!container) return;
      await _fetchLines(plant, null);
      const lines = (Store._state.masterData?.lines || []).filter(l => l.plant === plant).map(l => l.production_line);
      const horizonStart = _weeks[0].monday;
      const utilMatrix   = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
      const exceptions = [];
      lines.forEach(line => {
        const lm = utilMatrix[line]; if (!lm) return;
        Object.entries(lm).forEach(([dayKey, cell]) => {
          if (!cell.scheduled && !cell.capacity) return;
          const ld    = _lineData[plant]?.[line]?.[dayKey];
          const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
          const req   = cell.scheduled || 0, calCap = cell.capacity || 0;
          if (req > avail + 0.05 && req > 0)
            exceptions.push({ sev: 'err',  line, day: dayKey, msg: `${req.toFixed(1)}h required, ${avail.toFixed(1)}h available — ${(req - avail).toFixed(1)}h short` });
          else if (avail > calCap + 0.05 && calCap > 0)
            exceptions.push({ sev: 'warn', line, day: dayKey, msg: `${avail.toFixed(1)}h planned exceeds ${calCap.toFixed(1)}h calendar capacity` });
        });
      });
      exceptions.sort((a, b) => (a.sev === 'err' ? -1 : 1) - (b.sev === 'err' ? -1 : 1) || a.day.localeCompare(b.day));

      const badge = document.getElementById('labor-exc-badge');
      if (badge) { badge.textContent = exceptions.length; badge.hidden = exceptions.length === 0; }

      if (!exceptions.length) {
        container.innerHTML = `<div class="empty-state" style="padding:40px 0;">✓ No exceptions in the current horizon.</div>`; return;
      }
      const rows = exceptions.map(ex => `
        <div class="lp-exc-row lp-exc-${ex.sev}">
          <span class="lp-exc-sev">${ex.sev === 'err' ? '▲' : '⚠'}</span>
          <span class="lp-exc-line">${ex.line}</span>
          <span class="lp-exc-day">${ex.day}</span>
          <span class="lp-exc-msg">${ex.msg}</span>
          <button class="btn btn-sm lp-exc-fix" onclick="NIMBUS.App.gotoLaborSub('line-plan')">Line Plan →</button>
        </div>`).join('');
      container.innerHTML = `<div class="lp-exc-summary">${exceptions.length} exception${exceptions.length !== 1 ? 's' : ''}</div><div class="lp-exc-list">${rows}</div>`;
    }

    // ── Inputs sub-tab ───────────────────────────────────────────────────────
    function _renderInputs() {
      const container = document.getElementById('labor-inputs-pane'); if (!container) return;
      container.innerHTML = `
        <div class="lp-inputs-section">
          <h3 class="lp-inputs-title">Disaggregation</h3>
          <div class="lp-input-row">
            <label class="lp-input-label">Default split mode</label>
            <select class="lp-input-sel"><option selected>Even split (equal hours per open day)</option></select>
            <span class="lp-input-hint">Aggregate group/week hours divide evenly across each line's open working days. Right-click any Line Plan cell to reset an override to even-split.</span>
          </div>
        </div>
        <div class="lp-inputs-section">
          <h3 class="lp-inputs-title">Horizon</h3>
          <div class="lp-input-row">
            <label class="lp-input-label">Week span</label>
            <select class="lp-input-sel" onchange="NIMBUS.LaborPlanning.setSpan(+this.value)">
              <option value="4" ${_horizonSpan===4?'selected':''}>4 weeks</option>
              <option value="8" ${_horizonSpan===8?'selected':''}>8 weeks</option>
              <option value="12" ${_horizonSpan===12?'selected':''}>12 weeks</option>
              <option value="16" ${_horizonSpan===16?'selected':''}>16 weeks</option>
            </select>
          </div>
        </div>
        <div class="lp-inputs-section">
          <h3 class="lp-inputs-title">Aggregate ↔ Line reconciliation</h3>
          <p style="font-size:12px;color:var(--fg-mute);margin:0;">When aggregate hours are saved, the system auto-splits to lines via even split across open working days. Overridden line·day cells are pinned (●) and do not re-split until manually reset.</p>
        </div>`;
    }

    // ── Toolbar update ───────────────────────────────────────────────────────
    function _renderToolbar(plant) {
      // Group multi-select button label
      const lbl = document.getElementById('lp-group-label');
      if (lbl) {
        if (_selectedGroups.size === 0)           lbl.textContent = 'All Groups';
        else if (_selectedGroups.size === 1)      lbl.textContent = [..._selectedGroups][0];
        else                                      lbl.textContent = `${_selectedGroups.size} groups`;
      }
      // Rebuild dropdown checkboxes (keeps checked state in sync)
      const drop = document.getElementById('lp-group-dropdown');
      if (drop) {
        drop.innerHTML =
          `<div class="lp-group-scroll">` +
          _groups.map(g => `
            <label class="lp-group-chk-row">
              <input type="checkbox" value="${g.replace(/"/g,'&quot;')}"${_selectedGroups.has(g) ? ' checked' : ''}
                onchange="NIMBUS.LaborPlanning.onGroupToggle(this.value,this.checked)">
              ${g}
            </label>`).join('') +
          `</div>
          <div class="lp-group-chk-footer">
            <button class="btn btn-sm" onclick="NIMBUS.LaborPlanning.clearGroupFilter()">Clear</button>
          </div>`;
      }
      // Flatpickr date-jump: lazily init, then sync to current horizon start
      if (_weeks.length) {
        if (!_fpHorizon) {
          _fpHorizon = flatpickr('#labor-horizon-input', {
            dateFormat: 'M j, Y',
            onChange(dates) {
              if (!dates[0]) return;
              const now = new Date();
              const todayMon = new Date(now);
              todayMon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
              _horizonOffset = Math.round((dates[0] - todayMon) / (7 * Config.MS_DAY));
              render();
            },
          });
        }
        _fpHorizon.setDate(_weeks[0].monday, false);
      }
      const badge = document.getElementById('labor-plant-badge');
      if (badge) badge.textContent = plant || '—';
    }

    // ── Main render ──────────────────────────────────────────────────────────
    async function render() {
      _weeks = _computeWeeks();
      const plant = Store.selectedPlant;
      if (!plant) {
        ['labor-grid','labor-line-grid','labor-capacity-grid','labor-exceptions-list','labor-inputs-pane'].forEach(id => {
          const el = document.getElementById(id); if (el) el.innerHTML = '';
        });
        const grid = document.getElementById('labor-grid');
        if (grid) grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${t('ui.select_plant_labor')}</div>`;
        document.getElementById('labor-plant-badge')?.setAttribute && (document.getElementById('labor-plant-badge').textContent = '—');
        document.getElementById('labor-kpi-strip') && (document.getElementById('labor-kpi-strip').innerHTML = '');
        return;
      }
      const mdLines = (Store._state.masterData?.lines || []).filter(r => r.plant === plant);
      _groups = [...new Set(mdLines.map(r => r.pl_group).filter(Boolean))].sort();
      if (!_groups.length) {
        const grid = document.getElementById('labor-grid');
        if (grid) grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${t('empty.no_line_groups_plant')}</div>`;
        return;
      }
      _renderToolbar(plant);
      _renderKPIs(plant);
      const sub = App._laborSub || 'aggregate';
      if (sub === 'aggregate')   await _renderAggregate(plant);
      else if (sub === 'line-plan')  await _renderLinePlan(plant);
      else if (sub === 'capacity')   await _renderCapacity(plant);
      else if (sub === 'exceptions') await _renderExceptions(plant);
      else if (sub === 'inputs')     _renderInputs();
    }

    function _onLPKeyDown(e) {
      if (!_selRange || App._currentTab !== 'labor') return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); _clearSelection(); return; }
      if (e.key === 'Delete' || (e.key === 'Backspace' && !e.target?.classList.contains('lp-cell'))) {
        e.preventDefault(); e.stopImmediatePropagation(); _deleteSelected(); return;
      }
      if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); e.stopImmediatePropagation(); _copySelected(); return; }
    }

    function init() {
      document.addEventListener('keydown', _onLPKeyDown, { capture: true });
      document.addEventListener('mouseup', () => { _dragging = false; });
      Store.subscribe(evt => {
        if ((evt.type === 'plant:selected' || evt.type === 'master-data-changed') && App._currentTab === 'labor') {
          if (evt.type === 'plant:selected') { delete _aggrData[evt.plant]; delete _lineData[evt.plant]; }
          render();
        }
      }, 'Labor');
    }

    return {
      init, render,
      onGroupToggle(group, checked) {
        if (checked) _selectedGroups.add(group); else _selectedGroups.delete(group);
        _renderToolbar(Store.selectedPlant || '');
        const plant = Store.selectedPlant; if (!plant) return;
        const sub = App._laborSub;
        if (sub === 'aggregate')       _renderAggregate(plant);
        else if (sub === 'line-plan')  _renderLinePlan(plant);
        else if (sub === 'capacity')   _renderCapacity(plant);
        else if (sub === 'exceptions') _renderExceptions(plant);
      },
      clearGroupFilter() {
        _selectedGroups.clear();
        _renderToolbar(Store.selectedPlant || '');
        const plant = Store.selectedPlant; if (!plant) return;
        const sub = App._laborSub;
        if (sub === 'aggregate')       _renderAggregate(plant);
        else if (sub === 'line-plan')  _renderLinePlan(plant);
        else if (sub === 'capacity')   _renderCapacity(plant);
        else if (sub === 'exceptions') _renderExceptions(plant);
      },
      toggleGroupDropdown(e) {
        e?.stopPropagation();
        const drop = document.getElementById('lp-group-dropdown');
        if (!drop) return;
        drop.hidden = !drop.hidden;
        if (!drop.hidden) {
          const close = ev => { if (!drop.contains(ev.target) && ev.target.id !== 'lp-group-btn') { drop.hidden = true; document.removeEventListener('click', close); } };
          setTimeout(() => document.addEventListener('click', close), 0);
        }
      },
      prevHorizon() { _horizonOffset -= _horizonSpan; render(); },
      nextHorizon() { _horizonOffset += _horizonSpan; render(); },
      setSpan(n) {
        _horizonSpan = n;
        const sel = document.getElementById('labor-span-sel'); if (sel) sel.value = n;
        render();
      },
    };
  })();

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

  /* =============================================================================
     ADMIN COCKPIT — health bar, pipeline inspector, backend warnings,
     filterable logs, upload, purge, and upload history.
     ========================================================================== */
  const AdminCockpit = {
    _initialized: false,
    _pendingFile: null,
    _logFilter: { level: 'all', scope: 'all', search: '', errorCode: 'all', reqId: '' },
    _backendLogFilter: { level: 'all', category: 'all', since: '', q: '', reqId: '' },
    _healthData: null,
    _deepData: null,
    _healthTimer: null,
    _pipelineOpen: null,
    _activeSub: 'overview',
    _activeOvTab: 'diagnostics',
    _dbDeepAbort: null,
    _backendLogAbort: null,

    gotoOvTab(tab) {
      AdminCockpit._activeOvTab = tab;
      document.querySelectorAll('.admin-ov-tabs .sub-subtab').forEach(b =>
        b.classList.toggle('active', b.dataset.ovTab === tab));
      ['diagnostics', 'data-ops', 'logs', 'thread'].forEach(t => {
        const el = document.getElementById(`admin-ov-${t}`);
        if (el) el.hidden = (t !== tab);
      });
      if (tab === 'thread') AdminCockpit._refreshThreadPane();
    },

    _setSub(sub) {
      AdminCockpit._activeSub = sub;
      document.querySelectorAll('.admin-subtab').forEach(b =>
        b.classList.toggle('active', b.dataset.sub === sub));
      const ov = document.getElementById('admin-overview-pane');
      const mg = document.getElementById('admin-manage-pane');
      const ifc = document.getElementById('admin-interface-pane');
      const sec = document.getElementById('admin-security-pane');
      if (ov) ov.hidden = (sub !== 'overview');
      if (mg) mg.hidden = (sub !== 'manage');
      if (ifc) ifc.hidden = (sub !== 'interface');
      if (sec) sec.hidden = (sub !== 'security');
      if (sub === 'manage') MasterData.render();
      else if (sub === 'interface') Interface.render();
      else if (sub === 'security') Security.render();
      else AdminCockpit._renderOverview();
    },

    init() {
      if (AdminCockpit._initialized) return;
      AdminCockpit._initialized = true;

      document.querySelectorAll('.admin-subtab').forEach(b =>
        b.addEventListener('click', () => AdminCockpit._setSub(b.dataset.sub)));

      // Upload zone — drag-drop + click-browse
      const _uploadZone = document.getElementById('admin-upload-zone');
      const _uploadFile = document.getElementById('admin-upload-file');
      if (_uploadZone && _uploadFile) {
        _uploadZone.onclick    = e => { if (e.target !== _uploadFile) _uploadFile.click(); };
        _uploadZone.onkeydown  = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _uploadFile.click(); } };
        _uploadFile.onchange   = () => { if (_uploadFile.files[0]) AdminCockpit._pickFile(_uploadFile.files[0]); };
        _uploadZone.ondragover = e => { e.preventDefault(); _uploadZone.classList.add('drag-over'); };
        _uploadZone.ondragleave= () => _uploadZone.classList.remove('drag-over');
        _uploadZone.ondrop     = e => {
          e.preventDefault();
          _uploadZone.classList.remove('drag-over');
          const f = e.dataTransfer.files[0];
          if (f) AdminCockpit._pickFile(f);
        };
      }
      document.getElementById('admin-upload-clear')?.addEventListener('click', AdminCockpit._clearUpload);
      document.getElementById('admin-upload-btn')?.addEventListener('click', AdminCockpit._upload);
      document.getElementById('admin-purge-btn')?.addEventListener('click', AdminCockpit._purge);

      document.getElementById('admin-log-reload')?.addEventListener('click', () => Persistence.reload());
      document.getElementById('admin-log-cache')?.addEventListener('click', () => Persistence.clearCache());
      document.getElementById('admin-log-copy')?.addEventListener('click', () => ErrorLog.copy());
      document.getElementById('admin-log-copy-filtered')?.addEventListener('click', () => AdminCockpit._copyFiltered());
      document.getElementById('admin-log-clear')?.addEventListener('click', () => {
        ErrorLog.clear();
        AdminCockpit._renderLogs();
      });

      document.getElementById('admin-audit-reload')?.addEventListener('click', AdminCockpit._renderAudit);
      document.getElementById('admin-audit-clear')?.addEventListener('click', AdminCockpit._clearAudit);
      document.getElementById('admin-audit-log-reload')?.addEventListener('click', AdminCockpit._renderAuditLog);
      document.getElementById('admin-audit-log-clear')?.addEventListener('click', AdminCockpit._clearAuditLog);
      document.getElementById('admin-health-refresh')?.addEventListener('click', AdminCockpit._renderHealth);
      document.getElementById('admin-pipeline-refresh')?.addEventListener('click', AdminCockpit._renderPipeline);
      document.getElementById('admin-db-deep-refresh')?.addEventListener('click', AdminCockpit._renderDbDeep);
      document.getElementById('admin-db-deep')?.addEventListener('click', async e => {
        const btn = e.target.closest('[data-maint-action]');
        if (!btn) return;
        const action = btn.dataset.maintAction;
        const table  = btn.dataset.maintTable || null;
        if (action === 'vacuum-analyze' && !table) {
          const ok = await Modal.confirm({ title: t('ui.maint_vacuum_all_confirm'), confirmLabel: t('btn.run') });
          if (!ok) return;
        }
        AdminCockpit._runMaintenance(action, table, btn);
      });
      document.getElementById('admin-backend-log-refresh')?.addEventListener('click', AdminCockpit._renderBackendLog);
      document.getElementById('admin-backend-log-clear')?.addEventListener('click', AdminCockpit._clearBackendLog);
      document.getElementById('admin-backend-log-filter-level')?.addEventListener('change', e => {
        AdminCockpit._backendLogFilter.level = e.target.value;
        AdminCockpit._renderBackendLog();
      });

      // Filter controls
      document.getElementById('admin-log-filter-level')?.addEventListener('change', e => {
        AdminCockpit._logFilter.level = e.target.value;
        AdminCockpit._renderLogs();
      });
      document.getElementById('admin-log-filter-scope')?.addEventListener('change', e => {
        AdminCockpit._logFilter.scope = e.target.value;
        AdminCockpit._renderLogs();
      });
      document.getElementById('admin-log-search')?.addEventListener('input', e => {
        AdminCockpit._logFilter.search = e.target.value.toLowerCase();
        AdminCockpit._renderLogs();
      });

      ErrorLog.subscribe(() => {
        const panel = document.getElementById('admin-tab');
        if (panel?.classList.contains('active')) {
          AdminCockpit._renderLogs();
        }
      });

      document.getElementById('admin-thread-clear')?.addEventListener('click', () => {
        PerfMonitor.clear();
        AdminCockpit._refreshThreadPane();
      });

      PerfMonitor.subscribe(() => {
        if (AdminCockpit._activeOvTab === 'thread') AdminCockpit._refreshThreadPane();
      });

      Store.subscribe(evt => {
        if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate') {
          const panel = document.getElementById('admin-tab');
          if (panel?.classList.contains('active')) {
            // Defer so Persistence._lastLoad stats are fully written before rendering.
            setTimeout(() => AdminCockpit._renderPipeline(), 50);
          }
        }
      }, 'AdminCockpit');

      document.addEventListener('mouseover', e => {
        const el = e.target.closest?.('.adm-help');
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--tip-x', `${r.left + r.width / 2}px`);
        el.style.setProperty('--tip-y', `${r.top}px`);
      });
    },

    render() {
      AdminCockpit._setSub('overview');
      AdminCockpit._renderOverview();
    },

    _renderOverview() {
      AdminCockpit._renderPurgeMeta();
      AdminCockpit._renderHealth();
      AdminCockpit._renderDiagnostics();
      AdminCockpit._renderPipeline();
      AdminCockpit._renderDbDeep();
      AdminCockpit._renderBackendLog();
      AdminCockpit._renderLogs();
      AdminCockpit._renderAudit();
      AdminCockpit._renderAuditLog();
      AdminCockpit._startHealthPolling();
    },

    _startHealthPolling() {
      if (AdminCockpit._healthTimer) return;
      AdminCockpit._healthTimer = setInterval(() => {
        if (document.getElementById('admin-tab')?.classList.contains('active')) {
          AdminCockpit._renderHealth();
        }
      }, 30_000);
    },

    _stopHealthPolling() {
      if (AdminCockpit._healthTimer) {
        clearInterval(AdminCockpit._healthTimer);
        AdminCockpit._healthTimer = null;
      }
    },

    _renderHealth() {
      AdminCockpit._healthAbort?.abort();
      AdminCockpit._healthAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._healthAbort.signal, AbortSignal.timeout(6000)])
        : AdminCockpit._healthAbort.signal;
      Util.fetchTraced(`${Config.API_BASE}/health`, { signal: sig })
        .then(r => r.json())
        .then(data => {
          AdminCockpit._healthData = data;
          const db = data.db || {};
          const mem = data.memory || {};
          const cw = data.color_wheel || {};

          const dbEl = document.getElementById('admin-health-db');
          if (dbEl) {
            const dot = dbEl.querySelector('.admin-health-dot');
            const lbl = dbEl.querySelector('.admin-health-label');
            const cls = !db.connected ? 'err' : db.ping_ms > 500 ? 'warn' : 'ok';
            dot.className = `admin-health-dot ${cls}`;
            lbl.textContent = db.connected
              ? `DB ${db.ping_ms}ms`
              : `DB offline${db.error ? ': ' + db.error.slice(0, 60) : ''}`;
          }

          const ordEl = document.getElementById('admin-health-orders');
          if (ordEl) {
            ordEl.querySelector('.admin-health-label').textContent =
              `${(db.total_orders ?? 0).toLocaleString()} orders`;
          }

          const ovEl = document.getElementById('admin-health-overrides');
          if (ovEl) {
            ovEl.querySelector('.admin-health-label').textContent =
              `${(db.user_overrides ?? 0).toLocaleString()} user overrides`;
          }

          const cwEl = document.getElementById('admin-health-color');
          if (cwEl) {
            const dot = cwEl.querySelector('.admin-health-dot');
            const lbl = cwEl.querySelector('.admin-health-label');
            const misses = cw.misses ?? 0;
            dot.className = `admin-health-dot ${misses > 0 ? 'warn' : 'ok'}`;
            lbl.textContent = misses > 0
              ? t('ui.color_wheel_miss', { count: misses, plural: misses === 1 ? '' : 'es' })
              : t('ui.color_wheel_all_matched');
          }

          const poolChip = document.getElementById('admin-health-pool');
          if (poolChip) {
            const pPool = data.pool || {};
            const dot  = poolChip.querySelector('.admin-health-dot');
            const plbl = poolChip.querySelector('.admin-health-label');
            if (pPool.error) {
              if (dot) dot.className = 'admin-health-dot warn';
              if (plbl) plbl.textContent = t('ui.pool_unavailable');
            } else {
              const used = (pPool.pool_size ?? 0) - (pPool.pool_available ?? 0);
              const max  = pPool.pool_max || 1;
              const pct  = Math.round(100 * used / max);
              const cls  = pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok');
              if (dot) dot.className = `admin-health-dot ${cls}`;
              if (plbl) plbl.textContent = `Pool ${used}/${max}`;
            }
          }

          const ldEl = document.getElementById('admin-health-loaded');
          if (ldEl) {
            const lbl = ldEl.querySelector('.admin-health-label');
            const loadedAt = mem.loaded_at ? new Date(mem.loaded_at) : null;
            lbl.textContent = loadedAt
              ? `Loaded ${AdminCockpit._relTime(loadedAt)}${mem.load_ms != null ? ' · ' + mem.load_ms + 'ms' : ''}`
              : t('ui.not_loaded');
          }
        })
        .catch(e => {
          const dbEl = document.getElementById('admin-health-db');
          if (dbEl) {
            const dot = dbEl.querySelector('.admin-health-dot');
            const lbl = dbEl.querySelector('.admin-health-label');
            dot.className = 'admin-health-dot err';
            lbl.textContent = t('ui.backend_unreachable');
          }
          if (e.name !== 'AbortError') ErrorLog.warn('admin', `Health check failed: ${e.message}`);
        });
    },

    _renderPipeline() {
      const wrap = document.getElementById('admin-pipeline');
      if (!wrap) return;

      AdminCockpit._pipelineAbort?.abort();
      AdminCockpit._pipelineAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._pipelineAbort.signal, AbortSignal.timeout(8000)])
        : AdminCockpit._pipelineAbort.signal;
      Util.fetchTraced(`${Config.API_BASE}/diagnostics/deep`, { signal: sig })
        .then(r => r.json())
        .then(data => {
          AdminCockpit._deepData = data;
          const p = data.pipeline || {};
          const dbSt = data.db_stats || {};
          const cw = data.color_wheel || {};
          const st = Persistence.stats ? Persistence.stats() : {};

          const rendered   = st.rendered ?? 0;
          const rawDb      = p.raw_row_count ?? dbSt.total ?? 0;
          const activePlant = st.plant ?? null;
          // Color-merge stats come from the last /tasks response (per-request,
          // plant-scoped) — not /diagnostics/deep, which holds load-time defaults.
          const colorMiss  = st.color_merge_misses ?? 0;
          // received = rows after both plant filter + color merge (what UI got)
          const received   = st.raw_received ?? 0;
          // Rows entering color merge = post-plant-filter count (= received + misses)
          const preMerge   = st.pre_color_merge_count ?? (received + colorMiss);
          // Rows removed by plant filter = raw - what entered color merge
          const plantFiltered = activePlant ? Math.max(0, rawDb - preMerge) : 0;
          const gap = received - rendered;

          // Pipeline order: DB → [Plant filter if active] → Color Merge → Emitted → Rendered.
          // Reordered (May 2026) so color-miss counts are plant-scoped — the merge
          // now runs *after* the plant filter, against only the rows the user will see.
          const steps = [
            {
              key: 'db',
              label: 'DB Load',
              count: rawDb,
              delta: null,
              status: p.dropped_no_start_date > 0 ? 'warn' : 'ok',
              detail: () => AdminCockpit._pipelineDetailDB(p, dbSt),
            },
            ...(activePlant ? [{
              key: 'plant-filter',
              label: `Plant ${activePlant}`,
              count: preMerge,
              delta: plantFiltered > 0 ? `-${plantFiltered} (other plants)` : null,
              status: 'ok',
              detail: () => AdminCockpit._pipelineDetailPlantFilter(st, plantFiltered, rawDb),
            }] : []),
            {
              key: 'color',
              label: 'Color Merge',
              count: received,
              delta: colorMiss > 0 ? `-${colorMiss} miss${colorMiss === 1 ? '' : 'es'}` : null,
              status: colorMiss > 0 ? 'warn' : 'ok',
              detail: () => AdminCockpit._pipelineDetailColor(p, cw, st),
            },
            {
              key: 'emitted',
              label: 'Emitted',
              count: received,
              delta: null,
              status: p.warnings?.length > 0 ? 'warn' : 'ok',
              detail: () => AdminCockpit._pipelineDetailEmitted(p, st),
            },
            {
              key: 'rendered',
              label: 'Rendered',
              count: rendered,
              delta: gap > 0 ? `-${gap} gap` : null,
              status: gap > 0 ? 'err' : 'ok',
              detail: () => AdminCockpit._pipelineDetailRendered(st, p),
            },
          ];

          wrap.textContent = '';
          steps.forEach((s, i) => {
            if (i > 0) {
              const arrow = document.createElement('span');
              arrow.className = 'admin-pipeline-arrow';
              arrow.textContent = '→';
              wrap.appendChild(arrow);
            }
            const box = document.createElement('div');
            box.className = `admin-pipeline-step ${s.status}`;
            box.dataset.key = s.key;

            const cnt = document.createElement('div');
            cnt.className = 'admin-pipeline-step-count';
            cnt.textContent = s.count.toLocaleString();
            box.appendChild(cnt);

            const lbl = document.createElement('div');
            lbl.className = 'admin-pipeline-step-label';
            lbl.textContent = s.label;
            box.appendChild(lbl);

            if (s.delta) {
              const delta = document.createElement('div');
              delta.className = 'admin-pipeline-delta';
              delta.textContent = s.delta;
              box.appendChild(delta);
            }

            box.addEventListener('click', () => {
              const detail = document.getElementById('admin-pipeline-detail');
              if (!detail) return;
              if (AdminCockpit._pipelineOpen === s.key) {
                AdminCockpit._pipelineOpen = null;
                detail.classList.remove('open');
                detail.textContent = '';
              } else {
                AdminCockpit._pipelineOpen = s.key;
                detail.classList.add('open');
                detail.textContent = '';
                detail.appendChild(s.detail());
              }
            });

            wrap.appendChild(box);
          });

          // Backend warnings
          AdminCockpit._renderBackendWarnings(p.warnings || []);
        })
        .catch(e => {
          if (e.name === 'AbortError') return;
          wrap.innerHTML = `<div class="admin-log-empty">Could not load pipeline: ${e.message}</div>`;
          ErrorLog.warn('admin', `Pipeline fetch failed: ${e.message}`);
        });
    },

    _pipelineDetailDB(p, dbSt) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      head.textContent = t('ui.db_load_details');
      frag.appendChild(head);

      const rows = [
        [t('ui.diag_total_in_db'), (dbSt.total ?? '—').toLocaleString()],
        [t('ui.diag_null_start_date'), dbSt.null_start ?? '—'],
        [t('ui.diag_null_end_date'), dbSt.null_end ?? '—'],
        [t('ui.diag_null_color'), dbSt.null_color ?? '—'],
        [t('ui.diag_null_line'), dbSt.null_line ?? '—'],
        [t('ui.diag_null_desc'), dbSt.null_desc ?? '—'],
        [t('ui.diag_null_runtime'), dbSt.null_runtime ?? '—'],
        [t('ui.diag_date_range_min'), dbSt.date_range?.min?.slice(0, 10) ?? '—'],
        [t('ui.diag_date_range_max'), dbSt.date_range?.max?.slice(0, 10) ?? '—'],
        [t('ui.diag_dropped_no_start'), p.dropped_no_start_date ?? 0],
        [t('ui.diag_load_time'), p.load_ms != null ? p.load_ms + ' ms' : '—'],
      ];

      if (dbSt.by_line && Object.keys(dbSt.by_line).length) {
        const lbl = document.createElement('div');
        lbl.className = 'admin-pdtl-sub';
        lbl.textContent = t('ui.orders_by_line');
        frag.appendChild(AdminCockpit._kvTable(rows));
        frag.appendChild(lbl);
        frag.appendChild(AdminCockpit._lineBar(dbSt.by_line));
        return frag;
      }

      frag.appendChild(AdminCockpit._kvTable(rows));
      return frag;
    },

    _pipelineDetailColor(p, cw, st) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      const scope = st?.plant ? ` (${t('ui.plant_prefix')} ${st.plant})` : '';
      head.textContent = t('ui.color_wheel_details') + scope;
      frag.appendChild(head);

      // Misses are now plant-scoped — pulled from the last /tasks meta via Persistence stats.
      const requestMiss = st?.color_merge_misses ?? 0;
      const requestMissed = st?.missed_colors ?? [];
      const requestMs = st?.backend_meta?.color_merge_ms;

      const rows = [
        [t('ui.diag_scope'), st?.plant ? `${t('ui.plant_prefix')} ${st.plant} only` : t('ui.all_plants')],
        [t('ui.diag_rows_entering_merge'), st?.pre_color_merge_count ?? '—'],
        [t('ui.diag_global_wheel_colors'), cw.wheel_total ?? '—'],
        [t('ui.diag_matched_rows'), (st?.pre_color_merge_count ?? 0) - requestMiss],
        [t('ui.diag_missed_rows'), requestMiss],
        [t('ui.diag_merge_time'), requestMs != null ? requestMs + ' ms' : '—'],
      ];
      frag.appendChild(AdminCockpit._kvTable(rows));

      if (requestMissed.length) {
        const sub = document.createElement('div');
        sub.className = 'admin-pdtl-sub';
        sub.textContent = t('ui.unmatched_colors', { count: requestMissed.length });
        frag.appendChild(sub);
        const chips = document.createElement('div');
        chips.className = 'admin-pdtl-chips';
        for (const c of requestMissed) {
          const chip = document.createElement('span');
          chip.className = 'admin-pdtl-chip warn';
          chip.textContent = c;
          chips.appendChild(chip);
        }
        frag.appendChild(chips);
      } else {
        const ok = document.createElement('div');
        ok.className = 'admin-pdtl-ok';
        ok.textContent = t('empty.no_colors_matched');
        frag.appendChild(ok);
      }
      return frag;
    },

    _pipelineDetailEmitted(p, st) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      head.textContent = t('ui.emitted_details');
      frag.appendChild(head);

      const scopeLbl = st?.plant ? `${t('ui.plant_prefix')} ${st.plant}` : t('ui.all_plants');
      const rows = [
        [t('ui.diag_raw_from_db'), p.raw_row_count ?? '—'],
        [t('ui.diag_dropped_no_start'), p.dropped_no_start_date ?? 0],
        [t('ui.diag_active_scope'), scopeLbl],
        [t('ui.diag_rows_entering_cmerge'), st?.pre_color_merge_count ?? '—'],
        [t('ui.diag_color_merge_misses'), st?.color_merge_misses ?? 0],
        [t('ui.diag_emitted'), st?.raw_received ?? '—'],
        [t('ui.diag_unique_ids'), p.unique_id_count ?? '—'],
        [t('ui.diag_loaded_at'), p.loaded_at ? p.loaded_at.replace('T', ' ').slice(0, 19) + ' UTC' : '—'],
      ];
      frag.appendChild(AdminCockpit._kvTable(rows));

      const warnings = p.warnings || [];
      if (warnings.length) {
        const sub = document.createElement('div');
        sub.className = 'admin-pdtl-sub';
        sub.textContent = t('ui.diag_backend_load_warnings', { count: warnings.length });
        frag.appendChild(sub);
        frag.appendChild(AdminCockpit._warningList(warnings));
      }
      return frag;
    },

    _pipelineDetailPlantFilter(st, plantFiltered, rawDb) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      head.textContent = t('ui.plant_filter_details');
      frag.appendChild(head);

      // Pipeline order is now: DB → Plant filter → Color merge → Emitted.
      // The pre-merge count here is what reaches the color merge stage.
      const preMerge = st?.pre_color_merge_count ?? 0;
      const rows = [
        [t('ui.diag_active_plant'), st.plant ?? '—'],
        [t('ui.diag_raw_rows_from_db'), rawDb ?? '—'],
        [t('ui.diag_rows_this_plant'), preMerge],
        [t('ui.diag_other_plant_excluded'), plantFiltered],
        [t('ui.diag_final_emitted'), st.raw_received ?? '—'],
      ];
      frag.appendChild(AdminCockpit._kvTable(rows));
      return frag;
    },

    _pipelineDetailRendered(st, p) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      head.textContent = t('ui.rendering_details');
      frag.appendChild(head);

      // Gap is measured from received (post-plant-filter) so plant filtering does not
      // look like data loss here.
      const received = st.raw_received ?? 0;
      const rendered = st.rendered ?? 0;
      const gap = received - rendered;
      const rows = [
        [t('ui.diag_received_by_ui'), received],
        [t('ui.diag_pl_filtered'), st.filtered_pl ?? 0],
        [t('ui.diag_null_id_dropped'), st.filtered_null_id ?? 0],
        [t('ui.diag_store_collisions'), st.dedup_collisions ?? 0],
        [t('ui.diag_rendered'), rendered],
        [t('ui.diag_gap'), gap],
        [t('ui.diag_source'), st.source ?? '—'],
      ];
      frag.appendChild(AdminCockpit._kvTable(rows));

      if (gap > 0) {
        const warn = document.createElement('div');
        warn.className = 'admin-pdtl-warn';
        warn.textContent = t('ui.data_gap_warn', { count: gap });
        frag.appendChild(warn);
      }
      return frag;
    },

    _kvTable(rows) {
      const tbl = document.createElement('table');
      tbl.className = 'admin-pdtl-tbl';
      for (const [k, v] of rows) {
        const tr = document.createElement('tr');
        const tdK = document.createElement('td');
        tdK.className = 'admin-pdtl-key';
        tdK.textContent = k;
        const tdV = document.createElement('td');
        tdV.className = 'admin-pdtl-val';
        tdV.textContent = String(v ?? '—');
        tr.appendChild(tdK);
        tr.appendChild(tdV);
        tbl.appendChild(tr);
      }
      return tbl;
    },

    _lineBar(byLine) {
      const wrap = document.createElement('div');
      wrap.className = 'admin-pdtl-linebars';
      const max = Math.max(...Object.values(byLine));
      for (const [line, cnt] of Object.entries(byLine)) {
        const row = document.createElement('div');
        row.className = 'admin-pdtl-linebar-row';
        const lbl = document.createElement('span');
        lbl.className = 'admin-pdtl-linebar-lbl';
        lbl.textContent = line;
        const bar = document.createElement('div');
        bar.className = 'admin-pdtl-linebar-track';
        const fill = document.createElement('div');
        fill.className = 'admin-pdtl-linebar-fill';
        fill.style.width = `${Math.round((cnt / max) * 100)}%`;
        const num = document.createElement('span');
        num.className = 'admin-pdtl-linebar-num';
        num.textContent = cnt;
        bar.appendChild(fill);
        row.appendChild(lbl);
        row.appendChild(bar);
        row.appendChild(num);
        wrap.appendChild(row);
      }
      return wrap;
    },

    _warningList(warnings) {
      const ul = document.createElement('div');
      ul.className = 'admin-bwarn-list';
      for (const w of warnings) {
        const row = document.createElement('div');
        row.className = `admin-bwarn-row admin-bwarn-${w.level || 'warn'}`;
        const lvl = document.createElement('span');
        lvl.className = 'admin-bwarn-lvl';
        lvl.textContent = (w.level || 'warn').toUpperCase();
        const msg = document.createElement('span');
        msg.className = 'admin-bwarn-msg';
        msg.textContent = w.msg || '';
        row.appendChild(lvl);
        row.appendChild(msg);
        ul.appendChild(row);
      }
      return ul;
    },

    _renderBackendWarnings(warnings) {
      const host = document.getElementById('admin-backend-warnings');
      const countEl = document.getElementById('admin-bwarn-count');
      if (!host) return;
      host.textContent = '';
      if (countEl) countEl.textContent = t('ui.bwarn_count', { count: warnings.length });

      if (!warnings.length) {
        const ok = document.createElement('div');
        ok.className = 'admin-bwarn-empty';
        ok.textContent = t('empty.no_backend_warnings');
        host.appendChild(ok);
        return;
      }

      for (const w of warnings) {
        const row = document.createElement('div');
        row.className = `admin-bwarn-row admin-bwarn-${w.level || 'warn'}`;
        row.style.cursor = w.context && Object.keys(w.context).length ? 'pointer' : '';

        const meta = document.createElement('div');
        meta.className = 'admin-bwarn-meta';
        const lvl = document.createElement('span');
        lvl.className = 'admin-bwarn-lvl';
        lvl.textContent = (w.level || 'warn').toUpperCase();
        const ts = document.createElement('span');
        ts.className = 'admin-bwarn-ts';
        ts.textContent = w.ts ? w.ts.replace('T', ' ').slice(0, 19) + ' UTC' : '';
        meta.appendChild(lvl);
        meta.appendChild(ts);

        const msg = document.createElement('div');
        msg.className = 'admin-bwarn-msg';
        msg.textContent = w.msg || '';

        row.appendChild(meta);
        row.appendChild(msg);

        if (w.context && Object.keys(w.context).length) {
          const pre = document.createElement('pre');
          pre.className = 'admin-bwarn-ctx';
          pre.style.display = 'none';
          pre.textContent = JSON.stringify(w.context, null, 2);
          row.appendChild(pre);
          row.addEventListener('click', () => {
            pre.style.display = pre.style.display === 'none' ? '' : 'none';
          });
        }

        host.appendChild(row);
      }
    },

    _updatePurgeCount() {
      const start = AdminCockpit._fpPurgeStart?.selectedDates[0];
      const end   = AdminCockpit._fpPurgeEnd?.selectedDates[0];
      const el    = document.getElementById('admin-past-count');
      if (!el) return;
      if (!start || !end) { el.textContent = ''; return; }
      const endOfDay = new Date(end); endOfDay.setHours(23, 59, 59, 999);
      const count = (Store.tasksArr || []).filter(t => t.end_date && t.end_date >= start && t.end_date <= endOfDay).length;
      el.innerHTML = count > 0
        ? `<strong style="color:var(--err,#c0392b)">${t('ui.orders_in_range', {count, plural: count === 1 ? '' : 's'})}</strong>`
        : `<span style="color:var(--text-muted,#888)">${t('ui.orders_in_range', {count: 0, plural: 's'})}</span>`;
    },

    _renderPurgeMeta() {
      const yesterday   = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      if (!AdminCockpit._fpPurgeStart) {
        AdminCockpit._fpPurgeStart = flatpickr('#admin-purge-start', {
          dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
          onChange: () => AdminCockpit._updatePurgeCount(),
        });
        AdminCockpit._fpPurgeEnd = flatpickr('#admin-purge-end', {
          dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
          onChange: () => AdminCockpit._updatePurgeCount(),
        });
      }
      AdminCockpit._fpPurgeStart.setDate(twoWeeksAgo, false);
      AdminCockpit._fpPurgeEnd.setDate(yesterday, false);
      AdminCockpit._updatePurgeCount();
    },

    _setStatus(el, text, kind) {
      if (!el) return;
      el.textContent = text;
      el.className = 'admin-status' + (kind ? ' ' + kind : '');
    },

    _pickFile(file) {
      if (!file) return;
      AdminCockpit._pendingFile = file;
      document.getElementById('admin-upload-info').hidden = false;
      document.getElementById('admin-upload-actions').hidden = false;
      document.getElementById('admin-upload-fname').textContent = file.name;
      document.getElementById('admin-upload-fsize').textContent =
        file.size < 1_048_576
          ? `${(file.size / 1024).toFixed(1)} KB`
          : `${(file.size / 1_048_576).toFixed(1)} MB`;
      const status = document.getElementById('admin-upload-status');
      if (status) { status.textContent = ''; status.className = 'admin-status'; }
    },

    _clearUpload() {
      AdminCockpit._pendingFile = null;
      const fi = document.getElementById('admin-upload-file');
      if (fi) fi.value = '';
      const info    = document.getElementById('admin-upload-info');
      const actions = document.getElementById('admin-upload-actions');
      const status  = document.getElementById('admin-upload-status');
      if (info)    info.hidden = true;
      if (actions) actions.hidden = true;
      if (status)  { status.textContent = ''; status.className = 'admin-status'; }
    },

    _upload() {
      const f      = AdminCockpit._pendingFile;
      const status = document.getElementById('admin-upload-status');
      const zone   = document.getElementById('admin-upload-zone');
      const btn    = document.getElementById('admin-upload-btn');
      if (!f) {
        AdminCockpit._setStatus(status, t('toast.pick_xlsx_first'), 'warn');
        return;
      }
      if (zone) zone.classList.add('uploading');
      if (btn)  btn.disabled = true;
      AdminCockpit._setStatus(status, t('toast.uploading_file', { name: f.name }), 'info');
      const fd = new FormData();
      fd.append('file', f);
      const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      Util.fetchTraced(`${Config.API_BASE}/upload`, { method: 'POST', body: fd, headers: { 'x-request-id': reqId } })
        .then(r => r.json().catch(() => ({})).then(j => ({ ok: r.ok, body: j })))
        .then(({ ok, body }) => {
          if (zone) zone.classList.remove('uploading');
          if (btn)  btn.disabled = false;
          if (!ok || body.status !== 'ok') {
            const msg = body?.message || body?.detail || 'HTTP error';
            AdminCockpit._setStatus(status, t('toast.upload_failed', { msg }), 'error');
            ErrorLog.error('admin', `Upload failed: ${msg}`, body,
              { reqId, errorCode: body?.error_code || 'http.status' });
            return;
          }
          const warnCount = body.warnings?.length ?? 0;
          const w = warnCount ? ` (${warnCount} warning${warnCount === 1 ? '' : 's'})` : '';
          AdminCockpit._setStatus(
            status,
            `✓ Inserted ${body.inserted}, updated ${body.updated} of ${body.raw_row_count} rows${w}`,
            'success'
          );
          ErrorLog.info('admin',
            `Upload OK: inserted=${body.inserted} updated=${body.updated} batch=${body.batch_id}`, body);
          if (warnCount) {
            ErrorLog.warn('admin', `Upload had ${warnCount} warning(s)`, body.warnings);
          }
          Toast.show(t('toast.upload_ok', { count: body.inserted + body.updated }), 'success');
          setTimeout(() => AdminCockpit._clearUpload(), 2000);
          Persistence.reload().then(() => {
            AdminCockpit._renderHealth();
            AdminCockpit._renderPipeline();
          });
          AdminCockpit._renderAudit();
        })
        .catch(e => {
          if (zone) zone.classList.remove('uploading');
          if (btn)  btn.disabled = false;
          AdminCockpit._setStatus(status, t('toast.upload_failed', { msg: e.message }), 'error');
          ErrorLog.error('admin', `Upload network error: ${e.message}`,
            { reqId }, { reqId, errorCode: 'http.network' });
        });
    },

    async _purge() {
      const startEl = document.getElementById('admin-purge-start');
      const endEl   = document.getElementById('admin-purge-end');
      const status  = document.getElementById('admin-purge-status');
      const start = startEl?.value;
      const end   = endEl?.value;
      if (!start || !end) {
        AdminCockpit._setStatus(status, t('toast.pick_purge_dates'), 'warn');
        return;
      }
      if (start > end) {
        AdminCockpit._setStatus(status, t('toast.purge_start_before_end'), 'warn');
        return;
      }
      const ok = await Modal.confirm({ title: t('modal.purge_confirm', { start, end }), confirmLabel: t('btn.yes_delete') });
      if (!ok) return;

      AdminCockpit._setStatus(status, t('toast.purging', { start, end }), 'info');
      const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      Util.fetchTraced(`${Config.API_BASE}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-request-id': reqId },
        body: JSON.stringify({ start_date: start + 'T00:00:00', end_date: end + 'T23:59:59' })
      })
        .then(r => r.json().catch(() => ({})))
        .then(body => {
          if (body.status !== 'ok') {
            AdminCockpit._setStatus(status, t('toast.purge_failed', { msg: body.message || body.detail || 'unknown' }), 'error');
            ErrorLog.error('admin', `Purge failed: ${body.message || body.detail || 'unknown'}`, body,
              { reqId, errorCode: body?.error_code || 'http.status' });
            return;
          }
          AdminCockpit._setStatus(status, `✓ Deleted ${body.deleted} order${body.deleted === 1 ? '' : 's'}`, 'success');
          ErrorLog.info('admin', `Purge: deleted ${body.deleted} (${start} → ${end})`);
          Toast.show(t('toast.purge_ok', { count: body.deleted }), 'success');
          Persistence.reload().then(() => {
            AdminCockpit._renderHealth();
            AdminCockpit._renderPipeline();
          });
        })
        .catch(e => {
          AdminCockpit._setStatus(status, t('toast.purge_failed', { msg: e.message }), 'error');
          ErrorLog.error('admin', `Purge network error: ${e.message}`,
            { reqId }, { reqId, errorCode: 'http.network' });
        });
    },

    async _runMaintenance(action, table, triggerBtn) {
      const label = triggerBtn ? triggerBtn.textContent : action;
      if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = t('ui.maint_running'); }
      const body = table ? { table } : {};
      try {
        const r = await fetch(`${Config.API_BASE}/maintenance/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(res => res.json());
        if (!r.ok) throw new Error(r.error || 'maintenance failed');
        Toast.show(t('ui.maint_done', { label }), 'success');
        ErrorLog.info('admin', `Maintenance: ${action} ${table || '(all)'} ok`);
        AdminCockpit._renderDbDeep();
      } catch (e) {
        Toast.show(t('ui.maint_failed', { label, msg: e.message }), 'error');
        ErrorLog.error('admin', `Maintenance: ${action} ${table || '(all)'} failed: ${e.message}`);
        if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = label; }
      }
    },

    /* FE↔BE correlation: clicking a reqId pins it as a filter on BOTH panes and
       refreshes them so the operator sees the matching frontend + backend events. */
    _correlateReqId(reqId) {
      if (!reqId) return;
      AdminCockpit._logFilter.reqId        = reqId;
      AdminCockpit._backendLogFilter.reqId = reqId;
      AdminCockpit._renderLogs();
      AdminCockpit._renderBackendLog();
    },

    /* Render (or clear) a small "filtering by request <id>" chip at the top of a
       log list. `onClear` removes the filter. Self-contained: builds the chip if
       a reqId is set, removes any prior chip otherwise. */
    _renderReqIdChip(listId, reqId, onClear) {
      const list = document.getElementById(listId);
      if (!list || !list.parentElement) return;
      const chipId = `${listId}-reqid-chip`;
      let chip = document.getElementById(chipId);
      if (!reqId) { if (chip) chip.remove(); return; }
      if (!chip) {
        chip = document.createElement('div');
        chip.id = chipId;
        chip.className = 'admin-log-reqid-chip';
        list.parentElement.insertBefore(chip, list);
      }
      chip.textContent = '';
      const label = document.createElement('span');
      label.textContent = `req ${String(reqId).slice(0, 8)}…`;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'admin-log-reqid-chip-x';
      x.textContent = '✕';
      x.title = 'Clear request filter';
      x.addEventListener('click', () => { onClear(); });
      chip.appendChild(document.createTextNode('Filtering: '));
      chip.appendChild(label);
      chip.appendChild(x);
    },

    _getFilteredEntries() {
      const { level, scope, search, errorCode, reqId } = AdminCockpit._logFilter;
      return ErrorLog.entries().filter(e => {
        if (level !== 'all' && e.level !== level) return false;
        if (scope !== 'all' && e.scope !== scope) return false;
        if (errorCode && errorCode !== 'all' && e.errorCode !== errorCode) return false;
        if (reqId && e.reqId !== reqId) return false;
        if (search) {
          const haystack = `${e.scope} ${e.msg} ${e.ts} ${e.errorCode || ''} ${e.reqId || ''}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      });
    },

    /* -----------------------------------------------------------------------
       DB DEEP DIVE — fetches /diagnostics/db on demand, renders sections
       ----------------------------------------------------------------------- */
    _renderDbDeep() {
      const wrap = document.getElementById('admin-db-deep');
      if (!wrap) return;
      wrap.innerHTML = `<div class="admin-db-loading">${t('ui.diag_loading')}</div>`;

      AdminCockpit._dbDeepAbort?.abort();
      AdminCockpit._dbDeepAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._dbDeepAbort.signal, AbortSignal.timeout(12000)])
        : AdminCockpit._dbDeepAbort.signal;

      Util.fetchTraced(`${Config.API_BASE}/diagnostics/db`, { signal: sig })
        .then(r => r.json())
        .then(d => {
          wrap.textContent = '';

          // ── Top: summary tiles strip ──────────────────────────────────────────────
          AdminCockpit._dbSummaryStrip(d, wrap);

          if (d.fetched_at) {
            const tsEl = document.createElement('div');
            tsEl.className = 'admin-db-fetched';
            tsEl.textContent = t('ui.diag_last_refreshed', { time: AdminCockpit._relTime(new Date(d.fetched_at)) });
            wrap.appendChild(tsEl);
          }

          const mkSection = (title, statusCls, buildFn, openByDefault, helpText) => {
            const det = document.createElement('details');
            det.className = 'admin-db-section';
            if (openByDefault) det.open = true;
            const sum = document.createElement('summary');
            sum.className = 'admin-db-section-sum';
            const dot = document.createElement('span');
            dot.className = `admin-health-dot ${statusCls}`;
            const ttl = document.createElement('span');
            ttl.className = 'admin-db-section-title';
            ttl.textContent = title;
            sum.appendChild(dot);
            sum.appendChild(ttl);
            if (helpText) {
              const hEl = document.createElement('span');
              hEl.className = 'adm-help';
              hEl.tabIndex = 0;
              hEl.setAttribute('aria-label', t('aria.help'));
              hEl.addEventListener('click', e => e.stopPropagation());
              const hDot = document.createElement('span');
              hDot.className = 'adm-help-dot';
              hDot.textContent = '?';
              const hTip = document.createElement('span');
              hTip.className = 'adm-help-tip';
              hTip.textContent = helpText;
              hEl.appendChild(hDot);
              hEl.appendChild(hTip);
              sum.appendChild(hEl);
            }
            det.appendChild(sum);
            const body = document.createElement('div');
            body.className = 'admin-db-section-body';
            buildFn(body);
            det.appendChild(body);
            wrap.appendChild(det);
          };

          // ── 1. Connection Pool
          const pool = d.pool || {};
          const poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0);
          const poolMax  = pool.pool_max || 1;
          const poolSt   = pool.error ? 'err' : (pool.requests_waiting > 0 || pool.requests_errors > 0 ? 'warn' : 'ok');
          mkSection(t('ui.diag_section_pool'), poolSt, body => {
            if (pool.error) { body.textContent = pool.error; return; }
            body.appendChild(AdminCockpit._dbFillBar(poolUsed, poolMax, t('ui.diag_pool_utilization')));
            body.appendChild(AdminCockpit._kvTable([
              [t('ui.diag_pool_min_max'),         `${pool.pool_min ?? '—'} / ${pool.pool_max ?? '—'}`],
              [t('ui.diag_pool_in_use'),           `${poolUsed} / ${pool.pool_available ?? '—'}`],
              [t('ui.diag_requests_waiting'),      pool.requests_waiting ?? 0],
              [t('ui.diag_requests_completed'),    (pool.requests_completed ?? 0).toLocaleString()],
              [t('ui.diag_request_errors'),        pool.requests_errors ?? 0],
              [t('ui.diag_bad_returns'),           pool.returns_bad ?? 0],
            ]));
            if (pool.requests_waiting > 0)
              AdminCockpit._dbWarnBanner(body, t('ui.diag_pool_queued', { count: pool.requests_waiting }));
            if (pool.requests_errors > 0)
              AdminCockpit._dbWarnBanner(body, t('ui.diag_pool_errors', { count: pool.requests_errors }), true);
          }, true, t('ui.diag_desc_pool'));

          // ── 2. Server Info
          const srv = d.server || {};
          mkSection(t('ui.diag_section_server'), srv.error ? 'err' : 'ok', body => {
            if (srv.error) { body.textContent = srv.error; return; }
            body.appendChild(AdminCockpit._kvTable([
              [t('ui.diag_database'),        srv.database ?? '—'],
              [t('ui.diag_database_size'),   srv.db_size   ?? '—'],
              [t('ui.diag_max_connections'), srv.max_connections ?? '—'],
              [t('ui.diag_up_since'),        srv.started_at ? AdminCockpit._relTime(new Date(srv.started_at)) : '—'],
              [t('ui.diag_version'),         (srv.version || '').split(' (')[0]],
            ]));
          }, true, t('ui.diag_desc_server'));

          // ── 3. Table Health
          const tables = Array.isArray(d.tables) ? d.tables : [];
          const hasTableErr = tables[0]?.error;
          const tablesNeedWork = !hasTableErr && tables.some(t => t.needs_vacuum || t.needs_analyze);
          mkSection(t('ui.diag_section_table_health', { count: hasTableErr ? '?' : tables.length }),
              hasTableErr ? 'err' : (tablesNeedWork ? 'warn' : 'ok'), body => {
            if (hasTableErr) { body.textContent = tables[0].error; return; }
            if (!tables.length) { body.textContent = t('empty.no_user_tables'); return; }
            const strip = document.createElement('div');
            strip.className = 'db-maint-strip';
            const vacAllBtn = document.createElement('button');
            vacAllBtn.className = 'db-maint-global-btn';
            vacAllBtn.dataset.maintAction = 'vacuum-analyze';
            vacAllBtn.dataset.maintTable = '';
            vacAllBtn.textContent = t('ui.maint_vacuum_all');
            strip.appendChild(vacAllBtn);
            body.appendChild(strip);
            body.appendChild(AdminCockpit._dbTableCards(tables));
          }, false, t('ui.diag_desc_table_health'));

          // ── 4. Active Connections
          const conn = d.connections || {};
          const hasLong = (conn.long_running || []).length > 0;
          mkSection(t('ui.diag_section_connections', { count: conn.total ?? '?' }),
              conn.error ? 'err' : (hasLong ? 'warn' : 'ok'), body => {
            if (conn.error) { body.textContent = conn.error; return; }
            body.appendChild(AdminCockpit._dbStackBar(conn.by_state || {}));
            if (hasLong) {
              const sub = document.createElement('div');
              sub.className = 'admin-pdtl-sub';
              sub.textContent = t('ui.non_idle_queries');
              body.appendChild(sub);
              body.appendChild(AdminCockpit._dbTable(
                ['PID', 'State', 'Dur (s)', 'Wait event', 'Query'],
                (conn.long_running || []).map(q => ({
                  cells: [q.pid, q.state || '—', q.duration_s ?? '—', q.wait_event || '—', (q.query || '').slice(0, 120)],
                  rowWarn: (q.duration_s || 0) > 30,
                  cellWarn: [],
                }))
              ));
            }
          }, false, t('ui.diag_desc_connections'));

          // ── 5. Lock Waits
          const locks = Array.isArray(d.locks) ? d.locks : [];
          const hasLockErr = locks[0]?.error;
          const activeLocks = !hasLockErr && locks.length > 0;
          mkSection(t('ui.diag_section_lock_waits', { count: hasLockErr ? '?' : locks.length }),
              hasLockErr ? 'err' : (activeLocks ? 'err' : 'ok'), body => {
            if (hasLockErr) { body.textContent = locks[0].error; return; }
            if (!activeLocks) {
              const ok = document.createElement('div');
              ok.className = 'admin-db-ok-msg';
              ok.textContent = t('empty.no_lock_contention');
              body.appendChild(ok);
              return;
            }
            AdminCockpit._dbWarnBanner(body, t('ui.diag_blocking_locks', { count: locks.length }), true);
            body.appendChild(AdminCockpit._dbLockChain(locks));
          }, false, t('ui.diag_desc_lock_waits'));

          // ── 6. Index Usage
          const indexes = Array.isArray(d.indexes) ? d.indexes : [];
          const hasIdxErr = indexes[0]?.error;
          const unusedCount = !hasIdxErr ? indexes.filter(ix => ix.unused).length : 0;
          mkSection(unusedCount
              ? t('ui.diag_section_index_unused', { count: hasIdxErr ? '?' : indexes.length, unused: unusedCount })
              : t('ui.diag_section_index_usage', { count: hasIdxErr ? '?' : indexes.length }),
              hasIdxErr ? 'err' : (unusedCount > 0 ? 'warn' : 'ok'), body => {
            if (hasIdxErr) { body.textContent = indexes[0].error; return; }
            if (!indexes.length) { body.textContent = t('empty.no_indexes'); return; }
            if (unusedCount > 0)
              AdminCockpit._dbWarnBanner(body, t('ui.diag_unused_indexes_warn', { count: unusedCount }));
            body.appendChild(AdminCockpit._dbHBarChart(indexes));
          }, false, t('ui.diag_desc_index_usage'));

          // ── 7. Slow Queries
          const sq = d.slow_queries || {};
          mkSection(t('ui.diag_section_slow_queries'),
              !sq.available ? 'warn' : ((sq.queries || []).length ? 'warn' : 'ok'), body => {
            if (!sq.available) {
              const msg = document.createElement('div');
              msg.className = 'admin-db-na-msg';
              msg.textContent = sq.error
                ? `Error: ${sq.error}`
                : t('ui.diag_pg_stat_missing');
              body.appendChild(msg);
              return;
            }
            if (!(sq.queries || []).length) {
              const ok = document.createElement('div');
              ok.className = 'admin-db-ok-msg';
              ok.textContent = t('empty.no_queries_yet');
              body.appendChild(ok);
              return;
            }
            body.appendChild(AdminCockpit._dbSlowQueryBars(sq.queries));
          }, false, t('ui.diag_desc_slow_queries'));

          // ── 8. Sequences
          const seqs = Array.isArray(d.sequences) ? d.sequences : [];
          const hasSeqErr = seqs[0]?.error;
          const seqIssues = !hasSeqErr ? seqs.filter(s => s.status !== 'ok').length : 0;
          mkSection(t('ui.diag_section_sequences', { count: hasSeqErr ? '?' : seqs.length }),
              hasSeqErr ? 'err' : (seqIssues > 0 ? 'warn' : 'ok'), body => {
            if (hasSeqErr) { body.textContent = seqs[0].error; return; }
            if (!seqs.length) { body.textContent = t('empty.no_sequences'); return; }
            body.appendChild(AdminCockpit._dbProgressBars(seqs));
          }, false, t('ui.diag_desc_sequences'));
        })
        .catch(e => {
          if (e.name === 'AbortError') return;
          wrap.textContent = '';
          const err = document.createElement('div');
          err.className = 'admin-db-error';
          err.textContent = t('ui.failed_load_db_diag', { error: e.message });
          wrap.appendChild(err);
          ErrorLog.warn('admin', `DB deep dive failed: ${e.message}`);
        });
    },

    /* -----------------------------------------------------------------------
       DB visual helpers
       ----------------------------------------------------------------------- */

    _dbSummaryStrip(d, wrap) {
      const strip = document.createElement('div');
      strip.className = 'admin-db-summary';
      const mkTile = (label, num, sub, status, extra) => {
        const tile = document.createElement('div');
        tile.className = `admin-db-stat-tile ${status}`;
        const top = document.createElement('div');
        top.className = 'admin-db-stat-tile-top';
        const dot = document.createElement('span');
        dot.className = `admin-health-dot ${status}`;
        const lbl = document.createElement('span');
        lbl.className = 'admin-db-stat-tile-lbl';
        lbl.textContent = label;
        top.appendChild(dot); top.appendChild(lbl);
        tile.appendChild(top);
        const numEl = document.createElement('div');
        numEl.className = 'admin-db-stat-tile-num';
        numEl.innerHTML = num;
        tile.appendChild(numEl);
        if (extra) tile.appendChild(extra);
        if (sub) {
          const subEl = document.createElement('div');
          subEl.className = 'admin-db-stat-tile-sub';
          subEl.textContent = sub;
          tile.appendChild(subEl);
        }
        return tile;
      };
      const pool = d.pool || {};
      const poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0);
      const poolMax  = pool.pool_max || 1;
      const poolPct  = Math.round(100 * poolUsed / poolMax);
      const poolSt   = pool.error ? 'err' : (poolPct >= 85 || (pool.requests_waiting ?? 0) > 0 ? 'warn' : 'ok');
      strip.appendChild(mkTile(t('ui.diag_tile_pool'),
        `${poolUsed}<span style="font-size:14px;font-weight:400;color:var(--fg-mute)">/${poolMax}</span>`,
        t('ui.diag_tile_pct_utilized', {pct: poolPct}), poolSt,
        pool.error ? null : AdminCockpit._dbFillBar(poolUsed, poolMax, null)));
      const conn = d.connections || {};
      const activeConn = (conn.by_state || {})['active'] ?? 0;
      strip.appendChild(mkTile(t('ui.diag_tile_sessions'), String(conn.total ?? '—'), t('ui.diag_tile_active', {count: activeConn}),
        conn.error ? 'err' : ((conn.long_running || []).length > 0 ? 'warn' : 'ok'), null));
      const locks = Array.isArray(d.locks) && !d.locks[0]?.error ? d.locks : [];
      strip.appendChild(mkTile(t('ui.diag_tile_lock_waits'),
        locks.length > 0 ? `<span style="color:var(--err)">${locks.length}</span>` : '0',
        locks.length > 0 ? t('ui.diag_tile_contention') : t('ui.diag_tile_clear'),
        locks.length > 0 ? 'err' : 'ok', null));
      const tables = Array.isArray(d.tables) && !d.tables[0]?.error ? d.tables : [];
      const tblIssues = tables.filter(t => t.needs_vacuum || t.needs_analyze).length;
      strip.appendChild(mkTile(t('ui.diag_tile_table_issues'),
        tblIssues > 0 ? `<span style="color:var(--warn)">${tblIssues}</span>` : '0',
        tblIssues > 0 ? t('ui.diag_tables_need_work', {total: tables.length, issues: tblIssues}) : t('ui.diag_tables_healthy', {count: tables.length}),
        tblIssues > 0 ? 'warn' : 'ok', null));
      const sq = d.slow_queries || {};
      let sqNum = '—', sqSub = t('ui.diag_not_tracked'), sqSt = 'warn';
      if (sq.available && (sq.queries || []).length) {
        const top = sq.queries[0];
        sqNum = `${top.mean_ms}<span style="font-size:12px;font-weight:400;color:var(--fg-mute)">ms</span>`;
        sqSub = t('ui.diag_avg_calls', {calls: top.calls.toLocaleString()});
        sqSt  = top.mean_ms > 500 ? 'err' : (top.mean_ms > 100 ? 'warn' : 'ok');
      } else if (sq.available) {
        sqNum = '0'; sqSub = t('ui.diag_no_queries'); sqSt = 'ok';
      }
      strip.appendChild(mkTile(t('ui.diag_tile_slowest_query'), sqNum, sqSub, sqSt, null));
      wrap.appendChild(strip);
    },

    _dbFillBar(used, max, label) {
      const pct = max > 0 ? Math.min(100, Math.round(100 * used / max)) : 0;
      const cls = pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok');
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-fillbar';
      const track = document.createElement('div');
      track.className = 'admin-db-fillbar-track';
      const fill = document.createElement('div');
      fill.className = `admin-db-fillbar-fill ${cls}`;
      fill.style.width = `${pct}%`;
      fill.title = `${pct}%`;
      track.appendChild(fill);
      wrap.appendChild(track);
      if (label) {
        const lbl = document.createElement('span');
        lbl.className = 'admin-db-fillbar-lbl';
        lbl.textContent = `${used} / ${max} (${pct}%)`;
        wrap.appendChild(lbl);
      }
      return wrap;
    },

    _dbStackBar(byState) {
      const STATE_CLS = { 'active': 'state-active', 'idle in transaction': 'state-xit',
        'idle in transaction (aborted)': 'state-xit', 'idle': 'state-idle' };
      const total = Math.max(Object.values(byState).reduce((a, b) => a + b, 0), 1);
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-stackbar-wrap';
      const bar = document.createElement('div');
      bar.className = 'admin-db-stackbar';
      for (const [state, count] of Object.entries(byState)) {
        if (!count) continue;
        const pct = Math.max(1, Math.round(100 * count / total));
        const seg = document.createElement('div');
        seg.className = `admin-db-stackbar-seg ${STATE_CLS[state] || 'state-other'}`;
        seg.style.width = `${pct}%`;
        seg.title = `${state}: ${count}`;
        bar.appendChild(seg);
      }
      wrap.appendChild(bar);
      const legend = document.createElement('div');
      legend.className = 'admin-db-stackbar-legend';
      for (const [state, count] of Object.entries(byState)) {
        if (!count) continue;
        const chip = document.createElement('span');
        chip.className = `admin-db-stackbar-chip ${STATE_CLS[state] || 'state-other'}`;
        chip.textContent = `${state}: ${count}`;
        legend.appendChild(chip);
      }
      wrap.appendChild(legend);
      return wrap;
    },

    _dbTableCards(tables) {
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-tbl-cards';
      for (const tbl of tables) {
        const card = document.createElement('div');
        card.className = 'admin-db-tbl-card';
        const issues = [];
        if (tbl.needs_vacuum)  issues.push(t('ui.diag_vacuum'));
        if (tbl.needs_analyze) issues.push(t('ui.diag_analyze'));
        if (issues.length) card.classList.add('has-issues');
        const row1 = document.createElement('div');
        row1.className = 'admin-db-tbl-card-row1';
        const name = document.createElement('span');
        name.className = 'admin-db-tbl-card-name';
        name.textContent = tbl.table;
        const size = document.createElement('span');
        size.className = 'admin-db-tbl-card-size';
        size.textContent = tbl.total_size || '';
        const badge = document.createElement('span');
        badge.className = `admin-db-tbl-card-badge ${issues.length ? 'warn' : 'ok'}`;
        badge.textContent = issues.length ? issues.join(' + ') + ' ' + t('ui.diag_needed') : t('ui.diag_healthy');
        row1.appendChild(name); row1.appendChild(size); row1.appendChild(badge);
        card.appendChild(row1);
        const total = Math.max((tbl.live_rows ?? 0) + (tbl.dead_rows ?? 0), 1);
        const deadPct = Math.min(100, Math.round(100 * (tbl.dead_rows ?? 0) / total));
        const barWrap = document.createElement('div');
        barWrap.className = 'admin-db-tbl-card-barwrap';
        const barLive = document.createElement('div');
        barLive.className = 'admin-db-tbl-card-live';
        barLive.style.width = `${100 - deadPct}%`;
        barLive.title = `${t('ui.diag_table_live')}: ${(tbl.live_rows ?? 0).toLocaleString()}`;
        const barDead = document.createElement('div');
        barDead.className = 'admin-db-tbl-card-dead';
        barDead.style.width = `${deadPct}%`;
        barDead.title = `${t('ui.diag_table_dead')}: ${(tbl.dead_rows ?? 0).toLocaleString()} (${tbl.dead_pct}%)`;
        barWrap.appendChild(barLive); barWrap.appendChild(barDead);
        card.appendChild(barWrap);
        const row2 = document.createElement('div');
        row2.className = 'admin-db-tbl-card-row2';
        const vacAt = tbl.last_autovacuum || tbl.last_vacuum;
        row2.textContent = t('ui.diag_table_row2', {
          live: (tbl.live_rows ?? 0).toLocaleString(),
          dead: (tbl.dead_rows ?? 0).toLocaleString(),
          deadPct: tbl.dead_pct,
          vacAt: vacAt ? AdminCockpit._relTime(new Date(vacAt)) : t('ui.diag_vacuum_never'),
        });
        card.appendChild(row2);

        const actions = document.createElement('div');
        actions.className = 'db-maint-actions';
        const urgentVA = tbl.needs_vacuum || tbl.needs_analyze;
        const urgentA  = tbl.needs_analyze;
        const vaBtn = document.createElement('button');
        vaBtn.className = `db-maint-btn${urgentVA ? ' db-maint-btn--urgent' : ''}`;
        vaBtn.dataset.maintAction = 'vacuum-analyze';
        vaBtn.dataset.maintTable = tbl.table;
        vaBtn.textContent = 'VACUUM ANALYZE';
        const aBtn = document.createElement('button');
        aBtn.className = `db-maint-btn${urgentA ? ' db-maint-btn--urgent' : ''}`;
        aBtn.dataset.maintAction = 'analyze';
        aBtn.dataset.maintTable = tbl.table;
        aBtn.textContent = 'ANALYZE';
        actions.appendChild(vaBtn);
        actions.appendChild(aBtn);
        card.appendChild(actions);

        wrap.appendChild(card);
      }
      return wrap;
    },

    _dbHBarChart(indexes) {
      const maxScans = Math.max(...indexes.map(ix => ix.scans ?? 0), 1);
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-hbar-chart';
      for (const ix of indexes) {
        const pct = Math.max(ix.unused ? 0 : 1, Math.round(100 * (ix.scans ?? 0) / maxScans));
        const row = document.createElement('div');
        row.className = 'admin-db-hbar-row';
        const names = document.createElement('div');
        names.className = 'admin-db-hbar-names';
        const tblN = document.createElement('span');
        tblN.className = 'admin-db-hbar-tbl';
        tblN.textContent = ix.table || '';
        const idxN = document.createElement('span');
        idxN.className = `admin-db-hbar-idx${ix.unused ? ' unused' : ''}`;
        idxN.textContent = ix.index || '';
        names.appendChild(tblN); names.appendChild(idxN);
        const track = document.createElement('div');
        track.className = 'admin-db-hbar-track';
        const fill = document.createElement('div');
        fill.className = `admin-db-hbar-fill${ix.unused ? ' unused' : ''}`;
        fill.style.width = `${pct}%`;
        track.appendChild(fill);
        const val = document.createElement('span');
        val.className = 'admin-db-hbar-val';
        val.textContent = (ix.scans ?? 0).toLocaleString();
        const sizeChip = document.createElement('span');
        sizeChip.className = 'admin-db-hbar-size';
        sizeChip.textContent = ix.index_size || '';
        row.appendChild(names); row.appendChild(track); row.appendChild(val); row.appendChild(sizeChip);
        wrap.appendChild(row);
      }
      return wrap;
    },

    _dbSlowQueryBars(queries) {
      const maxMs = Math.max(...queries.map(q => q.mean_ms ?? 0), 1);
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-hbar-chart';
      for (const q of queries) {
        const pct = Math.max(1, Math.round(100 * (q.mean_ms ?? 0) / maxMs));
        const cls = (q.mean_ms ?? 0) > 500 ? 'err' : ((q.mean_ms ?? 0) > 100 ? 'warn' : '');
        const row = document.createElement('div');
        row.className = 'admin-db-hbar-row';
        const names = document.createElement('div');
        names.className = 'admin-db-hbar-names';
        const qText = document.createElement('span');
        qText.className = 'admin-db-hbar-idx';
        qText.textContent = (q.query || '').slice(0, 90);
        qText.title = q.query || '';
        names.appendChild(qText);
        const track = document.createElement('div');
        track.className = 'admin-db-hbar-track';
        const fill = document.createElement('div');
        fill.className = `admin-db-hbar-fill${cls ? ' ' + cls : ''}`;
        fill.style.width = `${pct}%`;
        track.appendChild(fill);
        const val = document.createElement('span');
        val.className = 'admin-db-hbar-val';
        val.textContent = `${q.mean_ms}ms`;
        if (cls) val.style.color = `var(--${cls})`;
        const callChip = document.createElement('span');
        callChip.className = 'admin-db-hbar-size';
        callChip.textContent = `${q.calls.toLocaleString()} calls`;
        row.appendChild(names); row.appendChild(track); row.appendChild(val); row.appendChild(callChip);
        wrap.appendChild(row);
      }
      return wrap;
    },

    _dbProgressBars(seqs) {
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-progress-list';
      for (const s of seqs) {
        const row = document.createElement('div');
        row.className = 'admin-db-progress-row';
        const name = document.createElement('span');
        name.className = 'admin-db-progress-name';
        name.textContent = `${s.schema}.${s.name}`;
        const track = document.createElement('div');
        track.className = 'admin-db-fillbar-track';
        const fill = document.createElement('div');
        fill.className = `admin-db-fillbar-fill ${s.status || 'ok'}`;
        fill.style.width = `${Math.max(0.5, s.used_pct ?? 0)}%`;
        fill.title = `${s.used_pct}%`;
        track.appendChild(fill);
        const lbl = document.createElement('span');
        lbl.className = 'admin-db-fillbar-lbl';
        lbl.textContent = `${s.used_pct}%${s.cycles ? ' ↻' : ''}  (${(s.last_value ?? 0).toLocaleString()} / ${(s.max_value ?? 0).toLocaleString()})`;
        row.appendChild(name); row.appendChild(track); row.appendChild(lbl);
        wrap.appendChild(row);
      }
      return wrap;
    },

    _dbLockChain(locks) {
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-lock-chains';
      for (const lk of locks) {
        const chain = document.createElement('div');
        chain.className = 'admin-db-lock-chain';
        const mkNode = (pid, role, query, cls) => {
          const node = document.createElement('div');
          node.className = `admin-db-lock-node ${cls}`;
          node.innerHTML = `<span class="admin-db-lock-pid">PID ${pid}</span>`
            + `<span class="admin-db-lock-role">${role}</span>`
            + `<div class="admin-db-lock-query">${(query || '—').slice(0, 90)}</div>`;
          return node;
        };
        chain.appendChild(mkNode(lk.blocking_pid, 'BLOCKING', lk.blocking_query, 'blocking'));
        const arrow = document.createElement('div');
        arrow.className = 'admin-db-lock-arrow';
        arrow.innerHTML = `<span class="admin-db-lock-type">${lk.lock_type || ''}</span> ▼`;
        chain.appendChild(arrow);
        chain.appendChild(mkNode(lk.blocked_pid, `BLOCKED ${lk.blocked_for_s}s`, lk.blocked_query, 'blocked'));
        wrap.appendChild(chain);
      }
      return wrap;
    },

    _dbWarnBanner(parent, text, isError) {
      const d = document.createElement('div');
      d.className = `admin-db-banner ${isError ? 'admin-db-banner-err' : 'admin-db-banner-warn'}`;
      d.textContent = text;
      parent.appendChild(d);
    },

    _dbTable(headers, rowDefs) {
      const tbl = document.createElement('table');
      tbl.className = 'admin-db-tbl';
      const thead = tbl.createTHead();
      const hrow = thead.insertRow();
      headers.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        hrow.appendChild(th);
      });
      const tbody = tbl.createTBody();
      for (const { cells, rowWarn, rowErr, cellWarn } of rowDefs) {
        const tr = tbody.insertRow();
        if (rowErr)  tr.style.background = 'rgba(192,57,43,0.07)';
        else if (rowWarn) tr.style.background = 'rgba(243,156,18,0.06)';
        cells.forEach((c, i) => {
          const td = tr.insertCell();
          td.textContent = (c === null || c === undefined) ? '—' : c;
          if (cellWarn.includes(i)) td.style.color = 'var(--warn)';
        });
      }
      return tbl;
    },

    /* -----------------------------------------------------------------------
       BACKEND EVENT LOG — fetches /logs/backend, renders like the front-end log
       ----------------------------------------------------------------------- */
    _renderBackendLog() {
      const host = document.getElementById('admin-backend-log-list');
      const countEl = document.getElementById('admin-backend-log-count');
      if (!host) return;
      host.innerHTML = `<div class="admin-log-empty">${t('ui.loading')}</div>`;

      AdminCockpit._backendLogAbort?.abort();
      AdminCockpit._backendLogAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._backendLogAbort.signal, AbortSignal.timeout(8000)])
        : AdminCockpit._backendLogAbort.signal;

      const bf = AdminCockpit._backendLogFilter || {};
      // Lazily inject a free-text query input beside the level select (markup is in
      // index.html which we don't own). Drives the server-side ?q= filter.
      const lvlSel = document.getElementById('admin-backend-log-filter-level');
      if (lvlSel && lvlSel.parentElement && !document.getElementById('admin-backend-log-q')) {
        const qIn = document.createElement('input');
        qIn.id = 'admin-backend-log-q';
        qIn.type = 'search';
        qIn.className = 'input';
        qIn.placeholder = 'Filter backend (msg / code / category)';
        qIn.title = 'Server-side free-text filter';
        qIn.addEventListener('input', Util.debounce(ev => {
          AdminCockpit._backendLogFilter.q = ev.target.value.trim();
          AdminCockpit._renderBackendLog();
        }, 350));
        lvlSel.insertAdjacentElement('afterend', qIn);
      }
      const lvl = bf.level || 'all';
      const qp = [`limit=200`];
      if (lvl !== 'all')                  qp.push('level='    + encodeURIComponent(lvl));
      if (bf.category && bf.category !== 'all') qp.push('category=' + encodeURIComponent(bf.category));
      if (bf.since)                       qp.push('since='    + encodeURIComponent(bf.since));
      if (bf.q)                           qp.push('q='        + encodeURIComponent(bf.q));
      const params = `?${qp.join('&')}`;
      const reqIdFilter = bf.reqId || '';

      // Reqid-correlation chip on the backend pane.
      AdminCockpit._renderReqIdChip('admin-backend-log-list', reqIdFilter, () => {
        AdminCockpit._backendLogFilter.reqId = '';
        AdminCockpit._renderBackendLog();
      });

      Util.fetchTraced(`${Config.API_BASE}/logs/backend${params}`, { signal: sig })
        .then(r => r.json())
        .then(({ entries: rawEntries, total, dropped }) => {
          host.textContent = '';
          // Client-side reqId correlation filter (server filters category/since/q/level).
          let entries = rawEntries || [];
          if (reqIdFilter) entries = entries.filter(e => e.rid === reqIdFilter || e.reqId === reqIdFilter);
          if (countEl) countEl.textContent = t('ui.backend_log_count', { total, shown: entries.length });

          // Overflow marker if the backend reports a dropped count.
          if (dropped > 0) {
            const ov = document.createElement('div');
            ov.className = 'admin-log-older';
            ov.textContent = `${dropped} older backend entr${dropped === 1 ? 'y' : 'ies'} dropped`;
            host.appendChild(ov);
          }

          if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'admin-log-empty';
            empty.textContent = lvl !== 'all' ? t('ui.diag_no_level_events', {level: lvl}) : t('empty.no_backend_events');
            host.appendChild(empty);
            return;
          }

          for (const e of entries) {
            const row = document.createElement('div');
            row.className = `admin-log-row admin-log-${e.level || 'info'}`;

            const head = document.createElement('div');
            head.className = 'admin-log-head';

            const lvlEl = document.createElement('span');
            lvlEl.className = 'admin-log-lvl';
            lvlEl.textContent = (e.level || 'info').toUpperCase();

            const tsEl = document.createElement('span');
            tsEl.className = 'admin-log-ts';
            const d = e.ts ? new Date(e.ts) : null;
            tsEl.textContent = d ? AdminCockpit._relTime(d) : '';
            tsEl.title = e.ts || '';

            const scopeEl = document.createElement('span');
            scopeEl.className = 'admin-log-scope';
            scopeEl.textContent = e.category || '';

            head.appendChild(lvlEl);
            head.appendChild(tsEl);
            head.appendChild(scopeEl);
            if (e.source === 'frontend') {
              const src = document.createElement('span');
              src.className = 'admin-log-src';
              src.textContent = 'FE';
              src.title = 'Forwarded from a frontend client';
              head.appendChild(src);
            }
            const code = e.error_code || e.errorCode;
            if (code) {
              const codeEl = document.createElement('span');
              codeEl.className = 'admin-log-code';
              codeEl.textContent = code;
              codeEl.title = 'Filter by this error code';
              codeEl.addEventListener('click', ev => {
                ev.stopPropagation();
                AdminCockpit._backendLogFilter.q = code;
                AdminCockpit._renderBackendLog();
              });
              head.appendChild(codeEl);
            }
            const rid = e.rid || e.reqId;
            if (rid) {
              const ridEl = document.createElement('span');
              ridEl.className = 'admin-log-reqid';
              ridEl.textContent = `req ${String(rid).slice(0, 8)}`;
              ridEl.title = `Correlate request ${rid} across the frontend log`;
              ridEl.addEventListener('click', ev => {
                ev.stopPropagation();
                AdminCockpit._correlateReqId(rid);
              });
              head.appendChild(ridEl);
            }
            row.appendChild(head);

            const msg = document.createElement('div');
            msg.className = 'admin-log-msg';
            msg.textContent = e.msg || '';
            row.appendChild(msg);

            if (e.ctx && Object.keys(e.ctx).length) {
              const pre = document.createElement('pre');
              pre.className = 'admin-log-ctx';
              pre.textContent = JSON.stringify(e.ctx, null, 2);
              row.appendChild(pre);
              row.style.cursor = 'pointer';
              row.addEventListener('click', () => row.classList.toggle('expanded'));
            }

            host.appendChild(row);
          }
        })
        .catch(e => {
          host.textContent = '';
          const err = document.createElement('div');
          err.className = 'admin-log-empty';
          err.textContent = t('ui.failed_load_backend_log', { error: e.message });
          host.appendChild(err);
        });
    },

    _clearBackendLog() {
      Util.fetchTraced(`${Config.API_BASE}/logs/backend/clear`, { method: 'POST' })
        .then(() => AdminCockpit._renderBackendLog())
        .catch(() => {});
    },

    _copyFiltered() {
      const entries = AdminCockpit._getFilteredEntries();
      const txt = entries.map(e =>
        `${e.ts} [${e.level.toUpperCase()}] ${e.scope}: ${e.msg}${e.ctx ? ' :: ' + JSON.stringify(e.ctx) : ''}`
      ).join('\n');
      navigator.clipboard?.writeText(txt).then(
        () => Toast.show(t('toast.copied_filtered', { count: entries.length }), 'success'),
        () => Toast.show(t('toast.copy_failed'), 'error')
      );
    },

    _renderLogs() {
      const list = document.getElementById('admin-log-list');
      if (!list) return;

      // Rebuild scope filter options
      const allEntries = ErrorLog.entries();
      const scopeEl = document.getElementById('admin-log-filter-scope');
      if (scopeEl) {
        const currentScope = AdminCockpit._logFilter.scope;
        const scopes = [...new Set(allEntries.map(e => e.scope).filter(Boolean))].sort();
        scopeEl.textContent = '';
        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.textContent = t('ui.all_scopes');
        scopeEl.appendChild(allOpt);
        for (const s of scopes) {
          const opt = document.createElement('option');
          opt.value = s;
          opt.textContent = s;
          if (s === currentScope) opt.selected = true;
          scopeEl.appendChild(opt);
        }
        // Lazily inject an errorCode filter select beside the scope select (the
        // markup lives in index.html which we don't own — build it on demand).
        let codeEl = document.getElementById('admin-log-filter-code');
        if (!codeEl && scopeEl.parentElement) {
          codeEl = document.createElement('select');
          codeEl.id = 'admin-log-filter-code';
          codeEl.className = scopeEl.className || '';
          codeEl.title = 'Filter by error code';
          codeEl.addEventListener('change', ev => {
            AdminCockpit._logFilter.errorCode = ev.target.value;
            AdminCockpit._renderLogs();
          });
          scopeEl.insertAdjacentElement('afterend', codeEl);
        }
        if (codeEl) {
          const curCode = AdminCockpit._logFilter.errorCode;
          const codes = [...new Set(allEntries.map(e => e.errorCode).filter(Boolean))].sort();
          codeEl.textContent = '';
          const cAll = document.createElement('option');
          cAll.value = 'all'; cAll.textContent = 'All codes';
          codeEl.appendChild(cAll);
          for (const c of codes) {
            const opt = document.createElement('option');
            opt.value = c; opt.textContent = c;
            if (c === curCode) opt.selected = true;
            codeEl.appendChild(opt);
          }
        }
      }

      // Active reqId-correlation chip (set by clicking a reqId in either pane).
      AdminCockpit._renderReqIdChip('admin-log-list', AdminCockpit._logFilter.reqId, () => {
        AdminCockpit._logFilter.reqId = '';
        AdminCockpit._renderLogs();
      });

      const filtered = AdminCockpit._getFilteredEntries();
      const visible = filtered.slice().reverse();

      list.textContent = '';

      // Overflow marker — N entries evicted past MAX since last clear.
      const dropped = ErrorLog.droppedCount();
      if (dropped > 0) {
        const ov = document.createElement('div');
        ov.className = 'admin-log-older';
        ov.textContent = `${dropped} older entr${dropped === 1 ? 'y' : 'ies'} dropped (ring at ${ErrorLog.MAX})`;
        list.appendChild(ov);
      }

      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'admin-log-empty';
        empty.textContent = filtered.length === 0 && allEntries.length > 0
          ? t('empty.no_entries_filter')
          : t('empty.no_log_entries');
        list.appendChild(empty);
      }

      const SCOPE_COLORS = {
        persistence: 'var(--info,#3498db)',
        engine:      '#9b59b6',
        admin:       'var(--accent,#b8791a)',
        alerts:      'var(--err,#c0392b)',
        store:       '#16a085',
        calendar:    '#2ecc71',
        interaction: '#e67e22',
      };

      for (const e of visible) {
        const row = document.createElement('div');
        row.className = `admin-log-row admin-log-${e.level}`;
        row.style.cursor = e.ctx != null ? 'pointer' : '';

        const head = document.createElement('div');
        head.className = 'admin-log-head';

        const lvl = document.createElement('span');
        lvl.className = 'admin-log-lvl';
        lvl.textContent = e.level;

        const ts = document.createElement('span');
        ts.className = 'admin-log-ts';
        const d = e.ts ? new Date(e.ts) : null;
        ts.textContent = d ? AdminCockpit._relTime(d) : '';
        ts.title = e.ts || '';

        const scope = document.createElement('span');
        scope.className = 'admin-log-scope';
        scope.textContent = e.scope || '';
        if (SCOPE_COLORS[e.scope]) scope.style.color = SCOPE_COLORS[e.scope];

        head.appendChild(lvl);
        head.appendChild(ts);
        head.appendChild(scope);
        if (e.errorCode) {
          const code = document.createElement('span');
          code.className = 'admin-log-code';
          code.textContent = e.errorCode;
          code.title = 'Filter by this error code';
          code.addEventListener('click', ev => {
            ev.stopPropagation();
            AdminCockpit._logFilter.errorCode = e.errorCode;
            AdminCockpit._renderLogs();
          });
          head.appendChild(code);
        }
        if (e.reqId) {
          const rid = document.createElement('span');
          rid.className = 'admin-log-reqid';
          rid.textContent = `req ${String(e.reqId).slice(0, 8)}`;
          rid.title = `Correlate request ${e.reqId} across the backend log`;
          rid.addEventListener('click', ev => {
            ev.stopPropagation();
            AdminCockpit._correlateReqId(e.reqId);
          });
          head.appendChild(rid);
        }
        row.appendChild(head);

        const msg = document.createElement('div');
        msg.className = 'admin-log-msg';
        msg.textContent = e.msg || '';
        row.appendChild(msg);

        if (e.ctx != null) {
          const pre = document.createElement('pre');
          pre.className = 'admin-log-ctx';
          pre.textContent = typeof e.ctx === 'string' ? e.ctx : JSON.stringify(e.ctx, null, 2);
          row.appendChild(pre);
          row.addEventListener('click', () => row.classList.toggle('expanded'));
        }

        list.appendChild(row);
      }

      const counts = document.getElementById('admin-log-counts');
      if (counts) {
        const errs  = ErrorLog.countBy('error');
        const warns = ErrorLog.countBy('warn');
        const show  = filtered.length !== allEntries.length ? t('ui.log_shown', { count: filtered.length }) : '';
        counts.textContent = t('ui.log_count_summary', {
          total: allEntries.length,
          errs, errp: errs === 1 ? '' : 's',
          warns, warnp: warns === 1 ? '' : 's',
          shown: show,
        });
      }
    },

    _relTime(d) {
      const diffMs = Date.now() - (d instanceof Date ? d : new Date(d)).getTime();
      const s = Math.round(diffMs / 1000);
      if (s < 60)    return t('ui.time_s_ago', { n: s });
      if (s < 3600)  return t('ui.time_m_ago', { n: Math.floor(s / 60) });
      if (s < 86400) return t('ui.time_h_ago', { n: Math.floor(s / 3600) });
      return t('ui.time_d_ago', { n: Math.floor(s / 86400) });
    },

    async _clearAudit() {
      const ok = await Modal.confirm({ title: t('modal.delete_upload_history'), confirmLabel: t('btn.yes_delete_all') });
      if (!ok) return;
      fetch(`${Config.API_BASE}/upload/audit/clear`, { method: 'POST' })
        .then(r => r.json())
        .then(body => {
          if (body.status !== 'ok') { Toast.show(t('toast.clear_history_failed'), 'error'); return; }
          Toast.show(t('toast.history_cleared', { count: body.deleted }), 'success');
          AdminCockpit._renderAudit();
        })
        .catch(e => Toast.show(t('toast.clear_history_failed') + ': ' + e.message, 'error'));
    },

    _renderAudit() {
      const host = document.getElementById('admin-audit-list');
      if (!host) return;
      host.textContent = t('ui.loading');
      AdminCockpit._auditAbort?.abort();
      AdminCockpit._auditAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._auditAbort.signal, AbortSignal.timeout(8000)])
        : AdminCockpit._auditAbort.signal;
      Util.fetchTraced(`${Config.API_BASE}/upload/audit`, { signal: sig })
        .then(r => r.json())
        .then(body => {
          host.textContent = '';
          const items = body?.audit || [];
          if (items.length === 0) {
            const e = document.createElement('div');
            e.className = 'admin-log-empty';
            e.textContent = t('empty.no_uploads');
            host.appendChild(e);
            return;
          }
          const tbl = document.createElement('table');
          tbl.className = 'admin-audit-tbl';
          const thead = document.createElement('thead');
          const htr = document.createElement('tr');
          for (const h of [t('ui.audit_col_when'), t('ui.audit_col_file'), t('ui.audit_col_rows'), t('ui.audit_col_inserted'), t('ui.audit_col_updated'), t('ui.audit_col_batch'), t('ui.audit_col_warnings')]) {
            const th = document.createElement('th');
            th.textContent = h;
            htr.appendChild(th);
          }
          thead.appendChild(htr);
          tbl.appendChild(thead);

          const tb = document.createElement('tbody');
          for (const it of items) {
            const hasWarnings = it.warnings && it.warnings.length > 0;

            const tr = document.createElement('tr');
            if (hasWarnings) tr.classList.add('admin-audit-has-warn');
            tr.style.cursor = hasWarnings ? 'pointer' : '';

            const batchShort = it.batch_id ? it.batch_id.slice(0, 8) + '…' : '—';
            const cells = [
              (it.uploaded_at || '').replace('T', ' ').slice(0, 19),
              it.filename || '—',
              String(it.row_count ?? '—'),
              String(it.inserted ?? '—'),
              String(it.updated ?? '—'),
              batchShort,
              hasWarnings ? `⚠ ${it.warnings.length}` : '✓',
            ];
            cells.forEach((c, i) => {
              const td = document.createElement('td');
              td.textContent = c;
              if (i === 6 && hasWarnings) td.style.color = 'var(--warn,#b57a0a)';
              if (i === 5 && it.batch_id) td.title = it.batch_id;
              tr.appendChild(td);
            });

            if (hasWarnings) {
              const warnRow = document.createElement('tr');
              warnRow.className = 'admin-audit-warn-detail';
              warnRow.style.display = 'none';
              const td = document.createElement('td');
              td.colSpan = 7;
              td.style.padding = '0';
              td.appendChild(AdminCockpit._warningList(it.warnings));
              warnRow.appendChild(td);
              tb.appendChild(tr);
              tb.appendChild(warnRow);
              tr.addEventListener('click', () => {
                warnRow.style.display = warnRow.style.display === 'none' ? '' : 'none';
              });
            } else {
              tb.appendChild(tr);
            }
          }
          tbl.appendChild(tb);
          host.appendChild(tbl);
        })
        .catch(e => {
          if (e?.name === 'AbortError') return;
          host.textContent = '';
          const err = document.createElement('div');
          err.className = 'admin-status error';
          err.textContent = t('ui.failed_load_upload_history', { error: e.message });
          host.appendChild(err);
        });
    },

    async _clearAuditLog() {
      const ok = await Modal.confirm({ title: t('modal.clear_audit_log'), confirmLabel: t('btn.yes_delete') });
      if (!ok) return;
      fetch(`${Config.API_BASE}/audit/log/clear`, { method: 'POST' })
        .then(r => r.json())
        .then(body => {
          if (body.status !== 'ok') { Toast.show(t('toast.clear_failed'), 'error'); return; }
          Toast.show(t('toast.audit_log_cleared'), 'success');
          AdminCockpit._renderAuditLog();
        })
        .catch(e => Toast.show(t('toast.clear_failed') + ': ' + e.message, 'error'));
    },

    _renderAuditLog() {
      const host = document.getElementById('admin-audit-log-list');
      if (!host) return;
      host.textContent = t('ui.loading');
      AdminCockpit._auditLogAbort?.abort();
      AdminCockpit._auditLogAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._auditLogAbort.signal, AbortSignal.timeout(8000)])
        : AdminCockpit._auditLogAbort.signal;
      Util.fetchTraced(`${Config.API_BASE}/audit/log?limit=200`, { signal: sig })
        .then(r => r.json())
        .then(body => {
          host.textContent = '';
          const items = body?.entries || [];
          if (!items.length) {
            const e = document.createElement('div');
            e.className = 'admin-log-empty';
            e.textContent = t('empty.no_audit_events');
            host.appendChild(e);
            return;
          }
          const tbl = document.createElement('table');
          tbl.className = 'admin-audit-tbl';
          const thead = document.createElement('thead');
          const htr   = document.createElement('tr');
          for (const h of [t('ui.audit_log_col_when'), t('ui.audit_log_col_user'), t('ui.audit_log_col_action'), t('ui.audit_log_col_plant'), t('ui.audit_log_col_details')]) {
            const th = document.createElement('th');
            th.textContent = h;
            htr.appendChild(th);
          }
          thead.appendChild(htr);
          tbl.appendChild(thead);

          const ACTION_ICONS = {
            color_wheel_upload:  '⬆',
            color_wheel_replace: '↻',
            color_wheel_delete:  '⌫',
            optimization_run:    '📈',
          };
          const ACTION_COLORS = {
            color_wheel_upload:  'var(--ok,#2f7a4d)',
            color_wheel_replace: 'var(--info,#2d5f8c)',
            color_wheel_delete:  'var(--err,#c0392b)',
            optimization_run:    'var(--accent,#b8791a)',
          };

          const tb = document.createElement('tbody');
          for (const it of items) {
            const tr = document.createElement('tr');
            const action = it.action || '—';
            const icon   = ACTION_ICONS[action] || '•';
            const color  = ACTION_COLORS[action] || 'inherit';
            const details = it.details
              ? Object.entries(it.details).map(([k, v]) => `${k}: ${v}`).join(' · ')
              : '—';
            const cells = [
              (it.ts || '').replace('T', ' ').slice(0, 19),
              it.user || '—',
              '',
              it.plant || '—',
              details,
            ];
            cells.forEach((c, i) => {
              const td = document.createElement('td');
              if (i === 2) {
                // `action` is server-stored and not whitelisted, so render it as inert
                // text — never innerHTML — to avoid a stored-XSS sink (R1). icon is from
                // the fixed ACTION_ICONS map; color is a CSS var, set via style only.
                const span = document.createElement('span');
                span.style.color = color;
                span.style.fontWeight = '600';
                span.textContent = `${icon} ${action}`;
                td.appendChild(span);
              } else {
                td.textContent = c;
              }
              if (i === 3 && it.plant) td.style.fontWeight = '600';
              tr.appendChild(td);
            });
            tb.appendChild(tr);
          }
          tbl.appendChild(tb);
          host.appendChild(tbl);
        })
        .catch(e => {
          if (e?.name === 'AbortError') return;
          host.textContent = '';
          const err = document.createElement('div');
          err.className = 'admin-status error';
          err.textContent = t('ui.failed_load_audit_log', { error: e.message });
          host.appendChild(err);
        });
    },

    /* ---------------------------------------------------------------------
       THREAD PROFILER PANEL — PerfMonitor ring-buffer stats table.
       Rendered into #admin-ov-thread on tab activation and on each
       PerfMonitor notification (debounced 250 ms by PerfMonitor itself).
       --------------------------------------------------------------------- */
    _refreshThreadPane() {
      const tbody = document.getElementById('admin-perf-tbody');
      if (!tbody) return;
      const rows = PerfMonitor.all();
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="admin-perf-empty">No data yet — interact with the app to record operations.</td></tr>`;
        return;
      }
      rows.sort((a, b) => b.last - a.last);
      const fmt = ms => ms < 1 ? `${ms.toFixed(2)}` : ms < 100 ? `${ms.toFixed(1)}` : `${Math.round(ms)}`;
      const cls = ms => ms >= 50 ? 'perf-hot' : ms >= 16 ? 'perf-warn' : 'perf-ok';
      const ago = ts => {
        if (!ts) return '—';
        const s = Math.round((Date.now() - ts) / 1000);
        if (s < 2)  return 'just now';
        if (s < 60) return `${s}s ago`;
        return `${Math.round(s / 60)}m ago`;
      };
      tbody.innerHTML = rows.map(r => {
        const c = cls(r.last);
        return `<tr>
          <td class="perf-name">${r.name}</td>
          <td class="${c}">${fmt(r.last)} ms</td>
          <td class="${cls(r.p50)}">${fmt(r.p50)} ms</td>
          <td class="${cls(r.p95)}">${fmt(r.p95)} ms</td>
          <td class="${cls(r.max)}">${fmt(r.max)} ms</td>
          <td>${r.count}</td>
          <td class="perf-ago">${ago(r.lastTs)}</td>
        </tr>`;
      }).join('');
    },

    /* ---------------------------------------------------------------------
       DIAGNOSTICS PANEL — client-side health summary, "Reset client state",
       diagnostics bundle export. Renders into #admin-diagnostics-pane.
       --------------------------------------------------------------------- */
    _renderDiagnostics() {
      const host = document.getElementById('admin-diagnostics-pane');
      if (!host) return;

      const inv  = Persistence.storageInventory();
      const totK = (inv.totalBytes / 1024).toFixed(1);
      const lastK = (inv.lastBytes / 1024).toFixed(1);
      const lastWhen = inv.lastSavedAt ? new Date(inv.lastSavedAt).toLocaleTimeString() : '—';
      const errCount  = ErrorLog.countBy('error');
      const warnCount = ErrorLog.countBy('warn');
      const errRate   = ErrorLog.errorRatePerMin();
      const warnRate  = ErrorLog.warnRatePerMin();
      const heap = (performance && performance.memory)
        ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} / ${(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0)} MB`
        : 'n/a';
      const stats = (Persistence.stats && Persistence.stats()) || {};

      const autosaveTxt = inv.autosaveDisabled
        ? `<span class="admin-bad">${t('ui.ls_quota_disabled')}</span>`
        : inv.degraded
          ? `<span class="admin-warn">${t('ui.ls_degraded')}</span>`
          : `<span class="admin-good">${t('ui.ls_healthy')}</span>`;
      const errTxt = errRate > 10
        ? `<span class="admin-bad">${t('ui.diag_err_rate_spike', { count: errCount, rate: errRate })}</span>`
        : errRate > 0
          ? `<span class="admin-warn">${t('ui.diag_err_rate_warn', { count: errCount, rate: errRate })}</span>`
          : `${errCount}`;

      host.innerHTML = `
        <div class="admin-card">
          <div class="admin-card-hd">
            <h3>${t('ui.diag_client_title')}<span class="adm-help" tabindex="0" aria-label="Help"><span class="adm-help-dot">?</span><span class="adm-help-tip">${t('ui.diag_client_help')}</span></span></h3>
            <div class="admin-card-actions">
              <button class="btn btn-ghost sm" id="admin-diag-refresh" title="${t('tip.refresh')}">${t('btn.refresh')}</button>
              <button class="btn btn-ghost sm" id="admin-diag-storage" title="${t('tip.inspect_storage')}">${t('btn.inspect_storage')}</button>
              <button class="btn btn-ghost sm" id="admin-diag-export" title="${t('tip.diag_export_bundle')}">${t('btn.export_bundle')}</button>
              <button class="btn btn-warn  sm" id="admin-diag-reset"   title="${t('tip.diag_clear_cache')}">${t('btn.reset_client')}</button>
            </div>
          </div>
          <div class="admin-kv">
            <span>${t('ui.diag_kv_build')}</span><span>${Config.BUILD_ID}</span>
            <span>${t('ui.diag_kv_schema')}</span><span>${Config.SCHEMA_VERSION}</span>
            <span>${t('ui.diag_kv_cache')}</span><span>${t('ui.diag_cache_val', { size: lastK, when: lastWhen })}</span>
            <span>${t('ui.diag_kv_storage')}</span><span>${t('ui.diag_storage_val', { size: totK, count: inv.count })}</span>
            <span>${t('ui.diag_kv_autosave')}</span><span>${autosaveTxt}</span>
            <span>${t('ui.diag_kv_heap')}</span><span>${heap}</span>
            <span>${t('ui.diag_kv_errors')}</span><span>${errTxt}</span>
            <span>${t('ui.diag_kv_warnings')}</span><span>${warnCount} (${warnRate}/min)</span>
            <span>${t('ui.diag_kv_tasks')}</span><span>${Store.tasksArr.length}</span>
            <span>${t('ui.diag_kv_source')}</span><span>${stats.source || '—'}</span>
            <span>${t('ui.diag_kv_plant')}</span><span>${Store.selectedPlant || '<em>none</em>'}</span>
          </div>
        </div>`;

      document.getElementById('admin-diag-refresh').onclick = () => AdminCockpit._renderDiagnostics();
      document.getElementById('admin-diag-storage').onclick = () => AdminCockpit._showStorageInventory(inv);
      document.getElementById('admin-diag-export' ).onclick = () => AdminCockpit._exportDiagnostics();
      document.getElementById('admin-diag-reset'  ).onclick = () => AdminCockpit._resetClientState();
    },

    async _resetClientState() {
      const ok = await Modal.confirm({
        title:        t('modal.reset_client_title'),
        message:      t('modal.reset_client_msg'),
        detail:       t('modal.reset_client_detail'),
        confirmLabel: t('modal.reset_client_confirm'),
        tone:         'warn',
      });
      if (!ok) return;
      try { localStorage.removeItem(Config.LS_KEY); } catch {}
      try { sessionStorage.clear(); } catch {}
      try {
        const prefix = `${Config.LS_KEY}.quarantine.`;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) toRemove.push(k);
        }
        toRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
      } catch {}
      ErrorLog.info('admin', 'Client state reset by user — reloading');
      // Give the log a frame to render in case of debounce, then hard-reload bypassing HTTP cache.
      setTimeout(() => location.reload(), 50);
    },

    _showStorageInventory(inv) {
      if (!inv) inv = Persistence.storageInventory();
      const top = inv.items.slice(0, 12)
        .map(i => `${(i.bytes / 1024).toFixed(1).padStart(7)} KB  ${i.key}`)
        .join('\n') || t('ui.ls_empty');
      const lsStatus = inv.degraded ? t('ui.ls_evicted_tier') : inv.autosaveDisabled ? t('ui.ls_autosave_disabled') : t('ui.ls_healthy');
      const detail =
        `<pre style="margin:0;font:11px ui-monospace,monospace;white-space:pre;">` +
        t('modal.ls_inv_total', { size: (inv.totalBytes / 1024).toFixed(1), count: inv.count }) + '\n' +
        t('modal.ls_inv_snapshot', { size: (inv.lastBytes / 1024).toFixed(1), status: lsStatus }) + '\n\n' +
        t('modal.ls_inventory_top_keys') + `\n${top}` +
        `</pre>`;
      Modal.confirm({
        title:        t('modal.ls_inventory_title'),
        message:      t('modal.ls_inventory_msg'),
        detail,
        confirmLabel: t('btn.close'),
        tone:         'warn',
      });
    },

    _exportDiagnostics() {
      const bundle = {
        generatedAt: new Date().toISOString(),
        build:       Config.BUILD_ID,
        schema:      Config.SCHEMA_VERSION,
        userAgent:   navigator.userAgent,
        location:    location.href,
        storage:     Persistence.storageInventory(),
        heap: (performance && performance.memory) ? {
          usedMB:  +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
          limitMB: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(1),
        } : null,
        persistence: (Persistence.stats && Persistence.stats()) || null,
        health:      AdminCockpit._healthData || null,
        deep:        AdminCockpit._deepData   || null,
        storeCounts: {
          tasks:        Store.tasksArr.length,
          blocks:       (Store.blocks || []).length,
          plantBlocks:  (Store.plantBlocks || []).length,
          lines:        Object.keys(Store.lineSettings || {}).length,
          plants:       Object.keys(Store.plants || {}).length,
          fixed:        Store.fixedIds ? Store.fixedIds.size : 0,
          alerts:       (Store.alerts || []).length,
        },
        selectedPlant: Store.selectedPlant,
        errorRates: {
          errorPerMin: ErrorLog.errorRatePerMin(),
          warnPerMin:  ErrorLog.warnRatePerMin(),
          totalErrors: ErrorLog.countBy('error'),
          totalWarns:  ErrorLog.countBy('warn'),
        },
        errors: ErrorLog.entries().slice(-500),
        droppedErrors: ErrorLog.droppedCount(),
      };
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nimbus-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      Toast.show(t('toast.diag_bundle_downloaded'), 'success');
    }
  };

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

  /* =============================================================================
     MASTER DATA — Manage Data Tables admin sub-tab UI (Subnetwork / Plant / Production Line)
     ========================================================================== */
  const MasterData = (() => {
    const API = Config.API_BASE;
    let _activeTable = 'subnetworks';
    // Per-table state: { columns, rows, dirty: Map(rowKey→patch), deleted: Set(rowKey), added: [] }
    const _cache = {};

    const TABLE_LABELS = {
      subnetworks:      'Subnetworks',
      plants:           'Plants',
      production_lines: 'Production Lines',
      materials:        'Material',
      material_plants:  'Material Plant',
      bom_items:        'Bill of Materials',
    };

    // KEY_COLS drives primary-key identification per table.
    const KEY_COLS = {
      subnetworks:      ['code'],
      plants:           ['subnetwork', 'plant'],
      production_lines: ['subnetwork', 'plant', 'production_line'],
      materials:        ['material_id'],
      material_plants:  ['material_id', 'plant'],
      bom_items:        ['material_id', 'plant', 'alternative_bom', 'level', 'item_number', 'component_id'],
    };

    // Tables that need a parent-dropdown for FK columns.
    const FK_SOURCE = {
      plants:           { subnetwork: 'subnetworks' },
      production_lines: { subnetwork: 'subnetworks', plant: 'plants' },
      material_plants:  { material_id: 'materials' },
      // bom_items.component_id is deliberately NOT registered here: it needs a
      // plant-scoped option list (material_plants filtered to the row's plant),
      // which the generic _fkSelect (whole-source-table, single-key convention)
      // can't express. See the bom_items special case in _appendRow instead.
    };

    // bom_items requires a plant + material pick before the grid loads (its
    // table is expected to be huge — one row per component per level per
    // material — unlike every other MasterData table, which loads in full).
    let _bomFilter = { plant: null, material_id: null };

    function _rowKey(table, row) {
      return KEY_COLS[table].map(k => String(row[k] ?? '')).join('|');
    }

    function _parsePaste(rawText, columns) {
      const lines = rawText.replace(/\r/g, '').split('\n').filter(l => l.trim());
      if (!lines.length) return { rows: [] };
      const colNames  = columns.map(c => c.column_name.toLowerCase());
      const colLabels = columns.map(c => (c.display_label || c.column_name).toLowerCase());
      const first     = lines[0].split('\t').map(h => h.trim().toLowerCase());
      const hasHeader = first.some(h => colNames.includes(h) || colLabels.includes(h));
      let headers, dataLines;
      if (hasHeader) {
        headers   = first.map(h => {
          const ni = colNames.indexOf(h);
          if (ni >= 0) return columns[ni].column_name;
          const li = colLabels.indexOf(h);
          return li >= 0 ? columns[li].column_name : h;
        });
        dataLines = lines.slice(1);
      } else {
        headers   = columns.map(c => c.column_name);
        dataLines = lines;
      }
      const rows = dataLines.map(line => {
        const vals = line.split('\t');
        const row  = {};
        headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
        return row;
      });
      return { rows };
    }

    // -----------------------------------------------------------------------
    // Public entry point
    // -----------------------------------------------------------------------
    function render() {
      // Wire inner tabs on first call.
      document.querySelectorAll('.md-tab').forEach(b => {
        b.onclick = () => _setTab(b.dataset.mdTab);
      });
      const exportBtn = document.getElementById('md-export-schema-btn');
      if (exportBtn) exportBtn.onclick = _exportSchema;
      _syncTabUI();
      _renderActiveTable();
    }

    function _setTab(table) {
      _activeTable = table;
      _syncTabUI();
      _renderActiveTable();
    }

    function _syncTabUI() {
      document.querySelectorAll('.md-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.mdTab === _activeTable));
    }

    // bom_items never loads unscoped (its table is expected to be huge) — show
    // the plant+material picker gate until both are chosen, same as every
    // other tab shows its grid immediately.
    function _renderActiveTable() {
      if (_activeTable === 'bom_items' && !(_bomFilter.plant && _bomFilter.material_id)) {
        _renderBomGate();
      } else {
        _loadAndRender(_activeTable);
      }
    }

    // -----------------------------------------------------------------------
    // BOM plant + material scope gate
    // -----------------------------------------------------------------------
    function _renderBomGate() {
      const host = document.getElementById('md-host');
      if (!host) return;
      host.innerHTML = `
        <div class="md-bom-gate">
          <p class="md-bom-gate-hint">${t('hint.bom_pick_scope')}</p>
          <div class="md-bom-gate-row">
            <label>${t('ui.plant_label')}</label>
            <div id="md-bom-plant-picker"></div>
          </div>
          <div class="md-bom-gate-row">
            <label>${t('col.material')}</label>
            <div id="md-bom-material-picker"></div>
          </div>
        </div>`;
      const plants = Store.knownPlants ? Store.knownPlants() : [];
      _mkCombobox(document.getElementById('md-bom-plant-picker'), plants, {
        value: _bomFilter.plant || '',
        placeholder: t('ph.select_plant'),
        onSelect: (p) => {
          _bomFilter = { plant: p || null, material_id: null };
          _renderBomGate();
        },
      });
      if (_bomFilter.plant) _loadBomMaterialsForPlant(_bomFilter.plant);
    }

    async function _loadBomMaterialsForPlant(plant) {
      const matHost = document.getElementById('md-bom-material-picker');
      if (matHost) matHost.innerHTML = `<div class="md-loading-inline">${t('ui.loading')}</div>`;
      try {
        const data = await Util.fetchTraced(`${API}/master-data/material_plants?${new URLSearchParams({ plant }).toString()}`)
          .then(r => r.json());
        const materials = (data.rows || []).map(r => r.material_id).sort();
        const host2 = document.getElementById('md-bom-material-picker');
        if (!host2) return; // tab/plant changed again while this was in flight
        _mkCombobox(host2, materials, {
          value: _bomFilter.material_id || '',
          placeholder: t('ph.select_material'),
          onSelect: (m) => {
            _bomFilter.material_id = m || null;
            if (m) _loadAndRender('bom_items');
          },
        });
      } catch (e) {
        if (matHost) matHost.innerHTML = `<div class="md-empty">${t('err.load_materials_failed')}</div>`;
        ErrorLog.error('master-data', `Failed to load materials for plant ${plant}: ${e.message}`);
      }
    }

    // Minimal self-contained searchable combobox — reuses the topbar
    // PlantSelector's markup/CSS classes (hps-*) for visual consistency and
    // the same type-to-filter/keyboard-nav interaction, but works off a plain
    // options array with no Store dependency, so it fits BOM's plant AND
    // material pickers (PlantSelector itself is wired one-to-one to
    // Store.selectedPlant and the global topbar DOM).
    function _mkCombobox(containerEl, options, { value = '', placeholder = '', onSelect } = {}) {
      if (!containerEl) return;
      containerEl.innerHTML = `
        <div class="hps-combobox md-bom-combobox">
          <input type="text" class="hps-input" placeholder="${placeholder}" autocomplete="off" spellcheck="false"
                 aria-haspopup="listbox" aria-expanded="false">
          <button type="button" class="hps-clear" hidden>&times;</button>
          <div class="hps-dropdown" role="listbox" hidden></div>
        </div>`;
      const root      = containerEl.querySelector('.hps-combobox');
      const input     = root.querySelector('.hps-input');
      const clearBtn  = root.querySelector('.hps-clear');
      const dropdown  = root.querySelector('.hps-dropdown');
      let filtered  = [];
      let activeIdx = -1;
      let open      = false;
      let selected  = value;

      function reflect() {
        input.value = selected || '';
        root.classList.toggle('has-value', !!selected);
        clearBtn.hidden = !selected;
      }
      function renderDropdown(query) {
        const q = (query || '').trim().toLowerCase();
        const looksLikeLabel = selected && String(query).trim().toLowerCase() === String(selected).toLowerCase();
        const filterQ = looksLikeLabel ? '' : q;
        filtered = filterQ ? options.filter(o => String(o).toLowerCase().includes(filterQ)) : options.slice();
        if (!filtered.length) {
          dropdown.innerHTML = `<div class="hps-empty">${options.length ? t('ui.no_matches') : t('ui.no_options')}</div>`;
          activeIdx = -1;
          return;
        }
        dropdown.innerHTML = filtered.map((o, i) =>
          `<div class="hps-option${o === selected ? ' selected' : ''}" role="option" data-idx="${i}">${o}</div>`
        ).join('');
        activeIdx = Math.max(0, filtered.indexOf(selected));
        highlight();
        dropdown.querySelectorAll('.hps-option').forEach((el, i) => {
          el.addEventListener('mousedown', e => { e.preventDefault(); pick(filtered[i]); });
        });
      }
      function highlight() {
        const items = dropdown.querySelectorAll('.hps-option');
        items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
      }
      function openDd()  { dropdown.hidden = false; open = true;  input.setAttribute('aria-expanded', 'true'); }
      function closeDd() { dropdown.hidden = true;  open = false; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); }
      function pick(o) {
        selected = o;
        reflect();
        closeDd();
        input.blur();
        if (onSelect) onSelect(o);
      }

      input.addEventListener('focus', () => { renderDropdown(input.value); openDd(); });
      input.addEventListener('input', () => { renderDropdown(input.value); openDd(); });
      input.addEventListener('keydown', e => {
        if (!open) {
          if (e.key === 'ArrowDown' || e.key === 'Enter') { renderDropdown(input.value); openDd(); e.preventDefault(); }
          return;
        }
        if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); highlight(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (filtered[activeIdx]) pick(filtered[activeIdx]); }
        else if (e.key === 'Escape') { closeDd(); reflect(); input.blur(); }
      });
      input.addEventListener('blur', () => { setTimeout(() => { closeDd(); reflect(); }, 120); });
      clearBtn.addEventListener('mousedown', e => e.preventDefault());
      clearBtn.addEventListener('click', () => { selected = ''; reflect(); if (onSelect) onSelect(''); input.focus(); });
      document.addEventListener('click', e => { if (!root.contains(e.target)) closeDd(); });

      reflect();
    }

    // -----------------------------------------------------------------------
    // Data loading
    // -----------------------------------------------------------------------
    async function _loadAndRender(table) {
      const host = document.getElementById('md-host');
      if (!host) return;
      host.innerHTML = `<div class="md-loading">${t('ui.loading')}</div>`;
      const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      // bom_items is the one table that must never load in full — always scope
      // the request to the plant + material the user picked via the gate.
      const qs = table === 'bom_items'
        ? `?${new URLSearchParams({ plant: _bomFilter.plant, material_id: _bomFilter.material_id }).toString()}`
        : '';
      try {
        const data = await Util.fetchTraced(`${API}/master-data/${table}${qs}`, { headers: { 'x-request-id': reqId } }).then(async r => {
          if (!r.ok) {
            // Surface the backend body instead of discarding it.
            const parsed = await Util.parseBackendError(r);
            const err = new Error(parsed.message); err.errorCode = parsed.errorCode; err.httpStatus = r.status;
            throw err;
          }
          return r.json();
        });
        _cache[table] = {
          columns: data.columns,
          rows:    data.rows,
          dirty:   new Map(),
          deleted: new Set(),
          added:   [],
        };
        _renderTable(table);
      } catch (e) {
        host.innerHTML = `<div class="md-empty">Failed to load ${TABLE_LABELS[table]}: ${e.message}</div>`;
        ErrorLog.error('master-data', `Load failed for ${table}: ${e.message}`,
          { reqId, table, status: e.httpStatus }, { reqId, errorCode: e.errorCode || 'http.network' });
      }
    }

    // -----------------------------------------------------------------------
    // Table rendering
    // -----------------------------------------------------------------------
    function _renderTable(table) {
      const host = document.getElementById('md-host');
      if (!host) return;
      const state = _cache[table];
      if (!state) return;

      const { columns, rows, dirty, deleted, added } = state;
      const allRows = [...rows, ...added];
      const isDirty = dirty.size > 0 || deleted.size > 0 || added.length > 0;

      host.innerHTML = '';

      if (table === 'bom_items') {
        const scopeBar = document.createElement('div');
        scopeBar.className = 'md-bom-scope-bar';
        scopeBar.innerHTML = `<span>${t('ui.plant_label')}: <strong>${_bomFilter.plant}</strong> &middot; ${t('col.material')}: <strong>${_bomFilter.material_id}</strong></span>`;
        const changeBtn = document.createElement('button');
        changeBtn.className = 'btn btn-ghost sm';
        changeBtn.textContent = t('btn.change_scope');
        changeBtn.onclick = () => {
          _bomFilter = { plant: null, material_id: null };
          delete _cache.bom_items;
          _renderActiveTable();
        };
        scopeBar.appendChild(changeBtn);
        host.appendChild(scopeBar);
      }

      // -- Toolbar --
      const toolbar = document.createElement('div');
      toolbar.className = 'md-toolbar';

      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'input md-search';
      searchInput.placeholder = t('ph.search_table', { table: TABLE_LABELS[table] });
      searchInput.oninput = () => _applyFilter(table, searchInput.value.toLowerCase());
      toolbar.appendChild(searchInput);

      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      toolbar.appendChild(spacer);

      if (isDirty) {
        const badge = document.createElement('span');
        badge.className = 'md-dirty-badge';
        const n = dirty.size + deleted.size + added.length;
        badge.textContent = t('ui.unsaved_badge', { count: n });
        toolbar.appendChild(badge);
      }

      const addRowBtn = document.createElement('button');
      addRowBtn.className = 'btn btn-ghost sm';
      addRowBtn.textContent = t('btn.add_row');
      addRowBtn.onclick = () => _addRow(table);
      toolbar.appendChild(addRowBtn);

      const pasteBtn = document.createElement('button');
      pasteBtn.className = 'btn btn-ghost sm';
      pasteBtn.textContent = t('btn.paste_rows');
      pasteBtn.title = t('tip.paste_rows');
      pasteBtn.onclick = () => _pasteRows(table);
      toolbar.appendChild(pasteBtn);

      if (table === 'bom_items') {
        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'btn btn-ghost sm';
        uploadBtn.textContent = t('btn.upload_bom');
        uploadBtn.title = t('tip.upload_bom');
        uploadBtn.onclick = () => _uploadBom();
        toolbar.appendChild(uploadBtn);
      }

      const addColBtn = document.createElement('button');
      addColBtn.className = 'btn btn-ghost sm';
      addColBtn.textContent = t('btn.add_column');
      addColBtn.onclick = () => _openAddColumn(table);
      toolbar.appendChild(addColBtn);

      const discardBtn = document.createElement('button');
      discardBtn.className = 'btn btn-ghost sm';
      discardBtn.textContent = t('btn.discard');
      discardBtn.disabled = !isDirty;
      discardBtn.onclick = () => { delete _cache[table]; _loadAndRender(table); };
      toolbar.appendChild(discardBtn);

      const saveBtn = document.createElement('button');
      saveBtn.className = `btn btn-primary sm${isDirty ? '' : ' md-save-idle'}`;
      saveBtn.textContent = t('btn.save');
      saveBtn.disabled = !isDirty;
      saveBtn.onclick = () => _save(table);
      toolbar.appendChild(saveBtn);

      host.appendChild(toolbar);

      // -- Table --
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';

      const tbl = document.createElement('table');
      tbl.className = 'md-table';
      tbl.id = `md-tbl-${table}`;

      // Header
      const thead = document.createElement('thead');
      const hRow = document.createElement('tr');
      columns.forEach(col => {
        const th = document.createElement('th');
        th.className = 'md-th';
        const lbl = document.createElement('span');
        lbl.textContent = col.display_label;
        th.appendChild(lbl);

        // Column action menu (⋮)
        const menuBtn = document.createElement('button');
        menuBtn.className = 'md-col-menu-btn';
        menuBtn.textContent = '⋮';
        menuBtn.title = t('tip.col_options');
        menuBtn.onclick = e => { e.stopPropagation(); _openColMenu(table, col, menuBtn); };
        th.appendChild(menuBtn);

        hRow.appendChild(th);
      });
      // Blank header for delete button column
      hRow.appendChild(document.createElement('th'));
      thead.appendChild(hRow);
      tbl.appendChild(thead);

      // Body
      const tbody = document.createElement('tbody');
      tbody.id = `md-tbody-${table}`;

      if (!allRows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = columns.length + 1;
        td.className = 'md-empty';
        td.textContent = t('empty.table_no_rows', { table: TABLE_LABELS[table] });
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        allRows.forEach(row => _appendRow(tbody, table, columns, row));
      }
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      host.appendChild(wrap);
    }

    function _appendRow(tbody, table, columns, row) {
      const state = _cache[table];
      const key = _rowKey(table, row);
      const isNew = state.added.some(r => _rowKey(table, r) === key);
      const isDeleted = state.deleted.has(key);
      const isDirty = state.dirty.has(key);
      // Render pending (dirty) values over the saved baseline so an in-progress edit
      // survives a re-render (add/paste/delete all call _renderTable). For added rows
      // the dirty entry IS the added row object, so rowView resolves to the same values.
      const _dirtyPatch = state.dirty.get(key);
      const rowView = _dirtyPatch ? { ...row, ..._dirtyPatch } : row;

      const tr = document.createElement('tr');
      tr.dataset.rowKey = key;
      tr.className = [
        isNew     ? 'md-row-new'     : '',
        isDeleted ? 'md-row-deleted' : '',
        isDirty   ? 'md-row-dirty'   : '',
      ].filter(Boolean).join(' ');

      columns.forEach(col => {
        const td = document.createElement('td');
        td.className = 'md-td';

        // bom_items.component_id: plant-scoped dropdown (material_plants rows
        // for this row's plant), not the generic FK_SOURCE/_fkSelect path —
        // that assumes the source table's LAST key column is the value column
        // (true for material_plants -> 'plant', wrong for what we need: 'material_id').
        if (table === 'bom_items' && col.column_name === 'component_id' && isNew) {
          td.appendChild(_bomComponentSelect(rowView.plant || _bomFilter.plant, rowView.component_id, key));
          tr.appendChild(td);
          return;
        }

        // FK columns get a <select> populated from parent table.
        const fkSources = FK_SOURCE[table] || {};
        if (fkSources[col.column_name] && !isNew) {
          // For existing rows, key columns are read-only.
          if (col.is_locked) {
            td.textContent = rowView[col.column_name] ?? '';
          } else {
            td.appendChild(_fkSelect(table, col.column_name, rowView[col.column_name], fkSources[col.column_name], key));
          }
        } else if (fkSources[col.column_name] && isNew) {
          td.appendChild(_fkSelect(table, col.column_name, rowView[col.column_name], fkSources[col.column_name], key));
        } else if (col.is_locked && !isNew) {
          // Key columns on saved rows are read-only.
          td.textContent = rowView[col.column_name] ?? '';
        } else {
          const cell = document.createElement('div');
          cell.contentEditable = isDeleted ? 'false' : 'true';
          cell.className = 'md-cell';
          cell.textContent = rowView[col.column_name] ?? '';
          cell.dataset.col = col.column_name;
          cell.dataset.rowKey = key;
          cell.oninput = () => _markDirty(table, key, col.column_name, cell.textContent);
          td.appendChild(cell);
        }
        tr.appendChild(td);
      });

      // Delete button
      const delTd = document.createElement('td');
      delTd.className = 'md-td md-td-action';
      if (!isDeleted) {
        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn md-del-btn';
        delBtn.title = t('tip.delete_row');
        delBtn.textContent = '🗑';
        delBtn.onclick = () => _deleteRow(table, key, tr);
        delTd.appendChild(delBtn);
      } else {
        const undoBtn = document.createElement('button');
        undoBtn.className = 'btn btn-ghost sm';
        undoBtn.textContent = t('btn.undo');
        undoBtn.onclick = () => { state.deleted.delete(key); _renderTable(table); };
        delTd.appendChild(undoBtn);
      }
      tr.appendChild(delTd);
      tbody.appendChild(tr);
    }

    function _fkSelect(table, colName, value, sourceTable, rowKey) {
      const sel = document.createElement('select');
      sel.className = 'input md-fk-select';
      // Populate from cache or fetch.
      const sourceState = _cache[sourceTable];
      const sourceRows = sourceState?.rows ?? [];
      const srcKeys = KEY_COLS[sourceTable];
      // For subnetworks: use 'code'. For plants when in production_lines: use 'plant'.
      const valCol = srcKeys[srcKeys.length - 1];
      const labelCol = sourceTable === 'subnetworks' ? 'name' : valCol;

      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = t('ui.select_placeholder');
      sel.appendChild(blank);
      const _optLabel = r => (r[labelCol] && labelCol !== valCol) ? `${r[valCol]} — ${r[labelCol]}` : r[valCol];
      sourceRows.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r[valCol];
        opt.textContent = _optLabel(r);
        if (r[valCol] === value) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = () => _markDirty(table, rowKey, colName, sel.value);

      // If source not loaded yet, fetch it.
      if (!sourceState) {
        fetch(`${API}/master-data/${sourceTable}`).then(r => r.json()).then(data => {
          _cache[sourceTable] = { columns: data.columns, rows: data.rows, dirty: new Map(), deleted: new Set(), added: [] };
          // Rebuild select options.
          while (sel.options.length > 1) sel.remove(1);
          data.rows.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r[valCol];
            opt.textContent = _optLabel(r);
            if (r[valCol] === value) opt.selected = true;
            sel.appendChild(opt);
          });
        }).catch(() => {});
      }
      return sel;
    }

    // Per-plant memoized list of material_ids valid at that plant, used only
    // by the bom_items component_id dropdown. Deliberately separate from
    // _cache['material_plants'] (which may be absent, or scoped to a
    // different plant if that tab was visited) rather than risking either
    // table's cached view corrupting the other's.
    const _bomComponentOptionsCache = {};

    function _bomComponentSelect(plant, value, rowKey) {
      const sel = document.createElement('select');
      sel.className = 'input md-fk-select';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = t('ui.select_placeholder');
      sel.appendChild(blank);

      const fill = (materials) => {
        while (sel.options.length > 1) sel.remove(1);
        materials.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === value) opt.selected = true;
          sel.appendChild(opt);
        });
      };
      sel.onchange = () => _markDirty('bom_items', rowKey, 'component_id', sel.value);

      if (_bomComponentOptionsCache[plant]) {
        fill(_bomComponentOptionsCache[plant]);
      } else if (plant) {
        fetch(`${API}/master-data/material_plants?${new URLSearchParams({ plant }).toString()}`)
          .then(r => r.json())
          .then(data => {
            const materials = (data.rows || []).map(r => r.material_id).sort();
            _bomComponentOptionsCache[plant] = materials;
            fill(materials);
          }).catch(() => {});
      }
      return sel;
    }

    function _markDirty(table, rowKey, colName, value) {
      const state = _cache[table];
      if (!state) return;
      // An existing dirty entry accumulates further edits. For a row's FIRST edit start
      // the patch from a SHALLOW COPY of the live baseline, so the baseline in
      // state.rows is never mutated in place — EXCEPT for newly-added rows, which ARE
      // their own working copy in state.added and are intentionally edited in place
      // (_save reads them from there; copying one would leave the added entry blank and
      // trip the "missing key columns" guard in _save).
      let patch = state.dirty.get(rowKey);
      if (!patch) {
        const addedRow = (state.added || []).find(r => _rowKey(table, r) === rowKey);
        patch = addedRow ? addedRow : { ..._getRowByKey(table, rowKey) };
      }
      patch[colName] = value;
      state.dirty.set(rowKey, patch);
      // Update the tr class to show dirty highlight.
      const tr = document.querySelector(`#md-tbody-${table} tr[data-row-key="${CSS.escape(rowKey)}"]`);
      if (tr) tr.classList.add('md-row-dirty');
      _updateSaveBtn(table);
    }

    function _getRowByKey(table, key) {
      const state = _cache[table];
      const all = [...(state?.rows ?? []), ...(state?.added ?? [])];
      return all.find(r => _rowKey(table, r) === key) ?? {};
    }

    function _updateSaveBtn(table) {
      const state = _cache[table];
      if (!state) return;
      const isDirty = state.dirty.size > 0 || state.deleted.size > 0 || state.added.length > 0;
      const saveBtn = document.querySelector('#md-host .btn-primary.sm');
      if (saveBtn) {
        saveBtn.disabled = !isDirty;
        saveBtn.classList.toggle('md-save-idle', !isDirty);
      }
      // Update dirty badge.
      const badge = document.querySelector('#md-host .md-dirty-badge');
      if (badge) {
        const n = state.dirty.size + state.deleted.size + state.added.length;
        badge.textContent = `${n} unsaved`;
        badge.hidden = !isDirty;
      }
    }

    function _addRow(table) {
      const state = _cache[table];
      if (!state) return;
      const newRow = {};
      state.columns.forEach(c => { newRow[c.column_name] = ''; });
      if (table === 'bom_items') {
        // A new row is always within the currently scoped material+plant —
        // pre-fill so the user isn't retyping the scope on every row.
        newRow.material_id = _bomFilter.material_id || '';
        newRow.plant = _bomFilter.plant || '';
      }
      state.added.push(newRow);
      // Re-render to show the new row (simpler than appending).
      _renderTable(table);
      // Focus first editable cell of the new row.
      setTimeout(() => {
        const tbody = document.getElementById(`md-tbody-${table}`);
        const lastRow = tbody?.lastElementChild;
        const firstCell = lastRow?.querySelector('.md-cell');
        if (firstCell) firstCell.focus();
      }, 50);
    }

    async function _uploadBom() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.xlsx';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        try {
          const resp = await Util.fetchTraced(`${API}/bom/upload`, { method: 'POST', body: fd });
          const result = await resp.json();
          if (!resp.ok) throw new Error(result.detail || result.message || t('toast.bom_upload_failed'));
          Toast.show(
            t('toast.bom_upload_done', {
              inserted: result.inserted || 0, updated: result.updated || 0, rejected: result.rejected || 0,
            }),
            result.rejected ? 'warn' : 'success',
          );
          if (result.warnings && result.warnings.length) {
            result.warnings.slice(0, 10).forEach(w => ErrorLog.warn('master-data', w.msg));
          }
          // Refresh the currently-scoped view so newly uploaded rows for this
          // material+plant show up immediately.
          delete _cache.bom_items;
          if (_activeTable === 'bom_items') _renderActiveTable();
        } catch (e) {
          Toast.show(`${t('toast.bom_upload_failed')}: ${e.message}`, 'error');
          ErrorLog.error('master-data', `BOM upload failed: ${e.message}`);
        }
      };
      input.click();
    }

    async function _pasteRows(table) {
      let raw;
      try {
        raw = await navigator.clipboard.readText();
      } catch {
        Toast.show(t('toast.clipboard_denied'), 'error');
        return;
      }
      if (!raw.trim()) { Toast.show(t('toast.clipboard_empty'), 'error'); return; }

      const state = _cache[table];
      if (!state) return;

      const { rows } = _parsePaste(raw, state.columns);
      if (!rows.length) { Toast.show(t('toast.no_rows_paste'), 'error'); return; }

      const keys    = KEY_COLS[table];
      const toAdd   = [];
      const toUpdate = [];
      const invalid  = [];

      rows.forEach(row => {
        if (keys.find(k => !row[k])) { invalid.push(row); return; }
        const key = _rowKey(table, row);
        const inSaved    = state.rows.some(r => _rowKey(table, r) === key);
        const inAdded    = state.added.some(r => _rowKey(table, r) === key);
        const batchAddIdx = toAdd.findIndex(r => _rowKey(table, r) === key);
        const batchUpdIdx = toUpdate.findIndex(r => _rowKey(table, r) === key);
        if      (batchAddIdx >= 0)  toAdd[batchAddIdx]    = row; // last write wins within batch
        else if (batchUpdIdx >= 0)  toUpdate[batchUpdIdx] = row;
        else if (inSaved || inAdded) toUpdate.push(row);
        else                         toAdd.push(row);
      });

      if (!toAdd.length && !toUpdate.length) {
        Toast.show(invalid.length
          ? t('toast.missing_key_rows', { count: invalid.length, keys: keys.join(', ') })
          : t('toast.no_valid_rows'), 'error');
        return;
      }

      const parts = [];
      if (toAdd.length)    parts.push(`add ${toAdd.length} new`);
      if (toUpdate.length) parts.push(`update ${toUpdate.length} existing`);
      if (invalid.length)  parts.push(`skip ${invalid.length} invalid`);

      const ok = await Modal.confirm({
        title:   'Paste Rows',
        message: `This will ${parts.join(', ')} row(s).`,
        detail:  `Changes appear in the table but won't be saved until you click Save.` +
                 (invalid.length ? ` Skipped rows are missing key column(s): ${keys.join(', ')}.` : ''),
        tone:    'info',
      });
      if (!ok) return;

      toAdd.forEach(row => {
        const full = {};
        state.columns.forEach(c => { full[c.column_name] = row[c.column_name] ?? ''; });
        state.added.push(full);
      });

      toUpdate.forEach(row => {
        const key = _rowKey(table, row);
        const idx = state.rows.findIndex(r => _rowKey(table, r) === key);
        if (idx >= 0) {
          Object.assign(state.rows[idx], row);
          state.dirty.set(key, { ...state.rows[idx] });
        } else {
          const ai = state.added.findIndex(r => _rowKey(table, r) === key);
          if (ai >= 0) Object.assign(state.added[ai], row);
        }
      });

      _renderTable(table);
      Toast.show(invalid.length
        ? t('toast.paste_result_skip', { added: toAdd.length, updated: toUpdate.length, skipped: invalid.length })
        : t('toast.paste_result', { added: toAdd.length, updated: toUpdate.length }), 'success');
    }

    async function _deleteRow(table, rowKey, tr) {
      const state = _cache[table];
      if (!state) return;

      // Build delete payload from the key.
      const keys = KEY_COLS[table];
      const row = _getRowByKey(table, rowKey);
      const deletePayload = {};
      keys.forEach(k => { deletePayload[k] = row[k]; });

      // Get cascade preview for saved rows (not for newly-added rows).
      const isNew = state.added.some(r => _rowKey(table, r) === rowKey);
      let cascadeDetail = '';

      if (!isNew && (table === 'subnetworks' || table === 'plants' || table === 'material_plants')) {
        try {
          const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deletes: [deletePayload] }),
          }).then(r => r.json());

          const parts = [];
          if (preview.plants > 0)           parts.push(`<strong>${preview.plants}</strong> plant${preview.plants !== 1 ? 's' : ''}`);
          if (preview.production_lines > 0)  parts.push(`<strong>${preview.production_lines}</strong> production line${preview.production_lines !== 1 ? 's' : ''}`);
          if (preview.bom_items > 0)          parts.push(`<strong>${preview.bom_items}</strong> BOM item${preview.bom_items !== 1 ? 's' : ''}`);
          if (parts.length) {
            cascadeDetail = table === 'material_plants'
              ? `<div class="md-cascade-warn">This is referenced by ${parts.join(' and ')} — delete those first.</div>`
              : `<div class="md-cascade-warn">This will also permanently delete ${parts.join(' and ')}.</div>`;
          }
        } catch {}
      }

      const keyDisplay = keys.map(k => row[k]).join(' / ');
      const confirmed = await Modal.confirm({
        title:         `Delete "${keyDisplay}"?`,
        message:       `Are you sure you want to delete this ${TABLE_LABELS[table].replace(/s$/, '').toLowerCase()} from the database?`,
        detail:        cascadeDetail || undefined,
        confirmLabel:  'Yes, delete',
        tone:          'danger',
      });
      if (!confirmed) return;

      if (isNew) {
        // Just remove from added array.
        const idx = state.added.findIndex(r => _rowKey(table, r) === rowKey);
        if (idx >= 0) state.added.splice(idx, 1);
        _renderTable(table);
      } else {
        state.deleted.add(rowKey);
        tr.className = 'md-row-deleted';
        _updateSaveBtn(table);
        _renderTable(table);
      }
    }

    // -----------------------------------------------------------------------
    // Save
    // -----------------------------------------------------------------------
    async function _save(table) {
      const state = _cache[table];
      if (!state) return;
      const keys = KEY_COLS[table];

      // Build upserts from dirty + added.
      const upserts = [];
      state.dirty.forEach((patch, _key) => { if (!state.deleted.has(_key)) upserts.push(patch); });
      state.added.forEach(row => {
        // Validate that key columns are filled.
        const missing = keys.filter(k => !row[k]);
        if (missing.length) {
          Toast.show(t('toast.no_plant_selected') + ': ' + missing.join(', '), 'error');
          return;
        }
        upserts.push(row);
      });

      // Build deletes.
      const deletes = [];
      state.deleted.forEach(rowKey => {
        const row = _getRowByKey(table, rowKey);
        const d = {};
        keys.forEach(k => { d[k] = row[k]; });
        deletes.push(d);
      });

      if (!upserts.length && !deletes.length) return;

      // Cascade confirmation for deletes that weren't already confirmed.
      if (deletes.length && (table === 'subnetworks' || table === 'plants' || table === 'material_plants')) {
        try {
          const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deletes }),
          }).then(r => r.json());
          const total = (preview.plants || 0) + (preview.production_lines || 0) + (preview.bom_items || 0);
          if (total > 0) {
            const parts = [];
            if (preview.plants > 0)          parts.push(`${preview.plants} plant${preview.plants !== 1 ? 's' : ''}`);
            if (preview.production_lines > 0) parts.push(`${preview.production_lines} production line${preview.production_lines !== 1 ? 's' : ''}`);
            if (preview.bom_items > 0)         parts.push(`${preview.bom_items} BOM item${preview.bom_items !== 1 ? 's' : ''}`);
            const ok = table === 'material_plants'
              ? await Modal.confirm({
                  title:         `Cannot delete ${deletes.length} row${deletes.length !== 1 ? 's' : ''}`,
                  message:       `This is referenced by ${parts.join(' and ')} — delete those first.`,
                  confirmLabel:  `OK`,
                  tone:          'danger',
                }).then(() => false)
              : await Modal.confirm({
                  title:         `Delete ${deletes.length} row${deletes.length !== 1 ? 's' : ''}?`,
                  message:       `This will also permanently delete ${parts.join(' and ')}.`,
                  detail:        '<strong>This cannot be undone.</strong>',
                  confirmLabel:  `Yes, delete all`,
                  tone:          'danger',
                });
            if (!ok) return;
          }
        } catch {}
      }

      try {
        const res = await fetch(`${API}/master-data/${table}/bulk`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ upserts, deletes }),
        }).then(r => {
          if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });

        Toast.show(
          t('toast.paste_result', { added: res.inserted, updated: res.updated }) + `, ${res.deleted} deleted`,
          'success'
        );
        delete _cache[table];
        await _loadAndRender(table);

        // Refresh master-data in Store so Hierarchy/ProdLines stay in sync.
        Promise.all([
          fetch(`${API}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
          fetch(`${API}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        ]).then(([pData, lData]) => {
          if (pData || lData) {
            Store._state.masterData = {
              plants: pData?.rows ?? [],
              lines:  lData?.rows ?? [],
            };
            Store.rebuildPlantIndex(); // backfill line→plant cache / plant index after edit
          }
          Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
        }).catch(() => {
          Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
        });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('master-data', `Save failed for ${table}: ${e.message}`);
      }
    }

    // -----------------------------------------------------------------------
    // Filter / search
    // -----------------------------------------------------------------------
    function _applyFilter(table, query) {
      const tbody = document.getElementById(`md-tbody-${table}`);
      if (!tbody) return;
      tbody.querySelectorAll('tr').forEach(tr => {
        const text = tr.textContent.toLowerCase();
        tr.hidden = query ? !text.includes(query) : false;
      });
    }

    // -----------------------------------------------------------------------
    // Column management
    // -----------------------------------------------------------------------
    function _openColMenu(table, col, anchor) {
      // Close any existing menu.
      document.querySelectorAll('.md-col-menu').forEach(m => m.remove());

      const menu = document.createElement('div');
      menu.className = 'md-col-menu';

      const rename = document.createElement('button');
      rename.className = 'md-col-menu-item';
      rename.textContent = t('btn.rename_label');
      rename.onclick = () => { menu.remove(); _openRenameLabel(table, col); };
      menu.appendChild(rename);

      const drop = document.createElement('button');
      drop.className = 'md-col-menu-item md-col-menu-danger';
      drop.textContent = t('btn.delete_column');
      drop.disabled = col.is_locked;
      drop.title = col.is_locked ? t('tip.key_cols_no_delete') : '';
      drop.onclick = () => { menu.remove(); _dropColumn(table, col); };
      menu.appendChild(drop);

      document.body.appendChild(menu);
      const rect = anchor.getBoundingClientRect();
      menu.style.top  = `${rect.bottom + 4}px`;
      menu.style.left = `${rect.left}px`;

      const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    }

    function _openAddColumn(table) {
      document.getElementById('md-col-name').value  = '';
      document.getElementById('md-col-label').value = '';
      document.getElementById('md-col-type').value  = 'TEXT';
      document.getElementById('md-col-length').value = '';
      document.getElementById('md-col-default').value = '';
      document.getElementById('md-col-nullable').checked = true;
      document.getElementById('md-addcol-error').textContent = '';
      document.getElementById('md-col-length-row').hidden = true;

      const typeSelect = document.getElementById('md-col-type');
      typeSelect.onchange = () => {
        document.getElementById('md-col-length-row').hidden = typeSelect.value !== 'NUMERIC';
      };

      document.getElementById('md-addcol-confirm-btn').onclick = async () => {
        const colName  = document.getElementById('md-col-name').value.trim();
        const label    = document.getElementById('md-col-label').value.trim() || colName;
        const sqlType  = document.getElementById('md-col-type').value;
        const length   = document.getElementById('md-col-length').value.trim() || null;
        const nullable = document.getElementById('md-col-nullable').checked;
        const def      = document.getElementById('md-col-default').value.trim() || null;
        const errEl    = document.getElementById('md-addcol-error');

        if (!colName) { errEl.textContent = t('ui.column_id_required'); return; }
        if (!/^[a-z][a-z0-9_]{0,62}$/.test(colName)) {
          errEl.textContent = t('ui.column_id_format');
          return;
        }
        if (!nullable && !def) {
          errEl.textContent = t('ui.not_null_requires_default');
          return;
        }

        Modal.close('md-addcol-modal');

        try {
          await fetch(`${API}/master-data/${table}/columns`, {
            method:  'POST',
            headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body:    JSON.stringify({ column_name: colName, sql_type: sqlType, length, nullable, default: def, display_label: label }),
          }).then(r => {
            if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
            return r.json();
          });
          Toast.show(t('toast.col_added', { label }), 'success');
          delete _cache[table];
          _loadAndRender(table);
        } catch (e) {
          Toast.show(t('toast.failed_add_col', { msg: e.message }), 'error');
        }
      };

      Modal.open('md-addcol-modal');
    }

    async function _dropColumn(table, col) {
      const confirmed = await Modal.confirm({
        title:         t('modal.drop_column_title', { label: col.display_label }),
        message:       t('modal.drop_column_msg', { name: col.column_name, table: TABLE_LABELS[table] }),
        detail:        `<strong>${t('modal.delete_cannot_undo')}</strong>`,
        confirmLabel:  t('modal.drop_column_confirm'),
        tone:          'danger',
      });
      if (!confirmed) return;

      try {
        await fetch(`${API}/master-data/${table}/columns/${col.column_name}`, {
          method:  'DELETE',
          headers: { 'x-user-email': Session.actor() },
        }).then(r => {
          if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        Toast.show(t('toast.column_dropped', { col: col.column_name }), 'success');
        delete _cache[table];
        _loadAndRender(table);
      } catch (e) {
        Toast.show(t('toast.failed_drop_column', { msg: e.message }), 'error');
      }
    }

    function _openRenameLabel(table, col) {
      const noteEl  = document.getElementById('md-rename-note');
      const inputEl = document.getElementById('md-rename-label-input');
      if (noteEl)  noteEl.textContent = `Column ID: "${col.column_name}" (unchanged) · Table: ${TABLE_LABELS[table]}`;
      if (inputEl) inputEl.value = col.display_label;

      document.getElementById('md-rename-confirm-btn').onclick = async () => {
        const newLabel = inputEl.value.trim();
        if (!newLabel) return;
        Modal.close('md-renamelabel-modal');
        try {
          await fetch(`${API}/master-data/${table}/columns/${col.column_name}`, {
            method:  'PATCH',
            headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body:    JSON.stringify({ display_label: newLabel }),
          }).then(r => {
            if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
            return r.json();
          });
          Toast.show(t('toast.column_label_updated', { label: newLabel }), 'success');
          delete _cache[table];
          _loadAndRender(table);
        } catch (e) {
          Toast.show(t('toast.failed_rename_label', { msg: e.message }), 'error');
        }
      };
      Modal.open('md-renamelabel-modal');
    }

    // Pulls the current column state (whichever DB this app is pointed at —
    // local or Azure) back out as idempotent SQL, so drift from the Add/Drop
    // Column wizard (which mutates the live DB directly, with no git record)
    // can be folded back into schema.sql after the fact.
    async function _exportSchema() {
      const textEl  = document.getElementById('md-schema-export-text');
      const copyBtn = document.getElementById('md-schema-export-copy-btn');
      textEl.value = '…';
      Modal.open('md-schema-export-modal');
      try {
        const data = await fetch(`${API}/master-data/_schema-export`).then(r => {
          if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        textEl.value = data.sql || '';
      } catch (e) {
        textEl.value = '';
        Toast.show(t('toast.failed_schema_export', { msg: e.message }), 'error');
      }
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(textEl.value)
          .then(() => Toast.show(t('toast.schema_copied'), 'success'))
          .catch(() => Toast.show(t('toast.clipboard_denied'), 'error'));
      };
    }

    async function syncLineSettings(line, patch) {
      if (!_cache['production_lines']) {
        try {
          const data = await fetch(`${API}/master-data/production_lines`).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          });
          _cache['production_lines'] = {
            columns: data.columns, rows: data.rows,
            dirty: new Map(), deleted: new Set(), added: [],
          };
        } catch { return; }
      }

      const state = _cache['production_lines'];
      const rowIdx = state.rows.findIndex(r => r.production_line === line);
      if (rowIdx < 0) return;

      const updatedRow = { ...state.rows[rowIdx] };
      if ('excludeFromOpt' in patch) updatedRow.excl_optimizer  = patch.excludeFromOpt ? 'X' : null;
      if ('bottleneck'     in patch) updatedRow.bottleneck      = patch.bottleneck     ? 'X' : null;
      if ('bufferUnit'     in patch) updatedRow.buffer_type     = patch.bufferUnit === 'pct' ? '%' : 'hrs';
      if ('bufferPct'      in patch) updatedRow.buffer_percent  = patch.bufferPct;
      if ('bufferHours'    in patch) updatedRow.buffer_hours    = patch.bufferHours;
      if ('plGroup'        in patch) updatedRow.pl_group        = patch.plGroup || null;

      // Update cache row and clear any stale dirty flag so MasterData table stays consistent.
      state.rows[rowIdx] = updatedRow;
      state.dirty.delete(_rowKey('production_lines', updatedRow));

      try {
        await fetch(`${API}/master-data/production_lines/bulk`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ upserts: [updatedRow], deletes: [] }),
        }).then(r => {
          if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        if (_activeTable === 'production_lines') _renderTable('production_lines');
      } catch (e) {
        ErrorLog.error('prod-lines', `Failed to save line setting: ${e.message}`);
      }
    }

    return { render, syncLineSettings };
  })();

  /* =============================================================================
     INTERFACE — SAP integration console (Admin → Interface sub-tab)
     A master-detail console rendered into #sap-interface-host, driven by the
     /sap/interface/* endpoints:
       • status ribbon  — aggregate health (connection, enabled, last activity, errors)
       • object rail    — the 6 sync objects (status dot, kind, enable toggle); selects detail
       • detail pane    — Overview (transport/secret/schedule/checklist + Test connection),
                          Mapping (SAP→transform→NIMBUS flow + key-column guardrail),
                          History (run timeline with counts/duration/watermark/error drill-down)
     Dirty-tracking/save is local to this module; it does not touch MasterData.
     Reads use Util.fetchTraced; writes use fetch with x-user-email. Reuses NIMBUS
     component classes (.kpi-tile, .panel, .admin-health-dot, .cal-toggle-*) + a .sap-* block.
     ========================================================================== */
  const Interface = (() => {
    const API = Config.API_BASE;
    // Transform names — must mirror sap_sync.TRANSFORMS in the backend contract.
    const TRANSFORMS = ['none', 'alpha', 'strip_zeros', 'dats', 'tims', 'decimal', 'uom', 'bool_x'];
    const TRANSPORTS = ['file_drop', 'odata', 'rfc'];

    let _objects = [];               // last GET /objects payload — drives ribbon + rail
    let _selected = null;            // selected object_key (master selection)
    let _tab = 'overview';           // active detail tab: 'overview' | 'mapping' | 'history'
    let _testResult = null;          // last {cls,dot,msg} from a Test-connection click
    let _lastNewestKey = null;       // object_key of the most-recent run (ribbon deep-link)
    const _config = {};              // object_key -> GET /config payload (transport/params/has_secret)
    // Per-object mapping editor state: { rows:[{sap_field,nimbus_column,transform,active}], dirty:bool }
    const _mapState = {};

    // Master upsert keys — MUST mirror sap_sync._MASTER_KEY_COLUMNS. A master object whose
    // active mapping omits any of these hits a NOT-NULL on upsert, so the editor blocks Save.
    const MASTER_KEYS = {
      subnetworks:      ['code'],
      plants:           ['subnetwork', 'plant'],
      production_lines: ['subnetwork', 'plant', 'production_line'],
      materials:        ['material_id'],
      material_plants:  ['material_id', 'plant'],
    };
    // One-line transform descriptions (keys mirror sap_sync.TRANSFORMS).
    const XHINT = {
      none: 'pass through unchanged',    alpha: 'ALPHA-pad — e.g. MATNR',
      strip_zeros: 'drop leading zeros', dats: 'SAP YYYYMMDD → ISO date',
      tims: 'SAP HHMMSS → time',         decimal: 'packed decimal, trailing sign',
      uom: 'unit of measure → ISO',      bool_x: "SAP 'X' flag → boolean",
    };
    // Transport-specific connection fields (label + example only — scaffolds the params editor).
    const TRANSPORT_FIELDS = {
      file_drop: [['path', 'Share / Blob path', '/data/sap_drop'], ['glob', 'File glob', 'plants_*.xlsx']],
      odata:     [['base_url', 'Service base URL', 'https://sap-gw/odata/ZNIMBUS_SRV'], ['entity_set', 'Entity set', 'PlantSet'], ['filter', '$filter (delta)', 'LAEDA gt {watermark}'], ['page_size', 'Page size', '1000']],
      rfc:       [['dest', 'RFC destination', 'SAP_PRD'], ['function', 'Function module', 'Z_NIMBUS_GET_PLANTS'], ['batch', 'Batch size', '2000']],
    };

    const _esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function _writeHeaders(json = true) {
      const h = { 'x-user-email': Session.actor() };
      if (json) h['content-type'] = 'application/json';
      return h;
    }

    // -----------------------------------------------------------------------
    // Public entry point
    // -----------------------------------------------------------------------
    async function render() {
      const host = document.getElementById('sap-interface-host');
      if (!host) return;
      await _reload();
    }

    // Fetch /objects, then paint the console. Used on first load + after every write.
    async function _reload() {
      const host = document.getElementById('sap-interface-host');
      if (!host) return;
      try {
        const data = await Util.fetchTraced(`${API}/sap/interface/objects`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        _objects = data.objects || [];
        if (!_selected || !_objects.some(o => o.object_key === _selected)) {
          _selected = _objects.length ? _objects[0].object_key : null;
        }
        _paint();
      } catch (e) {
        host.innerHTML = `<div class="sap-empty"><div class="sap-empty-ico">⚠</div>`
          + `<div class="sap-empty-t">${_esc(t('ui.sap_load_failed'))}</div>`
          + `<div class="sap-empty-d">${_esc(e.message)}</div></div>`;
        ErrorLog.error('sap-interface', `Load objects failed: ${e.message}`);
      }
    }

    // Rebuild the whole console from cached _objects (no fetch).
    function _paint() {
      const host = document.getElementById('sap-interface-host');
      if (!host) return;
      host.innerHTML = `
        <div class="sap-pagehead">
          <div>
            <div class="sap-pagehead-title"><h2>${_esc(t('tab.interface'))}</h2>
              <span class="sap-flow">SAP ECC <b>━▶</b> NIMBUS</span></div>
            <div class="sap-pagehead-sub">${_esc(t('ui.sap_subtitle'))}</div>
          </div>
          <span class="sap-mode-chip"><span class="admin-health-dot"></span> ${_esc(t('ui.sap_stub_mode'))}</span>
        </div>
        ${_renderRibbon()}
        <div class="sap-console">
          <div id="sap-rail"></div>
          <div id="sap-detail"></div>
        </div>`;
      host.querySelectorAll('[data-jump]').forEach(tile => tile.addEventListener('click', () => {
        const j = tile.dataset.jump;
        if (j === 'errors') { const eo = _objects.find(o => o.last_run && o.last_run.status === 'error'); if (eo) _selected = eo.object_key; }
        else if (j === 'last' && _lastNewestKey) { _selected = _lastNewestKey; }
        _tab = 'history'; _renderRail(); _renderDetail();
      }));
      _renderRail();
      _renderDetail();
    }

    function _renderRibbon() {
      const enabled = _objects.filter(o => o.enabled).length;
      let newest = null, newestObj = null;
      _objects.forEach(o => {
        const lr = o.last_run;
        if (lr && lr.started_at && (!newest || new Date(lr.started_at) > new Date(newest.started_at))) { newest = lr; newestObj = o; }
      });
      _lastNewestKey = newestObj ? newestObj.object_key : null;
      const errs = _objects.filter(o => o.last_run && o.last_run.status === 'error').length;
      const tile = (k, v, d, cls, act) =>
        `<div class="kpi-tile${cls ? ' ' + cls : ''}${act ? ' is-actionable' : ''}"${act ? ` data-jump="${act}"` : ''}>`
        + `<div class="k">${_esc(k)}</div><div class="v">${v}</div><div class="d">${_esc(d)}</div></div>`;
      const lastV = newest ? `<span class="sap-v-sm">${_esc(_relTime(newest.started_at))}</span>` : '—';
      const lastD = newest ? `${newestObj.label} · ${newest.triggered_by || 'manual'}` : 'no runs yet';
      const rowsV = newest ? Number(newest.rows_read || 0).toLocaleString() : '0';
      const rowsD = newest ? `+${newest.rows_inserted ?? 0} ins / ~${newest.rows_updated ?? 0} upd` : '—';
      return `<div class="sap-ribbon">
        ${tile(t('ui.sap_kpi_connection'), 'Stub', 'connectors not live', 'warn', '')}
        ${tile(t('ui.sap_kpi_objects'), `${enabled} <span class="sap-frac">/ ${_objects.length}</span>`, enabled ? `${_objects.length - enabled} awaiting setup` : 'none enabled', enabled ? '' : 'warn', '')}
        ${tile(t('ui.sap_kpi_last_activity'), lastV, lastD, '', newest ? 'last' : '')}
        ${tile(t('ui.sap_kpi_rows'), rowsV, rowsD, '', '')}
        ${tile(t('ui.sap_kpi_errors'), String(errs), errs ? 'most recent run failed' : 'no failures', errs ? 'err' : '', errs ? 'errors' : '')}
      </div>`;
    }

    // -----------------------------------------------------------------------
    // Object rail (master) + detail shell (Overview / Mapping / History tabs)
    // -----------------------------------------------------------------------
    function _renderRail() {
      const el = document.getElementById('sap-rail');
      if (!el) return;
      const rows = _objects.map(o => {
        const sel = o.object_key === _selected ? ' sap-rail-row-sel' : '';
        const lr = o.last_run;
        const dotCls = !lr ? '' : (lr.status === 'ok' ? 'ok' : (lr.status === 'error' ? 'err' : (lr.status === 'running' ? 'warn' : '')));
        const statusTxt = !lr ? t('ui.sap_never_run')
          : (lr.status === 'ok' ? `ok · ${_relTime(lr.started_at)}`
          : (lr.status === 'error' ? `failed · ${_relTime(lr.started_at)}` : lr.status));
        const kind = o.kind || 'master';
        return `<div class="sap-rail-row${sel}" data-obj="${_esc(o.object_key)}">
          <span class="admin-health-dot ${dotCls}"></span>
          <div class="sap-rail-main">
            <div class="sap-rail-name">${_esc(o.label || o.object_key)} <span class="sap-kind sap-kind-${_esc(kind)}">${_esc(kind)}</span></div>
            <div class="sap-rail-meta">${_esc(o.object_key)} · ${_esc(o.transport || 'file_drop')}</div>
            <div class="sap-rail-status">${_esc(statusTxt)}</div>
          </div>
          <label class="cal-day-toggle-wrap sap-railsw" title="${_esc(t('ui.sap_enabled'))}">
            <input type="checkbox" data-enable="${_esc(o.object_key)}" ${o.enabled ? 'checked' : ''}>
            <span class="cal-toggle-track"></span><span class="cal-toggle-thumb"></span>
          </label>
        </div>`;
      }).join('');
      el.innerHTML = `<div class="panel">
        <div class="panel-head"><span class="sap-section-label">${_esc(t('ui.sap_objects'))}</span>
          <span class="sap-hint">${_objects.filter(o => o.enabled).length} / ${_objects.length}</span></div>
        <div class="sap-rail">${rows}</div></div>`;
      el.querySelectorAll('[data-obj]').forEach(r =>
        r.addEventListener('click', () => { _selected = r.dataset.obj; _testResult = null; _renderRail(); _renderDetail(); }));
      el.querySelectorAll('[data-enable]').forEach(cb => {
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => _saveConfig(cb.dataset.enable, { enabled: cb.checked }, cb.checked ? t('toast.sap_enable_note') : null));
      });
    }

    function _renderDetail() {
      const el = document.getElementById('sap-detail');
      if (!el) return;
      const o = _objects.find(x => x.object_key === _selected);
      if (!o) { el.innerHTML = ''; return; }
      const kind = o.kind || 'master';
      const tabBtn = (id, label) => `<button class="sap-tab${_tab === id ? ' sap-tab-active' : ''}" data-tab="${id}">${_esc(label)}</button>`;
      el.innerHTML = `<div class="panel">
        <div class="sap-detail-head">
          <span class="sap-detail-name">${_esc(o.label || o.object_key)}</span>
          <span class="sap-kind sap-kind-${_esc(kind)}">${_esc(kind)}</span>
          <span class="sap-detail-key">${_esc(o.object_key)}</span>
          <div class="sap-detail-actions">
            <button class="btn btn-sm" data-act="dry">${_esc(t('ui.sap_dry_run'))}</button>
            <button class="btn btn-sm btn-primary" data-act="run">${_esc(t('ui.sap_run_now'))} ▸</button>
          </div>
        </div>
        <div class="sap-tabs">${tabBtn('overview', t('ui.sap_overview'))}${tabBtn('mapping', t('ui.sap_mapping'))}${tabBtn('history', t('ui.sap_history'))}</div>
        <div class="sap-tabbody" id="sap-tabbody"><div class="md-loading">${_esc(t('ui.loading'))}</div></div>
      </div>`;
      el.querySelectorAll('[data-tab]').forEach(b =>
        b.addEventListener('click', () => { _tab = b.dataset.tab; _renderDetail(); }));
      el.querySelectorAll('[data-act]').forEach(b =>
        b.addEventListener('click', () => _runNow(o.object_key, b.dataset.act === 'dry', b)));
      if (_tab === 'overview') _renderOverview(o);
      else if (_tab === 'mapping') _renderMapping(o);
      else _renderHistory(o);
    }

    function _relTime(ts) {
      if (!ts) return '—';
      const d = new Date(ts); if (isNaN(d.getTime())) return String(ts);
      let s = Math.floor((Date.now() - d.getTime()) / 1000); if (s < 0) s = 0;
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    }

    function _cronProse(c) {
      if (!c) return null;
      const p = c.trim().split(/\s+/); if (p.length !== 5) return null;
      const mi = p[0], ho = p[1], dom = p[2], mon = p[3];
      const pad = x => (x === '*' ? '00' : (x.length < 2 ? '0' + x : x));
      if (dom === '*' && mon === '*' && p[4] === '*' && ho !== '*' && mi !== '*') return `Every day at ${pad(ho)}:${pad(mi)}`;
      if (mi.indexOf('*/') === 0) return `Every ${mi.slice(2)} minutes`;
      if (ho.indexOf('*/') === 0 && dom === '*') return `Every ${ho.slice(2)} hours`;
      return null;
    }

    // -----------------------------------------------------------------------
    // Overview tab — transport config, secret indicator, schedule, checklist
    // -----------------------------------------------------------------------
    async function _renderOverview(o) {
      const body = document.getElementById('sap-tabbody');
      if (!body) return;
      let cfg = _config[o.object_key];
      if (!cfg) {
        try {
          cfg = await Util.fetchTraced(`${API}/sap/interface/config/${encodeURIComponent(o.object_key)}`).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          });
          _config[o.object_key] = cfg;
        } catch {
          cfg = { transport: o.transport, source_params: {}, has_secret: false, schedule_cron: o.schedule_cron };
        }
      }
      // bail if the user switched object/tab while awaiting
      if (document.getElementById('sap-tabbody') !== body || _tab !== 'overview' || _selected !== o.object_key) return;

      const transport = cfg.transport || o.transport || 'file_drop';
      const cron = cfg.schedule_cron != null ? cfg.schedule_cron : (o.schedule_cron || '');
      const prose = _cronProse(cron);
      const lr = o.last_run;
      const errBanner = (lr && lr.status === 'error')
        ? `<div class="sap-banner sap-banner-err"><span class="sap-banner-ico">⚠</span><div><b>${_esc(t('ui.sap_last_failed'))} ${_esc(_relTime(lr.started_at))}</b><div class="sap-mono">${_esc(lr.error || '')}</div></div></div>`
        : '';
      const secret = cfg.has_secret
        ? `<div class="sap-chipline"><span class="admin-health-dot ok"></span> ${_esc(t('ui.sap_credential_present'))}</div>`
        : `<div class="sap-chipline"><span class="admin-health-dot warn"></span> ${_esc(t('ui.sap_no_credential'))}</div>`;
      const activeMaps = (_mapState[o.object_key]?.rows || []).filter(m => m.active && m.sap_field && m.nimbus_column).length;
      const steps = [
        ['01', t('ui.sap_step_transport'), true],
        ['02', t('ui.sap_step_map'), activeMaps > 0],
        ['03', t('ui.sap_step_enable'), o.enabled && !!cron],
        ['04', t('ui.sap_step_test'), false],
        ['05', t('ui.sap_step_dryrun'), !!(lr && lr.triggered_by === 'dry-run')],
        ['06', t('ui.sap_step_first'), !!(lr && lr.status === 'ok' && (lr.rows_inserted || 0) > 0)],
      ];
      const checklist = steps.map(s =>
        `<div class="sap-check-step${s[2] ? ' done' : ''}"><span class="sap-check-n">${s[0]}</span><span class="sap-check-mark">${s[2] ? '✓' : ''}</span><span class="sap-check-t">${_esc(s[1])}</span></div>`).join('');
      const tr = _testResult;
      const testStrip = tr
        ? `<div class="sap-test-strip ${tr.cls}"><span class="admin-health-dot ${tr.dot || ''}"></span> ${_esc(tr.msg)}</div>`
        : `<div class="sap-test-strip"><span class="admin-health-dot"></span> ${_esc(t('ui.sap_not_tested'))}</div>`;

      body.innerHTML = `${errBanner}
        <div class="sap-ov-grid">
          <div>
            <div class="sap-section-label">${_esc(t('ui.sap_connection_section'))}</div>
            <div class="sap-field"><label>${_esc(t('ui.sap_transport'))}</label>
              <select id="sap-transport-sel">${TRANSPORTS.map(tp => `<option${tp === transport ? ' selected' : ''}>${tp}</option>`).join('')}</select></div>
            <div id="sap-transport-fields">${_transportFieldsHTML(transport, cfg.source_params || {})}</div>
            <div class="sap-secretbox">${secret}<div class="sap-secret-note">${_esc(t('ui.sap_secret_note'))}</div></div>
            <div class="sap-test-row"><button class="btn" id="sap-test-btn">${_esc(t('ui.sap_test_connection'))}</button></div>
            ${testStrip}
          </div>
          <div>
            <div class="sap-section-label">${_esc(t('ui.sap_schedule_section'))}</div>
            <div class="sap-field"><label>${_esc(t('ui.sap_cron'))}</label>
              <input class="sap-mono" id="sap-cron-input" value="${_esc(cron)}" placeholder="— — — — —">
              ${prose ? `<div class="sap-cron-prose">${_esc(prose)}<span class="sap-cron-raw">${_esc(cron)}</span></div>` : `<div class="sap-help">${_esc(t('ui.sap_not_scheduled'))}</div>`}</div>
            <div class="sap-banner sap-banner-info"><span class="sap-banner-ico">ℹ</span><div>${_esc(t('ui.sap_scheduler_note_a'))} <span class="sap-mono">NIMBUS_SAP_SYNC_ENABLED=1</span> ${_esc(t('ui.sap_scheduler_note_b'))}</div></div>
            <div class="sap-section-label">${_esc(t('ui.sap_delta_section'))}</div>
            <div class="sap-kv"><span>${_esc(t('ui.sap_last_watermark'))}</span><span class="sap-mono">${_esc(cfg.last_watermark || '— (full load)')}</span></div>
          </div>
          <div class="sap-ov-full">
            <div class="sap-section-label">${_esc(t('ui.sap_checklist'))}</div>
            <div class="sap-check">${checklist}</div>
          </div>
        </div>`;

      document.getElementById('sap-transport-sel')?.addEventListener('change', e => {
        _config[o.object_key] = { ...(_config[o.object_key] || {}), transport: e.target.value };
        _testResult = null;
        _saveConfig(o.object_key, { transport: e.target.value }, null);
      });
      document.getElementById('sap-cron-input')?.addEventListener('change', e =>
        _saveConfig(o.object_key, { schedule_cron: e.target.value.trim() || null }, null));
      document.getElementById('sap-test-btn')?.addEventListener('click', () => _testConnection(o.object_key, transport));
    }

    function _transportFieldsHTML(transport, params) {
      const fields = TRANSPORT_FIELDS[transport] || [];
      if (!fields.length) return '';
      return fields.map(f =>
        `<div class="sap-field"><label>${_esc(f[1])}</label><input class="sap-mono" data-param="${_esc(f[0])}" value="${_esc(params[f[0]] != null ? params[f[0]] : '')}" placeholder="${_esc(f[2])}" spellcheck="false"></div>`).join('');
    }

    async function _testConnection(object, transport) {
      const params = {};
      document.querySelectorAll('#sap-transport-fields [data-param]').forEach(inp => {
        if (inp.value.trim()) params[inp.dataset.param] = inp.value.trim();
      });
      _testResult = { cls: 'info', dot: '', msg: t('ui.sap_testing') };
      _renderDetail();
      try {
        const res = await fetch(`${API}/sap/interface/test-connection`, {
          method: 'POST', headers: _writeHeaders(),
          body: JSON.stringify({ transport, source_params: params }),
        }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
        _testResult = res.ok
          ? { cls: 'ok', dot: 'ok', msg: `${t('toast.sap_conn_ok')} — ${res.detail || ''}`.trim() }
          : { cls: 'info', dot: '', msg: res.detail || t('toast.sap_conn_fail') };
      } catch (e) {
        _testResult = { cls: 'err', dot: 'err', msg: `${t('toast.sap_conn_fail')} — ${e.message}` };
        ErrorLog.error('sap-interface', `Test connection failed: ${e.message}`);
      }
      if (_tab === 'overview' && _selected === object) _renderDetail();
    }

    async function _saveConfig(object, patch, confirmMsg) {
      try {
        await fetch(`${API}/sap/interface/config/${encodeURIComponent(object)}`, {
          method: 'POST', headers: _writeHeaders(), body: JSON.stringify(patch),
        }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
        if (_config[object]) _config[object] = { ...(_config[object]), ...patch };
        if (confirmMsg) Toast.show(confirmMsg, 'info');
        await _reload();
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('sap-interface', `Config save failed for ${object}: ${e.message}`);
        await _reload();
      }
    }

    async function _runNow(object, dryRun, btn) {
      if (btn) btn.disabled = true;
      try {
        const res = await fetch(`${API}/sap/interface/sync/${encodeURIComponent(object)}`, {
          method: 'POST', headers: _writeHeaders(), body: JSON.stringify({ dry_run: !!dryRun }),
        }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
        if (res.status === 'ok') {
          Toast.show(`${dryRun ? t('toast.sap_dryrun_done') : t('toast.sap_sync_done')} (read ${res.rows_read ?? 0} · +${res.rows_inserted ?? 0} / ~${res.rows_updated ?? 0})`, 'success');
        } else {
          Toast.show(`${t('toast.sap_sync_failed')}: ${res.error || ''}`.trim(), 'error', 6000);
        }
        await _reload();
      } catch (e) {
        Toast.show(`${t('toast.sap_sync_failed')}: ${e.message}`, 'error');
        ErrorLog.error('sap-interface', `Sync failed for ${object}: ${e.message}`);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    // -----------------------------------------------------------------------
    // Mapping tab — SAP field ━▶ transform ━▶ NIMBUS column flow editor
    // -----------------------------------------------------------------------
    async function _renderMapping(o) {
      const body = document.getElementById('sap-tabbody');
      if (!body) return;
      if (!_mapState[o.object_key]) {
        body.innerHTML = `<div class="md-loading">${_esc(t('ui.loading'))}</div>`;
        try {
          const data = await Util.fetchTraced(`${API}/sap/interface/mappings/${encodeURIComponent(o.object_key)}`).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          });
          _mapState[o.object_key] = {
            rows: (data.mappings || []).map(m => ({
              sap_field: m.sap_field || '', nimbus_column: m.nimbus_column || '',
              transform: m.transform || 'none', active: m.active !== false,
            })),
            dirty: false,
          };
        } catch (e) {
          body.innerHTML = `<div class="sap-empty"><div class="sap-empty-t">${_esc(t('ui.sap_map_load_failed'))}</div><div class="sap-empty-d">${_esc(e.message)}</div></div>`;
          ErrorLog.error('sap-interface', `Load mappings failed for ${o.object_key}: ${e.message}`);
          return;
        }
      }
      if (document.getElementById('sap-tabbody') !== body || _tab !== 'mapping' || _selected !== o.object_key) return;
      _drawMapping(o);
    }

    function _drawMapping(o) {
      const body = document.getElementById('sap-tabbody');
      const st = _mapState[o.object_key];
      if (!body || !st) return;
      const isMaster = (o.kind || 'master') === 'master';
      const keys = MASTER_KEYS[o.object_key] || [];
      const rails = `<div class="sap-flow-rails"><span class="sap-fr">▤ ${_esc(t('ui.sap_field'))}</span><span class="sap-fr c">${_esc(t('ui.sap_transform'))}</span><span class="sap-fr r">${_esc(t('ui.sap_nimbus_column'))} ◆</span></div>`;

      if (!st.rows.length) {
        body.innerHTML = `${isMaster ? _keystrip(o, st) : ''}
          <div class="sap-banner sap-banner-info"><span class="sap-banner-ico">→</span><div>${isMaster ? _esc(t('ui.sap_map_primer_master')) : _esc(t('ui.sap_map_primer_orders'))}</div></div>
          ${rails}
          <div class="sap-ghost-row"><div class="sap-ghost-node">SAP field</div><div class="sap-ghost-mid">transform</div><div class="sap-ghost-node">nimbus_column</div></div>
          <div class="sap-map-actions"><button class="btn btn-sm" id="sap-add-map">+ ${_esc(t('ui.sap_add_first'))}</button></div>`;
        document.getElementById('sap-add-map')?.addEventListener('click', () => { st.rows.push({ sap_field: '', nimbus_column: '', transform: 'none', active: true }); st.dirty = true; _drawMapping(o); });
        return;
      }

      const rows = st.rows.map((m, i) => {
        const isKey = isMaster && keys.indexOf(m.nimbus_column) > -1;
        const opts = TRANSFORMS.map(tr => `<option${tr === m.transform ? ' selected' : ''}>${tr}</option>`).join('');
        return `<div class="sap-map-row${m.active ? '' : ' inactive'}" style="animation-delay:${i * 55}ms">
          <input class="sap-node sap-node-sap" data-idx="${i}" data-f="sap_field" value="${_esc(m.sap_field)}" placeholder="SAP field" spellcheck="false">
          <span class="sap-wire"><span class="sap-wire-fill" style="animation-delay:${i * 55}ms"></span></span>
          <span class="sap-xform-wrap${m.transform === 'none' ? ' none' : ''}"><select class="sap-xform${m.transform === 'none' ? ' none' : ''}" data-idx="${i}" data-f="transform">${opts}</select><span class="sap-xform-hint">${_esc(XHINT[m.transform] || '')}</span></span>
          <span class="sap-node-wrap"><input class="sap-node sap-node-nimbus${isKey ? ' key' : ''}" data-idx="${i}" data-f="nimbus_column" value="${_esc(m.nimbus_column)}" placeholder="nimbus_column" spellcheck="false">${isKey ? '<span class="sap-keytag" title="Key column">🔑</span>' : ''}</span>
          <span class="sap-row-tools"><label class="cal-day-toggle-wrap sap-rowsw" title="${_esc(t('ui.sap_active'))}"><input type="checkbox" data-idx="${i}" data-f="active" ${m.active ? 'checked' : ''}><span class="cal-toggle-track"></span><span class="cal-toggle-thumb"></span></label><button class="sap-icon-btn danger" data-del="${i}" title="Remove">🗑</button></span>
        </div>`;
      }).join('');

      let guard = '', blocked = false;
      if (isMaster && keys.length) {
        const missing = keys.filter(k => !st.rows.some(m => m.nimbus_column === k && m.active));
        blocked = missing.length > 0;
        guard = _keystrip(o, st);
        if (blocked) {
          guard += `<div class="sap-banner sap-banner-err"><span class="sap-banner-ico">⚠</span><div><b>${_esc(o.label || o.object_key)} ${_esc(t('ui.sap_upsert_fail'))}</b> ${_esc(t('ui.sap_key_missing'))} <span class="sap-mono">${missing.map(_esc).join(', ')}</span>.</div></div>`;
        }
      } else if (!isMaster) {
        guard = `<div class="sap-help" style="margin-bottom:12px"><span class="sap-mono">production_order</span> ${_esc(t('ui.sap_orders_identity'))}</div>`;
      }

      body.innerHTML = `${guard}${rails}<div class="sap-flow">${rows}</div>
        <div class="sap-map-actions">
          <button class="btn btn-sm" id="sap-add-map">+ ${_esc(t('ui.sap_add_mapping'))}</button>
          <span class="sap-spacer"></span>
          ${st.dirty ? `<span class="sap-dirty">${_esc(t('ui.sap_unsaved'))}</span>` : ''}
          <button class="btn btn-sm btn-primary" id="sap-save-map"${blocked ? ` disabled title="${_esc(t('ui.sap_resolve_keys'))}"` : ''}>${_esc(t('ui.sap_save_mappings'))}</button>
        </div>`;

      body.querySelectorAll('[data-f]').forEach(inp => {
        const isText = inp.tagName === 'INPUT' && inp.type === 'text';
        const update = () => {
          const row = st.rows[+inp.dataset.idx]; if (!row) return;
          row[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.value;
          st.dirty = true;
        };
        if (isText) { inp.addEventListener('input', update); inp.addEventListener('change', () => { update(); _drawMapping(o); }); }
        else { inp.addEventListener('change', () => { update(); _drawMapping(o); }); }
      });
      body.querySelectorAll('[data-del]').forEach(b =>
        b.addEventListener('click', () => { st.rows.splice(+b.dataset.del, 1); st.dirty = true; _drawMapping(o); }));
      document.getElementById('sap-add-map')?.addEventListener('click', () => { st.rows.push({ sap_field: '', nimbus_column: '', transform: 'none', active: true }); st.dirty = true; _drawMapping(o); });
      document.getElementById('sap-save-map')?.addEventListener('click', () => _saveMappings(o.object_key));
    }

    function _keystrip(o, st) {
      const keys = MASTER_KEYS[o.object_key] || [];
      if (!keys.length) return '';
      const chips = keys.map(k => {
        const ok = st.rows.some(m => m.nimbus_column === k && m.active);
        return `<span class="sap-keychip${ok ? '' : ' miss'}"><span class="admin-health-dot ${ok ? 'ok' : 'err'}"></span>${_esc(k)}${ok ? '' : ` <span class="sap-req">${_esc(t('ui.sap_required'))}</span>`}</span>`;
      }).join('');
      return `<div class="sap-keystrip"><span class="sap-ks-label">${_esc(t('ui.sap_key_columns'))}</span>${chips}</div>`;
    }

    async function _saveMappings(object) {
      const st = _mapState[object];
      if (!st) return;
      const mappings = st.rows
        .filter(m => m.sap_field.trim() && m.nimbus_column.trim())
        .map((m, i) => ({ sap_field: m.sap_field.trim(), nimbus_column: m.nimbus_column.trim(), transform: m.transform || 'none', active: m.active !== false, field_order: i }));
      try {
        await fetch(`${API}/sap/interface/mappings/${encodeURIComponent(object)}`, {
          method: 'POST', headers: _writeHeaders(), body: JSON.stringify({ mappings }),
        }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
        delete _mapState[object];
        Toast.show(t('toast.sap_mappings_saved'), 'success');
        await _reload();
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('sap-interface', `Save mappings failed for ${object}: ${e.message}`);
      }
    }

    // -----------------------------------------------------------------------
    // History tab — run timeline (status, counts, duration, watermark, errors)
    // -----------------------------------------------------------------------
    async function _renderHistory(o) {
      const body = document.getElementById('sap-tabbody');
      if (!body) return;
      body.innerHTML = `<div class="md-loading">${_esc(t('ui.loading'))}</div>`;
      try {
        const params = new URLSearchParams({ limit: '50', object: o.object_key });
        const data = await Util.fetchTraced(`${API}/sap/interface/runs?${params.toString()}`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        if (document.getElementById('sap-tabbody') !== body || _tab !== 'history' || _selected !== o.object_key) return;
        const runs = data.runs || [];
        if (!runs.length) {
          body.innerHTML = `<div class="sap-empty"><div class="sap-empty-ico">◍</div><div class="sap-empty-t">${_esc(t('ui.sap_no_runs'))}</div><div class="sap-empty-d">${_esc(t('ui.sap_no_runs_hint'))}</div><button class="btn btn-sm" data-act-empty="dry">${_esc(t('ui.sap_dry_run'))}</button></div>`;
          body.querySelector('[data-act-empty]')?.addEventListener('click', () => _runNow(o.object_key, true, null));
          return;
        }
        body.innerHTML = `<div class="sap-feed">${runs.map((rn, i) => _runRow(rn, i)).join('')}</div>`;
        body.querySelectorAll('[data-exp]').forEach(b =>
          b.addEventListener('click', () => b.closest('.sap-run').classList.toggle('open')));
      } catch (e) {
        body.innerHTML = `<div class="sap-empty"><div class="sap-empty-t">${_esc(t('ui.sap_runs_load_failed'))}</div><div class="sap-empty-d">${_esc(e.message)}</div></div>`;
        ErrorLog.error('sap-interface', `Load runs failed: ${e.message}`);
      }
    }

    function _runRow(rn, i) {
      const status = rn.status || 'unknown';
      const cls = status === 'ok' ? 'ok' : (status === 'error' ? 'err' : 'info');
      const pill = status === 'ok' ? '<span class="sap-pill ok">ok</span>'
        : (status === 'error' ? '<span class="sap-pill err">error</span>' : `<span class="sap-pill info">${_esc(status)}</span>`);
      const dur = _dur(rn.started_at, rn.ended_at);
      const counts = `read ${rn.rows_read ?? 0} · <span class="ins">+${rn.rows_inserted ?? 0} ins</span> / <span class="upd">~${rn.rows_updated ?? 0} upd</span> / <span class="fail">!${rn.rows_failed ?? 0} fail</span>`;
      const wm = (rn.watermark_before || rn.watermark_after)
        ? `<div class="sap-run-wm">watermark ${_esc(rn.watermark_before || '∅')} → ${_esc(rn.watermark_after || '∅')}</div>` : '';
      const err = rn.error
        ? `<div class="sap-run-err"><button class="sap-exp" data-exp="${i}">view error ▾</button><pre>${_esc(rn.error)}</pre></div>` : '';
      return `<div class="sap-run ${cls}"><div class="sap-run-head">${pill}<span class="sap-run-t">${_esc(_fmtTs(rn.started_at))}</span><span class="sap-run-by">${_esc(rn.triggered_by || 'manual')}</span>${dur ? `<span class="sap-run-dur">${_esc(dur)}</span>` : ''}</div><div class="sap-run-counts">${counts}</div>${wm}${err}</div>`;
    }

    function _dur(a, b) {
      if (!a || !b) return '';
      const d = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
      if (isNaN(d) || d < 0) return '';
      if (d < 1) return `${Math.round(d * 1000)}ms`;
      if (d < 60) return `${d.toFixed(1)}s`;
      return `${Math.floor(d / 60)}m ${Math.round(d % 60)}s`;
    }

    function _fmtTs(ts) {
      if (!ts) return '—';
      try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return String(ts);
        return Util.fmtDTReadable ? Util.fmtDTReadable(d) : d.toLocaleString();
      } catch { return String(ts); }
    }

    return { render };
  })();

  /* =============================================================================
     SECURITY — admin sub-tab: user accounts (username / role / password) and
     role-based plant assignment (roles + role_plants). Same self-contained,
     paint-into-one-host-div idiom as Interface: private state, a public
     render() entry point, an internal 'users' | 'roles' tab, full re-render on
     every tab switch and on every write (mirrors Interface's _saveConfig: try
     the write, Toast+log on failure, then unconditionally reload+repaint from
     the server either way). Backend: /security/users(+/bulk, +/{username}/
     reset-password) for accounts (auth.py); the generic /master-data/roles
     and /master-data/role_plants (+/bulk) for roles and their plant scoping
     (master_data.py) — this module only renders and posts, never touches
     password hashes beyond the single write they're submitted in.
     ========================================================================== */
  const Security = (() => {
    const API = Config.API_BASE;

    let _tab = 'users';              // active top-level tab: 'users' | 'roles'

    // ---- Users tab state ----
    let _users = [];                 // last GET /security/users .users: [{username,role,has_password}]
    let _usersSearch = '';           // current server-side search query
    let _roleOptions = [];           // role names for the Role <select> (from GET /master-data/roles)
    let _staged = [];                // rows staged via "Paste rows", not yet saved: [{username, role}]
    const _pwOpen = new Set();       // usernames with an open inline password-reveal row
    const _nameSaveTimers = new Map(); // username -> pending debounce timeout id

    // ---- Roles tab state ----
    let _roles = [];                 // GET /master-data/roles rows: [{role, description}]
    let _rolePlants = [];            // GET /master-data/role_plants rows: [{role, plant}]
    let _rolesInUse = new Set();     // role names currently assigned to >=1 user (best-effort; disables delete)
    let _selectedRole = null;

    const _esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function _writeHeaders(json = true) {
      const h = { 'x-user-email': Session.actor() };
      if (json) h['content-type'] = 'application/json';
      return h;
    }

    function _postJSON(url, body) {
      return fetch(url, { method: 'POST', headers: _writeHeaders(), body: JSON.stringify(body) })
        .then(r => {
          if (!r.ok) {
            // A 403 here means the backend admin gate rejected us though the UI
            // believed we were admin (stale cached role). Reconcile + prompt
            // re-auth instead of only bubbling a raw error to the caller.
            if (r.status === 403) { try { Session.onAuthDenied(); } catch {} }
            return r.json().catch(() => ({})).then(e => {
              const err = new Error(e.detail || `HTTP ${r.status}`);
              err.status = r.status;
              throw err;
            });
          }
          return r.json();
        });
    }

    const _debouncedUserSearch = Util.debounce(() => _reloadUsers(), 300);

    // -----------------------------------------------------------------------
    // Public entry point
    // -----------------------------------------------------------------------
    async function render() {
      const host = document.getElementById('security-host');
      if (!host) return;
      _paintShell();
      await _loadActiveTab();
    }

    function _paintShell() {
      const host = document.getElementById('security-host');
      if (!host) return;
      const tabBtn = (id, label) => `<button class="sap-tab${_tab === id ? ' sap-tab-active' : ''}" data-tab="${id}">${_esc(label)}</button>`;
      host.innerHTML = `
        <div class="sap-pagehead">
          <div><div class="sap-pagehead-title"><h2>${_esc(t('tab.security'))}</h2></div></div>
        </div>
        <div class="sap-tabs">${tabBtn('users', t('tab.security_users'))}${tabBtn('roles', t('tab.security_roles'))}</div>
        <div id="security-tabbody"><div class="md-loading">${_esc(t('ui.loading'))}</div></div>`;
      host.querySelectorAll('[data-tab]').forEach(b =>
        b.addEventListener('click', () => { _tab = b.dataset.tab; _paintShell(); _loadActiveTab(); }));
    }

    function _loadActiveTab() {
      return _tab === 'users' ? _reloadUsers() : _reloadRoles();
    }

    // -----------------------------------------------------------------------
    // USERS tab
    // -----------------------------------------------------------------------
    async function _reloadUsers() {
      const body = document.getElementById('security-tabbody');
      try {
        const q = _usersSearch.trim();
        const usersUrl = `${API}/security/users` + (q ? `?search=${encodeURIComponent(q)}` : '');
        const [usersData, rolesData] = await Promise.all([
          Util.fetchTraced(usersUrl).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
          Util.fetchTraced(`${API}/master-data/roles`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        ]);
        _users = usersData.users || [];
        _roleOptions = [...new Set((rolesData.rows || []).map(r => r.role).filter(Boolean))].sort();
        if (_tab !== 'users') return; // bail if the admin switched tabs while awaiting
        _renderUsersTab();
      } catch (e) {
        const is403 = e.status === 403 || /\b403\b/.test(e.message || '');
        // Stale-admin 403 (the /master-data/roles half of the Promise.all is
        // ungated, so a 403 here is from /security/users): reconcile + re-auth.
        if (is403) { try { Session.onAuthDenied(); } catch {} }
        if (body) body.innerHTML = `<div class="md-empty">${_esc(is403 ? t('sec.access_revoked') : t('sec.load_users_failed', { msg: e.message }))}</div>`;
        ErrorLog.error('security', `Load users failed: ${e.message}`);
      }
    }

    function _renderUsersTab() {
      const body = document.getElementById('security-tabbody');
      if (!body) return;
      // Preserve the search box's focus/caret across the re-render a debounced
      // keystroke-driven reload causes (captured synchronously, not via
      // focus/blur listeners, since replacing innerHTML can race those).
      const hadFocus = document.activeElement && document.activeElement.id === 'sec-user-search';
      const caret = hadFocus ? document.activeElement.selectionStart : null;
      body.innerHTML = _usersShellHtml();
      _wireUsersShell();
      _renderUsersRows();
      _renderUsersActions();
      if (hadFocus) {
        const search = document.getElementById('sec-user-search');
        if (search) {
          search.focus();
          const pos = caret ?? search.value.length;
          search.setSelectionRange(pos, pos);
        }
      }
    }

    function _usersShellHtml() {
      return `
        <div class="panel">
          <div class="md-toolbar">
            <input type="search" class="input md-search" id="sec-user-search" placeholder="${_esc(t('sec.search_users_ph'))}" value="${_esc(_usersSearch)}">
            <span class="spacer"></span>
            <button class="btn btn-ghost sm" id="sec-paste-users" title="${_esc(t('tip.paste_rows'))}">${_esc(t('btn.paste_rows'))}</button>
            <span id="sec-users-actions" style="display:inline-flex;gap:8px;align-items:center"></span>
          </div>
          <div style="display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);align-items:center;flex-wrap:wrap">
            <input type="text" class="input" id="sec-new-username" placeholder="${_esc(t('sec.username_ph'))}" style="flex:1;min-width:120px">
            <input type="text" class="input" id="sec-new-firstname" placeholder="${_esc(t('sec.first_name_ph'))}" maxlength="100" style="flex:1;min-width:100px">
            <input type="text" class="input" id="sec-new-lastname" placeholder="${_esc(t('sec.last_name_ph'))}" maxlength="100" style="flex:1;min-width:100px">
            ${_roleSelectHtml('', 'id="sec-new-role-select"')}
            <input type="password" class="input" id="sec-new-password" placeholder="${_esc(t('sec.new_password_ph'))}" autocomplete="new-password" style="flex:1;min-width:120px">
            <button class="btn btn-primary sm" id="sec-add-user-btn">${_esc(t('sec.add_user'))}</button>
          </div>
          <div class="md-table-wrap">
            <table class="md-table">
              <thead><tr>
                <th class="md-th">${_esc(t('sec.username'))}</th>
                <th class="md-th">${_esc(t('sec.first_name'))}</th>
                <th class="md-th">${_esc(t('sec.last_name'))}</th>
                <th class="md-th">${_esc(t('sec.role'))}</th>
                <th class="md-th">${_esc(t('sec.password'))}</th>
                <th class="md-th"></th>
              </tr></thead>
              <tbody id="sec-users-tbody"></tbody>
            </table>
          </div>
        </div>`;
    }

    function _wireUsersShell() {
      const search = document.getElementById('sec-user-search');
      if (search) {
        search.addEventListener('input', () => { _usersSearch = search.value; _debouncedUserSearch(); });
      }
      document.getElementById('sec-paste-users')?.addEventListener('click', _pasteUsers);
      document.getElementById('sec-add-user-btn')?.addEventListener('click', _addUser);
    }

    function _renderUsersActions() {
      const el = document.getElementById('sec-users-actions');
      if (!el) return;
      el.innerHTML = _staged.length
        ? `<span class="md-dirty-badge">${_esc(t('ui.unsaved_badge', { count: _staged.length }))}</span>
           <button class="btn btn-primary sm" id="sec-save-staged">${_esc(t('sec.save_changes'))}</button>`
        : '';
      document.getElementById('sec-save-staged')?.addEventListener('click', _saveStaged);
    }

    // extraAttrs is a caller-built, already-escaped attribute string (id="..." or data-x="...").
    function _roleSelectHtml(value, extraAttrs) {
      const opts = [`<option value=""${!value ? ' selected' : ''}>${_esc(t('ui.select_placeholder'))}</option>`]
        .concat(_roleOptions.map(r => `<option value="${_esc(r)}"${r === value ? ' selected' : ''}>${_esc(r)}</option>`))
        .join('');
      return `<select class="input" ${extraAttrs}>${opts}</select>`;
    }

    function _userRowHtml(u) {
      const pwOpen = _pwOpen.has(u.username);
      const pwCell = pwOpen
        ? `<div style="display:flex;gap:6px;align-items:center">
             <input type="password" class="input" data-pw-input="${_esc(u.username)}" placeholder="${_esc(t('sec.new_password_ph'))}" autocomplete="new-password" style="width:140px">
             <button class="btn btn-primary sm" data-pw-save="${_esc(u.username)}">${_esc(t('sec.save_password'))}</button>
             <button class="btn btn-ghost sm" data-pw-cancel="${_esc(u.username)}">${_esc(t('btn.cancel'))}</button>
           </div>`
        : `<div style="display:flex;gap:8px;align-items:center">
             <span class="admin-health-dot ${u.has_password ? 'ok' : 'warn'}"></span>
             <span>${_esc(u.has_password ? t('sec.password_set') : t('sec.password_not_set'))}</span>
             <button class="btn btn-ghost sm" data-pw-toggle="${_esc(u.username)}">${_esc(u.has_password ? t('sec.reset_password') : t('sec.set_password'))}</button>
           </div>`;
      return `<tr data-username="${_esc(u.username)}">
        <td class="md-td">${_esc(u.username)}</td>
        <td class="md-td"><input type="text" class="input" data-first-name-user="${_esc(u.username)}" value="${_esc(u.first_name || '')}" maxlength="100"></td>
        <td class="md-td"><input type="text" class="input" data-last-name-user="${_esc(u.username)}" value="${_esc(u.last_name || '')}" maxlength="100"></td>
        <td class="md-td">${_roleSelectHtml(u.role, `data-role-select-user="${_esc(u.username)}"`)}</td>
        <td class="md-td">${pwCell}</td>
        <td class="md-td md-td-action"><button class="icon-btn md-del-btn" data-del-user="${_esc(u.username)}" title="${_esc(t('tip.delete_row'))}">🗑</button></td>
      </tr>`;
    }

    function _stagedRowHtml(r, i) {
      return `<tr class="md-row-new">
        <td class="md-td">${_esc(r.username)}</td>
        <td class="md-td"><input type="text" class="input" data-first-name-staged="${i}" value="${_esc(r.first_name || '')}" maxlength="100"></td>
        <td class="md-td"><input type="text" class="input" data-last-name-staged="${i}" value="${_esc(r.last_name || '')}" maxlength="100"></td>
        <td class="md-td">${_roleSelectHtml(r.role, `data-role-select-staged="${i}"`)}</td>
        <td class="md-td">${_esc(t('sec.password_not_set'))}</td>
        <td class="md-td md-td-action"><button class="icon-btn md-del-btn" data-del-staged="${i}" title="${_esc(t('tip.delete_row'))}">🗑</button></td>
      </tr>`;
    }

    function _renderUsersRows() {
      const tbody = document.getElementById('sec-users-tbody');
      if (!tbody) return;
      if (!_users.length && !_staged.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="md-empty">${_esc(t('sec.no_users_yet'))}</td></tr>`;
      } else {
        tbody.innerHTML = _users.map(_userRowHtml).join('') + _staged.map(_stagedRowHtml).join('');
      }
      tbody.querySelectorAll('[data-role-select-user]').forEach(sel =>
        sel.addEventListener('change', () => _setUserRole(sel.dataset.roleSelectUser, sel.value)));
      tbody.querySelectorAll('[data-role-select-staged]').forEach(sel =>
        sel.addEventListener('change', () => { _staged[+sel.dataset.roleSelectStaged].role = sel.value; }));
      tbody.querySelectorAll('[data-first-name-user]').forEach(inp =>
        inp.addEventListener('blur', () => _scheduleSetUserName(inp.dataset.firstNameUser)));
      tbody.querySelectorAll('[data-last-name-user]').forEach(inp =>
        inp.addEventListener('blur', () => _scheduleSetUserName(inp.dataset.lastNameUser)));
      tbody.querySelectorAll('[data-first-name-staged]').forEach(inp =>
        inp.addEventListener('blur', () => { _staged[+inp.dataset.firstNameStaged].first_name = inp.value; }));
      tbody.querySelectorAll('[data-last-name-staged]').forEach(inp =>
        inp.addEventListener('blur', () => { _staged[+inp.dataset.lastNameStaged].last_name = inp.value; }));
      tbody.querySelectorAll('[data-pw-toggle]').forEach(b =>
        b.addEventListener('click', () => { _pwOpen.add(b.dataset.pwToggle); _renderUsersRows(); }));
      tbody.querySelectorAll('[data-pw-cancel]').forEach(b =>
        b.addEventListener('click', () => { _pwOpen.delete(b.dataset.pwCancel); _renderUsersRows(); }));
      tbody.querySelectorAll('[data-pw-save]').forEach(b =>
        b.addEventListener('click', () => _savePassword(b.dataset.pwSave)));
      tbody.querySelectorAll('[data-del-user]').forEach(b =>
        b.addEventListener('click', () => _deleteUser(b.dataset.delUser)));
      tbody.querySelectorAll('[data-del-staged]').forEach(b =>
        b.addEventListener('click', () => { _staged.splice(+b.dataset.delStaged, 1); _renderUsersRows(); _renderUsersActions(); }));
    }

    async function _setUserRole(username, role) {
      try {
        await _postJSON(`${API}/security/users/bulk`, { upserts: [{ username, role: role || null }] });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Set role failed for ${username}: ${e.message}`);
      }
      await _reloadUsers();
    }

    // Debounced by username so tabbing from First Name straight into Last Name
    // in the same row coalesces into one save (reading both fields' live
    // values) instead of firing mid-edit and losing the second field's
    // keystrokes to the unconditional reload/re-render below.
    function _scheduleSetUserName(username) {
      clearTimeout(_nameSaveTimers.get(username));
      _nameSaveTimers.set(username, setTimeout(() => {
        _nameSaveTimers.delete(username);
        _setUserName(username);
      }, 200));
    }

    async function _setUserName(username) {
      const row = document.querySelector(`tr[data-username="${CSS.escape(username)}"]`);
      if (!row) return;
      const roleSelect = row.querySelector('[data-role-select-user]');
      const firstInput = row.querySelector('[data-first-name-user]');
      const lastInput = row.querySelector('[data-last-name-user]');
      try {
        await _postJSON(`${API}/security/users/bulk`, {
          upserts: [{
            username,
            role: roleSelect ? (roleSelect.value || null) : null,
            first_name: firstInput ? firstInput.value.trim() : '',
            last_name: lastInput ? lastInput.value.trim() : '',
          }],
        });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Set name failed for ${username}: ${e.message}`);
      }
      await _reloadUsers();
    }

    async function _savePassword(username) {
      const input = document.querySelector(`[data-pw-input="${CSS.escape(username)}"]`);
      const pw = input ? input.value : '';
      if (!pw || pw.length < 4) { Toast.show(t('sec.password_too_short'), 'error'); return; }
      try {
        await _postJSON(`${API}/security/users/${encodeURIComponent(username)}/reset-password`, { password: pw });
        _pwOpen.delete(username);
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Set password failed for ${username}: ${e.message}`);
      }
      await _reloadUsers();
    }

    async function _deleteUser(username) {
      const ok = await Modal.confirm({
        title: t('sec.confirm_delete_user_title'),
        message: t('sec.confirm_delete_user_msg', { username }),
        confirmLabel: t('btn.yes_delete'),
        tone: 'danger',
      });
      if (!ok) return;
      try {
        await _postJSON(`${API}/security/users/bulk`, { deletes: [{ username }] });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Delete user failed for ${username}: ${e.message}`);
      }
      await _reloadUsers();
    }

    async function _addUser() {
      const uInput = document.getElementById('sec-new-username');
      const fInput = document.getElementById('sec-new-firstname');
      const lInput = document.getElementById('sec-new-lastname');
      const rSelect = document.getElementById('sec-new-role-select');
      const pInput = document.getElementById('sec-new-password');
      const username = (uInput?.value || '').trim();
      if (!username) { Toast.show(t('sec.username_required'), 'error'); return; }
      const password = pInput?.value || '';
      if (password && password.length < 4) { Toast.show(t('sec.password_too_short'), 'error'); return; }
      const role = rSelect?.value || null;
      const first_name = (fInput?.value || '').trim();
      const last_name = (lInput?.value || '').trim();
      try {
        await _postJSON(`${API}/security/users/bulk`, { upserts: [{ username, role, first_name, last_name }] });
        if (password) await _postJSON(`${API}/security/users/${encodeURIComponent(username)}/reset-password`, { password });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Add user failed: ${e.message}`);
      }
      await _reloadUsers();
    }

    // Mirrors MasterData._parsePaste's header-detection idiom, scoped to a fixed
    // username/role 2-column shape (no password column — passwords are never pasted).
    function _parseUserPaste(rawText) {
      const lines = rawText.replace(/\r/g, '').split('\n').filter(l => l.trim());
      if (!lines.length) return [];
      const first = lines[0].split('\t').map(h => h.trim().toLowerCase());
      const nameHdrs = ['username', t('sec.username').toLowerCase()];
      const roleHdrs = ['role', t('sec.role').toLowerCase()];
      const firstNameHdrs = ['first name', 'firstname', t('sec.first_name').toLowerCase()];
      const lastNameHdrs = ['last name', 'lastname', t('sec.last_name').toLowerCase()];
      const hasHeader = first.some(h =>
        nameHdrs.includes(h) || roleHdrs.includes(h) || firstNameHdrs.includes(h) || lastNameHdrs.includes(h));
      let headers, dataLines;
      if (hasHeader) {
        headers = first.map(h => {
          if (nameHdrs.includes(h)) return 'username';
          if (roleHdrs.includes(h)) return 'role';
          if (firstNameHdrs.includes(h)) return 'first_name';
          if (lastNameHdrs.includes(h)) return 'last_name';
          return h;
        });
        dataLines = lines.slice(1);
      } else {
        headers = ['username', 'role'];
        dataLines = lines;
      }
      return dataLines.map(line => {
        const vals = line.split('\t');
        const row = {};
        headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
        return row;
      }).filter(r => r.username);
    }

    async function _pasteUsers() {
      let raw;
      try { raw = await navigator.clipboard.readText(); }
      catch { Toast.show(t('toast.clipboard_denied'), 'error'); return; }
      if (!raw.trim()) { Toast.show(t('toast.clipboard_empty'), 'error'); return; }
      const rows = _parseUserPaste(raw);
      if (!rows.length) { Toast.show(t('toast.no_rows_paste'), 'error'); return; }
      rows.forEach(r => _staged.push({
        username: r.username, role: r.role || '',
        first_name: r.first_name || '', last_name: r.last_name || '',
      }));
      _renderUsersRows();
      _renderUsersActions();
    }

    async function _saveStaged() {
      if (!_staged.length) return;
      const upserts = _staged.map(r => ({
        username: r.username, role: r.role || null,
        first_name: r.first_name || '', last_name: r.last_name || '',
      }));
      try {
        await _postJSON(`${API}/security/users/bulk`, { upserts });
        _staged = [];
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Save staged users failed: ${e.message}`);
      }
      await _reloadUsers();
    }

    // -----------------------------------------------------------------------
    // ROLES tab — master-detail: role list (left) + its plant assignments (right)
    // -----------------------------------------------------------------------
    async function _reloadRoles() {
      const body = document.getElementById('security-tabbody');
      try {
        const [rolesData, rpData] = await Promise.all([
          Util.fetchTraced(`${API}/master-data/roles`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
          Util.fetchTraced(`${API}/master-data/role_plants`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        ]);
        _roles = rolesData.rows || [];
        _rolePlants = rpData.rows || [];
        if (_selectedRole && !_roles.some(r => r.role === _selectedRole)) _selectedRole = null;
        // Best-effort: knowing which roles have >=1 user lets the delete button be
        // disabled pre-emptively. Non-fatal if this fetch fails — bulk_apply's FK
        // hardening (ForeignKeyViolation -> clean 400) remains the authoritative guard.
        try {
          const usersData = await Util.fetchTraced(`${API}/security/users`).then(r => { if (!r.ok) throw new Error(); return r.json(); });
          _rolesInUse = new Set((usersData.users || []).map(u => u.role).filter(Boolean));
        } catch { _rolesInUse = new Set(); }
        if (_tab !== 'roles') return; // bail if the admin switched tabs while awaiting
        _renderRolesTab();
      } catch (e) {
        if (body) body.innerHTML = `<div class="md-empty">Failed to load roles: ${_esc(e.message)}</div>`;
        ErrorLog.error('security', `Load roles failed: ${e.message}`);
      }
    }

    function _renderRolesTab() {
      const body = document.getElementById('security-tabbody');
      if (!body) return;
      body.innerHTML = `<div class="sap-console"><div id="sec-roles-rail"></div><div id="sec-roles-detail"></div></div>`;
      _renderRolesRail();
      _renderRolesDetail();
    }

    function _roleRowHtml(r) {
      const sel = r.role === _selectedRole ? ' sap-rail-row-sel' : '';
      const inUse = _rolesInUse.has(r.role);
      const delAttrs = inUse
        ? `disabled title="${_esc(t('sec.role_in_use'))}"`
        : `title="${_esc(t('tip.delete_row'))}"`;
      return `<div class="sap-rail-row${sel}" style="display:flex;align-items:center;gap:8px" data-role="${_esc(r.role)}">
        <div style="flex:1;min-width:0">
          <div class="sap-rail-name" style="cursor:pointer" data-role-select="${_esc(r.role)}">${_esc(r.role)}</div>
          <input type="text" class="input" data-role-desc="${_esc(r.role)}" value="${_esc(r.description || '')}"
            title="${_esc(t('sec.description'))}" placeholder="${_esc(t('sec.description_ph'))}"
            style="margin-top:4px;width:100%;font-size:11.5px;padding:3px 6px">
        </div>
        <button class="btn btn-ghost sm" data-role-desc-save="${_esc(r.role)}">${_esc(t('btn.save'))}</button>
        <button class="sap-icon-btn danger" data-role-del="${_esc(r.role)}" ${delAttrs}>🗑</button>
      </div>`;
    }

    function _renderRolesRail() {
      const el = document.getElementById('sec-roles-rail');
      if (!el) return;
      const rows = !_roles.length
        ? `<div class="md-empty">${_esc(t('sec.no_roles_yet'))}</div>`
        : _roles.map(_roleRowHtml).join('');
      el.innerHTML = `<div class="panel">
        <div class="panel-head"><span class="sap-section-label">${_esc(t('tab.security_roles'))}</span></div>
        <div style="display:flex;gap:8px;padding:12px;border-bottom:1px solid var(--line);flex-wrap:wrap">
          <input type="text" class="input" id="sec-new-role" placeholder="${_esc(t('sec.role'))}" style="flex:1;min-width:90px">
          <input type="text" class="input" id="sec-new-role-desc" placeholder="${_esc(t('sec.description_ph'))}" style="flex:1.6;min-width:110px">
          <button class="btn btn-primary sm" id="sec-add-role-btn">${_esc(t('sec.add_role'))}</button>
        </div>
        <div class="sap-rail" id="sec-roles-list">${rows}</div>
      </div>`;
      document.getElementById('sec-add-role-btn')?.addEventListener('click', _addRole);
      el.querySelectorAll('[data-role-select]').forEach(nameEl =>
        nameEl.addEventListener('click', () => _selectRole(nameEl.dataset.roleSelect)));
      el.querySelectorAll('[data-role-desc-save]').forEach(b =>
        b.addEventListener('click', () => _saveRoleDescription(b.dataset.roleDescSave)));
      el.querySelectorAll('[data-role-del]').forEach(b =>
        b.addEventListener('click', () => _deleteRole(b.dataset.roleDel)));
    }

    function _selectRole(role) {
      _selectedRole = role;
      // Local-only: toggle the selected highlight instead of rebuilding the rail,
      // so an in-progress "add role" draft elsewhere in the rail isn't wiped.
      document.querySelectorAll('#sec-roles-list .sap-rail-row').forEach(el =>
        el.classList.toggle('sap-rail-row-sel', el.dataset.role === role));
      _renderRolesDetail();
    }

    function _renderRolesDetail() {
      const el = document.getElementById('sec-roles-detail');
      if (!el) return;
      const role = _selectedRole;
      const header = role ? t('sec.plants_for_role', { role }) : t('sec.no_role_selected');
      const plants = role ? _rolePlants.filter(rp => rp.role === role).map(rp => rp.plant).sort() : [];
      const addHtml = !role ? '' : `
        <div class="sap-section-label">${_esc(t('sec.add_plant'))}</div>
        <div class="hps-combobox" id="sec-plant-combobox" style="max-width:280px">
          <input type="text" class="input" id="sec-plant-search" placeholder="${_esc(t('sec.search_plants_ph'))}" autocomplete="off">
          <div class="hps-dropdown" id="sec-plant-dropdown" hidden></div>
        </div>`;
      const listHtml = !role ? '' : !plants.length
        ? `<div class="sap-help" style="margin-top:12px">${_esc(t('sec.no_plants_yet'))}</div>`
        : `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px">${plants.map(p =>
            `<span class="sap-keychip">${_esc(p)}<button data-remove-plant="${_esc(p)}" title="${_esc(t('tip.delete_row'))}"
               style="border:none;background:transparent;cursor:pointer;color:var(--fg-mute);font-size:12px;line-height:1;padding:0;margin-left:2px">✕</button></span>`
          ).join('')}</div>`;
      el.innerHTML = `<div class="panel">
        <div class="sap-detail-head"><span class="sap-detail-name">${_esc(header)}</span></div>
        <div class="panel-body">${addHtml}${listHtml}</div>
      </div>`;
      if (role) {
        const srch = document.getElementById('sec-plant-search');
        srch?.addEventListener('focus', () => { _renderPlantDropdown(srch.value); document.getElementById('sec-plant-dropdown').hidden = false; });
        srch?.addEventListener('input', () => { _renderPlantDropdown(srch.value); document.getElementById('sec-plant-dropdown').hidden = false; });
        srch?.addEventListener('blur', () => { setTimeout(() => { const dd = document.getElementById('sec-plant-dropdown'); if (dd) dd.hidden = true; }, 150); });
      }
      el.querySelectorAll('[data-remove-plant]').forEach(b =>
        b.addEventListener('click', () => _removePlantFromRole(b.dataset.removePlant)));
    }

    // Type-to-filter Store.knownPlants() down to matches, click one to add it —
    // NIMBUS's plant lists must never be a plain <select> at 50+ plant scale (see
    // CLAUDE.md); mirrors the PlantSelector/OptimizeDialog filterPlants pattern.
    function _renderPlantDropdown(query) {
      const dd = document.getElementById('sec-plant-dropdown');
      if (!dd || !_selectedRole) return;
      const assigned = new Set(_rolePlants.filter(rp => rp.role === _selectedRole).map(rp => rp.plant));
      const all = Store.knownPlants().filter(p => !assigned.has(p));
      const q = (query || '').trim().toLowerCase();
      const filtered = q ? all.filter(p => p.toLowerCase().includes(q)) : all;
      if (!filtered.length) {
        dd.innerHTML = `<div class="hps-empty">${all.length ? 'No matches' : 'No plants available'}</div>`;
        return;
      }
      dd.innerHTML = filtered.map(p => `<div class="hps-option" data-plant="${_esc(p)}">${_esc(p)}</div>`).join('');
      dd.querySelectorAll('[data-plant]').forEach(optEl =>
        optEl.addEventListener('mousedown', e => { e.preventDefault(); _addPlantToRole(optEl.dataset.plant); }));
    }

    async function _addPlantToRole(plant) {
      if (!_selectedRole) return;
      try {
        await _postJSON(`${API}/master-data/role_plants/bulk`, { upserts: [{ role: _selectedRole, plant }] });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Add plant to role failed: ${e.message}`);
      }
      await _reloadRoles();
    }

    async function _removePlantFromRole(plant) {
      if (!_selectedRole) return;
      try {
        await _postJSON(`${API}/master-data/role_plants/bulk`, { deletes: [{ role: _selectedRole, plant }] });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Remove plant from role failed: ${e.message}`);
      }
      await _reloadRoles();
    }

    async function _addRole() {
      const nameInput = document.getElementById('sec-new-role');
      const descInput = document.getElementById('sec-new-role-desc');
      const role = (nameInput?.value || '').trim();
      if (!role) return;
      try {
        await _postJSON(`${API}/master-data/roles/bulk`, { upserts: [{ role, description: (descInput?.value || '').trim() }] });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Add role failed: ${e.message}`);
      }
      await _reloadRoles();
    }

    async function _saveRoleDescription(role) {
      const input = document.querySelector(`[data-role-desc="${CSS.escape(role)}"]`);
      if (!input) return;
      try {
        await _postJSON(`${API}/master-data/roles/bulk`, { upserts: [{ role, description: input.value }] });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Save role description failed: ${e.message}`);
      }
      await _reloadRoles();
    }

    async function _deleteRole(role) {
      const ok = await Modal.confirm({
        title: t('sec.confirm_delete_role_title'),
        message: t('sec.confirm_delete_role_msg', { role }),
        confirmLabel: t('btn.yes_delete'),
        tone: 'danger',
      });
      if (!ok) return;
      try {
        await _postJSON(`${API}/master-data/roles/bulk`, { deletes: [{ role }] });
        if (_selectedRole === role) _selectedRole = null;
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('security', `Delete role failed: ${e.message}`);
      }
      await _reloadRoles();
    }

    return { render };
  })();

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
