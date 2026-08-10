# TypeScript Migration — Phase 3 (`schedule-services.mts`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `web/schedule-services.mjs` (`Calendar`, `Compute`, `Alerts`, `Utilization`, `Engine`) to real, `tsc`-checked TypeScript — with **full precise typing for `Calendar`/`Compute`/`Alerts`/`Utilization`**, and **deliberately loose/minimal typing for `Engine`** (a documented, user-approved tradeoff — see Global Constraints).

**Architecture:** One file, renamed in place, zero behavior change. Imports `NimbusTask`, `NimbusBlock`, `NimbusPlantBlock`, `WorkHours`, `NimbusLineSetting`, `NimbusMasterData`, `ConstraintConfig`, `OptimizerMode` from `./types.mjs`; the ambient globals `NimbusAlert`, `NimbusUtilizationMatrix`, `NimbusUtilizationRow`, `NimbusComputeCoreApi` (all from `nimbus-compute-core.d.ts`) need no import. Four files (`application-shell.mjs`, `plant-and-administration.mjs`, `schedule-workbench.mjs`, `app-entry.mjs`) import from this file by name — none of those call sites change.

**Tech Stack:** Same as prior phases — `tsc`, no new dependencies.

## Why Engine gets looser typing than everything else (read this before Task 1)

`Engine` (`runAndApply`, `_dispatchDayIntegrity`, `autoReflow`) is the production-scheduling optimizer for a **live** manufacturing tool. It is the single most algorithmically complex code in the frontend — nested closures over a heterogeneous "sort term" array (`{get, cmp}` pairs mixing string- and number-keyed comparators), a two-phase admit-then-resequence day-integrity dispatch, and per `docs/typescript_migration.md`'s own project memory, it ships with **4 known, deliberately-unfixed bugs** (multi-day window bypass, force-place off-by-one, SPT non-determinism, force-place/fixed-task overlap) that must not be accidentally "fixed" by this migration.

**Decision (user-approved 2026-08-01):** Convert the whole file to `.mts` in one pass (matching the CQ-1 module boundary — `Engine` cannot be physically split into its own file without a larger, separately-scoped architecture change this plan does not make). `Calendar`/`Compute`/`Alerts`/`Utilization` get the same full-rigor typing as every prior phase. `Engine` gets the *loosest types that compile* — `any`/`unknown`/loose object shapes wherever strict mode complains inside its internals — rather than precisely modeling the sort-term heterogeneity or the dispatch algorithm's closures. Its public method signatures still get reasonable outer types (they're cheap and useful for the four consumer files), but nothing inside `_sortTerms`, `_comparator`, or `_dispatchDayIntegrity` should be hand-derived to the same precision as Phase 1/2's trickiest spots. A future follow-up phase will tighten Engine's types — after first capturing its exact current output across representative scenarios as a regression baseline, so a later type-tightening pass can't silently change scheduling behavior either.

## Global Constraints

Same as Phases 1-2 (zero behavior change; permitted edits are type syntax + non-null/type assertions + explicit fields for lazily-added properties + coercions matching existing implicit JS coercion; preserve every comment verbatim; `import type {...} from './types.mjs'`; always verify with `npm test`; don't edit `tsconfig.json`/`tsconfig.worker.json`/`eslint.config.js`/`nimbus-compute-core.d.ts`/consumer files), plus:

- **The `Engine` looseness above is a deliberate scope boundary, not a shortcut to extend elsewhere.** `Calendar`, `Compute`, `Alerts`, and `Utilization` must get the SAME rigor as Phase 1/2 — don't let "Engine is loose" bleed into treating the rest of this file casually.
- **The two-utilization-row-shape trap (§E4 of `docs/typescript_migration.md`, trap T-8):** `Utilization.computeMatrix`'s rows carry `tasks: NimbusTask[]` (resolved from ids to real task objects); the ambient global `NimbusUtilizationRow`'s `tasks: string[]` is the *worker/core contract* shape, before resolution. These are two distinct types — do not collapse them into one. `Utilization.dayByLine`/`todayByLine` return a **third**, entirely different row shape (`{capacity, effectiveCapacity, scheduled, pct}`, no `date`/`tasks` at all).
- **`Compute` must stay fully encapsulated** — `tests/modules/schedule-services.test.mjs` asserts `Object.keys(Compute)` is exactly `['alerts', 'available', 'utilization']` (no `_`-prefixed property leaks onto the returned object). The IIFE-closure pattern already guarantees this; just don't accidentally hoist an internal helper onto the returned object literal while typing it.
- **`Engine.CONSTRAINT_CATALOG`, `activeConstraintKeys`, `constraintEnabled` should still be properly typed** (via `ConstraintConfig` from `types.mjs`) — these are simple, cheap to type precisely, and worth doing even under the "Engine is loose" umbrella; the looseness is specifically for the sort-term/dispatch internals, not an excuse to skip easy wins.

---

## Task 1: Convert `web/schedule-services.mjs` → `.mts`

**Files:**
- Rename: `web/schedule-services.mjs` → `web/schedule-services.mts` (via `git mv`)
- Modify: `.gitignore` (add `web/schedule-services.mjs`)
- Modify: `docs/typescript_migration.md` (Phase 3 row: Future → Done, plus a dated note explaining the Engine-looseness decision and that a follow-up phase will tighten it)
- Modify: `CLAUDE.md` (TypeScript-migration mention: add this file)

**Interfaces:**
- Consumes: `NimbusTask`, `NimbusBlock`, `NimbusPlantBlock`, `WorkHours`, `NimbusLineSetting`, `NimbusMasterData`, `ConstraintConfig`, `OptimizerMode` from `./types.mjs`; ambient globals `NimbusAlert`, `NimbusUtilizationMatrix`, `NimbusUtilizationRow` (no import).
- Produces: identical public surface — `Calendar`, `Compute`, `Alerts`, `Utilization`, `Engine`. `application-shell.mjs` (`Alerts`), `plant-and-administration.mjs` (`Calendar`, `Engine`, `Utilization`), `schedule-workbench.mjs` (`Calendar`, `Utilization`, `Alerts`, `Engine`), `app-entry.mjs` (`import * as services`). **None of these four call sites change.**

**Model guidance:** dispatch on a standard/capable model. `Calendar`/`Compute`/`Alerts`/`Utilization` need the same judgment as Phase 2; `Engine` needs judgment of a *different* kind — knowing when to stop precisely modeling something and just make it compile.

### Step 1: Rename

- [ ] `git mv web/schedule-services.mjs web/schedule-services.mts`

### Step 2: Imports and shared local types

- [ ] After the file's top comment block (update the filename reference only), insert:

```ts
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, NimbusMasterData, ConstraintConfig, OptimizerMode } from './types.mjs';

// -- Local type declarations (Phase 3 conversion; scoped to this file) ------
interface CalendarEntry {
  workHours: WorkHours;
}

interface BlockRec {
  s: number;
  e: number;
  startDate: Date;
  endDate: Date;
}

interface RunBlocksIndex {
  byLine: Map<string, BlockRec[]>;
  byPlant: Map<string, BlockRec[]>;
}

interface CapRec {
  s: Date;
  e: Date;
  plant: string | null;
}

interface PlantCapRec {
  s: Date;
  e: Date;
}

interface CapacityBlockIndex {
  lineBlocks: Map<string, CapRec[]>;
  globalLine: CapRec[];
  plantBlocks: Map<string, PlantCapRec[]>;
  globalPlant: PlantCapRec[];
}

/** Fields common to both the ALERTS and UTILIZATION worker payloads (Compute._snap's return). */
interface WorkerSnapshotBase {
  tasks: NimbusTask[];
  blocks: NimbusBlock[];
  plantBlocks: NimbusPlantBlock[];
  calendars: Record<string, CalendarEntry>;
  plants: Record<string, CalendarEntry>;
  lineSettings: Record<string, NimbusLineSetting>;
  masterData: NimbusMasterData | null;
}

/** Utilization.computeMatrix's row shape — tasks RESOLVED to objects (see T-8 in
 *  docs/typescript_migration.md: this is deliberately NOT the same type as the
 *  ambient NimbusUtilizationRow, whose `tasks: string[]` is the pre-resolution
 *  worker/core contract shape). */
interface UtilizationRowResolved {
  date: Date;
  scheduled: number;
  capacity: number;
  effectiveCapacity: number;
  tasks: NimbusTask[];
  pct?: number;
}

interface UtilizationMatrixResolved {
  [line: string]: Record<string, UtilizationRowResolved>;
}

/** Utilization.dayByLine/todayByLine's row shape — a THIRD, distinct shape:
 *  no date/tasks at all. */
interface DayByLineRow {
  capacity: number;
  effectiveCapacity: number;
  scheduled: number;
  pct: number;
}

/** Deliberately loose (see this plan's "Why Engine gets looser typing" section):
 *  cmp's params are `any` (not `T`) so a heterogeneous array of terms with
 *  different key types (number for runHours/colorMap, string for
 *  FORM_SIZE/MATERIAL_NUMBER) can share one array type without fighting
 *  strict-mode function-parameter variance. Precision here is intentionally
 *  deferred to a future Engine-focused phase. */
interface SortTerm {
  get(t: NimbusTask): number | string;
  cmp(a: any, b: any): number;
}
```

### Step 3: Type `Calendar` (full rigor)

- [ ] Change the field declarations and every method signature (bodies unchanged except where noted):

```ts
export const Calendar = {
  _runCache: null as { ww: Map<string, [Date, Date] | null> } | null,
  _runBlocks: null as RunBlocksIndex | null,

  _beginRun(plant: string | null): void {
    // ... body unchanged ...
  },
  _endRun(): void {
    Calendar._runCache  = null;
    Calendar._runBlocks = null;
  },
  _indexBlocks(plant: string | null): RunBlocksIndex {
    // ... body unchanged ...
  },
  _dayWindow(workHours: WorkHours, date: Date): [Date, Date] | null {
    return globalThis.NimbusComputeCore!._dayWindow(workHours, date);
  },
  workWindow(line: string, date: Date): [Date, Date] | null {
    // ... body unchanged ...
  },
  _indexCapacityBlocks(): CapacityBlockIndex {
    // ... body unchanged ...
  },
  dailyCapacityHours(line: string, date: Date, idx?: CapacityBlockIndex): number {
    // ... body unchanged ...
  },
  effectiveFromCapacity(line: string, full: number): number {
    return globalThis.NimbusComputeCore!.effectiveFromCapacity(line, full, Store.lineSettings);
  },
  effectiveCapacityHours(line: string, date: Date): number {
    return Calendar.effectiveFromCapacity(line, Calendar.dailyCapacityHours(line, date));
  },
  isAvailable(line: string, date: Date): boolean {
    // ... body unchanged ...
  },
  nextAvailable(line: string, from: Date, durationMs: number): Date {
    // ... body unchanged ...
  },
  _overlapsBlock(line: string, start: Date, end: Date): { start: Date; end: Date } | null {
    // ... body unchanged ...
  },
};
```

`globalThis.NimbusComputeCore` is typed `NimbusComputeCoreApi | undefined` by the ambient declaration in `nimbus-compute-core.d.ts` — the `!` non-null assertion matches this file's own existing runtime assumption (documented at the top of the file: the UMD core is loaded as a parser-blocking `<script>` before any function here is called) and mirrors the identical assertion already used and reviewer-approved in `nimbus-worker.ts` (`const Core = self.NimbusComputeCore!;`).

`_indexBlocks`'s and `_indexCapacityBlocks`'s bodies declare untyped `new Map()`s and push into them — annotate each `new Map()` with its element type from the interfaces above (e.g. `const byLine = new Map<string, BlockRec[]>();`) rather than waiting for `tsc` to infer `Map<any, any>` and complain later on `.push`.

### Step 4: Type `Compute` (full rigor)

- [ ] Replace the whole IIFE:

```ts
export const Compute = (() => {
  let _worker: Worker | null = null;
  let _dead   = false;
  let _crashCount = 0;
  let _seq    = 0;
  const _pending = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>();

  function _init(): Worker | null {
    // ... body unchanged ...
  }

  function _post(type: 'ALERTS' | 'UTILIZATION', payload: Record<string, unknown>): Promise<any> {
    // ... body unchanged ...
  }

  function _snap(): WorkerSnapshotBase {
    // ... body unchanged ...
  }

  return {
    available(): boolean { return !_dead && typeof Worker !== 'undefined'; },

    alerts(opts: { lines?: Set<string> } = {}, dismissed?: Set<string>): Promise<{ alerts: NimbusAlert[]; elapsed: number }> {
      // ... body unchanged ...
    },

    utilization(startMs: number, days: number): Promise<{ matrix: NimbusUtilizationMatrix }> {
      // ... body unchanged ...
    },
  };
})();
```

`_snap`'s body declares `const pick = obj => {...}` — type it as `const pick = <T,>(obj: Record<string, T>): Record<string, T> => { const out: Record<string, T> = {}; ... };` (the trailing comma after `T` avoids the `.tsx`-style ambiguity; irrelevant here since this is `.mts` not `.tsx`, but harmless either way — leave it out if it causes a parse issue, it won't in a `.mts` file). `_worker.onmessage`/`.onerror` handler parameters (`{ data }`, `ev`) get inferred correctly from `Worker`'s ambient DOM type — no extra annotation needed unless `tsc` says otherwise.

### Step 5: Type `Alerts` (full rigor)

```ts
export const Alerts = {
  recompute(opts: { lines?: Set<string> } = {}): void {
    // ... body unchanged ...
  },
  _recomputeSync(opts: { lines?: Set<string> } = {}): void {
    // ... body unchanged ...
  },
  _dismissed: new Set<string>(),
  dismiss(alertId: string): void {
    // ... body unchanged ...
  },
  dismissAll(): void {
    // ... body unchanged ...
  },
  clearDismissed(): void { Alerts._dismissed.clear(); },
  applyFix(alertId: string): void {
    // ... body unchanged ...
  },
};
Alerts._lastMs = 0;
Alerts._timer = null as ReturnType<typeof setTimeout> | null;
Alerts._pendingFull = false;
Alerts._pendingLines = new Set<string>();
Alerts._fire = function (): void {
  // ... body unchanged ...
};
Alerts._armTimer = function (): void {
  // ... body unchanged ...
};
Alerts.scheduleRecompute = function (): void {
  // ... body unchanged ...
};
Alerts.scheduleRecomputeLines = function (lines: Set<string> | null | undefined): void {
  // ... body unchanged ...
};
```

The module-scope `Alerts._lastMs = 0;` etc. assignments happen OUTSIDE the object literal (after it), which means `Alerts`'s own inferred type from the literal won't have these properties declared — TypeScript needs them declared inside the initial object literal instead (same "object-literal properties need to exist in the initial literal" rule as Phase 2's `_alertsByTaskSrc`/`_rev`), OR add an explicit type annotation on the `Alerts` const covering all of them. **Simplest fix, matching this codebase's existing style:** move these five assignments' initial values into the object literal itself as declared properties (`_lastMs: 0`, `_timer: null as ReturnType<typeof setTimeout> | null`, `_pendingFull: false`, `_pendingLines: new Set<string>()`, and the four function properties `_fire`, `_armTimer`, `scheduleRecompute`, `scheduleRecomputeLines` as method-shorthand entries) rather than leaving them as post-hoc assignments. This changes where the code visually lives (inside vs. just after the literal) but not what it does — confirm with the implementer's own judgment whether moving them in is cleaner than annotating `Alerts`'s type separately; either is acceptable as long as it compiles and nothing is dropped.

`applyFix`'s body reads `a.line`/`a.time`/`a.taskId` off a `NimbusAlert` — these are typed required/non-optional on the ambient global (a known drift vs. reality per `docs/typescript_migration.md` §E5, out of scope to fix here) — this should not cause a compile error either way (reading a required field is always legal), only a false sense that these are guaranteed present; no code change needed on account of this.

### Step 6: Type `Utilization` (full rigor)

```ts
export const Utilization = {
  _cache: null as { key: string; matrix: UtilizationMatrixResolved } | null,

  computeMatrix(startDate: Date, days: number = 7, srcTasks: NimbusTask[] | null = null): UtilizationMatrixResolved {
    // ... body unchanged, EXCEPT the final `matrix` (from
    // globalThis.NimbusComputeCore!.computeUtilization(...), typed NimbusUtilizationMatrix
    // with `tasks: string[]`) is mutated in place to hold resolved task objects — cast the
    // return: `return matrix as unknown as UtilizationMatrixResolved;` The in-place mutation
    // loop itself needs `rows[k].tasks = rows[k].tasks.map(id => byId.get(id)).filter(Boolean) as NimbusTask[];`
    // (same `.filter(Boolean)` cast pattern already established and reviewer-approved in
    // Phase 2's UndoStack.snapshotTasks — Boolean isn't recognized as a TS type-guard predicate).
  },

  sev(pct: number, overloadAt: number = Config.OVERLOAD_THRESHOLD): 'err' | 'warn' | 'ok' {
    // ... body unchanged ...
  },

  todayByLine(): Record<string, DayByLineRow> {
    return Utilization.dayByLine(new Date());
  },

  dayByLine(date: Date, srcTasks: NimbusTask[] | null = null): Record<string, DayByLineRow> {
    // ... body unchanged ...
  }
};

Utilization._prewarm = function (): void {
  // ... body unchanged ...
};
```

(Same object-literal-vs-post-hoc-assignment note as `Alerts` applies to `Utilization._prewarm` — either move it into the literal or add an explicit type annotation covering it; either is fine.)

`computeMatrix`'s call into `globalThis.NimbusComputeCore!.computeUtilization({...})` needs its payload object to satisfy the ambient `ComputeUtilizationPayload` interface — pass `calendars`/`plants`/`lineSettings`/`masterData` exactly as the body already does (`Store.calendars`, etc., all already typed correctly by Phase 2's `schedule-state.mts`); no extra casting expected there.

`dayByLine`'s body has a `const dEndMs = (() => { const x = new Date(d); x.setDate(x.getDate() + 1); return x.getTime(); })();` IIFE — no annotation needed (arrow function with no params, return type inferred as `number`).

### Step 7: Type `Engine` (deliberately loose — see this plan's header section)

- [ ] Outer signatures (reasonably precise — these are the consumer-facing surface):

```ts
export const Engine = {
  CONSTRAINT_CATALOG: [
    { key: 'colorWheel', label: 'Color wheel',
      desc: 'Sequence orders by color-wheel priority to minimize color changeovers.' },
  ] as Array<{ key: string; label: string; desc: string }>,

  constraintsFor(plant: string | null): ConstraintConfig[] | null {
    // ... body unchanged ...
  },

  constraintEnabled(plant: string | null, key: string): boolean {
    // ... body unchanged ...
  },

  activeConstraintKeys(plant: string | null): string[] {
    // ... body unchanged ...
  },

  _sortTerms(mode: string, opts: { plant?: string | null; colorMap?: Record<string, number> | null } = {}): SortTerm[] {
    // ... body unchanged; numCmp/strCmp locals get explicit (a: number, b: number) /
    // (a: string, b: string) param types since they're implicit-any closures otherwise ...
  },

  _comparator(mode: string, opts: { plant?: string | null; colorMap?: Record<string, number> | null } = {}): (a: NimbusTask, b: NimbusTask) => number {
    // ... body unchanged ...
  },

  _dispatchDayIntegrity(
    line: string,
    freeTasksIn: NimbusTask[],
    fixedTasks: NimbusTask[],
    cursorInit: Date,
    opts: { respectCalendar: boolean; tieBreakTerms: SortTerm[]; mode: string }
  ): Array<{ id: string; changes: Partial<NimbusTask> }> {
    // ... body unchanged. This method's internal closures (nextFixIdx, fitsAt, seqCompare,
    // rankForDay) are NOT hand-typed by this plan — type them with whatever's fastest to
    // get green (explicit `any`/`unknown` params where a closure's inferred contextual type
    // doesn't cover it, loose object shapes for the `{t, tier, due, k}` decorated-sort
    // records, etc.). Do not spend effort making these precise. Do not change any
    // comparison/branching logic while adding types — this function's exact current
    // behavior (bugs included) must survive unchanged.
  },

  runAndApply(mode: OptimizerMode = 'combined', opts: Record<string, unknown> = {}): void {
    // ... body unchanged; internals get loose/any typing per this section's header note ...
  },

  autoReflow(changedId: string): void {
    // ... body unchanged ...
  }
};
```

- [ ] After getting a clean `npm run typecheck`, do a **quick sanity pass** (not a rewrite) over `_dispatchDayIntegrity`'s and `runAndApply`'s bodies: confirm no `any` was used in a way that silently changed a comparison (e.g. a `===` that used to compare two `Date`s now comparing a `Date` against something typed `any` that could be a different runtime value) — this is a read-through check, not a typing exercise. If anything looks suspicious, flag it in the report rather than guessing at a fix.

### Step 8: Typecheck, build, test — iterate to green

- [ ] `npm run typecheck` — fix strict-mode errors using the established toolkit (Phases 1-2) for `Calendar`/`Compute`/`Alerts`/`Utilization`; use the loosest-that-compiles approach for `Engine`'s internals per Step 7.
- [ ] `npm run build`
- [ ] `npm test` — expect all passing, including `tests/modules/schedule-services.test.mjs`'s full suite: the `Compute` encapsulation check (`Object.keys(Compute)` exactly `['alerts','available','utilization']`), the `schedule:hydrated` → `Alerts.scheduleRecompute` seam test, the `Utilization.computeMatrix` memoization test, and — most behavior-sensitive — the three `Engine` tests (`'spt'` ascending-run-hours ordering, `autoReflow` pushing an overlapping peer forward, and the DOM-read regression guard counting `document.getElementById` calls). If any `Engine` test fails, that is a real behavior regression from a type-only pass — do not "fix" it by loosening a test's assertion; find and correct whatever the typing pass actually changed.
- [ ] `npm run lint` — confirm no new errors on `web/schedule-services.mts`.

### Step 9: Update the roadmap doc and CLAUDE.md

- [ ] `docs/typescript_migration.md`: flip Phase 3's Status to `Done`; add a dated note next to it recording the Engine-looseness decision and that a follow-up phase should (a) capture a regression baseline of Engine's exact current scheduling output across representative scenarios, then (b) tighten its types to match the rest of the codebase's rigor.
- [ ] `CLAUDE.md`: extend the TypeScript-migration sentence to mention `web/schedule-services.mts`.

### Step 10: Commit

```bash
git add web/schedule-services.mts .gitignore docs/typescript_migration.md CLAUDE.md
git commit -m "typescript migration phase 3: convert schedule-services.mjs to .mts (Engine typed loosely, by design)"
```

---

## Self-Review Notes

- **Spec coverage:** all five exports (`Calendar`, `Compute`, `Alerts`, `Utilization`, `Engine`) are addressed; the two-tier rigor (full for four, loose for one) is a user-approved deviation from this migration's usual "full rigor everywhere" pattern, documented prominently rather than buried.
- **Known open risk, explicitly deferred, not silently dropped:** Engine's sort-term/dispatch internals remain loosely typed on purpose. This is tracked as a named follow-up in `docs/typescript_migration.md`, not treated as "done" — a future phase needs a regression-baseline step before tightening it further.
- **Type consistency:** `UtilizationRowResolved`/`UtilizationMatrixResolved` are deliberately kept separate from the ambient `NimbusUtilizationRow`/`NimbusUtilizationMatrix` (ids-not-yet-resolved) — this is the T-8 trap from `docs/typescript_migration.md`, called out twice (Global Constraints and Step 6) so it isn't missed.
