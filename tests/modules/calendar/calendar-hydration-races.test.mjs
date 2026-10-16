import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { SandboxAdapter } from '../../../frontend/optimization/optimize-ui.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast, ErrorLog } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
const oldHours = { 1: [8, 16] }, liveHours = { 1: [9, 17] }, newerHours = { 1: [10, 18] };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
let globals, requests, unsubscribe;
const config = () => ({ plant_work_hours: oldHours, line_work_hours: { L1: oldHours, L3: newerHours } });
beforeEach(t => {
  globals = Object.fromEntries(['document', 'NIMBUS', 'localStorage'].map(k => [k, globalThis[k]]));
  globalThis.document = { getElementById: () => null, querySelectorAll: () => [], body: { classList: { add() {}, remove() {} } } };
  globalThis.NIMBUS = { Persistence: { saveAll() {} } };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  requests = [];
  t.mock.method(Util, 'fetchTraced', (url, options) => !String(url).includes('/plant-calendar') ? Promise.resolve({ ok: true, json: async () => ({}) }) : new Promise(resolve => requests.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null, resolve })));
  t.mock.method(Util, 't', key => key);
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Alerts, 'scheduleRecompute', () => {});
  t.mock.method(console, 'error', () => {});
  for (const method of ['info', 'warn', 'error']) t.mock.method(ErrorLog, method, () => {});
  CalendarSync._hoursEdits = {};
  CalendarSync._pendingLineHours = {};
  CalendarSync._whDebounce = {};
  CalendarSync._lineHoursWait = {};
  CalendarSync._hydration = {};
  CalendarSync._deferredHydrationPlant = null;
  CalendarSync._hydrating = false;
  Sandbox.active = false;
  Store.setTasks([], 'test'); Store.replaceCalendars({}, 'test'); Store.replacePlants({}, 'test');
  Store.replaceBlocks([], 'test'); Store.replacePlantBlocks([], 'test');
  Store.setMasterData({ plants: [{ plant: 'P1' }, { plant: 'P2' }], lines: [{ machine: 'L1', plant: 'P1' }, { machine: 'L3', plant: 'P1' }, { machine: 'L2', plant: 'P2' }] }, 'test');
  Store.setSelectedPlant('P1', 'test');
  Store.setCalendar('L1', liveHours, 'test'); Store.setCalendar('L2', oldHours, 'test'); Store.setCalendar('L3', oldHours, 'test');
  // Match application registration order: the adapter precedes the timer's exit listener.
  unsubscribe = Store.subscribe(event => { if (event.type === 'sandbox:exited') SandboxAdapter._onExited(event); });
});
afterEach(() => {
  assert.equal(ErrorLog.error.mock.calls.length, 0, 'adapter must not log integration errors');
  assert.equal(console.error.mock.calls.filter(call => String(call.arguments[0]).includes('[Store] listener error:')).length,
    0, 'Store subscriber must not swallow integration errors');
  unsubscribe();
  for (const timer of Object.values(CalendarSync._whDebounce)) clearTimeout(timer);
  for (const stop of Object.values(CalendarSync._lineHoursWait)) stop();
  CalendarSync._hoursEdits = {}; CalendarSync._lineHoursWait = {}; CalendarSync._pendingLineHours = {};
  Sandbox.active = false; Sandbox._snapshot = null;
  for (const [key, value] of Object.entries(globals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
function reply(request, body = config(), ok = true) { request.resolve({ ok, status: ok ? 200 : 503, json: async () => body }); }
function discardWithDeferredRead() {
  CalendarSync.saveLineHours('P1', 'L1', liveHours);
  Sandbox.enter('test');
  CalendarSync._applyConfig('P1', config());
  CalendarSync._flushLineHours('P1');
  Sandbox.exit(false, 'test');
}
for (const succeeds of [true, false]) test(`actual adapter discard retains live hours while deferred GET precedes ${succeeds ? 'successful' : 'failed'} POST`, async () => {
  discardWithDeferredRead();
  assert.deepEqual(requests.map(r => r.body ? 'POST' : 'GET'), ['GET', 'POST']);
  assert.deepEqual(requests[1].body.lines, [{ machine: 'L1', work_hours: liveHours }]);
  reply(requests[0]); await settle();
  assert.deepEqual(Store.calendars.L1.workHours, liveHours);
  assert.deepEqual(Store.calendars.L3.workHours, newerHours, 'unrelated line still hydrates');
  assert.deepEqual(Store.calendars.L2.workHours, oldHours, 'other plant stays untouched');
  reply(requests[1], {}, succeeds); await settle();
  assert.deepEqual(Store.calendars.L1.workHours, liveHours);
  if (!succeeds) {
    const retry = Toast.show.mock.calls.find(call => call.arguments[0] === 'toast.calendar_save_failed')?.arguments[3];
    assert.equal(typeof retry?.run, 'function');
    const reload = CalendarSync.fetchPlantConfig('P1'); reply(requests.at(-1)); await reload;
    assert.deepEqual(Store.calendars.L1.workHours, liveHours, 'failed edits survive later refresh');
    retry.run(); reply(requests.at(-1), {}); await settle();
    assert.deepEqual(requests.at(-1).body.lines[0].work_hours, liveHours);
  }
});


test('actual adapter deferred GET stays stale even if resumed POST acknowledges before its body arrives', async () => {
  discardWithDeferredRead();
  reply(requests[1], {}); await settle();
  reply(requests[0]); await settle();
  assert.deepEqual(Store.calendars.L1.workHours, liveHours);
  assert.deepEqual(Store.calendars.L3.workHours, newerHours);
});

test('actual adapter discard preserves a live POST already in flight before entering What-If', async () => {
  CalendarSync.saveLineHours('P1', 'L1', liveHours);
  const write = CalendarSync._flushLineHours('P1');
  Sandbox.enter('test');
  CalendarSync._applyConfig('P1', config());
  Sandbox.exit(false, 'test');
  assert.deepEqual(requests.map(r => r.body ? 'POST' : 'GET'), ['POST', 'GET']);
  reply(requests[1]); await settle();
  assert.deepEqual(Store.calendars.L1.workHours, liveHours);
  reply(requests[0], {}); await write;
  assert.deepEqual(Store.calendars.L1.workHours, liveHours);
});

test('a later edit during a resumed POST is protected from its acknowledgment and a stale read', async () => {
  discardWithDeferredRead();
  Store.setCalendar('L1', newerHours, 'test');
  CalendarSync.saveLineHours('P1', 'L1', newerHours);
  reply(requests[1], {}); await settle();
  reply(requests[0]); await settle();
  assert.deepEqual(Store.calendars.L1.workHours, newerHours);
  const write = CalendarSync._flushLineHours('P1');
  assert.deepEqual(requests.at(-1).body.lines[0].work_hours, newerHours);
  reply(requests.at(-1), {}); await write;
});

test('a local edit queued after a GET starts wins even after its POST settles before that GET', async () => {
  const read = CalendarSync.fetchPlantConfig('P1');
  Store.setCalendar('L1', newerHours, 'test');
  CalendarSync.saveLineHours('P1', 'L1', newerHours);
  const write = CalendarSync._flushLineHours('P1');
  reply(requests[1], {}); await write;
  reply(requests[0]); await read;
  assert.deepEqual(Store.calendars.L1.workHours, newerHours);
});

test('actual adapter promotion wins over a GET started before the trial, including acknowledged writes', async () => {
  const read = CalendarSync.fetchPlantConfig('P1');
  Sandbox.enter('test');
  Store.setCalendar('L1', newerHours, 'test');
  Sandbox.exit(true, 'test');
  const writes = requests.filter(request => request.body);
  assert.ok(writes.length > 0);
  for (const request of writes) reply(request, {});
  await settle();
  reply(requests[0]); await read;
  assert.deepEqual(Store.calendars.L1.workHours, newerHours);
});

test('failed plant hours remain visible while unrelated line and other plant hydration proceeds', async () => {
  Store.ensurePlant('P1'); Store.plants.P1.workHours = liveHours;
  const write = CalendarSync.savePlantHours('P1', liveHours);
  reply(requests[0], {}, false); await write;
  const read = CalendarSync.fetchPlantConfig('P1'); reply(requests.at(-1)); await read;
  assert.deepEqual(Store.plants.P1.workHours, liveHours);
  assert.deepEqual(Store.calendars.L3.workHours, newerHours);
  const otherRead = CalendarSync.fetchPlantConfig('P2');
  reply(requests.at(-1), { plant_work_hours: newerHours, line_work_hours: { L2: newerHours } }); await otherRead;
  assert.deepEqual(Store.calendars.L2.workHours, newerHours);
  assert.deepEqual(Store.plants.P1.workHours, liveHours);
  const retry = Toast.show.mock.calls.find(call => call.arguments[0] === 'toast.calendar_save_failed').arguments[3];
  retry.run(); reply(requests.at(-1), {}); await settle();
  const fresh = CalendarSync.fetchPlantConfig('P1'); reply(requests.at(-1), { ...config(), plant_work_hours: newerHours }); await fresh;
  assert.deepEqual(Store.plants.P1.workHours, newerHours, 'a fresh post-ack read may hydrate server changes');
});


test('actual adapter discard keeps queued hours when the deferred read settles before debounce expiry', async () => {
  CalendarSync.saveLineHours('P1', 'L1', liveHours);
  Sandbox.enter('test');
  CalendarSync._applyConfig('P1', config());
  Sandbox.exit(false, 'test');
  assert.deepEqual(requests.map(request => request.body ? 'POST' : 'GET'), ['GET']);
  reply(requests[0]); await settle();
  assert.deepEqual(Store.calendars.L1.workHours, liveHours);
  const write = CalendarSync._flushLineHours('P1');
  reply(requests[1], {}); await write;
  assert.deepEqual(requests[1].body.lines[0].work_hours, liveHours);
});

test('missing backend hours do not silently auto-retry a failed local edit during hydration', async () => {
  CalendarSync.saveLineHours('P1', 'L1', liveHours);
  const write = CalendarSync._flushLineHours('P1');
  reply(requests[0], {}, false); await write;
  const read = CalendarSync.fetchPlantConfig('P1');
  reply(requests[1], { plant_work_hours: oldHours, line_work_hours: { L3: newerHours } }); await read;
  assert.deepEqual(Store.calendars.L1.workHours, liveHours, 'a missing row cannot clear the failed local edit');
  assert.equal(requests.length, 2, 'failed edit remains a manual Retry, not an automatic overwrite');
});
