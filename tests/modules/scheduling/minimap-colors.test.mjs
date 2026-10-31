// Minimap (TimelineNav) alert-category colours: _cssVar reads document.body, _readTheme carries --bar-pm-<cat>,
// the profile-matched bar branch draws the category's colour, and the strip repaints when the decl map changes.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineNav, Timeline, navBarCategory } from '../../../frontend/scheduling/gantt.mjs';
import { AlertProfileMatches } from '../../../frontend/insights/alert-profile-matches.mjs';
import { ALERT_CATEGORY_ORDER, ALL_ALERTS_PROFILE } from '../../../frontend/insights/alert-profiles.mjs';

const priorDoc = globalThis.document;
const priorGcs = globalThis.getComputedStyle;
afterEach(() => { globalThis.document = priorDoc; globalThis.getComputedStyle = priorGcs; });

/** Stub document with a body and a documentElement that disagree, so the element read is observable. */
function stubStyles(bodyVars, rootVars = {}) {
  const body = { id: 'body' }, root = { id: 'root' };
  globalThis.document = { body, documentElement: root };
  globalThis.getComputedStyle = el => ({ getPropertyValue: n => (el === body ? bodyVars : rootVars)[n] ?? '' });
}

test('navBarCategory reads the profile-match-<category> class, ignoring severity classes', () => {
  assert.equal(navBarCategory('order-standard profile-match profile-match-late profile-match-warn'), 'late');
  assert.equal(navBarCategory('profile-match profile-match-err'), null);
  assert.equal(navBarCategory('profile-match profile-match-bogus'), null);
  assert.equal(navBarCategory(undefined), null);
});

test('_cssVar reads document.body, not documentElement (body.dark lives on the body)', () => {
  stubStyles({ '--fg': '#e8edf3' }, { '--fg': '#1c2b3a' });
  assert.equal(TimelineNav._cssVar('--fg', '#000'), '#e8edf3');
  assert.equal(TimelineNav._cssVar('--missing', '#abc'), '#abc');
});

test('_readTheme.pm carries --bar-pm-<category> for all seven categories', () => {
  const vars = { '--accent': '#1f5fbf' };
  ALERT_CATEGORY_ORDER.forEach((c, i) => { vars[`--bar-pm-${c}`] = `#00000${i}`; });
  stubStyles(vars);
  const th = TimelineNav._readTheme();
  assert.deepEqual(Object.keys(th.pm).sort(), [...ALERT_CATEGORY_ORDER].sort());
  assert.equal(th.pm.capacity, '#000000');
  assert.equal(th.pm.exceptions, '#000006');
});

function paintBars(bars, pm) {
  const fills = [];
  let fillStyle = '';
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'fillRect') return (...a) => fills.push([fillStyle, ...a]);
      if (typeof k === 'string' && ['clearRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fillText'].includes(k)) return () => {};
      return undefined;
    },
    set(_, k, v) { if (k === 'fillStyle') fillStyle = v; return true; },
  });
  const day = 86400000, start = Date.UTC(2026, 9, 1);
  const model = {
    range: { startMs: start, endMs: start + 3 * day, dayStarts: [start, start + day, start + 2 * day] },
    layout: { mode: 'rows', stripH: 40, bodyH: 28, rowH: 14 },
    bars, blackouts: [], alertByDay: new Map(), closedDay: [false, false, false], histAll: null, histActive: null,
    nowMs: start, theme: {
      bg: '#bg', closedFill: '#cf', warnFill: '#wf', errFill: '#ef', barStandard: '#std', barFirmed: '#frm', dimFill: '#df',
      dividerColor: '#dc', labelScrim: '#ls', labelText: '#lt', fontMono: 'mono', accent: '#accent', fg: '#fg', pm,
    },
  };
  const prior = { c: TimelineNav._canvas, x: TimelineNav._ctx, t: Timeline._tl };
  TimelineNav._canvas = { offsetWidth: 300, offsetHeight: 40 };
  TimelineNav._ctx = ctx;
  Timeline._tl = null;
  try { TimelineNav._paint(model); } finally { TimelineNav._canvas = prior.c; TimelineNav._ctx = prior.x; Timeline._tl = prior.t; }
  return fills;
}

test('a profile-matched bar is drawn in its category colour; no known category falls back to accent', () => {
  const pm = Object.fromEntries(ALERT_CATEGORY_ORDER.map((c, i) => [c, `#pm${i}`]));
  const day = 86400000, s = Date.UTC(2026, 9, 1);
  const mk = (rowIdx, cat) => ({ rowIdx, startMs: s + 10, endMs: s + day, style: 'profile', firmed: false, cat });
  const fills = paintBars([mk(0, 'planning'), mk(1, 'late'), mk(2, null)], pm);
  const barFills = fills.filter(f => f[0].startsWith('#pm') || f[0] === '#accent');
  assert.deepEqual(barFills.map(f => f[0]).slice(0, 3), [pm.planning, pm.late, '#accent']);
});

test('TimelineNav repaints on an AlertProfileMatches fanout only when the colour decl signature changed', () => {
  const calls = [];
  const priorRender = TimelineNav.render, priorSig = TimelineNav._colorSig, cur = AlertProfileMatches.current;
  TimelineNav.render = () => calls.push('render');
  try {
    AlertProfileMatches.current = () => ({ profile: ALL_ALERTS_PROFILE });
    TimelineNav._colorSig = '';
    TimelineNav._onProfileMatches();
    assert.deepEqual(calls, ['render']);
    TimelineNav._onProfileMatches();                      // unchanged signature: no repaint
    assert.deepEqual(calls, ['render']);
    const categories = Object.fromEntries(ALERT_CATEGORY_ORDER.map(c => [c, { on: true, color: 'sky' }]));
    AlertProfileMatches.current = () => ({ profile: { id: 'p', plant: 'P', name: 'p', description: '', rules: [], ranking: 'impact', categories } });
    TimelineNav._onProfileMatches();
    assert.deepEqual(calls, ['render', 'render']);
  } finally { TimelineNav.render = priorRender; TimelineNav._colorSig = priorSig; AlertProfileMatches.current = cur; }
});
