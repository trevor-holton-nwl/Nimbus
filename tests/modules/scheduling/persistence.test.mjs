// Tests for frontend/scheduling/persistence.mjs, split from
// tests/modules/schedule-data.test.mjs (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-data.mts
// into 3 domain files: scheduling/persistence.mjs, calendar/calendar-sync.mjs,
// security/session.mjs).
//
// Persistence reaches ErrorLog/Toast (platform/foundation.mjs), which
// reference bare `document`/`window` — same split-realm-free, DOM-less
// environment as tests/modules/optimization/engine.test.mjs. Minimal stubs
// keep those paths a real no-op instead of throwing "document/window is not
// defined".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Config, Toast, Util, Modal } from '../../../frontend/platform/foundation.mjs';
import { UndoStack } from '../../../frontend/platform/store.mjs';

test('plant switch guard keeps dirty edits on cancel and clears them on discard', async () => {
  const priorConfirm = Modal.confirm;
  const priorDirty = new Set(Persistence._dirtyIds);
  const priorForce = new Set(Persistence._forceIds);
  const priorPlant = Store.selectedPlant;
  const priorLoadedPlant = Persistence._currentLoadedPlant;
  try {
    Store.setSelectedPlant('PLANT-A', 'test');
    Persistence._currentLoadedPlant = 'PLANT-A';
    Persistence._dirtyIds.add('order-a');
    Persistence._forceIds.add('order-a');
    Modal.confirm = async () => false;
    assert.equal(await Persistence.confirmPlantSwitch('PLANT-B'), false);
    assert.equal(Persistence._dirtyIds.has('order-a'), true);
    Modal.confirm = async () => true;
    assert.equal(await Persistence.confirmPlantSwitch('PLANT-B'), true);
    assert.equal(Persistence._dirtyIds.size, 0);
    assert.equal(Persistence._forceIds.size, 0);
    assert.equal(Persistence._currentLoadedPlant, null);
  } finally {
    Modal.confirm = priorConfirm;
    Persistence._dirtyIds.clear();
    Persistence._forceIds.clear();
    for (const id of priorDirty) Persistence._dirtyIds.add(id);
    for (const id of priorForce) Persistence._forceIds.add(id);
    Persistence._currentLoadedPlant = priorLoadedPlant;
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

test('Needs Planning survives API hydration, cached moves, normalization and undo with no committed dates', () => {
  const due = new Date('2026-09-09T18:00:00');
  const raw = { id: 'queued', MACHINE: 'L1', RUN_TIME: 6, planning_status: 'needs_planning',
    planning_reason: { code: 'no_fit_found', message: 'No fit found within the allowed window.' },
    original_end_date: due, start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T14:00:00',
    schedule_segments: [{ sequence: 1, start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T11:00:00' },
      { sequence: 2, start_date: '2026-09-09T12:00:00', end_date: '2026-09-09T15:00:00' }] };
  const task = Persistence._prepTask(raw);
  assert.equal(task.start_date, null);
  assert.equal(task.end_date, null);
  assert.deepEqual(task.scheduleSegments, []);
  Persistence._overlayUserMoves([task], [{ id: 'queued', start_date: '2026-09-10T08:00:00',
    end_date: '2026-09-10T14:00:00', original_start_date: '2026-09-09T00:00:00' }]);
  assert.equal(task.start_date, null);
  Store.setTasks([task], 'unit-test');
  const snapshot = UndoStack.snapshotTasks(['queued']);
  Store.updateTask('queued', { start_date: new Date('2026-09-10T08:00:00'),
    end_date: new Date('2026-09-10T14:00:00') }, 'table');
  assert.equal(Store.tasks.queued.planning_status, 'scheduled');
  assert.equal(Store.tasks.queued.planning_reason, null);
  UndoStack.restoreTasks(snapshot);
  assert.equal(Store.tasks.queued.planning_status, 'needs_planning');
  assert.equal(Store.tasks.queued.start_date, null);
  assert.equal(Store.tasks.queued.original_end_date.getTime(), due.getTime());
});

test('PR-2: _overlayUserMoves skips the cached override when the server row_version has moved past what was cached', () => {
  // Another session's write (optimizer run, anchor-carry, etc.) landed on this
  // row after the planner's local edit was cached — the cached copy is stale,
  // not "my own unsaved edit", and must not mask the fresh server dates.
  const backendTask = {
    id: 'ver-skip', MACHINE: 'L1', row_version: 9,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T09:00:00'),
    original_start_date: new Date('2026-09-08T00:00:00'),
  };
  const cachedTask = {
    id: 'ver-skip', row_version: 5,
    start_date: '2026-09-10T08:00:00', end_date: '2026-09-10T09:00:00',
    original_start_date: '2026-09-08T00:00:00',
  };
  Persistence._overlayUserMoves([backendTask], [cachedTask]);
  assert.equal(backendTask.start_date.getTime(), new Date('2026-09-09T08:00:00').getTime(),
    'a stale-versioned cached edit must not overwrite the freshly-fetched server dates');
  assert.equal(backendTask.end_date.getTime(), new Date('2026-09-09T09:00:00').getTime());
});

test('PR-2: _overlayUserMoves still applies the cached override when row_version matches (a genuinely unsaved local edit)', () => {
  const backendTask = {
    id: 'ver-match', MACHINE: 'L1', row_version: 5,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T09:00:00'),
    original_start_date: new Date('2026-09-08T00:00:00'),
  };
  const cachedTask = {
    id: 'ver-match', row_version: 5,
    start_date: '2026-09-10T08:00:00', end_date: '2026-09-10T09:00:00',
    original_start_date: '2026-09-08T00:00:00',
  };
  Persistence._overlayUserMoves([backendTask], [cachedTask]);
  assert.equal(backendTask.start_date.getTime(), new Date('2026-09-10T08:00:00').getTime(),
    'a same-versioned cached edit is the planner\'s own unsaved move and must still be overlaid');
});

test('PR-2: _overlayUserMoves falls back to applying the override when either side lacks a row_version', () => {
  // Old caches (pre-dating this field) or rows that never got one keep the
  // previous best-effort behavior rather than being silently skipped forever.
  const backendTask = {
    id: 'ver-none', MACHINE: 'L1', row_version: null,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T09:00:00'),
    original_start_date: new Date('2026-09-08T00:00:00'),
  };
  const cachedTask = {
    id: 'ver-none',
    start_date: '2026-09-10T08:00:00', end_date: '2026-09-10T09:00:00',
    original_start_date: '2026-09-08T00:00:00',
  };
  Persistence._overlayUserMoves([backendTask], [cachedTask]);
  assert.equal(backendTask.start_date.getTime(), new Date('2026-09-10T08:00:00').getTime());
});

test('optimizer save is atomic without force and a conflict leaves every dependent edit unsaved', async () => {
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  Store.setTasks([{ id: 'atomic-a', MACHINE: 'L1', RUN_TIME: 6, row_version: 5,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T14:00:00') },
  { id: 'atomic-b', MACHINE: 'L1', RUN_TIME: 6, row_version: 5,
    planning_status: 'needs_planning', planning_reason: { code: 'no_fit_found', message: 'No fit found.' },
    start_date: null, end_date: null }], 'unit-test');
  for (const id of ['atomic-a', 'atomic-b']) { Persistence._dirtyIds.add(id); Persistence._forceIds.add(id); }
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ status: 'ok', updated: 2, persisted: 0, stale: ['atomic-a'], versions: {} }) };
  };
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls[0].body.atomic_optimizer, true);
    assert.ok(calls[0].body.tasks.every(task => task.force === false && task.base_version === 5));
    const queued = calls[0].body.tasks.find(task => task.id === 'atomic-b');
    assert.equal(queued.planning_status, 'needs_planning');
    assert.equal(queued.start_date, null);
    assert.deepEqual(queued.schedule_segments, []);
    assert.deepEqual([...Persistence._dirtyIds].sort(), ['atomic-a', 'atomic-b']);
    assert.equal(calls.length, 1, 'atomic conflict must not overwrite one local row via refresh');
  } finally { globalThis.fetch = original; Persistence._dirtyIds.clear(); Persistence._forceIds.clear(); }
});

test('offline reload preserves both ordinary and dependent optimizer dirty state', () => {
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  const tasks = [{ id: 'offline-queue', MACHINE: 'L1', RUN_TIME: 6, row_version: 7,
    planning_status: 'needs_planning', start_date: null, end_date: null },
  { id: 'offline-move', MACHINE: 'L1', RUN_TIME: 1, row_version: 8,
    start_date: new Date('2026-09-10T08:00:00'), end_date: new Date('2026-09-10T09:00:00') }];
  Store.setTasks(tasks, 'unit-test');
  Persistence._dirtyIds.add('offline-queue'); Persistence._forceIds.add('offline-queue');
  Persistence._dirtyIds.add('offline-move');
  Persistence._saveCache();
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  assert.equal(Persistence._loadCache(), true);
  assert.ok(Persistence._dirtyIds.has('offline-queue'));
  assert.ok(Persistence._dirtyIds.has('offline-move'));
  assert.ok(Persistence._forceIds.has('offline-queue'));
  assert.ok(!Persistence._forceIds.has('offline-move'));
  assert.equal(Store.tasks['offline-queue'].start_date, null);
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  globalThis.localStorage.removeItem(Config.LS_KEY);
});

test('undo after a successful save retains the latest row version for its atomic save', () => {
  Store.setTasks([{ id: 'undo-version', MACHINE: 'L1', RUN_TIME: 1, row_version: 5,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T09:00:00') }], 'unit-test');
  const before = UndoStack.snapshotTasks(['undo-version']);
  Store.updateTask('undo-version', { planning_status: 'needs_planning', start_date: null, end_date: null }, 'engine');
  Store.tasks['undo-version'].row_version = 6;
  UndoStack.restoreTasks(before);
  assert.equal(Store.tasks['undo-version'].row_version, 6);
  assert.equal(Store.tasks['undo-version'].planning_status, 'scheduled');
});

test('optimizer minute precision survives Apply and reload without quarter-hour snapping', () => {
  Store.setTasks([{ id: 'minute-plan', MACHINE: 'L1', RUN_TIME: 1, start_date: null, end_date: null }], 'unit-test');
  const changes = { planning_status: 'scheduled', planning_reason: null,
    start_date: new Date('2026-09-09T08:17:00'), end_date: new Date('2026-09-09T09:17:00') };
  Store.updateMany([{ id: 'minute-plan', changes }], 'engine');
  assert.equal(Store.tasks['minute-plan'].start_date.getMinutes(), 17);
  const reloaded = Persistence._prepTask(JSON.parse(JSON.stringify(Store.tasks['minute-plan'])));
  Store.setTasks([reloaded], 'persistence');
  assert.equal(Store.tasks['minute-plan'].start_date.getMinutes(), 17);
  assert.equal(Store.tasks['minute-plan'].end_date.getMinutes(), 17);
});

test('a save response carrying conflicts toasts a count and emits schedule:conflicts for the machines', async () => {
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  Store.setTasks([{ id: 'cf-a', MACHINE: 'L1', RUN_TIME: 2, row_version: 3,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T10:00:00') }], 'unit-test');
  Persistence._dirtyIds.add('cf-a');
  const originalFetch = globalThis.fetch;
  const originalToast = Toast.show;
  // Util.t() reads bare `window.__NIMBUS_LOCALES` (no locale files are loaded
  // in this ES-module test realm — see tests/modules/foundation.test.mjs's
  // identical pattern) — stub just the key this test needs so the toast
  // message actually interpolates {{count}} instead of falling back to the
  // literal key.
  globalThis.window = globalThis.window || {};
  const originalLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.save_conflicts': '{{count}} conflict(s)' } };
  const toasts = []; const events = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  const unsub = Store.subscribe(evt => { if (evt.type === 'schedule:conflicts') events.push(evt); }, 'test-conflicts');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    status: 'ok', updated: 1, persisted: 1, failed: 0, invalid: 0, not_found: 0,
    invalid_ids: [], not_found_ids: [], stale: [], versions: { 'cf-a': 4 },
    conflicts: [{ machine: 'L1', order_a: 'cf-a', order_b: 'cf-b', overlap_minutes: 60 }],
  }) });
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].lines, ['L1']);
    assert.ok(toasts.some(t => t.type === 'warn' && /1/.test(t.msg)), 'a warn toast naming the conflict count');
    assert.equal(Store.tasks['cf-a'].row_version, 4, 'advisory conflicts never block the re-stamp');
  } finally {
    globalThis.fetch = originalFetch; Toast.show = originalToast;
    globalThis.window.__NIMBUS_LOCALES = originalLocales;
    if (typeof unsub === 'function') unsub();
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  }
});

test('a strict-rollback optimizer save (error_code schedule.conflicts) toasts the conflict-specific message, never re-stamps, and never emits schedule:conflicts', async () => {
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  Store.setTasks([{ id: 'strict-a', MACHINE: 'L1', RUN_TIME: 2, row_version: 3,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T10:00:00') }], 'unit-test');
  Persistence._dirtyIds.add('strict-a'); Persistence._forceIds.add('strict-a');
  const originalFetch = globalThis.fetch;
  const originalToast = Toast.show;
  globalThis.window = globalThis.window || {};
  const originalLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.optimizer_conflicts': 'STRICT {{count}} conflict(s)' } };
  const toasts = []; const events = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  const unsub = Store.subscribe(evt => { if (evt.type === 'schedule:conflicts') events.push(evt); }, 'test-strict-conflicts');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    status: 'error', error_code: 'schedule.conflicts', cause: 'overlap detected',
    updated: 1, persisted: 0, failed: 1, invalid: 0, not_found: 0,
    invalid_ids: [], not_found_ids: [], stale: [], versions: {},
    conflicts: [{ machine: 'L1', plant: 'P1', order_a: 'cf-a', order_b: 'cf-b', overlap_minutes: 60 }],
  }) });
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(events.length, 0, 'the strict branch returns before the advisory schedule:conflicts block');
    assert.ok(toasts.some(t => t.type === 'warn' && /STRICT 1 conflict/.test(t.msg)),
      'a warn toast using the conflict-specific optimizer_conflicts wording');
    assert.equal(Store.tasks['strict-a'].row_version, 3, 'a strict rollback must never re-stamp row_version');
  } finally {
    globalThis.fetch = originalFetch; Toast.show = originalToast;
    globalThis.window.__NIMBUS_LOCALES = originalLocales;
    if (typeof unsub === 'function') unsub();
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  }
});

test('a generic atomic-optimizer rejection (non-conflicts error_code) still shows the pre-existing generic message', async () => {
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  Store.setTasks([{ id: 'generic-a', MACHINE: 'L1', RUN_TIME: 2, row_version: 3,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T10:00:00') }], 'unit-test');
  Persistence._dirtyIds.add('generic-a'); Persistence._forceIds.add('generic-a');
  const originalFetch = globalThis.fetch;
  const originalToast = Toast.show;
  const toasts = []; const events = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  const unsub = Store.subscribe(evt => { if (evt.type === 'schedule:conflicts') events.push(evt); }, 'test-generic-rejection');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    status: 'error', error_code: 'atomic.stale', cause: 'concurrency conflict',
    updated: 1, persisted: 0, failed: 1, invalid: 0, not_found: 0,
    invalid_ids: [], not_found_ids: [], stale: [], versions: {},
  }) });
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(events.length, 0);
    assert.ok(toasts.some(t => t.type === 'warn'
      && t.msg === 'Optimizer changes remain unsaved. Resolve the conflict or reload and optimize again.'),
      'the branch split must not have touched the pre-existing generic wording');
    assert.equal(Store.tasks['generic-a'].row_version, 3);
  } finally {
    globalThis.fetch = originalFetch; Toast.show = originalToast;
    if (typeof unsub === 'function') unsub();
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  }
});

globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ classList: { add() {}, remove() {} }, style: {} }),
    body: { insertBefore() {} },
  };
}

// Minimal in-memory localStorage — Persistence.load()/saveAll()/_saveCache() read and
// write it directly (no DI seam for storage), and plain Node has no global localStorage.
function makeStorage() {
  const store = new Map();
  return {
    getItem:    k => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear:      () => { store.clear(); },
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
  };
}
globalThis.localStorage = globalThis.localStorage || makeStorage();

test('conflict refresh sends identity and API key and reports a failed refresh', async () => {
  const previousFetch = globalThis.fetch;
  const previousToast = Toast.show;
  const calls = [];
  const toasts = [];
  Util.setActorResolver(() => 'planner@example.com');
  Util.setApiKey('test-key');
  globalThis.fetch = async (_url, options) => {
    calls.push(options.headers);
    return { ok: false, status: 401 };
  };
  Toast.show = (...args) => { toasts.push(args); };
  try {
    Persistence._refreshTasks(['order-1']);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].get('x-user-email'), 'planner@example.com');
    assert.equal(calls[0].get('x-api-key'), 'test-key');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][1], 'error');
  } finally {
    globalThis.fetch = previousFetch;
    Toast.show = previousToast;
    Util.setApiKey('');
    Util.setActorResolver(() => undefined);
  }
});

test('Persistence.setCalendarService is settable and Persistence works with a stub before it is wired', () => {
  assert.equal(typeof Persistence.setCalendarService, 'function');
  // A snap-affecting path should not throw even with no calendar service wired yet —
  // it should just skip snapping, not crash the load.
  const tasks = [{
    id: 'nosvc1', MACHINE: 'L9', RUN_TIME: '1',
    start_date: new Date('2026-08-03T00:00:00'),
    end_date:   new Date('2026-08-03T01:00:00'),
  }];
  assert.doesNotThrow(() => Persistence._snapToWorkingHours(tasks, '5512'));
});

test('Persistence.saveAll still posts the documented payload shape (base_version/force/blocks/calendars)', async () => {
  Store.setTasks([{
    id: 'pd1', MACHINE: 'L1', RUN_TIME: '1',
    start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'),
    row_version: '5', PRT_01: 'MOLD-A', PRT_02: 'MOLD-B', PRODUCTION_VERSION: '0001',
  }], 'unit-test');
  Persistence._dirtyIds.add('pd1');

  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ versions: {}, stale: [], persisted: 1, updated: 1 }) });
  };
  try {
    Persistence.saveAll();
    const saveCall = calls.find(c => c.url.includes('/tasks/update'));
    assert.ok(saveCall, 'saveAll must POST to /tasks/update');
    assert.equal(saveCall.opts.method, 'POST');
    const body = JSON.parse(saveCall.opts.body);
    assert.ok(Array.isArray(body.tasks), 'payload must have a tasks array');
    assert.ok(Array.isArray(body.blocks), 'payload must always include blocks');
    assert.ok('calendars' in body, 'payload must always include calendars');
    const t = body.tasks.find(x => x.id === 'pd1');
    assert.ok(t, 'dirty task must be in the payload');
    assert.ok('start_date' in t, 'task must have start_date');
    assert.ok('end_date' in t, 'task must have end_date');
    assert.ok('base_version' in t, 'task must carry base_version for optimistic concurrency');
    assert.ok('force' in t, 'task must carry force flag');
    assert.equal(t.PRT_01, 'MOLD-A');
    assert.equal(t.PRT_02, 'MOLD-B');
    assert.equal(t.PRODUCTION_VERSION, '0001');
    // Flush the fetch → r.json() → result-handler → finally() microtask chain so
    // saveAll()'s _saveInFlight re-entrancy lock is guaranteed clear before the
    // next test's saveAll() call runs (setTimeout is a macrotask boundary, so it
    // forces a full microtask drain first — same pattern used below for the
    // terminally-rejected-ids test).
    await new Promise(res => setTimeout(res, 0));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.saveAll sends the full split aggregate in naive-local form', async () => {
  Store.setTasks([{
    id: 'split-save', MACHINE: 'L1', RUN_TIME: '10',
    start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-04T10:00:00'),
    row_version: '5',
    scheduleSegments: [
      { sequence: 1, startDate: new Date('2026-08-03T08:00:00'), endDate: new Date('2026-08-03T16:00:00') },
      { sequence: 2, startDate: new Date('2026-08-04T08:00:00'), endDate: new Date('2026-08-04T10:00:00') },
    ],
  }], 'unit-test');
  Persistence._dirtyIds.add('split-save');

  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ versions: {}, stale: [], persisted: 1, updated: 1 }) });
  };
  try {
    Persistence.saveAll();
    const saveCall = calls.find(c => c.url.includes('/tasks/update'));
    const task = JSON.parse(saveCall.opts.body).tasks.find(x => x.id === 'split-save');
    assert.equal(task.RUN_TIME, '10');
    assert.deepEqual(task.schedule_segments, [
      { sequence: 1, start_date: '2026-08-03T08:00:00', end_date: '2026-08-03T16:00:00' },
      { sequence: 2, start_date: '2026-08-04T08:00:00', end_date: '2026-08-04T10:00:00' },
    ]);
    // See the flush comment in the payload-shape test above — same reason.
    await new Promise(res => setTimeout(res, 0));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('saveAll clears terminally-rejected ids (invalid_ids/not_found_ids) so they stop being retried forever', async () => {
  // Regression guard for a latent client↔server contract bug: the backend's
  // /tasks/update forwards invalid_ids/not_found_ids (terminal rejections — inverted
  // range or id-not-in-DB) and saveAll's R7 logic must add them to its `accounted`
  // set and clear them from _dirtyIds. Before the fix the endpoint sent only counts,
  // so these ids never cleared → they re-posted on every save and spammed a
  // "Partial DB save" warning with no way to resolve.
  Store.setTasks([
    { id: 'ok1',       MACHINE: 'L1', RUN_TIME: '1', start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'), row_version: '5' },
    { id: 'bad-range', MACHINE: 'L1', RUN_TIME: '1', start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'), row_version: '5' },
    { id: 'gone',      MACHINE: 'L1', RUN_TIME: '1', start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'), row_version: '5' },
  ], 'unit-test');
  Persistence._dirtyIds.add('ok1');
  Persistence._dirtyIds.add('bad-range');
  Persistence._dirtyIds.add('gone');

  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      versions: { ok1: '6' }, stale: [],
      invalid_ids: ['bad-range'], not_found_ids: ['gone'],
      persisted: 1, updated: 3,
    }),
  });
  try {
    Persistence.saveAll();
    // Flush the fetch → r.json() → result-handler microtask chain (saveAll returns void).
    await new Promise(res => setTimeout(res, 0));
    assert.ok(!Persistence._dirtyIds.has('ok1'),       'persisted id must clear');
    assert.ok(!Persistence._dirtyIds.has('bad-range'), 'invalid_ids id must clear (terminal — do not retry forever)');
    assert.ok(!Persistence._dirtyIds.has('gone'),      'not_found_ids id must clear (terminal — row not in DB)');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('PR-1: saveAll removes not_found_ids from Store (not just clears the dirty flag) and toasts the removed count', async () => {
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  Store.setTasks([{ id: 'gone-remote', MACHINE: 'L1', RUN_TIME: 1, row_version: 5,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T09:00:00') }], 'unit-test');
  Persistence._dirtyIds.add('gone-remote');
  const originalFetch = globalThis.fetch;
  const originalToast = Toast.show;
  globalThis.window = globalThis.window || {};
  const originalLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.orders_removed_remotely': '{{count}} removed' } };
  const toasts = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    status: 'ok', updated: 1, persisted: 0, failed: 1, invalid: 0, not_found: 1,
    invalid_ids: [], not_found_ids: ['gone-remote'], stale: [], versions: {},
  }) });
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(Store.tasks['gone-remote'], undefined,
      'a not_found_ids row must be removed from Store, not left behind as a permanent ghost');
    assert.ok(!Persistence._dirtyIds.has('gone-remote'), 'a removed ghost must not stay dirty and get resent');
    assert.ok(toasts.some(t => t.type === 'warn' && /1 removed/.test(t.msg)),
      'a toast naming the removed count');
  } finally {
    globalThis.fetch = originalFetch; Toast.show = originalToast;
    globalThis.window.__NIMBUS_LOCALES = originalLocales;
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  }
});

test('PR-1: _refreshTasks removes ids in `missing` from Store and toasts once for the whole batch', async () => {
  Store.setTasks([
    { id: 'ghost-1', MACHINE: 'L1', RUN_TIME: 1, start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T09:00:00') },
    { id: 'ghost-2', MACHINE: 'L1', RUN_TIME: 1, start_date: new Date('2026-09-09T09:00:00'), end_date: new Date('2026-09-09T10:00:00') },
  ], 'unit-test');
  Persistence._dirtyIds.add('ghost-1');
  const originalFetch = globalThis.fetch;
  const originalToast = Toast.show;
  globalThis.window = globalThis.window || {};
  const originalLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.orders_removed_remotely': '{{count}} removed' } };
  const toasts = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [], missing: ['ghost-1', 'ghost-2'] }) });
  try {
    Persistence._refreshTasks(['ghost-1', 'ghost-2']);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(Store.tasks['ghost-1'], undefined, 'a missing id must be removed from Store');
    assert.equal(Store.tasks['ghost-2'], undefined, 'a missing id must be removed from Store');
    assert.ok(!Persistence._dirtyIds.has('ghost-1'), 'a removed ghost must not stay dirty');
    assert.equal(toasts.filter(t => /removed/.test(t.msg)).length, 1, 'exactly one toast for the whole batch');
    assert.ok(toasts.some(t => t.type === 'warn' && /2 removed/.test(t.msg)));
  } finally {
    globalThis.fetch = originalFetch; Toast.show = originalToast;
    globalThis.window.__NIMBUS_LOCALES = originalLocales;
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  }
});

test('PR-1: _refreshTasks does not remove or toast when `missing` is absent/empty', async () => {
  Store.setTasks([{ id: 'kept-1', MACHINE: 'L1', RUN_TIME: 1,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T09:00:00'), row_version: 1 }], 'unit-test');
  const originalFetch = globalThis.fetch;
  const originalToast = Toast.show;
  const toasts = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    data: [{ id: 'kept-1', start_date: '2026-09-09T10:00:00', end_date: '2026-09-09T11:00:00', row_version: 2 }],
  }) });
  try {
    Persistence._refreshTasks(['kept-1']);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(Store.tasks['kept-1'], 'a task still present server-side must not be removed');
    assert.equal(toasts.length, 0, 'no removal toast when nothing was removed');
  } finally {
    globalThis.fetch = originalFetch; Toast.show = originalToast;
  }
});

test('a load that needs to snap a task to working hours calls the injected calendar service, not a global', () => {
  const calls = [];
  Persistence.setCalendarService({
    beginRun: (plant) => calls.push(['beginRun', plant]),
    endRun: () => calls.push(['endRun']),
    nextAvailable: (line, from, ms) => { calls.push(['nextAvailable', line]); return from; },
    workWindow: (line, date) => { calls.push(['workWindow', line]); return null; },
  });
  const tasks = [{
    id: 'snap1', MACHINE: 'L9', RUN_TIME: '1',
    start_date: new Date('2026-08-03T00:00:00'), // midnight -> triggers the snap path
    end_date:   new Date('2026-08-03T01:00:00'),
  }];
  Persistence._snapToWorkingHours(tasks, '5512');
  assert.ok(calls.some(c => c[0] === 'beginRun'), 'must call the injected beginRun');
  assert.ok(calls.some(c => c[0] === 'nextAvailable'), 'must call the injected nextAvailable');
  assert.ok(calls.some(c => c[0] === 'endRun'), 'must call the injected endRun');
});


test('Persistence.loadPriorityRankMaps returns a real awaitable promise and null-clears the cache', async () => {
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } });
  Persistence._rankMapsPlant = '5512';
  const p = Persistence.loadPriorityRankMaps(null);
  assert.ok(p instanceof Promise, 'must return a real promise, not fire-and-forget');
  await p;
  assert.deepEqual(Store.priorityRankMaps, {});
  assert.equal(Persistence._rankMapsPlant, null);
});

test('Persistence.loadPriorityRankMaps fetches GET /priority-rank-maps?plant= and tracks freshness on success', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ '': { colorWheel: { RED: 1 } } }) });
  };
  try {
    await Persistence.loadPriorityRankMaps('5512');
    assert.ok(calls.some(u => u.includes('/priority-rank-maps?plant=5512')), 'must GET the plant-scoped endpoint');
    assert.deepEqual(Store.priorityRankMaps, { '': { colorWheel: { RED: 1 } } });
    assert.equal(Persistence._rankMapsPlant, '5512', 'freshness marker must record the plant just fetched');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.loadPriorityRankMaps does NOT mark a plant fresh on a resolved-but-non-ok response (e.g. a transient 502)', async () => {
  // Regression guard: a resolved response with ok:false (unlike a thrown/rejected
  // fetch) previously still set _rankMapsPlant = plant, which would make Task 6's
  // freshness check (`_rankMapsPlant !== plant`) wrongly trust an empty cache as
  // current — silently ranking every order at the 999999 default with no error.
  Persistence._rankMapsPlant = null;
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
  try {
    await Persistence.loadPriorityRankMaps('5512');
    assert.deepEqual(Store.priorityRankMaps, {}, 'a non-ok response must not leave stale data lying around');
    assert.notEqual(Persistence._rankMapsPlant, '5512', 'must NOT claim freshness for a plant whose response was resolved-but-not-ok');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.loadPriorityRankMaps clears the cache but leaves the freshness marker stale on network failure, so a later check still retries', async () => {
  Persistence._rankMapsPlant = null;
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  try {
    await Persistence.loadPriorityRankMaps('9999');
    assert.deepEqual(Store.priorityRankMaps, {}, 'a failed fetch must not leave stale data lying around');
    assert.notEqual(Persistence._rankMapsPlant, '9999', 'must NOT claim freshness for a plant whose fetch failed');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.loadPriorityRankMaps goes through Util.fetchTraced, so the plant-gate identity header is sent', async () => {
  // GET /priority-rank-maps is plant-gated server-side (brain.py's
  // _assert_plant_allowed). The actor identity that gate reads rides on the
  // x-user-email header Util.fetchTraced attaches — a bare fetch() sends none and
  // 403s for every plant-restricted user. Assert the header actually arrives, which
  // is the only observable difference between the two call styles from here.
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? null });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  try {
    await Persistence.loadPriorityRankMaps('5512');
    assert.equal(seen.length, 1);
    const h = seen[0].headers;
    assert.ok(h && typeof h.get === 'function', 'fetchTraced must pass a real Headers object');
    assert.ok(h.has('x-request-id'), 'x-request-id must be attached (backend log correlation)');
    assert.ok(h.has('x-user-email') || h.has('X-User'),
      'an identity header must be attached or the server-side plant gate rejects the request');
  } finally {
    globalThis.fetch = origFetch;
  }
});

function setupSnapshot(plant, plantActive = false) {
  return {
    plant,
    definition: null,
    plant_rows: [],
    machine_rows: [],
    machine_states: [],
    overrides: [],
    // Workstream D2 (2026-08-20): plants.setup_active, surfaced as the
    // top-level plant_active field — independent of definition.active.
    plant_active: plantActive,
    freshness: { signature_version: null, request_id: `setup-${plant}` },
  };
}

test('Persistence.loadSetupSnapshot round-trips plant_active from GET /setup/{plant} into Store.setupSnapshot', async () => {
  const priorSnapshot = Store.setupSnapshot;
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(setupSnapshot('PLANT_ACTIVE', true)) });
  try {
    const snapshot = await Persistence.loadSetupSnapshot('PLANT_ACTIVE');
    assert.equal(snapshot.plant_active, true, 'loadSetupSnapshot must return the fetched plant_active verbatim');
    assert.equal(Store.setupSnapshot?.plant_active, true, 'Store.setupSnapshot must carry plant_active through unchanged');
  } finally {
    globalThis.fetch = origFetch;
    Store.replaceSetupSnapshot(priorSnapshot, 'unit-test');
  }
});

test('Persistence.loadSetupSnapshot clears the outgoing plant before the replacement request resolves', async () => {
  Store.replaceSetupSnapshot(setupSnapshot('PLANT_A'), 'unit-test');
  Persistence._setupSnapshotPlant = 'PLANT_A';
  let resolveRequest;
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(resolve => { resolveRequest = resolve; });
  try {
    const loading = Persistence.loadSetupSnapshot('PLANT_B');
    assert.equal(Store.setupSnapshot, null, 'the outgoing plant snapshot must disappear before PLANT_B can hydrate');
    assert.equal(Persistence._setupSnapshotPlant, null, 'the freshness marker must remain stale until a successful response');
    resolveRequest({ ok: true, json: () => Promise.resolve(setupSnapshot('PLANT_B')) });
    await loading;
    assert.equal(Store.setupSnapshot?.plant, 'PLANT_B');
    assert.equal(Persistence._setupSnapshotPlant, 'PLANT_B');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.loadSetupSnapshot leaves setup state stale and empty after a failed fetch', async () => {
  Store.replaceSetupSnapshot(setupSnapshot('PLANT_A'), 'unit-test');
  Persistence._setupSnapshotPlant = 'PLANT_A';
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
  try {
    const result = await Persistence.loadSetupSnapshot('PLANT_B');
    assert.equal(result, null);
    assert.equal(Store.setupSnapshot, null, 'a failed plant load must not retain PLANT_A data');
    assert.notEqual(Persistence._setupSnapshotPlant, 'PLANT_B', 'a failed response must never be marked fresh');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.loadSetupSnapshot suppresses an older plant response after a newer plant request starts', async () => {
  const pending = new Map();
  const origFetch = globalThis.fetch;
  globalThis.fetch = url => new Promise(resolve => { pending.set(String(url), resolve); });
  try {
    const oldRequest = Persistence.loadSetupSnapshot('PLANT_A');
    const newRequest = Persistence.loadSetupSnapshot('PLANT_B');
    pending.get('/setup/PLANT_B')({ ok: true, json: () => Promise.resolve(setupSnapshot('PLANT_B')) });
    await newRequest;
    pending.get('/setup/PLANT_A')({ ok: true, json: () => Promise.resolve(setupSnapshot('PLANT_A')) });
    assert.equal(await oldRequest, null, 'the stale request must report that it did not hydrate Store');
    assert.equal(Store.setupSnapshot?.plant, 'PLANT_B', 'a late PLANT_A response must not overwrite the active plant data');
    assert.equal(Persistence._setupSnapshotPlant, 'PLANT_B');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// Stage 3 fix — the rank cache must not survive a plant switch.
//
// The window this closes: load() calls Store.setTasks() and emits the FIRST
// 'schedule:hydrated' (which triggers the alert recompute that renders auto-fix
// buttons) long before loadPriorityRankMaps() runs for the new plant — that call
// sits inside the master-data Promise.all's .finally(). Without an early clear,
// the new plant's orders and alerts are on screen while Store.priorityRankMaps
// still holds the OLD plant's ranks, and Alerts.applyFix's overload branch —
// which cannot await freshness (optimization/engine.mjs must not import
// this module) — would sequence against the wrong plant's priority lists.
// ---------------------------------------------------------------------------

test('Persistence.load drops the previous plant\'s rank maps immediately on a plant switch, before the new fetch resolves', () => {
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1, BLUE: 2 } } }, 'unit-test');
  Persistence._rankMapsPlant = 'PLANT_A';

  const origFetch = globalThis.fetch;
  // Nothing ever settles: this pins the assertion to exactly the window between
  // "load started for the new plant" and "the new plant's ranks arrived".
  globalThis.fetch = () => new Promise(() => {});
  try {
    const p = Persistence.load({ plant: 'PLANT_B' });
    if (p && typeof p.catch === 'function') p.catch(() => {});

    assert.deepEqual(Store.priorityRankMaps, {},
      'PLANT_A\'s ranks must be gone the moment a load for PLANT_B starts — otherwise an overload auto-fix in this window sequences PLANT_B\'s orders against PLANT_A\'s priority lists');
    assert.equal(Persistence._rankMapsPlant, null,
      'the freshness marker must read stale so OptimizeDialog.run()\'s guard re-fetches');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.load does NOT wipe a still-valid cache when reloading the SAME plant', () => {
  // The clear is conditional on an actual change: a force-reload of the current
  // plant must not needlessly discard good ranks and open a fresh unranked window.
  const maps = { '': { colorWheel: { RED: 1 } } };
  Store.setPriorityRankMaps(maps, 'unit-test');
  Persistence._rankMapsPlant = 'PLANT_A';

  const origFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const p = Persistence.load({ plant: 'PLANT_A', force: true });
    if (p && typeof p.catch === 'function') p.catch(() => {});

    assert.deepEqual(Store.priorityRankMaps, maps, 'same-plant reload must keep the cache');
    assert.equal(Persistence._rankMapsPlant, 'PLANT_A', 'same-plant reload must keep the freshness marker');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence._loadCache clears the rank cache — the offline restore hydrates without ever loading rank maps', () => {
  // Same exposure as _loadDemo: this is the backend-failed / boot restore path. It
  // rehydrates whatever plant was last persisted, which need not be the plant the
  // rank cache holds, and it emits schedule:hydrated regardless.
  globalThis.localStorage.setItem(Config.LS_KEY, JSON.stringify({
    _schemaVersion: Config.SCHEMA_VERSION,
    tasks: [],
  }));
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  Persistence._rankMapsPlant = 'PLANT_A';
  try {
    assert.equal(Persistence._loadCache(), true, 'a schema-current cache must restore');
    assert.deepEqual(Store.priorityRankMaps, {},
      'ranks cannot be trusted to match a cache-restored board, so they must be dropped');
    assert.equal(Persistence._rankMapsPlant, null);
  } finally {
    globalThis.localStorage.removeItem(Config.LS_KEY);
  }
});

test('Persistence._loadDemo clears the rank cache — it hydrates and emits schedule:hydrated but never loads rank maps', () => {
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  Persistence._rankMapsPlant = 'PLANT_A';
  Persistence._loadDemo();
  assert.deepEqual(Store.priorityRankMaps, {},
    'demo orders belong to no real plant\'s priority lists, so any retained ranks are categorically wrong for them');
  assert.equal(Persistence._rankMapsPlant, null);
});

// ---------------------------------------------------------------------------
// Whole-branch review fix — the same stale-plant exposure applies to the C1/C2
// horizon fields. Store.visibilityHorizonEnd/frozenHorizonEnd are set only on a
// successful /tasks 2xx (see load() above); the offline fallback paths
// (_loadCache/_loadDemo) hydrate a DIFFERENT plant's tasks without ever
// touching them, so a stale horizon from whatever plant was on screen before
// the backend went unreachable would otherwise leak onto the newly-rendered
// plant (wrongly clamping the Gantt/hiding grid rows, or wrongly refusing to
// schedule into a window the new plant never configured).
// ---------------------------------------------------------------------------

test('Persistence._loadCache clears stale visibility/frozen horizon state from a previously-loaded plant', () => {
  globalThis.localStorage.setItem(Config.LS_KEY, JSON.stringify({
    _schemaVersion: Config.SCHEMA_VERSION,
    tasks: [],
  }));
  Store.setVisibilityHorizonEnd(new Date('2026-09-01T00:00:00Z'), 'unit-test');
  Store.setFrozenHorizonEnd(new Date('2026-08-25T00:00:00Z'), 'unit-test');
  try {
    assert.equal(Persistence._loadCache(), true, 'a schema-current cache must restore');
    assert.equal(Store.visibilityHorizonEnd, null,
      'a stale visibility horizon from the previously-loaded plant must not carry over to the cache-restored plant');
    assert.equal(Store.frozenHorizonEnd, null,
      'a stale frozen horizon from the previously-loaded plant must not carry over to the cache-restored plant');
  } finally {
    globalThis.localStorage.removeItem(Config.LS_KEY);
  }
});

test('Persistence._loadDemo clears stale visibility/frozen horizon state from a previously-loaded plant', () => {
  Store.setVisibilityHorizonEnd(new Date('2026-09-01T00:00:00Z'), 'unit-test');
  Store.setFrozenHorizonEnd(new Date('2026-08-25T00:00:00Z'), 'unit-test');
  Persistence._loadDemo();
  assert.equal(Store.visibilityHorizonEnd, null,
    'demo orders belong to no real plant, so any retained visibility horizon is categorically wrong for them');
  assert.equal(Store.frozenHorizonEnd, null,
    'demo orders belong to no real plant, so any retained frozen horizon is categorically wrong for them');
});

test('Persistence.isLoading() returns false at rest', () => {
  // Reset _loadsInFlight state in case previous async tests left it non-zero
  const priorLoadsInFlight = Persistence._loadsInFlight;
  Persistence._loadsInFlight = 0;
  try {
    assert.equal(Persistence.isLoading(), false, 'isLoading must return false when no loads are in flight');
  } finally {
    Persistence._loadsInFlight = priorLoadsInFlight;
  }
});

test('Persistence.refreshHorizons(null) resolves false without calling fetch', async () => {
  const priorFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = () => { fetchCalled = true; return Promise.reject(new Error('should not be called')); };
  try {
    const result = await Persistence.refreshHorizons(null);
    assert.equal(result, false, 'refreshHorizons(null) must resolve false');
    assert.equal(fetchCalled, false, 'refreshHorizons(null) must not call fetch');
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test('Persistence.refreshHorizons happy path: fetches horizons, applies changes to Store, patches masterData, and respects throttle', async () => {
  const priorFetch = globalThis.fetch;
  const priorSelectedPlant = Store.selectedPlant;
  const priorVisibilityHorizonEnd = Store.visibilityHorizonEnd;
  const priorFrozenHorizonEnd = Store.frozenHorizonEnd;
  const priorMasterData = Store.masterData;
  let fetchCount = 0;

  // Set up Store state
  Store.setSelectedPlant('P1', 'unit-test');
  Store.setMasterData({
    plants: [{ plant: 'P1', alt_flag_horizon: 100 }],
    lines: [],
  }, 'unit-test');

  globalThis.fetch = async () => {
    fetchCount++;
    return {
      ok: true,
      json: async () => ({
        visibility_horizon_end: '2026-10-01T00:00:00',
        frozen_horizon_end: '2026-09-20T00:00:00',
        alert_horizon_minutes: 250,
      }),
    };
  };

  try {
    // Delete throttle entry to allow the call
    delete Persistence._horizonsFetchedAt['P1'];

    const result = await Persistence.refreshHorizons('P1');
    assert.equal(result, true, 'refreshHorizons should resolve true when changes are applied');
    assert.equal(fetchCount, 1, 'should have called fetch once');
    assert.equal(Store.frozenHorizonEnd?.getTime(), new Date('2026-09-20T00:00:00').getTime(), 'frozenHorizonEnd should be set');
    assert.equal(Store.visibilityHorizonEnd?.getTime(), new Date('2026-10-01T00:00:00').getTime(), 'visibilityHorizonEnd should be set');
    assert.equal(Store.masterData.plants[0].alt_flag_horizon, 250, 'alt_flag_horizon should be patched');

    // Call again immediately — should be throttled
    const result2 = await Persistence.refreshHorizons('P1');
    assert.equal(result2, false, 'refreshHorizons within 10s throttle should resolve false');
    assert.equal(fetchCount, 1, 'should not call fetch again within throttle window');
  } finally {
    globalThis.fetch = priorFetch;
    Store.setSelectedPlant(priorSelectedPlant, 'unit-test');
    Store.setVisibilityHorizonEnd(priorVisibilityHorizonEnd, 'unit-test');
    Store.setFrozenHorizonEnd(priorFrozenHorizonEnd, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    delete Persistence._horizonsFetchedAt['P1'];
  }
});

test('Persistence.refreshHorizons non-OK response resolves false and does not apply changes', async () => {
  const priorFetch = globalThis.fetch;
  const priorSelectedPlant = Store.selectedPlant;
  const priorFrozenHorizonEnd = Store.frozenHorizonEnd;
  const priorVisibilityHorizonEnd = Store.visibilityHorizonEnd;

  Store.setSelectedPlant('P2', 'unit-test');
  Store.setFrozenHorizonEnd(new Date('2026-08-01T00:00:00'), 'unit-test');
  Store.setVisibilityHorizonEnd(new Date('2026-09-01T00:00:00'), 'unit-test');

  globalThis.fetch = async () => ({ ok: false, status: 404 });

  try {
    delete Persistence._horizonsFetchedAt['P2'];
    const result = await Persistence.refreshHorizons('P2');
    assert.equal(result, false, 'refreshHorizons should resolve false on non-OK response');
    assert.equal(Store.frozenHorizonEnd?.getTime(), new Date('2026-08-01T00:00:00').getTime(), 'frozenHorizonEnd should remain unchanged');
    assert.equal(Store.visibilityHorizonEnd?.getTime(), new Date('2026-09-01T00:00:00').getTime(), 'visibilityHorizonEnd should remain unchanged');
  } finally {
    globalThis.fetch = priorFetch;
    Store.setSelectedPlant(priorSelectedPlant, 'unit-test');
    Store.setFrozenHorizonEnd(priorFrozenHorizonEnd, 'unit-test');
    Store.setVisibilityHorizonEnd(priorVisibilityHorizonEnd, 'unit-test');
    delete Persistence._horizonsFetchedAt['P2'];
  }
});

// ---------------------------------------------------------------------------
// D25 — sap_workcenter is per-plant master data (never a global/all-plants
// fetch); the plant-load paths must scope the request, and the three
// master-data `.then` handlers (no-plant/zero-task/main) must discard a
// response superseded by a newer load() before it can clobber Store.
// ---------------------------------------------------------------------------

test('D25: a plant load fetches sap_workcenter scoped to that plant (?plant=)', async () => {
  const originalFetch = globalThis.fetch;
  const priorMasterData = Store.masterData;
  const priorLoadsInFlight = Persistence._loadsInFlight;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/tasks?')) return { ok: true, json: async () => ({ data: [] }) };
    if (u.includes('/master-data/')) return { ok: true, json: async () => ({ rows: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    Persistence.load({ plant: 'PLANT-SCOPE' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    const wcCall = calls.find(u => u.includes('/master-data/sap_workcenter'));
    assert.ok(wcCall, 'sap_workcenter must still be fetched when a plant is loaded');
    assert.ok(wcCall.includes('?plant=PLANT-SCOPE'), `sap_workcenter fetch must be scoped to the loaded plant, got: ${wcCall}`);
  } finally {
    globalThis.fetch = originalFetch;
    Store.setMasterData(priorMasterData, 'unit-test');
    Persistence._loadsInFlight = priorLoadsInFlight;
  }
});

test('D25: loading with no plant selected never fetches sap_workcenter and sets workcenters to []', async () => {
  const originalFetch = globalThis.fetch;
  const priorMasterData = Store.masterData;
  const priorLoadsInFlight = Persistence._loadsInFlight;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    return { ok: true, json: async () => ({ rows: [] }) };
  };
  try {
    await Persistence.load({ plant: null });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(!calls.some(u => u.includes('/master-data/sap_workcenter')),
      'the no-plant path must skip the sap_workcenter fetch entirely');
    assert.deepEqual(Store.masterData?.workcenters, [], 'workcenters must still be set to [] without fetching');
  } finally {
    globalThis.fetch = originalFetch;
    Store.setMasterData(priorMasterData, 'unit-test');
    Persistence._loadsInFlight = priorLoadsInFlight;
  }
});

test('D25: a late Plant A master-data response after switching to Plant B is discarded, not overwriting Plant B\'s master data', async () => {
  const originalFetch = globalThis.fetch;
  const priorMasterData = Store.masterData;
  const priorLoadsInFlight = Persistence._loadsInFlight;
  const pendingWc = {};
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/tasks?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    if (u.includes('/master-data/sap_workcenter')) {
      return new Promise(resolve => { pendingWc[u] = resolve; });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) });
  };
  try {
    const loadA = Persistence.load({ plant: 'PLANT-A' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const loadB = Persistence.load({ plant: 'PLANT-B' });
    await new Promise(resolve => setTimeout(resolve, 0));

    const aKey = Object.keys(pendingWc).find(u => u.includes('PLANT-A'));
    const bKey = Object.keys(pendingWc).find(u => u.includes('PLANT-B'));
    assert.ok(aKey && bKey, 'both plants must have an in-flight sap_workcenter fetch at this point');

    // B's response lands first and hydrates Store normally.
    pendingWc[bKey]({ ok: true, json: () => Promise.resolve({ rows: [{ plant: 'PLANT-B', sap_workcenter: 'WC-B' }] }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(Store.masterData.workcenters, [{ plant: 'PLANT-B', sap_workcenter: 'WC-B' }]);

    // A's late response arrives after — it belongs to a load() generation the
    // user has since navigated away from and must be discarded outright.
    pendingWc[aKey]({ ok: true, json: () => Promise.resolve({ rows: [{ plant: 'PLANT-A', sap_workcenter: 'WC-A' }] }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(Store.masterData.workcenters, [{ plant: 'PLANT-B', sap_workcenter: 'WC-B' }],
      'a late Plant A master-data response must not overwrite Plant B\'s already-applied master data');

    await Promise.all([loadA, loadB]).catch(() => {});
  } finally {
    globalThis.fetch = originalFetch;
    Store.setMasterData(priorMasterData, 'unit-test');
    Persistence._loadsInFlight = priorLoadsInFlight;
  }
});


// Bundle 0 #2 (docs/Code_Review_Consolidated_10_05.md): cross-seam save contract.
// The browser's REAL saveAll() body for a distribution sub-order and for a
// routing-enabled-plant order is captured here and pinned in a checked-in shared
// fixture (same pattern as routing_cases.json). tests/test_task_concurrency.py
// POSTs those exact bodies through FastAPI against the real DB, so a payload-shape
// change on either side (the C1/N09/R3 class of regressions) fails a test.
// Regenerate deliberately with: NIMBUS_UPDATE_FIXTURES=1 node --test <this file>
const SAVE_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/save_payload_cases.json', import.meta.url));

async function captureSavePayload(raw, edit) {
  const [task] = [Persistence._prepTask(raw)];
  Store.setTasks([task], 'unit-test');
  Store.updateTask(task.id, edit, 'unit-test');
  Persistence._dirtyIds.add(String(task.id));
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ versions: {}, stale: [], persisted: 1, updated: 1 }) });
  };
  try {
    Persistence.saveAll();
    const call = calls.find(c => c.url.includes('/tasks/update'));
    assert.ok(call, 'saveAll must POST to /tasks/update');
    await new Promise(res => setTimeout(res, 0));
    const body = JSON.parse(call.opts.body);
    // blocks/calendars are legacy ride-alongs the server ignores (see
    // frontend/scheduling/CLAUDE.md) and carry demo-seeded, random-id Store state;
    // pin them to empty so the fixture is deterministic.
    assert.ok(Array.isArray(body.blocks) && 'calendars' in body, 'saveAll must still send blocks + calendars');
    return { ...body, blocks: [], calendars: {} };
  } finally {
    globalThis.fetch = origFetch;
    Persistence._dirtyIds.clear();
  }
}

test('cross-seam: saveAll payloads for a sub-order and a routing-plant order match the shared fixture', async () => {
  const cases = {
    sub_order: {
      seed: { kind: 'sub_order', plant: 'ZZTEST_XSEAM_P1', machine: 'ZZTEST_XSEAM_L1', production_order: 'ZZTEST_XSEAM_A-1000',
        parent_order: 'ZZTEST_XSEAM_A', distribution_letter: 'A', run_time: 4, production_version: '0001',
        start_date: '2026-10-06T08:00:00', end_date: '2026-10-06T12:00:00' },
      raw: { id: 'zztest-xseam-sub', MACHINE: 'ZZTEST_XSEAM_L1', RUN_TIME: 4, PRT_01: 'TOOL-A', PRT_02: null,
        PRODUCTION_VERSION: '0001', PARENT_ORDER: 'ZZTEST_XSEAM_A', DISTRIBUTION_LETTER: 'A', row_version: 5,
        start_date: '2026-10-06T08:00:00', end_date: '2026-10-06T12:00:00', schedule_segments: [] },
      edit: { start_date: new Date('2026-10-07T08:00:00'), end_date: new Date('2026-10-07T13:00:00'),
        scheduleSegments: [{ sequence: 1, startDate: new Date('2026-10-07T08:00:00'), endDate: new Date('2026-10-07T10:00:00') },
          { sequence: 2, startDate: new Date('2026-10-07T11:00:00'), endDate: new Date('2026-10-07T13:00:00') }] },
    },
    routing_plant: {
      seed: { kind: 'routing_plant', plant: 'ZZTEST_XSEAM_P2', machine: 'ZZTEST_XSEAM_L2', production_order: 'ZZTEST_XSEAM_R-1',
        parent_order: null, distribution_letter: null, run_time: 3.5, production_version: '0002',
        start_date: '2026-10-06T08:00:00', end_date: '2026-10-06T11:30:00' },
      raw: { id: 'zztest-xseam-routing', MACHINE: 'ZZTEST_XSEAM_L2', RUN_TIME: 3.5, PRT_01: null, PRT_02: null,
        PRODUCTION_VERSION: '0002', PARENT_ORDER: null, DISTRIBUTION_LETTER: null, row_version: 7,
        start_date: '2026-10-06T08:00:00', end_date: '2026-10-06T11:30:00', schedule_segments: [] },
      edit: { start_date: new Date('2026-10-07T08:00:00'), end_date: new Date('2026-10-07T11:30:00') },
    },
  };
  const generated = { _comment: 'Generated by tests/modules/scheduling/persistence.test.mjs (cross-seam test); consumed by tests/test_task_concurrency.py. base_version is a placeholder - the Python side substitutes the seeded row xmin. Regenerate: NIMBUS_UPDATE_FIXTURES=1 node --test tests/modules/scheduling/persistence.test.mjs', cases: {} };
  for (const [name, c] of Object.entries(cases)) {
    generated.cases[name] = { seed: c.seed, request: await captureSavePayload(c.raw, c.edit) };
  }
  if (process.env.NIMBUS_UPDATE_FIXTURES === '1') {
    writeFileSync(SAVE_FIXTURE_PATH, JSON.stringify(generated, null, 2) + '\n');
  }
  const checkedIn = JSON.parse(readFileSync(SAVE_FIXTURE_PATH, 'utf8'));
  assert.deepEqual(generated, checkedIn,
    'saveAll payload drifted from tests/modules/fixtures/save_payload_cases.json; if intentional, regenerate with NIMBUS_UPDATE_FIXTURES=1 and re-run tests/test_task_concurrency.py');
});

test('#24 reconnect reloads the plant that was ATTEMPTED, not the null _currentLoadedPlant of a failed boot load', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // virtual clock: the 1s backoff is ticked, not slept
  const origFetch = globalThis.fetch;
  const priorLoad = Persistence.load;
  const priorLoaded = Persistence._currentLoadedPlant;
  const loads = [];
  try {
    Persistence._currentLoadedPlant = null;
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.includes('/tasks')) return Promise.reject(new Error('offline'));
      if (u.includes('/health')) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      return Promise.reject(new Error('offline'));
    };
    await Persistence.load({ plant: 'PLANT-ATTEMPT' }).catch(() => {});
    assert.equal(Persistence._lastAttemptedPlant, 'PLANT-ATTEMPT');
    assert.equal(Persistence._currentLoadedPlant, null);
    Persistence.load = (opts) => { loads.push(opts); return Promise.resolve(); };
    Persistence._reconnect.start();
    t.mock.timers.tick(1000); // first backoff delay
    for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res)); // let the /health promise chain settle
    assert.equal(loads.length, 1);
    assert.equal(loads[0].plant, 'PLANT-ATTEMPT');
  } finally {
    Persistence._reconnect.stop();
    Persistence.load = priorLoad;
    Persistence._currentLoadedPlant = priorLoaded;
    globalThis.fetch = origFetch;
  }
});

test('#29 save POST carries a timeout signal, a timeout toasts an error (no blind retry), and a second Save while in flight toasts', async () => {
  Store.setTasks([{
    id: 'to1', MACHINE: 'L1', RUN_TIME: '1',
    start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'), row_version: '5',
  }], 'unit-test');
  const calls = [];
  const toasts = [];
  const origFetch = globalThis.fetch;
  const origToast = Toast.show;
  Toast.show = (msg, type) => { toasts.push([msg, type]); };
  globalThis.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
  };
  try {
    Persistence._dirtyIds.add('to1');
    Persistence.saveAll();
    Persistence.saveAll(); // second Save while the first is still in flight
    assert.ok(toasts.some(([m, t]) => m === 'toast.save_in_progress' && t === 'warn'), 'second save is reported, not just logged');
    await new Promise(res => setImmediate(res));
    const saves = calls.filter(c => c.url.includes('/tasks/update'));
    assert.equal(saves.length, 1, 'a timeout is not retried blind');
    assert.ok(saves[0].opts.signal instanceof AbortSignal, 'save POST must carry an AbortSignal timeout');
    assert.ok(toasts.some(([m, t]) => m === 'toast.save_timeout' && t === 'error'), 'timeout shows an error toast');
    assert.equal(Persistence._saveInFlight, false, 'lock released after a timeout');
    assert.ok(Persistence._dirtyIds.has('to1'), 'edit stays dirty after a timeout');
  } finally {
    globalThis.fetch = origFetch;
    Toast.show = origToast;
    Persistence._dirtyIds.delete('to1');
  }
});

test('describeRejections names the rejected orders and their reasons, capped with a +N more tail (D29)', async () => {
  const { describeRejections } = await import('../../../frontend/scheduling/persistence.mjs');
  assert.equal(describeRejections({}), '');
  assert.equal(describeRejections(undefined), '');
  assert.equal(describeRejections({ A: 'runtime_preview_changed' }), '', 'preview changes have their own toast');
  assert.equal(describeRejections({ A: 'machine_unknown' }), '', 'unknown machines have their own toast (no double report)');
  const text = describeRejections({ A: 'pv_expired', B: 'something_new', C: 'no_routing', D: 'zero_runtime' }, 3);
  assert.match(text, /^A: /);
  assert.match(text, /B: something_new/, 'unknown codes fall back to the raw code');
  assert.doesNotMatch(text, /D: /, 'capped at the limit');
  assert.match(text, /reject_more|\+1 more/, 'tail present (locale keys are unresolved under Node)');
});

test('saveAll while a save is in flight toasts for a user save but stays silent for programmatic callers', () => {
  const origShow = Toast.show;
  const toasts = [];
  Toast.show = (msg) => { toasts.push(msg); };
  const prev = Persistence._saveInFlight;
  Persistence._saveInFlight = true;
  try {
    Persistence.saveAll({ silent: true });
    assert.equal(toasts.length, 0);
    Persistence.saveAll();
    assert.equal(toasts.length, 1);
  } finally { Persistence._saveInFlight = prev; Toast.show = origShow; }
});

// -- reload() failure path ---------------------------------------------------
// reload() is the "discard my edits and refetch" action. When the server load
// fails it must NOT fall back to cache/demo (that would silently replace the
// user's still-unsaved board with an older snapshot) and must not start the
// reconnect watcher; it just tells the user and leaves local edits intact.
async function withFailingTasksFetch(run) {
  const origFetch = globalThis.fetch;
  const origToast = Toast.show;
  const origLoadCache = Persistence._loadCache;
  const origLoadDemo = Persistence._loadDemo;
  const origReconnectStart = Persistence._reconnect.start;
  const priorLoaded = Persistence._currentLoadedPlant;
  const priorAttempted = Persistence._lastAttemptedPlant;
  const calls = { urls: [], toasts: [], loadCache: 0, loadDemo: 0, reconnect: 0 };
  globalThis.fetch = (url) => { calls.urls.push(String(url)); return Promise.resolve({ ok: false, status: 500, clone() { return this; }, json: () => Promise.resolve({}), text: () => Promise.resolve('') }); };
  Toast.show = (msg, type) => { calls.toasts.push({ msg, type }); };
  Persistence._loadCache = () => { calls.loadCache++; return origLoadCache.call(Persistence); };
  Persistence._loadDemo = () => { calls.loadDemo++; };
  Persistence._reconnect.start = () => { calls.reconnect++; };
  try { await run(calls); } finally {
    globalThis.fetch = origFetch; Toast.show = origToast;
    Persistence._loadCache = origLoadCache; Persistence._loadDemo = origLoadDemo;
    Persistence._reconnect.start = origReconnectStart;
    Persistence._currentLoadedPlant = priorLoaded; Persistence._lastAttemptedPlant = priorAttempted;
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  }
}

test('Persistence.reload: a failed server load keeps local edits, toasts the error, and never falls back to cache/demo or starts the reconnect watcher', async () => {
  await withFailingTasksFetch(async (calls) => {
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
    Store.setTasks([{ id: 'reload-edit', PLANT: 'RL', MACHINE: 'L1', RUN_TIME: 1, row_version: 4,
      start_date: new Date('2026-09-10T08:00:00'), end_date: new Date('2026-09-10T09:00:00') }], 'unit-test');
    Persistence._dirtyIds.add('reload-edit');
    Persistence._currentLoadedPlant = 'RL';
    const before = Store.tasks['reload-edit'];

    await Persistence.reload();

    assert.ok(calls.urls.some(u => u.includes('/tasks?plant=RL')), `reload must refetch the loaded plant, saw ${calls.urls}`);
    assert.ok(calls.toasts.some(t => t.type === 'error' && /Reload failed/.test(t.msg)), 'user is told the reload failed');
    assert.equal(calls.loadCache, 0, 'a discard-reload must not substitute the offline cache');
    assert.equal(calls.loadDemo, 0, 'a discard-reload must not substitute demo data');
    assert.equal(calls.reconnect, 0, 'no reconnect watcher for a manual reload');
    assert.equal(Store.tasks['reload-edit'], before, 'the local board is untouched');
    assert.ok(Persistence._dirtyIds.has('reload-edit'), 'unsaved edits remain unsaved');
  });
});

test('Persistence.reload: targets the last ATTEMPTED plant when no plant has loaded yet', async () => {
  await withFailingTasksFetch(async (calls) => {
    Persistence._currentLoadedPlant = null;
    Persistence._lastAttemptedPlant = 'ATTEMPTED-RL';
    await Persistence.reload();
    assert.ok(calls.urls.some(u => u.includes('/tasks?plant=ATTEMPTED-RL')), `saw ${calls.urls}`);
  });
});

test('Persistence.load (non-reload) with a failed server load falls back to the cache, toasts, and starts the reconnect watcher', async () => {
  await withFailingTasksFetch(async (calls) => {
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
    Store.setTasks([{ id: 'cached-fallback', PLANT: 'RL', MACHINE: 'L1', RUN_TIME: 1, row_version: 2,
      start_date: new Date('2026-09-10T08:00:00'), end_date: new Date('2026-09-10T09:00:00') }], 'unit-test');
    Persistence._saveCache();
    Store.setTasks([], 'unit-test');
    Persistence._currentLoadedPlant = null;

    await Persistence.load({ force: true, plant: 'RL' });

    assert.equal(calls.loadCache, 1, 'cache restore attempted');
    assert.ok(Store.tasks['cached-fallback'], 'cached board is shown');
    assert.equal(calls.loadDemo, 0, 'demo is only the last resort when no cache exists');
    assert.equal(calls.reconnect, 1, 'reconnect watcher started');
    assert.ok(calls.toasts.some(t => t.type === 'warn'), 'user is warned the backend is unreachable');
    globalThis.localStorage.removeItem(Config.LS_KEY);
  });
});

// ---- Task 6: manual firm is server state (the dirty-tracking half lives in tests/modules/application-shell.test.mjs) ----
const firmTask = (id, extra = {}) => ({ id, MACHINE: 'L1', RUN_TIME: 1, row_version: 3,
  start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T09:00:00'), ...extra });

test('refresh copy-back updates both t.firmed and firmedIds from the server row', async () => {
  Store.setTasks([firmTask('rf-a', { firmed: true }), firmTask('rf-b')], 'unit-test');
  assert.ok(Store.firmedIds.has('rf-a'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ missing: [], data: [
    { id: 'rf-a', MACHINE: 'L1', row_version: 9, firmed: false, start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T09:00:00', original_start_date: '2026-09-09T08:00:00' },
    { id: 'rf-b', MACHINE: 'L1', row_version: 9, firmed: true, start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T09:00:00', original_start_date: '2026-09-09T08:00:00' },
  ] }) });
  try {
    Persistence._refreshTasks(['rf-a', 'rf-b']);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(Store.tasks['rf-a'].firmed, false);
    assert.equal(Store.tasks['rf-b'].firmed, true);
    assert.deepEqual([...Store.firmedIds].sort(), ['rf-b']);
  } finally { globalThis.fetch = originalFetch; Persistence._dirtyIds.clear(); Persistence._conflictedIds.clear(); }
});

test('a cache holding firmedIds / fixedIds / tasks[].firmed restores no firms, but cached date edits still restore', () => {
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  const cached = firmTask('old-firm', { firmed: true });
  Store.setTasks([cached], 'unit-test');
  Persistence._dirtyIds.add('old-firm');
  Persistence._saveCache();
  const parsed = JSON.parse(globalThis.localStorage.getItem(Config.LS_KEY));
  parsed.firmedIds = ['old-firm', 'ghost'];
  parsed.fixedIds = ['old-firm'];
  parsed.tasks[0].firmed = true;
  globalThis.localStorage.setItem(Config.LS_KEY, JSON.stringify(parsed));
  Store.setTasks([], 'unit-test');
  Store.firmedIds.add('leftover');
  assert.equal(Persistence._loadCache(), true);
  assert.equal(Store.firmedIds.size, 0, 'no firm is revived from the browser cache');
  assert.equal(Store.tasks['old-firm'].firmed, false);
  assert.ok(Persistence._dirtyIds.has('old-firm'), 'cached edits still restore');
  assert.equal(Store.tasks['old-firm'].start_date.getTime(), new Date('2026-09-09T08:00:00').getTime());

  // The backend-load path restores non-task state only: same rule.
  Persistence._restoreNonTaskState({ firmedIds: ['old-firm'], fixedIds: ['old-firm'] });
  assert.equal(Store.firmedIds.size, 0);
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  globalThis.localStorage.removeItem(Config.LS_KEY);
});

test('_saveCache never writes firmedIds or per-task firmed', () => {
  Store.setTasks([firmTask('wr-a', { firmed: true })], 'unit-test');
  Persistence._saveCache();
  const parsed = JSON.parse(globalThis.localStorage.getItem(Config.LS_KEY));
  assert.ok(!('firmedIds' in parsed));
  assert.ok(parsed.tasks.every(t => !('firmed' in t)));
  assert.equal(Store.tasks['wr-a'].firmed, true, 'the live task keeps its mirror');
  globalThis.localStorage.removeItem(Config.LS_KEY);
});
