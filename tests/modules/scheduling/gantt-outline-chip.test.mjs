// The "Outlined: N · Clear" chip and the focus outline CSS: static wiring checks (no DOM harness needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL(`../../../frontend/${p}`, import.meta.url), 'utf8');

test('the chip lives in #context-sched-actions, starts hidden and is i18n-routed', () => {
  const html = read('index.html');
  const cluster = html.slice(html.indexOf('id="context-sched-actions"'));
  const end = cluster.indexOf('</div>');
  const block = cluster.slice(0, end);
  assert.match(block, /id="btn-gantt-outline-clear"[^>]*\bhidden\b/);
  assert.match(block, /data-i18n="ui\.gantt_outline_clear"/);
});

test('the shell shows the chip only while focusTaskIds() is set and Clear calls setFocusTaskIds(null)', () => {
  const src = read('shell/application-shell.mts');
  assert.match(src, /AlertProfileMatches\.focusTaskIds\(\)/);
  assert.match(src, /ui\.gantt_outlined_one/);
  assert.match(src, /setFocusTaskIds\(null\)/);
});

test('legend swatch uses lg-outlined; lg-focus stays the scene hover class only', () => {
  const html = read('index.html');
  const css = read('styles.css');
  assert.doesNotMatch(html, /class="[^"]*\blg-focus\b/, 'no legend element may carry the scene class lg-focus');
  assert.match(html, /lg-order-standard lg-outlined/);
  assert.match(css, /\.lg-outlined\s*\{\s*outline:\s*2px dashed/);
  assert.doesNotMatch(css, /^\.lg-focus\s*\{/m);
  assert.match(css, /\.lg-scene\.lg-focus \.lg-el:not\(\.is-on\)/);
});

test('CSS: alert-focus is a dashed ink outline; the red conflict outline and its legend names are gone', () => {
  const css = read('styles.css');
  assert.match(css, /\.vis-item\.alert-focus\s*\{[^}]*outline:\s*2px dashed var\(--fg\) !important/);
  assert.doesNotMatch(css, /conflict-order|\.lg-conflict|\.lg-nav-bar\.conflict/);
  assert.match(css, /\.row-expanded \.vis-item\.vis-range:is\(\.order-standard, \.order-firmed\)\s*\{\s*outline:\s*1px solid var\(--bg-elev\)/);
});
