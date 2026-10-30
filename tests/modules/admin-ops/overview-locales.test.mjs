// Every key family the Admin cockpit redesign adds exists in all five locales with identical {{placeholders}}.
// tab.logs_audit / tab.data_operations were removed in W1.
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
const T = Object.fromEntries(LOCALES.map(l => [l, load(l)]));
const ph = s => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');

const FAMILIES = /^(ov|sig|attn|ulog|pipe|thread)\./;
const EXTRA = ['tab.logs', 'tab.order_maintenance', 'btn.pause', 'btn.resume', 'btn.rerun_now', 'btn.open_run', 'btn.vacuum_analyze', 'btn.vacuum', 'btn.view_logs',
  'btn.open_color_wheel', 'btn.open_diagnostics', 'btn.open_interface', 'btn.open_history', 'btn.show_all_n', 'btn.show_fewer', 'btn.copy_json',
  'ph.filter_plant', 'ph.search_logs', 'ph.filter_backend', 'ui.all_codes', 'diag.error_prefix', 'aria.upload_zone'];
const keys = [...new Set([...Object.keys(T.en).filter(k => FAMILIES.test(k) || /^diag\.col_/.test(k)), ...EXTRA])];

test('the families are populated', () => {
  for (const f of ['ov.', 'sig.', 'attn.', 'ulog.', 'pipe.', 'thread.', 'diag.col_']) assert.ok(keys.filter(k => k.startsWith(f)).length >= 5, f);
  assert.ok(keys.length > 150);
});

test('every key is present, non-empty and placeholder-identical in all five locales', () => {
  for (const k of keys) {
    assert.ok(T.en[k], `en.js is missing ${k}`);
    for (const l of LOCALES.slice(1)) {
      assert.ok(T[l][k], `${l}.js is missing ${k}`);
      assert.equal(ph(T[l][k]), ph(T.en[k]), `${l}.js ${k} placeholders`);
    }
  }
});

test('pinned spot values', () => {
  assert.equal(T.en['tab.order_maintenance'], 'Order Maintenance');
  assert.equal(T.de['tab.order_maintenance'], 'Auftragspflege');
  assert.equal(T.es['tab.order_maintenance'], 'Mantenimiento de pedidos');
  assert.equal(T.fr['tab.order_maintenance'], 'Maintenance des commandes');
  assert.equal(T.pt['tab.order_maintenance'], 'Manutenção de pedidos');
  assert.equal(T.en['sig.jobs_failed'], '{{n}} failed in 24 h · {{job}} ({{plant}}) {{ago}}: {{reason}}');
  assert.equal(T.en['btn.show_all'], '← Show all');    // pre-existing calendar string is untouched
});

test('old tab keys are absent (removed in W1)', () => {
  for (const l of LOCALES) { assert.equal(T[l]['tab.logs_audit'], undefined, `${l} tab.logs_audit`); assert.equal(T[l]['tab.data_operations'], undefined, `${l} tab.data_operations`); }
});
