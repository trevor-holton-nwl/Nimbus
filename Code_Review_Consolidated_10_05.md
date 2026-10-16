# NIMBUS: Consolidated audit of the four reviews (2026-10-05, rev. 2 after the Fable stress test)

> **Status warning (2026-10-07).** This doc was written against `main@fdaae9c`. `docs/CONSOLIDATED_FIXES_2026-10-05.ledger.md` records many Part 1 and Part 2 items as DONE with commit ids, including Part 2 Bundle 0–3 (#1–16), #18, #20–21, #23–24, #26–27 and Part 1 #3, #4, #8, #9, #13, #16–19, #42–44, #47, #48 (mostly). Treat the ledger as the source of truth for status and re-check an item against code before working it. This doc has not yet been rewritten to strike those items.

## Context

**The ask.** Read `Code_Review_09_01.md`, `Code_Review_09_25.md`, `Code_Review_09_30.md` and `Distribution_Audit_10_01.md` together, then recommend:
1. a comprehensive list of every **low-risk** change, one executive sentence each;
2. a list of **high-impact** changes, including mediums that materially improve the app.

**Method.**
- I read all four docs plus the repair ledgers.
- Three read-only agents checked every open item against `main@fdaae9c`.
- An independent adversarial reviewer (Fable) then re-checked about 40 items, challenged the risk labels and looked for knock-on effects. Revision 2 folds in its corrections.
- **Only items still open at HEAD appear below.** No code was changed, no tests were run and no database was touched.

**Already done, so excluded:**
- **09-01:** N1–N8.
- **09-30:** N01–N12, plus the six follow-up corrections R1–R6.
- **09-25, now fixed:**
  - C1 and C2 (except the promote gate).
  - H1, H2, H5, H6, H8 and H9.
  - H3 (a), (d), (g) and (h).
  - Most H4 sinks.
  - P15, the "inherited" flag, the NUL bytes and the missing i18n keys.
- **10-01 distribution:** 35 of 61 findings, plus H6.
- **R1–R6** are defined in `docs/AUDIT_REPAIR_REVIEW_2026-09-30.md` and `docs/AUDIT_FOLLOWUP_FIXES_2026-10-01.md`, not in 09-30 itself, and are unrelated to the lint rule "R1" in Part 1 #6. Spot-checked against code on 2026-10-06: N01–N12 are all fixed.
- **Gap check (2026-10-06):** after this doc was written, 09-25 and 09-30 were re-compared against it and their remaining open items were folded in (Part 1 §1E #50–68, Part 2 #29, one Part 3 row). Those two docs and the 09-25 HTML copy are then redundant.
- **Note:** `Code_Review_09_25.md`'s own ✔ marks on **H7** and **H3(f)** are wrong; both are still open and listed below.

---

## Part 1: Low-risk changes (small, local, no contract or schema change)

★ marks a change that is also high-impact.

### 1A. Security and exposure
1. ★ **Ingress IP allowlist (C3).** The app is on the public internet and trusts an identity header anyone can set; restricting Container Apps ingress to corporate IP ranges closes that with no code change and is reversible in a minute.
2. **Pin CORS (S9).** `NIMBUS_ALLOWED_ORIGINS` is `*` today; setting it to the app's own URL is an env-only change that breaks nothing, because the UI is same-origin.
3. **API-key guard on `/diagnostics/deep`.** It is the one admin route missing the key check its siblings have.
4. **Finish the log-endpoint caps.** Entry and size caps already exist; what's left is capping the free-form `ctx` values and adding an overall request-body limit, so one caller can't exhaust the single container's memory.
5. **Escape the last injection sinks (H4 residual).** Master Data plant blackouts (`admin-ui.mts` ~569, ~631) and two Orders spots (`orders.mts` ~559, ~1695) still build HTML and inline `onclick` from stored data, so a crafted value runs script in a colleague's browser.
6. **Lint rule R1, at severity `error`.** It blocks new `${}` interpolation inside `on*=` handlers so the injection class can't return. It must be `error`, because CI lint runs `--quiet` and hides warnings.
7. **Subresource integrity on CDN scripts (S4).** The CDN URLs are already version-pinned, so adding `integrity=` hashes is mechanical and stops a compromised CDN from injecting code.
8. **Spreadsheet-formula guard on CSV exports (S6, D58).** Prefix `'` **only on text cells** that start with `= + - @`, never on numbers, and keep the setup-matrix CSV round-trip working. Apply it to every exporter: the AG Grid exports, the printer CSV and the four backend CSV streams. Add a BOM for Excel.
9. **Lock the last-admin check.** Two admins demoting each other at once can leave zero admins. A one-line transaction lock fixes it. This touches the otherwise-frozen `auth.py`, which is acceptable for one line.
10. **Correct the false CSP claims.** `index.html` and `frontend/shell/CLAUDE.md` describe a CSP that doesn't exist.

### 1B. Release pipeline and hygiene
11. ★ **Promote skill requires green CI.** Deploys build from the working tree with no test gate; require CI green on HEAD, `npm test` and `check:static-assets` before `az acr build`.
12. **Build the cache-bust stamp from the git SHA.** `NIMBUS_BUILD_ID` is still hand-set to `2026-09-18-2`, so users can run stale JavaScript after a deploy.
13. **Quarantine three hand-applied migrations.** These are `2026-08-17-line-key-columns`, `2026-08-20-line-to-machine` and `2026-08-20-setup-value-case-fold-backfill`. They aren't safe to re-run, so a fresh environment fails; move them to `migrations/manual/`. The runner doesn't recurse into subfolders, so this has no effect on Azure.
14. **Pin the Docker base images.** `node:20-slim` and `python:3.12-slim` float, so builds can't be reproduced. The pip hash lock is dropped: too much churn on every dependency bump for a pilot.
15. **Stop ESLint from linting the compiled `.mjs` twins.** Every warning is counted twice today.
16. **Replace the last five `datetime.utcnow()` calls.**
17. **`sql.Identifier` for VACUUM/ANALYZE.**
18. **Delete dead code and false comments.** This includes the stale `update_task_dates_bulk` docstring, which still describes a post-commit resolve.

### 1C. Tests and guard rails (no app behavior change)
19. **Delete the tautology test** (`_coalesce_nullif_semantics`).
20. **Make the legacy harness reject unknown URLs.** Today it answers 200 to anything.
21. **Make `legacy-surface` a real ratchet.** It currently regenerates instead of failing.
22. **CI check that regenerates the API types and fails on any diff.**
23. **Locale parity ratchet for all key families.** The non-English locales are still about 237 keys short.

### 1D. Planner- and admin-facing fixes (small, contained)
24. **Reconnect reloads the plant you were on (H3e).** Record the attempted plant before loading; today a failed first load leaves the board empty.
25. **Command-palette undo actually undoes (H3f).** Firm, Unfirm, Push +1h and Unschedule push an empty undo, so the next Ctrl+Z reverts an unrelated edit.
26. **What-If discard keeps the unsaved-edits list (H3c).**
27. **Undo of an *applied* What-If also reverts calendar edits.** Discard is already correct; only the apply-undo restores just tasks and firms, leaving promoted blackout and hours edits live.
28. **One-click alert fixes skip firmed orders.** Use the effective firmed set (SAP-firmed, frozen horizon and manual, all parent-level), not just the manual flag.
29. **Save requests time out, and a skipped second Save is reported.**
30. **Readable error messages and longer error toasts.** No more "[object Object]" or 1.5 s error toasts, and outages are no longer reported as "invalid password".
31. **Retry the API-key bootstrap.** One blip at page load currently leaves admin calls failing with 401 until refresh.
32. **Confidence score uses the plant's own horizon.**
33. **The Gantt filter survives a redraw, and pasting a list selects every entry.**
34. **The Inspector stops leaking a date-picker per render.**
35. **Printer CSV in plant-local time, not UTC.**
36. **Routing client fixes.** Parse date-only validity as local time (it's a day early in the US today), add a plant-switch sequence token, and refresh after a routing-rule delete.
37. **Alert gap-fill keeps the real reason** ("setup transition unrecorded") instead of "No slot found".
38. **Pass the setup index into proposal validation (P2).** It's a one-argument optimizer speedup.
39. **Trim the optimizer worker payload (P14).** Send only the selected plant's blackouts and calendars.
40. **Utilization steps days safely across daylight-saving changes.**
41. **Bound `nextAvailable` properly.** Today an overlong order is returned as if valid, and a 10:05 blackout end can loop.
42. **Normalize numeric MACHINE codes at ingest.** PLANT is already normalized. This is safe, but it can't recover leading zeros Excel already stripped.
43. **Keep NULL-machine orders in dependency links,** and sort distribution letters correctly past 26 machines (AA currently sorts before B).
44. **Treat real 00:00–00:59 finishes as times, not date-only.** This is an ingest correctness fix.
45. ★ **Setup signature collision (moved up from high-impact).** States ("10","220") and ("102","20") share one key, so the optimizer charges no setup where the Inspector shows 40 minutes. Fable confirmed the joined key is never persisted (stored data is JSONB arrays), so changing the separator is a one-line local fix.
46. ★ **Lines tab sends only changed columns (moved up from high-impact).** It re-posts whole machine rows from a session cache and silently reverts colleagues' edits. The server already applies only the keys it's sent.
47. **Small admin fixes.**
    - Fix delete-filtered: it always returns 409 and shows a literal `<strong>`.
    - Add a confirm to "Clear backend log".
    - Stop showing "Copied" when the clipboard is denied.
    - Use `CSS.escape` in Labor, and validate its `period`/`day` fields as dates.
    - Fix the setup grid handlers that keep first-render data, and the dead "Update state" controls.
48. **Distribution polish.**
    - Align separation severities (D50).
    - Window the badge the same way as its list (D37).
    - Use a combobox for the default machine (D61).
    - Filter SAP history on the server (D49).
    - Show per-item rejection reasons (D29).
    - Flush queued Work Center edits on tab close (D28).
49. **Accessibility basics.** Modals get `role="dialog"`, `aria-modal` and focus handling, and toasts become `aria-live`.

### 1E. Added 2026-10-06 from a gap check of 09-25 and 09-30
A second pass compared both source docs against this one, verifying each candidate against `main@8de0414`. Everything below was missing here and is still open.

50. **Distribution re-weight, reset and repair no longer report a saved change as a failure.** The routing resolve runs after the commit without a guard (`backend/distribution/data.py:3258`, `:3344`, `:3822`). If it throws, the planner sees an error for a change that is saved, and a retry hits a stale-version conflict. Wrap it and return a warning, as the upload path already does (`db.py:3552-3600`). Reset and re-apply also run one whole-plant resolve per header, which should be one per request.
51. **Alert one-click fix undoes everything it moved.** It snapshots only the order it moves, then auto-reflow may push neighbours, so Ctrl+Z restores one bar and leaves the rest shifted (`insights/services.mts` applyFix). Snapshot the whole line. This is separate from the firmed-order half in #28.
52. **Time Machine restore also restores machine and splits.** It puts back only start and end dates (`nimbus-intelligence.js:1449-1465`), so an order moved to another line or split since the snapshot comes back on the wrong line or still split.
53. **Master Data delete confirm shows the cascade.** Deleting a material also deletes its plant links at every plant, and deleting a plant removes labor plans, calendars and blackouts. The server counts the material links (`master_data.py:918-926`) but the confirm never shows them (`admin-ui.mts:4033-4046`, `:4278-4284`), so it looks like a plain confirm.
54. **Labor edits roll back when the save is rejected, and the screen uses `t()`.** Today a rejected hours edit stays on screen as if saved, with only an error toast (`labor-planning.mts:174-200`); the file has only about 4 `t()` calls and most text is hard-coded English.
55. **Changeover across midnight is judged on both days.** A 40-minute changeover starting 23:40 on a 24/7 line is checked against only the new day's window (`engine.mts:320-345`), so it reads about 20 minutes and raises a false "not enough changeover time". Static read, not executed.
56. **A line with no calendar entry uses the default working hours in the overlong check.** `setup-scheduler.mts:2387-2389` returns "no window" while lines 2272 and 2292 fall back to the default, so on an overlong-only plant ordinary 4-hour orders can be split across days.
57. **Gantt dependency arrows use the visible row order and redraw once per animation frame.** Arrows currently use a sorted line list rather than the visible lines, so they can land on the wrong row, and every pan event redraws directly (`gantt.mts:2395-2410`, about `:2480`).
58. **Autosave runs only on schedule changes.** Today it fires on every non-refresh event and serialises the whole plant to browser storage after any non-refresh event (`application-shell.mts:2119`, `persistence.mts:2012-2016`).
59. **Small security leftovers.**
    - Evict old entries from the login throttle (`auth.py:620-654`, S7).
    - Stop echoing raw `ValueError` text in 400 responses (S8: `admin_ops/routes.py:192`, `calendars/routes.py:29-101`, `integration/routes.py:162` and `:230`, `distribution/routes.py:67`).
    - Escape LIKE wildcards in the user search (`auth.py:175`) and the routing-PV search (`master_data.py:693-697`).
    - Bound the `/audit/log` file, whose entries are capped but which grows forever (`master_data/routes.py:104-118`).
60. **Minor leftovers.** The scheduler hard-codes four priority fields, so a fifth one an admin adds is ignored (`setup-scheduler.mts:1193-1198`); the command palette indexes only the first 2,000 orders (`nimbus-intelligence.js:981`).
61. **A save retried after a lost reply no longer reports a false conflict.** The network-error retry reuses the same body and row versions (`persistence.mts:1509-1531`). If the first attempt was applied but the reply was lost, the retry hits a stale-version conflict on the planner's own save.
62. **An empty save doesn't toast "Saved".** `saveAll` has no early return when nothing is dirty, so it posts an empty payload and says "Saved to backend" (`persistence.mts:1444-1475`, `:1643`).
63. **Cap the log-ship queue.** `_shipQueue` grows without limit while the backend is unreachable; only the de-dupe set is bounded (`foundation.mts:1434-1450`).
64. **Compute worker answers unknown messages and times out.** An unknown message type gets no reply (`nimbus-worker.ts:50-57`) and `_pending` has no timeout (`insights/services.mts` ~108-172), so a request can wait forever.
65. **Cache-bust redirect handles `_v` as the first query parameter.** `?_v=1&a=b` becomes `&a=b`, which gives a malformed redirect URL (`app-entry.mjs:141-142`).
66. **Reconnect doesn't append duplicate dependency links.** The load pushes into `Store.dependencies` without clearing (`persistence.mts:591-593`), so a reconnect doubles the arrows.
67. **Accessibility leftovers.** `index.html` has 37 `role="tab"` and no `aria-selected`, and only 1 of 48 `<label>`s has `for=`. Add to #49.
68a. **Distribution leftovers from the 10-01 audit (added 2026-10-07).**
    - **D47:** after the shares preview refreshes while a planner types a weight, focus returns to the right input but the text cursor jumps to the start (`distribution-pane.mts:2434-2438`). Restore the selection range, or drop it as cosmetic.
    - **D60:** lookups match "order in list" and "material in list" separately instead of as pairs, so they over-fetch (`distribution/data.py:486`, `:516`, `:1702`, `:2123`, `:2152`). The pair-matching `unnest` pattern already exists at `:3386`. Run `EXPLAIN` on Azure first; the harm was never proven.
    - **D61:** add a test that walks every API route prefix against the `frontend/` folders, so a future route like `/routing/{plant}/x` can't silently shadow a static file. Today only setup and master-data are pinned (`brain.py:483`, `tests/test_static_delivery.py:56-62`).
    - **D50:** distribution separation alerts as `err` while the optimizer treats it as `warning`. This is deliberate and documented; the only open question is whether Apply should be blocked, which is an owner decision (the ledger records it).
68. **Test debt (no app behaviour change).** 29 fake database cursor classes in `tests/*.py`, and `tests/test_rbac_plant_scoping.py` overrides dependencies 41 times, so those tests can hide real bugs.

---

## Part 2: High-impact changes

Effort: S = days, M = about 1–2 weeks, L = more.

Rev. 3: every item below was stress-tested by a second Fable review of each proposed fix. The fix shapes reflect what it found, and the items are grouped into bundles that must ship together.

### Bundle 0: safety net first (ship before anything else)
1. **★ Promote gate on green CI, with an escape hatch (S).** The deploy skill builds straight from the working tree. Require the CI checks on HEAD to be green via the GitHub REST API (there is no `gh` CLI on this machine). Add an explicit `-OverrideCi "<reason>"` for urgent hotfixes, recorded in the deploy note, because a known-flaky 1.5 s optimizer timing test could otherwise block one.
2. **One cross-seam save test (S).** No test sends the browser's real save payload through the real save route; that gap let C1, N09 and R3 through. Emit the payload from the JavaScript and POST it through `TestClient` against a sub-order row and a routing-enabled row, reusing the `routing_cases.json` shared-fixture pattern. *Correction:* CI **already** runs the full PostgreSQL suite on every PR (`ci.yml`, with `NIMBUS_REQUIRE_TEST_DB=1`), so this one test is the only missing piece.

### Bundle 1: the routing switch-on gate (one PR; must land before routing is enabled on any plant)
3. **Release `runtime_pending` holds (C4, S, low risk).** New orders on a routing plant are parked with a code the resolver never releases, and a planner can't rescue them either. Recognise the code in `_is_routing_hold`. Fable checked that this can't release an order that should stay held.
4. **Chunk the routing outcome write (C4, S, low risk).** One statement with 6 parameters per order fails past about 10,900 orders. Chunk at 5,000 rows or use `unnest`. It stays one transaction, so there's no partial-failure risk.
5. **Keep run times on re-upload, but only the right ones (C4 + D23, S, medium risk).** Upload blanks every run time on routing plants, wiping planner-entered values.
   - **The fix in rev. 2 was unsafe.** A plain "keep the old value" would also keep a *stale* duration when SAP changes the quantity, because the resolver only re-derives rows that are blank.
   - **Correct shape:** keep the old value only where `run_time_source='manual'`, and teach the resolver to re-derive every non-manual row in the upload batch.
   - This also covers D23, the sub-order case.
6. **A failed routing resolve becomes a warning, not a failed upload (C4, S).**
   - **Rev. 2 said to stop committing upload chunks before the resolve. Dropped.** That is the single giant transaction 09-25 §10 explicitly says not to build: it would hold locks on 10k+ rows for the whole SAP sync and time out every planner save on the plant.
   - Once items 3–5 land, a failed resolve leaves nothing damaged. Catch it, report it as an upload warning, and let the existing recompute action repair it.
7. **Upload without a PLANT column (downgraded, S).** Mostly a non-issue: plants are already derived from the machine or work center before the routing check. Add the no-PLANT-column case to the tests plus a one-line union of the backfilled plants.

### Bundle 2: distribution parent-link integrity (one PR, in this order)
8. **Skip and warn on uploaded rows whose order number is an existing sub-order (D30, S).** A grid export re-imported as an upload overwrites a sub-order's machine and quantity and gets around its machine lock. **Warn and skip the row, never refuse the whole upload**, because one stray row must not block a 10,000-row SAP file. This must come before item 9.
9. **Uploads write the parent link and letter (D07, S).** Use plain overwrite, not "keep the old value"; otherwise an order whose header was purged stays machine-locked forever. Append the columns at the end of the column list, because existing tests index by position.
   - **Correction:** this alone does **not** make Repair recover failed sub-orders, because Repair only walks existing headers. Either add a sweep for orders whose parent has no header, or drop that claim from the design doc.
10. **Upload racing a planner can't double the quantity (D06, S).** Include the sub-orders created at upload time in the set to remove. Without this, item 9 makes the orphans visible to re-weight.
11. **Re-weight sums hours only from real sub-orders (D43, S, newly added).** Today it sums every order with that parent, orphans included. Without this, item 9 makes re-weights split inflated labor hours (about 1.5×).

### Bundle 3: distribution re-weight safety (one PR)
12. **Lock sub-orders during re-weight (D17, S, low risk).** Fable confirmed this can't deadlock with normal saves, because both lock orders in id order. Keep the preview lock-free.
13. **One bad parent no longer fails the whole upload (D01, S, medium risk).** Use **savepoints per chunk of about 50 parents**, not one per parent. Thousands of per-parent savepoints in one SAP sync degrade every other session's database performance for its duration. On failure, retry that chunk parent by parent and report the failed keys.
14. **Re-weighted and reset sub-orders keep tooling and production version (D11, S).** Today the optimizer treats them as unknown setups, and on routing plants they're held and unscheduled. Stamp them inside the write. On collapse, copy the run time **only if it was manually entered**; copying a 50% share's hours onto the now-100% order would be wrong.
15. **Ctrl+Z can't restore pre-re-weight values (D31, S).** Undo entries currently can't be identified by which orders they touch. Add order ids to undo entries and drop those that touch the re-weighted orders. Restricting what undo restores would break the Override dialog's undo.
16. **Sub-orders that grow get re-fitted to the calendar (H10/D33, S).** Flag a sub-order only when its run time *actually changed* and it is already scheduled. Ship this **after** item 15, because the re-fit creates undo entries. Planners will see affected bars adjust on reload: that's intended, and it's the same mechanism routing already uses.

### Independent data-protection fixes
17. **★ Ingress IP allowlist (C3, ops).** Use the corporate proxy's egress ranges, and test from both the proxy path and Cloud Shell before relying on it. It's reversible.
18. **The save-time conflict check sees long orders (S, low risk).** Widen the lookback by the touched machines' longest run time (capped). In strict optimizer mode only, take per-machine locks in sorted order. Fable confirmed neither change can deadlock.
19. **Deleted blackouts stay deleted (S).** Persist failed **deletes** per plant and replay them on the next load; deletes are safe to repeat. Do **not** auto-replay failed hours edits, which could overwrite a newer edit by another admin. Make that toast honest and give it a Retry button instead.
20. **Setup plant-default saves detect a concurrent admin (M).** Add a content-hash token that needs no schema change, and carry the provenance fields in the same change.
21. **Keep a planner-chosen production version on re-upload (H7, PV half, S, low risk).** Keep the old value when SAP sends a blank, and count those cases in the upload warnings so they're visible.

### Scale (before 50 plants / 70 machines)
22. **Two cheap optimizer speedups now (S).** Pass the setup index into proposal validation (P2), and remove the O(n²) setup-availability check on the main thread (P3).
23. **Save-path routing lookups cached per request (P7, S, low risk).**
24. **Distribution review queue in SQL (D13/D14, M–L).** Past 5,000 headers the badge, Dashboard and Ctrl+K undercount. Move classification to SQL with a parity test against the existing Python classifier, which stays as the oracle so the badge and list can't disagree. Build it after the Bundle 0 test scaffolding.
25. **Scoped master-data loading (P8, M).**
26. **Time Machine memory trim (P4, S).** Bulk-save batching (P6) is now **M**, not S. Rows have different column sets, so batching must group rows by shape; done carelessly, it bumps versions on rows nobody edited and creates false conflicts.

### Added 2026-10-06 (gap check)
29. **Master Data: two added rows with blank keys no longer collide (M).** After clicking Add Row twice, typing in row 2 edits row 1, because rows are matched by `_rowKey` (`admin-ui.mts:3809`, `_addRow` at `:3844`). Needs a temporary row id. Static read; the tab-switch and plant-switch drops are already guarded (6354e00).

30. **Distribution apply sends far fewer database round trips (D39, S–M).** `apply()` runs one statement per sub-order, share and anchor (`distribution/data.py:1472`, `:1760-1830`). At about 5,000 distributed parents that is tens of thousands of round trips to Azure while header locks are held, so a planner's save can time out. Batch with `executemany` or `unnest`; the per-chunk savepoints don't reduce round trips.
31. **Distribution roll-up has a date window and paging (D41, S).** The roll-up for downstream consumers has no window and no paging, and the CSV is built whole in memory (`distribution/routes.py:192-233`). A plant with 20,000 headers returns about 13 MB of JSON in one call. Require a window, page the JSON and stream the CSV. Low urgency: no frontend consumer yet.
32. **Distribution header rewrites only when SAP changed (D15, header half, S).** Every upload rewrites every distributed order's summary record because the "changed?" test includes the batch id (`distribution/data.py:1148`), so an open shares editor shows a false "stale" prompt after a routine SAP sync. Example: order 1000's header is untouched by SAP but still reads stale. The child half is fixed (`:1332-1363`). Check the `last_batch_id` filter at `:2042` first. The owner's "SAP changed" test already settles the rule; this is the header half of the Part 3 "only write what changed" row.

### Security before Entra (split into two)
27. **Server-side MACHINE validation (S).** Accept the plant's registered machines **plus any machine already holding orders in that plant**, compared case- and space-insensitively. A registered-only check would reject moves between legitimate unregistered or legacy lines.
28. **Content Security Policy (L, not M).**
    - Start **report-only**, and add enforcement once reports are clean.
    - `style-src 'unsafe-inline'` is unavoidable for now: the templates use inline styles and AG Grid injects styles.
    - Converting 105 inline handlers and the `document.write` loader comes after Part 1 items #4 (log caps), #5 and #6 (escaping, lint rule), #7 (SRI) and #12 (build stamp).

---

## Part 3: Needs an owner decision before anyone implements

Fable showed these aren't mechanical fixes; each changes product behavior or persisted meaning.

| Item | The decision | Why it isn't a simple fix |
|---|---|---|
| **H7 machine on re-upload** | When SAP says L1 and a planner moved the order to L2, who wins? | SAP is the system of record for work center. "Planner wins" needs a stored override marker that interacts with plant re-derivation and distribution's own machine rewrites. |
| **Persist manual "firm"** | Should manual firm become a shared, server-side fact? | Today it lives only in one browser, so another planner's optimizer moves the order. Fixing it needs a new `orders` column, a save-contract field and ingest preservation, and it must respect "firmed is parent-level only". |
| **"Only write what changed" on upload (D15/P12)** | How should post-upload steps find "this batch's" rows? | It stops false "stale" conflicts after every SAP sync. But unchanged rows would no longer get the new batch id, which today drives the post-upload stamping, the missing-master-data report and the inserted/updated counts. Those steps would need id lists instead. |
| **Delete key / Unschedule (H3b)** | Should Delete send orders to Needs Planning, or revert them to their SAP dates? | Queuing changes the persisted status, the Needs Planning counts and optimizer eligibility, and hides the order's SAP dates in the grid. It needs its own reason code so routing never claims it, and undo must capture the status too. |
| **Run time on plants without routing** | On a plant with routing off, if a planner keyed a run time and SAP re-sends a different one, who wins? | This is the same "SAP vs planner" family as H7. Today SAP always wins there, and Bundle 1 deliberately leaves that unchanged. |
| **Optimizer fairness on big plants (H11/P1, P13)** | Run a PerfMonitor capture on the largest plant first. | If starvation is real, use a fair share with carry-over (unused time rolls forward), never a hard equal split. A hard split would *worsen* small plants where one line legitimately needs most of the 5 seconds, and it changes results on any plant that hits the deadline today. |
| **Strategic: multi-shift hours (X4b), shared tooling (X1), publish ledger (X2)** | Whether and when to start each. | Multi-shift changes a persisted calendar shape (owner's schema freeze). Shared tooling needs tool-quantity data and confirmation that `PRT_01` is a physical tool. The publish ledger should wait for "persist manual firm", or a published schedule would omit manual firms. |
| **Repair of orphan sub-orders that already exist (09-30 N04 follow-up)** | Should a reviewed one-off repair remove sub-orders already orphaned before the N04 fix? | Example: 100 pieces split 50/50 between L1 and a new L2, then reset to L1 only, left an L2=50 order on the Gantt. The code fix is in (`distribution/data.py:3150-3151`), but nothing cleans rows already orphaned. The D07 ledger row records that a header-less sweep was deliberately **not** built, because it could silently delete real orders left by a master-data cascade; `aggregate_to_detail.md` was corrected instead, so orphans recover by re-uploading the parent. Only a read-only count of orphans on the Azure pilot is still worth doing. |
| **Strategic backlog from 09-01 (X4a, X5, L1, L3, L4; L2)** | Whether and when to start each. | **X4a plant-time consistency:** order dates and the calendar use the browser's clock, while Remove Backlog, the Dashboard plant hour and setup captures use the plant's timezone (`engine.mts:665`, `:1293`, `insights-ui.mts:600` against 14 `toLocalSeconds` uses); `docs/MIGRATION.md:892-913` forbids unifying the two schemes, so it needs a design pass (start with display-only projection). Part 1 #35 and #40 are slices of it. **X5 server-side named scenarios:** snapshots and What-If scenarios live in one browser's IndexedDB, so a second planner can't see them; needs a new table; sequence with X2 after manual firm. **L1 operation model:** orders are one row on one machine; first ask production planning how many SAP operations per order need independent scheduling (routing today covers run time, not multi-operation scheduling). **L3 crew as a finite resource:** nothing in `frontend/optimization/` reads `labor_plan_line`; needs a plant answer on whether a crew limit applies to setup windows only or to unattended production too. **L4 business-weighted lateness:** lateness is unweighted; needs a weight source from SAP, and the cheap proxy is policy-tier rank. **L2 SAP execution feedback** is blocked on a live SAP connector. |
| **Sign-out clears local data (S5)** | When to clear the browser cache on shared PCs? | That cache is currently the *only* store of manual firms and cached unsaved edits. Do it only after "persist manual firm", or prompt when unsaved work exists, or it destroys planner work. |

### Owner decisions (2026-10-06)

Guiding rule: **SAP is the source of truth.** Unless someone sends NIMBUS's corrected dates and times back to SAP, a re-upload overwrites what NIMBUS holds.

| Item | Decision | What it means in code (verified 2026-10-06) |
|---|---|---|
| **H7 machine on re-upload** | **SAP wins on the work center, not the exact machine.** A planner may move an order between machines that NIMBUS maps to the order's SAP work center (`machine.sap_workcenter`), and a re-upload carrying the same work center keeps that move. Only a **changed SAP work center** re-applies the mapping (the `single`-mode default machine, or re-distribution). Example: work center WC10 maps to L1 and L2, with L1 as default. A planner moves order 4711 from L1 to L2. SAP resends it on WC10, so it stays on L2. SAP changes it to WC20, so it goes to WC20's default machine. | **Contradicts current code (traced 2026-10-06):** the upload resolves the work center to `sap_workcenter.default_machine` (`backend/distribution/service.py:104-112`) and then overwrites unconditionally (`db.py:2414`). That undoes every same-work-center move, which is the shallow check the owner rejected. The order's SAP work center is **not stored** for plain orders; it is lost after the default-machine rewrite (`data.py:968` keeps only a counter). Only distributed orders keep it (`order_distribution.sap_workcenter`). **Needs:** a per-order SAP work-center column, written on every upload, and a machine CASE: same work center and the current machine still a member, keep it; otherwise take the planned value. Unregistered work centers keep today's raw-code passthrough. Distribution children are unaffected, since direct machine edits on them are already rejected (`db.py:1384-1386`). **Implemented on fix/sap-truth-integration (unmerged).** |
| **Persist manual firm** | **Yes, saved on the server and shared by all planners.** A manual firm is a NIMBUS-only hold and is separate from SAP's firm flag. **Rollout: start fresh.** Existing browser-only firms are dropped (not uploaded), and planners re-firm what they need. | Needs the `orders` column, save-contract field and ingest handling as scoped above; firmed stays parent-level only. The browser cache (`nimbus.state.v3`) must stop restoring old local firms. **Implemented on fix/sap-truth-integration (unmerged).** |
| **"SAP changed this order"** (one test, used by the two rows below) | Changed means any of these differs from SAP's **previous upload**: **dates, work center, quantity, production version.** It is never compared with NIMBUS's edited values. | Dates (`basic_start_date`/`basic_finish_date`) and quantity are already stored as SAP-only values. Work center needs the new column (H7 row). **Production version** is planner-editable on save (`backend/scheduling/routes.py:316`), so the stored value isn't SAP's. **Owner decision: keep planner editing.** Planned outbound interfaces will send NIMBUS edits to SAP, which then returns them on the next upload. So store SAP's last production version in its own column. **Round-trip rule:** an incoming SAP value that matches what NIMBUS already holds (the planner's edit coming back from SAP) is an echo, not a change. It must not un-firm the order or reset its slot. The same rule applies to dates and work center once outbound interfaces send them. D15/P12 ("only write what changed") should reuse this same test. **Implemented on fix/sap-truth-integration (unmerged).** |
| **Re-upload vs manual firm** | **A re-upload removes the manual firm only if SAP changed the order.** An order SAP resends unchanged stays firmed. **Running orders keep their manual firm even when SAP changes them.** | Uses the "SAP changed" test above. **Implemented on fix/sap-truth-integration (unmerged).** |
| **Re-upload vs NIMBUS's planned slot** | **Reset to SAP's dates only if SAP changed the order.** If SAP resends it unchanged, NIMBUS's slot (planner or optimizer) is kept. Example: order 4711 is moved to Tue in NIMBUS. SAP resends it unchanged, so it stays on Tue. SAP changes its date to Thu, so it goes back to SAP's Thu slot. **Running orders never move (except Remove Backlog) and keep slot and firm on an SAP change; orders inside the frozen horizon ARE reset on an SAP change.** A deleted order becomes Needs Planning with SAP's dates shown. Uploads skip unchanged orders entirely. | **New behavior:** today `scheduled_start`/`scheduled_end` are always preserved (`db.py:2512-2513`). On "SAP changed", clear the scheduled dates and segments so the order falls back to SAP's dates; a queued (`needs_planning`) order returns to `scheduled` on SAP's dates, and for a distribution parent every child's slot resets too (owner-approved 2026-10-06). **Implemented on fix/sap-truth-integration (unmerged).** |
| **SAP firm flag (`ecc_firmed`)** | **Show it, never lock.** About 90% of SAP orders arrive firmed regardless of horizon, so honoring the flag would leave nothing to optimize. Only the **frozen horizon** and **NIMBUS manual firms** lock an order. | **Contradicts current code:** the optimizer locks `ecc_firmed` orders when "respect firmed" is on (`frontend/optimization/engine.mts:216`), and that box defaults to on (`engine.mts:1984`, `optimize-ui.mts:645`). Part 1 #28 (alert one-click fixes) also counts SAP-firmed as locked. All three must drop `ecc_firmed` from the lock set and keep it as a display marker only. More lock sites: auto-reflow's peer push (`engine.mts:2328, 2374-2377, 2630, 2686`), distribution resize (`distribution-pane.mts:1438`), and `Engine.firmingStatus` (`engine.mts:1027`). The last one drives the Gantt firmed color and lock icon (`gantt.mts:706, 2633`), the Orders "firmed" filter and Inspector banner (`orders.mts:473, 759, 2108`), the Dashboard firmed count (`insights-ui.mts:913`) and the alert-fix guard (`services.mts:406`). Remove the `'ecc'` reason from the lock union and show SAP firm as its own neutral marker; otherwise ~90% of bars render as locked. **Implemented on fix/sap-truth-integration (unmerged).** |
| **Run time** | **Hand-keyed run time is a demo-only stopgap.** The end state is run time calculated from routing only, with no keying. For now, when routing is switched on for a plant, a hand-keyed run time is **kept** and every other order is re-derived from routing; a hand-keyed run time lasts until an upload changes anything SAP sends for that order (senior audit ruling, 2026-10-06). On plants without routing, SAP wins (already shipped as A2 follow-up `6e25344`). | Example: a planner keyed 6 h/1000 on order 4711 and routing is then enabled for the plant; the order keeps 6 h until an upload changes something SAP sends for order 4711. No other change now. Later: remove the manual arm of the `_UPSERT_SQL` run_time CASE and the keying UI. **Implemented on fix/sap-truth-integration (unmerged).** |
| **Production version on re-upload** | **SAP wins.** If SAP re-sends the order with a new production version, that version is written. The order's production version is otherwise the material's default. | **Reverses Part 2 #21**, which keeps the old value when SAP sends a blank. **Confirmed by owner:** a blank from SAP resolves to the material's default production version. This also removes the known side effect that new material defaults never reach existing orders. **Implemented on fix/sap-truth-integration (unmerged).** |
| **Sign-out clears local data (S5)** | Unblocked once manual firm is persisted on the server. | Sequence it after "persist manual firm". **Implemented on fix/sap-truth-integration (unmerged).** |
| **Expired login (senior audit ruling, 2026-10-06)** | **An expired login clears local planner data exactly like Sign out, with no confirmation.** | The expired session is handled at start-up before the app loads. Theme and language are kept. **Implemented on fix/sap-truth-integration (unmerged).** |
| **Running orders stay manually draggable (senior audit ruling, 2026-10-06)** | **A planner may still drag a running order by hand.** Only the Optimizer and the automatic fixes skip it. | The lock label now reads "protected from Optimize and auto-fixes" (all five languages). **Implemented on fix/sap-truth-integration (unmerged).** |

**Go-live notes**

- Cross-work-center planner machine moves also survive uploads that SAP left unchanged.
- An SAP change resets non-routing planning-exception holds back to scheduled.
- A running order's end can still change when routing re-derives its run time (the start is kept).
- Planners can still manually drag a running order; only the automatic movers (optimizer, auto-reflow) are blocked.
- The first upload after deploy only records SAP baselines and detects no changes.
- A planner's machine move, even to another work center, now survives SAP writes as long as SAP's work-center field is unchanged and the machine still exists in the plant.
- A hand-keyed run time is dropped (re-derived from routing) whenever an upload actually rewrites that order, meaning SAP sent any value that differs from its previous upload for it (dates, quantity, work center, production version, description, etc.), not only a different run time. Unchanged orders are skipped and keep it.
- Changing only the run time in the upload file no longer resets a planned slot.
- A running order whose run time cannot be recalculated keeps its slot and is reported in the upload warnings.
- Re-uploading now fills in master-data attributes (color, tooling, default production version) that were missing on an order.

---

## Open questions (cannot be answered from code)
- Is ingress still public, and is `NIMBUS_ALLOWED_ORIGINS` set to `*` on `ca-nimbus-dev`?
- Have the post-09-25 fix commits been deployed? Nothing is recorded since `f3dfb86`.
- Is optimizer budget starvation real at 70 lines? This needs a PerfMonitor capture.
- Does `PRT_01` identify one physical tool or a tool type with several copies? 09-01 N4 asked for this to be confirmed with the pilot plant and no answer is recorded. The `tool-conflict` alert shipped assuming one physical tool, so a type with several copies would raise false conflicts. The shared-tooling decision (X1) depends on it.

## Things learned along the way
- **Wrong source-doc claims:**
  - 09-25 marked H7 and H3(f) fixed; both are open.
  - C2 "pg job doesn't fail on skip": the collection guard already existed.
  - P9 "refetch every event": it was already debounced.
  - The CSP claims in `index.html` and `shell/CLAUDE.md`: no CSP exists.
  - High 8 in rev. 1 overstated the What-If calendar leak; only the apply-undo path leaks.
  - The resolver already caches its lookups per call; the per-row reload is on the save path (P7).
  - `/audit/log` is authenticated, not anonymous.
- **Corrected by the rev. 3 Part 2 review:**
  - "Row version unchanged after re-upload" can't be a test assertion: every upload rewrites every row by design (P12). The test should assert that the edit is kept.
  - "Stop committing chunks before resolve" contradicts 09-25 §10 and was dropped.
  - CI already runs the PostgreSQL suite.
  - Plants are already derived before the routing check.
  - CSP effort is L.
  - A plain `COALESCE` on run time would freeze stale durations.
- **Migration gate:** `apply-migrations.ps1` treats every `ALTER` as destructive, so routine `ADD COLUMN IF NOT EXISTS` migrations need `-AllowDestructive`. The gate doesn't do what the skill text implies. This is outside this scope; record it in `docs/MIGRATION.md`.
- **Naming:** N6 shipped as `admitted-state-unrecorded`, not `admitted-unknown-state`.
- **Grep hygiene:** `.worktrees/wave0-code-review-fixes/` is a stale checkout, so exclude it from greps. The NUL bytes are gone, so Grep works again on `setup-scheduler.mts` and `orders.mts`.
- **Distribution audit follow-ups (2026-10-07):** the 62 throwaway reproductions from the 10-01 audit lived only in a session scratchpad and were probably never ported into `tests/test_distribution.py`, `tests/test_rbac_plant_scoping.py` and `distribution-pane.test.mjs`. Two earlier tests still pass for the wrong reason (the concurrent re-weight test doesn't delete children, and the run-time guard test bypasses `upsert_orders`); the ledger added real-DB tests beside them rather than rewriting them. A manual browser smoke check is still owed for D12, D29, D36, D48, D51 and D52, which were code traces only. D42's tie order and D60's query plans need `EXPLAIN` on Azure.
- **Unverified:** whether purge and Reset can race (purge doesn't lock headers), and D11's exact path, which wasn't re-traced end to end.
