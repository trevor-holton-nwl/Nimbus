// New in Stage 2 of docs/scheduling_priority.md (N22) — no prior locale-
// completeness test existed. Locale files are classic scripts (not ES
// modules), so keys are extracted via regex on the raw source text rather
// than importing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', '..', 'frontend', 'locales');
const LOCALES = ['en', 'de', 'es', 'fr', 'pt'];

// A locale file with a syntax error (e.g. an unescaped apostrophe in a single-quoted string) fails to load in the
// browser and takes the whole language with it; the key regex below would never notice, so compile each file.
for (const locale of LOCALES) {
  test(`${locale}.js is syntactically valid JavaScript`, () => {
    const file = join(LOCALES_DIR, `${locale}.js`);
    assert.doesNotThrow(() => new vm.Script(readFileSync(file, 'utf8'), { filename: file }));
  });
}

// Locale entries are usually one per line, but valid object literals may keep
// several short translations together; key discovery must not mistake that
// formatting choice for a missing translation.
const KEY_RE = /(['"])([\w.]+)\1\s*:/g;

function keysOf(locale) {
  const text = readFileSync(join(LOCALES_DIR, `${locale}.js`), 'utf8');
  const keys = new Set();
  let m;
  while ((m = KEY_RE.exec(text))) keys.add(m[2]);
  return keys;
}

function keyCount(locale, key) {
  const text = readFileSync(join(LOCALES_DIR, `${locale}.js`), 'utf8');
  return [...text.matchAll(KEY_RE)].filter(match => match[2] === key).length;
}

test('every constraint.<field> key exists in all 5 locales', () => {
  const REQUIRED = ['constraint.colorWheel', 'constraint.prt01', 'constraint.prt02', 'constraint.productionVersion'];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('Gantt legend popup keys (btn.legend, tip.legend, legend.*) exist in all 5 locales', () => {
  // #modal-gantt-legend (scheduling/gantt-legend.mts): the toolbar button label and tooltip plus every title,
  // explanation and scene label of the legend. Each must be translated, not left to the missing-key ratchet.
  const REQUIRED = [
    'btn.legend', 'tip.legend',
    'legend.title', 'legend.intro', 'legend.scene_title', 'legend.day_yesterday', 'legend.day_today',
    'legend.day_tomorrow', 'legend.scene_blackout_reason', 'legend.group_orders', 'legend.group_setup',
    'legend.group_shading', 'legend.group_markers', 'legend.group_nav', 'legend.standard_t',
    'legend.standard_d', 'legend.firmed_t', 'legend.firmed_d', 'legend.selected_t', 'legend.selected_d',
    'legend.conflict_t', 'legend.conflict_d', 'legend.dimmed_t', 'legend.dimmed_d', 'legend.split_t',
    'legend.split_d', 'legend.dist_t', 'legend.dist_d', 'legend.dist_sibling_t', 'legend.dist_sibling_d',
    'legend.ghost_t', 'legend.ghost_d', 'legend.ghost_conflict_t', 'legend.ghost_conflict_d', 'legend.setup_t',
    'legend.setup_d', 'legend.setup_conflict_t', 'legend.setup_conflict_d', 'legend.setup_missing_t',
    'legend.setup_missing_d', 'legend.past_t', 'legend.past_d', 'legend.nonworking_t', 'legend.nonworking_d',
    'legend.blackout_t', 'legend.blackout_d', 'legend.frozen_t', 'legend.frozen_d', 'legend.alert_t',
    'legend.alert_d', 'legend.alertcell_err_t', 'legend.alertcell_err_d', 'legend.alertcell_warn_t',
    'legend.alertcell_warn_d', 'legend.alertcell_cal_t', 'legend.alertcell_cal_d', 'legend.gridline_t',
    'legend.gridline_d', 'legend.now_t', 'legend.now_d', 'legend.visibility_t', 'legend.visibility_d',
    'legend.nav_viewport_t', 'legend.nav_viewport_d', 'legend.nav_bars_t',
    'legend.nav_bars_d', 'legend.nav_alert_t', 'legend.nav_alert_d', 'legend.nav_closed_t', 'legend.nav_closed_d',
    'legend.nav_blackout_t', 'legend.nav_blackout_d', 'legend.nav_hist_t', 'legend.nav_hist_d', 'legend.nav_now_t',
    'legend.nav_now_d',
    'legend.pm_capacity_t', 'legend.pm_capacity_d', 'legend.pm_conflicts_t', 'legend.pm_conflicts_d',
    'legend.pm_calendar_t', 'legend.pm_calendar_d', 'legend.pm_setup_t', 'legend.pm_setup_d',
    'legend.pm_exceptions_t', 'legend.pm_exceptions_d', 'legend.pm_ring_d',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('N6 missing-setup remedy keys exist in all 5 locales', () => {
  // ui.setup_missing_remedy_state / _row back the per-reason remedy text
  // surfaced in the Optimize preview table, both CSV exports, the
  // never-freeze banner and the Setup Matrix review chip filter (N6b).
  const REQUIRED = ['ui.setup_missing_remedy_state', 'ui.setup_missing_remedy_row', 'ui.opt_pv_scheduled_state_unrecorded',
    'ui.setup_col_remedy', 'ui.setup_review_filter_state', 'ui.setup_review_filter_row', 'ui.setup_review_filter_all'];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('Stage 0 setup-matrix administration keys exist in all 5 locales', () => {
  // ui.setup_matrix_observation, btn.setup_export_csv, and btn.setup_delete_override
  // were retired as dead i18n keys (docs/Setup_matrix_redesign.md §10/§15) — the
  // "REFERENCE DATA" observation eyebrow, CSV-export button, and delete-row
  // wiring they backed have no remaining callers.
  // ui.setup_inherited backed the old flat edge-list table's `tr.inherited`
  // row styling; the grid rebuild (docs/archive/setup_matrix_ui_redesign.md) replaced
  // that table and never carried this key's usage forward.
  const REQUIRED_SETUP = [
    'ui.setup_matrix_title',
    'ui.setup_activation_inactive',
    'ui.setup_compatibility', 'ui.setup_compatibility_reason', 'ui.setup_not_global_exclusion',
    'ui.setup_import_csv',
    'ui.setup_state_source',
    'ui.setup_observed_at', 'ui.setup_override_audit',
    'ui.setup_detail_title', 'ui.setup_predecessor', 'ui.setup_predecessor_state', 'ui.setup_required',
    'ui.setup_effective', 'ui.setup_standard', 'ui.setup_source',
    'ui.setup_override', 'ui.setup_missing', 'ui.setup_capacity_shortfall',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_SETUP) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('Task 5 reuses the existing setup source label exactly once in every locale', () => {
  for (const locale of LOCALES) {
    assert.equal(keyCount(locale, 'ui.setup_source'), 1,
      `${locale}.js must not introduce a second ui.setup_source key`);
  }
});

test('Stage 3 priority-tree / effective-sequence ui.* keys exist in all 5 locales', () => {
  // Task 9 of 2026-08-11-priority-lists-stage-3 — added by Task 8's tree UI
  // (Plant ▸ Settings ▸ Scheduling Constraints): add/remove controls on the
  // priority tree and the "Effective sequence" readout panel.
  const REQUIRED_STAGE3 = [
    'ui.no_effect',
    'ui.no_constraints_configured',
    'ui.add_sub_priority',
    'ui.add_priority',
    'ui.all_fields_used',
    'ui.effective_sequence',
    // Final-review fix wave: the generic (all-fields) replacements for the
    // colorWheel-only 'ui.constraint_no_wheel' / 'modal.no_color_wheel_confirm_msg'
    // pair, now that every registered priority field can be silently inert (N11).
    'ui.constraint_no_list',
    'modal.no_priority_ranks_confirm_msg',
    // Same wave, i18n follow-up: the Optimize dialog's priority-list badge
    // tooltips (OptimizeDialog._updatePlantBadge, one key per badge state).
    // These replace five colorWheel-worded keys that had been authored and
    // left unwired while the badge set English literals — which is how a
    // localized `constraint.<field_key>` name ended up interpolated into an
    // English sentence. Required here so the generic wordings can never
    // regress to that state in one locale only.
    'ui.opt_badge_checking',
    'ui.opt_badge_no_plant',
    'ui.opt_badge_lists_loaded',
    'ui.opt_badge_lists_missing',
    'ui.opt_badge_check_failed',
    'ui.opt_badge_none_enabled',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_STAGE3) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('Setup Matrix grid redesign keys exist in all 5 locales', () => {
  // docs/Setup_matrix_redesign.md — the four-band layout + grid rebuild pass.
  // ui.setup_eyebrow_active/_inactive, the setup_group_* group headers/descs,
  // ui.setup_line_status_empty, ui.setup_step2_grid, and ui.setup_kpi_observed/
  // _reachable were retired: the four-group layout collapsed into four bands
  // (context bar, standard rail, grid, action bar) with one status chip and
  // an inline coverage readout replacing the KPI tiles (§9, §15).
  const REQUIRED_GRID = [
    'ui.settings_subtab_rules', 'ui.settings_subtab_setup',
    'ui.setup_include_setup_times',
    'ui.setup_step1_definition',
    // Band A/B additions (§9): status-chip-adjacent signature popover, Scope
    // selector, inline coverage readout, and the missing-pairs review chip
    // that replaced the tab's own copy of the missing-pairs mini-table.
    'ui.setup_band_signature_label', 'ui.setup_scope_label', 'ui.setup_no_definition_short',
    'ui.setup_signature_popover_hint', 'ui.setup_coverage_inline',
    'ui.setup_review_chip', 'btn.setup_review_clear',
    // "You are here" row marker (§9-C.5), replacing the standalone Line Status panel.
    'ui.setup_you_are_here', 'ui.setup_you_are_here_hint',
    // Split From/To filter (docs/Setup_matrix_redesign.md §6) replaces the
    // single shared ui.setup_grid_filter_placeholder, which made directional
    // inspection (e.g. BLUE→RED) impossible.
    'ui.setup_grid_filter_from_placeholder', 'ui.setup_grid_filter_to_placeholder',
    'ui.setup_grid_axis_capped', 'ui.setup_grid_uncovered_hint',
    'ui.setup_grid_implicit_zero_hint', 'ui.setup_grid_line_override_hint',
    'ui.setup_grid_dirty_count', 'ui.setup_grid_no_values',
    'ui.setup_grid_invalid_minutes',
    'ui.setup_grid_pasted', 'ui.setup_grid_paste_rejected',
    'ui.setup_replace_confirm_title', 'ui.setup_replace_confirm_msg',
    'ui.setup_kpi_missing_count',
    'btn.setup_audit_toggle', 'btn.setup_copy_matrix', 'btn.setup_export_matrix',
    'btn.setup_copy_missing', 'btn.setup_export_missing', 'btn.setup_replace_confirm',
    'btn.setup_field_up', 'btn.setup_field_down',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_GRID) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('setup-aware optimizer never-freeze toast key exists in all 5 locales', () => {
  // B4 (quiet-wandering-lerdorf.md): the never-freeze rework added a second
  // toast, alongside toast.optimize_missing_setup_summary, for orders left
  // at their existing dates because no capacity remained in the horizon.
  const REQUIRED_NEVER_FREEZE = ['toast.optimize_orders_left_in_place'];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_NEVER_FREEZE) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('Scheduling Rules density pass keys exist in all 5 locales', () => {
  // 2026-08-21: Plant ▸ Settings ▸ Scheduling Rules compact-form rework moved
  // every per-field description into a right-click "More info" popover and
  // fixed the split-policy save handler's two hardcoded English toasts. The
  // follow-up pass the same day split the form into two titled panels
  // ("Horizons" / "Order Rules") and dropped the Visibility Horizon,
  // Roll-forward hour and Setup-aware optimization rows. `ui.unit_hour_utc`
  // stays pinned even though nothing renders it now (see admin-ui.mts's own
  // comment on RULE_HELP) — the POST /master-data/plants/{plant}/visibility-horizon
  // route this comment used to cite was itself removed 2026-09 as confirmed
  // dead (its only frontend caller had already been removed 2026-08-21, the
  // same day as this rework); these keys are kept purely because this test
  // still pins them, not because anything live still depends on them.
  const REQUIRED_SCHED_RULES = [
    'ui.more_info',
    'ui.split_policy_saved',
    'ui.split_policy_save_failed',
    'ui.unit_minutes',
    'ui.unit_hour_utc',
    'ui.sched_section_horizons',
    'ui.sched_section_order_rules',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_SCHED_RULES) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('N8c unknown-setup scheduling-rules control keys exist in all 5 locales', () => {
  // N8c: Scheduling Rules pane's per-plant unknown-setup-policy control
  // (dropdown + plant-default minutes row + rule-help hint), saved via N8a's
  // POST /master-data/plants/{plant}/unknown-setup-policy.
  const REQUIRED_UNKNOWN_SETUP = [
    'ui.unknown_setup_title',
    'ui.unknown_setup_help',
    'ui.unknown_setup_opt_zero',
    'ui.unknown_setup_opt_default',
    'ui.unknown_setup_opt_exclude',
    'ui.unknown_setup_minutes_label',
    'ui.unknown_setup_saved',
    'ui.unknown_setup_failed',
    'ui.unknown_setup_minutes_invalid',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_UNKNOWN_SETUP) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('Command Palette (cmdp.*) keys exist in all 5 locales', () => {
  // 2026-09 i18n sweep (Code_Review_09_01.md §5/§11 item 21) — CommandPalette
  // (frontend/nimbus-intelligence.js) previously had its chrome (aria-labels,
  // tooltips, empty-state) routed through Util.t() but every visible command
  // label/sub/placeholder/toast-fallback string hardcoded in English. All
  // cmdp.* keys below are new; de/es/fr/pt currently carry the English text
  // with a `// MISSING TRANSLATION` marker (same convention as pre-existing
  // untranslated keys elsewhere in these files) pending real translation.
  const REQUIRED_COMMAND_PALETTE = [
    'cmdp.need_conflict_jump', 'cmdp.sub_scroll_to_overlap',
    'cmdp.need_overload_inspect', 'cmdp.sub_scroll_to_overloaded_line',
    'cmdp.need_unscheduled_review', 'cmdp.sub_switch_to_orders_table',
    'cmdp.need_snapshot_due', 'cmdp.sub_take_checkpoint',
    'cmdp.need_first_snapshot', 'cmdp.sub_save_first_entry',
    'cmdp.need_blackout_risk', 'cmdp.sub_review_blackout_overlap',
    'cmdp.need_sandbox_active', 'cmdp.sub_whatif_mode',
    'cmdp.label_compare_snapshot', 'cmdp.sub_open_diff_viewer',
    'cmdp.intent_freeze_label', 'cmdp.intent_freeze_sub',
    'cmdp.intent_rush_label', 'cmdp.intent_rush_sub',
    'cmdp.label_optimize_schedule', 'cmdp.sub_run_optimizer',
    'cmdp.label_print_export_schedule', 'cmdp.sub_open_export_dialog',
    'cmdp.label_take_snapshot_now',
    'cmdp.label_jump_first_conflict', 'cmdp.sub_scroll_to_error_alert',
    'cmdp.label_go_to_line', 'cmdp.sub_scroll_to_this_line',
    'cmdp.label_isolate_line', 'cmdp.sub_show_only_this_line',
    'cmdp.label_jump_first_conflict_title',
    'cmdp.label_take_snapshot_title', 'cmdp.sub_save_manual_checkpoint',
    'cmdp.label_print_export_title', 'cmdp.sub_open_print_export_dialog',
    'cmdp.label_go_to_now', 'cmdp.sub_center_gantt_on_now',
    'cmdp.label_time_machine', 'cmdp.sub_browse_schedule_history',
    'cmdp.label_compare_schedules', 'cmdp.sub_diff_current_vs_snapshot',
    'cmdp.label_reload_data', 'cmdp.sub_reread_excel',
    'cmdp.index_actions_count', 'cmdp.index_lines_count',
    'cmdp.index_orders_count', 'cmdp.index_selection_count',
    'cmdp.search_placeholder', 'cmdp.close_button_title', 'cmdp.no_match_hint',
    'cmdp.label_unfirm_selected', 'cmdp.label_firm_selected',
    'cmdp.sub_make_orders_moveable', 'cmdp.sub_pin_orders_in_place',
    'cmdp.label_push_selected', 'cmdp.sub_shift_orders_1h', 'cmdp.toast_no_orders_moveable',
    'cmdp.label_unschedule_selected', 'cmdp.sub_remove_start_end_times', 'cmdp.toast_split_orders_whole',
    'cmdp.label_snapshot_before_acting', 'cmdp.sub_save_checkpoint_now',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_COMMAND_PALETTE) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('Optimizer mode tips exist in all 5 locales', () => {
  // N5d: tip.duedate_mode and tip.changeover_mode document the per-plant
  // "priority tiers vs. lateness" tradeoff chosen by mode; added in Step 2.
  const REQUIRED_MODE_TIPS = ['tip.duedate_mode', 'tip.changeover_mode'];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_MODE_TIPS) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('Order Distribution feature (P2-22) keys exist in all 5 locales', () => {
  // The Order Distribution feature (aggregate_to_detail.md, ROUTING_RUNTIME_DESIGN.md)
  // introduces work-center distribution modes, shares editors, sub-order management,
  // and distribution review workflows. All user-facing strings are localized.
  const REQUIRED_DISTRIBUTION = [
    // Tab labels
    'tab.distribution', 'tab.sap_workcenter', 'tab.work_centers',
    // Column header
    'col.default_machine_hint',
    // Work center modes and settings (ui.wc_*)
    'ui.wc_admins_edit', 'ui.wc_mode_single', 'ui.wc_mode_distribute',
    'ui.wc_max_sep_none', 'ui.wc_max_sep_hour', 'ui.wc_max_sep_day', 'ui.wc_max_sep_week',
    'ui.wc_review_required_label', 'ui.wc_review_required_hint', 'ui.wc_review_required_help',
    'ui.wc_distribute_tooled_label', 'ui.wc_distribute_tooled_hint', 'ui.wc_distribute_tooled_help',
    'ui.wc_membership_title', 'ui.wc_assign_hint', 'ui.wc_total_row', 'ui.wc_even_placeholder',
    'ui.wc_not_set_zero', 'ui.wc_distribute_thin_warning', 'ui.wc_single_needs_default',
    'ui.wc_default_not_member',
    // Distribution filters and buckets
    'ui.dist_filter_from', 'ui.dist_filter_to',
    'ui.dist_bucket_needs_review', 'ui.dist_bucket_changed', 'ui.dist_bucket_problems', 'ui.dist_bucket_all',
    // Distribution table columns and details
    'ui.dist_col_order', 'ui.dist_col_material', 'ui.dist_col_workcenter', 'ui.dist_col_qty',
    'ui.dist_col_start', 'ui.dist_col_suborders', 'ui.dist_col_status', 'ui.dist_col_reviewed',
    'ui.dist_showing_count', 'ui.dist_batch_chip', 'ui.dist_detail_empty', 'ui.dist_detail_window',
    'ui.dist_detail_hours', 'ui.dist_detail_hours_vs', 'ui.dist_detail_updated', 'ui.dist_detail_reviewed',
    'ui.dist_upload', 'ui.dist_shares_editor_placeholder',
    // Distribution basis/explanation
    'ui.dist_basis_material_default', 'ui.dist_basis_tooled_single', 'ui.dist_basis_weights',
    'ui.dist_basis_even', 'ui.dist_basis_manual', 'ui.dist_basis_unknown',
    // Distribution status indicators
    'ui.dist_status_incomplete', 'ui.dist_status_incomplete_tip',
    'ui.dist_status_runtime_mismatch', 'ui.dist_status_runtime_mismatch_tip',
    'ui.dist_status_separation_violated', 'ui.dist_status_separation_violated_tip',
    'ui.dist_status_wc_changed', 'ui.dist_status_wc_changed_tip',
    'ui.dist_status_membership_changed', 'ui.dist_status_membership_changed_tip',
    'ui.dist_status_mode_mismatch', 'ui.dist_status_mode_mismatch_tip',
    'ui.dist_status_qty_changed', 'ui.dist_status_qty_changed_tip',
    'ui.dist_status_below_min_lot', 'ui.dist_status_below_min_lot_tip',
    'ui.dist_status_zero_quantity_children', 'ui.dist_status_zero_quantity_children_tip',
    'ui.dist_status_needs_review', 'ui.dist_status_needs_review_tip',
    'ui.dist_status_purged', 'ui.dist_status_purged_tip',
    // Distribution editor
    'ui.dist_editor_col_letter', 'ui.dist_editor_col_machine', 'ui.dist_editor_col_weight',
    'ui.dist_editor_col_effective', 'ui.dist_editor_col_qty_after', 'ui.dist_editor_col_hours_after',
    'ui.dist_editor_col_start', 'ui.dist_editor_col_outcome', 'ui.dist_editor_total',
    'ui.dist_no_suborder', 'ui.dist_outcome_unchanged', 'ui.dist_outcome_resized',
    'ui.dist_outcome_new', 'ui.dist_outcome_removed',
    'ui.dist_marker_frozen', 'ui.dist_marker_stale', 'ui.dist_marker_purged', 'ui.dist_marker_below_min_lot',
    // Distribution actions
    'ui.dist_save_plain', 'ui.dist_save_removes', 'ui.dist_confirm_remove_title', 'ui.dist_confirm_remove_msg',
    'ui.dist_saved_reconcile', 'ui.dist_banner_firmed_left', 'ui.dist_whatif_blocked',
    'ui.dist_bulk_selected', 'ui.dist_bulk_partial_msg', 'ui.dist_bulk_review_result_title',
    'ui.dist_bulk_reset_result_title',
    // Distribution inspector/KPI
    'ui.insp_machine_locked_title', 'ui.work_status_distribution',
    'ui.hov_suborder',
    'ui.insp_dist_title', 'ui.insp_dist_share', 'ui.insp_dist_siblings',
    'ui.insp_dist_note_child', 'ui.insp_dist_note_bare',
    'btn.insp_dist_open',
    // Toast messages
    'toast.optimize_distribution_separation',
    'toast.dist_machine_locked', 'toast.dist_load_failed', 'toast.dist_detail_load_failed',
    'toast.dist_review_failed', 'toast.dist_reviewed', 'toast.dist_shares_saved', 'toast.dist_shares_save_failed',
    'toast.dist_stale_refetched', 'toast.dist_reset_failed', 'toast.dist_repaired', 'toast.dist_repair_failed',
    'toast.dist_bulk_done', 'toast.dist_reassign_confirm',
    // toast.wc_code_required/_shadowed/_exists, toast.wc_single_needs_default_at_create,
    // toast.wc_created and toast.wc_create_failed were removed: creation was
    // taken out of the Work Centers tab (work centers now only come from SAP
    // interface ingest or the Admin > Manage Plant Data grid), so there is no
    // create-time validation or create-result toast left to back.
    'toast.wc_load_failed',
    'toast.wc_invalid_weight', 'toast.wc_saved', 'toast.wc_save_failed',
    // Alert messages
    'alert.distribution_separation',
    // Error messages
    'err.dist_weights_empty', 'err.dist_duplicate_machine', 'err.dist_share_purged',
    'err.dist_stale_machine', 'err.dist_workcenter_missing',
    // Empty states
    'empty.dist_no_workcenters_title', 'empty.dist_no_workcenters_msg',
    'empty.dist_no_orders_title', 'empty.dist_no_orders_msg',
    'empty.dist_no_match_title', 'empty.dist_no_match_msg',
    'empty.wc_select_plant', 'empty.wc_select_row', 'empty.wc_no_members',
    // KPI and command palette
    'kpi.orders_sub_counted',
    'cmdp.need_distribution_review', 'cmdp.sub_view_distribution',
    // Buttons and placeholders
    // btn.new_work_center dropped with the create form it opened. btn.create
    // stays pinned below — this repo's convention for a generic verb key kept
    // even though it is now unreferenced (see this file's own comments around
    // lines 56-63 and 183-195 for other examples of that convention).
    'btn.create', 'btn.load_more', 'btn.even',
    // ph.wc_code/_description backed the removed create form's own inputs;
    // gone with it. ph.wc_default_machine/select_work_center are still used
    // by the surviving detail-pane combobox/selector.
    'ph.search_work_centers', 'ph.wc_default_machine', 'ph.select_work_center',
    // New in the autosave-on-change rework: the sidebar's block-reason glyph
    // tooltip (ui.wc_blocked_needs_members) and member-count badge tooltip
    // (ui.wc_member_count_tip) — see WorkCenters._wcNoticeText/_renderSidebarList.
    'ui.wc_blocked_needs_members', 'ui.wc_member_count_tip',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_DISTRIBUTION) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('SAP staging (Admin > Interface > Staging) keys exist in all 5 locales', () => {
  // docs/SAP_STAGING_DESIGN.md §3.5 — batch list, apply/confirm/discard, rejected rows,
  // upload, Outbound (Send to SAP) and Archive panels, plus the per-status / per-warning
  // families below. Real translations in de/es/fr/pt, not English copies.
  const STATUSES = ['loading', 'ready', 'validated', 'held', 'applying', 'applied', 'error', 'rejected', 'superseded', 'discarded'];
  const WARNINGS = [
    'routing_required', 'vanish_threshold', 'horizon_unlimited_no_deletes', 'empty_snapshot', 'incomplete_rows', 'lot_size_rounded',
    'stale_loading', 'unknown_columns', 'rows_not_staged', 'discarded', 'unknown_object_key', 'unknown_plant',
    'vanish_not_reviewed', 'revalidate_required', 'apply_in_progress', 'not_applicable', 'superseded', 'order_exists',
    'sap_changed', 'unfirmed', 'sap_changed_running', 'unparseable_dates', 'routing_running_kept',
  ];
  const REJECTS = ['missing_key', 'plant_mismatch', 'unknown_plant', 'duplicate_key', 'invalid_date', 'invalid_time',
    'invalid_number', 'invalid_int', 'key_too_long', 'value_too_long', 'deleted_flag', 'rejected_by_validator'];
  const REQUIRED_SAP_STAGING = [
    'ui.sap_staging', 'ui.sap_staging_group', 'ui.sap_connectors_group',
    'ui.sap_stage_batches', 'ui.sap_stage_no_batches',
    'ui.sap_stage_apply', 'ui.sap_stage_confirm_apply', 'ui.sap_stage_retry_apply',
    'ui.sap_stage_validate', 'ui.sap_stage_discard', 'ui.sap_stage_refresh',
    'ui.sap_stage_apply_mode', 'ui.sap_stage_mode_manual', 'ui.sap_stage_mode_auto',
    'ui.sap_stage_mode_hint', 'ui.sap_stage_mode_hint_auto', 'ui.sap_stage_mode_hint_manual',
    'ui.sap_stage_plant_required',
    'ui.sap_stage_rejected_rows', 'ui.sap_stage_rejected_empty', 'ui.sap_stage_rejected_shown',
    'ui.sap_stage_download_csv', 'ui.sap_stage_upload',
    'ui.sap_stage_held_banner', 'ui.sap_stage_held_routing',
    'ui.sap_stage_vanish', 'ui.sap_stage_deletions', 'ui.sap_stage_deletions_more', 'ui.sap_stage_counts',
    'ui.sap_stage_time_received', 'ui.sap_stage_time_ready', 'ui.sap_stage_time_validated', 'ui.sap_stage_time_applied',
    'ui.sap_stage_col_order', 'ui.sap_stage_col_end', 'ui.sap_stage_col_firmed',
    'ui.sap_stage_col_key', 'ui.sap_stage_deletions_rows',
    'ui.sap_stage_col_deleted_at', 'ui.sap_stage_col_deleted_by', 'ui.sap_stage_firmed_yes',
    'ui.sap_stage_confirm_msg',
    ...STATUSES.map(s => `ui.sap_stage_status_${s}`),
    ...WARNINGS.map(w => `ui.sap_stage_warn_${w}`),
    ...REJECTS.map(r => `ui.sap_stage_reject_${r}`),
    'ui.sap_stage_col_reason', 'ui.sap_stage_col_running', 'ui.sap_stage_running_yes',
    'ui.sap_stage_delete_notice', 'ui.sap_stage_delete_running_count', 'ui.sap_stage_confirm_delete_msg',
    'ui.sap_outbound', 'ui.sap_outbound_last_queued', 'ui.sap_outbound_last_sent', 'ui.sap_outbound_error_csv',
    'ui.sap_send_to_sap', 'ui.sap_send_confirm',
    'ui.sap_send_status_ready', 'ui.sap_send_status_sent', 'ui.sap_send_status_error',
    'ui.sap_archive', 'ui.sap_archive_restore', 'ui.sap_archive_restore_confirm',
    'ui.sap_archive_restored', 'ui.sap_archive_empty',
    'ui.sap_map_primer_staging',
    'toast.sap_stage_applied', 'toast.sap_stage_apply_failed', 'toast.sap_stage_failed',
    'toast.sap_stage_uploaded', 'toast.sap_stage_discarded', 'toast.sap_stage_validated',
    'toast.sap_poll_done', 'toast.sap_sent_queued', 'toast.sap_archive_restored',
    'alert.zero_open_quantity',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_SAP_STAGING) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
  // Translated, not copied: every non-English value must differ from the English one,
  // except the product-name/loanword labels that are identical by design.
  const SAME_OK = new Set(['ui.sap_staging', 'ui.sap_staging_group', 'ui.sap_stage_mode_manual', 'ui.sap_stage_status_error', 'ui.sap_send_status_error', 'ui.sap_stage_status_ready', 'ui.sap_send_status_ready']);
  const val = (loc, key) => readFileSync(join(LOCALES_DIR, `${loc}.js`), 'utf8').match(new RegExp(`'${key.replace(/\./g, '\\.')}'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`))?.[1];
  for (const key of REQUIRED_SAP_STAGING.filter(k => !SAME_OK.has(k))) {
    for (const loc of ['de', 'es', 'fr', 'pt']) {
      assert.notEqual(val(loc, key), val('en', key), `${loc}.js carries the English text for "${key}"`);
    }
  }
});

test('F10 (D34) — every dist_/wc_-family key in en.js exists in all 5 locales', () => {
  // Task F10's parity test (docs/archive/… brief): derive the distribution/
  // work-center family from en.js itself rather than hand-listing every key
  // (the existing "Order Distribution feature" test above already does
  // that for an older snapshot) — this way a NEW dist_/wc_ key added later
  // without its translations fails here too, not just in en.js.
  const FAMILY_RE = /^(ui|btn|toast|err|empty|ph|col|aria)\.(dist_|wc_)|^ui\.review_distributions$|^col\.(max_separation|distribution_mode|open_distributions)$|^ui\.(conflicting_parent_rows|ambiguous_plant_conflicts|workcenter_without_members|default_machine_invalid)$/;
  // Fix round 1: the regex alone can't reach plain column/empty-state names
  // that have no dist_/wc_ infix (col.description/col.machine/col.weight/
  // col.effective_pct are shared Work Centers-tab column headers, and
  // empty.no_work_centers is the tab's empty state) — widening the regex to
  // match any col.*/empty.* would over-match unrelated keys like col.id or
  // empty.no_alerts, so these five are listed explicitly instead.
  const EXTRA_REQUIRED = ['col.description', 'col.machine', 'col.weight', 'col.effective_pct', 'empty.no_work_centers'];
  const en = keysOf('en');
  const family = [...new Set([...[...en].filter(k => FAMILY_RE.test(k)), ...EXTRA_REQUIRED])];
  assert.ok(family.length > 0, 'the dist_/wc_ family regex matched nothing in en.js — regex or fixture drifted');
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of family) {
    assert.ok(en.has(key), `en.js itself is missing distribution/work-center key "${key}"`);
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing distribution/work-center key "${key}"`);
    }
  }
});

test('en.js is the superset — no locale has a key en.js lacks', () => {
  const en = keysOf('en');
  for (const locale of LOCALES.filter(l => l !== 'en')) {
    const extra = [...keysOf(locale)].filter(k => !en.has(k));
    assert.deepEqual(extra, [], `${locale}.js has keys not present in en.js: ${extra.join(', ')}`);
  }
});

// Ratchet (CR 09-25 #23): non-English locales may lag en.js, but the number of
// missing keys per locale must never grow. When you ADD keys to en.js, add the
// same keys to every locale (English value is fine) rather than raising these
// numbers; when you translate and the count drops, LOWER the number here.
const MISSING_KEY_BASELINE = { de: 230, es: 230, fr: 230, pt: 230 };

test('locale parity ratchet - missing-key count per locale never grows vs en.js', () => {
  const en = keysOf('en');
  for (const [locale, baseline] of Object.entries(MISSING_KEY_BASELINE)) {
    const have = keysOf(locale);
    const missing = [...en].filter(k => !have.has(k));
    assert.ok(
      missing.length <= baseline,
      `${locale}.js is missing ${missing.length} en.js keys (baseline ${baseline}); add the new keys (English value is fine). Last missing: ${missing.slice(-5).join(', ')}`,
    );
  }
});

test('G3: ui.firm_reason_running says running orders are protected from Optimize/auto-fixes (not "locked") in every locale', () => {
  const val = (loc) => readFileSync(join(LOCALES_DIR, `${loc}.js`), 'utf8').match(/'ui\.firm_reason_running'\s*:\s*'([^']*)'/)?.[1];
  assert.equal(val('en'), 'Running — protected from Optimize and auto-fixes');
  for (const loc of ['de', 'es', 'fr', 'pt']) {
    assert.ok(val(loc) && val(loc) !== val('en'), `${loc} must carry its own translation`);
  }
  assert.doesNotMatch(val('en'), /locked/i);
});

// Backward scheduling Task 3.4 (group 32): the finish-anchored vocabulary. Each key below was reworded (or renamed
// from an "Original/Updated" key) and must exist in all five files; en.js must carry the pinned English text. The
// four translations are written separately, so this pins presence and the English source, not the translation.
const REWORDED_KEYS = {
  'col.due_date': 'Due Date',
  'col.planned_start': 'Planned Start',
  'col.planned_finish': 'Planned Finish',
  'ui.insp_due_date': 'Due Date',
  'ui.insp_planned_start': 'Planned Start',
  'ui.insp_planned_finish': 'Planned Finish',
  'ui.insp_variance_shifted': 'Planned finish compared with the due date',
  'ui.diff_kind_start': 'Planned start',
  'ui.diff_kind_finish': 'Planned finish',
  'toast.order_moved': 'Moved "{{name}}" so it now finishes {{date}}',
  'toast.commit_failed': 'Could not hold the finish there. The order stays where it was.',
  'toast.sap_sent_queued': 'Queued {{queued}} orders for SAP',
};
const RETIRED_KEYS = ['col.orig_start', 'col.orig_end', 'col.updated_start', 'col.updated_end',
  'ui.insp_orig_start', 'ui.insp_orig_end', 'ui.insp_updated_start', 'ui.insp_updated_end'];
const enDict = (() => {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(join(LOCALES_DIR, 'en.js'), 'utf8'), sandbox);
  return sandbox.window.__NIMBUS_LOCALES.en;
})();
const enValue = key => enDict[key];

test('group 32: every reworded scheduling key exists in all five locales and en.js carries the finish-anchored text', () => {
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const [key, text] of Object.entries(REWORDED_KEYS)) {
    assert.equal(enValue(key), text, `en.js text for "${key}"`);
    for (const locale of LOCALES) assert.ok(perLocale[locale].has(key), `${locale}.js is missing reworded key "${key}"`);
  }
});

test('group 32: the retired Original/Updated keys are gone from every locale', () => {
  for (const locale of LOCALES) {
    const have = keysOf(locale);
    for (const key of RETIRED_KEYS) assert.ok(!have.has(key), `${locale}.js still carries retired key "${key}"`);
  }
});

test('gate 4b: every alert.* message key the compute core can emit exists in all 5 locales (literals, derivation-issue codes, reversal details)', () => {
  const core = readFileSync(join(__dirname, '..', '..', 'frontend', 'nimbus-compute-core.js'), 'utf8');
  const emitted = new Set([...core.matchAll(/'(alert\.[a-z_]+)'/g)].map(m => m[1]));
  // `alert.${code}` is built from the derivation-issue switch: every case label is a key.
  const sw = core.slice(core.indexOf("switch (code) {"), core.indexOf("default:", core.indexOf("switch (code) {")));
  const codes = [...sw.matchAll(/case '([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(codes.includes('finish_moved_earlier') && codes.includes('pull_floor_crossed'), 'the derivation switch was found');
  for (const code of codes) emitted.add(code === 'reversal_forward' ? 'alert.reversal_forward' : `alert.${code}`);
  for (const detail of ['run_time_grew', 'due_date_past', 'cutover']) emitted.add(`alert.reversal_forward_${detail}`);
  assert.ok(emitted.size >= 20, `expected the core to emit 20+ alert keys, found ${emitted.size}`);
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of emitted) {
    for (const locale of LOCALES) assert.ok(perLocale[locale].has(key), `${locale}.js is missing alert key "${key}"`);
  }
});

// Senior review U32/U28/U34: a presence + placeholder + non-empty guard over EVERY en.js key this branch added or
// reworded (hand list, like the lists above). A later new key must be appended here; the parity ratchet above only
// bounds the count, it does not look at values.
const BRANCH_KEYS = [
  'toast.optimize_plant_no_timezone', 'toast.plant_no_timezone', 'toast.finish_cannot_hold', 'toast.left_edge_locked',
  'toast.system_moved_n', 'toast.cutover_summary', 'toast.manual_refusal_generic', 'toast.order_moved', 'toast.commit_failed',
  'modal.override_finish_label', 'modal.override_finish_hint', 'modal.override_title', 'modal.override_line_label',
  'modal.override_apply', 'modal.confirm_overtime_title', 'modal.confirm_overtime_msg', 'modal.confirm_overtime_confirm',
  'col.due_date', 'col.planned_start', 'col.planned_finish', 'planning_reason.run_time_over_cap',
  'planning_reason.overlong_never', 'ui.diff_kind_start', 'ui.diff_kind_finish', 'ui.max_push_forward_help',
  'ui.insp_due_date', 'ui.insp_planned_start', 'ui.insp_planned_finish', 'ui.insp_system_move',
  'ui.insp_move_reason_finish_moved_earlier', 'ui.insp_move_reason_reversal_forward', 'ui.insp_move_reason_pull_floor_crossed',
  'ui.insp_move_reason_run_time_changed', 'ui.insp_move_reason_due_date_derivation', 'ui.insp_move_reason_cutover',
  'ui.hov_run', 'ui.insp_variance_shifted', 'ui.derive_paused', 'alert.setup_violated', 'alert.distribution_separation',
  'alert.start_may_be_stale', 'alert.late', 'alert.late_beyond_cap', 'alert.finish_moved_earlier', 'alert.reversal_forward',
  'alert.reversal_forward_run_time_grew', 'alert.reversal_forward_due_date_past', 'alert.reversal_forward_cutover',
  'alert.plant_no_timezone', 'alert.line_no_calendar', 'alert.no_anchor', 'alert.no_operating_window', 'alert.run_time_zero',
  'alert.setup_override_orphaned', 'alert.pull_floor_crossed', 'alert.frozen_window_crossed',
  'alert.placement_exception_overtime', 'alert.placement_exception_overlong', 'alert.derivation_issue',
  'ui.diag_unreadable_start', 'ui.diag_dropped_no_finish', 'ui.sap_send_confirm', 'toast.sap_sent_queued',
  'toast.sap_sent_skipped_unfirmed', 'ui.preview_stale', 'ui.opt_backlog_runtime_grew',
  'ui.dist_status_separation_violated_tip', 'ui.opt_pv_distribution_separation_head', 'ui.reject_run_time_over_cap',
  'ui.reject_width_mismatch', 'ui.reject_single_edge',
  // fix wave B6 (U28, U34)
  'toast.pushed_orders_skipped', 'undo.push_orders_1h',
];
const localeDict = locale => {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(join(LOCALES_DIR, `${locale}.js`), 'utf8'), sandbox);
  return sandbox.window.__NIMBUS_LOCALES[locale];
};
const placeholdersOf = s => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');

const FRONTEND_AUDIT_KEYS = [
  'alert.horizon_hidden_duration', 'intel.snapshot_scope_unknown',
  'ui.system_config_saving', 'ui.system_config_unsaved', 'alert.summary_counts', 'alert.summary_open',
  'ui.sap_archive_search', 'btn.search', 'sec.assigned_plants', 'sec.available_plants',
  'intel.snapshot_entries', 'intel.select_snapshot', 'ui.material_draft_retained',
  'btn.dist_expand_detail', 'btn.dist_collapse_detail', 'ui.dist_editor_region',
  'toast.calendar_changes_pending', 'toast.calendar_whatif_local', 'toast.snapshot_restore_skipped',
  'ui.print_scope', 'ui.print_scope_all', 'ui.print_scope_plant', 'ui.print_scope_filtered',
  ...['save_failed', 'invalid_save_response', 'pins_preserved', 'aggregate_hint', 'empty_groups',
    'horizon_filtered', 'capacity_note', 'group_note', 'line_hours_label', 'group_hours_label',
    'line_cell_title', 'pinned', 'reset_split', 'reset_calendar', 'pasted', 'undo_delete',
    'undo_paste', 'undo_group', 'undo_line', 'undo_reset', 'split_hint', 'reconciliation_help',
    'loading', 'load_failed', 'retry', 'search_groups', 'no_matching_groups', 'all_groups',
    'selected_groups', 'clear_groups'].map(key => `labor.${key}`),
];

test('frontend audit copy exists once in every locale with complete interpolation parameters', () => {
  const dicts = Object.fromEntries(LOCALES.map(locale => [locale, localeDict(locale)]));
  for (const key of FRONTEND_AUDIT_KEYS) {
    for (const locale of LOCALES) {
      assert.ok(keysOf(locale).has(key), `${locale} key discovery missed ${key}`);
      assert.equal(keyCount(locale, key), 1, `${locale} must define ${key} exactly once`);
      assert.ok(typeof dicts[locale][key] === 'string' && dicts[locale][key].trim(), `${locale} has no usable ${key}`);
      assert.equal(placeholdersOf(dicts[locale][key]), placeholdersOf(dicts.en[key]), `${locale} interpolation differs for ${key}`);
    }
  }
});

test('U32: every key this branch added exists in all five locales, non-empty, with the same {{placeholder}} set as en.js', () => {
  const dicts = Object.fromEntries(LOCALES.map(l => [l, localeDict(l)]));
  for (const key of BRANCH_KEYS) {
    assert.ok(typeof dicts.en[key] === 'string' && dicts.en[key].trim(), `en.js has no usable "${key}"`);
    for (const locale of LOCALES.filter(l => l !== 'en')) {
      const v = dicts[locale][key];
      assert.ok(typeof v === 'string' && v.trim(), `${locale}.js is missing or empty for "${key}"`);
      assert.equal(placeholdersOf(v), placeholdersOf(dicts.en[key]), `${locale}.js "${key}" must carry the same {{placeholders}} as en.js`);
    }
  }
});

test('U28: every AlertType has a localized alert.type.<type> headline row in all five locales', () => {
  const types = readFileSync(join(__dirname, '..', '..', 'frontend', 'platform', 'types.mts'), 'utf8');
  const union = types.slice(types.indexOf('export type AlertType ='), types.indexOf('export type AlertSev'));
  const alertTypes = [...union.matchAll(/'([a-z_-]+)'/g)].map(m => m[1]);
  assert.ok(alertTypes.length >= 30 && alertTypes.includes('finish_moved_earlier'), 'the AlertType union was parsed');
  for (const locale of LOCALES) {
    const dict = localeDict(locale);
    for (const type of alertTypes) {
      const v = dict[`alert.type.${type}`];
      assert.ok(typeof v === 'string' && v.trim(), `${locale}.js has no headline row alert.type.${type}`);
    }
  }
});

test('U33: the new es rows use "pedido" and the new fr rows "commande" (no ordre/orden mix), de uses "festgeschrieben" for firmed, pt "firmadas"', () => {
  const es = localeDict('es'), fr = localeDict('fr'), de = localeDict('de'), pt = localeDict('pt');
  for (const key of BRANCH_KEYS) {
    assert.doesNotMatch(es[key], /\b[Oo]rden(es)?\b/, `es "${key}" must say pedido, not orden`);
    assert.doesNotMatch(fr[key], /\b[Oo]rdres?\b/, `fr "${key}" must say commande, not ordre`);
  }
  assert.doesNotMatch(de['modal.confirm_overtime_msg'], /fixiert/);
  assert.doesNotMatch(de['ui.sap_send_confirm'], /fixiert|Fixierung/);
  assert.match(pt['toast.sap_sent_skipped_unfirmed'], /firmadas/);
  assert.doesNotMatch(es['alert.finish_moved_earlier'], /a las \{\{to\}\}/, 'es: {{to}} is a full date-time, not an hour');
});

// Alert Monitor (feature/alert-monitor): every user-facing string of the page, the profile editor, the leverage cards,
// the profile toasts / User Settings rows and the Gantt-legend profile-match rows, with identical {{placeholders}}.
const ALERT_MONITOR_KEYS = [
  'tab.alerts', 'am.profile_label', 'am.profile_all', 'am.manage_profiles', 'am.profile_ph', 'am.profile_none',
  'am.window_rule', 'am.window_any_days', 'am.window_sev_any', 'am.window_sev_warn', 'am.window_sev_err',
  'am.window_all', 'am.gantt_highlight', 'am.group_by', 'am.group_type', 'am.group_category', 'am.group_line',
  'am.group_day', 'am.group_order', 'am.group_none', 'am.sort', 'am.sort_impact', 'am.sort_time', 'am.sort_severity',
  'am.sort_orders', 'am.kpi_matched', 'am.kpi_matched_of', 'am.kpi_errors', 'am.kpi_warnings', 'am.kpi_orders',
  'am.kpi_confidence', 'am.kpi_confidence_sub', 'am.leverage_title', 'am.leverage_hint', 'am.lev_alerts',
  'am.lev_conf', 'am.lev_conf_na', 'am.lev_outside_window', 'am.lev_partial_window', 'am.lev_method_exact',
  'am.lev_method_estimate', 'am.lev_needs_minutes', 'am.lev_minutes_ph', 'am.lev_show_alerts', 'am.lev_computing',
  'am.lev_none', 'am.lev_show_more', 'am.lev_points', 'am.lev_score', 'am.lev_score_capped', 'am.lev_headroom',
  'am.lev_no_headroom', 'am.lev_remaining', 'am.lev_admin_fix', 'am.lev_copy_summary', 'am.lev_copied', 'am.lev_setup_inactive',
  'am.focus_chip', 'am.focus_chip_outside', 'am.focus_clear', 'alert.profile_hidden', 'alert.profile_show_all',
  'alert.profile_override_on', 'alert.profile_back', 'am.group_dismiss_n', 'am.group_dismiss_confirm',
  'am.show_all_n', 'am.day_rel', 'am.rel_in_days', 'am.rel_today', 'am.rel_overdue_days', 'am.whatif_blocked',
  'am.empty_no_plant', 'am.empty_no_match_title', 'am.empty_no_match_msg', 'am.empty_switch_all',
  'am.profile_missing', 'am.open_in_table', 'am.diagnose', 'am.ack', 'am.ack_by', 'am.ack_by_noend', 'am.ack_show',
  'am.ack_title', 'am.ack_reason', 'am.ack_until', 'am.ack_noend', 'am.ack_note', 'am.unack', 'am.view_as',
  'am.make_default', 'am.is_default', 'am.col_points', 'am.col_orders', 'am.col_late', 'am.banner_no_timezone',
  'am.create_profile_prompt', 'am.empty_all_acked', 'am.anchor_due', 'am.anchor_time', 'am.points_outside', 'am.points_outside_tip',
  'am.diag_setup', 'am.diag_reason', 'am.diag_not_firmed', 'am.group_unassigned', 'am.table_unavailable', 'leverage.title.setup-pair', 'leverage.title.calendar-day', 'leverage.title.tool',
  'leverage.title.machine-state', 'leverage.title.optimize-window', 'leverage.title.routing-gap.workcenter_unmapped',
  'leverage.title.routing-gap.pv_missing', 'leverage.title.routing-gap.routing_upload',
  'leverage.title.routing-gap.no_machine', 'leverage.title.routing-gap.unknown', 'leverage.action.setup-pair',
  'leverage.action.calendar-day', 'leverage.action.routing-gap', 'leverage.action.routing-gap.workcenter_unmapped',
  'leverage.action.tool', 'leverage.action.machine-state', 'leverage.action.optimize-window', 'ape.title_new',
  'ape.title_edit', 'ape.name', 'ape.name_ph', 'ape.rules', 'ape.rule_n', 'ape.add_rule', 'ape.remove_rule',
  'ape.types', 'ape.cat_capacity', 'ape.cat_conflicts', 'ape.cat_calendar', 'ape.cat_setup', 'ape.cat_exceptions',
  'ape.select_category', 'ape.day_from', 'ape.day_to', 'ape.days_hint', 'ape.min_sev', 'ape.sev_any', 'ape.sev_warn',
  'ape.sev_err', 'ape.ranking', 'ape.set_mine', 'ape.new_profile', 'ape.duplicate', 'ape.copy_to_plants',
  'ape.late_hours', 'ape.err_late_hours', 'ape.live_range', 'ape.live_matches', 'ape.err_name_required',
  'ape.err_name_dup', 'ape.err_name_long', 'ape.err_no_rules', 'ape.err_too_many_rules', 'ape.err_rule_no_types',
  'ape.err_days_range', 'ape.err_days_order', 'ape.err_min_sev', 'ape.err_rule_dup', 'ape.err_stale',
  'ape.delete_confirm_title', 'ape.delete_confirm_msg', 'toast.alert_profile_saved', 'toast.alert_profile_deleted',
  'toast.alert_profiles_load_failed', 'us.alert_profile_for', 'us.alert_profile_no_plant', 'us.alert_profile_hint',
  'us.alert_profile_manage', 'us.alert_gantt_highlight', 'us.alert_gantt_highlight_hint', 'legend.pm_capacity_t',
  'legend.pm_capacity_d', 'legend.pm_conflicts_t', 'legend.pm_conflicts_d', 'legend.pm_calendar_t',
  'legend.pm_calendar_d', 'legend.pm_setup_t', 'legend.pm_setup_d', 'legend.pm_exceptions_t',
  'legend.pm_exceptions_d', 'legend.pm_ring_d',
];

test('Alert Monitor keys exist in all five locales, non-empty, with the same {{placeholder}} set as en.js', () => {
  const dicts = Object.fromEntries(LOCALES.map(l => [l, localeDict(l)]));
  for (const key of ALERT_MONITOR_KEYS) {
    assert.ok(typeof dicts.en[key] === 'string' && dicts.en[key].trim(), `en.js has no usable "${key}"`);
    for (const locale of LOCALES.filter(l => l !== 'en')) {
      const v = dicts[locale][key];
      assert.ok(typeof v === 'string' && v.trim(), `${locale}.js is missing or empty for "${key}"`);
      assert.equal(placeholdersOf(v), placeholdersOf(dicts.en[key]), `${locale}.js "${key}" must carry the same {{placeholders}} as en.js`);
    }
  }
});

test('Alert Monitor: every firing alert type has an alert.help.<type> sentence in all five locales (same placeholders)', async () => {
  const { FIRING_ALERT_TYPES } = await import('../../frontend/insights/alert-profiles.mjs');
  assert.equal(FIRING_ALERT_TYPES.length, 30, 'the firing type list was loaded');
  const dicts = Object.fromEntries(LOCALES.map(l => [l, localeDict(l)]));
  for (const type of FIRING_ALERT_TYPES) {
    for (const locale of LOCALES) {
      const v = dicts[locale][`alert.help.${type}`];
      assert.ok(typeof v === 'string' && v.trim(), `${locale}.js has no alert.help.${type}`);
      assert.equal(placeholdersOf(v), placeholdersOf(dicts.en[`alert.help.${type}`]), `${locale} alert.help.${type} placeholders`);
    }
  }
});

test('Alert Monitor: es says pedido and fr says commande (no orden/ordre)', () => {
  const es = localeDict('es'), fr = localeDict('fr');
  for (const key of ALERT_MONITOR_KEYS) {
    assert.doesNotMatch(es[key], /\b[Oo]rden(es)?\b/, `es "${key}" must say pedido, not orden`);
    assert.doesNotMatch(fr[key], /\b[Oo]rdres?\b/, `fr "${key}" must say commande, not ordre`);
  }
});
