// T6: admin "Reset client state" halts cache writes, confirms with the pending unsaved-edit count and offers Save first,
// then wipes and reloads; the autosave-off fix is Save, dispatched as 'client.save'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminCockpit } from '../../../frontend/admin-ops/admin-ui.mjs';
import { Modal, Toast, Util } from '../../../frontend/platform/foundation.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { CacheStore, LS_RECORD_PREFIX } from '../../../frontend/platform/cache-store.mjs';
import { resetCacheEnv } from '../helpers/cache-env.mjs';

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

test('reset does not wait on the wipe promise (the wipe is synchronous), so it always reloads', async () => {
  await withReset({ dirty: 0, wipe: () => new Promise(() => {}) }, async (calls) => {
    await AdminCockpit._resetClientState();
    await settle();
    assert.ok(names(calls).includes('reload'));
  });
});

test('A3 M2 reset counts and names edits kept in the cache for OTHER plants, which the wipe would also remove', async () => {
  const lsf = resetCacheEnv({ user: 'planner' });
  const recFor = (plant, rows) => lsf.ls.setItem(LS_RECORD_PREFIX + `planner|${plant}`, JSON.stringify({ key: `planner|${plant}`, user: 'planner', plant, seq: 1, savedAt: 1,
    json: JSON.stringify({ rows: Array.from({ length: rows }, (_, i) => ({ id: 'R' + i })) }) }));
  recFor('Q', 4); recFor('Z', 2);
  const savedPlant = Persistence._currentLoadedPlant; Persistence._currentLoadedPlant = 'P';
  try {
    await withReset({ dirty: 3, choose: null }, async (calls) => {
      assert.equal(Persistence.unsavedCount(), 9, '3 in memory + 4 + 2 stored for other plants');
      await AdminCockpit._resetClientState();
      const ch = calls.find(c => c[0] === 'choose')[1];
      assert.match(ch.message, /modal\.reset_client_pending_msg\|\{"count":9\}/);
      assert.match(ch.message, /modal\.reset_client_pending_plants\|\{"plants":"Q, Z"\}/, 'the other plants are named');
    });
    // nothing in memory, rows only stored (an offline boot): the plain confirm must not be used
    await withReset({ dirty: 0, choose: null }, async (calls) => {
      await AdminCockpit._resetClientState();
      assert.equal(names(calls)[0], 'choose', 'stored-only edits get the Save/discard choice, not the plain confirm');
    });
  } finally { Persistence._currentLoadedPlant = savedPlant; delete globalThis.localStorage; CacheStore._setBackendForTests(); }
});

test('A3 m6 a discarding reset forgets the in-memory unsaved sets, so the reload cannot raise a "Leave site?" prompt', async () => {
  resetCacheEnv({ user: 'planner' });
  const sets = ['_dirtyIds', '_forceIds', '_firmDirtyIds', '_conflictedIds'];
  const saved = Object.fromEntries(sets.map(k => [k, new Set(Persistence[k])]));
  try {
    await withReset({ dirty: 3, choose: 'discard' }, async () => {
      Persistence._forceIds.add('o0'); Persistence._firmDirtyIds.add('o1'); Persistence._conflictedIds.add('o2');
      assert.equal(Persistence.hasPendingWork(false), true);
      await AdminCockpit._resetClientState();
      await settle();
      assert.equal(Persistence.hasPendingWork(false), false, 'dirty, force, firm and conflict sets are empty');
      assert.equal(Persistence.unsavedCount(), 0);
    });
  } finally { for (const k of sets) { Persistence[k].clear(); saved[k].forEach(x => Persistence[k].add(x)); } delete globalThis.localStorage; CacheStore._setBackendForTests(); }
});

test('the signal dispatcher routes client.save to Persistence.saveAll', async () => {
  const real = Persistence.saveAll; let n = 0;
  Persistence.saveAll = () => { n++; };
  try { await AdminCockpit._onSignalFix({ id: 'client.save', labelKey: 'btn.save' }, null); } finally { Persistence.saveAll = real; }
  assert.equal(n, 1);
});
