import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast, ErrorLog } from '../../../frontend/platform/foundation.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';

globalThis.window = {};
globalThis.document = { getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
Toast.show = () => {};
ErrorLog.info = ErrorLog.warn = ErrorLog.error = () => {};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const row = (id = 'A') => ({ id, MACHINE: 'L2', PRT_01: 'NEW', PRT_02: null,
  PRODUCTION_VERSION: '0002', RUN_TIME: 2, row_version: 2,
  run_time_source: 'routing', run_time_basis: { quantity: 20 },
  start_date: '2026-10-01T08:00:00', end_date: '2026-10-01T10:00:00',
  planning_status: 'scheduled', planning_reason: null, schedule_segments: [] });
const response = data => ({ ok: true, json: async () => data });
function edit(hour) {
  Store.updateTask('A', { start_date: new Date(`2026-10-01T${hour}:00:00`),
    end_date: new Date(`2026-10-01T${Number(hour) + 1}:00:00`) }, 'table');
  Persistence._dirtyIds.add('A');
}
beforeEach(() => {
  Store.setSelectedPlant('P', 'test');
  Store.setMasterData({ plants: [{ plant: 'P', routing_runtime_enabled: true }], lines: [] }, 'test');
  Runtime._rateMap = null; Runtime._rateMapPlant = null;
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  Store.setTasks(['A', 'B'].map(id => ({ id, PLANT: 'P', MACHINE: 'L1', PRT_01: 'OLD', PRT_02: 'OLD2',
    PRODUCTION_VERSION: '0001', RUN_TIME: 1, row_version: 1, planning_status: 'scheduled',
    start_date: new Date('2026-10-01T08:00:00'), end_date: new Date('2026-10-01T09:00:00') })), 'persistence');
});

for (const scenario of ['unchanged', 'newer edit', 'atomic optimizer']) {
  test(`changed routing preview reloads rates and safely handles ${scenario}`, async () => {
    const requests = [];
    Util.fetchTraced = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
    edit('10');
    if (scenario === 'atomic optimizer') Persistence._forceIds.add('A');
    Persistence.saveAll();
    if (scenario === 'newer edit') edit('11');
    requests[0].resolve(response({ stale: ['A'], rejection_reasons: { A: 'runtime_preview_changed' },
      versions: {}, updated: 1, persisted: 0 }));
    await tick();
    const rates = requests.find(request => request.url.endsWith('/routing/P/rate-map'));
    assert.ok(rates, 'rejected preview must invalidate and reload the selected plant rate map');
    rates.resolve(response({ plant: 'P', generated_at: 'now', machines: {}, pv: {}, ops: {} }));
    const refresh = requests.find(request => request.url.endsWith('/tasks/refresh'));
    if (scenario === 'atomic optimizer') {
      assert.equal(refresh, undefined, 'atomic failure must retain every dependent edit');
    } else {
      assert.ok(refresh);
      refresh.resolve(response({ data: [row()], missing: [] }));
    }
    await tick();
    assert.equal(Runtime._rateMapPlant, 'P');
    assert.equal(Store.tasks.A.row_version, scenario === 'unchanged' ? 2 : 1);
    assert.equal(Store.tasks.A.start_date.getHours(), scenario === 'unchanged' ? 8 : scenario === 'newer edit' ? 11 : 10);
    assert.equal(Persistence._dirtyIds.has('A'), scenario !== 'unchanged');
    if (scenario === 'atomic optimizer') assert.equal(Persistence._forceIds.has('A'), true);
  });
}

test('refresh replaces every saved attribute with the authoritative aggregate before the next save', async () => {
  Util.fetchTraced = async () => response({ data: [row()], missing: [] });
  Persistence._dirtyIds.add('A');
  Persistence._refreshTasks(['A']); await tick();
  const task = Store.tasks.A;
  assert.equal(task.MACHINE, 'L2'); assert.equal(task.PRT_01, 'NEW'); assert.equal(task.PRT_02, '');
  assert.equal(task.PRODUCTION_VERSION, '0002'); assert.equal(task.RUN_TIME, 2);
  assert.equal(task.run_time_source, 'routing'); assert.deepEqual(task.run_time_basis, { quantity: 20 });
  assert.equal(task.row_version, 2); assert.equal(Persistence._dirtyIds.has('A'), false);
  let sent;
  Util.fetchTraced = async (_url, options) => { sent = JSON.parse(options.body); return response({ versions: { A: 3 }, persisted: 1, updated: 1 }); };
  edit('11'); Persistence.saveAll(); await tick();
  assert.equal(sent.tasks[0].MACHINE, 'L2'); assert.equal(sent.tasks[0].base_version, 2);
});

test('refresh preserves unknown runtime as null in the next save payload', async () => {
  Util.fetchTraced = async () => response({ data: [{ ...row(), RUN_TIME: null }], missing: [] });
  Persistence._refreshTasks(['A']); await tick();
  assert.equal(Persistence._taskEditSnapshot(Store.tasks.A).RUN_TIME, null);
});

for (const timing of ['before refresh dispatch', 'during refresh', 'edit and revert during refresh']) {
  test(`conflict preserves newer edits ${timing} without rebasing the version`, async () => {
    const requests = [];
    Util.fetchTraced = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
    edit('10'); Persistence.saveAll();
    if (timing === 'before refresh dispatch') edit('11');
    requests[0].resolve(response({ stale: ['A'], versions: {}, updated: 1, persisted: 0 })); await tick();
    if (timing !== 'before refresh dispatch') edit('11');
    if (timing === 'edit and revert during refresh') edit('10');
    const intendedStart = +Store.tasks.A.start_date;
    requests[1].resolve(response({ data: [row()], missing: [] })); await tick();
    assert.equal(+Store.tasks.A.start_date, intendedStart);
    assert.equal(Store.tasks.A.row_version, 1);
    assert.equal(Store.tasks.A.PRT_01, 'OLD');
    assert.equal(Persistence._dirtyIds.has('A'), true);
    Persistence.saveAll(); await tick();
    assert.equal(requests.length, 2, 'unresolved local data must not be retransmitted');
  });
}

for (const failure of ['HTTP rejection', 'network failure']) test(`${failure} during conflict refresh keeps the edit dirty and prevents blind retry`, async () => {
  const calls = [];
  Util.fetchTraced = async url => {
    calls.push(url);
    if (url.endsWith('/tasks/update')) return response({ stale: ['A'], versions: {}, updated: 1, persisted: 0 });
    if (failure === 'network failure') throw new Error('offline');
    return { ok: false, status: 503 };
  };
  edit('10'); Persistence.saveAll(); await tick();
  assert.equal(Persistence._dirtyIds.has('A'), true);
  assert.equal(Store.tasks.A.row_version, 1);
  Persistence.saveAll(); await tick(); assert.equal(calls.length, 2);
});

test('unresolved conflict permits unrelated normal saves but blocks a dependent optimizer batch', async () => {
  let resolveRefresh;
  Util.fetchTraced = () => new Promise(resolve => { resolveRefresh = resolve; });
  Persistence._refreshTasks(['A']); edit('11');
  resolveRefresh(response({ data: [row()], missing: [] })); await tick();
  const sent = [];
  Util.fetchTraced = async (_url, options) => { sent.push(JSON.parse(options.body)); return response({ versions: { B: 2 }, updated: 1, persisted: 1 }); };
  Persistence._dirtyIds.add('B'); Persistence.saveAll(); await tick();
  assert.deepEqual(sent[0].tasks.map(t => t.id), ['B']);
  Persistence._dirtyIds.add('B'); Persistence._forceIds.add('B'); Persistence.saveAll(); await tick();
  assert.equal(sent.length, 1);
});

test('a late conflict response cannot overwrite a newly loaded schedule', async () => {
  let resolveRefresh;
  Util.fetchTraced = () => new Promise(resolve => { resolveRefresh = resolve; });
  Persistence._refreshTasks(['A']);
  Store.setTasks([{ ...Store.tasks.A, MACHINE: 'L3', row_version: 9 }], 'persistence');
  resolveRefresh(response({ data: [row()], missing: [] })); await tick();
  assert.equal(Store.tasks.A.MACHINE, 'L3'); assert.equal(Store.tasks.A.row_version, 9);
});

test('remote deletion during refresh retains newer local work until explicit reload', async () => {
  let resolveRefresh;
  Util.fetchTraced = () => new Promise(resolve => { resolveRefresh = resolve; });
  Persistence._refreshTasks(['A']); edit('11');
  resolveRefresh(response({ data: [], missing: ['A'] })); await tick();
  assert.ok(Store.tasks.A); assert.equal(Persistence._dirtyIds.has('A'), true);
  let calls = 0;
  Util.fetchTraced = async () => { calls++; return response({ versions: { A: 10 }, updated: 1, persisted: 1 }); };
  Persistence.saveAll(); await tick(); assert.equal(calls, 0);
  // The backend reload replaces the task collection through this Store call.
  Store.setTasks([{ ...Store.tasks.A, row_version: 9 }], 'persistence');
  edit('12'); Persistence.saveAll(); await tick(); assert.equal(calls, 1);
});

for (const identical of [true, false]) {
  test(`U25: a stale reply whose server row ${identical ? 'already holds this client\'s placement reconciles silently' : 'differs is a real conflict with a toast'}`, async () => {
    const toasts = [];
    const priorShow = Toast.show;
    Toast.show = (msg, kind) => { toasts.push(`${msg}|${kind}`); };
    try {
      const requests = [];
      Util.fetchTraced = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
      edit('10');
      Store.tasks.A.user_scheduled = true;          // a placement is what a cutover reconcile saves
      Persistence.saveAll();
      const sent = JSON.parse(requests[0].options.body).tasks[0];
      assert.equal(sent.start_date, '2026-10-01T10:00:00');
      requests[0].resolve(response({ stale: ['A'], versions: {}, updated: 1, persisted: 0 }));
      await tick();
      const refresh = requests.find(request => request.url.endsWith('/tasks/refresh'));
      refresh.resolve(response({ data: [{ ...row(), MACHINE: 'L1', PRT_01: 'OLD', PRT_02: 'OLD2', PRODUCTION_VERSION: '0001', RUN_TIME: 1,
        row_version: 5, user_scheduled: true,
        start_date: identical ? '2026-10-01T10:00:00' : '2026-10-01T12:00:00',
        end_date: identical ? '2026-10-01T11:00:00' : '2026-10-01T13:00:00' }], missing: [] }));
      await tick(); await tick();
      assert.equal(Store.tasks.A.row_version, 5, 'the server row is applied either way');
      assert.equal(Persistence._conflictedIds.has('A'), false);
      const conflictToasts = toasts.filter(x => x.startsWith('toast.concurrent_edit_conflict'));
      assert.equal(conflictToasts.length, identical ? 0 : 1);
    } finally { Toast.show = priorShow; }
  });
}
