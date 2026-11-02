/*
 * frontend/scheduling/order-field-catalog.mjs — single source of truth for which optional
 * Orders fields exist and their default show/hide state in the AG Grid
 * columns and the Inspector detail panel.
 *
 * Consumed by:
 *   - Table's columnDefs builder (frontend/scheduling/orders.mts)
 *   - Inspector._render() (frontend/scheduling/orders.mts)
 *   - The admin "System Configuration" sub-tab (frontend/admin-ops/admin-ui.mts)
 *
 * CORE fields are never in this catalog and are never hideable — they stay
 * hardcoded in Table/Inspector exactly as before this feature existed:
 * production_order, machine, start_date, end_date, notes.
 *
 * Every other order attribute NIMBUS renders anywhere today is listed here so
 * an admin can toggle its default visibility globally (system_settings
 * table, see master_data.py get_system_settings/upsert_system_settings). Each
 * entry's gridDefault/inspectorDefault is seeded to match what's ALREADY
 * shown today, so turning this feature on is a zero-visual-change rollout
 * until an admin actually changes something.
 *
 * Zero-dependency leaf module: do not import anything else here, so both
 * scheduling/orders.mts and admin-ops/admin-ui.mts can depend on it
 * without adding a new edge between those two domains.
 *
 * Entry fields: `dbColumn` is documentation only (the orders column the value
 * comes from); nothing at runtime reads it (one test pins it). `inspector: false`
 * means the Inspector has no row for the field at all, so the System
 * Configuration matrix disables that entry's Inspector checkbox.
 */
/** The catalog entry for an exact field key, or undefined. */
export function getField(key) {
    return ORDER_FIELD_CATALOG.find(c => c.key === key);
}

export const ORDER_FIELD_CATALOG = [
    // Shown in Inspector today, no grid column today.
    { key: 'MATERIAL_NUMBER', dbColumn: 'material_number', type: 'text',
        gridDefault: false, inspectorDefault: true,
        i18nGridKey: 'col.material_no', i18nInspectorKey: 'ui.insp_material_no', gridWidth: 140 },
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
    // Shown in Inspector today, no grid column today.
    { key: 'FORM_SIZE', dbColumn: 'form_size', type: 'text',
        gridDefault: false, inspectorDefault: true,
        i18nGridKey: 'col.form', i18nInspectorKey: 'ui.insp_form', gridWidth: 90 },
    { key: 'RUN_TIME', dbColumn: 'run_time', type: 'number',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.run_h', i18nInspectorKey: 'ui.insp_run_time' },
    // Display-only scheduling fields — shown in both surfaces today (grid column + Inspector Schedule card row).
    // The DERIVED Original Start stays retired (backward scheduling OQ16); SAP Start is the raw SAP start as received,
    // read-only, re-added 2026-10-28 on owner request. Due Date is the SAP finish as received.
    { key: 'original_start_date', dbColumn: 'original_start_received', type: 'text',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.sap_start', i18nInspectorKey: 'ui.insp_sap_start' },
    { key: 'original_end_date', dbColumn: 'basic_finish_date', type: 'text',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.due_date', i18nInspectorKey: 'ui.insp_due_date' },
    // PRT_01/PRT_02 — materialized from material_plants at ingest, Stage 1 of
    // docs/scheduling_priority.md. Visible and editable in the Orders grid
    // today, no Inspector row today.
    { key: 'PRT_01', dbColumn: 'prt_01', type: 'text',
        gridDefault: true, inspectorDefault: false,
        i18nGridKey: 'col.prt_01', i18nInspectorKey: 'ui.insp_prt_01' },
    { key: 'PRT_02', dbColumn: 'prt_02', type: 'text',
        gridDefault: true, inspectorDefault: false,
        i18nGridKey: 'col.prt_02', i18nInspectorKey: 'ui.insp_prt_02' },
    // Materialized from material_plants.default_production_version at ingest
    // (Stage 1 of docs/scheduling_priority.md). Visible in the grid today, no
    // Inspector row today.
    { key: 'PRODUCTION_VERSION', dbColumn: 'production_version', type: 'text',
        gridDefault: true, inspectorDefault: false,
        i18nGridKey: 'col.prod_version', i18nInspectorKey: 'ui.insp_prod_version' },
    // Already returned by GET /tasks today but never rendered anywhere —
    // default hidden in both surfaces until an admin opts in.
    { key: 'PLANT', dbColumn: 'plant', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.plant', i18nInspectorKey: 'ui.insp_plant', gridWidth: 90 },
    { key: 'FIRMING_INDICATOR', dbColumn: 'firming_indicator', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.sap_firmed', i18nInspectorKey: 'ui.sap_firmed', gridWidth: 90 },
    // 9 SAP COOIS extract fields — upload-sourced (db.ingest_orders_from_excel),
    // never rendered anywhere yet. Default hidden in both surfaces until an
    // admin opts in via System Configuration.
    { key: 'PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)', dbColumn: 'planned_order_initial_quantity', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.planned_init_qty', i18nInspectorKey: 'ui.insp_planned_init_qty' },
    { key: 'REDUCED_QUANTITY_(GMEIN)', dbColumn: 'reduced_quantity', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.reduced_qty', i18nInspectorKey: 'ui.insp_reduced_qty' },
    { key: 'ORDER_CATEGORY', dbColumn: 'order_category', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.order_category', i18nInspectorKey: 'ui.insp_order_category' },
    { key: 'ORDER_TYPE', dbColumn: 'order_type', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.order_type', i18nInspectorKey: 'ui.insp_order_type' },
    { key: 'BOM_ALTERNATIVE', dbColumn: 'bom_alternative', type: 'integer',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.bom_alternative', i18nInspectorKey: 'ui.insp_bom_alternative' },
    { key: 'BOM_USAGE', dbColumn: 'bom_usage', type: 'integer',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.bom_usage', i18nInspectorKey: 'ui.insp_bom_usage' },
    { key: 'LABOR_HOURS_(MEINH)', dbColumn: 'labor_hours', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.labor_hours', i18nInspectorKey: 'ui.insp_labor_hours' },
    { key: 'MACHINE_HOURS_(MEINH)', dbColumn: 'machine_hours', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.machine_hours', i18nInspectorKey: 'ui.insp_machine_hours' },
    { key: 'NO_OF_FTE_(MEINH)', dbColumn: 'no_of_fte', type: 'number',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.no_of_fte', i18nInspectorKey: 'ui.insp_no_of_fte' },
    // Read-only distribution fields — never grid editable. The grid column is hidden until an admin opts in; the Inspector's
    // distribution card (sub-orders only) shows them by default, as it did before the Inspector honoured this setting.
    { key: 'PARENT_ORDER', dbColumn: 'parent_production_order', type: 'text',
        gridDefault: false, inspectorDefault: true,
        i18nGridKey: 'col.sap_order', i18nInspectorKey: 'ui.insp_sap_order' },
    { key: 'DISTRIBUTION_LETTER', dbColumn: 'distribution_letter', type: 'text',
        gridDefault: false, inspectorDefault: true,
        i18nGridKey: 'col.dist_letter', i18nInspectorKey: 'ui.insp_dist_letter' },
    // Routing runtime fields — default hidden until an admin opts in via System Configuration.
    { key: 'run_time_source', dbColumn: 'run_time_source', type: 'text',
        gridDefault: false, inspectorDefault: false, inspector: false,
        i18nGridKey: 'col.run_time_source', i18nInspectorKey: 'ui.insp_run_time_source', gridWidth: 100 },
    { key: 'run_time_basis', dbColumn: 'run_time_basis', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.run_time_basis', i18nInspectorKey: 'ui.insp_run_time_basis', gridWidth: 120 },
];
