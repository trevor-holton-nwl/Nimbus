# NIMBUS — Audit Recommendations

> Generated from a full-codebase examination (34-agent workflow, 15 code slices, every doc-drift / bug / high-impact perf claim adversarially re-verified against live code). `CLAUDE.md` was updated separately with the verified documentation corrections. This file holds the recommendation deliverables: **critical bugs**, **performance**, **UI**, and **moonshots**. File:line references point at the code as examined.

---

## §1. Critical bugs found (reported, not fixed)

These surfaced during the examination. They are **listed for prioritization only** — no fixes were applied. Severity is the auditor's; *(verified: …)* marks findings an independent adversarial pass re-confirmed against live code.

### High severity

- **CORS: allow_origins=['*'] combined with allow_credentials=True is invalid/insecure**  
  `brain.py:141-148` — The CORS middleware sets allow_origins=['*'] AND allow_credentials=True. Per the CORS spec a wildcard origin cannot be used with credentials; browsers refuse credentialed requests and Starlette will not echo a wildcard when credentials are allowed. Combined with allow_methods=['*']/allow_headers=['*'] this is also wide open to any origin.

- **Destructive and DDL endpoints are unauthenticated and trust client-supplied identity headers**  
  `brain.py:828,860,1059,1074,1094,1126,1224` — POST /upload, POST /purge (mass DELETE), /master-data/{table}/bulk (upsert+delete), /master-data/{table}/columns (ADD/DROP COLUMN — live DDL), and /maintenance/* have no auth check. Actor identity comes entirely from spoofable X-User / x-user-email request headers (defaulted to 'system', read at brain.py:917,973,1024,1068,1088,1100,1114,1138), so audit attribution is unverifiable and any network-reachable client can drop columns or purge orders.

- **Plant LEFT JOIN keyed only on production_line can fan out / mis-attribute rows across plants** *(verified: confirmed)*  
  `db.py:126, schema.sql:107-116` — production_lines PK is (subnetwork, plant, production_line), so the same production_line code may legitimately exist under multiple plants/subnetworks. _ORDERS_SELECT joins `ON pl.production_line = o.production_line` only (no plant qualifier). If a line code is reused across plants, the LEFT JOIN multiplies each order row once per matching plant — inflating /tasks output, duplicating tasks/links, breaking count_orders totals, and assigning an arbitrary PLANT. The ORDER BY/link builder (brain.py:599-644) would then emit duplicate task ids on one line. orders has no plant column to disambiguate, so the join cannot be made safe without schema change. At 50+ plants line-code reuse is highly likely.

- **Unvalidated NUMERIC length is a raw SQL injection vector in add_column** *(verified: confirmed)*  
  `master_data.py:290-291` — `type_sql = sql.SQL("NUMERIC({})").format(sql.SQL(str(length)))` composes the request-supplied length directly into DDL with no escaping or validation (sql.SQL is a trusted-literal wrapper, not an escaper). length comes from body.get('length') (brain.py:1084). A crafted length value can inject arbitrary SQL into the ALTER TABLE that add_column then executes. Directly contradicts the module's own safety docstring.

- **applyFix overload optimizes the whole plant but snapshots one line+day, breaking Undo** *(verified: confirmed)*  
  `app.js:4088-4097` — runAndApply('combined') runs unscoped (4094) over the whole plant/35 days, but undo restores only the line+day subset (4095) so tasks moved on other lines/days are lost; the computed day is unused as scope

- **Inspector renders order fields into innerHTML without escaping (stored XSS / markup injection)**  
  `app.js:6804-6822` — _render interpolates task.id, task.ORDER, task.MATERIAL_NUMBER, task.MATERIAL_DESCRIPTION, task.COLOR, task.FORM_SIZE, and line option values directly into body.innerHTML with no escaping (only the notes textarea at 6828 is escaped). The same fields ARE escaped in Dashboard (_esc at 7596, 7687, 7838) and GanttFilter (esc at 7187, 8246). If any order field (e.g. MATERIAL_DESCRIPTION from the uploaded Excel) contains HTML, it is injected into the DOM, and the onclick handlers built with task.id (6854-6855) break or execute injected markup.

- **Promote does not flag the schedule dirty for backend save; relies on a later unrelated mutation to persist — risk of silent data loss** *(verified: confirmed)*  
  `app.js:9187-9198 (no Persistence/dirty marking) vs autosave guard at 11040` — During sandbox, autosave is suppressed (11040). On promote, exit(true) shows a 'scenario applied' success toast but never triggers a save or marks tasks dirty — it only pushes an undo entry and clears Sandbox.active. The promoted edits sit in memory and are only persisted if some subsequent unrelated Store mutation fires autosave. A user who promotes and immediately reloads/closes can lose the scenario despite the success toast.

- **Partial-save clears all dirty ids, so un-persisted edits are silently dropped from retry tracking** *(verified: confirmed)*  
  `app.js:10816-10847` — On a successful HTTP response saveAll unconditionally runs `Persistence._dirtyIds.clear(); Persistence._forceIds.clear()` (10818-10819) BEFORE checking `persisted < total`. If the backend persisted only some rows, the failed ids are no longer dirty and will never be auto-retried; only a transient toast informs the user. Combined with autosave NOT writing to the backend, those edits can be permanently lost on reload.

- **MasterData._markDirty mutates the live cached row object before save, corrupting the in-memory baseline** *(verified: confirmed)*  
  `app.js:14435-14445 (_markDirty) + app.js:14447-14451 (_getRowByKey)` — _markDirty does `const patch = state.dirty.get(rowKey) || _getRowByKey(table, rowKey) || {}`. On the FIRST edit of a clean row, state.dirty has no entry, so _getRowByKey returns the ACTUAL row object (a live reference into state.rows or state.added via all.find(...) at app.js:14450). The next line `patch[colName] = value` then mutates that live row directly, and state.dirty.set stores the same reference. Consequence: the saved baseline in state.rows is overwritten in place before the user clicks Save — 'Discard' only recovers because it deletes _cache[table] and reloads (app.js:14260). The dirty 'patch' also ends up holding the full row rather than just changed fields.

- **Freeze intent crashes: local `t` shadows the global i18n function** *(verified: confirmed)*  
  `nimbus-intelligence.js:615 + 630` — In NeedsEngine.resolveIntent, `const t = text.trim().toLowerCase();` (line 615) shadows the global i18n helper `window.t` (defined app.js:381). The freeze intent's run() closure at line 630 calls `Toast.show(t('toast.freeze_saved'), ...)`, but `t` here is the lowercased query STRING, so this throws `TypeError: t is not a function`. The 'toast.freeze_saved' key exists in locales/en.js:113, confirming the call was meant to be the i18n function. Running the 'freeze'/'lock'/'fix all' intent from the command palette fixes all orders and takes a snapshot, then throws before the success toast — the error is swallowed by the _activate try/catch (line 1029) so the user sees no confirmation.

- **Pattern-detected toast crashes: local `t` shadows the global i18n function** *(verified: confirmed)*  
  `nimbus-intelligence.js:2028 + 2040` — In Patterns._observe, `const t = Store.tasks[movedId];` (line 2028) shadows global `t`. Line 2040 calls `Toast.show(t('toast.pattern_detected', { key }), 'info', 4500)`, invoking a task OBJECT as a function → `TypeError: t is not a function`. This fires exactly when a color-sequence pair reaches the threshold (Patterns._pairs[key] === 4) — the single moment the feature is meant to surface a suggestion. The throw happens synchronously inside the Store 'task:update' subscriber (registered at line 2021), so it propagates into Store.publish/emit rather than being caught locally.


### Medium severity (verified)

- **Chunked upload commits per 500-row chunk — a mid-upload failure leaves a partially-applied batch and NO upload_audit row** — `db.py:990-1012` *(verified: confirmed)*

- **list_rows ORDER BY uses first-N display columns, not the actual key columns** — `master_data.py:105-109` *(verified: confirmed)*

- **bulk_apply delete path KeyerrorS on a delete dict missing a key column** — `master_data.py:191` *(verified: confirmed)*

- **Store.updateMany mutates task objects in place, violating the documented ref-swap contract used by AG Grid / diff-by-identity** — `app.js:675-684 (updateMany) vs 640-647 (updateTask)` *(verified: confirmed)*

- **_rebuildPlantIndex drops tasks when masterData/lineSettings are not yet hydrated, with no re-index hook** — `app.js:837-845 (_rebuildPlantIndex), 630-631` *(verified: confirmed)*

- **_disaggregate even-split rounds each slot independently, silently losing/gaining hours vs the entered aggregate** — `app.js:2310-2312` *(verified: confirmed)*

- **_onCellChanged can produce a zero-length or inverted order that the backend rejects** — `app.js:6470-6475 (RUN_TIME branch) and 6468-6469 (start_date branch)` *(verified: confirmed)*

- **Alert-summary row onclick references undefined identifier `a` at runtime** — `app.js:7689` *(verified: confirmed)*

- **renderCard injects unescaped task fields into innerHTML (markup-injection / latent XSS)** — `app.js:9494-9527` *(verified: confirmed)*

- **Sandbox.exit(true) promote pushes an undo labeled 'Discard What-If scenario' whose undo restores only tasks+fixedIds, not blocks/calendars** — `app.js:9189-9196` *(verified: confirmed)*

- **_snapToWorkingHours can re-snap genuine user placements that land at midnight with no original baseline** — `app.js:10568-10597` *(verified: confirmed)*

- **_restoreNonTaskState replaces lineSettings/calendars wholesale rather than merging** — `app.js:10682-10709, app.js:10355-10371` *(verified: confirmed)*

- **TimeMachine.restore only restores start/end dates, not line membership** — `nimbus-intelligence.js:1259-1277` *(verified: confirmed)*

- **Worker loaded by bare filename has no cache-bust, so a stale worker can pair with new app.js** — `index.html:47,2405 / app.js:3419` *(verified: confirmed)*


---

## §2. Performance recommendations

### Backend

**Hard-cap unscoped `/tasks` so a missing plant filter can't dump the whole order book**
Impact: High · Effort: S
`get_tasks` (brain.py:557-576) calls `db.query_orders(plant, line, limit, offset)`; when all four are omitted, `query_orders` (db.py:157-178) builds no `WHERE` and no `LIMIT`, returning every order. At 3,500 lines this materializes the full table into a DataFrame, runs the per-row build loop, and freezes the client. The `query_orders` docstring (db.py:147-149) already declares "plant is the scaling unit … so we never materialize the whole order book," but nothing enforces it.
Fix: In `get_tasks`, require `plant` (or `line`) for the non-tooling path — return `400`/empty `meta` when no scope is given — or fall back to a hard default `LIMIT` (e.g. 5000) so an unscoped request can never build the full frame. Keep the explicit `?limit=`/`?offset=` tooling escape hatch.

**Add an index on `production_lines(production_line)` — the join key every `/tasks` and `count_orders` uses**
Impact: High · Effort: S
`_ORDERS_SELECT` joins `LEFT JOIN production_lines pl ON pl.production_line = o.production_line` (db.py:126), and `count_orders` repeats it (db.py:183). The PK is `(subnetwork, plant, production_line)` and the secondary indexes are `idx_lines_plant (subnetwork,plant)` / `idx_lines_plant_only (plant)` (schema.sql:117-120) — none is keyed on `production_line` alone, so resolving the plant per line scans `production_lines` on every request. At 3,500+ lines this degrades with line count.
Fix: `CREATE INDEX idx_lines_production_line ON production_lines(production_line);`. This is the lowest-effort, highest-leverage DB change in the audit — it accelerates both the hot read and the paged count.

**Fix the `production_line`-only join fan-out before plants share line codes**
Impact: High · Effort: M
The same join (db.py:126) keys *only* on `production_line`, but `production_lines` PK is `(subnetwork, plant, production_line)` (schema.sql:113) and `orders` has no plant column (schema.sql:20-40). When a line code is reused across plants — realistic at 50+ plants — the `LEFT JOIN` multiplies each order row once per matching plant, duplicating task IDs, inflating `count_orders` totals, and assigning an arbitrary `PLANT`. The link builder (brain.py:599-644) would then emit duplicate IDs on one line. Dormant today (seed data has distinct lines), latent at scale.
Fix: Add a `plant` (and ideally `subnetwork`) column to `orders`, populate it at ingest, and qualify the join `ON pl.production_line = o.production_line AND pl.plant = o.plant`. This is a schema migration, so plan it ahead of multi-plant onboarding rather than reactively.

**Replace the per-request second `COUNT(*)` with a window-function count**
Impact: Med · Effort: S
On any paged request, `get_tasks` calls `db.count_orders()` (brain.py:584 empty path, :656 normal path) in addition to `query_orders`, doubling round-trips and re-running the same unindexed `production_lines` join just to populate `meta.total` (db.py:181-196).
Fix: Add `COUNT(*) OVER() AS total` to the data query when paging so the total returns with the page in one scan; or compute the count only on `offset==0` and cache it client-side. Eliminates an entire second join pass per paged call.

**Stop `/diagnostics/deep` from full-scanning `orders` + re-reading the color-wheel Excel on every click**
Impact: High · Effort: M
The handler calls `db.load_orders_df()` (brain.py:484), which runs `_ORDERS_SELECT` with no `WHERE`/`LIMIT` (db.py:130-139) — the entire order book into a DataFrame — then `pd.read_excel(COLOR_FILE)` (brain.py:485-486) re-parses the global wheel from disk each call. At target scale this is a full-table load + Excel parse on every admin panel render.
Fix: Replace the DataFrame load with `SELECT DISTINCT color FROM orders` (push the distinct into SQL), and read wheel colors from the already-cached `GLOBAL_CW` dict instead of re-reading `COLOR_FILE`. Reserve `load_orders_df()` for explicit, row-capped export only — never a per-request path.

**Refresh only the changed plant's color wheel on upload/delete instead of rescanning the whole directory**
Impact: Med · Effort: M
`load_color_wheels()` iterates `os.listdir(COLOR_WHEEL_DIR)` and `pd.read_excel()`s every per-plant file (brain.py:317-353). It runs at startup (brain.py:117), on `/reload`, and inline after *every* upload (brain.py:938) and delete (brain.py:981) — including on the event-loop thread in the sync delete handler. At 50+ plants that's 50+ blocking Excel parses on each single-wheel change.
Fix: On upload/delete, re-read only the one affected plant's file and patch `PLANT_CWS[plant_safe]` rather than rebuilding the whole cache. Longer term, move wheels into Postgres (per the per-plant storage roadmap) to eliminate the directory scan entirely.

**Scope `apply_color_merge` to the requested plant instead of looping all cached wheels**
Impact: Low · Effort: S
For each key in `PLANT_CWS`, `apply_color_merge` builds a boolean mask over the whole frame and runs `.map(cw_map)` (brain.py:384-391). A single-plant `/tasks` scope matches one key, but the loop still iterates all 50+ cached plant wheels, building masks against the scoped frame each request.
Fix: When the request is plant-scoped, look up `PLANT_CWS[plant_safe]` directly and skip the loop over other plants' wheels.

**Vectorize the `/tasks` payload build — drop `iterrows()` + per-field `strftime`**
Impact: Low · Effort: M
`get_tasks` groups by `PRODUCTION_LINE` and iterates `group.iterrows()` (brain.py:599-644), building a dict per row with `strftime` per date field. `iterrows()` is pandas' slowest access pattern and dominates per-request CPU on a large plant pull.
Fix: Vectorize date formatting (`df['BASIC_START_DATE'].dt.strftime(...)`), use `to_dict('records')` or `itertuples`, and build the finish-to-start links from the already-sorted line column via `shift()`.

**Add server-side pagination/filtering to `/master-data/{table}` and `/color-wheels`**
Impact: Med · Effort: M
`list_rows(table)` issues an unbounded `SELECT {cols} FROM {tbl} ORDER BY …` with no `LIMIT`/`OFFSET`/`WHERE` (master_data.py:104-110), and the handler passes nothing through (brain.py:1043-1048) — so `GET /master-data/production_lines` returns all 3,500+ rows every call. `/color-wheels` (brain.py:985-997) lists every plant wheel via `os.listdir` with no paging. Both violate the roadmap's server-level pagination rule (CLAUDE.md:23).
Fix: Add optional `plant`/`subnetwork` filter plus `limit`/`offset` to `list_rows` and the GET handler, mirroring the `/tasks ?plant=/?limit=/?offset=` pattern, and return `meta.total`. The frontend `_save` refetch (below) depends on this to stop pulling whole catalogs.

**Close the unvalidated `NUMERIC` length SQL-injection sink in `add_column`**
Impact: High (security) · Effort: S
`type_sql = sql.SQL("NUMERIC({})").format(sql.SQL(str(length)))` (master_data.py:290-291) composes the request-supplied `length` (from `body.get("length")`, brain.py:1084) verbatim into DDL — `sql.SQL()` is a trusted-literal wrapper, not an escaper. `length` is never run through `COLUMN_NAME_RE` or any numeric check, so a payload like `length="10); DROP TABLE plants;--"` is injected into the `ALTER TABLE`. This is the one genuine injection hole in the otherwise `sql.Identifier`-safe master-data layer.
Fix: Validate before composing — `re.match(r'^\d{1,3}(,\d{1,3})?$', str(length))` and raise `ValueError` otherwise — or parse to ints and rebuild with `sql.SQL("NUMERIC({},{})").format(sql.Literal(p), sql.Literal(s))`.

**Add an auth/identity layer to destructive + DDL endpoints; stop trusting `X-User`/`x-user-email` headers**
Impact: High (security) · Effort: M
`POST /upload`, `POST /purge` (mass DELETE), `/master-data/{table}/bulk`, `/master-data/{table}/columns` (live `ADD`/`DROP COLUMN` DDL), and `/maintenance/*` have no auth dependency (brain.py:828,860,1059,1074,1094,1126,1224). Actor identity comes only from spoofable `X-User`/`x-user-email` headers defaulted to `'system'` (brain.py:917,973,1024,1068,1088,1100,1114,1138), and the frontend even hardcodes one developer's email (app.js:2227,2242,13927,etc.). Any network-reachable client can purge orders, drop columns, or run VACUUM, and audit attribution is unverifiable.
Fix: Add a FastAPI `Depends` auth guard (session/JWT) on every mutating + DDL + maintenance route, derive the actor from the verified session rather than the header, and gate `/maintenance/*` (which opens unpooled `psycopg.connect` connections, db.py:825,837) to admins so they can't exhaust `max_connections`.

**Fix the CORS wildcard-plus-credentials misconfiguration**
Impact: Med (security) · Effort: S
`CORSMiddleware` sets `allow_origins=["*"]` with `allow_credentials=True` plus `allow_methods=["*"]`/`allow_headers=["*"]` (brain.py:141-148). Per the CORS spec a wildcard origin cannot be combined with credentials — browsers refuse credentialed requests and Starlette won't echo a wildcard, while leaving the API open to any origin.
Fix: Replace `["*"]` with an explicit allowlist of the deployed frontend origins, and only keep `allow_credentials=True` if you actually send cookies/auth.

**Persist the `chk_orders_sched_range` constraint and make the `/update` write path materialize `scheduled_end`**
Impact: Med · Effort: M
Two related correctness gaps in the write path: (1) `update_task_dates_bulk` validates `new_end` against effective dates but the `UPDATE` writes only the literally-supplied `start`/`end` and COALESCEs against `scheduled_*` (not `basic_*`) — so a first-time single-field start edit on a never-scheduled order leaves `scheduled_end` NULL, silently reverting the effective end to `basic_finish_date` instead of the validated `new_end` (db.py:336-345,356-360). (2) `chk_orders_sched_range` is added `NOT VALID` and never followed by `VALIDATE CONSTRAINT` (schema.sql:57-60), so legacy inverted rows are never checked.
Fix: Persist `new_start`/`new_end` (the validated effective values) in the VALUES tuple rather than the raw supplied fields, and add a one-shot `ALTER TABLE orders VALIDATE CONSTRAINT chk_orders_sched_range;` (after cleaning any existing inverted rows).

**Make chunked upload write an audit row even on partial failure; harden destructive-date parsing**
Impact: Med · Effort: M
Two ingest/purge robustness issues: (1) `ingest_orders_from_excel` commits per 500-row chunk (db.py:1003) but the `upload_audit` INSERT runs only after the loop (db.py:1004-1012) — a mid-upload failure leaves chunks 0..N-1 committed with no audit row, so Admin Cockpit history shows nothing despite the docstring's "consistent partial state" claim. (2) `purge_orders` strips only a trailing `Z` (brain.py:869-870), so an offset-suffixed timestamp (`+00:00`) parses tz-aware and compares against `TIMESTAMP WITHOUT TIME ZONE` columns, risking off-by-timezone deletes on a DELETE.
Fix: Wrap the whole upload in one transaction (or write a "partial/failed" audit row in the `except` before re-raising), and parse purge dates with full ISO-8601 handling (`datetime.fromisoformat` after normalizing offsets, then convert to naive UTC) instead of `.replace("Z","")`.

---

### Frontend

**Build a `line → plant` Map so `getPlantForLine` is O(1) — it's called per-task on every render**
Impact: High · Effort: S
`Store.getPlantForLine` falls back to `masterData.lines.find(r => r.production_line === line)` — an O(lines) scan (app.js:818-822). `tasksForSelectedPlant()` calls it per task (app.js:859-862), and that function ignores the prebuilt `_tasksByPlant` index. Dashboard's `_filteredTasks()` calls `tasksForSelectedPlant` ~4× per render (app.js:7328,7495,7608,7754), Table calls it 3× per refresh (app.js:6209,6228,6392), plus Timeline.rebuild (app.js:5669) and `_rebuildPlantIndex` (app.js:837-845). At 3,500 lines this compounds to O(tasks × lines) repeatedly per render.
Fix: Build a `Map<line, plant>` from `masterData.lines` + `lineSettings` once, rebuilt only on `master-data`/`lineSettings` change; make `getPlantForLine` a Map lookup. Then route `tasksForSelectedPlant()` through the existing `_tasksByPlant` index (`return Store._tasksByPlant[plant] || []`) and reuse one scoped array per render instead of recomputing it. Single highest-leverage frontend fix.

**Forward arguments through the `Alerts.recompute` monkey-patch — it currently forces a full-board recompute on every mutation**
Impact: High · Effort: S
`Confidence.init` overwrites `Alerts.recompute` with an arity-0 wrapper: `Alerts.recompute = () => { origRecompute(); Confidence._recomputeDebounced(); }` (nimbus-intelligence.js:1307-1308). The only opts-bearing caller passes `Alerts.recompute(full ? {} : { lines })` (app.js:4135), but the wrapper drops `{ lines }`, so every line-scoped incremental pass degrades to an all-lines scan. At 3,500 lines this turns O(lines-touched) into O(all-lines) on every drag/edit — defeating the documented adaptive incremental optimization.
Fix: `Alerts.recompute = (...args) => { const r = origRecompute(...args); Confidence._recomputeDebounced(); return r; };`

**Fix the two i18n variable-shadowing crashes (`t` shadowed by a local) in command-palette + patterns**
Impact: High · Effort: S
Two `TypeError: t is not a function` crashes where a local `t` shadows the global i18n function (app.js:381): (1) `NeedsEngine.resolveIntent` declares `const t = text.trim()...` (nimbus-intelligence.js:615) then the freeze intent's `run()` calls `t('toast.freeze_saved')` (nimbus-intelligence.js:630) — so running "freeze/lock/fix all" fixes all orders, snapshots, then throws before the success toast (swallowed by `_activate`'s try/catch at :1029, so the user sees no confirmation). (2) `Patterns._observe` declares `const t = Store.tasks[movedId]` (:2028) then calls `t('toast.pattern_detected', { key })` (:2040) — throws exactly when a color-sequence pair hits the threshold, inside a Store subscriber.
Fix: Rename the locals (e.g. `query`, `task`) so the global i18n `t` is reachable in both `run()`/toast calls.

**Stop sending the global (all-line) Store snapshot to the worker — require a plant scope**
Impact: High · Effort: S
When no plant is selected, `Compute._snap` sends `Store.tasksArr` + all calendars + all lineSettings + full `masterData` uncapped (app.js:3456-3464), and `computeUtilization` then builds a row matrix for *every* line in the snapshot (nimbus-worker.js:400-401) and structured-clones it back. The structured-clone over `postMessage` is the documented dominant main-thread cost; at 3,500 lines this is a huge clone in both directions. The plant-scoped `_snap` branch (app.js:3479-3487) already prunes correctly — the global fallback is the scalability hole.
Fix: Never send the global snapshot for compute — require a selected plant (or pass an explicit on-screen line allowlist) so `computeUtilization`/`computeAlerts` are always plant-scoped. This is a guard in `_snap`, not a worker rewrite.

**Virtualize / delegate the LaborPlanning line-plan grid — it builds ~8,000 live inputs with per-cell listeners**
Impact: High · Effort: M
`_renderLinePlan` emits one row per line × one `<input type=number>` per day across the full horizon, each calling `Calendar.effectiveCapacityHours` (app.js:2681-2703), built as one `innerHTML` string, then `querySelectorAll('.lp-line-cell')` re-walks all of them to attach `onchange`/`contextmenu` (app.js:2717). The `days` array is built from all `_weeks` with no 84-cap, so at span 16 it's 112 columns; 70 lines × 112 ≈ 7,840 inputs + 7,840 capacity calls per render. `_renderCapacity`/`_renderExceptions` also iterate all plant lines (app.js:2768,2829).
Fix: Use event delegation on the grid container instead of per-cell `onchange`, render only the visible row/column window (the line-status panel beside it already uses `VirtualList`, app.js:7638 — reuse that), and memoize `effectiveCapacityHours` per `(line,date)` for the render pass.

**Escape interpolated order fields before `innerHTML` (Inspector, hover-card, alert/note renderers)**
Impact: High (security) · Effort: S
Several render paths inject uploaded-Excel fields raw into `innerHTML`. Inspector `_render` interpolates `task.id`, `ORDER`, `MATERIAL_NUMBER`, `MATERIAL_DESCRIPTION`, `COLOR`, `FORM_SIZE` unescaped (app.js:6804-6822; only the notes textarea is escaped). The Interaction hover-card `renderCard` does the same with `ORDER`/`MATERIAL_DESCRIPTION`/`COLOR`/`FORM_SIZE` (app.js:9494-9527). Inline `onclick` handlers also interpolate IDs/values into single-quoted JS-string args (Table app.js:6082,6094,6658; Inspector app.js:6854-6855). A `MATERIAL_DESCRIPTION` containing `<img src=x onerror=…>` executes on render/hover. Dashboard and GanttFilter already escape via `_esc`/`esc` — these paths don't.
Fix: Route every interpolated field through the existing `esc()`/`_esc()` helper before `innerHTML`, and for the inline-handler buttons, attach listeners via `addEventListener` keyed by `data-id` instead of string-concatenated `onclick`.

**Make autosave persist to the backend, or surface clearly that backend save is manual**
Impact: High · Effort: M
The 1,200 ms debounced `_autosave` only calls `_saveCache()` → localStorage; it never POSTs (app.js:11039-11043, subscriber app.js:13670). Backend persistence (`saveAll` → `POST /tasks/update`) fires only on Cmd/Ctrl+S (app.js:10087) and the Save button. Combined with two related data-loss bugs: (1) `saveAll` clears `_dirtyIds`/`_forceIds` *before* checking `persisted < total` (app.js:10817-10843), so partially-persisted rows lose dirty tracking and are never retried; (2) Sandbox "promote" shows a success toast but never marks dirty or triggers a save (app.js:9187-9198), relying on a later unrelated mutation — a reload immediately after promote loses the scenario.
Fix: Either trigger a debounced `saveAll` from the autosave subscriber (with conflict handling), or at minimum (a) on partial save, clear only the server-confirmed `persisted` ids and keep the rest dirty for retry, and (b) call `saveAll()` (or set a dirty flag + fire autosave) at the end of `Sandbox.exit(true)`.

**Refetch only the affected table (plant-scoped) after a MasterData save instead of pulling both full catalogs**
Impact: High · Effort: M
`MasterData._save` always fires `GET /master-data/plants` *and* `GET /master-data/production_lines` in full after any successful save of any table, with no plant scoping or pagination (app.js:14696-14709). At 50+ plants / 3,500+ lines this pulls the entire line catalog on every single-row edit — exactly the "full list query" the roadmap forbids (CLAUDE.md:23).
Fix: Refetch only the table that changed, scope the `production_lines` refetch by selected plant (depends on the backend pagination rec above), and/or patch `Store._state.masterData` in place from the save response instead of refetching.

**Fix `applyFix` overload auto-fix: it optimizes the whole plant but snapshots one line+day, so Undo loses cross-line moves**
Impact: High · Effort: S
For an `overload` alert, the auto-fix calls `Engine.runAndApply('combined')` with no opts (app.js:4094) — `opts.lines` undefined means all lines, default 35-day horizon — but the undo snapshot is filtered to only the single line+day (app.js:4091-4093). `runAndApply` supports scoping via `opts.lines`/`opts.startDate`, but none is passed. Undo therefore restores only that subset; any task moved on other lines/days is permanently lost. The computed `line`/`day` are used only for the snapshot filter, contradicting the inline "Scope the combined optimizer to just this line+day" comment.
Fix: Pass the scope to the engine: `Engine.runAndApply('combined', { lines: [line], startDate, endDate })` so the optimization and the snapshot cover the same tasks.

**Replace the Calendar/util full-block rescan with a parsed, indexed blackout structure**
Impact: High · Effort: M
`dailyCapacityHours` and `isAvailable` iterate *all* of `Store.blocks` + `Store.plantBlocks` and re-parse each block's dates with `Util.parseDate` on every call (app.js:1025-1045,1059-1080), ignoring the `Calendar._runBlocks` index that `_overlapsBlock` uses. `computeMatrix` calls `dailyCapacityHours` (plus `effectiveCapacityHours`, which calls it again) once per line per day (app.js:4188-4189), giving O(L·days·(blocks+plantBlocks)) parse-heavy work per matrix build. The unmemoized `Utilization.dayByLine` path (app.js:4262-4326) re-parses every block per call too.
Fix: Build a parsed/indexed blackout structure (ms + pre-parsed Date, bucketed by line/plant) once per matrix build or per `Store._rev`, and have `dailyCapacityHours`/`isAvailable`/`dayByLine` consult it instead of rescanning raw `Store.blocks`. Also compute `full = dailyCapacityHours(...)` once per cell and derive `effectiveCapacity` inline (the Alerts path already does this) to kill the duplicate call.

**Cache the marquee item rects at drag start instead of `getBoundingClientRect` per item per pointermove**
Impact: High · Effort: M
The marquee `updateOverlay` loops *all* `Timeline._tl.itemSet.items` and calls `box.getBoundingClientRect()` per item on every `pointermove` and every edge-scroll RAF tick (app.js:9643-9647). `getBoundingClientRect` forces synchronous layout; doing it N times per frame while writing overlay styles is O(n) layout thrash. At 70+ visible lines this drops the marquee below 60fps.
Fix: Cache each item's rect once at marquee start (recompute only on scroll/pan, not on mousemove), or batch all reads before any style writes. Same pattern applies to the ghost-drag conflict check — pre-index peers by `PRODUCTION_LINE` once at drag start rather than scanning `Store.tasksArr` per companion per frame (app.js:10017-10022).

**Add a global `:focus-visible` baseline — keyboard focus is invisible across the chrome (WCAG 2.4.7)**
Impact: High · Effort: S
Only 2 `:focus-visible` rules exist in 4,912 lines of CSS (styles.css:346,3107). `.btn`, `.tab-btn`, `.seg-btn`, `.icon-btn`, `.alert-row`, `.hier-item`, dropdown rows define `:hover` but no focus ring, so keyboard-only users can't see what's focused.
Fix: Add `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` as a baseline (reuse the `.kpi-tile.is-actionable:focus-visible` pattern at styles.css:346), with a dark-mode-safe variant; let components opt out only where they already provide a ring. Also replace the hardcoded `outline: 2px solid #111` on the active tab (styles.css:134) with `var(--accent)` so it adapts to dark mode.

**Memoize Dashboard's filtered utilization matrix — it rebuilds 3× per render (cache bypassed by filtered subsets)**
Impact: Med · Effort: S
Every `Dashboard.render()` (debounced 300 ms) calls `Utilization.computeMatrix` three times with non-null filtered subsets — KPIs 7d (app.js:7328), heatmap 7d (app.js:7495), line-status 1d (app.js:7608). Because the `(startMs,days,_rev)` memo only applies when `srcTasks===null` (app.js:4169), each is a full O(lines·days·tasks) rebuild, and the two 7-day calls recompute identical data. LaborPlanning compounds this with a 90-vs-84 `days` mismatch between `_renderKPIs` (app.js:2328) and the body renderers (app.js:2654) that guarantees a second build.
Fix: Compute the 7-day filtered matrix once at the top of `render()` and pass it to `_renderKPIs`/`_renderHeatmap`, or add a subset cache keyed on `(startMs|days|filterLines-signature|_rev)`. Align the LaborPlanning KPI horizon (90) with the body horizon (84) so they share a cache entry.

**Forward worker message args and guard against worker death / scope-mismatched cache**
Impact: Med · Effort: M
Three worker-coupling issues: (1) the sync fallback is permanent — a single `Compute._worker.onerror` sets `_dead=true` forever (app.js:3427-3431,3491), so one transient worker error routes all compute to the main thread for the session with no recovery. (2) The worker silently no-ops on unknown message types (nimbus-worker.js:469-482), leaving the caller's promise pending forever — realistic under version skew since the worker is loaded by bare filename with no `?v=` cache-bust (app.js:3419). (3) The prewarm writes a plant-scoped matrix under the same `${startMs}|7|${rev}` key the sync global path expects (app.js:4344 vs 4170), so a cache hit can be missing other plants' lines.
Fix: Include the selected plant in the utilization cache key; add a `_post` timeout that rejects + cleans the `_pending` entry; add a worker `?v=` cache-bust (or version-handshake) matching `APP_VERSION`; and consider allowing one worker re-init rather than permanent death.

**Stop the always-on per-second Timeline ticker and rAF loops from running on hidden/idle tabs**
Impact: Med · Effort: S
The Timeline ticker `setInterval(…, 1000)` updates past-zone + alert-horizon items every second for the page lifetime regardless of tab visibility, never cleared (app.js:5499-5516). `WelcomeSplash` runs a perpetual rAF loop calling `getBoundingClientRect` twice per frame while `selectedPlant` is null (app.js:13519-13559). The 30 s admin health poll's interval is never cleared on tab switch (`_stopHealthPolling` exists but is never called, app.js:11215-11229). Two bootstrap `setInterval`s (heap 30 s, freeze watchdog 1 s) never pause and false-positive after a backgrounded tab resumes (app.js:14953-14975).
Fix: Gate the Timeline ticker on `Timeline._ganttActive()` and tab visibility; replace the WelcomeSplash rAF loop with a one-shot position + resize/scroll listeners; call `_stopHealthPolling()` on admin-tab deactivation; pause the watchdogs on `visibilitychange`.

**Fix `_normalizeDates` snapping start/end independently (collapses sub-grid ranges) and `_onCellChanged` zero-length/inverted ranges**
Impact: Med · Effort: S
`_normalizeDates` snaps `start_date` and `end_date` independently to the 15-min grid (app.js:909-910), so a `:07→:08` range rounds to `start===end`; `computeMatrix` then silently drops it via `tEndMs <= tStartMs` (app.js:4213). Separately, AG Grid `_onCellChanged` produces ranges the backend rejects: editing `start_date` when `runHours` is 0 leaves the old `end_date` (potential `end<start`, app.js:6468-6469), and `RUN_TIME=0` yields `end===start` (app.js:6470-6475); the autosave then fails server-side with weak feedback. Inspector also unconditionally recomputes `end_date` from `RUN_TIME` on a start edit, discarding manual end overrides (app.js:6908-6910).
Fix: After snapping, validate `end > start` and either preserve duration (snap end relative to start) or reject the edit; in `_onCellChanged`, guard against zero/negative duration before committing and show an inline error tied to the cell.

**Convert line/color/form filter dropdowns to searchable comboboxes; scope the Calendar/Hierarchy grids per-plant**
Impact: Med · Effort: M
Multiple line/color selectors are flat scroll-only `<select>`/checkbox lists, violating the roadmap's "must always be filterable" rule (CLAUDE.md:20-25): the three Calendar line selectors (app.js:1187-1194,1305-1307,1262-1272), Table chip dropdowns (app.js:6205,6224), and GanttFilter/Dashboard line dropdowns (app.js:7190,8250,8301,8344). `Calendar.render()` also renders one hours row per line system-wide with no plant scoping (app.js:1179-1219), and the Hierarchy sidebar silently shows only orders *starting today* (app.js:7044-7046).
Fix: Reuse `ProdLines._lineFilter`'s substring-filter pattern (app.js:1883-1885) — or the already-correct `PlantSelector` combobox — inside these dropdowns; default the Calendar hours grid to `Store.linesForSelectedPlant()` and virtualize its rows; add a visible "Today" label (or full schedule) to the Hierarchy panel.

**Use `Object.assign`-free ref-swap in `Store.updateMany`; add a master-data re-index hook for `_tasksByPlant`**
Impact: Med · Effort: S
`updateTask` swaps to a new object reference so identity-diffing subscribers re-render (app.js:636-645), but `updateMany` (the optimizer bulk path) mutates in place via `Object.assign(task, p.changes)` (app.js:677-681) — so AG Grid / diff-by-identity subscribers may skip re-rendering after a bulk run. Separately, `_rebuildPlantIndex` drops tasks whose plant is only derivable from master data when `masterData`/`lineSettings` aren't hydrated yet (`if (!p) continue`, app.js:837-845), and only `setTasks` rebuilds the index — `setLineSetting`/master-data setters don't (app.js:813-817).
Fix: In `updateMany`, build a new object per patch (`this._state.tasks[p.id] = { ...task, ...p.changes }`) before `_normalizeDates`; and call `_rebuildPlantIndex()` from the `lineSettings:change` / `master-data-changed` setters so the index backfills after hydration.

**Fix `_disaggregate` rounding drift and the LaborPlanning aggregate-vs-line undo/cache desyncs**
Impact: Med · Effort: S
`_disaggregate` broadcasts one `Math.round(perSlot*10)/10` value to every open slot (app.js:2310-2312), so the persisted line-plan total drifts from the entered aggregate (100h / 3 = 33.3 × 3 = 99.9) with no residual allocation. The aggregate-edit undo restores only the aggregate cell, never the auto-split line rows it created (app.js:2553-2563), so views diverge after undo. And `_aggrData`/`_lineData` caches are cleared only on `plant:selected`, not on `master-data-changed` (app.js:2986-2988), so adding/removing a line leaves stale caches.
Fix: Use largest-remainder allocation (add the rounding residual to the last/largest slot) so slots sum to `groupHours`; in the undo closure, also revert `_lineData` + re-save the line rows; and delete `_aggrData[plant]`/`_lineData[plant]` in the `master-data-changed` branch too.

**Add `aria-live` to toasts, `role=dialog`/focus-trap to modals, and dialog/skip-landmark structure**
Impact: Med · Effort: M
Toasts are plain divs in `#toast-stack` with no `role`/`aria-live` (app.js:5335-5343, index.html:2398) — error toasts (invalid date, save failed) are silent to screen readers. `Modal.confirm` toggles `.hidden` with no focus trap, no initial focus, and no Escape→cancel (app.js:5353-5382; leaks the promise on Escape), while most modal close buttons are bare `✕` with no `aria-label` and containers lack `role=dialog`/`aria-modal`/`aria-labelledby` (index.html:1718,1757,…). The shell also has no `<main>` landmark or skip link (index.html:902-1683), and tabs use `role=tab` without `aria-selected`/`aria-controls` (index.html:925-941).
Fix: Add `aria-live="polite"` + `role="status"` to `#toast-stack` (assertive for errors); convert `confirm-modal` to native `<dialog>` (the alert popup at app.js:6618 already does); add `aria-label="Close"` + `role="dialog"`/`aria-modal`/`aria-labelledby` to modals; wrap panels in `<main>` with a skip link; add `aria-selected`/`aria-controls` synced with the active class.

**Resolve the multiple "brand amber" values and undefined CSS tokens that break dark mode**
Impact: Med · Effort: S
Three different ambers claim to be the accent: `--accent #b8791a` (styles.css:44), `var(--nimbus-amber,#d97706)` on the marquee/hover-card (styles.css:772,833), and `var(--amber,#d4a843)` on the active line-filter (styles.css:1762) — the latter two reference undefined tokens that always hit hardcoded fallbacks and never shift in dark mode. The Admin profiler table uses undefined `var(--border)`/`var(--border-subtle)`/`var(--font-mono)` with no fallback, rendering borderless (styles.css:4903-4905), and the pill context menu's undefined `var(--bg-float,#1e2025)` makes a dark menu in light mode (styles.css:437). Several newer surfaces (`.cw-active-card` 3042, `.welcome-splash` 1441, `.lp-hm-grad` 4845) hardcode light colors with no `body.dark` override.
Fix: Replace `var(--nimbus-amber,…)`/`var(--amber,…)` with `var(--accent)`; point `--border*`→`--line`, `--font-mono`→`'JetBrains Mono', monospace`, `--bg-float`→a defined surface token; and add `body.dark` overrides (or tokenize) for the hardcoded-light components.

**Lazy-load / defer CDN libraries and move line palette off a 10-color wheel**
Impact: Med · Effort: M
All four CDN libraries (vis-timeline, ag-grid, chart.js, flatpickr) and Google Fonts load render-blocking in `<head>` with no `defer`/`async` and no SRI (index.html:24-42), though ag-grid (Orders), chart.js (Dashboard charts), and flatpickr (modals) aren't needed for first paint. All five locale files load eagerly though only one is active (index.html:2400-2404). Separately, the production-line color palette is only 10 colors (`--l0..--l9`, styles.css:68-69; `.lc-0..lc-9`, 720-729), so at 70+ lines/plant colors wrap every 10 lines and adjacent lines collide.
Fix: Add `defer` to the library scripts (or lazy-load ag-grid/chart.js/flatpickr on first feature use), add `preconnect` for `cdn.jsdelivr.net`/`unpkg.com`, add SRI hashes before any hosted deploy, lazy-load non-default locales, and replace the 10-class line palette with a generated hashed-HSL scheme.

**Add a cycle guard to `DependencyOverlay` critical-path recursion; throttle its per-frame relayout**
Impact: Low · Effort: S
`getLen(id)` recurses through `deps[id]` and memoizes `chainLen[id]` only *after* recursing (nimbus-intelligence-adjacent app.js:8475-8482), so a cyclic `dependencies` map (server-supplied, not validated acyclic) recurses to stack overflow — caught by the per-id try/catch at :8482 and silently mis-rendered. The overlay also runs on both `rangechange` and `rangechanged` (continuous during pan), calling `getBoundingClientRect` on every `.vis-group` then rebuilding all SVG (app.js:8459-8579).
Fix: Add a `visiting` set (gray/black marking) to `getLen` to break cycles; throttle `render` to `rangechanged` (or rAF-coalesce), cache group Y offsets until the group set changes, and batch all rect reads before DOM writes.

---

### Quick wins (do this week)

- **Backend:** `CREATE INDEX idx_lines_production_line ON production_lines(production_line);` — one statement, speeds up every `/tasks` and `count_orders` (db.py:126,183).
- **Backend:** Validate the `NUMERIC` length in `add_column` (master_data.py:290-291) and hard-cap unscoped `/tasks` (brain.py:557-576) — closes the injection sink and the order-book-dump in two small edits.
- **Frontend:** Forward args through the `Alerts.recompute` monkey-patch (nimbus-intelligence.js:1307-1308) — restores line-scoped incremental recompute with a one-line fix.
- **Frontend:** Rename the two shadowed `t` locals (nimbus-intelligence.js:615/630 and 2028/2040) — stops the freeze-intent and pattern-detected `TypeError` crashes.
- **Frontend:** Add the global `:focus-visible` baseline (styles.css) and route `tasksForSelectedPlant()` through the `_tasksByPlant` index (app.js:859-862) — one CSS rule fixes keyboard a11y app-wide; one index lookup removes the dominant per-render scan.

---

## §3. UI — make it feel exceptionally better


A product designer's plan for raising NIMBUS from "competent dense ops tool" to "premium scheduling instrument." Every item is tied to a real selector in `styles.css` / `index.html` and explains the *felt* difference. Ordered by impact within each tier.

---

### Foundational polish

#### 1. Visual hierarchy, typography, spacing & density

##### 1a. Tokenize the density scale — and add a density toggle hook
**Where:** `:root` (styles.css:71–80), consumed by `.btn` (172), `.input/select/textarea` (246), `.tab-btn` (118), AG Grid `--ag-row-height` (1058).

Every control height is a hardcoded `30px`/`28px`/`32px` literal scattered across the file, so density — the single highest-leverage lever for a 70-line / 3,500-order grid — can't be tuned.

```css
:root {
  --row-h: 30px; --row-h-sm: 24px; --grid-row-h: 32px;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --pad-cell:10px;
}
body.compact {
  --row-h:26px; --grid-row-h:26px; --pad-cell:7px;
  --space-3:8px; --space-4:12px; font-size:12px;
}
```
Then `.btn { height: var(--row-h); }`, `--ag-row-height: var(--grid-row-h)`, etc.

**Felt difference:** a planner triaging a full plant flips to compact and sees ~25% more rows with one class on `<body>` — impossible today.

##### 1b. One type ramp instead of ~12 ad-hoc font-sizes
**Where:** `40px` (hero, 299), `26px` (KPI, 331), plus `22/16/14/13.5/12.5/11.5/11/10px` repeated as raw px, and uppercase-label letter-spacing that drifts between `0.04/0.06/0.07/0.08/0.14em` (`.kpi-tile .k` 328, `.dash-filter-label` 60, `.form-row label` 1560, `.col-head` 1153).

Define `--fs-*` and `--ls-label` tokens and apply them. The mono-for-data discipline (`'JetBrains Mono'` on KPI values/dates) is already good — formalize it.

**Felt difference:** unifying letter-spacing alone makes the chrome read as one designed system rather than five.

##### 1c. Shrink the Dashboard hero's vertical cost
**Where:** `.hero-text h1 { font-size:40px }` (299), `.hero-row { margin-bottom:36px }` (289), `.home-container { padding:12px 32px 60px }` (283). A 40px marketing hero pushes the actual KPIs/alerts below the fold. Drop to ~28px and collapse it once a plant is selected — it's onboarding chrome, not working chrome.

##### 1d. Consistent panel-header rhythm
**Where:** `.panel-head` (370), `.cal-head` (1098), `.ac-head` (848), admin `summary` (4199) each invent their own padding. Standardize on `var(--space-3) var(--space-4)` + one 13.5px Archivo title.

---

#### 2. Motion & micro-interactions (purposeful, not decorative)

##### 2a. Replace `transition: all` on segmented buttons
**Where:** `.seg-btn { transition: all var(--t-fast); }` (styles.css:222) — a compositor foot-gun on dense toolbars. The correct pattern is already used one selector up on `.btn` (180): list the 4 real properties (`background, color, border-color, box-shadow`).

##### 2b. Make Gantt drag feel physical — lift on pickup, settle on drop
**Where:** `.vis-item.vis-range` (682), `.vis-item.vis-selected` (690).
```css
.vis-item.vis-range { transition: box-shadow var(--t-fast), transform var(--t-fast); }
.vis-item.vis-dragging { box-shadow:0 6px 16px rgba(26,27,31,.28); transform:translateY(-1px) scale(1.01); z-index:50; }
@keyframes drop-settle { 0%{box-shadow:0 0 0 3px var(--accent-wash)} 100%{box-shadow:none} }
.vis-item.just-dropped { animation: drop-settle .35s ease-out; }
```
**Felt difference:** the bar feels *grabbed* (rises toward cursor) and *confirmed* (settles back) — the single most premium sensation in a Gantt, for ~8 lines. Mirrors the existing copy-flash at AG Grid 1083.

##### 2c. Optimistic-save state on bars and the Save button
**Where:** order bars `.vis-item`, Save button (index.html:948). The audit confirms autosave only writes localStorage; backend `saveAll` is manual — so the user *needs* to see dirty vs. persisted.
```css
.vis-item.is-dirty { box-shadow: inset 0 0 0 2px var(--warn); }
.vis-item.is-saving { opacity:.7; }
.btn.has-unsaved::after { content:''; position:absolute; top:-2px; right:-2px; width:7px; height:7px; border-radius:50%; background:var(--warn); }
```
**Felt difference:** the amber dot on Save is the gap between "I think I saved" and "I have 3 unsaved edits."

##### 2d. Conflict outline that *arrives* (one pulse, then static)
**Where:** `.vis-item.conflict-order` (702), `.ag-theme-quartz .row-alert` (1081). A new overlap pulses once to catch the eye, then holds — no perpetual flashing on a status-critical tool.

##### 2e. Globally honor reduced motion
**Where:** the guard at styles.css:1432 only hides `.ws-broom-flyby`. The splash scale-bounce (`ws-in` 1462), toast slide (1600), KPI hover-lift (341) all ignore it. Add a blanket `@media (prefers-reduced-motion: reduce)` that zeroes `animation-duration`/`transition-duration`.

---

#### 3. Feedback & state: loading / skeleton / empty / error / undo

##### 3a. Skeletons for the three heavy async surfaces
**Where:** Dashboard heatmaps, `#ag-grid` (1043), DB Deep Dive (`.admin-db-loading` 4190 is just italic "loading…"). Add a token-driven `.skeleton` shimmer (linear-gradient over `--bg-subtle`/`--bg-strong`) on KPI tiles, heatmap rows, and grid rows during first fetch. **Felt difference:** the app reads as fast — layout is present, just filling in — instead of stalling on a Postgres round-trip.

##### 3b. Upgrade `.empty-state` from a faint sentence to a real pattern
**Where:** `.empty-state { color: var(--fg-faint) }` (526) — one faint line reads as a failure. Add glyph + headline + primary action slots, and wire the cases the audit flags: "no plant selected" (Calendar/Labor), MasterData "no rows match" blank tbody, and Hierarchy's today-only empties ("No orders starting today — [View full schedule]").

##### 3c. Make undo discoverable and conflict-loss recoverable
**Where:** `UndoStack` (10 levels) has no visible affordance; the audit's **highest-severity UX bug** is silent edit loss on concurrency conflict (transient toast only) and dropped dirty-tracking on partial save.
- A sticky "Undo (Ctrl+Z) — *last action*" pill bottom-left, fading after ~6s.
- A **persistent** (non-auto-dismiss) warn banner on conflict: "Your change to ORDER 4471 was overwritten by server — [Reapply] [Keep server]."

**Felt difference:** schedulers trust destructive ops because every one is reversible *and visible*.

##### 3d. Toast a11y + don't drop unread errors
**Where:** `#toast-stack` (1579) has no `aria-live`; `.toast.error` (1597) can be evicted under a burst. Add `aria-live="polite"` (and `role="alert"` for errors), and visually mark a queued error so it isn't silently lost.

---

#### 4. Color, contrast, dark-mode polish & accessibility

##### 4a. The single missing global focus ring — biggest a11y win in the file
**Where:** only TWO `:focus-visible` rules exist in 4,912 lines (`.kpi-tile.is-actionable` 346, and 3107). `.btn`, `.tab-btn`, `.seg-btn`, `.icon-btn`, `.alert-row` (478), `.hier-item` (640) have hover but no keyboard focus — a WCAG 2.4.7 failure across the whole chrome.
```css
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:var(--r-sm); }
```
Dark mode already shifts `--accent` to `#d4920f`, so it adapts free. **Felt difference:** the keyboard-first flows the audit confirms exist in `Interaction` finally have a *visible* cursor.

##### 4b. Replace hardcoded `#111` active-tab outline with the accent token
**Where:** `.tab-btn.active { outline:2px solid #111 }` (styles.css:134) — a muddy near-invisible halo on the dark `~#1c1d26` topbar that also fights the amber active icon. Use `box-shadow: inset 0 0 0 1px var(--accent)`.

##### 4c. Kill the three competing ambers
**Where:** `--accent` is `#b8791a` (42), but the marquee uses `var(--nimbus-amber,#d97706)` (772–773), the hover-card line the same (833), and the active line-filter `var(--amber,#d4a843)` (1762,1764). `--nimbus-amber` and `--amber` are **never defined**, so all three always fall to those literals and never shift in dark mode. Replace every one with `var(--accent)`.

##### 4d. Fix the dark-mode-broken surfaces (all hardcoded light, no `body.dark` override)
- `.cw-active-card` gradient ends `#fdf8ee` (3042) → dark-to-cream split; use `var(--bg-elev)`.
- `.welcome-splash` frost `rgba(245,244,239,.82)` (1441) → near-white sheet over a dark app; add `body.dark { background: rgba(19,20,26,.82) }`.
- `.ws-orb` goes pure `#ffffff` in dark (1475) → harsh white disc; use `var(--accent-soft)`.
- `.lp-hm-grad` 4 fixed light stops (4845) → tokenize as `--heat-0..3` with dark overrides.
- `.pill-ctx-menu` falls back to `var(--bg-float,#1e2025)` (437) — `--bg-float` **undefined**, so a dark menu appears in *light* mode with near-black `var(--fg)` text → dark-on-dark. Use `var(--bg-elev)`.

##### 4e. Profiler table's invisible borders
**Where:** `.admin-perf-table` uses `var(--border)`/`var(--border-subtle)`/`var(--font-mono)` (4903–4905) — **none defined, no fallback** → borders resolve to `currentColor`, font drops to OS monospace. Change to `var(--line)` and `'JetBrains Mono', monospace`.

##### 4f. Color-blind safety on dependency arrows & util pills
**Where:** `.dep-arrow.gap/.tight/.ok` (1709–1711) and `.line-util.ok/warn/err` (637–639) differ by color alone. The alert system already does this right with shape glyphs (`.sev::before` X/triangle/i at 499–510) — extend it: dash patterns on dep arrows, a leading glyph (▲/●/✓) on util pills.

##### 4g. Scope the universal scrollbar selector
**Where:** `*::-webkit-scrollbar*` (1612) matches every node (thousands of vis-timeline + AG Grid cells at scale). Scope to known containers (`.home-scroll, .cal-scroll, .modal-body, #hierarchy, .ag-body-viewport, #cal-hours-body`).

---

### Signature touches — the wow tier

#### S1. A command palette that teaches itself — the keyboard-first spine
CommandPalette exists (Cmd/Ctrl+K, `nimbus-intelligence.js`) but the launcher is a broom `🧹` FAB with a hover-only shortcut hint — undiscoverable for the very users it serves.
- Swap the broom for an always-visible **⌘K pill** in `.topbar-actions`, styled like a muted `.seg-btn` showing the literal shortcut.
- Add **focus-trap + `aria-modal`** and restore focus to the launcher on close (neither exists today).
- Default the empty palette to **"Right Now" smart suggestions** from the existing NeedsEngine (*"3 lines overloaded Thursday → Rebalance"*).

**Felt difference:** the shift from mouse-hunting tabs to "⌘K → type intent → Enter" *is* the premium-tool feeling. Today it's hidden behind a broom.

#### S2. A live schedule-health ring with a heartbeat
The Confidence 0–100 score + sparkline already exists (badge injected into `.topbar-actions`).
- Render it as a thin **amber conic-gradient arc ring** around the number — readable from across a control room, not just text.
- **Animate score changes** (400ms count-up + ring sweep, reusing a `drop-settle`-style keyframe) so an optimize run visibly *moves the needle*.
- Band-color the ring via `--ok/--warn/--err` with a numeric label (not color-only).

**Felt difference:** after Optimize, the planner *watches* health climb 71 → 88 — the cause-and-effect moment that makes the optimizer feel intelligent, not a black box.

#### S3. Optimizer preview as a before/after cinematic
`OptimizerPreview` (`index.html:2072–2079`) already computes per-KPI deltas + verdict, but conveys direction by color + ▲/▼ only.
- Animate each KPI number old→new with explicit text ("Lateness −12h · improved"), not just a colored arrow.
- On Apply, **ghost old bar positions** (reuse `.vis-item.ghost` 1880, 0.45 dashed) and tween bars old→new start over 250ms — the board visibly reflows.
- A single "N improved / M regressed" verdict pill.

**Felt difference:** the scheduler *sees* what moved and trusts the heuristic instead of second-guessing it.

#### S4. Smart defaults that remember the operator
- **Density toggle** (Comfortable/Compact, item 1a) in System Settings *and* Cmd+K, persisted next to `nimbus.theme`.
- **Remember last plant + tab + sidebar width** (audit: width isn't persisted, resize is mouse-only/no ARIA) so the tool reopens exactly where they left it.
- **Per-plant default** optimize horizon and Gantt zoom.

**Felt difference:** the tool feels like *theirs* — zero re-setup on return. Premium tools never make you re-tell them who you are.

#### S5. A keyboard-first, zoomable, fully-navigable board
`Interaction` already has arrow-nav, marquee, multi-drag — but page zoom is **hard-disabled globally** (index.html:5–18, `user-scalable=no` + Ctrl+wheel/Ctrl±0 `preventDefault`), a WCAG 1.4.4 failure that also blocks low-vision schedulers.
- **Scope the zoom-lock to `#vis-timeline` only** — Gantt keeps scroll-zoom, the rest of the app (grids, dashboard, modals) becomes browser-zoomable.
- **Visible roving-tabindex** on order bars (uses S1's focus ring) so arrow-nav has a cursor on the Gantt.
- A discoverable **"?" shortcuts cheatsheet** modal listing the Interaction keymap.
- Make `.resize-handle` (670) a `role="separator"` with `aria-valuenow` + arrow-key support, persist the width.

**Felt difference:** a scheduler runs a full shift mouse-free — zoom to read, arrow to navigate, ⌘K to act, Ctrl+Z to undo — and a low-vision operator can finally enlarge the grid. Keyboard-first + accessible is the hallmark of a tool people live in 8 hours a day.

---

#### Suggested sequencing (impact-first)
1. **4a focus ring + 4b/4c/4d/4e dark-mode & undefined-token fixes** — highest impact-per-line; fixes look-broken and a11y-broken at once.
2. **2c optimistic-save + 3c undo/conflict recovery** — addresses the top-severity UX bug (silent edit loss).
3. **1a density tokens + S4 smart defaults** — unlocks the scale story the roadmap demands.
4. **2b drag physics + S3 optimizer cinematic + S2 health ring** — the wow tier.
5. **S1 ⌘K discoverability + S5 keyboard/zoom** — the keyboard-first spine.
6. **3a skeletons + 3b empty states + 2a/2e/4g hygiene** — final fit-and-finish.

Everything preserves the existing amber / warm-slate token system and dark-mode layer — it sharpens what's already there rather than introducing a new design language.

---

## §4. Moonshot additions


NIMBUS today is an honest manual scheduling cockpit: a Postgres-backed order book, a stateless FastAPI layer, a vanilla-JS reactive frontend, a Compute web worker, a what-if Sandbox, and an "Engine" whose three modes are dispatching heuristics (SPT / changeover-grouping / combined) with **no changeover-cost matrix, no finite-capacity constraints, and no precedence enforcement**. The verified audit confirms the bones are sound (single-transaction writes, xmin optimistic concurrency, worker offload, memoized utilization) but the system stops at *visualizing* decisions a human makes by hand. Every moonshot below turns an existing asset into a decision the system can *make or defend* — not vaporware UI polish.

---

### 1. NIMBUS Solver — a real finite-capacity constraint engine (CP-SAT) behind the existing Engine façade

**Value proposition.** This is the headline gap. `Engine.runAndApply(mode)` is a greedy dispatcher that ignores the three things that actually drive a feasible factory schedule: machine capacity, sequence-dependent changeover cost, and finish-to-start precedence. A real solver turns "optimize" from a re-sort into a *plan you can defend to a plant manager*: minimize total weighted tardiness + changeover hours subject to one-order-per-line-at-a-time, calendar/blackout windows, fixed orders pinned, and FTS links honored. The data to do this **already exists** — `COLOR`/`FORM_SIZE`/`MATERIAL_NUMBER` give a changeover-cost matrix, `RUN_TIME` gives durations, calendars give capacity windows, `scheduled_*`/`FIXED` give pins, and `Store._state.dependencies` gives precedence.

**What it would take.** Add a Python solver service alongside `brain.py` using Google OR-Tools CP-SAT (the natural fit for disjunctive job-shop scheduling). New endpoint `POST /optimize` takes a plant-scoped order set + the per-plant `plants.constraints` JSONB (the registry already exists in `Engine.CONSTRAINT_CATALOG`/`activeConstraintKeys` — today only `colorWheel` is wired) and returns start/end assignments. Model: interval variables per order, `NoOverlap` per line for capacity, `AddCircuit`/transition-cost terms for sequence-dependent changeover (derive the cost matrix from attribute distance), precedence constraints from the dependency map, fixed orders as bounded intervals, objective = weighted sum of tardiness + changeover. Frontend wires it through the **existing `OptimizerPreview.runWithPreview`** path so you get the before/after KPI card, full-plant Undo snapshot, and apply/discard for free. The heuristic Engine stays as the instant-feedback fallback and the warm-start seed for the solver.

**Why high-leverage now.** The per-plant constraint registry (`CONSTRAINT_CATALOG`, `constraintsFor`, persisted to `plants.constraints` JSONB) is *already built and undocumented* — it was clearly designed as the extension point for exactly this. `OptimizerPreview` already wraps optimization with KPI deltas and undo. CP-SAT solves single-plant problems (~70 lines) in seconds. You plug a real brain into sockets that already exist.

**Difficulty: XL** (the solver model and changeover-cost calibration are the hard parts; the integration surface is mostly built).

---

### 2. Ripple-cost optimization in the Compute worker — make every drag financially honest

**Value proposition.** Today `Engine.autoReflow()` shifts downstream orders after a drag to remove overlap, but the planner commits the drag *first* and discovers the damage *second*. There is no number on "what did that move cost?" A ripple engine computes, before commit, the full downstream consequence of a candidate move: how many orders shift, total tardiness delta, changeover-hours delta, and confidence-score delta — and surfaces it as an Alt-hover ghost preview plus a "this move costs +3.5 late-hours / saves 18 changeover-min" verdict.

**What it would take.** Add a `RIPPLE` message type to `nimbus-worker.js` (which already ports the full Calendar capacity engine and alert rules off-thread). It receives the plant snapshot + a candidate `{taskId, newStart}` and returns the reflow delta + KPI impact without touching the Store. The frontend renders ghost bars over vis-timeline (reuse the overlay tech already in `DependencyOverlay`/`RipplePreview`). Pair with **finding-driven fixes**: the worker's `computeUtilization` cache-key collision with the sync path (the plant-scoped vs global matrix bug) must be fixed first by adding plant scope to the cache key — otherwise ripple costs computed off a wrong-scope matrix mislead the planner.

**Why high-leverage now.** The worker is the right home (DOM-free, already has the capacity model), the `Compute` wrapper already does stale-rev guarding and sync fallback, and `OptimizerPreview` proves the before/after-KPI pattern works. This is the single biggest trust unlock for a tool people are afraid to drag.

**Difficulty: M.**

---

### 3. Changeover-cost learning from the order history Newell already has

**Value proposition.** The Engine's `changeover` mode *assumes* color→form→size is the right grouping priority, but the real changeover cost between two products is an empirical fact buried in the `orders` history: how long setups actually took between consecutive (attribute-A → attribute-B) pairs. An ML moonshot learns the **actual sequence-dependent changeover-cost matrix** from historical `scheduled_start`/`scheduled_end` gaps between adjacent orders on the same line, and feeds it into both the heuristic Engine *and* the CP-SAT solver (#1). This replaces a hand-guessed priority order with measured minutes.

**What it would take.** This is grounded ML, not an LLM: a regression/gradient-boosted model (or even a robust empirical mean with shrinkage) over historical adjacent-order pairs, keyed on attribute transitions (color-pair, form-pair, size-pair) and line. Run it as a periodic batch job in Python (the data layer already materializes order history; `db.load_orders_df` exists). Persist the learned matrix per-plant (Postgres, keyed by plant per the roadmap). The `Patterns` module in the intelligence layer already does a frequency-tally of color-sequence pairs — this is its principled, server-side, dollarized successor.

**Why high-leverage now.** It is the missing input that makes *both* optimization moonshots correct rather than plausible. It uses data Newell already generates daily. And it degrades gracefully: with no history, fall back to attribute-distance defaults.

**Difficulty: L** (the modeling is tractable; data hygiene on historical gaps — distinguishing real changeovers from idle/blackout time — is the real work).

---

### 4. Tardiness / late-risk forecasting — turn the lateness heatmap into a prediction

**Value proposition.** The Dashboard already renders a projected-lateness heatmap from `Util.latenessHours`/`sapDueDate` — but it's a *deterministic projection* of the current schedule. The moonshot makes it *probabilistic*: given historical variance between `BASIC_*` (SAP-planned) and `scheduled_*` (actual) dates, plus line utilization and changeover density, predict the probability each order misses its due date and the expected late-hours. The planner sees "PO-4823: 71% likely late, ~6h expected" instead of a binary projection that assumes everything runs to plan.

**What it would take.** The SAP-vs-actual variance signal already exists (`Util.sapDueDate`/`scheduledEnd`/`latenessHours` compute it; the audit confirms `BASIC_*` vs `scheduled_*` is the COALESCE'd pair in `db.py`). Train a calibrated classifier/quantile model on historical orders: features = run-hours, line utilization at scheduled window, changeover neighbors, days-of-slack-to-due, plant. Serve via a `GET /risk?plant=` endpoint (stateless, plant-scoped, paginated per the roadmap). Render confidence-banded cells in the existing heatmap; feed the risk weight into the solver objective (#1) and the Triage ranking. The `NeedsEngine` already scores situational templates — add a "high-late-risk orders" need that surfaces in the Cmd+K "Right Now" feed.

**Why high-leverage now.** The variance data is sitting in two columns the app already reads. The visualization surface (heatmap + drill-down) is already built. This is the difference between "the schedule says late" and "the schedule will probably be late" — which is what a planner actually needs to act early.

**Difficulty: L.**

---

### 5. Multi-scenario branches with server-side persistence and team sharing

**Value proposition.** `Sandbox` today is binary (enter → edit live Store → promote or discard), edits mutate the live in-memory Store, and the audit found promote doesn't even mark the schedule dirty for save — a silent data-loss path. Elevate it to **named, durable, shareable scenario branches**: "today as-is," "if line 5 breaks Thursday," "rush order lands," "Mike's draft." A planner holds 3–5 plans at once, diffs any against Main, and — the team unlock — *shares* a scenario to a colleague because branches live in Postgres, not just one browser.

**What it would take.** Promote Sandbox snapshots from in-memory clones to a `scenarios` table in Postgres (plant-scoped, owned by user, with the xmin concurrency model the write path already uses). A `POST /scenarios` / `GET /scenarios` surface. Frontend: a scenario dropdown (the `TimeMachine` already snapshots full task arrays to IndexedDB — generalize that storage abstraction to also hit the backend). Diff any two scenarios with the existing `Diff` viewer. Fix the promote-not-dirty and promote-undo-asymmetry bugs the audit flagged as part of the work. This also lays the foundation for genuine multi-user collaboration, which the optimistic-concurrency `stale`/`/tasks/refresh` machinery was clearly built to support.

**Why high-leverage now.** Sandbox, TimeMachine (durable IndexedDB history), and Diff already exist as separate intelligence-layer modules — this moonshot *unifies* them and moves the storage to the server, exploiting the xmin concurrency layer that's already shipped but barely used. It converts NIMBUS from single-user tool to team planning surface.

**Difficulty: M.**

---

### 6. Natural-language scheduling commands through the Command Palette (LLM-backed, grounded in the order schema)

**Value proposition.** The audit found the `CommandPalette` and its `need:`/`!` intent parser are the most mature intelligence modules, but the parser is keyword/regex. The moonshot: a planner types (or speaks) *"move all blue injection orders off line 7 next week and rebalance"* or *"why is line 3 overloaded Thursday?"* and NIMBUS parses it against the **real order schema** into a concrete, previewable action — answering the "why" with the causality data and executing the "move" through the Sandbox + solver, always with a confirm/preview step.

**What it would take.** A bounded LLM tool-calling layer: the model never touches the DB directly — it maps natural language to a *constrained set of existing Store/Engine actions* (filter orders by attribute, reassign line, run optimize-with-weights, jump-to). The order attributes (`COLOR`, `FORM_SIZE`, `PRODUCTION_LINE`, due dates) become the typed vocabulary. Route through a `POST /nl-command` endpoint that returns a structured action plan; the frontend renders it as a `OptimizerPreview`-style confirm card before anything mutates. Read-only "why" questions get answered from the lateness/risk/utilization data already computed. This is credible because the action space is small and typed — the LLM is a parser, not the executor.

**Why high-leverage now.** Cmd+K, the intent parser, the Sandbox-preview-confirm pattern, and (with #1) a real solver to execute against all exist. The LLM sits on top as a translation layer with a hard safety boundary (preview-before-commit), which is exactly the architecture that makes NL commands trustworthy rather than reckless. It's also the natural front door to every other moonshot.

**Difficulty: L** (the engineering is moderate; the discipline is keeping the LLM strictly in parse-and-propose, never execute-directly).

---

### Sequencing & dependency notes

- **#3 (learned changeover matrix) and #4 (risk model)** are the data foundation — they make #1's objective function *correct*, not just plausible. Build the data pipeline first; both are batch ML jobs over data NIMBUS already has.
- **#1 (CP-SAT solver)** is the centerpiece but should land *after* #3 so its changeover costs are real. It reuses #2's ripple-cost infrastructure for incremental re-solves.
- **#2 (ripple cost)** is the fastest standalone win and the biggest day-one trust improvement; it can ship before the solver.
- **#5 (scenario branches)** and **#6 (NL commands)** are the surface that makes the new brain usable by a team and approachable by a non-expert.
- Two audit-confirmed bugs are **prerequisites**, not optional: the worker's plant-scope cache-key collision (blocks correct #2/#4 visuals) and the Sandbox promote-not-dirty / promote-undo-asymmetry (blocks safe #5).

The throughline: NIMBUS already *collects* the right data and already has the *sockets* (constraint registry, OptimizerPreview, Compute worker, Sandbox, intent parser) — every moonshot here plugs a real decision-making capability into a socket that's already wired, rather than inventing new infrastructure.
