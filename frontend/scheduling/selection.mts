// scheduling/selection.mjs — Selection (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-state.mts
// (1,034 lines) into 3 domain files). Multi-select store, independent of
// vis-timeline internals.
//
// `Store` (platform/store.mjs) is a real cross-file import forming a
// two-way ESM cycle with this module — Store.removeTask() calls
// Selection.remove() (see platform/store.mjs's header comment). Safe under
// the same rule: every cross-reference here is inside a method body invoked
// after both modules finish loading, never at top-level evaluation.
import { Store } from '../platform/store.mjs';
import { Util, ErrorLog } from '../platform/foundation.mjs';
import type { SelectionEmitKind, NimbusTask } from '../platform/types.mjs';

interface SelectionEmitPayload {
  kind: SelectionEmitKind;
  ids: string[];
  anchor: string | null;
}

/* =============================================================================
   SELECTION — multi-select store, independent of vis-timeline internals.
   Single source of truth for "which orders are selected". All UIs (Timeline,
   Table, Inspector, ContextMenu) subscribe to this. Never persisted, never
   autosaved.
   ========================================================================== */
export const Selection = {
  _ids: new Set<string>(),           // Set<string>
  _anchor: null as string | null,              // id of last-single-clicked item (for Shift range)
  _listeners: new Set<(payload: SelectionEmitPayload) => void>(),

  /** @returns {string[]} currently selected ids */
  ids(): string[] { return [...this._ids]; },
  has(id: string | number): boolean { return this._ids.has(String(id)); },
  size(): number { return this._ids.size; },
  clear(): void {
    if (!this._ids.size) return;
    this._ids.clear();
    this._anchor = null;
    this._emit('clear');
  },
  set(ids: Array<string | number>): void {
    const next = new Set(ids.map(String));
    if (_setsEqual(next, this._ids)) return;
    this._ids = next;
    this._anchor = ids.length ? String(ids[ids.length - 1]) : null;
    this._emit('set');
  },
  add(ids: string | number | Array<string | number>): void {
    const arr = Array.isArray(ids) ? ids : [ids];
    let changed = false;
    for (const id of arr) {
      const s = String(id);
      if (!this._ids.has(s)) { this._ids.add(s); changed = true; }
    }
    if (changed) {
      this._anchor = String(arr[arr.length - 1]);
      this._emit('add');
    }
  },
  remove(ids: string | number | Array<string | number>): void {
    const arr = Array.isArray(ids) ? ids : [ids];
    let changed = false;
    for (const id of arr) {
      if (this._ids.delete(String(id))) changed = true;
    }
    if (changed) this._emit('remove');
  },
  toggle(id: string | number): void {
    const s = String(id);
    if (this._ids.has(s)) this._ids.delete(s);
    else { this._ids.add(s); this._anchor = s; }
    this._emit('toggle');
  },

  /** Select every id from anchor to target on the same line (inclusive). `include` (optional) drops orders it
   *  rejects, e.g. ones the Gantt filter dims; the anchor and target themselves always stay. */
  selectRange(targetId: string | number, include?: (t: NimbusTask) => boolean): void {
    const target = String(targetId);
    const anchor = this._anchor;
    if (!anchor || anchor === target) { this.set([target]); return; }

    const ta = Store.tasks[anchor];
    const tt = Store.tasks[target];
    if (!ta || !tt || ta.MACHINE !== tt.MACHINE) {
      this.set([target]);
      return;
    }
    const line = ta.MACHINE;
    const peers = Store.tasksArr
      .filter(t => t.MACHINE === line && t.start_date
        && (!include || String(t.id) === anchor || String(t.id) === target || include(t)))
      .sort((a, b) => Number(a.start_date) - Number(b.start_date));
    const ia = peers.findIndex(t => String(t.id) === anchor);
    const it = peers.findIndex(t => String(t.id) === target);
    if (ia < 0 || it < 0) { this.set([target]); return; }
    const [lo, hi] = ia < it ? [ia, it] : [it, ia];
    const range = peers.slice(lo, hi + 1).map(t => String(t.id));
    const keep = this._anchor;
    this.set(range);
    this._anchor = keep; // preserve anchor for further Shift-clicks
  },

  /** Summary for the Inspector multi-selection view. */
  stats(): { count: number; totalHours: number; lines: string[] } {
    const ids = [...this._ids];
    let totalHours = 0;
    const lines = new Set<string>();
    for (const id of ids) {
      const t = Store.tasks[id];
      if (!t) continue;
      totalHours += Util.runHours(t);
      if (t.MACHINE) lines.add(t.MACHINE);
    }
    return { count: ids.length, totalHours, lines: [...lines] };
  },

  on(fn: (payload: SelectionEmitPayload) => void): () => void { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  _emit(kind: SelectionEmitKind): void {
    const payload = { kind, ids: [...this._ids], anchor: this._anchor };
    for (const l of this._listeners) {
      try { l(payload); } catch (e) { ErrorLog.error('selection', `listener: ${(e as Error).message}`); }
    }
  },

  /** [{plant, id}] for the currently selected ids — additive convenience for
   *  consumers that need plant scoping alongside the raw id (e.g. cross-plant
   *  bulk actions). Existing bare-ID methods above are unchanged. */
  selectedRefs(): Array<{ plant: string | null; id: string }> {
    return [...this._ids].map(id => ({ plant: Store.tasks[id]?.plant ?? null, id }));
  },
};

function _setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
