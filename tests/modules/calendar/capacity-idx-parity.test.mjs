// B14: callers that loop over (line x day) build the blackout-block index once and pass it to
// Calendar.effectiveCapacityHours / dailyCapacityHours. The indexed path must return exactly what the
// per-call path returns, for line blocks, plant-wide blocks, global (line-less) blocks and blocks stamped
// with another plant, across several days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar } from '../../../frontend/calendar/calendar-engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

const allDays = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
const at = (day, h, m = 0) => new Date(2031, 2, day, h, m, 0);   // March 2031, local wall clock

function fixture() {
  Store.setMasterData({
    plants: [{ plant: 'P1' }, { plant: 'P2' }],
    lines: [{ machine: 'L1', plant: 'P1' }, { machine: 'L2', plant: 'P1' }, { machine: 'L3', plant: 'P2' }],
    workcenters: [], tool_inventory: [],
  }, 'unit-test');
  Store.replacePlants({ P1: { workHours: allDays([6, 22]) }, P2: { workHours: allDays([8, 16]) } }, 'unit-test');
  for (const [line, plant] of [['L1', 'P1'], ['L2', 'P1'], ['L3', 'P2']]) {
    Store.setCalendar(line, allDays([0, 24]), 'unit-test');
    Store.setLineSetting(line, { plant }, 'unit-test');
  }
  Store.setLineSetting('L1', { bufferUnit: 'pct', bufferPct: 10 }, 'unit-test');
  Store.setLineSetting('L2', { bufferUnit: 'hours', bufferHours: 1.5 }, 'unit-test');
  Store.replaceBlocks([
    { id: 'b-line',      line: 'L1', plant: 'P1', start: at(3, 9), end: at(3, 11, 30) },
    { id: 'b-line-over', line: 'L1', plant: 'P1', start: at(3, 10), end: at(3, 12) },        // overlaps b-line: union, not a double count
    { id: 'b-no-plant',  line: 'L2', start: at(4, 7), end: at(4, 9) },                         // line block without a plant stamp
    { id: 'b-global',    line: null, plant: 'P1', start: at(5, 12), end: at(5, 14) },         // all lines of P1
    { id: 'b-global-p2', line: null, plant: 'P2', start: at(5, 8), end: at(5, 10) },          // another plant: must not touch P1 lines
    { id: 'b-global-any', line: null, start: at(6, 15), end: at(6, 17) },                     // no plant at all: applies everywhere
    { id: 'b-bad',       line: 'L1', plant: 'P1', start: 'not a date', end: at(3, 12) },     // unparsable: ignored by both paths
  ], 'unit-test');
  Store.replacePlantBlocks([
    { id: 'pb-p1',  plant: 'P1', start: at(7, 6), end: at(7, 10) },
    { id: 'pb-p2',  plant: 'P2', start: at(7, 8), end: at(7, 12) },
    { id: 'pb-any', start: at(8, 20), end: at(8, 22) },
  ], 'unit-test');
}

test('indexed capacity equals the per-call capacity for every line and day (line, plant-wide and global blocks)', () => {
  const prior = { blocks: Store.blocks.slice(), plantBlocks: Store.plantBlocks.slice() };
  try {
    fixture();
    const idx = Calendar._indexCapacityBlocks();
    let compared = 0, positive = 0;
    for (const line of ['L1', 'L2', 'L3']) {
      for (let day = 1; day <= 10; day++) {
        const date = at(day, 0);
        const plain = Calendar.dailyCapacityHours(line, date);
        const indexed = Calendar.dailyCapacityHours(line, date, idx);
        assert.equal(indexed, plain, `dailyCapacityHours ${line} day ${day}`);
        assert.equal(Calendar.effectiveCapacityHours(line, date, idx), Calendar.effectiveCapacityHours(line, date), `effectiveCapacityHours ${line} day ${day}`);
        compared++;
        if (plain > 0) positive++;
      }
    }
    assert.equal(compared, 30);
    assert.ok(positive > 0);
    // The blocks really matter on the days the fixture touches (so the parity is not trivially 16 === 16).
    assert.equal(Calendar.dailyCapacityHours('L1', at(2, 0), idx), 16, 'an untouched day is the plant window (6-22)');
    assert.equal(Calendar.dailyCapacityHours('L1', at(3, 0), idx), 16 - 3, 'overlapping line blocks 9-12 count once');
    assert.equal(Calendar.dailyCapacityHours('L3', at(5, 0), idx), 8 - 2, 'P2 global block applies to P2 only');
    assert.equal(Calendar.dailyCapacityHours('L1', at(5, 0), idx), 16 - 2, 'P1 global block applies to P1 lines only');
    assert.equal(Calendar.effectiveCapacityHours('L2', at(2, 0), idx), 16 - 1.5, 'buffer applies on top of the indexed capacity');
  } finally {
    Store.replaceBlocks(prior.blocks, 'unit-test');
    Store.replacePlantBlocks(prior.plantBlocks, 'unit-test');
  }
});
