# Progress ledger: Admin Diagnostics rail (jump-rail sections + exact-section deep links)

Branch `feature/admin-diagnostics-rail`, worktree `.claude/worktrees/admin-diagnostics`, HEAD at start 00d512c (main). Spec `docs/superpowers/specs/2026-10-30-admin-diagnostics-design.md`; plan `docs/superpowers/plans/2026-10-30-admin-diagnostics.md`; plan of record `C:\Users\PJ29587\.claude\plans\i-want-to-re-do-kind-falcon.md`. Nothing pushed or deployed without the owner's word.

| Wave | Model | Scope | Status |
|---|---|---|---|
| W0 | Sonnet | spec, plan, ledger | done |
| W1 | Sonnet | `diag-sections.mts` + test + locale keys x5 + `.gitignore` twin (T1, T2) | pending |
| W2 | Sonnet | Diagnostics restructure: markup, rail, scroll-spy, headers, `_diagOpen`, summary-strip deletion, Refresh consolidation, Emitted dedupe, CSS, i18n sweep (T3) | pending |
| W3 | Sonnet | Deep links: `gotoSub` opts, pending anchor/reveal, anchor map, `linkAnchor`, Jobs/SAP `showTab`, `logs.open` fix, tests (T4) | pending |
| W4 | Sonnet (owner: "have sonnet do everything. Go!"; not Fable) | Chrome design pass punch list, Sonnet apply, fresh Sonnet branch review (T5, T6 docs) | pending |
| Final | Sonnet | full gates, merge to local main `--no-ff` | pending |

## Facts recorded by the orchestrator

- Scroll container is `.admin-scroll` (`flex:1; overflow:auto`, `styles.css:2999`); `html, body` are `overflow:hidden`; no sticky header above the sub-tab strip. Rail is sticky like `.ulog-rail` (`styles.css:6414`): `top:12px; max-height:calc(100vh - 24px); overflow:auto`; sections carry `scroll-margin-top:12px`; `scrollIntoView` needs no container special-casing.
- Jobs inner tabs: `jobs-pane.mts` `_setTab(tab)` at :1047 is already on the exported object (:1196) as a test seam; `render()` is async (:1178). Add public `showTab(tab: 'jobs'|'runs'|'upcoming'|'templates')` beside `openRun`; reveal `#jobs-view-<tab>`. `openRun` keeps `gotoSub('jobs')`, `await render()`, `openRun(id)`.
- SAP inner tabs: `frontend/integration/sap-interface-ui.mts` renders inner tabs `overview|staging|mapping|history` into `#sap-tabbody` (JS-built, no static cards); batches list `#sap-stage-batches`, outbound panel `#sap-stage-outbound` (~:1150-1160, :1425); internal deep link sets `_selected`/`_tab` (:1776-1780). Add public `showTab(tab, objectKey = 'orders')`; fall back to `#sap-tabbody` when no staging panel.
- Anchor grammar: DOM id (`diag-db-conn`, `admin-audit`) or `<pane>:<innerTab>` (`jobs:runs`, `jobs:jobs`, `sap:staging`).
- `admin-ui.test.mjs` fakes the DOM by hand: `fakeNode()` :29, `withFakeDom` :44, `els` map + `document = { getElementById }` :141, `stubAll(ALL_RENDERERS)` :173-201.
- No backend change: `/diagnostics/db` and `/diagnostics/deep` unchanged; no pytest, no migration.
- Local test env: `nimbus_frontend_audit` DB (`PG_HOST=localhost`, `PG_DB=nimbus_frontend_audit`, `PG_USER=postgres`, password from the owner, `NIMBUS_TEST_DB=1`, bootstrap admin `designadmin`), env vars on the process, never a worktree `.env`.

## Entries

2026-10-30 | W0 | c33d35a | spec (168 lines), plan (6 tasks, 224 lines), ledger written | resolved: Sonnet (not Fable) does the W4 design pass per owner's 'have sonnet do everything'; plan translation table is ASCII-folded with an accent-restoration note; btn.vacuum_analyze and thread.col_p50/p95 already exist so not re-added | deferred: none
2026-10-30 | W1 | 0f3b007 + i18n commit | diag-sections.mts + 19 tests (all pass), 38 locale keys x5 (btn.export_bundle, aria.help already existed, kept), overview-locales 5 + locale-completeness 37 pass | resolved: inclusive >= boundaries for conn 30 s / slow 100,500 ms / errors-per-min 10 (signals.mts uses > for the first three; Overview and Diagnostics differ only at the exact value); optional DiagInputs.pingMs added for the Server light; 24-char guard covers diag.short_* + diag.rail_sections only (existing titles es/fr/pt db_deep_dive, thread.title exceed 24, truncate by CSS) | deferred: none
