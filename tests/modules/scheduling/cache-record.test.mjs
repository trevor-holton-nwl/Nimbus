// T2: pure cache record builder + projection. Guard: every key _taskEditSnapshot emits survives the projection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import {
  projectRowForCache, buildCacheRecord, serializeCacheRecord, parseCacheRecord, fingerprintText, applyContextChanged,
  CACHE_ROW_FIELDS, SNAPSHOT_WIRE_TO_ROW, CACHE_RECORD_VERSION,
} from '../../../frontend/scheduling/cache-record.mjs';

globalThis.window = globalThis.window || {};

const d = s => new Date(s);
const base = (id, extra = {}) => ({ id, MACHINE: 'L1', PRT_01: 'T1', PRT_02: null, PRODUCTION_VERSION: '0001', RUN_TIME: 1.5,
  row_version: 7, user_scheduled: true, planning_status: 'scheduled', planning_reason: null,
  start_date: d('2026-09-09T08:00:00'), end_date: d('2026-09-09T09:30:00'), original_start_date: d('2026-09-08T08:00:00'),
  scheduleSegments: [{ sequence: 1, startDate: d('2026-09-09T08:00:00'), endDate: d('2026-09-09T09:30:00') }],
  run_time_source: 'routing', firmed: false, ...extra });

const scheduled = base('s1');
const queued = base('q1', { planning_status: 'needs_planning', user_scheduled: false, start_date: null, end_date: null,
  scheduleSegments: [], planning_reason: { code: 'no_capacity', detail: 'x', from: null } });
const overtime = base('o1', { placement_exception: 'overtime' });
const nulled = base('n1', { placement_exception: null });
const never = base('v1');
delete never.placement_exception;

const rowKeyOf = k => (k in SNAPSHOT_WIRE_TO_ROW ? SNAPSHOT_WIRE_TO_ROW[k] : k);

test('guard: every _taskEditSnapshot key appears in the projection', () => {
  Persistence._firmDirtyIds.add('s1');
  Persistence._dirtySource.set('s1', 'drag');
  try {
    for (const r of [scheduled, queued, overtime, nulled, never]) {
      const snap = Persistence._taskEditSnapshot(r);
      const proj = projectRowForCache(r);
      for (const k of Object.keys(snap)) {
        const rk = rowKeyOf(k);
        if (rk === null) continue;
        assert.ok(CACHE_ROW_FIELDS.includes(rk), `projection field list lacks ${rk} (snapshot key ${k})`);
        if (rk in r) assert.ok(rk in proj, `row ${r.id}: ${rk} dropped by projection`);
      }
    }
  } finally { Persistence._firmDirtyIds.clear(); Persistence._dirtySource.clear(); }
});

test('absent keys stay absent, explicit null stays null, id and row_version kept', () => {
  const pe = projectRowForCache(never);
  assert.equal('placement_exception' in pe, false);
  assert.equal(projectRowForCache(nulled).placement_exception, null);
  assert.equal(projectRowForCache(overtime).placement_exception, 'overtime');
  assert.equal(pe.id, 'v1');
  assert.equal(pe.row_version, 7);
  const bare = projectRowForCache({ id: 'x' });
  assert.deepEqual(Object.keys(bare), ['id']);
  const extra = projectRowForCache({ id: 'x', BIG: 'y', runtime_schedule_mismatch: true });
  assert.equal('BIG' in extra, false);
  assert.equal(extra.runtime_schedule_mismatch, true);
});

const input = (over = {}) => ({ user: 'u1', plant: 'P1', schemaVersion: 3, buildId: 'b1', savedAt: 1000, seq: 4,
  rows: [scheduled, queued], dirtyIds: ['s1', 'q1', 'z9'], forceIds: ['q1', 'gone'], dirtySource: new Map([['s1', 'drag']]),
  context: { lineSettings: { L1: { a: 1 } }, calendars: {}, blocks: [], plants: [], plantBlocks: {}, userSettings: {} }, ...over });

test('optimizerIds = forceIds intersect dirtyIds; dirtySource per row; lineSettings kept', () => {
  const rec = buildCacheRecord(input());
  assert.deepEqual(rec.optimizerIds, ['q1']);
  assert.equal(rec.rows.length, 2);
  assert.equal(rec.rows[0].dirtySource, 'drag');
  assert.equal('dirtySource' in rec.rows[1], false);
  assert.deepEqual(rec.context.lineSettings, { L1: { a: 1 } });
  assert.equal(rec.complete, true);
  assert.equal(rec.v, CACHE_RECORD_VERSION);
});

test('round trip serialize/parse', () => {
  const rec = buildCacheRecord(input());
  const json = serializeCacheRecord(rec);
  assert.equal(typeof json, 'string');
  assert.deepEqual(parseCacheRecord(json), JSON.parse(json));
  assert.equal(parseCacheRecord(json).seq, 4);
});

test('parse rejects garbage and old versions without throwing', () => {
  const good = JSON.parse(serializeCacheRecord(buildCacheRecord(input())));
  const bad = [null, undefined, 5, '', '{', 'null', '[]', '"x"',
    JSON.stringify({ ...good, v: 0 }), JSON.stringify({ ...good, v: 99 }),
    JSON.stringify({ ...good, complete: false }), JSON.stringify({ ...good, complete: undefined }),
    JSON.stringify({ ...good, seq: undefined }), JSON.stringify({ ...good, seq: 'a' }),
    JSON.stringify({ ...good, plant: '' }), JSON.stringify({ ...good, user: undefined }),
    JSON.stringify({ ...good, rows: 'no' })];
  for (const b of bad) assert.equal(parseCacheRecord(b), null, String(b));
});

test('size: 5000 dirty rows stay under 4,000,000 chars', () => {
  const pad = (n) => 'x'.repeat(n);
  const mk = (i, isQueued) => {
    const r = base(`id-${i}`, {
      // non-edited bulk the real rows carry (~45 fields); must NOT reach the record
      ...Object.fromEntries(Array.from({ length: 36 }, (_, k) => [`F${k}`, pad(isQueued ? 22 : 28)])),
    });
    if (isQueued) Object.assign(r, { planning_status: 'needs_planning', user_scheduled: false, start_date: null, end_date: null,
      scheduleSegments: [], planning_reason: { code: 'tool_blocked', detail: pad(120), from: null, to: null } });
    return r;
  };
  const sched = Array.from({ length: 2500 }, (_, i) => mk(i, false));
  const queue = Array.from({ length: 2500 }, (_, i) => mk(2500 + i, true));
  const fullS = JSON.stringify(sched[0]).length, fullQ = JSON.stringify(queue[0]).length;
  const rows = [...sched, ...queue];
  const rec = buildCacheRecord(input({ rows, dirtyIds: rows.map(r => r.id), forceIds: rows.map(r => r.id), dirtySource: new Map() }));
  const json = serializeCacheRecord(rec);
  const ps = JSON.stringify(rec.rows[0]).length, pq = JSON.stringify(rec.rows[2500]).length;
  console.log(`cache-record size: scheduled full ${fullS} -> projected ${ps} chars; queued full ${fullQ} -> projected ${pq} chars; 5000-row record ${json.length} chars`);
  assert.ok(json.length < 4_000_000);
  assert.ok(ps < fullS && pq < fullQ);
});

test('firmDirtyIds defaults to [] and travels; applyContext is written only when the record holds an optimizer batch', () => {
  assert.deepEqual(buildCacheRecord(input()).firmDirtyIds, []);
  const ctx = { calendar: 'c1', tools: 't1', setup: 's1' };
  const withBatch = buildCacheRecord(input({ firmDirtyIds: ['s1'], applyContext: ctx }));
  assert.deepEqual(withBatch.firmDirtyIds, ['s1']);
  assert.deepEqual(withBatch.applyContext, ctx);
  const noBatch = buildCacheRecord(input({ forceIds: [], applyContext: ctx }));
  assert.equal('applyContext' in noBatch, false, 'no batch, no context');
  const old = JSON.parse(serializeCacheRecord(withBatch)); delete old.firmDirtyIds;
  assert.deepEqual(parseCacheRecord(JSON.stringify(old)).firmDirtyIds, [], 'an older record parses with an empty list');
});

test('fingerprintText is stable and sensitive; applyContextChanged ignores unknown sides', () => {
  assert.equal(fingerprintText('abc'), fingerprintText('abc'));
  assert.notEqual(fingerprintText('abc'), fingerprintText('abd'));
  const a = { calendar: 'c1', tools: 't1', setup: 's1' };
  assert.equal(applyContextChanged(a, { ...a }), false);
  assert.equal(applyContextChanged(a, { ...a, setup: 's2' }), true);
  assert.equal(applyContextChanged(a, { calendar: null, tools: null, setup: null }), false, 'unknown now is not a change');
  assert.equal(applyContextChanged({ calendar: null, tools: 't1', setup: null }, { ...a, tools: 't2' }), true);
  assert.equal(applyContextChanged(null, a), false);
});

test('A4 n8 convertLegacyStatePlants limits the whole-blob context to each plant, the way the live record does', async () => {
  const { convertLegacyStatePlants } = await import('../../../frontend/scheduling/cache-record.mjs');
  const blob = {
    _schemaVersion: 7, selectedPlant: 'P', _dirtyIds: ['a', 'b'],
    tasks: [{ id: 'a', PLANT: 'P' }, { id: 'b', PLANT: 'Q' }],
    lineSettings: { LP: { plant: 'P' }, LQ: { plant: 'Q' } },
    calendars: { LP: { h: 1 }, LQ: { h: 2 } },
    plants: { P: { tz: 'a' }, Q: { tz: 'b' } },
    blocks: [{ id: 1, plant: 'P' }, { id: 2, plant: 'Q' }, { id: 3 }],
    plantBlocks: [{ id: 4, plant: 'Q' }, { id: 5, plant: 'P' }],
    userSettings: { theme: 'dark' },
  };
  const conv = convertLegacyStatePlants(blob, 'u', 7, 'b');
  const byPlant = Object.fromEntries(conv.plants.map(x => [x.plant, x.record.context]));
  assert.deepEqual(Object.keys(byPlant.P.calendars), ['LP']);
  assert.deepEqual(Object.keys(byPlant.Q.calendars), ['LQ']);
  assert.deepEqual(Object.keys(byPlant.P.plants), ['P']);
  assert.deepEqual(byPlant.P.blocks.map(b => b.id), [1, 3], 'this plant\'s blocks and plant-less ones');
  assert.deepEqual(byPlant.Q.plantBlocks.map(b => b.id), [4]);
  assert.deepEqual(Object.keys(byPlant.P.lineSettings).sort(), ['LP', 'LQ'], 'lineSettings stay whole');
  assert.deepEqual(byPlant.P.userSettings, { theme: 'dark' });
});
