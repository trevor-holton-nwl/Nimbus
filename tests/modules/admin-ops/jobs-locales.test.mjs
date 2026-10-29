// Every jobs.* string exists in all five locales with the same {{placeholders}} as en.js, every key the Jobs sources
// ask for (static t('jobs.x') and the dynamic families) is defined, and the Dry run / Apply wording holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../../frontend/', import.meta.url);
const LOCALES = ['en', 'de', 'es', 'fr', 'pt'];
function load(l) {
  const window = {};
  vm.runInNewContext(readFileSync(new URL(`locales/${l}.js`, root), 'utf8'), { window });
  return window.__NIMBUS_LOCALES[l];
}
const tables = Object.fromEntries(LOCALES.map(l => [l, load(l)]));
const jobsKeys = l => Object.keys(tables[l] || {}).filter(k => k.startsWith('jobs.'));
const ph = s => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');

test('the locale tables load', () => { for (const l of LOCALES) assert.ok(jobsKeys(l).length > 150, `${l} has its jobs.* strings`); });

test('every en jobs.* key exists in de / es / fr / pt, non-empty, same placeholders', () => {
  for (const k of jobsKeys('en')) {
    for (const l of LOCALES.slice(1)) {
      assert.ok(tables[l][k], `${l}.js is missing ${k}`);
      assert.equal(ph(tables[l][k]), ph(tables.en[k]), `${l}.js ${k} placeholders`);
    }
  }
});

test('every key the Jobs sources ask for is defined', () => {
  const src = ['jobs-pane', 'jobs-dialog', 'jobs-run-detail', 'jobs-model'].map(n => readFileSync(new URL(`admin-ops/${n}.mts`, root), 'utf8')).join('\n');
  const keys = new Set([...src.matchAll(/['"`](jobs\.[a-z0-9_]+)['"`]/g)].map(m => m[1]));
  const families = {
    'jobs.status_': ['scheduled', 'running', 'succeeded', 'warning', 'failed', 'cancelled', 'skipped', 'missed', 'pending'],
    'jobs.step_runon_': ['success', 'failure', 'always'],
    'jobs.step_onfail_': ['stop', 'continue'],
    'jobs.diff_f_': ['type', 'label', 'continue_on_failure', 'run_on'],
    'jobs.tile_': ['matched', 'deleted', 'findings', 'rows'],
    'jobs.result_': ['apply', 'propose', 'apply_tip', 'propose_tip', 'hint_apply', 'hint_propose'],
    'jobs.error_kind_': ['config', 'system', 'transient', 'config_hint', 'system_hint', 'transient_hint'],
    'jobs.health_': ['running', 'queued', 'failed', 'missed', 'next'],
    'jobs.bulk_': ['run', 'pause', 'resume', 'archive'],
    'jobs.win_': ['fixed', 'older_than', 'last', 'next', 'since_last_success', 'this_week', 'this_month', 'custom'],
    'jobs.win_anchor_': ['now', 'start_of_day', 'start_of_week', 'start_of_month', 'last_success'],
    'jobs.win_unit_': ['day', 'week', 'month'],
    'jobs.t_mode_': ['single', 'selected', 'all', 'subnetwork'],
    'jobs.tz_mode_': ['plant', 'fixed', 'utc'],
    'jobs.view_': ['runs', 'batches', 'timeline'],
    // W3b: the Advanced rules, preview notes, skip reasons and the timeline (built from the policy values in jobs-dialog / jobs-model)
    'jobs.adv_dst_gap_': ['shift', 'skip', 'hint_shift', 'hint_skip'],
    'jobs.adv_dst_overlap_': ['once', 'twice', 'hint_once', 'hint_twice'],
    'jobs.adv_closed_': ['run', 'skip', 'next_working_day', 'previous_working_day', 'hint_run', 'hint_skip', 'hint_next_working_day', 'hint_previous_working_day'],
    'jobs.adv_win_': ['skip', 'defer'],
    'jobs.adv_monthly_': ['day_of_month', 'last_day', 'first_working_day', 'last_working_day'],
    'jobs.cron_monthly_': ['last_day', 'first_working_day', 'last_working_day'],
    'jobs.note_': ['dst_gap_shifted', 'dst_overlap_second', 'moved_next_working_day', 'moved_previous_working_day', 'deferred_to_window'],
    'jobs.skip_reason_': ['closed_day', 'no_working_day', 'dst_gap', 'outside_run_window'],
    'jobs.tl_': ['24h', '7d'],
    'jobs.trigger_': ['catchup'],
    'jobs.batch_tile_': ['total', 'succeeded', 'warning', 'failed', 'skipped', 'cancelled', 'running', 'scheduled'],
    'jobs.batch_trigger_': ['schedule', 'manual', 'restart'],
  };
  for (const [p, vs] of Object.entries(families)) for (const v of vs) keys.add(p + v);
  const missing = [...keys].filter(k => !k.endsWith('_') && !tables.en[k]);   // `'jobs.mode_' + m` is a dynamic prefix
  assert.deepEqual(missing, []);
});

test('the report viewer strings (jobs.a.*), the report section titles, tile labels and column labels exist in all five locales', () => {
  const need = ['title', 'csv', 'rows', 'loading_rows', 'rows_partial', 'empty', 'truncated', 'truncated_all', 'csv_failed', 'yes', 'no'].map(k => `jobs.a.${k}`);
  const reports = readFileSync(new URL('../../../backend/jobs/types/reports.py', import.meta.url), 'utf8');
  const sections = [...reports.matchAll(/artifacts\.section\(\s*"(\w+)"[\s\S]*?\[([^\]]*)\]/g)];
  assert.ok(sections.length >= 9, 'found the report sections in reports.py');
  for (const [, key, cols] of sections) {
    need.push(`jobs.a.sec.${key}`, `jobs.a.tile.${key}`);
    for (const c of cols.matchAll(/col\("(\w+)"/g)) need.push(`jobs.a.col.${c[1]}`);
  }
  for (const l of LOCALES) assert.deepEqual([...new Set(need)].filter(k => !tables[l][k]), [], l);
});

test('Dry run replaces Propose in the UI, and the stored value stays propose', () => {
  assert.equal(tables.en['jobs.result_propose'], 'Dry run');
  assert.equal(tables.en['jobs.result_apply'], 'Apply');
  assert.equal(tables.en['jobs.status_scheduled'], 'Queued');
  assert.equal(tables.en['jobs.status_succeeded'], 'Finished');
  assert.equal(tables.en['jobs.status_warning'], 'Finished with warnings');
  for (const l of LOCALES) assert.doesNotMatch(tables[l]['jobs.result_propose'], /^(Propose|Vorschlagen|Proponer|Proposer|Propor)$/, l);
});
