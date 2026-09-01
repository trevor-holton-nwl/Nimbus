# CQ-1 Phase 1: Foundation and State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `Config`, `Util`, `PerfMonitor`, `VirtualList`, `ErrorLog`, `Toast`, `Modal` into a real ES module `web/application-foundation.mjs`, and `Store`, `Selection`, `UndoStack`, `Sandbox` into a real ES module `web/schedule-state.mjs`, wired into `web/app.js` through a new ordered loader and temporary ESM entry point (`web/app-entry.mjs`) — with zero change to any externally-observable behavior (the legacy characterization suite and the `NIMBUS.*` public surface used by `index.html`/`nimbus-intelligence.js` stay green throughout).

**Architecture:** `app.js` today is one 20,566-line closure (`const NIMBUS = (function () { ... return {...}; })();`) containing ~32 sequential `const ModuleName = {...}` declarations that resolve each other lazily through shared closure scope. This phase surgically removes 11 of those declarations and relocates them into two real ES modules, then has `app.js` destructure them back from a temporary global bridge (`window.__NIMBUS_FOUNDATION`, `window.__NIMBUS_STATE`) at the very top of its own closure — so every one of the ~26 remaining modules' thousands of bare `Config.X` / `Store.method()` references keep resolving unchanged, with no edits to their bodies. `NIMBUS` itself stays a bare script-scope `const` (never `window.NIMBUS` — confirmed by inspection, `nimbus-intelligence.js` depends on the browser's shared classic-script lexical scope to see it), so `app.js` and `nimbus-intelligence.js` are deliberately **not** converted to `type="module"` this phase; only the loader and the two new modules are real ESM. Six call sites where an extracted module currently reaches into a not-yet-extracted module (`Session`, `Settings`, `Utilization`, `Alerts`, `Persistence`, `CalendarSync`, and cross-file `nimbus-intelligence.js`'s `Confidence`) are resolved with small injected-callback seams or post-commit events, per the design doc's own prescribed resolution ("A cycle is resolved through a post-commit event or a small public method") — never a `globalThis` reach-around and never an import that points the wrong direction in the module map.

**Tech Stack:** Native browser ES modules (no bundler), Node 20 built-in test runner (`node --test`) for both plain-ESM shape/behavior tests and the existing `node:vm` legacy characterization harness, ESLint 9 flat config (already covers `web/**/*.mjs`), Python 3.12/pytest/FastAPI (unaffected this phase — no backend changes).

## Global Constraints

- Preserve all current planner behavior, explicit Save semantics, optimistic-concurrency behavior, worker protocol, and UMD compute-core behavior. Nothing in Phase 1 touches `nimbus-worker.js` or `nimbus-compute-core.js`.
- `NIMBUS` remains a bare script-scope `const`, never assigned to `window`. Do not convert `app.js` or `nimbus-intelligence.js` to `type="module"` this phase — that is Phase 4 ("shell and intelligence bridge") work.
- No migration step may boot old and new implementations together. `application-foundation.mjs`/`schedule-state.mjs` become the **only** definition of each extracted module; the corresponding `const ModuleName = {...}` block is deleted from `app.js` in the same task that extracts it — never left in place "just in case."
- Imports flow downward only: `application-foundation.mjs` must never import from `schedule-state.mjs` or reference `Store`/`Selection`/`UndoStack`/`Sandbox`. Any call from a foundation module into a not-yet-extracted or higher-layer module (`Store`, `Session`, `Settings`, `Utilization`, `Alerts`, `Persistence`, `CalendarSync`, cross-file `Confidence`) becomes an injected-callback seam (a `setXResolver(fn)` method, defaulting to a safe no-op) wired exactly once in `app.js`, or (for Sandbox's side effects) a post-commit event consumed by a thin adapter left in `app.js`.
- Do not change `nimbus-compute-core.js`'s UMD wrapper pattern or add one to the new modules — `application-foundation.mjs`/`schedule-state.mjs` have no non-ESM consumer (confirmed: neither the worker nor compute-core reference any of the 11 extracted module names), so they are plain native ESM with a single `export` block, no `module.exports`/`importScripts` branch.
- `Store._state` and `Store._rev` remain real, readable/writable properties on the exported `Store` object — do **not** attempt to fully encapsulate them this phase. 15 consumer modules (`Alerts`, `Utilization`, `Engine`, `Timeline`, `Hierarchy`, `Dashboard`, `GanttFilter`, `DependencyOverlay`, `Persistence`, `CalendarSync`, `MasterData`, `App`, `ColorWheelViewer`, `OptimizeDialog`, `LaborPlanning`) plus `nimbus-intelligence.js` read/write these directly and are **not** migrated until Phase 2/3/4; breaking their access is out of scope and would be a regression, not a fix. Only fix a private-consumer violation in this phase when its caller is itself one of the 11 modules being moved (e.g. `Sandbox`'s own `Store._state.*` writes) — everything else gets tracked as a documented, still-open exception in the compatibility inventory.
- Every `.mjs` file already lints cleanly under the existing `eslint.config.js` `files: ['web/**/*.mjs']` block (`sourceType: 'module'`, browser globals) and is already picked up by `npm run lint:ci`'s `"web/**/*.mjs"` glob and by `npm run test:modules`'s `"tests/modules/*.test.mjs"` glob — **no `package.json` or `eslint.config.js` changes are needed in this phase.** Verify this assumption in Task 1's own verification step rather than assuming it silently.
- `.mjs` responses already carry `Cache-Control: no-cache` (Phase 0 Task 4's middleware) — internal `import './application-foundation.mjs'` specifiers inside the new modules deliberately carry **no** `?v=` query param; the no-cache header is the substitute cache-busting mechanism for those, per the design doc.
- Do not add inline scripts, inline event-handler attributes, or inline style attributes. The committed legacy allowlist (`tests/contracts/cq1-legacy-surface.json`) may only shrink.
- Regenerate `tests/contracts/cq1-legacy-surface.json` (`node scripts/legacy-surface.mjs --write`) in the same task that removes a tracked private-consumer/inline-handler entry — never batch contract regeneration into a later task, and never hand-edit the JSON file.
- **Line numbers cited below are absolute positions in `web/app.js` as it exists at the start of Task 1** (before any deletions). Every task after Task 1 deletes a block from `app.js`, which shifts every line below it upward for all subsequent tasks. Do not trust a later task's cited line number as a literal offset into the file at that point in execution — instead, locate the target block by its distinctive comment banner (e.g. `/* ===... STORE — single reactive source of truth ... === */`) or its exact `const ModuleName = {` / `class ModuleName {` opening line, confirm the matching closing brace by reading forward, and use the cited numbers only as an approximate locator and as a description of the block's original size/contents.

---

### Task 1: Ordered ESM Loader, Temporary Entry Point, and First Foundation Batch

**Files:**
- Create: `web/application-foundation.mjs` (exports `Config`, `PerfMonitor`, `VirtualList`, `Toast`, `Modal` — moved verbatim from `web/app.js`)
- Create: `web/app-entry.mjs`
- Create: `tests/modules/app-entry.test.mjs`
- Create: `tests/modules/foundation.test.mjs`
- Modify: `web/app.js` (delete lines 67–102 `Config`, 640–735 `VirtualList`, 737–797 `PerfMonitor`, 7067–7122 `Toast`, 7124–7162 `Modal`; add bridge gate + destructure at the top of the `NIMBUS` closure)
- Modify: `web/index.html` (bootstrap script, ~line 2774)
- Modify: `tests/modules/helpers/load-legacy-app.mjs` (pre-populate the foundation bridge; the exported function becomes `async`)
- Modify: `tests/modules/legacy-app-characterization.test.mjs` (all 6 tests `await loadLegacyApp(...)`)

**Interfaces:**
- Produces: `export function bootEntry({ window: win, loadScript } = {})` in `web/app-entry.mjs` — resolves a `Promise<void>` once `app.js` then `nimbus-intelligence.js` have loaded (in that order), rejecting with an actionable `Error` if either fails.
- Produces: `window.__NIMBUS_FOUNDATION` — the live `application-foundation.mjs` module namespace, assigned by `bootEntry` before either script loads.
- Consumed by: `web/app.js`'s top-of-file boot gate (throws if `window.__NIMBUS_FOUNDATION` is missing).

- [ ] **Step 1: Write a failing test for the loader's ordering contract**

Create `tests/modules/app-entry.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootEntry } from '../../web/app-entry.mjs';

test('bootEntry populates the foundation bridge before loading app.js', async () => {
  const fakeWindow = { NIMBUS_BUILD_ID: 'test-build' };
  const calls = [];
  const loadScript = (src) => { calls.push(src); return Promise.resolve(); };

  await bootEntry({ window: fakeWindow, loadScript });

  assert.ok(fakeWindow.__NIMBUS_FOUNDATION, 'bridge was not populated');
  assert.equal(typeof fakeWindow.__NIMBUS_FOUNDATION.Config, 'object');
  assert.equal(typeof fakeWindow.__NIMBUS_FOUNDATION.Toast, 'object');
  assert.deepEqual(
    calls.map(s => s.split('?')[0]),
    ['app.js', 'nimbus-intelligence.js'],
    'app.js must load, then resolve, before nimbus-intelligence.js is requested'
  );
});

test('bootEntry rejects with an actionable message when app.js fails to load', async () => {
  const fakeWindow = {};
  const loadScript = () => Promise.reject(new Error('404'));
  await assert.rejects(
    () => bootEntry({ window: fakeWindow, loadScript }),
    /app\.js/
  );
});

test('bootEntry does not request nimbus-intelligence.js if app.js fails', async () => {
  const fakeWindow = {};
  const calls = [];
  const loadScript = (src) => {
    calls.push(src);
    return src.startsWith('app.js') ? Promise.reject(new Error('boom')) : Promise.resolve();
  };
  await assert.rejects(() => bootEntry({ window: fakeWindow, loadScript }));
  assert.deepEqual(calls, ['app.js']);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/app-entry.test.mjs`

Expected: failure — `web/app-entry.mjs` does not exist yet.

- [ ] **Step 3: Move the first five foundation modules verbatim**

Using `git mv`-equivalent surgical edits (these stay inside `app.js` as a single file, so this is a cut-and-paste, not a file move): delete lines 67–102 (`Config`), 640–735 (`VirtualList`), 737–797 (`PerfMonitor`), 7067–7122 (`Toast`), 7124–7162 (`Modal`) from `web/app.js` verbatim, and create `web/application-foundation.mjs`:

```js
// application-foundation.mjs — CQ-1 foundation module.
// Owns immutable configuration, generic UI chrome (Toast/Modal), the perf
// profiler, and the virtual-list windowing helper. No schedule state, no
// feature endpoints, no scheduling rules. See docs/architecture/
// cq1-compatibility-inventory.md for the full module ownership map.

export const Config = {
  API_BASE:         (typeof window !== 'undefined' && window.NIMBUS_API_BASE) || '',
  STEP_MS:          15 * 60 * 1000,
  MS_MIN:           60 * 1000,
  MS_HOUR:          60 * 60 * 1000,
  MS_DAY:           24 * 60 * 60 * 1000,
  ANIM_MS:          220,
  DEFAULT_SHIFT:    [7, 19],
  WEEKEND_OFF:      true,
  TZ:               'America/New_York',
  COLORS: [
    '#b8791a', '#2d5f8c', '#4f7a3c', '#8b4c7e', '#b14a3e',
    '#3c6e7a', '#7a5a2a', '#5e498b', '#a8493a', '#4a7a5e'
  ],
  OVERLOAD_THRESHOLD: 1.0,
  WARN_THRESHOLD:     0.8,
  SHOW_NEAR_CAPACITY_ALERTS: false,
  LS_KEY:             'nimbus.state.v3',
  SCHEMA_VERSION:     4,
  BUILD_ID:           (typeof window !== 'undefined' && window.NIMBUS_BUILD_ID) || 'dev',
  DEFAULT_PLANT:      null,
  KNOWN_PLANTS:       ['5512', '1006'],
  CENTER_ON_CLICK:    true,
  DEBUG_BLOCKS:       true,
  CONCURRENCY_CHECK:  true,
};

export class VirtualList {
  // ... body identical to app.js lines 655–734 (constructor, update, _totalH,
  // _offsetOf, _paint, destroy) — copied verbatim, no changes.
}

export const PerfMonitor = (() => {
  // ... body identical to app.js lines 743–796 (record, time, stats, all,
  // clear, subscribe, _notify) — copied verbatim, no changes.
  return { record, time, stats, all, clear, subscribe };
})();

export const Toast = (function () {
  // ... body identical to app.js lines 7075–7121 (_scheduleRemoval, _remove,
  // _evictOne, show) — copied verbatim, no changes.
  return { show };
})();

export const Modal = {
  // ... body identical to app.js lines 7131–7161 (open, close, confirm) —
  // copied verbatim, no changes.
};
```

(The `// ...` comments above mark verbatim copy points — copy the exact bodies from the deleted `app.js` line ranges with no edits; do not paraphrase them.)

- [ ] **Step 4: Write the ordered loader entry point**

Create `web/app-entry.mjs`:

```js
// app-entry.mjs — CQ-1 temporary ESM entry point.
//
// Statically imports the extracted foundation module, bridges its exports
// onto `window.__NIMBUS_FOUNDATION`, then loads the still-legacy app.js and
// nimbus-intelligence.js as classic scripts, in that strict order. This file
// shrinks over Phase 2-4 as more of app.js's content moves into real modules,
// and disappears once app.js does.
import * as foundation from './application-foundation.mjs';

export function bootEntry({ window: win = (typeof window !== 'undefined' ? window : undefined), loadScript } = {}) {
  if (!win) return Promise.reject(new Error('NIMBUS boot error: no window available for bootEntry'));
  win.__NIMBUS_FOUNDATION = foundation;

  const inject = loadScript || defaultLoadScript;
  const v = win.NIMBUS_BUILD_ID || 'dev';

  return inject(`app.js?v=${encodeURIComponent(v)}`)
    .catch(e => { throw new Error(`NIMBUS boot error: failed to load app.js — ${e.message}`); })
    .then(() => inject(`nimbus-intelligence.js?v=${encodeURIComponent(v)}`))
    .catch(e => { throw new Error(`NIMBUS boot error: failed to load nimbus-intelligence.js — ${e.message}`); });
}

function defaultLoadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`script failed to load: ${src}`));
    document.head.appendChild(el);
  });
}

// Auto-boot when this module is the page's real entry point. Under a plain
// Node `import()` (as in tests), `window` is undefined, so this never fires —
// tests call `bootEntry({ window, loadScript })` explicitly instead.
if (typeof window !== 'undefined' && window.document) {
  bootEntry().catch(e => {
    console.error('[NIMBUS boot]', e);
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="background:#c0392b;color:#fff;padding:12px;font:14px monospace;">NIMBUS failed to load: ${(e && e.message) || e}</div>`);
  });
}
```

Note the two `.catch` re-throws produce the `/app\.js/` / distinguishable messages the Step 1 tests assert on.

- [ ] **Step 5: Verify the loader test is GREEN**

Run: `node --test tests/modules/app-entry.test.mjs`

Expected: all 3 tests pass.

- [ ] **Step 6: Write a failing shape test for the moved foundation modules**

Create `tests/modules/foundation.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, PerfMonitor, VirtualList, Toast, Modal } from '../../web/application-foundation.mjs';

test('Config exposes the documented constants', () => {
  assert.equal(Config.STEP_MS, 15 * 60 * 1000);
  assert.ok(Array.isArray(Config.COLORS));
  assert.equal(Config.COLORS.length, 10);
});

test('PerfMonitor records and reports timing stats', () => {
  PerfMonitor.clear();
  PerfMonitor.record('unit-test', 12);
  const stats = PerfMonitor.stats('unit-test');
  assert.equal(stats.count, 1);
  assert.equal(stats.last, 12);
});

test('PerfMonitor.stats returns null for an unknown name', () => {
  assert.equal(PerfMonitor.stats('does-not-exist'), null);
});

test('VirtualList exposes the documented instance methods', () => {
  assert.equal(typeof VirtualList, 'function');
  assert.equal(typeof VirtualList.prototype.update, 'function');
  assert.equal(typeof VirtualList.prototype.destroy, 'function');
});

test('Toast and Modal are present with their documented public methods', () => {
  assert.equal(typeof Toast.show, 'function');
  assert.equal(typeof Modal.open, 'function');
  assert.equal(typeof Modal.close, 'function');
  assert.equal(typeof Modal.confirm, 'function');
});
```

- [ ] **Step 7: Verify RED, then GREEN**

Run: `node --test tests/modules/foundation.test.mjs`

Expected: fails first (file doesn't exist until Step 3 lands — if run after Step 3, expect PASS immediately since the module already exists by this point). Confirm all 5 tests pass.

- [ ] **Step 8: Wire the bridge gate into `app.js`**

At the top of the `NIMBUS` closure in `web/app.js`, immediately after the existing `NimbusComputeCore` check (originally lines 63–65, now shifted up by the deleted `Config` block), add:

```js
if (typeof window === 'undefined' || !window.__NIMBUS_FOUNDATION) {
  throw new Error('NIMBUS boot error: application-foundation.mjs did not load before app.js — check app-entry.mjs.');
}
const { Config, PerfMonitor, VirtualList, Toast, Modal } = window.__NIMBUS_FOUNDATION;
```

(`Util` and `ErrorLog` are not yet destructured here — they still exist as local `const` blocks in `app.js` until Task 2. `Store`/`Selection`/`UndoStack`/`Sandbox` are untouched until Tasks 3–5.)

- [ ] **Step 9: Update `index.html`'s bootstrap script**

In `web/index.html`, replace the last two `document.write` lines (currently `nimbus-compute-core.js` stays, `app.js` and `nimbus-intelligence.js` both get written) — keep the `nimbus-compute-core.js` line unchanged, and replace the two lines that write `app.js` and `nimbus-intelligence.js` with one line:

```js
document.write('<script type="module" src="app-entry.mjs?v=' + encodeURIComponent(v) + '"><\/script>');
```

(`app-entry.mjs` itself now sequences loading `app.js` then `nimbus-intelligence.js` — see Step 4.)

- [ ] **Step 10: Update the legacy characterization harness to satisfy the new gate**

`web/app.js` now throws unless `window.__NIMBUS_FOUNDATION` exists before it runs. `tests/modules/helpers/load-legacy-app.mjs` must populate that before evaluating `app.js`'s source in the VM sandbox. Change its exported function to `async` and add, before the `runInContext` call:

```js
import * as foundation from '../../../web/application-foundation.mjs';
// ...
export async function loadLegacyApp({ fetchImpl, workerFactory, storageSeed = {} } = {}) {
  // ... existing sandbox construction unchanged ...
  sandbox.window.__NIMBUS_FOUNDATION = foundation;
  // ... existing runInContext(appSrc + '\nglobalThis.__NIMBUS__ = NIMBUS;\n', ctx) unchanged ...
}
```

- [ ] **Step 11: Update the 6 characterization tests to await the now-async harness**

In `tests/modules/legacy-app-characterization.test.mjs`, change the setup at the top from `const { nimbus, workerMessages, fetchCalls } = loadLegacyApp();` to `const { nimbus, workerMessages, fetchCalls } = await loadLegacyApp();`, and mark the enclosing `test(...)` callbacks `async` wherever they aren't already.

- [ ] **Step 12: Verify GREEN**

Run: `npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

Expected: all pass, no drift in `check:legacy-surface` (the `NIMBUS.Config`/`NIMBUS.Toast`/etc. surface exposed to `index.html`/`nimbus-intelligence.js` is byte-identical — only *how* `app.js` obtains these objects changed, not what it exposes).

- [ ] **Step 13: Commit**

```bash
git add web/application-foundation.mjs web/app-entry.mjs web/app.js web/index.html tests/modules/app-entry.test.mjs tests/modules/foundation.test.mjs tests/modules/helpers/load-legacy-app.mjs tests/modules/legacy-app-characterization.test.mjs
git commit -m "build: introduce the CQ-1 ESM loader and extract the first foundation batch"
```

---

### Task 2: Extend `application-foundation.mjs` with `Util` and `ErrorLog`

**Files:**
- Modify: `web/application-foundation.mjs` (add `Util`, `ErrorLog`, plus new DI-seam methods)
- Modify: `web/app.js` (delete `Util`/`ErrorLog` blocks; extend the foundation destructure; wire 5 DI seams; fix 2 tracked private-consumer violations)
- Modify: `tests/modules/foundation.test.mjs` (add `Util`/`ErrorLog` coverage)
- Modify: `tests/contracts/cq1-legacy-surface.json` (regenerate — 2 private-consumer entries are fixed this task)

**Interfaces:**
- Produces: `Util.setPreferenceResolver(fn)`, `Util.setActorResolver(fn)`, `Util.setUtilizationResolver(fn)`, `Util.locale()`, `Util.setLocale(lang)` — all default to safe no-ops/fallbacks matching today's try/catch-swallowed behavior when unset.
- Produces: `ErrorLog.setAdminGate(fn)`, `ErrorLog.setBadgeClickHandler(fn)`, `ErrorLog.renderBadge()` (renamed from `_renderBadge`, now public).
- Consumed by: `web/app.js`, wired once immediately after the foundation destructure.

- [ ] **Step 1: Write failing tests for the new DI seams**

Add to `tests/modules/foundation.test.mjs`:

```js
import { Util, ErrorLog } from '../../web/application-foundation.mjs';

test('Util.setPreferenceResolver changes what _timeFormatPref/_dateFormatPref read', () => {
  Util.setPreferenceResolver(key => ({ timeFormat: '24h', dateFormat: 'd/m/Y' }[key]));
  assert.equal(Util._timeFormatPref(), '24h');
  assert.equal(Util._dateFormatPref(), 'd/m/Y');
  Util.setPreferenceResolver(() => undefined); // reset
  assert.equal(Util._timeFormatPref(), '12h'); // documented fallback
});

test('Util.setLocale/locale round-trip and t() reads the active locale', () => {
  const prevLocale = Util.locale();
  globalThis.window = globalThis.window || {};
  window.__NIMBUS_LOCALES = { en: { 'greet.hi': 'Hi' }, fr: { 'greet.hi': 'Salut' } };
  Util.setLocale('fr');
  assert.equal(Util.locale(), 'fr');
  assert.equal(Util.t('greet.hi'), 'Salut');
  Util.setLocale(prevLocale);
});

test('ErrorLog.setAdminGate/setBadgeClickHandler are settable and default to safe no-ops', () => {
  assert.equal(typeof ErrorLog.setAdminGate, 'function');
  assert.equal(typeof ErrorLog.setBadgeClickHandler, 'function');
  assert.equal(typeof ErrorLog.renderBadge, 'function');
});

test('ErrorLog.info/warn/error record entries readable via entries()', () => {
  ErrorLog.clear();
  ErrorLog.warn('unit-test', 'hello', { x: 1 });
  const entries = ErrorLog.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'warn');
  assert.equal(entries[0].scope, 'unit-test');
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/foundation.test.mjs`

Expected: fails — `Util`/`ErrorLog` aren't exported by `application-foundation.mjs` yet.

- [ ] **Step 3: Move `Util` into `application-foundation.mjs` with its 3 injected-callback seams**

Delete lines 107–583 from `web/app.js` (the `Util` object body plus the trailing `window.t = (key, vars) => Util.t(key, vars);` glue line). Add to `web/application-foundation.mjs`:

```js
let _prefResolver = () => undefined;
let _actorResolver = () => undefined;
let _utilizationResolver = null;
let _locale = (typeof localStorage !== 'undefined' && localStorage.getItem('nimbus.locale')) || 'en';

export const Util = {
  setPreferenceResolver(fn) { _prefResolver = typeof fn === 'function' ? fn : () => undefined; },
  setActorResolver(fn) { _actorResolver = typeof fn === 'function' ? fn : () => undefined; },
  setUtilizationResolver(fn) { _utilizationResolver = typeof fn === 'function' ? fn : null; },
  locale() { return _locale; },
  setLocale(lang) { _locale = lang; },

  // ... parseDate, snap, dayKey, fmtDT, fmtBlockRange, mergedOverlapHours, fmtHours,
  // toLocalInput, toLocalSeconds, fpDatetime, clamp, norm, runHours, startOfDay,
  // addMin, uid, debounce, clone, fetchTraced, parseBackendError, sapDueDate,
  // scheduledEnd, impliedOriginalStart, latenessHours, countChangeovers,
  // scheduleKpis, t, reqEl, _stripExcelFloatSuffix, parsePasteList,
  // matchPasteToCheckboxes, wirePasteToCheckboxes, taskMatchesPasteSet,
  // countPasteMatches — copied verbatim from the deleted app.js Util block,
  // with exactly these three internal edits:
  //
  //   _timeFormatPref() {
  //     try { return _prefResolver('timeFormat') || '12h'; } catch { return '12h'; }
  //   },
  //   _dateFormatPref() {
  //     try { return _prefResolver('dateFormat') || 'M j, Y'; } catch { return 'M j, Y'; }
  //   },
  //   (both replace their old `Store.pref(...)` call)
  //
  //   fetchTraced(input, init = {}) {
  //     ...
  //     if (!headers.has('x-user-email') && !headers.has('X-User')) headers.set('x-user-email', _actorResolver());
  //     ... (replaces the old `Session.actor()` call, rest unchanged)
  //   },
  //
  //   scheduleKpis(tasks, horizonDays = 14) {
  //     ...
  //     try {
  //       if (!_utilizationResolver) throw new Error('utilization resolver not wired');
  //       const m = _utilizationResolver(new Date(), horizonDays, tasks);
  //       ... (rest unchanged, still falls through to `peak = 0` on any throw)
  //     } catch { /* matrix unavailable — leave peak at 0 */ }
  //     ...
  //   },
  //
  //   t(key, vars) {
  //     const dict = window.__NIMBUS_LOCALES?.[_locale] || {};
  //     const en   = window.__NIMBUS_LOCALES?.en || {};
  //     let str = dict[key] ?? en[key] ?? key;
  //     if (vars) str = str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  //     return str;
  //   },
  //
  // Every other method's body is unchanged from app.js lines 109–580.
};
```

- [ ] **Step 4: Move `ErrorLog` into `application-foundation.mjs` with its 2 injected-callback seams**

Delete lines 5892–6168 from `web/app.js` (the `ErrorLog` object body). Add to `application-foundation.mjs`:

```js
let _adminGate = () => false;
let _badgeClick = () => {};

export const ErrorLog = {
  setAdminGate(fn) { _adminGate = typeof fn === 'function' ? fn : () => false; },
  setBadgeClickHandler(fn) { _badgeClick = typeof fn === 'function' ? fn : () => {}; },

  // ... MAX, SESSION_ID, BREADCRUMB_MAX, breadcrumb, _push, info, warn, error,
  // _pushRecent, errorRatePerMin, warnRatePerMin, installGlobalHandlers,
  // entries, countBy, droppedCount, clear, subscribe, _openDb, _scheduleSave,
  // _saveNow, restore, _scheduleShip, _enqueueShip, _shipNow, SHIP_BATCH_MAX,
  // _safeCtx, copy — copied verbatim from the deleted app.js ErrorLog block,
  // with exactly these two edits:
  //
  //   renderBadge: Util.debounce(function () {     // renamed from _renderBadge
  //     if (!_adminGate()) {
  //       const existing = document.getElementById('err-log-btn');
  //       if (existing) existing.hidden = true;
  //       return;
  //     }
  //     let btn = document.getElementById('err-log-btn');
  //     if (!btn) {
  //       const host = document.getElementById('alert-bell')?.parentElement
  //                 || document.querySelector('.topbar-actions')
  //                 || document.body;
  //       btn = document.createElement('button');
  //       btn.id = 'err-log-btn';
  //       btn.className = 'icon-btn';
  //       btn.innerHTML = '<span class="log-ico" aria-hidden="true">🖥️</span>'
  //                      + '<span class="badge" id="err-log-badge" hidden>0</span>';
  //       btn.onclick = () => { try { _badgeClick(); } catch {} };   // replaces the old inline App.goto/AdminCockpit call
  //       host.appendChild(btn);
  //     }
  //     // ... rest of the badge-count rendering body unchanged
  //   }, 80),
  //
  // Every internal self-reference to `ErrorLog._renderBadge` (there are none —
  // it was only ever called externally) stays; every OTHER internal
  // self-reference (e.g. inside `copy()`, `_scheduleSave`) keeps using
  // `ErrorLog.xxx` exactly as before, now resolving within the same module.
};
```

- [ ] **Step 5: Extend the `app.js` foundation destructure and wire the 5 seams**

In `web/app.js`, change the Task 1 destructure line to:

```js
const { Config, Util, PerfMonitor, VirtualList, ErrorLog, Toast, Modal } = window.__NIMBUS_FOUNDATION;
```

Immediately after it, add:

```js
window.t = (key, vars) => Util.t(key, vars);
Util.setPreferenceResolver(key => Store.pref(key));
Util.setActorResolver(() => Session.actor());
Util.setUtilizationResolver((from, days, tasks) => Utilization.computeMatrix(from, days, tasks));
ErrorLog.setAdminGate(() => Session.isAdmin());
ErrorLog.setBadgeClickHandler(() => { App.goto('admin'); AdminCockpit.gotoOvTab('logs'); });
```

(These are safe forward references — each is a closure captured now but not *called* until well after `Store`/`Session`/`Utilization`/`App`/`AdminCockpit` are declared later in this same file, exactly like the lazy-resolution pattern the file already relied on before this refactor.)

- [ ] **Step 6: Fix the 2 tracked private-consumer violations this task closes**

In `web/app.js`:
- Inside `Session._applyGates()` (was line 6932): change `try { ErrorLog._renderBadge(); } catch {}` to `try { ErrorLog.renderBadge(); } catch {}`.
- Inside `_bootMain()` (was lines 20300–20301, 20484):
  ```js
  if (lang && lang !== Util.locale()) {
    Util.setLocale(lang);
    try { localStorage.setItem('nimbus.locale', lang); } catch {}
  }
  ```
  and
  ```js
  ErrorLog.renderBadge();
  ```

- [ ] **Step 7: Regenerate the legacy-surface contract**

Run: `node scripts/legacy-surface.mjs --write`

Expected diff: `privateConsumers` shrinks by exactly `Util._locale` (write) and `ErrorLog._renderBadge` (the two call sites collapse to zero since both now call the public `renderBadge`).

- [ ] **Step 8: Verify GREEN**

Run: `npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 9: Commit**

```bash
git add web/application-foundation.mjs web/app.js tests/modules/foundation.test.mjs tests/contracts/cq1-legacy-surface.json
git commit -m "build: extract Util and ErrorLog into application-foundation.mjs"
```

---

### Task 3: Introduce `schedule-state.mjs` with `Store`

**Files:**
- Create: `web/schedule-state.mjs` (exports `Store` for now)
- Create: `tests/modules/schedule-state.test.mjs`
- Modify: `web/app-entry.mjs` (bridge `schedule-state.mjs` too)
- Modify: `tests/modules/app-entry.test.mjs` (assert the state bridge as well)
- Modify: `web/app.js` (delete `Store`; extend bridge gate/destructure; wire 2 new DI seams; rename `_rebuildPlantIndex` → `rebuildPlantIndex` at all 6 call sites)
- Modify: `tests/modules/helpers/load-legacy-app.mjs` (bridge `schedule-state.mjs` too)
- Modify: `tests/contracts/cq1-legacy-surface.json` (regenerate)
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (mark `Store` migrated; document the `Store._state`/`_rev` exception list)

**Interfaces:**
- Produces: `Store.rev()`, `Store.mode()`, `Store.rebuildPlantIndex()` (renamed, was `_rebuildPlantIndex`), `Store.replaceBlocks(blocks, source)`, `Store.replaceCalendars(calendars, source)`, `Store.replacePlants(plants, source)`, `Store.replacePlantBlocks(plantBlocks, source)`, `Store.replaceFixedIds(idSet, source)`, `Store.setAllowedPlantsResolver(fn)`, `Store.setSettingsDefaultsResolver(fn)`.
- Consumes: `Config`, `Util`, `PerfMonitor`, `ErrorLog` from `application-foundation.mjs`.
- Every emitted event now additionally carries `revision` (the post-increment `_rev`) and `mode` (`'live'` or `'draft'` — `'draft'` once Task 5's `Sandbox.active` exists; until then `mode()` always returns `'live'`). Existing listeners that only read `evt.type`/`evt.source`/etc. are unaffected — this is purely additive.

- [ ] **Step 1: Write failing tests for the new Store surface**

Create `tests/modules/schedule-state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../web/schedule-state.mjs';

test('Store.rev() starts at 0 and increments on every mutation', () => {
  const before = Store.rev();
  Store.setTasks([], 'unit-test');
  assert.equal(Store.rev(), before + 1);
});

test('Store.mode() defaults to live', () => {
  assert.equal(Store.mode(), 'live');
});

test('emitted events carry revision and mode', () => {
  let seen = null;
  const off = Store.subscribe(evt => { seen = evt; });
  Store.setTasks([], 'unit-test');
  off();
  assert.equal(typeof seen.revision, 'number');
  assert.equal(seen.mode, 'live');
});

test('Store.rebuildPlantIndex is public (renamed from _rebuildPlantIndex)', () => {
  assert.equal(typeof Store.rebuildPlantIndex, 'function');
  assert.doesNotThrow(() => Store.rebuildPlantIndex());
});

test('Store.replaceBlocks/replaceCalendars/replacePlants/replacePlantBlocks/replaceFixedIds replace wholesale and emit', () => {
  const events = [];
  const off = Store.subscribe(evt => events.push(evt.type));
  Store.replaceBlocks([{ id: 'b1' }], 'unit-test');
  Store.replaceCalendars({ L1: { workHours: {} } }, 'unit-test');
  Store.replacePlants({ '5512': { workHours: {} } }, 'unit-test');
  Store.replacePlantBlocks([{ id: 'pb1' }], 'unit-test');
  Store.replaceFixedIds(new Set(['t1']), 'unit-test');
  off();
  assert.deepEqual(Store.blocks, [{ id: 'b1' }]);
  assert.deepEqual(Store.plantBlocks, [{ id: 'pb1' }]);
  assert.ok(Store.fixedIds.has('t1'));
  assert.deepEqual(events, ['blocks:replace', 'calendar:replace', 'plants:replace', 'plantBlocks:replace', 'fixed:replace']);
});

test('Store.setAllowedPlantsResolver scopes knownPlants()', () => {
  Store.setTasks([{ id: 't1', PRODUCTION_LINE: 'L1', RUN_TIME: '1' }], 'unit-test');
  Store.setAllowedPlantsResolver(() => ['5512']);
  const known = Store.knownPlants();
  assert.ok(known.includes('5512') || known.length === 0); // scoped set never includes a disallowed plant
  Store.setAllowedPlantsResolver(() => null); // reset — no scoping
});

test('Store.setSettingsDefaultsResolver feeds Store.pref()\'s fallback tier', () => {
  Store.setSettingsDefaultsResolver(() => ({ landingView: 'dashboard' }));
  assert.equal(Store.pref('landingView'), 'dashboard');
  Store.setSettingsDefaultsResolver(() => ({})); // reset
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-state.test.mjs`

Expected: failure — `web/schedule-state.mjs` does not exist.

- [ ] **Step 3: Move `Store` into `schedule-state.mjs`**

Delete lines 809–1328 from `web/app.js`. Create `web/schedule-state.mjs`:

```js
// schedule-state.mjs — CQ-1 schedule-state module.
// Owns schedule state, derived indexes, selection, undo, sandbox snapshots,
// and synchronous post-commit events. Every mutator takes a `source` and
// every emitted event carries {type, source, revision, mode, ...}. See
// docs/architecture/cq1-compatibility-inventory.md for the full contract.
import { Config, Util, PerfMonitor, ErrorLog } from './application-foundation.mjs';

let _allowedPlantsResolver = () => null;
let _settingsDefaultsResolver = () => ({});

export const Store = {
  _tasksByPlant: {},
  _lineToPlant: {},
  _linesByPlant: {},
  _masterLinesByPlant: {},
  _state: {
    tasks: {}, dependencies: {}, calendars: {}, blocks: [], alerts: [],
    fixedIds: new Set(), meta: { lastOptimize: null }, plants: {}, plantBlocks: [],
    lineSettings: {}, selectedPlant: null, masterData: null,
    userSettings: { alertHorizonMinutes: null, confidenceHorizonMinutes: 20160 },
    roleDefaults: {},
  },
  _listeners: new Set(),

  setAllowedPlantsResolver(fn) { _allowedPlantsResolver = typeof fn === 'function' ? fn : () => null; },
  setSettingsDefaultsResolver(fn) { _settingsDefaultsResolver = typeof fn === 'function' ? fn : () => ({}); },
  rev() { return this._rev || 0; },
  mode() { return (typeof Sandbox !== 'undefined' && Sandbox.active) ? 'draft' : 'live'; },

  // ... get state/tasks/blocks/alerts/calendars/fixedIds/tasksArr/plants/
  // plantBlocks/lineSettings/selectedPlant/userSettings/roleDefaults,
  // isFixed, subscribe — copied verbatim from the deleted app.js Store block
  // (lines 833-854), no changes.

  emit(event) {
    this._rev = (this._rev || 0) + 1;
    const enriched = { ...event, revision: this._rev, mode: this.mode() };
    for (const l of this._listeners) {
      const _t = performance.now();
      try { l(enriched); } catch (e) { console.error('[Store] listener error:', e); }
      finally { PerfMonitor.record('store:' + (l._pmLabel || l.name || '?'), performance.now() - _t); }
    }
  },

  // ... setTasks, updateTask, removeTask, updateMany, setFixed, setCalendar,
  // ensureCalendar, addBlock, removeBlock, ensurePlant, setPlantWorkHours,
  // clampLinesToPlant, addPlantBlock, removePlantBlock, ensureLineSettings,
  // setLineSetting, getPlantForLine, setSelectedPlant, tasksByPlant, allLines,
  // tasksForSelectedPlant, linesForSelectedPlant, masterLinesForPlant,
  // setAlerts, dismissAlert, dismissAllAlerts, alertsByTask, setUserSettings,
  // setRoleDefaults — copied verbatim from the deleted app.js Store block
  // (lines 869-1293), no changes except every internal `ErrorLog`/`Config`/
  // `Util` reference now resolves via the static import above instead of
  // shared-closure scope (same identifiers, same behavior).

  rebuildPlantIndex() {
    // ... body identical to the deleted app.js `_rebuildPlantIndex` (lines
    // 1129-1161), renamed only.
  },

  replaceBlocks(blocks, source) { this._state.blocks = blocks; this.emit({ type: 'blocks:replace', source }); },
  replaceCalendars(calendars, source) { this._state.calendars = calendars; this.emit({ type: 'calendar:replace', source }); },
  replacePlants(plants, source) { this._state.plants = plants; this.emit({ type: 'plants:replace', source }); },
  replacePlantBlocks(plantBlocks, source) { this._state.plantBlocks = plantBlocks; this.emit({ type: 'plantBlocks:replace', source }); },
  replaceFixedIds(idSet, source) {
    this._state.fixedIds = new Set([...idSet]);
    for (const id of this._state.fixedIds) {
      const t = this._state.tasks[id];
      if (t) t.fixed = true;
    }
    this.emit({ type: 'fixed:replace', source });
  },

  knownPlants() {
    const masterPlants = this._state.masterData?.plants?.map(p => p.plant) ?? [];
    let all;
    if (masterPlants.length) {
      all = [...new Set(masterPlants)].sort();
    } else {
      const dynamic = [];
      for (const line of this.allLines()) {
        const p = this.getPlantForLine(line);
        if (p) dynamic.push(p);
      }
      all = [...new Set([...Config.KNOWN_PLANTS, ...dynamic])].sort();
    }
    const allowed = _allowedPlantsResolver();
    return allowed ? all.filter(p => allowed.includes(p)) : all;
  },

  pref(key, opts = {}) {
    try {
      const us   = this._state.userSettings || {};
      const rd   = this._state.roleDefaults || {};
      const defs = _settingsDefaultsResolver() || {};
      return us[key] ?? rd[key] ?? defs[key];
    } catch { return undefined; }
  },

  _reindexTask(prev, next) {
    // ... body identical to the deleted app.js `_reindexTask` (lines 1165-1185).
  },
  _normalizeDates(task) {
    // ... body identical to the deleted app.js `_normalizeDates` (lines
    // 1315-1327), no changes (still references `Util.parseDate`/`Util.snap`,
    // now resolved via the static import).
  },
};
```

(`Store.mode()` references `Sandbox` via a bare identifier that doesn't exist yet in this file until Task 5 adds it as a sibling `const` in the same module — this is the same same-module lazy-closure-reference pattern the original file used throughout, and is safe because `mode()` is never *called* until well after module evaluation completes. Until Task 5 lands, `typeof Sandbox !== 'undefined'` is false and `mode()` always returns `'live'`, matching this task's own test expectations.)

- [ ] **Step 4: Bridge `schedule-state.mjs` from `app-entry.mjs`**

In `web/app-entry.mjs`, add:

```js
import * as state from './schedule-state.mjs';
```

and inside `bootEntry`, alongside the foundation assignment:

```js
win.__NIMBUS_STATE = state;
```

Add to `tests/modules/app-entry.test.mjs`:

```js
test('bootEntry populates the state bridge too', async () => {
  const fakeWindow = {};
  await bootEntry({ window: fakeWindow, loadScript: () => Promise.resolve() });
  assert.ok(fakeWindow.__NIMBUS_STATE);
  assert.equal(typeof fakeWindow.__NIMBUS_STATE.Store, 'object');
});
```

- [ ] **Step 5: Extend the `app.js` bridge gate and destructure**

Replace the Task 1 gate/destructure in `web/app.js` with:

```js
if (typeof window === 'undefined' || !window.__NIMBUS_FOUNDATION || !window.__NIMBUS_STATE) {
  throw new Error('NIMBUS boot error: application-foundation.mjs/schedule-state.mjs did not load before app.js — check app-entry.mjs.');
}
const { Config, Util, PerfMonitor, VirtualList, ErrorLog, Toast, Modal } = window.__NIMBUS_FOUNDATION;
const { Store } = window.__NIMBUS_STATE;
```

(`Selection`, `UndoStack`, `Sandbox` join this destructure in Tasks 4–5.)

- [ ] **Step 6: Wire the 2 new Store DI seams**

Alongside the Task 2 seam wiring, add:

```js
Store.setAllowedPlantsResolver(() => Session.allowedPlants());
Store.setSettingsDefaultsResolver(() => Settings.DEFAULTS);
```

- [ ] **Step 7: Rename all 6 `_rebuildPlantIndex` call sites**

In `web/app.js`, change every `Store._rebuildPlantIndex()` to `Store.rebuildPlantIndex()`: inside `Persistence` (3 call sites), inside `CalendarSync.fetchPlantConfig` (1 call site), inside `MasterData` (1 call site), inside `_bootMain` (1 call site). Grep to confirm zero remaining:

Run: `grep -n "_rebuildPlantIndex" web/app.js`

Expected: no matches.

- [ ] **Step 8: Update `load-legacy-app.mjs` to bridge state too**

Alongside the Task 1 foundation import, add:

```js
import * as state from '../../../web/schedule-state.mjs';
// ...
sandbox.window.__NIMBUS_STATE = state;
```

- [ ] **Step 9: Regenerate the legacy-surface contract**

Run: `node scripts/legacy-surface.mjs --write`

Expected diff: `privateConsumers` loses every `Store._rebuildPlantIndex` entry (renamed to public); `Store._state`/`Store._rev` entries from the 15 untouched consumer modules remain present (unchanged, still open — do not expect or force these to disappear).

- [ ] **Step 10: Update the compatibility inventory**

In `docs/architecture/cq1-compatibility-inventory.md`, under §1 Module Ownership Map, mark `Store` as migrated to `schedule-state.mjs` (already listed there — no row change needed). Add a new §6 section:

```markdown
## 6. Open Store Encapsulation Exceptions (tracked, not fixed in Phase 1)

`Store._state` and `Store._rev` remain real, physically-present properties on
the exported `Store` object — required for backward compatibility with
consumers not yet migrated. Remove each row below only when its owning
module migrates in a later phase and stops touching these fields directly.

| Consumer | Touches | Migrates in |
|---|---|---|
| `Alerts` | `Store._rev`, `Store._state` | Phase 2 (schedule-services.mjs) |
| `Utilization` | `Store._rev` | Phase 2 (schedule-services.mjs) |
| `Engine` | `Store._state` | Phase 2 (schedule-services.mjs) |
| `Persistence` | `Store._state` | Phase 2 (schedule-data.mjs) |
| `CalendarSync` | `Store._state` | Phase 2 (schedule-data.mjs) |
| `Timeline` | `Store._state` | Phase 3 (schedule-workbench.mjs) |
| `Hierarchy` | `Store._rev` | Phase 3 (schedule-workbench.mjs) |
| `Dashboard` | `Store._rev`, `Store._state` | Phase 3 (schedule-workbench.mjs) |
| `GanttFilter` | `Store._state` | Phase 3 (schedule-workbench.mjs) |
| `DependencyOverlay` | `Store._state` | Phase 3 (schedule-workbench.mjs) |
| `MasterData` | `Store._state` | Phase 3 (plant-and-administration.mjs) |
| `App` | `Store._state` | Phase 4 (application-shell.mjs) |
| `nimbus-intelligence.js` | `Store._rev`, `Store._state` | Phase 4 (intelligence bridge) |

`Store.rev()` and the new `Store.replace*` setters are available now as the
migration target for each row above — use them instead of `_rev`/`_state`
when a consumer's turn comes.
```

- [ ] **Step 11: Verify GREEN**

Run: `npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

- [ ] **Step 12: Commit**

```bash
git add web/schedule-state.mjs web/app-entry.mjs web/app.js tests/modules/schedule-state.test.mjs tests/modules/app-entry.test.mjs tests/modules/helpers/load-legacy-app.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Store into schedule-state.mjs"
```

---

### Task 4: Move `Selection` and `UndoStack` into `schedule-state.mjs`

**Files:**
- Modify: `web/schedule-state.mjs` (add `Selection`, `UndoStack`)
- Modify: `web/app.js` (delete both blocks; extend the state destructure)
- Modify: `tests/modules/schedule-state.test.mjs` (add coverage)

**Interfaces:**
- Produces: `Selection.selectedRefs()` — new additive method returning `{ plant, id }[]`, resolved via `Store.tasks[id]?.plant`. Existing bare-ID methods (`ids()`, `set()`, `add()`, `remove()`, `toggle()`, `has()`, `selectRange()`, `stats()`, `on()`) are unchanged — `Interaction` (the sole consumer) doesn't migrate until Phase 3, so its calls keep working as-is.
- Consumes: `Store` (already in the same module, same-file reference), `Util`, `ErrorLog`, `Toast` from `application-foundation.mjs` (`UndoStack.pop()` needs `Toast.show`/`t(...)` — see seam below).

- [ ] **Step 1: Write failing tests**

Add to `tests/modules/schedule-state.test.mjs`:

```js
import { Selection, UndoStack } from '../../web/schedule-state.mjs';

test('Selection tracks ids and selectedRefs() resolves plant per id', () => {
  Store.setTasks([{ id: 'sel1', plant: '5512', PRODUCTION_LINE: 'L1', RUN_TIME: '1' }], 'unit-test');
  Selection.clear();
  Selection.add(['sel1']);
  assert.deepEqual(Selection.ids(), ['sel1']);
  assert.deepEqual(Selection.selectedRefs(), [{ plant: '5512', id: 'sel1' }]);
  Selection.clear();
});

test('UndoStack.push caps at MAX(10) entries', () => {
  for (let i = 0; i < 12; i++) UndoStack.push(`entry-${i}`, () => {});
  assert.ok(UndoStack._entries.length <= UndoStack.MAX);
});

test('UndoStack.snapshotTasks/restoreTasks round-trip through Store', () => {
  Store.setTasks([{ id: 'u1', RUN_TIME: '2', start_date: new Date('2026-01-01') }], 'unit-test');
  const snap = UndoStack.snapshotTasks(['u1']);
  Store.updateTask('u1', { RUN_TIME: '9' }, 'unit-test');
  UndoStack.restoreTasks(snap);
  assert.equal(Store.tasks['u1'].RUN_TIME, '2');
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-state.test.mjs`

Expected: fails — `Selection`/`UndoStack` aren't exported yet.

- [ ] **Step 3: Move `Selection` (with the additive `selectedRefs()`) into `schedule-state.mjs`**

Delete lines 11307–11411 from `web/app.js` (the `Selection` object plus its co-located `_setsEqual` helper). Add to `schedule-state.mjs`:

```js
export const Selection = {
  _ids: new Set(),
  _anchor: null,
  _listeners: new Set(),

  // ... ids, has, size, clear, set, add, remove, toggle, selectRange, stats,
  // on, _emit — copied verbatim from the deleted app.js Selection block
  // (lines 11313-11404), no changes.

  selectedRefs() {
    return [...this._ids].map(id => ({ plant: Store.tasks[id]?.plant ?? null, id }));
  },
};

function _setsEqual(a, b) {
  // ... body identical to the deleted app.js `_setsEqual` (lines 11408-11411).
}
```

- [ ] **Step 4: Move `UndoStack` into `schedule-state.mjs`**

Delete lines 11417–11443 from `web/app.js`. `UndoStack.pop()` calls `Toast.show`/the global `t(...)` — both now come from `application-foundation.mjs` (`Toast` is already imported; add `Util` to the same import if not already present, and call `Util.t` directly instead of the bare `t(...)` global, since `schedule-state.mjs` has no `window.t` glue):

```js
import { Config, Util, PerfMonitor, ErrorLog, Toast } from './application-foundation.mjs';
// ...
export const UndoStack = {
  MAX: 10,
  _entries: [],

  push(label, undoFn) {
    this._entries.push({ label, undoFn, at: Date.now() });
    if (this._entries.length > this.MAX) this._entries.shift();
  },
  pop() {
    const e = this._entries.pop();
    if (!e) return null;
    try { e.undoFn(); Toast.show(Util.t('toast.undone', { label: e.label }), 'success'); }
    catch (err) { ErrorLog.error('undo', `${e.label}: ${err.message}`); }
    return e;
  },
  snapshotTasks(ids) {
    return ids.map(id => {
      const t = Store.tasks[id];
      return t ? structuredClone(t) : null;
    }).filter(Boolean);
  },
  restoreTasks(snapshot) {
    const patches = snapshot.map(s => ({ id: s.id, changes: s }));
    Store.updateMany(patches, 'undo');
  },
};
```

- [ ] **Step 5: Extend the `app.js` state destructure**

```js
const { Store, Selection, UndoStack } = window.__NIMBUS_STATE;
```

(`Sandbox` joins in Task 5.)

- [ ] **Step 6: Verify GREEN**

Run: `npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

Expected: no legacy-surface drift — `UndoStack.pop()`'s switch from the bare `t(...)` global to `Util.t(...)` is a pure internal call-style change with identical output, and `NIMBUS.Selection`/`NIMBUS.UndoStack`'s exposed public shape is unchanged (`selectedRefs` is additive, doesn't remove anything the scanner already recorded).

- [ ] **Step 7: Commit**

```bash
git add web/schedule-state.mjs web/app.js tests/modules/schedule-state.test.mjs
git commit -m "build: extract Selection and UndoStack into schedule-state.mjs"
```

---

### Task 5: Move Sandbox's State Logic into `schedule-state.mjs`; Leave a Thin UI Adapter in `app.js`

**Files:**
- Modify: `web/schedule-state.mjs` (add a state-only `Sandbox`: `active`, `enter(source)`, `exit(apply, source)` — no DOM, no `Toast`, no `t()`, no cross-phase calls)
- Modify: `web/app.js` (delete the old `Sandbox` block; add a `SandboxAdapter` that owns the DOM banner/buttons and subscribes to the new `sandbox:entered`/`sandbox:exited` events to perform the side effects — `Alerts.scheduleRecompute()`, `Persistence.saveAll()`, `CalendarSync.flushPlant`/`fetchPlantConfig`, `NIMBUS.Confidence` snapshot/restore, `Toast` messages — that used to be inline in `Sandbox.exit()`; extend the state destructure and wire `SandboxAdapter.init()` in `_bootMain()` where `Sandbox.init()` used to be called)
- Modify: `tests/modules/schedule-state.test.mjs` (add coverage)
- Modify: `tests/modules/legacy-app-characterization.test.mjs` (existing `Sandbox.enter` callable-surface assertion in test 6 stays valid unchanged — verify, don't rewrite)

**Interfaces:**
- Produces: `Sandbox.enter(source)` → `boolean` (false if already active); `Sandbox.exit(apply, source)` → the pre-sandbox snapshot object (or `null` if not active), for the caller to diff against.
- Produces: two new event types on `Store.emit`: `{ type: 'sandbox:entered', source }` and `{ type: 'sandbox:exited', applied, source, snapshot }`.
- Consumes: `Store.tasksArr/blocks/calendars/plants/plantBlocks/fixedIds` (getters, same module), `Util.clone`, `Store.setTasks`/`Store.replaceBlocks`/`Store.replaceCalendars`/`Store.replacePlants`/`Store.replacePlantBlocks`/`Store.replaceFixedIds`, `UndoStack.push`.

- [ ] **Step 1: Write failing tests for the state-only Sandbox**

Add to `tests/modules/schedule-state.test.mjs`:

```js
import { Sandbox } from '../../web/schedule-state.mjs';

test('Sandbox.enter snapshots current state and flips active/mode', () => {
  Store.setTasks([{ id: 'sb1', RUN_TIME: '1' }], 'unit-test');
  assert.equal(Store.mode(), 'live');
  const entered = Sandbox.enter('unit-test');
  assert.equal(entered, true);
  assert.equal(Sandbox.active, true);
  assert.equal(Store.mode(), 'draft');
  Sandbox.exit(false, 'unit-test');
});

test('Sandbox.enter is a no-op (returns false) when already active', () => {
  Sandbox.enter('unit-test');
  assert.equal(Sandbox.enter('unit-test'), false);
  Sandbox.exit(false, 'unit-test');
});

test('Sandbox.exit(false) restores the pre-enter snapshot and emits sandbox:exited', () => {
  Store.setTasks([{ id: 'sb2', RUN_TIME: '1' }], 'unit-test');
  Store.setFixed('sb2', true, 'unit-test');
  Sandbox.enter('unit-test');
  Store.setFixed('sb2', false, 'unit-test');
  const events = [];
  const off = Store.subscribe(evt => events.push(evt));
  const snap = Sandbox.exit(false, 'unit-test');
  off();
  assert.ok(Store.isFixed('sb2'), 'discard must restore the pre-sandbox fixed flag');
  assert.equal(Sandbox.active, false);
  assert.equal(Store.mode(), 'live');
  const exitEvt = events.find(e => e.type === 'sandbox:exited');
  assert.equal(exitEvt.applied, false);
  assert.equal(exitEvt.snapshot, snap);
});

test('Sandbox.exit(true) pushes exactly one UndoStack entry and emits applied:true', () => {
  Store.setTasks([{ id: 'sb3', RUN_TIME: '1' }], 'unit-test');
  Sandbox.enter('unit-test');
  const before = UndoStack._entries.length;
  const events = [];
  const off = Store.subscribe(evt => events.push(evt));
  Sandbox.exit(true, 'unit-test');
  off();
  assert.equal(UndoStack._entries.length, before + 1);
  const exitEvt = events.find(e => e.type === 'sandbox:exited');
  assert.equal(exitEvt.applied, true);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/schedule-state.test.mjs`

Expected: fails — `Sandbox` isn't exported by `schedule-state.mjs` yet.

- [ ] **Step 3: Move Sandbox's state logic into `schedule-state.mjs`**

Delete lines 11851–11982 from `web/app.js`. Add to `schedule-state.mjs`:

```js
export const Sandbox = {
  active: false,
  _snapshot: null,

  enter(source) {
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

  exit(apply, source) {
    if (!this.active) return null;
    const snap = this._snapshot;

    if (apply) {
      UndoStack.push('Discard What-If scenario', () => {
        Store.setTasks(snap.tasks, 'undo');
        Store.replaceFixedIds(snap.fixedIds, 'undo');
        Store.emit({ type: 'sandbox:reverted', source: 'undo' });
      });
    } else {
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
```

(`Store.mode()`, added in Task 3, now resolves `Sandbox.active` for real — `typeof Sandbox !== 'undefined'` is true from this task on, since both are top-level `const`s in the same module.)

- [ ] **Step 4: Add the `SandboxAdapter` in `app.js`, replacing the old DOM/side-effect code**

In `web/app.js`, in place of the deleted `Sandbox` block, add (this is new code, not a move — it's the thin UI/cross-module layer the design's ownership map calls out as belonging to `schedule-workbench.mjs` eventually; for Phase 1 it stays here as a boot-wired adapter):

```js
const SandboxAdapter = {
  _confSnapshot: null,

  init() {
    const banner = document.getElementById('sandbox-banner');
    if (!banner) return;
    banner.innerHTML = `
      <span style="font-size:14px;">🔮</span>
      <strong>${t('ui.what_if_title')}</strong> ${t('ui.what_if_sub')}
      <input class="sb-name" id="sb-scenario-name" placeholder="${t('ph.name_scenario')}" value="${t('ui.what_if_default_name')}">
      <div style="display:flex;gap:6px;margin-left:auto;">
        <button class="btn btn-ghost sm" id="sb-discard-btn">${t('ui.discard_btn')}</button>
        <button class="btn btn-primary sm" id="sb-apply-btn">${t('ui.promote_btn')}</button>
      </div>`;
    document.getElementById('sb-discard-btn')?.addEventListener('click', () => Sandbox.exit(false, 'sandbox-ui'));
    document.getElementById('sb-apply-btn')?.addEventListener('click',  () => Sandbox.exit(true, 'sandbox-ui'));

    Store.subscribe(evt => {
      if (evt.type === 'sandbox:entered') this._onEntered();
      else if (evt.type === 'sandbox:exited') this._onExited(evt);
    }, 'SandboxAdapter');
  },

  enter() {
    if (Sandbox.active) { Toast.show(t('toast.already_in_sandbox'), 'warn'); return; }
    Sandbox.enter('sandbox-ui');
  },

  _onEntered() {
    document.body.classList.add('sandbox-mode');
    const banner = document.getElementById('sandbox-banner');
    if (banner) banner.hidden = false;
    document.querySelectorAll('.sandbox-btn').forEach(btn => {
      btn.textContent = t('ui.sandbox_on');
      btn.style.color = 'var(--warn)';
      btn.onclick = null;
    });
    Toast.show(t('toast.what_if_mode'), 'info', 1500);
  },

  _onExited(evt) {
    const { applied, snapshot } = evt;
    if (applied) {
      const scenarioName = document.getElementById('sb-scenario-name')?.value || 'What-If';
      Toast.show(t('toast.scenario_applied', { name: scenarioName }), 'success');
    } else {
      if (NIMBUS.Confidence && SandboxAdapter._confSnapshot) NIMBUS.Confidence.restore(SandboxAdapter._confSnapshot);
      Alerts.scheduleRecompute();
      Toast.show(t('toast.scenario_discarded'), 'info');
    }

    document.body.classList.remove('sandbox-mode');
    const banner = document.getElementById('sandbox-banner');
    if (banner) banner.hidden = true;
    document.querySelectorAll('.sandbox-btn').forEach(btn => {
      btn.textContent = t('ui.sandbox_off');
      btn.style.color = '';
      btn.onclick = () => SandboxAdapter.enter();
    });

    if (applied) {
      NIMBUS.Persistence.saveAll();
      if (Store.selectedPlant) {
        const plant = Store.selectedPlant;
        const curLine  = new Set(Store._state.blocks.filter(b => b.plant === plant).map(b => b.id));
        const curPlant = new Set(Store._state.plantBlocks.filter(b => b.plant === plant).map(b => b.id));
        const removed = {
          line:  (snapshot?.blocks || []).filter(b => b.plant === plant && !curLine.has(b.id)).map(b => b.id),
          plant: (snapshot?.plantBlocks || []).filter(b => b.plant === plant && !curPlant.has(b.id)).map(b => b.id),
        };
        CalendarSync.flushPlant(plant, removed);
      }
    }

    const deferred = CalendarSync._deferredHydrationPlant;
    CalendarSync._deferredHydrationPlant = null;
    if (deferred && !applied && deferred === Store.selectedPlant) {
      CalendarSync.fetchPlantConfig(deferred);
    }
  },
};
```

Note: the old code captured `NIMBUS.Confidence?.snapshot()` into `Sandbox._confSnapshot` inside `enter()`, before any Store mutation happened — since `Sandbox.enter()` (state module) no longer knows about `Confidence` (cross-file, Phase 4 concern), `SandboxAdapter._onEntered()` must capture it at the same logical moment. Add one line to `_onEntered()`:

```js
_onEntered() {
  SandboxAdapter._confSnapshot = NIMBUS.Confidence?.snapshot() ?? null;
  document.body.classList.add('sandbox-mode');
  // ... rest unchanged
},
```

and clear it in `_onExited` after use: add `SandboxAdapter._confSnapshot = null;` right after the `NIMBUS.Confidence... .restore(...)` line.

- [ ] **Step 5: Extend the `app.js` state destructure and rewire boot**

```js
const { Store, Selection, UndoStack, Sandbox } = window.__NIMBUS_STATE;
```

In `_bootMain()`, change `try { Sandbox.init(); } catch (e) { ErrorLog.error('boot', \`Sandbox.init: ${e.message}\`); }` to `try { SandboxAdapter.init(); } catch (e) { ErrorLog.error('boot', \`SandboxAdapter.init: ${e.message}\`); }`.

Any inline `NIMBUS.Sandbox.enter()` reference (e.g. `index.html:1271`'s `onclick="NIMBUS.Sandbox.enter()"`) must keep working — the returned `NIMBUS` object's final `return {...}` still needs a `Sandbox` entry for external inline-handler compatibility, but `Sandbox.enter()` (state module) no longer takes a `Toast`/no-arg form the way the old inline handler expects. Update `index.html:1271`'s `onclick` to call the adapter instead:

```html
onclick="NIMBUS.SandboxAdapter.enter()"
```

and add `SandboxAdapter` to `app.js`'s final `return {...}` object alongside the existing `Sandbox` entry (`Sandbox` itself stays in the return object too — `nimbus-intelligence.js`'s optional-chained `NIMBUS.Sandbox?.active`/`?.enter?.()`/`?.showPanel?.()` reads still resolve against the real state-module object; `Sandbox.enter()` with no args still works there since `source` is an optional parameter that's simply `undefined` when omitted).

- [ ] **Step 6: Verify GREEN, paying special attention to the existing Sandbox characterization test**

Run: `npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

`tests/modules/legacy-app-characterization.test.mjs` test 6 asserts `nimbus.Sandbox.enter` is a function and `'Sandbox'` is `in nimbus` — both still true (the state-module `Sandbox` is still returned from `app.js`'s closure under the same key). Confirm this test needed no edits; if it fails, re-examine Step 5's return-object change before proceeding.

Run: `node scripts/legacy-surface.mjs --write` and review the diff — `index.html`'s `onclick="NIMBUS.SandboxAdapter.enter()"` change adds one new `htmlCommands` entry (`SandboxAdapter.enter`) and the old `NIMBUS.Sandbox.enter()` inline-handler occurrence disappears from `inlineHandlers`' single index.html call site (the `Sandbox.enter` reference inside `nimbus-intelligence.js`'s optional-chained `intelligenceCommands` list is untouched, since that file wasn't edited).

> **Retrospective correction (post-review):** the "wasn't edited" expectation above did not hold. A separate follow-up commit (`aa390f3`, "fix: route Command Palette rush-order action through SandboxAdapter.enter") *did* edit `nimbus-intelligence.js` — its Command Palette rush-order action called `NIMBUS.Sandbox?.enter?.()`, and after this task the state-module `Sandbox.enter()` only sets state (no DOM banner/Toast/etc.), so that call site needed to move to `NIMBUS.SandboxAdapter?.enter?.()` to keep the same user-visible side effects. This was a correct, narrow fix, not scope creep — but it means the compatibility inventory / this plan's own note about `nimbus-intelligence.js` being untouched was stale from that commit onward. Don't trust this note as ground truth; re-check the actual diff.

- [ ] **Step 7: Update the compatibility inventory**

In `docs/architecture/cq1-compatibility-inventory.md`, update the `Sandbox` row in §1 to note the split:

```markdown
| `Sandbox` | `schedule-state.mjs` | State + snapshots only (done, Phase 1). DOM banner/buttons/Toast/Confidence/Persistence/CalendarSync side effects live in `app.js`'s `SandboxAdapter` via the `sandbox:entered`/`sandbox:exited` events, pending their real move to `schedule-workbench.mjs` in Phase 3. |
```

- [ ] **Step 8: Commit**

```bash
git add web/schedule-state.mjs web/app.js web/index.html tests/modules/schedule-state.test.mjs tests/contracts/cq1-legacy-surface.json docs/architecture/cq1-compatibility-inventory.md
git commit -m "build: extract Sandbox state into schedule-state.mjs behind a thin app.js adapter"
```

---

### Task 6: Phase 1 Completion — Documentation and Full Gate

**Files:**
- Modify: `docs/architecture/cq1-compatibility-inventory.md` (final consistency pass)
- Modify: `tests/README.md` (document the new `.mjs` module test files)
- Modify: `AGENTS.md` and `CLAUDE.md` (document the ESM loader/bridge, matching the Phase 0 precedent of keeping both docs in sync)

- [ ] **Step 1: Update `docs/architecture/cq1-compatibility-inventory.md`**

Confirm §1's rows for `Config`, `Util`, `PerfMonitor`, `VirtualList`, `ErrorLog`, `Toast`, `Modal`, `Store`, `Selection`, `UndoStack`, `Sandbox` all read as migrated (Tasks 1–5 already updated the `Store`/`Sandbox` rows specifically; add a one-line "migrated Phase 1" note to the other 9 rows). Add a short new top-level note directly under the document's title:

```markdown
**Phase 1 status (complete):** `application-foundation.mjs` (Config, Util,
PerfMonitor, VirtualList, ErrorLog, Toast, Modal) and `schedule-state.mjs`
(Store, Selection, UndoStack, Sandbox) are real ES modules, bridged into
`app.js` via `app-entry.mjs` + `window.__NIMBUS_FOUNDATION`/`__NIMBUS_STATE`.
See §6 for the still-open `Store._state`/`_rev` exceptions carried into
Phase 2/3/4.
```

- [ ] **Step 2: Update `tests/README.md`**

Add a bullet under the existing "`tests/modules/` harness notes" list:

```markdown
- `foundation.test.mjs` / `schedule-state.test.mjs` — plain ESM `import` shape
  and behavior tests for `application-foundation.mjs`/`schedule-state.mjs`
  (no VM sandbox needed — these are real native modules). `app-entry.test.mjs`
  covers the loader's load-then-load-in-order contract via dependency
  injection (`loadScript`), not real DOM script tags — real-browser boot
  ordering is a Phase 4 browser-smoke responsibility, not unit-tested here.
```

- [ ] **Step 3: Update `AGENTS.md` and `CLAUDE.md`**

In both files' Frontend section, add one paragraph documenting: `app.js` now boots via `app-entry.mjs` (loaded as `<script type="module">` from `index.html`), which bridges `application-foundation.mjs`/`schedule-state.mjs` onto `window.__NIMBUS_FOUNDATION`/`window.__NIMBUS_STATE` before injecting `app.js` then `nimbus-intelligence.js` as classic scripts in that order; `NIMBUS` itself is still a bare script-scope `const`, not `window.NIMBUS`.

- [ ] **Step 4: Run the full Phase 1 completion gate**

- [ ] Run `git diff --check`.
- [ ] Run `npm run lint:ci`.
- [ ] Run `npm test`.
- [ ] Run `npm run check:legacy-surface`.
- [ ] Run `npm run check:static-assets`.
- [ ] Run safe offline `pytest` (`$env:PG_HOST='127.0.0.1'; $env:PG_DB='nimbus_test'; Remove-Item Env:NIMBUS_TEST_DB -ErrorAction SilentlyContinue; python -m pytest -q`) and confirm no regressions (Phase 1 makes no backend changes, so this is a pure regression check).
- [ ] Grep for any remaining bare references to the 11 moved module names' old in-file definitions to confirm nothing was left duplicated: `grep -n "^  const Config = {\|^  const Util = {\|^  class VirtualList\|^  const PerfMonitor = \|^  const Store = {\|^  const ErrorLog = {\|^  const Toast = \|^  const Modal = {\|^  const Selection = {\|^  const UndoStack = {\|^  const Sandbox = {" web/app.js` — expect **zero matches** (all 11 now live only in the two new files).
- [ ] Manually review `web/app.js`'s line count dropped by roughly the sum of the 11 deleted blocks (~3,500 lines) plus the small net-new adapter/seam code — a rough sanity check, not a strict assertion.
- [ ] Docker/browser boot smoke test — same as Phase 0: if Docker/a real browser is unavailable in this environment, record that as an unverified environment gate rather than weakening any test. This is the one piece of Phase 1 that cannot be proven by the Node/pytest suites alone (the `app-entry.mjs` auto-boot path, real `<script type="module">` timing, and the version-guard's interaction with the new loader all need a real browser).

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/cq1-compatibility-inventory.md tests/README.md AGENTS.md CLAUDE.md
git commit -m "docs: close out CQ-1 Phase 1 foundation-and-state migration"
```

---

## Phase 1 Completion Gate

- [ ] All 6 tasks committed.
- [ ] Full verification suite green (lint, JS tests, legacy-surface, static-assets, pytest).
- [ ] `web/app.js` no longer contains its own definitions of `Config`, `Util`, `PerfMonitor`, `VirtualList`, `ErrorLog`, `Toast`, `Modal`, `Store`, `Selection`, `UndoStack`, or `Sandbox` — all 11 live only in `application-foundation.mjs`/`schedule-state.mjs`.
- [ ] `NIMBUS.*`'s externally-observable surface (what `index.html` and `nimbus-intelligence.js` can call) is unchanged except for the one deliberate, documented addition (`NIMBUS.SandboxAdapter.enter()`, replacing `NIMBUS.Sandbox.enter()` in exactly one `onclick`).
- [ ] Every emitted Store event carries `revision` and `mode`; `Store.mode()` correctly reflects `Sandbox.active`.
- [ ] The 6 DI seams (`Util.setPreferenceResolver/setActorResolver/setUtilizationResolver`, `ErrorLog.setAdminGate/setBadgeClickHandler`, `Store.setAllowedPlantsResolver/setSettingsDefaultsResolver`) are each wired exactly once, in `app.js`, immediately after the bridge destructure.
- [ ] The compatibility inventory's §6 exception table accurately lists every consumer still reaching into `Store._state`/`Store._rev` directly, with its real migration phase.
- [ ] Docker/browser smoke test run if available this session; recorded as an unverified environment gate if not — never silently skipped or weakened.
- [ ] Review the complete Phase 1 diff for security, behavior drift, and accidental scope creep before writing the Phase 2 extraction plan (services + data: `Calendar`, `Compute`, `Alerts`, `Utilization`, `Engine`, `Persistence`, `CalendarSync`, `Session`).
</content>
