// Subprocess probe for utilization-cache.test.mjs: run with TZ set to a zone whose DST change skips local midnight
// (e.g. America/Santiago). Compares a window sliced from a cached 14-day matrix with a fresh compute of the same window.
// Usage: node utilization-dst-probe.mjs <repoRoot> <year> <month0> <day>   -> prints {"mismatches":n,"slices":n,"hits":n}
import { createRequire } from 'node:module';
const ROOT = process.argv[2];
const require = createRequire(ROOT + '/package.json');
globalThis.NimbusComputeCore = require(ROOT + '/frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ needs_review: 0, changed: 0, problems: 0 }) });
const url = p => new URL('file:///' + (ROOT + p).replace(/\\/g, '/')).href;
const { Utilization } = await import(url('/frontend/insights/services.mjs'));
const { Store } = await import(url('/frontend/platform/store.mjs'));
const { Util } = await import(url('/frontend/platform/foundation.mjs'));

const PLANT = 'DST-P';
Store.setMasterData({ plants: [{ plant: PLANT }], lines: [{ plant: PLANT, machine: 'L1' }, { plant: PLANT, machine: 'L-IDLE' }] }, 't');
const year = Number(process.argv[3]), mon = Number(process.argv[4]), dd = Number(process.argv[5]);
const at = (o, h) => new Date(year, mon, dd + o, h);
const mk = (id, line, s, e) => ({ id, PLANT, MACHINE: line, RUN_TIME: 4, start_date: s, end_date: e });
Store.setTasks([mk('a', 'L1', at(1, 20), at(2, 6)), mk('b', 'L1', at(3, 1), at(3, 5)), mk('c', 'L1', at(8, 23), at(9, 3))], 't');
Store.setSelectedPlant(PLANT, 't');
const start = Util.startOfDay(new Date(year, mon, dd));
const strip = m => JSON.stringify(Object.fromEntries(Object.entries(m).map(([l, r]) => [l, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v, tasks: v.tasks.map(t => t.id) }]))])));
let mismatches = 0, slices = 0, hits = 0;
for (let off = 0; off < 10; off++) {
  for (const len of [1, 3, 4]) {
    Utilization._cacheClear();
    Utilization.computeMatrix(start, 14);
    const s = new Date(start); s.setDate(start.getDate() + off);
    const sliced = Utilization.computeMatrix(s, len);
    if (Utilization._cacheEntries().length === 1) hits++;
    Utilization._cacheClear();
    const fresh = Utilization.computeMatrix(s, len);
    slices++;
    if (strip(sliced) !== strip(fresh)) mismatches++;
  }
}
console.log(JSON.stringify({ mismatches, slices, hits }));
process.exit(0);
