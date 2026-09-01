# TypeScript Migration — Phase 2 (`schedule-state.mts`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `web/schedule-state.mjs` (`Store`, `Selection`, `UndoStack`, `Sandbox` — the reactive state core; per `docs/typescript_migration.md`'s phase table, "the heaviest domain-type payoff") to real, `tsc`-checked TypeScript, importing domain types from Phase 1's `web/types.mts`.

**Architecture:** One file, renamed in place, zero behavior change. `schedule-state.mts` imports `NimbusTask`, `NimbusBlock`, `NimbusPlantBlock`, `WorkHours`, `NimbusLineSetting`, `NimbusMasterData`, `StoreEventType`, `SelectionEmitKind`, `StoreMode` from `./types.mjs`, plus the ambient global `NimbusAlert` (already declared correctly in `nimbus-compute-core.d.ts` — no import needed, it's global). Five other `.mjs` files (`application-shell.mjs`, `plant-and-administration.mjs`, `schedule-data.mjs`, `schedule-services.mjs`, `schedule-workbench.mjs`) and `app-entry.mjs` import from this file by name — none of those seven call sites need to change, since the compiled `.mjs` output lands at the same path with the same named exports (`Store`, `Selection`, `UndoStack`, `Sandbox`).

**Tech Stack:** Same as Phase 1 — `tsc`, no new dependencies.

## Global Constraints

Identical to Phase 1's Global Constraints (`docs/superpowers/plans/2026-08-01-typescript-migration-phase-1.md`), restated for a standalone reviewer:

- **Zero behavior change.** Type-annotation-only pass. Permitted non-type-syntax edits: (a) non-null/type assertions where the code already implicitly assumes a value's shape; (b) explicit coercions where strict typing rejects a value JS was already silently coercing; (c) declaring a property in an object literal's initial shape when the existing code only assigns it lazily on first use (TS requires object-literal properties to exist in the initial literal to have a stable type — unlike a class constructor, there's no special-cased "inferred from first assignment" path for plain object literals). Never add a new runtime guard that wasn't there before.
- **Preserve every existing comment verbatim.** This file has extensive "why" comments explaining forward-reference safety (`Store.mode()` referencing `Sandbox` before its declaration, `Store.removeTask` referencing `Selection`) and event-contract subtleties (Sandbox's `*:replace` vs `*:change` event distinction) — these are load-bearing documentation for future readers/phases, not decoration.
- **`import type { ... } from './types.mjs';`** — never `.mts`/`.js`. `NimbusAlert` is a *global ambient* type (from `nimbus-compute-core.d.ts`) and needs **no import** — referencing the bare identifier is correct here (unlike `NimbusTask`/`NimbusBlock`/etc., where the ambient global is a deliberately-minimal subset and the full domain type must be explicitly imported from `types.mjs` — see Phase 1's plan for that naming-collision writeup). `docs/typescript_migration.md` §E confirms `NimbusAlert`'s `type`/`sev` fields "match reality verbatim — safe to lift," and this phase relies on that being true for the whole shape.
- **This is the file six other modules import from** (`application-shell.mjs`, `plant-and-administration.mjs`, `schedule-data.mjs`, `schedule-services.mjs`, `schedule-workbench.mjs`, `app-entry.mjs`) — several of those (still-untyped) files reach directly into `Store._state.masterData`/`.blocks`/`.plantBlocks`/`.calendars`/`.plants`/`.lineSettings` and `Store._rev`, bypassing the public getters (a known, tracked pattern — see `CLAUDE.md`'s "2 still-open `Store._state`/`_rev` consumer exceptions"). Do **not** rename, remove, or mark `private` any of `_state`, `_rev`, `_tasksByPlant`, `_lineToPlant`, `_linesByPlant`, `_masterLinesByPlant` — these must stay plain, publicly-typed fields exactly as today, because those five untyped consumer files access them directly and would break at runtime (not caught by `tsc`, since it doesn't check untyped `.mjs` files) if the shape or a property name changed.
- **Always verify with `npm test`** (not `test:modules` directly — the `pretest` hook rebuilds first).
- **Do not edit** `tsconfig.json`, `tsconfig.worker.json`, `eslint.config.js`, `nimbus-compute-core.d.ts`, or any of the six consumer files listed above.
- **Lighter-weight signature guidance than Phase 1, by design:** Phase 1's task reviews confirmed the implementer can correctly resolve strict-mode errors beyond a plan's hand-derived signatures using a small, consistent toolkit (non-null/type assertions, explicit interface fields for lazily-added properties, coercions matching existing implicit JS coercion). This plan gives full type declarations and complete signatures/bodies only for the genuinely subtle parts of this file (the state shape, `emit`, `setTasks`, `updateTask`, `_reindexTask`, `alertsByTask`, `pref`) and a signature-only table for the rest — trust the same toolkit for anything the table doesn't cover, verified by `npm run typecheck` iteration exactly as Phase 2's own predecessor was.

---

## Task 1: Convert `web/schedule-state.mjs` → `.mts`

**Files:**
- Rename: `web/schedule-state.mjs` → `web/schedule-state.mts` (via `git mv`)
- Modify: `.gitignore` (add `web/schedule-state.mjs`)
- Modify: `docs/typescript_migration.md` (Phase 2 row: Future → Done)
- Modify: `CLAUDE.md` (TypeScript-migration mention: add this file)

**Interfaces:**
- Consumes: `NimbusTask`, `NimbusBlock`, `NimbusPlantBlock`, `WorkHours`, `NimbusLineSetting`, `NimbusMasterData`, `StoreEventType`, `SelectionEmitKind`, `StoreMode` from `./types.mjs` (Phase 1); the global ambient `NimbusAlert` (no import).
- Produces: identical public surface to today — `Store`, `Selection`, `UndoStack`, `Sandbox`, unchanged in shape and behavior. `application-shell.mjs`, `plant-and-administration.mjs`, `schedule-data.mjs`, `schedule-services.mjs`, `schedule-workbench.mjs` import these by name from `./schedule-state.mjs`; `app-entry.mjs` does `import * as state from './schedule-state.mjs'`. **None of these six call sites change.**

**Model guidance:** dispatch on a standard/capable model (same tier as Phase 1 Task 2) — this file's DI-resolver seams and forward-reference patterns need real judgment, not pure transcription.

### Step 1: Rename

- [ ] `git mv web/schedule-state.mjs web/schedule-state.mts`

### Step 2: Add imports and local type declarations

- [ ] After the file's top comment block (update its first line's filename reference from `.mjs` to `.mts`, keep the rest verbatim), insert:

```ts
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

/** What a subscriber actually receives — StoreEventInput plus the two fields emit() always adds. */
interface StoreEvent extends StoreEventInput {
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
```

- [ ] Change the two module-scope DI-resolver `let`s above `Store` to:

```ts
let _allowedPlantsResolver: AllowedPlantsResolver = () => null;
let _settingsDefaultsResolver: SettingsDefaultsResolver = () => ({});
```

### Step 3: Type `Store`'s field declarations and state shape

- [ ] Change the top of the `Store` object literal to:

```ts
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
    masterData: null,
    userSettings: { alertHorizonMinutes: null, confidenceHorizonMinutes: 20160 },
    roleDefaults: {}
  } as StoreState,
  _listeners: new Set<(event: StoreEvent) => void>(),
  // Lazily populated by alertsByTask() below — declared here (not left to first
  // assignment) because plain object-literal properties, unlike class fields
  // assigned in a constructor, need their type fixed at the literal's declaration.
  _alertsByTaskSrc: null as NimbusAlert[] | null,
  _alertsByTask: new Map<string, NimbusAlert[]>(),
  // Set by emit() on first mutation; read by rev(). Same reasoning as above.
  _rev: 0,
```

(`_masterLinesByPlant`'s value type is `NimbusMasterData['lines']`, i.e. `NimbusMasterLine[]` — reuses the array-of-master-line-rows type Phase 1 already defined, via an indexed-access type rather than re-declaring it.)

- [ ] Signatures for this section:

| Method | New signature |
|---|---|
| `setAllowedPlantsResolver` | `setAllowedPlantsResolver(fn: AllowedPlantsResolver): void {` |
| `setSettingsDefaultsResolver` | `setSettingsDefaultsResolver(fn: SettingsDefaultsResolver): void {` |
| `rev` | `rev(): number {` |
| `mode` | `mode(): StoreMode {` |

### Step 4: Type the getters and `isFixed`/setters

- [ ] Every `get X()` getter's return type follows directly from `StoreState` — add return types matching the table:

| Getter | Return type |
|---|---|
| `state` | `StoreState` |
| `tasks` | `Record<string, NimbusTask>` |
| `blocks` | `NimbusBlock[]` |
| `alerts` | `NimbusAlert[]` |
| `calendars` | `Record<string, CalendarEntry>` |
| `fixedIds` | `Set<string>` |
| `tasksArr` | `NimbusTask[]` |
| `plants` | `Record<string, CalendarEntry>` |
| `plantBlocks` | `NimbusPlantBlock[]` |
| `lineSettings` | `Record<string, NimbusLineSetting>` |
| `selectedPlant` | `string \| null` |
| `userSettings` | `StoreState['userSettings']` |
| `roleDefaults` | `Record<string, unknown>` |
| `masterData` | `NimbusMasterData \| null` |
| `dependencies` | `Record<string, string[]>` |

- [ ] `isFixed(id: string | number): boolean {`
- [ ] `setLastOptimize(date: Date | null, _source?: string): void {`
- [ ] `setMasterData(masterData: NimbusMasterData | null, source?: string): void {`

### Step 5: Type subscription and `emit`

- [ ] `subscribe(fn: (event: StoreEvent) => void, label?: string): () => void {` (body unchanged)
- [ ] Replace `emit` with:

```ts
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
```

`l._pmLabel` needs `_listeners`'s function type to carry an optional expando property — change the `_listeners` declaration from Step 3 to:

```ts
  _listeners: new Set<((event: StoreEvent) => void) & { _pmLabel?: string }>(),
```

and `subscribe`'s parameter type to match: `subscribe(fn: ((event: StoreEvent) => void) & { _pmLabel?: string }, label?: string): () => void {` (the body's `if (label) fn._pmLabel = label;` then type-checks against this signature without an assertion).

### Step 6: Type the task mutators

- [ ] Replace `setTasks` with:

```ts
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
```

- [ ] Replace `updateTask` with:

```ts
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
```

- [ ] `removeTask(id: string | number, source?: string): NimbusTask | null {` (body unchanged)
- [ ] `updateMany(patches: Array<{ id: string; changes: Partial<NimbusTask> }>, source?: string): void {` (body unchanged)
- [ ] `setFixed(ids: string | number | Array<string | number>, fixed: boolean, source?: string): void {` (body unchanged)

- [ ] Replace `_reindexTask` with:

```ts
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
```

### Step 7: Type calendar/block/plant/line-settings mutators — signature table (bodies unchanged)

| Method | New signature |
|---|---|
| `setCalendar` | `setCalendar(line: string, workHours: WorkHours, source?: string): void {` |
| `ensureCalendar` | `ensureCalendar(line: string): void {` |
| `addBlock` | `addBlock(block: NimbusBlock, source?: string): void {` |
| `removeBlock` | `removeBlock(blockId: string, source?: string): void {` |
| `ensurePlant` | `ensurePlant(name: string | null): void {` |
| `setPlantWorkHours` | `setPlantWorkHours(plant: string, dow: number, range: [number, number] | null, source?: string): void {` |
| `clampLinesToPlant` | `clampLinesToPlant(plant: string, dow: number): string[] {` |
| `addPlantBlock` | `addPlantBlock(block: NimbusPlantBlock, source?: string): void {` |
| `removePlantBlock` | `removePlantBlock(id: string, source?: string): void {` |
| `ensureLineSettings` | `ensureLineSettings(line: string): void {` |
| `setLineSetting` | `setLineSetting(line: string, patch: Partial<NimbusLineSetting>, source?: string): void {` |
| `getPlantForLine` | `getPlantForLine(line: string): string | null {` |
| `setSelectedPlant` | `setSelectedPlant(plant: string | null, source?: string): void {` |

`addBlock`'s body calls `ErrorLog.warn?.(...)` — leave the optional-chaining call as-is, it type-checks fine against `ErrorLog.warn`'s real (non-optional) signature from Phase 1's `application-foundation.mts`.

### Step 8: Type plant-scoped accessors and `rebuildPlantIndex`

| Method | New signature |
|---|---|
| `tasksByPlant` | `tasksByPlant(plant: string | null): NimbusTask[] {` |
| `rebuildPlantIndex` | `rebuildPlantIndex(): void {` |
| `replaceBlocks` | `replaceBlocks(blocks: NimbusBlock[], source?: string): void {` |
| `replaceCalendars` | `replaceCalendars(calendars: Record<string, CalendarEntry>, source?: string): void {` |
| `replacePlants` | `replacePlants(plants: Record<string, CalendarEntry>, source?: string): void {` |
| `replacePlantBlocks` | `replacePlantBlocks(plantBlocks: NimbusPlantBlock[], source?: string): void {` |
| `replaceFixedIds` | `replaceFixedIds(idSet: Set<string>, source?: string): void {` |
| `allLines` | `allLines(): string[] {` |
| `tasksForSelectedPlant` | `tasksForSelectedPlant(): NimbusTask[] {` |
| `linesForSelectedPlant` | `linesForSelectedPlant(): string[] {` |
| `masterLinesForPlant` | `masterLinesForPlant(plant: string | null): NimbusMasterData['lines'] {` |
| `knownPlants` | `knownPlants(): string[] {` |

`rebuildPlantIndex`'s body declares `const l2p = {}` then indexes it — annotate as `const l2p: Record<string, string | null> = {};`, and `const masterByPlant = {}` as `const masterByPlant: Record<string, NimbusMasterData['lines']> = {};`, and `const idx = {}` as `const idx: Record<string, NimbusTask[]> = {};`, and `const namesByPlant = {}` as `const namesByPlant: Record<string, Set<string>> = {};` (all four are the same "implicit-any object then indexed-assigned" pattern flagged in Phase 1's deviation log — annotate upfront rather than waiting for `tsc` to flag it, since this file's pattern is identical and now-known).

### Step 9: Type alerts, `alertsByTask`, settings, `pref`

| Method | New signature |
|---|---|
| `setAlerts` | `setAlerts(alerts: NimbusAlert[], source?: string): void {` |
| `dismissAlert` | `dismissAlert(alertId: string, source?: string): void {` |
| `dismissAllAlerts` | `dismissAllAlerts(source?: string): void {` |
| `setUserSettings` | `setUserSettings(patch: Record<string, unknown>, source?: string): void {` |
| `setRoleDefaults` | `setRoleDefaults(obj: Record<string, unknown> | null | undefined, source?: string): void {` |

`setAlerts`'s body declares `const oldTaskIds = new Set(...)`/`const newTaskIds = new Set(...)`/`const changedIds = []` — annotate `const changedIds: string[] = [];` (the two `Set`s infer correctly as `Set<string>` from `.map(a => a.taskId)` combined with `.filter(id => id != null)` narrowing — no annotation needed there).

- [ ] Replace `alertsByTask` with:

```ts
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
```

- [ ] Replace `pref` with:

```ts
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
```

(`opts` is accepted only for the one `{ plant? }` shape any call site actually passes — grep the codebase for `Store.pref(` call sites with a second argument before finalizing this signature; if any pass additional fields, widen `opts` to `Record<string, unknown>` instead.)

### Step 10: Type `_normalizeDates`

- [ ] Replace with:

```ts
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
```

(The `as const` on the field-name array lets `task[k]` resolve to the precise union of those six fields' types instead of widening to every `NimbusTask` property via the index signature — needed because `NimbusTask` carries an open index signature, per Phase 1's `types.mts`.)

### Step 11: Type `Selection`

- [ ] Change the field declarations and signatures:

```ts
export const Selection = {
  _ids: new Set<string>(),
  _anchor: null as string | null,
  _listeners: new Set<(payload: SelectionEmitPayload) => void>(),

  ids(): string[] { return [...this._ids]; },
  has(id: string | number): boolean { return this._ids.has(String(id)); },
  size(): number { return this._ids.size; },
  clear(): void {
    // ... body unchanged ...
  },
  set(ids: Array<string | number>): void {
    // ... body unchanged ...
  },
  add(ids: string | number | Array<string | number>): void {
    // ... body unchanged ...
  },
  remove(ids: string | number | Array<string | number>): void {
    // ... body unchanged ...
  },
  toggle(id: string | number): void {
    // ... body unchanged ...
  },
  selectRange(targetId: string | number): void {
    // ... body unchanged ...
  },
  stats(): { count: number; totalHours: number; lines: string[]; fixedCount: number } {
    // ... body unchanged ...
  },
  on(fn: (payload: SelectionEmitPayload) => void): () => void { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  _emit(kind: SelectionEmitKind): void {
    // ... body unchanged ...
  },
  selectedRefs(): Array<{ plant: string | null; id: string }> {
    // ... body unchanged ...
  },
};
```

`selectRange`'s body sorts by `a.start_date - b.start_date` where both are `Date | null` (filtered to truthy just above via `.filter(t => ... && t.start_date)`, but the filter doesn't narrow the array's element type past the closure boundary) — if `tsc` flags this arithmetic, fix with `Number(a.start_date) - Number(b.start_date)` (same pattern already used and reviewer-approved in Phase 1's `countChangeovers`).

- [ ] Type the standalone helper below `Selection`: `function _setsEqual(a: Set<string>, b: Set<string>): boolean {` (body unchanged)

### Step 12: Type `UndoStack`

```ts
export const UndoStack = {
  MAX: 10,
  _entries: [] as UndoEntry[],

  push(label: string, undoFn: () => void): void {
    // ... body unchanged ...
  },
  pop(): UndoEntry | null {
    // ... body unchanged ...
  },
  snapshotTasks(ids: string[]): NimbusTask[] {
    // ... body unchanged ...
  },
  restoreTasks(snapshot: NimbusTask[]): void {
    const patches = snapshot.map(s => ({ id: s.id, changes: s }));
    Store.updateMany(patches, 'undo');
  },
};
```

`snapshotTasks`'s body calls `structuredClone(t)` — this is a global in `lib: ["es2022", "dom"]` and returns `NimbusTask` correctly via generic inference from `t: NimbusTask`; no cast needed. `pop`'s body calls `e.undoFn()` and `Toast.show(Util.t('toast.undone', { label: e.label }), 'success')` — both already typed correctly by Phase 1's `application-foundation.mts` signatures (`Util.t`'s `vars` param is `Record<string, string | number>`, and `label: string` satisfies that).

### Step 13: Type `Sandbox`

```ts
export const Sandbox = {
  active: false,
  _snapshot: null as SandboxSnapshot | null,

  enter(source?: string): boolean {
    // ... body unchanged ...
  },

  exit(apply: boolean, source?: string): SandboxSnapshot | null {
    // ... body unchanged ...
  },
};
```

`enter`'s body builds `this._snapshot = { tasks: ..., blocks: ..., calendars: ..., plants: ..., plantBlocks: ..., fixedIds: ... }` — this object literal's shape must match `SandboxSnapshot` exactly (it does, field-for-field, per Step 2's type). `Util.clone(t)`/`Util.clone(b)` calls resolve via `Util.clone`'s Phase 1 generic signature (`clone<T>(obj: T): T`) to the correct element type automatically.

### Step 14: Typecheck, build, test — iterate to green

- [ ] Run: `npm run typecheck` — fix any strict-mode errors this plan's signatures don't cover using the same toolkit as Phase 1 (non-null/type assertions, explicit interface fields for lazily-added properties, `Number()`/`String()`-style coercions matching existing implicit JS coercion). Do not change behavior or loosen `strict`.
- [ ] Run: `npm run build`
- [ ] Run: `npm test` — expect all passing, including `tests/modules/schedule-state.test.mjs` (the event-sequence-pinning test for `Sandbox.exit(false)` is the most behavior-sensitive one in this file — if it fails, the bug is almost certainly an accidental reordering of the `replaceX()` calls in `Sandbox.exit`, not a typing issue).
- [ ] Run: `npm run lint` — confirm no new errors on `web/schedule-state.mts`.

### Step 15: Update the roadmap doc and CLAUDE.md

- [ ] In `docs/typescript_migration.md`'s phase table, flip Phase 2's Status from `Future` to `Done`.
- [ ] In `CLAUDE.md`, extend the TypeScript-migration sentence to also mention `web/schedule-state.mts`.

### Step 16: Commit

```bash
git add web/schedule-state.mts .gitignore docs/typescript_migration.md CLAUDE.md
git commit -m "typescript migration phase 2: convert schedule-state.mjs to .mts"
```

---

## Self-Review Notes

- **Spec coverage:** all four exports named in the roadmap's Phase 2 row (`Store`, `Selection`, `UndoStack`, `Sandbox`) have full type coverage in this plan.
- **Known open risk:** unlike Phase 1, most of this plan's method entries are signature-only (body unchanged), trusting the implementer to iterate against real `tsc` output for anything not spelled out — this is a deliberate cost/thoroughness tradeoff justified by Phase 1's clean review outcome, not an oversight. The genuinely tricky spots (state shape, `emit`, `setTasks`, `updateTask`, `_reindexTask`, `alertsByTask`, `pref`, `_normalizeDates`) get full bodies because they involve real design decisions (the `StoreEvent`/`StoreEventInput` split, the lazily-added expando fields, the `as const` field-list cast) that a signature line alone can't convey.
- **Cross-file risk flagged explicitly, not hidden:** the five untyped `.mjs` consumers reaching into `Store._state`/`Store._rev` directly are called out in Global Constraints as a hard "do not rename" boundary — this is the primary way this phase could silently break something `tsc` can't see.
