// optimization/sandbox.mjs — Sandbox (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-state.mts
// (1,034 lines) into 3 domain files). "What-If" mode state + snapshots only.
// Deep-clones Store state so planners can try changes freely without
// affecting the live schedule. The DOM banner/buttons, Toast messages, and
// cross-module side effects (Confidence snapshot/restore, Persistence.saveAll,
// CalendarSync flush/hydration) are NOT this module's concern — they live in
// app.js's `SandboxAdapter`, which subscribes to the `sandbox:entered`/
// `sandbox:exited` events emitted below.
//
// `Store`/`UndoStack` (platform/store.mjs) are real cross-file imports
// forming a two-way ESM cycle with that module — Store.mode() reads
// Sandbox.active (see platform/store.mjs's header comment). Safe under the
// same rule: every cross-reference here is inside a method body invoked
// after both modules finish loading, never at top-level evaluation.
import { Store, UndoStack } from '../platform/store.mjs';
import type { CalendarEntry } from '../platform/store.mjs';
import { Util } from '../platform/foundation.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock } from '../platform/types.mjs';

interface SandboxSnapshot {
  tasks: NimbusTask[];
  blocks: NimbusBlock[];
  calendars: Record<string, CalendarEntry>;
  plants: Record<string, CalendarEntry>;
  plantBlocks: NimbusPlantBlock[];
  firmedIds: Set<string>;
}

/* =============================================================================
   SANDBOX — "What-If" mode state + snapshots only. Deep-clones Store state so
   planners can try changes freely without affecting the live schedule. The DOM
   banner/buttons, Toast messages, and cross-module side effects (Confidence
   snapshot/restore, Persistence.saveAll, CalendarSync flush/hydration) are NOT
   this module's concern — they live in app.js's `SandboxAdapter`, which
   subscribes to the `sandbox:entered`/`sandbox:exited` events emitted below.
   ========================================================================== */
export const Sandbox = {
  active: false,
  _snapshot: null as SandboxSnapshot | null,

  enter(source?: string): boolean {
    if (this.active) return false;
    this._snapshot = {
      tasks:       Store.tasksArr.map(t => Util.clone(t)),
      blocks:      Store.blocks.map(b => Util.clone(b)),
      calendars:   Util.clone(Store.calendars),
      plants:      Util.clone(Store.plants),
      plantBlocks: Store.plantBlocks.map(b => Util.clone(b)),
      firmedIds:   new Set([...Store.firmedIds]),
    };
    this.active = true;
    Store.emit({ type: 'sandbox:entered', source });
    return true;
  },

  exit(apply: boolean, source?: string): SandboxSnapshot | null {
    if (!this.active) return null;
    const snap = this._snapshot!;

    if (apply) {
      // Promote sandbox state to real state with a single undoable entry.
      UndoStack.push('Discard What-If scenario', () => {
        Store.setTasks(snap.tasks, 'undo');
        Store.replaceFirmedIds(snap.firmedIds, 'undo');
        Store.emit({ type: 'sandbox:reverted', source: 'undo' });
      });
    } else {
      // Discard: restore the pre-enter snapshot wholesale. Each replaceX() below
      // fires its own '<field>:replace' event (distinct from that field's normal
      // '<field>:change' event) — a future consumer of 'blocks:change' /
      // 'calendar:change' / 'plants:change' / 'plantBlocks:change' / 'firmed:change'
      // receives the following compatibility change event, so existing change
      // subscribers also refresh after a What-If discard. See
      // docs/architecture/cq1-compatibility-inventory.md §6 and the pinned
      // event-sequence test in tests/modules/optimization/sandbox.test.mjs.
      Store.setTasks(snap.tasks, 'sandbox');
      Store.replaceBlocks(snap.blocks, 'sandbox');
      Store.replaceCalendars(snap.calendars, 'sandbox');
      Store.replacePlants(snap.plants, 'sandbox');
      Store.replacePlantBlocks(snap.plantBlocks, 'sandbox');
      Store.replaceFirmedIds(snap.firmedIds, 'sandbox');
    }

    this.active = false;
    this._snapshot = null;
    Store.emit({ type: 'sandbox:exited', applied: !!apply, source, snapshot: snap });
    return snap;
  },
};
