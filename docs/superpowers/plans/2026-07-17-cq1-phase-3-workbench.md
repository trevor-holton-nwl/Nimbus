# CQ-1 Phase 3: Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `Timeline`, `Table`, `Inspector`, `Hierarchy`, `Dashboard`, `TimelineNav`, `GanttFilter`, `DependencyOverlay`, `ContextMenu`, `Interaction`, `OptimizeDialog`, `OptimizerPreview`, `EditCalendar`, `ColorWheelViewer`, and `Printer` — plus the Phase 1/2 DOM adapters `SandboxAdapter` and `AlertsUIAdapter`, whose coupling profile puts them here — into a real ES module `web/schedule-workbench.mjs`, without changing any planner behavior, and close the last five `Store._state`/`Store._rev` compatibility exceptions these modules carry.

**Architecture:** Bridged via `app-entry.mjs` exactly like Phases 1-2 — a fifth entry, `window.__NIMBUS_WORKBENCH`. Research against the current codebase (post Phase 2, `app.js` ≈ 16,000 lines) found four things the original design doc didn't anticipate:

1. **`UtilStrip` doesn't exist.** No module, function, or DOM id resembling it exists anywhere in the codebase — its intended function is already absorbed into `Dashboard`'s heatmap/line-status rendering and `TimelineNav`'s heat bands. This plan drops it from the ownership map rather than inventing new code to satisfy a design-doc name with no referent.
2. **Three destination questions the design doc leaves genuinely open**, resolved here by reading the actual coupling:
   - `CalendarUI` (the Phase 1 blackout-block-tab DOM remnant) has only one workbench consumer (`EditCalendar`, calling two trivial pure hour↔string helpers) and two plant-admin consumers (`Plant`, `ProdLines`) — it **stays in `app.js`** for a Phase 4 `plant-and-administration.mjs` destination; the two shared pure helpers move to `application-foundation.mjs`'s `Util` instead, so neither side needs a cross-module reach.
   - `AlertsUIAdapter` (the Phase 2 alerts-drawer DOM remnant) is **heavily and bidirectionally coupled** to `Timeline`, `Inspector`, `Table`, `Dashboard`, and `Interaction` — stronger coupling than `Sandbox` had before its explicitly-mandated Phase 3 move. This plan moves it into `schedule-workbench.mjs` alongside `SandboxAdapter` (whose move the design doc **does** explicitly mandate) as a reasoned extension of the same rationale, documented as a deliberate scope decision, not silent creep.
   - `SessionUIAdapter` (login gating, settings panes) has **zero** coupling to any workbench module and matches `application-shell.mjs`'s described "login gating" ownership far better — it **stays in `app.js`** for Phase 4.
3. **`Interaction` (1,122 lines, the densest module in the codebase) has zero existing test coverage** anywhere in the suite, and has **no teardown mechanism at all** — its `document`-level keydown/mousemove/mouseleave listeners are installed once at boot and never removed, tolerated today only because Gantt Timeline is documented as mount-once/show-hide (never actually unmounting). This phase adds real characterization tests before moving it, and adds an `uninstall()` teardown method as new, purely-additive, unwired-but-real machinery — satisfying the phase's own "verify lifecycle teardown" mandate without inventing an unmount trigger that doesn't otherwise exist yet.
4. **The phase's own explicit mandate — "migrate inline handlers to owned listeners as screens move"** — has one concrete instance: `Interaction._showMultiInspector`'s generated multi-select panel HTML contains three `onclick="NIMBUS.Interaction._bulkFix(...)"`/`NIMBUS.Selection.clear()"` inline strings. This phase converts them to real `addEventListener` wiring.

**Tech Stack:** Native browser ES modules, Node 20 built-in test runner, ESLint 9 (zero config changes needed, confirmed — same glob pattern as Phases 1-2, and `CDN_GLOBALS` already covers `vis`/`agGrid`/`Chart`).

## Global Constraints

- Preserve all current planner behavior. `Timeline`'s vis-timeline instance and `Table`'s AG Grid instance stay private to `schedule-workbench.mjs` (per the design's stable contract); nothing outside the module may reach `Timeline._tl`/`Table._api` once the move is complete except through public methods — this phase does not yet enforce that as encapsulation (see Task 8), it only relocates the code faithfully.
- **Line numbers cited below are absolute positions in `web/app.js` as of the start of this phase (last Phase 2 commit).** Every task after Task 1 deletes code, shifting everything below it. Locate blocks by comment banner or exact `const ModuleName = {` declaration and matching closing brace — never trust a later task's cited number as a literal offset at that point in execution.
- `NIMBUS` remains a bare script-scope `const`; `app.js`/`nimbus-intelligence.js` stay classic scripts this phase.
- Do not change any inline-onclick string that isn't explicitly named in this plan — the phase's "migrate inline handlers" mandate applies to the one concrete instance found (`Interaction._showMultiInspector`), not a blanket rewrite of every onclick in `index.html`/generated HTML.
- `Store._state`/`Store._rev` remain real properties (Phase 1). This phase closes exactly the 5 rows in `docs/architecture/cq1-compatibility-inventory.md` §6 tagged "Phase 3 (schedule-workbench.mjs)" (`Timeline`, `Hierarchy`, `Dashboard`, `GanttFilter`, `DependencyOverlay`). Do not touch `MasterData` (closes in a different Phase 3 target file, `plant-and-administration.mjs`, out of scope for this plan) or `App`/`nimbus-intelligence.js` (Phase 4).
- Regenerate `tests/contracts/cq1-legacy-surface.json` (`node scripts/legacy-surface.mjs --write`) in the same task that removes a tracked private-consumer entry — `GanttFilter`'s 8 private-consumer rows (all from `nimbus-intelligence.js`) close only when `GanttFilter` gets real public replacements for `_selectedLines`/`_refreshLineBtn`/`_buildLineDropdown`/`_active` (Task 3); do not force this closure prematurely in an earlier task.
- No new inline scripts, inline event-handler attributes, or inline style attributes beyond the one explicitly-authorized removal (`_showMultiInspector`'s three onclick strings shrink the allowlist; nothing grows it).
- `package.json`/`eslint.config.js` need zero changes — confirmed by inspection.

---

### Task 1: `schedule-workbench.mjs` — Timeline, TimelineNav, DependencyOverlay

**Files:**
- Create: `web/schedule-workbench.mjs` (exports `Timeline`, `TimelineNav`, `DependencyOverlay` for now)
- Create: `tests/modules/schedule-workbench.test.mjs`
- Modify: `web/app-entry.mjs` (bridge as `window.__NIMBUS_WORKBENCH`, extend post-boot cleanup)
- Modify: `web/app.js` (delete the three blocks; extend the bridge destructure; move `VL_HIER_LINE_H`/`VL_HIER_TASK_H` top-of-file consts along with `Hierarchy` in Task 3, not here — `Timeline`/`TimelineNav`/`DependencyOverlay` don't use them)
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (close the `Timeline`/`DependencyOverlay` §6 rows — `Hierarchy` closes in Task 3)

**Interfaces:**
- Produces: `Timeline.init()`, `.rebuild()`, `.redraw()`, `.focus(id)`, `.zoomToFit()`, `.gotoNow()`, `.gotoLineDay(line, day)`, `.scrollToLine(line)`, `.setView(mode)` — moved verbatim; `Timeline._tl`/`._items`/`._groups`/`._visItems`/`._suppressEvents`/`._colorIndex` stay real properties for now (not yet encapsulated — see Task 8).
- Produces: `TimelineNav.init()`, `.render()` — verbatim.
- Produces: `DependencyOverlay.init()`, `.highlightChain(id)` — verbatim, including its one `Store._state.dependencies` read (closed in Step 5).
- Consumes: `Store`, `Util`, `Config`, `PerfMonitor`, `ErrorLog` (Phase 1); `Utilization.computeMatrix/sev` (Phase 2, for `TimelineNav`'s heat bands).

- [ ] **Step 1: Write failing shape/behavior tests**

Create `tests/modules/schedule-workbench.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, TimelineNav, DependencyOverlay } from '../../web/schedule-workbench.mjs';
import { Store } from '../../web/schedule-state.mjs';

test('Timeline exposes the documented navigation API', () => {
  assert.equal(typeof Timeline.init, 'function');
  assert.equal(typeof Timeline.rebuild, 'function');
  assert.equal(typeof Timeline.focus, 'function');
  assert.equal(typeof Timeline.gotoLineDay, 'function');
});

test('DependencyOverlay.highlightChain reads Store dependencies without throwing when empty', () => {
  Store.setTasks([], 'unit-test');
  assert.doesNotThrow(() => DependencyOverlay.highlightChain('nonexistent'));
});
```

(Third-party `vis.Timeline`/canvas instantiation can't run under plain Node — these tests exercise only the parts reachable without a real DOM/vis-timeline; deeper behavior stays covered by the existing manual/browser verification this project has always relied on for Gantt rendering.)

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-workbench.test.mjs`

Expected: fails — `web/schedule-workbench.mjs` does not exist.

- [ ] **Step 3: Move the three modules verbatim**

Locate `const Timeline = {` (banner "TIMELINE", currently ~line 4154, closing ~4877), `const TimelineNav = {` (~7465–7660), `const DependencyOverlay = {` (~8063–8231). Move each verbatim into `web/schedule-workbench.mjs`:

```js
// schedule-workbench.mjs — CQ-1 schedule-workbench module.
// Owns the planner workspace: timeline, order grid, inspector, hierarchy,
// dashboard, navigation, filters, dependency overlay, context menu,
// interaction pipeline, and planner dialogs. Third-party instances
// (vis-timeline, AG Grid) stay private to this module. Also owns the
// SandboxAdapter/AlertsUIAdapter DOM remnants from Phase 1/2, whose coupling
// profile puts them here — see docs/architecture/cq1-compatibility-inventory.md.
import { Config, Util, PerfMonitor, ErrorLog, Toast, Modal } from './application-foundation.mjs';
import { Store, Selection, UndoStack, Sandbox } from './schedule-state.mjs';
import { Calendar, Alerts, Utilization, Engine } from './schedule-services.mjs';
import { Persistence, CalendarSync, Session } from './schedule-data.mjs';

export const Timeline = {
  // ... _tl, _items, _groups, _visItems, _suppressEvents, _colorIndex, init,
  // rebuild, redraw, focus, zoomToFit, gotoNow, gotoLineDay, scrollToLine,
  // setView — copied verbatim from the deleted app.js Timeline block, no
  // changes.
};

export const TimelineNav = {
  // ... _ctx, init, render — copied verbatim, no changes.
};

export const DependencyOverlay = {
  // ... init, highlightChain — copied verbatim, with one change: the direct
  // `Store._state.dependencies` read becomes `Store.dependencies` — add a
  // one-line public getter to schedule-state.mjs if none exists
  // (`get dependencies() { return this._state.dependencies; }`) rather than
  // reaching into `_state` (this is one of the 5 §6 exceptions this phase
  // closes — see Step 5).
};
```

(All four imports — `Calendar`/`Alerts`/`Utilization`/`Engine` and `Persistence`/`CalendarSync`/`Session` — aren't needed by these first three modules, but are added now since later tasks in this same file need them; unused-import lint would flag them prematurely, so only add what Step 3 actually uses, extending the import list task-by-task exactly like Phase 1/2's incremental same-file build-up.)

- [ ] **Step 4: Bridge `schedule-workbench.mjs`, extend the destructure**

`app-entry.mjs`: add `import * as workbench from './schedule-workbench.mjs';`, `win.__NIMBUS_WORKBENCH = workbench;`, and the matching `delete win.__NIMBUS_WORKBENCH;` in the cleanup block.

`app.js`:
```js
if (typeof window === 'undefined' || !window.__NIMBUS_FOUNDATION || !window.__NIMBUS_STATE || !window.__NIMBUS_SERVICES || !window.__NIMBUS_DATA || !window.__NIMBUS_WORKBENCH) {
  throw new Error('NIMBUS boot error: a required module bundle did not load before app.js — check app-entry.mjs.');
}
// ...
const { Timeline, TimelineNav, DependencyOverlay } = window.__NIMBUS_WORKBENCH;
```

- [ ] **Step 5: Add `Store.dependencies` getter, close the `Timeline`/`DependencyOverlay` §6 rows**

In `schedule-state.mjs`, add `get dependencies() { return this._state.dependencies; }` alongside the other public getters. Update `DependencyOverlay`'s one call site. Remove the `Timeline` and `DependencyOverlay` rows from the compatibility inventory's §6 table (`Timeline`'s row closes here even though `Hierarchy`/`Dashboard`/`GanttFilter` don't yet — do not wait for the whole phase).

- [ ] **Step 6: Update `load-legacy-app.mjs`, regenerate the contract, verify GREEN**

Add the same `sandbox.window.__NIMBUS_WORKBENCH = workbench;` bridging line as Phases 1-2's precedent. Run `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`.

- [ ] **Step 7: Commit**

```bash
git add web/schedule-workbench.mjs web/app-entry.mjs web/app.js web/schedule-state.mjs tests/modules/schedule-workbench.test.mjs tests/modules/helpers/load-legacy-app.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Timeline, TimelineNav, and DependencyOverlay into schedule-workbench.mjs"
```

---

### Task 2: Add Table, Inspector, ContextMenu

**Files:**
- Modify: `web/schedule-workbench.mjs`
- Modify: `web/app.js` (delete the three blocks; extend the destructure)
- Modify: `tests/modules/schedule-workbench.test.mjs`

**Interfaces:**
- Produces: `Table.init()`, `._api`, `._colApi` (stay real properties), `._openOverrideModalForId(id)`, `._getLineOptions()`, `._applyChipFilter(...)`, `._showAlertPopup(...)` (calls into `AlertsUIAdapter`, added Task 7 — until then this is a same-file forward reference within `app.js` since `AlertsUIAdapter` hasn't moved yet; verify this doesn't break by checking whether Table's own tests exercise the alert-popup path, and if so defer that specific test to Task 7).
- Produces: `Inspector.init()`, `.show(task)`, `.clear()`.
- Produces: `ContextMenu.init()`, `.open(...)`, `.openCanvas(...)`.

- [ ] **Step 1: Write failing tests**

Add to `tests/modules/schedule-workbench.test.mjs`:

```js
import { Table, Inspector, ContextMenu } from '../../web/schedule-workbench.mjs';

test('Table/Inspector/ContextMenu expose the documented public API', () => {
  assert.equal(typeof Table.init, 'function');
  assert.equal(typeof Inspector.show, 'function');
  assert.equal(typeof Inspector.clear, 'function');
  assert.equal(typeof ContextMenu.open, 'function');
});
```

- [ ] **Step 2: Verify RED, then move all three verbatim**

Locate `const Table = {` (~4883–6130), `const Inspector = {` (~6136–6374), `const ContextMenu = {` (~8236–8281). Move verbatim into `schedule-workbench.mjs`. `Table`'s call into `AlertsUIAdapter.focus`/`.showForCell` (via `_showAlertPopup`) stays exactly as written for now — `AlertsUIAdapter` is still in `app.js` until Task 7, so this is a genuine cross-file reference in the WRONG direction (schedule-workbench.mjs calling into app.js) that only resolves once Task 7 lands. Do not attempt to fix it in this task; note it in the compatibility inventory as a known-temporary same-phase forward dependency, resolved by Task 7.

- [ ] **Step 3: Extend the bridge destructure**

```js
const { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu } = window.__NIMBUS_WORKBENCH;
```

- [ ] **Step 4: Regenerate the contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

(Expect `npm test` to still pass even with the temporary `AlertsUIAdapter` forward reference, since nothing in the automated suite exercises the alert-popup click path — this is a real gap the plan accepts for one task's duration, closed by Task 7.)

- [ ] **Step 5: Commit**

```bash
git add web/schedule-workbench.mjs web/app.js tests/modules/schedule-workbench.test.mjs tests/contracts/cq1-legacy-surface.json
git commit -m "build: extract Table, Inspector, and ContextMenu into schedule-workbench.mjs"
```

---

### Task 3: Add Hierarchy and GanttFilter; Close Their Private-Consumer Debt

**Files:**
- Modify: `web/schedule-workbench.mjs`
- Modify: `web/app.js` (delete the two blocks + the `VL_HIER_LINE_H`/`VL_HIER_TASK_H` top-level consts, moving them into the new file; extend the destructure)
- Modify: `web/nimbus-intelligence.js` (replace the 4 `GanttFilter._*` private reaches with public equivalents)
- Modify: `tests/modules/schedule-workbench.test.mjs`
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (close `Hierarchy`'s §6 row; close all 8 `GanttFilter` §4.2 private-consumer rows)

**Interfaces:**
- Produces: `Hierarchy.init()`, `.render()`.
- Produces: `GanttFilter.init()`, `.selectedLines()` (new public getter replacing external `._selectedLines` reads), `.isolateLine(line)` / `.restoreAllLines()` (new public methods replacing `nimbus-intelligence.js`'s direct `._selectedLines.clear()`/`.add(line)` + `._refreshLineBtn()`/`._buildLineDropdown()` call sequence), `.activeFilter()` (new public getter replacing `._active` reads).

- [ ] **Step 1: Write failing tests**

Add to `tests/modules/schedule-workbench.test.mjs`:

```js
import { Hierarchy, GanttFilter } from '../../web/schedule-workbench.mjs';

test('Hierarchy exposes init/render', () => {
  assert.equal(typeof Hierarchy.init, 'function');
  assert.equal(typeof Hierarchy.render, 'function');
});

test('GanttFilter.selectedLines/isolateLine/restoreAllLines/activeFilter are the public replacement for the old private surface', () => {
  assert.equal(typeof GanttFilter.selectedLines, 'function');
  assert.equal(typeof GanttFilter.isolateLine, 'function');
  assert.equal(typeof GanttFilter.restoreAllLines, 'function');
  assert.equal(typeof GanttFilter.activeFilter, 'function');
  GanttFilter.isolateLine('L1');
  assert.ok(GanttFilter.selectedLines().has('L1'));
  GanttFilter.restoreAllLines();
  assert.equal(GanttFilter.selectedLines().size, 0);
});
```

- [ ] **Step 2: Verify RED, then move both modules**

Locate `const Hierarchy = {` (~6379–6540) and `const GanttFilter = {` (~7666–8056 — remember the module-scope `GanttFilter._apply = Util.debounce(...)` statement at the tail is part of the extraction range, not just the object literal). Move both verbatim, plus the top-level `VL_HIER_LINE_H`/`VL_HIER_TASK_H` consts (currently declared alongside `VL_LS_ROW_H`/`VL_ALERT_ROW_H` at app.js top — split them: the Hierarchy-only two travel with this move, `VL_LS_ROW_H` travels with `Dashboard` in Task 4, `VL_ALERT_ROW_H` stays in `app.js` with `AlertsUIAdapter` until Task 7 moves that too, at which point it travels there).

Add the four new public `GanttFilter` methods as thin wrappers around the existing private state (`_selectedLines`, `_active`, `_refreshLineBtn`, `_buildLineDropdown`):

```js
selectedLines() { return this._selectedLines; },
activeFilter() { return this._active; },
isolateLine(line) {
  this._selectedLines.clear();
  this._selectedLines.add(line);
  this._refreshLineBtn();
  this._buildLineDropdown();
},
restoreAllLines() {
  this._selectedLines.clear();
  this._refreshLineBtn();
  this._buildLineDropdown();
},
```

(Exact behavior match for the two `nimbus-intelligence.js` call sites this replaces — see Step 3.)

- [ ] **Step 3: Update `nimbus-intelligence.js`'s 4 private-consumer call sites**

Replace:
```js
NIMBUS.GanttFilter._selectedLines.clear();
NIMBUS.GanttFilter._selectedLines.add(line);
NIMBUS.GanttFilter._refreshLineBtn?.();
NIMBUS.GanttFilter._buildLineDropdown?.();
```
with:
```js
NIMBUS.GanttFilter.isolateLine(line);
```
Replace the three `NIMBUS.GanttFilter?._active?.color`/`?._active?.form`/`?._active?.text`/`?._selectedLines?.size > 0` reads with `NIMBUS.GanttFilter?.activeFilter()?.color`/`.form`/`.text` and `NIMBUS.GanttFilter?.selectedLines()?.size > 0`.

- [ ] **Step 4: Regenerate the contract — confirm all 8 `GanttFilter` private-consumer entries disappear**

Run: `node scripts/legacy-surface.mjs --write`

Expected diff: `privateConsumers` loses all 8 `GanttFilter._*` entries; `intelligenceCommands` gains `GanttFilter.selectedLines`/`.isolateLine`/`.restoreAllLines`/`.activeFilter`.

- [ ] **Step 5: Extend the bridge destructure, update the compatibility inventory**

```js
const { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter } = window.__NIMBUS_WORKBENCH;
```

Close `Hierarchy`'s §6 row and all 8 `GanttFilter` §4.2 rows in the compatibility inventory.

- [ ] **Step 6: Verify GREEN**

Run: `npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 7: Commit**

```bash
git add web/schedule-workbench.mjs web/app.js web/nimbus-intelligence.js tests/modules/schedule-workbench.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Hierarchy and GanttFilter into schedule-workbench.mjs, close GanttFilter private-consumer debt"
```

---

### Task 4: Add Dashboard

**Files:**
- Modify: `web/schedule-workbench.mjs`
- Modify: `web/app.js` (delete the block + move `VL_LS_ROW_H`; fix the stale "Chart.js" header comment; extend the destructure)
- Modify: `web/index.html` (remove the dead Chart.js `<script>` tag — confirm zero other consumers first)
- Modify: `tests/modules/schedule-workbench.test.mjs`
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (close `Dashboard`'s §6 row)

**Interfaces:**
- Produces: `Dashboard.init()`, `.render()`.

- [ ] **Step 1: Write a failing test, verify RED, move verbatim**

Add a shape test (`Dashboard.init`/`.render` are functions). Locate `const Dashboard = {` (~6545–7459, plus `VL_LS_ROW_H` from the top-level const group). Move verbatim.

- [ ] **Step 2: Confirm Chart.js is genuinely unused before removing it**

Run `grep -rn "Chart(" web/` and `grep -rn "Chart\\." web/app.js web/schedule-workbench.mjs` — confirm zero real instantiations anywhere (research already found none; re-verify against the current file, not the stale research snapshot, since Tasks 1-3 already changed line numbers). If confirmed unused, remove the `<script src=".../chart.js@4.4.4/...">` tag from `web/index.html` and correct `app.js`'s top-of-file module-map comment (still reads "Dashboard — home KPIs + Chart.js charts") to describe the real hand-rolled DOM/CSS heatmap implementation. If any live usage is found that the research missed, leave the script tag in place and document the actual usage instead — do not remove a dependency that's still load-bearing.

- [ ] **Step 3: Extend the bridge destructure, close the §6 row**

```js
const { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter, Dashboard } = window.__NIMBUS_WORKBENCH;
```

- [ ] **Step 4: Regenerate the contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 5: Commit**

```bash
git add web/schedule-workbench.mjs web/app.js web/index.html tests/modules/schedule-workbench.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Dashboard into schedule-workbench.mjs, remove the unused Chart.js dependency"
```

---

### Task 5: Add Interaction — New Characterization Tests, Inline-Handler Migration, and a Real Teardown Method

**Files:**
- Modify: `web/schedule-workbench.mjs`
- Modify: `web/app.js` (delete the block; extend the destructure)
- Modify: `tests/modules/schedule-workbench.test.mjs` (substantial new coverage — this module has zero prior tests anywhere)
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (document the new `Interaction.uninstall()` method and its current unwired status)

**Interfaces:**
- Produces: `Interaction.install()` (verbatim), `.uninstall()` (**new** — removes every listener `install()` attaches and cancels any in-flight RAF loop; purely additive, not called from anywhere yet since Gantt Timeline's documented lifecycle is mount-once/show-hide with no unmount trigger today).
- Produces: `Interaction._bulkFix(fixed)`/`._unscheduleSelected()` stay as-is (still called via real event listeners now, not inline strings — see Step 3).

- [ ] **Step 1: Write failing characterization tests — this module has none today**

Add to `tests/modules/schedule-workbench.test.mjs`:

```js
import { Interaction } from '../../web/schedule-workbench.mjs';

test('Interaction exposes install/uninstall', () => {
  assert.equal(typeof Interaction.install, 'function');
  assert.equal(typeof Interaction.uninstall, 'function');
});

test('Interaction.install is idempotent — a second call does not double-attach listeners', () => {
  // ... using a harness-provided document stub that counts addEventListener
  // calls by (type, phase), call Interaction.install() twice, assert the
  // document-level keydown/mousemove/mouseleave listener count after the
  // second call equals the count after the first.
});

test('Interaction.uninstall removes every listener install() attached', () => {
  // ... call install(), snapshot the stub document's registered-listener
  // count, call uninstall(), assert the count returns to its pre-install
  // baseline (0 Interaction-attached listeners remain).
});

test('Interaction._onDataSetUpdate reverts a drag on a fixed task (noActualChange guard)', () => {
  // Seed a fixed task, simulate the vis DataSet 'update' callback with a
  // changed start_date, assert Store.tasks[id].start_date is unchanged
  // (the drag was reverted, not committed) — this is the single most
  // safety-critical behavior in this module and had zero coverage before
  // this task.
});
```

Use the existing `tests/modules/helpers/load-legacy-app.mjs` VM harness (not a plain ESM import) for the deeper behavioral tests, since `Interaction` needs a realistic `document`/`Timeline._tl`/`Table._api` stub environment that the harness already provides — plain `import` from `schedule-workbench.mjs` only works for the shape-level tests above the harness-dependent ones. Extend `load-legacy-app.mjs`'s bridge to include `window.__NIMBUS_WORKBENCH` (mirroring the Task 1 pattern) so the VM-executed `app.js` can destructure `Interaction` from it.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-workbench.test.mjs`

Expected: fails — `Interaction` isn't exported yet, and the harness doesn't bridge workbench yet.

- [ ] **Step 3: Move `Interaction`, migrate the 3 inline handlers, add `uninstall()`**

Locate `const Interaction = {` (~8833–9954). Move verbatim, with these two additions:

Replace `_showMultiInspector`'s generated HTML (currently embedding `onclick="NIMBUS.Interaction._bulkFix(true)"` / `(false)` / `NIMBUS.Selection.clear()`) with plain elements plus real listeners wired right after the HTML is inserted into the DOM:

```js
_showMultiInspector() {
  // ... build the panel HTML WITHOUT the three onclick attributes, using
  // data-action="fix"/"unfix"/"clear" attributes instead, or bare ids ...
  const panel = /* the inserted element */;
  panel.querySelector('[data-action="fix"]')?.addEventListener('click', () => Interaction._bulkFix(true));
  panel.querySelector('[data-action="unfix"]')?.addEventListener('click', () => Interaction._bulkFix(false));
  panel.querySelector('[data-action="clear"]')?.addEventListener('click', () => Selection.clear());
},
```

Add a new `uninstall()` method that reverses everything `install()` does — every `document.addEventListener` call in `install()`/`_installHoverPreview()`/`_installMarquee()` needs a stored reference and a matching `removeEventListener` here, plus cancellation of any live `requestAnimationFrame` handle (`_marqueeRAF`, `_edgeScrollRAF`) and a reset of `_installed = false`:

```js
uninstall() {
  if (!this._installed) return;
  document.removeEventListener('keydown', this._onKeyDownBound);
  document.removeEventListener('keydown', this._hoverDismissBound);
  document.removeEventListener('mousemove', this._edgeScrollTrackBound);
  document.removeEventListener('mouseleave', this._hideTooltipBound);
  if (this._marqueeRAF) { cancelAnimationFrame(this._marqueeRAF); this._marqueeRAF = null; }
  if (this._edgeScrollRAF) { cancelAnimationFrame(this._edgeScrollRAF); this._edgeScrollRAF = null; }
  this._installed = false;
},
```

(This requires `install()`'s existing anonymous arrow-function listeners to become named, stored bound references — e.g. `this._onKeyDownBound = e => this._onKeyDown(e); document.addEventListener('keydown', this._onKeyDownBound);` — a small, mechanical refactor of `install()` itself, not a behavior change, needed so `uninstall()` has something concrete to remove. Read the actual current listener-attachment code before writing this — there may be more than the four listeners identified by research; account for every one found.)

`uninstall()` is not called from anywhere in `app.js` this task — it exists as new, tested, correct-but-dormant machinery, satisfying the phase's "verify lifecycle teardown" mandate without inventing an unmount trigger the Gantt Timeline screen doesn't otherwise have (its lifecycle stays mount-once/show-hide per the compatibility inventory's §2 table, untouched this phase).

- [ ] **Step 4: Extend the bridge destructure**

```js
const { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter, Dashboard, Interaction } = window.__NIMBUS_WORKBENCH;
```

- [ ] **Step 5: Regenerate the contract — confirm the 3 inline-handler entries disappear**

Run: `node scripts/legacy-surface.mjs --write`

Expected diff: `inlineHandlers` loses the 3 `NIMBUS.Interaction._bulkFix`/`NIMBUS.Selection.clear` entries generated from `_showMultiInspector`'s old HTML string (these were tracked as `app.js`-sourced inline handlers even though they were generated at runtime, not static markup — confirm the scanner actually caught them before assuming this diff; if it didn't, note why in the compatibility inventory rather than silently skip the check).

- [ ] **Step 6: Verify GREEN**

Run: `npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 7: Update the compatibility inventory**

Document `Interaction.uninstall()`'s existence and dormant status in a new note, and add an `Interaction` row to §2's lifecycle table clarifying it shares Gantt Timeline's mount-once/show-hide lifecycle (it has no independent lifecycle of its own — it's the input layer for that one screen).

- [ ] **Step 8: Commit**

```bash
git add web/schedule-workbench.mjs web/app.js tests/modules/schedule-workbench.test.mjs tests/modules/helpers/load-legacy-app.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Interaction into schedule-workbench.mjs, add characterization tests and a teardown method"
```

---

### Task 6: Add OptimizeDialog and OptimizerPreview

**Files:**
- Modify: `web/schedule-workbench.mjs`
- Modify: `web/app.js` (delete both blocks; extend the destructure)
- Modify: `tests/modules/schedule-workbench.test.mjs`

**Interfaces:**
- Produces: `OptimizeDialog.open()`, `.run()` — moved verbatim (IIFE, closure-private flatpickr instances preserved as-is).
- Produces: `OptimizerPreview.showLoading()`, `.runWithPreview(mode, opts)`, `.hideLoading()` — moved verbatim, including the `_installAbandonGuard()` `MutationObserver` and the optional-chained `NIMBUS.Confidence?.snapshot()/.restore()` cross-file call (stays exactly as-is — `Confidence` lives entirely in `nimbus-intelligence.js`, out of scope for CQ-1's module bridges, unaffected by which file `OptimizerPreview` lives in).

- [ ] **Step 1: Write a failing test, verify RED, move both verbatim**

Add a shape test (`.open`/`.run`/`.runWithPreview` are functions). Locate `const OptimizeDialog = (() => { ... })();` (~2877–3417) and `const OptimizerPreview = { ... };` (~8288–8683). Move both verbatim into `schedule-workbench.mjs`.

- [ ] **Step 2: Extend the bridge destructure, verify GREEN**

```js
const { ..., OptimizeDialog, OptimizerPreview } = window.__NIMBUS_WORKBENCH;
```

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 3: Commit**

```bash
git add web/schedule-workbench.mjs web/app.js tests/modules/schedule-workbench.test.mjs tests/contracts/cq1-legacy-surface.json
git commit -m "build: extract OptimizeDialog and OptimizerPreview into schedule-workbench.mjs"
```

---

### Task 7: Add EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, and AlertsUIAdapter; Share the Hour-Conversion Helpers

**Files:**
- Modify: `web/schedule-workbench.mjs`
- Modify: `web/application-foundation.mjs` (add `Util.hoursToTimeString`/`Util.timeStringToHours`)
- Modify: `web/app.js` (delete all five blocks; update `CalendarUI`'s two internal call sites to use the shared `Util` helpers instead of its own `_hToT`/`_tToH`; extend the destructure; fix `Table`'s temporary Task-2 forward reference to `AlertsUIAdapter`, now resolved since both are in the same file)
- Modify: `tests/modules/schedule-workbench.test.mjs`
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (add `SandboxAdapter`/`AlertsUIAdapter` rows documenting their move and the reasoning; confirm `CalendarUI`/`SessionUIAdapter` rows explicitly note they stay in `app.js` for Phase 4)

**Interfaces:**
- Produces (application-foundation.mjs): `Util.hoursToTimeString(h)`, `Util.timeStringToHours(t)` — the two pure conversions previously duplicated as `CalendarUI._hToT`/`_tToH`.
- Produces (schedule-workbench.mjs): `EditCalendar.open(line)`, `.openPlant(name)`; `ColorWheelViewer.open(plant)`; `Printer.open()`; `SandboxAdapter.init()`, `.enter()`; `AlertsUIAdapter.focus(id)`, `.showForCell(line, dayKey)`, `.toggleDrawer()`, `.renderBell()`, `.renderDrawer()` — all moved verbatim from `app.js`.

- [ ] **Step 1: Add the shared hour-conversion helpers to `application-foundation.mjs`**

```js
hoursToTimeString(h) {
  // ... body identical to CalendarUI's current _hToT(h), copied verbatim.
},
timeStringToHours(t) {
  // ... body identical to CalendarUI's current _tToH(t), copied verbatim.
},
```

Update `CalendarUI`'s own internal call sites (its `render()`/`openBlockModal()`/`saveBlockFromModal()` methods, wherever they currently call `this._hToT`/`this._tToH` or `CalendarUI._hToT`/`_tToH`) to call `Util.hoursToTimeString`/`Util.timeStringToHours` instead, then delete `CalendarUI._hToT`/`_tToH` entirely (they have no other callers per the Phase-3 research — confirm this is still true against the current file before deleting, since Tasks 1-6 may have shifted things but shouldn't have touched `CalendarUI`).

- [ ] **Step 2: Write failing tests, verify RED**

Add to `tests/modules/schedule-workbench.test.mjs` (and a companion test in `tests/modules/foundation.test.mjs` for the new `Util` methods):

```js
import { EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, AlertsUIAdapter } from '../../web/schedule-workbench.mjs';

test('EditCalendar/ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter expose their documented public API', () => {
  assert.equal(typeof EditCalendar.open, 'function');
  assert.equal(typeof ColorWheelViewer.open, 'function');
  assert.equal(typeof Printer.open, 'function');
  assert.equal(typeof SandboxAdapter.init, 'function');
  assert.equal(typeof AlertsUIAdapter.toggleDrawer, 'function');
});
```

Add to `tests/modules/foundation.test.mjs`:

```js
test('Util.hoursToTimeString/timeStringToHours round-trip', () => {
  assert.equal(Util.hoursToTimeString(13.5), '13:30');
  assert.equal(Util.timeStringToHours('13:30'), 13.5);
});
```

- [ ] **Step 3: Move all five modules verbatim**

Locate `const EditCalendar = (() => { ... })();` (~2147–2354), `const ColorWheelViewer = { ... };` (~2360–2520), `const Printer = { ... };` (~12226–12375, line numbers will have shifted substantially by this point in execution — locate by banner comment), `const SandboxAdapter = { ... };` (the Phase 1-created adapter, banner comment references `Sandbox.enter()`/`SandboxAdapter`), `const AlertsUIAdapter = { ... };` (the Phase 2-created adapter). Move all five verbatim into `schedule-workbench.mjs`, including `AlertsUIAdapter`'s `VL_ALERT_ROW_H` top-level const (finally traveling with it now).

`Table`'s `_showAlertPopup` call into `AlertsUIAdapter` (a temporary same-phase forward reference accepted in Task 2) now resolves as a normal same-module reference — no code change needed there, just confirm via the full test run that nothing broke.

Update `index.html`'s one `onclick="NIMBUS.Sandbox.enter()"`-turned-`NIMBUS.SandboxAdapter.enter()"` and `NIMBUS.AlertsUIAdapter.toggleDrawer()` inline handlers — these already point at the right names from Phase 1/2 and need no further edits, just confirm they still resolve (the `NIMBUS` return object in `app.js` must keep re-exporting `SandboxAdapter`/`AlertsUIAdapter` under those names — it already does from Phase 1/2, no change needed).

- [ ] **Step 4: Extend the bridge destructure**

```js
const { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter, Dashboard, Interaction, OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, AlertsUIAdapter } = window.__NIMBUS_WORKBENCH;
```

- [ ] **Step 5: Update the compatibility inventory**

Add `SandboxAdapter`/`AlertsUIAdapter` rows to §1 documenting the move and, for `AlertsUIAdapter`, the reasoning (coupling evidence, not an explicit design-doc mandate — a deliberate, documented scope decision). Add explicit notes to `CalendarUI`'s and `SessionUIAdapter`'s existing status paragraphs confirming they stay in `app.js`, targeting `plant-and-administration.mjs`/`application-shell.mjs` respectively in Phase 4, with the reasoning from this plan's Architecture section.

- [ ] **Step 6: Regenerate the contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 7: Commit**

```bash
git add web/schedule-workbench.mjs web/application-foundation.mjs web/app.js tests/modules/schedule-workbench.test.mjs tests/modules/foundation.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, and AlertsUIAdapter into schedule-workbench.mjs"
```

---

### Task 8: Phase 3 Completion — Documentation and Full Gate

**Files:**
- Modify: `docs/architecture/cq1-compatibility-inventory.md`
- Modify: `tests/README.md`, `AGENTS.md`, `CLAUDE.md`

- [ ] **Step 1: Update the compatibility inventory**

Add a "Phase 3 status (complete)" note mirroring Phases 1-2. Confirm §6 now lists only `App` and `nimbus-intelligence.js` (Phase 4) — every other row closed across Phases 1-3. Add §2 lifecycle-table rows for any of the 16 modules that warrant one beyond the existing Gantt Timeline/Orders Table/Dashboard rows, per what Task 5 already started for `Interaction`.

- [ ] **Step 2: Update `tests/README.md`, `AGENTS.md`, `CLAUDE.md`**

Mirror the Phase 1/2 Task-6-equivalent pattern: one bullet for the new test file, one paragraph per doc describing `schedule-workbench.mjs`'s scope and the `AlertsUIAdapter`/`SandboxAdapter` relocation (and that `CalendarUI`/`SessionUIAdapter` remain deliberately in `app.js`).

- [ ] **Step 3: Run the full Phase 3 completion gate**

- [ ] `git diff --check`
- [ ] `npm run lint:ci`
- [ ] `npm test`
- [ ] `npm run check:legacy-surface`
- [ ] `npm run check:static-assets`
- [ ] Offline pytest regression check
- [ ] Grep `web/app.js` for all 16 old module declarations plus `SandboxAdapter`/`AlertsUIAdapter` — expect zero matches; confirm `CalendarUI`/`SessionUIAdapter` still DO exist there (deliberately not moved)
- [ ] Confirm the compatibility inventory §6 table has only the 2 Phase 4 rows left
- [ ] Docker/browser boot smoke test if available; record as an unverified environment gate if not

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/cq1-compatibility-inventory.md tests/README.md AGENTS.md CLAUDE.md
git commit -m "docs: close out CQ-1 Phase 3 workbench migration"
```

---

## Phase 3 Completion Gate

- [x] All 8 tasks committed.
- [x] Full verification suite green (re-run and confirmed during the post-hoc review that closed the findings below; see that review's commit for the exact command output).
- [x] `web/app.js` no longer contains its own definitions of the 15 real workbench modules (`UtilStrip` never existed), `SandboxAdapter`, or `AlertsUIAdapter` — all live only in `schedule-workbench.mjs`. `CalendarUI` and `SessionUIAdapter` remain in `app.js`, deliberately, for Phase 4.
- [x] **Corrected, not as originally worded:** re-verifying against the actual scanner/source (not this bullet's original claim) found only **4 of `GanttFilter`'s 8** private-consumer rows close this phase (`_active`, `_selectedLines`, `_refreshLineBtn`, `_buildLineDropdown`) — the other 4 (`_toggleLineDropdown`/`_toggleColorDropdown`/`_toggleFormDropdown`/`_togglePoMatDropdown`) are reached only from `index.html`'s inline `onclick` attributes, out of this phase's Global Constraints, and stay open deliberately. `Interaction`'s inline-handler count was also undercounted here: it was **4** call sites (`_bulkFix(true)`, `_bulkFix(false)`, `Selection.clear()`, and a fourth, `_unscheduleSelected()`, missed by this bullet's original prose but implied by this plan's own Interfaces line), not 3 — all 4 are closed. See `docs/architecture/cq1-compatibility-inventory.md` §4.2 and its `Interaction`-moved note for the full rationale.
- [x] `Interaction.uninstall()` exists, is tested, and is documented as intentionally unwired pending a real unmount trigger.
- [x] **Corrected, not as originally worded:** compatibility inventory §6 has **3** rows left, not 2 — `App` and `nimbus-intelligence.js` (both genuinely Phase 4), plus `MasterData`, whose row this plan's own Global Constraints explicitly placed out of scope (closes in the separate `plant-and-administration.mjs` migration). The inventory's own "note on §6's row count" documents this; this bullet's original "exactly 2" wording was wrong the day it was written, not a regression.
- [x] **Not run — recorded as an unverified environment gate, not a pass.** No Docker/browser environment was available during this phase's execution sessions, and nothing in the diff (this file, the compatibility inventory, `tests/README.md`, `AGENTS.md`, `CLAUDE.md`) recorded that fact until this retroactive note — the original gate was silently left unchecked with no explanation. This matters because this phase's core new cross-file pattern — dozens of `schedule-workbench.mjs` call sites resolving the bare `NIMBUS` identifier (a classic-script top-level `const` in `app.js`) — is exercised only by the Node VM-sandboxed test harness (`tests/modules/helpers/load-legacy-app.mjs`), which by its own header comment cannot populate a real `NIMBUS` global and therefore cannot validate these call sites. `npm test` passing green does not substitute for this gate; a real-browser smoke test of the Gantt Timeline (empty-state render, a dashboard drill-down click, a `GanttFilter` line-isolate double-click) remains outstanding and should run before/during Phase 4.
- [ ] Review the complete Phase 3 diff for security, behavior drift, and accidental scope creep before writing the Phase 4 extraction plan (shell + administration: `App`, `PlantSelector`, `WelcomeSplash`, `EmptyState`, `Plant`, `ProdLines`, `MasterData`, `LaborPlanning`, `Interface`, `Security`, `AdminCockpit`, `BomItems`, plus `CalendarUI`/`SessionUIAdapter` finally landing in `plant-and-administration.mjs`/`application-shell.mjs`, plus converting `nimbus-intelligence.js`'s monkey-patches — `UndoStack.push`, `Alerts.recompute` — to events, plus removing the legacy boot path entirely).
</content>
