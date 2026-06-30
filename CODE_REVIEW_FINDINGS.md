# NIMBUS — Master Code Review: Verified Findings (Ranked)

> **Generated** from a 67-agent adversarially-verified review of the entire NIMBUS codebase. Every region of every core file was reviewed under two diverse lenses (correctness/risk + performance/dead-code); each finding was then re-checked against the live code by an independent skeptical verifier, and the headline findings were spot-verified by hand. This document lists **every kept finding, verbatim, ranked by priority**.

## Executive summary

- **238 verified findings** kept from 244 raw (6 refuted as false-positives) across 23 code regions.
- **By severity:** 🔴 21 high · 🟠 78 medium · 🟡 139 low
- **By category:** performance 104 · bug-error 66 · maintainability 25 · risk 15 · unused-code 11 · security 9 · illogical-pattern 8
- **By file:** `app.js` 152 · `nimbus-intelligence.js` 29 · `brain.py` 21 · `master_data.py` 11 · `db.py` 10 · `schema.sql` 4 · `styles.css` 4 · `index.html` 4 · `nimbus-worker.js` 2 · `migration_perf.sql` 1
- **9 findings flagged _needs-human-judgment_** (real code, but defect status depends on runtime data / product intent).

**Ranking method:** severity first, then category weight (security → correctness/data-integrity → risk → performance → illogical-pattern → unused-code → maintainability), then file & line. Rank 1 = highest priority.

> ⚠️ **Meta-finding — CLAUDE.md is stale in one place:** the documented `Confidence.init` arity-0 monkey-patch that supposedly drops the `{lines}` incremental alert scope does **not** exist as described — the real patch at `nimbus-intelligence.js:1308` forwards all args (`(...args) => orig(...args)`). Correct CLAUDE.md when touching that area.

## Systemic themes

The findings cluster into recurring architectural patterns. Fixing the root of each theme resolves many findings at once.

### Unscoped/all-plant data reads that violate the 50+ plant / 3,500+ line scale target
The single most systemic correctness+scale failure: render and query paths repeatedly operate over ALL plants/lines instead of the selected-plant scope. Visual/correctness bugs (Timeline.zoomToFit, TimelineNav, DependencyOverlay render all plants; OptimizeDialog uses Config.KNOWN_PLANTS not Store.knownPlants; cache/load fallbacks bleed cross-plant state) compound with server-side full-list reads (backend fetches unfiltered production_lines; master_data list_rows unbounded; GET /tasks COUNT/full scans). Several are also data-integrity bugs: shared-line-code orders mis-attributed to lowest plant code (202, 223). This theme is the through-line of the CLAUDE.md scalability mandate.

_Findings:_ [R4](#r4), [R8](#r8), [R14](#r14), [R17](#r17), [R29](#r29), [R32](#r32), [R33](#r33), [R34](#r34), [R40](#r40), [R41](#r41), [R45](#r45), [R50](#r50), [R67](#r67), [R75](#r75), [R77](#r77), [R90](#r90), [R144](#r144), [R216](#r216)

### Repeated unmemoized utilization-matrix / capacity rebuilds (blackout re-parsing) on hot render paths
The dominant performance pattern. dailyCapacityHours/effectiveCapacityHours re-parse every blackout block per cell and are called twice per matrix cell; computeMatrix memoization is repeatedly defeated by mismatched day-span keys (90 vs 84, 14-day spans), non-null filtered subsets, and plant-scoped writes under global keys. Labor, Dashboard, Alerts overload loop, Optimize preview, Command Palette, and the intelligence Confidence/NeedsEngine layers all rebuild full matrices per render/edit/keystroke. At 3,500 lines this is the primary main-thread stall risk.

_Findings:_ [R10](#r10), [R11](#r11), [R12](#r12), [R13](#r13), [R14](#r14), [R15](#r15), [R21](#r21), [R57](#r57), [R58](#r58), [R61](#r61), [R62](#r62), [R63](#r63), [R65](#r65), [R73](#r73), [R74](#r74), [R93](#r93), [R97](#r97), [R98](#r98), [R162](#r162), [R169](#r169), [R188](#r188)

### Spoofable / hardcoded actor identity for destructive and audit-logged writes
Actor identity for labor-plan, audit-log, and master-data writes is hardcoded to a single developer's email on the frontend, and the backend trusts a spoofable X-User header. Audit trails are therefore unreliable for the very destructive/DDL operations they are meant to govern. The CLAUDE.md MIGRATION note (Entra SSO) confirms this is known but unresolved.

_Findings:_ [R22](#r22), [R23](#r23), [R26](#r26), [R27](#r27)

### XSS / injection sinks via innerHTML and unescaped inline onclick interpolation
Multiple untrusted-string-into-DOM paths: audit-log action (stored XSS, high), DB query text in lock-chain rendering, Modal.confirm detail, and unescaped line-code/alert-id interpolated into inline onclick JS. The pervasive inline-handler architecture (234) also blocks any future CSP that would mitigate these.

_Findings:_ [R1](#r1), [R24](#r24), [R25](#r25), [R100](#r100)

### Missing range/validity validation on working-hours and date inputs
Working-hours editors across Calendar tab, EditCalendar, and cached-state restore accept inverted (end<=start) or zero-length windows; _dayWindow silently floors fractional hours (08:30 to 08:00); effectiveCapacityHours can go negative when bufferPct>100; alert-horizon clamps only the lower bound. These corrupt the capacity engine that everything downstream depends on.

_Findings:_ [R3](#r3), [R30](#r30), [R31](#r31), [R101](#r101), [R113](#r113), [R117](#r117)

### Persistence / cross-plant state bleed and silent data loss
saveAll clears dirty ids before the partial-save check so un-persisted rows are never retried (silent data loss, high). Cache fallback and _restoreNonTaskState are not plant-scoped, enabling cross-plant order/calendar bleed on reconnect/offline. Settings horizon/constraint saves mutate Store before the network write succeeds, leaving local state diverged from DB on failure.

_Findings:_ [R7](#r7), [R40](#r40), [R41](#r41), [R43](#r43), [R112](#r112), [R113](#r113)

### Optimistic-concurrency and optimize-flow correctness gaps
Failed optimize leaves the schedule partially mutated with no revert path (high); Sandbox promote registers a mislabeled undo that loses blocks/calendars and discard mutates Store without bumping _rev. Backend: rows lost between FOR UPDATE select and UPDATE count as success; FOR UPDATE locks in unspecified order (deadlock risk). OptimizerPreview KPI scope drops null-line orders the engine actually moves, and selecting a plant in the dialog mutates global Store as a side effect.

_Findings:_ [R6](#r6), [R38](#r38), [R39](#r39), [R46](#r46), [R53](#r53), [R55](#r55), [R110](#r110), [R140](#r140), [R141](#r141)

### Schema migrations are non-idempotent / re-mutate data on re-run
schema.sql is documented as 'not strictly run-once' and the findings confirm why: horizon columns ×1440 re-multiply any sub-365 edit on every run; orders.plant backfill picks the lowest plant for shared line codes; chk_orders_sched_range is dropped/re-added NOT VALID and never validated; a perf index is duplicated and built non-CONCURRENTLY (blocks writes at scale).

_Findings:_ [R8](#r8), [R49](#r49), [R50](#r50), [R145](#r145), [R232](#r232)

### Backend row-by-row Python iteration and redundant queries on hot paths
GET /tasks builds responses via pandas groupby+iterrows and a full-frame astype(object) copy, plus a second full COUNT per paged request. Upload ingest iterates row-by-row. master_data cascade-preview is N+1 per plant, bulk_apply rebuilds SQL per row, labor-plan splits use O(n^2) membership, audit-log reads the entire unbounded file to return the last N. All scale poorly with row/plant count.

_Findings:_ [R84](#r84), [R85](#r85), [R86](#r86), [R87](#r87), [R88](#r88), [R89](#r89), [R91](#r91), [R181](#r181), [R185](#r185), [R186](#r186), [R187](#r187)

### Listener / instance / interval leaks and missing teardown
Many modules register document/window-level listeners, setIntervals, or Flatpickr instances that are never removed: Modal.confirm X button leaks listeners and never resolves; Inspector/Plant re-create Flatpickr without destroy(); TimelineNav/DependencyOverlay store unsub handles but never call them; per-second ticker and memory watchdog intervals never clear; Patterns._pairs grows unbounded with synchronous localStorage writes.

_Findings:_ [R35](#r35), [R71](#r71), [R72](#r72), [R154](#r154), [R171](#r171), [R173](#r173), [R207](#r207), [R210](#r210), [R219](#r219), [R221](#r221), [R225](#r225), [R234](#r234)

### Web Worker hand-port drift from app.js
The worker duplicates Calendar + Alerts logic with a code comment as the only guard. It is loaded by bare filename (no cache-bust) so a stale cached worker silently diverges; the near-capacity branch is structured differently; and the day-length literal is hardcoded instead of mirroring Config.MS_DAY. CLAUDE.md flags this must be mirrored rule-for-rule.

_Findings:_ [R52](#r52), [R235](#r235), [R236](#r236)

### Dark-mode and CSS-token incompleteness
--border / --border-subtle are referenced without fallback but never defined; multiple components hardcode light colors with no body.dark override; admin tab tint tokens not redefined in dark mode; duplicated scrollbar rules. Matches the CLAUDE.md note that body.dark is incomplete.

_Findings:_ [R99](#r99), [R127](#r127), [R136](#r136), [R214](#r214), [R222](#r222), [R238](#r238)

### Duplicate / double-fired computation and rendering
Work is performed twice: AdminCockpit.render double-fires _renderOverview (all 9 panels twice); TimeMachine writes two snapshots per undo-tracked bulk edit; Confidence recompute fires twice per mutation; dailyCapacityHours invoked twice per cell; conflict set computed twice per rebuild; countChangeovers walks the task set redundantly with scheduleKpis.

_Findings:_ [R11](#r11), [R15](#r15), [R20](#r20), [R47](#r47), [R80](#r80), [R81](#r81), [R95](#r95), [R96](#r96), [R125](#r125), [R155](#r155), [R190](#r190), [R191](#r191), [R215](#r215)

### Timestamp / locale / timezone correctness
Printer CSV exports UTC while preview shows local time; _displayDate hardcodes en-US bypassing i18n; the DB midnight-finish heuristic recomputes finish for any order legitimately ending at 00:00. These produce subtly wrong exported/displayed data.

_Findings:_ [R42](#r42), [R125](#r125), [R218](#r218)

### Dead code, stale comments, and CLAUDE.md drift
Unused functions (load_orders_df, _row_key, _onRowClicked never wired), dead writes (_lastQuarantineKey), always-empty gating variables (skippedFixed), stale copy ('Re-read Excel' though Postgres-backed), and a documented monkey-patch (172) that no longer exists. Low individual severity but indicates documentation has drifted from code.

_Findings:_ [R203](#r203), [R205](#r205), [R206](#r206), [R207](#r207), [R208](#r208), [R209](#r209), [R210](#r210), [R211](#r211), [R212](#r212), [R213](#r213), [R224](#r224), [R228](#r228), [R232](#r232), [R233](#r233)

### Indexing/keying and FK-integrity correctness in Store and DB
Store.updateTask leaves a stale object in _tasksByPlant; linesForSelectedPlant ignores the maintained plant index; FK select matching uses strict === across string/number mismatch; duplicate-id suffixing can overwrite a genuine prior row; maintenance allowlist cached for process lifetime; cascade_preview has no materials branch (reports 0 while delete cascades material_plants — high) and bulk_apply uses d[k] raising KeyError; labor_plan_line lacks FKs allowing orphans.

_Findings:_ [R9](#r9), [R28](#r28), [R118](#r118), [R124](#r124), [R126](#r126), [R128](#r128), [R151](#r151), [R156](#r156), [R161](#r161), [R237](#r237)

## Reviewer's top priorities

- **[R8](#r8) 🔴 Cross-plant order misattribution: ORDER BY pl.plant LIMIT 1 silently picks the lowest plant code when a line is shared across plants** — Cross-plant order misattribution (ORDER BY pl.plant LIMIT 1 silently picks the lowest plant code for a shared line code) is a data-integrity defect at the core read path, and it directly breaks the 3,500-line/50-plant model where line codes WILL be reused across plants. Orders are silently attributed to the wrong plant — wrong schedules, wrong capacity, wrong everything downstream. Mirrored in schema backfill (223) and reattribute logic.
- **[R7](#r7) 🔴 saveAll() clears dirty/force ids before the partial-save check, so un-persisted rows are never retried (silent data loss)** — saveAll clears dirty/force ids before the partial-save check, so un-persisted rows are never retried — silent data loss of user edits with no error surfaced. This is the worst kind of bug: it loses work quietly.
- **[R1](#r1) 🔴 Stored XSS: audit-log `action` rendered via innerHTML from an unvalidated backend dict** — Stored XSS via audit-log action rendered through innerHTML from an unvalidated backend dict. The audit log is attacker-influenceable content rendered in a privileged admin context, and the pervasive inline-handler design blocks CSP mitigation. Highest-severity security finding.
- **[R2](#r2) 🔴 Color-wheel upload/delete routes are unauthenticated while every other destructive route is API-key gated** — Color-wheel upload/delete routes are unauthenticated while every other destructive route is API-key gated — an inconsistent security boundary that lets an unauthenticated caller overwrite/delete per-plant color wheels (which feed the only wired optimizer constraint). Clear gap in the deployment security stopgap.
- **[R6](#r6) 🔴 Failed optimize leaves the schedule partially mutated with no revert path** — A failed optimize leaves the schedule partially mutated with no revert path, corrupting live in-memory state that then autosaves to cache. Combined with the optimize double-submit risk (47) and Sandbox undo loss (97), the primary value-add workflow can silently corrupt the schedule.
- **[R9](#r9) 🔴 cascade_preview has no branch for 'materials' — silently reports 0 cascading children while the actual delete cascades material_plants rows** — cascade_preview has no materials branch — it reports 0 cascading children while the actual delete cascades material_plants rows. Users approve a destructive delete believing nothing else is affected; this is a data-integrity + trust failure in the admin delete-confirmation path.
- **[R11](#r11) 🔴 dailyCapacityHours re-parses all blackout blocks on every call and is invoked twice per matrix cell** — dailyCapacityHours re-parses ALL blackout blocks on every call and is invoked twice per matrix cell, and this matrix is rebuilt unmemoized across Dashboard, Labor, Alerts, and the intelligence layer. It is the single root cause behind the largest cluster of high-severity perf findings and is the main thing that will make the app unusable at 3,500 lines.
- **[R3](#r3) 🔴 Fractional working hours (08:30 etc.) are silently floored to the hour by setHours() in _dayWindow** — Fractional working hours (08:30) are silently floored to the hour by setHours() in _dayWindow — this corrupts the capacity engine input that every utilization, alert, and optimizer calculation depends on, producing systematically wrong capacity across the whole app with no error.
- **[R27](#r27) 🟠 Destructive/audit actions attribute the actor to a spoofable X-User header** — Destructive/audit actions attribute the actor to a spoofable X-User header (frontend hardcodes a single dev email). The audit trail meant to govern DDL/purge/maintenance is unreliable — a compliance and accountability failure for a manufacturing scheduling system.
- **[R17](#r17) 🔴 TimelineNav renders ALL plants' tasks (unscoped Store.tasksArr) instead of the selected plant** — TimelineNav renders ALL plants' tasks (unscoped Store.tasksArr) — emblematic of the unscoped-render theme and a high-severity perf/correctness defect: at 50+ plants the minimap draws the entire system every Store change, both wrong (shows other plants) and a guaranteed stall.

## Master ranked table (all findings)

| Rank | Sev | Category | File : Lines | Finding |
|----:|:---:|:---------|:-------------|:--------|
| [R1](#r1) | 🔴 | security | `app.js:12990-2999` | Stored XSS: audit-log `action` rendered via innerHTML from an unvalidated backend dict |
| [R2](#r2) | 🔴 | security | `brain.py:973-1062` | Color-wheel upload/delete routes are unauthenticated while every other destructive route is API-key gated |
| [R3](#r3) | 🔴 | bug-error | `app.js:987-994` | Fractional working hours (08:30 etc.) are silently floored to the hour by setHours() in _dayWindow |
| [R4](#r4) | 🔴 | bug-error | `app.js:5998-6007` | Timeline.zoomToFit() ignores the selected-plant filter and zooms to all plants' tasks |
| [R5](#r5) | 🔴 | bug-error | `app.js:6984-6997` | _persistNote shared debounce timer drops note saves across different orders |
| [R6](#r6) | 🔴 | bug-error | `app.js:8897-8959` | Failed optimize leaves the schedule partially mutated with no revert path |
| [R7](#r7) | 🔴 | bug-error | `app.js:10918-10947` | saveAll() clears dirty/force ids before the partial-save check, so un-persisted rows are never retried (silent data loss) |
| [R8](#r8) | 🔴 | bug-error | `db.py:1062-1073 (also 220-237 in reattribute_null_plant_orders)` | Cross-plant order misattribution: ORDER BY pl.plant LIMIT 1 silently picks the lowest plant code when a line is shared across plants |
| [R9](#r9) | 🔴 | bug-error | `master_data.py:173-206` | cascade_preview has no branch for 'materials' — silently reports 0 cascading children while the actual delete cascades material_plants rows |
| [R10](#r10) | 🔴 | performance | `app.js:1043-1063` | dailyCapacityHours re-scans ALL blocks and re-parses every date on every call in the live (non-optimizer) path |
| [R11](#r11) | 🔴 | performance | `app.js:1043-1074, 4231-4232` | dailyCapacityHours re-parses all blackout blocks on every call and is invoked twice per matrix cell |
| [R12](#r12) | 🔴 | performance | `app.js:2552-2562, 2618, 2334-2367` | _renderKPIs rebuilds the entire utilization matrix on every aggregate cell edit and paste |
| [R13](#r13) | 🔴 | performance | `app.js:3632-3641` | Alerts._recomputeSync overload loop re-parses every blackout block per (line,day) cell via dailyCapacityHours, ignoring the already-parsed block arrays in the same function |
| [R14](#r14) | 🔴 | performance | `app.js:4210-4216, 7316-7321, 7552-7557` | Dashboard 7-day utilization matrix bypasses memoization on every render (full O(lines x days) rebuild) |
| [R15](#r15) | 🔴 | performance | `app.js:4231-4232` | computeMatrix and dayByLine call both dailyCapacityHours AND effectiveCapacityHours per cell, doubling the full block scan |
| [R16](#r16) | 🔴 | performance | `app.js:6056, 6122-6133, 6472-6478, 6553-6558` | Alerts column renderer + row-class do O(rows × alerts) linear scans on every grid redraw |
| [R17](#r17) | 🔴 | performance | `app.js:8095-8096` | TimelineNav renders ALL plants' tasks (unscoped Store.tasksArr) instead of the selected plant |
| [R18](#r18) | 🔴 | performance | `app.js:9692-9729, 9774` | Marquee hit-test reads getBoundingClientRect() for every timeline item on every pointermove and RAF tick |
| [R19](#r19) | 🔴 | performance | `app.js:10077-10101` | 60fps ghost-drag does an O(selected x allTasks) conflict scan on every timechange event |
| [R20](#r20) | 🔴 | performance | `nimbus-intelligence.js:1163-1204` | TimeMachine snapshots full task array + IndexedDB write on every UndoStack.push |
| [R21](#r21) | 🔴 | performance | `nimbus-intelligence.js:1304-1361` | Confidence rebuilds a 14-day utilization matrix after every Alerts.recompute and every task mutation |
| [R22](#r22) | 🟠 | security | `app.js:2241-2268` | Labor-plan POST actor identity hardcoded to a single developer's email |
| [R23](#r23) | 🟠 | security | `app.js:5172-5182 (pattern repeated app-wide; see also 1831, 2245, 14027, 14796, 14946)` | Audit-log POST hardcodes the actor identity to a single developer email |
| [R24](#r24) | 🟠 | security | `app.js:7613, 7751, 7914, 7966` | Unescaped line code / alert id interpolated into inline onclick JS string (handler-breaking / injection sink) |
| [R25](#r25) | 🟠 | security | `app.js:12549-12551` | XSS sink: DB query text injected via innerHTML in lock-chain rendering |
| [R26](#r26) | 🟠 | security | `app.js:14027, 14124` | Actor identity hardcoded to a single user's email in master-data write headers |
| [R27](#r27) | 🟠 | security | `brain.py:994-1010` | Destructive/audit actions attribute the actor to a spoofable X-User header |
| [R28](#r28) | 🟠 | bug-error | `app.js:641-648` | updateTask replaces the task reference but does not refresh _tasksByPlant, leaving a stale task object in the plant index after single edits |
| [R29](#r29) | 🟠 | bug-error | `app.js:757-773` | clampLinesToPlant only clamps lines mapped via lineSettings.plant, ignoring master-data-derived plant mapping used everywhere else |
| [R30](#r30) | 🟠 | bug-error | `app.js:1254-1264` | Calendar-tab working-hours editor accepts inverted (end <= start) windows with no validation |
| [R31](#r31) | 🟠 | bug-error | `app.js:3241-3263` | EditCalendar save() persists work hours with no validation that end > start, allowing inverted/zero-length day windows |
| [R32](#r32) | 🟠 | bug-error | `app.js:4374-4392 (cache read 4213-4216)` | Off-thread prewarm writes a plant-scoped utilization matrix under the global cache key, poisoning computeMatrix for unfiltered callers |
| [R33](#r33) | 🟠 | bug-error | `app.js:4741-4743` | OptimizeDialog plant list uses Config.KNOWN_PLANTS instead of Store.knownPlants() — stale list at scale |
| [R34](#r34) | 🟠 | bug-error | `app.js:4742-4743` | Optimize dialog plant picker bypasses Store.knownPlants(), hiding master-data plants with no orders |
| [R35](#r35) | 🟠 | bug-error | `app.js:5404-5425` | Modal.confirm: the X close button bypasses cleanup(), leaking click listeners and leaving the promise unresolved forever |
| [R36](#r36) | 🟠 | bug-error | `app.js:8537-8544, 8622` | DependencyOverlay critical-path recursion has no cycle guard — a dependency cycle throws an uncaught RangeError that aborts render() |
| [R37](#r37) | 🟠 | bug-error | `app.js:8578-8595` | DependencyOverlay maps line→Y using all-plant task list but indexes plant-scoped group rows positionally — arrows attach to wrong lines |
| [R38](#r38) | 🟠 | bug-error | `app.js:8914-8922 (vs Engine 4542-4543 and OptimizeDialog 4853)` | OptimizerPreview KPI scope drops null-line ('Unknown') orders the engine actually reschedules |
| [R39](#r39) | 🟠 | bug-error | `app.js:9249-9260` | Sandbox promote (exit(true)) registers an undo that loses blocks/calendars and is mislabeled "Discard" |
| [R40](#r40) | 🟠 | bug-error | `app.js:10447-10463, 10775-10788` | _restoreNonTaskState whole-object-replaces lineSettings/calendars on the backend load path, enabling cross-plant state bleed and swallowing restore errors |
| [R41](#r41) | 🟠 | bug-error | `app.js:10534-10547, 10712-10770, 11024-11039` | Cache fallback (_loadCache) is not plant-scoped, so reconnect/offline can render the wrong plant's orders |
| [R42](#r42) | 🟠 | bug-error | `app.js:13270-13274, 13337` | Printer CSV export emits UTC timestamps while the on-screen preview shows local time |
| [R43](#r43) | 🟠 | bug-error | `app.js:14021-14033, 14116-14130` | Settings horizon/constraint saves mutate Store state before the network write succeeds; failure only toasts, leaving local state diverged from DB |
| [R44](#r44) | 🟠 | bug-error | `app.js:14549-14555, 14744-14755` | Added-then-edited MasterData rows are upserted twice (and bypass key-column validation on one path) |
| [R45](#r45) | 🟠 | bug-error | `brain.py:643-734` | Paginated GET /tasks splits production-line groups across page boundaries, breaking finish-to-start links |
| [R46](#r46) | 🟠 | bug-error | `db.py:388-416` | Rows lost between FOR UPDATE select and the UPDATE are counted as success, not failure (applied/persisted = len(versions)) |
| [R47](#r47) | 🟠 | bug-error | `nimbus-intelligence.js:1163-1178` | Every undo-tracked bulk edit writes TWO Time Machine snapshots (UndoStack.push patch + tasks:bulkUpdate subscription both fire) |
| [R48](#r48) | 🟠 | bug-error | `nimbus-intelligence.js:1198-1202` | TimeMachine.snapshot corrupts in-memory snap.id with an IndexedDB transaction Event object |
| [R49](#r49) | 🟠 | bug-error | `schema.sql:103-105` | Horizon-column ×1440 UPDATE re-multiplies any legitimate sub-365 horizon edit on every schema.sql re-run |
| [R50](#r50) | 🟠 | bug-error | `schema.sql:143-149` | orders.plant backfill arbitrarily picks lowest plant when a line code is reused across plants, silently mis-attributing orders |
| [R51](#r51) | 🟠 | risk | `app.js:2289-2308, 2649-2660, 2971-2999` | LaborPlanning async render has no generation guard — fast plant/horizon switches interleave stale data into the live grid |
| [R52](#r52) | 🟠 | risk | `app.js:3448` | Web Worker loaded by bare filename with no cache-bust query — stale cached worker silently diverges from freshly-deployed app.js |
| [R53](#r53) | 🟠 | risk | `app.js:3456-3466` | Compute worker is never restarted after a single onerror, making sync fallback permanent for the session |
| [R54](#r54) | 🟠 | risk | `brain.py:1314-1332` | /diagnostics/db has no per-call error isolation — one failing probe 500s the entire panel |
| [R55](#r55) | 🟠 | risk | `db.py:352-364` | Bulk update SELECT ... FOR UPDATE locks rows in unspecified order — deadlock risk under concurrent saves |
| [R56](#r56) | 🟠 | risk | `index.html:5` | viewport meta blocks pinch-zoom (maximum-scale=1, user-scalable=no) — accessibility violation ⚖️ |
| [R57](#r57) | 🟠 | performance | `app.js:352-360` | scheduleKpis bypasses computeMatrix memoization on every optimizer-preview call |
| [R58](#r58) | 🟠 | performance | `app.js:1000-1038` | workWindow memoization (_runCache) exists only during Engine runs; the UI render path is fully unmemoized |
| [R59](#r59) | 🟠 | performance | `app.js:1441-1482` | Plant._renderHours destroys and recreates 14 Flatpickr instances plus a rAF on every render |
| [R60](#r60) | 🟠 | performance | `app.js:1882-1919, 1928-1929, 1997-2011, 2029-2037` | ProdLines.render re-fetches lines and re-ensures calendars/settings for the full line list on every keystroke in the filter |
| [R61](#r61) | 🟠 | performance | `app.js:2311-2331, 2600-2614` | _disaggregate re-filters all lines and recomputes effectiveCapacityHours over lines x 7 days per aggregate cell, multiplied across a paste |
| [R62](#r62) | 🟠 | performance | `app.js:2345-2346, 2672, 2803, 2860, 4210-4216` | computeMatrix cache key uses mismatched day counts (90 vs 84), guaranteeing a cache miss and a full all-lines rebuild on every Labor render |
| [R63](#r63) | 🟠 | performance | `app.js:2855-2875` | _renderExceptions iterates all plant lines x all matrix days against an unscoped global matrix |
| [R64](#r64) | 🟠 | performance | `app.js:3352-3408` | ColorWheelViewer._render rebuilds a full global task-count scan on every search keystroke and sort |
| [R65](#r65) | 🟠 | performance | `app.js:4311-4368` | Utilization.dayByLine re-parses all blackout blocks once per line (unmemoized hot path) |
| [R66](#r66) | 🟠 | performance | `app.js:4858-4925` | OptimizeDialog line search re-scans all plant orders and rebuilds line list on every keystroke |
| [R67](#r67) | 🟠 | performance | `app.js:5998-6007` | zoomToFit uses Math.min/Math.max spread over all tasks — RangeError risk and O(2n) at scale |
| [R68](#r68) | 🟠 | performance | `app.js:6244-6285, 6448` | Chip dropdowns re-scan all plant tasks and rebuild full innerHTML on every store event, even while hidden |
| [R69](#r69) | 🟠 | performance | `app.js:6472-6478` | alerts:change handler forces a full redrawRows() of the entire grid on every alert recompute |
| [R70](#r70) | 🟠 | performance | `app.js:6560-6564, 6841, 6092` | _getLineOptions rebuilds a Set over all tasks + all calendars on every call, unmemoized and not plant-scoped |
| [R71](#r71) | 🟠 | performance | `app.js:6804-6805, 6833-6934` | Inspector._render does a full innerHTML rebuild + Flatpickr re-instantiation on every task:update for the inspected row |
| [R72](#r72) | 🟠 | performance | `app.js:6927-6933` | Inspector re-creates a Flatpickr instance on every _render with no destroy() — instance/listener/DOM leak |
| [R73](#r73) | 🟠 | performance | `app.js:7316-7322, 7670, 4212-4216, 4290` | Dashboard render bypasses Utilization memo on every render (non-null filtered subset) |
| [R74](#r74) | 🟠 | performance | `app.js:7656-7670, 7316-7322` | Dashboard render rebuilds the 1-day line-status matrix uncached every render (memo bypass, scale risk) |
| [R75](#r75) | 🟠 | performance | `app.js:8536-8580` | DependencyOverlay.render computes line layout and chain lengths over ALL plants (unscoped Store.tasksArr / Store.tasks) |
| [R76](#r76) | 🟠 | performance | `app.js:10282-10286` | Selection->Table sync is O(rows x selected) via Array.includes inside forEachNode |
| [R77](#r77) | 🟠 | performance | `app.js:10357, 10399, 10514` | Backend load path fetches the unfiltered full production_lines list (scale anti-pattern at 3,500 lines) |
| [R78](#r78) | 🟠 | performance | `app.js:10880-10882` | saveAll dirty-task selection scans the full task map instead of looking up dirty ids directly |
| [R79](#r79) | 🟠 | performance | `app.js:10893` | saveAll serializes the entire blocks + calendars map on every backend save, even when only one task changed |
| [R80](#r80) | 🟠 | performance | `app.js:11175-11185, 11297-11300` | AdminCockpit.render() double-fires _renderOverview() — every admin tab open issues all 9 panel renders/fetches twice |
| [R81](#r81) | 🟠 | performance | `app.js:11262-11267, 12697-12733` | _renderLogs() does a full scope-select rebuild + up to 500-row DOM teardown on every ErrorLog push (undebounced) while the admin tab is active |
| [R82](#r82) | 🟠 | performance | `app.js:14497-14538, 14445-14474` | FK <select> rebuilt per cell with O(rows × sourceRows) option population — and N+1 fetch when source uncached |
| [R83](#r83) | 🟠 | performance | `app.js:14624-14674` | _pasteRows is O(P × N) — four linear scans per pasted row plus a fifth in the update pass |
| [R84](#r84) | 🟠 | performance | `brain.py:660, 733` | Paged GET /tasks issues a second full-table COUNT query per request |
| [R85](#r85) | 🟠 | performance | `brain.py:671` | Full-frame df.astype(object).where(pd.notna(df), None) allocates an entire object-dtype copy of every column just to null-coerce ~20 read columns |
| [R86](#r86) | 🟠 | performance | `brain.py:676-721` | GET /tasks builds the response row-by-row via pandas iterrows() + groupby — O(rows) Python-object iteration on the hot path |
| [R87](#r87) | 🟠 | performance | `brain.py:676-721` | GET /tasks builds the response with df.groupby + iterrows() Python row-by-row loop (hot path) |
| [R88](#r88) | 🟠 | performance | `brain.py:1100-1113` | GET /audit/log reads and JSON-parses the entire unbounded audit file to return only the last N entries |
| [R89](#r89) | 🟠 | performance | `db.py:991-1035` | ingest_orders_from_excel does row-by-row Python iteration (df.apply axis=1 + df.iterrows) on the upload path |
| [R90](#r90) | 🟠 | performance | `master_data.py:119-147` | list_rows performs an unbounded full-table read when no limit/offset is supplied |
| [R91](#r91) | 🟠 | performance | `master_data.py:194-204` | cascade_preview plants branch issues one COUNT query per deleted plant (N+1) |
| [R92](#r92) | 🟠 | performance | `nimbus-intelligence.js:393-406` | IntelDB.pruneSnapshots loads every snapshot (including full task payloads) into memory just to delete the oldest by id |
| [R93](#r93) | 🟠 | performance | `nimbus-intelligence.js:425-436, 1352-1359` | NeedsEngine and Confidence each build a full Utilization matrix with mismatched day-spans, defeating the shared memo |
| [R94](#r94) | 🟠 | performance | `nimbus-intelligence.js:734-752, 841-917` | CommandPalette index rebuilds a 2,000-row string-built array on every broad Store event and every selection change |
| [R95](#r95) | 🟠 | performance | `nimbus-intelligence.js:1163-1204` | TimeMachine.snapshot deep-serializes the entire task list on every UndoStack.push and every bulk Store event (undebounced) |
| [R96](#r96) | 🟠 | performance | `nimbus-intelligence.js:1163-1174` | TimeMachine takes a full deep snapshot on EVERY UndoStack.push and again on every bulk Store event — duplicate, unbounded-cost snapshots |
| [R97](#r97) | 🟠 | performance | `nimbus-intelligence.js:1307-1309` | Confidence._recompute rebuilds a full all-lines Utilization matrix on a 400ms debounce after every alert recompute |
| [R98](#r98) | 🟠 | performance | `nimbus-intelligence.js:1405-1429` | showBreakdown rebuilds the full 14-day utilization matrix on every badge click |
| [R99](#r99) | 🟠 | maintainability | `styles.css:1442, 3043, 4846` | Dark mode incomplete: .welcome-splash, .cw-active-card, .lp-hm-grad hardcode light colors with no body.dark override |
| [R100](#r100) | 🟡 | security | `app.js:5408-5410` | Modal.confirm renders opts.detail via innerHTML (latent XSS sink) |
| [R101](#r101) | 🟡 | bug-error | `app.js:1071` | effectiveCapacityHours can return negative capacity when bufferPct loaded from master data exceeds 100 |
| [R102](#r102) | 🟡 | bug-error | `app.js:2289-2308, 2358-2367, 2862-2873` | _lineData cache is never pruned when the horizon scrolls — stale out-of-window days accumulate and KPIs/exceptions read them |
| [R103](#r103) | 🟡 | bug-error | `app.js:2328-2330` | Even-split disaggregation rounds each slot to 0.1h independently, so per-line totals drift from the aggregate group/week hours |
| [R104](#r104) | 🟡 | bug-error | `app.js:2662-2672, 2715-2721` | _renderLinePlan builds span*7 day columns but the matrix only covers min(span*7,84) days, so columns past day 84 silently show scheduled=0 |
| [R105](#r105) | 🟡 | bug-error | `app.js:2727, 2750-2757, 2785` | Line-plan cell value 0 is stored but rendered as blank, so a legitimate 0-hour override is indistinguishable from 'no value' |
| [R106](#r106) | 🟡 | bug-error | `app.js:3332-3349` | ColorWheelViewer error branch keys off the substring '404' and leaks raw error text to users on any other failure |
| [R107](#r107) | 🟡 | bug-error | `app.js:6509-6515` | start_date edit leaves a stale end_date when RUN_TIME duration is 0, producing end < start ⚖️ |
| [R108](#r108) | 🟡 | bug-error | `app.js:7158-7171` | Dashboard `tasks:bulk` re-render does not cancel the pending debounced render |
| [R109](#r109) | 🟡 | bug-error | `app.js:7750-7751` | Inline onclick handler references undefined variable `a` in dead else-branch |
| [R110](#r110) | 🟡 | bug-error | `app.js:9263-9269` | Sandbox discard mutates Store._state.blocks/calendars directly without bumping _rev or publishing |
| [R111](#r111) | 🟡 | bug-error | `app.js:9918, 9978, 9996` | Variable shadowing: i18n function `t` shadowed by task object inside _onDataSetUpdate, making Toast call throw if ever reached |
| [R112](#r112) | 🟡 | bug-error | `app.js:10561-10573` | Reconnect-triggered reload uses stale _currentLoadedPlant, ignoring a plant the user switched to while offline |
| [R113](#r113) | 🟡 | bug-error | `app.js:10745-10769` | Cache load path skips _snapToWorkingHours/range validation, so a cache written mid-edit can render inverted ranges the backend rejects |
| [R114](#r114) | 🟡 | bug-error | `app.js:11739-11750` | `_dbLineBar`/`_lineBar` and chart helpers divide by `Math.max(...[],1)` but pass through `cnt/max` with no empty guard on per-row width when max could be 0 only mitigated by the `,1` seed — verify NaN width on empty datasets |
| [R115](#r115) | 🟡 | bug-error | `app.js:11995-12014` | `_runMaintenance` leaves the trigger button disabled/'Running…' on success |
| [R116](#r116) | 🟡 | bug-error | `app.js:13252-13261, 13328-13330` | Printer date-range filter only matches orders whose start_date falls in range, silently dropping orders that span into the range |
| [R117](#r117) | 🟡 | bug-error | `app.js:13984, 14018, 14036-14038` | Alert-horizon input clamps only the lower bound, so a stored horizon > 60 days renders an out-of-range value silently re-clamped on next edit |
| [R118](#r118) | 🟡 | bug-error | `app.js:14512-14519, 14528-14534` | FK <select> option matching uses strict === across possible string/number type mismatch ⚖️ |
| [R119](#r119) | 🟡 | bug-error | `brain.py:300-305, 990-1006` | _cw_safe_name maps distinct plant codes to the same file, silently overwriting wheels at scale ⚖️ |
| [R120](#r120) | 🟡 | bug-error | `brain.py:777-780, 815-816` | /task/update returns misleading 'Invalid date range' 400 for blank-id payloads |
| [R121](#r121) | 🟡 | bug-error | `brain.py:821-837` | POST /task/note silently succeeds for a nonexistent task id |
| [R122](#r122) | 🟡 | bug-error | `brain.py:843-882` | Bulk update logs a spurious 'some tasks not persisted' warning for no-op date edits |
| [R123](#r123) | 🟡 | bug-error | `db.py:167-172` | OFFSET applied with truthy check `if offset:` instead of `is not None` |
| [R124](#r124) | 🟡 | bug-error | `db.py:840-852` | Maintenance table allowlist is cached for process lifetime; tables created after startup are permanently un-vacuumable and the cache never refreshes |
| [R125](#r125) | 🟡 | bug-error | `db.py:980-984` | Midnight-finish heuristic recomputes finish time for any order legitimately ending at 00:00 |
| [R126](#r126) | 🟡 | bug-error | `db.py:996-1006` | Duplicate-id suffixing (_1, _2) can collide with and overwrite a genuine prior-batch order row |
| [R127](#r127) | 🟡 | bug-error | `index.html:1309-1310` | var(--border) used without fallback in index.html inline style (Plant inner-tab strip) |
| [R128](#r128) | 🟡 | bug-error | `master_data.py:229-239` | bulk_apply delete uses d[k] (not d.get) — a delete payload missing a key column raises KeyError → unhandled 500 instead of a 4xx |
| [R129](#r129) | 🟡 | bug-error | `master_data.py:610-611, 683-684` | to_upsert partition via `c not in to_delete` uses dict-equality membership — duplicate/identical cells are mis-partitioned and it is O(n^2) |
| [R130](#r130) | 🟡 | bug-error | `nimbus-intelligence.js:353-361, 1198-1202` | IntelDB.put resolves with the transaction 'complete' Event, not the inserted key — TimeMachine snap.id corrupted |
| [R131](#r131) | 🟡 | bug-error | `nimbus-intelligence.js:1262-1263` | TimeMachine.restore pushes directly into UndoStack._entries, bypassing the MAX=10 cap |
| [R132](#r132) | 🟡 | bug-error | `nimbus-intelligence.js:1293-1308, 1326-1348` | Confidence score can be computed from stale Store.alerts (worker is async; 'alerts' source not subscribed) |
| [R133](#r133) | 🟡 | bug-error | `nimbus-intelligence.js:1552-1590` | Confidence._drawChart divides font sizes by devicePixelRatio without scaling the canvas — labels shrink on HiDPI displays |
| [R134](#r134) | 🟡 | bug-error | `nimbus-intelligence.js:1741-1754` | RipplePreview ghosts are position:fixed from a one-time getBoundingClientRect and never reposition on scroll/zoom |
| [R135](#r135) | 🟡 | bug-error | `nimbus-intelligence.js:1812-1827` | Diff treats any non-zero start delta as 'moved', flagging null<->null and unscheduled transitions inconsistently |
| [R136](#r136) | 🟡 | bug-error | `styles.css:4905-4906` | --border and --border-subtle CSS variables used without fallback but never defined |
| [R137](#r137) | 🟡 | risk | `app.js:284-293` | fetchTraced hard-references ErrorLog (defined later in the IIFE) without the typeof guard used elsewhere |
| [R138](#r138) | 🟡 | risk | `app.js:338-348` | scheduleKpis calls .getTime() on raw task date fields, contradicting its documented pure-function contract for arbitrary task arrays |
| [R139](#r139) | 🟡 | risk | `app.js:1464-1482` | _renderHours rAF flatpickr init re-reads Store.selectedPlant, risking stale-plant pickers if selection changes within one frame |
| [R140](#r140) | 🟡 | risk | `app.js:4755 and 4823-4825` | Selecting a plant inside the optimize dialog mutates the global Store.selectedPlant as a side effect |
| [R141](#r141) | 🟡 | risk | `app.js:5099-5113, 5167-5169, 8897-8930` | Optimize run can be double-submitted: runWithPreview re-snapshots after a possible prior mutation with no in-flight guard ⚖️ |
| [R142](#r142) | 🟡 | risk | `app.js:10397-10410, 10511-10527` | Master-data fetch on the zero-row/non-zero load paths is detached, so awaiting load() does not guarantee the plant picker is hydrated |
| [R143](#r143) | 🟡 | risk | `brain.py:380-383, 405-409` | Color-wheel load/refresh swallow all exceptions, can serve a stale wheel after a failed refresh |
| [R144](#r144) | 🟡 | risk | `master_data.py:659-669` | load_labor_plan_line LEFT JOIN keys on (production_line, plant) without subnetwork, risking fan-out at scale |
| [R145](#r145) | 🟡 | risk | `schema.sql:57-60` | chk_orders_sched_range is dropped and re-added NOT VALID on every run, so it is never validated against existing rows and re-locks orders each time |
| [R146](#r146) | 🟡 | performance | `app.js:91-92` | DEBUG_BLOCKS left enabled in shipped config, emitting a full console.trace on every block add |
| [R147](#r147) | 🟡 | performance | `app.js:91, 716, 776` | DEBUG_BLOCKS defaults to true — console.trace runs on every block add in production |
| [R148](#r148) | 🟡 | performance | `app.js:511-528` | PerfMonitor.stats() allocates and sorts a fresh array on every call |
| [R149](#r149) | 🟡 | performance | `app.js:593-603` | Store.emit records a PerfMonitor sample (2x performance.now + string concat) for every listener on every mutation |
| [R150](#r150) | 🟡 | performance | `app.js:757-774` | clampLinesToPlant always emits calendar:change even when no line was modified, triggering needless recompute/re-render storms |
| [R151](#r151) | 🟡 | performance | `app.js:822-832` | getPlantForLine falls back to a linear scan of all master-data lines on cache miss ⚖️ |
| [R152](#r152) | 🟡 | performance | `app.js:2417-2424, 2561, 2618` | _updateAggrTotals recomputes every week column total by reducing over all groups on each cell edit |
| [R153](#r153) | 🟡 | performance | `app.js:3619-3660` | WelcomeSplash arrow loop forces 2 layout reflows per animation frame indefinitely until a plant is selected |
| [R154](#r154) | 🟡 | performance | `app.js:5544-5562` | Per-second timeline ticker setInterval is never cleared and runs regardless of active tab |
| [R155](#r155) | 🟡 | performance | `app.js:5660,5747-5775` | Conflict-alert set computed twice per rebuild — inline set plus per-task _conflictIds() memo |
| [R156](#r156) | 🟡 | performance | `app.js:5727,882-886` | linesForSelectedPlant re-scans the global task array and re-filters every rebuild instead of using the maintained plant index |
| [R157](#r157) | 🟡 | performance | `app.js:5804,5861-5862` | Repeated string-parsed Date construction on the rebuild path (past-zone constant and per alert-cell) |
| [R158](#r158) | 🟡 | performance | `app.js:6384-6431` | _refreshChipButtons rebuilds STATUS_LABEL and recomputes today/tomorrow keys twice on every call |
| [R159](#r159) | 🟡 | performance | `app.js:6472-6478` | redrawRows() on every alerts:change destroys/rebuilds all visible row DOM instead of refreshing the alert column |
| [R160](#r160) | 🟡 | performance | `app.js:6509-6515, 6763-6779` | _onCellChanged re-parses an already-parsed Date returned by _DateTimeEditor.getValue |
| [R161](#r161) | 🟡 | performance | `app.js:7371, 7721, 882-885` | linesForSelectedPlant() recomputed multiple times per Dashboard render (O(allLines) each) |
| [R162](#r162) | 🟡 | performance | `app.js:7670` | _renderLineStatus builds a separate uncached 1-day utilization matrix per dashboard render |
| [R163](#r163) | 🟡 | performance | `app.js:7794-7805` | _gotoLine measures group heights with a getBoundingClientRect loop (forced reflow per row) |
| [R164](#r164) | 🟡 | performance | `app.js:7827-7854, 7863-7869` | Lateness heatmap pre-allocates a full lines x days cell object for every line, including all-zero rows |
| [R165](#r165) | 🟡 | performance | `app.js:8086-8093` | TimelineNav reassigns canvas.width/height every render, forcing a full backing-store reallocation and clear |
| [R166](#r166) | 🟡 | performance | `app.js:8154-8163` | TimelineNav.render recomputes line index per task via Array.indexOf — O(tasks × lines) on every Store change |
| [R167](#r167) | 🟡 | performance | `app.js:8154-8163` | TimelineNav.render does O(tasks x lines) lookups via lineArr.indexOf in the per-task draw loop |
| [R168](#r168) | 🟡 | performance | `app.js:8442-8452` | GanttFilter._doApply rebuilds each item's className via split/filter/join for every scoped task on every filter apply |
| [R169](#r169) | 🟡 | performance | `app.js:8926, 8935` | Optimize-preview KPI path rebuilds the utilization matrix twice, bypassing the memo |
| [R170](#r170) | 🟡 | performance | `app.js:9576` | Hover-preview card linearly scans all alerts per render |
| [R171](#r171) | 🟡 | performance | `app.js:9636-9638` | Hover-preview registers a document-level keydown listener that runs on every keystroke for the page lifetime |
| [R172](#r172) | 🟡 | performance | `app.js:10219-10221` | _navigateSelection recomputes the full sorted distinct-line list on every arrow keypress, unused for Left/Right |
| [R173](#r173) | 🟡 | performance | `app.js:11288-11294` | Permanent document-level mouseover listener for help tooltips stays bound for the page lifetime, even when the admin tab is closed |
| [R174](#r174) | 🟡 | performance | `app.js:11835-11846, 11852-11862` | _updatePurgeCount scans the entire Store.tasksArr on every flatpickr date change ⚖️ |
| [R175](#r175) | 🟡 | performance | `app.js:13497-13510` | PlantSelector dropdown rebuilds entire DOM and rebinds N listeners on every keystroke |
| [R176](#r176) | 🟡 | performance | `app.js:14318-14322, 14835-14842` | _applyFilter reads tr.textContent for every row on every keystroke (no debounce, full layout-touching scan) |
| [R177](#r177) | 🟡 | performance | `app.js:14425-14430, 14418` | _appendRow recomputes added/deleted/dirty membership per row via linear scan during full-table render |
| [R178](#r178) | 🟡 | performance | `app.js:14696-14711, 14769-14791` | cascade-preview fetched twice for the same delete (once on row delete, again on save) |
| [R179](#r179) | 🟡 | performance | `app.js:14807-14825` | _save full-reloads the active table plus refetches plants and production_lines on every save (no incremental update) |
| [R180](#r180) | 🟡 | performance | `brain.py:449-453` | apply_color_merge all-plants branch loops over every plant's wheel applying a full-column boolean mask per plant (O(plants x rows)) |
| [R181](#r181) | 🟡 | performance | `brain.py:733` | Paged /tasks requests fire a second full COUNT(*) query for meta.total on every request |
| [R182](#r182) | 🟡 | performance | `brain.py:1020-1040` | GET /color-wheel/{plant} re-reads and re-parses the xlsx from disk on every request despite the in-memory PLANT_CWS cache |
| [R183](#r183) | 🟡 | performance | `brain.py:1077-1083` | list_color_wheels does a regex sanitize per (file x meta-key) comparison to cross-reference stale meta |
| [R184](#r184) | 🟡 | performance | `brain.py:1314-1332` | GET /diagnostics/db runs eight DB queries serially, each checking out its own pool connection |
| [R185](#r185) | 🟡 | performance | `db.py:586-607` | Admin diagnostics issue unbounded catalog scans (get_db_table_stats / get_db_index_usage have no LIMIT) |
| [R186](#r186) | 🟡 | performance | `master_data.py:227-284` | bulk_apply rebuilds identical composed SQL for every upsert/delete row instead of batching |
| [R187](#r187) | 🟡 | performance | `master_data.py:609-611` | upsert_labor_plan / upsert_labor_plan_line use O(n^2) list-membership to split delete vs upsert |
| [R188](#r188) | 🟡 | performance | `nimbus-intelligence.js:416-436, 1138-1145, 597-599` | Opening the Command Palette runs Utilization.computeMatrix synchronously on the main thread (NeedsEngine._readState) — main-thread stall at scale |
| [R189](#r189) | 🟡 | performance | `nimbus-intelligence.js:614-698` | NeedsEngine intent-bank literal (7 entries + closures) is rebuilt on every keystroke in need:/! mode |
| [R190](#r190) | 🟡 | performance | `nimbus-intelligence.js:1293-1308` | Confidence recompute is triggered twice per mutation (Store subscription + Alerts.recompute monkey-patch) |
| [R191](#r191) | 🟡 | performance | `nimbus-intelligence.js:1364-1402` | Confidence._sparkline re-reads the canvas and redraws the entire history on every score apply |
| [R192](#r192) | 🟡 | performance | `nimbus-intelligence.js:1730-1755` | RipplePreview._show filters+sorts the entire line task set on every hover-move to take only the first 5, plus per-id querySelector layout reads |
| [R193](#r193) | 🟡 | performance | `nimbus-intelligence.js:1730-1755` | RipplePreview ghost positioning does a querySelector + getBoundingClientRect per downstream item in a hover loop |
| [R194](#r194) | 🟡 | performance | `nimbus-intelligence.js:1978-2007` | Diff.showUI re-serializes the entire live task list on every snapshot-row click |
| [R195](#r195) | 🟡 | performance | `nimbus-intelligence.js:2097-2100` | LangSwitcher.set forces a full location.reload() on language change |
| [R196](#r196) | 🟡 | illogical-pattern | `app.js:676-685` | updateMany mutates task objects in place while updateTask replaces the reference, breaking identity-diffing for the bulk optimizer path |
| [R197](#r197) | 🟡 | illogical-pattern | `app.js:7096-7107` | Hierarchy utilization chip mixes ending-today load with starting-today task list |
| [R198](#r198) | 🟡 | illogical-pattern | `app.js:8722-8733` | Selection.add sets anchor to the last element of the passed array even when that id was already selected (no net change attributable to it) |
| [R199](#r199) | 🟡 | illogical-pattern | `app.js:14302-14323, 14835-14842` | Active search filter is silently reset whenever the grid re-renders (add/paste/delete/dirty-save) |
| [R200](#r200) | 🟡 | illogical-pattern | `app.js:14696-14721, 14768-14791` | Deleting a saved subnetwork/plant triggers two separate cascade-preview fetches and two confirm dialogs |
| [R201](#r201) | 🟡 | illogical-pattern | `brain.py:783-784, 850-857` | Bulk-update 'persisted < total' warning fires spuriously for no-op (dateless) tasks |
| [R202](#r202) | 🟡 | illogical-pattern | `nimbus-intelligence.js:586-592` | NeedsEngine 'diff-available' need uses an inverted confDelta guard that hides the suggestion exactly when confidence is degrading ⚖️ |
| [R203](#r203) | 🟡 | illogical-pattern | `nimbus-intelligence.js:1308` | CLAUDE.md contradiction: documented arity-0 Alerts.recompute monkey-patch is no longer present |
| [R204](#r204) | 🟡 | unused-code | `app.js:2675-2688, 2811-2825` | Duplicated lerpRGB/heatBg heat-map helpers defined inline twice, rebuilt on every render |
| [R205](#r205) | 🟡 | unused-code | `app.js:6541-6552` | _onRowClicked is defined but never wired into gridOptions — dead code / Inspector unreachable from the orders Table |
| [R206](#r206) | 🟡 | unused-code | `app.js:8258-8271` | GanttFilter.matches checks colors/forms but isActive()/badge never account for selected lines; matches() ignores line selection entirely |
| [R207](#r207) | 🟡 | unused-code | `app.js:8480-8514` | DependencyOverlay declares _unsubStore/_unsubRange but never assigns _unsubRange, and never tears down the rangechange handlers |
| [R208](#r208) | 🟡 | unused-code | `app.js:9967, 9978, 9996` | Dead variable: skippedFixed is always empty, gating an unreachable toast in multi-order drag |
| [R209](#r209) | 🟡 | unused-code | `app.js:11093` | _lastQuarantineKey is written but never read — dead write |
| [R210](#r210) | 🟡 | unused-code | `app.js:15069-15080` | Memory watchdog setInterval relies on non-standard performance.memory (Chromium-only) and never clears |
| [R211](#r211) | 🟡 | unused-code | `brain.py:725-732` | meta payload ships the entire stateless-stale DIAGNOSTICS dict (lines{}, warnings[], dropped_* counters) on every /tasks response |
| [R212](#r212) | 🟡 | unused-code | `db.py:129-138` | Dead function: load_orders_df() has no callers |
| [R213](#r213) | 🟡 | unused-code | `master_data.py:56-57` | _row_key helper is defined but never used (dead code) |
| [R214](#r214) | 🟡 | unused-code | `styles.css:163-165, 292-294, 794-796` | Duplicated webkit-scrollbar rule blocks repeated across many components |
| [R215](#r215) | 🟡 | maintainability | `app.js:318-333` | countChangeovers uses Date-subtraction comparator and walks the task set redundantly with scheduleKpis |
| [R216](#r216) | 🟡 | maintainability | `app.js:963-984` | _indexBlocks buckets line-scoped blocks without plant filtering, so the optimizer block index carries every plant's line blocks |
| [R217](#r217) | 🟡 | maintainability | `app.js:4120-4140` | applyFix overload undo correctness depends on a comment-only coupling to Engine.runAndApply's internal free-set predicate |
| [R218](#r218) | 🟡 | maintainability | `app.js:4927-4932` | _displayDate hardcodes 'en-US' locale, bypassing NIMBUS i18n in the optimize date summary |
| [R219](#r219) | 🟡 | maintainability | `app.js:6187-6195` | Outside-click/Escape document listeners in Table.init are anonymous, never removed, and re-added on re-init |
| [R220](#r220) | 🟡 | maintainability | `app.js:7567-7587, 7871-7885` | _renderHeatmap reads document.body.dark and rebuilds color closures on every render |
| [R221](#r221) | 🟡 | maintainability | `app.js:8027-8068` | TimelineNav registers window-level mousemove/mouseup/resize listeners and a Store subscription that are never removed; _unsubStore is stored but never invoked |
| [R222](#r222) | 🟡 | maintainability | `app.js:9255` | Multi-inspector panel hardcodes light-mode color, breaking in dark mode |
| [R223](#r223) | 🟡 | maintainability | `app.js:10355-10367, 10397-10409, 10511-10527` | Backend load path runs the master-data fetch as a duplicated 3-way inline block in three places |
| [R224](#r224) | 🟡 | maintainability | `app.js:10895-10912` | _post network-retry comment says 'up to 3 times' but performs at most 2 retries (3 attempts total) |
| [R225](#r225) | 🟡 | maintainability | `app.js:13757-13758, 14166-14181` | App.init wires window-level mousemove/mouseup resize listeners with no teardown; safe today but a leak vector if init can re-run |
| [R226](#r226) | 🟡 | maintainability | `app.js:14025-14029, 14122-14126, 14146-14149` | _renderSettingsPane uses raw fetch instead of the standard Util.fetchTraced wrapper |
| [R227](#r227) | 🟡 | maintainability | `app.js:14281, 14524, 14698, 14771, 14794, 14914, 14944, 14970, 15019` | MasterData CRUD fetches bypass fetchTraced — no x-request-id correlation, no timeout on column DDL / save / load |
| [R228](#r228) | 🟡 | maintainability | `index.html:49-900` | ~850 lines of component CSS embedded as inline <style> in index.html instead of styles.css |
| [R229](#r229) | 🟡 | maintainability | `index.html:948, 965, 1069-1088, 1883, 2016` | Pervasive inline onclick/oninput handlers couple markup to global NIMBUS namespace and block any future CSP ⚖️ |
| [R230](#r230) | 🟡 | maintainability | `master_data.py:124-126` | list_rows ORDER BY assumes the first N display columns are exactly the key columns — latent coupling that silently mis-sorts if column_order is ever edited |
| [R231](#r231) | 🟡 | maintainability | `master_data.py:124-126` | list_rows ORDER BY key-column slice computed via convoluted list().__len__() call |
| [R232](#r232) | 🟡 | maintainability | `migration_perf.sql:18-19` | idx_orders_line_eff_start duplicated across schema.sql and migration_perf.sql; non-CONCURRENT build blocks writes at target scale |
| [R233](#r233) | 🟡 | maintainability | `nimbus-intelligence.js:905` | 'Reload Data' command sub-text claims 'Re-read Excel' though runtime data is Postgres-backed -- stale, misleading copy |
| [R234](#r234) | 🟡 | maintainability | `nimbus-intelligence.js:2027-2041` | Patterns._pairs grows without bound and writes localStorage synchronously on every timeline drag |
| [R235](#r235) | 🟡 | maintainability | `nimbus-worker.js:280-285` | Near-capacity branch condition is structured differently in worker vs app.js (gate moved into the else-if test) |
| [R236](#r236) | 🟡 | maintainability | `nimbus-worker.js:444` | Worker hardcodes day-length literal 86400000 instead of mirroring Config.MS_DAY used in app.js computeMatrix |
| [R237](#r237) | 🟡 | maintainability | `schema.sql:249-259` | labor_plan_line has no foreign key to plants/production_lines, allowing orphan labor rows on plant/line delete |
| [R238](#r238) | 🟡 | maintainability | `styles.css:59-60, 4136` | Admin tab tint tokens (--tab-admin-bg / --tab-admin-bg-hover) not redefined in dark mode |

## Detailed findings


# 🔴 High severity

<a id="r1"></a>
### R1. Stored XSS: audit-log `action` rendered via innerHTML from an unvalidated backend dict

`app.js:12990-2999`  ·  **HIGH**  ·  _security_  ·  confidence: high

**Why it matters.** `action` comes from `it.action` on the `/audit/log` GET response and is interpolated raw into `innerHTML`. The backend `POST /audit/log` (brain.py:1116-1122) accepts an arbitrary `entry: dict` and only `setdefault`s `ts`/`user` — it does NOT validate or whitelist `action`. Any client that can POST to `/audit/log` (the route is not behind `require_api_key`, and actor identity is the spoofable `X-User` header) can store an `action` string like `<img src=x onerror=...>` which then executes in the admin's browser when the audit log pane renders. Every other field in this table (`user`, `plant`, `details`, `ts`) is correctly rendered via `textContent`; `action` is the sole innerHTML sink, making this an inconsistency as well as a vulnerability. The frontend ACTION_ICONS/ACTION_COLORS maps only cover four known actions but the raw `action` is still printed regardless of whether it matched a known key.

**Evidence.**

```
cells.forEach((c, i) => {
  const td = document.createElement('td');
  if (i === 2) {
    td.innerHTML = `<span style="color:${color};font-weight:600;">${icon} ${action}</span>`;
  } else {
    td.textContent = c;
  }
```

**Suggested fix.** Render `action` via textContent, not innerHTML. Build the span with DOM APIs: `const span=document.createElement('span'); span.style.color=color; span.style.fontWeight='600'; span.textContent=`${icon} ${action}`; td.appendChild(span);`. Additionally validate/whitelist `action` server-side in `append_audit_log`.

**Verification.** At line 12993 `td.innerHTML = `<span style="color:${color};font-weight:600;">${icon} ${action}</span>`` interpolates `action` (from `it.action`, line 12977) raw, while every sibling cell uses textContent — a genuine stored-XSS sink fed by an unvalidated backend field.

---

<a id="r2"></a>
### R2. Color-wheel upload/delete routes are unauthenticated while every other destructive route is API-key gated

`brain.py:973-1062`  ·  **HIGH**  ·  _security_  ·  confidence: high

**Why it matters.** Every other write/destructive/DDL route in this region carries `dependencies=[Depends(require_api_key)]` — `/upload` (905), `/purge` (937), `/master-data/{table}/bulk` (1165), the column DDL routes (1191/1211/1222), `/master-data/plants/{plant}/constraints` (1243), and both `/maintenance/*` routes (1341/1353). The color-wheel POST (overwrites a file on disk and mutates the in-process PLANT_CWS cache) and DELETE (calls `os.remove(path)` and pops cache) have NO such dependency. When NIMBUS_API_KEY is set for a hosted deployment, an unauthenticated caller can still overwrite or delete any plant's color wheel, directly changing optimizer sequencing for that plant (colorWheel is the one constraint wired into the Engine). This contradicts the deployment intent stated in CLAUDE.md that NIMBUS_API_KEY 'gates the destructive/DDL/maintenance routes'.

**Evidence.**

```
@api.post("/color-wheel/{plant}")
async def upload_color_wheel(plant: str, request: Request, file: UploadFile = File(...)):
    """Upload or replace a plant-specific color wheel xlsx."""
    ...
@api.delete("/color-wheel/{plant}")
def delete_color_wheel(plant: str, request: Request):
    """Delete a plant's uploaded color wheel file."""
    ...
    os.remove(path)
```

**Suggested fix.** Add `dependencies=[Depends(require_api_key)]` to the `@api.post("/color-wheel/{plant}")` and `@api.delete("/color-wheel/{plant}")` decorators, matching `/upload` and `/purge`.

**Verification.** At lines 973 and 1043 the @api.post and @api.delete color-wheel decorators carry no dependencies, while /upload (905), /purge (937), bulk (1165), columns (1191), constraints, and both /maintenance routes (1341/1353) all have dependencies=[Depends(require_api_key)]; the DELETE does os.remove(path) at 1049.

---

<a id="r3"></a>
### R3. Fractional working hours (08:30 etc.) are silently floored to the hour by setHours() in _dayWindow

`app.js:987-994`  ·  **HIGH**  ·  _bug-error_  ·  confidence: high

**Why it matters.** Working hours are stored as fractional hours: Calendar._tToH returns `h + m/60` (line 1361-1363), and the UI offers 30-minute granularity everywhere it edits hours (`minuteIncrement: 30` at lines 1471/1477/3153, and the Calendar-tab flatpickr at 1265-1266). So an 08:30 start is stored as 8.5. But `_dayWindow` passes that fraction to `Date.prototype.setHours(h1, 0, 0, 0)`. Per ECMAScript, setHours truncates its hour argument to an integer and takes minutes from the second argument (here a hard-coded 0), so `setHours(8.5,0,0,0)` yields 08:00:00, NOT 08:30. The half-hour is discarded. Meanwhile ProdLines._fmtHour (line 2135-2141) DOES render the minutes ("8:30am"), so the roster/pills display 08:30 while the capacity engine computes the day as starting at 08:00. Every downstream consumer is affected: dailyCapacityHours/effectiveCapacityHours (line 1043-1074), workWindow intersection (1025-1026), isAvailable, nextAvailable snapping, the optimizer's greedy placement, Utilization, and Alerts 'closed'/overload rules. Net effect: capacity is mis-computed by up to 30 min per boundary per day per line — at 3,500+ lines this is large, persistent, invisible drift between displayed and actual schedules. The bug is mirrored identically in nimbus-worker.js _dayWindow (lines 121-122), so the worker and main-thread agree with each other but both are wrong.

**Evidence.**

```
_dayWindow(workHours, date) {
  const d = new Date(date);
  const wh = workHours[d.getDay()];
  if (!wh) return null;
  const [h1, h2] = wh;
  const start = new Date(d); start.setHours(h1, 0, 0, 0);
  const end   = new Date(d); end.setHours(h2, 0, 0, 0);
  return [start, end];
}
```

**Suggested fix.** Split the fractional hour into hours+minutes before applying: `const hh = Math.floor(h1), mm = Math.round((h1-hh)*60); start.setHours(hh, mm, 0, 0);` (same for h2/end). Apply the identical fix in nimbus-worker.js lines 121-122 to keep the hand-port in sync. Alternatively store workHours in minutes-since-midnight and convert once.

**Verification.** app.js 992-993 calls start.setHours(h1,0,0,0) with h1 being the fractional hour from _tToH (1361-1363: h + m/60) and minuteIncrement:30 is set at 1471/1477; setHours truncates the hour arg and uses the hard-coded 0 minutes, dropping the half-hour; mirrored identically in nimbus-worker.js 121-122.

---

<a id="r4"></a>
### R4. Timeline.zoomToFit() ignores the selected-plant filter and zooms to all plants' tasks

`app.js:5998-6007`  ·  **HIGH**  ·  _bug-error_  ·  confidence: high

**Why it matters.** Every other path in Timeline scopes to the selected plant: rebuild() uses Store.tasksForSelectedPlant() (line 5715) and the whole view is plant-filtered. But zoomToFit() reads Store.tasksArr, which is `Object.values(this._state.tasks)` (line 578) — ALL tasks across ALL plants. The computed min/max window therefore spans the earliest/latest order in the entire system, not the visible plant. The user sees a viewport zoomed far wider than the rows actually rendered for the current plant, with most of the screen empty. At the documented scale target (50+ plants, 3,500+ lines) this makes 'zoom to fit' effectively useless — it fits a horizon driven by unrelated plants. This contradicts the CLAUDE.md invariant that the selected plant is a true global filter.

**Evidence.**

```
zoomToFit() {
  if (!Timeline._tl) return;
  const tasks = Store.tasksArr.filter(t => t.start_date && t.end_date);
  if (!tasks.length) return;
  const minT = Math.min(...tasks.map(t => t.start_date.getTime()));
  const maxT = Math.max(...tasks.map(t => t.end_date.getTime()));
```

**Suggested fix.** Use the plant-scoped accessor like rebuild() does: `const tasks = Store.tasksForSelectedPlant().filter(t => t.start_date && t.end_date);` (and apply the GanttFilter visible-line scope if you want it to match exactly what is on screen).

**Verification.** Line 6000 reads Store.tasksArr (Object.values of all tasks, line 578 = all plants) while rebuild() at line 5715 uses Store.tasksForSelectedPlant(); the inconsistency and plant-blind window are genuinely present.

---

<a id="r5"></a>
### R5. _persistNote shared debounce timer drops note saves across different orders

`app.js:6984-6997`  ·  **HIGH**  ·  _bug-error_  ·  confidence: high

**Why it matters.** _persistNote is created ONCE as a module-level Util.debounce-wrapped function (single shared closure timer `t`). debounce(fn,wait) keeps one timer and clears it on every call, so successive calls for DIFFERENT task ids within 800ms cancel each other — only the LAST id/notes pair is ever POSTed to /task/note. It is invoked from Inspector notes blur (6924), Inspector._onFieldChange notes branch (6972), AND Table._saveNotePopover (6745). A user who edits a note on order A then quickly edits/saves a note on order B (or saves the note popover then blurs the inspector) within 800ms silently loses order A's backend persistence — the note survives only in the in-memory Store/localStorage and is lost on the next backend refetch (which is last-writer-loses per the concurrency model). This is a real data-integrity bug on a fast-typing/fast-switching user.

**Evidence.**

```
_persistNote: Util.debounce(function(id, notes) {
  fetch(`${Config.API_BASE}/task/note`, { method: 'POST', ... body: JSON.stringify({ id, notes }) })
  ...
}, 800),
```

**Suggested fix.** Key the debounce per task id, e.g. maintain a Map of id->timer (or debounce the network layer per id). Minimal fix: replace the single shared debounce with a small per-id debounce dispatcher so notes for distinct orders are not mutually cancelling: `const _noteTimers = {}; _persistNote(id, notes){ clearTimeout(_noteTimers[id]); _noteTimers[id] = setTimeout(() => { /* fetch */ }, 800); }`.

**Verification.** Util.debounce (line 259-261) uses a single closure timer `t` cleared on every call, and _persistNote is a single module-level debounced fn invoked with different ids from 6745, 6924 and 6972, so rapid notes on distinct orders within 800ms mutually cancel — only the last id is POSTed.

---

<a id="r6"></a>
### R6. Failed optimize leaves the schedule partially mutated with no revert path

`app.js:8897-8959`  ·  **HIGH**  ·  _bug-error_  ·  confidence: high

**Why it matters.** Engine.runAndApply(mode, opts) mutates the live Store in place. If it throws partway through (e.g. mid auto-reflow, mid placement), the catch block only logs and shows an 'Optimization failed' panel — it never reverts. The local `snapshot` taken at line 8906 is published to OptimizerPreview._snapshot only at line 8938, AFTER runAndApply returns successfully. So on an exception the snapshot is discarded, _snapshot stays at its prior value (often null), and neither Apply (line 8166 returns early when !snap) nor Discard (line 8178) can roll back the half-applied mutation. The user is left with a corrupted, partially-optimized schedule and no undo entry.

**Evidence.**

```
const snapshot = UndoStack.snapshotTasks(ids);
...
// Run the optimizer in place.
Engine.runAndApply(mode, opts);
...
OptimizerPreview._snapshot = snapshot;   // line 8938, only reached on success
...
} catch (err) {
  ErrorLog.error('optimize-preview', err?.message || String(err));
  if (body) { body.innerHTML = ...'Optimization failed'... }
  footBtns.forEach(b => { b.disabled = false; });
}
```

**Suggested fix.** Move OptimizerPreview._snapshot = snapshot to immediately after the snapshot is taken (before Engine.runAndApply), or in the catch block call UndoStack.restoreTasks(snapshot) (the local var) and Alerts.scheduleRecompute() to roll the Store back to the captured state before showing the failure panel.

**Verification.** Engine.runAndApply mutates the Store in place at line 8930; OptimizerPreview._snapshot is assigned only at 8938 after success, the catch block (8946-8955) only logs and shows a panel without calling UndoStack.restoreTasks(snapshot), and both apply() (9166) and discard() (9178) no-op when _snapshot is null, so a mid-run throw leaves no rollback path.

---

<a id="r7"></a>
### R7. saveAll() clears dirty/force ids before the partial-save check, so un-persisted rows are never retried (silent data loss)

`app.js:10918-10947`  ·  **HIGH**  ·  _bug-error_  ·  confidence: high

**Why it matters.** On any HTTP 200, both _dirtyIds and _forceIds are unconditionally cleared at the top of the success handler (10918-10919). The partial-save branch at 10941 detects that fewer rows persisted than were sent (persisted < total) and merely warns the user — but the dirty set is already empty, so those un-persisted edits are dropped from the next saveAll() payload. The user sees a 'partial save' toast but the missing rows are never auto-retried and will be lost on reload (backend has the old dates). CLAUDE.md acknowledges this as current behavior ('on a partial save it clears all dirty ids before checking persisted < total, so un-persisted rows are not auto-retried'), confirming it is a real, intentional-but-risky gap. At the 3,500-line scale a partial backend write silently strips scheduling work.

**Evidence.**

```
Persistence._dirtyIds.clear();
          Persistence._forceIds.clear();
          ... 
          const persisted = result.persisted ?? 0;
          const total     = result.updated   ?? 0;
          if (stale.length) {
          } else if (persisted < total) {
            ErrorLog.warn('persistence', `Partial DB save: ${persisted}/${total} persisted`, result);
            Toast.show(t('toast.partial_db_save', { persisted, total }), 'warn', 6000);
```

**Suggested fix.** Compute the set of ids actually persisted (from result.versions keys plus stale ids that were refetched) and only clear those from _dirtyIds/_forceIds. Leave any sent-but-not-persisted ids dirty so the next explicit save retries them. E.g. const persistedIds = new Set([...Object.keys(versions), ...stale]); for (const id of persistedIds) { _dirtyIds.delete(id); _forceIds.delete(id); } instead of .clear().

**Verification.** At lines 10918-10919 both _dirtyIds and _forceIds are unconditionally .clear()'d on any HTTP 200, then the partial-save branch at 10941 (persisted < total) only warns — the dirty set is already empty so un-persisted rows are dropped from the next payload; CLAUDE.md also documents this as current behavior.

---

<a id="r8"></a>
### R8. Cross-plant order misattribution: ORDER BY pl.plant LIMIT 1 silently picks the lowest plant code when a line is shared across plants

`db.py:1062-1073 (also 220-237 in reattribute_null_plant_orders)`  ·  **HIGH**  ·  _bug-error_  ·  confidence: high

**Why it matters.** The plant-derivation subquery joins production_lines on the line CODE alone and resolves ties with ORDER BY pl.plant LIMIT 1. The inline comment calls this 'deterministic even if a line code is ever shared across plants', but determinism is not correctness: when line code L exists under plants 1006 and 5512, every order for L without an explicit upload plant is attributed to 1006 (the lexically smallest) regardless of which plant it truly belongs to. At the stated scale target (50+ plants, line codes WILL collide across plants - this is the documented make_id limitation), this silently routes orders to the wrong plant, and the plant-scoped GET /tasks read path (o.plant = %s) then shows them on the wrong plant's board or hides them from the correct one. make_id being plant-blind compounds this: two real orders on the same line code+material in different plants collide to one row entirely.

**Evidence.**

```
UPDATE orders o
   SET plant = (
       SELECT pl.plant FROM production_lines pl
        WHERE pl.production_line = o.production_line
        ORDER BY pl.plant LIMIT 1
   )
 WHERE o.upload_batch_id = %s AND o.plant IS NULL
```

**Suggested fix.** Derivation by line code alone cannot be made correct once codes are reused. Require an authoritative plant on the upload (WERKS/PLANT column or an upload-time plant picker) and make it mandatory rather than deriving; until then, when the subquery would match multiple distinct plants, leave plant NULL and emit an upload warning rather than guessing the smallest. Plant must also become part of make_id before line codes are reused across plants (already flagged in MIGRATION.md).

**Verification.** Lines 1062-1073 and 220-237 both derive plant via SELECT pl.plant ... WHERE pl.production_line = o.production_line ORDER BY pl.plant LIMIT 1, joining on line code alone; the comment itself admits determinism (not correctness) when a line code is shared across plants, which CLAUDE.md confirms WILL collide at scale.

---

<a id="r9"></a>
### R9. cascade_preview has no branch for 'materials' — silently reports 0 cascading children while the actual delete cascades material_plants rows

`master_data.py:173-206`  ·  **HIGH**  ·  _bug-error_  ·  confidence: high

**Why it matters.** schema.sql defines material_plants with a FOREIGN KEY on material_id REFERENCES materials(material_id) ON DELETE CASCADE (lines 165-167). cascade_preview only has branches for 'subnetworks' and 'plants'; there is no 'materials' branch. When the user previews deleting a material that has material_plants children, the preview returns the default {"plants": 0, "production_lines": 0} (and never any material_plants count), so the UI shows zero downstream impact. The subsequent bulk_apply DELETE (lines 229-239) then cascades and silently destroys all matching material_plants rows. The preview's entire purpose — warn before a destructive cascade — is defeated for the materials table, risking silent loss of per-plant material configuration (lot sizes, production versions, status).

**Evidence.**

```
def cascade_preview(table: str, deletes: list[dict]) -> dict:
    """Return how many child rows would cascade-delete if these rows are removed."""
    _assert_table(table)
    if not deletes:
        return {"plants": 0, "production_lines": 0}
    result = {"plants": 0, "production_lines": 0}
    with _pool.connection() as conn, conn.cursor() as cur:
        if table == "subnetworks":
            ...
        elif table == "plants":
            ...
    return result

# schema.sql: material_plants ... REFERENCES materials(material_id) ON DELETE CASCADE ON UPDATE CASCADE
```

**Suggested fix.** Add an `elif table == "materials":` branch that counts child material_plants rows for the material_ids being deleted, e.g. `SELECT COUNT(*) FROM material_plants WHERE material_id = ANY(%s)`, and include `material_plants` in the returned result dict. Also seed the default return (line 177) with all child-table keys that can ever appear so callers can render them.

**Verification.** cascade_preview (lines 173-206) only has 'subnetworks' and 'plants' branches and returns the default {plants:0, production_lines:0} for materials, while schema.sql lines 165-167 define material_plants with ON DELETE CASCADE on material_id, so previewing a materials delete reports zero impact despite a real cascade.

---

<a id="r10"></a>
### R10. dailyCapacityHours re-scans ALL blocks and re-parses every date on every call in the live (non-optimizer) path

`app.js:1043-1063`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** The pre-indexed/pre-parsed block cache (Calendar._runBlocks, built once by _indexBlocks in _beginRun) is ONLY installed for the duration of Engine.runAndApply (line 4552 _beginRun / finally _endRun). dailyCapacityHours never consults _runBlocks -- it always does a fresh linear scan over Store.blocks + Store.plantBlocks and calls Util.parseDate (which does `new Date(v)`, lines 100-105) on EACH block's start and end. On the UI render path (_runBlocks/_runCache are null) this runs for every line x day cell. computeMatrix (4231) calls it for every (line,day); dayByLine (4319) calls it per line; the today summary (7103) calls it per line. With B blocks, L lines, D days the cost is O(L*D*B) Date allocations every matrix build. At the 3,500-line / 14-day target with hundreds of blackout blocks this is millions of throwaway Date objects per build -- main-thread GC pressure. _overlapsBlock (1141) already demonstrates the O(1) bucketed lookup pattern; dailyCapacityHours has no live-path equivalent.

**Evidence.**

```
dailyCapacityHours(line, date) {
  const win = Calendar.workWindow(line, date);
  if (!win) return 0;
  ...
  for (const b of Store.blocks) {
    if (b.line && b.line !== line) continue;
    const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
    if (s && e) intervals.push({ s, e });
  }
  for (const b of Store.plantBlocks) {
    if (b.plant && b.plant !== plant) continue;
    const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
    if (s && e) intervals.push({ s, e });
  }
```

**Suggested fix.** Give dailyCapacityHours (and isAvailable / dayByLine) the same bucketed, pre-parsed block index that _overlapsBlock uses via _runBlocks. Either (a) make _indexBlocks lazily built and invalidated on Store._rev so it is available on the render path, not just inside Engine runs, or (b) pre-parse Store.blocks/plantBlocks once per Store mutation (cache ms timestamps on the block objects) so parseDate is not re-run per cell. Reuse the byLine/byPlant Maps to skip the per-call linear `if (b.line !== line) continue` filter.

**Verification.** app.js 1050-1058 does a fresh linear scan over Store.blocks and Store.plantBlocks calling Util.parseDate per block on every call, and the bucketed _runBlocks index (1140-1159 via _overlapsBlock) is only consulted when _runCache/_runBlocks is non-null (Engine runs only), so the render path is unindexed.

---

<a id="r11"></a>
### R11. dailyCapacityHours re-parses all blackout blocks on every call and is invoked twice per matrix cell

`app.js:1043-1074, 4231-4232`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** dailyCapacityHours does NOT consult the Calendar._runBlocks pre-indexed cache (that cache is only installed by Engine.runAndApply via _beginRun, not during Utilization.computeMatrix). It re-parses every Store.blocks and Store.plantBlocks date string with Util.parseDate on each invocation. computeMatrix calls dailyCapacityHours once directly and once indirectly through effectiveCapacityHours per cell, so capacity is computed twice and all blackout blocks are parsed twice per cell. Cost scales as O(lines x days x blocks) for what should be O(lines x days) — and the date strings are re-parsed every render even though the block list rarely changes.

**Evidence.**

```
dailyCapacityHours: `for (const b of Store.blocks) { ... const s = Util.parseDate(b.start), e = Util.parseDate(b.end); if (s && e) intervals.push({ s, e }); } for (const b of Store.plantBlocks) { ... }`  effectiveCapacityHours: `const full = Calendar.dailyCapacityHours(line, date);`  computeMatrix cell init: `capacity: Calendar.dailyCapacityHours(line, d), effectiveCapacity: Calendar.effectiveCapacityHours(line, d),`
```

**Suggested fix.** Compute full capacity once per cell and derive effectiveCapacity from it (pass the precomputed full value into effectiveCapacityHours, or inline the buffer math). Pre-parse blackout blocks into ms once per computeMatrix call (a local index like _indexBlocks) and pass it down, or have dailyCapacityHours consult Calendar._runBlocks when present and have computeMatrix install a lightweight run-cache.

**Verification.** dailyCapacityHours (1050-1059) re-parses every Store.blocks/plantBlocks with Util.parseDate and consults no _runBlocks cache; effectiveCapacityHours (1068) calls it again, and computeMatrix invokes both per cell (4231-4232), giving two full block re-parses per cell.

---

<a id="r12"></a>
### R12. _renderKPIs rebuilds the entire utilization matrix on every aggregate cell edit and paste

`app.js:2552-2562, 2618, 2334-2367`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** Each committed edit to a single aggregate cell triggers _renderKPIs(plant), which calls computeMatrix over the full horizon (up to 90 days) for every plant line, then runs two more nested passes (plantLines x days for totalRequired, plantLines x days for shortfalls). Labor editing is inherently repeated per-cell; at 70 lines x 84-90 days this is ~6,000+ cell visits plus a full matrix rebuild per edit. The required/available numbers depend only on scheduled orders and per-line plan data which the aggregate edit does not change (it only changes _aggrData totals and auto-split _lineData) so the expensive utilization recompute is largely redundant per edit.

**Evidence.**

```
inp.onchange = async function() { ... _updateAggrTotals(grid); _renderKPIs(plant); ... }; and in paste: _updateAggrTotals(grid); _renderKPIs(plant);
_renderKPIs: const matrix = Utilization.computeMatrix(horizonStart, horizonDays); plantLines.forEach(line => { const lm = matrix[line]; ... Object.values(lm).forEach(...) }); plantLines.forEach(line => { ... Object.entries(lm).forEach(...) });
```

**Suggested fix.** Debounce _renderKPIs (300-500 ms trailing) so rapid edits/paste coalesce into one recompute. Since the matrix (scheduled hours from orders) does not change during labor editing, cache the matrix/totalRequired for the (plant, horizon) and recompute only the cheap totalAvail/shortfall aggregation on cell edits. Avoid calling full computeMatrix inside the onchange path.

**Verification.** The onchange handler (2562) and paste handler (2618) both call _renderKPIs(plant) synchronously with no debounce, and _renderKPIs (2346) calls computeMatrix over the full horizon plus two nested plantLines×days passes (2349-2367) on every committed edit.

---

<a id="r13"></a>
### R13. Alerts._recomputeSync overload loop re-parses every blackout block per (line,day) cell via dailyCapacityHours, ignoring the already-parsed block arrays in the same function

`app.js:3632-3641`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** `dailyCapacityHours` (app.js:1043) re-parses the dates of EVERY entry in `Store.blocks` and `Store.plantBlocks` (via `Util.parseDate`) on each call, and `workWindow`'s block-free memo (`_runCache`) is only populated inside an `Engine.runAndApply` cycle (`_beginRun`/`_endRun`, lines 953-961). `_recomputeSync` runs OUTSIDE any Engine run (it is the alert recompute path), so `_runCache` is null and there is no block-parse cache. The overload loop calls `dailyCapacityHours` once per (line,day) cell, giving O(cells x (blocks + plantBlocks)) `parseDate` calls per recompute. Worse, the same function already parsed all blocks once into `parsedBlocks`/`parsedPlantBlocks` at lines 3582-3591, but those arrays are used only by the blackout check (section 3) and are not reused for capacity. Because the sync path is the PERMANENT fallback once the worker errors (Compute sets `_dead=true` with no restart, per the module comment), and is also the path whenever no plant is selected, this is a real recurring main-thread cost that scales with both line count and blackout count toward the 3,500-line target.

**Evidence.**

```
for (const k of Object.keys(byLineDay)) {
  const { line, day, hours } = byLineDay[k];
  const dateObj = new Date(day + 'T12:00:00');
  const cap = Calendar.dailyCapacityHours(line, dateObj);
  // Inline effectiveCapacityHours to avoid a second dailyCapacityHours call
  ...
}
// dailyCapacityHours (lines 1043-1063):
//   for (const b of Store.blocks)      { ... Util.parseDate(b.start); Util.parseDate(b.end); ... }
//   for (const b of Store.plantBlocks) { ... Util.parseDate(b.start); Util.parseDate(b.end); ... }
```

**Suggested fix.** Reuse the already-parsed `parsedBlocks`/`parsedPlantBlocks` arrays inside the overload loop instead of calling `Calendar.dailyCapacityHours`. Either (a) compute capacity locally from `Calendar.workWindow` (already memo-light) plus `Util.mergedOverlapHours` fed by the pre-parsed, line/plant-filtered intervals, or (b) add an optional pre-parsed-intervals parameter to `dailyCapacityHours` so callers in a tight loop can pass blocks parsed once. This drops the per-cell block re-parse from O(blocks) to O(1) lookup.

**Verification.** The overload loop at 3632-3635 calls Calendar.dailyCapacityHours per (line,day) cell, and dailyCapacityHours (1050-1059) re-iterates Store.blocks/plantBlocks with Util.parseDate each call; _runCache is null outside an Engine run (3953-961) and the pre-parsed parsedBlocks/parsedPlantBlocks (3582-3591) are used only by the blackout check, confirming O(cells x blocks) re-parsing on the permanent sync fallback path.

---

<a id="r14"></a>
### R14. Dashboard 7-day utilization matrix bypasses memoization on every render (full O(lines x days) rebuild)

`app.js:4210-4216, 7316-7321, 7552-7557`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** Dashboard.render() always passes a non-null filtered task subset (_filtered) to computeMatrix, so cacheable is false and the memo (keyed on startMs|days|_rev) is never consulted OR populated for this path. The entire matrix is rebuilt from scratch on every dashboard render. render() is invoked on plant change, filter change, and a 300ms-debounced Store subscription (lines 7155/7170/7281/7288/13876), so a drag-storm or optimize run triggers repeated full rebuilds. Each rebuild is O(lines x days) cells, and per cell it calls BOTH Calendar.dailyCapacityHours AND Calendar.effectiveCapacityHours (which itself calls dailyCapacityHours again — 2 calls/cell), each of which re-parses every Store.blocks + Store.plantBlocks entry with Util.parseDate. At the 70+ lines/plant x 7 days target that is ~490 cells x 2 capacity calls x (all blackout blocks parsed) per render — pure repeated work that the memo was built to avoid.

**Evidence.**

```
computeMatrix: `const cacheable = srcTasks === null;` ... `if (cacheable && Utilization._cache && Utilization._cache.key === cacheKey) return ...matrix;`  Dashboard.render(): `const _filtered = Dashboard._filteredTasks();` `const _matrix7 = Utilization.computeMatrix(_now7, 7, _filtered);`
```

**Suggested fix.** Either (a) build the unfiltered Store-backed matrix once via computeMatrix(now,7) (srcTasks=null, hits the memo) and filter the returned line keys for the dashboard view, or (b) extend the cache key with a filter-set discriminator and allow filtered subsets to memoize too. Also memoize per-(line,day) capacity inside computeMatrix so effectiveCapacityHours does not recompute dailyCapacityHours.

**Verification.** render() passes the non-null _filtered subset to computeMatrix at 7318, so cacheable===false (4212) and the memo is neither read nor populated; the matrix is rebuilt each render as described.

---

<a id="r15"></a>
### R15. computeMatrix and dayByLine call both dailyCapacityHours AND effectiveCapacityHours per cell, doubling the full block scan

`app.js:4231-4232`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** effectiveCapacityHours (1067-1074) internally calls dailyCapacityHours(line, date) again (line 1068). So computeMatrix performs TWO complete full-block scans + workWindow computations for the same (line, day) cell -- the result of the first dailyCapacityHours call (stored as capacity) is discarded and recomputed inside effectiveCapacityHours. dayByLine has the identical pattern (line 4319 dailyCapacityHours then 4320 effectiveCapacityHours). This exactly doubles the already-expensive block-scan cost from finding #1. The developers ALREADY recognized and fixed this elsewhere: the Alerts overload path at line 3635-3641 carries the comment `// Inline effectiveCapacityHours to avoid a second dailyCapacityHours call (which would re-run workWindow + block iteration for the same line/day)` and inlines the buffer math -- but computeMatrix and dayByLine were never given the same treatment.

**Evidence.**

```
capacity:          Calendar.dailyCapacityHours(line, d),
effectiveCapacity: Calendar.effectiveCapacityHours(line, d),
```

**Suggested fix.** Compute cap = Calendar.dailyCapacityHours(line, d) once, then derive effectiveCapacity inline from the line's buffer settings (mirror lines 3638-3641: pct -> cap*(1-pct/100); hours -> max(0, cap-hours)). Apply the same single-call pattern in dayByLine (4319-4320). Halves the capacity-engine cost of every utilization/dashboard render.

**Verification.** app.js 4231-4232 and 4319-4320 call dailyCapacityHours then effectiveCapacityHours (which itself re-calls dailyCapacityHours at 1068), so the block scan runs twice per cell; the Alerts path at 3636-3641 already inlines the buffer math to avoid this but these two were not given the same treatment.

---

<a id="r16"></a>
### R16. Alerts column renderer + row-class do O(rows × alerts) linear scans on every grid redraw

`app.js:6056, 6122-6133, 6472-6478, 6553-6558`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** Store.alerts is a flat array (line 559). Both the alerts-count cellRenderer (6124) and _rowClass — invoked by defaultColDef.cellClass for EVERY cell (6056) — call Store.alerts.filter() with a full linear scan keyed on taskId. The cost is O(visibleRows × alerts) per redraw, and redrawRows() (6474) fires on EVERY alerts:change. The identical linear filter is duplicated at 6124, 6223, 6554, 6641, 6842 and 9576 with no shared index. At the 3,500-line scale target with a comparable alert population this is a quadratic main-thread hot path on every recompute.

**Evidence.**

```
defaultColDef.cellClass: p => Table._rowClass(p.data)  // runs per visible cell
// alerts column cellRenderer:
cellRenderer: p => { const rel = Store.alerts.filter(a => String(a.taskId) === String(p.value)); ... }
// _rowClass:
_rowClass(data) { ... const ids = Store.alerts.filter(a => String(a.taskId) === String(data.id)); ... }
// on every alerts:change:
} else if (evt.type === 'alerts:change') { Table._api.refreshCells({ columns: ['id'], force: true }); Table._api.redrawRows();
```

**Suggested fix.** Maintain an alerts-by-taskId index in Store (Store._alertsByTask = Map<taskId, alert[]>) rebuilt once per alerts:change, and have _rowClass, the alerts cellRenderer, _taskPassesChipFilters, _showAlertPopup, and Inspector read from the Map (O(1) lookup) instead of Store.alerts.filter(). Collapses O(rows × alerts) to O(rows).

**Verification.** defaultColDef.cellClass (6056) calls _rowClass which does Store.alerts.filter (6554), the alerts cellRenderer filters at 6124, and the same flat-array linear scan recurs at 6223/6641 — no shared index exists, so cost is O(visibleRows × alerts) per redraw.

---

<a id="r17"></a>
### R17. TimelineNav renders ALL plants' tasks (unscoped Store.tasksArr) instead of the selected plant

`app.js:8095-8096`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** render() reads Store.tasksArr (every order across every plant) rather than Store.tasksForSelectedPlant() (which the rest of the Gantt UI uses, e.g. Timeline.rebuild at line 5715 and GanttFilter._doApply at line 8441). At the scale target of 50+ plants the nav strip is the only Gantt component drawing the entire global order set, so its filter+map+set+sort+draw cost grows with total system size (3,500+ lines) regardless of which single plant is on screen. The utilization heat-band loop (line 8117 computeMatrix over the global cacheable path) and the dividers also span all lines. This both wastes work and visually misrepresents the nav (rows for lines not in the current plant).

**Evidence.**

```
const tasks = Store.tasksArr.filter(t => t.start_date && t.end_date);
if (!tasks.length || !Timeline._tl) return;
```

**Suggested fix.** Scope to the selected plant: const tasks = (Store.selectedPlant ? Store.tasksForSelectedPlant() : Store.tasksArr).filter(t => t.start_date && t.end_date); and derive lineArr from that scoped set, matching Timeline.rebuild/GanttFilter scoping.

**Verification.** Line 8095 reads Store.tasksArr (all plants per the getter at line 578) and line 8117 computes the utilization matrix globally, whereas the rest of the Gantt (Timeline.rebuild 5715, GanttFilter 8441) scopes to tasksForSelectedPlant; this both wastes work and draws rows for lines outside the current plant.

---

<a id="r18"></a>
### R18. Marquee hit-test reads getBoundingClientRect() for every timeline item on every pointermove and RAF tick

`app.js:9692-9729, 9774`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** updateOverlay() runs on every pointermove during a Ctrl/Cmd marquee drag AND on every edge-scroll RAF tick (line 9774: `if (scrolled) updateOverlay(...)`). Each call loops over EVERY rendered timeline item and calls box.getBoundingClientRect() per item. getBoundingClientRect() forces a synchronous layout/reflow; doing it N times in a tight loop at pointer/60fps frequency causes severe layout thrash. At the scale target (70+ lines/plant, hundreds of visible order boxes) this is O(visibleItems) forced reflows per frame and is the dominant cost of marquee selection. It is also interleaved with the overlay style writes at 9703-9706 (read-after-write), which can double the reflow count.

**Evidence.**

```
const hits = new Set();
for (const id of Object.keys(itemSet)) {
  if (!isOrderId(id)) continue;
  const box = itemSet[id]?.dom?.box;
  if (!box) continue;
  if (_rectsIntersect(rect, box.getBoundingClientRect())) hits.add(id);
}
```

**Suggested fix.** Cache each item box's rect once at marquee pointerdown (or recompute only boxes whose layout actually changed). Since edge-scroll panning moves all boxes by a known window-delta rather than re-laying-out, project box positions through the same window math used in getAnchorScreenX instead of re-reading the DOM each frame. At minimum, batch all getBoundingClientRect() reads before any overlay style writes.

**Verification.** updateOverlay (9692) loops over every item in itemSet and calls box.getBoundingClientRect() per item (9717) after writing overlay styles at 9703-9706 (read-after-write), and it is invoked from the edge-scroll RAF at line 9774, so it forces O(visibleItems) synchronous reflows per frame during a marquee drag.

---

<a id="r19"></a>
### R19. 60fps ghost-drag does an O(selected x allTasks) conflict scan on every timechange event

`app.js:10077-10101`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** _onTimeChange fires at ~60fps for the entire duration of a multi-order drag. For each selected companion it runs Store.tasksArr.some() over the FULL task array, and inside the predicate calls Selection.has(String(peer.id)) per peer (extra Set lookup + String allocation). Total cost per frame is O(selIds x tasksArr). With the 3,500-line scale target and a multi-selection of dozens of orders, every dragged frame performs tens of thousands of comparisons, defeating the 60fps goal the comment promises.

**Evidence.**

```
for (const sid of selIds) {
  const st = Store.tasks[sid];
  ...
  const hasConflict = Store.tasksArr.some(peer => {
    if (peer.id === sid || Selection.has(String(peer.id))) return false;
    if ((peer.PRODUCTION_LINE || 'Unknown') !== line) return false;
    if (!peer.start_date || !peer.end_date) return false;
    return ghostStart < peer.end_date && ghostEnd > peer.start_date;
  });
```

**Suggested fix.** Pre-bucket Store.tasksArr by PRODUCTION_LINE once when this._isDragging flips true (Map<line, task[]>, excluding selected ids) and reuse across frames; only ghostStart/ghostEnd change per frame. Hoist the selected-id Set out of the predicate (build it once per frame, not per peer).

**Verification.** Lines 10077-10092: for each selected companion the code calls Store.tasksArr.some(...) over the full task array, with Selection.has(String(peer.id)) and a String() allocation inside the predicate, run on every timechange frame, giving O(selIds x tasksArr) per frame as described.

---

<a id="r20"></a>
### R20. TimeMachine snapshots full task array + IndexedDB write on every UndoStack.push

`nimbus-intelligence.js:1163-1204`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** TimeMachine.init() monkey-patches UndoStack.push so that EVERY undoable action (every fix/unfix, push +1h, unschedule, drag, optimize, bulk edit) synchronously maps the ENTIRE Store.tasksArr into a fresh 9-field plain-object array and then writes it to IndexedDB. UndoStack is described as wrapping 'any destructive Store mutation', so this fires on the hottest mutation path. At the 3,500-line scale target (with multiple orders per line, easily tens of thousands of orders), each push allocates a full deep copy of all orders on the main thread and serializes it for structured-clone into IDB. This is O(allOrders) per action and is unscoped to the selected plant (snapshot copies all of tasksArr, then stamps a single plant field), so it scales with total system orders, not on-screen ones. Combined with the Store.subscribe handler at 1169-1174 also snapshotting on tasks:bulk/tasks:bulkUpdate, a single bulk update can trigger two full serializations.

**Evidence.**

```
init() {
  const origPush = UndoStack.push.bind(UndoStack);
  UndoStack.push = (label, undoFn) => {
    origPush(label, undoFn);
    TimeMachine.snapshot(label, { auto: true });
  };
  ...
snapshot(label, opts = {}) {
  const snap = {
    ...
    tasks: Store.tasksArr.map(t => ({ id: t.id, start_date: ... , end_date: ... , PRODUCTION_LINE: ..., PRODUCTION_ORDER: ..., text: ..., COLOR: ..., FORM_SIZE: ..., FIXED: !!t.FIXED, }))
  };
  IntelDB.put('snapshots', snap).then(id => { ... IntelDB.pruneSnapshots(200); }).catch(() => {});
```

**Suggested fix.** Debounce auto-snapshots (e.g. coalesce rapid pushes within ~1s into one snapshot), and/or scope the snapshot's tasks to the selected plant's lines (Store already scopes Compute snapshots this way). Move the object-map + IDB put off the synchronous push path (queue it via requestIdleCallback/microtask) so undo latency is not coupled to order count. Consider snapshotting only changed task ids for auto snapshots rather than the full array.

**Verification.** init() (lines 1164-1168) monkey-patches UndoStack.push to call snapshot(), which maps the entire Store.tasksArr into a 9-field object array (lines 1186-1196) and writes to IndexedDB; snapshot copies all tasksArr (unscoped to plant, only a single plant field stamped), so cost scales with total system orders as described.

---

<a id="r21"></a>
### R21. Confidence rebuilds a 14-day utilization matrix after every Alerts.recompute and every task mutation

`nimbus-intelligence.js:1304-1361`  ·  **HIGH**  ·  _performance_  ·  confidence: high

**Why it matters.** Confidence.init wraps Alerts.recompute so that Confidence._recompute fires (debounced 400ms) after EVERY alert recompute, in addition to firing on tasks:bulk/bulkUpdate/task:update/task:remove. _recompute calls Utilization.computeMatrix over the full confidence horizon (default 20160 minutes = 14 days), iterating O(lines x 14 days). computeMatrix is memoized only via a SINGLE-SLOT cache keyed on (startMs|days|Store._rev) (app.js 4213-4216). Because Dashboard and other callers request matrices with different (days) values and different start days, and because Store._rev bumps on every mutation, the single-slot cache is routinely evicted before Confidence can reuse it - so the 14-day matrix is rebuilt from scratch on most recomputes. At 3,500 lines this is a large main-thread build (computeMatrix is synchronous and not worker-offloaded on this path) recurring on nearly every edit, compounding the cost of every drag/optimize that already triggers an alert recompute.

**Evidence.**

```
if (['tasks:bulk','tasks:bulkUpdate','task:update','task:remove'].includes(evt.type))
  Confidence._recomputeDebounced();
...
const origRecompute = Alerts.recompute.bind(Alerts);
Alerts.recompute = (...args) => { const r = origRecompute(...args); Confidence._recomputeDebounced(); return r; };
...
_recompute() {
  ...
  const matrix = Utilization.computeMatrix(horizonStart, Math.ceil(hMinutes / 1440));
  Object.values(matrix).forEach(lineData => {
    Object.values(lineData).forEach(row => {
      if (row.effectiveCapacity > 0 && row.scheduled > row.effectiveCapacity) utilPenalty += 1.5;
    });
  });
```

**Suggested fix.** Reuse the alert recompute's already-computed overload data instead of independently rebuilding a 14-day matrix; or compute the confidence utilization penalty from the worker-prewarmed matrix. At minimum, give computeMatrix a small multi-entry LRU keyed including a plant discriminator so the Confidence horizon matrix survives interleaved Dashboard calls, and gate _recompute to skip when neither alerts nor _rev changed since the last score.

**Verification.** Store.subscribe (line 1304) plus the Alerts.recompute wrapper (line 1308) both trigger _recomputeDebounced, and computeMatrix (app.js 4210-4216) uses a single-slot cache keyed on (startMs|days|Store._rev) that is routinely evicted by _rev bumps and Dashboard's differing keys, forcing full rebuilds as claimed.

---


# 🟠 Medium severity

<a id="r22"></a>
### R22. Labor-plan POST actor identity hardcoded to a single developer's email

`app.js:2241-2268`  ·  **MEDIUM**  ·  _security_  ·  confidence: high

**Why it matters.** Both labor-plan write paths (_saveAggregate and _saveLines) hardcode the x-user-email header to the literal string 'trevor.holton@newellco.com'. The backend uses x-user-email as the actor identity for the admin_audit / labor audit trail. Every labor plan edit made by ANY user from ANY browser will be attributed to this one developer in the audit log, destroying the integrity of the audit trail. This also contradicts the rest of the codebase which reads actor identity from spoofable X-User/x-user-email request headers populated per-session — here it is not even read from session state, it is a baked-in literal. At the 50+ plant scale target with many planners, the labor audit becomes useless.

**Evidence.**

```
async function _saveAggregate(subnetwork, plant, cells) {
  ...
  headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
  ...
async function _saveLines(subnetwork, plant, cells) {
  ...
  headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
```

**Suggested fix.** Read the current actor email from the same session/config source the rest of the app uses (e.g. a Config.currentUser / Store-held identity, or the value Persistence threads onto fetchTraced), and pass that. Better: route these POSTs through Util.fetchTraced like every other request so the standard x-user / x-request-id headers are applied centrally instead of two hand-rolled fetch() calls with a literal email.

**Verification.** Lines 2245 and 2260 literally set headers 'x-user-email': 'trevor.holton@newellco.com' in both _saveAggregate and _saveLines, so every labor-plan write is attributed to one hardcoded developer in the audit trail.

---

<a id="r23"></a>
### R23. Audit-log POST hardcodes the actor identity to a single developer email

`app.js:5172-5182 (pattern repeated app-wide; see also 1831, 2245, 14027, 14796, 14946)`  ·  **MEDIUM**  ·  _security_  ·  confidence: high

**Why it matters.** Every audit/master-data mutation the frontend emits stamps the actor as the literal string 'trevor.holton@newellco.com'. CLAUDE.md acknowledges X-User/x-user-email is spoofable and that real identity awaits Entra SSO, but here it is not even derived from a runtime user — it is a compile-time constant. The admin_audit log (the system of record for who optimized/changed a plant's schedule) therefore attributes EVERY action by EVERY operator to one person, which defeats the audit trail's purpose and is a compliance/accountability risk in a manufacturing scheduling system.

**Evidence.**

```
fetch(`${Config.API_BASE}/audit/log`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User': 'trevor.holton@newellco.com' },
  body: JSON.stringify({ action: 'optimization_run', plant, ... }),
}).catch(() => {});
```

**Suggested fix.** Source the actor from a single runtime value (logged-in user / session), e.g. a Store.currentUser or a config-injected identity, and reference it everywhere instead of the inlined literal. Until SSO lands, at minimum centralize it in one place rather than ~12 hardcoded copies so it is not silently misattributed.

**Verification.** Line 5174 sends header 'X-User': 'trevor.holton@newellco.com' as a compile-time literal, so every operator's optimization_run is attributed to one person in the audit log.

---

<a id="r24"></a>
### R24. Unescaped line code / alert id interpolated into inline onclick JS string (handler-breaking / injection sink)

`app.js:7613, 7751, 7914, 7966`  ·  **MEDIUM**  ·  _security_  ·  confidence: high

**Why it matters.** `line` (from order `PRODUCTION_LINE`) and alert `id` (built as `ovl-day-${line}-${day}`, embedding the line code) are interpolated into single-quoted JS string literals inside inline `onclick` attributes. The local `esc`/`_esc` helpers only escape `& < > "` — they do NOT escape the single quote `'`. A line code containing an apostrophe (e.g. `O'Brien-1`, plausible for plant/line naming) breaks out of the JS string literal: `_gotoLine('O'Brien-1','...')` becomes a syntax error at best and an arbitrary-JS-execution sink at worst (a crafted line code could inject executable JS into the handler). At the 3,500-line scale target, line codes are sourced from uploaded Excel and master data — not a trusted closed set. Lines 7613 and 7751 do not even apply `esc`; 7914/7966 apply `esc` but it is insufficient for a JS-string context.

**Evidence.**

```
// _renderHeatmap (7613):
onclick="NIMBUS.Dashboard._gotoLine('${line}','${d}')"
// _renderAlertSummary (7751):
onclick="...NIMBUS.Alerts.focus('${a.id}')..."
// _renderLatenessHeatmap (7914):
onclick="NIMBUS.Dashboard._latenessDrill('${esc(line)}','${dk}')"
```

**Suggested fix.** Do not build inline `onclick` strings from data. Either (a) escape for JS-string context (also encode `'`, backslash, backtick, newline) before interpolation, or preferably (b) drop inline handlers: render `data-line`/`data-id`/`data-date` attributes (HTML-escaped) and attach a single delegated `addEventListener('click', ...)` on the container that reads `dataset` — eliminating the string-eval surface entirely.

**Verification.** Lines 7613 (`'${line}'`, no esc), 7751 (`'${a.id}'`), 7914 (`'${esc(line)}'`) and 7966 (`'${esc(t.id)}'`) interpolate data into single-quoted JS string literals in inline onclick, and the local esc/_esc helpers only replace & < > " — never the single quote — so an apostrophe in a line code breaks the handler.

---

<a id="r25"></a>
### R25. XSS sink: DB query text injected via innerHTML in lock-chain rendering

`app.js:12549-12551`  ·  **MEDIUM**  ·  _security_  ·  confidence: high

**Why it matters.** `query` is `lk.blocking_query` / `lk.blocked_query` from `/diagnostics/db`, which surfaces raw SQL text from `pg_stat_activity`. That text is whatever any DB client submitted — it can contain `<`, `>`, quotes, or a crafted string-literal containing markup. Interpolating it into `innerHTML` means a blocking/blocked query whose SQL text contains HTML (e.g. a comment or string literal `'<img src=x onerror=...>'`) renders as live DOM in the admin console. The sibling `_dbSlowQueryBars` correctly uses `qText.textContent = (q.query||'').slice(0,90)` for the same kind of DB query text, so this innerHTML usage is an inconsistent and unsafe outlier. `role` is also interpolated but is constructed client-side (`BLOCKED ${lk.blocked_for_s}s`) so lower risk; the query text is the real sink.

**Evidence.**

```
node.innerHTML = `<span class="admin-db-lock-pid">PID ${pid}</span>`
  + `<span class="admin-db-lock-role">${role}</span>`
  + `<div class="admin-db-lock-query">${(query || '—').slice(0, 90)}</div>`;
```

**Suggested fix.** Build the node with textContent like the slow-query path: create the three child spans/divs and assign `.textContent` for pid, role, and query rather than concatenating into innerHTML.

**Verification.** Lines 12549-12551 build the node via innerHTML interpolating `query` (lk.blocking_query/blocked_query), whereas the sibling `_dbSlowQueryBars` correctly uses `qText.textContent` at line 12493 for the same DB query text — confirmed inconsistent unsafe sink.

---

<a id="r26"></a>
### R26. Actor identity hardcoded to a single user's email in master-data write headers

`app.js:14027, 14124`  ·  **MEDIUM**  ·  _security_  ·  confidence: high

**Why it matters.** The plant-horizon bulk upsert and the per-plant constraints POST both hardcode x-user-email to a single developer's address. brain.py/master_data.py write this header into the admin_audit log as the actor. Every horizon and constraint change made by any user in any plant is therefore attributed to trevor.holton@newellco.com, destroying the audit trail's usefulness. CLAUDE.md already flags actor identity as spoofable (X-User/x-user-email) pending Entra SSO, but here it is not even reading the real current user — it is a literal constant, which is strictly worse than spoofable.

**Evidence.**

```
headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
...
headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
```

**Suggested fix.** Route these through the standard request wrapper (Util.fetchTraced) so the actor header is populated from the same source the rest of the app uses (a single config/identity accessor), rather than embedding a literal email. Replace both literals with that accessor.

**Verification.** Lines 14027 and 14124 literally set 'x-user-email':'trevor.holton@newellco.com', and a grep shows this same literal hardcoded in 12 places across app.js, so all audit attribution collapses to one address.

---

<a id="r27"></a>
### R27. Destructive/audit actions attribute the actor to a spoofable X-User header

`brain.py:994-1010`  ·  **MEDIUM**  ·  _security_  ·  confidence: high

**Why it matters.** The color-wheel upload (and the broader audit trail) records the acting user solely from the client-supplied X-User header with no server-side verification. NIMBUS_API_KEY (when set) only gates whether the route runs at all (a single shared secret), not who performed it. Any client holding the shared key — or any client at all in the default no-op configuration — can write arbitrary attribution into the append-only audit log, defeating its purpose for accountability. CLAUDE.md explicitly flags this as a known stopgap, but at the 50+ plant production scale an audit log with forgeable actor identity is a real compliance/forensics risk worth tracking.

**Evidence.**

```
user = request.headers.get("X-User", "system")
...
_cw_append_audit({
    "ts": ts, "user": user, "action": action, "plant": plant,
    "details": {"filename": fname, "row_count": row_count, "replaced": is_replace},
})
```

**Suggested fix.** Derive actor identity from a server-verified source (Entra SSO / signed token) rather than X-User before any internet-facing or multi-tenant deployment. Until then, mark audited 'user' values as untrusted in the log schema and require NIMBUS_API_KEY in any non-localhost deployment.

**Verification.** Line 994 reads `user = request.headers.get('X-User','system')` and writes it unverified into the append-only audit log at 1007-1010; this is real and explicitly flagged as a known stopgap in CLAUDE.md, so it is a tracked risk rather than an oversight.

---

<a id="r28"></a>
### R28. updateTask replaces the task reference but does not refresh _tasksByPlant, leaving a stale task object in the plant index after single edits

`app.js:641-648`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** _tasksByPlant (built in _rebuildPlantIndex, lines 854-860) stores task references. updateTask replaces the reference in _state.tasks[id] with a NEW object (next) but never updates _tasksByPlant, so the OLD reference (with pre-edit start_date/end_date) remains in Store._tasksByPlant[plant]. tasksByPlant()/tasksForSelectedPlant() (lines 843-845, 875-881) read straight from that index, so any consumer reading plant-scoped tasks after a single-task edit sees stale dates until the next full setTasks/lineSettings rebuild. Notably updateMany mutates in place (line 681) so its edits DO stay visible through the index — the two paths diverge in correctness here.

**Evidence.**

```
updateTask(id, changes, source) {
      const prev = this._state.tasks[id];
      if (!prev) return;
      const next = { ...prev, ...changes };
      Store._normalizeDates(next);
      this._state.tasks[id] = next;
      this.emit({ type: 'task:update', id, prev, next, changes, source });
    },
```

**Suggested fix.** After replacing the reference in updateTask, also replace the old ref inside Store._tasksByPlant[plant] (locate by id and swap), or rebuild the index when a plant/line/date field changes. Verify which UI paths read tasksByPlant after a single drag/edit before choosing scope.

**Verification.** _rebuildPlantIndex (855-858) pushes the same task refs into _tasksByPlant, updateTask (646) reassigns _state.tasks[id] to a new object without rebuilding the index, and setLineSetting only rebuilds on a 'plant' change (819), so a single date edit leaves the stale old ref in _tasksByPlant read by tasksByPlant()/tasksForSelectedPlant().

---

<a id="r29"></a>
### R29. clampLinesToPlant only clamps lines mapped via lineSettings.plant, ignoring master-data-derived plant mapping used everywhere else

`app.js:757-773`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** clampLinesToPlant decides which lines belong to the plant using ONLY `lineSettings[line].plant`. But the authoritative line→plant resolver Store.getPlantForLine (line 822-832) first checks lineSettings.plant and then FALLS BACK to the master-data lines table (`masterData.lines.find(...).plant`). linesForSelectedPlant() (line 882-885) — which decides which lines are shown in the Plant roster and clamped conceptually — uses getPlantForLine. So a line whose plant is known only via master data (the documented authoritative onboarding path per CLAUDE.md) appears in the plant roster but is NEVER clamped when the plant's working hours are tightened in the Plant tab (callers at 1492/1516/1547 invoke clampLinesToPlant for all 7 days). Result: those lines keep working-hour windows that exceed the plant's hours, so workWindow's intersection (1025-1030) will still cap them at run time, but the stored per-line calendars become inconsistent with the plant and any code reading line calendars directly (roster display line 1655-1664, EditCalendar) shows un-clamped hours. The inconsistency grows precisely at the target scale where master-data mapping (not manual lineSettings.plant) is the norm.

**Evidence.**

```
clampLinesToPlant(plant, dow) {
  const plantHours = this._state.plants[plant]?.workHours[dow];
  for (const line of Object.keys(this._state.calendars)) {
    const lsettings = this._state.lineSettings[line];
    const linePlant = (lsettings || {}).plant || null;
    if (linePlant !== plant) continue;
    ...
```

**Suggested fix.** Resolve the line's plant the same way as the rest of the code: replace `const linePlant = (lsettings || {}).plant || null;` with `const linePlant = Store.getPlantForLine(line);` so clamping matches linesForSelectedPlant/getPlantForLine. Verify Store._lineToPlant is current at call time (it is rebuilt on lineSettings/master-data changes).

**Verification.** app.js 760-762 resolves linePlant solely from lineSettings[line].plant, whereas getPlantForLine (822-831) falls back to the master-data lines table and linesForSelectedPlant (882-885) uses getPlantForLine, so master-data-only lines appear in the roster but are skipped by clamping.

---

<a id="r30"></a>
### R30. Calendar-tab working-hours editor accepts inverted (end <= start) windows with no validation

`app.js:1254-1264`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** This Calendar-tab handler writes `[start, end]` directly into the line calendar with no check that end > start, unlike the Plant pill path (_pillSave, line 1512-1513) which explicitly rejects `eh <= sh` with a toast, and the ProdLines path. A user can set e.g. 17:00 start / 08:00 end. The inverted pair flows into _dayWindow which returns [17:00, 08:00] (end before start). dailyCapacityHours computes winHours negative and clamps to 0 via Math.max(0,...) (line 1062) — so the line silently shows 0 capacity / 'closed' alerts despite the UI showing a configured shift. For a line with no plant mapping, workWindow returns the inverted window verbatim (line 1033 `result = lineWin`, bypassing the `s >= e` guard that only runs on the plant-intersection branch at 1027), which can corrupt isAvailable/nextAvailable comparisons. The same silent toast 'calendar updated' fires, giving false confidence.

**Evidence.**

```
const upd = () => {
  const vs = inS.value, ve = inE.value;
  const cal = Store.calendars[line].workHours;
  if (!vs || !ve) { cal[day] = null; cell.classList.add('off'); }
  else {
    cal[day] = [Calendar._tToH(vs), Calendar._tToH(ve)];
    cell.classList.remove('off');
  }
  Store.emit({ type: 'calendar:change', line, source: 'calendar' });
  Toast.show(t('toast.calendar_updated'), 'success');
};
```

**Suggested fix.** Mirror _pillSave's validation: in the else branch compute `const sh = Calendar._tToH(vs), eh = Calendar._tToH(ve); if (eh <= sh) { Toast.show(t('toast.end_must_be_after_start'),'error'); return; }` before assigning cal[day]. Optionally also guard workWindow's no-plant branch (line 1033) with the same `s >= e -> null` check the plant branch already has.

**Verification.** app.js 1254-1264 writes [_tToH(vs),_tToH(ve)] into cal[day] with no eh<=sh check, unlike _pillSave (1512-1513) which rejects eh<=sh; an inverted pair flows into _dayWindow and workWindow's no-plant branch (1033) returns it verbatim without the s>=e guard.

---

<a id="r31"></a>
### R31. EditCalendar save() persists work hours with no validation that end > start, allowing inverted/zero-length day windows

`app.js:3241-3263`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** save() writes whatever the two time pickers hold. There is no check that end is after start. A user can set start=17:00 / end=08:00 (or equal), producing a workHours entry like [17,8]. _refreshBadge already detects this case (it shows the dash when hrs<=0, line 3181) but save() ignores that and persists the inverted pair anyway. Downstream Calendar.workWindow / dailyCapacityHours then compute a negative or zero working window for that day-of-week, silently corrupting capacity math (overload/closed alerts, utilization, the greedy optimizer's nextAvailable). Calendars are local/explicit-save so the backend never validates this; the bad value propagates through every alert and capacity computation for that line until manually corrected.

**Evidence.**

```
const s = _fp[d * 2]?.element?.value;
const e = _fp[d * 2 + 1]?.element?.value;
newWh[d] = (s && e) ? [Calendar._tToH(s), Calendar._tToH(e)] : null;
...
Store.setCalendar(_line, newWh, 'edit-calendar');
```

**Suggested fix.** In the save() loop, after computing [Calendar._tToH(s), Calendar._tToH(e)], reject or skip days where end <= start: e.g. const sh=Calendar._tToH(s), eh=Calendar._tToH(e); if (eh<=sh){ Toast.show(invalid window); return; } newWh[d]=[sh,eh]. Mirror the same guard in Calendar.saveHours (~line 1259) which has the identical pattern.

**Verification.** save() at app.js:3247-3249 writes [_tToH(s),_tToH(e)] with no end>start check (mirrored in Calendar's upd at 1259); when a line has no plant, workWindow returns the raw inverted lineWin (1032-1033) so dailyCapacityHours computes negative winHours — though the plant-assigned path is guarded by s>=e→null at 1027.

---

<a id="r32"></a>
### R32. Off-thread prewarm writes a plant-scoped utilization matrix under the global cache key, poisoning computeMatrix for unfiltered callers

`app.js:4374-4392 (cache read 4213-4216)`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** _prewarm requests a worker matrix that is deliberately scoped to the selected plant's lines (the snapshot is pruned to on-screen lines per CLAUDE.md), then stores it under the key `${startMs}|7|${rev}` — the exact key the synchronous computeMatrix(today, 7, null) path treats as the GLOBAL all-lines matrix. The key carries no plant discriminator, so any later srcTasks===null call with the same (startMs, days, rev) receives the plant-scoped matrix and silently omits every line outside the selected plant (lines that have a calendar but no on-screen task). For a single-plant UI session this is masked, but it is a genuine cache-identity bug and CLAUDE.md flags it as a known caveat — confirmed present in current code.

**Evidence.**

```
Compute.utilization(startMs, 7)
  .then(({ matrix }) => {
    if ((Store._rev || 0) !== rev) return;
    ...
    Utilization._cache = { key: `${startMs}|7|${rev}`, matrix };
  })
// sync read path keys identically with no plant discriminator:
const cacheKey = `${start.getTime()}|${days}|${Store._rev || 0}`;
if (cacheable && Utilization._cache && Utilization._cache.key === cacheKey) {
  return Utilization._cache.matrix;
}
```

**Suggested fix.** Make the cache key plant-aware (e.g. include Store.selectedPlant or a 'scope' tag) for the prewarm write and the sync read, or have _prewarm store under a separate `_cacheByPlant` map that computeMatrix only consults when its own scope matches. Do not write a plant-scoped result under the global key.

**Verification.** _prewarm (gated on Store.selectedPlant at 4377) writes Utilization._cache under key `${startMs}|7|${rev}` (4389) with no plant discriminator, the exact key the srcTasks===null sync path reads at 4213-4214; matches the documented caveat, though impact is masked in single-plant sessions.

---

<a id="r33"></a>
### R33. OptimizeDialog plant list uses Config.KNOWN_PLANTS instead of Store.knownPlants() — stale list at scale

`app.js:4741-4743`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** CLAUDE.md states Config.KNOWN_PLANTS (['5512','1006']) is only a fallback seed and Store.knownPlants() is the authoritative path — it prefers master-data plants and returns them alone when present, ignoring KNOWN_PLANTS entirely. _buildPlantSelect bypasses Store.knownPlants() and unconditionally merges the hardcoded seed with order-derived plants. At the 50+ plant target this surfaces the two stale prototype plant codes alongside real plants, and any master-data plant with no orders and not in the seed will be missing from the optimizer's plant picker. Other call sites (lines 11132, 13451) correctly use Store.knownPlants().

**Evidence.**

```
`function _buildPlantSelect() { const dynamic = Store.tasksArr.map(t => Store.getPlantForLine(t.PRODUCTION_LINE)).filter(Boolean); _allPlants = [...new Set([...Config.KNOWN_PLANTS, ...dynamic])].sort();`
```

**Suggested fix.** Replace the merge with `_allPlants = Store.knownPlants();` (which already applies the master-data-first logic and order-derived discovery), matching PlantSelector and the other call sites.

**Verification.** Same code as verified for the related finding: line 4743 unions Config.KNOWN_PLANTS with order-derived plants instead of Store.knownPlants(); this is a duplicate of the earlier plant-picker finding.

---

<a id="r34"></a>
### R34. Optimize dialog plant picker bypasses Store.knownPlants(), hiding master-data plants with no orders

`app.js:4742-4743`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** CLAUDE.md states the authoritative plant source is the Master Data plants table via Store.knownPlants(), and that Config.KNOWN_PLANTS (['5512','1006']) is only a fallback seed that knownPlants() ignores entirely when master-data plants exist. _buildPlantSelect instead unions the raw KNOWN_PLANTS seed with order-derived discovery and never consults Store.knownPlants(). Consequences: (1) a plant onboarded in Master Data but with no ingested orders yet never appears in the optimize picker; (2) the stale hardcoded seed 5512/1006 is always injected even when master data defines a completely different plant set; (3) at the 50+ plant scale target this list is neither server-filtered nor backed by the master-data source of truth. This directly contradicts the documented knownPlants() contract.

**Evidence.**

```
const dynamic = Store.tasksArr.map(t => Store.getPlantForLine(t.PRODUCTION_LINE)).filter(Boolean);
_allPlants = [...new Set([...Config.KNOWN_PLANTS, ...dynamic])].sort();
```

**Suggested fix.** Build the list from Store.knownPlants() (which already prefers master-data plants and folds in order-derived discovery), e.g. `_allPlants = [...new Set([...Store.knownPlants(), ...dynamic])].sort();` or simply `_allPlants = Store.knownPlants();` if that already merges discovery.

**Verification.** Line 4743 builds _allPlants from [...Config.KNOWN_PLANTS, ...order-derived dynamic] and never calls Store.knownPlants(), contradicting the documented master-data-first contract.

---

<a id="r35"></a>
### R35. Modal.confirm: the X close button bypasses cleanup(), leaking click listeners and leaving the promise unresolved forever

`app.js:5404-5425`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** The confirm-modal header in index.html (line 2306) wires its dismiss button directly to `onclick="NIMBUS.Modal.close('confirm-modal')"`. That path only sets `hidden=true`; it never calls cleanup() and never resolves the promise. Consequences: (1) the awaiting caller (e.g. `const ok = await Modal.confirm(...)`) is left hanging forever — the code after the await never runs, so the user dismissing via X silently aborts the operation with no cancel semantics; (2) the onOk/onCancel listeners added on okBtn and confirm-cancel-btn are never removed, so they accumulate across every dismiss-via-X. A later confirm() then has multiple stale onOk closures bound; clicking OK resolves the new promise but the stale listeners' done()/cleanup() still fire against already-resolved promises (resolve is a no-op, but cleanup re-runs removeEventListener and Modal.close needlessly). This is a real listener leak plus a hung-promise bug whenever the user closes the dialog with the X.

**Evidence.**

```
confirm(opts = {}) {
  return new Promise(resolve => {
    ...
    const cleanup = () => {
      okBtn.removeEventListener('click', onOk);
      document.getElementById('confirm-cancel-btn').removeEventListener('click', onCancel);
      Modal.close('confirm-modal');
    };
    const onOk     = () => done(true);
    const onCancel = () => done(false);
    okBtn.addEventListener('click', onOk);
    document.getElementById('confirm-cancel-btn').addEventListener('click', onCancel);
    Modal.open('confirm-modal');
  });
}
```

**Suggested fix.** Make the dialog resolvable on dismiss: either remove the inline onclick on the header X and instead bind it inside confirm() as another onCancel-equivalent (added in cleanup's removeEventListener list), or have the X invoke a Modal-level cancel handler that calls the active resolver with false. Track the active resolver on Modal so the X always resolves(false) and runs cleanup.

**Verification.** index.html line 2306 wires the X to NIMBUS.Modal.close('confirm-modal') which only sets hidden=true (app.js line 5400) and never calls cleanup()/resolve(), so the awaited promise hangs and the onOk/onCancel listeners added at 5422-5423 are not removed.

---

<a id="r36"></a>
### R36. DependencyOverlay critical-path recursion has no cycle guard — a dependency cycle throws an uncaught RangeError that aborts render()

`app.js:8537-8544, 8622`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** getLen memoizes chainLen[id] only AFTER the recursive Math.max(...sources.map(getLen)) resolves. If Store._state.dependencies contains a cycle (A depends on B, B depends on A), getLen(A) calls getLen(B) which calls getLen(A) again before either is memoized — infinite recursion until 'Maximum call stack size exceeded'. The maxLen computation at line 8544 wraps each call in try/catch and swallows it, but inside the draw loop the SECOND call `getLen(targetId)` at line 8622 has NO try/catch, so a cyclic dependency throws an uncaught RangeError that aborts the entire render() — the dependency overlay silently fails to draw. Dependencies are finish-to-start chains derived from order data; a self-loop or 2-cycle (plausible with reused/plant-blind task IDs, given IDs are MD5 of PRODUCTION_ORDER|MATERIAL_NUMBER and plant-blind) triggers this.

**Evidence.**

```
const getLen = (id) => {
  if (chainLen[id] !== undefined) return chainLen[id];
  const sources = deps[id] || [];
  if (!sources.length) { chainLen[id] = 0; return 0; }
  chainLen[id] = 1 + Math.max(...sources.map(getLen));
  return chainLen[id];
};
const maxLen = Math.max(0, ...allIds.map(id => { try { return getLen(id); } catch { return 0; } }));
...
const isCritical = maxLen > 0 && (getLen(targetId) || 0) >= maxLen - 1;
```

**Suggested fix.** Add an in-progress marker to getLen to break cycles: maintain a `visiting` Set, return 0 (or a sentinel) if id is already on the recursion stack, set chainLen[id]=0 before recursing as a tentative value. e.g. `const visiting = new Set(); const getLen = id => { if (chainLen[id] !== undefined) return chainLen[id]; if (visiting.has(id)) return 0; visiting.add(id); const sources = deps[id]||[]; const v = sources.length ? 1 + Math.max(...sources.map(getLen)) : 0; visiting.delete(id); chainLen[id]=v; return v; };` and/or wrap the line-8622 call in the same guard.

**Verification.** At lines 8537-8544 getLen memoizes chainLen[id] only after the recursive Math.max resolves, so a dependency cycle recurses until stack overflow; the maxLen call wraps each getLen in try/catch but the second call at line 8622 (getLen(targetId)) has no guard, so a cyclic dependency would throw uncaught and abort render. Whether a cycle can actually arise depends on dependency data, but the missing guard is genuinely present.

---

<a id="r37"></a>
### R37. DependencyOverlay maps line→Y using all-plant task list but indexes plant-scoped group rows positionally — arrows attach to wrong lines

`app.js:8578-8595`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** `lines` is built from Store.tasksArr (ALL plants' tasks) and sorted, then mapped positionally onto groupEls[i] (the DOM group rows the timeline actually renders, which are scoped to the SELECTED plant's lines per CLAUDE.md). When tasksArr contains lines from multiple plants, the sorted all-plant line list does not align index-for-index with the plant-scoped rendered groups, so lineToY[line] gets the Y of the wrong group row. Dependency arrows then render at incorrect vertical positions. The timeline elsewhere is plant-scoped (Timeline.rebuild, GanttFilter._buildLineDropdown use Store.tasksForSelectedPlant / linesForSelectedPlant), making this the inconsistent path.

**Evidence.**

```
const groupEls = dom.querySelectorAll('.vis-foreground .vis-group');
const lineToY = {};
const lines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();
if (groupEls.length) {
  lines.forEach((line, i) => {
    const groupEl = groupEls[i];
    if (groupEl) {
      const gRect = groupEl.getBoundingClientRect();
      lineToY[line] = (gRect.top - wrapRect.top) + gRect.height / 2;
```

**Suggested fix.** Build `lines` from the same plant-scoped source the timeline renders from (e.g. derive line order from Store.linesForSelectedPlant()/tasksForSelectedPlant(), or read the line label off each groupEl rather than relying on positional index). Match group rows to lines by the group's data attribute/label, not array index.

**Verification.** Line 8580 builds `lines` from Store.tasksArr (all plants, line 578) sorted, then line 8582-8583 zips it positionally against groupEls (the rendered .vis-group rows), which Timeline.rebuild (5715-5751) derives from tasksForSelectedPlant and further filters by GanttFilter._selectedLines, so the index alignment breaks under multiple plants or an active line filter.

---

<a id="r38"></a>
### R38. OptimizerPreview KPI scope drops null-line ('Unknown') orders the engine actually reschedules

`app.js:8914-8922 (vs Engine 4542-4543 and OptimizeDialog 4853)`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** The optimize dialog's line list, _selectedLines, and Engine.runAndApply all normalize a missing production line to the literal string 'Unknown' (t.PRODUCTION_LINE || 'Unknown'). The preview's inScope filter instead tests the RAW field: lineSet.has(t.PRODUCTION_LINE). For an order whose PRODUCTION_LINE is null/undefined, the engine WILL reschedule it (it is grouped under 'Unknown', and 'Unknown' can be present in _selectedLines), but inScope evaluates lineSet.has(undefined) === false and excludes it from both pre- and post-KPI computation. The before/after KPI comparison the planner sees therefore omits orders that the run genuinely moved, so changeover/lateness/span deltas are understated whenever any in-scope order lacks a line code.

**Evidence.**

```
const lineSet = (Array.isArray(opts.lines) && opts.lines.length) ? new Set(opts.lines) : null;
const inScope = t => {
  if (lineSet && !lineSet.has(t.PRODUCTION_LINE)) return false;
  ...
};
// Engine.runAndApply groups on the 'Unknown' fallback:
const line = t.PRODUCTION_LINE || 'Unknown';  // line 4542
if (allowed && !allowed.has(line)) continue;  // line 4543
// _linesForPlant also normalizes to 'Unknown':
const l = t.PRODUCTION_LINE || 'Unknown';     // line 4853
```

**Suggested fix.** Normalize identically in inScope: change `if (lineSet && !lineSet.has(t.PRODUCTION_LINE)) return false;` to `if (lineSet && !lineSet.has(t.PRODUCTION_LINE || 'Unknown')) return false;` so the KPI scope matches Engine's grouping key exactly.

**Verification.** Line 4916 tests lineSet.has(t.PRODUCTION_LINE) on the raw field, while Engine.runAndApply (4542) and _linesForPlant (4852) both normalize a missing line to 'Unknown', so an order with null line is rescheduled but excluded from pre/post KPIs.

---

<a id="r39"></a>
### R39. Sandbox promote (exit(true)) registers an undo that loses blocks/calendars and is mislabeled "Discard"

`app.js:9249-9260`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** When a What-If scenario is promoted, the undo entry it pushes restores only snap.tasks and snap.fixedIds. The discard branch (exit(false)) restores tasks, blocks, calendars AND fixedIds (lines 9264-9268), proving blocks/calendars are part of sandbox state and ARE mutated live during sandbox. So if a planner promotes a scenario that edited blackout blocks or calendars and then presses Ctrl+Z, tasks and fixedIds revert to pre-sandbox state while blocks/calendars stay at their sandbox-mutated values — an inconsistent schedule (alerts/capacity computed against blocks that no longer match the reverted tasks). The undo label is also wrong: it reads 'Discard What-If scenario' for a promote action, and its toast says scenario_discarded, so the undo toast will tell the user the scenario was discarded when they undid a promotion.

**Evidence.**

```
if (apply) {
  const snap = Sandbox._snapshot;
  UndoStack.push('Discard What-If scenario', () => {
    Store.setTasks(snap.tasks, 'undo');
    Store._state.fixedIds = new Set([...snap.fixedIds]);
    for (const id of Store._state.fixedIds) { const t = Store.tasks[id]; if (t) t.fixed = true; }
    Alerts.scheduleRecompute();
    Toast.show(t('toast.scenario_discarded'), 'info');
  });
  const scenarioName = document.getElementById('sb-scenario-name')?.value || 'What-If';
  Toast.show(t('toast.scenario_applied', { name: scenarioName }), 'success');
}
```

**Suggested fix.** Capture and restore the full snapshot in the promote undo callback, matching the discard branch: also set Store._state.blocks = snap.blocks and Store._state.calendars = snap.calendars (deep-cloned). Relabel the undo entry (e.g. `Promote What-If scenario "${scenarioName}"`) and use a 'reverted promotion' toast string rather than scenario_discarded.

**Verification.** Lines 9249-9258: the promote undo callback restores only snap.tasks and snap.fixedIds (not snap.blocks/calendars, which the discard branch at 9265-9266 does restore), is labeled 'Discard What-If scenario', and shows the scenario_discarded toast; since enter() snapshots blocks/calendars (9226-9227) and sandbox mutates them live, undoing a promote leaves blocks/calendars at sandbox values while tasks revert.

---

<a id="r40"></a>
### R40. _restoreNonTaskState whole-object-replaces lineSettings/calendars on the backend load path, enabling cross-plant state bleed and swallowing restore errors

`app.js:10447-10463, 10775-10788`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** On the authoritative backend load, _restoreNonTaskState assigns Store._state.lineSettings = data.lineSettings and Store._state.calendars = data.calendars by whole-object replacement (not merge). Combined with the un-plant-scoped cache (see the cache-fallback finding), a cache written for a different plant injects that plant's per-line settings and calendars into the currently-loaded plant's Store. Even within one plant, lines present in the backend tasks but absent from the cached lineSettings are left without their cached config, and orphan lines from the cache are retained. The wrapping catch(_) at 10454 also silently discards any restore exception, hiding corruption.

**Evidence.**

```
try { ... Persistence._restoreNonTaskState(cacheData); } catch(_) {}
 ...
_restoreNonTaskState(data) {
      if (data.lineSettings && Object.keys(data.lineSettings).length)
        Store._state.lineSettings = data.lineSettings;
 ... if (data.calendars) Store._state.calendars = data.calendars;
```

**Suggested fix.** Merge cached lineSettings/calendars into existing Store state keyed by line (ideally filtered to the loaded plant) instead of whole-object assignment, and log restore failures instead of swallowing them in an empty catch.

**Verification.** _restoreNonTaskState assigns Store._state.lineSettings = data.lineSettings (10777) and Store._state.calendars = data.calendars (10788) by whole-object replacement, and the backend-path caller wraps it in catch(_){} (10454) swallowing errors; combined with the un-plant-scoped cache this is a genuine bleed/merge gap.

---

<a id="r41"></a>
### R41. Cache fallback (_loadCache) is not plant-scoped, so reconnect/offline can render the wrong plant's orders

`app.js:10534-10547, 10712-10770, 11024-11039`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** _saveCache() persists Store.tasksArr, which the load path scopes to a single plant (GET /tasks?plant=...). _loadCache() restores those cached tasks verbatim with no plant filter or check against Persistence._currentLoadedPlant / the requested plant. If the backend goes down while plant A is loaded, then a reload is attempted for plant B (e.g. via _reconnect -> load({plant: _currentLoadedPlant}) racing a user plant switch, or a boot using _rememberedPlant that differs from the last-saved tasks), the cache will repopulate Store with plant A's orders while the UI believes it is showing plant B. Given the explicit 50+ plant scale target and plant-blind MD5 task IDs, this produces cross-plant data display with no warning.

**Evidence.**

```
if (Persistence._loadCache()) {
              stats.source = 'cache';
              Toast.show(t('toast.backend_unreachable_cache'), 'warn', 5000);
 ...
_saveCache() { const snapshot = { ... tasks: Store.tasksArr, ... selectedPlant: Store.selectedPlant, ... }; }
```

**Suggested fix.** Stamp the cached snapshot with the plant it represents (e.g. snapshot.cachedPlant = Store.selectedPlant) and have _loadCache() compare it against the plant being loaded; if they differ, discard the task portion (restore only non-task state) and render empty rather than showing a foreign plant's orders.

**Verification.** _saveCache (11030-11037) stores Store.tasksArr and selectedPlant but _loadCache (10712-10769) restores data.tasks verbatim with no comparison against the requested/_currentLoadedPlant, so a cache written for plant A can repopulate the Store while the UI believes it shows plant B; the named race depends on runtime sequencing but the missing scope check is real.

---

<a id="r42"></a>
### R42. Printer CSV export emits UTC timestamps while the on-screen preview shows local time

`app.js:13270-13274, 13337`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** preview() formats start/end using local getters (getHours/getMonth/getDate), but exportCsv() formats the same rows with toISOString(), which is UTC. For any user not at UTC+0 the CSV times differ from what the preview table shows (and from the Gantt/Inspector, which are local) by the local offset — e.g. a 14:00 start shown in the table becomes 18:00 in the CSV at UTC-4. Since the CSV is the artifact people share for production scheduling, the times are wrong/misleading relative to every other view. The CSV can also straddle a date boundary versus the preview.

**Evidence.**

```
// preview() — local time:
const fmtDt = d => {
  if (!d) return '—';
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
// exportCsv() — UTC:
const fmtDt = d => d ? d.toISOString().slice(0, 16).replace('T', ' ') : '';
```

**Suggested fix.** Use the same local formatter in exportCsv() as in preview() (or a shared Util.fmtDTReadable/local helper). Avoid toISOString() for human-facing schedule timestamps.

**Verification.** preview()'s fmtDt at 13271-13274 uses local getters (getMonth/getDate/getHours/getMinutes) while exportCsv()'s fmtDt at 13337 uses d.toISOString() which is UTC, so the two views disagree by the local UTC offset for any non-UTC user.

---

<a id="r43"></a>
### R43. Settings horizon/constraint saves mutate Store state before the network write succeeds; failure only toasts, leaving local state diverged from DB

`app.js:14021-14033, 14116-14130`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** Both writers optimistically mutate the in-memory master-data plant row (Object.assign(plantRow, patch) for horizons; plantRow.constraints = payload for constraints) BEFORE awaiting the POST, and the catch block only shows a toast. The mutation is never rolled back on failure. After a failed save the optimizer and the alert/confidence horizons run against values that were never persisted; on next plant reload they silently revert, so the user sees their edit 'take effect' (constraint reorder changes optimizer output immediately) and then disappear with no record of which state is authoritative. Additionally fetch() only rejects on network error, not on HTTP 4xx/5xx — a 500 from the constraints endpoint resolves normally, so even the toast never fires and the divergence is completely silent.

**Evidence.**

```
async function _savePlantHorizon(patch) {
  if (!plantRow) { Toast.show(t('toast.no_plant_selected'), 'warn'); return; }
  Object.assign(plantRow, patch);
  try {
    await fetch(`${Config.API_BASE}/master-data/plants/bulk`, { ... });
  } catch (e) {
    Toast.show(t('toast.horizon_save_failed', { msg: e.message }), 'error');
  }
}
... 
async function saveConstraints() {
  ...
  plantRow.constraints = payload;  // update Store so the optimizer sees it immediately
  try { await fetch(...constraints..., { ... }); } catch (e) { Toast.show(...); }
}
```

**Suggested fix.** Snapshot the prior value, write to the server first, and only commit the Store mutation after r.ok; on failure restore the snapshot and re-render. At minimum check `if (!r.ok) throw` inside the try so HTTP errors surface the toast and trigger rollback.

**Verification.** At lines 14023 (Object.assign(plantRow, patch)) and 14120 (plantRow.constraints = payload) the in-memory row is mutated before the bare fetch is awaited, and the catch only toasts with no rollback; since fetch() resolves on HTTP 4xx/5xx, a server error is silently swallowed, leaving local state diverged.

---

<a id="r44"></a>
### R44. Added-then-edited MasterData rows are upserted twice (and bypass key-column validation on one path)

`app.js:14549-14555, 14744-14755`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** When a newly-added row is edited, _markDirty stores the SAME object reference (addedRow) in state.dirty (the code comment at 14543-14548 confirms added rows are edited in place and the dirty entry IS the added-row object). In _save, the dirty Map iteration pushes that object into `upserts`, and the state.added iteration pushes the identical object again — so every added-and-edited row is upserted twice in one POST body. More importantly, the dirty-path push (line 14746) skips the missing-key-column validation that the added-path applies (14749-14753): an added row with empty key columns that was edited will still be sent via the dirty path even though the added path correctly rejects it (the `return` only skips the second push). The DB upsert is idempotent so data is not corrupted, but the inserted/updated counts reported back in the success toast are inflated/wrong, and the validation guard is effectively defeated for the duplicate.

**Evidence.**

```
// _markDirty (first edit of an added row): patch === the added row object
let patch = state.dirty.get(rowKey);
if (!patch) {
  const addedRow = (state.added || []).find(r => _rowKey(table, r) === rowKey);
  patch = addedRow ? addedRow : { ..._getRowByKey(table, rowKey) };
}
patch[colName] = value;
state.dirty.set(rowKey, patch);
...
// _save: builds upserts from BOTH dirty AND added
state.dirty.forEach((patch, _key) => { if (!state.deleted.has(_key)) upserts.push(patch); });
state.added.forEach(row => {
  const missing = keys.filter(k => !row[k]);
  if (missing.length) { Toast.show(...); return; }
  upserts.push(row);
});
```

**Suggested fix.** De-duplicate before POST: build `upserts` from a Map keyed by _rowKey, or skip dirty entries whose key matches an entry already in state.added (e.g. `state.dirty.forEach((patch,_key)=>{ if(state.deleted.has(_key)) return; if(state.added.some(r=>_rowKey(table,r)===_key)) return; upserts.push(patch); })`). Apply the missing-key validation to the unified set rather than only the added path.

**Verification.** Verified at 14550-14555 _markDirty sets patch=addedRow (same object reference) into state.dirty, and at 14746/14754 _save pushes it from both the dirty Map and state.added, while the missing-key guard (14749-14753) only protects the added-path push, so the duplicate dirty-path entry bypasses it.

---

<a id="r45"></a>
### R45. Paginated GET /tasks splits production-line groups across page boundaries, breaking finish-to-start links

`brain.py:643-734`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** query_orders applies LIMIT/OFFSET at the SQL level ordered by (production_line, start). brain.py then rebuilds finish-to-start links per production_line group from only the rows on the current page. When a line's orders straddle a page boundary, the first task on a page is linked to the last task of the SAME line on a different page incorrectly (the link is simply omitted for the first row of each group, so the chain silently drops the cross-page edge), and the chain restarts mid-line. The response advertises meta.total for paging while emitting links that are only coherent for an unpaginated single-plant/line scope. A consumer paging through and stitching links will get a corrupted dependency graph. The code comment acknowledges 'links are only coherent within a plant/line scope' but the endpoint still emits links unconditionally alongside paginated data.

**Evidence.**

```
paging = limit is not None or offset is not None
...
df = db.query_orders(plant=plant, line=line, limit=limit, offset=offset)
...
for prod_line, group_raw in df.groupby("PRODUCTION_LINE"):
    ...
    if prev_task_id:
        links.append({"id": link_id_counter, "source": prev_task_id, "target": task_id, "type": "0"})
```

**Suggested fix.** When limit/offset are supplied (paging mode), omit the links array (return links: []) or document that links must be ignored; alternatively only build links when not paging. At minimum, do not emit a partial link chain that looks complete.

**Verification.** Lines 676-721 rebuild per-line links from only the current page's rows while db.py 167-172 applies SQL LIMIT/OFFSET, so a line straddling a page boundary loses its cross-page link and the first row of each page-group emits no link (713); the harm depends on a consumer actually paginating and stitching, but the emitted data is genuinely incoherent under paging.

---

<a id="r46"></a>
### R46. Rows lost between FOR UPDATE select and the UPDATE are counted as success, not failure (applied/persisted = len(versions))

`db.py:388-416`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** applied and persisted are derived from len(versions) (the rows the UPDATE...RETURNING actually returned), but update_rows is built from the FOR UPDATE snapshot. If any id in update_rows is not written by the final UPDATE (e.g. its row was deleted by a concurrent purge_orders_by_date / re-upload after the SELECT but before this statement, or otherwise vanished), versions silently has fewer entries. failed stays 0, so the caller's reconciliation in brain.py (`if res['persisted'] < total`) logs a benign warn but the missing ids are reported in NEITHER stale, not_found, NOR failed - the client never learns those edits were dropped and never refetches them. The discrepancy is silent data loss of a user edit. The current comment claims 'A DB-write failure leaves Postgres unchanged' which is true for exceptions, but the partial-no-match case is not an exception.

**Evidence.**

```
cur.execute(sql, params)
                for rid, rver in cur.fetchall():
                    versions[rid] = int(rver)
                conn.commit()
                persisted = applied = len(versions)
            except Exception:
                conn.rollback()
                failed = len(update_rows)
                raise
```

**Suggested fix.** Compute the set of attempted ids = {r[2] for r in update_rows}; after the UPDATE, diff against versions.keys(). Report any id present in update_rows but absent from versions in `not_found` (or a new `lost` list) so the client can refetch/retry instead of silently believing the edit persisted. Alternatively assert len(versions) == len(update_rows) and surface the gap.

**Verification.** At line 409 persisted = applied = len(versions) where versions is built only from RETURNING rows (406-407), while update_rows came from the FOR UPDATE snapshot (388); a row vanishing between SELECT and UPDATE silently shrinks versions with failed staying 0, and the gap is reported in neither stale/not_found/failed.

---

<a id="r47"></a>
### R47. Every undo-tracked bulk edit writes TWO Time Machine snapshots (UndoStack.push patch + tasks:bulkUpdate subscription both fire)

`nimbus-intelligence.js:1163-1178`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** Almost every mutating command in this file follows the pattern `UndoStack.push(label, ...)` immediately followed by `Store.updateMany(patches, 'cmd-palette')` (see _buildSelectionCommands push/unschedule/fix at lines 1071-1113, and resolveIntent 'freeze' at 1624-1627). UndoStack.push is monkey-patched to snapshot, and Store.updateMany emits 'tasks:bulkUpdate' (app.js:684) whose source ('cmd-palette') is NOT in the {'undo','time-machine'} exclusion list, so the subscription ALSO snapshots. Result: one user action produces two IndexedDB writes and two history rows — snapshot #1 captures pre-edit state mislabeled with the action label, snapshot #2 captures post-edit state labeled the generic 'Bulk update'. This doubles IDB write volume, halves effective retention under the 200-entry prune cap, and clutters both the Time Machine list and the Diff snapshot picker with redundant/mislabeled entries.

**Evidence.**

```
init() {
  const origPush = UndoStack.push.bind(UndoStack);
  UndoStack.push = (label, undoFn) => {
    origPush(label, undoFn);
    TimeMachine.snapshot(label, { auto: true });        // snapshot #1
  };
  Store.subscribe(evt => {
    if (['tasks:bulk','tasks:bulkUpdate'].includes(evt.type) &&
        evt.source !== 'undo' && evt.source !== 'time-machine') {
      TimeMachine.snapshot(evt.type === 'tasks:bulk' ? 'Data loaded' : 'Bulk update', { auto: true }); // snapshot #2
    }
  });
```

**Suggested fix.** Pick one capture point. Either (a) exclude the cmd-palette/engine sources from the bulkUpdate subscription the same way 'undo'/'time-machine' are excluded, or (b) drop the snapshot() call from the UndoStack.push monkey-patch and rely solely on the Store-event subscription (adding 'task:update' to it if single-edit history is wanted). Also give the surviving path a meaningful label.

**Verification.** UndoStack.push is monkey-patched to snapshot (1164-1168) AND the Store subscription snapshots on tasks:bulkUpdate excluding only 'undo'/'time-machine' (1169-1173); updateMany emits tasks:bulkUpdate with source 'cmd-palette'/'engine' (app.js:684), which is not excluded, so push-then-updateMany command paths double-snapshot.

---

<a id="r48"></a>
### R48. TimeMachine.snapshot corrupts in-memory snap.id with an IndexedDB transaction Event object

`nimbus-intelligence.js:1198-1202`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** IntelDB.put resolves via `tx.oncomplete = res` (line 358), so the resolved value is the transaction `complete` Event, NOT the autoIncremented key. Because the snapshot object has no `id` before the put, `snap.id = id || snap.id` assigns the truthy Event object to `snap.id`. The in-memory `_snapshots` entry therefore carries a bogus `id` (an Event), diverging from the real numeric primary key that `getAll` returns on a later page reload. restore()/_plantSnaps() key off `ts` so they still work, and pruneSnapshots re-reads DB rows (real ids), so the impact is limited — but any future code keying snapshots by `id` (e.g. dedup, delete-by-id) will silently fail on freshly-created snapshots while working on reloaded ones, an inconsistency that is hard to debug.

**Evidence.**

```
IntelDB.put('snapshots', snap).then(id => {
  snap.id = id || snap.id;
  TimeMachine._snapshots.push(snap);
  IntelDB.pruneSnapshots(200);
}).catch(() => {});
```

**Suggested fix.** Have IntelDB.put resolve with the generated key: in put(), capture `const req = tx.objectStore(store).put(value);` and on `tx.oncomplete` resolve `req.result` (the key). Then `snap.id = key` is correct. Alternatively in snapshot() stop trusting the resolved value and re-read the key, or drop the `snap.id = id` line entirely since restore keys by ts.

**Verification.** IntelDB.put resolves with `tx.oncomplete = res` (line 358), so the resolved value is the transaction complete Event, and snapshot()'s `snap.id = id || snap.id` (line 1199) assigns that Event to snap.id since the object had no prior id; impact is genuinely limited because restore()/_plantSnaps key off ts, so medium severity is slightly overstated for current behavior.

---

<a id="r49"></a>
### R49. Horizon-column ×1440 UPDATE re-multiplies any legitimate sub-365 horizon edit on every schema.sql re-run

`schema.sql:103-105`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** These two UPDATEs are unconditional data mutations gated only by a value threshold (<= 365), not by any migration-version flag or sentinel. The defaults (43200, 20160 minutes) are above 365 so a fresh DB is safe, and a one-time day->minute conversion is correct. But the operation is NOT idempotent: if an operator legitimately sets a horizon to a small minute value (e.g. ~300 minutes, or any stored value that happens to be <= 365), the NEXT schema.sql re-run silently multiplies it by 1440 again, corrupting it to 432000. CLAUDE.md explicitly documents schema.sql is re-applied routinely (e.g. 'Re-run schema.sql after pulling this change' for orders.plant), so re-runs are expected operations, not a one-time event. There is no way to distinguish 'a 300-minute horizon the user set' from 'a 300-day legacy value needing conversion'. Silent corruption of scheduling horizons directly affects alert/confidence windows across all plants.

**Evidence.**

```
-- Convert existing day-valued rows to minutes (safe: day values are always <= 365)
UPDATE plants SET alt_flag_horizon   = alt_flag_horizon   * 1440 WHERE alt_flag_horizon   <= 365;
UPDATE plants SET conf_score_horizon = conf_score_horizon * 1440 WHERE conf_score_horizon <= 365;
```

**Suggested fix.** Make the conversion run-once instead of value-gated. Option A: add a marker (plants.horizon_unit_minutes BOOLEAN DEFAULT FALSE, or a schema_migrations table) and only run the ×1440 UPDATE for not-yet-migrated rows, then mark them. Option B: drop the migration from schema.sql entirely and move it to a one-shot migration file that is explicitly never re-applied. Either way, the in-place value-threshold UPDATE must not live in a file the runbook says to re-run.

**Verification.** schema.sql lines 103-105 match exactly: the UPDATEs are gated only by value threshold (<=365), not a migration flag, and CLAUDE.md's own Database Setup section documents this exact non-idempotent re-multiply hazard on re-run.

---

<a id="r50"></a>
### R50. orders.plant backfill arbitrarily picks lowest plant when a line code is reused across plants, silently mis-attributing orders

`schema.sql:143-149`  ·  **MEDIUM**  ·  _bug-error_  ·  confidence: high

**Why it matters.** The backfill resolves an order's plant from production_lines by production_line alone, using ORDER BY pl.plant LIMIT 1 to pick deterministically. The whole reason orders.plant was added (comment at lines 126-135 and CLAUDE.md) is that line codes ARE reused across plants at the 50+ plant / 3,500+ line target scale. When a line code exists under multiple plants, this backfill assigns the alphabetically/numerically lowest plant — an arbitrary, possibly wrong attribution then treated as authoritative by the /tasks read path (which selects o.plant directly and no longer joins, confirmed db.py query_orders line 159/166). This re-introduces the very mis-attribution the column was meant to fix, just at backfill time, and it is silent (no warning, no NULL-left-for-review). make_id() is also plant-blind (MD5 of order|material), so same-coded lines in different plants can't be distinguished.

**Evidence.**

```
UPDATE orders o
   SET plant = (
       SELECT pl.plant FROM production_lines pl
        WHERE pl.production_line = o.production_line
        ORDER BY pl.plant LIMIT 1
   )
 WHERE o.plant IS NULL;
```

**Suggested fix.** Only backfill rows whose line code maps to exactly one plant (guard with a COUNT(DISTINCT pl.plant) = 1 check), leaving genuinely ambiguous rows NULL so the upload-picker / WERKS column path can attribute them authoritatively. Surface the count of un-attributable rows. Long-term, carry plant in the upload and in make_id as MIGRATION.md notes.

**Verification.** schema.sql lines 143-149 resolve plant via SELECT ... ORDER BY pl.plant LIMIT 1 with no single-plant guard, and db.py query_orders (line 159) selects o.plant directly, so an ambiguous line code is silently attributed to the lowest plant and treated as authoritative.

---

<a id="r51"></a>
### R51. LaborPlanning async render has no generation guard — fast plant/horizon switches interleave stale data into the live grid

`app.js:2289-2308, 2649-2660, 2971-2999`  ·  **MEDIUM**  ·  _risk_  ·  confidence: medium

**Why it matters.** render(), _renderLinePlan, _renderCapacity, _renderExceptions and _fetchLines are all async with awaited fetches but carry no request-generation/cancellation token. _fetchLines computes from_date/to_date from the module-level _weeks at call time, but _weeks is reassigned at the top of every render(). If the user changes the horizon (prevHorizon/nextHorizon/setSpan) or switches plant while a prior fetch is in flight, the late-resolving fetch merges rows into _lineData and the late render writes innerHTML over the grid the newer render already produced — a classic last-response-wins stale-render race. Because _weeks may have changed between the fetch dispatch and the render that consumes the result, the rendered day columns can also mismatch the fetched window.

**Evidence.**

```
async function render() {
  _weeks = _computeWeeks();
  const plant = Store.selectedPlant;
  ...
  if (sub === 'aggregate')   await _renderAggregate(plant);
  else if (sub === 'line-plan')  await _renderLinePlan(plant);
...
async function _fetchLines(plant, group) {
  const w0 = _weeks[0], wN = _weeks[_weeks.length - 1];
  ...
  const res = await fetch(url);
  ...
  (json.rows || []).forEach(r => { ... _lineData[plant][r.production_line][r.day] = ...; });
```

**Suggested fix.** Add a monotonically increasing _renderToken captured at the start of render() (and passed to the sub-renderers/_fetchLines); after each await, bail if the captured token !== the current _renderToken. Alternatively use an AbortController per render cycle and abort the previous one.

**Verification.** render() (2972), _fetchLines (2289) and the sub-renderers are all async with awaited fetch()es and no captured render token or AbortController; _weeks is reassigned at the top of every render() and _fetchLines derives its window from module-level _weeks, so a late-resolving fetch writes _lineData and innerHTML after a newer render — a real last-response-wins race.

---

<a id="r52"></a>
### R52. Web Worker loaded by bare filename with no cache-bust query — stale cached worker silently diverges from freshly-deployed app.js

`app.js:3448`  ·  **MEDIUM**  ·  _risk_  ·  confidence: high

**Why it matters.** CLAUDE.md states APP_VERSION/NIMBUS_BUILD_ID are bumped on every deploy to bust static asset caches, and that nimbus-worker.js is a hand-port that MUST mirror Calendar+Alerts rule-for-rule. But the worker is instantiated with a bare filename ('nimbus-worker.js') — unlike the versioned <script src=...?v=...> tags in index.html, there is no ?v= cache-bust on the worker URL. After a deploy that changes BOTH app.js (Calendar/Alerts) AND nimbus-worker.js, the browser can serve a STALE cached nimbus-worker.js (HTTP cache / service worker) while running fresh app.js. The off-thread Alerts/Utilization compute would then use the OLD rules while the sync fallback uses the NEW rules — the exact rule-for-rule drift the architecture warns against, now triggered by caching rather than by an un-mirrored edit. At the 50+ plant / 3,500-line scale the worker path is the dominant one (it only runs when a plant is selected and something is on screen), so users would see incorrect alerts/capacity with no error. This is the single most likely real-world cause of worker/sync divergence.

**Evidence.**

```
_worker = new Worker('nimbus-worker.js');
```

**Suggested fix.** Append the same build version to the worker URL: new Worker('nimbus-worker.js?v=' + Config.BUILD_ID) (or read NIMBUS_BUILD_ID). Bump it on every deploy alongside APP_VERSION so a worker source change always invalidates the cached copy. Confidence high that the gap exists; the fix is mechanical.

**Verification.** app.js:3448 instantiates `new Worker('nimbus-worker.js')` with a bare filename and no `?v=` build-id, unlike the versioned <script> tags, so an HTTP/SW-cached stale worker can run old Calendar/Alerts rules against fresh app.js — exactly the rule-for-rule drift CLAUDE.md warns about.

---

<a id="r53"></a>
### R53. Compute worker is never restarted after a single onerror, making sync fallback permanent for the session

`app.js:3456-3466`  ·  **MEDIUM**  ·  _risk_  ·  confidence: high

**Why it matters.** A single worker onerror sets _dead=true permanently. _init() short-circuits forever after (if (_dead || _worker) return _worker; at 3446). Because available() returns !_dead && ..., Alerts.recompute (3548) and all utilization pre-warming route to the main thread for the rest of the session with no auto-recovery. At the stated scale target (70+ lines/plant, heavy structured-clone alert/utilization compute) a one-off worker error (transient OOM, a script-parse hiccup on slow load) permanently moves the dominant compute cost onto the main thread, degrading UI responsiveness until a full page reload. The onerror also records no telemetry, so this silent degradation is invisible in PerfMonitor/ErrorLog.

**Evidence.**

```
_worker.onerror = () => {
  for (const p of _pending.values()) p.reject(new Error('worker error'));
  _pending.clear();
  _worker = null;
  _dead   = true;
};
```

**Suggested fix.** Add bounded auto-restart: keep a retry counter, log via ErrorLog/PerfMonitor in onerror, and allow _init to recreate the worker up to N times (resetting _dead=false) before giving up permanently. At minimum record an ErrorLog entry in onerror so the permanent fallback is observable.

**Verification.** onerror at 3456-3461 sets _dead=true permanently, _init short-circuits forever (if (_dead||_worker) return at 3446), available() returns !_dead, and no ErrorLog/telemetry is recorded in onerror — so a single worker error routes all compute to the main thread for the session with no recovery or observability.

---

<a id="r54"></a>
### R54. /diagnostics/db has no per-call error isolation — one failing probe 500s the entire panel

`brain.py:1314-1332`  ·  **MEDIUM**  ·  _risk_  ·  confidence: high

**Why it matters.** Eight independent DB observability probes are evaluated eagerly in a single dict literal with no try/except around any of them. `get_db_slow_queries` depends on the `pg_stat_statements` extension, which is frequently not installed; `get_db_lock_waits` / `get_db_connection_activity` query system views that can require privileges. If ANY single probe raises, the whole endpoint returns 500 and the Admin Cockpit DB Deep Dive panel shows nothing — even though pool/server/table health were fine. This is the opposite of the resilient pattern used elsewhere in this file (e.g. the upload warnings block at 925-933 and the color_reachable guard at 516-519 both swallow per-section failures).

**Evidence.**

```
    return {
        "pool":         db.get_pool_stats(),
        "server":       db.get_db_server_info(),
        "tables":       db.get_db_table_stats(),
        "connections":  db.get_db_connection_activity(),
        "locks":        db.get_db_lock_waits(),
        "indexes":      db.get_db_index_usage(),
        "slow_queries": db.get_db_slow_queries(),
        "sequences":    db.get_db_sequence_health(),
        "fetched_at":   pd.Timestamp.utcnow().isoformat(),
    }
```

**Suggested fix.** Wrap each probe in a small helper that returns `{"error": str(e)}` on failure (e.g. `def _safe(fn): try: return fn() except Exception as e: return {"error": str(e)}`) so a missing pg_stat_statements or a single failing view degrades gracefully to a partial payload instead of a total 500.

**Verification.** Lines 1322-1332 evaluate all eight db.* probes eagerly inside one dict literal with no try/except, so any single probe raising (e.g. missing pg_stat_statements in get_db_slow_queries) returns 500 for the whole endpoint.

---

<a id="r55"></a>
### R55. Bulk update SELECT ... FOR UPDATE locks rows in unspecified order — deadlock risk under concurrent saves

`db.py:352-364`  ·  **MEDIUM**  ·  _risk_  ·  confidence: medium

**Why it matters.** update_task_dates_bulk is the backend persistence path (Cmd/Ctrl+S saveAll). SELECT ... FOR UPDATE with id = ANY(array) acquires row locks in whatever order Postgres scans them — there is no ORDER BY. Two users saving overlapping sets of orders (common when two planners edit the same plant) can each grab a subset of the locks and then block waiting on the other, producing a classic lock-ordering deadlock; Postgres aborts one transaction with a deadlock error, surfacing as a 500 and a lost save. The single-transaction design makes this a real availability issue at multi-user scale, not just theoretical.

**Evidence.**

```
ids = [it["id"] for it in items if it.get("id")]
with _pool.connection() as conn, conn.cursor() as cur:
    cur.execute(
        """
        SELECT id,
               COALESCE(scheduled_start, basic_start_date)  AS eff_start,
               COALESCE(scheduled_end,   basic_finish_date) AS eff_end,
               xmin::text::bigint                           AS row_version
        FROM orders WHERE id = ANY(%s)
        FOR UPDATE
        """,
        (ids,),
    )
```

**Suggested fix.** Acquire row locks in a deterministic order so concurrent transactions cannot form a cycle: add 'ORDER BY id' to the SELECT ... FOR UPDATE (Postgres honors ORDER BY for lock-acquisition order). Cheap, no schema change, eliminates this deadlock class.

**Verification.** Lines 353-363 issue SELECT ... FROM orders WHERE id = ANY(%s) FOR UPDATE with no ORDER BY, so concurrent overlapping saves can acquire locks in conflicting orders; the single-transaction multi-user save path makes the classic lock-ordering deadlock real, and ORDER BY id is a valid cheap mitigation.

---

<a id="r56"></a>
### R56. viewport meta blocks pinch-zoom (maximum-scale=1, user-scalable=no) — accessibility violation

`index.html:5`  ·  **MEDIUM**  ·  _risk_  ·  confidence: high  ·  **⚖️ needs-human-judgment**

**Why it matters.** Setting maximum-scale=1 and user-scalable=no disables browser pinch-zoom entirely, which fails WCAG 1.4.4 (Resize Text) and 1.4.10 (Reflow) — low-vision users cannot magnify the UI. A dedicated inline <script> at the top of the file (lines 6-18) already intercepts Ctrl+wheel and Ctrl +/-/0 to lock desktop zoom, so the viewport restriction is redundant for the stated goal (protecting Gantt scroll-zoom) and only adds the accessibility cost on touch devices. For an enterprise tool deployed to many plants this is a real compliance gap.

**Evidence.**

```
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
```

**Suggested fix.** Remove `maximum-scale=1, user-scalable=no` from the viewport meta, leaving `width=device-width, initial-scale=1`. The existing JS zoom-lock script already covers the Gantt-zoom-protection intent on desktop without penalizing touch/low-vision users.

**Verification.** index.html line 5 does set maximum-scale=1, user-scalable=no and the JS zoom-lock at lines 6-18 exists, but whether removing the viewport restriction is desired depends on product/accessibility-compliance intent, not source correctness.

---

<a id="r57"></a>
### R57. scheduleKpis bypasses computeMatrix memoization on every optimizer-preview call

`app.js:352-360`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** scheduleKpis always passes a non-null `tasks` array as the 3rd arg to computeMatrix. Per the memo logic at lines 4212-4216 (`const cacheable = srcTasks === null; if (cacheable && Utilization._cache && ...) return Utilization._cache.matrix;`), any non-null srcTasks bypasses the cache entirely and rebuilds the full per-line per-day matrix from scratch, re-invoking Calendar.dailyCapacityHours / effectiveCapacityHours for every line/day cell. The OptimizerPreview before/after flow calls scheduleKpis twice per optimize run, each forcing a full O(lines x days) synchronous main-thread build. At the 3,500-line target this is multi-second work, repeated rather than reused. CLAUDE.md documents this memo-bypass for Dashboard; scheduleKpis is a second independent caller hitting the same cost.

**Evidence.**

```
try {
  const m = Utilization.computeMatrix(new Date(), horizonDays, tasks);
  for (const ln of Object.keys(m)) {
    for (const d of Object.keys(m[ln])) {
      const p = m[ln][d]?.pct || 0;
      if (p > peak) peak = p;
```

**Suggested fix.** scheduleKpis operates on a candidate task set so it cannot use the Store-backed memo, but the matrix is only used to extract peak pct. Compute peak utilization with a lighter single-pass accumulation over the candidate tasks rather than constructing the full nested matrix object, or memoize on a hash of the task subset for the before/after pair within one optimize run.

**Verification.** scheduleKpis passes non-null tasks to computeMatrix (353) and the memo at 4212-4216 only caches when srcTasks===null, so each before/after preview call rebuilds the full per-line/day matrix; the cited memo lines match exactly.

---

<a id="r58"></a>
### R58. workWindow memoization (_runCache) exists only during Engine runs; the UI render path is fully unmemoized

`app.js:1000-1038`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** The workWindow memo (rc.ww Map) is only consulted/populated when Calendar._runCache is non-null, which is true only between _beginRun and _endRun inside Engine.runAndApply (line 4552). On the render path (_runCache === null) every workWindow call recomputes from scratch: ensureCalendar, _dayWindow (allocates 3 Date objects at lines 988/992/993), getPlantForLine, ensurePlant, a second _dayWindow, plus Math.max/Math.min Date construction (1025-1026). Within a single dashboard frame the same (line, day) workWindow is recomputed many times: inside dailyCapacityHours, again inside effectiveCapacityHours->dailyCapacityHours, again directly at computeMatrix line 4275, and again in the Alerts pass. There is no frame-scoped or _rev-keyed cache for the live path.

**Evidence.**

```
workWindow(line, date) {
  const rc = Calendar._runCache;
  let key;
  if (rc) {
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    key = line + '|' + d.getTime();
    if (rc.ww.has(key)) return rc.ww.get(key);
  }
  Store.ensureCalendar(line);
  const lineWin = Calendar._dayWindow(Store.calendars[line].workHours, date);
```

**Suggested fix.** Promote the workWindow memo to a render-path cache keyed on (line|startOfDayMs|Store._rev), mirroring Utilization._cache's _rev-based invalidation, so repeated same-frame lookups across dailyCapacityHours / effectiveCapacityHours / computeMatrix / Alerts hit the cache. Combine with the daily+effective single-call fix so workWindow runs once per (line,day) per frame instead of 4+ times.

**Verification.** app.js 1001-1006 only consults/populates rc.ww when _runCache is non-null (set in _beginRun/_endRun around Engine.runAndApply), so on the render path every workWindow call recomputes via ensureCalendar + two _dayWindow Date allocations; the same (line,day) is recomputed multiple times per frame across dailyCapacityHours/effectiveCapacityHours/computeMatrix line 4275.

---

<a id="r59"></a>
### R59. Plant._renderHours destroys and recreates 14 Flatpickr instances plus a rAF on every render

`app.js:1441-1482`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** Plant.render() (1393-1401) calls _renderHours() unconditionally, and Plant.init subscribes to 'plant:selected' to re-render (1378-1390). Every render tears down all 14 Flatpickr instances (7 start + 7 end) and rebuilds them inside a requestAnimationFrame. Flatpickr instantiation builds a full calendar DOM subtree per input; destroying and recreating 14 of them on each plant selection / render is wasteful DOM churn. Because the rebuild is deferred to rAF while body.innerHTML (1462) is set synchronously, there is also a frame where the pill inputs exist but are not yet wired. This is single-plant UI, not on the 3,500-line scale path, so impact is interaction smoothness rather than throughput -- hence medium.

**Evidence.**

```
if (Plant._pillFps) {
  Plant._pillFps.forEach(p => { p.start?.destroy(); p.end?.destroy(); });
}
Plant._pillFps = Array(7).fill(null).map(() => ({ start: null, end: null }));
...
requestAnimationFrame(() => {
  for (let d = 0; d < 7; d++) {
    Plant._pillFps[d].start = flatpickr(`#plant-pill-start-${d}`, {...});
    Plant._pillFps[d].end = flatpickr(`#plant-pill-end-${d}`, {...});
  }
});
```

**Suggested fix.** Build the 14 Flatpickr instances once (lazy init guarded by if (!Plant._pillFps)) and on subsequent renders update them in place via setDate(value, false) rather than destroy()+recreate. This matches the documented lazy-init + setDate pattern used elsewhere (Calendar._fpBlkStart, Plant._fpBlkStart). Only destroy when the plant actually changes if instance reuse across plants is undesirable.

**Verification.** app.js 1441-1443 destroys all 14 existing _pillFps and 1444 rebuilds the array, then the rAF at 1464-1482 recreates 14 flatpickr instances on every render; this contradicts the lazy-init+setDate pattern used for _fpBlkStart, though impact is single-plant UI smoothness so medium is reasonable.

---

<a id="r60"></a>
### R60. ProdLines.render re-fetches lines and re-ensures calendars/settings for the full line list on every keystroke in the filter

`app.js:1882-1919, 1928-1929, 1997-2011, 2029-2037`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** Typing in the line-search input fires oninput -> ProdLines.render() per keystroke. Each render re-fetches linesForSelectedPlant() and loops the entire line list calling Store.ensureCalendar + Store.ensureLineSettings, re-renders the nav with allLines.indexOf per shown line (O(shown x all)), and re-renders the detail which calls linesForSelectedPlant() AGAIN (line 1928) plus indexOf. At 70 lines/plant (or the no-plant fallback over all lines) this re-walks and re-ensures the full list per character. The ensure* loop is pure redundant work after first render since calendars/settings already exist.

**Evidence.**

```
render(){ const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : Calendar._getLines(); allLines.forEach(l => { Store.ensureCalendar(l); Store.ensureLineSettings(l); }); ... ProdLines._renderNav(allLines, shownLines); } _wireNav: input.oninput = function(){ ProdLines._lineFilter = this.value; ProdLines.render(); }; _renderDetail: const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : Calendar._getLines(); const gi = allLines.indexOf(line); _renderNav: const gi = allLines.indexOf(line) inside shownLines.map.
```

**Suggested fix.** Debounce the filter oninput (120-150 ms). Move the one-time ensureCalendar/ensureLineSettings loop out of render() into an init/plant-change path. In _renderNav build a Map(line -> globalIndex) once instead of allLines.indexOf inside the map loop. Pass allLines into _renderDetail to avoid the second linesForSelectedPlant() call.

**Verification.** _wireNav (2033-2036) wires input.oninput to call ProdLines.render() with no debounce; render() (1885-1890) re-fetches linesForSelectedPlant() and loops the full list calling ensureCalendar/ensureLineSettings, _renderNav does allLines.indexOf per shown item (2001), and _renderDetail calls linesForSelectedPlant() again (1928) — all per keystroke.

---

<a id="r61"></a>
### R61. _disaggregate re-filters all lines and recomputes effectiveCapacityHours over lines x 7 days per aggregate cell, multiplied across a paste

`app.js:2311-2331, 2600-2614`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** In the paste path _disaggregate is called once per pasted cell. Each call re-filters the entire masterData.lines array (O(all lines)) then loops linesInGroup x 7 days, each calling effectiveCapacityHours -> dailyCapacityHours -> workWindow (calendar + blackout evaluation). Pasting an R x C block costs O(R*C * allLines) for the filter plus O(R*C * linesInGroup * 7) capacity evaluations with no memoization across the paste (unlike _renderLinePlan which added _capMemo). At scale (70+ lines, large Excel paste) this is a noticeable synchronous main-thread stall.

**Evidence.**

```
function _disaggregate(plant, group, periodKey, groupHours){ const lines = (Store._state.masterData?.lines || []).filter(l => l.plant === plant && l.pl_group === group).map(l => l.production_line); ... lines.forEach(line => { for (let d=0; d<7; d++){ ... if (Calendar.effectiveCapacityHours(line, date) > 0) openSlots.push(...); } }); }
paste: clipRows.forEach(... clipCols.forEach((val,c) => { ... if (ah !== null) allSplits.push(..._disaggregate(plant, grp, period, ah)); }));
```

**Suggested fix.** Precompute a Map(group -> line list) once before the paste loop instead of re-filtering per cell. Add a per-paste memo for effectiveCapacityHours keyed by line|dayKey (mirroring _capMemo in _renderLinePlan). Batch disaggregation after the paste loop completes.

**Verification.** _disaggregate (2312-2325) re-filters masterData.lines and loops linesInGroup×7 days calling Calendar.effectiveCapacityHours with no memo, and the paste loop (2614) calls it once per pasted cell, so an R×C paste costs O(R*C*allLines) filtering plus uncached capacity evaluations — unlike _renderLinePlan which added _capMemo (2701).

---

<a id="r62"></a>
### R62. computeMatrix cache key uses mismatched day counts (90 vs 84), guaranteeing a cache miss and a full all-lines rebuild on every Labor render

`app.js:2345-2346, 2672, 2803, 2860, 4210-4216`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** LaborPlanning.render() calls _renderKPIs() (computeMatrix with days=min(span*7,90)) immediately followed by a sub-tab renderer (days=min(span*7,84)). The Utilization cache is a single slot keyed by start|days|rev with NO plant discriminator. For any span >= 13 weeks the two day-counts differ (90 vs 84) so the second call always misses and rebuilds the whole matrix. Even when they coincide (e.g. 12 wk), the single-slot cache is immediately overwritten so the next sub-tab switch re-misses. computeMatrix loops over every line that has a calendar (Object.keys(Store.calendars), line 4221) x days, then over all tasks. At 70 lines/plant or the 3,500-line system target this is a multi-thousand-cell rebuild run twice per render and again on every horizon nav / group toggle / sub-tab switch.

**Evidence.**

```
_renderKPIs: const horizonDays = Math.min(_horizonSpan * 7, 90); const matrix = Utilization.computeMatrix(horizonStart, horizonDays);
line-plan/capacity/exceptions all use: Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
computeMatrix cache: const cacheKey = `${start.getTime()}|${days}|${Store._rev || 0}`; if (cacheable && Utilization._cache && Utilization._cache.key === cacheKey) return Utilization._cache.matrix;
```

**Suggested fix.** Compute one consistent day-count once in render() and pass it to KPIs and every sub-tab renderer so the second call hits the cache. Better: build the matrix once per render() and pass it down as a parameter. Long-term add a plant discriminator to the cache key and scope the matrix to the selected plant's lines.

**Verification.** _renderKPIs uses min(span*7,90) (2345) and the sub-renderers use min(span*7,84) (2672/2803/2860) against a single-slot cache keyed start|days|rev (4213); at the 16-week option these differ (112→capped 90 vs 84) forcing a second full rebuild, though the title overstates it as 'every render' — at the default/12-week span both cap to 84 and match.

---

<a id="r63"></a>
### R63. _renderExceptions iterates all plant lines x all matrix days against an unscoped global matrix

`app.js:2855-2875`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** _renderExceptions calls computeMatrix which builds rows for EVERY line that has a calendar across the whole system (line 4221 Object.keys(Store.calendars)), not just this plant, then walks plantLines x days. computeMatrix itself is O(allLines x days + tasks); at the 3,500-line target it builds rows for all 3,500 lines though only this plant's ~70 are read. Combined with _renderKPIs and the sub-tab renderer each independently calling computeMatrix with a different days, one Labor interaction can rebuild the global matrix 2-3 times.

**Evidence.**

```
const lines = (Store._state.masterData?.lines || []).filter(l => l.plant === plant).map(l => l.production_line); const utilMatrix = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84)); const exceptions = []; lines.forEach(line => { const lm = utilMatrix[line]; if (!lm) return; Object.entries(lm).forEach(([dayKey, cell]) => { ... }); });
```

**Suggested fix.** Scope computeMatrix to the selected plant's lines (plant-filtered task list or plant scoping + plant-keyed cache inside computeMatrix). Build the matrix once per render() and share it across _renderKPIs and all sub-tab renderers.

**Verification.** _renderExceptions (2860) calls the unscoped computeMatrix which adds rows for every line in Store.calendars (4221) across the whole system, then walks this plant's lines×days (2862-2874); combined with _renderKPIs and the sub-renderer's differing day-counts the global matrix is rebuilt multiple times per interaction.

---

<a id="r64"></a>
### R64. ColorWheelViewer._render rebuilds a full global task-count scan on every search keystroke and sort

`app.js:3352-3408`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** `_render` recomputes `taskCounts` by iterating the ENTIRE global `Store.tasksArr` (every task across every plant) and calling `Util.norm` per task on every invocation. `search()` calls `_render()` on every keystroke and `sort()` on every sort toggle, yet `taskCounts` depends only on `_plant` and the loaded data — never on `_search` or `_sort`. So the full O(total-tasks) scan is repeated on each keystroke purely to produce a per-color count map that never changes between keystrokes. At the stated scale target (3,500+ lines, large order volumes) this is a needless full-array sweep per keystroke inside a modal the user is actively typing in.

**Evidence.**

```
function _render() {
  ...
  // Task counts per color for this plant
  const taskCounts = {};
  for (const t of Store.tasksArr) {
    if (_plant && Store.getPlantForLine(t.PRODUCTION_LINE) !== _plant) continue;
    const c = Util.norm(t.COLOR);
    if (c && c !== 'NAN') taskCounts[c] = (taskCounts[c] || 0) + 1;
  }
  ...
}
// and:
function search(val) { _search = String(val || '').toLowerCase(); _render(); }
function sort(mode) { _sort = mode; ...; _render(); }
```

**Suggested fix.** Compute `taskCounts` once in `_load()` (right after `_entries` is set) and cache it on a module field (e.g. `_taskCounts`); have `_render()` read the cached map. Invalidate only when `_plant` or the underlying task set changes (e.g. recompute in `open`/`_load`). This makes per-keystroke `_render` cost proportional to the visible/filtered entry list rather than the global task array.

**Verification.** _render (3357-3363) iterates all of Store.tasksArr building taskCounts that depends only on _plant, while search() (3418-3420) and sort() (3423-3428) both call _render() — so the full O(total-tasks) scan repeats per keystroke even though the count map never changes between keystrokes.

---

<a id="r65"></a>
### R65. Utilization.dayByLine re-parses all blackout blocks once per line (unmemoized hot path)

`app.js:4311-4368`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** dayByLine (and todayByLine which delegates to it) is documented as unmemoized and not worker-offloaded. Inside the per-line loop it (1) rebuilds the full blackouts array by re-parsing every Store.blocks/plantBlocks entry once per line — O(lines x blocks) parse work — and (2) iterates the entire taskList per line with a string-compare filter rather than pre-grouping tasks by line, making it O(lines x tasks). At the 70+ lines target with large order/block counts this is a quadratic-ish scan re-run on each call.

**Evidence.**

```
`for (const line of lines) { ... const blackouts = []; for (const b of Store.blocks) { ... const s = Util.parseDate(b.start), e = Util.parseDate(b.end); if (s && e) blackouts.push({ s, e }); } for (const b of Store.plantBlocks) { ... } for (const t of taskList) { if ((t.PRODUCTION_LINE || 'Unknown') !== line) continue; ... } }`
```

**Suggested fix.** Parse blackout intervals once before the line loop (bucket plant blocks/line blocks by key like Calendar._indexBlocks). Pre-group taskList into a by-line map once (O(tasks)) and iterate only that line's tasks instead of filtering the full list per line.

**Verification.** Inside the per-line loop (4318) it rebuilds the blackouts array by re-parsing every Store.blocks/plantBlocks (4326-4335) and filters the full taskList per line (4336-4337) rather than pre-grouping, yielding the described O(lines x blocks) and O(lines x tasks) work.

---

<a id="r66"></a>
### R66. OptimizeDialog line search re-scans all plant orders and rebuilds line list on every keystroke

`app.js:4858-4925`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** filterLines() (bound to the line-search input) calls _renderLines() on every keystroke. _renderLines() rebuilds allLines via _linesForPlant() (which itself builds a Set from Store.linesForSelectedPlant() plus a full Store.tasksByPlant(_plant) scan) AND re-scans Store.tasksByPlant(_plant) again to recompute orderCounts, then regenerates the entire <li> innerHTML for all matching lines. None of this is cached. At the 70+ lines/plant target with large per-plant order counts, each keystroke re-scans all plant orders twice and re-renders the full filtered list. _onLineToggle also recomputes _linesForPlant() purely to get a count.

**Evidence.**

```
_renderLines(): `const allLines = _linesForPlant();` then `const orderCounts = {}; for (const t of Store.tasksByPlant(_plant)) { const l = t.PRODUCTION_LINE || 'Unknown'; orderCounts[l] = (orderCounts[l] || 0) + 1; }` ... filterLines(q): `_lineSearch = q || ''; _renderLines();` ... _onLineToggle: `const total = _linesForPlant().length;`
```

**Suggested fix.** Compute allLines and orderCounts once when the plant is selected (cache on _plant change) and reuse across keystrokes; filterLines should only re-filter the cached array and re-render visible rows. Cache _linesForPlant().length for the _onLineToggle count instead of recomputing.

**Verification.** filterLines (4903) calls _renderLines on each keystroke, which calls _linesForPlant (4863, scanning tasksByPlant) and re-scans Store.tasksByPlant for orderCounts (4872) then regenerates all <li>, with no caching.

---

<a id="r67"></a>
### R67. zoomToFit uses Math.min/Math.max spread over all tasks — RangeError risk and O(2n) at scale

`app.js:5998-6007`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** zoomToFit reads Store.tasksArr (ALL tasks across ALL plants, not plant-scoped) and spreads two freshly-allocated arrays into Math.min/Math.max. The spread operator pushes every element as a separate function argument; at the documented 3,500-line / many-thousands-of-orders target this risks a 'RangeError: too many function arguments' and, short of throwing, allocates two intermediate arrays plus two O(n) passes over the entire global task list on every zoom-to-fit. It is also not scoped to the selected plant, unlike the rest of Timeline which uses tasksForSelectedPlant().

**Evidence.**

```
const tasks = Store.tasksArr.filter(t => t.start_date && t.end_date);
if (!tasks.length) return;
const minT = Math.min(...tasks.map(t => t.start_date.getTime()));
const maxT = Math.max(...tasks.map(t => t.end_date.getTime()));
```

**Suggested fix.** Replace the spread with a single linear loop over the plant-scoped list: iterate Store.tasksForSelectedPlant() tracking running minT/maxT, skipping rows without start/end. One pass, no array allocation, no spread, plant-scoped.

**Verification.** Lines 6002-6003 spread freshly-mapped arrays over the global Store.tasksArr into Math.min/max; the spread/allocation and plant-blind scope are real, though RangeError only manifests at extreme counts so high severity is overstated.

---

<a id="r68"></a>
### R68. Chip dropdowns re-scan all plant tasks and rebuild full innerHTML on every store event, even while hidden

`app.js:6244-6285, 6448`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** _onStore calls _refreshChipDropdowns() on tasks:bulk, plant:selected and lineSettings:change (6448). Each call iterates all plant tasks twice (lines in _buildLineChipDropdown, colors in _buildColorChipDropdown), sorts, and replaces the entire dropdown innerHTML — even though the dropdowns are hidden until the user opens them. The line dropdown is also a scale anti-pattern flagged in CLAUDE.md: at 70+ lines/plant a flat checkbox list rebuilt as one innerHTML string is slow and unusable (no filtering).

**Evidence.**

```
_refreshChipDropdowns() { Table._buildLineChipDropdown(); Table._buildColorChipDropdown(); ... }
// _buildLineChipDropdown:
for (const t of (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])) { if (t.PRODUCTION_LINE) lineSet.add(t.PRODUCTION_LINE); }
const sorted = [...lineSet].sort(...);
drop.innerHTML = sorted.map(...).join('')
```

**Suggested fix.** Build chip dropdown contents lazily — only when the dropdown is opened in _toggleChipDropdown — and memoize the line/color value sets on Store._rev so the double full-task scan is not repeated per store event. For the line dropdown, switch to a searchable/filterable combobox per the scale roadmap.

**Verification.** _refreshChipDropdowns (6244) calls the line/color builders that iterate tasksForSelectedPlant and replace full innerHTML (6251-6285), and it is invoked unconditionally at 6448 on tasks:bulk/plant:selected/lineSettings:change regardless of dropdown visibility.

---

<a id="r69"></a>
### R69. alerts:change handler forces a full redrawRows() of the entire grid on every alert recompute

`app.js:6472-6478`  ·  **MEDIUM**  ·  _performance_  ·  confidence: medium

**Why it matters.** On every alerts:change event the handler calls refreshCells({columns:['id'],force:true}) AND redrawRows() with no rowNodes argument, which destroys and re-renders EVERY rendered row. _rowClass / the alerts cellRenderer only need the cells whose alert state changed, but redrawRows() with no params is grid-wide. Alerts recompute frequently (after every drag/edit/reflow, and per CLAUDE.md the Confidence.init monkey-patch degrades every scheduled recompute to a full all-lines pass once the intelligence layer boots). At the stated scale target (70+ lines/plant, thousands of orders) a full grid redraw on each alert recompute is a significant main-thread cost and will cause visible jank during scheduling. refreshCells already handles the alerts column; the additional redrawRows() is the heavy and largely redundant part (it exists to re-apply the row-level cellClass _rowClass, but that can be done far more cheaply).

**Evidence.**

```
} else if (evt.type === 'alerts:change') {
  Table._api.refreshCells({ columns: ['id'], force: true });
  Table._api.redrawRows();
  if (Table._chipFilters.status === 'conflict' || Table._chipFilters.status === 'atrisk') {
    Table._api.onFilterChanged();
  }
}
```

**Suggested fix.** Drop the unconditional redrawRows(). To refresh row-level alert classes, scope the redraw to only the affected nodes (the alert taskIds carry the changed rows) or use api.refreshCells with the relevant row nodes, e.g. compute the set of taskIds present in Store.alerts deltas and call redrawRows({ rowNodes }) for just those.

**Verification.** Lines 6473-6474 call refreshCells({columns:['id'],force:true}) then redrawRows() with no rowNodes on every alerts:change, which rebuilds all visible row DOM; the redrawRows is redundant given refreshCells already handles the alerts column.

---

<a id="r70"></a>
### R70. _getLineOptions rebuilds a Set over all tasks + all calendars on every call, unmemoized and not plant-scoped

`app.js:6560-6564, 6841, 6092`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** _getLineOptions allocates a new array (Store.tasksArr.map over ALL tasks across ALL plants — not plant-scoped), builds a Set, merges all calendar keys, spreads, and sorts — every call. Called from Inspector._render (6841, once per inspector open and per task:update re-render of the focused order), from PRODUCTION_LINE cellEditorParams (6092, on every line-cell edit-start), init (6042) and the override modal (6600). With 3,500 lines and a large order table each Inspector re-render does a full O(tasks) scan + sort. It also scans the global Store.tasksArr rather than the plant-scoped set, leaking cross-plant lines into the dropdown — a correctness/scale concern at the 50+ plant target.

**Evidence.**

```
_getLineOptions() {
  const set = new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'));
  Object.keys(Store.calendars).forEach(l => set.add(l));
  return [...set].sort();
}
```

**Suggested fix.** Memoize the sorted line-option list on Store._rev and invalidate on tasks:bulk / calendars change; or scope it to the selected plant (tasksForSelectedPlant + that plant's calendars) so it is both correct per-plant and smaller. Pass the cached list into cellEditorParams instead of recomputing.

**Verification.** Lines 6560-6564 map over Store.tasksArr (all plants, not tasksForSelectedPlant), merge all Store.calendars keys, spread and sort on every call, and it is invoked from Inspector._render (6841) and cellEditorParams (6092) — unmemoized and cross-plant as described.

---

<a id="r71"></a>
### R71. Inspector._render does a full innerHTML rebuild + Flatpickr re-instantiation on every task:update for the inspected row

`app.js:6804-6805, 6833-6934`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** Every task:update for the currently-inspected task triggers a complete innerHTML teardown of the inspector body and a fresh Flatpickr instantiation on start_date (6928-6933), plus a full Table._getLineOptions() scan (6841) to rebuild the line <select>. _onFieldChange itself calls Store.updateTask (emitting task:update) and Engine.autoReflow, so editing start_date in the inspector re-renders the whole inspector and re-creates the Flatpickr picker mid-edit. Per CLAUDE.md the old Flatpickr instance is discarded on innerHTML reset with no destroy, leaking the prior picker's listeners until GC. Wasteful churn on a panel that updates on every drag/edit of the focused order.

**Evidence.**

```
if (evt.type === 'task:update' && String(evt.id) === Inspector._currentId) { Inspector._render(Store.tasks[Inspector._currentId]); }
// _render:
body.innerHTML = `...`;
const _dtEl = body.querySelector('[data-field="start_date"]');
if (_dtEl) { Util.fpDatetime(_dtEl, { onChange() { Inspector._onFieldChange('start_date', _dtEl.value); } }); }
```

**Suggested fix.** Make _render incremental for task:update: update only changed field values (start_date input value, end-date text, variance badge, alert card) in place rather than rebuilding innerHTML and re-instantiating Flatpickr. Reuse a single stored Flatpickr instance (Inspector._fpStart) with setDate() per the lazy-init pattern used elsewhere.

**Verification.** 6804-6805 re-renders on every task:update for the current id; _render rebuilds body.innerHTML (6844), re-runs Table._getLineOptions (6841) and re-instantiates Flatpickr (6928-6933) with no destroy of the prior instance.

---

<a id="r72"></a>
### R72. Inspector re-creates a Flatpickr instance on every _render with no destroy() — instance/listener/DOM leak

`app.js:6927-6933`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** _render runs on every Inspector.show AND on every task:update / tasks:bulk / fixed:change store event for the current id (subscription at 6791-6811). Each run rebuilds body.innerHTML (discarding the old input DOM) and then calls Util.fpDatetime() to spin up a NEW Flatpickr. Unlike every other Flatpickr in the file (Calendar._fpBlk*, Plant._pillFps which explicitly destroy(), OptimizeDialog _fpStart guarded by `if (_fpStart) return`), this instance is never stored and never destroyed. Flatpickr with altInput:true appends a .flatpickr-calendar to document.body and registers document-level event listeners; clearing inspector-body.innerHTML removes the original input but NOT the body-appended calendar node or the global listeners. Rapidly clicking through orders (the core scheduling workflow) leaks one Flatpickr instance + orphaned calendar DOM + document listeners per render — unbounded over a session. CLAUDE.md acknowledges 'initialized fresh on each Inspector._render() call (no stored instance; old one is discarded with innerHTML reset)', but innerHTML reset does not reclaim the body-level artifacts.

**Evidence.**

```
// Upgrade start_date to Flatpickr datetime picker
const _dtEl = body.querySelector('[data-field="start_date"]');
if (_dtEl) {
  Util.fpDatetime(_dtEl, {
    onChange() { Inspector._onFieldChange('start_date', _dtEl.value); }
  });
}
```

**Suggested fix.** Store the instance (Inspector._fp) and call Inspector._fp?.destroy() at the top of _render (or in clear()) before re-initializing, mirroring the Plant._pillFps.forEach(p=>p.start?.destroy()) pattern at line 1442. Alternatively configure the picker with static:true / appendTo the inspector body so the innerHTML reset reclaims it.

**Verification.** Lines 6928-6933 call Util.fpDatetime(_dtEl,...) on every _render with no stored instance and no destroy(), while _render fires on every task:update for the focused id (6804-6805); altInput Flatpickr appends a body-level calendar + document listeners that innerHTML reset does not reclaim.

---

<a id="r73"></a>
### R73. Dashboard render bypasses Utilization memo on every render (non-null filtered subset)

`app.js:7316-7322, 7670, 4212-4216, 4290`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** computeMatrix only memoizes when srcTasks===null. Dashboard always passes a non-null filtered subset (_filtered), so EVERY Dashboard render rebuilds the matrix from scratch — two full builds per render (a 7-day matrix in render() reused by KPIs+heatmap, plus a separate 1-day matrix in _renderLineStatus). Each build is O(lines x days) and calls Calendar.dailyCapacityHours + effectiveCapacityHours + workWindow per line-day cell (lines 4231-4232, 4275). render() runs on tasks:bulkUpdate / task:update / alerts:change / calendar:change / blocks:change / fixed:change (debounced 300ms, line 7169-7170). At the 70-lines/plant scale target, a 7-day build is ~490 cells each doing 3 Calendar lookups, redone on every dashboard-visible mutation with zero cache reuse. The memo exists but is structurally unreachable from the dashboard hot path.

**Evidence.**

```
render(): const _filtered = Dashboard._filteredTasks(); const _matrix7 = Utilization.computeMatrix(_now7, 7, _filtered); ... Dashboard._renderLineStatus() -> const matrix = Utilization.computeMatrix(now, 1, tasks);  // computeMatrix: const cacheable = srcTasks === null; if (cacheable && Utilization._cache && ...) return cached; ... if (cacheable) Utilization._cache = {...}
```

**Suggested fix.** Add a subset-aware memo: key the cache on (startMs, days, Store._rev, filterSignature) where filterSignature is derived from the sorted _filterLines set (empty set => the global/null path). Or, when _filterLines is empty, call computeMatrix with srcTasks=null so the dashboard shares the global memo, and only pass a subset when a line filter is actually active. Either change lets repeated same-tick renders (and re-renders within one dashboard paint) hit the cache.

**Verification.** Lines 7318 and 7670 always pass a non-null filtered subset and 4212 only memoizes the null path, so both dashboard matrix builds skip the cache; the perf cost is real but confined to debounced dashboard renders, not a sustained hot loop, so high is overstated.

---

<a id="r74"></a>
### R74. Dashboard render rebuilds the 1-day line-status matrix uncached every render (memo bypass, scale risk)

`app.js:7656-7670, 7316-7322`  ·  **MEDIUM**  ·  _performance_  ·  confidence: medium

**Why it matters.** `Utilization.computeMatrix` only caches when `srcTasks === null` (line 4212: `const cacheable = srcTasks === null`). Dashboard ALWAYS passes a filtered subset (`_filteredTasks()`), so every Dashboard render computes from scratch: one 7-day matrix in render() plus a separate 1-day matrix in `_renderLineStatus`, and `_renderLatenessHeatmap` walks all tasks again. This matches the CLAUDE.md note that Dashboard 'always passes a non-null filtered task subset, which bypasses the memo entirely'. The render() change already collapsed the prior three 7-day passes into one shared `_matrix7`, but the 1-day line-status matrix remains a separate uncached full pass on every debounced render (300 ms) and on every `alerts:change`. At the 50+ plant / 70+ line scale target, `computeMatrix` iterates all lines × days × tasks; an uncached rebuild on each alert recompute is a sustained main-thread cost.

**Evidence.**

```
// render() builds a filtered (non-null) 7-day matrix => not cacheable:
const _filtered = Dashboard._filteredTasks();
const _matrix7  = Utilization.computeMatrix(_now7, 7, _filtered);
// _renderLineStatus builds a SECOND filtered matrix, also non-null => not cacheable:
const tasks = Dashboard._filteredTasks();
...
const matrix   = Utilization.computeMatrix(now, 1, tasks);
```

**Suggested fix.** When no line filter is active (`Dashboard._filterLines.size === 0`), pass `srcTasks = null` so the memoized Store-backed path is used and shared with other consumers. Alternatively derive the 1-day line-status numbers from the already-built `_matrix7` (slice the first day) instead of a second `computeMatrix(now, 1, tasks)` call.

**Verification.** render() passes `_filtered` (7318) and _renderLineStatus passes `tasks` (7670), both non-null, while computeMatrix only caches when srcTasks===null (4212), so the 1-day line-status matrix is rebuilt uncached on every render as stated.

---

<a id="r75"></a>
### R75. DependencyOverlay.render computes line layout and chain lengths over ALL plants (unscoped Store.tasksArr / Store.tasks)

`app.js:8536-8580`  ·  **MEDIUM**  ·  _performance_  ·  confidence: medium

**Why it matters.** render() builds the critical-path chainLen over Object.keys(Store.tasks) (every task in every plant) and builds the lineToY map from Store.tasksArr (every plant's lines), then zips that line list against the on-screen .vis-group DOM rows (line 8582 lines.forEach((line,i)=>{ const groupEl = groupEls[i]; ...})). Because the timeline only renders the selected plant's groups, indexing a global all-plant sorted line list against per-plant DOM groups is both wasteful (O(all-system-lines)) and positionally incorrect once more than one plant exists: groupEls[i] will not correspond to lines[i]. At 3,500+ lines this also makes Math.max(0, ...allIds.map(...)) a large spread call. render() runs on every pan/zoom (rangechange/rangechanged, lines 8503-8504) when deps are enabled.

**Evidence.**

```
const allIds = Object.keys(Store.tasks);
...
const maxLen = Math.max(0, ...allIds.map(id => { try { return getLen(id); } catch { return 0; } }));
...
const lines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();
```

**Suggested fix.** Derive both allIds and lines from the selected-plant scope (Store.tasksForSelectedPlant()/tasksByPlant) so the line array aligns with the rendered .vis-group rows and the chain-length spread is bounded to the visible plant.

**Verification.** Line 8536 builds allIds from Object.keys(Store.tasks) (all plants) for the chain-length spread, and line 8580 builds `lines` from Store.tasksArr (all plants); both are unscoped and the positional zip against plant-scoped .vis-group rows is incorrect, consistent with the separate alignment finding.

---

<a id="r76"></a>
### R76. Selection->Table sync is O(rows x selected) via Array.includes inside forEachNode

`app.js:10282-10286`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** On every selection change this handler walks every AG Grid row node and calls evt.ids.includes(...) — a linear array scan — per row, plus a String() allocation per row, making it O(rows x selectedCount). The marquee calls Selection.set on each overlay update (line 9728), so during a single marquee drag this full O(rows x sel) pass re-runs for every incremental selection change, compounding the marquee cost. At thousands of loaded orders this is a meaningful per-event cost.

**Evidence.**

```
Table._api.forEachNode(node => {
  if (node.data && evt.ids.includes(String(node.data.id))) {
    node.setSelected(true, false);
  }
});
```

**Suggested fix.** Build `const idSet = new Set(evt.ids)` once before forEachNode and use `idSet.has(String(node.data.id))` (O(1) per row). Consider debouncing the Selection->Table sync while a marquee is active since intermediate selections are transient.

**Verification.** Lines 10282-10286: forEachNode walks every grid row and calls evt.ids.includes(String(node.data.id)) (linear scan + String allocation per row) on every selection change, and the marquee calls Selection.set per overlay update (9728), so this O(rows x sel) pass re-runs on each incremental marquee selection.

---

<a id="r77"></a>
### R77. Backend load path fetches the unfiltered full production_lines list (scale anti-pattern at 3,500 lines)

`app.js:10357, 10399, 10514`  ·  **MEDIUM**  ·  _performance_  ·  confidence: medium

**Why it matters.** On every load (no-plant, zero-rows, and happy paths) the client fetches the complete production_lines table with no plant filter or pagination, then assigns the full row set into Store._state.masterData.lines and rebuilds the plant index over all of them. CLAUDE.md's Production Scale Roadmap explicitly states 'API endpoints that return plant or line lists must support pagination or filtering at the server level — full list queries become untenable' at the 3,500-total-line target. A plant is already selected on the happy path (the variable `plant` is in scope at line 10514), so the line list could be scoped to that plant but is fetched globally. This pulls every line for every plant across the network and into memory on each load.

**Evidence.**

```
fetch(`${Config.API_BASE}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
```

**Suggested fix.** On the happy/zero-rows paths where `plant` is known, request `/master-data/production_lines?plant=${plant}` (server-side scope). For the no-plant picker bootstrap, fetch only plants (the picker needs plants, not all lines) or paginate the line list. Pair this with the helper-extraction above so it is a single change.

**Verification.** All three sites (10357, 10399, 10514) fetch /master-data/production_lines with no ?plant= filter or pagination then store all rows, which CLAUDE.md's Production Scale Roadmap explicitly flags as untenable at the 3,500-line target; severity is appropriately scale-forward.

---

<a id="r78"></a>
### R78. saveAll dirty-task selection scans the full task map instead of looking up dirty ids directly

`app.js:10880-10882`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** Store.tasksArr is a getter that does Object.values(this._state.tasks) — it allocates a brand-new array over ALL loaded tasks on every access (line 578). saveAll then filters that full array to recover the dirty subset. This is O(total tasks) plus a full-array allocation to find what is typically a handful of dirty ids. _dirtyIds is already a Set of the exact ids that changed, and Store.tasks (the id-keyed object) supports direct O(1) lookup. At the plant scale where a loaded plant can hold thousands of orders, materializing and scanning the whole array to find e.g. 1-3 dirty tasks is wasted work on the save path.

**Evidence.**

```
const dirtyTasks = Persistence._dirtyIds.size > 0
        ? Store.tasksArr.filter(t => Persistence._dirtyIds.has(String(t.id)))
        : [];
```

**Suggested fix.** Iterate _dirtyIds directly and look up each in Store.tasks: const dirtyTasks = [...Persistence._dirtyIds].map(id => Store.tasks[id]).filter(Boolean); This is O(dirty) instead of O(total) and avoids the full Object.values allocation.

**Verification.** Line 10880-10882 calls Store.tasksArr.filter — and tasksArr is a getter doing Object.values(_state.tasks) (line 578) allocating an array over all tasks — when _dirtyIds is a Set and Store.tasks (573) supports O(1) id lookup, so it is O(total) where O(dirty) suffices.

---

<a id="r79"></a>
### R79. saveAll serializes the entire blocks + calendars map on every backend save, even when only one task changed

`app.js:10893`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** saveAll always POSTs the full Store.blocks array and the full Store.calendars map regardless of how many tasks are dirty. Store.calendars is keyed per production line (Store.ensureCalendar is called for every line on load). At the 3,500-line scale target, calendars becomes a large object that gets JSON.stringify'd synchronously on the main thread on EVERY explicit save (Cmd/Ctrl+S), even when the user dragged a single order. This is O(total lines) serialization on a UI-blocking path. CLAUDE.md explicitly notes 'saveAll always POSTs full blocks/calendars even with an empty dirty-task set', confirming this is the intended-but-unscalable shape. The dirtyTasks payload is correctly minimized but the blocks/calendars envelope is not.

**Evidence.**

```
const body = JSON.stringify({ tasks: taskPayload, blocks: Store.blocks, calendars: Store.calendars });
```

**Suggested fix.** Scope blocks/calendars to the currently loaded plant before serializing (Persistence._currentLoadedPlant is available), or send blocks/calendars only when they are themselves dirty (track a separate dirty flag for calendar/block mutations) rather than on every task save. At minimum, prune Store.calendars to on-screen/loaded lines the way the worker snapshot path already prunes calendars/lineSettings.

**Verification.** Line 10893 stringifies Store.blocks and the full Store.calendars on every saveAll regardless of dirty count; calendars is per-line so this is O(total lines) main-thread serialization, matching CLAUDE.md's noted shape — though the high severity is forward-looking (only material at the 3,500-line target).

---

<a id="r80"></a>
### R80. AdminCockpit.render() double-fires _renderOverview() — every admin tab open issues all 9 panel renders/fetches twice

`app.js:11175-11185, 11297-11300`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** render() (invoked on every switch to the admin tab, app.js:13883) calls _setSub('overview'), and for sub==='overview' _setSub already calls _renderOverview(). render() then calls _renderOverview() a second time. _renderOverview() fans out to nine renders, three of which are network fetches: _renderHealth (GET /health), _renderPipeline (GET /diagnostics/deep), _renderDbDeep (GET /diagnostics/db), plus _renderBackendLog, _renderAudit, _renderAuditLog. So every admin tab open issues these DB-observability endpoints (which run pg_stat_statements, lock-chain, bloat, and pool queries) twice in immediate succession. The per-render AbortControllers (_pipelineAbort, _dbDeepAbort, etc.) cancel the first in-flight request when the second starts, so the work is wasted: the backend may still execute the expensive query for the aborted first request, and the duplicate DOM teardown/rebuild runs regardless. At the 50+ plant scale these diagnostics endpoints are non-trivial; firing them 2x per visit is pure waste.

**Evidence.**

```
_setSub(sub) {
  ...
  if (sub === 'manage') MasterData.render();
  else AdminCockpit._renderOverview();
},

render() {
  AdminCockpit._setSub('overview');   // sub==='overview' => calls _renderOverview()
  AdminCockpit._renderOverview();      // ...then calls it AGAIN
},
```

**Suggested fix.** Drop the redundant second call. render() should be just `AdminCockpit._setSub('overview');` since _setSub already routes overview to _renderOverview(). Alternatively make _renderOverview idempotent/guarded within a single tick.

**Verification.** render() (11297-11300) calls `_setSub('overview')` which routes to `_renderOverview()` (11184), then calls `_renderOverview()` again at 11299; `_renderOverview` (11302-11313) fans out to ~9 renders including _renderHealth/_renderPipeline/_renderDbDeep network fetches — confirmed redundant double invocation.

---

<a id="r81"></a>
### R81. _renderLogs() does a full scope-select rebuild + up to 500-row DOM teardown on every ErrorLog push (undebounced) while the admin tab is active

`app.js:11262-11267, 12697-12733`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** ErrorLog._listeners are invoked synchronously inside ErrorLog._push (app.js:5252) — NOT through the 250ms _notify debounce (that debounce belongs to PerfMonitor/Store, a different module). So while the admin tab is open, every single info/warn/error log call triggers a full _renderLogs(): it copies the entire ErrorLog buffer (cap 500, ErrorLog.MAX), rebuilds the scope <select> via Set+sort, re-filters all entries, wipes the list with textContent='', and recreates every visible row plus a click listener. Engine/Alerts/Persistence emit log bursts (e.g. optimizer convergence warnings, reflow, autosave), so a burst of N logs while admin is open causes N full O(500) rebuilds back-to-back — visible jank and layout thrash. The ErrorLog.copy/badge path is debounced (_renderBadge via Util.debounce) but this admin re-render is not.

**Evidence.**

```
ErrorLog.subscribe(() => {
  const panel = document.getElementById('admin-tab');
  if (panel?.classList.contains('active')) {
    AdminCockpit._renderLogs();
  }
});
...
_renderLogs() {
  ...
  const allEntries = ErrorLog.entries();           // .slice() of up to 500
  const scopes = [...new Set(allEntries.map(e => e.scope).filter(Boolean))].sort();  // rebuild <select> every call
  ...
  const filtered = AdminCockpit._getFilteredEntries();   // filters all 500 again
  const visible = filtered.slice().reverse();
  list.textContent = '';                                 // tear down
  for (const e of visible) { /* build a fresh row + listeners */ }
```

**Suggested fix.** Debounce the subscriber, e.g. wrap the callback in Util.debounce(…, 200). Better: append only the new entry to the list and incrementally add a new scope <option> when an unseen scope appears, instead of tearing down and rebuilding all rows + the whole select on every push.

**Verification.** ErrorLog._push synchronously invokes listeners at line 5252 (no debounce), and the subscriber at 11262-11267 calls `_renderLogs()` which rebuilds the scope <select> via Set+sort (12706) and tears down the list with `list.textContent=''` (12724) rebuilding every row — confirmed undebounced full rebuild per log push.

---

<a id="r82"></a>
### R82. FK <select> rebuilt per cell with O(rows × sourceRows) option population — and N+1 fetch when source uncached

`app.js:14497-14538, 14445-14474`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** _fkSelect is invoked once per FK cell per row inside the _appendRow loop. Every call builds a fresh <select> and appends one <option> per source row, so a production_lines table with R rows and S subnetworks/plants does O(R × S) option DOM node creation on every _renderTable (paste/add/delete/save all trigger a full re-render). At the 3,500-line scale target with dozens of plants, a single render of production_lines materializes tens of thousands of <option> nodes. Worse, if the source table is not yet cached, each FK cell fires its own fetch to the same /master-data/{source} endpoint (no in-flight dedupe), producing an N+1 burst of identical requests for one render.

**Evidence.**

```
sourceRows.forEach(r => { const opt = document.createElement('option'); opt.value = r[valCol]; opt.textContent = _optLabel(r); if (r[valCol] === value) opt.selected = true; sel.appendChild(opt); });  // called from _appendRow per FK column per row
// and when uncached:
if (!sourceState) { fetch(`${API}/master-data/${sourceTable}`).then(...) }
```

**Suggested fix.** Build the <option> list once per (sourceTable) as a detached template/DocumentFragment and cloneNode(true) per cell, setting only the selected option afterward. Dedupe the source fetch: kick off a single fetch keyed by sourceTable (store the promise in _cache) before rendering FK columns, await it once, then render all FK cells from the resolved cache rather than firing one fetch per cell.

**Verification.** _fkSelect is called per FK cell per row (14456/14459) and builds a fresh select appending one option per source row (14513-14519); the uncached branch (14523-14535) fires an independent fetch per cell with no in-flight dedupe.

---

<a id="r83"></a>
### R83. _pasteRows is O(P × N) — four linear scans per pasted row plus a fifth in the update pass

`app.js:14624-14674`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** For each of P pasted rows the code performs state.rows.some, state.added.some, toAdd.findIndex, toUpdate.findIndex — each O(N) and each rebuilding _rowKey (a map+join) on every comparison element. Then toUpdate.forEach does another state.rows.findIndex per row. Total is O(P × N) key recomputations. Pasting a few thousand rows into a multi-thousand-row table (the stated scale) makes this quadratic and blocks the main thread.

**Evidence.**

```
rows.forEach(row => {
  if (keys.find(k => !row[k])) { invalid.push(row); return; }
  const key = _rowKey(table, row);
  const inSaved    = state.rows.some(r => _rowKey(table, r) === key);
  const inAdded    = state.added.some(r => _rowKey(table, r) === key);
  const batchAddIdx = toAdd.findIndex(r => _rowKey(table, r) === key);
  const batchUpdIdx = toUpdate.findIndex(r => _rowKey(table, r) === key);
  ...
});
...
toUpdate.forEach(row => { const key = _rowKey(table, row); const idx = state.rows.findIndex(r => _rowKey(table, r) === key); ... });
```

**Suggested fix.** Build a single Map(rowKey → {bucket, ref}) over state.rows and state.added once before the loop, and key toAdd/toUpdate by a Map keyed on rowKey instead of findIndex. That reduces the classification pass to O(P + N) with one _rowKey computation per existing row.

**Verification.** 14624-14635 runs state.rows.some + state.added.some + toAdd.findIndex + toUpdate.findIndex (each O(N), each recomputing _rowKey) per pasted row, and 14664-14666 adds another state.rows.findIndex per update row.

---

<a id="r84"></a>
### R84. Paged GET /tasks issues a second full-table COUNT query per request

`brain.py:660, 733`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** Whenever ?limit or ?offset is supplied, the handler runs db.count_orders() in addition to db.query_orders(). count_orders (db.py:180) opens its own pool connection and runs a separate SELECT COUNT(*) FROM orders with the same WHERE. That is a second DB round-trip and a second connection checkout from the pool on every paged request. Under the unscoped tooling pull path (plant=None, line=None, limit set) this COUNT(*) scans the entire orders table — the exact full-order-book cost the limit guard rail was added to avoid. It also doubles pool pressure for paginating clients.

**Evidence.**

```
meta["total"] = db.count_orders(plant=plant, line=line) if paging else len(data)
... (empty path) ...
"total": (db.count_orders(plant=plant, line=line) if paging else 0),
```

**Suggested fix.** Compute the total in the same query as the page using a window function: add COUNT(*) OVER() AS _total to query_orders when paging, so one round-trip returns both the page and the full filtered count. Falls back cleanly to len(data) when not paging.

**Verification.** db.count_orders is called at 660 and 733 whenever paging, and count_orders (db.py 180-195) opens its own pool connection and runs a separate SELECT COUNT(*) with the same WHERE, a second round-trip per paged request.

---

<a id="r85"></a>
### R85. Full-frame df.astype(object).where(pd.notna(df), None) allocates an entire object-dtype copy of every column just to null-coerce ~20 read columns

`brain.py:671`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** This converts EVERY column of the scoped frame to object dtype and runs an element-wise pd.notna mask + where over the whole DataFrame, producing a second full copy of the frame purely so that NaN becomes None for the JSON build. It runs once per /tasks request after apply_color_merge already produced a copy (line 438 df = df.copy()), so each request allocates at least two full frame copies. astype(object) on a wide frame is expensive and defeats columnar storage; only ~20 named columns are actually read in the loop. At plant scale this is a per-request memory/CPU spike proportional to rows x columns, not rows x read-columns.

**Evidence.**

```
df, cm_stats = apply_color_merge(df, plant=plant)
df = df.astype(object).where(pd.notna(df), other=None)
```

**Suggested fix.** Avoid the whole-frame object conversion. Either coerce only the columns actually emitted, or handle NaN inline in the row loop (e.g. a small helper that returns None for NaN), or use df.where(pd.notna(df), None) without the astype(object) when the columns are already object/datetime. Combined with the itertuples change, the null-coercion can be done per-value during emission, eliminating this copy entirely.

**Verification.** Line 671 runs df.astype(object).where(pd.notna(df), other=None) over the whole frame after apply_color_merge already df.copy()'d (438), producing a second full object-dtype copy per request when only ~20 named columns are read in the loop.

---

<a id="r86"></a>
### R86. GET /tasks builds the response row-by-row via pandas iterrows() + groupby — O(rows) Python-object iteration on the hot path

`brain.py:676-721`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** The per-request /tasks read materializes the JSON payload with df.iterrows(), which is the slowest pandas row-access pattern: each iteration boxes the entire row into a pandas Series, and the body then does ~22 dict/attribute lookups, two-to-four strftime() calls, and several str()/bool() coercions per order. This runs on every /tasks call (no cache — confirmed by the stateless design). At the documented scale of ~70 lines/plant with realistic order volumes per line, a single plant scope can be thousands of rows, and iterrows() is roughly 5-20x slower than vectorized or itertuples access. The groupby is also redundant work: db.query_orders already orders by (production_line, COALESCE(scheduled_start, basic_start_date)) (db.py line 166), so lines already arrive contiguous and sorted — the groupby + per-group sort_values re-sorts data the DB already sorted.

**Evidence.**

```
for prod_line, group_raw in df.groupby("PRODUCTION_LINE"):
    group = group_raw.sort_values("BASIC_START_DATE")
    prev_task_id = None
    for _, row in group.iterrows():
        task_id = row["id"]
        task_text = str(row.get("MATERIAL_DESCRIPTION", "")).strip()
        ...
        data.append({ ... ~22 row.get() / strftime calls per row ... })
```

**Suggested fix.** Replace iterrows() with itertuples(index=False) (or build columns vectorially and zip them). Drop the groupby/sort_values entirely and instead detect line boundaries in the single already-sorted pass (emit a link only when the current row's PRODUCTION_LINE equals the previous row's). This removes a full re-sort and converts the dominant per-row cost from Series boxing to attribute access on lightweight namedtuples.

**Verification.** Lines 676-721 use df.groupby + sort_values + iterrows() with ~22 per-row lookups/strftime calls on the no-cache hot path, and the groupby/sort is redundant since db.py 166 already orders by (production_line, effective start); the high severity is plausible but order-volume-dependent.

---

<a id="r87"></a>
### R87. GET /tasks builds the response with df.groupby + iterrows() Python row-by-row loop (hot path)

`brain.py:676-721`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** GET /tasks is the single most load-bearing endpoint (called on every page load and after every reschedule, no cache). The response is assembled with df.groupby("PRODUCTION_LINE") followed by group.iterrows(), the canonical pandas anti-pattern: iterrows() materializes a Series per row and does per-cell Python attribute access (row.get(...), .strftime(...), pd.notna(...)) for ~20 fields. At the stated scale of 70+ lines per plant and thousands of orders per plant, this is pure Python interpreter overhead linear in row count, executed synchronously in the request handler. The preceding apply_color_merge already sorts by (BASIC_START_DATE, PRODUCTION_LINE, ORDER_Y), so the per-group sort_values("BASIC_START_DATE") on line 677 is also redundant re-sorting of already-ordered data, and db.query_orders already returns rows ORDER BY production_line, effective-start.

**Evidence.**

```
for prod_line, group_raw in df.groupby("PRODUCTION_LINE"):
        group = group_raw.sort_values("BASIC_START_DATE")
        prev_task_id = None

        for _, row in group.iterrows():
            task_id = row["id"]
            ...
            data.append({
                "id": task_id,
                ...
                "start_date": row["BASIC_START_DATE"].strftime("%Y-%m-%dT%H:%M:%S"),
                ...
            })
```

**Suggested fix.** Drop the redundant per-group sort_values (the frame is already globally sorted by start within line). Replace iterrows() with vectorized construction: pre-format the datetime columns once with df["BASIC_START_DATE"].dt.strftime(...) (vectorized), then build the records via df.to_dict(orient="records") and compute the finish-to-start links from the contiguous per-line ordering rather than re-iterating. iterrows() is typically 10-100x slower than vectorized/to_dict construction for this shape.

**Verification.** Lines 676-680 do df.groupby('PRODUCTION_LINE') then group.sort_values then group.iterrows() with per-cell access for ~20 fields; apply_color_merge already sorted by BASIC_START_DATE/PRODUCTION_LINE/ORDER_Y (479-481) and query_orders orders by production_line+effective-start (db.py 166), so the per-group re-sort is redundant.

---

<a id="r88"></a>
### R88. GET /audit/log reads and JSON-parses the entire unbounded audit file to return only the last N entries

`brain.py:1100-1113`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** The audit log is an append-only JSON-Lines file (_cw_append_audit, line 339) that grows without bound — every color-wheel upload/delete and every frontend /audit/log POST (e.g. optimization_run events) appends a line forever, with no rotation or truncation except the manual /audit/log/clear. This handler reads the whole file and json.loads() every single line on each request, then discards all but the last `limit` (default 200). Cost is O(total-history) per call regardless of limit. The same unbounded-tail-read pattern degrades linearly as the deployment ages; after months of optimizer runs this file can be very large and the parse happens on the event loop (sync handler in threadpool, but still O(file) work per request).

**Evidence.**

```
def get_audit_log(limit: int = 200):
    log = []
    try:
        with open(_cw_audit_path(), encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                with suppress(json.JSONDecodeError):
                    log.append(json.loads(line))
    except FileNotFoundError:
        pass
    return {"entries": list(reversed(log[-limit:]))}
```

**Suggested fix.** Read only the tail: either keep a bounded buffer, or seek to the end and read backward (e.g. collections.deque(f, maxlen=limit) which still streams but avoids holding the whole list, or a reverse-chunk reader to read just the last N lines). Better: rotate/cap the audit file, or move audit to a DB table with ORDER BY ts DESC LIMIT N. At minimum use deque(f, maxlen=limit) to bound memory.

**Verification.** Lines 1104-1113 open the JSON-Lines file and json.loads every line into `log`, then return only reversed(log[-limit:]); the file is append-only (_cw_append_audit at 339-341) with no rotation, so cost is O(total history) per call.

---

<a id="r89"></a>
### R89. ingest_orders_from_excel does row-by-row Python iteration (df.apply axis=1 + df.iterrows) on the upload path

`db.py:991-1035`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** Two full passes over every uploaded row in pure Python: (1) df.apply(..., axis=1) materializes a Series object per row just to compute the MD5 id, and (2) df.iterrows() materializes another per-row Series to build the insert tuples (iterrows is the slowest pandas iteration idiom — it boxes each row into a new Series and loses dtype). For the prototype's small files this is invisible, but a SAP export for a 50+ plant / 3,500-line deployment can be tens-to-hundreds of thousands of rows, where apply+iterrows is typically 10-50x slower than vectorized/zipped column access and runs synchronously inside the upload request. The DB upsert is already chunked at 500 rows; the Python marshalling is now the dominant cost of a large upload.

**Evidence.**

```
df["id"] = df.apply(
    lambda r: make_id(r.get("PRODUCTION_ORDER", ""),
                      r.get("MATERIAL_NUMBER", "")),
    axis=1,
)
...
rows = []
for _, r in df.iterrows():
    rows.append((
        r["id"],
        _str_id(r.get("PRODUCTION_ORDER", "")),
        _str_id(r.get("MATERIAL_NUMBER", "")),
        ...
```

**Suggested fix.** Replace iterrows with column-wise extraction: pull each needed column once as a list/ndarray (e.g. po = df['PRODUCTION_ORDER'].map(_str_id).tolist(), etc.) and zip() them to build tuples, or use itertuples(index=False) at minimum. Compute ids vectorized: build the normalized 'PO|MAT' key as a Series, then map MD5 over that single Series instead of df.apply over full rows.

**Verification.** Lines 991-994 use df.apply(..., axis=1) to compute ids and lines 1019-1035 use df.iterrows() to build insert tuples — two full pure-Python row passes on the synchronous upload path, exactly as described.

---

<a id="r90"></a>
### R90. list_rows performs an unbounded full-table read when no limit/offset is supplied

`master_data.py:119-147`  ·  **MEDIUM**  ·  _performance_  ·  confidence: medium

**Why it matters.** When the caller omits limit/offset (the default and, per brain.py:1154, the default route behavior), list_rows selects and materializes the entire table with no upper bound. For production_lines the scale target is 3,500+ rows across 50+ plants; an unfiltered GET /master-data/production_lines would pull every row, build a dict per row (line 135), and for plants additionally run the constraints fetch. CLAUDE.md explicitly names unfiltered full-list queries as a scale anti-pattern. The function supports pagination, but nothing forces it, so the default path is the expensive one.

**Evidence.**

```
select_idents = sql.SQL(", ").join(sql.Identifier(c) for c in col_names)
query = sql.SQL("SELECT {cols} FROM {tbl}").format(...) + where_sql + sql.SQL(" ORDER BY {order}")...
...
if limit is not None:
    query += sql.SQL(" LIMIT %s")
...
if limit is not None or offset:
    cur.execute(... COUNT ...)
    total = int(cur.fetchone()[0])
else:
    total = len(rows)
```

**Suggested fix.** Apply a sane default cap (e.g. default limit when none provided) or require a plant filter for the large tables (production_lines, materials, material_plants), returning meta.total so the client paginates. Ensure the ORDER BY key columns are indexed so the LIMIT path can avoid a full sort.

**Verification.** brain.py md_list (lines 1140-1154) defaults limit/offset to None and list_rows (lines 119-147) only appends LIMIT/OFFSET when supplied, so the default route materializes the entire table — directly contradicting CLAUDE.md's full-list scale anti-pattern; whether to force a cap is a product decision but the unbounded read is real.

---

<a id="r91"></a>
### R91. cascade_preview plants branch issues one COUNT query per deleted plant (N+1)

`master_data.py:194-204`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** The plants branch runs one round-trip COUNT query per deleted plant inside a Python loop, an N+1 pattern. The subnetworks branch directly above (lines 182-192) correctly uses a single `WHERE subnetwork = ANY(%s)` aggregate query, so the loop here is a regression from the established pattern in the same function. At the scale target (50+ plants) a bulk cascade-delete preview of many plants fires that many serial DB round-trips. Each round-trip is dominated by network/latency, not the count itself, so this is O(plants) latency where O(1) is achievable.

**Evidence.**

```
elif table == "plants":
    # Each delete dict should have {subnetwork, plant}
    plines = 0
    for d in deletes:
        if d.get("subnetwork") and d.get("plant"):
            cur.execute(
                "SELECT COUNT(*) FROM production_lines WHERE subnetwork = %s AND plant = %s",
                (d["subnetwork"], d["plant"]),
            )
            plines += int(cur.fetchone()[0])
```

**Suggested fix.** Mirror the subnetworks branch: collect the (subnetwork, plant) pairs and issue a single grouped query, e.g. `SELECT COUNT(*) FROM production_lines WHERE (subnetwork, plant) IN (SELECT unnest(%s::text[]), unnest(%s::text[]))` passing two parallel arrays, then sum the single result. This collapses N round-trips to one.

**Verification.** Lines 196-204 loop over deletes issuing one COUNT round-trip per plant, while the subnetworks branch directly above (lines 185-192) uses a single ANY(%s) aggregate, confirming the N+1 regression from the in-function idiom.

---

<a id="r92"></a>
### R92. IntelDB.pruneSnapshots loads every snapshot (including full task payloads) into memory just to delete the oldest by id

`nimbus-intelligence.js:393-406`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** getAll('snapshots') deserializes all up-to-200 snapshots -- each carrying a full per-task array (thousands of objects at scale) -- into JS memory, then sorts the whole set, only to compute which ids to delete. It is called after every snapshot() (line 1201). The 'ts' index already exists (line 341: ss.createIndex('ts','ts')) but is unused here; a keyed cursor on ts could delete the oldest without materializing any task payloads. Also: (window.requestIdleCallback || setTimeout) passes 2000 as requestIdleCallback's 2nd arg, which rIC ignores -- so the 2s delay only applies on the setTimeout fallback; on Chrome it runs at next idle.

**Evidence.**

```
pruneSnapshots(keepN = 200) {
  if (!IntelDB._db) return;
  (window.requestIdleCallback || setTimeout)(() => {
    IntelDB.getAll('snapshots').then(all => {
      if (!all || all.length <= keepN) return;
      const toDelete = all.sort((a, b) => a.ts - b.ts).slice(0, all.length - keepN);
      const tx = IntelDB._db.transaction('snapshots', 'readwrite');
      const os = tx.objectStore('snapshots');
      toDelete.forEach(s => os.delete(s.id));
    });
  }, 2000);
}
```

**Suggested fix.** Use a cursor over the 'ts' index (openCursor(null,'next')) and delete entries until count<=keepN, never loading task payloads. Pass options correctly: requestIdleCallback(fn, { timeout: 2000 }). Cheaply count() first and only prune when count exceeds keepN.

**Verification.** Lines 393-405 call getAll('snapshots') (materializing every snapshot with its full task array), sort, then delete by id, despite the 'ts' index existing (341); the (window.requestIdleCallback||setTimeout) call also passes 2000 as rIC's 2nd arg which rIC ignores, so the delay only applies on the setTimeout fallback.

---

<a id="r93"></a>
### R93. NeedsEngine and Confidence each build a full Utilization matrix with mismatched day-spans, defeating the shared memo

`nimbus-intelligence.js:425-436, 1352-1359`  ·  **MEDIUM**  ·  _performance_  ·  confidence: medium

**Why it matters.** computeMatrix caches on key `start|days|Store._rev` only when srcTasks===null (app.js:4210-4216). NeedsEngine asks for (startOfDay(now), 7); Confidence asks for (startOfDay(now), 14 by default). Different `days` => different cache keys => two independent full matrix builds, each O(lines x days), iterating every task and calling Calendar.dailyCapacityHours/effectiveCapacityHours per line-day. At 70+ lines/plant these are real synchronous main-thread costs that are not worker-offloaded here. Because the cache key carries no plant discriminator (documented hazard in CLAUDE.md), values cached by these callers can also be clobbered by/served to the plant-scoped worker prewarm path.

**Evidence.**

```
// NeedsEngine._readState:
const now = Util.startOfDay(new Date());
const matrix = Utilization.computeMatrix(now, 7);
// Confidence._recompute:
const matrix = Utilization.computeMatrix(horizonStart, Math.ceil(hMinutes / 1440));
```

**Suggested fix.** Have NeedsEngine reuse the same horizon/days as Confidence (or read Confidence's last computed overload map) so a single cached matrix serves both. Align the `days` argument so the memo hits.

**Verification.** NeedsEngine calls computeMatrix(startOfDay(now),7) (427) while Confidence calls computeMatrix(now, ceil(20160/1440)=14) (1353); the memo key is start|days|rev with a single-slot cache (app.js:4213,4290), so the differing days produce two builds that also evict each other.

---

<a id="r94"></a>
### R94. CommandPalette index rebuilds a 2,000-row string-built array on every broad Store event and every selection change

`nimbus-intelligence.js:734-752, 841-917`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** _index is nulled on tasks:bulk / tasks:bulkUpdate / plant:selected and on EVERY selection change. It is lazily rebuilt on next open/search. _buildIndex iterates up to 2,000 tasks building closure objects + two passes over Store.tasksArr (Object.values() each), plus a Set-dedup of lines, plus a second Store.tasksArr.map. At the 3,500-line scale target a plant can hold thousands of orders; selection-driven invalidation (which fires on every marquee drag / grid click) discards the whole index even though only the selection-command subset (_buildSelectionCommands) actually changed. The order/line portion is unaffected by selection yet is thrown away and rebuilt.

**Evidence.**

```
Store.subscribe(evt => {
  if (!evt?.type || evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate' || evt.type === 'plant:selected')
    CommandPalette._index = null;
...
NIMBUS.Selection?.on?.(() => { CommandPalette._index = null; NeedsEngine._cachedState = null; });
// then in _buildIndex:
for (const t of Store.tasksArr.slice(0, 2000)) { ... idx.push({...}) }
const lines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE).filter(Boolean))];
```

**Suggested fix.** Split the index into a stable order/line/action segment (invalidated only on data events) and a small selection segment rebuilt independently. On Selection.on(), rebuild only _buildSelectionCommands() and splice it in, instead of nulling the entire 2,000-row index. Cap and paginate orders rather than slicing the first 2,000 silently.

**Verification.** _index is nulled on tasks:bulk/tasks:bulkUpdate/plant:selected (735-736) and on every Selection change (749-752), and _buildIndex (841-883) iterates up to 2000 tasks plus two more full Store.tasksArr passes for lines, so selection-only changes discard and rebuild the entire data index even though only _buildSelectionCommands changed.

---

<a id="r95"></a>
### R95. TimeMachine.snapshot deep-serializes the entire task list on every UndoStack.push and every bulk Store event (undebounced)

`nimbus-intelligence.js:1163-1204`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** Every UndoStack.push (which CLAUDE.md says wraps ANY destructive mutation -- drags, fix/unfix, optimize, bulk push) AND every tasks:bulk/tasks:bulkUpdate event allocates a fresh array of per-task plain objects over the entire plant's task set, then structured-clones it into IndexedDB. At the scale target (thousands of orders/plant) every drag triggers a multi-thousand-object map + IDB write. UndoStack already keeps its own 10-level snapshots, so this doubles per-mutation serialization and floods IDB. app.js auto-save is debounced 1,200ms specifically to avoid this kind of per-mutation cost; these snapshots are undebounced.

**Evidence.**

```
const origPush = UndoStack.push.bind(UndoStack);
UndoStack.push = (label, undoFn) => { origPush(label, undoFn); TimeMachine.snapshot(label, { auto: true }); };
Store.subscribe(evt => { if (['tasks:bulk','tasks:bulkUpdate'].includes(evt.type) && evt.source !== 'undo' && evt.source !== 'time-machine') TimeMachine.snapshot(...,{auto:true}); });
// snapshot():
tasks: Store.tasksArr.map(t => ({ id, start_date, end_date, PRODUCTION_LINE, PRODUCTION_ORDER, text, COLOR, FORM_SIZE, FIXED }))
```

**Suggested fix.** Debounce auto-snapshots (coalesce rapid pushes into one snapshot after idle) and/or store deltas vs the previous snapshot instead of a full task array each time. Skip auto-snapshot for high-frequency drag events; snapshot only on coarse boundaries.

**Verification.** snapshot() maps the full Store.tasksArr into plain objects (1186-1196) and is invoked synchronously/undebounced from the UndoStack.push patch (1167) and the bulk-event subscription (1172), then structured-cloned into IndexedDB via put — undebounced unlike app.js's 1200ms autosave, so every drag serializes the whole plant.

---

<a id="r96"></a>
### R96. TimeMachine takes a full deep snapshot on EVERY UndoStack.push and again on every bulk Store event — duplicate, unbounded-cost snapshots

`nimbus-intelligence.js:1163-1174`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** Two independent snapshot triggers are wired. A bulk operation that both pushes an UndoStack entry AND publishes a `tasks:bulkUpdate` event (the normal pattern: many app.js paths call UndoStack.push then Store.updateMany which publishes bulk) produces TWO snapshots for one user action. Each snapshot iterates all of Store.tasksArr building a per-task object (snapshot(), lines 1186-1196) and writes to IndexedDB. At the 3,500-line scale target, a single optimizer run or marquee drag triggers multiple full-table O(n) clones plus IDB writes back-to-back, on the main thread before the IDB put. This is also semantically redundant history noise (two near-identical entries per action). The snapshot() is not debounced or de-duplicated against the just-pushed UndoStack snapshot.

**Evidence.**

```
init() {
  const origPush = UndoStack.push.bind(UndoStack);
  UndoStack.push = (label, undoFn) => {
    origPush(label, undoFn);
    TimeMachine.snapshot(label, { auto: true });
  };
  Store.subscribe(evt => {
    if (['tasks:bulk','tasks:bulkUpdate'].includes(evt.type) &&
        evt.source !== 'undo' && evt.source !== 'time-machine') {
      TimeMachine.snapshot(evt.type === 'tasks:bulk' ? 'Data loaded' : 'Bulk update', { auto: true });
    }
  });
```

**Suggested fix.** De-duplicate: drop the Store.subscribe bulk trigger (UndoStack.push already covers user-initiated bulk ops) or guard it so it only fires when no UndoStack.push happened in the same tick. Alternatively debounce TimeMachine.snapshot (e.g. coalesce snapshots within ~250ms by ts) and skip if the previous snapshot's task set is identical.

**Verification.** Lines 1164-1174 wire both an UndoStack.push monkey-patch and a Store.subscribe handler firing on tasks:bulk/tasks:bulkUpdate, so a bulk op that pushes undo AND publishes a bulk event produces two full Store.tasksArr.map() snapshots; this overlaps with the separate high-severity finding.

---

<a id="r97"></a>
### R97. Confidence._recompute rebuilds a full all-lines Utilization matrix on a 400ms debounce after every alert recompute

`nimbus-intelligence.js:1307-1309`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** Every Alerts.recompute call now also schedules Confidence._recompute (400ms debounce). _recompute calls `Utilization.computeMatrix(horizonStart, Math.ceil(hMinutes/1440))` (line 1353) — by default a 14-day matrix over ALL lines in the selected plant, then iterates every line×day cell. At 70+ lines/plant this is a heavy synchronous main-thread build on the standard alert-recompute cadence (alerts fire on every drag/edit). It is not worker-offloaded here and not scoped to changed lines. Confidence.showBreakdown() (line 1420) builds the same full matrix a second time when the badge is clicked. Note the wrapper correctly spreads `...args`, so the CLAUDE.md claim that Confidence patches recompute to arity-0 (dropping the {lines} incremental scope) is NOT true of the current code — the doc is stale on that point.

**Evidence.**

```
const origRecompute = Alerts.recompute.bind(Alerts);
Alerts.recompute = (...args) => { const r = origRecompute(...args); Confidence._recomputeDebounced(); return r; };
```

**Suggested fix.** Reuse the already-computed/memoized matrix instead of forcing a fresh full build inside _recompute; or compute the confidence util-penalty from Store.alerts/Utilization data the worker already produced. Increase the debounce or skip recompute when the alert set is unchanged.

**Verification.** Line 1308 wraps Alerts.recompute to call _recomputeDebounced (400ms) and _recompute calls Utilization.computeMatrix over the full horizon (line 1353) iterating every line/day cell on the main thread, and the wrapper correctly spreads ...args as the finding notes.

---

<a id="r98"></a>
### R98. showBreakdown rebuilds the full 14-day utilization matrix on every badge click

`nimbus-intelligence.js:1405-1429`  ·  **MEDIUM**  ·  _performance_  ·  confidence: high

**Why it matters.** showBreakdown recomputes the same 14-day O(lines x days) utilization matrix that _recompute already computed to produce the current score, duplicating the heavy build solely to render the breakdown dialog. The penalty figures (alertPts/utilPts) are also recomputed verbatim from the same logic in _recompute (lines 1342-1359 vs 1416-1429), so the scoring math is duplicated in two places and can silently diverge. This is user-triggered (less hot than _recompute) but still an avoidable full-matrix build, and the duplicated penalty logic is a maintenance hazard.

**Evidence.**

```
showBreakdown() {
  const alerts = Store.alerts || [];
  const hMinutes = (Store.userSettings?.confidenceHorizonMinutes ?? 20160);
  const hDays    = Math.ceil(hMinutes / 1440);
  ...
  const matrix = Utilization.computeMatrix(horizonStart, hDays);
  const overloadedLines = {};
  Object.entries(matrix).forEach(([line, lineData]) => {
    let days = 0;
    Object.values(lineData).forEach(row => { if (row.effectiveCapacity > 0 && row.scheduled > row.effectiveCapacity) days++; });
    if (days > 0) overloadedLines[line] = days;
  });
```

**Suggested fix.** Have _recompute cache the last-computed { alertPts, utilPts, overloadedLines, errCt, warnCt } alongside _score and reuse it in showBreakdown instead of recomputing the matrix and re-deriving penalties. This removes the duplicate build and collapses the two copies of the scoring formula into one.

**Verification.** showBreakdown (line 1420) calls Utilization.computeMatrix again and re-derives alertPts/utilPts (lines 1416-1429) duplicating the _recompute scoring logic (lines 1342-1359), so both the heavy build and the penalty formula are duplicated and can diverge.

---

<a id="r99"></a>
### R99. Dark mode incomplete: .welcome-splash, .cw-active-card, .lp-hm-grad hardcode light colors with no body.dark override

`styles.css:1442, 3043, 4846`  ·  **MEDIUM**  ·  _maintainability_  ·  confidence: high

**Why it matters.** Verified there is NO `body.dark .welcome-splash`, `body.dark .cw-active-card`, or `body.dark .lp-hm-grad` rule anywhere (grep returned no matches). The welcome splash backdrop is hardcoded to a warm off-white rgba(245,244,239,0.82) — in dark mode this produces a bright near-white overlay over a dark app. .cw-active-card's gradient ends in hardcoded #fdf8ee (light cream), washing out against dark panels. .lp-hm-grad's legend gradient starts at light #ede8de. These match the CLAUDE.md warning that the body.dark layer is incomplete.

**Evidence.**

```
.welcome-splash { ... background: rgba(245, 244, 239, 0.82); ... }
.cw-active-card { ... background: linear-gradient(135deg, var(--accent-wash) 0%, #fdf8ee 100%); ... }
.lp-hm-grad  { ... background: linear-gradient(to right, #ede8de, #c8a95a, #c96a1a, #991b1b); }
```

**Suggested fix.** Add body.dark overrides: `body.dark .welcome-splash { background: rgba(19,20,26,0.82); }`; replace the hardcoded #fdf8ee in .cw-active-card with a token (e.g. drop to single var(--accent-wash) or add a body.dark gradient); add `body.dark .lp-hm-grad` with the dark gradient already used for the sibling .hm-grad at line 255-257.

**Verification.** Verified .welcome-splash (1442 rgba(245,244,239,0.82)), .cw-active-card (3043 gradient ending #fdf8ee), and .lp-hm-grad (4846 gradient starting #ede8de) hardcode light values and grep found no body.dark override for any of the three.

---


# 🟡 Low severity

<a id="r100"></a>
### R100. Modal.confirm renders opts.detail via innerHTML (latent XSS sink)

`app.js:5408-5410`  ·  **LOW**  ·  _security_  ·  confidence: medium

**Why it matters.** opts.detail is assigned to innerHTML rather than textContent. Today's callers pass either static markup or server-derived integer counts (e.g. cascade-preview plant/line counts at lines 14705-14708, which are numbers), so there is no active exploit. However it is a standing injection sink: any future caller that interpolates an order text, material number, line code, reason string, or other ingest/user-controlled value into `detail` would get unescaped HTML execution in a confirmation dialog. Given task/line/material fields originate from uploaded Excel, this is a realistic future foot-gun.

**Evidence.**

```
const det = document.getElementById('confirm-detail');
if (opts.detail) { det.innerHTML = opts.detail; det.hidden = false; }
else             { det.textContent = ''; det.hidden = true; }
```

**Suggested fix.** Either keep innerHTML but document that detail MUST be pre-escaped trusted markup, or split into two options: a `detailText` (set via textContent) for dynamic content and a separate `detailHtml` reserved for static trusted markup. Audit existing callers to ensure none interpolate ingest-derived strings.

**Verification.** Line 5409 assigns opts.detail to det.innerHTML; it is a real latent sink as the finding itself acknowledges (no active exploit), correctly rated low.

---

<a id="r101"></a>
### R101. effectiveCapacityHours can return negative capacity when bufferPct loaded from master data exceeds 100

`app.js:1071`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** The pct branch has no lower clamp. The ProdLines input clamps bufferPct to 0..100 (line 2108: `Math.max(0, Math.min(100, ...))`), but the master-data load path at line 15149 sets `ls.bufferPct = parseFloat(row.buffer_percent) || 0` with NO upper bound. If the master-data `buffer_percent` column holds a value > 100 (data entry / import error), effectiveCapacityHours returns a NEGATIVE number, unlike the 'hours' branch (line 1072) which is protected by Math.max(0, ...). Negative effective capacity then propagates into Utilization pct (division and ratios) and optimizer placement decisions. Low severity because it requires bad master data, but the asymmetry with the hours branch (which IS clamped) shows the guard was simply omitted.

**Evidence.**

```
if (ls.bufferUnit === 'pct' && ls.bufferPct > 0) return full * (1 - ls.bufferPct / 100);
```

**Suggested fix.** Clamp the result: `if (ls.bufferUnit === 'pct' && ls.bufferPct > 0) return full * Math.max(0, 1 - ls.bufferPct / 100);`, and/or clamp bufferPct to [0,100] in the master-data load at line 15149.

**Verification.** app.js 1071 returns full*(1-bufferPct/100) with no lower clamp (unlike the hours branch at 1072 which uses Math.max(0,...)), and the master-data load at 15149 sets bufferPct via parseFloat with no upper bound while only the ProdLines UI input clamps to 0..100 (2108); requires bad master data so low severity is apt.

---

<a id="r102"></a>
### R102. _lineData cache is never pruned when the horizon scrolls — stale out-of-window days accumulate and KPIs/exceptions read them

`app.js:2289-2308, 2358-2367, 2862-2873`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** _fetchLines only ever ADDS day keys into _lineData[plant][line] and never clears entries outside the current horizon window. Across multiple horizon scrolls the cache grows unbounded for the session, and—more importantly—it is consulted by _renderKPIs (line 2363) and _renderExceptions (line 2866) which iterate the utilization matrix day keys and prefer _lineData over calendar capacity. If a line·day was overridden in a previously-viewed horizon and the override was later changed at the DB by another writer, the cached value silently shadows the fresh value. The _fetchAggregate path returns early when _aggrData[plant] exists (line 2271), so aggregate data is also never refreshed within a session.

**Evidence.**

```
async function _fetchLines(plant, group) {
  ... if (!_lineData[plant]) _lineData[plant] = {};
  (json.rows || []).forEach(r => {
    if (!_lineData[plant][r.production_line]) _lineData[plant][r.production_line] = {};
    _lineData[plant][r.production_line][r.day] = { avail_hours: r.avail_hours, source: r.source };
  });
```

**Suggested fix.** Clear _lineData[plant] (or the day keys outside [from_date,to_date]) at the start of each _fetchLines for that plant before merging, and/or add a TTL/invalidate-on-mutation. For _fetchAggregate, allow a force-refresh path rather than permanently memoizing per plant.

**Verification.** _fetchLines (2300-2304) only ever adds r.day keys into _lineData[plant][line] and never clears out-of-window days, and _fetchAggregate (2271) returns early whenever _aggrData[plant] exists so it never refreshes within a session; _renderKPIs (2363) and _renderExceptions (2866) prefer the cached _lineData over calendar capacity.

---

<a id="r103"></a>
### R103. Even-split disaggregation rounds each slot to 0.1h independently, so per-line totals drift from the aggregate group/week hours

`app.js:2328-2330`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** perSlot is rounded to one decimal and applied identically to every open slot. The sum of the rounded per-slot values does not equal groupHours except when groupHours is exactly divisible. Example: groupHours=100 over 7 open slots → perSlot=14.2857 → rounded 14.3 ×7 = 100.1 (over) ; 100 over 3 slots → 33.333→33.3×3 = 99.9 (under). The Headroom and Shortfalls KPIs (lines 2354-2366) and the Capacity/Exceptions heatmaps then compute surplus/deficit against these drifted line values, so 'Available' aggregate total and the disaggregated line totals disagree by up to ~slots×0.05h, and shortfall counts can flip near the boundary.

**Evidence.**

```
const perSlot = Math.max(0, (groupHours || 0)) / openSlots.length;
const rounded = Math.round(perSlot * 10) / 10;
return openSlots.map(s => ({ production_line: s.line, day: s.dayKey, avail_hours: rounded, source: 'auto_split' }));
```

**Suggested fix.** Use a largest-remainder (Hamilton) apportionment: floor each slot to 0.1, distribute the leftover 0.1h increments to the slots with the largest fractional remainder until the rounded total equals groupHours. Or store full-precision and only round for display.

**Verification.** Lines 2328-2330 compute perSlot = groupHours/openSlots.length, round to 0.1, and apply the identical rounded value to every slot, so the summed per-slot total only equals groupHours when evenly divisible (largest-remainder apportionment is not used).

---

<a id="r104"></a>
### R104. _renderLinePlan builds span*7 day columns but the matrix only covers min(span*7,84) days, so columns past day 84 silently show scheduled=0

`app.js:2662-2672, 2715-2721`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** days is built for the full _horizonSpan*7 columns (16 weeks = 112 days) but utilMatrix is capped at 84 days. For any span > 12 weeks, the last (span*7 - 84) day columns render with req=0 because utilMatrix has no row for those dayKeys, so the heat map and required/ratio for those days are silently wrong (always idle). This worsens at the larger horizons the tool offers (16-week option in _renderInputs).

**Evidence.**

```
const days = []; _weeks.forEach(w => { for (let d=0; d<7; d++){ ... days.push({date,dayKey,weekKey}); } }); // span*7 columns
const utilMatrix = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
... const req = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
```

**Suggested fix.** Cap the days column build to the same min(span*7, 84) used for the matrix, or raise the matrix day cap to cover the full rendered horizon. Drive both from one shared constant.

**Verification.** days is built for the full _weeks (span*7, up to 112 at the 16-week option) at 2663-2669, but utilMatrix is capped at min(span*7,84) (2672), so for span>12 the day columns beyond day 84 read req = utilMatrix[line]?.[d.dayKey]?.scheduled || 0 (2720) which is 0 because the matrix has no rows for those days.

---

<a id="r105"></a>
### R105. Line-plan cell value 0 is stored but rendered as blank, so a legitimate 0-hour override is indistinguishable from 'no value'

`app.js:2727, 2750-2757, 2785`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** In the change handler a typed 0 yields ah=0 (not null), so it is stored as an explicit override {avail_hours:0, source:'override'}. But the cell render uses `avail > 0 ? avail : ''`, so the stored 0 shows as an empty input. On the next render the empty input looks unset; if the user re-edits the row the blank reads back as null and the deliberate 0-hour (line-closed) override is lost. The reset path at 2785 has the same `|| ''` truthiness bug — avail_hours of 0 renders blank. This conflates 'closed line' (0h) with 'no plan'.

**Evidence.**

```
value="${avail > 0 ? avail : ''}"   // render (2727)
...
const ah = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);  // 2750
...
if (ah === null) delete _lineData[plant][line][day]; else _lineData[plant][line][day] = { avail_hours: ah, source: 'override' };  // 2757
...
inp.value = resetCell.avail_hours || '';  // 2785
```

**Suggested fix.** Render with an explicit null check, e.g. `value="${avail != null ? avail : (calCap || '')}"` for the line cell and `inp.value = resetCell.avail_hours != null ? resetCell.avail_hours : ''` for the reset, mirroring the `ah !== null` discipline already used for storage.

**Verification.** The change handler at 2750/2757 stores ah=0 as {avail_hours:0,source:'override'}, but the render at 2727 uses `value="${avail > 0 ? avail : ''}"` and the reset at 2785 uses `resetCell.avail_hours || ''`, both of which render a stored 0 as blank, conflating a 0h closed-line override with no plan.

---

<a id="r106"></a>
### R106. ColorWheelViewer error branch keys off the substring '404' and leaks raw error text to users on any other failure

`app.js:3332-3349`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** On any failure that is not an HTTP 404 — the 8s AbortSignal.timeout (TimeoutError), a network error (TypeError: Failed to fetch), or a 500 — the meta line renders the raw err.message string directly to the end user, untranslated and unfriendly. The 404 detection via err.message.includes('404') is also brittle (any status or body containing '404' misclassifies). This leaks internal error text into a production plant-management screen and bypasses the i18n layer used everywhere else.

**Evidence.**

```
fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(_plant)}`, { signal: AbortSignal.timeout(8000) })
  .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
...
.catch(err => {
  ...
  if (metaEl) metaEl.textContent = err.message.includes('404') ? t('empty.cw_no_file') : err.message;
});
```

**Suggested fix.** Branch on the actual status, not a substring of the message: capture r.status before rejecting and test status===404. For all other errors show a single generic translated 'failed to load color wheel' string and route the raw message to ErrorLog instead of rendering it.

**Verification.** At 3348 metaEl.textContent = err.message.includes('404') ? t(...) : err.message renders the raw untranslated message (e.g. TimeoutError, 'Failed to fetch', 'HTTP 500') for any non-404 failure, and the substring 404 detection is brittle; severity low is fair for a non-critical admin screen.

---

<a id="r107"></a>
### R107. start_date edit leaves a stale end_date when RUN_TIME duration is 0, producing end < start

`app.js:6509-6515`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium  ·  **⚖️ needs-human-judgment**

**Why it matters.** When a task's RUN_TIME is 0/missing (Util.runHours returns 0), editing the start_date advances start but the `if (dur > 0)` guard skips updating end_date, leaving the previous end_date. If the new start is later than the old end, the row now has end_date < start_date — an inverted range. The backend update path rejects inverted ranges (end <= start) per CLAUDE.md, so the explicit Save (Cmd/Ctrl+S) will fail/stale for that row, and the alerts/utilization engines also assume start<=end. The same pattern exists in Inspector._onFieldChange (6960-6962). For a zero-duration order this produces an internally inconsistent task with no user-visible warning at edit time.

**Evidence.**

```
if (field === 'start_date') {
  const d = Util.parseDate(p.newValue);
  if (!d) { Toast.show(t('toast.invalid_date'), 'error'); Table._api.refreshCells({ rowNodes: [p.node] }); return; }
  changes.start_date = Util.snap(d);
  // recompute end based on RUN_TIME
  const dur = Util.runHours(p.data) * Config.MS_HOUR;
  if (dur > 0) changes.end_date = new Date(changes.start_date.getTime() + dur);
}
```

**Suggested fix.** When dur <= 0, set end_date = start_date (zero-length) instead of leaving the stale value, e.g. `changes.end_date = dur > 0 ? new Date(changes.start_date.getTime()+dur) : new Date(changes.start_date.getTime());` Apply the same fix in Inspector._onFieldChange.

**Verification.** The `if (dur > 0)` guard at 6515 (and mirrored at 6962) genuinely skips updating end_date when runHours is 0, leaving a stale end that can invert the range; whether this manifests depends on whether real orders ever have RUN_TIME of 0/missing, which I cannot determine from source.

---

<a id="r108"></a>
### R108. Dashboard `tasks:bulk` re-render does not cancel the pending debounced render

`app.js:7158-7171`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** The `tasks:bulk` branch returns early WITHOUT `clearTimeout(Dashboard._renderDebounced)`. If a non-bulk event (calendar/blocks/fixed/task:update) scheduled the 300 ms debounced render just before a `tasks:bulk` arrives, both timers stay armed: the 300 ms render fires against partially-applied data, then the 350 ms bulk render fires again. The bulk path also resets `_prevKpi = {}` and `_latenessDrillKey = null`, so the earlier 300 ms render between reset and rebuild can render stale/half-state and replay KPI tick animations spuriously. Harmless visually but a redundant double-render and a latent ordering hazard.

**Evidence.**

```
if (evt.type === 'tasks:bulk') {
  Dashboard._prevKpi = {};
  Dashboard._latenessDrillKey = null;
  setTimeout(() => { Dashboard._buildFilterOptions(); Dashboard.render(); }, 350);
  return;
}
clearTimeout(Dashboard._renderDebounced);
Dashboard._renderDebounced = setTimeout(() => Dashboard.render(), 300);
```

**Suggested fix.** Add `clearTimeout(Dashboard._renderDebounced)` at the top of the `tasks:bulk` branch before scheduling the 350 ms rebuild, so only the bulk render runs.

**Verification.** The `tasks:bulk` branch at 7162-7168 schedules a 350ms render and returns before the `clearTimeout(Dashboard._renderDebounced)` at 7169, so a previously-armed 300ms render can still fire alongside it.

---

<a id="r109"></a>
### R109. Inline onclick handler references undefined variable `a` in dead else-branch

`app.js:7750-7751`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** The onclick string contains the literal token `a&&a.taskId` (NOT inside a `${...}` interpolation), so it is emitted verbatim into the HTML attribute. Inline event handlers execute in global scope, where `a` (the map callback's loop variable) does not exist. If `NIMBUS.Alerts.focus` were ever falsy the handler would throw `ReferenceError: a is not defined`. In practice `Alerts.focus` is always defined (declared at line 3809), so the else-branch is currently unreachable dead code — but it is a latent landmine: if `focus` is ever renamed/removed the alert rows silently break instead of falling back to the timeline. The `${a.taskId||''}` inside the same branch IS interpolated at build time, showing the author intended runtime data but mixed scopes.

**Evidence.**

```
list.innerHTML = alerts.slice(0, 8).map(a => `
  <div class="alert-row sev-${a.sev}" onclick="if(NIMBUS.Alerts.focus){NIMBUS.Alerts.focus('${a.id}');}else if(a&&a.taskId){NIMBUS.App.goto('gantt');setTimeout(()=>NIMBUS.Timeline.focus('${a.taskId||''}'),200);}">
```

**Suggested fix.** Remove the dead else-branch or bake the fallback target into the template at build time. E.g. precompute `const tid = a.taskId || ''` in the map and emit a self-contained handler: `onclick="NIMBUS.Alerts.focus ? NIMBUS.Alerts.focus('${a.id}') : (NIMBUS.App.goto('gantt'), setTimeout(()=>NIMBUS.Timeline.focus('${tid}'),200))"` — no reference to a runtime `a`.

**Verification.** Line 7751 emits `else if(a&&a.taskId){...}` literally outside any ${} interpolation, and `a` is the map callback variable absent in global onclick scope; Alerts.focus is defined at 3809 so the branch is currently unreachable dead code as described.

---

<a id="r110"></a>
### R110. Sandbox discard mutates Store._state.blocks/calendars directly without bumping _rev or publishing

`app.js:9263-9269`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** On discard, blocks/calendars/fixedIds are assigned straight into Store._state, bypassing any Store mutator. Per CLAUDE.md the Store is a reactive pub/sub source of truth and the Utilization Store-backed memo is keyed on Store._rev; direct _state assignment does not bump _rev or call Store.publish(). setTasks(snap.tasks) does publish/bump for the tasks change, but that single publish happens BEFORE blocks/calendars are swapped in (lines 9265-9266 run after setTasks at 9264). Subscribers that already re-rendered off the tasks publish read the still-old blocks/calendars, and the cached Utilization matrix keyed on the unchanged _rev can serve stale capacity until the next unrelated mutation. Blackout/Calendar visuals may not refresh until the next publish.

**Evidence.**

```
const snap = Sandbox._snapshot;
Store.setTasks(snap.tasks, 'sandbox');
Store._state.blocks    = snap.blocks;
Store._state.calendars = snap.calendars;
Store._state.fixedIds  = new Set([...snap.fixedIds]);
for (const id of Store._state.fixedIds) { const t = Store.tasks[id]; if (t) t.fixed = true; }
Alerts.scheduleRecompute();
```

**Suggested fix.** Swap blocks/calendars/fixedIds into _state BEFORE the setTasks call so the single publish reflects the full restored state, or route blocks/calendars through their proper Store setters (or call Store.publish()/bump _rev) after assigning all three, so reactive subscribers and the _rev-keyed Utilization memo see the reverted state atomically.

**Verification.** Lines 9263-9269: blocks/calendars/fixedIds are assigned straight into Store._state AFTER the Store.setTasks publish at 9264, so the only publish/_rev bump happens before blocks/calendars are swapped in, leaving _rev-keyed Utilization memo and subscribers reading stale capacity until the next mutation; whether this causes a visible defect vs. recompute-driven repaint is partly runtime-dependent but the ordering issue is real.

---

<a id="r111"></a>
### R111. Variable shadowing: i18n function `t` shadowed by task object inside _onDataSetUpdate, making Toast call throw if ever reached

`app.js:9918, 9978, 9996`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** At line 9918 the loop binds `const t = Store.tasks[id]` (a task object). At line 9996, inside the same scope, the code calls `t('toast.fixed_count_not_moved', ...)` expecting `t` to be the global i18n resolver — but `t` is the shadowing task object, so this would throw `TypeError: t is not a function`. It is currently unreachable because `skippedFixed` (declared at 9978) is never populated (companion fixed tasks are filtered out earlier at line 9967 via `.filter(... && !Store.isFixed(sid))`), so `skippedFixed.length` is always 0. This is latent: the moment anyone wires up skippedFixed tracking, the warning toast crashes the drag commit.

**Evidence.**

```
const t = Store.tasks[id];   // line 9918 — `t` is now the task object
...
const skippedFixed = [];     // line 9978 — never pushed to
...
if (skippedFixed.length) Toast.show(t('toast.fixed_count_not_moved', { count: skippedFixed.length }), 'warn');  // line 9996
```

**Suggested fix.** Either remove the dead `skippedFixed` array and its toast (companions are already pre-filtered, so no warning is needed), or — if a 'fixed companions skipped' warning is desired — compute the skipped count before filtering and reference the i18n resolver via its unshadowed name (e.g. window.t or Util.t) instead of `t`.

**Verification.** Line 9918 binds `const t = Store.tasks[id]` and line 9996 calls `t('toast.fixed_count_not_moved', ...)`, which would throw TypeError since t is the task object; it is latent because skippedFixed (9978) is never populated (selIds is pre-filtered with !Store.isFixed at 9967), so the branch is unreachable today.

---

<a id="r112"></a>
### R112. Reconnect-triggered reload uses stale _currentLoadedPlant, ignoring a plant the user switched to while offline

`app.js:10561-10573`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** _currentLoadedPlant is only assigned on the success / zero-row paths (10480, 10395). If the user switches plants while the backend is down, loadForPlant -> load -> fetch rejects before reaching those assignments, so _currentLoadedPlant stays pinned to the pre-disconnect plant. When the watcher reloads on recovery it fetches that stale plant rather than Store.selectedPlant (the plant the UI is showing). Also, load() returns a Promise and never throws synchronously, so the surrounding try/catch cannot catch a fetch rejection — a reload failure after reconnect would surface as an unhandled rejection instead of the intended ErrorLog.error.

**Evidence.**

```
try { Persistence.load({ force: true, plant: Persistence._currentLoadedPlant }); } catch (e) {
  ErrorLog.error('persistence', `Reload after reconnect failed: ${e.message}`);
}
```

**Suggested fix.** Reload from the live selection (plant: Store.selectedPlant ?? Persistence._currentLoadedPlant) and attach a .catch to the load() promise rather than relying on a synchronous try/catch.

**Verification.** _currentLoadedPlant is only set on success/zero-row paths (10354/10395/10480) and not in the catch (10529), so a fetch that rejects during an offline plant switch leaves it stale; the reconnect tick (10571) reloads that stale plant, and the surrounding try/catch cannot catch the returned promise's async rejection.

---

<a id="r113"></a>
### R113. Cache load path skips _snapToWorkingHours/range validation, so a cache written mid-edit can render inverted ranges the backend rejects

`app.js:10745-10769`  ·  **LOW**  ·  _bug-error_  ·  confidence: low

**Why it matters.** Unlike the backend path (which runs _snapToWorkingHours and the backend rejects end <= start), the cache path trusts the serialized start_date/end_date with no validation or snap. A cache written mid-edit with an inverted or zero-length range will render, and the subsequent saveAll would have that row rejected per-row by the backend — feeding directly into the partial-save-loses-data finding. The asymmetry between the two load paths is a real integrity gap; severity is low because inverted ranges in cache are uncommon.

**Evidence.**

```
const tasks = data.tasks.map(Persistence._prepTask);
        Persistence._restoreNonTaskState(data);
 ... Store.setTasks(tasks, 'persistence');
 ... Alerts.scheduleRecompute();
        Toast.show(t('toast.loaded_cache', { count: tasks.length }), 'info');
        return true;
```

**Suggested fix.** Apply the same normalization/validation (at minimum an end>start guard that drops or repairs bad rows) on the cache load path before setTasks, mirroring the backend path.

**Verification.** The cache path (10745-10769) maps data.tasks through _prepTask (which only coerces dates, 10589-10597) and calls setTasks with no _snapToWorkingHours or end>start guard, unlike the backend path (10475), so an inverted cached range would render and later be per-row rejected on save.

---

<a id="r114"></a>
### R114. `_dbLineBar`/`_lineBar` and chart helpers divide by `Math.max(...[],1)` but pass through `cnt/max` with no empty guard on per-row width when max could be 0 only mitigated by the `,1` seed — verify NaN width on empty datasets

`app.js:11739-11750`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** `_lineBar` computes `max = Math.max(...Object.values(byLine))` WITHOUT a `,1` fallback seed (unlike `_dbHBarChart`, `_dbSlowQueryBars`, and `_dbStackBar`, which all seed with `,1`). It is only reached when `dbSt.by_line && Object.keys(dbSt.by_line).length` (guarded by the caller at line 11574), so an empty object cannot reach it — but if every line count is 0 (all values 0, non-empty object), `max` is 0 and `cnt/max` yields `NaN`, producing `width: NaN%` (ignored by the browser, bars render at 0 width). This is a latent divide-by-zero that is currently masked by data assumptions rather than code. Low impact but inconsistent with the seeded siblings.

**Evidence.**

```
const max = Math.max(...Object.values(byLine));
...
        fill.style.width = `${Math.round((cnt / max) * 100)}%`;
```

**Suggested fix.** Seed the max like the other helpers: `const max = Math.max(...Object.values(byLine), 1);`

**Verification.** Line 11739 `const max = Math.max(...Object.values(byLine))` lacks the `,1` seed present in siblings at 12446 and 12481; the caller guard (11574) only blocks empty objects, so an all-zero non-empty byLine yields max=0 and NaN width — a real but low-impact latent divide-by-zero.

---

<a id="r115"></a>
### R115. `_runMaintenance` leaves the trigger button disabled/'Running…' on success

`app.js:11995-12014`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** The button is disabled and relabeled to 'Running…' before the request, but it is only re-enabled/restored in the `catch` block. On the success path the original `triggerBtn` is never restored — it relies entirely on `AdminCockpit._renderDbDeep()` rebuilding the panel DOM (which replaces the button). If that re-render is slow, fails its fetch (it catches and renders an error, discarding the cards), or is aborted by a competing `_renderDbDeep` call, the user can be left looking at a permanently-disabled 'Running…' button that is actually orphaned. The asymmetry (restore only on failure) is a latent correctness/UX bug; the only thing masking it is the side-effecting full re-render.

**Evidence.**

```
if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = t('ui.maint_running'); }
...
        AdminCockpit._renderDbDeep();
      } catch (e) {
        ...
        if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = label; }
      }
```

**Suggested fix.** Restore the button in a `finally` block (or before the early `_renderDbDeep`): `finally { if (triggerBtn && triggerBtn.isConnected) { triggerBtn.disabled = false; triggerBtn.textContent = label; } }`. Restoring before the re-render is harmless because the re-render replaces the node anyway.

**Verification.** Lines 11997-12013: button is disabled+relabeled before the request and restored only in the catch block (12012); the success path relies entirely on `AdminCockpit._renderDbDeep()` (12008) rebuilding the DOM, so a failed/aborted re-render leaves an orphaned disabled button — a real low-severity asymmetry.

---

<a id="r116"></a>
### R116. Printer date-range filter only matches orders whose start_date falls in range, silently dropping orders that span into the range

`app.js:13252-13261, 13328-13330`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** The filter tests only start_date against the window. An order that started before rangeStart but is still running (end_date inside the range) is excluded, and the count label asserts these are the 'orders in range'. For a manufacturing export this under-reports in-progress work at the start of the chosen window — the most operationally relevant rows. The end-of-range boundary also uses a fixed 'T23:59:59' string constructed in local time which drops the final minute/second and any sub-second, a minor off-by-edge.

**Evidence.**

```
const rangeStart = new Date(startVal + 'T00:00:00');
const rangeEnd   = new Date(endVal   + 'T23:59:59');
const rows = Store.tasksArr
  .filter(t => t.start_date && t.start_date >= rangeStart && t.start_date <= rangeEnd)
  ...
countEl.textContent = ... `${rows.length} order${rows.length === 1 ? '' : 's'} in range`;
```

**Suggested fix.** Filter on interval overlap: include a row when t.start_date <= rangeEnd && (t.end_date ?? t.start_date) >= rangeStart. Build rangeEnd as the next day's 00:00 (exclusive) rather than 'T23:59:59' to avoid the boundary gap.

**Verification.** Line 13256 filters solely on t.start_date >= rangeStart && <= rangeEnd, so an order that started before the window but runs into it is excluded, and rangeEnd is built as 'T23:59:59' (line 13253) dropping sub-minute precision; the count label at 13330 then asserts these are the orders in range.

---

<a id="r117"></a>
### R117. Alert-horizon input clamps only the lower bound, so a stored horizon > 60 days renders an out-of-range value silently re-clamped on next edit

`app.js:13984, 14018, 14036-14038`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** The DB column alt_flag_horizon is free-form minutes; the input advertises max=60 days. If a stored value exceeds 60 days (or is set elsewhere), line 14018 writes e.g. 90 into the input — exceeding its own max — and the value displays as invalid. readAlertMinutes() never re-applies the 60-day ceiling, so the read path and the declared max disagree. The displayed value silently changes the next time the field's change handler fires from an unrelated edit only if the user touches it, but the inconsistency means the UI cannot round-trip a legitimately-stored larger horizon.

**Evidence.**

```
<input type="number" id="sys-alert-horizon-days" class="form-input" min="1" max="60" step="1" ...>
...
alertDaysInp.value = Math.max(1, Math.round(alertHz / 1440));
...
function readAlertMinutes() {
  const days = Math.max(1, parseInt(alertDaysInp.value, 10) || 1);
  return days * 1440;
}
```

**Suggested fix.** Clamp symmetrically on both display and read: Math.min(60, Math.max(1, Math.round(alertHz/1440))) when setting .value, and apply the same Math.min(60, ...) in readAlertMinutes(). Decide whether 60 is a real cap and, if not, remove the max attribute.

**Verification.** The input at 13984 declares max=60 but line 14018 sets .value = Math.max(1, ...) with no upper clamp and readAlertMinutes() at 14036-14038 applies only Math.max(1, ...), so a stored value over 60 days cannot round-trip through the UI; impact is low and contingent on such a value being stored.

---

<a id="r118"></a>
### R118. FK <select> option matching uses strict === across possible string/number type mismatch

`app.js:14512-14519, 14528-14534`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium  ·  **⚖️ needs-human-judgment**

**Why it matters.** `value` is the FK value read from the current row (rowView[col.column_name]), which for an edited/pasted row is a trimmed STRING (cells store text; paste splits on tab to strings). `r[valCol]` is the source-table value as returned by JSON — for numeric key columns (e.g. a plant code stored as an integer) this is a NUMBER. The strict `r[valCol] === value` comparison then fails (number !== string), so the dropdown renders with NO option pre-selected even though the row already has a valid FK, silently showing the blank placeholder and inviting the user to think the FK is unset. The plant/subnetwork keys in this codebase are often numeric-looking codes, so this is reachable.

**Evidence.**

```
const _optLabel = r => (r[labelCol] && labelCol !== valCol) ? `${r[valCol]} — ${r[labelCol]}` : r[valCol];
sourceRows.forEach(r => {
  const opt = document.createElement('option');
  opt.value = r[valCol];
  opt.textContent = _optLabel(r);
  if (r[valCol] === value) opt.selected = true;
  sel.appendChild(opt);
});
```

**Suggested fix.** Compare with coercion: `if (String(r[valCol]) === String(value ?? '')) opt.selected = true;` in both the initial loop and the post-fetch rebuild loop.

**Verification.** Lines 14517/14532 do use strict r[valCol] === value and cell values are strings, but whether the source JSON returns key columns (plant/subnetwork/code/material_id) as numbers vs strings is a DB-column-type / runtime-data question not determinable from this source.

---

<a id="r119"></a>
### R119. _cw_safe_name maps distinct plant codes to the same file, silently overwriting wheels at scale

`brain.py:300-305, 990-1006`  ·  **LOW**  ·  _bug-error_  ·  confidence: high  ·  **⚖️ needs-human-judgment**

**Why it matters.** The on-disk filename is derived from `_cw_safe_name`, which collapses every non-word character to '_' and uppercases. Two genuinely distinct plant identifiers — e.g. '55-12' vs '55_12', or 'a.b' vs 'a/b' — both resolve to the same file `color_wheel_55_12.xlsx`. The meta JSON, however, is keyed by the RAW plant string (`meta[plant] = ...` at 1002), so uploading the second plant's wheel silently overwrites the first plant's file while meta retains TWO entries pointing at one file. `apply_color_merge` then looks up `PLANT_CWS.get(_cw_safe_name(plant))` (line 446), so both plants receive whichever wheel was uploaded last — wrong optimizer priorities with no error surfaced. At the 50+ plant target this collision risk is real (SAP plant codes / subnetwork-qualified codes can contain separators).

**Evidence.**

```
def _cw_safe_name(plant: str) -> str:
    return re.sub(r'[^\w]', '_', plant.strip().upper())

def _cw_path(plant: str) -> str:
    return os.path.join(COLOR_WHEEL_DIR, f"color_wheel_{_cw_safe_name(plant)}.xlsx")
...
    path = _cw_path(plant)
    is_replace = os.path.isfile(path)
    ...
        meta[plant] = { ... }   # meta keyed by RAW plant code
```

**Suggested fix.** Detect collisions at upload time: before writing, check whether `_cw_path(plant)` already exists for a DIFFERENT raw plant key in meta and reject with 409, or key files by a reversible encoding (e.g. percent-encode rather than collapse to '_'). At minimum key the meta dict by `_cw_safe_name(plant)` so file and meta stay 1:1 and the collision is at least visible.

**Verification.** The collision is real in code (re.sub collapse at 302, meta keyed by raw plant at 1002, cache lookup via _cw_safe_name at 446), but whether two real plant codes ever differ only in separator characters is a data/product question I cannot determine from source.

---

<a id="r120"></a>
### R120. /task/update returns misleading 'Invalid date range' 400 for blank-id payloads

`brain.py:777-780, 815-816`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** _apply_task_date_updates increments the same `invalid` counter for two distinct failure modes: a blank/missing id (line 778-779) and an inverted date range (validated in db.update_task_dates_bulk). The single-task /task/update handler maps any nonzero `invalid` to the fixed message 'Invalid date range (end must be after start)'. A client sending an empty id therefore receives a 400 claiming a date-range problem, masking the real cause and complicating support triage.

**Evidence.**

```
for it in items:
    if not it.id:
        invalid += 1
        continue
...
if res.get("invalid"):
    raise HTTPException(status_code=400, detail="Invalid date range (end must be after start)")
```

**Suggested fix.** Track blank-id failures separately from inverted-range failures (e.g. a `bad_id` counter), and return distinct 400 messages ('id required' vs 'Invalid date range'). Or validate `id` presence with a dedicated 400 before counting it as `invalid`.

**Verification.** Line 778-779 increments the shared `invalid` counter for a blank id, and the single-task handler at 815-816 maps any nonzero invalid to the fixed 'Invalid date range (end must be after start)' message, masking the real blank-id cause.

---

<a id="r121"></a>
### R121. POST /task/note silently succeeds for a nonexistent task id

`brain.py:821-837`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** `db.update_task_note` runs `UPDATE orders SET notes=... WHERE id=%s` and returns `{status:'ok', updated: rowcount}`. If `task_id` matches no row, `rowcount` is 0 but the endpoint still returns HTTP 200 `{status:'ok', updated:0}`. The route does not inspect `updated`, so a client writing a note against a stale/typo'd id gets a success response while the note is silently dropped. By contrast the single `/task/update` path (813-814) explicitly raises 404 on `not_found`. This is an inconsistent and silently-lossy contract for note persistence.

**Evidence.**

```
    try:
        return db.update_task_note(task_id, notes)
    except Exception as e:
        ...
# db.update_task_note:
    cur.execute(sql, (notes or None, task_id))
    updated = cur.rowcount
    conn.commit()
    return {"status": "ok", "updated": updated}
```

**Suggested fix.** After the call, if `result.get('updated', 0) == 0` raise `HTTPException(status_code=404, detail='Task not found')`, mirroring the `/task/update` behavior.

**Verification.** db.update_task_note returns {status:'ok', updated:rowcount} (db.py 424-426) and the route at 834 returns it unchanged without checking `updated`, so a note against an unknown id yields 200/updated:0, unlike /task/update which raises 404 at 813.

---

<a id="r122"></a>
### R122. Bulk update logs a spurious 'some tasks not persisted' warning for no-op date edits

`brain.py:843-882`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** `total` counts every item in the payload, but `_apply_task_date_updates` (lines 783-784) silently skips any item with both start_date and end_date None via `continue` — these are never added to `norm`, never counted as invalid, and never persisted. So any autosave batch that includes tasks without a date change (common, since the frontend posts full `tasks`) makes `res['persisted'] < total` true and emits a misleading warn-level log claiming persistence failed when nothing actually failed. This pollutes the backend ring buffer (`_BACKEND_LOG`, 500 entries) and the Admin Cockpit log view with false alarms, and the comparison cannot distinguish a real partial-persist failure from benign no-op rows.

**Evidence.**

```
    res = _apply_task_date_updates(payload.tasks)
    total = len(payload.tasks)
    stale = res.get("stale", [])
    if res["persisted"] < total:
        _log_event("warn", "db", "Bulk update: some tasks not persisted", ...)
```

**Suggested fix.** Compare against the count of items that actually carried an edit. E.g. have `_apply_task_date_updates` return the normalized/attempted count (`len(norm)`), or compute `attempted = sum(1 for t in payload.tasks if t.id and (t.start_date or t.end_date))` and warn only when `res['persisted'] < attempted`.

**Verification.** Lines 783-784 `continue` past items with both dates None without counting them, but total=len(payload.tasks) at 851 and the warn at 853-857 fires whenever res['persisted'] < total, so any benign no-op row triggers a false warn.

---

<a id="r123"></a>
### R123. OFFSET applied with truthy check `if offset:` instead of `is not None`

`db.py:167-172`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** LIMIT uses the correct `is not None` guard, but OFFSET uses a truthy check `if offset:`. offset=0 is a legitimate, explicit value (first page) yet is silently dropped — harmless for offset=0 since SQL defaults to 0, but the asymmetry is a latent inconsistency: in brain.py get_tasks, `paging = limit is not None or offset is not None` will set paging=True for an `?offset=0` only request (no limit), which then computes meta.total via count_orders and returns the full unbounded result with paging metadata attached — a confusing contract where the caller thinks it paged but received everything. The guards in the two files disagree on what 'paging' means.

**Evidence.**

```
if limit is not None:
    sql += " LIMIT %s"
    params.append(int(limit))
if offset:
    sql += " OFFSET %s"
    params.append(int(offset))
```

**Suggested fix.** Use `if offset is not None:` in query_orders to match the LIMIT guard and the brain.py `paging` definition, so the two files agree on offset semantics.

**Verification.** db.py line 167 guards LIMIT with `if limit is not None` but line 170 guards OFFSET with `if offset:`, a real asymmetry where offset=0 is dropped while brain.py 643 treats offset is not None as paging.

---

<a id="r124"></a>
### R124. Maintenance table allowlist is cached for process lifetime; tables created after startup are permanently un-vacuumable and the cache never refreshes

`db.py:840-852`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** The allowlist is populated lazily once and then frozen for the lifetime of the worker process. master_data.py owns runtime DDL (add/drop tables/columns) per CLAUDE.md; any table created after this cache is first built will be rejected by run_vacuum_analyze / run_analyze with 'Unknown table' even though it is a legitimate table. Conversely a dropped table lingers in the allowlist and a VACUUM against it would then error at execution. pg_stat_user_tables is a cheap catalog read; caching it indefinitely trades a negligible perf saving for a correctness/staleness bug. (Security is fine - the allowlist still gates injection.)

**Evidence.**

```
_MAINT_TABLE_ALLOWLIST: set | None = None


def _get_maint_table_allowlist() -> set:
    global _MAINT_TABLE_ALLOWLIST
    if _MAINT_TABLE_ALLOWLIST is None:
        with _pool.connection() as conn:
            rows = conn.execute(
                "SELECT relname FROM pg_stat_user_tables"
            ).fetchall()
        _MAINT_TABLE_ALLOWLIST = {r[0] for r in rows}
    return _MAINT_TABLE_ALLOWLIST
```

**Suggested fix.** Either query pg_stat_user_tables on every maintenance call (the cost is trivial relative to a VACUUM) or add a way to invalidate _MAINT_TABLE_ALLOWLIST when master_data DDL runs. Re-validate the target table against the live catalog at call time regardless.

**Verification.** Lines 840-852 populate _MAINT_TABLE_ALLOWLIST once when None and never invalidate it; master_data.py owns runtime DDL per CLAUDE.md, so tables created post-startup are rejected and dropped tables linger, though this is a low-severity edge given DDL is infrequent.

---

<a id="r125"></a>
### R125. Midnight-finish heuristic recomputes finish time for any order legitimately ending at 00:00

`db.py:980-984`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** This treats 'finish hour == 0' as a proxy for 'SAP exported a date with no time component' and overwrites the finish with start + run_time. But an order that genuinely finishes at exactly midnight (hour 0, e.g. a shift ending at 00:00, or a multi-day order whose computed end lands on 00:00) is indistinguishable from a time-less export and gets its real finish silently discarded and replaced by a run_time-derived value. The check also only inspects .hour, ignoring minutes/seconds, so 00:30 is treated as a real time while 00:00 is not. This corrupts BASIC_FINISH_DATE for a legitimate (if uncommon) class of orders, which then drives the Gantt bar length and overlap/overload alerts.

**Evidence.**

```
mask_notime = df["BASIC_FINISH_DATE"].dt.hour == 0
    df.loc[mask_notime, "BASIC_FINISH_DATE"] = (
        df.loc[mask_notime, "BASIC_START_DATE"]
        + pd.to_timedelta(df.loc[mask_notime, "RUN_TIME"], unit="h")
    )
```

**Suggested fix.** Detect a missing time component explicitly (e.g. finish.normalize() == finish, i.e. hour==0 AND minute==0 AND second==0) only as a tie-break, or better, carry a flag from the parse step indicating whether the source cell had a time component, instead of inferring it from a midnight value that can occur legitimately.

**Verification.** Lines 980-984 use df['BASIC_FINISH_DATE'].dt.hour == 0 as the sole 'no time component' proxy and overwrite finish with start+RUN_TIME, which indeed clobbers a genuine 00:00 finish; note line 965-966 already coerces finish<=start to start+1h so some cases are masked, but a valid same-midnight or multi-day-to-midnight finish is still corrupted.

---

<a id="r126"></a>
### R126. Duplicate-id suffixing (_1, _2) can collide with and overwrite a genuine prior-batch order row

`db.py:996-1006`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** When two rows in one upload hash to the same id (ORDER|MATERIAL not unique), the second is suffixed to id+'_1'. The suffixed value is a free-form string that is then upserted via ON CONFLICT (id). If a previous upload legitimately produced an order whose own make_id happened to equal that suffixed string (or a prior dedup created the same '<hash>_1'), this row will silently UPDATE (overwrite) that unrelated prior order rather than insert a new one - and because scheduled_start/scheduled_end are deliberately preserved on upsert, the victim row keeps stale user edits attached to now-wrong SAP data. The collision probability is low but the failure mode is silent cross-order data corruption with no warning beyond the generic 'duplicate IDs suffixed' note.

**Evidence.**

```
dup_counts = df.groupby("id").cumcount()
    if (dup_counts > 0).any():
        ...
        df.loc[dup_counts > 0, "id"] = (
            df.loc[dup_counts > 0, "id"].astype(str)
            + "_"
            + dup_counts[dup_counts > 0].astype(str)
        )
```

**Suggested fix.** Make the synthetic id unambiguous and collision-proof: derive it from a hash that includes a uniqueness discriminator that cannot collide with a real make_id output (e.g. md5(key + '#dup' + index)), or append the batch_id, so a suffixed id can never equal another order's natural make_id. Better, treat true ORDER|MATERIAL duplicates within a file as a hard validation error rather than silently materializing extra rows.

**Verification.** Lines 996-1006 append a free-form '_<n>' string to the MD5 id and these are upserted via ON CONFLICT(id), so a suffixed id equal to another order's natural make_id (or an earlier batch's suffixed id) would silently UPDATE the wrong row; the collision is low-probability, so medium severity is appropriate.

---

<a id="r127"></a>
### R127. var(--border) used without fallback in index.html inline style (Plant inner-tab strip)

`index.html:1309-1310`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** The Plant sub-pane inner tab strip sets `border-top:1px solid var(--border)` inline. --border is never defined (confirmed: no definition in styles.css or index.html). With no fallback the border color resolves to currentColor instead of a hairline, so the General/Optimization/System Settings tab strip shows a top border in the text color rather than the intended subtle separator. Inconsistent with the rest of the codebase which uses var(--line) for hairlines.

**Evidence.**

```
<nav class="admin-subtabs plant-inner-tabs" role="tablist"
           style="padding:0 24px;border-top:1px solid var(--border);margin-top:0;flex-shrink:0;">
```

**Suggested fix.** Change the inline style to `border-top:1px solid var(--line)` (the defined hairline token), or define --border globally.

**Verification.** index.html line 1310 sets border-top:1px solid var(--border) inline and --border is undefined everywhere, matching the described cosmetic defect.

---

<a id="r128"></a>
### R128. bulk_apply delete uses d[k] (not d.get) — a delete payload missing a key column raises KeyError → unhandled 500 instead of a 4xx

`master_data.py:229-239`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** `vals = [d[k] for k in keys]` indexes each delete dict by every key column with direct subscription. If a client sends a delete entry missing a composite-key field (e.g. a plants delete with only {plant} and no subnetwork), this raises KeyError, which propagates out of bulk_apply uncaught and surfaces as an HTTP 500 with a stack trace rather than a clean 400/validation error. By contrast cascade_preview (lines 183, 198) defensively uses d.get(...). A subtler risk: if a key value were silently None it would build `WHERE subnetwork = NULL` semantics via placeholder, matching nothing — but the KeyError path is the concrete current behavior.

**Evidence.**

```
for d in deletes:
    where = sql.SQL(" AND ").join(
        sql.SQL("{} = {}").format(sql.Identifier(k), sql.Placeholder())
        for k in keys
    )
    vals = [d[k] for k in keys]
    cur.execute(
        sql.SQL("DELETE FROM {} WHERE {}").format(sql.Identifier(table), where),
        vals,
    )
```

**Suggested fix.** Validate each delete dict has all key columns before building the statement (raise ValueError("delete row missing key column …") so brain.py returns 400), or use d.get(k) and skip/reject rows with any missing key. Mirror the defensive .get() already used in cascade_preview.

**Verification.** Line 234 `vals = [d[k] for k in keys]` subscripts each key directly, so a delete dict missing a composite-key column raises KeyError that propagates out of bulk_apply as a 500, while cascade_preview at lines 198/201 defensively uses d.get.

---

<a id="r129"></a>
### R129. to_upsert partition via `c not in to_delete` uses dict-equality membership — duplicate/identical cells are mis-partitioned and it is O(n^2)

`master_data.py:610-611, 683-684`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** to_upsert is computed by excluding any cell whose dict is value-equal to a member of to_delete. Python `in` on a list of dicts compares by value equality, not identity. If the payload contains two cells with identical contents where one is a delete (empty avail_hours) — or any upsert cell that happens to be == a delete cell — the upsert cell is wrongly dropped from to_upsert. The correct partition is the set complement by index/key, not by dict value. It is also O(n*m) dict comparisons; at the 50+ plant / 70+ line / multi-week scale a labor-plan grid save can submit thousands of cells, making this a needless quadratic scan. The same pattern is duplicated in upsert_labor_plan_line (683-684).

**Evidence.**

```
valid = [c for c in cells if c.get("pl_group") and c.get("period")]
to_delete = [c for c in valid if c.get("avail_hours") is None or c.get("avail_hours") == ""]
to_upsert = [c for c in valid if c not in to_delete]
```

**Suggested fix.** Partition in a single pass without membership testing: `to_delete, to_upsert = [], []; for c in valid: (to_delete if (c.get('avail_hours') in (None, '')) else to_upsert).append(c)`. This is O(n) and never collapses value-identical dicts.

**Verification.** Lines 610-611 and 683-684 build to_delete then compute to_upsert via `c not in to_delete`, which is value-equality dict membership over a list — two value-identical cells collapse and it is O(n*m); correctedSeverity low since for this to mis-partition you need two cells with identical contents where one is a delete, which is uncommon in a keyed grid.

---

<a id="r130"></a>
### R130. IntelDB.put resolves with the transaction 'complete' Event, not the inserted key — TimeMachine snap.id corrupted

`nimbus-intelligence.js:353-361, 1198-1202`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** The 'snapshots' store uses keyPath:'id', autoIncrement:true. The author clearly intends IntelDB.put to resolve with the auto-generated key (the .then(id => snap.id = id || snap.id) line only makes sense if 'id' is the new key). But put() wires res to tx.oncomplete, so the promise resolves with a transaction-complete Event, not the request.result key. The IDBObjectStore.put().onsuccess (which carries the key in e.target.result) is never read. Consequently the freshly-created in-memory snapshot gets snap.id set to an Event object instead of its numeric DB key. Any in-memory operation keyed by snap.id is then wrong: e.g. if pruneSnapshots ever operated on the in-memory list it would os.delete(Event) and silently no-op. Today restore/diff/render all match snapshots by .ts (not .id) and pruneSnapshots reloads via getAll() (which returns correct DB keys), so the live blast radius is limited — but the put() contract is broken and is a latent correctness trap for any future code that trusts snap.id.

**Evidence.**

```
put(store, value) {
  if (!IntelDB._db) return Promise.resolve();
  return new Promise((res, rej) => {
    const tx = IntelDB._db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = res;            // <-- resolves with the transaction 'complete' Event
    tx.onerror    = e => rej(e.target.error);
  });
}
...
IntelDB.put('snapshots', snap).then(id => {
  snap.id = id || snap.id;          // id is an Event object, always truthy
  TimeMachine._snapshots.push(snap);
  IntelDB.pruneSnapshots(200);
})
```

**Suggested fix.** Capture the request and resolve with its key: `const req = tx.objectStore(store).put(value); tx.oncomplete = () => res(req.result); tx.onerror = e => rej(e.target.error);`. Then snap.id = id || snap.id will store the real autoIncrement key.

**Verification.** Lines 353-361 wire tx.oncomplete = res (resolving with the complete Event, never reading request.result), and 1198-1199 does snap.id = id || snap.id treating that Event as the key; the autoIncrement keyPath:'id' store (line 340) means the real key is silently never captured, though live matching is by .ts so blast radius is latent.

---

<a id="r131"></a>
### R131. TimeMachine.restore pushes directly into UndoStack._entries, bypassing the MAX=10 cap

`nimbus-intelligence.js:1262-1263`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** UndoStack.push enforces a 10-entry ring (app.js:8814-8817: `if (this._entries.length > this.MAX) this._entries.shift()`). restore() deliberately bypasses push (presumably to avoid the snapshot() side-effect the monkey-patch added), but in doing so it also bypasses the MAX trim. Repeated Time Machine restores therefore grow UndoStack._entries without bound, each retaining a full structuredClone of every task in beforeSnap. At the 3,500-line scale target this is a slow memory leak across a long planning session. It also makes the undo depth inconsistent with every other mutation path.

**Evidence.**

```
const beforeSnap = UndoStack.snapshotTasks(Store.tasksArr.map(t => t.id));
UndoStack._entries.push({ label: 'Before Time Machine restore', undoFn: () => UndoStack.restoreTasks(beforeSnap), at: Date.now() });
```

**Suggested fix.** After the direct push, trim manually (`if (UndoStack._entries.length > UndoStack.MAX) UndoStack._entries.shift();`), or expose an UndoStack method like pushSilent(label, undoFn) that applies the cap without triggering the TimeMachine snapshot side-effect, and call it here.

**Verification.** Line 1263 does UndoStack._entries.push(...) directly, while UndoStack.push (app.js:8814-8817) is the only path that trims via _entries.shift() when length > MAX(10), so repeated restores grow the array unbounded each retaining a full task snapshot.

---

<a id="r132"></a>
### R132. Confidence score can be computed from stale Store.alerts (worker is async; 'alerts' source not subscribed)

`nimbus-intelligence.js:1293-1308, 1326-1348`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** Alerts.recompute offloads the actual computation to nimbus-worker.js and returns before Store.alerts is updated (the worker resolves later via Compute.alerts(...).then(... Store.setAlerts ...), app.js:3550-3558). The Confidence wrapper fires _recomputeDebounced() at recompute *call* time, and Confidence does NOT subscribe to the 'alerts' Store event (its subscription list is plant:selected + tasks:* only). So the 400ms-debounced Confidence._recompute reads whatever Store.alerts held BEFORE the in-flight worker result lands. On a slow worker round-trip (large plant) the score and sparkline reflect the previous alert set until the next unrelated tasks event nudges another recompute. Note: the CLAUDE.md claim that this wrapper is 'arity-0' and drops the {lines} incremental scope is STALE — the live code forwards (...args), so incremental scope is preserved; this staleness-vs-worker timing is the real (smaller) issue.

**Evidence.**

```
Store.subscribe(evt => {
  if (evt?.type === 'plant:selected') { ... }
  if (['tasks:bulk','tasks:bulkUpdate','task:update','task:remove'].includes(evt.type))
    Confidence._recomputeDebounced();
});
const origRecompute = Alerts.recompute.bind(Alerts);
Alerts.recompute = (...args) => { const r = origRecompute(...args); Confidence._recomputeDebounced(); return r; };
...
_recompute() {
  const alerts = Store.alerts || [];   // read synchronously
```

**Suggested fix.** Subscribe Confidence to the 'alerts' Store event (Store.setAlerts emits source 'alerts') and recompute the score from that, instead of (or in addition to) patching Alerts.recompute. That guarantees the score is derived from the alert set actually committed to the Store.

**Verification.** Alerts.recompute offloads to the worker and resolves Store.setAlerts later (app.js:3550-3559), the Confidence wrapper fires the debounced recompute at call time (1308) reading Store.alerts synchronously (1327), and Confidence subscribes only to plant:selected/tasks events (1293-1306) — not the 'alerts:change' event setAlerts emits (app.js:901-903).

---

<a id="r133"></a>
### R133. Confidence._drawChart divides font sizes by devicePixelRatio without scaling the canvas — labels shrink on HiDPI displays

`nimbus-intelligence.js:1552-1590`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** The canvas backing store is a fixed 760x240 (set in the dialog HTML, line 1535) and is never scaled by dpr (there is no ctx.scale(dpr,dpr) and W/H are the literal attribute values). Dividing the font px by dpr therefore makes the text smaller for no reason: on a 2x Retina/Windows-200%-scaling display the 14px zone labels render at 7px and the 18px axis labels at 9px. The intent of a dpr divisor only makes sense when the context has been pre-scaled by dpr; here it inverts the usual HiDPI correction and degrades legibility on exactly the high-resolution monitors planners are likely to use.

**Evidence.**

```
const dpr = window.devicePixelRatio || 1;
ctx.clearRect(0, 0, W, H);
...
ctx.font = `bold ${Math.round(14/dpr)}px system-ui`; ctx.textAlign = 'right';
...
ctx.font = `${Math.round(18/dpr)}px system-ui`; ctx.textAlign = 'left';
```

**Suggested fix.** Drop the /dpr divisor (use `bold 14px system-ui` and `18px system-ui`). If crisp HiDPI rendering is desired, instead set canvas.width/height = CSS_size * dpr, keep CSS size fixed via style, call ctx.scale(dpr,dpr) once, and use unscaled font sizes.

**Verification.** Canvas is fixed 760x240 (line 1535) with no ctx.scale(dpr,dpr) applied; lines 1573 and 1587 set font to Math.round(14/dpr) and Math.round(18/dpr), so on a 2x display labels render at half size — an inverted HiDPI correction that only degrades legibility.

---

<a id="r134"></a>
### R134. RipplePreview ghosts are position:fixed from a one-time getBoundingClientRect and never reposition on scroll/zoom

`nimbus-intelligence.js:1741-1754`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** Ghost overlays are placed at absolute viewport coordinates captured at hover time. The vis-timeline is horizontally/vertically scrollable; if the user scrolls or the timeline re-renders while Alt is held, the ghosts remain frozen at stale coordinates and no longer line up with their target items. Mitigation exists for the cursor-stuck case (blur/visibilitychange clear), but not for scroll-induced drift. Impact is purely a transient visual artifact (preview only, no data mutation), hence low severity. The 6th-onward downstream items are intentionally capped at 5 (.slice(0,5)).

**Evidence.**

```
const r = el.getBoundingClientRect();
if (!r.width) return;
const ghost = document.createElement('div');
ghost.className = 'ni-ripple-ghost';
ghost.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;
  border-radius:3px;pointer-events:none;z-index:9998;box-sizing:border-box;
  opacity:${0.75 - i * 0.1};`;
```

**Suggested fix.** Clear ghosts on the timeline's scroll/rangechange events (or render them as vis-timeline background items / absolutely-positioned children of the scroll container) so they track the items, and re-run _show on rangechange while _active.

**Verification.** Lines 1744-1750 create position:fixed ghosts at coordinates captured once from getBoundingClientRect with no scroll/rangechange listener to reposition; impact is a transient preview-only visual artifact, so low severity is correct.

---

<a id="r135"></a>
### R135. Diff treats any non-zero start delta as 'moved', flagging null<->null and unscheduled transitions inconsistently

`nimbus-intelligence.js:1812-1827`  ·  **LOW**  ·  _bug-error_  ·  confidence: medium

**Why it matters.** Because null start dates are coalesced to 0 with `|| 0`, an order that goes from scheduled (e.g. start_date = epoch ms) to unscheduled (null) produces a huge negative delta and is reported as a multi-thousand-hour 'earlier' move rather than as an unschedule; conversely scheduling a previously-null order shows a giant 'later' move. The reverse (null -> null with only a line change) is handled, but the mixed null/non-null case mislabels semantics and produces a nonsensical _fmtDelta value in the rendered diff. This is a correctness/UX defect in the comparison view rather than a data-write bug, hence low severity.

**Evidence.**

```
Object.keys(mapB).forEach(id => {
  if (!mapA[id]) return;
  const delta       = (mapB[id].start_date || 0) - (mapA[id].start_date || 0);
  const lineChanged = mapA[id].PRODUCTION_LINE !== mapB[id].PRODUCTION_LINE;
  if (Math.abs(delta) > 0 || lineChanged) {
    moved.push({ ...mapB[id], delta, lineFrom: mapA[id].PRODUCTION_LINE, lineTo: mapB[id].PRODUCTION_LINE, lineChanged, newStart: mapB[id].start_date, oldStart: mapA[id].start_date, });
```

**Suggested fix.** Branch on null start_date: if one side is null and the other is not, classify as 'unscheduled' / 'scheduled' rather than computing a delta from a 0 epoch. Only compute the numeric delta when both oldStart and newStart are non-null.

**Verification.** Line 1814 coalesces null start_date to 0 with `|| 0`, so a scheduled→null (or null→scheduled) transition yields a huge epoch-based delta reported as a multi-thousand-hour move rather than an unschedule/schedule, a comparison-view correctness/UX defect; low severity fits since it is display-only.

---

<a id="r136"></a>
### R136. --border and --border-subtle CSS variables used without fallback but never defined

`styles.css:4905-4906`  ·  **LOW**  ·  _bug-error_  ·  confidence: high

**Why it matters.** Neither --border nor --border-subtle is defined anywhere in styles.css (no :root or body.dark definition) or in index.html's inline <style>. Confirmed via regex for `^\s*(--border|--border-subtle)\s*:` — zero matches. Unlike --font-mono, --amber, --nimbus-amber, and --bg-float (which all carry inline fallbacks like var(--font-mono, monospace)), these two usages have NO fallback. An undefined custom property with no fallback resolves to the property's initial/inherited value, so the border-bottom shorthand receives an invalid color token and the border color falls back to currentColor (the text color) rather than a hairline. In the Admin Cockpit Thread profiler table this produces heavy text-colored row separators instead of subtle borders, in both light and dark mode.

**Evidence.**

```
.admin-perf-table th { ... border-bottom: 2px solid var(--border); ... }
.admin-perf-table td { padding: 4px 10px; border-bottom: 1px solid var(--border-subtle); white-space: nowrap; }
```

**Suggested fix.** Either define --border and --border-subtle in :root and body.dark (e.g. map --border to --line and --border-subtle to a lighter hairline), or replace the two usages with the existing defined tokens: `border-bottom: 2px solid var(--line-strong)` and `border-bottom: 1px solid var(--line)`.

**Verification.** styles.css lines 4905-4906 use var(--border)/var(--border-subtle) with no fallback, and grep confirms neither token is defined anywhere in styles.css or index.html, so the border color resolves to currentColor.

---

<a id="r137"></a>
### R137. fetchTraced hard-references ErrorLog (defined later in the IIFE) without the typeof guard used elsewhere

`app.js:284-293`  ·  **LOW**  ·  _risk_  ·  confidence: medium

**Why it matters.** Util.fetchTraced lives in the Util layer near the top of the file but hard-references ErrorLog, which is declared much later (Infrastructure layer). Store.setTasks guards the same reference defensively with `typeof ErrorLog !== 'undefined'` (lines 614, 626) precisely because of this load-order constraint, but fetchTraced does not. Because const declarations are in the temporal dead zone until executed, any fetch that resolves during the synchronous module-init window (before ErrorLog's declaration runs) would throw ReferenceError inside the then/catch callback. Low likelihood since most fetches are issued after boot, but the inconsistency with the existing guard pattern makes this a latent risk.

**Evidence.**

```
return fetch(input, { ...init, headers }).then(r => {
        const ms = Math.round(performance.now() - t0);
        if (!r.ok)        ErrorLog.warn('http', `${method} ${url} → ${r.status} (${ms}ms, ${reqId})`);
        else if (ms > 2000) ErrorLog.info('http', `slow: ${method} ${url} ${ms}ms (${reqId})`);
        return r;
      }).catch(e => {
        if (e?.name === 'AbortError') throw e;
        ErrorLog.error('http', `${method} ${url} failed: ${e.message} (${reqId})`);
```

**Suggested fix.** Apply the same guard used in Store.setTasks: wrap the ErrorLog calls in `if (typeof ErrorLog !== 'undefined')`, or capture a safe logger at call time.

**Verification.** Lines 286-291 call ErrorLog.warn/info/error unguarded inside fetchTraced, whereas Store.setTasks at 614/626 wraps the same reference in `typeof ErrorLog !== 'undefined'`; the inconsistency is real though the TDZ window is only hit by a fetch resolving during synchronous module init (low likelihood).

---

<a id="r138"></a>
### R138. scheduleKpis calls .getTime() on raw task date fields, contradicting its documented pure-function contract for arbitrary task arrays

`app.js:338-348`  ·  **LOW**  ·  _risk_  ·  confidence: medium

**Why it matters.** The function comment states it is 'Pure: takes a task array, no Store access.' But it calls t.start_date.getTime() and e.getTime() directly, where scheduledEnd/sapDueDate (lines 298-305) return the raw end_date/original_end_date fields unparsed. If a caller passes tasks whose date fields are still ISO strings (not normalized through Store._normalizeDates), .getTime() throws a TypeError and aborts the whole KPI computation. The peak-util block (lines 352-360) is wrapped in try/catch, but the span/lateness loop above it is not. In current usage tasks always originate from the normalizing Store, so this is latent rather than active.

**Evidence.**

```
scheduleKpis(tasks, horizonDays = 14) {
      const changeovers = Util.countChangeovers(tasks);
      let minStart = Infinity, maxEnd = -Infinity;
      let lateCount = 0, lateH = 0;
      for (const t of tasks) {
        if (t.start_date) minStart = Math.min(minStart, t.start_date.getTime());
        const e = Util.scheduledEnd(t);
        if (e) maxEnd = Math.max(maxEnd, e.getTime());
```

**Suggested fix.** Coerce defensively: `const s = Util.parseDate(t.start_date); if (s) minStart = Math.min(minStart, s.getTime());` and `const e = Util.parseDate(Util.scheduledEnd(t)); if (e) maxEnd = Math.max(maxEnd, e.getTime());`. This honors the documented pure/arbitrary-input contract.

**Verification.** Lines 336-348 carry the 'Pure: takes a task array' comment yet call t.start_date.getTime() and e.getTime() on unparsed fields (scheduledEnd returns raw end_date/original_end_date) outside any try/catch, so a string-valued date would throw; latent because current callers feed Store-normalized tasks.

---

<a id="r139"></a>
### R139. _renderHours rAF flatpickr init re-reads Store.selectedPlant, risking stale-plant pickers if selection changes within one frame

`app.js:1464-1482`  ·  **LOW**  ·  _risk_  ·  confidence: medium

**Why it matters.** _renderHours builds the pill DOM synchronously for the plant captured at call time, then defers flatpickr initialization to requestAnimationFrame, which re-reads `Store.plants[Store.selectedPlant]` instead of capturing the plant used to build the DOM. If selectedPlant changes between the synchronous render and the rAF callback (a fast plant switch, or a 'plant:selected' event re-entering render), `p` is the NEW plant while the pickers are bound to DOM elements/values from the OLD plant — and if the new plant has no entry yet, `p` could even be undefined (ensurePlant ran for the old name only at line 1438), throwing `Cannot read properties of undefined (reading 'workHours')` inside the rAF. The init reads Store.plants[Store.selectedPlant] rather than the closure's `plantName`/`Store.plants[plantName]`, defeating the snapshot.

**Evidence.**

```
requestAnimationFrame(() => {
  const p = Store.plants[Store.selectedPlant];
  for (let d = 0; d < 7; d++) {
    const wh = p.workHours[d];
    ...
    defaultDate: wh ? Calendar._hToT(wh[0]) : '08:00',
```

**Suggested fix.** Capture the plant at render time and use it in the rAF: `const plantName = Store.selectedPlant; ... requestAnimationFrame(() => { const p = Store.plants[plantName]; if (!p) return; ... })`. This matches the closure variable already named `plantName` at line 1436.

**Verification.** app.js 1436 captures plantName=Store.selectedPlant but the rAF at 1465 re-reads Store.plants[Store.selectedPlant] instead of using the closure plantName, so a plant switch within the frame yields a mismatched or undefined p; real but low-probability given typical render cadence.

---

<a id="r140"></a>
### R140. Selecting a plant inside the optimize dialog mutates the global Store.selectedPlant as a side effect

`app.js:4755 and 4823-4825`  ·  **LOW**  ·  _risk_  ·  confidence: medium

**Why it matters.** Both _buildPlantSelect (called from open()) and selectPlant push the chosen plant into the global Store via setSelectedPlant, which publishes 'plant:selected' and re-renders the entire app (Gantt, Table, Dashboard, Hierarchy) behind the modal. Picking a plant merely to scope an optimize run thus silently re-scopes the whole application view, and on open() it can fire a full app re-render in the same tick the modal is being shown. This couples a transient dialog choice to global navigation state; if the user cancels the dialog, the app is left scoped to whatever plant they last clicked.

**Evidence.**

```
if (_plant) Store.setSelectedPlant(_plant, 'optimize-dialog');   // inside _buildPlantSelect
...
function selectPlant(plant) {
  _plant = plant;
  Store.setSelectedPlant(plant, 'optimize-dialog');
  ...
```

**Suggested fix.** Keep the optimize dialog's plant selection local to _plant and pass it explicitly to Engine.runAndApply via opts.plant (which it already supports: `opts.plant ?? Store.selectedPlant`). Only call Store.setSelectedPlant if changing the global scope is the intended UX; otherwise drop the side effect so Cancel leaves the prior view intact.

**Verification.** Both _buildPlantSelect (4755) and selectPlant (4825) call Store.setSelectedPlant(..., 'optimize-dialog'), so a transient dialog choice re-scopes global app state; whether this is undesired is a UX judgment but the side effect is real.

---

<a id="r141"></a>
### R141. Optimize run can be double-submitted: runWithPreview re-snapshots after a possible prior mutation with no in-flight guard

`app.js:5099-5113, 5167-5169, 8897-8930`  ·  **LOW**  ·  _risk_  ·  confidence: medium  ·  **⚖️ needs-human-judgment**

**Why it matters.** run() disables the run button for responsiveness, but close(true) then hides the entire config modal, so the disabled state is moot — the run is committed by a deferred rAF+setTimeout. The actual snapshot/optimize in runWithPreview happens inside a further double-rAF (lines 8897+), i.e. several frames later. opts.startDate/endDate were captured by value, but the snapshot (UndoStack.snapshotTasks) and pre-KPIs are computed against Store at execution time, not at click time. If any other mutation lands in that window (autosave-driven refresh, concurrency refetch, a second queued optimize), the 'pre' snapshot no longer reflects the state the user reviewed. There is no in-flight guard on OptimizerPreview itself.

**Evidence.**

```
if (runBtn) {
  runBtn.disabled = true;
  runBtn.innerHTML = `...optimizing...`;
}
OptimizerPreview.showLoading(_mode, plant);
close(true);   // hides the whole config modal immediately
...
requestAnimationFrame(() => setTimeout(() => {
  OptimizerPreview.runWithPreview(_mode, optsForEngine);
}, 0));
```

**Suggested fix.** Add a simple in-flight flag on OptimizerPreview (set on showLoading/runWithPreview entry, cleared on _render/error) and reject re-entry while a preview is pending, so a queued or duplicate run cannot snapshot against a state mutated by the first run.

**Verification.** Confirmed runBtn is disabled (5100) then the modal is closed via close(true) (5113) and the run deferred through rAF+setTimeout (5167) into a double-rAF snapshot (8897), with no in-flight flag on OptimizerPreview; whether a duplicate/concurrent mutation can actually land in that window depends on runtime event timing I cannot determine from source.

---

<a id="r142"></a>
### R142. Master-data fetch on the zero-row/non-zero load paths is detached, so awaiting load() does not guarantee the plant picker is hydrated

`app.js:10397-10410, 10511-10527`  ·  **LOW**  ·  _risk_  ·  confidence: medium

**Why it matters.** Both the zero-task branch (10397) and the main success branch (10512) launch a fire-and-forget Promise.all for master-data that is NOT returned from the enclosing .then. Each has a .catch so there is no unhandled-rejection, but because they are not chained, the outer load() promise resolves before master-data is hydrated. Callers that await load() (boot, reload, loadForPlant) believe loading is finished while Store.masterData / the plant index are still empty, so the plant picker and Master Data tabs can render empty/stale for plants that have no orders. The no-plant branch at 10355 correctly returns its Promise.all, so the inconsistency is internal to this same function.

**Evidence.**

```
            Promise.all([
              fetch(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
              fetch(`${Config.API_BASE}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
            ]).then(([pData, lData]) => { ... }).catch(e => ErrorLog.warn('persistence', `Master-data fetch failed (zero-task path): ${e.message}`));
            return;
```

**Suggested fix.** Return the master-data Promise.all from these two branches (return Promise.all([...]).then(...)) so load()'s resolution reflects master-data hydration, matching the no-plant branch at 10355.

**Verification.** The zero-task branch (10397) and happy path (10512) start a Promise.all that is NOT returned from the enclosing .then, while the no-plant branch (10355) correctly returns it — so awaiting load() resolves before master-data hydration on those two paths.

---

<a id="r143"></a>
### R143. Color-wheel load/refresh swallow all exceptions, can serve a stale wheel after a failed refresh

`brain.py:380-383, 405-409`  ·  **LOW**  ·  _risk_  ·  confidence: medium

**Why it matters.** _reload_one_plant_wheel parses the just-uploaded file inside a bare `except Exception: pass`. If _parse_color_wheel raises (e.g. COLOR column missing/renamed at parse time, or a numeric-coercion edge case), the existing PLANT_CWS[key] entry is left untouched, yet CW_LOADED_AT is still bumped and upload_color_wheel returns {status: ok}. The caller believes the new wheel took effect while the optimizer keeps using the previous wheel's priorities — a silent data-integrity drift between what the user uploaded and what /tasks color-merge applies. (upload_color_wheel does pre-validate COLOR/ORDER_Y presence, which mitigates the most common case, but any other parse failure is still swallowed and reported as success.)

**Evidence.**

```
try:
    p_cws[m.group(1).upper()] = _parse_color_wheel(os.path.join(COLOR_WHEEL_DIR, fname))
except Exception:
    pass
...
try:
    PLANT_CWS[key] = _parse_color_wheel(path)
except Exception:
    pass
CW_LOADED_AT = pd.Timestamp.utcnow().isoformat()
```

**Suggested fix.** In _reload_one_plant_wheel, log the exception via _log_event('error', ...) instead of silent pass, and surface a non-ok status to upload_color_wheel so the response reflects that the cache refresh failed even though the file was written.

**Verification.** Lines 405-409 parse inside a bare `except Exception: pass`, CW_LOADED_AT is still bumped (409) and the caller returns status ok (1017), so any parse failure other than the pre-validated COLOR/ORDER_Y check (982-984) silently leaves the old wheel in place while reporting success.

---

<a id="r144"></a>
### R144. load_labor_plan_line LEFT JOIN keys on (production_line, plant) without subnetwork, risking fan-out at scale

`master_data.py:659-669`  ·  **LOW**  ·  _risk_  ·  confidence: medium

**Why it matters.** The JOIN to production_lines matches on (production_line, plant) but production_lines is keyed on (subnetwork, plant, production_line) per _KEY_COLUMNS. If the same production_line code exists under two subnetworks for the same plant, this LEFT JOIN fans out — each labor_plan_line row matches multiple production_lines rows and is emitted more than once, double-counting avail_hours in the result. This mirrors the documented plant-blind ID limitation elsewhere in NIMBUS. The JOIN is also only needed when `group` is supplied (it filters on pl.pl_group), yet it is always performed even when group is None, adding an unnecessary join for the common unfiltered case.

**Evidence.**

```
SELECT lpl.production_line, lpl.day, lpl.avail_hours, lpl.source
FROM labor_plan_line lpl
LEFT JOIN production_lines pl
  ON pl.production_line = lpl.production_line AND pl.plant = lpl.plant
WHERE {where}
ORDER BY lpl.production_line, lpl.day
```

**Suggested fix.** Include subnetwork in the JOIN condition (pl.subnetwork = lpl.subnetwork) to match the real composite key, and skip the production_lines JOIN entirely when `group` is None so the unfiltered read is a single-table scan. Confirm a covering index on labor_plan_line(plant, production_line, day) supports the WHERE+ORDER BY (idx_lpl_plant_line exists but lacks day).

**Verification.** Lines 663-664 join production_lines ON (production_line, plant) only, omitting subnetwork even though _KEY_COLUMNS['production_lines'] includes subnetwork (line 35), so if a line code repeats across subnetworks within a plant the LEFT JOIN fans out and double-counts; this is the documented plant/subnetwork-blind limitation pattern, real but its impact depends on whether line codes actually collide across subnetworks.

---

<a id="r145"></a>
### R145. chk_orders_sched_range is dropped and re-added NOT VALID on every run, so it is never validated against existing rows and re-locks orders each time

`schema.sql:57-60`  ·  **LOW**  ·  _risk_  ·  confidence: medium

**Why it matters.** The DROP-then-ADD pattern won't error on re-run, but it has two costs. (1) NOT VALID means existing rows are never checked, and because the constraint is dropped and re-added NOT VALID on EVERY run with no VALIDATE CONSTRAINT step anywhere, pre-existing inverted ranges remain permanently un-audited; the comment frames NOT VALID as 'never fails on pre-existing rows' but omits that it is therefore never validated either, so the belt-and-suspenders against legacy data is illusory. (2) DROP + ADD takes an ACCESS EXCLUSIVE lock each run; on a large orders table during a routine re-run this is an avoidable table lock. New writes are still checked, so the goal partly holds.

**Evidence.**

```
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_sched_range;
ALTER TABLE orders ADD CONSTRAINT chk_orders_sched_range
    CHECK (scheduled_start IS NULL OR scheduled_end IS NULL OR scheduled_end > scheduled_start)
    NOT VALID;
```

**Suggested fix.** Guard the ADD with a catalog existence check (only add if the constraint is absent) to avoid the per-run lock, and add a one-shot VALIDATE CONSTRAINT step (after cleaning any existing inverted rows) so existing data is actually enforced rather than perpetually NOT VALID.

**Verification.** schema.sql lines 57-60 DROP then ADD the constraint NOT VALID with no VALIDATE CONSTRAINT anywhere in the file, so legacy rows are never checked and each re-run takes the DROP/ADD lock; low severity is appropriate.

---

<a id="r146"></a>
### R146. DEBUG_BLOCKS left enabled in shipped config, emitting a full console.trace on every block add

`app.js:91-92`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** DEBUG_BLOCKS is committed as true, so Store.addBlock (line 716) and addPlantBlock (line 776) emit a full console.trace (stack capture) on every block insertion. The inline comment frames this as a temporary diagnostic toggle. At the scale target with per-plant blackout configs and bulk loads, repeated stack-trace captures add measurable main-thread cost and console noise, and expose internal block structures in a shipped build.

**Evidence.**

```
DEBUG_BLOCKS:       true,                       // when true, Store.addBlock/addPlantBlock console.trace every push (for diagnosing duplicate-add bugs)
```

**Suggested fix.** Default DEBUG_BLOCKS to false; enable only while actively diagnosing duplicate-add bugs.

**Verification.** Line 91 sets DEBUG_BLOCKS: true and addBlock (716) console.traces every push; it is committed as enabled with a comment framing it as a duplicate-add diagnostic.

---

<a id="r147"></a>
### R147. DEBUG_BLOCKS defaults to true — console.trace runs on every block add in production

`app.js:91, 716, 776`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** DEBUG_BLOCKS is hardcoded to true. console.trace forces a full stack-trace capture and serialization to the console on every blackout block add. Per CLAUDE.md blackouts are per-plant and the scale target is 50+ plants; bulk-hydrating many plant/line blackout blocks at boot emits a stack trace per block, adding load-time cost and console spam in a deployed build. This is diagnostic scaffolding left enabled.

**Evidence.**

```
DEBUG_BLOCKS: true,  // when true, Store.addBlock/addPlantBlock console.trace every push
...
addBlock(block, source) {
  if (Config.DEBUG_BLOCKS) console.trace('[addBlock]', { source, block });
...
addPlantBlock(block, source) {
  if (Config.DEBUG_BLOCKS) console.trace('[addPlantBlock]', { source, block });
```

**Suggested fix.** Default DEBUG_BLOCKS to false (it is a targeted aid for a duplicate-add bug), or gate it on a dev-only runtime flag so production never pays the console.trace cost during block hydration.

**Verification.** Duplicate of the earlier DEBUG_BLOCKS finding; line 91 sets it true and both addBlock (716) and addPlantBlock (776) console.trace when the flag is set, exactly as cited.

---

<a id="r148"></a>
### R148. PerfMonitor.stats() allocates and sorts a fresh array on every call

`app.js:511-528`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** stats() copies the Float32Array ring buffer into a new JS Array (Array.from over up to 100 entries) and sorts it (O(n log n)) on every invocation. all() calls stats() once per bucket. The AdminCockpit Thread tab subscribes to PerfMonitor and re-renders on the 250ms _notify debounce, calling all() which re-sorts every bucket each tick. Since Store.emit records a perf sample for every listener on every mutation (lines 599-601), bucket count grows with subscribed module count, so all() cost scales with module count x 100-entry sorts. Bounded (n<=100 per bucket) but pure repeated work that could be incrementally maintained.

**Evidence.**

```
function stats(name) {
  const b = _buckets.get(name);
  if (!b) return null;
  const n = Math.min(b.count, _MAX);
  const sorted = Array.from(b.buf.subarray(0, n)).sort((a, c) => a - c);
  ...
}
function all() {
  return [..._buckets.keys()].map(k => ({ name: k, ...stats(k) }));
}
```

**Suggested fix.** Cache the sorted percentiles per bucket and recompute only when a new sample is recorded for that bucket (track a dirty flag in record()), avoiding the full Array.from + sort on every read.

**Verification.** Lines 515 (Array.from + .sort) and 526-528 (all() maps stats over every bucket) confirm a fresh copy-and-sort per bucket per call, driven by the 250ms _notify; bounded at n<=100 per bucket so severity is appropriately low.

---

<a id="r149"></a>
### R149. Store.emit records a PerfMonitor sample (2x performance.now + string concat) for every listener on every mutation

`app.js:593-603`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** Every Store mutation fans out to all listeners, and per listener emit() calls performance.now() twice, builds the key string `'store:' + label` via concatenation, and calls PerfMonitor.record() (which calls _notify()). On hot paths (60fps ghost-drag reflow, bulk optimizer updateMany/emit, incremental alert recompute) this adds two timer reads, a string allocation, and a Map lookup per listener per emit. The key string is rebuilt every call rather than cached on the listener. This overhead exists purely for the diagnostics Thread tab.

**Evidence.**

```
emit(event) {
  this._rev = (this._rev || 0) + 1;
  for (const l of this._listeners) {
    const _t = performance.now();
    try { l(event); } catch (e) { console.error('[Store] listener error:', e); }
    finally { PerfMonitor.record('store:' + (l._pmLabel || l.name || '?'), performance.now() - _t); }
  }
}
```

**Suggested fix.** Cache the composed metric key on the listener fn at subscribe time (e.g. fn._pmKey = 'store:' + label) so emit skips the per-call concat, and/or gate the per-listener timing behind a runtime PerfMonitor-enabled flag so production drag paths skip instrumentation.

**Verification.** Lines 598-601 confirm per-listener performance.now() calls bracketing each listener plus a 'store:'+label string concat and PerfMonitor.record (which calls _notify) on every emit, with the key rebuilt each call; overhead is real but small, low severity is correct.

---

<a id="r150"></a>
### R150. clampLinesToPlant always emits calendar:change even when no line was modified, triggering needless recompute/re-render storms

`app.js:757-774`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** The emit at the end fires unconditionally, even when the loop changed nothing (no lines belong to the plant, or every line's hours already fit inside the plant window). Each emit bumps _rev (line 597), invalidating memoized Utilization matrices, and fans out to every subscriber, which can trigger a full alert recompute. At the scale target (70+ lines per plant), no-op plant-hour edits cause avoidable recompute/re-render storms.

**Evidence.**

```
clampLinesToPlant(plant, dow) {
      const plantHours = this._state.plants[plant]?.workHours[dow];
      for (const line of Object.keys(this._state.calendars)) {
        const lsettings = this._state.lineSettings[line];
        const linePlant = (lsettings || {}).plant || null;
        if (linePlant !== plant) continue;
        const lineHours = this._state.calendars[line].workHours[dow];
        if (!lineHours) continue;
        if (!plantHours) {
          this._state.calendars[line].workHours[dow] = null;
        } else {
          const ns = Math.max(lineHours[0], plantHours[0]);
          const ne = Math.min(lineHours[1], plantHours[1]);
          this._state.calendars[line].workHours[dow] = ns >= ne ? null : [ns, ne];
        }
      }
      this.emit({ type: 'calendar:change', source: 'plant-clamp' });
    },
```

**Suggested fix.** Set a `let changed = false;` flag inside the loop whenever a line's workHours is actually reassigned, and only emit when `changed` is true.

**Verification.** Lines 757-773 emit calendar:change unconditionally after the loop with no changed-flag guard, so a no-op plant-hours edit (no lines in plant, or all already within window) still bumps _rev and fans out to subscribers.

---

<a id="r151"></a>
### R151. getPlantForLine falls back to a linear scan of all master-data lines on cache miss

`app.js:822-832`  ·  **LOW**  ·  _performance_  ·  confidence: medium  ·  **⚖️ needs-human-judgment**

**Why it matters.** The O(1) _lineToPlant cache is built in _rebuildPlantIndex from masterData.lines, but the fallback `.find()` at line 830 is O(number of master-data lines) = up to 3,500 at the scale target. The cache only holds entries enumerated at the last _rebuildPlantIndex; any line not in the cache (referenced before master-data hydration, or an order line code absent from the rebuilt map) hits the linear scan. getPlantForLine is called inside _rebuildPlantIndex's own task loop (line 856), inside linesForSelectedPlant's filter (line 885, O(lines) calls), and inside knownPlants (lines 893-895). A persistent cache miss on a hot line turns those into O(lines^2) over the master-data list.

**Evidence.**

```
getPlantForLine(line) {
  const fromSettings = (this._state.lineSettings[line] || {}).plant;
  if (fromSettings) return fromSettings;
  const cached = this._lineToPlant[line];
  if (cached !== undefined) return cached;
  const mdLine = (this._state.masterData?.lines ?? []).find(r => r.production_line === line);
  return mdLine?.plant ?? null;
}
```

**Suggested fix.** Treat _lineToPlant as authoritative after _rebuildPlantIndex (it enumerates every master-data line) and return null on a miss instead of re-scanning the array; or lazily memoize each .find() result into _lineToPlant so any given line is scanned at most once.

**Verification.** Line 830's .find fallback is real, but _lineToPlant (849-853) is built from every masterData.lines row, so any line present in master data is cached and never re-scanned; the O(lines^2) worst case requires a persistent miss on a master-data line, which the cache build prevents, so the scan only fires for non-master-data lines (where it returns null) — impact depends on how many order line codes are absent from master data.

---

<a id="r152"></a>
### R152. _updateAggrTotals recomputes every week column total by reducing over all groups on each cell edit

`app.js:2417-2424, 2561, 2618`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** On every aggregate cell change/paste, _updateAggrTotals recomputes the total for every week column by reducing over all groups: O(weeks x groups). Only the edited column's total can actually change on a single-cell edit, so reducing all groups for all weeks is unnecessary work, and it runs alongside the separately-reported full _renderKPIs matrix rebuild on each edit.

**Evidence.**

```
function _updateAggrTotals(grid){ const plant = Store.selectedPlant; if (!plant || !_aggrData[plant]) return; const tds = grid.querySelectorAll('tbody tr:last-child td'); _weeks.forEach((w,i) => { const total = Object.values(_aggrData[plant]).reduce((sum,p) => sum + (p[w.key] ?? 0), 0); if (tds[i+1]) tds[i+1].textContent = total > 0 ? total.toFixed(1) : '—'; }); }
```

**Suggested fix.** On a single-cell edit, delta-update only the affected week column's total (subtract old value, add new). For paste, recompute only the set of touched week columns.

**Verification.** _updateAggrTotals (2417-2424) loops every week column and reduces over all groups in _aggrData[plant] on each invocation, and it is called on every single-cell edit (2561) and paste (2618) even though only the edited column's total changes on a single edit.

---

<a id="r153"></a>
### R153. WelcomeSplash arrow loop forces 2 layout reflows per animation frame indefinitely until a plant is selected

`app.js:3619-3660`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** The welcome splash runs a requestAnimationFrame loop that calls _positionArrow on every frame (~60fps). Each call does getElementById + querySelector + two getBoundingClientRect() reads, each of which can force a synchronous layout/reflow. While the splash is visible (i.e. as long as no plant has been selected), this is continuous layout thrash for an overlay whose geometry rarely changes. It is correctly paused on visibilitychange (via App.registerPausable) and torn down on plant:selected, so real-world exposure is limited to the idle boot screen, hence low severity. But polling layout every frame to position a static arrow is unnecessary CPU.

**Evidence.**

```
function _positionArrow() {
  if (!_el || !_svg) return;
  const plantEl = document.getElementById('header-plant-selector');
  const card    = _el.querySelector('.welcome-splash-card');
  if (!plantEl || !card) return;
  const pr = plantEl.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  ...
}
function _startArrowLoop() {
  function tick() {
    _positionArrow();
    _rafId = requestAnimationFrame(tick);
  }
  _rafId = requestAnimationFrame(tick);
}
```

**Suggested fix.** Replace the per-frame rAF loop with event-driven repositioning: call _positionArrow once on init and re-run it only on window 'resize'/'scroll' (debounced) and on a ResizeObserver of the plant selector / card. This eliminates ~60 forced reflows/sec while the splash is up.

**Verification.** _startArrowLoop at 13654-13660 runs a perpetual rAF calling _positionArrow (13619-13651), which does two getBoundingClientRect reads per frame; the finding's cited lines (3619-3660) are off by 10000 but the actual code at 13619-13660 matches, and it is correctly paused on visibilitychange and torn down on plant:selected, so low severity is apt.

---

<a id="r154"></a>
### R154. Per-second timeline ticker setInterval is never cleared and runs regardless of active tab

`app.js:5544-5562`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** The ticker fires every 1000ms for the life of the page and is never stored in a handle or cleared. It guards on document.hidden but NOT on whether the Gantt tab is the active view — so while the user is on the dashboard, master-data, admin, or labor tabs (the majority of the app), it still wakes every second, calls Timeline._items.get() once per past-zone id, allocates a filtered+mapped updates array, and (if non-empty) calls Timeline._items.update() which triggers a vis-timeline redraw of off-screen background items. At 70+ visible lines that is 70+ DataSet.get() calls plus an update/redraw every second behind an invisible timeline. It also runs a per-second linear Array.find over masterData.plants (5552) to resolve the alert horizon.

**Evidence.**

```
setInterval(() => {
  if (document.hidden) return; // skip ticker work while the tab is backgrounded
  if (!Timeline._items || !Timeline._pastZoneIds.length) return;
  const now  = new Date();
  const updates = Timeline._pastZoneIds
    .filter(id => Timeline._items.get(id))
    .map(id => ({ id, end: now }));
  if (Timeline._alertHorizonIds.length) {
    const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
```

**Suggested fix.** Gate the interval body on Timeline._ganttActive() in addition to document.hidden (early-return when the Gantt tab is not active), and resolve the plant row / horizon via a cached lookup rather than Array.find on every tick.

**Verification.** Lines 5544-5562 call setInterval(...,1000) with no stored handle, guard only document.hidden (not gantt-active), and run an Array.find over masterData.plants every tick at line 5552.

---

<a id="r155"></a>
### R155. Conflict-alert set computed twice per rebuild — inline set plus per-task _conflictIds() memo

`app.js:5660,5747-5775`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** rebuild() builds its own conflictIds Set (5747-5748), then for every scoped task calls _itemForTask (5766), which internally calls _conflictIds() and does .has(String(t.id)) to add the 'conflict-order' class (5660-5664). rebuild() then redundantly re-checks the SAME task against its OWN conflictIds set (5769) and re-parses/re-joins the className string to add a class _itemForTask already added. So per task there are two conflict-set lookups, plus a String(t.id) build, split(' '), filter, includes(), and join() — pure duplicate work O(scopedTasks). _conflictIds() is memoized on Store.alerts identity which does not change mid-rebuild, so both sets are identical and the inline block is redundant. At 70+ lines x dozens of orders this is wasted string allocation on the hottest render path.

**Evidence.**

```
// in _itemForTask (called per task):
const conflict = Timeline._conflictIds().has(String(t.id));
...
// in rebuild():
const conflictIds = new Set();
for (const a of Store.alerts) if (a.taskId != null) conflictIds.add(String(a.taskId));
...
for (const t of scopedTasks) {
  const item = Timeline._itemForTask(t);
  if (conflictIds.has(String(t.id))) {
    const cls = (item.className || '').split(' ').filter(Boolean);
    if (!cls.includes('conflict-order')) cls.push('conflict-order');
    item.className = cls.join(' ');
  }
```

**Suggested fix.** Drop the inline conflictIds Set and the 5769-5773 re-classification block entirely; _itemForTask already applies 'conflict-order' via the memoized _conflictIds(). If sharing one set is desired, pass it into _itemForTask as an optional arg instead of recomputing and re-splitting the className.

**Verification.** _itemForTask already adds 'conflict-order' via memoized _conflictIds() (lines 5660,5664), yet rebuild builds its own identical conflictIds set (5747-5748) and re-applies the same class via split/filter/includes/join (5769-5773), which is genuinely redundant; severity is overstated for a per-task string op.

---

<a id="r156"></a>
### R156. linesForSelectedPlant re-scans the global task array and re-filters every rebuild instead of using the maintained plant index

`app.js:5727,882-886`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** Every Timeline.rebuild() (coalesced to rAF but fired on every tasks:bulk / blocks / calendar / alerts:change event) calls linesForSelectedPlant(), which calls allLines() — that constructs a fresh Set by scanning Store.tasksArr (all tasks, all plants), then all calendar keys, all lineSettings keys, and all masterData.lines — then filters the result calling getPlantForLine() per line. So a plant switch or any bulk edit re-scans the ENTIRE global task array plus three key-spaces and runs an O(allLines) getPlantForLine filter just to get the lines for the one selected plant, even though Store already maintains a plant-scoped task index (_tasksByPlant) and a line->plant cache (_lineToPlant). At the 3,500-total-line scale, allLines() is an all-plants O(N) scan on the render-critical path.

**Evidence.**

```
// rebuild():
const plantLines = new Set(Store.linesForSelectedPlant());
// Store.linesForSelectedPlant():
linesForSelectedPlant() {
  const plant = this._state.selectedPlant;
  if (!plant) return [];
  return Store.allLines().filter(line => Store.getPlantForLine(line) === plant);
}
```

**Suggested fix.** Add a maintained plant->lines index in _rebuildPlantIndex, or derive lines for the selected plant from _tasksByPlant[plant] plus master-data lines filtered by the _lineToPlant cache, so linesForSelectedPlant() does not re-scan the global tasksArr and all key-spaces on every rebuild.

**Verification.** linesForSelectedPlant (882-886) calls allLines() (862-873) which scans the global Store.tasksArr plus calendar/lineSettings/masterData keyspaces then filters via getPlantForLine, and rebuild invokes it at line 5727 despite the _tasksByPlant index existing.

---

<a id="r157"></a>
### R157. Repeated string-parsed Date construction on the rebuild path (past-zone constant and per alert-cell)

`app.js:5804,5861-5862`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** The fixed past-zone epoch is re-parsed from a string on every rebuild even though it is a constant (string-to-Date parsing is markedly slower than the numeric constructor). The alert-cell loop additionally builds two string-parsed Dates per alert cell (5861-5862). Combined, the rebuild path performs repeated string-Date parsing scaling with visibleLines and alert-cell count. Minor individually but it sits on the coalesced-but-frequent rebuild path.

**Evidence.**

```
const pastStart = new Date('2000-01-01T00:00:00');
...
start: new Date(cell.dayKey + 'T00:00:00'),
end:   new Date(cell.dayKey + 'T23:59:59'),
```

**Suggested fix.** Hoist the fixed past-zone start to a module constant created once with the numeric Date constructor (new Date(2000,0,1)). For alert cells, construct day boundaries numerically (new Date(y,m,d) / +1 day) or parse each unique dayKey once rather than per cell.

**Verification.** Line 5804 re-parses the constant new Date('2000-01-01T00:00:00') each rebuild and lines 5861-5862 build two string-parsed Dates per alert cell; the micro-perf observation is accurate and correctly rated low.

---

<a id="r158"></a>
### R158. _refreshChipButtons rebuilds STATUS_LABEL and recomputes today/tomorrow keys twice on every call

`app.js:6384-6431`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** _refreshChipButtons runs from nearly every _onStore branch (6479) and from each chip handler. On each call it allocates a fresh STATUS_LABEL i18n object and calls Util.startOfDay(new Date()) twice (two separate fresh Dates) to compute today/tomorrow keys. Individually cheap but runs on every task:update / alerts:change / bulkUpdate event — avoidable repeated work in a per-event path.

**Evidence.**

```
const STATUS_LABEL = { late: t('ui.late'), conflict: t('ui.conflicting'), atrisk: t('ui.at_risk'), fixed: t('ui.fixed') };
...
const todayKey = Util.dayKey(Util.startOfDay(new Date()));
const tomorrowKey = Util.dayKey(new Date(Util.startOfDay(new Date()).getTime() + Config.MS_DAY));
```

**Suggested fix.** Compute startOfDay(new Date()) once and reuse it for both today and tomorrow keys; hoist STATUS_LABEL into a locale-memoized lookup invalidated on language change rather than rebuilding it each call.

**Verification.** Line 6407 allocates a fresh STATUS_LABEL object each call and 6414-6415 call Util.startOfDay(new Date()) twice; _refreshChipButtons runs on nearly every _onStore branch (6449/6479) — minor avoidable per-event work as described.

---

<a id="r159"></a>
### R159. redrawRows() on every alerts:change destroys/rebuilds all visible row DOM instead of refreshing the alert column

`app.js:6472-6478`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** refreshCells({columns:['id'], force:true}) already re-renders the alerts column (field 'id'). The subsequent redrawRows() with no params then tears down and rebuilds the DOM for ALL displayed rows — full layout/paint churn — solely to re-apply the row-level alert CSS class from _rowClass. alerts:change fires on every alert recompute (and per CLAUDE.md the intelligence layer degrades every scheduled recompute to a full all-lines pass), so this full redraw runs frequently. At the scale target this is the dominant table-render cost per recompute.

**Evidence.**

```
} else if (evt.type === 'alerts:change') {
  Table._api.refreshCells({ columns: ['id'], force: true });
  Table._api.redrawRows();
  if (Table._chipFilters.status === 'conflict' || Table._chipFilters.status === 'atrisk') {
    Table._api.onFilterChanged();
  }
}
```

**Suggested fix.** Drop the unconditional redrawRows(). To update row-level alert classes incrementally, scope a refresh to the specific rowNodes whose alert state changed (carried on the alerts:change event) via api.redrawRows({rowNodes:[...]}), rather than every visible row.

**Verification.** Duplicate of the alerts:change redrawRows finding — lines 6472-6478 confirm the unscoped redrawRows() runs after refreshCells already refreshes the 'id' column; real but it is the same defect reported twice.

---

<a id="r160"></a>
### R160. _onCellChanged re-parses an already-parsed Date returned by _DateTimeEditor.getValue

`app.js:6509-6515, 6763-6779`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** The start_date column's cell editor (_DateTimeEditor.getValue, 6777) already returns a Date via Util.parseDate. _onCellChanged then calls Util.parseDate(p.newValue) again on that Date object (6510), a redundant double-parse and a latent fragility if Util.parseDate does not robustly accept Date inputs. The editor's destroy() (6778) is also an empty no-op. Low impact but avoidable.

**Evidence.**

```
// _DateTimeEditor.getValue(): return Util.parseDate(this._input.value);
// _onCellChanged:
if (field === 'start_date') {
  const d = Util.parseDate(p.newValue);
  if (!d) { Toast.show(t('toast.invalid_date'), 'error'); ... return; }
  changes.start_date = Util.snap(d);
```

**Suggested fix.** Since the editor already returns a Date, branch on (p.newValue instanceof Date) in _onCellChanged to skip the second parse, or have the editor return the snapped value. Remove the empty destroy() (AG Grid tolerates its absence).

**Verification.** _DateTimeEditor.getValue returns Util.parseDate(...) i.e. a Date (6777) and _onCellChanged calls Util.parseDate(p.newValue) again (6510); parseDate (line 102) safely returns Date inputs so the 'latent fragility' is overstated, but the redundant call and empty destroy() (6778) are real.

---

<a id="r161"></a>
### R161. linesForSelectedPlant() recomputed multiple times per Dashboard render (O(allLines) each)

`app.js:7371, 7721, 882-885`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** linesForSelectedPlant() is O(allLines): allLines() unions tasks + calendars + lineSettings into a Set, then filter calls getPlantForLine per line. A single Dashboard.render() invokes it at least twice (KPIs and AlertSummary), each rebuilding the same plant-line Set from scratch within one synchronous render. The same plantRow .find scan over masterData.plants is also duplicated (7372 and 7722). At the 3,500-total-line scale, allLines is the system-wide union, so this is a full-system scan repeated per sub-panel per render even though selectedPlant has not changed mid-render.

**Evidence.**

```
_renderKPIs: const plantLines = new Set(Store.linesForSelectedPlant()); ... _renderAlertSummary: const plantLines = new Set(Store.linesForSelectedPlant());  // linesForSelectedPlant(){ ... return Store.allLines().filter(line => Store.getPlantForLine(line) === plant); }
```

**Suggested fix.** Compute plantLines (and plantRow / alert cutoff) once in render() and pass them into _renderKPIs and _renderAlertSummary, mirroring how the shared _matrix7 / _filtered are already threaded through. Alternatively memoize linesForSelectedPlant on (selectedPlant, Store._rev).

**Verification.** _renderKPIs (7371) and _renderAlertSummary (7721) each call Store.linesForSelectedPlant() — which at 882-885 runs allLines().filter(getPlantForLine) — within one render, and the plants.find scan is duplicated at 7372/7722.

---

<a id="r162"></a>
### R162. _renderLineStatus builds a separate uncached 1-day utilization matrix per dashboard render

`app.js:7670`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** _renderLineStatus passes the filtered tasks subset (non-null srcTasks) so this 1-day matrix also bypasses the memo and is rebuilt on every dashboard render, in addition to the 7-day matrix built in render(). It re-runs the same dailyCapacityHours/effectiveCapacityHours-per-cell capacity computation (with full blackout re-parse) for all lines for a single day. The inline comment in render() even notes 'The 1-day line-status matrix stays its own call.' Lower severity than the 7-day path (1 day vs 7) but identical structural waste.

**Evidence.**

```
`const matrix = Utilization.computeMatrix(now, 1, tasks);`
```

**Suggested fix.** Derive today's line status from the already-built 7-day _matrix7 (today is the first day column) passed down from render(), eliminating the second computeMatrix pass entirely.

**Verification.** _renderLineStatus (7656) uses Dashboard._filteredTasks() and passes it as non-null srcTasks to computeMatrix(now, 1, tasks) at 7670, bypassing the memo on every dashboard render as described.

---

<a id="r163"></a>
### R163. _gotoLine measures group heights with a getBoundingClientRect loop (forced reflow per row)

`app.js:7794-7805`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** To compute a scroll offset, this calls getBoundingClientRect() on every group element up to the target index inside a loop. getBoundingClientRect forces a synchronous layout flush; doing it repeatedly in a loop is a classic layout-thrash pattern (here reads only, so the browser can usually batch, but it still walks O(lineIdx) DOM nodes and re-reads layout). It also rebuilds allLines via a full Store.tasksArr scan + Set + sort on each click. This is a click handler (not a hot render path), so impact is low, but at 70+ groups it does measurable redundant work on each heatmap-cell click.

**Evidence.**

```
const allLines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort(); const lineIdx = allLines.indexOf(line); ... const groups = document.querySelectorAll('.vis-foreground .vis-group'); ... let targetY = 0; for (let i = 0; i < lineIdx && i < groups.length; i++) { targetY += groups[i].getBoundingClientRect().height; }
```

**Suggested fix.** Read offsetHeight once per group or, better, use the target group element's own offsetTop (groups[lineIdx].offsetTop) for a single layout read instead of summing rects in a loop. Cache the sorted allLines list (or derive line index from a map) rather than rescanning Store.tasksArr on every click.

**Verification.** At 7794-7805 allLines is rebuilt from a full Store.tasksArr scan+Set+sort per click and a loop calls getBoundingClientRect().height on each group up to lineIdx, exactly the layout-read loop described in a click handler.

---

<a id="r164"></a>
### R164. Lateness heatmap pre-allocates a full lines x days cell object for every line, including all-zero rows

`app.js:7827-7854, 7863-7869`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** The grid object is fully materialized as O(lines x horizonDays) objects up front (e.g. 70 lines x 28 days = 1,960 {lateHours,lateCount,tasks:[]} objects) even though the actual late-order data is sparse — most cells stay zero. Then lineTotals re-walks every cell again (a second O(lines x days) pass) just to compute per-line sums that could have been accumulated during the single task loop at 7841-7854. Finally every line is rendered into the HTML string (7901-7919) even though the comment says only ~9 are visible; there is no virtualization here, unlike _renderLineStatus/_renderHierarchy which use VirtualList. This is the only Dashboard sub-panel that builds the full grid eagerly and re-renders all rows as a string.

**Evidence.**

```
const allLines = [...new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort(); ... const cells = {}; for (const ln of allLines) { cells[ln] = {}; for (const dk of days) cells[ln][dk] = { lateHours: 0, lateCount: 0, tasks: [] }; } ... const lineTotals = allLines.map(ln => { let total = 0; for (const dk of days) total += cells[ln][dk].lateHours; return { ln, total }; });
```

**Suggested fix.** Accumulate per-line totals inside the existing task loop (7841-7854) instead of the separate lineTotals pass. Lazily create cells[ln][dk] only when a late order lands there (guard reads with optional chaining in the render loop, defaulting to 0). For the 50+ plant / 70+ line scale, consider rendering the heatmap rows through VirtualList like the sibling line-status panel rather than emitting every row into innerHTML.

**Verification.** Lines 7837-7839 eagerly allocate a {lateHours,lateCount,tasks} object for every line×day, 7863-7867 re-walk all cells in a separate lineTotals pass, and 7901-7919 render every row into the HTML string with no VirtualList — all as described, though impact is modest.

---

<a id="r165"></a>
### R165. TimelineNav reassigns canvas.width/height every render, forcing a full backing-store reallocation and clear

`app.js:8086-8093`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** Writing to canvas.width/canvas.height unconditionally on every render reallocates the canvas backing store and resets its context even when dimensions are unchanged. Since render() fires on every relevant store event and on every timeline rangechange (a high-frequency event during drag-pan, lines 8055-8056), this triggers a backing-store realloc per frame during pan/zoom. Reading offsetWidth/offsetHeight here is also a forced layout read; combined with the realloc it is avoidable thrash on a strip that redraws constantly.

**Evidence.**

```
const dpr = window.devicePixelRatio || 1;
const cssW = canvas.offsetWidth  || 800;
const cssH = canvas.offsetHeight || 42;
canvas.width  = cssW * dpr;
canvas.height = cssH * dpr;
const ctx = TimelineNav._ctx;
ctx.scale(dpr, dpr);
ctx.clearRect(0, 0, cssW, cssH);
```

**Suggested fix.** Only assign canvas.width/height when the computed pixel size actually changed (cache last w/h on TimelineNav and compare); otherwise just clearRect. Also reset the transform once at start (the code already calls setTransform(1,0,0,1,0,0) at the end at line 8190, so the per-render ctx.scale stacking is only safe because of that — but skipping the realloc avoids both costs).

**Verification.** Lines 8089-8090 unconditionally assign canvas.width = cssW*dpr and canvas.height = cssH*dpr on every render with no dimension-change comparison, forcing a backing-store realloc each frame during high-frequency rangechange events (8056); the suggested cache-and-compare fix is valid.

---

<a id="r166"></a>
### R166. TimelineNav.render recomputes line index per task via Array.indexOf — O(tasks × lines) on every Store change

`app.js:8154-8163`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** For each task, lineArr.indexOf does a linear scan of the line list. At the stated scale target (70+ lines/plant, thousands of orders) this is O(tasks × lines) per render, and render() is triggered on every tasks:bulk / task:update / calendar / blocks Store event (debounced only by a 50ms setTimeout). It is a minimap redraw so impact is bounded, but the indexOf is trivially replaceable with a precomputed Map for a linear pass.

**Evidence.**

```
const lineArr = [...new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();
const lineH = Math.max(2, Math.floor(cssH / (lineArr.length || 1)));
tasks.forEach(t => {
  const li = lineArr.indexOf(t.PRODUCTION_LINE || 'Unknown');
  ...
```

**Suggested fix.** Build a Map once: `const lineIdx = new Map(lineArr.map((l,i)=>[l,i]));` then `const li = lineIdx.get(t.PRODUCTION_LINE || 'Unknown');` inside the loop.

**Verification.** Lines 8154-8157 build lineArr then call lineArr.indexOf(...) for every task in the per-task loop, an O(tasks×lines) pattern trivially replaceable with a Map; correctly rated low for a debounced minimap redraw.

---

<a id="r167"></a>
### R167. TimelineNav.render does O(tasks x lines) lookups via lineArr.indexOf in the per-task draw loop

`app.js:8154-8163`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** For every task the code calls lineArr.indexOf(...), an O(lines) linear scan, inside a per-task loop. That makes the draw loop O(tasks x distinct-lines). At the stated scale target (3,500+ lines, thousands of orders) this is quadratic-ish work on the main thread, re-run on every render. render() is wired to fire on resize and on every tasks:bulk/tasks:bulkUpdate/task:update/calendar:change/blocks:change store event (debounced 50 ms via setTimeout at line 8064), and on every timeline rangechange/rangechanged (lines 8055-8056), so it runs extremely frequently during pan/zoom and edits.

**Evidence.**

```
const lineArr = [...new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();
const lineH = Math.max(2, Math.floor(cssH / (lineArr.length || 1)));
tasks.forEach(t => {
  const li = lineArr.indexOf(t.PRODUCTION_LINE || 'Unknown');
  const x1 = toX(t.start_date.getTime());
  const x2 = toX(t.end_date.getTime());
  const y  = li * lineH;
  ctx.fillStyle = lineColors[t.PRODUCTION_LINE || 'Unknown'] + 'cc';
  ctx.fillRect(x1, y, Math.max(1, x2 - x1), lineH);
});
```

**Suggested fix.** Build a lineIndex map once (const lineIndex = new Map(lineArr.map((l,i)=>[l,i]))) and replace lineArr.indexOf(...) with lineIndex.get(line). This turns the per-task lookup into O(1), reducing the loop to O(tasks).

**Verification.** Same code at 8154-8163 as the prior finding — lineArr.indexOf inside the per-task loop is genuinely O(tasks×lines); this is a duplicate of the low-severity finding and 'high' is overstated for a small debounced canvas strip.

---

<a id="r168"></a>
### R168. GanttFilter._doApply rebuilds each item's className via split/filter/join for every scoped task on every filter apply

`app.js:8442-8452`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** For every task in the plant scope, _doApply does a Timeline._items.get(id) DataSet lookup plus a string split/filter/join to recompute the className. This runs on a 60 ms debounce (line 8469) and is triggered on text input, color/form toggles, plant:selected and tasks:bulk/bulkUpdate events. The work is O(scoped-tasks) with per-task string allocation; at 70+ lines x many orders per plant it is repeated allocation churn. dimCount is computed but only used implicitly via `active` for the badge — note the actual badge count `n` is recomputed separately at lines 8459-8461, so dimCount is effectively dead (assigned, never read).

**Evidence.**

```
for (const task of scoped) {
  if (!task.start_date || !task.end_date) continue;
  const id = String(task.id);
  const item = Timeline._items.get(id);
  if (!item) continue;
  const shouldDim = active && !GanttFilter.matches(task);
  if (shouldDim) dimCount++;
  const baseClass = (item.className || '').split(' ').filter(c => c !== 'dimmed').join(' ');
  const newClass  = shouldDim ? baseClass + ' dimmed' : baseClass;
  if (newClass !== item.className) updates.push({ id, className: newClass });
}
```

**Suggested fix.** Use a regex-free toggle (e.g. precompute baseClass once if className rarely contains other dynamic classes, or store the base class on the item) and remove the unused dimCount accumulator (it is incremented at line 8448 but never read).

**Verification.** Lines 8442-8451 loop over every scoped task doing Timeline._items.get plus a split/filter/join className recompute; dimCount is incremented at 8448 and never read (the badge count `n` is recomputed independently at 8459-8461), confirming both the per-task allocation churn and the dead accumulator.

---

<a id="r169"></a>
### R169. Optimize-preview KPI path rebuilds the utilization matrix twice, bypassing the memo

`app.js:8926, 8935`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** Per CLAUDE.md, Util.scheduleKpis calls Utilization.computeMatrix, whose memo only hits on the Store-backed global path (srcTasks === null). Here both pre and post KPIs pass non-null filtered subsets (snapshot.filter(inScope) and postTasks), so each call rebuilds the full per-line per-day matrix from scratch — O(lines x days) — done twice per optimize preview. At 70+ lines x 14 days this is non-trivial synchronous main-thread work on the rAF-after-rAF path while the user waits on the spinner.

**Evidence.**

```
const preKpis = Util.scheduleKpis(snapshot.filter(inScope), 14);
...
const postKpis  = Util.scheduleKpis(postTasks, 14);
```

**Suggested fix.** Share a single computeMatrix pass between pre/post where feasible, or extend the memo key to cover scoped subsets (scoped line set + window + Store._rev). At minimum document that the filtered path is intentionally unmemoized so it is not mistaken for the cached global path.

**Verification.** Lines 8926 and 8935 both call Util.scheduleKpis with non-null filtered subsets (snapshot.filter(inScope) and Store.tasksByPlant(plant).filter(inScope)); per CLAUDE.md the computeMatrix memo only hits on the Store-backed global path (srcTasks === null), so each filtered call rebuilds the matrix, twice per preview.

---

<a id="r170"></a>
### R170. Hover-preview card linearly scans all alerts per render

`app.js:9576`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** renderCard() runs Store.alerts.filter(...) — a full linear scan with a String() coercion per alert — each time the 500ms hover card materializes for an item, and again for every re-hover of the same item. The alert list grows with schedule size and overload/overlap density; at the scale target the array can be large, and this is on a hot hover path.

**Evidence.**

```
const rel = Store.alerts.filter(a => String(a.taskId) === String(id));
```

**Suggested fix.** Index alerts by taskId (Map<taskId, alert[]>) when Store.alerts is rebuilt and look it up in renderCard, instead of filtering the whole list on every hover.

**Verification.** Line 9576: renderCard runs Store.alerts.filter(a => String(a.taskId) === String(id)) — a full linear scan with String coercion per alert — each time the hover card materializes; whether this is a meaningful cost depends on alert-list size at scale, but the unindexed scan on the hover path is real.

---

<a id="r171"></a>
### R171. Hover-preview registers a document-level keydown listener that runs on every keystroke for the page lifetime

`app.js:9636-9638`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** _installHoverPreview adds a document-level keydown listener (plus container mousedown/wheel) wired to the local `hide` closure. install() is idempotent (guarded by this._installed), so under normal boot it fires once — not a true leak — but the keydown handler stays attached to `document` for the page lifetime with no teardown. It is in addition to the separate document keydown handler at line 9428 (_onKeyDown). Every keystroke (including while another tab is active and the Gantt is off-screen) runs this extra closure, which calls clearTimeout and queries the DOM via card. Minor wasted work per keystroke and an un-removable closure capturing card/showTimer.

**Evidence.**

```
container.addEventListener('mousedown', hide);
container.addEventListener('wheel', hide, { passive: true });
document.addEventListener('keydown', hide);
```

**Suggested fix.** Early-return in `hide` when card.hidden is already true (cheap no-op), and/or attach the keydown listener lazily only while a card is visible, or scope it to the container rather than document. Keep install() the single call site.

**Verification.** Line 9638 attaches `document.addEventListener('keydown', hide)` with no teardown; hide() (9600-9605) runs clearTimeout and sets card.hidden on every keystroke for the page lifetime, in addition to the separate _onKeyDown handler, though install() idempotency means it is one listener, not a leak — minor wasted work as described.

---

<a id="r172"></a>
### R172. _navigateSelection recomputes the full sorted distinct-line list on every arrow keypress, unused for Left/Right

`app.js:10219-10221`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** Every Arrow keypress on a single selection rebuilds the distinct sorted line list by scanning all of Store.tasksArr (O(n) filter + map + Set + sort). For ArrowLeft/Right this allLines value is computed but never used (only the per-line peers list at 10224 is consulted), so the work is fully wasted on horizontal navigation. At the 3,500-line target, holding an arrow key to walk the schedule re-scans the entire task array on each key repeat.

**Evidence.**

```
const allLines = [...new Set(Store.tasksArr
  .filter(t => t.PRODUCTION_LINE)
  .map(t => t.PRODUCTION_LINE))].sort();
```

**Suggested fix.** Move the allLines computation inside the ArrowUp/ArrowDown branch (unused for Left/Right). Better: derive the line list from a value cached on Store._rev rather than rescanning tasksArr per keypress.

**Verification.** Lines 10219-10221 build allLines (filter+map+Set+sort over all of Store.tasksArr) unconditionally before the key branch, but the ArrowLeft/ArrowRight branch (10223-10229) only uses the per-line `peers` list and never references allLines, so the work is wasted on horizontal navigation.

---

<a id="r173"></a>
### R173. Permanent document-level mouseover listener for help tooltips stays bound for the page lifetime, even when the admin tab is closed

`app.js:11288-11294`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** This is attached once in AdminCockpit.init() but bound to document for the entire session — it fires on every mouseover anywhere in the app (timeline, grid, dashboard), running e.target.closest('.adm-help') against the ancestor chain on each event, regardless of whether the admin tab is even visible. The .adm-help help icons only exist in the admin DB-deep pane, so for ~99% of the app's runtime this handler does pointless closest() walks on a hot input path (the Gantt/grid generate heavy pointer traffic). It also calls getBoundingClientRect() (forced layout) on match. Listener is never removed and never gated on admin-tab visibility.

**Evidence.**

```
document.addEventListener('mouseover', e => {
  const el = e.target.closest?.('.adm-help');
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--tip-x', `${r.left + r.width / 2}px`);
  el.style.setProperty('--tip-y', `${r.top}px`);
});
```

**Suggested fix.** Scope the listener to the admin pane container (e.g. attach to #admin-tab or #admin-db-deep) instead of document, or gate the body with an early `if (AdminCockpit._activeSub !== 'overview') return;`. Even simpler: drive the tooltip position purely from CSS (position the tip relative to the .adm-help element) and drop the JS listener entirely.

**Verification.** Lines 11288-11294 attach a document-level mouseover listener inside init() that runs `e.target.closest('.adm-help')` on every mouseover app-wide, never removed and never gated on admin-tab visibility — confirmed; severity low is appropriate as closest() on a miss is cheap.

---

<a id="r174"></a>
### R174. _updatePurgeCount scans the entire Store.tasksArr on every flatpickr date change

`app.js:11835-11846, 11852-11862`  ·  **LOW**  ·  _performance_  ·  confidence: medium  ·  **⚖️ needs-human-judgment**

**Why it matters.** _updatePurgeCount is registered as the onChange handler for both purge date pickers and also called eagerly in _renderPurgeMeta. Each invocation does a full linear filter over Store.tasksArr. Today tasksArr is the plant-scoped order set, but the count is computed client-side over every loaded order on each keystroke/date-pick. As loaded order volume grows toward enterprise scale this becomes a noticeable per-interaction cost for a purely advisory count. Minor today, but it scales linearly with order count and runs on every picker interaction.

**Evidence.**

```
_updatePurgeCount() {
  const start = AdminCockpit._fpPurgeStart?.selectedDates[0];
  const end   = AdminCockpit._fpPurgeEnd?.selectedDates[0];
  ...
  const count = (Store.tasksArr || []).filter(t => t.end_date && t.end_date >= start && t.end_date <= endOfDay).length;
  ...
}
// wired as flatpickr onChange for BOTH start and end pickers (lines 11854, 11858)
// and called once more directly at 11863
```

**Suggested fix.** Acceptable at current scale; if order volume grows, debounce the onChange (e.g. 150ms) so dragging across the calendar does not recount per intermediate date, and/or memoize on (startMs,endMs,Store._rev).

**Verification.** Line 11842 does a full linear filter over Store.tasksArr and is wired as onChange for both pickers (11854/11858) plus called at 11863 — code is exactly as described, but whether the per-interaction cost matters depends on plant-scoped order volume at runtime, which is not determinable from source.

---

<a id="r175"></a>
### R175. PlantSelector dropdown rebuilds entire DOM and rebinds N listeners on every keystroke

`app.js:13497-13510`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** _renderDropdown is called on every 'input' event (each keystroke) and on every focus. It rebuilds the full options list via innerHTML, then queries all rendered .hps-option nodes and attaches a fresh mousedown listener to EACH one. At the documented scale target of 50+ plants this is a full string-build + DOM-parse + O(N) querySelectorAll + O(N) addEventListener on every character typed. The old listeners are discarded with the innerHTML overwrite (no leak), but the per-keystroke churn is wasted work that grows linearly with plant count and is precisely the kind of full re-render the scale guidance warns against. _highlightActive (13513-13517) compounds this by running querySelectorAll('.hps-option') again on the same set immediately after.

**Evidence.**

```
PlantSelector._dropdown.innerHTML = PlantSelector._filtered.map((p, i) => {
  const isSel = p === sel;
  return `<div class="hps-option${isSel ? ' selected' : ''}" role="option" data-plant="${p}" data-idx="${i}">...`;
}).join('');
PlantSelector._activeIdx = Math.max(0, PlantSelector._filtered.indexOf(sel));
PlantSelector._highlightActive();
PlantSelector._dropdown.querySelectorAll('.hps-option').forEach(el => {
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    PlantSelector._select(el.dataset.plant);
  });
});
```

**Suggested fix.** Bind a single delegated 'mousedown' listener on PlantSelector._dropdown once in init() (read e.target.closest('.hps-option').dataset.plant), instead of attaching one listener per option on every render. For very large lists, also debounce the input handler and/or cap rendered rows, and reuse the cached node list in _highlightActive rather than re-querying.

**Verification.** _renderDropdown at 13497-13510 rebuilds the full options innerHTML then querySelectorAll('.hps-option') and addEventListener('mousedown') per option on every input/focus, with _highlightActive at 13514 re-querying the same nodes; this is O(N) per-keystroke churn that grows with the documented 50+ plant target.

---

<a id="r176"></a>
### R176. _applyFilter reads tr.textContent for every row on every keystroke (no debounce, full layout-touching scan)

`app.js:14318-14322, 14835-14842`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** On every input event the handler walks all <tr> nodes and reads tr.textContent (which forces serialization of each row's subtree, and for contentEditable/select cells touches layout-affecting state) then toLowerCase()s it. There is no debounce and no precomputed search index, so typing in a multi-thousand-row table runs O(rows × cellText) per keystroke on the main thread.

**Evidence.**

```
searchInput.oninput = () => _applyFilter(table, searchInput.value.toLowerCase());
...
function _applyFilter(table, query) {
  const tbody = document.getElementById(`md-tbody-${table}`);
  if (!tbody) return;
  tbody.querySelectorAll('tr').forEach(tr => {
    const text = tr.textContent.toLowerCase();
    tr.hidden = query ? !text.includes(query) : false;
  });
}
```

**Suggested fix.** Precompute a lowercased searchable string per row once at render time (store on tr.dataset or in a parallel array keyed by rowKey) and compare against that in the filter. Debounce the oninput handler (~150 ms) to coalesce keystrokes.

**Verification.** oninput at 14322 calls _applyFilter with no debounce, and 14838-14840 walks every tr reading tr.textContent.toLowerCase() per keystroke with no precomputed index.

---

<a id="r177"></a>
### R177. _appendRow recomputes added/deleted/dirty membership per row via linear scan during full-table render

`app.js:14425-14430, 14418`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** _renderTable iterates allRows ([...rows, ...added]) and calls _appendRow for each. Inside, isNew does state.added.some(...) — an O(added) scan with a _rowKey map+join per element — so the per-render cost of the new-row check alone is O(allRows × added). dirty/deleted use Map/Set (cheap), but the added scan plus the repeated _rowKey allocation per cell adds up at thousands of rows. The whole grid has no virtualization, so all N rows are materialized into the DOM regardless.

**Evidence.**

```
allRows.forEach(row => _appendRow(tbody, table, columns, row));
...
const key = _rowKey(table, row);
const isNew = state.added.some(r => _rowKey(table, r) === key);
```

**Suggested fix.** Compute a Set of added row keys once per render and pass it down (or test membership against the Set) instead of state.added.some per row. Longer term, route the grid through the existing VirtualList infrastructure so only on-screen rows are built — full DOM materialization of thousands of rows is the dominant cost.

**Verification.** 14418 iterates allRows calling _appendRow, which at 14428 does state.added.some(r => _rowKey(...)===key) — an O(added) scan with _rowKey allocation per element — and there is no virtualization so all rows are materialized.

---

<a id="r178"></a>
### R178. cascade-preview fetched twice for the same delete (once on row delete, again on save)

`app.js:14696-14711, 14769-14791`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** Deleting a subnetwork/plant row issues a cascade-preview POST to show the confirm dialog. The deletion is then staged (state.deleted) and the identical cascade impact is recomputed via a second cascade-preview POST in _save before the bulk write. For a batch of staged deletes this is a redundant round-trip of an aggregate query that already ran per row at delete time. The double-confirm is also a redundant UX prompt.

**Evidence.**

```
// in _deleteRow:
const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, { method:'POST', ... body: JSON.stringify({ deletes: [deletePayload] }) })
// in _save:
if (deletes.length && (table === 'subnetworks' || table === 'plants')) { ... const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, { ... body: JSON.stringify({ deletes }) }) ... }
```

**Suggested fix.** Cache the cascade-preview result on the staged delete entry (keyed by rowKey) when _deleteRow runs, and in _save reuse the cached totals unless the staged set changed — only re-query if there are staged deletes without a cached preview. This removes the duplicate server round-trip and the second confirmation for already-confirmed rows.

**Verification.** Same code as the dual-confirm finding: a cascade-preview POST in _deleteRow (14698) and a second identical POST in _save (14771) for the staged deletes — a redundant aggregate round-trip.

---

<a id="r179"></a>
### R179. _save full-reloads the active table plus refetches plants and production_lines on every save (no incremental update)

`app.js:14807-14825`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** After any save (even a single-cell edit), the code discards the table cache, refetches the full active table, AND unconditionally refetches the entire plants and production_lines tables (full-list queries with no plant/line filtering). The CLAUDE.md scale roadmap explicitly flags unfiltered full-list master-data queries as untenable at 50+ plants / 3,500+ lines. The bulk endpoint already returns inserted/updated/deleted counts, so the client could apply the change locally instead of three full refetches.

**Evidence.**

```
delete _cache[table];
await _loadAndRender(table);

// Refresh master-data in Store so Hierarchy/ProdLines stay in sync.
Promise.all([
  fetch(`${API}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
  fetch(`${API}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
]).then(([pData, lData]) => { ... Store._rebuildPlantIndex(); ...
```

**Suggested fix.** Apply the saved upserts/deletes to the in-memory cache from the bulk response and re-render incrementally instead of delete _cache + _loadAndRender. Refetch plants/production_lines only when those specific tables were edited, and scope the refetch with ?plant= when a plant context is active rather than pulling the global list.

**Verification.** 14807-14813 does delete _cache[table]; await _loadAndRender(table) then unconditionally refetches the full plants and production_lines tables (no plant/line filter) on every save regardless of which table or fields changed.

---

<a id="r180"></a>
### R180. apply_color_merge all-plants branch loops over every plant's wheel applying a full-column boolean mask per plant (O(plants x rows))

`brain.py:449-453`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** When plant is None, the merge iterates over every entry in PLANT_CWS and for each computes a full-length boolean mask (df['PLANT_SAFE'] == plant_key), calls mask.any(), then does a masked .loc assignment. This is O(num_plant_wheels x num_rows). At the documented target of 50+ plants this becomes 50+ full-frame passes per call. The /tasks path correctly passes plant= (taking the cheap scoped branch at lines 444-448), so this is confined to the plant=None callers (diagnostics/unscoped tooling), which is why severity is low — but it is the exact full-list-over-all-plants anti-pattern CLAUDE.md warns against, and a single groupby('PLANT_SAFE') with a per-group map would be one pass instead of N.

**Evidence.**

```
else:
    for plant_key, cw_map in PLANT_CWS.items():
        mask = df["PLANT_SAFE"] == plant_key
        if mask.any():
            df.loc[mask, "ORDER_Y"] = df.loc[mask, "COLOR"].map(cw_map)
```

**Suggested fix.** Replace the per-plant loop with a single vectorized mapping: build a combined lookup keyed by (PLANT_SAFE, COLOR) or use df.groupby('PLANT_SAFE')['COLOR'].transform via a dict-of-dicts map, so the assignment is one pass over the frame regardless of plant count.

**Verification.** Lines 449-453 loop over every PLANT_CWS entry computing a full-length mask + masked .loc per plant; this is confined to plant=None callers since /tasks takes the scoped branch (444-448), so low severity is appropriate.

---

<a id="r181"></a>
### R181. Paged /tasks requests fire a second full COUNT(*) query for meta.total on every request

`brain.py:733`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** Whenever limit or offset is supplied (paging=True), the handler issues an additional SELECT COUNT(*) FROM orders ... query (db.py count_orders, lines 180-195) on top of the main query_orders SELECT — a second DB round trip and a second scan of the plant/line scope per request. The empty-result branch does the same (line 660). For a tooling client paging through a plant, every page costs two queries instead of one. COUNT(*) over a large plant scope without the LIMIT is also the more expensive of the two. The full count rarely changes between adjacent pages, so recomputing it on every page is redundant.

**Evidence.**

```
meta["total"] = db.count_orders(plant=plant, line=line) if paging else len(data)
```

**Suggested fix.** Compute the total once on the first page (offset is None or 0) and have clients carry it forward, or use a windowed COUNT(*) OVER () in the main query so the total comes back with the rows in a single round trip, or only return total when offset==0. Avoid the unconditional second query on every paged call.

**Verification.** Line 733 (and 660 in the empty branch) calls db.count_orders when paging=True, issuing a second SELECT COUNT(*) over the plant/line scope (db.py 180-195) on top of query_orders on every paged request.

---

<a id="r182"></a>
### R182. GET /color-wheel/{plant} re-reads and re-parses the xlsx from disk on every request despite the in-memory PLANT_CWS cache

`brain.py:1020-1040`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** The parsed wheel for each plant is already held in the module-level PLANT_CWS cache as a {COLOR: ORDER_Y} dict (populated at startup, on /reload, and inline on every upload/delete via _reload_one_plant_wheel). This GET endpoint ignores that cache and does a fresh, blocking pd.read_excel + db.clean + dtype coercion on every call — a CPU-bound Excel parse on the event loop (this handler is NOT offloaded to run_in_threadpool, unlike the upload path which deliberately offloads the same pd.read_excel because it is 'blocking/CPU-bound'). The ColorWheelViewer modal can call this repeatedly. The cached dict already contains exactly the (color, order_y) pairs needed for the entries list.

**Evidence.**

```
def get_color_wheel(plant: str):
    path = _cw_path(plant)
    if not os.path.isfile(path):
        raise HTTPException(...)
    try:
        cw_df = db.clean(pd.read_excel(path))
        if "ORDER" in cw_df.columns and "ORDER_Y" not in cw_df.columns:
            cw_df = cw_df.rename(columns={"ORDER": "ORDER_Y"})
        cw_df["COLOR"] = cw_df["COLOR"].astype(str).str.upper().str.strip()
        cw_df["ORDER_Y"] = pd.to_numeric(cw_df["ORDER_Y"], errors="coerce").fillna(999999)
        entries = (cw_df.sort_values("ORDER_Y")[["COLOR", "ORDER_Y"]]...)
```

**Suggested fix.** Serve from PLANT_CWS: cw_map = PLANT_CWS.get(_cw_safe_name(plant)); if present, build entries = sorted([{"color": c, "order_y": o} for c,o in cw_map.items()], key=lambda e: e["order_y"]) and skip the disk read entirely. Fall back to the disk parse only on a cache miss, and offload that parse with run_in_threadpool to match the upload path.

**Verification.** Lines 1020-1040 call pd.read_excel + db.clean + dtype coercion synchronously on the event loop (no run_in_threadpool), ignoring the module-level PLANT_CWS dict that already holds the parsed {COLOR:ORDER_Y} pairs, unlike the upload path which offloads the same parse at 979.

---

<a id="r183"></a>
### R183. list_color_wheels does a regex sanitize per (file x meta-key) comparison to cross-reference stale meta

`brain.py:1077-1083`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** For every color-wheel file on disk the code runs any(_cw_safe_name(p) == safe_key for p in meta), and _cw_safe_name applies a regex substitution (re.sub) to each meta plant key on every comparison. That is O(files x meta_keys) with a regex per inner step. At the 50+ plant scale target this is still a small set, so impact is minor, but the sanitized keys can be precomputed once instead of re-deriving them for each file. Low severity, flagged for completeness.

**Evidence.**

```
if os.path.isdir(COLOR_WHEEL_DIR):
        for fname in os.listdir(COLOR_WHEEL_DIR):
            if not (fname.startswith("color_wheel_") and fname.endswith(".xlsx")):
                continue
            safe_key = fname[len("color_wheel_"):-len(".xlsx")]
            if not any(_cw_safe_name(p) == safe_key for p in meta):
                meta[safe_key] = {"uploaded_at": None, "row_count": None, "filename": fname}
```

**Suggested fix.** Precompute the set of sanitized meta keys once before the loop: safe_meta_keys = {_cw_safe_name(p) for p in meta}; then test `if safe_key not in safe_meta_keys`. Turns O(files x keys) with per-step regex into O(files + keys).

**Verification.** Line 1082 runs `any(_cw_safe_name(p) == safe_key for p in meta)` inside the per-file loop, and _cw_safe_name applies re.sub (302) to each meta key on every inner comparison, giving O(files x keys) with a regex per step instead of precomputing the sanitized key set once.

---

<a id="r184"></a>
### R184. GET /diagnostics/db runs eight DB queries serially, each checking out its own pool connection

`brain.py:1314-1332`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** This dict is built by calling eight separate db.* functions sequentially. Each (per db.py's per-function pattern) opens its own pool connection and runs catalog/pg_stat_statements queries — some of which (table bloat, index usage, slow-query aggregation) are themselves heavy. Total latency is the sum of eight serial round-trips plus eight connection checkouts. It is a synchronous handler so it runs in the threadpool and won't block the event loop, and the docstring notes it is 'loaded on demand, not polled', which caps the impact — but the serial fan-out makes the Admin Cockpit DB panel slow to load and briefly consumes a pool slot per call. Not a correctness issue, only latency.

**Evidence.**

```
def get_diagnostics_db():
    return {
        "pool":         db.get_pool_stats(),
        "server":       db.get_db_server_info(),
        "tables":       db.get_db_table_stats(),
        "connections":  db.get_db_connection_activity(),
        "locks":        db.get_db_lock_waits(),
        "indexes":      db.get_db_index_usage(),
        "slow_queries": db.get_db_slow_queries(),
        "sequences":    db.get_db_sequence_health(),
        "fetched_at":   pd.Timestamp.utcnow().isoformat(),
    }
```

**Suggested fix.** If these become slow in practice, fan the eight reads out concurrently (asyncio.gather over run_in_threadpool wrappers, or a thread pool) and/or batch the cheap ones (server info, pool stats, sequence health) into a single connection/transaction so the panel populates in one round-trip group instead of eight serial ones.

**Verification.** Lines 1322-1332 call eight separate db.* functions sequentially in one dict literal; each opens its own pool connection per db.py's pattern, so latency is the sum of eight serial round-trips, though the on-demand docstring caps real impact.

---

<a id="r185"></a>
### R185. Admin diagnostics issue unbounded catalog scans (get_db_table_stats / get_db_index_usage have no LIMIT)

`db.py:586-607`  ·  **LOW**  ·  _performance_  ·  confidence: low

**Why it matters.** get_db_table_stats returns one row per user table with no LIMIT, calling pg_size_pretty(pg_total_relation_size(relid)) per row, and the Python comprehension recomputes needs_vacuum/needs_analyze per table. get_db_index_usage (lines 720-734) has the same shape: one unbounded row per index. At the schema's current ~10 tables and modest index count this is negligible, hence low severity. Flagging only because the AdminCockpit DB console invokes these together and other diagnostics in this file already bound output (LIMIT 15 in get_db_connection_activity, LIMIT 20 in get_db_lock_waits) — the inconsistency is the smell.

**Evidence.**

```
cur.execute("""
    SELECT
        relname,
        n_live_tup,
        n_dead_tup,
        ...
        pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
        n_mod_since_analyze
    FROM pg_stat_user_tables
    ORDER BY n_dead_tup DESC
""")
rows = cur.fetchall()
```

**Suggested fix.** If the AdminCockpit DB tab ever feels slow at scale, add a LIMIT (e.g. top 50 by dead_tup / idx_scan) to get_db_table_stats and get_db_index_usage to match the existing LIMIT-bounded diagnostics. No change required at current scale.

**Verification.** get_db_table_stats (586-607) and get_db_index_usage (720-734) both ORDER BY with no LIMIT, returning one row per table/index with per-row pg_size_pretty; negligible at ~10 tables, correctly flagged low severity.

---

<a id="r186"></a>
### R186. bulk_apply rebuilds identical composed SQL for every upsert/delete row instead of batching

`master_data.py:227-284`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** Both loops re-compose the same SQL fragments (the DELETE WHERE clause is identical on every iteration since `keys` is constant; the INSERT statement is identical for every row that shares the same column set) and issue one separate `cur.execute` round-trip per row. For a paste-driven bulk edit of master data (the documented Manage Data Tables grid use case) this is O(rows) round-trips and O(rows) redundant SQL composition. The DELETE WHERE clause in particular is invariant across the whole loop yet rebuilt each pass. The labor-plan upserts in this same file already use `cur.executemany` (lines 625, 698), so batching is the in-codebase idiom this function diverges from.

**Evidence.**

```
for d in deletes:
    where = sql.SQL(" AND ").join(
        sql.SQL("{} = {}").format(sql.Identifier(k), sql.Placeholder())
        for k in keys
    )
    ...
    cur.execute(sql.SQL("DELETE FROM {} WHERE {}").format(sql.Identifier(table), where), vals)
    deleted += cur.rowcount

# --- Upserts ---
for row in upserts:
    col_names = [c for c in row if c not in SYSTEM_COLUMNS]
    ...
    cur.execute(q, [row[c] for c in col_names])
    row_result = cur.fetchone()
```

**Suggested fix.** Hoist the invariant DELETE WHERE composition out of the loop and use a single ANY/tuple-IN delete for all keys at once. For upserts, group rows by their column-name signature and use `cur.executemany` per group (the `RETURNING (xmax = 0)` inserted/updated split can be replaced by comparing pre/post counts, or by reading rowcount semantics). This removes per-row Python SQL composition and reduces round-trips.

**Verification.** Lines 229-239 recompose the invariant DELETE WHERE clause and execute per-row, and lines 242-284 execute one INSERT per upsert row, while the labor-plan functions in the same file use cur.executemany (lines 625, 698); correctedSeverity low because the RETURNING (xmax=0) inserted/updated split is intentional and batching it is a non-trivial refactor for a paste-grid path that is not on the hot read path.

---

<a id="r187"></a>
### R187. upsert_labor_plan / upsert_labor_plan_line use O(n^2) list-membership to split delete vs upsert

`master_data.py:609-611`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** `c not in to_delete` is a linear scan of the `to_delete` list for every element of `valid`, making the partition O(len(valid) * len(to_delete)) — quadratic in the worst case (when most cells are deletes). The same pattern is duplicated in upsert_labor_plan_line at lines 682-684. Labor-plan grids are line x day matrices; at the 70-lines-per-plant target over a multi-week horizon a single save payload can be hundreds-to-thousands of cells, where the quadratic membership test becomes measurable. The partition is also semantically fragile: `c not in to_delete` compares dicts by value, so two distinct cells with identical contents would be mis-partitioned.

**Evidence.**

```
valid = [c for c in cells if c.get("pl_group") and c.get("period")]
to_delete = [c for c in valid if c.get("avail_hours") is None or c.get("avail_hours") == ""]
to_upsert = [c for c in valid if c not in to_delete]
```

**Suggested fix.** Partition in a single pass: iterate `valid` once and append each cell to either `to_delete` or `to_upsert` based on the avail_hours predicate, instead of building `to_delete` first and then filtering `valid` against it. This is O(n) and avoids the value-equality `in` check entirely.

**Verification.** Lines 609-611 (and duplicate at 682-684) compute to_upsert via `c not in to_delete`, a linear scan of to_delete per element of valid, which is O(len(valid)*len(to_delete)); low severity is appropriate.

---

<a id="r188"></a>
### R188. Opening the Command Palette runs Utilization.computeMatrix synchronously on the main thread (NeedsEngine._readState) — main-thread stall at scale

`nimbus-intelligence.js:416-436, 1138-1145, 597-599`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** Every Ctrl/Cmd+K open with an empty query calls NeedsEngine.topNeeds, which (when _cachedState is null — and it is invalidated on every Store.publish at line 702 and every selection change at line 751) calls _readState(). _readState runs Utilization.computeMatrix(now,7) on the main thread. Per CLAUDE.md, computeMatrix is the heavy capacity engine and is normally worker-offloaded/pre-warmed; this synchronous, all-lines call bypasses the worker entirely. With srcTasks omitted it can hit the Store-backed memo, but the memo is keyed (startMs, days, Store._rev) and Store._rev bumps on every mutation, so during active editing the palette open recomputes the full matrix synchronously. At the 50+ plants / 3,500-line target this blocks the main thread on the very interaction that is supposed to feel instant.

**Evidence.**

```
open() {
  if (!CommandPalette._panel) return;
  if (!CommandPalette._index) CommandPalette._buildIndex();
  CommandPalette._search('');   // empty query -> NeedsEngine.topNeeds(4) -> _readState()
  ...
}
...
_readState() {
  ...
  const now = Util.startOfDay(new Date());
  const matrix = Utilization.computeMatrix(now, 7);   // synchronous, all lines
  for (const [line, lineData] of Object.entries(matrix)) { ... }
```

**Suggested fix.** Scope the matrix to the selected plant's lines (Store.selectedPlant is required to open the palette anyway), or compute topNeeds' utilization factor off the prewarmed worker matrix / a cached value, and render the palette immediately with needs filled in asynchronously. At minimum, cache _readState's util result keyed by Store._rev so reopening without edits is free.

**Verification.** open()→_search('')→topNeeds rebuilds _cachedState (598) when null, and _readState calls Utilization.computeMatrix(now,7) synchronously over all lines (427); _cachedState is nulled on every Store.publish (702) and selection change (751), so during active editing palette-open recomputes the full matrix on the main thread.

---

<a id="r189"></a>
### R189. NeedsEngine intent-bank literal (7 entries + closures) is rebuilt on every keystroke in need:/! mode

`nimbus-intelligence.js:614-698`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** resolveIntent is invoked from _search on every debounced input event while the query starts with 'need:' or '!'. Each call re-allocates the entire 7-entry intent bank with its run() closures. Unlike NeedsEngine._buildBank (cached into _bank at init, line 701), this bank is a local literal rebuilt per call -- needless per-keystroke allocation and inconsistent with the cached _bank pattern in the same module.

**Evidence.**

```
resolveIntent(text) {
  const q = text.trim().toLowerCase();
  const bank = [ { keywords:['freeze',...], label:..., run(){...} }, ... 7 entries with closures ... ];
  const results = bank.filter(intent => intent.keywords.some(kw => q.includes(kw)));
  ...
}
```

**Suggested fix.** Hoist the intent bank to a module-level constant built once in init() (like _bank); resolveIntent should only filter/map over it.

**Verification.** resolveIntent (614-686) declares the 7-entry bank as a local literal with run() closures rebuilt on each call, inconsistent with NeedsEngine._bank cached once in init() (701); it is the per-keystroke intent path, so this is needless allocation as described.

---

<a id="r190"></a>
### R190. Confidence recompute is triggered twice per mutation (Store subscription + Alerts.recompute monkey-patch)

`nimbus-intelligence.js:1293-1308`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** A typical edit path mutates Store (firing task:update / tasks:bulkUpdate -> _recomputeDebounced) AND then calls Alerts.recompute/scheduleRecompute (the patched recompute also calls _recomputeDebounced). Both schedule the same 400ms-debounced _recompute. While debounce coalesces back-to-back calls, _recompute itself runs Utilization.computeMatrix over the full confidence horizon (default 20160 min = 14 days -> 14 day-columns across every line). The double wiring means no single owner of when confidence recomputes, and the monkey-patch fires for incremental {lines} alert recomputes too, forcing a full all-lines confidence rebuild after a line-scoped pass. NOTE: the patch correctly forwards (...args) and does NOT drop the {lines} scope -- CLAUDE.md's 'arity-0' description is stale for this code.

**Evidence.**

```
Store.subscribe(evt => {
  ...
  if (['tasks:bulk','tasks:bulkUpdate','task:update','task:remove'].includes(evt.type))
    Confidence._recomputeDebounced();
});
const origRecompute = Alerts.recompute.bind(Alerts);
Alerts.recompute = (...args) => { const r = origRecompute(...args); Confidence._recomputeDebounced(); return r; };
```

**Suggested fix.** Drive Confidence recompute from a single source. Prefer subscribing only to Alerts completion (or only to Store) -- not both. The Alerts.recompute wrapper should not re-trigger a full confidence pass for incremental {lines} recomputes; gate it so it only schedules on a full pass.

**Verification.** Lines 1304-1305 schedule _recomputeDebounced on tasks events and 1307-1308 also schedule it inside the Alerts.recompute wrapper; a typical edit fires both, and the patch fires even for incremental {lines} recomputes, forcing a full all-lines confidence rebuild (debounce coalesces but does not gate by scope).

---

<a id="r191"></a>
### R191. Confidence._sparkline re-reads the canvas and redraws the entire history on every score apply

`nimbus-intelligence.js:1364-1402`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** Every _apply (fired after each debounced recompute) does a getElementById + getContext and redraws all up-to-500 history points into a 48x20px canvas. Drawing 500 line segments into a ~48px-wide sparkline is wasted work - at most ~48 pixels of horizontal resolution can be distinguished, so >90% of the points overdraw the same columns. Minor on its own but it stacks on top of the already-frequent Confidence recompute path. The Array.shift() at the 500 cap is also O(n) per push once the buffer is full.

**Evidence.**

```
_apply(score) {
  ...
  Confidence._history.push({ ts: Date.now(), score });
  if (Confidence._history.length > 500) Confidence._history.shift();
  ...
  Confidence._sparkline();
},
_sparkline() {
  const canvas = document.getElementById('ni-conf-spark');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 48, 20);
  const h = Confidence._history;
  ...
  h.forEach((v, i) => { const x = i * step, y = 19 - (v.score / 100) * 17; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
```

**Suggested fix.** Cache the canvas/context references on the badge element rather than getElementById each draw; cap the sparkline to the number of distinguishable x-pixels (e.g. last ~48 points) for rendering; and use a ring buffer or splice batch instead of per-push shift() for the 500-entry cap.

**Verification.** _apply (line 1384) calls _sparkline which does getElementById+getContext and redraws all up-to-500 history points (lines 1387-1400) into a 48px canvas, and the 500-cap uses Array.shift() (line 1368) which is O(n); low severity is correct as it stacks on the already-frequent recompute path.

---

<a id="r192"></a>
### R192. RipplePreview._show filters+sorts the entire line task set on every hover-move to take only the first 5, plus per-id querySelector layout reads

`nimbus-intelligence.js:1730-1755`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** _show runs on Alt+hover (debounced 80ms). It allocates Store.tasksArr (Object.values), filters+sorts ALL line peers then takes only the first 5, then per ghost does a document.querySelector by attribute selector plus a getBoundingClientRect (layout read). Bounded to 5 ghosts, so impact is small, but the full filter+sort over the whole task set per hover-move (not just the 5 needed) scales with plant size and the querySelector-per-id is avoidable.

**Evidence.**

```
const peers = Store.tasksArr.filter(t => t.PRODUCTION_LINE === line && t.start_date && t.id !== taskId).sort((a,b) => a.start_date - b.start_date);
const downstream = peers.filter(t => t.start_date >= task.start_date).slice(0, 5);
...
downstream.forEach((t, i) => {
  const el = document.querySelector(`.vis-item[data-id="${t.id}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  ...
});
```

**Suggested fix.** Partition to tasks with start_date >= task.start_date before sorting (or cache the sorted line list per line and invalidate on edit). Map ids to elements via a single pass instead of querySelector per id.

**Verification.** Lines 1735-1738 filter+sort all line peers across the full Store.tasksArr before slicing to 5, and 1741-1744 do a querySelector-by-attribute plus getBoundingClientRect per ghost; bounded to 5 ghosts so impact is small but the full filter/sort per hover scales with plant size as described.

---

<a id="r193"></a>
### R193. RipplePreview ghost positioning does a querySelector + getBoundingClientRect per downstream item in a hover loop

`nimbus-intelligence.js:1730-1755`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** _show (debounced 80ms, fired on every Alt+hover over a new item) scans the entire Store.tasksArr to filter+sort all peers on the hovered line before slicing to 5. At the scale target a single busy line can hold many hundreds of orders, so the full filter+sort runs on each hover transition even though only the first 5 downstream are used. Additionally each of the (<=5) ghosts does a separate document.querySelector by attribute and a getBoundingClientRect; interleaving reads is fine here since no writes occur between them, but the per-item attribute querySelector is avoidable. Impact is bounded by the slice(0,5) on the DOM side, so severity is low, but the unbounded peer sort is the real cost.

**Evidence.**

```
const peers = Store.tasksArr
  .filter(t => t.PRODUCTION_LINE === line && t.start_date && t.id !== taskId)
  .sort((a,b) => a.start_date - b.start_date);
const downstream = peers.filter(t => t.start_date >= task.start_date).slice(0, 5);
if (!downstream.length) return;
downstream.forEach((t, i) => {
  const el = document.querySelector(`.vis-item[data-id="${t.id}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  ...
```

**Suggested fix.** Avoid sorting the full peer list: do a single pass to collect peers with start_date >= task.start_date, partial-select the 5 earliest (or sort only that filtered subset). Resolve ghost source elements via a single querySelectorAll('.vis-item[data-id]') map keyed by id rather than N separate attribute querySelectors.

**Verification.** _show (lines 1735-1742) filters+sorts the full Store.tasksArr peer set before slice(0,5), then does a separate document.querySelector by data-id per ghost; bounded to 5 ghosts so low severity is right, the unbounded peer sort being the real cost.

---

<a id="r194"></a>
### R194. Diff.showUI re-serializes the entire live task list on every snapshot-row click

`nimbus-intelligence.js:1978-2007`  ·  **LOW**  ·  _performance_  ·  confidence: high

**Why it matters.** The 'current' snapshot (curr) is identical for every comparison within one dialog session (the live Store does not change while the modal is open), yet it is rebuilt -- a full map over Store.tasksArr (Object.values + per-task object alloc, then Diff._enrich does another Store.tasks[id] lookup per row inside compute) -- on each row click. With many snapshot rows and a large plant this is repeated O(orders) work per click for no benefit.

**Evidence.**

```
const runDiff = ts => {
  const snap = snaps.find(s => s.ts === ts);
  if (!snap) return;
  const curr = Store.tasksArr.map(t => ({ id, start_date: t.start_date?.getTime?.()||null, ... }));
  const d = Diff.compute(snap.tasks, curr);
  ...
};
// wired to every row click, and auto-run once on open
```

**Suggested fix.** Compute `curr` once before wiring row handlers and reuse it inside runDiff. Diff._enrich already re-reads live Store per id, so caching curr is safe.

**Verification.** runDiff (1978-1994) rebuilds curr via a full Store.tasksArr.map on every invocation, and it is wired to every row click (1997-2002) plus the auto-run (2007), even though the live Store does not change while the modal is open so curr is identical across clicks.

---

<a id="r195"></a>
### R195. LangSwitcher.set forces a full location.reload() on language change

`nimbus-intelligence.js:2097-2100`  ·  **LOW**  ·  _performance_  ·  confidence: medium

**Why it matters.** Switching language triggers a full page reload, which re-fetches all CDN libraries, re-runs the entire app.js IIFE chain and nimbus-intelligence.js boot, re-queries GET /tasks against Postgres, and discards the in-memory Store and any unsaved (localStorage-only autosaved but not backend-persisted) what-if/sandbox state. Given locales are plain string maps already loaded on window before app.js, a reload is a heavy way to re-render translated strings and silently loses transient UI state. Low severity because language changes are rare, but it is a needless full reload and a data-loss footgun for in-progress edits.

**Evidence.**

```
set(code) {
  localStorage.setItem(LangSwitcher._key, code);
  location.reload();
},
```

**Suggested fix.** Re-render in place: set the locale, repoint window.t's active map, and trigger a Store.publish/re-render of visible modules instead of location.reload(). If a reload is truly required, first flush/confirm any unsaved edits.

**Verification.** set() (lines 2097-2100) calls location.reload() after writing the locale, which re-fetches CDN libs, re-runs boot, re-queries /tasks, and discards transient in-memory/sandbox state; low severity is appropriate given rarity of language changes.

---

<a id="r196"></a>
### R196. updateMany mutates task objects in place while updateTask replaces the reference, breaking identity-diffing for the bulk optimizer path

`app.js:676-685`  ·  **LOW**  ·  _illogical-pattern_  ·  confidence: medium

**Why it matters.** updateTask (lines 641-648) deliberately replaces the task reference (prev -> next = {...prev,...changes}) with the documented rationale (lines 637-640) that subscribers (AG Grid, diff-rebuild) diff by identity. updateMany does the opposite: Object.assign mutates the existing object in place, so the reference is unchanged. Any subscriber that relies on reference identity to detect a change (as the updateTask comment explicitly says they do) will see the same object reference after a bulk optimizer update and may skip re-rendering or mis-diff. This is an internal inconsistency between two mutation paths feeding the same subscribers.

**Evidence.**

```
updateMany(patches, source) {
      // patches: [{id, changes}]
      for (const p of patches) {
        const task = this._state.tasks[p.id];
        if (!task) continue;
        Object.assign(task, p.changes);
        Store._normalizeDates(task);
      }
      this.emit({ type: 'tasks:bulkUpdate', ids: patches.map(p => p.id), source });
    },
```

**Suggested fix.** Make updateMany replace references like updateTask: `const next = { ...task, ...p.changes }; Store._normalizeDates(next); this._state.tasks[p.id] = next;`. If the event should carry refs, collect them into the emitted payload.

**Verification.** Lines 678-682 show updateMany doing Object.assign(task, p.changes) (in-place) while updateTask at 644-646 replaces the reference with the documented identity-diff rationale at 637-640, so the two mutation paths genuinely diverge in reference semantics.

---

<a id="r197"></a>
### R197. Hierarchy utilization chip mixes ending-today load with starting-today task list

`app.js:7096-7107`  ·  **LOW**  ·  _illogical-pattern_  ·  confidence: medium

**Why it matters.** The expanded task list under each line (`tasks`) is filtered to orders that START today, but the utilization chip percentage (`pct`) is computed from `runH` of orders that END today. These are two disjoint order sets. A multi-day order spanning today contributes to neither, and the chip can read high/low while the visible list is empty, or vice-versa. This contradicts the everywhere-else convention: `Utilization.computeMatrix` (lines 4254-4283) distributes run-hours by per-day calendar overlap rather than attributing the whole order to its end day. The chip will diverge from the heatmap/line-status cell for the same line/day.

**Evidence.**

```
const tasks = lines[name]
  .filter(tk => tk.start_date >= todayStart && tk.start_date <= todayEnd)  // STARTING today
  ...
const endingToday = lines[name].filter(
  tk => tk.end_date && tk.end_date >= todayStart && tk.end_date <= todayEnd  // ENDING today
);
const runH      = endingToday.reduce((s, tk) => s + Util.runHours(tk), 0);
const cap       = Calendar.dailyCapacityHours(name, todayStart);
const utilRatio = cap > 0 ? runH / cap : (runH > 0 ? 1 : 0);
```

**Suggested fix.** Compute the chip from the same overlap-based daily load used by `Utilization.computeMatrix`/`dayByLine` (call `Utilization.dayByLine(now)` or read the day cell), instead of summing full `runHours` of end-today orders. At minimum align the numerator set with what the row displays.

**Verification.** At 7096-7104 `tasks` is filtered to orders starting today while `runH`/`pct` derive from `endingToday` (end_date today) — two disjoint sets, so the chip percentage can diverge from the visible task list as described.

---

<a id="r198"></a>
### R198. Selection.add sets anchor to the last element of the passed array even when that id was already selected (no net change attributable to it)

`app.js:8722-8733`  ·  **LOW**  ·  _illogical-pattern_  ·  confidence: medium

**Why it matters.** When `changed` is true, the anchor is set to arr[arr.length-1] regardless of whether that last id was actually newly added or was already in the set. If add(['x','y']) is called where 'y' was already selected but 'x' is new, the anchor becomes 'y' (an already-selected item) rather than the newly added 'x'. Since the anchor drives Shift-range selection (selectRange), this can place the range anchor on an unexpected item after a multi-add. Minor UX correctness issue in range-select behavior, not a crash.

**Evidence.**

```
add(ids) {
  const arr = Array.isArray(ids) ? ids : [ids];
  let changed = false;
  for (const id of arr) {
    const s = String(id);
    if (!this._ids.has(s)) { this._ids.add(s); changed = true; }
  }
  if (changed) {
    this._anchor = String(arr[arr.length - 1]);
    this._emit('add');
  }
},
```

**Suggested fix.** Track the last id that was actually newly added and use that as the anchor: e.g. `let lastAdded = null; ... if (!this._ids.has(s)) { this._ids.add(s); changed = true; lastAdded = s; } ... if (changed) { this._anchor = lastAdded; ... }`

**Verification.** At lines 8729-8730 when `changed` is true the anchor is set to String(arr[arr.length-1]) unconditionally, so if the last id was already selected but an earlier id was newly added, the anchor lands on an already-selected item; minor UX correctness issue affecting Shift-range as described.

---

<a id="r199"></a>
### R199. Active search filter is silently reset whenever the grid re-renders (add/paste/delete/dirty-save)

`app.js:14302-14323, 14835-14842`  ·  **LOW**  ·  _illogical-pattern_  ·  confidence: high

**Why it matters.** _renderTable builds a brand-new empty search input on every call, and _addRow/_pasteRows/_deleteRow/undo all call _renderTable. The filter query lives only in the DOM input that was just destroyed, so any structural edit clears the user's active search and re-shows all rows. At the documented scale target (50+ plants, 70+ lines/plant, 3,500+ lines) the operator is expected to filter before editing; losing the filter on every add/paste/delete is a real usability regression against the CLAUDE.md anti-pattern guidance that lists must always remain filterable.

**Evidence.**

```
function _renderTable(table) {
  ...
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'input md-search';
  searchInput.placeholder = t('ph.search_table', { table: TABLE_LABELS[table] });
  searchInput.oninput = () => _applyFilter(table, searchInput.value.toLowerCase());
  ...
// _applyFilter only toggles tr.hidden — it does not persist the query anywhere
function _applyFilter(table, query) {
  const tbody = document.getElementById(`md-tbody-${table}`);
  if (!tbody) return;
  tbody.querySelectorAll('tr').forEach(tr => { tr.hidden = query ? !text.includes(query) : false; });
}
```

**Suggested fix.** Persist the current query in per-table state (e.g. `state.filter`), restore `searchInput.value` from it in _renderTable, and re-run _applyFilter after each re-render so the active filter survives structural edits.

**Verification.** _renderTable (14318-14323) builds a fresh empty search input each call and _applyFilter (14835-14842) only toggles tr.hidden with no persisted query, so any _addRow/_pasteRows/_deleteRow/undo re-render destroys the active filter.

---

<a id="r200"></a>
### R200. Deleting a saved subnetwork/plant triggers two separate cascade-preview fetches and two confirm dialogs

`app.js:14696-14721, 14768-14791`  ·  **LOW**  ·  _illogical-pattern_  ·  confidence: high

**Why it matters.** For subnetworks/plants the user confirms a cascade-aware delete per row in _deleteRow, but that only marks the row in state.deleted (nothing is sent to the backend yet — delete is staged until Save). When Save runs, _save re-fetches the same cascade-preview and shows a second danger confirmation covering the same deletes. The result is a double round-trip to /cascade-preview and a redundant second 'this will permanently delete N plants' dialog for the same action, which is confusing and extra server load at scale. There is no flag carried from _deleteRow to _save to suppress the duplicate prompt.

**Evidence.**

```
// _deleteRow (per row): fetch cascade-preview + Modal.confirm({tone:'danger'})
if (!isNew && (table === 'subnetworks' || table === 'plants')) {
  const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {...});
  ... cascadeDetail ...
}
const confirmed = await Modal.confirm({ title:`Delete "${keyDisplay}"?`, ... });
...
// _save (batch): fetch cascade-preview AGAIN + Modal.confirm AGAIN for the same deletes
if (deletes.length && (table === 'subnetworks' || table === 'plants')) {
  const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {...});
  ... const ok = await Modal.confirm({ title:`Delete ${deletes.length} row...?`, ... });
}
```

**Suggested fix.** Pick one gate: either make _deleteRow stage silently (no per-row cascade fetch/confirm) and rely on the batch confirm in _save, or record that a row's cascade was already confirmed (e.g. a `state.cascadeConfirmed` Set) and skip the batch preview/confirm for already-confirmed keys.

**Verification.** _deleteRow (14696-14711) fetches cascade-preview and shows a danger Modal.confirm then only stages to state.deleted, and _save (14769-14791) re-fetches cascade-preview and shows a second danger confirm with no flag carried between them.

---

<a id="r201"></a>
### R201. Bulk-update 'persisted < total' warning fires spuriously for no-op (dateless) tasks

`brain.py:783-784, 850-857`  ·  **LOW**  ·  _illogical-pattern_  ·  confidence: medium

**Why it matters.** Tasks with neither start_date nor end_date are silently skipped in _apply_task_date_updates (line 783-784) and are never counted in invalid/not_found/persisted. But the /tasks/update and /tasks/bulk_update handlers compute `total = len(payload.tasks)` including those skipped no-ops, then warn-log whenever `persisted < total`. A payload that legitimately contains some metadata-only or unchanged rows will emit a misleading 'some tasks not persisted' warning every save, polluting the structured log buffer (500-entry ring) and obscuring real partial-failure signals.

**Evidence.**

```
if start_dt is None and end_dt is None:
    continue
...
res = _apply_task_date_updates(payload.tasks)
total = len(payload.tasks)
...
if res["persisted"] < total:
    _log_event("warn", "db", "Bulk update: some tasks not persisted", total=total, persisted=res["persisted"], ...)
```

**Suggested fix.** Compute the warning denominator from the count of items that actually carried a date edit (e.g. return a `considered` count from _apply_task_date_updates) rather than raw len(payload.tasks), so the warn only fires on genuine non-persistence.

**Verification.** Lines 783-784 skip tasks with no start/end without counting them, while line 851 sets total=len(payload.tasks) and 853 warns when persisted<total, so a payload containing dateless rows logs a misleading 'some tasks not persisted' warning every save.

---

<a id="r202"></a>
### R202. NeedsEngine 'diff-available' need uses an inverted confDelta guard that hides the suggestion exactly when confidence is degrading

`nimbus-intelligence.js:586-592`  ·  **LOW**  ·  _illogical-pattern_  ·  confidence: medium  ·  **⚖️ needs-human-judgment**

**Why it matters.** The score gate `confDelta >= -5` surfaces the 'compare snapshots' suggestion only when confidence has held steady or improved. When confidence drops sharply (delta < -5) -- precisely when a user would most want to diff against an earlier, healthier snapshot -- the need scores 0 and is hidden. score() and when() also diverge (when() omits the confDelta term), so the suggestion silently vanishes under degradation rather than being prioritized. Likely an inverted condition.

**Evidence.**

```
{
  id: 'diff-available',
  label: () => 'Compare to a previous snapshot',
  ...
  score: s => s.snapshotCount > 1 && s.confDelta >= -5 ? 35 : 0,
  when:  s => s.snapshotCount > 1 && s.hasPlant,
}
```

**Suggested fix.** Re-express the gate so degrading confidence raises (not suppresses) the diff suggestion (e.g. boost score when confDelta < 0); keep score() and when() consistent.

**Verification.** Line 590's score gate confDelta >= -5 is real and does score 0 (hiding the diff suggestion) when confidence drops sharply, while when() (591) omits confDelta so they diverge; whether surfacing-on-degradation vs surfacing-on-stability is the intended product behavior cannot be determined from source alone.

---

<a id="r203"></a>
### R203. CLAUDE.md contradiction: documented arity-0 Alerts.recompute monkey-patch is no longer present

`nimbus-intelligence.js:1308`  ·  **LOW**  ·  _illogical-pattern_  ·  confidence: high

**Why it matters.** CLAUDE.md states: 'Confidence.init monkey-patches Alerts.recompute with an arity-0 wrapper that calls the original with no arguments, so the {lines} incremental scope is silently dropped.' The current code spreads `...args` into origRecompute, so the {lines} incremental scope IS preserved — the documented bug does not exist in this code. The arrow function's `.length` is 0, but no caller checks recompute.length (confirmed: the only call site, app.js:4178 `Alerts.recompute(full ? {} : { lines })`, passes args positionally). This is a stale-documentation issue, not a runtime bug, but it actively misleads anyone reasoning about alert performance from the docs.

**Evidence.**

```
Alerts.recompute = (...args) => { const r = origRecompute(...args); Confidence._recomputeDebounced(); return r; };
```

**Suggested fix.** Update CLAUDE.md to reflect that the wrapper now forwards arguments; remove the 'incremental scope silently dropped' caveat. No code change needed.

**Verification.** Line 1308 spreads `...args` into origRecompute so the {lines} incremental scope IS forwarded, contradicting the CLAUDE.md claim of an arity-0 wrapper that drops arguments; this is a stale-doc issue, not a runtime bug.

---

<a id="r204"></a>
### R204. Duplicated lerpRGB/heatBg heat-map helpers defined inline twice, rebuilt on every render

`app.js:2675-2688, 2811-2825`  ·  **LOW**  ·  _unused-code_  ·  confidence: high

**Why it matters.** The same lerpRGB color-interpolation function and idle/low/mid/hot palette plus heatBg are hand-duplicated in _renderLinePlan and _renderCapacity and re-declared as fresh closures on every render of each tab. This is duplicated logic that should be shared and hoisted out of the per-render path; the per-call hex parse (parseInt slices) is repeated for every heat cell. Divergence between the two copies would silently make the Line Plan and Capacity heat maps inconsistent.

**Evidence.**

```
_renderLinePlan (2675-2688): const isDark = ...; function lerpRGB(a,b,t){...} const idle=...,low=...,mid=...,hot=...; function heatBg(ratio){...}
_renderCapacity (2811-2825): identical lerpRGB / idle,low,mid,hot / heatBg (plus heatText).
```

**Suggested fix.** Hoist lerpRGB, palette constants, heatBg and heatText to module-scope helpers in the LaborPlanning IIFE, parameterized by isDark, and call them from both renderers. Precompute the palette once per render rather than per cell.

**Verification.** Identical lerpRGB, idle/low/mid/hot palette and heatBg are re-declared as fresh closures inside _renderLinePlan (2676-2688) and _renderCapacity (2812-2825), with _renderCapacity additionally defining heatText.

---

<a id="r205"></a>
### R205. _onRowClicked is defined but never wired into gridOptions — dead code / Inspector unreachable from the orders Table

`app.js:6541-6552`  ·  **LOW**  ·  _unused-code_  ·  confidence: medium

**Why it matters.** Table._onRowClicked is the only place in the Table module that opens the Inspector (Inspector.show at 6550). However gridOptions (6043-6172) registers onCellValueChanged, onSelectionChanged, onCellKeyDown, onGridReady, isExternalFilterPresent, doesExternalFilterPass — but NO onRowClicked handler. A grep for onRowClicked confirms _onRowClicked is never referenced anywhere else in app.js. So clicking a row in the orders grid never opens the Inspector via this code; the function is dead. Either this is unused leftover code or a missing wiring that breaks the expected 'click order row -> see detail panel' interaction from the Table tab (Inspector is still reachable from Timeline/context-menu paths at 5957/8662/9458). Worth confirming the table-row->inspector flow is intended; if so this is a functional gap, if not the function should be removed.

**Evidence.**

```
_onRowClicked(event) {
  if (!event.data) return;
  const task = Store.tasks[event.data.id];
  if (task) {
    const rightSidebar = document.getElementById('right-sidebar');
    ...
    Inspector.show(task);
  }
},
```

**Suggested fix.** If row-click should open the Inspector, add `onRowClicked: Table._onRowClicked` to gridOptions. If the interaction is intentionally driven elsewhere, delete _onRowClicked to remove the misleading dead code.

**Verification.** _onRowClicked is defined at 6541 but gridOptions (6043-6172) registers no onRowClicked, and a grep shows onRowClicked appears only at that definition — it is genuinely unwired dead code (Inspector remains reachable via 5 other Inspector.show sites).

---

<a id="r206"></a>
### R206. GanttFilter.matches checks colors/forms but isActive()/badge never account for selected lines; matches() ignores line selection entirely

`app.js:8258-8271`  ·  **LOW**  ·  _unused-code_  ·  confidence: medium

**Why it matters.** matches() (used by _doApply to decide dimming) never consults GanttFilter._selectedLines, and isActive() omits it too. Line filtering is instead handled entirely by Timeline.rebuild() (line 5736-5745) which physically drops non-selected lines. This is internally consistent (lines are removed, not dimmed), but it means _selectedLines participates in a different code path than colors/forms, which is an easy correctness/maintenance trap: a reader expecting matches()/isActive() to be the single filter predicate will be wrong. Not a runtime bug today, but the divergence is worth flagging.

**Evidence.**

```
matches(task) {
  const { text } = GanttFilter._active;
  if (GanttFilter._selectedColors.size > 0 && !GanttFilter._selectedColors.has((task.COLOR || '').toUpperCase())) return false;
  if (GanttFilter._selectedForms.size  > 0 && !GanttFilter._selectedForms.has((task.FORM_SIZE || '').toUpperCase())) return false;
  ...
}
isActive() {
  return !!(GanttFilter._selectedColors.size || GanttFilter._selectedForms.size || GanttFilter._active.text);
}
```

**Suggested fix.** Document the intentional split (lines = structural rebuild; colors/forms/text = dim) with a comment on matches(), or fold line membership into matches()/isActive() and let rebuild() consume the same predicate, to keep one source of truth for 'is this task filtered'.

**Verification.** matches() (8258-8267) and isActive() (8269-8271) consult only colors/forms/text and never _selectedLines, while line filtering is handled structurally by Timeline.rebuild (5736-5745); this is an accurate observation of an intentional split, correctly flagged as a maintainability/documentation note rather than a runtime bug.

---

<a id="r207"></a>
### R207. DependencyOverlay declares _unsubStore/_unsubRange but never assigns _unsubRange, and never tears down the rangechange handlers

`app.js:8480-8514`  ·  **LOW**  ·  _unused-code_  ·  confidence: high

**Why it matters.** _unsubRange is declared but never assigned — the vis-timeline rangechanged/rangechange handlers (doRender) are registered with no stored reference and no teardown. _unsubStore is assigned but never called. Dead field plus un-cleanable listeners. Harmless for single boot but misleading (the field name implies a cleanup contract that does not exist) and a leak if the module is ever re-initialized.

**Evidence.**

```
_unsubStore: null,
_unsubRange: null,
...
if (Timeline._tl) {
  const doRender = () => { if (DependencyOverlay._enabled) DependencyOverlay.render(); };
  Timeline._tl.on('rangechanged', doRender);
  Timeline._tl.on('rangechange',  doRender);
}
DependencyOverlay._unsubStore = Store.subscribe(evt => { ... }, 'DependencyOverlay');
```

**Suggested fix.** Remove the unused _unsubRange field or actually store the off-handler (vis-timeline supports tl.off('rangechanged', doRender)); add a destroy() that invokes _unsubStore and tl.off for the range handlers if teardown is intended.

**Verification.** _unsubRange is declared at 8481 but never assigned (the rangechanged/rangechange handlers at 8503-8504 are registered with no stored reference), and _unsubStore is assigned at 8507 but never invoked anywhere; dead field plus uncleaned listeners as described.

---

<a id="r208"></a>
### R208. Dead variable: skippedFixed is always empty, gating an unreachable toast in multi-order drag

`app.js:9967, 9978, 9996`  ·  **LOW**  ·  _unused-code_  ·  confidence: high

**Why it matters.** skippedFixed is declared empty and never pushed to. Fixed tasks are already filtered out of selIds at line 9967 (`!Store.isFixed(sid)`), so the companion loop never encounters a fixed task to skip. The `if (skippedFixed.length)` branch and its toast are permanently dead code, and toast.fixed_count_not_moved can never fire from this path — a user multi-dragging a selection that includes fixed orders gets no feedback that the fixed ones were left behind.

**Evidence.**

```
const selIds = Selection.ids().filter(sid => sid !== id && !Store.isFixed(sid));
...
const skippedFixed = [];
...
if (skippedFixed.length) Toast.show(t('toast.fixed_count_not_moved', { count: skippedFixed.length }), 'warn');
```

**Suggested fix.** Remove the dead skippedFixed array and its branch; or, if the warning is desired, compute the fixed-companion count before filtering (Selection.ids().filter(sid => sid !== id && Store.isFixed(sid)).length) and surface it in the toast.

**Verification.** skippedFixed is declared empty at 9978 and never pushed to (the companion loop 9980-9993 has no push); selIds is pre-filtered with !Store.isFixed at 9967, so the `if (skippedFixed.length)` toast at 9996 is permanently dead code.

---

<a id="r209"></a>
### R209. _lastQuarantineKey is written but never read — dead write

`app.js:11093`  ·  **LOW**  ·  _unused-code_  ·  confidence: high

**Why it matters.** In _quarantineCache, the quarantine localStorage key is stored on Persistence._lastQuarantineKey. A repo-wide grep shows this property is assigned at exactly one location and read nowhere (no diagnostics bundle, no storageInventory, no UI surfaces it). It is a dead write — unlike sibling diagnostics fields _lastCacheBytes/_lastCacheAt/_cacheDegraded/_autosaveDisabled which are all consumed by storageInventory(). Either the intent to surface the quarantine key in diagnostics was dropped, or the assignment is vestigial.

**Evidence.**

```
Persistence._lastQuarantineKey = key;
```

**Suggested fix.** Either surface _lastQuarantineKey in storageInventory()/the diagnostics bundle so an operator can recover a quarantined cache, or remove the assignment. Given quarantine is a debugging aid, surfacing it in storageInventory is the more useful resolution.

**Verification.** Repo-wide grep shows Persistence._lastQuarantineKey is assigned only at line 11093 and read nowhere (storageInventory at 11097-11119 surfaces _cacheDegraded/_lastCacheBytes/_lastCacheAt/_autosaveDisabled but not it) — a confirmed dead write.

---

<a id="r210"></a>
### R210. Memory watchdog setInterval relies on non-standard performance.memory (Chromium-only) and never clears

`app.js:15069-15080`  ·  **LOW**  ·  _unused-code_  ·  confidence: medium

**Why it matters.** performance.memory is a non-standard, Chromium-only API; on Firefox/Safari `m` is always undefined so the interval fires every 30 s for the life of the page doing nothing but a property check. It is effectively dead work on non-Chromium browsers and an unmanaged timer with no clearInterval handle anywhere. Low impact, but it is a permanently-scheduled no-op on a subset of clients.

**Evidence.**

```
setInterval(() => {
  if (document.hidden) return;
  const m = performance && performance.memory;
  if (!m) return;
  const usedMB  = m.usedJSHeapSize  / 1048576;
  ...
}, 30_000);
```

**Suggested fix.** Guard the setInterval so it is only scheduled when performance.memory exists at boot (feature-detect once), and skip scheduling otherwise. This is a minor cleanup, not a correctness bug.

**Verification.** 15069-15080 schedules a 30s setInterval unconditionally that early-returns when performance.memory is absent (non-Chromium), with no stored handle/clearInterval anywhere, so it is a permanent no-op timer on those browsers.

---

<a id="r211"></a>
### R211. meta payload ships the entire stateless-stale DIAGNOSTICS dict (lines{}, warnings[], dropped_* counters) on every /tasks response

`brain.py:725-732`  ·  **LOW**  ·  _unused-code_  ·  confidence: medium

**Why it matters.** DIAGNOSTICS (lines 248-263) is a load-time bucket whose fields — raw_row_count, dropped_no_start_date, dropped_no_finish_date_filled, duplicate_ids_suffixed, lines{}, warnings[], load_ms, source_file — were populated by an in-memory load path that no longer exists in stateless mode. dict(DIAGNOSTICS, **cm_stats) copies all of these into every /tasks response meta, then overwrites only a handful (rendered, link_count, plant/line filters, pre_color_merge_count, raw_row_count, unique_id_count, total). The remaining keys (lines{} which can grow unbounded as a global, warnings[], dropped_* always-zero counters) are dead, misleading payload serialized on every request. The empty-result branch (lines 655-662) already hand-builds a clean minimal meta, demonstrating the full DIAGNOSTICS spread is unnecessary.

**Evidence.**

```
meta = dict(DIAGNOSTICS, **cm_stats)
meta["rendered"] = len(data)
...
meta["unique_id_count"] = len(data)
```

**Suggested fix.** Build meta from cm_stats plus the explicitly-set keys only (mirroring the empty-result branch), rather than spreading the whole DIAGNOSTICS global. This shrinks the response, removes stale/zero fields, and avoids leaking the unbounded global lines{}/warnings[] state into per-request output.

**Verification.** Line 725 does dict(DIAGNOSTICS, **cm_stats) spreading the load-time DIAGNOSTICS bucket (248-263) into every response while only a handful of keys are overwritten (726-733); the stale dropped_*/warnings fields are real dead payload, though the 'unbounded lines{}' claim is overstated since stateless mode never populates it.

---

<a id="r212"></a>
### R212. Dead function: load_orders_df() has no callers

`db.py:129-138`  ·  **LOW**  ·  _unused-code_  ·  confidence: high

**Why it matters.** The docstring claims it is 'Used by diagnostics/admin paths' but a repo-wide grep finds no caller in any .py file (brain.py, master_data.py, db.py itself) — the only other mention is in AUDIT_RECOMMENDATIONS.md. It is genuinely dead. Beyond being unused, it is also an unbounded full-table SELECT with no plant/line scoping — exactly the anti-pattern CLAUDE.md forbids at the 3,500-line scale target. Leaving it present invites a future caller to reintroduce a full-order-book load. The diagnostics paths that actually exist (get_db_deep_stats, distinct_order_colors) deliberately avoid building a full DataFrame.

**Evidence.**

```
def load_orders_df() -> pd.DataFrame:
    """
    Return ALL orders as a DataFrame. Used by diagnostics/admin paths only —
    the hot /tasks read path uses query_orders() with server-side scoping.
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(_ORDERS_SELECT)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)
```

**Suggested fix.** Delete load_orders_df() entirely. If a future admin path needs bulk export, route it through query_orders() with an explicit plant scope or a hard LIMIT, mirroring the GET /tasks guard in brain.py (line 647) that already refuses unscoped full loads.

**Verification.** Repo-wide grep for load_orders_df across *.py returns only its own definition at db.py:129; it is an unbounded full-table SELECT (lines 134-138) with no callers, matching the finding.

---

<a id="r213"></a>
### R213. _row_key helper is defined but never used (dead code)

`master_data.py:56-57`  ·  **LOW**  ·  _unused-code_  ·  confidence: high

**Why it matters.** A repo-wide grep for `_row_key` returns only this definition — it is never called anywhere in master_data.py, brain.py, db.py, or any other module. It is dead code: the bulk_apply path computes its own `keys = sorted(_KEY_COLUMNS[table])` inline (line 223) rather than using this helper. Dead helpers accrete maintenance cost and mislead readers into thinking row-keying is centralized when it is not.

**Evidence.**

```
def _row_key(table: str, row: dict) -> tuple:
    return tuple(row.get(k) for k in sorted(_KEY_COLUMNS[table]))
```

**Suggested fix.** Either remove _row_key, or refactor bulk_apply (and any future keyed paths) to use it so key-tuple construction is centralized. Removal is the simpler choice if no caller is planned.

**Verification.** A repo-wide grep for _row_key returns only its definition at master_data.py:56; bulk_apply computes keys inline at line 223, confirming it is dead code.

---

<a id="r214"></a>
### R214. Duplicated webkit-scrollbar rule blocks repeated across many components

`styles.css:163-165, 292-294, 794-796`  ·  **LOW**  ·  _unused-code_  ·  confidence: high

**Why it matters.** The exact same three-line ::-webkit-scrollbar / -track / -thumb declaration (width 6px, transparent track, var(--line-strong,#c7c6bd) thumb, radius 3px) is copy-pasted for at least .hm-scroll-wrap, .lh-scroll-wrap, and #line-status-panel within the inline <style> block, plus the matching scrollbar-width/scrollbar-color Firefox pair. This is pure duplication that should be a shared utility class. Maintenance hazard: a future thumb-color change must be made in N places and is easy to miss.

**Evidence.**

```
.hm-scroll-wrap::-webkit-scrollbar { width: 6px; }
.hm-scroll-wrap::-webkit-scrollbar-track { background: transparent; }
.hm-scroll-wrap::-webkit-scrollbar-thumb { background: var(--line-strong, #c7c6bd); border-radius: 3px; }
... (identical pattern repeated for .lh-scroll-wrap at 292-294 and #line-status-panel at 794-796, all inside index.html inline <style>) ...
```

**Suggested fix.** Extract a single reusable class (e.g. `.thin-scroll`) with the scrollbar-width/color + ::-webkit-scrollbar rules, and apply it to each scroll container, removing the per-selector copies.

**Verification.** The identical three-line ::-webkit-scrollbar/track/thumb block (6px, transparent, var(--line-strong,#c7c6bd), radius 3px) appears verbatim at .hm-scroll-wrap (163-165), .lh-scroll-wrap (292-294), and #line-status-panel (794-796).

---

<a id="r215"></a>
### R215. countChangeovers uses Date-subtraction comparator and walks the task set redundantly with scheduleKpis

`app.js:318-333`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** The comparator relies on implicit Date->number coercion (`a.start_date - b.start_date`), which is fragile. More relevant to this perf pass: scheduleKpis (line 339) calls countChangeovers, which builds byLine buckets and sorts them, then scheduleKpis separately iterates the same `tasks` array again for span/lateness. The same task set is grouped, sorted, and walked across two functions per optimizer preview rather than in a single pass.

**Evidence.**

```
let n = 0;
for (const l of Object.keys(byLine)) {
  const sorted = byLine[l].sort((a, b) => a.start_date - b.start_date);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if ((a.COLOR || '') !== (b.COLOR || '') || (a.FORM_SIZE || '') !== (b.FORM_SIZE || '')) n++;
```

**Suggested fix.** Use an explicit numeric comparator `(a.start_date.getTime() - b.start_date.getTime())`, and fold the changeover count and span/lateness accumulation into a single pass in scheduleKpis to avoid grouping/walking the task set twice.

**Verification.** Line 327 uses implicit Date-subtraction comparator (a.start_date - b.start_date) and scheduleKpis (339) calls countChangeovers then re-iterates the same tasks array at 342-348, confirming the double walk; a maintainability nit, not a correctness defect.

---

<a id="r216"></a>
### R216. _indexBlocks buckets line-scoped blocks without plant filtering, so the optimizer block index carries every plant's line blocks

`app.js:963-984`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** _indexBlocks receives the plant being optimized and correctly scopes byPlant to it (line 975: if (b.plant && plant && b.plant !== plant) continue;), but byLine indexes EVERY line-scoped block across all plants with no plant scoping. At the 3,500-line target a single plant's optimizer run builds a byLine Map containing blocks for lines belonging to all 50+ plants. Lookups in _overlapsBlock are keyed by exact line (rb.byLine.get(line)) so correctness is preserved, but the index is far larger than necessary -- O(all-system-line-blocks) memory and parse cost per run instead of O(this-plant's-blocks). Since blocks are line-keyed and the plant is known, the index can be pruned to the plant's lines.

**Evidence.**

```
_indexBlocks(plant) {
  const byLine = new Map();
  for (const b of Store.blocks) {
    const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
    if (!s || !e) continue;
    const key = b.line || '__any__';
    ...
  }
  const byPlant = new Map();
  for (const b of Store.plantBlocks) {
    if (b.plant && plant && b.plant !== plant) continue;
    ...
```

**Suggested fix.** Pass the plant's line set (the allowed-line set already computed in runAndApply, or Store.linesForSelectedPlant) into _indexBlocks and skip line-scoped blocks whose b.line is not in that set, mirroring the plant filter already applied to byPlant. Reduces per-run index build cost and memory at scale.

**Verification.** app.js 965-972 indexes every Store.blocks line-scoped block with no plant scoping while the byPlant loop at 974-975 does filter by plant; lookups are exact-line keyed so correctness holds but the byLine index is larger than necessary, matching the maintainability/low classification.

---

<a id="r217"></a>
### R217. applyFix overload undo correctness depends on a comment-only coupling to Engine.runAndApply's internal free-set predicate

`app.js:4120-4140`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** The undo snapshot reconstructs, at the call site, the set of tasks the optimizer is expected to move (the comment at 4129-4131 explains it must be a SUPERSET of runAndApply's free-set predicate isAged/isOutOfWin). The snapshot/optimize/undo correctness therefore depends entirely on this filter staying in sync with runAndApply's internal window/aged predicate, enforced only by a comment. The comment itself documents that a prior version of this exact coupling had a bug (keying on dayKey(start) lost cross-midnight orders on undo). Any future change to runAndApply's predicate will silently desync undo coverage again — a fragile, recurrence-prone pattern.

**Evidence.**

```
const snap = UndoStack.snapshotTasks(Store.tasksArr.filter(t =>
  (t.PRODUCTION_LINE || 'Unknown') === line &&
  (!t.end_date   || t.end_date   >= dayStart) &&
  (!t.start_date || t.start_date <= dayEnd)
).map(t => t.id));
Engine.runAndApply('combined', { lines: [line], startDate: dayStart, endDate: dayEnd });
UndoStack.push(`Auto-fix overload ${line} ${day}`, () => UndoStack.restoreTasks(snap));
```

**Suggested fix.** Have Engine.runAndApply return the set of task ids it actually treated as movable (its free set) and snapshot precisely those ids, instead of reconstructing the predicate at the call site. This removes the comment-only coupling between applyFix and the optimizer internals.

**Verification.** At 4128-4137 the undo snapshot reconstructs the optimizer's movable-task set via a hand-written window filter coupled to runAndApply's isAged/isOutOfWin predicate only by the comment at 4128-4131, which itself documents a prior recurrence of this exact desync bug — a genuine fragility, severity low is appropriate.

---

<a id="r218"></a>
### R218. _displayDate hardcodes 'en-US' locale, bypassing NIMBUS i18n in the optimize date summary

`app.js:4927-4932`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** NIMBUS ships locale maps (en, de, es, fr, pt) and a window.t resolver; date display elsewhere goes through Flatpickr altFormat / Util helpers. _displayDate pins the locale to 'en-US' for the optimize dialog's From/To buttons and date-range summary, so a German/Spanish/French/Portuguese user sees English month abbreviations and AM/PM formatting in this dialog only — an inconsistency with the rest of the localized UI.

**Evidence.**

```
function _displayDate(d) {
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}
```

**Suggested fix.** Use the active locale: `d.toLocaleString(undefined, {...})` (honors the browser/app locale) or thread the NIMBUS-selected language code into toLocaleString, consistent with how other date displays are localized.

**Verification.** Line 4928 calls d.toLocaleString('en-US', {...}) with a pinned locale; severity-low is appropriate as it is cosmetic and dialog-scoped.

---

<a id="r219"></a>
### R219. Outside-click/Escape document listeners in Table.init are anonymous, never removed, and re-added on re-init

`app.js:6187-6195`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** These two document-level listeners (capture-phase mousedown + keydown) are added with anonymous handlers and no stored reference, so they can never be removed and would be duplicated if init() ran again. The capture-phase mousedown fires on every document click and runs e.target.closest('#table-filterbar') each time even when no dropdown is open — a leak-by-design plus avoidable per-click DOM walk.

**Evidence.**

```
document.addEventListener('mousedown', e => {
  if (!e.target.closest || !e.target.closest('#table-filterbar')) { closeAllChipDropdowns(); }
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllChipDropdowns(); });
```

**Suggested fix.** Store handler references on Table so they can be removed, guard init() against double-registration, and skip the closest() check unless at least one chip dropdown is currently open.

**Verification.** Lines 6187-6195 add capture-phase mousedown + keydown with anonymous handlers and no stored reference, and the mousedown runs closest('#table-filterbar') on every document click; the duplicate-on-reinit risk is theoretical since init runs once, but the un-removable listeners and per-click DOM walk are real.

---

<a id="r220"></a>
### R220. _renderHeatmap reads document.body.dark and rebuilds color closures on every render

`app.js:7567-7587, 7871-7885`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** Both heatmap renderers redefine their color-ramp helper functions (lerpRGB/heatBg/heatText, cellBg/cellText) as fresh closures on every render, and the lerpRGB hex-parse path runs per cell (O(lines x days) string slicing + parseInt). This is minor allocation churn rather than a correctness issue, but it is duplicated logic that re-parses constant hex strings for every cell on every render. At 70 lines x 7 days that is ~490 lerpRGB calls per heatmap render, each doing 6 parseInt on hardcoded constants.

**Evidence.**

```
const isDark = document.body.classList.contains('dark'); function lerpRGB(a,b,t){...} ... function heatBg(pct){...} function heatText(pct){...}  // and again, duplicated, in _renderLatenessHeatmap: const isDark = document.body.classList.contains('dark'); function cellBg(h){...} function cellText(h){...}
```

**Suggested fix.** Hoist the palette helpers to module scope (or precompute the RGB tuples once per render outside the per-cell loop) and pass isDark in. The hex endpoints are constants — parse them once, not per cell.

**Verification.** _renderHeatmap (7567-7586) and _renderLatenessHeatmap (7871-7884) each redefine isDark and their color-ramp helper functions as fresh closures per render, with lerpRGB parsing constant hex strings per cell as described.

---

<a id="r221"></a>
### R221. TimelineNav registers window-level mousemove/mouseup/resize listeners and a Store subscription that are never removed; _unsubStore is stored but never invoked

`app.js:8027-8068`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** init() attaches window-level mousemove, mouseup, and resize listeners plus a Store subscription. _unsubStore is captured but there is no teardown/destroy method that calls it or removeEventListener. If init() were ever called more than once (re-init on plant switch / hot reload), listeners stack up and the Store subscription leaks. The mousemove handler also closes over `canvas` and runs on every pointer move globally (guarded by _dragging, so cheap, but always live). Low impact for a single-boot SPA but a latent leak if re-init is ever introduced.

**Evidence.**

```
window.addEventListener('mousemove', e => { ... });
window.addEventListener('mouseup', () => { TimelineNav._dragging = false; });
...
TimelineNav._unsubStore = Store.subscribe(evt => { ... }, 'TimelineNav');
window.addEventListener('resize', Util.debounce(() => TimelineNav.render(), 100));
```

**Suggested fix.** Either guard init() against double-invocation (early-return if TimelineNav._canvas already set) or add a destroy() that calls _unsubStore() and removeEventListener for the named handlers (hoist the handlers to named functions so they can be removed).

**Verification.** init() at 8027-8068 attaches window mousemove/mouseup/resize plus Store.subscribe into _unsubStore (8060), and there is no destroy/teardown method anywhere in the module that calls _unsubStore() or removeEventListener; severity-appropriate as low given single-boot SPA.

---

<a id="r222"></a>
### R222. Multi-inspector panel hardcodes light-mode color, breaking in dark mode

`app.js:9255`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** The multi-selection inspector summary hardcodes color:#666 instead of a CSS design token (e.g. var(--fg-mute)). Per CLAUDE.md the dark-mode layer is incomplete and several newer components hardcode light colors; this is one of them. In dark mode #666 on a dark panel is low-contrast / hard to read. The rest of the panel uses inline literal styles too which is acceptable, but the foreground color specifically regresses in dark mode.

**Evidence.**

```
<div style="font-size:13px;color:#666;margin-bottom:12px;">
```

**Suggested fix.** Replace color:#666 with the existing muted-foreground token, e.g. color:var(--fg-mute), so the summary line follows the theme in both light and dark mode.

**Verification.** The hardcoded `color:#666` is real and present in _showMultiInspector at line 10255 (the finding mis-cited 9255, which is actually the Sandbox undo callback), and CLAUDE.md documents that dark mode is incomplete with hardcoded light colors in newer components.

---

<a id="r223"></a>
### R223. Backend load path runs the master-data fetch as a duplicated 3-way inline block in three places

`app.js:10355-10367, 10397-10409, 10511-10527`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** The exact same master-data fetch-plants+lines / assign masterData / _rebuildPlantIndex / emit sequence is hand-duplicated three times in load(): the no-plant path (10355), the zero-rows path (10397), and the happy path (10511). The bodies are identical apart from the catch message. Beyond maintenance risk (a fix to one — e.g. the production_lines endpoint needs pagination at the 3,500-line scale — must be applied three times), the production_lines fetch itself is an unfiltered full-list query, which CLAUDE.md flags as a scale anti-pattern. Consolidating to one helper makes the eventual server-side filtering fix a one-line change.

**Evidence.**

```
Promise.all([
  fetch(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
  fetch(`${Config.API_BASE}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
]).then(([pData, lData]) => { if (pData || lData) { Store._state.masterData = { plants: pData?.rows ?? [], lines: lData?.rows ?? [] }; Store._rebuildPlantIndex(); Store.emit({ type: 'master-data-changed', source: 'persistence' }); } })
```

**Suggested fix.** Extract a single Persistence._loadMasterData() helper that performs the Promise.all, assignment, _rebuildPlantIndex, and emit, and call it from all three sites. When the scale work lands, add ?plant= scoping (or pagination) to the production_lines fetch in that one place.

**Verification.** The identical Promise.all fetch-plants+lines / assign masterData / _rebuildPlantIndex / emit block is hand-duplicated at 10355-10367, 10397-10409, and 10512-10527, differing only in the catch message — a real DRY/maintainability issue.

---

<a id="r224"></a>
### R224. _post network-retry comment says 'up to 3 times' but performs at most 2 retries (3 attempts total)

`app.js:10895-10912`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** Called as _post(1): attempt 1 schedules _post(2), attempt 2 schedules _post(3), attempt 3 hits attempt >= 3 and throws. That is 3 total POSTs (2 retries), not 'retry up to 3 times' (which reads as 4 attempts). Comment/behavior mismatch that misleads anyone tuning retries. The 2000 ms delay is also fixed, not exponential, unlike the _reconnect watcher.

**Evidence.**

```
// Retry up to 3 times on network failures; don't retry 4xx (server rejections).
      const _post = (attempt) => fetch(...).then(...).catch(e => {
        if (e.httpStatus || attempt >= 3) throw e;
        return new Promise(res => setTimeout(res, 2000)).then(() => _post(attempt + 1));
      });
      _post(1)
```

**Suggested fix.** Change the guard to attempt > 3 for 3 actual retries, or fix the comment to 'retry up to 2 times (3 attempts total)'.

**Verification.** Comment at 10895 says 'up to 3 times' but _post(1) with guard attempt >= 3 (10908) yields attempts 1,2,3 = 3 total POSTs / 2 retries, and the 2000ms delay (10909) is fixed not exponential — a comment/behavior mismatch.

---

<a id="r225"></a>
### R225. App.init wires window-level mousemove/mouseup resize listeners with no teardown; safe today but a leak vector if init can re-run

`app.js:13757-13758, 14166-14181`  ·  **LOW**  ·  _maintainability_  ·  confidence: low

**Why it matters.** _wireResize attaches mousemove/mouseup handlers to window with anonymous closures and never removes them. App.init is intended to run once, so this is not an active leak — but there is no idempotency guard on init(), and each call would stack another pair of always-on window listeners (each running on every mousemove across the whole app). The mousemove handler runs Timeline-relevant width math on every pointer move globally even when not dragging (cheap, early-returns), but the accumulation risk is real if any future code re-invokes init or re-wires panels.

**Evidence.**

```
App._wireResize('left',  document.getElementById('left-sidebar'));
App._wireResize('right', document.getElementById('right-sidebar'));
...
_wireResize(side, el) {
  ...
  window.addEventListener('mousemove', e => { if (!dragging) return; ... });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; ... } });
}
```

**Suggested fix.** Bind the drag move/up listeners only while dragging (attach on mousedown, remove on mouseup) so they are not always-on, and/or guard App.init with an _inited flag. This also removes the global per-mousemove early-return handler.

**Verification.** _wireResize at 14166-14181 attaches anonymous window mousemove/mouseup listeners with no removal and there is no _inited guard on init, so re-invocation would stack always-on global handlers; the finding itself concedes this is not an active leak today, hence low.

---

<a id="r226"></a>
### R226. _renderSettingsPane uses raw fetch instead of the standard Util.fetchTraced wrapper

`app.js:14025-14029, 14122-14126, 14146-14149`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** Util.fetchTraced (app.js:275) is the documented standard fetch wrapper that attaches x-request-id and logs slow/failed requests; the rest of the codebase uses it (e.g. health, diagnostics, logs, audit endpoints all go through Util.fetchTraced). These three calls in _renderSettingsPane bypass it, so the horizon-save, constraint-save, and color-wheel-probe requests are not correlated to backend logs by request id and slow/failed cases are not surfaced through the normal logging path. Additionally the x-user-email actor is hardcoded to a single email literal, which is a separate (spoofable-actor) concern already noted in CLAUDE.md but is also a latent bug if this code is reused for another user.

**Evidence.**

```
await fetch(`${Config.API_BASE}/master-data/plants/bulk`, {
  method:  'POST',
  headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
  body:    JSON.stringify({ upserts: [{ subnetwork: plantRow.subnetwork, plant: plantRow.plant, ...patch }], deletes: [] }),
});
...
await fetch(`${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/constraints`, {...});
...
fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(plantName)}`, { signal: AbortSignal.timeout(4000) })
```

**Suggested fix.** Route all three requests through Util.fetchTraced (preserving the AbortSignal.timeout on the color-wheel probe) for consistent tracing/logging, and replace the hardcoded 'trevor.holton@newellco.com' actor header with the same dynamic actor source used elsewhere in the app.

**Verification.** Lines 14025, 14122, and 14146 use bare fetch() while Util.fetchTraced (275-294) is the standard wrapper attaching x-request-id and logging failures, so these three calls miss request-id correlation; note the finding's secondary fix is partly wrong since fetchTraced injects no actor header, but the core tracing-bypass claim is accurate.

---

<a id="r227"></a>
### R227. MasterData CRUD fetches bypass fetchTraced — no x-request-id correlation, no timeout on column DDL / save / load

`app.js:14281, 14524, 14698, 14771, 14794, 14914, 14944, 14970, 15019`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** Util.fetchTraced is the standard wrapper in this codebase (attaches x-request-id and logs slow/failed requests) and is used 9× elsewhere, but the entire MasterData module — including the destructive DDL endpoints (ADD/DROP/rename column) and the bulk upsert/delete save — calls bare `fetch`. These are exactly the high-impact, DDL-and-data-mutating calls where backend log correlation matters most, yet a failure here cannot be tied to a backend request id (CLAUDE.md notes correlation is already only timestamp-based for frontend logs). The _fkSelect fetch additionally swallows all errors with `.catch(() => {})`, so a failed parent-table load leaves the dropdown permanently blank with no log entry. None of these calls carry a timeout/AbortSignal either (unlike the post-save Store refresh which does use AbortSignal.timeout(5000)).

**Evidence.**

```
const data = await fetch(`${API}/master-data/${table}`).then(r => {...});  // _loadAndRender
fetch(`${API}/master-data/${sourceTable}`).then(r => r.json())...            // _fkSelect (errors swallowed: .catch(()=>{}))
await fetch(`${API}/master-data/${table}/bulk`, {...})                        // _save
await fetch(`${API}/master-data/${table}/columns`, {...})                     // _openAddColumn DDL
await fetch(`${API}/master-data/${table}/columns/${col.column_name}`, {...})  // _dropColumn / rename
```

**Suggested fix.** Route MasterData fetches through Util.fetchTraced for request-id propagation and slow/error logging; at minimum, log the _fkSelect parent-load failure via ErrorLog.warn instead of swallowing it, and add an AbortSignal.timeout to the DDL/save calls.

**Verification.** All cited lines (14281,14524,14698,14771,14794,14914,14944,14970) use bare fetch (fetchTraced is used 9x elsewhere), the _fkSelect load swallows errors with .catch(()=>{}) at 14535, and the DDL/save calls carry no AbortSignal.

---

<a id="r228"></a>
### R228. ~850 lines of component CSS embedded as inline <style> in index.html instead of styles.css

`index.html:49-900`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** The <head> carries one large inline <style> block (lines 49-900, ~850 lines) defining whole component systems — .dash-filter-* , .hm-* heatmap, .lh-* lateness heatmap, .opt-pv-* optimizer preview, .ls-* line status — that logically belong in styles.css. This block is NOT cache-busted by the styles.css?v= query string (it ships with the HTML document, which has its own caching), splits the design system across two files, and duplicates the design-token fallback pattern. It also hardcodes hex colors (e.g. .dash-filter-bar border #e8e4dc at line 57, .hm-sticky background #ffffff at 175) that bypass the token system and have only partial body.dark coverage.

**Evidence.**

```
<style>
/* ── Dashboard Filter Bar ───────────────────────────────────── */
.dash-filter-bar { ... }
... (Dashboard filter bar, Utilization Heatmap, Projected-Lateness Heatmap, Optimizer Impact Preview, Line Status Panel) ...
body.dark .ls-co       { color: var(--fg-mute); }
</style>
```

**Suggested fix.** Migrate the entire <style> block into styles.css (it is already versioned via ?v=), replacing hardcoded hex values with the existing design tokens (--line, --bg-elev, --fg-mute, etc.) so dark-mode coverage and cache-busting are consistent.

**Verification.** The inline <style> spans lines 49-900 (~851 lines) of component CSS with hardcoded hex like #e8e4dc (57) and #ffffff (175); the migration recommendation is a maintainability judgment but the factual claim is accurate.

---

<a id="r229"></a>
### R229. Pervasive inline onclick/oninput handlers couple markup to global NIMBUS namespace and block any future CSP

`index.html:948, 965, 1069-1088, 1883, 2016`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium  ·  **⚖️ needs-human-judgment**

**Why it matters.** Nearly every interactive control wires behavior via inline onclick/oninput/onchange attributes referencing the global NIMBUS object (dozens of occurrences across the topbar, gantt toolbar, all modals). This hard-couples HTML structure to JS module method names (rename a method and the markup breaks silently with no build-time check), and makes the document incompatible with a strict Content-Security-Policy (no script-src 'unsafe-inline' would disable every button). CLAUDE.md notes hosted deployment and optional auth are planned; a CSP is a natural next step and inline handlers would have to be removed wholesale at that point. There is currently no CSP meta tag (confirmed: no http-equiv match), so nothing is broken today — this is forward risk and maintainability.

**Evidence.**

```
<button class="btn btn-primary" data-i18n="btn.save" onclick="NIMBUS.Persistence.saveAll()">Save</button>
...
<div class="modal-backdrop opt-backdrop" id="modal-optimize" hidden
     onclick="if(event.target===this)NIMBUS.OptimizeDialog.close()">
```

**Suggested fix.** Incrementally migrate inline handlers to delegated listeners in app.js keyed off data-* attributes (the codebase already uses data-tab, data-action, data-gantt-sub patterns). At minimum, do this before introducing a CSP for hosting.

**Verification.** Inline onclick handlers referencing NIMBUS confirmed (e.g. line 948, 1883) and no CSP meta tag exists, but as the finding itself states nothing is broken today — acting on it is a forward-looking maintainability/architecture choice.

---

<a id="r230"></a>
### R230. list_rows ORDER BY assumes the first N display columns are exactly the key columns — latent coupling that silently mis-sorts if column_order is ever edited

`master_data.py:124-126`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** col_names comes from column_metadata ordered by column_order (lines 90, 107). The ORDER BY then slices the first len(keys) of those DISPLAY-ordered columns and treats them as the sort key — implicitly assuming the key columns always occupy column_order positions 1..N. That holds for all five seeded tables today (schema.sql lines 281-302), so it is not an active bug, but it is a hidden invariant: the rename/reorder DDL surface and column_metadata.column_order are user-editable, and add_column appends with MAX(column_order)+1. If an admin ever reorders columns so a non-key column sorts before a key column, the page ordering silently stops being key-ordered, which can make LIMIT/OFFSET pagination return overlapping or skipped rows across pages. The intent (sort by the actual key columns) should not depend on display order. The `list(...).__len__()` call is also a convoluted way to write len().

**Evidence.**

```
+ sql.SQL(" ORDER BY {order}").format(
    order=sql.SQL(", ").join(sql.Identifier(c) for c in col_names[:list(_KEY_COLUMNS[table]).__len__()]),
)
```

**Suggested fix.** Order by the real key columns intersected with visible columns, independent of display order: build the ORDER BY from `[c for c in sorted(_KEY_COLUMNS[table]) if c in col_names]` (falling back to all col_names if empty), and replace `list(...).__len__()` with `len(...)`.

**Verification.** Lines 124-126 slice col_names[:len(keys)] (display order) as the ORDER BY; verified against schema.sql column_metadata (lines 281-301) that all five tables currently have keys in the first column_order positions, so it is a latent invariant not an active bug, matching the finding's low severity.

---

<a id="r231"></a>
### R231. list_rows ORDER BY key-column slice computed via convoluted list().__len__() call

`master_data.py:124-126`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** `col_names[:list(_KEY_COLUMNS[table]).__len__()]` is a needlessly convoluted way to slice off the first N columns where N is the number of key columns. `_KEY_COLUMNS[table]` is a frozenset, so `len(_KEY_COLUMNS[table])` is already O(1) and direct — wrapping it in `list(...)` allocates a throwaway list and calling `.__len__()` explicitly instead of `len()` is non-idiomatic. More importantly this couples the ORDER BY to a positional assumption (that the first len(keys) entries of col_names are the key columns in display order), which is not guaranteed by the column_metadata ORDER BY (column_order, column_name) and could silently order by non-key columns if metadata ordering ever changes.

**Evidence.**

```
+ sql.SQL(" ORDER BY {order}").format(
    order=sql.SQL(", ").join(sql.Identifier(c) for c in col_names[:list(_KEY_COLUMNS[table]).__len__()]),
)
```

**Suggested fix.** Replace with an explicit, intent-revealing ORDER BY over the actual key columns: order by `sorted(_KEY_COLUMNS[table])` (the same keys bulk_apply uses), filtered to those present in col_names, rather than a positional slice. At minimum, write `len(_KEY_COLUMNS[table])` instead of `list(...).__len__()`.

**Verification.** Line 125 literally contains `col_names[:list(_KEY_COLUMNS[table]).__len__()]`, a throwaway list allocation plus explicit dunder call where len() suffices; the maintainability/idiom point is accurate.

---

<a id="r232"></a>
### R232. idx_orders_line_eff_start duplicated across schema.sql and migration_perf.sql; non-CONCURRENT build blocks writes at target scale

`migration_perf.sql:18-19`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** The exact same index (same name, same expression) is created in both schema.sql lines 51-52 and migration_perf.sql lines 18-19. Both use CREATE INDEX IF NOT EXISTS so re-running either is harmless today, but the duplication means a future change to the expression in one file (e.g. adding plant as the leading column for plant-scoped /tasks) can silently diverge from the other — whichever ran first wins via IF NOT EXISTS, masking the drift. Separately, migration_perf.sql's header claims CONCURRENTLY is 'not needed for a small table'; at the 3,500+ line / large-orders target scale this non-CONCURRENT build takes a table lock blocking writes during live /tasks traffic.

**Evidence.**

```
CREATE INDEX IF NOT EXISTS idx_orders_line_eff_start
  ON orders(production_line, COALESCE(scheduled_start, basic_start_date));
```

**Suggested fix.** Treat schema.sql as the single source of truth for this index and retire migration_perf.sql (or have it reference schema.sql). Update the 'CONCURRENTLY not needed' note — at target scale, build large-table indexes with CREATE INDEX CONCURRENTLY to avoid blocking the live /tasks write path.

**Verification.** schema.sql lines 51-52 and migration_perf.sql lines 18-19 create the identical index (same name and COALESCE expression), and migration_perf.sql's header (line 16) explicitly claims CONCURRENTLY is not needed, which does not hold at the 3,500+ line target scale.

---

<a id="r233"></a>
### R233. 'Reload Data' command sub-text claims 'Re-read Excel' though runtime data is Postgres-backed -- stale, misleading copy

`nimbus-intelligence.js:905`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** Per CLAUDE.md the runtime data source is Postgres, not Excel ('Orders live in Postgres, not Excel ... brain.py is stateless'), and POST /reload only refreshes the color-wheel file cache -- it does not reload orders. The sub-text 'Re-read Excel (discards in-memory edits)' describes behavior that no longer exists and could mislead operators about whether in-memory edits are at risk.

**Evidence.**

```
{ type:'action', label:'Reload Data', sub:'Re-read Excel (discards in-memory edits)', icon:'↺', run(){ CommandPalette.close(); NIMBUS.Persistence?.reload?.(); } }
```

**Suggested fix.** Update the sub-text to reflect actual behavior (e.g. 'Refetch from server / reload caches') and confirm Persistence.reload exists and matches the label; otherwise remove the command.

**Verification.** Line 905 sub-text reads 'Re-read Excel (discards in-memory edits)' but Persistence.reload (app.js:10993-10996) force-loads from the backend/Postgres, so 'Excel' is inaccurate per CLAUDE.md's 'Orders live in Postgres' (the 'discards edits' clause is roughly accurate via force load).

---

<a id="r234"></a>
### R234. Patterns._pairs grows without bound and writes localStorage synchronously on every timeline drag

`nimbus-intelligence.js:2027-2041`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** Every `task:update` from the timeline triggers a synchronous JSON.stringify + localStorage.setItem of the entire _pairs map. The map is never pruned or capped, so over months of use it accumulates an entry per distinct COLOR-pair ever observed and the stringify cost grows with it. The threshold-toast uses strict `=== _THRESHOLD`, so it fires exactly once at the 4th observation (intended), but there is no eviction policy. At scale with many colors this is a slow unbounded localStorage write on the drag hot path.

**Evidence.**

```
_observe(movedId) {
  ...
  const key  = `${Util.norm(prev.COLOR)}→${Util.norm(task.COLOR)}`;
  Patterns._pairs[key] = (Patterns._pairs[key] || 0) + 1;
  localStorage.setItem(Patterns._LS_KEY, JSON.stringify(Patterns._pairs));
  if (Patterns._pairs[key] === Patterns._THRESHOLD)
    Toast.show(t('toast.pattern_detected', { key }), 'info', 4500);
}
```

**Suggested fix.** Cap the map (e.g. keep top-N by count, evict least-frequent) and debounce the localStorage write rather than writing on every drag. Persisting to IntelDB (already available) off the main thread would also remove the synchronous serialize cost.

**Verification.** _observe (lines 2027-2041) does JSON.stringify(Patterns._pairs)+localStorage.setItem on every timeline task:update with no eviction or cap, and the threshold toast uses strict === _THRESHOLD as described; low severity is appropriate.

---

<a id="r235"></a>
### R235. Near-capacity branch condition is structured differently in worker vs app.js (gate moved into the else-if test)

`nimbus-worker.js:280-285`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** app.js (3649-3651) enters the else-if whenever `effCap > 0 && hours > effCap * WARN_THRESHOLD` and then gates only the push inside `if (Config.SHOW_NEAR_CAPACITY_ALERTS)`. The worker instead folds SHOW_NEAR_CAPACITY_ALERTS INTO the else-if condition. With the current flag value (false) the two are behaviorally identical: when SHOW is false, app.js enters an empty else-if and does not fall through to the `cap === 0` branch, while the worker skips the else-if and falls to `cap === 0 && hours > 0` — but `effCap > 0` implies `cap > 0`, so that branch is false anyway. So no current behavioral divergence. However, this is a structural deviation from a file that is supposed to mirror app.js line-for-line, so a future edit to either side (e.g. flipping the flag, or adding a real near-capacity vs closed interaction) could make them diverge. Flagging for fidelity, not for present-day impact.

**Evidence.**

```
} else if (SHOW_NEAR_CAPACITY_ALERTS && effCap > 0 && hours > effCap * WARN_THRESHOLD) {
        alerts.push({ id: `warn-day-${line}-${day}`, sev: 'warn', type: 'near-capacity', ... });
```

**Suggested fix.** Mirror app.js exactly: keep the else-if condition as `effCap > 0 && hours > effCap * WARN_THRESHOLD` and gate the push with an inner `if (SHOW_NEAR_CAPACITY_ALERTS)`. Keeps the two control-flow graphs identical so future edits stay in lockstep.

**Verification.** Worker line 280 folds `SHOW_NEAR_CAPACITY_ALERTS` into the else-if test while app.js:3649-3651 keeps the condition flag-free and gates only the push; the structural deviation is real but, as the finding states, behaviorally identical with the flag currently false — a fidelity/maintainability nit, not a present bug.

---

<a id="r236"></a>
### R236. Worker hardcodes day-length literal 86400000 instead of mirroring Config.MS_DAY used in app.js computeMatrix

`nimbus-worker.js:444`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** app.js Utilization.computeMatrix (4273) uses `const dayEndMs = dayStartMs + Config.MS_DAY;` where Config.MS_DAY is defined as 24*60*60*1000 = 86400000 (app.js:73). The worker uses the bare literal 86400000. Numerically identical today, so this is NOT a behavioral bug. But the worker does not define any MS_DAY constant in its Config mirror block (lines 20-24 only mirror OVERLOAD_THRESHOLD/WARN_THRESHOLD/SHOW_NEAR_CAPACITY_ALERTS/DEFAULT_SHIFT/WEEKEND_OFF), so a reader cross-checking against app.js cannot grep the constant and confirm parity. The same applies to the closed-day diagnostic which uses dayEnd.setDate(+1) (DST-safe) on line 295 while computeUtilization uses a fixed-ms day — but app.js has the exact same asymmetry, so that is matched, not drift.

**Evidence.**

```
const dayEndMs   = dayStartMs + 86400000;
```

**Suggested fix.** Add `const MS_DAY = 24 * 60 * 60 * 1000;` to the worker Config-mirror block and use it at line 444, matching app.js's named-constant usage so parity is grep-verifiable.

**Verification.** Worker line 444 uses the bare literal `86400000` whereas app.js:4273 uses `Config.MS_DAY` (defined =86400000 at app.js:73), and the worker's Config-mirror block (lines 20-24) defines no MS_DAY, so parity is not grep-verifiable; numerically identical today, a low-severity maintainability point.

---

<a id="r237"></a>
### R237. labor_plan_line has no foreign key to plants/production_lines, allowing orphan labor rows on plant/line delete

`schema.sql:249-259`  ·  **LOW**  ·  _maintainability_  ·  confidence: medium

**Why it matters.** labor_plan (lines 217-228) declares FOREIGN KEY (subnetwork, plant) REFERENCES plants ON DELETE CASCADE, but its sibling labor_plan_line declares NO foreign key at all — neither to plants(subnetwork, plant) nor to production_lines(subnetwork, plant, production_line). Deleting a plant or production line (which cascades through plants/production_lines) leaves orphan per-line labor rows in labor_plan_line that nothing cleans up, and the cascade-delete preview the admin UI shows will under-count affected rows. Inconsistent with the explicit cascading FK on labor_plan and on production_lines itself.

**Evidence.**

```
CREATE TABLE IF NOT EXISTS labor_plan_line (
    subnetwork      TEXT    NOT NULL,
    plant           TEXT    NOT NULL,
    production_line TEXT    NOT NULL,
    day             TEXT    NOT NULL,
    avail_hours     NUMERIC,
    source          TEXT    NOT NULL DEFAULT 'auto_split',
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subnetwork, plant, production_line, day)
);
```

**Suggested fix.** Add FOREIGN KEY (subnetwork, plant, production_line) REFERENCES production_lines(subnetwork, plant, production_line) ON DELETE CASCADE ON UPDATE CASCADE to labor_plan_line, matching the cascade semantics already used on labor_plan and production_lines.

**Verification.** schema.sql lines 249-259 define labor_plan_line with only a PRIMARY KEY and no FOREIGN KEY, whereas labor_plan (226-227) and production_lines (114-115) both carry cascading FKs, so plant/line deletes orphan per-line labor rows.

---

<a id="r238"></a>
### R238. Admin tab tint tokens (--tab-admin-bg / --tab-admin-bg-hover) not redefined in dark mode

`styles.css:59-60, 4136`  ·  **LOW**  ·  _maintainability_  ·  confidence: high

**Why it matters.** In body.dark, --tab-md-bg and --tab-md-bg-hover are redefined for dark mode (line 4136), but --tab-admin-bg and --tab-admin-bg-hover are NOT. The Admin Cockpit tab (.tab-btn[data-tab="admin"], styles.css 142-153) therefore keeps the light-mode #f3f4f6 / #e5e7eb gray backgrounds in dark mode, producing a bright light-gray chip in the otherwise dark top bar while the Master Data tab correctly turns dark green. Inconsistent dark-mode treatment between the two specially-tinted tabs.

**Evidence.**

```
:root { ... --tab-admin-bg: #f3f4f6;   /* Admin tab tint (light) */
  --tab-admin-bg-hover: #e5e7eb; ... }

body.dark { ... --tab-md-bg: #1c3d28;  --tab-md-bg-hover: #224830;  /* Master Data tab — dark green in dark mode */ ... }
```

**Suggested fix.** Add to body.dark: `--tab-admin-bg: #20222c; --tab-admin-bg-hover: #2a2d3a;` (dark slate counterparts), mirroring how --tab-md-bg is handled.

**Verification.** --tab-admin-bg/-hover are only defined in :root (lines 59-60) while body.dark redefines --tab-md-bg at line 4136 but not the admin tokens, so the admin tab keeps its light #f3f4f6 tint in dark mode.

---

# Refuted findings (false-positives)

These were raised by a reviewer but **refuted** by the adversarial verifier against live code — recorded so they are not re-raised.

- **Aggregate KPI 'Required' uses the global-keyed utilization memo that CLAUDE.md flags as plant-collision-prone** (`app.js:2344-2352`) — _renderKPIs (2346) does call the unscoped memoized computeMatrix, but it then filters to plantLines via masterData (2347-2351) so totalRequired only sums this plant's lines regardless of which producer wrote the global matrix; the prewarm (4389) only writes a days=7 key, not the days=90 KPI key, so the specific cross-plant 'sums an unrelated plant' collision described does not occur here.
- **Worker alerts path can re-surface an alert dismissed while the worker round-trip was in flight** (`app.js:3548-3562`) — The finding's premise is wrong: Store.dismissAlert (905-910) calls this.emit(), and emit() at line 597 bumps this._rev on every event, so a dismissal during the round-trip changes Store._rev and the stale guard at 3552 (Store._rev !== reqRev) returns early, discarding the worker result rather than re-inserting the dismissed alert.
- **Confidence.init arity-0 monkey-patch silently degrades every scheduled incremental recompute to a full all-lines pass** (`app.js:4191-4198`) — The actual patch in nimbus-intelligence.js:1308 is Alerts.recompute = (...args) => { const r = origRecompute(...args); ... } which forwards all arguments, so opts.lines is preserved; the arity-0 claim matches the stale CLAUDE.md note, not the current code (only one patch site exists).
- **EditCalendar disables alt inputs via a general-sibling DOM selector instead of the flatpickr.altInput handle** (`app.js:3163-3170`) — In the actual markup (index.html:2174-2178) each .cal-day-times holds start-original, start-alt, separator, end-original, end-alt; querySelector('#cal-edit-start-d ~ input.flatpickr-input') returns the first following sibling (start's alt) and '#cal-edit-end-d ~ ...' returns end's alt, so the described mis-targeting does not occur — the finding admits it is unverified/latent, and it does not manifest here.
- **Plant-blackout loop clones the block item per line with a largely redundant per-line plant guard** (`app.js:5790-5798`) — plantBlocks is a single global array tagged per-plant (line 563), so the getPlantForLine(line) !== plant guard at 5794 prevents one plant's blackout from rendering on visibleLines of the selected plant when plantBlocks holds other plants' blocks; the suggested fix to drop the guard would cause cross-plant blackout bleed, and the spread cost is negligible.
- **_openAddColumn / _openRenameLabel re-bind confirm-button onclick each open without removing prior handler scope, capturing stale {table,col}** (`app.js:14892-14930, 14965-14985`) — At 14892/14965 onclick is reassigned with = (overwrite, no accumulation) closing over the current table/col, and the finding itself concedes this is safe today and 'not a confirmed live bug' — the described failure requires a hypothetical future non-_openAddColumn open path, so no defect is present in current code.

# Coverage gaps (recommended follow-up passes)

- Whole-program undeclared-variable / linter pass: findings 75 (undefined `a`) and 99 (variable shadowing of `t`) were caught incidentally. A full static-analysis/ESLint pass on the ~15k-line app.js is warranted — these two suggest more latent reference/shadowing bugs exist that ad-hoc review missed.
- Concurrency model review: findings touch FOR UPDATE lock ordering / deadlock (209), lost-rows-counted-as-success (203), and last-writer-loses reconciliation, but there is no end-to-end review of the optimistic-concurrency + multi-worker model under genuine concurrent saves (xmin/base_version semantics, retry behavior, the per-process log ring buffer not shared across replicas).
- Database index / EXPLAIN review: many backend perf findings are about full scans (186-188, 197, 198, 210, 218) and an index that is duplicated/non-CONCURRENT (226), but no finding analyzes the actual query plans or whether indexes exist for the ?plant=/?line= server-side scoping that the scale target requires. An EXPLAIN ANALYZE pass at target row counts is needed.
- Accessibility audit: only one finding (231, pinch-zoom blocked) touches a11y, flagged needs-human-judgment. Keyboard navigation, ARIA, focus management for the many modals/dropdowns, and color-contrast in both themes are entirely uncovered.
- Localization completeness: findings 44 and 165 are isolated i18n catches; there is no systematic sweep for untranslated hardcoded strings across the 5 locales, nor verification that locale maps are complete/consistent.
- Test coverage / verification harness: MEMORY notes httpx/TestClient are absent and Postgres often not running. There appear to be no automated tests covering the data-integrity bugs found (plant attribution, cascade preview, concurrency). A test-harness bootstrap is a prerequisite for safely fixing the high-severity DB findings.
- Memory-growth / unbounded-buffer review: Patterns._pairs (170), _lineData cache never pruned (24), audit file unbounded (198), and TimeMachine snapshot bloat (160,161,173) hint at a broader unbounded-growth class not systematically audited (IndexedDB snapshot retention, localStorage size limits at scale).
- Backend error-isolation and failure-mode review: 194 (one failing probe 500s the whole diagnostics panel) and 183 (swallowed color-wheel exceptions) suggest endpoint-level error-handling consistency was not reviewed as a class.
- nimbus-intelligence.js depth: the intel layer got two passes (intel:1, intel:2) producing many overlapping perf findings, but its correctness interaction with the core Store/Undo/Alerts contract (monkey-patching, snapshot duplication, IndexedDB key corruption 151/167) deserves a dedicated architectural review rather than line-level findings.
- CSS/HTML received light coverage (only ~11 findings for ~5k-line styles.css + ~850 inline lines): a fuller token-audit (undefined vars, dark-mode parity matrix, the inline-style migration) and a CSP-readiness review of the pervasive inline handlers (234) are under-represented.

---

# Appendix A — ESLint static-analysis pass (machine-found, complementary)

A flat-config ESLint gate was added (`eslint.config.js`, `npm run lint`) tuned for the no-build IIFE/global-`NIMBUS` style — `no-undef`, `no-unused-vars`, `no-shadow`, `no-dupe-keys`, `no-redeclare`, `no-const-assign`, etc. It found **70 issues (42 errors, 28 warnings)** that are *complementary* to the prose review above — different bug classes, almost no overlap.

**What the linter caught that prose review missed, and vice-versa:**
- `no-undef` = **0**. The two reference bugs the review found by hand (R-rank for #75 undefined `a`, #99 shadowed `t`) are **invisible to ESLint**: #75 lives inside an inline `onclick` *string literal* (not parsed as code), and #99 shadows a config-injected global (`no-shadow` only flags it with `builtinGlobals:true`, which is too noisy against browser globals). → **Both tools are necessary.**

## A.1 — Duplicate object keys (`no-dupe-keys`) — 42 errors, NEW bug class 🟠

Duplicate keys in the i18n string maps: the **later key silently wins**, so the earlier translation is dead and the maps are internally inconsistent. Not surfaced by the original review (locale files were not deep-linted). Fix: delete the duplicate entries (keep the intended translation).

| File | Duplicated keys (line) |
|:-----|:-----------------------|
| `locales/en.js` (3) | `ui.loading` (536, 902) · `btn.close` (882) |
| `locales/de.js` (9) | `ui.loading` (352, 927) · `ui.working_hours` (497) · `ui.line_blackouts` (498) · `ui.bottleneck` (503) · `ui.excl_optimizer` (504) · `ui.buffer_label` (505) · `btn.close` (700) · `empty.no_log_entries` (704) |
| `locales/fr.js` (9) | same key set as de.js (352/497/498/503/504/505/700/704/927) |
| `locales/pt.js` (9) | same key set as de.js (352/497/498/503/504/505/700/704/927) |
| `locales/es.js` (12) | `ui.loading` (356, 930) · `ui.working_hours` (501) · `ui.line_blackouts` (502) · `ui.bottleneck` (507) · `ui.excl_optimizer` (508) · `ui.buffer_label` (509) · `btn.save_note` (700) · `btn.cancel_note` (701) · `btn.discard_changes` (702) · `btn.close` (704) · `empty.no_log_entries` (708) |

## A.2 — Dead / unused variables (`no-unused-vars`) — 28 warnings 🟡

Augments the review's `unused-code` findings with specific dead locals:
- `app.js`: `STEP` (1104), `lines` (6042), `next7` (6317), `color` (6650), `dimCount` (8448), `rect` (8532), `neutral` (9013) — assigned but never read.
- `nimbus-intelligence.js:24-25`: `Modal`, `Engine`, `Sandbox`, `Config`, `Calendar`, `Timeline` destructured from `NIMBUS` but never used — dead aliases.
- 8 × `catch (e)` where `e` is unused (app.js 3462/4115/10720/15067, intel 2080/2081, etc.) — relates to the swallowed-exception / error-isolation theme (#183/#194). Either log `e` or use optional-catch-binding `catch {}`.
- Several throwaway `_` placeholders (not args) flagged — harmless; can be silenced via a config `varsIgnorePattern: '^_'` if desired.

## A.3 — Variable shadowing (`no-shadow`) — 2 warnings 🟡

- `app.js:3414` — `open` shadows an outer `open` declared at 3301:14.
- `app.js:5791` — `plant` shadows an outer `plant` declared at 5726:13. (Same region as refuted FP "Plant-blackout loop clones the block per line" — worth a glance since the shadow could mask the intended outer `plant`.)

> **Recommended:** wire `npm run lint` into CI / pre-commit so `no-dupe-keys`, `no-undef`, and `no-const-assign` (all set to `error`) block regressions. The config deliberately keeps `no-unused-vars`/`no-shadow` at `warn` to avoid blocking on the existing backlog.

