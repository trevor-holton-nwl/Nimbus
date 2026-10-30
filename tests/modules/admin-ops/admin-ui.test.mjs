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

test('the three old log renderers and their filter state are gone (the Logs sub-tab is UnifiedLogPane)', () => {
  for (const k of ['_renderBackendLog', '_renderLogs', '_renderAuditLog', '_getFilteredEntries', '_correlateReqId', '_renderReqIdChip', '_logFilter', '_backendLogFilter']) {
    assert.equal(AdminCockpit[k], undefined, k);
  }
  assert.equal(typeof AdminCockpit._copyFiltered, 'function');
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
  '_refreshOverview', '_renderDiagnostics', '_renderPipeline',
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
  const restore = stubAll(['_refreshOverview', '_startHealthPolling', '_stopHealthPolling', '_renderDiagnostics', '_renderPipeline', '_renderDbDeep', '_refreshThreadPane', '_renderPurgeMeta', '_renderAudit'], calls);
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
  const LAZY = new Set(['admin-upload-detail', 'admin-diag-storage']);   // admin-diag-refresh / -export are static page-head buttons now
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
    handlers: {},
    addEventListener(t, fn) { n.handlers[t] = fn; },
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

test('_renderLogsPane initialises, renders and activates the unified pane; leaving Logs deactivates it', async () => {
  const { UnifiedLogPane } = await import('../../../frontend/admin-ops/unified-log-pane.mjs');
  const real = { i: UnifiedLogPane.init, r: UnifiedLogPane.render, s: UnifiedLogPane.setActive };
  const seen = [];
  UnifiedLogPane.init = () => seen.push('init'); UnifiedLogPane.render = () => { seen.push('render'); return Promise.resolve(); };
  UnifiedLogPane.setActive = (on) => seen.push(`active:${on}`);
  try {
    AdminCockpit._renderLogsPane();
    assert.deepEqual(seen, ['init', 'render', 'active:true']);
    seen.length = 0;
    const restore = stubAll(['_refreshOverview', '_startHealthPolling', '_stopHealthPolling'], []);
    try { withEmptyDom(() => AdminCockpit._setSub('overview')); } finally { restore(); }
    assert.ok(seen.includes('active:false'));
  } finally { UnifiedLogPane.init = real.i; UnifiedLogPane.render = real.r; UnifiedLogPane.setActive = real.s; }
});

// ---- W5: _capList + the design-pass markup/CSS pins -------------------------------------------------------
test('_capList shows only cap items plus a Show all toggle over the cap, none at or under it', () => {
  const prior = globalThis.document;
  globalThis.document = { createElement: fakeEl, createTextNode: t => ({ _text: t }) };
  try {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const host = fakeEl('div');
    AdminCockpit._capList(items, 10, vis => { for (const i of vis) host.appendChild(Object.assign(fakeEl('span'), { _text: String(i) })); }, host);
    assert.equal(host.children.length, 11);                       // 10 rows + the toggle
    const btn = host.children[10];
    assert.equal(btn.tag, 'button');
    assert.equal(btn._text, 'btn.show_all_n');
    btn.handlers.click();
    assert.equal(host.children.length, 31);                       // all rows + Show fewer
    assert.equal(host.children[30]._text, 'btn.show_fewer');
    host.children[30].handlers.click();
    assert.equal(host.children.length, 11);
    const small = fakeEl('div');
    AdminCockpit._capList([1, 2, 3], 10, vis => { vis.forEach(() => small.appendChild(fakeEl("i"))); }, small);
    assert.equal(small.children.length, 3);
  } finally { globalThis.document = prior; }
});

test('Diagnostics: thread section sits last, collapsed, data-i18n; the five static sections and the rail exist; upload-detail host exists', () => {
  const html = readFileSync(new URL('../../../frontend/index.html', import.meta.url), 'utf8');
  const pane = html.slice(html.indexOf('id="admin-diag-pane"'), html.indexOf('/admin-diag-pane'));
  const order = ['diag-client', 'diag-pipe', 'diag-bwarn', 'diag-db', 'diag-thread'].map(id => pane.indexOf(`id="${id}"`));
  assert.ok(order.every(i => i > 0), 'five static sections');
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'page order: client, pipe, bwarn, db, thread (thread last)');
  assert.equal((pane.match(/<details class="diag-sec"/g) || []).length, 5);
  assert.ok(pane.includes('<nav class="diag-rail" id="diag-rail"'));
  const t = pane.indexOf('id="diag-thread"');
  assert.ok(!/<details[^>]*id="diag-thread"[^>]*\sopen/.test(pane.slice(t - 60, t + 80)), 'thread collapsed');
  assert.ok(!pane.includes('Main Thread Profiler</h3>'));
  assert.match(pane, /<th data-i18n="thread.col_p50">/);
  assert.match(pane, /<th data-i18n="thread.col_p95">/);
  for (const gone of ['admin-pipeline-refresh', 'admin-db-deep-refresh']) {
    assert.ok(!html.includes(gone), gone + ' is gone from the markup');
    assert.ok(!readFileSync(new URL('../../../frontend/admin-ops/admin-ui.mts', import.meta.url), 'utf8').includes(gone), gone + ' is gone from the code');
  }
  assert.ok(html.includes('id="admin-upload-detail"'));
  assert.ok(html.includes('data-i18n-aria-label="aria.upload_zone"'));
});

test('design-pass CSS pins: no side stripe in Logs, one-line recent rows, subtab scroll, ov-acts', () => {
  const css = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#ulog-list \.admin-log-row\s*\{\s*border-left-color:\s*transparent/);
  assert.match(css, /#ulog-list\s*\{[^}]*calc\(100vh - 340px\)[^}]*min-height:\s*320px/);
  assert.match(css, /\.ov-recent-row \.admin-log-msg\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.ov-acts\s*\{/);
  assert.match(css, /\.sig-dt th\.num\s*\{\s*text-align:\s*right/);
  assert.match(css, /\.admin-subtabs\s*\{\s*flex-wrap:\s*nowrap;\s*overflow-x:\s*auto/);
});

// ---- W2: Diagnostics jump-rail sections ------------------------------------------------------------------
// A small tree-shaped fake DOM: parent links, a real class set, dataset, <details>.open, focus/scroll recording.
function dnode(tag, { id = '', cls = '' } = {}) {
  const classes = new Set(cls.split(' ').filter(Boolean));
  const n = {
    tagName: tag.toUpperCase(), id, parentElement: null, children: [], dataset: {}, attrs: {}, open: false, hidden: false,
    style: {}, title: '', href: '', tabIndex: 0, _text: '', listeners: {}, focused: null, scrolled: null,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); for (const c of String(v).split(' ').filter(Boolean)) classes.add(c); },
    appendChild(c) { c.parentElement = n; n.children.push(c); return c; },
    setAttribute(k, v) { n.attrs[k] = v; },
    getAttribute(k) { return n.attrs[k] ?? null; },
    removeAttribute(k) { delete n.attrs[k]; },
    addEventListener(t, fn) { (n.listeners[t] ||= []).push(fn); },
    focus(o) { n.focused = o ?? {}; },
    scrollIntoView(o) { n.scrolled = o; },
    get textContent() { return n._text; },
    set textContent(v) { n._text = v; if (v === '') n.children = []; },
    querySelector(sel) {
      const hit = (x) => (sel.startsWith('.') ? x.classList.contains(sel.slice(1))
        : sel.startsWith('[data-sec="') ? x.dataset.sec === sel.slice(11, -2) : x.tagName === sel.toUpperCase());
      const walk = (x) => { for (const c of x.children) { if (hit(c)) return c; const r = walk(c); if (r) return r; } return null; };
      return walk(n);
    },
  };
  return n;
}
function diagSec(id, sev = 'ok') {
  return { id, severity: sev, titleKey: 'ui.data_pipeline', lineKey: 'diag.line_bwarn', lineArgs: {}, shortKey: 'diag.short_bwarn', shortArgs: { n: 1 } };
}
function withDiagDom(els, fn, extra = {}) {
  const prior = globalThis.document;
  globalThis.document = { getElementById: (id) => els[id] ?? null, createElement: (t) => dnode(t), querySelectorAll: () => [], ...extra };
  try { return fn(); } finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; }
}

test('_revealAnchor opens the element and every <details> above it, flashes it, scrolls and focuses the summary', () => {
  const outer = dnode('details', { id: 'diag-db', cls: 'diag-sec' });
  const inner = dnode('details', { id: 'diag-db-conn', cls: 'diag-sub' });
  const sum = dnode('summary');
  outer.appendChild(inner); inner.appendChild(sum);
  const priorMM = globalThis.matchMedia;
  const timers = [];
  const priorST = globalThis.setTimeout;
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  try {
    AdminCockpit._revealAnchor(inner);
    assert.equal(inner.open, true);
    assert.equal(outer.open, true, 'the closed Database parent opens too');
    assert.equal(inner.classList.contains('is-target'), true);
    assert.deepEqual(inner.scrolled, { block: 'start', behavior: 'smooth' });
    assert.deepEqual(sum.focused, { preventScroll: true }, 'focus goes to the summary without scrolling again');
    // animationend never fires under reduced motion: the fallback timer clears the class
    timers[0]();
    assert.equal(inner.classList.contains('is-target'), false);
  } finally { globalThis.matchMedia = priorMM; globalThis.setTimeout = priorST; if (priorMM === undefined) delete globalThis.matchMedia; }
});

test('_revealAnchor under prefers-reduced-motion scrolls with behavior auto', () => {
  const det = dnode('details', { id: 'diag-pipe', cls: 'diag-sec' });
  det.appendChild(dnode('summary'));
  const priorMM = globalThis.matchMedia, priorST = globalThis.setTimeout;
  globalThis.matchMedia = (q) => ({ matches: /reduce/.test(q) });
  globalThis.setTimeout = () => 0;
  try {
    AdminCockpit._revealAnchor(det);
    assert.equal(det.scrolled.behavior, 'auto');
  } finally { globalThis.matchMedia = priorMM; globalThis.setTimeout = priorST; if (priorMM === undefined) delete globalThis.matchMedia; }
});

test('_diagOpen wins over the severity default on repaint (closed-while-warn stays closed, opened-while-ok stays open)', () => {
  AdminCockpit._diagOpen.clear();
  const warn = dnode('details', { id: 'diag-pipe', cls: 'diag-sec' });
  const ok = dnode('details', { id: 'diag-bwarn', cls: 'diag-sec' });
  const toggle = (d) => AdminCockpit._onDiagToggle({ target: d });
  try {
    AdminCockpit._syncOpen(warn, diagSec('pipe', 'warn'));
    AdminCockpit._syncOpen(ok, diagSec('bwarn', 'ok'));
    assert.equal(warn.open, true, 'warn opens by default');
    assert.equal(ok.open, false, 'ok stays closed by default');
    toggle(warn);                                  // the echo of our own programmatic open (ok never changed: no event): not a user choice
    assert.equal(AdminCockpit._diagOpen.size, 0, 'a programmatic open/close is not remembered as a user choice');
    warn.open = false; toggle(warn);               // the user closes the warn section
    ok.open = true; toggle(ok);                    // and opens the ok one
    assert.equal(AdminCockpit._diagOpen.get('diag-pipe'), false);
    assert.equal(AdminCockpit._diagOpen.get('diag-bwarn'), true);
    AdminCockpit._syncOpen(warn, diagSec('pipe', 'err'));   // a repaint, now even worse
    AdminCockpit._syncOpen(ok, diagSec('bwarn', 'ok'));
    assert.equal(warn.open, false, 'closed by the user: stays closed');
    assert.equal(ok.open, true, 'opened by the user: stays open');
  } finally { AdminCockpit._diagOpen.clear(); }
});

test('_paintSectionHead updates the head in place and never replaces the <details>', () => {
  AdminCockpit._diagOpen.clear();
  const det = dnode('details', { id: 'diag-bwarn', cls: 'diag-sec' });
  const sum = dnode('summary');
  for (const c of ['diag-title-text', 'diag-count', 'diag-line']) sum.appendChild(dnode('span', { cls: c }));
  det.appendChild(sum);
  const host = { 'diag-bwarn': det };
  withDiagDom(host, () => {
    AdminCockpit._paintSectionHead({ ...diagSec('bwarn', 'warn'), count: 3 });
    assert.equal(det.dataset.sev, 'warn');
    assert.equal(sum.querySelector('.diag-count').textContent, '3');
    assert.equal(sum.querySelector('.diag-line').textContent, 'diag.line_bwarn');
    AdminCockpit._paintSectionHead({ ...diagSec('bwarn', 'ok'), count: 0 });
    assert.equal(host['diag-bwarn'], det);
    assert.equal(det.dataset.sev, 'ok');
  });
  AdminCockpit._diagOpen.clear();
});

test('_ensureDbSubs builds the eight Database sub-sections once; _mkSection reuses the element on repaint', () => {
  const dbHost = dnode('div', { id: 'admin-db-deep' });
  const els = { 'admin-db-deep': dbHost };
  const reg = (n) => { els[n.id] = n; };
  const prior = globalThis.document;
  globalThis.document = { getElementById: (id) => els[id] ?? null, createElement: (t) => dnode(t), querySelectorAll: () => [] };
  try {
    // register sub-sections as they are appended (the real DOM does this by id lookup)
    const append = dbHost.appendChild.bind(dbHost);
    dbHost.appendChild = (c) => { reg(c); return append(c); };
    AdminCockpit._ensureDbSubs();
    const ids = dbHost.children.map(c => c.id);
    assert.deepEqual(ids, ['diag-db-pool', 'diag-db-server', 'diag-db-tables', 'diag-db-conn', 'diag-db-locks', 'diag-db-idx', 'diag-db-slow', 'diag-db-seq']);
    const pool = els['diag-db-pool'];
    AdminCockpit._ensureDbSubs();
    assert.equal(dbHost.children.length, 8, 'no duplicates');
    assert.equal(els['diag-db-pool'], pool, 'same element');
    AdminCockpit._fillSub('db-pool', (body) => { body.textContent = 'x'; });
    assert.equal(pool.querySelector('.diag-body').textContent, 'x');
    assert.equal(els['diag-db-pool'], pool, 'a body refill keeps the <details>');
  } finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; }
});

test('_renderDiagRail builds 13 links once (db-* indented) and then updates them in place', () => {
  const rail = dnode('nav', { id: 'diag-rail' });
  rail.querySelector = ((orig) => (sel) => (sel === '.diag-rail-link' ? (rail.children.find(c => c.classList.contains('diag-rail-link')) ?? null) : orig(sel)))(rail.querySelector);
  const ids = ['client', 'pipe', 'bwarn', 'db', 'db-pool', 'db-server', 'db-tables', 'db-conn', 'db-locks', 'db-idx', 'db-slow', 'db-seq', 'thread'];
  const secs = ids.map(id => ({ ...diagSec(id), titleKey: 'thread.title' }));
  withDiagDom({ 'diag-rail': rail }, () => {
    AdminCockpit._renderDiagRail(secs);
    const links = rail.children.filter(c => c.classList.contains('diag-rail-link'));
    assert.equal(links.length, 13);
    assert.equal(links.filter(l => l.classList.contains('is-sub')).length, 8);
    assert.equal(links[0].dataset.anchor, 'diag-client');
    assert.equal(links[4].dataset.anchor, 'diag-db-pool');
    AdminCockpit._renderDiagRail(secs.map(s => ({ ...s, severity: 'err' })));
    assert.equal(rail.children.filter(c => c.classList.contains('diag-rail-link'))[0], links[0], 'same link element');
    assert.equal(links[0].dataset.sev, 'err');
  });
});

test('rail links and [data-anchor] buttons go through _revealAnchor; a help dot in a head does not toggle it', () => {
  const target = dnode('details', { id: 'diag-bwarn', cls: 'diag-sec' });
  const seen = [];
  const real = AdminCockpit._revealAnchor;
  AdminCockpit._revealAnchor = (el) => seen.push(el.id);
  try {
    withDiagDom({ 'diag-bwarn': target }, () => {
      let prevented = 0;
      const btn = { closest: (s) => (s === '[data-anchor]' ? btn : null), dataset: { anchor: 'diag-bwarn' } };
      AdminCockpit._onDiagClick({ target: btn, preventDefault() { prevented++; } });
      assert.deepEqual(seen, ['diag-bwarn']);
      assert.equal(prevented, 1);
      const help = { closest: (s) => (s === '.diag-sec-sum .adm-help' ? help : null), dataset: {} };
      AdminCockpit._onDiagClick({ target: help, preventDefault() { prevented++; } });
      assert.equal(prevented, 2);
      assert.equal(seen.length, 1);
    });
  } finally { AdminCockpit._revealAnchor = real; }
});

test('_setSub("diagnostics") creates the scroll-spy observer and renders the pane once; leaving disconnects it', () => {
  const made = [];
  const priorIO = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class { constructor(cb, o) { this.cb = cb; this.o = o; this.disconnected = false; made.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  const calls = [];
  const restore = stubAll(ALL_RENDERERS.filter(n => n !== '_renderDiagnosticsPane'), []);
  const realPane = AdminCockpit._renderDiagnosticsPane;
  AdminCockpit._renderDiagnosticsPane = () => { calls.push('pane'); };
  try {
    withEmptyDom(() => AdminCockpit._setSub('diagnostics'));
    assert.deepEqual(calls, ['pane'], 'rendered exactly once');
    assert.equal(made.length, 1);
    assert.equal(made[0].o.rootMargin, '-80px 0px -60% 0px');
    assert.ok(AdminCockpit._spy);
    withEmptyDom(() => AdminCockpit._setSub('overview'));
    assert.equal(made[0].disconnected, true);
    assert.equal(AdminCockpit._spy, null);
  } finally {
    AdminCockpit._renderDiagnosticsPane = realPane; restore();
    if (priorIO === undefined) delete globalThis.IntersectionObserver; else globalThis.IntersectionObserver = priorIO;
  }
});

test('init wires the page-head Refresh to a forced repaint, Export, and the pane delegates; the removed refresh ids are never looked up', () => {
  const wired = {}; const asked = [];
  const priorDoc = globalThis.document, priorInit = AdminCockpit._initialized;
  const node = (id) => ({ id, addEventListener(t, fn, cap) { (wired[id] ||= []).push([t, fn, cap]); }, classList: { contains() { return false; } }, closest() { return null; } });
  globalThis.document = {
    getElementById(id) { asked.push(id); return node(id); },
    querySelectorAll() { return []; },
  };
  const realPane = AdminCockpit._renderDiagnosticsPane, realExport = AdminCockpit._exportDiagnostics;
  const paneCalls = []; let exported = 0;
  AdminCockpit._renderDiagnosticsPane = (o) => { paneCalls.push(o); };
  AdminCockpit._exportDiagnostics = () => { exported++; };
  try {
    AdminCockpit._initialized = false;
    AdminCockpit.init();
    assert.ok(!asked.includes('admin-pipeline-refresh'));
    assert.ok(!asked.includes('admin-db-deep-refresh'));
    wired['admin-diag-refresh'][0][1]();
    assert.deepEqual(paneCalls, [{ force: true }]);
    wired['admin-diag-export'][0][1]();
    assert.equal(exported, 1);
    const pane = wired['admin-diag-pane'];
    assert.ok(pane.some(([t, , cap]) => t === 'toggle' && cap === true), 'one capture-phase toggle listener');
    assert.ok(pane.some(([t]) => t === 'click'));
  } finally {
    AdminCockpit._renderDiagnosticsPane = realPane; AdminCockpit._exportDiagnostics = realExport;
    AdminCockpit._initialized = priorInit;
    if (priorDoc === undefined) delete globalThis.document; else globalThis.document = priorDoc;
  }
});

test('CSS pins: diag rail is sticky, sections carry scroll-margin, the flash is disabled under reduced motion, dead db tile rules are gone', () => {
  const css = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.diag-rail\s*\{\s*position:\s*sticky;\s*top:\s*12px;\s*max-height:\s*calc\(100vh - 24px\);\s*overflow:\s*auto/);
  assert.match(css, /\.diag-sec\s*\{[^}]*scroll-margin-top:\s*12px/);
  assert.match(css, /@keyframes diag-flash/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.diag-sec\.is-target\s*\{\s*animation:\s*none/);
  assert.match(css, /\.diag-sec\[data-sev="warn"\]\s*>\s*\.diag-sec-sum \.diag-title\s*\{\s*color:\s*var\(--warn-text\)/);
  assert.ok(!/\.admin-db-summary|\.admin-db-stat-tile|\.admin-db-section\b|\.admin-db-fetched/.test(css));
  const src = readFileSync(new URL('../../../frontend/admin-ops/admin-ui.mts', import.meta.url), 'utf8');
  assert.ok(!src.includes('_dbSummaryStrip') && !src.includes('admin-db-fetched'));
  for (const lit of ["'VACUUM ANALYZE'", "'BLOCKING'", '`BLOCKED ', ' calls`', 'aria-label="Help"', '<em>none</em>']) assert.ok(!src.includes(lit), lit);
});
