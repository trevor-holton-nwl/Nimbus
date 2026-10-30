// Pure Diagnostics page model (frontend/admin-ops/diag-sections.mts): 13 sections in page order, severity
// ladders at their boundaries, unavailable / 403 inputs, defaultOpen, and the locale contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildDiagSections, defaultOpen, ANCHOR_IDS } from '../../../frontend/admin-ops/diag-sections.mjs';
import { THRESHOLDS } from '../../../frontend/admin-ops/signals.mjs';

const root = new URL('../../../frontend/', import.meta.url);
const LOCALES = ['en', 'de', 'es', 'fr', 'pt'];
const T = Object.fromEntries(LOCALES.map(l => {
  const window = {};
  vm.runInNewContext(readFileSync(new URL(`locales/${l}.js`, root), 'utf8'), { window });
  return [l, window.__NIMBUS_LOCALES[l]];
}));
const ph = s => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');

const NOW = Date.parse('2026-10-30T12:00:00Z');
const MIN = 60_000;
const ORDER = ['client', 'pipe', 'bwarn', 'db', 'db-pool', 'db-server', 'db-tables', 'db-conn', 'db-locks', 'db-idx', 'db-slow', 'db-seq', 'thread'];

function base(o = {}) {
  return {
    now: NOW,
    client: { build: 'b1', autosave: 'on', errRate: 0, heapUsed: 50, heapLimit: 1000 },
    deep: { loaded: 100, plant: 80, received: 80, rendered: 80, misses: 0, warnings: 0 },
    dbDeep: {
      pool: { pool_size: 3, pool_available: 2, pool_max: 10, requests_waiting: 0 },
      server: { version: 'PostgreSQL 16.2 (Debian)', started_at: '2026-10-29T12:00:00Z' },
      tables: [{ needs_vacuum: false }, { needs_vacuum: false }],
      connections: { total: 3, long_running: [] },
      locks: [],
      indexes: [{ unused: false }],
      slow_queries: { available: true, queries: [{ mean_ms: 5 }] },
      sequences: [{ used_pct: 10 }],
    },
    perf: [{ name: 'render', last: 3, p50: 2, p95: 4, max: 9 }],
    dbStatsAt: NOW - MIN,
    pingMs: 20,
    ...o,
  };
}
const withDb = patch => base({ dbDeep: { ...base().dbDeep, ...patch } });
const sec = (inputs, id) => buildDiagSections(inputs).find(s => s.id === id);
const sev = (inputs, id) => sec(inputs, id).severity;

test('always 13 sections in page order; anchors are diag-<id>', () => {
  assert.deepEqual(buildDiagSections(base()).map(s => s.id), ORDER);
  assert.deepEqual(buildDiagSections({ ...base(), client: null, deep: null, dbDeep: null, perf: [], dbStatsAt: null }).map(s => s.id), ORDER);
  assert.equal(ANCHOR_IDS['db-conn'], 'diag-db-conn');
  assert.equal(ANCHOR_IDS.client, 'diag-client');
  assert.ok(ORDER.every(id => ANCHOR_IDS[id] === `diag-${id}`));
});

test('a healthy base is ok everywhere', () => {
  for (const x of buildDiagSections(base())) assert.equal(x.severity, 'ok', x.id);
});

test('pool ladder 59 / 60 / 85 percent and waiting', () => {
  const pool = (used, waiting = 0) => withDb({ pool: { pool_size: used, pool_available: 0, pool_max: 100, requests_waiting: waiting } });
  assert.equal(sev(pool(59), 'db-pool'), 'ok');
  assert.equal(sev(pool(60), 'db-pool'), 'warn');
  assert.equal(sev(pool(84), 'db-pool'), 'warn');
  assert.equal(sev(pool(85), 'db-pool'), 'err');
  assert.equal(sev(pool(10, 1), 'db-pool'), 'warn');
  assert.equal(sev(pool(60), 'db'), 'warn');
  assert.equal(sec(pool(42), 'db-pool').shortArgs.pct, 42);
});

test('long-running query ladder at 30 s, counted on the Database line', () => {
  const conn = s => withDb({ connections: { total: 4, long_running: [{ duration_s: s }] } });
  assert.equal(sev(conn(29), 'db-conn'), 'ok');
  assert.equal(sev(conn(30), 'db-conn'), 'warn');
  assert.equal(sec(conn(45), 'db').lineArgs.slow, 1);
  assert.equal(sec(conn(45), 'db-conn').lineArgs.longest, 45);
});

test('slow query ladder 99 / 100 / 500 ms; unavailable is info', () => {
  const slow = ms => withDb({ slow_queries: { available: true, queries: [{ mean_ms: ms }, { mean_ms: 1 }] } });
  assert.equal(sev(slow(99), 'db-slow'), 'ok');
  assert.equal(sev(slow(100), 'db-slow'), 'warn');
  assert.equal(sev(slow(499), 'db-slow'), 'warn');
  assert.equal(sev(slow(500), 'db-slow'), 'err');
  assert.equal(sec(slow(250), 'db-slow').lineArgs.n, 1);
  const none = sec(withDb({ slow_queries: { available: true, queries: [] } }), 'db-slow');
  assert.equal(none.severity, 'ok');
  assert.equal(none.lineKey, 'diag.line_slow_ok');
  const na = sec(withDb({ slow_queries: { available: false, queries: [] } }), 'db-slow');
  assert.equal(na.severity, 'info');
  assert.equal(na.lineKey, 'diag.line_unavailable');
});

test('browser: heap 79 / 80 percent and errors per minute 0 / 1 / 10', () => {
  const heap = pct => base({ client: { build: 'b', autosave: 'on', errRate: 0, heapUsed: pct, heapLimit: 100 } });
  assert.equal(sev(heap(79), 'client'), 'ok');
  assert.equal(sev(heap(80), 'client'), 'warn');
  const errs = n => base({ client: { build: 'b', autosave: 'on', errRate: n } });
  assert.equal(sev(errs(0), 'client'), 'ok');
  assert.equal(sev(errs(1), 'client'), 'warn');
  assert.equal(sev(errs(9), 'client'), 'warn');
  assert.equal(sev(errs(10), 'client'), 'err');
  assert.equal(sev(base({ client: { build: 'b', autosave: 'off', autosaveDisabled: true, errRate: 0 } }), 'client'), 'err');
  assert.equal(sec(heap(55), 'client').shortArgs.heap, 55);
});

test('tables: any needs_vacuum warns; locks: any wait is an error; indexes: unused is info', () => {
  assert.equal(sev(withDb({ tables: [{ needs_vacuum: false }, { needs_vacuum: true }] }), 'db-tables'), 'warn');
  assert.equal(sec(withDb({ tables: [{ needs_vacuum: true }, { needs_vacuum: true }, { needs_vacuum: false }] }), 'db').lineArgs.vacuum, 2);
  const locks = withDb({ locks: [{ blocked_pid: 1 }] });
  assert.equal(sev(locks, 'db-locks'), 'err');
  assert.equal(sec(locks, 'db-locks').lineKey, 'diag.line_locks_n');
  assert.equal(sec(base(), 'db-locks').lineKey, 'diag.line_locks_ok');
  assert.equal(sev(withDb({ indexes: [{ unused: true }, { unused: true }] }), 'db-idx'), 'info');
  assert.notEqual(sev(withDb({ indexes: [{ unused: true }] }), 'db'), 'warn');
});

test('sequences ladder 80 / 81 / 95 / 96 percent', () => {
  const seq = p => withDb({ sequences: [{ used_pct: p }, { used_pct: 1 }] });
  assert.equal(sev(seq(80), 'db-seq'), 'ok');
  assert.equal(sev(seq(81), 'db-seq'), 'warn');
  assert.equal(sev(seq(95), 'db-seq'), 'warn');
  assert.equal(sev(seq(96), 'db-seq'), 'err');
});

test('thread P95 15 / 16 / 50 ms; empty is info', () => {
  const perf = p => base({ perf: [{ name: 'a', last: 1, p50: 1, p95: 1, max: 2 }, { name: 'b', last: 1, p50: 1, p95: p, max: p + 1 }] });
  assert.equal(sev(perf(15), 'thread'), 'ok');
  assert.equal(sev(perf(16), 'thread'), 'warn');
  assert.equal(sev(perf(49), 'thread'), 'warn');
  assert.equal(sev(perf(50), 'thread'), 'err');
  assert.equal(sec(perf(20), 'thread').lineArgs.op, 'b');
  assert.equal(sev(base({ perf: [] }), 'thread'), 'info');
  assert.equal(sec(base({ perf: [] }), 'thread').lineKey, 'diag.line_thread_empty');
});

test('stats age 9 / 10 minutes: warn on the Database line only', () => {
  assert.equal(sev(base({ dbStatsAt: NOW - 9 * MIN }), 'db'), 'ok');
  assert.equal(sev(base({ dbStatsAt: NOW - 10 * MIN }), 'db'), 'warn');
  assert.equal(sev(base({ dbStatsAt: NOW - 10 * MIN }), 'db-pool'), 'ok');
  assert.equal(sec(base({ dbStatsAt: NOW - 10 * MIN }), 'db').lineArgs.age, 10 * MIN);
});

test('pipeline: a gap is an error, color misses warn; backend warnings warn with a count', () => {
  assert.equal(sev(base({ deep: { loaded: 9, plant: 9, received: 9, rendered: 8, misses: 0, warnings: 0 } }), 'pipe'), 'err');
  const miss = sec(base({ deep: { loaded: 9, plant: 9, received: 9, rendered: 9, misses: 3, warnings: 2 } }), 'pipe');
  assert.equal(miss.severity, 'warn');
  assert.equal(miss.shortArgs.misses, 3);
  const bw = sec(base({ deep: { loaded: 9, plant: 9, received: 9, rendered: 9, misses: 0, warnings: 2 } }), 'bwarn');
  assert.equal(bw.severity, 'warn');
  assert.equal(bw.count, 2);
});

test('null inputs are info, never ok; a 403 marker reads admin-only', () => {
  const none = buildDiagSections({ ...base(), client: null, deep: null, dbDeep: null });
  for (const id of ORDER.filter(x => x !== 'thread')) {
    const s = none.find(x => x.id === id);
    assert.equal(s.severity, 'info', id);
    assert.equal(s.lineKey, 'diag.line_unavailable', id);
    assert.equal(defaultOpen(s, null), false, id);
  }
  const forbidden = buildDiagSections(base({ dbDeep: { forbidden: true } })).filter(s => s.id.startsWith('db'));
  assert.equal(forbidden.length, 9);
  for (const s of forbidden) { assert.equal(s.severity, 'info', s.id); assert.equal(s.lineKey, 'sig.admin_only', s.id); }
  assert.equal(sec(base({ deep: { forbidden: true } }), 'pipe').lineKey, 'sig.admin_only');
});

test('a list error sentinel is an error, not ok', () => {
  assert.equal(sev(withDb({ tables: [{ error: 'boom' }] }), 'db-tables'), 'err');
  assert.equal(sev(withDb({ tables: [{ error: 'boom' }] }), 'db'), 'err');
  assert.equal(sev(withDb({ pool: { error: 'x' } }), 'db-pool'), 'err');
});

test('server: ping ladder, version and uptime', () => {
  assert.equal(sev(base({ pingMs: 400 }), 'db-server'), 'ok');
  assert.equal(sev(base({ pingMs: 600 }), 'db-server'), 'warn');
  assert.equal(sev(base({ pingMs: 2500 }), 'db-server'), 'err');
  const s = sec(base(), 'db-server');
  assert.equal(s.lineArgs.version, 'PostgreSQL 16.2');
  assert.equal(s.lineArgs.uptime, 24 * 60 * MIN);
});

test('thresholds can be overridden', () => {
  const s = buildDiagSections(base({ client: { build: 'b', autosave: 'on', errRate: 0, heapUsed: 50, heapLimit: 100 } }), { ...THRESHOLDS, heapWarnPct: 50 });
  assert.equal(s.find(x => x.id === 'client').severity, 'warn');
});

test('defaultOpen: warn/err open, ok closed, the pending anchor opens its section and the Database parent', () => {
  const mk = (id, severity) => ({ id, severity, titleKey: 't', lineKey: 'l', lineArgs: {}, shortKey: 's', shortArgs: {} });
  assert.equal(defaultOpen(mk('client', 'warn'), null), true);
  assert.equal(defaultOpen(mk('client', 'err'), null), true);
  assert.equal(defaultOpen(mk('client', 'ok'), null), false);
  assert.equal(defaultOpen(mk('client', 'info'), null), false);
  assert.equal(defaultOpen(mk('pipe', 'ok'), 'diag-pipe'), true);
  assert.equal(defaultOpen(mk('client', 'ok'), 'diag-pipe'), false);
  assert.equal(defaultOpen(mk('db-conn', 'ok'), 'diag-db-conn'), true);
  assert.equal(defaultOpen(mk('db', 'ok'), 'diag-db-conn'), true);
  assert.equal(defaultOpen(mk('db', 'ok'), 'diag-db'), true);
  assert.equal(defaultOpen(mk('db', 'ok'), 'diag-pipe'), false);
  assert.equal(defaultOpen(mk('db-pool', 'ok'), 'diag-db-conn'), false);
});

/* ---- locale contract ---- */
const T2_KEYS = ['diag.rail_sections', 'diag.stats_age', 'diag.line_client', 'diag.line_pipe', 'diag.line_bwarn', 'diag.line_db', 'diag.line_pool', 'diag.line_server',
  'diag.line_tables', 'diag.line_conn', 'diag.line_locks_ok', 'diag.line_locks_n', 'diag.line_idx', 'diag.line_slow', 'diag.line_slow_ok', 'diag.line_seq', 'diag.line_thread',
  'diag.line_thread_empty', 'diag.line_unavailable', 'diag.short_client', 'diag.short_pipe', 'diag.short_bwarn', 'diag.short_db', 'diag.short_pool', 'diag.short_server',
  'diag.short_tables', 'diag.short_conn', 'diag.short_locks', 'diag.short_idx', 'diag.short_slow', 'diag.short_seq', 'diag.short_thread', 'diag.see_bwarn', 'diag.lock_blocking',
  'diag.lock_blocked', 'diag.calls', 'btn.analyze', 'btn.export_bundle', 'aria.help', 'ui.none'];

// A spread of inputs that makes every line and short key appear.
function emittedAll() {
  const out = [];
  const variants = [
    base(), base({ client: null, deep: null, dbDeep: null, perf: [] }), base({ dbDeep: { forbidden: true } }),
    withDb({ locks: [{ blocked_pid: 1 }], slow_queries: { available: true, queries: [] } }), base({ perf: [] }),
  ];
  for (const v of variants) out.push(...buildDiagSections(v));
  return out;
}

test('every emitted key exists in all five locales with the same placeholders as the args that fill it', () => {
  const all = emittedAll();
  const keys = new Set(all.flatMap(s => [s.titleKey, s.lineKey, s.shortKey]));
  for (const k of keys) for (const l of LOCALES) assert.ok(T[l][k], `${l}.js missing ${k}`);
  for (const s of all) {
    for (const l of LOCALES) {
      if (s.lineKey.startsWith('diag.') || s.lineKey.startsWith('sig.')) {
        assert.equal(ph(T[l][s.lineKey]), Object.keys(s.lineArgs).sort().join(','), `${l} ${s.lineKey} args for ${s.id}`);
      }
      assert.equal(ph(T[l][s.shortKey]), Object.keys(s.shortArgs).sort().join(','), `${l} ${s.shortKey} args for ${s.id}`);
    }
  }
});

test('every T2 key is present, non-empty and placeholder-identical in all five locales', () => {
  for (const k of T2_KEYS) {
    assert.ok(T.en[k], `en.js missing ${k}`);
    for (const l of LOCALES.slice(1)) {
      assert.ok(T[l][k], `${l}.js missing ${k}`);
      assert.equal(ph(T[l][k]), ph(T.en[k]), `${l} ${k} placeholders`);
    }
  }
});

test('rail strings stay within 24 characters in all five locales', () => {
  // The figures (diag.short_*) and the rail caption must fit the 220 px rail without wrapping. The section
  // titles are existing keys and truncate with an ellipsis plus a title attribute (T3/T5), so they are not capped here.
  const shorts = Object.keys(T.en).filter(k => k.startsWith('diag.short_'));
  assert.ok(shorts.length >= 13);
  const fill = s => String(s).replace(/\{\{\w+\}\}/g, '000');   // a typical figure width
  for (const l of LOCALES) {
    for (const k of [...shorts, 'diag.rail_sections']) assert.ok(fill(T[l][k]).length <= 24, `${l} ${k}: ${T[l][k]}`);
  }
});
