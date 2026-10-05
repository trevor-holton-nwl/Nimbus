// Tests for frontend/labor/labor-planning.mjs.
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaborPlanning } from '../../../frontend/labor/labor-planning.mjs';

test('LaborPlanning exposes its documented public API', () => {
  assert.equal(typeof LaborPlanning.init, 'function');
  assert.equal(typeof LaborPlanning.render, 'function');
  assert.equal(typeof LaborPlanning.onGroupToggle, 'function');
  assert.equal(typeof LaborPlanning.clearGroupFilter, 'function');
  assert.equal(typeof LaborPlanning.prevHorizon, 'function');
  assert.equal(typeof LaborPlanning.nextHorizon, 'function');
  assert.equal(typeof LaborPlanning.setSpan, 'function');
});

test('Labor attribute selectors are CSS-escaped, never hand-escaped with &quot; (#47)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../frontend/labor/labor-planning.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /&quot;'\)\}/, 'a name containing a quote must not be turned into &quot; inside a selector');
  assert.match(source, /_cssEsc\(grp\)/);
});

test('Aggregate grid writes the RAW week key into data-period, even where CSS.escape escapes a leading digit (senior audit #1)', async () => {
  // Spec-correct CSS.escape: a leading digit becomes `\3X ` (what browsers do).
  const BS = String.fromCharCode(92);
  const specEscape = (s) => String(s).replace(/^[0-9]/, (d) => BS + '3' + d + ' ').replace(/["\\]/g, (c) => BS + c);
  const saved = { CSS: globalThis.CSS, document: globalThis.document, fetch: globalThis.fetch, flatpickr: globalThis.flatpickr };
  globalThis.flatpickr = () => ({ setDate() {} });
  globalThis.CSS = { escape: specEscape };
  let html = '';
  const grid = {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const noop = () => {};
  globalThis.document = { getElementById: (id) => (id === 'labor-grid' ? grid : null), addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ rows: [] }) });
  try {
    const { Store } = await import('../../../frontend/platform/store.mjs');
    Store.setMasterData({ plants: [{ plant: 'P1', subnetwork: 'S' }], lines: [{ plant: 'P1', machine: 'L1', wc_group: 'G1' }] });
    Store.setSelectedPlant('P1');
    await LaborPlanning.render();
    const periods = [...html.matchAll(/data-period="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(periods.length > 0, 'the aggregate grid rendered cells');
    for (const p of periods) {
      assert.match(p, /^\d{4}-W\d{2}$/, `data-period must be the raw ISO week key, got ${JSON.stringify(p)}`);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});
