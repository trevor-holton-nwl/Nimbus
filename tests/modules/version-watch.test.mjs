import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotify, startVersionWatch, makeUpdatePresenter } from '../../frontend/shell/version-watch.mjs';

function makeHarness({ hidden = false } = {}) {
  const listeners = new Set();
  const doc = {
    hidden,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  };
  let tick = null;
  let cleared = false;
  return {
    doc,
    listeners,
    fireTick: () => tick && tick(),
    isCleared: () => cleared,
    timers: {
      setIntervalFn: (fn) => { tick = fn; return 1; },
      clearIntervalFn: () => { cleared = true; tick = null; },
    },
  };
}

const flush = () => new Promise(r => setImmediate(r));

test('shouldNotify is true only for two different non-empty strings', () => {
  assert.equal(shouldNotify('a', 'b'), true);
  assert.equal(shouldNotify('a', 'a'), false);
  assert.equal(shouldNotify('', 'b'), false);
  assert.equal(shouldNotify('a', ''), false);
  assert.equal(shouldNotify('a', null), false);
  assert.equal(shouldNotify(undefined, 'b'), false);
  assert.equal(shouldNotify('a', 7), false);
});

test('poll notifies when the remote id differs, and again on each later poll', async () => {
  const h = makeHarness();
  const seen = [];
  startVersionWatch({
    fetchVersion: async () => 'new', currentId: 'old', doc: h.doc, ...h.timers,
    onNewVersion: id => seen.push(id),
  });
  h.fireTick(); await flush();
  h.fireTick(); await flush();
  assert.deepEqual(seen, ['new', 'new']);
});

test('an unchanged remote id never notifies', async () => {
  const h = makeHarness();
  const seen = [];
  startVersionWatch({
    fetchVersion: async () => 'same', currentId: 'same', doc: h.doc, ...h.timers,
    onNewVersion: id => seen.push(id),
  });
  h.fireTick(); await flush();
  assert.deepEqual(seen, []);
});

test('currentId defaults to win.NIMBUS_BUILD_ID', async () => {
  const h = makeHarness();
  const seen = [];
  startVersionWatch({
    fetchVersion: async () => 'b', win: { NIMBUS_BUILD_ID: 'a' }, doc: h.doc, ...h.timers,
    onNewVersion: id => seen.push(id),
  });
  h.fireTick(); await flush();
  assert.deepEqual(seen, ['b']);
});

test('a hidden tab skips the interval poll; becoming visible checks at once', async () => {
  const h = makeHarness({ hidden: true });
  let calls = 0;
  const seen = [];
  startVersionWatch({
    fetchVersion: async () => { calls++; return 'new'; }, currentId: 'old', doc: h.doc, ...h.timers,
    onNewVersion: id => seen.push(id),
  });
  h.fireTick(); await flush();
  assert.equal(calls, 0);
  h.doc.hidden = false;
  for (const fn of h.listeners) fn();
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(seen, ['new']);
});

test('fetch errors are swallowed and the next poll still works', async () => {
  const h = makeHarness();
  const seen = [];
  let n = 0;
  startVersionWatch({
    fetchVersion: async () => { if (n++ === 0) throw new Error('offline'); return 'new'; },
    currentId: 'old', doc: h.doc, ...h.timers, onNewVersion: id => seen.push(id),
  });
  h.fireTick(); await flush();
  assert.deepEqual(seen, []);
  h.fireTick(); await flush();
  assert.deepEqual(seen, ['new']);
});

test('stop() clears the timer, removes the listener and silences later polls', async () => {
  const h = makeHarness();
  const seen = [];
  const stop = startVersionWatch({
    fetchVersion: async () => 'new', currentId: 'old', doc: h.doc, ...h.timers,
    onNewVersion: id => seen.push(id),
  });
  stop();
  assert.equal(h.isCleared(), true);
  assert.equal(h.listeners.size, 0);
  h.fireTick(); await flush();
  assert.deepEqual(seen, []);
});

function presenterDeps({ pending, confirmResult }) {
  const shown = [];
  const confirms = [];
  let reloads = 0;
  return {
    shown, confirms, reloads: () => reloads,
    deps: {
      Toast: { show: (...a) => shown.push(a) },
      Util: { t: k => k },
      Persistence: { hasPendingWork: () => pending },
      Modal: { confirm: async o => { confirms.push(o); return confirmResult; } },
      reload: () => { reloads++; },
    },
  };
}

test('presenter shows a 30 minute info toast whose action reloads when nothing is pending', async () => {
  const p = presenterDeps({ pending: false, confirmResult: true });
  makeUpdatePresenter(p.deps)('new');
  const [msg, type, ms, action] = p.shown[0];
  assert.equal(msg, 'toast.update_available');
  assert.equal(type, 'info');
  assert.equal(ms, 30 * 60 * 1000);
  assert.equal(action.label, 'toast.update_refresh');
  action.run(); await flush();
  assert.equal(p.confirms.length, 0);
  assert.equal(p.reloads(), 1);
});

test('with pending work the action asks first and reloads only on confirm', async () => {
  const yes = presenterDeps({ pending: true, confirmResult: true });
  makeUpdatePresenter(yes.deps)('new');
  yes.shown[0][3].run(); await flush();
  assert.equal(yes.confirms.length, 1);
  assert.equal(yes.confirms[0].message, 'confirm.update_unsaved');
  assert.equal(yes.reloads(), 1);

  const no = presenterDeps({ pending: true, confirmResult: false });
  makeUpdatePresenter(no.deps)('new');
  no.shown[0][3].run(); await flush();
  assert.equal(no.confirms.length, 1);
  assert.equal(no.reloads(), 0);
});
