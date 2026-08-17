# Setup/Teardown Bars — Historical Functional Design Specification

> **Fully superseded for live feature requirements by `docs/changeover_matrix.md` (2026-08-12).**
> This document remains the best functional description of NIMBUS's pre-feature behavior—Part 1 in
> particular—and the historical record of the earlier setup/teardown debate. Do not read Part 2's
> fork or Open Questions as current decisions.

## Final decision notice (2026-08-12)

`docs/changeover_matrix.md` now fully supersedes this file's live feature requirements. The final design models
one schedule-real setup duration before the successor order; teardown was removed. This file remains the best
functional description of pre-feature NIMBUS—especially Part 1—and a record of the original design fork. Do not
treat Part 2, its open questions, or its setup/teardown split as current requirements.

The resolved decisions are:

- **Setup only:** `previous setup state -> next setup state = setup minutes`.
- **Derived, schedule-real activity:** setup consumes capacity but is never an `orders` row or dependency record.
- **Plant-defined state:** each plant selects one ordered signature such as `PRT_01 + Color` or `Color`; sparse
  line duration overrides inherit plant values.
- **Only safe missing zero:** an absent diagonal row between two valid identical states implies zero. Every
  missing non-diagonal transition is unknown and unavailable to optimization.
- **Actionable coverage:** optimization excludes unknown edges, continues on covered feasible sequences, leaves
  an unresolvable line unchanged, and exposes copyable/exportable missing pairs in preview.
- **Current line state:** represents present physical truth or a clearly labeled derived best guess, not a future
  event timeline. Authorized manual correction is required for unexpected overnight mold changes.
- **Occurrence override:** authorized schedulers may record audited remaining setup for an exact adjacency. The
  override persists, binds to that pair, and protects it during optimization.
- **Split-aware placement:** setup stays contiguous and cannot occupy a block without the split policy's required
  productive segment, fixed at 30 minutes in phase 1. Ordinary downtime preserves state; phase 1 does not
  interleave parents inside a split envelope. Remove Backlog retains its documented continuous overlong exception
  under `never`.
- **Bounded deterministic heuristic:** rules still determine eligibility. Candidate search is private, commits at
  most once, and alert recomputation never triggers another optimization run. A planner's explicit **Fix It** may
  request one bounded run, whose resulting alerts cannot recursively start another.
- **Preview-only explanations:** chosen and rejected alternatives and reasons exist only while preview is open.
- **Separate narrow Gantt bar:** setup precedes production as a derived foreground interval. Affected setup bars
  may temporarily disappear during drag and are recalculated once per affected line after drop. Equivalent setup
  detail remains reachable from the successor order's tooltip/inspector and keyboard path.
- **Deferred shared molds:** individual mold IDs, interchangeable duplicate molds, and exclusive cross-line tool
  reservations are a separate future finite-resource feature; matrix coverage alone does not prove mold
  availability or global schedule feasibility.

See `docs/changeover_matrix.md` for authoritative semantics, persistence, permissions, staging, performance
contracts, and required tests.

## Purpose

This document lays out the current functional model of NIMBUS's Gantt chart and its sequencing
engine, then specifies what it would take to introduce **auto-generated setup and teardown bars**
— visual (and potentially schedule-real) representations of the transition time between two
consecutive orders on the same production line, driven by a tooling-to-tooling transition value.

It is written for a design debate, not an implementation. It avoids referencing specific files or
line numbers; it describes NIMBUS's current behavior functionally, so the reasoning holds even as
the underlying code moves.

## Part 1 — How NIMBUS Represents and Renders Orders Today

### What an order is, functionally

Every bar on the Gantt chart represents exactly one manufacturing order. An order carries, at
minimum: which production line and plant it belongs to, a scheduled start and end time, the
material being run, a run-time duration, and a handful of "priority" attributes used for
sequencing (a color/tooling attribute, two PRT-type attributes, and a production version). Orders
arrive into NIMBUS either through a spreadsheet upload or a SAP synchronization job, and both
paths converge on the same storage and the same shape — there is no separate "SAP order" vs.
"manual order" type once an order exists in the system.

Critically, **there is no stored concept of an order's position in a line's sequence.** An order's
place in line is always computed by sorting orders on a line by their effective start time. This
means "the order immediately before this one" is a derived fact, recomputed on every read, not a
persisted relationship. Any new feature that needs to know adjacency (like setup/teardown bars)
inherits this: adjacency must be computed, not looked up.

### One order, one bar — and a second, distinct kind of bar

The Gantt component renders one horizontal swimlane per production line and places one draggable
bar per order onto its line's lane. The mapping is strictly 1:1 — an order never today spans
multiple bars, and a bar never today represents more than one order.

However, the Gantt component **already supports a second, structurally different category of
bar**: non-interactive, auto-generated shading used for things like blackout periods, "past"
shading, and alert-severity bands. These are not draggable, carry no editable content, are
generated fresh on every re-render from other data (they are never stored as their own record),
and are deliberately excluded from click/hover/selection handling that applies to real order bars.

This is functionally important: **the charting library NIMBUS uses already has a first-class
notion of "a bar that exists for display/context but is not a task,"** and NIMBUS already has a
working implementation of that pattern. This is the natural template for a setup/teardown bar,
regardless of which design option (below) is chosen — the open question is not "can the chart
render a bar that isn't an order," but "does that bar need to actually consume scheduled time."

### How sequencing currently decides order and adjacency

NIMBUS's scheduling engine is a set of **dispatching heuristics**, not a true finite-capacity
optimizer — there is no cost-based optimization, and no notion of a changeover *cost* is consumed
today anywhere in placement math.

At a functional level, when the engine re-sequences a line, it:
1. Walks the schedule day by day.
2. For each day, buckets the still-unplaced orders into priority tiers — orders due that day get
   first claim on that day's capacity, then overdue orders, then orders not yet due, then
   orders with no due date at all.
3. Tentatively fits as many of the highest-tier orders into that day's available time as it can,
   respecting fixed (pinned) orders, blackout periods, and shift boundaries as hard obstacles —
   a day can end up split into multiple fit-able fragments if an obstacle sits in the middle of it.
4. Within whatever got admitted to a fragment, re-orders them by the plant's configured priority
   fields (e.g., group same-tooling orders together) as a tie-break, then places them **back to
   back with zero gap** — one order's scheduled end becomes the next order's scheduled start.
5. Repeats for the next day, carrying forward anything that didn't fit.

The phrase "one order's end becomes the next order's start" is the crux of this design problem:
today, the placement math has no step in between two orders. Introducing a setup/teardown concept
means deciding whether that gap becomes real (subtracted from available time) or stays purely
cosmetic (drawn on top of a schedule that hasn't actually changed).

There is one existing signal in this direction, but it is reporting-only: NIMBUS already computes,
for display, how many "changeovers" occur across a line — i.e., how many times a consecutive pair
of orders differs on their tooling/priority attributes. That number is shown to the user as a
KPI. It is never subtracted from anything or used to delay placement. It's the seed of a
transition concept, but not a duration.

## Part 2 — The Feature: Setup/Teardown Bars

### Functional intent

For every order placed on a line, automatically generate:
- A **setup bar** immediately before the order's bar, representing the time needed to configure
  the line for that order's tooling, coming from the previous order's tooling.
- A **teardown bar** immediately after the order's bar, representing the time needed to break down
  that order's tooling before the next one can begin.

Both durations come from a tooling-to-tooling transition lookup (an "order tooling → order tooling
matrix") that does not exist in NIMBUS today and would need to be built and populated per plant
(and likely per line, since tooling and changeover time can differ by line even within a plant).

### The central design fork

**Option A — Cosmetic bars.** Setup/teardown bars are computed purely for display, using the same
"generated, non-interactive shading" pattern the Gantt component already uses for blackout
periods. They are drawn adjacent to (or overlapping the boundary of) the real order bars, using
the transition-matrix lookup, but the underlying schedule — start/end times, capacity, and
utilization — is completely unaffected. Nothing about placement changes.

*Feasibility:* fully supported by the existing charting component's capabilities with no new
category of object required — the "auto-generated, non-task shading" pattern already exists and
already knows how to coexist with real order bars on the same lane.

*Functional risk:* the chart can visually assert a cost — "this changeover takes 45 minutes" — that
the actual schedule does not reserve. Two orders can be shown with a teardown/setup pair drawn
between them while remaining scheduled back-to-back with zero real gap underneath. This is a
correctness gap between what the chart claims and what the schedule guarantees.

**Option B — Schedule-real bars.** The transition duration is subtracted from a line's available
time between two consecutive orders as part of placement itself. This means the sequencing
engine's placement step — the "one order's end becomes the next order's start" step described
above — needs a new step in between: after placing an order, advance the cursor by that order's
teardown time *plus* the next order's setup time (or a single combined transition value) before
computing the next order's start.

*Feasibility:* also renderable by the same "auto-generated shading" chart pattern as Option A —
this option is not a charting-capability question, it is a scheduling-engine question. The bars
themselves render identically either way; what differs is whether the numbers under them are real.

*Functional consequences if chosen:*
- **Capacity and utilization calculations** (how many hours of a line's working day are consumed)
  need to account for transition time, not just run time, or utilization will read as artificially
  low without an explanation.
- **The day-by-day fitting step** needs to treat setup/teardown time as part of what it's fitting
  into a day, which can change how many orders fit in a day and can change which orders get pushed
  to the next day — a behavior change to the existing dispatch logic, not just an addition to it.
- **The reporting-only changeover-count KPI** described above becomes partially redundant (or needs
  reconciling) once a real duration exists, since it was invented as a proxy for exactly this cost.
- **Manual drag-and-drop** and the engine's "reflow subsequent orders on this line" behavior (which
  fires after a user manually moves an order) would both need to know about transition time too, or
  a user's manual edit could silently violate the same rule the automatic scheduler enforces.
- **Pinned/fixed orders** — the one existing mechanism protecting an order from being
  automatically moved — would need a decision about whether a fixed order's setup/teardown is also
  fixed, or whether it's allowed to compress/expand if what precedes or follows it changes.

### Data model implications (either option)

Two new pieces of information are needed regardless of which option is chosen:
1. **A tooling attribute per order** usable as the lookup key (this may already partially exist via
   the color/PRT/production-version attributes NIMBUS tracks per order, or may need its own
   dedicated field — that's a data-mapping decision, not an architectural one).
2. **A transition-duration matrix**: tooling-A → tooling-B → minutes, which needs to be scoped per
   plant (and probably per line) the same way NIMBUS's other per-plant configuration data
   (priority/ranking lists, calendars, blackout periods) already is. It should **not** be a single
   global matrix — NIMBUS's architecture treats per-plant/per-line configuration as the norm, not
   the exception, specifically because tooling and changeover behavior genuinely differs across
   plants and lines.

### Scale considerations

NIMBUS is explicitly designed to grow toward dozens of plants and thousands of production lines.
A tooling-transition matrix has combinatorial blowup risk: if a plant has N distinct tooling
types, a full matrix is N² entries, and at enterprise scale this needs to be an indexed lookup a
user can search/filter (consistent with NIMBUS's existing rule that any plant/line list must be
filterable, never a flat scroll), not a grid a human is expected to fill in by hand for every
plant. A sparse-matrix upload/edit workflow (only define the transitions that matter; default
unknown transitions to a configurable fallback) is likely necessary from day one, not a later
optimization.

## Open Questions for the Debate

1. Cosmetic (Option A) vs. schedule-real (Option B) — and whether a middle path exists (e.g.,
   cosmetic first, upgraded to schedule-real once the transition-matrix data is trusted).
2. Is the tooling attribute already one of NIMBUS's existing per-order priority attributes
   (color/PRT/production version), or does the concept of "tooling" need its own new attribute
   distinct from those?
3. Should setup/teardown duration for the *very first* order of a day (or a line's day) assume a
   transition from "idle"/"no tooling," or no setup bar at all?
4. If schedule-real: what happens when a user manually drags an order such that it would now
   violate the required transition time before/after it — hard-block the drag, auto-shift the
   neighbor, or allow it and raise an alert (NIMBUS already has a general alert mechanism for
   schedule violations, which is a plausible fit for this)?
5. Who owns/edits the transition matrix, and does it need the same upload/versioning/audit-trail
   treatment NIMBUS already gives its other per-plant configuration data?

---

## Critical Callouts & Assumptions

These are the assumptions or decisions I believe *must* be made explicit before this feature can
be scoped further, given how NIMBUS is actually built today:

- **This is fundamentally a scheduling-engine decision dressed as a UI feature.** The chart itself
  can render this trivially either way (NIMBUS already has the "generated, non-task bar" pattern
  it needs). The hard part is entirely inside the sequencing engine and the data model, not the
  rendering layer. Anyone scoping "add setup/teardown bars" as a frontend-only ticket is
  understating it by an order of magnitude if Option B is the goal.
- **Adjacency is not free.** Because NIMBUS never stores an order's position in its line's
  sequence — it's always derived by sorting on start time — any setup/teardown logic must
  re-derive "what's the previous order on this line" every time it runs, including inside the
  scheduling engine's own placement loop, where it currently doesn't need that concept at all
  (it only ever asks "is there room for this next order," never "what was the previous order").
- **The existing changeover-count KPI is a trap, not a shortcut.** It looks like it already
  tracks changeovers, but it's a same-day, whole-schedule count of attribute differences, not a
  transition duration between two specific orders. It cannot be repurposed as the new feature's
  data source; at best it becomes redundant once the real thing exists.
- **Assume the tooling-transition matrix must be per-plant at minimum, per-line at maximum, from
  day one.** NIMBUS's whole configuration model (priority lists, calendars, blackout periods) has
  already had to be pushed from "one global config" to "per-plant/per-line config" once, and it
  was disruptive each time. Building the matrix as global-only "for now" would repeat a mistake
  the codebase has already paid down elsewhere.
- **If Option B is chosen, decide the fixed-order interaction rule before writing any placement
  code.** The scheduling engine's only existing protection mechanism (pinning/fixing an order) was
  designed with no adjacent-time concept in mind. Whether a fixed order "owns" its setup/teardown
  time or is agnostic to it is a one-line-sounding decision that will otherwise get decided
  accidentally by whoever writes the placement loop change.
- **Do not assume the priority/tooling attributes NIMBUS already tracks are sufficient for the
  transition lookup without checking.** They were built for ranking/sequencing tie-breaks, not
  for identifying "the physical tooling configuration on the machine." They may coincide, or a
  changeover may depend on a combination of attributes (or one not currently tracked at all,
  e.g. a mold or die identifier) — this should be confirmed with whoever owns the tooling-matrix
  data before assuming the schema question is already solved.
- **If Option B is chosen, pseudo-orders representing setup and teardown should not load into the orders table
  shown by the viewer.** The authoritative design has since resolved this: setup is derived and never persisted
  as an order.
- **If Option B is chosen, dependency arrows require caution.** The authoritative design has since resolved this:
  adjacency and setup are derived from productive order sequence, with no persisted dependency links.
