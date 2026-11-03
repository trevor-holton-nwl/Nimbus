// Tests for frontend/alert-monitor/alert-ack-modal.mts: the pure validation (reason required, <= 200, trimmed;
// until = end of the chosen day as a naive local timestamp, null with "No end date"), the default end date
// (plant today + 7 days) and the modal against a stubbed document (submit payload, inline errors, close).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AlertAckModal, validateAck, defaultUntilDay, ACK_REASON_MAX } from '../../../frontend/alert-monitor/alert-ack-modal.mjs';
import { AlertAcksClient } from '../../../frontend/insights/alert-acks-client.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Modal, Toast } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

function makeEl(id) {
  const handlers = {};
  return {
    id, _html: '', handlers, textContent: '', hidden: false, value: '', checked: false, disabled: false, dataset: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, addEventListener(type, fn) { handlers[type] = fn; }, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; }, focus() {}, blur() {}, style: {},
  };
}

const prior = {};
let els;
const calls = { ack: [], closed: [], toast: [] };

beforeEach(() => {
  els = {};
  prior.doc = globalThis.document; prior.clock = Util.plantClock; prior.today = Util.plantToday;
  prior.ack = AlertAcksClient.acknowledge; prior.open = Modal.open; prior.close = Modal.close; prior.toast = Toast.show;
  globalThis.document = {
    getElementById(id) { return (els[id] ??= makeEl(id)); },
    createElement() { return makeEl('created'); },
    querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {}, activeElement: null,
  };
  calls.ack = []; calls.closed = []; calls.toast = [];
  Util.plantToday = () => new Date(2026, 9, 20);   // Oct 20 2026, local midnight
  AlertAcksClient.acknowledge = async p => { calls.ack.push(p); return { alert_id: p.alert_id }; };
  Modal.open = id => { els[id] ??= makeEl(id); els[id].hidden = false; };
  Modal.close = id => { calls.closed.push(id); if (els[id]) els[id].hidden = true; };
  Toast.show = (msg, type) => { calls.toast.push([msg, type]); };
  Store.setSelectedPlant('P1', 'test');
});

afterEach(() => {
  AlertAckModal.close();
  globalThis.document = prior.doc; Util.plantClock = prior.clock; Util.plantToday = prior.today;
  AlertAcksClient.acknowledge = prior.ack; Modal.open = prior.open; Modal.close = prior.close; Toast.show = prior.toast;
});

test('validateAck: the reason is required, trimmed and at most 200 characters', () => {
  assert.deepEqual(validateAck('', '2026-10-27', false), { ok: false, field: 'reason', key: 'am.ack_err_reason' });
  assert.deepEqual(validateAck('   \n ', '2026-10-27', false), { ok: false, field: 'reason', key: 'am.ack_err_reason' });
  assert.deepEqual(validateAck('x'.repeat(ACK_REASON_MAX + 1), '2026-10-27', false), { ok: false, field: 'reason', key: 'am.ack_err_long' });
  const ok = validateAck(`  ${'x'.repeat(ACK_REASON_MAX)}  `, '2026-10-27', false);
  assert.equal(ok.ok, true);
  assert.equal(ok.reason.length, ACK_REASON_MAX, 'trimmed before the length check');
  assert.equal(ACK_REASON_MAX, 200);
});

test('validateAck: until is the end of the chosen day (naive local), null with No end date, required otherwise', () => {
  assert.equal(validateAck('waiting for tooling', '2026-10-27', false).until, '2026-10-27T23:59:59');
  assert.equal(validateAck('waiting for tooling', '2026-10-27', true).until, null);
  assert.equal(validateAck('waiting for tooling', null, true).until, null);
  assert.deepEqual(validateAck('waiting for tooling', '', false), { ok: false, field: 'until', key: 'am.ack_err_until' });
  assert.ok(!/[Z+]/.test(validateAck('r', '2026-10-27', false).until), 'no zone suffix or offset');
});

test('validateAck: a day that is not on the calendar is rejected with the invalid-date message', () => {
  const bad = { ok: false, field: 'until', key: 'am.ack_err_until' };
  assert.deepEqual(validateAck('r', '2026-02-31', false), bad);
  assert.deepEqual(validateAck('r', '2026-13-01', false), bad);
  assert.deepEqual(validateAck('r', '2026-00-10', false), bad);
  assert.deepEqual(validateAck('r', '2026-04-31', false), bad);
  assert.equal(validateAck('r', '2028-02-29', false).until, '2028-02-29T23:59:59', 'a real leap day passes');
  assert.deepEqual(validateAck('r', '2027-02-29', false), bad, 'not a leap year');
  assert.equal(validateAck('r', '2026-02-31', true).until, null, 'No end date ignores the picked day');
});

test('defaultUntilDay is the plant today plus seven days', () => {
  assert.equal(defaultUntilDay('P1'), '2026-10-27');
  Util.plantToday = () => new Date(2026, 11, 28);
  assert.equal(defaultUntilDay('P1'), '2027-01-04', 'rolls over month and year');
});

test('open renders the form with the default end date and the confidence note', () => {
  AlertAckModal.open({ plant: 'P1', alertId: 'a1' });
  assert.equal(els['modal-alert-ack'].hidden, false);
  const body = els['aak-body'].innerHTML;
  assert.match(body, /<textarea[^>]*id="aak-reason"[^>]*maxlength="200"/);
  assert.match(body, /id="aak-until"/);
  assert.match(body, /id="aak-noend"/);
  assert.match(body, /am\.ack_note/);
  assert.equal(els['aak-until'].value, '2026-10-27');
  assert.match(els['aak-foot'].innerHTML, /btn\.cancel/);
  assert.match(els['aak-foot'].innerHTML, /btn\.save/);
});

test('the date picker starts at the plant today, not the browser today', () => {
  const seen = [];
  globalThis.flatpickr = (el, opts) => { seen.push(opts); return { altInput: null, destroy() {} }; };
  try {
    Util.plantToday = () => new Date(2026, 11, 28);   // far from the browser's real today
    AlertAckModal.open({ plant: 'P1', alertId: 'a1' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].minDate, '2026-12-28');
    assert.notEqual(seen[0].minDate, 'today');
  } finally { delete globalThis.flatpickr; }
});

test('submit sends plant, alert id, trimmed reason and the end-of-day until, then closes', async () => {
  AlertAckModal.open({ plant: 'P1', alertId: 'a1' });
  els['aak-reason'].value = '  waiting for the mould  ';
  await AlertAckModal.submit();
  assert.deepEqual(calls.ack, [{ plant: 'P1', alert_id: 'a1', reason: 'waiting for the mould', until: '2026-10-27T23:59:59' }]);
  assert.deepEqual(calls.closed, ['modal-alert-ack']);
});

test('No end date sends until null', async () => {
  AlertAckModal.open({ plant: 'P1', alertId: 'a1' });
  els['aak-reason'].value = 'known issue';
  globalThis.document.getElementById('aak-noend').checked = true;
  await AlertAckModal.submit();
  assert.equal(calls.ack.length, 1);
  assert.equal(calls.ack[0].until, null);
});

test('a missing reason shows the inline error and sends nothing', async () => {
  AlertAckModal.open({ plant: 'P1', alertId: 'a1' });
  els['aak-reason'].value = '   ';
  await AlertAckModal.submit();
  assert.equal(calls.ack.length, 0);
  assert.deepEqual(calls.closed, []);
  assert.match(els['aak-err-reason'].textContent, /am\.ack_err_reason/);
  assert.equal(els['aak-err-reason'].hidden, false);
});

test('a failed request keeps the modal open and toasts the error', async () => {
  AlertAcksClient.acknowledge = async () => { throw new Error('boom'); };
  AlertAckModal.open({ plant: 'P1', alertId: 'a1' });
  els['aak-reason'].value = 'x';
  await AlertAckModal.submit();
  assert.deepEqual(calls.closed, []);
  assert.equal(calls.toast.length, 1);
  assert.equal(calls.toast[0][1], 'error');
});

test('bulk mode: the title counts the alerts and one submit calls acknowledgeMany once with every id', async () => {
  const many = [];
  const priorMany = AlertAcksClient.acknowledgeMany;
  AlertAcksClient.acknowledgeMany = async (...args) => { many.push(args); return { ok: 3, failed: 0 }; };
  try {
    AlertAckModal.open({ plant: 'P1', alertIds: ['a1', 'a2', 'a3'] });
    assert.match(els['aak-title'].textContent, /^am\.ack_title_n/);
    els['aak-reason'].value = '  waiting for the mould  ';
    await AlertAckModal.submit();
    assert.deepEqual(many, [['P1', ['a1', 'a2', 'a3'], 'waiting for the mould', '2026-10-27T23:59:59']]);
    assert.equal(calls.ack.length, 0, 'the single-alert endpoint is not used');
    assert.deepEqual(calls.toast, [['am.ack_bulk_done', 'success']]);
    assert.deepEqual(calls.closed, ['modal-alert-ack']);
  } finally { AlertAcksClient.acknowledgeMany = priorMany; }
});

test('bulk mode: a partial result toasts the failures; No end date sends null; a failed request keeps the modal open', async () => {
  const priorMany = AlertAcksClient.acknowledgeMany;
  const sent = [];
  AlertAcksClient.acknowledgeMany = async (...args) => { sent.push(args); return { ok: 2, failed: 1 }; };
  try {
    AlertAckModal.open({ plant: 'P1', alertIds: ['a1', 'a2', 'a3'] });
    els['aak-reason'].value = 'known issue';
    globalThis.document.getElementById('aak-noend').checked = true;
    await AlertAckModal.submit();
    assert.equal(sent[0][3], null);
    assert.deepEqual(calls.toast, [['am.ack_bulk_partial', 'warn']]);

    calls.toast = []; calls.closed = [];
    AlertAcksClient.acknowledgeMany = async () => { throw new Error('boom'); };
    AlertAckModal.open({ plant: 'P1', alertIds: ['a1', 'a2'] });
    els['aak-reason'].value = 'x';
    await AlertAckModal.submit();
    assert.deepEqual(calls.closed, []);
    assert.equal(calls.toast.length, 1);
    assert.equal(calls.toast[0][1], 'error');
  } finally { AlertAcksClient.acknowledgeMany = priorMany; }
});

test('one id (alertId or a one-element alertIds) keeps the single-alert title and request; an empty list does not open', async () => {
  AlertAckModal.open({ plant: 'P1', alertIds: ['a9'] });
  assert.equal(els['aak-title'].textContent, 'am.ack_title');
  els['aak-reason'].value = 'x';
  await AlertAckModal.submit();
  assert.deepEqual(calls.ack.map(c => c.alert_id), ['a9']);
  AlertAckModal.open({ plant: 'P1', alertIds: [] });
  assert.equal(AlertAckModal.isOpenFor('P1'), false);
});
