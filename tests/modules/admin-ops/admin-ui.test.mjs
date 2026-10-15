// Tests for frontend/admin-ops/admin-ui.mjs (AdminCockpit).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminCockpit } from '../../../frontend/admin-ops/admin-ui.mjs';

// Same split-realm/no-DOM situation documented in
// tests/modules/insights/insights-ui.test.mjs: Util.t() reads window.__NIMBUS_LOCALES
// (optionally — undefined falls through to the key itself), but needs the bare
// `window` global to exist at all.
globalThis.window = globalThis.window || {};

test('AdminCockpit exposes its documented public API', () => {
  assert.equal(typeof AdminCockpit.init, 'function');
  assert.equal(typeof AdminCockpit.render, 'function');
  assert.equal(typeof AdminCockpit._startHealthPolling, 'function');
  assert.equal(typeof AdminCockpit._stopHealthPolling, 'function');
  assert.equal(typeof AdminCockpit.gotoOvTab, 'function');
  assert.equal(typeof AdminCockpit._setSub, 'function');
});

// Minimal fake DOM (same no-document situation as insights-ui.test.mjs):
// _renderDistributionWarning only needs createElement/createDocumentFragment
// nodes that can appendChild, hold style/className/textContent/href, and
// record an addEventListener'd click handler.
function fakeNode() {
  const node = {
    style: {},
    className: '',
    textContent: '',
    href: '',
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
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

test('AdminCockpit._renderDistributionWarning formats each warning-item shape and fixes the prior "[object Object]" output', () => {
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

    const frag = AdminCockpit._renderDistributionWarning(entry, 'batch-123');

    // children: [0] summary, [1] link row, [2..5] the four detail-list rows,
    // in the listFields order declared in _renderDistributionWarning.
    const detailRows = frag.children.slice(2);
    const preTextOf = row => row.children[1].children[0].textContent;
    assert.equal(preTextOf(detailRows[0]), 'PO1 · MAT1 · 10/20', 'conflicting_parent_rows: order · material · values.join(\'/\')');
    assert.equal(preTextOf(detailRows[1]), 'PO2 · MAT2', 'ambiguous_plant: order · material, no trailing separator for missing fields');
    assert.equal(
      preTextOf(detailRows[2]),
      'PO3 · MAT3 · WC1\nPO5 · MAT5 · WC2 · ui.workcenter_zero_weights',
      'workcenter_without_members: a plain memberless item has no suffix; a `reason: "zero_weights"` item (B3) gets one',
    );
    assert.equal(preTextOf(detailRows[3]), 'PO4 · MAT4', 'default_machine_invalid: order · material');
  });
});

test('AdminCockpit._renderDistributionWarning\'s review link navigates to the Gantt distribution sub-pane instead of a dead #gantt/distribution hash', () => {
  withFakeDom(() => {
    const priorNimbus = globalThis.NIMBUS;
    const calls = [];
    globalThis.NIMBUS = { App: {
      goto: tab => calls.push(['goto', tab]),
      gotoGanttSub: sub => calls.push(['gotoGanttSub', sub]),
    } };
    try {
      const entry = { category: 'distribution', msg: 'ok', headers_created: 1, headers_refreshed: 0 };
      const frag = AdminCockpit._renderDistributionWarning(entry, 'batch-456');
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

test('_clearBackendLog confirms first, and reports a non-OK response instead of swallowing it (#47)', async () => {
  const { Modal, Toast } = await import('../../../frontend/platform/foundation.mjs');
  const priorFetch = globalThis.fetch, priorConfirm = Modal.confirm, priorToast = Toast.show;
  const fetched = [], toasts = [];
  globalThis.fetch = (url, opts) => { fetched.push([String(url), opts?.method]); return Promise.resolve({ ok: false, status: 500, headers: new Map(), json: () => Promise.resolve({}) }); };
  Toast.show = (msg, type) => { toasts.push([msg, type]); };
  try {
    Modal.confirm = () => Promise.resolve(false);
    await AdminCockpit._clearBackendLog();
    assert.equal(fetched.length, 0, 'declined confirm must not call the server');
    Modal.confirm = () => Promise.resolve(true);
    await AdminCockpit._clearBackendLog();
    assert.equal(fetched.length, 1);
    assert.ok(toasts.some(([, type]) => type === 'error'), 'HTTP 500 must surface an error toast');
  } finally {
    globalThis.fetch = priorFetch; Modal.confirm = priorConfirm; Toast.show = priorToast;
  }
});

test('purge preview sends the whole-day range (T00:00:00 start, T23:59:59 end), the same shape the purge call sends', async () => {
  const priorFetch = globalThis.fetch, priorDocument = globalThis.document;
  const priorPlant = AdminCockpit._purgePlant, priorStart = AdminCockpit._fpPurgeStart, priorEnd = AdminCockpit._fpPurgeEnd;
  const bodies = [];
  const els = { 'admin-past-count': { innerHTML: '', textContent: '' }, 'admin-purge-btn': { disabled: false } };
  globalThis.document = { getElementById: id => els[id] ?? null };
  globalThis.fetch = (url, opts) => {
    bodies.push({ url: String(url), body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok', plant: '1085', total: 0, planner_overridden: 0 }) });
  };
  try {
    AdminCockpit._purgePlant = '1085';
    AdminCockpit._fpPurgeStart = { selectedDates: [new Date(2026, 8, 1)] };
    AdminCockpit._fpPurgeEnd = { selectedDates: [new Date(2026, 8, 30)] };
    await AdminCockpit._fetchPurgePreview();
    assert.equal(bodies.length, 1, 'one preview request');
    assert.match(bodies[0].url, /\/purge\/preview$/);
    assert.equal(bodies[0].body.start_date, '2026-09-01T00:00:00');
    assert.equal(bodies[0].body.end_date, '2026-09-30T23:59:59', 'a bare date would count the last day from 00:00 and under-count the purge');
  } finally {
    globalThis.fetch = priorFetch;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    AdminCockpit._purgePlant = priorPlant; AdminCockpit._fpPurgeStart = priorStart; AdminCockpit._fpPurgeEnd = priorEnd;
  }
});
