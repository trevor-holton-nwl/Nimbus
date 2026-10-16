# Independent planning package review

Date: 2026-10-16. Reviewer: independent Astra review agent. Baseline: `960abf6`; worktree: `.worktrees/frontend-audit`. Read-only implementation review; this report is the only reviewer-authored file. No database, deployment, or live writes.

## Disposition

**Changes requested: one confirmed medium-severity calendar consistency issue remains.** The existing focused tests all pass. No other confirmed regression was found in the reviewed Scheduling/Orders, context menu, print scope, or Distribution changes. Browser-dependent validation remains pending.

## Finding R-PLN-001 — deferred hydration can overwrite the live hours resumed after What-If discard

- **Severity:** Medium (P2).
- **Code:** `frontend/calendar/calendar-sync.mts:397–406` (new exit listener), interacting with `frontend/optimization/optimize-ui.mts:3064–3070` (deferred GET on discard) and `CalendarSync._applyConfig`.
- **Status:** Open; sent to root for author correction.
- **Impact:** The backend receives the preserved live edit, but the browser displays and schedules against older working hours until another refresh. This is an incomplete resolution of PLN-003: baseline also lost this live edit, so this finding is not characterized as a wholly new workflow regression.
- **Reproduction:** Start with server L1 hours 08:00–16:00. Edit live hours to 09:00–17:00 and queue `saveLineHours`. Enter What-If before the debounce. A pending calendar GET resolves while What-If is active, causing `_applyConfig` to record P1 in `_deferredHydrationPlant`. Expire the debounce inside What-If, then discard. The already-registered SandboxAdapter starts a fresh deferred GET before the subsequently registered queue listener sends the preserved hours. A response representing the earlier server state then applies after the queue has been drained.
- **Observed:** Request order was GET `/plant-calendar?plant=P1`, then POST `/plant-calendar/line-hours` containing `{1:[9,17]}`. After settling, `Store.calendars.L1.workHours` was `{1:[8,16]}` and the pending queue was empty. An assertion expecting `{1:[9,17]}` failed with exit code 1. The reproduction used the real `Sandbox.exit`, `SandboxAdapter._onExited`, `CalendarSync`, and `Store`; only DOM, feedback, and transport were stubbed. No swallowed Store-listener error occurred in the confirmed run.
- **Required correction:** Coordinate resumed live-hour persistence with deferred hydration. Do not apply a fetched line-hours value over a queued or in-flight newer local edit. If sequencing a refetch after the write, keep failed live edits visible with their existing Retry contract, and ensure another local edit made during either request also wins. Preserve unrelated plant and line hydration.
- **Required regression:** Exercise the actual adapter subscriber registered before the queue subscriber, with deferred GET resolving before the preserved POST is acknowledged. Assert both POST payload and final Store state. Cover successful and failed POST plus unrelated-line hydration; retain existing discard/promotion queue tests.

Minimal executable reproduction, run from the worktree via `node --input-type=module` (stdin):

```js
import assert from 'node:assert/strict';
import { CalendarSync } from './frontend/calendar/calendar-sync.mjs';
import { Sandbox } from './frontend/optimization/sandbox.mjs';
import { SandboxAdapter } from './frontend/optimization/optimize-ui.mjs';
import { Store } from './frontend/platform/store.mjs';
import { Util, Toast } from './frontend/platform/foundation.mjs';
import { Alerts } from './frontend/insights/services.mjs';
globalThis.document = {
  getElementById() { return null; }, querySelectorAll() { return []; },
  body: { classList: { add() {}, remove() {} } },
};
globalThis.NIMBUS = {};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
Toast.show = () => {}; Util.t = key => key; Alerts.scheduleRecompute = () => {};
const oldHours = { 1: [8, 16] }, editedHours = { 1: [9, 17] }, calls = [];
Util.fetchTraced = async (url, options) => {
  calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
  return { ok: true, json: async () => ({
    plant_work_hours: oldHours, line_work_hours: { L1: oldHours },
  }) };
};
Store.setMasterData({ plants: [{ plant: 'P1' }], lines: [{ machine: 'L1', plant: 'P1' }] });
Store.setSelectedPlant('P1'); Store.setCalendar('L1', editedHours);
Store.subscribe(event => {
  if (event.type === 'sandbox:exited') SandboxAdapter._onExited(event);
});
CalendarSync.saveLineHours('P1', 'L1', editedHours);
Sandbox.enter();
CalendarSync._applyConfig('P1', { line_work_hours: { L1: oldHours } });
CalendarSync._flushLineHours('P1');
Sandbox.exit(false);
for (let i = 0; i < 30; i++) await Promise.resolve();
console.log(JSON.stringify({ calls, local: Store.calendars.L1.workHours }));
assert.deepEqual(Store.calendars.L1.workHours, editedHours);
```

## Reviewed contracts

- **Orders Clear:** Clears quick search alongside existing chip/native/pasted-ID/machine reset. Selected plant, task edits, and explicit Save remain intact. Shared selected-machine reset predates this patch and is preserved, not introduced by the quick-filter correction.
- **Print scope:** Iterates `getDisplayedRowCount` / `getDisplayedRowAtIndex`; does not query rendered DOM rows or `getRenderedNodes`. The configured grid uses ordinary client rows with no pagination/server row model. Date overlap and split-piece logic, all-loaded default, and CSV scope share the existing preview row set. Actual AG Grid browser integration is still untested; the focused scope test stubs this API.
- **Context menu:** Keyboard entry targets the focused grid row or Gantt selection; hidden Firm/Unfirm actions are excluded; navigation wraps; Escape restores focus. The global Gantt handler skips handled/menu events. Existing firm/override/inspect action implementations and scheduling guards remain unchanged. Viewport bounds are source/unit evidence only.
- **Distribution:** Expansion changes a class, button label, and accessibility state without rebuilding the editor or altering weights/preview identities. Existing async response and write guards retain their tests. CSS gives the table an explicit scroll owner, but sticky layout, theme appearance and zoom behavior require browser evidence.
- **Calendar:** Enqueue-time guards and cloning prevent speculative delayed writes; pending blackout-delete tombstones survive speculative upserts; live batches survive timer expiration inside What-If; promotion clears old timers; unrelated plant batches remain independent. R-PLN-001 is the uncovered adapter/hydration interaction.
- **Scheduling invariants:** No engine, scheduling-patch, due/source-date, protected-order, or distribution mutation algorithm changed. Existing Orders and Gantt suites continue to cover finish anchoring, running protection, left-edge refusal, distributed machine constraints and explicit-save behavior.

## Fresh verification

Compiled `.mjs` files were newer than the corresponding reviewed `.mts` files. Each test ran in its own process using `node --test --test-isolation=none tests/modules/<file>.test.mjs`; every process exited 0, with no skipped/TODO tests. Existing fixtures deliberately emit failed-network logs.

| Suite | Passed |
| --- | ---: |
| calendar/calendar-sync-boundaries | 34 |
| calendar/calendar-sync | 11 |
| calendar/edit-calendar | 2 |
| scheduling/planning-audit | 6 |
| scheduling/orders | 67 |
| scheduling/gantt | 81 |
| distribution/distribution-write-conflicts | 48 |
| optimization/sandbox | 7 |
| **Total** | **256** |

The separate inline R-PLN-001 assertion failed as documented. Full lint/typecheck/build/static-assets and repository-wide Node gates are root-owned. No browser was available, so this review does not assert light/dark, zoom, geometry, assistive-technology, rendered stress, or print-layout passes.

## R-PLN-001 correction review — closed

**Final production-code disposition: accepted; R-PLN-001 is closed.** This supersedes the initial changes-requested disposition above, which is retained as the review history and reproduction evidence.

Independently inspected the correction in CalendarSync and reran the original inline reproduction verbatim from this report. It now exits 0: the preserved POST carries 09:00–17:00 and the final local calendar is also 09:00–17:00. The deferred GET still runs, preserving unrelated hydration rather than dropping the entire response.

Each GET captures its hours revision and already-pending keys. Hydration protects a key pending when the read began, still pending when it settles, or edited after its captured revision. Successful POST acknowledgment modifies only the captured edit record; replacing the per-key record for a newer edit prevents an older acknowledgment from clearing that newer pending state. Failed writes retain the existing current-state Retry path. A fresh GET after acknowledgment can install new server values normally. Plant keys and line keys are independently scoped.

The revision map retains one small record per distinct edited plant/line plus plant-wide entry, rather than growing once per edit. Acknowledged records intentionally remain to identify reads that began before that edit; old captured records are released with their write promises. The map is page-lifetime state; the actual sign-out path reloads the page. No new lifecycle blocker was established for the reviewed workflow.

Fresh one-file-per-process verification against compiled output newer than the source:

| Suite | Passed | Failed / skipped / TODO |
| --- | ---: | --- |
| calendar/calendar-hydration-races | 10 | 0 / 0 / 0 |
| calendar/calendar-sync-boundaries | 34 | 0 / 0 / 0 |
| calendar/calendar-sync | 11 | 0 / 0 / 0 |

**Nonblocking test-quality note, now resolved:** the reviewed suite's `afterEach` checked `ErrorLog.error`, but Store subscriber exceptions use `console.error('[Store] listener error:', error)`. The coordinator added a spy on that actual channel and an assertion against matching subscriber errors, then reran all ten integration tests successfully. The final full module suite also passes with that assertion enabled.

Browser evidence remains pending as previously stated.
