// calendar/calendar-periods.mjs — pure helpers for the Plant > Calendar tab's
// dated periods (docs/CALENDAR_PERIODS_DESIGN.md). No DOM, no Store, no Util:
// day keys are plain 'YYYY-MM-DD' strings (compared as strings, which sorts
// chronologically), `validTo === null` means open-ended (+infinity), and every
// piece of text that needs a locale (month names, "Closed") is supplied by the
// caller. The UI module (calendar-periods-ui.mts) and the editor
// (edit-calendar.mts) own all rendering.
import type { PlantPeriod, WorkHours } from '../platform/types.mjs';

export type PeriodStatus = 'active' | 'upcoming' | 'past';

export interface PeriodDraft {
  id: string;
  name: string;
  validFrom: string;
  validTo: string | null;
  workHours: WorkHours;
}

export interface PeriodIssue {
  field: 'name' | 'from' | 'to' | 'overlap';
  /** Suffix of the `err.<code>` locale key. */
  code: 'period_name_required' | 'period_from_required' | 'period_to_required' | 'period_to_before_from' | 'period_overlap';
  params?: { name: string; from: string; to: string | null };
}

export interface WeekSummary { short: string; full: string }
export interface WeekSummaryOpts { closed?: string; closedAll?: string }

export interface StripSegment {
  id: string;
  name: string;
  status: PeriodStatus;
  leftPct: number;
  widthPct: number;
  openEnded: boolean;
  fromKey: string;
  toKey: string | null;
}
export interface PeriodStrip {
  axisStartKey: string;
  axisEndKey: string;
  segments: StripSegment[];
  today: { leftPct: number };
  ticks: Array<{ leftPct: number; label: string }>;
}
export interface PeriodStripOpts { fmtMonth?: (date: Date) => string }

/** One blackout reduced to inclusive local day keys (the caller derives them; this module stays Util-free). */
export interface BlackoutItem { id: string; fromKey: string; toKey: string }
/** A run of blackouts that touch or overlap, drawn as one marker on the timeline lane. */
export interface BlackoutMark {
  ids: string[];
  /** Clipped to the axis, inclusive. */
  fromKey: string;
  toKey: string;
  leftPct: number;
  widthPct: number;
}
export interface BlackoutMarks { marks: BlackoutMark[]; truncated: number }

/** Most markers the lane draws; beyond this the rest are counted, not drawn. */
export const MAX_BLACKOUT_MARKS = 60;

const MS_DAY = 86400000;
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Days since the epoch for a 'YYYY-MM-DD' key (UTC arithmetic, so DST never shifts a day). */
export function dayIndex(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
}

/** Inverse of dayIndex. */
export function keyFromIndex(idx: number): string {
  const dt = new Date(idx * MS_DAY);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Day key shifted by `n` calendar days (negative allowed). */
export function addDaysKey(key: string, n: number): string {
  return keyFromIndex(dayIndex(key) + n);
}

/** Local-midnight Date for a day key, for display through the per-user date format. */
export function keyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Where a period sits relative to today: not started yet, finished, or covering today. */
export function periodStatus(p: { validFrom: string; validTo: string | null }, todayKey: string): PeriodStatus {
  if (p.validFrom > todayKey) return 'upcoming';
  if (p.validTo !== null && p.validTo < todayKey) return 'past';
  return 'active';
}

function fmtHour(h: number): string {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60), mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** One-line weekly summary in Mon...Sun order. `dayLabels` is indexed 0=Sun..6=Sat (the
 *  `day.*` locale order). Consecutive days with identical hours collapse into a run:
 *  "Mon–Thu 01:00–13:00 · Fri 06:00–14:00 · Sat–Sun Closed". `short` keeps the first two
 *  groups and appends " +N" for the rest. */
export function summarizeWeek(workHours: WorkHours, dayLabels: string[], opts: WeekSummaryOpts = {}): WeekSummary {
  const closed = opts.closed ?? 'Closed';
  const closedAll = opts.closedAll ?? 'Closed all week';
  const order = [1, 2, 3, 4, 5, 6, 0];
  const range = (d: number) => workHours?.[d] ?? null;
  if (order.every(d => !range(d))) return { short: closedAll, full: closedAll };

  const groups: Array<{ days: number[]; text: string }> = [];
  for (const d of order) {
    const r = range(d);
    const text = r ? `${fmtHour(r[0])}–${fmtHour(r[1])}` : closed;
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.days.push(d);
    else groups.push({ days: [d], text });
  }
  const parts = groups.map(g => {
    const first = dayLabels[g.days[0]] ?? '';
    const lastLabel = dayLabels[g.days[g.days.length - 1]] ?? '';
    const days = g.days.length === 1 ? first : `${first}–${lastLabel}`;
    return `${days} ${g.text}`;
  });
  const full = parts.join(' · ');
  const short = parts.length > 2 ? `${parts.slice(0, 2).join(' · ')} +${parts.length - 2}` : full;
  return { short, full };
}

function spanDays(from: string, to: string): number {
  return dayIndex(to) - dayIndex(from);
}

/** Validate a draft against the plant's other periods. Dates are inclusive on both ends, so a
 *  shared end day overlaps and an open-ended period overlaps everything starting after it.
 *  Only the first conflicting period (by start date) is reported. */
export function validatePeriodDraft(draft: PeriodDraft, existing: PlantPeriod[]): PeriodIssue[] {
  const issues: PeriodIssue[] = [];
  if (!String(draft.name ?? '').trim()) issues.push({ field: 'name', code: 'period_name_required' });
  if (!draft.validFrom) issues.push({ field: 'from', code: 'period_from_required' });
  // '' is an empty Valid-to picker with "No end date" unticked; null is the open-ended period.
  if (draft.validTo === '') issues.push({ field: 'to', code: 'period_to_required' });
  const datesOk = !!draft.validFrom && draft.validTo !== '' && (draft.validTo === null || draft.validTo >= draft.validFrom);
  if (draft.validFrom && draft.validTo && draft.validTo < draft.validFrom) {
    issues.push({ field: 'to', code: 'period_to_before_from' });
  }
  if (datesOk) {
    const others = existing.filter(p => p.id !== draft.id)
      .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
    const hit = others.find(p =>
      draft.validFrom <= (p.validTo ?? '9999-12-31') && p.validFrom <= (draft.validTo ?? '9999-12-31'));
    if (hit) {
      issues.push({ field: 'overlap', code: 'period_overlap', params: { name: hit.name, from: hit.validFrom, to: hit.validTo } });
    }
  }
  return issues;
}

/** Non-blocking advice: a period that closes every day and runs open-ended or for more than
 *  90 days is probably a mistake (a long shutdown is better modelled as a blackout). */
export function periodWarnings(draft: PeriodDraft): Array<'all_closed_long'> {
  const wh = draft.workHours ?? {};
  const allClosed = [0, 1, 2, 3, 4, 5, 6].every(d => !wh[d]);
  if (!allClosed) return [];
  if (draft.validTo === null) return ['all_closed_long'];
  if (draft.validFrom && spanDays(draft.validFrom, draft.validTo) > 90) return ['all_closed_long'];
  return [];
}

/** Axis and segment geometry for the timeline strip, as raw percentages of the axis. */
export function buildPeriodStrip(periods: PlantPeriod[], todayKey: string, opts: PeriodStripOpts = {}): PeriodStrip {
  const fmtMonth = opts.fmtMonth ?? ((d: Date) => EN_MONTHS[d.getMonth()]);
  const todayIdx = dayIndex(todayKey);
  const fromIdxs = periods.map(p => dayIndex(p.validFrom));
  const endIdxs = periods.map(p => (p.validTo === null ? dayIndex(p.validFrom) + 90 : dayIndex(p.validTo)));
  // Start: 30 days back or the earliest period start, but never more than a year back (mirrors the end cap below);
  // older segments are drawn clipped at the left edge with their title intact.
  const startIdx = Math.max(Math.min(todayIdx - 30, ...fromIdxs), todayIdx - 365);
  const lastEnd = endIdxs.length ? Math.max(...endIdxs) : todayIdx;
  const endIdx = Math.min(Math.max(lastEnd, todayIdx + 365), todayIdx + 730);
  const total = endIdx - startIdx + 1;
  const pct = (n: number) => (n / total) * 100;

  const segments: StripSegment[] = periods.map(p => {
    const openEnded = p.validTo === null;
    const fromIdx = Math.max(Math.min(dayIndex(p.validFrom), endIdx), startIdx);
    const toIdx = openEnded ? endIdx : Math.max(Math.min(dayIndex(p.validTo as string), endIdx), fromIdx);
    return {
      id: p.id,
      name: p.name,
      status: periodStatus(p, todayKey),
      leftPct: pct(fromIdx - startIdx),
      widthPct: pct(toIdx - fromIdx + 1),
      openEnded,
      fromKey: p.validFrom,
      toKey: p.validTo,
    };
  });

  const quarterly = total > 700;
  const ticks: PeriodStrip['ticks'] = [];
  const startDate = new Date(startIdx * MS_DAY);
  let y = startDate.getUTCFullYear(), m = startDate.getUTCMonth();
  // The axis is bounded (<= ~3 years), so the loop runs to its end rather than a fixed month count.
  for (;;) {
    const idx = Math.round(Date.UTC(y, m, 1) / MS_DAY);
    if (idx > endIdx) break;
    if (idx >= startIdx && (!quarterly || m % 3 === 0)) {
      const label = fmtMonth(new Date(y, m, 1));
      ticks.push({ leftPct: pct(idx - startIdx), label: m === 0 ? `${label} ${y}` : label });
    }
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }

  return {
    axisStartKey: keyFromIndex(startIdx),
    axisEndKey: keyFromIndex(endIdx),
    segments,
    today: { leftPct: pct(todayIdx - startIdx) },
    ticks,
  };
}

/** Marker geometry for plant blackouts over the strip's axis. Each item is clipped to the axis
 *  (dropped when wholly outside), then items that overlap or sit on adjacent days merge into one
 *  cluster so dense holiday runs stay readable. Only the first MAX_BLACKOUT_MARKS clusters in time
 *  order are returned; `truncated` counts the rest. Keys are inclusive 'YYYY-MM-DD' day keys. */
export function buildBlackoutMarks(strip: Pick<PeriodStrip, 'axisStartKey' | 'axisEndKey'>, items: BlackoutItem[]): BlackoutMarks {
  const startIdx = dayIndex(strip.axisStartKey);
  const endIdx = dayIndex(strip.axisEndKey);
  const total = endIdx - startIdx + 1;
  const clipped: Array<{ id: string; from: number; to: number }> = [];
  for (const it of items) {
    if (!it.fromKey || !it.toKey) continue;
    const from = Math.max(dayIndex(it.fromKey), startIdx);
    const to = Math.min(dayIndex(it.toKey), endIdx);
    if (to < from) continue;
    clipped.push({ id: it.id, from, to });
  }
  clipped.sort((a, b) => a.from - b.from || a.to - b.to);
  const clusters: Array<{ ids: string[]; from: number; to: number }> = [];
  for (const c of clipped) {
    const last = clusters[clusters.length - 1];
    if (last && c.from - last.to <= 1) {
      last.ids.push(c.id);
      if (c.to > last.to) last.to = c.to;
    } else {
      clusters.push({ ids: [c.id], from: c.from, to: c.to });
    }
  }
  const marks: BlackoutMark[] = clusters.slice(0, MAX_BLACKOUT_MARKS).map(c => ({
    ids: c.ids,
    fromKey: keyFromIndex(c.from),
    toKey: keyFromIndex(c.to),
    leftPct: ((c.from - startIdx) / total) * 100,
    widthPct: ((c.to - c.from + 1) / total) * 100,
  }));
  return { marks, truncated: Math.max(0, clusters.length - MAX_BLACKOUT_MARKS) };
}

/** Defaults for "Add period": starts today, or the day after the latest existing end if that is
 *  later, and runs one week (from + 6 days, inclusive). */
export function nextPeriodDefaults(existing: PlantPeriod[], todayKey: string): { validFrom: string; validTo: string } {
  let from = todayKey;
  for (const p of existing) {
    if (p.validTo !== null) {
      const next = addDaysKey(p.validTo, 1);
      if (next > from) from = next;
    }
  }
  return { validFrom: from, validTo: addDaysKey(from, 6) };
}
