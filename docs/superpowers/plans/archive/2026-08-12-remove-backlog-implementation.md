# Remove Backlog Heuristic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add planner-invoked Remove Backlog as the fourth Optimize strategy, shifting past orders forward without resequencing their lines.

**Architecture:** Engine.removeBacklog is a dedicated path that snapshots scheduled starts and applies a forward cursor per line. It returns structured diagnostics retained by OptimizerPreview. The dialog calculates backlog-specific windows and common preview/undo/persistence continues to own mutation lifecycle.

**Tech Stack:** TypeScript ES modules, vanilla DOM, Node built-in test runner.

**Implementation status (2026-08-12):** Complete. Focused verification: `npm run build`, `npm run typecheck`, changed-file ESLint, `tests/modules/remove-backlog.test.mjs`, the workbench module tests, and the legacy-surface contract test. The full suite retains one unrelated pre-existing `Engine.autoReflow` failure.

## Global Constraints

- Run only after an explicit planner action. No time, ingest, or alert trigger may invoke it.
- Use NIMBUS start_date only, never BASIC_START_DATE or BASIC_FINISH_DATE.
- Preserve lines, chronological order, and fixed membership. Do not use sort terms or day-integrity dispatch.
- A normal placement must fully fit one effective continuous working interval; use the existing 90-day search bound.
- From and To inclusively apply to snapshotted starts. An eligible order may finish beyond To; protected later orders do not move.
- A missing or invalid plant IANA timezone blocks the run. One captured plant-wall now is rounded to minute precision.
- Do not implement split-order behavior. Inherently overlong orders remain reported continuous exceptions.

---

### Task 1: Add engine types and calendar slot primitives

**Files:**

- Modify: web/types.mts:222
- Modify: web/schedule-services.mts:126-390
- Create: tests/js/remove-backlog.test.js

**Interfaces:**

- Produce RemoveBacklogDiagnostics with counts/IDs for backlog, moves, fixed moves, invalid runtime, missing starts, overlong orders, calendar failures, and boundary conflicts.
- Produce RemoveBacklogResult as { patches, diagnostics }.
- Produce Calendar.findContiguousSlot(line, from, durationMs), returning slot, overlong, unavailable, or exhausted.

- [ ] **Step 1: Write failing contiguous-placement tests**

~~~js
test('moves a one-minute shift-close overrun to the next working day', () => {
  seedLineCalendar('L1', weekdayHours('08:00', '16:00'));
  const r = Calendar.findContiguousSlot('L1', at('2026-08-12T08:01'), 8 * HOUR);
  assert.equal(r.kind, 'slot');
  assert.equal(+r.start, +at('2026-08-13T08:00'));
});

test('identifies a runtime longer than every nominal operating window', () => {
  seedLineCalendar('L1', weekdayHours('08:00', '16:00'));
  assert.equal(Calendar.findContiguousSlot('L1', at('2026-08-12T08:00'), 9 * HOUR).kind, 'overlong');
});
~~~

- [ ] **Step 2: Verify the new test fails**

Run: node --test tests/js/remove-backlog.test.js

Expected: failure because Calendar.findContiguousSlot is absent.

- [ ] **Step 3: Implement bounded slot search**

~~~ts
findContiguousSlot(line: string, from: Date, durationMs: number): BacklogSlot {
  if (!Calendar.hasNominalWindow(line, from, durationMs)) {
    const start = Calendar.nextOperatingInstant(line, from);
    return start ? { kind: 'overlong', start } : { kind: 'unavailable' };
  }
  const start = Calendar.nextAvailable(line, from, durationMs);
  return Calendar.fitsContinuous(line, start, durationMs)
    ? { kind: 'slot', start }
    : { kind: 'exhausted' };
}
~~~

hasNominalWindow checks the plant/line hours intersection without dated blackouts; fitsContinuous verifies work window and all blackouts so nextAvailable's legacy fallback cannot be mistaken for a valid slot.

- [ ] **Step 4: Verify the calendar tests pass**

Run: node --test tests/js/remove-backlog.test.js

Expected: pass for full fit, blackouts, closed lines, exhaustion, and overlong exception.

- [ ] **Step 5: Commit**

~~~bash
git add web/types.mts web/schedule-services.mts tests/js/remove-backlog.test.js
git commit -m "feat: add backlog calendar slot helpers"
~~~

### Task 2: Implement the snapshot-based forward cascade

**Files:**

- Modify: web/schedule-services.mts:1638-1812
- Modify: tests/js/remove-backlog.test.js

**Interfaces:**

- Consume Engine.removeBacklog({ plant, lines, startDate, endDate, runAt }).
- Produce Engine.lastBacklogResult only for a backlog run.
- Route runAndApply('backlog', opts) directly to removeBacklog before _sortTerms is called.

- [ ] **Step 1: Write failing cascade tests**

~~~js
test('compresses backlogged gaps then stops when a future gap absorbs delay', () => {
  seedTasks([
    task('past-a', 'L1', '2026-08-12T06:00', 2),
    task('past-b', 'L1', '2026-08-12T10:00', 2),
    task('future', 'L1', '2026-08-12T15:00', 1),
  ]);
  const r = Engine.removeBacklog(backlogOpts({ runAt: at('2026-08-12T08:00') }));
  assert.equal(+patch(r, 'past-a').changes.start_date, +at('2026-08-12T08:00'));
  assert.equal(+patch(r, 'past-b').changes.start_date, +at('2026-08-12T10:00'));
  assert.equal(patch(r, 'future'), undefined);
});

test('moves fixed backlog while preserving fixed membership', () => {
  Store.fixedIds.add('fixed-past');
  const r = Engine.removeBacklog(backlogOpts());
  assert.ok(patch(r, 'fixed-past'));
  assert.ok(Store.fixedIds.has('fixed-past'));
});
~~~

- [ ] **Step 2: Verify the new test fails**

Run: node --test tests/js/remove-backlog.test.js

Expected: failure because Engine.removeBacklog is absent.

- [ ] **Step 3: Implement the forward pass**

~~~ts
for (const line of scopedLines) {
  const ordered = eligibleForLine(line).sort(snapshotStartThenId);
  const first = ordered.findIndex(x => x.snapshotStart < now);
  if (first < 0) continue;
  let cursor = now;
  for (const item of ordered.slice(first)) {
    if (item.snapshotStart >= now && +cursor <= +item.snapshotStart) break;
    const candidate = item.snapshotStart < now ? cursor : new Date(Math.max(+item.snapshotStart, +cursor));
    const runtimeMs = validRuntimeMs(item.task);
    if (!runtimeMs) { diagnostics.invalidRuntimeIds.push(item.task.id); continue; }
    const slot = Calendar.findContiguousSlot(line, candidate, runtimeMs);
    if (slot.kind === 'unavailable' || slot.kind === 'exhausted') { recordFailureAndStopLine(); break; }
    patches.push({ id: item.task.id, changes: { start_date: slot.start, end_date: new Date(+slot.start + runtimeMs) } });
    cursor = new Date(+slot.start + runtimeMs);
  }
}
~~~

Validate the plant timezone before grouping. Adapt the injected runAt instant to plant wall time once. Record missing starts before eligibility; runtime skips do not advance cursor. Record overlong placement, fixed movement, largest delay, and conflicts with untouched post-To tasks.

- [ ] **Step 4: Add and run edge-case tests**

~~~js
test('uses RUN_TIME rather than existing duration or basic dates', () => {
  const r = Engine.removeBacklog(backlogOpts());
  assert.equal(+patch(r, 'order').changes.end_date - +patch(r, 'order').changes.start_date, 3 * HOUR);
});
test('does not patch a protected order beyond To but reports the boundary overlap', () => {
  const r = Engine.removeBacklog(backlogOpts({ endDate: at('2026-08-12T12:00') }));
  assert.equal(patch(r, 'protected'), undefined);
  assert.equal(r.diagnostics.boundaryConflicts.length, 1);
});
~~~

Run: node --test tests/js/remove-backlog.test.js

Expected: pass for runtime, never-basic-date, fixed, hard-boundary, closed-line, independent-line, second-run, and timezone cases.

- [ ] **Step 5: Commit**

~~~bash
git add web/schedule-services.mts tests/js/remove-backlog.test.js
git commit -m "feat: add remove backlog scheduling heuristic"
~~~

### Task 3: Expose the fourth strategy and diagnostics in the workflow

**Files:**

- Modify: web/schedule-workbench.mts:6124-6685
- Modify: web/schedule-workbench.mts:6770-7168
- Modify: web/index.html only if strategy markup is static
- Modify: web/locales/en.js, web/locales/de.js, web/locales/es.js, web/locales/fr.js, web/locales/pt.js
- Modify: tests/modules/schedule-workbench.test.mjs

**Interfaces:**

- Consume Engine.lastBacklogResult after Engine.runAndApply.
- Produce OptimizerRunOptions.runAt captured immediately before preview.
- Produce OptimizerPreview._backlogResult, cleared together with snapshot state.

- [ ] **Step 1: Write failing UI/module tests**

~~~js
test('OptimizeDialog accepts backlog as its stored default mode', () => {
  Store.setPref('optimizerDefaults', { mode: 'backlog', preset: 'custom' });
  OptimizeDialog.open();
  assert.equal(OptimizeDialog.selectedModeForTest(), 'backlog');
});

test('backlog preview shows a non-blocking boundary warning', () => {
  OptimizerPreview._backlogResult = fakeBacklogResult({ boundaryConflicts: [conflict] });
  OptimizerPreview._render();
  assert.match(previewBody().textContent, /Boundary conflicts/);
  assert.equal(applyButton().disabled, false);
});
~~~

- [ ] **Step 2: Verify the module test fails**

Run: node --test tests/modules/schedule-workbench.test.mjs

Expected: failure because backlog is rejected or diagnostics are absent.

- [ ] **Step 3: Implement mode-specific UX and window defaults**

~~~ts
if (_mode === 'backlog') {
  setCalendarControl({ checked: true, disabled: true, help: 'Required for Remove Backlog' });
  setFixedControl({ disabled: true, help: 'Fixed orders move when reached and remain fixed' });
  if (!_startDirty || !_endDirty) applyBacklogDefaults(_plant, scopedLines, capturedPlantNow());
}
~~~

From is earliest scoped start_date before plant now, or now. To is the earlier of latest scoped end_date and calendar-months(now, 4); if earlier than From, use calendar-months(From, 4). Change only undirtied field values when scope changes. Skip priority-map loading and priority confirmations in backlog mode. Capture runAt, pass it to Engine, and post audit only when Apply occurs with mode/window/timezone/timestamp/counts/applied-with-conflicts.

- [ ] **Step 4: Render structured backlog diagnostics**

~~~ts
const backlogHtml = OptimizerPreview._backlogResult
  ? renderBacklogDiagnostics(OptimizerPreview._backlogResult.diagnostics)
  : '';
body.innerHTML = header + backlogHtml + kpiGrid + footer;
~~~

Include explicit no-backlog/no-change copy, skipped counts, overlong exception count, capacity failures, and a prominent Apply-allowed boundary warning. Existing mode rendering remains unchanged.

- [ ] **Step 5: Verify UI behavior**

Run: node --test tests/modules/schedule-workbench.test.mjs

Expected: pass for saved mode, defaults, option states, no priority rank fetch, diagnostics, Apply, Discard, and Undo.

Run: npm run typecheck

Expected: exit 0.

- [ ] **Step 6: Commit**

~~~bash
git add web/schedule-workbench.mts web/index.html web/locales tests/modules/schedule-workbench.test.mjs
git commit -m "feat: expose remove backlog optimizer mode"
~~~

### Task 4: Perform proportionate verification and record implementation

**Files:**

- Modify: docs/superpowers/specs/2026-08-12-remove-backlog-design.md
- Modify: docs/superpowers/plans/2026-08-12-remove-backlog-implementation.md

- [ ] **Step 1: Run focused tests**

Run: node --test tests/js/remove-backlog.test.js tests/modules/schedule-workbench.test.mjs

Expected: pass.

- [ ] **Step 2: Run focused regression gates**

Run: npm run typecheck

Expected: exit 0.

Run: npm test

Expected: legacy and module test suites pass.

- [ ] **Step 3: Review for scope leakage**

Run: git diff --check

Expected: no whitespace errors.

Run: git diff -- web/schedule-services.mts web/schedule-workbench.mts web/types.mts tests

Expected: no automatic invocation and no legacy heuristic behavior changes.

- [ ] **Step 4: Commit the verification record**

~~~bash
git add docs/superpowers/specs/2026-08-12-remove-backlog-design.md docs/superpowers/plans/2026-08-12-remove-backlog-implementation.md
git commit -m "docs: record remove backlog implementation"
~~~

