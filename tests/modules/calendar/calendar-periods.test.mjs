// Tests for frontend/calendar/calendar-periods.mts (pure period helpers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodStatus, summarizeWeek, validatePeriodDraft, periodWarnings,
  buildPeriodStrip, nextPeriodDefaults, addDaysKey, dayIndex,
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
