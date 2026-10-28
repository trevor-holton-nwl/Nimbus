/*
 * frontend/types/nimbus-global.d.mts — ambient shim for the bare `NIMBUS` global
 * identifier (docs/archive/typescript_migration.md §A implication #2). `NIMBUS` is
 * `app.js`'s own top-level `const` — part of the classic-script shared page
 * realm, never a module import. schedule-workbench.mjs, plant-and-
 * administration.mjs, and application-shell.mjs each reach a handful of
 * members on it for genuine upward-in-the-DAG or sideways-into-
 * nimbus-intelligence.js calls (T-2: these must stay ambient `declare`,
 * never a real `import` — promoting one to an import recreates a circular
 * import, since the reach points at a module that already imports the
 * reacher, or at nimbus-intelligence.js, which is not a CQ-1 module at all).
 *
 * ADDITIVE ONLY: every member below is optional (`Foo?:`) because NIMBUS is
 * assembled at runtime by app.js's bridge-and-return step, and every real
 * call site already guards with `typeof NIMBUS !== 'undefined'` and/or `?.`.
 * When a later phase's task reaches a NIMBUS member not yet declared here,
 * add it to this same object — do not create a second ambient declaration
 * or inline `as any` at the call site.
 */
import type { NimbusTask, NimbusLineSetting } from '../platform/types.mjs';

declare global {
  const NIMBUS:
    | undefined
    | {
        App?: {
          goto?(tab: string): void;
          gotoGanttTimeline?(): void;
          /** Added for the Distribution pane's "no distribute-mode work
           *  center" empty state (`frontend/distribution/distribution-pane.mts`),
           *  whose "Open Work Centers" button navigates to Master Data ›
           *  Work Centers the same way `App.gotoMasterSub` does internally. */
          gotoMasterSub?(sub: string): void;
          /** Switches the Gantt tab's active sub-pane (e.g. 'distribution').
           *  `goto('gantt')` must be called first to switch the top-level tab —
           *  this alone does not. Pre-existing call sites in
           *  `frontend/scheduling/orders.mts` reach it via a local cast instead
           *  of this ambient declaration; left as-is (see that file's own
           *  comment). */
          gotoGanttSub?(sub: string): void;
        };
        Inspector?: {
          show?(task: NimbusTask): void;
          _currentId?: string | null;
          _render?(task: NimbusTask): void;
        };
        GanttFilter?: {
          _selectedLines?: Set<string>;
        };
        /** Reached by Timeline.rebuild()'s debug-log gate (`NIMBUS.Interaction?.DEBUG`) —
         *  documented in this file's own header comment as one of Timeline's five genuine
         *  cross-references, but omitted from this plan's own Step 3 code block; added here
         *  since Task 1's own code needs it (Interaction itself moves into this file in Task 5). */
        Interaction?: {
          DEBUG?: boolean;
        };
        EmptyState?: {
          /** `action` added for the Distribution pane's "Open Work Centers" /
           *  "Clear filters" empty-state buttons (`distribution-pane.mts`) —
           *  optional and additive, every existing call site that omits it
           *  renders exactly as before. */
          render?(container: HTMLElement | null, opts?: { title?: string; msg?: string; icon?: string; action?: { label: string; onClick(): void } }): void;
        };
        Timeline?: {
          rebuild?(): void;
          _ganttActive?(): boolean;
          _scheduleRebuild?(): void;
          focus?(id: string): void;
        };
        /** Reached by the Distribution pane's "Show on Gantt" action
         *  (`frontend/distribution/distribution-pane.mts`, P2-16) to select a
         *  header's live children before scrolling to the earliest via
         *  `Timeline.focus` — the same ambient-global "leaf pane reaching
         *  upward" idiom this file documents for `App`/`EmptyState` above. */
        Selection?: {
          set?(ids: Array<string | number>): void;
        };
        TimelineNav?: {
          render?(): void;
        };
        Table?: {
          _api?: NimbusVendor.AgGridApi;
          _openOverrideModalForId?(id: string): void;
          _applyChipFilter?(patch: any): void;
        };
        Store?: {
          tasks?: Record<string, NimbusTask>;
        };
        DarkMode?: {
          set?(isDark: boolean): void;
        };
        LangSwitcher?: {
          set?(lang: string): void;
        };
        CommandPalette?: {
          close?(): void;
        };
        Confidence?: {
          snapshot?(): any;
          restore?(snap?: any): void;
          _recompute?(): void;
          _recomputeDebounced?(): void;
          _score?: number;
          showBreakdown?(): void;
        };
        /* Task 2 stopgap additions (schedule-workbench.mts Table-onward region)
           — these members are reached but not precisely typed here; args/return
           are deliberately loose (`any`) per this file's own additive-only
           convention. Tasks 3-8 may tighten them alongside their own region's
           real typing. */
        /** Tightened by Task 3 (Table._showAlertPopup's real forward reference —
         *  AlertsUIAdapter itself still doesn't move into schedule-workbench.mts
         *  until Task 7). `toggleDrawer` dropped: real TS call sites never call
         *  it via `NIMBUS.AlertsUIAdapter.toggleDrawer()` (only present inside
         *  generated onclick="..." HTML-attribute strings, which tsc never
         *  type-checks) — see docs/archive/typescript_migration.md Phase 6 Task 3. */
        AlertsUIAdapter?: {
          focus?(alertId: string): void;
          showForCell?(line: string, dayKey: string): void;
          renderBell?(): void;
          renderDrawer?(): void;
        };
        Plant?: {
          _persistPlantHours?(pName: string | null): void;
          render?(): void;
        };
        ProdLines?: {
          render?(): void;
        };
        Persistence?: {
          saveAll?(opts?: { silent?: boolean }): void;
        };
        /** Reached by Plant._renderRoster's plant-group-input onchange handler
         *  (plant-and-administration.mts Task 1) to keep MasterData's lines
         *  table row in sync after a same-plant roster edit. Tightened by
         *  Task 4 (MasterData's real conversion) to `syncLineSettings`'s
         *  actual signature — the reach stays ambient (not a same-module bare
         *  reference) because Plant/ProdLines' call sites were left going
         *  through the shared `NIMBUS` binding rather than simplified once
         *  MasterData landed in this same file (see the file header comment). */
        MasterData?: {
          syncLineSettings?(line: string, patch: Partial<NimbusLineSetting>): Promise<boolean>;
        };
      };
}

export {};
