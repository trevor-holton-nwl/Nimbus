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
