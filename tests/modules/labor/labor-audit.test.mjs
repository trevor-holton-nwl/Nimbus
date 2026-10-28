import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaborPlanning } from '../../../frontend/labor/labor-planning.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { Calendar } from '../../../frontend/calendar/calendar-engine.mjs';
import { Utilization } from '../../../frontend/insights/services.mjs';
import { setActiveTabResolvers } from '../../../frontend/shell/tab-resolvers.mjs';

function auditDay(offset = 0) {
  const monday = new Date(); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + offset);
  return Util.dayKey(monday);
}

function grid() {
  let html = ''; const inputs = []; const buttons = []; const table = { addEventListener(type, fn) { this[type] = fn; } };
  return {
    inputs, buttons, table, addEventListener() {},
    set innerHTML(value) {
      html = value; inputs.length = 0; buttons.length = 0;
      for (const match of value.matchAll(/<input\b([^>]*)>/g)) {
        const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        const td = { style: {}, classList: { add() {}, remove() {}, toggle() {} } };
        inputs.push({ checked: /\bchecked\b/.test(match[1]), style: {}, value: attrs.value || '', dataset: { group: attrs['data-group'], period: attrs['data-period'], line: attrs['data-line'], day: attrs['data-day'], savedValue: attrs['data-saved-value'] },
          classList: { contains(c) { return attrs.class?.includes(c); } }, closest(s) { return s === 'td' ? td : this; }, focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; } });
      }
      for (const match of value.matchAll(/<button\b([^>]*)>/g)) {
        const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        buttons.push({ dataset: { line: attrs['data-line'], day: attrs['data-day'] } });
      }
    },
    get innerHTML() { return html; },
    querySelectorAll(selector) { return selector === '.lp-cell' || selector === '.lp-line-cell' || selector === 'input[type="checkbox"]' ? inputs : selector === '.lp-exc-fix' ? buttons : []; },
    querySelector(selector) {
      if (selector === 'table') return table;
      if (selector === 'thead tr') return null;
      const pairs = [...selector.matchAll(/data-(group|period|line|day)="([^"]*)"/g)];
      return pairs.length ? inputs.find(i => pairs.every(([, key, value]) => i.dataset[key] === value)) || null : null;
    },
  };
}

async function harness(t, sub = 'aggregate') {
  const nodes = Object.fromEntries(['labor-grid', 'labor-line-grid', 'labor-capacity-grid', 'labor-exceptions-list', 'labor-kpi-strip'].map(id => [id, grid()]));
  t.mock.method(Utilization, 'computeMatrix', () => ({}));
  t.mock.method(Calendar, 'effectiveCapacityHours', () => 8);
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Util, 't', (key, vars) => vars ? `${key} ${JSON.stringify(vars)}` : key);
  t.mock.method(Util, 'fetchTraced', async () => ({ ok: true, json: async () => ({ rows: [] }) }));
  const prior = { document: globalThis.document, flatpickr: globalThis.flatpickr };
  globalThis.document = { getElementById: id => nodes[id] || null, body: { classList: { contains: () => false } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, activeElement: null };
  globalThis.flatpickr = () => ({ setDate() {} });
  let active = sub;
  setActiveTabResolvers({ laborSub: () => active, currentTab: () => 'labor' });
  const plant = `AUDIT-${Math.random()}`;
  Store.setMasterData({ plants: [{ plant, subnetwork: 'S' }], lines: ['A','B','C'].map(g => ({ plant, machine: `LINE-${g}`, wc_group: g })) });
  Store.setSelectedPlant(plant); Store.setSelectedLines(new Set());
  UndoStack._entries = [];
  const writes = []; let fail = false; let readFail = false; let lineRows = []; let aggregateRows = []; let nextGate = null;
  Util.fetchTraced.mock.mockImplementation(async (url, opts) => {
    if (opts?.method === 'POST') {
      const body = JSON.parse(opts.body); writes.push({ url, body });
      const gate = nextGate; nextGate = null; if (gate) { gate.started(); await gate.pending; }
      const applied = [], skipped = [];
      if (!fail) {
        for (const cell of body.line_cells || []) {
          const previous = lineRows.find(c => c.machine === cell.machine && c.day === cell.day);
          if (body.intent === 'reconcile' && previous?.source === 'override') { skipped.push(previous); continue; }
          if (previous || cell.avail_hours != null) applied.push({ machine: cell.machine, day: cell.day });
          lineRows = lineRows.filter(c => c.machine !== cell.machine || c.day !== cell.day);
          if (cell.avail_hours != null) lineRows.push(cell);
        }
        for (const cell of body.cells || []) {
          aggregateRows = aggregateRows.filter(c => c.wc_group !== cell.wc_group || c.period !== cell.period);
          if (cell.avail_hours != null) aggregateRows.push(cell);
        }
      }
      return { ok: !fail, status: 500, json: async () => fail ? ({ detail: 'write rejected' }) : ({ lines: { applied, skipped, rows: body.line_cells.map(c => lineRows.find(r => r.machine === c.machine && r.day === c.day) || { ...c, avail_hours: null, source: 'auto_split' }) } }) }; }
    return { ok: !readFail, status: 503, json: async () => ({ rows: url.includes('/line?') ? lineRows : aggregateRows }) };
  });
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 0)); Object.assign(globalThis, prior); setActiveTabResolvers({ laborSub: () => null, currentTab: () => null }); });
  return { nodes, writes, plant,
    addGroupPicker() {
      const list = grid(), search = { value: '', focus() { globalThis.document.activeElement = this; } };
      const clear = {}, trigger = { focus() { this.focused = true; }, setAttribute() {} };
      let built = false;
      const drop = { hidden: true, contains: () => true,
        set innerHTML(_v) { built = true; },
        querySelector(sel) { return built ? ({ '[data-group-search]': search, '[data-group-list]': list, '[data-group-clear]': clear }[sel] || null) : null; }
      };
      nodes['lp-group-dropdown'] = drop; nodes['lp-group-btn'] = trigger;
      return { drop, list, search, clear, trigger };
    },
    subscribe() {
      const original = Store.subscribe.bind(Store);
      t.mock.method(Store, 'subscribe', (...args) => { const off = original(...args); t.after(off); return off; });
      LaborPlanning.init();
    },
    holdNext() {
      let release, started;
      const pending = new Promise(resolve => { release = resolve; });
      const observed = new Promise(resolve => { started = resolve; });
      nextGate = { pending, started }; return { release, started: observed };
    },
    setSub(s) { active = s; }, setFail(v) { fail = v; }, setReadFail(v) { readFail = v; }, setRows(rows) { lineRows = rows; } };
}

test('LAB-001 aggregate edits preserve pins, persist together, and Undo restores derived cells', async t => {
  const h = await harness(t);
  const monday = new Date(); monday.setDate(monday.getDate() - ((monday.getDay()+6)%7));
  const day = Util.dayKey(monday);
  h.setRows([{ machine: 'LINE-A', day, avail_hours: 3, source: 'override' }]);
  await LaborPlanning.render();
  let input = h.nodes['labor-grid'].inputs[0]; input.value = '70'; await input.onchange();
  assert.equal(h.writes.length, 1, 'aggregate and derived cells must use one atomic request');
  const write = h.writes[0];
  assert.match(write.url, /\/labor-plan\/batch$/);
  assert.equal(write.body.line_cells.some(c => c.machine === 'LINE-A' && c.day === day), false, 'pinned cell must not be written');
  assert.equal(write.body.line_cells.length, 6);
  assert.equal(write.body.line_cells[0].avail_hours, 10, 'pins do not change the original split denominator');
  assert.equal(await UndoStack._entries.at(-1).undoFn(), true);
  const undo = h.writes.at(-1).body;
  assert.equal(undo.cells[0].avail_hours, null);
  assert.ok(undo.line_cells.every(c => c.avail_hours === null), 'Undo removes newly derived cells');
});

test('LAB-002 failed aggregate save restores the prior value without registering Undo', async t => {
  const h = await harness(t); await LaborPlanning.render(); h.setFail(true);
  const input = h.nodes['labor-grid'].inputs[0]; input.value = '70'; await input.onchange();
  assert.equal(UndoStack._entries.length, 0);
  assert.equal(h.nodes['labor-grid'].inputs[0].value, '');
});

test('LAB-003 group filters work in every data view without visiting Aggregate', async t => {
  const h = await harness(t, 'line-plan');
  await LaborPlanning.render();
  LaborPlanning.onGroupToggle('A', true); LaborPlanning.onGroupToggle('B', true);
  for (const [sub, id] of [['line-plan','labor-line-grid'], ['capacity','labor-capacity-grid'], ['exceptions','labor-exceptions-list']]) {
    h.setSub(sub);
    Utilization.computeMatrix.mock.mockImplementation(() => Object.fromEntries(['A','B','C'].map(g => [`LINE-${g}`, { [auditDay()]: { scheduled: 9, capacity: 8, effectiveCapacity: 8 } }])));
    await LaborPlanning.render();
    assert.match(h.nodes[id].innerHTML, /LINE-A/);
    assert.match(h.nodes[id].innerHTML, /LINE-B/);
    assert.doesNotMatch(h.nodes[id].innerHTML, /LINE-C/, sub);
  }
  LaborPlanning.clearGroupFilter();
});

test('LAB-004 all horizon calculations cover all 112 days at 16 weeks', async t => {
  const h = await harness(t);
  LaborPlanning.setSpan(16);
  for (const sub of ['aggregate','line-plan','capacity','exceptions']) {
    h.setSub(sub); await LaborPlanning.render();
  }
  for (const call of Utilization.computeMatrix.mock.calls) assert.equal(call.arguments[1], 112);
  assert.match(h.nodes['labor-capacity-grid'].innerHTML, /labor.capacity_note.*112/);
});


test('LAB-001 paste and clear share atomic derived-cell Undo and preserve pins', async t => {
  const h = await harness(t); await LaborPlanning.render();
  const g = h.nodes['labor-grid']; const input = g.inputs[0];
  globalThis.document.activeElement = input;
  await g.table.paste({ preventDefault() {}, clipboardData: { getData: () => '70\t140' } });
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].body.cells.length, 2);
  assert.equal(h.writes[0].body.line_cells.length, 14);
  input.value = ''; await input.onchange();
  assert.equal(h.writes[1].body.line_cells.length, 7);
  assert.ok(h.writes[1].body.line_cells.every(c => c.avail_hours === null));
  await UndoStack._entries.at(-1).undoFn();
  assert.ok(h.writes.at(-1).body.line_cells.every(c => c.avail_hours === 10));
});

test('LAB-002 failed Undo keeps the persisted plan and returns false for retry', async t => {
  const h = await harness(t); await LaborPlanning.render();
  const input = h.nodes['labor-grid'].inputs[0]; input.value = '70'; await input.onchange();
  h.setFail(true);
  assert.equal(await UndoStack._entries.at(-1).undoFn(), false);
  assert.equal(input.value, '70');
});

test('LAB-005 failed reads display Retry instead of empty editable plan', async t => {
  const h = await harness(t); h.setReadFail(true); await LaborPlanning.render();
  assert.match(h.nodes['labor-grid'].innerHTML, /labor.load_failed/);
  assert.match(h.nodes['labor-grid'].innerHTML, /labor.retry/);
  assert.equal(h.nodes['labor-grid'].inputs.length, 0);
});

test('LAB-006 daily overrides control KPI availability and zero-capacity demand stays visible', async t => {
  const h = await harness(t, 'capacity');
  const day = auditDay();
  h.setRows([{ machine: 'LINE-A', day, avail_hours: 0, source: 'override' }]);
  Store.setSelectedLines(new Set(['LINE-A']));
  Utilization.computeMatrix.mock.mockImplementation(() => ({ 'LINE-A': { [day]: { scheduled: 9, capacity: 8, effectiveCapacity: 8 } } }));
  await LaborPlanning.render();
  assert.match(h.nodes['labor-kpi-strip'].innerHTML, /labor.kpi_available<\/span>\s*<span class="lp-kpi-val">0h/);
  assert.match(h.nodes['labor-capacity-grid'].innerHTML, />9\/0<\/div>/);
  assert.doesNotMatch(h.nodes['labor-capacity-grid'].innerHTML, /LINE-B/);
});

test('LAB-007 line edits only change the plan after persistence, with Undo', async t => {
  const h = await harness(t, 'line-plan'); await LaborPlanning.render();
  const g = h.nodes['labor-line-grid']; let input = g.inputs[0];
  input.value = '3'; await g.onchange({ target: input });
  assert.equal(h.writes.at(-1).body.line_cells[0].source, 'override');
  assert.equal(g.inputs[0].value, '3');
  h.setFail(true); input = g.inputs[0]; input.value = '7'; await g.onchange({ target: input });
  assert.equal(g.inputs[0].value, '3');
  assert.equal(UndoStack._entries.length, 1);
  h.setFail(false); await UndoStack._entries.at(-1).undoFn();
  assert.equal(g.inputs[0].value, '8');
});


test('LAB-007 reset pin returns to split and Undo restores original provenance', async t => {
  const h = await harness(t); await LaborPlanning.render();
  const aggregate = h.nodes['labor-grid'].inputs[0]; aggregate.value = '70'; await aggregate.onchange();
  h.setSub('line-plan'); await LaborPlanning.render();
  const g = h.nodes['labor-line-grid']; let input = g.inputs[0];
  input.value = '3'; await g.onchange({ target: input });
  input = g.inputs[0]; await g.oncontextmenu({ target: input, preventDefault() {} });
  assert.equal(g.inputs[0].value, '10');
  assert.equal(h.writes.at(-1).body.line_cells[0].source, 'auto_split');
  await UndoStack._entries.at(-1).undoFn();
  assert.equal(g.inputs[0].value, '3');
  assert.equal(h.writes.at(-1).body.line_cells[0].source, 'override');
});

test('LAB-008 exception action focuses and scrolls to the exact line and date', async t => {
  const h = await harness(t, 'exceptions');
  const day = auditDay(1);
  Utilization.computeMatrix.mock.mockImplementation(() => ({ 'LINE-B': { [day]: { scheduled: 12, capacity: 8, effectiveCapacity: 8 } } }));
  await LaborPlanning.render();
  const button = h.nodes['labor-exceptions-list'].buttons[0];
  assert.deepEqual(button.dataset, { line: 'LINE-B', day });
  button.onclick(); h.setSub('line-plan'); await LaborPlanning.render();
  const focused = h.nodes['labor-line-grid'].inputs.filter(i => i.focused);
  assert.equal(focused.length, 1);
  assert.equal(focused[0].dataset.line, 'LINE-B');
  assert.equal(focused[0].dataset.day, day);
  assert.equal(focused[0].scrolled, true);
});


test('LAB-007 reset also removes a pin when no aggregate split exists', async t => {
  const h = await harness(t, 'line-plan'); await LaborPlanning.render();
  const g = h.nodes['labor-line-grid']; let input = g.inputs[0];
  input.value = '3'; await g.onchange({ target: input });
  await g.oncontextmenu({ target: g.inputs[0], preventDefault() {} });
  assert.equal(g.inputs[0].value, '8');
  assert.equal(h.writes.at(-1).body.line_cells[0].avail_hours, null);
});


test('RLAB-01 queued group edit and Undo retain committed state across plant switch away/back', async t => {
  const h = await harness(t); await LaborPlanning.render();
  let inputA = h.nodes['labor-grid'].inputs.find(i => i.dataset.group === 'A');
  inputA.value = '56'; await inputA.onchange();
  const period = inputA.dataset.period;
  h.setRows([{ machine: 'LINE-A', day: auditDay(), avail_hours: 3, source: 'override' },
    { machine: 'LINE-A', day: auditDay(1), avail_hours: 4, source: 'auto_split' }]);
  await LaborPlanning.render(); h.subscribe();
  inputA = h.nodes['labor-grid'].inputs.find(i => i.dataset.group === 'A');
  const inputB = h.nodes['labor-grid'].inputs.find(i => i.dataset.group === 'B');
  const gate = h.holdNext(); inputB.value = '21'; const first = inputB.onchange(); await gate.started;
  inputA.value = '70'; const second = inputA.onchange();
  Store.setSelectedPlant('AUDIT-OTHER'); Store.setSelectedPlant(h.plant);
  gate.release(); await Promise.all([first, second]);
  const write = h.writes.at(-1).body;
  assert.equal(write.line_cells.some(c => c.machine === 'LINE-A' && c.day === auditDay()), false);
  await UndoStack._entries.at(-1).undoFn();
  const undo = h.writes.at(-1).body;
  assert.deepEqual(undo.cells, [{ wc_group: 'A', period, avail_hours: 56 }]);
  assert.equal(undo.line_cells.find(c => c.day === auditDay(1)).avail_hours, 4);
  assert.ok(undo.line_cells.filter(c => c.day !== auditDay(1)).every(c => c.avail_hours === null));
  await LaborPlanning.render();
});

for (const fail of [false, true]) test(`RLAB-02 prior ${fail ? 'failed' : 'successful'} save preserves next-cell draft and focus`, async t => {
  const h = await harness(t, 'line-plan'); await LaborPlanning.render();
  const g = h.nodes['labor-line-grid']; const monday = g.inputs[0], tuesday = g.inputs[1];
  const gate = h.holdNext(); monday.value = '3'; const save = g.onchange({ target: monday }); await gate.started;
  globalThis.document.activeElement = tuesday; tuesday.value = '7'; h.setFail(fail);
  gate.release(); await save;
  assert.equal(g.inputs[1], tuesday, 'the next input remains attached');
  assert.equal(g.inputs[1].value, '7');
  assert.equal(globalThis.document.activeElement, tuesday);
  assert.equal(monday.focused, undefined, 'completion does not move focus backward');
  assert.equal(g.inputs[0].value, fail ? '8' : '3');
});

test('RLAB-02 two already queued edits persist in order without replacing a third draft', async t => {
  const h = await harness(t, 'line-plan'); await LaborPlanning.render();
  const g = h.nodes['labor-line-grid']; const [first, second, third] = g.inputs;
  const gate = h.holdNext(); first.value = '3'; const one = g.onchange({ target: first }); await gate.started;
  second.value = '7'; const two = g.onchange({ target: second });
  globalThis.document.activeElement = third; third.value = '11';
  gate.release(); await Promise.all([one, two]);
  assert.deepEqual(h.writes.map(w => w.body.line_cells[0].avail_hours), [3, 7]);
  assert.equal(g.inputs[2], third); assert.equal(third.value, '11');
});


test('RLAB-03 canonical pin acknowledgements update cache and exclude untouched cells from Undo', async t => {
  const h = await harness(t); await LaborPlanning.render();
  const input = h.nodes['labor-grid'].inputs[0];
  // The other client pins after this browser has loaded its empty line cache.
  h.setRows([{ machine: 'LINE-A', day: auditDay(), avail_hours: 3, source: 'override' }]);
  input.value = '70'; await input.onchange();
  assert.equal(h.writes[0].body.intent, 'reconcile');
  assert.equal(h.writes[0].body.line_cells.length, 7, 'stale browser initially submits the pinned slot');
  const undo = UndoStack._entries.at(-1);
  input.value = '84'; await input.onchange();
  assert.equal(h.writes[1].body.line_cells.some(c => c.day === auditDay()), false, 'canonical pin was applied to the browser cache');
  await undo.undoFn();
  assert.equal(h.writes.at(-1).body.intent, 'undo');
  assert.equal(h.writes.at(-1).body.line_cells.some(c => c.day === auditDay()), false, 'Undo never touches the skipped concurrent pin');
});


for (const fail of [false, true]) test(`RLAB-04 aggregate ${fail ? 'failed' : 'successful'} acknowledgement preserves a later same-cell draft`, async t => {
  const h = await harness(t); await LaborPlanning.render();
  const g = h.nodes['labor-grid'], input = g.inputs[0];
  const gate = h.holdNext(); input.value = '70'; const save = input.onchange(); await gate.started;
  globalThis.document.activeElement = input; input.value = '84'; input.oninput?.(); h.setFail(fail);
  gate.release(); await save;
  assert.equal(g.inputs[0], input);
  assert.equal(input.value, '84');
  assert.equal(globalThis.document.activeElement, input);
  assert.equal(input.dataset.savedValue, fail ? '' : '70');
});

test('RLAB-04 a later clear draft remains intentional even when it matches the saved baseline', async t => {
  const h = await harness(t); await LaborPlanning.render();
  const input = h.nodes['labor-grid'].inputs[0];
  const gate = h.holdNext(); input.value = '70'; const save = input.onchange(); await gate.started;
  input.value = ''; input.oninput();
  gate.release(); await save;
  assert.equal(input.value, ''); assert.equal(input.dataset.savedValue, '70');
});

test('RLAB-04 two queued aggregate writes preserve a third draft and unrelated dirty inputs', async t => {
  const h = await harness(t); await LaborPlanning.render();
  const [input, other] = h.nodes['labor-grid'].inputs;
  const gate = h.holdNext(); input.value = '70'; const first = input.onchange(); await gate.started;
  input.value = '84'; const second = input.onchange();
  input.value = '98'; input.oninput?.(); other.value = '11'; other.oninput?.();
  globalThis.document.activeElement = input;
  gate.release(); await Promise.all([first, second]);
  assert.deepEqual(h.writes.map(w => w.body.cells[0].avail_hours), [70, 84]);
  assert.equal(input.value, '98'); assert.equal(other.value, '11');
  assert.equal(input.dataset.savedValue, '84');
  assert.equal(globalThis.document.activeElement, input);
});

test('RLAB-04 invalid aggregate input restores only its own draft and Undo updates clean cells', async t => {
  const h = await harness(t); await LaborPlanning.render();
  const [input, other] = h.nodes['labor-grid'].inputs;
  input.value = '11'; input.oninput?.(); other.value = '-1'; await other.onchange();
  assert.equal(input.value, '11'); assert.equal(other.value, '');
  input.value = '70'; await input.onchange();
  assert.equal(input.value, '70');
  await UndoStack._entries.at(-1).undoFn();
  assert.equal(input.value, '');
});

test('LAB-O02 group search persists, retains hidden selections, and Escape returns focus', async t => {
  const h = await harness(t); const picker = h.addGroupPicker(); await LaborPlanning.render();
  LaborPlanning.toggleGroupDropdown();
  picker.search.value = 'A'; picker.search.oninput();
  assert.deepEqual(picker.list.inputs.map(i => i.value), ['A']);
  picker.list.inputs[0].checked = true; picker.list.inputs[0].onchange(); await LaborPlanning.render();
  assert.equal(picker.search.value, 'A');
  picker.search.value = 'C'; picker.search.oninput();
  picker.list.inputs[0].checked = true; picker.list.inputs[0].onchange(); await LaborPlanning.render();
  const groups = new Set(h.nodes['labor-grid'].inputs.map(i => i.dataset.group));
  assert.deepEqual(groups, new Set(['A', 'C']), 'search does not discard the hidden A selection');
  picker.drop.onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(picker.drop.hidden, true); assert.equal(picker.trigger.focused, true);
  LaborPlanning.toggleGroupDropdown(); assert.equal(picker.search.value, 'C');
  assert.equal(globalThis.document.activeElement, picker.search);
  picker.search.value = 'missing'; picker.search.oninput();
  assert.match(picker.list.innerHTML, /labor.no_matching_groups/);
});
