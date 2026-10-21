// Tests for frontend/platform/overflow-menu.mts: the pure positioning / keyboard helpers without a DOM,
// then the DOM glue against the shared mini-DOM stub (tests/modules/helpers/dom-stub.mjs).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OverflowMenu, menuPosition, menuKeyNav } from '../../../frontend/platform/overflow-menu.mjs';
import { installDom } from '../helpers/dom-stub.mjs';

// ---- pure ------------------------------------------------------------------------------------------------

const VP = { width: 1000, height: 800 };
const SIZE = { width: 180, height: 120 };
const rect = (left, top, width = 24, height = 24) => ({ left, top, right: left + width, bottom: top + height });

test('menuPosition: opens below the anchor, left-aligned', () => {
  const p = menuPosition(rect(100, 100), SIZE, VP);
  assert.equal(p.flipped, false);
  assert.equal(p.left, 100);
  assert.ok(p.top >= 124 && p.top <= 132, `top ${p.top} should sit just below the anchor bottom (124)`);
});

test('menuPosition: flips above when it would overflow the viewport bottom', () => {
  const p = menuPosition(rect(100, 740), SIZE, VP);
  assert.equal(p.flipped, true);
  assert.ok(p.top + SIZE.height <= 740, 'flipped menu must end above the anchor top');
  assert.ok(p.top >= 0);
});

test('menuPosition: align end right-aligns to the anchor', () => {
  const p = menuPosition(rect(500, 100, 24), SIZE, VP, 'end');
  assert.equal(p.left, 524 - SIZE.width);
});

test('menuPosition: clamps horizontally inside the viewport', () => {
  assert.ok(menuPosition(rect(980, 100), SIZE, VP).left + SIZE.width <= VP.width, 'right edge clamped');
  assert.ok(menuPosition(rect(2, 100, 24), SIZE, VP, 'end').left >= 0, 'left edge clamped for align end');
});

test('menuKeyNav: ArrowDown/ArrowUp wrap and skip disabled items', () => {
  const mask = [true, false, true, true];
  assert.equal(menuKeyNav(0, 'ArrowDown', mask), 2);
  assert.equal(menuKeyNav(3, 'ArrowDown', mask), 0);
  assert.equal(menuKeyNav(0, 'ArrowUp', mask), 3);
  assert.equal(menuKeyNav(2, 'ArrowUp', mask), 0);
  assert.equal(menuKeyNav(-1, 'ArrowDown', mask), 0);
  assert.equal(menuKeyNav(-1, 'ArrowUp', mask), 3);
});

test('menuKeyNav: Home/End jump to the first/last enabled item', () => {
  const mask = [false, true, true, false];
  assert.equal(menuKeyNav(2, 'Home', mask), 1);
  assert.equal(menuKeyNav(1, 'End', mask), 2);
});

test('menuKeyNav: Escape closes; Enter and Space select; unrelated keys keep the index; no enabled items is stable', () => {
  const mask = [true, true];
  assert.equal(menuKeyNav(1, 'Escape', mask), 'close');
  assert.equal(menuKeyNav(1, 'Enter', mask), 'select');
  assert.equal(menuKeyNav(1, ' ', mask), 'select');
  assert.equal(menuKeyNav(1, 'x', mask), 1);
  assert.equal(menuKeyNav(0, 'ArrowDown', [false, false]), 0);
});

// ---- DOM -------------------------------------------------------------------------------------------------

let dom, anchor;
const mkItems = (calls = []) => [
  { id: 'fix', label: 'Fix', onSelect: it => calls.push(['fix', it.id]), data: { alertAction: 'fix', alertId: 'a1' } },
  { id: 'off', label: 'Off', onSelect: () => calls.push(['off']), disabled: true, hint: 'Not available while What-If is active' },
  { id: 'show', label: 'Show', onSelect: v => calls.push(['show', v]), checked: false },
  { id: 'del', label: 'Delete', onSelect: () => calls.push(['del']), danger: true },
];
const menuEl = () => dom.doc.body.querySelector('.ovf-menu');
const itemEls = () => dom.doc.body.querySelectorAll('.ovf-item');

beforeEach(() => {
  dom = installDom();
  anchor = dom.doc.createElement('button');
  anchor.rect = { top: 100, left: 300, width: 24, height: 24 };
  dom.doc.body.appendChild(anchor);
  anchor.focus();
});
afterEach(() => { OverflowMenu.closeAll(); dom.restore(); });

test('open renders role=menu with one item per entry and sets aria on the anchor', () => {
  OverflowMenu.open(anchor, mkItems());
  const m = menuEl();
  assert.ok(m, 'menu in the DOM');
  assert.equal(m.getAttribute('role'), 'menu');
  assert.equal(itemEls().length, 4);
  assert.equal(itemEls()[0].getAttribute('role'), 'menuitem');
  assert.equal(itemEls()[2].getAttribute('role'), 'menuitemcheckbox');
  assert.equal(anchor.getAttribute('aria-haspopup'), 'menu');
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  assert.equal(OverflowMenu.isOpen(), true);
  assert.equal(m.parentNode, dom.doc.body);
  assert.ok(itemEls()[3].classList.contains('ovf-item-danger'));
});

test('items carry data-* attributes from `data`', () => {
  OverflowMenu.open(anchor, mkItems());
  const it = itemEls()[0];
  assert.equal(it.getAttribute('data-alert-action'), 'fix');
  assert.equal(it.getAttribute('data-alert-id'), 'a1');
});

test('a disabled item is aria-disabled, shows its hint and is not selectable', () => {
  const calls = [];
  OverflowMenu.open(anchor, mkItems(calls));
  const it = itemEls()[1];
  assert.equal(it.getAttribute('aria-disabled'), 'true');
  assert.ok(it.querySelector('.ovf-hint'));
  assert.equal(it.querySelector('.ovf-hint').textContent, 'Not available while What-If is active');
  it.dispatch('click');
  assert.deepEqual(calls, []);
  assert.equal(OverflowMenu.isOpen(), true, 'clicking a disabled item leaves the menu open');
});

test('a normal item calls onSelect(item) then closes and refocuses the anchor', () => {
  const calls = [];
  OverflowMenu.open(anchor, mkItems(calls));
  itemEls()[0].dispatch('click');
  assert.deepEqual(calls, [['fix', 'fix']]);
  assert.equal(OverflowMenu.isOpen(), false);
  assert.equal(menuEl(), null);
  assert.equal(dom.doc.activeElement, anchor);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
});

test('a checkbox item stays open, toggles, and reports the new value', () => {
  const calls = [];
  OverflowMenu.open(anchor, mkItems(calls));
  const cb = itemEls()[2];
  cb.dispatch('click');
  assert.deepEqual(calls, [['show', true]]);
  assert.equal(cb.getAttribute('aria-checked'), 'true');
  assert.equal(OverflowMenu.isOpen(), true);
  cb.dispatch('click');
  assert.deepEqual(calls, [['show', true], ['show', false]]);
  assert.equal(cb.getAttribute('aria-checked'), 'false');
});

test('keyboard: ArrowDown focuses the next enabled item, Enter selects it, Escape closes and refocuses the anchor', () => {
  const calls = [];
  OverflowMenu.open(anchor, mkItems(calls));
  const m = menuEl();
  assert.equal(dom.doc.activeElement, itemEls()[0], 'first enabled item focused on open');
  m.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(dom.doc.activeElement, itemEls()[2], 'disabled item skipped');
  m.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(calls, [['show', true]]);
  m.dispatch('keydown', { key: 'Escape' });
  assert.equal(OverflowMenu.isOpen(), false);
  assert.equal(dom.doc.activeElement, anchor);
});

test('an outside mousedown closes; a mousedown inside does not', () => {
  OverflowMenu.open(anchor, mkItems());
  itemEls()[1].dispatch('mousedown');
  assert.equal(OverflowMenu.isOpen(), true);
  const other = dom.doc.createElement('div');
  dom.doc.body.appendChild(other);
  other.dispatch('mousedown');
  assert.equal(OverflowMenu.isOpen(), false);
});

test('scroll and resize close the menu', () => {
  OverflowMenu.open(anchor, mkItems());
  dom.win.dispatch('resize');
  assert.equal(OverflowMenu.isOpen(), false);
  OverflowMenu.open(anchor, mkItems());
  dom.win.dispatch('scroll');
  assert.equal(OverflowMenu.isOpen(), false);
});

test('only one menu is open at a time and the first anchor is reset', () => {
  const second = dom.doc.createElement('button');
  second.rect = { top: 200, left: 300, width: 24, height: 24 };
  dom.doc.body.appendChild(second);
  OverflowMenu.open(anchor, mkItems());
  OverflowMenu.open(second, mkItems());
  assert.equal(dom.doc.body.querySelectorAll('.ovf-menu').length, 1);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
  assert.equal(second.getAttribute('aria-expanded'), 'true');
});

test('opening on the already-open anchor toggles it closed; the handle close() is idempotent', () => {
  const h = OverflowMenu.open(anchor, mkItems());
  OverflowMenu.open(anchor, mkItems());
  assert.equal(OverflowMenu.isOpen(), false);
  h.close();
  h.close();
  assert.equal(OverflowMenu.isOpen(), false);
});

test('opts.key mirrors onto the trigger as data-ovf-key', () => {
  OverflowMenu.open(anchor, mkItems(), { key: 'alert-7' });
  assert.equal(anchor.getAttribute('data-ovf-key'), 'alert-7');
});

test('reconcile() leaves a connected anchor alone', () => {
  OverflowMenu.open(anchor, mkItems(), { key: 'k' });
  OverflowMenu.reconcile();
  assert.equal(OverflowMenu.isOpen(), true);
});

test('reconcile() closes when the anchor is disconnected and re-points focus to a trigger with the same key', () => {
  OverflowMenu.open(anchor, mkItems(), { key: 'alert-7' });
  assert.equal(itemEls().length, 4);
  anchor.remove();                                   // the page repainted
  const fresh = dom.doc.createElement('button');
  fresh.setAttribute('data-ovf-key', 'alert-7');
  dom.doc.body.appendChild(fresh);
  OverflowMenu.reconcile();
  assert.equal(OverflowMenu.isOpen(), false);
  assert.equal(menuEl(), null);
  assert.equal(dom.doc.activeElement, fresh);
});

test('reconcile() with no replacement trigger just closes', () => {
  OverflowMenu.open(anchor, mkItems(), { key: 'gone' });
  anchor.remove();
  OverflowMenu.reconcile();
  assert.equal(OverflowMenu.isOpen(), false);
});

// ---- fix round 1 -----------------------------------------------------------------------------------------

const listenerCount = () => {
  const n = o => Object.values(o.listeners).reduce((a, l) => a + l.length, 0);
  return n(dom.doc) + n(dom.win);
};

test('an all-disabled menu focuses the container so Escape still closes it', () => {
  OverflowMenu.open(anchor, [{ id: 'a', label: 'A', onSelect() {}, disabled: true, hint: 'nope' }]);
  const m = menuEl();
  assert.equal(m.getAttribute('tabindex'), '-1');
  assert.equal(dom.doc.activeElement, m);
  m.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(OverflowMenu.isOpen(), true);
  m.dispatch('keydown', { key: 'Escape' });
  assert.equal(OverflowMenu.isOpen(), false);
  assert.equal(dom.doc.activeElement, anchor);
});

test('close removes the document and window listeners it added', () => {
  const before = listenerCount();
  OverflowMenu.open(anchor, mkItems());
  assert.ok(listenerCount() > before);
  OverflowMenu.closeAll();
  assert.equal(listenerCount(), before);
});

test('data-ovf-key stays on the trigger after close', () => {
  OverflowMenu.open(anchor, mkItems(), { key: 'k1' });
  OverflowMenu.closeAll();
  assert.equal(anchor.getAttribute('data-ovf-key'), 'k1');
});

test('onSelect of a plain item can re-find the trigger by key after the menu closed', () => {
  let found = null;
  OverflowMenu.open(anchor, [{ id: 'x', label: 'X', onSelect: () => { found = dom.doc.querySelector('[data-ovf-key="k2"]'); } }], { key: 'k2' });
  itemEls()[0].dispatch('click');
  assert.equal(found, anchor);
});

test('reconcile() with no open menu is a no-op and keeps focus where it is', () => {
  const other = dom.doc.createElement('input');
  dom.doc.body.appendChild(other);
  other.focus();
  OverflowMenu.reconcile();
  assert.equal(dom.doc.activeElement, other);
});

test('reconcile() does not steal focus when focus is elsewhere', () => {
  OverflowMenu.open(anchor, mkItems(), { key: 'k3' });
  const other = dom.doc.createElement('input');
  dom.doc.body.appendChild(other);
  other.focus();
  anchor.remove();
  const fresh = dom.doc.createElement('button');
  fresh.setAttribute('data-ovf-key', 'k3');
  dom.doc.body.appendChild(fresh);
  OverflowMenu.reconcile();
  assert.equal(OverflowMenu.isOpen(), false);
  assert.equal(dom.doc.activeElement, other);
});

test('clicking the anchor while its menu is open closes it (toggle) and opens no second menu', () => {
  const trigger = () => OverflowMenu.open(anchor, mkItems());
  anchor.addEventListener('click', trigger);
  trigger();
  anchor.dispatch('mousedown');
  assert.equal(OverflowMenu.isOpen(), true, 'mousedown on the anchor does not dismiss');
  anchor.dispatch('click');
  assert.equal(OverflowMenu.isOpen(), false);
  assert.equal(dom.doc.body.querySelectorAll('.ovf-menu').length, 0);
});

test('keyboard: End and Home move focus; Space selects', () => {
  const calls = [];
  OverflowMenu.open(anchor, mkItems(calls));
  const m = menuEl();
  m.dispatch('keydown', { key: 'End' });
  assert.equal(dom.doc.activeElement, itemEls()[3]);
  m.dispatch('keydown', { key: 'Home' });
  assert.equal(dom.doc.activeElement, itemEls()[0]);
  m.dispatch('keydown', { key: ' ' });
  assert.deepEqual(calls, [['fix', 'fix']]);
  assert.equal(OverflowMenu.isOpen(), false);
});

test('Enter on a focused aria-disabled item does nothing and keeps the menu open', () => {
  const calls = [];
  OverflowMenu.open(anchor, mkItems(calls));
  itemEls()[1].focus();
  menuEl().dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(calls, []);
  assert.equal(OverflowMenu.isOpen(), true);
});

test('stylesheet puts .ovf-menu above the modal layers', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8');
  const block = /\.ovf-menu \{[^}]*\}/.exec(css)[0];
  assert.ok(Number(/z-index:\s*(\d+)/.exec(block)[1]) >= 1500);
});
