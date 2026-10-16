import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionHelpTooltip, revealHorizontalItem, installLayoutAffordances } from '../../../frontend/platform/layout.mjs';

function help(anchor, size = { width: 260, height: 90 }) {
  const values = {};
  const tip = { style: { setProperty: (k, v) => { values[k] = v; } },
    getBoundingClientRect: () => size, dataset: {} };
  return { values, tip, querySelector: () => tip, getBoundingClientRect: () => anchor };
}

test('help near the top-left flips below and stays inside the viewport', () => {
  const el = help({ left: 0, right: 16, top: 5, bottom: 21, width: 16 });
  positionHelpTooltip(el, { innerWidth: 800, innerHeight: 600 });
  assert.equal(el.values['--tip-left'], '8px');
  assert.equal(el.values['--tip-top'], '29px');
  assert.equal(el.tip.dataset.side, 'below');
});

test('help near the bottom-right stays above its anchor and inside the viewport', () => {
  const el = help({ left: 780, right: 796, top: 570, bottom: 586, width: 16 });
  positionHelpTooltip(el, { innerWidth: 800, innerHeight: 600 });
  assert.equal(el.values['--tip-left'], '532px');
  assert.equal(el.values['--tip-top'], '472px');
  assert.equal(el.tip.dataset.side, 'above');
});

test('revealing a tab scrolls only its horizontal strip', () => {
  const strip = { scrollLeft: 20, clientWidth: 300, clientLeft: 0,
    getBoundingClientRect: () => ({ left: 100 }) };
  const item = { closest: () => strip, getBoundingClientRect: () => ({ left: 370, right: 470, width: 100 }) };
  revealHorizontalItem(item);
  assert.equal(strip.scrollLeft, 90);
  item.getBoundingClientRect = () => ({ left: 70, right: 170, width: 100 });
  revealHorizontalItem(item);
  assert.equal(strip.scrollLeft, 60);
  item.getBoundingClientRect = () => ({ left: 110, right: 210, width: 100 });
  revealHorizontalItem(item);
  assert.equal(strip.scrollLeft, 60);
});

test('keyboard focus positions help without prior mouse movement; scrolling repositions it', () => {
  const events = {};
  const el = help({ left: 0, right: 16, top: 5, bottom: 21, width: 16 });
  const listen = (name, fn) => { (events[name] ??= []).push(fn); };
  const doc = { addEventListener: listen,
    querySelectorAll: () => [el] };
  const win = { innerWidth: 800, innerHeight: 600, addEventListener: listen };
  installLayoutAffordances(doc, win);
  events.focusin.forEach(fn => fn({ target: { closest: selector => selector === '.adm-help' ? el : null } }));
  assert.equal(el.values['--tip-top'], '29px');
  el.getBoundingClientRect = () => ({ left: 20, right: 36, top: 200, bottom: 216, width: 16 });
  events.scroll.forEach(fn => fn());
  assert.equal(el.values['--tip-top'], '102px');
});
