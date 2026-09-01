# TypeScript Migration Phase 5 (application-shell.mjs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `web/application-shell.mjs` (1,581 lines) to real, fully-typed TypeScript (`web/application-shell.mts`), matching the full-rigor standard from Phases 1, 2, 4, 6, and 7. This is the **last** of the seven CQ-1 modules to convert — after this phase, every producer module `app.js`/`nimbus-intelligence.js` bridges in via `window.__NIMBUS_*` is real, typed TypeScript.

**Architecture:** Single task (the file is comparable in size to Phase 4's single-task `schedule-data.mts` conversion at 1,735 lines). Six exports: `Settings`, `SessionUIAdapter`, `showLoginScreen`, `EmptyState`, `PlantSelector`, `App`.

**Prerequisite:** Must run *after* Phase 6 (`schedule-workbench.mjs`) and Phase 7 (`plant-and-administration.mjs`) both land — this file imports `Timeline, TimelineNav, DependencyOverlay, Table, Hierarchy, GanttFilter, Dashboard, AlertsUIAdapter` from `./schedule-workbench.mjs` and `AdminCockpit, Plant, ProdLines, LaborPlanning` from `./plant-and-administration.mjs` (lines 32-37). `allowJs: false` means this conversion cannot typecheck until both are real `.mts` siblings. Do not start this plan before Phase 7's final review is clean.

**Tech Stack:** `tsc` (existing `tsconfig.json`). Reuses `web/types/nimbus-global.d.mts` (Phase 6/7) — every real bare-`NIMBUS` reach this file makes is already declared there (verified below); this phase is expected to need zero shim additions, only one type refinement (see Task 1 Step 5).

## Global Constraints

- **Full rigor, no loose-typing exceptions.**
- **Zero behavior change.**
- **Per-module conversion ritual:**
  1. `git mv web/application-shell.mjs web/application-shell.mts`.
  2. `git rm --cached web/application-shell.mjs`, add the exact filename to `.gitignore`.
  3. Reuse existing `web/types.mts` domain types; add new ones only for genuinely new shapes.
  4. `tsconfig.json`'s glob covers it automatically.
  5. Import specifiers keep the `.mjs` suffix.
  6. `npm run typecheck && npm run build && npm test` clean before commit.
  7. Commit.
- **Verified: this file's every real (non-string) bare-`NIMBUS` reach is already in `web/types/nimbus-global.d.mts` from Phase 6/7** — `Timeline.rebuild`, `TimelineNav.render`, `Table._api`, `Inspector._currentId`/`._render`, `DarkMode.set`, `LangSwitcher.set`, `CommandPalette.close`, and a loose `Store` member. No new ambient members are needed; the one exception is a **refinement** (not a narrowing of relied-upon capability — see Task 1 Step 5): `NIMBUS.Store?.tasks?.[id]` (line ~290) is the only real use of the ambient `Store` member anywhere in the codebase, and it was declared as a placeholder `Store?: unknown` in Phase 6 Task 1 (speculative, no real caller existed yet at that point). Replacing `unknown` with a precise structural type for the one property this file actually reads is a legitimate tightening — going from a vague placeholder to a real type is not the "narrower than something already relied upon" case the additive-only rule guards against. Do this once, here.
- **T-1/T-2 traps apply** — do not promote any of the above to real imports; `App`/`EmptyState`/`PlantSelector` in this same file are what the OTHER converted files (workbench, plant-admin) reach via ambient `NIMBUS.App`/`.EmptyState` — this file is the one place those ambient ceilings terminate in a real, typed implementation, but the ambient declarations themselves stay as-is (workbench/plant-admin still can't import this file — it imports them, so the DAG direction is unchanged; only this file's own internal `NIMBUS.Timeline`/etc. reaches resolve against the shim).

## File Structure

- Modify: `web/application-shell.mjs` → renamed to `.mts`.
- Modify: `web/types/nimbus-global.d.mts` — one refinement (`Store` member), no new members.
- Modify: `.gitignore`.

---

### Task 1: Settings, SessionUIAdapter, showLoginScreen, EmptyState, PlantSelector, App

**Files:**
- Modify: `web/application-shell.mjs` (rename to `.mts`), entire file (1,581 lines): `Settings` at :72, `SessionUIAdapter` at :131, `showLoginScreen` at :826, `EmptyState` at :884, `PlantSelector` at :904, `App` at :1092
- Modify: `web/types/nimbus-global.d.mts` — refine the `Store` member
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `Config`, `Util`, `ErrorLog`, `Toast`, `Modal` from `./application-foundation.mjs`; `Store` from `./schedule-state.mjs`; `Alerts` from `./schedule-services.mjs`; `Persistence`, `Session` from `./schedule-data.mjs`; `Timeline`, `TimelineNav`, `DependencyOverlay`, `Table`, `Hierarchy`, `GanttFilter`, `Dashboard`, `AlertsUIAdapter` from `./schedule-workbench.mjs` (Phase 6); `AdminCockpit`, `Plant`, `ProdLines`, `LaborPlanning` from `./plant-and-administration.mjs` (Phase 7) — all now fully typed `.mts` modules. Domain types from `web/types.mts`: `NimbusTask`, `TopLevelTab`, `GanttSubTab`, `MasterSubTab`, `LaborSubTab`.
- Produces: `Settings`, `SessionUIAdapter`, `showLoginScreen`, `EmptyState`, `PlantSelector`, `App` typed exports — the final compatibility surface `app.js`'s `application-shell` bridge destructure consumes (per `CLAUDE.md`'s Architecture section on the seven `window.__NIMBUS_*` bridges).

- [ ] **Step 1: Rename and stop tracking the compiled output**

```bash
git mv web/application-shell.mjs web/application-shell.mts
git rm --cached web/application-shell.mjs 2>/dev/null || true
```

Add to `.gitignore`:

```
web/application-shell.mjs
```

- [ ] **Step 2: Type `Settings` (lines 72-107)**

Full-rigor typing for the per-user settings catalog. Define a `SettingsCatalogEntry` interface matching the documented shape (per this file's own header comment): `{ key: string; category: 'personalization' | 'workflow' | 'profile'; type: string; default: unknown; tier: 'user' | 'role' | 'system'; region: boolean }`. `CATALOG: SettingsCatalogEntry[]`, `DEFAULTS: Record<string, unknown>`, `isRegion(key: string): boolean`, `byCategory(cat: string): SettingsCatalogEntry[]`.

- [ ] **Step 3: Type `SessionUIAdapter` (lines 131-813)**

Full-rigor typing for the DOM/settings-pane remnant of the mandatory-login client session: gates (`_applyGates`), avatar rendering (`_initialsFor`, `_renderAvatar`), the User Settings modal (tab switching, Personalization/Workflow panes, Profile self-service via `PATCH /security/me`, password change via `PATCH /security/me/password`), and the searchable pinned-plant/pinned-line comboboxes (`_initPinnedCombo`). Use `Session`'s already-typed public API (`Session.pref`, `.setPref`, `.currentUser`, `.isAdmin`, `.signIn`, `.signOut`, `.updateCachedUser` — all typed in Phase 4) — do not add new `Session` methods as a side effect of this task. `saveProfile`/`changePassword` are `async` methods returning `Promise<void>`; type the two fetch response shapes (`PATCH /security/me` and `.../password`) as local interfaces if not already covered by Phase 4's local-interface precedent for non-`response_model=` endpoints.

- [ ] **Step 4: Type `showLoginScreen` (lines 826-877)**

Full-rigor typing for the mandatory full-screen login gate. `function showLoginScreen(): void` — builds DOM nodes directly (no template-string `innerHTML` beyond the card's own static markup), calls `Session.signIn(username: string, password: string): Promise<void>` (already typed in Phase 4) and `App._bootMain()`.

- [ ] **Step 5: Type `EmptyState` (lines 884-897) and refine the ambient `Store` member**

Type `EmptyState.render(container: HTMLElement | null, opts?: { title?: string; msg?: string; icon?: string }): void` — note this signature must exactly match what the ambient shim already declares for `NIMBUS.EmptyState.render` (Phase 6 Task 1) since other files call it through that ambient path; keep the two in sync.

Then, in `web/types/nimbus-global.d.mts`, refine the `Store` member from its Phase 6 placeholder `Store?: unknown;` to a precise type covering the one real use in this file (`_repaintDisplayFormat`, line ~290, `NIMBUS.Store?.tasks?.[id]`):

```typescript
Store?: {
  tasks?: Record<string, NimbusTask>;
};
```

This requires no new import in `nimbus-global.d.mts` — `NimbusTask` is already imported there from Phase 6 Task 1.

- [ ] **Step 6: Type `PlantSelector` (lines 904-1087)**

Full-rigor typing for the global searchable plant combobox: `_root`/`_input`/`_dropdown`/`_clearBtn`/`_combobox` as `HTMLElement | null` (matched to actual DOM query results), `_options`/`_filtered: string[]`, `_activeIdx: number`, `_open: boolean`. Uses `Store.knownPlants()`, `Store.selectedPlant`, `Store.setSelectedPlant(...)`, `Store.pref('pinnedPlants')` — all already typed in Phase 2.

- [ ] **Step 7: Type `App` (lines 1092-1579)**

Full-rigor typing for the bootstrap/tab-switching/side-panel module — the largest section of this file. Key surfaces:
- `_currentTab: TopLevelTab`, `_currentMasterSub: MasterSubTab`, `_ganttSub: GanttSubTab`, `_laborSub: LaborSubTab` (all four enums already defined in `web/types.mts`).
- `_pausables: Set<{ pause?(): void; resume?(): void }>` (per `registerPausable`'s duck-type check).
- `goto(tab: TopLevelTab): void`, `gotoGanttSub(sub: GanttSubTab): void`, `gotoMasterSub(sub: MasterSubTab): void`, `gotoLaborSub(sub: LaborSubTab): void`, `gotoGanttTimeline(): void` — note `goto`'s runtime accepts the legacy string `'table'` as well (redirects to `gantt`+`orders`), so its parameter type should be `TopLevelTab | 'table'`, not bare `TopLevelTab` (a real, intentional behavior — do not narrow it away).
- `init()` — the large boot-wiring method (i18n sweep, tab buttons, nav drawer, resize handles, `Store.subscribe(...)` autosave/dirty-tracking/alerts-sync listeners). Type each `Store.subscribe` callback's event parameter against `web/types.mts`'s `StoreEventType` union and the event-shape fields it actually reads (`evt.type`, `evt.source`, `evt.id`, `evt.ids`, `evt.plant`) — `Store`'s existing typed `subscribe` signature from Phase 2 governs the parameter shape; do not add a new overload.
- `_wireResize(side: 'left' | 'right', el: HTMLElement): void`.
- The four real `NIMBUS.*` reaches inside `_repaintDisplayFormat`/theme-change/language-change/`_openDrawer` handlers — all resolve against the existing (Step 5-refined) ambient shim.

- [ ] **Step 8: Typecheck, build, test**

```bash
npm run typecheck
npm run build
npm test
```

Expected: all three clean/green. This is the final module in the DAG — a clean `npm run build` here means all seven CQ-1 modules are now real, fully-typed TypeScript.

- [ ] **Step 9: Verify `scripts/check-static-assets.mjs` on the built tree**

```bash
npm run check:static-assets
```

Per T-12, this only gives a meaningful signal on a built tree (`npm test`'s `pretest` already built it in Step 8) — confirm it passes since this is the last file that import-closure walker needed to resolve.

- [ ] **Step 10: Commit**

```bash
git add web/application-shell.mts web/types/nimbus-global.d.mts .gitignore
git commit -m "typescript migration phase 5 task 1: convert application-shell.mjs to .mts (final CQ-1 module)"
```

---

## After Task 1: final whole-branch review

Per `superpowers:subagent-driven-development`, dispatch the final code reviewer on the full range (this task's BASE through HEAD) on the most capable available model. Confirm:
- Zero `any`/`unknown` outside documented exceptions.
- `npm run typecheck` / `npm run build` / `npm test` / `npm run check:static-assets` all clean.
- Update `docs/typescript_migration.md`'s phase table: Phase 5 → **Done**. Also add a closing note to the doc's top-level summary that **all 7 CQ-1 modules are now `.mts`** — Phase 8 (eliminating the `window.__NIMBUS_*` bridge and converting `app.js`/`nimbus-intelligence.js` to real ES modules) remains the only item left in the phase table, already marked "Deferred" and out of scope unless separately requested.
