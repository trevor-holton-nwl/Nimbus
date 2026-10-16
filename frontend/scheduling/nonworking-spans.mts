// scheduling/nonworking-spans.mjs — pure builder for the Gantt's non-working-time shading.
// No DOM, no vis, no Store: the caller supplies `windowFor(dayStart)` (the plant's working
// window on that local day, or null when closed) and gets back the merged grey spans.
// Day stepping is always setDate(+1) on a local Date — never + 86_400_000 ms, which drifts
// off midnight across a DST transition.

export interface Span { start: Date; end: Date }

export interface NonWorkingSpanResult { spans: Span[]; truncated: boolean }

export interface NonWorkingSpanOptions {
  /** Coarse mode: an open day counts as fully open (only closed days are shaded). */
  closedDaysOnly?: boolean;
  /** Maximum spans returned (default 600); the far end is dropped. */
  cap?: number;
}

const DEFAULT_CAP = 600;

export function buildNonWorkingSpans(
  fromMs: number,
  toMs: number,
  windowFor: (dayStart: Date) => [Date, Date] | null,
  opts: NonWorkingSpanOptions = {},
): NonWorkingSpanResult {
  const cap = opts.cap ?? DEFAULT_CAP;
  const spans: Span[] = [];
  let open: Date | null = null;
  let day = new Date(fromMs);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() < toMs) {
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    let win = windowFor(day);
    if (win && win[0].getTime() >= win[1].getTime()) win = null;   // degenerate -> closed
    if (win && opts.closedDaysOnly) win = [day, next];
    if (!win) {
      if (open == null) open = day;
    } else {
      if (win[0].getTime() > day.getTime()) {
        if (open == null) open = day;
        spans.push({ start: open, end: win[0] });
        open = null;
      } else if (open != null) {
        spans.push({ start: open, end: day });
        open = null;
      }
      if (win[1].getTime() < next.getTime()) open = win[1];
    }
    day = next;
  }
  if (open != null) spans.push({ start: open, end: day });
  if (spans.length > cap) return { spans: spans.slice(0, cap), truncated: true };
  return { spans, truncated: false };
}
