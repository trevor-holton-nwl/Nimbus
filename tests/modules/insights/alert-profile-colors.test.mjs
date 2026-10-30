import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../frontend/platform/store.mjs';
import { AlertProfileClient } from '../../../frontend/insights/alert-profile-client.mjs';
import { AlertAcksClient } from '../../../frontend/insights/alert-acks-client.mjs';
import { AlertProfileMatches as M, applyCategoryColors, categoryColorSignature, _resetColorSignature } from '../../../frontend/insights/alert-profile-matches.mjs';
import {
  categoryColorDecls, ALL_ALERTS_PROFILE, PALETTE, DEFAULT_CATEGORY_COLORS, ALERT_CATEGORY_ORDER,
} from '../../../frontend/insights/alert-profiles.mjs';

const colored = (overrides = {}) => {
  const categories = {};
  for (const c of ALERT_CATEGORY_ORDER) categories[c] = { on: true, color: DEFAULT_CATEGORY_COLORS[c] };
  for (const [c, color] of Object.entries(overrides)) categories[c] = { on: true, color };
  return { id: 'p1', plant: 'P1', name: 'p1', description: '', rules: [], ranking: 'impact', categories };
};

/** A body stand-in: records every setProperty and keeps the values readable. */
function fakeEl() {
  const props = new Map();
  const writes = [];
  return {
    props, writes,
    style: {
      setProperty(k, v) { props.set(k, v); writes.push(k); },
      getPropertyValue(k) { return props.get(k) ?? ''; },
    },
    setAttribute() { throw new Error('applyCategoryColors must not use setAttribute'); },
  };
}

test('PALETTE is the nine fixed swatches and every default colour is one of them', () => {
  assert.deepEqual([...PALETTE], ['amber', 'orange', 'magenta', 'violet', 'teal', 'sky', 'slate', 'sand', 'stone']);
  for (const c of ALERT_CATEGORY_ORDER) assert.ok(PALETTE.includes(DEFAULT_CATEGORY_COLORS[c]), c);
  assert.deepEqual(DEFAULT_CATEGORY_COLORS, {
    capacity: 'amber', conflicts: 'violet', calendar: 'teal', setup: 'magenta', planning: 'orange', late: 'slate', exceptions: 'stone',
  });
});

test('categoryColorDecls: built-in, null and legacy profiles yield the full 21-key default map, never {}', () => {
  for (const p of [ALL_ALERTS_PROFILE, null, undefined, { ...colored(), categories: null }, { ...colored(), categories: undefined }]) {
    const d = categoryColorDecls(p);
    assert.equal(Object.keys(d).length, 21);
    assert.equal(d['--bar-pm-capacity'], 'var(--pal-amber)');
    assert.equal(d['--bar-pm-late-fg'], 'var(--pal-slate-fg)');
    assert.equal(d['--bar-pm-exceptions-ring'], 'var(--pal-stone-ring)');
  }
  // a built-in profile ignores any categories it carries
  assert.deepEqual(categoryColorDecls({ ...ALL_ALERTS_PROFILE, categories: colored({ capacity: 'sky' }).categories }), categoryColorDecls(ALL_ALERTS_PROFILE));
});

test('categoryColorDecls: a profile re-points only its own categories at its swatches', () => {
  const d = categoryColorDecls(colored({ capacity: 'sky', late: 'sand' }));
  assert.equal(Object.keys(d).length, 21);
  assert.equal(d['--bar-pm-capacity'], 'var(--pal-sky)');
  assert.equal(d['--bar-pm-capacity-fg'], 'var(--pal-sky-fg)');
  assert.equal(d['--bar-pm-capacity-ring'], 'var(--pal-sky-ring)');
  assert.equal(d['--bar-pm-late'], 'var(--pal-sand)');
  assert.equal(d['--bar-pm-setup'], 'var(--pal-magenta)');
});

test('applyCategoryColors writes all 21 keys via setProperty, then only the keys that changed', () => {
  const prior = globalThis.document;
  globalThis.document = {};
  try {
    const el = fakeEl();
    applyCategoryColors(el, colored());
    assert.equal(el.writes.length, 21);
    assert.equal(el.props.get('--bar-pm-conflicts'), 'var(--pal-violet)');
    el.writes.length = 0;
    applyCategoryColors(el, colored());                       // unchanged: nothing written
    assert.equal(el.writes.length, 0);
    applyCategoryColors(el, colored({ conflicts: 'sky' }));   // one category: its three keys
    assert.deepEqual(el.writes.sort(), ['--bar-pm-conflicts', '--bar-pm-conflicts-fg', '--bar-pm-conflicts-ring']);
    el.writes.length = 0;
    applyCategoryColors(el, ALL_ALERTS_PROFILE);              // back to defaults restores the same three
    assert.equal(el.writes.length, 3);
    assert.equal(el.props.get('--bar-pm-conflicts'), 'var(--pal-violet)');
  } finally { globalThis.document = prior; }
});

test('applyCategoryColors is a no-op without a document or without an element', () => {
  assert.equal(typeof document, 'undefined');
  const el = fakeEl();
  applyCategoryColors(el, colored());
  assert.equal(el.writes.length, 0);
  const prior = globalThis.document;
  globalThis.document = {};
  try { applyCategoryColors(null, colored()); applyCategoryColors(undefined, colored()); } finally { globalThis.document = prior; }
});

test('categoryColorSignature changes only when a colour changes', () => {
  assert.equal(categoryColorSignature(colored()), categoryColorSignature(ALL_ALERTS_PROFILE));
  assert.notEqual(categoryColorSignature(colored({ setup: 'sky' })), categoryColorSignature(colored()));
});

// ---- recompute() writes the viewed default profile onto document.body, skipping when the signature is unchanged ----

let profiles;
let priorDoc;
beforeEach(t => {
  priorDoc = globalThis.document;
  profiles = [];
  t.mock.method(AlertProfileClient, 'cached', () => profiles);
  t.mock.method(AlertProfileClient, 'list', async () => profiles);
  t.mock.method(AlertAcksClient, 'cached', () => new Map());
  t.mock.method(AlertAcksClient, 'load', async () => new Map());
  Store._state.selectedPlant = 'P1';
  Store._state.tasks = {};
  Store._state.alerts = [];
  Store._state.userSettings = {};
  Store._state.roleDefaults = {};
  M.init();
  M.setSessionProfile(null);
});
afterEach(() => { globalThis.document = priorDoc; });

test('recompute applies the default profile colours to document.body once per signature change', () => {
  const body = fakeEl();
  globalThis.document = { body };
  profiles = [colored({ capacity: 'sky' })];
  Store._state.userSettings = { alertProfileByPlant: { P1: 'p1' } };
  M.recompute();
  assert.equal(body.props.get('--bar-pm-capacity'), 'var(--pal-sky)');
  const n = body.writes.length;
  M.recompute();                                    // same profile: skipped by signature
  assert.equal(body.writes.length, n);
  Store._state.userSettings = {};                   // back to All alerts: defaults restored
  M.recompute();
  assert.equal(body.props.get('--bar-pm-capacity'), 'var(--pal-amber)');
});

test('"View as" does not recolour the body (the page paints its own #alerts-tab)', () => {
  const body = fakeEl();
  globalThis.document = { body };
  profiles = [colored({ capacity: 'sky' })];
  _resetColorSignature();                           // the module-level signature carries over from earlier tests
  M.recompute();
  assert.equal(body.props.get('--bar-pm-capacity'), 'var(--pal-amber)', 'the default (All alerts) colours were written');
  M.setSessionProfile('p1');
  assert.notEqual(body.props.get('--bar-pm-capacity'), 'var(--pal-sky)');
  assert.equal(M.view().profile.id, 'p1');
});
