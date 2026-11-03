// OptimizeDialog Custom window: an inclusive date-only range by default (From D1 / To D2 -> [D1 00:00, D2+1 00:00)),
// with an optional "Adjust times" toggle that restores minute-precision instants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OptimizeDialog, OptimizerPreview } from '../../../frontend/optimization/optimize-ui.mjs';
import { enLocale } from '../helpers/en-locale.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

function makeEl(id) {
  const classes = new Set();
  return {
    id, value: '', hidden: false, innerHTML: '', textContent: '', style: {}, checked: false, disabled: false, dataset: {},
    classList: {
      add(...n) { n.forEach(x => classes.add(x)); }, remove(...n) { n.forEach(x => classes.delete(x)); },
      contains: n => classes.has(n),
      toggle(n, force) { const on = force === undefined ? !classes.has(n) : force; if (on) classes.add(n); else classes.delete(n); return on; },
    },
    addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, appendChild() {},
  };
}

function fixture() {
  const els = new Map();
  const get = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const pickers = {};   // selector -> every instance built for it (settable selectedDates, recorded options)
  const prior = {
    document: globalThis.document, raf: globalThis.requestAnimationFrame, flatpickr: globalThis.flatpickr,
    plant: Store.selectedPlant, tasks: structuredClone(Store.tasksArr), recompute: Alerts.scheduleRecompute, window: globalThis.window,
    plantNow: Store.plantNow,
  };
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = enLocale();
  globalThis.document = {
    getElementById: get, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, createElement: () => makeEl('created'),
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.flatpickr = (selector, opts) => {
    const target = { selectedDates: [], opts, destroyed: false, destroy() { target.destroyed = true; } };
    const inst = new Proxy(target, { get: (t, key) => (key in t ? t[key] : () => {}) });
    (pickers[selector] ||= []).push(target);
    return inst;
  };
  Alerts.scheduleRecompute = () => {};
  Store.plantNow = () => new Date(2026, 10, 3, 14, 30, 45);
  Store.setTasks([
    { id: 't1', PLANT: 'SR', MACHINE: 'L1', RUN_TIME: 1, start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('SR', 'unit-test');
  const live = sel => pickers[sel].filter(p => !p.destroyed).at(-1);
  // The dialog is module-level state and keeps the pickers an earlier test built; flip the mode once so this
  // fixture's stub owns fresh instances (open() always resets the mode to off).
  OptimizeDialog.setTimeMode(true);
  OptimizeDialog.setTimeMode(false);
  return {
    el: get, pickers, live,
    /** Simulate a planner picking a date in a picker modal and pressing OK. */
    pickFrom(d) { live('#opt-from-cal').selectedDates = [d]; OptimizeDialog.commitFrom(); },
    pickTo(d) { live('#opt-to-cal').selectedDates = [d]; OptimizeDialog.commitTo(); },
    restore() {
      Alerts.scheduleRecompute = prior.recompute;
      Store.plantNow = prior.plantNow;
      Store.setTasks(prior.tasks, 'unit-test');
      Store.setSelectedPlant(prior.plant, 'unit-test');
      globalThis.document = prior.document; globalThis.requestAnimationFrame = prior.raf;
      if (prior.flatpickr === undefined) delete globalThis.flatpickr; else globalThis.flatpickr = prior.flatpickr;
    },
  };
}

/** Run the dialog and capture the options handed to the preview. */
async function runAndCapture() {
  const prior = {
    fg: OptimizerPreview.runWithPreview, loading: OptimizerPreview.showLoading, raf: globalThis.requestAnimationFrame,
    rank: Persistence._rankMapsPlant, hydration: CalendarSync._hydration.SR,
  };
  try {
    CalendarSync._setHydration('SR', 'hydrated');
    Persistence._rankMapsPlant = 'SR';
    globalThis.requestAnimationFrame = fn => { fn(); return 1; };
    const calls = [];
    OptimizerPreview.runWithPreview = async (mode, opts) => { calls.push({ mode, opts }); };
    OptimizerPreview.showLoading = () => {};
    OptimizeDialog.selectMode('spt');
    await OptimizeDialog.run();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(calls.length, 1, 'run reached the preview');
    return calls[0].opts;
  } finally {
    OptimizerPreview.runWithPreview = prior.fg; OptimizerPreview.showLoading = prior.loading;
    globalThis.requestAnimationFrame = prior.raf; Persistence._rankMapsPlant = prior.rank;
    if (prior.hydration) CalendarSync._hydration.SR = prior.hydration; else delete CalendarSync._hydration.SR;
  }
}

const at = (m, d, h = 0, mi = 0) => new Date(2026, m - 1, d, h, mi);

test('date mode: the same day twice is a one-day window; two days is two', () => {
  const fx = fixture();
  try {
    OptimizeDialog.open();
    OptimizeDialog.applyPreset('custom');
    fx.pickFrom(at(11, 5, 13, 40));
    fx.pickTo(at(11, 5, 9, 15));
    assert.match(fx.el('opt-date-summary').innerHTML, /\b1 day\b(?!s)/);
    assert.match(fx.el('opt-start-btn').textContent, /11\/05\/2026/);
    assert.match(fx.el('opt-end-btn').textContent, /11\/05\/2026/, 'To shows the inclusive picked day');
    assert.doesNotMatch(fx.el('opt-start-btn').textContent, /:/, 'no time of day in date mode');
    fx.pickTo(at(11, 6));
    assert.match(fx.el('opt-date-summary').innerHTML, /\b2 days\b/);
    assert.match(fx.el('opt-end-btn').textContent, /11\/06\/2026/);
  } finally { fx.restore(); }
});

test('date mode: run() receives [D1 00:00, D2+1 00:00)', async () => {
  const fx = fixture();
  try {
    OptimizeDialog.open();
    OptimizeDialog.applyPreset('custom');
    fx.pickFrom(at(11, 5, 13, 40));
    fx.pickTo(at(11, 6, 9, 15));
    const opts = await runAndCapture();
    assert.equal(opts.startDate.getTime(), at(11, 5).getTime());
    assert.equal(opts.endDate.getTime(), at(11, 7).getTime());
  } finally { fx.restore(); }
});

test('date mode: a To before From is pushed to the day after From', () => {
  const fx = fixture();
  try {
    OptimizeDialog.open();
    OptimizeDialog.applyPreset('custom');
    fx.pickFrom(at(11, 10));
    fx.pickTo(at(11, 8));
    assert.match(fx.el('opt-date-summary').innerHTML, /\b1 day\b(?!s)/);
    assert.match(fx.el('opt-end-btn').textContent, /11\/10\/2026/);
  } finally { fx.restore(); }
});

test('date mode: a DST fall-back day is still one midnight-aligned day', async () => {
  const fx = fixture();
  try {
    OptimizeDialog.open();
    OptimizeDialog.applyPreset('custom');
    fx.pickFrom(at(11, 1));   // US fall-back day in 2026 (25 h)
    fx.pickTo(at(11, 1));
    assert.match(fx.el('opt-date-summary').innerHTML, /\b1 day\b(?!s)/);
    const opts = await runAndCapture();
    assert.equal(opts.startDate.getTime(), new Date(2026, 10, 1).getTime());
    assert.equal(opts.endDate.getTime(), new Date(2026, 10, 2).getTime(), 'end is midnight of the next day');
  } finally { fx.restore(); }
});

test('choosing Custom with no dates picked seeds today to today (one day, plant clock)', () => {
  const fx = fixture();
  try {
    OptimizeDialog.open();
    OptimizeDialog.applyPreset('custom');
    assert.match(fx.el('opt-start-btn').textContent, /11\/03\/2026/);
    assert.match(fx.el('opt-end-btn').textContent, /11\/03\/2026/);
    assert.match(fx.el('opt-date-summary').innerHTML, /\b1 day\b(?!s)/);
  } finally { fx.restore(); }
});

test('time mode: picked instants pass through; toggling off re-snaps to day bounds', async () => {
  const fx = fixture();
  try {
    OptimizeDialog.open();
    OptimizeDialog.applyPreset('custom');
    const dateOnlyFrom = fx.live('#opt-from-cal');
    OptimizeDialog.setTimeMode(true);
    assert.equal(fx.live('#opt-from-cal').opts.enableTime, true, 'pickers rebuilt with time controls');
    assert.equal(fx.live('#opt-to-cal').opts.enableTime, true);
    assert.equal(dateOnlyFrom.destroyed, true, 'the date-only instance was destroyed');
    fx.pickFrom(at(11, 5, 13, 40));
    fx.pickTo(at(11, 6, 9, 15));
    assert.match(fx.el('opt-start-btn').textContent, /11\/05\/2026.*:/, 'time mode shows the time');
    const opts = await runAndCapture();
    assert.equal(opts.startDate.getTime(), at(11, 5, 13, 40).getTime());
    assert.equal(opts.endDate.getTime(), at(11, 6, 9, 15).getTime());
    OptimizeDialog.setTimeMode(false);
    assert.equal(fx.live('#opt-from-cal').opts.enableTime, false);
    assert.doesNotMatch(fx.el('opt-start-btn').textContent, /:/);
    assert.match(fx.el('opt-date-summary').innerHTML, /\b2 days\b/);
    const snapped = await runAndCapture();
    assert.equal(snapped.startDate.getTime(), at(11, 5).getTime());
    assert.equal(snapped.endDate.getTime(), at(11, 7).getTime());
  } finally { fx.restore(); }
});

test('open() resets the Adjust times toggle to off', () => {
  const fx = fixture();
  try {
    OptimizeDialog.open();
    OptimizeDialog.setTimeMode(true);
    fx.el('opt-chk-times').checked = true;
    OptimizeDialog.open();
    assert.equal(fx.el('opt-chk-times').checked, false);
    assert.equal(fx.live('#opt-from-cal').opts.enableTime, false);
  } finally { fx.restore(); }
});

test('prefill with non-midnight instants turns time mode on; midnight bounds keep date mode', () => {
  const fx = fixture();
  try {
    OptimizeDialog.open({ startDate: at(10, 21, 6, 30), endDate: at(10, 24, 14, 0) });
    assert.equal(fx.el('opt-chk-times').checked, true);
    assert.equal(fx.live('#opt-from-cal').opts.enableTime, true);
    assert.match(fx.el('opt-start-btn').textContent, /10\/21\/2026.*:/);

    OptimizeDialog.open({ startDate: at(10, 21), endDate: at(10, 24) });
    assert.equal(fx.el('opt-chk-times').checked, false);
    assert.equal(fx.live('#opt-from-cal').opts.enableTime, false);
    assert.match(fx.el('opt-start-btn').textContent, /10\/21\/2026/);
    assert.match(fx.el('opt-end-btn').textContent, /10\/23\/2026/, 'To shows the inclusive last day');
    assert.match(fx.el('opt-date-summary').innerHTML, /3 days/);
  } finally { fx.restore(); }
});

test('Remove Backlog: switching to Custom keeps the computed backlog bounds', () => {
  const fx = fixture();
  try {
    OptimizeDialog.open();
    OptimizeDialog.selectMode('backlog');
    const before = fx.el('opt-start-btn').textContent;
    assert.match(before, /:/, 'backlog bounds carry a time of day');
    OptimizeDialog.applyPreset('custom');
    assert.equal(fx.el('opt-start-btn').textContent, before, 'the seed did not overwrite the backlog start');
    assert.doesNotMatch(fx.el('opt-date-summary').innerHTML, /\b1 day\b(?!s)/);
  } finally { fx.restore(); }
});

test('the 2 Weeks preset still shows date and time with the toggle off', () => {
  const fx = fixture();
  try {
    OptimizeDialog.open();
    OptimizeDialog.applyPreset('2w');
    assert.match(fx.el('opt-start-btn').textContent, /11\/03\/2026.*:/);
    assert.match(fx.el('opt-end-btn').textContent, /11\/17\/2026.*:/, 'exclusive end shown as is');
    assert.match(fx.el('opt-date-summary').innerHTML, /14 days/);
  } finally { fx.restore(); }
});
