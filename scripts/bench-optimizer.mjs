#!/usr/bin/env node

import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../frontend/nimbus-compute-core.js');

import * as SetupScheduler from '../frontend/optimization/setup-scheduler.mjs';

// Mulberry32 seeded PRNG for reproducibility
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

// Parse CLI arguments
const args = new Map();
process.argv.slice(2).forEach((arg, i, arr) => {
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const value = i + 1 < arr.length && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
    args.set(key, value);
  }
});

const targetShape = args.get('shape') || null;
const targetMode = args.get('mode') || null;
const seed = parseInt(args.get('seed') || '42', 10);

// Constants
const SHAPES = {
  small: { lines: 5, ordersPerLine: 12, colors: 4 },
  medium: { lines: 10, ordersPerLine: 36, colors: 8 },
  wide: { lines: 70, ordersPerLine: 8, colors: 4 },
  large: { lines: 70, ordersPerLine: 30, colors: 6 },
};

const MODES = ['min-changeover', 'due-date', 'spt'];

// Local wall-clock time: the calendar and the engine work in naive local dates.
const NOW = new Date(2026, 7, 3, 8, 0, 0).getTime();
const HORIZON_MS = 28 * 24 * 60 * 60 * 1000;
const HORIZON_END = NOW + HORIZON_MS;

// Calendar: weekday 06:00-22:00, sat 06:00-14:00, sun closed
function makeCalendar() {
  return Object.fromEntries(
    Array.from({ length: 7 }, (_, day) => [
      day,
      day === 0 ? null :           // Sunday closed
      day === 6 ? [6, 14] :        // Saturday 06:00-14:00
      [6, 22]                      // Weekday 06:00-22:00
    ])
  );
}

// Generate blackout blocks: 2-3 four-hour blocks per line per run.
// Block shape is { plant, line, start, end } (what lineBlocksFor reads).
function makeBlackouts(rng, plant, line) {
  const count = 2 + Math.floor(rng() * 2); // 2 or 3
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const dayOffset = Math.floor(rng() * 28); // 0-27 days ahead
    const start = new Date(NOW + dayOffset * 24 * 60 * 60 * 1000); // 08:00 local
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    blocks.push({ plant, line, start, end });
  }
  return blocks;
}

// Generate an order
function makeOrder(rng, id, plant, line, colors, due) {
  const runtimeHours = 0.5 + rng() * 7.5; // 0.5-8 hours
  const colorIdx = Math.floor(rng() * colors.length);
  const dueTime = due + (rng() * HORIZON_MS - HORIZON_MS * 0.5); // ±50% of horizon
  return {
    id,
    PLANT: plant,
    plant,
    MACHINE: line,
    RUN_TIME: runtimeHours,
    COLOR: colors[colorIdx],
    original_end_date: new Date(dueTime),
    start_date: null,
    end_date: null,
    original_start_date: null,
    BASIC_START_DATE: null,
    BASIC_FINISH_DATE: null,
    firmed: false,
    row_version: null,
    planning_status: 'needs_planning',
  };
}

// Build synthetic plant. Every order starts queued; makeInitialSchedule() then
// lays a calendar- and setup-valid current schedule down from "now" and
// re-queues ~20% of the orders. Hand-placed dates that ignore the calendar,
// blackouts and setup gaps fail final validation, which silently un-schedules
// the tail lines and wrecks lateness.
function makePlant(rng, shape, colors) {
  const lines = [];
  for (let i = 0; i < shape.lines; i++) {
    lines.push({ plant: 'P1', machine: `L${i + 1}` });
  }

  const tasks = [];
  const blocks = [];
  let taskId = 1;

  for (let lineIdx = 0; lineIdx < shape.lines; lineIdx++) {
    const line = `L${lineIdx + 1}`;
    blocks.push(...makeBlackouts(rng, 'P1', line));
    for (let orderIdx = 0; orderIdx < shape.ordersPerLine; orderIdx++) {
      tasks.push(makeOrder(rng, `O${taskId}`, 'P1', line, colors, NOW + HORIZON_MS / 2));
      taskId += 1;
    }
  }

  return { tasks, blocks, lines };
}

// Current schedule: run SPT-with-setup (generous budget) over the all-queued plant
// so every order gets a valid back-to-back placement from now, then re-queue 20%.
function makeInitialSchedule(rng, plant, setup, colors) {
  const snapshot = makeSnapshot(plant, setup, colors);
  const bounds = makeBounds(setup);
  bounds.deadline = performance.now() + 10 * 60 * 1000;
  bounds.iterationCap = 1e9;
  const result = SetupScheduler.evaluateSptWithSetup(snapshot, bounds);
  const placed = SetupScheduler.applyPatchesToSnapshot(plant.tasks, result.patches);
  plant.tasks = placed.map(task => {
    const scheduled = task.planning_status === 'scheduled' && task.start_date && task.end_date;
    if (scheduled && rng() >= 0.2) return task;
    return {
      ...task, start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning',
    };
  });
}

// Build setup truth: full color-pair matrix
function makeSetupTruth(colors, numLines) {
  const rows = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = 0; j < colors.length; j++) {
      if (i !== j) {
        const minutes = 30 + Math.floor((colors.length + i + j) * (90 / colors.length)) % 91; // 30-120
        rows.push({
          machine: '',
          signature_version: 1,
          from_key: [{ fieldKey: 'colorWheel', value: colors[i] }],
          to_key: [{ fieldKey: 'colorWheel', value: colors[j] }],
          setup_min: minutes,
        });
      }
    }
  }

  const machineStates = [];
  for (let i = 0; i < numLines; i++) {
    machineStates.push({
      machine: `L${i + 1}`,
      state_key: [{ fieldKey: 'colorWheel', value: colors[0] }],
      signature_version: 1,
      source: 'test',
      reason: 'test-generated',
    });
  }

  return {
    plant: 'P1',
    definition: {
      plant: 'P1',
      fields: ['colorWheel'],
      signature_version: 1,
      strict_blanks: true,
      active: true,
    },
    plant_rows: rows,
    machine_rows: [],
    machine_states: machineStates,
    overrides: [],
  };
}

// Build snapshot
function makeSnapshot(plant, setup, colors) {
  const calendar = makeCalendar();
  const calendars = Object.fromEntries(plant.lines.map(l => [l.machine, { workHours: calendar }]));

  return {
    tasks: plant.tasks,
    firmedIds: [],
    alerts: [],
    selectedPlant: 'P1',
    blocks: plant.blocks,
    plantBlocks: [],
    calendars,
    plants: {
      P1: {
        workHours: calendar,
        setup_active: true,
      },
    },
    lineSettings: {},
    masterData: {
      plants: [
        {
          plant: 'P1',
          setup_active: true,
          min_productive_segment_minutes: 30,
        },
      ],
      lines: plant.lines,
    },
    priorityRankMaps: {
      P1: colors.reduce((acc, color, idx) => {
        acc[color] = idx;
        return acc;
      }, {}),
    },
  };
}

// Build bounds for evaluation
function makeBounds(setup) {
  const now = new Date(NOW);
  const horizonEnd = new Date(HORIZON_END);
  return {
    setup,
    exactSearchThreshold: 8,
    iterationCap: 20000,
    clock: () => performance.now(),
    deadline: performance.now() + 5000, // 5 second budget
    now,
    planningStart: now,
    runNow: now,
    placementStart: now,
    horizonEnd,
    respectCalendar: true,
    notBefore: () => now,
    notAfter: () => horizonEnd,
    convergenceWindow: 2000,
  };
}

// Lines searched vs tail-only, from the explanation codes. A line that got a real
// search emits 'due-date-first-placement' for the orders it placed; a line laid
// out as a tail (iteration-cap / deadline / unknown setup) emits only
// 'unknown-setup-tail-placement' / 'unknown-setup-tail-unplaced'.
function countLinesSearched(result, shape) {
  const searchedLines = new Set();
  for (const entry of result.explanation) {
    if (entry.code === 'due-date-first-placement' && entry.line) searchedLines.add(entry.line);
  }
  const searched = searchedLines.size;
  return { searched, tailOnly: Math.max(0, shape.lines - searched) };
}

// Count late orders and lateness minutes
function countLateness(result) {
  if (!result.objective) return { lateCount: 0, lateMinutes: 0 };

  return {
    lateCount: result.objective.lateCount || 0,
    lateMinutes: Math.round(result.objective.latenessMinutes || 0),
  };
}

// Format seconds as fixed 2 decimals with "s"
function formatTime(ms) {
  return (ms / 1000).toFixed(2) + ' s';
}

// Main benchmark
async function benchmark() {
  const results = [];

  for (const [shapeName, shapeConfig] of Object.entries(SHAPES)) {
    if (targetShape && shapeName !== targetShape) continue;

    // One plant per (shape, seed), shared by every mode so modes are comparable.
    const colors = Array.from({ length: shapeConfig.colors }, (_, i) => `COLOR${i + 1}`);
    const rng = mulberry32(seed);
    const plant = makePlant(rng, shapeConfig, colors);
    const setup = makeSetupTruth(colors, shapeConfig.lines);
    makeInitialSchedule(rng, plant, setup, colors);

    for (const mode of MODES) {
      if (targetMode && mode !== targetMode) continue;
      // Fresh deep copies per mode so one evaluator can never leave state behind
      // (caches, mutated tasks) that skews the next mode's timing.
      const snapshot = makeSnapshot(structuredClone(plant), structuredClone(setup), colors);
      const bounds = makeBounds(setup);

      // Run evaluator
      const startTime = performance.now();
      let result;
      try {
        if (mode === 'min-changeover') {
          result = SetupScheduler.evaluateMinChangeover(snapshot, bounds);
        } else if (mode === 'due-date') {
          result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds, 'due-date');
        } else {
          result = SetupScheduler.evaluateSptWithSetup(snapshot, bounds);
        }
      } catch (e) {
        console.error(`Error running ${shapeName}/${mode}:`, e.message);
        continue;
      }
      // Lines searched / termination / candidates come from the search result.
      // The engine (Engine.evaluateSetupAware) then runs one 1-second gap-fill pass
      // that re-inserts orders final validation bounced; late/setup are read from
      // that final candidate's objective facts.
      const searchResult = result;
      result = SetupScheduler.fillPlanningGaps(snapshot, bounds, searchResult);
      const elapsedMs = performance.now() - startTime;

      // Extract metrics
      const { searched, tailOnly } = countLinesSearched(searchResult, shapeConfig);
      const { lateCount, lateMinutes } = countLateness(result);
      const setupMinutes = Math.round(result.objective?.setupMinutes || 0);
      const candidates = searchResult.diagnostics?.candidateCount ?? 0;
      const termination = searchResult.diagnostics?.termination ?? 'unknown';

      results.push({
        shape: shapeName,
        mode,
        wallMs: elapsedMs,
        termination,
        candidates,
        searched,
        tailOnly,
        lateCount,
        lateMinutes,
        setupMinutes,
      });

      process.stdout.write('.');
    }
  }

  console.log('\n');
  console.log(`Benchmark Results (seed ${seed})`);
  console.log('============================\n');

  // Print header
  console.log(
    'Shape                Mode                 Wall      Termination      Candidates  Lines  Late     Late min  Setup min'
  );
  console.log(
    '─────────────────────────────────────────────────────────────────────────────────────────────────────────────────'
  );

  // Print rows
  for (const r of results) {
    const shapeStr = r.shape.padEnd(19);
    const modeStr = r.mode.padEnd(20);
    const wallStr = formatTime(r.wallMs).padStart(8);
    const termStr = r.termination.padEnd(16);
    const candStr = String(r.candidates).padStart(11);
    const linesStr = `${r.searched}/${r.tailOnly}`.padStart(6);
    const lateStr = String(r.lateCount).padStart(8);
    const lateMinStr = String(r.lateMinutes).padStart(10);
    const setupStr = String(r.setupMinutes).padStart(10);

    console.log(
      `${shapeStr} ${modeStr} ${wallStr} ${termStr} ${candStr} ${linesStr} ${lateStr} ${lateMinStr} ${setupStr}`
    );
  }
}

benchmark().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
