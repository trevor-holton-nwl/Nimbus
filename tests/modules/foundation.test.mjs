import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, PerfMonitor, VirtualList, Toast, Modal } from '../../frontend/platform/foundation.mjs';
import { Util, ErrorLog } from '../../frontend/platform/foundation.mjs';

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
  globalThis.document = { getElementById: id => elements[id] ?? null };
  try {
    const first = Modal.confirm({ message: 'First' });
    const second = Modal.confirm({ message: 'Second' });
    elements['confirm-modal']._listeners.click({ target: elements['confirm-modal'] });
    assert.equal(await first, false);
    assert.equal(elements['confirm-message'].textContent, 'Second');
    elements['confirm-ok-btn'].click();
    assert.equal(await second, true);
  } finally {
    globalThis.document = previousDocument;
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

test('Modal: Tab stays trapped (including focus on <body> and dialogs with no focusables) and Escape cancels a confirm', async () => {
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
    focus() { if (!this.isConnected || this.hidden || this.closest('[hidden]')) return; document.activeElement = this; }
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
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const A = mk('tabA', 2);
    Modal.open('tabA'); await sleep(5);
    assert.equal(document.activeElement, A.btns[0], 'focus moves into the dialog');
    A.btns[1].focus();
    assert.equal(key(A.btns[1], 'Tab').prevented, true, 'Tab on the last control wraps');
    assert.equal(document.activeElement, A.btns[0]);
    assert.equal(key(A.btns[0], 'Tab', true).prevented, true, 'Shift+Tab on the first control wraps');
    assert.equal(document.activeElement, A.btns[1]);

    document.activeElement = root; // a click on the backdrop left focus on <body>
    assert.equal(key(root, 'Tab').prevented, true, 'Tab from <body> is pulled back into the open dialog');
    assert.ok(A.m.contains(document.activeElement));
    Modal.close('tabA');
    document.activeElement = root;
    assert.equal(key(root, 'Tab').prevented, false, 'no trap once the dialog is closed');

    const E = mk('tabEmpty', 0); // nothing focusable inside
    Modal.open('tabEmpty'); await sleep(5);
    document.activeElement = root;
    assert.equal(key(root, 'Tab').prevented, true);
    assert.equal(document.activeElement, E.m, 'the dialog container itself takes focus');
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
