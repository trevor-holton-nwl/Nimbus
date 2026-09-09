# Shell — boot, login, top-level routing, and the root-pinned classic scripts

## What lives here

- **`application-shell.mts`** (2644 lines) — `export { Settings, SessionUIAdapter, showLoginScreen, EmptyState, PlantSelector, App }`.
  - `Settings` — personalization/workflow defaults catalog; lives here (not one of the 14 tracked CQ-1 modules) because `SessionUIAdapter` is its only real reader.
  - `SessionUIAdapter` — session/login UI glue.
  - `showLoginScreen` — renders the login gate.
  - `EmptyState` — no-plant/no-data placeholder screen.
  - `PlantSelector` — plant picker.
  - `App` — top-level tab switching and screen lifecycle. `App._bootMain`/`_domReadyGate` are deliberately **not** defined here — they stay in `app.js` and are assigned onto this same exported `App` object from `app.js` after this module loads (a documented, intentional asymmetry — see the file's own header, lines 9-20).
- **`tab-resolvers.mts`** (28 lines) — the `ActiveTabResolvers` seam (`setActiveTabResolvers`/`getActiveTabResolvers`, plus the `ActiveTabResolvers` type: `currentTab()`, `currentMasterSub()`, `laborSub()`). Extracted verbatim from the old `plant-and-administration.mts` in Phase P2 so `master-data/admin-ui.mts`'s `Plant` and `labor/labor-planning.mts`'s `LaborPlanning` can each ask "am I currently the visible tab?" without a bare reference to `App`. Defaults are no-op closures returning `null`, so a call before boot wiring never throws.

**Also the custodian of the root-pinned classic scripts that never moved into any domain folder:**
- `frontend/app.js` (762 lines) — boot orchestration, DI-seam wiring, the CQ-1 bridge destructure, and a compatibility `return {...}` namespace. Holds no module bodies.
- `frontend/app-entry.mjs` — the real module loader (see Integration points below for its current import list).
- `frontend/nimbus-intelligence.js` (2410 lines) — the intelligence layer, loaded after `app.js`: `CommandPalette` (Cmd+K), `NeedsEngine`, `TimeMachine`, `Confidence`, `RipplePreview`, `Diff`, `Patterns`, `DarkMode`, `LangSwitcher`, `IntelDB`. Deliberately stays a classic (non-module) script — it needs `NIMBUS` as a bare identifier via shared lexical scope, and now uses `Store` event subscriptions rather than runtime monkey-patches (except the one documented `Alerts.recompute` exception — see `frontend/insights/CLAUDE.md`).
- `frontend/index.html` (3094 lines) — script/style load order, `NIMBUS_BUILD_ID`, the CSP meta tag.
- `frontend/styles.css`, `frontend/locales/` — design tokens and i18n string maps.

## Counterpart

None — this is a frontend-only shell/boot domain.

## Key invariants & hazards

- **`NIMBUS_BUILD_ID` is the single cache-bust source.** Set at `index.html:55` (`window.NIMBUS_BUILD_ID = '2026-08-25-a'`) and read again at `index.html:3072`. It drives every `?v=` query param, `Config.BUILD_ID` (in `platform/foundation.mts`), and `app-entry.mjs`'s `runCacheBustGuard()`. There is no separate `APP_VERSION` constant — bump this on every deploy.
- **`runCacheBustGuard(win)`** (`app-entry.mjs`, lines ~132-145): compares `sessionStorage['nimbus.app.ver']` to `window.NIMBUS_BUILD_ID`; on mismatch, stores the new version and `location.replace(...)`s with a refreshed `_v=` param (stripping any prior one). Wrapped in try/catch so storage/location failures never block boot. It was deliberately moved to the top of `app-entry.mjs` (rather than the top of `app.js`, where it lived pre-refactor) so it fires before the deferred-module load even starts, recovering most of the redirect-timing gap the new load order introduced.
- **Script/module load order matters.** `app-entry.mjs` (a `<script type="module">`) imports the real ES modules, bridges their exports onto `window.__NIMBUS_*` globals, then injects `app.js` and `nimbus-intelligence.js` as classic scripts in that order, then deletes all the bridge globals (`app-entry.mjs` lines ~99-106) since `app.js` only reads them synchronously at its own IIFE top and `nimbus-intelligence.js` never reads them at all. Locale files load before all of this (first in the script chain) because `app.js` reads them when defining `window.t`.
- **Classic-script constraints.** `nimbus-intelligence.js` must stay non-module for the bare-`NIMBUS`-identifier reason above — don't convert it to an ES module without re-solving that coupling.
- **Tab-scoped chrome + drawer sub-navigation (2026-09-09).** `App.goto` writes `document.body.dataset.tab`; CSS keys on it to show the scheduling-only action cluster `#context-sched-actions` (Optimize/What-If/Print) in the context bar. Hour/Day/Week + Fit/Now sit at the right end of `#gantt-filterbar` inside the Timeline pane (so they hide with the pane on the Orders sub-view — no per-id display toggling remains in `gotoGanttSub`). There is no other per-tab show/hide mechanism for shared chrome — reuse the attribute rather than inventing another. The Gantt Timeline/Orders switch lives in the nav drawer as `.nav-sub-btn[data-gantt-sub]` children under the gantt `.tab-btn` (wrapped in `.nav-group`, with a `#nav-gantt-chevron` collapse toggle). Children deliberately carry **no** `.tab-btn`/`data-tab` so the generic tab wiring, `goto`'s active-toggle, and `SessionUIAdapter._applyGates` ignore them; `_applyGates` hides the whole `.nav-group` with the parent. `_setGanttNavExpanded` also toggles `.open` on `#nav-group-gantt`, which is the CSS hook that turns the active parent into a header-style row so only the active child carries the selection marker. Zoom buttons are found via `#gantt-zoom-controls .seg-btn[data-view]` (three sites: `App.init`, `Timeline.setView`, `Timeline.gotoLineDay`). The What-If button must stay `.sandbox-btn` with a flat text node — `SandboxAdapter` rewrites its `textContent`.
- **i18n routing.** Route all new/changed UI text through `data-i18n`/`t()`, even tiny badges, rather than hardcoding to match a pre-existing hardcoded neighbor — `tests/modules/locale-completeness.test.mjs` pins coverage.
- **Flatpickr standard.** All date and time inputs use [Flatpickr](https://flatpickr.js.org/) — never native `<input type="date">`, `datetime-local`, or `time`. Flatpickr loads via CDN in `index.html` (before `styles.css`). The NIMBUS amber theme lives mid-`styles.css` under `/* Flatpickr calendar — NIMBUS amber theme */`, with dark-mode counterparts later in the file. **Exception:** the AG Grid inline `start_date` cell editor (`Table._DateTimeEditor`) is a native `datetime-local`.

  | Type | `enableTime` | `noCalendar` | `dateFormat` | `altInput` | `altFormat` |
  |------|:---:|:---:|---|:---:|---|
  | Date-only | — | — | `"Y-m-d"` | `true` | `"M j, Y"` |
  | Datetime | `true` | — | `"Y-m-d\\TH:i"` | `true` | `"M j, Y · h:i K"` |
  | Time-only (hours table) | `true` | `true` | `"H:i"` | — | — |

  Modal pickers are **module-level, lazily initialized, and conventionally named `_fp*`** — built once behind an `if (!Module._fpX)` guard, then `Module._fpX.setDate(d, false)` (`false` suppresses `onChange`); table time inputs are built inline per row. `grep -n "flatpickr(" frontend/*.mjs` finds every instance. With `altInput: true`, existing `.value` reads keep working: the hidden original input holds the `dateFormat` value, the visible alt input shows `altFormat`.
- **CSP is Report-Only, not yet enforced.** `index.html:17` carries a `Content-Security-Policy-Report-Only` meta tag pending removal of the remaining static inline `onclick=`/`onchange=` handlers — don't assume CSP is actually blocking anything yet.

## Integration points

- **`app-entry.mjs`'s current import list** (this **supersedes** the root `CLAUDE.md`'s pre-refactor description, which still names the old flat module set `application-foundation, schedule-state, schedule-services, schedule-data, schedule-workbench, plant-and-administration, application-shell, master-data-grids` — that sentence is stale and should be corrected when the root doc is next touched):
  `platform/foundation.mjs`, `platform/store.mjs`, `scheduling/selection.mjs`, `optimization/sandbox.mjs`, `calendar/calendar-engine.mjs`, `insights/services.mjs`, `optimization/engine.mjs`, `scheduling/persistence.mjs`, `calendar/calendar-sync.mjs`, `security/session.mjs`, `scheduling/gantt.mjs`, `scheduling/orders.mjs`, `optimization/optimize-ui.mjs`, `insights/insights-ui.mjs`, `priority-lists/viewers.mjs`, `calendar/edit-calendar.mjs`, `setup/setup-admin.mjs`, `calendar/calendar-admin.mjs`, `master-data/admin-ui.mjs`, `priority-lists/mapping.mjs`, `labor/labor-planning.mjs`, `admin-ops/admin-ui.mjs`, `integration/sap-interface-ui.mjs`, `security/security-admin.mjs`, `shell/tab-resolvers.mjs`, `shell/application-shell.mjs` (as `* as shell`), `master-data/material-grids.mjs` (as `* as materialGrids`), plus `setup/setup-domain.mjs` (side-effect only, no bridge).
  These bridge onto `window.__NIMBUS_FOUNDATION/STATE/SERVICES/DATA/WORKBENCH/PLANT_ADMIN/SHELL/MATERIAL_GRIDS` — the bridge object literals' key sets are a real compatibility contract (both `app.js`'s destructure and `tests/modules/helpers/load-legacy-app.mjs`'s VM harness depend on the exact keys present).
- **`tab-resolvers` callers:** `master-data/admin-ui.mts` (`.currentTab() === 'masterdata' && .currentMasterSub() === 'plant'`), `labor/labor-planning.mts` (`.laborSub()`, `.currentTab() !== 'labor'`). `setActiveTabResolvers` itself is wired once from `app.js` boot glue after the CQ-1 bridge destructure.
- **Importers of `application-shell`/`tab-resolvers` overall:** `app-entry.mjs`, `master-data/admin-ui.mts`, `labor/labor-planning.mts`, plus test harnesses (`tests/modules/helpers/load-legacy-app.mjs`, `tests/modules/application-shell.test.mjs`). No other domain file imports `application-shell` directly by name — everything else goes through `tab-resolvers` or the `__NIMBUS_SHELL` bridge.

## Tests

- Login artwork: `factory-products.mts` holds the shared original product library;
  `factory-product-styles.mts` selects refinements per product. `factory-scene.mts`
  renders the refined assembly/inspection/packing scene and handles pause, resize,
  reduced motion and cleanup. `factory-scene-model.mts` provides its pure flow/layout.
  `factory-cameo.mts` adds the hidden A-02 greeting at each minute of visible time,
  starting at 60 seconds, using `assets/chris-peterson-cameo.png`. It has no manual
  control, loads artwork shortly before the first greeting, and skips reduced motion.
  `FACTORY_SCENE.style = 'classic'` selects the prior scene retained in
  `application-shell.mts`. See `docs/LOGIN-ARTWORK.md` for independent scene/product rollback.
- `tests/modules/factory-{product-styles,scene-model,scene,cameo}.test.mjs` cover artwork
  selection, flow, responsive layout, reduced motion and animation lifecycle.

- `tests/modules/application-shell.test.mjs` — direct test of this domain.
- `tests/modules/helpers/load-legacy-app.mjs` — shared VM harness loading the `app.js`/`app-entry.mjs` bridges (used by many module tests, not shell-specific).
- No dedicated `tab-resolvers` test file exists — it's exercised indirectly via the `admin-ui`/`labor-planning`/`application-shell` tests.

Run: `node --test tests/modules/application-shell.test.mjs`

## Gotchas

- The root `CLAUDE.md`'s description of `app-entry.mjs`'s import list is stale (pre-P2/P3/P4 module names) — use the list above, verified against the live file.
- `App._bootMain`/`_domReadyGate` living in `app.js` rather than `application-shell.mts` is deliberate, not an oversight — don't "fix" it by moving them without re-reading the header comment's rationale.
- `Settings` living in `application-shell.mts` looks like it could belong to a settings/preferences domain, but it's here on purpose (single reader: `SessionUIAdapter`).
