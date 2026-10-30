# Admin Cockpit Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Token efficiency (read this first):** read only the files your task names; do not grep repo-wide; do not run the whole suite. Run the named test files and the named build/lint commands only. The orchestrator runs the gates (`npm run test`, `npm run check:legacy-surface`, pytest) between waves. Append one line per task to the branch `progress.md` ledger. Do not touch files outside your task's list without a ledger note.

**Goal:** Replace the Admin Overview's four inner tabs with a one-screen Signal board, and give Logs, Diagnostics and Order Maintenance their own Admin sub-tabs, with one merged Logs timeline and a correlation context rail.

**Architecture:** Two new pure TypeScript modules (`signals.mts`, `unified-log.mts`) hold all severity and merge/filter/relatedness logic with no DOM or fetch; `admin-ui.mts` gains a two-tier (fast 30 s / slow 5 min) Overview refresh and thin renderers; a new `unified-log-pane.mts` owns the Logs sub-tab DOM. Backend adds one plant-wide read route and two join keys (`upload_audit.rid`, `rid`/`plant` on audit rows).

**Tech Stack:** TypeScript (`.mts` compiled in place to `.mjs`, gitignored), node:test, vanilla DOM, FastAPI + Postgres (psycopg), pytest, five locale files.

**Spec:** `docs/superpowers/specs/2026-10-30-admin-cockpit-redesign-design.md` (plan of record: `C:\Users\PJ29587\.claude\plans\i-want-to-re-do-kind-falcon.md`). Base `main` c70af07; worktree `.claude/worktrees/admin-cockpit`, branch `feature/admin-cockpit-overview`.

## Work packages

| Wave | Model | Files owned | Depends on |
|---|---|---|---|
| W0 | Sonnet | `frontend/admin-ops/signals.mts`, `frontend/admin-ops/unified-log.mts`, `frontend/locales/{en,de,es,fr,pt}.js` (new keys), `.gitignore`, `tests/modules/admin-ops/{signals,unified-log,overview-locales}.test.mjs` | none |
| W1 | Sonnet | `frontend/index.html` (Admin strip + panes), `frontend/admin-ops/admin-ui.mts` (sub-tab shell), `frontend/admin-ops/jobs-pane.mts` (`openRun`), `frontend/app.js` (2 lines), `frontend/styles.css` (1 rule), `tests/contracts/cq1-legacy-surface.json`, `tests/modules/admin-ops/admin-ui.test.mjs` | W0 |
| W2 | Sonnet | `frontend/admin-ops/admin-ui.mts` (Overview), `frontend/index.html` (`#admin-overview-pane` markup), `frontend/styles.css` (`.ov-*`, `.sig-*`, `.attn-*`), locales | W1 |
| W3 | Sonnet; Fable, design pass only (the one UX pass, then a Sonnet fix wave) | `frontend/admin-ops/unified-log-pane.mts` (new), `frontend/admin-ops/unified-log.mts` (`relatedTo`), `frontend/admin-ops/admin-ui.mts` (old log cards removed), `frontend/index.html`, `frontend/styles.css` (`.ulog-*`), locales | W2 |
| W4a | Sonnet | `backend/schedule_events/{routes,data}.py`, `backend/schedule_events/CLAUDE.md`, `tests/test_schedule_events.py`, `tests/test_rbac_plant_scoping.py` (only if it enumerates routes), `frontend/admin-ops/unified-log.mts` (`fromScheduleEvent` use) | W3 (frontend wiring); backend part independent |
| W4b | Sonnet | `migrations/2026-10-30-1-upload-audit-rid.sql`, `schema.sql`, `backend/integration/routes.py`, `backend/master_data/routes.py`, frontend audit writers, `docs/MIGRATION.md`, `tests/` (pytest) | W3 |
| W5 | Sonnet | `frontend/admin-ops/admin-ui.mts` (caps, Thread fold, strings), `frontend/index.html` (Thread card), locales, `frontend/admin-ops/CLAUDE.md`, `backend/admin_ops/CLAUDE.md`, root `CLAUDE.md` | W4b |

Never Opus. Every wave: one Sonnet implementer, then one Sonnet reviewer with fresh context (given the diff and this plan, not the implementer's summary). Waves merge to local `main` in order W0 to W5; nothing is pushed or deployed without the owner's say.

## Global Constraints

- Scale rule: Jobs runs, SAP reads and plant-wide schedule events are read for `Store.selectedPlant` (or the Logs plant filter) only; never fan out across plants; plant selection is a combobox, never chips.
- i18n: every new string via `data-i18n` or `Util.t()`; keys in all five of `frontend/locales/{en,de,es,fr,pt}.js` with identical `{{placeholders}}`.
- DESIGN.md: hairline borders over shadow; no side stripes (soft-tint row background only); warn text uses `--warn-text`; tokens only; Flatpickr for any date input.
- No inline handlers on new controls; fix buttons use `data-fix` + `data-args` and one delegated listener on `#ov-signals`.
- Server-supplied strings are rendered with `createElement` + `textContent`, never `innerHTML`.
- Pool rule: warn at 60 percent, err at 85 percent (same as Diagnostics); trust the server `needs_vacuum` flag (dead rows above 20 percent).
- THRESHOLDS: ping warn > 500 ms, err > 2000 ms; backend errors err >= 5, warn >= 1; backend warns warn >= 20; slowest query warn > 100 ms, err > 500 ms; long-running warn > 30 s; heap warn >= 80 %; browser error rate err > 10/min; stats stale after 10 min.
- Polling: fast tier 30 s; slow tier (`/diagnostics/db`, `/audit/log?limit=20`, `/upload/audit`) only on first load, force, or older than 5 min; 1 s "refreshed N s ago" ticker; Logs polls 30 s only while visible.
- Caps: Needs attention 8; Recent activity 10 rows; Database detail 8 tables; `mergeEntries` limit 500; Diagnostics `_dbTableCards` 10, `_dbHBarChart` 15, `_renderBackendWarnings` 20, `_lineBar` 15; schedule-events route limit 1-200, default 50.
- `_startHealthPolling` / `_stopHealthPolling` keep their names. `gotoOvTab` and `_activeOvTab` are deleted; `gotoSub(sub)` replaces them.
- Plant filter rule: when set, keep entries whose `plant` equals it OR is null; drop other-plant entries; empty source set means all sources.
- Logs filter persists in `localStorage` key `nimbus.ulog.filter` inside try/catch; Clear buttons keep ids `admin-backend-log-clear`, `admin-log-clear`, `admin-audit-log-clear`, `admin-audit-clear`.
- Migration `migrations/2026-10-30-1-upload-audit-rid.sql` is additive and idempotent; never `-AllowDestructive`; deploys apply `migrations/`, never `schema.sql`.
- Business terms only in docs; no SAP field codes. Business-copy and doc text in the repo avoids emojis.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Build after any `.mts` edit: `npm run build`. Single JS test: `node --test <file>`. Pytest needs `NIMBUS_TEST_DB=1` and a local `PG_HOST`.

## Review Focus

Five input classes the plan does not otherwise pin down and that most likely bite. The reviewer checks each by reading the code path, and the implementer adds a test where noted.

1. **A source endpoint returns 401/403 for a non-admin** (`/audit/log`, `/sap/*`, `/upload/audit`, `/logs/backend`): the signal must be `info` + `sig.admin_only` and the Logs source a notice chip, never `err`, never a toast, never a throw inside `Promise.allSettled` handling.
2. **A log entry with no timestamp or an unparseable one** (ErrorLog rows, job run with null `finished_at`): `tsMs` must be a number sentinel so `mergeEntries` puts it last without NaN comparisons, and relatedness windows must skip it.
3. **Plant filter set with every source unticked** (or with Backend and Browser unticked and no plant-tagged rows): empty set means all sources, so "every unticked" must not render an empty list by accident; UI state and `filterEntries` must agree. Also plant filter set and the schedule-events route 404.
4. **`/diagnostics/db` stale for more than 10 minutes, or never fetched**: Database and Connections reasons must say "stats from N min ago" and must not read missing slow-tier data as healthy; a Refresh after a failed slow tier must not wipe the last good table list.
5. **A job run with no `started_at`** (queued or skipped runs) in `fromJobRun`, the Jobs signal "longer than usual" check and Recent activity: no NaN durations, no "Invalid Date", sorted by `created_at` fallback.

---

## Wave W0: pure modules, tests, locale keys

### Task W0.1: signals.mts (pure signal model)

**Files:**
- Create: `frontend/admin-ops/signals.mts`
- Test: `tests/modules/admin-ops/signals.test.mjs`

**Interfaces:**
- Consumes: nothing (pure; inputs are plain objects shaped from `/health`, `/diagnostics/db`, `JobsClient` results, `Persistence.stats()`).
- Produces (exported from `signals.mts`):
  - `type Severity = 'err' | 'warn' | 'info' | 'ok'`; `SEVERITY_RANK`; `worstOf(...s)`
  - `type SignalId = 'jobs' | 'database' | 'backend' | 'data_load' | 'connections' | 'sap' | 'browser'`; `type AdminSub` (overview, logs, diagnostics, order-maintenance, jobs, manage, interface, security, system-config, table-browser)
  - `interface Fix { id: string; labelKey: string; args?: Record<string, unknown>; adminOnly?: boolean }` with ids `jobs.rerun`, `jobs.open_run`, `db.vacuum_all`, `db.vacuum_table`, `logs.open`, `data.reload`, `data.color_wheel`, `client.reset`, `nav.diagnostics`, `nav.interface`, `nav.order_maintenance`, `nav.jobs` (Jobs sub-tab)
  - `interface DetailTable { headKeys: string[]; rows: Array<Array<string | number | null>>; rowFixes?: Array<Fix | null>; linkKey?: string; linkSub?: AdminSub }` (data_load's first column holds `pipe.*` keys the pane translates)
  - `interface Signal { id: SignalId; severity: Severity; reasonKey: string; reasonArgs: Record<string, string | number>; fixes: Fix[]; detail: DetailTable | null; measuredAt?: number }` (`ago`/`next`/`measuredAt` are epoch ms, 0 = unknown; `next: 0` renders `sig.next_none`)
  - `interface AttentionItem { id: string; severity: Severity; textKey: string; args: Record<string, unknown>; fix: Fix }`
  - `interface SignalInputs` (flat: `now`, `health`/`healthErr`, `dbDeep`/`dbDeepErr`/`dbDeepAt`, `backendErrors`/`backendWarns`/`backendErr`, `jobs`/`jobsErr`, `sap`/`sapErr`, `client`, `uploadWarnings?`, `isAdmin`); a failed read is `null` plus the `*Err` string
  - `const FORBIDDEN = 'forbidden'`, `const NOT_FOUND = 'not_found'` (`sapErr === NOT_FOUND` gives `info` + `sig.sap_not_live`; `FORBIDDEN` or a non-admin gives `info` + `sig.admin_only`)
  - `const THRESHOLDS` (values per Global Constraints)
  - `function buildSignals(inputs: SignalInputs, thresholds?: Partial<typeof THRESHOLDS>): Signal[]`
  - `function buildAttention(signals: Signal[], inputs: SignalInputs): AttentionItem[]`

- [x] **Step 1: Write the failing test.** In `tests/modules/admin-ops/signals.test.mjs`, importing from `../../../frontend/admin-ops/signals.mjs`: all green gives seven `ok` signals in id order and empty attention; the severity ladder per subsystem (jobs, database, backend, data_load, connections, sap, browser) at each `THRESHOLDS` boundary; failed reads give `err` + `sig.unavailable`, `forbidden` / non-admin give `info` + `sig.admin_only`, `sapErr === NOT_FOUND` gives `sig.sap_not_live`; worst-first ordering with stable ties and a threshold override; `buildAttention` is worst-first, capped at 8, one item per cause; every emitted locale key exists in `en.js`; `data_load` never depends on the deep diagnostics read.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/signals.test.mjs` -> fails, module not found.
- [x] **Step 3: Implement** `signals.mts` with the exports above (no DOM, no fetch, no `Util`). Keep the pool rule 60/85 and trust `needs_vacuum`.
- [x] **Step 4: Run and expect pass.** `npm run build && node --test tests/modules/admin-ops/signals.test.mjs` (the en.js key test passes only after Task W0.3; run it last or temporarily expect that single failure and note it in the ledger).
- [x] **Step 5: Commit.** `git add frontend/admin-ops/signals.mts tests/modules/admin-ops/signals.test.mjs` then `git commit -m "feat(admin-ops): pure signal model (buildSignals, buildAttention)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W0.2: unified-log.mts (adapters, merge, filter, counts, relatedTo)

**Files:**
- Create: `frontend/admin-ops/unified-log.mts`
- Test: `tests/modules/admin-ops/unified-log.test.mjs`

**Interfaces:**
- Consumes: nothing (pure). Raw shapes: backend ring rows (`ctx`, `exc`, `rid`), ErrorLog entries (`reqId`), audit rows, upload audit rows, `JobRun`, schedule-event rows, SAP run rows.
- Produces:
  - `type LogSource = 'backend' | 'frontend' | 'audit' | 'upload' | 'jobs' | 'events' | 'sap'`; `type LogLevel = 'error' | 'warn' | 'info'`
  - `interface UnifiedEntry { key; ts: string | null; tsMs: number | null; source; level: LogLevel; user: string | null; plant: string | null; text; raw; rid?; errorCode?; actionId?; orderId?; runId? }`
  - `interface RelatedGroup { kind: 'request' | 'action' | 'order' | 'run' | 'user_window'; key: string; whyKey: string; possible: boolean; entries: UnifiedEntry[] }`
  - `interface LogFilter { level: 'all' | LogLevel; sources: Set<LogSource>; user: string; plant: string; q: string }` (all fields required; empty `sources` = all, `plant === ''` = no filter)
  - `fromBackend`, `fromFrontend`, `fromAudit`, `fromUpload`, `fromJobRun`, `fromSapRun`: `(raw) => UnifiedEntry`; `fromScheduleEvent(raw, plant)`
  - `mergeEntries(lists: UnifiedEntry[][], limit = 500): UnifiedEntry[]`
  - `filterEntries(entries, f: LogFilter)`, `sourceCounts(entries, f: LogFilter)` (ignores `f.sources` only), `relatedTo(entry, all, windowMs = 300000): RelatedGroup[]`
  - Local structural copies `BackendLogEntry`, `AdminAuditLogItem`, `AdminUploadAuditItem`, `LogEntry` (originals unexported). Cleanup for W5: export the originals and drop the copies.

- [x] **Step 1: Write the failing test.** In `tests/modules/admin-ops/unified-log.test.mjs`: each adapter (level mapping, `plant` null when absent, `fromFrontend` carries `rid` from `reqId`, upload warns only for non-`upload_counts` warnings, job `failed` is error and `warning` / `skipped` / `missed` are warn); `mergeEntries` newest first, missing ts last, stable ties, limit; `filterEntries` level ladder, empty `sources` = all, plant plus global, user exact case-insensitive, `q` over text / user / rid / errorCode; `sourceCounts` ignores only the sources filter; `relatedTo` group order, membership, `possible` flag on `user_window` only, excludes the entry itself, empty groups omitted, window honoured.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/unified-log.test.mjs` -> module not found.
- [x] **Step 3: Implement** `unified-log.mts` with the exports above. Pure; no `Util.t`, no DOM.
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add frontend/admin-ops/unified-log.mts tests/modules/admin-ops/unified-log.test.mjs` then `git commit -m "feat(admin-ops): pure unified-log module (adapters, merge, filter, relatedTo)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W0.3: locale keys, family-pin test, gitignore

**Files:**
- Modify: `frontend/locales/en.js`, `de.js`, `es.js`, `fr.js`, `pt.js` (append keys; find the insertion point by reading the file tail only)
- Modify: `.gitignore:85-90` (add `frontend/admin-ops/signals.mjs`, `frontend/admin-ops/unified-log.mjs`, later `frontend/admin-ops/unified-log-pane.mjs`, beside the existing `frontend/admin-ops/*.mjs` lines)
- Test: `tests/modules/admin-ops/overview-locales.test.mjs`

**Interfaces:**
- Consumes: key lists from W0.1 and W0.2 outputs.
- Produces: all new keys in the five locales: `tab.logs`, `tab.order_maintenance` (de `Auftragspflege`, es `Mantenimiento de pedidos`, fr `Maintenance des commandes`, pt `Manutenção de pedidos`); `ov.*` (title, refreshed_ago, auto_every, paused, signals, attention, attention_clear, recent, open_logs, details, details_hide, admin_only, measured_ago); `sig.*` (seven names, per-subsystem reasons, `sig.unavailable`, `sig.d_*`); `btn.pause`, `btn.resume`, `btn.rerun_now`, `btn.open_run`, `btn.vacuum_analyze`, `btn.vacuum`, `btn.view_logs`, `btn.open_color_wheel`, `btn.open_diagnostics`, `btn.open_interface`, `btn.open_history`, `btn.show_all_n`, `btn.show_fewer`, `sig.jobs_warning`, `sig.jobs_slow`, `sig.conn_long`, `sig.next_none`, `sig.sap_not_live`; `attn.*`; `ulog.*` (including `ulog.sources` "Sources", `ulog.sources_all` "All", `ulog.sources_none` "None", the seven `ulog.src_*` incl. `ulog.src_sap` "SAP", `ulog.plant_hint` "Global entries with no plant always show; untick Backend and Browser for a plant-only log", `ulog.events_for_plant` "Order changes shown for plant {{plant}}"); `ph.filter_plant` "All plants"; `ph.search_logs`. The hardcoded-string families (`pipe.*`, `thread.*`, `diag.col_*`, `ui.all_codes`, `diag.error_prefix`, `ph.filter_backend`, `ulog.older_dropped`, `ulog.filter_by_code`, `ulog.correlate`) are added in W5.3, not here.

- [x] **Step 1: Write the failing test** `overview-locales.test.mjs` (shape of `jobs-locales.test.mjs:8-28`, loading locales with `vm`):
  - `test('every ov, sig, attn, ulog key in en exists in de/es/fr/pt with same placeholders')`.
  - `test('tab.logs and tab.order_maintenance exist in all five locales')`.
  - `test('required button and placeholder keys exist')`: the `btn.*` and `ph.*` keys above.
  - `test('pinned English copy')`: `ulog.sources`, `ulog.sources_all`, `ulog.sources_none`, `ulog.src_sap`, `ulog.plant_hint`, `ulog.events_for_plant` equal the strings above.
  - `test('old tab keys absent')`: `tab.logs_audit` and `tab.data_operations` absent in all five (this test is added now but marked `{ todo: 'W1.3 removes the old keys' }` and the todo flag removed in Task W1.3).
- [x] **Step 2: Run and expect failure.** `node --test tests/modules/admin-ops/overview-locales.test.mjs` -> missing keys.
- [x] **Step 3: Implement** the keys in all five files (English first; translate the rest; watch French apostrophes) and the `.gitignore` lines.
- [x] **Step 4: Run and expect pass.** `node --test tests/modules/admin-ops/overview-locales.test.mjs tests/modules/admin-ops/signals.test.mjs` and `node --test tests/js/locale-keys.test.js tests/modules/locale-completeness.test.mjs` (the two named locale gates only).
- [x] **Step 5: Commit.** `git add frontend/locales/en.js frontend/locales/de.js frontend/locales/es.js frontend/locales/fr.js frontend/locales/pt.js .gitignore tests/modules/admin-ops/overview-locales.test.mjs` then `git commit -m "feat(admin-ops): locale keys for Overview, Logs, sub-tabs (5 locales)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

---

W1 reminder: flip the `old tab keys are still present` assertion in `tests/modules/admin-ops/overview-locales.test.mjs` (`tab.logs_audit` / `tab.data_operations`) to assert they are gone, in the same commit that removes the keys.

## Wave W1: sub-tab restructure

### Task W1.1: strip and four panes (content moved verbatim)

**Files:**
- Modify: `frontend/index.html:1872-1880` (strip: add `logs`, `diagnostics`, `order-maintenance`), `frontend/index.html:1882-2052` (the Overview pane: split into `#admin-overview-pane` (health bar temporarily kept), `#admin-logs-pane` (empty shell), `#admin-diag-pane` (client card host at 1934, Thread card 2133-2158 stays where W5 moves it, pipeline, backend warnings, DB deep dive), `#admin-order-maint-pane` (`#admin-upload`, `#admin-purge`, `#admin-audit` at 1984-2052)); remove the four inner `sub-subtab` buttons at 1888-1894.
- Test: `tests/modules/admin-ops/admin-ui.test.mjs` (later task)

**Interfaces:**
- Consumes: existing element ids.
- Produces: element ids `admin-overview-pane`, `admin-logs-pane`, `admin-diag-pane`, `admin-order-maint-pane`; strip buttons `data-sub="logs|diagnostics|order-maintenance"` with `data-i18n="tab.logs|tab.diagnostics|tab.order_maintenance"`.

- [x] **Step 1: Write the failing test** (appended to `admin-ui.test.mjs`): `test('every getElementById admin- id used by admin-ui.mts exists in index.html')`: read `frontend/admin-ops/admin-ui.mts` and `frontend/index.html` as text, extract static `getElementById('admin-...')` ids, assert each is present in the HTML as `id="..."` (lazily injected ids listed in an allowlist in the test). This is the grep the plan requires before W1 merges.
- [x] **Step 2: Run and expect failure** only if an id is orphaned by the move; before editing HTML it passes, so first move the markup then run. (State this in the ledger; the test guards the move.) `node --test tests/modules/admin-ops/admin-ui.test.mjs`.
- [x] **Step 3: Implement** the markup move (cut and paste verbatim; panes `hidden` except overview).
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add frontend/index.html tests/modules/admin-ops/admin-ui.test.mjs` then `git commit -m "refactor(admin): split Overview into Logs, Diagnostics, Order Maintenance panes (markup moved verbatim)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W1.2: _setSub dispatch, gotoSub, double-render fix, gated subscriptions

**Files:**
- Modify: `frontend/admin-ops/admin-ui.mts:461` (delete `_activeOvTab`), `:474-484` (delete `gotoOvTab`, add `gotoSub`), `:486-513` (`_setSub`), `:595-619` (subscriptions), `:622-625` (`render`), `:627-638` (`_renderOverview`)
- Test: `tests/modules/admin-ops/admin-ui.test.mjs:15-21` and new cases

**Interfaces:**
- Consumes: `JobsAdmin.setActive(false)` (existing), `UnifiedLogPane.render()` / `UnifiedLogPane.setActive(on: boolean)` (stub exported now from a minimal `unified-log-pane.mts`, filled in W3).
- Produces: `AdminCockpit.gotoSub(sub: string): void`; `_setSub(sub)` dispatch: overview -> `_renderOverview()`, logs -> `UnifiedLogPane.render()`, diagnostics -> `_renderDiagnostics(); _renderPipeline(); _renderDbDeep(); _refreshThreadPane()`, order-maintenance -> `_renderPurgeMeta(); _renderAudit()`; leaving overview -> `_stopHealthPolling()`; leaving logs -> `UnifiedLogPane.setActive(false)`; `render()` -> `_setSub('overview')` only.

- [x] **Step 1: Write the failing test** in `admin-ui.test.mjs`:
  - Change the surface test: `assert.equal(typeof AdminCockpit.gotoSub, 'function')` and `assert.equal(AdminCockpit.gotoOvTab, undefined)`; keep the `_startHealthPolling` / `_stopHealthPolling` / `_setSub` assertions.
  - `test('render() calls _setSub once and _renderOverview once')`: stub `_setSub` and `_renderOverview` counters on `AdminCockpit`; call `render()`; with the stub on `_setSub` only, assert `_renderOverview` is not called directly by `render()`; with a real `_setSub` over the fake DOM assert exactly one `_renderOverview`.
  - `test('_setSub("logs") stops the overview timer')`: start polling, `_setSub('logs')`, assert `_healthTimer === null`.
  - `test('_setSub dispatch per sub')`: spies prove diagnostics calls the four renderers and order-maintenance calls the two.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/admin-ui.test.mjs`.
- [x] **Step 3: Implement** the changes at the listed lines; subscriptions at 595-619 gate on `_activeSub` (ErrorLog -> logs pane refresh or overview `clientOnly` refresh; PerfMonitor -> diagnostics; Store `tasks:bulk` / `tasks:bulkUpdate` -> pipeline on diagnostics, `clientOnly` refresh on overview). Overview's old four-tab body is trimmed to what stays in the Overview pane until W2.
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add frontend/admin-ops/admin-ui.mts frontend/admin-ops/unified-log-pane.mts tests/modules/admin-ops/admin-ui.test.mjs` then `git commit -m "refactor(admin): gotoSub replaces gotoOvTab; _setSub dispatch; fix double Overview render" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W1.3: app.js callers, CSS rule, legacy contract, old locale keys

**Files:**
- Modify: `frontend/app.js:319`, `frontend/app.js:577` (`AdminCockpit.gotoOvTab('logs')` -> `AdminCockpit.gotoSub('logs')`); `frontend/styles.css:5067-5068` (drop `#admin-tab .admin-ov-tabs,` keep `.md-table-nav-row`); `tests/contracts/cq1-legacy-surface.json` (regenerate); `frontend/locales/*.js` (remove `tab.logs_audit`, `tab.data_operations`)
- Test: `tests/modules/admin-ops/overview-locales.test.mjs` (remove the todo flag), `npm run check:legacy-surface`

**Interfaces:**
- Consumes: `AdminCockpit.gotoSub`.
- Produces: contract with no `gotoOvTab` entries (`cq1-legacy-surface.json` lines 52-67 and 511 disappear).

- [x] **Step 1: Write the failing test:** remove `{ todo }` from `test('old tab keys absent')` so it asserts `tab.logs_audit` / `tab.data_operations` are gone; the legacy-surface check currently passes, so also add `test('no gotoOvTab anywhere in frontend')` reading `frontend/app.js` and `frontend/index.html` as text and asserting no match.
- [x] **Step 2: Run and expect failure.** `node --test tests/modules/admin-ops/overview-locales.test.mjs tests/modules/admin-ops/admin-ui.test.mjs`.
- [x] **Step 3: Implement** the edits, then `node scripts/legacy-surface.mjs --write` (shrink is accepted by the ratchet).
- [x] **Step 4: Run and expect pass.** `npm run build && node --test tests/modules/admin-ops/overview-locales.test.mjs tests/modules/admin-ops/admin-ui.test.mjs && npm run check:legacy-surface && node --test tests/js/locale-keys.test.js tests/modules/locale-completeness.test.mjs`.
- [x] **Step 5: Commit.** `git add frontend/app.js frontend/styles.css tests/contracts/cq1-legacy-surface.json frontend/locales/en.js frontend/locales/de.js frontend/locales/es.js frontend/locales/fr.js frontend/locales/pt.js tests/modules/admin-ops/overview-locales.test.mjs tests/modules/admin-ops/admin-ui.test.mjs` then `git commit -m "refactor(admin): route Logs entry points to gotoSub; drop inner-tab CSS, contract entries and keys" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W1.4: JobsAdmin.openRun

**Files:**
- Modify: `frontend/admin-ops/jobs-pane.mts:1175-1204` (add a member to the exported `JobsAdmin` object)
- Test: `tests/modules/admin-ops/jobs-pane.test.mjs` (append)

**Interfaces:**
- Consumes: existing `_setTab` and run-detail opener (`JobsRunDetail`) inside `jobs-pane.mts`.
- Produces: `JobsAdmin.openRun(runId: number): void` (switch to the Jobs runs tab and open that run's detail; safe when the pane is not rendered yet).

- [x] **Step 1: Write the failing test:** `test('JobsAdmin.openRun is a public function and selects the runs view')` asserting `typeof JobsAdmin.openRun === 'function'` and that calling it with a run id does not throw in the fake-DOM harness already used by that file.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/jobs-pane.test.mjs`.
- [x] **Step 3: Implement** `openRun(runId: number): void` beside `setActive`.
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add frontend/admin-ops/jobs-pane.mts tests/modules/admin-ops/jobs-pane.test.mjs` then `git commit -m "feat(jobs): public JobsAdmin.openRun(id)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

---

## Wave W2: Signal board

### Task W2.1: _fetchJson and the two-tier _refreshOverview

**Files:**
- Modify: `frontend/admin-ops/admin-ui.mts` (new members near `_renderOverview` at 627; replace the abort/timeout boilerplate copies, for example the health fetch around 662-664)
- Test: `tests/modules/admin-ops/admin-ui.test.mjs`

**Interfaces:**
- Consumes: `buildSignals`, `buildAttention` (W0.1); `JobsClient.summary`, `JobsClient.runs`; `Store.selectedPlant`.
- Produces:
  - `_fetchJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T>` (throws a typed error carrying `status`).
  - `_refreshOverview(o?: { force?: boolean; clientOnly?: boolean }): Promise<void>`; fields `_ovSeq: number`, `_ovAbort: AbortController | null`, `_ovPaused: boolean`, `_ovSlowAt: number`, `_ovInputs`.

- [x] **Step 1: Write the failing test:**
  - `test('stale overview response is discarded')`: two overlapping refreshes, resolve the first last; assert inputs reflect the second.
  - `test('rejected fetch yields sig.unavailable')`: stub `_fetchJson` to reject for `/health`; assert the Database signal is `err` with `reasonKey 'sig.unavailable'`.
  - `test('401 yields sig.admin_only not err')` (review focus 1).
  - `test('slow tier only on force or older than 5 min')`: count `/diagnostics/db` calls across two non-forced ticks (1 call), then force (2), then advance the clock past 5 min (3).
  - `test('clientOnly does not fetch')`.
  - `test('no plant: Jobs runs and SAP reads skipped')`.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/admin-ui.test.mjs`.
- [x] **Step 3: Implement** per the spec 4.9: one `Promise.allSettled` per tier with per-request timeouts; Jobs and SAP for `Store.selectedPlant` only; keep the last good slow-tier data on failure (review focus 4).
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add frontend/admin-ops/admin-ui.mts tests/modules/admin-ops/admin-ui.test.mjs` then `git commit -m "feat(admin): two-tier Overview refresh with _fetchJson and stale guard" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W2.2: polling, pause, refresh, ticker

**Files:**
- Modify: `frontend/admin-ops/admin-ui.mts:643-658` (`_startHealthPolling`, `_stopHealthPolling`); Overview head wiring in `init()`
- Test: `tests/modules/admin-ops/admin-ui.test.mjs`

**Interfaces:**
- Consumes: `_refreshOverview` (W2.1).
- Produces: `_startHealthPolling(): void` and `_stopHealthPolling(): void` (names unchanged) driving a 30 s tick and a 1 s ticker (`_ovTickTimer`); `_setPaused(on: boolean): void`; Refresh button handler calling `_refreshOverview({force:true})`; Store plant-change event triggers a refresh.

- [x] **Step 1: Write the failing test:** `test('start is idempotent and stop clears both timers')`; `test('pause skips the tick')` (fake timers: paused -> `_refreshOverview` not called; resumed -> called); `test('refresh forces both tiers')`; `test('leaving overview stops polling')` (already in W1.2; assert both timers).
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/admin-ui.test.mjs`.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add frontend/admin-ops/admin-ui.mts tests/modules/admin-ops/admin-ui.test.mjs` then `git commit -m "feat(admin): Overview 30 s polling with pause, refresh and refreshed-ago ticker" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W2.3: Signal board markup, CSS and renderers

**Files:**
- Modify: `frontend/index.html` (`#admin-overview-pane`: `.ov-head`, `.panel#ov-signals-card` > `.sig-board`, `.ov-grid` with Needs attention and Recent activity panels); `frontend/styles.css` (new `.ov-head`, `.sig-board`, `.sig-row`, `.sig-num`, `.sig-detail`, `.ov-grid`, `.attn-row`; place near the Admin section, not at EOF); `frontend/admin-ops/admin-ui.mts`
- Test: `tests/modules/admin-ops/admin-ui.test.mjs`

**Interfaces:**
- Consumes: `Signal[]`, `AttentionItem[]`, `mergeEntries`, `filterEntries` (W0), `Util.t`.
- Produces: `_renderSignals(signals: Signal[]): void`, `_renderAttention(items: AttentionItem[]): void`, `_renderRecent(): void`, `_renderOvHead(): void`; `_ovOpenDetail: string | null` preserved across repaints with focus; rows `.sig-row[data-sig][data-sev]` with `.sig-reason` (`overflow-wrap:anywhere`) and fix buttons carrying `data-fix` + `data-args`.

- [x] **Step 1: Write the failing test:** `test('_renderSignals builds seven rows via createElement with data-sig and data-sev')`; `test('server strings are set with textContent')` (a reason arg containing `<b>` appears as text, not markup); `test('open detail strip survives repaint')`; `test('_renderAttention empty shows nothing-needs-attention key')`; `test('_renderRecent shows at most 10 rows and applies this-plant-plus-global')` with fake entries; a CSS text test `test('severity rows use no border-left and warn text uses --warn-text')` reading `styles.css` for the `.sig-row` rules.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/admin-ui.test.mjs`.
- [x] **Step 3: Implement** markup, CSS (grid `14px minmax(140px,180px) 1fr auto auto`; narrow <= 720 px stack; `.ov-grid` one column <= 900 px; `.attn-row` 44 px) and renderers.
- [x] **Step 4: Run and expect pass.** Same command plus `npm run lint`.
- [x] **Step 5: Commit.** `git add frontend/index.html frontend/styles.css frontend/admin-ops/admin-ui.mts tests/modules/admin-ops/admin-ui.test.mjs` then `git commit -m "feat(admin): Signal board, Needs attention and Recent activity renderers and styles" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W2.4: fix dispatch and detail strips

**Files:**
- Modify: `frontend/admin-ops/admin-ui.mts` (delegated listener on `#ov-signals`, following the `[data-maint-action]` pattern at 559-569)
- Test: `tests/modules/admin-ops/admin-ui.test.mjs`

**Interfaces:**
- Consumes: `Fix` (W0.1), `JobsClient.restartRun`, `JobsAdmin.openRun` (W1.4), `_runMaintenance`, `_resetClientState`, `gotoSub`, `UnifiedLogPane.setFilter`.
- Produces: `_onSignalFix(fix: Fix): void` handling fix ids `rerun_now`, `open_run`, `vacuum_analyze`, `vacuum_table`, `view_logs`, `reload`, `open_color_wheel`, `reset_client`, `open_diagnostics`, `open_interface`; admin-only fixes disabled for non-admins.

- [x] **Step 1: Write the failing test:** `test('delegated click on [data-fix] calls _onSignalFix once with parsed args')`; `test('rerun_now asks for confirmation before restartRun')`; `test('vacuum_analyze calls _runMaintenance("vacuum-analyze", null, ...) after confirm')`; `test('view_logs calls gotoSub("logs") then UnifiedLogPane.setFilter')`; `test('admin-only fix is disabled and non-admin click does nothing')`.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/admin-ui.test.mjs`.
- **Ordering requirement (W1 review):** `JobsAdmin.openRun(id)` assumes the Jobs pane has rendered. `gotoSub('jobs')` starts `JobsAdmin.render()`, which is async (it awaits `JobsClient.types()` on first use, then calls `_setTab(_tab)`), so an `openRun` issued right after `gotoSub('jobs')` can be overwritten when `render` resumes. In `open_run`, call `AdminCockpit.gotoSub('jobs')`, then `await JobsAdmin.render()` (idempotent), then `JobsAdmin.openRun(id)`. Do not fix this inside `jobs-pane.mts`.
- **W1 settled decision:** the `#admin-tab .admin-ov-tabs` CSS rule in `styles.css` stays, because the Jobs pane's inner nav (`#admin-jobs-pane .admin-ov-tabs`) uses that class; the Step in W1.3 that drops it is superseded.
- **W1 finding (pre-existing, deferred):** `#admin-upload-detail` is read in the upload-success path but exists neither in `index.html` nor at runtime, so the distribution warning there is silently skipped.

- [x] **Step 3: Implement** `_onSignalFix` and detail strips (last 3 runs; tables by dead % desc cap 8 with per-row Vacuum; pipeline step counts with the existing deltas).
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add frontend/admin-ops/admin-ui.mts tests/modules/admin-ops/admin-ui.test.mjs` then `git commit -m "feat(admin): quick-fix dispatch and Details strips on the Signal board" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W2.5: delete _renderHealth and health bar; pipeline strings to i18n

**Files:**
- Modify: `frontend/admin-ops/admin-ui.mts:659-744` (delete `_renderHealth`; keep `_healthData` / `_dbDeep` caches used by `_exportDiagnostics` around 3008-3009), pipeline labels at 784-818 and 876 (to `Util.t('pipe.*')`); `frontend/index.html` (delete `#admin-health-bar`); locales (`pipe.*` keys)
- Test: `tests/modules/admin-ops/admin-ui.test.mjs`, `tests/modules/admin-ops/overview-locales.test.mjs`

**Interfaces:**
- Consumes: existing `_renderPipeline`.
- Produces: `pipe.*` family in all five locales; `_renderHealth` removed from the object.

- [x] **Step 1: Write the failing test:** `test('_renderHealth is gone and #admin-health-bar is absent')` (object key check and HTML text check); `test('_exportDiagnostics still includes cached health and deep data')`; locales: extend the family-pin test so every `pipe.*` key in en exists in the other four with equal placeholders and every `Util.t('pipe.` call in `admin-ui.mts` resolves.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/admin-ui.test.mjs tests/modules/admin-ops/overview-locales.test.mjs`.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run and expect pass.** Same command plus `node --test tests/js/locale-keys.test.js tests/modules/locale-completeness.test.mjs`.
- [x] **Step 5: Commit.** `git add frontend/admin-ops/admin-ui.mts frontend/index.html frontend/locales/en.js frontend/locales/de.js frontend/locales/es.js frontend/locales/fr.js frontend/locales/pt.js tests/modules/admin-ops/admin-ui.test.mjs tests/modules/admin-ops/overview-locales.test.mjs` then `git commit -m "refactor(admin): remove health bar; pipeline labels through i18n" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

---

## Wave W3: Logs sub-tab

### Task W3.1: pane fetch, filter bar, persistence, list

**Files:**
- Create: `frontend/admin-ops/unified-log-pane.mts`
- Modify: `frontend/index.html` (`#admin-logs-pane`: `.ulog-toolbar`, `fieldset.ulog-sources`, level select, user input, plant combobox, search input, `.ulog-split` with list and rail hosts), `frontend/styles.css` (`.ulog-*`), `frontend/admin-ops/admin-ui.mts` (import and `init()` hook)
- Test: `tests/modules/admin-ops/unified-log-pane.test.mjs` (new)

**Interfaces:**
- Consumes: `unified-log.mts` exports (W0.2), `JobsClient.runs`, `ErrorLog.entries()`, `AdminCockpit._fetchJson` (W2.1), `Store.selectedPlant`.
- Produces: `UnifiedLogPane = { init(): void; render(): Promise<void>; setActive(on: boolean): void; setFilter(f: Partial<LogFilter>): void; _state(): { entries: UnifiedEntry[]; filter: LogFilter; notices: string[] } }`.

- [x] **Step 1: Write the failing test** (fake DOM, stubbed fetch):
  - `test('render fetches six sources plus events for the selected plant only')`: assert URLs requested; no per-plant fan-out.
  - `test('a failed source becomes a notice chip, others still render')`; `test('401 on /audit/log is a notice, not an error')` (review focus 1).
  - `test('default plant filter is blank, never prefilled')`.
  - `test('filter persists to localStorage nimbus.ulog.filter and survives a throwing storage')` (try/catch).
  - `test('setFilter applies and re-renders; every source unticked behaves as all')` (review focus 3).
  - `test('render cap 500 with Show more')`.
  - `test('setActive(false) clears the 30 s poll')`.
  - `test('request-id chip sets q to the rid')`.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/unified-log-pane.test.mjs`.
- [x] **Step 3: Implement** the pane: `allSettled` over sources, `/schedule-events/{plant}/recent` hidden with `ulog.events_for_plant` note or a notice on 404, 250 ms debounce for text, Clear row reusing the four existing button ids, Export JSON and Copy filtered, expandable raw rows reusing `.admin-log-row` with `.ulog-src` badge.
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add frontend/admin-ops/unified-log-pane.mts frontend/index.html frontend/styles.css frontend/admin-ops/admin-ui.mts tests/modules/admin-ops/unified-log-pane.test.mjs` then `git commit -m "feat(admin): Logs sub-tab with merged timeline, source checkboxes and persisted filter" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W3.2: context rail

**Files:**
- Modify: `frontend/admin-ops/unified-log-pane.mts`, `frontend/styles.css` (`.ulog-split` list `1fr` / rail `360px` sticky, stack at <= 1000 px; `.is-selected`), `frontend/admin-ops/unified-log.mts` (only if `relatedTo` needs a field fix)
- Test: `tests/modules/admin-ops/unified-log-pane.test.mjs`

**Interfaces:**
- Consumes: `relatedTo(entry, all): RelatedGroup[]` (W0.2).
- Produces: `UnifiedLogPane.select(key: string | null): void`; rail DOM with one section per `RelatedGroup` (why-line, "Filter list to this" button, entries) and a footer `<pre>` plus Copy JSON.

- [x] **Step 1: Write the failing test:** `test('clicking a row or pressing Enter selects it and fills the rail')`; `test('rail groups render in order request, action, order, job_run, user_window')`; `test('possible label only on the user-window group')`; `test('Filter list to this applies the group filter')`; `test('selection survives the 30 s repaint by key')`; `test('rail shows empty-state text until a row is selected')`; `test('rail footer pre shows raw ctx/exc/changes via textContent')`.
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/unified-log-pane.test.mjs`.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add frontend/admin-ops/unified-log-pane.mts frontend/admin-ops/unified-log.mts frontend/styles.css tests/modules/admin-ops/unified-log-pane.test.mjs` then `git commit -m "feat(admin): Logs context rail (same request, action, order, job run, user window)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W3.3: remove the three old log cards

**Files:**
- Modify: `frontend/index.html` (the old Logs & Audit cards), `frontend/admin-ops/admin-ui.mts` (delete `_renderBackendLog`, `_renderLogs`, `_renderAuditLog`, `_correlateReqId`, `_renderReqIdChip` and the lazily injected filter inputs around 2236-2261 and 2468-2495; keep the per-source Clear handlers at 538-555 wired to the same four ids), `frontend/locales` (keys no longer used: none removed unless unreferenced)
- Test: `tests/modules/admin-ops/admin-ui.test.mjs`

**Interfaces:**
- Consumes: `UnifiedLogPane` (W3.1).
- Produces: removal only; the four Clear button ids resolve inside `#admin-logs-pane`.

- [x] **Step 1: Write the failing test:** `test('old log renderers are removed')` (keys absent on `AdminCockpit`); `test('the four Clear button ids exist exactly once in index.html')`; `test('no remaining reference to a removed element id')` (reuse the W1.1 id-vs-HTML check).
- [x] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/admin-ui.test.mjs`.
- [x] **Step 3: Implement the removals.**
- [x] **Step 4: Run and expect pass.** Same command plus `npm run lint && npm run typecheck`.
- [x] **Step 5: Commit.** `git add frontend/index.html frontend/admin-ops/admin-ui.mts tests/modules/admin-ops/admin-ui.test.mjs` then `git commit -m "refactor(admin): remove the three old log cards superseded by the Logs sub-tab" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W3.4: Fable design pass + Sonnet fix wave

**Files:**
- Modify (by the Sonnet fix wave only, from the punch list): `frontend/styles.css`, `frontend/index.html`, copy keys in `frontend/locales/*.js`, `frontend/admin-ops/admin-ui.mts` / `unified-log-pane.mts` only for spacing/markup tweaks

**Interfaces:**
- Consumes: the live app in Chrome (`uvicorn brain:api --port 8000`), `DESIGN.md`, the two mockups (Overview A https://claude.ai/artifact/RKbwrhVxf2GDp4vdtxTLFD; Logs 2 https://claude.ai/artifact/8yX26a3ECo8YDptPDVGJjA), the fit-to-measure list from the plan of record.
- Produces: a short punch list (not code) from the Fable agent; then one Sonnet fix wave applying it.

- [ ] **Step 1: Fable design pass (one pass, no code).** A Fable agent, "Fable, design pass only", reviews Overview and Logs on the live app: spacing, hierarchy, dark mode, narrow widths (375 / 640 / 1024 / 1440), reason-line and attention-sentence copy, the fit-to-measure list (10-label strip; source checkboxes at 640 px; `.sig-name` column with fr `Chargement des données` and de `SAP-Schnittstelle`; fix buttons on one row with de `Jetzt erneut ausführen` and fr `Ouvrir la roue des couleurs`; Jobs reason with a long job name at 375 px; `ov.refreshed_ago` + `ov.auto_every` beside two buttons at 375 px; Logs filter bar at 640 px; attention sentence + button in fr). Returns the punch list.
- [ ] **Step 2: Write a failing test per mechanical item** where one is testable (for example a CSS text assertion that a rule exists); copy and spacing items are verified visually and logged.
- [ ] **Step 3: Sonnet fix wave** applies the punch list, nothing else.
- [ ] **Step 4: Run** `npm run build && npm run lint && node --test tests/modules/admin-ops/admin-ui.test.mjs tests/modules/admin-ops/unified-log-pane.test.mjs tests/modules/admin-ops/overview-locales.test.mjs`; expect pass.
- [ ] **Step 5: Commit.** `git add frontend/styles.css frontend/index.html frontend/locales/en.js frontend/locales/de.js frontend/locales/es.js frontend/locales/fr.js frontend/locales/pt.js` (plus any `.mts` the punch list touched, named explicitly) then `git commit -m "style(admin): design pass fixes for Overview and Logs" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

---

## Wave W4a: plant-wide schedule-events route

### Task W4a.1: route, data function and pytest

**Files:**
- Modify: `backend/schedule_events/routes.py` (after the per-order route, lines 14-28 are the guard pattern), `backend/schedule_events/data.py` (add `_RECENT_SQL` after `_LIST_SQL` at 117-121 and `list_plant_events`)
- Test: `tests/test_schedule_events.py`; `tests/test_rbac_plant_scoping.py` only if it enumerates scoped routes (read its route list before editing)

**Interfaces:**
- Consumes: `auth.require_authenticated`, `auth.get_allowed_plants_for_request`, `md._assert_plant_allowed`, `_row_to_wire`.
- Produces:
  - `GET /schedule-events/{plant}/recent` with `limit: int = Query(50, ge=1, le=200)`, `before_id: int | None = Query(None, ge=1, le=9223372036854775807)`, `since: str | None`; `Cache-Control: no-store`; 403 plant not allowed, 400 invalid plant.
  - `data.list_plant_events(plant: str, *, limit: int, before_id: int | None, since: str | None) -> dict` (rows with `fields`, not full `changes`; next-page cursor from the `limit+1` fetch).
  - `_RECENT_SQL`: filtered by plant, `ORDER BY e.at DESC, e.id DESC`, `LIMIT` param.

- [x] **Step 1: Write the failing tests** in `tests/test_schedule_events.py`:
  - `test_recent_sql_shape`: `_RECENT_SQL` contains `e.plant = %s`, `ORDER BY e.at DESC, e.id DESC` and `LIMIT`; does not select the full `e.changes` as a wire field.
  - `@pytest.mark.pg test_list_plant_events_newest_first`: insert three events, assert order.
  - `@pytest.mark.pg test_list_plant_events_since_and_before_id`: `since` cuts older rows; `before_id` pages.
  - `@pytest.mark.pg test_list_plant_events_rows_carry_fields_not_changes`.
  - No-DB TestClient (pattern `tests/test_logs_endpoints.py:23-48`): `test_recent_route_403_when_plant_not_allowed`, `test_recent_route_400_invalid_plant`, `test_recent_route_422_for_limit_0_and_201`, `test_recent_route_sets_no_store`.
- [x] **Step 2: Run and expect failure.** `python -m pytest tests/test_schedule_events.py -q -k "recent or plant_events"` (with `NIMBUS_TEST_DB=1` and a local `PG_HOST` for the pg tests).
- [x] **Step 3: Implement** the route and data function; add the route to `tests/test_rbac_plant_scoping.py` only if that file enumerates scoped routes.
- [x] **Step 4: Run and expect pass.** Same command.
- [x] **Step 5: Commit.** `git add backend/schedule_events/routes.py backend/schedule_events/data.py tests/test_schedule_events.py` (plus `tests/test_rbac_plant_scoping.py` if changed) then `git commit -m "feat(schedule-events): plant-wide recent route GET /schedule-events/{plant}/recent" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W4a.2: Logs adapter wiring and contract note

**Files:**
- Modify: `frontend/admin-ops/unified-log-pane.mts` (events fetch uses the real route; 404 hides the source with a notice), `backend/schedule_events/CLAUDE.md` (add one contract line for the route)
- Test: `tests/modules/admin-ops/unified-log-pane.test.mjs`

**Interfaces:**
- Consumes: `fromScheduleEvent` (W0.2), the route (W4a.1).
- Produces: `events` source active in the Logs pane; `ulog.events_for_plant` note shown with the plant name.

- [ ] **Step 1: Write the failing test:** `test('events source fetches /schedule-events/{plant}/recent for the filter plant, else the selected plant')`; `test('404 hides the Order changes source with a notice')`; `test('rows carry action_id for the Same action group')`.
- [ ] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/unified-log-pane.test.mjs`.
- [x] **Step 3: Implement** and add the CLAUDE.md contract line. (W4a review 2026-10-30: wiring already present from W3; `fromScheduleEvent` / `RecentScheduleEvent` fields match the route wire shape one-to-one, `at` is ISO with offset; pane tests not run in this review.)
- [ ] **Step 4: Run and expect pass.** Same command.
- [ ] **Step 5: Commit.** `git add frontend/admin-ops/unified-log-pane.mts backend/schedule_events/CLAUDE.md tests/modules/admin-ops/unified-log-pane.test.mjs` then `git commit -m "feat(admin): Logs reads plant-wide schedule events; document route contract" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

---

## Wave W4b: exact join keys

### Task W4b.1: upload_audit.rid migration, upload stamp, read field

**Files:**
- Create: `migrations/2026-10-30-1-upload-audit-rid.sql`
- Modify: `schema.sql:270-278` (mirror the column), `backend/integration/routes.py:46` (upload route stamps the request contextvar id), `backend/integration/routes.py:250` (`GET /upload/audit` returns `rid`), the audit insert in `db.py` or the integration data layer (locate via the `upload_audit` INSERT; read only that function)
- Test: a new `tests/test_upload_audit_rid.py` (or an addition to the existing upload audit test file, found by name only)

**Interfaces:**
- Consumes: the request id contextvar from `backend/admin_ops/logbuffer.py:45-87`.
- Produces: column `upload_audit.rid TEXT NULL` (and `user` only if absent); `GET /upload/audit` rows include `rid`.

- [ ] **Step 1: Write the failing test:** `test_migration_is_additive_and_idempotent` (file text contains `ADD COLUMN IF NOT EXISTS rid` and no `DROP`/`ALTER ... TYPE`); `test_schema_sql_mirrors_rid_column`; `@pytest.mark.pg test_upload_stamps_request_id_and_audit_returns_it` (post an upload with `x-request-id: abc123`, then `GET /upload/audit` first row has `rid == 'abc123'`); `test_audit_row_without_rid_returns_null` (old rows).
- [ ] **Step 2: Run and expect failure.** `python -m pytest tests/test_upload_audit_rid.py -q`.
- [ ] **Step 3: Implement** migration, `schema.sql` mirror, route stamp and read field.
- [ ] **Step 4: Run and expect pass.** Same command.
- [ ] **Step 5: Commit.** `git add migrations/2026-10-30-1-upload-audit-rid.sql schema.sql backend/integration/routes.py tests/test_upload_audit_rid.py` (plus the data-layer file the INSERT lives in, named explicitly) then `git commit -m "feat(upload): stamp request id on upload_audit (additive migration)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W4b.2: rid and plant on audit-log rows

**Files:**
- Modify: `backend/master_data/routes.py:98-125` (`append_audit_log` stamps `rid`; `get_audit_log` returns new fields as stored), the frontend audit writers (the `POST /audit/log` callers: find by `'/audit/log'` in `frontend/`, e.g. the optimization audit writer) to pass `plant: Store.selectedPlant`
- Test: `tests/` (pytest for the route) and `tests/modules/` (frontend writer)

**Interfaces:**
- Consumes: request id contextvar.
- Produces: audit entries carrying `rid` (server-stamped, `setdefault` semantics so a caller cannot forge over an existing server value is not required; server value wins) and `plant` (caller-supplied).

- [ ] **Step 1: Write the failing test:** `test_post_audit_log_stamps_rid` (TestClient with `x-request-id`, then read back through the audit path with a temp audit file); `test_post_audit_log_keeps_caller_plant`; `test_get_audit_log_returns_rid_and_plant`; frontend: `test('audit writers pass plant from Store.selectedPlant')`.
- [ ] **Step 2: Run and expect failure.** `python -m pytest tests -q -k "audit_log and (rid or plant)"` and `node --test <the frontend writer test file>`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and expect pass.** Same commands.
- [ ] **Step 5: Commit.** `git add backend/master_data/routes.py` plus the exact frontend writer files and tests changed, then `git commit -m "feat(audit): stamp rid and plant on audit-log rows" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W4b.3: adapters carry rid/plant; deploy note

**Files:**
- Modify: `frontend/admin-ops/unified-log.mts` (`fromUpload`, `fromAudit` read `rid` / `plant`), `docs/MIGRATION.md` (deploy note: additive migration applies before the image, no `-AllowDestructive`)
- Test: `tests/modules/admin-ops/unified-log.test.mjs`

**Interfaces:**
- Consumes: new fields from W4b.1 and W4b.2.
- Produces: `fromUpload(raw).rid`, `fromAudit(raw).rid` and `.plant`; `relatedTo` places an upload and its backend rows in "Same request", not "possible".

- [ ] **Step 1: Write the failing test:** `test('fromUpload and fromAudit carry rid and plant')`; `test('an upload with rid groups with its backend rows under request, not user_window')`; `test('rows without rid still appear in the user window as possible')`.
- [ ] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/unified-log.test.mjs`.
- [ ] **Step 3: Implement** adapter fields and the MIGRATION.md note.
- [ ] **Step 4: Run and expect pass.** Same command.
- [ ] **Step 5: Commit.** `git add frontend/admin-ops/unified-log.mts docs/MIGRATION.md tests/modules/admin-ops/unified-log.test.mjs` then `git commit -m "feat(admin): upload and audit rows join by request id; deploy note" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

---

## Wave W5: Diagnostics caps, Thread fold, strings, docs

### Task W5.1: caps with _capList

**Files:**
- Modify: `frontend/admin-ops/admin-ui.mts` (`_dbTableCards`, `_dbHBarChart`, `_renderBackendWarnings` around 1220-1271, `_lineBar`; helpers within `_renderDbDeep` 1648-2216); locales (`btn.show_all_n`, `btn.show_fewer` already added in W0.3)
- Test: `tests/modules/admin-ops/admin-ui.test.mjs`

**Interfaces:**
- Consumes: `Util.t('btn.show_all_n', {n})`, `Util.t('btn.show_fewer')`.
- Produces: `_capList<T>(items: T[], cap: number, render: (visible: T[]) => void, host: HTMLElement): void` (toggle button appears only when `items.length > cap`); caps: `_dbTableCards` 10, `_dbHBarChart` 15, `_renderBackendWarnings` 20, `_lineBar` 15 machines.

- [ ] **Step 1: Write the failing test:** `test('_capList shows only cap items and a Show all button when over cap')`; `test('no button at or under the cap')`; `test('Show all expands and Show fewer collapses')`; per-list tests that feed 30 tables, 30 bars, 40 warnings and 40 machines and count rendered rows (10, 15, 20, 15).
- [ ] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/admin-ui.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and expect pass.** Same command.
- [ ] **Step 5: Commit.** `git add frontend/admin-ops/admin-ui.mts tests/modules/admin-ops/admin-ui.test.mjs` then `git commit -m "feat(admin): cap Diagnostics lists with Show all / Show fewer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W5.2: Thread fold-in and i18n

**Files:**
- Modify: `frontend/index.html` (Thread card at 2133-2158 moved directly under the client card in `#admin-diag-pane`, converted to `data-i18n`), `frontend/admin-ops/admin-ui.mts:2861-2891` (`_refreshThreadPane` strings via `Util.t('thread.*')`), locales (`thread.*`)
- Test: `tests/modules/admin-ops/admin-ui.test.mjs`, `tests/modules/admin-ops/overview-locales.test.mjs`

**Interfaces:**
- Consumes: existing `_refreshThreadPane`, `PerfMonitor`.
- Produces: `thread.*` family in all five locales; Thread card inside Diagnostics as a Client section; `admin-thread-clear` id unchanged.

- [ ] **Step 1: Write the failing test:** `test('thread card sits inside #admin-diag-pane directly after the client card')` (HTML order check); `test('thread card text uses data-i18n, no hardcoded English')`; locales family pin for `thread.*`; `test('_refreshThreadPane uses Util.t for its labels')`.
- [ ] **Step 2: Run and expect failure.** `npm run build && node --test tests/modules/admin-ops/admin-ui.test.mjs tests/modules/admin-ops/overview-locales.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and expect pass.** Same command plus the two locale gate tests.
- [ ] **Step 5: Commit.** `git add frontend/index.html frontend/admin-ops/admin-ui.mts frontend/locales/en.js frontend/locales/de.js frontend/locales/es.js frontend/locales/fr.js frontend/locales/pt.js tests/modules/admin-ops/admin-ui.test.mjs tests/modules/admin-ops/overview-locales.test.mjs` then `git commit -m "feat(admin): fold Thread profiler into Diagnostics Client section; i18n" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W5.3: remaining hardcoded strings

**Files:**
- Modify: `frontend/admin-ops/admin-ui.mts` (Connections headers around 1780 -> `diag.col_*`; `ui.all_codes` ~2487; `diag.error_prefix` ~1833; `ph.filter_backend` ~2242; `ulog.older_dropped` ~2291 and ~2514; `ulog.filter_by_code` ~2339 and ~2568; `ulog.correlate` ~2352 and ~2581: some of these sit in code removed in W3.3, so only convert what survives); locales
- Test: `tests/modules/admin-ops/overview-locales.test.mjs`

**Interfaces:**
- Consumes: surviving call sites after W3.3.
- Produces: keys `diag.col_*`, `ui.all_codes`, `diag.error_prefix`, `ph.filter_backend`, `ulog.older_dropped`, `ulog.filter_by_code`, `ulog.correlate` in all five locales (only those still referenced; unreferenced ones are not added).

- [ ] **Step 1: Write the failing test:** `test('every static Util.t key in admin-ops sources resolves in en.js')` (scan `admin-ui.mts`, `unified-log-pane.mts`, `signals.mts`); `test('diag.col_* keys exist in all five locales with equal placeholders')`.
- [ ] **Step 2: Run and expect failure.** `node --test tests/modules/admin-ops/overview-locales.test.mjs`.
- [ ] **Step 3: Implement** the conversions and keys.
- [ ] **Step 4: Run and expect pass.** Same command plus `node --test tests/js/locale-keys.test.js tests/modules/locale-completeness.test.mjs`.
- [ ] **Step 5: Commit.** `git add frontend/admin-ops/admin-ui.mts frontend/locales/en.js frontend/locales/de.js frontend/locales/es.js frontend/locales/fr.js frontend/locales/pt.js tests/modules/admin-ops/overview-locales.test.mjs` then `git commit -m "refactor(admin): route remaining hardcoded Admin strings through i18n" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task W5.4: docs

**Files:**
- Modify: `frontend/admin-ops/CLAUDE.md` (replace the "Logs tab" section with "Admin sub-tabs 2026-10-30": strip order, `gotoSub`, two-tier refresh, THRESHOLDS table, caps, fit-to-measure list), `backend/admin_ops/CLAUDE.md` (Overview polling cadence: fast 30 s, slow 5 min, `/diagnostics/db` ring write note), `CLAUDE.md` (root: Admin Ops row and Schedule Events row mention the plant-wide recent read and join keys)
- Test: none (docs); verification is a read-back diff

**Interfaces:**
- Consumes: the shipped behaviour of W0 to W5.3 and the spec.
- Produces: updated docs; no code.

- [ ] **Step 1: Write the check.** A short shell check listing that each of the three files mentions `gotoSub`, `nimbus.ulog.filter` (frontend doc), `/schedule-events/{plant}/recent` (root and schedule-events docs) and `upload_audit.rid`; expect it to fail before the edit: `grep -c "gotoSub" frontend/admin-ops/CLAUDE.md` returns 0.
- [ ] **Step 2: Run and expect failure.** The grep above prints 0.
- [ ] **Step 3: Implement** the doc edits (business terms only, no SAP field codes, no emojis).
- [ ] **Step 4: Run and expect pass.** `grep -c "gotoSub" frontend/admin-ops/CLAUDE.md` is at least 1; `grep -c "recent" CLAUDE.md` finds the Schedule Events mention.
- [ ] **Step 5: Commit.** `git add frontend/admin-ops/CLAUDE.md backend/admin_ops/CLAUDE.md CLAUDE.md` then `git commit -m "docs(admin): Admin sub-tabs 2026-10-30, polling cadence, domain table rows" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

---

## Self-review (completed)

- **Spec coverage:** sub-tab list (W1.1, W1.2), Signal board rows and thresholds (W0.1, Global Constraints), Needs attention and Recent activity (W2.3), Logs timeline + rail with source group and plant-plus-global rule (W0.2, W3.1, W3.2), two join keys (W4b), Diagnostics caps (W5.1), Order Maintenance rename (W0.3 keys, W1.1 markup), polling tiers (W2.1, W2.2), plant-wide route contract (W4a), i18n families (W0.3, W2.5, W5.2, W5.3), legacy contract and CSS removal (W1.3), docs (W5.4).
- **Names consistent with the spec:** `buildSignals`, `buildAttention`, `THRESHOLDS`, `mergeEntries`, `filterEntries`, `sourceCounts`, `relatedTo`, `UnifiedLogPane.setFilter` / `setActive` / `render`, `gotoSub`, `_refreshOverview`, `_fetchJson`, `_onSignalFix`, `_capList`, `JobsAdmin.openRun`, `list_plant_events`, `_RECENT_SQL`, ids `#ov-signals`, `#admin-logs-pane`, `#admin-diag-pane`, `#admin-order-maint-pane`, localStorage key `nimbus.ulog.filter`.
- **Open for the builder (logged in the spec, section 5):** signal id strings, `SignalInputs` / `AttentionItem` field shapes, copy wording, fix id strings used in `_onSignalFix`.
