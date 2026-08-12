# Split Orders: Follow-on Design Brief

**Date:** 2026-08-12

**Status:** Approved follow-on scope; separate implementation plan required

**Relationship:** Replaces the Remove Backlog heuristic's temporary overlong continuous-bar exception

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
- Let Remove Backlog allocate overlong orders across valid calendar intervals.

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

Invariants:

1. Every segment has `startDate < endDate`.
2. Segments are ordered, non-overlapping, and on the parent's line.
3. The sum of segment durations equals `RUN_TIME` to minute precision.
4. Parent `start_date` equals the first segment start.
5. Parent `end_date` equals the last segment end.
6. Parent elapsed span may exceed `RUN_TIME`; only segments represent productive duration.
7. Fixed status applies atomically to the entire parent and every segment.
8. A single continuous order remains representable without explicit child rows for backward compatibility.

The parent dates are an envelope for compatibility and display. Capacity and conflict logic must never interpret the full envelope as productive time when segments exist.

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

### Orders grid and inspector

- Keep one parent row.
- Display scheduled start as the first segment start and scheduled end as the last segment end.
- Display `RUN_TIME` as productive duration, not envelope duration.
- Add a read-only segment summary when an order is split.
- Editing line, runtime, or scheduled start invalidates/regenerates segments through an explicit scheduling action; never leave stale segments silently attached.

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

Dependencies remain attached to the logical order. Unless a later design says otherwise, predecessor completion means the final segment end and successor start means the first segment start.

## Calendar allocation

Provide a pure allocation function:

```text
allocateRuntime(line, earliestStart, runtimeMinutes, effectiveCalendar)
    -> ordered productive segments | scheduling error
```

Behavior:

1. Find the next available operating instant at or after `earliestStart`.
2. Allocate as much remaining runtime as possible before the next closure or blackout.
3. If runtime remains, resume at the next available interval.
4. Continue until allocated productive minutes equal `RUN_TIME`.
5. Never allocate a one-minute fragment merely because one minute remains in a window; the minimum-segment decision below must be resolved first.
6. Return all segments without mutating Store so callers can preview safely.

Remove Backlog will call this allocator only after the segment model, persistence, calculations, and rendering are segment-aware. Until then it uses the documented continuous-bar exception.

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

No UI or API may persist only part of a segment set. A failure restores the previous complete aggregate.

## Delivery sequence

1. Add schema/API/type support and aggregate concurrency tests.
2. Add `scheduleIntervals` and segment-aware persistence/cache hydration.
3. Convert compute core, Alerts, Utilization, and KPI consumers.
4. Render connected Gantt segments and parent-level selection.
5. Add pure calendar runtime allocation.
6. Integrate the allocator with Remove Backlog preview/apply.
7. Add inspector/grid segment summaries and operational diagnostics.

Do not enable segment creation in production until steps 1-4 are complete; otherwise the UI and capacity calculations would disagree about what is scheduled.

## Required product decisions before implementation planning

### Minimum segment size

Decide whether a short remainder at the end of an operating window may become a productive segment. Recommended phase-1 default: require 30 minutes, unless the entire remaining runtime is shorter. This avoids unusable one-minute fragments while still completing genuinely short orders.

### Manual split request

Decide whether phase 1 is generated only by scheduling heuristics or also offers a user action. Recommended phase-1 default: heuristic-generated only. Manual split placement adds validation and interaction complexity without being required to fix the overlong-order case.

### Drag behavior

Decide whether dragging any segment shifts the entire segmented schedule by a wall-clock delta or reruns forward allocation from the new first start. Recommended behavior: rerun allocation from the requested first start so every resulting segment remains calendar-valid.

### SAP semantics

Confirm whether segments are NIMBUS-only schedule detail or must eventually map to SAP operations/capacity requirements. Phase 1 should remain NIMBUS-only and preserve the parent order's existing SAP-facing dates until a write-back contract exists.

## Error handling

- Reject overlapping, reversed, or out-of-order segments.
- Reject a productive-duration sum that differs from `RUN_TIME` beyond one-minute rounding tolerance.
- Reject a segment on a different line from its parent.
- Reject partial writes and concurrency-stale aggregate updates.
- Surface an allocation error when the calendar has no future operating interval within the bounded search.
- Preserve the previous valid segment set if regeneration fails.

## Testing

- Two-day 12h + 2h allocation for a 14-hour order.
- Multi-day allocation around weekends, plant blackouts, and line blackouts.
- Productive segment sum equals `RUN_TIME`; envelope duration does not.
- Alerts and utilization ignore closed gaps between segments.
- Gantt renders multiple pieces but selection resolves to one parent.
- Grid displays one order row.
- Apply, Discard, Undo, cache reload, and server reload preserve the full segment set.
- Concurrent edits reject the stale aggregate without partial persistence.
- Parent delete cascades to segments.
- Fixed status and dependencies remain parent-level.
- Legacy continuous orders behave exactly as before.
- Remove Backlog uses segments instead of its continuous-bar exception once integration is enabled.

## Acceptance criteria

1. One order can be durably scheduled across two or more valid operating intervals.
2. Productive duration equals `RUN_TIME` while closed gaps consume no capacity.
3. The Gantt communicates continuity without presenting multiple business orders.
4. Grid, selection, notes, dependencies, and fixed status remain parent-level.
5. Every persistence and undo operation is atomic across the parent and all segments.
6. Alerts, utilization, and preview KPIs calculate from productive segments.
7. Existing non-split orders remain backward compatible.
8. Remove Backlog can allocate an overlong order across calendar intervals without crossing closed time as productive work.
