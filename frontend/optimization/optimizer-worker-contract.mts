import type { CandidateResult, DueDateFirstBounds, EvaluationRequest, ScheduleSnapshot } from './setup-scheduler.mjs';
import type { OptimizerMode } from '../platform/types.mjs';

export interface OptimizerWorkerRequest {
  runId: string;
  mode: OptimizerMode;
  snapshot: ScheduleSnapshot;
  request: EvaluationRequest;
}

/** Clone-safe replacement for the evaluator's function-bearing bounds. The
 * worker sends these facts back so Apply can validate the exact candidate
 * without running the expensive search a second time. */
export interface SerializedOptimizerValidation {
  setup: DueDateFirstBounds['setup'];
  exactSearchThreshold: number;
  iterationCap: number;
  deadline: number;
  now: Date | string | number;
  planningStart?: Date | string | number;
  runNow?: Date | string | number;
  placementStart?: Date | string | number;
  horizonEnd: Date | string | number;
  lines?: readonly string[];
  respectCalendar?: boolean;
  notBeforeById: Record<string, Date | string | number | null>;
  notAfterById: Record<string, Date | string | number | null>;
}

export interface OptimizerWorkerResponse {
  runId: string;
  candidate?: Omit<CandidateResult, 'validationContext'>;
  validation?: SerializedOptimizerValidation;
  error?: string;
  stack?: string;
}

/** Build a clone-safe validation descriptor from the function-bearing search
 * bounds. Bound closures must capture detached snapshot data at construction
 * time; the worker entry can then call them after Engine clears its run-local
 * source selector. */
export function serializeOptimizerValidation(
  candidate: CandidateResult,
): SerializedOptimizerValidation | undefined {
  const context = candidate.validationContext;
  if (!context) return undefined;
  const { bounds, snapshot } = context;
  const notBeforeById: Record<string, Date | string | number | null> = {};
  const notAfterById: Record<string, Date | string | number | null> = {};
  for (const task of snapshot.tasks) {
    const id = String(task.id);
    notBeforeById[id] = bounds.notBefore?.(task) ?? null;
    notAfterById[id] = bounds.notAfter?.(task) ?? null;
  }
  return {
    setup: bounds.setup,
    exactSearchThreshold: bounds.exactSearchThreshold,
    iterationCap: bounds.iterationCap,
    deadline: bounds.deadline,
    now: bounds.now,
    planningStart: bounds.planningStart,
    runNow: bounds.runNow,
    placementStart: bounds.placementStart,
    horizonEnd: bounds.horizonEnd,
    lines: bounds.lines,
    respectCalendar: bounds.respectCalendar,
    notBeforeById,
    notAfterById,
  };
}
