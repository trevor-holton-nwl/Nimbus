// platform/store.mjs — Store + UndoStack (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-state.mts
// (1,034 lines) into 3 domain files). Owns schedule state, derived indexes,
// undo, and synchronous post-commit events. Every mutator takes a `source`
// and every emitted event carries {type, source, revision, mode, ...}. See
// docs/architecture/cq1-compatibility-inventory.md for the full contract.
//
// `Selection` (scheduling/selection.mjs) and `Sandbox` (optimization/
// sandbox.mjs) are real cross-file imports, not new couplings — they were
// sibling top-level consts in the single-file module and Store.removeTask()/
// Store.mode() already referenced them "before their declaration" in file
// order, safe only because neither call fires until well after module
// evaluation completes. Splitting them into separate files turns that into a
// genuine two-way ESM import cycle (store.mjs ↔ selection.mjs, store.mjs ↔
// sandbox.mjs); it stays safe under the same rule — every cross-reference
// below is inside a method body invoked after both modules finish loading,
// never at top-level evaluation. This is the same pattern already
// established between scheduling/gantt.mjs and scheduling/orders.mjs (Phase
// P3).
import { Config, Util, PerfMonitor, ErrorLog, Toast } from './foundation.mjs';
import { Selection } from '../scheduling/selection.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { activePeriodOn } from '../calendar/calendar-periods.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, NimbusMasterData, NimbusMasterPlant, PriorityRankMaps, SetupSnapshot, StoreEventType, StoreMode, OrderScheduleSegment, PlantCalendarEntry, PlantPeriod } from './types.mjs';

// -- Local type declarations (Phase 2 conversion; scoped to this file) ------
type AllowedPlantsResolver = () => string[] | null;
type SettingsDefaultsResolver = () => Record<string, unknown>;

/** Shared with optimization/sandbox.mjs's SandboxSnapshot (calendars/plants
 *  fields) — exported so that file imports this exact declaration instead of
 *  redeclaring a structurally-identical shadow copy. */
export interface CalendarEntry {
  workHours: WorkHours;
  /** True = the machine has no calendar of its own and follows its plant. Its `workHours` is then "open all
   *  day" (`[0,24]` every weekday) once the line's plant resolves, because every scheduling reader
   *  intersects line hours with the plant's hours for the date; until the plant resolves it holds the
   *  DEFAULT_SHIFT seed. Display and editing code reads `Store.effectiveLineHours`, never this raw value.
   *  Absent/false = the machine has its own saved hours. Optional and additive: no SCHEMA_VERSION bump. */
  inherited?: boolean;
}

/** The raw event object a mutator builds before Store.emit() enriches it with revision/mode. */
interface StoreEventInput {
  type: StoreEventType;
  [key: string]: unknown;
}

/** What a subscriber actually receives — StoreEventInput plus the two fields emit() always adds.
 *  Exported (CQ-1 Phase 6 Task 1) so a module that keeps a named `Store.subscribe` callback as a
 *  real method (rather than an inline arrow relying on contextual inference, e.g. Timeline._onStore
 *  in scheduling/gantt.mjs) can name this type explicitly instead of redeclaring a shadow copy. */
export interface StoreEvent extends StoreEventInput {
  revision: number;
  mode: StoreMode;
}

interface StoreState {
  tasks: Record<string, NimbusTask>;
  dependencies: Record<string, string[]>;
  calendars: Record<string, CalendarEntry>;
  blocks: NimbusBlock[];
  alerts: NimbusAlert[];
  firmedIds: Set<string>;
  meta: { lastOptimize: Date | null };
  plants: Record<string, PlantCalendarEntry>;
  plantBlocks: NimbusPlantBlock[];
  lineSettings: Record<string, NimbusLineSetting>;
  selectedPlant: string | null;
  /** Global cross-screen line filter (Gantt/Orders/Dashboard/Labor Plan/Master Data).
   *  Object identity is never replaced after creation — GanttFilter/Table/Dashboard
   *  alias this exact Set rather than copying it, so their many existing direct
   *  reads keep working; setSelectedLines() always mutates it in place. */
  selectedLines: Set<string>;
  masterData: NimbusMasterData | null;
  /** Stage 3: per-plant rank-map cache for the optimizer's hot path, fetched by
   *  Persistence.loadPriorityRankMaps (scheduling/persistence.mts) on plant load/switch and
   *  after a priority-list upload/delete. Shape: {machine_or_empty: {field_key:
   *  {VALUE: RANK}}} — matches GET /priority-rank-maps verbatim, no reshaping. */
  priorityRankMaps: PriorityRankMaps;
  /** Read-only setup truth for exactly one plant, or null while unavailable/stale.
   * It is intentionally excluded from Persistence's schedule cache/payload. */
  setupSnapshot: SetupSnapshot | null;
  /** Per-plant order distribution summary counts: {needs_review, changed, problems}.
   *  Fetched via GET /distribution/{plant}/summary and cached reactively on plant
   *  selection and schedule hydration (see frontend/insights/services.mts). */
  distributionSummary: { needs_review: number; changed: number; problems: number } | null;
  /** Named fields are guaranteed; Session/DB-sourced prefs beyond them are an open bag (Object.assign in setUserSettings). */
  userSettings: Record<string, unknown> & { alertHorizonMinutes: number | null; confidenceHorizonMinutes: number };
  roleDefaults: Record<string, unknown>;
  /** Admin-configured global default (system_settings.orderFields) for which
   *  optional Orders fields show in the AG Grid / Inspector — see
   *  frontend/order-field-catalog.mjs. Keyed by catalog `key`; absent keys fall
   *  back to the catalog's gridDefault/inspectorDefault. */
  orderFieldVisibility: Record<string, { grid?: boolean; inspector?: boolean }>;
  /** C1 (2026-08-20): the currently-selected plant's visibility-horizon end
   *  instant, as computed server-side and echoed in GET /tasks' `meta.
   *  visibility_horizon_end` — null when unlimited or before any load. Set on
   *  every successful /tasks load (scheduling/persistence.mts) so Timeline.rebuild's
   *  Gantt `max` clamp and Table's Orders-grid filter both read the SAME
   *  already-computed instant instead of each carrying their own copy of the
   *  plant-local-midnight/roll-hour clock math the backend already did. */
  visibilityHorizonEnd: Date | null;
  /** C2 (2026-08-20): the currently-selected plant's frozen-horizon end
   *  instant, as computed server-side and echoed in GET /tasks' `meta.
   *  frozen_horizon_end` — null when off (frozen_horizon_days NULL/0) or
   *  before any load. FALLBACK ONLY since the frozen horizon became a rolling
   *  now + N days window (2026-10-19): the `Store.frozenHorizonEnd` getter
   *  computes the live value from the plant clock and master data, and
   *  returns this cached instant only when the plant's master-data row is
   *  unknown or lacks `frozen_horizon_days`. */
  frozenHorizonEnd: Date | null;
}

interface UndoEntry {
  label: string;
  /** May be async; resolving/returning `false` means the user aborted (entry is kept, no toast). */
  undoFn: () => void | boolean | Promise<void | boolean>;
  at: number;
  /** Task ids this entry restores (optional; entries without ids are never invalidated). */
  ids?: string[];
}

// Two DI seams replace what used to be direct references from Store into modules
// that stay in app.js (Session, Settings) — each defaults to a safe fallback
// (no scoping / no defaults) when unset. Selection needs no such seam: it is a
// real cross-file import (see header comment above) — `removeTask()`
// references it directly — same as `mode()` does for `Sandbox`.
let _allowedPlantsResolver: AllowedPlantsResolver = () => null;
let _settingsDefaultsResolver: SettingsDefaultsResolver = () => ({});

/* =============================================================================
   STORE — single reactive source of truth.
   Every mutation goes through here and fans out to subscribers.
   Subscribers tag their own mutations with `source` so they can skip echoes.
   ========================================================================== */
// Wired at module load (store.mjs imports foundation.mjs, so this is a legal edge, not a cycle): the
// header clock and greeting read the server's instant through Util without Util importing Store.
Util.setServerNowResolver(() => Store.serverNow());
Util.setPlantClockResolver((plant, line) => Store.plantNow(plant || (line ? Store.getPlantForLine(line) : null)));

/** Events that cannot change any input of Utilization.computeMatrix (tasks, line settings, calendars, plants,
 *  blocks, plant blocks, master data, setup snapshot, selected plant). They bump rev() but not dataRev(). */
const DATA_REV_EXCLUDED: ReadonlySet<string> = new Set(['alerts:change', 'lines:selected', 'distribution:summary', 'undo:pushed', 'settings:change', 'tasks:saved']);

export interface ActiveLineHours {
  workHours: WorkHours;
  /** 'period' = a dated plant period covers the day; 'default' = the plant's default week; 'none' = no plant resolves. */
  source: 'period' | 'default' | 'none';
  period: PlantPeriod | null;
}

export const Store = {
  /** ONE clock (backward scheduling OQ52): the server's instant minus this browser's `Date.now()`,
   *  captured on every /tasks load (`setServerNow`, called from Persistence.load). 0 until the first
   *  response arrives (so before then "now" is the browser's own clock, as it always was). Everything
   *  that asks "what time is it at this plant" goes through `plantNow`, never `new Date()`. */
  serverOffsetMs: 0,
  /** Plants whose derivations are blocked because they have no valid IANA timezone (OQ52). Session
   *  only, filled once per plant by `plantNow`; pruned when the plant resolves; the compute core renders it as plant_no_timezone. */
  _blockedPlants: new Set<string>(),
  _tasksByPlant: {} as Record<string, NimbusTask[]>,
  _lineToPlant: {} as Record<string, string | null>,
  _linesByPlant: {} as Record<string, string[]>,
  _masterLinesByPlant: {} as Record<string, NimbusMasterData['lines']>,
  _state: {
    tasks:        {},
    dependencies: {},
    calendars:    {},
    blocks:       [],
    alerts:       [],
    firmedIds:    new Set<string>(),
    meta:         { lastOptimize: null },
    plants:       {},
    plantBlocks:  [],
    lineSettings: {},
    selectedPlant: null,
    selectedLines: new Set<string>(),
    masterData: null,
    priorityRankMaps: {},
    setupSnapshot: null,
    distributionSummary: null,
    userSettings: { alertHorizonMinutes: null, confidenceHorizonMinutes: 20160 },
    roleDefaults: {},
    orderFieldVisibility: {},
    visibilityHorizonEnd: null,
    frozenHorizonEnd: null
  } as StoreState,
  _listeners: new Set<((event: StoreEvent) => void) & { _pmLabel?: string }>(),
  // Lazily populated by alertsByTask() below — declared here (not left to first
  // assignment) because plain object-literal properties, unlike class fields
  // assigned in a constructor, need their type fixed at the literal's declaration.
  _alertsByTaskSrc: null as NimbusAlert[] | null,
  _alertsByTask: new Map<string, NimbusAlert[]>(),
  // Lazily populated by siblingsByParent() below — same reasoning as
  // _alertsByTaskSrc above (plain object-literal property, type fixed here).
  _siblingsByParentSrc: null as { rev: number; plant: string | null; tasks: Record<string, NimbusTask> } | null,
  _siblingsByParent: new Map<string, NimbusTask[]>(),
  // Set by emit() on first mutation; read by rev(). Same reasoning as above.
  _rev: 0,
  // Data revision: bumped by emit() for every event EXCEPT DATA_REV_EXCLUDED. Read by dataRev().
  _dataRev: 0,
  // Last emitted event, for the ErrorLog 'platform' state provider (tail of this module).
  _lastEvent: null as { type: string; source?: string; revision: number; ts: number } | null,

  setAllowedPlantsResolver(fn: AllowedPlantsResolver): void { _allowedPlantsResolver = typeof fn === 'function' ? fn : () => null; },
  setSettingsDefaultsResolver(fn: SettingsDefaultsResolver): void { _settingsDefaultsResolver = typeof fn === 'function' ? fn : () => ({}); },
  rev(): number { return this._rev || 0; },
  /** Revision of the data utilization (and similar read-models) is computed from. Unlike rev() it does NOT
   *  bump for events that cannot change tasks/calendars/blocks/setup (alerts:change, lines:selected, ...), so a
   *  read-model keyed on it survives them. Bumped BEFORE listeners run. An exclusion list on purpose: an event
   *  missing from it only costs one extra recompute, never stale data. */
  dataRev(): number { return this._dataRev || 0; },
  // 'draft' once What-If mode is active. `Sandbox` is a real cross-file import
  // (optimization/sandbox.mjs, see this file's header comment) forming a
  // two-way ESM cycle with this module — safe because mode() is never
  // *called* until well after both modules finish loading.
  mode(): StoreMode { return (typeof Sandbox !== 'undefined' && Sandbox.active) ? 'draft' : 'live'; },

  /* ----- basic access ---------------------------------------------------- */
  get state(): StoreState     { return this._state; },
  get tasks(): Record<string, NimbusTask>     { return this._state.tasks; },
  get blocks(): NimbusBlock[]    { return this._state.blocks; },
  get alerts(): NimbusAlert[]    { return this._state.alerts; },
  get calendars(): Record<string, CalendarEntry> { return this._state.calendars; },
  get firmedIds(): Set<string> { return this._state.firmedIds; },
  get tasksArr(): NimbusTask[]      { return Object.values(this._state.tasks); },
  get plants(): Record<string, PlantCalendarEntry>        { return this._state.plants; },
  get plantBlocks(): NimbusPlantBlock[]   { return this._state.plantBlocks; },
  get lineSettings(): Record<string, NimbusLineSetting>  { return this._state.lineSettings; },
  get selectedPlant(): string | null { return this._state.selectedPlant; },
  // Live reference (same convention as firmedIds above) — callers that alias this
  // Set (GanttFilter/Table/Dashboard) see every future in-place mutation for free.
  get selectedLines(): Set<string> { return this._state.selectedLines; },
  get userSettings(): StoreState['userSettings']  { return this._state.userSettings; },
  get roleDefaults(): Record<string, unknown>  { return this._state.roleDefaults; },
  get masterData(): NimbusMasterData | null    { return this._state.masterData; },
  get priorityRankMaps(): PriorityRankMaps { return this._state.priorityRankMaps; },
  get setupSnapshot(): SetupSnapshot | null { return this._state.setupSnapshot; },
  get distributionSummary(): { needs_review: number; changed: number; problems: number } | null { return this._state.distributionSummary; },
  get dependencies(): Record<string, string[]>  { return this._state.dependencies; },
  get orderFieldVisibility(): StoreState['orderFieldVisibility'] { return this._state.orderFieldVisibility; },
  get visibilityHorizonEnd(): Date | null { return this._state.visibilityHorizonEnd; },
  /** Rolling frozen-horizon far edge (2026-10-19): plant-local NOW + `frozen_horizon_days` wall-clock
   *  days, computed live on every read from the selected plant's clock (`plantNow`) and its master-data
   *  row, so both edges of the frozen window advance with the clock like the alert horizon. This is the
   *  one source every reader sees (Engine helpers, the optimizer snapshot, Gantt band/ticker/lock scan).
   *  Row present with NULL/0 days -> null (off); row present with no usable plant clock -> null (never
   *  throws). Only when the plant's master-data row is unknown, or does not carry the
   *  `frozen_horizon_days` key at all (master data not loaded yet; cache-only boot), does it fall back
   *  to the server-resolved instant cached from /tasks `meta` (`setFrozenHorizonEnd`). */
  get frozenHorizonEnd(): Date | null {
    return this.frozenHorizonEndFor(this._state.selectedPlant);
  },
  /** The same rolling edge for an explicit plant (a task's own plant, not the selected one). */
  frozenHorizonEndFor(plant: string | null | undefined): Date | null {
    const row = plant ? this._state.masterData?.plants?.find(p => p.plant === plant) : undefined;
    if (row && row.frozen_horizon_days !== undefined) {
      const days = row.frozen_horizon_days;
      if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return null;
      const now = this.plantNow(plant);
      if (!now) return null;
      const end = new Date(now.getTime());
      end.setDate(end.getDate() + Math.trunc(days));   // wall-clock days, same as the server's timedelta on the plant-local clock
      return end;
    }
    return this._state.frozenHorizonEnd;
  },
  /** Read the timestamp of the most recent optimizer run. Return a detached
   * Date so callers cannot mutate Store's metadata without going through the
   * setter. */
  get lastOptimize(): Date | null {
    const date = this._state.meta.lastOptimize;
    return date ? new Date(date) : null;
  },

  isFirmed(id: string | number): boolean    { return this._state.firmedIds.has(String(id)); },

  /** Record the timestamp of the last optimizer run. Public equivalent of the
   *  former direct `Store._state.meta.lastOptimize = ...` write (CQ-1 Phase 2
   *  Task 3 — closes Engine's `_state` touch, one of the tracked §6 exceptions).
   *  Deliberately does NOT call `emit()`: the original direct field write fired
   *  no Store event, and `runAndApply` calls this setter unconditionally on every
   *  run (including true no-ops with `patches.length === 0`) — emitting here would
   *  spuriously bump `Store._rev` and trigger the debounced autosave subscriber on
   *  every optimize call, a real behavior change this setter must not introduce.
   *  `source` is accepted only for signature symmetry with the other setters. */
  setLastOptimize(date: Date | null, _source?: string): void {
    this._state.meta.lastOptimize = date ? new Date(date) : null;
  },

  /** Replace the master-data snapshot ({plants, lines} from /master-data/*) wholesale
   *  and rebuild the derived line→plant index, mirroring the exact 3-statement sequence
   *  every call site used to repeat verbatim. Public equivalent of the former direct
   *  `Store._state.masterData = {...}` write (CQ-1 Phase 2 Task 4 — closes Persistence's
   *  `_state` touch, one of the tracked §6 exceptions). */
  setMasterData(masterData: NimbusMasterData | null, source?: string, table?: string): void {
    this._state.masterData = masterData;
    this.rebuildPlantIndex();
    // `table` (optional) names the master-data table whose save triggered this write, so a
    // subscriber can react to just 'plants'/'machine'/'sap_workcenter'. Boot and Refresh omit it.
    this.emit(table ? { type: 'master-data-changed', source, table } : { type: 'master-data-changed', source });
  },

  /** Replace the admin-configured global Orders field-visibility default
   *  (system_settings.orderFields) wholesale. Global/system-tier, not part of
   *  the per-user Store.pref() 3-tier resolution — every user sees the same
   *  value, with no per-user override. */
  setOrderFieldVisibility(cfg: Record<string, { grid?: boolean; inspector?: boolean }> | null | undefined, source?: string): void {
    this._state.orderFieldVisibility = (cfg && typeof cfg === 'object') ? { ...cfg } : {};
    this.emit({ type: 'order-field-visibility:changed', source });
  },

  /** Replace the priority rank-map cache wholesale (Stage 3). Populated by
   *  Persistence.loadPriorityRankMaps (schedule-data.mts) — this setter itself stays
   *  ignorant of which plant the maps belong to; that freshness tracking lives on the
   *  fetcher side as `Persistence._rankMapsPlant`, mirroring how `Persistence._currentLoadedPlant`
   *  already tracks freshness for the sibling tasks/calendars cache rather than Store itself.
   *
   *  Deliberately does NOT call `emit()` — the same rule, for the same reason,
   *  as `setLastOptimize` above. `Store.subscribe` has one subscriber with no
   *  event-type filter (`Persistence.autosave`, application-shell.mts), so any
   *  emit here would schedule a full localStorage cache write and bump
   *  `Store._rev` and `dataRev()` (a non-excluded event would evict the shared
   *  utilization cache, which is keyed on `dataRev()`) on every rank load — including one per Optimize-dialog open and
   *  one per Scheduling Constraints render, neither of which changes any
   *  schedule data. Nothing subscribes to rank-map changes: every reader
   *  (`Engine._sortTerms`' terms, `hasPriorityRanks`, `unrankedActiveFields`)
   *  pulls on demand. `_source` is accepted only for signature symmetry with
   *  the other setters, exactly as in `setLastOptimize`. */
  setPriorityRankMaps(maps: PriorityRankMaps, _source?: string): void {
    this._state.priorityRankMaps = maps || {};
  },

  /** Replace the C1 visibility-horizon end instant for whichever plant just
   *  loaded (schedule-data.mts's Persistence.load, from GET /tasks' `meta.
   *  visibility_horizon_end`). No `emit()` — same reasoning as
   *  setPriorityRankMaps above: this always changes alongside a tasks load,
   *  which already triggers its own 'schedule:hydrated' event and the
   *  Timeline.rebuild()/Table refresh that reads this value, so a second
   *  event here would be redundant, not additive. `_source` is accepted only
   *  for signature symmetry with the other setters. */
  setVisibilityHorizonEnd(end: Date | null, _source?: string): void {
    this._state.visibilityHorizonEnd = end;
  },

  /** Replace the C2 frozen-horizon end instant for whichever plant just
   *  loaded (schedule-data.mts's Persistence.load, from GET /tasks' `meta.
   *  frozen_horizon_end`). No `emit()` — same reasoning as
   *  setVisibilityHorizonEnd above. */
  setFrozenHorizonEnd(end: Date | null, _source?: string): void {
    this._state.frozenHorizonEnd = end;
  },

  /** Capture the server clock from a /tasks response's `meta.server_now` (ISO-8601 UTC). A missing or
   *  unparsable value leaves the last good offset in place. `receivedAtMs` is the browser clock at
   *  receipt (injectable for tests). */
  setServerNow(serverNowIso: unknown, receivedAtMs: number = Date.now()): void {
    if (typeof serverNowIso !== 'string' || !serverNowIso) return;
    const serverMs = new Date(serverNowIso).getTime();
    if (!Number.isFinite(serverMs)) return;
    this.serverOffsetMs = serverMs - receivedAtMs;
  },

  /** The server's current instant, as a real (absolute) Date. */
  serverNow(): Date {
    return new Date(Date.now() + this.serverOffsetMs);
  },

  /** "Now" at a plant: the server instant projected into the plant's IANA zone, as the naive
   *  wall-clock Date every schedule derivation compares against (same convention as task dates).
   *  Returns null when the plant has no valid timezone, or when there is no plant to ask about; a
   *  plant that exists in master data but has no valid zone is also recorded in `_blockedPlants` and
   *  announced once per session (toast now, alert in Task 3.3). A plant master data does not know yet
   *  (not loaded) is NOT recorded: that is "not loaded", not "misconfigured". */
  plantNow(plant: string | null | undefined): Date | null {
    if (!plant) return null;
    const row = this._state.masterData?.plants?.find(p => p.plant === plant);
    const tz = typeof row?.timezone === 'string' ? row.timezone.trim() : '';
    const wall = tz ? globalThis.NimbusComputeCore!.plantWallClockFromInstant(tz, this.serverNow()) : null;
    if (wall) { this._blockedPlants.delete(plant); return wall; }   // a plant that resolves is no longer blocked
    if (row && !this._blockedPlants.has(plant)) {
      this._blockedPlants.add(plant);
      Toast.show(Util.t('toast.plant_no_timezone', { plant }), 'warn', 9000);
    }
    return null;
  },

  /** Replace the one active plant's read-only setup snapshot. Unlike priority
   * maps this publishes a dedicated event so later observation-only setup views
   * can render promptly; Persistence deliberately never serializes it into the
   * schedule cache or update payload. */
  replaceSetupSnapshot(snapshot: SetupSnapshot | null, source?: string): void {
    this._state.setupSnapshot = snapshot;
    this.emit({ type: 'setup-snapshot:replace', snapshot, source });
  },

  /** Set the per-plant order distribution summary counts. Fetched reactively by
   * frontend/insights/services.mts on plant selection and schedule hydration.
   * Emits a `distribution:summary` event so the Distribution tab and Dashboard
   * summary can update synchronously. */
  setDistributionSummary(summary: { needs_review: number; changed: number; problems: number } | null, source?: string): void {
    this._state.distributionSummary = summary;
    this.emit({ type: 'distribution:summary', summary, source });
  },

  /* ----- subscription ---------------------------------------------------- */
  subscribe(fn: ((event: StoreEvent) => void) & { _pmLabel?: string }, label?: string): () => void {
    if (label) fn._pmLabel = label;
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  },
  emit(event: StoreEventInput): void {
    // event: { type, source?, id?, changes?, ... }
    // Monotonic revision — any state change bumps it. Used as a cheap, always-correct
    // cache key by memoized read-models (e.g. Utilization.computeMatrix).
    this._rev = (this._rev || 0) + 1;
    if (!DATA_REV_EXCLUDED.has(event.type)) this._dataRev = (this._dataRev || 0) + 1;
    // revision/mode are additive — existing listeners that only read
    // evt.type/evt.source/etc. are unaffected.
    const enriched: StoreEvent = { ...event, revision: this._rev, mode: this.mode() };
    this._lastEvent = { type: enriched.type, source: typeof enriched.source === 'string' ? enriched.source : undefined, revision: this._rev, ts: Date.now() };
    for (const l of this._listeners) {
      const _t = performance.now();
      try { l(enriched); } catch (e) {
        ErrorLog.error('store', 'listener error: ' + (e instanceof Error ? e.message : String(e)),
          { event: enriched.type, source: enriched.source, listener: l._pmLabel || l.name || '?' },
          { stack: e instanceof Error ? e.stack : undefined, errorCode: 'store.listener' });
      }
      finally { PerfMonitor.record('store:' + (l._pmLabel || l.name || '?'), performance.now() - _t); }
    }
  },

  /* ----- mutations ------------------------------------------------------- */
  // Replace all tasks (e.g. after backend load or optimiser run).
  setTasks(tasks: NimbusTask[], source?: string): { inserted: number; collisions: number } {
    this._state.tasks = {};
    // firmedIds is derived from task.firmed (server state) on every wholesale
    // load, so a stale local id (old browser firm, previous plant) cannot survive.
    this._state.firmedIds.clear();
    let collisions = 0;
    const collisionSamples: Array<{ id: string; text?: string; line: string }> = [];
    for (const t of tasks) {
      Store._normalizeDates(t);
      if (t.id == null || String(t.id).trim() === '') {
        if (typeof ErrorLog !== 'undefined') {
          ErrorLog.error('store', 'setTasks: task with null/empty id — skipped', t);
        }
        continue;
      }
      const key = String(t.id);
      if (Object.prototype.hasOwnProperty.call(this._state.tasks, key)) {
        collisions++;
        if (collisionSamples.length < 5) collisionSamples.push({ id: key, text: t.text, line: t.MACHINE });
      }
      this._state.tasks[key] = t;
    }
    if (collisions && typeof ErrorLog !== 'undefined') {
      ErrorLog.error('store',
        `setTasks silently overwrote ${collisions} duplicate id(s) — rows were LOST`,
        collisionSamples);
    }
    this.rebuildPlantIndex();
    this.emit({ type: 'tasks:bulk', source });
    return { inserted: Object.keys(this._state.tasks).length, collisions };
  },

  /** `user_scheduled` is the server's "a planner placed this row" wire flag and nothing else updates it on the
   *  client. A client write that gives the row both edges (a drop, a grid/Inspector edit, Override, an optimizer
   *  apply, a release, Push +1 hour, a dirty reconcile patch) is a placement, so the row is placed locally from
   *  then on; display-only derivations, server refreshes, undo/What-If restores and distribution's own saves are
   *  not. Without this a dirty, planner-placed row would read as never-placed and be re-derived from its due date. */
  _markPlaced(task: NimbusTask, changes: Partial<NimbusTask>, source?: string): void {
    if (!changes.start_date || !changes.end_date || task.user_scheduled) return;
    if (source === 'refresh' || source === 'engine-runtime-reconcile-display' || source === 'undo'
      || source === 'sandbox' || source === 'distribution' || source === 'note' || source === 'time-machine') return;
    // VI8: a Time Machine restore replays display-derived dates; reconcileRestored decides what is a placement.
    task.user_scheduled = true;
  },

  /** The session-only derivation notes (`derivationIssue`, `systemMove`) describe the engine's last derivation of
   *  a row. The next edit of its dates, machine or run time makes them stale, so a change-set that touches
   *  those fields and does not itself carry a note clears them (the reconcile always carries both). */
  _clearStaleNotes(task: NimbusTask, changes: Partial<NimbusTask>): void {
    if (!('start_date' in changes || 'end_date' in changes || 'MACHINE' in changes || 'RUN_TIME' in changes)) return;
    if (!('derivationIssue' in changes) && task.derivationIssue) task.derivationIssue = null;
    if (!('systemMove' in changes) && task.systemMove) task.systemMove = null;
  },

  // Update one task with a partial change-set.
  // NOTE: we replace the task *reference* (prev → next) rather than mutating
  // in place, so subscribers (e.g. AG Grid, diff-rebuild) can diff by identity.
  // Backwards-compatible: the emitted event still carries {id, changes, source};
  // {prev, next} are additive fields for consumers that want them.
  updateTask(id: string, changes: Partial<NimbusTask>, source?: string): void {
    const prev = this._state.tasks[id];
    if (!prev) return;
    const next = { ...prev, ...changes };
    if (changes.planning_status === undefined && changes.start_date && changes.end_date) {
      next.planning_status = 'scheduled';
      next.planning_reason = null;
    }
    Store._clearStaleNotes(next, changes);
    Store._markPlaced(next, changes, source);
    Store._normalizeDates(next);
    this._state.tasks[id] = next;
    // Keep the _tasksByPlant index coherent with this reference swap. That index caches
    // task *references* captured at the last rebuildPlantIndex(); replacing prev→next
    // above would otherwise leave it pointing at the stale pre-edit object, so
    // tasksForSelectedPlant() → Timeline.rebuild() (fired by the post-edit alerts
    // recompute via alerts:change) would repaint the task at its OLD position — this is
    // the single-drag "spring-back". updateMany() mutates in place so it stays coherent
    // on its own; only this reference-replacing path needs the fix-up.
    Store._reindexTask(prev, next);
    this.emit({ type: 'task:update', id, prev, next, changes, source });
  },

  // Remove a task, cleaning up dependencies, firmedIds, and (if present)
  // the Selection set. Emits 'task:remove'.
  removeTask(id: string | number, source?: string): NimbusTask | null {
    const key = String(id);
    const prev = this._state.tasks[key];
    if (!prev) return null;
    delete this._state.tasks[key];
    const plant = prev.PLANT || Store.getPlantForLine(prev.MACHINE);
    const bucket = plant ? Store._tasksByPlant[plant] : null;
    if (bucket) {
      const index = bucket.findIndex(task => String(task.id) === key);
      if (index >= 0) bucket.splice(index, 1);
    }

    // Clean up dependency graph both ways.
    const deps = this._state.dependencies;
    if (deps[key]) delete deps[key];
    for (const target of Object.keys(deps)) {
      const arr = deps[target];
      const i = arr.indexOf(key);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length) delete deps[target];
    }

    this._state.firmedIds.delete(key);
    // `Selection` is a real cross-file import (scheduling/selection.mjs, see
    // this file's header comment) forming a two-way ESM cycle with this
    // module — safe because removeTask() is never *called* until well after
    // both modules finish loading (same reasoning as Store.mode()'s
    // reference to Sandbox, above).
    if (typeof Selection !== 'undefined') Selection.remove(key);
    this.emit({ type: 'task:remove', id: key, prev, source });
    return prev;
  },

  // Update several tasks at once (used by the optimiser).
  updateMany(patches: Array<{ id: string; changes: Partial<NimbusTask> }>, source?: string): void {
    // patches: [{id, changes}]
    for (const p of patches) {
      const task = this._state.tasks[p.id];
      if (!task) continue;
      Object.assign(task, p.changes);
      Store._clearStaleNotes(task, p.changes);
      Store._markPlaced(task, p.changes, source);
      if (p.changes.planning_status === undefined && p.changes.start_date && p.changes.end_date) {
        task.planning_status = 'scheduled';
        task.planning_reason = null;
      }
      Store._normalizeDates(task);
    }
    this.emit({ type: 'tasks:bulkUpdate', ids: patches.map(p => p.id), source });
  },

  // Toggle firmed flag on a task (or group of tasks).
  setFirmed(ids: string | number | Array<string | number>, firmed: boolean, source?: string): void {
    const arr = Array.isArray(ids) ? ids : [ids];
    for (const id of arr) {
      const key = String(id);
      if (firmed) this._state.firmedIds.add(key);
      else        this._state.firmedIds.delete(key);
      const t = this._state.tasks[id];
      if (t) t.firmed = !!firmed;
    }
    this.emit({ type: 'firmed:change', ids: arr, firmed, source });
  },

  /* ----- calendar & blocks ---------------------------------------------- */
  /** An explicit machine edit: the line now has its own hours (never inherited). */
  setCalendar(line: string, workHours: WorkHours, source?: string): void {
    if (!this._state.calendars[line]) this._state.calendars[line] = { workHours: {} };
    this._state.calendars[line].workHours = workHours;
    this._state.calendars[line].inherited = false;
    this.emit({ type: 'calendar:change', line, source });
  },
  /** The week a line holds while its plant is unknown: Config.DEFAULT_SHIFT (weekends off when configured). */
  _defaultShiftWeek(): WorkHours {
    const week: WorkHours = {};
    for (let d = 0; d < 7; d++) {
      week[d] = Config.WEEKEND_OFF && (d === 0 || d === 6) ? null : [...Config.DEFAULT_SHIFT] as [number, number];
    }
    return week;
  },
  _isAllDay(wh: WorkHours): boolean {
    for (let d = 0; d < 7; d++) { const r = wh[d]; if (!r || r[0] !== 0 || r[1] !== 24) return false; }
    return true;
  },
  /** The seed for an inherited line: open all day when the plant resolves (scheduling intersects it with the
   *  plant's hours per date), else the DEFAULT_SHIFT week (nothing would bound it). */
  _inheritedSeed(line: string): WorkHours {
    if (!this.getPlantForLine(line)) return this._defaultShiftWeek();
    const week: WorkHours = {};
    for (let d = 0; d < 7; d++) week[d] = [0, 24];
    return week;
  },
  ensureCalendar(line: string): void {
    if (this._state.calendars[line]) return;
    this._state.calendars[line] = { workHours: this._inheritedSeed(line), inherited: true };
  },
  /** Make a line follow its plant (no machine calendar of its own). Emits `calendar:change` only when a
   *  `source` is given, so a bulk caller (hydration) can emit once itself. */
  inheritPlantHours(line: string, source?: string): void {
    this._state.calendars[line] = { workHours: this._inheritedSeed(line), inherited: true };
    if (source) this.emit({ type: 'calendar:change', line, source });
  },
  /** The hours to SHOW or EDIT for a line: the plant's default week for an inherited line, the saved hours
   *  otherwise. Never feed this to a scheduling reader: those intersect the raw `workHours` with the plant's
   *  hours per date, and a default week would hide a dated period. The result may be the plant's own object. */
  effectiveLineHours(line: string): WorkHours {
    const entry = this._state.calendars[line];
    if (entry && !entry.inherited) return entry.workHours;
    const plant = this.getPlantForLine(line);
    return (plant ? this._state.plants[plant]?.workHours : undefined) ?? this._defaultShiftWeek();
  },
  /** The hours a line actually works on `date` (default: today on the plant clock), with where they come from.
   *  An inherited line shows the plant pattern active that day (the dated period when one covers it, else the
   *  default week); an override is intersected with that pattern per weekday, the same math as the compute
   *  core's workWindow. For DISPLAY (Machines pane); scheduling readers keep using the raw `calendars`. */
  activeLineHoursOn(line: string, date?: Date): ActiveLineHours {
    const own = this._state.calendars[line];
    const override = own && !own.inherited ? own.workHours : null;
    const plant = this.getPlantForLine(line);
    if (!plant) return { workHours: override ?? this._defaultShiftWeek(), source: 'none', period: null };
    const entry = this._state.plants[plant];
    const d = date ?? this.plantNow(plant) ?? new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const period = activePeriodOn(entry?.periods, key);
    const pattern = period ? period.workHours : (entry?.workHours ?? this._defaultShiftWeek());
    const source = period ? 'period' : 'default';
    if (!override) return { workHours: pattern, source, period };
    const week: WorkHours = {};
    for (let dow = 0; dow < 7; dow++) {
      const a = override[dow], b = pattern[dow];
      if (!a || !b) { week[dow] = null; continue; }
      const s = Math.max(a[0], b[0]), e = Math.min(a[1], b[1]);
      week[dow] = s < e ? [s, e] : null;
    }
    return { workHours: week, source, period };
  },
  addBlock(block: NimbusBlock, source?: string): void {
    if (Config.DEBUG_BLOCKS) console.trace('[addBlock]', { source, block });
    const newS = Util.parseDate(block.start)?.getTime();
    const newE = Util.parseDate(block.end)?.getTime();
    const dup = this._state.blocks.find(b =>
      (b.line || '') === (block.line || '') &&
      (b.plant || '') === (block.plant || '') &&   // scope dedup per-plant so same-time
      Util.parseDate(b.start)?.getTime() === newS &&  // blackouts on different plants coexist (F5)
      Util.parseDate(b.end)?.getTime()   === newE &&
      (b.reason || '') === (block.reason || '')
    );
    if (dup) {
      ErrorLog.warn?.('store', `Refused duplicate line blackout (line=${block.line||'*'}, ${block.start}→${block.end}, reason="${block.reason||''}") from source="${source}"`);
      return;
    }
    if (!block.id) block.id = Util.uid('blk');
    this._state.blocks.push(block);
    this.emit({ type: 'blocks:change', source });
  },
  removeBlock(blockId: string, source?: string): void {
    const i = this._state.blocks.findIndex(b => b.id === blockId);
    if (i >= 0) {
      this._state.blocks.splice(i, 1);
      this.emit({ type: 'blocks:change', source });
    }
  },

  /* ----- plants & plant-blocks ------------------------------------------ */
  ensurePlant(name: string | null): void {
    if (!name) return;
    if (this._state.plants[name]) return;
    const defaults: WorkHours = {};
    for (let d = 0; d < 7; d++) {
      if (Config.WEEKEND_OFF && (d === 0 || d === 6)) defaults[d] = null;
      else defaults[d] = [...Config.DEFAULT_SHIFT] as [number, number];
    }
    this._state.plants[name] = { workHours: defaults };
  },
  setPlantWorkHours(plant: string, dow: number, range: [number, number] | null, source?: string): void {
    this.ensurePlant(plant);
    this._state.plants[plant].workHours[dow] = range;
    this.emit({ type: 'calendar:change', source });
  },
  /** Dated plant periods, ascending by validFrom; `[]` when the plant has none. */
  getPlantPeriods(plant: string): PlantPeriod[] {
    return this._state.plants[plant]?.periods ?? [];
  },
  /** Replace a plant's period list (acknowledged by the server, or local-only in What-If). An empty list
   *  deletes the key so JSON diffs of `plants` stay stable. Always emits `calendar:change` so the
   *  rev-keyed caches (Utilization, Dashboard) invalidate. `source` must not be 'calendar-sync'. */
  setPlantPeriods(plant: string, periods: PlantPeriod[], source?: string): void {
    this.ensurePlant(plant);
    const entry = this._state.plants[plant];
    if (periods.length) entry.periods = [...periods].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
    else delete entry.periods;
    this.emit({ type: 'calendar:change', source, plant });
  },
  addPlantBlock(block: NimbusPlantBlock, source?: string): void {
    if (Config.DEBUG_BLOCKS) console.trace('[addPlantBlock]', { source, block });
    const newS = Util.parseDate(block.start)?.getTime();
    const newE = Util.parseDate(block.end)?.getTime();
    const dup = this._state.plantBlocks.find(b =>
      (b.plant || '') === (block.plant || '') &&
      Util.parseDate(b.start)?.getTime() === newS &&
      Util.parseDate(b.end)?.getTime()   === newE &&
      (b.reason || '') === (block.reason || '')
    );
    if (dup) {
      ErrorLog.warn?.('store', `Refused duplicate plant blackout (plant=${block.plant||'*'}, ${block.start}→${block.end}, reason="${block.reason||''}") from source="${source}"`);
      return;
    }
    if (!block.id) block.id = Util.uid('pblk');
    this._state.plantBlocks.push(block);
    this.emit({ type: 'plantBlocks:change', source });
  },
  /** Edit a plant blackout in place of the old one (same id/plant, new object so
   *  value-based change detection sees it). False when the block is gone or the
   *  edit would duplicate another block. */
  updatePlantBlock(id: string, plant: string, patch: { start: Date | string; end: Date | string; reason: string }, source?: string): boolean {
    const i = this._state.plantBlocks.findIndex(b => b.id === id && (b.plant || '') === (plant || ''));
    if (i < 0) return false;
    const newS = Util.parseDate(patch.start)?.getTime();
    const newE = Util.parseDate(patch.end)?.getTime();
    const dup = this._state.plantBlocks.find((b, j) =>
      j !== i &&
      (b.plant || '') === (plant || '') &&
      Util.parseDate(b.start)?.getTime() === newS &&
      Util.parseDate(b.end)?.getTime()   === newE &&
      (b.reason || '') === (patch.reason || '')
    );
    if (dup) {
      ErrorLog.warn?.('store', `Refused duplicate plant blackout edit (plant=${plant||'*'}, id=${id}) from source="${source}"`);
      return false;
    }
    this._state.plantBlocks[i] = { ...this._state.plantBlocks[i], start: patch.start, end: patch.end, reason: patch.reason } as NimbusPlantBlock;
    this.emit({ type: 'plantBlocks:change', source });
    return true;
  },
  removePlantBlock(id: string, source?: string): void {
    const i = this._state.plantBlocks.findIndex(b => b.id === id);
    if (i >= 0) {
      this._state.plantBlocks.splice(i, 1);
      this.emit({ type: 'plantBlocks:change', source });
    }
  },

  /* ----- line settings -------------------------------------------------- */
  ensureLineSettings(line: string): void {
    if (this._state.lineSettings[line]) return;
    this._state.lineSettings[line] = {
      plant: null,
      bufferUnit: 'pct',
      bufferPct: 0,
      bufferHours: 0,
      bottleneck: false,
      excludeFromOpt: false,
      plGroup: '',
      sapWorkcenter: null,
      distributionWeight: null,
    };
  },
  /** Copy the master `machine` rows (`masterData.lines`) into `lineSettings` with direct writes
   *  (no per-line emit — the caller coalesces one 'lineSettings:change' and rebuilds the plant
   *  index when this returns > 0). Moved out of app.js's master-data-changed subscriber so it is
   *  typechecked and testable; also carries sap_workcenter + distribution_weight, which the
   *  Machines pane reads. Returns how many lines changed. */
  applyMasterLinesToSettings(): number {
    const mdLines = (this._state.masterData?.lines ?? []) as unknown as Array<Record<string, unknown>>;
    let touched = 0;
    for (const row of mdLines) {
      const line = row.machine as string | undefined;
      if (!line) continue;
      this.ensureLineSettings(line);
      const ls = this._state.lineSettings[line];
      const before = JSON.stringify(ls);
      ls.excludeFromOpt = row.excl_optimizer === 'X';
      ls.bottleneck     = row.bottleneck === 'X';
      if (row.buffer_type === '%')        ls.bufferUnit = 'pct';
      else if (row.buffer_type === 'hrs') ls.bufferUnit = 'hours';
      if (row.buffer_percent != null && row.buffer_percent !== '')
        ls.bufferPct = parseFloat(String(row.buffer_percent)) || 0;
      if (row.buffer_hours != null && row.buffer_hours !== '')
        ls.bufferHours = parseFloat(String(row.buffer_hours)) || 0;
      ls.plGroup = (row.wc_group as string) || '';
      ls.plant   = (row.plant as string) || null;
      ls.sapWorkcenter = (row.sap_workcenter as string) || null;
      ls.distributionWeight = row.distribution_weight == null ? null : Number(row.distribution_weight);
      if (JSON.stringify(ls) !== before) touched++;
    }
    return touched;
  },
  setLineSetting(line: string, patch: Partial<NimbusLineSetting>, source?: string): void {
    this.ensureLineSettings(line);
    Object.assign(this._state.lineSettings[line], patch);
    // Only a `plant` change can move a line between plant buckets — skip the
    // index/cache rebuild for the common buffer/group/flag edits that can't.
    if ('plant' in patch) this.rebuildPlantIndex();
    this.emit({ type: 'lineSettings:change', line, source });
  },
  getPlantForLine(line: string): string | null {
    const fromSettings = (this._state.lineSettings[line] || {}).plant;
    if (fromSettings) return fromSettings;
    // O(1) cache (line → master-data plant), rebuilt alongside _tasksByPlant. Consulted
    // before the linear .find fallback so this stays O(1) on hot paths (tasksForSelectedPlant,
    // worker snapshots, util matrix builds). A miss falls through to the authoritative scan.
    const cached = this._lineToPlant[line];
    if (cached) return cached;
    const mdLine = (this._state.masterData?.lines ?? []).find(r => r.machine === line);
    if (mdLine?.plant) return mdLine.plant;
    // Task payloads carry an explicit PLANT even when master-data hydration is
    // incomplete. Use that as the final ownership fallback so calendar flushes,
    // plant indexes, and What-If promotion do not silently omit an otherwise
    // identifiable line. Lines are plant-owned; if malformed data repeats a
    // line across plants, the first explicit owner is the deterministic choice.
    return this.tasksArr.find(t => t.MACHINE === line && t.PLANT)?.PLANT ?? null;
  },
  setSelectedPlant(plant: string | null, source?: string): void {
    const next = plant || null;
    if (next === this._state.selectedPlant) return; // no-op: don't re-emit
    this._state.selectedPlant = next;
    // Lines are plant-scoped — a stale selection from the old plant must never
    // leak into the new one. Routed through setSelectedLines so this reuses its
    // in-place-mutate + no-op-guard + emit logic instead of duplicating it.
    this.setSelectedLines([], source);
    // Reset per-plant reactive data when plant changes
    this._state.distributionSummary = null;
    this.emit({ type: 'plant:selected', plant: this._state.selectedPlant, source });
  },
  setSelectedLines(lines: Iterable<string>, source?: string): void {
    const next = new Set(lines);
    const current = this._state.selectedLines;
    if (next.size === current.size && [...next].every(l => current.has(l))) return; // no-op: content unchanged
    // Mutate in place — never reassign — so every existing direct alias
    // (GanttFilter._selectedLines, Table._chipFilters.lines, Dashboard._filterLines,
    // plus scattered direct reads in Timeline/Hierarchy) sees the update for free.
    current.clear();
    for (const l of next) current.add(l);
    this.emit({ type: 'lines:selected', lines: [...current], source });
  },

  /* ----- plant-scoped accessors ----------------------------------------- */
  // The selected plant is a true global filter. When null, callers see an
  // empty world and render an EmptyState prompt instead of their usual view.
  tasksByPlant(plant: string | null): NimbusTask[] {
    return plant ? (Store._tasksByPlant[plant] || []) : Store.tasksArr;
  },
  rebuildPlantIndex(): void {
    // Rebuild the line → master-data plant cache first so the getPlantForLine calls
    // below (and on every later hot path) resolve in O(1) instead of scanning lines.
    const l2p: Record<string, string | null> = {};
    const masterByPlant: Record<string, NimbusMasterData['lines']> = {};
    for (const r of (Store._state.masterData?.lines ?? [])) {
      if (r.machine && l2p[r.machine] === undefined) l2p[r.machine] = r.plant ?? null;
      if (r.plant) (masterByPlant[r.plant] ||= []).push(r);
    }
    Store._lineToPlant = l2p;
    Store._masterLinesByPlant = masterByPlant;
    const idx: Record<string, NimbusTask[]> = {};
    for (const t of Store.tasksArr) {
      const p = t.PLANT || Store.getPlantForLine(t.MACHINE);
      if (!p) continue;
      (idx[p] ||= []).push(t);
    }
    Store._tasksByPlant = idx;

    // Names-only index for dropdown/chip/heatmap consumers — same 4 sources
    // allLines() unions, bucketed by plant instead of collapsed into one flat set.
    const namesByPlant: Record<string, Set<string>> = {};
    const addName = (plant: string | null, line: string): void => { if (plant && line) (namesByPlant[plant] ||= new Set()).add(line); };
    for (const t of Store.tasksArr) addName(t.PLANT || Store.getPlantForLine(t.MACHINE), t.MACHINE);
    for (const [line, entry] of Object.entries(this._state.calendars)) {
      const plant = Store.getPlantForLine(line);
      addName(plant, line);
      // An inherited line seeded before its plant resolved (DEFAULT_SHIFT) goes all-day once it does.
      if (plant && entry.inherited && !Store._isAllDay(entry.workHours)) entry.workHours = Store._inheritedSeed(line);
      // ...and the reverse: a plant that stopped resolving must not leave an all-day seed with nothing to bound it.
      else if (!plant && entry.inherited && Store._isAllDay(entry.workHours)) entry.workHours = Store._defaultShiftWeek();
    }
    for (const line of Object.keys(this._state.lineSettings)) addName(Store.getPlantForLine(line), line);
    for (const r of (Store._state.masterData?.lines ?? []))   addName(r.plant, r.machine);
    const linesByPlant: Record<string, string[]> = {};
    for (const [plant, set] of Object.entries(namesByPlant)) {
      linesByPlant[plant] = [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    }
    Store._linesByPlant = linesByPlant;
  },

  /* ----- wholesale replace (bulk hydration paths) ------------------------ */
  replaceBlocks(blocks: NimbusBlock[], source?: string): void {
    this._state.blocks = blocks;
    this.emit({ type: 'blocks:replace', source });
    this.emit({ type: 'blocks:change', source });
  },
  replaceCalendars(calendars: Record<string, CalendarEntry>, source?: string): void {
    this._state.calendars = calendars;
    this.emit({ type: 'calendar:replace', source });
    this.emit({ type: 'calendar:change', source });
  },
  replacePlants(plants: Record<string, PlantCalendarEntry>, source?: string): void {
    this._state.plants = plants;
    this.emit({ type: 'plants:replace', source });
    // Plant hours use the established calendar:change channel, as does
    // setPlantWorkHours(). There is no separate plants:change contract.
    this.emit({ type: 'calendar:change', source });
  },
  replacePlantBlocks(plantBlocks: NimbusPlantBlock[], source?: string): void {
    this._state.plantBlocks = plantBlocks;
    this.emit({ type: 'plantBlocks:replace', source });
    this.emit({ type: 'plantBlocks:change', source });
  },
  replaceFirmedIds(idSet: Set<string>, source?: string): void {
    // Report ONLY ids whose membership actually changed (symmetric difference):
    // the old union reported every firmed id on every replace, and the dirty
    // tracker would have mass-dirtied the whole firm set on a What-If undo.
    const prior = this._state.firmedIds;
    const changedIds: string[] = [];
    for (const id of prior) if (!idSet.has(id)) changedIds.push(id);
    for (const id of idSet) if (!prior.has(id)) changedIds.push(id);
    this._state.firmedIds = new Set([...idSet]);
    for (const id of changedIds) {
      const t = this._state.tasks[id];
      if (t) t.firmed = this._state.firmedIds.has(id);
    }
    this.emit({ type: 'firmed:replace', source });
    this.emit({ type: 'firmed:change', ids: changedIds, source });
  },

  // Patch a single task reference inside the _tasksByPlant index after updateTask swaps
  // prev→next, keeping the cached plant buckets coherent without a full O(n) rebuild.
  // Moves the task between buckets if its resolved plant changed (line/plant edit).
  _reindexTask(prev: NimbusTask, next: NimbusTask): void {
    const idx = Store._tasksByPlant;
    if (!idx) return; // index not built yet (pre-setTasks) — nothing to keep coherent
    const plantOf = (t: NimbusTask): string | null => t.PLANT || Store.getPlantForLine(t.MACHINE) || null;
    const oldP = plantOf(prev);
    const newP = plantOf(next);
    if (oldP === newP) {
      const bucket = oldP ? idx[oldP] : null;
      if (bucket) {
        const i = bucket.indexOf(prev);
        if (i >= 0) bucket[i] = next;   // in-place swap preserves order
        else bucket.push(next);
      }
      return;
    }
    if (oldP && idx[oldP]) {
      const i = idx[oldP].indexOf(prev);
      if (i >= 0) idx[oldP].splice(i, 1);
    }
    if (newP) (idx[newP] ||= []).push(next);
  },
  allLines(): string[] {
    const set = new Set<string>();
    for (const t of Store.tasksArr) {
      if (t.MACHINE) set.add(t.MACHINE);
    }
    Object.keys(this._state.calendars).forEach(l => set.add(l));
    Object.keys(this._state.lineSettings).forEach(l => set.add(l));
    // Master table is authoritative — include lines regardless of order attachment.
    (this._state.masterData?.lines ?? []).forEach(r => {
      if (r.machine) set.add(r.machine);
    });
    return [...set];
  },
  tasksForSelectedPlant(): NimbusTask[] {
    const plant = this._state.selectedPlant;
    if (!plant) return [];
    // Read straight from the _tasksByPlant index (rebuilt on setTasks / lineSettings /
    // master-data changes) instead of re-filtering every task via getPlantForLine.
    return Store.tasksByPlant(plant);
  },
  linesForSelectedPlant(): string[] {
    const plant = this._state.selectedPlant;
    return plant ? (Store._linesByPlant[plant] || []) : [];
  },
  masterLinesForPlant(plant: string | null): NimbusMasterData['lines'] {
    return plant ? (Store._masterLinesByPlant[plant] || []) : [];
  },
  knownPlants(): string[] {
    // Prefer master-data plants when available (authoritative source).
    const masterPlants = Store._state.masterData?.plants?.map(p => p.plant) ?? [];
    let all;
    if (masterPlants.length) {
      all = [...new Set(masterPlants)].sort();
    } else {
      // Fall back to dynamically discovered plants from order data.
      const dynamic = [];
      for (const line of Store.allLines()) {
        const p = Store.getPlantForLine(line);
        if (p) dynamic.push(p);
      }
      all = [...new Set([...Config.KNOWN_PLANTS, ...dynamic])].sort();
    }
    // Per-user role_plants scope (backend is the real boundary — this is UX,
    // not security; a stale/wide cache here still 403s server-side).
    const allowed = _allowedPlantsResolver();
    return allowed ? all.filter(p => allowed.includes(p)) : all;
  },

  /** Master-data row for a plant code; null when master data hasn't loaded
   *  yet or the code is unknown. Not to be confused with Store.plants, the
   *  separate calendar/work-hours map. */
  masterPlant(code: string | null): NimbusMasterPlant | null {
    if (!code) return null;
    return (this._state.masterData?.plants ?? []).find(p => p.plant === code) ?? null;
  },
  /** "1006 — Maryville" when a description exists; bare "1006" otherwise. */
  plantLabel(code: string | null): string {
    if (!code) return '';
    const d = (Store.masterPlant(code)?.description ?? '').trim();
    return d ? `${code} — ${d}` : String(code);
  },

  /* ----- alerts ---------------------------------------------------------- */
  setAlerts(alerts: NimbusAlert[], source?: string): void {
    // Compute which task IDs changed alert membership for incremental table updates.
    const oldAlerts = this._state.alerts || [];
    // A task's alert membership is its set of alert types: gaining or losing ANY type (a queued row that already
    // had another alert and now gains queued_now_fits) changes what its grid row and flags show, not only going
    // from none to some or back.
    const typesByTask = (list: NimbusAlert[]): Map<string, string> => {
      const m = new Map<string, string[]>();
      for (const a of list) {
        if (a.taskId == null) continue;
        const k = String(a.taskId);
        const arr = m.get(k);
        if (arr) arr.push(a.type); else m.set(k, [a.type]);
      }
      return new Map([...m].map(([k, v]) => [k, [...new Set(v)].sort().join('|')]));
    };
    const oldTypes = typesByTask(oldAlerts);
    const newTypes = typesByTask(alerts);
    const changedIds: string[] = [];
    for (const [id, sig] of oldTypes) {
      if (newTypes.get(id) !== sig) changedIds.push(id);
    }
    for (const id of newTypes.keys()) {
      if (!oldTypes.has(id)) changedIds.push(id);
    }
    this._state.alerts = alerts;
    this.emit({ type: 'alerts:change', source, changedIds: changedIds.length ? changedIds : undefined });
  },
  dismissAlert(alertId: string, source?: string): void {
    const next = this._state.alerts.filter(a => a.id !== alertId);
    if (next.length !== this._state.alerts.length) {
      // Reassign (not splice-in-place) so the array identity changes and the
      // alertsByTask() memo invalidates correctly.
      this._state.alerts = next;
      this.emit({ type: 'alerts:change', source });
    }
  },
  dismissAllAlerts(source?: string): void {
    this._state.alerts = [];
    this.emit({ type: 'alerts:change', source });
  },
  /** Map<String taskId, alert[]> for O(1) per-row alert lookups, memoized on the
   *  Store.alerts array identity (every mutator reassigns the array, so the memo
   *  invalidates on any change). Replaces O(rows × alerts) Store.alerts.filter()
   *  scans in grid cell renderers / row-class / popovers (R16). Treat as read-only. */
  alertsByTask(): Map<string, NimbusAlert[]> {
    if (this._alertsByTaskSrc !== this._state.alerts) {
      const m = new Map<string, NimbusAlert[]>();
      for (const a of this._state.alerts) {
        if (a.taskId == null) continue;
        const k = String(a.taskId);
        let arr = m.get(k);
        if (!arr) m.set(k, arr = []);
        arr.push(a);
      }
      this._alertsByTaskSrc = this._state.alerts;
      this._alertsByTask = m;
    }
    return this._alertsByTask;
  },
  /** Map<PARENT_ORDER, sibling tasks> for O(1) distribution-sibling lookups
   *  (aggregate_to_detail.md §8) — replaces the repeated
   *  `(selectedPlant ? tasksForSelectedPlant() : tasksArr).filter(x => x.PARENT_ORDER === ...)`
   *  scans in the Gantt bar pill/hover card/sibling highlight and the Orders
   *  grid renderer/Inspector (D40). Each parent's array is self-inclusive
   *  (matches what those call sites filtered before this memo existed) —
   *  callers that need "other siblings" still subtract the current task.
   *  Memoized like alertsByTask() but on (rev, selectedPlant, tasks) since
   *  siblings are themselves plant-scoped and removeTask() splices the tasks
   *  object in place (no new reference) — rev is the only reliable signal.
   *  Treat as read-only. */
  siblingsByParent(): Map<string, NimbusTask[]> {
    const rev = this._rev;
    const plant = this._state.selectedPlant;
    const tasks = this._state.tasks;
    const src = this._siblingsByParentSrc;
    if (!src || src.rev !== rev || src.plant !== plant || src.tasks !== tasks) {
      const scoped = plant ? this.tasksForSelectedPlant() : this.tasksArr;
      const m = new Map<string, NimbusTask[]>();
      for (const t of scoped) {
        if (!t.PARENT_ORDER) continue;
        let arr = m.get(t.PARENT_ORDER);
        if (!arr) m.set(t.PARENT_ORDER, arr = []);
        arr.push(t);
      }
      this._siblingsByParentSrc = { rev, plant, tasks };
      this._siblingsByParent = m;
    }
    return this._siblingsByParent;
  },
  setUserSettings(patch: Record<string, unknown>, source?: string): void {
    Object.assign(this._state.userSettings, patch);
    this.emit({ type: 'settings:change', source });
  },
  // Replace the persisted pref keys wholesale with `obj` (the server's merged
  // blob), so a key the server deleted (a null PATCH) disappears here too instead
  // of lingering the way Object.assign would leave it. Mutates in place (callers
  // may hold the reference) and keeps the two runtime-only horizon fields, which
  // are not pref-persisted and would otherwise be wiped by a settings refresh.
  replaceUserSettings(obj: Record<string, unknown>, source?: string): void {
    const cur = this._state.userSettings as Record<string, unknown>;
    const keep = { alertHorizonMinutes: cur.alertHorizonMinutes, confidenceHorizonMinutes: cur.confidenceHorizonMinutes };
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, keep, obj || {});
    this.emit({ type: 'settings:change', source });
  },
  // Replace the role-defaults snapshot wholesale (roles.settings for the signed-in
  // user's role). Session.signIn/refresh push this from GET /security/me.role_settings.
  setRoleDefaults(obj: Record<string, unknown> | null | undefined, source?: string): void {
    this._state.roleDefaults = (obj && typeof obj === 'object') ? { ...obj } : {};
    this.emit({ type: 'settings:change', source });
  },
  /* Resolve an effective per-user preference using the contract precedence:
       userSettings[key] ?? roleDefaults[key] ?? settingsDefaultsResolver()[key]
     Never throws — returns undefined for an unknown key with no default. `opts.plant`
     scaffolds a region/{plant} fallback (see note) and may be passed now for
     forward-compat; it is ignored today. */
  pref(key: string, opts: { plant?: string } = {}): unknown {
    try {
      const us   = this._state.userSettings || {};
      const rd   = this._state.roleDefaults || {};
      const defs = _settingsDefaultsResolver() || {};
      // ── region/{plant} fallback — EXTENSION POINT, NO-OP TODAY ──────────
      // For region-scoped keys (Settings.isRegion(key): firstDayOfWeek)
      // a per-plant regional default keyed on opts.plant would slot in between the
      // user blob and the role defaults right here. There is NO plants timezone /
      // week-start column yet, so we deliberately do not read one — do not invent a
      // plants column to satisfy this hook.
      return us[key] ?? rd[key] ?? defs[key];
    } catch { return undefined; }
  },

  /* ----- internals ------------------------------------------------------- */
  _normalizeDates(task: NimbusTask): void {
    // Canonical persisted/optimizer aggregates already carry their exact timing.
    // Re-snapping them after validation can move setup occupancy and break bounds.
    const canonicalSchedule = task.planning_status !== undefined;
    for (const k of ['start_date','end_date','BASIC_START_DATE','BASIC_FINISH_DATE','original_start_date','original_end_date'] as const) {
      const v = task[k];
      if (v && !(v instanceof Date)) task[k] = Util.parseDate(v);
    }
    if (task.start_date && !canonicalSchedule) task.start_date = Util.snap(task.start_date);
    if (task.end_date && !canonicalSchedule)   task.end_date   = Util.snap(task.end_date);
    const rawSegments = Array.isArray(task.scheduleSegments) ? task.scheduleSegments : [];
    const segments = rawSegments.map((segment, index) => {
      const startDate = Util.parseDate(segment?.startDate);
      const endDate = Util.parseDate(segment?.endDate);
      return startDate instanceof Date && endDate instanceof Date && endDate > startDate
        ? { sequence: Number(segment?.sequence) || index + 1,
          startDate: canonicalSchedule ? startDate : Util.snap(startDate), endDate: canonicalSchedule ? endDate : Util.snap(endDate) }
        : null;
    }).filter((segment): segment is OrderScheduleSegment => segment !== null)
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.sequence - b.sequence);
    task.scheduleSegments = segments.length >= 2
      ? segments.map((segment, index) => ({ ...segment, sequence: index + 1 }))
      : [];
    if (task.scheduleSegments.length >= 2) {
      task.start_date = new Date(task.scheduleSegments[0].startDate);
      task.end_date = new Date(task.scheduleSegments[task.scheduleSegments.length - 1].endDate);
    }
    task.planning_status ??= 'scheduled';
    if (task.planning_status === 'needs_planning') {
      task.start_date = null;
      task.end_date = null;
      task.scheduleSegments = [];
    }
    // task.firmed is the MANUAL (planner) firm mirror only. The SAP flag arrives
    // separately as task.ecc_firmed and the frozen-horizon reason is derived live —
    // the frozen-horizon (finish-based) and running reasons unite with this planner firm in Engine.firmingStatus() (the SAP flag is display-only and never locks); derived firming never enters firmedIds.
    task.firmed = !!task.firmed;
    // firmedIds mirrors task.firmed both ways, so undo/restore of a snapshot
    // (updateMany with firmed:false) also drops the id.
    if (task.id != null) {
      if (task.firmed) Store._state.firmedIds.add(String(task.id));
      else Store._state.firmedIds.delete(String(task.id));
    }
    if (task.id != null) task.id = String(task.id);
  }
};

/* =============================================================================
   UNDO STACK — minimal, in-memory, destructive ops only (10 levels).
   Used by drag-commits and unschedule actions in the Interaction module.
   ========================================================================== */
export const UndoStack = {
  MAX: 10,
  _entries: [] as UndoEntry[],

  push(label: string, undoFn: UndoEntry['undoFn'], ids?: Iterable<string | number>): void {
    const entry: UndoEntry = { label, undoFn, at: Date.now() };
    if (ids) entry.ids = [...ids].map(String);
    this._entries.push(entry);
    if (this._entries.length > this.MAX) this._entries.shift();
    Store.emit({ type: 'undo:pushed', label });
  },
  /** Drop every entry whose ids intersect `ids` (D31): after a server-side
   *  write rewrites those tasks (e.g. a distribution re-weight), restoring an
   *  older snapshot would resurrect pre-write values. Entries without ids stay. */
  invalidate(ids: Iterable<string | number>): void {
    const hit = new Set([...ids].map(String));
    if (!hit.size) return;
    this._entries = this._entries.filter(e => !e.ids || !e.ids.some(id => hit.has(id)));
  },
  /** True while an async undo (e.g. the What-If confirm) is still pending: a second
   *  Ctrl+Z must not pop an OLDER entry and undo out of order. */
  _busy: false,
  pop(): UndoEntry | null {
    if (this._busy) return null;
    const e = this._entries.pop();
    if (!e) return null;
    const done = (r: void | boolean): void => {
      this._busy = false;
      if (r === false) { this._entries.push(e); return; } // aborted: keep the entry, no toast
      Toast.show(Util.t('toast.undone', { label: e.label }), 'success');
    };
    const fail = (err: unknown): void => { this._busy = false; ErrorLog.error('undo', `${e.label}: ${(err as Error).message}`); };
    try {
      const r = e.undoFn();
      if (r && typeof (r as Promise<void | boolean>).then === 'function') {
        this._busy = true;
        (r as Promise<void | boolean>).then(done, fail);
      } else done(r as void | boolean);
    } catch (err) { fail(err); }
    return e;
  },
  /** Take a snapshot of the given task ids so they can be restored. */
  snapshotTasks(ids: string[]): NimbusTask[] {
    return ids.map(id => {
      const t = Store.tasks[id];
      if (!t) return null;
      const clone = structuredClone(t);
      // F10: remember whether the row already carried unsaved edits before the edit this snapshot guards.
      if (UndoStack.dirtyProbe?.(String(id))) UndoStack._wasDirty.add(clone);
      return clone;
    }).filter(Boolean) as NimbusTask[];
  },
  /** Registered by the engine (platform cannot import persistence): true when the row has unsaved edits. */
  dirtyProbe: null as null | ((id: string) => boolean),
  _wasDirty: new WeakSet<NimbusTask>(),
  /** Registered by the engine (platform cannot import it): re-derive the start of just-restored rows from their
   *  restored finish and the CURRENT run time (OQ21). Receives the restored ids. */
  afterRestore: null as null | ((ids: string[], wasDirty: ReadonlySet<string>) => void),
  /** Registered by the engine: true when the post-restore reconcile will process this (restored) row. Only such a
   *  row is flagged stale by restoreTasks, because only the reconcile ever clears the flag (U23). Null = every row. */
  willRederive: null as null | ((task: NimbusTask) => boolean),
  restoreTasks(snapshot: NimbusTask[]): void {
    // planning_reason is defaulted explicitly: a snapshot of a scheduled order may not
    // carry the key, and an undone Unschedule must not leave its reason behind.
    // `firmed` is deliberately NOT restored: the manual firm is a separate planner edit that
    // only setFirmed/replaceFirmedIds may change (they mark it firm-dirty). Restoring it here
    // flipped a firm without a marker, so the save sent no FIRMED and the UI diverged from the server.
    const patches = snapshot.map(s => {
      const { firmed: _firmed, ...rest } = s;
      // OQ21: undo restores the FINISH. The restored start is only a placeholder, so the row is flagged stale and
      // the engine re-derives the start from the finish under the current run time (afterRestore below).
      // A row the reconcile will not process (no machine, an overtime/overlong
      // marker) keeps its previous flag: nothing would clear a flag set here.
      const mismatch = UndoStack.willRederive && !UndoStack.willRederive(s as NimbusTask)
        ? !!Store.tasks[s.id]?.runtime_schedule_mismatch : true;
      return { id: s.id, changes: { ...rest, planning_reason: s.planning_reason ?? null, runtime_schedule_mismatch: mismatch,
        row_version: Store.tasks[s.id]?.row_version ?? s.row_version } };
    });
    Store.updateMany(patches, 'undo');
    if (patches.length) {
      const wasDirty = new Set(snapshot.filter(s => UndoStack._wasDirty.has(s)).map(s => String(s.id)));
      UndoStack.afterRestore?.(patches.map(p => String(p.id)), wasDirty);
    }
  },
};

// Snapshot attached to error-level ErrorLog entries (ctx.state.platform).
try {
  ErrorLog.registerStateProvider('platform', () => ({
    plant: Store.selectedPlant,
    selectedLines: Store.selectedLines.size,
    lastEvent: Store._lastEvent,
    rev: Store.rev(),
    mode: Store.mode()
  }));
} catch { /* ErrorLog unavailable: skip the provider */ }
