# Platform — foundation layer (config, generic chrome, reactive state)

## What lives here

**`foundation.mts`** (1,491 lines) — CQ-1 foundation module; no schedule state, no feature endpoints, no scheduling rules:
- `Config` — frozen-in-spirit (never mutated at runtime) global constants: `STEP_MS` (15-min snap), `DEFAULT_SHIFT`, `COLORS` (10-line palette), `OVERLOAD_THRESHOLD`/`WARN_THRESHOLD`, `LS_KEY` (`'nimbus.state.v3'`), `SCHEMA_VERSION` (6), `BUILD_ID`, `KNOWN_PLANTS`, `CONCURRENCY_CHECK`, `SESSION_MAX_AGE_MS`, etc.
- `Util` — pure helpers plus four DI-seam setters (`setPreferenceResolver`, `setActorResolver`, `setUtilizationResolver`, `setChangeoverFieldsResolver`) that replace old direct references into modules living elsewhere (Store, Session, Utilization, Engine). Also owns `fetchTraced` (traced fetch wrapper), `parseBackendError`, i18n resolver `t()`, `fpDatetime` (Flatpickr factory), date/time formatting, `toLocalSeconds` (the UTC-corruption-bug fix), `scheduleKpis`/`countChangeovers`/`latenessHours` (optimizer-preview KPI math — calls the injected utilization resolver, so not stateless), paste-to-checkbox helpers (`renderLineChecklist`, `matchPasteToCheckboxes`, `wirePasteToCheckboxes`) shared by every line-picker across the app.
- `VirtualList<T>` — padding-based windowed list renderer (fixed or variable row height via binary search), with scroll-position preservation across re-renders (`_desiredTop`, `saveTop`/`restoreTop`) and a zero-height-container deferral guard.
- `PerfMonitor` — ring-buffer (100 samples) profiler; `record`/`time`/`stats` (p50/p95/max)/`all()`; read by AdminCockpit's Thread tab.
- `ErrorLog` — structured in-memory + IndexedDB-durable log (max 500 entries), four DI-seam setters (`setPlantResolver`, `setRouteResolver`, `setAdminGate`, `setBadgeClickHandler`), breadcrumb ring, error-rate tracking, batched shipping to `POST /logs/frontend`, header badge rendering.
- `Toast` — top-right notification stack, max 3 visible, dedupes by `(msg, type)`, evicts oldest non-error first.
- `Modal` — generic `open`/`close`/`confirm` (promise-based) driven by the `hidden` attribute.

Brief accuracy: matches — Config, Util, VirtualList, PerfMonitor, ErrorLog, Toast, Modal are exactly what's here, nothing misplaced.

**`store.mts`** (857 lines) — reactive schedule state:
- `Store` — single source of truth. Holds `tasks`, `dependencies`, `calendars`, `blocks`, `alerts`, `firmedIds`, `plants`, `plantBlocks`, `lineSettings`, `selectedPlant`, `selectedLines`, `masterData`, `priorityRankMaps`, `setupSnapshot`, `userSettings`, `roleDefaults`, `orderFieldVisibility`, `visibilityHorizonEnd`, `frozenHorizonEnd`. Two DI-seam setters (`setAllowedPlantsResolver`, `setSettingsDefaultsResolver`); `Selection` and `Sandbox` are real cross-file imports forming two-way ESM cycles (see Integration points). Every mutator takes a `source` tag; `emit()` bumps `_rev` and enriches the event with `{revision, mode}` before fanning out to `_listeners`, timing each listener via `PerfMonitor`.
- `UndoStack` — `MAX: 10`; `push`/`pop` (invokes the stored `undoFn`, shows a toast), `snapshotTasks`/`restoreTasks` helpers used by drag-commit/unschedule flows.
- `StoreEvent` — exported interface for a subscriber callback's received event shape (revision + mode added to whatever the mutator emitted).

**`types.mts`** (513 lines) — shared ambient-adjacent (but module-scoped, not `declare global`) domain types: `NimbusTask`, `NimbusBlock`, `NimbusPlantBlock`, `NimbusMasterData`/`NimbusMasterPlant`/`NimbusMasterLine`, `WorkHours`, `NimbusLineSetting`, `PriorityRankMaps` and the priority-list wire types, the full setup-transition contract (`SetupDefinition`, `SetupMatrixRow`, `SetupSnapshot`, `ResolvedSetup`, `ResolveSetupInput`, etc.), every string-literal enum (`OptimizerMode`, `AlertType`, `StoreEventType`, `TopLevelTab`, …), and the wire/localStorage encoding types (`NaiveLocalTs`, `IsoUtcTs`, `LiveState`, `StoredState`). Zero runtime code — compiles to an empty `.mjs`. Deliberate naming collision with `nimbus-compute-core.d.ts`'s ambient `NimbusTask`/`NimbusBlock`/etc. (a minimal worker-payload subset) — always import explicitly from `./types.mjs`, never rely on the bare global (see file header, and `docs/archive/typescript_migration.md` trap T-5).

Brief accuracy: matches — this is genuinely the leaf every other domain imports from.

## Counterpart

No `backend/` counterpart — platform is a pure frontend foundation layer with no backend analog. The nearest backend equivalent of "shared truth everything depends on" is `db.py` (whole, unsplit) plus `brain.py`'s root FastAPI app object, but nothing here calls either directly.

## Key invariants & hazards

- **`Store.selectedLines` is the global cross-screen line filter** (`store.mts:67`, state field; `store.mts:181`, getter) — an aliased `Set` mutated in place by `setSelectedLines()` (`store.mts:561-571`, `current.clear()` + re-add loop). GanttFilter/Table/Dashboard/Labor Plan/Master Data all hold a direct reference to this exact object; **never replace the reference**, only mutate it.
- **`nimbus.state.v3` cache key + `SCHEMA_VERSION` gate**: `Config.LS_KEY = 'nimbus.state.v3'` and `Config.SCHEMA_VERSION = 6` are both defined here (`foundation.mts:136-137`), with an explicit comment: "do NOT bump [LS_KEY] for shape changes — use SCHEMA_VERSION". The actual cache read/write/discard logic lives in `Persistence` (`frontend/scheduling/persistence.mts`), not here — platform only owns the two constants. `types.mts`'s `StoredState` interface (the on-disk shape) documents the same gate.
- **`UndoStack.MAX = 10`** (`store.mts:831`) — confirmed 10-level cap. It wraps destructive Store mutations generically via `push(label, undoFn)`; callers (Interaction, Engine-adjacent drag/optimize flows) are responsible for calling `push` before a destructive op — UndoStack itself doesn't intercept mutations.
- **`Config.KNOWN_PLANTS` is a fallback-only seed** (`foundation.mts:140`, `['5512', '1006']`). `Store.knownPlants()` (`store.mts:678-697`) prefers `masterData.plants` when present and **only falls back to `KNOWN_PLANTS` merged with dynamically-discovered plants** when `masterData` has no plants at all — confirmed via the `if (masterPlants.length) { … } else { …KNOWN_PLANTS… }` branch.
- **Two real ESM import cycles originate in `store.mts`**: `store.mjs ↔ selection.mjs` (`scheduling/selection.mts`) and `store.mjs ↔ sandbox.mjs` (`optimization/sandbox.mts`). Both are safe only because every cross-reference (`Store.mode()` reads `Sandbox.active`; `Store.removeTask()` calls `Selection.remove()`) happens inside a method body invoked long after both modules finish top-level evaluation — never at module-evaluation time. This mirrors the established `scheduling/gantt.mjs ↔ scheduling/orders.mjs` pattern from Phase P3. Don't add a new top-level (module-evaluation-time) reference across either edge.
- **`setLastOptimize`, `setPriorityRankMaps`, `setVisibilityHorizonEnd`, `setFrozenHorizonEnd` deliberately do NOT call `emit()`** — each has an inline comment explaining why (avoiding a spurious `_rev` bump that would invalidate `Utilization`'s memoized matrix and re-trigger `Persistence.autosave`'s unfiltered subscriber on every optimize run / rank load / tasks load, none of which need a second event beyond `tasks:bulk`/`schedule:hydrated`).
- **`Store.pref(key, opts)`** resolves `userSettings[key] ?? roleDefaults[key] ?? settingsDefaultsResolver()[key]` — a 3-tier precedence chain; `opts.plant` is an accepted-but-currently-inert extension point (no per-plant regional defaults column exists yet — don't invent one to "complete" this hook).

## Integration points

- **Imports in**: `foundation.mts` imports only `type { NimbusTask }` from `./types.mjs`. `store.mts` imports `{ Config, Util, PerfMonitor, ErrorLog, Toast }` from `./foundation.mjs`, `{ Selection }` from `../scheduling/selection.mjs`, `{ Sandbox }` from `../optimization/sandbox.mjs`, plus types from `./types.mjs`. `types.mts` has zero runtime imports (one type-only import of `SetupResolutionIndex` from `../setup/setup-domain.mjs`).
- **Imports out (who depends on platform)**: essentially every other domain — `admin-ops`, `calendar`, `insights`, `integration`, `labor`, `master-data`, `optimization`, `priority-lists`, `scheduling`, `security`, `setup`, `shell` all import from `platform/foundation.mjs` and/or `platform/store.mjs` and/or `platform/types.mjs`. This is the foundation layer by design — grep `platform/foundation\|platform/store\|platform/types` across `frontend/` to re-verify the current list if it matters for a specific change.
- **Store events emitted here**: `master-data-changed`, `order-field-visibility:changed`, `setup-snapshot:replace`, `tasks:bulk`, `task:update`, `task:remove`, `tasks:bulkUpdate`, `firmed:change`/`firmed:replace`, `calendar:change`/`calendar:replace`, `blocks:change`/`blocks:replace`, `plantBlocks:change`/`plantBlocks:replace`, `lineSettings:change`, `plant:selected`, `lines:selected`, `alerts:change`, `settings:change`, `plants:replace`, `undo:pushed` (from `UndoStack.push`). Full literal union lives in `types.mts`'s `StoreEventType`.
- **No backend endpoints** are called directly from this domain (no `fetch`/`fetchTraced` call sites in these three files beyond `ErrorLog`'s own log-shipping to `POST /logs/frontend` and `Util.fetchTraced` itself, which is infrastructure other domains use).

## Tests

- `tests/modules/foundation.test.mjs` — Config/Util/VirtualList/PerfMonitor/ErrorLog/Toast/Modal.
- `tests/modules/platform/store.test.mjs` — Store/UndoStack.
- `tests/modules/legacy-surface.test.mjs` + `tests/contracts/cq1-legacy-surface.json` — pins the `app.js` legacy compatibility surface, which re-exposes these modules on `window.NIMBUS`.
- `tests/modules/helpers/load-legacy-app.mjs` — shared test bootstrap that loads platform modules alongside the rest of the legacy bridge.

Run just these: `node --test tests/modules/foundation.test.mjs tests/modules/platform/store.test.mjs`

## Gotchas

- **Capacity-math mirror rule (cross-link):** `Calendar`'s capacity math (`frontend/calendar/calendar-engine.mts`) must stay in parity with `frontend/nimbus-compute-core.js`'s copy, pinned by `tests/js/compute-core.test.js` — see `frontend/calendar/CLAUDE.md` for the substance (delegation vs. independent duplication nuance). Platform itself owns none of that math; this is a pointer only.
- `store.mts`'s header comment is the authoritative explanation for why the two import cycles (with `selection.mjs` and `sandbox.mjs`) are safe — read it before restructuring any top-level reference in either file, not just this doc's summary above.
- `Config.SESSION_MAX_AGE_MS` is a raw literal (`12 * 60 * 60 * 1000`), not `12 * Config.MS_HOUR`, because `Config` can't reference itself mid-object-literal-initializer — a real, commented constraint, not an oversight.
- `Util.changeoverFields()` falls back to a frozen `['COLOR', 'FORM_SIZE']` default when its resolver isn't wired (e.g. Node tests) — this is the exact historical hardcoded pair, kept for behavioral parity, not a stale leftover.
- `ErrorLog`'s IndexedDB durability (`_DB_NAME: 'nimbus-errorlog'`) is a **separate** database from `IntelDB` (owned by `nimbus-intelligence.js`, documented in `frontend/shell/CLAUDE.md`) — don't conflate the two ring stores.
