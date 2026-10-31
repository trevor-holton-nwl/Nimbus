// F1 (2026-10-30): order-less detail rows, the narrow side-list layout, Inbox/facet height, collapsible Top fixes,
// "Open in Orders" for multi-order / queued fixes, and the fixed-width Matrix columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rowHtml, rowDetailHtml, detailHeightFor, ROW_H, ROW_H_NARROW, NARROW_AT, fixPrimaryAction, levActions, fixesSectionHtml,
} from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', '..', '..', 'frontend', 'styles.css'), 'utf8');
const t = (k, v) => `${k}${v ? '|' + Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',') : ''}`;
const block = sel => {
  const i = CSS.indexOf(`\n${sel}`);
  assert.ok(i >= 0, `styles.css has ${sel}`);
  return CSS.slice(i, CSS.indexOf('}', i));
};

// ---- rowDetailHtml: optional trio, machine-day label, overload line, Day details --------------------------------

const full = { message: 'm', material: 'Widget', due: 'Fri', plannedFinish: 'Sat', firming: 'Not firmed', t };

test('rowDetailHtml: a line whose value is undefined is skipped (no em-dash placeholder)', () => {
  const html = rowDetailHtml({ id: 'a1' }, { message: 'Overloaded', material: 'M1 · Mon', t });
  assert.match(html, /am\.detail_alert/);
  assert.match(html, /am\.detail_material/);
  for (const k of ['due', 'finish', 'firming']) assert.doesNotMatch(html, new RegExp(`am\\.detail_${k}`));
  assert.doesNotMatch(html, /—/);
  const withTask = rowDetailHtml({ id: 'a1' }, full);
  for (const k of ['due', 'finish', 'firming']) assert.match(withTask, new RegExp(`am\\.detail_${k}`));
});

test('rowDetailHtml: an order-less alert labels the first line "Machine · day"', () => {
  const html = rowDetailHtml({ id: 'a1' }, { message: 'x', material: 'M1 · Mon', materialLabelKey: 'am.detail_machine_day', t });
  assert.match(html, /am\.detail_machine_day<\/b>M1 · Mon/);
  assert.doesNotMatch(html, /am\.detail_material/);
});

test('rowDetailHtml: the overload line and the Day details action render only when asked for', () => {
  const html = rowDetailHtml({ id: 'a"4' }, { message: 'x', material: 'M1 · Mon', ordersOnDay: 3, dayAction: true, t });
  assert.match(html, /am\.detail_orders_on_day<\/b>3</);
  assert.match(html, /<button[^>]*data-alert-action="cell"[^>]*data-alert-id="a&quot;4"[^>]*>am\.day_details<\/button>/);
  const plain = rowDetailHtml({ id: 'a1' }, full);
  assert.doesNotMatch(plain, /detail_orders_on_day|data-alert-action="cell"/);
  assert.match(rowDetailHtml({ id: 'a1' }, { message: 'x', material: 'y', ordersOnDay: 0, t }), /detail_orders_on_day<\/b>0</, 'zero is a number, not a missing value');
});

test('detailHeightFor follows the lines rendered: fewer lines, shorter block; the narrow list is 32 px per line', () => {
  const trio = detailHeightFor(full);
  const bare = detailHeightFor({ message: 'm', material: 'y', t });
  const overload = detailHeightFor({ message: 'm', material: 'y', ordersOnDay: 2, dayAction: true, t });
  assert.equal(bare, trio, 'four cells fit one row: the trio does not add height in the wide layout');
  assert.ok(detailHeightFor({ message: 'm', material: 'y', due: 'a', plannedFinish: 'b', firming: 'c', ordersOnDay: 1, t }) > trio, 'a fifth line wraps to a second row');
  assert.ok(overload > bare, 'the action row adds height');
  assert.equal(detailHeightFor(full, true), 16 + 32 * 5, 'message + material + due + finish + firming');
  assert.equal(detailHeightFor({ message: 'm', material: 'y', t }, true), 16 + 32 * 2);
  assert.equal(detailHeightFor({ message: 'm', material: 'y', ordersOnDay: 1, dayAction: true, t }, true), 16 + 32 * 4);
});

test('rowDetailHtml writes both heights as custom properties on the block, in step with detailHeightFor', () => {
  const html = rowDetailHtml({ id: 'a1' }, full);
  assert.ok(html.includes(`--am-xd-h:${detailHeightFor(full)}px`));
  assert.ok(html.includes(`--am-xd-hn:${detailHeightFor(full, true)}px`));
  assert.match(html, /^<div class="am-xdetail"/);
});

test('narrow rows are two lines tall and the breakpoint matches the CSS container query', () => {
  assert.equal(ROW_H, 32);
  assert.ok(ROW_H_NARROW > ROW_H);
  assert.equal(NARROW_AT, 520);
  assert.match(CSS, new RegExp(`@container \\(max-width: ${NARROW_AT}px\\)`));
});

// ---- CSS pins ----------------------------------------------------------------------------------------------------

test('CSS: the side list and the Inbox list are inline-size containers with the narrow row and detail rules', () => {
  assert.match(block('.am-side {'), /container-type:\s*inline-size/);
  assert.match(block('.am-ib-main {'), /container-type:\s*inline-size/);
  const i = CSS.indexOf(`@container (max-width: ${NARROW_AT}px)`);
  const q = CSS.slice(i, i + 3000);
  assert.match(q, /\.am-xrow/);
  assert.match(q, /.am-sub/);
  assert.match(q, /grid-area/);
  assert.match(q, /\.am-xdetail/);
  assert.match(q, /overflow-wrap:\s*anywhere/);
  assert.match(q, /min-width:\s*0/);
});

test('CSS: the Inbox list fills the facet column (no max-height) and the wrapper keeps the viewport minimum', () => {
  assert.doesNotMatch(block('.am-ib-scroll {'), /max-height\s*:\s*calc/);
  assert.match(block('.am-ib-scroll {'), /flex:\s*1 1 auto/);
  assert.match(block('.am-ib-main {'), /display:\s*flex/);
  assert.match(block('.am-ib {'), /min-height:\s*calc\(100vh - var\(--chrome-h\) - 300px\)/);
  assert.match(block('.am-ib {'), /align-items:\s*stretch/);
  assert.match(block('body.update-available .am-ib {'), /min-height:\s*calc\(100vh - var\(--chrome-h\) - 300px - var\(--update-banner-h\)\)/);
  assert.doesNotMatch(CSS, /body\.update-available \.am-ib-scroll/);
});

test('CSS: matrix data columns are 64 px and the box scrolls in both axes', () => {
  assert.match(CSS, /\.am-mx-table th:not\(\.am-mx-rh\), \.am-mx-table td:not\(\.am-mx-rh\)\s*\{[^}]*width:\s*64px;[^}]*min-width:\s*64px/);
  assert.match(block('.am-mx-scroll {'), /overflow:\s*auto/);
  assert.match(CSS, /th\.am-mx-rh\s*\{[^}]*min-width:\s*200px/);
});

// ---- fixPrimaryAction + levActions ---------------------------------------------------------------------------

const alertsById = new Map([
  ['np', { id: 'np', type: 'needs_planning' }], ['qn', { id: 'qn', type: 'queued_now_fits' }], ['ov', { id: 'ov', type: 'overlap' }],
]);
test('fixPrimaryAction: one placed order -> gantt; several orders or any queued alert -> orders', () => {
  assert.equal(fixPrimaryAction({ orderIds: ['T1'], alertIds: ['ov'] }, alertsById), 'gantt');
  assert.equal(fixPrimaryAction({ orderIds: ['T1', 'T2'], alertIds: ['ov'] }, alertsById), 'orders');
  assert.equal(fixPrimaryAction({ orderIds: ['T1'], alertIds: ['np'] }, alertsById), 'orders', 'queued: no bar exists');
  assert.equal(fixPrimaryAction({ orderIds: ['T1'], alertIds: ['ov', 'qn'] }, alertsById), 'orders');
  assert.equal(fixPrimaryAction({ orderIds: [], alertIds: ['ov'] }, alertsById), 'gantt', 'nothing to open in a table');
  assert.equal(fixPrimaryAction({ orderIds: ['T1'], alertIds: ['missing'] }, alertsById), 'gantt', 'an unknown alert id is not queued');
});

const lctx = (extra = {}) => ({ remaining: 0, canReviewPairs: true, isAdmin: true, setupActive: true, whatIf: false, fieldLabel: k => k, alertsById, ...extra });
const item = (o = {}) => ({
  family: 'needs-planning', key: 'k', titleKey: 'x', titleVars: {}, alertIds: ['np'], orderIds: ['T1', 'T2'], lines: [], points: 1,
  confidenceBefore: 90, confidenceAfter: null, method: 'none', outsideConfidenceWindowCount: 0,
  action: { kind: 'needs-planning', alertIds: ['np'] }, ...o,
});

test('levActions: a queued or multi-order fix opens the Orders table as its primary; Gantt moves to the menu', () => {
  const a = levActions(item(), lctx());
  assert.equal(a.primary.act, 'open-table');
  assert.equal(a.primary.labelKey, 'am.open_in_orders');
  assert.ok(a.menu.some(x => x.act === 'show-alerts'), 'Show on Gantt stays reachable');
  assert.ok(!a.menu.some(x => x.act === 'open-table'), 'no duplicate');
});

test('levActions: a single placed order keeps its Gantt primary; Go To and fixes that write keep theirs', () => {
  const tool = item({ family: 'tool', alertIds: ['ov'], orderIds: ['T1'], action: { kind: 'tool', tool: 'X', available: 1, inUse: 2, hasRow: true } });
  assert.equal(levActions(tool, lctx()).primary.act, 'focus-first');
  const multiTool = item({ family: 'tool', alertIds: ['ov'], orderIds: ['T1', 'T2'], action: { kind: 'tool', tool: 'X', available: 1, inUse: 2, hasRow: true } });
  assert.equal(levActions(multiTool, lctx()).primary.act, 'focus-first', 'Go To selects the holders itself; only the outline primary is swapped');
  const outline = item({ family: 'routing-gap', alertIds: ['ov'], orderIds: ['T1', 'T2'], action: { kind: 'routing-gap', step: 'other' } });
  assert.equal(levActions(outline, lctx()).primary.act, 'copy-summary', 'not a show-me primary: untouched');
  const cal = item({ family: 'calendar-day', alertIds: ['ov'], orderIds: ['T1', 'T2'], action: { kind: 'calendar-day', line: 'M1', dayKey: '2026-10-30', fixableAlertIds: ['ov'] } });
  assert.equal(levActions(cal, lctx()).primary.act, 'cal-fix', 'a fix that writes is not replaced');
});

// ---- collapsible Top fixes -------------------------------------------------------------------------------------

const fixOpts = (extra = {}) => ({ isAdmin: true, adminOpen: false, limit: 5, computing: false, ctxFor: () => lctx(), ...extra });
test('fixesSectionHtml: the head carries a caret toggle and the count; collapsed shows only the head', () => {
  const items = [item({ key: 'a' }), item({ key: 'b' })];
  const open = fixesSectionHtml(items, fixOpts(), t);
  assert.match(open, /<button[^>]*data-am-action="fixes-toggle"[^>]*aria-expanded="true"/);
  assert.match(open, /am\.fixes_title<\/h3>/);
  assert.match(open, /am-fix-list/);
  const shut = fixesSectionHtml(items, fixOpts({ collapsed: true }), t);
  assert.match(shut, /aria-expanded="false"/);
  assert.doesNotMatch(shut, /am-fix-list|am-more|am-fix-divider/);
  assert.match(shut, /am\.fixes_title[^<]*<\/h3>/);
  assert.match(shut, /class="am-fixes-count"[^>]*>2</, 'the live count stays visible');
  assert.match(open, /class="am-fixes-count"[^>]*>2</);
});

// ---- the row keeps its markup contract -------------------------------------------------------------------------

test('rowHtml still renders the 5 spans the narrow grid areas address', () => {
  const a = { id: 'a1', sev: 'err', type: 'overlap', line: 'M1', time: new Date(2026, 9, 30), taskId: 'T1' };
  const html = rowHtml(a, { hideMachine: false, open: false, material: 'Widget', tag: 'Overlap', t, orderNo: 'O1', dueText: 'Fri' });
  for (const c of ['am-sev', 'am-gdot', 'am-oid', 'am-mat', 'am-mc', 'am-tag', 'am-due', 'am-acts']) assert.match(html, new RegExp(`class="${c}[ "]`));
});
