// Tool Inventory Wave 5: the Order Rules "Treat Tooling as Hard Constraint" drop-down in System Settings > Scheduling Rules.
// Rendered only while TOOLING_RULE_CONTROL_READY is true (Wave 6 flips it); planner-level (no isAdmin gate); saves through
// POST /master-data/plants/{plant}/tooling-rule and patches the LIVE Store row without rebuilding the pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Plant, RULE_HELP, TOOLING_RULE_CONTROL_READY, __setToolingRuleControlReady } from '../../../frontend/master-data/admin-ui.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Toast, Util } from '../../../frontend/platform/foundation.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';

// The gate setter is inert unless the test setup declares itself (a console import cannot flip the gate).
globalThis.__NIMBUS_TEST__ = true;

function mountPane(plants) {
  const els = new Map();
  const mkEl = () => {
    const el = {
      value: '', disabled: false, hidden: false, isConnected: true, checked: false,
      validity: { badInput: false }, dataset: {}, style: {}, children: [], handlers: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener(type, fn) { (el.handlers[type] ??= []).push(fn); },
      removeEventListener() {}, appendChild() {}, setAttribute() {}, focus() {}, closest: () => null,
      querySelector: () => null, querySelectorAll: () => [],
    };
    return el;
  };
  const pane = {
    innerHTML: '',
    querySelector(sel) { if (!els.has(sel)) els.set(sel, mkEl()); return els.get(sel); },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  globalThis.document = { getElementById: id => (id === 'plant-tab-settings' ? pane : null), querySelector: () => null, querySelectorAll: () => [] };
  globalThis.window = {};
  Store.setSelectedPlant('5512', 'test');
  Store.setMasterData({ plants, lines: [] }, 'test');
  Plant._currentSettingsSubTab = 'rules';
  try { Plant._renderSettingsPane(); } catch { /* the constraint-tree wiring after the Order Rules handlers needs a real DOM */ }
  const el = id => pane.querySelector(`#${id}`);
  const fire = async (id, type = 'change') => { for (const fn of el(id).handlers[type] ?? []) await fn(); };
  return { el, fire, pane };
}

async function withHarness(ready, body) {
  const prior = {
    document: globalThis.document, window: globalThis.window, fetch: Util.fetchTraced, t: Util.t, toast: Toast.show,
    recompute: Alerts.scheduleRecompute, isAdmin: Session.isAdmin, plant: Store.selectedPlant, md: Store.masterData,
    unsub: Plant._setupNoteUnsub, ready: TOOLING_RULE_CONTROL_READY,
  };
  const calls = []; const toasts = []; const recomputes = [];
  Util.t = key => key;
  Toast.show = (msg, type) => { toasts.push([msg, type]); };
  Alerts.scheduleRecompute = () => { recomputes.push(1); };
  Session.isAdmin = () => false;                      // a planner: the control must still be there and usable
  __setToolingRuleControlReady(ready);
  Util.fetchTraced = () => Promise.reject(new Error('stubbed'));
  try { await body({ calls, toasts, recomputes }); }
  finally {
    __setToolingRuleControlReady(prior.ready);
    Plant._setupNoteUnsub?.(); Plant._setupNoteUnsub = prior.unsub;
    Util.fetchTraced = prior.fetch; Util.t = prior.t; Toast.show = prior.toast; Alerts.scheduleRecompute = prior.recompute; Session.isAdmin = prior.isAdmin;
    if (prior.document === undefined) delete globalThis.document; else globalThis.document = prior.document;
    if (prior.window === undefined) delete globalThis.window; else globalThis.window = prior.window;
    Store.setSelectedPlant(prior.plant, 'test-restore'); Store.setMasterData(prior.md, 'test-restore');
  }
}

test('the gate is true in the shipped build (the optimizer overflow pass, its consumer, exists since Wave 6)', () => {
  assert.equal(TOOLING_RULE_CONTROL_READY, true);
});

test('control absent while the gate is false; present (wide row, Off/Hard options, hint, no admin gate) when true', async () => {
  const row = () => ({ subnetwork: 'SN', plant: '5512', setup_policy_config: {} });
  await withHarness(false, async () => {
    const { pane } = mountPane([row()]);
    assert.doesNotMatch(pane.innerHTML, /sys-tooling-rule|data-rule-key="toolingRule"/);
  });
  await withHarness(true, async () => {
    const { pane } = mountPane([row()]);
    assert.match(pane.innerHTML, /class="sched-rule-row sched-rule-row--wide" data-rule-key="toolingRule"/);
    assert.match(pane.innerHTML, /<select id="sys-tooling-rule"[^>]*>\s*<option value="off">ui\.tooling_rule_off<\/option>\s*<option value="hard">ui\.tooling_rule_hard<\/option>/);
    assert.match(pane.innerHTML, /<p class="panel-hint sched-rule-note" id="sys-tooling-rule-hint">ui\.tooling_rule_hint<\/p>/);
    assert.ok(pane.innerHTML.indexOf('sys-tooling-rule') > pane.innerHTML.indexOf('sys-unknown-setup-inactive-note'), 'after the unknown-setup rows');
  });
});

test('right-click More info: RULE_HELP.toolingRule carries a title and two help paragraphs, all with locale text and no angle brackets or ampersands', () => {
  assert.deepEqual(RULE_HELP.toolingRule, { title: 'ui.tooling_rule_title', help: ['ui.tooling_rule_help', 'ui.tooling_rule_help_detail'] });
  for (const l of ['en', 'de', 'es', 'fr', 'pt']) {
    const sandbox = { window: {} };
    vm.runInNewContext(readFileSync(new URL(`../../../frontend/locales/${l}.js`, import.meta.url), 'utf8'), sandbox);
    const d = sandbox.window.__NIMBUS_LOCALES[l];
    for (const key of ['ui.tooling_rule_title', ...RULE_HELP.toolingRule.help]) {
      assert.ok(d[key], `${l} ${key}`);
      assert.doesNotMatch(d[key], /[<>&]/, `${l} ${key} is injected as raw HTML in the popover`);
    }
  }
});

test('saving posts the planner-level route, patches the live row in place, refreshes alerts, re-enables the select', async () => {
  await withHarness(true, async ({ toasts, recomputes }) => {
    const stale = { subnetwork: 'SN', plant: '5512', setup_policy_config: { unknownSetupPolicy: 'zero' } };
    const { el, fire } = mountPane([stale]);
    const live = { subnetwork: 'SN', plant: '5512', setup_policy_config: { unknownSetupPolicy: 'zero' } };
    Store.setMasterData({ plants: [live], lines: [] }, 'test-refresh');          // a refresh replaced the row after the pane rendered
    const requests = []; let release;
    Util.fetchTraced = (url, init) => {
      requests.push({ url: String(url), init, body: JSON.parse(init.body) });
      return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ status: 'ok', plant: '5512', setup_policy_config: { unknownSetupPolicy: 'zero', toolingRule: 'hard', version: 2 } }) }); });
    };
    el('sys-tooling-rule').value = 'hard';
    const pending = fire('sys-tooling-rule');
    assert.equal(el('sys-tooling-rule').disabled, true, 'disabled while posting');
    release(); await pending;
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/master-data\/plants\/5512\/tooling-rule$/);
    assert.deepEqual(requests[0].body, { subnetwork: 'SN', tooling_rule: 'hard' });
    assert.equal(requests[0].init.method, 'POST');
    assert.ok('x-user-email' in requests[0].init.headers, 'the sibling routes\' actor header');
    assert.equal(live.setup_policy_config.toolingRule, 'hard', 'the live Store row is merged');
    assert.equal(live.setup_policy_config.unknownSetupPolicy, 'zero', 'siblings in the JSON are kept');
    assert.equal(Store.masterData.plants[0], live, 'no Store.setMasterData swap (it would rebuild the pane)');
    assert.equal(recomputes.length, 1);
    assert.equal(el('sys-tooling-rule').disabled, false);
    assert.ok(toasts.some(([m, t]) => m === 'ui.tooling_rule_saved' && t === 'success'));
  });
});

test('a failed save (403 for a planner without access, or a network error) reverts the select and the row, with an error toast', async () => {
  await withHarness(true, async ({ toasts }) => {
    const row = { subnetwork: 'SN', plant: '5512', setup_policy_config: { toolingRule: 'off' } };
    const { el, fire } = mountPane([row]);
    Util.fetchTraced = async () => ({ ok: false, status: 403, json: async () => ({ detail: 'Not allowed for this plant' }) });
    el('sys-tooling-rule').value = 'hard';
    await fire('sys-tooling-rule');
    assert.equal(el('sys-tooling-rule').value, 'off', 'reverted to the stored value');
    assert.equal(row.setup_policy_config.toolingRule, 'off', 'row untouched');
    assert.equal(el('sys-tooling-rule').disabled, false);
    assert.ok(toasts.some(([m, t]) => /^ui\.tooling_rule_failed: Not allowed for this plant$/.test(m) && t === 'error'));
    Util.fetchTraced = async () => { throw new Error('offline'); };
    el('sys-tooling-rule').value = 'hard';
    await fire('sys-tooling-rule');
    assert.equal(el('sys-tooling-rule').value, 'off');
    assert.ok(toasts.some(([m]) => /ui\.tooling_rule_failed: offline/.test(m)));
  });
});

test('the select starts at the stored rule (hard) and treats anything else as off', async () => {
  await withHarness(true, async () => {
    assert.equal(mountPane([{ subnetwork: 'SN', plant: '5512', setup_policy_config: { toolingRule: 'hard' } }]).el('sys-tooling-rule').value, 'hard');
    assert.equal(mountPane([{ subnetwork: 'SN', plant: '5512', setup_policy_config: { toolingRule: 'bogus' } }]).el('sys-tooling-rule').value, 'off');
    assert.equal(mountPane([{ subnetwork: 'SN', plant: '5512' }]).el('sys-tooling-rule').value, 'off');
  });
});

test('the select sizes to its widest option (width:auto, max-width:100%), never a fixed ch width', async () => {
  await withHarness(true, async () => {
    const { pane } = mountPane([{ subnetwork: 'SN', plant: '5512', setup_policy_config: {} }]);
    const tag = pane.innerHTML.match(/<select id="sys-tooling-rule"[^>]*>/)?.[0] ?? '';
    assert.match(tag, /style="width:auto;max-width:100%"/);
    assert.doesNotMatch(tag, /50ch/);
  });
});

test('__setToolingRuleControlReady is inert unless the test flag is set (a console import cannot flip the gate)', () => {
  const before = TOOLING_RULE_CONTROL_READY;
  globalThis.__NIMBUS_TEST__ = false;
  try {
    __setToolingRuleControlReady(!before);
    assert.equal(TOOLING_RULE_CONTROL_READY, before, 'unchanged without the flag');
  } finally { globalThis.__NIMBUS_TEST__ = true; }
  __setToolingRuleControlReady(!before);
  assert.equal(TOOLING_RULE_CONTROL_READY, !before, 'flips with the flag');
  __setToolingRuleControlReady(before);
});
