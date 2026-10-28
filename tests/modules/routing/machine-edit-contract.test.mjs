import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';
import { Table, Inspector } from '../../../frontend/scheduling/orders.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Toast } from '../../../frontend/platform/foundation.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';

globalThis.window = {};
globalThis.document = { getElementById: () => null };
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

// Placement holds the FINISH and derives the start from the plant's working time (backward scheduling Task 2.5), so
// the plant needs a time zone and a pinned server clock (these orders are dated 2026-09-30).
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const REAL_SERVER_OFFSET_MS = Store.serverOffsetMs;
afterEach(() => { Store.serverOffsetMs = REAL_SERVER_OFFSET_MS; Store._blockedPlants.clear(); });

function seed() {
  Store.setMasterData({ plants: [{plant:'P', routing_runtime_enabled:true, split_order_policy:'partial_allowed', timezone: LOCAL_TZ}], lines:[], materials:[] }, 'test');
  Store.serverOffsetMs = new Date('2026-09-01T00:00:00').getTime() - Date.now();
  Store._blockedPlants.clear();
  Store.setTasks([{id:'move', PLANT:'P', MATERIAL_NUMBER:'MAT', PRODUCTION_VERSION:'0001', MACHINE:'M1',
    'ORDER_QUANTITY_(GMEIN)':60, RUN_TIME:3, run_time_source:'routing', planning_status:'scheduled',
    start_date:new Date('2026-09-30T13:00:00'), end_date:new Date('2026-09-30T16:00:00')}], 'test');
  Runtime._rateMapPlant='P';
  // Two work centers: PV 0001 runs on WC1 (M1, M3), PV 0002 on WC2 (M2), PV 0003 is a second version on WC1.
  Runtime._rateMap={plant:'P',generated_at:'',machines:{M1:'WC1',M2:'WC2',M3:'WC1'},
    pv:{'MAT|0001':{key:'MAT|N|G|01',valid_from:null,valid_to:null,workcenter:'WC1'},
        'MAT|0002':{key:'MAT|N|G|02',valid_from:null,valid_to:null,workcenter:'WC2'},
        'MAT|0003':{key:'MAT|N|G|03',valid_from:null,valid_to:null,workcenter:'WC1'}},
    ops:{'MAT|N|G|01|WC1':{minutes_per_unit:3},'MAT|N|G|02|WC2':{minutes_per_unit:6},'MAT|N|G|03|WC1':{minutes_per_unit:4}}};
}

test('PV - Machine grid edit uses the target pair runtime before constructing the bar', () => {
  seed();
  const priorApi=Table._api, priorToast=Toast.show, priorAlerts=Alerts.scheduleRecompute;
  Table._api={applyTransaction(){},refreshCells(){}};
  Toast.show=()=>{};
  Alerts.scheduleRecompute=()=>{};
  try {
    const task=Store.tasks.move;
    task.MACHINE='0002|M2';   // AG Grid writes the raw editor value before the handler runs
    Table._onCellChanged({colDef:{field:'MACHINE'},data:task,newValue:'0002|M2',oldValue:'M1',node:{}});
    const updated=Store.tasks.move;
    assert.equal(updated.MACHINE,'M2');
    assert.equal(updated.PRODUCTION_VERSION,'0002');
    assert.equal(updated.RUN_TIME,6);
    assert.equal(updated.end_date.getTime(), new Date('2026-09-30T16:00:00').getTime(), 'the finish is held across the pair move');
    assert.equal((updated.end_date-updated.start_date)/3600000,6, 'the longer run time pulls the start earlier');
    assert.equal(updated.run_time_basis.workcenter,'WC2');
  } finally { Table._api=priorApi; Toast.show=priorToast; Alerts.scheduleRecompute=priorAlerts; }
});

test('undo after a grid pair edit restores production version, machine and run time', () => {
  seed();
  const priorApi=Table._api, priorToast=Toast.show, priorAlerts=Alerts.scheduleRecompute;
  Table._api={applyTransaction(){},refreshCells(){}};
  Toast.show=()=>{};
  Alerts.scheduleRecompute=()=>{};
  const before=UndoStack._entries.length;
  try {
    const task=Store.tasks.move;
    task.MACHINE='0002|M2';
    Table._onCellChanged({colDef:{field:'MACHINE'},data:task,newValue:'0002|M2',oldValue:'M1',node:{}});
    assert.equal(UndoStack._entries.length,before+1,'one undo step');
    UndoStack.pop();
    const restored=Store.tasks.move;
    assert.equal(restored.PRODUCTION_VERSION,'0001');
    assert.equal(restored.MACHINE,'M1');
    assert.equal(restored.RUN_TIME,3);
  } finally { UndoStack._entries.length=before; Table._api=priorApi; Toast.show=priorToast; Alerts.scheduleRecompute=priorAlerts; }
});

test('manual routing placement resets a manual runtime to the routing value when the line changes (D9)', () => {
  seed();
  const task={...Store.tasks.move,run_time_source:'manual',RUN_TIME:5};
  const patch=Engine.manualRoutingSchedulePatchFor(task,'M3',task.end_date);
  assert.equal(patch.RUN_TIME,3,'the run time resets to the routing value at the new machine');
  assert.equal(patch.run_time_source,'routing');
  assert.equal((patch.end_date-patch.start_date)/3600000,3);
  assert.equal(patch.end_date.getTime(), task.end_date.getTime(), 'the finish is held');
  // A same-line call (a plain time edit) still keeps the hand-timed run time.
  const sameLine=Engine.manualRoutingSchedulePatchFor({...task,end_date:new Date('2026-09-30T18:00:00'),start_date:new Date('2026-09-30T13:00:00')},'M1',new Date('2026-09-30T18:00:00'));
  assert.equal(sameLine.RUN_TIME,undefined);
  assert.equal((sameLine.end_date-sameLine.start_date)/3600000,5);
});

test('pairSchedulePatchFor: a PV-only change on the same line resolves explicitly and writes the whole pair in one patch', () => {
  seed();
  const task=Store.tasks.move;
  const patch=Engine.pairSchedulePatchFor(task,'0003','M1',task.end_date);
  assert.equal(patch.PRODUCTION_VERSION,'0003');
  assert.equal(patch.MACHINE,'M1');
  assert.equal(patch.RUN_TIME,4);
  assert.equal(patch.run_time_source,'routing');
  assert.equal(patch.run_time_basis.workcenter,'WC1');
  assert.equal((patch.end_date-patch.start_date)/3600000,4);
  assert.equal(patch.end_date.getTime(),task.end_date.getTime());
});

test('pairSchedulePatchFor: line-only and PV+line changes', () => {
  seed();
  const task=Store.tasks.move;
  const lineOnly=Engine.pairSchedulePatchFor(task,'0001','M3',task.end_date);
  assert.equal(lineOnly.MACHINE,'M3'); assert.equal(lineOnly.PRODUCTION_VERSION,'0001'); assert.equal(lineOnly.RUN_TIME,3);
  const both=Engine.pairSchedulePatchFor(task,'0002','M2',task.end_date);
  assert.equal(both.MACHINE,'M2'); assert.equal(both.PRODUCTION_VERSION,'0002'); assert.equal(both.RUN_TIME,6);
  assert.equal(both.run_time_basis.workcenter,'WC2');
  assert.equal((both.end_date-both.start_date)/3600000,6);
});

test('pairSchedulePatchFor: null on a pair that does not resolve (no refusal recorded); chosenPv routes through it', () => {
  seed();
  const task=Store.tasks.move;
  Engine.lastManualRefusal='finish_cannot_hold';
  assert.equal(Engine.pairSchedulePatchFor(task,'0001','M2',task.end_date),null,'0001 covers WC1 only');
  assert.equal(Engine.lastManualRefusal,null,'a resolve failure is not a placement refusal');
  assert.equal(Engine.pairSchedulePatchFor(task,'0009','M1',task.end_date),null,'unknown version');
  const viaChosen=Engine.manualRoutingSchedulePatchFor(task,'M2',task.end_date,{chosenPv:'0002'});
  assert.equal(viaChosen.PRODUCTION_VERSION,'0002'); assert.equal(viaChosen.RUN_TIME,6);
  assert.equal(Engine.manualRoutingSchedulePatchFor(task,'M2',task.end_date,{chosenPv:'0001'}),null);
});

test('pairSchedulePatchFor keeps the placement refusal reason so overtime-confirm and running-locked explanations still work', () => {
  seed();
  const task=Store.tasks.move;
  const prior=Engine.finishAnchoredPatchFor;
  Engine.finishAnchoredPatchFor=()=>({kind:'refuse',reason:'no_operating_window'});
  try {
    assert.equal(Engine.pairSchedulePatchFor(task,'0002','M2',task.end_date),null);
    assert.equal(Engine.lastManualRefusal,'no_operating_window');
  } finally { Engine.finishAnchoredPatchFor=prior; }
  const running={...task,user_scheduled:true,start_date:new Date('2026-09-01T00:00:00'),end_date:new Date('2026-09-01T03:00:00')};
  assert.equal(Engine.pairSchedulePatchFor(running,'0002','M2',new Date('2026-09-30T16:00:00')),null);
  assert.equal(Engine.lastManualRefusal,'running_finish_locked');
});

test('a current pair that is no longer eligible is offered first with the not-eligible label, and can be left for an eligible pair', () => {
  seed();
  const priorLocales=globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES={en:{'ui.pv_machine_option':'{{pv}} - {{machine}}','ui.pv_machine_current_ineligible':'{{pv}} - {{machine}} (current, not eligible)'}};
  try {
    const task={...Store.tasks.move,PRODUCTION_VERSION:'0002'};   // PV 0002 runs on WC2, the order sits on M1 (WC1)
    const options=Table._getPairOptions(task);
    assert.deepEqual(options[0],{value:'0002|M1',label:'0002 - M1 (current, not eligible)'});
    assert.deepEqual(options.slice(1).map(o=>o.value),['0001|M1','0001|M3','0002|M2','0003|M1','0003|M3']);
    const patch=Engine.pairSchedulePatchFor(task,'0001','M1',task.end_date);
    assert.equal(patch.PRODUCTION_VERSION,'0001'); assert.equal(patch.RUN_TIME,3);
  } finally { globalThis.window.__NIMBUS_LOCALES=priorLocales; }
});

test('failed split reallocation restores the cell already mutated by AG Grid', () => {
  seed();
  const task=Store.tasks.move;
  task.scheduleSegments=[
    {sequence:1,startDate:new Date('2026-09-30T08:00:00'),endDate:new Date('2026-09-30T09:00:00')},
    {sequence:2,startDate:new Date('2026-09-30T10:00:00'),endDate:new Date('2026-09-30T12:00:00')},
  ];
  const prior=Engine.finishAnchoredPatchFor, priorApi=Table._api, priorToast=Toast.show;
  Engine.finishAnchoredPatchFor=()=>({kind:'refuse',reason:'no_operating_window'});
  Table._api={refreshCells(){}};
  Toast.show=()=>{};
  try {
    task.MACHINE='0002|M2';
    Table._onCellChanged({colDef:{field:'MACHINE'},data:task,newValue:'0002|M2',oldValue:'M1',node:{}});
    assert.equal(Store.tasks.move.MACHINE,'M1');
    assert.equal(Store.tasks.move.PRODUCTION_VERSION,'0001');
    assert.equal(Store.tasks.move.RUN_TIME,3);
    assert.equal(Store.tasks.move.scheduleSegments.length,2);
  } finally { Engine.finishAnchoredPatchFor=prior; Table._api=priorApi; Toast.show=priorToast; }
});

test('changed runtime of an existing split aggregate is reallocated, unchanged runtime translates pieces', () => {
  seed();
  const task={...Store.tasks.move,RUN_TIME:6,scheduleSegments:[
    {sequence:1,startDate:new Date('2026-09-30T08:00:00'),endDate:new Date('2026-09-30T09:00:00')},
    {sequence:2,startDate:new Date('2026-09-30T10:00:00'),endDate:new Date('2026-09-30T12:00:00')},
  ]};
  const prior=Engine.finishAnchoredPatchFor;
  const allocated={start_date:new Date('2026-09-30T10:00:00'),end_date:new Date('2026-09-30T16:00:00'),scheduleSegments:[]};
  let calls=0, probes=0;
  const stillSplit=[{sequence:1,startDate:new Date('2026-09-30T08:00:00'),endDate:new Date('2026-09-30T09:00:00')},
    {sequence:2,startDate:new Date('2026-09-30T10:00:00'),endDate:new Date('2026-09-30T12:00:00')}];
  Engine.finishAnchoredPatchFor=(candidate,line,finish,policy)=>{
    // 2026-10-28: an unchanged-total split first probes whether the run now fits ONE window. This destination
    // still needs splitting (the probe returns pieces), so the rigid translation below stays the pinned case.
    if(candidate.RUN_TIME===3){ probes++; return {kind:'placed',finishMoved:false,changes:{scheduleSegments:stillSplit}}; }
    calls++; assert.equal(candidate.RUN_TIME,6); assert.equal(policy,'partial_allowed');
    assert.equal(finish.getTime(), task.end_date.getTime(), 'the re-derivation is anchored on the held finish');
    return {kind:'placed',finishMoved:false,changes:allocated};
  };
  try {
    const patch=Engine.manualSchedulePatchFor(task,'M2',task.end_date);
    assert.equal(calls,1);
    assert.equal(patch.end_date,allocated.end_date);
    // Unchanged run time: a rigid translation by the finish delta (+1 h), no re-derivation.
    const translated=Engine.manualSchedulePatchFor({...task,RUN_TIME:3},'M2',new Date('2026-09-30T13:00:00'));
    assert.equal(calls,1);
    assert.equal(probes,1);
    assert.equal(translated.scheduleSegments[0].startDate.getHours(),9);
    assert.equal(translated.scheduleSegments[1].startDate.getHours(),11);
  } finally { Engine.finishAnchoredPatchFor=prior; }
});

function heldEditFixture(t, { anchor = new Date('2026-09-30T17:00:00'), reason = 'runtime_unknown' } = {}) {
  seed();
  const task = Store.tasks.move;
  // A held order has no placed finish: it anchors on its due instant (the SAP finish as received).
  Object.assign(task, Persistence._prepTask({ start_date: null, end_date: null,
    original_end_date: anchor instanceof Date && Number.isFinite(anchor.getTime()) ? '2026-09-30T17:00:00' : null,
    RUN_TIME: null, run_time_source: null, planning_status: 'needs_planning',
    planning_reason: { code: reason, message: 'Awaiting routing' }, schedule_segments: [] }));
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Alerts, 'scheduleRecompute', () => {});
  t.mock.method(Inspector, '_render', () => {});
  const priorApi = Table._api, priorId = Inspector._currentId;
  Table._api = { applyTransaction() {}, refreshCells() {} };
  Inspector._currentId = 'move';
  t.after(() => { Table._api = priorApi; Inspector._currentId = priorId; });
  return (surface, field, value) => {
    // PAIR is the routing plant's "PV - Machine" edit (the only writer of the production version, D11).
    if (surface === 'table') {
      const gridField = field === 'PAIR' ? 'MACHINE' : field;
      const oldValue = task[gridField];
      task[gridField] = value;   // AG Grid writes the raw editor value first
      Table._onCellChanged({ colDef: { field: gridField }, data: task, oldValue, newValue: value, node: {} });
    } else Inspector._onFieldChange(field === 'PAIR' ? 'PV_MACHINE' : field, String(value));
    return Store.tasks.move;
  };
}

for (const surface of ['table', 'inspector']) {
  for (const [field, value, hours, source] of [
    ['PAIR', '0003|M1', 4, 'routing'], ['PAIR', '0002|M2', 6, 'routing'], ['RUN_TIME', 4, 4, 'manual'],
  ]) {
    test(`${surface} ${field} resolution releases a routing hold so it ends at its due instant`, t => {
      const edit = heldEditFixture(t);
      const task = edit(surface, field, value);
      assert.equal(task.RUN_TIME, hours);
      assert.equal(task.run_time_source, source);
      assert.equal(task.planning_status, 'scheduled');
      assert.equal(task.planning_reason, null);
      assert.equal(task.end_date?.getTime(), new Date('2026-09-30T17:00:00').getTime(), 'the bar ends at the due instant');
      assert.equal((task.end_date - task.start_date) / 3600000, hours, 'the start is derived from the run time');
      const snapshot = Persistence._taskEditSnapshot(task);
      assert.equal(snapshot.end_date, '2026-09-30T17:00:00');
      assert.equal(snapshot.start_date, `2026-09-30T${String(17 - hours).padStart(2, '0')}:00:00`);
      assert.equal(snapshot.RUN_TIME, hours);
    });
  }
  for (const [field, value, hours] of [
    ['PAIR', '0003|M1', 4], ['PAIR', '0002|M2', 6], ['RUN_TIME', 4, 4],
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
  test(`${surface} PV change preserves an unrelated hold despite a valid due date`, t => {
    const edit = heldEditFixture(t, { reason: 'setup_missing' });
    const task = edit(surface, 'PAIR', '0003|M1');
    assert.equal(task.planning_status, 'needs_planning');
    assert.equal(task.planning_reason.code, 'setup_missing');
    assert.equal(task.start_date, null);
  });
}
