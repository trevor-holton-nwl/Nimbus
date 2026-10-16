import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminCockpit } from '../../../frontend/admin-ops/admin-ui.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, ErrorLog } from '../../../frontend/platform/foundation.mjs';

globalThis.window ||= {};

test('color summary uses only matching plant task metadata, never load-time defaults', () => {
  const oldStats = Persistence.stats;
  const oldPlant = Store.selectedPlant;
  try {
    Store.setSelectedPlant('A');
    Persistence.stats = () => ({ plant: 'A', backend_meta: { color_merge_misses: 3 }, color_merge_misses: 3 });
    assert.equal(AdminCockpit._diagnosticColorMisses(), 3);
    Persistence.stats = () => ({ plant: 'B', color_merge_misses: 0 });
    assert.equal(AdminCockpit._diagnosticColorMisses(), null);
    Persistence.stats = () => ({ plant: 'A' });
    assert.equal(AdminCockpit._diagnosticColorMisses(), null);
  } finally { Persistence.stats = oldStats; Store.setSelectedPlant(oldPlant); }
});

test('health polling skips hidden diagnostics and resumes when visible', () => {
  const oldDocument = globalThis.document;
  const oldInterval = globalThis.setInterval;
  const oldHealth = AdminCockpit._renderHealth;
  const oldSub = AdminCockpit._activeSub;
  const oldTab = AdminCockpit._activeOvTab;
  let tick;
  let calls = 0;
  globalThis.document = { hidden: false, getElementById: () => ({ classList: { contains: () => true } }) };
  globalThis.setInterval = fn => { tick = fn; return 77; };
  AdminCockpit._renderHealth = () => calls++;
  AdminCockpit._healthTimer = null;
  try {
    AdminCockpit._startHealthPolling();
    AdminCockpit._activeSub = 'overview';
    AdminCockpit._activeOvTab = 'logs';
    tick();
    assert.equal(calls, 0);
    AdminCockpit._activeOvTab = 'diagnostics';
    tick();
    assert.equal(calls, 1);
    globalThis.document.hidden = true;
    tick();
    assert.equal(calls, 1);
  } finally {
    globalThis.document = oldDocument;
    globalThis.setInterval = oldInterval;
    AdminCockpit._renderHealth = oldHealth;
    AdminCockpit._activeSub = oldSub;
    AdminCockpit._activeOvTab = oldTab;
    AdminCockpit._healthTimer = null;
  }
});

test('cache loads retain task evidence even when color metadata is absent', () => {
  const oldStats = Persistence.stats;
  const oldPlant = Store.selectedPlant;
  try {
    Store.setSelectedPlant('A');
    Persistence.stats = () => ({ plant: 'A', source: 'cache', raw_received: 12, rendered: 10, backend_meta: null });
    assert.equal(AdminCockpit._diagnosticTasksAvailable(), true);
    assert.equal(AdminCockpit._diagnosticColorMisses(), null);
    Store.setSelectedPlant('B');
    assert.equal(AdminCockpit._diagnosticTasksAvailable(), false);
  } finally { Persistence.stats = oldStats; Store.setSelectedPlant(oldPlant); }
});

test('returning to Diagnostics refreshes all sources after hidden task changes', () => {
  const oldDocument = globalThis.document;
  const names = ['_renderHealth', '_renderPipeline', '_renderDbDeep', '_renderDiagnostics'];
  const originals = names.map(name => AdminCockpit[name]);
  const calls = [];
  const oldTab = AdminCockpit._activeOvTab;
  globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
  names.forEach(name => { AdminCockpit[name] = () => calls.push(name); });
  try {
    AdminCockpit.gotoOvTab('diagnostics');
    assert.deepEqual(calls.sort(), [...names].sort());
  } finally {
    names.forEach((name, i) => { AdminCockpit[name] = originals[i]; });
    AdminCockpit._activeOvTab = oldTab;
    globalThis.document = oldDocument;
  }
});

test('failed health refresh clears previous healthy metrics and reports an error', async () => {
  const oldDocument = globalThis.document;
  const oldFetch = Util.fetchTraced;
  const oldWarn = ErrorLog.warn;
  const label = { textContent: 'DB 15ms' };
  const dot = { className: 'admin-health-dot ok' };
  const status = { dataset: {}, textContent: '' };
  globalThis.document = {
    getElementById: id => id === 'diag-health-state' ? status : id === 'admin-health-db'
      ? { querySelector: selector => selector.includes('dot') ? dot : label } : null,
    querySelectorAll: selector => selector.includes('label') ? [label] : [dot],
  };
  Util.fetchTraced = async () => ({ ok: false, status: 503 });
  ErrorLog.warn = () => {};
  try {
    AdminCockpit._renderHealth();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(status.dataset.state, 'error');
    assert.equal(dot.className, 'admin-health-dot err');
    assert.notEqual(label.textContent, 'DB 15ms');
  } finally {
    globalThis.document = oldDocument;
    Util.fetchTraced = oldFetch;
    ErrorLog.warn = oldWarn;
  }
});

test('opening diagnostic evidence preserves expansion and focuses its summary', () => {
  const oldDocument = globalThis.document;
  let focused = false;
  const detail = { open: false, querySelector: () => ({ focus() { focused = true; } }), scrollIntoView() {} };
  globalThis.document = { querySelector: () => detail };
  try {
    AdminCockpit._openDiagnostic('db-locks');
    assert.equal(detail.open, true);
    assert.equal(AdminCockpit._diagnosticOpen.get('db-locks'), true);
    assert.equal(focused, true);
  } finally { globalThis.document = oldDocument; AdminCockpit._diagnosticOpen.clear(); }
});
