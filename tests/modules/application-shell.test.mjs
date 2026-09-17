import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, PlantSelector, EmptyState, SessionUIAdapter, showLoginScreen, Settings } from '../../frontend/shell/application-shell.mjs';
import { Util } from '../../frontend/platform/foundation.mjs';

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
// No `distribution` entry yet — that lands with its own pane in a later task.

test('App._GANTT_SUBS carries the documented registry shape for the two existing sub-tabs', () => {
  assert.deepEqual(App._GANTT_SUBS.map(e => e.key), ['timeline', 'orders']);
  assert.deepEqual(App._GANTT_SUBS.find(e => e.key === 'timeline'), {
    key: 'timeline', paneId: 'gantt-sub-timeline', labelKey: 'tab.gantt_timeline',
    landingEligible: true, scrollKey: 'gantt:timeline',
  });
  assert.deepEqual(App._GANTT_SUBS.find(e => e.key === 'orders'), {
    key: 'orders', paneId: 'gantt-sub-orders', labelKey: 'tab.table',
    landingEligible: true, scrollKey: 'gantt:orders',
  });
});

test('gotoGanttSub is a no-op for an unknown sub-tab key (matches the old whitelist\'s reject-unknown behavior)', () => {
  const priorSub = App._ganttSub;
  App._ganttSub = 'timeline';
  try {
    App.gotoGanttSub('distribution'); // not registered yet — must be rejected same as any bogus key
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
    ]);
  } finally {
    globalThis.window = priorWindow;
  }
});
