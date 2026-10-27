// Tool Inventory Wave 3: the masterData.tool_inventory key's load / refresh / freshness contract.
//   undefined = not loaded or FAILED (never "empty"); rows sorted by tool_id; keep-on-failure; plant-switch guards;
//   /tasks/horizons probe; admin-ui refreshStoreMasterData carry-forward; compact worker projection.
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Toast, Util, Modal } from '../../../frontend/platform/foundation.mjs';
import { refreshStoreMasterData } from '../../../frontend/master-data/admin-ui.mjs';
import { buildPlantSnapshot, projectMasterDataForWorker } from '../../../frontend/insights/services.mjs';

globalThis.NimbusComputeCore = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ classList: { add() {}, remove() {} }, style: {} }), body: { insertBefore() {} } };
}
{
  const mem = new Map();
  globalThis.localStorage = globalThis.localStorage || { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); }, clear: () => mem.clear() };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const row = (plant, tool_id, total_qty = 1, out_of_service_qty = 0) =>
  ({ plant, tool_id, total_qty, out_of_service_qty, note: null });

function env(plant = 'TP') {
  const prior = {
    fetchTraced: Util.fetchTraced, toast: Toast.show, plant: Store.selectedPlant, md: Store.masterData,
    invPlant: Persistence._toolInventoryPlant, base: { ...Persistence._toolInventoryBaseline },
    warned: new Set(Persistence._toolInventoryWarned), guard: Persistence._calendarRefreshBlocked, anyOpen: Modal.anyOpen,
    load: Persistence._loadRequest, doc: globalThis.document,
  };
  const s = { toasts: [], urls: [], inv: null, invStatus: 200, invThrow: false, plants: [{ plant, subnetwork: 'SN', setup_policy_config: {} }], horizons: {} };
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setMasterData({ plants: s.plants, lines: [], workcenters: [], tool_inventory: undefined }, 'unit-test');
  Persistence._toolInventoryPlant = null;
  Persistence._toolInventoryBaseline = {};
  Persistence._toolInventoryWarned = new Set();
  Persistence._calendarRefreshBlocked = null;
  Util.fetchTraced = async (url) => {
    const u = String(url);
    s.urls.push(u);
    if (u.includes('/tasks?')) return { ok: true, json: async () => ({ data: s.tasks ?? [], links: [], meta: {} }) };
    if (u.includes('/master-data/tool_inventory')) {
      if (s.invThrow) throw new Error('timeout');
      if (s.invStatus !== 200) return { ok: false, status: s.invStatus, json: async () => ({}) };
      return { ok: true, json: async () => ({ columns: [], rows: s.inv ?? [] }) };
    }
    if (u.includes('/master-data/plants')) return { ok: true, json: async () => ({ rows: s.plants }) };
    if (u.includes('/tasks/horizons')) return { ok: true, json: async () => ({
      visibility_horizon_end: null, frozen_horizon_end: null, alert_horizon_minutes: null, ...s.horizons }) };
    return { ok: true, json: async () => ({ rows: [] }) };
  };
  Toast.show = (...a) => s.toasts.push(a);
  const probe = async () => { delete Persistence._horizonsFetchedAt[plant]; await Persistence.refreshHorizons(plant); await tick(); await tick(); };
  const restore = () => {
    Util.fetchTraced = prior.fetchTraced; Toast.show = prior.toast; Modal.anyOpen = prior.anyOpen;
    Persistence._calendarRefreshBlocked = prior.guard; Persistence._toolInventoryPlant = prior.invPlant;
    Persistence._toolInventoryBaseline = prior.base; Persistence._toolInventoryWarned = prior.warned;
    delete Persistence._horizonsFetchedAt[plant];
    Store.setMasterData(prior.md, 'unit-test'); Store.setSelectedPlant(prior.plant, 'unit-test');
  };
  return { s, probe, restore, toastsOf: key => s.toasts.filter(t => t[0] === key) };
}

// --- fetch: undefined vs empty, sorted -------------------------------------------------------------------------
test('_fetchToolInventory: not-ok (403/500), a throw/timeout and a malformed body are undefined, never []', async () => {
  const { s, restore } = env();
  try {
    s.invStatus = 403;
    assert.equal(await Persistence._fetchToolInventory('TP'), undefined);
    s.invStatus = 500;
    assert.equal(await Persistence._fetchToolInventory('TP'), undefined);
    s.invStatus = 200; s.invThrow = true;
    assert.equal(await Persistence._fetchToolInventory('TP'), undefined);
    s.invThrow = false;
    Util.fetchTraced = async () => ({ ok: true, json: async () => ({ rows: 'nope' }) });
    assert.equal(await Persistence._fetchToolInventory('TP'), undefined);
    Util.fetchTraced = async () => ({ ok: true, json: async () => ({ rows: [] }) });
    assert.deepEqual(await Persistence._fetchToolInventory('TP'), [], 'a successful empty plant is [] (loaded, 1 copy each)');
  } finally { restore(); }
});

test('_fetchToolInventory is plant-scoped and sorts rows by tool_id ascending', async () => {
  const { s, restore } = env();
  try {
    s.inv = [row('TP', 'T9'), row('TP', 'A1'), row('TP', 'T10')];
    const rows = await Persistence._fetchToolInventory('TP');
    assert.deepEqual(rows.map(r => r.tool_id), ['A1', 'T10', 'T9'], 'plain code-unit order, deterministic');
    assert.ok(s.urls.some(u => u.endsWith('/master-data/tool_inventory?plant=TP')));
  } finally { restore(); }
});

// --- load() sites -----------------------------------------------------------------------------------------------
function loadEnv() {
  const e = env('PLANT-L');
  const priorFetch = globalThis.fetch;
  const priorLoads = Persistence._loadsInFlight;
  e.s.fail = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/tasks?')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const restore0 = e.restore;
  e.restore = () => { globalThis.fetch = priorFetch; Persistence._loadsInFlight = priorLoads; restore0(); };
  return e;
}

test('load() main path: failed fetch leaves tool_inventory undefined, warns + toasts once per plant per session; ok rows are sorted', async () => {
  const { s, restore, toastsOf } = loadEnv();
  try {
    s.tasks = [{ id: 'o1', PRODUCTION_ORDER: 'o1', MACHINE: 'L1', PLANT: 'PLANT-L', BASIC_START_DATE: '2026-10-27T08:00:00', BASIC_FINISH_DATE: '2026-10-27T10:00:00', RUN_TIME: 2 }];
    s.invStatus = 403;
    await Persistence.load({ plant: 'PLANT-L' }); await tick(); await tick();
    assert.equal(Store.masterData.tool_inventory, undefined, '403 must not read as loaded-empty');
    assert.equal(toastsOf('toast.tool_inventory_unavailable').length, 1);
    await Persistence.load({ plant: 'PLANT-L', force: true }); await tick(); await tick();
    assert.equal(toastsOf('toast.tool_inventory_unavailable').length, 1, 'de-duplicated per plant + session');
    s.invStatus = 200; s.inv = [row('PLANT-L', 'T2'), row('PLANT-L', 'T1')];
    await Persistence.load({ plant: 'PLANT-L', force: true }); await tick(); await tick();
    assert.deepEqual(Store.masterData.tool_inventory.map(r => r.tool_id), ['T1', 'T2']);
  } finally { restore(); }
});

test('load(): a same-plant reload keeps the held rows when the refetch fails; a plant switch never reuses the previous plant\'s rows', async () => {
  const { s, restore } = loadEnv();
  try {
    s.inv = [row('PLANT-L', 'T1', 3)];
    await Persistence.load({ plant: 'PLANT-L' }); await tick(); await tick();
    assert.equal(Store.masterData.tool_inventory.length, 1);
    s.invStatus = 500;
    await Persistence.load({ plant: 'PLANT-L', force: true }); await tick(); await tick();
    assert.equal(Store.masterData.tool_inventory?.[0]?.tool_id, 'T1', 'keep-on-failure for the same plant');
    // switch: the outgoing plant's rows are dropped at once and stay dropped when the new plant's fetch fails
    Store.setSelectedPlant('PLANT-M', 'unit-test');
    await Persistence.load({ plant: 'PLANT-M' }); await tick(); await tick();
    assert.equal(Store.masterData.tool_inventory, undefined);
  } finally { restore(); }
});

test('load(): the previous plant\'s inventory is cleared the instant a different plant starts loading (before its rows arrive)', async () => {
  const { s, restore } = loadEnv();
  try {
    s.inv = [row('PLANT-L', 'T1')];
    await Persistence.load({ plant: 'PLANT-L' }); await tick(); await tick();
    assert.equal(Store.masterData.tool_inventory.length, 1);
    let release;
    const gate = new Promise(r => { release = r; });
    const inner = Util.fetchTraced;
    Util.fetchTraced = async (u, o) => { if (String(u).includes('/master-data/tool_inventory')) await gate; return inner(u, o); };
    Store.setSelectedPlant('PLANT-M', 'unit-test');
    s.inv = [row('PLANT-M', 'M1')];
    const p = Persistence.load({ plant: 'PLANT-M' });
    await tick(); await tick();
    assert.equal(Store.masterData.tool_inventory, undefined, 'transient: no stale counts from the other plant');
    release(); await p; await tick(); await tick();
    assert.deepEqual(Store.masterData.tool_inventory.map(r => r.tool_id), ['M1']);
  } finally { restore(); }
});

test('load() with no plant: tool_inventory is undefined (never []) and nothing is fetched for it', async () => {
  const { s, restore } = loadEnv();
  try {
    await Persistence.load({ plant: null }); await tick();
    assert.equal(Store.masterData.tool_inventory, undefined);
    assert.ok(!s.urls.some(u => u.includes('/master-data/tool_inventory')));
  } finally { restore(); }
});

// --- refreshToolInventory ----------------------------------------------------------------------------------------
test('refreshToolInventory merges rows with source/table, keeps the other keys, and emits master-data-changed once', async () => {
  const { s, restore } = env();
  const events = [];
  const unsub = Store.subscribe(e => { if (e.type === 'master-data-changed') events.push(e); });
  try {
    s.inv = [row('TP', 'B'), row('TP', 'A', 5, 1)];
    assert.equal(await Persistence.refreshToolInventory('TP'), true);
    assert.deepEqual(Store.masterData.tool_inventory.map(r => r.tool_id), ['A', 'B']);
    assert.equal(Store.masterData.plants.length, 1, 'plants carried forward');
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'tool-inventory-refresh');
    assert.equal(events[0].table, 'tool_inventory');
  } finally { unsub(); restore(); }
});

test('refreshToolInventory keeps the held rows on failure (and does not emit)', async () => {
  const { s, restore } = env();
  try {
    s.inv = [row('TP', 'A')];
    await Persistence.refreshToolInventory('TP');
    const held = Store.masterData.tool_inventory;
    const events = [];
    const unsub = Store.subscribe(e => { if (e.type === 'master-data-changed') events.push(e); });
    s.invStatus = 503;
    assert.equal(await Persistence.refreshToolInventory('TP'), false);
    unsub();
    assert.equal(Store.masterData.tool_inventory, held);
    assert.equal(events.length, 0);
  } finally { restore(); }
});

test('refreshToolInventory discards its response when the plant switches (or a newer load starts) during the await', async () => {
  const { s, restore } = env();
  try {
    let release;
    const gate = new Promise(r => { release = r; });
    const inner = Util.fetchTraced;
    Util.fetchTraced = async (u, o) => { await gate; return inner(u, o); };
    s.inv = [row('TP', 'A')];
    const p = Persistence.refreshToolInventory('TP');
    Store.setSelectedPlant('OTHER', 'unit-test');
    release();
    assert.equal(await p, false);
    assert.equal(Store.masterData.tool_inventory, undefined, 'the stale plant\'s rows were not applied');
    Store.setSelectedPlant('TP', 'unit-test');
    const p2 = Persistence.refreshToolInventory('TP');
    Persistence._loadRequest++;                       // a newer load() started
    assert.equal(await p2, false);
    assert.equal(Persistence._toolInventoryPlant, null);
  } finally { restore(); }
});

// --- horizons probe (WIRE-ACCURATE rows: GET /master-data/tool_inventory never returns updated_at) -----------------
const invFetches = s => s.urls.filter(u => u.includes('/master-data/tool_inventory')).length;

test('probe: baseline is the server version read before the rows; the same version settles (no refetch, no emit, no toast)', async () => {
  const { s, probe, restore, toastsOf } = env();
  const events = [];
  const unsub = Store.subscribe(e => { if (e.type === 'master-data-changed') events.push(e); });
  try {
    s.inv = [row('TP', 'A', 2)];
    s.horizons = { tool_inventory_version: '1|2026-10-27T10:00:00+00:00' };
    await Persistence.refreshToolInventory('TP');
    assert.equal(Persistence._toolInventoryBaseline.TP, '1|2026-10-27T10:00:00+00:00', 'verbatim server string, never recomputed');
    const fetchesBefore = invFetches(s); const eventsBefore = events.length;
    await probe(); await probe();
    assert.equal(invFetches(s), fetchesBefore, 'settled: probes with an unchanged version never refetch');
    assert.equal(events.length, eventsBefore, 'and never emit (no alert recompute loop)');
    assert.equal(toastsOf('toast.tool_inventory_refreshed_remote').length, 0);
  } finally { unsub(); restore(); }
});

test('probe: a changed server version refetches once and toasts remote; the next probe is quiet', async () => {
  const { s, probe, restore, toastsOf } = env();
  try {
    s.inv = [row('TP', 'A', 2)];
    s.horizons = { tool_inventory_version: '1|2026-10-27T10:00:00+00:00' };
    await Persistence.refreshToolInventory('TP');
    s.inv = [row('TP', 'A', 2, 1), row('TP', 'B')];
    s.horizons = { tool_inventory_version: '2|2026-10-27T11:00:00.123456+00:00' };
    const before = invFetches(s);
    await probe();
    assert.equal(invFetches(s), before + 1, 'refetched once');
    assert.equal(Store.masterData.tool_inventory.length, 2);
    assert.equal(toastsOf('toast.tool_inventory_refreshed_remote').length, 1);
    await probe();
    assert.equal(invFetches(s), before + 1, 'baseline moved: no repeat');
    assert.equal(toastsOf('toast.tool_inventory_refreshed_remote').length, 1);
  } finally { restore(); }
});

test('probe: a version change whose rows are identical (e.g. an edit reverted) refetches silently, no emit, no toast', async () => {
  const { s, probe, restore, toastsOf } = env();
  const events = [];
  try {
    s.inv = [row('TP', 'A', 2)];
    s.horizons = { tool_inventory_version: '1|2026-10-27T10:00:00+00:00' };
    await Persistence.refreshToolInventory('TP');
    const unsub = Store.subscribe(e => { if (e.type === 'master-data-changed') events.push(e); });
    s.horizons = { tool_inventory_version: '1|2026-10-27T12:00:00+00:00' };
    await probe();
    unsub();
    assert.equal(events.length, 0);
    assert.equal(toastsOf('toast.tool_inventory_refreshed_remote').length, 0);
    assert.equal(Persistence._toolInventoryBaseline.TP, '1|2026-10-27T12:00:00+00:00');
  } finally { restore(); }
});

test('probe: our own save (refreshStoreMasterData) moves the baseline, so the next probe is not announced as remote', async () => {
  const { s, probe, restore, toastsOf } = env();
  const priorDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  try {
    s.inv = [row('TP', 'A')];
    s.horizons = { tool_inventory_version: '1|2026-10-27T10:00:00+00:00' };
    await Persistence.refreshToolInventory('TP');
    // the planner saves: the server now reports a new version and new rows
    s.inv = [row('TP', 'A', 5)];
    s.horizons = { tool_inventory_version: '1|2026-10-27T13:00:00+00:00' };
    await refreshStoreMasterData('master-data-save', 'tool_inventory');
    assert.equal(Store.masterData.tool_inventory[0].total_qty, 5);
    assert.equal(Persistence._toolInventoryBaseline.TP, '1|2026-10-27T13:00:00+00:00');
    const before = invFetches(s);
    await probe();
    assert.equal(invFetches(s), before, 'no refetch');
    assert.equal(toastsOf('toast.tool_inventory_refreshed_remote').length, 0, 'own change is never "updated by another session"');
    assert.ok(!Persistence._toolInventoryRefreshing.has('TP'), 'refreshing flag released');
  } finally {
    if (priorDoc === undefined) delete globalThis.document; else globalThis.document = priorDoc;
    restore();
  }
});

test('probe: a probe racing our own refetch is suppressed (refreshing flag), with no toast', async () => {
  const { s, probe, restore, toastsOf } = env();
  const priorDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  try {
    s.inv = [row('TP', 'A')];
    s.horizons = { tool_inventory_version: 'v1' };
    await Persistence.refreshToolInventory('TP');
    s.inv = [row('TP', 'A', 7)];
    s.horizons = { tool_inventory_version: 'v2' };
    let release;
    const gate = new Promise(r => { release = r; });
    const inner = Util.fetchTraced;
    Util.fetchTraced = async (u, o) => { if (String(u).includes('/master-data/tool_inventory')) await gate; return inner(u, o); };
    const saving = refreshStoreMasterData('master-data-save', 'tool_inventory');
    await tick();
    assert.ok(Persistence._toolInventoryRefreshing.has('TP'));
    const before = invFetches(s);
    await probe();                                              // lands mid-refetch: must do nothing
    assert.equal(invFetches(s), before, 'the probe made no inventory request (the save\'s own is still gated)');
    release(); await saving; await tick();
    assert.equal(toastsOf('toast.tool_inventory_refreshed_remote').length, 0);
    assert.equal(Store.masterData.tool_inventory[0].total_qty, 7);
    assert.equal(Persistence._toolInventoryBaseline.TP, 'v2');
  } finally {
    if (priorDoc === undefined) delete globalThis.document; else globalThis.document = priorDoc;
    restore();
  }
});

test('probe: a failed version read leaves the baseline undefined; the next probe adopts the server value without refetching (no loop)', async () => {
  const { s, probe, restore, toastsOf } = env();
  try {
    s.inv = [row('TP', 'A', 2)];
    s.horizons = {};                                            // no tool_inventory_version: the read yields undefined
    await Persistence.refreshToolInventory('TP');
    assert.equal(Persistence._toolInventoryBaseline.TP, undefined);
    assert.equal(Store.masterData.tool_inventory.length, 1, 'rows still applied');
    s.horizons = { tool_inventory_version: '1|2026-10-27T10:00:00+00:00' };
    const before = invFetches(s);
    await probe(); await probe(); await probe();
    assert.equal(invFetches(s), before, 'adopted silently, never refetched');
    assert.equal(Persistence._toolInventoryBaseline.TP, '1|2026-10-27T10:00:00+00:00');
    assert.equal(toastsOf('toast.tool_inventory_refreshed_remote').length, 0);
    // a failed HTTP read behaves the same
    Util.fetchTraced = async (u) => String(u).includes('/tasks/horizons') ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => ({ rows: [row('TP', 'A', 2)] }) };
    assert.equal(await Persistence._readToolInventoryVersion('TP'), undefined);
  } finally { restore(); }
});

test('probe: a failed load (undefined rows) is retried by the next probe, silently (no "remote" toast)', async () => {
  const { s, probe, restore, toastsOf } = env();
  try {
    s.invStatus = 500;
    await Persistence.load({ plant: 'TP' }).catch(() => {});
    Store.setSelectedPlant('TP', 'unit-test');
    Persistence._toolInventoryPlant = 'TP';
    Persistence._toolInventoryBaseline.TP = undefined;
    s.invStatus = 200; s.inv = [row('TP', 'A', 4)];
    s.horizons = { tool_inventory_version: '1|2026-10-27T10:00:00+00:00' };
    await probe();
    assert.equal(Store.masterData.tool_inventory?.[0]?.total_qty, 4, 'the failure healed');
    assert.equal(toastsOf('toast.tool_inventory_refreshed_remote').length, 0, 'recovering our own failed load is not a remote change');
  } finally { restore(); }
});

test('_warnToolInventoryUnavailable: ErrorLog.warn every time, toast once per plant', () => {
  const { s, restore } = env();
  try {
    Persistence._warnToolInventoryUnavailable('TP');
    Persistence._warnToolInventoryUnavailable('TP');
    assert.equal(s.toasts.filter(t => t[0] === 'toast.tool_inventory_unavailable').length, 1);
  } finally { restore(); }
});

test('probe: skipped while a drag/dialog/What-If is active (throttle released), picked up on the next entry', async () => {
  const { s, probe, restore } = env();
  try {
    s.inv = [row('TP', 'A')];
    s.horizons = { tool_inventory_version: 'v1' };
    await Persistence.refreshToolInventory('TP');
    s.inv = [row('TP', 'A', 9)];
    s.horizons = { tool_inventory_version: 'v2' };
    let dragging = true;
    Persistence._calendarRefreshBlocked = () => dragging;
    await probe();
    assert.equal(Store.masterData.tool_inventory[0].total_qty, 1, 'blocked');
    assert.equal(Persistence._horizonsFetchedAt.TP, 0);
    dragging = false;
    await probe();
    assert.equal(Store.masterData.tool_inventory[0].total_qty, 9);
  } finally { restore(); }
});

test('probe: tooling_rule differing from the Store plant row re-fetches the plants rows and toasts; an older backend (no fields) does nothing', async () => {
  const { s, probe, restore, toastsOf } = env();
  try {
    await probe();                                                   // no tooling_rule: nothing
    assert.ok(!s.urls.some(u => u.includes('/master-data/plants')));
    s.plants = [{ plant: 'TP', subnetwork: 'SN', setup_policy_config: { toolingRule: 'hard' } }];
    s.horizons = { tooling_rule: 'hard' };
    await probe();
    assert.equal(Store.masterData.plants[0].setup_policy_config.toolingRule, 'hard');
    assert.equal(toastsOf('toast.tool_inventory_refreshed_remote').length, 1);
    await probe();
    assert.equal(s.urls.filter(u => u.includes('/master-data/plants')).length, 1, 'now equal: no refetch');
  } finally { restore(); }
});

// --- admin-ui refreshStoreMasterData ---------------------------------------------------------------------------------
test('refreshStoreMasterData carries tool_inventory forward on every rebuild, refetches it for table tool_inventory, keeps it on failure', async () => {
  const { s, restore } = env();
  const priorDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  try {
    const held = [row('TP', 'KEEP', 2)];
    Store.setMasterData({ ...Store.masterData, tool_inventory: held }, 'unit-test');
    s.inv = [row('TP', 'FRESH')];
    await refreshStoreMasterData('master-data-save', 'machine');
    assert.equal(Store.masterData.tool_inventory, held, 'an unrelated save does not wipe (or refetch) the inventory');
    assert.ok(!s.urls.some(u => u.includes('/master-data/tool_inventory')));
    await refreshStoreMasterData('master-data-refresh');
    assert.equal(Store.masterData.tool_inventory, held, 'refresh without a table carries it forward');
    await refreshStoreMasterData('master-data-save', 'tool_inventory');
    assert.deepEqual(Store.masterData.tool_inventory.map(r => r.tool_id), ['FRESH']);
    assert.ok(s.urls.some(u => u.endsWith('/master-data/tool_inventory?plant=TP')), 'plant-scoped refetch');
    const fresh = Store.masterData.tool_inventory;
    s.invStatus = 500;
    await refreshStoreMasterData('master-data-save', 'tool_inventory');
    assert.equal(Store.masterData.tool_inventory, fresh, 'failed refetch keeps the held rows');
    // undefined stays undefined (never promoted to [])
    Store.setMasterData({ ...Store.masterData, tool_inventory: undefined }, 'unit-test');
    await refreshStoreMasterData('master-data-refresh');
    assert.equal(Store.masterData.tool_inventory, undefined);
  } finally {
    if (priorDoc === undefined) delete globalThis.document; else globalThis.document = priorDoc;
    restore();
  }
});

// --- worker payload -----------------------------------------------------------------------------------------------
test('worker payload: tool_inventory stays INSIDE masterData as compact rows; a tool with no row stays absent; undefined stays undefined', () => {
  const priorPlant = Store.selectedPlant;
  const priorMd = Store.masterData;
  try {
    Store.setSelectedPlant('WP', 'unit-test');
    Store.setMasterData({
      plants: [{ plant: 'WP' }], lines: [{ machine: 'WL1', plant: 'WP' }], workcenters: [],
      tool_inventory: [row('WP', 'T1', 3, 1), row('WP', 'T2', 1, 0), row('WP', 'T3', 2, 5)],
    }, 'unit-test');
    const snap = buildPlantSnapshot('WP');
    assert.deepEqual(snap.masterData.tool_inventory, [
      { plant: 'WP', tool_id: 'T1', available: 2, hasRow: true },
      { plant: 'WP', tool_id: 'T2', available: 1, hasRow: true },
      { plant: 'WP', tool_id: 'T3', available: 0, hasRow: true },
    ]);
    assert.ok(!('tool_inventory' in snap), 'no top-level payload key');
    assert.equal(Store.masterData.tool_inventory[0].total_qty, 3, 'the Store rows are untouched');
    Store.setMasterData({ ...Store.masterData, tool_inventory: undefined }, 'unit-test');
    assert.equal(buildPlantSnapshot('WP').masterData.tool_inventory, undefined);
    assert.equal(projectMasterDataForWorker(null), null);
    const md = { plants: [], lines: [], workcenters: [], tool_inventory: undefined };
    assert.equal(projectMasterDataForWorker(md), md);
  } finally {
    Store.setMasterData(priorMd, 'unit-test'); Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});
