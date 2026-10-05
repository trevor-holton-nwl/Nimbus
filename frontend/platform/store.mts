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
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, NimbusMasterData, NimbusMasterPlant, PriorityRankMaps, SetupSnapshot, StoreEventType, StoreMode, OrderScheduleSegment } from './types.mjs';

// -- Local type declarations (Phase 2 conversion; scoped to this file) ------
type AllowedPlantsResolver = () => string[] | null;
type SettingsDefaultsResolver = () => Record<string, unknown>;

/** Shared with optimization/sandbox.mjs's SandboxSnapshot (calendars/plants
 *  fields) — exported so that file imports this exact declaration instead of
 *  redeclaring a structurally-identical shadow copy. */
export interface CalendarEntry {
  workHours: WorkHours;
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
  plants: Record<string, CalendarEntry>;
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
   *  before any load. Same reasoning as visibilityHorizonEnd above: read by
   *  Engine.frozenHorizonEnd/isFrozenHorizon (optimization/engine.mts) and
   *  Timeline's `.frozen-horizon-zone` band (scheduling/gantt.mts) instead
   *  of either carrying its own copy of the anchor-day/roll-hour clock math. */
  frozenHorizonEnd: Date | null;
}

interface UndoEntry {
  label: string;
  undoFn: () => void;
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
export const Store = {
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

  setAllowedPlantsResolver(fn: AllowedPlantsResolver): void { _allowedPlantsResolver = typeof fn === 'function' ? fn : () => null; },
  setSettingsDefaultsResolver(fn: SettingsDefaultsResolver): void { _settingsDefaultsResolver = typeof fn === 'function' ? fn : () => ({}); },
  rev(): number { return this._rev || 0; },
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
  get plants(): Record<string, CalendarEntry>        { return this._state.plants; },
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
  get frozenHorizonEnd(): Date | null { return this._state.frozenHorizonEnd; },
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
  setMasterData(masterData: NimbusMasterData | null, source?: string): void {
    this._state.masterData = masterData;
    this.rebuildPlantIndex();
    this.emit({ type: 'master-data-changed', source });
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
   *  `Store._rev` (invalidating `Utilization._cache`, whose memo key includes
   *  `rev()`) on every rank load — including one per Optimize-dialog open and
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
    // revision/mode are additive — existing listeners that only read
    // evt.type/evt.source/etc. are unaffected.
    const enriched: StoreEvent = { ...event, revision: this._rev, mode: this.mode() };
    for (const l of this._listeners) {
      const _t = performance.now();
      try { l(enriched); } catch (e) { console.error('[Store] listener error:', e); }
      finally { PerfMonitor.record('store:' + (l._pmLabel || l.name || '?'), performance.now() - _t); }
    }
  },

  /* ----- mutations ------------------------------------------------------- */
  // Replace all tasks (e.g. after backend load or optimiser run).
  setTasks(tasks: NimbusTask[], source?: string): { inserted: number; collisions: number } {
    this._state.tasks = {};
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
  setCalendar(line: string, workHours: WorkHours, source?: string): void {
    if (!this._state.calendars[line]) this._state.calendars[line] = { workHours: {} };
    this._state.calendars[line].workHours = workHours;
    this.emit({ type: 'calendar:change', line, source });
  },
  ensureCalendar(line: string): void {
    if (this._state.calendars[line]) return;
    const defaults: WorkHours = {};
    for (let d = 0; d < 7; d++) {
      if (Config.WEEKEND_OFF && (d === 0 || d === 6)) defaults[d] = null;
      else defaults[d] = [...Config.DEFAULT_SHIFT] as [number, number];
    }
    this._state.calendars[line] = { workHours: defaults };
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
  clampLinesToPlant(plant: string, dow: number): string[] {
    const plantHours = this._state.plants[plant]?.workHours[dow];
    const changed = [];  // line codes whose hours this call actually rewrote (F9)
    const plantLineSet = new Set(Store._linesByPlant[plant] || []);
    for (const line of Object.keys(this._state.calendars)) {
      if (!plantLineSet.has(line)) continue;
      const lineHours = this._state.calendars[line].workHours[dow];
      if (!lineHours) continue;
      let next: [number, number] | null;
      if (!plantHours) {
        next = null;
      } else {
        const ns = Math.max(lineHours[0], plantHours[0]);
        const ne = Math.min(lineHours[1], plantHours[1]);
        next = ns >= ne ? null : [ns, ne];
      }
      // Only write + report when the value actually changes, so a concurrent
      // single-line edit that already fits the new plant window is not re-persisted
      // (and therefore not clobbered) by the plant-hours batch. (F9)
      const same = Array.isArray(next)
        ? (Array.isArray(lineHours) && lineHours[0] === next[0] && lineHours[1] === next[1])
        : (next === null && lineHours === null);
      if (!same) {
        this._state.calendars[line].workHours[dow] = next;
        changed.push(line);
      }
    }
    this.emit({ type: 'calendar:change', source: 'plant-clamp' });
    return changed;
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
    for (const line of Object.keys(this._state.calendars))    addName(Store.getPlantForLine(line), line);
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
  replacePlants(plants: Record<string, CalendarEntry>, source?: string): void {
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
    const changedIds = new Set([...this._state.firmedIds, ...idSet]);
    this._state.firmedIds = new Set([...idSet]);
    for (const id of this._state.firmedIds) {
      const t = this._state.tasks[id];
      if (t) t.firmed = true;
    }
    this.emit({ type: 'firmed:replace', source });
    this.emit({ type: 'firmed:change', ids: [...changedIds], source });
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
    const oldTaskIds = new Set(oldAlerts.map(a => a.taskId).filter(id => id != null));
    const newTaskIds = new Set(alerts.map(a => a.taskId).filter(id => id != null));
    const changedIds: string[] = [];
    // Tasks that had alerts before but don't now
    for (const id of oldTaskIds) {
      if (!newTaskIds.has(id)) changedIds.push(id);
    }
    // Tasks that have alerts now but didn't before
    for (const id of newTaskIds) {
      if (!oldTaskIds.has(id)) changedIds.push(id);
    }
    this._state.alerts = alerts;
    this.emit({ type: 'alerts:change', source, changedIds: changedIds.length ? changedIds : undefined });
  },
  dismissAlert(alertId: string, source?: string): void {
    const next = this._state.alerts.filter(a => a.id !== alertId);
    if (next.length !== this._state.alerts.length) {
      // Reassign (not splice-in-place) so the array identity changes and the
      // alertsByTask()/Timeline._conflictIds() memos invalidate correctly.
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
      // For region-scoped keys (Settings.isRegion(key): timezone, firstDayOfWeek)
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
    // the three unite in Engine.firmingStatus(); derived firming never enters firmedIds.
    task.firmed = !!task.firmed;
    if (task.firmed) Store._state.firmedIds.add(String(task.id));
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

  push(label: string, undoFn: () => void, ids?: Iterable<string | number>): void {
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
  pop(): UndoEntry | null {
    const e = this._entries.pop();
    if (!e) return null;
    try { e.undoFn(); Toast.show(Util.t('toast.undone', { label: e.label }), 'success'); }
    catch (err) { ErrorLog.error('undo', `${e.label}: ${(err as Error).message}`); }
    return e;
  },
  /** Take a snapshot of the given task ids so they can be restored. */
  snapshotTasks(ids: string[]): NimbusTask[] {
    return ids.map(id => {
      const t = Store.tasks[id];
      return t ? structuredClone(t) : null;
    }).filter(Boolean) as NimbusTask[];
  },
  restoreTasks(snapshot: NimbusTask[]): void {
    const patches = snapshot.map(s => ({ id: s.id, changes: { ...s, row_version: Store.tasks[s.id]?.row_version ?? s.row_version } }));
    Store.updateMany(patches, 'undo');
  },
};
