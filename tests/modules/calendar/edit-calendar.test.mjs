// Tests for web/calendar/edit-calendar.mts (EditCalendar). Split from
// tests/modules/schedule-workbench.test.mjs (Phase P3 of
// docs/architecture/domain-refactor-plan.md, which split that mega-module
// into 6 domain files) to mirror the new file layout. This assertion was
// pulled out of that file's combined 'EditCalendar/ColorWheelViewer/Printer/
// SandboxAdapter/AlertsUIAdapter expose their documented public API' smoke
// test, which spanned five modules across four different new files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditCalendar } from '../../../web/calendar/edit-calendar.mjs';

test('EditCalendar exposes the documented public API', () => {
  assert.equal(typeof EditCalendar.open, 'function');
});
