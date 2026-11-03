// nimbus-intelligence.js i18n sweep and the helpers that came with it (code review C29 / C31 / C34 / C24-C28):
// stored snapshot labels (key + variables, old plain strings still read), singular / plural key pairs, translated palette
// chrome, relative time, the confidence band helper, palette search order, and the single-pass Patterns / Ripple scans.
// The VM harness runs the production classic script with the boot gate closed (see intelligence-fixes.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext, runInNewContext } from 'node:vm';
import { loadLegacyApp, ROOT } from '../helpers/load-legacy-app.mjs';

const { nimbus, context } = await loadLegacyApp();
context.document.readyState = 'loading';
context.document.addEventListener = () => {};
context.addEventListener = () => {};
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
const SOURCE = readFileSync(`${ROOT}/frontend/nimbus-intelligence.js`, 'utf8');
runInContext(SOURCE, context);
const { Store, Toast, Util } = nimbus;
const { CommandPalette, NeedsEngine, TimeMachine, Confidence, RipplePreview, Patterns, Diff } = nimbus;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// The harness loads no locale files, so a test installs the strings it asserts on (keys not listed return the key).
function withLocale(entries, body) {
  const prior = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { [Util.locale()]: entries };
  try { return body(); } finally { globalThis.window.__NIMBUS_LOCALES = prior; }
}
function withPlant(plant, tasks, body) {
  const priorTasks = structuredClone(Store.tasksArr), priorPlant = Store.selectedPlant;
  Store.setTasks(tasks, 'test');
  Store.setSelectedPlant(plant, 'test');
  try { return body(); } finally { Store.setTasks(priorTasks, 'test'); Store.setSelectedPlant(priorPlant, 'test'); }
}

// ---- locale files ---------------------------------------------------------------------------------------------------

function loadLocales() {
  const out = {};
  for (const code of ['en', 'de', 'es', 'fr', 'pt']) {
    const w = {};
    runInNewContext(readFileSync(`${ROOT}/frontend/locales/${code}.js`, 'utf8'), { window: w });
    out[code] = w.__NIMBUS_LOCALES[code];
  }
  return out;
}
const placeholders = s => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');

test('every translation key nimbus-intelligence.js names exists in all five locales, and every _plural key has its _one twin', () => {
  const locales = loadLocales();
  const keys = new Set([...SOURCE.matchAll(/'((?:cmdp|ui|btn|toast|undo|snap|tip|aria|intel|confirm)\.[a-z0-9_]*[a-z0-9])'/g)].map(m => m[1]));
  const pluralKeys = [...SOURCE.matchAll(/_plural\([^,]+,\s*(?:[^'?]*\?\s*)?'([\w.]+)'(?:\s*:\s*'([\w.]+)')?/g)].flatMap(m => [m[1], m[2]].filter(Boolean));
  assert.ok(keys.size > 40, 'the scan found the file\'s keys');
  for (const key of pluralKeys) { keys.add(key); keys.add(`${key}_one`); }
  keys.delete('toast.');   // a prefix literal
  for (const code of Object.keys(locales)) {
    const missing = [...keys].filter(k => !(k in locales[code]));
    assert.deepEqual(missing, [], `${code}.js is missing keys used by nimbus-intelligence.js`);
  }
});

test('the new intelligence keys keep the English placeholder set in every locale; the seven need_* texts are translated, with no {{plural}} suffix', () => {
  const locales = loadLocales();
  const mine = Object.keys(locales.en).filter(k => /^(snap\.|undo\.(firm|unfirm|before_time)|cmdp\.(fab_|type_)|cmdp\.need_.*_one$|ui\.(hours_mins_ago|diff_(added_short|removed_short|n_|snap_)|ripple_downstream|conf_tier_|conf_axis_now|conf_days_over))/.test(k));
  assert.ok(mine.length >= 30, `found ${mine.length} new keys`);
  for (const key of mine) for (const code of ['de', 'es', 'fr', 'pt'])
    assert.equal(placeholders(locales[code][key]), placeholders(locales.en[key]), `${code} ${key} placeholders`);
  const need = ['conflict_jump', 'overload_inspect', 'unscheduled_review', 'snapshot_due', 'first_snapshot', 'blackout_risk', 'sandbox_active'].map(k => `cmdp.need_${k}`);
  for (const key of need) for (const code of ['de', 'es', 'fr', 'pt']) {
    assert.notEqual(locales[code][key], locales.en[key], `${code} ${key} is translated`);
    assert.doesNotMatch(locales[code][key], /\{\{plural\}\}/, `${code} ${key} has no English suffix placeholder`);
  }
  for (const code of Object.keys(locales)) assert.doesNotMatch(locales[code]['ui.conf_days_over'], /\{\{plural\}\}/);
});

// ---- stored snapshot labels -----------------------------------------------------------------------------------------

test('checkpoint() stores a label KEY with its variables; the text shown follows the current language and the time follows the snapshot', () => {
  const db = TimeMachine._IntelDB;
  const prior = { put: db.putSnapshot, prune: db.pruneSnapshots, snaps: TimeMachine._snapshots, show: Toast.show };
  const saved = [], toasts = [];
  db.putSnapshot = (body, meta) => { saved.push({ body, meta }); return Promise.resolve(); };
  db.pruneSnapshots = () => {};
  Toast.show = (msg, type) => toasts.push({ msg, type });
  try {
    withPlant('LBL-P', [], () => withLocale({
      'snap.pre_selection': 'Pre-selection · {{count}} orders · {{time}}',
      'snap.manual': 'Manual · {{time}}',
      'toast.snapshot_saved': 'Snapshot saved',
    }, () => {
      const snap = TimeMachine.checkpoint('snap.pre_selection', { count: 3 });
      assert.equal(saved.length, 1);
      const { meta } = saved[0];
      assert.equal(meta.labelKey, 'snap.pre_selection');
      assert.deepEqual({ ...meta.labelVars }, { count: 3 });
      assert.match(meta.label, /^Pre-selection · 3 orders · /, 'plain .label keeps the current-language text for older readers');
      assert.equal(snap.labelKey, 'snap.pre_selection');
      assert.deepEqual(toasts.map(x => x.msg), ['Snapshot saved'], 'the standard toast');

      // Display time: another language, and a time computed from the snapshot's own stamp.
      const entry = { ts: 86400000 * 3, labelKey: 'snap.manual', labelVars: null, label: 'old text' };
      assert.equal(TimeMachine.labelOf(entry), `Manual · ${Util._fmtTimePref(new Date(entry.ts))}`);
      globalThis.window.__NIMBUS_LOCALES = { [Util.locale()]: { 'snap.manual': 'Manuell · {{time}}' } };
      assert.equal(TimeMachine.labelOf(entry), `Manuell · ${Util._fmtTimePref(new Date(entry.ts))}`, 'translated at display time');

      // Opting out of the toast (the freeze command has its own).
      toasts.length = 0;
      TimeMachine.checkpoint('snap.manual', null, { toast: false });
      assert.deepEqual(toasts, []);
    }));
  } finally {
    db.putSnapshot = prior.put; db.pruneSnapshots = prior.prune; TimeMachine._snapshots = prior.snaps; Toast.show = prior.show;
  }
});

test('a snapshot saved with a plain string label (an older build, or an auto snapshot named after an undo entry) reads as written', () => {
  assert.equal(TimeMachine.labelOf({ ts: 1, label: 'Manual · 10:15 AM' }), 'Manual · 10:15 AM');
  assert.equal(TimeMachine.labelOf({ ts: 1, label: 'Push 3 orders +1h', labelKey: undefined }), 'Push 3 orders +1h');
  assert.equal(TimeMachine.labelOf({ ts: 1 }), '', 'a record with neither is empty, never "undefined"');
  const db = TimeMachine._IntelDB;
  const prior = { put: db.putSnapshot, prune: db.pruneSnapshots, snaps: TimeMachine._snapshots };
  const saved = [];
  db.putSnapshot = (body, meta) => { saved.push(meta); return Promise.resolve(); };
  db.pruneSnapshots = () => {};
  try {
    withPlant('LBL-P2', [], () => {
      TimeMachine.snapshot('Move "A" to line 2');
      TimeMachine.snapshot('');
    });
    assert.equal(saved[0].label, 'Move "A" to line 2');
    assert.equal(saved[0].labelKey, undefined, 'a string label stores no key');
    assert.equal(saved[1].label, 'snap.default', 'an empty label falls back to the translated default (the key when no locale is loaded)');
  } finally { db.putSnapshot = prior.put; db.pruneSnapshots = prior.prune; TimeMachine._snapshots = prior.snaps; }
});

// ---- singular / plural key pairs ------------------------------------------------------------------------------------

test('Right Now cards pick the singular key for exactly one, the plural key for 0 and 2+', () => {
  const bank = NeedsEngine._buildBank();
  const label = (id, state) => bank.find(n => n.id === id).label(state);
  withLocale({
    'cmdp.need_conflict_jump': '{{count}} conflicts', 'cmdp.need_conflict_jump_one': '{{count}} conflict',
    'cmdp.need_unscheduled_review': '{{count}} orders open', 'cmdp.need_unscheduled_review_one': '{{count}} order open',
    'cmdp.need_blackout_risk': '{{count}} orders at risk', 'cmdp.need_blackout_risk_one': '{{count}} order at risk',
  }, () => {
    assert.equal(label('conflict-jump', { errCount: 1 }), '1 conflict');
    assert.equal(label('conflict-jump', { errCount: 2 }), '2 conflicts');
    assert.equal(label('conflict-jump', { errCount: 0 }), '0 conflicts');
    assert.equal(label('unscheduled-review', { unscheduledCount: 1 }), '1 order open');
    assert.equal(label('unscheduled-review', { unscheduledCount: 7 }), '7 orders open');
    assert.equal(label('blackout-risk', { blackoutRisk: 1 }), '1 order at risk');
    assert.equal(label('blackout-risk', { blackoutRisk: 3 }), '3 orders at risk');
  });
});

// ---- palette chrome -------------------------------------------------------------------------------------------------

test('palette section headings and type badges are translated and escaped', () => {
  const el = { innerHTML: '', querySelectorAll: () => [] };
  const priorGet = context.document.getElementById;
  const prior = { results: CommandPalette._results, last: CommandPalette._lastQuery, cursor: CommandPalette._cursor };
  context.document.getElementById = id => (id === 'ni-cp-results' ? el : null);
  try {
    withLocale({
      'ui.actions_section': 'Aktionen', 'ui.lines_section': 'Maschinen', 'ui.orders_section': 'Aufträge',
      'ui.right_now_section': 'Jetzt', 'cmdp.type_action': 'Aktion', 'cmdp.type_line': '<Maschine>', 'cmdp.type_order': 'Auftrag',
    }, () => {
      CommandPalette._lastQuery = '';
      CommandPalette._cursor = 0;
      CommandPalette._results = [
        { type: 'need', label: 'n', sub: 's', run() {} },
        { type: 'action', label: 'a', sub: 's', run() {} },
        { type: 'line', label: 'l', sub: 's', run() {} },
        { type: 'order', label: 'o', sub: 's', run() {} },
      ];
      CommandPalette._render();
    });
    const html = el.innerHTML;
    for (const text of ['>Jetzt<', '>Aktionen<', '>Maschinen<', '>Aufträge<']) assert.ok(html.includes(text), `heading ${text}`);
    assert.ok(html.includes('data-t="action">Aktion<'), 'singular badge text');
    assert.ok(html.includes('data-t="line">&lt;Maschine&gt;<'), 'badge text is escaped');
    assert.doesNotMatch(html, />(Actions|Lines|Orders|Right Now)</, 'no English heading left');
  } finally {
    context.document.getElementById = priorGet;
    Object.assign(CommandPalette, { _results: prior.results, _lastQuery: prior.last, _cursor: prior.cursor });
  }
});

test('the palette FAB carries its two tooltips as data attributes the CSS reads (no hardcoded content strings)', () => {
  assert.match(SOURCE, /content:attr\(data-label\)/);
  assert.match(SOURCE, /content:attr\(data-locked-label\)/);
  assert.doesNotMatch(SOURCE, /content:'(ctrl \+ k|Select a plant to unlock)'/);
});

test('Diff results use translated headings, stat labels and the Was/Now line, escaped', () => {
  withLocale({
    'ui.diff_rescheduled': 'Neu <geplant>', 'ui.diff_added': 'Hinzugefügt (Plan)', 'ui.diff_added_short': 'Neu',
    'ui.diff_removed': 'Entfernt (Plan)', 'ui.diff_removed_short': 'Weg',
    'ui.diff_was': 'War: {{date}} → Jetzt: {{date2}}', 'ui.diff_n_moved': '{{count}} verschoben', 'ui.diff_n_added': '{{count}} neu',
    'ui.diff_no_changes': 'Keine Unterschiede',
  }, () => {
    const day = n => new Date(2031, 2, 3 + n, 8).getTime();
    const mk = (id, s, e, m) => ({ id, start_date: s, end_date: e, MACHINE: m, PRODUCTION_ORDER: id, text: id });
    const d = Diff.compute([mk('a', day(0), day(0) + 3600000, 'L1'), mk('gone', day(0), day(0) + 3600000, 'L1')],
      [mk('a', day(1), day(1) + 3600000, 'L1'), mk('new', day(0), day(0) + 3600000, 'L2')]);
    const html = Diff._renderResults(d);
    assert.ok(html.includes('Neu &lt;geplant&gt;'), 'section heading and stat label, escaped');
    assert.ok(html.includes('Hinzugefügt (Plan)') && html.includes('Entfernt (Plan)'));
    assert.ok(html.includes('>Neu<') && html.includes('>Weg<'), 'short stat labels');
    assert.ok(html.includes('+ Neu') && html.includes('− Weg'), 'row badges');
    assert.match(html, /War: .* → Jetzt: /);
    assert.ok(html.includes('1 verschoben'), 'per-machine summary');
    assert.doesNotMatch(html, /Was:|Now:|Rescheduled|Added to schedule/, 'no English left');
    const empty = Diff._renderResults(Diff.compute([], []));
    assert.ok(empty.includes('Keine Unterschiede'));
    assert.equal(Object.hasOwn(d, 'summary'), false, 'the unused summary string is gone');
  });
});

// ---- relative time --------------------------------------------------------------------------------------------------

test('TimeMachine._relTime buckets: just now, minutes, hours (+ minutes), then a date; all through translated keys', () => {
  withLocale({
    'ui.just_now': 'gerade eben', 'ui.mins_ago': 'vor {{n}} Min.', 'ui.hours_ago': 'vor {{n}} Std.', 'ui.hours_mins_ago': 'vor {{h}} Std. {{m}} Min.',
  }, () => {
    const ago = ms => TimeMachine._relTime(Date.now() - ms - 1000);
    assert.equal(ago(10000), 'gerade eben');
    assert.equal(ago(5 * 60000), 'vor 5 Min.');
    assert.equal(ago(120 * 60000), 'vor 2 Std.');
    assert.equal(ago(125 * 60000), 'vor 2 Std. 5 Min.');
    const old = Date.now() - 30 * 3600000;
    assert.equal(TimeMachine._relTime(old), Util.fmtDTShortPref(old), 'a day or more is a date, not a relative label');
  });
});

// ---- confidence bands -----------------------------------------------------------------------------------------------

test('Confidence.band is the one cut-off set: 80+ good, 50-79 risk, below 50 critical; badge text and ring follow it', () => {
  assert.deepEqual([100, 80, 79, 50, 49, 0].map(s => Confidence.band(s)), ['good', 'good', 'risk', 'risk', 'critical', 'critical']);
  const scoreEl = { textContent: '', style: {} };
  const ring = { style: { props: {}, setProperty(k, v) { this.props[k] = v; } } };
  const priorGet = context.document.getElementById, saved = Confidence.snapshot();
  context.document.getElementById = id => (id === 'ni-conf-score' ? scoreEl : id === 'ni-conf-ring' ? ring : null);
  try {
    const colors = {};
    for (const s of [90, 80, 79, 50, 49]) {
      Confidence._apply(s);
      colors[s] = [scoreEl.style.color, ring.style.props['--conf-color']];
    }
    assert.deepEqual(colors[90], ['#4dbd7a', '#4ddb9f']);
    assert.deepEqual(colors[80], colors[90]);
    assert.deepEqual(colors[79], ['#e0a018', '#f0c04a']);
    assert.deepEqual(colors[50], colors[79]);
    assert.deepEqual(colors[49], ['#e88f83', '#f08a6a']);
  } finally { context.document.getElementById = priorGet; Confidence.restore(saved); }
});

// ---- palette search: same order as the old map/filter/sort ----------------------------------------------------------

test('palette search returns exactly what the old map + filter + stable sort + slice(9) returned (ties included)', () => {
  const fz = (q, text) => {
    const qt = q.toLowerCase(), tt = text.toLowerCase();
    if (tt.startsWith(qt)) return 3;
    if (tt.includes(qt)) return 2;
    let qi = 0;
    for (let i = 0; i < tt.length && qi < qt.length; i++) if (tt[i] === qt[qi]) qi++;
    return qi === qt.length ? 1 : 0;
  };
  const typeOrder = { selection: 0, action: 1, line: 2, order: 3 };
  const reference = (index, q) => index
    .map(item => ({ item, score: Math.max(fz(q, item.label), Math.floor(fz(q, item.sub || '') * 0.8)) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || (typeOrder[a.item.type] ?? 9) - (typeOrder[b.item.type] ?? 9))
    .slice(0, 9).map(x => x.item);
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = ['Aa', 'ab', 'BA', 'abc', 'x', 'Bab', 'cab', 'zz'];
  const types = ['selection', 'action', 'line', 'order', 'mystery'];
  const phrase = () => Array.from({ length: 1 + rnd(3) }, () => words[rnd(words.length)]).join(' ');
  const index = Array.from({ length: 400 }, (_, i) => ({ id: i, type: types[rnd(types.length)], label: phrase(), sub: rnd(3) ? phrase() : '' }));
  // Half the rows carry the lower-cased text the real index precomputes, half do not (tests and old callers).
  index.forEach((row, i) => { if (i % 2) { row.labelLc = row.label.toLowerCase(); row.subLc = row.sub.toLowerCase(); } });
  const prior = { index: CommandPalette._index, results: CommandPalette._results };
  try {
    CommandPalette._index = index;
    for (const q of ['a', 'ab', 'ba', 'abc', 'zz', 'b', 'cab x', 'qq', 'AB']) {
      CommandPalette._search(q);
      assert.deepEqual(Array.from(CommandPalette._results, r => r.id), reference(index, q).map(r => r.id), `query "${q}"`);
    }
    CommandPalette._index = [];
    CommandPalette._search('a');
    assert.equal(CommandPalette._results.length, 0);
  } finally { Object.assign(CommandPalette, { _index: prior.index, _results: prior.results }); }
});

test('the built index stores each row\'s lower-cased label and sub once', () => {
  const prior = CommandPalette._index;
  withPlant('IDX-P', [{ id: 'i1', PLANT: 'IDX-P', MACHINE: 'Line-A', COLOR: 'Red', text: 'Mixed CASE Name', PRODUCTION_ORDER: 'PO-1' }], () => {
    CommandPalette._index = null;
    CommandPalette._buildIndex();
    assert.ok(CommandPalette._index.length > 5);
    for (const row of CommandPalette._index) {
      assert.equal(row.labelLc, String(row.label).toLowerCase());
      assert.equal(row.subLc, String(row.sub || '').toLowerCase());
    }
  });
  CommandPalette._index = prior;
});

test('arrow keys toggle the active row instead of re-rendering the list; a mismatched DOM falls back to a render', () => {
  const mkRow = () => ({ calls: [], classList: { add(c) { this.owner.calls.push(`+${c}`); }, remove(c) { this.owner.calls.push(`-${c}`); } }, scrollIntoView() { this.calls.push('scroll'); } });
  const rows = [mkRow(), mkRow(), mkRow()];
  rows.forEach(r => { r.classList.owner = r; });
  const list = { querySelectorAll: () => rows };
  const priorGet = context.document.getElementById, priorRender = CommandPalette._render;
  const prior = { results: CommandPalette._results, cursor: CommandPalette._cursor };
  let renders = 0;
  context.document.getElementById = id => (id === 'ni-cp-results' ? list : null);
  CommandPalette._render = () => { renders++; };
  try {
    CommandPalette._results = [{}, {}, {}];
    CommandPalette._cursor = 0;
    CommandPalette._move(1);
    assert.equal(CommandPalette._cursor, 1);
    assert.deepEqual(rows[0].calls, ['-active']);
    assert.deepEqual(rows[1].calls, ['+active', 'scroll']);
    assert.equal(renders, 0, 'no full render for an arrow key');
    CommandPalette._move(9);
    assert.equal(CommandPalette._cursor, 2, 'clamped at the last row');
    CommandPalette._move(-9);
    assert.equal(CommandPalette._cursor, 0, 'clamped at the first row');
    CommandPalette._results = [{}, {}];   // the list on screen no longer matches
    CommandPalette._move(1);
    assert.equal(renders, 1, 'falls back to a render');
  } finally {
    context.document.getElementById = priorGet; CommandPalette._render = priorRender;
    Object.assign(CommandPalette, { _results: prior.results, _cursor: prior.cursor });
  }
});

test('an order row goes to the Gantt, then opens and focuses the order after the rebuild delay (one shared helper)', async () => {
  const log = [];
  const priorApp = nimbus.App.gotoGanttTimeline, priorInspector = nimbus.Inspector, priorFocus = nimbus.Timeline.focus, priorClose = CommandPalette.close;
  const prior = CommandPalette._index;
  const priorTasks = structuredClone(Store.tasksArr), priorPlant = Store.selectedPlant;
  nimbus.App.gotoGanttTimeline = () => log.push('goto');
  nimbus.Inspector = { show: task => log.push(`inspect:${task.id}`) };
  nimbus.Timeline.focus = id => log.push(`focus:${id}`);
  CommandPalette.close = () => log.push('close');
  globalThis.NIMBUS = nimbus;
  try {
    Store.setTasks([{ id: 'g1', PLANT: 'GT-P', MACHINE: 'L1', text: 'Goto me' }], 'test');   // kept past the deferred focus below
    Store.setSelectedPlant('GT-P', 'test');
    CommandPalette._index = null;
    CommandPalette._buildIndex();
    CommandPalette._index.find(r => r.type === 'order' && r.id === 'g1').run();
    assert.deepEqual(log, ['close', 'goto'], 'navigation is immediate, focus is deferred');
    await wait(180);
    assert.deepEqual(log, ['close', 'goto', 'inspect:g1', 'focus:g1']);
  } finally {
    nimbus.App.gotoGanttTimeline = priorApp; nimbus.Inspector = priorInspector; nimbus.Timeline.focus = priorFocus;
    CommandPalette.close = priorClose; CommandPalette._index = prior;
    Store.setTasks(priorTasks, 'test'); Store.setSelectedPlant(priorPlant, 'test');
  }
});

// ---- Patterns / Ripple single-pass scans -----------------------------------------------------------------------------

test('Patterns predecessor by one scan equals the old filter + stable sort + findIndex (equal starts included); the write is debounced', async () => {
  const ls = context.localStorage;
  const priorSet = ls.setItem, priorPairs = Patterns._pairs;
  let writes = 0;
  ls.setItem = () => { writes++; };
  // Several orders per machine, many sharing a start time, listed out of start order.
  const starts = [5, 1, 3, 3, 9, 1, 5, 5, 2, 7];
  const hour = n => new Date(Date.UTC(2031, 2, 3, n));
  const tasks = starts.map((s, i) => ({ id: `p${i}`, PLANT: 'PT-P', MACHINE: i % 4 === 3 ? 'L2' : 'L1', COLOR: `c${i}`, RUN_TIME: 1, start_date: hour(s), end_date: hour(s + 1) }));
  const oldPrev = id => {
    const task = tasks.find(x => x.id === id);
    const sorted = tasks.filter(x => x.MACHINE === task.MACHINE && x.start_date).sort((a, b) => a.start_date - b.start_date);
    const idx = sorted.findIndex(x => x.id === id);
    return idx > 0 ? sorted[idx - 1] : null;
  };
  try {
    withPlant('PT-P', tasks, () => {
      Patterns.flush();
      writes = 0;
      const before = new Set(Object.keys(Patterns._pairs));
      const expected = new Set();
      for (const task of tasks) {
        const prev = oldPrev(task.id);
        if (prev) expected.add(`${Util.norm(prev.COLOR)}→${Util.norm(task.COLOR)}`);
        Patterns._observe(task.id);
      }
      const added = Object.keys(Patterns._pairs).filter(k => !before.has(k));
      assert.ok(expected.size >= 5, 'the fixture has real predecessors (starts are not all equal)');
      assert.deepEqual(added.sort(), [...expected].sort());
      assert.equal(writes, 0, 'no localStorage write per observation');
      Patterns.flush();
      assert.equal(writes, 1, 'one write when flushed');
    });
  } finally { ls.setItem = priorSet; Patterns._pairs = priorPairs; }
  await wait(450);   // a debounce timer left over must not fire after the stub is gone
});

test('RipplePreview draws ghosts for the five earliest downstream orders (ties in Store order), reading every rectangle before creating any ghost', () => {
  const startsS = [4, 2, 6, 6, 3, 9, 6, 7, 1, 8, 6];   // Store order; the hovered order is index 1 (start 2)
  const tasks = startsS.map((s, i) => ({ id: `r${i}`, PLANT: 'RP-P', MACHINE: i === 5 ? 'OTHER' : 'L1', text: `T${i}`, RUN_TIME: 1,
    start_date: new Date(Date.UTC(2031, 2, 3, s)), end_date: new Date(Date.UTC(2031, 2, 3, s + 1)) }));
  const events = [], titles = [];
  const priorQuery = context.document.querySelector, priorCreate = context.document.createElement, priorBody = context.document.body;
  context.document.querySelector = sel => { events.push('read'); return { getBoundingClientRect: () => ({ left: 1, top: 2, width: 10, height: 5 }) }; };
  context.document.createElement = () => { events.push('write'); const el = { style: {}, remove() {} }; titles.push(el); return el; };
  context.document.body = { appendChild() {} };
  RipplePreview._active = true;
  try {
    withLocale({ 'ui.ripple_downstream': 'Downstream: {{name}}' }, () => withPlant('RP-P', tasks, () => RipplePreview._show('r1')));
    // Downstream of r1 (start 2): r4(3) r0(4) r2(6) r3(6) r6(6) — then r10(6) is the sixth start-6 order and is cut; r5 is another machine.
    assert.deepEqual(titles.map(el => el.title), ['T4', 'T0', 'T2', 'T3', 'T6'].map(n => `Downstream: ${n}`));
    const firstWrite = events.indexOf('write');
    assert.ok(firstWrite > 0 && !events.slice(firstWrite).includes('read'), 'all layout reads come before the first DOM write');
    assert.equal(events.filter(e => e === 'read').length, 5);
  } finally {
    RipplePreview._active = false; RipplePreview._clearGhosts();
    context.document.querySelector = priorQuery; context.document.createElement = priorCreate; context.document.body = priorBody;
  }
});
