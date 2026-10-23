// Tests for frontend/insights/toast-log-tab.mts with the dom-stub: newest-first order, scope filter,
// hidden/active toggling and the debounced re-render that only fires while the Toast Log tab is active.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToastLogTab } from '../../../frontend/insights/toast-log-tab.mjs';
import { ErrorLog, Toast } from '../../../frontend/platform/foundation.mjs';
import { installDom } from '../helpers/dom-stub.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let dom, ids;

function build() {
  dom = installDom();
  const { doc } = dom;
  const mk = (tag, id, parent = doc.body) => { const e = doc.createElement(tag); e.id = id; parent.appendChild(e); return e; };
  const drawer = mk('aside', 'alert-drawer'); drawer.classList.add('open');
  const nav = mk('nav', 'alert-drawer-tabs', drawer);
  const b1 = mk('button', '', nav); b1.setAttribute('data-drawer-tab', 'alerts'); b1.classList.add('seg-btn', 'active');
  const b2 = mk('button', '', nav); b2.setAttribute('data-drawer-tab', 'toasts'); b2.classList.add('seg-btn');
  ids = { drawer, b1, b2 };
  for (const id of ['alert-dismiss-visible', 'alert-drawer-body', 'alert-drawer-footer', 'toast-log-body', 'toast-log-footer']) ids[id] = mk('div', id, drawer);
  ids['toast-log-body'].hidden = true; ids['toast-log-footer'].hidden = true;
  const ex = mk('button', 'toast-log-export', ids['toast-log-footer']);
  ids.ex = ex;
}

const _con = { log: console.log, info: console.info, warn: console.warn, error: console.error };
beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; ErrorLog.clear(); build(); ToastLogTab.init(); });
afterEach(() => { dom.restore(); Object.assign(console, _con); });

test('activate(toasts) swaps visibility and aria-selected; activate(alerts) restores', () => {
  ToastLogTab.activate('toasts');
  assert.equal(ids['alert-drawer-body'].hidden, true);
  assert.equal(ids['alert-drawer-footer'].hidden, true);
  assert.equal(ids['alert-dismiss-visible'].hidden, true);
  assert.equal(ids['toast-log-body'].hidden, false);
  assert.equal(ids['toast-log-footer'].hidden, false);
  assert.equal(ids.b2.getAttribute('aria-selected'), 'true');
  assert.equal(ids.b1.getAttribute('aria-selected'), 'false');
  ToastLogTab.activate('alerts');
  assert.equal(ids['alert-drawer-body'].hidden, false);
  assert.equal(ids['toast-log-body'].hidden, true);
  assert.equal(ids.b1.classList.contains('active'), true);
});

test('tab click activates; footer hidden state is restored', () => {
  ids['alert-drawer-footer'].hidden = false;
  ids.b2.dispatch('click');
  assert.equal(ids['toast-log-body'].hidden, false);
  ids.b1.dispatch('click');
  assert.equal(ids['alert-drawer-footer'].hidden, false);
});

test('render lists only toast-scope entries, newest first, escaped, with icon by type', () => {
  Toast.show('first <b>', 'error');
  ErrorLog.info('other', 'not a toast');
  Toast.show('second', 'success');
  ToastLogTab.activate('toasts');
  const html = ids['toast-log-body'].innerHTML;
  assert.ok(!html.includes('not a toast'));
  assert.ok(html.indexOf('second') < html.indexOf('first'));
  assert.ok(html.includes('first &lt;b&gt;'));
  assert.ok(html.includes('✖') && html.includes('✓'));
  assert.equal((html.match(/class="alert-row/g) || []).length, 2);
});

test('empty state when no toasts', () => {
  ToastLogTab.activate('toasts');
  assert.ok(ids['toast-log-body'].innerHTML.includes('empty-state'));
});

test('new toast re-renders (debounced) only while the toasts tab is active', async () => {
  ToastLogTab.activate('alerts');
  const w0 = ids['toast-log-body'].writes;
  Toast.show('while alerts tab', 'info');
  await sleep(160);
  assert.equal(ids['toast-log-body'].writes, w0);
  ToastLogTab.activate('toasts');
  const w1 = ids['toast-log-body'].writes;
  Toast.show('a', 'info'); Toast.show('b', 'warn');
  assert.equal(ids['toast-log-body'].writes, w1);   // debounced, not synchronous
  await sleep(160);
  assert.equal(ids['toast-log-body'].writes, w1 + 1);
  assert.ok(ids['toast-log-body'].innerHTML.includes('>b<'));
  ids.drawer.classList.remove('open');
  Toast.show('closed', 'info');
  await sleep(160);
  assert.equal(ids['toast-log-body'].writes, w1 + 1);
});
