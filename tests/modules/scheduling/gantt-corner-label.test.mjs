import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source pin only: it cannot prove placement (that is an owner browser check).
const css = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8');
const gantt = readFileSync(new URL('../../../frontend/scheduling/gantt.mts', import.meta.url), 'utf8');

test('corner label is drawn on the vis root, not the left panel', () => {
  assert.ok(css.includes('.vis-timeline[data-label]::before'));
  assert.ok(!css.includes('.vis-panel.vis-left[data-label]'));
});

test('dark-mode rule targets the vis root label', () => {
  assert.match(css, /body\.dark \.vis-timeline\[data-label\]::before/);
});

test('gantt.mts sets the label and corner size on the .vis-timeline root', () => {
  assert.ok(gantt.includes("querySelector('.vis-timeline')"));
  assert.ok(gantt.includes("'--corner-h'"));
  assert.ok(gantt.includes("'--corner-w'"));
  assert.ok(gantt.includes("root.setAttribute('data-label'"));
  assert.ok(!gantt.includes("left.setAttribute('data-label'"));
});
