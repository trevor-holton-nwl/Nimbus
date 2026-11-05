// Locale gate for the compact-cache wording (T7): every backup/storage key exists in all five locales with the same
// {{placeholders}}, the non-English ones are real translations (es says pedido, fr commande), the dead keys are gone,
// and no admin wording still names localStorage or the removed trimmed tiers.
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
const D = Object.fromEntries(LOCALES.map(l => [l, dict(l)]));
const ph = s => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');

const KEYS = ['toast.cache_put_failed', 'toast.cache_older_record', 'toast.cache_dirty_no_record', 'toast.cache_context_changed',
  'toast.cache_not_restored', 'toast.cache_kept_offline', 'toast.cache_deferred', 'toast.cache_read_failed', 'toast.cache_corrupt_record',
  'toast.cache_other_plants', 'ui.cache_reason_stale', 'ui.cache_reason_missing', 'ui.cache_reason_unmatched',
  'modal.reset_client_pending_msg', 'modal.reset_client_pending_save', 'modal.reset_client_pending_discard', 'modal.reset_client_pending_go',
  'toast.reset_saving', 'modal.reset_client_msg', 'tip.inspect_storage', 'ui.diag_kv_storage', 'ui.diag_kv_cache', 'ui.diag_kv_autosave',
  'ui.diag_client_help', 'tip.diag_clear_cache', 'ui.ls_healthy', 'ui.ls_degraded', 'ui.ls_blocked', 'ui.diag_cache_val', 'ui.diag_storage_val',
  'modal.ls_inventory_title', 'modal.ls_inventory_msg', 'modal.ls_inv_total', 'modal.ls_inv_snapshot', 'modal.ls_inventory_top_keys',
  'sig.browser_backup_failed', 'sig.browser_backup_blocked', 'attn.autosave', 'diag.line_client',
  // review A3: halt from another tab, other plants named in Reset, edits lost to an expired session
  'toast.cache_halted_other_tab', 'modal.reset_client_pending_plants', 'sec.session_expired_lost',
  // review A4: a halt shows as paused, not as a failed write
  'ui.ls_paused', 'sig.browser_backup_paused', 'attn.autosave_paused'];

const DEAD = ['sig.data_cached', 'toast.cache_cleared', 'btn.clear_cache', 'toast.loaded_cache', 'toast.backend_unreachable_cache',
  'modal.storage_inventory_title', 'modal.storage_inventory_msg', 'modal.storage_inventory_confirm', 'ui.ls_quota_disabled',
  'ui.ls_evicted_tier', 'ui.ls_autosave_disabled', 'sig.browser_autosave_off', 'sig.browser_degraded'];

test('every cache/backup key exists in all five locales with identical placeholders', () => {
  for (const k of KEYS) for (const l of LOCALES) {
    const v = D[l][k];
    assert.ok(typeof v === 'string' && v.trim(), `${l} is missing "${k}"`);
    assert.equal(ph(v), ph(D.en[k]), `${l} "${k}" placeholders`);
  }
});

test('non-English locales are real translations, es says pedido and fr commande', () => {
  for (const k of KEYS) {
    assert.doesNotMatch(D.es[k], /\b[Oo]rden(es)?\b/, `es "${k}"`);
    assert.doesNotMatch(D.fr[k], /\b[Oo]rdres?\b/, `fr "${k}"`);
    if (['modal.reset_client_pending_go'].includes(k)) continue;
    for (const l of ['de', 'es', 'fr', 'pt']) {
      // identical-to-English is only fine for strings that are format-only (the heap line keeps its English-looking tokens)
      if (k === 'diag.line_client') continue;
      assert.notEqual(D[l][k], D.en[k], `${l} "${k}" is still English`);
    }
  }
});

test('dead cache keys are removed from every locale', () => {
  for (const l of LOCALES) for (const k of DEAD) assert.equal(k in D[l], false, `${l} still carries "${k}"`);
});

test('admin wording is storage/backup, not localStorage or trimmed tiers; sizes are labelled in characters', () => {
  for (const l of LOCALES) for (const k of ['modal.ls_inventory_title', 'ui.diag_kv_storage', 'tip.inspect_storage', 'ui.diag_client_help', 'tip.diag_clear_cache']) {
    assert.doesNotMatch(D[l][k], /localStorage/i, `${l} "${k}"`);
  }
  for (const l of LOCALES) for (const k of ['ui.diag_cache_val', 'ui.diag_storage_val', 'modal.ls_inv_total', 'modal.ls_inv_snapshot']) {
    assert.doesNotMatch(D[l][k], /\b(KB|Ko|KiB)\b/, `${l} "${k}" must not claim bytes`);
  }
  assert.match(D.en['ui.diag_client_help'], /Save/);
  assert.doesNotMatch(D.en['ui.diag_client_help'], /click Reset client state to clear/);
});

test('A3 new keys: the expiry line carries a count, the Reset line names plants, vocabulary stays formal and on-glossary', () => {
  for (const l of LOCALES) {
    assert.deepEqual(ph(D[l]['sec.session_expired_lost']), 'count', l);
    assert.deepEqual(ph(D[l]['modal.reset_client_pending_plants']), 'plants', l);
    assert.equal(ph(D[l]['toast.cache_halted_other_tab']), '', l);
  }
  assert.match(D.de['modal.reset_client_pending_plants'], /Werke/);
  assert.match(D.pt['modal.reset_client_pending_plants'], /plantas/);
  assert.match(D.fr['sec.session_expired_lost'], /modifications/);
  assert.match(D.es['sec.session_expired_lost'], /cambios/);
  assert.doesNotMatch(D.de['toast.cache_halted_other_tab'], /\bdu\b|\bdeine/i, 'formal address');
});

test('A5 k6 paused/halted texts lead with Save and never tell the planner to reload (a reload discards the edits)', () => {
  const PAUSED = ['ui.ls_paused', 'sig.browser_backup_paused', 'attn.autosave_paused', 'toast.cache_halted_other_tab'];
  const RELOAD = { en: /reload|refresh/i, de: /neu laden|neu starten|aktualisier/i, es: /recarg|actualiz/i, fr: /recharg|actualis/i, pt: /recarreg|atualiz/i };
  const SAVE = { en: /Save/, de: /[Ss]peichern/, es: /[Gg]uarde/, fr: /[Ee]nregistrez/, pt: /[Ss]alve/ };
  for (const l of LOCALES) for (const k of PAUSED) {
    assert.doesNotMatch(D[l][k], RELOAD[l], `${l} "${k}" must not recommend reloading`);
    assert.match(D[l][k], SAVE[l], `${l} "${k}" leads with Save`);
    assert.equal(ph(D[l][k]), '', `${l} "${k}" has no placeholders`);
  }
});

test('A5 k4 the removed-record notice exists in all five locales, is translated, and says the changes are gone', () => {
  const k = 'toast.cache_corrupt_removed';
  for (const l of LOCALES) {
    assert.ok(typeof D[l][k] === 'string' && D[l][k].trim(), `${l} is missing "${k}"`);
    assert.equal(ph(D[l][k]), ph(D.en[k]), `${l} placeholders`);
    if (l !== 'en') assert.notEqual(D[l][k], D.en[k], `${l} is still English`);
  }
  assert.match(D.en[k], /gone/);
  assert.match(D.fr[k], /perdues/); assert.doesNotMatch(D.fr[k], /\bordres?\b/i);
  assert.match(D.es[k], /perdido/); assert.doesNotMatch(D.es[k], /\b[Oo]rden/);
  assert.match(D.de[k], /verloren/);
  assert.match(D.pt[k], /perdidas/);
});
