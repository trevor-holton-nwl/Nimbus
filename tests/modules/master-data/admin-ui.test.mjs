// Tests for frontend/master-data/admin-ui.mjs (Plant, ProdLines, MasterData).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Plant, ProdLines, MasterData, WorkCenters } from '../../../frontend/master-data/admin-ui.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Modal, Toast, Util } from '../../../frontend/platform/foundation.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';

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

// Bulk-save (paste/cell-edit) to routing_rules should refresh Runtime.load for
// EVERY distinct plant present in the saved rows, not just Store.selectedPlant,
// because routing_rules is NOT in SCOPED_TABLES (its grid shows multiple plants'
// rows simultaneously). The fix extracts distinct plants from upserts and calls
// Runtime.load(plant) for each (mirroring db.py's resolve_fn loop at line 2734).
test('MasterData bulk-save for routing_rules calls Runtime.load for each distinct plant in saved rows', () => {
  const source = readFileSync(new URL('../../../frontend/master-data/admin-ui.mts', import.meta.url), 'utf8');
  // Verify the special case handler for routing_rules exists and extracts distinct plants
  assert.match(source, /if \(table === ['"]routing_rules['"]\)/);
  assert.match(source, /new Set<string>\(\)/);
  assert.match(source, /affectedPlants\.add\(plant\)/);
  assert.match(source, /affectedPlants\.forEach\(\(plant\) => Runtime\.load\(plant\)\)/);
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
  assert.match(source, /\[\.\.\.upserts, \.\.\.deletes\]\.forEach\(\(row\) => \{\s*const plant = row\.plant as string \| undefined;/);
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
