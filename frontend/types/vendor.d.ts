/*
 * Hand-written ambient declarations for third-party libraries loaded via CDN <script>
 * tags in index.html (NOT via npm) — see docs/archive/typescript_migration.md's Phase 0 write-up.
 *
 * Kept intentionally minimal: only the API surface actually called from NIMBUS code
 * (cross-checked against tests/modules/helpers/load-legacy-app.mjs's CDN stubs and
 * eslint.config.js's CDN_GLOBALS). Mirrors the pinned CDN versions in index.html:
 *   vis-timeline@7.7.3, ag-grid-community@31.3.2, flatpickr@4.6.13
 * If a version bumps in index.html, re-check this file against the new API surface —
 * there is no automated check tying the two together.
 */

declare global {
  // Structurally relocated inside this `declare global` block (previously declared
  // at module top level, outside `declare global`) so `NimbusVendor.X` is nameable
  // from any .mts file in the program, not just from ambient declarations inside
  // this file — see docs/archive/typescript_migration.md Phase 6 Global Constraints (the
  // "NimbusVendor namespace is not yet globally referenceable by name" note). Pure
  // structural move: same interface bodies, same members, zero behavior change.
  namespace NimbusVendor {
    interface VisTimelineOptions {
      [key: string]: unknown;
    }

    interface VisDataSet<T = unknown> {
      add(items: T | T[]): void;
      /** vis-timeline's DataSet.update() patches an existing item by id (merges fields into
       *  the stored object) rather than replacing it wholesale — schedule-workbench.mts's
       *  live ticker (Timeline.init's setInterval) calls this with `{id, end}`/`{id, start,
       *  end}` partials, not a full T, so the parameter type must reflect that real,
       *  patch-semantics contract rather than requiring a full item. */
      update(items: (Partial<T> & { id: string | number }) | Array<Partial<T> & { id: string | number }>): void;
      remove(ids: string | number | Array<string | number>): void;
      clear(): void;
      get(id?: string | number): T | T[] | null;
      getIds(): Array<string | number>;
      /** vis-data's DataSet pub/sub — added by CQ-1 Phase 6 Task 6
       *  (schedule-workbench.mts's Interaction module subscribes to '*' to
       *  catch drag-commit 'update' events on Timeline._items) as the real
       *  vis-data DataSet API surface that module uses. `properties` is `null`
       *  for some event kinds (e.g. a bare 'remove' by id only) — real vis-data
       *  behavior, not a NIMBUS invention. */
      on(event: 'add' | 'update' | 'remove' | '*',
         callback: (event: string, properties: { items: Array<string | number>; data?: T[] } | null, senderId?: string | number | null) => void): void;
      off(event: 'add' | 'update' | 'remove' | '*', callback?: (...args: unknown[]) => void): void;
    }

    /** A vis-timeline DataView — a filtered, read-only projection over a VisDataSet
     *  (Timeline._visItems's sliding ±90-day window, see schedule-workbench.mts). */
    interface VisDataView<T = unknown> {
      refresh(): void;
      get(id?: string | number): T | T[] | null;
      on(event: 'add' | 'update' | 'remove' | '*', callback: (...args: unknown[]) => void): void;
    }

    /** vis-timeline's internal event→props mapping — the shape returned both by
     *  calling `getEventProperties(rawEvent)` directly AND (structurally) by
     *  the Timeline's own 'click'/'doubleClick' event payloads, since
     *  getEventProperties is the same internal mapper vis-timeline uses to
     *  build those payloads from a raw DOM event. Added by CQ-1 Phase 6 Task 6
     *  (schedule-workbench.mts's Interaction module — pan-vs-click
     *  disambiguation, the alertcell click delegate, and the group-label
     *  double-click isolate gesture) with only the fields that module reads;
     *  the real vis-timeline v7.7.3 payload also carries pageX/pageY/x/y/
     *  snappedTime, omitted here since no caller uses them. */
    interface VisEventProperties {
      event?: {
        shiftKey?: boolean;
        metaKey?: boolean;
        ctrlKey?: boolean;
        target?: EventTarget | null;
        srcEvent?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; target?: EventTarget | null };
      };
      item?: string | number | null;
      group?: string | number | null;
      what?: string;
      time?: Date;
    }

    interface VisTimelineInstance {
      setItems(items: VisDataSet | unknown[]): void;
      setGroups(groups: VisDataSet | unknown[]): void;
      setOptions(options: VisTimelineOptions): void;
      on(event: string, handler: (...args: unknown[]) => void): void;
      off(event: string, handler?: (...args: unknown[]) => void): void;
      getItemRange(): { min: Date; max: Date };
      getWindow(): { start: Date; end: Date };
      setWindow(start: Date, end: Date, options?: { animation?: boolean | { duration: number } }): void;
      /** `zoom` added by CQ-1 Phase 6 Task 6 (Interaction._onClick's
       *  center-on-click pan uses `{ zoom: false }` to pan without changing
       *  the viewport width) — a real vis-timeline v7.7.3 focus() option. */
      focus(id: string, options?: { animation?: boolean | { duration: number }; zoom?: boolean }): void;
      setSelection(ids: string[]): void;
      redraw(): void;
      destroy(): void;
      /** Maps a raw DOM MouseEvent to vis-timeline's coordinate-mapped event
       *  properties (group/item/what/time) — added by CQ-1 Phase 6 Task 6
       *  (schedule-workbench.mts's Interaction module, the only caller today)
       *  as the real vis-timeline v7.7.3 API surface that module uses. */
      getEventProperties(event: Event): VisEventProperties;
      [method: string]: unknown;
    }

    /** One entry of AgGridApi's getColumnState()/applyColumnState() contract —
     *  named (CQ-1 Phase 6 Task 3) so schedule-workbench.mts's Table module can
     *  reference it directly for its saved-grid-layout feature instead of an
     *  inline literal type. */
    interface AgGridColumnState {
      colId: string;
      sort?: 'asc' | 'desc' | null;
      sortIndex?: number;
      hide?: boolean;
      width?: number;
      pinned?: 'left' | 'right' | null;
      [k: string]: unknown;
    }

    interface AgGridApi {
      setGridOption(key: string, value: unknown): void;
      applyTransaction(txn: { add?: unknown[]; update?: unknown[]; remove?: unknown[] }): unknown;
      getSelectedRows(): unknown[];
      forEachNode(callback: (node: unknown) => void): void;
      destroy(): void;
      refreshCells(params?: Record<string, unknown>): void;
      setColumnDefs(defs: unknown[]): void;
      getDisplayedRowCount(): number;
      getColumnState(): AgGridColumnState[];
      getFilterModel(): Record<string, unknown>;
      /* Members below added by CQ-1 Phase 6 Task 3 (schedule-workbench.mts's
       * Table module — the AG Grid orders-grid wrapper, plus its Interaction-
       * module two-way-sync consumers further down the same file that reach
       * the same Table._api instance) as the real, precise AgGridApi surface
       * that module actually calls became known. Real AG Grid v31 Grid API
       * methods, not invented. */
      getDisplayedRowAtIndex(index: number): unknown | undefined;
      getRowNode(id: string): unknown | undefined;
      getValue(colKey: string, rowNode: unknown): unknown;
      applyColumnState(params: { state: AgGridColumnState[]; applyOrder?: boolean }): void;
      resetColumnState(): void;
      setFilterModel(model: Record<string, unknown> | null): void;
      isAnyFilterPresent(): boolean;
      onFilterChanged(): void;
      getAllDisplayedColumns(): unknown[];
      exportDataAsCsv(params?: Record<string, unknown>): void;
      deselectAll(): void;
      addEventListener(eventType: string, listener: (...args: unknown[]) => void): void;
      stopEditing(cancel?: boolean): void;
      /** Auto-sizes all columns to fit the available grid width — added by the
       *  TypeScript migration's application-shell.mts conversion (Phase 5 Task 1;
       *  App.gotoGanttSub's Orders-sub-tab activation calls it) as the real
       *  AG Grid v31 Grid API surface that call site uses. */
      sizeColumnsToFit(): void;
      /** Batched show/hide for one or more columns by colId — used by Table's
       *  admin-configured Orders field-visibility feature
       *  (_applyFieldVisibility, frontend/order-field-catalog.mjs) instead of a
       *  per-column setColumnVisible() loop. Real AG Grid v31 Grid API method. */
      setColumnsVisible(colKeys: string[], visible: boolean): void;
      [method: string]: unknown;
    }

    interface AgGridOptions {
      [key: string]: unknown;
    }

    interface FlatpickrInstance {
      setDate(date: Date | string | number, triggerChange?: boolean): void;
      destroy(): void;
      clear(): void;
      /** Sets a single config option after instantiation — added by CQ-1 Phase 6
       *  Task 7 (schedule-workbench.mts's OptimizeDialog module, which calls
       *  `_fpEnd.set('minDate', _start)` to constrain the end-date picker once a
       *  start date is chosen) as the real flatpickr v4.6.13 API surface that
       *  module uses. */
      set(option: string, value: unknown): void;
      /** Opens the calendar/time-picker UI programmatically — part of the real
       *  flatpickr v4.6.13 API surface. No `.mts` caller remains (the plant
       *  working-hours pills now open the EditCalendar modal instead); kept so
       *  the typing still matches the vendor library. */
      open(): void;
      selectedDates: Date[];
      /** The original `<input>` flatpickr was attached to — added by CQ-1 Phase 6
       *  Task 8 (schedule-workbench.mts's EditCalendar module, which reads
       *  `.element.value` on its 14 working-hours time pickers to compute badge
       *  hours/save payloads) as the real flatpickr v4.6.13 API surface that
       *  module uses. Every NIMBUS call site attaches flatpickr to a plain
       *  `<input>` (never a `<select>`/custom element), so `HTMLInputElement`
       *  is accurate, not just convenient. */
      element: HTMLInputElement;
      [method: string]: unknown;
    }

    interface FlatpickrOptions {
      [key: string]: unknown;
    }
  }

  const vis: {
    Timeline: new (container: HTMLElement, items: unknown, groups: unknown, options?: NimbusVendor.VisTimelineOptions) => NimbusVendor.VisTimelineInstance;
    DataSet: new <T = unknown>(data?: T[]) => NimbusVendor.VisDataSet<T>;
    DataView: new <T = unknown>(dataset: NimbusVendor.VisDataSet<T>, options: { filter: (item: T) => boolean }) => NimbusVendor.VisDataView<T>;
    /** The moment build bundled in the standalone UMD (re-exported as `vis.moment`); only the locale API is used. */
    moment?: { locales?: () => string[]; defineLocale?: (name: string, config: Record<string, unknown>) => unknown };
  };

  const agGrid: {
    createGrid: (container: HTMLElement, options: NimbusVendor.AgGridOptions) => NimbusVendor.AgGridApi;
    ModuleRegistry: { registerModules(modules: unknown[]): void };
  };

  const flatpickr: {
    (selector: string | HTMLElement, options?: NimbusVendor.FlatpickrOptions): NimbusVendor.FlatpickrInstance;
    localize(locale: unknown): void;
    l10ns: Record<string, unknown>;
    formatDate(date: Date, format: string, customLocale?: unknown): string;
  };
}

export {};
