// Tests for web/master-data/admin-ui.mjs (Plant, ProdLines, MasterData).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Plant, ProdLines, MasterData } from '../../../web/master-data/admin-ui.mjs';
import { CalendarSync } from '../../../web/calendar/calendar-sync.mjs';
import { Store } from '../../../web/platform/store.mjs';

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
  const source = readFileSync(new URL('../../../web/master-data/admin-ui.mts', import.meta.url), 'utf8');
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
  const source = readFileSync(new URL('../../../web/master-data/admin-ui.mts', import.meta.url), 'utf8');
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
