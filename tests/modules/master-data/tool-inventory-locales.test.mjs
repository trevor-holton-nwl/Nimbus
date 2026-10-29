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
    en: 'PRT Inventory', de: 'PRT-Bestand', es: 'Inventario de PRT', fr: 'Inventaire PRT', pt: 'Inventário de PRT',
  });
  for (const l of LOCALES) assert.ok(dicts[l]['alert.tool_conflict'], `${l} alert.tool_conflict`);
});

test('the English tool inventory copy never uses SAP field codes', () => {
  for (const key of KEYS.filter(k => k !== 'tab.tool_inventory')) assert.doesNotMatch(dicts.en[key], /\b(PRT_0[12]|MEINH|MATNR)\b/, key);
});

test('the Wave 4a review-fix keys are in the block and es says planta (not centro) for plant', () => {
  for (const k of ['btn.add_tools_in_use', 'tip.add_tools_in_use', 'filter.tool_used_no_row', 'filter.tool_in_use_now', 'toast.tool_inventory_added_in_use',
    'toast.tool_inventory_added_in_use_capped', 'toast.tool_inventory_none_in_use', 'toast.tool_inventory_remote_deleted_kept',
    'ui.tool_inventory_used_no_row_hint', 'ui.tool_inventory_used_no_row_none']) assert.ok(KEYS.includes(k), k);
  for (const k of ['empty.no_tool_inventory_plant', 'toast.tool_inventory_draft_restored']) {
    assert.match(dicts.es[k], /planta/, k);
    assert.doesNotMatch(dicts.es[k], /centro/, k);
  }
  assert.match(dicts.en['tip.add_tools_in_use'], /loaded window/);
  assert.equal(dicts.en['toast.tool_inventory_remote_deleted_kept'], 'A row you edited was removed by another session; it was kept as a new row. Save to add it back.');
});

// ---- Excel upload / review modal / deep link block (Wave 4b) ------------------------------------------------------------------
// Bounded at the first Jobs-scheduler key: later sections appended to en.js carry legitimate cognates (Jobs, Status, Info).
const XL_BLOCK = enText.slice(enText.indexOf('Tool Inventory Excel upload (Wave 4b)'), enText.indexOf("'tab.jobs'"));
const XL_KEYS = [...XL_BLOCK.matchAll(/^\s*'([a-z_.]+)'\s*:/gm)].map(m => m[1]);

test('the Excel upload block carries the documented keys, all included in the Tool Inventory locale gate above', () => {
  for (const key of ['btn.download_data', 'btn.upload_tool_inventory', 'tip.upload_tool_inventory', 'modal.tool_inventory_review_title',
    'modal.tool_inventory_review_summary', 'modal.tool_inventory_review_changes', 'modal.tool_inventory_review_new', 'modal.tool_inventory_review_rejected',
    'modal.tool_inventory_review_warnings', 'modal.tool_inventory_review_untouched', 'modal.tool_inventory_review_rejected_warn',
    'modal.tool_inventory_review_apply', 'modal.tool_inventory_review_more', 'ui.tool_inventory_review_arrow_sr', 'toast.tool_inventory_upload_done', 'toast.tool_inventory_upload_failed',
    'toast.tool_inventory_upload_too_large', 'toast.tool_inventory_upload_dirty', 'ui.alert_open_tool_inventory', 'am.act_open_tool_inventory']) {
    assert.ok(XL_KEYS.includes(key), `missing ${key}`);
    assert.ok(KEYS.includes(key), `${key} is covered by the all-locales gate`);
  }
  for (const l of LOCALES) assert.ok(dicts[l]['btn.download_template'], `${l} reuses btn.download_template`);
});

test('the review modal wording: counts placeholders, the standing sentences, translated in every locale', () => {
  for (const l of LOCALES) {
    const d = dicts[l];
    assert.equal(placeholders(d['modal.tool_inventory_review_summary']), 'changed,new,rejected,unchanged', l);
    assert.equal(placeholders(d['modal.tool_inventory_review_apply']), 'n', l);
    assert.equal(placeholders(d['modal.tool_inventory_review_more']), 'n', l);
    assert.equal(placeholders(d['toast.tool_inventory_upload_done']), 'inserted,rejected,updated', l);
  }
  assert.equal(dicts.en['modal.tool_inventory_review_untouched'], 'Rows missing from the file are left unchanged.');
  assert.equal(dicts.en['modal.tool_inventory_review_rejected_warn'], 'Rejected rows will be skipped; the valid rows will still be saved.');
  for (const key of XL_KEYS) {
    if (key === 'btn.download_data' || key === 'ui.alert_open_tool_inventory' || key === 'am.act_open_tool_inventory') continue;
    for (const l of ['de', 'es', 'fr', 'pt']) assert.notEqual(dicts[l][key], dicts.en[key], `${l} "${key}" is still English`);
  }
});

test('Monitor vocabulary: the English am.* deep-link label avoids points / pts / exact / estimate', () => {
  assert.doesNotMatch(dicts.en['am.act_open_tool_inventory'], /points|pts|exact|estimate/i);
  assert.equal(dicts.en['am.act_open_tool_inventory'], dicts.en['ui.alert_open_tool_inventory']);
});

test('review strings use the same words as the grid headers (total / out of service); Apply needs no plural', () => {
  for (const l of LOCALES) {
    const d = dicts[l];
    assert.ok(d['modal.tool_inventory_review_new_item'].includes(d['col.total_qty']), `${l} new_item says "${d['col.total_qty']}"`);
    assert.ok(d['modal.tool_inventory_review_new_item'].includes(d['col.out_of_service_qty']), `${l} new_item says "${d['col.out_of_service_qty']}"`);
    assert.match(d['modal.tool_inventory_review_apply'], /\(\{\{n\}\}\)$/, `${l} Apply label is "... (n)"`);
  }
  assert.equal(dicts.en['modal.tool_inventory_review_apply'], 'Apply changes ({{n}})');
});
