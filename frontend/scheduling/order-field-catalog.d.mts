/*
 * Hand-written ambient declaration for frontend/order-field-catalog.mjs.
 *
 * order-field-catalog.mjs is a plain hand-written ES module (like
 * frontend/_static-delivery-check.mjs), not part of the tsc-compiled CQ-1 module
 * set — it's a static data catalog with no logic worth type-checking at the
 * source level. This sibling .d.mts exists purely so schedule-workbench.mts
 * and plant-and-administration.mts get real typing when they `import` it.
 * Keep this in sync with the array literal in order-field-catalog.mjs — there
 * is no automated check tying the two together.
 */

export interface OrderFieldCatalogEntry {
  /** Exact NimbusTask/API property, e.g. 'COLOR', 'ORDER_QUANTITY_(GMEIN)'. */
  key: string;
  /** orders table column (snake_case) this field is sourced from. */
  dbColumn: string;
  type: 'text' | 'number' | 'integer';
  /** Default AG Grid column visibility when no system_settings override exists. */
  gridDefault: boolean;
  /** Default Inspector row visibility when no system_settings override exists. */
  inspectorDefault: boolean;
  /** i18n key for the AG Grid column header. */
  i18nGridKey: string;
  /** i18n key for the Inspector row label. */
  i18nInspectorKey: string;
  /** AG Grid column width; falls back to a generic default if omitted. */
  gridWidth?: number;
}

export const ORDER_FIELD_CATALOG: OrderFieldCatalogEntry[];
