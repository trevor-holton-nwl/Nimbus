// Tests for frontend/integration/sap-interface-ui.mjs (Interface).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
