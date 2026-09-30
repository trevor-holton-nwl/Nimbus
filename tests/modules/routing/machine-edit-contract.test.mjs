import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';
import { Table, Inspector } from '../../../frontend/scheduling/orders.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Toast } from '../../../frontend/platform/foundation.mjs';

globalThis.window = {};
globalThis.document = { getElementById: () => null };

function seed() {
  Store.setMasterData({ plants: [{plant:'P', routing_runtime_enabled:true, split_order_policy:'partial_allowed'}], lines:[], materials:[] }, 'test');
  Store.setTasks([{id:'move', PLANT:'P', MATERIAL_NUMBER:'MAT', PRODUCTION_VERSION:'0001', MACHINE:'M1',
    'ORDER_QUANTITY_(GMEIN)':60, RUN_TIME:3, run_time_source:'routing', planning_status:'scheduled',
    start_date:new Date('2026-09-30T08:00:00'), end_date:new Date('2026-09-30T11:00:00')}], 'test');
  Runtime._rateMapPlant='P';
  Runtime._rateMap={plant:'P',generated_at:'',machines:{M1:'WC1',M2:'WC2'},
    pv:{'MAT|0001':{key:'MAT|N|G|01',valid_from:null,valid_to:null}},
    ops:{'MAT|N|G|01|WC1':{minutes_per_unit:3},'MAT|N|G|01|WC2':{minutes_per_unit:6}}};
}

test('machine grid edit uses target machine runtime before constructing the bar', () => {
  seed();
  const priorApi=Table._api, priorToast=Toast.show, priorAlerts=Alerts.scheduleRecompute;
  Table._api={applyTransaction(){},refreshCells(){}};
  Toast.show=()=>{};
  Alerts.scheduleRecompute=()=>{};
  try {
    const task=Store.tasks.move;
    task.MACHINE='M2';
    Table._onCellChanged({colDef:{field:'MACHINE'},data:task,newValue:'M2',oldValue:'M1',node:{}});
    const updated=Store.tasks.move;
    assert.equal(updated.RUN_TIME,6);
    assert.equal((updated.end_date-updated.start_date)/3600000,6);
    assert.equal(updated.run_time_basis.workcenter,'WC2');
  } finally { Table._api=priorApi; Toast.show=priorToast; Alerts.scheduleRecompute=priorAlerts; }
});

test('manual routing placement preserves a manual runtime when changing machines', () => {
  seed();
  const task={...Store.tasks.move,run_time_source:'manual'};
  const patch=Engine.manualRoutingSchedulePatchFor(task,'M2',task.start_date);
  assert.equal((patch.end_date-patch.start_date)/3600000,3);
  assert.equal(patch.RUN_TIME,undefined);
});

test('failed split reallocation restores the cell already mutated by AG Grid', () => {
  seed();
  const task=Store.tasks.move;
  task.scheduleSegments=[
    {sequence:1,startDate:new Date('2026-09-30T08:00:00'),endDate:new Date('2026-09-30T09:00:00')},
    {sequence:2,startDate:new Date('2026-09-30T10:00:00'),endDate:new Date('2026-09-30T12:00:00')},
  ];
  const prior=Engine.schedulePatchFor, priorApi=Table._api, priorToast=Toast.show;
  Engine.schedulePatchFor=()=>null;
  Table._api={refreshCells(){}};
  Toast.show=()=>{};
  try {
    task.MACHINE='M2';
    Table._onCellChanged({colDef:{field:'MACHINE'},data:task,newValue:'M2',oldValue:'M1',node:{}});
    assert.equal(Store.tasks.move.MACHINE,'M1');
    assert.equal(Store.tasks.move.RUN_TIME,3);
    assert.equal(Store.tasks.move.scheduleSegments.length,2);
  } finally { Engine.schedulePatchFor=prior; Table._api=priorApi; Toast.show=priorToast; }
});

test('changed runtime of an existing split aggregate is reallocated, unchanged runtime translates pieces', () => {
  seed();
  const task={...Store.tasks.move,RUN_TIME:6,scheduleSegments:[
    {sequence:1,startDate:new Date('2026-09-30T08:00:00'),endDate:new Date('2026-09-30T09:00:00')},
    {sequence:2,startDate:new Date('2026-09-30T10:00:00'),endDate:new Date('2026-09-30T12:00:00')},
  ]};
  const prior=Engine.schedulePatchFor;
  const allocated={start_date:task.start_date,end_date:new Date('2026-09-30T14:00:00'),scheduleSegments:[]};
  let calls=0;
  Engine.schedulePatchFor=(candidate,line,start,policy)=>{
    calls++; assert.equal(candidate.RUN_TIME,6); assert.equal(policy,'partial_allowed'); return allocated;
  };
  try {
    const patch=Engine.manualSchedulePatchFor(task,'M2',task.start_date);
    assert.equal(calls,1);
    assert.equal(patch.end_date,allocated.end_date);
    const translated=Engine.manualSchedulePatchFor({...task,RUN_TIME:3},'M2',new Date('2026-09-30T09:00:00'));
    assert.equal(calls,1);
    assert.equal(translated.scheduleSegments[0].startDate.getHours(),9);
    assert.equal(translated.scheduleSegments[1].startDate.getHours(),11);
  } finally { Engine.schedulePatchFor=prior; }
});

function heldEditFixture(t, { anchor = new Date('2026-09-30T08:00:00'), reason = 'runtime_unknown' } = {}) {
  seed();
  const task = Store.tasks.move;
  Object.assign(task, { start_date: null, end_date: null, BASIC_START_DATE: anchor,
    RUN_TIME: null, run_time_source: null, planning_status: 'needs_planning',
    planning_reason: { code: reason, message: 'Awaiting routing' }, scheduleSegments: [] });
  Runtime._rateMap.pv['MAT|0002'] = { key: 'MAT|N|G|01', valid_from: null, valid_to: null };
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Alerts, 'scheduleRecompute', () => {});
  t.mock.method(Inspector, '_render', () => {});
  const priorApi = Table._api, priorId = Inspector._currentId;
  Table._api = { applyTransaction() {}, refreshCells() {} };
  Inspector._currentId = 'move';
  t.after(() => { Table._api = priorApi; Inspector._currentId = priorId; });
  return (surface, field, value) => {
    if (surface === 'table') {
      const oldValue = task[field];
      task[field] = value;
      Table._onCellChanged({ colDef: { field }, data: task, oldValue, newValue: value, node: {} });
    } else Inspector._onFieldChange(field, String(value));
    return Store.tasks.move;
  };
}

for (const surface of ['table', 'inspector']) {
  for (const [field, value, hours, source] of [
    ['PRODUCTION_VERSION', '0002', 3, 'routing'], ['MACHINE', 'M2', 6, 'routing'], ['RUN_TIME', 4, 4, 'manual'],
  ]) {
    test(`${surface} ${field} resolution places a routing hold at its existing SAP start`, t => {
      const edit = heldEditFixture(t);
      const task = edit(surface, field, value);
      assert.equal(task.RUN_TIME, hours);
      assert.equal(task.run_time_source, source);
      assert.equal(task.planning_status, 'scheduled');
      assert.equal(task.planning_reason, null);
      assert.equal(task.start_date?.getTime(), new Date('2026-09-30T08:00:00').getTime());
      assert.equal((task.end_date - task.start_date) / 3600000, hours);
    });
  }
  for (const [field, value, hours] of [
    ['PRODUCTION_VERSION', '0002', 3], ['MACHINE', 'M2', 6], ['RUN_TIME', 4, 4],
  ]) for (const anchor of [null, new Date('invalid')]) {
    test(`${surface} resolved ${field} retains the hold without a valid start anchor (${anchor})`, t => {
      const edit = heldEditFixture(t, { anchor });
      const task = edit(surface, field, value);
      assert.equal(task.RUN_TIME, hours);
      assert.equal(task.planning_status, 'needs_planning');
      assert.equal(task.planning_reason.code, 'runtime_unknown');
      assert.equal(task.start_date, null);
      assert.equal(task.end_date, null);
    });
  }
  test(`${surface} PV change preserves an unrelated hold despite a valid SAP anchor`, t => {
    const edit = heldEditFixture(t, { reason: 'setup_missing' });
    const task = edit(surface, 'PRODUCTION_VERSION', '0002');
    assert.equal(task.planning_status, 'needs_planning');
    assert.equal(task.planning_reason.code, 'setup_missing');
    assert.equal(task.start_date, null);
  });
}
