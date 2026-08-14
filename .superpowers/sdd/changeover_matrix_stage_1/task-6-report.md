# Task 6 report — drag and manual reflow setup awareness

## Delivered behavior

- `Engine.autoReflow` remains a single deterministic forward walk. It leaves the direct manual drop unchanged, reserves a covered transition before each downstream peer that needs to move, preserves order, and stops at an immutable fixed/aged boundary. Uncovered/unknown setup remains observational rather than inventing capacity.
- `Timeline.rebuildSetupForLines(lines)` derives, diffs, and flushes only setup items on the supplied source/target lines. Existing production item patching is unchanged.
- The drag animation callback only dims existing setup items on newly affected source/target lines. It performs no setup resolution or rebuild. Drop/cancel funnels through `finishSetupDrag`, which batches the affected-line setup rebuild once.
- No API, schema, persistence, activation, optimizer-policy, or end-user-documentation changes were made.

## TDD evidence

RED (before implementation/build):

```text
node --test tests/modules/schedule-services.test.mjs tests/modules/schedule-workbench.test.mjs
FAIL Engine.autoReflow reserves a covered incoming setup before moving a downstream peer
  expected 2026-08-17T09:30, actual 2026-08-17T09:15
FAIL Timeline.rebuildSetupForLines ...
  TypeError: Timeline.rebuildSetupForLines is not a function
```

GREEN:

```text
npm run build
node --test --test-concurrency=1 tests/modules/schedule-services.test.mjs tests/modules/schedule-workbench.test.mjs
90 pass, 0 fail
```

The new service regression proves a covered RED→BLUE transition reserves 30 minutes before the downstream order while retaining the directly placed RED order. The workbench regression proves a stale setup item is removed in one affected-line batch without touching setup on another line.

## Performance measurement design

`PerfMonitor` now records `Timeline.setup.derive`, `Timeline.setup.diff`, and `Timeline.setup.redraw` around the affected-line operation. Existing `Worker.setupClone:<type>` and `Worker.postClone:<type>` measurements remain the worker-clone instrumentation; no numeric budget or activation threshold was invented.

Representative plant-level browser benchmarks (positive setup density, rapid cross-line multi-drag, split-order/cancel) were not available in this isolated test run. Therefore this task makes no activation change; plant activation must remain disabled until those measurements are recorded against the Stage 0 accepted interaction budget.

## Self-review

- Setup remains derived/non-business and is not persisted.
- Direct drops are never reverted or moved to make incoming setup feasible; shortfall diagnostics continue to come from the derived observation path.
- The reflow path does not invoke optimizer candidate evaluation.
- Existing full timeline behavior for segmented-order regeneration is left intact; Task 6's new setup operation itself is strictly line-scoped.
