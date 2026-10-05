# SDD ledger — plan: docs/superpowers/plans/2026-10-01-distribution-low-risk-fixes.md

Spec: Distribution_Audit_10_01.md (main checkout, untracked). Base for both tracks: main @ c00ea70.
Worktrees: /c/Users/PJ29587/nimbus-wt/dist-backend (fix/dist-audit-backend), /c/Users/PJ29587/nimbus-wt/dist-frontend (fix/dist-audit-frontend).
Throwaway PG: 127.0.0.1:55439, data dir <scratchpad>/pg-dist, db nimbus_test (schema.sql applied). Stop at X3.

## Setup
Task B0: complete (worktree + PG + schema applied; baseline pending → see below)
Task F0: complete (worktree + node_modules junction; baseline pending → see below)

## Pre-flight scan

| Pair / task | Shared file or interface | Finding | Ruling |
|---|---|---|---|
| B3 ↔ B4 | data.py `_plan_core` | B3 adds the D03 zero-weights check before `_plan_one_parent`; B4 restructures `_plan_core` to move the conflict filter after classification | B4 dispatch must preserve B3's zero-weights branch (carried in the dispatch) |
| B3 ↔ B7 | data.py `reset_one_header` | B3 adds `weights_empty` raise; B7 adds `require_unreviewed` + dry-run `for_update` | Sequential; B7 dispatch notes B3's raise exists |
| B6 ↔ B7 | data.py `_write_reweight_shares` / `reset_one_header` | B6 clears `purged_at` in shares upsert; B7 touches lock/review | Disjoint functions; no conflict |
| B1 ↔ B2 | routes.py error mapping | B2 maps `unknown_machine`/`weight_invalid` to 400 via `_distribution_error` | Fine; B2 reuses B1's file state |
| B4/B5/B6/B8 | db.py | Different functions (upsert_orders, ingest_orders_from_excel, purge_orders_by_date, new `_like_contains`) | Sequential; no conflict |
| B8 (D13) ↔ F4 | API: list `meta.truncated: bool`, summary `truncated: bool` | Cross-track interface | Pinned: list response `meta.truncated` (bool); F4 reads `data.meta?.truncated === true` |
| B1/B2/B3 ↔ F10 | error codes → `err.dist_<code>` locale keys (pane `distErrorLocaleKey`) | Plan F10 lists `err.dist_unknown_machine`, `err.dist_weight_invalid`, `err.dist_base_version_required`, `err.dist_too_many_orders` but NOT `weights_empty` (frontend Reset can hit it) or `reviewed_required` | Ruling: F10 also adds `err.dist_weights_empty` and `err.dist_reviewed_required` — the pane maps any server code to a key; a missing key renders raw — cost if wrong: two unused keys |
| F4 ↔ F10 | `ui.dist_list_truncated` | F4 uses the key before F10 adds it; `tests/js/locale-keys.test.js` may fail at F4 | Ruling: F4 adds the en.js key itself; F10 adds de/es/fr/pt — cost if wrong: none |
| F2 ↔ F3 ↔ F4 ↔ F10 | distribution-pane.mts | F2 extracts `_postReview`; F3 changes `_runWritePipeline` to `Promise<boolean>` + `_latched`; F4 list fetch seq; F10 string swaps | Sequential; each dispatch told the prior task's new helpers |
| F3 | shares-editor.mts + harness fixture | Plan mandates updating `distribution-write-conflicts.test.mjs` fixture in same commit | OK (consistent) |
| F5 ↔ F6 ↔ F10 | orders.mts | F5 `_onStore`/Override; F6 sibling map in renderer/Inspector; F10 toast label | Disjoint regions; sequential |
| F6 ↔ F9 | `Store.siblingsByParent()` | F9 D52 consumes F6's map | F9 after F6 (already ordered) |
| F4 ↔ F8 | master-data/admin-ui.mts | F4 combobox listener mirror; F8 WorkCenters write/autosave | Disjoint regions |
| Each task self-consistency | — | Checked file lists vs touched files for B1–B9, F1–F11: consistent. B2's "add locale key note for Track F" is informational (F10 owns keys) | — |

## Rulings
Ruling: run Track B and Track F concurrently (one implementer per track at a time) — separate worktrees/branches with disjoint file sets remove the conflict the skill's "never parallel" rule guards against — cost if wrong: a merge conflict at X1, resolved by a Sonnet subagent.
Ruling: implementers commit their own work (skill default) instead of the plan's "orchestrator commits at the gate", with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — keeps the per-task BASE..HEAD review package intact — cost if wrong: none (history only).
Ruling: task reviewers run on Sonnet (mid-tier floor per skill; diffs are small and scoped), escalation/final review on Opus — cost if wrong: a subtle defect slips to the final Opus review.

## Baselines
Backend baseline (c00ea70, full `pytest tests/`, test DB): 767 passed, 1 skipped (test_data_integrity.py:226 placeholder — pre-existing), 19 warnings, 0 DB skips.
Frontend baseline (c00ea70): build ok; test:legacy 37/37; test:modules 872/872; typecheck ok; lint 0 errors / 46 warnings; legacy-surface ok; static-assets ok.

## Tasks
Task B1: dispatched (BASE c00ea70)
Task F1: dispatched (BASE c00ea70)
Task B1: complete (commits c00ea70..6f1f735, review clean)
Task B1: minor (deferred): base_version per-item loop duplicated in review/reset routes (routes.py ~252, ~273) — could fold into _validate_bulk_orders
Task B2: dispatched (BASE 6f1f735)
Task F1: complete (commits c00ea70..39bf487, review clean; trailer verified by controller)
Task F1: minor (deferred): application-shell.mts ~2234 comment says distribution writes go via Store.updateMany — actual producer is a direct Store.emit at distribution-pane.mts:1117
Task F1: minor (deferred): D48 test doesn't restore App._prevTab in finally
Task F2: dispatched (BASE 39bf487)
Task B2: review: spec ✅; 1 Important (_clean_weights float(int) OverflowError → 500) → fix round 1 sent to implementer
Task B2: minor (deferred): finiteness/ceiling check duplicated in _clean_weights and _validate_share_payload
Task B2: fix round 1/5 (1 addressed, 0 open; commits 4a50163..515417a)
Task B2: complete (commits 6f1f735..515417a, review clean after 1 fix round)
Task B3: dispatched (BASE 515417a)
Ruling: scoped node test commands in briefs use the glob form `node --test "tests/modules/<dir>/*.test.mjs"` — Node 24 here rejects a bare trailing-slash directory arg — cost if wrong: none.
Task F2: implementer DONE (1ae859d); concerns: per-row What-If hint as tooltip instead of visible span; added mid-flight Sandbox re-check in _runWritePipeline/_onSaveClick (needed for brief's test) → review
Task F2: review: 1 Important (plan-mandated: badge 'disabled' class has no CSS + blocked click shows misleading failure toast) → fix round 1 sent; ⚠️ _repairRow gating resolved by controller (already gated pre-task, vetting: pane ~1666)
Task F2: minor (deferred): _onReviewedToggle HTTP-error path lost _parseDistError code-mapped message (now generic toast.dist_review_failed)
Task F2: minor (deferred): per-row What-If hint is tooltip-only; consider one list-level visible hint
Task F2: fix round 1/5 (1 addressed, 0 open; commits 1ae859d..fb3b0e6)
Task F2: complete (commits 39bf487..fb3b0e6, review clean after 1 fix round)
Task F3: dispatched (BASE fb3b0e6)
Task B3: implementer DONE (cb8731b) → review (Opus, includes Critical D01)
Task B3: review (Opus): 3 Important → fix round 1 sent
Ruling: B3 finding 1 (D53 rounding alters lot-size quantity splits) — fix: total-rounding opt-in for labor/machine hours only — plan forbids touching H6/quantity — cost if wrong: none.
Ruling: B3 finding 2 (cut-over plant: carried children may skip routing resolution) — implementer verifies with a pg test; if real, pin behavior and DEFER (fix lives in resolver.py, outside low-risk scope) — disputed by planning evidence that run_time is blanked on shared dicts — cost if wrong: a cut-over routing plant's carried sub-orders keep SAP run time until a manual resolve.
Ruling: B3 finding 3 (D03 warning lost when no parents planned) — moved to Task B4 (its D04 warnings part fixes exactly this; B4 adds the assertion) — cost if wrong: none.
Task B3: observation (out of scope, for final report): reviewer says resolver `_is_routing_hold` (resolver.py ~555-559) returns False for upsert_orders' `runtime_pending` hold reason → resolver may never release that hold. Unverified; flag to user.
Task B3: minor (deferred): D03 default-share lookup computed twice per new distribute header (accepted for B4 restructure)
Task B3: minor (deferred): D16 test feeds a hand-built dict to compute_derived_statuses rather than the real list path
Task F3: implementer DONE (e2a3e8d); concern: D46 restore-on-false vs stale-header resync → review
Task B3: fix round 1/5 (findings 1,2,4 addressed; 3 deferred by ruling to B4; commits cb8731b..a4fc7ec) — finding 2 disproved by pg test (cut-over plant still resolves carried children)
Task B3: complete (commits 515417a..a4fc7ec, review clean after 1 fix round)
Task B4: dispatched (BASE a4fc7ec)
Task F3: review (Opus): 1 Important (D46 restore lacks _detail===detail guard → overwrites stale refetch; lost update) → fix round 1 sent with cheap minors #2-#6 folded in
Ruling: fold F3 minors #2 (throw skips restore), #3 (stillCurrent after json), #4 (Q≤0 skip), #5 (wrong test inputs), #6 (disable inside try) into fix round 1 — same code, trivially small, correctness-relevant — cost if wrong: slightly larger fix diff.
Task F3: minor (deferred): bulk bar doesn't render _writeBusy; latch doesn't block single-row writes during bulk
Task F3: minor (deferred): _writeBusy not cleared on plant:selected (a hung request keeps new plant's buttons disabled until it settles)
Task F3: fix round 1/5 (6 addressed, 0 open; commits e2a3e8d..afce06c)
Task F3: complete (commits fb3b0e6..afce06c, review clean after 1 fix round)
Task F3: minor (deferred): _postDistWrite has no try/catch for network throws on Save/Reset/Repair call sites (only Undo now guarded)
Task F4: dispatched (BASE afce06c)
Task B4: implementer DONE (b7adcb5) → review (Opus: ingest restructure)
Task B4: complete (commits a4fc7ec..b7adcb5, review clean)
Task B4: minor (deferred): _resolve_wc_codes ids_by_key keeps one id per key — same-key plain rows (X, X_1) now pass through and both rewrite one id; single_rewrites over-reported (harmless, exposed by B4)
Task B4: minor (deferred): no test for "involved only via existing header" path, same-machine duplicate survivor, mixed group, or full upsert proving X/X_1 suffixing
Task B4: minor (deferred): unresolved-plant row in a conflict group now reported in both ambiguous_workcenter_plant and conflicting_parent_rows
Task B4: minor (deferred): ambiguous_workcenter_plant entries now surface a distribution warn entry on non-distribution plants (overlaps db.py's plant-unattributed warning) — plan-mandated noise
Task B4: minor (deferred): six-key zero-counter dict duplicated vs _empty_apply_result; distribution_ingest_warnings relies on short-circuit; addendum test could assert reason=="zero_weights"
Task B5: dispatched (BASE b7adcb5)
Task B5: implementer DONE (b2140db) → review
Task B5: complete (commits b7adcb5..b2140db, review clean)
Task B5: minor (deferred): no test for an upload file with no RUN_TIME column at all (flag should read True)
Task B6: dispatched (BASE b2140db)
Task F4: implementer DONE (2d75729) → review
Task B6: implementer DONE (ed7b67e) → review (Opus: destructive purge route)
Task F4: review (Opus): 1 Important plan-mandated (module-level AbortController aborts sibling mounted comboboxes in admin-ui) → fix round 1 sent with minors 1-3 folded in
Ruling: F4 combobox listener — key the AbortController per container (WeakMap) in all three copies instead of the plan's module-level controller — the plan's literal design breaks admin-ui's two-picker screens; the audit's intent (no leak) is preserved — cost if wrong: none.
Task F4: minor (deferred): pre-existing test noise — insights-ui.test.mjs triggers a real summary fetch ("Failed to parse URL /distribution/5512/summary") via the distribution-loader subscriber
Task F4: minor (deferred): no CSS for .dist-list-truncated-notice; D36/D47 need a manual browser check
Task F4: minor (deferred): no test for work-center stale-plant guard; D26 list test covers only plant-change route, not newer-seq same plant
Task B6: review (Opus): 1 Important (test doesn't pin revived quantities) → fix round 1 sent with minors 1-2 folded (audit counts always; docstrings/error text)
Task B6: minor (deferred): purge doesn't lock headers — a concurrent Reset could have its header deleted (read-committed NOT EXISTS) and opposite lock order can deadlock (one side aborts cleanly); admin-only, low likelihood
Ruling: aggregate_to_detail.md has several lines saying only an upload revives a purged share (~207, 317, 335, 370, 466, 631, 669) — X3's §5.7 amendment must cover all of them (amend in main checkout, uncommitted) — cost if wrong: stale design doc.
Task B6: fix round 1/5 (3 addressed, 0 open; commits ed7b67e..f60174c)
Task B6: complete (commits b2140db..f60174c, review clean after 1 fix round)
Ruling: locale text err.dist_share_purged ("only a fresh upload revives it") is now wrong after B6 — F10 updates it in all 5 locales to mention Reset — cost if wrong: misleading UI message.
Task B7: dispatched (BASE f60174c)
Task F4: fix round 1/5 (5 addressed, 0 open; commits 2d75729..454f4e7)
Task F4: complete (commits afce06c..454f4e7, review clean after 1 fix round)
Task F4: minor (deferred): Load-more's one-line `_loading` click guard has no DOM click test (harness has no DOM)
Task F5: dispatched (BASE 454f4e7)
Task B7: implementer DONE (9d9a5c6) → review (Opus: locking)
Task F5: implementer DONE (87ade03) → review
Task B7: complete (commits f60174c..9d9a5c6, review clean)
Task B7: minor (deferred): 19-col lock row→dict mapping now copied 3x (apply, _lock_one_header, review_orders) — xmin at index 18 drift risk; extract helper
Task B7: minor (deferred): duplicate (order, material) items in one bulk review now both report ok (pre-B7 the repeat reported stale)
Task B7: minor (deferred): wc_codes audit headers_created = planned parents, not actual created; commit-only branch of _resolve_wc_codes audit untested
Task B7: minor (deferred): CLAUDE.md/docstring wording "lock for connection's full lifetime" overstates; deadlock test threads not daemon
Task B8: dispatched (BASE 9d9a5c6)
Task F5: review: 1 Important (Override lock compare not normalized → null-MACHINE sub-order date-only Override wrongly rejected; brief had specified the normalized form) → fix round 1 sent with remove-not-in-grid test folded
Task F5: fix round 1/5 (2 addressed, 0 open; commits 87ade03..4acd1d5)
Task F5: complete (commits 454f4e7..4acd1d5, review clean after 1 fix round)
Task F6: dispatched (BASE 4acd1d5)
Task B8: implementer DONE (7280721) → review
Task F6: implementer DONE (b40e4e9) → review
Task B8: complete (commits 9d9a5c6..7280721, review clean)
Task B8: minor (deferred): test_search_predicate_uses_escaped_ilike relies on positional params[1:3]
Task B9: dispatched (BASE 7280721) — doc update by Sonnet; controller runs full suite + ruff
Task F6: complete (commits 4acd1d5..b40e4e9, review clean)
Task F6: minor (deferred): rebuild()'s explicit _distSiblingItemIds reset is redundant (apply overwrites it); D51 rebuild test simulates rather than calls real rebuild()
Task F7: dispatched (BASE b40e4e9)
Task B9: doc committed by controller (dfba3eb; implementer left it uncommitted). Full backend suite: 858 passed, 1 skipped (same pre-existing placeholder), 0 DB skips (baseline 767). ruff: 2 NEW errors in tests/test_distribution.py (B007, F841) → Sonnet lint fix dispatched.
Task B9: lint fix f39d866 (ruff clean; test_distribution 144 passed, 0 skips)
Task B9: complete (commits 7280721..f39d866) — TRACK B COMPLETE (branch fix/dist-audit-backend @ f39d866)
Task F7: implementer DONE (f26d9e5); added test-only export checkDistributionSeparationForTest → review
Task F7: complete (commits b40e4e9..f26d9e5, review clean; legacy-surface + static-assets checks pass)
Task F7: minor (deferred): race test exercises only the zero-task path's generation guard, not the main populated-tasks path
Task F8: dispatched (BASE f26d9e5)
Task F8: implementer DONE (a8904b8) → review
Task F8: review: approved w/ 1 Important (6-field mapping duplicated between _rows patch and Store patch) → fix round 1 sent
Task F8: fix round 1/5 (2 addressed, 0 open; commits a8904b8..26dde9c)
Task F8: complete (commits f26d9e5..26dde9c, review clean after 1 fix round)
Task F9: dispatched (BASE 26dde9c)
Task F9: implementer DONE (cc31e49) → review
Task F9: complete (commits 26dde9c..cc31e49, 1 parked)
Task F9: parked — fmt() duplicated in admin-ops/admin-ui.mts and integration/sap-interface-ui.mts (plan-mandated) — Ruling: keep; these two leaf renderers follow the codebase's deliberate-local-copy convention and a shared helper would add a cross-domain import edge — cost if wrong: two 10-line copies may drift.
Task F9: minor (deferred): after integration, backend (B3) adds `reason: "zero_weights"` to workcenter_without_members items; fmt() omits reason, so "no members" vs "zero weights" render the same (frontend reviewer checked pre-B3 data.py)
Task F9: minor (deferred): _ordersTileSubtitle uses plant-wide siblingsByParent, ignoring Dashboard line filter; distribution:summary subscriber branch has no dedicated test
Task F10: dispatched (BASE cc31e49)
X1 (early, backend half): audit probes re-pointed at dist-backend (copies in scratchpad/audit-wt-backend; originals hard-coded the OneDrive path). 27 probes now FAIL (bug fixed): D01, D02(S3,P5,p6 purge), D03(zero children deletes plain), D04 silent drop, D10(P1), D16(policy qty x3), D18(P2), D20(P7,P7b,P8), D21(P4,P4b), D22(P3,S5), D27(p3), D42(p7 order), D59(p7 wildcards), D53 negative, p2 20k-uncapped(behavior changed by B8 cap+1). 21 still PASS — all expected: deferred D06/D11/D14/D15/D17/D37/D39/D41/D58; or probe calls a lower-level helper than where the fix sits (apportion default round_total=False → fixed via opt-in at callers; resolve_plant numeric → fixed at ingest _str_id; to-date → fixed in routes._parse_iso_date; compute_default_shares zeros → fixed in _plan_core; stored-inf → prevented at write; S6 static grep); p6 'purged children read incomplete' = historic dangling shares (documented unrepaired prod data).
Task F10: implementer DONE (1be462b) → review
Ruling: my F10 addendum was wrong — `err.dist_weights_empty` already existed ("At least one machine needs a positive weight.") for the share-save path (data.py raises weights_empty for empty/all-zero shares AND, since B3, for Reset with all-zero defaults); the addendum's Reset-only text overwrote it. Fix: one message covering both. Also err.dist_reviewed_required means "request missing boolean `reviewed`" (malformed request), not "must be reviewed first"; err.dist_unknown_machine means "not a current member or existing share of this work center", not "doesn't exist in plant". → carried into F10 review/fix round — cost if wrong: misleading error toasts.
Task F10: review: 5 Important (unknown_machine / weight_invalid / reviewed_required meanings wrong in all 5 locales; weights_empty regression (plan-mandated by my addendum); parity test misses 5 col./empty. keys) → fix round 1 sent with controller-specified English wording
Task F10: minor (deferred): sap-interface-ui tests don't assert the new t()-driven header/label text
Task F10: fix round 1/5 (5 addressed, 0 open; commits 1be462b..53403a8)
Task F10: complete (commits cc31e49..53403a8, review clean after 1 fix round)
Task F11: dispatched (BASE 53403a8) — doc update by Sonnet; controller runs full frontend checks
Task F11: full frontend checks on final code (53403a8): build ok; test:legacy 37/37; test:modules 928/928 (baseline 872); typecheck ok; lint 0 errors / 46 warnings (= baseline); legacy-surface ok; static-assets ok
Task F11: complete (commits 53403a8..2a3d540) — TRACK F COMPLETE (fix/dist-audit-frontend @ 2a3d540)

## Integration (X1)
X1: branch fix/distribution-audit-low-risk @ 15f6659 = main(c00ea70) + both tracks (clean octopus merge; local main 10 commits ahead of origin/main from the other session — not touched)
X1: full pytest 858 passed / 1 skipped (pre-existing placeholder) / 0 DB skips; ruff clean; npm build ok; test:legacy 37/37; test:modules 928/928; typecheck ok; lint 0 errors / 46 warnings (= baseline); legacy-surface ok; static-assets ok
X1: frontend+crossdomain probes re-pointed at dist-int (scratchpad/audit-wt-int). Now FAIL (bug gone, genuine assertion): p01 D08, p02 D09, p03 D44, p05 D36, p06 D32, p07/p07b D26, summary-race D26, wc-autosave-queue D28. Harness-incompatible (no evidence; repo tests cover): p04 & p08 (fake DOM lacks classList for F2's click guard), p09 one case (old quantityToWeight arity). Still PASS, expected: p10 UndoStack (D31 deferred), separation P1 cross-plant (D25 plant-keying deferred; probe feeds both plants into core), separation undated (probe re-implements old expression verbatim, not real code — F7 tests cover real D50).
X2: dispatched final whole-branch review (Opus)
X2: final review (Opus): no Critical; 3 Important (Reset per-item error code not mapped → raw English; Repair re-posts purged share weight → share_purged 400 steering to Reset; zero_weights reason not shown in upload warnings) → ONE fix wave dispatched in dist-int, with cheap minors folded (stale comments x2, process-note comments in locales, truncated-notice wording, RF3 upload step test)
Ruling: X2 deferred-minor triage accepted as the reviewer gave it (only F9 zero_weights promoted; rest safe to defer) — cost if wrong: listed residuals ship.
Ruling: summary `truncated` not surfaced on badge/Dashboard/Ctrl+K — deferred (pilot plants far below 5,000 headers) — cost if wrong: badge undercounts silently past 5,000.
X2: fix wave DONE (d029ba9) → scoped re-review
X2: fix wave re-review: 7/7 addressed, no new breakage (commit d029ba9)
X2: complete. Final verification @ d029ba9: pytest 859 passed / 1 pre-existing skip / 0 DB skips; ruff clean; build ok; 37+932 node tests pass; typecheck ok; lint 0 errors (46 warnings = baseline); legacy-surface + static-assets ok.
X3: dispatched (docs in main checkout, uncommitted)
X3: complete — audit status column + §5.7 amendment written (uncommitted, main checkout); throwaway PG stopped. ALL TASKS COMPLETE.
