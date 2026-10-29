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

const { errorPanelHtml, stepBarHtml, tilesHtml, resultBadgeHtml, logRowHtml, proposalRowHtml, artifactSectionHtml, artifactRowHtml, reportBadgeHtml } = await import('../../../frontend/admin-ops/jobs-run-detail.mjs');

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

const section = over => ({ key: 'orders', title: 'Late orders', columns: [{ key: 'machine', label: 'Machine' }, { key: 'days_late', label: 'Days late' }],
  rows: [['L1', 2.5]], rowCount: 1, rowsStored: 1, truncated: false, offset: 0, ...over });

test('artifact section: a labelled table (title, column headers, row count) with a per-section CSV button', () => {
  const html = artifactSectionHtml(section());
  assert.match(html, /<h4 id="jr-art-h-orders">Late orders<\/h4>/);
  assert.match(html, /role="table" style="--cols:2" aria-labelledby="jr-art-h-orders" aria-rowcount="2"/, 'rows plus the header row');
  assert.equal((html.match(/role="columnheader"/g) || []).length, 2);
  assert.match(html, /id="jr-art-list-orders"[^>]*role="rowgroup"[^>]*aria-label="Late orders"/);
  assert.match(html, /data-jr-act="art-csv" data-art-sec="orders">jobs\.a\.csv</);
  assert.match(html, /id="jr-art-count-orders">jobs\.a\.rows</);
  assert.doesNotMatch(html, /jobs\.a\.truncated/);
});

test('artifact section: a truncated section says how many of how many; an empty one has no table and no CSV', () => {
  assert.match(artifactSectionHtml(section({ rowCount: 9000, rowsStored: 4000, truncated: true })), /role="note">jobs\.a\.truncated</);
  const empty = artifactSectionHtml(section({ rows: [], rowCount: 0, rowsStored: 0 }));
  assert.doesNotMatch(empty, /role="table"/); assert.match(empty, /jobs\.a\.empty/); assert.match(empty, /data-jr-act="art-csv"[^>]*disabled/);
  assert.match(artifactSectionHtml(section({ title: '<b>x</b>' })), /&lt;b&gt;x&lt;\/b&gt;/, 'titles are escaped');
});

test('artifact row: one cell per column, null empty, values escaped, the grid width comes from --cols', () => {
  const html = artifactRowHtml(3, ['<i>', null, 2.456]);   // a bare column count still works (untyped cells)
  assert.match(html, /role="row" style="--cols:3"/);
  assert.equal((html.match(/role="cell"/g) || []).length, 3);
  assert.match(html, /&lt;i&gt;/); assert.doesNotMatch(html, /<i>/); assert.match(html, />2\.46</);
});

test('a report run shows its row counts as kpi-tiles in the report\'s own order, plus the Report badge', () => {
  const html = tilesHtml(run({ status: 'warning', summary: { row_counts: { by_machine: 3, orders: 12 }, rows: 15 } }));
  assert.equal((html.match(/class="kpi-tile/g) || []).length, 2);
  assert.ok(html.indexOf('>3<') < html.indexOf('>12<'));
  assert.match(html, /<div class="k">by machine</, 'no locale loaded here: the key spelled out (jobs.a.tile.by_machine is used when translated)');
  assert.match(reportBadgeHtml(), /badge-info job-kind[^>]*>jobs\.kind_report</);
});

test('there is no Approve or Discard control in the run detail source', () => {
  const src = readFileSync(new URL('../../../frontend/admin-ops/jobs-run-detail.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /data-jr-act="(approve|discard)|\/(approve|discard)|act === '(approve|discard)'/i);
  const client = readFileSync(new URL('../../../frontend/admin-ops/jobs-client.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /approve|discard/i, 'the client has no such call');
});

test('typed cells: datetime reads as plant time through the display format, bool translates, sentinels and codes translate, dates are not raw ISO', () => {
  const cols = [{ key: 'finish', label: 'Finish', type: 'datetime' }, { key: 'machine', label: 'Machine', type: 'text' }, { key: 'flag', label: 'Flag', type: 'bool' },
    { key: 'status', label: 'Status', type: 'text' }, { key: 'due', label: 'Due', type: 'date' }];
  const html = artifactRowHtml(cols, ['2026-10-28T14:30:00', '__plant_total__', true, 'yes', '2026-10-28']);
  assert.doesNotMatch(html, /2026-10-28T14:30:00/, 'no raw ISO in the cell');
  assert.match(html, /14:30|2:30/);
  assert.match(html, />jobs\.a\.yes</, 'the boolean is translated');
  assert.match(html, />yes</, 'a TEXT column that happens to hold the word yes is left alone');
  assert.doesNotMatch(html, />2026-10-28</, 'a date cell is formatted');
});

test('a section with a datetime column says the times are plant time; the section id is escaped', () => {
  const sec = { key: 'orders', title: 'Late', columns: [{ key: 'finish', label: 'Finish', type: 'datetime' }], rows: [['2026-10-28T09:00:00']], rowCount: 1, rowsStored: 1, truncated: false, offset: 0 };
  assert.match(artifactSectionHtml(sec, 'America/Chicago'), /job-art-tz/);
  assert.doesNotMatch(artifactSectionHtml({ ...sec, columns: [{ key: 'n', label: 'N', type: 'number' }] }), /job-art-tz/);
});
