# Calendar — capacity engine, durable persistence, and calendar/blackout admin UI

## What lives here

- **`calendar-engine.mts`** (686 lines) — the capacity engine.
  - `candidateDefaultWorkHours()` — fallback work-hours generator, used by `setup-scheduler.mts`'s `freeIntervalsFor`.
  - `Calendar` — `_beginRun`/`_endRun`/`_indexBlocks` (per-run cache lifecycle), `workWindow`, `dailyCapacityHours`, `_indexCapacityBlocks`, `effectiveFromCapacity`, `effectiveCapacityHours`, `isAvailable`, `nextAvailable`, `fitsContinuous`, `nextOperatingInstant`, `hasNominalWindow`, `findContiguousSlot`, `allocateRuntime`, `placeWithSetup`, `_overlapsBlock`, plus private interval-math helpers (`_freeIntervals`, `_blockingIntervals`, `_ceilMinute`/`_floorMinute`, `_nextContiguousMinuteSlot`).
- **`calendar-sync.mts`** (398 lines) — `CalendarSync`, the durable-persistence client for `/plant-calendar*`: `fetchPlantConfig`, `_applyConfig`, `_migrateMissingSlices`, `savePlantHours`, `saveLineHours`/`_flushLineHours` (600ms debounce), `saveLineBlackoutUpsert`/`Delete`, `savePlantBlackoutUpsert`/`Delete`, `flushPlant` (What-If → live promote), `_post` (single write choke point), plus legacy-migration helpers (`_isDefaultWorkHours`, `_discardLegacyGlobalLineBlocks`/`PlantBlocks`, `_isLegacyFanoutCopy`).
- **`edit-calendar.mts`** (240 lines) — `EditCalendar` (`{ open, openPlant, close, save, onToggle, applyPreset, copyFromPlant }`), the per-line/plant working-hours modal with 14 Flatpickr pickers (verified: `_fp` array sized 14, `_initPickers()` loops 7 days × 2 fields, guarded by `if (_fp.length === 14) return`).
- **`calendar-admin.mts`** (208 lines) — `CalendarUI` (`render`, `_renderBlocks`, `removeBlock`, `openBlockModal`, `saveBlockFromModal`, `_getLines`, `_clearLineFilter`), the blackout-block admin tab. Overlaps in *purpose* with `EditCalendar` (both write `Store.calendars[line].workHours`), but this is a deliberate post-split naming split — `Calendar` (this file's namesake in `calendar-engine.mts`) is capacity math, `CalendarUI` is the blackout-tab remnant UI — not accidental duplication.

## Counterpart

`server/calendars/routes.py` (101 lines) — 5 endpoints: `GET /plant-calendar`, `POST /plant-calendar/plant-hours`, `POST /plant-calendar/line-hours`, `POST /plant-calendar/line-blackouts`, `POST /plant-calendar/plant-blackouts` (the last 4 gated by `require_admin`). `server/calendars/CLAUDE.md` is a 3-line pointer back to this file — don't duplicate its content there.

This domain's data functions do **not** live in `db.py`/`master_data.py` — calendar/blackout persistence is its own table set behind `server/calendars/routes.py`, not part of the deferred `db.py`/`master_data.py` split.

## Key invariants & hazards

- **Capacity-math mirror rule, with a nuance.** `web/nimbus-compute-core.js`'s header still says `Calendar.workWindow`/`dailyCapacityHours`/`effectiveCapacityHours` "remain in app.js" and must match Core's copies exactly — post-refactor, that "app.js copy" is now `calendar-engine.mts`'s `Calendar`. In the live code, `Calendar._dayWindow` (line ~158-160) and `Calendar.effectiveFromCapacity` (line ~273-275) **delegate directly** to `globalThis.NimbusComputeCore!._dayWindow`/`.effectiveFromCapacity` rather than duplicating the math — `workWindow`/`dailyCapacityHours`/`effectiveCapacityHours` all route through those delegates. `tests/js/compute-core.test.js` pins **Core's own math** (not a Calendar-vs-Core diff), so parity is achieved by delegation, not by an independent pinned comparison. If any *other* `Calendar` method starts duplicating Core math again, it becomes an un-pinned drift risk — watch for that specifically.
- **Blackout snap-to-next-valid-slot.** `Calendar.nextAvailable` (lines 308-351) is the snap primitive. It is not called directly from Gantt drag handling — drag goes through `Interaction` → `Engine`/`Persistence`, and `scheduling/persistence.mts`'s `_snapToWorkingHours` re-snap path (and `optimization/engine.mts`, `insights/services.mts`) call `Calendar.nextAvailable` from there.
- **`line: null` means per-plant, not global.** Confirmed verbatim in `calendar-admin.mts` (lines ~188-190): "Stamp the block's plant so it persists/scopes per-plant (line:null = all lines in this plant)" — mirrored in `calendar-engine.mts`'s blackout-indexing comment (lines ~132-134).
- **`edit-calendar.mts` still reads a bare global `NIMBUS`** (`/* global NIMBUS */`, used for `NIMBUS!.Plant!._persistPlantHours!` and `NIMBUS!.ProdLines!.render!()`) — a classic-script-era coupling that survived the module split. A lingering global-namespace dependency worth knowing about before assuming this file is fully decoupled from `window.NIMBUS`.
- **Two separate import cycles touch this domain — don't conflate them:**
  1. The 4-file strongly-connected component `optimization/engine.mts → optimization/setup-scheduler.mts → calendar/calendar-engine.mts → optimization/engine.mts`, combined with a direct `engine.mts ↔ insights/services.mts` cycle (all four: `engine.mts`, `setup-scheduler.mts`, `calendar-engine.mts`, `insights/services.mts`). Confirmed in `calendar-engine.mts`'s own header (lines 1-28): it imports `Engine`, `placeWithSetupPure`, `sourceBlocks`, `sourcePlantBlocks`, `sourceGetPlantForLine`, `sourceLineWorkHours`, `sourcePlantWorkHours`, `reportSchedulerDiagnostic` from `optimization/engine.mjs`. All cross-references resolve inside method bodies, never at module-evaluation time (verified safe under every load order), but this means "setup-scheduler is a detached module" is true only at the *runtime-coupling* level (no Store/DOM access), not the *import-graph* level.
  2. A separate two-way cycle between `calendar-sync.mts` and `scheduling/persistence.mts` (documented in `calendar-sync.mts`'s own header, lines 9-20).
- **Store events emitted:** `calendar:change`, `blocks:change`, `plantBlocks:change`, `tasks:bulkUpdate` (the last from the post-hydration re-snap in `CalendarSync._applyConfig`).

## Integration points

- **Imports in:**
  - `calendar-engine.mts` → `platform/foundation.mjs` (Config, Util), `platform/store.mjs` (Store), `optimization/engine.mjs` (Engine and setup-placement internals, per the cycle above), `platform/types.mjs` (WorkHours, SplitOrderPolicy).
  - `calendar-sync.mts` → `platform/foundation.mjs` (Config, Util, ErrorLog, Toast), `platform/store.mjs`, `optimization/sandbox.mjs` (Sandbox), `scheduling/persistence.mjs` (Persistence), `platform/types.mjs`.
  - `edit-calendar.mts` → `platform/foundation.mjs` (Util, Toast), `platform/store.mjs`, `./calendar-sync.mjs`, `platform/types.mjs`, plus the bare global `NIMBUS`.
  - `calendar-admin.mts` → `platform/foundation.mjs` (Config, Util, ErrorLog, Toast, Modal), `platform/store.mjs`, `./calendar-sync.mjs`, `platform/types.mjs`.
- **Imports out (who depends on this domain):**
  - `calendar-engine.mts` (`Calendar`, `candidateDefaultWorkHours`): `insights/insights-ui.mts`, `insights/services.mts`, `labor/labor-planning.mts`, `optimization/engine.mts`, `optimization/scheduler-contract.mts`, `optimization/setup-scheduler.mts`, `scheduling/persistence.mts`, plus `app-entry.mjs`.
  - `calendar-sync.mts`: `master-data/admin-ui.mts`, `optimization/engine.mts`, `optimization/optimize-ui.mts`, `scheduling/persistence.mts`, `security/session.mts`, plus `app-entry.mjs`.
  - `edit-calendar.mts`: only `app-entry.mjs` (opened via UI/global wiring, no other domain module imports it).
  - `calendar-admin.mts`: `master-data/admin-ui.mts`, plus `app-entry.mjs`.

## Tests

- `tests/js/compute-core.test.js` — tests `Core._dayWindow`/`Core.effectiveFromCapacity` directly (the math `Calendar` delegates to); doesn't import `web/calendar/` by name.
- `tests/modules/calendar/calendar-engine.test.mjs` (37 lines)
- `tests/modules/calendar/calendar-sync.test.mjs` (62 lines)
- `tests/modules/calendar/edit-calendar.test.mjs` (14 lines)
- `tests/modules/calendar/calendar-admin.test.mjs` (11 lines)
- Cross-domain tests also exercising `calendar-engine`: `tests/modules/insights/services.test.mjs`, `tests/modules/optimization/engine.test.mjs`, `tests/modules/remove-backlog.test.mjs`, `tests/modules/split-order.test.mjs`, `tests/modules/helpers/load-legacy-app.mjs`.
- Cross-domain tests also exercising `calendar-sync`: `tests/modules/master-data/admin-ui.test.mjs`, `tests/modules/scheduling/persistence.test.mjs`, `tests/modules/security/session.test.mjs`.

Run: `node --test tests/modules/calendar/*.test.mjs`

## Gotchas

- The "parity-pinned" framing for the capacity-math mirror rule is slightly imprecise: the pin is on Core's own math, and `Calendar` achieves parity by delegating to Core rather than being independently diffed against it. Low-risk today (no `Calendar` method left duplicates the math), but worth restating precisely rather than as a flat "parity-pinned" claim.
- `edit-calendar.mts`'s bare-global `NIMBUS` dependency is a real, surviving classic-script coupling — not fully module-isolated.
- Two distinct import cycles touch this domain (see Key invariants above) — they're independent of each other; don't describe them as one loop.

**Cross-link:** `web/platform/CLAUDE.md` carries a one-line pointer to the capacity-math mirror rule; the substance lives here.
