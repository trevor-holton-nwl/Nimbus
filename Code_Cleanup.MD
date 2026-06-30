# NIMBUS — Architect's Code Cleanup Review

> **Lens:** This is *not* a bug/lint sweep (that already exists in `CODE_REVIEW_FINDINGS.md`). This review reads the codebase the way a senior architect would on a maturity pass: where the code *works* but is **inefficient, duplicated, weakly abstracted, scale-fragile, or quietly wrong** — and where idioms a beginner reaches for have hardened into structural debt.
>
> **Scope:** `app.js` (15.9k lines), `nimbus-intelligence.js`, `nimbus-worker.js`, `brain.py`, `db.py`, `master_data.py`, `index.html`, `styles.css`, `schema.sql`.
>
> **How this was produced:** 26 slice-scoped reviewers swept the codebase in parallel, each producing candidate findings against the live source; a second **adversarial verification pass** then re-read the actual code for every candidate and **dropped 31** as false, stale, trivial, or already-mitigated (NIMBUS audits have historically run ~50% stale, so verification is the guardrail). What remains — **190 findings** — was confirmed against the code as it exists today. Every finding cites real line numbers and a verbatim excerpt. Verifier notes (`> Verifier note:`) record what was checked and where a candidate's severity or wording was corrected.

---

## The one-paragraph verdict

NIMBUS is a capable, feature-dense prototype whose **single biggest architectural liability is that it is still written as a one-plant app while its own roadmap commits it to 50+ plants / 3,500+ lines.** Global, all-plant data structures and "render everything" patterns appear in dozens of places, contradicting the per-plant scoping doctrine in `CLAUDE.md`. The second liability is **drift-by-duplication**: the same rule — line→plant resolution, the alert engine, HTML-escaping, schedule scoring, heat-map coloring, bar charts — is hand-copied across files with no shared definition, and in at least one safety-critical case (the worker's alert engine) the copies have **already diverged**. Neither liability is exotic; both are the predictable result of fast prototype growth without a refactor pass. The fixes are mostly mechanical and high-leverage.

---

## Cross-cutting themes (read this first)

The 190 findings collapse into **10 architectural themes**. Fixing the theme is worth more than fixing any single finding.

### T1 · Global state where the architecture demands per-plant scoping  *(the dominant defect — ~25 findings)*
The app's stated scalability model is per-plant scoping, yet the hottest data paths operate on the **global, all-plant** task/line set:
- Calendar tab renders **every line system-wide** (`app.js:1455`); line cell-editor & override-modal pull lines from the **global task array** (`app.js:6894`); MasterData does a **full-table fetch + full DOM render with no pagination** even though the backend already supports `limit/offset/plant` (`app.js:14895`); FK `<select>`s populate the **entire parent table, rebuilt per row** (`app.js:15125`).
- The intelligence layer indexes the **global** task array in `NeedsEngine`/`CommandPalette` (`nimbus-intelligence.js:427`) and `TimeMachine` snapshots **all plants** on every auto-snapshot (`:1194`); `Patterns` learns into one **global** localStorage map (`:2065`).
- Offline `_loadCache` ignores the active plant and never sets `_currentLoadedPlant` (`app.js:11117`); `saveAll` POSTs the **global** blocks+calendars on every save (`app.js:11298`); `_navigateSelection` full-scans every task on each arrow key (`app.js:10619`); `DependencyOverlay` walks all tasks (`app.js:8898`).
- `linesForSelectedPlant()` is **unmemoized** and there is **no `_linesByPlant` index** to match the existing `_tasksByPlant` (`app.js:920`), so per-plant line resolution re-scans the world on every render.
- **Root cause:** line identity is keyed by *bare line code with no plant qualifier* (`app.js:595`, mirrored in `schema.sql:113`). Reused line codes across plants therefore collide silently — the same hazard `MIGRATION.md` flags for `make_id`.

**The fix is one idea applied everywhere:** build a plant-scoped index (`_linesByPlant` beside `_tasksByPlant`), make every "list lines / list tasks" call go through it, and qualify line identity by `(plant, line)`. Almost a third of this report dissolves once that exists.

### T2 · The worker is a hand-mirror of safety-critical logic — and it has already drifted  *(highest integrity risk)*
`nimbus-worker.js` re-implements ~480 lines of the `Calendar` capacity engine and the entire `Alerts` rule set (`nimbus-worker.js:26-506`), guarded only by a comment. Verification found this is **not hypothetical**: the near-capacity branch **structurally differs** between worker and `app.js` (`nimbus-worker.js:319` vs `app.js:3794`). It also re-ports `getPlantForLine` **without** the O(1) cache the main thread added — reintroducing O(lines²×days) in the very path meant to be fast (`nimbus-worker.js:91`), resolves plant by line-code only (ignoring materialized `t.PLANT`, `:260`), and recomputes capacity by subtracting wall-clock epoch-ms (DST off-by-one-hour, `:125`). **Recommendation:** stop mirroring. Pass the resolved line→plant map (or the already-materialized `t.PLANT`) into the worker snapshot, and extract the shared rules into a plain module the worker can load via `importScripts` so there is exactly one source of truth.

### T3 · Drift-by-duplication: the same rule lives in N places  *(45 Duplication findings)*
No shared utility layer means business rules are copy-pasted and then diverge:
- **HTML-escaping** is hand-rolled inline **~19 times** across `app.js` with *different* entity sets and null handling (`app.js:8672`, `:7173`, `:9326`, …) — and one variant omits the single-quote escape while feeding values into single-quoted `onclick` args (`app.js:7173`), an XSS-shaped hole.
- **line→plant derivation** is hand-copied in **three** places (`db.py:297`, ingest, and `schema.sql:152`); the **alert-horizon cutoff** is duplicated (`app.js:4207`, `:7731`) and the copies **have already drifted** (KPI count ignores a filter the summary honors, `app.js:7731`); **schedule-confidence scoring** is duplicated between the live badge and its explanation dialog (`nimbus-intelligence.js:1382`); **heat-map coloring** is copy-pasted 3× (`app.js:2785`); **bar-chart builders** reimplemented 5× (`app.js:12158`).
- The frontend hardcodes the five master tables (`KEY_COLS/FK_SOURCE/TABLE_LABELS`, `app.js:14812`), duplicating backend authority and drifting from runtime DDL.

**Fix:** a single `esc()`, a single `lineToPlant()`, a single `scoreSchedule()`, a single `hbar()` / `heatColor()`. This is the cheapest theme to close and kills a whole class of "fixed it in one place" bugs.

### T4 · "Render everything, every time" — incremental primitives exist and are bypassed  *(~29 Inefficiency findings)*
The codebase *has* `VirtualList`, AG Grid transactions, and a memoized utilization matrix — and routinely ignores them:
- Heatmaps render **every line** via string-built `innerHTML` with per-cell inline `onclick`, right next to a `VirtualList`-backed panel that does it correctly (`app.js:7912`).
- MasterData rebuilds the **whole table** on every add/paste/delete/undo (`app.js:15214`); `lineSettings:change` does a full grid `rowData` reset instead of a transaction (`app.js:6770`); `alerts:change` runs a `refreshCells` **and** a full `redrawRows()` — the first is dead work (`app.js:6806`).
- `OptimizerPreview` runs **two** full unmemoized matrix builds on the main thread on top of the optimizer (`app.js:9294`); the Admin tab fires the **entire diagnostics fan-out twice** (`app.js:11719`); `_rowKey` is recomputed O(n) inside O(m) loops so paste degrades **quadratically** (`app.js:15252`); a decorative arrow is repositioned by an **indefinite per-frame rAF + getBoundingClientRect** loop (`app.js:14238`).

### T5 · The project has standards; large parts of the code opt out
There is a `fetchTraced` wrapper (x-request-id correlation), an actor-identity header, an i18n resolver, and a "searchable combobox, never bubble/flat selectors" scale rule. Yet:
- Many paths use **raw `fetch()`** (no tracing) — labor plan, color wheels, MasterData, the read path (`app.js:2347`, `:10761`, `:15152`), and `master_data` writes.
- Several write paths **hardcode the developer's email** as `X-User`, corrupting the audit trail (`app.js:2349`, `:5330`, color-wheel `:_fetchAndRender…`).
- Override/Blackout modals use **bare native `<select>`** line pickers (`index.html:1731`) while the optimize modal already ships a searchable combobox — exactly the anti-pattern the roadmap forbids at 70+ lines/plant.
- Actions wired via **stringly-typed inline `onclick`** attributes (`app.js:4187`, `:9837`, `:10651`) inconsistent with the delegated pattern used lines away; hardcoded English strings break i18n (`app.js:7831`).

### T6 · Backend correctness & concurrency under the multi-replica future
- The **read path mutates a process-global** `DIAGNOSTICS['warnings']` (unbounded) on color-merge failure, leaking one request's warning into everyone's diagnostics (`brain.py:320`); color-wheel/audit JSON use **unguarded read-modify-write + `os.listdir` scans** that are not replica-safe (`brain.py:400`).
- **Eleven** diagnostics functions swallow every `Exception` into `{'error': str(e)}` — hiding pool exhaustion / statement timeouts and never logging (`db.py:555`).
- Chunked upsert **commits each 500-row chunk separately** and writes the audit row last, so a mid-upload crash leaves orders durably half-loaded with no audit (`db.py:1164`); `make_id` collisions are patched with a per-upload `cumcount`, producing **batch-unstable ids** that violate the frontend's stable-key contract (`db.py:1117`); `FOR UPDATE` without `ORDER BY` invites deadlocks (`db.py:455`).
- The riskiest write endpoints (DDL, bulk, purge, labor-plan, constraints) take **raw dict bodies**, forfeiting Pydantic validation / 422 / OpenAPI (`brain.py:931`).
- `/tasks` **sorts the order set three times** per request with mismatched keys (`brain.py:571`) and fires a **second full COUNT(\*)** when paging (`brain.py:828`).

### T7 · Schema & data-model fragility
- The documented **×1440 non-idempotent horizon migration** re-multiplies on every re-run (`schema.sql:109`) — a live data-corruption landmine, now the highest-severity backend item.
- `production_lines.production_line` has **no global identity and no FK** from `orders`, so reused line codes leave orders un-attributed (`schema.sql:113`); horizon columns are **labeled "(days)" but stored as minutes** (`schema.sql:99`); dates/weeks stored as **TEXT not DATE** (`schema.sql:233`); all timestamps are **`TIMESTAMP` (no tz)** for a multi-region future (`schema.sql:27`); no **composite `(plant,…)` index** matches the `/tasks` filter+order (`schema.sql:143`); `labor_plan_line` has **no FK** so orphans survive deletes (`schema.sql:261`).

### T8 · The CSS design-token system is half-built  *(21 findings)*
- Tokens are **referenced but never declared** — `--border`, `--border-subtle`, `--amber`, `--nimbus-amber`, `--bg-float`, `--font-mono`, `--accent-rgb` — so components silently pin to fallback literals, several **wrong in the default light theme** (`styles.css:438`, `:1763`, `:4970`).
- **Dark mode is incomplete**: many components hardcode light colors with no `body.dark` counterpart (welcome splash `:1442`, optimize/edit-calendar modals `:2171`, DB Deep Dive `:4387`, timeline overlay `:3764`).
- Semantic colors are **re-hardcoded as divergent rgba** (two different reds for one "error" state, `:2825`); the production-line palette is **duplicated** between CSS `--l0..--l9` and JS `Config.COLORS` with no sync (`styles.css:69`).

### T9 · Accessibility gaps & missing teardown (leaks)
- Modals are plain `<div>`s with **no `role="dialog"`/`aria-modal`/focus-trap**, status/toast regions lack `aria-live` (`index.html:1714`); tab strips declare `role="tab"` but never wire `aria-selected`/`aria-controls` (`index.html:1280`, `:925`).
- Lifecycle leaks: the Timeline 1-second `setInterval` handle is **discarded** (`app.js:5874`); `TimelineNav`/`DependencyOverlay` unsub handles are **stored but never invoked** and window/vis listeners have no teardown (`app.js:8367`); a document-level click listener **leaks** when the column menu closes via a menu item (`app.js:15475`); `TimelineNav` schedules a full minimap repaint via a raw 50 ms `setTimeout` per mutation with **no debounce, so timers stack** (`app.js:8420`).

### T10 · Latent bugs the verifier confirmed (small, sharp, real)
- Multi-order drag declares `skippedFixed` but **never populates it**, so the "fixed not moved" toast is dead code that would **throw if reached** (`app.js:10359`).
- CSV export uses naive comma-join with **broken escaping and no BOM** — corrupts on commas/quotes/newlines and mis-decodes accents (`app.js:13954`).
- Promote-What-If then undo restores tasks+fixedIds but **not blocks/calendars**, leaving sandbox blackout edits live (`app.js:9598`).
- Purge preview counts **plant-scoped** rows while `/purge` deletes **globally** — undercounts a destructive cross-plant delete (`app.js:12257`).
- `_renderSettingsPane` **optimistically mutates Store** before unchecked fire-and-forget fetches with **no rollback** (`app.js:14640`); `Diff.compute` flags **1 ms jitter** and null↔value transitions as moves (`nimbus-intelligence.js:1855`); the confidence chart **inverts devicePixelRatio** handling (`nimbus-intelligence.js:1586`).

---

## High-severity findings (the 17 to schedule first)

| # | File | Theme | Finding |
|---|------|-------|---------|
| 1 | `app.js:1455` | T1 | Calendar tab renders **every line system-wide**, not plant-scoped |
| 2 | `app.js:595` | T1 | Line settings/calendars keyed by **bare line code** — collides on reused codes |
| 3 | `app.js:6894` | T1 | Line cell-editor & override-modal pull from the **global** all-plant task array |
| 4 | `app.js:7912` | T1/T4 | Lateness/utilization heatmaps render **every line** via innerHTML + inline onclick |
| 5 | `app.js:11117` | T1 | Offline `_loadCache` **ignores the active plant** filter |
| 6 | `app.js:14895` | T1 | MasterData **full-table fetch + full DOM render, no pagination** (backend supports it) |
| 7 | `app.js:15125` | T1 | FK `<select>` populates the **entire parent table, rebuilt per row** |
| 8 | `app.js:8942` | T1/T10 | DependencyOverlay **zips a global, lexically-sorted line list against plant-scoped DOM by index** — already mis-aligns |
| 9 | `app.js:9294` | T4 | OptimizerPreview runs **two full unmemoized matrix builds** on the main thread |
| 10 | `app.js:11719` | T4 | Admin tab fires the **entire diagnostics fan-out twice** |
| 11 | `app.js:3707` / worker | T2/T3 | Alert rule engine **fully re-implemented inline in the worker** (drifts) |
| 12 | `nimbus-worker.js:26` | T2 | **~480 lines** of capacity/alert logic hand-duplicated, guarded only by a comment |
| 13 | `nimbus-intelligence.js:427` | T1 | NeedsEngine/CommandPalette **index the global** task array |
| 14 | `nimbus-intelligence.js:1194` | T1 | TimeMachine **snapshots all plants** on every auto-snapshot |
| 15 | `brain.py:400` | T6 | Color-wheel/audit JSON **unguarded read-modify-write + os.listdir** — not replica-safe |
| 16 | `schema.sql:109` | T7 | **Non-idempotent ×1440 horizon migration** — data-corruption landmine |
| 17 | `schema.sql:113` | T7 | `production_lines` has **no global line identity / no FK** — orders un-attributed |

---

## Suggested sequencing

1. **De-risk first (cheap, high-impact):** fix the ×1440 idempotency landmine (#16), the worker near-capacity drift (#11/#12), the unescaped-onclick `esc()` variant (T3), and the global purge-preview undercount (T10). These are correctness/data-integrity, small diffs.
2. **Build the per-plant spine (T1):** add `_linesByPlant` + `(plant,line)` identity + route all line/task listings through scoped getters. This is the structural investment that retires ~25 findings.
3. **Extract the shared utilities (T3):** one `esc`, `lineToPlant`, `scoreSchedule`, `hbar`, `heatColor`; move the worker rules into an `importScripts` module (T2).
4. **Reach for the incremental primitives you already own (T4):** AG Grid transactions, `VirtualList` in the heatmaps, memoize the matrix builds.
5. **Pay down the rest by theme:** standards adoption (T5), backend replica-safety (T6), schema typing/indexes/FKs (T7), CSS token completion + dark mode (T8), a11y + teardown (T9).

---

## Findings at a glance

**By severity:** 17 high · 104 medium · 69 low  &nbsp;(190 confirmed; 31 dropped in verification)

**By category:** Duplication 45 · Maintainability 40 · Scalability 35 · Correctness 32 · Inefficiency 29 · Abstraction 9

**By file:**

| File | Findings |
|------|---------:|
| `app.js` | 105 |
| `styles.css` | 21 |
| `nimbus-intelligence.js` | 14 |
| `index.html` | 12 |
| `db.py` | 9 |
| `schema.sql` | 9 |
| `brain.py` | 8 |
| `master_data.py` | 6 |
| `nimbus-worker.js` | 6 |

> The 31 dropped candidates are listed for transparency in the **Appendix** at the end — adversarial verification rejected them as misreads, dead-but-harmless code, or deliberate documented tradeoffs.

---

# Detailed findings

*Grouped by file (most high-severity first), each ordered high → medium → low. Line numbers were re-confirmed against live source during verification; treat them as accurate-as-of-this-review and re-anchor by the quoted excerpt if the file has since shifted.*

## `app.js` — 105 findings (11 high · 52 medium · 42 low)

### 1. [HIGH · Correctness] DependencyOverlay zips a GLOBAL, lexically-sorted line list against plant-scoped DOM groups by positional index — already mis-aligns under numeric line codes or an active line filter, and breaks outright with multiple plants

**Location:** `app.js` lines 8942-8959, 8977-8978  |  **Confidence:** high

**Problem.** lineToY (8944) is built from `[...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort()` — ALL plants' lines with a plain lexical `.sort()` — then zipped index-for-index against `dom.querySelectorAll('.vis-foreground .vis-group')` (8945-8954). But Timeline.rebuild() builds its groups from `Store.tasksForSelectedPlant()` (plant-scoped), sorts them with `localeCompare(..., {numeric:true})` (app.js 6062-6063), and can further drop rows when a GanttFilter line multi-select is active (6069-6075). So `groupEls[i]` for the i-th global-lexical line is not the DOM row for that line, and arrows positioned via `lineToY[sTask.PRODUCTION_LINE]` land on the wrong row or fall back to the centre line.

**Why it matters (architect view).** This is the global-vs-per-plant defect the scale roadmap warns about, but it is worse than 'only breaks with 2+ plants': even on one plant the orderings already diverge for numeric line codes (lexical 'L10' < 'L2' vs numeric 'L2' < 'L10') and when a GanttFilter line filter hides DOM groups, so misplacement can occur today.

**Recommendation.** Drop positional zipping entirely: key lineToY by reading each group element's own line id (the group `id` is the line code — set a data attribute or match by group id) instead of relying on index alignment. If a list is still needed, build it from the SAME source and sort the timeline uses (`Store.tasksForSelectedPlant()` plus `Store.linesForSelectedPlant()`, sorted with the identical numeric localeCompare, and respecting the GanttFilter line filter).

**Evidence.**

```
8944: const lines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();  8946-8950: lines.forEach((line, i) => { const groupEl = groupEls[i]; ... lineToY[line] = (gRect.top - wrapRect.top) + gRect.height/2; });  Timeline groups (6062): sortedLines = [...lineSet].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,...}));  visibleLines filtered by GanttFilter (6069-6071).
```
> _Verifier note:_ Verified at 8944/8946-8954 and cross-checked Timeline.rebuild group build at 6045/6062-6071. Finding is correct and understated — raised confidence: the misalignment can already occur single-plant via numeric-sort divergence and active line filters, not only at multi-plant.


### 2. [HIGH · Duplication] Alert rule engine is fully re-implemented inline in the worker — a hand-mirror that silently drifts

**Location:** `app.js` lines 3707-3937 (sync copy); nimbus-worker.js ~270-417 (worker copy)  |  **Confidence:** high

**Problem.** Alerts._recomputeSync (app.js 3707-3937) contains the entire rule set — overlap (3739-3759), overload + near-capacity (3761-3801), closed-day union diagnostic (3802-3849), blackout (3852-3880), fixed-closed (3882-3895), fixed-out-of-hours (3897-3920) — plus the block pre-parse/index logic. This is hand-ported rule-for-rule into nimbus-worker.js (overlap at 279, overload/effCap*OVERLOAD_THRESHOLD at 313-315, closed-day mergedOverlapHours at 325-360, blackout at 385, fixed-closed at 399, fixed-out-of-hours at 417). The worker copy is the PRIMARY path whenever a plant is selected (recompute() at 3684 routes to Compute.alerts); the sync version is only the fallback.

**Why it matters (architect view).** Two independent copies of safety-critical scheduling rules will diverge over time — a fix to one (e.g. the closed-day union math at 3802-3849, or the effCap*OVERLOAD_THRESHOLD comparison at 3787) is invisibly absent from the other. Which alerts a user sees depends on whether the worker is alive (non-deterministic across sessions, since a single worker onerror permanently routes to the sync path). The only guard is a CLAUDE.md comment. This is the highest-risk structural defect in the slice.

**Recommendation.** Extract the rule set into a single pure module (e.g. alerts-core.js) taking a plain snapshot {tasks, blocks, plantBlocks, calendars, lineSettings, config} and returning alerts, with zero DOM/Store references. Import from app.js (sync fallback) and from nimbus-worker.js via importScripts. One source of truth; the comment-only guard disappears.

**Evidence.**

```
app.js 3750-3756 `if (cur.start_date < prev.end_date) { alerts.push({ id: \`ovl-${prev.id}-${cur.id}\`, sev:'err', type:'overlap', ... }) }` is mirrored verbatim by nimbus-worker.js 279 `sev: 'err', type: 'overlap'` and 313 `if (effCap > 0 && hours > effCap * OVERLOAD_THRESHOLD)`; closed-day math app.js 3840 `Util.mergedOverlapHours(win, intervals)` mirrors worker 356 `mergedOverlapHours(win, intervals)`.
```
> _Verifier note:_ Verified both copies exist and match rule-for-rule: grepped nimbus-worker.js and confirmed overlap/overload/closed/blackout/fixed-closed/fixed-out-of-hours all present (lines 279,313,325,360,385,399,417). Adjusted line cite to add the worker-file range; the original app.js range is accurate.


### 3. [HIGH · Inefficiency] OptimizerPreview runs two full unmemoized utilization-matrix builds (pre + post) on the main thread, on top of the optimizer itself

**Location:** `app.js` lines 9294, 9301-9303, 388-398, 4357  |  **Confidence:** high

**Problem.** OptimizerPreview.runWithPreview calls Util.scheduleKpis() twice inside a double-rAF on the main thread (explicitly noted at 9258-9260 as 'we block the main thread with the optimizer'): once on the pre-snapshot (9294) and once on the post-optimize plant slice (9303). Each scheduleKpis() calls Utilization.computeMatrix(new Date(), 14, tasks) with a NON-null srcTasks (391). computeMatrix only memoizes when srcTasks === null (4357: `const cacheable = srcTasks === null`), so both calls rebuild the 14-day capacity matrix from scratch (per-(line,day) Calendar capacity + blackout math) plus countChangeovers — all synchronously around Engine.runAndApply (9298) while the spinner shows.

**Why it matters (architect view).** The matrix is scoped to in-window/in-scope plant lines, so at 70+ lines/plant it is ~1,000 cells rebuilt twice per optimize, each doing per-cell calendar/blackout math, on the main thread with the UI frozen. CLAUDE.md already routes Alerts/Utilization matrix builds through nimbus-worker.js and pre-warms them; this optimize hot path deliberately bypasses both the worker and the memo, making optimize-preview the slowest interactive action exactly as plants get large.

**Recommendation.** Hoist the matrix build out of scheduleKpis and build it once per (pre, post) phase, passing a prebuilt matrix in so the cheap O(n) changeover/lateness counting is separated from the expensive capacity matrix build. Better: route the matrix build through the Compute worker wrapper like Alerts/Utilization already do, since the user is staring at a spinner anyway. Note: the 'reuse the memoized global (srcTasks=null) matrix' option changes the scope from the user's filtered window/lines to all lines, so it is not a drop-in substitute for these scoped KPIs.

**Evidence.**

```
9294: const preKpis = Util.scheduleKpis(snapshot.filter(inScope), 14);
9303: const postKpis  = Util.scheduleKpis(postTasks, 14);
391: const m = Utilization.computeMatrix(new Date(), horizonDays, tasks);  // tasks !== null
4357: const cacheable = srcTasks === null;
```
> _Verifier note:_ Verified all cited code: 9262 double-rAF, 9294/9303 two scheduleKpis calls, 391 non-null srcTasks, 4357 cacheable gate. Tightened the lines field and flagged that the 'global matrix' recommendation option changes scope semantics.


### 4. [HIGH · Inefficiency] Admin tab entry fires the entire diagnostics fan-out twice (every backend fetch duplicated)

**Location:** `app.js` lines 11719-11722 (render), 11597-11607 (_setSub), 11724-11735 (_renderOverview)  |  **Confidence:** high

**Problem.** render() (11719-11722) calls AdminCockpit._setSub('overview') and then AdminCockpit._renderOverview() back-to-back. But _setSub already ends in `else AdminCockpit._renderOverview();` (line 11606), so _renderOverview() runs TWICE on every admin-tab open. _renderOverview() (11724-11735) fires six concurrent backend fetches — /health, /diagnostics/deep, /diagnostics/db, /logs/backend, /upload/audit, /audit/log — so each Admin-tab entry issues ~12 HTTP requests instead of ~6. (_renderDiagnostics and _renderLogs are local-only and add no fetch.) render() is the tab-switch entry point (called from App tab switching at line 14502), so this fires on every admin click.

**Why it matters (architect view).** Each /diagnostics/db round-trip runs the expensive Postgres observability suite (pg_stat_statements, blocking-lock chains, bloat scan, index usage). Doubling it on every tab open doubles DB load from the one console an operator opens precisely when the DB is already stressed. Worse, the second fan-out races the first: each _renderXxx does `AdminCockpit._xxxAbort?.abort(); new AbortController()`, so the second invocation aborts the first's in-flight request mid-flight — the first six requests are started and then cancelled and wasted.

**Recommendation.** render() should call _setSub('overview') only — delete the redundant AdminCockpit._renderOverview() on line 11721. _setSub already dispatches to _renderOverview, and each _renderXxx self-guards re-entrancy via its own AbortController, so a single fan-out is sufficient.

**Evidence.**

```
render() { AdminCockpit._setSub('overview'); AdminCockpit._renderOverview(); }  // and _setSub ends: ...else AdminCockpit._renderOverview();
```
> _Verifier note:_ Verified: render() 11720-11721 double-calls; _setSub line 1606 else-branch confirmed; _renderOverview 11724-11735 fans out 6 real fetches (diagnostics/logs are local); render() is the per-click admin entry (14502); each _renderXxx aborts its predecessor, confirming the race.


### 5. [HIGH · Scalability] Calendar tab renders every line system-wide, not plant-scoped — breaks at 3,500+ lines

**Location:** `app.js` lines _getLines 1455-1460; render hours table 1325-1341 + Flatpickr wiring 1369-1370; _renderBlocks dropdown 1384-1393; contrast ProdLines.render 1989  |  **Confidence:** high

**Problem.** Calendar._getLines() unions ALL lines from every order (Store.tasksArr) and every key in Store.calendars with no plant scoping. Calendar.render() then ensureCalendar()s every one, builds a <select> option per line (1313), and emits one <tr> with 7 input cells per line — wiring 2 Flatpickr instances per cell (1369-1370), i.e. 14 per line — synchronously into innerHTML. _renderBlocks() builds a per-line filter dropdown over the same full global set (1393).

**Why it matters (architect view).** Per the CLAUDE.md scale roadmap (~15 -> 3,500+ total lines, 50+ plants) this tab goes from ~210 Flatpickr inputs today to ~49,000 at target scale, all instantiated in one synchronous render with no virtualization and no plant filter. The sibling tab ProdLines.render() (line 1989) already scopes to Store.linesForSelectedPlant() when a plant is selected; Calendar does not, so the two tabs disagree on scope and Calendar is the one that locks the browser.

**Recommendation.** Scope _getLines() to the selected plant via Store.linesForSelectedPlant() (the pattern ProdLines already uses at 1989), falling back to the global union only when no plant is selected. Make the line <select> and block filter per-plant, and render the hours table through the existing VirtualList infra instead of building all rows + Flatpickr at once.

**Evidence.**

```
_getLines() { const set = new Set(); Store.tasksArr.forEach(t => set.add(t.PRODUCTION_LINE || 'Unknown')); Object.keys(Store.calendars).forEach(l => set.add(l)); return [...set].sort(); }  // vs ProdLines.render line 1989: const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : Calendar._getLines();
```
> _Verifier note:_ Verified all cited lines exist and behave as described; confirmed ProdLines (1989) scopes by plant and Calendar does not, and the 14-Flatpickr-per-line wiring at 1369-1370. Arithmetic (3,500×14≈49k) is sound.


### 6. [HIGH · Scalability] Line settings, calendars, and syncLineSettings are keyed by bare line code with no plant qualifier — collides on reused line codes (roadmap hazard)

**Location:** `app.js` lines 595/602 (Store calendars/lineSettings maps), 860-869 (getPlantForLine), 1455-1460 (Calendar._getLines), 2249-2250 (openBlockModal dropdown), 15631 (syncLineSettings findIndex)  |  **Confidence:** high

**Problem.** `Store.calendars` (595) and `Store.lineSettings` (602) are global maps keyed by bare line code. `setLineSetting(line, patch)` (852) and `getPlantForLine` (860) operate on bare line code (the master-data fallback at 868 also `.find(r => r.production_line === line)` ignoring plant). `MasterData.syncLineSettings` finds its DB row with `state.rows.findIndex(r => r.production_line === line)` (15631) — first match wins, plant-blind. `ProdLines.openBlockModal` populates the line `<select>` from `Calendar._getLines()` (2249) which returns ALL lines across ALL plants (1455-1459), not `Store.linesForSelectedPlant()`.

**Why it matters (architect view).** CLAUDE.md explicitly flags line-code reuse across plants (50+ plants, 3,500+ lines) as the primary scale hazard and says a plant-aware `make_id` is still needed. With these plant-blind keys, two plants sharing a line code (e.g. 'L01') collide: editing bottleneck/buffer/calendar for L01 in plant A silently mutates plant B's L01, and `syncLineSettings` PATCHes whichever DB row is first. The blackout dropdown also lists every line in every plant — unusable at 3,500 lines, and violates the documented no-flat-list/searchable-dropdown rule.

**Recommendation.** Key `lineSettings`/`calendars` and the `syncLineSettings` `findIndex` by composite `(plant, production_line)` (master-data tables are already composite-keyed). Scope `openBlockModal`'s `<select>` to `Store.linesForSelectedPlant()` and make it a searchable combobox per the roadmap rule.

**Evidence.**

```
595 `calendars: {}, // line → {...}`; 602 `lineSettings: {}, // line → {...}`; 868 `(this._state.masterData?.lines ?? []).find(r => r.production_line === line)`; 2249 `lineSel.innerHTML = Calendar._getLines().map(...)`; 15631 `const rowIdx = state.rows.findIndex(r => r.production_line === line);`.
```
> _Verifier note:_ Verified all keying claims: maps are bare-line-keyed, getPlantForLine/_getLines are plant-blind, syncLineSettings findIndex ignores plant, and openBlockModal uses _getLines() (all plants). Corrected the cited Store line refs (595/602/860/868 rather than 2032-2035). Directly aligns with CLAUDE.md's stated #1 scale constraint — kept high.


### 7. [HIGH · Scalability] Line cell-editor and override-modal line select pull from the GLOBAL all-plant task array, not the selected plant

**Location:** `app.js` lines 6894-6898 (_getLineOptions); 6424-6426 (agSelectCellEditor); 6933-6935 (override modal select)  |  **Confidence:** high

**Problem.** _getLineOptions() builds its Set from `Store.tasksArr` (every task across every plant — getter at line 616 returns Object.values(this._state.tasks)) unioned with all `Store.calendars` keys (global), then sorts. It feeds the inline PRODUCTION_LINE `agSelectCellEditor` (cellEditorParams at 6426), the override-modal line <select> (6934-6935), and the Inspector line <select> (7175/7203). At the documented target scale (50+ plants, 3,500+ lines) this is a single flat dropdown of lines from every plant, rebuilt by a full global scan each time the editor opens.

**Why it matters (architect view).** CLAUDE.md's primary scalability constraint forbids unfiltered all-lines lists and requires plant-scoped, filterable selectors. A multi-thousand-entry flat <option> list is unusable AND lets a user reassign an order to a line belonging to a different plant, corrupting orders.plant attribution.

**Recommendation.** Scope to the selected plant via `Store.linesForSelectedPlant()` (already plant-keyed, lines 920-924) instead of `Store.tasksArr` + all calendars, and memoize per (plant, Store._rev). For both the cell editor and the modal/inspector selects, prefer a searchable combobox over a raw <select>/agSelectCellEditor so it stays usable past ~10 lines.

**Evidence.**

```
_getLineOptions() {
  const set = new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'));
  Object.keys(Store.calendars).forEach(l => set.add(l));
  return [...set].sort();
}  // 6894-6898
```
> _Verifier note:_ Verified _getLineOptions (6894-6898), Store.tasksArr is all-plant (616), Store.calendars is global (614), and it feeds the editor (6426) + override modal (6934-6935) + Inspector (7175). linesForSelectedPlant() exists as the plant-scoped alternative (920-924). Directly contradicts the CLAUDE.md scalability mandate.


### 8. [HIGH · Scalability] Lateness heatmap and utilization heatmap render every line at once via string-built innerHTML with per-cell inline onclick (no VirtualList, unlike the adjacent line-status panel)

**Location:** `app.js` lines 7912-7985 (util heatmap), 8176-8297 (lateness heatmap); comment at 8222; inline onclick at 7973 and 8274; VirtualList contrast at 8060  |  **Confidence:** high

**Problem.** _renderHeatmap (loop at line 7961 `lines.forEach`) and _renderLatenessHeatmap (loop at line 8261 `lines.forEach`) build a complete HTML string for EVERY line in scope (rows = all lines, cols = 7 or up to 28 days) and assign it via innerHTML. The code even acknowledges it at line 8222: `// All lines are rendered; the scroll-wrap viewport shows ~9 at a time.` The adjacent line-status panel (_renderLineStatus) DOES use a VirtualList (line 8060 `Dashboard._lsVL = new VirtualList(...)`), so the windowing primitive is available and was simply not applied to the two heatmaps. Each util cell carries an inline `onclick="NIMBUS.Dashboard._gotoLine('${line}','${d}')"` (line 7973) and each lateness cell an inline `onclick="NIMBUS.Dashboard._latenessDrill('${esc(line)}','${dk}')"` (line 8274), so a 70-line × 28-day grid emits ~1,960 inline handlers per render.

**Why it matters (architect view).** CLAUDE.md sets 70+ lines per plant (3,500+ system-wide) as the design target and explicitly forbids all-at-once rendering of per-line views. A 70×28 lateness grid is 1,960 DOM cells rebuilt from a string with 1,960 inline onclick closures parsed by the HTML engine on every dashboard render — exactly the pattern the scale roadmap rules out, and it blocks the main thread while the worker prewarms matrices.

**Recommendation.** Apply the same VirtualList windowing used by _renderLineStatus (line 8060) to both heatmap grids, or render only the top-N risk-sorted lines with a 'show more' expander — the lateness map already computes lineTotals sorted by risk (line 8223-8228), so capping to the worst ~15 is cheap. Replace per-cell inline onclick with one delegated listener on the grid container that reads the data-line/data-date attributes the cells already carry (line 7973 sets data-line/data-date; the lateness cells should add them too).

**Evidence.**

```
Line 8222 comment verbatim: `// All lines are rendered; the scroll-wrap viewport shows ~9 at a time.` Line 8273-8275: `const click = h > 0 ? \`onclick="NIMBUS.Dashboard._latenessDrill('${esc(line)}','${dk}')"\` : '';`. Line 7973: util cell `... onclick="NIMBUS.Dashboard._gotoLine('${line}','${d}')">${lbl}</div>`. Contrast line 8060: `Dashboard._lsVL = new VirtualList(el, {...})`.
```
> _Verifier note:_ Verified both loops, the verbatim comment at 8222, both inline-onclick sinks (7973, 8274), and the VirtualList contrast at 8060. The util heatmap onclick (7973) lacks an esc() so its claim about per-cell handlers is fully accurate.


### 9. [HIGH · Scalability] Offline cache fallback (_loadCache) ignores the active plant filter and never sets _currentLoadedPlant

**Location:** `app.js` lines 11117-11175 (vs plant-scoped backend path 10775-10885)  |  **Confidence:** high

**Problem.** The backend load path is plant-scoped (`/tasks?plant=...`, sets `Persistence._currentLoadedPlant = plant`). When the backend is unreachable, the catch at 10938 falls back to _loadCache(), which does `data.tasks.map(Persistence._prepTask)` then `Store.setTasks(tasks, 'persistence')` with NO plant filter and never assigns `_currentLoadedPlant`. The cache is written by _saveCache() as the full Store.tasksArr of whatever plant was last loaded.

**Why it matters (architect view).** Two concrete failures. (1) At 50+ plants the cache may hold a different plant's orders than the one currently selected, and the offline board renders that other plant's data with no indication. (2) _currentLoadedPlant is left stale (or null), so the reconnect watcher at 10976 reloads `plant: Persistence._currentLoadedPlant` — potentially the wrong plant or null (= the deliberately-unsupported whole-order-book fetch). This contradicts the 'a plant is the scaling unit — never request the whole order book' invariant the online path enforces.

**Recommendation.** Thread the requested plant into _loadCache(plant): after JSON.parse, either filter data.tasks to the requested plant or go to demo when the cached selectedPlant !== requested plant, and set Persistence._currentLoadedPlant = plant on success. Make the no-plant offline case render empty like the online no-plant path rather than dumping all cached tasks.

**Evidence.**

```
Online: `const tasksUrl = `${Config.API_BASE}/tasks?plant=${encodeURIComponent(plant)}`;` then `Persistence._currentLoadedPlant = plant;` (10885). Offline _loadCache: `const tasks = data.tasks.map(Persistence._prepTask); ... Store.setTasks(tasks, 'persistence');` (11151, 11163) with no plant argument; grep shows _currentLoadedPlant is never assigned inside _loadCache.
```
> _Verifier note:_ Read 11117-11175 in full; confirmed no plant filter and no _currentLoadedPlant write. Confirmed _saveCache snapshots full Store.tasksArr (11453) and reconnect reloads _currentLoadedPlant (10976). Finding accurate as written.


### 10. [HIGH · Scalability] Full-table fetch + full DOM render with no pagination — backend already supports limit/offset/plant scoping that the UI discards

**Location:** `app.js` lines 14895-14925 (_loadAndRender), 14930-15051 (_renderTable), 15463-15470 (_applyFilter)  |  **Confidence:** high

**Problem.** _loadAndRender fetches `${API}/master-data/${table}` with no ?limit/offset/plant params (14903), stores the full result in _cache[table].rows, and _renderTable materializes one <tr> per row into a real DOM table (`allRows.forEach(row => _appendRow(...))`, 15046). Each row builds several elements plus contentEditable cells and (for FK columns) a <select>. The search box (`searchInput.oninput = () => _applyFilter(...)`, 14950) is a client-side filter that iterates EVERY <tr> and reads `tr.textContent` per keystroke (15467).

**Why it matters (architect view).** This is the master-data admin grid for `plants` and `production_lines`. CLAUDE.md's scale roadmap is explicit: 50+ plants, 70+ lines/plant, 3,500+ total lines. Rendering 3,500 rows x ~6 columns as live DOM nodes (some contentEditable, some with <select> children) produces multi-second layout and a frozen tab on every tab switch / save / paste (each rebuilds the whole table from scratch). Per-keystroke _applyFilter reading textContent across 3,500 rows is O(rows) layout-thrash per character.

**Recommendation.** Drive the existing server-side window: pass ?limit=&offset= (and ?plant= when the table has a plant column) to /master-data/{table}, render only a page, and use meta.total (already returned) for a pager. For the body, reuse the project's existing VirtualList windowed renderer (used at Hierarchy/Dashboard/Alerts) instead of materializing all rows. Move search to a server-side q/plant filter, or at minimum debounce it and precompute a lowercased search string per row instead of reading tr.textContent.

**Evidence.**

```
14903 `Util.fetchTraced(`${API}/master-data/${table}`, ...)` (no params); 15046 `allRows.forEach(row => _appendRow(tbody, table, columns, row));`; 14950 `searchInput.oninput = () => _applyFilter(table, searchInput.value.toLowerCase());`; 15467 `const text = tr.textContent.toLowerCase();`. Backend list_rows(table, limit, offset, plant) at master_data.py:70-182 implements the plant WHERE filter (122-124), LIMIT/OFFSET (135-140), and meta.total (147-154); brain.py:1274-1289 wires ?limit/?offset/?plant. VirtualList exists at app.js:434.
```
> _Verifier note:_ Verified: fetch has no params, full forEach render, per-keystroke textContent filter all present at cited lines; backend window support confirmed in master_data.py:70-182 and brain.py:1274-1289; VirtualList confirmed at app.js:434.


### 11. [HIGH · Scalability] FK <select> populates the entire parent table unscoped and is rebuilt per-row — flat dropdowns of 50+ plants / 3,500+ lines violate the roadmap's anti-pattern

**Location:** `app.js` lines 15125-15166 (_fkSelect), 15077-15087 (per-row FK cell construction)  |  **Confidence:** high

**Problem.** _fkSelect builds a fresh <select> for every FK cell of every rendered row, appending one <option> per source-table row (`sourceRows.forEach(...)`, 15141; and again in the fetch-fallback at 15156). The FK source is fetched/used in full (`fetch(`${API}/master-data/${sourceTable}`)` at 15152, no plant/subnetwork scoping). There is also no parent->child scoping: for production_lines the `plant` dropdown lists ALL plants regardless of the row's chosen subnetwork (valCol/labelCol derived only from the source table's own keys at 15133-15134).

**Why it matters (architect view).** At target scale a production_lines page renders, per row, a <select> with 50+ plant <option>s; the material_plants FK to `materials` (FK_SOURCE materials at 14833) could be thousands of options per cell. This is exactly the flat-dropdown-breaks-past-~10-entries anti-pattern CLAUDE.md forbids for plants/lines. A flat unscoped select of 3,500 lines or 50+ plants is both unusable and slow to build per cell.

**Recommendation.** Replace the flat <select> with a searchable combobox that lazy-loads/paginates the parent table (server-side filtered by the typed query and, for production_lines, scoped to the row's selected subnetwork). Cache the parent option list once per render keyed by the scoping value rather than re-deriving and re-fetching per cell.

**Evidence.**

```
15141 `sourceRows.forEach(r => { const opt = document.createElement('option'); ... sel.appendChild(opt); });`; 15152 `fetch(`${API}/master-data/${sourceTable}`).then(r => r.json())` (full parent table, no filter); 15133 `const valCol = srcKeys[srcKeys.length - 1];` with no subnetwork scoping; FK_SOURCE at 14830-14834 maps production_lines.plant -> plants and material_plants.material_id -> materials.
```
> _Verifier note:_ Verified: _fkSelect at 15125-15166 builds a per-cell select over the full unscoped parent list with no subnetwork->plant narrowing; FK_SOURCE confirmed at 14830-14834. Adjusted the per-row cell line cite to 15077-15087 (was 15079-15087).


### 12. [MED · Correctness] _rebuildPlantIndex silently drops tasks that resolve to no plant, with no counter or warning — unlike setTasks which carefully reports id collisions

**Location:** `app.js` lines 892-898 (drop), 658-668 (the contrasting collision-reporting pattern in setTasks)  |  **Confidence:** medium

**Problem.** _rebuildPlantIndex indexes tasks by `t.PLANT || Store.getPlantForLine(t.PRODUCTION_LINE)` and does `if (!p) continue;` (894-895). If an order's PLANT column is absent (older ingests, or any upload lacking WERKS/PLANT) AND its line is absent from masterData, the order resolves to null and is dropped from every per-plant bucket. tasksByPlant/tasksForSelectedPlant then silently omit those orders. setTasks (658-668) demonstrates the right pattern right next door — it counts collisions and emits ErrorLog.error with samples — but _rebuildPlantIndex applies no equivalent diagnostic.

**Why it matters (architect view).** Per-plant scoping is the app's primary scalability strategy, and it hinges on every order resolving to a plant via two fallible inputs (ingest-time t.PLANT materialization, master-data line mapping) with a silent null sink. At 50+ plants with heterogeneous upload sources this is exactly where orders 'disappear' from a plant with zero diagnostic — and the codebase already has the pattern to surface it.

**Recommendation.** In _rebuildPlantIndex, count tasks resolving to null and emit a single ErrorLog.warn with a small sample (mirroring setTasks' collision reporting). Longer term, make resolved plant a required attribute of a task value-object so 'task without a plant' is representable and surfaced rather than silently elided.

**Evidence.**

```
const p = t.PLANT || Store.getPlantForLine(t.PRODUCTION_LINE); if (!p) continue; (idx[p] ||= []).push(t);   // contrast setTasks 664-667: ErrorLog.error('store', `setTasks silently overwrote ${collisions} duplicate id(s)...`)
```
> _Verifier note:_ Verified silent continue at 894-895 and the contrasting collision-counting in setTasks at 658-668. The asymmetry and the proposed fix are real. Overlaps finding 1 on the silent-drop point but the primary recommendation differs (add diagnostic vs remove dead .find); kept as distinct, complementary findings.


### 13. [MED · Correctness] _dayWindow builds work windows with local setHours — no timezone/DST awareness across a multi-plant deployment

**Location:** `app.js` lines _dayWindow 1046-1059; workWindow intersection 1064-1102  |  **Confidence:** high

**Problem.** _dayWindow takes fractional work hours and applies them with start.setHours(hh1, mm1, 0, 0) on a Date in the browser's local timezone (1056-1057). workWindow then intersects line and plant windows in that same local frame (1089-1090). There is no plant-timezone concept anywhere in the Calendar engine — every plant's '08:00 shift' is interpreted in whoever is viewing the screen's local time.

**Why it matters (architect view).** At 50+ plants per the roadmap, plants span timezones and DST transition dates differ by region. A planner in US-Eastern viewing a Mexico or EU plant computes that plant's capacity windows, blackout overlaps, and optimizer placement in Eastern local wall-clock — capacity for a calendar day is off by the offset, and on DST-transition days setHours silently gains/loses an hour. The whole capacity/alert pipeline (and its worker mirror) inherits this.

**Recommendation.** Carry a per-plant IANA timezone on the plants master-data row and construct day windows in that zone (tz-aware date library or Intl.DateTimeFormat offset resolution) instead of browser-local setHours. This is an architectural item to schedule before multi-plant rollout — flag it in MIGRATION.md alongside the line-code-reuse plant-awareness work already noted there.

**Evidence.**

```
const hh1 = Math.floor(h1), mm1 = Math.round((h1 - hh1) * 60); const start = new Date(d); start.setHours(hh1, mm1, 0, 0);  // browser-local; no plant tz
```
> _Verifier note:_ Code confirmed at 1046-1059/1064-1102; setHours is local-time with no tz parameter and no plant-tz field anywhere in Calendar. Did not find any existing TZ mitigation in CLAUDE.md, so not a documented tradeoff.


### 14. [MED · Correctness] _aggrData / _lineData caches are evicted only on plant:selected, never on master-data-changed — stale labor reads after a structural change

**Location:** `app.js` lines 2374-2375 (_fetchAggregate guard), 3123-3128 (subscriber)  |  **Confidence:** high

**Problem.** `_fetchAggregate` returns the cached `_aggrData[plant]` indefinitely once populated (2375). The only eviction is in the Store subscriber, which does `delete _aggrData[evt.plant]; delete _lineData[evt.plant]` solely when `evt.type === 'plant:selected'` (3125). On `master-data-changed` the subscriber re-renders (3126) but does NOT evict either cache, so the aggregate/line grids render against the stale map.

**Why it matters (architect view).** A structural master-data change that the labor tab actually depends on — e.g. a `pl_group` rename or lines added/moved between groups in another tab — leaves the Aggregate/Line views showing pre-change hours until the user re-picks the plant. Classic 'memoized with no invalidation for the dimension that actually changed.' Single-replica pilot masks it for local edits (which patch the in-memory copy), but not for out-of-band master-data edits.

**Recommendation.** In the subscriber, also `delete _aggrData[evt.plant]; delete _lineData[evt.plant]` on `master-data-changed` (or version the caches by a master-data revision so a structural change forces a refetch). At minimum refetch aggregate when the `pl_group` set changes.

**Evidence.**

```
2375 `if (_aggrData[plant]) return _aggrData[plant];`; 3124-3126 `if ((evt.type === 'plant:selected' || evt.type === 'master-data-changed') && App._currentTab === 'labor') { if (evt.type === 'plant:selected') { delete _aggrData[evt.plant]; delete _lineData[evt.plant]; } render(); }` — master-data-changed falls through to render() with no delete.
```
> _Verifier note:_ Verified the subscriber gates the delete on plant:selected only while master-data-changed merely re-renders against the stale cache. Real correctness gap; medium because impact is bounded to multi-tab/out-of-band edits.


### 15. [MED · Correctness] _gotoLine derives the scroll-target row index from the GLOBAL all-plants task list (wrong sort, wrong scope) and reads getBoundingClientRect() in a loop (layout thrash)

**Location:** `app.js` lines 8142-8168 (esp. 8154-8155 index source, 8159-8162 reflow loop)  |  **Confidence:** high

**Problem.** _gotoLine computes the target row index from `[...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE))].sort()` (line 8154) — the GLOBAL all-plants line list, plain lexicographic sort — then scrolls by summing `groups[i].getBoundingClientRect().height` in a for-loop (lines 8160-8162). But the Gantt builds its groups from `visibleLines` = plant-scoped (tasksForSelectedPlant + linesForSelectedPlant) optionally GanttFilter-filtered, sorted with `localeCompare(..., {numeric:true, sensitivity:'base'})` (verified in Timeline.rebuild at lines 6056-6091). So the index used to scroll is computed from a different, larger, and differently-collated list than the rendered group order — the jump lands on the wrong row once a second plant's lines exist or a line filter is active, or even for purely-numeric line codes that sort differently under numeric collation. Separately, reading getBoundingClientRect() inside the loop forces a synchronous reflow per iteration (classic layout thrashing).

**Why it matters (architect view).** The Gantt is plant-scoped, but the index is derived from every plant's lines with a non-matching comparator. At 50+ plants the global list diverges from the rendered group order, so click-to-jump silently scrolls to the wrong line — a correctness defect, not just a perf one. The reflow loop also turns an O(1) jump into O(visible-lines) forced layouts.

**Recommendation.** Derive the target from the same group elements the Timeline renders — query `.vis-foreground .vis-group` (already done at line 8157) and match by the group's line identity so index == DOM order by construction, or read the matched group's offsetTop once instead of summing getBoundingClientRect heights in a loop (one layout read instead of N).

**Evidence.**

```
Line 8154: `const allLines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();`. Lines 8160-8162: `for (let i = 0; i < lineIdx && i < groups.length; i++) { targetY += groups[i].getBoundingClientRect().height; }`. Contrast Timeline.rebuild line 6062-6063: `const sortedLines = [...lineSet].sort((a,b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));` over a plant-scoped/filtered lineSet.
```
> _Verifier note:_ Confirmed the global tasksArr source + plain .sort() at 8154 against Timeline.rebuild's plant-scoped, numeric-collated visibleLines (6056-6091). The sort-comparator mismatch is an additional real defect the original finding only partly captured. Reflow loop confirmed at 8160-8162. Upgraded category to Correctness (wrong-row scroll) — the original called it Inefficiency/medium; severity stays medium.


### 16. [MED · Correctness] Promoting a What-If scenario then undoing restores tasks+fixedIds but NOT blocks/calendars, leaving sandbox blackout/calendar edits live

**Location:** `app.js` lines 9598-9603, 9620-9645  |  **Confidence:** high

**Problem.** The Sandbox enter() snapshot deep-clones tasks, blocks, calendars, and fixedIds (9598-9603). On exit(true) (promote), the pushed undo entry restores ONLY snap.tasks and snap.fixedIds (9627-9629) — it never restores snap.blocks or snap.calendars. The discard branch (exit(false)) DOES restore all four (9638-9641). So if a planner enters what-if, edits a blackout block or calendar, promotes, then hits Ctrl+Z, tasks/fixedIds roll back but the sandbox's block/calendar edits stay applied — a silent partial undo with no UI signal. Secondary: the promote's undo label is 'Discard What-If scenario' (9626) and its toast is 'scenario_discarded' (9631), confusing for an undo-of-promote, but minor next to the data inconsistency.

**Why it matters (architect view).** Blackouts and calendars are first-class scheduling inputs (they gate capacity and alerts). A promote whose undo silently leaves block/calendar edits applied yields a schedule whose constraints match neither the pre- nor post-sandbox state, and the planner gets no signal the undo was partial.

**Recommendation.** Make the promote-undo restore the full snapshot symmetrically: in the exit(true) undoFn also set Store._state.blocks = snap.blocks and Store._state.calendars = snap.calendars (deep-cloned) before scheduleRecompute, mirroring the discard branch. Factor both branches' restore into one shared _restoreSnapshot(snap) helper to prevent future drift.

**Evidence.**

```
9626: UndoStack.push('Discard What-If scenario', () => {
9627:   Store.setTasks(snap.tasks, 'undo');
9628:   Store._state.fixedIds = new Set([...snap.fixedIds]);  // no blocks/calendars restore
// vs discard branch 9639-9640: Store._state.blocks = snap.blocks; Store._state.calendars = snap.calendars;
```
> _Verifier note:_ Verified the asymmetry directly at 9626-9632 (promote-undo) vs 9638-9641 (discard). Real. Downgraded high→medium because it requires the specific sequence of editing blocks/calendars in what-if, then promote, then undo.


### 17. [MED · Correctness] Multi-order drag declares skippedFixed but never populates it, so the 'fixed not moved' toast is dead code that would throw if ever reached

**Location:** `app.js` lines 10359, 10370-10388  |  **Confidence:** high

**Problem.** selIds is filtered to exclude fixed tasks up front (10359: `.filter(sid => sid !== id && !Store.isFixed(sid))`). Inside the companion loop a skippedFixed array is declared (10370) but nothing is ever pushed to it — the loop only handles already-non-fixed ids. So the guard at 10388 (`if (skippedFixed.length) Toast.show(t('toast.fixed_count_not_moved', ...))`) can never fire: a multi-drag that includes fixed orders silently moves the non-fixed ones with zero feedback that the fixed ones were left behind. The dangling array signals the skip-tracking was refactored away incompletely.

**Why it matters (architect view).** On a multi-drag the user's intent is to move the whole selection; quietly dropping fixed members with no toast is a usability/correctness gap. The dead array plus its unreachable toast is also a maintenance trap.

**Recommendation.** Decide the product behavior explicitly: either compute skippedFixed = Selection.ids().filter(sid => sid !== id && Store.isFixed(sid)) before filtering selIds and fire the toast from that, or delete the dead array and unreachable toast outright.

**Evidence.**

```
10359: const selIds = Selection.ids().filter(sid => sid !== id && !Store.isFixed(sid));
10370: const skippedFixed = [];   // never pushed to
10388: if (skippedFixed.length) Toast.show(t('toast.fixed_count_not_moved', { count: skippedFixed.length }), 'warn');  // unreachable
```
> _Verifier note:_ Verified: selIds filters fixed at 10359, skippedFixed declared at 10370 and never pushed, toast unreachable at 10388. CORRECTION to the original finding: in this scope `t` is the dragged-task object (const t = Store.tasks[id] at 10310), NOT the global i18n function — so the toast would throw 't is not a function' if ever reached, it would not resolve to the global t. This makes the code latently broken, not merely dead.


### 18. [MED · Correctness] Purge-count preview scans plant-scoped tasksArr while /purge deletes globally — undercounts a destructive cross-plant delete

**Location:** `app.js` lines 12257-12268 (_updatePurgeCount); brain.py 1061-1078 / db.py 533-540 (/purge)  |  **Confidence:** high

**Problem.** _updatePurgeCount() (12264) filters Store.tasksArr by date on every Flatpickr onChange. But Store.tasksArr holds only the currently-selected plant's orders — the frontend fetches /tasks?plant=<plant> (app.js line 10775). Meanwhile POST /purge → db.purge_orders_by_date (db.py 535) runs `DELETE FROM orders WHERE COALESCE(scheduled_end, basic_finish_date) BETWEEN %s AND %s` with NO plant filter — it deletes across ALL plants. So the operator sees the count for one plant before confirming a delete that wipes matching orders in every plant.

**Why it matters (architect view).** The preview is semantically wrong for a destructive, irreversible operation: at the documented target scale (50+ plants) the undercount can be order-of-magnitude. Secondary: the O(n) full-array scan re-fires on every keystroke/onChange and is re-run by _renderPurgeMeta on every admin render, but the undercount is the load-bearing issue.

**Recommendation.** Either (a) add a /purge/preview?start&end backend count (consistent with the server-side cascade-preview in master_data) so the number matches what the server actually deletes, or (b) relabel to 'loaded plant orders only' and/or scope the DELETE by plant. Debounce the keystroke handler regardless.

**Evidence.**

```
const count = (Store.tasksArr || []).filter(t => t.end_date && t.end_date >= start && t.end_date <= endOfDay).length;  // vs db.py: DELETE FROM orders WHERE COALESCE(...) BETWEEN ... (no plant)
```
> _Verifier note:_ Confirmed tasksArr is plant-scoped (fetch /tasks?plant= at 10775) and purge_orders_by_date (db.py 533-540) has no plant filter. The semantic-mismatch on a destructive op is the real, verified core — stronger than the original 'scalability' framing.


### 19. [MED · Correctness] _runMaintenance uses bare fetch() with no timeout/abort and can leave the button permanently disabled

**Location:** `app.js` lines 12427-12446  |  **Confidence:** high

**Problem.** Every other AdminCockpit network call goes through Util.fetchTraced with an AbortController + AbortSignal.timeout. _runMaintenance instead calls raw fetch() (12432) with no signal and no timeout. A VACUUM ANALYZE on a large/bloated table is exactly the operation that can hang for minutes. The triggering button is disabled and relabelled 'running' before the await (12429); re-enable happens only in catch (12444), and there is no finally. If the request never resolves (hung VACUUM, dropped connection, proxy idle cutoff with no body), neither catch nor finally fires, so the button is stuck disabled with no error and the operator must reload.

**Why it matters (architect view).** It also bypasses fetchTraced's x-request-id propagation, so this destructive DDL action is the one admin operation NOT correlatable in the backend log via the reqId-chip feature (_correlateReqId) built right below it.

**Recommendation.** Route through Util.fetchTraced with an AbortSignal.timeout (a longer budget is fine for maintenance, e.g. 60s) and add a finally{} that always re-enables/relabels the button. This also restores reqId correlation for the most consequential admin action.

**Evidence.**

```
const r = await fetch(`${Config.API_BASE}/maintenance/${action}`, { method: 'POST', headers: {...}, body: JSON.stringify(body) }).then(res => res.json());
```
> _Verifier note:_ Verified 12432 bare fetch, no signal; success path re-enables only via _renderDbDeep re-render (12440), and a hang fires neither catch (12441) nor a finally (none exists). The stuck-button-on-hang and reqId-bypass claims both hold.


### 20. [MED · Correctness] CSV export uses naive comma-join with broken escaping and no BOM — corrupts on commas/quotes/newlines and mis-decodes accented text

**Location:** `app.js` lines 13954-13976  |  **Confidence:** high

**Problem.** exportCsv joins fields with ',' and only sanitizes the description field by replacing commas with semicolons (.replace(/,/g, ';')). PRODUCTION_LINE, ORDER, MATERIAL_NUMBER are emitted raw — any comma, double-quote, CR or LF in those values shifts columns or breaks rows. The comma→semicolon swap mutates the actual data instead of quoting it. No UTF-8 BOM is written, so Excel mis-decodes non-ASCII material descriptions (the app ships de/es/fr/pt locales).

**Why it matters (architect view).** Manufacturing material descriptions routinely contain commas, quotes and accented characters; a single offending field silently produces a malformed CSV that Excel/downstream tools parse wrong — a data-integrity hazard in a file users feed into other systems. Mutating description content means the export no longer matches source data.

**Recommendation.** Add a single csvField(v) helper that wraps a value in double-quotes and doubles internal quotes per RFC 4180 (quoting when the value contains comma/quote/CR/LF), prepend a UTF-8 BOM, and use it for every field. Remove the comma→semicolon hack. Consider \r\n line endings for Excel.

**Evidence.**

```
const lines = [ headers.join(','), ...Printer._rows.map(t => [ t.PRODUCTION_LINE || '', ..., (t.MATERIAL_DESCRIPTION || t.text || '').replace(/,/g, ';'), fmtDt(t.start_date), ... ].join(',')) ]; const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
```
> _Verifier note:_ Verified verbatim at 13954-13976; escaping is genuinely broken and BOM absent. Severity set to medium (bounded to the export feature, not core data path).


### 21. [MED · Correctness] _renderSettingsPane optimistically mutates Store before unchecked fire-and-forget fetches with no rollback

**Location:** `app.js` lines 14640-14749  |  **Confidence:** high

**Problem.** _savePlantHorizon and saveConstraints do Object.assign(plantRow, patch) / plantRow.constraints = payload (optimistic in-memory write) and then POST with raw fetch() (not Util.fetchTraced) without ever checking res.ok — only a network reject is caught. A 4xx/5xx from /master-data/plants/bulk or /constraints silently 'succeeds' while the local Store already diverged from Postgres, with no rollback. The optimizer then runs against constraints the DB never persisted.

**Why it matters (architect view).** An optimistic mutation that is never reconciled against the actual HTTP status leaves in-memory plant config out of sync with the database on any server-side rejection, with no toast and no revert — exactly the failure mode the per-plant constraint registry must avoid. Using raw fetch also bypasses the documented x-request-id tracing of Util.fetchTraced.

**Recommendation.** Check `if (!res.ok)` (and route through Util.fetchTraced) and either roll back the optimistic Object.assign on failure or apply it only after a 2xx. Surface a toast on non-2xx, not just on network rejection.

**Evidence.**

```
Object.assign(plantRow, patch); try { await fetch(`${Config.API_BASE}/master-data/plants/bulk`, { method:'POST', headers:{...}, body: JSON.stringify(...) }); } catch (e) { Toast.show(...); }   // no res.ok check; same shape in saveConstraints
```
> _Verifier note:_ Verified at 14640-14749. Narrowed to the optimistic-write-without-ok-check + raw-fetch issue (real correctness gap). DROPPED the hardcoded-email angle from this finding's emphasis — see Dropped — because it is an app-wide documented stopgap (12 identical occurrences), not localized here.


### 22. [MED · Duplication] Worker reimplements getPlantForLine with an uncached .find inside the (line x day) capacity loop — O(lines^2 x days) in computeUtilization, the exact cost the main-thread cache eliminated

**Location:** `app.js` lines app.js 860-870 (cached original); nimbus-worker.js 91-96 (uncached port), 195 + 444-449 (hot loop)  |  **Confidence:** medium

**Problem.** Store.getPlantForLine's resolution rule (lineSettings.plant first, then masterData.lines match) is hand-ported into nimbus-worker.js (91-96) WITHOUT the _lineToPlant O(1) cache app.js added — the worker does `(masterData?.lines ?? []).find(...)` on every call. In computeUtilization the matrix loop (444-449) calls dailyCapacityHours per (line x day); dailyCapacityHours calls getPlantForLine directly at worker line 195, and workWindow calls it again at 148. The _wwCache memoizes workWindow results per line|day but not getPlantForLine itself, so getPlantForLine runs at least once per unique (line, day), each an O(lines) .find → O(lines^2 x days).

**Why it matters (architect view).** The worker is the path specifically meant to keep heavy compute off the main thread, so it is the one that most needs the cache. At 3,500 lines x N-day horizon this reintroduces the O(n^2) the app.js cache was added to kill. Separately, the resolution rule now lives in two files with different data structures; any future change (e.g. the roadmapped plant-aware make_id / line-reuse-across-plants) must be edited in both, and a missed edit silently desyncs worker alerts/utilization from the sync fallback. Note the alerts path already added a _plantCache (worker 259-263) — the utilization path conspicuously did not, so this is an inconsistency within the worker itself.

**Recommendation.** Pass the already-built line→plant map into the worker snapshot (a small flat object) and have the worker resolve via map lookup. Better: serialize the resolved plant onto each task in the snapshot (Store already materializes t.PLANT) so the worker never resolves plant in a loop — eliminating the duplicated rule rather than mirroring it. At minimum, mirror the alerts path's _plantCache into computeUtilization.

**Evidence.**

```
worker 94: const mdLine = (masterData?.lines ?? []).find(r => r.production_line === line); worker 195/148 call this per (line,day); worker 259-263 alerts path DOES memoize via _plantCache but utilization (435-505) does not.
```
> _Verifier note:_ Verified worker 91-96 uncached, 444-449 calls dailyCapacityHours per (line,day), 195 calls getPlantForLine per call. Confirmed _wwCache (131,251,437) memoizes workWindow but NOT getPlantForLine, so the .find still runs per unique pair. Confirmed alerts path has _plantCache but utilization path does not — strengthens the finding.


### 23. [MED · Duplication] Two near-identical blackout-index builders (_indexBlocks vs _indexCapacityBlocks) with divergent bucketing — silent drift hazard

**Location:** `app.js` lines _indexBlocks 1021-1043; _indexCapacityBlocks 1112-1127; consumers _overlapsBlock 1256-1273 and dailyCapacityHours 1139-1142  |  **Confidence:** high

**Problem.** Calendar._indexBlocks(plant) (the Engine-run cache) and Calendar._indexCapacityBlocks() (the matrix cache) both iterate Store.blocks + Store.plantBlocks, parse start/end via Util.parseDate, and bucket the results — but bucket DIFFERENTLY. _indexBlocks puts line-less/plant-less blocks under a literal '__any__' map key and stores both ms and Date forms ({s,e,startDate,endDate}); _indexCapacityBlocks puts them in separate globalLine/globalPlant arrays and stores Date-only {s,e}. Their two consumers must therefore special-case each shape: _overlapsBlock reads '__any__' (1256-1273); dailyCapacityHours reads globalLine/globalPlant (1139-1142).

**Why it matters (architect view).** The same business rule (which blackout blocks apply to a line/plant, including line-less 'applies-to-all' blocks) is encoded in two parse-and-bucket functions plus two distinct consumers. A future change to blackout semantics (e.g. a new subnetwork scope, or the line-code-reuse-across-plants fix flagged in CLAUDE.md/MIGRATION.md) must land in both, and nothing fails loudly if only one is updated — capacity and the optimizer would then disagree about which days are blacked out.

**Recommendation.** Collapse to one index builder returning a single canonical shape ({byLine, byPlant} maps with an '__any__' bucket and pre-parsed ms+Date) consumed by both the Engine-run cache and the matrix path. The per-run vs per-matrix lifetime difference is only where the result is stored, not a reason for two parsers.

**Evidence.**

```
_indexBlocks 1027/1030: const key = b.line || '__any__'; ... arr.push({ s: s.getTime(), e: e.getTime(), startDate: s, endDate: e });  vs _indexCapacityBlocks 1117/1118: if (b.line) {...a.push({ s, e });} else globalLine.push({ s, e });
```
> _Verifier note:_ Both builders and both consumers verified at the cited lines; the shape and bucketing divergence is real and the drift hazard is genuine.


### 24. [MED · Duplication] Heat-map color engine (lerpRGB + heatBg + heatText) is copy-pasted in 3 places and will silently drift

**Location:** `app.js` lines 2785-2797 (_renderLinePlan), 2920-2934 (_renderCapacity), 7928-7946 (_renderHeatmap)  |  **Confidence:** high

**Problem.** The hex-lerp interpolation (`lerpRGB`), threshold-banding (`heatBg` with 0/0.5/1.0/+0.25 bands), the light/dark palette constants (`#252730/#7a5a18/#a8520f/#b32a1f` dark, `#ede8de/#c8a95a/#c96a1a/#991b1b` light) and a `heatText` variant are defined inline three separate times: in `_renderLinePlan` (lerpRGB at 2785, heatBg at 2792), again verbatim in `_renderCapacity` (2921/2928, plus heatText at 2934), and a third near-twin in Dashboard `_renderHeatmap` (lerpRGB at 7928, heatBg at 7937, heatText at 7943). Only the local variable names differ (idle/low/mid/hot vs idleBg/lowMid/midHi/hot); the numeric palette and band math are identical.

**Why it matters (architect view).** Labor Line-Plan, Labor Capacity, and the Dashboard utilization heatmap all color req/avail ratios. If a designer retunes the overload band or amber ramp, an engineer must edit all three blocks identically or the three views will color the same data differently — a trust issue in a planning tool. The logic is a closure inside an async render, so it cannot be unit-tested.

**Recommendation.** Extract a single `Util.heatScale(isDark)` factory returning `{ bg(ratio), text(ratio) }` (or a small `Heat` module) with the palette and bands defined once; have all three sites call it. Optionally move the palette to CSS custom properties so dark-mode tuning is data, not code.

**Evidence.**

```
Verified identical: 2785 `function lerpRGB(a, b, t)` + 2792 `function heatBg(ratio){ if(ratio<=0) return idle; ... return lerpRGB(mid, hot, Math.min((ratio-1.0)/0.25,1)); }` reproduced verbatim at 2921/2928 and at 7928/7937. Palette constants identical across all three.
```
> _Verifier note:_ Verified all three sites exist with identical palette + band math; downgraded severity to medium — it is pure duplication with no live correctness bug today, real maintainability/drift risk but not high-impact.


### 25. [MED · Duplication] Overload auto-fix re-derives the optimizer's free-set predicate by hand — drifts from runAndApply's real eligibility logic

**Location:** `app.js` lines 4265-4285  |  **Confidence:** high

**Problem.** applyFix for overload (4265-4285) snapshots tasks using a hand-written predicate `(!t.end_date || t.end_date >= dayStart) && (!t.start_date || t.start_date <= dayEnd)` (4279-4280) with a comment (4273-4276) explicitly stating it must be a SUPERSET of what runAndApply's free-set predicate (4720-4722: `!(respectFixed && isFixed) && !isAged && !isOutOfWin`) will move. The two predicates live ~440 lines apart and are maintained independently.

**Why it matters (architect view).** Documented landmine: the comment at 4267-4269 admits a previous version mismatched the snapshot scope so 'undo silently lost every cross-line/cross-day move.' If runAndApply's eligibility (isAged/isOutOfWin/respectFixed) changes, this snapshot predicate must be manually re-synced or undo silently corrupts state again. Correctness-critical state captured by a duplicated, hand-aligned rule.

**Recommendation.** Have Engine.runAndApply expose (or return) the exact set of task IDs it considered movable for given opts, and have applyFix snapshot precisely that set — eliminating the parallel predicate. Alternatively factor the free-set predicate into one Engine._movableIds(opts) used by both.

**Evidence.**

```
4277-4281 `UndoStack.snapshotTasks(Store.tasksArr.filter(t => (t.PRODUCTION_LINE||'Unknown')===line && (!t.end_date || t.end_date >= dayStart) && (!t.start_date || t.start_date <= dayEnd)).map(t=>t.id))` paired with 4720-4722 `freeTasks = tasks.filter(t => !(respectFixed && Store.isFixed(t.id)) && !isAged(t) && !isOutOfWin(t))`.
```
> _Verifier note:_ Verified both predicates and the explicit SUPERSET comment at 4273-4276. The hazard is real and self-documented as a past bug source. Note the two are deliberately NOT identical (snapshot is intentionally broader), so the fix is to derive the snapshot set FROM the optimizer, not to make the predicates equal.


### 26. [MED · Duplication] OptimizeDialog._buildPlantSelect rebuilds the plant universe inline instead of using Store.knownPlants()

**Location:** `app.js` lines 4900-4901  |  **Confidence:** high

**Problem.** _buildPlantSelect re-derives the plant list by hand: `const dynamic = Store.tasksArr.map(t => Store.getPlantForLine(t.PRODUCTION_LINE)).filter(Boolean); _allPlants = [...new Set([...Config.KNOWN_PLANTS, ...dynamic])].sort();`. This is a parallel, divergent copy of Store.knownPlants() (line 925), which deliberately PREFERS master-data plants and returns them ALONE when present, falling back to KNOWN_PLANTS + order-derived discovery only when master data is empty.

**Why it matters (architect view).** CLAUDE.md states KNOWN_PLANTS is only a fallback seed and the authoritative onboarding path is the Master Data plants table. The inline version ALWAYS unions in the hardcoded seeds ('5512','1006'), so when master data is populated the optimizer dialog can show phantom seed plants that no longer exist, and OMIT master-data plants that have no orders yet (it discovers plants only via tasksArr, never via masterData.plants). It is exactly the silent-drift trap of two implementations of one rule — Store.knownPlants() already solves this correctly.

**Recommendation.** Replace lines 4900-4901 with `_allPlants = Store.knownPlants();` so the dialog inherits the single authoritative master-data-first source and stays correct as the plant set grows.

**Evidence.**

```
Line 4900-4901: `const dynamic = Store.tasksArr.map(t => Store.getPlantForLine(t.PRODUCTION_LINE)).filter(Boolean); _allPlants = [...new Set([...Config.KNOWN_PLANTS, ...dynamic])].sort();` vs Store.knownPlants() at 925-936 which returns masterData plants alone when present.
```
> _Verifier note:_ Verified: code matches at 4900-4901; Store.knownPlants() at 925-936 is master-data-first and is the authoritative accessor CLAUDE.md describes. Severity reduced high->medium: it is a real correctness/drift bug but scoped to the optimize dialog's plant picker, not app-wide.


### 27. [MED · Duplication] Conflict/alert-to-task Set is derived three times and rebuild() ignores its own memo

**Location:** `app.js` lines 5974-5983 (_conflictIds memo); 5990 (_itemForTask uses memo); 6077-6078 + 6099-6103 (rebuild inline set + re-apply)  |  **Confidence:** high

**Problem.** The 'task IDs with an active alert' set is built in three places: (1) the memoized `Timeline._conflictIds()` (5974), which `_itemForTask` already consults at 5990 to stamp the conflict-order class; (2) a fresh inline `conflictIds` Set rebuilt from `Store.alerts` inside rebuild() at 6077-6078; and (3) a second application at 6099-6103 that re-checks each task against that inline set and re-adds conflict-order to the className `_itemForTask` already set. rebuild() therefore computes conflict membership twice per task and bypasses its own memo.

**Why it matters (architect view).** Three parallel implementations of one rule drift over time, and the comment at 6076 ('fixes snapshot inconsistency') shows the author already hit a drift bug here. The 6096-6103 loop is also wasted O(tasks) work re-deriving a flag _itemForTask already stamped from the same alert array.

**Recommendation.** Delete the inline `conflictIds` Set (6077-6078) and the re-application (6099-6103); rely on `_itemForTask` -> `_conflictIds()` everywhere. The memo is already invalidated on alerts:change (`_conflictSrc = null` at 5950) and self-rebuilds against `Store.alerts` identity, so there is no snapshot-consistency reason to recompute inline.

**Evidence.**

```
const conflictIds = new Set();
for (const a of Store.alerts) if (a.taskId != null) conflictIds.add(String(a.taskId));  // 6077-6078
... if (conflictIds.has(String(t.id))) { ... if (!cls.includes('conflict-order')) cls.push('conflict-order'); }  // 6099-6103
```
> _Verifier note:_ Verified _conflictIds memo (5974-5983), its use in _itemForTask (5990), the inline rebuild Set (6077-6078) and the redundant re-apply (6099-6103). _conflictSrc invalidation on alerts:change confirmed at 5950. The double-compute is genuine.


### 28. [MED · Duplication] Incompatible inline esc() HTML-escapers: the single-quote-omitting variant feeds values into single-quoted JS args inside onclick attributes

**Location:** `app.js` lines 7173 (escapes '), 7586/8018/8109/8260/8315 (do NOT escape '); sink at 8274; ~18 such lambdas file-wide  |  **Confidence:** high

**Problem.** Within the Inspector/Dashboard slice there are 6 separately-defined esc/_esc lambdas (lines 7173, 7586, 8018, 8109, 8260, 8315) that are NOT equivalent: the Inspector one (7173) escapes the single quote (`[&<>"']` → includes `'` → `'`), but the Dashboard ones (7586, 8018, 8109, 8260, 8315) escape only `[&<>"]` — no single quote. Across the whole file the split is ~6 apostrophe-escaping vs ~12 not (19 inline lambdas total; no shared Util helper exists). Several Dashboard sinks interpolate the weaker-escaped value INTO single-quoted JS string arguments inside onclick attributes — most clearly line 8274 `onclick="NIMBUS.Dashboard._latenessDrill('${esc(line)}','${dk}')"` where esc is the line-8260 variant. A line code containing an apostrophe (PRODUCTION_LINE is user-supplied via Excel ingest) is escaped for `<>&"` but its `'` passes through, breaking out of the JS string literal — an injection/breakage hazard the Inspector's stronger variant would have caught.

**Why it matters (architect view).** Copy-paste drift of a security-relevant primitive: the same conceptual function exists in two incompatible forms, and the weaker form sits exactly where output crosses into a JS-string context inside an HTML attribute. A linter cannot flag it because each lambda is locally valid. Line/material codes are attacker-influenceable through Excel ingest, so this is a real escaping gap, not theoretical.

**Recommendation.** Hoist ONE escaper into Util (e.g. Util.escHtml that always escapes `&<>"'`) and delete the inline copies. For values placed inside inline `on*="...'${x}'..."` handlers, prefer delegated listeners reading data-* attributes (the util-heatmap cells already carry data-line/data-date) so the JS-string-context escaping problem disappears at the root.

**Evidence.**

```
Line 7173: `.replace(/[&<>"']/g, c => ({ ... "'":''' }[c]))` — escapes apostrophe. Line 8260: `.replace(/[&<>"]/g, ...)` — does NOT. Sink line 8274: `onclick="NIMBUS.Dashboard._latenessDrill('${esc(line)}','${dk}')"`. Grep confirms no `Util.escHtml`/`Util.esc` exists.
```
> _Verifier note:_ Grep confirmed 19 inline esc lambdas, split into the two incompatible classes; 6 in-slice (finding said '7' but listed 6 — corrected to 6 in-slice / ~18-19 file-wide). The single-quote sink at 8274 fed by the non-escaping 8260 variant is real; PRODUCTION_LINE origin (Excel ingest) confirmed via CLAUDE.md.


### 29. [MED · Duplication] Duplicated alert-visibility/horizon-cutoff logic in _renderKPIs and _renderAlertSummary has already drifted (KPI count ignores the line filter the summary honors)

**Location:** `app.js` lines 7731-7742 (_renderKPIs), 8081-8090 (_renderAlertSummary)  |  **Confidence:** high

**Problem.** The same alert-visibility computation — `new Set(Store.linesForSelectedPlant())`, find plantRow, read `alt_flag_horizon ?? userSettings.alertHorizonMinutes`, compute cutoff = now + hz*MS_MIN, then filter Store.alerts by (a.line in plantLines) and (a.time <= cutoff) — is implemented twice: _renderKPIs (lines 7731-7739) and _renderAlertSummary (lines 8081-8090). They have ALREADY diverged: _renderAlertSummary additionally applies `Dashboard._filterLines` (line 8087) while _renderKPIs does not, so the KPI 'open alerts'/'conflicts' tile counts and the alert-summary list count disagree for the same view whenever a line filter is active.

**Why it matters (architect view).** Classic 'same rule in two places' that already produced a user-visible inconsistency: two counts meant to agree don't when a line filter is on. Future changes to the horizon/scope rule must be mirrored manually with no guard — the same drift hazard CLAUDE.md documents for the worker mirror, but here undocumented and within one module.

**Recommendation.** Extract one helper, e.g. Dashboard._visibleAlerts({ applyLineFilter }), that owns plantLines + horizon cutoff + the optional line filter, and have both callers consume it. Decide deliberately whether the KPI tiles should reflect the line filter and encode that decision in the single helper.

**Evidence.**

```
Lines 7735-7739 (KPIs): filter on `!plantLines.has(a.line)` and `a.time > alertCutoff` only. Lines 8085-8090 (summary): identical plus line 8087 `if (Dashboard._filterLines.size > 0 && a.line && !Dashboard._filterLines.has(a.line)) return false;`.
```
> _Verifier note:_ Read both blocks; the divergence (line filter applied in summary at 8087, absent in KPIs) is exactly as described and produces a real count mismatch when _filterLines is non-empty.


### 30. [MED · Duplication] HTML-escape helper hand-rolled inline ~19 times across app.js with divergent null handling and entity sets (3 copies in this slice)

**Location:** `app.js` lines 8672-8673, 8723-8724, 8766-8767  |  **Confidence:** high

**Problem.** The same `esc`/`_esc` escape helper is redeclared inline in `_buildLineDropdown`, `_buildColorDropdown`, and `_buildFormDropdown` here, and ~16 more times elsewhere (grep: 1858, 3387, 3990, 4189, 6598, 6615, 6979, 7022, 7173, 8018, 8109, 8260, 8315, 9414, 9943). The copies drift in null handling (`String(s)` vs `String(s ?? '')` vs `String(s || '')` vs `String(s == null ? '' : s)`) AND in coverage (some escape the single-quote `'`, e.g. 3990/7173/9943, while the three here and several others do not).

**Why it matters (architect view).** An escaping helper is a security-relevant primitive for attribute-interpolated innerHTML. A dozen-plus hand-rolled copies that already disagree on single-quote escaping and null coercion mean any hardening must be applied in ~19 places, and the existing variance is itself a latent XSS-surface inconsistency.

**Recommendation.** Promote one `Util.escapeHtml` with consistent `String(s ?? '')` and a full attribute-safe entity set (including `'`), and replace every inline `esc`/`_esc`. The three dropdown builders here are otherwise near-identical and could share a single `_buildCheckboxDropdown(dropId, values, selectedSet, onchangeName)` helper.

**Evidence.**

```
8672-8673: const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&','<':'<','>':'>','"':'"' }[c]));  (identical at 8723 and 8766; contrast 3990/7173 which use String(s == null ? '' : s) and add the ' entity).
```
> _Verifier note:_ Grep verified 19 inline copies with four distinct null-coercion forms and two distinct entity sets (with/without single-quote). No existing Util.escapeHtml. Duplication and drift are real and security-adjacent.


### 31. [MED · Duplication] Master-data fetch + hydrate block is copy-pasted 3x inside load() (4th near-copy in MasterData)

**Location:** `app.js` lines 10760-10772 (no-plant), 10802-10814 (zero-task), 10917-10932 (happy path); 4th variant at 15439-15453 in MasterData  |  **Confidence:** high

**Problem.** The 'Promise.all([fetch /master-data/plants, fetch /master-data/production_lines]) → assign Store._state.masterData = {plants, lines} → Store._rebuildPlantIndex() → emit master-data-changed' sequence is written verbatim three times inside the single load() function (no-plant, zero-task, and happy paths), differing only in the .catch wording. A near-identical fourth copy lives in the MasterData save handler at 15439-15453 (it uses the local `API` alias instead of Config.API_BASE and emits inside the .then rather than unconditionally).

**Why it matters (architect view).** The plant index rebuild and masterData shape assembly are duplicated across paths, two of which (no-plant, zero-task offline) are rarely exercised. When the masterData shape changes — e.g. paginating/filtering plants at the 50+ scale the roadmap mandates, or adding a third entity — a developer must edit all four sites; missing the zero-task or no-plant copy silently hydrates a stale/partial plant index on a load path nobody tests. It also triples the maintenance surface for the AbortSignal timeout and the r.ok/null-coalescing guards.

**Recommendation.** Extract one private Persistence._hydrateMasterData({ onError }) that owns the two fetches, the Store._state.masterData assignment, Store._rebuildPlantIndex(), and the emit; call it from all three load() branches. Refactor the MasterData copy at 15439 to reuse it as well. Then server-side pagination/filtering for 50+ plants is a one-place change.

**Evidence.**

```
Verified verbatim at 10765-10770, 10807-10812, 10922-10927: `Store._state.masterData = { plants: pData?.rows ?? [], lines: lData?.rows ?? [] }; Store._rebuildPlantIndex(); Store.emit({ type: 'master-data-changed', source: 'persistence' });`, each preceded by the identical `Promise.all([ fetch(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) })...`. Fourth copy confirmed at 15440-15450.
```
> _Verifier note:_ Grep confirms exactly 4 occurrences of the master-data/plants fetch block; read all four. 3 are inside load(), 4th is in the MasterData IIFE (uses `API`, emits inside .then). Duplication is real; downgraded severity from high to medium (pure ~12-line duplication) but the untested-path drift hazard plus roadmap pagination justifies keeping.


### 32. [MED · Duplication] Two near-identical horizontal-bar chart builders (_dbHBarChart vs _dbSlowQueryBars) — copy-paste that will drift

**Location:** `app.js` lines 12918-12950 (_dbHBarChart), 12953-12986 (_dbSlowQueryBars)  |  **Confidence:** high

**Problem.** _dbHBarChart (index usage) and _dbSlowQueryBars (slow queries) are the same chart widget built twice: both create a .admin-db-hbar-chart wrap, then per row a .admin-db-hbar-row with .admin-db-hbar-names, .admin-db-hbar-track > .admin-db-hbar-fill, a .admin-db-hbar-val chip and a .admin-db-hbar-size chip. They differ only in (a) min-pct flooring (`Math.max(ix.unused ? 0 : 1, …)` vs `Math.max(1, …)`), (b) fill-class derivation (`ix.unused` vs `>500/>100` -> err/warn), and (c) which two text values fill the chips.

**Why it matters (architect view).** Two hand-maintained copies of the same widget guarantee silent drift: a styling/accessibility fix or a class-threshold change applied to one chart will not reach the other. CLAUDE.md already documents that this codebase fights exactly this kind of mirror-drift (the worker hand-port).

**Recommendation.** Extract one `_dbHBar(rows, { label, valueText, sizeText, fillClass, minPct })` helper taking per-row accessor callbacks; have both call it. Both already share the `admin-db-hbar-*` CSS classes, so the markup is identical — only the row->{label,value,class} projection differs.

**Evidence.**

```
_dbHBarChart 12919/12938: `const maxScans = Math.max(...indexes.map(ix => ix.scans ?? 0), 1); … fill.className = \`admin-db-hbar-fill${ix.unused ? ' unused' : ''}\`;`  vs  _dbSlowQueryBars 12954/12972: `const maxMs = Math.max(...queries.map(q => q.mean_ms ?? 0), 1); … fill.className = \`admin-db-hbar-fill${cls ? ' ' + cls : ''}\`;` — same `admin-db-hbar-chart` wrap, same row scaffold.
```
> _Verifier note:_ Verified both functions at 12918-12986; markup is structurally identical, no shared helper exists (grep for _dbHBar found nothing). Line range corrected (was 12918-12986 lumped).


### 33. [MED · Duplication] _renderBackendLog and _renderLogs are parallel functions building the same log-row DOM

**Location:** `app.js` lines 13141-13214 (backend row build), 13333-13398 (frontend row build)  |  **Confidence:** high

**Problem.** Both functions build an `.admin-log-row` with an identical head (level span, ts via _relTime, scope/category span, optional error-code chip whose click sets a filter, optional reqId chip whose click calls AdminCockpit._correlateReqId, a msg div, and an optional expandable ctx <pre> with a click-to-toggle 'expanded'). The only real differences are field-name aliasing (`e.level || 'info'`, `e.category` vs `e.scope`, `e.rid || e.reqId` vs `e.reqId`, `e.error_code || e.errorCode`) and the frontend-source 'FE' badge.

**Why it matters (architect view).** The reqId chip, error-code chip, ctx-expand toggle, and timestamp rendering are reimplemented twice; a fix to the reqId-correlation click or the ctx-expand behavior must be made in two places or the FE/BE panes diverge — the same drift hazard CLAUDE.md documents for the worker mirror.

**Recommendation.** Extract `_logRow(entry, { showSource, scopeColors })` returning the row element from a normalized entry, plus a small `_normalizeLogEntry` that resolves the alias pairs (`rid||reqId`, `category||scope`, `error_code||errorCode`). Both renderers then loop and append `_logRow`.

**Evidence.**

```
Backend 13185-13195: `const rid = e.rid || e.reqId; … ridEl.addEventListener('click', ev => { ev.stopPropagation(); AdminCockpit._correlateReqId(rid); });` duplicated at frontend 13371-13380: `if (e.reqId) { … rid.addEventListener('click', ev => { ev.stopPropagation(); AdminCockpit._correlateReqId(e.reqId); }); }`.
```
> _Verifier note:_ Verified both row-build loops; structure and the reqId/code/ctx handlers are parallel. Corrected the '~150-line' claim — each row-build body is ~70 lines; finding stands as duplication. No shared _logRow exists (grep clean).


### 34. [MED · Duplication] KEY_COLS / FK_SOURCE / TABLE_LABELS hardcode the five master tables in the frontend, duplicating backend authority and drifting from runtime DDL

**Location:** `app.js` lines 14812-14834 (the three maps), 15131-15134 (valCol/labelCol heuristic)  |  **Confidence:** high

**Problem.** The module hardcodes per-table primary keys (KEY_COLS, 14821), FK parent mappings (FK_SOURCE, 14830), labels (TABLE_LABELS, 14812), and an inline rule that the FK value column is 'the last key column' and the label column is 'name only for subnetworks' (15133-15134). The backend master_data.py independently owns ALLOWED_TABLES, _KEY_COLUMNS, and column_metadata. Two sources of truth for the same schema facts.

**Why it matters (architect view).** Any schema change — a new master table, a renamed key, a new FK relationship, or a column added via the module's own add-column DDL — must be edited in both places or the grid silently mis-keys rows (wrong _rowKey -> wrong upsert/delete target) or shows the wrong FK label. The 'last key column' / 'subnetworks->name' heuristic is a hidden special-case that breaks the moment another table needs a human-readable label column. This contradicts the roadmap goal of onboarding plants via data, not code edits.

**Recommendation.** Have the /master-data/{table} response (or a /master-data/meta endpoint) return key columns, FK relationships, value/label column hints, and labels as metadata, and drive the grid from that. Delete the hardcoded KEY_COLS/FK_SOURCE/TABLE_LABELS maps and the inline valCol/labelCol heuristic.

**Evidence.**

```
14821 `const KEY_COLS = { subnetworks: ['code'], plants: ['subnetwork','plant'], ... }`; 14830 `const FK_SOURCE = { plants: { subnetwork: 'subnetworks' }, ... }`; 14812 `const TABLE_LABELS = {...}`; 15133 `const valCol = srcKeys[srcKeys.length - 1];`; 15134 `const labelCol = sourceTable === 'subnetworks' ? 'name' : valCol;`. Backend list_rows already returns column metadata (master_data.py:101-112) including is_locked/display_label.
```
> _Verifier note:_ Verified all three maps and the inline heuristic at cited lines; backend already serves per-column metadata (display_label/is_locked) so the recommendation to push key/FK hints server-side is feasible.


### 35. [MED · Inefficiency] Hierarchy today-summary calls dailyCapacityHours with no block index — re-parses every blackout per visible line, per render

**Location:** `app.js` lines callsite 7450; slow re-parse branch 1143-1155; helper _indexCapacityBlocks 1112-1127; idx pattern at 4388/4482  |  **Confidence:** high

**Problem.** dailyCapacityHours(line, date, idx) takes an optional pre-parsed block index (built by _indexCapacityBlocks) specifically to avoid re-parsing Store.blocks/Store.plantBlocks per call. The two matrix loops correctly pass blockIdx (4388, 4482). But the Hierarchy lane summary at 7450 calls Calendar.dailyCapacityHours(name, todayStart) with NO third arg, so it falls into the else branch (1143-1155) that re-parses EVERY block in Store.blocks and Store.plantBlocks via Util.parseDate, for every visible lane, on every Hierarchy render.

**Why it matters (architect view).** The Hierarchy._lineItems map at 7440 iterates visibleNames (the selected plant's lines, up to ~70 per the roadmap) and re-renders on Store mutations. Each render pays O(visibleLines × blocks) Date-parses on a hot path — exactly the per-cell re-parse the index was built to eliminate. The fix is one line and the helper already exists. (Scope note: this is one plant's lines, not the full 3,500 — bounded, hence medium not high.)

**Recommendation.** Build the index once before the map and thread it through: const _capIdx = Calendar._indexCapacityBlocks(); then Calendar.dailyCapacityHours(name, todayStart, _capIdx) — identical to the pattern already used at 4388 and 4482.

**Evidence.**

```
Line 7450: const cap = Calendar.dailyCapacityHours(name, todayStart);  // no idx -> 1143 else branch re-parses all blocks.  Line 4388: const cap = Calendar.dailyCapacityHours(line, d, blockIdx);
```
> _Verifier note:_ Confirmed 7450 passes no idx and 1143-1155 is a full re-parse; idx fast-path and the 4388/4482 pattern verified. Corrected the citation: the matrix idx callsites are 4388/4482 (also 3785), and the loop iterates linesForSelectedPlant (one plant), which I noted to right-size severity.


### 36. [MED · Inefficiency] _fetchLines has no cache guard — labor sub-tabs refetch the full line·day matrix on every render, group toggle, and horizon nudge

**Location:** `app.js` lines 2393-2412 (_fetchLines, no guard), 2769/2905/2966 (call sites), 3163-3168 (horizon/span), 3133-3151 (toggle/clear handlers)  |  **Confidence:** high

**Problem.** `_fetchAggregate` (2374-2375) short-circuits with `if (_aggrData[plant]) return _aggrData[plant]`, but `_fetchLines` (2393) has no equivalent hit-check — it always issues `GET /labor-plan/line?...` and merges into `_lineData`. `_renderLinePlan` (2769), `_renderCapacity` (2905), and `_renderExceptions` (2966) each `await _fetchLines(...)` unconditionally. `onGroupToggle`/`clearGroupFilter` (3133-3151) re-run the active sub-render (another fetch), and `prevHorizon`/`nextHorizon`/`setSpan` (3163-3168) call `render()` which re-fetches AND rebuilds `Utilization.computeMatrix` for up to 84 days.

**Why it matters (architect view).** At target scale (70+ lines/plant, 12-16 week horizons) every group-checkbox toggle issues another `/labor-plan/line` query plus a matrix rebuild. A planner toggling 4 groups fires 4 sequential network round-trips. Because the fetch merges with no invalidation, it is also pure repeated work even when nothing changed.

**Recommendation.** Give `_fetchLines` the same `(plant, from_date, to_date, group)` cache key + in-flight de-dupe `_fetchAggregate` already has, refetching only when the date window actually changes. Group toggles that don't change the window should re-render from cached `_lineData` without a network call. Memoize the per-render `Utilization.computeMatrix(horizonStart, days)` across the labor sub-renders in one pass.

**Evidence.**

```
2374 `if (_aggrData[plant]) return _aggrData[plant];` (guarded) vs 2393 `async function _fetchLines(plant, group){ ... const res = await fetch(url) ... }` (no guard); 2769/2905/2966 `await _fetchLines(...)`; 3163 `prevHorizon(){ _horizonOffset -= _horizonSpan; render(); }`.
```
> _Verifier note:_ Verified _fetchLines genuinely lacks the guard _fetchAggregate has, and all three call sites + toggle/horizon paths re-invoke it. Reworded the 'N+1' framing (it is one batched range query per call, not N per-line queries) and set severity medium.


### 37. [MED · Inefficiency] Aggregate edits await a synchronous per-cell POST and re-scan all plant lines per cell; paste does R×C full-line disaggregation passes

**Location:** `app.js` lines 2660-2693 (onchange), 2696-2754 (paste), 2415-2435 (_disaggregate)  |  **Confidence:** high

**Problem.** Each aggregate cell `onchange` (2661) ends with `await _saveAggregate(...)` — one HTTP POST per cell — and calls `_disaggregate(plant, grp, period, ah)` (2673) which re-filters `Store._state.masterData.lines` and walks `Calendar.effectiveCapacityHours(line, date)` over 7 days for every line in the group (2423-2429), then `_saveLines`. The paste path (2709-2724) loops every clipboard cell and pushes `..._disaggregate(...)` per cell (2723), so pasting an R×C block does R×C independent full-line scans + capacity computations, with no memo of `effectiveCapacityHours` across cells of the same line/week.

**Why it matters (architect view).** Only the KPI strip is debounced (`_renderKPIsDebounced`, 2500); the writes and the O(lines×7) disaggregation are not. A 12-week × 10-group paste = 120 disaggregation passes, each re-deriving the line list and recomputing calendar capacity for the same lines/weeks, and the per-cell `await` serializes network latency. Note the LinePlan render at 2810 already proves the memo pattern (`_capFor` Map) — _disaggregate does not reuse it.

**Recommendation.** Batch persistence: accumulate changed cells and POST once per paste/edit-burst (the paste already collects `changed`/`allSplits` arrays — defer the per-cell awaits). Hoist a per-render `effectiveCapacityHours(line,date)` memo into `_disaggregate` (reuse the `_capFor` pattern at 2811) and compute the open-slot set per (group,week) once instead of per cell.

**Evidence.**

```
2691 `await _saveAggregate(sn, plant, [{ pl_group: grp, period, avail_hours: ah }]);` (per cell, onchange); 2723 `if (ah !== null) allSplits.push(..._disaggregate(plant, grp, period, ah));` (per pasted cell); 2426 `if (Calendar.effectiveCapacityHours(line, date) > 0)` inside the per-line×7-day loop.
```
> _Verifier note:_ Verified per-cell await + per-cell _disaggregate in both onchange and paste paths, and the lack of a capacity memo inside _disaggregate. Note the paste already batches _saveLines into one allSplits POST (2734) but still awaits _saveAggregate per the changed array at 2753 — corrected wording accordingly. Severity medium.


### 38. [MED · Inefficiency] Utilization.dayByLine is O(lines × tasks) — re-scans the entire task list once per line, unmemoized

**Location:** `app.js` lines 4472-4526  |  **Confidence:** high

**Problem.** The outer `for (const line of lines)` (4481) wraps an inner `for (const t of taskList)` (4493) that scans every task and skips with `if ((t.PRODUCTION_LINE||'Unknown') !== line) continue` (4494). For L lines and T tasks the scan is L×T even though each task belongs to exactly one line. The function also rebuilds blockIdx fresh each call (4480) and has no memo; todayByLine() (4466-4468) calls it with `new Date()` on every relevant render.

**Why it matters (architect view).** At the scale roadmap (70+ lines/plant, thousands of orders) this is quadratic main-thread work on a hot summary path with no cache. A plant with 70 lines and 3,000 orders does ~210,000 iterations per call, repeated per today/day-summary render — exactly the cost the memoized matrix path was built to avoid, but dayByLine bypasses it.

**Recommendation.** Bucket tasks by line once into a Map<line, task[]> before the line loop (single O(T) pass), then iterate only that line's bucket inside the loop — drops it to O(T + L). Better: memoize on (dayMs, Store._rev, plant) as computeMatrix already does, and reuse the existing worker prewarm.

**Evidence.**

```
4481 `for (const line of lines) {` … 4493-4494 `for (const t of taskList) { if ((t.PRODUCTION_LINE || 'Unknown') !== line) continue;` — full task scan nested inside the per-line loop; no cache assignment anywhere in the function.
```
> _Verifier note:_ Verified the nested loop, the per-line full-list skip, the fresh _indexCapacityBlocks() each call (4480), and todayByLine delegating to it. Real and matches code. Downgraded high→medium: it is genuinely O(L×T) but is a derived day-summary path (not the dominant matrix path), and tasks are pre-filtered to active by callers in practice; still worth the O(T+L) fix.


### 39. [MED · Inefficiency] _renderLines re-derives the line set + re-scans plant orders + full innerHTML rebuild on every line-filter keystroke

**Location:** `app.js` lines 5016-5064 (filterLines at 5061-5064; _linesForPlant at 5006-5014)  |  **Confidence:** high

**Problem.** filterLines() calls _renderLines() on every keystroke. _renderLines() calls _linesForPlant() — which runs Store.linesForSelectedPlant() (a FULL-SYSTEM Store.allLines() scan over tasksArr+calendars+lineSettings+masterData.lines, then .filter by getPlantForLine), then a per-plant tasks loop, a Set build and a sort — and then independently loops the plant's tasks a SECOND time to compute orderCounts, then maps the full visible list to one innerHTML string (complete <li> teardown/rebuild). selectAllLines() re-derives _linesForPlant() yet again. The line universe and per-line counts are invariant for a fixed plant, yet all of it is recomputed per keystroke.

**Why it matters (architect view).** At the documented 70+ lines/plant target, every character typed re-runs a full-system allLines() scan + plant-tasks scan + Set/sort + total DOM rebuild, when only the filter substring changed. This is avoidable O(allTasks)+O(plantTasks) work plus layout thrash per keystroke. (Note: the plant-tasks loops use Store.tasksByPlant(), which is an O(1) index lookup returning only the plant's tasks — so the per-plant loops are plant-scoped, but the allLines() scan inside linesForSelectedPlant IS full-system.)

**Recommendation.** Compute the {allLines, orderCounts} pair once per plant when scope switches to 'lines' (cache it, invalidate on plant change / Store._rev); have filterLines only re-filter the cached array. Render rows via the existing VirtualList (class at line 434, already used at 4221/7459/8060) or a documentFragment so typing does not rebuild every <li>.

**Evidence.**

```
5008: `const set = new Set(Store.linesForSelectedPlant());` (linesForSelectedPlant at 920-923 → Store.allLines() full scan at 900-911 then .filter). 5009 and 5030: two separate `for (const t of Store.tasksByPlant(_plant))` loops. 5041-5055: full `list.innerHTML = visible.map(...).join('')`. 5061-5063: filterLines → _renderLines on each keystroke.
```
> _Verifier note:_ Verified all cited lines and the allLines() full-system scan path. Corrected magnitude: tasksByPlant is an O(1) index (line 881-882), so the per-plant loops are plant-scoped — but the allLines() scan inside linesForSelectedPlant is full-system, and the double plant-loop + sort + full innerHTML rebuild per keystroke is real. Severity high->medium.


### 40. [MED · Inefficiency] Row-alert styling is computed per-cell via defaultColDef.cellClass instead of once per row

**Location:** `app.js` lines 6390 (defaultColDef.cellClass); 6887-6892 (_rowClass)  |  **Confidence:** high

**Problem.** defaultColDef.cellClass is `p => Table._rowClass(p.data)`, and `_rowClass` calls `Store.alertsByTask().get(String(data.id))` then runs two `.some()` scans. AG Grid evaluates cellClass per cell, so each rendered/refreshed row re-runs this for every column that INHERITS the default — i.e. the columns that do not set their own cellClass (PRODUCTION_ORDER, MATERIAL_DESCRIPTION, PRODUCTION_LINE, COLOR, FORM_SIZE, the alerts and notes columns, plus the no-field checkbox/fixed columns). Note: the cell-num/cell-date columns (id, qty, RUN_TIME, the four date columns) define their OWN `cellClass`, which OVERRIDES the default, so `_rowClass` never runs there — meaning row-alert/row-warn is applied inconsistently (only to some cells of an alerting row, not all).

**Why it matters (architect view).** Row-level styling (row-alert / row-warn) is a property of the ROW. Routing it through per-cell cellClass both multiplies the lookup by the inheriting column count for zero benefit AND produces partial/inconsistent row highlighting because columns with their own cellClass silently drop it. On `alerts:change` the handler calls `redrawRows()` (line 6808) which re-runs this for every cell of every displayed row — exactly the enterprise-scale hot path.

**Recommendation.** Move alert classification to a row-level hook: add `getRowClass: p => Table._rowClass(p.data)` (or `rowClassRules`) to gridOptions and remove `cellClass` from defaultColDef. The `alertsByTask()` memo already makes this O(1) per row, so the cost becomes O(rows) instead of O(rows x inheriting-cols), and it fixes the inconsistent highlighting on the cell-num/cell-date columns at the same time.

**Evidence.**

```
defaultColDef: { ... cellClass: p => Table._rowClass(p.data) }  // 6390
_rowClass(data) { ... const ids = Store.alertsByTask().get(String(data.id)) || []; if (ids.some(a => a.sev === 'err')) return 'row-alert'; ... }  // 6887-6892
```
> _Verifier note:_ Verified cellClass at 6390 and _rowClass at 6887-6892; confirmed no getRowClass/rowClassRules exists anywhere (grep). Corrected the original 'all 13 columns' framing: column-level cellClass overrides the default, so ~8 columns inherit it and the cell-num/cell-date columns get NO row class — a latent inconsistency the original missed. Lowered severity to medium since alertsByTask is memoized O(1).


### 41. [MED · Inefficiency] alerts:change runs a targeted refreshCells AND a full redrawRows() — the refreshCells is dead work and the redraw is a whole-grid DOM teardown

**Location:** `app.js` lines 6806-6811  |  **Confidence:** high

**Problem.** On every alerts:change the handler runs `Table._api.refreshCells({ columns: ['id'], force: true })` immediately followed by `Table._api.redrawRows()`. redrawRows destroys and rebuilds the DOM for every displayed row (including the id/alerts column), so the preceding targeted refreshCells is redundant. redrawRows is being used purely to re-evaluate the per-cell alert class (see related finding) — a sledgehammer for row repainting.

**Why it matters (architect view).** Alerts recompute frequently (drag, edit, optimize, plus downstream recompute). A full redrawRows on each one discards AG Grid's incremental rendering, can flicker and drop in-progress focus/edit, and scales O(displayed rows) per recompute.

**Recommendation.** Move row styling to getRowClass/rowClassRules (related finding) so the DOM teardown is unnecessary, then keep only `refreshCells({ columns: ['id'], force: true })` to repaint the alert-count column and let the row-class rule re-evaluate. If a redraw is still needed, scope it to the affected rows (the alerts payload can carry the changed taskIds) via `applyTransaction`/`redrawRows({ rowNodes })`.

**Evidence.**

```
} else if (evt.type === 'alerts:change') {
  Table._api.refreshCells({ columns: ['id'], force: true });
  Table._api.redrawRows();
```
> _Verifier note:_ Verified at 6806-6808; grep confirms redrawRows() appears only here. Tempered severity to medium (single grid, redraw is bounded by displayed-row count) but the refreshCells-before-redraw redundancy and the teardown are both real.


### 42. [MED · Inefficiency] Lateness heatmap rebuilds the full line×day cell map on every render with no memo, and a single drill-click rebuilds the entire grid

**Location:** `app.js` lines 8176-8297 (build), 8196-8214 (cell map + per-task scan), 8299-8302 (drill), contrast _matrix7Cache at 7670-7678  |  **Confidence:** high

**Problem.** _renderLatenessHeatmap allocates cells[line][dayKey] = {lateHours, lateCount, tasks:[]} for every (line, day) in the horizon (lines 8197-8200), scans all filtered tasks calling Util.scheduledEnd + Util.latenessHours per task (lines 8201-8214), sums per-line totals in another pass (8223-8228), then string-builds the grid. None of this is memoized on (plant, filterLines, _rev, horizon) the way the 7-day util matrix is (Dashboard._matrix7Cache, built at lines 7670-7678 with the explicit 'R14' memo rationale). Worse, clicking a single cell calls _latenessDrill (line 8299) which sets _latenessDrillKey and re-runs the ENTIRE _renderLatenessHeatmap (line 8301) just to surface the drill list — rebuilding the whole grid to render one panel, even though _renderLatenessDrill(cells) (line 8304) already exists and takes the cells map.

**Why it matters (architect view).** This is the heaviest dashboard pass at scale: it allocates lines×horizonDays cell objects (up to 70×28 ≈ 1,960) plus per-task lateness math each render, re-runs on every Store-event-driven render (300ms debounce) AND on every drill click. The 7-day util matrix was explicitly memoized for exactly this reason; the larger lateness map was left uncached.

**Recommendation.** Memoize the cells map on the same scope key shape used for _matrix7Cache (`plant|filterLines|_rev|horizon`) and reuse it across re-renders and drill clicks. Decouple the drill render from the grid render so _latenessDrill only re-renders the drill panel — call the existing _renderLatenessDrill(cachedCells) directly instead of rebuilding the grid via _renderLatenessHeatmap.

**Evidence.**

```
Line 8301: `Dashboard._renderLatenessHeatmap();   // re-render so drill stays in sync` inside _latenessDrill. Cell-map allocation at 8196-8200; per-task scan at 8201-8214. No `_latenessCache` exists (grep confirmed only `_matrix7Cache`). _renderLatenessDrill(cells) defined at 8304 already accepts the cells argument.
```
> _Verifier note:_ Verified the unmemoized rebuild, the drill-triggers-full-grid path at 8301, the existence of a separable _renderLatenessDrill(cells) at 8304, and that no analogous _latenessCache exists while _matrix7Cache does (7673).


### 43. [MED · Inefficiency] TimelineNav schedules a full minimap repaint (computeMatrix + per-task fill) via a raw 50 ms setTimeout on every store mutation — no debounce, timers stack

**Location:** `app.js` lines 8420-8429, 8443-8495  |  **Confidence:** high

**Problem.** The Store subscription (8420-8426) fires on `tasks:bulk | tasks:bulkUpdate | task:update | calendar:change | blocks:change` and each event calls `setTimeout(() => TimelineNav.render(), 50)` — not a debounce, so back-to-back events queue independent timers. render() then runs `Utilization.computeMatrix(...)` over ~44 days (8481), re-derives line colors, re-sorts the line set, and fills one rect per task (8520-8527). A single drag (task:update + autoReflow bulkUpdate) queues two full canvas repaints.

**Why it matters (architect view).** During optimizer-apply or multi-order drag this fires several times in quick succession with no coalescing, each doing a matrix build and an O(tasks) canvas pass on the main thread. The resize handler on the very next line (8428) already uses `Util.debounce`, so the inconsistency is gratuitous.

**Recommendation.** Replace the raw `setTimeout(render, 50)` with `Util.debounce(() => TimelineNav.render(), ...)` keyed to a single pending render (mirroring the resize handler at 8428) so back-to-back events collapse into one repaint. The matrix is already memoized on (start, days, _rev, plant-scope) at 4363, so a single trailing-edge call will hit the cache that the synchronous render path populates.

**Evidence.**

```
8420-8424: TimelineNav._unsubStore = Store.subscribe(evt => { if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate' || evt.type === 'task:update' || evt.type === 'calendar:change' || evt.type === 'blocks:change') { setTimeout(() => TimelineNav.render(), 50); } }, 'TimelineNav');  8428: window.addEventListener('resize', Util.debounce(() => TimelineNav.render(), 100));
```
> _Verifier note:_ Verified raw setTimeout vs the debounced resize handler one line below; render() does call computeMatrix (8481) and an O(tasks) fill loop (8520-8527). Util.debounce confirmed at 259.


### 44. [MED · Inefficiency] Marquee drag fires Selection.set() and its full subscriber cascade (grid deselect/reselect + Inspector re-render) on every hit-set change

**Location:** `app.js` lines 10087-10120, 9808-9839, 10680-10697  |  **Confidence:** high

**Problem.** updateOverlay() runs on every pointermove and every edge-scroll RAF frame. When the intersecting hit-set changes (guarded at 10111-10115) it calls Selection.set([...next]) (10119). Selection.set (9079-9085) emits to ALL subscribers synchronously: the install() handler that calls Timeline._tl.setSelection, may toggle the right sidebar, and re-renders the Inspector multi-view (9808-9838), AND _wireTableSync's handler that does Table._api.deselectAll() then forEachNode over the ENTIRE grid (10686-10691). During a fast marquee over dense items this fires repeatedly, each time re-running a full-grid deselect/reselect loop and an Inspector re-render.

**Why it matters (architect view).** Work per Selection change is O(grid rows) plus DOM writes (setSelection, possible sidebar layout + redraw). Doing it continuously during a 60fps drag rather than once on pointerup is unnecessary DOM thrash that grows with order count — the same layout-in-loop pattern remediated elsewhere (R18/R19), reintroduced via the subscriber fan-out.

**Recommendation.** During an active marquee, update only the lightweight overlay highlight and accumulate the hit-set, committing Selection.set ONCE on pointerup (onPointerUp, 10228). If live selection feedback is required, add a transient/silent flag to Selection.set so mid-drag updates skip the heavy Table-sync and Inspector re-render subscribers and only repaint the timeline highlight.

**Evidence.**

```
10119: Selection.set([...next]);  // inside updateOverlay, per frame when hits change
10687: Table._api.forEachNode(node => { if (node.data && evt.ids.includes(String(node.data.id))) node.setSelected(true, false); });
```
> _Verifier note:_ Verified updateOverlay's per-frame Selection.set at 10119 (with its own hit-change guard at 10111), the Selection.set→_emit fan-out (9084), and the full-grid forEachNode in _wireTableSync (10686-10691). Real. Note Selection.set has a _setsEqual no-op guard (9081) so it only fires on genuine hit-set changes — the finding already accounts for this.


### 45. [MED · Inefficiency] Full Store.tasksArr re-serialized on every 1200ms autosave; up to 4x re-stringify under quota pressure

**Location:** `app.js` lines 11446-11466 (_saveCache), 11468-11509 (_writeCacheWithQuotaGuard), 11561-11565 (_autosave), subscription at 14389  |  **Confidence:** high

**Problem.** _autosave (debounced 1200ms, fires on every non-'refresh' Store mutation per the subscription at 14389) calls _saveCache(), which snapshots `tasks: Store.tasksArr` plus blocks/calendars/lineSettings, then _writeCacheWithQuotaGuard does `JSON.stringify(tiers[i])` inside the loop. On QuotaExceededError it retries with tier 1 (tasks.slice(-2000)), tier 2 (slice(-500)), and tier 3 — each a fresh full JSON.stringify of the snapshot, so a single quota-pressured save can stringify the task book up to four times on the main thread.

**Why it matters (architect view).** The base case is one full stringify of the whole in-memory task array per autosave; at plant scale (thousands of orders) this is a recurring main-thread cost on every mutation during a drag-storm or optimize. Under quota pressure it degrades to up to 4 full serializations precisely when the cache is largest.

**Recommendation.** Skip _saveCache when no task changed since the last successful write (compare Store._rev, which exists). Stringify tasks once and reuse the array for the slice tiers rather than re-stringifying the whole snapshot per tier, or move the JSON.stringify to the worker / an idle callback so autosave never blocks input.

**Evidence.**

```
tiers = [ snapshot, { ...snapshot, tasks: snapshot.tasks.slice(-2000) }, { ...snapshot, tasks: snapshot.tasks.slice(-500) }, {...} ]; `for (let i = 0; i < tiers.length; i++) { ... const payload = JSON.stringify(tiers[i]); localStorage.setItem(...) ... }` (11474-11498). Subscription: `Store.subscribe(evt => { if (evt.source !== 'refresh') Persistence._autosave(); }, ...)` (14389).
```
> _Verifier note:_ Read 11446-11509; confirmed JSON.stringify is inside the tier loop (4x worst-case under quota, 1x normal). Confirmed autosave subscription at 14389 and Store._rev exists (grep). The '4x' is worst-case not steady-state — wording adjusted; mechanism is real.


### 46. [MED · Inefficiency] Every mutation (add / paste / delete / undo) tears down and rebuilds the whole table via _renderTable

**Location:** `app.js` lines 15214-15229 (_addRow), 15304 (_pasteRows), 15355 & 15360 (_deleteRow), 15118 (undo), 14940 (host.innerHTML='')  |  **Confidence:** high

**Problem.** _addRow, _pasteRows, _deleteRow, and the delete-undo handler all call _renderTable(table), which does `host.innerHTML = ''` (14940) and rebuilds the toolbar, thead, and every <tr> from scratch. _addRow even comments 'Re-render to show the new row (simpler than appending)' then uses a 50ms setTimeout to re-find and focus the new row (15220-15228).

**Why it matters (architect view).** A full teardown to add a single row (or undo one delete) is O(allRows) DOM work for an O(1) change. Combined with the all-rows render (finding above), a paste of 10 rows into a 3,000-row table rebuilds 3,000+ nodes. It also discards per-cell DOM state (caret, scroll), and the 50ms setTimeout focus hack races the re-render rather than appending+focusing directly.

**Recommendation.** Make row operations incremental: _addRow should _appendRow(tbody, ...) and focus synchronously (no setTimeout); _deleteRow/undo should toggle classes / swap the action cell on the existing <tr> (the `tr` reference is already in scope) instead of re-rendering; _pasteRows should append only new rows and patch updated ones in place. Reserve full _renderTable for tab/table switches.

**Evidence.**

```
15220 `// Re-render to show the new row (simpler than appending).` then `_renderTable(table);`; 15223-15228 `setTimeout(() => { ... firstCell.focus(); }, 50);`; 14940 `host.innerHTML = '';`; 15118 undo: `state.deleted.delete(key); _renderTable(table);`; 15355 & 15360 `_renderTable(table);` in _deleteRow.
```
> _Verifier note:_ Verified all four mutation paths call _renderTable; the setTimeout-focus comment and hack confirmed at 15220-15228. Note _deleteRow already sets tr.className then still calls _renderTable (15358-15360), making the inline class set redundant.


### 47. [MED · Inefficiency] _rowKey recomputed O(n) inside O(m) loops — paste and append degrade quadratically over row counts

**Location:** `app.js` lines 15252-15263 (_pasteRows classification), 15292-15301 (_pasteRows apply), 15056 (_appendRow isNew), 15190-15194 (_getRowByKey)  |  **Confidence:** high

**Problem.** _pasteRows classifies each pasted row by scanning state.rows, state.added, toAdd and toUpdate with .some/.findIndex that each recompute _rowKey (KEY_COLS[table].map(...).join('|'), 14836-14838). For P pasted rows against R existing rows that is O(P*R) key recomputations. Separately _appendRow recomputes `state.added.some(r => _rowKey(...) === key)` for every rendered row (15056, O(rows*added)), and _markDirty -> _getRowByKey re-scans `[...rows, ...added]` linearly per edit (15190-15194).

**Why it matters (architect view).** Key derivation is pure and stable yet recomputed thousands of times. At 3,500 lines a bulk paste degrades quadratically and a single keystroke edit (_markDirty -> _getRowByKey) linearly scans the full set. Avoidable repeated work, not an inherent cost.

**Recommendation.** Build a Map(rowKey -> row) index once per loaded table (rows + added) and update it on add/delete; test membership with map.has(key) instead of .some/.findIndex over re-derived keys. Compute each pasted row's key once and reuse it. In _appendRow, pass a precomputed isNew Set rather than re-scanning state.added per row.

**Evidence.**

```
15255 `const inSaved = state.rows.some(r => _rowKey(table, r) === key);`; 15257 `const batchAddIdx = toAdd.findIndex(r => _rowKey(table, r) === key);`; 15294/15299 `findIndex(r => _rowKey(table, r) === key)`; 15056 `const isNew = state.added.some(r => _rowKey(table, r) === key);`; 15192 `const all = [...(state?.rows ?? []), ...(state?.added ?? [])]; return all.find(...)`.
```
> _Verifier note:_ Verified the repeated _rowKey scans in _pasteRows (15252-15301), _appendRow (15056) and _getRowByKey (15190-15194). Corrected _getRowByKey cite from 15179/15192 to 15190-15194; _pasteRows apply block is 15292-15301.


### 48. [MED · Inefficiency] Cascade-preview fetched twice (per-row, then again at save) and the per-row confirmation is not remembered at save

**Location:** `app.js` lines 15320-15349 (_deleteRow per-row preview + confirm), 15396-15419 (_save preview + confirm)  |  **Confidence:** high

**Problem.** _deleteRow does a POST /cascade-preview and a danger-confirm modal for subnetworks/plants when the trash icon is clicked (15324-15349). _save then does the SAME POST /cascade-preview for all queued deletes and shows ANOTHER danger-confirm (15397-15419). Deleting N plant rows fires N preview round-trips during editing plus one more at save, and the user confirms the same destructive cascade twice.

**Why it matters (architect view).** Redundant network round-trips and a double-confirm UX. The per-row preview's confirmation result is not recorded, so the save-time modal re-asks. At scale (a subnetwork cascading to many plants/lines) each per-row preview is a non-trivial DB query and the per-row previews are not batched.

**Recommendation.** Pick one authoritative preview point: either drop the per-row cascade fetch and compute the full cascade once at save over the batched deletes, or keep the inline preview but record that the user already confirmed and skip the second modal. The endpoint already accepts a batched { deletes: [...] } list (brain.py:1292-1297, md.cascade_preview), so any multi-row preview can be a single request.

**Evidence.**

```
15326 `const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, { ... body: JSON.stringify({ deletes: [deletePayload] }) })` (per row); 15342 first `Modal.confirm({ ... tone: 'danger' })`; 15399 `... JSON.stringify({ deletes })` (again at save); 15409 second `Modal.confirm({ ... tone: 'danger' })`.
```
> _Verifier note:_ Verified both cascade-preview POSTs and both danger confirms; backend endpoint accepts a deletes[] list per brain.py:1293. Tightened the per-row line cite to 15320-15349.


### 49. [MED · Maintainability] Hardcoded developer email in labor-plan and line-setting write headers — corrupts the audit trail

**Location:** `app.js` lines 2349 (_saveAggregate), 2364 (_saveLines), 15649 (syncLineSettings)  |  **Confidence:** high

**Problem.** Three POST paths hardcode `'x-user-email': 'trevor.holton@newellco.com'` directly in the request headers (`_saveAggregate` 2349, `_saveLines` 2364, `MasterData.syncLineSettings` 15649). This is the actor identity the backend `admin_audit` log records.

**Why it matters (architect view).** Every labor-plan and line-setting edit by any user is attributed to one developer's email in the audit trail, defeating the audit log's purpose. It is a literal string repeated in three places (will drift) and ships a personal email in client source. CLAUDE.md notes actor identity is already spoofable pending Entra SSO — but this is worse: it is a constant, not even the current user.

**Recommendation.** Source the header from a single `Config.currentUserEmail()` / `Store.currentUser` accessor (fed by the eventual SSO claim or a runtime-set value) and attach it in one place — ideally route these writes through `Util.fetchTraced`, which already standardizes headers.

**Evidence.**

```
2349 / 2364 / 15649 all literally `headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' }`.
```
> _Verifier note:_ Verified the identical hardcoded email at all three cited lines. Real audit-integrity impact; kept at medium (pilot-stage, pre-SSO, spoofable-by-design per CLAUDE.md, so not high).


### 50. [MED · Maintainability] Plant/line list rows are built via innerHTML with a hand-rolled 2-char JS-string escape and the visible name interpolated unescaped

**Location:** `app.js` lines 4926-4931 (plant rows), 5041-5055 (line rows)  |  **Confidence:** high

**Problem.** Both lists build clickable rows by string-interpolating the identifier into an inline handler attribute, guarded only by `const safe = X.replace(/\\/g,'\\\\').replace(/'/g,"\\'");` then `onclick="NIMBUS.OptimizeDialog.selectPlant('${safe}')"` / `onchange="...('${safe}', this.checked)"`. The `safe` value only escapes backslash and single-quote for the JS-string-in-attribute context. Separately, the VISIBLE name is interpolated RAW with no HTML escaping: line 4930 `>${p}</li>` and line 5050 `<span class="opt-line-name">${line}</span>`.

**Why it matters (architect view).** A line/material/plant code containing a double-quote, `<`, or `&` (plausible from SAP free-text or future plant naming, and these codes are sourced from external upload data) breaks the attribute or injects markup, because neither the `safe` escape (JS-string only, no HTML metachars) nor the raw `${line}`/`${p}` interpolation (no escaping at all) handles HTML context. The brittle escape pattern is duplicated in two places, so any fix must be made twice.

**Recommendation.** Stop generating handlers via innerHTML: build rows with createElement + textContent for the visible name, attach listeners via addEventListener (passing the raw value through a closure or dataset attribute, with event delegation on the <ul>). This removes both the duplicated escape helper and the HTML-injection surface.

**Evidence.**

```
4927-4930: `const safe = p.replace(/\\/g,'\\\\').replace(/'/g,"\\'"); ... onclick="NIMBUS.OptimizeDialog.selectPlant('${safe}')">${p}</li>`. 5042-5050: `const safe = line.replace(...); ... onchange="NIMBUS.OptimizeDialog._onLineToggle('${safe}', this.checked)"> <span class="opt-line-name">${line}</span>`.
```
> _Verifier note:_ Verified the duplicated escape at 4927 and 5042 and the unescaped visible names at 4930 (${p}) and 5050 (${line}). Both real. Kept at medium — genuine injection/robustness surface from external upload data, duplicated pattern.


### 51. [MED · Maintainability] Optimizer audit-log POST hardcodes the developer's email as X-User instead of the current actor

**Location:** `app.js` lines 5330-5340  |  **Confidence:** high

**Problem.** The optimization audit entry is sent with `headers: { 'Content-Type': 'application/json', 'X-User': 'trevor.holton@newellco.com' }` — the developer's own email literally baked into the audit trail for every user's optimization run. The same literal also appears at lines 1935 and 1963 (color-wheel upload/delete audit), so it is a repeated hardcode, not a one-off.

**Why it matters (architect view).** Every optimization (and color-wheel mutation) in the pilot is attributed to one hardcoded person, defeating the audit log and making it actively misleading the moment a second user touches the app. CLAUDE.md notes actor identity flows via X-User; this bypasses any user-resolution and pins it to one address.

**Recommendation.** Send the actor from a single source (a Config.currentUser()/Store helper, the same identity fetchTraced would use), defaulting to null/'unknown' rather than a person's address. Fix all three occurrences (1935, 1963, 5332) together so they cannot drift.

**Evidence.**

```
5332: `headers: { 'Content-Type': 'application/json', 'X-User': 'trevor.holton@newellco.com' },`. Grep also found the same literal at 1935 and 1963.
```
> _Verifier note:_ Verified line 5332 exactly; grep shows the literal recurs at 1935 and 1963. Correcting the original finding's note 'this literal appears only here in this slice' — within the 4866-5766 slice yes, but it occurs 3x in app.js total, which strengthens the centralize recommendation.


### 52. [MED · Maintainability] _showMultiInspector wires actions via stringly-typed inline onclick attributes and fully re-renders the panel on every selection/bulk-fix change

**Location:** `app.js` lines 9837, 10651-10678  |  **Confidence:** high

**Problem.** The multi-select inspector panel is rebuilt as an innerHTML string with inline onclick="NIMBUS.Interaction._bulkFix(true)" etc. (10665-10668). This hard-codes the global namespace path into markup and makes the 'private' _bulkFix/_unscheduleSelected methods a public string contract — rename them and the buttons silently break with no lint/compile error. The whole panel is re-rendered (and re-parsed) on every selection change (via the Selection subscriber at 9837) and again after every _bulkFix (10677 calls _showMultiInspector), recreating the entire panel rather than updating just the count/hours/lines stats line.

**Why it matters (architect view).** Inline-string handlers defeat the unified Interaction input pipeline this module is supposed to own, and NIMBUS.* string references are exactly the stringly-typed coupling that breaks invisibly during refactors. Re-rendering the full panel on each bulk-fix when only the stats changed is wasteful.

**Recommendation.** Build the panel once with addEventListener-wired buttons holding real _bulkFix/_unscheduleSelected references (not strings in HTML), and on selection change update only the count/hours/lines text nodes instead of replacing innerHTML.

**Evidence.**

```
10665: <button class="btn btn-ghost" onclick="NIMBUS.Interaction._bulkFix(true)">${t('btn.fix_all')}</button>
10677: this._showMultiInspector();  // full re-render after every bulk fix
```
> _Verifier note:_ Verified inline onclick handlers at 10665-10668, the full innerHTML rebuild in _showMultiInspector (10655-10670), the re-render at 10677, and that it is invoked from the Selection subscriber at 9837 on every multi-selection change. Real maintainability + minor efficiency finding.


### 53. [MED · Maintainability] Status-threshold logic (>=85 / >=60, >500ms/>100ms) hardcoded and duplicated, with a pool ok/err disagreement inside one tile

**Location:** `app.js` lines 12760 (strip pool), 12786 (slow tile), 12796 (_dbFillBar), 12959 (slow bars)  |  **Confidence:** high

**Problem.** The same magic status thresholds are re-typed in multiple places: pool tile status uses `poolPct >= 85 … 'warn'` (12760); `_dbFillBar` uses `pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok')` (12796); the slow-query tile uses `top.mean_ms > 500 ? 'err' : (top.mean_ms > 100 ? 'warn' …)` (12786) and `_dbSlowQueryBars` repeats `>500/>100` (12959). The strip tile flags 85% pool utilization as 'warn' on the tile itself but embeds `_dbFillBar(poolUsed, poolMax, null)` (12764) which classes the same 85% as 'err' — so one tile shows a warn dot beside an err-colored bar.

**Why it matters (architect view).** Tuning one health threshold means hunting every literal; and the pool already presents contradictory signals within a single tile (warn dot, red fill at 85%). Thresholds are domain policy, not presentation, and belong in one place.

**Recommendation.** Add `Config.DB_HEALTH = { poolWarnPct, poolErrPct, slowWarnMs, slowErrMs }` and/or a `Util.statusFor(value, warn, err)` returning 'ok'|'warn'|'err'; route every tile/bar through it. Removes the scattered literals and reconciles the tile-vs-fillbar disagreement at 85%.

**Evidence.**

```
12760: `pool.error ? 'err' : (poolPct >= 85 || (pool.requests_waiting ?? 0) > 0 ? 'warn' : 'ok')` and 12764 embeds `_dbFillBar(poolUsed, poolMax, null)` whose 12796 line is `const cls = pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok');` — same 85 boundary, opposite class, rendered in the same tile.
```
> _Verifier note:_ Verified all four literal sites and that 12764 passes the same poolUsed/poolMax into _dbFillBar, confirming the in-tile warn-vs-err disagreement. No existing Config.DB_HEALTH/statusFor helper (grep clean).


### 54. [MED · Maintainability] Raw fetch() with empty catch{} swallows errors and bypasses the fetchTraced/parseBackendError standard used in the same module

**Location:** `app.js` lines 15152-15163 (FK source), 15326-15338 (per-row cascade), 15399-15418 (save cascade), 15439-15453 (post-save Store refresh)  |  **Confidence:** high

**Problem.** _loadAndRender uses Util.fetchTraced + Util.parseBackendError (request-id tracing, structured error envelope; 14903-14911). Other network calls in the module use bare fetch with ad-hoc `.then(r => r.json())` and silent catch: the FK-source fetch (`.catch(() => {})`, 15163), the per-row cascade preview (`} catch {}`, 15338), the save-time cascade preview (`} catch {}`, 15418) and the post-save Store refresh (`.catch(...)`, 15451) all swallow failures.

**Why it matters (architect view).** Inconsistent error discipline within one module is a drift hazard: a failed FK fetch silently yields an empty dropdown (user can't pick a parent, no explanation); a failed cascade preview silently shows a clean delete with no warning before a destructive operation; the swallowed save-refresh leaves Store master-data stale with no log. None carry the x-request-id correlation the codebase relies on for backend log correlation.

**Recommendation.** Route MasterData's calls through Util.fetchTraced and surface failures via ErrorLog.error + Toast as _loadAndRender already does. At minimum, the cascade-preview catch must fail safe: if the preview can't be obtained, warn the user that cascade impact is unknown rather than silently presenting a clean delete.

**Evidence.**

```
14903 `Util.fetchTraced(...)` + 14906 `Util.parseBackendError(r)` (the good path); 15163 `.catch(() => {});` (FK fetch); 15338 `} catch {}` (per-row cascade preview); 15418 `} catch {}` (save-time cascade preview); 15451 `.catch(() => { Store.emit(...) })`. fetchTraced at app.js:275, parseBackendError at app.js:318.
```
> _Verifier note:_ Verified the good path uses fetchTraced/parseBackendError and the four cited calls use bare fetch with silent catch; helpers confirmed at app.js:275 and 318.


### 55. [MED · Scalability] clampLinesToPlant scans every calendar across all plants on each per-day plant working-hours edit

**Location:** `app.js` lines 795-812  |  **Confidence:** high

**Problem.** setPlantWorkHours → clampLinesToPlant iterates `Object.keys(this._state.calendars)` (every line in the system, all plants) and calls getPlantForLine per line just to skip the ones not in the edited plant, then emits a calendar:change. There is no per-plant line index used here; the system has _tasksByPlant but no _linesByPlant, and linesForSelectedPlant itself also scans allLines(). CLAUDE.md's scale doctrine explicitly says calendars/blackouts are per-plant and must be keyed by plant, not scanned globally.

**Why it matters (architect view).** Editing one plant's Tuesday hours touches the calendars of all lines system-wide (~3,500 at target scale) to mutate maybe 70, and fires inside the Plant tab's Flatpickr onChange handlers — so an admin nudging hours triggers a full-system scan plus a calendar:change emit (which fans out to all subscribers and an alert recompute) per interaction. It will feel laggy well before 50 plants.

**Recommendation.** Add a plant→lines index (_linesByPlant) populated in _rebuildPlantIndex from lineSettings + masterData, and have clampLinesToPlant iterate only that plant's lines. This also lets linesForSelectedPlant drop its own allLines().filter scan. Falls out naturally from the per-plant scoping the rest of the app already adopted.

**Evidence.**

```
for (const line of Object.keys(this._state.calendars)) { const lsettings = this._state.lineSettings[line]; const linePlant = (lsettings || {}).plant || null; if (linePlant !== plant) continue; ... }
```
> _Verifier note:_ Verified 795-811 global scan + emit. Corrected the original recommendation's overstatement: there is NO existing per-plant line index (only _tasksByPlant); linesForSelectedPlant (923) also scans allLines().filter, so the index doesn't exist yet and would need creating.


### 56. [MED · Scalability] Store.emit fans every event to every subscriber with no event-type routing; each emit also pays a per-listener performance.now() pair

**Location:** `app.js` lines 626-641  |  **Confidence:** medium

**Problem.** subscribe(fn, label) registers a flat listener with no interest declaration (626-629); emit() invokes EVERY listener for EVERY event type (task:update, calendar:change, lineSettings:change, plant:selected, tasks:bulkUpdate, alerts:change, etc.) and wraps each call in a performance.now() pair for PerfMonitor.record (636-639). Every subscriber must itself inspect evt.type and decide whether to re-render — the many `if (evt.type === 'tasks:bulk' || ...)` guards scattered through the UI modules are this filtering done at the leaf.

**Why it matters (architect view).** This is the pub/sub core of the app and it has no topic routing. With ~20+ subscribers, a single calendar tweak wakes Timeline, Table, Dashboard, Hierarchy, Inspector, UtilStrip, etc., each running guard logic, and a burst of bulk updates (optimizer patches, drag autoreflow) multiplies the fixed O(events x allSubscribers) cost — plus two performance.now() calls per listener per event. It also makes 'who re-renders when' implicit and easy to get wrong (a module that forgets to filter re-renders on unrelated events).

**Recommendation.** Add optional event-type interest to subscribe (subscribe(fn, {label, types:['tasks:bulkUpdate','task:update']})) and have emit dispatch via a Map<type, Set<fn>>, turning O(events x allSubscribers) into O(events x interestedSubscribers) and making render dependencies explicit. Keep a catch-all option for the few modules that need everything.

**Evidence.**

```
for (const l of this._listeners) { const _t = performance.now(); try { l(event); } catch (e) { console.error('[Store] listener error:', e); } finally { PerfMonitor.record('store:' + (l._pmLabel || l.name || '?'), performance.now() - _t); } }
```
> _Verifier note:_ Verified flat _listeners Set, no type filtering at emit, per-listener performance.now() pair at 637/639. Confirmed leaf-level evt.type guards are pervasive (40+ call sites). Legitimate architecture-level observation; severity medium (it is fixed-overhead growth, not a present bug).


### 57. [MED · Scalability] linesForSelectedPlant() is unmemoized — full allLines() Set rebuild on every call, invoked several times per dashboard render, with no _linesByPlant index alongside the existing _tasksByPlant

**Location:** `app.js` lines 920-924 (linesForSelectedPlant), 900-912 (allLines), 884-898 (_rebuildPlantIndex), callers 7429/7731/8081/6057  |  **Confidence:** high

**Problem.** linesForSelectedPlant() (lines 920-923) calls Store.allLines() — which builds a Set by scanning tasksArr + calendars + lineSettings + masterData.lines (lines 900-912) — then filters it with Store.getPlantForLine(line) per element, every call. It is invoked at least three times per dashboard render: _renderKPIs (line 7731 `new Set(Store.linesForSelectedPlant())`), _renderAlertSummary (line 8081), and Hierarchy.render (line 7429), plus Timeline.rebuild (line 6057). Unlike tasksForSelectedPlant(), which reads the precomputed _tasksByPlant index in O(1) (line 918), there is no _linesByPlant index, so the line list is rebuilt from scratch each time. (Note: getPlantForLine itself is O(1) on cache hit via _lineToPlant, so the per-line cost is modest — the dominant cost is the repeated full allLines() Set construction, not getPlantForLine.)

**Why it matters (architect view).** At 3,500+ total lines, allLines() constructs a multi-thousand-entry Set several times per render. tasksForSelectedPlant was already promoted to an index (line 884 _rebuildPlantIndex) precisely to avoid the per-render scan; the line accessor was left behind, so it is now the larger of the two plant-scope filtering costs in the dashboard.

**Recommendation.** Build a _linesByPlant index inside _rebuildPlantIndex (it already iterates masterData.lines into _lineToPlant at lines 887-891 — accumulate plant → Set<line> there, and also fold in task/calendar/lineSettings lines) and have linesForSelectedPlant() return the cached Set. Callers that wrap it in `new Set(...)` (7731, 8081) can then share it.

**Evidence.**

```
Lines 920-923: `linesForSelectedPlant() { const plant = this._state.selectedPlant; if (!plant) return []; return Store.allLines().filter(line => Store.getPlantForLine(line) === plant); }`. Contrast line 918: `return Store.tasksByPlant(plant);`. Grep confirms no `_linesByPlant` exists.
```
> _Verifier note:_ Verified the unmemoized scan and absence of _linesByPlant. Corrected the original's overstated 'getPlantForLine runs 3,500 times per call' framing — getPlantForLine is O(1) cached (line 866 _lineToPlant); the real cost is the repeated allLines() Set rebuild. Finding stands at medium.


### 58. [MED · Scalability] DependencyOverlay critical-path computation walks ALL tasks (every plant), has no cycle guard, and the maxLen pass silently zeroes a stack overflow

**Location:** `app.js` lines 8898-8908, 8986  |  **Confidence:** high

**Problem.** render() seeds the critical-path chain computation from `const allIds = Object.keys(Store.tasks)` (line 8900), i.e. every plant's tasks, even though the overlay can only ever draw arrows for the rendered (plant-scoped) timeline. The recursive `getLen` (8901-8907) has no visited/in-progress set, so a dependency cycle recurses unbounded. The maxLen reduction wraps each id in `try { return getLen(id); } catch { return 0; }` (8908), so a RangeError from a cycle is silently turned into 0 there.

**Why it matters (architect view).** At 50+ plants / 3,500+ lines the overlay pays an O(N_all_tasks) chain walk on every pan/zoom/store event for arrows it scopes to one plant. The missing cycle guard plus the silent-zero swallow means a malformed dependency graph degrades critical-path highlighting with no diagnostics.

**Recommendation.** Scope the chain computation to `Store.tasksForSelectedPlant()` ids (the only drawable tasks), and replace the bare recursion + per-id try/catch with an iterative longest-path over the DAG using a visited/in-progress set so cycles are detected once and logged via ErrorLog.warn rather than swallowed. NOTE for the writer: correct the original finding's claim that the exception is *always* silently zeroed — the second `getLen(targetId)` call at line 8986 is NOT wrapped in try/catch, so on a genuine cycle that call would throw an uncaught RangeError and break the whole overlay render, not quietly produce 0. The swallow only applies to the maxLen pass.

**Evidence.**

```
8900: const allIds = Object.keys(Store.tasks);  8901-8907: const getLen = (id) => { if (chainLen[id] !== undefined) return chainLen[id]; const sources = deps[id] || []; if (!sources.length) { chainLen[id] = 0; return 0; } chainLen[id] = 1 + Math.max(...sources.map(getLen)); return chainLen[id]; };  8908: const maxLen = Math.max(0, ...allIds.map(id => { try { return getLen(id); } catch { return 0; } }));  8986: const isCritical = maxLen > 0 && (getLen(targetId) || 0) >= maxLen - 1;  // NOT wrapped
```
> _Verifier note:_ Verified code at 8900/8901-8908/8986 verbatim; deps sourced from server `links` (10893), so a cycle is low-probability but unvalidated client-side. Global scope and absent visited-set confirmed. Downgraded to medium and corrected the swallow claim (only the maxLen pass swallows; the in-loop getLen at 8986 would rethrow).


### 59. [MED · Scalability] GanttFilter line/color/form dropdowns render the full unfiltered list as flat checkboxes (no search, no virtualization) — violates the searchable-combobox scale rule

**Location:** `app.js` lines 8660-8680, 8714-8731, 8757-8774  |  **Confidence:** high

**Problem.** `_buildLineDropdown` (8660-8680) materializes one `<label><input type=checkbox></label>` per line for the whole selected plant into `drop.innerHTML` with no search box, no virtualization, no pagination — and folds in extra lines from order discovery (8664-8666). `_buildColorDropdown` (8714) and `_buildFormDropdown` (8757) follow the identical pattern. CLAUDE.md mandates searchable, filterable dropdowns for line/plant lists at scale (70+ lines/plant) and explicitly warns scrolling is not enough.

**Why it matters (architect view).** At the target 70+ lines per plant this is a 70-checkbox flat list rebuilt via full `innerHTML` replace on every plant switch and every `tasks:bulk` (rebuild is wired in the Store subscription at 8581-8597). It is both a render-cost issue and the exact UX anti-pattern the roadmap forbids.

**Recommendation.** Convert the line dropdown to a searchable combobox with a text-filter input and windowed rendering (the codebase already ships `VirtualList`), matching the comboboxes mandated elsewhere for plant/line selectors. Rebuild incrementally (keyed on a hash of the underlying line set) instead of re-`innerHTML` on every populate().

**Evidence.**

```
8674-8679: drop.innerHTML = sorted.length ? sorted.map(l => `<label><input type="checkbox" value="${esc(l)}"${GanttFilter._selectedLines.has(l) ? ' checked' : ''} onchange="NIMBUS.GanttFilter._onLineChange(this)"> ${esc(l)}</label>`).join('') : `...No lines...`;  rebuild on tasks:bulk / plant:selected at 8581-8596.
```
> _Verifier note:_ Verified all three builders do full-innerHTML flat-checkbox rendering with no search/virtualization, rebuilt on tasks:bulk and plant:selected. Directly contradicts CLAUDE.md's explicit scale rule for line lists.


### 60. [MED · Scalability] _navigateSelection rebuilds a global all-lines index and full-scans every task across every plant on each arrow keypress

**Location:** `app.js` lines 10619-10648  |  **Confidence:** high

**Problem.** Each arrow-key press recomputes allLines by scanning all of Store.tasksArr, building a Set, and sorting (10624-10626). ArrowLeft/Right then filters all of Store.tasksArr for same-line peers and sorts (10629-10631); ArrowUp/Down filters all of Store.tasksArr for the target line (10641-10642) and sorts by temporal distance. None of it is scoped to the selected plant — it iterates every task across every plant (Store.tasksArr is the global index; Store.tasksByPlant / tasksForSelectedPlant exist and are indexed but are not used here). The work is discarded after picking one neighbor and redone from scratch on the next keypress.

**Why it matters (architect view).** At 50+ plants and 3,500+ total lines, every arrow keystroke becomes multiple full O(n) scans plus a sort with no caching and no plant scoping — the all-at-once global-state pattern the roadmap explicitly forbids for line/plant handling. Holding an arrow key to step through orders will stutter as order count grows.

**Recommendation.** Scope to the selected plant via Store.tasksByPlant(Store.selectedPlant) / Store.linesForSelectedPlant() (both exist and are indexed). Better, precompute a per-plant, per-line ordered index (line → tasks sorted by start_date), invalidated on Store._rev change, so navigation is O(1) lookup + O(log n) neighbor find instead of O(n) scan-and-sort per keypress.

**Evidence.**

```
10624: const allLines = [...new Set(Store.tasksArr.filter(t => t.PRODUCTION_LINE).map(t => t.PRODUCTION_LINE))].sort();
10629: const peers = Store.tasksArr.filter(t => t.PRODUCTION_LINE === cur.PRODUCTION_LINE && t.start_date).sort(...)
10641: const candidates = Store.tasksArr.filter(t => t.PRODUCTION_LINE === targetLine && t.start_date);
```
> _Verifier note:_ Original line numbers (9619-9648) were wrong — the function is at 10619-10648 (9619-9648 is Sandbox.exit). Code excerpts match the real function. Confirmed tasksArr is global (882) and tasksByPlant/linesForSelectedPlant exist (881, 920). Downgraded high→medium: arrow-nav is single-selection, one scan per discrete keypress (not a per-frame loop), so impact is real but lower than a drag hot path.


### 61. [MED · Scalability] saveAll POSTs the entire global blocks + calendars set on every save regardless of loaded plant

**Location:** `app.js` lines 11298 (Store getters at 612, 614)  |  **Confidence:** high

**Problem.** saveAll builds `body = JSON.stringify({ tasks: taskPayload, blocks: Store.blocks, calendars: Store.calendars })`. Store.blocks and Store.calendars are global accessors (`get blocks() { return this._state.blocks; }`, `get calendars() { return this._state.calendars; }`) covering ALL lines/plants loaded into the session, not just the current plant. Tasks are correctly scoped to dirty ids; blocks/calendars are sent in full on every explicit save even when zero tasks are dirty (CLAUDE.md confirms this).

**Why it matters (architect view).** Calendars are per-line (roadmap targets 3,500+ lines) and blackout blocks accumulate per plant. As a user navigates plants in one long session, _state.calendars/blocks grow to cover every visited line, and every Ctrl+S re-serializes and re-uploads the union — the payload grows with session breadth, and the backend receives global config on a single-plant edit, against the per-plant storage keying the project mandates.

**Recommendation.** Scope the save payload to the loaded plant: send only blocks/calendars for lines belonging to _currentLoadedPlant (filter via Store.getPlantForLine, which exists), and omit the keys entirely when nothing block/calendar-related changed (track a dirty flag as is done for tasks). Long term, persist calendars/blocks via per-plant endpoints keyed by plant id.

**Evidence.**

```
`const body = JSON.stringify({ tasks: taskPayload, blocks: Store.blocks, calendars: Store.calendars });` (11298); getters at 612 `get blocks() { return this._state.blocks; }` and 614 `get calendars() { return this._state.calendars; }`.
```
> _Verifier note:_ Verified line 11298 and the two global getters at 612/614. CLAUDE.md documents the always-POST behavior; the per-plant-scale framing is the added insight. Downgraded high→medium because the behavior is documented/known — keeping for the scalability angle.


### 62. [MED · Scalability] Printer renders the whole plant as one flat, line-unfiltered table; CSV export is unbounded

**Location:** `app.js` lines 13860-13976  |  **Confidence:** medium

**Problem.** Printer.preview() filters Store.tasksArr by date range only, sorts by line, and renders every matching row into a single flat HTML table (preview capped at MAX_PRINT_ROWS=500; exportCsv emits ALL rows with no cap). There is no line multi-select, no per-line grouping/sectioning, and no pagination. At a plant with 70+ lines a week-wide range produces hundreds-to-thousands of undifferentiated rows, and the 500-row preview truncation tells the user to 'narrow the date range' rather than scope by line.

**Why it matters (architect view).** The CLAUDE.md scale roadmap mandates filterable line lists ('scrolling is not enough') and a single plant reaches 70+ lines. The print/export view ignores the line axis entirely, which is the axis a supervisor actually needs to narrow. Correction to the original framing: data IS already plant-scoped (Persistence.loadForPlant + server-scoped GET /tasks?plant= mean Store.tasksArr holds only the currently-loaded plant), so the gap is the missing line filter and grouping, not plant scoping.

**Recommendation.** Add a searchable line multi-select (reuse the PlantSelector combobox pattern) and group printed output by line with per-line subtotals. Build the preview table via DocumentFragment / chunked rendering or VirtualList. For CSV, stream/append rows instead of one giant array+join, and apply the same line scope.

**Evidence.**

```
const rows = Store.tasksArr.filter(t => t.start_date && t.start_date >= rangeStart && t.start_date <= rangeEnd).sort(...); const MAX_PRINT_ROWS = 500; const printRows = rows.length > MAX_PRINT_ROWS ? rows.slice(0, MAX_PRINT_ROWS) : rows;  // exportCsv: ...Printer._rows.map(...) — no cap
```
> _Verifier note:_ Verified code at 13874-13976; confirmed Store.tasksArr is single-plant-scoped via loadForPlant/setTasks, so corrected the 'no plant scoping' claim and dropped severity high→medium. Line-filter/grouping/unbounded-CSV gaps are real.


### 63. [MED · Scalability] PlantSelector rebuilds the full dropdown innerHTML and re-attaches per-option listeners on every keystroke, with no result cap

**Location:** `app.js` lines 14098-14130  |  **Confidence:** high

**Problem.** _renderDropdown serializes ALL filtered options into innerHTML on every focus and every input keystroke (the 'input' listener at 14032 calls it directly), then querySelectorAll('.hps-option') and attaches a fresh mousedown listener to each node. An empty/label query renders the full list (_options.slice()). At the roadmap's 50+ plants this is O(n) DOM rebuild + N listener attachments per character, with no cap on rendered results.

**Why it matters (architect view).** The combobox is explicitly the roadmap's scale answer, yet its own implementation does a full DOM teardown/rebuild and re-binds N listeners each keystroke. It works only because innerHTML replacement discards old nodes — but it is needless GC/layout pressure that degrades as plant count grows, and a blank query paints every plant.

**Recommendation.** Render via DocumentFragment, cap the visible list (e.g. first 50 matches with a 'refine search' hint) or use the existing VirtualList, and use one delegated mousedown listener on _dropdown (read e.target.closest('.hps-option').dataset.plant) instead of N per-option listeners rebuilt each render.

**Evidence.**

```
PlantSelector._dropdown.innerHTML = PlantSelector._filtered.map((p,i) => `<div class="hps-option..." data-plant="${p}">...`).join(''); ... PlantSelector._dropdown.querySelectorAll('.hps-option').forEach(el => { el.addEventListener('mousedown', e => { e.preventDefault(); PlantSelector._select(el.dataset.plant); }); });
```
> _Verifier note:_ Verified 14098-14130 plus the 'input' listener at 14032 that calls _renderDropdown per keystroke. _options sourced from Store.knownPlants() (master-data plants → 50+ at scale). Accurate.


### 64. [LOW · Abstraction] Schwartzian decorate-sort comparison is implemented twice (Engine._comparator vs runAndApply inline)

**Location:** `app.js` lines 4657-4663, 4730-4738  |  **Confidence:** high

**Problem.** _sortTerms was correctly extracted as the single source of ordering, but the term-walking comparison is then written twice: _comparator (4659-4662) walks terms calling tm.cmp(tm.get(a), tm.get(b)), and runAndApply re-walks sortTerms inline in the decorate sort (4731-4737) calling sortTerms[i].cmp(a.k[i], b.k[i]). runAndApply — the primary caller — does not reuse _comparator.

**Why it matters (architect view).** Minor, but the comment at 4655-4656 claims _comparator exists 'for callers that want a plain comparator' while runAndApply reimplements the same walk. If the tie-break/stability rule changes, both loops need editing. Note the two are not trivially interchangeable: _comparator calls tm.get(x) live, while the decorate sort compares pre-decorated key arrays (a.k[i]) — so a shared helper must compare keys, not tasks.

**Recommendation.** Add Engine._keyComparator(sortTerms) that compares pre-decorated key arrays and have runAndApply reuse it; optionally rebuild _comparator on top of it (decorating once). One walk of the term list.

**Evidence.**

```
4731-4736 `decorated.sort((a, b) => { for (let i = 0; i < sortTerms.length; i++) { const c = sortTerms[i].cmp(a.k[i], b.k[i]); if (c) return c; } return 0; });` duplicates 4660 `for (const tm of terms) { const c = tm.cmp(tm.get(a), tm.get(b)); if (c) return c; }`.
```
> _Verifier note:_ Verified both walks exist at the cited lines. Genuinely two implementations of the same term-walk. Kept at low: the duplication is real but the fix is subtle (one walks live getters, the other pre-decorated keys), which the original recommendation already flagged.


### 65. [LOW · Abstraction] Modal.confirm has no Escape/backdrop dismissal and its docstring advertises a stale positional signature

**Location:** `app.js` lines 5726 (docstring), 5734-5756 (confirm)  |  **Confidence:** high

**Problem.** Modal.confirm resolves ONLY via the OK and Cancel button clicks — cleanup() removes only those two listeners. There is no Escape keydown or backdrop-click handler, so a confirmation dialog (the standard cross-app dismissal affordance) cannot be dismissed by Escape/backdrop. Separately, the module docstring at line 5726 still advertises the OLD positional signature `Modal.confirm(msg, onOk, onCancel?)` while EVERY real call site (5303, 1959, 11658, 12392, 13424, 13527, 13735, 13771, 15277, 15342, 15409, 15562...) passes a single opts object — a misleading, stale contract.

**Why it matters (architect view).** The missing Escape/backdrop path is a real UX/abstraction gap for a reusable confirm dialog. The stale docstring invites a future caller to use the wrong (positional) signature and break silently, since confirm() reads opts.title/opts.message/opts.detail.

**Recommendation.** Add an Escape keydown listener and a backdrop click handler that call done(false), removing them in cleanup() alongside the button listeners. Update the docstring at 5726 to the opts-object signature `Modal.confirm({ title, message, detail, confirmLabel, tone })`.

**Evidence.**

```
5726: `Modal.confirm(msg, onOk, onCancel?) — two-button confirmation dialog`. 5734: `confirm(opts = {})`. 5745-5749: cleanup() removes only okBtn 'click' and confirm-cancel-btn 'click'; no esc/backdrop listener anywhere in the body.
```
> _Verifier note:_ Verified docstring (5726) vs opts-object body (5734) and all call sites pass objects — stale contract confirmed. DROPPED the finding's 'await hangs forever' correctness claim: I grepped all global keydown handlers (15728/15735 handle only Ctrl+Alt+L/backtick/Alt+H; ContextMenu Escape at 9031 closes the menu, not confirm-modal) — no code path can dismiss confirm-modal without the buttons, so no hang exists today. Kept the missing-dismissal UX gap + stale docstring only; severity medium->low.


### 66. [LOW · Abstraction] DependencyOverlay arrow classification has the 15-min tight/gap threshold magic-numbered and the class→color table duplicated between marker defs and CSS

**Location:** `app.js` lines 8911-8926, 8984-8992  |  **Confidence:** high

**Problem.** The finish-to-start gap classification is inline with a magic 15-minute threshold (`gapMs > 15 * Config.MS_MIN` ⇒ 'gap'; `Math.abs(gapMs) <= 15 * Config.MS_MIN` ⇒ 'tight', 8989-8990), and the class→color mapping is hardcoded once for the SVG arrowhead markers (8913) while the stroke color lives separately in CSS via `dep-arrow ${cls}` (9000). The semantic rule and its color identity are spread across three locations (JS threshold, JS marker color table, CSS stroke).

**Why it matters (architect view).** Tuning the tight/gap threshold or recoloring an arrow class requires edits in disconnected spots that can silently disagree (arrowhead color vs CSS stroke). Minor, but a genuine business-rule-inline-in-render plus a should-be-shared table.

**Recommendation.** Extract `Config.DEP_TIGHT_MIN = 15` and a `DEP_CLASSES` table (class → {color, threshold}) driving both the marker-defs loop (8912-8926) and the classification (8989-8990), so the rule and its presentation are defined once. (Stroke color is currently CSS, so either move marker color to CSS-var driven or document the split.)

**Evidence.**

```
8913: const color = { ok:'#2f7a4d', tight:'#b57a0a', gap:'#b1362a', critical:'#b1362a', highlight:'#b8791a' }[cls];  8989-8990: if (gapMs > 15 * Config.MS_MIN) cls = 'gap'; else if (Math.abs(gapMs) <= 15 * Config.MS_MIN) cls = 'tight';  9000: line.setAttribute('class', `dep-arrow ${cls}`);
```
> _Verifier note:_ Verified the inline 15-min threshold (8989-8990) and the marker color table (8913); stroke styling is indeed delegated to CSS via the dep-arrow class. Real but minor abstraction smell; low severity is appropriate.


### 67. [LOW · Abstraction] mkSection DB-deep section list is an 8-block procedural wall with copy-pasted error/empty/status guards

**Location:** `app.js` lines 12568-12711  |  **Confidence:** high

**Problem.** Each of the eight DB-deep sections (pool, server, table health, connections, locks, indexes, slow queries, sequences) repeats the same shape by hand: pull d.<key>, guard `Array.isArray(...) ? : []`, compute `hasXErr = arr[0]?.error`, derive a status tri-state, then call mkSection with a builder that re-checks the error and the empty case. The `arr[0]?.error` / `!arr.length ? empty` / status-class-ternary triad is duplicated ~6 times with only the field and thresholds changing.

**Why it matters (architect view).** Adding or reordering a section means hand-writing ~15 lines of boilerplate and re-deriving the error/empty/status logic — exactly where the `t`-shadow drift came from. It is a ~140-line block where none of the per-section status logic is independently reachable or testable.

**Recommendation.** Drive the sections from a declarative table: an array of { key, titleKey, descKey, pick(d)->{rows|error|empty}, status(rows) } that mkSection iterates. The error/empty/status guard becomes one shared function instead of eight inline copies, and section order/visibility becomes data.

**Evidence.**

```
const tables = Array.isArray(d.tables) ? d.tables : []; const hasTableErr = tables[0]?.error; const tablesNeedWork = !hasTableErr && tables.some(t => t.needs_vacuum || t.needs_analyze);
```
> _Verifier note:_ Verified all 8 mkSection blocks 12568-12711 with the repeated arr[0]?.error / !length / status-ternary triad. Real abstraction debt; low severity (cosmetic, no bug).


### 68. [LOW · Abstraction] Filter inputs are spliced into index.html markup the module 'does not own' with no guard or fallback if the anchor changes

**Location:** `app.js` lines 13087-13100 (backend q input), 13266-13291 (frontend errorCode select)  |  **Confidence:** medium

**Problem.** Both _renderBackendLog and _renderLogs build filter controls at render time by locating a sibling element (`admin-backend-log-filter-level` / `admin-log-filter-scope`) and calling `insertAdjacentElement('afterend', …)`, guarded only by `!document.getElementById(injectedId)`. The code comments admit the anchor 'markup is in index.html which we don't own'. If the anchor id is renamed or the layout reshuffled, the control silently never appears — no error, no fallback.

**Why it matters (architect view).** This is a hidden cross-file coupling with no contract: a real feature (server-side ?q= filter on the backend pane, errorCode filter on the frontend pane) simply vanishes on a markup change, with nothing logged. UI is assembled across two layers with no ownership boundary.

**Recommendation.** Either declare these inputs in index.html alongside the other filter controls (single ownership), or make the injection self-detecting: if the anchor is missing, `ErrorLog.warn('admin', 'log filter anchor missing')` so a markup change surfaces instead of silently dropping the control. Long term, render the whole admin filter bar from one place.

**Evidence.**

```
13088: `if (lvlSel && lvlSel.parentElement && !document.getElementById('admin-backend-log-q')) { … lvlSel.insertAdjacentElement('afterend', qIn); }` with comment 'markup is in index.html which we don't own'.
```
> _Verifier note:_ Verified both injection sites and the self-documenting comments. Silent-failure-on-anchor-drift is real; the 'partial injection wedges it' sub-claim is speculative but the core point holds. Low severity is right.


### 69. [LOW · Abstraction] Tab switching hand-rolls per-tab dispatch with repeated magic-number setTimeout(30) deferrals instead of a tab registry

**Location:** `app.js` lines 14474-14576  |  **Confidence:** high

**Problem.** goto/gotoGanttSub/gotoLaborSub/gotoMasterSub each hand-roll a hardcoded list of valid sub-ids, a querySelectorAll to toggle .active, manual pane show/hide, and a setTimeout(() => SomeModule.render(), 30) to defer rendering until the pane is visible. The 30ms idiom appears in five-plus sites; tab dispatch is a switch-on-string (if tab==='gantt' … else if tab==='home' …).

**Why it matters (architect view).** setTimeout(...,30) is a fragile substitute for 'render after layout' — it couples correctness to a guessed delay rather than requestAnimationFrame, and is copy-pasted across the goto* methods. Adding a tab means editing several parallel string lists and remembering the 30ms idiom; this does not scale as tabs/sub-tabs grow.

**Recommendation.** Define a tab registry { id, paneId, validSubs, onShow } and a single activate(tabId) that toggles classes, shows the pane, and calls onShow() inside requestAnimationFrame. Centralize or drop the timing constant in favor of rAF.

**Evidence.**

```
} else if (tab === 'home') { setTimeout(() => Dashboard.render(), 30); } else if (tab === 'masterdata') { setTimeout(() => { if (App._currentMasterSub === 'plant') Plant.render(); else ProdLines.render(); }, 30); } else if (tab === 'admin') { setTimeout(() => AdminCockpit.render(), 30); }
```
> _Verifier note:_ Verified 14492-14575: setTimeout(...,30) recurs in goto (home/masterdata/admin), gotoGanttSub (×2), gotoLaborSub, gotoMasterSub — five-plus sites. Accurate, low-severity maintainability/abstraction.


### 70. [LOW · Correctness] getPlantForLine's trailing .find fallback is unreachable dead code; the comment misdescribes it as an authoritative scan, masking a silent null-drop

**Location:** `app.js` lines 860-870 (lookup), 884-899 (cache build + index)  |  **Confidence:** medium

**Problem.** _rebuildPlantIndex (884-891) builds _lineToPlant from masterData.lines, storing l2p[r.production_line] = r.plant ?? null for every line with a truthy production_line. getPlantForLine (866-869) returns `cached` whenever it is !== undefined (i.e. for any line present in masterData, even when its plant is null). The trailing `masterData.lines.find(...)` at 868 is therefore only reached for lines absent from masterData — but those are exactly the lines .find will also fail to locate (it scans the same array the cache was built from). So .find can never return a non-null answer the cache wouldn't already have; it is effectively dead. The code comment at 863-865 ('A miss falls through to the authoritative scan') is misleading — the cache is the authoritative, complete map for masterData lines, and the scan resolves nothing extra.

**Why it matters (architect view).** getPlantForLine is one of the hottest lookups in the app (per-task in _rebuildPlantIndex, linesForSelectedPlant, every per-plant render). The phantom .find creates the false impression of a safety net for unmapped lines. The real failure mode it hides: a task on a line absent from both lineSettings and masterData resolves to null and is silently dropped from every per-plant bucket at line 895 (`if (!p) continue;`), with no diagnostic. This is the app's primary scalability model (per-plant scoping), so a silent drop is a real correctness gap at 50+ plants with heterogeneous uploads.

**Recommendation.** Collapse to a single path: after the lineSettings check, `return this._lineToPlant[line] ?? null;` and delete the trailing .find. Store only mapped lines in _lineToPlant (skip null entries) so a genuine miss is unambiguous. Pair with finding 9's diagnostic so lines that resolve to null are surfaced rather than silently elided. Fix the comment to stop claiming a fallback scan.

**Evidence.**

```
const cached = this._lineToPlant[line]; if (cached !== undefined) return cached; const mdLine = (this._state.masterData?.lines ?? []).find(r => r.production_line === line); return mdLine?.plant ?? null;  // vs build: l2p[r.production_line] = r.plant ?? null;
```
> _Verifier note:_ Verified at app.js 860-870 and 884-899. Core claim (unreachable .find, misleading comment, silent null-drop at 895) holds. Downgraded high->low: it is dead code, not a live bug, and resolution is purely defensive. Dropped the original 'first-wins vs first-match divergence' sub-claim — both cache build (=== undefined guard) and .find are first-match, so they cannot disagree.


### 71. [LOW · Correctness] Reconnect watcher reloads _currentLoadedPlant, which the offline fallback that triggered it never refreshed

**Location:** `app.js` lines 10958-10992 (watcher), 10976 (reload call)  |  **Confidence:** medium

**Problem.** On backend recovery the _reconnect watcher calls `Persistence.load({ force: true, plant: Persistence._currentLoadedPlant })`. But _currentLoadedPlant is only set on the SUCCESSFUL backend path (10800/10885); the offline _loadCache fallback that started the watcher never updates it. Meanwhile Store.setSelectedPlant (871) updates Store.selectedPlant unconditionally, so a user who switches plants while offline has Store.selectedPlant = the new plant but _currentLoadedPlant = the last online plant. On recovery the watcher force-reloads the stale plant.

**Why it matters (architect view).** On a single-replica pilot, a disconnect → navigate-to-different-plant → reconnect sequence silently force-reloads the previously-loaded plant, not the one the user is now looking at. Narrow race, but the force:true makes it a hard overwrite.

**Recommendation.** On recovery, reload from the authoritative current selection (Store.selectedPlant) rather than the stale _currentLoadedPlant, and skip the reload if no plant is selected. Consider calling _reconnect.stop() at the start of a user-triggered reload()/loadForPlant() so a manual reconnect cancels the backoff timer.

**Evidence.**

```
Recovery: `try { Persistence.load({ force: true, plant: Persistence._currentLoadedPlant }); }` (10976). _loadCache (11117-11175) never assigns _currentLoadedPlant. setSelectedPlant (871-876) sets selectedPlant regardless of backend reachability; loadForPlant (11423) then attempts a fetch that fails offline.
```
> _Verifier note:_ Confirmed _currentLoadedPlant set only on success paths and never in _loadCache; confirmed setSelectedPlant updates state unconditionally so Store.selectedPlant is the better source on recovery. Real but narrow race — downgraded medium→low (requires disconnect+navigate+reconnect on single replica).


### 72. [LOW · Correctness] _dbLockChain injects unescaped foreign query text and lock_type via innerHTML

**Location:** `app.js` lines 13013-13036 (mkNode 13019-13025; arrow 13030)  |  **Confidence:** high

**Problem.** mkNode builds the lock-chain node with innerHTML and interpolates `query` (a live SQL statement string captured from another Postgres session) and `role` directly: `<div class="admin-db-lock-query">${(query||'—').slice(0,90)}</div>` plus `<span class="admin-db-lock-role">${role}</span>`, and the arrow interpolates `${lk.lock_type || ''}` (13030). Every other DB helper in this slice correctly uses textContent (_dbTable 13062, _dbHBarChart, _dbSlowQueryBars, etc.).

**Why it matters (architect view).** The blocking/blocked query text is arbitrary SQL containing whatever literals were in those statements. Any `<` or `&` renders as broken/garbled markup in the lock panel, and it is a latent injection sink if any of that SQL text is ever attacker-influenced. It is the only innerHTML-with-external-string in the DB visual helpers, so it is inconsistent with the file's own established safe pattern two functions away.

**Recommendation.** Build the node with createElement + textContent for pid/role/query (and arrow lock_type) exactly like _dbTable does. Reserve innerHTML for static markup only.

**Evidence.**

```
node.innerHTML = `<span class="admin-db-lock-pid">PID ${pid}</span>` + `<span class="admin-db-lock-role">${role}</span>` + `<div class="admin-db-lock-query">${(query || '—').slice(0, 90)}</div>`;
```
> _Verifier note:_ Verified 13022-13024 innerHTML interpolation of query/role and 13030 lock_type, against the file's textContent convention (_dbTable 13062). XSS angle is weak (pg_stat-sourced SQL), but markup-corruption + pattern-inconsistency are real; low severity is right.


### 73. [LOW · Duplication] The 7-day default-workhours builder (WEEKEND_OFF/DEFAULT_SHIFT) is duplicated four times across Store and the worker

**Location:** `app.js` lines app.js 746-751 (ensureCalendar), 783-788 (ensurePlant); nimbus-worker.js 100-104 (ensureCalendar), 109-113 (ensurePlant)  |  **Confidence:** high

**Problem.** The exact default-workhours loop (`for d 0..6: WEEKEND_OFF && (d===0||d===6) ? null : [...DEFAULT_SHIFT]`) appears verbatim in Store.ensureCalendar (746-751), Store.ensurePlant (783-788), and again in nimbus-worker.js ensureCalendar (100-104) and ensurePlant (109-113). Four copies of one baseline-capacity rule.

**Why it matters (architect view).** This default defines the baseline capacity of every line and plant. If the default shift or weekend policy changes (plausible for a multi-plant tool where plants run different baseline shifts) three of four copies can be missed, and the worker copy drifting from the Store copy silently desyncs computed capacity/alerts from displayed calendars — the exact mirror-drift CLAUDE.md warns about, now reaching the default-seed path.

**Recommendation.** Extract one defaultWorkHours() helper (pure, reads Config) used by both ensureCalendar and ensurePlant in app.js, and pass the seeded defaults into the worker snapshot (or have the worker derive from the Config constants it already mirrors) so there is a single source for the baseline calendar.

**Evidence.**

```
const defaults = {}; for (let d = 0; d < 7; d++) { if (Config.WEEKEND_OFF && (d === 0 || d === 6)) defaults[d] = null; else defaults[d] = [...Config.DEFAULT_SHIFT]; }
```
> _Verifier note:_ Verified all four copies: app.js 746-751 & 783-788, worker 100-104 & 109-113. Worker uses bare WEEKEND_OFF/DEFAULT_SHIFT (duplicated constants), app.js uses Config.* — identical logic. Low severity but a genuine drift hazard consistent with the documented mirror-drift risk.


### 74. [LOW · Duplication] Labor-plan and color-wheel reads/writes use raw fetch() instead of Util.fetchTraced — no x-request-id correlation

**Location:** `app.js` lines 2347 (_saveAggregate), 2362 (_saveLines), 2377 (_fetchAggregate), 2401 (_fetchLines), 3441 (ColorWheelViewer._load), 15619/15647 (syncLineSettings)  |  **Confidence:** high

**Problem.** The labor module and ColorWheelViewer issue raw `fetch(`${Config.API_BASE}/...`)` calls rather than `Util.fetchTraced`, which CLAUDE.md documents as the standard wrapper that attaches `x-request-id` and logs slow/failed requests. Each site re-implements its own `if (!r.ok) { const e = await r.json(); throw ... }` ok-check + try/catch + ErrorLog/Toast boilerplate, and the policy varies (some Toast+ErrorLog.error at 2354/2369, some only ErrorLog.warn at 2388/2410, ColorWheelViewer swallows into an inline empty state).

**Why it matters (architect view).** Because they bypass `fetchTraced`, none of these writes carry an `x-request-id`, so a failed/slow labor save cannot be correlated to the backend's structured logs (CLAUDE.md already notes frontend↔backend correlation is weak). The ok-check boilerplate is copy-pasted ~6× with subtly different error handling.

**Recommendation.** Route these through `Util.fetchTraced` and a single `_postLabor(path, body)` / `_getLabor(path)` helper that centralizes the ok-check, JSON-error extraction, request-id, and ErrorLog policy.

**Evidence.**

```
2377 `const res = await fetch(`${Config.API_BASE}/labor-plan?plant=${encodeURIComponent(plant)}`);` (bare fetch); same raw pattern at 2347/2362/2401/3441/15619/15647. `fetchTraced` is used 16× elsewhere in app.js, confirming it is the established standard.
```
> _Verifier note:_ Verified all cited bare fetches exist and fetchTraced is the established convention (16 other uses). Added the two syncLineSettings fetches (15619/15647) which are the same anti-pattern. Genuine but low-severity consistency/observability cleanup.


### 75. [LOW · Duplication] _renderDrawer and _renderBell duplicate the entire alert-horizon cutoff computation

**Location:** `app.js` lines 4207-4210, 4291-4294  |  **Confidence:** high

**Problem.** Both functions independently compute the visible-alert set: look up plantRow from Store._state.masterData.plants, read alt_flag_horizon, fall back to userSettings.alertHorizonMinutes, build a cutoff Date, and filter Store.alerts by `!a.time || a.time <= cutoff`. The block is copy-pasted verbatim.

**Why it matters (architect view).** The bell badge count (4295 `visible.length`) and the drawer contents (4210) can silently disagree if one copy is edited (fallback chain or horizon source). Badge says 5, drawer shows 7 — a dual-source-of-truth bug. Low severity because both copies currently match.

**Recommendation.** Extract Alerts._visibleAlerts() returning { visible, hidden, horizonMinutes } and have both _renderDrawer and _renderBell call it. Single definition of 'which alerts are within the horizon.'

**Evidence.**

```
4207-4209 and 4291-4293 are identical: `const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null; const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null; const cutoff = typeof hz === 'number' ? new Date(Date.now() + hz * Config.MS_MIN) : null;`
```
> _Verifier note:_ Verified both blocks are byte-identical at 4207-4210 and 4291-4294 (corrected the second cite from the finding's 4288-4295 to the exact lines). The downstream filter+count divergence risk is real.


### 76. [LOW · Duplication] Color-wheel fetch + colorMap construction is duplicated between _updatePlantBadge and run()

**Location:** `app.js` lines 5164-5183 (_updatePlantBadge), 5283-5296 (run fallback)  |  **Confidence:** high

**Problem.** Two near-identical blocks fetch `${Config.API_BASE}/color-wheel/{plant}`, check r.ok, read body.entries, and build the colorMap with the same loop `for (const e of entries) colorMap[Util.norm(e.color)] = e.order_y ?? 999999;`. _updatePlantBadge does it (5s AbortSignal.timeout, sets badge + _wheelCache); run() repeats it as a cold-cache fallback (1500ms timeout, no badge). The 999999 missing-order sentinel and the entries-shape parsing live in both.

**Why it matters (architect view).** Two copies of the same network+parse contract drift: a change to the wheel API shape, Util.norm() keying, or the missing-order sentinel must be edited in both spots or the badge and the actual optimization silently disagree about what 'has a wheel' means. The magic 999999 is repeated as a bare literal.

**Recommendation.** Extract one `async function _fetchWheel(plant, timeoutMs) -> {colorMap, wheelUsed}` used by both the badge updater and the run() fallback; hoist 999999 to a named constant (e.g. Config.NO_COLOR_PRIORITY).

**Evidence.**

```
Line 5171: `for (const e of entries) colorMap[Util.norm(e.color)] = e.order_y ?? 999999;`. Line 5289: identical `for (const e of entries) colorMap[Util.norm(e.color)] = e.order_y ?? 999999;`. Both preceded by `fetch(.../color-wheel/${encodeURIComponent(plant)})` and `body.entries || []`.
```
> _Verifier note:_ Verified both blocks; the loop and 999999 sentinel are byte-identical at 5171 and 5289. Real duplication. Severity low: the run() copy is a guarded cold-cache fallback (cache usually already filled by _updatePlantBadge), so drift impact is limited, but the dedup is sound cleanup.


### 77. [LOW · Duplication] HTML-escape helper and SKIP_PREFIXES/isOrderId are copy-pasted multiple times across this slice (silent-drift hazard)

**Location:** `app.js` lines 9326, 9414-9415, 9943, 9908-9909, 10034-10035  |  **Confidence:** high

**Problem.** HTML escaping is reimplemented three times in this slice: a 3-char inline replace in the optimize-fail branch (9326, handles only <>&), a 5-char esc() in OptimizerPreview._render (9414), and another 5-char esc() in the hover renderCard (9943). Separately, the SKIP_PREFIXES array + isOrderId predicate is defined independently in _installHoverPreview (9908-9909) and again in _installMarquee (10034-10035) with identical contents. A future prefix added to one marquee/hover copy, or one escape table, won't reach the others.

**Why it matters (architect view).** Divergent SKIP_PREFIXES lists would make marquee and hover-preview disagree on what counts as a selectable order — a subtle, hard-to-trace inconsistency. Three escapers and two prefix lists are needless maintenance surface for logic that should be a single shared primitive.

**Recommendation.** Promote a single Util.escapeHtml(s) and a single Interaction.isOrderId(id) / Config.NON_ORDER_ITEM_PREFIXES to module level and reference them everywhere. This is the cross-cutting primitive Util is meant to own (it already owns fetchTraced, t, fpDatetime).

**Evidence.**

```
9326: .replace(/[<>&]/g, c => ({'<':'<','>':'>','&':'&'}[c]))
9414/9943: .replace(/[&<>"']/g, ...)
9908 & 10034: const SKIP_PREFIXES = ['blk-', 'past-zone-', 'alert-horizon-zone-', 'alertcell-'];
```
> _Verifier note:_ All five sites verified (escapers at 9326/9414/9943; identical SKIP_PREFIXES at 9908 and 10034). Downgraded medium→low and dropped the XSS framing: the 9326 variant injects err.message into text-content position (between <div>...</div>), where escaping <>& is adequate — omitting quote escaping is not an XSS gap there. This is a duplication/maintainability finding, not a security one.


### 78. [LOW · Duplication] AbortSignal.any + AbortSignal.timeout fetch-guard boilerplate copy-pasted across 6 render methods

**Location:** `app.js` lines 11756-11758, 11846-11848, 12512-12514, 13080-13082, 13442-13444, 13545-13547  |  **Confidence:** high

**Problem.** The identical idiom — abort the prior controller, make a new one, build `sig` via `AbortSignal.any ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(N)]) : ctrl.signal`, then Util.fetchTraced(url, { signal: sig }) — is duplicated verbatim in six AdminCockpit render methods (_renderHealth, _renderPipeline, _renderDbDeep, _renderBackendLog, _renderAudit, _renderAuditLog), differing only by the abort-field name and the timeout constant (6000/8000/12000).

**Why it matters (architect view).** Six hand-maintained copies of the same cancellation contract drift independently: the timeouts are scattered magic numbers, and a fix to the still-shipping no-AbortSignal.any fallback branch must be applied in six places. This is the cross-copy drift the codebase already warns about for the worker mirror.

**Recommendation.** Add one helper, e.g. AdminCockpit._tracedFetch(key, url, { timeout }) that owns AdminCockpit._aborts[key], builds the combined signal, and returns the fetch promise. Each site collapses to one line; hoist the timeouts into a small endpoint→timeout table.

**Evidence.**

```
const sig = AbortSignal.any ? AbortSignal.any([AdminCockpit._dbDeepAbort.signal, AbortSignal.timeout(12000)]) : AdminCockpit._dbDeepAbort.signal;
```
> _Verifier note:_ grep on AbortSignal.any found exactly 6 sites (not 7 — the original count was overstated; _renderDiagnostics is local-only with no fetch). Corrected count to 6 and downgraded severity to low: it is a genuine but cosmetic DRY issue with no behavioral bug.


### 79. [LOW · Duplication] Five bar-chart helpers reimplement the same max-normalized horizontal bar with divergent min-width clamps

**Location:** `app.js` lines _lineBar 12158-12183, _dbFillBar 12794-12814, _dbHBarChart 12918-12951, _dbSlowQueryBars 12953-12986, _dbProgressBars 12988-13011 (also _dbStackBar 12816-12845)  |  **Confidence:** high

**Problem.** _lineBar, _dbHBarChart, _dbSlowQueryBars and _dbProgressBars all do: find max over a collection, then per row create a track div + a fill div whose width = round(100*value/max)%, plus a label; _dbFillBar is the single-bar variant. They differ only in label formatting, the warn/err threshold, and one chip column. The divide-by-zero guard and min-width policy already disagree: _dbStackBar/_dbSlowQueryBars clamp to Math.max(1,...), _dbHBarChart to Math.max(ix.unused?0:1,...), _dbProgressBars to Math.max(0.5,...), and _lineBar (12161/12172) has NO `,1` max guard and NO min-width clamp — so a byLine where all values equal the max renders every bar at 100%, and an empty/single-key byLine divides by an undefined/zero max.

**Why it matters (architect view).** Bar-rendering logic, the max-guard, and percent rounding live in five places; a change to zero/near-zero bar handling must be repeated in each, and they already diverge.

**Recommendation.** Extract one _hbar({ rows, value, label, classFn }) builder returning normalized rows; have the callers supply a label/class function. Centralize the max-guard (Math.max(..., 1)) and the min-width policy.

**Evidence.**

```
_lineBar: const max = Math.max(...Object.values(byLine)); ... fill.style.width = `${Math.round((cnt / max) * 100)}%`;  // no ,1 guard, no clamp
```
> _Verifier note:_ All five helpers verified. Corrected the scrambled line attributions in the original (it labeled _lineBar's range as _dbFillBar and swapped _dbSlowQueryBars/_dbProgressBars). Confirmed the divergent clamps (1 / 0.5 / unused?0:1 / none) and the unguarded _lineBar max.


### 80. [LOW · Duplication] Pool used/max/status derived twice (summary strip vs detailed section) with divergent status formulas

**Location:** `app.js` lines 12570-12572 (section), 12757-12760 (strip)  |  **Confidence:** medium

**Problem.** The `poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0)` / `poolMax = pool.pool_max || 1` derivation is computed once in _renderDbDeep for the expandable Connection Pool section (12570-12571) and again in _dbSummaryStrip for the top tile (12757-12758). The two then derive *different* status from the same data: the section uses `requests_waiting > 0 || requests_errors > 0` (never considers utilization %, 12572) while the strip uses `poolPct >= 85 || requests_waiting > 0` (12760).

**Why it matters (architect view).** The summary strip and the section it summarizes are supposed to agree, but at e.g. 90% utilization with no waiters the strip shows 'warn' while the matching section header shows 'ok' — an operator scanning the strip then expanding the section gets contradictory verdicts. (Distinct from the in-tile disagreement: this is strip-vs-expanded-section.)

**Recommendation.** Compute `const poolView = derivePool(d.pool)` once in _renderDbDeep returning `{ used, max, pct, status }` and pass it to both _dbSummaryStrip and the section builder — single source of truth for the pool's health verdict.

**Evidence.**

```
12572: `const poolSt = pool.error ? 'err' : (pool.requests_waiting > 0 || pool.requests_errors > 0 ? 'warn' : 'ok');` vs 12760: `(poolPct >= 85 || (pool.requests_waiting ?? 0) > 0 ? 'warn' : 'ok')` — the section ignores pct entirely; the strip ignores requests_errors.
```
> _Verifier note:_ Verified both derivations and confirmed the two status formulas genuinely diverge (section: errors/waiters only; strip: pct/waiters). Overlaps with the threshold finding but is a distinct second divergence (strip vs expanded section, not within one tile); kept at low.


### 81. [LOW · Duplication] Preview and CSV use different timestamp formats for the same Start/End columns (local MM/DD vs ISO UTC)

**Location:** `app.js` lines 13890-13893, 13956  |  **Confidence:** high

**Problem.** preview() defines a local fmtDt rendering 'MM/DD HH:MM' (local time, no year); exportCsv() defines a different fmtDt rendering ISO 'YYYY-MM-DD HH:MM' via toISOString() (UTC). The same Start/End column therefore means different things on screen vs in the file, and the row-assembly array (line/order/material/desc/start/end/hours) is duplicated across the two functions.

**Why it matters (architect view).** Two formatters for the same conceptual column invite drift and confuse users comparing preview to CSV — a 2pm local order shows a different hour in the UTC export. The duplicated row-mapping means a column change must be made in two places.

**Recommendation.** Extract one row-projection function and one shared timestamp formatter (pick local vs UTC deliberately — local matches the rest of the UI) and have both preview and exportCsv consume them so the preview faithfully renders the CSV.

**Evidence.**

```
// preview: `${pad2(d.getMonth()+1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`  vs  // exportCsv: d.toISOString().slice(0,16).replace('T',' ')
```
> _Verifier note:_ Verified both fmtDt definitions differ exactly as cited. Corrected the title — Util.runHours is NOT forked (both call Util.runHours(t)); only fmtDt + the row array are duplicated.


### 82. [LOW · Duplication] App.sync repeats identical master-data re-render logic across four event branches (with a silent asymmetry)

**Location:** `app.js` lines 14432-14447  |  **Confidence:** high

**Problem.** blocks:change, calendar:change, plantBlocks:change and lineSettings:change are each handled by a separate if-block running the identical `if (onMaster('plant')) Plant.render(); if (onMaster('lines')) ProdLines.render();`. The copy-paste invites drift — and already has: the analogous plant:selected branch just below only re-renders ProdLines (resetting _lineFilter), an asymmetry that is hard to notice precisely because the blocks are duplicated rather than centralized.

**Why it matters (architect view).** Plant.render()/ProdLines.render() are full-pane rebuilds and at 70+ lines the ProdLines accordion rebuild is expensive. Four near-identical branches are a maintenance hazard; centralizing also makes it natural to coalesce into a single rAF-debounced re-render. (Note: each event fires its own render once — the original's 'multiple re-renders in one tick' is speculative since events are published one type at a time.)

**Recommendation.** Collapse the four branches into one membership check that calls a single scheduleMasterRerender() which debounces via requestAnimationFrame and dispatches to Plant.render or ProdLines.render based on the active sub-tab exactly once per frame.

**Evidence.**

```
if (evt.type === 'blocks:change' || evt.type === 'calendar:change') { if (onMaster('plant')) Plant.render(); if (onMaster('lines')) ProdLines.render(); } if (evt.type === 'plantBlocks:change') {...identical...} if (evt.type === 'lineSettings:change') {...identical...}
```
> _Verifier note:_ Verified 14432-14447 duplication and the plant:selected asymmetry at 14444-14446. Reframed from Inefficiency/medium to Duplication/low — the per-tick multi-render perf claim is not substantiated.


### 83. [LOW · Duplication] AdminCockpit health-polling start/stop is duplicated across visibilitychange and goto with inconsistent optional-chaining

**Location:** `app.js` lines 14466-14470, 14482-14484  |  **Confidence:** high

**Problem.** Health-polling lifecycle is controlled from two sites with different guards: the visibilitychange handler (stop on hidden, start on show only if currentTab==='admin', using optional-chaining `AdminCockpit._stopHealthPolling?.()` / `_startHealthPolling?.()`) and goto() (stop on leaving admin, using non-optional `AdminCockpit._stopHealthPolling()`). Both wrap in empty `catch {}`. The two decision sites must stay in sync by hand, and the optional-chaining asymmetry means one path tolerates a missing method while the other throws then swallows.

**Why it matters (architect view).** Two owners of the same 'is polling running?' state with no single source of truth is the classic setup for an interval leak (one path starts it, neither stops it) that would hit /diagnostics/db forever; the empty catch{} blocks hide exactly that class of failure.

**Recommendation.** Give AdminCockpit one idempotent setPollingActive(shouldPoll) that tracks its own state; have both visibilitychange and goto compute the desired boolean (`!document.hidden && App._currentTab === 'admin'`) and call it. Remove the duplicated try/catch and the optional-chaining asymmetry.

**Evidence.**

```
if (hidden) { try { AdminCockpit._stopHealthPolling?.(); } catch {} } else if (App._currentTab === 'admin') { try { AdminCockpit._startHealthPolling?.(); } catch {} } // goto(): if (App._currentTab === 'admin' && tab !== 'admin') { try { AdminCockpit._stopHealthPolling(); } catch {} }
```
> _Verifier note:_ Verified 14466-14470 and 14482-14484; the `?.` vs non-`?.` asymmetry and dual control sites are exactly as cited. Kept at low — the interval-leak risk is plausible but not demonstrated.


### 84. [LOW · Duplication] Five near-identical column-DDL/CRUD fetch blocks duplicate the same request/error/reload boilerplate

**Location:** `app.js` lines 15421-15436 (_save), 15541-15552 (_openAddColumn), 15571-15581 (_dropColumn), 15597-15608 (_openRenameLabel), 15646-15655 (syncLineSettings)  |  **Confidence:** high

**Problem.** _save, _openAddColumn, _dropColumn, _openRenameLabel, and syncLineSettings each repeat the same shape: `fetch(...).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); })`, the hardcoded `'x-user-email': 'trevor.holton@newellco.com'` header, a success Toast, and (for four of them) `delete _cache[table]; _loadAndRender(table)`.

**Why it matters (architect view).** Copy-pasted request plumbing is a drift magnet — the good path in _loadAndRender already diverged (it uses fetchTraced + parseBackendError; these do not). A change to error-envelope handling, the auth header, or cache-invalidation must be made in five places. The repeated `e.detail || HTTP ${r.status}` reinvents Util.parseBackendError, which already exists.

**Recommendation.** Extract one _mdRequest(method, path, body) helper using Util.fetchTraced + Util.parseBackendError, and a _reloadTable(table) helper for the cache-bust + reload. Route all five callers through them.

**Evidence.**

```
15427 / 15547 / 15576 / 15603 / 15652 are the same `if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); })` block; 15435/15551/15580/15607 each `delete _cache[table]; _loadAndRender(table);`; the hardcoded `'x-user-email'` literal appears at 15424, 15544, 15574, 15600, 15649.
```
> _Verifier note:_ Verified all five blocks share the identical r.ok/throw shape and hardcoded x-user-email header; four share the cache-bust+reload. Adjusted line ranges to the actual fetch blocks (e.g. _save 15421-15436 not 15422-15457).


### 85. [LOW · Inefficiency] VirtualList rebuilds the full Float64Array offset prefix-sum and re-invokes getRowH for every item on each update(), including single-row open/close toggles in the hierarchy

**Location:** `app.js` lines 450-460 (update), 7387-7388 (getRowH embeds open state), 7470-7480 (toggle/render call update)  |  **Confidence:** high

**Problem.** In variable-height mode, update() allocates a fresh Float64Array(n+1) and re-runs getRowH(items[i]) for all n items every call (450-457). The Hierarchy uses getRowH (7460) whose height embeds open/closed state (_itemH at 7387-7388 = base + open?tasks*taskH:0), and the toggle handler (7476) plus Hierarchy.render() (7480, called from many Store-driven paths) call _vl.update(_lineItems) — so toggling one row, or any sidebar-touching re-render, re-walks every line+order to rebuild the prefix sum from index 0.

**Why it matters (architect view).** At thousands of hierarchy rows this is an allocation + O(n) getRowH sweep on the hottest sidebar surface for what is often a single-row change. It's O(n), not O(n^2), so not catastrophic, but it is avoidable per-emit churn that scales linearly with the roadmap's line count.

**Recommendation.** Cache offsets keyed by a cheap signature (items.length + Store._rev, or a structural revision) and rebuild only when items identity or a height-affecting input changes. For single open/close toggles, recompute only the suffix of the prefix-sum from the changed index forward. Repaint-on-scroll already avoids this; only update() needs the guard.

**Evidence.**

```
this._offsets = new Float64Array(n + 1); for (let i = 0; i < n; i++) { this._offsets[i + 1] = this._offsets[i] + this._getRowH(items[i]); }
```
> _Verifier note:_ Verified update() at 450-460, _itemH open-state dependency at 7388, toggle/render update calls at 7476/7480. CORRECTED: dropped the original's Dashboard citation (8060-8073) — Dashboard._lsVL uses fixed rowH:VL_LS_ROW_H, NOT getRowH, so the variable-height prefix-sum path does not apply there. Finding now scoped to the Hierarchy path only.


### 86. [LOW · Inefficiency] closed-day diagnostic re-parses Store.blocks AND Store.plantBlocks per closed cell despite pre-parsed arrays in scope

**Location:** `app.js` lines 3802-3848  |  **Confidence:** high

**Problem.** Inside the overload loop, the `cap === 0 && hours > 0` branch (3802) builds its human-readable diagnostic by iterating raw Store.blocks (3818) and Store.plantBlocks (3829), calling Util.parseDate on every block's start/end again — even though parsedBlocks (3721-3725) and parsedPlantBlocks (3726-3730) hold the already-parsed Dates and _capIdx (3773) is in scope.

**Why it matters (architect view).** Every fully-closed-but-scheduled (line,day) cell triggers a full re-parse of all blackout blocks just to assemble a label string — O(closedCells × blocks) redundant Date parsing on the alert hot path. Minor because it only fires for the closed-cell edge case (cap===0 with scheduled hours), not every cell.

**Recommendation.** Reuse parsedBlocks/parsedPlantBlocks (filter by line/plant and day window) instead of re-walking Store.blocks/Store.plantBlocks with fresh parseDate. NOTE: parsedBlocks currently stores only {line,s,e} (3724) — to build the existing label text (which uses b.reason at 3826/3837) the parsed struct must also carry `reason`. Add reason to the parse at 3721-3730 and the re-parse disappears.

**Evidence.**

```
3818-3820 `for (const b of Store.blocks) { if (b.line && b.line !== line) continue; const s = Util.parseDate(b.start), e = Util.parseDate(b.end);` and 3829-3831 same for Store.plantBlocks — both re-parse while parsedBlocks already holds parsed results.
```
> _Verifier note:_ Verified the re-parse loops and that parsedBlocks/parsedPlantBlocks/_capIdx are all in scope. Downgraded medium→low: only fires on closed-but-scheduled cells (rare), and the fix has a real caveat the original missed — parsedBlocks lacks the `reason` field the label needs, so the struct must be augmented. Added that to the recommendation.


### 87. [LOW · Inefficiency] lineSettings:change triggers a full grid rowData reset instead of an incremental transaction

**Location:** `app.js` lines 6770-6786  |  **Confidence:** high

**Problem.** _onStore treats `lineSettings:change` identically to `tasks:bulk` and `plant:selected`: it calls `Store.tasksForSelectedPlant()` and `Table._api.setGridOption('rowData', rows)`, a full grid reset that re-evaluates all filters, re-renders every row, and clears scroll/selection. A single line's plant/setting edit thus rebuilds the entire visible grid, even though the module uses applyTransaction for task:update / tasks:bulkUpdate / fixed:change.

**Why it matters (architect view).** The Table header comment (6362-6363) states it 'Uses the transaction API for fast incremental updates', yet a lone line-setting tweak takes the wholesale path. At enterprise scale this is a visible jank source and discards row state unnecessarily.

**Recommendation.** Reserve `setGridOption('rowData', ...)` for plant:selected and tasks:bulk. For lineSettings:change, recompute only the affected rows' plant attribution and apply via `applyTransaction({ update })`, or skip when the change doesn't alter selected-plant membership.

**Evidence.**

```
if (evt.type === 'tasks:bulk' || evt.type === 'plant:selected'
    || evt.type === 'lineSettings:change') {
  const rows = Store.tasksForSelectedPlant();
  Table._api.setGridOption('rowData', rows);
```
> _Verifier note:_ Verified at 6770-6773 that lineSettings:change shares the full-reset branch; the applyTransaction path for task:update/bulkUpdate/fixed:change confirmed at 6787-6804. Lowered to low (lineSettings edits are infrequent, single-grid impact).


### 88. [LOW · Inefficiency] rebuild() recomputes the full plant line universe and re-fits height on every coalesced rebuild, including alert-only changes

**Location:** `app.js` lines 6045-6063 (line universe), 6253-6266 (_fitHeight clientHeight read)  |  **Confidence:** medium

**Problem.** Every rebuild() recomputes `Store.tasksForSelectedPlant()`, `new Set(Store.linesForSelectedPlant())` (which runs `Store.allLines().filter(getPlantForLine === plant)` — and allLines unions tasks+calendars+lineSettings+masterData on each call, lines 900-912), a numeric-collation localeCompare sort (6062-6063), then `_fitHeight` which reads `container.clientHeight` (6266, a forced layout read) and calls setOptions. _scheduleRebuild coalesces to one rAF, but an alerts:change still pays for the entire group/line recomputation even when only conflict classes changed.

**Why it matters (architect view).** At 3,500 lines the allLines union + per-line getPlantForLine + numeric sort runs on every rebuild, and the clientHeight read can force reflow. Group membership rarely changes between consecutive data events.

**Recommendation.** Cache sorted visibleLines/groupData keyed on (selectedPlant, GanttFilter selection, Store._rev) and recompute only when that key changes; for alert-only rebuilds, diff just the conflict-class/background items and skip the group + _fitHeight work. Memoize linesForSelectedPlant per (plant, rev).

**Evidence.**

```
const all = Store.tasksForSelectedPlant();
const plantLines = new Set(Store.linesForSelectedPlant());
...
const sortedLines = [...lineSet].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
...
Timeline._fitHeight(visibleLines.length);  // -> const containerH = container.clientHeight; (6266)
```
> _Verifier note:_ Verified line-universe recompute (6045-6063), allLines union (900-912), linesForSelectedPlant (920-924), and the clientHeight read in _fitHeight (6266). Real but already rAF-coalesced and singleton-scoped, so low severity / a tuning optimization rather than a defect.


### 89. [LOW · Inefficiency] Dashboard's Store subscription arms a 300ms debounce on every matching mutation with no tab-visibility gate at the schedule boundary

**Location:** `app.js` lines 7497-7519 (subscribe + debounce), 7649-7654 (active-tab guard inside render)  |  **Confidence:** medium

**Problem.** Every tasks:bulkUpdate/task:update/alerts:change/calendar:change/blocks:change/fixed:change event arms a 300ms-debounced Dashboard.render() (lines 7516-7517) regardless of which tab is active. render() does call Alerts._renderBell() then early-returns when the home tab is inactive (line 7654), so the heavy passes do NOT run while home is hidden — but the timer churn and the implicit _matrix7Cache invalidation (keyed on Store._rev, bumped on every mutation) still occur while the user works on the Gantt. The visibility check belongs at the subscribe/schedule boundary, not after the debounce fires.

**Why it matters (architect view).** Modest: while dragging on the Gantt (task:update + autoReflow per drag) the dashboard re-arms a setTimeout on each event that, 300ms later, does cheap work and bails. The waste is the timer plumbing and cache-key invalidation, not the heavy render (which is correctly gated). Gating at the subscribe boundary removes even that, and lets a single render run on tab-activation via a _dirtyWhileHidden flag.

**Recommendation.** Gate the subscription handler on tab visibility before arming the debounce: if home is not active, call Alerts._renderBell(), set a _dirtyWhileHidden flag, and return; run one render() on home-tab activation. (No _isHomeActive helper exists today — the check is inlined at line 7654.)

**Evidence.**

```
Lines 7516-7517: `clearTimeout(Dashboard._renderDebounced); Dashboard._renderDebounced = setTimeout(() => Dashboard.render(), 300);` — armed unconditionally. Line 7654: `if (!document.getElementById('home-tab').classList.contains('active')) return;` — guard is inside render(), after the timer fired.
```
> _Verifier note:_ Verified the code. Heavily corrected the original headline, which falsely claimed 'runs the full heavy KPI/heatmap/lateness pipeline regardless of whether the home tab is visible' — the heavy passes ARE gated at 7654; only timer churn + cache-key invalidation leak. Downgraded high→low and rewrote to the real, modest issue.


### 90. [LOW · Inefficiency] WelcomeSplash runs an indefinite per-frame rAF getBoundingClientRect loop to reposition a static decorative arrow

**Location:** `app.js` lines 14238-14279  |  **Confidence:** high

**Problem.** _startArrowLoop schedules _positionArrow on requestAnimationFrame indefinitely; _positionArrow reads two getBoundingClientRect() (forced layout) and rewrites the SVG path + polygon points every frame for the whole time the splash is shown. The geometry only changes on resize/scroll yet is recomputed ~60×/sec. The code comment itself acknowledges 'layout thrash', mitigated only by pause-on-tab-hide.

**Why it matters (architect view).** A continuous rAF reflow loop for a static decorative arrow burns CPU/battery on the very first screen the user sees, before any plant is selected. It 'works' but recomputes identical geometry every frame — a permanent rAF a senior would not ship for static content.

**Recommendation.** Position the arrow once on init, then recompute only on debounced 'resize'/'scroll' plus a ResizeObserver on the plant selector. Drop the rAF loop (and the pause/resume plumbing it requires for this module).

**Evidence.**

```
function tick() { _positionArrow(); _rafId = requestAnimationFrame(tick); } _rafId = requestAnimationFrame(tick); // _positionArrow: const pr = plantEl.getBoundingClientRect(); const cr = card.getBoundingClientRect();
```
> _Verifier note:_ Verified 14238-14279 and the pause-on-hide at 14310-14311. Real but minor; finding already acknowledges the hide-pause mitigation. Kept at low.


### 91. [LOW · Maintainability] Color-wheel fetch/upload/delete bypass the traced fetch wrapper and hardcode the actor email (X-User)

**Location:** `app.js` lines _fetchAndRenderOptimization 1842-1851; _uploadWheel 1933-1936; _confirmDeleteWheel 1961-1964  |  **Confidence:** high

**Problem.** All three color-wheel network calls use raw fetch() with ad-hoc .then/.catch chains instead of Util.fetchTraced, and two of them hardcode headers: { 'X-User': 'trevor.holton@newellco.com' } (1935, 1963). CLAUDE.md names Util.fetchTraced (defined at line 275) as the standard wrapper that attaches x-request-id and logs slow/failed requests, so these color-wheel ops are invisible to the request-id correlation the rest of the app relies on.

**Why it matters (architect view).** The fetchTraced bypass means color-wheel uploads/deletes can't be correlated to backend logs by request id. The hardcoded actor email is a real smell, but it is NOT localized to these three lines — the same literal appears at 10+ sites (2349, 2364, 5332, 14646, 14743, 15424, 15544, 15574, 15600, 15649…), and CLAUDE.md already documents actor identity as a spoofable stopgap pending Entra SSO. So the audit-trail point is a known, systemic limitation, not a color-wheel-specific defect.

**Recommendation.** Route these three calls through Util.fetchTraced for request-id correlation (the genuinely actionable, localized fix). For the actor email, address it once at the systemic level (a central identity helper, or let the backend derive identity) as part of the already-planned Entra SSO work in MIGRATION.md — not as a per-callsite patch.

**Evidence.**

```
1935 & 1963: headers: { 'X-User': 'trevor.holton@newellco.com' }  // identical literal also at 2349, 5332, 14646, 15424, … (10+ sites)
```
> _Verifier note:_ Confirmed the three raw-fetch callsites and the hardcoded email at 1935/1963. Grep shows the literal is systemic (10+ occurrences) and CLAUDE.md already flags spoofable actor identity as a documented stopgap — so I reframed the keepable core as the fetchTraced bypass and downgraded the actor claim from a 'fiction'/medium framing to a known systemic item; net severity low.


### 92. [LOW · Maintainability] Drawer alert rows wire actions via inline onclick string handlers — inconsistent with the delegated pattern used 30 lines above

**Location:** `app.js` lines 4187-4202  |  **Confidence:** high

**Problem.** _renderAlertRow (4187-4202) emits `onclick="NIMBUS.Alerts.focus('...')"`, `applyFix`, `toggleDrawer`, `dismiss` etc. as inline attribute strings on the global NIMBUS namespace, with IDs interpolated through a hand-rolled esc. The neighbouring showForCell modal (4159-4176) already uses the correct delegated pattern — one addEventListener with data-act/data-id. The drawer rows render into a VirtualList (4221-4227) whose rows recycle, so the inline handlers are re-serialized on every windowed update.

**Why it matters (architect view).** Inconsistent with the delegated handler used for the same alert data 30 lines above; inline onclick strings bypass CSP, can't be unit-tested, and re-bind per row instead of one delegated listener. The XSS angle is weak here (alert IDs are MD5-derived, not free user text, and esc covers quotes), so this is maintainability/consistency, not a live security hole.

**Recommendation.** Switch the drawer to the same single delegated click listener + data-act/data-id dispatch already used by showForCell (4159-4176). One listener on #alert-drawer-body; rows carry only data attributes.

**Evidence.**

```
4197 `(a.taskId != null ? \`<button class="btn btn-ghost sm" onclick="NIMBUS.Alerts.focus('${esc(a.id)}')">${t('btn.go_to')}</button>\` : '')` vs the delegated pattern at 4159-4162 `dlg.addEventListener('click', e => { const btn = e.target.closest('[data-act]'); ... const act = btn.dataset.act, aid = btn.dataset.id;`.
```
> _Verifier note:_ Verified inline onclick at 4197-4200, the contrasting delegated listener at 4159-4176, and that rows render through VirtualList (4221). Downgraded medium→low and softened the XSS claim: IDs are hashes, esc handles quotes — the real value is consistency + avoiding per-row rebind in a recycling list.


### 93. [LOW · Maintainability] applyPreset('horizon') reaches into Store._state and uses a 20160 default that diverges from the rest of the horizon code

**Location:** `app.js` lines 5112-5114  |  **Confidence:** medium

**Problem.** The 'horizon' preset resolves the plant horizon inline: `const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null; const horizonMinutes = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? 20160; days = Math.max(1, Math.ceil(horizonMinutes / 1440));`. It reaches through Store internals (_state.masterData) and hardcodes both the 20160 (14-day) fallback and the /1440 minutes-per-day divisor.

**Why it matters (architect view).** The fallback default is INCONSISTENT across the codebase: the other plant-horizon resolvers (4208, 4292, 5883, 6153, 8083) use `?? null`, while 14584/14585 use `?? 43200` / `?? 20160`. So this site silently picks a different no-config default (20160) than its siblings — exactly the divergence a single accessor would prevent. The linear .find over masterData.plants also does not scale to 50+ plants, and the raw _state access duplicates a pattern that exists in ~7 places without a shared helper.

**Recommendation.** Add a Store accessor (e.g. Store.plantHorizonMinutes(plant), O(1) via a plant-keyed index) that owns the alt_flag_horizon -> userSettings -> default fallback chain with a single named DEFAULT constant; call it here and at the other ~7 sites so the default cannot diverge. Define a named minutes-per-day constant (Config currently has only MS_DAY, not MINUTES_PER_DAY) rather than the bare 1440.

**Evidence.**

```
5112-5114 as quoted. Compare 4208/4292/5883/6153/8083 which all use `... ?? Store.userSettings?.alertHorizonMinutes ?? null` (null, not 20160), and 14584/14585 which use 43200/20160.
```
> _Verifier note:_ Verified the exact code at 5112-5114. Corrected the original finding: 20160 is NOT uniformly duplicated — sibling sites use `?? null`, so the real issue is a DIVERGENT default here (stronger argument). Also noted Config.MINUTES_PER_DAY does not exist (only MS_DAY), so the recommendation must define it. Severity low — latent inconsistency on a non-hot path (preset apply, not per-keystroke).


### 94. [LOW · Maintainability] Timeline 1-second ticker setInterval handle is discarded — no teardown, plus a per-second linear plants scan

**Location:** `app.js` lines 5874-5892  |  **Confidence:** high

**Problem.** init() starts `setInterval(() => {...}, 1000)` whose handle is never stored and is never cleared — there is no `Timeline._tickerId` and no teardown, in contrast to AdminCockpit which stores `_healthTimer` and clears it (11739/11748). Each tick also resolves alt_flag_horizon via `Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant)` — an O(plants) linear scan on a wall-clock timer for a value that only changes on plant switch.

**Why it matters (architect view).** The per-second `plants.find` is wasteful at 50+ plants for a rarely-changing value. The missing teardown is a latent hazard: any future Timeline re-init (SPA re-mount, test harness) would stack intervals that keep mutating the DataSet — though today Timeline is a boot-time singleton with no re-init path, so this is hypothetical.

**Recommendation.** Store the handle as `Timeline._tickerId = setInterval(...)` and add a teardown that clears it (mirroring AdminCockpit._healthTimer). Cache the resolved horizon on plant:selected rather than re-scanning `plants` every second; the ticker should only push the date/zone updates.

**Evidence.**

```
setInterval(() => {
  if (document.hidden) return;
  ... const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
  ...
}, 1000);  // 5874-5892, handle discarded; no clearInterval for it (grep confirms)
```
> _Verifier note:_ Verified ticker at 5874-5892 with no stored handle/clearInterval (grep). Confirmed _healthTimer contrast at 11739/11748 and the per-second plants.find at 5882. Lowered to low severity: Timeline is a boot singleton so the re-init stacking risk is hypothetical; the concrete cost is the per-second linear scan.


### 95. [LOW · Maintainability] _tileTooltip hardcodes English strings (breaking i18n) and is a parallel switch with _tileClick over the same action keys

**Location:** `app.js` lines 7831-7841 (_tileTooltip), 7843-7882 (_tileClick), tiles[] at 7763  |  **Confidence:** high

**Problem.** _tileTooltip (lines 7831-7841) returns hardcoded English ('Open Orders table filtered to today', etc.) while the rest of NIMBUS routes user-facing text through t()/window.t() (verified: titles/tooltips elsewhere use `title="${t(...)}"`, e.g. lines 1407, 4198, 7282, 13707-13710). Separately, _tileTooltip and _tileClick (line 7843) are two independent switch statements keyed by the same action set ('orders-today','late','conflicts','alerts','headroom','fixed'), so adding a tile means editing tiles[] (line 7763), _tileTooltip, and _tileClick in three places with no shared source of truth. (Note: this hardcoding is not unique to _tileTooltip — the line-status header 'Line/Hours/%/Next CO' at 8054-8057 and the heatmap cell titles are also English; worth folding into the same i18n pass.)

**Why it matters (architect view).** Hardcoded strings break localization for the documented de/es/fr/pt locales specifically on the dashboard tooltips. The triple-keyed switch is stringly-typed dispatch that can silently drift (a new action with a click handler but no tooltip, or vice versa). Low severity — cosmetic/maintainability, no correctness or perf impact.

**Recommendation.** Move the tooltip strings into the locale maps (t('tooltip.kpi.orders_today') etc.). Replace the two switches with one action registry, e.g. const ACTIONS = { 'orders-today': { tooltip: 'tooltip...', run() {...} }, ... }, so each tile's tooltip and behavior live together and tiles[] references keys guaranteed to exist.

**Evidence.**

```
Line 7833: `case 'orders-today': return 'Open Orders table filtered to today';`. Two parallel switches over the same keys: `switch (action)` at 7832 (_tileTooltip) and 7844 (_tileClick). Contrast localized titles at 7282 `title="${window.t('ui.insp_variance_shifted')}"`.
```
> _Verifier note:_ Confirmed the English literals and parallel switches, and that the rest of the app localizes titles via t(). Low severity (cosmetic). Added that several other dashboard literals share the gap so the fix is scoped sensibly.


### 96. [LOW · Maintainability] TimelineNav/DependencyOverlay store-unsub handles are stored but never invoked; window + vis-timeline listeners have no teardown and capture Timeline._tl once

**Location:** `app.js` lines 8367, 8387-8398, 8414-8428, 8844-8845, 8865-8877  |  **Confidence:** high

**Problem.** TimelineNav assigns `_unsubStore` (8420) and DependencyOverlay assigns `_unsubStore` (8871) but nothing ever calls them — neither module has a destroy()/teardown path. DependencyOverlay declares `_unsubRange` (8845) that is never even assigned (dead field). TimelineNav also binds `window.addEventListener('mousemove'/'mouseup'/'resize')` (8387/8398/8428) and `Timeline._tl.on('rangechange[d]')` (8415-8416) / DependencyOverlay (8867-8868) with anonymous handlers that cannot be removed and capture `Timeline._tl` once at init.

**Why it matters (architect view).** The stored-but-unused unsub handles imply a lifecycle that does not exist, misleading the next maintainer. The anonymous window/vis listeners and one-time `Timeline._tl` capture become a leak/double-bind/stale-instance hazard the moment init() can run more than once (hard data reload, future SPA nav) — but there is no such re-init path today, so impact is latent only.

**Recommendation.** Either delete the dead `_unsubStore`/`_unsubRange` fields, or implement a real destroy() that calls them plus `Timeline._tl.off(...)` and `window.removeEventListener(...)` (store named handler refs). If a re-init path is ever added, guard init() against double-binding and re-resolve `Timeline._tl` inside handlers.

**Evidence.**

```
8367: _unsubStore: null,  8420: TimelineNav._unsubStore = Store.subscribe(...);  8845: _unsubRange: null,  // never assigned  8871: DependencyOverlay._unsubStore = Store.subscribe(...);  grep confirms no `_unsubStore()` / `_unsubRange()` invocation and no destroy() on either module.
```
> _Verifier note:_ Grep confirmed the unsub handles are assigned but never called and neither module defines destroy(); _unsubRange is never even assigned. Severity lowered to low: real but purely latent — there is no current code path that re-runs init().


### 97. [LOW · Maintainability] TimelineNav 42-day horizon hardcoded in two methods, and the 'system-wide' heat-band comment is contradicted by computeMatrix's plant scoping

**Location:** `app.js` lines 8439, 8455-8464, 8481  |  **Confidence:** high

**Problem.** The minimap window `scheduleMin + 42 * Config.MS_DAY` is duplicated in `_scheduleRange()` (8439) and `render()` (8464) — a magic number kept in sync by hand. Separately, the comment at 8455-8457 states the `computeMatrix` heat-band 'stays intentionally system-wide,' but render() calls `Utilization.computeMatrix(new Date(scheduleMin), ...)` with NO `srcTasks` (8481), so the memoized `srcTasks===null` path applies and computeMatrix scopes its line set to `Store.linesForSelectedPlant()` whenever a plant is selected (verified at 4355-4376). The heat-band is therefore plant-scoped, not system-wide — the comment asserts the opposite on the exact per-plant axis CLAUDE.md treats as the primary scalability constraint.

**Why it matters (architect view).** The duplicated horizon invites drift (one method could pan a span it doesn't render). The stale comment actively misdirects the next maintainer about cross-plant behavior — a documentation defect, not just a typo, on a sensitive axis.

**Recommendation.** Hoist the horizon to a named constant (e.g. Config.NAV_HORIZON_DAYS = 42) referenced by both methods. Correct the comment to state the heat-band is plant-scoped (matching computeMatrix), or, if a true global view is intended, pass an explicit all-lines `srcTasks` so behavior matches the comment.

**Evidence.**

```
8439 and 8464: const scheduleMax = scheduleMin + 42 * Config.MS_DAY;  8456-8457 comment: 'The utilization heat-band below (computeMatrix) stays intentionally system-wide.'  8481: Utilization.computeMatrix(new Date(scheduleMin), ...) with no srcTasks ⇒ 4362-4375 scopes lines to Store.linesForSelectedPlant() when a plant is selected.
```
> _Verifier note:_ Verified the comment is genuinely false: computeMatrix(4355-4376) plant-scopes the srcTasks===null path, and render passes no srcTasks (8481). Duplicated 42 confirmed at 8439 & 8464. Low severity is correct — the stale comment is the substantive part; the dup constant is minor.


### 98. [LOW · Maintainability] load() read path and _refreshTasks use bare fetch (no x-request-id tracing) while reconnect/saveAll use fetchTraced

**Location:** `app.js` lines 10761-10762, 10776, 10803-10804, 10918-10919, 11389 (bare fetch) vs 10968, 11307 (Util.fetchTraced)  |  **Confidence:** high

**Problem.** The module mixes two fetch conventions. The reconnect watcher (10968) and saveAll (11307) use Util.fetchTraced — which attaches x-request-id and logs slow (>2000ms) / failed requests. But every fetch in load() — the /tasks read and all master-data fetches — plus _refreshTasks at 11389 uses bare fetch(...). So the primary read path and conflict-refetch path are invisible to the x-request-id correlation the rest of the app relies on.

**Why it matters (architect view).** The highest-frequency, highest-latency call (GET /tasks) bypasses fetchTraced, so when a load is slow at scale there is no traced client entry to correlate with the backend's per-request logs, and the slow-request threshold logging never fires for these calls.

**Recommendation.** Route all data fetches in load() and _refreshTasks through Util.fetchTraced for uniform tracing/slow-logging, or document why the read path deliberately opts out. Pick one convention module-wide.

**Evidence.**

```
fetchTraced (line 275) sets x-request-id and logs >2000ms / failures. load(): `return fetch(tasksUrl, { signal: AbortSignal.timeout(8000) })` (10776) and `fetch(`${Config.API_BASE}/master-data/plants`, ...)` (10761/10803/10918); _refreshTasks: `fetch(`${Config.API_BASE}/tasks/refresh`, ...)` (11389). vs reconnect `Util.fetchTraced(`${Config.API_BASE}/health`...)` (10968), saveAll `Util.fetchTraced(`${Config.API_BASE}/tasks/update`...)` (11307).
```
> _Verifier note:_ Grep of fetchTraced confirms the split; read fetchTraced impl (275-313) to verify it adds x-request-id + slow-logging. All cited bare-fetch sites verified. Correct but low severity (observability gap, not a behavior bug).


### 99. [LOW · Maintainability] Loop-variable `t` shadows the global i18n function `t` inside DB-deep render predicates

**Location:** `app.js` lines 12606, 12775, 12264  |  **Confidence:** high

**Problem.** `t` is the global i18n resolver (window.t defined at line 419, used hundreds of times in this same function as t('ui.…')). Yet inside _renderDbDeep and _dbSummaryStrip the predicates reuse `t` as the iteration variable: `tables.some(t => t.needs_vacuum || t.needs_analyze)` (12606) and `tables.filter(t => t.needs_vacuum || t.needs_analyze)` (12775). _updatePurgeCount does the same with `(Store.tasksArr || []).filter(t => t.end_date …)` (12264).

**Why it matters (architect view).** Inside those arrow bodies `t` no longer means the translator — it means a table/task row. Today the bodies don't call t(), so it works, but any future edit that adds an i18n string inside one of these predicates would silently call row('ui.key') and throw. A latent footgun in a file whose whole convention is t = translate; _dbTableCards two functions away already correctly uses `tbl`.

**Recommendation.** Rename the shadowing parameters to `tbl`/`task` (the file already uses `tbl` at 12850). A no-shadow lint rule on the global `t` would catch the class permanently.

**Evidence.**

```
const tablesNeedWork = !hasTableErr && tables.some(t => t.needs_vacuum || t.needs_analyze);
```
> _Verifier note:_ Verified all three shadow sites (12606, 12775, 12264) and that window.t is the global translator (419). Real latent footgun but no active bug today — low severity, not medium.


### 100. [LOW · Maintainability] Four divergent 'admin tab visible' gate predicates re-implemented across timers/subscriptions

**Location:** `app.js` lines 11737-11743 (health timer), 11684-11689 (ErrorLog sub), 11700-11708 (Store tasks:bulk sub), 11696-11698 (PerfMonitor sub)  |  **Confidence:** high

**Problem.** Four independent callbacks each re-implement an 'only work if admin tab is active' check with subtly different predicates: the 30s health timer and the ErrorLog/Store subscribers each re-query `document.getElementById('admin-tab')?.classList.contains('active')`, while the PerfMonitor subscriber checks `_activeOvTab === 'thread'`. None consults the overview sub-tab state (_activeSub). Because _setSub('manage') hides the overview pane but keeps admin-tab .active, the 30s health poll keeps fetching /health on the 'manage' sub-tab where the health chips aren't even shown.

**Why it matters (architect view).** The duplicated-and-divergent gate is a maintenance smell that keeps producing 'why is it still polling' bugs, and the missing _activeSub check is a small avoidable recurring fetch.

**Recommendation.** Add one AdminCockpit._isOverviewVisible() predicate (tab active AND _activeSub === 'overview' AND relevant ov-tab) and have all four callbacks consult it, collapsing four DOM probes into one source of truth.

**Evidence.**

```
AdminCockpit._healthTimer = setInterval(() => { if (document.getElementById('admin-tab')?.classList.contains('active')) { AdminCockpit._renderHealth(); } }, 30_000);
```
> _Verifier note:_ Verified all four gate sites and that _setSub('manage') leaves admin-tab .active (1597-1607) so the health poll fires on the manage sub-tab. Accurate but genuinely low-impact (one /health/30s).


### 101. [LOW · Maintainability] Inline RGBA/hex color and background literals in row builders bypass the design-token + dark-mode layer

**Location:** `app.js` lines 13058-13059 (_dbTable row tints), 13323-13331/13354 (SCOPE_COLORS), 13490 (audit cell color)  |  **Confidence:** medium

**Problem.** _dbTable sets raw `tr.style.background = 'rgba(192,57,43,0.07)'` / `'rgba(243,156,18,0.06)'` inline (13058-13059); _renderLogs defines a SCOPE_COLORS map that mixes design tokens with raw hex (`engine: '#9b59b6'`, `store: '#16a085'`, `calendar: '#2ecc71'`, `interaction: '#e67e22'`) applied via `scope.style.color` (13323-13354). The raw rgba/hex literals bypass the CSS-variable token system and the `body.dark` layer entirely.

**Why it matters (architect view).** CLAUDE.md explicitly flags that body.dark is incomplete because newer components hardcode light colors; these inline rgba row-tints and raw-hex scope colors are instances — they will not adapt in dark mode and can't be re-themed without editing JS.

**Recommendation.** Replace inline assignments with semantic classes — `tr.classList.add('row-err'/'row-warn')` and `scope.dataset.scope = e.scope` styled via `[data-scope=engine]` rules — defined once in styles.css with dark-mode counterparts. The SCOPE_COLORS object becomes a CSS concern.

**Evidence.**

```
13058: `if (rowErr) tr.style.background = 'rgba(192,57,43,0.07)'; else if (rowWarn) tr.style.background = 'rgba(243,156,18,0.06)';` and 13325-13330: `engine: '#9b59b6', … store: '#16a085', calendar: '#2ecc71', interaction: '#e67e22'` applied at 13354 `scope.style.color = SCOPE_COLORS[e.scope];`.
```
> _Verifier note:_ Verified the literals. Note for accuracy: several SCOPE_COLORS entries and the 13490 audit cell already use `var(--token,fallback)` (token-aware) — the genuinely un-themeable ones are the 13058 rgba row tints and the raw-hex scope colors. Severity correctly low; 13615 cited by the original is fontWeight, not color.


### 102. [LOW · Maintainability] Document-level click listener for the column menu leaks when the menu closes via a menu-item click

**Location:** `app.js` lines 15475-15503 (_openColMenu)  |  **Confidence:** high

**Problem.** _openColMenu appends a document-level click listener (`document.addEventListener('click', close)`) via setTimeout (15502), and only detaches it inside `close` when the click lands outside the menu (15501). The rename/drop onclick paths call `menu.remove()` directly (15485, 15493) without invoking `close`, so the outside-click listener is never detached in those branches. Opening the menu only removes prior `.md-col-menu` DOM nodes (15477), not their still-registered listeners.

**Why it matters (architect view).** Each column-menu open that ends via a menu-item click (rename/drop) leaves a dangling document click listener whose closure retains the detached `menu`. Over a long admin session with many column operations these accumulate, and stale closures keep firing menu.contains against detached nodes. A slow listener leak rather than a crash, but the kind of cross-cutting infra smell that compounds.

**Recommendation.** Track the active menu + handler at module scope and always detach through a single closeMenu() helper that both menu.remove() and document.removeEventListener go through; call it from the rename/drop onclick paths too. Or use { once: true } plus an explicit teardown on item-click.

**Evidence.**

```
15501 `const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };`; 15485 `rename.onclick = () => { menu.remove(); _openRenameLabel(table, col); };` (no close); 15493 `drop.onclick = () => { menu.remove(); _dropColumn(table, col); };` (no close); 15502 `setTimeout(() => document.addEventListener('click', close), 0);`.
```
> _Verifier note:_ Verified: rename/drop onclick both call menu.remove() directly without removing the document listener; close only detaches on outside-click. Low severity as flagged.


### 103. [LOW · Scalability] Plant roster renders a full inline-styled table for all of a plant's lines at once — no virtualization or event delegation

**Location:** `app.js` lines _renderRoster 1725-1801 (cell build 1760-1784, listener rewire 1788-1795)  |  **Confidence:** high

**Problem.** _renderRoster() maps over every line of the selected plant (Store.linesForSelectedPlant()) and emits, per line, a <tr> with 7 schedule sub-cells, badges, and a text input — repeating long inline style strings on every cell (e.g. the schedCells div at 1764). The whole table is set via innerHTML, then querySelectorAll('.roster-plgroup-input') rewires onchange per input (1788-1795).

**Why it matters (architect view).** The roadmap puts 70+ lines per plant: ~70 rows × (7 schedule cells + input + badges) ≈ several hundred inline-styled nodes built as one string and parsed at once, plus a per-input listener loop. It is collapsed by default (_rosterCollapsed), which defers but does not remove the cost. (Bounded to one plant, so this is a real-but-modest hit — low, not the browser-locker that the system-wide Calendar tab is.)

**Recommendation.** Move the static cell/th styles into styles.css classes, render the roster through VirtualList (or paginate), and use event delegation (one listener on the roster container reading data-line) instead of querySelectorAll + per-input onchange.

**Evidence.**

```
lines.map((line, li) => { ... const schedCells = [0..6].map(d => `<div style="text-align:center;font-size:11px;line-height:1.4;min-width:56px;">...`).join(''); ... }).join('')  // roster.querySelectorAll('.roster-plgroup-input').forEach(... onchange ...)
```
> _Verifier note:_ Verified at 1725-1801; scoped to linesForSelectedPlant (one plant, ~70 rows max) and collapsed by default, so I downgraded severity from medium to low — the impact is real but bounded, unlike Finding 1.


### 104. [LOW · Scalability] Table line/color chip dropdowns rebuild by full task scan + innerHTML on every store event, with no search box

**Location:** `app.js` lines 6585-6619 (_buildLineChipDropdown / _buildColorChipDropdown); 6782 (_refreshChipDropdowns on store events)  |  **Confidence:** medium

**Problem.** _buildLineChipDropdown and _buildColorChipDropdown each iterate `Store.tasksForSelectedPlant()` into a Set, sort, then regenerate innerHTML with one checkbox <label> per distinct value. _onStore calls `_refreshChipDropdowns()` (6782, runs all four builders) on tasks:bulk, plant:selected, and lineSettings:change. The line dropdown is an all-at-once checkbox list with no type-to-filter.

**Why it matters (architect view).** At 70+ lines per plant the line checkbox list is the unfilterable chip anti-pattern CLAUDE.md warns against for line selectors, and the repeated full-task scan + innerHTML regeneration on every store event is wasted work.

**Recommendation.** Derive distinct lines/colors once per (plant, rev) and cache, rebuilding dropdown DOM only when the set changes. Add a type-to-filter search box to the line dropdown — note OptimizeDialog's line list (around 5035, `filterLines`/`_lineSearch`) already implements exactly this pattern and can be reused.

**Evidence.**

```
_buildLineChipDropdown() { ... for (const t of (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])) { if (t.PRODUCTION_LINE) lineSet.add(t.PRODUCTION_LINE); } const sorted = [...lineSet].sort(...); ... drop.innerHTML = sorted.map(l => `<label>...`).join('') }  // 6585-6601
```
> _Verifier note:_ Verified the chip-dropdown builders (6585-6619) and _refreshChipDropdowns wiring (6578-6583, called at 6782). Corrected the title: these are the TABLE chip filters, not GanttFilter (a separate module at 8562) — the original conflated them. Confirmed OptimizeDialog already has the search-box pattern (5035-5064) the fix would reuse.


### 105. [LOW · Scalability] _buildFilterOptions scans the GLOBAL tasksArr to build an all-plants plant→lines map on every reload, though only the selected plant's dropdown is shown

**Location:** `app.js` lines 7554-7566 (build), 7509-7514 (tasks:bulk re-trigger), 7580 (single-plant read)  |  **Confidence:** high

**Problem.** _buildFilterOptions iterates the entire Store.tasksArr (all plants, line 7556) calling getPlantForLine per task to build Dashboard._plantLines = { plant → Set<line> } for ALL plants (line 7563), even though the dropdown only ever reads the selected plant's set (line 7580 `Dashboard._plantLines[Store.selectedPlant]`). It runs on init (line 7543) and again on every tasks:bulk after a 350ms debounce (line 7513), rebuilding the full cross-plant map from scratch each reload.

**Why it matters (architect view).** At 50+ plants × thousands of orders this is O(all orders) per reload when only the selected plant's lines are needed. _plantLines is a global structure, mildly at odds with CLAUDE.md's 'retrieval keyed by plant ID' guidance. Severity is low because it is debounced and fires on reload only (not per edit/keystroke), and getPlantForLine is O(1)-cached.

**Recommendation.** Reuse the maintained plant index instead of re-scanning tasksArr — derive the dropdown lines for the selected plant only (via a memoized linesForSelectedPlant per the related finding), or build the cross-plant map once inside Store._rebuildPlantIndex rather than recomputing in the Dashboard on each reload.

**Evidence.**

```
Lines 7556-7562: `for (const t of Store.tasksArr) { const p = Store.getPlantForLine(t.PRODUCTION_LINE); ... plantLines[p].add(l); }`. Line 7563: `Dashboard._plantLines = plantLines;`. Read at line 7580.
```
> _Verifier note:_ Verified the global scan and single-plant read. Downgraded severity from medium to low: it is debounced and runs on reload only, and getPlantForLine is O(1)-cached, so the practical cost is bounded. Real but minor.



## `nimbus-intelligence.js` — 14 findings (2 high · 7 medium · 5 low)

### 106. [HIGH · Scalability] NeedsEngine and CommandPalette index/scan the GLOBAL task array (all plants) instead of the selected-plant subset

**Location:** `nimbus-intelligence.js` lines 427-430, 472-474, 860, 876  |  **Confidence:** high

**Problem.** `NeedsEngine._readState()` reads `Store.tasksArr` (427) and scans it for unscheduled (430) and blackout-risk (472-474) counts, and `CommandPalette._buildIndex()` iterates `Store.tasksArr.slice(0, 2000)` (860) plus `new Set(Store.tasksArr.map(...))` for the line list (876). `Store.tasksArr` is `Object.values(this._state.tasks)` (app.js:616) — every order across EVERY plant. The Store already exposes plant-scoped accessors `Store.tasksByPlant(plant)` (backed by the prebuilt `_tasksByPlant` index, app.js:881-898) and `Store.linesForSelectedPlant()` (app.js:920-924).

**Why it matters (architect view).** The whole intelligence layer is gated on a selected plant (FAB locked / Cmd+K early-returns when `!Store.selectedPlant`, lines 747, 782), so its inputs should be plant-scoped but are global. At the roadmap target (50+ plants, 3,500+ lines) every Cmd+K rebuilds an index over all orders, the line `Set` spans all lines system-wide, and the unscheduled/blackout need-scans count orders from OTHER plants the user isn't viewing — surfacing misleading 'Right Now' prompts. The `.slice(0, 2000)` cap silently truncates the searchable order index in insertion order, so a large plant's orders may not be searchable at all. (Note: the peak-utilization scan in `_readState` at line 436 calls `computeMatrix(now, 7)`, which IS already plant-scoped via the matrix cache key — so this finding applies to the unscheduled/blackout/line-set/order-index scans, not that util scan.)

**Recommendation.** Route the order/line reads through `Store.tasksByPlant(Store.selectedPlant)` and the line `Set` through `Store.linesForSelectedPlant()`. Build the command-palette index from the plant subset (eliminating the magic 2000 cap, or making it per-plant), so index cost is proportional to the active plant and the cross-plant leakage in needs/selection stats disappears.

**Evidence.**

```
_readState(): const tasks = Store.tasksArr; (427); const unscheduled = tasks.filter(t => !t.start_date || !t.end_date); (430); blackoutRisk = tasks.filter(...) over Store.blocks/plantBlocks (472-474). _buildIndex(): for (const t of Store.tasksArr.slice(0, 2000)) (860); const lines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE).filter(Boolean))]; (876).
```
> _Verifier note:_ Verified excerpts at 427/430/472/860/876 and confirmed Store.tasksArr is global (app.js:616) while tasksByPlant/linesForSelectedPlant exist (app.js:881-924). Corrected line numbers and noted the line-436 util scan is already plant-scoped, so that part of the original claim was overstated.


### 107. [HIGH · Scalability] TimeMachine snapshots the GLOBAL task array (all plants) on every auto-snapshot; only the plant TAG is scoped, not the stored payload

**Location:** `nimbus-intelligence.js` lines 1194-1203, 1209-1237, 1242-1246  |  **Confidence:** high

**Problem.** `snapshot()` maps `Store.tasksArr` (1215) — the global cross-plant array — into a per-order blob and writes it to IndexedDB. It is wired onto `UndoStack.push` (1194-1197) and onto every `tasks:bulk`/`tasks:bulkUpdate` Store event (1198-1203), debounced 1s. The snapshot is tagged `plant: Store.selectedPlant` (1214) but the `tasks` payload is NOT filtered to that plant. `_plantSnaps()` (1242-1246) filters snapshots by the tag for DISPLAY only; each stored blob still contains every plant's orders, and `restore()` patches by id intersection with `Store.tasks` (1297-1298), so cross-plant rows in the blob are dead weight.

**Why it matters (architect view).** At 3,500 lines / hundreds of thousands of orders, each snapshot is a full structured copy of the entire order universe, written up to once per second of activity and retained 200 deep (`pruneSnapshots(200)`, 1230). That is a large IndexedDB footprint plus a main-thread serialization cost per drag-storm, and it directly contradicts the roadmap's per-plant storage mandate.

**Recommendation.** Snapshot only `Store.tasksByPlant(Store.selectedPlant)` so each blob is bounded by the active plant. Consider storing a delta against the previous snapshot (1s-apart auto-snapshots are nearly identical). Keep the 200-deep prune but make it per-plant so one busy plant doesn't evict another's history.

**Evidence.**

```
plant: Store.selectedPlant || null, (1214) — tag only. tasks: Store.tasksArr.map(t => ({ id, start_date, end_date, PRODUCTION_LINE, ... })) (1215) — payload NOT scoped. IntelDB.put('snapshots', snap).then(... IntelDB.pruneSnapshots(200)) (1227-1230). _plantSnaps filters by s.plant === p (1245); restore filters s.tasks by Store.tasks[s.id] (1298).
```
> _Verifier note:_ Verified every cited line. snapshot() does map global Store.tasksArr while tagging only plant; _plantSnaps is a display filter; restore is id-intersection. All claims hold; adjusted line ranges to match actual code (snapshot body 1209-1237).


### 108. [MED · Correctness] RipplePreview ghosts are position:fixed snapshots of getBoundingClientRect that never reposition, and init wires global listeners with no teardown

**Location:** `nimbus-intelligence.js` lines 1739-1812 (init + _show); fixed-coord ghost at 1795-1804  |  **Confidence:** high

**Problem.** _show captures `el.getBoundingClientRect()` into a `position:fixed` ghost and appends it to document.body. Ghosts are only cleared on keyup, blur, visibilitychange, or hovering a non-item — never repositioned. Any Gantt scroll, vertical pan, or window zoom while Alt is held leaves the ghosts floating over the wrong rows. Separately, init attaches document-level keydown/keyup, window blur, document visibilitychange, and a gantt `mouseover` listener with no stored handles and no destroy() path; the gantt element is captured once at init and assumed to live forever.

**Why it matters (architect view).** The Gantt is the primary surface at the target 70+ lines/plant scale, where users scroll constantly. Fixed-viewport coordinates for an element inside a scroll container is the wrong model: the ghosts will routinely point at the wrong orders, which is actively misleading on a scheduling tool. The leaked listeners are a smaller concern since the module is a singleton, but there is no clean teardown if the timeline is ever rebuilt.

**Recommendation.** Position ghosts as native vis-timeline background items (the same channel the comment at 1721-1728 says replaced the old canvas overlay), or absolutely-position them inside the timeline scroll content so they track natively. At minimum, clear ghosts on the timeline's `scroll`/`rangechange` event. Keep handles to the bound listeners so a destroy() can remove them.

**Evidence.**

```
1795-1801: `const r = el.getBoundingClientRect(); ... ghost.style.cssText = \`position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px; ...\`;` then `document.body.appendChild(ghost)`. No reposition handler exists; _clearGhosts (1808) only removes nodes.
```
> _Verifier note:_ Verified: ghosts are position:fixed off a one-time getBoundingClientRect with no scroll/rangechange handler; init's 5 listeners (1741,1747,1763,1764,1769) are never removed.


### 109. [MED · Correctness] Diff.compute treats any non-zero start-date delta as a 'reschedule' and uses `||0` for null start dates, so 1 ms jitter and null↔value transitions both flag as moves

**Location:** `nimbus-intelligence.js` lines 1855-1896 (compute); delta + threshold at 1865-1867; sort at 1879  |  **Confidence:** high

**Problem.** `moved` is populated when `Math.abs(delta) > 0 || lineChanged`, where `delta = (mapB[id].start_date || 0) - (mapA[id].start_date || 0)`. Any difference of even 1 ms counts as a move, and an order that gained or lost a start_date (null↔value) yields `delta = ±the absolute epoch ms` (because of the `||0`), which then sorts to the top of `moved` (`moved.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta))`) as a multi-thousand-hour shift and renders a 'Was: — → Now: …' row. There is no tolerance band.

**Why it matters (architect view).** Diff is meant to summarize what an optimize run changed. Treating a 0-vs-null transition as a ~50-year shift and 1 ms jitter as a reschedule makes the headline summary ('N moved') wrong and the sorted list misleading — the largest 'delta' rows shown to the planner are artifacts, not real reschedules.

**Recommendation.** Classify null↔value transitions as scheduled/unscheduled (a dedicated bucket), not moved. For genuine moves, require `Math.abs(delta) >= ` a tolerance (e.g. 60000 ms) and only compute delta when BOTH sides have a real start_date.

**Evidence.**

```
1865-1867: `const delta = (mapB[id].start_date || 0) - (mapA[id].start_date || 0); const lineChanged = ...; if (Math.abs(delta) > 0 || lineChanged) { moved.push({ ...mapB[id], delta, ... }); }`. 1879: `moved.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));`
```
> _Verifier note:_ Verified the `||0` fallback and `>0` test exactly as cited; enrich (1839-1853) carries numeric ms start_date, so null becomes 0 and the delta is the full epoch magnitude.


### 110. [MED · Duplication] Three parallel action/intent banks re-implement the same actions (conflict-jump, snapshot, diff, optimize) with copy-pasted run bodies that will drift

**Location:** `nimbus-intelligence.js` lines 511-612, 631-715, 901-923  |  **Confidence:** high

**Problem.** The same handful of actions are independently re-implemented in three places: `NeedsEngine._buildBank()` (511), `NeedsEngine.resolveIntent()`'s inline `bank` (633), and `CommandPalette._buildIndex()`'s action list (901). The conflict-jump block `(Store.alerts || []).filter(a => a.sev === 'err').sort((a,b) => a.time - b.time)[0]` + `App.goto('gantt')` + `setTimeout(...Timeline.focus..., 100)` appears verbatim at lines 522, 697, and 905. The snapshot-with-label `new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })` pattern is copy-pasted at 561, 575, 645, 685, 913, and 1148.

**Why it matters (architect view).** Classic rule-in-three-places drift: a fix to the conflict-jump (e.g. honoring plant scope, or changing the 100ms focus delay) must be made in three spots or behaviors diverge; the timestamp label format is repeated 6×. CLAUDE.md already calls out worker/alert rule mirroring as a maintenance hazard — this is the same anti-pattern inside one file.

**Recommendation.** Extract a small `Actions` registry (id → {icon,label,sub,run}) and have NeedsEngine, resolveIntent, and the palette index reference entries by id, attaching only scoring/keyword metadata. Factor the conflict-jump, snapshot-with-label, and goto+focus sequences into named helpers (e.g. `Actions.jumpToFirstConflict()`, `Actions.snapshotNow(prefix)`).

**Evidence.**

```
Conflict-jump identical at 522, 697, 905 (grep confirmed exactly 3 matches of the err-filter-sort line). Snapshot label timestamp at 561, 575, 645, 685, 913, 1148 (grep confirmed).
```
> _Verifier note:_ Verified by grep: the err.sort()[0] block occurs at exactly 522/697/905 and the timestamp label at 561/575/645/685/913/1148. Duplication is real and load-bearing.


### 111. [MED · Duplication] Confidence._recompute and showBreakdown duplicate the entire schedule-scoring algorithm (horizon, time-weights, alert + utilization penalties) — the live badge and its explanation dialog can silently diverge

**Location:** `nimbus-intelligence.js` lines 1382-1412 (_recompute) and 1456-1481 (showBreakdown)  |  **Confidence:** high

**Problem.** The live score (_recompute) and the explanatory dialog (showBreakdown) independently re-derive the SAME scoring rules: the horizon window (hMinutes ?? 20160), the time-weight function `d <= 3 ? 1.5 : d <= 7 ? 1.25 : 1.0`, the alert penalty (`err`=5 / `warn`=2, capped at 50), and the utilization-overload penalty (1.5 points per overloaded line-day, capped at 20). Every magic number (20160, 5, 2, 50, 1.5, 20, and the 3/7-day thresholds) is literally duplicated across the two functions.

**Why it matters (architect view).** These are the core scoring rules of the Confidence feature. Two hand-maintained copies mean the badge number and the breakdown dialog can silently disagree after any tweak to one — exactly the trust-destroying inconsistency that makes planners distrust the intelligence layer. showBreakdown also calls Utilization.computeMatrix a second time purely to re-derive the same util penalty the badge already computed moments earlier.

**Recommendation.** Extract one pure helper, e.g. `Confidence._score(alerts, matrix, opts)` returning `{ score, alertPenalty, utilPenalty, errCt, warnCt, overloadedLines }`. _recompute reads `.score`; showBreakdown reads the breakdown fields. Hoist the constants (HORIZON_MIN_DEFAULT=20160, ERR_PTS=5, WARN_PTS=2, ALERT_CAP=50, UTIL_PTS_PER_DAY=1.5, UTIL_CAP=20, TW thresholds) into a single config object so there is one source of truth.

**Evidence.**

```
_recompute (1397-1400): `const base = a.sev === 'err' ? 5 : a.sev === 'warn' ? 2 : 0; alertPenalty += base * tw(a.time); ... alertPenalty = Math.min(50, ...)`. showBreakdown (1468-1469): `alertPts += (a.sev === 'err' ? 5 : a.sev === 'warn' ? 2 : 0) * tw(a.time); alertPts = Math.min(50, ...)`. Util penalty: _recompute (1407) `utilPenalty += 1.5;` cap 20 (1410); showBreakdown (1480) `const utilPts = Math.min(20, Math.round(overloadedLineDays * 1.5));`. The `tw` arrow with 3/7 thresholds is copied verbatim at 1387-1391 and 1462.
```
> _Verifier note:_ Verified both functions in full: tw arrow, alert penalty (5/2, cap 50), and util penalty (1.5/day, cap 20) are byte-for-byte duplicated; showBreakdown independently re-calls computeMatrix at 1471.


### 112. [MED · Inefficiency] Confidence monkey-patches Alerts.recompute so every alert pass triggers a synchronous, main-thread Utilization.computeMatrix build that is NOT worker-offloaded

**Location:** `nimbus-intelligence.js` lines 1348-1349, 1404  |  **Confidence:** high

**Problem.** `Alerts.recompute` is globally reassigned (1348-1349) to also fire `Confidence._recomputeDebounced()`. `Confidence._recompute()` then builds `Utilization.computeMatrix(horizonStart, Math.ceil(hMinutes/1440))` (1404) — 14 days at the default 20160-minute horizon. This is wired onto every `Alerts.recompute` plus `tasks:bulk`/`task:update`/`task:remove`/`plant:selected` (1330-1346). Critically, `computeMatrix` runs synchronously on the main thread (app.js:4368-4453, with `PerfMonitor.record`); the worker `_prewarm` (app.js:4531) only warms a 7-day matrix (`${startMs}|7|${rev}|${plant}`), so the 14-day Confidence call NEVER hits that prewarm cache and always rebuilds on the UI thread.

**Why it matters (architect view).** Alerts.recompute is on the hot path of every drag, reflow, and bulk edit (CLAUDE.md documents the adaptive debounce + worker offload precisely because it is hot). Wrapping it to also build a 14-day matrix per plant (70+ lines × 14 days ≈ ~1,000 `dailyCapacityHours` cells) on the main thread roughly doubles the recompute surface. The matrix IS plant-scoped (cache key includes `Store.selectedPlant`, app.js:4362; sync line-set scoped at 4375) so it is bounded, not all-system. The `_lastAlertsSrc`/`_lastRev` guard (1375) correctly skips when nothing changed, so the build only runs after a real mutation — which mitigates but does not remove the per-mutation cost.

**Recommendation.** Have Confidence subscribe to a dedicated post-recompute hook rather than monkey-patching a core domain method (CLAUDE.md already flags hidden cross-module coupling as drift-prone). Either reuse the alert worker's utilization output, or make the prewarm warm the same horizon-days Confidence requests so the synchronous build hits cache, or route the Confidence matrix through the `Compute` worker wrapper so it is off the main thread.

**Evidence.**

```
const origRecompute = Alerts.recompute.bind(Alerts); Alerts.recompute = (...args) => { const r = origRecompute(...args); Confidence._recomputeDebounced(); return r; }; (1348-1349). const matrix = Utilization.computeMatrix(horizonStart, Math.ceil(hMinutes / 1440)); (1404) — synchronous, prewarm only covers days=7.
```
> _Verifier note:_ Verified monkey-patch (1348-1349) and sync computeMatrix (1404). Corrected two original misreads: the matrix is plant-scoped (not all-system, app.js:4362/4375) and the guard at 1375 prevents re-runs when unchanged; confirmed the 7-day prewarm does NOT cover the 14-day Confidence call, so the main-thread cost is real. Downgraded high→medium given the scoping + guard.


### 113. [MED · Maintainability] CommandPalette._recent is persisted on every action but never read or rendered — write-only dead state

**Location:** `nimbus-intelligence.js` lines 732-740, 1045  |  **Confidence:** high

**Problem.** `CommandPalette._recent` is a localStorage-backed MRU list: `_activate()` pushes the label of every fired action (1045) and `push()` maintains a 5-deep dedup'd list (735-738). But `_recent.get()` is only ever called from inside `push()` itself (736) for its read-modify-write — it is never consulted by `_buildIndex`, `_search`, or `_render`. There is no 'Recent' section anywhere in the results. Confirmed by grep: the only references to `_recent`/`recentCmds` are the definition (732-740) and the single writer (1045).

**Why it matters (architect view).** A half-built feature masquerading as working code: it writes to localStorage on every action (a side effect with zero payoff) and a maintainer will reasonably assume recents surface somewhere. It also declares `_key: 'nimbus.recentCmds'` (733) but hardcodes the literal in both get (734) and push (738), so the constant is dead too.

**Recommendation.** Either wire a 'Recent' section into `_search('')` (read `_recent.get()` and prepend matching actions, presumably the intent), or delete `_recent` and the `_activate` push. If kept, use the declared `_key` constant instead of repeating the literal.

**Evidence.**

```
_recent: { _key: 'nimbus.recentCmds', get() {...localStorage.getItem('nimbus.recentCmds')...}, push(label) {...localStorage.setItem('nimbus.recentCmds', ...)} } (732-740). if (item.type === 'action') CommandPalette._recent.push(item.label); (1045) — the only writer; grep found no reader.
```
> _Verifier note:_ Grep confirms _recent.get() is called only inside push() (line 736) and the single external touch is the writer at 1045 — no reader exists anywhere. Dead-state and unused-constant claims both verified.


### 114. [MED · Scalability] Patterns learns color-sequence preferences in a single global localStorage map (no plant scope) and writes the whole map synchronously on every committed drag

**Location:** `nimbus-intelligence.js` lines 2065-2101 (module); key + sync write at 2087-2089  |  **Confidence:** high

**Problem.** _pairs is persisted under one global key `nimbus.patterns.v1` and keyed only by `COLOR→COLOR` (2087) with no plant scope. _observe (fired on each `task:update` with source `timeline`) JSON.stringify's the FULL _pairs object and writes it to localStorage on every observation (2089). When the count hits `_THRESHOLD` (a bare `4` at 2068), a global toast surfaces the cross-plant-learned pattern to the user (2090-2091).

**Why it matters (architect view).** Color sequencing/changeover preference is inherently per-plant (CLAUDE.md mandates color wheels / calendars / blackouts be keyed by plant ID; different plants run different color wheels). A single global map means a 50-plant deployment cross-contaminates learned patterns, and the threshold toast advertises advice that may be irrelevant to the current plant — a direct violation of the per-plant-state mandate. The synchronous full-map JSON.stringify + localStorage write on the drag-commit path is also avoidable I/O on a hot path.

**Recommendation.** Namespace the storage by plant (e.g. `nimbus.patterns.v2.<plant>` or fold plant into the pair key), and have getSuggestions/the toast read only the selected plant's bucket. Coalesce/debounce the localStorage write (or move it to IntelDB like TimeMachine) instead of writing the whole map on every commit. Promote `_THRESHOLD` alongside the other module constants.

**Evidence.**

```
2066 `_LS_KEY: 'nimbus.patterns.v1'`; 2068 `_THRESHOLD: 4`; 2087-2089 `const key = \`${Util.norm(prev.COLOR)}→${Util.norm(task.COLOR)}\`; Patterns._pairs[key] = (Patterns._pairs[key] || 0) + 1; localStorage.setItem(Patterns._LS_KEY, JSON.stringify(Patterns._pairs));`
```
> _Verifier note:_ Verified global key + COLOR→COLOR pairing + per-commit sync write. Note: _observe fires on drag-COMMIT (task:update src timeline), not per drag frame, so the original's 'competes with the 60fps drag pipeline' is slightly overstated — toned to per-committed-drag; the per-plant defect is the real architect-level issue.


### 115. [LOW · Abstraction] resolveIntent rebuilds a closure-bearing keyword bank literal on every keystroke and matches via linear substring scans

**Location:** `nimbus-intelligence.js` lines 631-715  |  **Confidence:** high

**Problem.** `resolveIntent(text)` reconstructs the entire `bank` array literal (objects + closures) on every call (633), then runs `bank.filter(i => i.keywords.some(kw => q.includes(kw)))` (705) plus a second word-level fallback pass (708-712). The bank is identical every time — it is rebuilt purely because it is declared as a local literal. Matching is stringly-typed (bare `String.includes`, no alias/normalization table). This runs inside the 60ms-debounced palette search.

**Why it matters (architect view).** Small at today's 7 intents, but it allocates a fresh array of objects and functions per keystroke, and it is the root of the duplicate-action problem (the same run bodies live here AND in _buildBank AND the palette index). Adding an intent means editing an inline literal parallel to two other action lists.

**Recommendation.** Hoist the intent bank to a module-level constant built once in `init()` (as `NeedsEngine._buildBank` already does for the needs bank at line 718), and build a keyword→intent lookup map so resolution is O(words) instead of O(intents × keywords). Share run bodies with the action registry recommended in the duplication finding.

**Evidence.**

```
resolveIntent(text) { const q = text.trim().toLowerCase(); const bank = [ {...}, ... ]; (633, rebuilt every call) const results = bank.filter(intent => intent.keywords.some(kw => q.includes(kw))); (705).
```
> _Verifier note:_ Verified the bank is a function-local literal rebuilt per call (633) while the parallel _buildBank is hoisted via init (718) — confirms the inconsistency. Real but minor; low severity is appropriate at 7 intents.


### 116. [LOW · Abstraction] TimeMachine.restore pushes a synthetic undo entry directly onto UndoStack._entries, bypassing the MAX:10 cap and the auto-snapshot patch that UndoStack.push runs

**Location:** `nimbus-intelligence.js` lines 1292-1310 (restore); offending push at 1296  |  **Confidence:** high

**Problem.** restore() does `UndoStack._entries.push({ label, undoFn, at })` directly instead of calling the public `UndoStack.push`. Verified in app.js:9178-9181, push enforces the 10-level cap (`if (this._entries.length > this.MAX) this._entries.shift()`), and TimeMachine.init (1193-1197) monkey-patches push to also fire `_snapshotAuto`. Reaching past push into _entries skips both: the cap is not enforced and the pre-restore checkpoint never triggers an auto-snapshot the way every other undoable action does.

**Why it matters (architect view).** Leaky abstraction reaching past the public API into private state. The undo stack can exceed its documented 10-level cap (CLAUDE.md: 'UndoStack (10 levels)') and the Time-Machine auto-snapshot hook is silently skipped for restores, while a future change to the _entries shape would break restore. Low severity because the consequence is bounded (one extra unbounded entry path, no data loss).

**Recommendation.** Call `UndoStack.push('Before Time Machine restore', () => UndoStack.restoreTasks(beforeSnap))` — the same public API the rest of the module uses — and let push own entry shape, the MAX:10 cap, and the auto-snapshot hook.

**Evidence.**

```
nimbus-intelligence.js:1295-1296 `const beforeSnap = UndoStack.snapshotTasks(Store.tasksArr.map(t => t.id)); UndoStack._entries.push({ label: 'Before Time Machine restore', undoFn: () => UndoStack.restoreTasks(beforeSnap), at: Date.now() });`. app.js:9178-9181 push() does `this._entries.push(...); if (this._entries.length > this.MAX) this._entries.shift();`. app.js patch at nimbus-intelligence.js:1193-1197 wraps push to call `_snapshotAuto`.
```
> _Verifier note:_ Cross-checked app.js:9174-9200: UndoStack.MAX=10 and push() shifts on overflow; init's push monkey-patch confirmed at 1193-1197. The direct _entries.push genuinely bypasses both.


### 117. [LOW · Correctness] Confidence._drawChart divides draw-space font sizes by devicePixelRatio while never scaling the backing store — inverted DPR handling shrinks labels on HiDPI

**Location:** `nimbus-intelligence.js` lines 1586 (canvas decl), 1603-1641 (_drawChart), 1624 + 1638 (font sizing)  |  **Confidence:** high

**Problem.** The canvas is `width="760" height="240"` with CSS `width:100%; height:120px` (1545). _drawChart reads `W=canvas.width` / `H=canvas.height` and never scales the backing store by dpr (no `canvas.width = cssW*dpr` / `ctx.scale(dpr,dpr)`), yet computes font sizes as `Math.round(14/dpr)` (1624) and `Math.round(18/dpr)` (1638). On a 2x display this renders axis/zone labels at 7px and 9px while everything else is drawn in unscaled coordinates — the opposite of what DPR correction should do.

**Why it matters (architect view).** Dividing draw-coordinate font sizes by dpr shrinks text on exactly the displays where you'd want a sharper backing store. Cosmetic only, so low severity, but it inverts the standard canvas-DPR pattern and yields inconsistent label sizes across monitors.

**Recommendation.** Either scale the backing store once (`canvas.width = cssW*dpr; canvas.height = cssH*dpr; ctx.scale(dpr,dpr)`) and use plain px fonts, or drop the `/dpr` entirely and use fixed px sizes. Do not divide draw-space font sizes by dpr.

**Evidence.**

```
1607 `const dpr = window.devicePixelRatio || 1;` (no ctx.scale anywhere in 1603-1718). 1624 `ctx.font = \`bold ${Math.round(14/dpr)}px system-ui\`;` 1638 `ctx.font = \`${Math.round(18/dpr)}px system-ui\`;`
```
> _Verifier note:_ Verified canvas declared 760x240, CSS height 120px, no ctx.scale(dpr) anywhere in _drawChart; the only dpr use is the two font divisions. Correctly low/cosmetic.


### 118. [LOW · Maintainability] Intelligence-layer modules register multiple un-torn-down Store/Selection subscribers and monkey-patches with no re-wrap guard

**Location:** `nimbus-intelligence.js` lines 719, 751, 766, 1193-1197, 1198, 1330, 1348-1349  |  **Confidence:** medium

**Problem.** The module attaches four separate `Store.subscribe(...)` callbacks (NeedsEngine 719, CommandPalette 751, TimeMachine 1198, Confidence 1330), a `Selection.on` (766), and two monkey-patches (`UndoStack.push` 1193-1197, `Alerts.recompute` 1348-1349). `Store.subscribe(fn, label)` (app.js:626) returns no unsubscribe handle, none is captured, and none of the patches guard against re-wrapping. Several do overlapping cache-invalidation work on the same events (CommandPalette 751-753, NeedsEngine 719, Selection hook 766-768 all null caches).

**Why it matters (architect view).** If any `init()` were called twice (hot-reload, future plant re-init), the monkey-patches would stack (a wrapper wrapping a wrapper) and subscribers would fire N×, multiplying the expensive Confidence/needs recompute. Note: today `_boot` is guarded by the `document.readyState` check and its `.then`/`.catch` branches are mutually exclusive (lines 2174-2200), so each init runs exactly once — the double-init failure is currently hypothetical, not a live bug. The redundant fan-out (four intelligence callbacks per Store publish) is real avoidable work, though minor.

**Recommendation.** Add an idempotency guard to each init (`if (Module._inited) return; Module._inited = true;`) and capture the monkey-patch originals once, guarding against re-wrapping — cheap insurance before any future re-init path is added. Optionally consolidate the cache-invalidation subscriptions into a single intelligence-layer Store subscriber.

**Evidence.**

```
Store.subscribe(() => { NeedsEngine._cachedState = null; }); (719); Store.subscribe(evt => { ...CommandPalette._index = null; ... }); (751); NIMBUS.Selection?.on?.(() => {...}); (766); UndoStack.push = (label, undoFn) => {...}; (1194); Alerts.recompute = (...args) => {...}; (1349). app.js subscribe(fn, label) returns nothing (626).
```
> _Verifier note:_ Verified all subscribers/patches and that Store.subscribe returns no handle (app.js:626). Tempered the original: the double-init scenario is not reachable today (mutually-exclusive _boot then/catch, readyState-guarded), so this is defensive hardening, not a live defect — kept at low severity.


### 119. [LOW · Maintainability] Confidence.showBreakdown re-injects a ~30-rule <style> block on every open and hand-rolls modal scaffolding instead of using the shared Modal module (same for Diff.showUI)

**Location:** `nimbus-intelligence.js` lines 1534-1601 (showBreakdown style + dialog); 2006-2027 (Diff.showUI dialog)  |  **Confidence:** high

**Problem.** Each showBreakdown() call concatenates a ~30-selector styleBlock string into `dlg.innerHTML`, appends the dialog, and removes it on close — re-parsing and re-inserting the same CSS every open. The breakdown also hardcodes hex tokens (#22c55e / #f59e0b / #ef4444 at 1447, 1529-1532) that duplicate the --ok/--warn/--err design tokens used elsewhere in the same function. Both showBreakdown and Diff.showUI independently hand-roll `document.createElement('dialog')` + showModal try/catch + close-on-backdrop + close→remove rather than routing through the NIMBUS.Modal infrastructure module that CLAUDE.md lists.

**Why it matters (architect view).** Re-injecting a stylesheet per open is wasted parse work and means the breakdown's visual tokens cannot be themed centrally — relevant given CLAUDE.md already flags incomplete dark-mode token coverage and ~850 lines of un-migrated inline style. The duplicated dialog boilerplate across Confidence/Diff is exactly the parallel scaffolding a shared Modal helper exists to eliminate. Low severity because it is correctness-neutral and per-open cost is small.

**Recommendation.** Move `.ni-breakdown-dlg` CSS into styles.css once, using the existing --ok/--warn/--err tokens instead of literal hex. Route the Confidence breakdown and Diff dialog through NIMBUS.Modal so showModal/close/remove/backdrop wiring lives in one place.

**Evidence.**

```
1534 `const styleBlock = \`<style> .ni-breakdown-dlg .ni-conf-body { ... } ... </style>\`;` injected at 1572; 1592-1595 `document.body.appendChild(dlg); try { dlg.showModal(); } catch { dlg.open = true; } ... dlg.addEventListener('close', () => dlg.remove());`. Diff.showUI mirrors this at 2022-2027.
```
> _Verifier note:_ Verified the inline <style> is rebuilt per open and that Diff.showUI duplicates the dialog/showModal/close-remove pattern; hardcoded hex confirmed at 1447 and 1529-1532. Severity correctly low (maintainability, not behavior).



## `schema.sql` — 9 findings (2 high · 6 medium · 1 low)

### 120. [HIGH · Correctness] Non-idempotent ×1440 horizon migration re-multiplies on every re-run (data-corruption landmine)

**Location:** `schema.sql` lines 109-111  |  **Confidence:** high

**Problem.** Two unconditional UPDATEs at lines 110-111 convert plants.alt_flag_horizon/conf_score_horizon from 'days' to 'minutes' by multiplying ×1440 for any row whose current value is <= 365. There is no run-once guard, and CLAUDE.md declares schema.sql is re-run on every pull, so this fires routinely. The <=365 sentinel is not a reliable days-vs-minutes discriminator: a plant legitimately set to a sub-365-minute horizon (e.g. a 360-minute / 6-hour alert window) is silently ×1440'd to 518400 on the next bootstrap.

**Why it matters (architect view).** schema.sql is the declared per-pull bootstrap, so a data-mutating UPDATE with no idempotency guard is structurally guaranteed to re-fire. Corruption is silent (no error, plausible-looking number) and per-plant — undetectable by eye at 50+ plants. This is the exact landmine CLAUDE.md and the user's MEMORY both flag as the gating fix for prod promotion.

**Recommendation.** Make the conversion run-once and self-disabling: add a schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMP) table and wrap each data migration in an IF NOT EXISTS guard that INSERTs its version on success. Alternatively gate on column provenance (a one-shot plants.horizon_unit flag) rather than the value-magnitude heuristic. Stop using value <= 365 as a unit test.

**Evidence.**

```
schema.sql:110-111 — UPDATE plants SET alt_flag_horizon = alt_flag_horizon * 1440 WHERE alt_flag_horizon <= 365; (same for conf_score_horizon). No schema_migrations / run-once guard anywhere in the file.
```
> _Verifier note:_ Verified verbatim at lines 110-111; confirmed no run-once guard exists in the file; matches the documented CLAUDE.md landmine and the sub-365-minute corruption path is real.


### 121. [HIGH · Scalability] production_lines.production_line has no global line identity — orders soft-reference it with no FK, so reused line codes leave orders un-attributed

**Location:** `schema.sql` lines 113-130, 143-161  |  **Confidence:** high

**Problem.** orders.plant and its backfill exist precisely because a line code is reused across plants (file comment, lines 135-136/149-151). But production_lines is keyed by (subnetwork, plant, production_line) with no surrogate identity and nothing preventing the same production_line under multiple plants, and orders stores only production_line + a derived plant with NO FK to production_lines. The backfill (152-161) intentionally leaves orders.plant NULL whenever a code maps to >1 plant. At the roadmap target (3,500+ lines across 50+ plants), code collisions are near-certain, so a growing fraction of orders stay permanently plant-NULL and invisible to plant-scoped /tasks queries.

**Why it matters (architect view).** orders.production_line is a stringly-typed reference with no referential integrity, and plant must be guessed by aggregation on every ingest/backfill. This is the root scalability defect the roadmap and MIGRATION.md call out (line-code reuse, plant-aware make_id). The schema acknowledges the problem in comments but ships the derive-or-NULL workaround rather than a real identity model.

**Recommendation.** Introduce a surrogate production_lines.line_id (BIGSERIAL/UUID) as the real identity, make (plant, production_line) unique, and have orders carry line_id as a FK resolved at ingest from the authoritative WERKS/PLANT column. orders.plant then becomes derivable from the FK join rather than a value heuristic, and un-attributable rows become an ingest-time validation error instead of silent NULLs. This is the make_id/plant-aware identity work MIGRATION.md flags as a prerequisite.

**Evidence.**

```
schema.sql:119 PRIMARY KEY (subnetwork, plant, production_line); schema.sql:143 ALTER TABLE orders ADD COLUMN IF NOT EXISTS plant TEXT (no FK); schema.sql:152-161 backfill only when COUNT(DISTINCT pl.plant)=1, else NULL.
```
> _Verifier note:_ Verified PK at 119, no FK from orders to production_lines, and the COUNT(DISTINCT)=1 NULL-leaving backfill at 152-161. Aligns with the documented roadmap/MIGRATION.md constraint — genuinely architect-level.


### 122. [MED · Correctness] Horizon columns labeled '(days)' in metadata but stored/read as minutes — schema labels contradict the sole consumer

**Location:** `schema.sql` lines 99-100, 298-299  |  **Confidence:** high

**Problem.** plants.alt_flag_horizon defaults to 43200 and conf_score_horizon to 20160 (lines 99-100), and column_metadata labels them 'Alert Flag Horizon (days)' and 'Conf Score Horizon (days)' (lines 298-299). The sole consumer (app.js) treats the values as total MINUTES everywhere: the comment 'Values stored as total minutes in DB' (app.js:14583), new Date(Date.now()+hz*Config.MS_MIN) (e.g. 4209, 5885, 6156, 7734, 8084), Math.ceil(horizonMinutes/1440) (5114), and the save path _savePlantHorizon({alt_flag_horizon: totalMin}) (14667). So 43200 = 30 days and 20160 = 14 days — the '(days)' label is wrong. A bare INTEGER carries an undocumented unit, and the ×1440 migration exists precisely to reconcile this ambiguity.

**Why it matters (architect view).** An admin reading 'Conf Score Horizon (days) = 20160' in the Manage Data grid is badly misled (it is 14 days, not 20160). The unit is encoded nowhere in the column name or a CHECK, and the metadata label disagrees with the only code that reads it. Functionally the consumer is internally consistent (all minutes), which caps this below the corruption finding — hence medium, not high.

**Recommendation.** Rename to encode the unit (alt_flag_horizon_minutes / conf_score_horizon_minutes) and fix the column_metadata labels to '(minutes)' (or have the UI render minutes→days). Add CHECK (alt_flag_horizon > 0). Once the unit is unambiguous, the ×1440 reconciliation migration becomes unnecessary.

**Evidence.**

```
schema.sql:99-100 defaults 43200/20160; schema.sql:298-299 labels '(days)'. app.js:14583 comment 'Values stored as total minutes in DB'; app.js:14584-14585 read alt_flag_horizon/conf_score_horizon as minutes; app.js:5114 Math.ceil(horizonMinutes/1440); app.js:14667 _savePlantHorizon({alt_flag_horizon: totalMin}).
```
> _Verifier note:_ All cited app.js lines verified; the 'minutes' comment and ×MS_MIN math are real. Downgraded severity high→medium: it is a metadata/label correctness defect, not a runtime miscompute (the consumer is consistent).


### 123. [MED · Correctness] labor_plan_line has no FK to plants/production_lines — orphan rows survive plant/line deletes (asymmetric with labor_plan)

**Location:** `schema.sql` lines 261-271  |  **Confidence:** high

**Problem.** labor_plan_line (261-271) is keyed by (subnetwork, plant, production_line, day) but declares NO foreign key, whereas its sibling labor_plan (229-240) FKs to plants ON DELETE CASCADE and production_lines (113-122) FKs to plants the same way. Deleting a plant or line cascades through labor_plan but leaves labor_plan_line rows orphaned, pointing at a tuple that no longer exists.

**Why it matters (architect view).** Two tables representing the same domain concept (labor availability) have inconsistent integrity models — the classic asymmetry that produces silent data drift. Orphaned per-day labor rows accumulate and can be summed into utilization/labor KPIs for deleted plants/lines, with no DB-level cleanup guarantee. At 50+ plants with line churn this leaks.

**Recommendation.** Add FOREIGN KEY (subnetwork, plant, production_line) REFERENCES production_lines(subnetwork, plant, production_line) ON DELETE CASCADE ON UPDATE CASCADE to match labor_plan. For existing DBs, add NOT VALID first (like chk_orders_sched_range), clean orphans, then VALIDATE.

**Evidence.**

```
schema.sql:261-271 labor_plan_line has no FOREIGN KEY clause; contrast schema.sql:238-239 (labor_plan FK to plants) and schema.sql:120-121 (production_lines FK to plants), both ON DELETE CASCADE.
```
> _Verifier note:_ Verified labor_plan_line has no FK while labor_plan and production_lines do — the asymmetry and orphan-on-delete behavior are correct.


### 124. [MED · Correctness] All timestamp columns are TIMESTAMP (no timezone) in a schema headed for 50+ multi-region plants

**Location:** `schema.sql` lines 27-31, 39-40, 78, 91-92, 213  |  **Confidence:** medium

**Problem.** Every datetime column is TIMESTAMP (without time zone): orders.basic_start_date / basic_finish_date / scheduled_start / scheduled_end (27-31), orders.uploaded_at / updated_at (39-40), upload_audit.uploaded_at (78), subnetworks/plants/production_lines created_at/updated_at (e.g. 91-92, 101-102, 117-118), admin_audit.occurred_at (213). The roadmap targets 50+ plants likely spanning time zones, and the frontend does new Date(...)/Date.now() math against these values, so a wall-clock timestamp written in one region is reinterpreted in the server/session zone on read, and DST transitions shift apparent run windows.

**Why it matters (architect view).** For a scheduling product distributed across 50+ plants, naive TIMESTAMP is a latent correctness hazard: the same instant stores/displays differently depending on the session TimeZone, and DST 'spring forward' creates non-existent local times that capacity math (workWindow/dailyCapacityHours) mishandles. It only surfaces at boundaries/across regions, making it hard to detect.

**Recommendation.** Migrate instant-in-time columns to TIMESTAMPTZ and standardize on UTC storage; do per-plant local conversion explicitly in the app via a new per-plant timezone TEXT column to anchor working-hours math. Audit columns (uploaded_at, occurred_at) especially should be TIMESTAMPTZ.

**Evidence.**

```
schema.sql:27-31 basic_/scheduled_ TIMESTAMP; :39-40 uploaded_at/updated_at TIMESTAMP; :78 upload_audit.uploaded_at; :213 admin_audit.occurred_at TIMESTAMP NOT NULL DEFAULT NOW().
```
> _Verifier note:_ Verified all cited columns are bare TIMESTAMP. Kept at medium: the multi-region roadmap gives it real teeth, though it is a forward-looking latent risk rather than a current observed bug at the single-pilot scale.


### 125. [MED · Inefficiency] Line→plant backfill uses two correlated subqueries per row (O(N×M)); the same shape is duplicated in three places

**Location:** `schema.sql` lines 152-161  |  **Confidence:** high

**Problem.** The orders.plant backfill runs TWO correlated subqueries per NULL-plant row — MIN(plant) and COUNT(DISTINCT plant) over production_lines, both filtering pl.production_line = o.production_line — re-computing the same per-line aggregation twice per row. The identical shape recurs in db.py at lines 297-308 (runtime re-attribution), 314-322 (reporting), and 1192-1217 (post-upload attribution + reporting), so the expensive pattern lives in four spots that can drift.

**Why it matters (architect view).** At 3,500+ lines and a large orders table this is a repeated correlated double aggregation. The schema instance runs only at bootstrap, but db.py's post-line-change/post-upload re-attribution runs at runtime on high order volume — and the two-subquery form computes the line→plant mapping redundantly instead of once.

**Recommendation.** Precompute the mapping once with an aggregate CTE and join: WITH line_map AS (SELECT production_line, MIN(plant) AS plant, COUNT(DISTINCT plant) AS np FROM production_lines GROUP BY production_line) UPDATE orders o SET plant = lm.plant FROM line_map lm WHERE o.production_line = lm.production_line AND o.plant IS NULL AND lm.np = 1. Extract into one db.py helper shared by the schema migration, runtime re-attribution, and reporting to kill the multi-way drift.

**Evidence.**

```
schema.sql:152-161 MIN(pl.plant) + COUNT(DISTINCT pl.plant) correlated subqueries; mirrored in db.py:297-308, db.py:314-322, db.py:1192-1217.
```
> _Verifier note:_ Verified the double-subquery shape at schema 152-161 and confirmed three matching db.py copies (297-322, 1192-1217) — the duplication/drift claim is accurate; raised the count from three to four sites.


### 126. [MED · Maintainability] Date/week values stored as TEXT instead of native DATE — no DB validation, no range scans for the horizon window

**Location:** `schema.sql` lines 233, 265  |  **Confidence:** high

**Problem.** labor_plan.period is TEXT 'YYYY-Www' ISO week (line 233) and labor_plan_line.day is TEXT 'YYYY-MM-DD' (line 265). These temporal keys drive horizon windowing and aggregation but are stored as strings with no DB-level validity check (malformed values like '2026-13-99' are accepted), and date arithmetic / range windowing must be done in app code. (Note: lexical ordering of these particular formats actually sorts correctly — the real cost is loss of native range/arithmetic and validation, as the finding itself concedes.)

**Why it matters (architect view).** TEXT temporal columns can't use native range operators, date arithmetic, or efficient btree range scans; every horizon query round-trips strings to the app for date math (LaborPlanning computes Mondays/ISO weeks in JS). Over a 90-day horizon × thousands of lines this forces string scans where a DATE btree would range-scan, and admits malformed values.

**Recommendation.** Store labor_plan_line.day as DATE and labor_plan.period as a DATE (the ISO week's Monday) or an explicit (iso_year SMALLINT, iso_week SMALLINT) pair; keep 'YYYY-Www' only as a derived display string. Enables WHERE day BETWEEN %s AND %s index range scans and lets Postgres validate values.

**Evidence.**

```
schema.sql:233 period TEXT NOT NULL -- ISO week key 'YYYY-Www'; schema.sql:265 day TEXT NOT NULL -- ISO date 'YYYY-MM-DD'.
```
> _Verifier note:_ Verified both TEXT temporal columns at 233/265. The ISO-week lexical-sort concern is overstated (these formats sort fine) but the finding flags that itself; the validation/range-scan argument stands — kept at medium maintainability.


### 127. [MED · Scalability] orders has no composite (plant, …) index matching the /tasks filter+order — plant-scoped reads sort every time

**Location:** `schema.sql` lines 143-149, 49-53  |  **Confidence:** medium

**Problem.** db.query_orders() filters WHERE o.plant = %s (db.py:231) and ORDER BY o.production_line, COALESCE(scheduled_start, basic_start_date) (db.py:238) — the documented hot path for /tasks. The only plant index is single-column idx_orders_plant (schema.sql:144); it can satisfy the equality but the result must still be sorted on (production_line, effective start) for every paged request. The two line-leading indexes (idx_orders_line_start, idx_orders_line_eff_start, lines 49-53) cannot serve a plant-equality lead. No composite (plant, production_line, COALESCE(scheduled_start, basic_start_date)) exists to serve filter+order together.

**Why it matters (architect view).** At ~15 lines the sort is free; at 3,500+ lines across 50+ plants a per-plant /tasks page index-scans the plant then sorts the whole plant's order set, undercutting the LIMIT/OFFSET pagination the schema added for scale. Severity tempered to medium because the docstring frames LIMIT/OFFSET as a 'coarse guard rail for unscoped tooling', not the primary scaled access pattern, and real impact depends on per-plant cardinality.

**Recommendation.** Add CREATE INDEX idx_orders_plant_line_eff_start ON orders(plant, production_line, COALESCE(scheduled_start, basic_start_date)). This serves the o.plant=%s equality then provides the exact ORDER BY, removing the sort and enabling index-range pagination. Re-evaluate dropping idx_orders_line_start if confirmed redundant with idx_orders_line_eff_start.

**Evidence.**

```
db.py:231 where.append('o.plant = %s'); db.py:238 ORDER BY o.production_line, COALESCE(scheduled_start, basic_start_date); schema.sql:144 only idx_orders_plant ON orders(plant); schema.sql:49-53 line-leading composites.
```
> _Verifier note:_ Verified the WHERE/ORDER BY in db.py and that the only plant index is single-column. Downgraded high→medium: the sort-elimination win is real but pagination is documented as a coarse guardrail, so the at-scale impact is plausible rather than certain.


### 128. [LOW · Correctness] chk_orders_sched_range added NOT VALID and never VALIDATEd, and dropped+recreated on every bootstrap

**Location:** `schema.sql` lines 58-61  |  **Confidence:** high

**Problem.** chk_orders_sched_range is added NOT VALID (lines 59-61) so it won't fail on legacy rows, but the file never runs ALTER TABLE orders VALIDATE CONSTRAINT chk_orders_sched_range (none exists anywhere in schema.sql). So pre-existing inverted ranges are never surfaced. Worse, the constraint is unconditionally DROP IF EXISTS + re-ADDed on every run (line 58), so even a manual one-off VALIDATE would be reset to NOT VALID on the next per-pull bootstrap.

**Why it matters (architect view).** The defense-in-depth intent is partially undermined: legacy inverted rows are never checked, and the drop/recreate-every-run pattern guarantees VALIDATE state can never persist across the documented re-runs. Low severity because update_task_dates_bulk validates inverted ranges before write, but the DB guarantee is weaker than the comment implies.

**Recommendation.** Guard the DROP/ADD so it only fires when the constraint is absent (query pg_constraint), then run VALIDATE CONSTRAINT once after a cleanup pass. Don't unconditionally drop+recreate a NOT VALID constraint on every bootstrap.

**Evidence.**

```
schema.sql:58 ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_sched_range; :59-61 ADD ... NOT VALID; no VALIDATE CONSTRAINT statement anywhere in the file.
```
> _Verifier note:_ Verified the DROP/ADD-NOT-VALID at 58-61 and confirmed no VALIDATE CONSTRAINT exists in schema.sql; the drop+recreate-resets-validation reasoning is correct. Correctly self-rated low.



## `brain.py` — 8 findings (1 high · 6 medium · 1 low)

### 129. [HIGH · Scalability] Color-wheel metadata + audit JSON files use unguarded read-modify-write (lost-update race) and an all-plants os.listdir scan — not replica-safe

**Location:** `brain.py` lines 400-409, 426-428, 1128-1146, 1185-1194, 1208-1216  |  **Confidence:** high

**Problem.** GLOBAL_CW / PLANT_CWS are process-global dicts and the metadata/audit files (`_meta.json`, `_audit_log.json`) are read-modify-write with no locking. _cw_write_meta (407-409) does a full overwrite of one JSON file; upload (1131-1136) and delete (1185-1187) both do `_cw_read_meta()` -> mutate -> `_cw_write_meta()`. Two concurrent color-wheel operations on different plants race the same `_meta.json` and one plant's entry can be lost. list_color_wheels also does an all-plants `os.listdir(COLOR_WHEEL_DIR)` + filename match per call (1210-1216). Sync handlers run in Starlette's threadpool, so concurrent threads make the race more likely, not less.

**Why it matters (architect view).** The roadmap targets 50+ plants with per-plant keyed color-wheel storage. A single shared JSON file with non-atomic read-modify-write is a lost-update bug the moment two admins manage wheels concurrently, and it does not survive the planned move off single-replica (MIGRATION.md Azure Files durability fix puts N replicas on the same shared file).

**Recommendation.** Move color-wheel metadata and audit records into Postgres (a color_wheels table keyed by plant with row_count/uploaded_at/uploaded_by, and an audit_log table), so writes are transactional and replica-safe; keep only the parsed {COLOR:ORDER_Y} map cached per-process, invalidated via the existing /reload hook. If files must stay short-term, guard read-modify-write with a per-file lock and write atomically (temp file + os.replace).

**Evidence.**

```
def _cw_write_meta(meta: dict) -> None:
    with open(_cw_meta_path(), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)   (407-409)
upload: meta = _cw_read_meta(); meta[plant] = {...}; _cw_write_meta(meta)  (1131-1136)
```
> _Verifier note:_ Verified non-atomic read-modify-write in _cw_write_meta and both upload/delete handlers, and the os.listdir scan in list_color_wheels. Corrected the original's threadpool sub-claim: these are sync `def` handlers (1151/1177) so Starlette DOES threadpool them — which makes the concurrency race real rather than precluding it.


### 130. [MED · Abstraction] Highest-risk write endpoints (master-data DDL/bulk, purge, note, labor-plan, constraints) take raw dict bodies and hand-pull fields, forfeiting Pydantic validation and 422/OpenAPI

**Location:** `brain.py` lines 931-942, 1061-1074, 1292-1393, 1409-1442  |  **Confidence:** high

**Problem.** While TaskDateUpdate/TasksUpdatePayload are proper Pydantic models, the bulk of the write surface — /task/note (payload: dict, 932), /purge (payload: dict, 1062), all /master-data/{table}/* cascade-preview/bulk/columns add/drop/rename/constraints (Body(default={}), 1293-1393), and both /labor-plan* (Body(default={}), 1410/1432) — take raw dict and hand-pull with body.get("column_name", "") / payload["start_date"]. There is no request schema, no type coercion, and no required-field enforcement beyond scattered manual `if not x: raise 400`; OpenAPI docs for these routes are uninformative.

**Why it matters (architect view).** Primitive-obsession on the riskiest endpoints (runtime DDL, bulk upsert, purge). Validation is inconsistent (purge validates dates; set_plant_constraints does not validate shape until deep in md.*), error messages vary, and FastAPI's automatic 422 + schema docs are forfeited. At scale, malformed admin payloads surface as confusing 500s instead of clean 400s.

**Recommendation.** Define Pydantic request models (NotePayload, PurgePayload, ColumnAddPayload, BulkOpsPayload, ConstraintsPayload, LaborCellsPayload, ...) and type the handler params with them. FastAPI then enforces required fields/types, auto-documents the contract, and handlers shrink to passing typed fields through to db/md.

**Evidence.**

```
@api.post("/master-data/{table}/columns", ...)
def md_add_column(table: str, request: Request, body: dict = Body(default={})):
    ... column_name=body.get("column_name", ""), sql_type=body.get("sql_type", ""),  (1327-1335)
```
> _Verifier note:_ Verified raw-dict bodies at /task/note (932), /purge (1062), all /master-data/{table}/* (1293,1301,1327,1358,1379) and /labor-plan + /labor-plan/line (1410,1432). Inconsistent validation vs the typed task-update path confirmed.


### 131. [MED · Correctness] Read path /tasks mutates the shared, unbounded process-global DIAGNOSTICS['warnings'] on color-merge failure, leaking one request's warning into all others' diagnostics

**Location:** `brain.py` lines 320, 376-381, 566-569 (consumed at 708, 828)  |  **Confidence:** high

**Problem.** apply_color_merge runs on every /tasks request; its except path calls `_warn(...)` (line 567), which appends to the process-global `DIAGNOSTICS["warnings"]` list (376-380). That list is declared once (line 320), never bounded and never cleared, and is shallow-copied into every /tasks meta (`dict(DIAGNOSTICS, ...)`, line 828) and into _diag_snapshot (line 708). So plant A's malformed color wheel produces a warning that plant B's /tasks and the /diagnostics pull will then display, and the list grows without bound.

**Why it matters (architect view).** A read endpoint silently mutating an unbounded shared list is both a slow memory leak and a cross-request information bleed; under multiple workers the warnings are also per-worker-inconsistent, making them misleading for support.

**Recommendation.** Keep request-scoped color-merge problems in the returned stats/cm_stats dict (already returned to the caller) and out of global DIAGNOSTICS. If a global warning ring is genuinely wanted, make it a bounded deque like _BACKEND_LOG and stop copying it into every /tasks response.

**Evidence.**

```
"warnings": []  (line 320)
def _warn(level, msg, **ctx): DIAGNOSTICS["warnings"].append({...})  (376-380)
except Exception as e: _warn("error", f"Color-wheel merge failed: {e}; ...")  (566-567)
```
> _Verifier note:_ Verified DIAGNOSTICS['warnings'] is an unbounded list (320), _warn appends to it (377), apply_color_merge's except calls _warn (567), and it is copied into both /tasks meta (828) and _diag_snapshot (708). All sub-claims hold.


### 132. [MED · Duplication] Color-wheel xlsx is parsed twice on every upload (validation parse, then disk re-read in cache refresh); COLOR->ORDER_Y normalization is duplicated across four sites

**Location:** `brain.py` lines 1103, 1146, 431-441, 453-457, 1157-1161  |  **Confidence:** high

**Problem.** On upload, the file is parsed once for validation (`pd.read_excel(io.BytesIO(raw))`, line 1103) and then _reload_one_plant_wheel re-reads the same file from disk via _parse_color_wheel (line 1146/497) — two full Excel reads of one upload on a blocking path. The COLOR->ORDER_Y normalization (`rename ORDER->ORDER_Y`, `astype(str).str.upper().str.strip()`, `pd.to_numeric(errors='coerce')`) is written four times: _parse_color_wheel (431-441), inline in load_color_wheels (453-457), inline in upload validation (1104-1106), and inline in get_color_wheel (1157-1161).

**Why it matters (architect view).** Four copies of the same normalization is the drift hazard the codebase elsewhere works to avoid: a future change to color-key normalization (e.g. a new whitespace variant) must be made in all four or the validation path, the cache, and the viewer silently disagree. The double-parse is wasted CPU on a synchronous request.

**Recommendation.** Make _parse_color_wheel the single parser (accept a DataFrame OR a path/bytes) and route load_color_wheels, the global wheel, upload validation, and get_color_wheel through it. On upload, parse once into a DataFrame and feed that frame to both validation and the cache update (e.g. set PLANT_CWS[key] directly from the parsed map) instead of writing the file then re-reading it.

**Evidence.**

```
cw_df = await run_in_threadpool(lambda: db.clean(pd.read_excel(io.BytesIO(raw))))   # parse #1 (1103)
await run_in_threadpool(_reload_one_plant_wheel, plant)   # parse #2 re-reads file (1146 -> _parse_color_wheel @497)
```
> _Verifier note:_ Confirmed double-parse (1103 then 1146->497) and four normalization copies. Note: _parse_color_wheel ALREADY exists and dedups load_color_wheels<->refresh, so the recommendation is to extend it to the remaining two sites and pass a frame on upload — not to create it from scratch.


### 133. [MED · Inefficiency] GET /tasks fires a second full COUNT(*) query when paging, and copies the process-global DIAGNOSTICS bucket (incl. unbounded warnings) into every response meta

**Location:** `brain.py` lines 828, 836 (brain.py); db.count_orders db.py:252-267  |  **Confidence:** high

**Problem.** When ?limit/?offset is supplied, get_tasks runs db.query_orders() AND a separate db.count_orders() over the same scope: `meta["total"] = db.count_orders(plant=plant, line=line) if paging else len(data)` (line 836). count_orders (db.py:254) is `SELECT COUNT(*) FROM orders o` with the same WHERE — a second round-trip and second scan per paged request. Separately, `meta = dict(DIAGNOSTICS, **cm_stats)` (line 828) shallow-copies the process-global DIAGNOSTICS dict (including load-time counters and the shared, never-cleared `warnings` list) into every per-request response.

**Why it matters (architect view).** At target scale (50+ plants, large orders table) every paged read costs two scans instead of one — pagination's whole point was to reduce DB load. The COUNT can be folded into the data query with `COUNT(*) OVER()`. The DIAGNOSTICS copy means load-time/global fields and another request's color-merge warnings bleed into an unrelated plant-scoped response.

**Recommendation.** Return the scoped total from the same SELECT via `COUNT(*) OVER() AS _total` (read off the first row) so paging is one round-trip. Build meta from an explicit literal dict of the fields /tasks owns rather than `dict(DIAGNOSTICS, ...)`, so process-global state never bleeds into a request.

**Evidence.**

```
meta = dict(DIAGNOSTICS, **cm_stats)  (line 828)
meta["total"] = db.count_orders(plant=plant, line=line) if paging else len(data)  (line 836)
db.py:254  sql = "SELECT COUNT(*) FROM orders o"
```
> _Verifier note:_ Verified line 836 second-query and line 828 dict(DIAGNOSTICS,...) in brain.py; confirmed count_orders is a separate full COUNT(*) at db.py:252-267 with the same WHERE as query_orders (db.py:213-249).


### 134. [MED · Inefficiency] Order set is sorted three times per /tasks request (SQL ORDER BY, then a full pandas sort, then a per-line sort) with mismatched keys

**Location:** `brain.py` lines 571-573, 779-780 (brain.py); db.py:238  |  **Confidence:** high

**Problem.** db.query_orders issues `ORDER BY o.production_line, COALESCE(scheduled_start, basic_start_date)` (db.py:238). apply_color_merge then does a full `df.sort_values(by=["BASIC_START_DATE", "PRODUCTION_LINE", "ORDER_Y"]).reset_index(drop=True)` (brain.py:571-573), and get_tasks then iterates `df.groupby("PRODUCTION_LINE")` and inside each group calls `group_raw.sort_values("BASIC_START_DATE")` again (brain.py:780). That is three orderings of the same rows per request; the pandas key order ([start, line, order_y]) does not match the SQL key order ([line, start]), so the SQL sort is effectively discarded.

**Why it matters (architect view).** Sorting is O(n log n) and groupby builds intermediate frames; doing it 2-3x per /tasks call on a full plant order set (thousands of rows at target scale) is wasted CPU on the request hot path. The link-builder only needs rows grouped by line and start-ascending — exactly one ordering's worth of work.

**Recommendation.** Pick one source of truth for ordering. Simplest: drop the redundant per-group `sort_values` at line 780 (the SQL already orders by line, start) and keep apply_color_merge's sort only if intra-line color priority must influence order — in which case push ORDER_Y into the SQL ORDER BY and let apply_color_merge merely add the ORDER_Y column without re-sorting.

**Evidence.**

```
df = df.sort_values(by=["BASIC_START_DATE", "PRODUCTION_LINE", "ORDER_Y"]).reset_index(drop=True)  (571-573)
for prod_line, group_raw in df.groupby("PRODUCTION_LINE"):
    group = group_raw.sort_values("BASIC_START_DATE")  (779-780)
db.py:238  sql += '\n    ORDER BY o.production_line, COALESCE(scheduled_start, basic_start_date)'
```
> _Verifier note:_ Confirmed all three sorts: SQL ORDER BY (db.py:238), full pandas sort (brain.py:571-573), per-line re-sort (brain.py:780). Key orders genuinely mismatch as described.


### 135. [MED · Scalability] /audit/log scans and json-parses the entire (unbounded, unrotated) audit file every request before slicing; clear races concurrent appends

**Location:** `brain.py` lines 1233-1246, 1258-1267  |  **Confidence:** high

**Problem.** get_audit_log opens the audit file and iterates EVERY line on each request, json-loads all of them into a list, then slices `log[-limit:]` at the end (1238-1246) — so the whole history is parsed per call to return ~200 rows. There is no rotation, so the JSONL grows unbounded (optimization_run + color-wheel events). clear_audit_log truncates with `open(path,'w').close()` (1262), which can interleave with a concurrent _cw_append_audit (append in another threadpooled handler) and lose or corrupt writes.

**Why it matters (architect view).** Classic O(file) scan where the store should do the windowing. At target scale (50+ plants each running optimizations) the file grows without bound and every Admin Cockpit poll re-parses all of it. Postgres would give `ORDER BY ts DESC LIMIT n` and a transactional clear for free.

**Recommendation.** Persist audit events in a Postgres audit_log table (the master-data subsystem already has admin_audit / md.list_audit — reuse that pattern) and serve with ORDER BY ts DESC LIMIT/OFFSET. If keeping JSONL short-term, read only the tail (seek from end) and rotate by size.

**Evidence.**

```
with open(_cw_audit_path(), encoding='utf-8') as f:
    for line in f: ... log.append(json.loads(line))
return {"entries": list(reversed(log[-limit:]))}   (1238-1246)
open(_cw_audit_path(), 'w', encoding='utf-8').close()   (1262)
```
> _Verifier note:_ Confirmed full-file iterate-then-slice at 1238-1246 and truncate-on-clear at 1262; both handlers are sync (threadpooled), so the append/clear race is real.


### 136. [LOW · Maintainability] Mixed ISO timestamp renderings in the _BACKEND_LOG ring make the lexicographic ?since= filter unsound; datetime.utcnow() is deprecated on 3.12

**Location:** `brain.py` lines 344, 1601, 1536; 1123, 1183, 1252  |  **Confidence:** medium

**Problem.** Backend events written to _BACKEND_LOG stamp `ts = pd.Timestamp.utcnow().isoformat()` — no 'Z', microsecond precision (line 344). Frontend log entries POSTed to the SAME ring carry their own client ts verbatim (`str(raw.get("ts") or ...)`, line 1601), which from JS is typically `...Z` with millisecond precision. GET /logs/backend?since= then does a lexicographic string compare over that mixed buffer (`str(e.get("ts","")) >= since`, line 1536, with a comment asserting 'lexicographic == chronological for a fixed format'). The two renderings are NOT a fixed format, so a trailing 'Z' (0x5A, sorts after digits) and differing sub-second precision can include/exclude the wrong entries at the boundary. Separately, datetime.utcnow() (1123, 1183, 1252) is deprecated in 3.12, the container base image.

**Why it matters (architect view).** Mixed formats compared as strings is a latent correctness bug in log windowing, and two ways to spell 'now' invite further divergence. NOTE the bug is narrower than the original finding stated: the audit-FILE entries (the datetime.utcnow()+'Z' ones at 1123/1183/1252) never enter _BACKEND_LOG — they go to a separate JSONL file served by /audit/log, which has no ?since= filter. The actual Z-suffixed entries in the since-compared ring come from the FRONTEND POST path (1601), not the audit file.

**Recommendation.** Normalize ts at the _BACKEND_LOG boundary: in append_frontend_logs, re-stamp or canonicalize the incoming ts to the backend's single format (strip/standardize the 'Z' and precision) before append, OR store an epoch-ms field and compare on that instead of the ISO string. Replace deprecated datetime.utcnow() with timezone-aware datetime.now(timezone.utc) (or pd.Timestamp.utcnow()) for the audit/color-wheel stamps.

**Evidence.**

```
ts = pd.Timestamp.utcnow().isoformat()  (344, backend ring entries)
"ts": str(raw.get("ts") or pd.Timestamp.utcnow().isoformat())  (1601, frontend entries into same ring)
entries = [e for e in entries if str(e.get("ts", "")) >= since]  (1536, lexicographic compare)
```
> _Verifier note:_ Re-scoped: the original evidence conflated the audit FILE with _BACKEND_LOG. Verified ?since= (1536) compares only _BACKEND_LOG, which mixes backend ts (344, no Z) and frontend ts (1601, client-supplied, typically Z) — so the lexicographic-soundness bug is real, just from a different source than stated. Audit-file utcnow()+'Z' entries (1123/1183/1252) are NOT in this buffer. Deprecation point is valid. Kept at low severity with corrected wording.



## `nimbus-worker.js` — 6 findings (1 high · 5 medium · 0 low)

### 137. [HIGH · Duplication] ~480 lines of safety-critical capacity/alert logic hand-duplicated between nimbus-worker.js and app.js, guarded only by a code comment

**Location:** `nimbus-worker.js` lines 26-506 (whole file); mirrors app.js Util (~28-87 equivalents), Calendar 1046-1178, Alerts overload/closed loop 3760-3920, Utilization.computeMatrix 4355-4453  |  **Confidence:** high

**Problem.** Every Util date helper, the entire Calendar capacity engine (_dayWindow/workWindow/dailyCapacityHours/effectiveFromCapacity/ensureCalendar/ensurePlant/getPlantForLine/_indexCapacityBlocks) and the full alert rule set plus computeMatrix are verbatim hand-copies of app.js. The only guard against divergence is a 'mirror of app.js' comment. A change to capacity math or an alert rule in app.js that is not manually mirrored here produces two different alert sets / utilization matrices for the same data depending on whether the Worker is alive (worker path) or has died/is unsupported (sync fallback) — and per CLAUDE.md that fallback is permanent for the session (worker onerror sets _dead=true, no auto-restart), so the same user can silently flip between two implementations across reloads.

**Why it matters (architect view).** This is production scheduling logic. Drift means an overload/blackout/closed alert the planner relies on can appear or vanish purely based on worker liveness, with no error surfaced. Finding #2 below is a concrete, already-present structural divergence in this duplicated code — proof the comment-only guard has already partially failed.

**Recommendation.** Extract the shared pure logic into a dependency-free module (e.g. nimbus-calc.js) taking plain state as arguments (exactly the shape already passed here). Load it in the worker via importScripts('nimbus-calc.js?v='+BUILD_ID) — the no-import constraint forbids ES import, not importScripts — and have app.js's Calendar/Util/Alerts delegate to it via a normal <script>. If a single file is undesirable, at minimum add a test harness running both implementations on a fixture corpus and asserting identical alert/matrix output, failing the build on drift. (Note: the worker is loaded by bare filename with no ?v= cache-bust per CLAUDE.md, so any shared file must address that too.)

**Evidence.**

```
Worker 157 `const s = new Date(Math.max(lineWin[0], plantWin[0]));` vs app.js 1089 `const s = new Date(Math.max(lineWin[0], plantWin[0]));` — character-identical algorithm maintained in two files; same for _dayWindow, dailyCapacityHours, effectiveFromCapacity, and the five alert rules.
```
> _Verifier note:_ Verified both files: worker 26-506 and app.js Calendar 1046-1178 / Alerts 3760-3920 / computeMatrix 4355-4453 are line-for-line ports. Corrected the line-count claim (~480, not 525) and the app.js Util line range (the cited 98-196 was off); kept high — the worker-mirror constraint is explicitly documented in CLAUDE.md and finding #2 shows live drift.


### 138. [MED · Correctness] Near-capacity branch structurally differs between worker and app.js — latent if/else-chain drift

**Location:** `nimbus-worker.js` lines 319-324 vs app.js 3794-3801  |  **Confidence:** high

**Problem.** app.js gates the near-capacity warning INSIDE the else-if body: `} else if (effCap > 0 && hours > effCap * Config.WARN_THRESHOLD) { if (Config.SHOW_NEAR_CAPACITY_ALERTS) alerts.push(...) }`. The worker folds the flag INTO the branch condition: `} else if (SHOW_NEAR_CAPACITY_ALERTS && effCap > 0 && hours > effCap * WARN_THRESHOLD) { alerts.push(...) }`. These are not the same control flow: in app.js a warn-zone day (effCap>0, WARN < hours/effCap ≤ OVERLOAD) MATCHES branch 2 and the chain terminates. In the worker, with SHOW=false branch 2 is skipped and execution falls through to branch 3 (`cap===0 && hours>0`).

**Why it matters (architect view).** Today the two produce identical output only by an unstated invariant: effCap>0 implies cap>0, so the fall-through branch 3 (`cap===0`) can never fire in the warn zone, and when SHOW is flipped true the warn alert fires in both. It is equivalent by accident, not by construction. Add a 4th else-if after the warn branch, or make effectiveFromCapacity able to return effCap>0 while cap===0, and the two files diverge silently — the exact failure the 'mirror rule-for-rule' comment exists to prevent.

**Recommendation.** Make the two structurally identical — keep the flag inside the branch body in BOTH files, or fold it into the condition in both. Better, eliminate the divergence permanently via the shared-module extraction in finding #1. As written it is a maintainer trap.

**Evidence.**

```
Worker 319 `} else if (SHOW_NEAR_CAPACITY_ALERTS && effCap > 0 && hours > effCap * WARN_THRESHOLD) {` then unconditional `alerts.push`. app.js 3794-3796 `} else if (effCap > 0 && hours > effCap * Config.WARN_THRESHOLD) { … if (Config.SHOW_NEAR_CAPACITY_ALERTS) alerts.push({`.
```
> _Verifier note:_ Opened both files at the cited lines; the structural difference is exactly as described and currently behaviorally-equivalent only via the effCap>0⇒cap>0 invariant. Corrected worker line range to 319-324 and app.js to 3794-3801. This is the strongest finding — concrete present-day drift in the duplicated engine.


### 139. [MED · Correctness] Capacity computed by subtracting epoch-ms of wall-clock setHours endpoints — DST-day capacity off by one hour

**Location:** `nimbus-worker.js` lines 125-126 + 194 (and mirrored app.js 1056-1057 + 1132); compounded at worker 485  |  **Confidence:** medium

**Problem.** _dayWindow builds both window endpoints with `new Date(d); setHours(hh,mm,0,0)`, then capacity is `(win[1] - win[0]) / 3600000` (worker 194). On a spring-forward DST day a 7:00→19:00 wall-clock window spans 11 real hours; on fall-back, 13. setHours yields correct wall-clock instants, but subtracting them as epoch-ms gives 11h or 13h of 'capacity' for what the planner entered as a 12h shift. computeUtilization's proportional attribution uses a fixed-length day (`dayStartMs + 86400000`, worker 485) while the window math is wall-clock, so the two are inconsistent on DST days.

**Why it matters (architect view).** Capacity drives overload and 'closed (0h)' alerts and the utilization heatmap. Twice a year, every line in a DST-observing region reports ~8% wrong capacity that day, silently shifting overload/near-capacity alerts on or off. At the 50-plant multi-region roadmap this is a recurring correctness defect, not a rounding nit.

**Recommendation.** Compute capacity in wall-clock hours (decimal h2 − h1, DST-independent) rather than by subtracting epoch-ms, or standardize the whole engine on UTC day boundaries. Whichever is chosen MUST be applied identically to both files — another argument for the shared module in finding #1.

**Evidence.**

```
Worker 125-126 `const start = new Date(d); start.setHours(hh1, mm1, 0, 0); const end = new Date(d); end.setHours(hh2, mm2, 0, 0);` then 194 `const winHours = (win[1] - win[0]) / 3600000;`.
```
> _Verifier note:_ Confirmed the wall-clock-endpoint-minus-epoch-ms pattern at worker 125-126/194 and the mirror at app.js 1056-1057/1132. The DST reasoning is technically sound. Downgraded confidence to medium and trimmed the asserted magnitude: 'twice a year per region' is real but bounded; severity medium is fair. Corrected cited line numbers (116-128 → the operative lines are 125-126/194).


### 140. [MED · Correctness] Alert plant attribution resolves plant by line code only, ignoring the materialized orders.plant (t.PLANT) — reused line codes mis-attribute plant blackouts

**Location:** `nimbus-worker.js` lines 260-263, 332, 371 (computeAlerts plantOf used by closed-diagnostic, blackout rule 3); mirrored in app.js alert loop 3734-3737, 3813, 3856  |  **Confidence:** high

**Problem.** computeAlerts resolves a task's plant solely via getPlantForLine(line, lineSettings, masterData) — line→plant only — and never reads t.PLANT. The backend now materializes orders.plant on each row precisely because a line CODE is reused across plants (CLAUDE.md / MIGRATION.md), and Store._rebuildPlantIndex already prefers `t.PLANT || Store.getPlantForLine(...)` (app.js 894). But the alert loop (worker plantOf 260-263 / app.js plantOf 3734-3737) does not, so a task on a line code shared by two plants is attributed to whichever single plant the line→plant map resolves to. Plant-level blackout conflict (rule 3) and the closed-day plant diagnostic then use the wrong plant's blackouts.

**Why it matters (architect view).** This is the multi-plant correctness hazard the migration doc flags, live at the roadmap's core (50+ plants, line codes not globally unique). A plant blackout could be missed (no blackout alert raised) or falsely raised for an order whose true plant differs from the line's default mapping. Because the same gap exists in app.js's alert loop, it is a shared design limitation, not worker-vs-app drift — but the worker is where blackout truth is computed for the rendered plant.

**Recommendation.** Thread the row's authoritative plant through to the alert engine: when t.PLANT is present, use it for plant-blackout and plant-calendar lookups instead of getPlantForLine(line). Mirror the change in both engines (shared module from finding #1). Coordinate with the make_id plant-awareness work MIGRATION.md anticipates.

**Evidence.**

```
Worker 260-263 `const plantOf = line => { if (!(line in _plantCache)) _plantCache[line] = getPlantForLine(line, lineSettings, masterData); return _plantCache[line]; };` keyed on line only, t.PLANT never read; app.js plantOf 3734-3737 identical, while _rebuildPlantIndex 894 uses `t.PLANT || Store.getPlantForLine(...)`.
```
> _Verifier note:_ Confirmed: worker plantOf 260-263 and app.js plantOf 3734-3737 both line-only; getPlantForLine (worker 91 / Store 860) never consults t.PLANT; _rebuildPlantIndex 894 does. Corrected the cited worker line list (the blackout rule uses plantOf at 371 via parsedPlantBlocks, not 372/379/396). Genuinely matches the documented multi-plant hazard; kept medium.


### 141. [MED · Maintainability] Config thresholds and shift defaults re-declared as raw literals, not derived — silent drift if app.js Config changes; MS_HOUR/MS_DAY hardcoded across four sites

**Location:** `nimbus-worker.js` lines 20-24 (thresholds); 75, 194, 331, 485 (inline 3600000/86400000)  |  **Confidence:** high

**Problem.** OVERLOAD_THRESHOLD=1.0, WARN_THRESHOLD=0.8, SHOW_NEAR_CAPACITY_ALERTS=false, DEFAULT_SHIFT=[7,19], WEEKEND_OFF=true are hard-typed literals duplicating app.js Config (lines 75-84). MS_HOUR/MS_DAY are re-hardcoded inline as 3600000/86400000 (worker 75, 194, 331, 485) where app.js uses the named Config.MS_HOUR/Config.MS_DAY (e.g. app.js 1132, 4434). Nothing forces the worker copies to track Config.

**Why it matters (architect view).** If a planner bumps WARN_THRESHOLD to 0.85 or DEFAULT_SHIFT to [6,22] in Config, the worker keeps the old values, so worker-path overload/near-capacity alerts and default-calendar capacity differ from the sync fallback for the same plant, with no error. These constants are precisely what a manufacturing planner tunes.

**Recommendation.** Pass the Config slice into the worker as part of the postMessage payload (tiny, already structured-cloned) and read thresholds/shift from the message, OR move the constants into the shared importScripts module from finding #1 — either makes Config the single source. If kept inline, at least name MS_HOUR/MS_DAY rather than repeating the magic numbers.

**Evidence.**

```
Worker 20-24 `const OVERLOAD_THRESHOLD = 1.0; const WARN_THRESHOLD = 0.8; const SHOW_NEAR_CAPACITY_ALERTS = false; const DEFAULT_SHIFT = [7, 19]; const WEEKEND_OFF = true;` vs app.js 75-84 Config; worker 194 `(win[1] - win[0]) / 3600000` vs app.js 1132 `(win[1] - win[0]) / Config.MS_HOUR`.
```
> _Verifier note:_ Verified worker 20-24 against Config 75-84 (exact value match), and confirmed the four inline 3600000/86400000 sites at worker 75/194/331/485 where app.js uses named constants. Real maintainability hazard subsumed by finding #1 but distinct (it covers the literal constants, not the logic). Kept medium.


### 142. [MED · Scalability] computeUtilization builds a dense whole-line-set matrix with no plant discriminator on the result — scope correctness delegated entirely to the caller

**Location:** `nimbus-worker.js` lines 439-458  |  **Confidence:** medium

**Problem.** The matrix is built dense as {line:{dayKey:row}} over `new Set(tasks.map(line)) ∪ Object.keys(calendars)` × days. The worker has no plant notion; it trusts the caller (_snap) to have pruned calendars/lineSettings to the selected plant, and the returned matrix carries no scope field. app.js's computeMatrix cache key is scoped by plant (app.js 4362-4363), but the worker's output is not, so the documented prewarm-vs-sync key collision (CLAUDE.md) lives here. Crucially, the `!plant` branch of _snap (app.js 3619-3629) posts an UNSCOPED snapshot — full Store.tasksArr and full calendars — and the worker will then happily build a global all-lines matrix; at the 3,500-line roadmap that is a large dense allocation plus a full structured-clone back over postMessage on every recompute.

**Why it matters (architect view).** The scale roadmap is 3,500+ lines. The cost model is O(lines × days) dense allocation plus a structured-clone of the entire matrix back to the main thread on every alert/util recompute, and scoping correctness is delegated to the caller with no assertion — one mis-scoped snapshot turns a plant-local compute into a system-wide one silently.

**Recommendation.** Have the worker accept and echo back the plant scope (and assert the line set matches), so the result is self-describing and the cache key cannot collide. Longer term, return a sparse/typed structure and skip days with zero capacity AND zero scheduled rather than materializing every cell. Reconsider whether the `!plant` branch needs to post the full global snapshot at all (per the comment, nothing is rendered with no plant selected).

**Evidence.**

```
Worker 439-444 `const lines = new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown')); Object.keys(calendars).forEach(l => lines.add(l)); … for (const line of lines) { matrix[line] = {}; for (let i = 0; i < days; i++) {` — no plant filter, no scope on the returned `{ matrix }` (worker 505). _snap `!plant` branch returns Store.tasksArr/full calendars (app.js 3621-3629).
```
> _Verifier note:_ Verified worker 435-506 (no plant filter, returns bare {matrix}) and the unscoped _snap branch at app.js 3619-3629. The key-collision is consistent with CLAUDE.md's documented prewarm-vs-sync caveat. Note _snap is plant-scoped in the common path (3638-3652), so the worst case requires the `!plant` branch; kept medium with that nuance added.



## `styles.css` — 21 findings (0 high · 11 medium · 10 low)

### 143. [MED · Duplication] Production-line color palette is duplicated verbatim between CSS tokens (--l0..--l9) and JS Config.COLORS — two unsynchronized sources of truth

**Location:** `styles.css` lines 69-70 (consumed by .vis-item.lc-0..lc-9 at 721-730)  |  **Confidence:** high

**Problem.** The 10-color line palette is declared once as CSS custom properties --l0..--l9 (styles.css:69-70: `--l0:#b8791a; --l1:#2d5f8c; --l2:#4f7a3c; --l3:#8b4c7e; --l4:#b14a3e; --l5:#3c6e7a; --l6:#7a5a2a; --l7:#5e498b; --l8:#a8493a; --l9:#4a7a5e`), consumed by `.vis-item.lc-N { background: var(--lN) }` (721-730) for the Gantt timeline. The exact same hex sequence is re-declared independently in app.js as `Config.COLORS` (app.js:79-81) and consumed in ~13 places (dashboard mini-bars 8515, hierarchy/util dots 2946/7962/8035/8262, dashboard charts, legend swatches 6087, etc.). Two byte-identical copies of the same design data with no guard against drift.

**Why it matters (architect view).** Editing a line color in :root (e.g. to resolve a clash) updates the Gantt bar but NOT the dashboard/dots/legend, which read the JS literal — so a single line would render in two colors across views. Note: today both paths derive the index from the SAME source (`Timeline._colorIndex`, app.js:6353), and the two hex lists are byte-identical, so there is NO visible discrepancy currently — this is a latent maintenance hazard that materializes on the next edit, not a present-day bug. Still architect-level: at the modulo-10 reuse needed for 3,500 lines, color identity is load-bearing and there is no test or comment guarding parity.

**Recommendation.** Single-source it: at boot, resolve the palette once via `getComputedStyle(document.documentElement).getPropertyValue('--l'+i)` into Config.COLORS, or generate the --lN declarations from the JS array at startup. As a cheap stopgap, add a `/* MUST match Config.COLORS in app.js (line ~79) */` comment on the CSS side and vice versa.

**Evidence.**

```
CSS `--l0:#b8791a; --l1:#2d5f8c; --l2:#4f7a3c; --l3:#8b4c7e; --l4:#b14a3e;` (styles.css:69) consumed by `.vis-item.lc-0 { background: var(--l0); border-color: var(--l0); }` (721). JS `'#b8791a','#2d5f8c','#4f7a3c','#8b4c7e','#b14a3e',` (app.js:79) consumed as `lineColors[line] = Config.COLORS[ci % Config.COLORS.length];` (app.js:8515).
```
> _Verifier note:_ Verified both lists exist and are byte-identical; confirmed CSS lc-N path and 13 JS Config.COLORS consumers. Corrected the original 'silently renders two different colors' framing — both paths share Timeline._colorIndex so they only diverge after a future edit; downgraded high→medium accordingly.


### 144. [MED · Duplication] Severity-color washes are re-hardcoded as bespoke rgba() literals — several are subtly different reds/greens that don't match or track the semantic tokens they shadow

**Location:** `styles.css` lines 736-739, 748-749, 752, 762-764, 867-868  |  **Confidence:** high

**Problem.** The semantic palette defines --err:#b1362a, --warn:#b57a0a, --ok:#2f7a4d, --info:#2d5f8c (54-66). The timeline overlay and alertcell rules instead re-spell these as raw rgba literals with bespoke alpha — and several use a DIFFERENT hue than the token: blackout uses `rgba(177,54,42,...)` (736-737) which equals #b1362a (=--err, OK), but `.alertcell-err` uses `rgba(176,45,45,0.22)` + border `rgba(140,30,30,0.45)` (748-749) — a third near-err red that does NOT match #b1362a; alert-horizon uses `rgba(60,200,90,0.12)` + hardcoded #1a7a2e border (762-764), neither matching --ok #2f7a4d; verdict pills repeat `rgba(220,70,70,0.14)` / `rgba(220,165,60,0.14)` (867-868).

**Why it matters (architect view).** 'Error' is rendered in at least three slightly different hues across the timeline (177,54,42 vs 176,45,45 vs the token), and none track the token — flip to dark mode (where --err becomes #d94a3a, 4202) and all these washes stay the light-mode color, breaking visual consistency exactly where alerts matter. It also turns a future colorblind/per-plant palette change into a find-replace dig across scattered rgba literals.

**Recommendation.** Derive the washes from tokens via `color-mix(in srgb, var(--err) 22%, transparent)`, or define --err-wash/--warn-wash/--ok-wash once in both themes so alpha is explicit and hue is single-sourced. Eliminate the off-by-a-few-units variants (176,45,45 / 140,30,30 / #1a7a2e) by mixing from the existing tokens.

**Evidence.**

```
`background: repeating-linear-gradient(45deg, rgba(177,54,42,0.12) 0 8px, rgba(177,54,42,0.04) 8px 16px)` (736-737) vs `.vis-item.alertcell-err { background: rgba(176,45,45,0.22) !important; border: 1px solid rgba(140,30,30,0.45) !important; }` (748-749) — three distinct reds for one semantic --err:#b1362a; `border-right: 3px solid #1a7a2e` (764) for the --ok horizon.
```
> _Verifier note:_ Verified every rgba literal at the cited lines; confirmed 176,45,45 ≠ token's 177,54,42 (#b1362a) and horizon green ≠ --ok. Corrected line ranges (736-739, 748-749, 762-764, 867-868). Kept at medium — real consistency/dark-mode defect but confined to alert washes.


### 145. [MED · Duplication] Light-accent RGB hardcoded as raw rgba(184,121,26,…) instead of an alpha-able token; never tracks dark --accent

**Location:** `styles.css` lines 2178, 2184, 2190, 2191, 2252, 2383, 2408, 2505, 2506, 2575, 2615, 2638, 2639, 2771, 3145, 3177, 3293  |  **Confidence:** high

**Problem.** The literal `rgba(184,121,26, …)` — the RGB of light-mode `--accent` #b8791a — appears 30 times across the file (23 within this slice) wherever a translucent amber is needed (header glow, focus ring, chip shadows, badge tints, toggle shadow, dropzone ring). Because `--accent` shifts to #d4920f (212,146,15) in dark mode but these literals do not, every translucent-amber surface stays the LIGHT amber while solid `var(--accent)` surfaces shift to the dark amber. The accent effectively has two values that diverge the moment dark mode engages.

**Why it matters (architect view).** This is the largest DRY violation in the slice and a real theming defect. CLAUDE.md targets per-plant theming and a working dark mode; with the accent RGB inlined 30 times, neither rebrand nor per-plant accent nor correct dark-mode tinting is achievable without a file-wide find-and-replace — exactly what a token system exists to prevent.

**Recommendation.** Define `--accent-rgb: 184,121,26;` in `:root` and `--accent-rgb: 212,146,15;` in `body.dark`, then replace every `rgba(184,121,26, X)` with `rgba(var(--accent-rgb), X)`. This collapses the literals to one per-theme declaration and makes translucent amber track the solid accent. (`--accent-rgb` is already referenced at 3257 with a wrong fallback, so the contract is half-built — finish it.)

**Evidence.**

```
.opt-preset-chip.active { box-shadow: 0 2px 10px rgba(184,121,26,0.32); }  /* repeated at 0.06/.10/.12/.14/.18/.25/.28/.30/.36/.38/.50 across header, toggle, badge, dropzone, scope-btn */
```
> _Verifier note:_ Verified count: grep -oE 'rgba\(184,\s*121,\s*26' = 30 file-wide, 23 in slice 1701-3400. Finding's '59 times' was wrong — corrected to 30/23. Dark --accent=#d4920f confirmed at L4188, so the divergence claim holds. Severity high→medium (visual only).


### 146. [MED · Duplication] opt-modal and cal-edit-modal duplicate the backdrop + card + entrance-animation block near-verbatim

**Location:** `styles.css` lines 2137-2165, 2464-2492  |  **Confidence:** high

**Problem.** `.opt-backdrop`/`.opt-modal` (2137-2165) and `.cal-edit-backdrop`/`.cal-edit-modal` (2464-2492) are near-identical, differing only in `max-width` (550 vs 640) and `max-height` (90vh vs 92vh): same `rgba(10,12,18,0.72)` backdrop, same `backdrop-filter: blur(12px)`, same `z-index:3000`, same triple box-shadow, same `border-radius:18px`, same `transform: translateY(28px) scale(0.96)` + `cubic-bezier(.22,1,.36,1)` entrance, same `.visible` reset. The comment at line 2461 admits the duplication ('Mirrors the opt-modal pattern: same backdrop blur … same slide-up entrance animation').

**Why it matters (architect view).** Two copies of a modal shell guarantee silent drift — a tweak to one shadow or animation curve won't propagate to the other, and NIMBUS is adding more modals (optimizer preview, color-wheel viewer, blackout editors per CLAUDE.md), each likely to copy this block again.

**Recommendation.** Extract a shared `.nimbus-modal-backdrop` + `.nimbus-modal-shell` (or a `[data-modal]` base) carrying backdrop, blur, shadow, radius, and the entrance transition; let `.opt-modal`/`.cal-edit-modal` differ only by `max-width`/`max-height`. Promote the magic literals (`18px` radius, `28px` slide, `0.24s cubic-bezier(.22,1,.36,1)`, `blur(12px)`) to tokens (`--r-modal`, `--ease-modal`, `--modal-blur`).

**Evidence.**

```
.opt-modal { border-radius:18px; transform: translateY(28px) scale(0.96); transition: opacity 0.24s cubic-bezier(.22,1,.36,1), transform 0.24s cubic-bezier(.22,1,.36,1); }  /* .cal-edit-modal identical but for max-width/max-height */
```
> _Verifier note:_ Read both blocks: identical except max-width 550/640 and max-height 90vh/92vh; comment at L2461 self-documents the copy. Line ranges accurate.


### 147. [MED · Duplication] Admin status colors re-implemented with literal hex instead of the existing semantic tokens — two reds for one 'error' state

**Location:** `styles.css` lines 2825-2827, 2850-2852, 2869, 2872, 2903-2911, 2945-2948, 2999-3010, 3121-3122  |  **Confidence:** high

**Problem.** The admin cockpit re-invents ok/warn/err coloring with raw hex (`#27ae60`, `#c0392b`, `#92620a`, `#b57a0a`, `rgba(243,156,18,…)`, `rgba(192,57,43,…)`) across health dots, pipeline steps/deltas, pdtl panels, and backend-warning rows — while the file already defines `--ok`, `--err`, `--warn`, `--warn-vivid`, `--info`. The same status concept thus has two color vocabularies: token-based (`.admin-log-row.admin-log-error { border-left-color: var(--err) }`, 1995) and literal-based (`.admin-pipeline-step.err { border-color:#c0392b }`, 2852). And `--warn-vivid` (#f39c12) appears both as the token AND as hand-inlined `rgba(243,156,18,…)` — the same color two ways.

**Why it matters (architect view).** Status colors carry meaning. `--err` is #b1362a = rgba(177,54,42); the admin literal #c0392b = rgba(192,57,43) — a genuinely different red, so the same 'error' state renders as two reds depending on which panel draws it. Worse, the token-based reds (`--ok`/`--err`/`--warn`/`--info`) ARE redefined in `body.dark` while the literal ones are not, so in dark mode the admin's literal statuses diverge further from the app's. Classic copy-paste-then-drift across a god-module.

**Recommendation.** Replace the literals with the existing semantic tokens and (for tints) `rgba(var(--…-rgb), α)` companions. If the admin console genuinely needs more saturated status colors, define them once as `--status-ok/-warn/-err` with dark variants rather than inlining #27ae60/#c0392b at ~12 sites.

**Evidence.**

```
.admin-health-dot.err { background:#c0392b; }  .admin-pipeline-step.err { border-color:#c0392b; }  /* vs */ .admin-log-row.admin-log-error { border-left-color: var(--err); }  /* --err = #b1362a ≠ #c0392b — two reds for 'error' */
```
> _Verifier note:_ Verified --err=#b1362a (L63) ≠ admin #c0392b; --warn-vivid=#f39c12 (L58) used both as token and inline rgba(243,156,18); --ok/--err/--warn/--info redefined in body.dark (L4199-4203) but literals and --warn-vivid are not. All cited lines real.


### 148. [MED · Maintainability] Three design tokens (--bg-float, --nimbus-amber, --amber) are referenced but never declared, so their literal DARK fallbacks always win — wrong colors in the default LIGHT theme and unthemeable in dark

**Location:** `styles.css` lines 438, 773, 834, 1763-1765  |  **Confidence:** high

**Problem.** Three custom properties are referenced with literal fallbacks but never defined in :root OR body.dark (grep confirms zero declarations): --bg-float falls back to #1e2025 for the pill context menu (438); --nimbus-amber falls back to #d97706 for the marquee border (773) and hover-card alert text (834); --amber falls back to #d4a843 for the active gantt-line filter button (1763-1765). Because the named token is undefined, the literal fallback always resolves, in every theme. (The original finding also cited --bg-elev/--line-strong/--fg fallbacks at 786-792; those tokens ARE defined, so the fallbacks there are merely dead code — harmless, not part of the defect.)

**Why it matters (architect view).** For the three genuinely-undefined tokens the literal wins regardless of theme: the pill context menu paints near-black #1e2025 on the warm off-white shell, and the active gantt-line button renders #d4a843 — a fourth amber that matches neither the light accent (#b8791a, :root:43) nor the dark accent (#d4920f, body.dark:4188). These elements also never respond to the body.dark token swap, so a future per-plant --accent override would not reach them. This is the per-plant-theming fragility the roadmap flags.

**Recommendation.** Either define the three tokens once in :root and body.dark (alias --nimbus-amber and --amber to --accent; add --bg-float as a floating-surface elevation token), or replace the references with the existing real tokens (--accent, --bg-elev) and drop the literal fallbacks so an undefined token fails loudly instead of silently shipping an off-palette color.

**Evidence.**

```
`background: var(--bg-float, #1e2025);` (438); `border: 1px dashed var(--nimbus-amber, #d97706);` (773); `color: var(--nimbus-amber, #d97706);` (834); `background: var(--amber, #d4a843); ... border-color: var(--amber, #d4a843);` (1763-1765). Grep for `--bg-float`/`--nimbus-amber`/`--amber` returned no declarations anywhere in styles.css.
```
> _Verifier note:_ Grep confirmed all three tokens are never declared (no LHS matches). Verified each fallback site and that #d4a843 matches neither light nor dark accent. Trimmed the 786-792 lines from the finding (those tokens are defined → dead-but-harmless fallback); downgraded high→medium since the affected surfaces are a handful of secondary elements.


### 149. [MED · Maintainability] Admin-tab tint tokens are not redefined for dark mode, so the Admin tab keeps a light-gray chip on the dark shell

**Location:** `styles.css` lines 59-60, 142-153 (dark block 4175-4209, omission at 4201)  |  **Confidence:** high

**Problem.** --tab-admin-bg (#f3f4f6) and --tab-admin-bg-hover (#e5e7eb) are defined only in :root (59-60) and drive the Admin tab chip (142-153). The body.dark block (4175-4209) redefines the Master-Data sibling --tab-md-bg/--tab-md-bg-hover (4201: #1c3d28/#224830) but conspicuously omits the admin pair. So in dark mode the Admin tab renders the hardcoded light gray #f3f4f6/#e5e7eb against the deep-slate #13141a shell.

**Why it matters (architect view).** Asymmetric, clearly-unintended gap: the maintainer themed the md tab tints in dark but missed the admin pair — exactly the silent gap a token system should prevent. The admin chip glows light gray in dark mode while neighboring tabs theme correctly, and the active #e5e7eb hurts contrast on the dark shell.

**Recommendation.** Add --tab-admin-bg / --tab-admin-bg-hover overrides to the body.dark block alongside the existing --tab-md-bg overrides (e.g. desaturated slate #252730 / #2c2e3d). Better: derive both tab tints from --bg-subtle/--bg-strong so they theme automatically and the per-tab literals disappear.

**Evidence.**

```
`--tab-admin-bg: #f3f4f6;` (59) used by `.tab-btn[data-tab="admin"]:not(.active) { background: var(--tab-admin-bg); }` (143). body.dark redefines only `--tab-md-bg: #1c3d28; --tab-md-bg-hover: #224830;` (4201) — no admin counterpart in the 4175-4209 block.
```
> _Verifier note:_ Read the full body.dark block (4175-4209) — confirmed md pair present at 4201, admin pair absent. Light-mode declarations at 59-60 and consumers at 142-153 verified.


### 150. [MED · Maintainability] Welcome splash and orb hardcode light-only backdrop, shadows, and a one-off #ffffff dark orb patch instead of using tokens

**Location:** `styles.css` lines 1442, 1460-1462, 1471, 1476  |  **Confidence:** high

**Problem.** .welcome-splash hardcodes its frosted backdrop as `rgba(245,244,239,0.82)` (1442) — the literal light --bg value, not the token — and .welcome-splash-card hardcodes three slate shadows `rgba(26,27,31,0.07/.08/.07)` (1460-1462). The orb is filled with `var(--accent-wash)` (1471), whose dark value is near-black #1e1505 (4191), so a one-off rule `body.dark .ws-orb { background: #ffffff; }` (1476) hardcodes white to compensate. Grep confirms the orb is the ONLY body.dark override for the splash — no dark override exists for the backdrop or card.

**Why it matters (architect view).** The boot splash is the first thing a dark-mode user sees and renders with a baked-in light-cream backdrop regardless of theme. The #ffffff orb patch is a symptom of fighting the token system rather than using it. The block also ignores any per-plant accent, and is brittle — change --bg and the backdrop no longer matches it.

**Recommendation.** Replace `rgba(245,244,239,0.82)` with a token-derived translucent surface (e.g. `color-mix(in srgb, var(--bg) 82%, transparent)`), express the card shadow via the existing dark-aware --shadow-lg token (4208), and give the orb a dedicated --orb-bg token defined in both themes instead of the #ffffff patch.

**Evidence.**

```
`background: rgba(245, 244, 239, 0.82);` (1442); `box-shadow: 0 0 0 1px rgba(26,27,31,0.07), 0 4px 16px rgba(26,27,31,0.08), 0 20px 48px rgba(26,27,31,0.07);` (1460-1462); `background: var(--accent-wash);` (1471) with `body.dark .ws-orb { background: #ffffff; }` (1476).
```
> _Verifier note:_ All four lines verified verbatim; grep confirmed 1476 is the sole splash dark override (no backdrop/card dark rule exists). Adjusted orb-fill citation from 1467-1476 to the precise 1471 fill + 1476 patch.


### 151. [MED · Maintainability] Undefined design tokens (--amber, --font-mono, --accent-rgb) silently pin components to fallback literals

**Location:** `styles.css` lines 1763, 1765, 2025, 2037, 2067, 3257  |  **Confidence:** high

**Problem.** Several rules reference tokens that are never defined in the stylesheet, so each takes its inline fallback. `.gantt-line-btn.active` uses `var(--amber, #d4a843)` (1763, 1765) — but the project accent is `--accent: #b8791a` (light) / `#d4920f` (dark), and the analogous `.opt-preset-chip.active` (2249) uses `var(--accent)`. So the active line-filter button renders a different amber (#d4a843) than every other accent surface and never themes for dark mode. `--font-mono` (2025, 2037, 2067) is undefined, falling back to `ui-monospace` while the rest of the file hardcodes `'JetBrains Mono', ui-monospace, Consolas, monospace` — two competing mono stacks. `--accent-rgb` (3257) is undefined, so `.opt-plant-item.selected` highlights with the fallback `rgba(210,140,0,0.08)`, a third unrelated amber.

**Why it matters (architect view).** A token referenced-but-never-defined pins the component to a literal the maintainer believes is centralized but is not, so rebranding or per-plant theming via `--accent` leaves these surfaces behind, producing visible color drift. CLAUDE.md explicitly flags `--amber`, `--nimbus-amber`, `--font-mono`, `--bg-float` as referenced-but-never-defined, so this is a documented landmine worth closing.

**Recommendation.** Replace `var(--amber, …)` with `var(--accent)` on `.gantt-line-btn.active` so it matches `.opt-preset-chip.active` and themes in dark mode; define `--font-mono` once (the JetBrains stack) and use it consistently; either define `--accent-rgb` per theme or switch `.opt-plant-item.selected` to `var(--accent-wash)`/`var(--accent-soft)`.

**Evidence.**

```
.gantt-line-btn.active { background: var(--amber, #d4a843); border-color: var(--amber, #d4a843); }  /* vs */  .opt-preset-chip.active { background: var(--accent); }  /* --amber, --font-mono, --accent-rgb confirmed NONE DEFINED via grep of `^\s*--token:` */
```
> _Verifier note:_ Verified grep: --amber/--font-mono/--accent-rgb have zero LHS definitions; --accent=#b8791a (L43)/#d4920f (L4188). Severity lowered high→medium: theming/cosmetic, no functional break, and already documented in CLAUDE.md.


### 152. [MED · Maintainability] Optimize & Edit-Calendar modals hardcode light surface colors with no body.dark counterpart

**Location:** `styles.css` lines 2171, 2199, 2203, 2403, 2445, 2452, 3108  |  **Confidence:** high

**Problem.** The Optimize dialog and Edit Calendar modal hardcode light-design colors with no `body.dark` override (grep confirms NONE exist for these classes). The worst offenders are `.opt-strategy-card:hover { background: #efede6 }` (2403) — a light beige hover painted onto a dark card in dark mode — and `.cw-active-card { background: linear-gradient(135deg, var(--accent-wash) 0%, #fdf8ee 100%) }` (3108), whose second stop stays cream in dark mode (CLAUDE.md explicitly lists `.cw-active-card` as a known gap). The `.opt-run-btn` gradient `#c4831e→#9d6210` (2445/2452) and the `.opt-header` literals (`#1e222d` bg 2171, `#f8f5ef` title 2199, `rgba(248,245,239,0.48)` subtitle 2203) are also frozen, so the run button and header never track the dark accent.

**Why it matters (architect view).** A modal overlays the whole screen, so a half-finished dark theme is most jarring there. The dark layer was authored as an allowlist (token overrides + a handful of element fixes), so any component using literals instead of tokens silently opts OUT of dark mode with no compile-time signal — the structural reason CLAUDE.md documents the dark layer as incomplete.

**Recommendation.** Route these through tokens (`--bg-strong`/`--bg-elev`/`--fg`/`--fg-mute` for the header; `--bg-hover` or `--bg-subtle` for the strategy-card hover; an `--accent-grad-from/to` pair for the run-btn and active-wheel gradients) so they inherit `body.dark` automatically, OR add explicit `body.dark` overrides. Strategically, prefer token-by-default so dark coverage is automatic rather than per-component opt-in.

**Evidence.**

```
.opt-strategy-card:hover { background: #efede6; }  .cw-active-card { background: linear-gradient(135deg, var(--accent-wash) 0%, #fdf8ee 100%); }  /* grep: no `body.dark .opt-header|.opt-strategy|.cw-active-card|.opt-run-btn` rule exists */
```
> _Verifier note:_ Verified all literals at cited lines and confirmed body.dark redefines --accent/--bg-*/--fg (L4175-4209) so token-based components DO theme — these literal ones don't. Dropped lines 2211/2218/2404/2445/2452 partial-overlap noise; #efede6 hover and #fdf8ee gradient are the clearest real regressions. Severity high→medium.


### 153. [MED · Maintainability] DB Deep Dive panel hardcodes status colors as raw hex/rgba instead of semantic tokens, so they never shift in dark mode

**Location:** `styles.css` lines 4387-4389, 4402-4404, 4413-4415, 4426, 4442-4443, 4452-4453, 4540-4541 (DB Deep Dive block 4337-4567)  |  **Confidence:** high

**Problem.** The DB Deep Dive subsystem paints its status semantics with literal hex and literal rgba rather than the design tokens. Fill bars use `.admin-db-fillbar-fill.ok { background: linear-gradient(90deg, #27ae60, #2ecc71); }` (4387) and `.err { ... #c0392b, #e74c3c }` (4389); the stacked connection bar uses `.state-active { background: #e74c3c; }` / `.state-idle { background: #27ae60; }` (4402, 4404); the legend chips and table-health cards repeat `rgba(39,174,96,0.14)` / `rgba(243,156,18,0.x)` / `rgba(192,57,43,0.x)` across ok/warn badges, card backgrounds and lock-chain nodes (4413-4415, 4426, 4442-4443, 4452-4453, 4540-4541). None reference `--ok`/`--warn`/`--err` or their `-soft` variants, which are redefined for dark at 4199-4202.

**Why it matters (architect view).** These greens/reds are the brightest elements on the admin DB panel and they are hardcoded, so they do not track the dark-mode token overrides (dark `--ok` is #3d9962, dark `--err` is #d94a3a) — they stay light-tuned on a dark background. The literals also drift from the tokens (#27ae60 vs `--ok` #2f7a4d/#3d9962), so 'green' means different things on the same screen, and rebranding/per-plant accenting requires grepping ~25 scattered literals.

**Recommendation.** Replace solid fills with `var(--ok)`/`var(--warn)`/`var(--err)`; replace tinted rgba backgrounds with the `-soft` tokens or `color-mix(in srgb, var(--ok) 14%, transparent)` (the file already uses color-mix at 4844 and 4894). For the genuine two-stop gradients, define `--ok-2`/`--err-2` end-stop tokens once in :root and body.dark.

**Evidence.**

```
4387 `.admin-db-fillbar-fill.ok { background: linear-gradient(90deg, #27ae60, #2ecc71); }`; 4389 `.err { ... #c0392b, #e74c3c }`; 4402 `.state-active { background: #e74c3c; }`; 4404 `.state-idle { background: #27ae60; }`; 4442 `.admin-db-tbl-card-badge.ok { background: rgba(39,174,96,0.14); color: #27ae60; }`
```
> _Verifier note:_ Verified all cited literals exist verbatim at the stated lines (4387-4389, 4402-4404, 4413-4415, 4426, 4442-4443, 4452-4453, 4540-4541); confirmed --ok/--warn/--err are redefined in body.dark (4199-4202) so the hardcodes genuinely break dark mode. Lowered severity high->medium: this is an internal ops panel, not user-facing scheduling UI, and the visual is cosmetic (wrong-temperature greens/reds), not a functional defect.


### 154. [LOW · Correctness] Tokens referenced but never defined (--border, --border-subtle); no-fallback uses fall back to currentColor

**Location:** `styles.css` lines 4970-4971 (no fallback); 4126-4127 and 3973 (undefined-but-fallback)  |  **Confidence:** high

**Problem.** The Admin Thread Profiler references `var(--border)` and `var(--border-subtle)` with NO fallback: `.admin-perf-table th { ... border-bottom: 2px solid var(--border); }` (4970) and `td { ... border-bottom: 1px solid var(--border-subtle); }` (4971). Neither token is defined anywhere in the file, so the longhand `border-bottom-color` resolves to its initial value `currentColor` — i.e. the borders render in the cell's text color rather than a subtle line. By contrast the diagnostics card at 4126/4127 uses `var(--bg-elev, #fff)` / `var(--border, #e5dfd2)` and `.md-td` at 3973 uses `var(--line-subtle, #e8e7e1)`, where a fallback masks the missing token. So the codebase has three classes of color reference (defined token / undefined-with-fallback / undefined-without-fallback) that look identical in source but behave differently.

**Why it matters (architect view).** The no-fallback case is a real, if minor, visual bug: the profiler table's row separators draw in the text color instead of a hairline. The undefined-but-fallback cases are not bugs today but are latent — they encode a token name that doesn't exist, so the 'token system' silently isn't one for these references.

**Recommendation.** Define `--border` / `--border-subtle` (clearly meant to be `--line` and a lighter `--line`) once in :root and body.dark, or simpler: replace the four references with the canonical existing `--line` token. Add a lint rule flagging `var(--x)` with no fallback for undefined custom properties.

**Evidence.**

```
4970 `.admin-perf-table th { ... border-bottom: 2px solid var(--border); }`; 4971 `td { ... border-bottom: 1px solid var(--border-subtle); }`; anchored grep confirms no `--border:` / `--border-subtle:` / `--line-subtle:` declaration exists
```
> _Verifier note:_ Confirmed --border/--border-subtle/--line-subtle have no `:` definition anywhere (anchored grep). The no-fallback uses at 4970-4971 are real and do resolve to currentColor. DROPPED --font-mono from this finding's no-fallback claim: the original wrongly grouped --font-mono here, but line 4969 uses `var(--font-mono, monospace)` WITH a fallback (and 2025/2037/2067 also use it with fallbacks), so --font-mono is undefined-but-always-has-a-fallback, not a currentColor bug. Severity lowered medium->low: only the two profiler border lines are an actual defect, and it's a faint internal table.


### 155. [LOW · Correctness] .timeline-empty-overlay hardcodes a light off-white scrim with no dark-mode counterpart, unlike its sibling overlays

**Location:** `styles.css` lines 3764 (vs siblings at 3780, 3790)  |  **Confidence:** high

**Problem.** `.timeline-empty-overlay` sets `background: rgba(245, 244, 239, 0.92)` (3764) — the light `--bg` value (#f5f4ef) baked into an rgba. No body.dark override exists for this overlay (the dark section at 4211-4252 covers vis-timeline panels but not this scrim). In dark mode the 'no plant selected' overlay shows a near-opaque light panel over the dark Gantt. The sibling overlays `.table-empty-overlay` (3780, `background: var(--bg)`) and `.dashboard-empty-overlay` (3790, `background: var(--bg-elev)`) correctly use tokens, so this one is the odd one out.

**Why it matters (architect view).** Same component family, inconsistent approaches: two siblings theme correctly via tokens, this one hardcodes the light color and is theme-broken. The empty-state overlay is high-visibility — it is what an operator sees before selecting a plant, and with 50+ plants the picker is hit constantly, so a light flash on a dark Gantt is noticeable.

**Recommendation.** Replace with a token-derived translucent fill: `background: color-mix(in srgb, var(--bg) 92%, transparent)`, or define one `--scrim` token and reuse it across all three overlays for consistency.

**Evidence.**

```
3764 `.timeline-empty-overlay { ... background: rgba(245, 244, 239, 0.92); z-index: 6; ... }`; 3780 `.table-empty-overlay { ... background: var(--bg); }`; 3790 `.dashboard-empty-overlay { ... background: var(--bg-elev); }`
```
> _Verifier note:_ Confirmed the hardcoded rgba(245,244,239,0.92) at 3764 (= light --bg #f5f4ef) and the token-using siblings at 3780/3790; confirmed the body.dark vis-timeline block (4211-4252) has no override for this class. Real theming bug, but cosmetic and low severity.


### 156. [LOW · Duplication] Floating surfaces hand-roll rgba(0,0,0,...) box-shadows instead of the dark-aware --shadow-* token scale

**Location:** `styles.css` lines 345, 441, 789, 1182  |  **Confidence:** high

**Problem.** The design system defines a three-tier shadow scale (--shadow-sm/md/lg) that is explicitly re-tuned darker for dark mode (4206-4208) and is used correctly in ~15 places. But several floating/elevated surfaces hand-roll their own rgba(0,0,0,...) shadows: pill context menu `0 8px 24px rgba(0,0,0,.35)` (441), hover card `0 6px 20px rgba(0,0,0,0.35)` (789), sticky table-header LINE column `2px 0 4px -1px rgba(0,0,0,0.10)` (1182), actionable KPI hover `0 4px 12px rgba(0,0,0,0.06)` (345). (The original also cited 1169, but that line is `box-shadow: 2px 2px 0 var(--line)` — a hairline using a token, not an rgba literal — so it is not part of this finding.)

**Why it matters (architect view).** These literal shadows are tuned for one theme and bypass the deliberate light/dark re-tune at 4206: `rgba(0,0,0,0.06)` on the KPI tile is invisible on dark; the 0.35 menu/card shadows read too heavy on the light shell. Same single-source-of-truth break as the color tokens, for elevation. Lowest-impact of the set (cosmetic), but it does multiply the surface for any future elevation redesign.

**Recommendation.** Route elevated/floating surfaces through var(--shadow-md)/var(--shadow-lg). If a surface genuinely needs a unique elevation, add a token rather than a literal so it participates in the dark-mode re-tune.

**Evidence.**

```
`box-shadow: 0 8px 24px rgba(0,0,0,.35);` (441) and `box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);` (789) on float surfaces, while --shadow-lg exists and is dark-tuned at 4208.
```
> _Verifier note:_ Verified the 4 genuine rgba literals (345, 441, 789, 1182). Dropped the 1169 citation — it uses var(--line), not an rgba shadow literal. Kept at the reviewer's own low severity; this is the weakest of the set and overlaps thematically with the token findings, but the pattern is real.


### 157. [LOW · Duplication] .admin-subtab and .sub-subtab are near-duplicate rule blocks that must be maintained in lockstep

**Location:** `styles.css` lines 3802-3824 vs 3827-3849; dark override at 4580-4581  |  **Confidence:** high

**Problem.** `.admin-subtab` (base, :hover, .active at 3802-3824) and `.sub-subtab` (base, :hover, .active at 3827-3849) are identical declaration-for-declaration — same padding, border, margin, color, font, transition, and the same five-line .active block (`color:#000`, `border-left/right/top: 2px solid var(--accent)`, `border-bottom-color: var(--accent)`). The only difference is the selector name; the comment at 3826 acknowledges the copy ('isolated from .admin-subtab to prevent cross-contamination'). The dark-mode `.active { color:#fff }` rule at 4580-4581 already has to list both selectors together.

**Why it matters (architect view).** Two tab strips must be restyled by hand in lockstep; any future change must be mirrored in two places or the strips drift. 'Isolation to prevent cross-contamination' is achievable with a comma-grouped selector without copy-paste — which the dark rule at 4580 already demonstrates.

**Recommendation.** Collapse to a comma-grouped rule `.admin-subtab, .sub-subtab { ... }` (matching what 4580 already does) and keep only genuine per-strip overrides separate. Removes ~23 duplicated lines and a standing drift hazard.

**Evidence.**

```
3816-3823 `.admin-subtab.active { color: #000; font-weight: 700; background: var(--bg-strong); border-left: 2px solid var(--accent); ... border-bottom-color: var(--accent); }` is byte-identical to 3841-3848 `.sub-subtab.active { ... }`
```
> _Verifier note:_ Diffed both blocks line by line (3802-3824 vs 3827-3849) — base, :hover and .active are identical apart from the selector name; the 'isolation' comment is at 3826 as claimed and 4580-4581 already comma-groups both for the dark override. Corrected the second block's start line (finding said 3826, the rule actually starts at 3827). Lowered medium->low: pure cosmetic duplication of two tab strips, ~23 lines, low blast radius.


### 158. [LOW · Maintainability] Overlapping vis-item state classes all use !important opacity, giving source-order-dependent precedence when co-applied

**Location:** `styles.css` lines 1779, 1882, 1886-1890  |  **Confidence:** medium

**Problem.** State classes on timeline items lean on `!important` to beat the vis.js base rules: `.vis-item.dimmed { opacity:0.12 !important }` (1779), `.vis-item.ghost { opacity:0.45 !important; border-style:dashed !important }` (1882), `.vis-item.ghost-conflict { opacity:0.55 !important; outline:… !important; border-style:dashed !important }` (1886-1890). Because dimmed/ghost/ghost-conflict all set `opacity !important` at equal specificity, an item that is simultaneously dimmed AND a ghost has its final opacity decided by source order, not intent — there is no defined precedence among these mutually-applicable states.

**Why it matters (architect view).** `!important` on overlapping state classes removes the cascade's ability to express precedence. The moment two states co-occur — a ghost-dragged item on a filtered/dimmed line, possible during the documented multi-drag marquee with an active filter — the visual result is order-dependent and effectively undefined, and every new state must escalate to `!important` to compete, ratcheting the subtree into an arms race.

**Recommendation.** Scope the vis.js override once with a higher-specificity ancestor (e.g. `.timeline-root .vis-item.…`) so plain declarations win without `!important`, and define explicit precedence among dimmed/ghost/ghost-conflict (e.g. conflict > ghost > dimmed) via a single resolved rule or a custom-property-driven opacity.

**Evidence.**

```
.vis-item.dimmed { opacity: 0.12 !important; }  .vis-item.ghost { opacity: 0.45 !important; }  .vis-item.ghost-conflict { opacity: 0.55 !important; outline: 2px solid var(--err) !important; }
```
> _Verifier note:_ Verified the three !important opacity rules at cited lines. Dropped the 3121-3122 cw-delete-btn !important mention — that's beating utility-button styling, a different (defensible) use of !important, not the overlapping-state problem. Severity correctly low.


### 159. [LOW · Maintainability] --warn-vivid is never redefined in body.dark, so 'vivid amber' status fills stay light-tuned in dark mode

**Location:** `styles.css` lines defined only at 58; body.dark block 4175-4209 omits it; consumed at 4388, 4403, 4467, 4513 (also 2826, 2851, 3000)  |  **Confidence:** high

**Problem.** `--warn-vivid: #f39c12` is defined only in the light :root (line 58). The body.dark token block (4175-4209) overrides `--warn` to #d09010 and `--warn-soft` to #2e2008 but never overrides `--warn-vivid`. Components consume it on the admin panel: `.admin-db-fillbar-fill.warn` gradient (4388), `.admin-db-stackbar-seg.state-xit` (4403), `.db-maint-btn--urgent` color (4467), `.admin-db-hbar-fill.warn` (4513) — plus health dots/pipeline steps at 2826, 2851, 3000. In dark mode all render the unmodified light #f39c12.

**Why it matters (architect view).** It is the inverse of the discipline applied to the rest of the warn family: `--warn` shifts to the muted dark value but `--warn-vivid` next to it does not, so the dark warn palette is internally inconsistent on the same panel. Note 4388/4513 pair the missing-in-dark `--warn-vivid` with a hardcoded `#d09010` (the dark `--warn` literal), compounding the inconsistency.

**Recommendation.** Add `--warn-vivid` to the body.dark block (e.g. `--warn-vivid: #f0a830;`) so it tracks the rest of the warn family. As a general rule, any token added to :root should be mirrored in body.dark.

**Evidence.**

```
58 `--warn-vivid:#f39c12;`; body.dark 4200 has `--warn: #d09010; --warn-soft: #2e2008;` but no --warn-vivid; 4467 `.db-maint-btn--urgent { ... color: var(--warn-vivid); }`
```
> _Verifier note:_ Confirmed via anchored grep that --warn-vivid appears defined ONLY at line 58 and is absent from the body.dark block (4175-4209); confirmed all four cited consumers (4388,4403,4467,4513) exist plus three more at 2826/2851/3000. Kept at low (was medium): real but minor cosmetic inconsistency on an internal admin panel.


### 160. [LOW · Maintainability] Active-tab text color hardcoded #000 in light and re-patched to #fff in a distant dark rule

**Location:** `styles.css` lines 3817, 3842 (#000); 4578-4581 (dark #fff patch)  |  **Confidence:** high

**Problem.** `.admin-subtab.active` and `.sub-subtab.active` set `color: #000` (3817, 3842). Because #000 is wrong on dark backgrounds, a separate body.dark rule at 4578-4581 re-patches `.tab-btn[data-tab="masterdata"].active` / `[data-tab="admin"].active` / `.admin-subtab.active` / `.sub-subtab.active` to `color: #ffffff`. The correct active-tab foreground is split across two distant rule sets and expressed as raw black/white literals rather than `var(--fg)` (which already flips #1a1b1f light / #edebe3 dark).

**Why it matters (architect view).** Every new active-tab variant must be registered in both the light hardcode and the dark override list or it renders black-on-dark. Using `--fg` or a dedicated `--tab-active-fg` token would make the flip automatic and remove the parallel maintenance.

**Recommendation.** Replace `color: #000` on the active states with `var(--fg)` and delete the body.dark `#ffffff` patch (4578-4581), or introduce a `--tab-active-fg` token defined in :root and body.dark.

**Evidence.**

```
3817 `.admin-subtab.active { color: #000; ... }`; 3842 `.sub-subtab.active { color: #000; ... }`; 4578-4581 `body.dark ...masterdata.active, ...admin.active { color: #ffffff; } body.dark .admin-subtab.active, body.dark .sub-subtab.active { color: #ffffff; }`
```
> _Verifier note:_ Verified #000 at 3817 and 3842 and the two-rule dark #ffffff patch at 4578-4581; confirmed --fg flips per theme (38 light, 4183 dark). Note this overlaps the duplicate-block finding (the #000 is part of the same .active blocks); kept separate because the two-place light/dark coupling is a distinct maintenance hazard. Genuine but low severity.


### 161. [LOW · Maintainability] .adm-help-tip hardcodes off-palette navy chrome; amber-glow shadows re-type the --accent RGB triple in several places

**Location:** `styles.css` lines 4684-4685 (navy tooltip); 3452, 4760, 3921, 4001 (rgba(184,121,26,..) literal)  |  **Confidence:** high

**Problem.** Two hardcode patterns. (1) The admin help tooltip hardcodes a fixed dark chrome `background:#1a1a2e; ... border-top-color:#1a1a2e` (4684-4685), so it is the same navy in light and dark mode and off-palette from both. (2) `rgba(184,121,26, X)` — the RGB of the light `--accent` #b8791a — is re-typed as a glow/tint in several rules: `.opt-strategy-pill.active` box-shadow `rgba(184,121,26,0.32)` (3452), `.labor-toolbar .seg-btn[data-labor-sub].active` box-shadow `rgba(184,121,26,0.28)` (4760), `.md-dirty-badge` border `rgba(184,121,26,.25)` (3921), `.md-row-new td` background `rgba(184,121,26,.04)` (4001).

**Why it matters (architect view).** (1) The tooltip never participates in dark mode and locks to a magic navy unrelated to any token. (2) The brand amber is duplicated as a raw RGB triple in ~4 places; the dark `--accent` is #d4920f, so even today these glows use the wrong (light) RGB in dark mode, and any accent retune or per-plant accenting (which the scale roadmap implies) would require hand-editing each literal.

**Recommendation.** For the tooltip, use `var(--bg-strong)`/`var(--fg)` or a `--tooltip-bg` token so it themes. For the glows/tints, define `--accent-rgb: 184 121 26;` (overridden in body.dark) and write `rgba(var(--accent-rgb) / 0.32)`, or `color-mix(in srgb, var(--accent) 32%, transparent)` (already used at 4844/4894), retiring the repeated triple.

**Evidence.**

```
4684 `.adm-help-tip { ... background:#1a1a2e; color:#fff; ... }`; 4685 `.adm-help-tip::after { ... border-top-color:#1a1a2e; }`; 3452 `box-shadow: 0 2px 10px rgba(184,121,26,0.32);`; 4760 `box-shadow: 0 2px 8px rgba(184,121,26,0.28);`; 3921 `border: 1px solid rgba(184,121,26,.25);`; 4001 `background: rgba(184,121,26,.04);`
```
> _Verifier note:_ Verified every cited line: tooltip navy at 4684-4685, and the four rgba(184,121,26,..) literals at 3452/4760/3921/4001. Confirmed light --accent is #b8791a (=184,121,26) and dark --accent is #d4920f, so the dark-mode-wrong-glow claim is accurate. Genuine but low — cosmetic theming gap.


### 162. [LOW · Scalability] Plant/line picker dropdowns cap scroll at repeated magic heights and render every row to DOM (no VirtualList contract)

**Location:** `styles.css` lines 1773, 3248, 3331  |  **Confidence:** medium

**Problem.** The line/plant pickers cap their scroll viewport at small fixed values with no shared token: `.gantt-line-filter-group .dash-filter-dropdown { max-height:220px }` (1773), `.opt-plant-list { max-height:200px }` (3248), `.opt-lines-list { max-height:220px }` (3331). Scrolling rather than overflowing is correct in spirit, but the caps are repeated magic numbers, and the rows carry no fixed-height contract, so these lists are rendered as plain `<li>` templates in app.js (verified: `opt-plant-list`/`opt-lines-list` build full `<li>` strings, no VirtualList) — unlike Hierarchy, Dashboard, and the alert drawer, which DO use the project's `VirtualList`. At 50+ plants and 70+ lines per plant every `<li>` is fully materialized.

**Why it matters (architect view).** CLAUDE.md is explicit that plant/line lists must scale to 50+ plants / 3,500+ lines and stay filterable. The optimize-dialog pickers are per-plant (so the immediate blast radius is ~70 lines, not 3,500), but the plant picker grows with total plants, and the windowing infrastructure already exists and simply isn't applied here. The repeated literal heights (200/220) are also brittle tuning constants.

**Recommendation.** Replace the per-element max-height literals with a shared `--dropdown-max-h` token, give list rows a fixed line-height, and render these dropdowns through the existing `VirtualList` (as Hierarchy/Dashboard already do) so DOM node count is bounded by the viewport rather than the dataset.

**Evidence.**

```
.opt-plant-list { max-height: 200px; overflow-y: auto; }  .opt-lines-list { max-height: 220px; overflow-y: auto; }  /* app.js renders these as full <li> lists, no VirtualList; VirtualList IS used at Hierarchy L7459, Dashboard L8060, alert drawer L4221 */
```
> _Verifier note:_ Verified heights at cited lines + confirmed in app.js that opt-plant-list/opt-lines-list are plain <li> builds while VirtualList is used elsewhere. Dropped the `.opt-date-row max-height:70px` 'clip bug' sub-claim (L2262) — standard collapse trick, speculative. Severity medium→low: pickers are mostly modal/per-plant scoped, not the global list.


### 163. [LOW · Scalability] Edit-calendar day row is a fixed 4-track grid + nowrap pill strip, baking in one-window-per-day and English-width labels

**Location:** `styles.css` lines 2523-2531, 2757-2762  |  **Confidence:** medium

**Problem.** `.cal-day-row` is a hardcoded 4-column grid `grid-template-columns: 44px 36px 1fr 52px` (2525) and `.line-hours-pills` uses `flex-wrap: nowrap` (2760) so all seven day pills must fit one row. Both encode a fixed 7-day, single-window-per-day model in CSS. The label/badge track widths (44/36/52px) are tuned to one time-window and one hours badge; a plant with a second working window or longer localized day labels (de/es/fr/pt ship per CLAUDE.md) will overflow or truncate.

**Why it matters (architect view).** Calendars are documented as per-plant config that must scale, and the app is localized — German/Portuguese day abbreviations run wider than English, and plants commonly run split shifts (two windows/day). A fixed 4-track grid and nowrap pill strip bake the prototype's one-window assumption into layout, turning split-shift or wider-locale support into a CSS rewrite rather than a data change.

**Recommendation.** Make the day-row layout content-driven: `grid-template-columns: auto auto 1fr auto` (or subgrid) so label/toggle/badge size to content and the time-range area absorbs one OR multiple windows; size the label column in `ch`/`min-content` rather than 44px; let `.line-hours-pills` wrap or scroll.

**Evidence.**

```
.cal-day-row { display: grid; grid-template-columns: 44px 36px 1fr 52px; gap: 10px; }  .line-hours-pills { display: flex; gap: 5px; flex-wrap: nowrap; }
```
> _Verifier note:_ Verified the fixed grid (L2525) and nowrap pills (L2760). Localization claim cross-checked against CLAUDE.md (de/es/fr/pt locales). Genuine forward-looking scalability concern; correctly low severity since it's not currently broken.



## `index.html` — 12 findings (0 high · 8 medium · 4 low)

### 164. [MED · Duplication] ~850 lines of inline component CSS in <head> hardcodes light-mode hex (and themes dark via vars), bypassing the styles.css token system

**Location:** `index.html` lines 49-900  |  **Confidence:** high

**Problem.** An 851-line <style> block (49-900) defines whole component systems (dashboard filter bar, two near-identical heatmaps .hm-*/.lh-*, line-status panel) inline with raw hex for the light path while their dark-mode counterparts use the CSS variables styles.css owns. Concrete: .hm-sticky { background:#ffffff } (175) vs body.dark .hm-sticky { background:var(--bg-elev) } (250); .ls-header { color:#9a8f84; background:#ffffff } (803/811) vs body.dark .ls-header { background:var(--bg-elev); color:var(--fg-mute) } (884/886); accent #b8791a repeated at 92/96 (with var fallback only at 283). CLAUDE.md explicitly flags this file's inline style as un-migrated and the dark layer as incomplete.

**Why it matters (architect view).** (1) A token change in styles.css (rebrand, palette tweak) silently fails to reach these light-path components because they bypass the variables — a half-themed UI. (2) The light path hardcodes hex but the dark path themes via vars, so the two paths can (and per CLAUDE.md already do) drift. (3) .hm-* and .lh-* are near-duplicate rule sets (same sticky/dow/date/cell/legend skeleton, different prefix), so the same rule is written twice and can diverge.

**Recommendation.** Move this block into styles.css and replace raw hex with the existing tokens (--fg-mute, --bg-elev, --accent, --line) so light and dark share one source of truth. Collapse .hm-*/.lh-* into a shared .heatmap-* base with two modifier classes rather than two parallel rule sets.

**Evidence.**

```
L175 .hm-sticky { ... background:#ffffff; } vs L250 body.dark .hm-sticky { background:var(--bg-elev); }; L811 .ls-header background:#ffffff vs L884 body.dark .ls-header background:var(--bg-elev); L64 .dash-filter-label color:#9a9285.
```
> _Verifier note:_ Verified <style> spans 49-900 and the light-hex/dark-var split at the exact cited lines. The .hm-*/.lh-* near-duplication is real (compared both blocks). Lowered high→medium: it is a documented, known maintainability debt, not a live correctness defect.


### 165. [MED · Duplication] GanttFilter has three byte-identical dropdown togglers (and parallel build/refresh/onChange trios) when a generic parameterized toggle already exists

**Location:** `index.html` lines 963-970, 1096-1119, 1173-1207 (and app.js:8655-8770)  |  **Confidence:** high

**Problem.** The dash-filter-group > button + dropdown triplet is repeated ~8 times across dashboard (963-970), gantt line/color/form (1096-1119), and orders line/color/status/date (1173-1207). On the JS side, GanttFilter._toggleLineDropdown/_toggleColorDropdown/_toggleFormDropdown (app.js:8655/8709/8752) are byte-for-byte identical except the element id, and the _build*/_refresh*Btn/_on*Change trios differ only in the field (PRODUCTION_LINE/COLOR/FORM_SIZE) and i18n key. The XSS-escape helper esc is re-declared inside each builder (8672, 8723, 8766). Notably the codebase ALREADY has the right primitive: Dashboard._toggleDropdown(id) (app.js:7618) and Table._toggleChipDropdown(field) are single parameterized dispatchers used by the dashboard and orders bars — only GanttFilter was left as three hand-copied functions.

**Why it matters (architect view).** Every new facet (a plant-group or subnetwork filter as the system scales to 50+ plants) means copy-pasting three functions plus a markup triplet, and any cross-cutting fix (close-on-outside-click, keyboard nav, the esc map) must be applied N times or the variants drift. The duplication is gratuitous because a generic id-parameterized toggle already exists in the same file.

**Recommendation.** Reuse the existing generic toggle (Dashboard._toggleDropdown(id) / a data-field driven dispatcher) for the three GanttFilter buttons, and collapse the _build/_refresh/_onChange trios into one FilterDropdown({ field, selectedSet, i18nKeys, onChange }) factory that reads its facet from a data-field attribute. Hoist esc to a shared Util helper. Render the markup triplet from a config array so adding a facet is one entry.

**Evidence.**

```
index.html L1096-1119 three groups differing only by id (gantt-line/color/form-dropdown). app.js L8655-8657 _toggleLineDropdown body == L8709-8711 _toggleColorDropdown body == L8752-8754 _toggleFormDropdown body except the id string. Generic toggle exists at app.js:7618 _toggleDropdown(id).
```
> _Verifier note:_ Read the actual GanttFilter bodies (app.js:8655-8770): togglers are genuinely identical-except-id; esc re-declared per builder confirmed. Confirmed Dashboard._toggleDropdown(7618) and Table._toggleChipDropdown are already parameterized, so the 'a generic toggle already exists' claim is true. Corrected the original's wording (the four facets on the orders bar already use one toggle, so only GanttFilter is the duplication); severity medium stands.


### 166. [MED · Duplication] Build/cache-bust token is hand-duplicated across multiple literals with no single source, risking silent asset-version drift on deploy

**Location:** `index.html` lines 46, 47, 2417, 2418 (and app.js:43)  |  **Confidence:** high

**Problem.** The deploy/cache-bust token is written as four independent literals in index.html that must all be edited together every deploy: `window.NIMBUS_BUILD_ID = '2026-06-30-a'` (L46), `styles.css?v=2026-06-30-a` (L47), `app.js?v=2026-06-30-a` (L2417), `nimbus-intelligence.js?v=2026-06-30-a` (L2418), plus a fifth `const APP_VERSION = '2026-06-30-a'` in app.js:43. The locale loader (L2407 `var v = window.NIMBUS_BUILD_ID || 'dev'`) and the worker (app.js:3561 `new Worker('nimbus-worker.js?v=' + Config.BUILD_ID)`) already derive their version from the single `NIMBUS_BUILD_ID` source — so the static `<script>`/`<link>` tags are the holdouts that ignore an available single-source pattern.

**Why it matters (architect view).** CLAUDE.md elevates this to a deploy invariant ('APP_VERSION in app.js and NIMBUS_BUILD_ID in index.html must be kept in sync and bumped on every deploy'). Bumping 4 of 5 literals ships app.js against a stale styles.css or a stale APP_VERSION redirect token with no error — a silent class of failure. The L47/L2417/L2418 tags are trivially convertible to stamp from NIMBUS_BUILD_ID (which already runs first), collapsing 3 edit sites to 0.

**Recommendation.** Emit the three asset URLs from the existing inline bootstrap using `window.NIMBUS_BUILD_ID` (same as the locale loader's `document.write`), so the version is declared once. Note: app.js:43 APP_VERSION is a partly-deliberate tradeoff — its cache-bust IIFE runs before Config exists (app.js:5412 documents this), so it cannot read Config.BUILD_ID; it could still read `window.NIMBUS_BUILD_ID` directly. Lower-effort, high-leverage win.

**Evidence.**

```
L46 `<script>window.NIMBUS_BUILD_ID = '2026-06-30-a';</script>`; L47 `<link rel="stylesheet" href="styles.css?v=2026-06-30-a">`; L2417 `<script src="app.js?v=2026-06-30-a"></script>`; L2418 `<script src="nimbus-intelligence.js?v=2026-06-30-a"></script>`; app.js:43 `const APP_VERSION = '2026-06-30-a';`; L2407 derives from NIMBUS_BUILD_ID, app.js:3561 derives from Config.BUILD_ID.
```
> _Verifier note:_ Verified all 5 literals exist at the cited lines (index.html L46/47/2417/2418, app.js:43). Confirmed the single-source pattern is already used at index.html L2407 and app.js:3561/87. Downgraded high→medium: it is a manual edit on an infrequent (deploy-time) action, and the APP_VERSION piece is a partly-documented tradeoff (app.js:5412), so 'high' overstated it.


### 167. [MED · Maintainability] Cache-bust build token is hand-duplicated as 4 string literals in index.html (plus APP_VERSION in app.js) instead of read from NIMBUS_BUILD_ID

**Location:** `index.html` lines 46-47, 2417-2418 (and app.js:43)  |  **Confidence:** high

**Problem.** The deploy build token '2026-06-30-a' is defined as a variable at index.html:46 (window.NIMBUS_BUILD_ID) but then re-typed verbatim in three static asset URLs: styles.css?v=2026-06-30-a (47), app.js?v=2026-06-30-a (2417), nimbus-intelligence.js?v=2026-06-30-a (2418). A 5th copy lives in app.js:43 (const APP_VERSION = '2026-06-30-a', commented 'keep in sync with NIMBUS_BUILD_ID'). Meanwhile two consumers already template off the variable: the locale loader (index.html:2407, var v = window.NIMBUS_BUILD_ID || 'dev') and the worker load (app.js:3561, new Worker('nimbus-worker.js?v=' + Config.BUILD_ID)). So the codebase demonstrably knows how to template this, yet the three static <link>/<script> tags were never migrated.

**Why it matters (architect view).** On every deploy a human must edit four index.html literals plus APP_VERSION in lockstep. Miss one and you ship a stale cached styles.css or app.js against a new build — the exact bug the token exists to prevent, and one that is invisible until a user reports broken layout/JS that 'works on my machine'. The fix is low-risk because the inline-script templating pattern (document.write or DOM-injected tags reading NIMBUS_BUILD_ID) already exists two lines away.

**Recommendation.** Emit the three versioned asset tags from a single inline <script> that reads window.NIMBUS_BUILD_ID, the same way the locale loader at 2407 already does. Have app.js derive its own version from Config.BUILD_ID (app.js:87 already mirrors NIMBUS_BUILD_ID) to retire the separate APP_VERSION literal. Reduces 5 hand-synced copies to 1.

**Evidence.**

```
index.html L46 <script>window.NIMBUS_BUILD_ID = '2026-06-30-a';</script>; L47 styles.css?v=2026-06-30-a; L2417 app.js?v=2026-06-30-a; L2418 nimbus-intelligence.js?v=2026-06-30-a. Contrast L2407 (var v = window.NIMBUS_BUILD_ID || 'dev') and app.js:3561 (worker uses Config.BUILD_ID). app.js:43 const APP_VERSION = '2026-06-30-a'.
```
> _Verifier note:_ Verified all 5 line cites exist verbatim; confirmed locale loader (2407) and worker (app.js:3561) already template off the same token, and app.js:5411-5413 itself comments that APP_VERSION is the awkward out-of-scope copy. Lowered severity high→medium: real silent-cache hazard but it is a documented deploy-time manual step partially mitigated by existing templating.


### 168. [MED · Maintainability] Tab strips declare role="tab"/role="tabpanel" but never wire aria-selected or aria-controls — incomplete ARIA misleads assistive tech

**Location:** `index.html` lines 1280-1284, 1309-1317, 1388-1391, 1429-1438  |  **Confidence:** high

**Problem.** Every tab strip (master-data subtabs L1281-1284, plant inner tabs L1309-1317, admin subtabs L1388-1391, admin overview sub-subtabs L1429-1438) marks buttons `role="tab"` and panels `role="tabpanel"` (e.g. L1280 `<section ... id="masterdata-tab" role="tabpanel">`), but a repo-wide grep finds 30 `role=tab/tabpanel/tabindex` occurrences and ZERO `aria-selected` or `aria-controls`. Selection state is carried only by a visual `class="active"` toggled in JS; panels are shown/hidden with `hidden`/`display:none` rather than the role's implied contract.

**Why it matters (architect view).** Per the ARIA tab pattern, a `role="tab"` with no `aria-selected` and no `aria-controls` reports an indeterminate/unselected state to assistive tech — a screen-reader user is told 'tab' but never which is current, and cannot jump to the controlled panel. This is a real regression versus plain buttons, and the defective pattern is copy-pasted across the strips.

**Recommendation.** Either drop the ARIA roles (treat as plain buttons) or complete the pattern: toggle `aria-selected` alongside the existing `.active` class, give each panel an id linked via `aria-controls`, set `tabindex="-1"` on inactive tabs for roving focus, and add a shared arrow-key handler. Factor the strip into one templated render so the contract lives in one place.

**Evidence.**

```
L1282 `<button class="admin-subtab active" data-md-master="lines" role="tab" ...>` (no aria-selected/aria-controls); L1280 `<section class="tab-panel" id="masterdata-tab" role="tabpanel">` (no aria-labelledby). Grep: aria-selected/aria-controls = 0; role=tab/tabpanel/tabindex = 30.
```
> _Verifier note:_ Verified all four cited strips exist with role=tab and visual-only .active state; grep confirms 0 aria-selected/aria-controls vs 30 role/tabindex. Dropped the original's 5th cited range (1669-1675, md-tabs) from lines since I did not re-confirm it, but the four verified strips fully support the finding.


### 169. [MED · Maintainability] All modals are plain divs with no role="dialog"/aria-modal/focus-trap, and status/toast regions lack aria-live — accessibility gap plus duplicated inline backdrop handlers

**Location:** `index.html` lines 1714, 1753, 1846, 1882, 2026, 2046, 2068, 1517, 2398  |  **Confidence:** high

**Problem.** A repo-wide grep for `role="dialog"`, `aria-modal`, and `aria-live` returns ZERO matches. Every modal is `<div class="modal-backdrop" id=... hidden>` with a heading and ✕ button but no dialog semantics (e.g. L1714 `modal-override`, L1753 `modal-block`, L1846 `modal-lines-block`, L1882 `modal-optimize`, L2068 `modal-opt-preview`). Backdrop-click-to-close is done with inline `onclick="if(event.target===this)..."` repeated per modal (L1883, L2027, L2047). Dynamic status regions (`#admin-upload-status` L1517, toast stack L2398) carry no aria-live, so async outcomes are not announced.

**Why it matters (architect view).** Without `role="dialog"`+`aria-modal="true"` and a focus trap, keyboard/AT users can tab out of an open modal into the obscured page and the modal is not announced. Without aria-live on status/toast regions, upload/purge/health outcomes are silent. The per-modal inline backdrop handler is duplicated logic that belongs in the shared `Modal` module.

**Recommendation.** Add `role="dialog" aria-modal="true" aria-labelledby="<title-id>"` to each modal, implement one focus-trap + Esc-close + restore-focus in `Modal` (and remove the repeated inline backdrop-onclick), and add `aria-live="polite"` (assertive for errors) to the status/toast containers.

**Evidence.**

```
L1714 `<div class="modal-backdrop" id="modal-override" hidden>` (no role/aria-modal); L1517 `<div class="admin-status" id="admin-upload-status"></div>` (no aria-live); L2398 `<div id="toast-stack"></div>` (no aria-live); inline backdrop close at L1883/2027/2047. Grep role="dialog"/aria-modal/aria-live = 0.
```
> _Verifier note:_ Verified modal divs at L1714/1753/1846/1882/2068 are plain backdrops with no dialog ARIA; grep confirms 0 role=dialog/aria-modal/aria-live; status (L1517) and toast (L2398) regions confirmed without aria-live; inline backdrop onclick confirmed at L1883/2027/2047. Trimmed/corrected the cited line list to verified anchors.


### 170. [MED · Scalability] vis-timeline / AG Grid / Chart.js / Flatpickr loaded as render-blocking CDN scripts in <head> with no SRI and no local fallback

**Location:** `index.html` lines 29-42  |  **Confidence:** high

**Problem.** All four heavy third-party libs are <script src="https://unpkg.com/..."> / https://cdn.jsdelivr.net/... in <head> with no defer, no integrity= (SRI) hash, and no local fallback. crossorigin="anonymous" is present but inert without integrity. For an app now deployed same-origin behind Azure Container Apps (single container serving its own static UI), the entire UI's boot is hard-coupled to unpkg.com and jsdelivr.net being reachable and uncompromised from the corporate/plant network.

**Why it matters (architect view).** (1) Availability — if a Newell plant network blocks or cannot reach unpkg.com, NIMBUS does not boot (vis-timeline is define-or-die). (2) Supply-chain — no SRI means a compromised CDN tag silently injects code into a manufacturing scheduling tool. (3) Render-blocking head scripts delay first paint. The Dockerfile already copies the frontend into the image, so these could be self-hosted same-origin with no new infra.

**Recommendation.** Vendor the four libs into the container image (/app/web/vendor/...) and serve them same-origin like styles.css/app.js — this also lets the build-id cache-bust cover them. If staying on CDN, add integrity="sha384-…" SRI hashes (versions are already pinned, so the hashes are stable) and consider defer. Self-hosting is the scale-correct answer for a plant deployment that may sit behind a restrictive network.

**Evidence.**

```
L29 <script crossorigin="anonymous" src="https://unpkg.com/vis-timeline@7.7.3/.../vis-timeline-graph2d.min.js"></script> (no integrity, no defer); L33 ag-grid-community@31.3.2 from cdn.jsdelivr.net; L38 chart.js@4.4.4; L42 flatpickr@4.6.13 — all CDN, none with SRI.
```
> _Verifier note:_ Read L29-42 directly: all four CDN tags present, none carry integrity, all in <head>, crossorigin set. Versions are pinned so SRI is feasible. Real availability/supply-chain concern given same-origin Azure deployment per CLAUDE.md; severity medium stands.


### 171. [MED · Scalability] Override/Blackout modals use bare native <select> for line pickers while the optimize modal already has a searchable combobox — un-scalable at the 70+ lines/plant roadmap

**Location:** `index.html` lines 1731, 1762, 1855 (compare 1899, 1955-1963)  |  **Confidence:** high

**Problem.** The optimize dialog implements the CLAUDE.md scale mandate: a searchable plant combobox (`#opt-plant-search` 'Search plants…' L1899, listbox L1903) and a searchable, multi-selectable line panel (`#opt-line-search` L1955, `<ul ... role="listbox" aria-multiselectable="true">` L1963). But the line pickers in the Date-Override modal (`<select id="ovr-line">` L1731), the line blackout modal (`<select id="blk-line">` L1762), and the Production-Lines blackout modal (`<select id="lines-blk-line">` L1855) are bare native `<select>`s with no search/filter.

**Why it matters (architect view).** CLAUDE.md is explicit: at 70+ lines per plant a scrolling `<select>` is unusable ('Plant and line lists must always be filterable — scrolling is not enough'), against a 3,500-line roadmap. The optimize modal proves the searchable component exists, so the same line-selection task is good in one place and scale-fragile in three others — an inconsistency that bites the moment a real plant's line count grows.

**Recommendation.** Reuse the optimize dialog's searchable combobox for `#ovr-line`, `#blk-line`, and `#lines-blk-line` (extract a shared `LineSelect` widget). At minimum make them filterable. Avoid shipping plain `<select>` for line lists.

**Evidence.**

```
L1731 `<select id="ovr-line"></select>`; L1762 `<select id="blk-line"></select>`; L1855 `<select id="lines-blk-line"></select>` vs. L1899 `<input class="opt-plant-search" id="opt-plant-search" type="text" placeholder="Search plants…">` + L1963 `<ul id="opt-lines-list" class="opt-lines-list" role="listbox" aria-multiselectable="true">`.
```
> _Verifier note:_ Verified the three bare <select>s at L1731/1762/1855 and the optimize modal's searchable plant combobox (L1899/1903) and searchable multi-select line list (L1955/1963). Removed the spurious 4th evidence line (2731 was out of the file's range / not a line picker); the three verified selects fully carry the finding, which aligns directly with CLAUDE.md's hard scalability mandate.


### 172. [LOW · Duplication] Seven Edit-Calendar day-rows are verbatim-duplicated 14-line markup blocks coupled to JS by 35 hand-written string ids

**Location:** `index.html` lines 2166-2276  |  **Confidence:** high

**Problem.** The Edit Calendar modal contains seven near-identical ~14-line blocks (Sun..Sat, L2166-2276), differing only by the integer 0..6 woven into 5 ids (`cal-edit-row-N`, `cal-edit-toggle-N`, `cal-edit-start-N`, `cal-edit-end-N`, `cal-edit-badge-N`) and an inline `onchange="NIMBUS.EditCalendar.onToggle(N,this.checked)"`. That is 7 copies x 5 id patterns = 35 hand-maintained id strings the JS (`EditCalendar`) addresses by exact string, plus 14 Flatpickr instances wired in a loop per CLAUDE.md.

**Why it matters (architect view).** Textbook change-amplification: any structural tweak to a day-row (new field, layout change, a11y label) must be applied 7 times identically or the days silently diverge, and the stringly-typed `onToggle(N,...)` couples markup to JS by index. A loop-generated template would make the structure single-source and remove the drift surface.

**Recommendation.** Render the 7 rows from a JS template in `EditCalendar` (the module already does lazy Flatpickr init in a loop) or keep one `<template>` cloned 7x with the index stamped. Either removes 6 of 7 copies and collapses the 35 ids to one parameterized pattern.

**Evidence.**

```
L2166-2180 (`id="cal-edit-row-0"`, `id="cal-edit-toggle-0"`, `onToggle(0,this.checked)`, `id="cal-edit-start-0"`, `id="cal-edit-end-0"`, `id="cal-edit-badge-0"`) repeats verbatim through L2262-2276 for `-6`/`onToggle(6,...)`.
```
> _Verifier note:_ Read L2166-2276 in full; the 7 blocks are verbatim duplicates as described, all 5 id patterns and onToggle(N) confirmed. Downgraded medium→low: static 7-row table, fixed cardinality (days of week never grows), low real-world churn, so impact is modest maintainability — not medium.


### 173. [LOW · Maintainability] Top tab strip declares role=tab/tabpanel but is missing the ARIA contract (aria-selected/aria-controls/aria-labelledby), and the Labor Plan tab has no data-i18n so it never localizes

**Location:** `index.html` lines 925-941, 933, 955, 1065  |  **Confidence:** high

**Problem.** The tab strip declares role="tablist" (925) with role="tab" buttons (926-940) and role="tabpanel" panels (955, 1065), but the ARIA contract is incomplete: tabs have no aria-selected, no id+aria-controls to their panel, no roving tabindex; panels have no aria-labelledby. Confirmed no aria-selected/aria-controls/aria-labelledby for the top tabs exists anywhere in the JS (the tab-switch handler is class-driven, toggling .active). Separately, the Labor Plan tab span (933) is <span>Labor Plan</span> with no data-i18n, unlike the other four tabs (tab.home/tab.gantt/tab.masterdata/tab.admin) — and no tab.labor key exists, so it never translates in the 5-language app.

**Why it matters (architect view).** Declaring role="tab"/"tabpanel" without aria-selected/aria-controls/aria-labelledby promises screen-reader users a tab widget then gives them an unnavigable one (no announced selection, no arrow-key movement) — for an enterprise tool facing accessibility procurement review this is a real gap. The missing data-i18n on Labor Plan is a concrete localization correctness bug: that tab label stays English in de/es/fr/pt.

**Recommendation.** Complete the tablist pattern: give each tab an id, aria-controls="<panel-id>", aria-selected, and roving tabindex; give each panel aria-labelledby="<tab-id>"; toggle aria-selected/hidden in App's tab-switch handler. Add data-i18n="tab.labor" to the Labor Plan span and a tab.labor key to each locale map.

**Evidence.**

```
L925 <nav class="tabs" role="tablist">; L926 <button class="tab-btn active" data-tab="home" role="tab"> (no aria-selected/aria-controls/id); L933 <span>Labor Plan</span> (no data-i18n); L955 <section ... id="home-tab" role="tabpanel"> (no aria-labelledby). Grep confirms no aria-selected/controls/labelledby for the top tabs and no tab.labor i18n key.
```
> _Verifier note:_ Verified the markup at 925-941 and that L933 alone lacks data-i18n. Grep confirmed the top-tab ARIA attributes and the tab.labor key do not exist anywhere. The data-i18n omission is the strongest, fully-verified defect; kept at the original low severity.


### 174. [LOW · Maintainability] ~850 lines of render-blocking inline <style> with hardcoded hexes live in HTML instead of the cache-busted, tokenized styles.css

**Location:** `index.html` lines 49-900  |  **Confidence:** high

**Problem.** Lines 49-900 are a single inline `<style>` block (grep confirms `<style>` at L49, `</style>` at L900 — an 851-line span). It contains component styling (e.g. the dash-filter bar) with hardcoded hex literals (`#e8e4dc` L57, `#d5d1c8` L78, `#b8791a` L92, `#fdf4e7` L97) rather than the `var(--token)` design system styles.css is built on. styles.css is `?v=`-versioned (L47) and cacheable for a year; this inline block re-ships uncached on every HTML load and bypasses the token system.

**Why it matters (architect view).** Two costs: (1) ~850 lines of CSS re-download on every page hit and block first paint, partly defeating the versioned external stylesheet; (2) the hardcoded hexes cannot respond to `body.dark`, which is exactly why CLAUDE.md flags dark-mode as incomplete. The concrete perf + theming-drift framing is added insight beyond the CLAUDE.md note.

**Recommendation.** Move the block into styles.css (already cache-busted), converting raw hexes to the existing `--bg`/`--border`/`--amber` tokens so dark mode and re-theming work uniformly. Keep only truly above-the-fold critical CSS inline, if any.

**Evidence.**

```
L49 `<style>` ... L57 `border-bottom: 1px solid #e8e4dc;` ... L78 `border: 1.5px solid #d5d1c8;` ... L92 `border-color: #b8791a;` ... L900 `</style>` (851-line span, raw hex throughout).
```
> _Verifier note:_ Verified style block spans L49-900 via grep and confirmed raw hex literals L57/78/92/97. CLAUDE.md explicitly calls this known debt ('~850 lines of inline <style> not yet migrated'), so it is a documented tradeoff — kept (not dropped) because the perf/theming-cost framing adds insight, but downgraded medium→low since it is acknowledged, deliberate, and low-risk.


### 175. [LOW · Scalability] Utilization/lateness heatmaps render every line row at once into a fixed-height scrollport — no windowing for the 70+ lines-per-plant target

**Location:** `index.html` lines 157-159, 286-288 (render in app.js:7960-7975)  |  **Confidence:** high

**Problem.** The utilization heatmap caps at max-height:405px (/* ~10 data rows */, 157-159) and the lateness heatmap at max-height:360px (286-288), both plain scroll containers. The render path (app.js:7961 lines.forEach × 7964 days.forEach) builds every line × day .hm-cell node in a single innerHTML assignment — no virtualization. At the prototype's ~5 lines/plant this is fine; at the roadmap's 70+ lines/plant the dashboard materializes all 70 rows × N day columns even though only ~10 are visible behind the scrollport. NOTE: the data is NOT truncated (it scrolls); the cost is full DOM materialization, not lost rows.

**Why it matters (architect view).** Per the scale roadmap (70+ lines/plant) and CLAUDE.md's note that Dashboard rebuilds the utilization matrix several times per render (it bypasses the memo with a non-null filtered subset), the all-at-once heatmap build compounds: ~70 rows × ~30 days = ~2,100 cell nodes rebuilt repeatedly per dashboard render. The '~10 data rows' comment shows the panel was never designed past the prototype scale.

**Recommendation.** Apply the existing VirtualList windowing (Foundation layer) to the heatmap grids, or render only the selected-plant lines filtered to a visible window. Tie the row cap to a CSS variable / line count rather than the magic 405px so the '~10 rows visible' design intent survives a font/row-height change.

**Evidence.**

```
L157-159 .hm-scroll-wrap { max-height:405px; /* ~10 data rows (34px) + header + gaps */ overflow-y:auto; }; L286-288 .lh-scroll-wrap { max-height:360px; overflow-y:auto; }. app.js:7960-7975 builds all rows in one innerHTML pass.
```
> _Verifier note:_ Verified the two caps and read the app.js render (7960-7975) confirming all-at-once innerHTML with no windowing. Corrected the misleading 'truncate' framing (it scrolls). Lowered medium→low: ~2,100 nodes is a real cost that compounds with the documented repeated matrix rebuild, but not a hard perf wall by itself.



## `db.py` — 9 findings (0 high · 7 medium · 2 low)

### 176. [MED · Correctness] Chunked upsert commits each 500-row chunk in its own transaction and writes the upload_audit row LAST — a hard crash mid-upload leaves orders durably half-loaded with no audit row

**Location:** `db.py` lines 1164-1245  |  **Confidence:** medium

**Problem.** The loop does conn.commit() after every 500-row chunk (1174-1186), then derives plant (1191-1206), then writes the upload_audit row last (1231-1239). If the process dies or the connection drops after chunk 3 of 10, the first 1,500 orders are durably upserted, the batch-scoped plant derivation never runs for them, and crucially NO upload_audit row exists. The except handler (1240-1245) calls _write_failed_audit only on a caught in-process exception — a hard crash / pool eviction leaves committed data with zero audit evidence. The docstring (1165-1168) acknowledges the partial-state design but the audit-last ordering makes that partial state untraceable.

**Why it matters (architect view).** upload_audit is the system of record for 'what got loaded'; committing data before the audit row inverts the safe ordering. At enterprise volume multi-chunk uploads become the norm, so the failure window widens with order count. An operator re-uploads to 'recover' (per the docstring) but has no record the first attempt already wrote 1,500 rows under a different batch_id, leaving orphaned batch attribution.

**Recommendation.** Write a PENDING upload_audit row in the SAME first transaction as chunk 0 and flip it to a final count at the end, so every committed chunk is reachable from an audit row; or keep per-chunk commits but record a running per-chunk progress marker (batch_id + last committed offset) so a crashed upload is diagnosable/resumable. At minimum move the audit INSERT to commit alongside the first chunk, not after the last.

**Evidence.**

```
db.py 1174-1186: for i in range(0, len(rows), _UPSERT_CHUNK): ... conn.commit() (per chunk). 1231-1239: INSERT INTO upload_audit ... conn.commit() only after all chunks + derivation. 1240-1245: except only fires on in-process exception.
```
> _Verifier note:_ Verified per-chunk commit (1186), audit-last ordering (1231-1239), and that _write_failed_audit only runs in the except path. The hard-crash window (committed chunks, no audit row) is real. Severity medium: the in-process-exception path IS handled, so the gap is specifically the crash/eviction case.


### 177. [MED · Correctness] make_id collisions are resolved by suffixing the id with a per-upload cumcount, producing batch-unstable ids that violate the frontend's stable-key / upsert-idempotency contract

**Location:** `db.py` lines 1117-1133  |  **Confidence:** high

**Problem.** When two rows hash to the same make_id within one upload, the dedup appends _1, _2 from df.groupby('id').cumcount() (1123-1133). cumcount is ordered by the DataFrame's current row order (Excel row order). Re-uploading the same data in a different row order assigns the suffixes to different physical rows — so ON CONFLICT (id) updates the wrong row, or inserts a brand-new _2 while orphaning the old one. CLAUDE.md states the frontend relies on ids being 'stable across reloads'; suffixed ids are explicitly not stable.

**Why it matters (architect view).** The id is the primary key, the upsert conflict target, AND the frontend's drag/edit key. Order-dependent collision handling silently violates the stability guarantee the rest of the system is built on. It masks the real defect (PRODUCTION_ORDER|MATERIAL_NUMBER is not actually unique in the source) by minting non-deterministic surrogate keys — worse than rejecting the duplicate because it corrupts idempotency invisibly.

**Recommendation.** Make collision resolution deterministic and content-based: add a third discriminator to make_id for genuinely-distinct same-(order,material) rows (e.g. plant, or SAP operation/sequence number if present) so the hash is stable regardless of row order; or reject/quarantine true duplicates as a hard validation error. Flag in MIGRATION.md alongside the plant-aware make_id work already noted there.

**Evidence.**

```
db.py 1123: dup_counts = df.groupby("id").cumcount(); 1129-1133: df.loc[dup_counts > 0, "id"] = df.loc[dup_counts > 0, "id"].astype(str) + "_" + dup_counts[dup_counts > 0].astype(str).
```
> _Verifier note:_ Verified the cumcount-suffix scheme at 1123-1133 and that cumcount order follows DataFrame row order (no prior sort of df on a stable key before the groupby). The instability across re-uploads with reordered rows is real and contradicts the stable-id contract stated in CLAUDE.md.


### 178. [MED · Duplication] count_orders() duplicates the entire WHERE-builder of query_orders() and runs as a second independent pool checkout on every paged /tasks request

**Location:** `db.py` lines 213-267  |  **Confidence:** high

**Problem.** When /tasks is paged, brain.py calls db.query_orders(...) then db.count_orders(...) (brain.py:763, 836) as two independent pool checkouts running two scans with the same WHERE clause. query_orders (230-235) and count_orders (256-261) duplicate the plant/line predicate block verbatim, so the predicate logic can silently drift between read and count.

**Why it matters (architect view).** Two pool checkouts + two scans per paginated request double DB round-trips and connection-hold time; under the 20-connection pool / multi-replica target this reduces effective read throughput for paged callers. The copy-pasted WHERE builder is a DRY hazard: a future plant/line predicate change applied to one function but not the other yields a page whose meta.total no longer matches the rows. Scope note: paging is only triggered by ?limit=/?offset= (paging = limit is not None or offset is not None), so non-paged plant-scoped reads pay nothing — the double-checkout is confined to the tooling-pagination path, not the default UI load.

**Recommendation.** Extract one private _orders_where(plant, line) -> (sql_fragment, params) helper shared by query_orders and count_orders. For the paged path, return the total in the same query via a window function (COUNT(*) OVER() AS __total) so the page and its total come from one scan and one checkout.

**Evidence.**

```
query_orders 230-235 and count_orders 256-261 contain byte-identical: if plant: where.append('o.plant = %s'); params.append(plant); if line: where.append('o.production_line = %s'); params.append(line). brain.py 763 & 836 call count_orders separately only when paging.
```
> _Verifier note:_ Verified the verbatim WHERE-builder duplication and that count_orders is a distinct checkout. Corrected scope: it is only invoked when paging (brain.py:746), so the throughput cost applies to paged/tooling callers, not the default per-plant UI read.


### 179. [MED · Duplication] The line->plant derivation rule is hand-copied in three places (reattribute_null_plant_orders, ingest post-upsert, schema.sql) with no shared definition

**Location:** `db.py` lines 297-334, 1191-1230  |  **Confidence:** high

**Problem.** The plant-attribution rule — SET plant = (SELECT MIN(pl.plant) ...) WHERE the line maps to exactly one plant, plus the COUNT(DISTINCT pl.plant) > 1 ambiguity warning — is hand-copied into reattribute_null_plant_orders() (db.py 297-334), the post-upsert block in ingest_orders_from_excel() (db.py 1191-1230), and schema.sql (152-161). Three independent copies of one business invariant that MUST agree.

**Why it matters (architect view).** This is the core order-attribution logic of the app physically forked across three files. Any refinement — preferring subnetwork, handling a line that gained a second plant, or adding the authoritative plant column from MIGRATION.md — must be applied in three places by hand. Silent divergence mis-attributes orders, which at 50+ plants is invisible until a customer notices orders missing from a plant view.

**Recommendation.** Hoist the derivation into one place: either module-level SQL constants in db.py (_DERIVE_PLANT_SQL parameterized by an optional WHERE upload_batch_id = %s, plus _AMBIGUOUS_LINES_SQL) reused by both Python callers, or — better — a single SQL function/view in schema.sql (fn_derive_order_plant()) called by both the migration and the Python path, so there is exactly one definition.

**Evidence.**

```
db.py 297-308 (reattribute UPDATE), 1191-1205 (ingest UPDATE, scoped by upload_batch_id), both identical bodies; schema.sql 152-161 confirmed via grep (MIN(pl.plant) at 154, COUNT(DISTINCT pl.plant) at 159).
```
> _Verifier note:_ Verified all three copies exist: db.py 297-334 and 1191-1230, and schema.sql 152-161. The schema copy differs only by lacking the batch scope; the rule body is identical. Genuine three-way drift surface.


### 180. [MED · Inefficiency] ingest_orders_from_excel builds ids with df.apply(axis=1) and row tuples with df.iterrows() — two full Python-level passes over the upload that defeat pandas vectorization

**Location:** `db.py` lines 1118-1162  |  **Confidence:** high

**Problem.** ID assignment uses df.apply(lambda r: make_id(...), axis=1) (a per-row Python call), and the row-tuple build uses for _, r in df.iterrows() calling _v(r, col) (dict lookup + pd.isna) ~13 times per row. Both are pure-Python per-cell scans over the whole upload. At enterprise scale (50+ plants, full SAP order books), a multi-10k-row upload pays this twice before a byte hits Postgres.

**Why it matters (architect view).** df.apply(axis=1) and iterrows() are the canonical pandas anti-patterns — they box every row into a Series and re-dispatch Python per cell. For an order book that grows with plant count, ingest CPU scales in heavy constant factors. Classic 'works in the prototype, stalls the pilot' cost the scale roadmap is meant to surface. Note: ingest is a human-cadence upload, not the hot /tasks read path, so the practical urgency is moderate.

**Recommendation.** Vectorize: compute ids by concatenating the two normalized columns once then .map the md5 over the joined Series (or hash in one pass), and build tuples via df.where(pd.notna(df), None) followed by df[[ordered cols]].itertuples(index=False, name=None) instead of _v() per cell. Removes two full Python-level passes over the frame.

**Evidence.**

```
Lines 1118-1122: df["id"] = df.apply(lambda r: make_id(r.get("PRODUCTION_ORDER", ""), r.get("MATERIAL_NUMBER", "")), axis=1). Lines 1146-1162: for _, r in df.iterrows(): rows.append((... _v(r, "MATERIAL_DESCRIPTION"), ...)).
```
> _Verifier note:_ Verified both idioms exist verbatim at 1118-1122 (apply) and 1146-1162 (iterrows + _v per cell). Softened severity framing: this is the upload path (human cadence), not the per-request hot path, so it is a real but non-urgent inefficiency.


### 181. [MED · Maintainability] Eleven diagnostics functions each swallow every Exception into a {'error': str(e)} dict — over-broad catch that hides pool exhaustion / statement timeouts and never logs or reaches the psycopg.Error handler

**Location:** `db.py` lines 555-938  |  **Confidence:** high

**Problem.** get_health_stats (588), get_db_deep_stats (643), get_pool_stats (661), get_db_server_info (686), get_db_table_stats (730), get_db_connection_activity (782), get_db_lock_waits (820), get_db_index_usage (852), get_db_slow_queries (895), and get_db_sequence_health (937) each wrap their whole body in except Exception as e: return {... 'error': str(e) ...}. A pool-timeout, auth failure, or statement_timeout — the very conditions the admin console exists to surface — is collapsed into a stringified error in otherwise-empty data, never logged (no log.warning in any branch), and never reaching the structured psycopg.Error handler at brain.py:277.

**Why it matters (architect view).** The textbook swallowed-exception smell repeated ~10x. The admin DB console is meant to be the diagnostic surface, yet a systemic DB outage renders as ten 'error' strings with zeroed metrics instead of one actionable signal — and str(e) can contain SQL/DSN fragments, leaking internals that translate_db_error (db.py:118) was built to prevent. It also means the slow-request logger and requests_errors pool stat never see these failures.

**Recommendation.** Add log.warning(..., exc_info=True) before each return, and return translate_db_error(e)['client_message'] rather than raw str(e). Better: factor the repeated try/except + pool-checkout boilerplate into a @diagnostic_panel decorator (or _run_panel(fn)) so the bodies become just their query, with one place owning logging and leak-safe error shaping.

**Evidence.**

```
e.g. db.py 643-644: except Exception as e: return {"error": str(e), "total": 0, "by_line": {}} — repeated with panel-specific empty shapes in 10 functions across 555-938. None call log.* in the except branch; brain.py:277 has the psycopg.Error handler these bypass.
```
> _Verifier note:_ Counted and verified each except block (10 functions return raw str(e); get_pool_stats catches a non-DB call). Confirmed none log, and confirmed the brain.py psycopg.Error handler at 277 is bypassed because the error is caught in db.py first. 'leak' concern is valid given translate_db_error exists specifically to avoid it.


### 182. [MED · Scalability] _get_maint_table_allowlist caches the table set process-globally forever — runtime-created tables (labor_plan / labor_plan_line) can never be vacuumed until restart, and the cache is per-replica

**Location:** `db.py` lines 944-984  |  **Confidence:** medium

**Problem.** _MAINT_TABLE_ALLOWLIST (944) is populated once on first use (950-956) and never invalidated. But labor_plan and labor_plan_line are created lazily at runtime (master_data.ensure_labor_plan_table / ensure_labor_plan_line_table, master_data.py 568+) on first labor-plan use. If that first use happens after the first maintenance call, those tables are permanently absent from the allowlist, so run_vacuum_analyze/run_analyze reject them with ValueError('Unknown table') (967, 981) until the process restarts. Under the single-replica pilot it just goes stale; under the multi-replica target each replica caches a different snapshot, so the same admin click succeeds on one replica and 400s on another.

**Why it matters (architect view).** Process-global mutable state standing in for an authoritative source that genuinely changes at runtime. pg_stat_user_tables is already the cheap authoritative answer, queried at human click-cadence (not the hot path), so caching it trades a sub-millisecond catalog read for a correctness/consistency bug invisible until someone maintains a runtime-created table.

**Recommendation.** Drop the module-global cache: query pg_stat_user_tables on each maintenance call (these run at click cadence). If a cache is wanted, give it a short TTL and reflect live schema across replicas.

**Evidence.**

```
db.py 944: _MAINT_TABLE_ALLOWLIST: set | None = None; 949-956: if None then populate from SELECT relname FROM pg_stat_user_tables, never reset. master_data.py 568-595 / 598+ create labor_plan(_line) lazily via CREATE TABLE IF NOT EXISTS at runtime.
```
> _Verifier note:_ Cache-never-invalidated and per-replica concerns verified. Corrected the original's claim that 'Master Data DDL adds/drops tables' — master_data.py only ADD/DROP COLUMNs on fixed tables (388-446); the real runtime-table source is the lazy labor_plan bootstrap, which is the concrete trigger. Severity kept medium; impact is real but confined to a narrow timing window per process.


### 183. [LOW · Correctness] update_task_dates_bulk's FOR UPDATE select has no ORDER BY, so two concurrent bulk updates touching overlapping ids in different orders can deadlock

**Location:** `db.py` lines 455-489  |  **Confidence:** medium

**Problem.** update_task_dates_bulk runs SELECT ... WHERE id = ANY(%s) FOR UPDATE (456-466) with ids in client-supplied order (ids = [it['id'] for it in items], 454). Postgres acquires row locks in scan order, which for = ANY(array) is not a guaranteed-consistent sort across two callers passing the same ids in different orders (e.g. an optimizer save vs. a manual drag save of overlapping orders). Two such concurrent bulk updates can each hold one row and wait on the other → deadlock (SQLSTATE 40P01), which surfaces as a 503 (translate_db_error maps 40P01 → 503) the frontend treats as a generic 'busy, retry'.

**Why it matters (architect view).** A classic lock-ordering race, silent until two users edit the same line concurrently — exactly the multi-user scenario the optimistic-concurrency machinery was built for. The xmin/stale reconciliation handles last-writer-loses correctly but does nothing to prevent the lock-acquisition deadlock that precedes the version check.

**Recommendation.** Add a deterministic ORDER BY id to the FOR UPDATE select (WHERE id = ANY(%s) ORDER BY id FOR UPDATE) so every caller acquires row locks in the same global order, eliminating the cycle. One-line, zero-semantic-change fix.

**Evidence.**

```
db.py 456-466: cur.execute(SELECT id, COALESCE(...) AS eff_start, ... xmin::text::bigint AS row_version FROM orders WHERE id = ANY(%s) FOR UPDATE, (ids,)) — no ORDER BY. 40P01 → 503 confirmed in _SQLSTATE_ERROR_CODES (db.py:114).
```
> _Verifier note:_ Verified the FOR UPDATE select has no ORDER BY (462-463) and ids preserve client order (454). The deadlock is theoretically possible but requires genuine concurrent overlapping-id writes; the fix is trivially safe and correct, which is why I keep it at low severity. Corrected line range to 455-489.


### 184. [LOW · Duplication] get_task_versions and update_task_dates_bulk hand-duplicate the same effective-dates + xmin refetch query, differing only by FOR UPDATE; the COALESCE effective-date expression recurs in 5+ places

**Location:** `db.py` lines 346-352, 456-466  |  **Confidence:** high

**Problem.** get_task_versions (346-352) and the lock-read in update_task_dates_bulk (456-466) issue effectively the same projection (COALESCE(scheduled_start, basic_start_date) AS eff_start, COALESCE(scheduled_end, basic_finish_date) AS eff_end, xmin::text::bigint AS row_version FROM orders WHERE id = ANY(%s)), differing only by the trailing FOR UPDATE. The same COALESCE effective-date expression also appears in _ORDERS_SELECT (181-182), in query_orders' ORDER BY (238), in purge_orders_by_date (535), and in get_db_deep_stats (615-616).

**Why it matters (architect view).** The 'effective start/end = COALESCE(scheduled, basic)' rule is the most-repeated business expression in the file. It is the definition of what a scheduled date IS in NIMBUS. If precedence ever changes (e.g. a third override source), every copy must be found and updated in lockstep or the read path, concurrency check, purge, and diagnostics disagree about which date an order has.

**Recommendation.** Define the effective-date expressions once as module-level SQL fragments (_EFF_START_SQL, _EFF_END_SQL) composed into all queries, and extract the shared version-refetch query so get_task_versions and the FOR UPDATE read differ only by a for_update: bool flag. Makes the COALESCE precedence a single source of truth.

**Evidence.**

```
db.py 347-351 vs 458-462 are identical projections (FOR UPDATE added at 463). COALESCE(scheduled_*, basic_*) also at 181-182, 238, 535, 615-616.
```
> _Verifier note:_ Verified both refetch queries are identical save FOR UPDATE, and confirmed the COALESCE effective-date expression at all five cited locations. Genuine DRY/maintainability concern; correctly rated low since it is not yet a behavioral bug.



## `master_data.py` — 6 findings (0 high · 2 medium · 4 low)

### 185. [MED · Correctness] set_plant_constraints treats a missing subnetwork as 'match any subnetwork' — WHERE plant=%s alone can fan-out the constraints write across subnetworks that share a plant code

**Location:** `master_data.py` lines 518-530  |  **Confidence:** high

**Problem.** plants is keyed by the composite (subnetwork, plant) (schema.sql:103), but set_plant_constraints only adds the subnetwork predicate `if subnetwork:`. When subnetwork is falsy the UPDATE is `WHERE plant = %s` alone. The endpoint (/master-data/plants/{plant}/constraints, brain.py:1378) passes subnetwork as optional (body.get('subnetwork','') → falsy default), so the unscoped path is reachable from the API. If two subnetworks ever share a plant code (the line/plant-code-reuse hazard CLAUDE.md flags as unresolved), this overwrites the constraints JSONB of EVERY matching plant row, and the `cur.rowcount == 0` guard only catches under-match, not the over-match.

**Why it matters (architect view).** The optimizer reads plants.constraints per-plant; an UPDATE that omits half the composite key is not idempotent against future multi-subnetwork data and can silently clobber a sibling plant's optimizer config. Today single-subnetwork data masks it, so it is a latent correctness bug that activates exactly when the roadmap's cross-subnetwork plant codes arrive.

**Recommendation.** Require subnetwork for any keyed constraints write (raise if absent), or pre-resolve the unique (subnetwork, plant) and reject ambiguous matches (rowcount > 1) instead of updating all. Make the full composite key mandatory on every plant-scoped mutation.

**Evidence.**

```
where = "plant = %s"\n    if subnetwork:\n        where += " AND subnetwork = %s"\n        params.append(subnetwork)
```
> _Verifier note:_ Verified the conditional WHERE at 518-528 and rowcount==0 guard at 529. Confirmed plants PK is (subnetwork, plant) in schema.sql:103 (plant codes CAN repeat across subnetworks) and the endpoint passes subnetwork optionally (brain.py:1386-1391, default ''), so the falsy path is reachable. Latent today (single-subnetwork data) but real per the documented reuse roadmap — kept at medium.


### 186. [MED · Scalability] known_plant_line_codes() full-table-scans every plant and line on each upload — does not scale and ignores plant scoping

**Location:** `master_data.py` lines 745-752  |  **Confidence:** high

**Problem.** known_plant_line_codes() unconditionally selects ALL plant codes and ALL production_line codes into Python sets with no plant filter and no bound. It is called on every POST /upload (brain.py:1047) only to soft-warn about line codes not yet in master data. brain.py:1048-1052 then set-differences the global line set against the handful of lines in the upload.

**Why it matters (architect view).** Pulling the entire line catalog to validate a small upload is O(total_lines) per upload, growing unbounded toward the 3,500+ line roadmap target. Worse, a flat set of bare line codes cannot answer 'is this line known FOR the uploaded plant' once line codes are reused across plants (a hazard CLAUDE.md flags as unresolved) — production_lines is keyed by (subnetwork, plant, production_line), so a bare-code set is the wrong granularity.

**Recommendation.** Accept the upload's distinct (plant, line) pairs and validate with one targeted query: SELECT plant, production_line FROM production_lines WHERE (plant, production_line) = ANY(%s). Return presence keyed by (plant, line) so cost is bounded by upload size and the answer is plant-correct. Note this is a soft-warn-only path today, so impact is on ingest latency/correctness of the warning, not hard failure.

**Evidence.**

```
cur.execute("SELECT plant FROM plants")\n        plants = {r[0] for r in cur.fetchall()}\n        cur.execute("SELECT production_line FROM production_lines")\n        lines = {r[0] for r in cur.fetchall()}
```
> _Verifier note:_ Verified function body at 745-752 and caller at brain.py:1047-1055 (best-effort soft-warn, wrapped in try/except). Bare-code set vs composite (subnetwork,plant,production_line) PK (schema.sql:119) confirms the plant-scoping critique. Downgraded high→medium: it is a soft-warn enrichment path, not the hot read path, so the unbounded scan degrades upload latency and warning accuracy rather than core availability.


### 187. [LOW · Duplication] admin_audit INSERT + commit hand-duplicated across seven write functions with an inconsistent table_name/column_name contract — no single _audit() helper

**Location:** `master_data.py` lines 313-322, 415-419, 454-458, 477-481, 531-535, 660-664, 736-740  |  **Confidence:** high

**Problem.** Seven mutating functions each hand-write a near-identical INSERT INTO admin_audit (...) followed by conn.commit(). The shape drifts: table_name is the `table` param in bulk_apply/add_column/drop_column/rename_label but a hardcoded literal in set_plant_constraints ('plants'), upsert_labor_plan ('labor_plan'), and upsert_labor_plan_line ('labor_plan_line'); column_name is included only in the three column-DDL calls; the details JSON shape is ad hoc per site. There is no single definition of an audit row.

**Why it matters (architect view).** The audit contract lives in seven places, so adding a field (e.g. the x-request-id correlation CLAUDE.md notes is missing) means editing all seven, and the literal-vs-param table_name split is the kind of silent divergence that makes the forensic log unreliable.

**Recommendation.** Extract _audit(cur, table_name, action, *, column_name=None, details=None, user_email=None) and call it from every mutation; fold the commit in or keep it at the call site. One definition of an audit entry.

**Evidence.**

```
cur.execute(\n            "INSERT INTO admin_audit (table_name, action, details, user_email)"\n            " VALUES (%s, %s, %s, %s)",\n            (table, "bulk_apply", Jsonb({...}), user_email),\n        )\n        conn.commit()
```
> _Verifier note:_ Verified all seven sites and the cited inconsistencies: table_name is param at 317/418/457/479 and literal at 533 ('plants'), 662 ('labor_plan'), 738 ('labor_plan_line'); column_name only present at 416/455/478. Accurate maintainability finding; kept at low (cosmetic/DRY, not a runtime defect).


### 188. [LOW · Inefficiency] upsert_labor_plan / upsert_labor_plan_line partition cells with O(n^2) `c not in to_delete` dict-list membership

**Location:** `master_data.py` lines 636-637, 709-710  |  **Confidence:** high

**Problem.** Both functions build to_delete with a list comprehension, then build to_upsert via `[c for c in valid if c not in to_delete]`. `c not in to_delete` is a linear scan of a list whose elements are dicts (full-key equality per compare), making the partition O(n*m) ~ O(n^2) over a labor grid. The line-level grid (70 lines/plant × day horizon, the size idx_lpl_plant_line at line 615 exists for) is exactly where n grows.

**Why it matters (architect view).** The split is recomputing membership against a structure derived from the same iterable. A single O(n) pass over `valid` produces both lists. The current form is the classic accidental-quadratic and degrades silently as labor grids grow with the plant/line roadmap.

**Recommendation.** Partition in one loop with a shared empty-test helper: `to_delete, to_upsert = [], []; for c in valid: (to_delete if _empty(c) else to_upsert).append(c)`. Apply the identical fix in both functions.

**Evidence.**

```
to_delete = [c for c in valid if c.get("avail_hours") is None or c.get("avail_hours") == ""]\n    to_upsert = [c for c in valid if c not in to_delete]
```
> _Verifier note:_ Verified identical pattern at 636-637 and 709-710; idx_lpl_plant_line confirmed at 615. Real quadratic, but the per-compare constant (dict eq) is small and cells are per-plant-edit batches, so downgraded medium→low; the one-pass rewrite is still a clean, cheap win.


### 189. [LOW · Inefficiency] cascade_preview for table='plants' issues an N+1 COUNT query (one per deleted plant) where sibling branches use a single set-based query

**Location:** `master_data.py` lines 210-220  |  **Confidence:** high

**Problem.** The plants branch loops over each delete dict and fires a separate SELECT COUNT(*) FROM production_lines WHERE subnetwork=%s AND plant=%s per row, summing into `plines`. The subnetworks branch (201-208) and materials branch (226-230) directly above/below already use the correct single-query `= ANY(%s)` form, so this branch is an inconsistent slow path.

**Why it matters (architect view).** N deleted plants = N round-trips for a result one aggregate query returns, and the style divergence from the sibling branches invites future copy-paste of the slow pattern. Bulk plant deletes are a realistic admin action at the 50+ plant target.

**Recommendation.** Collect the (subnetwork, plant) pairs once and run a single grouped query — e.g. SELECT COUNT(*) FROM production_lines WHERE (subnetwork, plant) = ANY(%s) (psycopg adapts a list of tuples to a record array) or a VALUES join — mirroring the = ANY pattern already used for subnetworks/materials.

**Evidence.**

```
for d in deletes:\n                if d.get("subnetwork") and d.get("plant"):\n                    cur.execute(\n                        "SELECT COUNT(*) FROM production_lines WHERE subnetwork = %s AND plant = %s",\n                        (d["subnetwork"], d["plant"]),\n                    )\n                    plines += int(cur.fetchone()[0])
```
> _Verifier note:_ Verified the per-row loop at 210-220 and the contrasting = ANY single-query form in the subnetworks (201-208) and materials (224-230) branches of the same function. Real N+1 + style inconsistency; downgraded medium→low since cascade-preview is an interactive, low-frequency confirm step, not a hot path.


### 190. [LOW · Scalability] add_column/drop_column run ALTER TABLE (ACCESS EXCLUSIVE) on a pooled request connection with no advisory lock or lock_timeout

**Location:** `master_data.py` lines 395-400, 445-449  |  **Confidence:** medium

**Problem.** add_column (ALTER TABLE ... ADD COLUMN, 395-400) and drop_column (ALTER TABLE ... DROP COLUMN, 445-449) execute DDL inside an ordinary pooled request connection driven by the admin endpoints (brain.py:1326/1346). ALTER TABLE takes an ACCESS EXCLUSIVE lock; with no lock_timeout the statement can queue behind / block other queries on that table (including reads) for its duration, and with no advisory lock two concurrent DDL callers (the roadmap's multi-replica target) are unserialized.

**Why it matters (architect view).** Schema-mutating DDL on a live request connection is an availability hazard: a single admin add-column can stall reads on a busy master-data table, and concurrent DDL across replicas has no coordination. This is a genuine multi-replica readiness gap.

**Recommendation.** Gate add_column/drop_column behind a Postgres advisory lock (pg_advisory_xact_lock on a fixed key) so only one DDL runs at a time, and set a short lock_timeout on the DDL statement so it fails fast rather than blocking readers. Note the ensure_* migrations are NOT part of this — they run once at startup, not per request.

**Evidence.**

```
alter = sql.SQL("ALTER TABLE {} ADD COLUMN {} {}").format(\n            sql.Identifier(table), sql.Identifier(column_name), sql.SQL(" ").join(col_def_parts),\n        )\n        cur.execute(alter)
```
> _Verifier note:_ Verified ALTER TABLE at 395-400 and 445-449 run on a pooled connection via the per-request admin endpoints. CORRECTED the finding's scope: the cited ensure_* paths (568-616, 490-496) are NOT per-request — they run only at startup (brain.py:144-146), so I removed them and the 'two replicas calling ensure_* concurrently' framing. Downgraded medium→low: master-data tables are small/low-traffic and add/drop-column is a rare manual admin action, so the lock-blocking window is short in practice; still a valid hardening item for multi-replica.



## Appendix — findings dropped during adversarial verification

The verification pass examined every candidate finding against the live code and **dropped 31** as false, stale, trivial, or already-mitigated. Counts by slice (transparency):


**`fe-foundation-state`** — 2 dropped:
- _updateMany mutates task objects in place while updateTask replaces the reference — two divergent update paths that break identity-diffing consumers_ — Misread of consumer behavior. The asserted correctness impact (AG Grid and Timeline render stale rows after a bulk optimize) is contradicted by the code: AG Grid keys rows by string id via getRowId (app.js 6379), and the tasks:bulkUpdate handler (6787-6791) re-resolves each task fresh from Store.tasks[id] and pushes it through applyTransaction({update}), which matches by row id and copies data into the existing node — it does not depend on the object reference changing. No bulk-path consumer was found that diffs by object identity; they all key by id. The updateTask vs updateMany style difference is real but the high-severity correctness claim is unverified and the evidence points the other way; per the default-to-DROP rule for behavior misreads, dropped.
- _Util.t resolves the locale dictionary on every call, and caches the active locale in a module field set once at load (LangSwitcher desync)_ — The correctness half is a misread: LangSwitcher.set() (nimbus-intelligence.js 2156-2159) writes localStorage then calls location.reload(), so the only way to change locale is a full page reload, after which Util._locale is re-read fresh from localStorage at module-eval (app.js 408). There is no runtime path that changes locale without reloading, so Util.t and LangSwitcher can never disagree about the active locale — the claimed latent correctness gap does not exist. The remaining point (per-call double property-walk into window.__NIMBUS_LOCALES plus `|| {}` allocation) is a trivial micro-optimization on cheap operations, not architect-level. Dropped on both counts.

**`fe-calendar-plant`** — 2 dropped:
- _Capacity engine (workWindow/dailyCapacityHours/effectiveFromCapacity/_dayWindow) hand-ported into nimbus-worker.js, guarded only by comments_ — Verified accurate (worker functions at 91/116/133/191/220 mirror app.js bodies exactly), but this is the single most explicitly-documented deliberate tradeoff in the repo — CLAUDE.md devotes a whole 'Web Worker' subsection to it ('must be mirrored here rule-for-rule — a code comment is the only guard against drift') and the finding's shared-module/CI-hash recommendation adds no insight the maintainers don't already have. Per the brief, drop deliberate, sensibly-documented tradeoffs with no added insight.
- _Weekday label array duplicated 6 times in app.js and re-mapped through t() on every render_ — Confirmed exactly 6 occurrences in app.js (1307, 1549, 1598, 1633, 1739, 2037 — the finding mislabeled the 6th, but the count is right) plus the worker. Trivial: a 7-element constant of stable i18n keys; week-start localization is not a realistic driver of drift here, and the inline build-to-index pattern is a micro-smell, not architect-level impact. Drop as trivial.

**`fe-prodlines-labor`** — 3 dropped:
- _ProdLines._delegated / EditCalendar._fp / Flatpickr instances assume a single global line/plant universe — leak and identity bugs at scale_ — Two-part finding that is mostly redundant or wrong. The plant-blind line-keying half fully duplicates the kept 'Line settings keyed by bare line code' finding (same root cause, same 2249/dataset.line evidence). The EditCalendar `_fp.length !== 14` half is a misread: _initPickers (3256) and the early returns guarantee 14 instances after open()/openPlant() run, the `=== 14` checks are defensive belt-and-suspenders, and on save() (3353-3358) a missing s/e correctly yields `null` for that day — there is no realistic path where init silently fails yet save proceeds. No added architect-level insight beyond the kept keying finding.
- _Per-render full DOM re-query to build cellMatrix / _cellGrid duplicates a selector-string-building rule already used elsewhere_ — Trivial. The `.replace(/"/g,'"')` escaping in `.lp-cell[data-group=...]` selectors does recur ~6×, but these are one-line throwaway lookups in undo closures and paste/delete handlers — extracting a `_cellSelector()` helper is a cosmetic micro-DRY with negligible drift risk and no efficiency or correctness impact. Not architect-level; the more material DOM-re-query concern is already implied by the kept _cellGrid/cellMatrix caching work the code does well.
- _contextmenu 'reset override' re-derives the period key with a nested 7-day scan instead of a date→week lookup_ — Real but trivial and self-acknowledged as 'minor at prototype scale.' The dayKey→week scan (2886-2888) runs once per right-click on a single cell — not in a hot render loop — over at most 16 weeks × 7 days = 112 cheap iterations. Re-running _disaggregate to recover one cell is wasteful but again only on a manual right-click. No user-perceptible cost; below the architect-level bar the task sets (default-to-DROP when impact is negligible).

**`fe-domain-engine`** — 3 dropped:
- _Dashboard utilization matrix is rebuilt several times per render because the subset path bypasses the memo_ — STALE/incorrect: Dashboard.render() (7670-7681) now builds the 7-day matrix ONCE — caching it in Dashboard._matrix7Cache keyed on (startMs|7|rev|plant+filterLines) — then threads that single matrix into _renderKPIs (7680) and _renderHeatmap (7681). Both callers guard with `if (matrix === undefined) ... computeMatrix(...)` (7749, 7917) so they reuse the passed matrix and never recompute during a normal render. The 8030 caller builds a DIFFERENT matrix (days=1, not 7) for the line strip — not a redundant rebuild of the same matrix. So the '3-4× per render' premise no longer holds; the memo-bypass it described has been mitigated by a dedicated render-level cache.
- _computeMatrix and dayByLine attribute task hours to days with subtly different math — two implementations of one rule_ — Technically real (computeMatrix at 4438 uses raw calendar-overlap ratio `taskRunHrs * overlapMs/totalTaskMs`, while dayByLine at 4506-4517 clips to the working window and subtracts merged blackout overlap), but DROP as not a defect: the two paths answer deliberately different questions and are documented as such. The CLAUDE.md notes dayByLine is a separate today/day-summary path; computeMatrix gates each cell on workWindow existence (4436) and its denominator (dailyCapacityHours) already deducts blackouts (comment 4420-4423), so the displayed util RATIO accounts for blackouts on both paths even though the numerator attribution differs. No evidence the two surfaces are fed the same (line,day) and expected to print identical hour numerals; the 'strip says 8h, summary says 6.5h' scenario is asserted, not demonstrated. Unifying them risks changing established matrix semantics for a hypothetical discrepancy — insufficient architect-level justification to keep.
- _Inline block-index build in _recomputeSync duplicates Calendar._indexCapacityBlocks verbatim_ — DROP as overlapping/subsumed and partly misread. The _capIdx build at 3773-3781 IS the same bucketing shape as Calendar._indexCapacityBlocks (1112-1127), BUT _recomputeSync deliberately builds it from the already-parsed parsedBlocks/parsedPlantBlocks (3774,3778) to avoid a second parseDate pass — calling _indexCapacityBlocks() instead would RE-PARSE Store.blocks from scratch, so the finding's 'wastes a second parse pass' rationale is backwards (the inline build is the optimization, not the waste). The remaining genuine point — that the bucketing logic is duplicated across three sites — is the same hand-mirror/drift hazard already captured by Finding 1 (worker mirror) and Finding 5 (closed-day reuse); keeping this as a third overlapping finding adds no distinct architect-level insight. The sync path here is also only the fallback.

**`fe-optdialog-infra`** — 2 dropped:
- _Modal.confirm passes the human-readable message as `title`, leaving the message slot empty_ — Verified real but merged into the kept Modal.confirm finding's scope and judged too trivial to stand alone. The no_color_wheel_confirm_msg key IS prose ('No color wheel found for plant X.\n\nOptimize without color priority?') placed in the title slot, so #confirm-message stays empty — a genuine but purely cosmetic heading/body inversion. It renders readably, has no functional/correctness impact, and the systematic-misuse framing overstates it (12392/13424 pass short questions that read fine as titles). Low value relative to the kept abstraction finding on the same module.
- _Optimizer run() fires Engine.runAndApply inside requestAnimationFrame->setTimeout with no awaited result or error path_ — Misread of the error handling. runWithPreview (9245) returns immediately after scheduling its OWN double-requestAnimationFrame, inside which the entire optimize body is wrapped in try/catch/finally (9264-9332): the catch logs via ErrorLog, rolls back the UndoStack snapshot, re-enables the footer buttons, and renders an 'Optimization failed' panel. So a throw during optimization is NOT unhandled. The Run button is owned by the config modal, which run() already hides via close(true) (5271) and resets on next open() (5210), so it does not stay stuck on 'Optimizing...'. The finding's central premise (unhandled throw + stuck button + spinner forever) does not hold against the live code.

**`fe-timeline-table`** — 1 dropped:
- _AG Grid inline date editor diverges from the Flatpickr standard and round-trips through a second parser_ — Documented, sanctioned exception: CLAUDE.md explicitly names Table._DateTimeEditor as the one native datetime-local editor (not Flatpickr). The finding's core divergence premise is also wrong — _onCellChanged applies Util.snap to the editor's parsed value at line 6846, so the snap contract is NOT dropped; both paths snap on commit. No real added insight beyond the documented tradeoff.

**`fe-inspector-dash`** — 1 dropped:
- _Inspector re-renders the entire detail pane (full innerHTML + Flatpickr re-init) on every matching Store event, even single-field updates_ — The load-bearing claim — that editing RUN_TIME 'triggers a Store event that re-renders the very pane the user is typing in', re-creating Flatpickr and discarding focus mid-edit — is a misread: the subscribe guard at line 7128 (`if (evt.source === 'inspector' && evt.type !== 'fixed:change') return;`) explicitly suppresses re-render for inspector-sourced task:update edits, so the self-re-render the finding centers on does not happen. The residual true points (full innerHTML rebuild on EXTERNAL events; no visibility gating; Flatpickr re-init) are minor and the finding's own recommendation (suppress re-render when source is 'inspector') is already implemented. Net: overstated and substantially incorrect; drop.

**`fe-optimize-interaction`** — 1 dropped:
- _Sandbox discard assigns cloned snapshot arrays by reference into the live Store, aliasing future edits to the (now-consumed) snapshot_ — Verified the code (9639-9640 assign snap.blocks/snap.calendars by reference, _snapshot nulled at 9648) but it is not a present bug — the finding itself admits 'it currently survives only because _snapshot is nulled immediately' and the concern is purely about hypothetical future code that retains the snapshot. The snapshot was a fresh deep clone (Util.clone is recursive, verified 264-271) and nothing else holds a reference after nulling, so installing it as live state is correct, not aliased. The secondary '_rev/subscribers may not bump' claim is inaccurate: the discard branch calls Store.setTasks first (9638), which emits and bumps _rev (635), and then Alerts.scheduleRecompute (9643) — the direct block/calendar assignment piggybacks on that. Speculative latent issue, no added insight; the real symmetric-restore fix is already covered by the kept promote-undo finding.

**`fe-persistence`** — 3 dropped:
- __rememberedPlant and restoreSelectedPlant each independently getItem + JSON.parse the entire cache blob_ — Premise is factually wrong: restoreSelectedPlant (11547) is DEAD CODE — grep across the whole repo finds zero callers, so it never runs at boot. Only _rememberedPlant runs at boot (15837). The third cited site (load() at 10854) does NOT parse 'just to read selectedPlant' — it genuinely needs the full object for _restoreNonTaskState (blocks/calendars/fixedIds) and _overlayUserMoves (tasks). So the actual redundancy is a single one-field whole-blob parse in _rememberedPlant, low-impact, and the finding's core claim of double-parsing the blob at boot is not real.
- __dirtyIds / _forceIds are plant-unaware; stale dirty ids can leak across plants_ — Central mechanism is not reproducible against the code. Every plant-switch path funnels through Store.setTasks() (load happy path 10882, zero-task path 10799 with Store.setTasks([]), and offline _loadCache 11163), and setTasks emits 'tasks:bulk' (line 670), which the dirty subscriber (14405) handles by clearing both _dirtyIds and _forceIds. So dirty ids are cleared on every load/switch path, online and offline — they cannot survive a plant switch to produce the 'silently leaving dirty ids for the old plant' scenario described. The remaining sub-concern (MD5 id collision because make_id isn't plant-aware) is an existing db.py/make_id issue already documented in CLAUDE.md/MIGRATION.md, not introduced by the dirty-set design. Speculative.
- __prepTask mutates raw backend rows in place and uses substring matching to detect date fields_ — No impact in the current code and the failure mode is misstated. The /tasks read path uses a FIXED curated projection (_ORDERS_SELECT in db.py 173-198): the only column aliases containing the substring 'date' are the four real date columns (BASIC_START_DATE, BASIC_FINISH_DATE, ORIGINAL_START_DATE, ORIGINAL_END_DATE); the boolean USER_SCHEDULED does not contain 'date' and is non-string anyway (guarded by typeof === 'string'). The hypothetical UPDATE_USER/CANDIDATE_FLAG columns do not exist in the orders schema and arbitrary /upload columns are not echoed back through /tasks. Also the stated 'NaN-Date' corruption is wrong: Util.parseDate (100-105) returns null on an unparseable string, not a NaN-Date. Latent maintainability smell only, currently zero impact, evidence misreads parseDate.

**`fe-admin-b`** — 2 dropped:
- __refreshThreadPane rebuilds the entire profiler table via innerHTML on every PerfMonitor tick while the tab is open_ — Code exists as cited (11696-11698 subscribe; 13656 innerHTML map().join), but the criticism is over-stated and partly a misread: PerfMonitor._notify is debounced 250ms (lines 571-573), so the rebuild fires at most ~4x/sec and ONLY while the diagnostics Thread tab is the active overview tab. The core rationale — 'the row set grows at 3,500-line scale' — is wrong: _buckets are keyed by operation NAME (a small fixed set), not by orders/lines, so the table size does not scale with data. With an already-bounded, already-debounced, rarely-open diagnostics pane and a flawed scale justification, this does not clear the architect-level bar.
- __renderAuditLog builds icon/color dispatch maps inside the render loop scope and string-formats details with no key whitelist_ — Code exists (ACTION_ICONS/ACTION_COLORS built per-call at 13572-13583; details via Object.entries map at 13591-13592), but the substance is trivial or already mitigated. The two parallel maps hold only 4 keys each and are allocated once per render of a rarely-opened admin table — negligible cost and negligible drift surface. The 'no key whitelist' detail-rendering is NOT a real exposure: 13601-13614 renders action+details exclusively via textContent (not innerHTML), with an explicit comment documenting it as the deliberate R1 stored-XSS mitigation. Per criterion (d) this is a documented, sensibly-handled tradeoff with no added insight.

**`be-brain`** — 1 dropped:
- _Three update endpoints duplicate the same 'persisted < total -> warn + assemble out dict' block verbatim_ — Verified the duplication is real (tasks_update 961-978 and bulk_update 988-1003 differ only in a log-prefix string), but it is ~12 lines of straightforward response-envelope assembly across two thin adapters that already share the real logic via _apply_task_date_updates. Severity is correctly 'low' and the original brief flags this as low/trivial; extracting a _finish_bulk helper is a minor cleanup with no real impact on correctness, flexibility, or scale — not architect-level. Dropping per the 'not trivial' bar.

**`be-db`** — 1 dropped:
- _update_task_dates_bulk reports persisted = applied = len(versions), conflating 'rows the UPDATE matched' with 'edits requested' — a row deleted between FOR UPDATE select and UPDATE is silently counted as not-persisted_ — The scenario the finding rests on cannot occur: the rows in update_rows passed the SELECT ... FOR UPDATE (db.py:463), so they are row-locked and cannot be deleted by a concurrent transaction before this transaction commits. The single UPDATE...FROM(VALUES) WHERE o.id = v.id therefore always matches every locked row, so len(versions) == len(update_rows) holds in practice and persisted is correct. The residual 'applied vs persisted naming' point is cosmetic — both are deliberately set equal (line 512) and the docstring's invalid_ids/not_found_ids contract (439-442) is actually honored. No architect-level impact; premise contradicted by the FOR UPDATE lock.

**`be-masterdata`** — 3 dropped:
- _list_rows ORDER BY derives key columns from a positional slice of col_names, silently mis-ordering when key columns aren't the leading display columns_ — Not reachable as a bug. The ORDER BY slice col_names[:len(_KEY_COLUMNS[table])] only mis-orders if the first N display columns are not all key columns. schema.sql:293-313 seeds every key column at column_order 1..N (keys lead all five tables), and the only DDL that adds columns (add_column) assigns next_order = MAX(column_order)+1 (line 404), appending to the END. There is NO column-reorder feature in the backend (column_order is only read/seeded/MAX+1 — grep confirmed) or frontend (app.js only add/drop/rename-label, 15542-15608). So the leading N columns are always exactly the composite key, giving a total deterministic order — pagination cannot skip/repeat. The 'add/reorder features explicitly allow' premise is false. Latent positional coupling at most, not a correctness defect.
- _list_rows for table='plants' fires a second 'constraints' query and the JSONB swallow can mask real errors_ — Half already mitigated, other half trivial. The 'silently swallowed exception' criticism is stale: lines 176-180 already escalated the generic except to a logged log.warning(..., exc_info=True, extra={category}) with the UndefinedColumn case split out separately (174-175) — it does not silently swallow. The remaining point (one extra round-trip to attach constraints, 167-170) is a low-value micro-optimization: the second query is already scoped to just the current page's plants (page_plants), and the suggested 'add constraints to the primary SELECT' is marginal on a small, infrequently-rendered table. Below the architect-level bar given the error-handling concern is already addressed.
- _ensure_labor_plan_table runs a data-mutating, non-idempotent-by-name headcount->avail_hours migration on every call_ — Premise is factually wrong. The finding repeatedly claims the migration 'fires on every invocation'/'per-call ensure path'/'on every request'. ensure_labor_plan_table is called ONLY at startup in the lifespan (brain.py:144), never per request (grep for callers confirms the only call sites are the three startup lines 144-146). After the first run the headcount column is gone so the block no-ops, and it is guarded by an information_schema check (587-591) plus IF NOT EXISTS / IF EXISTS clauses. The 'partial restore re-adds headcount' scenario is hypothetical and benign (it would re-copy into avail_hours). The schema.sql x1440 analogy does not hold — that landmine re-multiplies live data every run; this only acts when an obsolete column is present. Not an architect-level defect.

**`worker-drift`** — 2 dropped:
- _Closed-day diagnostic re-parses raw blocks/plantBlocks despite pre-parsed arrays being in scope_ — Real but trivial / not architect-level. The re-parse at worker 336-355 fires only in the cap===0 && hours>0 branch (a day fully consumed by blackouts WITH load scheduled on it) — a rare diagnostic path, not a hot loop, and it builds a human-readable label string the bucketed _capIdx cannot supply (it carries no reason/line/plant labels), so the 'just reuse parsedBlocks' fix is not free. The dead non-idx branch of dailyCapacityHours is mirrored verbatim from app.js (1143-1155) intentionally to keep the two files identical — removing it from only the worker would CREATE the very drift finding #1 warns against. Low impact, partly a misread of why the code re-parses.
- _Per-call workWindow memo cache is a module-global, not passed — re-entrancy / interleave hazard_ — Correctly describes the _wwCache module-global (worker 131, set/null at 251/424 and 437/504) but the criticism is overstated and self-defeating: a Web Worker's onmessage is single-threaded and processes one message at a time, JS has no preemption, and none of the three compute fns call each other — so the 'interleave/re-entrancy' hazard cannot occur in this execution model. The finding itself concedes 'it works' and the risk is purely hypothetical-future. This intentionally mirrors app.js's Calendar._runCache pattern (app.js 1065). Speculative, no real present impact — drop.

**`intel-b`** — 1 dropped:
- _Confidence._recompute is wired to fire on three overlapping triggers, double-recomputing the expensive utilization matrix on every edit_ — Misread of the behavior. Both the Store subscription (1345-1346) and the Alerts.recompute monkey-patch (1348-1349) call the SAME single debounced instance `Confidence._recomputeDebounced` (created once at 1328 via Util.debounce, a trailing-edge debounce with one shared timer — app.js:259-261), so they reliably collapse to ONE execution per 400ms window, not 'by luck of timing.' On top of that, the R21 guard at 1375-1377 (`_lastAlertsSrc`/`_lastRev`) short-circuits the matrix build when neither alerts nor Store._rev changed. The expensive `Utilization.computeMatrix` (1404) is therefore specifically protected against the double-build the finding alleges. The finding even acknowledges the R21 guard exists, making this a deliberate, well-documented tradeoff with mitigation in place rather than a defect. (The genuine duplication concern is captured separately in the kept showBreakdown/_recompute duplication finding.)

**`css-c`** — 1 dropped:
- _JetBrains Mono font stack literal repeated ~15 times instead of a --font-mono token_ — Real (the literal recurs and --font-mono is referenced-but-undefined), but it is a trivial duplication-only cleanup with no efficiency/correctness/flexibility impact — a font-stack change touching ~15 lines is low-stakes find-and-replace, and the core 'undefined token' concern is already captured in the kept --border/--border-subtle finding. Below architect-level; folding it in would just inflate the report.

**`html-a`** — 1 dropped:
- _Locale bootstrap relies on document.write of synchronous external scripts as a hard dependency for app.js_ — Verified the code exists (L2413 document.write, L2417 app.js depends on order), but the criticism is overstated and the strongest stated risk is misapplied: the loaded scripts are SAME-origin (locales/en.js), and Chrome's intervention that 'blocks document.write of scripts' targets cross-origin parser-blocking scripts on slow connections — same-origin document.write is not blocked. The pattern is also a deliberate, sensibly-documented tradeoff (comment at L2400-2404 explains the no-build-step rationale and that the language switcher reloads cleanly). What remains is a minor maintainability nit (ordering is load-bearing) with no new architect-level insight beyond what CLAUDE.md already documents, so it fails criteria (b) and (d).

**`html-b`** — 1 dropped:
- _Layout and z-index decisions are hardcoded as inline style attributes scattered through the markup, bypassing the design system_ — Cited code all verified real (z-index:4000 at L2026/2046, inline flex/overflow at L1297/1306/1369, max-height:392px at L1346, margin at L1637), but this is low-severity polish that substantially overlaps the kept inline-<style> finding (same anti-pattern, attribute granularity). The z-index:4000 pair is a deliberate, locally-obvious 'sit above the optimize modal' choice on just two nested date-picker modals, and the handful of flex/overflow attributes are isolated, not a drift surface. Dropping as trivial and largely duplicative of the inline-style finding.