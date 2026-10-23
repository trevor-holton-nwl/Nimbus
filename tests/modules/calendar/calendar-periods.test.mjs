// Tests for frontend/calendar/calendar-periods.mts (pure period helpers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodStatus, summarizeWeek, validatePeriodDraft, periodWarnings,
  buildPeriodStrip, buildBlackoutMarks, buildDefaultSegments, nextPeriodDefaults, addDaysKey, dayIndex, activePeriodOn,
} from '../../../frontend/calendar/calendar-periods.mjs';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const wh = (map) => { const o = {}; for (let d = 0; d < 7; d++) o[d] = map[d] ?? null; return o; };
const per = (id, from, to, name = id) => ({ id, name, validFrom: from, validTo: to, workHours: wh({}) });

test('periodStatus: boundaries are inclusive and null validTo is open-ended', () => {
  assert.equal(periodStatus({ validFrom: '2026-10-16', validTo: '2026-10-20' }, '2026-10-16'), 'active');
  assert.equal(periodStatus({ validFrom: '2026-10-10', validTo: '2026-10-16' }, '2026-10-16'), 'active');
  assert.equal(periodStatus({ validFrom: '2026-10-10', validTo: '2026-10-15' }, '2026-10-16'), 'past');
  assert.equal(periodStatus({ validFrom: '2026-10-17', validTo: null }, '2026-10-16'), 'upcoming');
  assert.equal(periodStatus({ validFrom: '2020-01-01', validTo: null }, '2026-10-16'), 'active');
});

test('summarizeWeek groups consecutive equal days, Sunday last, 24 shown as 24:00', () => {
  const s = summarizeWeek(wh({ 1: [1, 13], 2: [1, 13], 3: [1, 13], 4: [1, 13], 5: [6, 14] }), DAYS);
  assert.equal(s.full, 'Mon–Thu 01:00–13:00 · Fri 06:00–14:00 · Sat–Sun Closed');
  assert.equal(s.short, 'Mon–Thu 01:00–13:00 · Fri 06:00–14:00 +1');
  const sun = summarizeWeek(wh({ 6: [8, 24], 0: [8, 24] }), DAYS);
  assert.equal(sun.full, 'Mon–Fri Closed · Sat–Sun 08:00–24:00');
  assert.equal(sun.short, sun.full, 'two groups need no +N');
});

test('summarizeWeek: all closed uses the caller label; fractional hours format as minutes', () => {
  assert.deepEqual(summarizeWeek(wh({}), DAYS, { closedAll: 'Cerrado toda la semana' }),
    { short: 'Cerrado toda la semana', full: 'Cerrado toda la semana' });
  assert.deepEqual(summarizeWeek(wh({}), DAYS), { short: 'Closed all week', full: 'Closed all week' });
  assert.equal(summarizeWeek(wh({ 3: [6.5, 14.25] }), DAYS, { closed: 'Off' }).full,
    'Mon–Tue Off · Wed 06:30–14:15 · Thu–Sun Off');
});

test('validatePeriodDraft: required name and from, to before from', () => {
  const base = { id: 'a', name: 'X', validFrom: '2026-10-01', validTo: '2026-10-05', workHours: wh({}) };
  assert.deepEqual(validatePeriodDraft(base, []), []);
  assert.deepEqual(validatePeriodDraft({ ...base, name: '   ' }, []).map(i => i.field), ['name']);
  assert.deepEqual(validatePeriodDraft({ ...base, validFrom: '' }, []).map(i => i.code), ['period_from_required']);
  const bad = validatePeriodDraft({ ...base, validTo: '2026-09-30' }, []);
  assert.deepEqual(bad.map(i => [i.field, i.code]), [['to', 'period_to_before_from']]);
});

test('validatePeriodDraft: inclusive overlap names the other period', () => {
  const existing = [per('p1', '2026-10-01', '2026-10-10', 'Summer')];
  const draft = (from, to) => ({ id: 'n', name: 'N', validFrom: from, validTo: to, workHours: wh({}) });
  const shared = validatePeriodDraft(draft('2026-10-10', '2026-10-12'), existing);
  assert.equal(shared.length, 1, 'a shared end day overlaps');
  assert.equal(shared[0].field, 'overlap');
  assert.deepEqual(shared[0].params, { name: 'Summer', from: '2026-10-01', to: '2026-10-10' });
  assert.deepEqual(validatePeriodDraft(draft('2026-10-11', '2026-10-12'), existing), []);
  assert.deepEqual(validatePeriodDraft(draft('2026-09-20', '2026-09-30'), existing), []);
  assert.equal(validatePeriodDraft(draft('2026-09-20', '2026-10-01'), existing).length, 1);
});

test('validatePeriodDraft: open-ended periods overlap everything after; own id is ignored', () => {
  const open = [per('p1', '2026-10-01', null, 'Forever')];
  const d = (from, to) => ({ id: 'n', name: 'N', validFrom: from, validTo: to, workHours: wh({}) });
  assert.equal(validatePeriodDraft(d('2030-01-01', '2030-01-05'), open).length, 1);
  assert.equal(validatePeriodDraft(d('2026-01-01', null), open).length, 1, 'open-ended draft hits a later period');
  assert.deepEqual(validatePeriodDraft(d('2026-01-01', '2026-09-30'), open), []);
  assert.deepEqual(validatePeriodDraft({ ...d('2026-10-02', '2026-10-09'), id: 'p1' }, open), [], 'editing a period never conflicts with itself');
});

test('periodWarnings: all-closed + (open-ended or >90 days)', () => {
  const closed = { id: 'a', name: 'A', validFrom: '2026-01-01', validTo: '2026-03-31', workHours: wh({}) };
  assert.deepEqual(periodWarnings(closed), [], '89 days apart is not above 90');
  assert.deepEqual(periodWarnings({ ...closed, validTo: '2026-04-02' }), ['all_closed_long']);
  assert.deepEqual(periodWarnings({ ...closed, validTo: null }), ['all_closed_long']);
  assert.deepEqual(periodWarnings({ ...closed, validTo: null, workHours: wh({ 1: [8, 17] }) }), []);
  assert.deepEqual(periodWarnings({ ...closed, validTo: '2026-01-07' }), []);
});

test('buildPeriodStrip: axis bounds and percentages', () => {
  const today = '2026-10-16';
  const strip = buildPeriodStrip([per('p1', '2026-10-20', '2026-10-26', 'Wk')], today);
  assert.equal(strip.axisStartKey, addDaysKey(today, -30));
  assert.equal(strip.axisEndKey, addDaysKey(today, 365));
  const total = 30 + 365 + 1;
  const seg = strip.segments[0];
  assert.equal(seg.status, 'upcoming');
  assert.equal(seg.openEnded, false);
  assert.ok(Math.abs(seg.leftPct - (34 / total) * 100) < 1e-9);
  assert.ok(Math.abs(seg.widthPct - (7 / total) * 100) < 1e-9);
  assert.ok(Math.abs(strip.today.leftPct - (30 / total) * 100) < 1e-9);
});

test('buildPeriodStrip: starts at an earlier period start, open-ended runs to 100%, 2-year cap clips', () => {
  const today = '2026-10-16';
  const early = buildPeriodStrip([per('p0', '2026-01-01', '2026-02-01')], today);
  assert.equal(early.axisStartKey, '2026-01-01');
  const open = buildPeriodStrip([per('p1', '2026-11-01', null)], today);
  const o = open.segments[0];
  assert.equal(o.openEnded, true);
  assert.ok(Math.abs(o.leftPct + o.widthPct - 100) < 1e-9);
  const far = buildPeriodStrip([per('p2', '2026-11-01', '2031-01-01')], today);
  assert.equal(far.axisEndKey, addDaysKey(today, 730));
  assert.ok(Math.abs(far.segments[0].leftPct + far.segments[0].widthPct - 100) < 1e-9, 'clipped at the axis end');
});

test('buildPeriodStrip: month ticks (year on January) and quarterly ticks on a long axis', () => {
  const today = '2026-10-16';
  const short = buildPeriodStrip([], today, { fmtMonth: d => `M${d.getMonth() + 1}` });
  assert.deepEqual(short.ticks.slice(0, 4).map(t => t.label), ['M10', 'M11', 'M12', 'M1 2027']);
  assert.equal(short.ticks.length, 13);
  const long = buildPeriodStrip([per('p', '2026-11-01', '2031-01-01')], today, { fmtMonth: d => `M${d.getMonth() + 1}` });
  assert.ok(dayIndex(long.axisEndKey) - dayIndex(long.axisStartKey) + 1 > 700);
  assert.ok(long.ticks.every(t => /^M(1|4|7|10)( \d{4})?$/.test(t.label)), 'quarters only');
  const dflt = buildPeriodStrip([], today).ticks[0].label;
  assert.equal(dflt, 'Oct');
});

test('buildPeriodStrip: axis start is capped at one year back; old segments clip at the left edge; ticks cover the whole axis', () => {
  const today = '2026-10-16';
  const strip = buildPeriodStrip([per('old', '2020-01-01', '2020-06-30'), per('far', '2026-11-01', '2031-01-01')], today,
    { fmtMonth: d => `M${d.getMonth() + 1}` });
  assert.equal(strip.axisStartKey, addDaysKey(today, -365));
  assert.equal(strip.axisEndKey, addDaysKey(today, 730));
  const old = strip.segments[0];
  assert.equal(old.leftPct, 0, 'a segment older than the axis is clipped at the left edge');
  assert.equal(old.fromKey, '2020-01-01', 'the segment keeps its real dates for the title');
  assert.ok(strip.today.leftPct > 30 && strip.today.leftPct < 36, 'today is not squeezed against the left edge');
  assert.ok(strip.ticks.length > 0 && strip.ticks[0].leftPct < 10, 'ticks start near the left edge');
  assert.ok(strip.ticks[strip.ticks.length - 1].leftPct > 85, 'ticks run to the right end of the axis');
});

test('nextPeriodDefaults: today, or the day after the latest end; one week long', () => {
  assert.deepEqual(nextPeriodDefaults([], '2026-10-16'), { validFrom: '2026-10-16', validTo: '2026-10-22' });
  const later = [per('a', '2026-10-01', '2026-10-31'), per('b', '2026-11-01', '2026-11-30')];
  assert.deepEqual(nextPeriodDefaults(later, '2026-10-16'), { validFrom: '2026-12-01', validTo: '2026-12-07' });
  const past = [per('a', '2026-01-01', '2026-02-01')];
  assert.deepEqual(nextPeriodDefaults(past, '2026-10-16'), { validFrom: '2026-10-16', validTo: '2026-10-22' });
  assert.deepEqual(nextPeriodDefaults([per('a', '2026-12-30', '2026-12-31')], '2026-10-16'),
    { validFrom: '2027-01-01', validTo: '2027-01-07' });
});

// Ten-day axis, 2026-01-01..2026-01-10, so each day is exactly 10%.
const AXIS = { axisStartKey: '2026-01-01', axisEndKey: '2026-01-10' };
const blk = (id, fromKey, toKey) => ({ id, fromKey, toKey });

test('buildBlackoutMarks: geometry for one blackout inside the axis', () => {
  const { marks, truncated } = buildBlackoutMarks(AXIS, [blk('a', '2026-01-03', '2026-01-04')]);
  assert.equal(truncated, 0);
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].ids, ['a']);
  assert.equal(marks[0].leftPct, 20);
  assert.equal(marks[0].widthPct, 20);
});

test('buildBlackoutMarks: clips at both edges and drops anything wholly outside', () => {
  const { marks } = buildBlackoutMarks(AXIS, [
    blk('left', '2025-12-20', '2026-01-02'),
    blk('right', '2026-01-09', '2026-02-20'),
    blk('before', '2025-12-01', '2025-12-31'),
    blk('after', '2026-01-11', '2026-01-12'),
  ]);
  assert.deepEqual(marks.map(m => m.ids), [['left'], ['right']]);
  assert.equal(marks[0].fromKey, '2026-01-01');
  assert.equal(marks[0].leftPct, 0);
  assert.equal(marks[0].widthPct, 20);
  assert.equal(marks[1].toKey, '2026-01-10');
  assert.equal(marks[1].leftPct, 80);
  assert.equal(marks[1].widthPct, 20);
});

test('buildBlackoutMarks: a blackout ending at exclusive midnight covers only its last day (the caller passes the end-1ms day)', () => {
  // 2026-01-03 00:00 -> 2026-01-05 00:00 is the 3rd and 4th, so the UI hands over toKey = 2026-01-04.
  const { marks } = buildBlackoutMarks(AXIS, [blk('a', '2026-01-03', '2026-01-04')]);
  assert.equal(marks[0].toKey, '2026-01-04');
  assert.equal(marks[0].widthPct, 20);
});

test('buildBlackoutMarks: overlapping and touching blackouts merge; ids keep time order', () => {
  const { marks } = buildBlackoutMarks(AXIS, [
    blk('c', '2026-01-06', '2026-01-07'),   // touches b (b ends the 5th)
    blk('a', '2026-01-02', '2026-01-04'),
    blk('b', '2026-01-04', '2026-01-05'),   // overlaps a on the 4th
  ]);
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].ids, ['a', 'b', 'c']);
  assert.equal(marks[0].fromKey, '2026-01-02');
  assert.equal(marks[0].toKey, '2026-01-07');
  assert.equal(marks[0].widthPct, 60);
});

test('buildBlackoutMarks: a blackout inside a longer one does not shrink the cluster', () => {
  const { marks } = buildBlackoutMarks(AXIS, [blk('big', '2026-01-02', '2026-01-09'), blk('small', '2026-01-04', '2026-01-04')]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].toKey, '2026-01-09');
});

test('buildBlackoutMarks: a free day between two blackouts keeps them separate', () => {
  const { marks } = buildBlackoutMarks(AXIS, [blk('a', '2026-01-02', '2026-01-03'), blk('b', '2026-01-05', '2026-01-06')]);
  assert.deepEqual(marks.map(m => m.ids), [['a'], ['b']]);
});

test('buildBlackoutMarks: caps at 60 clusters and counts the rest', () => {
  const axis = { axisStartKey: '2026-01-01', axisEndKey: '2026-12-31' };
  const items = [];
  for (let i = 0; i < 70; i++) { const k = addDaysKey('2026-01-01', i * 4); items.push(blk('b' + i, k, k)); }
  const { marks, truncated } = buildBlackoutMarks(axis, items);
  assert.equal(marks.length, 60);
  assert.equal(truncated, 10);
  assert.deepEqual(marks[0].ids, ['b0'], 'the earliest clusters are the ones kept');
  assert.deepEqual(buildBlackoutMarks(axis, []), { marks: [], truncated: 0 });
});

test('buildBlackoutMarks: over the cap with todayKey keeps clusters nearest today forward, drops oldest past', () => {
  const axis = { axisStartKey: '2026-01-01', axisEndKey: '2026-12-31' };
  const items = [];
  for (let i = 0; i < 70; i++) { const k = addDaysKey('2026-01-01', i * 4); items.push(blk('b' + i, k, k)); }
  // today = day 40 (b10 sits exactly on it): 60 ahead (b10..b69) fit, so every past cluster drops.
  const r1 = buildBlackoutMarks(axis, items, addDaysKey('2026-01-01', 40));
  assert.equal(r1.marks.length, 60);
  assert.equal(r1.truncated, 10);
  assert.deepEqual(r1.marks[0].ids, ['b10']);
  // today = day 100 (b25): 45 ahead (b25..b69) + the 15 most recent past (b10..b24); time-sorted.
  const r2 = buildBlackoutMarks(axis, items, addDaysKey('2026-01-01', 100));
  assert.equal(r2.marks.length, 60);
  assert.equal(r2.truncated, 10);
  assert.deepEqual(r2.marks.map(m => m.ids[0]), items.slice(10).map(i => i.id));
  // Under the cap, todayKey changes nothing.
  assert.equal(buildBlackoutMarks(axis, items.slice(0, 5), '2026-06-01').marks.length, 5);
});

// ---- buildDefaultSegments: the axis stretches no period covers (2026-01-01..2026-01-10, 10% per day) ----
const seg = (fromKey, toKey, openEnded = false) => ({ id: fromKey, name: fromKey, status: 'upcoming', leftPct: 0, widthPct: 0, openEnded, fromKey, toKey });
const dstrip = (...segments) => ({ ...AXIS, segments });
const keys = (r) => r.map(g => [g.fromKey, g.toKey]);

test('buildDefaultSegments: no periods is one gap spanning the whole axis', () => {
  const r = buildDefaultSegments(dstrip());
  assert.deepEqual(keys(r), [['2026-01-01', '2026-01-10']]);
  assert.equal(r[0].leftPct, 0);
  assert.ok(Math.abs(r[0].widthPct - 100) < 1e-9);
});

test('buildDefaultSegments: a period in the middle leaves a gap on each side', () => {
  const r = buildDefaultSegments(dstrip(seg('2026-01-04', '2026-01-06')));
  assert.deepEqual(keys(r), [['2026-01-01', '2026-01-03'], ['2026-01-07', '2026-01-10']]);
  assert.ok(Math.abs(r[0].widthPct - 30) < 1e-9 && Math.abs(r[1].leftPct - 60) < 1e-9 && Math.abs(r[1].widthPct - 40) < 1e-9);
});

test('buildDefaultSegments: adjacent periods leave no zero-width gap, one-day gaps are kept', () => {
  assert.deepEqual(keys(buildDefaultSegments(dstrip(seg('2026-01-03', '2026-01-04'), seg('2026-01-05', '2026-01-07')))),
    [['2026-01-01', '2026-01-02'], ['2026-01-08', '2026-01-10']]);
  assert.deepEqual(keys(buildDefaultSegments(dstrip(seg('2026-01-03', '2026-01-04'), seg('2026-01-06', '2026-01-07')))),
    [['2026-01-01', '2026-01-02'], ['2026-01-05', '2026-01-05'], ['2026-01-08', '2026-01-10']]);
});

test('buildDefaultSegments: an open-ended period leaves no trailing gap', () => {
  assert.deepEqual(keys(buildDefaultSegments(dstrip(seg('2026-01-04', null, true)))), [['2026-01-01', '2026-01-03']]);
});

test('buildDefaultSegments: periods clipped at the axis edges leave no phantom gap there', () => {
  // Starts before the axis (unclipped fromKey) and ends inside it: the gap begins after it.
  assert.deepEqual(keys(buildDefaultSegments(dstrip(seg('2025-12-20', '2026-01-03')))), [['2026-01-04', '2026-01-10']]);
  // Runs past the axis end: no trailing gap.
  assert.deepEqual(keys(buildDefaultSegments(dstrip(seg('2026-01-08', '2026-03-01')))), [['2026-01-01', '2026-01-07']]);
  // Covers the whole axis: nothing left.
  assert.deepEqual(buildDefaultSegments(dstrip(seg('2025-01-01', '2027-01-01'))), []);
});

test('buildDefaultSegments: segment order does not matter and overlapping input never double-counts', () => {
  const r = buildDefaultSegments(dstrip(seg('2026-01-07', '2026-01-08'), seg('2026-01-02', '2026-01-05'), seg('2026-01-04', '2026-01-06')));
  assert.deepEqual(keys(r), [['2026-01-01', '2026-01-01'], ['2026-01-09', '2026-01-10']]);
});

test('buildDefaultSegments: gaps and drawn segments tile the real strip exactly (percentages sum to 100)', () => {
  const today = '2026-10-16';
  const periods = [per('a', '2026-10-01', '2026-10-31'), per('b', '2026-11-01', '2026-11-20'), per('c', '2027-01-05', '2027-02-01'), per('d', '2027-03-01', null)];
  const strip = buildPeriodStrip(periods, today);
  const gaps = buildDefaultSegments(strip);
  const sum = [...strip.segments, ...gaps].reduce((n, s) => n + s.widthPct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-6, `tiles to 100%, got ${sum}`);
  // a/b are adjacent: no gap between them.
  assert.ok(!gaps.some(g => g.fromKey > '2026-10-31' && g.toKey < '2026-11-01'));
  assert.equal(gaps[0].fromKey, strip.axisStartKey);
  for (const g of gaps) assert.ok(g.widthPct > 0 && g.fromKey <= g.toKey);
});

test('buildDefaultSegments: a period wholly older than the clipped axis is drawn as a one-day sliver, and the gap math matches', () => {
  const strip = buildPeriodStrip([per('old', '2020-01-01', '2020-06-30'), per('x', '2026-11-01', '2026-11-05')], '2026-10-16');
  const sum = [...strip.segments, ...buildDefaultSegments(strip)].reduce((n, s) => n + s.widthPct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-6);
});

test('activePeriodOn: inclusive bounds, open-ended, earliest validFrom wins, null for none', () => {
  const a = per('a', '2026-10-10', '2026-10-20');
  const b = per('b', '2026-10-21', null);
  assert.equal(activePeriodOn([a, b], '2026-10-09'), null);
  assert.equal(activePeriodOn([a, b], '2026-10-10').id, 'a');
  assert.equal(activePeriodOn([a, b], '2026-10-20').id, 'a');
  assert.equal(activePeriodOn([a, b], '2026-10-21').id, 'b');
  assert.equal(activePeriodOn([a, b], '2099-01-01').id, 'b');
  assert.equal(activePeriodOn([b, per('c', '2026-10-01', null)], '2026-10-22').id, 'c', 'earliest validFrom wins on overlap');
  assert.equal(activePeriodOn(undefined, '2026-10-22'), null);
  assert.equal(activePeriodOn([], '2026-10-22'), null);
});
