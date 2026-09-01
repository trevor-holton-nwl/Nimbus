// app-entry.mjs — CQ-1 temporary ESM entry point.
//
// Statically imports the extracted foundation module, bridges its exports
// onto `window.__NIMBUS_FOUNDATION`, then loads the still-legacy app.js and
// nimbus-intelligence.js as classic scripts, in that strict order. Once both
// have loaded, the bridge is deleted from `window` again (see bootEntry) — it
// exists only to hand off values across the classic-script boundary, not as a
// permanent global. This file shrinks over Phase 2-4 as more of app.js's
// content moves into real modules, and disappears once app.js does.
import * as foundation from './platform/foundation.mjs';
// schedule-state.mjs, schedule-services.mjs, and schedule-data.mjs were split
// in Phase P4 of docs/architecture/domain-refactor-plan.md into 10 domain
// files (and Phase P4 also broke import cycle 1 between the former
// schedule-services.mjs and optimization/setup-scheduler.mjs — see
// optimization/scheduler-contract.mjs's header comment). The
// __NIMBUS_STATE/__NIMBUS_SERVICES/__NIMBUS_DATA bridges below are
// reconstructed explicitly from their named exports so they keep exposing
// the exact same key sets app.js's destructure (and
// tests/modules/helpers/load-legacy-app.mjs's VM harness) already depend on
// — the same "reconstruct an explicit object bridge" pattern already used
// below for __NIMBUS_WORKBENCH/__NIMBUS_PLANT_ADMIN (Phases P2/P3).
import { Store, UndoStack } from './platform/store.mjs';
import { Selection } from './scheduling/selection.mjs';
import { Sandbox } from './optimization/sandbox.mjs';
import { Calendar, candidateDefaultWorkHours } from './calendar/calendar-engine.mjs';
import { Compute, Alerts, scheduleAlertsForPatches, Utilization } from './insights/services.mjs';
import {
  Engine, snapshotSchedule, applySchedulePatches, effectiveFirmedIdSet,
  deriveSetupObservation, SETUP_AWARE_DEADLINE_MS, MIN_PRODUCTIVE_SEGMENT_MINUTES,
} from './optimization/engine.mjs';
import { Persistence } from './scheduling/persistence.mjs';
import { CalendarSync } from './calendar/calendar-sync.mjs';
import { Session } from './security/session.mjs';
// schedule-workbench.mjs was split in Phase P3 of
// docs/architecture/domain-refactor-plan.md into 6 domain files. The
// __NIMBUS_WORKBENCH bridge below is reconstructed explicitly from their
// named exports so it keeps exposing the exact same 18-key set app.js's
// destructure (and tests/modules/helpers/load-legacy-app.mjs's VM harness)
// already depend on.
import { Timeline, TimelineNav, DependencyOverlay, Hierarchy, GanttFilter, Interaction } from './scheduling/gantt.mjs';
import { Table, Inspector, ContextMenu, Printer } from './scheduling/orders.mjs';
import { OptimizeDialog, OptimizerPreview, SandboxAdapter } from './optimization/optimize-ui.mjs';
import { Dashboard, AlertsUIAdapter } from './insights/insights-ui.mjs';
import { ColorWheelViewer, PriorityListViewer } from './priority-lists/viewers.mjs';
import { EditCalendar } from './calendar/edit-calendar.mjs';
// plant-and-administration.mjs was split in Phase P2 of
// docs/architecture/domain-refactor-plan.md into 9 domain files. The
// __NIMBUS_PLANT_ADMIN bridge below is reconstructed explicitly from their
// named exports so it keeps exposing the exact same key set app.js's
// destructure (and tests/modules/helpers/load-legacy-app.mjs's VM harness)
// already depend on.
import { SetupAdmin } from './setup/setup-admin.mjs';
import { CalendarUI } from './calendar/calendar-admin.mjs';
import { Plant, ProdLines, MasterData } from './master-data/admin-ui.mjs';
import { PriorityListMapping } from './priority-lists/mapping.mjs';
import { LaborPlanning } from './labor/labor-planning.mjs';
import { AdminCockpit, SystemConfig } from './admin-ops/admin-ui.mjs';
import { Interface } from './integration/sap-interface-ui.mjs';
import { Security } from './security/security-admin.mjs';
import { setActiveTabResolvers } from './shell/tab-resolvers.mjs';
import * as shell from './shell/application-shell.mjs';
import * as materialGrids from './master-data/material-grids.mjs';
// Stage 0 setup resolution is a pure module. Keep it in the static module
// graph for build/runtime validation, without exposing a classic-script bridge.
import './setup/setup-domain.mjs';

export function bootEntry({ window: win = (typeof window !== 'undefined' ? window : undefined), loadScript } = {}) {
  if (!win) return Promise.reject(new Error('NIMBUS boot error: no window available for bootEntry'));
  win.__NIMBUS_FOUNDATION = foundation;
  win.__NIMBUS_STATE = { Store, UndoStack, Selection, Sandbox };
  win.__NIMBUS_SERVICES = {
    Calendar, candidateDefaultWorkHours,
    Compute, Alerts, scheduleAlertsForPatches, Utilization,
    Engine, snapshotSchedule, applySchedulePatches, effectiveFirmedIdSet,
    deriveSetupObservation, SETUP_AWARE_DEADLINE_MS, MIN_PRODUCTIVE_SEGMENT_MINUTES,
  };
  win.__NIMBUS_DATA = { Persistence, CalendarSync, Session };
  win.__NIMBUS_WORKBENCH = { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter, Dashboard, Interaction, OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer, PriorityListViewer, Printer, SandboxAdapter, AlertsUIAdapter };
  win.__NIMBUS_PLANT_ADMIN = { SetupAdmin, CalendarUI, Plant, ProdLines, MasterData, PriorityListMapping, LaborPlanning, AdminCockpit, SystemConfig, Interface, Security, setActiveTabResolvers };
  win.__NIMBUS_SHELL = shell;
  win.__NIMBUS_MATERIAL_GRIDS = materialGrids;

  const inject = loadScript || defaultLoadScript;
  const v = win.NIMBUS_BUILD_ID || 'dev';

  return inject(`app.js?v=${encodeURIComponent(v)}`)
    .catch(e => { throw new Error(`NIMBUS boot error: failed to load app.js — ${e.message}`); })
    .then(() => inject(`nimbus-intelligence.js?v=${encodeURIComponent(v)}`)
      .catch(e => { throw new Error(`NIMBUS boot error: failed to load nimbus-intelligence.js — ${e.message}`); }))
    .then(() => {
      // Both classic scripts have now finished executing. app.js destructures
      // everything it needs from these bridges synchronously at the top of its
      // own IIFE, and nimbus-intelligence.js never reads them at all — so the
      // bridge has served its purpose. Delete it rather than leaving it as a
      // permanent, enumerable `window` property: some of what it carries
      // (e.g. PerfMonitor, VirtualList) was never part of the public NIMBUS
      // namespace pre-migration and was reachable only to code sharing the
      // classic-script lexical scope, not to arbitrary window-scoped code.
      delete win.__NIMBUS_FOUNDATION;
      delete win.__NIMBUS_STATE;
      delete win.__NIMBUS_SERVICES;
      delete win.__NIMBUS_DATA;
      delete win.__NIMBUS_WORKBENCH;
      delete win.__NIMBUS_PLANT_ADMIN;
      delete win.__NIMBUS_SHELL;
      delete win.__NIMBUS_MATERIAL_GRIDS;
    });
}

function defaultLoadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`script failed to load: ${src}`));
    document.head.appendChild(el);
  });
}

// Cache-bust redirect guard. Moved here from the top of web/app.js: under the
// pre-CQ-1 `document.write('<script src="app.js">')` load, this ran mid-parse,
// almost immediately. Now that app.js is fetched by a dynamically-created
// <script> from inside bootEntry() (itself only reached after this deferred
// `type="module"` entry point runs, post-full-parse), running the guard at the
// top of app.js would fire it much later — after this file, its static
// imports, and app.js's own network fetch have all completed. Running it here
// instead, before app.js is even requested, recovers most of that gap. Reuses
// `NIMBUS_BUILD_ID` (already the single source of truth for the app.js /
// nimbus-intelligence.js / locale `?v=` cache-busting query params — see
// index.html) instead of tracking a second, separately-bumped version
// constant the way the old app.js guard's `APP_VERSION` did.
export function runCacheBustGuard(win) {
  const KEY = 'nimbus.app.ver';
  const version = win.NIMBUS_BUILD_ID || 'dev';
  let stored;
  try { stored = win.sessionStorage.getItem(KEY); }
  catch { return; } // sessionStorage can throw (e.g. privacy mode) — never block boot on it
  if (stored === version) return;
  try {
    win.sessionStorage.setItem(KEY, version);
    const base = win.location.pathname + win.location.search.replace(/[?&]_v=[^&]*/g, '');
    const sep = base.includes('?') ? '&' : '?';
    win.location.replace(base + sep + '_v=' + version);
  } catch { /* never block boot on a storage/location failure */ }
}

// Auto-boot when this module is the page's real entry point. Under a plain
// Node `import()` (as in tests), `window` is undefined, so this never fires —
// tests call `bootEntry({ window, loadScript })` explicitly instead.
if (typeof window !== 'undefined' && window.document) {
  runCacheBustGuard(window);
  bootEntry().catch(e => {
    console.error('[NIMBUS boot]', e);
    const banner = document.createElement('div');
    banner.className = 'nimbus-boot-error-banner';
    banner.textContent = `NIMBUS failed to load: ${(e && e.message) || e}`;
    document.body.insertBefore(banner, document.body.firstChild);
  });
}
