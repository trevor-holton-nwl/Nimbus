// CalendarSync: effective-dated plant calendar periods (hydration, pessimistic savePlantPeriods, What-If promote).
// Governing doc: docs/CALENDAR_PERIODS_DESIGN.md.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Toast, ErrorLog } from '../../../frontend/platform/foundation.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';

globalThis.NimbusComputeCore ??= createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

const wh = (a, b) => ({ 0: null, 1: [a, b], 2: [a, b], 3: [a, b], 4: [a, b], 5: [a, b], 6: null });
const per = (id, validFrom, validTo, hours = wh(6, 14)) => ({ id, name: `Period ${id}`, validFrom, validTo, workHours: hours });
const wire = (p) => ({ id: p.id, name: p.name, valid_from: p.validFrom, valid_to: p.validTo, work_hours: p.workHours });

let priorFetch, priorToast, priorWarn, toasts, posts, respond;

beforeEach(() => {
  priorFetch = globalThis.fetch; priorToast = Toast.show; priorWarn = ErrorLog.warn;
  toasts = []; posts = [];
  Toast.show = (msg, type, ms, action) => { toasts.push({ msg, type, action }); };
  ErrorLog.warn = () => {};
  respond = () => ({ ok: true, status: 200, json: () => Promise.resolve({}) });
  globalThis.fetch = (url, opts) => {
    posts.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    return Promise.resolve(respond(String(url)));
  };
  CalendarSync._hydrating = false;
  CalendarSync._hoursEdits = {};
  CalendarSync._pendingLineHours = {};
  CalendarSync._deferredHydrationPlant = null;
  Sandbox.active = false;
  Store.replacePlants({ P1: { workHours: wh(8, 16) } }, 'test');
  Store.replaceCalendars({}, 'test');
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
});

afterEach(async () => {
  await new Promise(r => setTimeout(r, 15));   // let _applyConfig's fire-and-forget slice migration settle
  globalThis.fetch = priorFetch; Toast.show = priorToast; ErrorLog.warn = priorWarn;
  CalendarSync._hydrating = false;
  Sandbox.active = false;
  delete CalendarSync._hydration.P1;
});

test('hydrating plant_periods maps wire to Store shape, sorted, and is visible to a calendar:change subscriber', () => {
  let seen = null;
  const off = Store.subscribe(evt => { if (evt.type === 'calendar:change' && evt.source === 'calendar-sync') seen = Store.getPlantPeriods('P1').map(p => p.id); });
  CalendarSync._applyConfig('P1', { plant_periods: [wire(per('b', '2027-01-01', null)), wire(per('a', '2026-10-01', '2026-12-31'))] });
  off();
  assert.deepEqual(seen, ['a', 'b'], 'applied before the emit');
  assert.deepEqual(Store.getPlantPeriods('P1')[0], per('a', '2026-10-01', '2026-12-31'));
  assert.equal(Store.getPlantPeriods('P1')[1].validTo, null);
});

test('hydrating plant_periods: [] clears local periods; undefined leaves them alone', () => {
  Store.setPlantPeriods('P1', [per('a', '2026-10-01', null)], 'test');
  CalendarSync._applyConfig('P1', { plant_work_hours: wh(8, 16) });
  assert.equal(Store.getPlantPeriods('P1').length, 1, 'older backend (no key) keeps local periods');
  CalendarSync._applyConfig('P1', { plant_periods: [] });
  assert.equal('periods' in Store.plants.P1, false, '[] clears and deletes the key');
});

test('savePlantPeriods posts only the delta and updates Store only after the ack', async () => {
  Store.setPlantPeriods('P1', [per('keep', '2026-01-01', '2026-01-31'), per('gone', '2026-03-01', '2026-03-31'), per('chg', '2026-05-01', '2026-05-31')], 'test');
  const next = [per('keep', '2026-01-01', '2026-01-31'), per('chg', '2026-05-01', '2026-06-15'), per('new', '2026-10-01', null)];
  let during = null;
  respond = () => { during = Store.getPlantPeriods('P1').map(p => p.id); return { ok: true, status: 200, json: () => Promise.resolve({}) }; };
  const res = await CalendarSync.savePlantPeriods('P1', next);
  assert.equal(res.ok, true);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/plant-calendar/plant-periods'));
  assert.equal(posts[0].body.plant, 'P1');
  assert.deepEqual(posts[0].body.upserts.map(u => u.id).sort(), ['chg', 'new']);
  assert.deepEqual(posts[0].body.upserts.find(u => u.id === 'new'), wire(per('new', '2026-10-01', null)));
  assert.deepEqual(posts[0].body.deletes, ['gone']);
  assert.deepEqual(during, ['keep', 'gone', 'chg'], 'Store untouched while the request is in flight');
  assert.deepEqual(Store.getPlantPeriods('P1').map(p => p.id), ['keep', 'chg', 'new']);
});

test('savePlantPeriods with no change is ok with no POST', async () => {
  Store.setPlantPeriods('P1', [per('a', '2026-10-01', null)], 'test');
  const res = await CalendarSync.savePlantPeriods('P1', [per('a', '2026-10-01', null)]);
  assert.deepEqual(res, { ok: true });
  assert.equal(posts.length, 0);
});

test('a server 400 period_overlap returns code and ids, leaves Store untouched, shows no plant_not_mastered toast', async () => {
  Store.setPlantPeriods('P1', [per('a', '2026-10-01', '2026-10-31')], 'test');
  respond = () => ({ ok: false, status: 400, json: () => Promise.resolve({ detail: { code: 'period_overlap', ids: ['a', 'b'], message: 'overlap' } }) });
  const res = await CalendarSync.savePlantPeriods('P1', [per('a', '2026-10-01', '2026-10-31'), per('b', '2027-01-01', null)]);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.code, 'period_overlap');
  assert.deepEqual(res.ids, ['a', 'b']);
  assert.equal(res.message, 'overlap');
  assert.deepEqual(Store.getPlantPeriods('P1').map(p => p.id), ['a']);
  assert.equal(toasts.length, 0, 'the caller renders structured refusals');
  assert.equal(CalendarSync._hoursEdits.P1['#periods'].pending, false, 'a failed write must not block hydration forever');
});

test('plant_not_mastered still toasts; a network failure toasts calendar_save_failed with no Retry action', async () => {
  respond = () => ({ ok: false, status: 400, json: () => Promise.resolve({ detail: { code: 'plant_not_mastered' } }) });
  await CalendarSync.savePlantPeriods('P1', [per('a', '2026-10-01', null)]);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].msg, 'toast.plant_not_mastered');
  toasts.length = 0;
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  const res = await CalendarSync.savePlantPeriods('P1', [per('a', '2026-10-01', null)]);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'offline');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].msg, 'toast.calendar_save_failed');
  assert.equal(toasts[0].action, undefined, 'no Retry: it would rebuild from a Store that was never updated');
  assert.equal(Store.getPlantPeriods('P1').length, 0);
});

test('a 5xx without a structured body toasts calendar_save_failed (no Retry)', async () => {
  respond = () => ({ ok: false, status: 503, json: () => Promise.reject(new Error('not json')) });
  const res = await CalendarSync.savePlantPeriods('P1', [per('a', '2026-10-01', null)]);
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
  assert.equal(res.code, undefined);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].action, undefined);
});

test('a local overlap is rejected with code and ids and no POST', async () => {
  const res = await CalendarSync.savePlantPeriods('P1', [per('a', '2026-10-01', '2026-10-31'), per('b', '2026-10-31', null)]);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'period_overlap');
  assert.deepEqual([...res.ids].sort(), ['a', 'b']);
  assert.equal(posts.length, 0);
  assert.equal(Store.getPlantPeriods('P1').length, 0);
});

test('in What-If savePlantPeriods updates Store locally with no POST', async () => {
  Sandbox.active = true;
  const res = await CalendarSync.savePlantPeriods('P1', [per('a', '2026-10-01', null)]);
  assert.deepEqual(res, { ok: true, skipped: true });
  assert.equal(posts.length, 0);
  assert.deepEqual(Store.getPlantPeriods('P1').map(p => p.id), ['a']);
});

test('flushPlant promotes periods and removed period ids in one write', async () => {
  Store.setPlantPeriods('P1', [per('a', '2026-10-01', null)], 'test');
  CalendarSync.flushPlant('P1', { line: [], plant: [], periods: ['old'] });
  await new Promise(r => setTimeout(r, 10));
  const call = posts.find(p => p.url.endsWith('/plant-calendar/plant-periods'));
  assert.ok(call, 'a plant-periods write was sent');
  assert.deepEqual(call.body, { plant: 'P1', upserts: [wire(per('a', '2026-10-01', null))], deletes: ['old'] });
});

test('flushPlant with no periods and nothing removed sends no plant-periods write', async () => {
  CalendarSync.flushPlant('P1', { line: [], plant: [] });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(posts.some(p => p.url.endsWith('/plant-calendar/plant-periods')), false);
});

async function promoteRefused(body, status = 400) {
  Store.setPlantPeriods('P1', [per('a', '2026-10-01', null)], 'test');
  respond = (url) => (url.endsWith('/plant-calendar/plant-periods')
    ? { ok: false, status, json: () => (body === null ? Promise.reject(new Error('no body')) : Promise.resolve(body)) }
    : { ok: true, status: 200, json: () => Promise.resolve({}) });
  CalendarSync.flushPlant('P1', { line: [], plant: [] });
  await new Promise(r => setTimeout(r, 10));
  return toasts.map(t => t.msg);
}

test('flushPlant: a refused promote with period_overlap shows toast.period_overlap only', async () => {
  assert.deepEqual(await promoteRefused({ detail: { code: 'period_overlap', ids: ['a'] } }), ['toast.period_overlap']);
});

test('flushPlant: a refused promote with period_dates_invalid shows toast.period_dates_invalid only', async () => {
  assert.deepEqual(await promoteRefused({ detail: { code: 'period_dates_invalid', ids: ['a'] } }), ['toast.period_dates_invalid']);
});

test('flushPlant: another structured code (plant_not_mastered) is toasted once by _post, with no second toast', async () => {
  assert.deepEqual(await promoteRefused({ detail: { code: 'plant_not_mastered' } }), ['toast.plant_not_mastered']);
});

test('flushPlant: an un-coded failed promote shows calendar_save_failed', async () => {
  assert.deepEqual(await promoteRefused(null, 500), ['toast.calendar_save_failed']);
});

test('savePlantPeriods: a pure delete skips local validation, so pre-existing overlapping data cannot block it', async () => {
  const bad = [per('a', '2026-10-01', '2026-10-31'), per('b', '2026-10-15', null), per('c', '2027-06-01', '2027-06-30')];
  Store.setPlantPeriods('P1', bad, 'test');
  const res = await CalendarSync.savePlantPeriods('P1', bad.filter(p => p.id !== 'c'));
  assert.equal(res.ok, true);
  assert.deepEqual(posts[0].body, { plant: 'P1', upserts: [], deletes: ['c'] });
  assert.deepEqual(Store.getPlantPeriods('P1').map(p => p.id), ['a', 'b']);
});

test('a stale GET that started before an acknowledged period write does not clobber the new periods', async () => {
  const read = CalendarSync._captureHoursRead('P1');   // the GET starts here
  const res = await CalendarSync.savePlantPeriods('P1', [per('new', '2026-10-01', null)]);
  assert.equal(res.ok, true);
  CalendarSync._applyConfig('P1', { plant_periods: [] }, read);   // the older response lands after the ack
  assert.deepEqual(Store.getPlantPeriods('P1').map(p => p.id), ['new']);
  // A GET that starts after the ack is authoritative again.
  CalendarSync._applyConfig('P1', { plant_periods: [] });
  assert.deepEqual(Store.getPlantPeriods('P1'), []);
});

test('a GET that started while a period write is pending is protected from the stale list', async () => {
  const releases = [];
  globalThis.fetch = () => new Promise(r => { releases.push(() => r({ ok: true, status: 200, json: () => Promise.resolve({}) })); });
  const saving = CalendarSync.savePlantPeriods('P1', [per('new', '2026-10-01', null)]);
  const read = CalendarSync._captureHoursRead('P1');
  CalendarSync._applyConfig('P1', { plant_periods: [] }, read);
  releases.forEach(r => r());
  await saving;
  assert.deepEqual(Store.getPlantPeriods('P1').map(p => p.id), ['new']);
});

// Propagation baseline (2026-10-23): hydration records the server's calendar_version; success is reported as a boolean.
test('_applyConfig records calendar_version as the horizons baseline and reports applied; What-If defers without recording', () => {
  delete Persistence._calendarVersion.P1;
  assert.equal(CalendarSync._applyConfig('P1', { plant_work_hours: wh(8, 16), calendar_version: 'abc' }), true);
  assert.equal(Persistence._calendarVersion.P1, 'abc');
  assert.equal(CalendarSync._applyConfig('P1', { plant_work_hours: wh(8, 16) }), true, 'an older backend: still applied');
  assert.equal(Persistence._calendarVersion.P1, 'abc', 'a missing field leaves the baseline alone');
  Sandbox.active = true;
  assert.equal(CalendarSync._applyConfig('P1', { calendar_version: 'zzz' }), false);
  assert.equal(Persistence._calendarVersion.P1, 'abc', 'a deferred apply never moves the baseline');
  delete Persistence._calendarVersion.P1;
});

test('fetchPlantConfig resolves true when applied and false (never rejects) when the GET fails', async () => {
  delete Persistence._calendarVersion.P1;
  respond = () => ({ ok: true, status: 200, json: () => Promise.resolve({ plant_work_hours: wh(8, 16), calendar_version: 'v9' }) });
  assert.equal(await CalendarSync.fetchPlantConfig('P1'), true);
  assert.equal(Persistence._calendarVersion.P1, 'v9');
  respond = () => ({ ok: false, status: 500, json: () => Promise.resolve({}) });
  assert.equal(await CalendarSync.fetchPlantConfig('P1'), false);
  assert.equal(Persistence._calendarVersion.P1, 'v9', 'a failed fetch keeps the baseline');
  delete Persistence._calendarVersion.P1;
});
