// VM harness that loads app.js in Node without firing DOMContentLoaded.
// Provides deterministic stubs for browser globals; throws for unrecognised
// fetch or Worker operations so tests cannot silently pass through gaps.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';

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
export function loadLegacyApp({ fetchImpl, workerFactory, storageSeed = {} } = {}) {
  const appSrc  = readFileSync(resolve(ROOT, 'app.js'), 'utf8');
  const corePath = resolve(ROOT, 'nimbus-compute-core.js');
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

    // Storage — pre-seed sessionStorage with the current APP_VERSION so the
    // cache-bust guard at the top of app.js doesn't call window.location.replace.
    localStorage:  makeStorage(storageSeed),
    sessionStorage: makeStorage({ 'nimbus.app.ver': '2026-07-13-d' }),

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
