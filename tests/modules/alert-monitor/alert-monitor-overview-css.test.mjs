// Task 31: static gate over the Overview band stylesheet. Reads frontend/styles.css as text, slices the Alert Monitor
// Overview block (between its header comment and the "Alert groups" comment) and asserts the house rules from the
// plan (section 1 / 7): tokens only, hairlines, no gradients / side stripes / glass, transitions through --t-fast
// and --t-med only, a reduced-motion guard, and that every class the builders emit is actually styled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { overviewData, overviewHtml, narrowChipHtml } from '../../../frontend/alert-monitor/alert-monitor-overview.mjs';

const CSS = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8');
const START = '/* ---- Alert Monitor Overview';
const END = '/* ---- Alert groups';
const i0 = CSS.indexOf(START);
const i1 = CSS.indexOf(END);
const BLOCK = i0 >= 0 && i1 > i0 ? CSS.slice(i0, i1) : '';
// The same block with comments removed: comments may mention a forbidden word while explaining why it is absent.
const CODE = BLOCK.replace(/\/\*[\s\S]*?\*\//g, '');

test('the Overview block exists between the Top fixes rules and the Alert groups rules', () => {
  assert.ok(i0 > 0, 'start marker found');
  assert.ok(i1 > i0, 'end marker found after the start marker');
  assert.ok(CSS.indexOf('.am-fixes {') < i0, 'placed after the .am-fixes rules');
  assert.ok(CODE.includes('.am-overview'), 'styles the section');
  assert.ok(CODE.length > 2000, 'the block is substantial');
});

test('the block is LF only (styles.css is an LF file)', () => {
  assert.ok(!CSS.includes('\r'), 'no carriage return anywhere in styles.css');
});

test('no gradients, side stripes, glass or hard-coded colours', () => {
  assert.ok(!/gradient\(/i.test(CODE), 'no gradient()');
  assert.ok(!/border-(left|right)\s*:/i.test(CODE), 'no border-left / border-right accents');
  assert.ok(!/border-(inline-start|inline-end)\s*:/i.test(CODE), 'no logical side stripes either');
  assert.ok(!/backdrop-filter/i.test(CODE), 'no backdrop-filter');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(CODE), 'no hex colours');
  assert.ok(!/\brgba?\(/i.test(CODE), 'no rgb()/rgba() colours');
  assert.ok(!/\bhsla?\(/i.test(CODE), 'no hsl()/hsla() colours');
  assert.ok(!/box-shadow\s*:\s*[^;]*\d+px\s+\d+px\s+\d+px/i.test(CODE), 'no soft drop shadows (hairlines only)');
});

test('transition durations only come from --t-fast / --t-med; no keyframe animation', () => {
  const decls = CODE.match(/transition\s*:[^;}]*/gi) ?? [];
  assert.ok(decls.length > 0, 'at least one transition is declared');
  for (const d of decls) {
    if (/transition\s*:\s*none\b/i.test(d)) continue;
    assert.ok(/var\(--t-(fast|med)\)/.test(d), `transition uses a motion token: ${d}`);
    assert.ok(!/\d(ms|s)\b/.test(d.replace(/var\(--t-(fast|med)\)/g, '')), `no literal duration: ${d}`);
    assert.ok(!/\ball\b/.test(d), `no transition: all: ${d}`);
    for (const prop of d.replace(/transition\s*:/i, '').split(',').map(s => s.trim().split(/\s+/)[0])) {
      assert.ok(['opacity', 'background', 'background-color', 'height'].includes(prop), `only opacity/background/height transition: ${prop}`);
    }
  }
  assert.ok(!/transition-duration|animation\s*:|@keyframes/i.test(CODE), 'no literal durations or keyframes');
});

test('a prefers-reduced-motion rule names .am-ov-bar and switches the transitions off', () => {
  const m = CODE.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\})\s*\}/);
  assert.ok(m, 'reduced-motion media rule present');
  assert.ok(/\.am-ov-bar\b/.test(m[1]), 'names .am-ov-bar');
  assert.ok(/\.am-ov-seg\b/.test(m[1]), 'names .am-ov-seg');
  assert.ok(/transition\s*:\s*none/.test(m[1]), 'turns transitions off');
});

test('every --bar-pm-* token used exists in both :root and body.dark', () => {
  const used = [...new Set(BLOCK.match(/--bar-pm-[a-z]+(?:-fg)?/g) ?? [])];
  assert.ok(used.length >= 10, `five fills and five -fg labels are used (got ${used.length})`);
  // The token blocks: the `:root {` and `body.dark {` blocks that carry the --bar-pm-capacity definition.
  const blockWith = (head) => {
    for (let at = CSS.indexOf(head); at >= 0; at = CSS.indexOf(head, at + 1)) {
      const block = CSS.slice(at, CSS.indexOf('}', at));
      if (block.includes('--bar-pm-capacity:')) return block;
    }
    return '';
  };
  const rootBlock = blockWith(':root {');
  const darkBlock = blockWith('body.dark {');
  assert.ok(rootBlock && darkBlock, 'both token blocks found');
  for (const tok of used) {
    assert.ok(new RegExp(`${tok}\\s*:`).test(rootBlock), `${tok} defined in :root`);
    assert.ok(new RegExp(`${tok}\\s*:`).test(darkBlock), `${tok} defined in body.dark`);
  }
});

test('structural rules the markup relies on', () => {
  // The body is a grid, so the [hidden] attribute needs an explicit display:none.
  assert.ok(/\.am-ov-body\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(CODE), 'collapsed body hidden');
  assert.ok(/\.am-ov-body\s*\{[^}]*grid-template-columns\s*:\s*minmax\(300px,\s*1fr\)\s+230px\s+220px\s+150px/.test(CODE), 'plan section 6 grid');
  // Stacking: warn is first in the DOM and err sits at the base, so a plain column, never column-reverse.
  const bar = CODE.match(/(?:^|\})\s*\.am-ov-bar\s*\{([^}]*)\}/);
  assert.ok(bar, '.am-ov-bar base rule');
  assert.ok(/display\s*:\s*flex/.test(bar[1]) && /flex-direction\s*:\s*column\s*;/.test(bar[1]), 'bar is a flex column');
  assert.ok(!/column-reverse/.test(CODE), 'never column-reverse');
  assert.ok(/height\s*:\s*calc\(var\(--h\)\s*\*\s*1%\)/.test(bar[1]), 'height from --h');
  assert.ok(/grid-row\s*:\s*1\b/.test(CODE.match(/\.am-ov-col\s*\{([^}]*)\}/)?.[1] ?? ''), 'columns pinned to row 1');
  assert.ok(/grid-row\s*:\s*1\b/.test(CODE.match(/\.am-ov-win\s*\{([^}]*)\}/)?.[1] ?? ''), 'window band pinned to row 1');
  assert.ok(/grid-column\s*:\s*var\(--c1\)\s*\/\s*var\(--c2\)/.test(CODE), 'window band uses --c1 / --c2');
  assert.ok(/flex-grow\s*:\s*var\(--g\)/.test(CODE), 'segments grow by --g');
  assert.ok(/calc\(var\(--w\)\s*\*\s*1%\)/.test(CODE), 'track spans use --w');
  assert.ok(/repeat\(var\(--cols\)/.test(CODE), 'chart and ticks use --cols');
  // The in-segment count hides under ~22px through a container query on the segment.
  assert.ok(/\.am-ov-cat\s*\{[^}]*container-type\s*:\s*inline-size/.test(CODE), 'segment is a size container');
  assert.ok(/@container\s*\(max-width:\s*21px\)\s*\{[^}]*\.am-ov-cat-n\s*\{[^}]*display\s*:\s*none/.test(CODE), 'count hidden when narrow');
  // Selection is never colour-only, and inset outlines keep edge bars inside the overflow:hidden panel.
  assert.ok(/\.is-sel\b[^{]*\{[^}]*outline\s*:\s*2px solid var\(--fg\)[^}]*outline-offset\s*:\s*-2px/.test(CODE), 'is-sel: 2px --fg inset outline');
  assert.ok(/:focus-visible[^{]*\{[^}]*outline-offset\s*:\s*-2px/.test(CODE), 'focus-visible outline inset');
  assert.ok(/\.has-sel[^{]*:not\(\.is-sel\)[^{]*\{[^}]*opacity\s*:\s*\.4/.test(CODE), 'unselected siblings dim to .4');
});

test('responsive: wraps below the grid minimum (2 columns) and again at 560 (1 column), inside a container query', () => {
  assert.ok(/container(?:-type)?\s*:[^;]*inline-size/.test(CODE.match(/\.am-overview\s*\{[^}]*\}/)?.[0] ?? ''), '.am-overview is a size container');
  const q = [...CODE.matchAll(/@container\s+am-ov\s*\(max-width:\s*(\d+(?:\.\d+)?)px\)/g)].map(m => Number(m[1]));
  assert.ok(q.some(w => w >= 899 && w <= 936), `a two-column step at the grid minimum (got ${q})`);
  assert.ok(q.some(w => w >= 559 && w < 560), `a one-column step below 560 (got ${q})`);
  assert.ok(/repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(CODE), 'two equal columns');
});

test('every class the builders emit is styled (or deliberately owned by an existing rule)', () => {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const t = (k, v) => (v ? `${k}|${Object.values(v).join(',')}` : k);
  const v = { t, esc, fmtDay: k => k, fmtTick: k => k, unassigned: 'Unassigned' };
  const today = new Date(2026, 9, 20);
  const at = off => new Date(2026, 9, 20 + off, 9);
  const types = ['overload', 'overlap', 'blackout', 'setup-violated', 'late'];
  const listed = [];
  let n = 0;
  for (let i = 0; i < 12; i++) {
    listed.push({ id: `a${++n}`, sev: i % 2 ? 'err' : 'warn', type: types[i % types.length], line: `L${i}`, time: at(i % 5 === 4 ? -3 : i % 5) });
  }
  listed.push({ id: `a${++n}`, sev: 'warn', type: 'overlap', line: 'L1', time: at(90) });
  const deps = { dueInstant: task => new Date(task.original_end_date), latenessHours: () => 0 };
  const data = overviewData(listed, { tasksById: {}, plantToday: today, horizonMinutes: 14 * 1440, window: { from: -1, to: 3 }, deps });
  const conf = { score: 71, history: [{ ts: 1, score: 60 }, { ts: 2, score: 71 }], ghost: 78 };
  const narrow = { day: data.days[0].key, line: 'L1', category: 'conflicts' };
  const only = overviewData([listed[1]], { tasksById: {}, plantToday: today, horizonMinutes: 1440, window: null, deps });
  const html = [
    overviewHtml({ data, narrow, showAll: true, conf, collapsed: false }, v),
    overviewHtml({ data, narrow: {}, showAll: false, conf, collapsed: false }, v),
    overviewHtml({ data: only, narrow: {}, showAll: false, conf: { score: 30, history: [], ghost: null }, collapsed: true }, v),
    narrowChipHtml({ shown: 2, total: 9, narrow, labelOf: (d, x) => x }, t),
  ].join('\n');
  const classes = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  assert.ok(classes.size > 60, `the fixture exercises the markup (${classes.size} classes)`);
  // Owned elsewhere in styles.css: the generic button, panel head / hint and caret rules.
  const external = new Set(['btn', 'sm', 'btn-ghost', 'panel-head', 'panel-hint', 'am-caret']);
  // Pure state / identity hooks with no rule of their own (the base class already carries the style):
  // am-ov-what (the panel's identity; .am-ov-panel styles it), am-ov-col-overdue / am-ov-col-later / am-ov-bucket (the
  // bucket columns look like day columns), is-today (the Today hairline is its own .am-ov-today child).
  const hooks = new Set(['am-ov-what', 'am-ov-col-overdue', 'am-ov-col-later', 'am-ov-bucket', 'is-today']);
  const missing = [...classes].filter(c => !external.has(c) && !hooks.has(c) && !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}(?![\\w-])`).test(CODE));
  assert.deepEqual(missing, [], `unstyled emitted classes: ${missing.join(', ')}`);
  for (const c of external) assert.ok(new RegExp(`\\.${c}(?![\\w-])`).test(CSS), `${c} is styled somewhere in styles.css`);
  for (const cat of ['capacity', 'conflicts', 'calendar', 'setup', 'exceptions']) {
    assert.ok(classes.has(`am-ov-cat-${cat}`) && classes.has(`am-ov-sw-${cat}`), `fixture emits ${cat}`);
  }
});
