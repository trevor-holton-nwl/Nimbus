/**
 * Pure speed model for the Gantt's item-drag edge auto-scroll (no imports, no DOM, no Store). The caller
 * (`Interaction._edgeScrollTick`, gantt.mts) feeds it the last pointer position, the centre panel's rect, the
 * visible span and the frame time; it answers how far to shift the window (ms) and the content (px).
 *
 * Model: inside an 80 px zone along an edge the speed ramps with the SQUARE of how deep the pointer is
 * (fraction 0..1); a pointer OUTSIDE the panel on that side is full speed. Full speed is 0.6 of the span
 * (or of the panel height) per second. Vertical scroll only happens when no side zone is active and the drag
 * set is a single order.
 */
export const EDGE_ZONE_PX = 80;
export const EDGE_MAX_SPEED_PER_S = 0.6;
/** A drag must be this old before the loop scrolls, so grabbing a bar near the edge does not move the view. */
export const EDGE_ARM_MS = 150;
/** A long frame (tab throttled, GC pause) must not become a window jump. */
export const EDGE_MAX_DT_MS = 100;

export interface EdgeRect { left: number; right: number; top: number; bottom: number }

export interface EdgeScrollInput {
  x: number;
  y: number;
  /** The vis centre panel's client rect (the timeline body without the machine-label column). */
  rect: EdgeRect;
  spanMs: number;
  widthPx: number;
  dtMs: number;
  /** More than one order is being dragged: no vertical scroll. */
  multi: boolean;
}

export interface EdgeScrollOutput {
  /** Signed ms to add to both window edges (negative = earlier). 0 when nothing scrolls. */
  shiftMs: number;
  /** Signed px to scroll the content DOWN by (negative = up). 0 when nothing scrolls. */
  vPx: number;
}

/** How deep into the `zonePx` band the coordinate is, 0..1; 1 at or beyond the panel edge. `lo`/`hi` are the panel
 *  edges; returns a negative fraction on the low side, positive on the high side, 0 in the middle. */
export function edgeFraction(p: number, lo: number, hi: number, zonePx = EDGE_ZONE_PX): number {
  if (!Number.isFinite(p)) return 0;
  const zone = Math.max(1, Math.min(zonePx, (hi - lo) / 2));
  if (p < lo + zone) return -Math.min(1, (lo + zone - p) / zone);
  if (p > hi - zone) return Math.min(1, (p - (hi - zone)) / zone);
  return 0;
}

export function edgeScrollStep(i: EdgeScrollInput): EdgeScrollOutput {
  const none: EdgeScrollOutput = { shiftMs: 0, vPx: 0 };
  const { rect } = i;
  if (!(i.spanMs > 0) || !(i.widthPx > 0) || !(rect.right > rect.left) || !(rect.bottom > rect.top)) return none;
  const dtSec = Math.max(0, Math.min(Number.isFinite(i.dtMs) ? i.dtMs : 0, EDGE_MAX_DT_MS)) / 1000;
  if (dtSec === 0) return none;
  const hf = edgeFraction(i.x, rect.left, rect.right);
  if (hf !== 0) {
    const mag = hf * hf;   // squared ramp, sign restored below
    return { shiftMs: Math.sign(hf) * mag * EDGE_MAX_SPEED_PER_S * i.spanMs * dtSec, vPx: 0 };
  }
  if (i.multi) return none;
  const vf = edgeFraction(i.y, rect.top, rect.bottom);
  if (vf === 0) return none;
  return { shiftMs: 0, vPx: Math.sign(vf) * vf * vf * EDGE_MAX_SPEED_PER_S * (rect.bottom - rect.top) * dtSec };
}

/** The `initialX` correction that keeps dragged bars under the pointer after the window moved `shiftMs`:
 *  vis reads the drag offset as toTime(pointerX) - toTime(initialX) against the CURRENT window, so initialX has
 *  to move by the pixels the window scrolled (subtract the returned value). */
export function initialXShiftPx(shiftMs: number, spanMs: number, widthPx: number): number {
  if (!(spanMs > 0) || !(widthPx > 0) || !Number.isFinite(shiftMs)) return 0;
  return shiftMs * (widthPx / spanMs);
}
