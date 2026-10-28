import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotify, startVersionWatch, makeUpdatePresenter } from '../../frontend/shell/version-watch.mjs';
import { makeDocument, makeEl } from './helpers/dom-stub.mjs';

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


function presenterDeps({ pending = false, confirmResult = true, staticMarkup = true } = {}) {
  const doc = makeDocument();
  const bar = makeEl('', doc); bar.className = 'context-bar'; doc.body.appendChild(bar);
  // dom-stub has no ChildNode.after()/prepend(); minimal shims for the presenter's markup fallback.
  bar.after = node => { const kids = bar.parentNode.children; bar.parentNode.appendChild(node); kids.splice(kids.indexOf(node), 1); kids.splice(kids.indexOf(bar) + 1, 0, node); };
  doc.body.prepend = node => { doc.body.appendChild(node); doc.body.children.unshift(doc.body.children.pop()); };
  const toggle = makeEl('nav-drawer-toggle', doc, 'button'); doc.body.appendChild(toggle);
  if (staticMarkup) {
    const banner = makeEl('update-banner', doc); banner.hidden = true; doc.body.appendChild(banner);
    banner.appendChild(makeEl('update-banner-build', doc, 'span'));
    banner.appendChild(makeEl('update-banner-refresh', doc, 'button'));
    banner.appendChild(makeEl('update-banner-dismiss', doc, 'button'));
  }
  const confirms = [];
  let reloads = 0, layouts = 0;
  return {
    doc, confirms, reloads: () => reloads, layouts: () => layouts,
    banners: () => doc.querySelectorAll('#update-banner'),
    banner: () => doc.getElementById('update-banner'),
    click: id => doc.getElementById(id).dispatch('click'),
    deps: {
      Util: { t: k => k },
      Persistence: { hasPendingWork: () => pending },
      Modal: { confirm: async o => { confirms.push(o); return confirmResult; } },
      reload: () => { reloads++; },
      doc,
      onLayoutChange: () => { layouts++; },
    },
  };
}

test('first call shows the strip, sets the build tag and body class, and fires onLayoutChange once', () => {
  const p = presenterDeps();
  makeUpdatePresenter(p.deps)('b2');
  assert.equal(p.banner().hidden, false);
  assert.equal(p.doc.getElementById('update-banner-build').textContent, 'b2');
  assert.equal(p.doc.body.classList.contains('update-available'), true);
  assert.equal(p.layouts(), 1);
});

test('repeated polls with the same id are no-ops', () => {
  const p = presenterDeps();
  const on = makeUpdatePresenter(p.deps);
  on('b2'); on('b2'); on('b2');
  assert.equal(p.layouts(), 1);
  assert.equal(p.banners().length, 1);
  assert.equal(p.doc.getElementById('update-banner-refresh').listeners.click.length, 1);
});

test('a still-newer id updates the tag in place without another layout call', () => {
  const p = presenterDeps();
  const on = makeUpdatePresenter(p.deps);
  on('b2'); on('b3');
  assert.equal(p.doc.getElementById('update-banner-build').textContent, 'b3');
  assert.equal(p.layouts(), 1);
});

test('dismiss hides the strip until a different id arrives', () => {
  const p = presenterDeps();
  const on = makeUpdatePresenter(p.deps);
  on('b2');
  p.click('update-banner-dismiss');
  assert.equal(p.banner().hidden, true);
  assert.equal(p.doc.body.classList.contains('update-available'), false);
  assert.equal(p.layouts(), 2);
  on('b2'); on('b2');
  assert.equal(p.banner().hidden, true);
  assert.equal(p.layouts(), 2);
  on('b3');
  assert.equal(p.banner().hidden, false);
  assert.equal(p.doc.getElementById('update-banner-build').textContent, 'b3');
  assert.equal(p.layouts(), 3);
});

test('dismiss moves focus to the nav toggle only when focus was inside the strip', () => {
  const p = presenterDeps();
  makeUpdatePresenter(p.deps)('b2');
  p.doc.getElementById('update-banner-dismiss').focus();
  p.click('update-banner-dismiss');
  assert.equal(p.doc.activeElement, p.doc.getElementById('nav-drawer-toggle'));

  const q = presenterDeps();
  makeUpdatePresenter(q.deps)('b2');
  assert.equal(q.doc.activeElement, null, 'showing never steals focus');
  q.click('update-banner-dismiss');
  assert.equal(q.doc.activeElement, null);
});

test('Refresh reloads straight away when nothing is pending', async () => {
  const p = presenterDeps({ pending: false });
  makeUpdatePresenter(p.deps)('b2');
  p.click('update-banner-refresh'); await flush();
  assert.equal(p.confirms.length, 0);
  assert.equal(p.reloads(), 1);
});

test('with pending work Refresh asks first, reloads only on confirm and keeps the strip on cancel', async () => {
  const yes = presenterDeps({ pending: true, confirmResult: true });
  makeUpdatePresenter(yes.deps)('b2');
  yes.click('update-banner-refresh'); await flush();
  assert.equal(yes.confirms.length, 1);
  assert.equal(yes.confirms[0].message, 'confirm.update_unsaved');
  assert.equal(yes.confirms[0].confirmLabel, 'toast.update_refresh');
  assert.equal(yes.reloads(), 1);

  const no = presenterDeps({ pending: true, confirmResult: false });
  makeUpdatePresenter(no.deps)('b2');
  no.click('update-banner-refresh'); await flush();
  assert.equal(no.confirms.length, 1);
  assert.equal(no.reloads(), 0);
  assert.equal(no.banner().hidden, false);
});

test('a second Refresh click while the confirm is open is ignored', async () => {
  let release;
  const p = presenterDeps({ pending: true });
  p.deps.Modal.confirm = o => { p.confirms.push(o); return new Promise(r => { release = r; }); };
  makeUpdatePresenter(p.deps)('b2');
  p.click('update-banner-refresh'); p.click('update-banner-refresh'); await flush();
  assert.equal(p.confirms.length, 1);
  release(false); await flush();
  assert.equal(p.reloads(), 0);
});

test('without the static markup the presenter builds exactly one wired strip after the context bar', () => {
  const p = presenterDeps({ staticMarkup: false });
  const on = makeUpdatePresenter(p.deps);
  on('b2'); on('b2'); on('b3');
  assert.equal(p.banners().length, 1);
  assert.equal(p.banner().hidden, false);
  assert.equal(p.banner().getAttribute('role'), 'status');
  const kids = p.doc.body.children;
  assert.equal(kids[kids.findIndex(k => k.className === 'context-bar') + 1], p.banner());
  assert.equal(p.doc.getElementById('update-banner-build').textContent, 'b3');
  assert.equal(p.doc.getElementById('update-banner-refresh').textContent, 'toast.update_refresh');
  assert.equal(p.doc.getElementById('update-banner-dismiss').getAttribute('aria-label'), 'btn.dismiss');
  assert.equal(p.doc.getElementById('update-banner-refresh').listeners.click.length, 1);
});
