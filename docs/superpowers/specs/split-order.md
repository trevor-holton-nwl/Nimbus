# Split Orders: Follow-on Design Brief

**Date:** 2026-08-12

**Status:** Approved design decisions; pending written-spec review and a separate implementation plan

**Relationship:** Adds a policy-controlled segmented alternative to Remove Backlog's temporary overlong continuous-bar exception; the `never` policy deliberately retains that exception

## Problem

NIMBUS currently represents one production order as one continuous `start_date -> end_date` interval. That model cannot truthfully show an order that consumes 12 operating hours today and resumes for 2 operating hours tomorrow. A single 14-hour bar either crosses closed time as if it were productive or loses the relationship between elapsed time and actual runtime.

Split-order support must preserve one logical production order while representing its productive schedule as multiple intervals separated by non-operating time.

## First-phase goals

- Allow one logical order to have multiple ordered schedule segments.
- Keep all segments on the same production line.
- Require segment productive durations to sum to the order's `RUN_TIME`.
- Treat gaps between segments as nonproductive time.
- Keep the order as one row in the Orders grid.
- Render its schedule as visually connected Gantt pieces.
- Persist segments durably and update them atomically.
- Make preview, Apply, Discard, Undo, autosave, and optimistic concurrency segment-aware.
- Make capacity, overlap, blackout, and utilization calculations consume segments rather than the parent's elapsed envelope.
- Let all four optimization strategies use the plant's split-order policy when placing orders.

## First-phase non-goals

- Splitting one order across production lines.
- Per-segment quantities, confirmations, scrap, or completion state.
- MES progress integration.
- SAP write-back of segments.
- Independent material, priority, due date, notes, or fixed status per segment.
- Automatic setup/changeover orders between two segments of the same order.
- Arbitrary manual editing of individual segment dates.
- Treating segments as independent selectable production orders.

These exclusions keep phase 1 focused on interruption-aware scheduling rather than turning one order into multiple operational orders.

## Domain model

The parent order remains authoritative for identity and business attributes:

- Production order and material
- Plant and production line
- Basic and due dates
- Priority attributes
- Notes and dependencies
- Fixed status
- `RUN_TIME`

A split schedule adds an ordered list of child intervals:

```ts
interface OrderScheduleSegment {
  orderId: string;
  sequence: number;
  startDate: Date;
  endDate: Date;
}
```

Invariants for a valid schedule:

1. Every segment has `startDate < endDate`.
2. Segments are ordered, non-overlapping, and on the parent's line.
3. The sum of segment durations equals canonical `RUN_TIME` minutes exactly.
4. Parent `start_date` equals the first segment start.
5. Parent `end_date` equals the last segment end.
6. Parent elapsed span may exceed `RUN_TIME`; only segments represent productive duration.
7. Fixed status applies atomically to the entire parent and every segment.
8. A single continuous order remains representable without explicit child rows for backward compatibility.

The parent dates are an envelope for compatibility and display. Capacity and conflict logic must never interpret the full envelope as productive time when segments exist.

Convert `RUN_TIME` once to canonical integer productive minutes before allocation. A valid schedule's interval total must equal that exact value; do not combine an exact invariant with a separate rounding tolerance.

## Schedule authority and ingest lifecycle

Basic dates seed the NIMBUS schedule only when an order first enters the system. After that initial creation:

- NIMBUS `start_date`, `end_date`, and any schedule segments are authoritative.
- Changes to `BASIC_START_DATE` or `BASIC_FINISH_DATE` update reference fields only. They never reset NIMBUS schedule fields or segments.
- Incoming source dates and ordinary attribute refreshes do not overwrite an existing NIMBUS schedule.
- NIMBUS timing changes only through a planner's scheduling action, a scheduling heuristic, or timing-relevant master data such as `RUN_TIME`.

When `RUN_TIME` changes, preserve the authoritative NIMBUS scheduled start and regenerate the complete schedule forward from that point using the assigned line, current effective calendar, plant split policy, and fixed 30-minute minimum. The order remains fixed if it was fixed; fixed status does not prevent this timing correction.

If regeneration fails, accept the authoritative runtime update but preserve the last valid schedule aggregate and raise a critical **runtime/schedule mismatch**. Derive this condition by comparing canonical `RUN_TIME` minutes with productive minutes from `scheduleIntervals(task)`. The mismatch remains visible until a planner action or heuristic successfully regenerates the order. The system must never silently claim that the old intervals represent the new runtime.

## Persistence recommendation

Use a normalized child table rather than JSON stored on `orders` or browser-only derived state.

Conceptual schema:

```sql
CREATE TABLE order_schedule_segments (
    order_id       TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    segment_no     INTEGER NOT NULL,
    scheduled_start TIMESTAMP NOT NULL,
    scheduled_end   TIMESTAMP NOT NULL,
    PRIMARY KEY (order_id, segment_no),
    CHECK (scheduled_end > scheduled_start)
);
```

The final migration should follow repository conventions and validate the exact parent key before implementation. NIMBUS's known global task-ID limitation remains a separate migration concern; this feature must not invent a second order identity.

Write the parent envelope dates and its complete segment set in one database transaction. Use the parent's existing schedule version as the aggregate optimistic-concurrency token so two users cannot independently overwrite different pieces of the same logical order.

Compatibility rule:

- No segment rows: use the existing continuous parent interval.
- Two or more segment rows: use segments for productive scheduling; parent dates are the envelope.
- Do not persist a one-row segment list merely to duplicate the legacy parent fields.

`GET /tasks` should load segments in a batch or aggregate query, not one query per order.

Store the split-order policy with the existing per-plant optimization constraints and manage it in the plant's Optimization settings. It is plant-scoped, not global, and must be retrieved without loading configuration for all target-scale plants. A missing or unrecognized value resolves to `never`, making schema rollout backward-compatible for every existing plant.

## Frontend representation

Add an optional `scheduleSegments` collection to `NimbusTask`. Introduce one shared helper as the source of truth:

```ts
scheduleIntervals(task): Array<{ start: Date; end: Date }>
```

It returns explicit segments for a split order and otherwise returns the legacy parent interval. Every compute or display path that needs productive intervals should use this helper.

### Gantt

- Render each segment as a separate timeline item with an internal segment ID.
- Map selection, hover, context menu, notes, and inspector actions back to the parent task ID.
- Give all pieces a shared visual identity and a subtle continuation treatment.
- Show segment position and productive duration in the tooltip, for example `Segment 1 of 2 - 12h`.
- Selecting one piece selects the complete logical order.

The first phase does not permit dragging one segment independently. Any supported move operates on the logical order and regenerates its calendar allocation atomically.

Dragging any segment requests a new first start for the complete logical order. Regenerate all segments forward from that requested start using the plant's current policy and calendar; do not shift old pieces by a wall-clock delta or preserve their old gaps.

### Orders grid and inspector

- Keep one parent row.
- Display scheduled start as the first segment start and scheduled end as the last segment end.
- Display `RUN_TIME` as productive duration, not envelope duration.
- Add a read-only segment summary when an order is split.
- Editing line, runtime, or scheduled start invalidates/regenerates segments through an explicit scheduling action; never leave stale segments silently attached.
- Treat parent scheduled end as derived from allocation. It cannot be edited independently for a split order.

## Compute integration

Segment awareness is cross-cutting and must be completed as one coherent phase. Update:

- Timeline rendering
- Alerts and overlap detection
- Closed-hours and blackout checks
- Utilization matrices and daily scheduled hours
- Optimizer-preview KPIs and schedule span
- Dashboard changeover and cell drill-down where intervals matter
- Printing/export of schedule dates
- Persistence cache serialization/hydration
- Undo/Sandbox snapshots
- Multi-user refresh and optimistic concurrency

Overlap and capacity calculations operate on each productive segment. The parent envelope must not create a false overnight overload or blackout violation.

Dependencies remain attached to the logical order. Predecessor completion means the final segment end, successor start means the first segment start, and dependency lag is measured between those parent boundary events. Internal segment gaps never satisfy or reset a dependency.

Treat a split order as one sequence occurrence for setup and changeover calculations:

- Do not count a setup or changeover between two segments of the same parent.
- Count the inbound transition before the first segment and the outbound transition after the final segment.
- Count the parent only once in sequence and changeover KPIs.
- Do not insert another order between a parent's segments in phase 1. Each heuristic may choose the parent sequence, but placement of that parent remains atomic.

## Plant split-order policy

Add one authoritative plant-level optimization setting with no per-run override:

```ts
type SplitOrderPolicy = 'never' | 'overlong_only' | 'partial_allowed';
```

Display the effective policy read-only in optimization preview and record it in the applied-run audit. A later plant-policy change must not make a historical result inexplicable.

### `never`

Use each strategy's existing continuous-placement behavior. This is the compatibility/off path and must not change results for the three existing optimization strategies. Remove Backlog retains its already-approved behavior for an inherently overlong order: start at the next valid operating instant, draw one continuous bar through closed time, and report the calendar exception.

### `overlong_only`

An order is **inherently overlong** when its canonical `RUN_TIME` exceeds the longest uninterrupted interval in the normal effective plant-hours and line-hours intersection for its assigned line. Temporary dated blackouts do not change that classification. A line with no normal operating interval produces a calendar error rather than an overlong classification.

Only inherently overlong orders may be segmented. An ordinarily fittable order that lacks enough time in the current interval moves intact to the next sufficiently large valid interval, even if a partial interval is currently available.

### `partial_allowed`

Any order placed by a heuristic may consume a valid partial operating interval and resume in later valid intervals. This makes all orders eligible for splitting; it does not mean every order is split. If the complete runtime fits in one interval, keep it continuous.

All four optimization strategies must honor the policy during placement. Their existing sorting, priority, fixed-order, and sequencing semantics remain unchanged. The setting determines only how the selected parent order's runtime is allocated after the strategy chooses its place in sequence.

Changing a plant's policy affects future scheduling actions only. Do not silently collapse, regenerate, or flag previously valid split schedules merely because an administrator changes the policy. When a planner later moves the order or runs a heuristic, regenerate it under the current policy.

## Calendar allocation

Provide a pure policy-aware allocation function:

```text
allocateRuntime(line, earliestStart, runtimeMinutes, effectiveCalendar, splitPolicy)
    -> ordered productive segments | scheduling error
```

Behavior:

1. Find the next available operating instant at or after `earliestStart`.
2. Apply the plant policy: continuous legacy placement for `never`, whole-order placement unless inherently overlong for `overlong_only`, or partial-window allocation for `partial_allowed`.
3. When splitting is permitted, allocate productive time before the next closure or blackout, then resume at the next valid interval until allocated minutes equal `RUN_TIME`.
4. Require every generated segment to be at least 30 minutes. The only shorter schedule allowed is a single unsplit order whose entire runtime is under 30 minutes.
5. Avoid producing a final remainder below 30 minutes. Shorten the preceding segment when doing so leaves valid segments of at least 30 minutes; for example, allocate 40 minutes now and 30 later rather than 45 now and 25 later. If the current interval cannot participate without violating the minimum, skip it.
6. Merge adjacent intervals. If allocation produces only one continuous interval, remove any previous child rows and use the legacy parent-only representation.
7. Use plant-local minute arithmetic, the same plant/line working-hours intersection and blackouts as the scheduling strategy, and the shared named 90-calendar-day search bound.
8. Return all segments without mutating Store so callers can preview safely.

Do not enable any heuristic's segmented placement until the segment model, persistence, calculations, and rendering are segment-aware. Until then Remove Backlog uses its documented continuous-bar exception and the other strategies retain their existing logic.

Calendar or blackout configuration changes do not silently regenerate existing split orders. Existing placements remain, normal calendar-violation alerts identify affected intervals, and a later planner move or heuristic explicitly regenerates them.

For Remove Backlog, the hard `To` boundary continues to use the parent's snapshotted authoritative NIMBUS scheduled start. An eligible parent may have segments and a final end beyond `To`; parents whose snapshotted start is after `To` remain untouched. Detect conflicts with protected orders beyond `To`, report them in preview, and continue to allow Apply as specified by Remove Backlog.

## Atomic operations

All schedule mutations treat the parent and segments as one aggregate:

- Apply/Discard
- Undo/Redo
- Fixed/unfixed
- Delete
- Drag or date edit
- Runtime change
- Line change
- Remote refresh/concurrency conflict

No UI or API may persist only part of a segment set. A failed schedule mutation restores the previous complete schedule aggregate. The one explicit exception is a failed regeneration after an authoritative runtime refresh: persist the new runtime, retain the prior complete schedule aggregate, and expose the derived critical mismatch until repair.

## Delivery sequence

1. Add schema/API/type support and aggregate concurrency tests.
2. Add `scheduleIntervals` and segment-aware persistence/cache hydration.
3. Convert compute core, Alerts, Utilization, and KPI consumers.
4. Render connected Gantt segments and parent-level selection.
5. Add pure, policy-aware calendar runtime allocation.
6. Integrate the allocator with all four optimization strategies while preserving their sequencing behavior and the `never` compatibility path.
7. Add inspector/grid segment summaries and operational diagnostics.

Do not enable segment creation in production until steps 1-4 are complete; otherwise the UI and capacity calculations would disagree about what is scheduled.

## Approved product decisions

### Minimum segment size: fixed at 30 minutes

The minimum is a phase-1 system constant, not another plant setting. Every segment must be at least 30 minutes, except an entire unsplit order whose total runtime is shorter. Tail handling follows the allocation rules above.

### Split creation: heuristic-generated only

Phase 1 has no manual "Split order" action and no independent segment editor. All four scheduling heuristics may generate segments according to the plant policy.

### Drag behavior: regenerate from requested start

Dragging operates on the logical parent and reruns allocation from the requested first start under the plant's current policy and calendar.

### SAP semantics: NIMBUS-only in phase 1

Segments are NIMBUS schedule detail. Phase 1 has no SAP write-back contract and does not model SAP operations or confirmations as segments.

## Error handling

- Reject overlapping, reversed, or out-of-order segments.
- Reject a valid schedule whose canonical productive-minute sum differs from canonical `RUN_TIME` minutes.
- Reject a segment on a different line from its parent.
- Reject partial writes and concurrency-stale aggregate updates.
- Surface an allocation error when the calendar has no future operating interval within the bounded search.
- Preserve the previous valid segment set if regeneration fails.
- Raise a critical runtime/schedule-mismatch diagnostic when a runtime refresh cannot be regenerated.

## Testing

- Two-day 12h + 2h allocation for a 14-hour order.
- Multi-day allocation around weekends, plant blackouts, and line blackouts.
- `never` exactly preserves legacy results for the three existing optimization strategies.
- `never` retains Remove Backlog's reported continuous overlong exception.
- `overlong_only` splits an inherently overlong order but moves an ordinarily fittable order intact.
- `partial_allowed` consumes a usable partial window and resumes later.
- All four strategies preserve their sequencing semantics while honoring the plant policy during placement.
- No generated segment is under 30 minutes except a complete order whose entire runtime is under 30 minutes.
- Tail adjustment produces 40 + 30 minutes rather than 45 + 25 minutes.
- Adjacent output intervals merge and a one-interval result removes obsolete child rows.
- Productive segment sum equals `RUN_TIME`; envelope duration does not.
- Alerts and utilization ignore closed gaps between segments.
- Gantt renders multiple pieces but selection resolves to one parent.
- Grid displays one order row.
- Apply, Discard, Undo, cache reload, and server reload preserve the full segment set.
- Concurrent edits reject the stale aggregate without partial persistence.
- Parent delete cascades to segments.
- Fixed status and dependencies remain parent-level.
- Changeovers are not counted between segments of the same parent.
- A policy change affects future regeneration but does not rewrite existing schedules.
- Calendar changes alert without silently regenerating segments.
- Basic-date refreshes do not overwrite authoritative NIMBUS dates or segments.
- Runtime changes regenerate from the authoritative NIMBUS start; failed regeneration preserves the schedule and raises a critical mismatch.
- Remove Backlog may finish an eligible segmented order after `To` without moving an ineligible protected order.
- Legacy continuous orders behave exactly as before.
- Remove Backlog uses segments instead of its continuous-bar exception when the plant policy permits splitting.

## Acceptance criteria

1. One order can be durably scheduled across two or more valid operating intervals.
2. Productive duration equals `RUN_TIME` while closed gaps consume no capacity.
3. The Gantt communicates continuity without presenting multiple business orders.
4. Grid, selection, notes, dependencies, and fixed status remain parent-level.
5. Every persistence and undo operation is atomic across the parent and all segments.
6. Alerts, utilization, and preview KPIs calculate from productive segments.
7. Existing non-split orders remain backward compatible.
8. Every optimization strategy honors the plant split policy without changing its sequencing semantics.
9. The `never` policy preserves existing strategy behavior and provides a safe compatibility path.
10. Remove Backlog can allocate permitted split orders across calendar intervals without crossing closed time as productive work.
