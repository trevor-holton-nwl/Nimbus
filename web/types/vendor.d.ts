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

declare namespace NimbusVendor {
  interface VisTimelineOptions {
    [key: string]: unknown;
  }

  interface VisDataSet<T = unknown> {
    add(items: T | T[]): void;
    update(items: T | T[]): void;
    remove(ids: string | number | Array<string | number>): void;
    clear(): void;
    get(id?: string | number): T | T[] | null;
  }

  interface VisTimelineInstance {
    setItems(items: VisDataSet | unknown[]): void;
    setGroups(groups: VisDataSet | unknown[]): void;
    setOptions(options: VisTimelineOptions): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler?: (...args: unknown[]) => void): void;
    getItemRange(): { min: Date; max: Date };
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

declare global {
  const vis: {
    Timeline: new (container: HTMLElement, items: unknown, groups: unknown, options?: NimbusVendor.VisTimelineOptions) => NimbusVendor.VisTimelineInstance;
    DataSet: new <T = unknown>(data?: T[]) => NimbusVendor.VisDataSet<T>;
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
