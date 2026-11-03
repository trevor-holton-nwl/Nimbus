import type { CandidateResult, DueDateFirstBounds, EvaluationRequest, ScheduleSnapshot } from './setup-scheduler.mjs';
import type { OptimizerMode } from '../platform/types.mjs';

export interface OptimizerWorkerRequest {
  runId: string;
  mode: OptimizerMode;
  snapshot: ScheduleSnapshot;
  request: EvaluationRequest;
  /** Remaining primary budget measured in the sender's monotonic clock. The
   * worker converts it to its own performance.now() origin on receipt. */
  deadlineDurationMs?: number;
}

/** The evaluator request for a worker request: the carried `mode` is the single source of truth, so the worker, the
 *  main-thread fallback and every sync caller evaluate exactly the same shape. */
export function evalRequestOf(request: OptimizerWorkerRequest): EvaluationRequest {
  return { ...request.request, mode: request.mode };
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
  planningStart: Date | string | number;
  runNow: Date | string | number;
  placementStart: Date | string | number;
  horizonEnd: Date | string | number;
  lines?: readonly string[];
  scopeTaskIds?: readonly string[];
  boundaryTaskIds?: readonly string[];
  respectCalendar: boolean;
  /** Effective manual + ECC + frozen firmed ids used by evaluation. */
  effectiveFirmedIds: readonly string[];
  notBeforeById: Record<string, Date | string | number | null>;
  notAfterById: Record<string, Date | string | number | null>;
  /** Frozen-horizon finish floor (2026-10-27); null/absent = none. */
  finishFloor?: Date | string | number | null;
  /** Remove Backlog only (headless backlog step, Jobs W4b): exempt from the plant's pull/push window and from the tool
   *  rule at validation. Absent = false, so every other mode is unchanged. */
  ignorePlantWindow?: boolean;
  ignoreToolRule?: boolean;
}

export interface OptimizerWorkerResponse {
  runId: string;
  candidate?: Omit<CandidateResult, 'validationContext'>;
  validation?: SerializedOptimizerValidation;
  error?: string;
  stack?: string;
  /** Worker-side evaluation time in ms (handler-added measurement, not part of the candidate). */
  evalMs?: number;
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
  // `ignorePlantWindow` and `ignoreToolRule` are set only by Remove Backlog (engine.runAndApply). They ARE serialized: the
  // headless backlog step (Jobs W4b) re-validates at apply time from this descriptor, and without them the validator would
  // enforce the plant window and the tool rule that Backlog is exempt from and drop its patches. The tooling rule and the inventory are NEVER carried in bounds: the validator re-derives both from
  // `snapshot.masterData` (Tool Inventory Wave 6), and `toolPass` on the candidate says the overflow pass has run.
  if (!Number.isFinite(bounds.now.getTime())
    || typeof bounds.respectCalendar !== 'boolean'
    || !bounds.planningStart || !Number.isFinite(bounds.planningStart.getTime())
    || !bounds.runNow || !Number.isFinite(bounds.runNow.getTime())
    || !bounds.placementStart || !Number.isFinite(bounds.placementStart.getTime())
    || !Number.isFinite(bounds.horizonEnd.getTime())) return undefined;
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
    lines: bounds.lines ?? undefined,
    scopeTaskIds: bounds.scopeTaskIds === undefined
      ? undefined
      : Array.from(bounds.scopeTaskIds, String),
    boundaryTaskIds: bounds.boundaryTaskIds === undefined
      ? undefined
      : Array.from(bounds.boundaryTaskIds, String),
    respectCalendar: bounds.respectCalendar,
    effectiveFirmedIds: Array.from(snapshot.firmedIds, String),
    notBeforeById,
    notAfterById,
    finishFloor: bounds.finishFloor ?? null,
    ...(bounds.ignorePlantWindow ? { ignorePlantWindow: true } : {}),
    ...(bounds.ignoreToolRule ? { ignoreToolRule: true } : {}),
  };
}
