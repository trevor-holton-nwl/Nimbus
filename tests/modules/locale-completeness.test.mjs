// New in Stage 2 of docs/scheduling_priority.md (N22) — no prior locale-
// completeness test existed. Locale files are classic scripts (not ES
// modules), so keys are extracted via regex on the raw source text rather
// than importing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', '..', 'frontend', 'locales');
const LOCALES = ['en', 'de', 'es', 'fr', 'pt'];
// Locale entries are usually one per line, but valid object literals may keep
// several short translations together; key discovery must not mistake that
// formatting choice for a missing translation.
const KEY_RE = /'([\w.]+)'\s*:/g;

function keysOf(locale) {
  const text = readFileSync(join(LOCALES_DIR, `${locale}.js`), 'utf8');
  const keys = new Set();
  let m;
  while ((m = KEY_RE.exec(text))) keys.add(m[1]);
  return keys;
}

function keyCount(locale, key) {
  const text = readFileSync(join(LOCALES_DIR, `${locale}.js`), 'utf8');
  return [...text.matchAll(new RegExp(`'${key}'\\s*:`, 'g'))].length;
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

test('en.js is the superset — no locale has a key en.js lacks', () => {
  const en = keysOf('en');
  for (const locale of LOCALES.filter(l => l !== 'en')) {
    const extra = [...keysOf(locale)].filter(k => !en.has(k));
    assert.deepEqual(extra, [], `${locale}.js has keys not present in en.js: ${extra.join(', ')}`);
  }
});
