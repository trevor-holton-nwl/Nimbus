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
  assert.deepEqual([BL.idempotent, BL.dryRun], [false, { param: 'apply_mode', value: 'propose' }]);
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

// ---- W4b fix wave
const TD = { t: (k, v) => (v ? `${k}|${JSON.stringify(v)}` : k) };

test('stepFacts reads the backlog counts from summary.backlog and the new step counts', () => {
  const facts = s => Object.fromEntries(M.stepFacts({ summary: s }).map(f => [f.key, f.value]));
  assert.deepEqual(facts({ moved: 4, dropped: 1, backlog: { found: 6, running_moved: 1, running_skipped: 0, moved: 4 } }), { moved: 4, dropped: 1, found: 6, running_moved: 1, running_skipped: 0 });
  assert.deepEqual(facts({ resolved: 12, unknown: 3 }), { resolved: 12, unknown: 3 });
  assert.deepEqual(facts({ unmatched_pairs: 2, unmatched_orders: 5 }), { unmatched_pairs: 2, unmatched_orders: 5 });
  assert.deepEqual(facts({ applied_batches: 2, applied: [{ object: 'x' }] }), { applied_batches: 2 }, 'a per-object applied list is not a count');
});

test('stepDetailLines: warning text, known notes translated, one line per SAP object (held needs a person)', () => {
  assert.deepEqual(M.stepDetailLines({ summary: { warnings: ['3 order(s) held for unknown routing data'] } }, TD), ['3 order(s) held for unknown routing data']);
  assert.deepEqual(M.stepDetailLines({ summary: { skipped: 'routing_off', note: 'routing run times are switched off for this plant' } }, TD), ['jobs.note_routing_off']);
  assert.deepEqual(M.stepDetailLines({ summary: { note: 'no validated batch to apply' } }, TD), ['jobs.note_sap_none']);
  const lines = M.stepDetailLines({ summary: { notes: [{ object: 'stage_material_plants', result: 'held' }, { object: 'stage_planned_orders', result: 'applied' }] } }, { t: (k) => ({ 'jobs.sap_res_held': 'Held: needs a person', 'jobs.sap_res_applied': 'Applied', 'jobs.p.sap.apply_batch.objects.stage_material_plants': 'Material-plant rows', 'jobs.p.sap.apply_batch.objects.stage_planned_orders': 'Planned orders' }[k] ?? k) });
  assert.deepEqual(lines, ['Material-plant rows: Held: needs a person', 'Planned orders: Applied']);
  assert.deepEqual(M.stepDetailLines({ summary: null }, TD), []);
});

test('an unavailable type that reaches the form shows selected-but-disabled and fails validation visibly', () => {
  const sendStep = { ...M.newStep(SEND), type: 'sap.send' };
  const card = stepCardHtml(sendStep, 0, 1, TYPES, true);
  assert.match(card, /<option value="sap\.send" disabled selected/);
  const errs = M.validateChain([sendStep], TYPES);
  assert.equal(errs.stepParams[0]._type, 'jobs.err_type_unavailable');
  const f = M.defaultJobForm('1008', 'sap.send', SEND.defaults, SEND);
  assert.equal(M.validateJobForm({ ...f, name: 'x' }, { isAdmin: true, plants: null, meta: SEND, types: TYPES }).type, 'jobs.err_type_unavailable');
  assert.equal(M.validateJobForm({ ...M.defaultJobForm('1008', 'optimizer.plant', OPT.defaults, OPT), name: 'x' }, { isAdmin: true, plants: null, meta: OPT, types: TYPES }).type, undefined);
  const html = bodyHtml({ ...f, name: 'x' }, 'new', true, SEND, TYPES, []);
  assert.match(html, /<option value="sap\.send" disabled selected/);
  assert.match(html, /job-unavail-hint/, 'the reason is visible under the single-job type select too');
  assert.match(html, /id="jb-err-type"/);
});

test('new strings exist in all five locales', () => {
  const need = ['jobs.tile_found', 'jobs.tile_running_moved', 'jobs.tile_running_skipped', 'jobs.tile_resolved', 'jobs.tile_unknown', 'jobs.tile_unmatched_pairs',
    'jobs.tile_unmatched_orders', 'jobs.tile_applied_batches', 'jobs.note_routing_off', 'jobs.note_sap_none', 'jobs.sap_res_applied', 'jobs.sap_res_held', 'jobs.sap_res_error',
    'jobs.sap_res_ready', 'jobs.sap_res_applying', 'jobs.sap_res_nothing', 'jobs.sap_res_would_apply', 'jobs.sap_res_superseded', 'jobs.prop_step_only', 'jobs.prop_step_earlier',
    'jobs.err_type_unavailable', 'jobs.p.sap.apply_batch.objects.hint'];
  for (const loc of ['en', 'de', 'es', 'fr', 'pt']) {
    const text = readFileSync(new URL(`../../../frontend/locales/${loc}.js`, import.meta.url), 'utf8');
    for (const k of need) assert.ok(text.includes(`'${k}':`), `${loc}: ${k}`);
  }
  const en = readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8');
  assert.match(en, /Running orders are re-placed from the current time on every run/);
});
