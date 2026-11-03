// optimization/sandbox.mjs — Sandbox (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-state.mts
// (1,034 lines) into 3 domain files). "What-If" mode state + snapshots only.
// Deep-clones Store state so planners can try changes freely without
// affecting the live schedule. The DOM banner/buttons, Toast messages, and
// cross-module side effects (Confidence snapshot/restore, Persistence.saveAll,
// CalendarSync flush/hydration) are NOT this module's concern — they live in
// optimize-ui.mts's `SandboxAdapter`, which subscribes to the `sandbox:entered`/
// `sandbox:exited` events emitted below.
//
// `Store`/`UndoStack` (platform/store.mjs) are real cross-file imports
// forming a two-way ESM cycle with that module — Store.mode() reads
// Sandbox.active (see platform/store.mjs's header comment). Safe under the
// same rule: every cross-reference here is inside a method body invoked
// after both modules finish loading, never at top-level evaluation.
import { Store, UndoStack } from '../platform/store.mjs';
import type { CalendarEntry } from '../platform/store.mjs';
import { Util, Modal } from '../platform/foundation.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, PlantCalendarEntry } from '../platform/types.mjs';

interface SandboxSnapshot {
  tasks: NimbusTask[];
  blocks: NimbusBlock[];
  calendars: Record<string, CalendarEntry>;
  plants: Record<string, PlantCalendarEntry>;
  plantBlocks: NimbusPlantBlock[];
  firmedIds: Set<string>;
}

/* =============================================================================
   SANDBOX — "What-If" mode state + snapshots only. Deep-clones Store state so
   planners can try changes freely without affecting the live schedule. The DOM
   banner/buttons, Toast messages, and cross-module side effects (Confidence
   snapshot/restore, Persistence.saveAll, CalendarSync flush/hydration) are NOT
   this module's concern — they live in optimize-ui.mts's `SandboxAdapter`, which
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
      // Calendar state as promoted (sandbox state at apply). Compared at undo time to
      // detect calendar edits made since applying, which the undo would silently revert.
      const promotedAtApply = JSON.stringify([Store.blocks, Store.plantBlocks, Store.calendars, Store.plants]);
      UndoStack.push('Discard What-If scenario', async () => {
        if (JSON.stringify([Store.blocks, Store.plantBlocks, Store.calendars, Store.plants]) !== promotedAtApply) {
          const ok = await Modal.confirm({
            title:        Util.t('modal.undo_whatif_calendar_title'),
            message:      Util.t('modal.undo_whatif_calendar_msg'),
            confirmLabel: Util.t('modal.undo_whatif_calendar_confirm'),
            tone:         'warn',
          });
          if (!ok) return false; // abort the whole undo
        }
        // The promoted calendar/blackout edits live in these slices, so reverting only
        // tasks + firms (the old behavior) left them applied and already POSTed. Capture
        // the promoted slices first so SandboxAdapter can re-sync the backend to the
        // restored state (CalendarSync.flushPlant, with the promoted-only blackouts as
        // explicit deletes), then restore every slice the discard path restores.
        const promoted = {
          blocks:      Store.blocks.map(b => Util.clone(b)),
          calendars:   Util.clone(Store.calendars),
          plants:      Util.clone(Store.plants),
          plantBlocks: Store.plantBlocks.map(b => Util.clone(b)),
        };
        // Tasks go through the UndoStack.restoreTasks path (updateMany source 'undo', LIVE
        // row_version): the restored ids become dirty, so the next save pushes the revert
        // to the server instead of leaving the promoted schedule persisted. A wholesale
        // setTasks() reset dirty tracking and left the revert local-only. Tasks the
        // scenario created are dropped locally, as before.
        const snapIds = new Set(snap.tasks.map((t) => String(t.id)));
        for (const t of Store.tasksArr) if (!snapIds.has(String(t.id))) Store.removeTask(t.id, 'undo');
        // Hand the Store copies, not the snapshot's own arrays: the Store mutates what it owns, and `snap` is still
        // referenced (the exited event payload, a later undo) so it must not alias live state.
        UndoStack.restoreTasks(structuredClone(snap.tasks));
        Store.replaceBlocks(structuredClone(snap.blocks), 'undo');
        Store.replaceCalendars(structuredClone(snap.calendars), 'undo');
        Store.replacePlants(structuredClone(snap.plants), 'undo');
        Store.replacePlantBlocks(structuredClone(snap.plantBlocks), 'undo');
        Store.replaceFirmedIds(new Set(snap.firmedIds), 'undo');
        Store.emit({ type: 'sandbox:reverted', source: 'undo', promoted });
        return true;
      }, snap.tasks.map((t) => t.id));
    } else {
      // Discard: restore the pre-enter snapshot wholesale. Each replaceX() below
      // fires its own '<field>:replace' event (distinct from that field's normal
      // '<field>:change' event) — a future consumer of 'blocks:change' /
      // 'calendar:change' / 'plantBlocks:change' / 'firmed:change' receive
      // their following compatibility change event, so existing subscribers
      // also refresh after a What-If discard. replacePlants emits
      // plants:replace followed by calendar:change (plant hours use the
      // calendar channel); it does not emit plants:change. See
      // Mapping: replaceBlocks -> blocks:change, replaceCalendars and
      // replacePlants -> calendar:change, replacePlantBlocks ->
      // plantBlocks:change, and replaceFirmedIds -> firmed:change.
      // docs/architecture/cq1-compatibility-inventory.md §6 and the pinned
      // event-sequence test in tests/modules/optimization/sandbox.test.mjs.
      // Copies, so the snapshot carried on sandbox:exited never aliases the rows the Store now mutates in place.
      Store.setTasks(structuredClone(snap.tasks), 'sandbox');
      Store.replaceBlocks(structuredClone(snap.blocks), 'sandbox');
      Store.replaceCalendars(structuredClone(snap.calendars), 'sandbox');
      Store.replacePlants(structuredClone(snap.plants), 'sandbox');
      Store.replacePlantBlocks(structuredClone(snap.plantBlocks), 'sandbox');
      Store.replaceFirmedIds(new Set(snap.firmedIds), 'sandbox');
    }

    this.active = false;
    this._snapshot = null;
    Store.emit({ type: 'sandbox:exited', applied: !!apply, source, snapshot: snap });
    return snap;
  },
};
