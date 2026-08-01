/*
 * Hand-written ambient declarations for third-party libraries loaded via CDN <script>
 * tags in index.html (NOT via npm) — see docs/typescript_migration.md's Phase 0 write-up.
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
  // this file — see docs/typescript_migration.md Phase 6 Global Constraints (the
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
    }

    /** A vis-timeline DataView — a filtered, read-only projection over a VisDataSet
     *  (Timeline._visItems's sliding ±90-day window, see schedule-workbench.mts). */
    interface VisDataView<T = unknown> {
      refresh(): void;
      get(id?: string | number): T | T[] | null;
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
      focus(id: string, options?: { animation?: boolean | { duration: number } }): void;
      setSelection(ids: string[]): void;
      redraw(): void;
      destroy(): void;
      [method: string]: unknown;
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
      getColumnState(): Array<{ colId: string; sort?: 'asc' | 'desc' | null; sortIndex?: number; [k: string]: unknown }>;
      getFilterModel(): Record<string, unknown>;
      [method: string]: unknown;
    }

    interface AgGridOptions {
      [key: string]: unknown;
    }

    interface FlatpickrInstance {
      setDate(date: Date | string | number, triggerChange?: boolean): void;
      destroy(): void;
      clear(): void;
      selectedDates: Date[];
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
