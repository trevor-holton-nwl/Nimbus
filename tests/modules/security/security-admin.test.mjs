// Tests for frontend/security/security-admin.mjs (Security).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Security } from '../../../frontend/security/security-admin.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Session } from '../../../frontend/security/session.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
let fixtureId = 0;

async function rolesFixture(t, plants = []) {
  function node(dataset = {}) {
    let html = '';
    const children = new Map();
    const listeners = new Map();
    const descendants = new Set();
    return {
      value: '',
      focus() { globalThis.document.activeElement = this; },
      detach() {
        if (globalThis.document.activeElement === this) globalThis.document.activeElement = null;
        for (const id of descendants) { nodes.get(id)?.detach(); nodes.delete(id); }
        descendants.clear();
      },
      dataset,
      addEventListener(type, listener) { listeners.set(type, listener); },
      fire(type) { listeners.get(type)?.(); },
      querySelectorAll: selector => children.get(selector) || [],
      get innerHTML() { return html; },
      set innerHTML(value) {
        this.detach();
        html = value;
        for (const match of value.matchAll(/\sid="([^"]+)"/g)) {
          nodes.set(match[1], node()); descendants.add(match[1]);
        }
        for (const [attr, key] of [['data-tab', 'tab'], ['data-role-select', 'roleSelect'], ['data-page-toggle', 'pageToggle'], ['data-plant', 'plant']]) {
          children.set(`[${attr}]`, [...value.matchAll(new RegExp(`<[^>]+${attr}="([^"]+)"[^>]*>`, 'g'))].map(match => {
            const item = node({ [key]: match[1] });
            item.checked = /\schecked(?:\s|>)/.test(match[0]);
            return item;
          }));
        }
      },
    };
  }
  const nodes = new Map([['security-host', node()]]);
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
  t.mock.method(Store, 'knownPlants', () => plants);
  t.mock.method(Store, 'plantLabel', plant => plant);
  t.mock.method(Session, 'actor', () => 'test-admin');
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Util, 'fetchTraced', (url, opts) => {
    if (opts?.method === 'POST' && url.endsWith('/role_plants/bulk')) {
      requests.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
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
      : url.endsWith('/role_plants') ? { rows: plants.slice(0, 25).map(plant => ({ role: 'planner', plant })) } : { users: [] };
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
  return { nodes, requests, saved, select, checkbox, toggle(page, checked) { const cb = checkbox(page); cb.checked = checked; cb.fire('change'); } };
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


test('role plant assignment searches both bounded lists and uses native named buttons', async t => {
  const f = await rolesFixture(t, Array.from({ length: 55 }, (_, n) => `PLANT-${String(n).padStart(2, '0')}`));
  const assigned = f.nodes.get('sec-plant-assigned'); const available = f.nodes.get('sec-plant-dropdown');
  assert.equal(assigned.querySelectorAll('[data-plant]').length, 25);
  assert.equal(available.querySelectorAll('[data-plant]').length, 30);
  assert.match(available.innerHTML, /<button type="button"[^>]+aria-label="sec.add_plant PLANT-25"/);
  assert.doesNotMatch(f.nodes.get('sec-roles-detail').innerHTML, /sap-keychip/);
  const search = f.nodes.get('sec-plant-search'); search.value = 'PLANT-3'; search.fire('input');
  assert.equal(assigned.querySelectorAll('[data-plant]').length, 0);
  assert.equal(available.querySelectorAll('[data-plant]').length, 10);
  available.querySelectorAll('[data-plant]')[0].fire('click');
  assert.deepEqual(f.requests.at(-1), { upserts: [{ role: 'planner', plant: 'PLANT-30' }] });
  await settle();
  const rebuilt = f.nodes.get('sec-plant-search');
  assert.notEqual(rebuilt, search, 'outer role markup replaces descendant nodes');
  assert.equal(rebuilt.value, 'PLANT-3');
  assert.equal(f.nodes.get('sec-plant-dropdown').querySelectorAll('[data-plant]').length, 10);
  assert.equal(globalThis.document.activeElement, rebuilt, 'keyboard workflow resumes at search after reload');
});

test('Page Access toggles list Alert Monitor after Labor Plan, on by default', async t => {
  const f = await rolesFixture(t);
  const order = f.nodes.get('sec-roles-detail').querySelectorAll('[data-page-toggle]').map(n => n.dataset.pageToggle);
  assert.deepEqual(order, ['home', 'gantt', 'labor', 'alerts', 'masterdata', 'admin']);
  assert.equal(f.checkbox('alerts').checked, true);
});