// Tests for frontend/security/security-admin.mjs (Security).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Security } from '../../../frontend/security/security-admin.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { Session } from '../../../frontend/security/session.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
let fixtureId = 0;

async function rolesFixture(t) {
  function node(dataset = {}) {
    let html = '';
    const children = new Map();
    const listeners = new Map();
    return {
      dataset,
      addEventListener(type, listener) { listeners.set(type, listener); },
      fire(type) { listeners.get(type)?.(); },
      querySelectorAll: selector => children.get(selector) || [],
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = value;
        for (const [attr, key] of [['data-tab', 'tab'], ['data-role-select', 'roleSelect'], ['data-page-toggle', 'pageToggle']]) {
          children.set(`[${attr}]`, [...value.matchAll(new RegExp(`<[^>]+${attr}="([^"]+)"[^>]*>`, 'g'))].map(match => {
            const item = node({ [key]: match[1] });
            item.checked = /\schecked(?:\s|>)/.test(match[0]);
            return item;
          }));
        }
      },
    };
  }
  const nodes = new Map(['security-host', 'security-tabbody', 'sec-roles-rail', 'sec-roles-detail'].map(id => [id, node()]));
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = {};
  globalThis.document = { getElementById: id => nodes.get(id) || null, querySelectorAll: () => [] };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  });
  const saved = {
    planner: { home: true, gantt: true, labor: true, masterdata: true, admin: false },
    other: { home: true, gantt: true, labor: true, masterdata: true, admin: false },
  };
  const requests = [];
  t.mock.method(Session, 'actor', () => 'test-admin');
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Util, 'fetchTraced', (url, opts) => {
    if (opts?.method === 'POST') {
      return new Promise(resolve => {
        const role = decodeURIComponent(url.match(/roles\/([^/]+)\/page-access/)[1]);
        const pages = JSON.parse(opts.body).pages;
        requests.push({ role, pages, respond(status = 200) {
          if (status < 400) Object.assign(saved[role], pages);
          resolve({ ok: status < 400, status, json: async () => status < 400 ? { pages: { ...saved[role] } } : { detail: 'failed' } });
        } });
      });
    }
    const data = url.endsWith('/roles') ? { rows: Object.entries(saved).map(([role, pages]) => ({ role, pages: { ...pages } })) }
      : url.endsWith('/role_plants') ? { rows: [] } : { users: [] };
    return Promise.resolve({ ok: true, json: async () => data });
  });
  const { Security: security } = await import(`../../../frontend/security/security-admin.mjs?fixture=${++fixtureId}`);
  await security.render();
  nodes.get('security-host').querySelectorAll('[data-tab]').find(n => n.dataset.tab === 'roles').fire('click');
  await settle();
  function select(role) {
    nodes.get('sec-roles-rail').querySelectorAll('[data-role-select]').find(n => n.dataset.roleSelect === role).fire('click');
  }
  function checkbox(page) { return nodes.get('sec-roles-detail').querySelectorAll('[data-page-toggle]').find(n => n.dataset.pageToggle === page); }
  select('planner');
  return { requests, saved, select, checkbox, toggle(page, checked) { const cb = checkbox(page); cb.checked = checked; cb.fire('change'); } };
}

test('Security exposes its documented public API', () => {
  assert.equal(typeof Security.render, 'function');
});

test('role toggles send only changed keys and serialize overlapping writes', async t => {
  const f = await rolesFixture(t);
  f.toggle('home', false); f.toggle('labor', false);
  assert.deepEqual(f.requests[0].pages, { home: false });
  assert.equal(f.requests.length, 1);
  f.requests[0].respond(); await settle();
  assert.equal(f.checkbox('labor').checked, false, 'first response must preserve pending choice');
  assert.deepEqual(f.requests[1].pages, { labor: false });
  f.requests[1].respond(); await settle();
  assert.equal(f.saved.planner.home, false);
  assert.equal(f.saved.planner.labor, false);
  assert.equal(f.checkbox('home').checked, false);
  assert.equal(f.checkbox('labor').checked, false);
});

test('same-page toggles settle at the latest click without a stale repaint', async t => {
  const f = await rolesFixture(t);
  f.toggle('home', false); f.toggle('home', true);
  assert.equal(f.requests.length, 1);
  f.requests[0].respond(); await settle();
  assert.equal(f.checkbox('home').checked, true);
  assert.deepEqual(f.requests[1].pages, { home: true });
  f.requests[1].respond(); await settle();
  assert.equal(f.saved.planner.home, true);
  assert.equal(f.checkbox('home').checked, true);
});

test('failed role write does not discard another queued toggle', async t => {
  const f = await rolesFixture(t);
  f.toggle('home', false); f.toggle('labor', false);
  f.requests[0].respond(500); await settle();
  assert.equal(f.checkbox('home').checked, true, 'failed value rolls back');
  assert.equal(f.checkbox('labor').checked, false, 'queued value remains visible');
  f.requests[1].respond(); await settle();
  assert.equal(f.saved.planner.home, true);
  assert.equal(f.saved.planner.labor, false);
});

test('different roles may save independently and old role responses preserve selected role state', async t => {
  const f = await rolesFixture(t);
  f.toggle('home', false);
  f.select('other'); f.toggle('labor', false);
  assert.equal(f.requests.length, 2);
  f.requests[1].respond(); await settle();
  f.requests[0].respond(); await settle();
  assert.equal(f.checkbox('home').checked, true);
  assert.equal(f.checkbox('labor').checked, false);
  f.select('planner');
  assert.equal(f.checkbox('home').checked, false);
  assert.equal(f.checkbox('labor').checked, true);
});
