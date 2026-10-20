import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, PlantSelector, EmptyState, SessionUIAdapter, showLoginScreen, Settings } from '../../frontend/shell/application-shell.mjs';
import { Util, Config, Toast } from '../../frontend/platform/foundation.mjs';
import { Store, UndoStack } from '../../frontend/platform/store.mjs';
import { Sandbox } from '../../frontend/optimization/sandbox.mjs';
import { Persistence } from '../../frontend/scheduling/persistence.mjs';
import { Session } from '../../frontend/security/session.mjs';
import { DistributionPane } from '../../frontend/distribution/distribution-pane.mjs';

test('header Lines picker announces open state and Escape returns focus', () => {
  const priorDoc = globalThis.document, priorRender = App._renderLinesPillChecklist;
  const button = { attrs: {}, setAttribute(k,v) { this.attrs[k] = v; }, focus() { this.focused = true; } };
  const drop = { hidden: true };
  const search = { focus() { this.focused = true; } };
  let renders = 0;
  try {
    globalThis.document = { getElementById: id => ({ 'context-lines-pill': button, 'context-lines-dropdown': drop, 'context-lines-search': search })[id] || null };
    App._renderLinesPillChecklist = () => { renders++; };
    App._toggleLinesPillDropdown();
    assert.equal(button.attrs['aria-expanded'], 'true');
    assert.equal(search.focused, true);
    assert.equal(renders, 1);
    let prevented = false;
    App._onLinesPillKeydown({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true);
    assert.equal(drop.hidden, true);
    assert.equal(button.attrs['aria-expanded'], 'false');
    assert.equal(button.focused, true);
  } finally { globalThis.document = priorDoc; App._renderLinesPillChecklist = priorRender; }
});

test('application-shell exposes the documented public API', () => {
  assert.equal(typeof App.goto, 'function');
  assert.equal(typeof App._renderSettingsPane, 'undefined', 'this method relocated to Plant in Task 1 — must not still exist here');
  assert.equal(typeof PlantSelector.init, 'function');
  assert.equal(typeof WelcomeSplash, 'undefined', 'WelcomeSplash was retired outright by the Command Band re-skin — must not still be exported');
  assert.equal(typeof EmptyState.render, 'function');
  assert.equal(typeof SessionUIAdapter.init, 'function');
  assert.equal(typeof showLoginScreen, 'function');
});

test('Settings (per-user settings catalog) is exported with its documented shape', () => {
  assert.ok(Array.isArray(Settings.CATALOG) && Settings.CATALOG.length > 0);
  assert.equal(typeof Settings.DEFAULTS, 'object');
  assert.equal(typeof Settings.isRegion, 'function');
  assert.equal(typeof Settings.byCategory, 'function');
  // DEFAULTS is derived 1:1 from CATALOG (Store.setSettingsDefaultsResolver's contract).
  for (const entry of Settings.CATALOG) {
    assert.ok(Object.prototype.hasOwnProperty.call(Settings.DEFAULTS, entry.key), `DEFAULTS missing key ${entry.key}`);
    assert.deepEqual(Settings.DEFAULTS[entry.key], entry.default);
  }
  assert.ok(Settings.byCategory('workflow').length > 0);
});

// _GANTT_SUBS registry (P2-12) — replaces gotoGanttSub's old hardcoded
// ['timeline', 'orders'].includes(sub) whitelist. Mirrors _MASTER_SUBS'
// { sub, paneId, render } shape but with { key, paneId, labelKey,
// landingEligible, scrollKey } per aggregate_to_detail.md §6's first bullet.
// The `distribution` entry (P2-15) is the pane frontend/distribution/distribution-pane.mts owns.

test('App._GANTT_SUBS carries the documented registry shape for all three sub-tabs', () => {
  assert.deepEqual(App._GANTT_SUBS.map(e => e.key), ['timeline', 'orders', 'distribution']);
  assert.deepEqual(App._GANTT_SUBS.find(e => e.key === 'timeline'), {
    key: 'timeline', paneId: 'gantt-sub-timeline', labelKey: 'tab.gantt_timeline',
    landingEligible: true, scrollKey: 'gantt:timeline',
  });
  assert.deepEqual(App._GANTT_SUBS.find(e => e.key === 'orders'), {
    key: 'orders', paneId: 'gantt-sub-orders', labelKey: 'tab.table',
    landingEligible: true, scrollKey: 'gantt:orders',
  });
  assert.deepEqual(App._GANTT_SUBS.find(e => e.key === 'distribution'), {
    key: 'distribution', paneId: 'gantt-sub-distribution', labelKey: 'tab.distribution',
    landingEligible: true, scrollKey: 'gantt:distribution',
  });
});

test('gotoGanttSub is a no-op for an unknown sub-tab key (matches the old whitelist\'s reject-unknown behavior)', () => {
  const priorSub = App._ganttSub;
  App._ganttSub = 'timeline';
  try {
    App.gotoGanttSub('not-a-real-sub'); // not registered — must be rejected same as any bogus key
    assert.equal(App._ganttSub, 'timeline', 'unknown sub must not overwrite the current sub');
  } finally {
    App._ganttSub = priorSub;
  }
});

test('gotoGanttSub resolves timeline/orders to the correct pane and scroll-key via the registry', (t) => {
  const priorDocument = globalThis.document;
  const priorSub = App._ganttSub;
  const priorCurrentTab = App._currentTab;
  const panes = {};
  // Only the two real pane ids resolve to an element — every other id (e.g.
  // 'timeline-loading-overlay', read by Timeline.showLoadingMask()) must come
  // back null so those call sites take their existing `if (!el) return;` path,
  // same as a real page before this refactor.
  globalThis.document = {
    body: { dataset: {} }, // gotoGanttSub stamps document.body.dataset.ganttSub on every switch (styles.css's Distribution context-actions hide rule keys on it)
    getElementById(id) {
      if (id !== 'gantt-sub-timeline' && id !== 'gantt-sub-orders') return null;
      if (!panes[id]) panes[id] = { style: {} };
      return panes[id];
    },
    querySelectorAll() { return { forEach() {} }; },
  };
  // Deferred work inside gotoGanttSub (Timeline.rebuild(), GanttFilter._apply(),
  // Persistence.refreshHorizons(), etc.) is real, unrelated module state this
  // test never initializes — freeze it behind the 30ms setTimeout so only the
  // synchronous registry-driven part (what this refactor actually changed) runs.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    App._currentTab = 'home'; // keeps _saveScroll/_updateSectionLabel's 'gantt'-only branches unentered — untouched by this refactor
    App.gotoGanttSub('timeline');
    assert.equal(App._ganttSub, 'timeline');
    assert.equal(App._scrollKeyFor('gantt'), 'gantt:timeline');
    assert.equal(panes['gantt-sub-timeline'].style.display, 'flex');
    assert.equal(panes['gantt-sub-orders'].style.display, 'none');

    App.gotoGanttSub('orders');
    assert.equal(App._ganttSub, 'orders');
    assert.equal(App._scrollKeyFor('gantt'), 'gantt:orders');
    assert.equal(panes['gantt-sub-orders'].style.display, 'flex');
    assert.equal(panes['gantt-sub-timeline'].style.display, 'none');
  } finally {
    t.mock.timers.reset();
    globalThis.document = priorDocument;
    App._ganttSub = priorSub;
    App._currentTab = priorCurrentTab;
  }
});

test('SessionUIAdapter._landingSubDefs(\'gantt\') is built from the registry and keeps its pre-refactor label text', () => {
  const priorWindow = globalThis.window;
  globalThis.window = globalThis.window || {};
  try {
    // Same [key, label] pairs the old hardcoded array returned — 'timeline' keeps
    // its shorter landing-picker copy (us.landing_timeline) rather than reusing
    // the registry's labelKey verbatim (tab.gantt_timeline, the command-band text).
    assert.deepEqual(SessionUIAdapter._landingSubDefs('gantt'), [
      ['timeline', Util.t('us.landing_timeline')],
      ['orders', Util.t('tab.table')],
      ['distribution', Util.t('tab.distribution')],
    ]);
  } finally {
    globalThis.window = priorWindow;
  }
});

// D08 — 'Persistence.dirty' subscriber body extracted to App._trackDirty(evt)
// (subscribed as `evt => App._trackDirty(evt)`) so it's callable directly in a
// test without standing up App.init()'s full DOM wiring. Distribution's own
// save path (frontend/distribution/distribution-pane.mts) writes task rows
// via Store.updateMany(patches, 'distribution') for its own persistence —
// routing that same write through the schedule's "N unsaved" badge/dirty-id
// tracking would be a false positive, so 'distribution' joins the existing
// 'refresh'/'note' skip list. A reconcile-resized bar (source
// 'engine-runtime-reconcile', emitted by Engine.reconcileRuntimeSchedules via
// Store.updateMany) is NOT skipped — it genuinely needs saving.
test('App._trackDirty skips distribution-sourced writes but still marks engine-runtime-reconcile dirty (D08)', () => {
  const priorDirtyIds = new Set(Persistence._dirtyIds);
  const priorForceIds = new Set(Persistence._forceIds);
  Persistence._dirtyIds.clear();
  Persistence._forceIds.clear();
  try {
    assert.equal(typeof App._trackDirty, 'function', 'the subscriber body must be extracted to App._trackDirty');

    App._trackDirty({ type: 'tasks:bulkUpdate', ids: ['dist-1', 'dist-2'], source: 'distribution', revision: 1, mode: 'live' });
    assert.equal(Persistence._dirtyIds.size, 0, "a 'distribution' source must leave Persistence._dirtyIds empty");

    App._trackDirty({ type: 'tasks:bulkUpdate', ids: ['reconcile-1'], source: 'engine-runtime-reconcile', revision: 2, mode: 'live' });
    assert.ok(Persistence._dirtyIds.has('reconcile-1'), 'an engine-runtime-reconcile source must still mark the task dirty');

    // A never-placed row the reconcile only DERIVES FOR DISPLAY (backward scheduling Task 2.6) is not a planner edit:
    // Save must leave the server row never-placed, so the display source joins the skip list.
    App._trackDirty({ type: 'tasks:bulkUpdate', ids: ['display-1'], source: 'engine-runtime-reconcile-display', revision: 3, mode: 'live' });
    assert.ok(!Persistence._dirtyIds.has('display-1'), 'a display-only reconcile write must not mark the task dirty');
  } finally {
    Persistence._dirtyIds.clear();
    Persistence._forceIds.clear();
    priorDirtyIds.forEach(id => Persistence._dirtyIds.add(id));
    priorForceIds.forEach(id => Persistence._forceIds.add(id));
  }
});

// D48 (shell part) — gotoGanttSub already deactivates the Distribution pane
// when switching to a *different gantt sub-tab* (see its own
// `if (App._ganttSub === 'distribution') DistributionPane.setActive(false)`),
// but that method is only reached while staying inside the gantt tab. Leaving
// the gantt tab entirely (e.g. goto('home')) never called gotoGanttSub at
// all, so the pane's debounced Store-event refresh kept doing background
// network work off-tab. App.goto now also deactivates it on that path.
test("App.goto deactivates the Distribution pane when leaving gantt entirely while it is the active sub-tab (D48 shell part)", (t) => {
  const priorDocument = globalThis.document;
  const priorSub = App._ganttSub;
  const priorCurrentTab = App._currentTab;
  const priorSetActive = DistributionPane.setActive;
  const calls = [];
  DistributionPane.setActive = (active) => { calls.push(active); };
  const homeTabEl = { classList: { add() {}, remove() {} } };
  globalThis.document = {
    body: { dataset: {} },
    getElementById(id) { return id === 'home-tab' ? homeTabEl : null; },
    querySelector() { return null; },
    querySelectorAll() { return { forEach() {} }; },
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    App._currentTab = 'gantt';
    App._ganttSub = 'distribution';
    App.goto('home');
    assert.deepEqual(calls, [false], 'leaving gantt while on the distribution sub must deactivate the pane exactly once');
    assert.equal(App._currentTab, 'home');
  } finally {
    t.mock.timers.reset();
    DistributionPane.setActive = priorSetActive;
    globalThis.document = priorDocument;
    App._ganttSub = priorSub;
    App._currentTab = priorCurrentTab;
  }
});

// ---- Task 6: manual firm round-trips through the explicit Save (Task 6) ----
globalThis.window = globalThis.window || {};
async function withDirtyTracking(body) {
  const off = Store.subscribe(evt => App._trackDirty(evt), 'test.dirty');
  const priorHint = App._firmHintShown;
  App._firmHintShown = true;               // keep the first-toggle toast out of unrelated assertions
  const priorToast = Toast.show;
  Toast.show = () => {};
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  const finish = () => {
    off(); Toast.show = priorToast; App._firmHintShown = priorHint;
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  };
  try {
    await body({ App, Sandbox });
  } finally { finish(); }
}
const firmTask = (id, extra = {}) => ({ id, MACHINE: 'L1', RUN_TIME: 1, row_version: 3,
  start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T09:00:00'), ...extra });

test('a firm toggle dirties just that task and saveAll sends FIRMED without going atomic or forced', () => withDirtyTracking(async () => {
  Store.setTasks([firmTask('fm-a'), firmTask('fm-b')], 'unit-test');
  Store.setFirmed(['fm-a'], true, 'table');
  assert.deepEqual([...Persistence._dirtyIds], ['fm-a']);
  assert.deepEqual([...Persistence._firmDirtyIds], ['fm-a'], 'G4: the firm toggle marks the firm-dirty set');
  assert.equal(Persistence._forceIds.size, 0, 'a firm-only row is never an optimizer (atomic) row');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ status: 'ok', updated: 1, persisted: 1, stale: [], versions: { 'fm-a': 4 } }) };
  };
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].atomic_optimizer, false);
    assert.equal(calls[0].tasks.length, 1);
    assert.equal(calls[0].tasks[0].id, 'fm-a');
    assert.equal(calls[0].tasks[0].FIRMED, true);
    assert.equal(calls[0].tasks[0].force, !Config.CONCURRENCY_CHECK);
    assert.equal(Persistence._dirtyIds.size, 0, 'a persisted firm clears its dirty flag');
    assert.equal(Persistence._firmDirtyIds.size, 0, 'G4: a successful save clears the firm-dirty marker too');
  } finally { globalThis.fetch = originalFetch; }
}));

test('G1: drag, firm, then undo the drag keeps the firm and the save payload sends FIRMED:true (never false)', () => withDirtyTracking(async () => {
  Store.setTasks([firmTask('un-a')], 'unit-test');
  const snap = UndoStack.snapshotTasks(['un-a']);
  Store.updateTask('un-a', { start_date: new Date('2026-09-09T10:00:00'), end_date: new Date('2026-09-09T11:00:00') }, 'interaction');
  Store.setFirmed(['un-a'], true, 'interaction');
  UndoStack.restoreTasks(snap);
  assert.equal(Store.isFirmed('un-a'), true);
  assert.equal(Store.tasks['un-a'].firmed, true);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ status: 'ok', updated: 1, persisted: 1, stale: [], versions: { 'un-a': 4 } }) };
  };
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls[0].tasks[0].FIRMED, true, 'the firm is sent as the planner left it');
  } finally { globalThis.fetch = originalFetch; }
}));

test('a date-only edit does not send FIRMED (a stale local copy must never overwrite another planner firm)', () => withDirtyTracking(async () => {
  Store.setTasks([firmTask('fm-date', { firmed: true })], 'unit-test');
  Store.updateTask('fm-date', { start_date: new Date('2026-09-09T10:00:00'), end_date: new Date('2026-09-09T11:00:00') }, 'table');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ status: 'ok', updated: 1, persisted: 1, stale: [], versions: { 'fm-date': 4 } }) };
  };
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(!('FIRMED' in calls[0].tasks[0]));
  } finally { globalThis.fetch = originalFetch; }
}));

test('firmed:change from sandbox or refresh never dirties; What-If apply leaves the dirty set unchanged', () => withDirtyTracking(() => {
  Store.setTasks([firmTask('wi-a', { firmed: true }), firmTask('wi-b')], 'unit-test');
  App._trackDirty({ type: 'firmed:change', ids: ['wi-a', 'wi-b'], source: 'sandbox', revision: 1, mode: 'live' });
  App._trackDirty({ type: 'firmed:change', ids: ['wi-a'], source: 'refresh', revision: 2, mode: 'live' });
  assert.equal(Persistence._dirtyIds.size, 0);

  Store.setFirmed(['wi-b'], true, 'table');                 // one genuine planner firm
  assert.deepEqual([...Persistence._dirtyIds], ['wi-b']);
  Sandbox.enter('unit-test');
  Sandbox.exit(true, 'unit-test');                          // apply: promotes, emits no firm events
  assert.deepEqual([...Persistence._dirtyIds], ['wi-b'], 'apply must not mass-dirty firms');
  assert.equal(Persistence._forceIds.size, 0);

  // Discard replays the snapshot through replaceFirmedIds('sandbox'): no dirtying even for changed ids.
  Persistence._dirtyIds.clear();
  Sandbox.enter('unit-test');
  Store.setFirmed(['wi-a'], false, 'table');
  Persistence._dirtyIds.clear();
  Store.replaceFirmedIds(new Set(['wi-a']), 'sandbox');
  assert.equal(Persistence._dirtyIds.size, 0, 'a sandbox-sourced firm replacement must not dirty');
  Sandbox.exit(false, 'unit-test');
}));

test('a firm toggled while a save is in flight stays dirty (edit generation)', () => withDirtyTracking(async () => {
  Store.setTasks([firmTask('fl-a')], 'unit-test');
  Store.setFirmed(['fl-a'], true, 'table');
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async () => { await new Promise(r => { release = r; });
    return { ok: true, json: async () => ({ status: 'ok', updated: 1, persisted: 1, stale: [], versions: { 'fl-a': 4 } }) }; };
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    Store.setFirmed(['fl-a'], false, 'table');              // toggled after the payload was captured
    release();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(Persistence._dirtyIds.has('fl-a'), 'the newer firm state was never sent, so it must stay dirty');
  } finally { globalThis.fetch = originalFetch; }
}));

test('first firm toggle per session shows toast.firm_needs_save once', async () => {
  const priorToast = Toast.show;
  const priorHint = App._firmHintShown;
  const priorLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.firm_needs_save': 'FIRM-HINT' } };
  Store.setTasks([firmTask('t-1')], 'unit-test');
  const toasts = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  App._firmHintShown = false;
  Persistence._dirtyIds.clear();
  try {
    App._trackDirty({ type: 'firmed:change', ids: ['t-1'], firmed: true, source: 'table', revision: 1, mode: 'live' });
    App._trackDirty({ type: 'firmed:change', ids: ['t-1'], firmed: false, source: 'table', revision: 2, mode: 'live' });
    assert.equal(toasts.filter(t => t.msg === 'FIRM-HINT').length, 1);
    App._firmHintShown = false;
    toasts.length = 0;
    App._trackDirty({ type: 'firmed:change', ids: ['t-1'], source: 'sandbox', revision: 3, mode: 'live' });
    assert.equal(toasts.length, 0, 'sandbox/refresh sourced events never toast');
  } finally {
    Toast.show = priorToast; App._firmHintShown = priorHint;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Persistence._dirtyIds.clear();
  }
});

test('a firm toggle followed by a reload (tasks:bulk) leaves no stale FIRMED for a later date-only edit', () => withDirtyTracking(async () => {
  Store.setTasks([firmTask('fr-a')], 'unit-test');
  Store.setFirmed(['fr-a'], true, 'table');
  assert.ok(Persistence._firmDirtyIds.has('fr-a'));
  Store.setTasks([firmTask('fr-a', { firmed: false })], 'persistence');   // reload / plant switch
  assert.equal(Persistence._firmDirtyIds.size, 0, 'tasks:bulk clears the firm marker with the dirty set');
  Store.updateTask('fr-a', { start_date: new Date('2026-09-09T10:00:00'), end_date: new Date('2026-09-09T11:00:00') }, 'table');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ status: 'ok', updated: 1, persisted: 1, stale: [], versions: { 'fr-a': 4 } }) };
  };
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(!('FIRMED' in calls[0].tasks[0]));
  } finally { globalThis.fetch = originalFetch; }
}));

// Master Data "↻ Refresh" button — App.refreshMasterSub dispatches to the active
// sub-tab's refresh() through the _MASTER_SUBS registry.

test('every App._MASTER_SUBS entry carries a refresh() function', () => {
  assert.ok(App._MASTER_SUBS.length > 0);
  for (const entry of App._MASTER_SUBS) {
    assert.equal(typeof entry.refresh, 'function', `sub '${entry.sub}' is missing refresh()`);
  }
});

async function withMasterRefresh(fn) {
  const priorToast = Toast.show;
  const priorDocument = globalThis.document;
  const priorSub = App._currentMasterSub;
  const priorPlant = Store.selectedPlant;
  const priorFlag = App._masterRefreshInFlight;
  const btn = { disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const toasts = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  globalThis.document = { getElementById: id => (id === 'md-master-refresh' ? btn : null) };
  Store.setSelectedPlant('P1', 'unit-test');
  App._masterRefreshInFlight = false;
  const entry = App._MASTER_SUBS.find(e => e.sub === 'material');
  const priorRefresh = entry.refresh;
  App._currentMasterSub = 'material';
  try {
    await fn({ btn, toasts, entry });
  } finally {
    entry.refresh = priorRefresh;
    Toast.show = priorToast;
    globalThis.document = priorDocument;
    App._currentMasterSub = priorSub;
    Store.setSelectedPlant(priorPlant, 'unit-test');
    App._masterRefreshInFlight = priorFlag;
  }
}

test('refreshMasterSub calls the active sub refresh and toasts success only when it resolves true', () => withMasterRefresh(async ({ toasts, entry }) => {
  let calls = 0;
  entry.refresh = async () => { calls++; return true; };
  await App.refreshMasterSub();
  assert.equal(calls, 1);
  assert.deepEqual(toasts, [{ msg: Util.t('toast.md_refreshed'), type: 'success' }]);

  toasts.length = 0;
  entry.refresh = async () => { calls++; return false; };
  await App.refreshMasterSub();
  assert.equal(calls, 2);
  assert.deepEqual(toasts, [], 'a false result (cancelled / failed, already toasted by the module) shows no toast');
}));

test('refreshMasterSub disables the button with aria-busy only while in flight and always restores it', () => withMasterRefresh(async ({ btn, toasts, entry }) => {
  let release;
  entry.refresh = () => new Promise(resolve => { release = resolve; });
  const pending = App.refreshMasterSub();
  assert.equal(btn.disabled, true);
  assert.equal(btn.attrs['aria-busy'], 'true');
  release(true);
  await pending;
  assert.equal(btn.disabled, false);
  assert.equal('aria-busy' in btn.attrs, false);

  // A thrown rejection toasts the failure, and the button is still restored.
  entry.refresh = async () => { throw new Error('boom'); };
  toasts.length = 0;
  await App.refreshMasterSub();
  assert.deepEqual(toasts, [{ msg: Util.t('toast.md_refresh_failed', { msg: 'boom' }), type: 'error' }]);
  assert.equal(btn.disabled, false);
  assert.equal('aria-busy' in btn.attrs, false);
  assert.equal(App._masterRefreshInFlight, false);
}));

test('refreshMasterSub with no selected plant toasts toast.no_plant_selected and calls no refresh', () => withMasterRefresh(async ({ toasts, entry }) => {
  let calls = 0;
  entry.refresh = async () => { calls++; return true; };
  Store.setSelectedPlant(null, 'unit-test');
  await App.refreshMasterSub();
  assert.equal(calls, 0);
  assert.deepEqual(toasts, [{ msg: Util.t('toast.no_plant_selected'), type: 'warn' }]);
}));

test('a second refreshMasterSub call while the first is pending is a no-op', () => withMasterRefresh(async ({ entry }) => {
  let calls = 0;
  let release;
  entry.refresh = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = App.refreshMasterSub();
  await App.refreshMasterSub();
  assert.equal(calls, 1, 'the in-flight guard must swallow the second call');
  release(true);
  await first;
  assert.equal(calls, 1);
}));

test('Alert Monitor tab: nav order after Labor, landing defs, section label, first accessible tab', t => {
  t.mock.method(Session, 'canAccessTab', () => true);
  t.mock.method(Util, 't', (k) => k);
  assert.deepEqual(SessionUIAdapter._landingTabDefs().map(([tab]) => tab), ['home', 'gantt', 'labor', 'alerts', 'masterdata', 'admin']);
  assert.equal(SessionUIAdapter._landingTabDefs().find(([tab]) => tab === 'alerts')[1], 'tab.alerts');
  const el = { textContent: '' };
  const priorDoc = globalThis.document;
  globalThis.document = { getElementById: id => (id === 'cmd-band-section-label' ? el : null) };
  try { App._updateSectionLabel('alerts'); } finally { globalThis.document = priorDoc; }
  assert.equal(el.textContent, 'tab.alerts');
  t.mock.method(Session, 'canAccessTab', tab => tab === 'alerts' || tab === 'masterdata');
  assert.equal(App._firstAccessibleTab(), 'alerts');
  assert.equal(App._scrollKeyFor('alerts'), 'alerts');
});