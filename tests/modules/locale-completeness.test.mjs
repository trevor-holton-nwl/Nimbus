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
const LOCALES_DIR = join(__dirname, '..', '..', 'web', 'locales');
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

test('every constraint.<field> key exists in all 5 locales', () => {
  const REQUIRED = ['constraint.colorWheel', 'constraint.prt01', 'constraint.prt02', 'constraint.productionVersion'];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('Stage 0 setup-matrix administration keys exist in all 5 locales', () => {
  const REQUIRED_SETUP = [
    'ui.setup_matrix_title', 'ui.setup_matrix_observation', 'ui.setup_line_scope',
    'ui.setup_inherited', 'ui.setup_activation_inactive', 'ui.setup_activation_requirements',
    'ui.setup_compatibility', 'ui.setup_compatibility_reason', 'ui.setup_not_global_exclusion',
    'ui.setup_import_csv',
    'btn.setup_export_csv', 'btn.setup_delete_override', 'ui.setup_state_source',
    'ui.setup_observed_at', 'ui.setup_override_audit',
  ];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED_SETUP) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
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

test('en.js is the superset — no locale has a key en.js lacks', () => {
  const en = keysOf('en');
  for (const locale of LOCALES.filter(l => l !== 'en')) {
    const extra = [...keysOf(locale)].filter(k => !en.has(k));
    assert.deepEqual(extra, [], `${locale}.js has keys not present in en.js: ${extra.join(', ')}`);
  }
});
