// schedule-state.mts — CQ-1 schedule-state module.
// Owns schedule state, derived indexes, selection, undo, sandbox snapshots,
// and synchronous post-commit events. Every mutator takes a `source` and
// every emitted event carries {type, source, revision, mode, ...}. See
// docs/architecture/cq1-compatibility-inventory.md for the full contract.
import { Config, Util, PerfMonitor, ErrorLog, Toast } from './application-foundation.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, NimbusMasterData, StoreEventType, SelectionEmitKind, StoreMode } from './types.mjs';

// -- Local type declarations (Phase 2 conversion; scoped to this file) ------
type AllowedPlantsResolver = () => string[] | null;
type SettingsDefaultsResolver = () => Record<string, unknown>;

interface CalendarEntry {
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
 *  in schedule-workbench.mts) can name this type explicitly instead of redeclaring a shadow copy. */
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
  fixedIds: Set<string>;
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
  /** Named fields are guaranteed; Session/DB-sourced prefs beyond them are an open bag (Object.assign in setUserSettings). */
  userSettings: Record<string, unknown> & { alertHorizonMinutes: number | null; confidenceHorizonMinutes: number };
  roleDefaults: Record<string, unknown>;
}

interface SelectionEmitPayload {
  kind: SelectionEmitKind;
  ids: string[];
  anchor: string | null;
}

interface UndoEntry {
  label: string;
  undoFn: () => void;
  at: number;
}

interface SandboxSnapshot {
  tasks: NimbusTask[];
  blocks: NimbusBlock[];
  calendars: Record<string, CalendarEntry>;
  plants: Record<string, CalendarEntry>;
  plantBlocks: NimbusPlantBlock[];
  fixedIds: Set<string>;
}

// Two DI seams replace what used to be direct references from Store into modules
// that stay in app.js (Session, Settings) — each defaults to a safe fallback
// (no scoping / no defaults) when unset. Selection needs no such seam: it is a
// sibling top-level export in this same module (see below), so `removeTask()`
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
    fixedIds:     new Set<string>(),
    meta:         { lastOptimize: null },
    plants:       {},
    plantBlocks:  [],
    lineSettings: {},
    selectedPlant: null,
    selectedLines: new Set<string>(),
    masterData: null,
    userSettings: { alertHorizonMinutes: null, confidenceHorizonMinutes: 20160 },
    roleDefaults: {}
  } as StoreState,
  _listeners: new Set<((event: StoreEvent) => void) & { _pmLabel?: string }>(),
  // Lazily populated by alertsByTask() below — declared here (not left to first
  // assignment) because plain object-literal properties, unlike class fields
  // assigned in a constructor, need their type fixed at the literal's declaration.
  _alertsByTaskSrc: null as NimbusAlert[] | null,
  _alertsByTask: new Map<string, NimbusAlert[]>(),
  // Set by emit() on first mutation; read by rev(). Same reasoning as above.
  _rev: 0,

  setAllowedPlantsResolver(fn: AllowedPlantsResolver): void { _allowedPlantsResolver = typeof fn === 'function' ? fn : () => null; },
  setSettingsDefaultsResolver(fn: SettingsDefaultsResolver): void { _settingsDefaultsResolver = typeof fn === 'function' ? fn : () => ({}); },
  rev(): number { return this._rev || 0; },
  // 'draft' once What-If mode is active. `Sandbox` is declared further down in
  // this same module (a sibling top-level const) — referencing it here is safe
  // even though it appears "before" its declaration in file order, because
  // mode() is never *called* until well after module evaluation completes.
  mode(): StoreMode { return (typeof Sandbox !== 'undefined' && Sandbox.active) ? 'draft' : 'live'; },

  /* ----- basic access ---------------------------------------------------- */
  get state(): StoreState     { return this._state; },
  get tasks(): Record<string, NimbusTask>     { return this._state.tasks; },
  get blocks(): NimbusBlock[]    { return this._state.blocks; },
  get alerts(): NimbusAlert[]    { return this._state.alerts; },
  get calendars(): Record<string, CalendarEntry> { return this._state.calendars; },
  get fixedIds(): Set<string>  { return this._state.fixedIds; },
  get tasksArr(): NimbusTask[]      { return Object.values(this._state.tasks); },
  get plants(): Record<string, CalendarEntry>        { return this._state.plants; },
  get plantBlocks(): NimbusPlantBlock[]   { return this._state.plantBlocks; },
  get lineSettings(): Record<string, NimbusLineSetting>  { return this._state.lineSettings; },
  get selectedPlant(): string | null { return this._state.selectedPlant; },
  // Live reference (same convention as fixedIds above) — callers that alias this
  // Set (GanttFilter/Table/Dashboard) see every future in-place mutation for free.
  get selectedLines(): Set<string> { return this._state.selectedLines; },
  get userSettings(): StoreState['userSettings']  { return this._state.userSettings; },
  get roleDefaults(): Record<string, unknown>  { return this._state.roleDefaults; },
  get masterData(): NimbusMasterData | null    { return this._state.masterData; },
  get dependencies(): Record<string, string[]>  { return this._state.dependencies; },

  isFixed(id: string | number): boolean     { return this._state.fixedIds.has(String(id)); },

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
    this._state.meta.lastOptimize = date;
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
        if (collisionSamples.length < 5) collisionSamples.push({ id: key, text: t.text, line: t.PRODUCTION_LINE });
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

  // Remove a task, cleaning up dependencies, fixedIds, and (if present)
  // the Selection set. Emits 'task:remove'.
  removeTask(id: string | number, source?: string): NimbusTask | null {
    const key = String(id);
    const prev = this._state.tasks[key];
    if (!prev) return null;
    delete this._state.tasks[key];

    // Clean up dependency graph both ways.
    const deps = this._state.dependencies;
    if (deps[key]) delete deps[key];
    for (const target of Object.keys(deps)) {
      const arr = deps[target];
      const i = arr.indexOf(key);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length) delete deps[target];
    }

    this._state.fixedIds.delete(key);
    // `Selection` is declared further down in this same module (a sibling
    // top-level const) — referencing it here is safe even though it appears
    // "before" its declaration in file order, because removeTask() is never
    // *called* until well after module evaluation completes (same reasoning
    // as Store.mode()'s reference to Sandbox, above).
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
      Store._normalizeDates(task);
    }
    this.emit({ type: 'tasks:bulkUpdate', ids: patches.map(p => p.id), source });
  },

  // Toggle fixed flag on a task (or group of tasks).
  setFixed(ids: string | number | Array<string | number>, fixed: boolean, source?: string): void {
    const arr = Array.isArray(ids) ? ids : [ids];
    for (const id of arr) {
      const key = String(id);
      if (fixed) this._state.fixedIds.add(key);
      else       this._state.fixedIds.delete(key);
      const t = this._state.tasks[id];
      if (t) t.fixed = !!fixed;
    }
    this.emit({ type: 'fixed:change', ids: arr, fixed, source });
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
    if (cached !== undefined) return cached;
    const mdLine = (this._state.masterData?.lines ?? []).find(r => r.production_line === line);
    return mdLine?.plant ?? null;
  },
  setSelectedPlant(plant: string | null, source?: string): void {
    const next = plant || null;
    if (next === this._state.selectedPlant) return; // no-op: don't re-emit
    this._state.selectedPlant = next;
    // Lines are plant-scoped — a stale selection from the old plant must never
    // leak into the new one. Routed through setSelectedLines so this reuses its
    // in-place-mutate + no-op-guard + emit logic instead of duplicating it.
    this.setSelectedLines([], source);
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
      if (r.production_line && l2p[r.production_line] === undefined) l2p[r.production_line] = r.plant ?? null;
      if (r.plant) (masterByPlant[r.plant] ||= []).push(r);
    }
    Store._lineToPlant = l2p;
    Store._masterLinesByPlant = masterByPlant;
    const idx: Record<string, NimbusTask[]> = {};
    for (const t of Store.tasksArr) {
      const p = t.PLANT || Store.getPlantForLine(t.PRODUCTION_LINE);
      if (!p) continue;
      (idx[p] ||= []).push(t);
    }
    Store._tasksByPlant = idx;

    // Names-only index for dropdown/chip/heatmap consumers — same 4 sources
    // allLines() unions, bucketed by plant instead of collapsed into one flat set.
    const namesByPlant: Record<string, Set<string>> = {};
    const addName = (plant: string | null, line: string): void => { if (plant && line) (namesByPlant[plant] ||= new Set()).add(line); };
    for (const t of Store.tasksArr) addName(t.PLANT || Store.getPlantForLine(t.PRODUCTION_LINE), t.PRODUCTION_LINE);
    for (const line of Object.keys(this._state.calendars))    addName(Store.getPlantForLine(line), line);
    for (const line of Object.keys(this._state.lineSettings)) addName(Store.getPlantForLine(line), line);
    for (const r of (Store._state.masterData?.lines ?? []))   addName(r.plant, r.production_line);
    const linesByPlant: Record<string, string[]> = {};
    for (const [plant, set] of Object.entries(namesByPlant)) {
      linesByPlant[plant] = [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    }
    Store._linesByPlant = linesByPlant;
  },

  /* ----- wholesale replace (bulk hydration paths) ------------------------ */
  replaceBlocks(blocks: NimbusBlock[], source?: string): void { this._state.blocks = blocks; this.emit({ type: 'blocks:replace', source }); },
  replaceCalendars(calendars: Record<string, CalendarEntry>, source?: string): void { this._state.calendars = calendars; this.emit({ type: 'calendar:replace', source }); },
  replacePlants(plants: Record<string, CalendarEntry>, source?: string): void { this._state.plants = plants; this.emit({ type: 'plants:replace', source }); },
  replacePlantBlocks(plantBlocks: NimbusPlantBlock[], source?: string): void { this._state.plantBlocks = plantBlocks; this.emit({ type: 'plantBlocks:replace', source }); },
  replaceFixedIds(idSet: Set<string>, source?: string): void {
    this._state.fixedIds = new Set([...idSet]);
    for (const id of this._state.fixedIds) {
      const t = this._state.tasks[id];
      if (t) t.fixed = true;
    }
    this.emit({ type: 'fixed:replace', source });
  },

  // Patch a single task reference inside the _tasksByPlant index after updateTask swaps
  // prev→next, keeping the cached plant buckets coherent without a full O(n) rebuild.
  // Moves the task between buckets if its resolved plant changed (line/plant edit).
  _reindexTask(prev: NimbusTask, next: NimbusTask): void {
    const idx = Store._tasksByPlant;
    if (!idx) return; // index not built yet (pre-setTasks) — nothing to keep coherent
    const plantOf = (t: NimbusTask): string | null => t.PLANT || Store.getPlantForLine(t.PRODUCTION_LINE) || null;
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
      if (t.PRODUCTION_LINE) set.add(t.PRODUCTION_LINE);
    }
    Object.keys(this._state.calendars).forEach(l => set.add(l));
    Object.keys(this._state.lineSettings).forEach(l => set.add(l));
    // Master table is authoritative — include lines regardless of order attachment.
    (this._state.masterData?.lines ?? []).forEach(r => {
      if (r.production_line) set.add(r.production_line);
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
    for (const k of ['start_date','end_date','BASIC_START_DATE','BASIC_FINISH_DATE','original_start_date','original_end_date'] as const) {
      const v = task[k];
      if (v && !(v instanceof Date)) task[k] = Util.parseDate(v);
    }
    if (task.start_date) task.start_date = Util.snap(task.start_date);
    if (task.end_date)   task.end_date   = Util.snap(task.end_date);
    // To re-enable SAP firmed→fixed mapping: change the line below back to:
    //   task.fixed = !!task.fixed || !!task.firmed;
    task.fixed = !!task.fixed;
    if (task.fixed) Store._state.fixedIds.add(String(task.id));
    if (task.id != null) task.id = String(task.id);
  }
};

/* =============================================================================
   SELECTION — multi-select store, independent of vis-timeline internals.
   Single source of truth for "which orders are selected". All UIs (Timeline,
   Table, Inspector, ContextMenu) subscribe to this. Never persisted, never
   autosaved.
   ========================================================================== */
export const Selection = {
  _ids: new Set<string>(),           // Set<string>
  _anchor: null as string | null,              // id of last-single-clicked item (for Shift range)
  _listeners: new Set<(payload: SelectionEmitPayload) => void>(),

  /** @returns {string[]} currently selected ids */
  ids(): string[] { return [...this._ids]; },
  has(id: string | number): boolean { return this._ids.has(String(id)); },
  size(): number { return this._ids.size; },
  clear(): void {
    if (!this._ids.size) return;
    this._ids.clear();
    this._anchor = null;
    this._emit('clear');
  },
  set(ids: Array<string | number>): void {
    const next = new Set(ids.map(String));
    if (_setsEqual(next, this._ids)) return;
    this._ids = next;
    this._anchor = ids.length ? String(ids[ids.length - 1]) : null;
    this._emit('set');
  },
  add(ids: string | number | Array<string | number>): void {
    const arr = Array.isArray(ids) ? ids : [ids];
    let changed = false;
    for (const id of arr) {
      const s = String(id);
      if (!this._ids.has(s)) { this._ids.add(s); changed = true; }
    }
    if (changed) {
      this._anchor = String(arr[arr.length - 1]);
      this._emit('add');
    }
  },
  remove(ids: string | number | Array<string | number>): void {
    const arr = Array.isArray(ids) ? ids : [ids];
    let changed = false;
    for (const id of arr) {
      if (this._ids.delete(String(id))) changed = true;
    }
    if (changed) this._emit('remove');
  },
  toggle(id: string | number): void {
    const s = String(id);
    if (this._ids.has(s)) this._ids.delete(s);
    else { this._ids.add(s); this._anchor = s; }
    this._emit('toggle');
  },

  /** Select every id from anchor to target on the same line (inclusive). */
  selectRange(targetId: string | number): void {
    const target = String(targetId);
    const anchor = this._anchor;
    if (!anchor || anchor === target) { this.set([target]); return; }

    const ta = Store.tasks[anchor];
    const tt = Store.tasks[target];
    if (!ta || !tt || ta.PRODUCTION_LINE !== tt.PRODUCTION_LINE) {
      this.set([target]);
      return;
    }
    const line = ta.PRODUCTION_LINE;
    const peers = Store.tasksArr
      .filter(t => t.PRODUCTION_LINE === line && t.start_date)
      .sort((a, b) => Number(a.start_date) - Number(b.start_date));
    const ia = peers.findIndex(t => String(t.id) === anchor);
    const it = peers.findIndex(t => String(t.id) === target);
    if (ia < 0 || it < 0) { this.set([target]); return; }
    const [lo, hi] = ia < it ? [ia, it] : [it, ia];
    const range = peers.slice(lo, hi + 1).map(t => String(t.id));
    const keep = this._anchor;
    this.set(range);
    this._anchor = keep; // preserve anchor for further Shift-clicks
  },

  /** Summary for the Inspector multi-selection view. */
  stats(): { count: number; totalHours: number; lines: string[]; fixedCount: number } {
    const ids = [...this._ids];
    let totalHours = 0;
    const lines = new Set<string>();
    let fixedCount = 0;
    for (const id of ids) {
      const t = Store.tasks[id];
      if (!t) continue;
      totalHours += Util.runHours(t);
      if (t.PRODUCTION_LINE) lines.add(t.PRODUCTION_LINE);
      if (Store.isFixed(id)) fixedCount++;
    }
    return { count: ids.length, totalHours, lines: [...lines], fixedCount };
  },

  on(fn: (payload: SelectionEmitPayload) => void): () => void { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  _emit(kind: SelectionEmitKind): void {
    const payload = { kind, ids: [...this._ids], anchor: this._anchor };
    for (const l of this._listeners) {
      try { l(payload); } catch (e) { ErrorLog.error('selection', `listener: ${(e as Error).message}`); }
    }
  },

  /** [{plant, id}] for the currently selected ids — additive convenience for
   *  consumers that need plant scoping alongside the raw id (e.g. cross-plant
   *  bulk actions). Existing bare-ID methods above are unchanged. */
  selectedRefs(): Array<{ plant: string | null; id: string }> {
    return [...this._ids].map(id => ({ plant: Store.tasks[id]?.plant ?? null, id }));
  },
};

function _setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/* =============================================================================
   UNDO STACK — minimal, in-memory, destructive ops only (10 levels).
   Used by drag-commits and unschedule actions in the Interaction module.
   ========================================================================== */
export const UndoStack = {
  MAX: 10,
  _entries: [] as UndoEntry[],

  push(label: string, undoFn: () => void): void {
    this._entries.push({ label, undoFn, at: Date.now() });
    if (this._entries.length > this.MAX) this._entries.shift();
    Store.emit({ type: 'undo:pushed', label });
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
    const patches = snapshot.map(s => ({ id: s.id, changes: s }));
    Store.updateMany(patches, 'undo');
  },
};

/* =============================================================================
   SANDBOX — "What-If" mode state + snapshots only. Deep-clones Store state so
   planners can try changes freely without affecting the live schedule. The DOM
   banner/buttons, Toast messages, and cross-module side effects (Confidence
   snapshot/restore, Persistence.saveAll, CalendarSync flush/hydration) are NOT
   this module's concern — they live in app.js's `SandboxAdapter`, which
   subscribes to the `sandbox:entered`/`sandbox:exited` events emitted below.
   ========================================================================== */
export const Sandbox = {
  active: false,
  _snapshot: null as SandboxSnapshot | null,

  enter(source?: string): boolean {
    if (this.active) return false;
    this._snapshot = {
      tasks:       Store.tasksArr.map(t => Util.clone(t)),
      blocks:      Store.blocks.map(b => Util.clone(b)),
      calendars:   Util.clone(Store.calendars),
      plants:      Util.clone(Store.plants),
      plantBlocks: Store.plantBlocks.map(b => Util.clone(b)),
      fixedIds:    new Set([...Store.fixedIds]),
    };
    this.active = true;
    Store.emit({ type: 'sandbox:entered', source });
    return true;
  },

  exit(apply: boolean, source?: string): SandboxSnapshot | null {
    if (!this.active) return null;
    const snap = this._snapshot!;

    if (apply) {
      // Promote sandbox state to real state with a single undoable entry.
      UndoStack.push('Discard What-If scenario', () => {
        Store.setTasks(snap.tasks, 'undo');
        Store.replaceFixedIds(snap.fixedIds, 'undo');
        Store.emit({ type: 'sandbox:reverted', source: 'undo' });
      });
    } else {
      // Discard: restore the pre-enter snapshot wholesale. Each replaceX() below
      // fires its own '<field>:replace' event (distinct from that field's normal
      // '<field>:change' event) — a future consumer of 'blocks:change' /
      // 'calendar:change' / 'plants:change' / 'plantBlocks:change' / 'fixed:change'
      // must also handle the '*:replace' counterpart or it will silently miss
      // updates that happen via a What-If discard. See
      // docs/architecture/cq1-compatibility-inventory.md §6 and the pinned
      // event-sequence test in tests/modules/schedule-state.test.mjs.
      Store.setTasks(snap.tasks, 'sandbox');
      Store.replaceBlocks(snap.blocks, 'sandbox');
      Store.replaceCalendars(snap.calendars, 'sandbox');
      Store.replacePlants(snap.plants, 'sandbox');
      Store.replacePlantBlocks(snap.plantBlocks, 'sandbox');
      Store.replaceFixedIds(snap.fixedIds, 'sandbox');
    }

    this.active = false;
    this._snapshot = null;
    Store.emit({ type: 'sandbox:exited', applied: !!apply, source, snapshot: snap });
    return snap;
  },
};
