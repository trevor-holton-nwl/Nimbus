# TypeScript Migration Phase 6 (schedule-workbench.mjs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `web/schedule-workbench.mjs` (7,525 lines — the largest CQ-1 module) to real, fully-typed TypeScript (`web/schedule-workbench.mts`), matching the full-rigor standard already established by Phases 1, 2, and 4 (Phase 3's `Engine` loose-typing exception does not apply here — nothing in this file is comparable to `Engine`'s algorithmic density).

**Architecture:** This file already has 14 top-level exported modules (`Timeline`, `TimelineNav`, `DependencyOverlay`, `Table`, `Inspector`, `ContextMenu`, `Hierarchy`, `GanttFilter`, `Dashboard`, `Interaction`, `OptimizeDialog`, `OptimizerPreview`, `EditCalendar`, `ColorWheelViewer`, `Printer`) plus `SandboxAdapter`/`AlertsUIAdapter`. Its own header comment (lines 1-141) documents the exact module groups the original CQ-1 JS-module-extraction split it into, task-by-task, including every genuine cross-file `NIMBUS.*` reach each group makes. This plan reuses those exact same seams for the TS conversion — they are already proven safe boundaries, and the header comment gives each task a verified list of ambient touchpoints instead of requiring rediscovery.

**Tech Stack:** `tsc` (via the existing `tsconfig.json`), no new tooling. One new file: `web/types/nimbus-global.d.mts` (the ambient `NIMBUS` shim — see Global Constraints).

## Global Constraints

- **Full rigor, no loose-typing exceptions.** Every module in this file gets precise types — no `Engine`-style deliberate `any`/`unknown` carve-out. If an implementer believes a specific closure genuinely cannot be typed precisely without behavior change, that is a judgment call to document in the task report and flag for reviewer/final-review triage, not a silent broad exception.
- **Zero behavior change.** This is a types-only conversion. Do not refactor logic, rename methods, change DOM structure, or "clean up" working code, even where the header comment notes a stale comment or leftover indirection — fix only what a task explicitly calls out below.
- **Per-module conversion ritual** (`docs/typescript_migration.md` "Per-module conversion ritual" section), every task:
  1. First task only: rename `web/schedule-workbench.mjs` → `web/schedule-workbench.mts`. Later tasks edit the same `.mts` file directly (it already exists after Task 1).
  2. First task only: `git rm --cached web/schedule-workbench.mjs` and add the exact filename `web/schedule-workbench.mjs` to `.gitignore` (mirror the existing entries for `schedule-data.mjs` etc. — do not add a blanket `*.mjs` glob, which would swallow hand-written fixtures like `web/_static-delivery-check.mjs`).
  3. Add new domain typedefs to `web/types.mts` (§C/§D) only if a genuinely new shape surfaces; reuse existing types (`NimbusTask`, `NimbusBlock`, `NimbusPlantBlock`, `WorkHours`, `NimbusLineSetting`, `AlertType`, `AlertSev`, `OptimizerMode`, etc. — see `web/types.mts`) rather than redeclaring.
  4. `tsconfig.json`'s `web/**/*.mts` glob picks up the file automatically — no config change needed.
  5. Import specifiers keep the `.mjs` suffix (`from './application-foundation.mjs'`) per `nodenext` — this is already correct in the current file's imports and does not change.
  6. Run `npm run typecheck` and `npm run build`; fix errors until clean.
  7. Run `npm test` (uses `pretest` → build, per T-9 — never run `test:modules`/`test:legacy` directly on a `.mts` edit).
  8. Commit.
- **T-1/T-2 traps apply directly to this file** (`docs/typescript_migration.md` "Common migration mistakes"): never add a bare import for an ambient `NIMBUS.*` reach — every genuine cross-file reach (into `application-shell.mjs`'s `App`/`EmptyState`, or into `nimbus-intelligence.js`'s `Confidence`/`DarkMode`/`LangSwitcher`/`CommandPalette`) must be typed via the shared `declare const NIMBUS` ambient shim described in Task 1, never "fixed" into a real import — doing so recreates a circular import (T-2).
- **The ambient NIMBUS shim is additive-only across tasks.** Task 1 creates `web/types/nimbus-global.d.mts` with the members its own modules need. Every later task in this plan that reaches a NIMBUS member not yet declared there **extends the same file** (adds a new optional property to the one `declare const NIMBUS` object) rather than creating a second ambient declaration or inlining `as any` at the call site. Keep every member optional (`Foo?:`) since `NIMBUS` is assembled incrementally at runtime and a `?.` guard already exists at every real call site in this file.
- **`/* global NIMBUS */` stays as a comment for ESLint** (unrelated to the TS ambient declaration — it silences the *ESLint* no-undef rule, not a TS mechanism) — do not remove it.
- **`web/types/vendor.d.ts`'s `NimbusVendor` namespace is not yet globally referenceable by name — fix this once, in whichever task first needs to name it.** The namespace is declared *outside* that file's `declare global {}` block, and the file ends in `export {}` (module mode), so today `NimbusVendor.AgGridApi`/`.FlatpickrInstance`/`.VisTimelineInstance`/etc. are scoped locally to `vendor.d.ts` itself — usable only inside that file's own `declare global { const agGrid: {...} }`-style declarations, not nameable from `schedule-workbench.mts` or any other file (verified: zero existing references anywhere in `web/`). This has never surfaced because no `.mts` file has needed to write an explicit `NimbusVendor.X` type annotation before now. Task 1 or Task 2 (whichever needs it first — expected to be Task 2's `Table` for `AgGridApi`) must move the `declare namespace NimbusVendor {...}` block bodily inside the file's existing `declare global { ... }` braces (a pure structural relocation — same interface bodies, same members, zero behavior change, since it's all type-only) so the namespace becomes globally nameable from any `.mts` file in the program. Do this once; later tasks needing other `NimbusVendor` members (Flatpickr in Tasks 1/7/8) then just reference it directly, no further vendor.d.ts edit needed. If a task can avoid naming the namespace at all — e.g. `ReturnType<typeof agGrid.createGrid>` instead of `NimbusVendor.AgGridApi` — that structural approach is also acceptable and needs no vendor.d.ts change; either is fine, but don't leave the file half-fixed (namespace moved for one member and not others).

## File Structure

- Modify: `web/schedule-workbench.mjs` → renamed to `web/schedule-workbench.mts` (Task 1), then edited in place by Tasks 2-8.
- Create: `web/types/nimbus-global.d.mts` (Task 1) — ambient `declare const NIMBUS: {...}` shim, extended by later tasks as needed.
- Modify: `web/types.mts` — only if a task's own Step calls for a new export (see per-task Interfaces).
- Modify: `.gitignore` (Task 1) — add `web/schedule-workbench.mjs`.
- Modify: `tsconfig.json` — add `web/types/nimbus-global.d.mts` to `include` (Task 1).

> **Plan amendment (post-Task-1 finding — see ledger):** Task 1's implementer discovered that renaming the file to `.mts` puts its *entire* 7,525 lines into `tsc`'s single-program `strict` check immediately — not just the converted region. Phases 1-4 never hit this because each converted one whole file in a single task; this is the first file split across multiple tasks. Task 2 (new, inserted below) is a one-time mechanical stopgap that gets the whole-program build green again with placeholder `any` annotations on the not-yet-converted remainder, so Tasks 3-8 each have a genuinely clean `npm run typecheck`/`build`/`test` baseline to gate on — matching every other phase's task discipline. Original Tasks 2-6 are renumbered 3-7, and original Task 7 is renumbered 8.

---

### Task 1: Timeline, TimelineNav, DependencyOverlay + ambient NIMBUS shim

**Files:**
- Modify: `web/schedule-workbench.mjs` (rename to `.mts`), lines 1-1268 (header comment through end of `DependencyOverlay`, i.e. `Timeline` at :156, `TimelineNav` at :885, `DependencyOverlay` at :1092, up to `Table` at :1269)
- Create: `web/types/nimbus-global.d.mts`
- Modify: `.gitignore`, `tsconfig.json` (add the new ambient file to `include`)
- Test: `npm test` (existing `tests/modules/*` suites covering Timeline/TimelineNav/DependencyOverlay must still pass unmodified — this task adds no new test files; it is a types-only conversion of already-tested code)

**Interfaces:**
- Consumes: `Config`, `Util`, `PerfMonitor`, `ErrorLog`, `Toast`, `Modal`, `VirtualList` from `./application-foundation.mjs`; `Store`, `Selection`, `UndoStack`, `Sandbox` from `./schedule-state.mjs`; `Calendar`, `Utilization`, `Alerts`, `Engine` from `./schedule-services.mjs`; `Session`, `Persistence`, `CalendarSync` from `./schedule-data.mjs` — all four already fully typed `.mts` modules from Phases 1-4. Domain types from `web/types.mts`: `NimbusTask`, `NimbusBlock`, `WorkHours`.
- Produces: `Timeline`, `TimelineNav`, `DependencyOverlay` typed exports, consumed later by Tasks 3-8 (same file) and eventually by `plant-and-administration.mts`/`application-shell.mts` (Phases 7/5).

- [ ] **Step 1: Rename and stop tracking the compiled output**

```bash
git mv web/schedule-workbench.mjs web/schedule-workbench.mts
git rm --cached web/schedule-workbench.mjs 2>/dev/null || true
```

Add to `.gitignore` (alongside the existing Phase 1-4 entries):

```
web/schedule-workbench.mjs
```

- [ ] **Step 2: Add the new file to `tsconfig.json`'s `include`**

`tsconfig.json`'s `web/**/*.mts` glob already covers `schedule-workbench.mts` automatically — no edit needed there. Add the new ambient declaration file explicitly, since ambient `.d.mts` files are listed individually elsewhere in this config:

```json
"include": [
  "web/**/*.mts",
  "web/nimbus-compute-core.d.ts",
  "web/types/vendor.d.ts",
  "web/types/api-generated.d.mts",
  "web/types/nimbus-global.d.mts"
]
```

- [ ] **Step 3: Create the ambient NIMBUS shim**

Create `web/types/nimbus-global.d.mts`. This models ONLY the finite set of members this task's three modules actually reach through the bare `NIMBUS` identifier (verified against this file's own header comment, lines 18-30): `App.gotoGanttTimeline()` (called from `Timeline`), `Inspector.show(task)` (called from `Timeline.focus`), `GanttFilter._selectedLines` (a `Set<string>`, read from `Timeline`), `EmptyState.render(container, opts?)` (referenced in this file's later modules, not this task's three — included now since Task 2 needs it immediately after and this file is additive-only per Global Constraints, avoiding a near-duplicate Step 3 in Task 2 for one member).

```typescript
/*
 * web/types/nimbus-global.d.mts — ambient shim for the bare `NIMBUS` global
 * identifier (docs/typescript_migration.md §A implication #2). `NIMBUS` is
 * `app.js`'s own top-level `const` — part of the classic-script shared page
 * realm, never a module import. schedule-workbench.mjs, plant-and-
 * administration.mjs, and application-shell.mjs each reach a handful of
 * members on it for genuine upward-in-the-DAG or sideways-into-
 * nimbus-intelligence.js calls (T-2: these must stay ambient `declare`,
 * never a real `import` — promoting one to an import recreates a circular
 * import, since the reach points at a module that already imports the
 * reacher, or at nimbus-intelligence.js, which is not a CQ-1 module at all).
 *
 * ADDITIVE ONLY: every member below is optional (`Foo?:`) because NIMBUS is
 * assembled at runtime by app.js's bridge-and-return step, and every real
 * call site already guards with `typeof NIMBUS !== 'undefined'` and/or `?.`.
 * When a later phase's task reaches a NIMBUS member not yet declared here,
 * add it to this same object — do not create a second ambient declaration
 * or inline `as any` at the call site.
 */
import type { NimbusTask } from '../types.mjs';

declare global {
  const NIMBUS:
    | undefined
    | {
        App?: {
          goto?(tab: string): void;
          gotoGanttTimeline?(): void;
          _currentTab?: string;
        };
        Inspector?: {
          show?(task: NimbusTask): void;
          _currentId?: string | null;
          _render?(task: NimbusTask): void;
        };
        GanttFilter?: {
          _selectedLines?: Set<string>;
        };
        EmptyState?: {
          render?(container: HTMLElement | null, opts?: { title?: string; msg?: string; icon?: string }): void;
        };
        Timeline?: {
          rebuild?(): void;
        };
        TimelineNav?: {
          render?(): void;
        };
        Table?: {
          _api?: NimbusVendor.AgGridApi;
        };
        Store?: unknown;
        DarkMode?: {
          set?(isDark: boolean): void;
        };
        LangSwitcher?: {
          set?(lang: string): void;
        };
        CommandPalette?: {
          close?(): void;
        };
        Confidence?: {
          snapshot?(): void;
          restore?(): void;
          _recompute?(): void;
        };
      };
}

export {};
```

Note the relative import path is `../types.mjs` (this file lives in `web/types/`, `web/types.mts` compiles to `web/types.mjs` one directory up).

- [ ] **Step 4: Add `/* global NIMBUS */` awareness in the converted file (no change needed)**

`schedule-workbench.mjs` already has `/* global NIMBUS */` at its top (line 142) for ESLint. This is unrelated to the new TS ambient declaration and needs no edit — verify it is still present after the rename.

- [ ] **Step 5: Type `Timeline`, `TimelineNav`, `DependencyOverlay` (lines 148-1268)**

Convert this module region to full-rigor TypeScript:
- Every method gets real parameter and return types.
- `NimbusTask`, `NimbusBlock`, `WorkHours` from `web/types.mts` type the vis-timeline group/item builders and drag-commit handlers.
- vis-timeline itself is already a global (`vis.Timeline`/`vis.DataSet`, declared in `web/types/vendor.d.ts`'s `declare global` block since Phase 0) — construct instances directly (`new vis.Timeline(...)`, `new vis.DataSet(...)`) rather than redeclaring. For an explicit type annotation on a private instance field (e.g. `Timeline._visInstance: NimbusVendor.VisTimelineInstance`), apply the Global Constraints note above about making `NimbusVendor` globally nameable first — this is likely the first task to need it, alongside Task 3's AG Grid usage.
- Every bare `NIMBUS.Foo.bar()` call (the five documented in the header comment: `NIMBUS.App.gotoGanttTimeline()`, `NIMBUS.Inspector.show(...)`, `NIMBUS.GanttFilter._selectedLines`, plus any `EmptyState.render` reach in this region) now resolves against the ambient shim from Step 3 — add `?.` guards only where the existing code already has them (zero behavior change; do not add new optional chaining defensiveness beyond what's already there).
- Preserve the exact judgment-call precedent from Phases 1-4: if a genuinely ambiguous typing choice would change behavior one way and satisfy the compiler another, choose the behavior-preserving one and document it in the task report (mirrors Phase 4's `_writeCacheWithQuotaGuard`/`Session.currentUser()` deviations).

- [ ] **Step 6: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

Expected: all three clean/green. Fix any type errors in this task's own code before proceeding — do not silence with blanket `any`.

- [ ] **Step 7: Commit**

```bash
git add web/schedule-workbench.mts web/types/nimbus-global.d.mts .gitignore tsconfig.json
git commit -m "typescript migration phase 6 task 1: convert Timeline/TimelineNav/DependencyOverlay to .mts, add ambient NIMBUS shim"
```

---

### Task 2: Stopgap-type the untouched remainder (Table onward) — restore a green whole-program build

**Why this task exists:** Task 1's implementer found that `tsconfig.json`'s single-program `strict: true` check applies to the *whole* file the moment it's `.mts`, not just the converted region (see the plan amendment note above and the ledger). This task is pure scaffolding — it adds no real domain typing and produces nothing later tasks are meant to keep. Its only job is to make `npm run typecheck`/`npm run build`/`npm test` pass again so Tasks 3-8 each have a real, green per-task gate, the same discipline every other phase in this migration has had.

**Files:**
- Modify: `web/schedule-workbench.mts`, lines 1269-7525 (everything from `Table` onward — i.e. all of Tasks 3-8's future territory). Do **not** touch lines 1-1268 (`Timeline`/`TimelineNav`/`DependencyOverlay`) — those are already fully and precisely typed by Task 1.

**Interfaces:**
- Consumes: nothing new.
- Produces: a green whole-program build baseline. Every `: any` this task adds is a placeholder that the task owning that region (3-8) is expected to remove and replace with a real, precise type as part of its own conversion — this task's annotations are intentionally throwaway, not a design decision to leave as-is.

- [ ] **Step 1: Enumerate the remaining errors**

```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "schedule-workbench.mts"
```

Confirm every reported error is at line ≥1269 (Task 1's region must show zero errors — if it doesn't, stop and investigate before proceeding; that would mean something is already wrong, not a new problem to paper over).

- [ ] **Step 2: Fix errors one at a time (or in small verified batches) with real edits, never blind bulk insertion**

Task 1's implementer already tried a scripted `: any` inserter targeting error positions by text offset — it corrupted syntax by clashing with destructuring/multi-line signatures and had to be reverted. Do not repeat that approach. For each error:
- `TS7006` (implicit-any parameter): read the actual line, add an explicit `: any` to that specific parameter using an exact-match edit.
- `TS7005`/`TS7034` (implicit-any variable): add `: any` to that variable's declaration.
- Any other error class blocking compilation: use the smallest fix that satisfies the compiler without changing runtime behavior (e.g. `as any` at a call site) — prefer a parameter/variable-level annotation over a broad cast where both are available.
- If a fix would require you to guess at the intended type rather than mechanically silencing the compiler, use `any` — precise typing for this region is explicitly out of scope for this task.

- [ ] **Step 3: Re-run the compiler after every batch of ~20-30 fixes**

```bash
npx tsc -p tsconfig.json --noEmit
```

The error count must decrease monotonically. A sudden large jump means a syntax break from your last edit — stop, diff that edit, and fix it before continuing rather than layering more changes on top of a break.

- [ ] **Step 4: Continue until zero errors, then build and test for real**

```bash
npx tsc -p tsconfig.json --noEmit   # expect: no output, exit 0
npm run build
npm test
```

Confirm the same pass/fail profile Task 1's report predicted: `tests/modules/schedule-workbench.test.mjs` and `tests/js/*.test.js` fully green. `tests/modules/legacy-surface.test.mjs`'s "contract snapshot matches scan result" may now fail — this is expected the first time the file is genuinely compiled (tsc's expression printer re-serializes template-literal `${...}` interpolation spacing, a cosmetic normalization, not a behavior change).

- [ ] **Step 5: If the legacy-surface snapshot test fails, inspect before regenerating**

Read the actual diff. If it is *only* whitespace/formatting inside template-literal interpolations (e.g. `a.taskId||''` → `a.taskId || ''`) and nothing else — no functional entries added or removed — regenerate it:

```bash
node scripts/legacy-surface.mjs --write
```

Review the resulting diff one more time to confirm it matches that same narrow class of change. If the diff shows anything beyond whitespace-in-interpolation, stop and report as a concern rather than committing it — that would mean an actual behavior change is present, either from this task's edits or a pre-existing discrepancy worth surfacing now rather than papering over.

- [ ] **Step 6: Commit**

```bash
git add web/schedule-workbench.mts
# plus the regenerated legacy-surface contract file, if Step 5 applied — check
# scripts/legacy-surface.mjs for exactly where --write updates it
git commit -m "typescript migration phase 6 task 2: stopgap-type schedule-workbench.mts remainder (Table onward) with placeholder any to restore a green whole-program build; Tasks 3-8 replace these region by region"
```

**Note for this task's reviewer:** confirm (a) zero logic changed — types-only, mechanical, (b) Timeline/TimelineNav/DependencyOverlay's real Task-1 types are untouched, (c) the build/test suite is genuinely green, not just "fewer errors than before." Do **not** flag remaining `any` in Table/Inspector/Hierarchy/GanttFilter/Dashboard/Interaction/OptimizeDialog/OptimizerPreview/EditCalendar/ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter as a defect in this task — precise typing of those regions is Tasks 3-8's explicit, separate scope.

---

### Task 3: Table, Inspector, ContextMenu

**Files:**
- Modify: `web/schedule-workbench.mts`, lines 1269-2820 (`Table` at :1269, `Inspector` at :2522, `ContextMenu` at :2765, up to `Hierarchy` at :2821) — replacing Task 2's placeholder `any` annotations in this range with real, precise types
- Modify: `web/types/nimbus-global.d.mts` only if this task reaches a NIMBUS member not already declared (per the header comment, `Table` reaches `EmptyState.render(...)` — already declared in Task 1 — and `AlertsUIAdapter.focus(...)` inside `_showAlertPopup`, which is NOT yet declared)

**Interfaces:**
- Consumes: same imports as Task 1 (already present at the top of the file); AG Grid ambient types from `web/types/vendor.d.ts` for `Table`'s grid instance and column defs.
- Produces: `Table`, `Inspector`, `ContextMenu` typed exports.

- [ ] **Step 1: Extend the ambient shim for `AlertsUIAdapter`**

`Table._showAlertPopup` calls `NIMBUS.AlertsUIAdapter.focus(...)` (a genuine forward reference — `AlertsUIAdapter` doesn't move into this file until Task 7). Add to `web/types/nimbus-global.d.mts`'s existing object (do not create a second `declare`):

```typescript
AlertsUIAdapter?: {
  focus?(alertId: string): void;
  showForCell?(line: string, dayKey: string): void;
  renderBell?(): void;
  renderDrawer?(): void;
};
```

- [ ] **Step 2: Type `Table` (lines 1269-2521)**

Full-rigor typing for the AG Grid wrapper: column defs, cell renderers/editors (including the `_DateTimeEditor` native-input editor noted in `CLAUDE.md`), row-data shape (`NimbusTask[]`), and the two-way `Selection` sync. `Table._api` (the AG Grid instance returned by `agGrid.createGrid(...)`) types against `NimbusVendor.AgGridApi` per the Global Constraints note above — apply that vendor.d.ts fix here if it hasn't landed yet. Column definitions type against `NimbusVendor.AgGridOptions`'s intentionally loose `[key: string]: unknown` shape (per vendor.d.ts's own comment — do not tighten it as a side effect of this task).

- [ ] **Step 3: Type `Inspector` (lines 2522-2764)**

Full-rigor typing: `_currentId`, `_render(task: NimbusTask)`, and the `start_date` Flatpickr instance (per `CLAUDE.md`'s Flatpickr standard — Inspector's is initialized fresh on each `_render()` call, no stored module-level instance, so no persistent Flatpickr-instance field to type beyond the local variable).

- [ ] **Step 4: Type `ContextMenu` (lines 2765-2820)**

Full-rigor typing — this is the smallest module in the file (56 lines).

- [ ] **Step 5: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 6: Commit**

```bash
git add web/schedule-workbench.mts web/types/nimbus-global.d.mts
git commit -m "typescript migration phase 6 task 3: convert Table/Inspector/ContextMenu to .mts"
```

---

### Task 4: Hierarchy, GanttFilter

**Files:**
- Modify: `web/schedule-workbench.mts`, lines 2821-3423 (`Hierarchy` at :2821, `GanttFilter` at :3004, up to `Dashboard` at :3424) — replacing Task 2's placeholder `any` annotations in this range with real, precise types

**Interfaces:**
- Consumes: `VL_HIER_LINE_H`/`VL_HIER_TASK_H` module-level consts (already in the file, moved from `app.js` per the header comment — these become typed `number` consts, no behavior change); `VirtualList` from foundation for `Hierarchy`'s windowed line list.
- Produces: `Hierarchy`, `GanttFilter` typed exports. No new ambient NIMBUS members — the header comment records `GanttFilter._selectedLines` as a Task-1-covered reach *into* this module, not a reach *from* it.

- [ ] **Step 1: Type `Hierarchy` (lines 2821-3003)**

Full-rigor typing, including the `VirtualList` binding for the windowed plant/line tree — reuse `VirtualList`'s existing typed generic from Phase 1, do not redeclare.

- [ ] **Step 2: Type `GanttFilter` (lines 3004-3423)**

Full-rigor typing. Note from the header comment: this task also "closes GanttFilter's nimbus-intelligence.js private-consumer debt" in the original JS split — that consumer relationship is unchanged by the TS conversion (nimbus-intelligence.js stays untyped); do not alter `GanttFilter`'s public surface.

- [ ] **Step 3: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 4: Commit**

```bash
git add web/schedule-workbench.mts
git commit -m "typescript migration phase 6 task 4: convert Hierarchy/GanttFilter to .mts"
```

---

### Task 5: Dashboard

**Files:**
- Modify: `web/schedule-workbench.mts`, lines 3424-4374 (`Dashboard` at :3424, up to `Interaction` at :4375) — replacing Task 2's placeholder `any` annotations in this range with real, precise types
- Modify: `web/types/nimbus-global.d.mts` if a new member surfaces (per the header comment, `Dashboard` reaches `AlertsUIAdapter.renderBell()` — already declared in Task 3 — `EmptyState.render(...)` — already declared in Task 1 — and `App.goto(...)`/`.gotoGanttTimeline()` — already declared in Task 1). Expect no shim changes this task.

**Interfaces:**
- Consumes: `VL_LS_ROW_H` module-level const (moved from `app.js`, per header comment); `Utilization.computeMatrix` return shape from `schedule-services.mts` (already typed).
- Produces: `Dashboard` typed export.

- [ ] **Step 1: Type `Dashboard` (lines 3424-4374)**

Full-rigor typing for the KPI strip and hand-rolled DOM/CSS heatmap (per `CLAUDE.md`: Dashboard is not Chart.js-based — confirm no stray `Chart` global reference needs typing). `Store.rev()` and `Store.masterData` calls use `schedule-state.mts`'s existing typed getters — do not add new ones.

- [ ] **Step 2: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 3: Commit**

```bash
git add web/schedule-workbench.mts
git commit -m "typescript migration phase 6 task 5: convert Dashboard to .mts"
```

---

### Task 6: Interaction

**Files:**
- Modify: `web/schedule-workbench.mts`, lines 4375-5572 (`Interaction` at :4375, up to `OptimizeDialog` at :5573) — replacing Task 2's placeholder `any` annotations in this range with real, precise types
- Modify: `web/types/nimbus-global.d.mts` — `AlertsUIAdapter.showForCell` already declared in Task 3; expect no shim changes this task.

**Interfaces:**
- Consumes: `Selection`, `UndoStack` from `schedule-state.mts`; `Engine.autoReflow` from `schedule-services.mts` (typed loose per Phase 3's documented exception — `Interaction`'s own call sites into `Engine` should type their own side using precise types even though `Engine`'s internals stay loose; this is calling an already-loosely-typed outer signature, not re-loosening `Interaction` itself).
- Produces: `Interaction` typed export, including its `install()`/`uninstall()` lifecycle methods and the four named bound-reference fields (`_edgeScrollTrackBound`, `_hideTooltipBound`, `_onKeyDownBound`, `_hoverDismissBound`) noted in the header comment.

- [ ] **Step 1: Type `Interaction` (lines 4375-5572)**

Full-rigor typing for the densest module in the codebase — the unified click/keyboard/drag pipeline, marquee multi-select, hover-preview card, ghost-drag, and AG Grid ↔ Selection sync (per `CLAUDE.md`'s Architecture notes on `Interaction`). This module was untested before the original CQ-1 Task 5 (per the header comment); do not weaken or remove any test coverage that Task 5 added — if `tests/modules/` has an `Interaction`-specific suite, it must still pass unmodified after this conversion.

Per the header comment's own documented deviations for this module: `_showMultiInspector`'s generated panel HTML uses `data-action` attributes wired via `addEventListener`, not inline `onclick` strings — type the `data-action` dispatch table precisely (a `Record<string, () => void>` or equivalent) rather than `any`.

- [ ] **Step 2: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 3: Commit**

```bash
git add web/schedule-workbench.mts
git commit -m "typescript migration phase 6 task 6: convert Interaction to .mts"
```

---

### Task 7: OptimizeDialog, OptimizerPreview

**Files:**
- Modify: `web/schedule-workbench.mts`, lines 5573-6119 (`OptimizeDialog` at :5573, `OptimizerPreview` at :6120, up to `EditCalendar` at :6524) — replacing Task 2's placeholder `any` annotations in this range with real, precise types
- Modify: `web/types/nimbus-global.d.mts` — `Confidence` already declared in Task 1; expect no shim changes this task.

**Interfaces:**
- Consumes: `OptimizerMode` type from `web/types.mts` (`'spt' | 'changeover' | 'combined'`) for `OptimizeDialog`'s mode selector; `Engine.runAndApply` from `schedule-services.mts`.
- Produces: `OptimizeDialog`, `OptimizerPreview` typed exports.

- [ ] **Step 1: Type `OptimizeDialog` (lines 5573-6119)**

Full-rigor typing, including the two registered Flatpickr instances (`OptimizeDialog._fpStart`/`._fpEnd`, per `CLAUDE.md`'s Flatpickr registry) — type them against `web/types/vendor.d.ts`'s existing Flatpickr ambient type, do not redeclare it. Per the header comment, `applyPreset`'s one `Store._state.masterData` read is left untouched (not in scope for this task) — type it as whatever `Store._state` already resolves to (a `schedule-state.mts` internal it's reaching into directly; if `_state` isn't part of `Store`'s public typed surface, this is exactly the kind of pre-existing internal-reach pattern Phase 2 already typed elsewhere in the codebase — match that precedent, do not add a new public getter as a side effect of this task).

- [ ] **Step 2: Type `OptimizerPreview` (lines 6120-6523)**

Full-rigor typing for `runWithPreview`'s before/after KPI preview and undo snapshot. The `NIMBUS.Confidence?.snapshot()/.restore()/._recompute()` calls resolve against the Task-1 ambient shim — leave them exactly as-is per the header comment (out of scope regardless of which file `OptimizerPreview` lives in).

- [ ] **Step 3: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 4: Commit**

```bash
git add web/schedule-workbench.mts
git commit -m "typescript migration phase 6 task 7: convert OptimizeDialog/OptimizerPreview to .mts"
```

---

### Task 8: EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, AlertsUIAdapter

**Files:**
- Modify: `web/schedule-workbench.mts`, lines 6524-7525 (`EditCalendar` at :6524, `ColorWheelViewer` at :6737, `AlertsUIAdapter` at :6918, `SandboxAdapter` at :7254, `Printer` at :7376, to end of file) — replacing Task 2's placeholder `any` annotations in this range with real, precise types

**Interfaces:**
- Consumes: `CalendarSync`, `Sandbox`, `Calendar` — new imports this task needs per the header comment (`SandboxAdapter` calls `Sandbox.active`/`.enter`/`CalendarSync.flushPlant`/`.fetchPlantConfig`/`._deferredHydrationPlant`; `AlertsUIAdapter.showForCell` calls `Calendar.effectiveCapacityHours`) — verify these are already imported at the top of the file from Task 1 (`Sandbox` from `schedule-state.mts`, `Calendar`/`CalendarSync` from `schedule-services.mts`/`schedule-data.mts` respectively); if any is missing from the existing top-of-file import statements, add it there.
- Produces: `EditCalendar`, `ColorWheelViewer`, `Printer`, `SandboxAdapter`, `AlertsUIAdapter` typed exports — the last exported member of this file.

- [ ] **Step 1: Type `EditCalendar` (lines 6524-6736)**

Full-rigor typing for the 14 Flatpickr working-hours pickers (`EditCalendar._fp`, per `CLAUDE.md`'s registry). Per the header comment, its five call sites now use `Util.hoursToTimeString`/`.timeStringToHours` from `application-foundation.mts` (already typed in Phase 1) instead of private duplicated helpers — verify these calls type-check against Phase 1's existing signatures without modification.

- [ ] **Step 2: Type `ColorWheelViewer` (lines 6737-6917)**

Full-rigor typing for the color-wheel preview modal (`{entries:[{color, order_y}]}` response shape per `CLAUDE.md` — add a local interface for this response shape if one doesn't already exist in `web/types.mts`).

- [ ] **Step 3: Type `AlertsUIAdapter` (lines 6918-7253)**

Full-rigor typing, including the `VL_ALERT_ROW_H` VirtualList row-height const (moved here from `app.js` per the header comment) and `AlertType`/`AlertSev` from `web/types.mts` for the alert-list rendering. `focus`/`showForCell`/`renderBell`/`renderDrawer` are the four methods the ambient shim (Task 1/3) already declares as `NIMBUS.AlertsUIAdapter.*` for OTHER modules' forward references — leave those forward-reference call sites (in `Table`, `Interaction`) exactly as `NIMBUS.AlertsUIAdapter...` per the header comment (a bare identifier would resolve identically since they're now same-file; touching call sites that already work is not required by this task).

- [ ] **Step 4: Type `SandboxAdapter` (lines 7254-7375)**

Full-rigor typing. Per the header comment, `Store._state.blocks`/`.plantBlocks` reads and `AlertsUIAdapter.renderDrawer`/`.renderBell`'s `Store._state.masterData` reads are left untouched (out of scope) — type them consistently with however Task 7's `OptimizeDialog.applyPreset` handled the same `Store._state` pattern (Task 7, Step 1) for consistency across the file.

- [ ] **Step 5: Type `Printer` (lines 7376-7525)**

Full-rigor typing for the export/print modal, including its two registered Flatpickr instances (`Printer._fpStart`/`._fpEnd`, per `CLAUDE.md`'s registry).

- [ ] **Step 6: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 7: Commit**

```bash
git add web/schedule-workbench.mts
git commit -m "typescript migration phase 6 task 8: convert EditCalendar/ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter to .mts"
```

---

## After all 8 tasks: final whole-branch review

Per `superpowers:subagent-driven-development`, after Task 8 completes, dispatch the final code reviewer on the full range (Task 1's BASE commit through Task 8's HEAD) on the most capable available model. Confirm:
- Zero `any`/`unknown` outside the documented `Store._state`/ambient-`NIMBUS` exceptions above — this specifically includes verifying Task 2's placeholder `any` annotations were fully replaced by Tasks 3-8 and none survive in the final diff.
- `web/types/nimbus-global.d.mts` only grew additively — no member was ever removed or retyped narrower across tasks.
- `npm run typecheck` / `npm run build` / `npm test` all clean on the full range.
- Update `docs/typescript_migration.md`'s phase table: Phase 6 → **Done**, with a landed-note mirroring Phases 1-4's style (file size, full-rigor confirmation, the ambient-NIMBUS-shim design decision, any judgment calls carried from individual tasks).
