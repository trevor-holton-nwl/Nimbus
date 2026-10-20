import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Util } from '../../../frontend/platform/foundation.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { AlertProfileClient as C } from '../../../frontend/insights/alert-profile-client.mjs';

const prof = (id, plant, name = id) => ({ id, plant, name, description: '', rules: [], ranking: 'impact' });
const res = (status, body) => ({ ok: status < 400, status, json: async () => body, clone() { return this; }, text: async () => JSON.stringify(body) });
let calls, handler;

beforeEach(t => {
  for (const p of ['A', 'B', 'C', 'D']) C.invalidate(p);
  calls = [];
  handler = null;
  t.mock.method(Util, 'fetchTraced', async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); });
});

test('list caches per plant; force refetches', async () => {
  handler = () => res(200, { plant: 'A', profiles: [prof('1', 'A')] });
  assert.equal(C.cached('A'), null);
  await C.list('A'); await C.list('A');
  assert.equal(calls.length, 1);
  assert.equal(C.cached('A').length, 1);
  await C.list('B');
  assert.equal(calls.length, 2);
  await C.list('A', { force: true });
  assert.equal(calls.length, 3);
});

test('stale guard drops an out-of-order response', async () => {
  const gates = [];
  handler = () => new Promise(r => gates.push(r));
  const first = C.list('A', { force: true });
  const second = C.list('A', { force: true });
  gates[1](res(200, { profiles: [prof('new', 'A')] }));
  await second;
  gates[0](res(200, { profiles: [prof('old', 'A')] }));
  await first;
  assert.deepEqual(C.cached('A').map(p => p.id), ['new']);
});

test('invalidate orphans an in-flight request', async () => {
  let gate;
  handler = () => new Promise(r => { gate = r; });
  const p = C.list('A');
  C.invalidate('A');
  gate(res(200, { profiles: [prof('x', 'A')] }));
  await p;
  assert.equal(C.cached('A'), null);
});

test('LRU keeps at most 3 plants', async () => {
  handler = () => res(200, { profiles: [] });
  for (const p of ['A', 'B', 'C', 'D']) await C.list(p);
  assert.equal(C.cached('A'), null);
  for (const p of ['B', 'C', 'D']) assert.ok(C.cached(p));
});

test('write refreshes the cache and notifies exactly once', async () => {
  let list = [prof('1', 'A')];
  handler = (url, init) => {
    if (init?.method === 'POST') { list = [...list, prof('2', 'A')]; return res(201, prof('2', 'A')); }
    return res(200, { profiles: list });
  };
  await C.list('A');
  let n = 0; const off = C.subscribe(() => { n++; });
  const created = await C.create({ plant: 'A', name: '2', rules: [] });
  assert.equal(created.id, '2');
  assert.equal(n, 1);
  assert.equal(C.cached('A').length, 2);
  off();
  handler = (url, init) => init?.method === 'DELETE' ? res(200, { deleted: true, id: '2' }) : res(200, { profiles: [prof('1', 'A')] });
  await C.remove('2', 'A');
  assert.equal(n, 1);
  assert.equal(C.cached('A').length, 1);
  assert.match(calls.at(-2).url, /alert-profiles\/2\?plant=A$/);
});

test('update sends PUT body; 409 name_taken and stale throw with .code and do not notify', async () => {
  let n = 0; C.subscribe(() => { n++; });
  for (const code of ['name_taken', 'stale']) {
    handler = () => res(409, { status: 409, message: code, detail: code });
    await assert.rejects(C.update('1', { plant: 'A', name: 'x', expected_updated_at: 't' }), e => e.code === code && e.status === 409);
  }
  assert.equal(n, 0);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(JSON.parse(calls[0].init.body).expected_updated_at, 't');
});

test('plant:selected invalidates the plant that was left, keeps the new one', async () => {
  handler = () => res(200, { profiles: [] });
  Store.emit({ type: 'plant:selected', plant: 'A', source: 'test' });
  await C.list('A'); await C.list('B');
  Store.emit({ type: 'plant:selected', plant: 'B', source: 'test' });
  assert.equal(C.cached('A'), null);
  assert.ok(C.cached('B'));
});
