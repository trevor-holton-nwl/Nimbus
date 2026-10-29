// W4b: the new step types in the chain builder (Remove backlog, routing recompute, attribute resync, SAP apply) and the
// disabled Send to SAP scaffold. Rendered from the served type metadata (tests/fixtures/jobs_types.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom } from '../helpers/dom-stub.mjs';
import { TYPES, byKey } from './jobs-types-fixture.mjs';
import * as M from '../../../frontend/admin-ops/jobs-model.mjs';
import { stepCardHtml, chainHtml, bodyHtml } from '../../../frontend/admin-ops/jobs-dialog.mjs';

installDom();
const BL = byKey('optimizer.backlog'); const SEND = byKey('sap.send'); const RR = byKey('routing.recompute');
const AR = byKey('attributes.resync'); const SA = byKey('sap.apply_batch'); const OPT = byKey('optimizer.plant');
const step = (meta, over = {}) => ({ ...M.newStep(meta), ...over });
const D = { t: (k, v) => (k === 'jobs.type_unavailable_why' ? `Not available yet: ${v.reason}` : k), esc: s => String(s) };

test('served contract: backlog defaults to running orders included, Send to SAP is unavailable with its reason', () => {
  assert.deepEqual(BL.defaults, { include_running: true, apply_mode: 'apply' });
  assert.deepEqual([BL.idempotent, BL.dryRun], [true, { param: 'apply_mode', value: 'propose' }]);
  assert.deepEqual(BL.lockKeys, ['jobs:optimizer.backlog:{plant}', 'jobs:optimizer.plant:{plant}']);
  assert.deepEqual([SEND.available, SEND.unavailableReason, SEND.idempotent], [false, 'SAP interface is not live', false]);
  assert.equal(OPT.available, true);
  assert.deepEqual([RR.params.length, AR.params.length, RR.idempotent, AR.idempotent], [0, 0, true, true]);
  assert.deepEqual(SA.dryRun, { param: 'dry_run', value: true });
});

test('type groups: optimizer.* is Optimization, purge / routing / attributes are Data, sap.* is SAP', () => {
  assert.deepEqual(['optimizer.backlog', 'purge.orders', 'routing.recompute', 'attributes.resync', 'sap.apply_batch', 'sap.send', 'report.coverage', 'chain']
    .map(k => M.typeGroupOf(byKey(k))), ['action', 'data', 'data', 'data', 'sap', 'sap', 'report', 'chain']);
});

test('unavailableWhy prefers the translated reason, falls back to the server text; isUnavailable reads the flag', () => {
  assert.equal(M.isUnavailable(SEND), true); assert.equal(M.isUnavailable(OPT), false); assert.equal(M.isUnavailable(null), false);
  assert.equal(M.unavailableWhy(SEND, D), 'Not available yet: SAP interface is not live');
  const tr = { t: (k, v) => (k === 'jobs.type.sap.send.unavailable' ? 'Die SAP-Schnittstelle ist noch nicht aktiv' : k === 'jobs.type_unavailable_why' ? `Noch nicht: ${v.reason}` : k) };
  assert.equal(M.unavailableWhy(SEND, tr), 'Noch nicht: Die SAP-Schnittstelle ist noch nicht aktiv');
});

test('the add-step select lists Send to SAP disabled, the step card does too, and the reason is visible', () => {
  const f = { ...M.defaultJobForm('1008', 'chain', null, byKey('chain')), steps: [step(BL)] };
  const html = chainHtml(f, TYPES, true, [], 'new');
  assert.match(html, /<option value="sap\.send" disabled title="[^"]*"/);
  assert.doesNotMatch(html, /<option value="sap\.apply_batch"[^>]*disabled/);
  assert.match(html, /job-unavail-hint/, 'a visible line, not only a tooltip');
  assert.match(html, /<optgroup label="jobs\.group_data">/); assert.match(html, /<optgroup label="jobs\.group_sap">/);
  assert.match(stepCardHtml(step(BL), 0, 1, TYPES, true), /<option value="sap\.send" disabled/);
});

test('a backlog step shows the include-running checkbox (checked by default) with its hint and the Result control', () => {
  const html = stepCardHtml(step(BL), 0, 1, TYPES, true);
  assert.match(html, /id="jb-s0-p-include_running" checked/);
  // (the hint text itself is a locale key, pinned by the locale test below; no locale is loaded in this harness)
  assert.match(html, /id="jb-s0-p-apply_mode"/);
  const off = stepCardHtml(step(BL, { params: { include_running: false, apply_mode: 'apply' } }), 0, 1, TYPES, true);
  assert.doesNotMatch(off, /id="jb-s0-p-include_running" checked/);
});

test('parameterless steps render no param controls; SAP apply renders its object boxes and dry-run box', () => {
  for (const meta of [RR, AR]) assert.doesNotMatch(stepCardHtml(step(meta), 0, 1, TYPES, true), /id="jb-s0-p-/);
  const sa = stepCardHtml(step(SA), 0, 1, TYPES, true);
  assert.match(sa, /id="jb-s0-p-objects-stage_planned_orders"/); assert.match(sa, /id="jb-s0-p-dry_run"/);
});

test('a single-job dialog also lists the new types, Send to SAP disabled', () => {
  const html = bodyHtml(M.defaultJobForm('1008', 'optimizer.backlog', BL.defaults, BL), 'new', true, BL, TYPES, []);
  assert.match(html, /<option value="optimizer\.backlog" selected/);
  assert.match(html, /<option value="sap\.send" disabled/);
});

test('every new type has its locale keys in all five locales (type label, hint, params)', () => {
  const need = ['jobs.type.optimizer.backlog', 'jobs.type.optimizer.backlog.hint', 'jobs.p.optimizer.backlog.include_running', 'jobs.p.optimizer.backlog.include_running.hint',
    'jobs.type.routing.recompute', 'jobs.type.routing.recompute.hint', 'jobs.type.attributes.resync', 'jobs.type.attributes.resync.hint',
    'jobs.type.sap.apply_batch', 'jobs.type.sap.apply_batch.hint', 'jobs.p.sap.apply_batch.objects', 'jobs.p.sap.apply_batch.dry_run', 'jobs.type.sap.send',
    'jobs.type.sap.send.unavailable', 'jobs.opt_unavailable', 'jobs.type_unavailable_why', 'jobs.group_data', 'jobs.group_sap'];
  for (const loc of ['en', 'de', 'es', 'fr', 'pt']) {
    const text = readFileSync(new URL(`../../../frontend/locales/${loc}.js`, import.meta.url), 'utf8');
    for (const k of need) assert.ok(text.includes(`'${k}':`), `${loc}: ${k}`);
  }
});
