// Pure unified-log model (frontend/admin-ops/unified-log.mts): adapters, merge, filter semantics
// (incl. the plant-plus-global rule), source counts and the related rail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as U from '../../../frontend/admin-ops/unified-log.mjs';

const en = (() => {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8'), { window });
  return window.__NIMBUS_LOCALES.en;
})();

const F = (o = {}) => ({ level: 'all', sources: new Set(), user: '', plant: '', q: '', ...o });
let _n = 0;
const E = (o = {}) => ({ key: `k${_n++}`, ts: '2026-10-30T10:00:00Z', tsMs: Date.parse('2026-10-30T10:00:00Z'), source: 'backend', level: 'info', user: null, plant: null, text: 't', raw: null, ...o });

test('fromBackend', () => {
  const e = U.fromBackend({ ts: '2026-10-30T10:00:00Z', level: 'error', category: 'db', msg: 'boom', rid: 'r1', error_code: 'E1', ctx: { plant: '1008', actor: 'ann', run_id: 7, order_id: 'O1' } });
  assert.equal(e.source, 'backend'); assert.equal(e.level, 'error'); assert.equal(e.text, '[db] boom');
  assert.equal(e.plant, '1008'); assert.equal(e.user, 'ann'); assert.equal(e.rid, 'r1'); assert.equal(e.errorCode, 'E1');
  assert.equal(e.runId, '7'); assert.equal(e.orderId, 'O1'); assert.equal(e.tsMs, Date.parse('2026-10-30T10:00:00Z'));
  const g = U.fromBackend({ ts: 'x', level: 'info', category: 'c', msg: 'm', user: 'u', actor: 'a' });
  assert.equal(g.plant, null); assert.equal(g.user, 'u'); assert.equal(g.tsMs, null);
});

test('fromFrontend', () => {
  const e = U.fromFrontend({ ts: '2026-10-30T10:00:00Z', level: 'warn', scope: 'http', msg: 'slow', reqId: 'r9', plant: '1021', user: 'bo', errorCode: 'X' });
  assert.equal(e.text, '[http] slow'); assert.equal(e.rid, 'r9'); assert.equal(e.plant, '1021'); assert.equal(e.user, 'bo');
  assert.equal(U.fromFrontend({ ts: 't', level: 'info', scope: 's', msg: 'm' }).plant, null);
});

test('fromAudit / fromUpload', () => {
  const a = U.fromAudit({ ts: '2026-10-30T10:00:00Z', user: 'cy', action: 'optimize', plant: '1008', rid: 'r2', details: { n: 1 } });
  assert.equal(a.level, 'info'); assert.equal(a.rid, 'r2'); assert.equal(a.plant, '1008'); assert.match(a.text, /optimize/);
  assert.equal(U.fromAudit({ ts: 't', action: 'x' }).plant, null);
  const base = { batch_id: 'b1', filename: 'f.xlsx', row_count: 5, inserted: 3, updated: 2, uploaded_at: '2026-10-30T10:00:00Z' };
  assert.equal(U.fromUpload({ ...base, warnings: [{ category: 'upload_counts' }] }).level, 'info');
  assert.equal(U.fromUpload({ ...base, warnings: [{ category: 'upload_counts' }, { category: 'x', msg: 'm' }], rid: 'r3' }).level, 'warn');
  assert.equal(U.fromUpload({ ...base, warnings: [], rid: 'r3' }).rid, 'r3');
});

test('fromJobRun levels, ts, user, runId', () => {
  const run = s => ({ id: 5, job_name: 'J', plant: '1008', status: s, started_at: null, scheduled_for: '2026-10-30T09:00:00Z', triggered_by: 'schedule', error: s === 'failed' ? 'x' : null, summary: null });
  assert.equal(U.fromJobRun(run('failed')).level, 'error');
  for (const s of ['warning', 'skipped', 'missed']) assert.equal(U.fromJobRun(run(s)).level, 'warn');
  const ok = U.fromJobRun(run('succeeded'));
  assert.equal(ok.level, 'info'); assert.equal(ok.runId, '5'); assert.equal(ok.user, 'schedule'); assert.equal(ok.ts, '2026-10-30T09:00:00Z'); assert.equal(ok.plant, '1008');
});

test('fromScheduleEvent / fromSapRun', () => {
  const ev = U.fromScheduleEvent({ id: 3, at: '2026-10-30T10:00:00Z', actor: 'a@x', actor_name: 'Ann', source: 'planner', op: 'update', action_id: 'act1', client_id: null, order_id: 'O9', production_order: '1000', material_number: null, fields: ['finish'] }, '1008');
  assert.equal(ev.source, 'events'); assert.equal(ev.plant, '1008'); assert.equal(ev.user, 'Ann'); assert.equal(ev.actionId, 'act1'); assert.equal(ev.orderId, 'O9'); assert.match(ev.text, /finish/);
  const run = o => ({ id: 1, object_key: 'orders', started_at: '2026-10-30T10:00:00Z', ended_at: null, status: 'success', rows_read: 5, rows_inserted: 1, rows_updated: 1, rows_failed: 0, error: null, triggered_by: 'sys', ...o });
  const ok = U.fromSapRun(run());
  assert.equal(ok.source, 'sap'); assert.equal(ok.level, 'info'); assert.equal(ok.plant, null); assert.equal(ok.user, 'sys');
  assert.equal(U.fromSapRun(run({ status: 'failed', error: 'x' })).level, 'error');
  assert.equal(U.fromSapRun(run({ rows_failed: 2 })).level, 'warn');
  assert.equal(U.fromSapRun(run({ plant: '1008' })).plant, '1008');
});

test('mergeEntries: newest first, missing ts last, stable tiebreak, limit', () => {
  const a = E({ key: 'a', tsMs: 100 }), b = E({ key: 'b', tsMs: 300 }), c = E({ key: 'c', tsMs: null, ts: null });
  const d = E({ key: 'd', tsMs: 100, source: 'audit' });
  const m = U.mergeEntries([[a, c], [b, d]]);
  assert.deepEqual(m.map(x => x.key), ['b', 'd', 'a', 'c']);       // tie at 100: audit before backend
  assert.equal(U.mergeEntries([[a, b, c, d]], 2).length, 2);
});

test('filter: level ladder', () => {
  const l = [E({ level: 'info' }), E({ level: 'warn' }), E({ level: 'error' })];
  assert.equal(U.filterEntries(l, F()).length, 3);
  assert.equal(U.filterEntries(l, F({ level: 'warn' })).length, 2);
  assert.equal(U.filterEntries(l, F({ level: 'error' })).length, 1);
});

test('filter: sources empty = all, multi-select union', () => {
  const l = [E({ source: 'backend' }), E({ source: 'jobs' }), E({ source: 'sap' })];
  assert.equal(U.filterEntries(l, F()).length, 3);
  assert.equal(U.filterEntries(l, F({ sources: new Set(['jobs', 'sap']) })).length, 2);
});

test('filter: plant plus global', () => {
  const l = [E({ key: 'a', plant: '1008' }), E({ key: 'g', plant: null }), E({ key: 'o', plant: '1021' }), E({ key: 'ja', plant: '1008', source: 'jobs' }), E({ key: 'bg', plant: null, source: 'frontend' })];
  assert.equal(U.filterEntries(l, F({ plant: '' })).length, 5);
  assert.deepEqual(U.filterEntries(l, F({ plant: '1008' })).map(x => x.key), ['a', 'g', 'ja', 'bg']);
  const pure = U.filterEntries(l, F({ plant: '1008', sources: new Set(['jobs', 'audit', 'upload', 'events', 'sap']) }));
  assert.deepEqual(pure.map(x => x.key), ['ja']);
});

test('filter: user exact case-insensitive; q over text/user/rid/errorCode', () => {
  const l = [E({ key: 'a', user: 'Ann' }), E({ key: 'b', user: 'Annie' }), E({ key: 'c', text: 'Needle here' }), E({ key: 'd', rid: 'RID-1' }), E({ key: 'e', errorCode: 'ERR_X' })];
  assert.deepEqual(U.filterEntries(l, F({ user: 'ann' })).map(x => x.key), ['a']);
  assert.deepEqual(U.filterEntries(l, F({ q: 'needle' })).map(x => x.key), ['c']);
  assert.deepEqual(U.filterEntries(l, F({ q: 'rid-1' })).map(x => x.key), ['d']);
  assert.deepEqual(U.filterEntries(l, F({ q: 'err_x' })).map(x => x.key), ['e']);
  assert.deepEqual(U.filterEntries(l, F({ q: 'annie' })).map(x => x.key), ['b']);
});

test('sourceCounts ignores the source filter, honours the others', () => {
  const l = [E({ source: 'backend', level: 'error' }), E({ source: 'backend', level: 'info' }), E({ source: 'jobs', level: 'error', plant: '1021' }), E({ source: 'sap', level: 'error' })];
  const all = U.sourceCounts(l, F({ sources: new Set(['jobs']) }));
  assert.equal(all.backend, 2); assert.equal(all.jobs, 1); assert.equal(all.sap, 1); assert.equal(all.events, 0);
  const err = U.sourceCounts(l, F({ level: 'error', plant: '1008' }));
  assert.equal(err.backend, 1); assert.equal(err.jobs, 0); assert.equal(err.sap, 1);
});

test('relatedTo: group order, membership, possible flag, excludes self, empty', () => {
  const sel = E({ key: 'sel', rid: 'r1', actionId: 'a1', orderId: 'o1', runId: '7', user: 'Ann', tsMs: 1_000_000 });
  const l = [sel,
    E({ key: 'q', rid: 'r1', source: 'frontend', user: null }),
    E({ key: 'ac', actionId: 'a1', source: 'events' }),
    E({ key: 'or', orderId: 'o1', source: 'events' }),
    E({ key: 'ru', runId: '7', source: 'jobs' }),
    E({ key: 'uw', user: 'ann', tsMs: 1_000_000 + 60_000 }),
    E({ key: 'far', user: 'ann', tsMs: 1_000_000 + 900_000 }),
    E({ key: 'unrelated', user: 'bob' })];
  const g = U.relatedTo(sel, l);
  assert.deepEqual(g.map(x => x.kind), ['request', 'action', 'order', 'run', 'user_window']);
  assert.deepEqual(g.map(x => x.possible), [false, false, false, false, true]);
  assert.deepEqual(g.map(x => x.entries.map(e => e.key)), [['q'], ['ac'], ['or'], ['ru'], ['uw']]);
  assert.ok(!g.some(x => x.entries.some(e => e.key === 'sel')));
  assert.ok(g.every(x => en[x.whyKey]));
  assert.deepEqual(U.relatedTo(E({ key: 'lonely', user: null }), l), []);
  assert.equal(U.relatedTo(sel, l, 2_000_000).find(x => x.kind === 'user_window').entries.length, 2);
});
