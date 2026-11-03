// B26: every alert the core emits renders in the viewer's language. Each alert type either ships msgKey + msgVars (and
// the key exists in all five locales, with every placeholder fed by msgVars) or is on the explicit allow-list below.
// The English template must also reproduce the English `msg` fallback exactly, so a viewer on `en` sees no change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { genPayload } from '../helpers/alert-payload-gen.mjs';

const require = createRequire(import.meta.url);
const Core = require('../../../frontend/nimbus-compute-core.js');
const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'locales');
const LOCALES = ['en', 'de', 'es', 'fr', 'pt'];

const dicts = {};
for (const l of LOCALES) {
  const win = {};
  vm.runInNewContext(readFileSync(join(LOCALES_DIR, `${l}.js`), 'utf8'), { window: win });
  dicts[l] = win.__NIMBUS_LOCALES[l];
}

// Alert types whose message is deliberately NOT keyed. runtime-unknown carries the routing resolver's own, already
// translated text (planning_reason.message); the core must never re-word it.
const ALLOW_UNKEYED = new Set(['runtime-unknown']);

const render = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''));
const placeholders = tpl => [...tpl.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);

// A few hundred seeded payloads reach every rule; the type list asserts the sweep did.
const emitted = [];
const NOW = Date.now();
for (let seed = 1; seed <= 400; seed++) {
  const { alerts } = Core.computeAlerts(genPayload(seed, NOW));
  for (const a of alerts) emitted.push(a);
}

const MUST_SEE = ['overlap', 'overload', 'closed', 'blackout', 'firmed-closed', 'firmed-out-of-hours', 'pv-lot-size', 'setup-violated',
  'setup-uncovered', 'initial-state-unknown', 'current-state-diverged', 'override-inactive', 'predecessor-state-unknown',
  'successor-state-unknown', 'tool-conflict', 'distribution-separation', 'late', 'runtime-unknown'];

test('the seeded sweep reaches every alert rule this test covers', () => {
  const seen = new Set(emitted.map(a => a.type));
  for (const type of MUST_SEE) assert.ok(seen.has(type), `no ${type} alert in the sweep (the generator no longer reaches that rule)`);
});

test('every emitted alert has msgKey + msgVars, or its type is on the allow-list', () => {
  for (const a of emitted) {
    if (ALLOW_UNKEYED.has(a.type)) continue;
    if (!a.msgKey && a.msg === 'preset message') continue;   // a setup diagnostic whose caller supplied its own text (shown as is)
    if (!a.msgKey) {
      // The one keyed rule with an English-only tail: a split order with several out-of-hours pieces lists every piece.
      assert.equal(a.type, 'firmed-out-of-hours', `${a.type} alert ${a.id} has no msgKey`);
      assert.ok(a.msgDates.length >= 2, `${a.id}: an unkeyed firmed-out-of-hours alert must be the multi-piece shape`);
      continue;
    }
    assert.ok(a.msgVars && typeof a.msgVars === 'object', `${a.id} has a msgKey but no msgVars`);
    for (const [k, v] of Object.entries(a.msgVars)) {
      assert.ok(typeof v === 'string' || typeof v === 'number', `${a.id}: msgVars.${k} must be a string or number, got ${typeof v}`);
    }
  }
});

test('every msgKey the core emits exists in all five locales and every placeholder has a var', () => {
  const keys = new Map();   // key -> one example alert
  for (const a of emitted) if (a.msgKey && !keys.has(a.msgKey)) keys.set(a.msgKey, a);
  for (const [key, a] of keys) {
    for (const l of LOCALES) {
      const tpl = dicts[l][key];
      assert.equal(typeof tpl, 'string', `${l}.js is missing ${key} (alert type ${a.type})`);
      for (const p of placeholders(tpl)) {
        assert.ok(p in a.msgVars, `${l}.js ${key} uses {{${p}}} which ${a.type} does not ship in msgVars`);
      }
    }
  }
});

// Keys added by B26. (The older keys, e.g. the tool-conflict ones, carry a longer English locale text than the msg fallback.)
const B26_KEYS = new Set(['overlap', 'overload', 'near_capacity', 'closed_calendar', 'closed_blackouts', 'blackout', 'firmed_closed', 'order_closed',
  'firmed_out_of_hours_start', 'firmed_out_of_hours_end', 'firmed_out_of_hours_both', 'order_out_of_hours_start', 'order_out_of_hours_end',
  'order_out_of_hours_both', 'pv_lot_size', 'setup_initial_state_unknown', 'setup_override_inactive', 'setup_current_state_diverged',
  'setup_uncovered', 'setup_uncovered_pair', 'setup_predecessor_state_unknown', 'setup_successor_state_unknown'].map(k => `alert.${k}`));

test('the English template reproduces the English msg fallback for every B26-keyed alert', () => {
  let checked = 0;
  for (const a of emitted) {
    if (!a.msgKey || !B26_KEYS.has(a.msgKey)) continue;
    checked++;
    assert.equal(render(dicts.en[a.msgKey], a.msgVars), a.msg, `${a.id} (${a.msgKey})`);
  }
  assert.ok(checked > 100, 'the sweep checked a meaningful number of alerts');
});

test('the B26 keys are translated, not copied from English, in the four other locales', () => {
  for (const key of B26_KEYS) {
    for (const l of LOCALES) assert.equal(typeof dicts[l][key], 'string', `${l}.js is missing ${key}`);
    for (const l of LOCALES.filter(x => x !== 'en')) assert.notEqual(dicts[l][key], dicts.en[key], `${l}.js ${key} is still the English text`);
  }
});
