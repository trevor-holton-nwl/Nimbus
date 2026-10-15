# Master Data "↻ Refresh" button — implementation plan

Branch: `feature/master-data-refresh` (forked from `main` at `be40b55`, worktree `.claude/worktrees/plant-hours`). Deliberately independent of `feature/backward-scheduling` so it can merge to `main` on its own.

## Context

Five of the six Master Data sub-tabs skip the backend fetch when their data is already loaded for the current plant (Material / Material Plant / Routing & PV gate on `st.plant !== plant` in `frontend/master-data/material-grids.mts:994`; Work Centers gates on `_loadedPlant` in `frontend/master-data/admin-ui.mts:4960`; Production Lines and Plant render from Store, which `Persistence.load` fills once per plant). A row changed in Postgres by anyone else is invisible until a hard browser reload. Owner decision (2026-10-15): **one `↻ Refresh` button at the right end of the Master Data sub-tab strip** that refreshes whichever sub-tab is showing; **scope is the six Master Data sub-tabs only** (Admin › Manage Data Tables unchanged). No backend change: nothing caches these GETs (`Util.fetchTraced` sets no `cache:`; `backend/master_data/routes.py` sets no `Cache-Control`).

## Global Constraints

- Every new user-visible string goes through `Util.t()` / `data-i18n` and is added to **all five** locale files `frontend/locales/{en,de,es,fr,pt}.js` (`tests/modules/locale-completeness.test.mjs` requires en to be the superset and forbids any locale's missing-key count from growing). Reuse existing keys where they fit: `btn.refresh` (`'↻ Refresh'`), `btn.discard`, `ui.n_unsaved` (`{{count}}`), `toast.no_plant_selected`.
- No inline `onclick="…"` in `index.html` or template-literal HTML, and no new `NIMBUS.X._y` reference in `index.html` — `npm run check:legacy-surface` is an exact ratchet (`tests/contracts/cq1-legacy-surface.json`). Wire with `addEventListener` / `.onclick =` in module code.
- Keep every fetch plant-scoped (`?plant=`); never fetch all plants' machines. `tests/modules/master-data/admin-ui.test.mjs` pins that `admin-ui.mts` has no unscoped `master-data/machine\`` and that `persistence.mts` contains exactly 2 occurrences of `master-data/machine?plant=${encodeURIComponent(plant)}` — do not touch `persistence.mts`.
- Edited `.mts` files require `npm run build` before tests run against the compiled `.mjs` (tests import `.mjs`). Run `npm run typecheck` too.
- Each `refresh()` returns `Promise<boolean>`: `true` = data was reloaded, `false` = the user cancelled (unsaved-edits confirm) or there was nothing to do. Never throw on a cancel.
- Preserve in-progress user state that a refresh does not invalidate: grid filter-bar selections and quick-filter text; Work Centers search text and selected row.
- Follow existing code style (TypeScript strict, 2-space indent, trailing commas as in neighbors). Commit per task with a conventional-commit subject and the Co-Authored-By trailer given in the dispatch.

## Task 1: `MaterialGrids.refresh(id)` for Material / Material Plant / Routing & PV

**Files:** `frontend/master-data/material-grids.mts`, `tests/modules/master-data/material-grids.test.mjs`, `frontend/locales/{en,de,es,fr,pt}.js`.

1. In `material-grids.mts` add a module-level `async function _reload(spec: GridSpec, plant: string): Promise<void>`:
   - Clear `st.dirty`, `st.edited`, `st.baseline`; set `st.plant = null; st.loaded = false`.
   - **Keep** `st.selected` filter sets and `st.search` text (unlike `_resetGridForPlant`, which is for a plant change and clears them).
   - `return _load(spec, plant)` — `_load` (line ~414) already aborts any in-flight request, bumps `generation`, re-indexes rows, rebuilds the filter bars, resets `baseline`, and sets `rowData`.
2. Add to the public `MaterialGrids` object (line ~965): `async refresh(which: GridId): Promise<boolean>`:
   - `const plant = Store.selectedPlant; if (!plant) return false;`
   - If `st.dirty.size > 0`: `const ok = await Modal.confirm({ title: Util.t('ui.n_unsaved', { count: st.dirty.size }), body: Util.t('confirm.md_refresh_discard'), confirmLabel: Util.t('btn.discard') }); if (!ok) return false;` — check `Modal.confirm`'s actual option names in `frontend/platform/foundation.mts` and match them (other callers: `admin-ui.mts:1055`, `:3913`).
   - If `!st.api` call `_createGrid(spec)` first (same as `render`).
   - `await _reload(spec, plant); return true;`
3. Locale key, all five files: `'confirm.md_refresh_discard': 'Reloading from the database discards your unsaved changes. Continue?'` (translate for de/es/fr/pt). First grep the locales for an existing "discard unsaved … continue" key; if one fits exactly, reuse it and skip the new key.
4. Tests in `tests/modules/master-data/material-grids.test.mjs` (reuse its existing `Util.fetchTraced` / `Store.subscribe` / `agGrid` mocks and fixture style):
   - `refresh('material')` after a `render('material')` for the same plant issues a second `_material-grid?plant=` fetch (where a second `render` would not).
   - Filter-bar selections set before `refresh` are still present in `_state` afterwards (expose nothing new for this; assert via the public behaviour — e.g. the mocked filter bar rebuild sees the same selected values — or via the existing test-only access pattern the file already uses).
   - With a dirty Material Plant map and `Modal.confirm` stubbed to resolve `false`: no fetch, resolves `false`, dirty map untouched. Stubbed `true`: fetch happens, resolves `true`, dirty map empty.
   - `refresh` with no selected plant resolves `false` without fetching.
   - Add the public-API shape assert (`typeof MaterialGrids.refresh === 'function'`) next to the existing one at ~line 68.
5. `npm run build && node --test tests/modules/master-data/material-grids.test.mjs tests/modules/locale-completeness.test.mjs`.

## Task 2: Production Lines and Plant refresh (shared Store master-data re-fetch)

**Files:** `frontend/master-data/admin-ui.mts`, `frontend/setup/setup-admin.mts`, `tests/modules/master-data/admin-ui.test.mjs`, `tests/modules/setup/setup-admin.test.mjs`.

1. **Extract** the Store master-data re-fetch block from `MasterData._save` (`admin-ui.mts` ~4499-4543: `Promise.all([GET /master-data/plants, GET /master-data/machine?plant=])` → `Store.setMasterData(...)` with the `Store.selectedPlant` + `Persistence._loadRequest` staleness tokens, the `workcenters` preservation, and the `master-data-changed` emit on the no-op/catch branch) into a module-level `async function refreshStoreMasterData(source: string, table?: string): Promise<void>` that resolves when the Store write (or the fallback emit) has happened. Replace the inline block in `_save` with `void refreshStoreMasterData('master-data-save', table);`. Behaviour of `_save` must not change (same URLs, same timeouts, same emits).
2. `ProdLines.refresh(): Promise<boolean>` next to `ProdLines.render` (~1992):
   - `const plant = Store.selectedPlant; if (!plant) return false;`
   - Flush any debounced line-hours write first so a just-typed edit isn't overwritten: look in `frontend/calendar/calendar-sync.mts` for the flush used by `saveLineHours` (600 ms debounce; `_flushLineHours`) and call it for this plant if it exists and is callable.
   - `await refreshStoreMasterData('master-data-refresh');` then `await CalendarSync.fetchPlantConfig(plant);` (hours + blackouts; it emits `calendar:change`/`blocks:change`, which the App subscriber already re-renders on).
   - `ProdLines.render(); return true;`
3. `Plant.refresh(): Promise<boolean>` next to `Plant.render` (212):
   - Same first three steps as ProdLines (flush, master data, plant config).
   - `await Persistence.loadPriorityRankMaps(plant);` (it always re-fetches — `persistence.mts:1801-1811`).
   - If `Plant._currentPlantTab === 'settings'`: `SetupAdmin.invalidatePlant(plant); await Persistence.loadSetupSnapshot(plant);`.
   - `Plant.render(); return true;` — `render` already dispatches by inner tab (`gotoTab` → general from Store, optimization via `_fetchAndRenderOptimization` which fetches fresh, settings via `_renderSettingsPane` → `SetupAdmin.render`).
4. `SetupAdmin.invalidatePlant(plant: string): void` in `setup-admin.mts` (public, next to `render`): `delete _linesByPlant[plant]; delete _coverageByPlant[plant];` and delete every `_compatibilityByLine` key that starts with `` `${plant}\u0000` ``. These caches are early-return gated at lines ~627/639/633 and otherwise never expire.
5. Tests:
   - `tests/modules/master-data/admin-ui.test.mjs`: public-API asserts `typeof ProdLines.refresh === 'function'`, `typeof Plant.refresh === 'function'` beside the existing ones (~line 16); `ProdLines.refresh()` with a selected plant calls `fetchTraced` for `/master-data/plants`, `/master-data/machine?plant=<p>` and `/plant-calendar?plant=<p>` (use the file's existing fetch-mock pattern); resolves `false` with no plant and issues no fetch. Keep all existing source-text pins green.
   - `tests/modules/setup/setup-admin.test.mjs`: after `invalidatePlant(p)`, the next `render` for `p` re-fetches `/master-data/machine?plant=p` and `/setup/p/coverage` (mock `fetchTraced` and count calls; follow the file's existing mocking style).
6. `npm run build && npm run typecheck && node --test tests/modules/master-data/admin-ui.test.mjs tests/modules/setup/setup-admin.test.mjs`.

## Task 3: `WorkCenters.refresh()`

**Files:** `frontend/master-data/admin-ui.mts`, `tests/modules/master-data/admin-ui.test.mjs`.

1. `WorkCenters.refresh(): Promise<boolean>` next to `render` (~4948):
   - `const plant = Store.selectedPlant; if (!plant) return false;`
   - `WorkCenters._flushPending();` (sends any debounced autosave — the same hazard the plant-switch branch of `render` guards against).
   - Keep `_search` and remember `const keep = WorkCenters._selected;`. Set `_offset = 0`, `_staged = null`, `_baseline = null`, `_dirty = false`, `_loadedPlant = plant`.
   - `await WorkCenters._loadAll(plant, true);`
   - If `keep` is still present in `_rows` (match on the row's code field the way `_selectRow` does), re-select it by calling the existing selection routine so `_staged`/`_baseline` are rebuilt from the fresh row; otherwise `_selected = null`.
   - `WorkCenters._renderPane();` then `WorkCenters._maybeFlush();` as `render` does. Return `true`.
   - Update the `_renderPane` comment (~5039, "reachable only from render()") to name `refresh()` as the second permitted caller.
2. Tests in `tests/modules/master-data/admin-ui.test.mjs`: `typeof WorkCenters.refresh === 'function'`; with `_loadedPlant` already equal to the selected plant, `refresh()` issues a `GET /master-data/sap_workcenter?plant=…` (where `render()` would not — it only calls `_refreshMachines`); `_search` survives; a previously selected code that is still in the fresh rows stays selected, one that vanished becomes `null`. Follow the file's existing fake-DOM / fetch-mock style.
3. `npm run build && node --test tests/modules/master-data/admin-ui.test.mjs`.

## Task 4: Button, shell dispatch, i18n, docs

**Files:** `frontend/index.html`, `frontend/styles.css`, `frontend/shell/application-shell.mts`, `frontend/locales/{en,de,es,fr,pt}.js`, `tests/modules/application-shell.test.mjs`, `backend/master_data/CLAUDE.md`.

1. `index.html` nav `<nav class="admin-subtabs md-master-subtabs">` (~1660-1667): after the six sub-tab buttons append
   ```html
   <div class="spacer"></div>
   <button id="md-master-refresh" class="btn btn-ghost sm md-master-refresh"
           data-i18n="btn.refresh" data-i18n-title="tip.md_refresh">↻ Refresh</button>
   ```
2. `styles.css` next to `.md-master-subtabs` (~4782): `.md-master-refresh { align-self: center; margin: 0 8px 2px 0; }` (`.admin-subtabs` is already `display:flex`; `.spacer { flex: 1 }` exists).
3. `application-shell.mts`:
   - Extend the `_MASTER_SUBS` entry type and each entry (2618-2625) with `refresh(): Promise<boolean>`: `lines → ProdLines.refresh()`, `plant → Plant.refresh()`, `material/material-plant/routing-pv → MaterialGrids.refresh(id)`, `work-centers → WorkCenters.refresh()`.
   - Add `_masterRefreshInFlight: false` and `async refreshMasterSub(): Promise<void>`: find the entry for `App._currentMasterSub` (return if none); if `!Store.selectedPlant` → `Toast.show(Util.t('toast.no_plant_selected'), 'warn')` and return; if in flight return; set the flag, disable `#md-master-refresh` and set `aria-busy="true"`; `try { const reloaded = await entry.refresh(); if (reloaded) Toast.show(Util.t('toast.md_refreshed'), 'success'); } catch (e) { ErrorLog.error('master-data', \`Refresh failed: ${msg}\`); Toast.show(Util.t('toast.md_refresh_failed', { msg }), 'error'); } finally { clear flag, re-enable button, remove aria-busy }`.
   - In `App.init` beside the sub-tab click wiring (~2074): `document.getElementById('md-master-refresh')?.addEventListener('click', () => void App.refreshMasterSub());`
4. Locale keys, all five files: `'tip.md_refresh': 'Reload this tab from the database'`, `'toast.md_refreshed': 'Refreshed from the database'`, `'toast.md_refresh_failed': 'Refresh failed: {{msg}}'` (translated for de/es/fr/pt).
5. Tests in `tests/modules/application-shell.test.mjs` (follow its existing harness): every `App._MASTER_SUBS` entry has a `refresh` function; `refreshMasterSub` calls the active sub's `refresh` (stub the entry) and toasts success only when it resolves `true`; with no selected plant it toasts `toast.no_plant_selected` and calls no `refresh`; a second call while the first is pending is a no-op.
6. Docs: in `backend/master_data/CLAUDE.md` → "Counterpart" paragraph, add one sentence: the Master Data sub-tab strip carries a `↻ Refresh` button (`App.refreshMasterSub`, `application-shell.mts`) that calls the active sub-tab module's `refresh()` (`ProdLines`/`Plant`/`WorkCenters` in `admin-ui.mts`, `MaterialGrids` in `material-grids.mts`) to re-pull from Postgres without a page reload.
7. `npm run build && npm run typecheck && node --test tests/modules/application-shell.test.mjs tests/modules/locale-completeness.test.mjs tests/modules/legacy-surface.test.mjs && npm run check:legacy-surface && npm run check:static-assets && npm run lint`.

## Verification (whole branch)

```bash
npm run build && npm run typecheck && npm run lint
node --test tests/modules/application-shell.test.mjs tests/modules/master-data/admin-ui.test.mjs tests/modules/master-data/material-grids.test.mjs tests/modules/setup/setup-admin.test.mjs tests/modules/locale-completeness.test.mjs tests/modules/legacy-surface.test.mjs
npm run check:legacy-surface && npm run check:static-assets
```

Manual (local Postgres + `uvicorn brain:api --port 8000`): change a `material_plants` PRT in psql → Refresh on Material Plant shows it, filters/quick-filter survive; dirty cell → Refresh prompts, Cancel keeps the edit, Discard reloads; change `machine.bottleneck` → Production Lines Refresh shows it; change plant hours → Plant › General shows them; Work Centers Refresh keeps selected row + search; no plant selected → toast only; double-click fires one fetch set.
