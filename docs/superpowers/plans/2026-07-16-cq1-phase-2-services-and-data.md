# CQ-1 Phase 2: Services and Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `Calendar` (capacity math only), `Compute`, `Alerts` (computation only), `Utilization`, and `Engine` into a real ES module `web/schedule-services.mjs`; extract `Persistence`, `CalendarSync`, and `Session` (state/API only) into a real ES module `web/schedule-data.mjs` — without changing any compute algorithm, the worker message protocol, or optimistic-concurrency behavior. DOM/UI code that was co-located with these modules (calendar blackout-block UI, the alerts drawer/bell/cell-briefing modal, session gates/settings panes) stays behind in `app.js` as thin adapters, following the `Sandbox`/`SandboxAdapter` precedent from Phase 1.

**Architecture:** `schedule-services.mjs` and `schedule-data.mjs` are bridged into `app.js` exactly like Phase 1's two modules — a third and fourth entry on the same `app-entry.mjs` loader, `window.__NIMBUS_SERVICES` / `window.__NIMBUS_DATA`, destructured at the top of `app.js`'s closure. The approved design's dependency arrow is `schedule-services.mjs ───→ schedule-data.mjs` (services *may* depend on data; data must never import services). Research against the current codebase found the **reverse** dependency already exists in real code: `Persistence` (data) calls `Alerts.scheduleRecompute()` and four `Calendar` capacity functions (services) at 10 call sites, all inside hydration/load logic that needs a real, synchronous return value or a "now go recompute" signal. This phase resolves that the same way the design doc prescribes for exactly this situation — "a post-commit event or a small public method" — never a reverse import: the fire-and-forget `Alerts.scheduleRecompute()` signal becomes a new `schedule:hydrated` Store event that `schedule-services.mjs` subscribes to once; the four `Calendar` capacity calls that need a real return value become an injected-callback seam, `Persistence.setCalendarService({...})`, wired once in `app.js` boot glue after both bridges exist — the same pattern as Phase 1's `Util.setActorResolver`/`Store.setAllowedPlantsResolver`.

Three of the eight modules need a DOM/computation split before they can move at all, discovered by direct inspection (not assumed from the design doc, which does not mention any of these splits):
- **`Calendar`** is ~80% pure capacity math (`workWindow`, `dailyCapacityHours`, `effectiveFromCapacity`, `nextAvailable`, etc.) and ~20% blackout-block-tab UI (`render`, `openBlockModal`, `saveBlockFromModal`, `removeBlock`, `_getLines`, `_hToT`/`_tToH`). Only the capacity-math half moves to `schedule-services.mjs`; the UI half stays in `app.js` renamed to `CalendarUI` (the bare name `Calendar` is claimed by the imported capacity object).
- **`Alerts`** is ~64% DOM (the alerts drawer, bell badge, cell-briefing modal) and ~36% computation (`recompute`, `applyFix`, the debounce machinery). Only the computation half moves; the UI half stays in `app.js` as `AlertsUIAdapter`, reacting to the `alerts:change` Store event exactly the way it already does today (this part requires **no new event** — `Store.setAlerts` already emits `alerts:change`, and `App.init()` already subscribes UI re-renders to it; only the physical code needs relocating).
- **`Session`** is a bare public API (`currentUser`, `actor`, `isAdmin`, `allowedPlants`, `pref`, `setPref`) wrapped around ~600 lines of fully-private DOM/settings-pane code invoked *inline* from `signIn`/`signOut`/`refresh`/`_applyGates`. Unlike Sandbox, there is no existing event seam here — this phase introduces one (`session:changed`) and a `SessionUIAdapter` in `app.js`, mirroring the `Sandbox`/`SandboxAdapter` split exactly.

`Engine` gets its own task: at 583 lines it is comparable in size to Calendar/Alerts, but its `_dispatchDayIntegrity` day-integrity dispatch (~245 lines of tiered admit-then-resequence logic with two independent convergence guards) is the most algorithmically dense code in the whole frontend, and the plan's own constraint is "extract without changing compute algorithms" — it gets isolated review attention rather than being bundled with anything else.

**Tech Stack:** Native browser ES modules, Node 20 built-in test runner, ESLint 9 flat config (already covers `web/**/*.mjs` and `tests/modules/**/*.mjs` with zero changes needed — confirmed by inspection), Python/pytest (unaffected — no backend changes this phase).

## Global Constraints

- Preserve all current scheduling behavior, the exact worker `postMessage`/`onmessage` envelope (`{type, id, payload}` out; `{type: 'ALERTS_RESULT'|'UTILIZATION_RESULT'|'ERROR', id, ...}` in), `nimbus-compute-core.js`'s exported function signatures, and optimistic-concurrency semantics (`base_version`/`force`/`stale` reconciliation). Do not touch `nimbus-worker.js` or `nimbus-compute-core.js`.
- **Imports flow one way: `schedule-services.mjs` may import from `schedule-data.mjs`; `schedule-data.mjs` must never import from `schedule-services.mjs`.** Every call in the reverse direction becomes an injected-callback seam (a `setXService(fn)`-style method on the data-side module, wired once in `app.js` boot glue) or a Store event — never a static import, never a `globalThis`/`window` reach-around.
- `NIMBUS` remains a bare script-scope `const`; `app.js`/`nimbus-intelligence.js` stay classic (non-module) scripts. Do not convert them this phase.
- **Line numbers cited below are absolute positions in `web/app.js` as it exists at the start of this phase (commit `05cb348`, ~18,848 lines).** Every task after Task 1 deletes code, shifting everything below it. Locate blocks by comment banner or exact `const ModuleName = {` declaration and matching closing brace — never trust a later task's cited number as a literal offset at that point in execution.
- `Store._state`/`Store._rev` remain real properties (established Phase 1) — this phase closes exactly the 5 rows in `docs/architecture/cq1-compatibility-inventory.md` §6 tagged "Phase 2" (`Alerts`, `Utilization`, `Engine`, `Persistence`, `CalendarSync`) by having those modules stop touching `_state`/`_rev` directly, replacing them with the public equivalents Phase 1 already added (`Store.rev()`, `Store.replace*`, public getters). Do not touch the remaining 8 rows (Phase 3/4 consumers) — those stay open exceptions.
- Regenerate `tests/contracts/cq1-legacy-surface.json` (`node scripts/legacy-surface.mjs --write`) in the same task that removes a tracked private-consumer/inline-handler entry. `scripts/legacy-surface.mjs`'s `discoverModuleSources()` already auto-globs every `.mjs` file under `web/` — no scanner changes needed for the two new files.
- No new inline scripts, inline event-handler attributes, or inline style attributes. The allowlist may only shrink.
- `package.json` and `eslint.config.js` need **zero changes** this phase — confirmed by inspection, both already glob `web/**/*.mjs` and `tests/modules/**/*.mjs`.
- Every new/changed DOM adapter (`CalendarUI`, `AlertsUIAdapter`, `SessionUIAdapter`) follows the `SandboxAdapter` precedent: owns DOM wiring, subscribes to Store events, calls the extracted module's public API — never the other way around.

---

### Task 1: `schedule-services.mjs` — Calendar (capacity math) + Compute; `CalendarUI` Remnant in `app.js`

**Files:**
- Create: `web/schedule-services.mjs` (exports `Calendar`, `Compute` for now)
- Create: `tests/modules/schedule-services.test.mjs`
- Modify: `web/app-entry.mjs` (bridge `schedule-services.mjs` as `window.__NIMBUS_SERVICES`, extend the post-boot bridge cleanup)
- Modify: `web/app.js` (delete the `Calendar`/`Compute` object literals at their current locations; extend the bridge destructure; add a new `CalendarUI` object holding the UI methods that don't move)
- Modify: `web/index.html` (the one `onclick="NIMBUS.Calendar.saveBlockFromModal()"` becomes `NIMBUS.CalendarUI.saveBlockFromModal()`)
- Modify: `tests/modules/helpers/load-legacy-app.mjs` (bridge `schedule-services.mjs` too)
- Modify: `tests/contracts/cq1-legacy-surface.json` (regenerate)

**Interfaces:**
- Produces (schedule-services.mjs): `Calendar.workWindow(line, date)`, `.dailyCapacityHours(line, date, idx)`, `.effectiveFromCapacity(line, full)`, `.effectiveCapacityHours(line, date)`, `.isAvailable(line, date)`, `.nextAvailable(line, from, durationMs)`, `._beginRun(plant)`, `._endRun()`, `._indexBlocks(plant)`, `._indexCapacityBlocks()`, `._overlapsBlock(line, start, end)`, `._dayWindow(workHours, date)`.
- Produces (schedule-services.mjs): `Compute.available()`, `.alerts(opts, dismissed)`, `.utilization(startMs, days)` — moved verbatim, zero behavior change.
- Produces (app.js): `CalendarUI.render()`, `.removeBlock(id)`, `.openBlockModal()`, `.saveBlockFromModal()`, `._getLines()`, `._hToT(h)`, `._tToH(t)`, `._clearLineFilter()`, `._renderBlocks()`.
- Consumes: `Store`, `Config`, `Util`, `ErrorLog`, `Toast`, `Modal`, `PerfMonitor` (all Phase 1, `application-foundation.mjs`/`schedule-state.mjs`).

- [ ] **Step 1: Write failing tests for the moved modules' shape and the worker protocol**

Create `tests/modules/schedule-services.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calendar, Compute } from '../../web/schedule-services.mjs';
import { Store } from '../../web/schedule-state.mjs';

test('Calendar exposes capacity-math methods only (no render/openBlockModal/DOM)', () => {
  assert.equal(typeof Calendar.workWindow, 'function');
  assert.equal(typeof Calendar.dailyCapacityHours, 'function');
  assert.equal(typeof Calendar.nextAvailable, 'function');
  assert.equal(Calendar.render, undefined, 'Calendar must not carry UI methods after the split');
  assert.equal(Calendar.openBlockModal, undefined);
  assert.equal(Calendar.saveBlockFromModal, undefined);
});

test('Calendar.workWindow returns null outside working hours, a window inside them', () => {
  Store.setCalendar('L1', { 1: [7, 19] }, 'unit-test'); // Monday 7am-7pm
  const monday = new Date('2026-08-03T12:00:00'); // a Monday, midday
  const win = Calendar.workWindow('L1', monday);
  assert.ok(win === null || Array.isArray(win));
});

test('Compute.available reflects Worker constructor availability', () => {
  assert.equal(typeof Compute.available(), 'boolean');
});

test('Compute has no underscore-prefixed properties reachable on the export (closure-private by construction)', () => {
  const keys = Object.keys(Compute);
  assert.ok(keys.every(k => !k.startsWith('_')), 'Compute must stay fully encapsulated, as before the move');
  assert.deepEqual(keys.sort(), ['alerts', 'available', 'utilization']);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-services.test.mjs`

Expected: failure — `web/schedule-services.mjs` does not exist.

- [ ] **Step 3: Move `Calendar`'s capacity-math half; leave the UI half in `app.js` as `CalendarUI`**

Locate the `const Calendar = {` object literal in `web/app.js` (comment banner "CALENDAR — working hours, blackout blocks, availability calculations", currently ~line 135, closing ~line 620). Split it:

- Moves to `web/schedule-services.mjs` (verbatim, no edits): `_runCache`, `_runBlocks` (state); `_beginRun(plant)`, `_endRun()`, `_indexBlocks(plant)`, `_dayWindow(workHours, date)`, `_indexCapacityBlocks()`, `_overlapsBlock(line, start, end)` (private methods); `workWindow(line, date)`, `dailyCapacityHours(line, date, idx)`, `effectiveFromCapacity(line, full)`, `effectiveCapacityHours(line, date)`, `isAvailable(line, date)`, `nextAvailable(line, from, durationMs)` (public methods).
- Stays in `app.js`, renamed from `Calendar` to `CalendarUI` (verbatim bodies, only the enclosing object's name changes): `_lineFilter`, `_blockFilter`, `_fpBlkStart`, `_fpBlkEnd` (state); `_clearLineFilter()`, `_renderBlocks()`, `_getLines()`, `_hToT(h)`, `_tToH(t)` (private); `render()`, `removeBlock(id)`, `openBlockModal()`, `saveBlockFromModal()` (public). `CalendarUI`'s methods call the now-imported `Calendar.*` capacity functions exactly where the original code did (e.g. inside `render()`), and continue to call `CalendarSync.saveLineBlackoutUpsert/Delete` unchanged (`CalendarSync` isn't extracted until Task 4 — it's still a same-file forward reference within `app.js` at this point, exactly as before).

Create `web/schedule-services.mjs`:

```js
// schedule-services.mjs — CQ-1 schedule-services module.
// Owns calendar capacity math, the Compute worker client, alerts computation,
// utilization, optimizer dispatch, and auto-reflow. Delegates algorithmic
// truth to nimbus-compute-core.js and preserves the existing worker protocol
// byte-for-byte. May import from schedule-data.mjs; must never be imported by
// it. DOM/UI code that was co-located with these modules in app.js (calendar
// blackout-block tab, alerts drawer/bell/modal, session settings panes)
// stays in app.js as thin adapters — see docs/architecture/
// cq1-compatibility-inventory.md.
import { Config, Util, PerfMonitor, ErrorLog, Toast } from './application-foundation.mjs';
import { Store } from './schedule-state.mjs';

export const Calendar = {
  _runCache: null,
  _runBlocks: null,

  // ... _beginRun, _endRun, _indexBlocks, _dayWindow, _indexCapacityBlocks,
  // _overlapsBlock, workWindow, dailyCapacityHours, effectiveFromCapacity,
  // effectiveCapacityHours, isAvailable, nextAvailable — copied verbatim from
  // the capacity-math half of app.js's deleted Calendar block, no changes.
};

export const Compute = (() => {
  // ... _worker, _dead, _crashCount, _seq, _pending, _init, _post, _snap —
  // copied verbatim from app.js's deleted Compute IIFE, no changes. Every
  // Worker construction, onmessage/onerror handler, and postMessage payload
  // shape stays byte-for-byte identical — this is the worker-protocol
  // preservation constraint.
  return { available, alerts, utilization };
})();
```

- [ ] **Step 4: Bridge `schedule-services.mjs` from `app-entry.mjs`, extending the existing post-boot cleanup**

In `web/app-entry.mjs`, add the import and bridge assignment, and extend the cleanup block:

```js
import * as services from './schedule-services.mjs';
// ...
win.__NIMBUS_SERVICES = services;
// ... (inside the existing .then() cleanup block, alongside the two existing deletes)
delete win.__NIMBUS_SERVICES;
```

- [ ] **Step 5: Extend the `app.js` bridge gate and destructure**

```js
if (typeof window === 'undefined' || !window.__NIMBUS_FOUNDATION || !window.__NIMBUS_STATE || !window.__NIMBUS_SERVICES) {
  throw new Error('NIMBUS boot error: application-foundation.mjs/schedule-state.mjs/schedule-services.mjs did not load before app.js — check app-entry.mjs.');
}
const { Config, Util, PerfMonitor, VirtualList, ErrorLog, Toast, Modal } = window.__NIMBUS_FOUNDATION;
const { Store, Selection, UndoStack, Sandbox } = window.__NIMBUS_STATE;
const { Calendar, Compute } = window.__NIMBUS_SERVICES;
```

(`Alerts`, `Utilization`, `Engine` join this destructure in Tasks 2–3.)

- [ ] **Step 6: Fix the `ProdLines`/`EditCalendar` calls that referenced the now-moved `Calendar._getLines`/`_hToT`/`_tToH`**

In `web/app.js`, update every call site found by inspection to reference `CalendarUI` instead of `Calendar`: `ProdLines.render()`, `ProdLines._renderDetail()`, `ProdLines.openBlockModal()` (each call `Calendar._getLines()` → `CalendarUI._getLines()`); `EditCalendar._populate()`, `._refreshBadge()`, `.copyFromPlant()`, `.save()` (each call `Calendar._hToT()`/`_tToH()` → `CalendarUI._hToT()`/`_tToH()`).

- [ ] **Step 7: Update `index.html`'s one `Calendar` inline handler**

Change `onclick="NIMBUS.Calendar.saveBlockFromModal()"` to `onclick="NIMBUS.CalendarUI.saveBlockFromModal()"`. Add `CalendarUI` to `app.js`'s final `return {...}` namespace object alongside the existing `Calendar` entry (both stay — `Calendar` for the imported capacity object, now also reachable via `NIMBUS.Calendar` for any Phase-3+ consumer that needs pure capacity math; `CalendarUI` for the UI remnant).

- [ ] **Step 8: Update `load-legacy-app.mjs` to bridge services too**

```js
import * as services from '../../../web/schedule-services.mjs';
// ...
sandbox.window.__NIMBUS_SERVICES = services;
```

- [ ] **Step 9: Regenerate the legacy-surface contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write`

Run: `npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 10: Commit**

```bash
git add web/schedule-services.mjs web/app-entry.mjs web/app.js web/index.html tests/modules/schedule-services.test.mjs tests/modules/helpers/load-legacy-app.mjs tests/contracts/cq1-legacy-surface.json
git commit -m "build: extract Calendar capacity math and Compute into schedule-services.mjs"
```

---

### Task 2: Add Alerts (Computation) and Utilization; `AlertsUIAdapter` Remnant in `app.js`

**Files:**
- Modify: `web/schedule-services.mjs` (add `Alerts`, `Utilization`)
- Modify: `web/app.js` (delete the `Alerts`/`Utilization` blocks; add `AlertsUIAdapter`; extend the bridge destructure; fix the 5 cross-module DOM-adjacent call sites)
- Modify: `web/index.html` (`NIMBUS.Alerts.toggleDrawer()` → `NIMBUS.AlertsUIAdapter.toggleDrawer()`)
- Modify: `tests/modules/schedule-services.test.mjs` (add coverage)
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (close the `Alerts`/`Utilization` §6 rows)

**Interfaces:**
- Produces (schedule-services.mjs): `Alerts.recompute(opts)`, `.dismiss(id)`, `.dismissAll()`, `.clearDismissed()`, `.applyFix(id)`, `.scheduleRecompute()`, `.scheduleRecomputeLines(lines)` — moved verbatim, same debounce/worker-fallback contract.
- Produces (schedule-services.mjs): `Utilization.computeMatrix(startDate, days, srcTasks)`, `.sev(pct, overloadAt)`, `.todayByLine()`, `.dayByLine(date, srcTasks)` — moved verbatim, same memo-key shape (`` `${startMs}|${days}|${Store.rev()}|${scope}` `` — see Step 3 note on replacing `Store._rev` with `Store.rev()`).
- Produces (app.js): `AlertsUIAdapter.focus(id)`, `.showForCell(line, dayKey)`, `.toggleDrawer()`, `.renderBell()` (renamed from `_renderBell`, now public since `Dashboard`/`App._renderSettingsPane` call it externally), `.renderDrawer()` (renamed from `_renderDrawer`, same reason). `_renderAlertRow` stays private (only called from within `renderDrawer`).
- Consumes: `Compute`, `Calendar` (same module, sibling consts from Task 1).

- [ ] **Step 1: Write failing tests**

Add to `tests/modules/schedule-services.test.mjs`:

```js
import { Alerts, Utilization } from '../../web/schedule-services.mjs';

test('Alerts exposes computation methods only (no showForCell/toggleDrawer/render*)', () => {
  assert.equal(typeof Alerts.recompute, 'function');
  assert.equal(typeof Alerts.scheduleRecompute, 'function');
  assert.equal(typeof Alerts.applyFix, 'function');
  assert.equal(Alerts.showForCell, undefined, 'DOM modal must not travel with the computation module');
  assert.equal(Alerts.toggleDrawer, undefined);
  assert.equal(Alerts._renderDrawer, undefined);
  assert.equal(Alerts._renderBell, undefined);
});

test('Alerts.recompute with no worker/no plant falls back to sync compute', () => {
  Store.setSelectedPlant(null, 'unit-test'); // no plant -> forces sync path regardless of Compute.available()
  Store.setTasks([], 'unit-test');
  assert.doesNotThrow(() => Alerts.recompute());
});

test('Alerts.scheduleRecompute/{,Lines} debounce and eventually call recompute (adaptive delay)', async () => {
  let recomputeCalls = 0;
  const orig = Alerts.recompute;
  Alerts.recompute = (...args) => { recomputeCalls++; return orig.apply(Alerts, args); };
  Alerts.scheduleRecompute();
  await new Promise(r => setTimeout(r, 600)); // > _ALERTS_MAX_DEBOUNCE_MS
  assert.ok(recomputeCalls >= 1);
  Alerts.recompute = orig;
});

test('Utilization.computeMatrix memoizes on (startMs, days, Store.rev(), plant scope)', () => {
  Store.setTasks([], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  const day = new Date('2026-08-03');
  const m1 = Utilization.computeMatrix(day, 7);
  const m2 = Utilization.computeMatrix(day, 7);
  assert.equal(m1, m2, 'same key must return the identical cached matrix object');
  Store.setTasks([{ id: 'u1', RUN_TIME: '1', PRODUCTION_LINE: 'L1', plant: '5512' }], 'unit-test');
  const m3 = Utilization.computeMatrix(day, 7);
  assert.notEqual(m3, m1, 'a Store mutation must bump Store.rev() and invalidate the memo');
});

test('Utilization.dayByLine is unmemoized — two calls with the same args recompute independently', () => {
  const a = Utilization.dayByLine(new Date());
  const b = Utilization.dayByLine(new Date());
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'must not be the same cached object reference — dayByLine has no memo');
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-services.test.mjs`

Expected: fails — `Alerts`/`Utilization` aren't exported yet.

- [ ] **Step 3: Move `Alerts`'s computation half into `schedule-services.mjs`**

Locate `const Alerts = {` (banner "ALERTS", currently ~line 2898, closing ~3342, plus the post-literal debounce augmentation through ~line 3380). Split:

- Moves verbatim: `recompute(opts)`, `_recomputeSync(opts)`, `_dismissed`, `dismiss(id)`, `dismissAll()`, `clearDismissed()`, `applyFix(id)`, and the post-literal debounce block (`_lastMs`, `_timer`, `_pendingFull`, `_pendingLines`, `_fire`, `_armTimer`, `scheduleRecompute`, `scheduleRecomputeLines`).
- Stays in `app.js`, in a new `AlertsUIAdapter` object: `focus(id)` (renamed from `focus`), `showForCell(line, dayKey)`, `toggleDrawer()`, `_renderAlertRow(a)` (stays private, only internal callers), `renderDrawer()` (renamed from `_renderDrawer`, promoted public), `renderBell()` (renamed from `_renderBell`, promoted public), plus the `_drawerVL` VirtualList instance and the `VL_ALERT_ROW_H` constant it was already using (that constant, currently a top-of-file `const` at app.js:129, stays in `app.js` — `AlertsUIAdapter` is in the same file, no import needed).

One byte-for-byte-preserving change while moving `Store.setAlerts`'s emitted event's consumer: `App.init()`'s existing `Store.subscribe(evt => { if (evt.type === 'alerts:change') { ...; Alerts._renderDrawer(); Alerts._renderBell(); } })` (currently ~line 15703) must call `AlertsUIAdapter.renderDrawer()`/`AlertsUIAdapter.renderBell()` instead — this is the **only** wiring change needed; `Store.setAlerts` already emits `alerts:change` today with no changes required.

Update the 3 other external private-consumer call sites found by inspection: `Dashboard.render()` (~line 8180: `Alerts._renderBell()` → `AlertsUIAdapter.renderBell()`), `App._renderSettingsPane()`'s `saveAlert()` (~lines 16006–16007: `Alerts._renderBell()`/`Alerts._renderDrawer()` → `AlertsUIAdapter.renderBell()`/`AlertsUIAdapter.renderDrawer()`).

Add to `schedule-services.mjs`:

```js
export const Alerts = {
  _dismissed: new Set(),

  // ... recompute, _recomputeSync, dismiss, dismissAll, clearDismissed,
  // applyFix — copied verbatim from the computation half of app.js's deleted
  // Alerts block, no changes. Every Store/Compute/Calendar/Toast/UndoStack
  // reference resolves via the imports at the top of this file (Calendar is
  // a sibling const from Task 1; UndoStack comes from schedule-state.mjs —
  // add it to this file's import line).
};

// Post-object debounce augmentation, copied verbatim from app.js:
const _ALERTS_MIN_DEBOUNCE_MS = 90;
const _ALERTS_MAX_DEBOUNCE_MS = 500;
Alerts._lastMs = 0; Alerts._timer = null; Alerts._pendingFull = false; Alerts._pendingLines = new Set();
Alerts._fire = function () { /* ... verbatim ... */ };
Alerts._armTimer = function () { /* ... verbatim ... */ };
Alerts.scheduleRecompute = function () { Alerts._pendingFull = true; Alerts._armTimer(); };
Alerts.scheduleRecomputeLines = function (lines) { /* ... verbatim ... */ };
```

Update `schedule-services.mjs`'s top import line to add `UndoStack`:
```js
import { Store, UndoStack } from './schedule-state.mjs';
```

- [ ] **Step 4: Move `Utilization` (pure — no split needed) into `schedule-services.mjs`**

Locate `const Utilization = {` (banner "UTILIZATION", currently ~line 3385, closing ~3518, plus the post-literal `_prewarm` augmentation and its `Store.subscribe` wiring through ~line 3550). Move verbatim in full: `_cache`, `computeMatrix(startDate, days, srcTasks)`, `sev(pct, overloadAt)`, `todayByLine()`, `dayByLine(date, srcTasks)`, `_prewarm`, and the debounced `Store.subscribe(...)` wiring that calls it. **Replace `Store._rev` with `Store.rev()`** at every one of the 3 sites found by inspection inside this block (the memo-key line in `computeMatrix`, and the two `_prewarm` cache-key sites) — this is one of Task 2's two §6-exception closures.

Add to `schedule-services.mjs`:

```js
export const Utilization = {
  _cache: null,
  // ... computeMatrix, sev, todayByLine, dayByLine, _prewarm — copied
  // verbatim, with `Store._rev` replaced by `Store.rev()` at its 3 call
  // sites (the public getter Phase 1 already added; behavior is identical,
  // this just stops touching the tracked-exception private field).
};
```

- [ ] **Step 5: Fix the `Alerts`/`Utilization` `Store._state`/`Store._rev` §6 exceptions**

Grep the moved `Alerts` block for `Store._state.masterData` (2 sites per inspection) and replace with the existing public getter `Store.masterData` if one exists, or add a one-line public getter to `schedule-state.mjs` if it doesn't (`get masterData() { return this._state.masterData; }`) rather than reach into `_state` directly. Same for the 1 remaining `Store._rev` read in `Alerts.recompute`'s staleness guard (`const reqRev = Store._rev || 0;` → `const reqRev = Store.rev();`, and the later comparison `(Store._rev || 0) !== reqRev` → `Store.rev() !== reqRev`).

- [ ] **Step 6: Extend the `app.js` bridge destructure**

```js
const { Calendar, Compute, Alerts, Utilization } = window.__NIMBUS_SERVICES;
```

(`Engine` joins in Task 3.)

- [ ] **Step 7: Update `index.html` and the compatibility inventory**

`index.html`'s `onclick="NIMBUS.Alerts.toggleDrawer()"` (~line 1957) → `onclick="NIMBUS.AlertsUIAdapter.toggleDrawer()"`. `NIMBUS.Alerts.dismissAll()` (~line 1956) stays as-is (computation, unchanged). Add `AlertsUIAdapter` to `app.js`'s final `return {...}`.

In `docs/architecture/cq1-compatibility-inventory.md` §6, remove the `Alerts` and `Utilization` rows (both closed this task) and add a note to §1's `Alerts` row: `"Split: computation → schedule-services.mjs; drawer/bell/cell-briefing modal → app.js's AlertsUIAdapter."`

- [ ] **Step 8: Regenerate the contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 9: Commit**

```bash
git add web/schedule-services.mjs web/app.js web/index.html tests/modules/schedule-services.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Alerts computation and Utilization into schedule-services.mjs"
```

---

### Task 3: Add Engine (Optimizer + Auto-Reflow)

**Files:**
- Modify: `web/schedule-services.mjs` (add `Engine`)
- Modify: `web/app.js` (delete the `Engine` block; extend the bridge destructure; resolve the one DOM read)
- Modify: `tests/modules/schedule-services.test.mjs` (add coverage — this task needs the most careful characterization given `_dispatchDayIntegrity`'s complexity)
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (close the `Engine` §6 row; correct its §1 "no DOM" note)

**Interfaces:**
- Produces: `Engine.CONSTRAINT_CATALOG`, `.constraintsFor(plant)`, `.constraintEnabled(plant, key)`, `.activeConstraintKeys(plant)`, `.runAndApply(mode, opts)`, `.autoReflow(changedId)` — moved verbatim except the one DOM-read fallback (see Step 4).
- Consumes: `Calendar`, `Alerts` (same module, sibling consts).

- [ ] **Step 1: Write a failing characterization test for `runAndApply` and `autoReflow`**

Add to `tests/modules/schedule-services.test.mjs`:

```js
import { Engine } from '../../web/schedule-services.mjs';

test('Engine exposes the documented public API and no DOM-dependent surprises', () => {
  assert.equal(typeof Engine.runAndApply, 'function');
  assert.equal(typeof Engine.autoReflow, 'function');
  assert.equal(typeof Engine.constraintEnabled, 'function');
  assert.ok(Array.isArray(Engine.CONSTRAINT_CATALOG));
});

test('Engine.runAndApply no-ops with a toast when there are no tasks', () => {
  Store.setTasks([], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  assert.doesNotThrow(() => Engine.runAndApply('spt'));
});

test('Engine.runAndApply(\'spt\') sorts a single line\'s free tasks by ascending run-hours', () => {
  Store.setTasks([
    { id: 'e1', PRODUCTION_LINE: 'L1', plant: '5512', RUN_TIME: '5', start_date: null, end_date: null },
    { id: 'e2', PRODUCTION_LINE: 'L1', plant: '5512', RUN_TIME: '1', start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  Engine.runAndApply('spt', { respectFixed: true, respectCalendar: false });
  const e1 = Store.tasks['e1'], e2 = Store.tasks['e2'];
  assert.ok(e2.start_date <= e1.start_date, 'shorter run-time task (e2) must be scheduled first under SPT');
});

test('Engine.autoReflow pushes an overlapping unfixed downstream peer forward on the same line', () => {
  // ... seed two overlapping same-line tasks, call Engine.autoReflow(changedId),
  // assert the downstream peer's start_date moved past the changed task's end_date.
});

test('Engine.runAndApply respects explicit respectFixed/respectCalendar options without reading any DOM element', () => {
  // Regression test for the DOM-read fix in Step 4: call runAndApply with both
  // flags explicit and confirm no `document.getElementById` call is needed —
  // this test's harness provides no `document` stub with 'chk-respect-fixed'/
  // 'chk-respect-calendar' elements, so if Engine still reads them, this throws.
  Store.setTasks([{ id: 'e3', PRODUCTION_LINE: 'L1', plant: '5512', RUN_TIME: '1' }], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  assert.doesNotThrow(() => Engine.runAndApply('combined', { respectFixed: true, respectCalendar: true }));
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-services.test.mjs`

Expected: fails — `Engine` isn't exported yet.

- [ ] **Step 3: Move `Engine` verbatim**

Locate `const Engine = {` (banner ~line 3559, closing ~4141). Move the entire object verbatim into `schedule-services.mjs`: `CONSTRAINT_CATALOG`, `constraintsFor(plant)`, `constraintEnabled(plant, key)`, `activeConstraintKeys(plant)`, `_sortTerms(mode, opts)`, `_comparator(mode, opts)` (dead code — confirmed zero call sites anywhere; move it anyway rather than delete it, since removing dead-but-still-exported code is a separate, out-of-scope cleanup this phase doesn't authorize), `_dispatchDayIntegrity(line, freeTasksIn, fixedTasks, cursorInit, opts)`, `runAndApply(mode, opts)`, `autoReflow(changedId)`. Preserve the exact two direct `Store` mutation calls (`Store.updateMany(patches, 'engine')` at both call sites) and replace the one direct `Store._state.meta.lastOptimize = new Date();` write with the public equivalent — add a one-line setter to `schedule-state.mjs` if none exists (`setLastOptimize(date, source) { this._state.meta.lastOptimize = date; this.emit({type:'meta:change', source}); }`) and call `Store.setLastOptimize(new Date(), 'engine')` instead.

- [ ] **Step 4: Resolve the one DOM read — `runAndApply`'s `respectFixed`/`respectCalendar` fallback**

Before moving, read `web/index.html`'s `#chk-respect-fixed`/`#chk-respect-calendar` checkbox elements' default `checked` attribute value (search for `id="chk-respect-fixed"` and `id="chk-respect-calendar"`) — confirm whether they default checked or unchecked. Replace the current

```js
const respectFixed = opts.respectFixed ?? document.getElementById('chk-respect-fixed')?.checked;
const respectCalendar = opts.respectCalendar ?? document.getElementById('chk-respect-calendar')?.checked;
```

with a plain JS default matching the checkboxes' observed default state exactly (e.g. `opts.respectFixed ?? true` if they default checked — confirm the actual value before writing this, do not guess):

```js
const respectFixed = opts.respectFixed ?? true;    // matches index.html's #chk-respect-fixed default-checked state
const respectCalendar = opts.respectCalendar ?? true; // matches index.html's #chk-respect-calendar default-checked state
```

This removes Engine's only DOM dependency, making the module genuinely DOM-free as the ownership map claims. `OptimizeDialog`/`OptimizerPreview` (staying in `app.js`, unaffected) already pass both flags explicitly today, so this default is only ever reached via `Alerts.applyFix`'s auto-fix-overload call site (`Engine.runAndApply('combined', { lines: [line], startDate, endDate })`, no flags passed) — confirm this call site's resulting behavior is unchanged by testing it against the checkboxes' real default before and after.

- [ ] **Step 5: Extend the `app.js` bridge destructure**

```js
const { Calendar, Compute, Alerts, Utilization, Engine } = window.__NIMBUS_SERVICES;
```

- [ ] **Step 6: Update the compatibility inventory**

Close the `Engine` §6 row. Correct §1's `Engine` note from `"Optimizer + auto-reflow; no DOM"` to `"Optimizer + auto-reflow; genuinely DOM-free after Phase 2 removed a checkbox-read fallback (see Task 3 Step 4)."`

- [ ] **Step 7: Regenerate the contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 8: Commit**

```bash
git add web/schedule-services.mjs web/app.js web/schedule-state.mjs tests/modules/schedule-services.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Engine into schedule-services.mjs"
```

---

### Task 4: `schedule-data.mjs` — Persistence + CalendarSync, with the Services-Facing Seams

**Files:**
- Create: `web/schedule-data.mjs` (exports `Persistence`, `CalendarSync`)
- Create: `tests/modules/schedule-data.test.mjs`
- Modify: `web/app-entry.mjs` (bridge `schedule-data.mjs` as `window.__NIMBUS_DATA`, extend cleanup)
- Modify: `web/app.js` (delete the blocks; extend the bridge destructure; wire the new seam + event; fix the `SandboxAdapter`/`App`-boot private-consumer touches to stay working against the imported objects)
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (close `Persistence`/`CalendarSync` §6 rows; document the new `schedule:hydrated` event and `Persistence.setCalendarService` seam)

**Interfaces:**
- Produces: `Persistence.setCalendarService({ beginRun, endRun, nextAvailable, workWindow })` — the injected seam replacing 5 direct `Calendar.*` calls.
- Produces: a new Store event `{ type: 'schedule:hydrated', source }`, replacing 5 direct `Alerts.scheduleRecompute()` calls — `schedule-services.mjs` subscribes to it once (added in this task, since that's where the subscriber naturally lives once `Alerts` already exists there from Task 2).
- Consumes: `Store`, `Config`, `Util`, `ErrorLog`, `Toast`, `Sandbox` (Phase 1 modules).

- [ ] **Step 1: Write failing tests for the seam and the event**

Create `tests/modules/schedule-data.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Persistence, CalendarSync } from '../../web/schedule-data.mjs';
import { Store } from '../../web/schedule-state.mjs';

test('Persistence.setCalendarService is settable and Persistence works with a stub before it is wired', () => {
  assert.equal(typeof Persistence.setCalendarService, 'function');
  // A snap-affecting path should not throw even with no calendar service wired —
  // it should just skip snapping, not crash the load.
});

test('Persistence.saveAll still posts the documented payload shape (base_version/force/blocks/calendars)', () => {
  Store.setTasks([{ id: 'pd1', RUN_TIME: '1', start_date: new Date(), end_date: new Date(), row_version: '5' }], 'unit-test');
  Persistence._dirtyIds.add('pd1');
  const calls = [];
  // ... wire a fetch stub via whatever DI Persistence already exposes for
  // fetchTraced (Util.fetchTraced is already seam-based from Phase 1) ...
  Persistence.saveAll();
  // assert one /tasks/update call whose body.tasks[0] has start_date, end_date, base_version, force
});

test('a load that needs to snap a task to working hours calls the injected calendar service, not a global', () => {
  const calls = [];
  Persistence.setCalendarService({
    beginRun: (plant) => calls.push(['beginRun', plant]),
    endRun: () => calls.push(['endRun']),
    nextAvailable: (line, from, ms) => { calls.push(['nextAvailable', line]); return from; },
    workWindow: (line, date) => { calls.push(['workWindow', line]); return null; },
  });
  // ... trigger Persistence's snap path (via its own internal function if
  // exported for testing, or via a full load() call with a seeded fetch
  // stub) and assert calls.length > 0 with the expected method names.
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-data.test.mjs`

Expected: fails — `web/schedule-data.mjs` does not exist.

- [ ] **Step 3: Move `Persistence` and `CalendarSync`, replacing the 5+5 cross-package calls**

Locate `const Persistence = {` (banner ~line 11398, closing ~12476) and `const CalendarSync = {` (banner ~line 12490, closing ~12818). Move both verbatim into `schedule-data.mjs`, with these exact substitutions:

Replace every `Calendar._beginRun(plant)` / `Calendar._endRun()` / `Calendar.nextAvailable(...)` / `Calendar.workWindow(...)` call inside `Persistence._snapToWorkingHours`/`_dueEndOfShift` with the injected seam:

```js
let _calendarService = null;
export function _setCalendarServiceForTest(svc) { _calendarService = svc; } // internal alias, see note below
// ...
export const Persistence = {
  setCalendarService(svc) { _calendarService = svc; },
  // ...
  _snapToWorkingHours() {
    if (!_calendarService) return; // no-op until wired — matches "skip snapping" behavior when Calendar isn't available
    _calendarService.beginRun(plant);
    try {
      // ... replace Calendar.nextAvailable(...) with _calendarService.nextAvailable(...),
      // Calendar.workWindow(...) with _calendarService.workWindow(...), verbatim otherwise
    } finally {
      _calendarService.endRun();
    }
  },
  // ...
};
```

Replace every `Alerts.scheduleRecompute()` call (5 sites, inside `load()`'s two branches, `_loadCache()`, and `_loadDemo()`) with:

```js
Store.emit({ type: 'schedule:hydrated', source: 'persistence' });
```

- [ ] **Step 4: Wire the `schedule:hydrated` subscriber in `schedule-services.mjs`**

Back in `web/schedule-services.mjs` (Task 2 already added `Alerts` there), add a module-level subscription right after `Alerts` is defined:

```js
Store.subscribe(evt => {
  if (evt.type === 'schedule:hydrated') Alerts.scheduleRecompute();
}, 'schedule-services.hydrated');
```

This is the "small public method or post-commit event" resolution the design doc prescribes — `schedule-data.mjs` never imports `schedule-services.mjs`; it only emits a fact through `Store`, which `schedule-services.mjs` (a legitimate importer of `schedule-state.mjs`) is free to subscribe to.

- [ ] **Step 5: Wire `Persistence.setCalendarService` in `app.js` boot glue**

Immediately after the Task 1 bridge destructure line that introduces `Calendar`, add:

```js
Persistence.setCalendarService({
  beginRun: (plant) => Calendar._beginRun(plant),
  endRun: () => Calendar._endRun(),
  nextAvailable: (line, from, durationMs) => Calendar.nextAvailable(line, from, durationMs),
  workWindow: (line, date) => Calendar.workWindow(line, date),
});
```

(Arrow-function wrappers, not bare method references — `Calendar`'s methods read `this._runCache`/`this._runBlocks` internally, so they must be invoked with `Calendar` as the receiver; verify this by reading the moved methods' bodies before assuming bare references would work.)

- [ ] **Step 6: Bridge `schedule-data.mjs`, extend the destructure**

`app-entry.mjs`: add `import * as data from './schedule-data.mjs';`, `win.__NIMBUS_DATA = data;`, and the matching `delete win.__NIMBUS_DATA;` in the cleanup block.

`app.js`:
```js
const { Persistence, CalendarSync } = window.__NIMBUS_DATA;
```

(`Session` joins in Task 5.) Confirm `SandboxAdapter`'s `CalendarSync._deferredHydrationPlant` reads/writes (from Phase 1) and `App`'s boot-section `Persistence._dirtyIds`/`_forceIds`/`_autosave`/`_rememberedPlant` touches (found by inspection) all continue to resolve correctly against the now-imported objects — these were already real, intentional cross-module reaches (not fixed in Phase 1, tracked as expected same-worktree access, not `_state`-style leaks) and require no code change, only confirmation via the full test run.

- [ ] **Step 7: Update the compatibility inventory**

Close the `Persistence`/`CalendarSync` §6 rows. Add a new subsection documenting the `schedule:hydrated` event and `Persistence.setCalendarService` seam, matching the style of the existing Sandbox-event documentation from Phase 1.

- [ ] **Step 8: Regenerate the contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 9: Commit**

```bash
git add web/schedule-data.mjs web/schedule-services.mjs web/app-entry.mjs web/app.js tests/modules/schedule-data.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Persistence and CalendarSync into schedule-data.mjs"
```

---

### Task 5: Add Session (State/API); `SessionUIAdapter` in `app.js`

**Files:**
- Modify: `web/schedule-data.mjs` (add `Session`'s pure state/API)
- Modify: `web/app.js` (delete the `Session` IIFE's body; add `SessionUIAdapter`; wire a new `session:changed` event subscription; extend the bridge destructure)
- Modify: `tests/modules/schedule-data.test.mjs` (add coverage)
- Modify: `docs/architecture/cq1-compatibility-inventory.md`

**Interfaces:**
- Produces: `Session.currentUser()`, `.actor()`, `.isAdmin()`, `.allowedPlants()`, `.pref(key)`, `.setPref(key, value)`, `.flushPrefs()`, `.signIn(...)`, `.signOut()`, `.refresh()`, `.onAuthDenied()` — the DOM-triggering calls each become `Store.emit({type:'session:changed', kind, ...})` instead of calling `_applyGates()`/UI code inline.
- Produces (app.js): `SessionUIAdapter` subscribing to `session:changed`, owning `_applyGates`, `_renderUserButton`, the settings-pane rendering, `saveProfile`, `changePassword`, and everything else currently private inside the `Session` IIFE that touches DOM.
- Consumes: `Store`, `Config`, `Util`, `ErrorLog` (Phase 1 modules).

- [ ] **Step 1: Write failing tests**

Add to `tests/modules/schedule-data.test.mjs`:

```js
import { Session } from '../../web/schedule-data.mjs';

test('Session exposes only the pure session/pref API (no DOM-rendering methods)', () => {
  assert.equal(typeof Session.currentUser, 'function');
  assert.equal(typeof Session.actor, 'function');
  assert.equal(typeof Session.isAdmin, 'function');
  assert.equal(typeof Session.allowedPlants, 'function');
  assert.equal(typeof Session.pref, 'function');
  assert.equal(typeof Session.setPref, 'function');
  assert.equal(Session._renderUserButton, undefined);
  assert.equal(Session._renderSettingsPanes, undefined);
  assert.equal(Session.saveProfile, undefined);
});

test('Session.signIn emits a session:changed event instead of touching DOM directly', () => {
  const events = [];
  const off = Store.subscribe(evt => { if (evt.type === 'session:changed') events.push(evt); });
  // ... call Session.signIn with a stubbed fetchTraced success response ...
  off();
  assert.ok(events.some(e => e.kind === 'signin'));
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-data.test.mjs`

Expected: fails — `Session` isn't exported by `schedule-data.mjs` yet.

- [ ] **Step 3: Split `Session`'s IIFE**

Locate `const Session = (() => { ... })();` (currently ~line 4703, closing ~5520). This is the highest-uncertainty split of the phase — read the full current body before proceeding (do not trust the researched line numbers past Task 4's edits) and classify every closure member:

- Moves to `schedule-data.mjs`, verbatim: the pure state (`KEY`, `_prefTimer`, `_prefPending`, `_prefPrev`) and the returned-object methods that don't touch DOM (`currentUser`, `actor`, `isAdmin`, `allowedPlants`, `pref`, `setPref`, `flushPrefs`/`_flushPrefs` — confirm `_flushPrefs`'s body is DOM-free before moving; if it touches DOM, it stays in `app.js` instead and `flushPrefs` calls a `SessionUIAdapter` hook).
- `signIn(...)`, `signOut()`, `refresh()`, `onAuthDenied()` move to `schedule-data.mjs` too, but with their inline `_applyGates()` call replaced by `Store.emit({ type: 'session:changed', kind: 'signin'|'signout'|'refresh'|'auth-denied' })`.
- Everything else (`_applyGates`, `_renderUserButton`, `_showUserTab`, `_optTag`, `_repaintDisplayFormat`, `_htmlEsc`, `_landingTabDefs`, `_landingSubDefs`, `_renderPinnedList`, `_initPinnedCombo`, `_renderSettingsPanes`, `_renderPersonalizationPane`, `_initDefaultPlantCombo`, `_renderWorkflowPane`, `saveProfile`, `changePassword`) stays in `app.js` inside a new `SessionUIAdapter` object, subscribing once to `session:changed`:

```js
const SessionUIAdapter = {
  init() {
    Store.subscribe(evt => {
      if (evt.type !== 'session:changed') return;
      SessionUIAdapter._applyGates();
      if (evt.kind === 'refresh') {
        PlantSelector._refreshOptions();
        PlantSelector._reflectSelection();
        App.goto('home');
      }
    }, 'SessionUIAdapter');
  },
  // ... _applyGates, _renderUserButton, _showUserTab, _optTag,
  // _repaintDisplayFormat, _htmlEsc, _landingTabDefs, _landingSubDefs,
  // _renderPinnedList, _initPinnedCombo, _renderSettingsPanes,
  // _renderPersonalizationPane, _initDefaultPlantCombo,
  // _renderWorkflowPane, saveProfile, changePassword — moved verbatim from
  // the private closures inside the old Session IIFE, unchanged bodies.
};
```

- [ ] **Step 4: Wire `SessionUIAdapter.init()` at boot, replacing the inline `Session._applyGates()` call**

`_applyGates` no longer exists as a `Session` method — it moved to `SessionUIAdapter`. In `_bootMain()`, change its first line from `Session._applyGates();` to:

```js
SessionUIAdapter.init();
SessionUIAdapter._applyGates(); // covers the "already signed in on page load" resume path, which
                                // never goes through signIn() and so would never fire session:changed
```

Read the original call site's own comment (it explains the cached-session-resume vs. fresh-sign-in distinction) and confirm both paths still apply gates exactly once: the resume path via this explicit call, the fresh-sign-in path via `signIn()`'s new `session:changed` emit reaching the same `SessionUIAdapter._applyGates()` through the subscription registered in `init()`.

- [ ] **Step 5: Extend the bridge destructure**

```js
const { Persistence, CalendarSync, Session } = window.__NIMBUS_DATA;
```

- [ ] **Step 6: Update the compatibility inventory**

Add a `Session` entry documenting the split (pure API → `schedule-data.mjs`; DOM/gates/settings panes → `app.js`'s `SessionUIAdapter`; new `session:changed` event), matching the `Sandbox`/`SandboxAdapter` documentation style from Phase 1.

- [ ] **Step 7: Regenerate the contract, verify GREEN**

Run: `node scripts/legacy-surface.mjs --write && npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 8: Commit**

```bash
git add web/schedule-data.mjs web/app.js tests/modules/schedule-data.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Session state into schedule-data.mjs behind a SessionUIAdapter"
```

---

### Task 6: Phase 2 Completion — Documentation and Full Gate

**Files:**
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (final consistency pass — confirm all 8 modules read as migrated, all 5 §6 rows closed)
- Modify: `tests/README.md`
- Modify: `AGENTS.md` and `CLAUDE.md`

- [ ] **Step 1: Update the compatibility inventory's top status note**

Add, alongside the existing "Phase 1 status (complete)" note:

```markdown
**Phase 2 status (complete):** `schedule-services.mjs` (Calendar capacity math,
Compute, Alerts computation, Utilization, Engine) and `schedule-data.mjs`
(Persistence, CalendarSync, Session state/API) are real ES modules. DOM/UI
code stays in app.js as `CalendarUI`, `AlertsUIAdapter`, and
`SessionUIAdapter`, following the Phase 1 `SandboxAdapter` precedent. The
`schedule:hydrated` and `session:changed` events and the
`Persistence.setCalendarService` seam resolve the two real
data→services dependencies found during Phase 2 research.
```

- [ ] **Step 2: Update `tests/README.md` and `AGENTS.md`/`CLAUDE.md`**

Mirror the Phase 1 Task 6 pattern: one bullet in `tests/README.md` for the two new `.mjs` test files, one paragraph in each of `AGENTS.md`/`CLAUDE.md` documenting the two new modules and the `CalendarUI`/`AlertsUIAdapter`/`SessionUIAdapter` split.

- [ ] **Step 3: Run the full Phase 2 completion gate**

- [ ] `git diff --check`
- [ ] `npm run lint:ci`
- [ ] `npm test`
- [ ] `npm run check:legacy-surface`
- [ ] `npm run check:static-assets`
- [ ] Offline pytest regression check (no backend changes expected, but confirm)
- [ ] Grep `web/app.js` for the 8 old module declarations (`^  const Calendar = {`, `^  const Compute = `, `^  const Alerts = {`, `^  const Utilization = {`, `^  const Engine = {`, `^  const Persistence = {`, `^  const CalendarSync = {`, `^  const Session = `) — expect zero matches.
- [ ] Confirm `docs/architecture/cq1-compatibility-inventory.md` §6 no longer lists `Alerts`, `Utilization`, `Engine`, `Persistence`, or `CalendarSync` — only the 8 Phase 3/4 rows remain.
- [ ] Docker/browser boot smoke test if available; record as an unverified environment gate if not, per the established Phase 0/1 precedent.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/cq1-compatibility-inventory.md tests/README.md AGENTS.md CLAUDE.md
git commit -m "docs: close out CQ-1 Phase 2 services-and-data migration"
```

---

## Phase 2 Completion Gate

- [ ] All 6 tasks committed.
- [ ] Full verification suite green.
- [ ] `web/app.js` no longer contains its own definitions of `Calendar` (capacity math), `Compute`, `Alerts` (computation), `Utilization`, `Engine`, `Persistence`, `CalendarSync`, or `Session` (state/API) — all eight live only in `schedule-services.mjs`/`schedule-data.mjs`. `CalendarUI`, `AlertsUIAdapter`, and `SessionUIAdapter` hold the DOM remnants.
- [ ] The worker `postMessage`/`onmessage` envelope and every `nimbus-compute-core.js` call signature are byte-identical to before this phase (confirmed by `tests/js/*.test.js` continuing to pass unmodified).
- [ ] `schedule-data.mjs` contains no static import of `schedule-services.mjs` anywhere — the `schedule:hydrated` event and `Persistence.setCalendarService` seam are the only cross-module coupling in that direction.
- [ ] Compatibility inventory §6 has exactly the 8 Phase 3/4 rows remaining (`Timeline`, `Hierarchy`, `Dashboard`, `GanttFilter`, `DependencyOverlay`, `MasterData`, `App`, `nimbus-intelligence.js`).
- [ ] Docker/browser smoke test run if available; recorded as an unverified environment gate if not.
- [ ] Review the complete Phase 2 diff for security, behavior drift, and accidental scope creep before writing the Phase 3 extraction plan (workbench: `Timeline`, `Table`, `Inspector`, `Hierarchy`, `Dashboard`, `UtilStrip`, `TimelineNav`, `GanttFilter`, `DependencyOverlay`, `ContextMenu`, `Interaction`, `OptimizeDialog`, `OptimizerPreview`, `EditCalendar`, `ColorWheelViewer`, `Printer`, plus `CalendarUI`/`AlertsUIAdapter` finally landing in their permanent home per the ownership map).
</content>
