# Optimizer Hard Bounds and Planning Exceptions

The approved user plan is the authority for this change. NIMBUS retains its frontend scheduler and introduces durable partial outcomes for Min Changeover, Due Date, and SPT, for preview and direct runs. Remove Backlog, manual movement, automatic reflow, and alert fixes retain their date policies.

## Scheduling contract

For SAP due timestamp D and optional nonnegative pull P and push Q, start is at or after local midnight D minus P calendar days, combined with planning/frozen floors. Production completes at or before midnight following D plus Q calendar days. Equality is legal; null limits impose no bound. Calendar arithmetic uses local setDate, including daylight-saving transitions. Delivery metrics always use the stored SAP due timestamp, never scheduled finish. Missing/invalid SAP due with a configured bound is a planning exception.

All productive segments and setup occupancy must fit calendars, blackouts, protected reservations and whole-order split policy. Setup cannot begin before the placement floor. Missing active setup transitions use zero minutes with visible warnings; setup confidence is independent of date compliance.

## Allocation and search

Admission favors earliest hard completion deadline, configured priority, SAP due timestamp, existing schedule order, stable ID; unbounded orders follow bounded ones. Compare admission lexicographically in that urgency order before strategy scores. Within admitted demand, Min Changeover minimizes late count, lateness minutes, setup minutes, priority and instability. Due Date remains delivery-first; SPT prefers short jobs within legal placements. Failed placement continues the line; reconsider alternative sequences before reporting no fit.

Valid current schedules are incumbents. Preserve the best validated result on search expiration. All placement paths (unknown tails, synthetic runs, firmed fallback, timeout) enforce windows. Recompute final metrics over the whole proposal including queued demand. Expose order dispositions, validation findings and search completeness separately from objective scores.

Approved follow-up: after selecting the final proposal, use a separate soft one-second budget across the run to check queued orders against unused gaps. Keep accepted production fixed; sort queued demand by deadline and machine-specific configured priority before insertion. Check incoming and outgoing setup, override adjacency, calendars, blackouts, hard windows and whole-order split rules. Recheck earlier failures if another insertion changes setup transitions on that line. Do not sort or move accepted production afterward. Retain successful additions on timeout and expose capacity-check completeness separately from primary search completeness; completed checks describe no slot found without moving scheduled orders. Final validation and metric recomputation may finish just after the soft budget.

## Queue and persistence

Orders use planning_status scheduled or needs_planning and a structured planning_reason for the latest attempt. Queued orders have null committed dates and no child segments; identity, machine, quantity, SAP baselines and business fields survive. Reasons distinguish expired_window, missing_due_date, invalid_runtime, no_fit_found and search_limit. Protected orders keep their dates and reserve capacity; report existing violations without rejecting the remaining line. Queued orders retry in later optimizations and clear status/reason on success.

Add idempotent migration and schema parity. Task read, refresh, update and frontend types carry queue state and nullable committed dates. Date-filtered scoped/paginated reads include queued demand. Hydration, calendar normalization and SAP refresh cannot restore schedule dates from baselines. Explicit date edits return an order to scheduled.

Opt-in atomic_optimizer on the bulk task update validates every affected version and update before any writes. Conflict or rejection rolls back all; force cannot bypass optimizer conflicts. Legacy callers retain best-effort behavior. Local Apply changes schedule and queue in one undo entry; Save persists dependent rows together. Failed atomic saves remain dirty.

## Planner experience and validation

Use existing plant/machine scoped Orders grid for Needs Planning. Show order, SAP due, allowed window, runtime and reason. Preview separately reports scheduled/newly queued/protected exceptions/setup warnings/incomplete search. Queue contributes to demand/delivery reporting and zero scheduled utilization.

Before Apply validate scope, exactly-once accounting, date windows, productive duration, segments, occupied capacity and preservation of protected orders. Reject stale or internally invalid proposals; ordinary capacity exceptions permit partial Apply.

## Acceptance and release

Regression coverage includes two six-hour jobs in a ten-hour due day; all floor and ceiling paths; setup/split overflow; protected violations; deadline admission over grouping; missing setup warning/score separation; save/reload/refresh/undo/retry; atomic stale/rejected rollback; timeout incumbent retention; DST, null bounds, missing due and excluded lines.

Run focused tests then build, typecheck, lint, Node tests and relevant Python tests with the guarded local database only. Apply the additive migration before deploying the dependent application. No replacement solver, machine reassignment, material/labor constraints or precedence enforcement is introduced.
