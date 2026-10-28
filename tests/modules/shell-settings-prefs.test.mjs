// Settings correctness (Wave C): catalog/backend key drift, shared optimizer mode
// list, landing sub validation, revert + refresh re-apply seams in the shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { App, SessionUIAdapter, Settings } from '../../frontend/shell/application-shell.mjs';
import { Util } from '../../frontend/platform/foundation.mjs';
import { Store } from '../../frontend/platform/store.mjs';
import { Session } from '../../frontend/security/session.mjs';
import {
  OPTIMIZER_MODES, OPTIMIZER_SEED_PRESETS, seedOptimizerMode, seedOptimizerPreset,
} from '../../frontend/optimization/optimizer-prefs.mjs';

globalThis.window = globalThis.window || {};

test('every Settings.CATALOG key is in the backend ALLOWED_SETTINGS_KEYS (the two lists cannot drift)', () => {
  const py = readFileSync(new URL('../../backend/security/auth.py', import.meta.url), 'utf8');
  const block = py.match(/ALLOWED_SETTINGS_KEYS\s*=\s*frozenset\(\{([\s\S]*?)\}\)/);
  assert.ok(block, 'ALLOWED_SETTINGS_KEYS not found in backend/security/auth.py');
  const allowed = new Set([...block[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map(m => m[1]));
  // timezone is the one known exception: it is a dead key that Wave D removes from the catalog.
  const missing = Settings.CATALOG.map(e => e.key).filter(k => !allowed.has(k) && k !== 'timezone');
  assert.deepEqual(missing, [], `catalog keys the backend would reject with 400: ${missing.join(', ')}`);
});

test('optimizer mode list: pane and dialog share one list, all four modes, every locale has the labels', () => {
  assert.deepEqual(OPTIMIZER_MODES.map(m => m.value), ['spt', 'changeover', 'duedate', 'backlog']);
  for (const m of OPTIMIZER_MODES) assert.equal(seedOptimizerMode(m.value), m.value);
  assert.equal(seedOptimizerMode('smart'), 'changeover');
  assert.equal(seedOptimizerMode(undefined), 'changeover');
  assert.deepEqual([...OPTIMIZER_SEED_PRESETS], ['horizon', '2w']);
  assert.equal(seedOptimizerPreset('2w'), '2w');
  assert.equal(seedOptimizerPreset('custom'), 'horizon');
  for (const lang of ['en', 'de', 'es', 'fr', 'pt']) {
    const src = readFileSync(new URL(`../../frontend/locales/${lang}.js`, import.meta.url), 'utf8');
    for (const m of OPTIMIZER_MODES) assert.match(src, new RegExp(`'${m.labelKey.replace(/\./g, '\\.')}'\\s*:`), `${lang} missing ${m.labelKey}`);
  }
});

function fakeEl(extra = {}) {
  const handlers = {};
  return { handlers, value: '', checked: false, hidden: false, innerHTML: '', dataset: {}, isConnected: true,
    classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, focus() {}, blur() {},
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    fire(type) { for (const fn of handlers[type] || []) fn({}); }, ...extra };
}

test('Workflow pane: a stored backlog mode survives a checkbox toggle and an unknown preset is not forced over a valid one', t => {
  const priorDoc = globalThis.document, priorFlatpickr = globalThis.flatpickr;
  t.mock.method(Util, 't', k => k);
  t.mock.method(Session, 'pref', k => (k === 'optimizerDefaults' ? { mode: 'backlog', preset: '2w', respectFirmed: true, respectCalendar: true } : undefined));
  const writes = [];
  t.mock.method(Session, 'setPref', (k, v) => { writes.push([k, v]); });
  t.mock.method(SessionUIAdapter, '_initAlertProfileRows', () => {});
  t.mock.method(SessionUIAdapter, '_alertProfileRowsHtml', () => '');
  const els = { '#us-pref-timeformat': fakeEl(), '#us-pref-dateformat': fakeEl(), '#us-pref-firstday': fakeEl(),
    '#us-opt-mode': fakeEl({ value: 'backlog' }), '#us-opt-firmed': fakeEl({ checked: true }),
    '#us-opt-calendar': fakeEl({ checked: true }), '#us-opt-clear': fakeEl() };
  const pane = { innerHTML: '', querySelector: sel => els[sel] || null };
  try {
    globalThis.document = { getElementById: id => (id === 'us-tab-workflow' ? pane : null) };
    SessionUIAdapter._renderWorkflowPane();
    assert.match(pane.innerHTML, /<option value="backlog" selected>/, 'backlog is a pane option and is the selected one');
    assert.match(pane.innerHTML, /<option value="duedate"/);
    els['#us-opt-calendar'].checked = false;
    els['#us-opt-calendar'].fire('change');
    assert.deepEqual(writes, [['optimizerDefaults', { mode: 'backlog', preset: '2w', respectFirmed: true, respectCalendar: false }]]);
  } finally { globalThis.document = priorDoc; globalThis.flatpickr = priorFlatpickr; }
});

test('_gotoLanding: a landingView.sub the picker does not offer falls back to the tab default; a valid one is applied', t => {
  t.mock.method(Util, 't', k => k);
  t.mock.method(Session, 'canAccessTab', () => true);
  const gotos = [], subs = [];
  t.mock.method(App, 'goto', tab => { gotos.push(tab); });
  t.mock.method(App, 'gotoGanttSub', s => { subs.push(['gantt', s]); });
  t.mock.method(App, 'gotoMasterSub', s => { subs.push(['master', s]); });
  t.mock.method(App, 'gotoLaborSub', s => { subs.push(['labor', s]); });
  const priorDoc = globalThis.document;
  try {
    globalThis.window = globalThis.window || {};
    t.mock.method(Store, 'pref', k => (k === 'landingView' ? { tab: 'masterdata', sub: 'bogus' } : undefined));
    App._gotoLanding();
    assert.deepEqual(gotos, ['masterdata']); assert.deepEqual(subs, [], 'bogus sub ignored');
    Store.pref.mock.restore();
    t.mock.method(Store, 'pref', k => (k === 'landingView' ? { tab: 'masterdata', sub: 'tool-inventory' } : undefined));
    gotos.length = 0; App._gotoLanding();
    assert.deepEqual(subs, [['master', 'tool-inventory']]);
    Store.pref.mock.restore();
    t.mock.method(Store, 'pref', k => (k === 'landingView' ? { tab: 'labor', sub: 'aggregate' } : undefined));
    subs.length = 0; App._gotoLanding();
    assert.deepEqual(subs, [], 'a tab with no landing sub-views ignores a stored sub');
  } finally { globalThis.document = priorDoc; }
});

test('a failed pref save (settings-pref-revert) re-applies the theme and re-renders the open Settings modal only', t => {
  let reapplied = 0, renders = 0;
  const priorNimbus = globalThis.NIMBUS, priorDoc = globalThis.document;
  globalThis.NIMBUS = { DarkMode: { reapply: () => { reapplied++; } } };
  t.mock.method(SessionUIAdapter, '_renderSettingsPanes', () => { renders++; });
  t.mock.method(App, '_applyFirstDayOfWeek', () => {});
  const modal = { hidden: false };
  try {
    globalThis.document = { getElementById: id => (id === 'modal-user-settings' ? modal : null) };
    SessionUIAdapter._onPrefRevert();
    assert.equal(reapplied, 1); assert.equal(renders, 1);
    modal.hidden = true;
    SessionUIAdapter._onPrefRevert();
    assert.equal(reapplied, 2); assert.equal(renders, 1, 'a closed modal is not re-rendered');
  } finally { globalThis.NIMBUS = priorNimbus; globalThis.document = priorDoc; }
});

test('session:changed/refresh re-applies theme and firstDayOfWeek; settings-pref-revert events reach _onPrefRevert', t => {
  const priorNimbus = globalThis.NIMBUS;
  let reapplied = 0, fdow = 0, reverts = 0;
  globalThis.NIMBUS = { DarkMode: { reapply: () => { reapplied++; } } };
  t.mock.method(SessionUIAdapter, '_applyGates', () => {});
  t.mock.method(App, '_applyFirstDayOfWeek', () => { fdow++; });
  t.mock.method(Session, 'canAccessTab', () => true);
  t.mock.method(SessionUIAdapter, '_onPrefRevert', () => { reverts++; });
  SessionUIAdapter.init();
  try {
    Store.emit({ type: 'session:changed', kind: 'refresh' });
    assert.equal(reapplied, 1); assert.equal(fdow, 1);
    Store.emit({ type: 'settings:change', source: 'settings-pref-revert' });
    assert.equal(reverts, 1);
    Store.emit({ type: 'settings:change', source: 'settings-pref' });
    assert.equal(reverts, 1);
  } finally { globalThis.NIMBUS = priorNimbus; }
});
