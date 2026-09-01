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
