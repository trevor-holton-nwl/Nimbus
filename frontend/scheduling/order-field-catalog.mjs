/*
 * frontend/order-field-catalog.mjs — single source of truth for which optional
 * Orders fields exist and their default show/hide state in the AG Grid
 * columns and the Inspector detail panel.
 *
 * Consumed by:
 *   - Table's columnDefs builder (frontend/schedule-workbench.mts)
 *   - Inspector._render() (frontend/schedule-workbench.mts)
 *   - The admin "System Configuration" sub-tab (frontend/plant-and-administration.mts)
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
 * schedule-workbench.mts and plant-and-administration.mts can depend on it
 * without adding a new edge between those two module groups.
 */
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
    // Display-only derived scheduling fields (see Util.impliedOriginalStart) —
    // shown in both surfaces today (grid column + Inspector Schedule card row).
    { key: 'original_start_date', dbColumn: 'basic_start_date', type: 'text',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.orig_start', i18nInspectorKey: 'ui.insp_orig_start' },
    { key: 'original_end_date', dbColumn: 'basic_finish_date', type: 'text',
        gridDefault: true, inspectorDefault: true,
        i18nGridKey: 'col.orig_end', i18nInspectorKey: 'ui.insp_orig_end' },
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
        i18nGridKey: 'col.firming', i18nInspectorKey: 'ui.insp_firming', gridWidth: 90 },
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
    // Read-only distribution fields — never grid editable, default hidden until an admin opts in via System Configuration.
    { key: 'PARENT_ORDER', dbColumn: 'parent_production_order', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.sap_order', i18nInspectorKey: 'ui.insp_sap_order' },
    { key: 'DISTRIBUTION_LETTER', dbColumn: 'distribution_letter', type: 'text',
        gridDefault: false, inspectorDefault: false,
        i18nGridKey: 'col.dist_letter', i18nInspectorKey: 'ui.insp_dist_letter' },
];
