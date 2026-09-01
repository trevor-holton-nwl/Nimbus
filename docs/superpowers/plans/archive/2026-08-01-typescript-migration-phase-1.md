# TypeScript Migration — Phase 1 (Foundation + `types.mts`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `web/application-foundation.mjs` (Config, Util, VirtualList, PerfMonitor, ErrorLog, Toast, Modal) to real, `tsc`-checked TypeScript (`web/application-foundation.mts`), and create `web/types.mts`, the shared domain-typedef module every later migration phase will import from — completing Phase 1 of `docs/typescript_migration.md`'s roadmap exactly as scoped in its phase table.

**Architecture:** Two new/changed files, zero behavior change. `web/types.mts` is a brand-new, dependency-free module of pure type/interface declarations (no runtime code) transcribed from `docs/typescript_migration.md` §C/§D. `web/application-foundation.mts` is a rename-in-place of the existing `.mjs` (same exports, same logic) with full type annotations added, importing `NimbusTask` from the new types module. Both compile via the existing `tsc -p tsconfig.json` step (already wired to `web/**/*.mts`); nothing about `app-entry.mjs`'s `import * as foundation from './application-foundation.mjs'` or any of the six other files that `import { Config, Util, ... } from './application-foundation.mjs'` needs to change, because the compiled output lands at the exact same path with the exact same named exports.

**Tech Stack:** `tsc` (typescript ^5.6, already a devDependency), Node's built-in test runner (`node --test`, already wired via `npm test`), no new dependencies.

## Global Constraints

- **File extension: `.mts` only, never plain `.ts`.** Per `docs/typescript_migration.md`'s resolved decision #4 ("standardize on `.mts`; new plain `.ts` forbidden — closes the T-13 lint gap"). `nimbus-worker.ts` remains the one intentional exception (a classic script); nothing in this plan touches it.
- **⚠️ Naming deviation from the roadmap doc — flagged for explicit sign-off:** `docs/typescript_migration.md`'s phase table literally reads "create `web/types.ts`". This plan creates **`web/types.mts`** instead. Rationale: (a) `tsconfig.json`'s `include` only globs `web/**/*.mts` plus two specific `.d.ts` paths — a bare `web/types.ts` would silently fall outside every build/typecheck/lint config with zero warning; (b) the SAME document's resolved decision #4 (dated the same day as the phase table) explicitly forbids new plain `.ts` files. `.mts` is the only spelling consistent with the document's own later, more specific ruling. **If you disagree with this call, stop before Task 1 and raise it** — it is a one-line, low-risk change to make now and a much messier one after five more phases depend on the name.
- **Zero behavior change.** This phase is a type-annotation pass, not a refactor. Every exported function/class/object keeps its exact current runtime logic. The only permitted categories of non-type-syntax edit are: (a) non-null assertions (`!`) on DOM lookups the existing code already implicitly assumes are present (e.g. fixed modal elements defined in `index.html`) — behavior on a missing element stays "throws", exactly as today; (b) explicit `String(x)`/similar coercions where TS's strict DOM typings reject a value JS was already silently coercing (e.g. assigning a `number` to `Element.textContent`); (c) `as`/`as unknown as T` type assertions, which erase to nothing at runtime. Do not add new defensive `if`/guard logic that wasn't there before.
- **Preserve every existing comment verbatim** — most importantly the sentinel comment containing the literal text `onchange="..."`, currently at `web/application-foundation.mjs:489` (inside `matchPasteToCheckboxes`'s doc comment). `tests/modules/legacy-surface.test.mjs` deep-compares a scan of this file against `tests/contracts/cq1-legacy-surface.json`, which has a hard-coded entry `{"file": "application-foundation.mjs", "attribute": "onchange", "expression": "..."}` sourced from that exact string. Losing or rewording it fails that test. `tsc` preserves comments verbatim by default (`removeComments` is not set in `tsconfig.json`), so a straight rename-and-annotate should carry it through unchanged — just don't touch that comment's wording while editing the adjacent code.
- **Always verify with `npm test`, never the `test:modules`/`test:legacy` sub-scripts directly.** Only `npm test` has the `pretest` → `npm run build` hook; running a sub-script straight after editing a `.mts` file exercises stale compiled output (`docs/typescript_migration.md` trap T-9).
- **Do not edit `tsconfig.json`, `tsconfig.worker.json`, `eslint.config.js`, or `web/nimbus-compute-core.d.ts`.** All four already correctly cover new `.mts` files under `web/` — verify this as you go (each task says exactly what to check), but no edits to any of them are part of this plan.
- **⚠️ Naming collision, by design — do not "fix" it:** `web/nimbus-compute-core.d.ts` already declares **global ambient** interfaces (via `declare global`) named `NimbusTask`, `NimbusBlock`, `NimbusPlantBlock`, `NimbusLineSetting`, `NimbusMasterData` — deliberately minimal subsets scoped to the worker/compute-core payload shapes (see that file's own header comment and `docs/typescript_migration.md` §E, trap T-5). `web/types.mts` (Task 1) exports **module-scoped** types with the *same names* — the full domain supersets from §C/§D. These do not conflict at compile time (different scopes: one is global-ambient, the other requires an explicit import), but any `.mts` file that needs the full shape **must** write `import type { NimbusTask, ... } from './types.mjs';` — referencing the bare identifier `NimbusTask` without that import silently resolves to the older 6-field ambient subset instead. `docs/typescript_migration.md` itself says keeping the two in sync is a permanent manual process, not a one-time fix — this plan does not touch `nimbus-compute-core.d.ts`.
- **Import specifiers reference the compiled `.mjs` extension**, never `.mts`/`.js` — e.g. `import type { NimbusTask } from './types.mjs';` — matching the existing convention already used by every intra-DAG `.mjs` import in this codebase (`docs/typescript_migration.md`'s per-module ritual step 4).
- **`strict: true`** (already set in `tsconfig.json`) — every annotation must satisfy strict null checks and `noImplicitAny`. Where this plan's signatures don't cover a strict-mode error `npm run typecheck` surfaces, fix it using the *same* toolkit already modeled in Task 2 (non-null assertions for assumed-present DOM lookups, explicit interface typing for objects that grow properties after construction, `String()`/`as`-coercions for genuine mismatches) — never by loosening `strict` or by changing runtime behavior.

---

## Task 1: Create `web/types.mts` (shared domain typedefs)

**Files:**
- Create: `web/types.mts`
- Modify: `.gitignore` (add the compiled `web/types.mjs` to the existing TypeScript-output section)

**Interfaces:**
- Consumes: nothing (zero imports; leaf module, same as `application-foundation`).
- Produces (all named exports other `.mts` files will import from `./types.mjs` in later phases and in Task 2 of this plan): `NimbusTask`, `NimbusBlock`, `NimbusPlantBlock`, `WorkHours`, `NimbusLineSetting`, `NimbusMasterLine`, `ConstraintConfig`, `NimbusMasterPlant`, `NimbusMasterData`, `OptimizerMode`, `AlertType`, `AlertSev`, `UtilSevBucket`, `BufferUnit`, `TopLevelTab`, `GanttSubTab`, `MasterSubTab`, `LaborSubTab`, `StoreMode`, `ConstraintKey`, `StoreEventType`, `SelectionEmitKind`, `WorkerRequestType`, `WorkerResponseType`.

- [ ] **Step 1: Write `web/types.mts`**

Create the file with exactly this content:

```ts
/*
 * web/types.mts — shared domain typedefs for the TypeScript migration.
 *
 * Source material: docs/typescript_migration.md §C (domain data shapes) and
 * §D (string-literal enum inventory), a full read of the frontend done once
 * up front so later phases read findings here instead of re-deriving them.
 * This file has zero runtime code — every export is a `type`/`interface` and
 * erases completely on compile; the emitted web/types.mjs is an empty module.
 *
 * ⚠️ NAMING COLLISION, BY DESIGN: web/nimbus-compute-core.d.ts already
 * declares GLOBAL AMBIENT interfaces (via `declare global`) named NimbusTask,
 * NimbusBlock, NimbusPlantBlock, NimbusLineSetting, NimbusMasterData —
 * deliberately minimal subsets scoped to the worker/compute-core payload
 * shapes. This file's exports of the SAME names are the full domain
 * supersets and are MODULE-SCOPED, not ambient. A file that references the
 * bare identifier `NimbusTask` without `import type { NimbusTask } from
 * './types.mjs'` silently gets the older 6-field ambient subset instead of
 * this one. Always import explicitly. Do not merge/rename either side to
 * "fix" this — see docs/typescript_migration.md trap T-5.
 */

// ---------------------------------------------------------------------------
// §C — Domain data shapes
// ---------------------------------------------------------------------------

/**
 * A scheduled production order. There is no single task constructor —
 * Persistence._prepTask (schedule-data.mjs) and Store._normalizeDates
 * (schedule-state.mjs) are the two authorities that coerce/default these
 * fields from the raw /tasks response. Open SAP bag: real rows carry
 * additional columns beyond this list (e.g. "ORDER_QUANTITY_(GMEIN)"),
 * hence the index signature.
 */
export interface NimbusTask {
  id: string;
  text?: string;
  PRODUCTION_LINE: string;
  PLANT?: string;
  /** Distinct lowercase field used by Selection.selectedRefs; likely a legacy alias of PLANT. */
  plant: string | null;
  RUN_TIME: number | string;
  start_date: Date | null;
  end_date: Date | null;
  original_start_date: Date | null;
  /** SAP due date (Util.sapDueDate reads this). */
  original_end_date: Date | null;
  BASIC_START_DATE: Date | null;
  BASIC_FINISH_DATE: Date | null;
  fixed: boolean;
  /** SAP firmed→fixed mapping is currently commented out/disabled. */
  firmed?: boolean;
  /** Opaque Postgres xmin; sent back to the server as `base_version`. */
  row_version: number | null;
  COLOR?: string;
  FORM_SIZE?: string;
  MATERIAL_NUMBER?: string;
  MATERIAL_DESCRIPTION?: string;
  PRODUCTION_ORDER?: string;
  /** Legacy alt of PRODUCTION_ORDER (brain.py aliases PRODUCTION_ORDER -> ORDER in /tasks). */
  ORDER?: string;
  ORDER_Y?: number;
  notes?: string;
  user_scheduled?: boolean;
  /** Open SAP bag — real rows carry additional raw columns not modeled above. */
  [key: string]: unknown;
}

export interface NimbusBlock {
  id: string;
  /** null = all lines in the plant. */
  line: string | null;
  /** null = legacy global block. */
  plant: string | null;
  /** Re-parsed via Util.parseDate on every read — NOT guaranteed a Date, unlike task dates. */
  start: Date | string;
  end: Date | string;
  reason: string;
}

export interface NimbusPlantBlock {
  id: string;
  plant: string | null;
  start: Date | string;
  end: Date | string;
  reason: string;
}

/** Day-of-week (0=Sun..6=Sat) -> [startHour, endHour] fractional-hour tuple, or null if closed. */
export type WorkHours = Record<number, [number, number] | null>;

export interface NimbusLineSetting {
  plant: string | null;
  /** Wire/DB alias: buffer_type ('%'|'hrs'). */
  bufferUnit: 'pct' | 'hours';
  bufferPct: number;
  bufferHours: number;
  bottleneck: boolean;
  /** Wire/DB alias: excl_optimizer. */
  excludeFromOpt: boolean;
  plGroup: string;
}

export interface NimbusMasterLine {
  production_line: string;
  plant: string;
  pl_group?: string;
}

export interface ConstraintConfig {
  key: string;
  enabled: boolean;
  order?: number;
}

/** Keyed by composite (subnetwork, plant), not plant alone. */
export interface NimbusMasterPlant {
  subnetwork: string;
  plant: string;
  constraints?: ConstraintConfig[];
}

export interface NimbusMasterData {
  plants: NimbusMasterPlant[];
  lines: NimbusMasterLine[];
}

// ---------------------------------------------------------------------------
// §D — String-literal enum inventory
// ---------------------------------------------------------------------------

export type OptimizerMode = 'spt' | 'changeover' | 'combined';

export type AlertType =
  | 'overlap' | 'overload' | 'near-capacity' | 'closed'
  | 'blackout' | 'fixed-closed' | 'fixed-out-of-hours';

export type AlertSev = 'err' | 'warn';

/** NOT the same set as AlertSev — 'ok' is a valid utilization bucket but never a valid alert sev. */
export type UtilSevBucket = 'err' | 'warn' | 'ok';

export type BufferUnit = 'pct' | 'hours';

export type TopLevelTab = 'home' | 'gantt' | 'masterdata' | 'labor' | 'admin';

export type GanttSubTab = 'timeline' | 'orders';

export type MasterSubTab = 'lines' | 'plant';

export type LaborSubTab = 'aggregate' | 'line-plan' | 'capacity' | 'exceptions' | 'inputs';

export type StoreMode = 'live' | 'draft';

/** Only 'colorWheel' is wired today; 'tooling' is reserved/commented in Engine.CONSTRAINT_CATALOG. */
export type ConstraintKey = 'colorWheel';

export type StoreEventType =
  | 'tasks:bulk' | 'task:update' | 'task:remove' | 'tasks:bulkUpdate'
  | 'fixed:change' | 'calendar:change' | 'blocks:change' | 'plantBlocks:change'
  | 'lineSettings:change' | 'plant:selected' | 'alerts:change' | 'settings:change'
  | 'master-data-changed' | 'undo:pushed' | 'sandbox:entered' | 'sandbox:exited'
  | 'sandbox:reverted' | 'schedule:hydrated' | 'session:changed'
  /** Wholesale *:replace variants, e.g. 'tasks:replace'. */
  | `${string}:replace`;

export type SelectionEmitKind = 'clear' | 'set' | 'add' | 'remove' | 'toggle';

export type WorkerRequestType = 'ALERTS' | 'UTILIZATION';

export type WorkerResponseType = 'ALERTS' | 'UTILIZATION' | 'ERROR';
```

- [ ] **Step 2: Add the compiled output to `.gitignore`**

`web/types.mts` is a brand-new file (not a rename of a tracked `.mjs`), so there's nothing to `git rm --cached` — but its compiled `web/types.mjs` output must never be committed. Edit `.gitignore`'s existing TypeScript section (currently just `web/nimbus-worker.js`) to also list it:

```
# TypeScript compiled output — compiled in place next to its .ts/.mts source
# (see docs/typescript_migration.md). Listed by specific filename, not a blanket
# *.js/*.mjs glob, so hand-written fixtures like web/_static-delivery-check.mjs
# are never accidentally ignored.
web/nimbus-worker.js
web/types.mjs
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck`
Expected: exits 0, no errors (this file has zero runtime logic — if it fails, the most likely cause is a typo in a union/interface).

Run: `npm run build`
Expected: exits 0; `web/types.mjs` now exists on disk (an emitted, near-empty module — safe, it's gitignored per Step 2).

- [ ] **Step 4: Confirm tooling coverage (no edits — verification only)**

- `tsconfig.json`'s `include` already globs `web/**/*.mts` — confirm `web/types.mts` was picked up by Step 3's typecheck (it will show up in `tsc`'s error output location if there were any errors; a clean run with no complaints about the file being unresolved confirms coverage).
- `eslint.config.js` already has a `files: ['web/**/*.mts']` block — run `npm run lint` and confirm no "file not linted" gap and no new errors from `web/types.mts`.

- [ ] **Step 5: Commit**

```bash
git add web/types.mts .gitignore
git commit -m "typescript migration phase 1: add web/types.mts domain typedefs"
```

---

## Task 2: Convert `web/application-foundation.mjs` → `.mts`

**Depends on:** Task 1 (imports `NimbusTask` from `web/types.mjs`).

**Files:**
- Rename: `web/application-foundation.mjs` → `web/application-foundation.mts` (via `git mv`, preserving history)
- Modify: `.gitignore` (add `web/application-foundation.mjs`)
- Modify: `docs/typescript_migration.md` (Phase 1 row: Future → Done)
- Modify: `CLAUDE.md` (TypeScript-migration mention: add this file alongside `nimbus-worker.ts`)

**Interfaces:**
- Consumes: `NimbusTask` from `./types.mjs` (Task 1).
- Produces: identical public surface to today — `Config`, `Util`, `VirtualList`, `PerfMonitor`, `ErrorLog`, `Toast`, `Modal`, unchanged in shape and behavior. Six files (`web/schedule-state.mjs`, `web/schedule-services.mjs`, `web/schedule-data.mjs`, `web/schedule-workbench.mjs`, `web/plant-and-administration.mjs`, `web/application-shell.mjs`) `import { ... } from './application-foundation.mjs'` by name, and `web/app-entry.mjs` does `import * as foundation from './application-foundation.mjs'` then bridges it to `window.__NIMBUS_FOUNDATION` for `app.js`'s classic-script destructure. **None of these seven call sites change** — the compiled `.mjs` lands at the same path with the same exports.

**Model guidance:** this task requires real TypeScript judgment (strict-mode null handling, a generic debounce/clone, an object that grows properties after construction) — dispatch it on a standard/capable model, not the cheapest tier.

### Step 1: Rename, preserving git history

- [ ] Run: `git mv web/application-foundation.mjs web/application-foundation.mts`

### Step 2: Add the header, global augmentation, and local type declarations

- [ ] Immediately after the file's existing top-of-file doc comment (the `// application-foundation.mjs — CQ-1 foundation module. ...` block — keep it verbatim, just update its own first line's filename reference from `.mjs` to `.mts`), insert:

```ts
import type { NimbusTask } from './types.mjs';

// Ambient augmentation: these three custom globals are read via
// `window.NIMBUS_API_BASE`/`window.NIMBUS_BUILD_ID`/`window.__NIMBUS_LOCALES`
// below and nowhere else in the codebase declares them yet.
declare global {
  interface Window {
    NIMBUS_API_BASE?: string;
    NIMBUS_BUILD_ID?: string;
    __NIMBUS_LOCALES?: Record<string, Record<string, string>>;
  }
}

// -- Local type declarations (Phase 1 conversion; scoped to this file) ------
type PreferenceResolver = (key: string) => string | undefined;
type ActorResolver = () => string | undefined;

// The full per-line/day utilization matrix type is Phase 3's domain
// (schedule-services.mts, not yet converted). This resolver only ever reads
// `.pct` off a matrix cell (see Util.scheduleKpis below), so it's typed to
// exactly that shape rather than importing a type that doesn't exist yet.
type UtilizationResolverFn = (
  date: Date, days: number, tasks: NimbusTask[]
) => Record<string, Record<string, { pct?: number } | undefined>>;

interface VirtualListOptions<T> {
  rowH?: number;
  getRowH?: (item: T) => number;
  renderFn: (item: T, index: number) => string;
  mountEl?: HTMLElement;
  buffer?: number;
}

interface PerfBucket {
  buf: Float32Array;
  head: number;
  count: number;
  last: number;
  lastTs: number;
}

interface PerfStats {
  last: number;
  lastTs: number;
  count: number;
  p50: number;
  p95: number;
  max: number;
}

type LogLevel = 'info' | 'warn' | 'error';

interface LogOpts {
  reqId?: string;
  errorCode?: string;
  stack?: string;
}

interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  ctx: unknown;
  reqId?: string;
  errorCode?: string;
  stack?: string;
  buildId: string;
  sessionId: string;
  plant?: string;
  route?: string;
}

interface Breadcrumb {
  t: number;
  type: string;
  d?: unknown;
}

interface RecentEntry {
  ts: number;
  level: LogLevel;
}

interface ToastEntry {
  el: HTMLDivElement;
  msg: string;
  type: string;
  timerId: ReturnType<typeof setTimeout> | null;
  _removing: boolean;
}

interface ModalConfirmOpts {
  title?: string;
  message?: string;
  detail?: string;
  confirmLabel?: string;
  tone?: 'danger' | 'warn';
}

type PasteWiredInput = HTMLInputElement & { _pasteWired?: boolean };
```

### Step 3: Config — verify only, no code change

- [ ] Confirm `Config`'s object literal needs no edits: `window.NIMBUS_API_BASE`/`window.NIMBUS_BUILD_ID` (lines referencing them in `API_BASE`/`BUILD_ID`) now type-check against the `Window` augmentation added in Step 2. Everything else in `Config` is a plain literal (numbers/strings/arrays/booleans) that `tsc` infers with no annotation needed.

### Step 4: Annotate `Util`

- [ ] Change each method's signature line to the annotated version below. **Do not touch the method bodies** except for the three call-outs at the end of this list (`debounce`, `clone`, `t`) — those need small, behavior-preserving body edits to satisfy strict mode, shown in full.

| Method | New signature |
|---|---|
| `setPreferenceResolver` | `setPreferenceResolver(fn: PreferenceResolver): void {` |
| `setActorResolver` | `setActorResolver(fn: ActorResolver): void {` |
| `setUtilizationResolver` | `setUtilizationResolver(fn: UtilizationResolverFn \| null): void {` |
| `locale` | `locale(): string {` |
| `setLocale` | `setLocale(lang: string): void {` |
| `parseDate` | `parseDate(v: unknown): Date \| null {` |
| `snap` | `snap(date: Date \| number \| string): Date {` |
| `dayKey` | `dayKey(d: unknown): string {` |
| `fmtDT` | `fmtDT(d: unknown): string {` |
| `_timeFormatPref` | `_timeFormatPref(): string {` |
| `_dateFormatPref` | `_dateFormatPref(): string {` |
| `_fmtTimePref` | `_fmtTimePref(date: Date): string {` |
| `_fmtDatePref` | `_fmtDatePref(date: Date): string {` |
| `fmtDTReadable` | `fmtDTReadable(d: unknown): string {` |
| `fmtBlockRange` | `fmtBlockRange(s: unknown, e: unknown): string {` |
| `mergedOverlapHours` | `mergedOverlapHours(win: [Date \| number, Date \| number] \| null, intervals: Array<{ s: Date \| number; e: Date \| number }>): number {` |
| `fmtHours` | `fmtHours(hours: number \| null \| undefined): string {` |
| `toLocalInput` | `toLocalInput(d: unknown): string {` |
| `toLocalSeconds` | `toLocalSeconds(d: unknown): string {` |
| `_fpAltFormat` | `_fpAltFormat(): string {` |
| `fpDatetime` | `fpDatetime(sel: string \| HTMLElement, extra: Record<string, unknown> = {}) {` (leave return type uninferred — it's flatpickr's ambient `FlatpickrInstance`, whose type name isn't reachable outside `web/types/vendor.d.ts`; `tsc` infers it fine without naming it) |
| `clamp` | `clamp(d: Date, min: Date \| null \| undefined, max: Date \| null \| undefined): Date {` |
| `norm` | `norm(s: unknown): string {` |
| `runHours` | `runHours(task: NimbusTask): number {` |
| `startOfDay` | `startOfDay(d: unknown): Date \| null {` |
| `addMin` | `addMin(d: Date, min: number): Date {` |
| `uid` | `uid(prefix?: string): string {` |
| `fetchTraced` | `fetchTraced(input: RequestInfo, init: RequestInit = {}): Promise<Response> {` |
| `parseBackendError` | `parseBackendError(resp: Response \| null \| undefined): Promise<{ message: string; errorCode: string; status: number }> {` |
| `sapDueDate` | `sapDueDate(t: NimbusTask): Date \| null {` |
| `scheduledEnd` | `scheduledEnd(t: NimbusTask): Date \| null {` |
| `impliedOriginalStart` | `impliedOriginalStart(t: NimbusTask): Date \| null {` |
| `latenessHours` | `latenessHours(t: NimbusTask): number {` |
| `countChangeovers` | `countChangeovers(tasks: NimbusTask[]): number {` |
| `scheduleKpis` | `scheduleKpis(tasks: NimbusTask[], horizonDays: number = 14): { changeovers: number; span_h: number; late_count: number; late_h: number; peak_util_pct: number } {` |
| `reqEl` | `reqEl(id: string): HTMLElement {` |
| `_stripExcelFloatSuffix` | `_stripExcelFloatSuffix(s: string): string {` |
| `parsePasteList` | `parsePasteList(text: string \| null \| undefined): string[] {` |
| `matchPasteToCheckboxes` | `matchPasteToCheckboxes(text: string, checkboxEls: HTMLInputElement[]): { matched: number; total: number } {` |
| `wirePasteToCheckboxes` | `wirePasteToCheckboxes(inputEl: PasteWiredInput, getCheckboxEls: () => HTMLInputElement[]): void {` |
| `taskMatchesPasteSet` | `taskMatchesPasteSet(task: NimbusTask, idSet: Set<string> \| null \| undefined): boolean {` |
| `countPasteMatches` | `countPasteMatches(text: string, knownIdSet: Set<string>): { matched: number; total: number } {` |
| `hoursToTimeString` | `hoursToTimeString(h: number): string {` |
| `timeStringToHours` | `timeStringToHours(t: string): number {` |

- [ ] Also change the three `let`/`const` module-scope variables above `Util` to:

```ts
let _prefResolver: PreferenceResolver = () => undefined;
let _actorResolver: ActorResolver = () => undefined;
let _utilizationResolver: UtilizationResolverFn | null = null;
let _locale: string = (typeof localStorage !== 'undefined' && localStorage.getItem('nimbus.locale')) || 'en';
```

- [ ] **`debounce`** — full replacement (generic over the wrapped function's argument tuple):

```ts
  debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): (...args: A) => void {
    let t: ReturnType<typeof setTimeout>;
    return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
  },
```

- [ ] **`clone`** — full replacement (generic in, same type out; internal assertions only, same runtime logic):

```ts
  clone<T>(obj: T): T {
    if (obj == null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj) as unknown as T;
    if (Array.isArray(obj)) return obj.map(Util.clone) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj as Record<string, unknown>)) out[k] = Util.clone((obj as Record<string, unknown>)[k]);
    return out as unknown as T;
  },
```

- [ ] **`t`** — signature `t(key: string, vars?: Record<string, string | number>): string {`, and change its one interior line from:
  `if (vars) str = str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');`
  to:
  `if (vars) str = str.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));`
  (`String.replace`'s callback must return `string`; JS was already coercing a numeric substitution to a string at this call site implicitly — this makes that coercion explicit, byte-identical result.)

### Step 5: Annotate `VirtualList`

- [ ] Replace the whole class with this fully-typed version (bodies unchanged from current source, just field declarations and signatures added — verify against the class you renamed in Step 1 that no method body differs from what's below):

```ts
export class VirtualList<T = unknown> {
  _scroll: HTMLElement;
  _mount: HTMLElement;
  _fixedH: number | null;
  _getRowH: ((item: T) => number) | null;
  _renderFn: (item: T, index: number) => string;
  _buf: number;
  _items: T[];
  _offsets: Float64Array | null;
  _inner: HTMLDivElement;
  _onScroll: () => void;

  constructor(scrollEl: HTMLElement, { rowH, getRowH, renderFn, mountEl, buffer = 5 }: VirtualListOptions<T>) {
    this._scroll   = scrollEl;
    this._mount    = mountEl || scrollEl;
    this._fixedH   = typeof rowH === 'number' ? rowH : null;
    this._getRowH  = getRowH || null;
    this._renderFn = renderFn;
    this._buf      = buffer;
    this._items    = [];
    this._offsets  = null;
    this._inner    = document.createElement('div');
    this._mount.appendChild(this._inner);
    this._onScroll = () => this._paint();
    scrollEl.addEventListener('scroll', this._onScroll, { passive: true });
  }

  update(items: T[]): void {
    this._items = items;
    if (this._getRowH) {
      const n = items.length;
      this._offsets = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) {
        this._offsets[i + 1] = this._offsets[i] + this._getRowH(items[i]);
      }
    }
    this._paint();
  }

  _totalH(): number {
    if (this._fixedH !== null) return this._items.length * this._fixedH;
    return this._offsets ? this._offsets[this._items.length] : 0;
  }

  _offsetOf(i: number): number {
    if (this._fixedH !== null) return i * this._fixedH;
    return this._offsets ? this._offsets[i] : 0;
  }

  _paint(): void {
    const n = this._items.length;
    if (!n) {
      this._inner.style.paddingTop = '0';
      this._inner.style.paddingBottom = '0';
      this._inner.innerHTML = '';
      return;
    }
    const scrollTop = this._scroll.scrollTop;
    const viewH     = this._scroll.clientHeight || 600;
    const buf       = this._buf;
    let lo: number, hi: number;

    if (this._fixedH !== null) {
      lo = Math.max(0, Math.floor(scrollTop / this._fixedH) - buf);
      hi = Math.min(n, Math.ceil((scrollTop + viewH) / this._fixedH) + buf);
    } else {
      // Binary search for first item whose bottom edge is below scrollTop.
      // Non-null assertions below: this branch is only reachable when
      // _fixedH === null, which only happens when the caller passed
      // getRowH — and update() always populates _offsets before _paint()
      // can see a non-empty _items in that configuration (see the n === 0
      // early return above).
      let l = 0, r = n - 1;
      while (l < r) {
        const m = (l + r) >> 1;
        if (this._offsets![m + 1] <= scrollTop) l = m + 1; else r = m;
      }
      lo = Math.max(0, l - buf);
      let e = lo;
      while (e < n && this._offsets![e] < scrollTop + viewH) e++;
      hi = Math.min(n, e + buf);
    }

    this._inner.style.paddingTop    = this._offsetOf(lo) + 'px';
    this._inner.style.paddingBottom = (this._totalH() - this._offsetOf(hi)) + 'px';

    let html = '';
    for (let i = lo; i < hi; i++) html += this._renderFn(this._items[i], i);
    this._inner.innerHTML = html;
  }

  destroy(): void {
    this._scroll.removeEventListener('scroll', this._onScroll);
    this._inner.remove();
    this._items = [];
  }
}
```

### Step 6: Annotate `PerfMonitor`

- [ ] Change the internal state declarations and every function signature inside the IIFE:

```ts
export const PerfMonitor = (() => {
  const _MAX = 100;
  const _buckets = new Map<string, PerfBucket>();
  const _listeners = new Set<() => void>();
  let _notifyTimer: ReturnType<typeof setTimeout> | null = null;

  function record(name: string, ms: number): void {
    // ... body unchanged ...
  }

  function time<T>(name: string, fn: () => T): T {
    // ... body unchanged ...
  }

  function stats(name: string): PerfStats | null {
    // ... body unchanged ...
  }

  function all(): Array<{ name: string } & PerfStats> {
    return [..._buckets.keys()].map(k => ({ name: k, ...(stats(k) as PerfStats) }));
  }

  function clear(): void { _buckets.clear(); _notify(); }
  function subscribe(fn: () => void): void { _listeners.add(fn); }

  function _notify(): void {
    // ... body unchanged ...
  }

  return { record, time, stats, all, clear, subscribe };
})();
```

(`all()`'s body does change — the spread now reads `...(stats(k) as PerfStats)` instead of `...stats(k)`, asserting what's operationally always true: `k` came from `_buckets.keys()`, so `stats(k)` can never actually be `null` here, even though `stats`'s own return type allows it for the "unknown name" case.)

### Step 7: Annotate `ErrorLog`

- [ ] Change the field declarations at the top of the object literal:

```ts
export const ErrorLog = {
  MAX: 500,
  _entries: [] as LogEntry[],
  _listeners: new Set<(e: LogEntry | { cleared: true }) => void>(),
  _recent: [] as RecentEntry[],
  _globalsInstalled: false,
  _droppedCount: 0,
  _breadcrumbs: [] as Breadcrumb[],
  BREADCRUMB_MAX: 15,
  SESSION_ID: (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
```

- [ ] Change these method signatures (bodies unchanged):

| Method | New signature |
|---|---|
| `setPlantResolver` | `setPlantResolver(fn: () => string \| null): void {` |
| `setRouteResolver` | `setRouteResolver(fn: () => { tab: string; ganttSub?: string } \| null): void {` |
| `setAdminGate` | `setAdminGate(fn: () => boolean): void {` |
| `setBadgeClickHandler` | `setBadgeClickHandler(fn: () => void): void {` |
| `_buildId` | `_buildId(): string {` |
| `_plant` | `_plant(): string \| null {` |
| `_route` | `_route(): string \| null {` |
| `breadcrumb` | `breadcrumb(type: string, data?: unknown): void {` |
| `info` | `info(scope: string, msg: string, ctx?: unknown, opts?: LogOpts): void {` |
| `warn` | `warn(scope: string, msg: string, ctx?: unknown, opts?: LogOpts): void {` |
| `error` | `error(scope: string, msg: string, ctx?: unknown, opts?: LogOpts): void {` |
| `_pushRecent` | `_pushRecent(level: LogLevel): void {` |
| `errorRatePerMin` | `errorRatePerMin(): number {` |
| `warnRatePerMin` | `warnRatePerMin(): number {` |
| `installGlobalHandlers` | `installGlobalHandlers(): void {` (leave the two `window.addEventListener('error', e => ...)` / `('unhandledrejection', e => ...)` callback parameters unannotated — TS infers `e: ErrorEvent` / `e: PromiseRejectionEvent` automatically from the string literal event name) |
| `entries` | `entries(): LogEntry[] {` |
| `countBy` | `countBy(level: LogLevel): number {` |
| `droppedCount` | `droppedCount(): number {` |
| `clear` | `clear(): void {` |
| `subscribe` | `subscribe(fn: (e: LogEntry \| { cleared: true }) => void): () => void {` |
| `_openDb` | `_openDb(): Promise<IDBDatabase \| null> {` |
| `_saveNow` | `_saveNow(): void {` |
| `restore` | `restore(): Promise<void> {` |
| `_scheduleShip` | `_scheduleShip(e: LogEntry): void {` |
| `_enqueueShip` | `_enqueueShip(e: LogEntry): void {` |
| `_shipNow` | `_shipNow(): void {` |
| `_safeCtx` | `_safeCtx(v: unknown): unknown {` |
| `copy` | `copy(): void {` |

- [ ] **`_dbPromise` field** — change to: `_dbPromise: null as Promise<IDBDatabase | null> | null,`

- [ ] **`_shipQueue` field** — change to: `_shipQueue: [] as LogEntry[],` (the object it pushes has exactly `LogEntry`'s shape — no separate type needed)

- [ ] **`_shipSeen` field** — change to: `_shipSeen: new Set<string>(),`

- [ ] **`_openDb`'s body** — the two `new Promise(...)` calls inside need an explicit type argument. Change:
  `ErrorLog._dbPromise = new Promise((resolve, reject) => {`
  to:
  `ErrorLog._dbPromise = new Promise<IDBDatabase | null>((resolve, reject) => {`
  (rest of the body unchanged).

- [ ] **`restore`'s body** — same fix, one line:
  `return new Promise(resolve => {`
  to:
  `return new Promise<void>(resolve => {`
  (rest of the body unchanged).

- [ ] **`_push`** — this is the one method needing a real (behavior-preserving) restructure, because `e` is built with 5 properties and then has more properties (`reqId`, `errorCode`, `stack`, `buildId`, `sessionId`, `plant`, `route`) assigned onto it afterward — TS needs to know upfront that those assignments are legal. Replace the whole method with:

```ts
  _push(level: LogLevel, scope: string, msg: string, ctx: unknown, opts?: LogOpts): void {
    // opts (all optional): { reqId, errorCode, stack } — explicit structured fields.
    const e: Partial<LogEntry> & Pick<LogEntry, 'ts' | 'level' | 'scope' | 'msg' | 'ctx'> = {
      ts: new Date().toISOString(),
      level, scope, msg,
      ctx: ctx === undefined ? null : ErrorLog._safeCtx(ctx),
    };
    // Additive structured fields. All optional — old readers ignore unknown keys.
    if (opts) {
      if (opts.reqId      != null) e.reqId      = opts.reqId;
      if (opts.errorCode  != null) e.errorCode  = opts.errorCode;
      if (opts.stack      != null) e.stack      = opts.stack;
    }
    // Central enrichment.
    if (level === 'error' && !e.stack) {
      try { e.stack = new Error().stack; } catch {}
    }
    e.buildId   = ErrorLog._buildId();
    e.sessionId = ErrorLog.SESSION_ID;
    const plant = ErrorLog._plant(); if (plant) e.plant = plant;
    const route = ErrorLog._route(); if (route) e.route = route;
    // Attach breadcrumbs to error-level entries for postmortem context.
    if (level === 'error' && ErrorLog._breadcrumbs.length) {
      e.ctx = ErrorLog._safeCtx({ ...(e.ctx && typeof e.ctx === 'object' ? e.ctx : (e.ctx != null ? { _ctx: e.ctx } : {})), breadcrumbs: ErrorLog._breadcrumbs.slice() });
    }

    ErrorLog._entries.push(e as LogEntry);
    if (ErrorLog._entries.length > ErrorLog.MAX) {
      const drop = ErrorLog._entries.length - ErrorLog.MAX;
      ErrorLog._entries.splice(0, drop);
      ErrorLog._droppedCount += drop;
    }
    ErrorLog._pushRecent(level);
    // mirror to console so power users see it
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[fn](`[${scope}]`, msg, ctx ?? '');
    for (const l of ErrorLog._listeners) { try { l(e as LogEntry); } catch {} }
    ErrorLog.renderBadge();
    ErrorLog._scheduleSave();
    if (level === 'error') ErrorLog._scheduleShip(e as LogEntry);
  },
```

(This is the exact original body with one type annotation on `e`'s declaration and three `as LogEntry` assertions at the points where `e` is handed to something typed to expect a complete `LogEntry` — by every one of those points, `buildId`/`sessionId` have already been set a few lines above, so the assertion reflects a runtime-true fact, not a lie to the compiler.)

- [ ] **`renderBadge`** — change the property to `renderBadge: Util.debounce(function (): void {`, and fix two strict-mode issues in the body (both are the "assumed-present DOM lookup" and "DOM string-coercion" categories from Global Constraints):
  1. `const badge = btn.querySelector('#err-log-badge');` → `const badge = btn.querySelector<HTMLElement>('#err-log-badge')!;` (generic narrows from `Element` to `HTMLElement` so `.hidden` type-checks; `!` matches the existing code's implicit assumption that this element is always present).
  2. `badge.textContent = total;` → `badge.textContent = String(total);` (`Element.textContent` is typed `string | null`; `total` is a `number` — JS was already coercing this via the DOM's own stringification, this makes it explicit).

  No other lines in `renderBadge` need to change — `btn`'s reassignment-narrows-to-non-null pattern (`let btn = document.getElementById(...); if (!btn) { ...; btn = document.createElement(...); ...; }`) is already strict-mode-safe as written; `host` similarly resolves to a non-null type because its final `|| document.body` fallback is always non-null.

### Step 8: Annotate `Toast`

- [ ] Change the internal state and signatures:

```ts
export const Toast = (function() {
  const MAX_VISIBLE = 3;
  const _visible: ToastEntry[] = [];

  function _scheduleRemoval(entry: ToastEntry, ms: number): void {
    // ... body unchanged ...
  }

  function _remove(entry: ToastEntry): void {
    // ... body unchanged ...
  }

  function _evictOne(): void {
    // ... body unchanged ...
  }

  return {
    show(msg: string, type: string = 'info', ms: number = 1500): void {
      // ... body unchanged ...
    }
  };
})();
```

### Step 9: Annotate `Modal`

- [ ] Change signatures, and add non-null assertions in `confirm` for the modal DOM elements the existing code already assumes are always present in `index.html` (these five `getElementById` calls have no preceding null-guard, unlike `Modal.open`/`Modal.close`'s own `if (el) ...` pattern, which needs no change):

```ts
export const Modal = {
  open(id: string): void  { const el = document.getElementById(id); if (el) el.hidden = false; },
  close(id: string): void { const el = document.getElementById(id); if (el) el.hidden = true;  },

  // Promise-based confirmation dialog.
  confirm(opts: ModalConfirmOpts = {}): Promise<boolean> {
    return new Promise(resolve => {
      document.getElementById('confirm-title')!.textContent   = opts.title   || 'Confirm';
      document.getElementById('confirm-message')!.textContent = opts.message || '';
      const det = document.getElementById('confirm-detail')!;
      if (opts.detail) { det.innerHTML = opts.detail; det.hidden = false; }
      else             { det.textContent = ''; det.hidden = true; }
      const okBtn = document.getElementById('confirm-ok-btn')!;
      okBtn.textContent  = opts.confirmLabel || 'Confirm';
      okBtn.className    = `btn btn-${opts.tone === 'warn' ? 'warn' : 'danger'}`;
      const closeBtn = document.getElementById('confirm-close-btn')!;
      const done = (ok: boolean): void => { cleanup(); resolve(ok); };
      const cleanup = (): void => {
        okBtn.removeEventListener('click', onOk);
        document.getElementById('confirm-cancel-btn')!.removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        Modal.close('confirm-modal');
      };
      const onOk     = (): void => done(true);
      const onCancel = (): void => done(false);
      okBtn.addEventListener('click', onOk);
      document.getElementById('confirm-cancel-btn')!.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      Modal.open('confirm-modal');
    });
  }
};
```

### Step 10: Add the compiled output to `.gitignore`

- [ ] Edit `.gitignore`'s TypeScript section (touched already in Task 1) to also list this file:

```
web/nimbus-worker.js
web/types.mjs
web/application-foundation.mjs
```

### Step 11: Typecheck and build — iterate to green

- [ ] Run: `npm run typecheck`
Expected: eventually exits 0. This plan's annotations were hand-traced against the current source, but if `tsc` surfaces additional strict-mode errors beyond what's covered above, fix them using the same toolkit already modeled in this task (non-null assertion for an assumed-present DOM lookup; explicit interface field for a property added after construction; `String()`/`as`-coercion for a genuine type mismatch that was previously silently coerced) — never by changing runtime behavior or loosening `strict`.

- [ ] Run: `npm run build`
Expected: exits 0; `web/application-foundation.mjs` is regenerated in place (gitignored per Step 10).

### Step 12: Run the full test suite

- [ ] Run: `npm test`
Expected: all pass, including (at minimum) `tests/modules/foundation.test.mjs` and `tests/modules/legacy-surface.test.mjs`. `npm test`'s `pretest` hook already ran `npm run build` for you — don't run `test:modules` directly (see Global Constraints).

### Step 13: Verify the legacy-surface sentinel comment survived

- [ ] Run: `grep -n 'onchange=' web/application-foundation.mjs` (the **compiled** output, post-build)
Expected: one match, containing the literal text `onchange="..."` — confirms Step 12's `legacy-surface.test.mjs` contract-snapshot assertion is passing for the right reason (comment preserved), not accidentally.

### Step 14: Update the roadmap doc and CLAUDE.md

- [ ] In `docs/typescript_migration.md`'s phase table, change the Phase 1 row's Status from `Future` to `Done`.
- [ ] In `docs/typescript_migration.md`, add a dated note near the Phase 1 row (matching the style of the existing "Docker gotcha fixed 2026-07-28" notes) recording: `web/types.mts` was created as `.mts` (not the phase table's literal "`.ts`") per resolved decision #4 — so a reader hitting the same phase table text later isn't confused by the filename mismatch.
- [ ] In `CLAUDE.md`, find the sentence "a small, growing set of modules is real TypeScript compiled in place by `tsc` (see `docs/typescript_migration.md`) — currently `web/nimbus-worker.ts` → `web/nimbus-worker.js`." and update it to also mention `web/application-foundation.mts` → `web/application-foundation.mjs` and `web/types.mts` (the domain-typedef module), so CLAUDE.md stays accurate for future sessions.

### Step 15: Commit

- [ ] Run:

```bash
git add web/application-foundation.mts .gitignore docs/typescript_migration.md CLAUDE.md
git commit -m "typescript migration phase 1: convert application-foundation.mjs to .mts"
```

(`web/application-foundation.mjs`, the old tracked path, was already removed from the index by Task 2 Step 1's `git mv` — nothing further to stage for its removal.)

---

## Self-Review Notes

- **Spec coverage:** every module named in `docs/typescript_migration.md`'s Phase 1 row (`Config`, `Util`, `VirtualList`, `PerfMonitor`, `ErrorLog`, `Toast`, `Modal`) has a task step; `web/types.mts` covers both §C and §D of the roadmap's codebase migration map.
- **Placeholder scan:** no TBD/"add appropriate"/"similar to Task N" language — every step gives exact code or an exact grep/npm command with expected output.
- **Type consistency:** `NimbusTask` (Task 1) is the exact type name imported and used in Task 2's `Util` signatures; `LogLevel`/`LogEntry`/`LogOpts` are declared once in Task 2 Step 2 and reused verbatim through every `ErrorLog` signature in Step 7 — no renamed variants.
- **Known open risk, called out rather than hidden:** Task 2's per-signature table and the `ErrorLog`/`VirtualList`/`Modal` full-body rewrites were hand-derived from a full read of the current file, not machine-verified against a live `tsc` run before hand-off. Step 11 explicitly budgets for iteration against real compiler output — treat any remaining error there as expected, not a plan failure, and resolve it with the same toolkit this plan already models.
