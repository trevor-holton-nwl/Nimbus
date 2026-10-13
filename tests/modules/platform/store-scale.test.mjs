import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../frontend/platform/store.mjs';

function enterprise(t) {
  const previous = { tasks: Store.tasksArr, master: Store.masterData, plant: Store.selectedPlant, alerts: Store.alerts };
  t.after(() => {
    Store.setMasterData(previous.master, 'test'); Store.setTasks(previous.tasks, 'test');
    Store.setSelectedPlant(previous.plant, 'test'); Store.setAlerts(previous.alerts, 'test');
  });
  const plants = Array.from({ length: 50 }, (_, p) => ({ plant: `P${p}` }));
  const lines = plants.flatMap(({ plant }) => Array.from({ length: 70 }, (_, m) => ({ plant, machine: `${plant}-M${m}` })));
  Store.setMasterData({ plants, lines }, 'test');
  // Four children per parent, 70 parents per plant: 14,000 orders total.
  const tasks = lines.flatMap(({ plant, machine }, m) => Array.from({ length: 4 }, (_, child) => ({
    id: `${machine}-${child}`, PLANT: plant, MACHINE: machine, RUN_TIME: 1,
    PARENT_ORDER: `${plant}-PARENT${m % 70}`, DISTRIBUTION_LETTER: String.fromCharCode(65 + child),
    planning_status: 'scheduled', start_date: new Date(2026, 9, 13, 8 + child), end_date: new Date(2026, 9, 13, 9 + child),
  })));
  assert.deepEqual(Store.setTasks(tasks, 'test'), { inserted: 14000, collisions: 0 });
  Store.setSelectedPlant('P0', 'test');
  return tasks;
}

test('a 14,000-order bulk edit emits one complete notification and preserves indexed task identities', t => {
  const tasks = enterprise(t);
  const events = [];
  const off = Store.subscribe(event => events.push(event));
  t.after(off);
  const rev = Store.rev();
  Store.updateMany(tasks.map(task => ({ id: task.id, changes: { PRODUCTION_VERSION: '0002' } })), 'table');
  assert.equal(Store.rev(), rev + 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tasks:bulkUpdate');
  assert.deepEqual(events[0].ids, tasks.map(task => task.id));
  assert.equal(new Set(events[0].ids).size, 14000);
  for (let p = 0; p < 50; p++) {
    const scoped = Store.tasksByPlant(`P${p}`);
    assert.equal(scoped.length, 280);
    for (const task of scoped) {
      assert.equal(task.PLANT, `P${p}`);
      assert.equal(task.PRODUCTION_VERSION, '0002');
      assert.equal(task, Store.tasks[task.id]);
    }
  }
});

test('sibling memo serves 14,000 renderer reads, invalidates on edits, and never leaks another plant', t => {
  enterprise(t);
  let previousMap;
  for (let p = 0; p < 50; p++) {
    Store.setSelectedPlant(`P${p}`, 'test');
    const index = Store.siblingsByParent();
    assert.notEqual(index, previousMap);
    assert.equal(index.size, 70);
    const seen = new Set();
    for (const task of Store.tasksForSelectedPlant()) {
      assert.equal(Store.siblingsByParent(), index, 'rendering each row must reuse the index');
      const siblings = index.get(task.PARENT_ORDER);
      assert.equal(siblings.length, 4);
      assert.ok(siblings.includes(task));
      assert.ok(siblings.every(sibling => sibling.PLANT === `P${p}`));
      seen.add(task.id);
    }
    assert.equal(seen.size, 280);
    previousMap = index;
  }
  const task = Store.tasksForSelectedPlant()[0];
  Store.updateTask(task.id, { PRODUCTION_VERSION: '0002' }, 'table');
  const refreshed = Store.siblingsByParent();
  assert.notEqual(refreshed, previousMap);
  assert.equal(refreshed.get(task.PARENT_ORDER).find(row => row.id === task.id), Store.tasks[task.id]);
  assert.equal(refreshed.get(task.PARENT_ORDER).find(row => row.id === task.id).PRODUCTION_VERSION, '0002');
});

test('14,000 alert memberships reuse one index and dismiss invalidates only the removed membership', t => {
  const tasks = enterprise(t);
  const alerts = tasks.map(task => ({ id: `alert-${task.id}`, taskId: task.id, line: task.MACHINE, type: 'late', severity: 'warn' }));
  Store.setAlerts(alerts, 'test');
  const index = Store.alertsByTask();
  assert.equal(index.size, 14000);
  for (const alert of alerts) {
    assert.equal(Store.alertsByTask(), index);
    assert.deepEqual(index.get(alert.taskId), [alert]);
  }
  Store.dismissAlert(alerts[7000].id, 'test');
  const refreshed = Store.alertsByTask();
  assert.notEqual(refreshed, index);
  assert.equal(refreshed.size, 13999);
  assert.equal(refreshed.has(alerts[7000].taskId), false);
  assert.equal(Store.alerts.length, 13999);
  for (const alert of Store.alerts) assert.equal(refreshed.get(alert.taskId)[0], alert);
});
