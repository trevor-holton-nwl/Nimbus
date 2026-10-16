import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { loadLegacyApp, ROOT } from '../helpers/load-legacy-app.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';

const { nimbus, context } = await loadLegacyApp();
runInContext(readFileSync(`${ROOT}/frontend/nimbus-intelligence.js`, 'utf8'), context);
const { CommandPalette, TimeMachine, DarkMode, LangSwitcher, Store, Diff } = nimbus;

// Small DOM event fixture: native browser keyboard activation and geometry
// still require browser QA; this exercises the production handlers and state.
function fixture() {
  const byId = new Map();
  const timers = [];
  class Element {
    constructor(tag = 'div', attrs = {}) {
      this.tagName = tag.toUpperCase(); this.attrs = attrs; this.listeners = {}; this.children = [];
      this.hidden = false; this.style = {}; this.dataset = {}; this.value = '';
      const classes = new Set((attrs.class || '').split(' '));
      this.classList = { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle(c, force) { const on = force ?? !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; } };
      for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5)] = value;
      if (attrs.id) byId.set(attrs.id, this);
    }
    set id(value) { this.attrs.id = value; byId.set(value, this); }
    get id() { return this.attrs.id; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key]; }
    set innerHTML(value) {
      this.html = value; this.children = [];
      for (const [, tag, raw] of value.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
        const attrs = Object.fromEntries([...raw.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        this.children.push(new Element(tag, attrs));
      }
    }
    get innerHTML() { return this.html || ''; }
    appendChild(child) { this.children.push(child); return child; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      return this.children.filter(el => selector.startsWith('#') ? el.id === selector.slice(1)
        : selector.startsWith('.') ? el.classList.contains(selector.slice(1)) : el.tagName === selector.toUpperCase());
    }
    contains(el) { return el === this || this.children.includes(el); }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); }
    focus() { context.document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    remove() {}
  }
  context.document.createElement = tag => new Element(tag);
  context.document.body = new Element('body');
  context.document.getElementById = id => byId.get(id) || null;
  context.document.activeElement = new Element('button');
  context.setTimeout = fn => { timers.push(fn); return timers.length; };
  return { byId, timers, Element };
}

test('palette theme and language controls expose native activation and synchronize state', () => {
  const { byId } = fixture();
  const priorSet = LangSwitcher.set, priorToggle = DarkMode.toggle;
  try {
    CommandPalette._buildPanel();
    const language = byId.get('ni-lang-pill'), theme = byId.get('ni-dm-pill');
    assert.equal(language.tagName, 'SELECT');
    assert.equal(theme.tagName, 'BUTTON');
    let chosen, toggles = 0;
    LangSwitcher.set = code => { chosen = code; };
    DarkMode.toggle = () => { toggles++; };
    language.value = 'es'; language.emit('change'); theme.emit('click');
    assert.equal(chosen, 'es'); assert.equal(toggles, 1);
    context.document.body.classList.add('dark'); DarkMode._syncPill();
    assert.equal(theme.getAttribute('aria-pressed'), 'true');
  } finally { LangSwitcher.set = priorSet; DarkMode.toggle = priorToggle; }
});

test('closing the palette before its deferred focus runs keeps focus on the opener', () => {
  const { byId, timers } = fixture();
  CommandPalette._buildPanel();
  const priorSearch = CommandPalette._search;
  CommandPalette._search = () => {};
  CommandPalette._index = [];
  const opener = context.document.activeElement;
  try {
    CommandPalette.open();
    byId.get('ni-cp-input').focus();
    CommandPalette.close();
    for (const timer of timers) timer();
    assert.equal(context.document.activeElement, opener);
  } finally { CommandPalette._search = priorSearch; }
});

test('Time Machine opens with focus and Escape closes with focus return', () => {
  const { byId } = fixture();
  const opener = context.document.activeElement;
  TimeMachine._panel = null; TimeMachine._snapshots = [];
  TimeMachine.openUI();
  assert.equal(context.document.activeElement, byId.get('ni-tm-close-btn'));
  TimeMachine._panel.emit('keydown', { key: 'Escape' });
  assert.equal(TimeMachine._panel.hidden, true);
  assert.equal(context.document.activeElement, opener);
});

test('snapshot comparison exposes buttons and selecting another snapshot updates pressed state', () => {
  fixture();
  const priorPlant = Store.selectedPlant;
  const priorTasks = Store.tasksArr;
  try {
    Store.setSelectedPlant('AUDIT-P', 'test'); Store.setTasks([], 'test');
    TimeMachine._snapshots = [{ plant: 'AUDIT-P', ts: 1, label: 'First', tasks: [] },
      { plant: 'AUDIT-P', ts: 2, label: 'Second', tasks: [] }];
    Diff.showUI();
    const dialog = context.document.body.children.at(-1);
    const rows = dialog.querySelectorAll('.ni-diff-snap-row');
    assert.equal(rows.length, 2);
    assert.equal(rows[1].tagName, 'BUTTON');
    rows[1].emit('click');
    assert.equal(rows[1].getAttribute('aria-pressed'), 'true');
    assert.equal(rows[0].getAttribute('aria-pressed'), 'false');
  } finally { Store.setTasks(priorTasks, 'test'); Store.setSelectedPlant(priorPlant, 'test'); }
});

test('Time Machine refuses stale snapshot restore after a plant switch', () => {
  fixture();
  const priorPlant = Store.selectedPlant, priorTasks = Store.tasksArr, priorToast = nimbus.Toast.show;
  try {
    nimbus.Toast.show = () => {};
    Store.setTasks([{ id: 'other-plant', PLANT: 'P-OTHER', MACHINE: 'OTHER',
      start_date: new Date('2026-01-01T08:00:00'), end_date: new Date('2026-01-01T09:00:00') }], 'test');
    Store.setSelectedPlant('AUDIT-P', 'test');
    TimeMachine._snapshots = [{ plant: 'P-OTHER', ts: 22, label: 'Other plant', tasks: [
      { id: 'other-plant', start_date: new Date('2026-01-02T08:00:00').getTime(), end_date: new Date('2026-01-02T09:00:00').getTime() },
    ] }];
    TimeMachine.restore(22);
    assert.equal(Store.tasks['other-plant'].end_date.getTime(), new Date('2026-01-01T09:00:00').getTime());
  } finally {
    nimbus.Toast.show = priorToast; Store.setTasks(priorTasks, 'test'); Store.setSelectedPlant(priorPlant, 'test');
  }
});

test('snapshot capture and compare include only the selected plant', async () => {
  fixture();
  const prior = { plant: Store.selectedPlant, tasks: Store.tasksArr, put: TimeMachine._IntelDB.put,
    prune: TimeMachine._IntelDB.pruneSnapshots, compute: Diff.compute, snaps: TimeMachine._snapshots };
  try {
    Store.setTasks([{ id: 'local', PLANT: 'AUDIT-P', MACHINE: 'L' }, { id: 'remote', PLANT: 'OTHER-P', MACHINE: 'R' }], 'test');
    Store.setSelectedPlant('AUDIT-P', 'test');
    TimeMachine._IntelDB.put = () => Promise.resolve(1);
    TimeMachine._IntelDB.pruneSnapshots = () => {};
    const snap = TimeMachine.snapshot('Scoped');
    assert.equal(snap.schemaVersion, 2);
    assert.equal(snap.tasks[0].PLANT, 'AUDIT-P');
    assert.deepEqual([...snap.tasks].map(t => t.id), ['local']);
    await Promise.resolve();
    TimeMachine._snapshots = [snap, { ...snap, ts: snap.ts - 1 }];
    let currentIds;
    Diff.compute = (before, current) => { currentIds = [...current].map(t => t.id); return prior.compute(before, current); };
    Diff.showUI();
    assert.deepEqual(currentIds, ['local']);
    context.document.body.children.at(-1).close();
  } finally {
    TimeMachine._IntelDB.put = prior.put; TimeMachine._IntelDB.pruneSnapshots = prior.prune;
    Diff.compute = prior.compute; TimeMachine._snapshots = prior.snaps;
    Store.setTasks(prior.tasks, 'test'); Store.setSelectedPlant(prior.plant, 'test');
  }
});

test('snapshot restore skips protected and distributed rows and records only affected undo IDs', () => {
  fixture();
  const { Engine, UndoStack, Alerts, Toast } = nimbus;
  const prior = { plant: Store.selectedPlant, tasks: Store.tasksArr, firming: Engine.firmingStatus,
    reconcile: Engine.reconcileRestored, schedule: Alerts.scheduleRecompute, show: Toast.show, entries: UndoStack._entries.slice() };
  const messages = [];
  try {
    Engine.firmingStatus = task => ({ firmed: task.id === 'protected', reasons: ['manual'] });
    Engine.reconcileRestored = () => {}; Alerts.scheduleRecompute = () => {};
    Toast.show = (message, tone) => messages.push({ message, tone });
    Store.setTasks(['eligible', 'protected', 'distributed', 'remote'].map(id => ({
      id, PLANT: id === 'remote' ? 'OTHER-P' : 'AUDIT-P', MACHINE: 'L',
      PARENT_ORDER: id === 'distributed' ? 'PARENT' : null,
      end_date: new Date('2031-01-01T09:00:00'),
    })), 'test');
    Store.setSelectedPlant('AUDIT-P', 'test');
    TimeMachine._snapshots = [{ plant: 'AUDIT-P', ts: 33, label: 'Mixed', tasks: Store.tasksArr.map(task => ({
      id: task.id, end_date: new Date('2031-01-02T09:00:00').getTime(), start_date: null,
    })) }];
    TimeMachine.restore(33);
    assert.equal(Store.tasks.eligible.end_date.getTime(), new Date('2031-01-02T09:00:00').getTime());
    for (const id of ['protected', 'distributed', 'remote'])
      assert.equal(Store.tasks[id].end_date.getTime(), new Date('2031-01-01T09:00:00').getTime());
    assert.deepEqual(UndoStack._entries.at(-1).ids, ['eligible']);
    assert.ok(messages.some(m => m.message === 'toast.snapshot_restore_skipped' && m.tone === 'warn'));
    UndoStack._entries.at(-1).undoFn();
    assert.equal(Store.tasks.eligible.end_date.getTime(), new Date('2031-01-01T09:00:00').getTime());
  } finally {
    Engine.firmingStatus = prior.firming; Engine.reconcileRestored = prior.reconcile;
    Alerts.scheduleRecompute = prior.schedule; Toast.show = prior.show; UndoStack._entries = prior.entries;
    Store.setTasks(prior.tasks, 'test'); Store.setSelectedPlant(prior.plant, 'test');
  }
});

test('split snapshot restore preserves requested finish through real Store, current calendar, runtime and Undo', () => {
  fixture();
  const { Engine, UndoStack, Alerts, Toast } = nimbus;
  const plant = 'RESTORE-P', line = 'RESTORE-L';
  const prior = { plant: Store.selectedPlant, master: Store.masterData, tasks: Store.tasksArr,
    clock: Store.plantNow, show: Toast.show, schedule: Alerts.scheduleRecompute,
    entries: UndoStack._entries.slice(), reconcile: Engine.reconcileRestored, calendar: Store.calendars[line], plants: Store.plants };
  const at = (day, hour) => new Date(2031, 0, day, hour);
  try {
    Store.plantNow = () => at(1, 0);
    Toast.show = () => {}; Alerts.scheduleRecompute = () => {};
    Store.setMasterData({ plants: [{ plant, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, split_order_policy: 'partial_allowed' }],
      lines: [{ plant, machine: line }] }, 'test');
    Store.setSelectedPlant(plant, 'test');
    const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [8, 16]]));
    Store.setCalendar(line, hours, 'test');
    Store.replacePlants({ ...prior.plants, [plant]: { workHours: hours } }, 'test');
    CalendarSync._setHydration(plant, 'hydrated', [line]);
    for (const runtime of [6, 2, 10]) {
      Store.setTasks([{ id: 'split', PLANT: plant, MACHINE: line, RUN_TIME: runtime, user_scheduled: true,
        planning_status: 'scheduled', start_date: at(4, 14), end_date: at(5, 12),
        scheduleSegments: [{ sequence: 1, startDate: at(4, 14), endDate: at(4, 16) },
          { sequence: 2, startDate: at(5, 8), endDate: at(5, 12) }] }], 'test');
      const oldSegments = structuredClone(Store.tasks.split.scheduleSegments);
      TimeMachine._snapshots = [{ ts: runtime, plant, label: 'Before', tasks: [
        { id: 'split', start_date: at(6, 10).getTime(), end_date: at(6, 12).getTime() },
      ] }];
      let receivedFinish;
      Engine.reconcileRestored = (ids, dirty) => {
        receivedFinish = Store.tasks.split.end_date.getTime();
        prior.reconcile(ids, dirty);
      };
      TimeMachine.restore(runtime);
      assert.equal(receivedFinish, at(6, 12).getTime(), 'Store must not re-anchor to the old segment envelope');
      assert.equal(Store.tasks.split.end_date.getTime(), at(6, 12).getTime());
      assert.equal(Store.tasks.split.start_date.getTime(), (runtime === 2 ? at(6, 10) : at(5, runtime === 6 ? 14 : 10)).getTime());
      assert.equal(Store.tasks.split.runtime_schedule_mismatch, false, 'real reconcile completed');
      assert.equal(Store.tasks.split.scheduleSegments.length, runtime === 2 ? 0 : 2);
      UndoStack._entries.at(-1).undoFn();
      if (runtime === 6) assert.deepEqual(Store.tasks.split.scheduleSegments, oldSegments, 'Undo restores the prior valid aggregate');
      else assert.equal(Store.tasks.split.start_date.getTime(), (runtime === 2 ? at(5, 10) : at(4, 10)).getTime(),
        'after a runtime change Undo preserves the prior finish and derives using current runtime');
      assert.equal(Store.tasks.split.end_date.getTime(), at(5, 12).getTime());
    }
  } finally {
    Engine.reconcileRestored = prior.reconcile; Store.plantNow = prior.clock;
    Toast.show = prior.show; Alerts.scheduleRecompute = prior.schedule; UndoStack._entries = prior.entries;
    delete CalendarSync._hydration[plant];
    if (prior.calendar) Store.calendars[line] = prior.calendar; else delete Store.calendars[line];
    Store.replacePlants(prior.plants, 'test');
    Store.setMasterData(prior.master, 'test'); Store.setTasks(prior.tasks, 'test'); Store.setSelectedPlant(prior.plant, 'test');
  }
});

test('legacy comparison excludes other plants, preserves known removals and discloses unresolved scope', () => {
  const { byId } = fixture();
  const prior = { plant: Store.selectedPlant, master: Store.masterData, tasks: Store.tasksArr, compute: Diff.compute };
  try {
    Store.setMasterData({ plants: [{ plant: 'P' }, { plant: 'OTHER' }],
      lines: [{ plant: 'P', machine: 'L' }, { plant: 'OTHER', machine: 'R' },
        { plant: 'P', machine: 'AMBIGUOUS' }, { plant: 'OTHER', machine: 'AMBIGUOUS' }] }, 'test');
    Store.setTasks([{ id: 'local', PLANT: 'P', MACHINE: 'L' }, { id: 'remote', PLANT: 'OTHER', MACHINE: 'R' }], 'test');
    Store.setSelectedPlant('P', 'test');
    const historical = [{ id: 'local', MACHINE: 'L' }, { id: 'remote', MACHINE: 'R' },
      { id: 'removed-local', MACHINE: 'L' }, { id: 'unknown', MACHINE: 'MISSING' },
      { id: 'ambiguous', MACHINE: 'AMBIGUOUS' }, { id: 'explicit-local', PLANT: 'P', MACHINE: 'MISSING' }]
      .map(task => ({ ...task, start_date: null, end_date: null }));
    TimeMachine._snapshots = [1, 2].map(ts => ({ ts, plant: 'P', tasks: historical }));
    let result;
    Diff.compute = (before, current) => { result = prior.compute(before, current); return result; };
    Diff.showUI();
    assert.deepEqual([...result.removed].map(task => task.id).sort(), ['explicit-local', 'removed-local']);
    assert.equal(result.added.length, 0);
    assert.equal(result.moved.length, 0);
    assert.match(byId.get('ni-diff-out').innerHTML, /intel.snapshot_scope_unknown/);
    context.document.body.children.at(-1).close();
    TimeMachine._snapshots = [3, 4].map(ts => ({ ts, plant: 'P', tasks: historical.slice(0, 2).concat(historical[3]) }));
    Diff.showUI();
    assert.equal(result.removed.length, 0, 'unchanged legacy other-plant row is not a removal');
    assert.doesNotMatch(byId.get('ni-diff-out').innerHTML, /identical/, 'unknown history cannot support an identical claim');
    context.document.body.children.at(-1).close();
  } finally {
    Diff.compute = prior.compute; Store.setMasterData(prior.master, 'test');
    Store.setTasks(prior.tasks, 'test'); Store.setSelectedPlant(prior.plant, 'test');
  }
});

test('command search finds the final selected-plant order at 10000 rows with bounded results', t => {
  const { byId } = fixture();
  const prior = { tasks: Store.tasksArr, plant: Store.selectedPlant, render: CommandPalette._render };
  try {
    const tasks = Array.from({ length: 10000 }, (_, i) => ({ id: `scale-${i}`, PLANT: 'SEARCH-P', MACHINE: 'L',
      PRODUCTION_ORDER: `ORDER-${String(i).padStart(5, '0')}`, text: `Product ${i}` }));
    tasks.unshift({ id: 'wrong-plant', PLANT: 'OTHER', MACHINE: 'R', PRODUCTION_ORDER: 'OTHER-ONLY-12345' });
    Store.setTasks(tasks, 'test'); Store.setSelectedPlant('SEARCH-P', 'test');
    CommandPalette._buildPanel();
    CommandPalette._render = () => {};
    const indexStart = performance.now(); CommandPalette._buildIndex(); const indexMs = performance.now() - indexStart;
    const searchStart = performance.now(); CommandPalette._search('ORDER-09999'); const searchMs = performance.now() - searchStart;
    assert.ok(CommandPalette._results.some(row => row.id === 'scale-9999'));
    assert.equal(CommandPalette._index.filter(row => row.type === 'order').length, 10000);
    assert.ok(!CommandPalette._index.some(row => row.id === 'wrong-plant'));
    assert.equal(CommandPalette._index.filter(row => row.type === 'line').length, 2,
      'only the selected plant line has Go to and Isolate actions');
    CommandPalette._search('ORDER');
    assert.ok(CommandPalette._results.length <= 9);
    prior.render();
    assert.ok(byId.get('ni-cp-results').querySelectorAll('.ni-cp-result').length <= 9);
    assert.ok(CommandPalette._index.some(row => row.type === 'action'), 'action catalog retained');
    t.diagnostic(`10000-order production index ${indexMs.toFixed(2)}ms; exact search ${searchMs.toFixed(2)}ms (Node fixture, no DOM rendering)`);
  } finally {
    CommandPalette._render = prior.render; CommandPalette._index = null;
    Store.setTasks(prior.tasks, 'test'); Store.setSelectedPlant(prior.plant, 'test');
  }
});
