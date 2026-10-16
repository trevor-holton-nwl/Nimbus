// Tests for frontend/priority-lists/viewers.mts (ColorWheelViewer,
// PriorityListViewer). Split from tests/modules/schedule-workbench.test.mjs
// (Phase P3 of docs/architecture/domain-refactor-plan.md, which split that
// mega-module into 6 domain files) to mirror the new file layout. The
// ColorWheelViewer assertion below was pulled out of that file's combined
// 'EditCalendar/ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter
// expose their documented public API' smoke test, which spanned five modules
// across four different new files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ColorWheelViewer, PriorityListViewer } from '../../../frontend/priority-lists/viewers.mjs';

test('ColorWheelViewer exposes the documented public API', () => {
  assert.equal(typeof ColorWheelViewer.open, 'function');
});

test('PriorityListViewer exposes open/close/search', () => {
  assert.equal(typeof PriorityListViewer.open, 'function');
  assert.equal(typeof PriorityListViewer.close, 'function');
  assert.equal(typeof PriorityListViewer.search, 'function');
});


for (const [viewer, prefix] of [[ColorWheelViewer, 'cw'], [PriorityListViewer, 'pl']]) {
  test(`${prefix} viewer ignores an older plant response and an error after closing`, async t => {
    const { Util } = await import('../../../frontend/platform/foundation.mjs');
    const nodes = new Map();
    const node = id => {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', hidden: false, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [] });
      return nodes.get(id);
    };
    const previous = { document: globalThis.document, window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame };
    Object.assign(globalThis, { document: { getElementById: node, querySelectorAll: () => [] }, window: {}, requestAnimationFrame: fn => fn() });
    t.after(() => Object.assign(globalThis, previous));
    const requests = [];
    t.mock.method(Util, 'fetchTraced', () => new Promise(resolve => requests.push(resolve)));
    viewer.open('A', 'prt01'); viewer.open('B', 'prt01');
    requests[1]({ ok: true, json: async () => ({ entries: [{ color: 'CURRENT', value: 'CURRENT', rank: 1, order_y: 1 }] }) });
    await new Promise(resolve => setImmediate(resolve));
    const current = node(`${prefix}-viewer-list`).innerHTML;
    assert.match(current, /CURRENT/);
    requests[0]({ ok: true, json: async () => ({ entries: [] }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(node(`${prefix}-viewer-list`).innerHTML, current);
    viewer.open('C', 'prt01'); viewer.close();
    const closed = node(`${prefix}-viewer-list`).innerHTML;
    requests[2]({ ok: false, status: 500 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(node(`${prefix}-viewer-list`).innerHTML, closed);
    viewer.open('D', 'prt01');
    requests[3]({ ok: true, json: async () => ({ entries: [] }) });
    await new Promise(resolve => setTimeout(resolve, 260));
    const modal = node(prefix === 'cw' ? 'modal-cw-viewer' : 'modal-priority-viewer');
    assert.equal(modal.hidden, false, 'closing timer must not hide a reopened viewer');
  });
}
