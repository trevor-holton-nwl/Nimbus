#!/usr/bin/env node
// Micro-benchmark: resolveSetup through a prebuilt index on a value-default-only plant
// (200 states, ~200 prt01 defaults, 10 colorWheel defaults, zero matrix rows).
import { performance } from 'node:perf_hooks';
import { buildSetupResolutionIndex, resolveSetup, stateForOrder } from '../frontend/setup/setup-domain.mjs';

const size = 200;
const repeats = Number(process.argv[2] ?? 20);
const definition = { plant: 'P0', fields: ['prt01', 'colorWheel'], signature_version: 1, strict_blanks: true, active: true };
const states = Array.from({ length: size }, (_, i) => stateForOrder({ PRT_01: `TOOL ${i}`, COLOR: `COLOR ${i % 10}` }, definition));
const valueDefaults = [];
for (let i = 0; i < size; i++) valueDefaults.push({ field_key: 'prt01', value: `TOOL ${i}`, setup_min: 5 + i % 50, signature_version: 1 });
for (let i = 0; i < 10; i++) valueDefaults.push({ field_key: 'colorWheel', value: `COLOR ${i}`, setup_min: 3 + i, signature_version: 1 });
const data = { definition, plantRows: [], machineRows: [], overrides: [], valueDefaults };
const index = buildSetupResolutionIndex(data);
// One reused input object: only the two states change per call, so the harness adds no per-call allocation.
const input = { ...data, index, machine: 'LINE 0', predecessorOrderId: 'P', successorOrderId: 'S', predecessorState: states[0], successorState: states[1] };
const run = () => {
  let acc = 0;
  for (let f = 0; f < size; f++) for (let t = 0; t < size; t++) {
    if (f === t) continue;
    input.predecessorState = states[f]; input.successorState = states[t];
    acc += resolveSetup(input).effectiveMin ?? 0;
  }
  return acc;
};
run(); // warm-up
const resolves = size * (size - 1) * repeats;
const best = [];
let checksum = 0;
for (let round = 0; round < 5; round++) {
  const t0 = performance.now();
  for (let r = 0; r < repeats; r++) checksum = run();
  best.push((performance.now() - t0) * 1e6 / resolves);
}
console.log(`resolves/round=${resolves} checksum=${checksum} ns/resolve rounds=[${best.map(n => n.toFixed(0)).join(', ')}] min=${Math.min(...best).toFixed(0)}`);
