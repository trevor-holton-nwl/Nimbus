// scheduling/gantt-lanes.mts — PURE lane assignment behind the Gantt's "expand one row" view.
// No imports, no Store, no DOM. Input is one line's order intervals; output is which lane each
// parent order sits in and how deep the row stacks.
//
// Rules (docs: frontend/scheduling/CLAUDE.md, "Expandable rows"):
//  - Greedy partitioning per PARENT ORDER, in earliest-start order (ties broken by id, so the
//    result is stable). An order takes the first lane where none of its intervals overlaps any
//    interval already in that lane.
//  - Overlap is strict: back-to-back orders (a.end === b.start) do NOT overlap.
//  - All segments of one split order share one lane (the order is placed as a unit).

export interface LaneInterval {
  /** The logical order this interval belongs to (segments share one parentId). */
  parentId: string;
  startMs: number;
  endMs: number;
}

export interface LaneResult {
  /** parentId -> 0-based lane index. */
  laneByParent: Map<string, number>;
  /** Number of lanes used (>= 1 when the input is non-empty; 0 for empty input). */
  maxDepth: number;
}

interface LaneState {
  intervals: Array<[number, number]>;
  maxEnd: number;
}

export function laneId(index: number): string {
  return `lane-${index}`;
}

export function computeLaneMap(intervals: ReadonlyArray<LaneInterval>): LaneResult {
  const byParent = new Map<string, Array<[number, number]>>();
  for (const iv of intervals) {
    if (!Number.isFinite(iv.startMs) || !Number.isFinite(iv.endMs)) continue;
    let list = byParent.get(iv.parentId);
    if (!list) { list = []; byParent.set(iv.parentId, list); }
    list.push([iv.startMs, iv.endMs]);
  }
  const parents = [...byParent.entries()].map(([parentId, list]) => {
    let min = Infinity;
    for (const [s] of list) if (s < min) min = s;
    return { parentId, list, min };
  });
  parents.sort((a, b) => (a.min - b.min) || (a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0));

  const lanes: LaneState[] = [];
  const laneByParent = new Map<string, number>();
  for (const p of parents) {
    let placed = -1;
    for (let i = 0; i < lanes.length && placed < 0; i++) {
      const lane = lanes[i];
      // Fast path: everything of this order starts at/after the lane's latest end.
      if (p.min >= lane.maxEnd) { placed = i; break; }
      let clash = false;
      for (const [ps, pe] of p.list) {
        for (const [ls, le] of lane.intervals) {
          if (ps < le && ls < pe) { clash = true; break; }
        }
        if (clash) break;
      }
      if (!clash) placed = i;
    }
    if (placed < 0) { lanes.push({ intervals: [], maxEnd: -Infinity }); placed = lanes.length - 1; }
    const lane = lanes[placed];
    for (const iv of p.list) {
      lane.intervals.push(iv);
      if (iv[1] > lane.maxEnd) lane.maxEnd = iv[1];
    }
    laneByParent.set(p.parentId, placed);
  }
  return { laneByParent, maxDepth: lanes.length };
}
