/*
 * web/types/nimbus-global.d.mts — ambient shim for the bare `NIMBUS` global
 * identifier (docs/typescript_migration.md §A implication #2). `NIMBUS` is
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
import type { NimbusTask } from '../types.mjs';

declare global {
  const NIMBUS:
    | undefined
    | {
        App?: {
          goto?(tab: string): void;
          gotoGanttTimeline?(): void;
          _currentTab?: string;
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
          render?(container: HTMLElement | null, opts?: { title?: string; msg?: string; icon?: string }): void;
        };
        Timeline?: {
          rebuild?(): void;
        };
        TimelineNav?: {
          render?(): void;
        };
        Table?: {
          _api?: NimbusVendor.AgGridApi;
        };
        Store?: unknown;
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
          snapshot?(): void;
          restore?(): void;
          _recompute?(): void;
        };
      };
}

export {};
