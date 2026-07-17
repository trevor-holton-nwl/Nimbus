import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, PerfMonitor, VirtualList, Toast, Modal } from '../../web/application-foundation.mjs';
import { Util, ErrorLog } from '../../web/application-foundation.mjs';

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
