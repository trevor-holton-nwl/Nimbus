import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { Util, Toast, ErrorLog } from '../../../frontend/platform/foundation.mjs';

const hours = { 1: [8, 16] };
const laterHours = { 1: [9, 17] };
const pendingKey = 'nimbus.calendar.pendingDeletes';
let storage;
let calls;
let restoreGlobals;
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
// Mark only the known assertion as TODO. Setup errors or changed failure shapes
// fail normally; an unexpected pass also fails so the marker must be removed.
function knownFailure(t, reason, check, actual, expected) {
  try {
    check();
  } catch (error) {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.deepEqual(error.actual, actual);
    assert.deepEqual(error.expected, expected);
    t.todo(reason);
    throw error;
  }
  assert.fail(`Known defect no longer reproduces; remove expected-failure wrapper: ${reason}`);
}
const block = (id = 'b', plant = 'P1', line = 'L1') => ({
  id, plant, line, start: new Date('2031-01-06T09:00:00Z'), end: new Date('2031-01-06T10:00:00Z'), reason: 'maintenance',
});

beforeEach(t => {
  storage = new Map();
  calls = [];
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
  restoreGlobals = () => { if (prior) Object.defineProperty(globalThis, 'localStorage', prior); else delete globalThis.localStorage; };
  t.mock.method(Util, 'fetchTraced', async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => ({}) };
  });
  t.mock.method(Util, 't', key => key);
  t.mock.method(Toast, 'show', () => {});
  for (const method of ['warn', 'error', 'info']) t.mock.method(ErrorLog, method, () => {});
  CalendarSync._hydrating = false;
  CalendarSync._pendingLineHours = {};
  CalendarSync._whDebounce = {};
  CalendarSync._deferredHydrationPlant = null;
  Sandbox.active = false;
  Store.setTasks([], 'test');
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  Store.setMasterData({ plants: [{ plant: 'P1' }, { plant: 'P2' }], lines: [
    { machine: 'L1', plant: 'P1' }, { machine: 'L2', plant: 'P2' },
  ] }, 'test');
});

afterEach(() => {
  for (const timer of Object.values(CalendarSync._whDebounce)) clearTimeout(timer);
  CalendarSync._hydrating = false;
  Sandbox.active = false;
  Sandbox._snapshot = null;
  restoreGlobals();
});

test('discarding What-If before the debounce expires must not persist its speculative hours', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Store.setCalendar('L1', hours, 'test');
  assert.equal(Sandbox.enter('test'), true);
  Store.setCalendar('L1', laterHours, 'test');
  CalendarSync.saveLineHours('P1', 'L1', laterHours);
  Sandbox.exit(false, 'test');
  assert.deepEqual(Store.calendars.L1.workHours, hours);
  t.mock.timers.tick(600);
  await settle();
  assert.deepEqual(calls[0]?.body, { plant: 'P1', lines: [{ machine: 'L1', work_hours: laterHours }] });
  knownFailure(t,
    'saveLineHours queues during What-If; after discard the delayed _post writes discarded hours.',
    () => assert.equal(calls.length, 0, 'discarded What-If calendar changes must never reach the backend'), 1, 0);
});

for (const kind of ['line', 'plant']) {
  test(`a speculative ${kind} blackout upsert must preserve a live pending-delete tombstone after discard`, async t => {
    CalendarSync._trackPendingDeletes('P1', kind, ['b'], true);
    const before = storage.get(pendingKey);
    Sandbox.enter('test');
    if (kind === 'line') await CalendarSync.saveLineBlackoutUpsert(block());
    else await CalendarSync.savePlantBlackoutUpsert(block());
    Sandbox.exit(false, 'test');
    assert.equal(calls.length, 0);
    knownFailure(t,
      'Upsert clears durable pending deletes before checking Sandbox.active; discarded recreation loses the live delete.',
      () => assert.equal(storage.get(pendingKey), before, 'What-If must not alter the durable live delete queue'), undefined, before);
  });
}

test('70 line edits coalesce into one request at the debounce boundary', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 70; i++) CalendarSync.saveLineHours('P1', `L${i}`, hours);
  t.mock.timers.tick(599);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.lines.length, 70);
  assert.equal(new Set(calls[0].body.lines.map(row => row.machine)).size, 70);
  assert.deepEqual(CalendarSync._pendingLineHours, {});
});

test('repeated line edits reset the timer and send the last hours once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  CalendarSync.saveLineHours('P1', 'L1', hours);
  t.mock.timers.tick(500);
  CalendarSync.saveLineHours('P1', 'L1', laterHours);
  t.mock.timers.tick(599);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(calls.map(call => call.body), [{ plant: 'P1', lines: [{ machine: 'L1', work_hours: laterHours }] }]);
});

test('plants debounce independently without postponing each other', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  CalendarSync.saveLineHours('P1', 'L1', hours);
  t.mock.timers.tick(300);
  CalendarSync.saveLineHours('P2', 'L2', laterHours);
  t.mock.timers.tick(300);
  assert.deepEqual(calls.map(call => call.body.plant), ['P1']);
  t.mock.timers.tick(300);
  await settle();
  assert.deepEqual(calls.map(call => call.body.plant), ['P1', 'P2']);
});

test('an edit arriving during a flush gets a separate pending batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  Util.fetchTraced.mock.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  CalendarSync.saveLineHours('P1', 'L1', hours);
  const first = CalendarSync._flushLineHours('P1');
  CalendarSync.saveLineHours('P1', 'L1', laterHours);
  resolve({ ok: true });
  await first;
  t.mock.timers.tick(600);
  await settle();
  const writes = Util.fetchTraced.mock.calls;
  assert.equal(writes.length, 2, 'both the in-flight original and subsequent edit must be sent exactly once');
  assert.ok(writes.every(call => String(call.arguments[0]).endsWith('/plant-calendar/line-hours')));
  assert.deepEqual(writes.map(call => JSON.parse(call.arguments[1].body)), [
    { plant: 'P1', lines: [{ machine: 'L1', work_hours: hours }] },
    { plant: 'P1', lines: [{ machine: 'L1', work_hours: laterHours }] },
  ]);
  assert.deepEqual(CalendarSync._pendingLineHours, {}, 'both batches must be drained after their flush');
});

for (const guard of ['sandbox', 'hydrating']) {
  test(`${guard} suppresses every immediate write and leaves no pending deletes`, async () => {
    Sandbox.active = guard === 'sandbox';
    CalendarSync._hydrating = guard === 'hydrating';
    const results = await Promise.all([
      CalendarSync.savePlantHours('P1', hours), CalendarSync.saveLineBlackoutUpsert(block()),
      CalendarSync.savePlantBlackoutUpsert(block()), CalendarSync.saveLineBlackoutDelete('P1', 'b'),
      CalendarSync.savePlantBlackoutDelete('P1', 'p'),
    ]);
    assert.ok(results.every(result => result.ok && result.skipped));
    assert.equal(calls.length, 0);
    assert.equal(storage.has(pendingKey), false);
  });
}

test('sandbox hydration records deferred plant without changing live calendars or blocks', () => {
  Store.setCalendar('L1', hours, 'test');
  Store.replaceBlocks([block()], 'test');
  Sandbox.active = true;
  CalendarSync._applyConfig('P1', { line_work_hours: { L1: laterHours }, machine_blackouts: [{ ...block('remote'), machine: 'L1' }] });
  assert.deepEqual(Store.calendars.L1.workHours, hours);
  assert.deepEqual(Store.blocks.map(b => b.id), ['b']);
  assert.equal(CalendarSync._deferredHydrationPlant, 'P1');
  assert.equal(calls.length, 0);
});

test('nonempty backend slices replace one plant while retaining other plant state and block array identity', async () => {
  Store.setCalendar('L1', hours, 'test');
  Store.setCalendar('L2', laterHours, 'test');
  Store.replaceBlocks([block('old'), block('other', 'P2', 'L2')], 'test');
  Store.replacePlantBlocks([block('old-plant'), block('other-plant', 'P2')], 'test');
  const blocks = Store.blocks;
  const plantBlocks = Store.plantBlocks;
  CalendarSync._applyConfig('P1', {
    plant_work_hours: laterHours, line_work_hours: { L1: laterHours },
    machine_blackouts: [{ ...block('new'), machine: 'L1' }], plant_blackouts: [block('new-plant')],
  });
  await settle();
  assert.equal(Store.blocks, blocks);
  assert.equal(Store.plantBlocks, plantBlocks);
  assert.deepEqual(Store.blocks.map(b => b.id), ['other', 'new']);
  assert.deepEqual(Store.plantBlocks.map(b => b.id), ['other-plant', 'new-plant']);
  assert.deepEqual(Store.calendars.L2.workHours, laterHours);
  assert.deepEqual(Store.calendars.L1.workHours, laterHours);
  assert.ok(Store.blocks[1].start instanceof Date);
  assert.equal(calls.length, 0);
});

test('failed fetch preserves local calendar and reports offline fallback', async () => {
  Store.setCalendar('L1', hours, 'test');
  Util.fetchTraced.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
  await CalendarSync.fetchPlantConfig('P1');
  assert.deepEqual(Store.calendars.L1.workHours, hours);
  assert.equal(Toast.show.mock.calls[0].arguments[0], 'toast.calendar_offline_cache');
  assert.equal(CalendarSync._hydrating, false);
});

for (const status of [400, 409, 429, 503]) {
  test(`HTTP ${status} returns a failed write with the appropriate recovery action`, async () => {
    Util.fetchTraced.mock.mockImplementationOnce(async () => ({ ok: false, status }));
    assert.deepEqual(await CalendarSync.savePlantHours('P1', hours), { ok: false, status });
    const toast = Toast.show.mock.calls[0].arguments;
    assert.equal(toast[0], status === 400 || status === 409 ? 'toast.plant_not_mastered' : 'toast.calendar_save_failed');
    assert.equal(typeof toast[3]?.run, status === 400 || status === 409 ? 'undefined' : 'function');
  });
}

test('network failure returns an error and delete stays durable without a manual Retry', async () => {
  Util.fetchTraced.mock.mockImplementationOnce(async () => { throw new Error('network down'); });
  assert.deepEqual(await CalendarSync.saveLineBlackoutDelete('P1', 'b'), { ok: false, error: 'network down' });
  assert.deepEqual(JSON.parse(storage.get(pendingKey)), { P1: { line: ['b'], plant: [] } });
  assert.equal(Toast.show.mock.calls[0].arguments[0], 'toast.calendar_delete_pending');
  assert.equal(Toast.show.mock.calls[0].arguments[3], undefined);
});

test('pending delete tracking deduplicates IDs and clearing one plant preserves another', () => {
  CalendarSync._trackPendingDeletes('P1', 'line', ['a', 'a', 'b'], true);
  CalendarSync._trackPendingDeletes('P2', 'plant', ['c'], true);
  CalendarSync._trackPendingDeletes('P1', 'line', ['a', 'b'], false);
  assert.deepEqual(JSON.parse(storage.get(pendingKey)), { P2: { line: [], plant: ['c'] } });
});

for (const raw of ['{', 'null', '[]', 'false']) {
  test(`malformed pending-delete storage ${raw} does not prevent a new durable delete`, () => {
    storage.set(pendingKey, raw);
    CalendarSync._trackPendingDeletes('P1', 'line', ['a'], true);
    assert.deepEqual(JSON.parse(storage.get(pendingKey)), { P1: { line: ['a'], plant: [] } });
  });
}

test('storage denial cannot reject a successful delete or leak an exception', async () => {
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.deepEqual(await CalendarSync.savePlantBlackoutDelete('P1', 'b'), { ok: true });
});

test('retrying line-hours uses current surviving lines and cannot resurrect removed calendars', async () => {
  Store.setCalendar('L1', hours, 'test');
  Store.setCalendar('L2', hours, 'test');
  Util.fetchTraced.mock.mockImplementationOnce(async () => ({ ok: false, status: 503 }));
  await CalendarSync._post('/plant-calendar/line-hours', { plant: 'P1', lines: [{ machine: 'L1' }, { machine: 'L2' }] }, 'test');
  Store.replaceCalendars({ L1: { workHours: laterHours } }, 'test');
  Toast.show.mock.calls[0].arguments[3].run();
  await settle();
  assert.deepEqual(calls[0].body, { plant: 'P1', lines: [{ machine: 'L1', work_hours: laterHours }] });
});

test('retrying hours after every target line was removed sends no request', async () => {
  Util.fetchTraced.mock.mockImplementationOnce(async () => ({ ok: false, status: 503 }));
  await CalendarSync._post('/plant-calendar/line-hours', { plant: 'P1', lines: [{ machine: 'L1' }] }, 'test');
  Toast.show.mock.calls[0].arguments[3].run();
  await settle();
  assert.equal(calls.length, 0);
});

for (const kind of ['line', 'plant']) {
  test(`${kind} blackout retry turns a removed upsert into a delete and retains live edits`, async () => {
    const pool = kind === 'line' ? 'replaceBlocks' : 'replacePlantBlocks';
    Store[pool]([block('keep'), block('gone')], 'test');
    Util.fetchTraced.mock.mockImplementationOnce(async () => ({ ok: false, status: 503 }));
    await CalendarSync._post(`/plant-calendar/${kind}-blackouts`, { plant: 'P1', upserts: [{ id: 'keep' }, { id: 'gone' }] }, 'test');
    Store[pool]([{ ...block('keep'), reason: 'updated' }], 'test');
    Toast.show.mock.calls[0].arguments[3].run();
    await settle();
    assert.deepEqual(calls[0].body.deletes, ['gone']);
    assert.deepEqual(calls[0].body.upserts.map(b => [b.id, b.reason]), [['keep', 'updated']]);
    assert.equal(Object.hasOwn(calls[0].body.upserts[0], 'machine'), kind === 'line');
  });
}

test('mixed blackout retry does not delete a blackout recreated since the failed save', () => {
  Store.replaceBlocks([block('recreated')], 'test');
  assert.equal(CalendarSync._freshBody('/plant-calendar/line-blackouts', { plant: 'P1', deletes: ['recreated'] }), null);
});

test('promotion includes explicit removals and only the selected plants current blackouts', async () => {
  Store.replacePlants({ P1: { workHours: hours } }, 'test');
  Store.setCalendar('L1', hours, 'test');
  Store.setCalendar('L2', laterHours, 'test');
  Store.replaceBlocks([block('own'), block('other', 'P2', 'L2')], 'test');
  Store.replacePlantBlocks([block('plant-own'), block('plant-other', 'P2')], 'test');
  CalendarSync.flushPlant('P1', { line: ['removed'], plant: ['removed-plant'] });
  await settle();
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.body.plant === 'P1'));
  const lineWrite = calls.find(call => call.url.endsWith('/line-blackouts')).body;
  assert.deepEqual(lineWrite.upserts.map(b => b.id), ['own']);
  assert.deepEqual(lineWrite.deletes, ['removed']);
  assert.equal(storage.has(pendingKey), false);
});
