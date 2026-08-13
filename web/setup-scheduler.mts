/*
 * Detached candidate scheduling contract.
 *
 * This module receives the complete scheduling read model as a snapshot and
 * returns only patches. It never mutates Store, DOM, persistence, alerts, or
 * Timeline; the workbench owns the one explicit Store commit after Apply.
 */

import type { RemoveBacklogResult } from './schedule-services.mjs';
import { Engine } from './schedule-services.mjs';
import type {
  NimbusBlock,
  NimbusLineSetting,
  NimbusMasterData,
  NimbusPlantBlock,
  NimbusTask,
  OptimizerMode,
  PriorityRankMaps,
  WorkHours,
} from './types.mjs';

export interface SchedulePatch {
  id: string;
  changes: Partial<NimbusTask>;
}

/** All reads needed for one candidate run.  The evaluator treats every field
 * as immutable and never fills missing calendar defaults back into this object. */
export interface ScheduleSnapshot {
  tasks: ReadonlyArray<NimbusTask>;
  fixedIds: ReadonlySet<string> | ReadonlyArray<string>;
  alerts: ReadonlyArray<unknown>;
  selectedPlant: string | null;
  blocks: ReadonlyArray<NimbusBlock>;
  plantBlocks: ReadonlyArray<NimbusPlantBlock>;
  calendars: Readonly<Record<string, { workHours: WorkHours }>>;
  plants: Readonly<Record<string, { workHours: WorkHours }>>;
  lineSettings: Readonly<Record<string, NimbusLineSetting>>;
  masterData: NimbusMasterData | null;
  priorityRankMaps: PriorityRankMaps;
}

export interface EvaluationRequest {
  mode?: OptimizerMode;
  plant?: string | null;
  lines?: ReadonlyArray<string> | null;
  startDate?: Date | string | number | null;
  endDate?: Date | string | number | null;
  respectFixed?: boolean;
  respectCalendar?: boolean;
  /** Tests and callers that need deterministic candidate placement supply this. */
  now?: Date;
}

export interface CandidateReason {
  code: string;
  message: string;
  line?: string;
  taskId?: string;
}

/** A non-persistent diagnostic produced while evaluating one detached candidate. */
export interface CandidateDiagnostic {
  level: 'warn' | 'error';
  scope: string;
  code: string;
  message: string;
  context: Readonly<Record<string, unknown>>;
}

export interface SearchDiagnostics {
  candidateCount: number;
  method: 'legacy-detached';
  termination: 'completed' | 'no-plant';
  runtimeMs: number;
  limitReached: boolean;
  events: ReadonlyArray<CandidateDiagnostic>;
}

export interface MissingSetupEdge {
  line: string;
  predecessorOrderId?: string | null;
  successorOrderId?: string | null;
  reason: string;
}

export interface CandidateResult {
  patches: ReadonlyArray<SchedulePatch>;
  score: readonly number[];
  explanation: ReadonlyArray<CandidateReason>;
  diagnostics: SearchDiagnostics;
  unchangedLines: readonly string[];
  missingEdges: readonly MissingSetupEdge[];
  /** Compatibility detail consumed only by the existing backlog-preview UI. */
  backlogResult?: RemoveBacklogResult;
}

/**
 * Evaluate against the existing placement algorithm, but with its reads bound
 * to `snapshot`.  The Engine adapter shares the legacy mode implementation;
 * it emits patches and never applies them while evaluating a candidate.
 */
export function evaluateSchedule(snapshot: Readonly<ScheduleSnapshot>, request: EvaluationRequest = {}): CandidateResult {
  const { mode = 'combined', ...opts } = request;
  return Engine.evaluateSchedule(mode, opts, snapshot);
}

/** Apply a detached patch set to detached task values for before/after
 * comparison.  The original snapshot and task objects are never changed. */
export function applyPatchesToSnapshot(tasks: ReadonlyArray<NimbusTask>, patches: ReadonlyArray<SchedulePatch>): NimbusTask[] {
  const byId = new Map(patches.map(patch => [String(patch.id), patch.changes]));
  return tasks.map(task => {
    const changes = byId.get(String(task.id));
    return changes ? { ...structuredClone(task), ...structuredClone(changes) } : structuredClone(task);
  });
}
