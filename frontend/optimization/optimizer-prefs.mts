// optimization/optimizer-prefs.mjs — the ONE list of optimizer strategies and
// seedable time-window presets, shared by the Optimize dialog (optimize-ui.mts)
// and the User Settings > Workflow pane (shell/application-shell.mts) so the two
// can never disagree again. Zero imports on purpose: both sides import this leaf
// without adding an edge to any import cycle.
import type { OptimizerMode } from '../platform/types.mjs';

/** Strategies in picker order; `labelKey` is the shared locale key (en/de/es/fr/pt). */
export const OPTIMIZER_MODES: ReadonlyArray<{ value: OptimizerMode; labelKey: string }> = [
  { value: 'spt',        labelKey: 'us.opt_mode_spt' },
  { value: 'changeover', labelKey: 'us.opt_mode_changeover' },
  { value: 'duedate',    labelKey: 'us.opt_mode_duedate' },
  { value: 'backlog',    labelKey: 'us.opt_mode_backlog' },
];

/** Presets that seed cleanly from a saved default (custom needs explicit dates). */
export const OPTIMIZER_SEED_PRESETS: readonly string[] = ['horizon', '2w'];

export const DEFAULT_OPTIMIZER_MODE: OptimizerMode = 'changeover';
export const DEFAULT_OPTIMIZER_PRESET = 'horizon';

export function isOptimizerMode(v: unknown): v is OptimizerMode {
  return typeof v === 'string' && OPTIMIZER_MODES.some(m => m.value === v);
}

/** A saved mode if it is a known one, else the default. Never rewrites a valid value. */
export function seedOptimizerMode(saved: unknown): OptimizerMode {
  return isOptimizerMode(saved) ? saved : DEFAULT_OPTIMIZER_MODE;
}

/** A saved preset if it can seed the dialog, else the default. */
export function seedOptimizerPreset(saved: unknown): string {
  return (typeof saved === 'string' && OPTIMIZER_SEED_PRESETS.includes(saved)) ? saved : DEFAULT_OPTIMIZER_PRESET;
}
