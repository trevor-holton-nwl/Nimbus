// Pure day-stepper logic shared by the Dashboard Machine Status card and the Gantt Machines pane.
// Leaf module: imports only foundation, so scheduling and insights can both use it without importing each other.
import { Util } from './foundation.mjs';

/** The 7 day keys the 7-day utilization matrix covers, starting at plant-today (mirrors computeMatrix's key build). */
export function dayStepKeys(now: Date): string[] {
  const start = Util.startOfDay(now)!;
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i);
    return Util.dayKey(d);
  });
}

/** The day to show: the stored key clamped into [today, today+6]; null -> today. */
export function dayStepActive(keys: string[], key: string | null): string {
  if (!key || key < keys[0]) return keys[0];
  if (key > keys[keys.length - 1]) return keys[keys.length - 1];
  return key;
}

/** One step of +/-1 day from the stored key, clamped into the window. */
export function dayStepNext(keys: string[], key: string | null, dir: number): string {
  const idx = Math.max(0, Math.min(keys.length - 1, keys.indexOf(dayStepActive(keys, key)) + (dir < 0 ? -1 : 1)));
  return keys[idx];
}

export function dayStepLabel(key: string, keys: string[]): string {
  if (key === keys[0]) return Util.t('ui.today');
  if (key === keys[1]) return Util.t('ui.tomorrow');
  return Util.fmtDayLabelPref(new Date(key + 'T12:00:00'));
}
