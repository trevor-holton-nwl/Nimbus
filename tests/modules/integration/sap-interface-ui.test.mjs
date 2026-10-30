// Tests for frontend/integration/sap-interface-ui.mjs (Interface).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface } from '../../../frontend/integration/sap-interface-ui.mjs';

// Same split-realm/no-DOM situation documented in
// tests/modules/admin-ops/admin-ui.test.mjs: Util.t() reads window.__NIMBUS_LOCALES
// (optionally — undefined falls through to the key itself, which is all the
// F10 translation keys in _renderSapDistributionWarning need here), but needs
// the bare `window` global to exist at all.
globalThis.window = globalThis.window || {};

test('Interface exposes its documented public API', () => {
  assert.equal(typeof Interface.render, 'function');
});

// Minimal fake DOM (same no-document situation as insights-ui.test.mjs /
// admin-ops/admin-ui.test.mjs): _renderSapDistributionWarning only needs
// createElement/createDocumentFragment nodes that can appendChild, hold
// style/textContent/href, and record an addEventListener'd click handler.
function fakeNode() {
  const node = {
    style: {},
    textContent: '',
    href: '',
    children: [],
    appendChild(child) { node.children.push(child); return child; },
    addEventListener(type, fn) { node._listeners[type] = fn; },
  };
  node._listeners = {};
  return node;
}

function withFakeDom(fn) {
  const priorDocument = globalThis.document;
  globalThis.document = {
    createElement() { return fakeNode(); },
    createDocumentFragment() { return fakeNode(); },
  };
  try {
    return fn();
  } finally {
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
  }
}

test('Interface._renderSapDistributionWarningForTest formats each warning-item shape and fixes the prior "[object Object]" output', () => {
  assert.equal(typeof Interface._renderSapDistributionWarningForTest, 'function',
    '_renderSapDistributionWarning is closure-private; exposed only for this test (ForTest precedent)');
  withFakeDom(() => {
    const entry = {
      category: 'distribution',
      msg: 'Distribution applied with warnings',
      level: 'warn',
      headers_created: 2,
      headers_refreshed: 0,
      conflicting_parent_rows: [{ production_order: 'PO1', material_number: 'MAT1', values: ['10', '20'] }],
      ambiguous_plant: [{ production_order: 'PO2', material_number: 'MAT2' }],
      workcenter_without_members: [
        { plant: 'P1', production_order: 'PO3', material_number: 'MAT3', sap_workcenter: 'WC1', reason: 'no machines mapped' },
        { plant: 'P1', production_order: 'PO5', material_number: 'MAT5', sap_workcenter: 'WC2', reason: 'zero_weights' },
      ],
      default_machine_invalid: [{ plant: 'P1', production_order: 'PO4', material_number: 'MAT4' }],
    };

    const frag = Interface._renderSapDistributionWarningForTest(entry, 'batch-123');

    const detailRows = frag.children.slice(2);
    const preTextOf = row => row.children[1].children[0].textContent;
    assert.equal(preTextOf(detailRows[0]), 'PO1 · MAT1 · 10/20', 'conflicting_parent_rows: order · material · values.join(\'/\')');
    assert.equal(preTextOf(detailRows[1]), 'PO2 · MAT2', 'ambiguous_plant: order · material');
    assert.equal(
      preTextOf(detailRows[2]),
      'PO3 · MAT3 · WC1\nPO5 · MAT5 · WC2 · ui.workcenter_zero_weights',
      'workcenter_without_members: a plain memberless item has no suffix; a `reason: "zero_weights"` item (B3) gets one',
    );
    assert.equal(preTextOf(detailRows[3]), 'PO4 · MAT4', 'default_machine_invalid: order · material');
  });
});

test('Interface._stageStatusLineForTest maps each batch status to its pill class and valid/rejected text', () => {
  const batch = (status, counts) => ({ batch_id: 'b1', object_key: 'stage_planned_orders', plant: '5512', status, counts });
  const held = Interface._stageStatusLineForTest(batch('held', { valid: 80, rejected: 3 }));
  assert.equal(held.pillClass, 'sap-batch-pill sap-batch-pill-held');
  assert.equal(held.text, 'ui.sap_stage_status_held · 80/3', 'no locales in the test realm: t() echoes the key');
  const applied = Interface._stageStatusLineForTest(batch('applied', {}));
  assert.equal(applied.pillClass, 'sap-batch-pill sap-batch-pill-applied');
  assert.equal(applied.text, 'ui.sap_stage_status_applied · 0/0', 'missing counts read as 0/0');
  const noCounts = Interface._stageStatusLineForTest({ batch_id: 'b2', object_key: 'x', plant: 'p', status: 'validated' });
  assert.equal(noCounts.text, 'ui.sap_stage_status_validated · 0/0');
  const unknown = Interface._stageStatusLineForTest(batch('weird', { valid: 1, rejected: 2 }));
  assert.equal(unknown.pillClass, 'sap-batch-pill sap-batch-pill-unknown', 'an unknown status falls back to the neutral pill');
  assert.equal(unknown.text, 'weird · 1/2', 'and shows the raw status');
});

test('Interface._applyModeHintForTest returns the consequence line for each apply mode', () => {
  assert.equal(Interface._applyModeHintForTest('auto'), 'ui.sap_stage_mode_hint_auto');
  assert.equal(Interface._applyModeHintForTest('manual'), 'ui.sap_stage_mode_hint_manual');
  assert.equal(Interface._applyModeHintForTest(undefined), 'ui.sap_stage_mode_hint_manual', 'default is manual');
});

test('Interface._renderSapDistributionWarningForTest\'s review link navigates to the Gantt distribution sub-pane instead of a dead #gantt/distribution hash', () => {
  withFakeDom(() => {
    const priorNimbus = globalThis.NIMBUS;
    const calls = [];
    globalThis.NIMBUS = { App: {
      goto: tab => calls.push(['goto', tab]),
      gotoGanttSub: sub => calls.push(['gotoGanttSub', sub]),
    } };
    try {
      const entry = { category: 'distribution', msg: 'ok', headers_created: 1, headers_refreshed: 0 };
      const frag = Interface._renderSapDistributionWarningForTest(entry, 'batch-456');
      const linkRow = frag.children[1];
      const link = linkRow.children[0];
      assert.equal(link.href, '#', 'link no longer encodes a dead #gantt/distribution hash');

      let defaultPrevented = false;
      link._listeners.click({ preventDefault() { defaultPrevented = true; } });

      assert.equal(defaultPrevented, true);
      assert.deepEqual(calls, [['goto', 'gantt'], ['gotoGanttSub', 'distribution']],
        'goto(\'gantt\') must run before gotoGanttSub, which alone does not switch the top-level tab');
    } finally {
      if (priorNimbus === undefined) delete globalThis.NIMBUS; else globalThis.NIMBUS = priorNimbus;
    }
  });
});

test('raw staging codes are shown as plain words: reject reasons, warning codes and 409 codes', () => {
  assert.equal(Interface._stageRejectTextForTest('missing_key'), 'ui.sap_stage_reject_missing_key');
  assert.equal(Interface._stageRejectTextForTest('value_too_long:mmsta'), 'ui.sap_stage_reject_value_too_long (mmsta)',
    'a suffixed code renders the base text plus the column');
  assert.equal(Interface._stageRejectTextForTest('Row 5 has a bad routing'), 'Row 5 has a bad routing',
    'text outside the known codes (routing validators) is shown as sent');
  assert.equal(Interface._stageRejectTextForTest(null), '');
  assert.equal(Interface._stageWarningTextForTest({ code: 'stale_loading' }), 'ui.sap_stage_warn_stale_loading');
  assert.equal(Interface._stageWarningTextForTest({ category: 'sap_changed_running', count: 2 }), 'ui.sap_stage_warn_sap_changed_running',
    'upsert warnings carry `category` instead of `code`');
  assert.equal(Interface._stageWarningTextForTest({ code: 'unknown_columns', msg: 'Ignored column(s) that are not part of this staging table: foo, bar' }),
    'ui.sap_stage_warn_unknown_columns (foo, bar)', 'the ignored column names stay visible');
  assert.equal(Interface._stageWarningTextForTest({ code: 'made_up_code' }), 'made_up_code', 'an unknown code still falls back to the raw code');
  assert.equal(Interface._stageErrorCodeTextForTest({ error: 'apply_in_progress' }), 'ui.sap_stage_warn_apply_in_progress');
  assert.equal(Interface._stageErrorCodeTextForTest({ error: 'superseded', newer_batch_id: 'n1' }), 'ui.sap_stage_warn_superseded');
  assert.equal(Interface._stageErrorCodeTextForTest({ error: 'nope' }), null);
  assert.equal(Interface._stageErrorCodeTextForTest('plain string'), null);
});

test('Track 9: the Refresh toast counts the poll result lists (the API returns lists, not numbers)', () => {
  assert.deepEqual(Interface._pollCountsForTest({ processed: [{}, {}, {}], applied: [{}], held: [], skipped: [], errors: [] }),
    { processed: 3, applied: 1, held: 0 });
  assert.deepEqual(Interface._pollCountsForTest({}), { processed: 0, applied: 0, held: 0 }, 'missing lists read as 0');
});

test('Track 9: the 25 % hold says rows for master-data objects and orders for planned orders', () => {
  const w = { code: 'vanish_threshold' };
  assert.equal(Interface._stageWarningTextForTest(w, 'stage_planned_orders'), 'ui.sap_stage_warn_vanish_threshold');
  assert.equal(Interface._stageWarningTextForTest(w, 'stage_material_plants'), 'ui.sap_stage_warn_vanish_threshold_rows');
  assert.equal(Interface._stageWarningTextForTest(w), 'ui.sap_stage_warn_vanish_threshold', 'no object keeps the orders wording');
  const here = dirname(fileURLToPath(import.meta.url));
  for (const lc of ['en', 'de', 'es', 'fr', 'pt']) {
    assert.ok(readFileSync(join(here, `../../../frontend/locales/${lc}.js`), 'utf8').includes("'ui.sap_stage_warn_vanish_threshold_rows'"), `${lc}.js lacks the rows wording`);
  }
});

test('every code the UI maps has a key in en.js (reject_* and warn_*)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../../frontend/integration/sap-interface-ui.mts'), 'utf8');
  const en = readFileSync(join(here, '../../../frontend/locales/en.js'), 'utf8');
  const list = (name) => [...src.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`))[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const warn = list('STAGE_WARN_CODES');
  const reject = list('STAGE_REJECT_CODES');
  assert.ok(warn.length >= 20 && reject.length === 12);
  for (const c of warn) assert.ok(en.includes(`'ui.sap_stage_warn_${c}'`), `en.js lacks ui.sap_stage_warn_${c}`);
  for (const c of reject) assert.ok(en.includes(`'ui.sap_stage_reject_${c}'`), `en.js lacks ui.sap_stage_reject_${c}`);
});

test('apply asks for confirmation whenever the batch will delete rows (held, or validated with deletions)', () => {
  const batch = (status, vanish) => ({ batch_id: 'b', object_key: 'stage_planned_orders', plant: 'P', status, counts: { vanish_candidates: vanish } });
  const needs = Interface._stageApplyNeedsConfirmForTest;
  assert.equal(needs(batch('held', 9), 'confirm'), true, 'Confirm & Apply on a held batch always confirms');
  assert.equal(needs(batch('validated', 3), 'apply'), true, 'a validated batch with deletions opens the same modal');
  assert.equal(needs(batch('error', 3), 'retry'), true);
  assert.equal(needs(batch('validated', 0), 'apply'), false, 'only a batch with zero deletions applies without a modal');
  assert.equal(needs({ batch_id: 'b', object_key: 'x', plant: 'P', status: 'validated' }, 'apply'), false, 'no counts reads as no deletions');
  assert.equal(needs(batch('ready', 3), 'validate'), false);
  assert.equal(needs(batch('ready', 3), 'discard'), false);
});


for (const panel of ['batches', 'outbound', 'archive']) {
  for (const failOld of [false, true]) {
    test(`${panel} ignores a stale ${failOld ? 'error' : 'success'} after A-B-A selection`, async t => {
      const { Util } = await import('../../../frontend/platform/foundation.mjs');
      const body = {}; const host = { id: `sap-stage-${panel}`, innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
      const prior = globalThis.document;
      globalThis.document = { getElementById: id => id === 'sap-tabbody' ? body : id === host.id ? host : null };
      t.after(() => { globalThis.document = prior; });
      const requests = [];
      t.mock.method(Util, 'fetchTraced', (url) => new Promise(resolve => requests.push({ url, resolve })));
      const first = Interface._loadStagePanelForTest(panel, 'A', body);
      const middle = Interface._loadStagePanelForTest(panel, 'B', body);
      const latest = Interface._loadStagePanelForTest(panel, 'A', body);
      const payload = panel === 'outbound' ? { ready: 12345 } : panel === 'archive' ? { orders: [{ id: 1, production_order: 'CURRENT' }] } : { batches: [{ batch_id: 'CURRENT', status: 'applied', plant: 'A' }] };
      requests[2].resolve({ ok: true, json: async () => payload }); await latest;
      const current = host.innerHTML;
      assert.match(current, panel === 'outbound' ? /12345/ : /CURRENT/);
      requests[1].resolve({ ok: false, status: 500, json: async () => ({ detail: 'OLD B' }) }); await middle;
      requests[0].resolve({ ok: !failOld, status: 500, json: async () => ({ detail: 'OLD A', batches: [], orders: [], ready: 0 }) }); await first;
      assert.equal(host.innerHTML, current);
    });
  }
}

test('archive paging requests older rows and search starts again at the first page', async t => {
  const { Util } = await import('../../../frontend/platform/foundation.mjs');
  const body = {}; const handlers = {}; const search = { value: 'MAT%_1' };
  const host = { id: 'sap-stage-archive', innerHTML: '', querySelectorAll: () => [], querySelector: selector =>
    selector === 'input[type=search]' ? search : { addEventListener(event, fn) { handlers[selector] = fn; } } };
  const prior = globalThis.document;
  globalThis.document = { getElementById: id => id === 'sap-tabbody' ? body : id === host.id ? host : null };
  t.after(() => { globalThis.document = prior; });
  const urls = [];
  t.mock.method(Util, 'fetchTraced', async url => { urls.push(url); return { ok: true, json: async () => ({ orders: [{ id: 1, order_id: 'ORDER' }], has_more: true }) }; });
  await Interface._loadStagePanelForTest('archive', 'A', body);
  assert.match(host.innerHTML, />1\u20131</, 'archive range uses a real en dash');
  handlers['[data-archive-next]'](); await new Promise(resolve => setImmediate(resolve));
  assert.match(urls.at(-1), /offset=50/);
  handlers['[data-archive-search]']({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
  const params = new URL(urls.at(-1), 'http://localhost').searchParams;
  assert.equal(params.get('offset'), '0'); assert.equal(params.get('search'), 'MAT%_1');
});


for (const failure of [false, true]) {
  test(`history ignores obsolete ${failure ? 'error' : 'success'} after its host is replaced`, async t => {
    const { Util } = await import('../../../frontend/platform/foundation.mjs');
    let body = { innerHTML: '' }; const old = body;
    const prior = globalThis.document;
    globalThis.document = { getElementById: id => id === 'sap-tabbody' ? body : null };
    t.after(() => { globalThis.document = prior; });
    const requests = [];
    t.mock.method(Util, 'fetchTraced', url => new Promise(resolve => requests.push({ url, resolve })));
    const loading = Interface._renderHistoryForTest('stage_planned_orders');
    const previousHtml = old.innerHTML;
    body = { innerHTML: 'Replacement tab' };
    requests[0].resolve({ ok: !failure, status: 500, json: async () => ({ runs: [] }) });
    await loading;
    assert.equal(body.innerHTML, 'Replacement tab');
    assert.equal(old.innerHTML, previousHtml, 'detached host must not be repainted');
    assert.equal(requests.length, 1, 'obsolete success does not start a second audit request');
  });
}

test('Interface.showTab exists and is safe before the console is on screen (selection kept, no throw)', () => {
  assert.equal(typeof Interface.showTab, 'function');
  const prior = globalThis.document;
  globalThis.document = { getElementById() { return null; } };
  try {
    assert.doesNotThrow(() => Interface.showTab('staging'));
    assert.doesNotThrow(() => Interface.showTab('history', 'stage_planned_orders'));
  } finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; }
});
