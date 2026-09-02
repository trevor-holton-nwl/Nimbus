// optimization/scheduler-contract.mjs — tiny leaf module (Phase P4 of
// docs/architecture/domain-refactor-plan.md). Exists purely to break import
// cycle 1 between the former schedule-services.mts and setup-scheduler.mts,
// not for domain-grouping reasons (see docs/architecture/domain-refactor-plan.md
// §5 and this phase's task brief, Part B). Holds only
// `MIN_PRODUCTIVE_SEGMENT_MINUTES` and `RemoveBacklogResult`/
// `RemoveBacklogDiagnostics` — the two things setup-scheduler.mts needed from
// schedule-services.mts that have nothing to do with the `Engine` object
// itself (whose adapter function was the actual cycle-forming edge).
// A true leaf: no imports of its own beyond the ambient NimbusTask type, and
// it must stay that way — nothing it exports may start importing back into
// optimization/engine.mjs or optimization/setup-scheduler.mjs.
//
// This leaf breaks the NAMED cycle (schedule-services/engine.mjs <->
// setup-scheduler.mjs), but setup-scheduler.mjs still imports
// candidateDefaultWorkHours from calendar/calendar-engine.mjs, which in turn
// imports Engine/the pure evaluators back from engine.mjs — so
// engine.mjs -> setup-scheduler.mjs -> calendar-engine.mjs -> engine.mjs is a
// real transitive loop, and combined with engine.mjs's separate direct cycle
// with insights/services.mjs, all four files form one strongly-connected
// component (contradicting the "setup-scheduler is a detached module"
// framing elsewhere in this codebase's docs). P4's review empirically
// confirmed this is safe today — every cross-reference in the loop is
// touched only inside a function/method body invoked after all four modules
// finish top-level evaluation, verified by loading them under every possible
// entry order with no TDZ ReferenceError — but it is NOT two independent
// 2-file cycles the way it might look from any single file's imports.
// Reason about the whole four-file loop, not just your own two neighbors,
// before adding a new top-level (module-evaluation-time) reference anywhere
// in engine.mjs, setup-scheduler.mjs, calendar-engine.mjs, or
// insights/services.mjs.
import type { NimbusTask } from '../platform/types.mjs';

export interface RemoveBacklogDiagnostics {
  backlogFound: number;
  moved: number;
  firmedMoved: number;
  frozenMoved: number;
  movedRuntimeHours: number;
  largestDelayMinutes: number;
  invalidRuntimeIds: string[];
  missingStartIds: string[];
  overlongIds: string[];
  calendarSearchFailures: Array<{ line: string; taskId?: string; reason: 'no-operating-interval' | 'search-exhausted' }>;
  boundaryConflicts: Array<{ line: string; movedTaskId: string; protectedTaskId?: string; type: 'overlap' }>;
}

export interface RemoveBacklogResult {
  patches: Array<{ id: string; changes: Partial<NimbusTask> }>;
  diagnostics: RemoveBacklogDiagnostics;
}

/** B3 (2026-08-21): default productive-segment floor (minutes) — no split
 * piece may be shorter than this, except one complete unsplit order below
 * the boundary. Phase-1 shipped this fixed system-wide; it is now the
 * DEFAULT ONLY, plant-overridable via `plants.min_productive_segment_minutes`
 * — see `Engine.minProductiveSegmentMinutesFor`, which resolves the per-plant
 * value and falls back to this default when unset/null. Keep allocator
 * arithmetic on this named boundary. Canonical for both calendar/
 * calendar-engine.mjs's `Calendar.allocateRuntime` (non-setup-aware) path and
 * optimization/setup-scheduler.mjs's `placeWithSetup` (setup-aware) path —
 * both import this constant from this leaf module rather than declaring
 * their own copy. */
export const MIN_PRODUCTIVE_SEGMENT_MINUTES = 30;
