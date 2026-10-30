# Admin Cockpit redesign: Signal-board Overview, Logs, Diagnostics, Order Maintenance (design)

> **Status (2026-10-30): design settled, nothing built.** Base `main` c70af07, branch `feature/admin-cockpit-overview`, worktree `.claude/worktrees/admin-cockpit`. Governing plan of record: `C:\Users\PJ29587\.claude\plans\i-want-to-re-do-kind-falcon.md`; implementation plan: `docs/superpowers/plans/2026-10-30-admin-cockpit-redesign.md`. Owner decisions in this document are settled; do not re-ask.

## 1. Intent and why

The Admin tab's Overview sub-tab is a container for four inner tabs (Diagnostics, Data Operations, Logs & Audit, Thread). An admin who opens it wants one answer: is the system healthy, and if not, what do I do about it. Today the answer is spread over a long scrolling column, three log lists, and a task area (upload, purge) that is not status at all. The redesign turns Overview into a one-screen **Signal board**, gives Logs its own sub-tab with one merged timeline, and moves the deep and task content to their own sub-tabs unchanged.

Confirmed in code on 2026-10-30:

- Diagnostics scrolls: health chips, a client key-value card, the data pipeline, backend warnings and an uncapped database deep dive stack in one column (`frontend/index.html:1898-1977`; `_dbTableCards` and `_dbHBarChart` have no row cap).
- Thread (the main-thread profiler) is a fourth inner tab, hardcoded English, unrelated to the rest.
- Logs & Audit is three stacked lists with three filter bars; upload history lives elsewhere; job runs and schedule events are not there at all, so nothing can be correlated.
- Data Operations (upload, purge, upload history) is a task area, not status.
- The same fact is shown in three places: database pool in a health chip, a deep-dive tile and a fill bar; order totals and color misses likewise.
- Every Overview fetch runs twice (see Appendix B), and all nine fetches also run for hidden inner tabs.

## 2. Goals, non-goals, anti-goals

**Goals**
- Overview fits one screen at 1440x900 and 1024x768: seven subsystem rows, "Needs attention", "Recent activity".
- Every red or amber light carries a one-line reason and, where an action exists, a quick-fix button next to it.
- Logs is one time-ordered merged timeline over seven sources with one filter bar and a context rail that shows related entries grouped by the key that links them.
- Each fact appears once on Overview. Deep content stays reachable (Details strip, "Open Diagnostics").
- A failed fetch is visible (`err` plus "unavailable"), never a silent green.

**Non-goals**
- No change to what Diagnostics, Order Maintenance, Jobs, Manage, Interface, Security, System Configuration or Table Browser contain, except the caps and the Thread fold-in listed below.
- No System Configuration wiring for thresholds (constants with an override argument now; wiring is a later wave).
- No server-side merged log endpoint. No cross-plant fan-out of any read.
- No change to the existing per-source Clear endpoints.

**Anti-goals**
- An Overview that scrolls. If the seven rows plus the two panels do not fit, content is cut or moved to Details, not scrolled.
- Duplicated facts: the same number or state must not be rendered in two Overview places, and Overview and Diagnostics must apply the same pool rule.
- A plant filter that hides global errors. Setting a plant must keep entries that carry no plant (see 4.4).
- Silent staleness: slow-tier data older than 10 minutes says so in the reason.

## 3. Constraints

- **Scale rule (root CLAUDE.md).** 50+ plants, 70+ machines per plant. Plant selection is a searchable combobox, never chips. Jobs runs, SAP reads and plant-wide schedule events are read for one plant only. No read fans out across plants. Lists are capped (see Diagnostics caps).
- **i18n rule.** Every new string goes through `data-i18n` or `Util.t()`, with keys in all five locale files (`frontend/locales/{en,de,es,fr,pt}.js`). Dynamic key families are invisible to `tests/js/locale-keys.test.js`, so a family-pin test covers them. Watch French apostrophes.
- **DESIGN.md rules.** Hairline borders over shadow; no side stripes (a severity row uses a soft-tint background, not a colored left border); warn text uses `--warn-text`; tokens only (nothing extra needed for dark mode); dates use Flatpickr where a date input exists.
- **Never fetch all plants.** No endpoint call enumerates plants to aggregate.
- **No inline handlers** for new controls; sub-tab buttons are wired by the existing click loop; fix buttons use one delegated listener.
- **No `innerHTML` for server strings.** Rows are built with `createElement` and `textContent`.
- **Names pinned elsewhere:** `_startHealthPolling` / `_stopHealthPolling` keep their names (Appendix B).

## 4. Decisions as decided

### 4.1 Sub-tab list

Strip (`frontend/index.html:1872-1880`), every entry `button.admin-subtab[data-sub]`:

| data-sub | i18n | Pane |
|---|---|---|
| overview | `tab.overview` | `#admin-overview-pane` (new markup) |
| logs | `tab.logs` (new) | `#admin-logs-pane` (new) |
| diagnostics | `tab.diagnostics` | `#admin-diag-pane` (moved content) |
| order-maintenance | `tab.order_maintenance` (new) | `#admin-order-maint-pane` (moved content) |
| jobs, manage, interface, security, system-config, table-browser | existing | unchanged |

`gotoOvTab` and `_activeOvTab` are deleted. A public `gotoSub(sub)` replaces them for the two `app.js` callers (ErrorLog badge click and Ctrl+Alt+L, both become `gotoSub('logs')`). The `_setSub` dispatch is: overview renders the Signal board; logs calls `UnifiedLogPane.render()`; diagnostics renders the client card, pipeline, DB deep dive and thread pane; order-maintenance renders purge meta and upload history. Leaving overview calls `_stopHealthPolling()`; leaving logs calls `UnifiedLogPane.setActive(false)`. `render()` becomes just `_setSub('overview')`.

### 4.2 Signal board (Overview)

Pure module `frontend/admin-ops/signals.mts`: `buildSignals(inputs, thresholds?) -> Signal[]` always returns seven, sorted worst-first, stable id order on ties. `Severity = err | warn | info | ok`. A failed fetch yields `err` plus `sig.unavailable`; a 401 or 403 yields `info` plus `sig.admin_only`. Thresholds are constants in `THRESHOLDS` with an override argument. The 60 percent warn and 85 percent error pool rule stays so Overview and Diagnostics never disagree; the server's `needs_vacuum` flag (dead rows above 20 percent) is trusted, not re-derived.

| Signal | Inputs | err | warn | Fixes / Detail |
|---|---|---|---|---|
| Jobs | `JobsClient.summary(plant)`, `runs({status:'failed', sinceHours:24, limit:1})`, `runs({limit:3})` | failed_24h > 0, scheduler stale, fetch failed | missed/warning > 0, maintenance on, longer-than-usual | Re-run now (admin, confirm, `restartRun`), Open run (new public `JobsAdmin.openRun(id)`). Detail: last 3 runs |
| Database | `/health` db, `/diagnostics/db` table stats (slow tier) | not connected, ping > 2000 ms | ping > 500 ms, any `needs_vacuum`, stats older than 10 min (reason gets "stats from N min ago") | Vacuum + analyze (existing `_runMaintenance('vacuum-analyze', null)` + confirm). Detail: tables by dead % desc, cap 8, per-row Vacuum |
| Backend | `/logs/backend?level=error&since=<1h>&limit=5` and `level=warn` (the `total` field gives the count) | errors >= 5, unreachable | errors >= 1, warns >= 20 | View in Logs (preset filter). Detail: latest 5 err + 5 warn |
| Data load | `/health` total_orders, `Persistence.stats()` (no `/diagnostics/deep` call: full `orders` scans) | rendered < received, connected but 0 orders | color misses > 0, source cache/demo | Reload, Open color wheel. Detail: pipeline step counts with the deltas the pipeline already computes |
| Connections | `/health` pool (fast), `/diagnostics/db` sessions/locks/slow (slow) | pool >= 85 %, lock waits, slowest > 500 ms | pool >= 60 %, waiting > 0, long-running > 30 s, slowest > 100 ms | Detail: link to Diagnostics |
| SAP interface | `GET /sap/staging/send/{plant}/status`, `/sap/staging/batches?plant&limit=20`, `/sap/interface/runs?limit=1` (admin and plant-scoped) | send errors > 0 | pending ready/validated/held batches | `info` when no plant selected, non-admin, or 404. "Last pull" is usually "never" (pull connectors are stubs). Detail: link to Interface |
| This browser | `Persistence.stats()`, storage inventory, ErrorLog counts, `performance.memory` | autosave disabled, error rate > 10/min | storage degraded, heap >= 80 %, session errors > 0 | Reset client (`_resetClientState`). Detail: link to Diagnostics > Client |

Rendering: `.sig-board` of `.sig-row[data-sig][data-sev]`, grid `14px minmax(140px,180px) 1fr auto auto` (dot, name, reason, fixes, Details). Err and warn rows get a soft-tint background; warn text uses `--warn-text`; narrow (<= 720 px) reason and fixes drop under the name; `overflow-wrap:anywhere` on `.sig-reason`. The inline Details strip is a `.sig-detail[hidden]{display:none}` pair; the open strip and focus survive repaints (`_ovOpenDetail`). Non-admins with page access see `info` / "Admin only" rows and disabled admin fixes, not toasts.

### 4.3 Needs attention and Recent activity

`buildAttention(signals, inputs) -> AttentionItem[]`, capped at 8, worst-first sentences, each with a button. Candidates: failed job, scheduler stale, backend errors, vacuum tables, lock waits, color misses, render gap, SAP errors or held batches, autosave off, distribution warnings in the last upload (`/upload/audit[0]`, slow tier). Empty shows "Nothing needs attention". Rows are `.attn-row`, 44 px like `.am-row`.

Recent activity shows 10 rows via `mergeEntries` plus `filterEntries({plant: Store.selectedPlant})` over fast-tier backend entries, `ErrorLog.entries().slice(-20)`, the three job runs and cached audit and upload rows. It therefore uses the same "this plant plus global" rule as the Logs tab. "Open Logs" calls `gotoSub('logs')`.

Layout: `.ov-head`, a `.panel#ov-signals-card` holding the board, then `.ov-grid` with the two panels side by side (one column at <= 900 px).

### 4.4 Logs: timeline plus context rail

Merged **client-side** from existing endpoints. Reasons: the frontend ErrorLog ring only exists in the browser; the server sources have four different auth postures; every source already has a bounded newest-first read; Clear stays per source anyway. Cost is 5 to 6 requests of at most 200 rows, polled every 30 s only while the Logs sub-tab is visible.

Pure modules `unified-log.mts` and `unified-log-pane.mts`:

- `LogSource = backend | frontend | audit | upload | jobs | events | sap`.
- `UnifiedEntry {key, ts, tsMs, source, level, user, plant: string | null, text, raw, rid?, errorCode?}`.
- Adapters `fromBackend` (plant from `ctx.plant`, else null), `fromFrontend` (plant from the entry, else null), `fromAudit`, `fromUpload`, `fromJobRun`, `fromScheduleEvent`, `fromSapRun` (level by run status, plant from the run).
- `mergeEntries(lists, limit = 500)`: descending by ts, stable tiebreak, missing ts last.
- `filterEntries(entries, {level, sources, user, plant, q})`:
  - `level`: error is a subset of warn is a subset of all.
  - `sources: Set<LogSource>`, multi-select; an empty set means all. Rendered as a checkbox group (`fieldset.ulog-sources`) with live counts per source; counts come from the level/user/plant/q-filtered set so they say what each box would add. All / None links.
  - `plant: '' | string`. Empty means no plant filter (default: the tab opens as a system-wide log). When set, keep entries whose `plant === plant` **or whose `plant` is null** (global entries: backend rows without a plant context, browser rows without one, scheduler heartbeat); entries carrying a different plant drop. Unticking Backend and Browser with a plant set therefore yields a pure plant log with no extra mode.
  - `user` exact, case-insensitive; `q` over text, user, rid, errorCode.
- `sourceCounts(entries, filterWithoutSources) -> Record<LogSource, number>`.
- `relatedTo(entry, all) -> RelatedGroup[]`.

Pane: fetches `/logs/backend?limit=200`, `ErrorLog.entries()`, `/audit/log?limit=200`, `/upload/audit`, `JobsClient.runs({plant: plantFilter || Store.selectedPlant, limit:50})`, `/sap/interface/runs?limit=50` (admin) and `/schedule-events/{plant}/recent` for the plant filter or, when none is set, the selected plant, with a "showing order changes for plant X" note. Uses `allSettled`; a failed source becomes a notice chip. Filter bar: level select, source checkbox group with counts, user, plant combobox over the viewer's plants (blank by default, never prefilled), free text (250 ms debounce, client-side). Filter state persists per viewer in `localStorage` key `nimbus.ulog.filter` (try/catch). Toolbar: Refresh, a "Clear:" row reusing the four existing per-source buttons and ids (`admin-backend-log-clear`, `admin-log-clear`, `admin-audit-log-clear`, `admin-audit-clear`) so `init()` wiring is unchanged, Export JSON, Copy filtered. Rows reuse `.admin-log-row` with a `.ulog-src` badge and expandable raw `ctx` / `exc`; a clickable request-id chip sets `q = rid` (replaces `_correlateReqId` / `_renderReqIdChip`). Render cap 500 plus "Show more". "View in Logs" and "Open Logs" call `gotoSub('logs')` then `UnifiedLogPane.setFilter(...)`.

**Context rail (owner's pick, mockup 2).** `.ulog-split`: list `1fr`, rail `360px` sticky; the rail stacks under the list at <= 1000 px. Clicking a row (or Enter) marks it `.is-selected` and renders the rail from `relatedTo`, groups in this order, each with a "why related" line and a "Filter list to this" button:

1. **Same request** (`rid`): browser http row and backend ring rows.
2. **Same action** (`action_id`): schedule events of one save / ingest / optimizer run / sweep and the job step that produced them.
3. **Same order** (order id parsed from backend `ctx`, audit details, schedule events).
4. **Same job run** (`run_id` on job rows and on job-sourced backend entries where `ctx.run_id` exists).
5. **Same user within +/- 5 min**, labelled "possible, joined by time". Job runs with no request id also land here.

Rail footer: raw record `<pre>` (`ctx` / `exc` / `changes`) for the selected row and Copy JSON. Selection survives the 30 s repaint by `key`. Empty-state text until a row is selected.

### 4.5 The two join keys (W4b, backend, small)

- `upload_audit.rid text NULL` (and `user` if absent): the upload route stores the request contextvar id; `GET /upload/audit` returns it. Migration `migrations/2026-10-30-1-upload-audit-rid.sql`, additive and idempotent (`ADD COLUMN IF NOT EXISTS`), mirrored in `schema.sql`. Deploys apply the migration before the image that reads it rolls; no `-AllowDestructive`.
- `POST /audit/log` (free-form dict): the server stamps `rid`; the caller adds `plant`; the frontend audit writers pass `plant: Store.selectedPlant`. No migration (file/JSON rows); `GET /audit/log` returns the new fields.

After these, `fromUpload` and `fromAudit` carry `rid` and `plant`, and the "possible" label applies only to the user-window group.

### 4.6 Plant-wide schedule-events route (W4a, backend)

Contract: `GET /schedule-events/{plant}/recent?limit=50&before_id=&since=` in `backend/schedule_events/routes.py`.

- Guards identical to the per-order route: `require_authenticated`, plant scope (403 not allowed, 400 invalid), `Cache-Control: no-store`.
- `limit` 1-200 (default 50), `before_id` >= 1 (bigint range), `since` an ISO timestamp.
- `data.list_plant_events(plant, *, limit, before_id, since)` with a `_RECENT_SQL` derived from `_LIST_SQL`, filtered by plant, `ORDER BY e.at DESC, e.id DESC`, `LIMIT limit+1`, using `idx_schedule_event_plant_at`.
- Response rows carry `fields` (the keys of `changes`), not the full diff. No migration.
- The Logs pane hides the "Order changes" source with a notice when the route returns 404, so W3 ships without W4a.

### 4.7 Diagnostics caps and fold-ins

Diagnostics holds the deep content unchanged: client card host `#admin-diagnostics-pane`, the Thread profiler folded in as a Client section directly under the client card (markup converted to `data-i18n`), `#admin-pipeline-card`, `#admin-bwarn-card`, `#admin-db-deep-card`. A `_capList` helper with `btn.show_all_n` / `btn.show_fewer` (`btn.show_all` already exists as a calendar string) caps the previously uncapped lists:

| List | Cap |
|---|---|
| `_dbTableCards` | 10 |
| `_dbHBarChart` | 15 |
| `_renderBackendWarnings` | 20 |
| `_lineBar` machines | 15 |

### 4.8 Order Maintenance rename

"Data Operations" becomes **Order Maintenance** (`tab.order_maintenance`; de `Auftragspflege`, es `Mantenimiento de pedidos`, fr `Maintenance des commandes`, pt `Manutenção de pedidos`). `#admin-upload`, `#admin-purge` and `#admin-audit` move verbatim into `#admin-order-maint-pane`; renderers unchanged. Every `getElementById('admin-...')` in `admin-ui.mts` is checked against the moved markup before W1 merges.

### 4.9 Polling tiers

- **Fast tier** (every 30 s while Overview is visible): `/health`, two `/logs/backend` reads, three Jobs reads, three SAP reads (plant selected and admin only).
- **Slow tier** (`/diagnostics/db`, `/audit/log?limit=20`, `/upload/audit`): only on first load, Refresh (force), or when older than 5 min. Reason: `/diagnostics/db` runs 8 catalog queries and writes an `info` ring entry per call, so it must not run every 30 s.
- `_refreshOverview({force?, clientOnly?})` uses an `_ovSeq` stale guard and `_ovAbort`, one `Promise.allSettled` per tier, per-request timeouts. `clientOnly` repaints from browser state without fetching.
- A 1 s ticker shows "refreshed N s ago"; Pause toggles `_ovPaused`; Refresh forces both tiers. Re-run on the Store plant-change event. Nothing is fetched for hidden sub-tabs; polling stops when leaving Overview and on Pause.
- One `_fetchJson<T>(url, timeoutMs, signal)` helper replaces the seven copies of abort/timeout boilerplate.
- `_renderHealth` and `#admin-health-bar` are deleted; `_healthData` and `_dbDeep` stay cached so `_exportDiagnostics` keeps working.

### 4.10 Why merge client-side

See 4.4. In one line: the browser ring cannot be merged server-side, the server sources differ in auth, and the bounded reads are cheap. A future server-side merge is possible without changing the pure module's contract.

## 5. What is left to the builder

- Settled by W0 (see `frontend/admin-ops/signals.mts` and `unified-log.mts`; these are now fixed names, not suggestions):
  - `SignalId`: `jobs`, `database`, `backend`, `data_load` (underscore), `connections`, `sap`, `browser`. `AdminSub`: `overview`, `logs`, `diagnostics`, `order-maintenance`, `jobs`, `manage`, `interface`, `security`, `system-config`, `table-browser`.
  - Fix ids dispatched by the pane: `jobs.rerun`, `jobs.open_run`, `db.vacuum_all`, `db.vacuum_table`, `logs.open`, `data.reload`, `data.color_wheel`, `client.reset`, `nav.diagnostics`, `nav.interface`, `nav.order_maintenance`, `nav.jobs` (switches to the Jobs sub-tab; used for scheduler-stale, missed, warning, slow and maintenance rows).
  - Constants `FORBIDDEN` (`'forbidden'`, a 401/403 on a read) and `NOT_FOUND` (`'not_found'`, a 404 on the SAP read). A `*Err` equal to `FORBIDDEN`, or a non-admin viewer on an admin-only source, gives `info` + `sig.admin_only`; `sapErr === NOT_FOUND` gives `info` + `sig.sap_not_live`; any other failed read gives `err` + `sig.unavailable`.
  - `reasonArgs.ago`, `reasonArgs.next` and `Signal.measuredAt` are epoch milliseconds; 0 means unknown or never. The pane formats them; `next: 0` renders `sig.next_none`.
  - The data_load detail table's first column holds `pipe.*` locale keys that the pane translates; other detail cells are raw values (ISO strings, numbers).
  - Extra keys beyond the first list: `sig.jobs_warning`, `sig.jobs_slow`, `sig.conn_long`, `sig.next_none`, `sig.sap_not_live`; the counted "show all" key is `btn.show_all_n`.
  - `BackendLogEntry`, `AdminAuditLogItem`, `AdminUploadAuditItem` and `LogEntry` in `unified-log.mts` are local structural copies because the originals are not exported. Cleanup for W5: export the originals and drop the copies.
  - `SignalInputs`, `AttentionItem` (`{id, severity, textKey, args, fix}`) and `RelatedGroup` (`kind` is `request | action | order | run | user_window`) are as exported.
- Wording of reason lines and attention sentences (English first; the Fable design pass tunes copy).
- Translations beyond the proposed `tab.order_maintenance` values.
- Concrete `THRESHOLDS` constant names, as long as the values match the table.
- Whether to drop the `info` ring write in `/diagnostics/db` (check `tests/test_api_admin_ops_coverage.py:252` first); optional.
- The "stale scheduler" definition (use whatever `JobsClient.summary` already exposes).
- The exact `fields` derivation for schedule-event rows beyond "keys of `changes`".

## 6. Mockups

- Overview: mockup A, https://claude.ai/artifact/RKbwrhVxf2GDp4vdtxTLFD
- Logs: mockup 2 (Timeline + context rail), https://claude.ai/artifact/8yX26a3ECo8YDptPDVGJjA

## Appendix A: Context

The request came from the owner's use of the Admin tab. Four complaints: Diagnostics scrolls too far to find anything; logs are hidden behind two levels of inner tabs and split into three separate lists; the name "Data Operations" does not say what it holds (it is where orders are uploaded and purged); and the same facts (pool usage, order totals, color misses) appear in several places. Three Overview mockups were prepared and the owner picked mockup A (Signal board: one row per subsystem with a light, one-line reason and quick fix, plus Needs attention and Recent activity). For Logs, three correlation layouts were compared and the owner picked mockup 2, Timeline + context rail. The owner also settled: Logs and Diagnostics become their own sub-tabs, Thread folds into Diagnostics, Data Operations becomes Order Maintenance, and quick fixes sit next to the red light.

## Appendix B: Things learned along the way

- `AdminCockpit.render()` (`frontend/admin-ops/admin-ui.mts:622-625`) calls `_setSub('overview')`, whose `else` branch already calls `_renderOverview()`, and then calls `_renderOverview()` again. Every Overview fetch therefore runs twice; the fix is `render()` calling only `_setSub('overview')`.
- `GET /diagnostics/db` writes an `info` ring entry on every call (`backend/admin_ops/routes.py:254`) and runs 8 catalog queries. It was designed "on demand, not polled", hence the slow tier.
- `GET /diagnostics/deep` performs full `orders` scans; the Data load signal must not call it.
- `needs_vacuum` is server-defined (`db.py:2659`, dead rows above 20 percent). The client trusts it.
- Pool thresholds already exist at 60 and 85 percent (`admin-ui.mts` around 719 and 1943); Overview reuses them.
- Correlation keys that exist: browser `reqId` (`frontend/platform/foundation.mts:90`) sent as `x-request-id` (`:712`) and recorded by the backend as `rid` (`backend/admin_ops/logbuffer.py:45-87`; `GET /logs/backend?rid=` already filters); schedule-event `action_id` (`backend/schedule_events/data.py`); `job_step_run.action_id` (`backend/jobs/data.py`). Keys that do not exist today: `/audit/log` rows carry no `rid` or `plant`; `upload_audit` has no `rid` column. W4b adds both.
- Only a per-order schedule-events read exists (`/schedule-events/{plant}/order/{order_id}`); the plant-wide read is new in W4a.
- `_startHealthPolling` / `_stopHealthPolling` keep their names: the shell calls them (`frontend/shell/application-shell.mts:2450, 2452, 2689`) and `tests/modules/admin-ops/admin-ui.test.mjs` pins them.
- `app.js` lives at `frontend/app.js` (callers at lines 319 and 577), not the repo root.
- Existing migration files already include `2026-11-01-*` names; the new `2026-10-30-1` file sorts before them. The ledger applies by recorded name, but the builder confirms the ledger mechanism does not require monotonic dates (see the `promote-azure` skill).
