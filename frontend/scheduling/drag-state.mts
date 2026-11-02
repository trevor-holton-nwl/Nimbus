/**
 * Pure item-drag gesture state for the Gantt. vis-timeline emits no timechange events for item drags, so the
 * gesture is bracketed with hooks that do fire: the first `onMoving` frame begins it; document pointerup /
 * pointercancel (and, defensively, the dropped item's DataSet update) end it. `end()` is idempotent and returns
 * true only on the active -> idle edge, so end-of-drag work (a deferred calendar refresh) runs once per gesture.
 */
export interface DragGate {
  readonly active: boolean;
  /** Mark a gesture as started (no-op while already active). Returns true on the idle -> active edge. */
  begin(): boolean;
  /** Mark it finished. Returns true on the active -> idle edge, false when nothing was in flight. */
  end(): boolean;
}

export function createDragGate(): DragGate {
  let active = false;
  return {
    get active() { return active; },
    begin() { if (active) return false; active = true; return true; },
    end() { if (!active) return false; active = false; return true; },
  };
}
