// Tests for the HTML builders of frontend/admin-ops/jobs-run-detail.mts: the Error panel of a failed run, the neutral
// step bar, kpi-tile result tiles, the Apply / Dry run badge, log rows with collapsed data, and the proposal row.
// No Approve or Discard control may exist anywhere in the detail (SAP-style: a dry run is only viewed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installDom } from '../helpers/dom-stub.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
installDom();

const { errorPanelHtml, stepBarHtml, tilesHtml, resultBadgeHtml, logRowHtml, proposalRowHtml } = await import('../../../frontend/admin-ops/jobs-run-detail.mjs');

const run = over => ({ id: 7, job_id: 1, job_name: 'J', plant: '1008', status: 'failed', trigger: 'manual', scheduled_for: null, started_at: null, ended_at: null,
  duration_ms: null, triggered_by: null, summary: null, error: null, log_truncated: false, ...over });

test('a failed run opens on an Error panel: kind badge, failing step, message, jump actions', () => {
  const html = errorPanelHtml(run({ error: 'plant 1008 has no timezone', summary: { error_kind: 'config', failed_step: 'gather' } }));
  assert.match(html, /role="alert"/);
  assert.match(html, /jobs\.error_kind_config/); assert.match(html, /gather/); assert.match(html, /no timezone/);
  assert.match(html, /data-jr-act="show-errors"[^>]*\shidden/); assert.match(html, /data-jr-act="first-error"[^>]*\shidden/);   // shown only once the log has an error line
  assert.match(errorPanelHtml(run({ error: 'x', summary: { error_kind: 'transient' } })), /badge-warn[^>]*>jobs\.error_kind_transient/);
  assert.match(errorPanelHtml(run({ error: 'timed out after 600s', summary: { error_kind: 'system' } })), /badge-err[^>]*>jobs\.error_kind_system/);
  assert.equal(errorPanelHtml(run({ status: 'succeeded', error: null })), '', 'no panel for a finished run');
  assert.doesNotMatch(errorPanelHtml(run({ error: '<img src=x onerror=1>' })), /<img/, 'the message is escaped');
});

test('step bar: one neutral fill, only the failed step is marked, mono labels', () => {
  const steps = [{ step: 'gather', duration_ms: 1000 }, { step: 'optimize', duration_ms: 3000 }];
  const ok = stepBarHtml(run({ status: 'succeeded', summary: { steps } }));
  assert.equal((ok.match(/class="job-step"/g) || []).length, 2);
  assert.doesNotMatch(ok, /job-step-\d|job-step-failed/);
  assert.match(ok, /<li class="job-mono">/);
  const bad = stepBarHtml(run({ summary: { steps, failed_step: 'optimize' } }));
  assert.equal((bad.match(/job-step-failed/g) || []).length, 1);
  assert.equal(stepBarHtml(run({ summary: {} })), '');
});

test('result tiles are kpi-tiles; dropped above zero is a warn tile', () => {
  const html = tilesHtml(run({ status: 'warning', summary: { late: 3, moved: 12, dropped: 2, action_id: 'a-1' } }));
  assert.equal((html.match(/class="kpi-tile/g) || []).length, 4);
  assert.match(html, /kpi-tile warn"><div class="k">jobs\.tile_dropped/);
  assert.match(html, /<div class="v">12<\/div>/);
  assert.equal(tilesHtml(run({ summary: {} })), '');
});

test('result badge: Apply and Dry run for optimizer runs, nothing for others', () => {
  assert.match(resultBadgeHtml({ summary: { apply_mode: 'propose' } }), /badge-info job-result[^>]*>jobs\.result_propose</);
  assert.match(resultBadgeHtml({ summary: { apply_mode: 'apply' } }), />jobs\.result_apply</);
  assert.equal(resultBadgeHtml({ summary: null }), '');
  assert.equal(resultBadgeHtml({ summary: { apply_mode: 'x' } }), '');
});

test('log row: elapsed column, and structured data only under its line when expanded', () => {
  const l = { seq: 3, at: '2026-10-29T12:00:03+00:00', level: 'warn', step: 'guard', msg: 'dropped 2', data: { dropped: ['A:running'] } };
  const closed = logRowHtml(l, 'UTC', '2026-10-29T12:00:00+00:00', false);
  assert.match(closed, /job-log-el job-mono">\+0:03\.0</);
  assert.match(closed, /data-jr-data="3" aria-expanded="false"/);
  assert.doesNotMatch(closed, /<pre/);
  const open = logRowHtml(l, 'UTC', '2026-10-29T12:00:00+00:00', true);
  assert.match(open, /aria-expanded="true"/); assert.match(open, /<pre class="job-log-data job-mono">[\s\S]*A:running/);
  assert.doesNotMatch(logRowHtml({ ...l, data: {} }, 'UTC', null, false), /data-jr-data/, 'no toggle without data');
});

test('proposal row: before and after finish, signed delta, status; a changed-since row is dimmed and said so', () => {
  const html = proposalRowHtml({ id: '1008-100', machine: 'L1', finishBefore: '2026-10-30T10:00:00', finishAfter: '2026-10-30T14:00:00', deltaHours: 4, status: 'scheduled', changedSince: false });
  assert.match(html, /1008-100/); assert.match(html, /\+4 h/); assert.doesNotMatch(html, /job-prop-stale/);
  assert.match(proposalRowHtml({ id: 'x', machine: null, finishBefore: null, finishAfter: null, deltaHours: null, status: null, changedSince: true }), /job-prop-stale[\s\S]*jobs\.prop_changed/);
});

test('there is no Approve or Discard control in the run detail source', () => {
  const src = readFileSync(new URL('../../../frontend/admin-ops/jobs-run-detail.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /data-jr-act="(approve|discard)|\/(approve|discard)|act === '(approve|discard)'/i);
  const client = readFileSync(new URL('../../../frontend/admin-ops/jobs-client.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /approve|discard/i, 'the client has no such call');
});
