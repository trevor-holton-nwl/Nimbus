import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, PerfMonitor, VirtualList, Toast, Modal } from '../../frontend/platform/foundation.mjs';
import { Util, ErrorLog } from '../../frontend/platform/foundation.mjs';

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

test('Util.setPreferenceResolver changes what _timeFormatPref/_dateFormatPref read', () => {
  Util.setPreferenceResolver(key => ({ timeFormat: '24h', dateFormat: 'd/m/Y' }[key]));
  assert.equal(Util._timeFormatPref(), '24h');
  assert.equal(Util._dateFormatPref(), 'd/m/Y');
  Util.setPreferenceResolver(() => undefined); // reset
  assert.equal(Util._timeFormatPref(), '12h'); // documented fallback
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
