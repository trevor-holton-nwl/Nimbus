// Time Machine memory / boot work (code review 2026-11, C4 + C22/C23). Counts, not timings: the browser is not
// available to these tests, so each claim is pinned as "N bodies read", "N row sets built", "N rows rendered".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { loadLegacyApp, ROOT } from '../helpers/load-legacy-app.mjs';

const { nimbus, context } = await loadLegacyApp();
context.document.readyState = 'loading';
context.document.addEventListener = () => {};
context.addEventListener = () => {};
runInContext(readFileSync(`${ROOT}/frontend/nimbus-intelligence.js`, 'utf8'), context);
const { Store, TimeMachine, Diff, Toast, Alerts, Engine } = nimbus;
const db = TimeMachine._IntelDB;
const settle = () => new Promise(resolve => setImmediate(resolve));
const H = 3600000;
const T0 = new Date('2026-09-30T08:00:00').getTime();

context.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };

// Runs `body` with the persistence edges stubbed and everything restored after.
async function harness(body) {
  const prior = { putSnapshot: db.putSnapshot, getNewest: db.getNewest, prune: db.pruneSnapshots, get: db.get, snaps: TimeMachine._snapshots,
    ric: context.window.requestIdleCallback, plant: Store.selectedPlant, tasks: Store.tasksArr, lastFp: TimeMachine.lastFp, sessionFp: TimeMachine.sessionFp,
    stats: { ...TimeMachine.stats }, cache: TimeMachine.bodyCache };
  const log = { put: [], prune: [], get: [], idle: [] };
  db.putSnapshot = (body, meta) => { log.put.push({ body, meta }); return Promise.resolve(log.put.length); };
  db.pruneSnapshots = (...args) => { log.prune.push(args); };
  context.window.requestIdleCallback = fn => { log.idle.push(fn); };
  TimeMachine._snapshots = [];
  TimeMachine.lastFp = new Map();
  TimeMachine.sessionFp = new Map();
  TimeMachine.bodyCache = new Map();
  Object.assign(TimeMachine.stats, { rowsBuilt: 0, deduped: 0, bodyReads: 0 });
  try { await body(log); } finally {
    Object.assign(db, { putSnapshot: prior.putSnapshot, getNewest: prior.getNewest, pruneSnapshots: prior.prune, get: prior.get });
    context.window.requestIdleCallback = prior.ric;
    TimeMachine._snapshots = prior.snaps; TimeMachine.lastFp = prior.lastFp; TimeMachine.sessionFp = prior.sessionFp; TimeMachine.bodyCache = prior.cache;
    Object.assign(TimeMachine.stats, prior.stats);
    Store.setTasks(prior.tasks, 'test'); Store.setSelectedPlant(prior.plant, 'test');
  }
}
const seed = (plant, n = 3) => {
  Store.setTasks(Array.from({ length: n }, (_, i) => ({ id: `${plant}-${i}`, PLANT: plant, MACHINE: 'M1', PRODUCTION_ORDER: `PO-${i}`,
    start_date: new Date(T0 + i * 3 * H), end_date: new Date(T0 + i * 3 * H + 2 * H) })), 'test');
  Store.setSelectedPlant(plant, 'test');
};

test('an auto snapshot of an unchanged schedule is skipped; one row set is built per distinct state (C4a)', async () => {
  await harness(async log => {
    seed('TM-D');
    const runIdle = () => { while (log.idle.length) log.idle.shift()(); };
    TimeMachine.snapshot('first', { auto: true });
    assert.equal(TimeMachine.stats.rowsBuilt, 0, 'nothing is built on the calling stack');
    runIdle();
    assert.equal(TimeMachine.stats.rowsBuilt, 1);
    assert.equal(log.put.length, 1);
    TimeMachine.snapshot('same', { auto: true }); runIdle();
    assert.equal(TimeMachine.stats.rowsBuilt, 1, 'identical state: no rows built');
    assert.equal(TimeMachine.stats.deduped, 1);
    assert.equal(log.put.length, 1, 'and nothing written');
    // A different finish is a different state.
    Store.updateTask('TM-D-1', { end_date: new Date(T0 + 12 * H) }, 'test');
    TimeMachine.snapshot('moved', { auto: true }); runIdle();
    assert.equal(TimeMachine.stats.rowsBuilt, 2);
    assert.equal(log.put.length, 2);
    // A manual checkpoint is always taken, even for an unchanged state.
    TimeMachine.snapshot('manual');
    assert.equal(TimeMachine.stats.rowsBuilt, 3);
    assert.equal(log.put.length, 3);
    // The fingerprint is per plant: another plant's identical-looking state is not "unchanged".
    seed('TM-D2');
    TimeMachine.snapshot('other plant', { auto: true }); runIdle();
    assert.equal(TimeMachine.stats.rowsBuilt, 4);
  });
});

test('a burst of auto-snapshot requests shares one idle build, which sees the latest state (C4d)', async () => {
  await harness(async log => {
    seed('TM-B');
    for (let i = 0; i < 5; i++) TimeMachine.snapshot(`burst ${i}`, { auto: true });
    assert.equal(log.idle.length, 1, 'one idle callback queued for the burst');
    assert.equal(TimeMachine.stats.rowsBuilt, 0);
    log.idle.shift()();
    assert.equal(TimeMachine.stats.rowsBuilt, 1);
    assert.equal(log.put[0].meta.label, 'burst 4', 'the latest label');
    // The plant changed before the idle build ran: nothing is snapshotted under the wrong plant.
    seed('TM-B');
    TimeMachine.lastFp = new Map();
    TimeMachine.snapshot('late', { auto: true });
    Store.setSelectedPlant('TM-B-OTHER', 'test');
    log.idle.shift()();
    assert.equal(TimeMachine.stats.rowsBuilt, 1, 'dropped');
  });
});

test('the per-plant cap in memory leaves other plants alone (C4b)', async () => {
  await harness(async log => {
    seed('TM-C', 2);
    const mk = (plant, n) => Array.from({ length: n }, (_, i) => ({ id: `${plant}${i}`, ts: i + (plant === 'TM-C' ? 1000 : 1), plant, label: 'x' }));
    TimeMachine._snapshots = mk('OTHER-P', 200).concat(mk('TM-C', 200)).sort((a, b) => a.ts - b.ts);
    TimeMachine.snapshot('overflow');
    await settle();
    const by = plant => TimeMachine._snapshots.filter(s => s.plant === plant);
    assert.equal(by('TM-C').length, 200, 'the busy plant stays at the cap');
    assert.equal(by('TM-C').at(-1).label, 'overflow');
    assert.equal(by('OTHER-P').length, 200, "the other plant's history is untouched");
    assert.deepEqual(log.prune, [[200, 'TM-C']], 'IndexedDB is pruned for that plant only');
  });
});

test('IntelDB.pruneSnapshots(keepN, plant) removes only that plant\'s oldest rows, bodies and metadata (C4b)', async () => {
  const priorDb = db._db, priorRic = context.window.requestIdleCallback;
  const rows = [], meta = [];
  for (let i = 1; i <= 4; i++) for (const plant of ['A', 'B']) { const id = rows.length + 1; rows.push({ id, ts: i, plant }); meta.push({ id, ts: i, plant }); }
  const inRange = (r, range) => !range || (r.plant === range.lower[0] && r.ts >= range.lower[1] && r.ts <= range.upper[1]);
  const store = list => ({
    count: () => { const req = { result: list.length }; queueMicrotask(() => req.onsuccess()); return req; },
    delete: key => { const i = list.findIndex(r => r.id === key); if (i >= 0) list.splice(i, 1); },
    index: () => ({
      count: range => { const req = { result: list.filter(r => inRange(r, range)).length }; queueMicrotask(() => req.onsuccess()); return req; },
      openKeyCursor: range => {
        const sorted = list.filter(r => inRange(r, range)).sort((a, b) => a.ts - b.ts); let i = 0; const req = {};
        const emit = () => queueMicrotask(() => req.onsuccess({ target: { result: i < sorted.length ? { primaryKey: sorted[i].id, continue() { i++; emit(); } } : null } }));
        emit(); return req;
      },
    }),
  });
  db._db = { transaction: () => ({ objectStore: name => store(name === 'snapshots' ? rows : meta) }) };
  context.window.requestIdleCallback = fn => fn();
  try {
    db.pruneSnapshots(2, 'A');
    await settle();
    const left = list => list.map(r => `${r.plant}${r.ts}`).sort();
    assert.deepEqual(left(meta), ['A3', 'A4', 'B1', 'B2', 'B3', 'B4']);
    assert.deepEqual(left(rows), left(meta), 'bodies go with their metadata');
  } finally { db._db = priorDb; context.window.requestIdleCallback = priorRic; }
});

test('boot reads metadata only: no body is deserialized until a restore asks for one (C4c)', async () => {
  await harness(async () => {
    seed('TM-R', 2);
    const bodies = { 7: { id: 7, ts: 70, plant: 'TM-R', schemaVersion: 2, tasks: [
      { id: 'TM-R-0', start_date: T0, end_date: T0 + 5 * H, MACHINE: 'M1', PRODUCTION_VERSION: '', PRODUCTION_ORDER: 'PO-0', FIRMED: false, scheduleSegments: null } ] } };
    const asked = [];
    db.getNewest = store => { asked.push(store); return Promise.resolve([{ id: 7, ts: 70, plant: 'TM-R', label: 'saved', schemaVersion: 2, count: 1, fp: 'f' }]); };
    db.get = (store, key) => { asked.push(`get:${store}:${key}`); return Promise.resolve(bodies[key] || null); };
    const subscribe = Store.subscribe; Store.subscribe = () => () => {};
    try { TimeMachine.init(); } finally { Store.subscribe = subscribe; }
    await settle();
    assert.deepEqual(asked, ['snapshot_meta'], 'only the metadata store was read');
    assert.equal(TimeMachine.stats.bodyReads, 0, 'bodies deserialized at init == 0');
    assert.equal(TimeMachine._snapshots.length, 1);
    assert.ok(!('tasks' in TimeMachine._snapshots[0]), 'the in-memory entry carries no rows');
    assert.equal(TimeMachine.lastFp.get('TM-R'), 'f', 'the dedupe fingerprint is seeded from the metadata');

    // A restore reads exactly one body, and applies it.
    const prior = { show: Toast.show, recompute: Alerts.scheduleRecompute, firming: Engine.firmingStatus, reconcile: Engine.reconcileRestored, entries: nimbus.UndoStack._entries.slice() };
    Toast.show = () => {}; Alerts.scheduleRecompute = () => {}; Engine.firmingStatus = () => ({ firmed: false }); Engine.reconcileRestored = () => {};
    try {
      await TimeMachine.restore(70);
      assert.equal(TimeMachine.stats.bodyReads, 1);
      assert.equal(Store.tasks['TM-R-0'].end_date.getTime(), T0 + 5 * H, 'the stored finish came back');
      await TimeMachine.restore(70);
      assert.equal(TimeMachine.stats.bodyReads, 1, 'a second restore is served from the small body cache');
    } finally { Toast.show = prior.show; Alerts.scheduleRecompute = prior.recompute; Engine.firmingStatus = prior.firming; Engine.reconcileRestored = prior.reconcile; nimbus.UndoStack._entries = prior.entries; }
  });
});

test('a legacy record that still carries inline tasks restores and diffs as before, and migrates to the same fingerprint (C4c)', async () => {
  await harness(async log => {
    seed('TM-L', 2);
    // Inline rows, no count/fp/schemaVersion: what a version 1 build kept in memory.
    const legacy = { ts: 5, plant: 'TM-L', label: 'old', tasks: [
      { id: 'TM-L-0', start_date: T0, end_date: T0 + 6 * H, MACHINE: 'M1', FIRMED: false, scheduleSegments: null } ] };
    TimeMachine._snapshots = [legacy];
    const prior = { show: Toast.show, recompute: Alerts.scheduleRecompute, firming: Engine.firmingStatus, reconcile: Engine.reconcileRestored, entries: nimbus.UndoStack._entries.slice() };
    Toast.show = () => {}; Alerts.scheduleRecompute = () => {}; Engine.firmingStatus = () => ({ firmed: false }); Engine.reconcileRestored = () => {};
    try {
      TimeMachine.restore(5);   // synchronous: the rows are in memory
      assert.equal(Store.tasks['TM-L-0'].end_date.getTime(), T0 + 6 * H);
      assert.equal(TimeMachine.stats.bodyReads, 0);
    } finally { Toast.show = prior.show; Alerts.scheduleRecompute = prior.recompute; Engine.firmingStatus = prior.firming; Engine.reconcileRestored = prior.reconcile; nimbus.UndoStack._entries = prior.entries; }

    // The upgrade handler describes each stored record once; its fingerprint equals a live capture of the same state.
    const snap = TimeMachine.snapshot('now');
    const written = [];
    const tx = { objectStore: name => name === 'snapshot_meta' ? { put: m => written.push(m) }
      : { openCursor: () => { const req = {}; queueMicrotask(() => { req.onsuccess({ target: { result: { value: { id: 3, ...snap, tasks: snap.tasks }, continue() { queueMicrotask(() => req.onsuccess({ target: { result: null } })); } } } }); }); return req; } } };
    db.migrateLegacyMeta(tx);
    await settle();
    assert.equal(written.length, 1);
    assert.equal(written[0].fp, snap.fp, 'same fingerprint as the live capture, so dedupe works across the upgrade');
    assert.equal(written[0].count, snap.tasks.length);
    assert.ok(!('tasks' in written[0]), 'metadata only');
  });
});

// --- Diff (C22, C23) ----------------------------------------------------------------------------------------------

test('Diff caps the rendered rows at 200 and "show more" reveals the rest (C23)', () => {
  const moved = Array.from({ length: 450 }, (_, i) => ({ id: `m${i}`, PRODUCTION_ORDER: `PO${i}`, text: '', MACHINE: 'L', lineTo: 'L', lineFrom: 'L', lineChanged: false,
    delta: H, startDelta: H, endDelta: H, kinds: ['start'], oldStart: T0, newStart: T0 + H }));
  const added = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, PRODUCTION_ORDER: `A${i}`, text: '', MACHINE: 'L', start_date: T0 }));
  const d = { moved, added, removed: [], lineImpact: {} };
  const count = (html, cls) => (html.match(new RegExp(`class="ni-diff-row ${cls}"`, 'g')) || []).length;
  const capped = Diff._renderResults(d);
  assert.equal(count(capped, 'ni-diff-row-moved'), 200, 'moved rows fill the cap first');
  assert.equal(count(capped, 'ni-diff-row-added'), 0);
  assert.match(capped, /data-diff-more/);
  assert.match(capped, /ui\.diff_show_more|more/, 'text goes through t()');
  const all = Diff._renderResults(d, Infinity);
  assert.equal(count(all, 'ni-diff-row-moved'), 450);
  assert.equal(count(all, 'ni-diff-row-added'), 30);
  assert.doesNotMatch(all, /data-diff-more/);
  // Below the cap nothing is hidden.
  assert.doesNotMatch(Diff._renderResults({ moved: moved.slice(0, 5), added: [], removed: [], lineImpact: {} }), /data-diff-more/);
});

test('Diff.showUI: a snapshot of this plant needs no scoping, and the show-more button repaints with every row (C22, C23)', async () => {
  await harness(async () => {
    seed('TM-U', 1);
    Store.setTasks(Array.from({ length: 300 }, (_, i) => ({ id: `u${i}`, PLANT: 'TM-U', MACHINE: 'M1', PRODUCTION_ORDER: `PO${i}`,
      start_date: new Date(T0 + 4 * H), end_date: new Date(T0 + 6 * H) })), 'test');
    Store.setSelectedPlant('TM-U', 'test');
    // 300 orders moved an hour earlier since the snapshot.
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: `u${i}`, PLANT: 'TM-U', MACHINE: 'M1', PRODUCTION_ORDER: `PO${i}`, start_date: T0 + 3 * H, end_date: T0 + 5 * H, FIRMED: false, scheduleSegments: null }));
    TimeMachine._snapshots = [1, 2].map(ts => ({ ts, plant: 'TM-U', schemaVersion: 2, label: 's', count: 300, tasks: rows }));
    const out = { html: '', click: null };
    const stub = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, appendChild() {}, querySelector: () => stub(), querySelectorAll: () => [], showModal() {}, close() {}, remove() {} });
    const priorCreate = context.document.createElement, priorGet = context.document.getElementById, priorBody = context.document.body;
    const dlg = stub();
    context.document.createElement = () => dlg;
    context.document.body = { appendChild() {} };
    Object.defineProperty(dlg, 'innerHTML', { set() {}, get: () => '', configurable: true });
    context.document.getElementById = id => id === 'ni-diff-out' ? { set innerHTML(v) { out.html = v; }, get innerHTML() { return out.html; },
      querySelector: sel => sel === '[data-diff-more]' && out.html.includes('data-diff-more') ? { addEventListener: (type, fn) => { out.click = fn; } } : null } : null;
    const priorSubscribe = Store.subscribe; Store.subscribe = () => () => {};
    try {
      Diff.showUI();
      await settle();
      const rowsIn = html => (html.match(/class="ni-diff-row /g) || []).length;
      assert.equal(rowsIn(out.html), 200, 'capped on first paint');
      assert.ok(out.click, 'the show-more button is wired');
      out.click();
      assert.equal(rowsIn(out.html), 300, 'every row after "show more"');
      assert.doesNotMatch(out.html, /data-diff-more/);
    } finally { Store.subscribe = priorSubscribe; context.document.createElement = priorCreate; context.document.getElementById = priorGet; context.document.body = priorBody; }
  });
});
