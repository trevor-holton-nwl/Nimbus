// Tests for frontend/master-data/admin-ui.mjs (Plant, ProdLines, MasterData).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Plant, ProdLines, MasterData } from '../../../frontend/master-data/admin-ui.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Modal, Toast } from '../../../frontend/platform/foundation.mjs';

test('Plant/ProdLines expose their documented public API', () => {
  assert.equal(typeof Plant.init, 'function');
  assert.equal(typeof Plant.gotoTab, 'function');
  assert.equal(typeof Plant._renderSettingsPane, 'function', 'App._renderSettingsPane was relocated bodily onto Plant in Task 1 — must land here');
  assert.equal(typeof ProdLines.render, 'function');
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
  const list = { innerHTML: '', style: {} };
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
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    Store.replacePlantBlocks(priorBlocks, 'test-restore');
    Store.setSelectedPlant(priorPlant, 'test-restore');
  }
});

test('Plant blackout delete ignores an ID that belongs to another plant', () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorPlant = Store.selectedPlant;
  const priorBlocks = Store.plantBlocks;
  const originalDelete = CalendarSync.savePlantBlackoutDelete;
  let deleteCalls = 0;
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
    Plant.removePlantBlock(block.id);
    assert.deepEqual(Store.plantBlocks, [block]);
    assert.equal(deleteCalls, 0);
  } finally {
    CalendarSync.savePlantBlackoutDelete = originalDelete;
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
