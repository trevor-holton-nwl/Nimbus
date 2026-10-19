// Tests for frontend/master-data/admin-ui.mjs (Plant, ProdLines, MasterData).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Plant, ProdLines, MasterData, WorkCenters } from '../../../frontend/master-data/admin-ui.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { EditCalendar } from '../../../frontend/calendar/edit-calendar.mjs';
import { CalendarPeriodsUI } from '../../../frontend/calendar/calendar-periods-ui.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Modal, Toast, Util } from '../../../frontend/platform/foundation.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';

test('Plant/ProdLines expose their documented public API', () => {
  assert.equal(typeof Plant.init, 'function');
  assert.equal(typeof Plant.gotoTab, 'function');
  assert.equal(typeof Plant._renderSettingsPane, 'function', 'App._renderSettingsPane was relocated bodily onto Plant in Task 1 — must land here');
  assert.equal(typeof ProdLines.render, 'function');
  assert.equal(typeof ProdLines.refresh, 'function');
  assert.equal(typeof Plant.refresh, 'function');
});

// Master Data sub-tab Refresh (docs/superpowers plan 2026-10-15-master-data-refresh, Task 2).
// ProdLines.refresh re-pulls the same plant-scoped data the page boots with, without a reload.
test('ProdLines.refresh re-fetches plants, the plant-scoped machines and the plant calendar, then resolves true', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetch = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const urls = [];
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  Util.fetchTraced = (url) => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) });
  };
  try {
    Store.setSelectedPlant('1006', 'test');
    const result = await ProdLines.refresh();
    assert.equal(result, true);
    assert.ok(urls.some(u => /\/master-data\/plants(\?|$)/.test(u)), `plants fetched: ${urls}`);
    assert.ok(urls.some(u => u.endsWith('/master-data/machine?plant=1006')), `plant-scoped machines fetched: ${urls}`);
    assert.ok(urls.some(u => u.endsWith('/plant-calendar?plant=1006')), `plant calendar fetched: ${urls}`);
    assert.ok(!urls.some(u => /\/master-data\/machine(\?(?!plant=)|$)/.test(u)), 'never an unscoped machine fetch');
  } finally {
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

test('ProdLines.refresh resolves false, keeps the Store rows and still emits master-data-changed when both fetches fail', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetch = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const sentinel = { plants: [{ plant: 'KEEP' }], lines: [{ machine: 'KEEP-1' }], workcenters: [] };
  const events = [];
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  Util.fetchTraced = (url) => {
    // Master-data fetches fail; the calendar fetch is allowed to succeed.
    if (String(url).includes('/master-data/')) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) });
  };
  try {
    Store.setSelectedPlant('1006', 'test');
    Store.setMasterData(sentinel, 'test');
    const unsubscribe = Store.subscribe(evt => { if (evt.type === 'master-data-changed') events.push(evt); }, 'test');
    const result = await ProdLines.refresh();
    unsubscribe();
    assert.equal(result, false, 'no fresh rows landed');
    assert.equal(Store.masterData, sentinel, 'a failed refresh never blanks the Store rows');
    assert.equal(events.length, 1, 'the no-op branch still emits exactly one master-data-changed');
    assert.equal(events[0].source, 'master-data-refresh');
  } finally {
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

test('ProdLines.refresh resolves false and does not write the Store when the plant switches while the fetches are in flight', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetch = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const priorSetMasterData = Store.setMasterData;
  const sentinel = { plants: [{ plant: 'KEEP' }], lines: [], workcenters: [] };
  let writes = 0;
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  Util.fetchTraced = (url) => {
    // The user switches plant after the refresh began but before its responses are applied.
    if (String(url).includes('/master-data/plants')) Store.setSelectedPlant('5512', 'test-switch');
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [{ plant: 'FRESH' }] }) });
  };
  try {
    Store.setSelectedPlant('1006', 'test');
    Store.setMasterData(sentinel, 'test');
    Store.setMasterData = function (...args) { writes += 1; return priorSetMasterData.apply(this, args); };
    assert.equal(await ProdLines.refresh(), false);
    assert.equal(writes, 0, 'the stale response must not overwrite the other plant\'s master data');
    assert.equal(Store.masterData, sentinel);
  } finally {
    Store.setMasterData = priorSetMasterData;
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

test('ProdLines.refresh and Plant.refresh resolve false and fetch nothing when no plant is selected', async () => {
  const priorPlant = Store.selectedPlant;
  const priorFetch = Util.fetchTraced;
  const urls = [];
  Util.fetchTraced = (url) => { urls.push(String(url)); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); };
  try {
    Store.setSelectedPlant(null, 'test');
    assert.equal(await ProdLines.refresh(), false);
    assert.equal(await Plant.refresh(), false);
    assert.deepEqual(urls, []);
  } finally {
    Util.fetchTraced = priorFetch;
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

test('Plant.refresh also re-pulls priority rank maps, and the setup snapshot only on the settings inner tab', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetch = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const priorTab = Plant._currentPlantTab;
  const originalGoto = Plant.gotoTab;
  const urls = [];
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  Util.fetchTraced = (url) => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) });
  };
  // gotoTab would render panes that need a real DOM; render() dispatching to it is Plant's own contract.
  Plant.gotoTab = () => {};
  try {
    Store.setSelectedPlant('1006', 'test');
    Plant._currentPlantTab = 'general';
    assert.equal(await Plant.refresh(), true);
    assert.ok(urls.some(u => u.includes('/priority-rank-maps?plant=1006')), `rank maps fetched: ${urls}`);
    assert.ok(urls.some(u => u.endsWith('/plant-calendar?plant=1006')), `plant calendar fetched: ${urls}`);
    assert.ok(!urls.some(u => u.includes('/setup/1006')), `no setup snapshot on the general tab: ${urls}`);

    urls.length = 0;
    Plant._currentPlantTab = 'settings';
    assert.equal(await Plant.refresh(), true);
    assert.ok(urls.some(u => u.endsWith('/setup/1006')), `setup snapshot re-fetched on the settings tab: ${urls}`);
  } finally {
    Plant.gotoTab = originalGoto;
    Plant._currentPlantTab = priorTab;
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

test('ProdLines.refresh flushes a pending debounced line-hours write before re-fetching', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetch = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const priorFlush = CalendarSync._flushLineHours;
  const order = [];
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  CalendarSync._flushLineHours = (plant) => { order.push(`flush:${plant}`); return Promise.resolve({ ok: true }); };
  Util.fetchTraced = (url) => { order.push(`fetch:${String(url)}`); return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) }); };
  try {
    Store.setSelectedPlant('1006', 'test');
    await ProdLines.refresh();
    assert.equal(order[0], 'flush:1006', 'the flush runs before any fetch');
  } finally {
    CalendarSync._flushLineHours = priorFlush;
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

// Final-review fixes (plan 2026-10-15-master-data-refresh): a failed flush, a partial master-data
// fetch and a failed rank-map fetch must each leave the previous state intact.
test('ProdLines.refresh and Plant.refresh resolve false and fetch nothing when the line-hours flush failed', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetch = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const priorFlush = CalendarSync._flushLineHours;
  const urls = [];
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  CalendarSync._flushLineHours = () => Promise.resolve({ ok: false });
  Util.fetchTraced = (url) => { urls.push(String(url)); return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) }); };
  try {
    Store.setSelectedPlant('1006', 'test');
    assert.equal(await ProdLines.refresh(), false);
    assert.equal(await Plant.refresh(), false);
    assert.deepEqual(urls, [], 'a failed flush must not be followed by a re-fetch that overwrites the local edit');
  } finally {
    CalendarSync._flushLineHours = priorFlush;
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

test('ProdLines.refresh keeps the Store plants and resolves false when only the plants fetch fails', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetch = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const keepPlants = [{ plant: 'KEEP' }];
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  Util.fetchTraced = (url) => {
    if (String(url).includes('/master-data/plants')) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [{ machine: 'FRESH-1' }] }) });
  };
  try {
    Store.setSelectedPlant('1006', 'test');
    Store.setMasterData({ plants: keepPlants, lines: [{ machine: 'OLD-1' }], workcenters: [] }, 'test');
    assert.equal(await ProdLines.refresh(), false, 'only half the data is fresh');
    assert.equal(Store.masterData.plants, keepPlants, 'a failed plants fetch must not wipe the plants');
    assert.deepEqual(Store.masterData.lines, [{ machine: 'FRESH-1' }], 'the machine rows that did land still show');
  } finally {
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

test('Plant.refresh restores the previous rank maps and leaves them marked stale when the rank-map fetch fails', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetch = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const priorTab = Plant._currentPlantTab;
  const priorRankPlant = Persistence._rankMapsPlant;
  const priorRanks = Store.priorityRankMaps;
  const originalGoto = Plant.gotoTab;
  const keepRanks = { color: { RED: 1 } };
  let rankStatus = 500;
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  Plant.gotoTab = () => {};
  Plant._currentPlantTab = 'general';
  Util.fetchTraced = (url) => {
    if (String(url).includes('/priority-rank-maps')) {
      return Promise.resolve({ ok: rankStatus === 200, status: rankStatus, json: () => Promise.resolve({ color: { BLUE: 2 } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) });
  };
  try {
    Store.setSelectedPlant('1006', 'test');
    Store.setPriorityRankMaps(keepRanks, 'test');
    Persistence._rankMapsPlant = '1006';
    await Plant.refresh();
    assert.equal(Store.priorityRankMaps, keepRanks, 'a failed rank-map fetch must not leave the optimizer with empty priority lists');
    assert.equal(Persistence._rankMapsPlant, null, 'the maps stay marked stale so the freshness guards retry');

    rankStatus = 200;
    await Plant.refresh();
    assert.deepEqual(Store.priorityRankMaps, { color: { BLUE: 2 } });
    assert.equal(Persistence._rankMapsPlant, '1006');
  } finally {
    Plant.gotoTab = originalGoto;
    Plant._currentPlantTab = priorTab;
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setPriorityRankMaps(priorRanks, 'test-restore');
    Persistence._rankMapsPlant = priorRankPlant;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

test('Plant working-hours pills open the plant Edit Calendar modal; _fmtHour renders midnight', () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorPlant = Store.selectedPlant;
  const originalOpenPlant = EditCalendar.openPlant;
  const calls = [];
  EditCalendar.openPlant = name => { calls.push(name); };
  globalThis.window = {};
  globalThis.document = { getElementById: () => null };
  try {
    Store.setSelectedPlant('1006', 'test');
    Plant._pillClick(1);   // an open day
    Plant._pillClick(0);   // a day that may be closed: same single-click behavior
    assert.deepEqual(calls, ['1006', '1006']);

    calls.length = 0;
    Store.setSelectedPlant(null, 'test');
    Plant._pillClick(1);
    assert.deepEqual(calls, [], 'no plant selected: openPlant must not be called');

    assert.equal(ProdLines._fmtHour(24), '12am', 'a stored 24 (end of day) reads as midnight');
    assert.equal(ProdLines._fmtHour(17), '5pm');
    assert.equal(ProdLines._fmtHour(12), '12pm');
    assert.equal(ProdLines._fmtHour(0), '12am');
  } finally {
    EditCalendar.openPlant = originalOpenPlant;
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

test('MasterData exposes its documented public API', () => {
  assert.equal(typeof MasterData.render, 'function');
  assert.equal(typeof MasterData.syncLineSettings, 'function');
});

test('Plant Settings pane exposes tree-rendering internals', () => {
  // Smoke-level, matching this file's existing thin public-API-shape style.
  // The Stage 3 priority tree's actual behavior is covered by
  // Engine.flattenConstraints' own tests in tests/modules/schedule-services.test.mjs
  // — _renderSettingsPane is a thin consumer of it (it deliberately does not
  // reimplement the flatten), and its render path needs a live DOM, which this
  // node:test suite has no jsdom for.
  assert.equal(typeof Plant._renderSettingsPane, 'function');
});

test('Plant Settings pane omits the redundant title and introductory copy', () => {
  const source = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  const renderer = source.slice(source.indexOf('_renderSettingsPane(): void {'), source.indexOf('  },\n};', source.indexOf('_renderSettingsPane(): void {')));
  assert.doesNotMatch(renderer, /ui\.system_settings_title/);
  assert.doesNotMatch(renderer, /ui\.system_settings_sub/);
});

test('Plant Settings pane has one fixed strip plus a scrollable body', () => {
  // Regression target: nesting the tab strip inside the scroll region lets
  // navigation disappear. (The "setup signature editor exposes accessible
  // removal" half of this regression target lives in SetupAdmin, now in
  // tests/modules/setup/setup-admin.test.mjs, since Plant and SetupAdmin
  // split into different files in Phase P2 of
  // docs/architecture/domain-refactor-plan.md.)
  const source = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  assert.match(source, /<div class="settings-content-scroll">/);
  assert.match(source, /<nav class="admin-subtabs settings-inner-tabs"/);
});

test('Plant exposes the generalized priority-list optimization API', () => {
  assert.equal(typeof Plant._renderOptimization, 'function');
  assert.equal(typeof Plant._uploadPriorityList, 'function');
  assert.equal(typeof Plant._confirmDeletePriorityList, 'function');
  assert.equal(typeof Plant._resyncOrderAttributes, 'function');
});

test('Plant blackout list renders only blocks for the selected plant', () => {
  const list = { innerHTML: '', style: {}, querySelectorAll: () => [] };
  const stats = { innerHTML: '' };
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorPlant = Store.selectedPlant;
  const priorBlocks = Store.plantBlocks;
  globalThis.window = {};
  globalThis.document = {
    getElementById: id => id === 'plant-blocks-list' ? list
      : id === 'plant-blocks-stats' ? stats : null,
  };
  try {
    const start = new Date('2026-08-18T08:00:00');
    const end = new Date('2026-08-18T12:00:00');
    Store.setSelectedPlant('1006', 'test');
    Store.replacePlantBlocks([
      { id: 'plant-5512', plant: '5512', start, end, reason: '5512-only' },
      { id: 'plant-1006', plant: '1006', start, end, reason: '1006-only' },
    ], 'test');
    Plant._renderBlocks();
    assert.doesNotMatch(list.innerHTML, /5512-only/);
    assert.match(list.innerHTML, /1006-only/);
    assert.match(stats.innerHTML, /pbs-val">1</);

    // H4 residual: a quote/angle-bracket-bearing reason or id must be escaped and
    // never reach an inline handler.
    Store.replacePlantBlocks([
      { id: `x');alert(1);//"<b>`, plant: '1006', start, end, reason: '<img src=x onerror=alert(1)>' },
    ], 'test');
    Plant._renderBlocks();
    assert.doesNotMatch(list.innerHTML, /<img/);
    assert.doesNotMatch(list.innerHTML, /onclick=/);
    assert.match(list.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(list.innerHTML, /data-block-id="x&#39;\);alert\(1\);\/\/&quot;&lt;b&gt;"/);
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    Store.replacePlantBlocks(priorBlocks, 'test-restore');
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

test('Plant blackout delete ignores an ID that belongs to another plant', async () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorPlant = Store.selectedPlant;
  const priorBlocks = Store.plantBlocks;
  const originalDelete = CalendarSync.savePlantBlackoutDelete;
  const originalConfirm = Modal.confirm;
  let deleteCalls = 0;
  let confirmCalls = 0;
  Modal.confirm = async () => { confirmCalls += 1; return true; };
  CalendarSync.savePlantBlackoutDelete = () => {
    deleteCalls += 1;
    return Promise.resolve({ ok: true });
  };
  globalThis.window = {};
  globalThis.document = { getElementById: () => null };
  const block = {
    id: 'plant-5512', plant: '5512',
    start: new Date('2026-08-18T08:00:00'), end: new Date('2026-08-18T12:00:00'),
    reason: '5512-only',
  };
  try {
    Store.setSelectedPlant('1006', 'test');
    Store.replacePlantBlocks([block], 'test');
    await Plant.removePlantBlock(block.id);
    assert.deepEqual(Store.plantBlocks, [block]);
    assert.equal(deleteCalls, 0);
    assert.equal(confirmCalls, 0, 'a block of another plant never even prompts');
  } finally {
    CalendarSync.savePlantBlackoutDelete = originalDelete;
    Modal.confirm = originalConfirm;
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    Store.replacePlantBlocks(priorBlocks, 'test-restore');
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

// P2-11b (aggregate_to_detail.md §4.2): the Machines pane's SAP Work Center
// combobox writes through the pane's autosave bulk path, but first checks how
// many distributions/scheduled sub-orders reference the machine so a
// reassignment away from a work center that's already feeding live children
// doesn't happen silently.
test('ProdLines._reassignWorkcenter confirms before reassigning a machine with existing distributions, and skips the write on decline', async () => {
  const priorPlant = Store.selectedPlant;
  const priorFetch = globalThis.fetch;
  const priorNimbus = globalThis.NIMBUS;
  const priorWindow = globalThis.window;
  const priorConfirm = Modal.confirm;
  const priorToast = Toast.show;

  let confirmArgs = null;
  let confirmCalls = 0;
  let syncCalls = 0;
  let fetchedUrl = null;

  Modal.confirm = (opts) => { confirmArgs = opts; confirmCalls += 1; return Promise.resolve(false); };
  Toast.show = () => {};
  globalThis.window = { ...(priorWindow || {}), __NIMBUS_LOCALES: { en: {
    'toast.dist_reassign_confirm': '{{n}} distributions and {{k}} scheduled sub-orders reference {{machine}} under {{wc}}; they will show as *machine left work center* until their shares are adjusted',
  } } };
  globalThis.NIMBUS = { MasterData: { syncLineSettings: () => { syncCalls += 1; return Promise.resolve(); } } };
  globalThis.fetch = (url) => {
    fetchedUrl = String(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [], meta: { total: 3, scheduled_children: 2 } }) });
  };

  try {
    Store.setSelectedPlant('1006', 'test');
    Store.setLineSetting('LINE1', { sapWorkcenter: 'WC-OLD' }, 'test');

    await ProdLines._reassignWorkcenter('LINE1', 'WC-NEW');

    assert.match(fetchedUrl, /\/distribution\/1006\?machines=LINE1&limit=1$/);
    assert.equal(confirmCalls, 1, 'a confirm dialog must open when meta.total > 0');
    assert.equal(confirmArgs.tone, 'warn');
    assert.equal(confirmArgs.detail,
      '3 distributions and 2 scheduled sub-orders reference LINE1 under WC-OLD; they will show as *machine left work center* until their shares are adjusted');
    // Declined -> no write: sapWorkcenter stays at the pre-selection value and
    // the pane's autosave bulk path (syncLineSettings) is never invoked.
    assert.equal(syncCalls, 0);
    assert.equal(Store.lineSettings.LINE1.sapWorkcenter, 'WC-OLD');
  } finally {
    Modal.confirm = priorConfirm;
    Toast.show = priorToast;
    globalThis.fetch = priorFetch;
    if (priorNimbus === undefined) delete globalThis.NIMBUS; else globalThis.NIMBUS = priorNimbus;
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

test('ProdLines._reassignWorkcenter writes through on confirm when there are existing distributions', async () => {
  const priorPlant = Store.selectedPlant;
  const priorFetch = globalThis.fetch;
  const priorNimbus = globalThis.NIMBUS;
  const priorWindow = globalThis.window;
  const priorConfirm = Modal.confirm;
  const priorToast = Toast.show;

  let syncCalls = 0;
  let syncPatch = null;

  Modal.confirm = () => Promise.resolve(true);
  Toast.show = () => {};
  // Util.t() (the confirm detail AND the post-write success toast) reads bare
  // `window.__NIMBUS_LOCALES` — must be defined even when no specific key
  // lookup is asserted here, or the unguarded post-write Toast.show(Util.t(...))
  // throws ReferenceError: window is not defined.
  globalThis.window = { ...(priorWindow || {}), __NIMBUS_LOCALES: priorWindow?.__NIMBUS_LOCALES || { en: {} } };
  globalThis.NIMBUS = { MasterData: { syncLineSettings: (line, patch) => { syncCalls += 1; syncPatch = patch; return Promise.resolve(); } } };
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [], meta: { total: 1, scheduled_children: 0 } }) });

  try {
    Store.setSelectedPlant('1006', 'test');
    Store.setLineSetting('LINE1', { sapWorkcenter: 'WC-OLD' }, 'test');

    await ProdLines._reassignWorkcenter('LINE1', 'WC-NEW');

    assert.equal(syncCalls, 1, 'a confirmed reassignment must still write through the autosave bulk path');
    assert.deepEqual(syncPatch, { sapWorkcenter: 'WC-NEW' });
    assert.equal(Store.lineSettings.LINE1.sapWorkcenter, 'WC-NEW');
  } finally {
    Modal.confirm = priorConfirm;
    Toast.show = priorToast;
    globalThis.fetch = priorFetch;
    if (priorNimbus === undefined) delete globalThis.NIMBUS; else globalThis.NIMBUS = priorNimbus;
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

test('ProdLines._reassignWorkcenter writes directly with no dialog when meta.total is zero', async () => {
  const priorPlant = Store.selectedPlant;
  const priorFetch = globalThis.fetch;
  const priorNimbus = globalThis.NIMBUS;
  const priorWindow = globalThis.window;
  const priorConfirm = Modal.confirm;
  const priorToast = Toast.show;

  let confirmCalls = 0;
  let syncCalls = 0;
  let syncPatch = null;

  Modal.confirm = () => { confirmCalls += 1; return Promise.resolve(false); };
  Toast.show = () => {};
  globalThis.window = { ...(priorWindow || {}), __NIMBUS_LOCALES: priorWindow?.__NIMBUS_LOCALES || { en: {} } };
  globalThis.NIMBUS = { MasterData: { syncLineSettings: (line, patch) => { syncCalls += 1; syncPatch = patch; return Promise.resolve(); } } };
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [], meta: { total: 0, scheduled_children: 0 } }) });

  try {
    Store.setSelectedPlant('1006', 'test');
    Store.setLineSetting('LINE1', { sapWorkcenter: 'WC-OLD' }, 'test');

    await ProdLines._reassignWorkcenter('LINE1', 'WC-NEW');

    assert.equal(confirmCalls, 0, 'meta.total === 0 must never open the confirm dialog');
    assert.equal(syncCalls, 1);
    assert.deepEqual(syncPatch, { sapWorkcenter: 'WC-NEW' });
    assert.equal(Store.lineSettings.LINE1.sapWorkcenter, 'WC-NEW');
  } finally {
    Modal.confirm = priorConfirm;
    Toast.show = priorToast;
    globalThis.fetch = priorFetch;
    if (priorNimbus === undefined) delete globalThis.NIMBUS; else globalThis.NIMBUS = priorNimbus;
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

// WorkCenters._wcBlockReason(staged: WorkCenterStaged, members: string[]): WcBlockReason
// is the client-side pre-flight for the three PUT /distribution/{plant}/workcenters/{wc}
// rules (backend/distribution/data.py:161-172) — autosave only fires when this
// returns null, so it is the gate that keeps the pane from ever sending a
// request the backend would reject with a 400. Pure/DOM-free, hence testable
// directly with no jsdom. The returned strings are the literal backend rule
// codes ('single_mode_without_default', 'default_machine_not_member',
// 'distribute_mode_thin') by design — that's the client/server contract — so
// assert the exact strings, not just truthiness.
test('WorkCenters._wcBlockReason covers every gate rule with the exact backend rule code', () => {
  const base = {
    description: '', distribution_mode: 'distribute', default_machine: '',
    max_separation: 'none', review_required: false, distribute_tooled: false, weights: {},
  };

  // distribute mode, 2+ members, no default machine -> all-clear.
  assert.equal(WorkCenters._wcBlockReason({ ...base }, ['M1', 'M2']), null);

  // single mode with no default machine set.
  assert.equal(
    WorkCenters._wcBlockReason({ ...base, distribution_mode: 'single' }, ['M1', 'M2']),
    'single_mode_without_default',
  );

  // default machine set but not among the work center's current members —
  // checked ahead of the thin-membership rule regardless of mode.
  assert.equal(
    WorkCenters._wcBlockReason({ ...base, default_machine: 'M9' }, ['M1', 'M2']),
    'default_machine_not_member',
  );

  // distribute mode with exactly 1 member.
  assert.equal(
    WorkCenters._wcBlockReason({ ...base }, ['M1']),
    'distribute_mode_thin',
  );

  // distribute mode with 0 members: the implementation reuses
  // 'distribute_mode_thin' rather than a distinct code (members.length < 2
  // catches both 0 and 1) — only the *display text* (_wcNoticeText) branches
  // on memberCount === 0 to point the admin at the Machines tab instead of
  // repeating the generic "needs 2+ members" copy.
  assert.equal(
    WorkCenters._wcBlockReason({ ...base }, []),
    'distribute_mode_thin',
  );
});

// 1:1 case: a machine named exactly the work center code is linked to it.
// Alone in single mode it is a valid default (no 'single_mode_without_default');
// once the work center aggregates (2+ members, or distribute mode) orders would
// land on that machine and never distribute -> 'wc_code_is_member_of_aggregate'.
test('WorkCenters._wcBlockReason handles a same-named linked member (wc_code_is_member_of_aggregate)', () => {
  const base = {
    description: '', distribution_mode: 'single', default_machine: '',
    max_separation: 'none', review_required: false, distribute_tooled: false, weights: {},
  };

  // Alone, single mode, no default -> not blocked.
  assert.equal(WorkCenters._wcBlockReason({ ...base }, ['20STA11'], '20STA11'), null);

  // Distribute mode with the same-named member -> blocked.
  assert.equal(
    WorkCenters._wcBlockReason({ ...base, distribution_mode: 'distribute' }, ['20STA11', 'M2'], '20STA11'),
    'wc_code_is_member_of_aggregate',
  );
  assert.equal(
    WorkCenters._wcBlockReason({ ...base, distribution_mode: 'distribute' }, ['20STA11'], '20STA11'),
    'wc_code_is_member_of_aggregate',
  );

  // Two members in single mode -> blocked.
  assert.equal(
    WorkCenters._wcBlockReason({ ...base }, ['20STA11', 'M2'], '20STA11'),
    'wc_code_is_member_of_aggregate',
  );

  // No same-named member -> original rules still apply.
  assert.equal(
    WorkCenters._wcBlockReason({ ...base }, ['M1', 'M2'], '20STA11'),
    'single_mode_without_default',
  );
});

test('WorkCenters._buildWrite keeps the loaded plant during a selection change', () => {
  const previous = {
    loadedPlant: WorkCenters._loadedPlant, selected: WorkCenters._selected,
    staged: WorkCenters._staged, machines: WorkCenters._machines,
    plant: Store.selectedPlant,
  };
  try {
    WorkCenters._loadedPlant = 'PLANT-A';
    WorkCenters._selected = 'WC-1';
    WorkCenters._staged = {
      description: '', distribution_mode: 'distribute', default_machine: '',
      max_separation: 'none', review_required: false, distribute_tooled: false, weights: {},
    };
    WorkCenters._machines = [
      { machine: 'M1', sap_workcenter: 'WC-1' },
      { machine: 'M2', sap_workcenter: 'WC-1' },
    ];
    Store.setSelectedPlant('PLANT-B', 'unit-test');
    assert.equal(WorkCenters._buildWrite()?.plant, 'PLANT-A');
  } finally {
    WorkCenters._loadedPlant = previous.loadedPlant;
    WorkCenters._selected = previous.selected;
    WorkCenters._staged = previous.staged;
    WorkCenters._machines = previous.machines;
    Store.setSelectedPlant(previous.plant, 'unit-test');
  }
});

// Work centers are now source data (SAP interface ingest or the Admin >
// Manage Plant Data grid) — this pins that the removed creation surface
// (toggle/form/create/cancel controls and the old staged-edit Save/Discard
// machinery) never regrows on this tab.
test('Work Centers tab source has no creation surface and no Save/Discard staging leftovers', () => {
  const source = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /wc-new-(toggle|form|create|cancel)|_createNew/);
  assert.doesNotMatch(source, /wc-save-btn|wc-discard-btn|_wcDirtyFields|_pendingWarnings|_renderWcWarnings/);
});

// ROUTING_TABLES includes 'machine' to ensure that edits to machine.sap_workcenter
// trigger a Runtime.load refresh, since a machine's work-center mapping directly
// affects which routing operation applies (ROUTING_RUNTIME_DESIGN.md D6).
test('MasterData ROUTING_TABLES includes machine for work-center mapping invalidation', () => {
  const source = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  assert.match(source, /const ROUTING_TABLES:.*=\s*new Set\(\[.*['"]machine['"]/s);
});

// Bulk-save (paste/cell-edit) to routing_rules can name several plants (the table is NOT in
// SCOPED_TABLES, its grid shows multiple plants' rows simultaneously). Runtime holds ONE plant's
// rate map, so the saved rows' plants are handed to _refreshRuntimeFor, which reloads only when
// Store.selectedPlant is among them.
test('MasterData bulk-save for routing_rules hands the saved rows\' plants to the selected-plant Runtime refresh', () => {
  const source = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  assert.match(source, /if \(table === ['"]routing_rules['"]\)/);
  assert.match(source, /function _refreshRuntimeFor\(/);
  assert.match(source, /if \(p === selected\) \{ Runtime\.load\(selected\)/);
});

// D38 (aggregate_to_detail.md audit): a successful autosave used to patch only
// this pane's own `_rows`/`_machines` — Store.masterData.workcenters (what
// Alerts/the optimizer actually read) stayed on the pre-edit snapshot until
// some unrelated full master-data refresh happened to land. _write now
// patches the matching Store row and schedules an alerts recompute too, but
// only for the currently selected plant (F7 scoped Store.masterData.workcenters
// per plant) — a save that lands for a different (background) plant must not
// touch the live Store other tabs are reading.
test('WorkCenters._write patches the matching Store.masterData.workcenters row and schedules an alerts recompute, scoped to the selected plant', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetch = Util.fetchTraced;
  const priorIsAdmin = Session.isAdmin;
  const priorRecompute = Alerts.scheduleRecompute;
  const priorDocument = globalThis.document;
  const priorCSS = globalThis.CSS;
  const priorRows = WorkCenters._rows;
  const priorMachines = WorkCenters._machines;
  const priorSelected = WorkCenters._selected;
  const priorLoadedPlant = WorkCenters._loadedPlant;

  let recomputeCalls = 0;
  Session.isAdmin = () => true;
  Alerts.scheduleRecompute = () => { recomputeCalls += 1; };
  globalThis.document = { querySelector: () => null, getElementById: () => null };
  // _refreshSidebarRow (called from _write's success path) uses CSS.escape —
  // a real browser global, absent in this node:test (no jsdom) environment.
  globalThis.CSS = { escape: (s) => s };
  Util.fetchTraced = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      description: 'Updated', distribution_mode: 'distribute', default_machine: null,
      max_separation: 'day', review_required: true, distribute_tooled: true,
      weights: { M1: 1, M2: 2 },
    }),
  });

  try {
    WorkCenters._rows = [];
    WorkCenters._machines = [];
    WorkCenters._selected = null;
    WorkCenters._loadedPlant = null;
    Store.setSelectedPlant('P1', 'test');
    Store.setMasterData({
      plants: [], lines: [],
      workcenters: [
        { plant: 'P1', sap_workcenter: 'WC-1', description: 'Old', distribution_mode: 'single', default_machine: 'M1', max_separation: 'none', review_required: false, distribute_tooled: false },
        { plant: 'P2', sap_workcenter: 'WC-1', description: 'Other plant, same code', distribution_mode: 'single', default_machine: null, max_separation: 'none', review_required: false, distribute_tooled: false },
      ],
    }, 'test');

    // Selected-plant save: patches the matching row, leaves the other plant's
    // same-code row untouched, and schedules a recompute.
    await WorkCenters._write('P1', 'WC-1', {
      description: 'Updated', distribution_mode: 'distribute', default_machine: null,
      max_separation: 'day', review_required: true, distribute_tooled: true,
      weights: { M1: 1, M2: 2 },
    }, ['M1', 'M2'], WorkCenters._editSeq);

    const patched = Store.masterData.workcenters.find((w) => w.plant === 'P1' && w.sap_workcenter === 'WC-1');
    assert.deepEqual(patched, {
      plant: 'P1', sap_workcenter: 'WC-1', description: 'Updated', distribution_mode: 'distribute',
      default_machine: null, max_separation: 'day', review_required: true, distribute_tooled: true,
    });
    const otherPlantRow = Store.masterData.workcenters.find((w) => w.plant === 'P2');
    assert.equal(otherPlantRow.description, 'Other plant, same code');
    assert.equal(recomputeCalls, 1);

    // Background-plant save (plant !== Store.selectedPlant, which is still
    // 'P1'): must not touch Store.masterData or fire a recompute.
    Store.setMasterData({
      plants: [], lines: [],
      workcenters: [
        { plant: 'P2', sap_workcenter: 'WC-9', description: 'Before', distribution_mode: 'single', default_machine: 'M9', max_separation: 'none', review_required: false, distribute_tooled: false },
      ],
    }, 'test');
    recomputeCalls = 0;
    await WorkCenters._write('P2', 'WC-9', {
      description: 'Should not land', distribution_mode: 'single', default_machine: 'M9',
      max_separation: 'none', review_required: false, distribute_tooled: false, weights: {},
    }, ['M9'], WorkCenters._editSeq);
    assert.equal(Store.masterData.workcenters.find((w) => w.plant === 'P2').description, 'Before');
    assert.equal(recomputeCalls, 0);
  } finally {
    Session.isAdmin = priorIsAdmin;
    Alerts.scheduleRecompute = priorRecompute;
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    if (priorCSS === undefined) delete globalThis.CSS; else globalThis.CSS = priorCSS;
    WorkCenters._rows = priorRows;
    WorkCenters._machines = priorMachines;
    WorkCenters._selected = priorSelected;
    WorkCenters._loadedPlant = priorLoadedPlant;
    Store.setMasterData(priorMasterData, 'test-restore');
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

// D28 (aggregate_to_detail.md audit): _queued used to hold a single slot and
// the queued write fired un-awaited ("fire-and-forget") right as _saving was
// cleared — a fresh debounced autosave for the row the admin had moved on to
// could then start a SECOND concurrent PUT while that queued one was still
// in flight. _queued is now a Map keyed by plant+code (so edits to different
// work centers queue independently, and a repeat edit to the SAME work
// center replaces its earlier queued payload) and _autosave drains it in a
// loop inside the same try/finally that holds _saving true, so the queue is
// fully serialized and a concurrent _autosave() call is blocked until the
// whole drain settles.
test('WorkCenters._autosave serializes queued writes for different work centers, sends only the latest payload for a repeated code, and blocks a concurrent autosave until the drain finishes', async () => {
  const priorPlant = Store.selectedPlant;
  const priorFetch = Util.fetchTraced;
  const priorIsAdmin = Session.isAdmin;
  const priorRecompute = Alerts.scheduleRecompute;
  const priorDocument = globalThis.document;
  const priorCSS = globalThis.CSS;
  const priorRows = WorkCenters._rows;
  const priorMachines = WorkCenters._machines;
  const priorSelected = WorkCenters._selected;
  const priorLoadedPlant = WorkCenters._loadedPlant;
  const priorStaged = WorkCenters._staged;
  const priorBaseline = WorkCenters._baseline;
  const priorQueued = WorkCenters._queued;
  const priorSaving = WorkCenters._saving;
  const priorDirty = WorkCenters._dirty;

  const calls = []; // { code, body, resolve }
  Session.isAdmin = () => true;
  Alerts.scheduleRecompute = () => {};
  globalThis.document = { querySelector: () => null, getElementById: () => null };
  // _refreshSidebarRow (called from _write's success path) uses CSS.escape —
  // a real browser global, absent in this node:test (no jsdom) environment.
  globalThis.CSS = { escape: (s) => s };
  Util.fetchTraced = (url, init) => {
    const code = decodeURIComponent(String(url).split('/').pop());
    return new Promise((resolve) => {
      calls.push({
        code,
        body: JSON.parse(init.body),
        settle: (body) => resolve({ ok: true, json: () => Promise.resolve(body ?? { ...JSON.parse(init.body), weights: {} }) }),
      });
    });
  };

  const staged = (description, machine) => ({
    description, distribution_mode: 'single', default_machine: machine,
    max_separation: 'none', review_required: false, distribute_tooled: false, weights: {},
  });

  try {
    WorkCenters._queued = new Map();
    WorkCenters._saving = false;
    WorkCenters._dirty = false;
    Store.setSelectedPlant('P1', 'test');
    WorkCenters._loadedPlant = 'P1';
    WorkCenters._machines = [
      { machine: 'MA', sap_workcenter: 'WC-A' },
      { machine: 'MB', sap_workcenter: 'WC-B' },
      { machine: 'MC', sap_workcenter: 'WC-C' },
      { machine: 'MD', sap_workcenter: 'WC-D' },
    ];

    // Kick off the first write for WC-A (fetch deferred — nothing resolves yet).
    WorkCenters._selected = 'WC-A';
    WorkCenters._staged = staged('A1', 'MA');
    WorkCenters._markDirty();
    const done = WorkCenters._autosave();
    await Promise.resolve();
    assert.equal(calls.length, 1, 'WC-A write must fire immediately');
    assert.equal(calls[0].code, 'WC-A');
    assert.equal(WorkCenters._saving, true);

    // While WC-A is still in flight, flush edits for WC-B and WC-C — these
    // must queue (no new fetch calls yet), not fire.
    WorkCenters._selected = 'WC-B';
    WorkCenters._staged = staged('B1', 'MB');
    WorkCenters._markDirty();
    WorkCenters._flushPending();
    WorkCenters._selected = 'WC-C';
    WorkCenters._staged = staged('C1', 'MC');
    WorkCenters._markDirty();
    WorkCenters._flushPending();
    assert.equal(calls.length, 1, 'queuing must not fire a write while one is in flight');
    assert.equal(WorkCenters._queued.size, 2);

    // A second edit to WC-B before it has been sent must REPLACE the queued
    // payload, not add a third queue entry.
    WorkCenters._selected = 'WC-B';
    WorkCenters._staged = staged('B2-latest', 'MB');
    WorkCenters._markDirty();
    WorkCenters._flushPending();
    assert.equal(WorkCenters._queued.size, 2, 'repeat edit to the same work center must replace, not add');
    assert.equal(WorkCenters._queued.get('P1\u0000WC-B').payload.description, 'B2-latest');

    // Settle WC-A. The drain should pick up WC-B next, still inside the same
    // _saving window — a concurrent autosave attempt must be blocked.
    calls[0].settle();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 2, 'WC-B must be sent once WC-A settles');
    assert.equal(calls[1].code, 'WC-B');
    assert.equal(calls[1].body.description, 'B2-latest', 'the latest queued payload must be the one sent');

    // Prove the overlap D28 fixes is actually closed: with the drain mid-way
    // (WC-B in flight, WC-C still queued), a fresh debounced autosave for yet
    // another row must not start a concurrent PUT.
    WorkCenters._selected = 'WC-D';
    WorkCenters._staged = staged('D1', 'MD');
    WorkCenters._markDirty();
    void WorkCenters._autosave();
    assert.equal(calls.length, 2, 'a concurrent autosave must be blocked while the drain is still in flight');
    assert.equal(WorkCenters._saving, true);
    WorkCenters._dirty = false; // not under test here — avoid it feeding a trailing drain below

    calls[1].settle();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 3, 'WC-C must be sent once WC-B settles');
    assert.equal(calls[2].code, 'WC-C');

    calls[2].settle();
    await done;

    assert.equal(WorkCenters._saving, false);
    assert.equal(WorkCenters._queued.size, 0);
  } finally {
    Session.isAdmin = priorIsAdmin;
    Alerts.scheduleRecompute = priorRecompute;
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    if (priorCSS === undefined) delete globalThis.CSS; else globalThis.CSS = priorCSS;
    WorkCenters._rows = priorRows;
    WorkCenters._machines = priorMachines;
    WorkCenters._selected = priorSelected;
    WorkCenters._loadedPlant = priorLoadedPlant;
    WorkCenters._staged = priorStaged;
    WorkCenters._baseline = priorBaseline;
    WorkCenters._queued = priorQueued;
    WorkCenters._saving = priorSaving;
    WorkCenters._dirty = priorDirty;
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

// #36: deleting an exclude/include rule changes a plant's rate map just like editing one,
// so the refresh set must include plants named in DELETED rows too (not only upserts).
test('MasterData bulk-save for routing_rules also refreshes Runtime for plants whose rules were deleted', () => {
  const source = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  assert.match(source, /_refreshRuntimeFor\(\[\.\.\.upserts, \.\.\.deletes\]\.map\(\(row\) => row\.plant as string \| undefined\)\)/);
});

test('syncLineSettings posts only the key columns and the changed column, not the whole cached row (#46)', async () => {
  const priorFetch = globalThis.fetch;
  const priorToast = Toast.show;
  const posts = [];
  Toast.show = () => {};
  Store.setLineSetting('LINE-46', { plant: 'P46' }, 'test');
  const priorGetPlant = Store.getPlantForLine;
  Store.getPlantForLine = (line) => (line === 'LINE-46' ? 'P46' : priorGetPlant.call(Store, line));
  globalThis.fetch = (url, opts) => {
    if (opts && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({
      columns: [], rows: [{ subnetwork: 'S1', plant: 'P46', machine: 'LINE-46', bottleneck: null, buffer_hours: 3, wc_group: 'G-old' }],
    }) });
  };
  try {
    await MasterData.syncLineSettings('LINE-46', { bottleneck: true });
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].upserts, [{ subnetwork: 'S1', plant: 'P46', machine: 'LINE-46', bottleneck: 'X' }],
      'untouched columns (buffer_hours, wc_group) must not be re-posted from the stale cache');
  } finally {
    Store.getPlantForLine = priorGetPlant;
    globalThis.fetch = priorFetch;
    Toast.show = priorToast;
  }
});

// Final-review fix: syncLineSettings memoizes the plant's machine rows; a machine added after the
// cache was filled (then shown by Refresh) must not be silently dropped by the rowIdx < 0 return.
function _lineSyncHarness(plant, machineBatches) {
  const gets = [];
  const posts = [];
  const priorFetch = globalThis.fetch;
  const priorToast = Toast.show;
  const priorGetPlant = Store.getPlantForLine;
  Toast.show = () => {};
  Store.getPlantForLine = (line) => (line.startsWith('M-') ? plant : priorGetPlant.call(Store, line));
  globalThis.fetch = (url, opts) => {
    if (opts && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    gets.push(String(url));
    const machines = machineBatches[Math.min(gets.length, machineBatches.length) - 1];
    return Promise.resolve({ ok: true, json: () => Promise.resolve({
      columns: [], rows: machines.map((m) => ({ subnetwork: 'S1', plant, machine: m, bottleneck: null })),
    }) });
  };
  const restore = () => { globalThis.fetch = priorFetch; Toast.show = priorToast; Store.getPlantForLine = priorGetPlant; };
  return { gets, posts, restore };
}

test('syncLineSettings drops its cache and refetches once when the line is absent, then posts (new machine after Refresh)', async () => {
  const h = _lineSyncHarness('P-miss', [['M-A'], ['M-A', 'M-B']]);
  try {
    await MasterData.syncLineSettings('M-A', { bottleneck: true });
    assert.equal(h.gets.length, 1, 'first call fills the cache');
    await MasterData.syncLineSettings('M-B', { bottleneck: true });
    assert.equal(h.gets.length, 2, 'a machine missing from the cache triggers exactly one refetch');
    assert.match(h.gets[1], /\/master-data\/machine\?plant=P-miss$/);
    assert.equal(h.posts.length, 2, 'the new machine\'s edit is saved, not silently dropped');
    assert.equal(h.posts[1].upserts[0].machine, 'M-B');
  } finally { h.restore(); }
});

test('syncLineSettings refetches once and then gives up without posting when the line is still absent', async () => {
  const h = _lineSyncHarness('P-gone', [['M-A']]);
  try {
    await MasterData.syncLineSettings('M-A', { bottleneck: true });
    await MasterData.syncLineSettings('M-Z', { bottleneck: true });
    assert.equal(h.gets.length, 2);
    assert.equal(h.posts.length, 1, 'no POST for a machine the server does not have');
  } finally { h.restore(); }
});

test('a successful master-data refresh invalidates the line-sync machine cache for that plant', async () => {
  const priorPlant = Store.selectedPlant;
  const priorMasterData = Store.masterData;
  const priorFetchTraced = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const h = _lineSyncHarness('P-inv', [['M-A']]);
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  try {
    await MasterData.syncLineSettings('M-A', { bottleneck: true });
    assert.equal(h.gets.length, 1);
    Store.setSelectedPlant('P-inv', 'test');
    Util.fetchTraced = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) });
    assert.equal(await ProdLines.refresh(), true);
    Util.fetchTraced = priorFetchTraced;
    await MasterData.syncLineSettings('M-A', { bottleneck: false });
    assert.equal(h.gets.length, 2, 'the cache was dropped by the refresh, so the next sync refills it');
  } finally {
    h.restore();
    Util.fetchTraced = priorFetchTraced;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

test('delete-filtered counts on the server and keeps markup out of the confirm message (#47)', () => {
  const source = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  const start = source.indexOf('async function _deleteFiltered');
  const body = source.slice(start, source.indexOf('// Save', start));
  assert.match(body, /meta\?\.total/, 'expected_count must come from the server list total');
  assert.doesNotMatch(body, /state\.rows\.filter/, 'no client-side recount that disagrees with the server predicate');
  assert.doesNotMatch(body, /message:[^\n]*<strong>/, 'confirm message is plain text; markup belongs in detail');
});

test('WorkCenters._flushOnPageHide sends queued edits with keepalive so they survive tab close (D28)', async () => {
  const priorFetch = globalThis.fetch;
  const priorIsAdmin = Session.isAdmin;
  const calls = [];
  Session.isAdmin = () => true;
  globalThis.fetch = (url, opts) => { calls.push({ url: String(url), opts }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); };
  const payload = { description: 'x', distribution_mode: 'single', default_machine: 'M1', max_separation: 'none', review_required: false, distribute_tooled: false, weights: {} };
  try {
    WorkCenters._queued.set('P\u0000WC1', { plant: 'P', code: 'WC1', payload, members: ['M1'] });
    WorkCenters._dirty = false;
    WorkCenters._flushOnPageHide();
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/distribution\/P\/workcenters\/WC1$/);
    assert.equal(calls[0].opts.method, 'PUT');
    assert.equal(calls[0].opts.keepalive, true);
    assert.equal(WorkCenters._queued.size, 0, 'queue is drained so nothing is sent twice');
  } finally {
    Session.isAdmin = priorIsAdmin;
    globalThis.fetch = priorFetch;
  }
});

test('machine / material_plants load plant-scoped and materials/material_plants are server-paged (#25)', () => {
  const source = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  assert.match(source, /machine:\s+'plant',\s*\n\s*material_plants:\s+'plant',/, 'machine + material_plants are SCOPED_TABLES');
  assert.match(source, /PAGED_TABLES[^\n]*new Set\(\['materials', 'material_plants'\]\)/);
  assert.match(source, /function _isPaged\(table: MasterDataTable\): boolean \{\s*return PAGED_TABLES\.has\(table\) \|\| \(table === 'bom_items' && !_scopeFilter\('bom_items'\)\.material_id\);/,
    'bom_items pages only while no material filter narrows it');
  assert.equal((source.match(/PAGED_TABLES\.has\(/g) || []).length, 1, 'every other paging check goes through _isPaged');
  const autoScope = source.slice(source.indexOf('const AUTO_SCOPE_FROM_SELECTED_PLANT'), source.indexOf(']);', source.indexOf('const AUTO_SCOPE_FROM_SELECTED_PLANT')));
  for (const t of ['machine', 'material_plants', 'bom_items', 'production_version', 'routing_operation']) {
    assert.match(autoScope, new RegExp(`'${t}'`), `${t} follows the top-bar plant`);
  }
  assert.doesNotMatch(source, /_renderScopeGate|md-bom-gate|btn\.change_scope/, 'the plant/material gate card is gone');
  const load = source.slice(source.indexOf('async function _loadAndRender'), source.indexOf('function _renderTable'));
  assert.match(load, /params\.set\('limit'/, 'paged tables send a limit');
  assert.match(load, /params\.set\('search'/, 'paged tables search server-side');
  assert.match(load, /params\.set\('offset'/, 'Load more sends an offset');
  const fk = source.slice(source.indexOf('const FK_SOURCE'), source.indexOf('const FIXED_OPTIONS'));
  assert.doesNotMatch(fk, /material_id:\s*'materials'/, 'no whole-materials FK dropdown');
  assert.doesNotMatch(source, /master-data\/machine`/, 'no unscoped /master-data/machine fetch left');
});

test('persistence fetches /master-data/machine only with the plant (#25)', () => {
  const source = readFileSync(new URL('../../../frontend/scheduling/persistence.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /master-data\/machine`/, 'no unscoped machine fetch');
  assert.equal((source.match(/master-data\/machine\?plant=\$\{encodeURIComponent\(plant\)\}/g) || []).length, 2);
});

test('WorkCenters.render installs the pagehide listener once, and firing it flushes the CURRENT unsaved edit plus queued ones (D28)', async () => {
  const priorFetch = globalThis.fetch;
  const priorIsAdmin = Session.isAdmin;
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorPlant = Store.selectedPlant;
  const priorWired = WorkCenters._pageHideWired;
  const priorState = {
    loadedPlant: WorkCenters._loadedPlant, selected: WorkCenters._selected, staged: WorkCenters._staged,
    machines: WorkCenters._machines, dirty: WorkCenters._dirty,
  };
  const listeners = [];
  const calls = [];
  Session.isAdmin = () => true;
  globalThis.window = { addEventListener: (type, fn) => listeners.push({ type, fn }) };
  globalThis.document = { getElementById: () => ({ innerHTML: '' }), querySelector: () => null };
  globalThis.fetch = (url, opts) => { calls.push({ url: String(url), opts }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); };
  try {
    // 1. render() wires the listener (no plant selected -> returns right after wiring).
    Store.setSelectedPlant(null, "test");
    WorkCenters._pageHideWired = false;
    await WorkCenters.render();
    const pagehide = listeners.filter(l => l.type === 'pagehide');
    assert.equal(pagehide.length, 1, 'a pagehide listener is installed');
    await WorkCenters.render();
    assert.equal(listeners.filter(l => l.type === 'pagehide').length, 1, 'second render does not stack another listener');

    // 2. Invoking the captured listener flushes a queued edit AND the current unsaved (dirty) edit.
    const payload = { description: 'q', distribution_mode: 'single', default_machine: 'M1', max_separation: 'none', review_required: false, distribute_tooled: false, weights: {} };
    WorkCenters._queued.set('P\u0000OLD', { plant: 'P', code: 'OLD', payload, members: ['M1'] });
    WorkCenters._loadedPlant = 'P';
    WorkCenters._selected = 'CUR';
    WorkCenters._machines = [{ machine: 'M1', sap_workcenter: 'CUR' }, { machine: 'M2', sap_workcenter: 'CUR' }];
    WorkCenters._staged = { description: 'typed just now', distribution_mode: 'distribute', default_machine: '', max_separation: 'none', review_required: false, distribute_tooled: false, weights: { M1: 3, M2: null } };
    WorkCenters._dirty = true;
    pagehide[0].fn();
    assert.equal(calls.length, 2, 'queued write + current unsaved write');
    const urls = calls.map(c => c.url);
    assert.ok(urls.some(u => /\/distribution\/P\/workcenters\/OLD$/.test(u)), 'queued edit flushed');
    const cur = calls.find(c => /\/workcenters\/CUR$/.test(c.url));
    assert.ok(cur, 'the in-progress (not yet queued) edit is flushed too');
    assert.equal(cur.opts.keepalive, true);
    const body = JSON.parse(cur.opts.body);
    assert.equal(body.description, 'typed just now');
    assert.deepEqual(body.weights, { M1: 3, M2: null });
    assert.equal(WorkCenters._dirty, false, 'dirty cleared so autosave does not resend');
    assert.equal(WorkCenters._queued.size, 0);

    // 3. Nothing dirty and nothing queued -> nothing sent.
    calls.length = 0;
    pagehide[0].fn();
    assert.equal(calls.length, 0);
  } finally {
    Session.isAdmin = priorIsAdmin;
    globalThis.fetch = priorFetch;
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, "test");
    WorkCenters._pageHideWired = priorWired;
    WorkCenters._loadedPlant = priorState.loadedPlant; WorkCenters._selected = priorState.selected;
    WorkCenters._staged = priorState.staged; WorkCenters._machines = priorState.machines; WorkCenters._dirty = priorState.dirty;
    WorkCenters._queued.clear();
  }
});

// Master Data sub-tab Refresh (docs/superpowers plan 2026-10-15-master-data-refresh, Task 3).
// WorkCenters.refresh re-pulls the work-center list even when the plant is unchanged
// (render() would only refresh the machine roster there), keeping search text and selection.
function _wcRefreshHarness({ failList = false, rows } = {}) {
  const urls = [];
  const fetchTraced = (url) => {
    urls.push(String(url));
    if (failList && /\/master-data\/sap_workcenter\?/.test(String(url))) {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    }
    if (/\/master-data\/sap_workcenter\?/.test(String(url))) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows, meta: { total: rows.length } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [{ machine: 'M1', sap_workcenter: 'WC-1', distribution_weight: null }] }) });
  };
  return { urls, fetchTraced };
}
const _wcRow = (code, description) => ({
  sap_workcenter: code, description, distribution_mode: 'single', default_machine: 'M1',
  max_separation: 'none', review_required: false, distribute_tooled: false,
});
const _wcStaged = (description) => ({
  description, distribution_mode: 'single', default_machine: 'M1', max_separation: 'none',
  review_required: false, distribute_tooled: false, weights: {},
});

async function _withWcRefreshState(fn) {
  const priorFetch = Util.fetchTraced;
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  const priorToast = Toast.show;
  const priorIsAdmin = Session.isAdmin;
  const priorPlant = Store.selectedPlant;
  const prior = {
    rows: WorkCenters._rows, machines: WorkCenters._machines, search: WorkCenters._search,
    offset: WorkCenters._offset, loadedPlant: WorkCenters._loadedPlant, selected: WorkCenters._selected,
    staged: WorkCenters._staged, baseline: WorkCenters._baseline, dirty: WorkCenters._dirty,
    saving: WorkCenters._saving,
  };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.window = { ...(priorWindow || {}), __NIMBUS_LOCALES: priorWindow?.__NIMBUS_LOCALES || { en: {} } }; // Util.t reads it on the load-failed path
  Session.isAdmin = () => true;
  const toasts = [];
  Toast.show = (m, kind) => toasts.push({ m, kind });
  try {
    await fn(toasts);
  } finally {
    Util.fetchTraced = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
    Toast.show = priorToast;
    Session.isAdmin = priorIsAdmin;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    WorkCenters._rows = prior.rows; WorkCenters._machines = prior.machines; WorkCenters._search = prior.search;
    WorkCenters._offset = prior.offset; WorkCenters._loadedPlant = prior.loadedPlant;
    WorkCenters._selected = prior.selected; WorkCenters._staged = prior.staged;
    WorkCenters._baseline = prior.baseline; WorkCenters._dirty = prior.dirty; WorkCenters._saving = prior.saving;
    WorkCenters._queued.clear();
  }
}

test('WorkCenters exposes refresh()', () => {
  assert.equal(typeof WorkCenters.refresh, 'function');
});

test('WorkCenters.refresh fetches the plant-scoped list even when the plant is unchanged, keeps the search text, and resolves true', async () => {
  await _withWcRefreshState(async () => {
    const h = _wcRefreshHarness({ rows: [_wcRow('WC-1', 'fresh')] });
    Util.fetchTraced = h.fetchTraced;
    Store.setSelectedPlant('1006', 'test');
    WorkCenters._loadedPlant = '1006'; // render() would take its same-plant branch and skip the list
    WorkCenters._search = 'WC';
    WorkCenters._offset = 50;
    WorkCenters._rows = [_wcRow('WC-1', 'stale')];
    const result = await WorkCenters.refresh();
    assert.equal(result, true);
    const listUrl = h.urls.find((u) => /\/master-data\/sap_workcenter\?/.test(u));
    assert.ok(listUrl, `work-center list fetched: ${h.urls}`);
    assert.match(listUrl, /plant=1006/);
    assert.match(listUrl, /search=WC/);
    assert.match(listUrl, /offset=0/);
    assert.ok(h.urls.some((u) => u.endsWith('/master-data/machine?plant=1006')), 'plant-scoped machine roster fetched');
    assert.equal(WorkCenters._search, 'WC', 'search text survives');
    assert.equal(WorkCenters._rows[0].description, 'fresh', 'fresh rows replaced the stale ones');
  });
});

test('WorkCenters.refresh keeps the selected work center when it is still in the fresh rows, restaging it from the fresh row', async () => {
  await _withWcRefreshState(async () => {
    const h = _wcRefreshHarness({ rows: [_wcRow('WC-1', 'fresh desc'), _wcRow('WC-2', 'other')] });
    Util.fetchTraced = h.fetchTraced;
    Store.setSelectedPlant('1006', 'test');
    WorkCenters._loadedPlant = '1006';
    WorkCenters._rows = [_wcRow('WC-1', 'stale desc')];
    WorkCenters._selected = 'WC-1';
    WorkCenters._staged = _wcStaged('stale desc');
    WorkCenters._baseline = _wcStaged('stale desc');
    const seqBefore = WorkCenters._editSeq;
    assert.equal(await WorkCenters.refresh(), true);
    assert.equal(WorkCenters._selected, 'WC-1');
    assert.equal(WorkCenters._staged.description, 'fresh desc', 'staged rebuilt from the fresh row');
    assert.equal(WorkCenters._baseline.description, 'fresh desc');
    assert.equal(WorkCenters._dirty, false);
    assert.ok(WorkCenters._editSeq > seqBefore, 'restaging bumps the edit sequence so a stale in-flight response is ignored');
  });
});

test('WorkCenters.refresh clears the selection when the selected work center vanished from the fresh rows', async () => {
  await _withWcRefreshState(async () => {
    const h = _wcRefreshHarness({ rows: [_wcRow('WC-2', 'other')] });
    Util.fetchTraced = h.fetchTraced;
    Store.setSelectedPlant('1006', 'test');
    WorkCenters._loadedPlant = '1006';
    WorkCenters._rows = [_wcRow('WC-1', 'old')];
    WorkCenters._selected = 'WC-1';
    WorkCenters._staged = _wcStaged('old');
    WorkCenters._baseline = _wcStaged('old');
    assert.equal(await WorkCenters.refresh(), true);
    assert.equal(WorkCenters._selected, null);
    assert.equal(WorkCenters._staged, null);
    assert.equal(WorkCenters._baseline, null);
  });
});

test('WorkCenters.refresh resolves false and keeps rows, selection and staged edit when the list fetch fails', async () => {
  await _withWcRefreshState(async (toasts) => {
    const h = _wcRefreshHarness({ failList: true, rows: [] });
    Util.fetchTraced = h.fetchTraced;
    Store.setSelectedPlant('1006', 'test');
    WorkCenters._loadedPlant = '1006';
    const keptRows = [_wcRow('WC-1', 'kept')];
    WorkCenters._rows = keptRows;
    WorkCenters._offset = 50; // after one load-more
    WorkCenters._selected = 'WC-1';
    const staged = _wcStaged('kept');
    WorkCenters._staged = staged;
    WorkCenters._baseline = _wcStaged('kept');
    assert.equal(await WorkCenters.refresh(), false);
    assert.equal(WorkCenters._offset, 50, 'a failed refresh must not reset paging, or the next load-more duplicates rows');
    assert.equal(WorkCenters._rows, keptRows);
    assert.equal(WorkCenters._selected, 'WC-1');
    assert.equal(WorkCenters._staged, staged);
    assert.ok(toasts.some((t) => t.kind === 'error'), 'the existing load-failed toast still shows');
  });
});

test('WorkCenters.refresh resolves false and fetches nothing when no plant is selected', async () => {
  await _withWcRefreshState(async () => {
    const h = _wcRefreshHarness({ rows: [] });
    Util.fetchTraced = h.fetchTraced;
    Store.setSelectedPlant(null, 'test');
    assert.equal(await WorkCenters.refresh(), false);
    assert.equal(h.urls.length, 0);
  });
});

test('WorkCenters.refresh flushes a pending debounced edit before re-fetching', async () => {
  await _withWcRefreshState(async () => {
    const h = _wcRefreshHarness({ rows: [_wcRow('WC-1', 'fresh')] });
    const calls = [];
    Util.fetchTraced = (url, opts) => {
      calls.push({ url: String(url), method: opts?.method || 'GET' });
      return h.fetchTraced(url, opts);
    };
    Store.setSelectedPlant('1006', 'test');
    WorkCenters._loadedPlant = '1006';
    WorkCenters._rows = [_wcRow('WC-1', 'old')];
    WorkCenters._machines = [{ machine: 'M1', sap_workcenter: 'WC-1', distribution_weight: null }];
    WorkCenters._selected = 'WC-1';
    WorkCenters._staged = { ..._wcStaged('typed just now'), weights: { M1: null } };
    WorkCenters._baseline = { ..._wcStaged('old'), weights: { M1: null } };
    WorkCenters._saving = false;
    WorkCenters._dirty = true;
    await WorkCenters.refresh();
    const putIdx = calls.findIndex((c) => c.method === 'PUT' && /\/workcenters\/WC-1$/.test(c.url));
    const getIdx = calls.findIndex((c) => /\/master-data\/sap_workcenter\?/.test(c.url));
    assert.ok(putIdx >= 0, `pending edit was sent: ${JSON.stringify(calls)}`);
    assert.ok(putIdx < getIdx, 'the write is dispatched before the list re-fetch');
  });
});

test('WorkCenters.refresh keeps an edit typed while the list fetch is pending and never re-sends the stale fetched value', async () => {
  await _withWcRefreshState(async () => {
    const h = _wcRefreshHarness({ rows: [_wcRow('WC-1', 'stale-from-server'), _wcRow('WC-2', 'new row')] });
    const puts = [];
    let releaseList;
    const listGate = new Promise((res) => { releaseList = res; });
    Util.fetchTraced = async (url, opts) => {
      if (opts?.method === 'PUT') puts.push(JSON.parse(opts.body));
      if (/\/master-data\/sap_workcenter\?/.test(String(url))) await listGate; // fetch "in flight"
      return h.fetchTraced(url, opts);
    };
    Store.setSelectedPlant('1006', 'test');
    WorkCenters._loadedPlant = '1006';
    WorkCenters._rows = [_wcRow('WC-1', 'old')];
    WorkCenters._machines = [{ machine: 'M1', sap_workcenter: 'WC-1', distribution_weight: null }];
    WorkCenters._selected = 'WC-1';
    WorkCenters._staged = { ..._wcStaged('old'), weights: { M1: null } };
    WorkCenters._baseline = { ..._wcStaged('old'), weights: { M1: null } };
    WorkCenters._saving = false;
    WorkCenters._dirty = false;
    const pending = WorkCenters.refresh();
    // User types while the GET is outstanding.
    WorkCenters._staged = { ...WorkCenters._staged, description: 'typed during fetch' };
    WorkCenters._markDirty();
    releaseList();
    assert.equal(await pending, true);
    assert.equal(WorkCenters._selected, 'WC-1');
    assert.equal(WorkCenters._staged.description, 'typed during fetch', 'staged edit is not overwritten by the older fetched row');
    await new Promise((r) => setTimeout(r, 20)); // let the _maybeFlush autosave settle
    assert.ok(puts.length >= 1, 'the user edit is sent');
    assert.ok(puts.every((p) => p.description === 'typed during fetch'), `no stale value is ever PUT: ${JSON.stringify(puts)}`);
    assert.deepEqual(WorkCenters._rows.map((r) => r.sap_workcenter), ['WC-1', 'WC-2'], 'the list itself still refreshed');
  });
});

test('Plant.gotoTab("calendar") shows only the Calendar pane and renders the periods; an unknown tab is ignored', () => {
  const priorDocument = globalThis.document;
  const priorTab = Plant._currentPlantTab;
  const priorRender = CalendarPeriodsUI.render;
  const panes = {};
  for (const t of ['general', 'calendar', 'optimization', 'settings']) panes[`plant-tab-${t}`] = { hidden: t !== 'general' };
  const tabBtn = (t) => ({ dataset: { plantTab: t }, active: false, classList: { toggle(_c, on) { this.owner.active = on; } } });
  const btns = ['general', 'calendar', 'optimization', 'settings'].map(tabBtn);
  btns.forEach(b => { b.classList.owner = b; });
  let rendered = 0;
  CalendarPeriodsUI.render = () => { rendered += 1; };
  globalThis.document = {
    getElementById: id => panes[id] ?? null,
    querySelector: () => null,
    querySelectorAll: sel => (sel === '.plant-inner-tabs .sub-subtab' ? btns : []),
  };
  try {
    Plant.gotoTab('calendar');
    assert.equal(Plant._currentPlantTab, 'calendar');
    assert.deepEqual(Object.fromEntries(Object.entries(panes).map(([k, v]) => [k, v.hidden])), {
      'plant-tab-general': true, 'plant-tab-calendar': false, 'plant-tab-optimization': true, 'plant-tab-settings': true,
    });
    assert.deepEqual(btns.map(b => b.active), [false, true, false, false]);
    assert.equal(rendered, 1, 'the Calendar tab renders its periods when opened');
    Plant.gotoTab('nonsense');
    assert.equal(Plant._currentPlantTab, 'calendar');
    assert.equal(panes['plant-tab-calendar'].hidden, false);
  } finally {
    CalendarPeriodsUI.render = priorRender;
    Plant._currentPlantTab = priorTab;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
  }
});

test('Plant.render() leaves the Calendar timeline to gotoTab, and static wiring initialises it once', () => {
  const priorDocument = globalThis.document;
  const priorPlant = Store.selectedPlant;
  const originalGoto = Plant.gotoTab;
  const priorRender = CalendarPeriodsUI.render;
  const priorInit = CalendarPeriodsUI.init;
  const log = [];
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  Plant.gotoTab = () => {};
  CalendarPeriodsUI.render = () => log.push('render');
  CalendarPeriodsUI.init = () => log.push('init');
  try {
    Store.setSelectedPlant('1006', 'test');
    Plant.render();
    assert.deepEqual(log, [], 'no second render here: gotoTab renders the Calendar tab itself when it is showing');
    Plant._wireStaticHandlers();
    assert.deepEqual(log, ['init']);
  } finally {
    CalendarPeriodsUI.render = priorRender;
    CalendarPeriodsUI.init = priorInit;
    Plant.gotoTab = originalGoto;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

// Plant blackout edit flow (add/edit share #modal-plant-block).
function _blockModalHarness(blocks) {
  const els = {
    'plant-blk-reason': { value: '' },
    'plant-blk-start': { value: '' },
    'plant-blk-end': { value: '' },
    'modal-plant-block-title': { textContent: '' },
    'modal-plant-block-save-btn': { textContent: '' },
    'plant-blocks-list': { innerHTML: '', style: {} },
    'plant-blocks-stats': { innerHTML: '' },
  };
  const picker = el => ({ setDate: d => { el.value = d instanceof Date ? d.toISOString() : String(d); } });
  const saved = {
    window: globalThis.window, document: globalThis.document, plant: Store.selectedPlant,
    blocks: Store.plantBlocks, open: Modal.open, close: Modal.close, show: Toast.show,
    upsert: CalendarSync.savePlantBlackoutUpsert, fpS: Plant._fpBlkStart, fpE: Plant._fpBlkEnd,
    collapsed: Plant._blocksCollapsed,
  };
  const log = { posts: [], toasts: [], closed: [], opened: [] };
  globalThis.window = {};
  globalThis.document = { getElementById: id => els[id] || null };
  Modal.open = id => log.opened.push(id);
  Modal.close = id => log.closed.push(id);
  Toast.show = (msg, kind) => log.toasts.push([msg, kind]);
  CalendarSync.savePlantBlackoutUpsert = b => { log.posts.push(b); return Promise.resolve({ ok: true }); };
  Plant._fpBlkStart = picker(els['plant-blk-start']);
  Plant._fpBlkEnd = picker(els['plant-blk-end']);
  Plant._blocksCollapsed = false;
  Plant._editingBlockId = null;
  Store.setSelectedPlant('1006', 'test');
  Store.replacePlantBlocks(blocks, 'test');
  const restore = () => {
    if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    Modal.open = saved.open; Modal.close = saved.close; Toast.show = saved.show;
    CalendarSync.savePlantBlackoutUpsert = saved.upsert;
    Plant._fpBlkStart = saved.fpS; Plant._fpBlkEnd = saved.fpE;
    Plant._blocksCollapsed = saved.collapsed; Plant._editingBlockId = null;
    Store.replacePlantBlocks(saved.blocks, 'test-restore');
    Store.setSelectedPlant(saved.plant, 'test-restore');
  };
  return { els, log, restore };
}

const _blk = (id, reason = 'Holiday') => ({
  id, plant: '1006', reason,
  start: new Date('2026-12-24T00:00:00'), end: new Date('2026-12-26T00:00:00'),
});

test('Plant.openBlockModal(id) prefills the edit form; a later add open resets to add mode', () => {
  const h = _blockModalHarness([_blk('pb1')]);
  try {
    Plant.openBlockModal('pb1');
    assert.equal(Plant._editingBlockId, 'pb1');
    assert.equal(h.els['plant-blk-reason'].value, 'Holiday');
    assert.notEqual(h.els['plant-blk-start'].value, '');
    assert.deepEqual(h.log.opened, ['modal-plant-block']);
    // Cancel and the close button shut the modal with no Plant hook; the next plain open must be a clean add.
    Plant.openBlockModal();
    assert.equal(Plant._editingBlockId, null);
    assert.equal(h.els['plant-blk-reason'].value, '');
    // Add mode: saving creates a new block and never routes through the edit path.
    h.els['plant-blk-reason'].value = 'Audit';
    h.els['plant-blk-start'].value = '2027-01-10T08:00:00';
    h.els['plant-blk-end'].value = '2027-01-10T12:00:00';
    Plant.savePlantBlockFromModal();
    assert.equal(Store.plantBlocks.length, 2);
    assert.equal(h.log.posts.length, 1);
    assert.equal(h.log.posts[0].reason, 'Audit');
  } finally { h.restore(); }
});

test('Plant.savePlantBlockFromModal edit path updates in place and POSTs once; unchanged is a no-op', () => {
  const h = _blockModalHarness([_blk('pb1')]);
  try {
    Plant.openBlockModal('pb1');
    h.els['plant-blk-start'].value = '2026-12-24T00:00:00';
    h.els['plant-blk-end'].value = '2026-12-26T00:00:00';
    Plant.savePlantBlockFromModal();
    assert.equal(h.log.posts.length, 0, 'nothing changed, so nothing is written');
    assert.deepEqual(h.log.closed, ['modal-plant-block']);

    Plant.openBlockModal('pb1');
    h.els['plant-blk-start'].value = '2026-12-24T00:00:00';
    h.els['plant-blk-end'].value = '2026-12-27T00:00:00';
    h.els['plant-blk-reason'].value = 'Shutdown';
    Plant.savePlantBlockFromModal();
    assert.equal(Store.plantBlocks.length, 1);
    assert.equal(Store.plantBlocks[0].id, 'pb1');
    assert.equal(Store.plantBlocks[0].reason, 'Shutdown');
    assert.equal(h.log.posts.length, 1);
    assert.equal(h.log.posts[0].id, 'pb1');
    assert.equal(h.log.toasts[h.log.toasts.length - 1][1], 'success');
  } finally { h.restore(); }
});

test('Plant.savePlantBlockFromModal edit of a vanished block makes no POST and does not re-insert it', () => {
  const h = _blockModalHarness([_blk('pb1')]);
  try {
    Plant.openBlockModal('pb1');
    h.els['plant-blk-start'].value = '2026-12-24T00:00:00';
    h.els['plant-blk-end'].value = '2026-12-28T00:00:00';
    h.els['plant-blk-reason'].value = 'Changed';
    Store.replacePlantBlocks([], 'test-hydrate');
    Plant.savePlantBlockFromModal();
    assert.equal(h.log.posts.length, 0);
    assert.equal(Store.plantBlocks.length, 0);
    assert.deepEqual(h.log.closed, ['modal-plant-block']);
    assert.equal(h.log.toasts[h.log.toasts.length - 1][1], 'warn');
    assert.equal(Plant._editingBlockId, null);
  } finally { h.restore(); }
});

test('Plant._renderBlocks shows the empty-state message even when collapsed', () => {
  const h = _blockModalHarness([]);
  try {
    Plant._blocksCollapsed = true;
    Plant._renderBlocks();
    assert.match(h.els['plant-blocks-list'].innerHTML, /empty-state/);
    assert.equal(h.els['plant-blocks-list'].style.display, '', 'an empty list has no chevron, so collapse never hides its message');
    Plant._blocksCollapsed = false;
    Plant._renderBlocks();
    assert.equal(h.els['plant-blocks-list'].style.display, '', 'expanding re-shows the empty-state message');
    assert.match(h.els['plant-blocks-list'].innerHTML, /empty-state/);
  } finally { h.restore(); }
});

test('Plant._renderBlocks renders each row as an edit button plus a remove button; panel and roster default to expanded', () => {
  const h = _blockModalHarness([_blk('pb1')]);
  try {
    Plant._renderBlocks();
    assert.match(h.els['plant-blocks-list'].innerHTML, /<button type="button" class="plant-blk-edit" data-block-id="pb1" title="Holiday · [^"]+">/);
    assert.match(h.els['plant-blocks-list'].innerHTML, /plant-blk-remove/);
    assert.equal(h.els['plant-blocks-list'].style.display, '');
  } finally { h.restore(); }
  const src = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  assert.match(src, /_blocksCollapsed: false,/);
  assert.match(src, /_rosterCollapsed: false,/);
});

test('Plant.savePlantBlockFromModal: an edit that duplicates another blackout keeps the modal open and toasts an error', () => {
  const other = { id: 'pb2', plant: '1006', reason: 'Audit', start: new Date('2027-01-05T00:00:00'), end: new Date('2027-01-06T00:00:00') };
  const h = _blockModalHarness([_blk('pb1'), other]);
  try {
    Plant.openBlockModal('pb1');
    h.els['plant-blk-start'].value = '2027-01-05T00:00:00';
    h.els['plant-blk-end'].value = '2027-01-06T00:00:00';
    h.els['plant-blk-reason'].value = 'Audit';
    Plant.savePlantBlockFromModal();
    assert.deepEqual(h.log.closed, [], 'the modal stays open so the user can fix it');
    assert.equal(h.log.posts.length, 0);
    assert.equal(Plant._editingBlockId, 'pb1', 'still editing the same block');
    assert.equal(Store.plantBlocks.find(b => b.id === 'pb1').reason, 'Holiday', 'the Store is untouched');
    const last = h.log.toasts[h.log.toasts.length - 1];
    assert.equal(last[1], 'error');
    assert.equal(last[0], "toast.plant_blackout_duplicate");
    // Fixing the reason and saving again goes through.
    h.els['plant-blk-reason'].value = 'Audit 2';
    Plant.savePlantBlockFromModal();
    assert.equal(h.log.posts.length, 1);
    assert.deepEqual(h.log.closed, ['modal-plant-block']);
  } finally { h.restore(); }
});

test('timeline delegated click: a single marker opens the blackout editor, a cluster reveals and flashes its list rows', () => {
  const priorDocument = globalThis.document, priorWindow = globalThis.window;
  const priorOpen = Plant.openBlockModal, priorInit = CalendarPeriodsUI.init, priorTimeout = globalThis.setTimeout;
  const priorCollapsed = Plant._blocksCollapsed;
  let handler = null;
  const opened = [];
  const flashed = new Set();
  const mkRow = id => ({ id, classList: { add: () => flashed.add(id), remove: () => flashed.delete(id) }, scrollIntoView: () => {} });
  const rows = { b1: mkRow('b1'), b2: mkRow('b2'), b3: mkRow('b3') };
  const btns = Object.keys(rows).map(id => ({ dataset: { blockId: id }, closest: () => rows[id] }));
  const panel = { scrolled: 0, scrollIntoView() { this.scrolled++; } };
  const timeline = { addEventListener: (type, fn) => { if (type === 'click') handler = fn; } };
  const timers = [];
  globalThis.setTimeout = fn => { timers.push(fn); return 0; };
  globalThis.window = {};
  globalThis.document = {
    getElementById: id => (id === 'plant-periods-timeline' ? timeline : id === 'plant-blackouts-panel' ? panel : null),
    querySelector: () => null,
    querySelectorAll: sel => (sel === '#plant-blocks-list .plant-blk-edit' ? btns : []),
  };
  Plant.openBlockModal = id => opened.push(id);
  CalendarPeriodsUI.init = () => {};
  try {
    Plant._wireStaticHandlers();
    assert.ok(handler, 'the timeline listener is registered');
    const markEvt = dataset => ({ target: { closest: sel => (sel === '[data-action="edit-blackout"]' ? { dataset } : null) } });
    handler({ target: { closest: () => null } });
    assert.deepEqual(opened, [], 'clicks that are not on a blackout marker are ignored');
    handler(markEvt({ action: 'edit-blackout', id: 'b1' }));
    assert.deepEqual(opened, ['b1']);
    assert.equal(panel.scrolled, 0);
    Plant._blocksCollapsed = false;
    handler(markEvt({ action: 'edit-blackout', ids: '["b1","b3"]' }));
    assert.deepEqual(opened, ['b1'], 'a cluster does not open the editor');
    assert.equal(panel.scrolled, 1);
    assert.deepEqual([...flashed].sort(), ['b1', 'b3']);
    timers.forEach(fn => fn());
    assert.equal(flashed.size, 0, 'the highlight is transient');
    handler(markEvt({ action: 'edit-blackout', ids: 'not json' }));
    assert.equal(flashed.size, 0);
  } finally {
    globalThis.setTimeout = priorTimeout;
    Plant.openBlockModal = priorOpen; CalendarPeriodsUI.init = priorInit;
    Plant._blocksCollapsed = priorCollapsed;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
  }
});

test('Plant.savePlantBlockFromModal: an untouched Save of a legacy row (seconds, blank reason) writes nothing', () => {
  const legacy = { id: 'pbL', plant: '1006', reason: '', start: new Date('2026-12-24T00:00:30'), end: new Date('2026-12-26T00:00:45') };
  const h = _blockModalHarness([legacy]);
  try {
    Plant.openBlockModal('pbL');
    // The picker shows minutes only, so the form holds the stored instants cut to the minute.
    h.els['plant-blk-start'].value = '2026-12-24T00:00:00';
    h.els['plant-blk-end'].value = '2026-12-26T00:00:00';
    h.els['plant-blk-reason'].value = '';
    Plant.savePlantBlockFromModal();
    assert.equal(h.log.posts.length, 0, 'untouched form must not rewrite the row');
    assert.equal(Store.plantBlocks[0].reason, '');
    assert.deepEqual(h.log.closed, ['modal-plant-block']);
    // A real edit of the same row still writes.
    Plant.openBlockModal('pbL');
    h.els['plant-blk-start'].value = '2026-12-24T00:00:00';
    h.els['plant-blk-end'].value = '2026-12-26T00:00:00';
    h.els['plant-blk-reason'].value = 'Shutdown';
    Plant.savePlantBlockFromModal();
    assert.equal(h.log.posts.length, 1);
  } finally { h.restore(); }
});

test('Plant._renderBlocks: a collapsed list that becomes empty shows its empty message (no chevron to reopen it)', () => {
  const h = _blockModalHarness([_blk('pb1')]);
  try {
    Plant._blocksCollapsed = true;
    Plant._renderBlocks();
    assert.equal(h.els['plant-blocks-list'].style.display, 'none', 'collapsed with a row stays hidden');
    Store.replacePlantBlocks([], 'test');
    Plant._renderBlocks();
    assert.equal(h.els['plant-blocks-list'].style.display, '');
    assert.match(h.els['plant-blocks-list'].innerHTML, /empty-state/);
  } finally { h.restore(); }
});

// Plant blackout delete asks first (same dialog as deleting a calendar period).
function _removeHarness(blocks, confirmImpl) {
  const h = _blockModalHarness(blocks);
  const saved = { confirm: Modal.confirm, del: CalendarSync.savePlantBlackoutDelete };
  h.confirms = [];
  h.deletes = [];
  Modal.confirm = async (opts) => { h.confirms.push(opts); return confirmImpl ? confirmImpl(opts) : true; };
  CalendarSync.savePlantBlackoutDelete = (plant, id) => { h.deletes.push([plant, id]); return Promise.resolve({ ok: true }); };
  const base = h.restore;
  h.restore = () => { Modal.confirm = saved.confirm; CalendarSync.savePlantBlackoutDelete = saved.del; base(); };
  return h;
}

test('Plant.removePlantBlock asks a danger confirm naming the reason and range, then removes and posts the delete', async () => {
  const h = _removeHarness([_blk('pb1', 'Summer shutdown')]);
  try {
    await Plant.removePlantBlock('pb1');
    assert.equal(h.confirms.length, 1);
    const c = h.confirms[0];
    assert.equal(c.tone, 'danger');
    assert.equal(c.title, 'confirm.delete_blackout_title');
    assert.equal(c.confirmLabel, 'btn.delete_blackout');
    assert.equal(typeof c.message, 'string');
    assert.deepEqual(Store.plantBlocks, []);
    assert.deepEqual(h.deletes, [['1006', 'pb1']]);
    assert.equal(h.log.toasts.at(-1)[0], 'toast.plant_blackout_removed');
  } finally { h.restore(); }
});

test('Plant.removePlantBlock passes the reason (or the default label) and the row range into the message', async () => {
  const seen = [];
  const prior = Util.t;
  Util.t = (key, params) => { seen.push([key, params]); return prior.call(Util, key, params); };
  const h = _removeHarness([_blk('pb1', 'Summer shutdown'), _blk('pb2', '')]);
  try {
    await Plant.removePlantBlock('pb1');
    await Plant.removePlantBlock('pb2');
    const msgs = seen.filter(([k]) => k === 'confirm.delete_blackout');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0][1].reason, 'Summer shutdown');
    assert.equal(msgs[0][1].range, Util.fmtBlockRange(_blk('x').start, _blk('x').end));
    assert.notEqual(msgs[1][1].reason, '', 'a blank reason falls back to the default label');
  } finally { Util.t = prior; h.restore(); }
});

test('Plant.removePlantBlock: Cancel keeps the blackout and sends nothing', async () => {
  const h = _removeHarness([_blk('pb1')], () => false);
  try {
    await Plant.removePlantBlock('pb1');
    assert.equal(h.confirms.length, 1);
    assert.deepEqual(Store.plantBlocks.map(b => b.id), ['pb1']);
    assert.deepEqual(h.deletes, []);
    assert.equal(h.log.toasts.length, 0);
  } finally { h.restore(); }
});

test('Plant.removePlantBlock: a blackout that vanished while the dialog was open is a no-op (no second delete, no toast)', async () => {
  const h = _removeHarness([_blk('pb1')], () => { Store.replacePlantBlocks([], 'other-tab'); return true; });
  try {
    await Plant.removePlantBlock('pb1');
    assert.deepEqual(h.deletes, []);
    assert.equal(h.log.toasts.length, 0);
  } finally { h.restore(); }
});

test('Plant.removePlantBlock: switching plant while the dialog is open deletes nothing', async () => {
  const h = _removeHarness([_blk('pb1')], () => { Store.setSelectedPlant('5512', 'test'); return true; });
  try {
    await Plant.removePlantBlock('pb1');
    assert.deepEqual(h.deletes, []);
    assert.deepEqual(Store.plantBlocks.map(b => b.id), ['pb1']);
  } finally { h.restore(); }
});

test('Plant.removePlantBlock: an unknown id never prompts', async () => {
  const h = _removeHarness([_blk('pb1')]);
  try {
    await Plant.removePlantBlock('nope');
    assert.equal(h.confirms.length, 0);
    assert.deepEqual(Store.plantBlocks.map(b => b.id), ['pb1']);
  } finally { h.restore(); }
});

test('the list x button routes through the confirming removePlantBlock (no direct Store delete in the handler)', () => {
  const src = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  assert.ok(src.includes('void Plant.removePlantBlock(rm.dataset.blockId!)'));
});
