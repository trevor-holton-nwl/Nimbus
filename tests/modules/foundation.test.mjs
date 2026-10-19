import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, PerfMonitor, VirtualList, Toast, Modal } from '../../frontend/platform/foundation.mjs';

test('contrastText handles equivalent hex and RGB heatmap fills', async () => {
  const { Util } = await import('../../frontend/platform/foundation.mjs');
  for (const color of ['#f39c12', 'rgb(243, 156, 18)', 'rgb(243 156 18)']) {
    const foreground = Util.contrastText(color);
    assert.equal(foreground, '#0c1c30');
    assert.ok((Util.relativeLuminance(color) + .05) / (Util.relativeLuminance(foreground) + .05) >= 4.5);
  }
  assert.equal(Util.relativeLuminance('#fff'), 1);
});
import { Util, ErrorLog } from '../../frontend/platform/foundation.mjs';
import { createRequire as makeRequire } from 'node:module';

// Util.scheduleIntervals / sapDueDate delegate to the UMD compute core through this ambient global.
globalThis.NimbusComputeCore = makeRequire(import.meta.url)('../../frontend/nimbus-compute-core.js');

test('fmtHours carries rounded minutes into hours', () => {
  assert.equal(Util.fmtHours(1.999), '2h');
  assert.equal(Util.fmtHours(-1.999), '-2h');
});

/* Minimal fake DOM for Toast tests — Toast.show() only ever calls
   document.getElementById('toast-stack') and document.createElement(), and
   operates on elements via textContent/className/classList/appendChild/
   addEventListener, so a tiny stub is enough (no jsdom dependency needed). */
function _fakeElement(tag) {
  const el = {
    tagName: tag,
    className: '',
    textContent: '',
    type: '',
    children: [],
    parent: null,
    _listeners: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    appendChild(child) { child.parent = el; this.children.push(child); return child; },
    remove() { if (el.parent) { el.parent.children = el.parent.children.filter(c => c !== el); el.parent = null; } },
    addEventListener(evt, fn) { this._listeners[evt] = fn; },
    removeEventListener(evt, fn) { if (this._listeners[evt] === fn) delete this._listeners[evt]; },
    click() { const fn = this._listeners.click; if (fn) fn(); },
  };
  return el;
}
function _fakeDocument() {
  const stack = _fakeElement('div');
  return {
    _stack: stack,
    getElementById(id) { return id === 'toast-stack' ? stack : null; },
    createElement(tag) { return _fakeElement(tag); },
  };
}

test('Config exposes the documented constants', () => {
  assert.equal(Config.STEP_MS, 15 * 60 * 1000);
  assert.ok(Array.isArray(Config.COLORS));
  assert.equal(Config.COLORS.length, 10);
});

test('PerfMonitor records and reports timing stats', () => {
  PerfMonitor.clear();
  PerfMonitor.record('unit-test', 12);
  const stats = PerfMonitor.stats('unit-test');
  assert.equal(stats.count, 1);
  assert.equal(stats.last, 12);
});

test('PerfMonitor.stats returns null for an unknown name', () => {
  assert.equal(PerfMonitor.stats('does-not-exist'), null);
});

test('VirtualList exposes the documented instance methods', () => {
  assert.equal(typeof VirtualList, 'function');
  assert.equal(typeof VirtualList.prototype.update, 'function');
  assert.equal(typeof VirtualList.prototype.destroy, 'function');
});

test('Toast and Modal are present with their documented public methods', () => {
  assert.equal(typeof Toast.show, 'function');
  assert.equal(typeof Modal.open, 'function');
  assert.equal(typeof Modal.close, 'function');
  assert.equal(typeof Modal.confirm, 'function');
});

test('confirm backdrop cancels the active prompt and advances the queued prompt', async () => {
  const previousDocument = globalThis.document;
  const ids = ['confirm-modal', 'confirm-title', 'confirm-message', 'confirm-detail',
    'confirm-ok-btn', 'confirm-cancel-btn', 'confirm-close-btn'];
  const elements = Object.fromEntries(ids.map(id => [id, _fakeElement('div')]));
  const aria = {};
  elements['confirm-close-btn'].setAttribute = (k, v) => { aria[k] = v; };
  globalThis.document = { getElementById: id => elements[id] ?? null };
  const previousWindow = globalThis.window;
  globalThis.window = { __NIMBUS_LOCALES: { en: { 'btn.cancel': 'Cancel', 'btn.close': 'Close' }, de: { 'btn.cancel': 'Abbrechen', 'btn.close': 'Schließen' } } };
  Util.setLocale('de');
  try {
    const first = Modal.confirm({ message: 'First' });
    const second = Modal.confirm({ message: 'Second' });
    elements['confirm-modal']._listeners.click({ target: elements['confirm-modal'] });
    assert.equal(await first, false);
    // Track 9: the shared dialog localizes its fixed Cancel / Close controls on every open.
    assert.equal(elements['confirm-cancel-btn'].textContent, 'Abbrechen');
    assert.equal(aria['aria-label'], 'Schließen');
    assert.equal(elements['confirm-message'].textContent, 'Second');
    elements['confirm-ok-btn'].click();
    assert.equal(await second, true);
  } finally {
    globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    Util.setLocale('en');
  }
});

test('Toast.show without an action behaves exactly as before: textContent only, no button', () => {
  const doc = _fakeDocument();
  globalThis.document = doc;
  Toast.show('plain message', 'info', 20);
  assert.equal(doc._stack.children.length, 1);
  const el = doc._stack.children[0];
  assert.equal(el.textContent, 'plain message');
  assert.equal(el.className, 'toast info');
  assert.equal(el.children.length, 0, 'no .toast-action button when action is omitted');
});

test('Toast.show(msg, type, ms, action) appends a .toast-action button whose click calls run() and dismisses the toast', () => {
  const doc = _fakeDocument();
  globalThis.document = doc;
  let ran = false;
  Toast.show('do the thing', 'warn', 20, { label: 'Open X', run: () => { ran = true; } });
  const el = doc._stack.children[0];
  assert.equal(el.textContent, 'do the thing', 'message text is untouched by adding the button');
  assert.equal(el.children.length, 1);
  const btn = el.children[0];
  assert.equal(btn.className, 'toast-action');
  assert.equal(btn.textContent, 'Open X');

  btn.click();
  assert.equal(ran, true, 'clicking the action button calls run()');
  assert.equal(el.classList.contains('leaving'), true, 'clicking the action dismisses the toast the same way its timeout would');
});

// Dedupe stays keyed on (msg, type) only, same as before `action` existed
// (per aggregate_to_detail.md §8: "the (msg, type) dedupe unchanged"). An
// `action` is not part of the dedupe key — the latest Toast.show(...) call
// for an already-visible (msg, type) simply replaces whatever action the
// existing toast had, exactly like it already replaces the dismiss timer.
test('Toast.show dedupe: a repeat (msg, type) call reuses the existing element and its action label wins', () => {
  const doc = _fakeDocument();
  globalThis.document = doc;
  let firstRan = false;
  let secondRan = false;
  Toast.show('dup message', 'error', 20, { label: 'First', run: () => { firstRan = true; } });
  assert.equal(doc._stack.children.length, 1);
  const el = doc._stack.children[0];

  Toast.show('dup message', 'error', 20, { label: 'Second', run: () => { secondRan = true; } });
  assert.equal(doc._stack.children.length, 1, 'dedupe reuses the existing toast, does not stack a second one');
  assert.equal(el.children.length, 1, 'exactly one action button, not stacked');
  const btn = el.children[0];
  assert.equal(btn.textContent, 'Second', 'the latest call\'s action replaces the previous one');

  btn.click();
  assert.equal(firstRan, false, 'the stale first action must not still be wired');
  assert.equal(secondRan, true, 'the latest run() is the one that fires');
});

test('Toast.show dedupe: a later call with no action clears a previous one (latest call wins entirely)', () => {
  const doc = _fakeDocument();
  globalThis.document = doc;
  Toast.show('toggle action', 'success', 20, { label: 'Click me', run: () => {} });
  const el = doc._stack.children[0];
  assert.equal(el.children.length, 1);

  Toast.show('toggle action', 'success', 20); // no action this time
  assert.equal(el.children.length, 0, 'omitting the action on the latest call removes the existing button');
});

test('_fmtTime12 zero-pads the hour and maps midnight/noon', () => {
  assert.equal(Util._fmtTime12(new Date(2026, 0, 5, 0, 0)), '12:00 AM');
  assert.equal(Util._fmtTime12(new Date(2026, 0, 5, 12, 0)), '12:00 PM');
  assert.equal(Util._fmtTime12(new Date(2026, 0, 5, 13, 5)), '01:05 PM');
});

test('_fmtTimePref honors the 12h/24h pref; fmtBlockRange follows date+time prefs', () => {
  const d1 = new Date(2026, 4, 15, 6, 0), d2 = new Date(2026, 4, 15, 19, 30), d3 = new Date(2026, 4, 17, 6, 0);
  try {
    Util.setPreferenceResolver(() => undefined);
    assert.equal(Util._fmtTimePref(d2), '07:30 PM');
    assert.equal(Util.fmtBlockRange(d1, d2), '05/15/2026 · 06:00 AM – 07:30 PM');
    assert.equal(Util.fmtBlockRange(d1, d3), '05/15/2026 06:00 AM → 05/17/2026 06:00 AM');
    Util.setPreferenceResolver(key => ({ timeFormat: '24h' }[key]));
    assert.equal(Util._fmtTimePref(d2), '19:30');
    assert.equal(Util.fmtBlockRange(d1, d2), '05/15/2026 · 06:00 – 19:30');
    assert.equal(Util.fmtBlockRange(d1, d3), '05/15/2026 06:00 → 05/17/2026 06:00');
  } finally {
    Util.setPreferenceResolver(() => undefined);
  }
});

test('Util.setPreferenceResolver changes what _timeFormatPref/_dateFormatPref read', () => {
  Util.setPreferenceResolver(key => ({ timeFormat: '24h', dateFormat: 'd/m/Y' }[key]));
  assert.equal(Util._timeFormatPref(), '24h');
  assert.equal(Util._dateFormatPref(), 'd/m/Y');
  Util.setPreferenceResolver(() => undefined); // reset
  assert.equal(Util._timeFormatPref(), '12h'); // documented fallback
});

test('Util.setApiKey makes fetchTraced attach X-API-Key; unset attaches nothing', async () => {
  const origFetch = globalThis.fetch;
  let seenHeaders;
  globalThis.fetch = (url, opts) => {
    seenHeaders = opts.headers;
    return Promise.resolve({ ok: true, status: 200, clone: () => ({}) });
  };
  try {
    Util.setApiKey('');
    await Util.fetchTraced('/tasks');
    assert.equal(seenHeaders.has('x-api-key'), false);

    Util.setApiKey('required-key');
    await Util.fetchTraced('/tasks');
    assert.equal(seenHeaders.get('x-api-key'), 'required-key');
  } finally {
    globalThis.fetch = origFetch;
    Util.setApiKey(''); // reset
  }
});

test('Util.setLocale/locale round-trip and t() reads the active locale', () => {
  const prevLocale = Util.locale();
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: { 'greet.hi': 'Hi' }, fr: { 'greet.hi': 'Salut' } };
  Util.setLocale('fr');
  assert.equal(Util.locale(), 'fr');
  assert.equal(Util.t('greet.hi'), 'Salut');
  Util.setLocale(prevLocale);
});

test('ErrorLog.setAdminGate/setBadgeClickHandler are settable and default to safe no-ops', () => {
  assert.equal(typeof ErrorLog.setAdminGate, 'function');
  assert.equal(typeof ErrorLog.setBadgeClickHandler, 'function');
  assert.equal(typeof ErrorLog.renderBadge, 'function');
});

test('ErrorLog.info/warn/error record entries readable via entries()', () => {
  ErrorLog.clear();
  ErrorLog.warn('unit-test', 'hello', { x: 1 });
  const entries = ErrorLog.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'warn');
  assert.equal(entries[0].scope, 'unit-test');
});

test('ErrorLog.setPlantResolver feeds _plant() and enriches new log entries with plant', () => {
  ErrorLog.clear();
  ErrorLog.setPlantResolver(() => '5512');
  assert.equal(ErrorLog._plant(), '5512');
  ErrorLog.warn('unit-test', 'plant-scoped');
  const entries = ErrorLog.entries();
  assert.equal(entries[entries.length - 1].plant, '5512');
  ErrorLog.setPlantResolver(() => null); // reset
});

test('ErrorLog._plant() defaults to null and swallows a throwing resolver', () => {
  assert.equal(ErrorLog._plant(), null); // default resolver, never set
  ErrorLog.setPlantResolver(() => { throw new Error('boom'); });
  assert.equal(ErrorLog._plant(), null); // throwing resolver caught, not propagated
  ErrorLog.setPlantResolver(() => null); // reset
});

test('ErrorLog.setRouteResolver feeds _route() (tab/ganttSub) and enriches log entries with route', () => {
  ErrorLog.clear();
  ErrorLog.setRouteResolver(() => ({ tab: 'gantt', ganttSub: 'timeline' }));
  assert.equal(ErrorLog._route(), 'gantt/timeline');
  ErrorLog.warn('unit-test', 'route-scoped');
  const entries = ErrorLog.entries();
  assert.equal(entries[entries.length - 1].route, 'gantt/timeline');
  ErrorLog.setRouteResolver(() => null); // reset
});

test('Util.hoursToTimeString/timeStringToHours round-trip', () => {
  assert.equal(Util.hoursToTimeString(13.5), '13:30');
  assert.equal(Util.timeStringToHours('13:30'), 13.5);
});

/* Final-review fix wave (2026-08-11): countChangeovers was hardcoded to
   COLOR/FORM_SIZE, which made the Optimizer Preview's changeover KPI — the
   number a planner reads to decide Apply vs Discard — blind to the three fields
   Stage 3 wired into the optimizer. It now resolves its field set through an
   injected seam (Engine.changeoverTaskFields; Util is Foundation and may not
   import Engine). */

test('Util.changeoverFields defaults to COLOR+FORM_SIZE, and survives a bad/throwing resolver', () => {
  Util.setChangeoverFieldsResolver(null);
  assert.deepEqual(Util.changeoverFields(), ['COLOR', 'FORM_SIZE'], 'unwired = historical behavior');
  Util.setChangeoverFieldsResolver(() => []);
  assert.deepEqual(Util.changeoverFields(), ['COLOR', 'FORM_SIZE'], 'an empty list must not disable changeover counting entirely');
  Util.setChangeoverFieldsResolver(() => { throw new Error('boom'); });
  assert.deepEqual(Util.changeoverFields(), ['COLOR', 'FORM_SIZE'], 'a throwing resolver is caught, not propagated');
  Util.setChangeoverFieldsResolver(null); // reset
});

test('Util.countChangeovers counts on the resolved field set, not a hardcoded COLOR/FORM_SIZE pair', () => {
  // Same COLOR and FORM_SIZE throughout, differing only in PRT_01: the old
  // implementation reported 0 for this line no matter what the plant sequences on.
  const tasks = [
    { id: 'a', MACHINE: 'L1', start_date: new Date('2026-08-11T06:00:00'), COLOR: 'RED', FORM_SIZE: 'MD', PRT_01: 'DOG' },
    { id: 'b', MACHINE: 'L1', start_date: new Date('2026-08-11T08:00:00'), COLOR: 'RED', FORM_SIZE: 'MD', PRT_01: 'CAT' },
    { id: 'c', MACHINE: 'L1', start_date: new Date('2026-08-11T10:00:00'), COLOR: 'RED', FORM_SIZE: 'MD', PRT_01: 'CAT' },
  ];
  Util.setChangeoverFieldsResolver(null);
  assert.equal(Util.countChangeovers(tasks), 0, 'baseline: invisible to a COLOR/FORM_SIZE-only count');
  Util.setChangeoverFieldsResolver(() => ['PRT_01', 'FORM_SIZE']);
  assert.equal(Util.countChangeovers(tasks), 1, 'DOG->CAT is one changeover; CAT->CAT is none');
  Util.setChangeoverFieldsResolver(null); // reset
});

test('Util.countChangeovers: ANY differing active field is ONE changeover, and blanks stay equal', () => {
  Util.setChangeoverFieldsResolver(() => ['COLOR', 'PRT_01', 'FORM_SIZE']);
  // Both COLOR and PRT_01 change between a and b — one physical changeover, not two.
  assert.equal(Util.countChangeovers([
    { id: 'a', MACHINE: 'L1', start_date: new Date('2026-08-11T06:00:00'), COLOR: 'RED',  FORM_SIZE: 'MD', PRT_01: 'DOG' },
    { id: 'b', MACHINE: 'L1', start_date: new Date('2026-08-11T08:00:00'), COLOR: 'BLUE', FORM_SIZE: 'MD', PRT_01: 'CAT' },
  ]), 1);
  // Absent vs null vs '' must all read as the same blank (the `|| ''` coercion the
  // hardcoded comparison used), or every order missing a value would look like a
  // changeover on a plant that has not populated that field yet.
  assert.equal(Util.countChangeovers([
    { id: 'a', MACHINE: 'L1', start_date: new Date('2026-08-11T06:00:00'), COLOR: 'RED', FORM_SIZE: 'MD' },
    { id: 'b', MACHINE: 'L1', start_date: new Date('2026-08-11T08:00:00'), COLOR: 'RED', FORM_SIZE: 'MD', PRT_01: null },
    { id: 'c', MACHINE: 'L1', start_date: new Date('2026-08-11T10:00:00'), COLOR: 'RED', FORM_SIZE: 'MD', PRT_01: '' },
  ]), 0);
  // Lines are counted independently (regression guard on the existing grouping).
  assert.equal(Util.countChangeovers([
    { id: 'a', MACHINE: 'L1', start_date: new Date('2026-08-11T06:00:00'), COLOR: 'RED',  FORM_SIZE: 'MD', PRT_01: 'DOG' },
    { id: 'b', MACHINE: 'L2', start_date: new Date('2026-08-11T08:00:00'), COLOR: 'BLUE', FORM_SIZE: 'MD', PRT_01: 'CAT' },
  ]), 0, 'adjacency is per line, so two orders on different lines are never a changeover');
  Util.setChangeoverFieldsResolver(null); // reset
});

test('ErrorLog._route() falls back to the bare tab without a ganttSub, and to null with no resolver/data', () => {
  assert.equal(ErrorLog._route(), null); // default resolver, never set
  ErrorLog.setRouteResolver(() => ({ tab: 'dashboard' }));
  assert.equal(ErrorLog._route(), 'dashboard');
  ErrorLog.setRouteResolver(() => null);
  assert.equal(ErrorLog._route(), null);
  ErrorLog.setRouteResolver(() => { throw new Error('boom'); });
  assert.equal(ErrorLog._route(), null); // throwing resolver caught, not propagated
  ErrorLog.setRouteResolver(() => null); // reset
});

// Distribution (aggregate_to_detail.md §8 "Paste and selection"): pasting or
// searching a parent SAP order number must select every sub-order, not just
// an exact PRODUCTION_ORDER/MATERIAL_NUMBER match.
test('Util.taskMatchesPasteSet also matches a task\'s PARENT_ORDER, so pasting the parent selects every sub-order', () => {
  const idSet = new Set(['1000']);
  assert.equal(Util.taskMatchesPasteSet({ PRODUCTION_ORDER: 'A-1000', PARENT_ORDER: '1000' }, idSet), true);
  assert.equal(Util.taskMatchesPasteSet({ PRODUCTION_ORDER: 'B-1000', PARENT_ORDER: '1000' }, idSet), true);
  assert.equal(Util.taskMatchesPasteSet({ PRODUCTION_ORDER: 'C-2000', PARENT_ORDER: '2000' }, idSet), false);
  // A task with no PARENT_ORDER still relies only on the existing ORDER/MATERIAL_NUMBER match.
  assert.equal(Util.taskMatchesPasteSet({ PRODUCTION_ORDER: '1000' }, idSet), true);
  assert.equal(Util.taskMatchesPasteSet({ PRODUCTION_ORDER: '3000' }, idSet), false);
});

test('Util.csvGuardText prefixes only text cells that start with = + - @ (never numbers)', () => {
  assert.equal(Util.csvGuardText('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(Util.csvGuardText('+cmd|x'), "'+cmd|x");
  assert.equal(Util.csvGuardText('-1+1'), "'-1+1");
  assert.equal(Util.csvGuardText('@A1'), "'@A1");
  assert.equal(Util.csvGuardText('\tx'), "'\tx");
  assert.equal(Util.csvGuardText('plain'), 'plain');
  // real numbers and numeric-looking strings stay numbers
  assert.equal(Util.csvGuardText(-5), -5);
  assert.equal(Util.csvGuardText('-5'), '-5');
  assert.equal(Util.csvGuardText('+3.25'), '+3.25');
  assert.equal(Util.csvGuardText('-1,234.5'), '-1,234.5');
  assert.equal(Util.csvGuardText(null), null);
});

test('Util.csvCell is RFC-4180 quoted and formula-guarded', () => {
  assert.equal(Util.csvCell('a,b'), '"a,b"');
  assert.equal(Util.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(Util.csvCell('l1\nl2'), '"l1\nl2"');
  assert.equal(Util.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(Util.csvCell(-5), '-5');
  assert.equal(Util.csvCell(null), '');
});

test('Util.csvProcessCell applies the column formatter, then the formula guard', () => {
  const fmt = v => (v === 7 ? '=7' : v);
  assert.equal(Util.csvProcessCell({ value: 7, formatValue: fmt }), "'=7");
  assert.equal(Util.csvProcessCell({ value: -5, formatValue: v => v }), -5);
  assert.equal(Util.csvProcessCell({ value: '@x' }), "'@x");
});

test('#30 Util.errorDetailText flattens FastAPI 422 lists and structured details to readable text (never [object Object])', () => {
  assert.equal(Util.errorDetailText('plain'), 'plain');
  assert.equal(Util.errorDetailText(null), null);
  assert.equal(
    Util.errorDetailText([{ loc: ['body', 'RUN_TIME'], msg: 'must be positive', type: 'value_error' }, { loc: ['query', 'plant'], msg: 'field required' }]),
    'RUN_TIME: must be positive; plant: field required');
  assert.equal(Util.errorDetailText({ message: 'Stale row', code: 'x' }), 'Stale row');
  assert.ok(!/\[object Object\]/.test(Util.errorDetailText({ a: 1 })));
});

test('#30 parseBackendError keeps the status and text for 422 list and 409 object details', async () => {
  const mk = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const p422 = await Util.parseBackendError(mk(422, { detail: [{ loc: ['body', 'qty'], msg: 'bad number' }] }));
  assert.equal(p422.status, 422);
  assert.equal(p422.message, 'qty: bad number');
  const p409 = await Util.parseBackendError(mk(409, { detail: { message: 'Version conflict', error_code: 'x' } }));
  assert.equal(p409.status, 409);
  assert.equal(p409.message, 'Version conflict');
});

test('#30 Toast defaults: errors and warnings stay longer than 1.5 s; explicit durations still win', () => {
  const doc = _fakeDocument();
  globalThis.document = doc;
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0); };
  try {
    Toast.show('e-default', 'error');
    Toast.show('w-default', 'warn');
    Toast.show('i-default', 'info');
    Toast.show('e-explicit', 'error', 20);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.deepEqual(delays.filter(d => d !== Config.ANIM_MS), [6000, 4000, 1500, 20]);
});

test('#33 matchPasteToCheckboxes with onBatch hands every newly matched box over once and fires no per-box events', () => {
  const mk = value => ({ value, checked: false, events: 0, dispatchEvent() { this.events++; } });
  const boxes = ['L1', 'L2', 'L3', 'L4'].map(mk);
  boxes[1].checked = true; // already selected
  const batches = [];
  const res = Util.matchPasteToCheckboxes('l1\nL2\nL3\nNOPE', boxes, b => batches.push(b.map(x => x.value)));
  assert.deepEqual(batches, [['L1', 'L3']], 'one callback carrying all N newly matched boxes');
  assert.deepEqual(res, { matched: 3, total: 4 });
  assert.ok(boxes.every(b => b.events === 0), 'no per-box change events (each would rebuild the checklist and detach the rest)');
});

test('Modal.open applies dialog semantics, moves focus in, and Modal.close restores the opener (#49)', async () => {
  const previousDocument = globalThis.document;
  const attrs = {};
  const opener = { focus() { opener.focused = true; }, isConnected: true };
  const cancel = { focus() { cancel.focused = true; } };
  const heading = { id: '' };
  const dlg = {
    getAttribute: k => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; },
    querySelector: sel => (sel.includes('.modal-head') ? heading : null),
    querySelectorAll: () => [], contains: () => false,
  };
  const backdrop = {
    hidden: true,
    querySelector: sel => (sel === '.modal' ? dlg : null),
    contains: () => false, addEventListener() {},
  };
  globalThis.document = {
    activeElement: opener, body: {},
    getElementById: id => (id === 'confirm-modal' ? backdrop : id === 'confirm-cancel-btn' ? cancel : null),
    addEventListener() {},
  };
  try {
    Modal.open('confirm-modal');
    assert.equal(backdrop.hidden, false);
    assert.equal(attrs.role, 'dialog');
    assert.equal(attrs['aria-modal'], 'true');
    assert.equal(attrs['aria-labelledby'], 'confirm-modal-title');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(cancel.focused, true, 'a confirm focuses Cancel, never the destructive action');
    Modal.close('confirm-modal');
    assert.equal(backdrop.hidden, true);
    assert.equal(opener.focused, true, 'focus returns to the element that opened the dialog');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('every Store.selectedLines picker applies a multi-line paste in one setSelectedLines call (#33 follow-up)', async () => {
  const { readFileSync } = await import('node:fs');
  const picks = [
    ['scheduling/orders.mts', 'tbl-flt-line-checklist'],
    ['labor/labor-planning.mts', 'lp-line-checklist'],
    ['master-data/admin-ui.mts', 'lines-nav-checklist'],
    ['shell/application-shell.mts', 'context-lines-checklist'],
  ];
  for (const [file, id] of picks) {
    const source = readFileSync(new URL(`../../frontend/${file}`, import.meta.url), 'utf8');
    const at = source.indexOf(`getElementById('${id}')?.querySelectorAll`);
    assert.ok(at > 0, `${file}: ${id} paste wiring found`);
    assert.match(source.slice(at, at + 400), /boxes => Store\.setSelectedLines\(new Set\(\[\.\.\.Store\.selectedLines/, `${file} passes an onBatch`);
  }
});

test('errorDetailText: empty scalars/objects fall back, {code} and {error:{message}} are readable, long 422 lists are truncated (senior audit)', () => {
  for (const empty of [undefined, null, '', 0, false, {}, []]) assert.equal(Util.errorDetailText(empty), null, JSON.stringify(empty));
  assert.equal(Util.errorDetailText({ code: 'E_LOCKED' }), 'E_LOCKED');
  assert.equal(Util.errorDetailText({ error_code: 'LOCKED', status: 'x' }), 'LOCKED');
  assert.equal(Util.errorDetailText({ error: { message: 'deep' } }), 'deep');
  const many = Array.from({ length: 150 }, (_, i) => ({ loc: ['body', `f${i}`], msg: `bad ${i}` }));
  const text = Util.errorDetailText(many);
  assert.ok(text.length < 200, `truncated, got ${text.length} chars`);
  assert.match(text, /f0: bad 0/);
  assert.match(text, /\(\+145\)/);
  const loop = {}; loop.message = loop;
  assert.equal(Util.errorDetailText(loop), null, 'self-referential payload cannot overflow the stack');
  // callers do: errorDetailText(x) || 'HTTP ' + status
  assert.equal(Util.errorDetailText({}) || 'HTTP 500', 'HTTP 500');
  assert.equal(Util.errorDetailText(0) || 'HTTP 500', 'HTTP 500');
});

test('Toast action is one-shot (double-click) and a throwing action still dismisses the toast', () => {
  const doc = _fakeDocument();
  globalThis.document = doc;
  let runs = 0;
  Toast.show('one shot', 'warn', 20, { label: 'Go', run: () => { runs++; } });
  const el = doc._stack.children[0];
  el.children[0].click(); el.children[0].click();
  assert.equal(runs, 1, 'a second click must not re-run the action');

  Toast.show('throws', 'warn', 20, { label: 'Boom', run: () => { throw new Error('x'); } });
  const el2 = doc._stack.children.find(c => c.textContent === 'throws');
  assert.throws(() => el2.children[0].click(), /x/);
  assert.equal(el2.classList.contains('leaving'), true, 'finally dismisses even when run() throws');
});

test('Modal: Tab stays trapped (including focus on <body> and dialogs with no focusables) and Escape cancels a confirm', async (tctx) => {
  tctx.mock.timers.enable({ apis: ['setTimeout'] }); // virtual clock for Modal.open's deferred focus
  const prevDoc = globalThis.document;
  const byId = {};
  let root;
  class El {
    constructor(tag, o = {}) {
      this.tag = tag; this.id = o.id || ''; this.cls = new Set((o.cls || '').split(' ').filter(Boolean)); this.children = []; this.parent = null;
      this.hidden = !!o.hidden; this.disabled = false; this.attrs = {}; this.L = {}; this.textContent = ''; this.type = ''; this.style = {};
      if (this.id) byId[this.id] = this;
    }
    get isConnected() { let e = this; while (e) { if (e === root) return true; e = e.parent; } return false; }
    add(c) { c.parent = this; this.children.push(c); return c; }
    appendChild(c) { return this.add(c); }
    get classList() { const s = this; return { add: c => s.cls.add(c), remove: c => s.cls.delete(c), contains: c => s.cls.has(c) }; }
    desc() { return this.children.flatMap(c => [c, ...c.desc()]); }
    contains(n) { return n === this || this.desc().includes(n); }
    closest(sel) { let e = this; while (e) { if (sel === '[hidden]' && e.hidden) return e; e = e.parent; } return null; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    matches(sel) {
      const f = ['a', 'button', 'input', 'select', 'textarea'].includes(this.tag) && !this.disabled && this.attrs.tabindex !== '-1';
      if (sel.startsWith('a[href]')) return f;
      if (sel === '.modal') return this.cls.has('modal');
      return false;
    }
    querySelector(s) { return this.desc().find(e => e.matches(s)) || null; }
    querySelectorAll(s) { return this.desc().filter(e => e.matches(s)); }
    addEventListener(t, f) { (this.L[t] ||= []).push(f); }
    removeEventListener(t, f) { this.L[t] = (this.L[t] || []).filter(x => x !== f); }
    focus() { if (!this.isConnected || this.hidden || this.closest('[hidden]')) return; globalThis.document.activeElement = this; }
    click() { for (const f of [...(this.L.click || [])]) f({ target: this }); }
  }
  root = new El('body');
  const docL = {};
  globalThis.document = {
    activeElement: root, body: root, getElementById: id => byId[id] || null, createElement: t => new El(t),
    addEventListener(t, f) { (docL[t] ||= []).push(f); },
  };
  const key = (target, k, shiftKey = false) => {
    const e = { key: k, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const f of docL.keydown || []) f(e);
    if (e.stopped) return e;
    for (let n = target; n; n = n.parent) for (const f of n.L.keydown || []) f(e);
    return e;
  };
  const mk = (id, nButtons) => {
    const bd = root.add(new El('div', { id, cls: 'modal-backdrop', hidden: true }));
    const m = bd.add(new El('div', { cls: 'modal' }));
    const btns = Array.from({ length: nButtons }, (_, i) => m.add(new El('button', { id: `${id}-b${i}` })));
    return { bd, m, btns };
  };
  const sleep = async ms => { tctx.mock.timers.tick(ms); }; // deferred-focus timer fires on the virtual clock
  try {
    const A = mk('tabA', 2);
    Modal.open('tabA'); await sleep(5);
    assert.equal(globalThis.document.activeElement, A.btns[0], 'focus moves into the dialog');
    A.btns[1].focus();
    assert.equal(key(A.btns[1], 'Tab').prevented, true, 'Tab on the last control wraps');
    assert.equal(globalThis.document.activeElement, A.btns[0]);
    assert.equal(key(A.btns[0], 'Tab', true).prevented, true, 'Shift+Tab on the first control wraps');
    assert.equal(globalThis.document.activeElement, A.btns[1]);

    globalThis.document.activeElement = root; // a click on the backdrop left focus on <body>
    assert.equal(key(root, 'Tab').prevented, true, 'Tab from <body> is pulled back into the open dialog');
    assert.ok(A.m.contains(globalThis.document.activeElement));
    A.btns[0].getClientRects = () => [];
    A.btns[1].getClientRects = () => [{}];
    globalThis.document.activeElement = root;
    key(root, 'Tab');
    assert.equal(globalThis.document.activeElement, A.btns[1], 'CSS-hidden controls are skipped');
    Modal.close('tabA');
    globalThis.document.activeElement = root;
    assert.equal(key(root, 'Tab').prevented, false, 'no trap once the dialog is closed');

    const E = mk('tabEmpty', 0); // nothing focusable inside
    Modal.open('tabEmpty'); await sleep(5);
    globalThis.document.activeElement = root;
    assert.equal(key(root, 'Tab').prevented, true);
    assert.equal(globalThis.document.activeElement, E.m, 'the dialog container itself takes focus');
    assert.equal(E.m.attrs.tabindex, '-1');
    Modal.close('tabEmpty');

    // Escape cancels an open confirm dialog.
    const C = mk('confirm-modal', 0);
    const cancel = C.m.add(new El('button', { id: 'confirm-cancel-btn' }));
    let cancelled = 0;
    cancel.addEventListener('click', () => { cancelled++; });
    Modal.open('confirm-modal'); await sleep(5);
    const esc = key(cancel, 'Escape');
    assert.equal(esc.prevented, true);
    assert.equal(cancelled, 1, 'Escape clicks Cancel');
    Modal.close('confirm-modal');
    assert.equal(key(root, 'Escape').prevented, false, 'Escape is ignored when no confirm is open');
  } finally {
    globalThis.document = prevDoc;
  }
});

test('sapDueDate reads a date-only (exact-midnight) due date as the end of that date\'s working window', async () => {
  const { createRequire } = await import('node:module');
  const prevCore = globalThis.NimbusComputeCore;
  globalThis.NimbusComputeCore = createRequire(import.meta.url)('../../frontend/nimbus-compute-core.js');
  const weekdays = { 0: null, 1: [6, 22], 2: [6, 22], 3: [6, 22], 4: [6, 22], 5: [6, 22], 6: null };
  let rev = 1;
  try {
    const task = (due, machine = 'L1') => ({ id: 't', MACHINE: machine, original_end_date: due });
    // Not wired: no calendar rows -> raw + 23:59:59.
    assert.equal(+Util.sapDueDate(task(new Date(2026, 7, 5))), +new Date(2026, 7, 5, 23, 59, 59));
    Util.setDueCalendarResolver(line => {
      return line === 'L1' ? { lineHours: weekdays, plantHours: weekdays, plant: 'P1', rev } : null;
    });
    assert.equal(+Util.sapDueDate(task(new Date(2026, 7, 5))), +new Date(2026, 7, 5, 22, 0, 0), 'open Wednesday -> window close');
    assert.equal(+Util.sapDueDate(task(new Date(2026, 7, 9))), +new Date(2026, 7, 7, 22, 0, 0), 'closed Sunday -> previous Friday close');
    const timed = new Date(2026, 7, 5, 9, 30);
    assert.equal(Util.sapDueDate(task(timed)), timed, 'timed due returned as-is');
    assert.equal(+Util.sapDueDate(task(new Date(2026, 7, 5), 'NOCAL')), +new Date(2026, 7, 5, 23, 59, 59), 'line without calendar rows');
    assert.equal(Util.sapDueDate({ id: 'n', MACHINE: 'L1', original_end_date: null }), null);
    // R-I6: a line closing at 24:00 reads a date-only due as the close of that day (Thu 00:00), not 23:59:59.
    weekdays[3] = [6, 24];
    rev = 3;
    assert.equal(+Util.sapDueDate(task(new Date(2026, 7, 5))), +new Date(2026, 7, 6, 0, 0, 0), '06:00-24:00 line -> next-day 00:00');
    weekdays[3] = [6, 22];
    rev = 1;
    // The per-line+date window cache stays valid until the Store revision moves.
    rev = 2;
    weekdays[3] = [8, 12];
    assert.equal(+Util.sapDueDate(task(new Date(2026, 7, 5))), +new Date(2026, 7, 5, 12, 0, 0), 'revision bump invalidates the window cache');
  } finally {
    Util.setDueCalendarResolver(null);
    globalThis.NimbusComputeCore = prevCore;
  }
});


/* Task 3.3: "today" is overlap on the plant clock; the queued-order clock is the plant's. */
test('Util.overlapsDay: a bar crossing midnight counts on both days; one ending exactly at midnight does not count on the next', () => {
  const crossing = { id: 'x', start_date: new Date(2026, 9, 14, 22), end_date: new Date(2026, 9, 15, 6) };
  assert.equal(Util.overlapsDay(crossing, '2026-10-14'), true);
  assert.equal(Util.overlapsDay(crossing, '2026-10-15'), true);
  assert.equal(Util.overlapsDay(crossing, '2026-10-16'), false);
  const endsAtMidnight = { id: 'm', start_date: new Date(2026, 9, 14, 20), end_date: new Date(2026, 9, 15, 0) };
  assert.equal(Util.overlapsDay(endsAtMidnight, '2026-10-14'), true);
  assert.equal(Util.overlapsDay(endsAtMidnight, '2026-10-15'), false);
});

test('Util.overlapsDay: split orders are tested piece by piece; a start with no finish counts on its start day; no start never counts', () => {
  const split = { id: 's', start_date: new Date(2026, 9, 14, 9), end_date: new Date(2026, 9, 16, 12),
    scheduleSegments: [{ sequence: 1, startDate: new Date(2026, 9, 14, 9), endDate: new Date(2026, 9, 14, 12) },
      { sequence: 2, startDate: new Date(2026, 9, 16, 9), endDate: new Date(2026, 9, 16, 12) }] };
  assert.equal(Util.overlapsDay(split, '2026-10-15'), false, 'the gap day between pieces is not a work day');
  assert.equal(Util.overlapsDay(split, '2026-10-16'), true);
  assert.equal(Util.overlapsDay({ id: 'n', start_date: new Date(2026, 9, 14, 9) }, '2026-10-14'), true);
  assert.equal(Util.overlapsDay({ id: 'z' }, '2026-10-14'), false);
});

test('Util.overlapsDay (U29): a finish-only row (end set, start null) counts on every day of [end - run_time, end]; without a run time or finish it never counts', () => {
  const fo = { id: 'fo', RUN_TIME: 3, start_date: null, end_date: new Date(2026, 9, 15, 1, 0) };   // 22:00 Wed -> 01:00 Thu
  assert.equal(Util.overlapsDay(fo, '2026-10-14'), true, 'the derived bar starts on Wednesday');
  assert.equal(Util.overlapsDay(fo, '2026-10-15'), true);
  assert.equal(Util.overlapsDay(fo, '2026-10-16'), false);
  assert.equal(Util.overlapsDay({ id: 'x', RUN_TIME: 0, start_date: null, end_date: new Date(2026, 9, 15, 1) }, '2026-10-15'), false);
  assert.equal(Util.overlapsDay({ id: 'y', RUN_TIME: 3, start_date: null, end_date: null }, '2026-10-15'), false);
});

test('Util.plantClock reads the wired plant clock (by plant, else by line), and falls back when it returns nothing', () => {
  const pinned = new Date(2026, 9, 15, 3, 30);
  Util.setPlantClockResolver((plant, line) => (plant === 'P' || line === 'L-P') ? pinned : null);
  try {
    assert.equal(Util.plantClock('P'), pinned);
    assert.equal(Util.plantClock(undefined, 'L-P'), pinned);
    assert.ok(Math.abs(Util.plantClock('OTHER').getTime() - Date.now()) < 5000, 'no plant clock: the server / viewer instant');
    assert.equal(Util.dayKey(Util.plantToday('P')), '2026-10-15');
  } finally { Util.setPlantClockResolver(null); }
});

test('Util.latenessHours: a queued order is as late as the plant clock says, not the viewer clock', () => {
  const due = new Date(2026, 9, 15, 12, 0, 0);
  const queued = { id: 'q', PLANT: 'P', MACHINE: 'L', planning_status: 'needs_planning', original_end_date: due };
  Util.setPlantClockResolver(plant => plant === 'P' ? new Date(2026, 9, 15, 15, 0, 0) : null);
  try {
    assert.equal(Util.latenessHours(queued), 3);
    Util.setPlantClockResolver(() => new Date(2026, 9, 15, 9, 0, 0));
    assert.equal(Util.latenessHours(queued), 0, 'before the due instant on the plant clock');
  } finally { Util.setPlantClockResolver(null); }
});

test('Util.alertMessage prefers the localized key and falls back to the English text', () => {
  assert.equal(Util.alertMessage({ msg: 'English only' }), 'English only');
  assert.equal(Util.alertMessage({ msg: 'fallback', msgKey: 'no.such.key', msgVars: {} }), 'no.such.key', 'Util.t returns the key for an unknown key');
});

test('Util.scheduleKpis counts late orders on the due instant (the same reading the late alert uses)', () => {
  const dueFriMidnight = new Date(2026, 9, 16, 0, 0, 0);
  const mk = (id, end) => ({ id, MACHINE: 'L', RUN_TIME: 1, original_end_date: dueFriMidnight, start_date: new Date(end.getTime() - 3600000), end_date: end });
  // No calendar wired: a date-only due date reads as 23:59:59 of that date.
  const kpis = Util.scheduleKpis([mk('ok', new Date(2026, 9, 16, 23, 0, 0)), mk('late', new Date(2026, 9, 17, 1, 0, 0))], 1);
  assert.equal(kpis.late_count, 1);
  assert.equal(Math.round(kpis.late_h * 10) / 10, 1);
});

test('sapDueDate: a plant period that changes the close time on the due date changes the due instant', () => {
  const weekdays = (open, close) => ({ 0: null, 1: [open, close], 2: [open, close], 3: [open, close], 4: [open, close], 5: [open, close], 6: null });
  const lineHours = weekdays(6, 22);
  const plantHours = weekdays(6, 22);
  // Wed 5 Aug 2026 onwards the plant closes at 14:00 instead of 22:00.
  const periods = [{ id: 'early', name: 'early', validFrom: '2026-08-05', validTo: null, workHours: weekdays(6, 14) }];
  let rev = 1;
  let withPeriods = true;
  try {
    Util.setDueCalendarResolver(line => (line === 'L1'
      ? { lineHours, plantHours, plantPeriods: withPeriods ? periods : null, plant: 'P1', rev }
      : null));
    const task = due => ({ id: 't', MACHINE: 'L1', original_end_date: due });
    assert.equal(+Util.sapDueDate(task(new Date(2026, 7, 5))), +new Date(2026, 7, 5, 14, 0, 0), 'the period close on its validFrom date');
    assert.equal(+Util.sapDueDate(task(new Date(2026, 7, 4))), +new Date(2026, 7, 4, 22, 0, 0), 'the day before the period keeps the default close');
    withPeriods = false; rev = 2; // a Store revision bump (calendar:change) invalidates the per-line+date cache
    assert.equal(+Util.sapDueDate(task(new Date(2026, 7, 5))), +new Date(2026, 7, 5, 22, 0, 0), 'no periods: the default pattern');
  } finally {
    Util.setDueCalendarResolver(null);
  }
});

/* PO/Material filter wildcards (W5) */
const _wcTasks = [
  { ORDER: '2040001', MATERIAL_NUMBER: 'M-A', PARENT_ORDER: '' },
  { ORDER: '1204999', MATERIAL_NUMBER: 'M-B', PARENT_ORDER: '' },
  { ORDER: '5550204', MATERIAL_NUMBER: 'M-C', PARENT_ORDER: '' },
  { ORDER: '204',     MATERIAL_NUMBER: 'M-D', PARENT_ORDER: '' },
  { ORDER: 'A-777',   MATERIAL_NUMBER: 'M-E', PARENT_ORDER: '5550204' },
  { ORDER: '2X4Y',    MATERIAL_NUMBER: 'M-F', PARENT_ORDER: '' },
  { ORDER: '2.4Z',    MATERIAL_NUMBER: 'M-G', PARENT_ORDER: '' },
];
const _wcHits = (text) => {
  const m = Util.compilePasteMatcher(Util.parsePasteList(text));
  return _wcTasks.filter(t => Util.taskMatchesPasteSet(t, m)).map(t => t.ORDER);
};

test('wildcard starts-with 204*', () => {
  assert.deepEqual(_wcHits('204*'), ['2040001', '204']);
});
test('wildcard contains *204*', () => {
  assert.deepEqual(_wcHits('*204*'), ['2040001', '1204999', '5550204', '204', 'A-777']);
});
test('wildcard ends-with *204 (also pulls sub-orders via PARENT_ORDER)', () => {
  assert.deepEqual(_wcHits('*204'), ['5550204', '204', 'A-777']);
});
test('plain 204 stays an exact match', () => {
  assert.deepEqual(_wcHits('204'), ['204']);
});
test('wildcard input is case-insensitive and matches material numbers', () => {
  assert.deepEqual(_wcHits('m-*'), _wcTasks.map(t => t.ORDER));
  assert.deepEqual(_wcHits('a-7*'), ['A-777']);
});
test('regex metacharacters in a wildcard token are literal', () => {
  assert.deepEqual(_wcHits('2.4*'), ['2.4Z']);
});
test('bare * is ignored; exact and wildcard tokens combine', () => {
  const m = Util.compilePasteMatcher(['*', '**', '204', '1204*']);
  assert.equal(m.exact.size, 1);
  assert.equal(m.patterns.length, 1);
  assert.equal(m.size, 2);
  assert.equal(Util.compilePasteMatcher(['*']).size, 0);
  assert.deepEqual(_wcHits('204\n1204*'), ['1204999', '204']);
});
test('taskMatchesPasteSet still accepts a plain Set', () => {
  assert.equal(Util.taskMatchesPasteSet(_wcTasks[3], new Set(['204'])), true);
  assert.equal(Util.taskMatchesPasteSet(_wcTasks[0], new Set(['204'])), false);
  assert.equal(Util.taskMatchesPasteSet(_wcTasks[0], new Set()), true);
});
test('countPasteMatches counts wildcard tokens against known ids', () => {
  const known = new Set(['2040001', '204', 'M-A']);
  assert.deepEqual(Util.countPasteMatches('204*\n999*\n204\nzzz', known), { matched: 2, total: 4 });
  assert.deepEqual(Util.countPasteMatches('*', known), { matched: 0, total: 0 });
});
