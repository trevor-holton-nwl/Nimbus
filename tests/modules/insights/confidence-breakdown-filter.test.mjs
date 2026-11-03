// Confidence breakdown dialog: the three tiles are toggle buttons that filter the content below.
// The VM harness runs the production nimbus-intelligence.js; the harness DOM is too thin to render a
// <dialog>, so the test swaps in a minimal fake dialog that records innerHTML and dispatches clicks
// through the dialog's own delegated click handler (the same path a real click takes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { loadLegacyApp, ROOT } from '../helpers/load-legacy-app.mjs';

const { nimbus, context } = await loadLegacyApp();
context.document.readyState = 'loading';
context.document.addEventListener = () => {};
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
runInContext(readFileSync(`${ROOT}/frontend/nimbus-intelligence.js`, 'utf8'), context);
const { Confidence, Store, Utilization } = nimbus;

// Fake dialog: captures the template, serves the .ni-conf-dyn region, routes click events to the handler.
function installFakeDialog() {
  const dlg = {
    className: '', innerHTML: '', open: false, handlers: {}, focused: null,
    dyn: { innerHTML: '' },
    showModal() { this.open = true; },
    close() { this.open = false; },
    remove() {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelector(sel) {
      if (sel === '.ni-conf-dyn') return this.dyn;
      const m = /^\[data-conf-filter="(\w+)"\]$/.exec(sel);
      if (m) return { focus: () => { this.focused = m[1]; } };
      return null;
    },
    // Fire a click on an element described by one data attribute (closest() matches only that attribute).
    click(attr, value) {
      const target = {
        closest: sel => {
          if (sel === `[${attr}]`) return { dataset: { [attr.replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())]: value } };
          return null;
        },
      };
      this.handlers.click({ target });
    },
    // The live region's markup: the initial template until the first re-render replaces it.
    region() { return this.dyn.innerHTML || /<div class="ni-conf-dyn">([\s\S]*)<\/div>\s*<\/div>$/.exec(this.innerHTML)[1]; },
  };
  const priorCreate = context.document.createElement;
  context.document.createElement = tag => (tag === 'dialog' ? dlg : priorCreate.call(context.document, tag));
  return { dlg, restore: () => { context.document.createElement = priorCreate; } };
}

async function withBreakdown(body) {
  const priorAlerts = structuredClone(Store.alerts);
  const priorMatrix = Utilization.computeMatrixAsync;
  const priorNimbus = globalThis.NIMBUS;
  const priorCss = context.getComputedStyle;
  globalThis.NIMBUS = nimbus;
  context.getComputedStyle = () => ({ getPropertyValue: () => '' });
  const day = n => new Date(Date.now() + n * 86400000);
  Store.setAlerts([
    { id: 'e1', type: 'overlap', sev: 'err', line: 'L1', taskId: 't1', time: day(1), msg: 'ERR-ONE' },
    { id: 'e2', type: 'overlap', sev: 'err', line: 'L1', taskId: 't2', time: day(2), msg: 'ERR-TWO' },
    { id: 'w1', type: 'late', sev: 'warn', line: 'L2', taskId: 't3', time: day(3), msg: 'WARN-ONE' },
  ], 'test');
  const row = (sched, cap) => ({ scheduled: sched, effectiveCapacity: cap });
  const setMatrix = m => { Utilization.computeMatrixAsync = () => Promise.resolve(m); };
  const { dlg, restore } = installFakeDialog();
  try {
    await body({ dlg, setMatrix, row });
  } finally {
    restore();
    Utilization.computeMatrixAsync = priorMatrix;
    context.getComputedStyle = priorCss;
    Store.setAlerts(priorAlerts, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
}

test('tiles render as toggle buttons with data-conf-filter and aria-pressed', async () => {
  await withBreakdown(async ({ dlg, setMatrix, row }) => {
    setMatrix({ 'LINE-A': { d1: row(10, 8) } });
    await Confidence.showBreakdown();
    const html = dlg.region();
    for (const key of ['err', 'warn', 'overload']) {
      assert.match(html, new RegExp(`<button type="button" class="ni-conf-tile" data-conf-filter="${key}" aria-pressed="false"`));
    }
    assert.doesNotMatch(html, /on(click|keydown)=/, 'no inline handlers');
  });
});

test('clicking a tile filters the alert list; clicking it again clears the filter', async () => {
  await withBreakdown(async ({ dlg, setMatrix }) => {
    setMatrix({});
    await Confidence.showBreakdown();
    assert.match(dlg.region(), /ERR-ONE/);
    assert.match(dlg.region(), /WARN-ONE/, 'unfiltered list shows everything');
    assert.doesNotMatch(dlg.region(), /<details class="ni-conf-alerts" open/, 'unfiltered list is collapsed');

    dlg.click('data-conf-filter', 'err');
    let html = dlg.region();
    assert.match(html, /ERR-ONE/);
    assert.match(html, /ERR-TWO/);
    assert.doesNotMatch(html, /WARN-ONE/, 'only critical conflicts remain');
    assert.match(html, /data-conf-filter="err" aria-pressed="true"/);
    assert.match(html, /<details class="ni-conf-alerts" open/, 'the list opens automatically');
    assert.match(html, /data-conf-goto="e1"/, 'Go to still works on filtered rows');
    assert.match(html, /data-conf-clear/, 'a Show all control appears');
    assert.equal(dlg.focused, 'err', 'focus returns to the tile');

    dlg.click('data-conf-filter', 'warn');
    html = dlg.region();
    assert.match(html, /WARN-ONE/);
    assert.doesNotMatch(html, /ERR-ONE/);

    dlg.click('data-conf-filter', 'warn');   // second click clears
    html = dlg.region();
    assert.match(html, /ERR-ONE/);
    assert.match(html, /WARN-ONE/);
    assert.match(html, /data-conf-filter="warn" aria-pressed="false"/);
    assert.doesNotMatch(html, /data-conf-clear/);
  });
});

test('the Show all control clears the filter', async () => {
  await withBreakdown(async ({ dlg, setMatrix }) => {
    setMatrix({});
    await Confidence.showBreakdown();
    dlg.click('data-conf-filter', 'err');
    assert.doesNotMatch(dlg.region(), /WARN-ONE/);
    dlg.click('data-conf-clear', '');
    assert.match(dlg.region(), /WARN-ONE/);
    assert.match(dlg.region(), /ERR-ONE/);
  });
});

test('a tile with a zero count is disabled', async () => {
  await withBreakdown(async ({ dlg, setMatrix }) => {
    setMatrix({});   // no overloaded lines
    await Confidence.showBreakdown();
    const html = dlg.region();
    assert.match(html, /data-conf-filter="overload" aria-pressed="false" disabled/);
    assert.doesNotMatch(html, /data-conf-filter="err" aria-pressed="false" disabled/);
    assert.doesNotMatch(html, /data-conf-filter="warn" aria-pressed="false" disabled/);
  });
});

test('the overloaded tile lists lines with days over capacity, most days first, without Go to', async () => {
  await withBreakdown(async ({ dlg, setMatrix, row }) => {
    setMatrix({
      'LINE-A': { d1: row(10, 8) },                                         // 1 day over
      'LINE-B': { d1: row(10, 8), d2: row(9, 8), d3: row(12, 8) },          // 3 days over
      'LINE-C': { d1: row(4, 8) },                                          // fine
    });
    await Confidence.showBreakdown();
    dlg.click('data-conf-filter', 'overload');
    const html = dlg.region();
    assert.match(html, /data-conf-filter="overload" aria-pressed="true"/);
    assert.ok(html.indexOf('LINE-B') > -1 && html.indexOf('LINE-A') > -1);
    assert.ok(html.indexOf('LINE-B') < html.indexOf('LINE-A'), 'sorted by days descending');
    assert.doesNotMatch(html, /LINE-C/);
    assert.doesNotMatch(html, /ERR-ONE/, 'alert rows are not shown under the overload filter');
    assert.doesNotMatch(html, /data-conf-goto/, 'no Go to on overloaded-line rows');
    assert.match(html, /<details class="ni-conf-alerts" open/);
  });
});

test('the alert list shows embedded dates in the user format and still escapes the text (msgDates)', async () => {
  await withBreakdown(async ({ dlg, setMatrix }) => {
    setMatrix({});
    const priorFmt = nimbus.Util.fmtDTReadable;
    nimbus.Util.fmtDTReadable = () => 'USER-FMT <b>';
    const ms = Date.now() + 86400000;
    Store.setAlerts([
      { id: 'd1', type: 'firmed-out-of-hours', sev: 'warn', line: 'L1', taskId: 't1', time: new Date(ms),
        msg: 'Order starts 11/04/2026 08:00 outside hours', msgDates: [{ text: '11/04/2026 08:00', ms }] },
    ], 'test');
    try {
      await Confidence.showBreakdown();
      const html = dlg.region();
      assert.match(html, /Order starts USER-FMT &lt;b&gt; outside hours/, 'default-format text swapped for the user format, then escaped');
      assert.doesNotMatch(html, /11\/04\/2026 08:00/);
      assert.doesNotMatch(html, /<b>/, 'the swapped text is still escaped');
    } finally { nimbus.Util.fmtDTReadable = priorFmt; }
  });
});

test('the overloaded-lines count includes a fully buffered day (capacity > 0, effective capacity 0)', async () => {
  await withBreakdown(async ({ dlg, setMatrix }) => {
    setMatrix({
      'BUF-LINE':    { d1: { scheduled: 3, effectiveCapacity: 0, capacity: 8 } },     // fully buffered: counts
      'CLOSED-LINE': { d1: { scheduled: 3, effectiveCapacity: 0, capacity: 0 } },     // closed day: the 'closed' alert's business
      'EMPTY-BUF':   { d1: { scheduled: 0, effectiveCapacity: 0, capacity: 8 } },     // nothing scheduled: fine
      'FULL-LINE':   { d1: { scheduled: 8.04, effectiveCapacity: 8, capacity: 8 } },  // inside the tolerance
    });
    await Confidence.showBreakdown();
    dlg.click('data-conf-filter', 'overload');
    const html = dlg.region();
    assert.match(html, /BUF-LINE/);
    assert.doesNotMatch(html, /CLOSED-LINE|EMPTY-BUF|FULL-LINE/);
  });
});
