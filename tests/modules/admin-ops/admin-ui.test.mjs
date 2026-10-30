// Tests for frontend/admin-ops/admin-ui.mjs (AdminCockpit).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminCockpit } from '../../../frontend/admin-ops/admin-ui.mjs';

// Same split-realm/no-DOM situation documented in
// tests/modules/insights/insights-ui.test.mjs: Util.t() reads window.__NIMBUS_LOCALES
// (optionally — undefined falls through to the key itself), but needs the bare
// `window` global to exist at all.
globalThis.window = globalThis.window || {};

test('AdminCockpit exposes its documented public API', () => {
  assert.equal(typeof AdminCockpit.init, 'function');
  assert.equal(typeof AdminCockpit.render, 'function');
  assert.equal(typeof AdminCockpit._startHealthPolling, 'function');
  assert.equal(typeof AdminCockpit._stopHealthPolling, 'function');
  assert.equal(typeof AdminCockpit.gotoSub, 'function');
  assert.equal(AdminCockpit.gotoOvTab, undefined);
  assert.equal(typeof AdminCockpit._setSub, 'function');
});

// Minimal fake DOM (same no-document situation as insights-ui.test.mjs):
// _renderDistributionWarning only needs createElement/createDocumentFragment
// nodes that can appendChild, hold style/className/textContent/href, and
// record an addEventListener'd click handler.
function fakeNode() {
  const node = {
    style: {},
    className: '',
    textContent: '',
    href: '',
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child) { node.children.push(child); return child; },
    addEventListener(type, fn) { node._listeners[type] = fn; },
  };
  node._listeners = {};
  return node;
}

function withFakeDom(fn) {
  const priorDocument = globalThis.document;
  globalThis.document = {
    createElement() { return fakeNode(); },
    createDocumentFragment() { return fakeNode(); },
  };
  try {
    return fn();
  } finally {
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
  }
}

test('AdminCockpit._renderDistributionWarning formats each warning-item shape and fixes the prior "[object Object]" output', () => {
  withFakeDom(() => {
    const entry = {
      category: 'distribution',
      msg: 'Distribution applied with warnings',
      level: 'warn',
      headers_created: 2,
      headers_refreshed: 0,
      conflicting_parent_rows: [{ production_order: 'PO1', material_number: 'MAT1', values: ['10', '20'] }],
      ambiguous_plant: [{ production_order: 'PO2', material_number: 'MAT2' }],
      workcenter_without_members: [
        { plant: 'P1', production_order: 'PO3', material_number: 'MAT3', sap_workcenter: 'WC1', reason: 'no machines mapped' },
        { plant: 'P1', production_order: 'PO5', material_number: 'MAT5', sap_workcenter: 'WC2', reason: 'zero_weights' },
      ],
      default_machine_invalid: [{ plant: 'P1', production_order: 'PO4', material_number: 'MAT4' }],
    };

    const frag = AdminCockpit._renderDistributionWarning(entry, 'batch-123');

    // children: [0] summary, [1] link row, [2..5] the four detail-list rows,
    // in the listFields order declared in _renderDistributionWarning.
    const detailRows = frag.children.slice(2);
    const preTextOf = row => row.children[1].children[0].textContent;
    assert.equal(preTextOf(detailRows[0]), 'PO1 · MAT1 · 10/20', 'conflicting_parent_rows: order · material · values.join(\'/\')');
    assert.equal(preTextOf(detailRows[1]), 'PO2 · MAT2', 'ambiguous_plant: order · material, no trailing separator for missing fields');
    assert.equal(
      preTextOf(detailRows[2]),
      'PO3 · MAT3 · WC1\nPO5 · MAT5 · WC2 · ui.workcenter_zero_weights',
      'workcenter_without_members: a plain memberless item has no suffix; a `reason: "zero_weights"` item (B3) gets one',
    );
    assert.equal(preTextOf(detailRows[3]), 'PO4 · MAT4', 'default_machine_invalid: order · material');
  });
});

test('AdminCockpit._renderDistributionWarning\'s review link navigates to the Gantt distribution sub-pane instead of a dead #gantt/distribution hash', () => {
  withFakeDom(() => {
    const priorNimbus = globalThis.NIMBUS;
    const calls = [];
    globalThis.NIMBUS = { App: {
      goto: tab => calls.push(['goto', tab]),
      gotoGanttSub: sub => calls.push(['gotoGanttSub', sub]),
    } };
    try {
      const entry = { category: 'distribution', msg: 'ok', headers_created: 1, headers_refreshed: 0 };
      const frag = AdminCockpit._renderDistributionWarning(entry, 'batch-456');
      const linkRow = frag.children[1];
      const link = linkRow.children[0];
      assert.equal(link.href, '#', 'link no longer encodes a dead #gantt/distribution hash');

      let defaultPrevented = false;
      link._listeners.click({ preventDefault() { defaultPrevented = true; } });

      assert.equal(defaultPrevented, true);
      assert.deepEqual(calls, [['goto', 'gantt'], ['gotoGanttSub', 'distribution']],
        'goto(\'gantt\') must run before gotoGanttSub, which alone does not switch the top-level tab');
    } finally {
      if (priorNimbus === undefined) delete globalThis.NIMBUS; else globalThis.NIMBUS = priorNimbus;
    }
  });
});

test('_clearBackendLog confirms first, and reports a non-OK response instead of swallowing it (#47)', async () => {
  const { Modal, Toast } = await import('../../../frontend/platform/foundation.mjs');
  const priorFetch = globalThis.fetch, priorConfirm = Modal.confirm, priorToast = Toast.show;
  const fetched = [], toasts = [];
  globalThis.fetch = (url, opts) => { fetched.push([String(url), opts?.method]); return Promise.resolve({ ok: false, status: 500, headers: new Map(), json: () => Promise.resolve({}) }); };
  Toast.show = (msg, type) => { toasts.push([msg, type]); };
  try {
    Modal.confirm = () => Promise.resolve(false);
    await AdminCockpit._clearBackendLog();
    assert.equal(fetched.length, 0, 'declined confirm must not call the server');
    Modal.confirm = () => Promise.resolve(true);
    await AdminCockpit._clearBackendLog();
    assert.equal(fetched.length, 1);
    assert.ok(toasts.some(([, type]) => type === 'error'), 'HTTP 500 must surface an error toast');
  } finally {
    globalThis.fetch = priorFetch; Modal.confirm = priorConfirm; Toast.show = priorToast;
  }
});

test('purge preview sends the whole-day range (T00:00:00 start, T23:59:59 end), the same shape the purge call sends', async () => {
  const priorFetch = globalThis.fetch, priorDocument = globalThis.document;
  const priorPlant = AdminCockpit._purgePlant, priorStart = AdminCockpit._fpPurgeStart, priorEnd = AdminCockpit._fpPurgeEnd;
  const bodies = [];
  const els = { 'admin-past-count': { innerHTML: '', textContent: '' }, 'admin-purge-btn': { disabled: false } };
  globalThis.document = { getElementById: id => els[id] ?? null };
  globalThis.fetch = (url, opts) => {
    bodies.push({ url: String(url), body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok', plant: '1085', total: 0, planner_overridden: 0 }) });
  };
  try {
    AdminCockpit._purgePlant = '1085';
    AdminCockpit._fpPurgeStart = { selectedDates: [new Date(2026, 8, 1)] };
    AdminCockpit._fpPurgeEnd = { selectedDates: [new Date(2026, 8, 30)] };
    await AdminCockpit._fetchPurgePreview();
    assert.equal(bodies.length, 1, 'one preview request');
    assert.match(bodies[0].url, /\/purge\/preview$/);
    assert.equal(bodies[0].body.start_date, '2026-09-01T00:00:00');
    assert.equal(bodies[0].body.end_date, '2026-09-30T23:59:59', 'a bare date would count the last day from 00:00 and under-count the purge');
  } finally {
    globalThis.fetch = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    AdminCockpit._purgePlant = priorPlant; AdminCockpit._fpPurgeStart = priorStart; AdminCockpit._fpPurgeEnd = priorEnd;
  }
});

test('_getFilteredEntries applies the exact-match user filter', async () => {
  const { ErrorLog } = await import('../../../frontend/platform/foundation.mjs');
  ErrorLog.clear?.();
  ErrorLog.info('t', 'from alice');
  ErrorLog.info('t', 'from bob');
  const all = ErrorLog.entries();
  all[0].user = 'alice@x.com';
  all[1].user = 'bob@x.com';
  const prior = { ...AdminCockpit._logFilter };
  try {
    AdminCockpit._logFilter = { ...prior, level: 'all', scope: 'all', search: '', errorCode: 'all', reqId: '', user: 'alice@x.com' };
    const out = AdminCockpit._getFilteredEntries();
    assert.equal(out.length, 1);
    assert.equal(out[0].user, 'alice@x.com');
    AdminCockpit._logFilter.user = '';
    assert.equal(AdminCockpit._getFilteredEntries().length, 2);
  } finally {
    AdminCockpit._logFilter = prior;
  }
});

// ---- W1: sub-tab shell ----
import { readFileSync } from 'node:fs';

function stubAll(names, calls) {
  const prior = {};
  for (const n of names) { prior[n] = AdminCockpit[n]; AdminCockpit[n] = () => { calls.push(n); }; }
  return () => { for (const n of names) AdminCockpit[n] = prior[n]; };
}
function withEmptyDom(fn) {
  const prior = globalThis.document;
  globalThis.document = { querySelectorAll() { return []; }, getElementById() { return null; } };
  try { return fn(); } finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; }
}
const ALL_RENDERERS = ['_renderOverview', '_renderLogsPane', '_renderDiagnosticsPane', '_renderOrderMaintenance',
  '_refreshOverview', '_renderBackendLog', '_renderLogs', '_renderAuditLog', '_renderDiagnostics', '_renderPipeline',
  '_renderDbDeep', '_refreshThreadPane', '_renderPurgeMeta', '_renderAudit', '_startHealthPolling', '_stopHealthPolling'];

test('render() calls _setSub once and renders Overview exactly once', () => {
  const calls = [];
  const restore = stubAll(['_refreshOverview', '_startHealthPolling', '_stopHealthPolling', '_renderLogsPane'], calls);
  const realOv = AdminCockpit._renderOverview; let ov = 0;
  AdminCockpit._renderOverview = function () { ov++; return realOv.call(AdminCockpit); };
  const realSet = AdminCockpit._setSub; let set = 0;
  AdminCockpit._setSub = function (s) { set++; return realSet.call(AdminCockpit, s); };
  try { withEmptyDom(() => AdminCockpit.render()); }
  finally { AdminCockpit._renderOverview = realOv; AdminCockpit._setSub = realSet; restore(); }
  assert.equal(set, 1);
  assert.equal(ov, 1);
  assert.equal(calls.filter(c => c === '_refreshOverview').length, 1);
});

test('_setSub("logs") stops health polling and renders the logs pane only', () => {
  const calls = [];
  const restore = stubAll(ALL_RENDERERS, calls);
  try { withEmptyDom(() => AdminCockpit._setSub('logs')); } finally { restore(); }
  assert.ok(calls.includes('_stopHealthPolling'));
  assert.ok(calls.includes('_renderLogsPane'));
  assert.ok(!calls.includes('_renderOverview'));
});

test('_setSub("overview") does not call the diagnostics or log renderers', () => {
  const calls = [];
  const restore = stubAll(['_refreshOverview', '_startHealthPolling', '_stopHealthPolling', '_renderBackendLog', '_renderLogs',
    '_renderAuditLog', '_renderDiagnostics', '_renderPipeline', '_renderDbDeep', '_refreshThreadPane', '_renderPurgeMeta', '_renderAudit'], calls);
  try { withEmptyDom(() => AdminCockpit._setSub('overview')); } finally { restore(); }
  assert.deepEqual(calls.sort(), ['_refreshOverview', '_startHealthPolling']);
});

test('_setSub dispatches diagnostics and order-maintenance to their renderers', () => {
  const calls = [];
  const restore = stubAll(ALL_RENDERERS.filter(n => !n.startsWith('_renderDiagnosticsPane') && n !== '_renderOrderMaintenance'), calls);
  try {
    withEmptyDom(() => AdminCockpit._setSub('diagnostics'));
    assert.deepEqual(calls.filter(c => c !== '_stopHealthPolling'), ['_renderDiagnostics', '_renderPipeline', '_renderDbDeep', '_refreshThreadPane']);
    calls.length = 0;
    withEmptyDom(() => AdminCockpit._setSub('order-maintenance'));
    assert.deepEqual(calls.filter(c => c !== '_stopHealthPolling'), ['_renderPurgeMeta', '_renderAudit']);
  } finally { restore(); }
});

test('every getElementById admin- id used by admin-ui.mts exists in index.html', () => {
  const src = readFileSync(new URL('../../../frontend/admin-ops/admin-ui.mts', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../../frontend/index.html', import.meta.url), 'utf8');
  // Ids injected at runtime (not in index.html). admin-upload-detail is NOT injected anywhere: a pre-existing
  // dead target (the distribution-warning zone is silently skipped), allowlisted only so this test pins the rest.
  const LAZY = new Set(['admin-upload-detail', 'admin-backend-log-q', 'admin-backend-log-user', 'admin-log-filter-code', 'admin-diag-refresh', 'admin-diag-storage']);
  const ids = new Set([...src.matchAll(/getElementById\('(admin-[\w-]+)'\)/g)].map(m => m[1]).filter(id => !LAZY.has(id)));
  const missing = [...ids].filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
  for (const id of ids) assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} appears once`);
});

test('_setSub with an unknown sub falls back to overview', () => {
  const calls = [];
  const restore = stubAll(ALL_RENDERERS, calls);
  try { withEmptyDom(() => AdminCockpit._setSub('bogus')); } finally { restore(); }
  assert.equal(AdminCockpit._activeSub, 'overview');
  assert.ok(calls.includes('_renderOverview'));
});

test('no gotoOvTab anywhere in frontend', () => {
  for (const f of ['app.js', 'index.html']) {
    assert.ok(!readFileSync(new URL('../../../frontend/' + f, import.meta.url), 'utf8').includes('gotoOvTab'), f);
  }
});

// ---- W2: Signal board refresh, polling, fixes ----
import { JobsClient } from '../../../frontend/admin-ops/jobs-client.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const HEALTH = (ping = 12) => ({ db: { connected: true, ping_ms: ping, total_orders: 100 }, pool: { pool_max: 10, pool_size: 2, pool_available: 2 }, memory: { loaded: true, loaded_at: null }, color_wheel: { misses: 0 } });
const COUNT = { total: 0, entries: [] };
const DEEP = { tables: [], connections: { total: 1, long_running: [] }, locks: [], slow_queries: { available: false, queries: [] } };
const SUMMARY = { failed24h: 0, missed24h: 0, warning24h: 0, longerThanUsual: [], nextFire: null, scheduler: { ok: true } };

/** Stub _fetchJson (by path prefix), JobsClient, admin role and plant; returns the call log and a restore(). */
function stubOverview({ routes = {}, admin = true, plant = 'P1' } = {}) {
  const A = AdminCockpit;
  const saved = {
    fetch: A._fetchJson, sum: JobsClient.summary, runs: JobsClient.runs, isAdmin: Session.isAdmin,
    plant: Store._state.selectedPlant, slow: A._ovSlow, fast: A._ovFast, seq: A._ovSeq, sigKey: A._ovSigKey,
  };
  const calls = [];
  A._fetchJson = async (path) => {
    calls.push(path);
    const key = Object.keys(routes).find(k => path.startsWith(k));
    const r = key ? routes[key] : undefined;
    if (typeof r === 'function') return r(path);
    if (r instanceof Error) throw r;
    if (r !== undefined) return r;
    if (path.startsWith('/health')) return HEALTH();
    if (path.startsWith('/logs/backend')) return COUNT;
    if (path.startsWith('/diagnostics/db')) return DEEP;
    if (path.startsWith('/audit/log')) return { entries: [] };
    if (path.startsWith('/upload/audit')) return { audit: [] };
    if (path.startsWith('/sap/staging/send')) return { ready: 0, sent: 0, error: 0, last_queued_at: null, last_sent_at: null };
    if (path.startsWith('/sap/staging/batches')) return { batches: [] };
    if (path.startsWith('/sap/interface/runs')) return { runs: [] };
    throw new Error('unexpected ' + path);
  };
  JobsClient.summary = async () => { calls.push('jobs.summary'); return SUMMARY; };
  JobsClient.runs = async () => { calls.push('jobs.runs'); return { items: [], nextBeforeId: null }; };
  Session.isAdmin = () => admin;
  Store._state.selectedPlant = plant;
  A._ovSlow = { dbDeep: null, dbDeepAt: 0, auditLog: [], uploadAudit: [], at: 0 };
  A._ovFast = { health: null, backendErrors: null, backendWarns: null, jobs: null, sap: null, plant: '' };
  A._ovSigKey = '';
  const restore = () => {
    A._fetchJson = saved.fetch; JobsClient.summary = saved.sum; JobsClient.runs = saved.runs; Session.isAdmin = saved.isAdmin;
    Store._state.selectedPlant = saved.plant; A._ovSlow = saved.slow; A._ovFast = saved.fast; A._ovSeq = saved.seq; A._ovSigKey = saved.sigKey;
  };
  return { calls, restore };
}
const sigOf = id => AdminCockpit._ovSignals.find(s => s.id === id);

test('stale overview response is discarded', async () => {
  let n = 0; let release;
  const gate = new Promise(r => { release = r; });
  const { restore } = stubOverview({ routes: { '/health': async () => (++n === 1 ? (await gate, HEALTH(9999)) : HEALTH(12)) } });
  try {
    const first = AdminCockpit._refreshOverview({ force: true });
    const second = AdminCockpit._refreshOverview({ force: true });
    await second;
    release();
    await first;
    assert.equal(AdminCockpit._ovFast.health.db.ping_ms, 12);
    assert.equal(sigOf('database').reasonKey, 'sig.db_ok');
  } finally { restore(); }
});

test('rejected fast-tier fetch yields sig.unavailable, not a silent ok', async () => {
  const { restore } = stubOverview({ routes: { '/health': new Error('boom') } });
  try {
    await AdminCockpit._refreshOverview({ force: true });
    const db = sigOf('database');
    assert.equal(db.severity, 'err');
    assert.equal(db.reasonKey, 'sig.unavailable');
  } finally { restore(); }
});

test('a 403 yields sig.admin_only, not err', async () => {
  const { restore } = stubOverview({ routes: { '/health': Object.assign(new Error('forbidden'), { status: 403 }) } });
  try {
    await AdminCockpit._refreshOverview({ force: true });
    const db = sigOf('database');
    assert.equal(db.severity, 'info');
    assert.equal(db.reasonKey, 'sig.admin_only');
  } finally { restore(); }
});

test('slow tier runs on force or when older than 5 minutes, not on every tick', async () => {
  const { calls, restore } = stubOverview();
  const deep = () => calls.filter(c => c.startsWith('/diagnostics/db')).length;
  try {
    await AdminCockpit._refreshOverview();           // first read: nothing cached yet
    assert.equal(deep(), 1);
    await AdminCockpit._refreshOverview();           // fresh: skipped
    assert.equal(deep(), 1);
    await AdminCockpit._refreshOverview({ force: true });
    assert.equal(deep(), 2);
    AdminCockpit._ovSlow.at = Date.now() - 300_001;  // older than OV_SLOW_MS
    await AdminCockpit._refreshOverview();
    assert.equal(deep(), 3);
  } finally { restore(); }
});

test('a failed slow read keeps the last good deep-dive', async () => {
  const { restore } = stubOverview();
  try {
    await AdminCockpit._refreshOverview({ force: true });
    assert.ok(AdminCockpit._ovSlow.dbDeep);
    AdminCockpit._fetchJson = async (p) => {
      if (p.startsWith('/diagnostics/db')) throw new Error('slow fail');
      return p.startsWith('/health') ? HEALTH() : p.startsWith('/logs') ? COUNT : { entries: [], audit: [], batches: [], runs: [] };
    };
    await AdminCockpit._refreshOverview({ force: true });
    assert.ok(AdminCockpit._ovSlow.dbDeep, 'kept');
  } finally { restore(); }
});

test('clientOnly does not fetch', async () => {
  const { calls, restore } = stubOverview();
  try {
    await AdminCockpit._refreshOverview({ force: true });
    const n = calls.length;
    await AdminCockpit._refreshOverview({ clientOnly: true });
    assert.equal(calls.length, n);
    assert.equal(AdminCockpit._ovSignals.length, 7);
  } finally { restore(); }
});

test('no plant: Jobs runs and SAP reads are skipped', async () => {
  const { calls, restore } = stubOverview({ plant: null });
  try {
    await AdminCockpit._refreshOverview({ force: true });
    assert.ok(!calls.includes('jobs.runs'));
    assert.ok(!calls.some(c => c.startsWith('/sap/')));
    assert.equal(sigOf('sap').reasonKey, 'sig.sap_no_plant');
  } finally { restore(); }
});

test('with a plant and admin the SAP reads and Jobs runs happen', async () => {
  const { calls, restore } = stubOverview();
  try {
    await AdminCockpit._refreshOverview({ force: true });
    assert.equal(calls.filter(c => c === 'jobs.runs').length, 2);
    assert.ok(calls.some(c => c.startsWith('/sap/staging/send/P1/status')));
    assert.ok(calls.some(c => c.startsWith('/sap/staging/batches?plant=P1&limit=20')));
    assert.ok(calls.some(c => c.startsWith('/sap/interface/runs?limit=1')));
  } finally { restore(); }
});

function withTabDom(active, fn) {
  const prior = globalThis.document;
  globalThis.document = {
    querySelectorAll() { return []; },
    getElementById(id) { return id === 'admin-tab' ? { classList: { contains: () => active } } : null; },
  };
  try { return fn(); } finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; }
}

test('pause skips the tick; resume runs it', () => {
  const A = AdminCockpit; let n = 0;
  const real = A._refreshOverview; const priorSub = A._activeSub; const priorPaused = A._ovPaused;
  A._refreshOverview = async () => { n++; };
  try {
    withTabDom(true, () => {
      A._activeSub = 'overview';
      A._ovPaused = true; A._ovPoll(); assert.equal(n, 0);
      A._ovPaused = false; A._ovPoll(); assert.equal(n, 1);
      A._activeSub = 'logs'; A._ovPoll(); assert.equal(n, 1, 'other sub-tab: no tick');
    });
    withTabDom(false, () => { A._activeSub = 'overview'; A._ovPoll(); assert.equal(n, 1, 'Admin tab hidden: no tick'); });
  } finally { A._refreshOverview = real; A._activeSub = priorSub; A._ovPaused = priorPaused; }
});

test('start is idempotent and _setSub("logs") stops both timers', () => {
  const A = AdminCockpit;
  const restore = stubAll(ALL_RENDERERS.filter(n => n !== '_stopHealthPolling' && n !== '_startHealthPolling'), []);
  try {
    withEmptyDom(() => {
      A._startHealthPolling();
      const t = A._ovTimer, k = A._ovTick;
      A._startHealthPolling();
      assert.ok(t && k);
      assert.equal(A._ovTimer, t); assert.equal(A._ovTick, k);
      A._setSub('logs');
      assert.equal(A._ovTimer, null); assert.equal(A._ovTick, null);
    });
  } finally { A._stopHealthPolling(); restore(); }
});

test('_onSignalFix("nav.jobs") goes to the Jobs sub-tab', async () => {
  const A = AdminCockpit; const seen = []; const real = A.gotoSub;
  A.gotoSub = (s) => { seen.push(s); };
  try { await A._onSignalFix({ id: 'nav.jobs', labelKey: 'ov.details' }); } finally { A.gotoSub = real; }
  assert.deepEqual(seen, ['jobs']);
});

test('jobs.open_run renders the Jobs pane before opening the run', async () => {
  const A = AdminCockpit; const { JobsAdmin } = await import('../../../frontend/admin-ops/jobs-pane.mjs');
  const order = []; const realGo = A.gotoSub; const realRender = JobsAdmin.render; const realOpen = JobsAdmin.openRun;
  A.gotoSub = (s) => { order.push('goto:' + s); };
  JobsAdmin.render = async () => { order.push('render'); };
  JobsAdmin.openRun = (id) => { order.push('open:' + id); };
  try { await A._onSignalFix({ id: 'jobs.open_run', labelKey: 'btn.open_run', args: { runId: 7 } }); }
  finally { A.gotoSub = realGo; JobsAdmin.render = realRender; JobsAdmin.openRun = realOpen; }
  assert.deepEqual(order, ['goto:jobs', 'render', 'open:7']);
});

test('admin-only fixes do nothing for a non-admin', async () => {
  const A = AdminCockpit; const real = A._runMaintenance; let ran = 0; const priorAdmin = Session.isAdmin;
  A._runMaintenance = async () => { ran++; };
  Session.isAdmin = () => false;
  try {
    await A._onSignalFix({ id: 'db.vacuum_table', labelKey: 'btn.vacuum', args: { table: 'orders' }, adminOnly: true });
    await A._onSignalFix({ id: 'db.vacuum_table', labelKey: 'btn.vacuum', args: { table: 'orders' } });
  } finally { A._runMaintenance = real; Session.isAdmin = priorAdmin; }
  assert.equal(ran, 0);
});

test('db.vacuum_table calls _runMaintenance("vacuum-analyze", table) and refreshes', async () => {
  const A = AdminCockpit; const real = A._runMaintenance; const realRef = A._refreshOverview; const priorAdmin = Session.isAdmin;
  const seen = []; let refreshed = 0;
  A._runMaintenance = async (...a) => { seen.push(a); };
  A._refreshOverview = async () => { refreshed++; };
  Session.isAdmin = () => true;
  try { await A._onSignalFix({ id: 'db.vacuum_table', labelKey: 'btn.vacuum', args: { table: 'orders' } }); }
  finally { A._runMaintenance = real; A._refreshOverview = realRef; Session.isAdmin = priorAdmin; }
  assert.deepEqual(seen, [['vacuum-analyze', 'orders', null]]);
  assert.equal(refreshed, 1);
});

// A tiny fake DOM for the renderers (createElement-only construction).
function fakeEl(tag) {
  const n = {
    tag, children: [], dataset: {}, attrs: {}, className: '', _text: '', hidden: false, title: '', disabled: false, type: '',
    appendChild(c) { n.children.push(c); return c; },
    append(...cs) { for (const c of cs) n.children.push(c); },
    setAttribute(k, v) { n.attrs[k] = v; },
    contains() { return false; },
    querySelector() { return null; },
    closest() { return null; },
    get textContent() { return n._text; },
    set textContent(v) { n._text = v; if (v === '') n.children = []; },
  };
  return n;
}
function withRenderDom(hosts, fn) {
  const prior = globalThis.document;
  globalThis.document = {
    activeElement: null,
    createElement: fakeEl,
    createTextNode(t) { return { text: t, _text: t }; },
    getElementById(id) { return hosts[id] ?? null; },
    querySelectorAll() { return []; },
  };
  try { return fn(); } finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; }
}

test('_renderSignals builds one row per signal with data-sig and data-sev, and repaints only on change', async () => {
  const { restore } = stubOverview();
  try {
    await AdminCockpit._refreshOverview({ force: true });
    const host = fakeEl('div');
    withRenderDom({ 'ov-signals': host }, () => {
      AdminCockpit._ovSigKey = '';
      AdminCockpit._renderSignals(AdminCockpit._ovSignals);
      assert.equal(host.children.length, 7);
      for (const row of host.children) {
        assert.ok(row.dataset.sig && row.dataset.sev);
        assert.equal(row.attrs.role, 'listitem');
      }
      const first = host.children[0];
      AdminCockpit._renderSignals(AdminCockpit._ovSignals);
      assert.equal(host.children[0], first, 'unchanged signals: no repaint');
    });
  } finally { restore(); }
});

test('_renderAttention with nothing to flag shows the all-clear key', () => {
  const host = fakeEl('div');
  withRenderDom({ 'ov-attention': host }, () => AdminCockpit._renderAttention([]));
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0]._text, 'ov.attention_clear');
});

test('_renderRecent shows at most 10 rows', async () => {
  const { restore } = stubOverview();
  try {
    await AdminCockpit._refreshOverview({ force: true });
    AdminCockpit._ovSlow.auditLog = Array.from({ length: 25 }, (_, i) => ({ ts: new Date(Date.now() - i * 1000).toISOString(), user: 'u', action: 'a' + i }));
    const host = fakeEl('div');
    withRenderDom({ 'ov-recent': host }, () => AdminCockpit._renderRecent());
    assert.equal(host.children.length, 10);
  } finally { restore(); }
});

test('markup, CSS and source: health bar gone, signal board present, no innerHTML in the Overview renderers', () => {
  const read = f => readFileSync(new URL('../../../frontend/' + f, import.meta.url), 'utf8');
  const html = read('index.html'); const css = read('styles.css'); const src = read('admin-ops/admin-ui.mts');
  assert.ok(!html.includes('admin-health-bar'));
  assert.equal(AdminCockpit._renderHealth, undefined);
  for (const id of ['ov-meta', 'ov-pause', 'ov-refresh', 'ov-signals-card', 'ov-signals', 'ov-attention', 'ov-recent', 'ov-open-logs']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  const rows = css.split('\n').filter(l => /^\.sig-row/.test(l) || /^\.attn-row/.test(l)).join('\n');
  assert.ok(!/border-left/.test(rows));
  assert.match(css, /\.sig-row\[data-sev="warn"\]\s+\.sig-name\s*\{\s*color:\s*var\(--warn-text\)/);
  assert.match(css, /\.sig-detail\[hidden\]\s*\{\s*display:\s*none/);
  const a = src.indexOf('_renderOvMeta(): void'); const b = src.indexOf("case 'client.reset'");
  assert.ok(a > 0 && b > a);
  assert.ok(!src.slice(a, b).includes('innerHTML'));
  assert.ok(!/label: '(DB Load|Color Merge|Emitted|Rendered)'/.test(src));
});

test('_exportDiagnostics reads the cached health and deep data', () => {
  const src = readFileSync(new URL('../../../frontend/admin-ops/admin-ui.mts', import.meta.url), 'utf8');
  assert.match(src, /health:\s+AdminCockpit\._healthData/);
  assert.match(src, /deep:\s+AdminCockpit\._deepData/);
});
