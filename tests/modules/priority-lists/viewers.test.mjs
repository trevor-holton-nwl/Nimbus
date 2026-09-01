// Tests for web/priority-lists/viewers.mts (ColorWheelViewer,
// PriorityListViewer). Split from tests/modules/schedule-workbench.test.mjs
// (Phase P3 of docs/architecture/domain-refactor-plan.md, which split that
// mega-module into 6 domain files) to mirror the new file layout. The
// ColorWheelViewer assertion below was pulled out of that file's combined
// 'EditCalendar/ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter
// expose their documented public API' smoke test, which spanned five modules
// across four different new files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ColorWheelViewer, PriorityListViewer } from '../../../web/priority-lists/viewers.mjs';

test('ColorWheelViewer exposes the documented public API', () => {
  assert.equal(typeof ColorWheelViewer.open, 'function');
});

test('PriorityListViewer exposes open/close/search', () => {
  assert.equal(typeof PriorityListViewer.open, 'function');
  assert.equal(typeof PriorityListViewer.close, 'function');
  assert.equal(typeof PriorityListViewer.search, 'function');
});
