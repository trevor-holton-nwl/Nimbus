# NIMBUS: Consolidated audit of the four reviews (2026-10-05, rev. 2 after the Fable stress test)

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
| **Sign-out clears local data (S5)** | When to clear the browser cache on shared PCs? | That cache is currently the *only* store of manual firms and cached unsaved edits. Do it only after "persist manual firm", or prompt when unsaved work exists, or it destroys planner work. |

---

## Open questions (cannot be answered from code)
- Is ingress still public, and is `NIMBUS_ALLOWED_ORIGINS` set to `*` on `ca-nimbus-dev`?
- Have the post-09-25 fix commits been deployed? Nothing is recorded since `f3dfb86`.
- Is optimizer budget starvation real at 70 lines? This needs a PerfMonitor capture.

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
- **Unverified:** whether purge and Reset can race (purge doesn't lock headers), and D11's exact path, which wasn't re-traced end to end.
