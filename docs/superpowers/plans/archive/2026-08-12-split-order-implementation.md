# Split Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one NIMBUS order be durably scheduled as multiple productive intervals while retaining one logical order everywhere else.

**Implementation status (2026-08-12):** Implemented on `feature/split-order`. Focused build, static, scheduler, persistence-contract, workbench, and no-DB API-model validation passed. The plan's live PostgreSQL integration/cascade checks remain intentionally unmarked because the requested validation scope was not exhaustive and no local database mutation was performed.

**Architecture:** Add a normalized `order_schedule_segments` aggregate beneath `orders`, using the parent row's `xmin` as the sole concurrency token. Expose a typed `scheduleSegments` collection in the frontend; the compute core becomes the single interval reader, while the scheduling engine owns calendar allocation and policy-aware regeneration. The default `never` policy preserves every existing continuous-order behavior.

**Tech Stack:** PostgreSQL, FastAPI/Pydantic, Python/psycopg, TypeScript ES modules, vanilla browser UI, vis-timeline, Node test runner.

## Global Constraints

- Use `scheduleSegments` only for two or more productive intervals; an empty collection means legacy continuous scheduling.
- Canonical productive duration is `Math.round(Number(RUN_TIME) * 60)` minutes in JavaScript and `Decimal(...).quantize(1, ROUND_HALF_UP)` in Python.
- Segment starts/ends are minute-aligned, ordered, non-overlapping, at least 30 minutes each, and sum exactly to the canonical runtime.
- Parent `start_date`/`end_date` are the first/last segment boundary and are written atomically with the full child set.
- Split policy is plant-only: `never`, `overlong_only`, or `partial_allowed`; missing/invalid values resolve to `never`.
- Do not create hidden segment rows under `never`; retain the existing Remove Backlog continuous overlong exception unchanged.
- Use the existing 90-calendar-day availability bound and plant/line calendar plus blackout intersection.
- Do not create manual segment editing, cross-line splits, MES/SAP segment write-back, or independent segment selection.

---

### Task 1: Persist the order-schedule aggregate and expose it through the API

**Files:**
- Create: `migrations/2026-08-12-order-schedule-segments.sql`
- Modify: `schema.sql`
- Modify: `db.py: _ORDERS_SELECT, get_task_versions(), update_task_dates_bulk()`
- Modify: `brain.py: TaskDTO, TaskDateUpdate, task update normalization, /tasks response, /tasks/refresh`
- Modify: `web/types/api-generated.d.mts`
- Test: `tests/test_task_response_models.py`
- Test: `tests/test_order_schedule_segments.py`

**Consumes:** Existing `orders.id`, scheduled parent dates, `xmin` optimistic concurrency, and `/tasks/update` bulk save contract.

**Produces:** `schedule_segments` wire payloads, aggregate-atomic bulk updates, and parent envelope dates returned by `/tasks`/`/tasks/refresh`.

- [ ] **Step 1: Write failing aggregate validation and response-contract tests**

```python
def test_split_schedule_round_trips_as_one_parent_with_ordered_segments(client):
    body = client.get('/tasks?plant=P1').json()['data'][0]
    assert body['schedule_segments'] == [
        {'sequence': 1, 'start_date': '2026-08-12T08:00:00', 'end_date': '2026-08-12T16:00:00'},
        {'sequence': 2, 'start_date': '2026-08-13T08:00:00', 'end_date': '2026-08-13T10:00:00'},
    ]
    assert body['start_date'] == '2026-08-12T08:00:00'
    assert body['end_date'] == '2026-08-13T10:00:00'

def test_bulk_update_rejects_stale_or_invalid_segment_aggregate(pg):
    result = db.update_task_dates_bulk([{
        'id': 'order-1', 'start': dt(8), 'end': dt(10),
        'schedule_segments': [{'sequence': 1, 'start': dt(8), 'end': dt(9)},
                              {'sequence': 2, 'start': dt(8, 30), 'end': dt(10)}],
        'base_version': current_xmin,
    }])
    assert result['invalid_ids'] == ['order-1']
```

- [ ] **Step 2: Run the focused tests to prove the contract is absent**

Run: `python -m pytest tests/test_task_response_models.py tests/test_order_schedule_segments.py -q`

Expected: FAIL because segment DTOs and persistence do not exist yet. If Python is unavailable, record that environment limitation and run the equivalent Node/API-contract checks after implementation.

- [ ] **Step 3: Add the schema and aggregate-aware data-access path**

```sql
CREATE TABLE IF NOT EXISTS order_schedule_segments (
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    segment_no INTEGER NOT NULL CHECK (segment_no > 0),
    scheduled_start TIMESTAMP NOT NULL,
    scheduled_end TIMESTAMP NOT NULL,
    PRIMARY KEY (order_id, segment_no),
    CHECK (scheduled_end > scheduled_start)
);
CREATE INDEX IF NOT EXISTS idx_order_schedule_segments_order_start
    ON order_schedule_segments(order_id, scheduled_start);
```

```python
# db.py: each locked parent is validated as one aggregate, then its parent
# envelope is updated and its complete child set is DELETE+INSERTed inside the
# SAME transaction. A supplied [] clears obsolete children; an omitted field
# never destroys a child set.
validate_segment_set(order_id, new_run_time, supplied_segments)
update_parent_envelope(order_id, first_start, last_end, attrs, run_time)
replace_segments(cur, order_id, normalized_segments)
```

Use a `LEFT JOIN LATERAL` aggregate in `_ORDERS_SELECT` and `get_task_versions()` to return ordered JSON child rows in one query, while parent start/end resolve to the first/last child when present. Add `runtime_schedule_mismatch` from persisted productive minutes versus canonical runtime.

- [ ] **Step 4: Add typed FastAPI DTOs and preserve aliases at the browser boundary**

```python
class ScheduleSegmentDTO(BaseModel):
    sequence: int
    start_date: str
    end_date: str

class TaskDateUpdate(BaseModel):
    id: str
    schedule_segments: list[ScheduleSegmentInput] | None = None
    RUN_TIME: float | None = None
```

`_apply_task_date_updates()` must pass `schedule_segments` only when Pydantic recorded it as explicitly supplied. Extend `TaskDTO` and refresh rows with `schedule_segments` and `runtime_schedule_mismatch`; manually synchronize the checked-in OpenAPI declaration if the local Python/OpenAPI tool is unavailable.

- [ ] **Step 5: Run aggregate-focused verification**

Run: `python -m pytest tests/test_task_response_models.py tests/test_order_schedule_segments.py -q`

Expected: PASS; invalid/reversed/overlapping/wrong-duration child sets fail without writing the parent or any children, stale `xmin` rejects the whole aggregate, and deleting the parent cascades children.

- [ ] **Step 6: Commit the database/API slice**

```bash
git add schema.sql migrations/2026-08-12-order-schedule-segments.sql db.py brain.py web/types/api-generated.d.mts tests/test_task_response_models.py tests/test_order_schedule_segments.py
git commit -m "feat: persist split order schedules"
```

### Task 2: Define one interval reader and make state/cache/persistence segment-aware

**Files:**
- Modify: `web/types.mts`
- Modify: `web/nimbus-compute-core.js`
- Modify: `web/nimbus-compute-core.d.ts`
- Modify: `web/application-foundation.mts`
- Modify: `web/schedule-state.mts`
- Modify: `web/schedule-data.mts`
- Test: `tests/js/compute-core.test.js`
- Test: `tests/modules/schedule-data.test.mjs`

**Consumes:** API `schedule_segments` wire rows from Task 1 and existing `Store` update/snapshot/autosave contracts.

**Produces:** `Core.scheduleIntervals(task)`, `Util.scheduleIntervals(task)`, normalized Date children, and complete segment payloads on save/refresh/cache restore.

- [ ] **Step 1: Write failing interval and cache-round-trip tests**

```js
test('scheduleIntervals returns productive pieces, not a split parent envelope', () => {
  const intervals = Core.scheduleIntervals({ start_date: at('08:00'), end_date: at('10:00'),
    scheduleSegments: [{ sequence: 1, startDate: at('08:00'), endDate: at('08:30') },
                       { sequence: 2, startDate: at('09:00'), endDate: at('10:00') }] });
  assert.deepEqual(intervals.map(x => [x.start.getMinutes(), x.end.getMinutes()]), [[0, 30], [0, 0]]);
});

test('Persistence.saveAll sends the complete split aggregate and refresh replaces it', () => {
  // assert schedule_segments carries both children in naive-local wire format
});
```

- [ ] **Step 2: Run the focused Node tests to verify failure**

Run: `node --test tests/js/compute-core.test.js tests/modules/schedule-data.test.mjs`

Expected: FAIL because the helper and segment wire serialization are absent.

- [ ] **Step 3: Add model normalization and single-source interval helpers**

```ts
export interface OrderScheduleSegment {
  sequence: number;
  startDate: Date;
  endDate: Date;
}

export type SplitOrderPolicy = 'never' | 'overlong_only' | 'partial_allowed';

// UMD compute core (the only implementation): explicit valid children when
// there are two or more, otherwise [{ start: task.start_date, end: task.end_date }].
function scheduleIntervals(task) { /* normalize/return copied Date boundaries */ }
```

`Persistence._prepTask()` converts `schedule_segments` to `scheduleSegments` Dates. `Store._normalizeDates()` normalizes copied child boundaries along with parent dates. `Persistence.saveAll()` sends the full `schedule_segments` list (or `[]` to clear) with every dirty task; `_refreshTasks()` atomically replaces both parent dates and child list. Bump `Config.SCHEMA_VERSION` because cached task shape changes.

- [ ] **Step 4: Run interval/persistence focused tests**

Run: `node --test tests/js/compute-core.test.js tests/modules/schedule-data.test.mjs`

Expected: PASS; legacy continuous tasks retain one implicit interval and split tasks survive Store snapshots, cache hydration, save payload construction, and stale refresh.

- [ ] **Step 5: Commit the model/persistence slice**

```bash
git add web/types.mts web/nimbus-compute-core.js web/nimbus-compute-core.d.ts web/application-foundation.mts web/schedule-state.mts web/schedule-data.mts tests/js/compute-core.test.js tests/modules/schedule-data.test.mjs
git commit -m "feat: make schedule intervals segment aware"
```

### Task 3: Calculate alerts and utilization from productive intervals

**Files:**
- Modify: `web/nimbus-compute-core.js`
- Modify: `web/nimbus-compute-core.d.ts`
- Modify: `web/schedule-services.mts`
- Modify: `web/types.mts`
- Test: `tests/js/compute-core.test.js`
- Test: `tests/modules/split-order.test.mjs`

**Consumes:** `scheduleIntervals()` from Task 2 and existing calendar/blackout capacity logic.

**Produces:** Segment-aware overlap, blackout, closed-hours, overload/utilization, fixed-boundary checks, and a critical runtime/schedule-mismatch diagnostic.

- [ ] **Step 1: Write failing productive-time tests**

```js
test('split overnight gap creates neither utilization nor blackout work', () => {
  const { matrix } = Core.computeUtilization({ tasks: [splitTask], /* 08-16 + next 08-10 */ });
  assert.equal(matrix.L['2026-08-12'].scheduled, 8);
  assert.equal(matrix.L['2026-08-13'].scheduled, 2);
});

test('a split envelope does not overlap an order placed in its closed overnight gap', () => {
  assert.equal(Core.computeAlerts({ tasks: [splitTask, overnightTask], /* ... */ })
    .alerts.filter(a => a.type === 'overlap').length, 0);
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `node --test tests/js/compute-core.test.js tests/modules/split-order.test.mjs`

Expected: FAIL because the legacy parent envelope is treated as productive.

- [ ] **Step 3: Flatten only explicit child intervals for compute paths**

```js
for (const interval of scheduleIntervals(task)) {
  // overlap/blackout: compare [interval.start, interval.end)
  // utilization/overload: bucket actual productive minutes by calendar day
}
```

Keep the single implicit parent interval on the legacy `never` path so its existing continuous-bar diagnostics remain intact. Add `runtime-schedule-mismatch` as an error-level alert when `task.runtime_schedule_mismatch` is true. Update `Utilization.dayByLine()` to use the same interval reader and use parent-level task IDs in matrix rows so drill-down does not duplicate one logical order.

- [ ] **Step 4: Run focused calculation tests**

Run: `node --test tests/js/compute-core.test.js tests/modules/split-order.test.mjs`

Expected: PASS; productive pieces consume capacity, parent gaps do not, and a split parent remains one task in drill-down/changeover collections.

- [ ] **Step 5: Commit the compute slice**

```bash
git add web/nimbus-compute-core.js web/nimbus-compute-core.d.ts web/schedule-services.mts web/types.mts tests/js/compute-core.test.js tests/modules/split-order.test.mjs
git commit -m "feat: calculate capacity from split order intervals"
```

### Task 4: Add plant policy and pure policy-aware calendar allocation

**Files:**
- Modify: `schema.sql`
- Modify: `migrations/2026-08-12-order-schedule-segments.sql`
- Modify: `master_data.py`
- Modify: `brain.py`
- Modify: `web/types.mts`
- Modify: `web/schedule-services.mts`
- Modify: `web/plant-and-administration.mts`
- Test: `tests/modules/split-order.test.mjs`
- Test: `tests/test_order_schedule_segments.py`

**Consumes:** Existing plant master-data load, line/plant calendars, blackout caches, and Task 2's schedule segment model.

**Produces:** A durable `split_order_policy` setting and pure `Calendar.allocateRuntime()` results that callers can preview before mutating Store.

- [ ] **Step 1: Write failing policy/allocation tests**

```js
test('partial_allowed allocates a 14h order as 12h today plus 2h tomorrow', () => {
  const result = Calendar.allocateRuntime('L', at('2026-08-12T08:00'), 840, 'partial_allowed');
  assert.deepEqual(result.segments.map(s => [s.start, s.end]), [
    [at('2026-08-12T08:00'), at('2026-08-12T20:00')],
    [at('2026-08-13T08:00'), at('2026-08-13T10:00')],
  ]);
});

test('overlong_only keeps an ordinarily fittable order intact but splits an inherently overlong order', () => {
  assert.equal(Calendar.allocateRuntime('L', at('15:00'), 120, 'overlong_only').segments.length, 1);
  assert.equal(Calendar.allocateRuntime('L', at('08:00'), 840, 'overlong_only').segments.length, 2);
});
```

- [ ] **Step 2: Run the focused allocator test to verify failure**

Run: `node --test tests/modules/split-order.test.mjs`

Expected: FAIL because split policy and allocation do not exist.

- [ ] **Step 3: Persist the plant-only policy without changing priority-tree semantics**

```sql
ALTER TABLE plants ADD COLUMN IF NOT EXISTS split_order_policy TEXT NOT NULL DEFAULT 'never'
  CHECK (split_order_policy IN ('never', 'overlong_only', 'partial_allowed'));
```

Add a dedicated authenticated/admin endpoint and `master_data.set_plant_split_order_policy()` validator. Attach the value alongside `constraints` in master-data plant rows, expose it in `NimbusMasterPlant`, and render one select in Plant → Settings → Optimization. Do not put it inside the existing constraint-tree list.

- [ ] **Step 4: Implement pure bounded allocation**

```ts
allocateRuntime(line, earliestStart, runtimeMinutes, policy): AllocationResult {
  // find next effective open [start,end) interval, including blackout gaps
  // `never`: preserve caller's legacy continuous placement
  // `overlong_only`: split only when no nominal window can fit the runtime
  // `partial_allowed`: consume earliest valid pieces until minutes === runtime
  // never emit a segment under 30 minutes unless the entire one-piece runtime is shorter
}
```

Use 90 calendar days, minute precision, blackout-aware intervals, adjacent-piece merging, and tail adjustment (`45 + 25` becomes `40 + 30`). Return an error instead of mutating Store when no operating interval exists or capacity cannot be found.

- [ ] **Step 5: Run policy/allocation tests**

Run: `node --test tests/modules/split-order.test.mjs`

Expected: PASS; weekends/blackouts, minimum segments, tail adjustment, one-piece collapse, and policy defaulting are covered.

- [ ] **Step 6: Commit the policy/allocator slice**

```bash
git add schema.sql migrations/2026-08-12-order-schedule-segments.sql master_data.py brain.py web/types.mts web/schedule-services.mts web/plant-and-administration.mts tests/modules/split-order.test.mjs tests/test_order_schedule_segments.py
git commit -m "feat: add policy-aware split order allocation"
```

### Task 5: Apply the allocator through scheduling, editing, and parent-level rendering

**Files:**
- Modify: `web/schedule-services.mts`
- Modify: `web/schedule-workbench.mts`
- Modify: `web/styles.css`
- Modify: `web/application-foundation.mts`
- Modify: `web/nimbus-intelligence.js`
- Test: `tests/modules/split-order.test.mjs`
- Test: `tests/modules/schedule-workbench.test.mjs`

**Consumes:** Tasks 1–4's durable aggregate, interval helper, calculator, policy, and allocator.

**Produces:** All four optimizer paths create policy-permitted segments; manual logical-order moves regenerate instead of moving pieces independently; timeline/grid/inspector retain one parent interaction model.

- [ ] **Step 1: Write failing scheduler/UI contract tests**

```js
test('Remove Backlog creates segments under partial_allowed but keeps never continuous', () => {
  Store.setMasterData({ plants: [{ plant, timezone: 'America/New_York', split_order_policy: 'partial_allowed' }], lines: [{ production_line: line, plant }] });
  const split = Engine.removeBacklog(opts());
  assert.equal(split.patches[0].changes.scheduleSegments.length, 2);
  Store.masterData.plants[0].split_order_policy = 'never';
  assert.equal(Engine.removeBacklog(opts()).patches[0].changes.scheduleSegments.length, 0);
});

test('Timeline maps two visual segment ids back to one logical parent selection', () => {
  assert.equal(Timeline.parentTaskId('order-1::seg-2'), 'order-1');
});
```

- [ ] **Step 2: Run focused failures**

Run: `node --test tests/modules/split-order.test.mjs tests/modules/schedule-workbench.test.mjs`

Expected: FAIL because scheduler patches and timeline IDs are parent-only.

- [ ] **Step 3: Route all scheduling mutations through one parent allocator seam**

```ts
Engine.schedulePatchFor(task, line, requestedStart, policy)
// => { start_date, end_date, scheduleSegments } | AllocationError
```

Use it in SPT, Changeover/Smart day-integrity dispatch, Remove Backlog, auto-reflow, overlap/blackout auto-fix, table start/runtime edits, inspector edits, and timeline dragging. Preserve selected order sequence, fixed state, line assignment rules, and hard-To eligibility; never insert another parent inside a split parent's envelope. For `never`, retain the prior placement code paths and Remove Backlog continuous exception exactly.

- [ ] **Step 4: Render connected pieces but parent-level interactions**

```ts
const itemId = `${task.id}::seg-${segment.sequence}`;
Timeline.parentTaskId(itemId) // `task.id` for legacy or segmented items
```

Render one item per productive piece, attach segment position/duration to the tooltip, and give pieces a continuation class. Map click, double-click, hover, context menu, drag, selection, focus, ghosts, and data-set updates through `parentTaskId`. A drag on any piece requests a new parent start and regenerates its complete schedule under current policy; table stays one row, inspector displays read-only segment summary, and printing/export uses parent envelope plus productive runtime.

- [ ] **Step 5: Reconcile runtime changes without overwriting authoritative scheduling**

```ts
Engine.reconcileRuntimeSchedule(task): SchedulePatch | null
// runs only when runtime_schedule_mismatch is true; preserve current parent start,
// allocate under the active plant policy, retain previous valid aggregate on failure.
```

Invoke after backend task/calendar hydration, not after ordinary basic-date changes. Surface mismatch as a critical diagnostic until a successful planner/heuristic regeneration persists the corrected aggregate.

- [ ] **Step 6: Run focused scheduling and workbench tests**

Run: `node --test tests/modules/split-order.test.mjs tests/modules/remove-backlog.test.mjs tests/modules/schedule-workbench.test.mjs`

Expected: PASS; all four modes respect policy, `never` keeps legacy results, a split Gantt item selects one parent, and drag/undo/preview/discard preserve complete aggregates.

- [ ] **Step 7: Commit the scheduling/UI slice**

```bash
git add web/schedule-services.mts web/schedule-workbench.mts web/styles.css web/application-foundation.mts web/nimbus-intelligence.js tests/modules/split-order.test.mjs tests/modules/schedule-workbench.test.mjs
git commit -m "feat: schedule and render split orders"
```

### Task 6: Validate in context and complete handoff documentation

**Files:**
- Modify: `docs/superpowers/specs/split-order.md`
- Modify: `docs/superpowers/plans/2026-08-12-split-order-implementation.md`
- Test: `tests/modules/split-order.test.mjs`

**Consumes:** Completed feature slices.

**Produces:** An evidence-backed implementation status and a clean reviewable feature branch.

- [ ] **Step 1: Run static and focused behavioral checks**

Run:

```bash
npm run build
node --test tests/js/compute-core.test.js tests/modules/split-order.test.mjs tests/modules/remove-backlog.test.mjs tests/modules/schedule-data.test.mjs tests/modules/schedule-workbench.test.mjs
git diff --check
git status --short
```

Expected: build succeeds; focused interval, allocator, backlog, persistence, and workbench tests pass; no whitespace errors; only deliberate feature changes are present.

- [ ] **Step 2: Review critical compatibility cases manually from test output and code paths**

Confirm these exact cases before handoff: legacy no-segment reads/saves; `never` SPT/Changeover/Smart behavior; Remove Backlog `never` continuous overlong behavior; 12h+2h valid pieces; 30-minute tail; fixed parent movement; protected To boundary; cache/refresh replacement; cascade delete; and stale parent version rejection.

- [ ] **Step 3: Mark the spec and plan as implemented**

```markdown
**Status:** Implemented on `feature/split-order`; focused validation recorded in the implementation handoff.
```

Check every task checkbox in this plan only after its listed verification has completed.

- [ ] **Step 4: Commit documentation and final state**

```bash
git add docs/superpowers/specs/split-order.md docs/superpowers/plans/2026-08-12-split-order-implementation.md
git commit -m "docs: complete split order implementation plan"
git status --short
```
