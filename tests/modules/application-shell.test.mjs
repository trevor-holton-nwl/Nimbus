import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, PlantSelector, EmptyState, SessionUIAdapter, showLoginScreen, Settings } from '../../frontend/shell/application-shell.mjs';
import { Util } from '../../frontend/platform/foundation.mjs';
import { Persistence } from '../../frontend/scheduling/persistence.mjs';
import { DistributionPane } from '../../frontend/distribution/distribution-pane.mjs';

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
