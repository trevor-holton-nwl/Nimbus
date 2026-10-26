// Tests for frontend/alert-monitor/alert-slot-modal.mts. Part 1 is the pure exports (ranking, closed-day walk-back,
// task fingerprint, default day, option text); part 2 drives the dialog and place() against a stubbed document,
// the real Store/UndoStack and stubbed Engine / Calendar / Toast / Modal.confirm.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  AlertSlotModal, slotSeams, liveSlotDeps, canPlaceSlot,
  parsePairValue, rankSlotCandidates, slotFinishFor, slotGapFinishFor, slotTaskKey, defaultSlotDay, formatSlotOption, SLOT_LOOKBACK_DAYS,
} from '../../../frontend/alert-monitor/alert-slot-modal.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Util, Modal, Toast } from '../../../frontend/platform/foundation.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { Alerts, Utilization } from '../../../frontend/insights/services.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';

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

/* ---- F1: a "fitting" slot is a real gap between the day's other orders */

const at = (h, m = 0, day = 28) => new Date(2026, 9, day, h, m);
const win28 = () => windowsFor(new Set(['2026-10-28']));   // 06:00 - 22:00

test('slotGapFinishFor: an empty day ends at the window close and counts as a gap', () => {
  const r = slotGapFinishFor('M1', '2026-10-28', 4, win28(), []);
  assert.deepEqual([r.finish.getTime(), r.gapHours, r.viaGap], [at(22).getTime(), 16, true]);
});

test('slotGapFinishFor: the finish is the END of the LATEST free gap that holds the need', () => {
  // gaps: 06-10 (4 h), 11-14 (3 h), 15-18 (3 h); a 4 h need only fits the first, a 3 h need takes the last that fits
  const busy = [[at(10), at(11)], [at(14), at(15)], [at(18), at(22)]];
  const four = slotGapFinishFor('M1', '2026-10-28', 4, win28(), busy);
  assert.deepEqual([four.finish.getTime(), four.gapHours, four.viaGap], [at(10).getTime(), 4, true]);
  const three = slotGapFinishFor('M1', '2026-10-28', 3, win28(), busy);
  assert.deepEqual([three.finish.getTime(), three.gapHours, three.viaGap], [at(18).getTime(), 3, true]);
});

test('slotGapFinishFor: an order is placed before a late bar, not on top of it', () => {
  const r = slotGapFinishFor('M1', '2026-10-28', 4, win28(), [[at(18), at(22)]]);
  assert.deepEqual([r.finish.getTime(), r.gapHours, r.viaGap], [at(18).getTime(), 12, true]);
});

test('slotGapFinishFor: no gap large enough falls back to the window close, not a fit, with the largest gap', () => {
  const r = slotGapFinishFor('M1', '2026-10-28', 4, win28(), [[at(8), at(22)]]);   // only 06-08 (2 h) is free
  assert.deepEqual([r.finish.getTime(), r.gapHours, r.viaGap], [at(22).getTime(), 2, false]);
});

test('slotGapFinishFor: busy intervals outside the window are ignored; a straddling one is clipped', () => {
  const outside = [[at(0), at(5)], [at(23), at(2, 0, 29)], [at(1, 0, 27), at(23, 0, 27)]];
  const a = slotGapFinishFor('M1', '2026-10-28', 4, win28(), outside);
  assert.deepEqual([a.finish.getTime(), a.gapHours, a.viaGap], [at(22).getTime(), 16, true]);
  const b = slotGapFinishFor('M1', '2026-10-28', 4, win28(), [[at(4), at(8)]]);   // clipped to 06-08: gap 08-22
  assert.deepEqual([b.finish.getTime(), b.gapHours, b.viaGap], [at(22).getTime(), 14, true]);
});

test('slotGapFinishFor: overlapping busy intervals merge; a bar spanning the whole window leaves no gap', () => {
  const merged = slotGapFinishFor('M1', '2026-10-28', 4, win28(), [[at(10), at(15)], [at(12), at(18)], [at(9), at(10)]]);
  assert.deepEqual([merged.finish.getTime(), merged.viaGap], [at(22).getTime(), true], 'gap 18-22 is exactly 4 h');
  const whole = slotGapFinishFor('M1', '2026-10-28', 4, win28(), [[at(5), at(23)]]);
  assert.deepEqual([whole.finish.getTime(), whole.gapHours, whole.viaGap], [at(22).getTime(), 0, false]);
});

test('slotGapFinishFor: an unknown need is never a fit; a closed day or an empty window is null', () => {
  const r = slotGapFinishFor('M1', '2026-10-28', null, win28(), []);
  assert.deepEqual([r.finish.getTime(), r.viaGap], [at(22).getTime(), false]);
  assert.equal(slotGapFinishFor('M1', '2026-10-28', 4, windowsFor(new Set()), []), null);
});

test('slotGapFinishFor: on the plant today the window starts at now, so time already gone is not free', () => {
  const r = slotGapFinishFor('M1', '2026-10-28', 10, win28(), [], at(14));   // 14-22 = 8 h, short of 10
  assert.deepEqual([r.finish.getTime(), r.gapHours, r.viaGap], [at(22).getTime(), 8, false]);
  const ok = slotGapFinishFor('M1', '2026-10-28', 8, win28(), [], at(14));
  assert.deepEqual([ok.gapHours, ok.viaGap], [8, true]);
  assert.equal(slotGapFinishFor('M1', '2026-10-28', 1, win28(), [], at(22, 30)), null, 'nothing left today');
  const before = slotGapFinishFor('M1', '2026-10-28', 4, win28(), [], at(3));
  assert.equal(before.gapHours, 16, 'now before the window opens clamps nothing');
  const otherDay = slotGapFinishFor('M1', '2026-10-28', 4, win28(), [], at(14, 0, 27));
  assert.equal(otherDay.gapHours, 16, 'now on a different day clamps nothing');
});

test('slotFinishFor: with a need and busy intervals it lands on the gap of the day it ends up on', () => {
  const r = slotFinishFor('M1', '2026-10-28', win28(), undefined, { needHours: 4, busy: () => [[at(18), at(22)]] });
  assert.deepEqual([r.finish.getTime(), r.day, r.movedBack, r.viaGap, r.gapHours], [at(18).getTime(), '2026-10-28', 0, true, 12]);
  // walk-back: the 28th is closed, the gap search runs on the 27th (asked for that day only)
  const asked = [];
  const ww = windowsFor(new Set(['2026-10-27']));
  const back = slotFinishFor('M1', '2026-10-28', ww, undefined, { needHours: 4, busy: (_m, day) => { asked.push(day); return [[at(16, 0, 27), at(22, 0, 27)]]; } });
  assert.deepEqual([back.finish.getTime(), back.day, back.movedBack], [at(16, 0, 27).getTime(), '2026-10-27', 1]);
  assert.deepEqual(asked, ['2026-10-27']);
  const noNeed = slotFinishFor('M1', '2026-10-28', win28(), undefined, { needHours: null, busy: () => [[at(18), at(22)]] });
  assert.deepEqual([noNeed.finish.getTime(), noNeed.viaGap], [at(22).getTime(), false]);
});

/* ---- F4: a fully blacked-out day is skipped like a closed day; F2: never walk back into the past */

test('slotFinishFor: isClosed skips a blacked-out day even when it has a nominal window', () => {
  const ww = windowsFor(new Set(['2026-10-28', '2026-10-27']));
  const seen = [];
  const r = slotFinishFor('M1', '2026-10-28', ww, (machine, day) => { seen.push([machine, day]); return day === '2026-10-28'; });
  assert.deepEqual([r.day, r.movedBack, r.finish.getTime()], ['2026-10-27', 1, at(22, 0, 27).getTime()]);
  assert.deepEqual(seen, [['M1', '2026-10-28'], ['M1', '2026-10-27']]);
  assert.equal(slotFinishFor('M1', '2026-10-28', ww, () => true), null, 'every day blacked out');
});

test('slotFinishFor: floorDay stops the walk-back at the plant today, and now empties today', () => {
  const ww = windowsFor(new Set(['2026-10-27']));
  assert.equal(slotFinishFor('M1', '2026-10-28', ww, undefined, { floorDay: '2026-10-28' }), null, 'yesterday is in the past');
  assert.equal(slotFinishFor('M1', '2026-10-28', windowsFor(new Set(['2026-10-28', '2026-10-27'])), undefined, { floorDay: '2026-10-28', now: at(23) }), null,
    'today has nothing left and the walk-back must not go earlier');
  const r = slotFinishFor('M1', '2026-10-28', windowsFor(new Set(['2026-10-28', '2026-10-27'])), undefined, { floorDay: '2026-10-27', now: at(23) });
  assert.equal(r.day, '2026-10-27', 'a floor one day earlier allows it');
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

/* ---------------------------------------------------------------- part 2: the dialog and place() */

function makeEl(id) {
  const handlers = {};
  return {
    id, _html: '', handlers, textContent: '', hidden: false, value: '', checked: false, disabled: false, dataset: {}, title: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { (this.attrs ??= {})[k] = v; }, removeAttribute() {}, addEventListener(type, fn) { handlers[type] = fn; }, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; }, focus() {}, blur() {}, style: {},
  };
}

const prior = {};
let els;
let calls;
let capByDay;          // day -> machine -> { free, cap, closed }
let confirmAnswer;     // what the stubbed Modal.confirm resolves
let beforeConfirm;     // optional hook run inside the stubbed Modal.confirm
let openDays;          // set of day keys the stubbed work window is open on
let patchFor;          // (cur, machine, finish, opts) -> patch | null

const writesOf = () => calls.events.filter(e => e.type === 'task:update' || e.type === 'tasks:bulkUpdate');
const firmsOf = () => calls.events.filter(e => e.type === 'firmed:change');

function seedTask(over = {}) {
  Store.setTasks([{
    id: 't1', ORDER: '1001', text: '1001', MACHINE: 'M1', PLANT: 'P1', PRODUCTION_VERSION: '0001', RUN_TIME: 4,
    MATERIAL_NUMBER: 'MAT1', 'ORDER_QUANTITY_(GMEIN)': 100, planning_status: 'needs_planning',
    planning_reason: { code: 'no_fit_found', message: 'No slot found' }, start_date: null, end_date: null,
    original_end_date: new Date(2026, 9, 28, 14), firmed: false, row_version: 3, ...over,
  }], 'test');
}

beforeEach(() => {
  els = {};
  calls = { toast: [], closed: [], confirm: [], goto: [], recompute: 0, patch: [], events: [], restored: [], sub: null };
  confirmAnswer = true; beforeConfirm = null;
  openDays = new Set(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-27', '2026-10-26', '2026-10-23']);
  capByDay = {
    '2026-10-28': { M1: { free: 3, cap: 8, closed: false }, M2: { free: 9, cap: 10, closed: false }, M3: { free: 6, cap: 8, closed: false } },
    '2026-10-29': { M1: { free: 9, cap: 10, closed: false }, M2: { free: 2, cap: 8, closed: false }, M3: { free: 6, cap: 8, closed: false } },
  };
  patchFor = (cur, machine, finish) => ({ start_date: new Date(finish.getTime() - 4 * 3600e3), end_date: finish, MACHINE: machine, RUN_TIME: 4 });
  prior.doc = globalThis.document; prior.today = Util.plantToday;
  prior.open = Modal.open; prior.close = Modal.close; prior.confirm = Modal.confirm; prior.toast = Toast.show;
  prior.manual = Engine.manualRoutingSchedulePatchFor; prior.pair = Engine.pairSchedulePatchFor; prior.overtime = Engine.confirmOvertimePlacement;
  prior.recompute = Alerts.scheduleRecompute; prior.restore = UndoStack.restoreTasks;
  prior.seams = { ...slotSeams }; prior.deps = { ...liveSlotDeps }; prior.active = Sandbox.active;
  globalThis.document = {
    getElementById(id) { return (els[id] ??= makeEl(id)); }, createElement() { return makeEl('created'); },
    querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {}, activeElement: null,
  };
  Util.plantToday = () => new Date(2026, 9, 26);
  Modal.open = id => { els[id] ??= makeEl(id); els[id].hidden = false; };
  Modal.close = id => { calls.closed.push(id); if (els[id]) els[id].hidden = true; };
  Modal.confirm = async o => { calls.confirm.push(o); if (beforeConfirm) beforeConfirm(); return confirmAnswer; };
  Toast.show = (msg, type) => { calls.toast.push([msg, type]); };
  Alerts.scheduleRecompute = () => { calls.recompute++; };
  UndoStack.restoreTasks = snap => { calls.restored.push(snap); };
  Engine.manualRoutingSchedulePatchFor = (cur, machine, finish, opts) => { calls.patch.push(['manual', cur.id, machine, finish, opts]); return patchFor(cur, machine, finish, opts); };
  Engine.pairSchedulePatchFor = (cur, pv, machine, finish, opts) => { calls.patch.push(['pair', cur.id, pv, machine, finish, opts]); return patchFor(cur, machine, finish, opts); };
  Engine.lastManualRefusal = null;
  slotSeams.signedIn = () => true;
  slotSeams.routingPlant = () => false;
  slotSeams.workWindow = (_line, date) => {
    const key = Util.dayKey(date);
    return openDays.has(key) ? [new Date(date.getFullYear(), date.getMonth(), date.getDate(), 6), new Date(date.getFullYear(), date.getMonth(), date.getDate(), 22)] : null;
  };
  slotSeams.nim = () => ({ Timeline: { gotoLineDay: (...a) => calls.goto.push(a) } });
  slotSeams.plantNow = () => null;
  slotSeams.dayClosed = () => false;
  liveSlotDeps.busyIntervals = () => [];
  liveSlotDeps.pairOptions = () => ['M1', 'M2', 'M3'].map(m => ({ value: m, label: m }));
  liveSlotDeps.hoursFor = () => 4;
  liveSlotDeps.dayCapacity = (machine, day) => capByDay[day]?.[machine] ?? null;
  liveSlotDeps.resolveStep = undefined;
  Sandbox.active = false;
  UndoStack._entries.length = 0;
  Store.setSelectedPlant('P1', 'test');
  seedTask();
  calls.sub = e => calls.events.push(e);
  Store.subscribe(calls.sub, 'slot-test');
});

afterEach(() => {
  AlertSlotModal.close();
  Store._listeners.delete(calls.sub);
  globalThis.document = prior.doc; Util.plantToday = prior.today;
  Modal.open = prior.open; Modal.close = prior.close; Modal.confirm = prior.confirm; Toast.show = prior.toast;
  Engine.manualRoutingSchedulePatchFor = prior.manual; Engine.pairSchedulePatchFor = prior.pair; Engine.confirmOvertimePlacement = prior.overtime;
  Alerts.scheduleRecompute = prior.recompute; UndoStack.restoreTasks = prior.restore;
  Object.assign(slotSeams, prior.seams); Object.assign(liveSlotDeps, prior.deps); Sandbox.active = prior.active;
  delete globalThis.flatpickr;
  UndoStack._entries.length = 0;
});

const openIt = () => AlertSlotModal.open({ plant: 'P1', taskId: 't1', alertId: 'needs-planning-t1' });
const optionOrder = () => [...els['asl-pair'].innerHTML.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
const pick = value => { els['asl-pair'].value = value; els['asl-body'].handlers.change?.({ target: els['asl-pair'] }); };

test('open renders the order, the reason, the due day and the ranked pairs with the best one preselected', () => {
  openIt();
  assert.equal(els['modal-alert-slot'].hidden, false);
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
  assert.equal(AlertSlotModal.isOpenFor('P2'), false);
  const body = els['asl-body'].innerHTML;
  assert.match(body, /1001/);
  assert.match(body, /M1/);
  assert.match(body, /No slot found/, 'the reason text');
  assert.match(body, /id="asl-day"/);
  assert.match(body, /id="asl-pair"/);
  assert.match(body, /am\.slot_hint/);
  assert.equal(els['asl-day'].value, '2026-10-28', 'the due day');
  assert.deepEqual(optionOrder(), ['M2', 'M3', 'M1'], 'most free hours first: M2 9, M3 6, M1 3 (3 free is short of 4)');
  assert.equal(els['asl-pair'].value, 'M2', 'the top pair is preselected');
  assert.match(els['asl-pair'].innerHTML, /am\.slot_option/);
  assert.match(els['asl-foot'].innerHTML, /btn\.cancel/);
  assert.match(els['asl-foot'].innerHTML, /id="asl-place"/);
  assert.match(els['asl-foot'].innerHTML, /am\.slot_place/);
  assert.doesNotMatch(els['asl-foot'].innerHTML, /id="asl-place"[^>]*disabled/);
});

test('open with Place not allowed (What-If or signed out) renders it disabled with the What-If hint, and place() writes nothing', async () => {
  Sandbox.active = true;
  assert.equal(canPlaceSlot(), false);
  openIt();
  assert.match(els['asl-foot'].innerHTML, /id="asl-place"[^>]*disabled[^>]*title="am\.whatif_blocked"/);
  await AlertSlotModal.place();
  assert.equal(calls.patch.length, 0);
  assert.equal(writesOf().length, 0);
  assert.deepEqual(calls.toast.at(-1), ['am.whatif_blocked', 'warn']);
  Sandbox.active = false;
  slotSeams.signedIn = () => false;
  assert.equal(canPlaceSlot(), false);
  slotSeams.signedIn = () => true;
  assert.equal(canPlaceSlot(), true);
});

test('open with no eligible pair shows the none text, disables the list and Place', () => {
  liveSlotDeps.pairOptions = () => [];
  openIt();
  assert.match(els['asl-pair'].innerHTML, /am\.slot_none/);
  assert.match(els['asl-pair'].innerHTML, /<option value=""/);
  assert.equal(els['asl-pair'].disabled, true);
  assert.match(els['asl-foot'].innerHTML, /id="asl-place"[^>]*disabled/);
});

test('open ignores a missing plant or task', () => {
  AlertSlotModal.open({ plant: '', taskId: 't1' });
  AlertSlotModal.open({ plant: 'P1', taskId: 'nope' });
  assert.equal(AlertSlotModal.isOpenFor('P1'), false);
  assert.equal(els['modal-alert-slot']?.hidden ?? true, true);
});

test('the date picker starts at the plant today, and picking a day re-ranks', () => {
  const seen = [];
  globalThis.flatpickr = (el, opts) => { seen.push(opts); return { altInput: null, destroy() {}, setDate() {} }; };
  openIt();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].minDate, '2026-10-26', 'the plant today, not the browser today');
  assert.equal(seen[0].dateFormat, 'Y-m-d');
  els['asl-day'].value = '2026-10-29';
  seen[0].onChange();
  assert.deepEqual(optionOrder(), ['M1', 'M3', 'M2'], 'the day change re-ranked');
});

test('rerank: a day change re-sorts and re-preselects; a manual pick survives while it is still listed', () => {
  openIt();
  assert.equal(els['asl-pair'].value, 'M2');
  els['asl-day'].value = '2026-10-29';
  AlertSlotModal.rerank();
  assert.deepEqual(optionOrder(), ['M1', 'M3', 'M2']);
  assert.equal(els['asl-pair'].value, 'M1', 'no manual pick yet: the new top is preselected');
  pick('M3');
  els['asl-day'].value = '2026-10-28';
  AlertSlotModal.rerank();
  assert.deepEqual(optionOrder(), ['M2', 'M3', 'M1']);
  assert.equal(els['asl-pair'].value, 'M3', 'the planner picked M3: it stays selected');
});

test('rerank ignores a malformed or past day and puts the input back', () => {
  openIt();
  els['asl-day'].value = 'soon';
  AlertSlotModal.rerank();
  assert.equal(els['asl-day'].value, '2026-10-28');
  els['asl-day'].value = '2026-10-20';   // before the plant today (Oct 26)
  AlertSlotModal.rerank();
  assert.equal(els['asl-day'].value, '2026-10-28');
  assert.deepEqual(optionOrder(), ['M2', 'M3', 'M1']);
});

test('place happy path: one finish-anchored patch, firm and undo in one step, recompute, toast, close, Go To', async () => {
  openIt();
  await AlertSlotModal.place();
  assert.equal(calls.patch.length, 1);
  const [kind, id, machine, finish, opts] = calls.patch[0];
  assert.deepEqual([kind, id, machine], ['manual', 't1', 'M2'], 'a plant without routing: the bare-machine path');
  assert.equal(finish.getTime(), new Date(2026, 9, 28, 22).getTime(), 'the end of the day working window');
  assert.deepEqual(opts, { quiet: true });
  assert.equal(calls.confirm.length, 0, 'it fits, nothing to confirm');
  const writes = writesOf();
  assert.equal(writes.length, 1, 'one patch write');
  assert.equal(writes[0].source, 'alerts');
  const live = Store.tasks.t1;
  assert.equal(live.MACHINE, 'M2');
  assert.equal(live.planning_status, 'scheduled', 'the both-dates rule releases the queue');
  const firms = firmsOf();
  assert.equal(firms.length, 1, 'one firm write');
  assert.equal(firms[0].source, 'alerts');
  assert.equal(firms[0].firmed, true);
  assert.equal(Store.isFirmed('t1'), true);
  assert.equal(UndoStack._entries.length, 1, 'one undo entry');
  assert.deepEqual(UndoStack._entries[0].ids, ['t1']);
  assert.equal(UndoStack._entries[0].label, 'am.slot_undo');
  assert.equal(calls.recompute, 1);
  assert.deepEqual(calls.toast.at(-1), ['am.slot_placed', 'success']);
  assert.deepEqual(calls.closed, ['modal-alert-slot']);
  assert.equal(AlertSlotModal.isOpenFor('P1'), false);
  assert.equal(calls.goto.length, 1);
  assert.deepEqual(calls.goto[0], ['M2', '2026-10-28', undefined, { taskId: 't1' }]);
});

test('undo restores the snapshot and unfirms; an order that was already firmed stays firmed and is not re-firmed', async () => {
  openIt();
  await AlertSlotModal.place();
  UndoStack._entries[0].undoFn();
  assert.equal(calls.restored.length, 1);
  assert.equal(calls.restored[0][0].id, 't1');
  assert.equal(calls.restored[0][0].planning_status, 'needs_planning', 'the snapshot is the queued row');
  assert.equal(Store.isFirmed('t1'), false);
  const unfirm = firmsOf().at(-1);
  assert.deepEqual([unfirm.firmed, unfirm.source], [false, 'undo']);

  AlertSlotModal.close(); calls.events.length = 0; UndoStack._entries.length = 0; calls.restored.length = 0;
  seedTask({ firmed: true });
  calls.events.length = 0;
  assert.equal(Store.isFirmed('t1'), true);
  openIt();
  await AlertSlotModal.place();
  assert.equal(firmsOf().length, 0, 'no firm write for an order that is already firmed');
  UndoStack._entries[0].undoFn();
  assert.equal(firmsOf().length, 0, 'and undo does not unfirm it');
  assert.equal(Store.isFirmed('t1'), true);
});

test('a routing pair goes through pairSchedulePatchFor with the chosen production version', async () => {
  liveSlotDeps.pairOptions = () => [{ value: '0002|M2', label: '0002 - M2' }];
  openIt();
  await AlertSlotModal.place();
  assert.equal(calls.patch.length, 1);
  assert.deepEqual(calls.patch[0].slice(0, 4), ['pair', 't1', '0002', 'M2']);
  assert.deepEqual(calls.patch[0][5], { quiet: true });
  assert.deepEqual(calls.goto[0], ['M2', '2026-10-28', undefined, { taskId: 't1' }]);
});

test('a short day asks first; Cancel writes nothing and keeps the dialog open', async () => {
  openIt();
  pick('M1');   // 3 free of 8, needs 4
  confirmAnswer = false;
  await AlertSlotModal.place();
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.confirm[0].tone, 'warn');
  assert.equal(calls.confirm[0].title, 'am.slot_confirm_title');
  assert.equal(calls.confirm[0].message, 'am.slot_confirm_short');
  assert.equal(calls.confirm[0].confirmLabel, 'am.slot_confirm_place');
  assert.equal(calls.patch.length, 0);
  assert.equal(writesOf().length, 0);
  assert.equal(UndoStack._entries.length, 0);
  assert.equal(Store.isFirmed('t1'), false);
  assert.deepEqual(calls.closed, []);
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
  confirmAnswer = true;
  await AlertSlotModal.place();
  assert.equal(calls.patch.length, 1, 'confirming places it');
  assert.equal(calls.patch[0][2], 'M1');
});

test('an unknown run time also asks first', async () => {
  liveSlotDeps.hoursFor = () => null;
  openIt();
  await AlertSlotModal.place();
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.confirm[0].message, 'am.slot_confirm_short');
});

test('a closed day confirms the move and places at the previous window end', async () => {
  openDays.delete('2026-10-28');   // Wed closed; Tue the 27th is open
  capByDay['2026-10-28'].M2 = { free: 0, cap: 0, closed: true };
  liveSlotDeps.pairOptions = () => [{ value: 'M2', label: 'M2' }];
  openIt();
  await AlertSlotModal.place();
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.confirm[0].message, 'am.slot_confirm_closed');
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.patch[0][3].getTime(), new Date(2026, 9, 27, 22).getTime(), 'the end of the previous open day, not the closed one');
  assert.deepEqual(calls.goto[0].slice(0, 2), ['M2', '2026-10-27']);
});

test('no open window within 30 days toasts and stays open', async () => {
  openDays.clear();
  openIt();
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['am.slot_no_window', 'warn']);
  assert.equal(calls.patch.length, 0);
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
});

test('an engine refusal explains itself and stays open with nothing written', async () => {
  patchFor = () => { Engine.lastManualRefusal = 'finish_cannot_hold'; return null; };
  openIt();
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['toast.finish_cannot_hold', 'warn']);
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
  assert.equal(UndoStack._entries.length, 0);
  assert.equal(Store.tasks.t1.planning_status, 'needs_planning');
  assert.equal(Store.isFirmed('t1'), false);
  assert.equal(calls.recompute, 0);

  patchFor = () => { Engine.lastManualRefusal = 'run_time_zero'; return null; };
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['toast.manual_refusal_generic', 'error']);

  // No recorded refusal and a non-routing plant: the generic wording, never a pair message.
  patchFor = () => { Engine.lastManualRefusal = null; return null; };
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['toast.manual_refusal_generic', 'error']);
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
});

test('a null return with no recorded refusal on a routing plant says why: pair, or machine only for a bare machine or an empty PV', async () => {
  slotSeams.routingPlant = () => true;
  patchFor = () => { Engine.lastManualRefusal = null; return null; };
  liveSlotDeps.pairOptions = () => [{ value: '0002|M2', label: '0002 - M2' }];
  openIt();
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['toast.pv_machine_ineligible', 'warn'], 'a routing pair that no longer resolves');
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);

  // A routing-plant sub-order offers a bare machine: still a routing failure, machine-only wording.
  liveSlotDeps.pairOptions = () => [{ value: 'M2', label: 'M2' }];
  AlertSlotModal.close(); openIt();
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['toast.no_routing_at_workcenter', 'warn']);

  // An empty PV half goes down the manual path (like null) and is worded like a bare machine, not as pair "—".
  liveSlotDeps.pairOptions = () => [{ value: '|M2', label: '- M2' }];
  AlertSlotModal.close(); openIt();
  await AlertSlotModal.place();
  assert.deepEqual(calls.patch.at(-1).slice(0, 3), ['manual', 't1', 'M2']);
  assert.deepEqual(calls.toast.at(-1), ['toast.no_routing_at_workcenter', 'warn']);
});

test('What-If starting while the confirm is open toasts the blocked hint, writes nothing and keeps the dialog open', async () => {
  openIt();
  pick('M1');   // short: asks first
  beforeConfirm = () => { Sandbox.active = true; };
  await AlertSlotModal.place();
  assert.equal(calls.confirm.length, 1);
  assert.deepEqual(calls.toast.at(-1), ['am.whatif_blocked', 'warn']);
  assert.equal(calls.patch.length, 0);
  assert.equal(writesOf().length, 0);
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
});

/* ---------------------------------------------------------------- live deps */

test('liveSlotDeps.dayCapacity reads the 1-day matrix cell: free = max(0, effective - scheduled), closed = capacity <= 0, a missing row is null', () => {
  const real = Utilization.computeMatrix;
  const seen = [];
  Utilization.computeMatrix = (start, days) => {
    seen.push([start, days]);
    return {
      M1: { '2026-10-28': { scheduled: 3, capacity: 8, effectiveCapacity: 7 }, '2026-10-29': { scheduled: 9, capacity: 8, effectiveCapacity: 7 } },
      M2: { '2026-10-28': { scheduled: 0, capacity: 0, effectiveCapacity: 0 } },
    };
  };
  try {
    const dayCapacity = prior.deps.dayCapacity;
    assert.deepEqual(dayCapacity('M1', '2026-10-28'), { free: 4, cap: 7, closed: false });
    assert.deepEqual(dayCapacity('M1', '2026-10-29'), { free: 0, cap: 7, closed: false }, 'over-booked: free never goes negative');
    assert.deepEqual(dayCapacity('M2', '2026-10-28'), { free: 0, cap: 0, closed: true });
    assert.equal(dayCapacity('M3', '2026-10-28'), null, 'a machine absent from the matrix');
    assert.equal(dayCapacity('M1', '2026-11-30'), null, 'a day absent from the matrix');
    assert.equal(dayCapacity('M1', 'not-a-day'), null);
    assert.equal(seen[0][1], 1, 'a 1-day window');
    assert.equal(seen[0][0].getTime(), new Date(2026, 9, 28).getTime(), 'local midnight of the day');
    const firstDay = seen.filter(s => s[0].getTime() === new Date(2026, 9, 28).getTime()).length;
    assert.equal(firstDay, 1, 'one compute per (plant, data revision, day): the memo serves the other machines');
  } finally { Utilization.computeMatrix = real; }
});

test('liveSlotDeps.pairOptions: the Orders grid list when bridged, the plant lines without it, and never an ineligible routing pair', () => {
  const realLines = Store.linesForSelectedPlant;
  const realResolve = Runtime.resolve;
  Store.linesForSelectedPlant = () => ['L1', 'L2'];
  Runtime.resolve = (row, machine) => (row.PRODUCTION_VERSION === '0001' && machine === 'M1' ? { ok: true, hours: 2 } : { ok: false, step: 'pv_expired' });
  try {
    const pairOptions = prior.deps.pairOptions;
    slotSeams.nim = () => ({});
    assert.deepEqual(pairOptions(Store.tasks.t1), [{ value: 'L1', label: 'L1' }, { value: 'L2', label: 'L2' }], 'no bridge: the plant line list');
    slotSeams.nim = () => ({ Table: { _getPairOptions: () => [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }] } });
    assert.deepEqual(pairOptions(Store.tasks.t1).map(o => o.value), ['A', 'B'], 'the grid list, bare machines kept as they are');
    slotSeams.nim = () => ({ Table: { _getPairOptions: () => [
      { value: '0009|M9', label: 'current, not eligible' },   // what _getPairOptions prepends for an ineligible current pair
      { value: '0001|M1', label: '0001 - M1' },
    ] } });
    assert.deepEqual(pairOptions(Store.tasks.t1).map(o => o.value), ['0001|M1'], 'the ineligible current pair is dropped from a mixed list');
  } finally { Store.linesForSelectedPlant = realLines; Runtime.resolve = realResolve; }
});

test('suggest: an ineligible current pair never leads, and with no eligible pair the suggestion is null', () => {
  const realResolve = Runtime.resolve;
  Runtime.resolve = (row, machine) => (row.PRODUCTION_VERSION === '0001' && machine === 'M1' ? { ok: true, hours: 2 } : { ok: false, step: 'pv_expired' });
  try {
    liveSlotDeps.pairOptions = prior.deps.pairOptions;
    capByDay['2026-10-28'] = { M1: { free: 1, cap: 8, closed: false }, M9: { free: 9, cap: 10, closed: false } };   // M9 has the most free hours
    slotSeams.nim = () => ({ Table: { _getPairOptions: () => [{ value: '0009|M9', label: 'current, not eligible' }] } });
    assert.equal(AlertSlotModal.suggest(Store.tasks.t1, 'P1'), null, 'the only option is the ineligible current pair');
    Store.updateTask('t1', { text: 'x' }, 'test');   // new data revision: no memo hit
    slotSeams.nim = () => ({ Table: { _getPairOptions: () => [
      { value: '0009|M9', label: 'current, not eligible' }, { value: '0001|M1', label: '0001 - M1' },
    ] } });
    const top = AlertSlotModal.suggest(Store.tasks.t1, 'P1');
    assert.equal(top.value, '0001|M1', 'the eligible pair wins even though M9 has more free hours');
    openIt();
    assert.deepEqual(optionOrder(), ['0001|M1'], 'and the dialog does not list the ineligible pair either');
  } finally { Runtime.resolve = realResolve; }
});

test('liveSlotDeps.hoursFor: Runtime.resolve for a routing pair, the order run time for a bare machine; resolveStep names the failing step', () => {
  const realResolve = Runtime.resolve;
  const asked = [];
  Runtime.resolve = (row, machine) => {
    asked.push([row.PRODUCTION_VERSION, machine]);
    return row.PRODUCTION_VERSION === '0001' ? { ok: true, hours: 2.5 } : { ok: false, step: 'pv_expired' };
  };
  try {
    const { hoursFor, resolveStep } = prior.deps;
    const live = Store.tasks.t1;   // RUN_TIME 4
    assert.equal(hoursFor(live, null, 'M1'), 4, 'no pair: the order own run time');
    assert.equal(asked.length, 0, 'and the rate map is not consulted');
    assert.equal(hoursFor({ ...live, RUN_TIME: 0 }, null, 'M1'), null, 'no run time is unknown');
    assert.equal(hoursFor(live, '0001', 'M2'), 2.5, 'a routing pair: what it resolves to, not RUN_TIME');
    assert.deepEqual(asked.at(-1), ['0001', 'M2']);
    assert.equal(hoursFor(live, '0002', 'M2'), null);
    assert.equal(resolveStep(live, '0002', 'M2'), 'pv_expired');
    assert.equal(resolveStep(live, '0001', 'M2'), undefined);
    assert.equal(resolveStep(live, null, 'M2'), undefined);
  } finally { Runtime.resolve = realResolve; }
});

test('a patch without both dates is a refusal, not a write', async () => {
  patchFor = () => ({ MACHINE: 'M2' });
  openIt();
  await AlertSlotModal.place();
  assert.equal(UndoStack._entries.length, 0);
  assert.equal(Store.tasks.t1.MACHINE, 'M1');
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
});

test('a task that changed while the dialog was open aborts with the stale toast and closes', async () => {
  openIt();
  Store.updateTask('t1', { RUN_TIME: 9 }, 'test');
  calls.events.length = 0;
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['am.slot_stale', 'warn']);
  assert.deepEqual(calls.closed, ['modal-alert-slot']);
  assert.equal(calls.patch.length, 0);
  assert.equal(writesOf().length, 0);
});

test('a task that changed while the confirm was open also aborts (the staleness check runs again after the await)', async () => {
  openIt();
  pick('M1');   // short: asks first
  beforeConfirm = () => Store.updateTask('t1', { RUN_TIME: 9 }, 'test');
  await AlertSlotModal.place();
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.patch.length, 0, 'the engine was never asked');
  assert.deepEqual(calls.toast.at(-1), ['am.slot_stale', 'warn']);
  assert.deepEqual(calls.closed, ['modal-alert-slot']);
  assert.equal(UndoStack._entries.length, 0);
  assert.equal(Store.isFirmed('t1'), false);
});

test('a task that vanished while the dialog was open aborts the same way', async () => {
  openIt();
  Store.setTasks([], 'test');
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['am.slot_stale', 'warn']);
  assert.equal(AlertSlotModal.isOpenFor('P1'), false);
});

test('closing while the confirm is open (a plant change) abandons the placement', async () => {
  openIt();
  pick('M1');
  beforeConfirm = () => Store.setSelectedPlant('P2', 'test');
  await AlertSlotModal.place();
  assert.equal(calls.patch.length, 0);
  assert.equal(AlertSlotModal.isOpenFor('P1'), false);
});

test('a second place() while the first is awaiting its confirm is ignored', async () => {
  openIt();
  pick('M1');
  let release;
  Modal.confirm = o => { calls.confirm.push(o); return new Promise(r => { release = r; }); };
  const first = AlertSlotModal.place();
  await AlertSlotModal.place();
  assert.equal(calls.confirm.length, 1);
  release(true);
  await first;
  assert.equal(calls.patch.length, 1);
});

test('a plant change closes the dialog; the same plant does not', () => {
  openIt();
  Store.setSelectedPlant('P1', 'test');
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
  Store.setSelectedPlant('P2', 'test');
  assert.equal(AlertSlotModal.isOpenFor('P1'), false);
  assert.deepEqual(calls.closed, ['modal-alert-slot']);
});

test('Escape and the Cancel / close buttons close the dialog', () => {
  openIt();
  els['modal-alert-slot'].handlers.keydown({ key: 'Escape', defaultPrevented: false });
  assert.equal(AlertSlotModal.isOpenFor('P1'), false);
  openIt();
  els['asl-foot'].handlers.click({ target: { closest: () => ({ dataset: { aslAct: 'cancel' } }) } });
  assert.equal(AlertSlotModal.isOpenFor('P1'), false);
  openIt();
  els['asl-close'].handlers.click();
  assert.equal(AlertSlotModal.isOpenFor('P1'), false);
  openIt();
  els['modal-alert-slot'].handlers.keydown({ key: 'Escape', defaultPrevented: true });
  assert.equal(AlertSlotModal.isOpenFor('P1'), true, 'an Escape another layer already handled (the confirm) is left alone');
});

test('the Place button runs place()', async () => {
  openIt();
  els['asl-foot'].handlers.click({ target: { closest: () => ({ dataset: { aslAct: 'place' } }) } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.patch.length, 1);
});

test('suggest returns the top candidate for the default day, synchronously, memoised per task and data revision', () => {
  let reads = 0;
  const original = liveSlotDeps.pairOptions;
  liveSlotDeps.pairOptions = row => { reads++; return original(row); };
  const live = Store.tasks.t1;
  const top = AlertSlotModal.suggest(live, 'P1');
  assert.equal(top.machine, 'M2');
  assert.equal(top.fits, true);
  assert.equal(reads, 1);
  assert.equal(AlertSlotModal.suggest(live, 'P1'), top, 'memo hit: the same object, no second read');
  assert.equal(reads, 1);
  Store.updateTask('t1', { text: 'edited' }, 'test');   // any data change moves Store.dataRev()
  const again = AlertSlotModal.suggest(Store.tasks.t1, 'P1');
  assert.equal(reads, 2, 'a new data revision recomputes');
  assert.equal(again.machine, 'M2');
});

test('suggest memo is cleared on plant:selected, and a task with no eligible pair suggests null (memoised too)', () => {
  let reads = 0;
  const original = liveSlotDeps.pairOptions;
  liveSlotDeps.pairOptions = row => { reads++; return original(row); };
  AlertSlotModal.suggest(Store.tasks.t1, 'P1');
  assert.equal(reads, 1);
  // A plant switch bumps dataRev on its own, so pin the revision by reading the memo through a switch that
  // returns to the same plant: the cleared memo is what forces the second read, not the revision.
  const revBefore = Store.dataRev();
  const realDataRev = Store.dataRev;
  Store.dataRev = () => revBefore;
  const t1 = Store.tasks.t1;
  try {
    assert.equal(AlertSlotModal.suggest(t1, 'P1').machine, 'M2');
    assert.equal(reads, 1, 'same revision: a memo hit');
    Store.setSelectedPlant('P2', 'test');
    Store.setSelectedPlant('P1', 'test');
    AlertSlotModal.suggest(t1, 'P1');
    assert.equal(reads, 2, 'the memo was cleared by plant:selected');
  } finally { Store.dataRev = realDataRev; }
  Store.setSelectedPlant('P1', 'test');
  if (!Store.tasks.t1) seedTask();
  liveSlotDeps.pairOptions = () => { reads++; return []; };
  Store.updateTask('t1', { text: 'x' }, 'test');
  const none = AlertSlotModal.suggest(Store.tasks.t1, 'P1');
  assert.equal(none, null);
  const n = reads;
  assert.equal(AlertSlotModal.suggest(Store.tasks.t1, 'P1'), null);
  assert.equal(reads, n, 'null is memoised as well');
  assert.equal(formatSlotOption(none, tr), 'am.slot_none');
});

test('suggest uses the due day when it is ahead of today and today when the due day is past', () => {
  const days = [];
  liveSlotDeps.dayCapacity = (machine, day) => { days.push(day); return capByDay['2026-10-28'][machine]; };
  AlertSlotModal.suggest(Store.tasks.t1, 'P1');
  assert.ok(days.length && days.every(d => d === '2026-10-28'));
  seedTask({ original_end_date: new Date(2026, 9, 20, 14) });
  days.length = 0;
  AlertSlotModal.suggest(Store.tasks.t1, 'P1');
  assert.ok(days.length && days.every(d => d === '2026-10-26'), 'a past due day falls back to the plant today');
});

/* ---------------------------------------------------------------- final fix wave (F1, F2, F4, F6, F7) */

test('F1: place lands on the latest real gap before a late bar, with no confirm', async () => {
  liveSlotDeps.busyIntervals = (machine, day) => (machine === 'M2' && day === '2026-10-28' ? [[at(18), at(22)]] : []);
  openIt();
  await AlertSlotModal.place();   // M2 is preselected (most free hours)
  assert.equal(calls.confirm.length, 0, 'a real gap needs no confirm');
  assert.equal(calls.patch[0][3].getTime(), at(18).getTime(), 'the finish is the start of the late bar, not the window close');
  assert.deepEqual(calls.goto[0].slice(0, 2), ['M2', '2026-10-28']);
});

test('F1: a day whose gaps are all too small asks first, naming the overlap, then places at the window close', async () => {
  liveSlotDeps.busyIntervals = () => [[at(8), at(22)]];
  openIt();
  await AlertSlotModal.place();   // M2 "fits" by free hours (9), but no 4 h gap exists
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.confirm[0].message, 'am.slot_confirm_short');
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.patch[0][3].getTime(), at(22).getTime());
});

test('F1: the walk-back confirm is unchanged and the gap search runs on the day it lands on', async () => {
  openDays.delete('2026-10-28');
  capByDay['2026-10-28'].M2 = { free: 0, cap: 0, closed: true };
  liveSlotDeps.pairOptions = () => [{ value: 'M2', label: 'M2' }];
  const asked = [];
  liveSlotDeps.busyIntervals = (_m, day) => { asked.push(day); return [[at(19, 0, 27), at(22, 0, 27)]]; };
  openIt();
  await AlertSlotModal.place();
  assert.equal(calls.confirm[0].message, 'am.slot_confirm_closed');
  assert.deepEqual(asked, ['2026-10-27']);
  assert.equal(calls.patch[0][3].getTime(), at(19, 0, 27).getTime());
});

test('F1: liveSlotDeps.busyIntervals reads the placed bars of that machine that touch the day', () => {
  seedTask();
  Store.setTasks([
    { ...Store.tasks.t1 },
    { id: 'b1', ORDER: '1', MACHINE: 'M2', PLANT: 'P1', start_date: at(10), end_date: at(14), planning_status: 'scheduled' },
    { id: 'b2', ORDER: '2', MACHINE: 'M2', PLANT: 'P1', start_date: at(22), end_date: at(3, 0, 29), planning_status: 'scheduled' },   // crosses midnight
    { id: 'b3', ORDER: '3', MACHINE: 'M2', PLANT: 'P1', start_date: at(10, 0, 30), end_date: at(14, 0, 30), planning_status: 'scheduled' },
    { id: 'b4', ORDER: '4', MACHINE: 'M3', PLANT: 'P1', start_date: at(10), end_date: at(14), planning_status: 'scheduled' },
    { id: 'b5', ORDER: '5', MACHINE: 'M2', PLANT: 'P1', start_date: null, end_date: null, planning_status: 'needs_planning' },
  ], 'test');
  const busy = prior.deps.busyIntervals;
  const span = list => list.map(([s, e]) => [s.getTime(), e.getTime()]);
  assert.deepEqual(span(busy('M2', '2026-10-28')), [[at(10).getTime(), at(14).getTime()], [at(22).getTime(), at(3, 0, 29).getTime()]]);
  assert.deepEqual(span(busy('M2', '2026-10-29')), [[at(22).getTime(), at(3, 0, 29).getTime()]], 'the midnight-crossing bar also counts on the next day');
  assert.deepEqual(busy('M2', '2026-10-27'), []);
  assert.deepEqual(busy('M9', '2026-10-28'), [], 'another machine');
  assert.deepEqual(busy('M2', 'not-a-day'), []);
});

test('F2: defaultSlotDay moves to tomorrow when nothing is left today, and keeps a later due day', () => {
  const dueIn = (d) => task({ original_end_date: new Date(2026, 9, d, 14) });
  assert.equal(defaultSlotDay(dueIn(20), '2026-10-26', false), '2026-10-27');
  assert.equal(defaultSlotDay(dueIn(26), '2026-10-26', false), '2026-10-27', 'due today, today is used up');
  assert.equal(defaultSlotDay(dueIn(30), '2026-10-26', false), '2026-10-30');
  assert.equal(defaultSlotDay(dueIn(20), '2026-10-26', true), '2026-10-26');
  assert.equal(defaultSlotDay(dueIn(20), '2026-10-26'), '2026-10-26', 'the flag defaults to "time is left"');
  assert.equal(defaultSlotDay(task({ original_end_date: null }), '2026-10-31', false), '2026-11-01', 'across a month end');
});

test('F2: with nothing left today on any eligible machine the dialog and the suggestion open on tomorrow', () => {
  seedTask({ original_end_date: new Date(2026, 9, 20, 14) });   // a past due day: would default to today
  capByDay['2026-10-26'] = { M1: { free: 0, cap: 0, closed: true }, M2: { free: 0, cap: 0, closed: true }, M3: { free: 0, cap: 0, closed: true } };
  capByDay['2026-10-27'] = { M1: { free: 5, cap: 8, closed: false }, M2: { free: 9, cap: 10, closed: false }, M3: { free: 6, cap: 8, closed: false } };
  openIt();
  assert.equal(els['asl-day'].value, '2026-10-27');
  assert.equal(AlertSlotModal.suggestedDay(Store.tasks.t1, 'P1'), '2026-10-27');
  assert.equal(AlertSlotModal.suggest(Store.tasks.t1, 'P1').machine, 'M2');
  // one machine with time left keeps today
  AlertSlotModal.close();
  capByDay['2026-10-26'].M3 = { free: 3, cap: 4, closed: false };
  Store.updateTask('t1', { text: 'x' }, 'test');
  openIt();
  assert.equal(els['asl-day'].value, '2026-10-26');
  assert.equal(AlertSlotModal.suggestedDay(Store.tasks.t1, 'P1'), '2026-10-26');
  // unreadable capacity does not hide today
  AlertSlotModal.close();
  delete capByDay['2026-10-26'];
  Store.updateTask('t1', { text: 'y' }, 'test');
  openIt();
  assert.equal(els['asl-day'].value, '2026-10-26');
});

test('F2: place never walks back into the past, and a day with nothing left toasts the no-window warning', async () => {
  const realNow = new Date(2026, 9, 26, 23, 0);
  slotSeams.plantNow = () => realNow;
  openDays.add('2026-10-26'); openDays.add('2026-10-25');
  seedTask({ original_end_date: new Date(2026, 9, 26, 14) });
  capByDay['2026-10-26'] = { M1: { free: 5, cap: 8, closed: false }, M2: { free: 9, cap: 10, closed: false }, M3: { free: 6, cap: 8, closed: false } };
  openIt();
  els['asl-day'].value = '2026-10-26';   // the planner insists on today, which is over
  AlertSlotModal.rerank();
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['am.slot_no_window', 'warn']);
  assert.equal(calls.patch.length, 0);
});

test('F2: liveSlotDeps.dayCapacity on the plant today counts only the time still ahead', () => {
  const real = Utilization.computeMatrix;
  Utilization.computeMatrix = () => ({
    M1: { '2026-10-26': { scheduled: 1, capacity: 16, effectiveCapacity: 16 }, '2026-10-27': { scheduled: 1, capacity: 16, effectiveCapacity: 16 } },
  });
  try {
    const dayCapacity = prior.deps.dayCapacity;
    slotSeams.plantNow = () => new Date(2026, 9, 26, 14, 0);   // window 06-22: 8 h gone
    assert.deepEqual(dayCapacity('M1', '2026-10-26'), { free: 8, cap: 8, closed: false }, 'free is capped by the time left');
    assert.deepEqual(dayCapacity('M1', '2026-10-27'), { free: 15, cap: 16, closed: false }, 'another day is untouched');
    slotSeams.plantNow = () => new Date(2026, 9, 26, 3, 0);
    assert.deepEqual(dayCapacity('M1', '2026-10-26'), { free: 15, cap: 16, closed: false }, 'now before the window opens');
    slotSeams.plantNow = () => new Date(2026, 9, 26, 22, 30);
    assert.deepEqual(dayCapacity('M1', '2026-10-26'), { free: 0, cap: 0, closed: true }, 'nothing left: treated as closed');
    slotSeams.plantNow = () => null;
    assert.deepEqual(dayCapacity('M1', '2026-10-26'), { free: 15, cap: 16, closed: false }, 'no plant clock: no clamp');
  } finally { Utilization.computeMatrix = real; }
});

test('F2: the success toast names the landing day', async () => {
  const seen = [];
  const priorT = Util.t;
  Util.t = (key, vars) => { seen.push([key, vars]); return key; };
  try {
    openIt();
    await AlertSlotModal.place();
  } finally { Util.t = priorT; }
  const placed = seen.find(([k]) => k === 'am.slot_placed');
  assert.equal(placed[1].order, '1001');
  assert.equal(placed[1].machine, 'M2');
  assert.equal(placed[1].when, Util._fmtDatePref(new Date(2026, 9, 28)), 'the landing day in the user date format');
});

test('F2/F6: a walk-back toast and Go To use the day the bar really ends on, also when the window closes at 24:00', async () => {
  slotSeams.workWindow = (_line, date) => (Util.dayKey(date) === '2026-10-28'
    ? [new Date(date.getFullYear(), date.getMonth(), date.getDate(), 6), new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0)]
    : null);
  const seen = [];
  const priorT = Util.t;
  Util.t = (key, vars) => { seen.push([key, vars]); return key; };
  try {
    openIt();
    await AlertSlotModal.place();
  } finally { Util.t = priorT; }
  assert.equal(calls.patch[0][3].getTime(), new Date(2026, 9, 29, 0).getTime(), 'a 24:00 close is next-day midnight');
  assert.deepEqual(calls.goto[0].slice(0, 2), ['M2', '2026-10-28'], 'Go To centres on the 28th, not the 29th');
  assert.equal(seen.find(([k]) => k === 'am.slot_placed')[1].when, Util._fmtDatePref(new Date(2026, 9, 28)));
});

test('F4: place skips a blacked-out day like a closed one and confirms the move', async () => {
  slotSeams.dayClosed = (_machine, day) => day === '2026-10-28';   // a nominal window, but fully blacked out
  openIt();
  await AlertSlotModal.place();
  assert.equal(calls.confirm[0].message, 'am.slot_confirm_closed');
  assert.deepEqual(calls.goto[0].slice(0, 2), ['M2', '2026-10-27']);
});

test('F7: a refusal that needs an overtime confirm asks, then retries once with confirmedOvertime', async () => {
  const asked = [];
  Engine.confirmOvertimePlacement = async (tk) => { asked.push(tk.id); return true; };
  patchFor = (cur, machine, finish, opts) => {
    if (opts?.confirmedOvertime) return { start_date: new Date(finish.getTime() - 4 * 3600e3), end_date: finish, MACHINE: machine, RUN_TIME: 4 };
    Engine.lastManualRefusal = 'needs_overtime_confirm';
    return null;
  };
  openIt();
  await AlertSlotModal.place();
  assert.deepEqual(asked, ['t1']);
  assert.equal(calls.patch.length, 2);
  assert.deepEqual(calls.patch[0][4], { quiet: true });
  assert.deepEqual(calls.patch[1][4], { quiet: true, confirmedOvertime: true });
  assert.equal(Store.tasks.t1.MACHINE, 'M2');
  assert.equal(Store.isFirmed('t1'), true);
  assert.equal(calls.toast.some(([m]) => m === 'toast.manual_refusal_generic'), false, 'no generic refusal toast');
  assert.deepEqual(calls.toast.at(-1), ['am.slot_placed', 'success']);
});

test('F7: declining the overtime confirm writes nothing and keeps the dialog open', async () => {
  Engine.confirmOvertimePlacement = async () => false;
  patchFor = () => { Engine.lastManualRefusal = 'needs_overtime_confirm'; return null; };
  openIt();
  await AlertSlotModal.place();
  assert.equal(calls.patch.length, 1, 'no retry');
  assert.equal(UndoStack._entries.length, 0);
  assert.equal(Store.tasks.t1.planning_status, 'needs_planning');
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
});

test('F7: the staleness check runs again after the overtime confirm', async () => {
  Engine.confirmOvertimePlacement = async () => { Store.updateTask('t1', { RUN_TIME: 9 }, 'test'); return true; };
  patchFor = () => { Engine.lastManualRefusal = 'needs_overtime_confirm'; return null; };
  openIt();
  await AlertSlotModal.place();
  assert.equal(calls.patch.length, 1, 'the retry never ran');
  assert.deepEqual(calls.toast.at(-1), ['am.slot_stale', 'warn']);
  assert.equal(AlertSlotModal.isOpenFor('P1'), false);
  assert.equal(UndoStack._entries.length, 0);
});

test('F7: a retry that is refused again is explained, not looped', async () => {
  Engine.confirmOvertimePlacement = async () => true;
  patchFor = () => { Engine.lastManualRefusal = 'needs_overtime_confirm'; return null; };
  openIt();
  await AlertSlotModal.place();
  assert.equal(calls.patch.length, 2, 'one retry only');
  assert.deepEqual(calls.toast.at(-1), ['toast.manual_refusal_generic', 'error']);
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
});
