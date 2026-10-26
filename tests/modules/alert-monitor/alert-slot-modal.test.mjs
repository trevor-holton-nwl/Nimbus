// Tests for frontend/alert-monitor/alert-slot-modal.mts. Part 1 is the pure exports (ranking, closed-day walk-back,
// task fingerprint, default day, option text); part 2 drives the dialog and place() against a stubbed document,
// the real Store/UndoStack and stubbed Engine / Calendar / Toast / Modal.confirm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  parsePairValue, rankSlotCandidates, slotFinishFor, slotTaskKey, defaultSlotDay, formatSlotOption, SLOT_LOOKBACK_DAYS,
} from '../../../frontend/alert-monitor/alert-slot-modal.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

/* ---------------------------------------------------------------- part 1: pure exports */

test('parsePairValue splits at the first pipe and pads the production version; a bare machine keeps the PV (null)', () => {
  assert.deepEqual(parsePairValue('0001|M1'), { pv: '0001', machine: 'M1' });
  assert.deepEqual(parsePairValue('1|M1'), { pv: '0001', machine: 'M1' }, 'an unpadded PV comes back padded');
  assert.deepEqual(parsePairValue('0001|M|1'), { pv: '0001', machine: 'M|1' }, 'only the first pipe splits');
  assert.deepEqual(parsePairValue('|M1'), { pv: '', machine: 'M1' }, 'an empty PV half stays empty, not null');
  assert.deepEqual(parsePairValue('M1'), { pv: null, machine: 'M1' });
});

function rankDeps(table, opts = {}) {
  return {
    pairOptions: () => Object.keys(table).map(v => ({ value: v, label: `L:${v}` })),
    hoursFor: (_task, _pv, machine) => table[Object.keys(table).find(v => v.split('|').pop() === machine)].need,
    dayCapacity: (machine) => table[Object.keys(table).find(v => v.split('|').pop() === machine)].cap,
    ...opts,
  };
}

test('rankSlotCandidates: fits first, then free hours descending, unknown last, then need ascending, machine, pv', () => {
  const day = '2026-10-28';
  const deps = rankDeps({
    'A': { need: 4, cap: { free: 6, cap: 8, closed: false } },       // fits, 6 free
    'B': { need: 4, cap: { free: 9, cap: 10, closed: false } },      // fits, 9 free
    'C': { need: 4, cap: { free: 2, cap: 8, closed: false } },       // short
    'D': { need: 4, cap: { free: 0, cap: 0, closed: true } },        // closed
    'E': { need: 4, cap: null },                                      // capacity unreadable
    'F': { need: null, cap: { free: 9, cap: 10, closed: false } },   // run time unknown
    'G': { need: 4, cap: { free: 6, cap: 8, closed: false } },       // ties A on free and need: machine breaks it
    'H': { need: 3, cap: { free: 6, cap: 8, closed: false } },       // ties A on free: smaller need first
  });
  const ranked = rankSlotCandidates({ id: 't1' }, day, deps);
  assert.deepEqual(ranked.map(c => c.machine), ['B', 'H', 'A', 'G', 'F', 'C', 'D', 'E']);
  assert.deepEqual(ranked.map(c => c.fits), [true, true, true, true, false, false, false, false]);
  const top = ranked[0];
  assert.deepEqual({ value: top.value, pv: top.pv, label: top.label, needHours: top.needHours, freeHours: top.freeHours, capHours: top.capHours, closed: top.closed },
    { value: 'B', pv: null, label: 'L:B', needHours: 4, freeHours: 9, capHours: 10, closed: false });
  assert.equal(ranked.find(c => c.machine === 'D').closed, true);
  assert.equal(ranked.find(c => c.machine === 'E').freeHours, null);
  assert.equal(ranked.find(c => c.machine === 'F').needHours, null);
});

test('rankSlotCandidates: routing pairs carry the padded PV, equal machines order by PV, an unresolved pair carries its step', () => {
  const deps = {
    pairOptions: () => [{ value: '0002|M1', label: '0002 - M1' }, { value: '0001|M1', label: '0001 - M1' }, { value: '0003|M1', label: '0003 - M1' }],
    hoursFor: (_t, pv) => (pv === '0003' ? null : 5),
    dayCapacity: () => ({ free: 8, cap: 8, closed: false }),
    resolveStep: (_t, pv) => (pv === '0003' ? 'pv_expired' : undefined),
  };
  const ranked = rankSlotCandidates({ id: 't1' }, '2026-10-28', deps);
  assert.deepEqual(ranked.map(c => c.pv), ['0001', '0002', '0003']);
  assert.equal(ranked[2].resolveStep, 'pv_expired');
  assert.equal(ranked[0].resolveStep, undefined);
  assert.equal(ranked[2].fits, false);
});

test('rankSlotCandidates: a zero or negative need is unknown, never a fit; an empty option list ranks to nothing', () => {
  const ranked = rankSlotCandidates({ id: 't1' }, '2026-10-28', rankDeps({ A: { need: 0, cap: { free: 8, cap: 8, closed: false } } }));
  assert.equal(ranked[0].needHours, null);
  assert.equal(ranked[0].fits, false);
  assert.deepEqual(rankSlotCandidates({ id: 't1' }, '2026-10-28', { pairOptions: () => [], hoursFor: () => 1, dayCapacity: () => null }), []);
});

function windowsFor(openDays) {
  const calls = [];
  const fn = (line, date) => {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    calls.push([line, key]);
    return openDays.has(key) ? [new Date(date.getFullYear(), date.getMonth(), date.getDate(), 6), new Date(date.getFullYear(), date.getMonth(), date.getDate(), 22)] : null;
  };
  fn.calls = calls;
  return fn;
}

test('slotFinishFor: an open day finishes at the end of its working window, no walk back', () => {
  const ww = windowsFor(new Set(['2026-10-28']));
  const r = slotFinishFor('M1', '2026-10-28', ww);
  assert.equal(r.day, '2026-10-28');
  assert.equal(r.movedBack, 0);
  assert.equal(r.finish.getTime(), new Date(2026, 9, 28, 22).getTime());
  assert.deepEqual(ww.calls, [['M1', '2026-10-28']]);
});

test('slotFinishFor: a closed day walks back to the latest open window and says how far', () => {
  const ww = windowsFor(new Set(['2026-10-23']));   // Fri open; Sat 24, Sun 25, Mon 26 closed
  const r = slotFinishFor('M1', '2026-10-26', ww);
  assert.equal(r.day, '2026-10-23');
  assert.equal(r.movedBack, 3);
  assert.equal(r.finish.getTime(), new Date(2026, 9, 23, 22).getTime());
  assert.deepEqual(ww.calls.map(c => c[1]), ['2026-10-26', '2026-10-25', '2026-10-24', '2026-10-23']);
});

test('slotFinishFor: gives up after SLOT_LOOKBACK_DAYS; 31 closed days is null, an open window exactly 30 days back is found', () => {
  assert.equal(SLOT_LOOKBACK_DAYS, 30);
  const none = windowsFor(new Set());
  assert.equal(slotFinishFor('M1', '2026-10-28', none), null);
  assert.equal(none.calls.length, 31, 'the target day plus 30 days back');
  const edge = windowsFor(new Set(['2026-09-28']));
  const r = slotFinishFor('M1', '2026-10-28', edge);
  assert.equal(r.movedBack, 30);
  assert.equal(r.day, '2026-09-28');
  assert.equal(slotFinishFor('M1', '2026-10-29', windowsFor(new Set(['2026-09-28']))), null, '31 days back is out of reach');
});

test('slotFinishFor: an empty window or a malformed day is not a slot', () => {
  const empty = (_l, date) => [date, new Date(date.getTime())];
  assert.equal(slotFinishFor('M1', '2026-10-28', empty), null);
  assert.equal(slotFinishFor('M1', 'tomorrow', windowsFor(new Set(['2026-10-28']))), null);
});

test('slotFinishFor: the walk-back crosses a month and a DST change by calendar day, never by 24-hour steps', () => {
  const ww = windowsFor(new Set(['2026-10-31']));
  const r = slotFinishFor('M1', '2026-11-02', ww);
  assert.equal(r.day, '2026-10-31');
  assert.equal(r.movedBack, 2);
  const spring = windowsFor(new Set(['2026-03-07']));
  assert.equal(slotFinishFor('M1', '2026-03-09', spring).day, '2026-03-07', 'across the US spring-forward weekend');
});

function task(over = {}) {
  return {
    id: 't1', MACHINE: 'M1', PRODUCTION_VERSION: '0001', RUN_TIME: 4, start_date: null, end_date: null,
    planning_status: 'needs_planning', MATERIAL_NUMBER: 'MAT1', planning_reason: { code: 'no_fit_found', message: 'm' },
    firmed: false, row_version: 7, 'ORDER_QUANTITY_(GMEIN)': 100, ...over,
  };
}

test('slotTaskKey changes with every field a slot pick depends on, and with nothing else', () => {
  const base = slotTaskKey(task());
  assert.equal(slotTaskKey(task()), base, 'stable for an identical row');
  const changed = {
    MACHINE: 'M2', PRODUCTION_VERSION: '0002', RUN_TIME: 5, start_date: new Date(2026, 9, 28, 6), end_date: new Date(2026, 9, 28, 10),
    planning_status: 'scheduled', MATERIAL_NUMBER: 'MAT2', planning_reason: { code: 'overlong_never', message: 'm' },
    firmed: true, row_version: 8, 'ORDER_QUANTITY_(GMEIN)': 200,
  };
  for (const [field, value] of Object.entries(changed)) {
    assert.notEqual(slotTaskKey(task({ [field]: value })), base, `${field} must change the key`);
  }
  assert.equal(slotTaskKey(task({ text: 'other', ORDER: '99' })), base, 'unrelated fields do not');
  assert.equal(slotTaskKey(task({ planning_reason: { code: 'no_fit_found', message: 'a different message' } })), base, 'only the reason CODE counts');
});

test('defaultSlotDay is the due day, never before the plant today; no due date means today', () => {
  const due = (y, m, d, h = 14) => new Date(y, m, d, h, 0, 0);
  assert.equal(defaultSlotDay(task({ original_end_date: due(2026, 9, 30) }), '2026-10-26'), '2026-10-30');
  assert.equal(defaultSlotDay(task({ original_end_date: due(2026, 9, 20) }), '2026-10-26'), '2026-10-26', 'a past due day falls back to today');
  assert.equal(defaultSlotDay(task({ original_end_date: due(2026, 9, 26) }), '2026-10-26'), '2026-10-26', 'due today is today');
  assert.equal(defaultSlotDay(task({ original_end_date: null }), '2026-10-26'), '2026-10-26');
  assert.equal(defaultSlotDay(task({ original_end_date: due(2026, 9, 30) }), new Date(2026, 9, 26)), '2026-10-30', 'a Date for the plant today is accepted');
});

const tr = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`;
const cand = (over = {}) => ({ value: 'M1', pv: null, machine: 'M1', label: 'M1', needHours: 4, freeHours: 6, capHours: 8, closed: false, fits: true, ...over });

test('formatSlotOption picks the key by state and fills one-decimal hours', () => {
  assert.equal(formatSlotOption(cand(), tr), 'am.slot_option{"pair":"M1","free":"6","cap":"8","need":"4"}');
  assert.equal(formatSlotOption(cand({ needHours: 7.25, freeHours: 4, fits: false }), tr),
    'am.slot_option_short{"pair":"M1","free":"4","cap":"8","need":"7.3","short":"3.3"}');
  assert.equal(formatSlotOption(cand({ closed: true, freeHours: 0, capHours: 0, fits: false }), tr), 'am.slot_option_closed{"pair":"M1"}');
  assert.equal(formatSlotOption(cand({ needHours: null, fits: false }), tr), 'am.slot_option_unknown{"pair":"M1"}');
  assert.equal(formatSlotOption(cand({ freeHours: null, capHours: null, fits: false }), tr), 'am.slot_option_unknown{"pair":"M1"}');
  assert.equal(formatSlotOption(null, tr), 'am.slot_none');
  assert.equal(formatSlotOption(undefined, tr), 'am.slot_none');
});

test('formatSlotOption: the translator is optional (the pane calls it with one argument) and null reads the same text', () => {
  assert.equal(typeof formatSlotOption(cand()), 'string');
  assert.equal(formatSlotOption(null), 'am.slot_none', 'no locale loaded in Node: Util.t answers the key');
});
