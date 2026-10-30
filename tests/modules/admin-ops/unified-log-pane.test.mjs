// Tests for frontend/admin-ops/unified-log-pane.mjs (the Admin Logs sub-tab): filter state, fetch fan-out,
// the context rail and the clear-button wiring. Fake DOM in the style of admin-ui.test.mjs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};

function mkEl(tag, id) {
  const n = {
    tag, id: id || '', children: [], dataset: {}, attrs: {}, className: '', _text: '', hidden: false, title: '', type: '', value: '',
    checked: false, scrollTop: 0, parentElement: null, _l: {}, _classes: new Set(), innerHTML: '',
    classList: {
      add: (c) => n._classes.add(c), remove: (c) => n._classes.delete(c), contains: (c) => n._classes.has(c),
      toggle: (c, f) => { if (f === undefined ? !n._classes.has(c) : f) n._classes.add(c); else n._classes.delete(c); },
    },
    appendChild(c) { c.parentElement = n; n.children.push(c); return c; },
    append(...cs) { for (const c of cs) n.appendChild(c); },
    setAttribute(k, v) { n.attrs[k] = v; },
    addEventListener(t, f) { (n._l[t] ||= []).push(f); },
    fire(t, ev = {}) { for (const f of n._l[t] || []) f({ target: n, stopPropagation() {}, preventDefault() {}, ...ev }); },
    querySelector(sel) { return sel === '.ulog-count' ? (n._count ?? null) : null; },
    querySelectorAll(sel) { return sel.includes('input[data-src]') ? (n._boxes ?? []) : []; },
    get textContent() { return n._text; },
    set textContent(v) { n._text = v; if (v === '') n.children = []; },
  };
  return n;
}

const SRC = ['backend', 'frontend', 'audit', 'upload', 'jobs', 'events', 'sap'];
function installDom() {
  const els = {};
  const get = (id) => (els[id] ||= mkEl('div', id));
  get('ulog-sources')._boxes = SRC.map((s) => {
    const label = mkEl('label'); const cb = mkEl('input'); cb.dataset.src = s;
    label._count = mkEl('span'); label.appendChild(cb);
    return cb;
  });
  globalThis.document = {
    visibilityState: 'visible',
    createElement: (t) => mkEl(t),
    getElementById: get,
    querySelectorAll: () => [],
    addEventListener() {},
    createRange: () => ({ selectNodeContents() {} }),
  };
  return els;
}

const { UnifiedLogPane } = await import('../../../frontend/admin-ops/unified-log-pane.mjs');
const { AdminCockpit } = await import('../../../frontend/admin-ops/admin-ui.mjs');
const { ErrorLog } = await import('../../../frontend/platform/foundation.mjs');
const { Session } = await import('../../../frontend/security/session.mjs');
const { Store } = await import('../../../frontend/platform/store.mjs');
const { JobsClient } = await import('../../../frontend/admin-ops/jobs-client.mjs');
const { sourceCounts, filterEntries } = await import('../../../frontend/admin-ops/unified-log.mjs');

const T = (m) => `2026-10-30T10:0${m}:00Z`;
const BACKEND = [
  { ts: T(5), level: 'error', category: 'db', msg: 'boom', rid: 'r1', ctx: { plant: 'P1', order_id: 'o1', action_id: 'a1' }, actor: 'alice' },
  { ts: T(4), level: 'info', category: 'app', msg: 'no plant here' },
  { ts: T(3), level: 'warn', category: 'app', msg: 'other plant', ctx: { plant: 'P2' } },
];
const AUDIT = [{ ts: T(2), user: 'alice', action: 'opt.run', plant: 'P1', rid: 'r1' }];
const EVENTS = [{ id: 7, at: T(1), actor: 'alice', actor_name: null, source: 'planner', op: 'move', action_id: 'a1', client_id: null, order_id: 'o1', production_order: 'PO1', material_number: null, fields: ['start'] }];

let calls, routes, store, priorFetch;
function resp(status, body) { return Promise.resolve({ ok: status >= 200 && status < 300, status, headers: new Map(), json: () => Promise.resolve(body) }); }

beforeEach(() => {
  UnifiedLogPane._reset();
  calls = [];
  routes = { events: [200, { events: EVENTS }] };
  store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  Session.isAdmin = () => true;
  Store._state.selectedPlant = 'P1';
  JobsClient.runs = async (q) => { calls.push(['runs', q.plant]); return { items: [], nextBeforeId: null }; };
  ErrorLog.entries = () => [];
  priorFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url); calls.push(['GET', u]);
    if (u.includes('/logs/backend')) return resp(200, { entries: BACKEND });
    if (u.includes('/audit/log')) return resp(200, { entries: AUDIT });
    if (u.includes('/upload/audit')) return resp(200, { audit: [] });
    if (u.includes('/sap/interface/runs')) return resp(200, { runs: [] });
    if (u.includes('/schedule-events/')) return resp(...routes.events);
    return resp(404, {});
  };
});
afterEach(() => { globalThis.fetch = priorFetch; UnifiedLogPane.setActive(false); delete globalThis.document; });

const rowKeys = (els) => els['ulog-list'].children.filter((c) => c.dataset.key).map((c) => c.dataset.key);
const boot = async () => { const els = installDom(); UnifiedLogPane.init(); await UnifiedLogPane.render(); return els; };
const selectErr = (els) => els['ulog-list'].children.find((c) => c.dataset.key?.startsWith('backend|') && c.className.includes('admin-log-error'));

test('default filter has a blank plant and no sources (all shown)', () => {
  installDom(); UnifiedLogPane.init();
  const f = UnifiedLogPane._state().filter;
  assert.equal(f.plant, ''); assert.equal(f.sources.size, 0); assert.equal(f.level, 'all'); assert.equal(f.q, '');
});

test('render reads every source once, events for the selected plant only', async () => {
  await boot();
  const urls = calls.filter((c) => c[0] === 'GET').map((c) => c[1]);
  for (const part of ['/logs/backend?limit=200', '/audit/log?limit=200', '/upload/audit', '/sap/interface/runs?limit=50', '/schedule-events/P1/recent?limit=100']) {
    assert.equal(urls.filter((u) => u.includes(part)).length, 1, part);
  }
  assert.deepEqual(calls.find((c) => c[0] === 'runs'), ['runs', 'P1']);
});

test('ticking two sources shows their union and counts match sourceCounts', async () => {
  const els = await boot();
  UnifiedLogPane.setFilter({ sources: new Set(['backend', 'audit']) });
  const st = UnifiedLogPane._state();
  const want = filterEntries(st.entries, st.filter).map((e) => e.key);
  assert.deepEqual(rowKeys(els), want);
  assert.ok(want.length === 4 && st.entries.some((e) => e.source === 'events'));
  const counts = sourceCounts(st.entries, st.filter);
  els['ulog-sources']._boxes.forEach((cb) => assert.equal(cb.parentElement._count.textContent, String(counts[cb.dataset.src])));
});

test('a plant keeps null-plant rows and drops other plants', async () => {
  const els = await boot();
  UnifiedLogPane.setFilter({ plant: 'P1' }); await UnifiedLogPane.render();
  const plants = UnifiedLogPane.filteredEntries().map((e) => e.plant);
  assert.ok(plants.includes(null) && plants.includes('P1') && !plants.includes('P2'));
  assert.equal(rowKeys(els).length, plants.length);
});

test('plant set with Backend and Browser unticked leaves only that plant', async () => {
  await boot();
  UnifiedLogPane.setFilter({ plant: 'P1', sources: new Set(['audit', 'upload', 'jobs', 'events', 'sap']) }); await UnifiedLogPane.render();
  const plants = UnifiedLogPane.filteredEntries().map((e) => e.plant);
  assert.ok(plants.length >= 2 && plants.every((p) => p === 'P1'));
});

test('the logs.open fix presets level and source', async () => {
  await boot();
  const A = AdminCockpit; const real = A.gotoSub; A.gotoSub = () => {};
  try { await A._onSignalFix({ id: 'logs.open', labelKey: 'btn.view_logs' }); } finally { A.gotoSub = real; }
  const f = UnifiedLogPane._state().filter;
  assert.equal(f.level, 'warn'); assert.deepEqual([...f.sources], ['backend']);
  assert.equal(JSON.parse(store.get('nimbus.ulog.filter')).level, 'warn');
});

test('selecting a row fills the rail: groups in order, never the entry itself', async () => {
  const els = await boot();
  const row = selectErr(els);
  assert.ok(row); row.fire('click');
  const body = els['ulog-rail-body'];
  const groups = body.children.filter((c) => c.dataset.kind);
  assert.deepEqual(groups.map((g) => g.dataset.kind), ['request', 'action', 'order', 'user_window']);
  for (const g of groups) for (const r of g.children.filter((c) => c.dataset.key)) assert.notEqual(r.dataset.key, row.dataset.key);
  assert.ok(row._classes.has('is-selected'));
  assert.ok(body.children.some((c) => c.tag === 'pre' && c.textContent.includes('"boom"')), 'raw JSON footer');
  assert.ok(groups[3].className.includes('ulog-possible') && !groups[0].className.includes('ulog-possible'));
});

test('Enter selects a row; the rail is empty until then', async () => {
  const els = await boot();
  assert.equal(els['ulog-rail-body'].children[0].textContent, 'ulog.related_empty');
  const row = selectErr(els);
  row.fire('keydown', { key: 'Enter', target: row });
  assert.ok(UnifiedLogPane._state().selectedKey);
});

test('Filter list to this sets q (or user for the time window)', async () => {
  const els = await boot();
  selectErr(els).fire('click');
  const btn = (kind) => els['ulog-rail-body'].children.find((c) => c.dataset.kind === kind).children.find((c) => c.attrs['data-rail-filter']);
  btn('request').fire('click');
  assert.equal(UnifiedLogPane._state().filter.q, 'r1');
  UnifiedLogPane.select(UnifiedLogPane._state().entries.find((e) => e.source === 'backend' && e.level === 'error').key);
  btn('user_window').fire('click');
  assert.equal(UnifiedLogPane._state().filter.user, 'alice');
});

test('selection survives a repaint by key', async () => {
  const els = await boot();
  selectErr(els).fire('click');
  const key = UnifiedLogPane._state().selectedKey;
  await UnifiedLogPane.render();
  assert.equal(UnifiedLogPane._state().selectedKey, key);
  assert.ok(els['ulog-rail-body'].children.some((c) => c.dataset.kind === 'request'));
});

test('a 404 on schedule events hides the source silently; a 500 shows a notice', async () => {
  routes.events = [404, {}];
  const els = await boot();
  assert.equal(UnifiedLogPane._state().eventsHidden, true);
  assert.deepEqual(UnifiedLogPane._state().notices, []);
  assert.equal(els['ulog-sources']._boxes.find((c) => c.dataset.src === 'events').parentElement.hidden, true);
  routes.events = [500, {}];
  await UnifiedLogPane.render();
  const n = UnifiedLogPane._state().notices;
  assert.equal(n.length, 1); assert.match(n[0], /^events: HTTP 500/);
  assert.equal(els['ulog-notices'].children.length, 1);
});

test('a failed source becomes a notice; the others still render', async () => {
  const f = globalThis.fetch;
  globalThis.fetch = (u) => (String(u).includes('/audit/log') ? resp(401, {}) : f(u));
  const els = await boot();
  assert.match(UnifiedLogPane._state().notices[0], /^audit: forbidden/);
  assert.ok(rowKeys(els).length >= 3);
});

test('a throwing localStorage does not break init or setFilter', () => {
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  installDom();
  assert.doesNotThrow(() => UnifiedLogPane.init());
  assert.doesNotThrow(() => UnifiedLogPane.setFilter({ level: 'error' }));
  assert.equal(UnifiedLogPane._state().filter.level, 'error');
});

test('the filter restores from localStorage on init', () => {
  store.set('nimbus.ulog.filter', JSON.stringify({ level: 'error', sources: ['jobs', 'bogus'], user: 'bob', plant: '', q: 'x' }));
  installDom(); UnifiedLogPane.init();
  const f = UnifiedLogPane._state().filter;
  assert.equal(f.level, 'error'); assert.deepEqual([...f.sources], ['jobs']); assert.equal(f.user, 'bob'); assert.equal(f.q, 'x');
});

test('setActive starts a poll and setActive(false) clears it', () => {
  installDom();
  UnifiedLogPane.setActive(true);
  assert.equal(UnifiedLogPane._state().polling, true);
  UnifiedLogPane.setActive(false);
  assert.equal(UnifiedLogPane._state().polling, false);
});

test('the list caps at 500 rows with a Show more button', async () => {
  ErrorLog.entries = () => Array.from({ length: 600 }, (_, i) => ({ ts: `2026-10-30T11:00:${String(i % 60).padStart(2, '0')}Z`, level: 'info', scope: 's', msg: `m${i}`, seq: i }));
  const els = await boot();
  assert.equal(rowKeys(els).length, 500);
  const more = els['ulog-list'].children.find((c) => c.className.includes('ulog-more'));
  assert.ok(more); more.fire('click');
  assert.ok(rowKeys(els).length > 500);
});

test('the request-id chip sets q to the rid', async () => {
  const els = await boot();
  const head = selectErr(els).children[0];
  const chip = head.children.find((c) => c.className === 'admin-log-reqid');
  assert.equal(chip.textContent, 'r1');
  chip.fire('click');
  assert.equal(UnifiedLogPane._state().filter.q, 'r1');
});

test('the four clear buttons still call their functions', () => {
  const els = installDom();
  const A = AdminCockpit; const priorInit = A._initialized;
  const hit = [];
  const real = { b: A._clearBackendLog, a: A._clearAuditLog, u: A._clearAudit, c: ErrorLog.clear };
  A._clearBackendLog = () => hit.push('backend'); A._clearAuditLog = () => hit.push('audit'); A._clearAudit = () => hit.push('upload');
  ErrorLog.clear = () => hit.push('frontend');
  A._initialized = false;
  try {
    A.init();
    for (const id of ['admin-backend-log-clear', 'admin-log-clear', 'admin-audit-log-clear', 'ulog-clear-upload']) els[id].fire('click');
  } finally { A._clearBackendLog = real.b; A._clearAuditLog = real.a; A._clearAudit = real.u; ErrorLog.clear = real.c; A._initialized = priorInit; }
  assert.deepEqual(hit.sort(), ['audit', 'backend', 'frontend', 'upload']);
});
