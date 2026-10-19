// Machine calendar inheritance (2026-10-19): a machine with no calendar row follows its plant. Its Store entry is
// `{workHours, inherited: true}` and its hours are "open all day" once the plant resolves, because every scheduling
// reader intersects line hours with the plant's hours for the date. Plant saves never write machine rows.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar } from '../../../frontend/calendar/calendar-engine.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { Util, Toast, ErrorLog } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore ??= createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

const week = (range) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, range ? [...range] : null]));
const MON = new Date('2031-03-03T12:00:00');          // a Monday
const MON_START = new Date(2031, 2, 3);
const hoursOf = (win) => win && [(win[0] - MON_START) / 3.6e6, (win[1] - MON_START) / 3.6e6];
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

let calls;
let storage;
let restoreStorage;
let fetchOk;

beforeEach(t => {
  storage = new Map();
  calls = [];
  fetchOk = true;
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
  restoreStorage = () => { if (prior) Object.defineProperty(globalThis, 'localStorage', prior); else delete globalThis.localStorage; };
  t.mock.method(Util, 'fetchTraced', async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    return { ok: fetchOk, status: fetchOk ? 200 : 500, json: async () => ({}) };
  });
  t.mock.method(Util, 't', key => key);
  t.mock.method(Toast, 'show', () => {});
  for (const method of ['warn', 'error', 'info']) t.mock.method(ErrorLog, method, () => {});
  CalendarSync._hydrating = false;
  CalendarSync._hoursEdits = {};
  CalendarSync._pendingLineHours = {};
  CalendarSync._whDebounce = {};
  CalendarSync._hydration = {};
  Sandbox.active = false;
  Store.setTasks([], 'test');
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({ P1: { workHours: week([7, 19]) } }, 'test');
  Store.setMasterData({ plants: [{ plant: 'P1' }], lines: [
    { machine: 'L1', plant: 'P1' }, { machine: 'L3', plant: 'P1' },
  ] }, 'test');
});

afterEach(() => {
  for (const unsubscribe of Object.values(CalendarSync._lineHoursWait)) unsubscribe();
  CalendarSync._lineHoursWait = {};
  for (const timer of Object.values(CalendarSync._whDebounce)) clearTimeout(timer);
  CalendarSync._hydrating = false;
  Sandbox.active = false;
  Sandbox._snapshot = null;
  restoreStorage();
});

test('an inherited line follows the plant 7pm -> 5pm -> 7pm and never pins the narrowed copy', () => {
  Store.ensureCalendar('L1');
  assert.equal(Store.calendars.L1.inherited, true);
  assert.deepEqual(Store.calendars.L1.workHours[1], [0, 24], 'open all day once the plant resolves');
  assert.deepEqual(hoursOf(Calendar.workWindow('L1', MON)), [7, 19]);
  Store.replacePlants({ P1: { workHours: week([7, 17]) } }, 'test');
  assert.deepEqual(hoursOf(Calendar.workWindow('L1', MON)), [7, 17], 'plant narrowed');
  Store.replacePlants({ P1: { workHours: week([7, 19]) } }, 'test');
  assert.deepEqual(hoursOf(Calendar.workWindow('L1', MON)), [7, 19], 'plant widened again: the machine is back to 7pm');
  assert.equal(Store.calendars.L1.inherited, true);
  assert.deepEqual(Store.calendars.L1.workHours[1], [0, 24]);
});

test('an override keeps its own hours when the plant narrows; its window is capped by the plant per date', () => {
  Store.replacePlants({ P1: { workHours: week([6, 19]) } }, 'test');
  Store.setCalendar('L1', week([6, 19]), 'test');
  assert.equal(Store.calendars.L1.inherited, false);
  assert.deepEqual(hoursOf(Calendar.workWindow('L1', MON)), [6, 19]);
  Store.replacePlants({ P1: { workHours: week([7, 17]) } }, 'test');
  assert.deepEqual(Store.calendars.L1.workHours[1], [6, 19], 'no clamp rewrite: the saved hours stay 6am-7pm');
  assert.deepEqual(hoursOf(Calendar.workWindow('L1', MON)), [7, 17], 'capped by the plant on that date');
  Store.replacePlants({ P1: { workHours: week([6, 19]) } }, 'test');
  assert.deepEqual(hoursOf(Calendar.workWindow('L1', MON)), [6, 19], 'plant widened: the override is whole again');
});

test('an inherited line picks up a dated plant period with no refresh', () => {
  Store.ensureCalendar('L1');
  Store.setPlantPeriods('P1', [{ id: 'p', name: 'Peak', validFrom: '2031-03-03', validTo: '2031-03-03', workHours: week([5, 22]) }], 'plant-periods');
  assert.deepEqual(hoursOf(Calendar.workWindow('L1', MON)), [5, 22], 'the period replaces the default on its date');
  const tuesday = new Date('2031-03-04T12:00:00');
  assert.deepEqual([...Calendar.workWindow('L1', tuesday).map(d => d.getHours())], [7, 19], 'the default week applies outside the period');
});

test('effectiveLineHours is the plant default week for an inherited line and the saved hours for an override', () => {
  Store.ensureCalendar('L1');
  Store.replacePlants({ P1: { workHours: week([7, 17]) } }, 'test');
  assert.deepEqual(Store.effectiveLineHours('L1')[1], [7, 17]);
  Store.setCalendar('L3', week([6, 18]), 'test');
  assert.deepEqual(Store.effectiveLineHours('L3')[1], [6, 18]);
  Store.inheritPlantHours('L3');
  assert.equal(Store.calendars.L3.inherited, true);
  assert.deepEqual(Store.effectiveLineHours('L3')[1], [7, 17]);
});

test('a line whose plant is unknown is seeded with the default shift, then goes all-day once the plant resolves', () => {
  Store.ensureCalendar('NEW1');
  assert.equal(Store.calendars.NEW1.inherited, true);
  assert.deepEqual(Store.calendars.NEW1.workHours[1], [7, 19], 'bounded by the DEFAULT_SHIFT seed while nothing would intersect it');
  Store.setMasterData({ plants: [{ plant: 'P1' }], lines: [{ machine: 'NEW1', plant: 'P1' }] }, 'test');
  Store.rebuildPlantIndex();
  assert.deepEqual(Store.calendars.NEW1.workHours[1], [0, 24]);
});

test('hydration with line_work_hours {} turns a stale pinned local copy into an inherited line', () => {
  Store.replaceCalendars({ L1: { workHours: week([7, 17]) } }, 'test');        // an old cached pin (no flag)
  CalendarSync._applyConfig('P1', { plant_work_hours: week([7, 19]), line_work_hours: {}, machine_blackouts: [], plant_blackouts: [] });
  assert.equal(Store.calendars.L1.inherited, true);
  assert.deepEqual(hoursOf(Calendar.workWindow('L1', MON)), [7, 19]);
  assert.equal(calls.length, 0, 'nothing is migrated back up');
});

test('hydration: a server row is an override, other lines inherit, and an in-flight edit is left alone', () => {
  Store.replaceCalendars({ L1: { workHours: week([7, 17]) }, L3: { workHours: week([8, 12]) } }, 'test');
  CalendarSync._markHoursEdit('P1', 'L3');                                     // L3 has an unsaved edit in flight
  CalendarSync._applyConfig('P1', { plant_work_hours: week([7, 19]), line_work_hours: { L1: week([6, 18]) }, machine_blackouts: [], plant_blackouts: [] },
    { revision: 0, pending: new Set(['L3']) });
  assert.equal(Store.calendars.L1.inherited, false);
  assert.deepEqual(Store.calendars.L1.workHours[1], [6, 18]);
  assert.deepEqual(Store.calendars.L3.workHours[1], [8, 12], 'the protected edit survives hydration');
  assert.equal(CalendarSync.hasServerLineCalendar('P1', 'L1'), true);
});

test('migration never writes an inherited line as hours', () => {
  Store.replaceCalendars({ L1: { workHours: week([6, 18]), inherited: true }, L3: { workHours: week([6, 18]), inherited: false } }, 'test');
  CalendarSync._migrateMissingSlices('P1', { plantHours: true, lineHours: false, lineBlackouts: true, plantBlackouts: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.lines.map(l => l.machine), ['L3']);
});

test('What-If: resetting a pinned machine then promoting sends a null write, and skips an inherited line with no row', async () => {
  Store.setCalendar('L1', week([6, 18]), 'test');
  CalendarSync._setHydration('P1', 'hydrated', ['L1']);                       // the server holds a row for L1 only
  Store.ensureCalendar('L3');
  assert.equal(Sandbox.enter('test'), true);
  CalendarSync.resetLinesToPlant('P1', ['L1']);
  assert.equal(Store.calendars.L1.inherited, true);
  Sandbox.exit(true, 'test');
  CalendarSync.flushPlant('P1');
  await settle();
  const lineWrite = calls.find(call => call.url.endsWith('/line-hours'));
  assert.deepEqual(lineWrite.body.lines, [{ machine: 'L1', work_hours: null }]);
  assert.equal(CalendarSync.hasServerLineCalendar('P1', 'L1'), true, 'promote does not touch the server-line set');
});

test('Reset to plant outside What-If sends one batched null POST and drops the machine from the server-line set', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Store.setCalendar('L1', week([6, 18]), 'test');
  Store.setCalendar('L3', week([8, 12]), 'test');
  CalendarSync._setHydration('P1', 'hydrated', ['L1', 'L3']);
  assert.deepEqual(CalendarSync.overrideLines('P1').sort(), ['L1', 'L3']);
  CalendarSync.resetLinesToPlant('P1', CalendarSync.overrideLines('P1'));
  t.mock.timers.tick(600);
  await settle();
  assert.equal(calls.length, 1, 'one batched request');
  assert.deepEqual(calls[0].body.lines.map(l => [l.machine, l.work_hours]).sort(), [['L1', null], ['L3', null]]);
  assert.equal(CalendarSync.hasServerLineCalendar('P1', 'L1'), false);
  assert.deepEqual(CalendarSync.overrideLines('P1'), []);
});

test('a failed Reset POST retries with null, not the inherited all-day seed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const toasts = [];
  Toast.show.mock.mockImplementation((...a) => toasts.push(a));
  Store.setCalendar('L1', week([6, 18]), 'test');
  CalendarSync.resetLinesToPlant('P1', ['L1']);
  fetchOk = false;
  t.mock.timers.tick(600);
  await settle();
  assert.deepEqual(calls[0].body.lines, [{ machine: 'L1', work_hours: null }]);
  const retry = toasts.find(a => a[3] && typeof a[3].run === 'function');
  assert.ok(retry, 'the failure toast offers Retry');
  fetchOk = true;
  retry[3].run();
  await settle();
  assert.deepEqual(calls[1].body.lines, [{ machine: 'L1', work_hours: null }], 'null again, never [0,24]');
});

test('_freshBody rebuilds an inherited line as null and an override as its hours', () => {
  Store.replaceCalendars({ L1: { workHours: week([0, 24]), inherited: true }, L3: { workHours: week([8, 12]), inherited: false } }, 'test');
  const body = CalendarSync._freshBody('/plant-calendar/line-hours', { plant: 'P1', lines: [{ machine: 'L1' }, { machine: 'L3' }] });
  assert.deepEqual(body.lines, [{ machine: 'L1', work_hours: null }, { machine: 'L3', work_hours: week([8, 12]) }]);
});
