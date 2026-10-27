// Locale gate for the Tool Inventory sub-tab: every string of the grid, its confirms and toasts exists in all five
// locale files with the same {{placeholders}}; es says "pedido" and fr "commande" (never orden / ordre).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const LOCALES = ['en', 'de', 'es', 'fr', 'pt'];
const dir = new URL('../../../frontend/locales/', import.meta.url);
const dict = l => {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(new URL(`${l}.js`, dir), 'utf8'), sandbox);
  return sandbox.window.__NIMBUS_LOCALES[l];
};
const dicts = Object.fromEntries(LOCALES.map(l => [l, dict(l)]));
const placeholders = s => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');

// The block the sub-tab added to en.js: everything after its marker comment up to the closing brace.
const enText = readFileSync(new URL('en.js', dir), 'utf8');
const block = enText.slice(enText.indexOf('Tool Inventory sub-tab (Master Data)'));
const KEYS = [...block.matchAll(/^\s*'([a-z_.]+)'\s*:/gm)].map(m => m[1]);

test('the Tool Inventory block is found and covers the documented key families', () => {
  assert.ok(KEYS.length >= 40, `found ${KEYS.length} keys`);
  for (const stem of ['tab.tool_inventory', 'col.tool_id', 'col.total_qty', 'col.out_of_service_qty', 'col.available_qty', 'col.note', 'col.used_by',
    'ph.quick_filter_tools', 'filter.tool_all', 'filter.tool_unused', 'empty.no_tool_inventory_rows', 'modal.tool_inventory_delete_title',
    'modal.tool_inventory_delete_body', 'modal.tool_inventory_check_failed', 'toast.tool_inventory_saved', 'toast.tool_inventory_save_failed',
    'toast.tool_inventory_draft_restored', 'toast.tool_alerts_cleared', 'ui.tool_inventory_status_off', 'ui.tool_inventory_status_hard',
    'ui.tool_id_locked_hint', 'ui.tool_inventory_duplicate', 'ui.tool_inventory_oos_exceeds_total']) {
    assert.ok(KEYS.includes(stem), `missing ${stem}`);
  }
});

test('every Tool Inventory key exists in all five locales with identical placeholders', () => {
  for (const key of KEYS) {
    for (const l of LOCALES) {
      const v = dicts[l][key];
      assert.ok(typeof v === 'string' && v.trim(), `${l}.js is missing or empty for "${key}"`);
      assert.equal(placeholders(v), placeholders(dicts.en[key]), `${l}.js "${key}" must carry the same {{placeholders}} as en.js`);
    }
  }
});

test('non-English locales carry real translations, es says pedido and fr commande', () => {
  for (const key of KEYS) {
    assert.doesNotMatch(dicts.es[key], /\b[Oo]rden(es)?\b/, `es "${key}" must say pedido`);
    assert.doesNotMatch(dicts.fr[key], /\b[Oo]rdres?\b/, `fr "${key}" must say commande`);
  }
  for (const key of ['tab.tool_inventory', 'col.tool_id', 'ui.tool_id_locked_hint', 'modal.tool_inventory_delete_body', 'empty.no_tool_inventory_rows']) {
    for (const l of ['de', 'es', 'fr', 'pt']) assert.notEqual(dicts[l][key], dicts.en[key], `${l} "${key}" is still English`);
  }
});

test('the sub-tab name uses the wording the tool-conflict alert text already points at', () => {
  assert.deepEqual(Object.fromEntries(LOCALES.map(l => [l, dicts[l]['tab.tool_inventory']])), {
    en: 'Tool Inventory', de: 'Werkzeugbestand', es: 'Inventario de herramientas', fr: 'Inventaire des outils', pt: 'Inventário de ferramentas',
  });
  for (const l of LOCALES) assert.ok(dicts[l]['alert.tool_conflict'], `${l} alert.tool_conflict`);
});

test('the English tool inventory copy never uses SAP field codes', () => {
  for (const key of KEYS) assert.doesNotMatch(dicts.en[key], /\b(PRT|PRT_0[12]|MEINH|MATNR)\b/, key);
});
