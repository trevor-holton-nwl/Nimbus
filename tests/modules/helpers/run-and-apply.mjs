// Test-only stand-in for the deleted live `Engine.runAndApply` (P3-3b). The optimizer is detached now:
// evaluate a plant-scoped snapshot, then (unless the candidate carries a blocking error finding, which the old live
// path also refused to apply) commit the patches in one `applySchedulePatches` call. Toasts, the Undo entry and the
// Alerts refresh the old tail raised are not reproduced; the Optimize preview's Apply owns those.
import { Engine, snapshotSchedule, applySchedulePatches } from '../../../frontend/optimization/engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

export function runAndApply(mode, opts = {}) {
  const plant = opts.plant ?? Store.selectedPlant ?? undefined;
  const result = Engine.evaluateSchedule(mode, opts, snapshotSchedule(plant));
  if (!result.validationFindings?.some(finding => finding.severity === 'error')) applySchedulePatches(result.patches);
  return result;
}
