// Tests for web/calendar/calendar-sync.mjs, split from
// tests/modules/schedule-data.test.mjs (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-data.mts
// into 3 domain files: scheduling/persistence.mjs, calendar/calendar-sync.mjs,
// security/session.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarSync } from '../../../web/calendar/calendar-sync.mjs';
import { Store } from '../../../web/platform/store.mjs';

test('CalendarSync is exported alongside Persistence with its documented public API', () => {
  assert.equal(typeof CalendarSync.fetchPlantConfig, 'function');
  assert.equal(typeof CalendarSync.savePlantHours, 'function');
  assert.equal(typeof CalendarSync.saveLineBlackoutUpsert, 'function');
  assert.equal(typeof CalendarSync.flushPlant, 'function');
});

test('CalendarSync discards legacy global plant blackout copies instead of fanning them out', () => {
  const priorMasterData = Store.masterData;
  const priorBlocks = Store.plantBlocks;
  const plants = [{ plant: '1006' }, { plant: '5512' }, { plant: '7000' }];
  const start = new Date('2026-08-18T08:00:00');
  const end = new Date('2026-08-18T12:00:00');
  try {
    Store.setMasterData({ plants, lines: [] }, 'test');
    Store.replacePlantBlocks([
      { id: 'legacy', plant: null, start, end, reason: 'old-global' },
      { id: 'legacy::1006', plant: '1006', start, end, reason: 'old-global' },
      { id: 'legacy::5512', plant: '5512', start, end, reason: 'old-global' },
      { id: 'legacy::7000', plant: '7000', start, end, reason: 'old-global' },
      { id: 'real-1006', plant: '1006', start, end, reason: 'plant-local' },
    ], 'test');
    CalendarSync._discardLegacyGlobalPlantBlocks();
    assert.deepEqual(Store.plantBlocks.map(b => b.id), ['real-1006']);
  } finally {
    Store.setMasterData(priorMasterData, 'test-restore');
    Store.replacePlantBlocks(priorBlocks, 'test-restore');
  }
});

test('CalendarSync discards legacy global line blackout copies instead of fanning them out', () => {
  const priorMasterData = Store.masterData;
  const priorBlocks = Store.blocks;
  const plants = [{ plant: '1006' }, { plant: '5512' }, { plant: '7000' }];
  const start = new Date('2026-08-18T08:00:00');
  const end = new Date('2026-08-18T12:00:00');
  try {
    Store.setMasterData({ plants, lines: [] }, 'test');
    Store.replaceBlocks([
      { id: 'legacy-line', plant: null, line: null, start, end, reason: 'old-global' },
      { id: 'legacy-line::1006', plant: '1006', line: null, start, end, reason: 'old-global' },
      { id: 'legacy-line::5512', plant: '5512', line: null, start, end, reason: 'old-global' },
      { id: 'legacy-line::7000', plant: '7000', line: null, start, end, reason: 'old-global' },
      { id: 'real-line', plant: '1006', line: 'LINE-1', start, end, reason: 'line-local' },
    ], 'test');
    CalendarSync._discardLegacyGlobalLineBlocks();
    assert.deepEqual(Store.blocks.map(b => b.id), ['real-line']);
  } finally {
    Store.setMasterData(priorMasterData, 'test-restore');
    Store.replaceBlocks(priorBlocks, 'test-restore');
  }
});
