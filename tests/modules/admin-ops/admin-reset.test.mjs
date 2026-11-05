// T6: admin "Reset client state" halts cache writes, confirms with the pending unsaved-edit count and offers Save first,
// then wipes (bounded) and reloads; the autosave-off fix is Save, dispatched as 'client.save'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminCockpit } from '../../../frontend/admin-ops/admin-ui.mjs';
import { Modal, Toast, Util } from '../../../frontend/platform/foundation.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';

globalThis.window = globalThis.window || {};

async function withReset({ dirty = 0, choose, confirm = true, wipe }, fn) {
  const saved = {
    choose: Modal.choose, confirm: Modal.confirm, toast: Toast.show, clear: Session.clearLocalPlannerData, halt: Persistence.haltCacheWrites,
    save: Persistence.saveAll, loc: globalThis.location, t: Util.t, dirty: new Set(Persistence._dirtyIds), force: new Set(Persistence._forceIds),
  };
  const calls = [];
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  for (let i = 0; i < dirty; i++) Persistence._dirtyIds.add('o' + i);
  Modal.choose = (o) => { calls.push(['choose', o]); return Promise.resolve(choose); };
  Modal.confirm = (o) => { calls.push(['confirm', o]); return Promise.resolve(confirm); };
  Toast.show = (m) => { calls.push(['toast', m]); };
  Persistence.haltCacheWrites = () => { calls.push(['halt']); };
  Persistence.saveAll = () => { calls.push(['save']); };
  Session.clearLocalPlannerData = (o) => { calls.push(['clear', o]); return wipe ? wipe() : Promise.resolve(); };
  Util.t = (k, a) => (a ? `${k}|${JSON.stringify(a)}` : k);
  globalThis.location = { reload: () => calls.push(['reload']) };
  try { return await fn(calls); } finally {
    Modal.choose = saved.choose; Modal.confirm = saved.confirm; Toast.show = saved.toast; Session.clearLocalPlannerData = saved.clear;
    Persistence.haltCacheWrites = saved.halt; Persistence.saveAll = saved.save; globalThis.location = saved.loc; Util.t = saved.t;
    Persistence._dirtyIds.clear(); saved.dirty.forEach(x => Persistence._dirtyIds.add(x));
    Persistence._forceIds.clear(); saved.force.forEach(x => Persistence._forceIds.add(x));
  }
}
const names = (calls) => calls.map(c => c[0]);
const settle = () => new Promise(r => setTimeout(r, 120));

test('reset with pending edits names the count, offers Save first, and discards only on the explicit choice', async () => {
  await withReset({ dirty: 3, choose: 'discard' }, async (calls) => {
    await AdminCockpit._resetClientState();
    await settle();
    const ch = calls.find(c => c[0] === 'choose')[1];
    assert.match(ch.message, /modal\.reset_client_pending_msg\|\{"count":3\}/);
    assert.deepEqual(ch.options.map(o => o.value), ['save', 'discard']);
    assert.match(ch.options[1].label, /"count":3/);
    assert.equal(calls.some(c => c[0] === 'confirm'), false);
    assert.deepEqual(names(calls).filter(n => n !== 'choose'), ['halt', 'clear', 'reload'], 'halt first, then the wipe, then the reload');
    assert.deepEqual(calls.find(c => c[0] === 'clear')[1], { keepQueuedWork: true });
  });
});

test('reset with pending edits: choosing Save saves and neither halts, wipes nor reloads', async () => {
  await withReset({ dirty: 2, choose: 'save' }, async (calls) => {
    await AdminCockpit._resetClientState();
    await settle();
    assert.deepEqual(names(calls).filter(n => n !== 'choose'), ['save', 'toast']);
  });
});

test('reset with pending edits: cancelling does nothing at all', async () => {
  await withReset({ dirty: 2, choose: null }, async (calls) => {
    await AdminCockpit._resetClientState();
    await settle();
    assert.deepEqual(names(calls), ['choose']);
  });
});

test('reset with nothing pending keeps the plain confirm, then halts, wipes and reloads; declining does nothing', async () => {
  await withReset({ dirty: 0 }, async (calls) => {
    await AdminCockpit._resetClientState();
    await settle();
    assert.deepEqual(names(calls), ['confirm', 'halt', 'clear', 'reload']);
  });
  await withReset({ dirty: 0, confirm: false }, async (calls) => {
    await AdminCockpit._resetClientState();
    await settle();
    assert.deepEqual(names(calls), ['confirm']);
  });
});

test('reset waits for the wipe but never longer than about a second (a stuck IndexedDB cannot trap the reload)', async () => {
  await withReset({ dirty: 0, wipe: () => new Promise(() => {}) }, async (calls) => {
    const t0 = Date.now();
    await AdminCockpit._resetClientState();
    assert.ok(Date.now() - t0 < 2500);
    await settle();
    assert.ok(names(calls).includes('reload'));
  });
});

test('the signal dispatcher routes client.save to Persistence.saveAll', async () => {
  const real = Persistence.saveAll; let n = 0;
  Persistence.saveAll = () => { n++; };
  try { await AdminCockpit._onSignalFix({ id: 'client.save', labelKey: 'btn.save' }, null); } finally { Persistence.saveAll = real; }
  assert.equal(n, 1);
});
