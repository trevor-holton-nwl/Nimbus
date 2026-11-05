// Pure signal model (frontend/admin-ops/signals.mts): severity ladder per subsystem, ordering,
// threshold override, attention list, and every emitted locale key exists in en.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildSignals, buildAttention, worstOf, SEVERITY_RANK, THRESHOLDS } from '../../../frontend/admin-ops/signals.mjs';

const en = (() => {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8'), { window });
  return window.__NIMBUS_LOCALES.en;
})();

const NOW = Date.parse('2026-10-30T12:00:00Z');
const table = (o = {}) => ({ table: 't', live_rows: 10, dead_pct: 1, last_vacuum: null, last_autovacuum: null, last_analyze: null, last_autoanalyze: null, needs_vacuum: false, ...o });
function base(o = {}) {
  return {
    now: NOW,
    health: { db: { connected: true, ping_ms: 20, total_orders: 100 }, pool: { pool_max: 10, pool_size: 2, pool_available: 1, requests_waiting: 0 }, memory: { loaded_at: '2026-10-30T11:00:00Z' } },
    dbDeep: { tables: [table({ table: 'a' })], connections: { total: 3, long_running: [] }, locks: [], slow_queries: { available: true, queries: [{ mean_ms: 5 }] } },
    dbDeepAt: NOW - 1000,
    backendErrors: { total: 0, entries: [] }, backendWarns: { total: 0, entries: [] },
    jobs: { summary: { failed24h: 0, missed24h: 0, warning24h: 0, longerThanUsual: [], nextFire: { atUtc: '2026-10-30T13:00:00Z' }, scheduler: { ok: true } }, lastFailed: [], recent: [{ id: 1, job_name: 'J', plant: '1008', status: 'succeeded', started_at: '2026-10-30T10:00:00Z', scheduled_for: null, duration_ms: 5, error: null }] },
    sap: { status: { ready: 0, sent: 5, error: 0, last_queued_at: null, last_sent_at: '2026-10-30T09:00:00Z' }, batches: [], lastRun: null, plant: '1008' },
    client: { stats: { source: 'backend', raw_received: 100, rendered: 100 }, inv: {}, errors: 0, warns: 0, errRate: 0, heapUsed: 50 * 1048576, heapLimit: 1000 * 1048576, build: 'b1', schema: 3, tasks: 100 },
    isAdmin: true,
    ...o,
  };
}
const sig = (s, id) => s.find(x => x.id === id);

test('all green: seven signals in stable id order, empty attention', () => {
  const s = buildSignals(base());
  assert.deepEqual(s.map(x => x.id), ['jobs', 'database', 'backend', 'data_load', 'connections', 'sap', 'browser']);
  assert.ok(s.every(x => x.severity === 'ok'));
  assert.deepEqual(buildAttention(s, base()), []);
});

test('worstOf / rank', () => {
  assert.equal(worstOf(), 'ok');
  assert.equal(worstOf('ok', 'warn', 'info'), 'warn');
  assert.equal(worstOf('warn', 'err'), 'err');
  assert.ok(SEVERITY_RANK.err > SEVERITY_RANK.warn && SEVERITY_RANK.warn > SEVERITY_RANK.info && SEVERITY_RANK.info > SEVERITY_RANK.ok);
});

test('jobs ladder', () => {
  const j = (patch, extra = {}) => { const b = base(); b.jobs = { ...b.jobs, summary: { ...b.jobs.summary, ...patch }, ...extra }; return sig(buildSignals(b), 'jobs'); };
  const failed = j({ failed24h: 2 }, { lastFailed: [{ id: 9, job_name: 'Opt', plant: '1008', status: 'failed', started_at: '2026-10-30T11:00:00Z', scheduled_for: null, duration_ms: 1, error: 'boom' }] });
  assert.equal(failed.severity, 'err'); assert.equal(failed.reasonKey, 'sig.jobs_failed');
  assert.equal(failed.reasonArgs.job, 'Opt'); assert.equal(failed.reasonArgs.ago, Date.parse('2026-10-30T11:00:00Z'));
  assert.deepEqual(failed.fixes.map(f => f.id), ['jobs.rerun', 'jobs.open_run']);
  assert.equal(failed.fixes[0].adminOnly, true);
  assert.equal(j({ scheduler: { ok: false } }).reasonKey, 'sig.jobs_scheduler_stale');
  assert.equal(j({ missed24h: 1 }).severity, 'warn');
  assert.equal(j({ warning24h: 1 }).reasonKey, 'sig.jobs_warning');
  assert.equal(j({ maintenance: { enabled: true } }).reasonKey, 'sig.jobs_maint');
  assert.equal(j({ longerThanUsual: [1] }).reasonKey, 'sig.jobs_slow');
  const none = j({ nextFire: null }, { recent: [] });
  assert.equal(none.severity, 'info'); assert.equal(none.reasonKey, 'sig.jobs_none');
  assert.equal(j({}).detail.rows.length, 1);
});

test('failed reads: err unavailable; forbidden / non-admin: info admin_only', () => {
  let s = buildSignals(base({ jobs: null, jobsErr: 'HTTP 500' }));
  assert.equal(sig(s, 'jobs').severity, 'err'); assert.equal(sig(s, 'jobs').reasonKey, 'sig.unavailable'); assert.equal(sig(s, 'jobs').reasonArgs.msg, 'HTTP 500');
  s = buildSignals(base({ jobs: null, jobsErr: 'forbidden' }));
  assert.equal(sig(s, 'jobs').severity, 'info'); assert.equal(sig(s, 'jobs').reasonKey, 'sig.admin_only');
  s = buildSignals(base({ health: null, healthErr: 'timeout' }));
  for (const id of ['database', 'data_load', 'connections']) { assert.equal(sig(s, id).severity, 'err'); assert.equal(sig(s, id).reasonKey, 'sig.unavailable'); }
  s = buildSignals(base({ backendErrors: null, backendWarns: null, backendErr: 'x' }));
  assert.equal(sig(s, 'backend').reasonKey, 'sig.unavailable');
  s = buildSignals(base({ isAdmin: false, jobs: null, backendErrors: null, backendWarns: null, sap: null, dbDeep: null }));
  for (const id of ['jobs', 'backend', 'sap', 'database']) assert.equal(sig(s, id).reasonKey, 'sig.admin_only', id);
  assert.equal(sig(s, 'connections').severity, 'ok');
  s = buildSignals(base({ dbDeep: null, dbDeepErr: 'boom' }));
  assert.equal(sig(s, 'database').reasonKey, 'sig.unavailable');
  assert.equal(sig(buildSignals(base({ sap: null, sapErr: 'oops' })), 'sap').reasonKey, 'sig.unavailable');
});

test('database ladder', () => {
  const db = (h, d = {}) => { const b = base(d); b.health = { ...b.health, db: { ...b.health.db, ...h } }; return sig(buildSignals(b), 'database'); };
  assert.equal(db({ connected: false }).reasonKey, 'sig.db_offline');
  assert.equal(db({ ping_ms: 2500 }).severity, 'err');
  const slow = db({ ping_ms: 600 }); assert.equal(slow.severity, 'warn'); assert.equal(slow.reasonKey, 'sig.db_slow');
  const vac = db({}, { dbDeep: { ...base().dbDeep, tables: [table({ table: 'x', dead_pct: 40, needs_vacuum: true, last_vacuum: '2026-10-01T00:00:00Z' }), table({ table: 'y', dead_pct: 25, needs_vacuum: true }), table({ table: 'z' })] } });
  assert.equal(vac.severity, 'warn'); assert.equal(vac.reasonKey, 'sig.db_vacuum');
  assert.equal(vac.reasonArgs.n, 2); assert.equal(vac.reasonArgs.table, 'x');
  assert.deepEqual(vac.fixes.map(f => f.id), ['db.vacuum_all']);
  assert.equal(vac.detail.rows[0][0], 'x'); assert.equal(vac.detail.rowFixes[0].id, 'db.vacuum_table'); assert.equal(vac.detail.rowFixes[2], null);
  const stale = db({}, { dbDeepAt: NOW - 700_000 });
  assert.equal(stale.severity, 'warn'); assert.equal(stale.measuredAt, NOW - 700_000);
  assert.equal(db({}).severity, 'ok');
  const many = db({}, { dbDeep: { ...base().dbDeep, tables: Array.from({ length: 12 }, (_, k) => table({ table: `t${k}`, dead_pct: k })) } });
  assert.equal(many.detail.rows.length, 8); assert.equal(many.detail.rows[0][0], 't11');
});

test('backend ladder', () => {
  const be = (e, w) => sig(buildSignals(base({ backendErrors: { total: e, entries: [{ ts: 't', level: 'error', category: 'c', msg: 'm' }] }, backendWarns: { total: w, entries: [] } })), 'backend');
  assert.equal(be(0, 0).reasonKey, 'sig.backend_ok');
  assert.equal(be(1, 0).severity, 'warn'); assert.equal(be(0, 20).severity, 'warn'); assert.equal(be(0, 19).severity, 'ok');
  const e = be(5, 2); assert.equal(e.severity, 'err'); assert.equal(e.reasonKey, 'sig.backend_counts'); assert.equal(e.fixes[0].id, 'logs.open');
  assert.equal(e.detail.linkSub, 'logs');
});

test('data load ladder', () => {
  const dl = patch => sig(buildSignals(base(patch)), 'data_load');
  const b = base();
  assert.equal(dl({ client: { ...b.client, stats: { source: 'backend', raw_received: 100, rendered: 90 } } }).reasonKey, 'sig.data_gap');
  assert.equal(dl({ client: { ...b.client, tasks: 0 } }).reasonKey, 'sig.data_none');
  // no colour-miss signal any more: a health read with a color_wheel block changes nothing
  assert.equal(dl({ health: { ...b.health, color_wheel: { misses: 3 } } }).reasonKey, 'sig.data_ok');
  // the detail rows are labelled: all plants vs the loaded plant's sent/loaded counts
  assert.deepEqual(dl({}).detail.rows.map(r => r[0]), ['pipe.in_db', 'pipe.sent', 'pipe.loaded']);
  assert.equal(dl({}).detail.rows[0][1], 100);
  assert.equal(dl({}).reasonKey, 'sig.data_ok');
  assert.equal(dl({}).reasonArgs.ago, Date.parse('2026-10-30T11:00:00Z'));
});

test('connections ladder', () => {
  const cn = (pool, deep = {}) => { const b = base(); b.health = { ...b.health, pool: { pool_max: 10, pool_size: 10, pool_available: 10, requests_waiting: 0, ...pool } }; b.dbDeep = { ...b.dbDeep, ...deep }; return sig(buildSignals(b), 'connections'); };
  assert.equal(cn({}).reasonKey, 'sig.conn_ok');
  assert.equal(cn({ pool_available: 4 }).severity, 'warn');          // 60 %
  assert.equal(cn({ pool_available: 1 }).severity, 'err');           // 90 %
  assert.equal(cn({ requests_waiting: 2 }).reasonKey, 'sig.conn_waiting');
  assert.equal(cn({}, { locks: [{ blocked_pid: 1 }] }).reasonKey, 'sig.conn_locks');
  assert.equal(cn({}, { locks: [{ error: 'x' }] }).severity, 'ok');
  assert.equal(cn({}, { connections: { total: 1, long_running: [{ duration_s: 45 }] } }).reasonKey, 'sig.conn_long');
  const s1 = cn({}, { slow_queries: { available: true, queries: [{ mean_ms: 150 }] } }); assert.equal(s1.severity, 'warn'); assert.equal(s1.reasonKey, 'sig.conn_slow');
  assert.equal(cn({}, { slow_queries: { available: true, queries: [{ mean_ms: 600 }] } }).severity, 'err');
});

test('sap ladder', () => {
  const sp = o => sig(buildSignals(base(o)), 'sap');
  const b = base();
  const noSend = { ...b.sap.status, last_sent_at: null };
  assert.equal(sp({}).reasonKey, 'sig.sap_ok');
  assert.equal(sp({ sap: null }).reasonKey, 'sig.sap_no_plant');
  assert.equal(sp({ sap: null, sapErr: 'not_found' }).reasonKey, 'sig.sap_not_live');
  assert.equal(sp({ sap: null, sapErr: 'forbidden' }).reasonKey, 'sig.admin_only');
  assert.equal(sp({ sap: { ...b.sap, status: { ...b.sap.status, error: 2 } } }).severity, 'err');
  const pend = sp({ sap: { ...b.sap, batches: [{ batch_id: 'a', status: 'held' }, { batch_id: 'b', status: 'applied' }] } });
  assert.equal(pend.severity, 'warn'); assert.equal(pend.reasonArgs.n, 1);
  assert.equal(sp({ sap: { ...b.sap, status: noSend } }).reasonKey, 'sig.sap_never');
  const run = { id: 1, object_key: 'o', started_at: '2026-10-30T08:00:00Z', ended_at: null, status: 'success', rows_read: 0, rows_failed: 0, error: null };
  assert.equal(sp({ sap: { ...b.sap, status: noSend, lastRun: run } }).reasonKey, 'sig.sap_last_pull');
});

test('browser ladder', () => {
  const br = patch => { const b = base(); b.client = { ...b.client, ...patch }; return sig(buildSignals(b), 'browser'); };
  assert.equal(br({}).reasonKey, 'sig.browser_ok');
  assert.equal(br({}).reasonArgs.heap, '50 MB');
  const blocked = br({ inv: { degraded: true, blocked: true } });
  assert.equal(blocked.severity, 'warn');
  assert.equal(blocked.reasonKey, 'sig.browser_backup_blocked');
  assert.deepEqual(blocked.fixes.map(f => f.id), ['client.save']);
  assert.equal(br({ errRate: 11, errors: 20 }).severity, 'err');
  const failing = br({ inv: { degraded: true } });
  assert.equal(failing.severity, 'warn');
  assert.equal(failing.reasonKey, 'sig.browser_backup_failed');
  assert.equal(br({ inv: { degraded: false, blocked: false } }).severity, 'ok');
  assert.equal(br({ heapUsed: 900, heapLimit: 1000 }).reasonKey, 'sig.browser_heap');
  const e = br({ errors: 2 }); assert.equal(e.severity, 'warn'); assert.equal(e.reasonKey, 'sig.browser_errors');
  assert.equal(br({ heapUsed: undefined }).reasonArgs.heap, '–');
});

test('ordering: worst first, stable on ties; threshold override', () => {
  const b = base();
  b.client = { ...b.client, inv: { degraded: true } };   // browser warn
  b.jobs = { ...b.jobs, summary: { ...b.jobs.summary, failed24h: 1 } };           // jobs err
  const s = buildSignals(b);
  assert.deepEqual(s.map(x => x.id).slice(0, 2), ['jobs', 'browser']);
  const b2 = base(); b2.health = { ...b2.health, db: { ...b2.health.db, ping_ms: 100 } };
  assert.equal(sig(buildSignals(b2), 'database').severity, 'ok');
  assert.equal(sig(buildSignals(b2, { dbPingWarnMs: 50 }), 'database').severity, 'warn');
  assert.equal(THRESHOLDS.dbPingWarnMs, 500);                                     // the override never mutates the defaults
});

function noisy() {
  const b = base();
  b.jobs = { summary: { failed24h: 1, missed24h: 0, warning24h: 0, longerThanUsual: [], nextFire: null, scheduler: { ok: false } }, lastFailed: [{ id: 4, job_name: 'Opt', plant: '1008', status: 'failed', started_at: '2026-10-30T11:00:00Z', scheduled_for: null, duration_ms: 1, error: 'e' }], recent: [] };
  b.backendErrors = { total: 6, entries: [] };
  b.dbDeep = { ...b.dbDeep, tables: [table({ needs_vacuum: true, dead_pct: 30 })], locks: [{ blocked_pid: 1 }] };
  b.client = { ...b.client, stats: { source: 'backend', raw_received: 10, rendered: 5 }, inv: { degraded: true } };
  b.sap = { ...b.sap, status: { ...b.sap.status, error: 3 }, batches: [{ batch_id: 'h', status: 'held' }] };
  b.uploadWarnings = { distribution: 2, batchId: 'bb' };
  return b;
}

test('attention: worst-first, capped at 8, one item per cause', () => {
  const b = noisy();
  const a = buildAttention(buildSignals(b), b);
  assert.equal(a.length, 8);
  assert.ok(a.every((x, k) => k === 0 || SEVERITY_RANK[a[k - 1].severity] >= SEVERITY_RANK[x.severity]));
  assert.equal(new Set(a.map(x => x.id)).size, a.length);
  assert.equal(a[0].id, 'job_failed');
  assert.equal(a[0].fix.id, 'jobs.open_run');
});

test('attention: lower-severity items appear when under the cap', () => {
  const b = base();
  b.sap = { ...b.sap, batches: [{ batch_id: 'h', status: 'held' }] };
  b.uploadWarnings = { distribution: 2, batchId: 'bb' };
  b.dbDeep = { ...b.dbDeep, tables: [table({ needs_vacuum: true })] };
  const a = buildAttention(buildSignals(b), b);
  assert.deepEqual(a.map(x => x.id), ['vacuum', 'sap_held', 'distribution']);
});

test('every emitted locale key exists in en.js', () => {
  const keys = new Set();
  const take = (s, i) => {
    for (const x of s) {
      keys.add(x.reasonKey);
      for (const f of x.fixes) keys.add(f.labelKey);
      if (x.detail) {
        x.detail.headKeys.forEach(k => keys.add(k));
        if (x.detail.linkKey) keys.add(x.detail.linkKey);
        x.detail.rowFixes?.forEach(f => f && keys.add(f.labelKey));
        if (x.id === 'data_load') x.detail.rows.forEach(r => keys.add(r[0]));
      }
    }
    for (const a of buildAttention(s, i)) { keys.add(a.textKey); keys.add(a.fix.labelKey); }
  };
  const fixtures = [base(), noisy()];
  const b = base();
  b.jobs = { ...b.jobs, summary: { ...b.jobs.summary, missed24h: 1, warning24h: 1, maintenance: { enabled: true }, longerThanUsual: [1], nextFire: null }, recent: [] };
  fixtures.push(b);
  const nj = base(); nj.jobs = { ...nj.jobs, summary: { ...nj.jobs.summary, nextFire: null }, recent: [] };
  fixtures.push(nj);
  fixtures.push(base({ isAdmin: false, jobs: null, sap: null, backendErrors: null, backendWarns: null, dbDeep: null }));
  fixtures.push(base({ health: null, healthErr: 'x', sap: null, sapErr: 'not_found' }));
  const c = base(); c.health = { ...c.health, db: { ...c.health.db, connected: false } }; fixtures.push(c);
  const d = base(); d.health = { ...d.health, db: { ...d.health.db, ping_ms: 900 }, pool: { pool_max: 10, pool_size: 10, pool_available: 3, requests_waiting: 1 } };
  d.dbDeep = { ...d.dbDeep, connections: { total: 1, long_running: [{ duration_s: 99 }] }, slow_queries: { available: true, queries: [{ mean_ms: 200 }] } };
  d.client = { ...d.client, stats: { source: 'demo', raw_received: 1, rendered: 1 }, tasks: 0, inv: { degraded: true }, errors: 3, heapUsed: 900, heapLimit: 1000 };
  d.backendWarns = { total: 30, entries: [] };
  d.sap = { ...d.sap, status: { ...d.sap.status, last_sent_at: null }, batches: [{ batch_id: 'x', status: 'ready' }] };
  fixtures.push(d);
  const lg = base(); lg.dbDeep = { ...lg.dbDeep, connections: { total: 1, long_running: [{ duration_s: 99 }] } }; fixtures.push(lg);
  const hp = base(); hp.client = { ...hp.client, heapUsed: 900, heapLimit: 1000 }; fixtures.push(hp);
  const ah = base(); ah.sap = { ...ah.sap, batches: [{ batch_id: 'h', status: 'held' }] }; ah.uploadWarnings = { distribution: 3, batchId: 'b' }; fixtures.push(ah);
  const ah1 = base(); ah1.uploadWarnings = { distribution: 1, batchId: 'b' }; fixtures.push(ah1);
  const e = base();
  e.sap = { ...e.sap, status: { ...e.sap.status, last_sent_at: null }, lastRun: { id: 1, object_key: 'o', started_at: '2026-10-30T08:00:00Z', ended_at: null, status: 's', rows_read: 0, rows_failed: 0, error: null } };
  e.client = { ...e.client, errRate: 99, errors: 99 };
  fixtures.push(e);
  for (const f of fixtures) take(buildSignals(f), f);
  for (const k of keys) assert.ok(typeof en[k] === 'string' && en[k], `en.js is missing ${k}`);
  for (const k of ['sig.jobs_ok', 'sig.jobs_none', 'sig.db_vacuum', 'sig.conn_long', 'sig.sap_last_pull', 'sig.browser_heap', 'attn.sap_held', 'attn.distribution', 'attn.distribution_one']) assert.ok(keys.has(k), `fixtures never emit ${k}`);
});

test('data_load never depends on the deep diagnostics read', () => {
  const a = sig(buildSignals(base()), 'data_load');
  const b = sig(buildSignals(base({ dbDeep: null, dbDeepErr: 'forbidden', isAdmin: false })), 'data_load');
  const c = sig(buildSignals(base({ dbDeep: null, dbDeepErr: 'boom' })), 'data_load');
  for (const s of [b, c]) { assert.equal(s.severity, a.severity); assert.equal(s.reasonKey, a.reasonKey); }
});

// ---- W3: deep-link anchors (spec 6.6 Anchor map): every nav.* fix and every detail link carries its target ----
const navFix = (s) => s.fixes.find((f) => f.id.startsWith('nav.'));
const withHealth = (h = {}, pool = {}) => { const b = base(); return { health: { ...b.health, ...h, pool: { ...b.health.pool, ...pool } } }; };
const withDeep = (d) => ({ dbDeep: { ...base().dbDeep, ...d } });
const withJobs = (sum, extra = {}) => { const b = base().jobs; return { jobs: { ...b, ...extra, summary: { ...b.summary, ...sum } } }; };
const withClient = (c) => ({ client: { ...base().client, ...c } });

test('anchors: Database and Connections emitters', () => {
  const at = (o, id) => sig(buildSignals(base(o)), id);
  assert.equal(navFix(at(withHealth({ db: { connected: false, ping_ms: 0 } }), 'database')).args.anchor, 'diag-db');
  assert.equal(navFix(at(withHealth({ db: { connected: true, ping_ms: 600 } }), 'database')).args.anchor, 'diag-db-server');
  const vac = at(withDeep({ tables: [table({ needs_vacuum: true, dead_pct: 40 })] }), 'database');
  assert.equal(vac.detail.linkAnchor, 'diag-db-tables');
  assert.equal(at({}, 'database').detail.linkAnchor, 'diag-db-tables');
  assert.equal(navFix(at(withDeep({ locks: [{ blocked_pid: 1 }] }), 'connections')).args.anchor, 'diag-db-locks');
  assert.equal(navFix(at(withHealth({}, { pool_size: 10, pool_available: 0 }), 'connections')).args.anchor, 'diag-db-pool');
  assert.equal(navFix(at(withHealth({}, { requests_waiting: 2 }), 'connections')).args.anchor, 'diag-db-pool');
  assert.equal(navFix(at(withDeep({ connections: { total: 3, long_running: [{ duration_s: 99 }] } }), 'connections')).args.anchor, 'diag-db-conn');
  assert.equal(navFix(at(withDeep({ slow_queries: { available: true, queries: [{ mean_ms: 600 }] } }), 'connections')).args.anchor, 'diag-db-slow');
  assert.equal(at({}, 'connections').detail.linkAnchor, 'diag-db-conn');
  assert.equal(at({}, 'browser').detail.linkAnchor, 'diag-client');
});

test('anchors: Data load carries a secondary nav.diagnostics fix to diag-pipe, plus a detail link', () => {
  const at = (o) => sig(buildSignals(base(o)), 'data_load');
  const cases = [
    withClient({ stats: { source: 'backend', raw_received: 100, rendered: 90 } }),
    withClient({ tasks: 0 }),
  ];
  for (const c of cases) {
    const s = at(c);
    const nav = navFix(s);
    assert.ok(nav, s.reasonKey);
    assert.equal(nav.labelKey, 'btn.open_diagnostics');
    assert.equal(nav.args.anchor, 'diag-pipe');
    assert.notEqual(s.fixes[0].id, 'nav.diagnostics', 'the primary fix stays first');
  }
  assert.equal(at({}).detail.linkAnchor, 'diag-pipe');
});

test('anchors: SAP, Distribution and Jobs emitters', () => {
  const at = (o, id) => sig(buildSignals(base(o)), id);
  const sap = base().sap;
  assert.equal(navFix(at({ sap: { ...sap, status: { ...sap.status, error: 2 } } }, 'sap')).args.anchor, 'sap:staging');
  assert.equal(navFix(at({ sap: { ...sap, batches: [{ status: 'ready' }] } }, 'sap')).args.anchor, 'sap:staging');
  assert.equal(at({}, 'sap').detail.linkAnchor, 'sap:staging');
  const runs = [{ missed24h: 1 }, { warning24h: 1 }, { longerThanUsual: [{}] }, { failed24h: 1 }];
  for (const r of runs) assert.equal(navFix(at(withJobs(r), 'jobs')).args.anchor, 'jobs:runs', JSON.stringify(r));
  assert.equal(navFix(at(withJobs({ scheduler: { ok: false } }), 'jobs')).args.anchor, 'jobs:jobs');
  assert.equal(navFix(at(withJobs({ maintenance: { enabled: true } }), 'jobs')).args.anchor, 'jobs:jobs');
  assert.equal(at({}, 'jobs').detail.linkAnchor, 'jobs:runs');
});

test('anchors: attention items', () => {
  const att = (o) => { const i = base(o); return buildAttention(buildSignals(i), i); };
  const one = (list, id) => list.find((x) => x.id === id);
  assert.equal(one(att(withDeep({ locks: [{ blocked_pid: 1 }] })), 'locks').fix.args.anchor, 'diag-db-locks');
  const sap = base().sap;
  const a = att({ sap: { ...sap, status: { ...sap.status, error: 1 }, batches: [{ status: 'held' }] } });
  assert.equal(one(a, 'sap_errors').fix.args.anchor, 'sap:staging');
  assert.equal(one(a, 'sap_held').fix.args.anchor, 'sap:staging');
  assert.equal(one(att({ uploadWarnings: { distribution: 2, batchId: 'b1' } }), 'distribution').fix.args.anchor, 'admin-audit');
  assert.equal(one(att(withJobs({ failed24h: 1 })), 'job_failed').fix.args.anchor, 'jobs:runs');
  assert.equal(one(att(withJobs({ scheduler: { ok: false } })), 'scheduler_stale').fix.args.anchor, 'jobs:jobs');
  // a failed run with a known id keeps jobs.open_run (no anchor needed)
  const lf = { id: 9, job_name: 'J', plant: '1008', status: 'failed', started_at: '2026-10-30T10:00:00Z', scheduled_for: null, duration_ms: 1, error: 'x' };
  assert.equal(one(att(withJobs({ failed24h: 1 }, { lastFailed: [lf] })), 'job_failed').fix.id, 'jobs.open_run');
});

test('anchors: every nav.* fix and every linkSub in a worst-case input carries an anchor; logs.open carries level and source', () => {
  const sap = base().sap;
  const i = base({
    ...withHealth({ db: { connected: true, ping_ms: 3000 } }, { pool_size: 10, pool_available: 0, requests_waiting: 4 }),
    ...withDeep({ locks: [{ blocked_pid: 1 }], tables: [table({ needs_vacuum: true })], connections: { total: 9, long_running: [{ duration_s: 99 }] }, slow_queries: { available: true, queries: [{ mean_ms: 900 }] } }),
    ...withJobs({ failed24h: 2, missed24h: 1, warning24h: 1, longerThanUsual: [{}], scheduler: { ok: false }, maintenance: { enabled: true } }),
    ...withClient({ tasks: 0, stats: { source: 'backend', raw_received: 100, rendered: 80 } }),
    sap: { ...sap, status: { ...sap.status, error: 3 }, batches: [{ status: 'held' }] },
    backendErrors: { total: 12, entries: [] }, backendWarns: { total: 40, entries: [] },
    uploadWarnings: { distribution: 1, batchId: 'b' },
  });
  const sigs = buildSignals(i);
  const fixes = [...sigs.flatMap((s) => s.fixes), ...buildAttention(sigs, i).map((a) => a.fix)];
  const navs = fixes.filter((f) => f.id.startsWith('nav.'));
  assert.ok(navs.length >= 8);
  for (const f of navs) assert.equal(typeof f.args?.anchor, 'string', f.id);
  for (const s of sigs) if (s.detail?.linkSub && s.id !== 'backend') assert.equal(typeof s.detail.linkAnchor, 'string', s.id);
  const logs = fixes.filter((f) => f.id === 'logs.open');
  assert.ok(logs.length >= 2);
  for (const f of logs) { assert.ok(['error', 'warn'].includes(f.args.level)); assert.equal(f.args.source, 'backend'); }
});

test('T6/T7: a failing or blocked backup is a warning whose fix is Save (client.save), not Reset client state, in the signal and the attention list', () => {
  const b = base();
  b.client = { ...b.client, inv: { degraded: true } };
  const sigs = buildSignals(b);
  const browser = sig(sigs, 'browser');
  assert.equal(browser.severity, 'warn');
  assert.equal(browser.reasonKey, 'sig.browser_backup_failed');
  assert.deepEqual(browser.fixes.map(f => [f.id, f.labelKey]), [['client.save', 'btn.save']]);
  const attn = buildAttention(sigs, b).find(a => a.id === 'autosave');
  assert.deepEqual([attn.fix.id, attn.fix.labelKey], ['client.save', 'btn.save']);
  assert.equal(attn.severity, 'warn');
  // a healthy backup raises nothing
  const ok = base();
  assert.equal(buildAttention(buildSignals(ok), ok).find(a => a.id === 'autosave'), undefined);
});
