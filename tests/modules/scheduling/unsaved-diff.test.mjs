// unsaved-diff.mts: the pure diff behind the unsaved-changes dialog. The app hooks (snapshot, parseDate, firm,
// source) are injected, so no Store/Persistence is needed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unsavedChanges, sortUnsaved, filterUnsaved, formatDeltaMs } from '../../../frontend/scheduling/unsaved-diff.mjs';

const snap = (o = {}) => ({
  planning_status: 'scheduled', planning_reason: null,
  start_date: '2026-11-06T02:30:00', end_date: '2026-11-06T14:00:00',
  PRT_01: null, PRT_02: null, PRODUCTION_VERSION: null, RUN_TIME: 6.5, MACHINE: 'M1', schedule_segments: [], ...o,
});
const key = o => JSON.stringify(snap(o));
const live = (id, over = {}, extra = {}) => ({ id, MATERIAL_NUMBER: `MAT-${id}`, MATERIAL_DESCRIPTION: `Desc ${id}`, MACHINE: over.MACHINE ?? 'M1', _snap: snap(over), ...extra });
function run({ dirty, base = {}, rows, firmDirty = [], firmed = [], source = {} }) {
  const baselines = new Map(Object.entries(base).map(([id, k]) => [id, { version: 1, key: k }]));
  return unsavedChanges(dirty, baselines, rows, {
    snapshot: t => ({ ...t._snap, ...(firmDirty.includes(String(t.id)) ? { FIRMED: true } : {}), ...(source[t.id] ? { source: source[t.id] } : {}) }),
    parseDate: v => (v ? new Date(v) : null),
    firmDirtyIds: new Set(firmDirty), dirtySource: new Map(Object.entries(source)), isFirmed: id => firmed.includes(id),
  });
}
const one = o => { const r = run(o); assert.equal(r.rows.length, 1); return r.rows[0]; };
const f = (row, k) => row.fields.find(x => x.key === k);

test('a moved order: start/finish before and after, delta from the finish, material carried', () => {
  const row = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', { start_date: '2026-11-08T22:00:00', end_date: '2026-11-09T09:30:00' }) }, source: { A: 'optimizer' } });
  assert.equal(row.status, 'moved');
  assert.equal(row.material, 'MAT-A'); assert.equal(row.materialDescription, 'Desc A');
  assert.equal(row.source, 'optimizer');
  assert.equal(f(row, 'finish').before.getTime(), new Date('2026-11-06T14:00:00').getTime());
  assert.equal(f(row, 'finish').after.getTime(), new Date('2026-11-09T09:30:00').getTime());
  assert.equal(row.deltaMs, new Date('2026-11-09T09:30:00') - new Date('2026-11-06T14:00:00'));
  assert.equal(formatDeltaMs(row.deltaMs), '+2d 19h');
  assert.equal(row.hasBaseline, true);
});

test('machine change wins over the date change', () => {
  const row = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', { MACHINE: 'M9', start_date: '2026-11-07T12:00:00', end_date: '2026-11-07T20:00:00' }) } });
  assert.equal(row.status, 'machine');
  assert.deepEqual([f(row, 'machine').before, f(row, 'machine').after], ['M1', 'M9']);
  assert.equal(row.machine, 'M9');
  assert.ok(f(row, 'start') && f(row, 'finish'));
});

test('run time only: start moves (finish held), status runtime, delta is the start gap', () => {
  const row = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', { RUN_TIME: 8, start_date: '2026-11-06T00:30:00' }) } });
  assert.equal(row.status, 'runtime');
  assert.equal(f(row, 'runtime').kind, 'hours');
  assert.deepEqual([f(row, 'runtime').before, f(row, 'runtime').after], [6.5, 8]);
  assert.equal(formatDeltaMs(row.deltaMs), '-2h');
});

test('PV and PRT edits are the tooling kind, field by field', () => {
  const row = one({ dirty: ['A'], base: { A: key({ PRT_01: 'T100' }) }, rows: { A: live('A', { PRT_01: 'T104', PRODUCTION_VERSION: '0003' }) } });
  assert.equal(row.status, 'tooling');
  assert.deepEqual([f(row, 'prt1').before, f(row, 'prt1').after], ['T100', 'T104']);
  assert.deepEqual([f(row, 'pv').before, f(row, 'pv').after], [null, '0003']);
  assert.equal(f(row, 'prt2'), undefined, 'unchanged fields are not listed');
});

test('segments: 2 -> 1 is a move even when start and finish hold; an unsplit order never reads 0 segments', () => {
  const seg = [{ sequence: 1, start_date: '2026-11-06T02:30:00', end_date: '2026-11-06T08:00:00' }, { sequence: 2, start_date: '2026-11-06T09:00:00', end_date: '2026-11-06T14:00:00' }];
  const row = one({ dirty: ['A'], base: { A: key({ schedule_segments: seg }) }, rows: { A: live('A', { schedule_segments: [] }) } });
  assert.equal(row.status, 'moved');
  assert.deepEqual([f(row, 'segments').before, f(row, 'segments').after], [2, 1]);
  const unsplit = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', { MACHINE: 'M2' }) } });
  assert.equal(f(unsplit, 'segments'), undefined);
  const noref = one({ dirty: ['A'], base: {}, rows: { A: live('A') } });
  assert.equal(f(noref, 'segments').after, 1);
});

test('a finish-held run time edit on a split order is still Run time', () => {
  const seg = [{ sequence: 1, start_date: '2026-11-06T02:30:00', end_date: '2026-11-06T08:00:00' }, { sequence: 2, start_date: '2026-11-06T09:00:00', end_date: '2026-11-06T14:00:00' }];
  const seg2 = [{ sequence: 1, start_date: '2026-11-06T04:30:00', end_date: '2026-11-06T08:00:00' }, { sequence: 2, start_date: '2026-11-06T09:00:00', end_date: '2026-11-06T14:00:00' }];
  const row = one({ dirty: ['A'], base: { A: key({ schedule_segments: seg }) }, rows: { A: live('A', { RUN_TIME: 5, start_date: '2026-11-06T04:30:00', schedule_segments: seg2 }) } });
  assert.equal(row.status, 'runtime');
});

test('a never-placed (display-only) baseline: placed dates read Not placed, absent fields are not diffed', () => {
  const displayOnly = { MACHINE: 'M1', PRT_01: null, PRT_02: null, PRODUCTION_VERSION: null, RUN_TIME: 6.5 };
  const row = one({ dirty: ['A'], base: { A: JSON.stringify(displayOnly) }, rows: { A: live('A') } });
  assert.equal(f(row, 'start').notPlaced, true);
  assert.equal(f(row, 'finish').notPlaced, true);
  assert.equal(f(row, 'segments'), undefined);
  assert.equal(row.status, 'moved');
});

test('firm-only: no made-up before (the saved firm state is not recorded; a reverted toggle stays marked)', () => {
  const on = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A') }, firmDirty: ['A'], firmed: ['A'] });
  assert.equal(on.status, 'firm');
  assert.equal('before' in f(on, 'firm'), false);
  assert.equal(f(on, 'firm').after, true);
  const off = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A') }, firmDirty: ['A'], firmed: [] });
  assert.equal('before' in f(off, 'firm'), false);
  assert.equal(f(off, 'firm').after, false);
});

test('a firm mark alongside a move lists both and the move wins the chip', () => {
  const row = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', { end_date: '2026-11-06T16:00:00' }) }, firmDirty: ['A'], firmed: ['A'] });
  assert.equal(row.status, 'moved');
  assert.ok(f(row, 'firm') && f(row, 'finish'));
});

test('no baseline (mismatch / cached overlay / never saved): "No saved reference", current values only, nothing invented', () => {
  const row = one({ dirty: ['A'], base: {}, rows: { A: live('A', { RUN_TIME: 7.5 }) } });
  assert.equal(row.status, 'noref');
  assert.equal(row.hasBaseline, false);
  assert.ok(row.fields.length >= 5);
  for (const fld of row.fields) assert.equal('before' in fld, false, `${fld.key} has no made-up before`);
  assert.equal(f(row, 'runtime').after, 7.5);
  assert.equal(row.deltaMs, 0);
});

test('an unparseable baseline key counts as no saved reference', () => {
  const row = one({ dirty: ['A'], base: { A: 'not json' }, rows: { A: live('A') } });
  assert.equal(row.status, 'noref');
});

test('a queued order that was scheduled: status needs, dates go to (none)', () => {
  const row = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', { planning_status: 'needs_planning', start_date: null, end_date: null }) } });
  assert.equal(row.status, 'needs');
  assert.equal(f(row, 'finish').after, null);
  assert.ok(f(row, 'finish').before instanceof Date);
  assert.equal(row.deltaMs, 0);
});

test('a never-placed order whose baseline already needs planning is not flagged as newly unscheduled', () => {
  const q = { planning_status: 'needs_planning', start_date: null, end_date: null };
  const row = one({ dirty: ['A'], base: { A: key(q) }, rows: { A: live('A', { ...q, RUN_TIME: 9 }) } });
  assert.equal(row.status, 'runtime');
});

test('baseline equal to current: "No visible change", no fields, still listed so the count reconciles', () => {
  const row = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A') }, source: { A: 'undo' } });
  assert.equal(row.status, 'nochange');
  assert.deepEqual(row.fields, []);
  assert.equal(row.source, 'undo');
});

test('only an invisible field differing (placement exception, reason) is still "No visible change"', () => {
  const row = one({ dirty: ['A'], base: { A: key({ placement_exception: 'overtime' }) }, rows: { A: live('A', { placement_exception: null }) } });
  assert.equal(row.status, 'nochange');
});

test('an unsaved id missing from the Store is skipped and reported; rows + skipped reconcile with the dirty count', () => {
  const dirty = ['A', 'B', 'GONE'];
  const r = run({ dirty, base: { A: key(), B: key() }, rows: { A: live('A'), B: live('B', { MACHINE: 'M2' }) } });
  assert.deepEqual(r.skipped, ['GONE']);
  assert.equal(r.rows.length + r.skipped.length, dirty.length);
});

test('the engine move note is carried (derivationIssue first), and ignored for non-move codes', () => {
  const from = new Date('2026-11-06T02:30:00'), to = new Date('2026-11-08T22:00:00');
  const a = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', {}, { systemMove: { from, to, reason: 'run_time_changed' } }) } });
  assert.deepEqual(a.moveNote, { reason: 'run_time_changed', from, to });
  const b = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', {}, { systemMove: { from, to, reason: 'run_time_changed' }, derivationIssue: { code: 'reversal_forward', from, to } }) } });
  assert.equal(b.moveNote.reason, 'reversal_forward');
  const c = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', {}, { derivationIssue: { code: 'missing_timezone' } }) } });
  assert.equal(c.moveNote, null);
  // A rejected issue code never lends its from/to to the accepted systemMove (and vice versa).
  const other = new Date('2026-12-01T00:00:00');
  const d = one({ dirty: ['A'], base: { A: key() }, rows: { A: live('A', {}, { systemMove: { from, to, reason: 'run_time_changed' }, derivationIssue: { code: 'missing_timezone', from: other, to: other } }) } });
  assert.deepEqual(d.moveNote, { reason: 'run_time_changed', from, to });
});

test('sort: biggest move first, then change kind, then id; order and machine sorts', () => {
  const rows = run({
    dirty: ['C', 'B', 'A', 'D'],
    base: { A: key(), B: key(), C: key(), D: key() },
    rows: {
      A: live('A', { end_date: '2026-11-06T16:00:00' }),                                   // +2h
      B: live('B', { end_date: '2026-11-09T09:30:00', start_date: '2026-11-08T22:00:00' }), // +2d 19h
      C: live('C', { MACHINE: 'M0' }),                                                    // machine, no delta
      D: live('D'),                                                                       // no change
    },
  }).rows;
  assert.deepEqual(sortUnsaved(rows, 'move').map(r => r.id), ['B', 'A', 'C', 'D']);
  assert.deepEqual(sortUnsaved(rows, 'order').map(r => r.id), ['A', 'B', 'C', 'D']);
  assert.deepEqual(sortUnsaved(rows, 'machine').map(r => r.id), ['C', 'B', 'A', 'D']);
  assert.equal(rows.length, 4, 'input is not mutated');
});

test('filter matches order, material number, description and machine, case-insensitively', () => {
  const rows = run({ dirty: ['A', 'B'], base: { A: key(), B: key() }, rows: { A: live('A'), B: live('B', { MACHINE: 'Blow-9' }) } }).rows;
  assert.deepEqual(filterUnsaved(rows, 'mat-a').map(r => r.id), ['A']);
  assert.deepEqual(filterUnsaved(rows, 'DESC B').map(r => r.id), ['B']);
  assert.deepEqual(filterUnsaved(rows, 'blow').map(r => r.id), ['B']);
  assert.deepEqual(filterUnsaved(rows, 'b').map(r => r.id).sort(), ['B']);
  assert.equal(filterUnsaved(rows, '  ').length, 2);
});

test('formatDeltaMs', () => {
  assert.equal(formatDeltaMs(0), '0h');
  assert.equal(formatDeltaMs(-2 * 3_600_000), '-2h');
  assert.equal(formatDeltaMs(45 * 60_000), '+45m');
  assert.equal(formatDeltaMs(90 * 60_000), '+1h 30m');
  assert.equal(formatDeltaMs(24 * 3_600_000), '+1d');
});

test('Order sort compares ids numerically-aware', () => {
  const rows = run({ dirty: ['100', '20', '3'], base: { 100: key(), 20: key(), 3: key() }, rows: { 100: live('100'), 20: live('20'), 3: live('3') } }).rows;
  assert.deepEqual(sortUnsaved(rows, 'order').map(r => r.id), ['3', '20', '100']);
});

test('order is the live PRODUCTION_ORDER, empty when it has none; sort and filter use it, the id stays the key', () => {
  const rows = run({ dirty: ['t1', 't2', 't3'], base: { t1: key(), t2: key(), t3: key() }, rows: {
    t1: live('t1', {}, { PRODUCTION_ORDER: '1000200', MATERIAL_NUMBER: 'MX', MATERIAL_DESCRIPTION: 'Dx' }), t2: live('t2', {}, { PRODUCTION_ORDER: '  ', MATERIAL_NUMBER: 'MY', MATERIAL_DESCRIPTION: 'Dy' }), t3: live('t3', {}, { PRODUCTION_ORDER: '900', MATERIAL_NUMBER: 'MZ', MATERIAL_DESCRIPTION: 'Dz' }),
  } }).rows;
  assert.deepEqual(rows.map(r => [r.id, r.order]), [['t1', '1000200'], ['t2', ''], ['t3', '900']]);
  assert.deepEqual(sortUnsaved(rows, 'order').map(r => r.id), ['t2', 't3', 't1'], 'numeric-aware on the order number');
  assert.deepEqual(filterUnsaved(rows, '1000200').map(r => r.id), ['t1']);
  assert.deepEqual(filterUnsaved(rows, 't1').map(r => r.id), [], 'the internal id is not matched when an order number exists');
});

test('formatDeltaMs takes localised unit letters', () => {
  const u = { d: 'T', h: 'Std.', m: 'Min.' };
  assert.equal(formatDeltaMs(0, u), '0Std.');
  assert.equal(formatDeltaMs(-(26 * 3_600_000), u), '-1T 2Std.');
  assert.equal(formatDeltaMs(45 * 60_000, u), '+45Min.');
});
