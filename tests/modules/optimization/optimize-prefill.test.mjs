// OptimizeDialog.open(prefill?) — the Alert Monitor's "Optimize this window" deep link preselects the
// machines and the custom window; a plain open() is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OptimizeDialog } from '../../../frontend/optimization/optimize-ui.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';

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
  const prior = {
    document: globalThis.document, raf: globalThis.requestAnimationFrame, flatpickr: globalThis.flatpickr,
    plant: Store.selectedPlant, tasks: structuredClone(Store.tasksArr), recompute: Alerts.scheduleRecompute, window: globalThis.window,
  };
  globalThis.window = globalThis.window || {};
  globalThis.document = {
    getElementById: get, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, createElement: () => makeEl('created'),
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.flatpickr = () => new Proxy({ selectedDates: [] }, { get: (target, key) => (key in target ? target[key] : () => {}) });
  Alerts.scheduleRecompute = () => {};
  Store.setTasks([
    { id: 't1', PLANT: 'SR', MACHINE: 'L1', RUN_TIME: 1, start_date: null, end_date: null },
    { id: 't2', PLANT: 'SR', MACHINE: 'L2', RUN_TIME: 1, start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('SR', 'unit-test');
  return {
    el: get,
    restore() {
      Alerts.scheduleRecompute = prior.recompute;
      Store.setTasks(prior.tasks, 'unit-test');
      Store.setSelectedPlant(prior.plant, 'unit-test');
      globalThis.document = prior.document; globalThis.requestAnimationFrame = prior.raf;
      if (prior.flatpickr === undefined) delete globalThis.flatpickr; else globalThis.flatpickr = prior.flatpickr;
    },
  };
}

test('open(prefill) preselects the lines and the custom window', () => {
  const fx = fixture();
  try {
    OptimizeDialog.open({ lines: ['L1'], startDate: new Date(2026, 9, 21, 0, 0), endDate: new Date(2026, 9, 24, 0, 0) });
    assert.equal(fx.el('modal-optimize').hidden, false);
    assert.equal(fx.el('opt-lines-panel').hidden, false, 'scope switches to selected machines');
    const list = fx.el('opt-lines-list').innerHTML;
    assert.match(list, /<input type="checkbox" checked data-line="L1">/, 'L1 is ticked');
    assert.match(list, /<input type="checkbox"  data-line="L2">/, 'L2 is not');
    assert.match(fx.el('opt-start-btn').textContent, /Oct 21, 2026/);
    assert.match(fx.el('opt-end-btn').textContent, /Oct 24, 2026/);
    assert.ok(fx.el('opt-date-row').classList.contains('visible'), 'the custom window row is shown');
    assert.match(fx.el('opt-date-summary').innerHTML, /3 days/);
  } finally { fx.restore(); }
});

test('a prefilled line that is not in the plant is ignored; a plain open() is unchanged', () => {
  const fx = fixture();
  try {
    OptimizeDialog.open({ lines: ['NOPE'], startDate: new Date(2026, 9, 21), endDate: new Date(2026, 9, 22) });
    assert.doesNotMatch(fx.el('opt-lines-list').innerHTML, /checked/);
    OptimizeDialog.open();
    assert.equal(fx.el('opt-lines-panel').hidden, true, 'whole-plant scope');
    assert.doesNotMatch(fx.el('opt-lines-list').innerHTML, /checked/);
    assert.equal(fx.el('opt-date-row').classList.contains('visible'), false, 'no custom window carried over');
  } finally { fx.restore(); }
});
