# TypeScript Migration Phase 7 (plant-and-administration.mjs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `web/plant-and-administration.mjs` (6,921 lines — the second-largest CQ-1 module) to real, fully-typed TypeScript (`web/plant-and-administration.mts`), matching the full-rigor standard from Phases 1, 2, 4, and 6.

**Architecture:** This file has 8 top-level exported modules: `CalendarUI`, `Plant`, `ProdLines`, `LaborPlanning`, `MasterData`, `AdminCockpit`, `Interface`, `Security`. Its own header comment (lines 1-38) documents the original CQ-1 JS-module-extraction task split (Phase 4 Task 1: CalendarUI/Plant/ProdLines; Task 2: MasterData/LaborPlanning; Task 3: Interface/Security/AdminCockpit) and every real cross-file reach. This plan mostly mirrors those boundaries, adjusted for size balance (`AdminCockpit` alone is ~2,273 lines — comparable to all of Phase 4's `schedule-data.mts` — so it gets its own task; `Interface`/`Security` are genuinely self-contained per the header comment, so they pair well as a smaller final task).

**Prerequisite:** This phase runs *after* Phase 6 (`schedule-workbench.mjs` → `.mts`) completes — this file imports `AlertsUIAdapter` from `./schedule-workbench.mjs` (line 44), so `allowJs: false` blocks this conversion from typechecking until that import resolves to a real `.mts` sibling. Do not start this plan before Phase 6's final review is clean.

**Tech Stack:** `tsc` (existing `tsconfig.json`). Reuses `web/types/nimbus-global.d.mts` (created in Phase 6 Task 1) — extends it, does not replace it.

## Global Constraints

- **Full rigor, no loose-typing exceptions.** Same standard as Phases 1, 2, 4, 6.
- **Zero behavior change.** Types-only conversion — no logic refactors, no "cleanup" of the documented same-file `NIMBUS.*` indirections (see below).
- **Per-module conversion ritual**, every task:
  1. First task only: `git mv web/plant-and-administration.mjs web/plant-and-administration.mts`.
  2. First task only: `git rm --cached web/plant-and-administration.mjs` and add the exact filename to `.gitignore`.
  3. Reuse existing `web/types.mts` domain types; add new ones only for genuinely new shapes.
  4. `tsconfig.json`'s `web/**/*.mts` glob covers the renamed file automatically — no config edit needed for the file itself.
  5. Import specifiers keep the `.mjs` suffix.
  6. `npm run typecheck && npm run build && npm test` clean before commit.
  7. Commit.
- **Important finding from surveying this file's real (non-string) `NIMBUS.*` reaches — much narrower than Phase 6's:** most `NIMBUS.Foo.bar(...)`-looking text in this file (e.g. `onclick="NIMBUS.Plant._pillClick(...)"`, `onclick="NIMBUS.App.goto(...)"`) is **HTML markup baked into template-string `innerHTML` assignments** — opaque string content the browser's classic global scope resolves at click time, never parsed by `tsc` at all. These need **no ambient typing whatsoever** — do not add ambient members for identifiers you only find inside a `.innerHTML =` template string or an `onclick="..."` attribute string. Only two call sites in this entire file are genuine bare-identifier JS code reaching through `NIMBUS`:
  - `NIMBUS.MasterData.syncLineSettings(line: string, patch: Record<string, unknown>): void` — real JS code, multiple call sites in `Plant` (`plant-and-administration.mjs:620`) and `ProdLines` (`:1274,1278,1283,1288,1293,1303`), a same-file forward reference to `MasterData` (which lives in this same file, per the header comment's own precedent for same-file indirections left as-is).
  - `NIMBUS.Confidence?._recomputeDebounced?.()` — real JS code, `plant-and-administration.mjs:938-939`, inside `Plant`. Note this is a **different** `Confidence` member than the one Phase 6 Task 1 already declared (`snapshot`/`restore`/`_recompute`) — add `_recomputeDebounced` as a new optional member on the existing `Confidence` entry in `web/types/nimbus-global.d.mts`, do not create a duplicate `Confidence` property.
  - If a task's implementer finds a THIRD genuine bare-identifier reach not listed above, treat it as a real discovery: add it to the shim the same additive way, and note it in the task report.
- **T-1/T-2 traps apply.** Never promote `NIMBUS.MasterData.syncLineSettings(...)` to a real same-module reference, and never promote `NIMBUS.Confidence...` to an import — both stay ambient per T-2, matching this file's own documented precedent (§ header comment, lines 11-17).
- **DI resolver seam, not ambient NIMBUS, for tab-state reads.** `Plant`/`LaborPlanning` read "am I the active tab?" via the injected `_activeTabResolvers` seam (`setActiveTabResolvers`, lines 46-56) — **not** via ambient `NIMBUS.App`. Per T-3, do not refactor this seam into a direct import of `App` (circular — `App` lives in `application-shell.mjs`, above this file in the DAG) and do not replace it with an ambient `NIMBUS.App` reach either — the DI-seam pattern is already the correct, existing solution here; just type it (`_activeTabResolvers`'s shape, `setActiveTabResolvers`'s parameter type).

## File Structure

- Modify: `web/plant-and-administration.mjs` → renamed to `.mts` (Task 1), edited in place by Tasks 2-6.
- Modify: `web/types/nimbus-global.d.mts` — extended additively (Task 1, for `Confidence._recomputeDebounced` and `MasterData.syncLineSettings`).
- Modify: `.gitignore` (Task 1).

> **Plan amendment (lesson from Phase 6 Task 1 — see that phase's ledger):** Renaming this file to `.mts` puts its *entire* 6,921 lines into `tsc`'s single-program `strict` check immediately, not just each task's converted region — Phase 6 discovered this the hard way when its first task's commit left the whole-program build red until its final task landed. This plan avoids that: Task 2 (new, inserted below) is a one-time mechanical stopgap that gets the whole-program build green again with placeholder `any` on the not-yet-converted remainder, so Tasks 3-6 each have a genuinely clean `npm run typecheck`/`build`/`test` baseline to gate on. Original Tasks 2-5 are renumbered 3-6.

---

### Task 1: CalendarUI, Plant

**Files:**
- Modify: `web/plant-and-administration.mjs` (rename to `.mts`), lines 1-1050 (`CalendarUI` at :70, `Plant` at :258, up to `ProdLines` at :1051)
- Modify: `web/types/nimbus-global.d.mts` — add `_recomputeDebounced` to the existing `Confidence` member, and add a new `MasterData?: { syncLineSettings?(line: string, patch: Record<string, unknown>): void }` member
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `Config`, `Util`, `ErrorLog`, `Toast`, `Modal`, `PerfMonitor` from `./application-foundation.mjs`; `Store`, `UndoStack` from `./schedule-state.mjs`; `Calendar`, `Engine`, `Utilization` from `./schedule-services.mjs`; `CalendarSync`, `Session`, `Persistence` from `./schedule-data.mjs`; `AlertsUIAdapter` from `./schedule-workbench.mjs` (Phase 6, now typed) — all six already fully typed `.mts` modules. Domain types from `web/types.mts`: `NimbusBlock`, `NimbusPlantBlock`, `WorkHours`.
- Produces: `CalendarUI`, `Plant` typed exports, plus `setActiveTabResolvers(resolvers)` and its module-level `_activeTabResolvers` state (shared by `LaborPlanning` in Task 3 — same file, same binding, no re-declaration needed there).

- [ ] **Step 1: Rename and stop tracking the compiled output**

```bash
git mv web/plant-and-administration.mjs web/plant-and-administration.mts
git rm --cached web/plant-and-administration.mjs 2>/dev/null || true
```

Add to `.gitignore`:

```
web/plant-and-administration.mjs
```

- [ ] **Step 2: Extend the ambient NIMBUS shim**

Open `web/types/nimbus-global.d.mts` (created in Phase 6 Task 1). Add `_recomputeDebounced` to the existing `Confidence` member (it already has `snapshot?`/`restore?`/`_recompute?` — add the fourth alongside them, same object, do not duplicate the `Confidence` property):

```typescript
Confidence?: {
  snapshot?(): void;
  restore?(): void;
  _recompute?(): void;
  _recomputeDebounced?(): void;
};
```

Add a new top-level member to the same `declare const NIMBUS` object:

```typescript
MasterData?: {
  syncLineSettings?(line: string, patch: Record<string, unknown>): void;
};
```

- [ ] **Step 3: Type `_activeTabResolvers` / `setActiveTabResolvers` (lines 46-56)**

```typescript
interface ActiveTabResolvers {
  currentTab(): string | null;
  currentMasterSub(): string | null;
  laborSub(): string | null;
}
```

Type `_activeTabResolvers: ActiveTabResolvers` and `setActiveTabResolvers(resolvers: Partial<ActiveTabResolvers>): void` — the function does a shallow merge (`{ ..._activeTabResolvers, ...resolvers }`), so its parameter is a `Partial`, not the full interface.

- [ ] **Step 4: Type `CalendarUI` (lines 70-257)**

Full-rigor typing for the blackout-block-tab UI. Real bare-`NIMBUS` reaches in this module's actual code (not HTML strings) — verify against the file directly; per the Global Constraints survey, expect none beyond what's already covered.

- [ ] **Step 5: Type `Plant` (lines 258-1050)**

Full-rigor typing, including:
- `NIMBUS.Confidence?._recomputeDebounced?.()` (line ~938) — resolves against the shim extended in Step 2.
- `NIMBUS.MasterData.syncLineSettings(...)` (line ~620) — resolves against the shim extended in Step 2.
- `_wireStaticHandlers()`'s DOM listener wiring (per the header comment, converts static `onclick=` attributes to real listeners) — type the element lookups as `HTMLElement | null` per existing codebase convention (optional chaining before use).
- `Plant._renderSettingsPane` (relocated bodily from `App` per the header comment) — type it consistently with how `App`'s other rendering methods are typed elsewhere in the codebase (check `application-foundation.mts`/`schedule-workbench.mts` for the established pattern on similar render methods).
- Registered Flatpickr instances: `Plant._pillFps` (7 per-day `{start,end}` pickers) and `Plant._fpBlkStart`/`._fpBlkEnd` (per `CLAUDE.md`'s Flatpickr registry) — type against `NimbusVendor.FlatpickrInstance` (Phase 6 already made this namespace globally nameable; if for any reason it isn't, apply the same fix Phase 6 Task 1/3 used).

- [ ] **Step 6: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 7: Commit**

```bash
git add web/plant-and-administration.mts web/types/nimbus-global.d.mts .gitignore
git commit -m "typescript migration phase 7 task 1: convert CalendarUI/Plant to .mts"
```

---

### Task 2: Stopgap-type the untouched remainder (ProdLines onward) — restore a green whole-program build

**Why this task exists:** Same structural issue Phase 6 hit — the moment this file is `.mts`, `tsc`'s single-program `strict` check covers all 6,921 lines, not just Task 1's converted region. This task is pure scaffolding: no real domain typing, nothing later tasks are meant to keep. Its only job is to make `npm run typecheck`/`npm run build`/`npm test` pass again so Tasks 3-6 each have a genuinely green per-task gate.

**Files:**
- Modify: `web/plant-and-administration.mts`, lines 1051-6921 (everything from `ProdLines` onward — all of Tasks 3-6's future territory). Do **not** touch lines 1-1050 (`CalendarUI`/`Plant`) — already fully and precisely typed by Task 1.

**Interfaces:**
- Consumes: nothing new.
- Produces: a green whole-program build baseline. Every `: any` this task adds is a placeholder the task owning that region (3-6) is expected to remove and replace with a real, precise type — this task's annotations are intentionally throwaway.

- [ ] **Step 1: Enumerate the remaining errors**

```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "plant-and-administration.mts"
```

Confirm every reported error is at line ≥1051 (Task 1's region must show zero errors — if it doesn't, stop and investigate first).

- [ ] **Step 2: Fix errors one at a time (or in small verified batches) with real edits, never blind bulk insertion**

Phase 6 Task 1's implementer tried a scripted `: any` inserter targeting error positions by text offset — it corrupted syntax by clashing with destructuring/multi-line signatures and had to be reverted. Do not repeat that approach here. For each error:
- `TS7006` (implicit-any parameter): read the actual line, add an explicit `: any` to that specific parameter with an exact-match edit.
- `TS7005`/`TS7034` (implicit-any variable): add `: any` to that variable's declaration.
- Any other error class blocking compilation: use the smallest fix that satisfies the compiler without changing runtime behavior (e.g. `as any` at a call site).
- If a fix would require guessing the intended type rather than mechanically silencing the compiler, use `any` — precise typing here is explicitly out of scope for this task.

- [ ] **Step 3: Re-run the compiler after every batch of ~20-30 fixes**

```bash
npx tsc -p tsconfig.json --noEmit
```

The error count must decrease monotonically. A sudden jump means a syntax break from your last edit — stop, diff it, and fix before continuing.

- [ ] **Step 4: Continue until zero errors, then build and test for real**

```bash
npx tsc -p tsconfig.json --noEmit   # expect: no output, exit 0
npm run build
npm test
```

Confirm existing `tests/modules/plant-and-administration.test.mjs` (or equivalent) and `tests/js/*.test.js` suites are fully green. If `tests/modules/legacy-surface.test.mjs`'s contract-snapshot test fails with a diff limited to whitespace/formatting inside template-literal `${...}` interpolations (the same one-time cosmetic effect Phase 6 Task 2 documented), regenerate it the same way that task did:

```bash
node scripts/legacy-surface.mjs --write
```

Review the diff to confirm it is exactly that narrow class of change before including it in this task's commit. If it shows anything else, stop and report as a concern instead.

- [ ] **Step 5: Commit**

```bash
git add web/plant-and-administration.mts
# plus the regenerated legacy-surface contract file, if Step 4 applied
git commit -m "typescript migration phase 7 task 2: stopgap-type plant-and-administration.mts remainder (ProdLines onward) with placeholder any to restore a green whole-program build; Tasks 3-6 replace these region by region"
```

**Note for this task's reviewer:** confirm (a) zero logic changed — types-only, mechanical, (b) CalendarUI/Plant's real Task-1 types are untouched, (c) build/test suite is genuinely green. Do **not** flag remaining `any` in ProdLines/LaborPlanning/MasterData/AdminCockpit/Interface/Security as a defect here — precise typing of those regions is Tasks 3-6's explicit, separate scope.

---

### Task 3: ProdLines, LaborPlanning

**Files:**
- Modify: `web/plant-and-administration.mts`, lines 1051-2272 (`ProdLines` at :1051, `LaborPlanning` at :1376, up to `MasterData` at :2273) — replacing Task 2's placeholder `any` annotations in this range with real, precise types

**Interfaces:**
- Consumes: `_activeTabResolvers`/`ActiveTabResolvers` from Task 1 (same file, same module scope — no import needed); `NimbusLineSetting`, `BufferUnit` from `web/types.mts` for the per-line settings controls.
- Produces: `ProdLines`, `LaborPlanning` typed exports.

- [ ] **Step 1: Type `ProdLines` (lines 1051-1375)**

Full-rigor typing. The six `NIMBUS.MasterData.syncLineSettings(...)` call sites (lines ~1274-1303) resolve against the shim extended in Task 1 — no further shim changes needed.

- [ ] **Step 2: Type `LaborPlanning` (lines 1376-2272)**

Full-rigor typing for the Labor Planning subsystem (aggregate/line-plan/capacity/exceptions/inputs sub-tabs, per `CLAUDE.md`). Per the header comment: `LaborPlanning`'s `App._laborSub`/`App._currentTab` reads already went through `_activeTabResolvers` (Task 1's seam) — verify no residual bare `App.*` reach remains uncaught. Per the header comment's own tracked gap: `LaborPlanning` still has six direct `Store._state.masterData` reads not closed by the original JS-migration task — type these consistently with how Phase 6 handled the analogous `Store._state.masterData`/`Store._state.blocks` reads in `OptimizeDialog`/`SandboxAdapter` (Phase 6 Tasks 7-8): match that precedent rather than inventing a new pattern or adding a new public `Store` getter as a side effect of this task. Registered Flatpickr instance: `LaborPlanning._fpHorizon` (horizon date-jump, per `CLAUDE.md`'s registry).

- [ ] **Step 3: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 4: Commit**

```bash
git add web/plant-and-administration.mts
git commit -m "typescript migration phase 7 task 3: convert ProdLines/LaborPlanning to .mts"
```

---

### Task 4: MasterData

**Files:**
- Modify: `web/plant-and-administration.mts`, lines 2273-3460 (`MasterData` at :2273, up to `AdminCockpit` at :3461) — replacing Task 2's placeholder `any` annotations in this range with real, precise types

**Interfaces:**
- Consumes: `Store.setMasterData(...)` from `schedule-state.mts` (the public setter `MasterData` already uses per the header comment — already typed in Phase 2, do not add a new one). Domain types: `NimbusMasterData`, `NimbusMasterPlant`, `NimbusMasterLine`, `ConstraintConfig` from `web/types.mts`.
- Produces: `MasterData` typed export — this is the module the ambient shim's `NIMBUS.MasterData.syncLineSettings` type (Task 1) describes; verify `MasterData`'s real `syncLineSettings` method signature here matches that shim exactly (`(line: string, patch: Record<string, unknown>) => void`) — if the real signature is more specific (e.g. `patch: Partial<NimbusLineSetting>`), tighten the ambient shim's declaration to match rather than leaving it looser than the real implementation.

- [ ] **Step 1: Type `MasterData` (lines 2273-3460)**

Full-rigor typing for the "Manage Data Tables" CRUD grid (paste, FK selects, add/drop/rename column DDL wizard, cascade-delete preview — per `CLAUDE.md`). This module owns the eight `ALLOWED_TABLES` (`subnetworks`, `plants`, `production_lines`, `materials`, `material_plants`, `bom_items`, `roles`, `role_plants`) — if a per-table row shape doesn't already exist in `web/types.mts`, add hand-written interfaces here (local to this file, following Phase 4's precedent of local interfaces for endpoints outside the `response_model=` scope — `master_data.py` endpoints are not part of that scope per Phase 4's landed note).

- [ ] **Step 2: Verify and reconcile the `syncLineSettings` signature**

Compare `MasterData.syncLineSettings`'s real parameter types against the ambient shim declared in Task 1. Update `web/types/nimbus-global.d.mts`'s `MasterData` member to match exactly if the real signature is more specific than the placeholder `Record<string, unknown>`.

- [ ] **Step 3: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 4: Commit**

```bash
git add web/plant-and-administration.mts web/types/nimbus-global.d.mts
git commit -m "typescript migration phase 7 task 4: convert MasterData to .mts"
```

---

### Task 5: AdminCockpit

**Files:**
- Modify: `web/plant-and-administration.mts`, lines 3461-5733 (`AdminCockpit` at :3461, up to `Interface` at :5734) — the largest single task in this entire migration (~2,273 lines, comparable to all of Phase 4's `schedule-data.mts`) — replacing Task 2's placeholder `any` annotations in this range with real, precise types

**Interfaces:**
- Consumes: `PerfMonitor` from `application-foundation.mts` (thread profiler tab). No cross-file `NIMBUS.*` reaches expected — per the header comment, `AdminCockpit`'s dispatch to `MasterData.render()`/`Interface.render()`/`Security.render()` in `_setSub` is already a same-file bare reference (no ambient seam involved).
- Produces: `AdminCockpit` typed export.

- [ ] **Step 1: Type `AdminCockpit` (lines 3461-5733)**

Full-rigor typing for the admin console described in `CLAUDE.md`: upload/data management, the Postgres ops console (pool utilization, server info, table bloat + VACUUM/ANALYZE triggers, active-connection stacks, blocking-lock chains, index usage/unused detection, slow-query bars via `pg_stat_statements`, sequence exhaustion), the `PerfMonitor` thread profiler tab, the diagnostics-bundle exporter, and the FE↔BE `x-request-id` correlation feature (clicking a `reqId` pins it as a filter on both panes). This module has no clean internal sub-module boundary (it is one large object, not several) — do not attempt to split it into a separate file or introduce new internal module structure as part of this task; type it in place, end to end.

Given the size, prioritize getting real types on: every fetch response shape (add local interfaces per distinct `/diagnostics*`/`/logs/backend`/`/maintenance/*` endpoint response, following Phase 4's precedent for hand-written local interfaces outside the `response_model=` scope), the health-polling start/stop lifecycle (`_startHealthPolling`/`_stopHealthPolling`, referenced from `application-shell.mjs`'s visibility-change handler — Phase 5 will import these as real typed methods once this task lands), and the `PerfMonitor` binding (already typed in Phase 1 — reuse, don't redeclare).

- [ ] **Step 2: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 3: Commit**

```bash
git add web/plant-and-administration.mts
git commit -m "typescript migration phase 7 task 5: convert AdminCockpit to .mts"
```

---

### Task 6: Interface, Security

**Files:**
- Modify: `web/plant-and-administration.mts`, lines 5734-6921 (`Interface` at :5734, `Security` at :6303, to end of file) — replacing Task 2's placeholder `any` annotations in this range with real, precise types

**Interfaces:**
- Consumes: per the header comment, both modules are "fully self-contained (zero cross-references to any other of the 14 modules)" — verify this still holds; if either module has grown a cross-reference since the header comment was written, treat it as a real finding (add ambient shim entries if genuinely needed, or note in the task report if it's a same-file/import fix instead).
- Produces: `Interface`, `Security` typed exports — the last exported members of this file.

- [ ] **Step 1: Type `Interface` (lines 5734-6302)**

Full-rigor typing for the SAP sync config/field-mapping/run-history UI (per `CLAUDE.md`'s Backend section on `sap_sync.py` — this module is the frontend counterpart to `sap_sync_config`/`sap_sync_run`/`sap_field_map`). Add local interfaces for the sync-config/run-history response shapes if not already in `web/types.mts`.

- [ ] **Step 2: Type `Security` (lines 6303-6920)**

Full-rigor typing for the admin-side user/role management UI (distinct from `Session`'s self-service `/security/me*` endpoints already typed in Phase 4 — `Security` here covers admin CRUD over other users' accounts/roles).

- [ ] **Step 3: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

- [ ] **Step 4: Commit**

```bash
git add web/plant-and-administration.mts
git commit -m "typescript migration phase 7 task 6: convert Interface/Security to .mts"
```

---

## After all 6 tasks: final whole-branch review

Per `superpowers:subagent-driven-development`, dispatch the final code reviewer on the full range (Task 1's BASE through Task 6's HEAD) on the most capable available model. Confirm:
- Zero `any`/`unknown` outside the documented `Store._state` exception (Task 3, matched to Phase 6's precedent) — this specifically includes verifying Task 2's placeholder `any` annotations were fully replaced by Tasks 3-6 and none survive in the final diff.
- `web/types/nimbus-global.d.mts` grew only additively across both Phase 6 and Phase 7 — diff the file's full history to confirm no member was narrowed or removed.
- `npm run typecheck` / `npm run build` / `npm test` all clean on the full range.
- Update `docs/typescript_migration.md`'s phase table: Phase 7 → **Done**, mirroring Phases 1-4/6's landed-note style.
