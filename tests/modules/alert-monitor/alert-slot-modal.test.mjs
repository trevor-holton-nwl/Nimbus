// Tests for frontend/alert-monitor/alert-slot-modal.mts. Part 1 is the pure exports (ranking, closed-day walk-back,
// task fingerprint, default day, option text); part 2 drives the dialog and place() against a stubbed document,
// the real Store/UndoStack and stubbed Engine / Calendar / Toast / Modal.confirm.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  AlertSlotModal, slotSeams, liveSlotDeps, canPlaceSlot,
  parsePairValue, rankSlotCandidates, slotFinishFor, slotTaskKey, defaultSlotDay, formatSlotOption, SLOT_LOOKBACK_DAYS,
} from '../../../frontend/alert-monitor/alert-slot-modal.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Util, Modal, Toast } from '../../../frontend/platform/foundation.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';

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
  prior.manual = Engine.manualRoutingSchedulePatchFor; prior.pair = Engine.pairSchedulePatchFor;
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
  Engine.manualRoutingSchedulePatchFor = (cur, machine, finish, opts) => { calls.patch.push(['manual', cur.id, machine, finish, opts]); return patchFor(cur, machine, finish); };
  Engine.pairSchedulePatchFor = (cur, pv, machine, finish, opts) => { calls.patch.push(['pair', cur.id, pv, machine, finish, opts]); return patchFor(cur, machine, finish); };
  Engine.lastManualRefusal = null;
  slotSeams.signedIn = () => true;
  slotSeams.workWindow = (_line, date) => {
    const key = Util.dayKey(date);
    return openDays.has(key) ? [new Date(date.getFullYear(), date.getMonth(), date.getDate(), 6), new Date(date.getFullYear(), date.getMonth(), date.getDate(), 22)] : null;
  };
  slotSeams.nim = () => ({ Timeline: { gotoLineDay: (...a) => calls.goto.push(a) } });
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
  Engine.manualRoutingSchedulePatchFor = prior.manual; Engine.pairSchedulePatchFor = prior.pair;
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

  liveSlotDeps.pairOptions = () => [{ value: '0002|M2', label: '0002 - M2' }];
  AlertSlotModal.close(); openIt();
  patchFor = () => { Engine.lastManualRefusal = null; return null; };
  await AlertSlotModal.place();
  assert.deepEqual(calls.toast.at(-1), ['toast.pv_machine_ineligible', 'warn'], 'a routing pair that no longer resolves');
  assert.equal(AlertSlotModal.isOpenFor('P1'), true);
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
