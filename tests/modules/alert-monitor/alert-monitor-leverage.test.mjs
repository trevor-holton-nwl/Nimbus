// Pure builders behind the "High-leverage fixes" panel (frontend/alert-monitor/alert-monitor-model.mts):
// the card (points headline, score / capped / n-a line, method eyebrow, headroom, admin, minutes, remaining),
// the per-family action list and the section (top 5 + show more, skeleton, empty).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const { levActions, levTitle, levSummaryText, levPairsForReview, LEV_TOP_N, LEV_STEP, LEV_MAX_RENDER } = M;
// The stub `t` serialises its vars as JSON; the builders escape quotes, so undo that before matching.
const unq = s => s.replace(/&quot;/g, '"');
const levCardHtml = (...a) => unq(M.levCardHtml(...a));
const levSectionHtml = (...a) => unq(M.levSectionHtml(...a));

const t = (k, v) => (v ? `${k}|${JSON.stringify(v)}` : k);
const ctx = (o = {}) => ({
  capped: false, remaining: 0, canReviewPairs: false, isAdmin: false, setupActive: true, whatIf: false,
  fieldLabel: k => `L:${k}`, ...o,
});
const item = (o = {}) => ({
  family: 'calendar-day', key: 'calendar-day:L1|2026-10-21', titleKey: 'leverage.title.calendar-day',
  titleVars: { n: 3, line: 'L1', day: '2026-10-21' }, alertIds: ['a', 'b', 'c'], orderIds: ['o1', 'o2'], lines: ['L1'],
  points: 12, confidenceBefore: 71, confidenceAfter: 78, method: 'removal', outsideConfidenceWindowCount: 0,
  action: { kind: 'calendar-day', line: 'L1', dayKey: '2026-10-21', fixableAlertIds: ['a'] }, ...o,
});
const pair = (o = {}) => ({
  line: 'L1', fromState: [{ fieldKey: 'colorWheel', value: 'A' }], toState: [{ fieldKey: 'colorWheel', value: 'B' }],
  reason: 'setup-uncovered', successorOrderId: 'o1', predecessorOrderId: 'o0', ...o,
});
const setupItem = (o = {}) => item({
  family: 'setup-pair', key: 'setup-pair:x', titleKey: 'leverage.title.setup-pair',
  titleVars: { from: 'Color A', to: 'Color B', lines: 1, orders: 2 },
  action: { kind: 'open-setup-matrix', plant: 'P1', pairs: [pair()] }, assumedMinutes: 15, minutesSource: 'plantDefault', ...o,
});
const optItem = (o = {}) => item({
  family: 'optimize-window', key: 'optimize-window:L1|2026-10-21|2026-10-23', titleKey: 'leverage.title.optimize-window',
  titleVars: { line: 'L1', from: '2026-10-21', to: '2026-10-23', n: 3 }, confidenceAfter: null, method: 'none', headroomHours: 6.5,
  action: { kind: 'optimize-window', line: 'L1', startDate: '2026-10-21', endDate: '2026-10-23' }, ...o,
});
const acts = (it, c = ctx()) => levActions(it, c).map(a => a.act);

test('the card leads with points; the score line is second', () => {
  const h = levCardHtml(item(), ctx(), t);
  assert.match(h, /class="am-lev-card/);
  const iPts = h.indexOf('am.lev_points|{"n":"12"}');
  const iScore = h.indexOf('am.lev_score|{"before":71,"after":78}');
  assert.ok(iPts > 0 && iScore > iPts, 'points headline precedes the score line');
  assert.match(h, />\+7</, 'the delta shows as +7');
  assert.match(h, /am\.lev_alerts\|\{"n":3,"m":2\}/);
});

test('before === after at the 50-point cap shows the capped message instead of a no-op score', () => {
  const h = levCardHtml(item({ confidenceAfter: 71 }), ctx({ capped: true }), t);
  assert.match(h, /am\.lev_score_capped/);
  assert.doesNotMatch(h, /am\.lev_score\|/);
  // Not at the cap: an unchanged score is simply shown.
  assert.match(levCardHtml(item({ confidenceAfter: 71 }), ctx(), t), /am\.lev_score\|\{"before":71,"after":71\}/);
});

test('zero points shows n/a and outside-the-window, never a score', () => {
  const h = levCardHtml(item({ points: 0, confidenceAfter: 71, outsideConfidenceWindowCount: 3 }), ctx(), t);
  assert.match(h, /am\.lev_conf_na/);
  assert.match(h, /am\.lev_outside_window/);
  assert.doesNotMatch(h, /am\.lev_score/);
  assert.doesNotMatch(h, /am\.lev_partial_window/);
});

test('some alerts outside the window add the partial note', () => {
  const h = levCardHtml(item({ outsideConfidenceWindowCount: 2 }), ctx(), t);
  assert.match(h, /am\.lev_partial_window\|\{"n":2\}/);
});

test('method eyebrow: exact for replay, estimate for removal, none for optimize-window', () => {
  assert.match(levCardHtml(item({ method: 'replay' }), ctx(), t), /am\.lev_method_exact/);
  assert.match(levCardHtml(item({ method: 'removal' }), ctx(), t), /am\.lev_method_estimate/);
  const o = levCardHtml(optItem(), ctx(), t);
  assert.doesNotMatch(o, /am\.lev_method/);
  assert.doesNotMatch(o, /am\.lev_score/);
});

test('optimize-window with headroom leads with Optimize and quotes the free hours', () => {
  const it = optItem();
  const h = levCardHtml(it, ctx(), t);
  assert.match(h, /am\.lev_headroom\|\{"h":"6\.5"\}/);
  const a = levActions(it, ctx());
  assert.equal(a.find(x => x.primary).act, 'optimize');
  assert.ok(a.some(x => x.act === 'diagnose-worst' && !x.primary));
});

test('optimize-window with no headroom leads with Diagnose and demotes Optimize', () => {
  const it = optItem({ headroomHours: -3.2 });
  const h = levCardHtml(it, ctx(), t);
  assert.match(h, /am\.lev_no_headroom\|\{"h":"3\.2"\}/);
  assert.doesNotMatch(h, /am\.lev_headroom\|/);
  const a = levActions(it, ctx());
  assert.equal(a.find(x => x.primary).act, 'diagnose-worst');
  const opt = a.find(x => x.act === 'optimize');
  assert.ok(opt && !opt.primary, 'Optimize is still offered, as a secondary');
  // exactly zero counts as no headroom too
  assert.equal(levActions(optItem({ headroomHours: 0 }), ctx()).find(x => x.primary).act, 'diagnose-worst');
});

test('adminOnly cards carry the admin badge and a copy-summary action', () => {
  const it = item({ family: 'routing-gap', key: 'routing-gap:pv_missing|M1', titleKey: 'leverage.title.routing-gap.pv_missing',
    titleVars: { n: 2, step: 'pv_missing', material: 'M1', pv: '', machine: '' }, adminOnly: true,
    action: { kind: 'routing-gap', step: 'pv_missing', material: 'M1', pv: '', machine: '' } });
  const h = levCardHtml(it, ctx(), t);
  assert.match(h, /am\.lev_admin_fix/);
  assert.match(h, /data-lev-action="copy-summary"/);
  assert.match(h, /am\.lev_copy_summary/);
  assert.doesNotMatch(levCardHtml(item(), ctx(), t), /am\.lev_admin_fix/);
});

test('a requiresMinutes card asks for minutes and never shows a predicted score', () => {
  const it = setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null, confidenceAfter: 78, method: 'removal' });
  const h = levCardHtml(it, ctx(), t);
  assert.match(h, /am\.lev_needs_minutes/);
  assert.match(h, /<input[^>]*data-lev-minutes="setup-pair:x"/);
  assert.match(h, /placeholder="am\.lev_minutes_ph"/);
  assert.doesNotMatch(h, /am\.lev_score/);
  assert.doesNotMatch(h, /78/);
  assert.doesNotMatch(h, /am\.lev_method/);
  assert.match(h, /am\.lev_points/, 'the points at stake are still facts');
});

test('after the replay returns the same card shows the exact score', () => {
  const it = setupItem({ requiresMinutes: false, assumedMinutes: 12, minutesSource: 'user', method: 'replay', confidenceAfter: 75 });
  const h = levCardHtml(it, ctx(), t);
  assert.doesNotMatch(h, /am\.lev_needs_minutes/);
  assert.match(h, /am\.lev_score\|\{"before":71,"after":75\}/);
  assert.match(h, /am\.lev_method_exact/);
});

test('a card whose alerts persist after a fix attempt shows the remaining count', () => {
  assert.match(levCardHtml(item(), ctx({ remaining: 2 }), t), /am\.lev_remaining\|\{"n":2\}/);
  assert.doesNotMatch(levCardHtml(item(), ctx(), t), /am\.lev_remaining/);
});

test('setup-pair titles are re-localised from the pair states, not the engine English', () => {
  const title = levTitle(setupItem(), ctx(), t);
  assert.match(title, /^leverage\.title\.setup-pair\|/);
  assert.match(title, /"from":"L:colorWheel: A"/);
  assert.match(title, /"to":"L:colorWheel: B"/);
  assert.doesNotMatch(title, /Color A/);
});

test('a setup-pair card says so when the plant has setup tracking off (the pair only clears a warning)', () => {
  assert.match(levCardHtml(setupItem(), ctx({ setupActive: false }), t), /am\.lev_setup_inactive/);
  assert.doesNotMatch(levCardHtml(setupItem(), ctx({ setupActive: true }), t), /am\.lev_setup_inactive/);
  assert.doesNotMatch(levCardHtml(item(), ctx({ setupActive: false }), t), /am\.lev_setup_inactive/, 'other families are unaffected');
});

test('setup-pair action: review when allowed, copy-for-owner otherwise', () => {
  assert.equal(levActions(setupItem(), ctx({ canReviewPairs: true })).find(a => a.primary).act, 'setup-review');
  const no = levActions(setupItem(), ctx({ canReviewPairs: false }));
  assert.equal(no.find(a => a.primary).act, 'setup-copy');
  assert.ok(!no.some(a => a.act === 'setup-review'));
});

test('calendar-day actions: fix movable (when fixable), diagnose, admin edit hours, go to', () => {
  assert.deepEqual(acts(item(), ctx({ isAdmin: true })).filter(a => ['cal-fix', 'diagnose-cell', 'edit-calendar', 'goto'].includes(a)),
    ['cal-fix', 'diagnose-cell', 'edit-calendar', 'goto']);
  const noFix = item({ action: { kind: 'calendar-day', line: 'L1', dayKey: '2026-10-21', fixableAlertIds: [] } });
  assert.ok(!acts(noFix).includes('cal-fix'));
  assert.equal(levActions(noFix, ctx()).find(a => a.primary).act, 'diagnose-cell');
  assert.ok(!acts(item(), ctx({ isAdmin: false })).includes('edit-calendar'), 'line hours are admin-only');
  const fix = levActions(item(), ctx({ whatIf: true })).find(a => a.act === 'cal-fix');
  assert.equal(fix.disabled, true, 'Fix is blocked while What-If is active');
});

const routing = (step, extra = {}) => item({
  family: 'routing-gap', key: `routing-gap:${step}`, titleKey: 'leverage.title.routing-gap.routing_upload',
  titleVars: { n: 2, step, material: 'M1', pv: 'PV1', machine: 'L1' }, adminOnly: step !== 'no_machine',
  action: { kind: 'routing-gap', step, material: 'M1', pv: 'PV1', machine: 'L1' }, ...extra,
});

test('routing-gap actions follow the failure step', () => {
  assert.equal(levActions(routing('workcenter_unmapped'), ctx()).find(a => a.primary).act, 'rg-workcenters');
  for (const step of ['no_routing', 'pv_not_found', 'pv_expired', 'no_operation_at_workcenter']) {
    assert.equal(levActions(routing(step), ctx()).find(a => a.primary).act, 'rg-routing', step);
  }
  assert.equal(levActions(routing('pv_missing'), ctx()).find(a => a.primary).act, 'copy-summary');
  assert.equal(levActions(routing('unknown'), ctx()).find(a => a.primary).act, 'copy-summary');
  assert.equal(levActions(routing('no_machine'), ctx()).find(a => a.primary).act, 'open-table');
});

test('tool and machine-state cards focus the first alert; every card can show its alerts and open the table', () => {
  const tool = item({ family: 'tool', key: 'tool:T1', action: { kind: 'tool', tool: 'T1', alertIds: ['a', 'b', 'c'] } });
  const ms = item({ family: 'machine-state', key: 'machine-state:L1', action: { kind: 'machine-state', line: 'L1' } });
  assert.equal(levActions(tool, ctx()).find(a => a.primary).act, 'focus-first');
  assert.equal(levActions(ms, ctx()).find(a => a.primary).act, 'focus-first');
  for (const it of [item(), setupItem(), optItem(), tool, ms, routing('no_routing')]) {
    const a = acts(it, ctx({ canReviewPairs: true }));
    assert.ok(a.includes('show-alerts'), `${it.family} shows alerts`);
    assert.ok(a.includes('open-table'), `${it.family} opens the table`);
  }
  const h = levCardHtml(tool, ctx(), t);
  assert.match(h, /am\.lev_show_alerts/);
  assert.match(h, /am\.open_in_table\|\{"n":2\}/);
});

test('dynamic text is escaped', () => {
  const it = item({ titleVars: { n: 1, line: '<img src=x onerror=1>', day: '2026-10-21' } });
  const h = levCardHtml(it, ctx(), t);
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img/);
});

test('the section shows the top 5, then 20 more per "show all fixes" click, never more than 100', () => {
  const mk = n => Array.from({ length: n }, (_, i) => item({ key: `calendar-day:L${i}|d`, titleVars: { n: 1, line: `L${i}`, day: 'd' } }));
  const items = mk(8);
  assert.equal(LEV_TOP_N, 5);
  assert.equal(LEV_STEP, 20);
  assert.equal(LEV_MAX_RENDER, 100);
  const cards = h => (h.match(/class="am-lev-card/g) || []).length;
  const at = (list, shown) => levSectionHtml(list, { shown, computing: false, ctxFor: () => ctx() }, t);
  const top = at(items, LEV_TOP_N);
  assert.equal(cards(top), 5);
  assert.match(top, /data-am-action="lev-show-more"/);
  assert.match(top, /am\.lev_show_more/);
  const all = at(items, LEV_TOP_N + LEV_STEP);
  assert.equal(cards(all), 8);
  assert.doesNotMatch(all, /lev-show-more/);
  assert.doesNotMatch(at(items.slice(0, 3), LEV_TOP_N), /lev-show-more/);
  // 636 cards (the QA dataset): increments of 20, hard cap 100, then no more button
  const many = mk(636);
  assert.equal(cards(at(many, 25)), 25);
  assert.match(at(many, 25), /lev-show-more/);
  assert.equal(cards(at(many, 85)), 85);
  const capped = at(many, 105);
  assert.equal(cards(capped), LEV_MAX_RENDER);
  assert.doesNotMatch(capped, /lev-show-more/);
  assert.equal(cards(at(many, 10_000)), LEV_MAX_RENDER, 'an oversized request is clamped');
});

test('the section shows a skeleton while computing and the empty copy when nothing qualifies', () => {
  const sk = levSectionHtml([], { shown: LEV_TOP_N, computing: true, ctxFor: () => ctx() }, t);
  assert.match(sk, /am\.lev_computing/);
  assert.match(sk, /aria-busy="true"/);
  const empty = levSectionHtml([], { shown: LEV_TOP_N, computing: false, ctxFor: () => ctx() }, t);
  assert.match(empty, /am\.lev_none/);
  assert.match(empty, /am\.leverage_title/);
});

test('summary text for the owner hand-off carries title, lines, orders and points', () => {
  const s = levSummaryText(item(), 'Fix the thing', t);
  assert.match(s, /Fix the thing/);
  assert.match(s, /L1/);
  assert.match(s, /o1, o2/);
  assert.match(s, /12/);
});

test('setup pairs map to the review shape SetupAdmin reads (fieldKey=value | …)', () => {
  const out = levPairsForReview([pair({ fromState: [{ fieldKey: 'colorWheel', value: 'A' }, { fieldKey: 'prt01', value: 'X' }] })], 'remedy text');
  assert.deepEqual(out, [{
    line: 'L1', predecessorOrderId: 'o0', successorOrderId: 'o1',
    fromState: 'colorWheel=A | prt01=X', toState: 'colorWheel=B', reason: 'setup-uncovered', remedy: 'remedy text',
  }]);
});
