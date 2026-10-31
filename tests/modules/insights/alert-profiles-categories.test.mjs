// W3: stored per-category on/off + colour, and the matching rule that reads it.
//   profileMatches = category on AND (no applicable rule OR some applicable rule matches),
//   "applicable" pinned at CATEGORY level (categoryOf), never by listing types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_ALERTS_PROFILE, ALERT_CATEGORY_ORDER, DEFAULT_CATEGORY_COLORS, PALETTE, FIRING_ALERT_TYPES,
  ruleMatches, ruleAppliesTo, profileMatches, effectiveCategories, profileCategoryCounts, validateProfile,
} from '../../../frontend/insights/alert-profiles.mjs';

const deps = { dueInstant: (t) => t.due ?? t.original_end_date ?? null, latenessHours: (t) => t.late ?? 0 };
const TODAY = new Date(2026, 9, 20);
const at = (n, h = 0) => new Date(2026, 9, 20 + n, h);
const rule = (o = {}) => ({ types: null, dayFrom: null, dayTo: null, minSev: null, minLateHours: null, ...o });
const alert = (o = {}) => ({ id: 'a1', sev: 'warn', type: 'overlap', line: 'L1', time: at(0, 9), ...o });
const prof = (rules, categories) => ({ id: 'p', plant: 'P1', name: 'p', description: '', rules, ranking: 'impact', ...(categories !== undefined ? { categories } : {}) });
const cats = (on = ALERT_CATEGORY_ORDER, colors = {}) => Object.fromEntries(ALERT_CATEGORY_ORDER.map(c => [c, { on: on.includes(c), color: colors[c] ?? DEFAULT_CATEGORY_COLORS[c] }]));

// ---- OLD predicate, verbatim: the back-compat oracle -----------------------------------------
const oldProfileMatches = (a, task, profile, today, d) => profile.rules.some(r => ruleMatches(a, task, r, today, d));

// ---- ruleAppliesTo / effectiveCategories ------------------------------------------------------

test('ruleAppliesTo is category-level: null types apply everywhere, listed types apply to their categories only', () => {
  assert.equal(ruleAppliesTo(rule(), 'late'), true);
  assert.equal(ruleAppliesTo(rule({ types: ['setup-violated'] }), 'setup'), true);
  assert.equal(ruleAppliesTo(rule({ types: ['setup-violated'] }), 'conflicts'), false);
  assert.equal(ruleAppliesTo(rule({ types: ['overlap', 'late'] }), 'late'), true);
  assert.equal(ruleAppliesTo(rule({ types: ['not-a-type'] }), 'exceptions'), true, 'an unknown type falls to Other');
  assert.equal(ruleAppliesTo(rule({ types: ['not-a-type'] }), 'setup'), false);
  assert.equal(ruleAppliesTo(rule({ types: [] }), 'setup'), false);
});

test('effectiveCategories derives on from the rules and uses the default colours', () => {
  const e = effectiveCategories(prof([rule({ types: ['overlap'] }), rule({ types: ['late', 'overload'] })]));
  assert.deepEqual(Object.keys(e), [...ALERT_CATEGORY_ORDER]);
  for (const c of ALERT_CATEGORY_ORDER) assert.equal(e[c].color, DEFAULT_CATEGORY_COLORS[c]);
  assert.deepEqual(ALERT_CATEGORY_ORDER.filter(c => e[c].on), ['capacity', 'conflicts', 'late']);
  assert.ok(ALERT_CATEGORY_ORDER.every(c => effectiveCategories(prof([rule()]))[c].on), 'an all-types rule turns all seven on');
  assert.ok(ALERT_CATEGORY_ORDER.every(c => !effectiveCategories(prof([]))[c].on), 'no rules, nothing on');
  assert.ok(ALERT_CATEGORY_ORDER.every(c => effectiveCategories(ALL_ALERTS_PROFILE)[c].on));
  assert.equal(ALL_ALERTS_PROFILE.categories, undefined, 'the frozen built-in is never written to');
});

test('effectiveCategories: a stored map wins; a missing key is derived; an unknown colour becomes the default', () => {
  const stored = cats(['late'], { late: 'sky' });
  delete stored.setup;
  stored.capacity = { on: false, color: 'chartreuse' };
  const e = effectiveCategories(prof([rule({ types: ['setup-violated'] })], stored));
  assert.deepEqual(e.late, { on: true, color: 'sky' });
  assert.deepEqual(e.setup, { on: true, color: 'magenta' }, 'missing key: derived from the rule that names a setup type');
  assert.deepEqual(e.capacity, { on: false, color: 'amber' }, 'unknown colour replaced, the stored switch kept');
  assert.deepEqual(e.conflicts, { on: false, color: 'violet' });
  assert.ok(PALETTE.includes(e.capacity.color));
});

// ---- the pinned counterexample ----------------------------------------------------------------

test('counterexample: a setup-violated rule with a day window never matches a setup-uncovered alert, in or out of the window', () => {
  const p = prof([rule({ types: ['setup-violated'], dayFrom: 0, dayTo: 3 })]);
  const outside = alert({ type: 'setup-uncovered', time: at(9) });
  const inside = alert({ type: 'setup-uncovered', time: at(1) });
  for (const stored of [undefined, effectiveCategories(p)]) {
    const q = stored ? { ...p, categories: stored } : p;
    assert.equal(profileMatches(outside, undefined, q, TODAY, deps), false);
    assert.equal(profileMatches(inside, undefined, q, TODAY, deps), false, 'the rule names a different type');
    assert.equal(profileMatches(alert({ type: 'setup-violated', time: at(1) }), undefined, q, TODAY, deps), true);
    assert.equal(profileMatches(alert({ type: 'setup-violated', time: at(9) }), undefined, q, TODAY, deps), false);
  }
});

// ---- new semantics ----------------------------------------------------------------------------

test('a category with no applicable rule matches in full when its switch is on', () => {
  const p = prof([], cats(['late', 'setup']));
  assert.equal(profileMatches(alert({ type: 'late' }), undefined, p, TODAY, deps), true);
  assert.equal(profileMatches(alert({ type: 'setup-uncovered', time: at(40) }), undefined, p, TODAY, deps), true);
  assert.equal(profileMatches(alert({ type: 'overlap' }), undefined, p, TODAY, deps), false, 'switch off');
});

test('rules narrow only the categories they apply to; the switch decides membership', () => {
  const p = prof([rule({ types: ['overlap'], minSev: 'err' })], cats(['conflicts', 'late']));
  assert.equal(profileMatches(alert({ type: 'overlap', sev: 'warn' }), undefined, p, TODAY, deps), false, 'narrowed out');
  assert.equal(profileMatches(alert({ type: 'overlap', sev: 'err' }), undefined, p, TODAY, deps), true);
  assert.equal(profileMatches(alert({ type: 'tool-conflict', sev: 'warn' }), undefined, p, TODAY, deps), false,
    'same category, the applicable rule names only overlap, so tool-conflict is narrowed out');
  assert.equal(profileMatches(alert({ type: 'late', sev: 'warn' }), undefined, p, TODAY, deps), true, 'no rule applies to Late');
  assert.equal(profileMatches(alert({ type: 'overload' }), undefined, p, TODAY, deps), false, 'capacity is off');
});

test('an unknown alert type is judged as Other', () => {
  assert.equal(profileMatches(alert({ type: 'brand-new' }), undefined, prof([], cats(['exceptions'])), TODAY, deps), true);
  assert.equal(profileMatches(alert({ type: 'brand-new' }), undefined, prof([], cats(['late'])), TODAY, deps), false);
});

test('ALL_ALERTS_PROFILE still matches everything', () => {
  for (const t of [...FIRING_ALERT_TYPES, 'brand-new']) assert.equal(profileMatches(alert({ type: t }), undefined, ALL_ALERTS_PROFILE, TODAY, deps), true, t);
});

test('a stale compile cache is not served after rules or categories are replaced', () => {
  const p = prof([], cats(['late']));
  assert.equal(profileMatches(alert({ type: 'overlap' }), undefined, p, TODAY, deps), false);
  p.categories = cats(['conflicts']);
  assert.equal(profileMatches(alert({ type: 'overlap' }), undefined, p, TODAY, deps), true);
  p.rules = [rule({ types: ['overlap'], minSev: 'err' })];
  assert.equal(profileMatches(alert({ type: 'overlap', sev: 'warn' }), undefined, p, TODAY, deps), false);
});

// ---- profileCategoryCounts ---------------------------------------------------------------------

test('profileCategoryCounts: one count per category with every switch forced on, rules still narrowing', () => {
  const p = prof([rule({ types: ['overlap'], minSev: 'err' })], cats(['late']));
  const alerts = [
    alert({ id: '1', type: 'overlap', sev: 'err' }), alert({ id: '2', type: 'overlap', sev: 'warn' }),
    alert({ id: '3', type: 'tool-conflict', sev: 'err' }), alert({ id: '4', type: 'late' }),
    alert({ id: '5', type: 'late' }), alert({ id: '6', type: 'brand-new' }),
  ];
  const c = profileCategoryCounts(alerts, {}, p, TODAY, deps);
  assert.deepEqual(Object.keys(c), [...ALERT_CATEGORY_ORDER]);
  assert.deepEqual(c, { capacity: 0, conflicts: 1, calendar: 0, setup: 0, planning: 0, late: 2, exceptions: 1 });
});

// ---- validateProfile ---------------------------------------------------------------------------

const draft = (o = {}) => ({ plant: 'P1', name: 'New', rules: [], ...o });

test('validateProfile: with categories present, empty rules are fine; without, one rule is still required', () => {
  assert.deepEqual(validateProfile(draft({ categories: cats() }), []), { ok: true, errors: {} });
  assert.equal(validateProfile(draft({ categories: null }), []).errors.rules, 'ape.err_no_rules');
  assert.equal(validateProfile(draft(), []).errors.rules, 'ape.err_no_rules');
  assert.equal(validateProfile(draft({ categories: cats(), rules: Array.from({ length: 21 }, (_, i) => rule({ dayFrom: i })) }), []).errors.rules, 'ape.err_too_many_rules');
});

test('validateProfile: needs one category on and valid palette colours', () => {
  assert.equal(validateProfile(draft({ categories: cats([]) }), []).errors.categories, 'ape.err_no_categories');
  const bad = cats();
  bad.late.color = 'chartreuse';
  assert.equal(validateProfile(draft({ categories: bad }), []).errors['categories.late.color'], 'ape.err_color');
  const missing = cats();
  delete missing.setup;
  assert.equal(validateProfile(draft({ categories: missing }), []).ok, false);
  assert.equal(validateProfile(draft({ categories: 'x' }), []).ok, false);
});

test('validateProfile: an extra key in categories is a shape error, like the server (ape.err_categories_shape)', () => {
  const extra = cats();
  extra.bogus = { on: true, color: 'sky' };
  const v = validateProfile(draft({ categories: extra }), []);
  assert.equal(v.ok, false);
  assert.equal(v.errors.categories, 'ape.err_categories_shape');
  const both = cats([]);
  both.bogus = { on: true, color: 'sky' };
  assert.equal(validateProfile(draft({ categories: both }), []).errors.categories, 'ape.err_categories_shape', 'the shape error wins');
  assert.equal(validateProfile(draft({ categories: cats() }), []).ok, true);
});

// ---- back-compat property test -----------------------------------------------------------------

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

test('property: a rules-only profile and the same profile with effectiveCategories written back match exactly as the OLD predicate did', () => {
  const rnd = mulberry32(20261030);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const allTypes = [...FIRING_ALERT_TYPES, 'brand-new'];
  const genRule = () => {
    let types = null;
    if (rnd() < 0.7) {
      const n = 1 + Math.floor(rnd() * 4);
      types = [...new Set(Array.from({ length: n }, () => pick(allTypes)))];
    }
    const win = rnd() < 0.5 ? [null, null] : [pick([null, -3, 0, 2]), pick([null, 3, 7, 10])];
    return rule({ types, dayFrom: win[0], dayTo: win[1], minSev: pick([null, 'warn', 'err']), minLateHours: rnd() < 0.2 ? pick([0, 4, 100]) : null });
  };
  const tasks = [undefined, { id: 't1', late: 6, original_end_date: at(2, 12) }, { id: 't2', late: 0, original_end_date: at(-2, 12) }];
  let cases = 0, positives = 0;
  for (let i = 0; i < 160; i++) {
    const rules = Array.from({ length: Math.floor(rnd() * 4) }, genRule);
    const legacy = prof(rules);
    const stored = prof(rules, effectiveCategories(legacy));
    for (const type of allTypes) for (const sev of ['warn', 'err']) for (let off = -3; off <= 10; off += 2) for (const task of tasks) {
      const a = alert({ type, sev, time: at(off, 9), taskId: task ? task.id : undefined });
      const want = oldProfileMatches(a, task, legacy, TODAY, deps);
      assert.equal(profileMatches(a, task, legacy, TODAY, deps), want, `legacy ${JSON.stringify(rules)} ${type}/${sev}/${off}`);
      assert.equal(profileMatches(a, task, stored, TODAY, deps), want, `stored ${JSON.stringify(rules)} ${type}/${sev}/${off}`);
      cases += 2; if (want) positives++;
    }
  }
  assert.ok(cases >= 2000, `ran ${cases} cases`);
  assert.ok(positives > 200, `a generator that never matches proves nothing (${positives})`);
});
