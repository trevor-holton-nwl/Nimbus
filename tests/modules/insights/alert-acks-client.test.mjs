import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Util } from '../../../frontend/platform/foundation.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { AlertAcksClient as C } from '../../../frontend/insights/alert-acks-client.mjs';

const ack = (id, plant = 'A') => ({ plant, alert_id: id, acknowledged_by: 'u', reason: 'r', until: null, created_at: 't' });
const res = (status, body) => ({ ok: status < 400, status, json: async () => body, clone() { return this; }, text: async () => JSON.stringify(body) });
let calls, handler;

beforeEach(t => {
  for (const p of ['A', 'B', 'C', 'D']) C.invalidate(p);
  calls = [];
  t.mock.method(Util, 'fetchTraced', async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); });
});

test('load returns a Map keyed by alert id, caches, force refetches', async () => {
  handler = () => res(200, { plant: 'A', acks: [ack('x'), ack('y')] });
  const m = await C.load('A');
  assert.deepEqual([...m.keys()], ['x', 'y']);
  await C.load('A');
  assert.equal(calls.length, 1);
  assert.equal(C.cached('A'), m);
  await C.load('A', { force: true });
  assert.equal(calls.length, 2);
});

test('stale guard drops an out-of-order response', async () => {
  const gates = [];
  handler = () => new Promise(r => gates.push(r));
  const a = C.load('A', { force: true }), b = C.load('A', { force: true });
  gates[1](res(200, { acks: [ack('new')] })); await b;
  gates[0](res(200, { acks: [ack('old')] })); await a;
  assert.deepEqual([...C.cached('A').keys()], ['new']);
});

test('LRU keeps at most 3 plants', async () => {
  handler = () => res(200, { acks: [] });
  for (const p of ['A', 'B', 'C', 'D']) await C.load(p);
  assert.equal(C.cached('A'), null);
  assert.ok(C.cached('D'));
});

test('acknowledge/unacknowledge refresh the cache and notify once each', async () => {
  let acks = [];
  handler = (url, init) => {
    if (init?.method === 'POST') { acks = [ack('x/1')]; return res(200, ack('x/1')); }
    if (init?.method === 'DELETE') { acks = []; return res(200, { deleted: true }); }
    return res(200, { acks });
  };
  await C.load('A');
  let n = 0; C.subscribe(() => { n++; });
  await C.acknowledge({ plant: 'A', alert_id: 'x/1', reason: 'r', until: null });
  assert.equal(n, 1);
  assert.ok(C.cached('A').has('x/1'));
  await C.unacknowledge('A', 'x/1');
  assert.equal(n, 2);
  assert.equal(C.cached('A').size, 0);
  assert.ok(calls.some(c => c.url.endsWith('/alert-acks/A/x%2F1')));
});

test('a failed write throws with status and does not notify', async () => {
  let n = 0; C.subscribe(() => { n++; });
  handler = () => res(400, { status: 400, message: 'reason is required', detail: 'reason is required' });
  await assert.rejects(C.acknowledge({ plant: 'A', alert_id: 'x', reason: '' }), e => e.status === 400);
  assert.equal(n, 0);
});

test('plant:selected invalidates the plant that was left', async () => {
  handler = () => res(200, { acks: [] });
  Store.emit({ type: 'plant:selected', plant: 'A', source: 'test' });
  await C.load('A'); await C.load('B');
  Store.emit({ type: 'plant:selected', plant: 'B', source: 'test' });
  assert.equal(C.cached('A'), null);
  assert.ok(C.cached('B'));
});
