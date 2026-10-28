// optimization/headless-writer.mts: the pure, Store-free half of "apply an optimizer result without a browser".
//
//  - `patchesToUpdateItems` turns optimizer patches into `POST /tasks/update` items shaped like
//    `Persistence._taskEditSnapshot` (local-second dates, segments, planning status and reason, `source`, the
//    row version as `base_version`), minus RUN_TIME / MACHINE / PRT / PV: the optimizer never changes those.
//  - `planApply` is the stale-write guard. A run takes minutes and planners keep saving, so before anything is
//    written the caller rebuilds a snapshot from a FRESH bundle and hands it here: every patch whose order row
//    changed since the run (different `row_version`, or gone, or now running) is dropped together with its
//    distribution family, the survivors are re-validated against the live board with the same checks the
//    preview's Apply uses (`validateCandidate`, pruning on findings as `_pruneAgainstLive` does), and the final
//    set is checked with `validateCandidateForApply`. Nothing here ever forces a write.
import { Util } from '../platform/foundation.mjs';
import type { NimbusTask } from '../platform/types.mjs';
import { Engine } from './engine.mjs';
import { applyPatchesToSnapshot, validateCandidate, validateCandidateForApply } from './setup-scheduler.mjs';
import type { CandidateResult, SchedulePatch, ScheduleSnapshot, ValidationFinding } from './setup-scheduler.mjs';

/** One `TaskDateUpdate` as the browser's save sends it (backend/scheduling/models.py), optimizer flavour. */
export interface TaskDateUpdateItem {
  id: string;
  planning_status?: string;
  planning_reason?: Record<string, unknown> | null;
  placement_exception?: 'overtime' | 'overlong' | null;
  start_date?: string | null;
  end_date?: string | null;
  schedule_segments?: Array<{ sequence: number; start_date: string; end_date: string }>;
  source: 'optimizer';
  base_version: number | null;
  force: false;
}

/** Mirrors `Persistence._taskEditSnapshot` for an optimizer-written row. A patch that gives both edges is a
 *  placement (Store._markPlaced would flag the row placed on apply), so its dates are always sent. */
export function patchesToUpdateItems(
  tasks: ReadonlyArray<NimbusTask>, patches: ReadonlyArray<SchedulePatch>,
): TaskDateUpdateItem[] {
  const before = new Map(tasks.map(task => [String(task.id), task]));
  const after = new Map(applyPatchesToSnapshot(tasks, patches).map(task => [String(task.id), task]));
  const items: TaskDateUpdateItem[] = [];
  for (const patch of patches) {
    const id = String(patch.id);
    const t = after.get(id);
    const original = before.get(id);
    if (!t || !original) continue;
    const placedByPatch = !!patch.changes.start_date && !!patch.changes.end_date;
    const displayOnly = !placedByPatch && !t.user_scheduled && t.planning_status !== 'needs_planning';
    const item: TaskDateUpdateItem = {
      id,
      ...(displayOnly ? {} : { planning_status: t.planning_status ?? 'scheduled', planning_reason: (t.planning_reason ?? null) as Record<string, unknown> | null }),
      ...(t.placement_exception !== undefined ? { placement_exception: t.placement_exception } : {}),
      ...(displayOnly ? {} : {
        start_date: t.start_date ? Util.toLocalSeconds(t.start_date) : null,
        end_date: t.end_date ? Util.toLocalSeconds(t.end_date) : null,
        schedule_segments: (t.scheduleSegments || []).map(segment => ({
          sequence: segment.sequence,
          start_date: Util.toLocalSeconds(segment.startDate),
          end_date: Util.toLocalSeconds(segment.endDate),
        })),
      }),
      source: 'optimizer',
      base_version: original.row_version ?? null,
      force: false,
    };
    items.push(item);
  }
  return items;
}

/** The `POST /tasks/update` body: one atomic batch, never forced, conflicts rejected whole. */
export function buildApplyBody(items: ReadonlyArray<TaskDateUpdateItem>, jobId: string | number): {
  tasks: TaskDateUpdateItem[]; client_id: string; atomic_optimizer: true; strict_conflicts: true;
} {
  return { tasks: [...items], client_id: `job:${jobId}`, atomic_optimizer: true, strict_conflicts: true };
}

export type DropReason = 'row_version_changed' | 'row_missing' | 'running' | 'family' | 'validation';

export interface DroppedPatch { id: string; reason: DropReason }

export interface ApplyPlan {
  /** Patches that still fit the live board (a subset of the candidate's, same objects). */
  apply: SchedulePatch[];
  dropped: DroppedPatch[];
  /** `validateCandidateForApply` on the final set against the live snapshot. */
  findings: ValidationFinding[];
  /** False when the survivors cannot be made safe (no validation context, an unresolvable collision, a finding on
   *  the final set): the caller applies nothing and fails the run. */
  ok: boolean;
  refusal?: string;
}

/** Plan a stale-safe apply. `runSnapshot` is the snapshot the run optimized; `liveSnapshot` is built (and derived)
 *  from a freshly fetched bundle; `candidate` must carry its `validationContext`; `now` is the plant's wall clock. */
export function planApply(args: {
  candidate: CandidateResult;
  runSnapshot: ScheduleSnapshot;
  liveSnapshot: ScheduleSnapshot;
  now: Date;
}): ApplyPlan {
  const { candidate, runSnapshot, liveSnapshot, now } = args;
  const patches = candidate.patches;
  const runById = new Map(runSnapshot.tasks.map(task => [String(task.id), task]));
  const liveById = new Map(liveSnapshot.tasks.map(task => [String(task.id), task]));
  const parentKey = (task: NimbusTask | undefined): string | null =>
    task?.PARENT_ORDER ? `${task.PARENT_ORDER}\u0000${task.MATERIAL_NUMBER ?? ''}` : null;

  const dropped = new Map<string, DropReason>();
  const familyOf = new Map<string, string[]>();
  for (const patch of patches) {
    const id = String(patch.id);
    const key = parentKey(runById.get(id) ?? liveById.get(id));
    if (key) familyOf.set(key, [...(familyOf.get(key) ?? []), id]);
  }
  const dropWithFamily = (id: string, reason: DropReason): void => {
    if (!dropped.has(id)) dropped.set(id, reason);
    const key = parentKey(runById.get(id) ?? liveById.get(id));
    if (key) for (const sibling of familyOf.get(key) ?? []) if (!dropped.has(sibling)) dropped.set(sibling, 'family');
  };

  for (const patch of patches) {
    const id = String(patch.id);
    const live = liveById.get(id);
    const ran = runById.get(id);
    if (!live) { dropWithFamily(id, 'row_missing'); continue; }
    // null === null: a never-versioned row that is still never-versioned has not changed.
    if ((live.row_version ?? null) !== (ran?.row_version ?? null)) { dropWithFamily(id, 'row_version_changed'); continue; }
    if (Engine.isInProgress(live, now)) dropWithFamily(id, 'running');
  }

  const context = candidate.validationContext;
  const refuse = (refusal: string): ApplyPlan => ({
    apply: [], dropped: [...dropped].map(([id, reason]) => ({ id, reason })), findings: [], ok: false, refusal,
  });
  if (!context) return refuse('no_validation_context');

  const keyOf = (finding: ValidationFinding): string => `${finding.code}|${finding.taskId}|${finding.message}`;
  const errorsFor = (set: SchedulePatch[]): ValidationFinding[] => {
    const ids = new Set(set.map(patch => String(patch.id)));
    return validateCandidate(liveSnapshot, context.bounds, {
      ...candidate, patches: set,
      dispositions: candidate.dispositions?.filter(item => ids.has(String(item.id))),
    }).filter(finding => finding.severity === 'error' && finding.code !== 'stale_candidate');
  };
  // Defects the live board already has with no patch at all are not this run's doing.
  const baseline = new Set(errorsFor([]).map(keyOf));
  let kept = patches.filter(patch => !dropped.has(String(patch.id)));
  const maxPasses = Math.min(8, kept.length);
  for (let pass = 0; pass < maxPasses; pass++) {
    const findings = errorsFor(kept);
    if (!findings.length) break;
    if (findings.some(finding => !finding.taskId)) return refuse('finding_without_order');
    const keptIds = new Set(kept.map(patch => String(patch.id)));
    let changed = false;
    for (const finding of findings) {
      const id = String(finding.taskId);
      if (keptIds.has(id)) { if (!dropped.has(id)) { dropWithFamily(id, 'validation'); changed = true; } continue; }
      if (finding.code === 'segments' || baseline.has(keyOf(finding))) continue;
      // A new collision with an order this run does not write: the kept patches on its line that meet it go.
      const other = liveById.get(id);
      const oStart = other?.start_date?.getTime(); const oEnd = other?.end_date?.getTime();
      const onLine = kept.filter(patch => !dropped.has(String(patch.id)) && liveById.get(String(patch.id))?.MACHINE === other?.MACHINE);
      const range = (patch: SchedulePatch): [number, number] | null => {
        const a = patch.changes.start_date?.getTime(); const b = patch.changes.end_date?.getTime();
        return a === undefined || b === undefined ? null : [a, b];
      };
      let hits = oStart === undefined || oEnd === undefined ? [] : onLine.filter(patch => {
        const r = range(patch);
        return !!r && r[0] < oEnd && oStart < r[1];
      });
      // No overlap: the kept patch placed immediately before it changed its incoming setup (the preview's fallback).
      if (!hits.length && oStart !== undefined) {
        const before = onLine.flatMap(patch => { const r = range(patch); return r && r[1] <= oStart ? [{ patch, end: r[1] }] : []; })
          .sort((a, b) => b.end - a.end)[0];
        if (before) hits = [before.patch];
      }
      if (!hits.length) return refuse('unresolvable_collision');
      for (const hit of hits) dropWithFamily(String(hit.id), 'validation');
      changed = true;
    }
    if (!changed) break;
    if (pass === maxPasses - 1) return refuse('validation_did_not_settle');
    kept = patches.filter(patch => !dropped.has(String(patch.id)));
  }
  kept = patches.filter(patch => !dropped.has(String(patch.id)));
  // Nothing dropped: the whole candidate is checked as the preview's Apply checks it. After a drop the dispositions
  // of the dropped orders no longer describe the kept set, so accounting (which compares them) is not meaningful.
  const droppedAny = dropped.size > 0;
  const finalCandidate: CandidateResult = droppedAny
    ? { ...candidate, patches: kept, dispositions: candidate.dispositions?.filter(item => kept.some(p => String(p.id) === String(item.id))) }
    : candidate;
  const findings = validateCandidateForApply(finalCandidate, liveSnapshot)
    .filter(finding => !(finding.code === 'stale_candidate' && finding.severity === 'error'));
  const blocking = findings.filter(finding => finding.severity === 'error' && !(droppedAny && (finding.code === 'accounting' || baseline.has(keyOf(finding)))));
  return {
    apply: kept,
    dropped: [...dropped].map(([id, reason]) => ({ id, reason })),
    findings,
    ok: blocking.length === 0,
    ...(blocking.length ? { refusal: `final_validation:${blocking[0].code}` } : {}),
  };
}
