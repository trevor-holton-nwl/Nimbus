// optimization/headless-runtime.mts: the display-only start derivation for never-placed orders, usable outside a
// browser session.
//
// The browser fills a start date for every order nobody has placed (`/tasks` sends such rows with a finish only)
// by running `Engine.reconcileRuntimeSchedules` after the plant's calendar lands; the optimizer then snapshots the
// Store AFTER that pass. A snapshot built straight from the wire (headless-snapshot.mts) lacks those starts, so
// this module reproduces the pass.
//
// Why it drives the real Store: the reconcile and the finish-anchored placement it calls (`finishAnchoredPatchFor`,
// `heldStartPatchFor`, `placeForwardSequence`, the Calendar walks, `Store.plantNow`) read the Store singleton
// directly, not the detached `_candidateSnapshot` selector the evaluators use. Making all of them snapshot-bound
// would touch the browser's placement paths, so the headless process instead loads the snapshot into its own
// (otherwise empty) Store and runs the unchanged engine code. One plant per process. The Store never leaves the
// process, nothing is saved, and the injected inputs below replace the three browser-only ones: the dirty set
// (`Persistence._dirtyIds`), the calendar hydration state (`CalendarSync`) and the clock (`Store.serverNow`).
import { Store } from '../platform/store.mjs';
import { Toast } from '../platform/foundation.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import { CalendarSync } from '../calendar/calendar-sync.mjs';
import { Engine, snapshotSchedule } from './engine.mjs';
import type { NimbusTask } from '../platform/types.mjs';
import type { ScheduleSnapshot } from './setup-scheduler.mjs';

export interface DeriveOptions {
  plant: string;
  /** The server's current instant (the one clock). */
  serverNow: Date;
  /** True for an order carrying unsaved local edits: the reconcile never re-derives it. Default: none dirty. */
  isDirty?: (id: string) => boolean;
  /** The plant calendar's hydration state. The reconcile derives nothing unless 'hydrated' (OQ51). Default 'hydrated':
   *  the snapshot was built from the server's own calendar body. */
  calendarState?: 'hydrated' | 'pending' | 'failed';
}

/** Drop every Store subscriber. A headless process has no UI, and each hydration write would otherwise wake the
 *  alert recompute. Call once at process start, before any hydration; never in a browser. */
export function quiesceStore(): void {
  Store._listeners.clear();
}

/** Load a plant snapshot into the process's Store, exactly as the browser's load + calendar hydration leave it. */
export function hydrateStoreFromSnapshot(snapshot: ScheduleSnapshot, opts: DeriveOptions): void {
  const { plant, serverNow } = opts;
  const source = 'headless';
  Persistence._dirtyIds.clear();
  Persistence._forceIds.clear();
  Store.setSelectedPlant(plant, source);
  Store.setServerNow(serverNow.toISOString(), Date.now());
  Store.setFrozenHorizonEnd(snapshot.frozenHorizonEnd ? new Date(snapshot.frozenHorizonEnd) : null, source);
  // Line settings first: the plant index built by setTasks resolves lines through them.
  for (const key of Object.keys(Store.lineSettings)) delete Store.lineSettings[key];
  Object.assign(Store.lineSettings, structuredClone(snapshot.lineSettings));
  Store.setMasterData(snapshot.masterData ? structuredClone(snapshot.masterData) : null, source);
  Store.setTasks(structuredClone(snapshot.tasks) as NimbusTask[], source);
  Store.replaceCalendars(structuredClone(snapshot.calendars) as Parameters<typeof Store.replaceCalendars>[0], source);
  Store.replacePlants(structuredClone(snapshot.plants) as Parameters<typeof Store.replacePlants>[0], source);
  Store.replaceBlocks(structuredClone(snapshot.blocks) as Parameters<typeof Store.replaceBlocks>[0], source);
  Store.replacePlantBlocks(structuredClone(snapshot.plantBlocks) as Parameters<typeof Store.replacePlantBlocks>[0], source);
  Store.replaceSetupSnapshot(snapshot.setupSnapshot ? structuredClone(snapshot.setupSnapshot) : null, source);
  Store.setPriorityRankMaps(structuredClone(snapshot.priorityRankMaps), source);
  Store.rebuildPlantIndex();
  // The server's own line rows are the calendars that are not inherited (CalendarSync._applyConfig's `lines`).
  const state = opts.calendarState ?? 'hydrated';
  CalendarSync._setHydration(plant, state, Object.entries(snapshot.calendars).filter(([, c]) => !c.inherited).map(([line]) => line));
  if (opts.isDirty) for (const task of Store.tasksArr) if (opts.isDirty(String(task.id))) Persistence._dirtyIds.add(String(task.id));
}

/** The snapshot the browser would optimize: `snapshot` with the display-derived starts of never-placed orders (and
 *  the dirty re-derivations of stale-flagged rows) applied by the engine's own reconcile. Returns a fresh snapshot;
 *  the input is not modified. Leaves the process Store holding the result (callers may validate against it). */
export function deriveDisplayStarts(snapshot: ScheduleSnapshot, opts: DeriveOptions): ScheduleSnapshot {
  hydrateStoreFromSnapshot(snapshot, opts);
  // The reconcile reports through toasts and the derive-paused banner; a headless run has neither.
  const toast = Toast.show;
  Toast.show = (): void => undefined;
  // One clock for the whole pass. `Store.serverNow()` drifts with wall time since the wire was received, so a derive
  // that straddles a minute boundary would otherwise read two different "now"s (and differ run to run).
  const pinned = opts.serverNow.getTime();
  const store = Store as unknown as { serverNow: () => Date };
  const hadOwn = Object.prototype.hasOwnProperty.call(store, 'serverNow');
  const ownServerNow = store.serverNow;
  store.serverNow = (): Date => new Date(pinned);
  try {
    Engine.reconcileRuntimeSchedules(opts.plant);
  } finally {
    if (hadOwn) store.serverNow = ownServerNow; else delete (store as Partial<typeof store>).serverNow;
    Toast.show = toast;
  }
  return snapshotSchedule(opts.plant);
}
