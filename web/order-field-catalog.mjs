/*
 * web/order-field-catalog.mts — single source of truth for which optional
 * Orders fields exist and their default show/hide state in the AG Grid
 * columns and the Inspector detail panel.
 *
 * Consumed by:
 *   - Table's columnDefs builder (web/schedule-workbench.mts)
 *   - Inspector._render() (web/schedule-workbench.mts)
 *   - The admin "System Configuration" sub-tab (web/plant-and-administration.mts)
 *
 * CORE fields are never in this catalog and are never hideable — they stay
 * hardcoded in Table/Inspector exactly as before this feature existed:
 * production_line, start_date, end_date, notes, production_order.
 *
 * Every other optional/attribute field on an order — 5 pre-existing display
 * fields plus 2 API fields that were already returned but never rendered
 * (PLANT, FIRMING_INDICATOR) plus 10 new SAP fields — is listed here so an
 * admin can toggle its default visibility globally (system_settings table,
 * see master_data.py get_system_settings/upsert_system_settings).
 *
 * Zero-dependency leaf module: do not import anything else here, so both
 * schedule-workbench.mts and plant-and-administration.mts can depend on it
 * without adding a new edge between those two module groups.
 */
export const ORDER_FIELD_CATALOG = [
    // Pre-existing display fields — default visible in both surfaces so this
    // feature is a zero-visual-change rollout.
    { key: 'MATERIAL_DESCRIPTION', dbColumn: 'material_description', type: 'text',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.material', i18nInspectorKey: 'ui.insp_material_desc' },
    { key: 'ORDER_QUANTITY_(GMEIN)', dbColumn: 'order_quantity', type: 'number',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.qty', i18nInspectorKey: 'ui.insp_qty' },
    { key: 'COLOR', dbColumn: 'color', type: 'text',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.color', i18nInspectorKey: 'ui.insp_color' },
    { key: 'FORM_SIZE', dbColumn: 'form_size', type: 'text',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.form', i18nInspectorKey: 'ui.insp_form' },
    { key: 'RUN_TIME', dbColumn: 'run_time', type: 'number',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.run_h', i18nInspectorKey: 'ui.insp_run_time' },
    // Already selected/returned by the API today but never wired into any UI —
    // default hidden until an admin opts in.
    { key: 'PLANT', dbColumn: 'plant', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.plant', i18nInspectorKey: 'ui.insp_plant', gridWidth: 90 },
    { key: 'FIRMING_INDICATOR', dbColumn: 'firming_indicator', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.firming', i18nInspectorKey: 'ui.insp_firming', gridWidth: 90 },
    // PRT_01/PRT_02 — materialized from material_plants at ingest, Stage 1 of
    // docs/scheduling_priority.md. Default hidden until an admin opts in, same
    // as the other optional attribute columns above.
    { key: 'PRT_01', dbColumn: 'prt_01', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.prt_01', i18nInspectorKey: 'ui.insp_prt_01' },
    { key: 'PRT_02', dbColumn: 'prt_02', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.prt_02', i18nInspectorKey: 'ui.insp_prt_02' },
    // 10 new SAP fields (COOIS extract) — default hidden until an admin opts in.
    { key: 'PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)', dbColumn: 'planned_order_initial_quantity', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.planned_init_qty', i18nInspectorKey: 'ui.insp_planned_init_qty' },
    { key: 'REDUCED_QUANTITY_(GMEIN)', dbColumn: 'reduced_quantity', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.reduced_qty', i18nInspectorKey: 'ui.insp_reduced_qty' },
    { key: 'ORDER_CATEGORY', dbColumn: 'order_category', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.order_cat', i18nInspectorKey: 'ui.insp_order_cat' },
    { key: 'ORDER_TYPE', dbColumn: 'order_type', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.order_type', i18nInspectorKey: 'ui.insp_order_type' },
    // Was dead (db.py never wrote this column) until Stage 1 of
    // docs/scheduling_priority.md — materialized from
    // material_plants.default_production_version at ingest. Kept in its
    // original spot in this list rather than moved up by the PRT_01/PRT_02
    // entries above.
    { key: 'PRODUCTION_VERSION', dbColumn: 'production_version', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.prod_version', i18nInspectorKey: 'ui.insp_prod_version' },
    { key: 'BOM_ALTERNATIVE', dbColumn: 'bom_alternative', type: 'integer',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.bom_alt', i18nInspectorKey: 'ui.insp_bom_alt', gridWidth: 90 },
    { key: 'BOM_USAGE', dbColumn: 'bom_usage', type: 'integer',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.bom_usage', i18nInspectorKey: 'ui.insp_bom_usage', gridWidth: 100 },
    { key: 'LABOR_HOURS_(MEINH)', dbColumn: 'labor_hours', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.labor_hrs', i18nInspectorKey: 'ui.insp_labor_hrs' },
    { key: 'MACHINE_HOURS_(MEINH)', dbColumn: 'machine_hours', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.machine_hrs', i18nInspectorKey: 'ui.insp_machine_hrs' },
    { key: 'NO_OF_FTE_(MEINH)', dbColumn: 'no_of_fte', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.fte', i18nInspectorKey: 'ui.insp_fte', gridWidth: 80 },
];
