// Locale gate for Tool Inventory Wave 5 (tooling rule control, Optimize tool UX, planning reasons, Inspector, Slot): every key is in
// all five locale files with identical {{placeholders}} and a real translation; es says pedido, fr commande; the rule help carries no
// raw-HTML characters and no SAP field codes; the English am.* clause keeps the Alert Monitor vocabulary (copies / limit, never cap).
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

const enText = readFileSync(new URL('en.js', dir), 'utf8');
// Bounded at the first Jobs-scheduler key: later sections appended to en.js carry legitimate cognates (Jobs, Status, Info).
const block = enText.slice(enText.indexOf('Tool Inventory Wave 5:'), enText.indexOf("'tab.jobs'"));
const KEYS = [...block.matchAll(/^\s*'([A-Za-z_.]+)'\s*:/gm)].map(m => m[1]);

test('the Wave 5 block is found and covers every documented key family', () => {
  assert.ok(KEYS.length >= 39, `found ${KEYS.length} keys`);
  for (const key of ['ui.tooling_rule_title', 'ui.tooling_rule_off', 'ui.tooling_rule_hard', 'ui.tooling_rule_help', 'ui.tooling_rule_help_detail',
    'ui.tooling_rule_hint', 'ui.tooling_rule_saved', 'ui.tooling_rule_failed', 'ui.opt_stale_banner_tooling', 'ui.opt_pv_chip_tooling',
    'ui.opt_tool_blocked_title', 'ui.opt_tool_raise', 'modal.opt_tool_confirm_moved', 'modal.opt_tool_confirm_queued', 'modal.opt_tool_inventory_not_loaded',
    'toast.fix_overload_blocked', 'planning_reason.tool_contention', 'planning_reason.tool_contention_incomplete', 'planning_reason.tool_unavailable',
    'ui.insp_tooling', 'toast.tool_id_unknown', 'am.slot_confirm_tool', 'ui.tool_inventory_rule_link',
    'modal.opt_tool_raise_discard', 'toast.opt_tool_raise_closed', 'toast.fix_overload_blocked_batch', 'toast.optimize_need_planning']) {
    assert.ok(KEYS.includes(key), `missing ${key}`);
  }
});

test('every Wave 5 key exists in all five locales with identical placeholders', () => {
  for (const key of KEYS) {
    for (const l of LOCALES) {
      const v = dicts[l][key];
      assert.ok(typeof v === 'string' && v.trim(), `${l}.js is missing or empty for "${key}"`);
      assert.equal(placeholders(v), placeholders(dicts.en[key]), `${l}.js "${key}" must carry the same {{placeholders}} as en.js`);
    }
  }
});

test('non-English locales carry real translations; es says pedido/planta and fr commande/usine', () => {
  for (const key of KEYS) {
    for (const l of ['de', 'es', 'fr', 'pt']) assert.notEqual(dicts[l][key], dicts.en[key], `${l} "${key}" is still English`);
    assert.doesNotMatch(dicts.es[key], /\b[Oo]rden(es)?\b|\bfábrica\b/, `es "${key}" must say pedido / planta`);
    assert.doesNotMatch(dicts.fr[key], /\b[Oo]rdres?\b/, `fr "${key}" must say commande`);
  }
});

test('rule help is popover-safe (no < > &), uses "Tool 1 / Tool 2" wording and no SAP field codes', () => {
  for (const l of LOCALES) {
    for (const key of ['ui.tooling_rule_title', 'ui.tooling_rule_help', 'ui.tooling_rule_help_detail', 'ui.tooling_rule_hint', 'ui.tooling_rule_off', 'ui.tooling_rule_hard']) {
      assert.doesNotMatch(dicts[l][key], /[<>&]/, `${l} ${key}`);
      assert.doesNotMatch(dicts[l][key], /\bPRT_?0?[12]\b/, `${l} ${key} must not name SAP field codes`);
    }
    assert.match(dicts[l]['ui.tooling_rule_help'], /Tool 1/, `${l} help names Tool 1`);
    assert.match(dicts[l]['ui.tooling_rule_help'], /Tool 2/, `${l} help names Tool 2`);
  }
});

test('English am.* clause: copies/limit wording, none of the banned Alert Monitor words', () => {
  const clause = dicts.en['am.slot_confirm_tool'];
  assert.match(clause, /copies/);
  assert.doesNotMatch(clause, /\b(points|pts|exact|estimate|cap)\b/i);
});

test('the moved-for-tooling line is plural-neutral (ends with the count after a colon) in every locale', () => {
  for (const l of LOCALES) {
    const v = dicts[l]['modal.opt_tool_confirm_moved'];
    assert.match(v, /:\s\{\{n\}\}$/, `${l} ends with the count after a colon`);
    assert.doesNotMatch(v, /informational|informativ|information/i, `${l} has no parenthetical`);
  }
});
