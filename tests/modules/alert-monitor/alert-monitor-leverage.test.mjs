// Pure builders behind the "Top fixes" panel (frontend/alert-monitor/alert-monitor-model.mts):
// the ranked row (counts + confidence clause rules, minutes entry, tooltip), levActions' {primary, menu} split,
// and the section (partition-then-slice, collapsed admin list, show more, skeleton, empty).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const { levActions, levTitle, levSummaryText, levPairsForReview, fixLineParts, LEV_TOP_N, LEV_STEP, LEV_MAX_RENDER } = M;
// The stub `t` serialises its vars as JSON; the builders escape quotes, so undo that before matching.
const unq = s => s.replace(/&quot;/g, '"');
const fixRowHtml = (...a) => unq(M.fixRowHtml(...a));
const fixesSectionHtml = (...a) => unq(M.fixesSectionHtml(...a));

const t = (k, v) => (v ? `${k}|${JSON.stringify(v)}` : k);
const ctx = (o = {}) => ({
  remaining: 0, canReviewPairs: false, isAdmin: false, setupActive: true, whatIf: false,
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
const routing = (step, extra = {}) => item({
  family: 'routing-gap', key: `routing-gap:${step}`, titleKey: 'leverage.title.routing-gap.routing_upload',
  titleVars: { n: 2, step, material: 'M1', pv: 'PV1', machine: 'L1' }, adminOnly: step !== 'no_machine',
  action: { kind: 'routing-gap', step, material: 'M1', pv: 'PV1', machine: 'L1' }, ...extra,
});
const all = (it, c = ctx()) => { const a = levActions(it, c); return [a.primary, ...a.menu].filter(Boolean); };
const acts = (it, c = ctx()) => all(it, c).map(a => a.act);
const primaryOf = (it, c = ctx()) => levActions(it, c).primary;
const rows = h => (h.match(/class="am-fix"/g) || []).length;

test('constants: top 5, step 10, render cap 50', () => {
  assert.equal(LEV_TOP_N, 5);
  assert.equal(LEV_STEP, 10);
  assert.equal(LEV_MAX_RENDER, 50);
});

test('a row is a ranked list item: rank, title, counts line, one primary button and the ⋯ trigger', () => {
  const h = fixRowHtml(item(), 1, ctx(), t);
  assert.match(h, /class="am-fix"/);
  assert.match(h, /class="am-fix-rank" role="img" aria-label="am\.rank_n\|\{"n":1\}">1</);
  assert.match(h, /class="am-fix-title"[^>]*>leverage\.title\.calendar-day\|/);
  assert.match(h, /am\.fix_clears\|\{"n":3,"m":2\}/);
  assert.equal((h.match(/class="btn sm btn-primary"/g) || []).length, 1);
  assert.match(h, /<button[^>]*class="icon-btn sm"[^>]*data-lev-menu="calendar-day:L1\|2026-10-21"[^>]*data-ovf-key="calendar-day:L1\|2026-10-21"/);
  assert.match(h, /aria-label="am\.more_actions"/);
});

test('builders never print points, estimate or exact wording', () => {
  const variants = [
    item(), item({ method: 'replay', confidenceAfter: 75 }), item({ points: 0, confidenceAfter: 71 }), optItem(),
    optItem({ headroomHours: -2 }), setupItem({ requiresMinutes: true }), item({ adminOnly: true, remaining: 1 }),
  ];
  for (const it of variants) {
    for (const c of [ctx(), ctx({ remaining: 2, isAdmin: true, setupActive: false })]) {
      const h = fixRowHtml(it, 1, c, t) + fixLineParts(it, c, t).join(' ');
      assert.doesNotMatch(h, /point|pts|exact|estimate/i, it.family);
    }
  }
  const s = fixesSectionHtml(variants, { isAdmin: false, adminOpen: true, limit: 5, computing: false, ctxFor: () => ctx() }, t);
  assert.doesNotMatch(s, /point|pts|exact|estimate/i);
  assert.doesNotMatch(levSummaryText(item(), 'T', t), /point|pts|exact|estimate/i);
});

test('counts line uses the singular keys the counts call for', () => {
  const one = (n, m) => unq(fixLineParts(item({ alertIds: Array(n).fill('a'), orderIds: Array(m).fill('o') }), ctx(), t)[0]);
  assert.equal(one(1, 1), 'am.fix_clears_one');
  assert.equal(one(1, 4), 'am.fix_clears_one_alert|{"m":4}');
  assert.equal(one(5, 1), 'am.fix_clears_one_order|{"n":5}');
  assert.equal(one(5, 4), 'am.fix_clears|{"n":5,"m":4}');
});

test('confidence clause: only for replay rows whose score changed', () => {
  const clause = it => fixLineParts(it, ctx(), t).some(p => /am\.fix_conf/.test(unq(p)));
  assert.equal(clause(item({ method: 'replay', confidenceAfter: 78 })), true);
  assert.equal(clause(item({ method: 'removal', confidenceAfter: 78 })), false, 'removal method: counts only');
  assert.equal(clause(item({ method: 'replay', confidenceAfter: 71 })), false, 'equal scores');
  assert.equal(clause(item({ method: 'replay', confidenceAfter: null })), false, 'null after-score');
  assert.equal(clause(item({ method: 'replay', confidenceAfter: 80, requiresMinutes: true })), false, 'requiresMinutes before replay');
  assert.equal(clause(optItem()), false, 'optimize-window (method none)');
  const p = unq(fixLineParts(item({ method: 'replay', confidenceAfter: 78 }), ctx(), t).join(' · '));
  assert.match(p, /am\.fix_conf\|\{"before":71,"after":78\}/);
  assert.doesNotMatch(p, /am-fix-down/, 'a higher score has no error-coloured delta');
});

test('a lower after-score is shown, with the delta in the error colour (D9)', () => {
  const p = unq(fixLineParts(item({ method: 'replay', confidenceAfter: 68 }), ctx(), t).join(' · '));
  assert.match(p, /am\.fix_conf\|\{"before":71,"after":68\}/);
  assert.match(p, /<span class="am-fix-down">−3<\/span>/);
});

test('optimize-window with headroom leads with Optimize and puts the free hours in the tooltip', () => {
  const it = optItem();
  const h = fixRowHtml(it, 1, ctx(), t);
  assert.match(h, /title="am\.lev_headroom\|\{"h":"6\.5"\}"/);
  assert.doesNotMatch(h, /am\.lev_no_headroom/);
  assert.equal(primaryOf(it).act, 'optimize');
  assert.ok(levActions(it, ctx()).menu.some(x => x.act === 'diagnose-worst'));
});

test('optimize-window with no headroom: Diagnose is primary and the clause says why', () => {
  const it = optItem({ headroomHours: -3.2 });
  const h = fixRowHtml(it, 1, ctx(), t);
  assert.match(h, /am\.lev_no_headroom\|\{"h":"3\.2"\}/);
  assert.doesNotMatch(h, /am\.lev_headroom\|/);
  assert.equal(primaryOf(it).act, 'diagnose-worst');
  assert.ok(levActions(it, ctx()).menu.some(x => x.act === 'optimize'), 'Optimize is still offered in the menu');
  assert.equal(primaryOf(optItem({ headroomHours: 0 })).act, 'diagnose-worst', 'zero counts as no headroom');
});

test('remaining count shows after a fix attempt', () => {
  assert.match(fixRowHtml(item(), 1, ctx({ remaining: 2 }), t), /am\.lev_remaining\|\{"n":2\}/);
  assert.doesNotMatch(fixRowHtml(item(), 1, ctx(), t), /am\.lev_remaining/);
});

test('minutes input and Replay button only for requiresMinutes rows; the clause appears after the replay', () => {
  const need = setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null, confidenceAfter: 78, method: 'removal' });
  const h = fixRowHtml(need, 1, ctx(), t);
  assert.match(h, /<input[^>]*type="number"[^>]*data-lev-minutes="setup-pair:x"/);
  assert.match(h, /am\.fix_minutes/);
  assert.match(h, /data-lev-action="replay-minutes" data-lev-key="setup-pair:x"[^>]*>am\.fix_replay/);
  assert.doesNotMatch(h, /am\.fix_conf/);
  assert.doesNotMatch(h, /78/);
  const done = fixRowHtml(setupItem({ requiresMinutes: false, assumedMinutes: 12, minutesSource: 'user', method: 'replay', confidenceAfter: 75 }), 1, ctx(), t);
  assert.doesNotMatch(done, /data-lev-minutes/);
  assert.match(done, /am\.fix_conf\|\{"before":71,"after":75\}/);
  assert.doesNotMatch(fixRowHtml(item(), 1, ctx(), t), /data-lev-minutes/);
});

test('adminOnly rows carry the admin tag; the non-admin primary is Copy summary and the admin link moves to the menu', () => {
  const it = routing('workcenter_unmapped');
  const h = fixRowHtml(it, 1, ctx({ isAdmin: false }), t);
  assert.match(h, /badge badge-info[^>]*>am\.lev_admin_fix/);
  assert.match(h, /btn-primary" data-lev-action="copy-summary"/);
  const a = levActions(it, ctx({ isAdmin: false }));
  assert.equal(a.primary.act, 'copy-summary');
  const link = a.menu.find(x => x.act === 'rg-workcenters');
  assert.ok(link && link.admin === true && link.primary === false, 'admin deep link (with its tag) is in the menu');
  assert.equal(a.menu.filter(x => x.act === 'copy-summary').length, 0, 'no duplicate copy item');
  // admin sees the deep link as the primary
  assert.equal(primaryOf(it, ctx({ isAdmin: true })).act, 'rg-workcenters');
  assert.doesNotMatch(fixRowHtml(item(), 1, ctx(), t), /am\.lev_admin_fix/);
  // adminOnly whose primary is already copy-summary (pv_missing)
  assert.equal(primaryOf(routing('pv_missing')).act, 'copy-summary');
});

test('setup-pair copy-export (no matrix permission) is not adminOnly: primary stays Copy missing pairs', () => {
  assert.equal(primaryOf(setupItem(), ctx({ canReviewPairs: true })).act, 'setup-review');
  assert.equal(primaryOf(setupItem(), ctx({ canReviewPairs: false })).act, 'setup-copy');
  assert.ok(!acts(setupItem(), ctx({ canReviewPairs: false })).includes('setup-review'));
});

test('setup-pair titles are re-localised from the pair states, not the engine English', () => {
  const title = levTitle(setupItem(), ctx(), t);
  assert.match(title, /^leverage\.title\.setup-pair\|/);
  assert.match(title, /"from":"L:colorWheel: A"/);
  assert.match(title, /"to":"L:colorWheel: B"/);
  assert.doesNotMatch(title, /Color A/);
});

test('setup tracking off goes into the row tooltip, for setup pairs only', () => {
  assert.match(fixRowHtml(setupItem(), 1, ctx({ setupActive: false }), t), /title="am\.lev_setup_inactive"/);
  assert.doesNotMatch(fixRowHtml(setupItem(), 1, ctx({ setupActive: true }), t), /am\.lev_setup_inactive/);
  assert.doesNotMatch(fixRowHtml(item(), 1, ctx({ setupActive: false }), t), /am\.lev_setup_inactive/);
});

test('menu items: everything but the primary (show alerts, open table, go to, diagnose, admin edit hours)', () => {
  const a = levActions(item(), ctx({ isAdmin: true }));
  assert.equal(a.primary.act, 'cal-fix');
  assert.deepEqual(a.menu.map(x => x.act), ['diagnose-cell', 'edit-calendar', 'goto', 'open-table', 'show-alerts']);
  assert.equal(a.menu.find(x => x.act === 'edit-calendar').admin, true);
  assert.ok(!acts(item(), ctx({ isAdmin: false })).includes('edit-calendar'), 'line hours are admin-only');
  assert.equal(levActions(item(), ctx({ whatIf: true })).primary.disabled, true, 'Fix is blocked while What-If is active');
  const noFix = item({ action: { kind: 'calendar-day', line: 'L1', dayKey: '2026-10-21', fixableAlertIds: [] } });
  assert.equal(primaryOf(noFix).act, 'diagnose-cell');
  assert.ok(!acts(noFix).includes('cal-fix'));
});

test('routing-gap primaries follow the failure step', () => {
  const adm = ctx({ isAdmin: true });
  assert.equal(primaryOf(routing('workcenter_unmapped'), adm).act, 'rg-workcenters');
  for (const step of ['no_routing', 'pv_not_found', 'pv_expired', 'no_operation_at_workcenter']) {
    assert.equal(primaryOf(routing(step), adm).act, 'rg-routing', step);
  }
  assert.equal(primaryOf(routing('unknown'), adm).act, 'copy-summary');
  assert.equal(primaryOf(routing('no_machine'), adm).act, 'open-table');
});

test('every row can show its alerts and open the table; tool and machine-state primaries focus the first alert', () => {
  const tool = item({ family: 'tool', key: 'tool:T1', action: { kind: 'tool', tool: 'T1', alertIds: ['a', 'b', 'c'] } });
  const ms = item({ family: 'machine-state', key: 'machine-state:L1', action: { kind: 'machine-state', line: 'L1' } });
  assert.equal(primaryOf(tool).act, 'focus-first');
  assert.equal(primaryOf(ms).act, 'focus-first');
  for (const it of [item(), setupItem(), optItem(), tool, ms, routing('no_routing')]) {
    const a = acts(it, ctx({ canReviewPairs: true }));
    assert.ok(a.includes('show-alerts'), `${it.family} shows alerts`);
    assert.ok(a.includes('open-table'), `${it.family} opens the table`);
  }
});

test('dynamic text is escaped', () => {
  const it = item({ titleVars: { n: 1, line: '<img src=x onerror=1>', day: '2026-10-21' } });
  const h = fixRowHtml(it, 1, ctx(), t);
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img/);
});

const mk = (n, o = {}) => Array.from({ length: n }, (_, i) => item({ key: `calendar-day:L${i}|d`, titleVars: { n: 1, line: `L${i}`, day: 'd' }, ...o }));
const sec = (list, o = {}) => fixesSectionHtml(list, { isAdmin: true, adminOpen: false, limit: LEV_TOP_N, computing: false, ctxFor: () => ctx(), ...o }, t);

test('the panel uses the standard panel-head with title and hint', () => {
  const h = sec(mk(2));
  assert.match(h, /<section class="panel am-fixes"/);
  assert.match(h, /<header class="panel-head"><h3>am\.fixes_title<\/h3><span class="panel-hint">am\.fixes_hint<\/span><\/header>/);
});

test('show more: top 5, then 10 per click, never more than 50, then no button', () => {
  const items = mk(8);
  const top = sec(items);
  assert.equal(rows(top), 5);
  assert.match(top, /data-am-action="fixes-show-more"/);
  assert.match(top, /am\.fixes_more/);
  const more = sec(items, { limit: LEV_TOP_N + LEV_STEP });
  assert.equal(rows(more), 8);
  assert.doesNotMatch(more, /fixes-show-more/);
  assert.doesNotMatch(sec(items.slice(0, 3)), /fixes-show-more/);
  const many = mk(636);
  assert.equal(rows(sec(many, { limit: 25 })), 25);
  assert.match(sec(many, { limit: 25 }), /fixes-show-more/);
  const capped = sec(many, { limit: 55 });
  assert.equal(rows(capped), LEV_MAX_RENDER);
  assert.doesNotMatch(capped, /fixes-show-more/);
  assert.equal(rows(sec(many, { limit: 10_000 })), LEV_MAX_RENDER, 'an oversized request is clamped');
});

test('rows are ranked 1..n in list order', () => {
  const h = sec(mk(3));
  assert.deepEqual([...h.matchAll(/class="am-fix-rank" role="img" aria-label="[^"]*\{"n":(\d)\}">(\d)</g)].map(m => [m[1], m[2]]), [['1', '1'], ['2', '2'], ['3', '3']]);
});

test('non-admin: partition first, so the top 5 come from the actionable list even when admin items lead the raw order', () => {
  const adminItems = mk(3, { adminOnly: true }).map((it, i) => ({ ...it, key: `adm${i}` }));
  const main = mk(7).map((it, i) => ({ ...it, key: `main${i}` }));
  const h = sec([...adminItems, ...main], { isAdmin: false });
  assert.equal(rows(h), 5, 'five main rows, admin list collapsed');
  for (let i = 0; i < 5; i++) assert.match(h, new RegExp(`data-lev-key="main${i}"`));
  assert.doesNotMatch(h, /data-lev-key="adm/);
  assert.match(h, /fixes-show-more/, 'the show-more applies to the main list (7 > 5)');
  // disclosure row: count, collapsed
  assert.match(h, /<button[^>]*class="am-fix-divider"[^>]*aria-expanded="false"[^>]*data-am-action="fixes-admin-toggle"/);
  assert.match(h, /am\.fixes_admin_divider\|\{"n":3\}/);
  assert.match(h, /aria-controls="am-fix-admin-list"/);
  assert.match(sec([...adminItems, ...main], { isAdmin: false, adminOpen: true }), /id="am-fix-admin-list"/);
});

test('non-admin: the admin disclosure expands to unranked rows whose primary is Copy summary', () => {
  const adminItems = [routing('workcenter_unmapped'), routing('no_routing')];
  const h = sec([...mk(2), ...adminItems], { isAdmin: false, adminOpen: true });
  assert.match(h, /aria-expanded="true"/);
  assert.equal(rows(h), 4);
  const adminHtml = h.slice(h.indexOf('am-fix-divider'));
  assert.equal(rows(adminHtml), 2);
  assert.equal((adminHtml.match(/class="am-fix-rank" aria-hidden="true"/g) || []).length, 2, 'admin rows carry no rank number');
  assert.doesNotMatch(adminHtml, /am\.rank_n/);
  assert.equal((adminHtml.match(/btn-primary" data-lev-action="copy-summary"/g) || []).length, 2);
});

test('the disclosure is rendered even when the main list is empty, and the empty copy is not', () => {
  const h = sec([routing('workcenter_unmapped')], { isAdmin: false });
  assert.match(h, /am-fix-divider/);
  assert.equal(rows(h), 0);
  assert.doesNotMatch(h, /am\.lev_none/);
});

test('admin: one list in original order, no divider, admin rows ranked', () => {
  const items = [routing('workcenter_unmapped'), ...mk(2)];
  const h = sec(items, { isAdmin: true });
  assert.doesNotMatch(h, /am-fix-divider/);
  assert.equal(rows(h), 3);
  assert.ok(h.indexOf('routing-gap:workcenter_unmapped') < h.indexOf('calendar-day:L0|d'));
  assert.match(h, /aria-label="am\.rank_n\|\{"n":1\}">1</);
});

test('a non-admin with only actionable items sees no divider', () => {
  assert.doesNotMatch(sec(mk(3), { isAdmin: false }), /am-fix-divider/);
});

test('skeleton while computing and the empty copy when nothing qualifies (panel head stays)', () => {
  const sk = sec([], { computing: true });
  assert.match(sk, /am\.lev_computing/);
  assert.match(sk, /aria-busy="true"/);
  const empty = sec([]);
  assert.match(empty, /am\.lev_none/);
  assert.match(empty, /am\.fixes_title/);
});

test('summary text for the owner hand-off: title, what it clears, lines, orders; no points', () => {
  const s = levSummaryText(item(), 'Fix the thing', t).split('\n');
  assert.equal(s[0], 'Fix the thing');
  assert.equal(s[1], 'am.fix_clears|{"n":3,"m":2}');
  assert.equal(s[2], 'am.copy_lines: L1');
  assert.equal(s[3], 'am.copy_orders: o1, o2');
  assert.equal(s.length, 4);
});

test('setup pairs map to the review shape SetupAdmin reads (fieldKey=value | …)', () => {
  const out = levPairsForReview([pair({ fromState: [{ fieldKey: 'colorWheel', value: 'A' }, { fieldKey: 'prt01', value: 'X' }] })], 'remedy text');
  assert.deepEqual(out, [{
    line: 'L1', predecessorOrderId: 'o0', successorOrderId: 'o1',
    fromState: 'colorWheel=A | prt01=X', toState: 'colorWheel=B', reason: 'setup-uncovered', remedy: 'remedy text',
  }]);
});
