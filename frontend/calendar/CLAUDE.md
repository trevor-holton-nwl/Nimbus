# Calendar — capacity engine, durable persistence, and calendar/blackout admin UI

## What lives here

- **`calendar-engine.mts`** (668 lines) — the capacity engine.
  - `candidateDefaultWorkHours()` — fallback work-hours generator, used by `setup-scheduler.mts`'s `freeIntervalsFor`.
  - `Calendar` — `_beginRun`/`_endRun`/`_indexBlocks` (per-run cache lifecycle), `workWindow`, `dailyCapacityHours`, `_indexCapacityBlocks`, `effectiveFromCapacity`, `effectiveCapacityHours`, `nextAvailable`, `fitsContinuous`, `nextOperatingInstant`, `hasNominalWindow`, `findContiguousSlot`, `allocateRuntime`, `placeWithSetup`, `_overlapsBlock`, plus private interval-math helpers (`_freeIntervals`, `_blockingIntervals`, `_ceilMinute`/`_floorMinute`, `_nextContiguousMinuteSlot`).
- **`calendar-sync.mts`** (536 lines) — `CalendarSync`, the durable-persistence client for `/plant-calendar*`: `fetchPlantConfig`, `_applyConfig`, `_migrateMissingSlices`, `savePlantHours`, `saveLineHours`/`_flushLineHours` (600ms debounce), `saveLineBlackoutUpsert`/`Delete`, `savePlantBlackoutUpsert`/`Delete`, `flushPlant` (What-If → live promote), `_post` (single write choke point), the pending-delete ledger (`_trackPendingDeletes`/`_replayPendingDeletes`/`_withoutPendingDeletes`/`_trackedDelete`), failure handling (`_notifyUnsynced`/`_freshBody`), plus legacy-migration helpers (`_isDefaultWorkHours`, `_discardLegacyGlobalLineBlocks`/`PlantBlocks`, `_isLegacyFanoutCopy`).
- **`edit-calendar.mts`** (240 lines) — `EditCalendar` (`{ open, openPlant, close, save, onToggle, applyPreset, copyFromPlant }`), the per-line/plant working-hours modal with 14 Flatpickr pickers (verified: `_fp` array sized 14, `_initPickers()` loops 7 days × 2 fields, guarded by `if (_fp.length === 14) return`).
- **`calendar-admin.mts`** (242 lines) — `CalendarUI` (`render`, `_renderBlocks`, `removeBlock`, `openBlockModal`, `saveBlockFromModal`, `_getLines`, `_clearLineFilter`), the blackout-block admin tab. Overlaps in *purpose* with `EditCalendar` (both write `Store.calendars[line].workHours`), but this is a deliberate post-split naming split — `Calendar` (this file's namesake in `calendar-engine.mts`) is capacity math, `CalendarUI` is the blackout-tab remnant UI — not accidental duplication.

## Counterpart

`backend/calendars/routes.py` (101 lines) — 5 endpoints: `GET /plant-calendar`, `POST /plant-calendar/plant-hours`, `POST /plant-calendar/line-hours`, `POST /plant-calendar/line-blackouts`, `POST /plant-calendar/plant-blackouts` (the last 4 gated by `require_admin`). `backend/calendars/CLAUDE.md` is a 3-line pointer back to this file — don't duplicate its content there.

This domain's data functions do **not** live in `db.py`/`master_data.py` — calendar/blackout persistence is its own table set behind `backend/calendars/routes.py`, not part of the deferred `db.py`/`master_data.py` split.

## Key invariants & hazards

- **Capacity-math mirror rule.** `Calendar._dayWindow`, `Calendar._indexCapacityBlocks`, `Calendar.dailyCapacityHours`, and `Calendar.effectiveFromCapacity` all **delegate directly** to their `globalThis.NimbusComputeCore` counterparts rather than duplicating the math — `workWindow`/`effectiveCapacityHours` route through those delegates in turn. This was completed in the 2026-09 capacity-math-triplication cleanup: `dailyCapacityHours` (and the `_indexCapacityBlocks` bucketing it consumes) previously called `Util.mergedOverlapHours` (`platform/foundation.mts`) independently of Core's own copy — a real, live duplicate this file's own Gotchas section previously (incorrectly) claimed didn't exist. `tests/js/compute-core.test.js` pins **Core's own math** (not a Calendar-vs-Core diff), so parity is achieved by delegation, not by an independent pinned comparison. If any *other* `Calendar` method starts duplicating Core math again, it becomes an un-pinned drift risk — watch for that specifically.
- `Calendar.dailyCapacityHours`'s delegate deliberately reads `Store.blocks`/`Store.plantBlocks`/`Store.lineSettings`/`Store.masterData` directly, not the `sourceBlocks()`/`sourcePlantBlocks()`/`sourceGetPlantForLine()` candidate-snapshot-aware accessors most other functions in this file use (see "Two separate import cycles" below) — this preserves its pre-existing behavior exactly. Whether it *should* read through those accessors instead (so it stays correct during a Sandbox what-if/candidate-snapshot session) is a separate, un-investigated question the 2026-09 dedup pass deliberately did not decide.
- **Blackout snap-to-next-valid-slot.** `Calendar.nextAvailable` (line ~261) is the snap primitive. It returns `null` — never a start — when the line has no working window, the order is longer than the longest single window (it never splits), or nothing fits within 90 days; callers must handle null. A blackout end is rounded up to the next minute so the start is clear of it. The overlong-order diagnostic is deduped per (line, duration) via a bounded module-level set, because the optimizer re-probes the same pair thousands of times. It is not called directly from Gantt drag handling — drag goes through `Interaction` → `Engine` (a drop is finish-anchored: `Engine.manualSchedulePatchFor` → `Engine.finishAnchoredPatchFor` → `Calendar.allocateRuntimeBackward`), and `optimization/engine.mts` / `insights/services.mts` call `Calendar.nextAvailable` for forward placement. `scheduling/persistence.mts` no longer calls the calendar at all: its load-time `_snapToWorkingHours` re-snap and the `setCalendarService` seam were removed in backward scheduling Task 2.5.
- **`line: null` means per-plant, not global.** Confirmed verbatim in `calendar-admin.mts` (line ~211): "Stamp the block's plant so it persists/scopes per-plant (line:null = all lines in this plant)" — mirrored in `calendar-engine.mts`'s blackout-indexing comment (line ~135).
- **`edit-calendar.mts` still reads a bare global `NIMBUS`** (`/* global NIMBUS */`, used for `NIMBUS!.Plant!._persistPlantHours!` and `NIMBUS!.ProdLines!.render!()`) — a classic-script-era coupling that survived the module split. A lingering global-namespace dependency worth knowing about before assuming this file is fully decoupled from `window.NIMBUS`.
- **Two separate import cycles touch this domain — don't conflate them:**
  1. The 4-file strongly-connected component `optimization/engine.mts → optimization/setup-scheduler.mts → calendar/calendar-engine.mts → optimization/engine.mts`, combined with a direct `engine.mts ↔ insights/services.mts` cycle (all four: `engine.mts`, `setup-scheduler.mts`, `calendar-engine.mts`, `insights/services.mts`). Confirmed in `calendar-engine.mts`'s own header (lines 1-28): it imports `Engine`, `placeWithSetupPure`, `sourceBlocks`, `sourcePlantBlocks`, `sourceGetPlantForLine`, `sourceLineWorkHours`, `sourcePlantWorkHours`, `reportSchedulerDiagnostic` from `optimization/engine.mjs`. All cross-references resolve inside method bodies, never at module-evaluation time (verified safe under every load order), but this means "setup-scheduler is a detached module" is true only at the *runtime-coupling* level (no Store/DOM access), not the *import-graph* level.
  2. A separate two-way cycle between `calendar-sync.mts` and `scheduling/persistence.mts` (documented in `calendar-sync.mts`'s own header, lines 9-20).
- **Failed blackout deletes are durable per plant.** Unconfirmed deletes are recorded in localStorage (`nimbus.calendar.pendingDeletes`) and replayed *before* the backend config is applied on the next `fetchPlantConfig`; still-pending ids are filtered out of the fetched config so the blackout stays deleted locally. Replay treats 404 as done and drops permanent 403/409 with a one-time toast. Re-upserting a blackout clears its pending-delete id. Failed non-delete saves toast honestly with a Retry action that rebuilds the body from current Store state (`_freshBody`) — hours/upserts are not auto-replayed.
- **Hydration state (backward scheduling Task 2.6).** `CalendarSync.calendarState(plant)` is `'pending'` (not fetched / in flight), `'hydrated'` (`_applyConfig` ran: the SERVER's rows are in Store) or `'failed'` (the GET failed and no earlier server copy exists); `hasServerLineCalendar(plant, line)` is true only for lines the server returned an hours row for (the client default is never a server row). The reconcile derives starts only from a hydrated plant. The state is set before the `calendar:change` emit so the synchronous subscriber sees it.
- **Store events emitted:** `calendar:change`, `blocks:change`, `plantBlocks:change`, (the post-hydration `tasks:bulkUpdate` re-snap in `CalendarSync._applyConfig` was removed in backward scheduling Task 2.5).

## Integration points

- **Imports in:**
  - `calendar-engine.mts` → `platform/foundation.mjs` (Config, Util), `platform/store.mjs` (Store), `optimization/engine.mjs` (Engine and setup-placement internals, per the cycle above), `platform/types.mjs` (WorkHours, SplitOrderPolicy).
  - `calendar-sync.mts` → `platform/foundation.mjs` (Config, Util, ErrorLog, Toast), `platform/store.mjs`, `optimization/sandbox.mjs` (Sandbox), `scheduling/persistence.mjs` (Persistence), `platform/types.mjs`.
  - `edit-calendar.mts` → `platform/foundation.mjs` (Util, Toast), `platform/store.mjs`, `./calendar-sync.mjs`, `platform/types.mjs`, plus the bare global `NIMBUS`.
  - `calendar-admin.mts` → `platform/foundation.mjs` (Config, Util, ErrorLog, Toast, Modal), `platform/store.mjs`, `./calendar-sync.mjs`, `shell/tab-resolvers.mjs`, `platform/types.mjs`.
- **Imports out (who depends on this domain):**
  - `calendar-engine.mts` (`Calendar`, `candidateDefaultWorkHours`): `insights/insights-ui.mts`, `insights/services.mts`, `labor/labor-planning.mts`, `optimization/engine.mts`, `optimization/scheduler-contract.mts`, `optimization/setup-scheduler.mts`, `scheduling/gantt.mts`, `scheduling/persistence.mts`, plus `app-entry.mjs`.
  - `calendar-sync.mts`: `master-data/admin-ui.mts`, `optimization/engine.mts`, `optimization/optimize-ui.mts`, `scheduling/persistence.mts`, `security/session.mts`, plus `app-entry.mjs`.
  - `edit-calendar.mts`: only `app-entry.mjs` (opened via UI/global wiring, no other domain module imports it).
  - `calendar-admin.mts`: `master-data/admin-ui.mts`, plus `app-entry.mjs`.

## Tests

- `tests/js/compute-core.test.js` — tests `Core._dayWindow`/`Core.effectiveFromCapacity` directly (the math `Calendar` delegates to); doesn't import `frontend/calendar/` by name.
- `tests/modules/calendar/calendar-engine.test.mjs`, `calendar-sync.test.mjs`, `edit-calendar.test.mjs`, `calendar-admin.test.mjs`
- Cross-domain tests also exercising `calendar-engine`: `tests/modules/insights/services.test.mjs`, `tests/modules/optimization/engine.test.mjs`, `tests/modules/remove-backlog.test.mjs`, `tests/modules/split-order.test.mjs`, `tests/modules/helpers/load-legacy-app.mjs`.
- Cross-domain tests also exercising `calendar-sync`: `tests/modules/master-data/admin-ui.test.mjs`, `tests/modules/scheduling/persistence.test.mjs`, `tests/modules/security/session.test.mjs`.

Run: `node --test tests/modules/calendar/*.test.mjs`

## Gotchas

- The "parity-pinned" framing for the capacity-math mirror rule is slightly imprecise: the pin is on Core's own math, and `Calendar` achieves parity by delegating to Core rather than being independently diffed against it. As of the 2026-09 dedup pass, no `Calendar` method duplicates the math anymore (this really is now true, not just asserted) — but worth restating precisely rather than as a flat "parity-pinned" claim.
- `edit-calendar.mts`'s bare-global `NIMBUS` dependency is a real, surviving classic-script coupling — not fully module-isolated.
- Two distinct import cycles touch this domain (see Key invariants above) — they're independent of each other; don't describe them as one loop.

**Cross-link:** `frontend/platform/CLAUDE.md` carries a one-line pointer to the capacity-math mirror rule; the substance lives here.
