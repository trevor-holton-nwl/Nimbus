# Remove Backlog Heuristic Design

**Date:** 2026-08-12

**Status:** Implemented on `feature/remove-backlog` (2026-08-12); split-order follow-on remains separate.

**Scope:** NIMBUS frontend scheduling engine and Optimize workflow

## Purpose

Add a fourth production-scheduling heuristic, **Remove Backlog**, modeled on SAP APO/PP/DS backlog rescheduling. It moves operations whose current scheduled start lies in the past to the next available present or future slot on their production line.

This is a schedule-repair heuristic, not an optimizer. It must preserve the current sequence and line assignment. It does not consult priority lists, due dates, basic dates, setup attributes, or optimization sort terms.

SAP describes backlog rescheduling as moving past operations on a selected resource to the next possible current or future date/time, with current date/time as the default earliest start. NIMBUS follows that core behavior while adding an explicit mutation window and preview diagnostics.

Remove Backlog is planner-invoked only. NIMBUS must not run it automatically because time passes, an ingest completes, an alert is raised, or the application infers that backlog exists. There is no MES signal on which to base automatic execution; the planner decides when schedule repair is appropriate.

Reference: [SAP Backlog Rescheduling](https://help.sap.com/docs/SAP_SUPPLY_CHAIN_MANAGEMENT/15f45255438149fa996da194295b132b/ec4cc95360267614e10000000a174cb4.html)

## Goals

- Move scheduled orders with `start_date` before plant-local now into valid present or future capacity.
- Preserve the existing chronological order; never reshuffle orders.
- Compress gaps between backlogged orders.
- Push subsequent orders only while the accumulated delay requires it.
- Stop naturally when an existing gap absorbs the delay.
- Respect the intersection of plant and line working calendars and all applicable blackouts.
- Treat the user-selected `From` and `To` values as a hard mutation boundary.
- Move fixed orders when they participate in the cascade without clearing their fixed state.
- Reuse the existing preview, apply/discard, undo, persistence, and audit workflow.

## Non-goals

- Re-ranking or optimizing sequence.
- Changing an order's production line.
- Consulting `BASIC_START_DATE`, `BASIC_FINISH_DATE`, priority lists, due dates, or changeover attributes.
- Inferring whether an order is actually running; NIMBUS has no MES integration.
- Automatically triggering backlog repair from the clock, ingest, alerts, or background processing.
- Splitting one order into multiple Gantt intervals in this phase.
- Repairing unrelated future calendar violations after the backlog delay has been absorbed.
- Mutating orders outside the selected window.

## User Experience

### Fourth strategy

Extend `OptimizerMode` with `backlog` and add **Remove Backlog** as the fourth strategy in the existing Optimize dialog. The existing plant scope, searchable selected-line scope, preview, Apply, Discard, and Undo behaviors remain shared.

Remove Backlog has different option semantics from the three sequencing strategies:

- Calendar adherence is mandatory. Display the calendar option as required and disabled-on.
- Fixed-order protection does not apply. Disable that option and explain that fixed orders may move but remain fixed.
- Do not load priority-rank maps solely for this mode.
- Do not show missing-priority-list confirmations.

The mode may be stored in the user's optimizer defaults like the existing strategies.

### Default window

When the user selects Remove Backlog, initialize the dates for the current plant/line scope:

- **From:** the earliest scheduled `start_date` that is before plant-local now; if none exists, plant-local now.
- **To:** the earlier of the latest scheduled `end_date` in scope and four calendar months after plant-local now.
- If the computed To is earlier than From, use four calendar months after From.

Both values remain editable. Plant or line-scope changes recalculate the defaults until the user manually edits either boundary; afterward, preserve the user's explicit values.

The four-month limit prevents an unexpectedly long default mutation window. It does not prevent the user from selecting a longer period manually.

"Four calendar months" means the same plant-local wall time four months later, clamped to the last valid day when the destination month is shorter.

### Preview

Reuse `OptimizerPreview`, with Remove Backlog-specific results in addition to any shared schedule KPIs:

- Backlogged orders found
- Orders moved
- Fixed orders moved
- Total runtime hours of moved backlog orders
- Largest individual delay
- Orders skipped for invalid runtime
- Orders skipped for missing scheduled start
- Overlong orders placed as continuous calendar exceptions
- Lines or orders that could not find an available calendar slot
- Unresolved overlaps or calendar conflicts at the hard To boundary

Boundary warnings do not disable Apply. The user may intentionally protect the later period and repair the reported conflicts manually.

If the run produces no changes and no actionable exceptions, show a clear no-backlog/no-change result instead of an empty comparison.

## Architecture

`Engine.runAndApply('backlog', opts)` delegates immediately to a dedicated `Engine.removeBacklog(opts)` path. The function returns patches and structured diagnostics; the shared workflow applies patches to `Store` only for the preview simulation, as it does for existing modes.

The backlog path must not call:

- `Engine._sortTerms`
- `Engine._comparator`
- `Engine._dispatchDayIntegrity`
- priority-rank resolution

It may share low-level, calendar-safe availability helpers where their semantics match. Backlog-specific calendar behavior should have a named helper rather than adding mode branches throughout the existing optimizer.

Suggested result shape:

```ts
interface RemoveBacklogResult {
  patches: Array<{ id: string; changes: Partial<NimbusTask> }>;
  diagnostics: {
    backlogFound: number;
    moved: number;
    fixedMoved: number;
    movedRuntimeHours: number;
    largestDelayMinutes: number;
    invalidRuntimeIds: string[];
    missingStartIds: string[];
    overlongIds: string[];
    calendarSearchFailures: Array<{ line: string; taskId?: string; reason: string }>;
    boundaryConflicts: Array<{ line: string; movedTaskId: string; protectedTaskId?: string; type: string }>;
  };
}
```

Exact naming may follow existing TypeScript conventions, but diagnostics must be structured data rather than strings parsed by the UI.

## Scheduling Clock and Timezone

Capture one run timestamp and use it for the entire preview. Resolve plant-local wall time from the selected plant's configured IANA timezone. A missing or invalid timezone blocks Remove Backlog; falling back to the browser timezone would make the result depend on where the planner is located.

NIMBUS currently persists schedule timestamps as naïve wall-clock values. The implementation therefore needs an explicit plant-wall-time adapter for comparisons, day boundaries, calendar lookup, and minute arithmetic. It must not mix raw viewer-local `new Date()` behavior with plant-local calendar decisions. The adapter should expose deterministic helpers and accept an injected run timestamp for tests.

The heuristic's time precision is one minute, matching scheduling snap behavior.

## Eligibility and Ordering

At run start, snapshot each task's current scheduled `start_date`. This is the only field used for window eligibility and chronological ordering.

- Eligible when `From <= snapshot start <= To`.
- Backlogged when eligible and `snapshot start < plant-local now`.
- `BASIC_START_DATE` and `BASIC_FINISH_DATE` are reference fields and are never read.
- A task cannot become newly eligible because an earlier task pushes it across To.
- An eligible task may be placed or finish after To.
- Tasks outside the snapshot window remain untouched.

Process each selected production line independently. Sort eligible tasks by snapshot `start_date`, then by stable task ID for deterministic ties. Do not change line assignments or any non-schedule fields.

## Forward-Cascade Algorithm

For each line:

1. Find the first eligible task whose snapshot start is before plant-local now. If none exists, the line has no backlog and needs no change.
2. Set `cursor` to plant-local now.
3. Walk eligible tasks in their snapshotted chronological order.
4. For every backlogged task, use `cursor` as its earliest candidate. This intentionally compresses historical gaps.
5. For a later task reached by the cascade, use `max(snapshot start, cursor)` as its earliest candidate.
6. Find the next calendar-valid placement at or after that candidate.
7. Preserve duration from `RUN_TIME` and set `end_date = new start + RUN_TIME` for ordinary continuous orders.
8. Advance `cursor` to the updated end.
9. When `cursor <= snapshot start` for a non-backlogged task and its existing placement does not need to move because of this cascade, the existing gap has absorbed the delay. Stop processing the line.
10. Stop before the first task whose snapshotted start falls outside the selected window. Do not mutate it even if an overlap remains.

Conceptual pseudocode:

```text
now = captured plant-local wall time

for each selected line:
    tasks = eligible tasks sorted by snapshot scheduled start
    first_backlog = first task where snapshot_start < now
    if none: continue

    cursor = now
    for task from first_backlog forward:
        if task is outside snapshot window: break

        if snapshot_start < now:
            candidate = cursor                 # compress backlog gaps
        else:
            if cursor <= snapshot_start:
                break                          # a future gap absorbed the delay
            candidate = cursor

        slot = next valid placement(line, candidate, RUN_TIME)
        patch task to slot.start and slot.end
        cursor = slot.end
```

The real implementation also records skips, overlong exceptions, and boundary conflicts.

## Calendar Rules

Effective availability is the intersection of:

- Plant working hours
- Line working hours
- Plant blackout blocks
- Line blackout blocks

For an ordinary order, the full `RUN_TIME` must fit within one continuous available interval. If the order would exceed the interval by even one minute, move the whole order to the next qualifying interval. Do not partially consume the current interval.

The slot search must distinguish these conditions:

1. **Ordinary fit exists:** use the earliest continuous valid slot.
2. **Inherently overlong:** `RUN_TIME` exceeds every nominal daily plant/line operating-window intersection. Place it at the next available operating instant as one continuous bar, allow that bar to cross closed periods, and report the exception.
3. **No operating interval exists:** skip the line and report it; there is no defensible start.
4. **A normally fittable order finds no slot within the bounded search because of extended closures/blackouts:** stop the remaining cascade on that line and report the failure. Do not silently force-place it. Use one named 90-calendar-day search limit, matching the existing `Calendar.nextAvailable` safety bound.

The overlong exception is temporary and deliberately follows the legacy continuous-interval representation. Its full parent interval participates in existing continuous-bar calculations, while closed-hours and calendar alerts identify the violation and preview reports the exception. NIMBUS cannot truthfully account for 12 productive hours today plus 2 productive hours tomorrow without schedule segments. Accurate interruption-aware capacity accounting therefore requires a split-enabled plant policy from `split-order.md`.

## Fixed Orders

Fixed status is not an obstacle in Remove Backlog. If a fixed order is eligible and reached by the cascade, shift it using the same rules as any other order and leave its fixed flag/ID membership unchanged.

This behavior is mode-specific. It does not change how fixed orders behave in SPT, Min Changeover, Smart, drag reflow, or other scheduling paths.

## Hard To Boundary

The selected To value is meaningful because it is a hard mutation boundary based on snapshotted scheduled starts.

- Orders at or before To may move if the cascade reaches them.
- Orders after To never move.
- Eligible orders may end after To.
- A moved eligible order may overlap a protected order or create a calendar conflict beyond the boundary.
- Simulate the final patched schedule, detect those unresolved conditions, and show them prominently in preview.
- Allow Apply despite the warning.

This deliberately favors user control of a protected/fixed period over silently expanding the mutation scope.

## Invalid and Exceptional Data

- Missing scheduled start: exclude and report.
- Missing, zero, negative, non-numeric, or non-finite `RUN_TIME`: skip and report. The skipped task does not advance the cursor; continue with later eligible tasks on that line.
- Missing/invalid plant timezone: block the entire run before mutation.
- No open calendar interval for one line: report that line and continue other lines.
- Calendar search exhaustion on one line: stop that line's remaining cascade and continue other lines.
- Empty plant/line scope or no tasks: reuse existing clear error handling.

One line's problem must not prevent valid lines from producing a preview.

## Persistence, Undo, and Audit

The preview must snapshot all tasks that could be mutated within the selected scope/window. Apply persists the resulting scheduled dates through the existing bulk-update and optimistic-concurrency path. Discard and Undo restore the complete pre-run schedule for every moved task, including fixed tasks.

The applied audit record includes:

- Mode: `backlog`
- Plant and selected lines
- From and To
- Plant timezone and captured run timestamp
- Backlog, moved, fixed-moved, skipped, and overlong counts
- Largest delay
- Boundary-conflict count
- Whether the user applied with unresolved boundary conflicts

Do not describe a discarded preview as an applied optimization run.

## Performance

The heuristic performs one sort per selected line followed by a forward pass and bounded calendar searches. Expected cost is `O(n log n)` for ordering plus slot lookup. It must use plant/line indexes already held by `Store` and per-run calendar caches; it must not scan all 3,500 target-scale lines for a scoped run.

## Testing

### Engine unit tests

- Compress gaps between multiple backlogged orders.
- Preserve chronological sequence and production lines.
- Move a fixed order and retain fixed status.
- Use `RUN_TIME`, not the existing start/end span.
- Never read basic dates.
- Move the entire order to the next day when it exceeds shift close by one minute.
- Honor plant hours, line hours, plant blackouts, and line blackouts.
- Stop when a future gap absorbs the delay.
- Keep tasks after To unchanged and report resulting boundary overlaps.
- Determine eligibility from the run-start schedule snapshot, not updated starts.
- Permit an eligible task to finish after To.
- Apply the overlong continuous-bar exception and report it.
- Skip invalid runtime and missing-start tasks.
- Report fully closed lines and calendar-search exhaustion.
- Process multiple lines independently.
- Produce no patches on a second run after backlog is removed.

### Timezone tests

- Planner browser timezone differs from plant timezone.
- Plant-local now falls on a different calendar date from browser-local now.
- Invalid or missing IANA timezone blocks the run.
- Spring-forward and fall-back transitions produce deterministic plant-wall-time behavior.
- Captured now remains constant throughout one run.

### UI and workflow tests

- Fourth strategy renders and can be saved as a user default.
- Selecting it initializes From/To correctly and applies the four-month cap.
- Scope changes update untouched defaults but do not overwrite manual date edits.
- Calendar/fixed option states and help text match mode semantics.
- No priority-rank fetch/confirmation occurs solely for backlog mode.
- Preview reports every diagnostic category.
- Boundary warnings allow Apply.
- Apply, Discard, and Undo restore expected schedules.
- Audit payload reflects the applied result.
- Backlog detection alone, an ingest, and alert recomputation do not invoke Remove Backlog automatically.

## Acceptance Criteria

1. A user can choose Remove Backlog as the fourth Optimize strategy.
2. A backlogged order is placed no earlier than captured plant-local now.
3. No ordinary moved order crosses an effective calendar closure or blackout.
4. Sequence and line assignment remain unchanged.
5. Backlog gaps compress and downstream gaps absorb delay.
6. Fixed orders move when reached and remain fixed.
7. Orders outside the snapshotted From/To window never mutate.
8. Boundary conflicts are reported and may be knowingly applied.
9. Overlong orders use the documented continuous-bar exception and are reported.
10. Preview, persistence, discard, undo, and audit work through existing NIMBUS workflows.
11. Remove Backlog runs only after an explicit planner action.

## Follow-on

Implement interruption-aware scheduling from `docs/superpowers/specs/split-order.md`. Once available, Remove Backlog honors the plant's authoritative split policy: `never` retains the reported legacy continuous exception, `overlong_only` segments inherently overlong orders, and `partial_allowed` may consume partial operating windows for any eligible order. The policy changes placement representation, not Remove Backlog's sequence-preserving cascade or hard mutation boundary.
