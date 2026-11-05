// app.js — CQ-1 launcher.
//
// Every module this file used to define now lives in a real ES module under
// frontend/<domain>/, bridged onto eight `window.__NIMBUS_*` objects
// (FOUNDATION, STATE, SERVICES, DATA, WORKBENCH, PLANT_ADMIN, SHELL,
// MATERIAL_GRIDS) built in frontend/app-entry.mjs. This file exists only
// because nimbus-intelligence.js reads `NIMBUS` as a bare identifier through
// classic-script shared lexical scope (converting it to an ES module would
// sever that access). It holds no module bodies: only boot orchestration
// (`_bootMain`/`_domReadyGate`, kept here so every `.init()` target is already
// resolvable from the bridge destructures below), the DI-seam wiring, and the
// compatibility namespace `return {...}` at the bottom, which carries only the
// keys that a bundle outside this file still reads (index.html inline handlers,
// nimbus-intelligence.js, ES modules via globalThis.NIMBUS, the VM test
// harness). The migration history that used to live here is in
// docs/architecture/cq1-compatibility-inventory.md (section 9).

// CACHE-BUST GUARD lives in frontend/app-entry.mjs's runCacheBustGuard(); it runs
// before app.js is requested, off `NIMBUS_BUILD_ID`.

const NIMBUS = (function () {
  'use strict';

  // nimbus-compute-core.js is the single source of truth for the capacity engine,
  // alert rules, and utilization matrix (the same module the worker importScripts).
  // index.html injects it just above app.js. Fail fast with a clear message rather
  // than throwing cryptically deep inside Alerts/Utilization on first compute.
  if (typeof NimbusComputeCore === 'undefined') {
    throw new Error('NIMBUS boot error: nimbus-compute-core.js did not load before app.js — check index.html script order / deploy.');
  }

  if (typeof window === 'undefined' || !window.__NIMBUS_FOUNDATION || !window.__NIMBUS_STATE || !window.__NIMBUS_SERVICES || !window.__NIMBUS_DATA || !window.__NIMBUS_WORKBENCH || !window.__NIMBUS_PLANT_ADMIN || !window.__NIMBUS_SHELL || !window.__NIMBUS_MATERIAL_GRIDS) {
    throw new Error('NIMBUS boot error: one of the window.__NIMBUS_* bridges (FOUNDATION, STATE, SERVICES, DATA, WORKBENCH, PLANT_ADMIN, SHELL, MATERIAL_GRIDS) did not load before app.js — check app-entry.mjs.');
  }
  const { Config, Util, ErrorLog, Toast, Modal } = window.__NIMBUS_FOUNDATION;
  const { Store, Selection, UndoStack, Sandbox } = window.__NIMBUS_STATE;
  const { Alerts, Utilization, Engine } = window.__NIMBUS_SERVICES;
  const { Persistence, Session } = window.__NIMBUS_DATA;
  const { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter, Dashboard, Interaction, OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, AlertsUIAdapter } = window.__NIMBUS_WORKBENCH;
  const { SetupAdmin, CalendarUI, Plant, ProdLines, MasterData, LaborPlanning, AdminCockpit, setActiveTabResolvers: _setPlantAdminTabResolvers } = window.__NIMBUS_PLANT_ADMIN;
  const { Settings, SessionUIAdapter, showLoginScreen, EmptyState, PlantSelector, App } = window.__NIMBUS_SHELL;
  const { MaterialGrids } = window.__NIMBUS_MATERIAL_GRIDS;
  // Injected getter seam so master-data/admin-ui's Plant and labor/labor-planning's
  // LaborPlanning can ask "am I currently the visible tab/sub-tab?" without a bare
  // reference to `App` (resolved lazily at call time, like every other seam here).
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
  // changeover KPI measures the same thing the evaluator ranks on (rankForTask / policyKeyForTask).
  // Resolved off Store.selectedPlant with no argument for the same reason
  // Engine.hasPriorityRanks takes no plant: every optimizer caller's effective
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
    return { lineHours, plantHours: plant ? (Store.plants[plant]?.workHours ?? null) : null, plantPeriods: plant ? (Store.plants[plant]?.periods ?? null) : null, plant,
      // dataRev, not rev: every calendar / plant / period / master-data edit emits an event that bumps it, while
      // alerts:change (a recompute lands every few hundred ms during edits) and line-checkbox toggles do not, so
      // they no longer flush the per-line+date due-window cache.
      rev: Store.dataRev() };
  });
  ErrorLog.setPlantResolver(() => Store.selectedPlant);
  ErrorLog.setRouteResolver(() => ({ tab: App._currentTab, ganttSub: App._ganttSub }));
  ErrorLog.setAdminGate(() => Session.isAdmin());
  ErrorLog.setBadgeClickHandler(() => { App.goto('admin'); AdminCockpit.gotoSub('logs'); });
  Store.setAllowedPlantsResolver(() => Session.allowedPlants());
  Store.setSettingsDefaultsResolver(() => Settings.DEFAULTS);

  /* =============================================================================
     RUNTIME WATCHDOGS (long task, JS heap, main-thread freeze)
     Started once from _bootMain(). Diagnostics only: each one logs through
     ErrorLog and never changes app behaviour.
     ========================================================================== */
  const WATCHDOG = Object.freeze({
    LONGTASK_MS: 250,               // only long tasks above this are worth a log line
    LONGTASK_LOG_CAP: 5,            // max long-task log lines per window (a busy page can emit hundreds)
    LONGTASK_LOG_WINDOW_MS: 60_000,
    HEAP_WARN_RATIO: 0.85,          // warn once when used/limit first crosses this ...
    HEAP_REARM_RATIO: 0.80,         // ... and re-arm only after it falls back below this (hysteresis)
    HEAP_POLL_MS: 30_000,
    BYTES_PER_MB: 1048576,
    FREEZE_TICK_MS: 1000,           // the interval the freeze watchdog expects to fire at
    FREEZE_WARN_GAP_MS: 2000,       // a tick gap above this means the main thread was blocked
    FREEZE_SLEEP_GAP_MS: 15_000,    // a gap this long is sleep / lock screen / throttling, not a JS block
  });

  function startRuntimeWatchdogs() {
    // Long tasks (PerformanceObserver), rate-limited per window.
    try {
      if ('PerformanceObserver' in window &&
          PerformanceObserver.supportedEntryTypes &&
          PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        let windowStart = 0, logged = 0, suppressed = 0;
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry.duration <= WATCHDOG.LONGTASK_MS) continue;
            const now = performance.now();
            if (now - windowStart > WATCHDOG.LONGTASK_LOG_WINDOW_MS) {
              if (suppressed > 0) ErrorLog.info('perf', `${suppressed} further long task(s) not logged in the previous ${WATCHDOG.LONGTASK_LOG_WINDOW_MS / 1000}s window`);
              windowStart = now; logged = 0; suppressed = 0;
            }
            if (logged >= WATCHDOG.LONGTASK_LOG_CAP) { suppressed++; continue; }
            logged++;
            const attr = entry.attribution?.[0]?.name || 'n/a';
            ErrorLog.warn('perf', `longtask ${Math.round(entry.duration)}ms (attribution: ${attr})`);
          }
        }).observe({ entryTypes: ['longtask'] });
      }
    } catch (e) { ErrorLog.info('perf', `longtask observer unavailable: ${e?.message || e}`); }

    // JS heap sampler: warns on crossing the ratio, not on every poll above it.
    let heapWarned = false;
    setInterval(() => {
      if (document.hidden) return; // skip heap sampling while the tab is backgrounded
      const m = performance && performance.memory;
      if (!m) return;
      const usedMB  = m.usedJSHeapSize  / WATCHDOG.BYTES_PER_MB;
      const limitMB = m.jsHeapSizeLimit / WATCHDOG.BYTES_PER_MB;
      const ratio   = usedMB / limitMB;
      if (ratio > WATCHDOG.HEAP_WARN_RATIO) {
        if (heapWarned) return;
        heapWarned = true;
        ErrorLog.warn('memory',
          `JS heap ${usedMB.toFixed(0)}/${limitMB.toFixed(0)} MB (${Math.round(ratio * 100)}%)`);
      } else if (ratio < WATCHDOG.HEAP_REARM_RATIO) {
        heapWarned = false;
      }
    }, WATCHDOG.HEAP_POLL_MS);

    // Freeze watchdog: a setInterval that records actual elapsed time. If the
    // gap is much larger than the schedule, the main thread was blocked. The
    // gap is measured with performance.now() (monotonic), so a wall-clock jump
    // cannot fake or hide a freeze.
    // Caveat: hidden-tab timers are throttled (Chrome/Edge: ~1 tick/min under
    // intensive throttling, and Windows window occlusion counts as hidden), so
    // the in-tick hidden guard alone can't keep _lastTick fresh across a
    // background stint — the visibilitychange reset below handles resume.
    let _lastTick = performance.now();
    document.addEventListener('visibilitychange', () => { _lastTick = performance.now(); });
    setInterval(() => {
      const now = performance.now();
      // Belt-and-suspenders alongside the visibilitychange reset, in case a
      // throttled tick races the event on resume.
      if (document.hidden) { _lastTick = now; return; }
      const drift = now - _lastTick;
      _lastTick = now;
      if (drift > WATCHDOG.FREEZE_WARN_GAP_MS) {
        const blockedMs = Math.round(drift - WATCHDOG.FREEZE_TICK_MS);
        if (drift > WATCHDOG.FREEZE_SLEEP_GAP_MS) {
          // A real synchronous block this long is implausible (and would show up
          // as a longtask entry) — this is system sleep / lock screen / residual
          // background-tab throttling.
          ErrorLog.info('freeze', `~${blockedMs}ms timer gap — likely system sleep or background-tab throttling, not a JS block`);
        } else {
          ErrorLog.warn('freeze', `Main thread blocked ~${blockedMs}ms`);
        }
      }
    }, WATCHDOG.FREEZE_TICK_MS);
  }

  // Settle delays for work that must run after the first Timeline render. The
  // Timeline exposes no "ready" signal to gate on, so these are heuristic
  // delays: vis-timeline needs a layout pass before Interaction can wire its
  // listeners, TimelineNav / DependencyOverlay read the rendered range, and the
  // first-load view reset runs after the landing navigation has settled.
  const BOOT_DELAY_MS = Object.freeze({
    INTERACTION_INSTALL: 80,
    TIMELINE_NAV_INIT: 150,
    DEPENDENCY_OVERLAY_INIT: 160,
    FIRST_LOAD_DAY_VIEW: 200,
  });

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
    // Global hard-error net FIRST (captures stack traces, normalized through ErrorLog), so a throw in any boot
    // step below (SessionUIAdapter.init, the gates, the settings hydration) is recorded instead of vanishing.
    ErrorLog.installGlobalHandlers();
    // Subscribe SessionUIAdapter to session:changed FIRST (Session.signIn/signOut/refresh emit that event
    // instead of calling _applyGates()/DOM code inline). Then re-apply session-driven UI gates explicitly —
    // this covers the "already signed in on page load" resume path, which never goes through signIn() and so
    // never fires session:changed. The "just signed in" path is covered too: showLoginScreen's signIn() already
    // fired the event (with nobody subscribed yet, since init() hadn't run), so this explicit call is what
    // actually applies the gates for that path as well — a harmless, idempotent single application either way.
    SessionUIAdapter.init();
    try { SessionUIAdapter._applyGates(); } catch (e) { ErrorLog.error('boot', `SessionUIAdapter._applyGates: ${e.message}`); }
    // N2: Config.CONCURRENCY_CHECK=false makes every manual save force:true
    // (last-write-wins). Documented escape hatch, but nobody should run the
    // pilot in that mode without seeing it. Logged once per boot + a
    // persistent banner (same chrome band as the What-If sandbox banner).
    try {
      if (Config.CONCURRENCY_CHECK === false) {
        ErrorLog.warn('concurrency', 'Config.CONCURRENCY_CHECK is false — task saves run last-write-wins');
        const _ccBanner = document.getElementById('concurrency-banner');
        if (_ccBanner) {
          _ccBanner.textContent = Util.t('ui.concurrency_off_banner');
          _ccBanner.hidden = false;
          document.body.classList.add('concurrency-off');
        }
      }
    } catch (e) { ErrorLog.error('boot', `concurrency banner: ${e.message}`); }
    // Hydrate per-user settings + role defaults from the cached session blob so the
    // app reflects the user's prefs immediately AND works offline. Session.refresh()
    // below overwrites these with DB truth from /security/me when the network is up.
    try {
      const _u = Session.currentUser();
      if (_u) {
        Store.setUserSettings(_u.settings || {}, 'session-cache');
        Store.setRoleDefaults(_u.role_settings || {}, 'session-cache');
      }
    } catch (e) { ErrorLog.warn('boot', `settings hydration from the session cache failed: ${e?.message || e}`); }
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
        // Storage can be unavailable (private mode, blocked site data); the locale still applies for this page.
        try { localStorage.setItem('nimbus.locale', lang); } catch (e) { ErrorLog.info('boot', `locale cache not written: ${e?.message || e}`); }
      }
    } catch (e) { ErrorLog.warn('boot', `language preference apply failed: ${e?.message || e}`); }
    // Re-apply the theme from the resolved pref. Covers the just-signed-in path
    // (DarkMode.init already ran off the offline cache before settings loaded) and
    // is idempotent for the resume path (DarkMode.init runs again right after).
    // The typeof/DarkMode guard is live: nimbus-intelligence.js (which defines DarkMode) loads AFTER app.js.
    try { if (typeof NIMBUS !== 'undefined' && NIMBUS.DarkMode?.init) NIMBUS.DarkMode.init(); } catch (e) { ErrorLog.warn('boot', `DarkMode.init failed: ${e?.message || e}`); }
    // Feed the resolved firstDayOfWeek pref into Flatpickr's default locale so every
    // calendar-style picker created afterwards renders weeks starting on the chosen day.
    App._applyFirstDayOfWeek();
    // Reconcile the cached session role against backend truth (a stale cache is
    // what leaves the admin UI visible while every admin request 403s). Fire-and-
    // forget — it re-applies the gates when it resolves.
    Session.refresh().catch(e => ErrorLog.warn('boot', `Session.refresh failed: ${e?.message || e}`));

    // (Global error handlers are installed at the top of _bootMain.)
    // Restore the persisted error-log ring from the previous page load (best-effort).
    try { ErrorLog.restore(); } catch {}
    // Defensively unregister any legacy service workers — none should be installed
    // but a prior experiment could leave one resident.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(rs => {
        if (rs.length) {
          ErrorLog.info('boot', `Unregistering ${rs.length} legacy service worker(s)`);
          rs.forEach(r => r.unregister());
        }
      }).catch(() => {});
    }

    startRuntimeWatchdogs();

    // Shared guard for the two global tab shortcuts below: not while typing in a field, not while a dialog is
    // open or an order is being dragged (a tab switch under either would orphan the gesture), and not for
    // auto-repeat (holding the keys must not re-navigate every ~30 ms).
    const _shortcutBlocked = e => {
      if (e.repeat) return true;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el?.isContentEditable) return true;
      if (Modal.anyOpen()) return true;
      if (Interaction._isDragging || Interaction._marquee) return true;
      return false;
    };

    // Ctrl+Alt+L → open Admin Cockpit log tab. Gated by the same per-role page access as the Admin Cockpit tab
    // itself, checked BEFORE preventDefault so a user without access keeps the browser's/OS's own binding.
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'l') {
        if (_shortcutBlocked(e)) return;
        if (!Session.canAccessTab('admin')) return;
        e.preventDefault();
        App.goto('admin'); AdminCockpit.gotoSub('logs');
      }
    });

    // ` (backtick) → go back to previous tab  |  Alt+H → Dashboard
    document.addEventListener('keydown', e => {
      if (_shortcutBlocked(e)) return;
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
      // evt.table (set by saves from Manage Data / Tool Inventory) lets unrelated tables (tool inventory, materials,
      // routing, ...) skip the line re-sync and the Hierarchy/Machines repaints; no table = boot/refresh = always run.
      if (evt.type === 'master-data-changed' && Store.masterDataChangeTouchesLines(evt.table)) {
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
        try { Hierarchy.render(); } catch (e) { ErrorLog.warn('boot', `Hierarchy.render after master-data change: ${e?.message || e}`); }
        try { if (App._currentTab === 'masterdata' && App._currentMasterSub === 'lines') ProdLines.render(); } catch (e) { ErrorLog.warn('boot', `ProdLines.render after master-data change: ${e?.message || e}`); }
      }
    }, 'App.masterData');
    try { Plant.init();       } catch (e) { ErrorLog.error('boot', `Plant.init: ${e.message}`); }
    try { MaterialGrids.init(); } catch (e) { ErrorLog.error('boot', `MaterialGrids.init: ${e.message}`); }
    try { PlantSelector.init();  } catch (e) { ErrorLog.error('boot', `PlantSelector.init: ${e.message}`); }
    try { App.init();            } catch (e) { ErrorLog.error('boot', `App.init: ${e.message}`); }
    // ProdLines has no async init — it renders on-demand when its tab is activated.
    // TimelineNav / DependencyOverlay init are deferred until after the first Timeline render (see BOOT_DELAY_MS).
    setTimeout(() => { try { TimelineNav.init(); } catch (e) { ErrorLog.error('boot', `TimelineNav.init: ${e.message}`); } }, BOOT_DELAY_MS.TIMELINE_NAV_INIT);
    setTimeout(() => { try { DependencyOverlay.init(); } catch (e) { ErrorLog.error('boot', `DependencyOverlay.init: ${e.message}`); } }, BOOT_DELAY_MS.DEPENDENCY_OVERLAY_INIT);
    // Sandbox init
    try { SandboxAdapter.init(); } catch (e) { ErrorLog.error('boot', `SandboxAdapter.init: ${e.message}`); }

    // Install the unified input pipeline AFTER Timeline + Table are up so
    // their internal DataSet / grid API exist when we wire the listeners.
    // Brief delay lets vis-timeline finish its first layout.
    setTimeout(() => {
      try { Interaction.install(); }
      catch (e) { ErrorLog.error('boot', `Interaction.install: ${e.message}`); }
    }, BOOT_DELAY_MS.INTERACTION_INSTALL);

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
        setTimeout(() => Timeline.setView('day'), BOOT_DELAY_MS.FIRST_LOAD_DAY_VIEW);
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
    const _offDefaultPlant = Store.subscribe(evt => {
      if (evt.type !== 'master-data-changed') return;
      // Act only on authoritative plant metadata: an early or failed load can emit master-data-changed with no
      // plants, and unsubscribing then would lose the one-shot before the real list arrives (knownPlants() would
      // also fall back to the hardcoded seed list). Stay subscribed until a non-empty plant list shows up.
      if (!(Store.masterData?.plants?.length > 0)) return;
      _offDefaultPlant();
      try {
        if (Store.selectedPlant) return;                 // already selected — never override
        // Unsaved work (or a cache marker that says there is some, before the boot restore has run) outranks the default plant:
        // switching now would drop the restored edits without the discard confirm.
        if (Persistence.blocksBootPlantSwitch()) return;
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
        if (!(dp && known.includes(dp)) && known.length === 1) Store.setSelectedPlant(known[0], 'default-plant');
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
      .catch(e => {
        // Attempts 1..4 = the first try plus three retries, backing off 1 s, 2 s, 4 s.
        if (attempt <= 3) { setTimeout(() => _loadApiKey(attempt + 1), 1000 * 2 ** (attempt - 1)); return; }
        // Terminal failure: leave a record (the admin Security / Table Browser calls will 401 until a reload).
        try { ErrorLog.warn('boot', `client-config (API key) load failed after ${attempt} attempts: ${e?.message || e}`); } catch {}
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
    // cache, and retry 3x after the first try with backoff (1s, 2s, 4s). Still fire-and-forget.
    _loadApiKey(1);

    // Mandatory login gate — blocks the whole app until authenticated against
    // user_security. A cached session (page reload while signed in) skips
    // straight to _bootMain(); otherwise showLoginScreen() takes over and calls
    // App._bootMain() itself once Session.signIn() resolves.
    //
    // The 12h local cache lifetime is checked ONLY here, at boot — not via a
    // live in-tab timer — so a session older than Config.SESSION_MAX_AGE_MS
    // is cleared and treated exactly like "not logged in" on the next reload.
    if (Session.isExpired()) { const lost = Session.expiredEditCount(); Session.clearExpired(); showLoginScreen({ expired: true, lost }); return; }
    if (!Session.currentUser()) { showLoginScreen(); return; }
    void Session.sweepOrphanCache();   // other users' / empty cache records, before the boot load reads its own
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

  /* Public namespace: only the keys a bundle outside this file still reads —
     index.html inline handlers, nimbus-intelligence.js (its destructure plus
     NIMBUS.X reads), ES modules reaching globalThis.NIMBUS, and the VM test
     harness. A key with no remaining reader is dropped, not kept "just in case"
     (npm run check:legacy-surface + grep the repo before adding or removing one). */
  return {
    App, Engine, Alerts, AlertsUIAdapter, Timeline, Table, Inspector,
    Dashboard, CalendarUI, Plant, ProdLines, Persistence, Modal, Toast, Store, Util,
    Utilization, Hierarchy,
    Selection, UndoStack, Interaction,
    ErrorLog,
    TimelineNav, GanttFilter, Sandbox, SandboxAdapter, Printer,
    OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer,
    EmptyState, MasterData, SetupAdmin,
    LaborPlanning, Session
  };
})();

// Expose the namespace for ES modules (Alert Monitor pane reads globalThis.NIMBUS);
// `const NIMBUS` is a script-scope lexical binding and is NOT a window property.
globalThis.NIMBUS = NIMBUS;
