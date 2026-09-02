# Setup Matrix & Derived Setup Bars — Design and Migration Plan

**Status:** design agreed through the 2026-08-12 debate; **implemented** across Stages 0-1-2 (~50 commits;
`setup_data.py`, `web/setup-domain.mts`, `web/setup-scheduler.mts`, four `schema.sql` tables, setup-aware
placement, due-date search, capacity diagnostics, derived Gantt bars, preview explanations). Live for a plant
via the single "Include setup times in optimizer" checkbox (`docs/archive/Setup_matrix_redesign.md` §15) rather than
the multi-step authorization flow this document assumed — see that document's §1.1/§15 for the correction and
what changed. `docs/archive/changeover_matrix_stage_1.md`'s checkbox tracking is stale; treat git log as authoritative.
**Supersedes:** the live feature requirements in `docs/archive/Setup_teardown_bars.md`, which remains the historical
description of pre-feature NIMBUS.

## 1. Product decision

NIMBUS will model one sequence-dependent **setup duration** before a production order. Teardown is removed.

```text
previous setup state -> next setup state = setup minutes
```

Setup is real finite-capacity time. It affects placement, utilization, alerts, split-order feasibility,
optimization preview, manual reflow, and fixed-order boundaries. It is derived, never stored as an order.

This follows the SAP APO / PP/DS mental model: sequence-dependent setup is a separate activity before
processing, based on predecessor resource state, and shown as a subordinate narrow bar. NIMBUS remains a
deterministic rule-based heuristic scheduler with bounded local search; this is not a migration to a global
mathematical solver.

## 2. Setup-state and matrix semantics

### Per-plant signature

Each plant chooses one ordered subset of registered rankable order attributes to define setup state:

```text
Plant 5512: PRT_01 + Color
Plant 1006: Color only
```

V1 supports one active definition per plant. All participating lines use it. Lines may override individual
matrix durations, but not signature composition. A line incompatible with the definition must opt out of
setup-aware optimization rather than use a knowingly wrong signature. This is a v1 scope boundary, not a
permanent claim that every equipment family in a facility is identical.

Coverage proves that values exist for the configured signature; it does not prove that the signature contains
the correct physical attributes. Choosing an overly narrow signature can collapse materially different states
and create false implicit-zero transitions. For example, a `Color only` signature treats two different red molds
as the same setup state even when changing molds actually requires work. Signature owners must validate that the
selected fields describe the plant's real transition behavior.

Changing fields or field order increments a signature-definition version, invalidates old matrix/state/override
keys, disables setup optimization for that plant, and requires a version-matched matrix and new coverage pass.
No automatic re-keying or silent old-version fallback is safe.

### Ordered transitions

Direction matters:

```text
AA -> AB = 70 minutes
AB -> AA = 45 minutes
```

The scheduling datum is one `setup_min`; NIMBUS does not invent a setup/teardown split.

Order adjacency and predecessor state are determined by processing sequence and production start, not by the
derived setup-bar start. Recalculating a setup duration may move its derived start, but must never independently
change which production order is considered the predecessor.

### Same-state exception

An explicit diagonal row is allowed and wins:

```text
A -> A = 10 minutes
```

Without one, two valid, fully known, identical setup states resolve to an intentional implicit zero. This is the
only missing-row case that may resolve to zero. Blank or incomplete signatures do not qualify as identical valid
states and remain uncovered.

### Missing non-diagonal transitions

For `A != B`, missing means unknown, never zero. Optimization treats the edge as unavailable. Two cases:

**Orders with blank or unresolvable setup signatures** (signature field missing, signature incompatible with line) are placed at the tail of their day bucket, ordered among tail orders by the normal priority terms; they contribute no setup bar; and they raise an initial-state-unknown or signature-incompatible alert.

**Orders with a resolvable setup signature but an uncovered transition** (known predecessor and successor states, missing matrix pair) are admitted *in sequence* near other orders sharing the same signature state, charged zero setup minutes, placed with no changeover bar, and raise a setup-uncovered alert. They are de-preferred in candidate selection by a dedicated coverage-tier comparison (fewer uncovered edges is better), guaranteeing that a fully-covered sequence still wins whenever one exists. This tier is compared immediately after policy key and outside the mode-permuted terms list, ensuring uncovered orders cluster with their signature peers rather than being scattered throughout a sequence.

The optimizer never freezes a line for missing setup data. Both kinds of missing-setup orders are excluded from the min-changeover permutation search over the covered core — they are never charged a fake zero-minute setup. Once search and coverage-tier ranking complete, each order places via real capacity and split-policy logic.

Never block unaffected lines solely because another line is incomplete.

The preview provides a selectable/`Ctrl+C`-friendly and CSV-exportable table containing from/to states, affected
lines/orders, excluded alternatives, and the orders scheduled without setup bars because of missing setup data
(no line is left unchanged solely for that reason — see the never-freeze rule above). Preview users cannot enter
standards there; authorized master-data owners update the matrix, which invalidates the preview and requires a
rerun.

The preview provides a **Review missing setups** action that opens the matrix editor filtered to the relevant
pairs for an authorized master-data owner. Users without matrix-write permission retain copy and export access
only. Saving any missing value marks the existing preview stale, disables Apply, and requires an explicit rerun;
the editor must not silently recalculate or modify an already-open preview.

Coverage reports both:

1. **Observed pairs:** edges in the current schedule.
2. **Reachable pairs:** edges the active policy may legally create.

Reachable coverage is the optimization safety gate. Missing edges cannot win a solve when a covered alternative exists.

### Resolution precedence

1. Valid occurrence-specific remaining-setup override.
2. Exact line-level matrix row.
3. Exact plant-level matrix row.
4. Implicit zero for identical, fully known states.
5. Otherwise uncovered.

Line overrides are sparse cell-level overrides. Deleting one exposes the inherited plant value; a partial line
upload never replaces the whole plant matrix.

## 3. Persistence boundaries

The conceptual persistent records are:

- **Plant setup-signature definition:** fields, version, strict blank policy, activation, audit metadata.
- **Setup matrix row:** plant, optional line, signature version, ordered keys, setup minutes, source/audit metadata.
- **Current line state:** plant/line, state key, signature version, optional physical mold ID, observed timestamp,
  source, reason, actor.
- **Setup occurrence override:** exact line, predecessor state/order, successor state/order, signature version,
  standard and remaining minutes, status, reason, actor, timestamps.

Do not persist setup pseudo-orders or adjacency/dependency links. A setup occurrence is derived from line,
predecessor state, successor order, current matrix version, current line state, and an applicable override.

Writes validate finite nonnegative minutes and a documented maximum, registered fields and canonical order,
allowed key kinds, plant/line ownership, signature version, deterministic duplicate behavior, canonical composite
key escaping, authorization, and audit metadata.

### Matrix changes after schedules exist

New matrix values become authoritative immediately for derived display and validation. Existing production orders
do not move automatically; alerts identify newly short setup intervals. Open previews become stale and cannot be
applied. No matrix write, cache refresh, or alert may invoke optimization.

A valid occurrence override survives a standard-value change because it represents remaining physical work; the
UI shows current standard versus scheduled remaining time.

### Cache and plant isolation

Plant-scoped signature, matrix, line-state, and override caches clear before plant hydration and refresh after
successful authorized writes. Freshness markers are set only on success. Plant-gated endpoints use
`Util.fetchTraced`. Scheduling services read cached data and never fetch inside the engine.

## 4. Current physical line state

`line_state` means the best-known **current physical setup state before the future plan begins**. It is not a
future event timeline.

Sources are visible:

- `manual`: a person confirmed floor state;
- `derived`: inferred from the last completed-by-plan order before removal/replacement;
- future `actual`: execution confirmation from SAP/MES.

Derived state is never presented as verified truth. Authorized plant schedulers may override current state,
optional mold ID, observed timestamp, and required reason. A manual state does not advance merely because the
clock passes a planned completion. It changes only through another manual assertion, future actual confirmation,
or a controlled pre-purge snapshot labeled derived.

A controlled derived snapshot is taken immediately before an upload/SAP replacement or purge removes the source
schedule. It may use only the last planned order completed at or before the captured plant-local snapshot time,
never a future planned order. State updates are monotonic by observed time and trust: an older derived snapshot
must not overwrite a newer manual or actual assertion, and every derivation retains its source event and signature
version for diagnosis.

If no usable state exists, preserve the current first order, report its initial setup as unknown, and use that
order's state as the planned predecessor for later transitions.

### Remove Backlog

Remove Backlog preserves sequence. Its first resulting order is the initial **successor**, not a replacement for
persisted current state:

```text
current state -> setup -> first repaired order -> setup -> next order
```

If current state is unknown, preserve the first repaired order and flag only its incoming setup. Applying or
discarding the preview never mutates current state.

## 5. Occurrence-specific overrides

Authorized plant schedulers may override the remaining duration of any specific setup occurrence without editing
the standard matrix. Overrides may increase or decrease time and are not artificially time-horizon restricted.

They require remaining and standard minutes, actor, timestamp, and reason; render visibly as `OVERRIDE`; affect
capacity, alerts, completion, and preview explanation; support clear/replace; and remain audited.

An override binds to the exact line, predecessor state/order, successor state/order, and signature version. If a
binding changes, it becomes inactive rather than following an order silently.

A valid override represents physical work or present operational truth and therefore protects that adjacency
during optimization. The planner must clear it before optimization may break the pair.

## 6. Split-order and calendar rules

Setup is contiguous and immediately precedes the first productive segment it prepares. It never occupies closed
time or crosses a blackout. A block may not contain setup alone; it must fit:

```text
contiguous setup + the split policy's required productive segment
```

- `never`: setup plus the complete order must fit continuously.
- `overlong_only`: only an eligible overlong order may split; its first block still includes setup plus a valid
  productive segment.
- `partial_allowed`: setup plus at least the configured minimum productive segment—fixed at **30 minutes** in the
  phase-1 split-order contract—must fit; production may continue later. This minimum is not a plant setting. The
  existing exception remains for one complete unsplit order whose entire runtime is under 30 minutes.

If only setup or partial setup fits near shift end, place nothing there. Move complete setup plus required
production to the next feasible block.

Ordinary closure, weekend, and blackout downtime preserve setup state in v1. A split continuation pays no new
setup if no other order ran between segments. If another order intervenes, charge setup into it and back into the
original order. Maintenance/cleaning state changes use manual state or occurrence override, not automatic blackout
semantics.

The phase-1 split allocator does not interleave another parent order inside a split parent's envelope. Therefore,
the intervening-order rule is defensive compatibility for a future interleaving capability, not behavior the
initial allocator is expected to create.

Remove Backlog retains one mode-specific compatibility exception under `never`: an inherently overlong order may
start at the next valid operating instant as one continuous bar through closed time and must be reported as a
calendar exception. Split-enabled policies replace that exception with productive segments; they do not change
Remove Backlog's preserved sequence or hard mutation boundary.

Splitting can reduce avoidable lateness but cannot erase setup capacity.

## 7. Scheduling engine and policies

### Deterministic bounded heuristic

Rules determine eligibility and priority; deterministic bounded search compares feasible setup-aware sequences
privately against an immutable snapshot. Intermediate candidates never enter `Store`, render, persist, or trigger
alerts.

```text
snapshot -> bounded search -> one winner -> preview -> apply once or discard
```

Alerts never invoke optimization. Here, “alerts” means alert computation, recomputation, publication, and the
appearance of a new alert; none may automatically start another run. An explicit planner click on **Fix It** is a
new user action and may request one bounded run, but that run's resulting alerts cannot recursively invoke another.
One user action creates at most one commit. Repeated candidate states are discarded, search has time/iteration
limits, and every accepted move strictly improves one immutable
lexicographic objective:

1. hard feasibility and fixed/override protection;
2. active policy/tier precedence;
3. late-order count and lateness;
4. admitted due work;
5. setup minutes;
6. deterministic sequence key.

This prevents oscillation such as `A-B-C -> A-C-B -> A-B-C`.

Search budget is scoped **per line**, not shared plant-wide: a large first line exhausting its iteration cap must
never starve or freeze the lines behind it. Min Changeover's due-safe baseline pass and its candidate pass split
one wall-clock deadline rather than each claiming the full window against a shared clock; the baseline runs first
and the candidate gets whatever remains. A candidate pass that is starved or empty can never be preferred over a
non-empty baseline — the baseline wins outright in that case.

### Setup groups

A group is eligible orders on one line sharing one fully known setup state—not a plant, line, batch, or physical
mold pool. Policy tier and order-level due obligations remain visible; grouping may not let future work jump ahead
merely because it shares a state.

Stage 0 measures distinct states per plant, line, day/fragment, median, maximum, and percentile before exact-search
thresholds are chosen. Larger fragments use deterministic greedy/local improvement with strict bounds.

### Fixed boundaries

Each fixed order creates two edges:

```text
free predecessor -> fixed order -> next free order
```

Incoming setup must fit before the fixed processing start. The fixed order's state becomes the outgoing
predecessor. If setup cannot fit, preserve the fixed run and report infeasibility. Solve each obstacle-free
fragment with incoming and next-fixed states as boundary conditions.

Remove Backlog is the deliberate mode-specific exception: an eligible fixed order reached by its forward cascade
moves under that heuristic's existing rules and remains fixed. The boundary rule above continues to govern SPT,
Smart, Min Changeover, Throughput first, manual reflow, and ordinary setup-aware sequencing.

### Mode semantics

All modes charge covered setup as capacity:

- **SPT:** remain pure shortest productive processing time. A missing edge never secretly changes SPT order and
  never freezes the line: the affected order is scheduled at the tail of its day bucket with no setup bar and a
  missing-setup-data alert, rather than being left in place or given an invented zero-minute transition.
- **Smart / Due-date first:** minimize setup only within due-safe choices; no additional sequencing-induced
  lateness beyond unavoidable setup capacity.
- **Min Changeover / Use available slack:** may pull future work forward while creating no new lateness.
- **Throughput first:** may create bounded lateness only under its explicit minimum-savings threshold and slip cap;
  initial defaults are at least 60 setup minutes saved and no order slipping more than one day.
- **Remove Backlog:** preserve sequence, repair past work, and use current state to set up its first resulting order.

### Manual drag and reflow

Honor a direct production-bar drop even if incoming setup is short; alert required, available, and short minutes.
Existing downstream reflow becomes setup-aware but remains one deterministic forward walk: preserve sequence,
reserve setup, move only permitted peers, stop at impossible fixed boundaries, alert, and never optimize.

When available time is shorter than required, render the full required setup interval with a conflict treatment,
even if it overlaps the predecessor or another unavailable interval. Never silently shorten the setup bar, invent
a valid gap, or move the directly dragged production order merely to make the setup appear feasible.

## 8. Preview-only explainability

The engine returns structured explanation and diagnostics with candidate patches. They live only while the
optimization preview is open. Apply, discard, or close destroys them; nothing is stored in Postgres, localStorage,
the audit log, or a permanent cache.

The preview shows before/after production, setup, occupied time, lateness, utilization, chosen line sequences,
concise reasons, a few meaningful rejected alternatives, fixed/override constraints, missing edges, the tally of
orders scheduled without setup bars for missing setup data, candidate count, search method, termination reason,
runtime, and whether a limit was reached. Lines are reported as unchanged only when a fail-closed guard genuinely
protects a pinned/fixed order (§7, §11) — never merely because setup data was incomplete.

```text
Rejected A -> C -> B: setup was 15 minutes lower, but B would finish 42 minutes late.
```

Capture is bounded and aggregated; never retain full schedule snapshots for every candidate.

This requires a deliberate migration seam. Today `OptimizerPreview.runWithPreview` snapshots tasks and then calls
the mutating `Engine.runAndApply`, so the trial exists temporarily in `Store` before Apply or Discard. That rollback
mechanism is not the private-candidate contract above. Before adding setup-aware candidate search, extract a pure
evaluation path that returns `patches`, `score`, `explanation`, and `diagnostics` from an immutable snapshot; the
preview compares detached before/after data and only Apply commits the selected patch set. Do not layer multi-
candidate search on top of repeated `Store` mutation and rollback.

## 9. Gantt rendering and performance contract

### Authoritative visual

Render a separate narrow foreground interval at exact time immediately before processing:

```text
[ setup ][---------------- production order ----------------]
```

It is derived, non-editable, and non-selectable. Zero setup renders no item. Missing setup renders a warning
marker at the successor's leading edge, never a fake-duration bar. Overrides show standard and scheduled minutes.

Non-selectable must not mean inaccessible. The successor order's tooltip and inspector expose required setup,
effective setup, source/override status, predecessor state, and missing-transition detail. Keyboard users must be
able to reach the same information through the successor order; color, hatch, or hover alone cannot carry setup
meaning.

Do not shade a percentage of productive runtime as authoritative setup; that lies about the time axis. A fixed
pixel leading indicator may aid coarse-zoom discoverability but must not pretend to represent duration.

### Semantic timeline items

Use a semantic kind such as `order | order-segment | setup | blackout | zone` in every click, double-click, hover,
context-menu, marquee, selection, focus, dependency, drag, and ghost path. Do not rely on scattered ID-prefix
checks. Setup items never resolve as business orders.

### Drag-performance requirement

Separate setup bars are a real performance risk. Do not claim `DataView` absorbs derivation, diff, memory,
filtering, and redraw costs.

During drag:

1. hide or dim setup bars on affected source/target lines;
2. do no matrix lookup or adjacency rebuild per animation frame;
3. preserve existing production ghost behavior;
4. after drop/cancel, recompute affected old/new lines once;
5. batch all setup item additions, updates, and removals.

Setup bars may visibly “poof” during drag and return after drop. Moving one order can invalidate predecessor and
successor setups on old and new lines, so order-only incremental patching is insufficient. Use line-scoped indexes
or affected-line batch rebuilds, never a full-plant rebuild for one drag.

Measure derivation, diff, redraw, and worker clone time through `PerfMonitor`. Benchmark representative volume,
positive-setup density, rapid/multi-order cross-line drag, split orders, cancel/revert, and previews. Establish an
interaction budget before plant activation.

## 10. Alerts

Add diagnostics for:

- **Setup violated:** available interval is shorter than required.
- **Setup uncovered:** required non-diagonal pair lacks a trusted row, deduplicated by pair/scope.
- **Initial state unknown:** first incoming setup is indeterminate.
- **Current state diverged:** asserted physical state conflicts with plan expectation.
- **Override inactive:** an override's bound adjacency changed.

Manual schedules may contain alerts. Optimizer output may not knowingly violate hard setup constraints. Alerts
report state and never start optimization.

Capacity and alert behavior must remain aligned between `schedule-services.mts` and
`nimbus-compute-core.js`, including split intervals. Worker snapshots carry only scoped setup data and their clone
cost is measured.

## 11. Maintenance, permissions, and activation

V1 uses canonical long-form upload/storage:

| From setup state | To setup state | Setup minutes |
|---|---|---:|
| Mold A / Red | Mold A / Blue | 10 |
| Mold A / Blue | Mold B / Red | 30 |

This matches missing-pair CSVs and sparse overrides. A pivot viewer may come later.

- Master-data owners manage signatures, activation, matrices, and standard rows.
- Authorized plant schedulers manage current state and occurrence-specific remaining setup.
- Preview users may inspect, select/copy, and export missing pairs but not enter standards there.

Activation is per plant and disabled by default. Once setup truth exists for a plant, a safe disable **only**
prevents new setup-aware optimization runs. It does not delete setup data, move orders, or hide the current setup
truth: derived setup bars, effective durations, current-state/override indicators, missing-transition markers, and
setup alerts remain visible. This lets planners understand the schedule they already have without allowing the
optimizer to create a new setup-aware sequence.

## 12. Staging

### Stage 0 — data and shadow diagnostics

Build versioned definitions, long-form plant rows and sparse line overrides, current state, occurrence overrides,
observed/reachable coverage, missing-pair export, shadow KPIs, group-count measurement, and performance evidence.

Exit requires version-matched validation, acceptable reachable coverage, visible/acknowledged unknown states,
representative performance budgets, and clear derived-versus-manual state UX.

### Stage 1 — schedule-real Due-date first

Ship transition-aware admission/sequencing, split-policy placement, fixed boundaries, utilization/alert parity,
separate setup bars, preview explanations, and setup-aware reflow together. Do not ship charging without
setup-aware sequencing.

### Stage 2 — broader policies

After real-plant validation, enable Use available slack / Min Changeover and Throughput first with explicit
savings and slip limits.

## 13. Required verification

Tests must cover:

- explicit/implicit diagonal and strict blanks;
- line -> plant -> diagonal -> uncovered resolution;
- observed/reachable coverage and missing-edge exclusion;
- signature-version and preview invalidation;
- override binding, protection, clearing, and inactivation;
- manual/derived current state and Remove Backlog's first successor;
- setup plus each split policy's productive minimum;
- downtime continuation and intervening-order transitions;
- free/fixed boundary combinations and infeasibility;
- pure SPT with real setup;
- deterministic reruns, bounded termination, and no alert feedback loop;
- manual drag/reflow and source/target-line item invalidation;
- every setup-item interaction guard;
- worker/main-thread utilization and alert parity;
- matrix-change behavior and representative performance budgets.

Use a fixed clock or relative dates in scheduling tests.

## 14. Explicitly deferred

- Finite shared-mold scheduling across lines.
- Individual mold inventory, interchangeable IDs, and reservations.
- Material-to-material exception rows outside the active setup signature (a future dedicated material-pair key
  kind rather than a hidden v1 fallback).
- Multiple active setup definitions within one plant.
- Future-dated line-state event streams.
- Automatic blackout/maintenance state resets.
- Setup labor/crew constraints.
- Permanent optimization-reason storage.
- A global mathematical solver.
- Interval-level setup adjacency inside a split order (audited 2026-08-17; deliberately not built).
  `deriveSetupObservation` collapses a multi-segment order to `first.start`/`last.end`
  (`web/schedule-services.mts`, the `byLine` push in the task loop), so if another order is manually
  dragged into a split order's idle gap, the setup needed to switch *back* to the split order is never
  evaluated — the resumption edge is silently free, and the following order's predecessor becomes the
  interleaved order rather than the split order's last segment.

  This is left as-is on purpose, not overlooked. The optimizer models an order as **atomic**: the
  candidate loop in `web/setup-scheduler.mts` resolves exactly one setup per task, then advances
  `cursor = new Date(last.end)`, so it never interleaves another order inside a split envelope (matching
  §6's "phase 1 does not interleave parents inside a split envelope"). Making the observation
  interval-aware while the optimizer stays order-aware would raise setup requirements the optimizer
  structurally cannot plan for or resolve — permanent, unfixable alerts. The two must move together, and
  an occurrence override could not express a repeated adjacency anyway: `setup_occurrence_override` is
  keyed on `(predecessor_order_id, successor_order_id)` with no occurrence discriminator.

  Prerequisite before revisiting: decide whether the optimizer may interleave inside a split envelope at
  all. If it may not, the correct fix is to block or alert on the manual drag that creates the interleave,
  not to model the resumption setup.

These are compatible future directions, not approximations v1 may silently claim to enforce.

Setup state and physical-asset feasibility remain separate. A matrix row proves only the duration of a covered
state transition; it does not prove that a required mold is available. Duplicate molds may produce the same
material but retain individual IDs, and a future plant-wide secondary-resource model must enforce their eligibility
and exclusive cross-line reservations. V1 must never label a schedule globally feasible merely because every setup
edge is covered.

A physical mold ID identifies a finite asset; a setup-state key identifies transition behavior. Multiple physical
mold IDs may therefore share one setup state. Do not automatically use individual mold IDs as matrix keys or
create ID-specific matrix rows unless plant evidence shows that a particular asset consistently changes the
standard setup duration; one-time differences in remaining work belong in an occurrence-specific override.
