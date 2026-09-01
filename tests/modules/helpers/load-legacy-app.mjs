// VM harness that loads app.js in Node without firing DOMContentLoaded.
// Provides deterministic stubs for browser globals; throws for unrecognised
// fetch or Worker operations so tests cannot silently pass through gaps.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import * as foundation from '../../../web/application-foundation.mjs';
import * as state from '../../../web/schedule-state.mjs';
import * as services from '../../../web/schedule-services.mjs';
import * as data from '../../../web/schedule-data.mjs';
import * as workbench from '../../../web/schedule-workbench.mjs';
import * as plantAdmin from '../../../web/plant-and-administration.mjs';
import * as shell from '../../../web/application-shell.mjs';
import * as materialGrids from '../../../web/master-data-grids.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '../../..');

const _require = createRequire(import.meta.url);

function makeStorage(seed = {}) {
  const store = Object.assign(Object.create(null), seed);
  return {
    getItem:    k => (k in store ? store[k] : null),
    setItem:    (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear:      () => { for (const k of Object.keys(store)) delete store[k]; },
    key:        i => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
}

function makeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), id: '', className: '', style: {}, dataset: {},
    textContent: '', innerHTML: '', value: '', checked: false, hidden: false,
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    hasAttribute() { return false; },
    addEventListener() {}, removeEventListener() {},
    appendChild() { return arguments[0]; }, removeChild() {}, remove() {},
    insertBefore() { return arguments[0]; }, replaceChild() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; }, replace() {} },
    querySelector() { return null; },
    querySelectorAll() { return makeNodeList([]); },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    dispatchEvent() {},
    focus() {}, blur() {}, click() {},
    children: [], childNodes: [], parentNode: null, parentElement: null,
  };
  return el;
}

function makeNodeList(items) {
  return Object.assign(items, {
    forEach(fn) { items.forEach(fn); },
    [Symbol.iterator]() { return items[Symbol.iterator](); },
  });
}

/**
 * Load app.js into an isolated VM context without firing DOMContentLoaded.
 *
 * @param {{
 *   fetchImpl?: (url: string, opts: object) => Promise,
 *   workerFactory?: (url: string) => object,
 *   storageSeed?: Record<string, string>,
 * }} opts
 * @returns {{ nimbus: object, context: object, domReady: Function|null,
 *             fetchCalls: Array, workerMessages: Array }}
 */
export async function loadLegacyApp({ fetchImpl, workerFactory, storageSeed = {} } = {}) {
  const appSrc  = readFileSync(resolve(ROOT, 'web/app.js'), 'utf8');
  const corePath = resolve(ROOT, 'web/nimbus-compute-core.js');
  const NimbusComputeCore = _require(corePath);

  let domReadyFn  = null;
  const fetchCalls     = [];
  const workerMessages = [];

  const defaultFetch = (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ tasks: [], versions: {}, stale: [] }),
      text: () => Promise.resolve(''),
    });
  };

  const fetchImpl_ = fetchImpl || defaultFetch;

  const FakeWorker = workerFactory
    ? class { constructor(u) { Object.assign(this, workerFactory(u)); } }
    : class {
        constructor() {
          this.onmessage = null;
          this.onerror   = null;
        }
        postMessage(msg) { workerMessages.push(msg); }
        terminate()      {}
        addEventListener() {}
      };

  const bodyEl = makeElement('body');
  bodyEl.appendChild = (child) => child;
  bodyEl.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };

  const document_ = {
    addEventListener(evt, fn) { if (evt === 'DOMContentLoaded') domReadyFn = fn; },
    removeEventListener() {},
    getElementById()         { return null; },
    querySelector()          { return null; },
    querySelectorAll()       { return makeNodeList([]); },
    createElement(tag)       { return makeElement(tag); },
    createElementNS(ns, tag) { return makeElement(tag); },
    createTextNode(t)        { return { nodeValue: t, textContent: t, nodeType: 3 }; },
    body:            bodyEl,
    head:            makeElement('head'),
    documentElement: makeElement('html'),
    readyState:      'loading',
    title:           '',
  };

  const location_ = {
    pathname: '/', search: '', hash: '', href: 'http://localhost/',
    replace() {}, assign() {}, reload() {},
  };

  const sandbox = {
    // Standard
    console,
    setTimeout(fn, ms) { /* suppress automatic timers during harness eval */ return 0; },
    clearTimeout()  {},
    setInterval()   { return 0; },
    clearInterval() {},
    queueMicrotask(fn) { Promise.resolve().then(fn); },

    // DOM
    document: document_,
    navigator: { userAgent: 'Node/TestHarness', language: 'en-US' },

    // Storage. (The cache-bust guard that used to live at the top of app.js and
    // read this same 'nimbus.app.ver' key has moved to app-entry.mjs's
    // runCacheBustGuard() — app.js loaded directly via this VM harness no
    // longer touches sessionStorage for that purpose, but an empty seed is
    // kept here as a harmless, deterministic default for any other reader.)
    localStorage:  makeStorage(storageSeed),
    sessionStorage: makeStorage({}),

    // Web APIs
    performance: { now: () => 0 },
    crypto: { randomUUID: () => 'test-uuid-0000-0000-0000-000000000000' },
    Worker: FakeWorker,
    URL,           // Node's built-in URL
    Blob: class { constructor(p) { this._p = p; } },
    CSS: { escape: s => String(s).replace(/[^\w-]/g, '\\$&') },
    MutationObserver:    class { constructor() {} observe() {} disconnect() {} },
    ResizeObserver:      class { constructor() {} observe() {} disconnect() {} },
    IntersectionObserver:class { constructor() {} observe() {} disconnect() {} },
    AbortSignal: { timeout: () => ({ aborted: false }) },
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() {} },

    // CDN stubs (enough to prevent throw during module definition)
    vis: {
      Timeline: class {
        constructor() {}
        setItems() {} setGroups() {} setOptions() {} on() {} off() {}
        fit() {} setWindow() {} moveTo() {} redraw() {} destroy() {}
        getWindow() { return { start: new Date('2026-01-01'), end: new Date('2026-12-31') }; }
        getItemRange() { return { min: new Date(), max: new Date() }; }
      },
      DataSet: class {
        constructor(data) { this._d = data || []; }
        add() {} update() {} remove() {} clear() {}
        get(ids) { return ids == null ? this._d : []; }
        getIds() { return []; }
        get length() { return this._d.length; }
        on() {} off() {}
      },
    },
    agGrid: {
      createGrid: () => ({
        setGridOption() {}, applyTransaction() {}, getSelectedRows() { return []; },
        forEachNode() {}, destroy() {}, refreshCells() {}, setColumnDefs() {},
        getDisplayedRowCount() { return 0; },
      }),
      ModuleRegistry: { registerModules() {} },
    },
    Chart: Object.assign(class {
      constructor() { this.data = { datasets: [] }; this.options = {}; }
      update() {} destroy() {}
    }, { register() {}, defaults: { plugins: {}, elements: {} } }),
    flatpickr: Object.assign(
      () => ({ setDate() {}, destroy() {}, selectedDates: [], clear() {} }),
      { localize() {}, l10ns: {} }
    ),
    NimbusComputeCore,

    // Network — Headers/Request/Response are available globally in Node 18+
    fetch: fetchImpl_,
    Headers,
    Request,
    Response,
    XMLHttpRequest: class { open() {} send() {} },
    WebSocket: class { constructor() {} },

    // Output capture
    __NIMBUS__: undefined,
  };

  // window = the sandbox itself (self-referential, standard browser model)
  sandbox.window = sandbox;
  sandbox.self   = sandbox;
  sandbox.globalThis = sandbox;
  // location lives both on sandbox and window
  sandbox.location = location_;

  // app.js now throws unless the foundation/state/services/data/workbench/
  // plant-admin/shell/material-grids bridges are populated before it runs (see
  // web/app-entry.mjs) — pre-populate them here just like a real page load.
  sandbox.window.__NIMBUS_FOUNDATION = foundation;
  sandbox.window.__NIMBUS_STATE = state;
  sandbox.window.__NIMBUS_SERVICES = services;
  sandbox.window.__NIMBUS_DATA = data;
  sandbox.window.__NIMBUS_WORKBENCH = workbench;
  sandbox.window.__NIMBUS_PLANT_ADMIN = plantAdmin;
  sandbox.window.__NIMBUS_SHELL = shell;
  sandbox.window.__NIMBUS_MATERIAL_GRIDS = materialGrids;

  // application-foundation.mjs is a real ES module loaded above via a normal
  // dynamic import, so it executes in THIS host Node realm — NOT inside the
  // vm context created below. Its Toast/Modal functions reference bare
  // `document` (e.g. Toast.show does document.getElementById('toast-stack')),
  // which app.js code running inside the vm (via runInContext) can trigger
  // indirectly (e.g. Persistence.saveAll -> Toast.show on save success). For
  // that cross-realm call to resolve instead of throwing "document is not
  // defined", mirror the same harness DOM stub onto the host realm's
  // globalThis. This split-realm quirk is a test-harness-only concession: in
  // a real browser, application-foundation.mjs and app.js share the one page
  // window/document, so it doesn't arise there.
  if (typeof globalThis.document === 'undefined') globalThis.document = document_;
  // Same split-realm quirk for `NimbusComputeCore`: schedule-services.mjs's
  // Calendar (host realm, imported above) now delegates to it via
  // `globalThis.NimbusComputeCore` (see that file for why — nimbus-compute-
  // core.js is a UMD module with no ES `export`, so it can't be statically
  // imported by an .mjs file; it's loaded as a classic <script> in the real
  // browser, ending up on `window`/`globalThis` before app-entry.mjs's static
  // imports run). This harness already `require()`s it once (above) for the
  // vm sandbox's bare `NimbusComputeCore` global (still read directly by any
  // app.js code not yet migrated) — mirror that same object onto the host
  // realm's globalThis so schedule-services.mjs's host-realm functions
  // resolve it too, instead of throwing "NimbusComputeCore is not defined".
  if (typeof globalThis.NimbusComputeCore === 'undefined') globalThis.NimbusComputeCore = NimbusComputeCore;
  // Same split-realm quirk for `fetch`: Util.fetchTraced now lives in
  // application-foundation.mjs (host realm) and calls bare `fetch(...)`.
  // Node already defines a real global `fetch`, so — unlike `document` above —
  // the "only if undefined" guard would never fire; the host's real fetch
  // would silently take over and reject relative URLs like `/tasks/update`
  // ("Failed to parse URL"). Always point the host realm's fetch at this
  // invocation's fetchImpl_ so calls originating in application-foundation.mjs
  // land in the same fetchCalls/stub the vm-sandboxed app.js code uses.
  globalThis.fetch = fetchImpl_;
  // Same split-realm quirk for `localStorage`: schedule-data.mjs's Persistence (host
  // realm, imported above) reads/writes bare `localStorage` directly (cache save/load,
  // selected-plant restore) — code that used to live inside app.js and so read the vm
  // sandbox's `localStorage` stub directly. Node has no global `localStorage` by
  // default, so mirror the SAME storage stub the vm-evaluated app.js code uses onto the
  // host realm, rather than fabricate a second, divergent store.
  if (typeof globalThis.localStorage === 'undefined') globalThis.localStorage = sandbox.localStorage;
  // Same split-realm quirk for `window`: Util.t() reads bare `window.__NIMBUS_LOCALES`
  // (no `typeof window` guard — matches the original app.js code, which never
  // needed one since app.js always ran somewhere `window` already existed).
  // Node has no global `window` at all, so point the host realm at the exact
  // same self-referential sandbox object the vm-evaluated app.js code sees,
  // rather than fabricate a second, divergent window.
  globalThis.window = sandbox.window;

  // NOTE (CQ-1 Phase 3 Task 1): schedule-workbench.mjs's `Timeline` references a
  // handful of app.js-resident siblings (App, Inspector, Interaction, GanttFilter,
  // EmptyState) via the bare `NIMBUS` binding rather than direct imports — safe in
  // a real browser (classic-script top-level `const`/`let` share one realm-wide
  // declarative scope with any module on the same page), but `NIMBUS` here only
  // exists inside THIS vm sandbox's context (`ctx.__NIMBUS__` below), not on the
  // host realm where schedule-workbench.mjs (a real ES module, imported above)
  // actually executes. No current test calls a Timeline method that reaches
  // `NIMBUS` (rebuild()/focus()/gotoLineDay()/_renderEmptyOverlay() all do), so
  // this hasn't needed a fix yet — if a future test (e.g. Task 5's Interaction
  // characterization tests, which can trigger a Timeline rebuild via a simulated
  // drag) does reach one, mirror `ctx.__NIMBUS__` onto `globalThis.NIMBUS` here,
  // the same way `NimbusComputeCore`/`fetch`/`localStorage`/`window` are mirrored
  // above — it can't be done here directly since `ctx.__NIMBUS__` doesn't exist
  // until after `runInContext` below runs.
  //
  // IMPORTANT — this VM harness cannot substitute for a real-browser smoke test
  // of this pattern: it never populates `globalThis.NIMBUS`, so any of the
  // dozens of `NIMBUS.X` call sites across `schedule-workbench.mjs` that a test
  // happens to reach would throw ReferenceError here rather than silently pass,
  // but nothing in this suite reaches most of them (see above), so a broken
  // `NIMBUS.EmptyState.render`/`NIMBUS.App.goto`/`NIMBUS.GanttFilter.isolateLine`
  // call, for example, would not be caught by `npm test` alone. Phase 3's own
  // Completion Gate required a Docker/browser boot smoke test to close this gap
  // (or an explicit record if one couldn't be run) — none was run during Phase 3;
  // this is recorded as an outstanding, unverified environment gate in that
  // plan's Completion Gate section
  // (`docs/superpowers/plans/archive/2026-07-17-cq1-phase-3-workbench.md`), not silently
  // assumed to be covered by this harness.
  const ctx = createContext(sandbox);

  // Inject __NIMBUS__ capture after the IIFE so `const NIMBUS` (script-scoped)
  // is still in scope. See Module_migration.md §3 VM harness design.
  runInContext(appSrc + '\nglobalThis.__NIMBUS__ = NIMBUS;\n', ctx);

  return {
    nimbus:         ctx.__NIMBUS__,
    context:        ctx,
    domReady:       domReadyFn,
    fetchCalls,
    workerMessages,
  };
}
