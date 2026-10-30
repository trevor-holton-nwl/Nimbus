# Admin Diagnostics redesign: jump-rail sections + exact-section deep links (design)

Branch `feature/admin-diagnostics-rail` (forked from main 00d512c), worktree `.claude/worktrees/admin-diagnostics`. Plan of record: `C:\Users\PJ29587\.claude\plans\i-want-to-re-do-kind-falcon.md`. Implementation plan: `docs/superpowers/plans/2026-10-30-admin-diagnostics.md`.

## 1. Intent and why

The Admin Cockpit redesign (merged to local main 2b7c573, not deployed) left the Diagnostics sub-tab as five stacked cards moved verbatim: Client diagnostics, Data pipeline, Backend warnings, Database deep dive (a five-tile summary strip plus eight `<details>` sections) and the Main thread profiler. The owner asked to optimize the tab for simplicity and to have the Overview details hyperlink to the note on the associated page.

Problems confirmed in code (`frontend/admin-ops/admin-ui.mts`, `frontend/index.html:1984-2056`):

- No section has an id, so no Overview link can land on one. The `nav.*` fixes (ui:1140-1143) and the Details-strip `data-nav` buttons (ui:981-988, 585-586) only call `gotoSub(sub)`: nothing scrolls, opens or focuses.
- One fact is painted three ways with three thresholds (pool: tile 85 %, section waiting/errors only, bar 60/85, Overview signal 60/85).
- Backend warnings are listed twice (standalone card and inside the Emitted pipeline step).
- Three per-card Refresh buttons for one page.
- `logs.open` ignores `fix.args.level`.
- Hardcoded English strings remain in the Database deep dive.

## 2. Goals

1. One scrolling Diagnostics page of collapsible sections; every section header carries a light and its own one-line state.
2. A sticky jump rail lists every section with a light and a short figure.
3. Every Overview link (Details-strip buttons, "Needs attention" buttons, `nav.*` fixes) lands on the exact section, opened, scrolled into view, flashed once and focused.
4. One threshold per fact, sourced from `THRESHOLDS` in `signals.mts`.
5. One page-head Refresh plus Export bundle.
6. Close the hardcoded-string gaps and the `logs.open` level bug while the code is open.

## 3. Non-goals

- No per-figure links inside the Overview Details strip (owner declined): figures stay plain text.
- No backend change, no pytest, no migration: `/diagnostics/db` and `/diagnostics/deep` payloads are unchanged.
- No change to the Overview, Logs, Jobs or Order Maintenance layouts beyond receiving anchors.
- No new polling tiers; the existing 30 s refresh drives repaints.

## 4. Anti-goals

- No side stripes (DESIGN section 6); hairline borders, soft tint on hover only.
- No bubble or chip selectors for sections beyond the under-1000 px chip row of the same rail links.
- No fabricated "ok" when data is missing: unavailable input is `info`, never silent ok.
- No re-declared thresholds anywhere outside `signals.mts`.
- Unused indexes never warn (advice, not a fault).

## 5. Constraints

- All new text via `data-i18n` / `Util.t()`, keys in all five `frontend/locales/{en,de,es,fr,pt}.js` with identical `{{placeholders}}`; fr apostrophes escaped as in `fr.js`.
- Tokens only in CSS; dark mode must work; server strings rendered via `textContent`.
- No inline handlers on new controls (`npm run check:legacy-surface` must stay green).
- Keep existing ids used by code and `init()` wiring: `admin-diagnostics-pane`, `admin-pipeline`, `admin-pipeline-detail`, `admin-backend-warnings`, `admin-bwarn-count`, `admin-db-deep`, `admin-perf-tbody`, `admin-thread-clear`, `admin-diag-storage`, `admin-diag-export`, `admin-diag-reset`, `admin-diag-refresh`. Remove `admin-pipeline-refresh` and `admin-db-deep-refresh`.
- `gotoSub(sub)` keeps its name (pinned by `admin-ui.test.mjs` and the two `app.js` callers, which pass no opts).
- Caps stay: tables 10, indexes 15, warnings 20; slow queries gain a cap of 10 via the existing `_capList`.
- Scale rule: nothing here fans out across plants; Diagnostics stays per-plant-selection as today.
- Compiled `.mjs` twins are gitignored; add the `.gitignore` twin for `diag-sections.mjs`.

## 6. Decisions as decided (owner, 2026-10-30; do not re-ask)

1. **Layout A, Jump rail** (mockup A, https://claude.ai/artifact/GFPmDv2a5yQRN2G7PuFMhD): one scrolling page of collapsible sections; sticky left rail with light + short figure per section; Database is one section holding eight sub-sections; under 1000 px the rail becomes a chip row above the sections.
2. **Deep links land on the exact section**: open the target and its `<details>` ancestors, scroll into view, flash once, move keyboard focus.
3. **Duplicates removed**: the five-tile DB summary strip (facts move into section headers); the warnings list inside the Emitted step (becomes a count + link to Backend warnings); the three per-card Refresh buttons (one head Refresh + Export bundle). One pool threshold everywhere: `THRESHOLDS.poolWarnPct` 60 / `poolErrPct` 85.
4. Caps stay; slow queries cap 10.

### 6.1 Target structure (`#admin-diag-pane`)

```
.diag-head      h2 Diagnostics · #admin-diag-ts "DB stats 2 min ago · pipeline 11 s ago" · [Refresh #admin-diag-refresh] [Export bundle #admin-diag-export]
.diag-layout    grid 220px 1fr (gap 20px); <=1000 px: 1fr, rail becomes a wrapping chip row
  nav.diag-rail sticky; a.diag-rail-link[href="#diag-..."][data-anchor] per section: .dot + title + .diag-rail-short (mono figure);
                "Database" is a caption with its eight sub-links indented; scroll-spy sets .is-on
  .diag-main    sections in this order:
    details.diag-sec#diag-client   Client           line: build, heap %, autosave, errors/min     acts: Storage (#admin-diag-storage), Reset client (#admin-diag-reset)
    details.diag-sec#diag-pipe     Data pipeline     line: N loaded > N plant > N rendered, N misses   body: #admin-pipeline + #admin-pipeline-detail
    details.diag-sec#diag-bwarn    Backend warnings  title count; line "from the last data load"       body: #admin-backend-warnings (cap 20)
    details.diag-sec#diag-db       Database          line: pool %, N tables need vacuum, N over 30 s, stats N min ago
        eight details.diag-sec.diag-sub: #diag-db-pool #diag-db-server #diag-db-tables #diag-db-conn #diag-db-locks #diag-db-idx #diag-db-slow #diag-db-seq
    details.diag-sec#diag-thread   Main thread       line: P95 N ms, slowest <op> N ms   acts: Clear (#admin-thread-clear)   body: existing table
```

Section header grid: `auto minmax(120px,200px) 1fr auto auto` = dot, title (+ mono count), one-line state, actions, chevron; at 760 px and below the line and actions drop under the title (same pattern as `.sig-row`). `[data-sev=warn] .diag-title` uses `--warn-text`; `[data-sev=err]` uses `--err`. `.diag-sec.is-target` = 2 px accent outline + `--accent-wash` halo fading over 2.4 s (`@keyframes diag-flash`); `.diag-sub.is-target > summary` tints the summary row instead. `prefers-reduced-motion`: no animation, outline only, `scrollIntoView` with `behavior:'auto'`.

### 6.2 Open/closed rule

First paint: a section is open when its severity is warn/err or it is the pending deep-link target; otherwise closed. Repaints (30 s Store/Perf-driven refreshes, Refresh button) keep the user's open state per id: `_diagOpen: Map<string, boolean>` recorded by one delegated `toggle` listener on `#admin-diag-pane` (capture phase, since `toggle` does not bubble). `mkSection` gains `(id, titleKey, count, severity, lineKey, lineArgs, bodyHTML, actionsHTML?)` and consults `_diagOpen` first, the severity rule second.

### 6.3 Thresholds source

All from `THRESHOLDS` in `frontend/admin-ops/signals.mts`, imported, never re-declared: pool 60/85 % + waiting > 0 = warn; connections `longQueryWarnS` 30; slow queries `slowQueryWarnMs` 100 / `slowQueryErrMs` 500; heap `heapWarnPct` 80; browser errors `errRateErrPerMin` 10 (err), > 0 (warn); tables: any `needs_vacuum` = warn; locks: any wait = err; indexes: unused > 0 = info (never warn); sequences: > 80 % warn, > 95 % err; stats age `dbStatsStaleMs` 10 min = warn on the Database line; thread: any op P95 >= 50 ms err, >= 16 ms warn (matches the existing cell colouring).

### 6.4 Pure module

`frontend/admin-ops/diag-sections.mts` (new, no DOM, no fetch): `buildDiagSections(inputs, thresholds = THRESHOLDS): DiagSection[]` (always 13, page order), `defaultOpen(sec, pendingAnchor): boolean`, `ANCHOR_IDS: Record<DiagSectionId, string>` (`'db-conn'` to `'diag-db-conn'`). Missing input (`dbDeep` null because the fetch failed or 403) gives `severity:'info'` with `lineKey:'diag.line_unavailable'` (or `sig.admin_only`), never a silent ok. `Severity` and `THRESHOLDS` come from `./signals.mjs`. Exact types are in the implementation plan.

### 6.5 Deep links

- `gotoSub(sub: string, opts?: { anchor?: string })`; `_setSub(sub, anchor?)` stores `_pendingAnchor = anchor ?? null`, calls the pane renderer, then `_revealPendingAnchor()`. A new `_setSub` clears any stale pending anchor.
- `_revealPendingAnchor()` is a no-op when `_pendingAnchor` is null or the element is not in the DOM yet; otherwise `_revealAnchor(el)` then clear. Every pane renderer that paints late calls it after painting: `_renderDbDeep` (after `/diagnostics/db` returns), `_renderPipeline`, `_renderDiagnosticsPane`, the `JobsAdmin` hook (builder decides whether needed); Interface and Order Maintenance static panes reveal immediately.
- `_revealAnchor(el)`: open `el` and every `<details>` ancestor; `scrollIntoView({ block:'start', behavior: reducedMotion ? 'auto' : 'smooth' })`; add `.is-target`, remove on `animationend` (fallback timer 2.6 s); focus the `<summary>` (or the element with `tabindex="-1"`) with `preventScroll:true`.
- Fix dispatch: `nav.jobs|diagnostics|interface|order_maintenance` call `gotoSub(sub, { anchor: fix.args?.anchor })`. Details-strip link buttons gain `data-anchor` from a new `DetailTable.linkAnchor?: string`; `onOvClick` forwards it. Attention items reuse `Fix.args.anchor`.
- `logs.open` honours `fix.args.level` and `fix.args.source`: `UnifiedLogPane.setFilter({ level: args.level ?? 'warn', sources: new Set([args.source ?? 'backend']) })`.

### 6.6 Anchor map (`signals.mts`; every `nav.*` fix and detail link gets one)

| Emitter | Anchor |
|---|---|
| `sig.db_offline` | `diag-db` |
| `sig.db_slow` | `diag-db-server` |
| `sig.db_vacuum` detail link, Database detail `btn.open_diagnostics` | `diag-db-tables` |
| `sig.conn_locks`, attention `locks` | `diag-db-locks` |
| `sig.conn_pool`, `sig.conn_waiting` | `diag-db-pool` |
| `sig.conn_long`, Connections detail link | `diag-db-conn` |
| `sig.conn_slow` | `diag-db-slow` |
| Browser (all), Browser detail link | `diag-client` |
| Data load: new secondary fix `nav.diagnostics` (`btn.open_diagnostics`) on `data_gap`/`data_none`/`data_misses`/`data_cached`, and a new detail link | `diag-pipe` |
| `sig.sap_errors`, `sig.sap_pending`, attention `sap_*`, SAP detail link | `sap:staging` |
| attention `distribution` (`nav.order_maintenance`) | `admin-audit` (upload history card, `index.html:2121`) |
| `sig.jobs_failed`, `jobs_missed`, `jobs_warning`, `jobs_slow`, attention `job_failed` (when `nav.jobs`) | `jobs:runs` |
| `sig.jobs_scheduler_stale`, `sig.jobs_maint`, attention `scheduler_stale` | `jobs:jobs` |

### 6.7 Anchor grammar

`anchor` is either a DOM id (`diag-db-conn`, `admin-audit`) or `<pane>:<innerTab>` for the two panes with their own inner views. `_revealPendingAnchor` resolves the second form by calling the pane's inner-tab switcher, then reveals that inner pane's element:

- `jobs:<tab>`: after `await JobsAdmin.render()` (async, `jobs-pane.mts:1178`), call the switcher. `_setTab(tab)` (`jobs-pane.mts:1047`) is already exposed on the exported object as a test seam (`:1196`); add a public `showTab(tab: 'jobs'|'runs'|'upcoming'|'templates')` beside `openRun` and use it, then reveal `#jobs-view-<tab>`. `openRun` keeps its order: `gotoSub('jobs')`, `await render()`, `openRun(id)`.
- `sap:<tab>`: the SAP module deep-links internally by setting `_selected`/`_tab` (`sap-interface-ui.mts:1776-1780`); add a public `showTab(tab, objectKey = 'orders')` on its export that sets both and re-renders, then reveal `#sap-stage-batches` (falls back to `#sap-tabbody` when the plant has no staging panel). If the Interface pane is not yet rendered for the selected plant, the reveal waits for its render, as the Diagnostics reveal waits for `/diagnostics/db`.

### 6.8 Scroll-container facts

The scroll container is `.admin-scroll` (`flex:1; overflow:auto`, `styles.css:2999`); `html, body` are `overflow:hidden`; there is no sticky header above the sub-tab strip. So the rail is `position:sticky; top:12px; max-height:calc(100vh - 24px); overflow:auto` exactly like the existing `.ulog-rail` (`styles.css:6414`), sections carry `scroll-margin-top:12px`, and `scrollIntoView` needs no container special-casing.

### 6.9 Scroll-spy and head timestamp

One `IntersectionObserver` (`rootMargin: '-80px 0px -60% 0px'`) over `.diag-sec[id]`, created on first `_setSub('diagnostics')`, disconnected when leaving. Rail clicks `preventDefault` and go through `_revealAnchor`; `href` stays for middle-click and a11y. `#admin-diag-ts` uses `diag.stats_age` "DB stats {{db}} · pipeline {{pipe}}" with the existing relative-time helper, repainted on each paint (no extra ticker).

### 6.10 i18n sweep

`VACUUM ANALYZE`/`ANALYZE` to `btn.vacuum_analyze`/`btn.analyze`; `BLOCKING`/`BLOCKED` to `diag.lock_blocking`/`diag.lock_blocked`; `calls` to `diag.calls`; `aria-label="Help"` to `aria.help`; `<em>none</em>` to `ui.none`; P50/P95 headers get `thread.col_p50`/`thread.col_p95` `data-i18n`. `ui.db_deep_hint`, `ui.pipeline_hint`, `ui.bwarn_hint` are removed if no longer referenced.

## 7. Left to the builder

- Exact copy of the new i18n strings beyond the plan's translation table, and the wording of `diag.short_*` figures.
- Whether `JobsAdmin` needs a late-paint reveal hook (W3 decides).
- CSS details inside the tokens and the shape above (spacing, chevron treatment, chip-row styling).
- Which test seams to add to `admin-ui.mts` exports, as long as the behaviours listed in the plan are pinned.
- Minimal tests for `jobs-pane` and `sap-interface-ui` `showTab` if none exist under `tests/modules/`.

## 8. Waves

W0 docs (Sonnet); W1 module + locales (Sonnet); W2 Diagnostics restructure (Sonnet); W3 deep links (Sonnet); W4 design pass in Chrome against the mockup, `DESIGN.md` and the fit list, run by a Sonnet agent (not Fable: the owner approved the plan with "have sonnet do everything. Go!"), then a Sonnet apply and a fresh Sonnet branch reviewer. Merge to local `main` with `--no-ff`; nothing pushed or deployed without the owner's word.

## Appendix A: Context

**Owner's complaint.** "Fable-optimize the Diagnostics tab, and have the Overview details hyperlink to the note on the associated page", with mockups and simplicity.

**Mockups.** Three layouts were produced at https://claude.ai/artifact/GFPmDv2a5yQRN2G7PuFMhD. The owner picked **A, Jump rail**. Per-figure links inside the Details strip were declined; links go to sections only.

**Code facts (from the plan; verify before relying):**
- `mkSection` (`admin-ui.mts:2056-2091`) builds anonymous `<details class="admin-db-section">`.
- `nav.diagnostics` / `nav.interface` / `nav.jobs` / `nav.order_maintenance` fixes at ui:1140-1143; Details-strip `data-nav` buttons at ui:981-988 and 585-586.
- Pool thresholds: summary tile ui:2289 (85 % or waiting), Pool section ui:2097 (waiting/errors only), fill bar ui:2325 (60/85), Overview signal `signals.mts` `THRESHOLDS` (60/85).
- Backend warnings: standalone `_renderBackendWarnings` ui:1658-1709; again in the Emitted step via `_pipelineDetailEmitted` / `_warningList` ui:1383-1413 (uncapped).
- Per-card Refresh ids: `#admin-diag-refresh`, `#admin-pipeline-refresh`, `#admin-db-deep-refresh`.
- `logs.open` always presets `warn` at ui:1154.
- Hardcoded strings: ui:2432, 2437 (VACUUM ANALYZE / ANALYZE), 2558, 2563 (BLOCKING / BLOCKED), 2510 (calls), 2845, 2864 (`aria-label="Help"`, `<em>none</em>`); P50/P95 headers at `index.html:2043-2044` lack `data-i18n`.
- Diagnostics markup `index.html:1984-2056`; upload history card `index.html:2121`.
- `_renderDiagnosticsPane()` ui:656-661; `_dbSummaryStrip` ui:2257-2321; `.admin-db-section*` CSS `styles.css:5964-5995`; `.admin-scroll` `styles.css:2999`; `.ulog-rail` `styles.css:6414`.
- `jobs-pane.mts`: `_setTab` :1047, `render` :1178, test-seam export :1196. `sap-interface-ui.mts`: internal deep link :1776-1780, `#sap-stage-batches` / `#sap-stage-outbound` ~:1150-1160, :1425.
- `admin-ui.test.mjs` fakes the DOM by hand: `fakeNode()` :29, `withFakeDom` :44, per-test `els` map + `document = { getElementById }` :141, `stubAll(ALL_RENDERERS)` :173-201.

## Appendix B: Learnings

(Empty; filled at the end of the run.)
