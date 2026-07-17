# CQ-1 Phase 4: Shell and Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the last 14 modules out of `app.js` into two final ES modules — `web/plant-and-administration.mjs` (`CalendarUI`, `Plant`, `ProdLines`, `MasterData`, `LaborPlanning`, `Interface`, `Security`, `AdminCockpit`) and `web/application-shell.mjs` (`SessionUIAdapter`, `showLoginScreen`, `PlantSelector`, `WelcomeSplash`, `EmptyState`, `App`) — convert `nimbus-intelligence.js`'s two remaining runtime monkey-patches to Store events, close the last three compatibility-inventory exceptions, and reduce `app.js` to the documented small launcher the design calls for (bridge wiring + boot orchestration only — it cannot disappear entirely while `nimbus-intelligence.js` still needs classic-script shared lexical scope, a constraint this phase makes explicit rather than working around).

**Architecture:** Bridged via `app-entry.mjs` exactly like Phases 1-3 — a sixth and seventh entry, `window.__NIMBUS_PLANT_ADMIN` and `window.__NIMBUS_SHELL`. Research against the current codebase (post Phase 3, `app.js` ≈ 8,868 lines) found:

1. **There is no separate `BomItems` module.** Bill-of-Materials handling is a set of private helper functions inside `MasterData` (the `bom_items` table gate, upload, and component-picker logic). It moves as part of `MasterData`, not as its own extraction.
2. **Two genuine bidirectional seams** between the two target files, both resolved here rather than carried forward as permanent cross-file coupling:
   - `Plant.gotoTab('settings')` calls `App._renderSettingsPane()` — but that method's entire body (per-plant scheduling-constraint list, color-wheel enable toggle) is plant-administration content that only ever renders into Plant's own `#plant-tab-settings` DOM and is only ever triggered from Plant. This phase relocates `_renderSettingsPane` bodily into `Plant` itself, eliminating the seam rather than papering over it with an injected callback.
   - `Plant`/`LaborPlanning` read `App._currentTab`/`_currentMasterSub`/`_laborSub` to decide whether to re-render on a background data change. This is a legitimate one-directional read (plant-admin asking the shell "am I currently visible?") — resolved with a small injected getter, `App.setActiveTabResolvers(...)`, the same pattern as every other cross-phase seam in this migration.
   - The *other* direction — `application-shell.mjs`'s boot sequence (`_bootMain`) calling `AdminCockpit.init()`/`LaborPlanning.init()`/`Plant.init()`/`Plant.render()`/`ProdLines.render()` — is expected, one-directional boot orchestration (shell imports plant-admin to start it), not a coupling problem.
3. **`nimbus-intelligence.js` cannot become a real ES module this phase.** It accesses `NIMBUS` as a bare identifier relying on classic-script shared lexical scope (confirmed by direct inspection, unchanged since Phase 1's research) — converting it to `type="module"` would sever that, and full ESM conversion is out of scope for a phase whose stated job is the shell/administration split, not an intelligence-layer rewrite. This phase does the two things the design doc actually asks for — converting the two monkey-patches to events — without attempting the module-format change.
4. **`app.js` cannot be deleted outright while (3) holds.** Something must remain a classic script defining `const NIMBUS = {...}` for `nimbus-intelligence.js` to see. This phase makes `app.js` *be* that documented small launcher explicitly — after this phase it contains only the bridge gate/destructure, the DI-seam wiring, `_bootMain`'s orchestration sequence, and the final namespace `return {...}` — no module bodies of its own.
5. **123 inline event-handler attributes exist in `index.html` today**, only 4 of which (`GanttFilter._toggle*Dropdown`) are currently tracked as deferred debt. Converting all 123 in one task would be the single riskiest, least-tested change of the entire migration — this phase does not attempt that. Instead, each task below converts the onclick= handlers that call **that task's own moved modules** (the same incremental, low-risk pattern Phase 3 used for `Interaction._showMultiInspector`), and Task 6 quantifies and documents the remainder as an explicit, tracked backlog rather than silently declaring the job done.

**Tech Stack:** Native browser ES modules, Node 20 built-in test runner, ESLint 9 (zero config changes needed — confirmed, same pattern as Phases 1-3).

## Global Constraints

- Preserve all current behavior. `NIMBUS` remains a bare script-scope `const` in `app.js`; `nimbus-intelligence.js` stays a classic script this phase (see Architecture point 3).
- **Line numbers cited below are absolute positions in `web/app.js` as of the start of this phase (last Phase 3 commit).** Every task after Task 1 deletes code, shifting everything below it. Locate blocks by comment banner or exact `const ModuleName = {` declaration and matching closing brace — never trust a later task's cited number as a literal offset at that point in execution.
- Do not attempt to convert all 123 inline handlers in `index.html` in one pass. Convert only the ones calling a module this phase actually moves, as part of that module's own task. Document the remaining count precisely in Task 6 — a smaller, accurate backlog is the honest deliverable, not a false "done."
- `Store._state`/`Store._rev` remain real properties. This phase closes the final 3 rows in `docs/architecture/cq1-compatibility-inventory.md` §6 (`MasterData`, `App`, `nimbus-intelligence.js`) — after Task 6, that table should be empty.
- Regenerate `tests/contracts/cq1-legacy-surface.json` in the same task that removes a tracked entry.
- No new inline scripts, inline event-handler attributes, or inline style attributes — only removals authorized by this plan.
- `package.json`/`eslint.config.js` need zero changes — confirmed by inspection.
- This phase is the last one for CQ-1. Task 7's completion gate is also the whole-migration completion gate — verify against the design doc's own final "Verification and completion" criteria, not just this phase's local scope.

---

### Task 1: `plant-and-administration.mjs` — CalendarUI, Plant, ProdLines

**Files:**
- Create: `web/plant-and-administration.mjs`
- Create: `tests/modules/plant-and-administration.test.mjs`
- Modify: `web/app-entry.mjs` (bridge as `window.__NIMBUS_PLANT_ADMIN`, extend cleanup)
- Modify: `web/app.js` (delete the three blocks; extend the bridge destructure)
- Modify: `web/index.html` (convert `CalendarUI`/`Plant`/`ProdLines`-targeting onclick= handlers found during this task to real listeners, following the Phase 3 `Interaction._showMultiInspector` precedent)
- Modify: `docs/architecture/cq1-compatibility-inventory.md`

**Interfaces:**
- Produces: `CalendarUI.render()`, `.openBlockModal()`, `.saveBlockFromModal()`, `.removeBlock(id)` (note: research found this modal has no live opener anywhere — confirm that's still true against current code, and if so, leave it as-is; do not delete apparently-dead code that isn't this task's job to clean up, just don't be surprised it's unreachable).
- Produces: `Plant.init()`, `.render()`, `.gotoTab(tab)` (its call into `App._renderSettingsPane()` is removed here — see Step 3).
- Produces: `ProdLines.render()` (no `.init()` — renders on-demand, unchanged).

- [ ] **Step 1: Write failing shape tests**

Create `tests/modules/plant-and-administration.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarUI, Plant, ProdLines } from '../../web/plant-and-administration.mjs';

test('CalendarUI/Plant/ProdLines expose their documented public API', () => {
  assert.equal(typeof CalendarUI.render, 'function');
  assert.equal(typeof Plant.init, 'function');
  assert.equal(typeof Plant.gotoTab, 'function');
  assert.equal(typeof ProdLines.render, 'function');
});
```

- [ ] **Step 2: Verify RED, then move all three verbatim**

Locate `const CalendarUI = {` (~289–472), `const Plant = {` (~477–1014), `const ProdLines = {` (~1020–1330). Move all three verbatim into `web/plant-and-administration.mjs`:

```js
// plant-and-administration.mjs — CQ-1 plant-and-administration module.
// Owns Plant, production lines, labor planning, Master Data, Bill of
// Materials, SAP Interface, Security, Admin Cockpit, color-wheel
// administration, and plant/line calendar management. Owns no planner
// timeline or application-wide navigation — see application-shell.mjs.
import { Config, Util, PerfMonitor, ErrorLog, Toast, Modal } from './application-foundation.mjs';
import { Store, Selection, UndoStack } from './schedule-state.mjs';
import { Calendar, Engine } from './schedule-services.mjs';
import { Persistence, CalendarSync, Session } from './schedule-data.mjs';
import { Hierarchy } from './schedule-workbench.mjs';

let _activeTabResolvers = { currentTab: () => null, currentMasterSub: () => null, laborSub: () => null };

export function setActiveTabResolvers(resolvers) {
  _activeTabResolvers = { ..._activeTabResolvers, ...resolvers };
}

export const CalendarUI = {
  // ... render, openBlockModal, saveBlockFromModal, removeBlock, filter
  // dropdown state, _getLines — copied verbatim, no changes.
};

export const Plant = {
  // ... copied verbatim, EXCEPT: (a) its Store-subscribe callback's read of
  // `App._currentTab`/`_currentMasterSub` (line ~488-489) becomes
  // `_activeTabResolvers.currentTab()`/`.currentMasterSub()`; (b)
  // `gotoTab('settings')`'s call to `App._renderSettingsPane()` is replaced
  // by calling `this._renderSettingsPane()` directly (the method itself
  // moves here in Step 3).
};

export const ProdLines = {
  // ... copied verbatim, no changes (no App references found).
};
```

- [ ] **Step 3: Relocate `App._renderSettingsPane` into `Plant`, eliminating the seam**

`App._renderSettingsPane()` (currently ~app.js:5920–6137, still in `app.js` until Task 4 moves the rest of `App`) is per-plant scheduling-constraint UI that only ever renders into `Plant`'s own `#plant-tab-settings` DOM and is only ever called from `Plant.gotoTab('settings')`. Move its body into `Plant` as a new method `Plant._renderSettingsPane()` now, in this task — even though the REST of `App` doesn't move until Task 4 — since this eliminates seam #2 identified in research (Plant → App → back into Plant's own DOM) rather than carrying it forward as a temporary cross-file call for 3 more tasks. Update `Plant.gotoTab`'s call site accordingly. Leave a one-line stub/comment at `App`'s old call site in `app.js` noting the relocation, removed entirely when Task 4 deletes the rest of `App`.

- [ ] **Step 4: Wire `setActiveTabResolvers` in `app.js` boot glue**

```js
PlantAdmin.setActiveTabResolvers({
  currentTab: () => App._currentTab,
  currentMasterSub: () => App._currentMasterSub,
  laborSub: () => App._laborSub,
});
```

(Wired once, immediately after the Task 1 bridge destructure — `App` is still a local `app.js` const at this point, resolved lazily at call time same as every other seam in this migration.)

- [ ] **Step 5: Bridge, extend the destructure, verify GREEN**

`app-entry.mjs`: add `import * as plantAdmin from './plant-and-administration.mjs';`, `win.__NIMBUS_PLANT_ADMIN = plantAdmin;`, matching delete in cleanup.

`app.js`:
```js
const { CalendarUI, Plant, ProdLines } = window.__NIMBUS_PLANT_ADMIN;
```

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 6: Commit**

```bash
git add web/plant-and-administration.mjs web/app-entry.mjs web/app.js web/index.html tests/modules/plant-and-administration.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract CalendarUI, Plant, and ProdLines into plant-and-administration.mjs, eliminate the App._renderSettingsPane seam"
```

---

### Task 2: Add MasterData and LaborPlanning; Close the `MasterData` §6 Row

**Files:**
- Modify: `web/plant-and-administration.mjs`
- Modify: `web/app.js` (delete both blocks; extend the destructure)
- Modify: `tests/modules/plant-and-administration.test.mjs`
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (close `MasterData`'s §6 row)

**Interfaces:**
- Produces: `MasterData.render()`, `.syncLineSettings(...)` — moved verbatim (its Bill-of-Materials logic travels as private helpers within it, per research — there is no separate `BomItems` module to extract).
- Produces: `LaborPlanning.init()`, `.render()`, `.onGroupToggle`, `.clearGroupFilter`, `.prevHorizon/.nextHorizon/.setSpan` — moved verbatim, its `App._laborSub`/`_currentTab` reads replaced with `_activeTabResolvers.laborSub()`/`.currentTab()`.

- [ ] **Step 1: Write a failing test, verify RED, move both verbatim**

Add a shape test. Locate `const MasterData = (() => { ... })();` (~6172–7346) and `const LaborPlanning = (() => { ... })();` (~1336–2223). Move both into `plant-and-administration.mjs`. Replace `LaborPlanning`'s `App._laborSub`/`App._currentTab` reads with the `_activeTabResolvers` calls established in Task 1.

Fix `MasterData`'s one `Store._state.masterData`-shaped direct access if research's flagged §6 touch is confirmed present in the current code — replace with the public `Store` getter, closing this row for real (not just by relocation).

- [ ] **Step 2: Extend the destructure, close the §6 row**

```js
const { CalendarUI, Plant, ProdLines, MasterData, LaborPlanning } = window.__NIMBUS_PLANT_ADMIN;
```

Remove `MasterData`'s row from the compatibility inventory's §6 table.

- [ ] **Step 3: Regenerate the contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 4: Commit**

```bash
git add web/plant-and-administration.mjs web/app.js tests/modules/plant-and-administration.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract MasterData and LaborPlanning into plant-and-administration.mjs, close the MasterData Store exception"
```

---

### Task 3: Add Interface, Security, AdminCockpit

**Files:**
- Modify: `web/plant-and-administration.mjs`
- Modify: `web/app.js` (delete all three blocks — including `AdminCockpit` at ~2259 lines, the single largest module in the codebase; extend the destructure)
- Modify: `tests/modules/plant-and-administration.test.mjs`

**Interfaces:**
- Produces: `Interface.render()`, `Security.render()` — moved verbatim, fully self-contained (research found zero cross-references to any other of the 14 modules from either).
- Produces: `AdminCockpit.init()`, `.render()`, `._startHealthPolling()/._stopHealthPolling()`, `.gotoOvTab(tab)`, `._setSub(tab)` (dispatches to `MasterData.render()`/`Interface.render()`/`Security.render()` — same file, no seam) — moved verbatim.

- [ ] **Step 1: Write a failing test, verify RED, move all three verbatim**

Add a shape test. Locate `const Interface = (() => { ... })();` (~7361–7915), `const Security = (() => { ... })();` (~7930–8548), `const AdminCockpit = { ... };` (~2990–5248 — by far the largest single block moved in this entire migration; read it in chunks, don't try to hold the whole thing in context at once). Move all three verbatim.

- [ ] **Step 2: Extend the destructure, verify GREEN**

```js
const { CalendarUI, Plant, ProdLines, MasterData, LaborPlanning, Interface, Security, AdminCockpit } = window.__NIMBUS_PLANT_ADMIN;
```

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 3: Commit**

```bash
git add web/plant-and-administration.mjs web/app.js tests/modules/plant-and-administration.test.mjs tests/contracts/cq1-legacy-surface.json
git commit -m "build: extract Interface, Security, and AdminCockpit into plant-and-administration.mjs"
```

---

### Task 4: `application-shell.mjs` — SessionUIAdapter, showLoginScreen, PlantSelector, WelcomeSplash, EmptyState, App

**Files:**
- Create: `web/application-shell.mjs`
- Create: `tests/modules/application-shell.test.mjs`
- Modify: `web/app-entry.mjs` (bridge as `window.__NIMBUS_SHELL`, extend cleanup; this is the last bridge — `app.js` itself now contains no module bodies of its own)
- Modify: `web/app.js` (delete all six items; the file becomes the documented small launcher — bridge destructure, DI-seam wiring, `_bootMain`, final `return {...}`; add the top-of-file comment declaring this explicitly)
- Modify: `web/index.html` (convert shell-module-targeting onclick= handlers found during this task)
- Modify: `docs/architecture/cq1-compatibility-inventory.md`

**Interfaces:**
- Produces: `SessionUIAdapter.init()`, `._applyGates()` — moved verbatim.
- Produces: `showLoginScreen()` — moved verbatim (standalone function, not a module method).
- Produces: `PlantSelector.init()` — moved verbatim, fully self-contained.
- Produces: `WelcomeSplash.init/.pause/.resume/.dismiss` — moved verbatim.
- Produces: `EmptyState.render(container, opts)` — moved verbatim.
- Produces: `App.goto/gotoGanttSub/gotoGanttTimeline/gotoMasterSub/gotoLaborSub/registerPausable/_applyFirstDayOfWeek/_gotoLanding/_wireResize/toggleSide` — moved verbatim, minus `_renderSettingsPane` (relocated to `Plant` in Task 1).

- [ ] **Step 1: Write failing tests**

Create `tests/modules/application-shell.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, PlantSelector, WelcomeSplash, EmptyState, SessionUIAdapter, showLoginScreen } from '../../web/application-shell.mjs';

test('application-shell exposes the documented public API', () => {
  assert.equal(typeof App.goto, 'function');
  assert.equal(typeof App._renderSettingsPane, 'undefined', 'this method relocated to Plant in Task 1 — must not still exist here');
  assert.equal(typeof PlantSelector.init, 'function');
  assert.equal(typeof WelcomeSplash.init, 'function');
  assert.equal(typeof EmptyState.render, 'function');
  assert.equal(typeof SessionUIAdapter.init, 'function');
  assert.equal(typeof showLoginScreen, 'function');
});
```

- [ ] **Step 2: Verify RED, then move all six items verbatim**

Locate `const SessionUIAdapter = {` (~2277–2917), `function showLoginScreen() { ... }` (~2929–2980), `const PlantSelector = {` (~5278–5461), `const WelcomeSplash = (() => { ... })();` (~5468–5614), `const EmptyState = {` (~5258–5271), `const App = {` (~5619–6167, minus the already-relocated `_renderSettingsPane`). Move all into `web/application-shell.mjs`:

```js
// application-shell.mjs — CQ-1 application-shell module.
// Owns ordered boot, login gating, top-level routing, screen lifecycle,
// plant selector, empty/welcome states. Composes the other six CQ-1 modules
// without duplicating their state, calculations, or endpoint calls. This is
// the last of the seven files — after this phase, app.js contains no module
// bodies of its own, only bridge wiring and boot orchestration (see the
// note at the top of app.js).
import { Config, Util, PerfMonitor, ErrorLog, Toast, Modal } from './application-foundation.mjs';
import { Store, Sandbox } from './schedule-state.mjs';
import { Alerts, Engine } from './schedule-services.mjs';
import { Persistence, Session } from './schedule-data.mjs';
import { Timeline, Table, Hierarchy, Dashboard, TimelineNav, GanttFilter, DependencyOverlay, AlertsUIAdapter } from './schedule-workbench.mjs';
import { AdminCockpit, Plant, ProdLines, LaborPlanning } from './plant-and-administration.mjs';

// ... SessionUIAdapter, showLoginScreen, PlantSelector, WelcomeSplash,
// EmptyState, App — copied verbatim from the deleted app.js blocks, no
// changes beyond App no longer containing _renderSettingsPane (already
// relocated in Task 1).
```

- [ ] **Step 3: Reduce `app.js` to the documented small launcher**

After this task's deletions, `app.js` contains only: the `NimbusComputeCore` guard, the bridge gate/destructure (now 7 bundles: FOUNDATION/STATE/SERVICES/DATA/WORKBENCH/PLANT_ADMIN/SHELL), the DI-seam wiring block, `_bootMain()`'s orchestration sequence (calling `.init()` on modules now imported from the other six files, in the same order as before), `_domReadyGate()`, and the final `return {...}` namespace object. Add a comment at the very top of the file:

```js
// app.js — CQ-1 launcher.
//
// Every module this file used to define now lives in one of the six real
// ES modules bridged in web/app-entry.mjs. This file exists only because
// nimbus-intelligence.js accesses NIMBUS as a bare identifier through
// classic-script shared lexical scope (confirmed: converting it to a real
// ES module would sever that access — see docs/architecture/
// cq1-compatibility-inventory.md). This IS "app.js is gone or a documented
// small launcher" per the CQ-1 design's completion criteria: nothing below
// is a module body — it is boot orchestration and the compatibility
// namespace this project's other consumers (index.html inline handlers,
// nimbus-intelligence.js) still read.
```

Move `_bootMain`'s `AdminCockpit.init()`/`LaborPlanning.init()`/`Plant.init()`/`PlantSelector.init()`/`WelcomeSplash.init()`/`App.init()` calls to reference the now-imported bindings — no change to call order, only to where each name resolves from.

- [ ] **Step 4: Bridge, extend the destructure, verify GREEN**

`app-entry.mjs`: add `import * as shell from './application-shell.mjs';`, `win.__NIMBUS_SHELL = shell;`, matching delete.

```js
const { SessionUIAdapter, showLoginScreen, PlantSelector, WelcomeSplash, EmptyState, App } = window.__NIMBUS_SHELL;
```

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 5: Commit**

```bash
git add web/application-shell.mjs web/app-entry.mjs web/app.js web/index.html tests/modules/application-shell.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract SessionUIAdapter, showLoginScreen, PlantSelector, WelcomeSplash, EmptyState, and App into application-shell.mjs; reduce app.js to a launcher"
```

---

### Task 5: Convert `nimbus-intelligence.js`'s Two Monkey-Patches to Store Events

**Files:**
- Modify: `web/schedule-state.mjs` (add the `undo:pushed` event to `UndoStack.push`)
- Modify: `web/nimbus-intelligence.js` (replace both monkey-patches with `Store.subscribe`)
- Modify: `tests/modules/schedule-state.test.mjs`
- Modify: `docs/architecture/cq1-compatibility-inventory.md`

**Interfaces:**
- Produces: `Store.emit({ type: 'undo:pushed', label })`, fired at the end of `UndoStack.push(label, undoFn)`.
- Consumes (nimbus-intelligence.js): the already-existing `alerts:change` event (`Store.setAlerts`/`dismissAlert`/`dismissAllAlerts` already emit it — confirmed by direct inspection, no `schedule-state.mjs` change needed for this one).

- [ ] **Step 1: Write a failing test for the new event**

Add to `tests/modules/schedule-state.test.mjs`:

```js
test('UndoStack.push emits undo:pushed with the entry label', () => {
  const events = [];
  const off = Store.subscribe(evt => { if (evt.type === 'undo:pushed') events.push(evt); });
  UndoStack.push('unit-test-label', () => {});
  off();
  assert.ok(events.some(e => e.label === 'unit-test-label'));
});
```

- [ ] **Step 2: Verify RED, then add the event**

In `schedule-state.mjs`'s `UndoStack.push`:

```js
push(label, undoFn) {
  this._entries.push({ label, undoFn, at: Date.now() });
  if (this._entries.length > this.MAX) this._entries.shift();
  Store.emit({ type: 'undo:pushed', label });
},
```

- [ ] **Step 3: Replace both monkey-patches in `nimbus-intelligence.js`**

Replace (currently ~line 1215, inside `TimeMachine.init()`):
```js
const origPush = UndoStack.push.bind(UndoStack);
UndoStack.push = (label, undoFn) => {
  origPush(label, undoFn);
  TimeMachine._snapshotAuto(label);
};
```
with:
```js
Store.subscribe(evt => {
  if (evt.type === 'undo:pushed') TimeMachine._snapshotAuto(evt.label);
}, 'TimeMachine.autoSnapshot');
```

Replace (currently ~line 1370, inside `Confidence.init()`):
```js
const origRecompute = Alerts.recompute.bind(Alerts);
Alerts.recompute = (...args) => { const r = origRecompute(...args); Confidence._recomputeDebounced(); return r; };
```
with:
```js
Store.subscribe(evt => {
  if (evt.type === 'alerts:change') Confidence._recomputeDebounced();
}, 'Confidence.autoRecompute');
```

Note this second replacement is a slight, deliberate behavior IMPROVEMENT, not just a refactor: the old wrap only fired on `Alerts.recompute()` calls, but `Alerts.dismiss()`/`dismissAll()` also change `Store.alerts` via `dismissAlert`/`dismissAllAlerts` (which already emit `alerts:change`) and previously never triggered a confidence recompute. Document this explicitly in the commit message and the compatibility inventory rather than silently changing behavior.

- [ ] **Step 4: Regenerate the contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

Expected: `UndoStack.push` and `Alerts.recompute` no longer appear as reassignment targets anywhere; the legacy-surface scanner's monkey-patch-adjacent detection (if any) reflects this — if the scanner doesn't specifically track monkey-patches, note that in the compatibility inventory instead of assuming a diff that won't happen.

- [ ] **Step 5: Update the compatibility inventory**

Document both event conversions, including the deliberate `Confidence` behavior improvement, in a new subsection alongside the existing `schedule:hydrated`/`session:changed`/`sandbox:*` event documentation from Phases 1-2.

- [ ] **Step 6: Commit**

```bash
git add web/schedule-state.mjs web/nimbus-intelligence.js tests/modules/schedule-state.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "refactor: convert nimbus-intelligence.js's UndoStack/Alerts monkey-patches to Store event subscriptions"
```

---

### Task 6: Close Remaining Exceptions, Establish Report-Only CSP, Document the Inline-Handler Backlog

**Files:**
- Modify: `web/app.js` (fix the `App`/`nimbus-intelligence.js` `Store._state`/`_rev` touches where a clean public alternative already exists; where one doesn't, this task adds it)
- Modify: `web/index.html` (add a report-only CSP `<meta>` tag)
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (close the final 2 §6 rows; add a new §7 quantifying the remaining inline-handler count precisely)
- Modify: `scripts/legacy-surface.mjs` (only if needed to add an inline-handler count to its output — check first whether it already reports a count before adding one)

**Interfaces:**
- Produces: a `<meta http-equiv="Content-Security-Policy-Report-Only" content="...">` tag in `index.html`'s `<head>`, scoped to log violations without blocking anything (report-only, per the design's explicit "enforcement waits until incompatible inline presentation is removed").

- [ ] **Step 1: Close the `App` and `nimbus-intelligence.js` §6 rows**

Read `app.js`'s remaining `Store._state`/`Store._rev` touches (now much smaller since most of `App`'s body moved to `application-shell.mjs` in Task 4) and `nimbus-intelligence.js`'s (confirmed present but not fully enumerated by Phase 4 research — read the file's remaining ~1300 unread lines, 1018–2322, to find every one). For each: if a public `Store` getter/method already exists (from Phase 1-3's additions), switch to it. If none exists for a specific field, add a minimal one (matching the pattern of every prior phase's `Store` getter additions) rather than leave the touch unresolved.

- [ ] **Step 2: Add the report-only CSP meta tag**

In `web/index.html`'s `<head>`, add:

```html
<meta http-equiv="Content-Security-Policy-Report-Only" content="default-src 'self'; script-src 'self' https://unpkg.com https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; report-uri /csp-report">
```

(`'unsafe-inline'` stays in this report-only policy for both `script-src` and `style-src` — enforcement is explicitly deferred per the design doc until the remaining inline handlers are gone; the point of Report-Only mode here is to start collecting real violation data against the exact CDN/self allowlist this app actually uses, not to break anything today. `/csp-report` need not be a real working endpoint yet — note in the compatibility inventory that wiring a real report-collection endpoint is a follow-up, not part of this task.)

- [ ] **Step 3: Quantify and document the remaining inline-handler backlog precisely**

Run a fresh count of `on\w+="..."` attributes in `index.html` (the same sweep Phase 4 research used) and record the exact current number in a new §7 of the compatibility inventory, itemized by which module's inline handlers remain (the count should be meaningfully lower than the 123 found at the start of this phase, given Tasks 1-4 each converted their own module's handlers — but it will not be zero). Explicitly state this is deliberately incomplete and why (see this plan's Architecture point 5), and that full elimination is follow-up work beyond CQ-1's scope as currently planned, not a silently-dropped requirement.

- [ ] **Step 4: Verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 5: Commit**

```bash
git add web/app.js web/index.html docs/architecture/cq1-compatibility-inventory.md scripts/legacy-surface.mjs tests/contracts/cq1-legacy-surface.json
git commit -m "build: close the final Store exceptions, establish report-only CSP, quantify the remaining inline-handler backlog"
```

---

### Task 7: CQ-1 Completion — Documentation and the Whole-Migration Gate

**Files:**
- Modify: `docs/architecture/cq1-compatibility-inventory.md`
- Modify: `tests/README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-07-16-cq1-frontend-module-migration-design.md` (mark complete)

- [ ] **Step 1: Update the compatibility inventory's final status**

Add a "CQ-1 status (complete)" note listing all 7 real ES modules and their final line counts, confirming §6 is empty, and cross-referencing the §7 inline-handler backlog as the one deliberately-deferred item.

- [ ] **Step 2: Update `tests/README.md`, `AGENTS.md`, `CLAUDE.md`, and the design doc**

Mirror the Phase 1-3 pattern for the test files. In the design doc itself, add a brief "Status: CQ-1 complete as of <this commit>" note at the top, listing the one known deliberate gap (inline-handler backlog) rather than silently closing a doc that still describes aspirational future work as if it were still pending.

- [ ] **Step 3: Run the full CQ-1 completion gate — this is the whole-migration gate, not just Phase 4's**

- [ ] `git diff --check`
- [ ] `npm run lint:ci`
- [ ] `npm test` (full suite — legacy CommonJS compute/timezone tests, every `.mjs` module test file across all 4 phases)
- [ ] `npm run check:legacy-surface`
- [ ] `npm run check:static-assets`
- [ ] Offline pytest regression check
- [ ] Grep `web/app.js` for every one of the ~30 module names extracted across all 4 phases — expect zero matches for any of them; confirm `app.js`'s only remaining content is the bridge/boot/return-object launcher described in Task 4 Step 3
- [ ] Confirm the compatibility inventory §6 table is empty
- [ ] Confirm `web/app-entry.mjs` bridges all 7 real modules (`__NIMBUS_FOUNDATION/STATE/SERVICES/DATA/WORKBENCH/PLANT_ADMIN/SHELL`)
- [ ] Confirm the worker `postMessage`/`onmessage` envelope and every `nimbus-compute-core.js` signature are still byte-identical to pre-Phase-1 (the `tests/js/*.test.js` suite passing unmodified across all 4 phases is the evidence)
- [ ] Docker/browser boot smoke test if available; if not, record as an unverified environment gate — this is the last chance in CQ-1 to actually exercise this, flag it prominently if it's still never been run by the time this phase closes
- [ ] Read the design doc's own final "Verification and completion" paragraph and confirm each named criterion against the actual repository state, not against this plan's intentions — report explicitly on: "app.js is gone or a documented small launcher" (yes, per Task 4), "the seven files are clear owners" (confirm), "no task API assumes global ID uniqueness" (confirm — this was flagged as deliberately deferred back in Phase 1's compatibility inventory §3, still true; do not silently claim it's resolved if it isn't), "live/draft/hydrate semantics are isolated" (confirm — `Store.mode()` exists per Phase 1 but 'hydrate' mode was never actually implemented; report honestly), "late async results cannot overwrite a newer plant/revision" (confirm against `Compute`'s stale-response guards), "worker/core parity remains green" (confirm), "intelligence no longer monkey-patches behavior" (confirm — Task 5 closes this), "inline compatibility is removed" (report the true, non-zero remaining count from Task 6 Step 3 — do not claim this is fully done), "the container reliably ships a coherent module graph" (this needs the Docker smoke test to genuinely confirm — report honestly if it's still unverified).

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/cq1-compatibility-inventory.md tests/README.md AGENTS.md CLAUDE.md docs/superpowers/specs/2026-07-16-cq1-frontend-module-migration-design.md
git commit -m "docs: close out CQ-1 — all four phases of the frontend module migration complete"
```

---

## Phase 4 / CQ-1 Completion Gate

- [ ] All 7 tasks committed.
- [ ] Full verification suite green.
- [ ] `web/app.js` contains no module bodies — only the bridge/boot/return-object launcher.
- [ ] `docs/architecture/cq1-compatibility-inventory.md` §6 is empty.
- [ ] `nimbus-intelligence.js` no longer reassigns `UndoStack.push` or `Alerts.recompute`.
- [ ] A report-only CSP meta tag exists in `index.html`.
- [ ] The remaining inline-handler count is precisely quantified in a new §7, not silently declared zero.
- [ ] Docker/browser smoke test run if available; recorded as an unverified environment gate if not — flagged prominently as never having been exercised across all 4 phases if that remains true.
- [ ] Honest final report against the design doc's own completion criteria (Task 7 Step 3's last bullet) — including the criteria this plan does NOT fully satisfy (inline-handler elimination, hydrate-mode implementation, global-ID-uniqueness enforcement), each with a clear note on what would need to happen next and in which follow-up effort, not silently dropped.
</content>
