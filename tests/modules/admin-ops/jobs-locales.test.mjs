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
    'jobs.status_': ['scheduled', 'running', 'succeeded', 'warning', 'failed', 'cancelled', 'skipped', 'missed'],
    'jobs.result_': ['apply', 'propose', 'apply_tip', 'propose_tip', 'hint_apply', 'hint_propose'],
    'jobs.error_kind_': ['config', 'system', 'config_hint', 'system_hint'],
    'jobs.health_': ['running', 'queued', 'failed', 'missed', 'next'],
    'jobs.bulk_': ['run', 'pause', 'resume', 'archive'],
  };
  for (const [p, vs] of Object.entries(families)) for (const v of vs) keys.add(p + v);
  const missing = [...keys].filter(k => !k.endsWith('_') && !tables.en[k]);   // `'jobs.mode_' + m` is a dynamic prefix
  assert.deepEqual(missing, []);
});

test('Dry run replaces Propose in the UI, and the stored value stays propose', () => {
  assert.equal(tables.en['jobs.result_propose'], 'Dry run');
  assert.equal(tables.en['jobs.result_apply'], 'Apply');
  assert.equal(tables.en['jobs.status_scheduled'], 'Queued');
  assert.equal(tables.en['jobs.status_succeeded'], 'Finished');
  assert.equal(tables.en['jobs.status_warning'], 'Finished with warnings');
  for (const l of LOCALES) assert.doesNotMatch(tables[l]['jobs.result_propose'], /^(Propose|Vorschlagen|Proponer|Proposer|Propor)$/, l);
});
