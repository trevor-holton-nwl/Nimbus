// Wave 1 (S5-1/S5-2/S5-3/S6-7/S10-3): alert change scoping, one undo entry per manual placement edit, note save failures.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Table, Inspector, manualEditKind, shouldAdoptNoteVersion } from '../../../frontend/scheduling/orders.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';

if (typeof globalThis.document === 'undefined') {
  globalThis.document = { getElementById() { return null; }, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, body: { appendChild() {} } };
}
globalThis.window = globalThis.window || {};

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || require('../../../frontend/nimbus-compute-core.js');

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const REAL_OFFSET = Store.serverOffsetMs;
afterEach(() => { Store.serverOffsetMs = REAL_OFFSET; Store._blockedPlants.clear(); });

function setup(plant, line, id) {
  const priorMaster = Store.masterData;
  Store.setMasterData({ ...priorMaster, plants: [...(priorMaster?.plants || []).filter(p => p.plant !== plant), { plant, timezone: LOCAL_TZ }], lines: priorMaster?.lines || [] }, 'unit-test');
  Store.serverOffsetMs = new Date('2026-08-01T00:00:00').getTime() - Date.now();
  Store._blockedPlants.clear();
  const priorPlant = Store.selectedPlant;
  const priorRecompute = Alerts.scheduleRecompute;
  const priorRecomputeLines = Alerts.scheduleRecomputeLines;
  Alerts.scheduleRecompute = () => {}; Alerts.scheduleRecomputeLines = () => {};
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([{ id, PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: new Date('2026-08-25T08:00:00'), end_date: new Date('2026-08-25T10:00:00') }], 'unit-test');
  const undoBefore = UndoStack._entries.length;
  return { undoBefore, restore() {
    UndoStack._entries.length = undoBefore;
    Alerts.scheduleRecompute = priorRecompute; Alerts.scheduleRecomputeLines = priorRecomputeLines;
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setMasterData(priorMaster, 'unit-test');
  } };
}

test('Store.setAlerts: no change emits [] , a severity flip names the order, dismiss stays unscoped', () => {
  const events = [];
  const unsub = Store.subscribe(e => { if (e.type === 'alerts:change') events.push(e.changedIds); }, 'test');
  const prior = Store.alerts;
  try {
    Store.setAlerts([{ id: 'late-1', sev: 'warn', type: 'late', taskId: 't1' }], 'test');
    Store.setAlerts([{ id: 'late-1', sev: 'warn', type: 'late', taskId: 't1' }], 'test');
    Store.setAlerts([{ id: 'late-1', sev: 'err', type: 'late', taskId: 't1' }], 'test');
    Store.dismissAlert('late-1', 'test');
    assert.deepEqual(events[0], ['t1']);
    assert.deepEqual(events[1], [], 'no change is an empty array, not undefined');
    assert.deepEqual(events[2], ['t1'], 'warn -> err on the same type is a change');
    assert.equal(events[3], undefined, 'dismiss is unscoped');
  } finally { unsub(); Store.setAlerts(prior, 'test'); }
});

test('Table skips a row refresh for an empty alerts:change and refreshes only the named rows', () => {
  const s = setup('P-UNDO-A', 'LA', 'ua1');
  const prior = Table._api;
  const tx = [];
  Table._api = { applyTransaction: x => tx.push(x), onFilterChanged: () => {}, refreshCells: () => {} };
  try {
    Table._onStore({ type: 'alerts:change', changedIds: [] });
    assert.equal(tx.length, 0);
    Table._onStore({ type: 'alerts:change', changedIds: ['ua1'] });
    assert.equal(tx.length, 1);
    assert.equal(tx[0].update.length, 1);
    Table._onStore({ type: 'alerts:change' });
    assert.equal(tx.length, 2, 'absent changedIds still refreshes the plant');
  } finally { Table._api = prior; s.restore(); }
});

test('pure helpers', () => {
  assert.equal(manualEditKind('end_date'), 'finish');
  assert.equal(manualEditKind('MACHINE'), 'machine');
  assert.equal(manualEditKind('RUN_TIME'), 'runtime');
  assert.equal(manualEditKind('PRT_01'), null);
  assert.equal(shouldAdoptNoteVersion(3, 3, 'a', 'a'), true);
  assert.equal(shouldAdoptNoteVersion(4, 3, 'a', 'a'), false);
  assert.equal(shouldAdoptNoteVersion(3, 3, 'b', 'a'), false);
  assert.equal(shouldAdoptNoteVersion(3, 3, undefined, null), true);
});

test('Inspector typed finish pushes exactly one undo entry; Ctrl+Z restores the old finish and start', () => {
  const s = setup('P-UNDO-B', 'LB', 'ub1');
  const priorId = Inspector._currentId;
  try {
    Inspector._currentId = 'ub1';
    Inspector._onFieldChange('end_date', '2026-08-25 09:00');
    assert.equal(UndoStack._entries.length, s.undoBefore + 1);
    assert.equal(Store.tasks.ub1.end_date.getTime(), new Date('2026-08-25T09:00:00').getTime());
    UndoStack.pop();
    assert.equal(Store.tasks.ub1.end_date.getTime(), new Date('2026-08-25T10:00:00').getTime());
    assert.equal(Store.tasks.ub1.start_date.getTime(), new Date('2026-08-25T08:00:00').getTime());
  } finally { Inspector._currentId = priorId; s.restore(); }
});

test('Inspector invalid date pushes nothing', () => {
  const s = setup('P-UNDO-C', 'LC', 'uc1');
  const priorId = Inspector._currentId;
  const priorShow = Toast.show; Toast.show = () => {};
  try {
    Inspector._currentId = 'uc1';
    Inspector._onFieldChange('end_date', 'not a date');
    assert.equal(UndoStack._entries.length, s.undoBefore);
  } finally { Toast.show = priorShow; Inspector._currentId = priorId; s.restore(); }
});

test('Inspector run time edit pushes one undo entry and undo restores RUN_TIME', () => {
  const s = setup('P-UNDO-D', 'LD', 'ud1');
  const priorId = Inspector._currentId;
  try {
    Inspector._currentId = 'ud1';
    Inspector._onFieldChange('RUN_TIME', '3');
    assert.equal(UndoStack._entries.length, s.undoBefore + 1);
    UndoStack.pop();
    assert.equal(Number(Store.tasks.ud1.RUN_TIME), 2);
  } finally { Inspector._currentId = priorId; s.restore(); }
});

test('Grid typed finish pushes one undo entry whose snapshot holds the OLD finish', () => {
  const s = setup('P-UNDO-E', 'LE', 'ue1');
  const prior = Table._api;
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  try {
    const row = Store.tasks.ue1;
    const oldEnd = row.end_date;
    row.end_date = new Date('2026-08-25T09:00:00');   // AG Grid writes the typed value onto the row first
    Table._onCellChanged({ colDef: { field: 'end_date' }, data: row, newValue: row.end_date, oldValue: oldEnd, node: {} });
    assert.equal(UndoStack._entries.length, s.undoBefore + 1);
    UndoStack.pop();
    assert.equal(Store.tasks.ue1.end_date.getTime(), oldEnd.getTime());
    assert.equal(Store.tasks.ue1.start_date.getTime(), new Date('2026-08-25T08:00:00').getTime());
  } finally { Table._api = prior; s.restore(); }
});

test('Grid finish / run time edit on an already-dirty row: the undo snapshot keeps its "was dirty" mark (F10 must not discard it)', () => {
  const s = setup('P-UNDO-G', 'LG', 'ug1');
  const prior = Table._api, priorProbe = UndoStack.dirtyProbe, priorAfter = UndoStack.afterRestore;
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  UndoStack.dirtyProbe = id => id === 'ug1';   // the row carries an unsaved edit (e.g. a PRT_01 change) before the grid edit
  try {
    for (const field of ['end_date', 'RUN_TIME']) {
      const row = Store.tasks.ug1;
      const oldValue = row[field];
      row[field] = field === 'end_date' ? new Date('2026-08-25T09:00:00') : '3';
      Table._onCellChanged({ colDef: { field }, data: row, newValue: row[field], oldValue, node: {} });
      const seen = [];
      UndoStack.afterRestore = (ids, wasDirty) => seen.push([...wasDirty]);
      UndoStack.pop();
      assert.deepEqual(seen, [['ug1']], field + ': the restored snapshot row still carries the dirty marker');
    }
  } finally { UndoStack.dirtyProbe = priorProbe; UndoStack.afterRestore = priorAfter; Table._api = prior; s.restore(); }
});

test('a note save that adopts the new row_version moves the saved baseline only when it sat at the sent version', async () => {
  const s = setup('P-UNDO-H', 'LH', 'uh1');
  const priorFetch = Util.fetchTraced;
  Util.fetchTraced = (url, init) => Promise.resolve({ ok: true, json: async () => ({ versions: { [JSON.parse(init.body).id]: 9 } }) });
  try {
    Store.tasks.uh1.row_version = 5; Store.tasks.uh1.notes = 'n';
    Persistence._savedBaseline.set('uh1', { version: 5, key: 'K' });
    await Inspector._sendNote('uh1', 'n', false);
    assert.equal(Store.tasks.uh1.row_version, 9);
    assert.deepEqual(Persistence._savedBaseline.get('uh1'), { version: 9, key: 'K' }, 'the note does not change the saved content, so the baseline follows the version');
    // A baseline from some OTHER version is not the state this note was written on: it stays, and the row can never settle on it.
    Store.tasks.uh1.row_version = 5;
    Persistence._savedBaseline.set('uh1', { version: 3, key: 'K' });
    await Inspector._sendNote('uh1', 'n', false);
    assert.deepEqual(Persistence._savedBaseline.get('uh1'), { version: 3, key: 'K' });
  } finally { Util.fetchTraced = priorFetch; Persistence._savedBaseline.clear(); s.restore(); }
});

test('Grid invalid typed finish pushes nothing and restores the cell', () => {
  const s = setup('P-UNDO-F', 'LF', 'uf1');
  const prior = Table._api;
  const priorShow = Toast.show; Toast.show = () => {};
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  try {
    const row = Store.tasks.uf1;
    const oldEnd = row.end_date;
    row.end_date = null;
    Table._onCellChanged({ colDef: { field: 'end_date' }, data: row, newValue: 'garbage', oldValue: oldEnd, node: {} });
    assert.equal(UndoStack._entries.length, s.undoBefore);
    assert.equal(row.end_date, oldEnd);
  } finally { Toast.show = priorShow; Table._api = prior; s.restore(); }
});

test('note save failure warns, queues a retry, and a later success clears it; row_version adoption is guarded', async () => {
  const s = setup('P-UNDO-G', 'LG', 'ug1');
  const priorFetch = Util.fetchTraced;
  const priorShow = Toast.show;
  const toasts = [];
  Toast.show = (m, type) => toasts.push([m, type]);
  const calls = [];
  let failNext = true;
  Util.fetchTraced = (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, keepalive: init.keepalive });
    if (failNext) return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: true, json: async () => ({ versions: { [body.id]: 9 } }) });
  };
  try {
    Store.tasks.ug1.row_version = 5;
    assert.equal(await Inspector._sendNote('ug1', 'hello', false), false);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][1], 'warn');
    assert.equal(Inspector._noteRetry.ug1, 'hello');
    failNext = false;
    assert.equal(await Inspector._sendNote('ug1', 'hello', false), true);
    assert.equal('ug1' in Inspector._noteRetry, false);
    assert.equal(Store.tasks.ug1.row_version, 5, 'task notes differ from the sent text, so the version is not adopted');
    Store.tasks.ug1.notes = 'hello';
    await Inspector._sendNote('ug1', 'hello', false);
    assert.equal(Store.tasks.ug1.row_version, 9);
    Inspector._noteRetry.ug1 = 'again';
    calls.length = 0;
    Inspector._flushNotes();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].keepalive, true);
    await new Promise(r => setTimeout(r, 0));
  } finally { Util.fetchTraced = priorFetch; Toast.show = priorShow; delete Inspector._noteRetry.ug1; s.restore(); }
});
