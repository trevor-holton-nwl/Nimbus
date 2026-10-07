# SAP Staging — Validation Plan

> Written 2026-10-07 for branch `feature/sap-staging` (20 commits, tip `2e3f0d0`). Purpose: find bad code, poor assumptions and weak spots **before** this first SAP interface reaches a live plant. Companion: `docs/SAP_STAGING_DESIGN.md` (design of record, decisions D1–D35), `docs/NIMBUS_INTERFACE_ARCHITECTURE.md` §7 (Mulesoft contract), `docs/DEPLOYMENT.md` (release steps).
>
> Status of what this plan validates: all unit tests green (1,075 JS / 871 Python), one read-only review round applied, **but zero database-backed tests have executed, no browser session has opened the new panels, and five facts about SAP and Mulesoft are still assumptions.** This plan exists because "tests pass" is not the same as "safe".

## 0. How to read this plan

Each section is a *lens*, not a file list. For every item: what we assumed, how it could be wrong, the check that would expose it, and the pass bar. Tracks run in this order because each one reduces the risk of the next:

| # | Track | Needs | Blocks |
|---|---|---|---|
| 1 | Assumption audit (facts we never verified) | people | 5, 6 |
| 2 | Database-backed tests (written, never run) | local Postgres | 3, 4 |
| 3 | Adversarial code review, second pass (independent eyes) | nothing | 4 |
| 4 | Scenario tests: the full lifecycle with a fake Mulesoft | local Postgres | 6 |
| 5 | Failure injection | local Postgres | 6 |
| 6 | Cutover rehearsal on a copy of the pilot database | DB copy | merge |
| 7 | Security of the Mulesoft login | local Postgres | merge |
| 8 | Performance at target scale | local Postgres | merge |
| 9 | Admin UI walk-through | browser | merge |
| 10 | Documentation vs. code | nothing | merge |

Exit criteria are in §11. Record findings in §12 as they come in.

---

## 1. Assumption audit — things we decided without evidence

These were decided on the owner's word or on a "recommended if true" answer. Each one, if wrong, changes behaviour in a way tests cannot catch. **Get the answer in writing from the named source before cutover.**

| # | Assumption (decision) | If wrong | Check | Source |
|---|---|---|---|---|
| A1 | Planning Plant equals the producing plant (D27) | Orders land on the wrong plant's machines or are rejected `unknown_plant` | PP confirms no plant plans for another in scope | PP |
| A2 | The export's "production line" field is the work-center value today's Excel MACHINE column carries (D32) | Every order has an unknown machine; distribution never resolves; all orders unassigned | Compare one real export row against one row of today's Excel file for the same order | SAP Dev |
| A3 | The Material Plant export carries all materials regardless of status (D33) | Materials that go inactive vanish from the snapshot and get deleted or flagged | Ask for the program's selection logic; compare a row count against a plant's material count | SAP Dev |
| A4 | SAP times are in the SAP system time zone, and that zone is one fixed value (D34) | Every start and finish is shifted by hours; echo never matches; first apply resets everything on every batch | Get the zone name; send one order with a known time and read it back | SAP Basis |
| A5 | The SAP planning horizon and NIMBUS visibility horizon are kept equal per plant (D22) | Orders in the gap are deleted as "vanished" on every apply | Add a cutover checklist line; compare the two numbers per plant before enabling auto mode | Planner lead |
| A6 | NIMBUS material numbers have no leading zeros and SAP's are all-numeric 18-char padded (D24) | Duplicates on cutover, or alphanumeric materials silently mismatched | Run the SQL in §6.1 against the pilot DB copy: count materials with leading zeros, count non-numeric ones | Us |
| A7 | SAP's subnetwork is NIMBUS's subnetwork with one trailing character (D25) | Wrong subnetwork on every material plant row | Compare five values from the export against `subnetworks.code` | Us + SAP Dev |
| A8 | Mulesoft can update rows in Postgres (not just insert) and can carry SAP's per-row import result back (D31) | Outbound rows never leave `ready`; the status tiles are meaningless; errors invisible | Integration team confirms CloudHub/on-prem, egress IPs, JDBC write capability, and whether the SAP import log is available per row | Integration |
| A9 | The SAP import updates only End Date/Time, Version and Firm, and SAP then back-schedules the start (D20 rationale) | If SAP also moves the finish to a factory-calendar boundary, the echo never matches and every Send causes a reset wave | Send one order, read the next export, diff all fields | SAP Dev |
| A10 | Row count Mulesoft writes = rows it inserted (completeness gate) | Gate always fails (batches stuck `ready`) or always passes (truncated batch applied) | Agree the definition in the contract; test with a deliberately short batch | Integration |
| A11 | Visibility horizon + 1 day equals "what SAP exported" for vanish purposes (D8) | See A5 | Same check | Planner lead |
| A12 | `firming_indicator == 'X'` in NIMBUS is SAP's planned-order firm flag (the Excel column was documented as a different SAP field) | Add-only firm rule sends 'X' for orders SAP never firmed, or misses ones it did | Check one firmed and one unfirmed order end to end | SAP Dev |

**Pass bar:** every row has a written answer. Any "no" reopens the matching decision with the owner before cutover.

---

## 2. Database-backed tests — written, never executed

Every `@pytest.mark.pg` test added on this branch has only been collected, never run. These are the tests that exercise the destructive paths.

**Setup.** Local Postgres 18, empty database, `schema.sql` applied, then both `migrations/2026-10-08-*.sql` re-applied (proves idempotency), `NIMBUS_TEST_DB=1`, `.env` pointing at localhost only (the guard refuses Azure; do not work around it).

**Run, in this order, and keep the output:**
```
python -m pytest tests/test_schema_idempotent.py -q
python -m pytest tests/test_ingest_data_layer.py -q -k "purge or archive or hygiene"
python -m pytest tests/test_orders_routing_ingest.py -q -k "sap_changed or echo"
python -m pytest tests/test_sap_staging.py -q
python -m pytest tests/test_integration_routes.py tests/test_rbac_plant_scoping.py -q
python -m pytest tests/ -q
```

**What each must prove** (if a test does not exist for a line below, add it to the same file):
- Purge by ids retires distribution shares, deletes orphan headers, writes one audit row in the same transaction; nothing is deleted when the id list is empty.
- Archive then restore round-trips an order **with** schedule segments and keeps `id`, `xmin` unaffected for untouched orders; restore of an already-restored row is refused.
- Date hygiene on the staging path produces identical results to the Excel path for the same inputs (parametrise both over one fixture set).
- Material-plant apply: creates a bare `materials` row; deletes an unreferenced absent row; flags a referenced one; a rejected duplicate protects its live row; the 25 % hold trips on a truncated snapshot; audit row present.
- Planned-order apply: upsert through the shared path; vanish deletion only after a complete batch; 24 % applies, 26 % holds; confirm applies; frozen deletion set aborts with `revalidate_required` when the live set grows; routing-off holds `routing_required`; zero open quantity lands in Needs Planning; running order is deleted when vanished (D21, deliberately) and is in the archive.
- Resume after a forced exception mid-apply: re-run reaches `applied`, nothing deleted twice, no duplicate archive rows.
- Poll: newest batch wins, older becomes `superseded`; upload batches never auto-apply; advisory lock makes a second concurrent poll skip.
- Outbound: queue → `ready` rows; re-queue retires old ones; unchanged orders keep their `xmin`; roll-up end equals the latest child end; firm truth table.
- Schema parity: `schema.sql` fresh build equals `schema.sql` + migrations.

**Pass bar:** whole suite green with **no** `pg` skips. Any failure is a Blocker until understood.

---

## 3. Adversarial code review — second, independent pass

The first review was done by the same model family that wrote the code, from a prompt I wrote. A second pass must be *differently framed* so it does not re-find the same things. Three personas, each read-only, each told nothing about the first review:

**3.1 "Break the deletion"** (persona: hostile data). Only question: *how do I make NIMBUS delete an order or material it should keep, or keep one it should delete?* Inputs to try, reasoning from the code: a batch whose `plant` differs from its rows; a batch with every row rejected `invalid_date` but valid keys; a batch of 0 rows with `row_count_expected = 0` for each object; two batches for one plant ready within the same second; a header set to `ready` while rows are still arriving; a batch for a plant whose visibility horizon is NULL, then set, then NULL again between validate and apply; an order whose `sap_basic_start_date` is NULL; a distribution child whose parent is in the batch under a different material; a production version referenced only by an order outside the horizon.

**3.2 "Break the schedule"** (persona: a planner mid-shift). Only question: *how does this branch lose a planner's work or move an order they did not touch?* Paths: auto-apply during a save (xmin, `stale` list, overlay); echo rule when the planner changed the version but not the end; echo when SAP shifts the finish by one minute; two Sends ten seconds apart; a Send while a batch is applying; the one-time first-apply reset (D19) — measure how many orders on the pilot copy would reset (§6.2); the midnight-crossing echo limit (known, quantify how many orders it would hit per plant).

**3.3 "Break the contract"** (persona: a Mulesoft developer who read only `NIMBUS_INTERFACE_ARCHITECTURE.md` §7). Only question: *following the document literally, where does my implementation disagree with the code?* Compare every column, type, status, and SQL statement in §7 against `schema.sql` and `sap_staging.py`. Try the guard trigger with every forbidden transition. Check whether the document tells me what to do on a Mulesoft-side retry, a network drop between rows and header, and a batch NIMBUS rejected.

**Also in this track — code-quality lens on the new module itself** (`backend/integration/sap_staging.py`, ~1,900 lines after fixes):
- Is it one module doing five jobs (poll, validate, apply, outbound, upload)? Candidate split: `staging_validate.py`, `staging_apply.py`, `staging_outbound.py`. Decide, don't drift.
- Every function that takes `conn=None`: does it commit when it should not, or not commit when it should? Table them.
- Every `except Exception`: is the exception logged with the batch id? Is any swallowed?
- Every raw SQL string with a `%s`: parameterised, and is `plant` always in the WHERE?
- Every place a staging row's text becomes a number, date, or time: one helper or five copies?
- Dead code and duplicated helpers introduced by the three fix commits.

**Pass bar:** each persona delivers a ranked list with "verified" or "not reproduced" per item; every High is fixed and gets a regression test in the existing test file.

---

## 4. Scenario tests — the full lifecycle with a fake Mulesoft

Script a fake Mulesoft in SQL (`scripts/fake_mulesoft.py`, throwaway, not shipped) that connects **as `nimbus_mulesoft`** and performs the contract exactly. Run each scenario on the local DB with the app running and the poll set to 10 seconds.

| # | Scenario | Expect |
|---|---|---|
| S1 | Material plant snapshot, 50 rows, manual mode | Batch `validated`; Apply → live rows; previous batch deleted; grid shows values |
| S2 | Same snapshot again | All rows `unchanged`; no audit noise; no `xmin` change on live rows |
| S3 | Snapshot missing 5 unreferenced + 5 referenced materials | 5 deleted with audit, 5 flagged `sap_missing_since`; next full snapshot clears the flag |
| S4 | Production versions, then routing operations, then planned orders for a routing-on plant | Orders scheduled with routing-derived run times; none at 1.0 h default |
| S5 | Planned orders for a routing-off plant | `held`, `routing_required`; enabling routing then Validate → `validated` |
| S6 | Planned-order snapshot with 30 % of orders missing | `held`; confirm modal lists exactly those orders; Confirm → archived + deleted + shares retired; Restore one → back on the Gantt after reload |
| S7 | Send to SAP for the plant; fake Mulesoft marks half `sent`, half `error` | Tiles correct; error CSV correct; `order_sap_sent` row present for every sent order |
| S8 | Next planned-order snapshot echoing the sent finishes with back-scheduled starts | **No** order loses its slot; baselines updated |
| S9 | Same, but one order's finish differs by 2 hours | Only that order resets; siblings of a distributed parent reset together |
| S10 | Auto mode on; snapshot arrives while a planner has an unsaved drag | Planner's save shows the concurrent-edit notice; server state wins; nothing crashes |
| S11 | Upload an Excel with SAP headers on an auto object | `validated`, never applied until clicked |
| S12 | Mulesoft retry: same rows, new UUID, 30 s after the first | Older batch `superseded`; newest applies once |
| S13 | Converted order (dropped from export) that is currently running | Deleted (D21), archived, visible in Archive panel |
| S14 | Zero open quantity order | Needs Planning with reason; not on the Gantt |
| S15 | 24-hour plant with finishes at midnight SAP-zone, plant zone differs | Count how many orders reset on echo (known limit L1); report the number to the owner |

**Pass bar:** every expectation met; S8 and S10 are the ones that protect planners and must be demonstrated, not inferred.

---

## 5. Failure injection

| # | Inject | Expect |
|---|---|---|
| F1 | Kill the app mid-apply (after the upsert, before vanish) | Batch `applying`; restart; poll resumes; deletion happens once; archive has one copy per order |
| F2 | Kill the app mid-apply (during upsert chunk 2 of 5) | Resume completes; counts coherent; no duplicate orders |
| F3 | Postgres restart while the poll holds the advisory lock | Next poll acquires the lock (session lock died with the connection) |
| F4 | Mulesoft sets `ready` with `row_count_expected` 10 % too high | Batch stays `ready` with `incomplete_rows`; after timeout → `rejected`; admin sees why |
| F5 | Mulesoft inserts rows for plant B under a header for plant A | Every row `plant_mismatch`; batch `rejected`; nothing applied |
| F6 | Two app replicas (run uvicorn twice on different ports against one DB) with the poll on | Only one processes each tick; no double apply |
| F7 | `NIMBUS_SAP_SYSTEM_TZ=Not/AZone`, `NIMBUS_SAP_STAGING_POLL_SECONDS=abc` | App boots; warning logged; conversion falls back predictably (define what "predictably" is and test it — today an unknown zone name raises inside `sap_to_plant_local`; decide: reject the row or treat as UTC?) |
| F8 | A staging row with a 19-character material | `key_too_long`; the batch still applies the rest |
| F9 | A `materials` row that violates a NOT NULL you did not expect | Apply → `error` with the step name; resumable after fixing data |
| F10 | Disk full / statement timeout during the archive copy | Transaction rolls back; nothing deleted without an archive copy |

**Pass bar:** no scenario leaves the live tables in a state that a re-run cannot repair, and every one leaves a readable `error`/warning on the batch.

---

## 6. Cutover rehearsal on a copy of the pilot database

This is the only track that tests *our data* rather than fixtures. Restore a recent `pg_dump` of `pgdb-nimbus-dev/nimbus` into local Postgres. Never run this against Azure.

**6.1 Data-shape queries (run first, record the numbers):**
- Materials with leading zeros; non-numeric materials; materials longer than 18.
- Orders whose `production_order` has leading zeros; duplicates after stripping.
- `material_plants.subnetwork` values and their lengths vs `subnetworks.code`.
- Plants with NULL `visibility_horizon_days`, NULL `timezone`, `routing_runtime_enabled` off, `frozen_horizon_days` 0.
- Orders with NULL `sap_basic_start_date` (they can never vanish — is that intended for pre-existing Excel orders?).
- Orders currently running (effective start ≤ now < effective end) per plant — the D21 exposure.

**6.2 Dry cutover:** apply the two migrations, then feed the fake Mulesoft a snapshot built *from the copy's own orders* (same orders, SAP-shaped). Measure: how many orders reset on first apply (D19), how many would vanish (should be ~0), how many materials would be deleted or flagged, how long apply takes. Then a second identical snapshot: everything must be `unchanged`.

**6.3 Migration runner:** run `.claude/skills/promote-azure/scripts/apply-migrations.ps1 -DryRun` against the copy; confirm both files are listed and both need `-AllowDestructive`; confirm the manual role file is *not* picked up.

**Pass bar:** first-apply reset count is known and accepted by the owner; second apply is a no-op; migration runner behaves as documented.

---

## 7. Security of the Mulesoft login

Connect to the local DB as `nimbus_mulesoft` (after running the manual script) and attempt, expecting failure for each:
- `SELECT` from `orders`, `plants`, `users`, any non-staging table.
- `INSERT` into `sap_stage_batch` with `status='applied'` (trigger forces `loading`).
- `UPDATE sap_stage_batch SET status='applied'` on a `loading` row; `ready → applied`; `applied → ready`.
- `INSERT` into a row table setting `row_status='valid'` or `material_id`.
- `DELETE` from any table; `UPDATE` any column not granted on the outbound table.
- `INSERT` into `sap_stage_batch` with `source='upload'` (trigger forces `mulesoft`).
Then the positive path: the exact §7 contract sequence succeeds.

Also: confirm the role has no `CREATE`, `TRUNCATE`, or sequence `UPDATE` beyond `USAGE/SELECT`; confirm `sslmode=require` is enforced server-side for this role (`pg_hba` on Azure: hostssl only); confirm the password lives in a Container App / Key Vault secret, never in git or a doc.

**Pass bar:** every forbidden action errors; the contract sequence succeeds; grants re-run idempotently.

---

## 8. Performance at target scale

Targets from the root `CLAUDE.md`: 50+ plants, 70+ machines per plant. Synthesize one plant with 10,000 planned orders, 5,000 material plants, 20,000 routing operations; and 50 plants with 500 orders each.

Measure (local DB, app running):
- Validate time and apply time per object for the big plant; the vanish candidate query plan (`EXPLAIN ANALYZE`) — it must use the plant index, not scan `orders`.
- Poll tick duration with 50 ready batches; thread-pool occupancy (does a 10-minute apply starve `/upload` or `/tasks`?).
- `GET /sap/staging/batches` with 5,000 batches in history (retention should keep this small; confirm).
- Outbound queue for 10,000 orders: time, and the `order_sap_sent` upsert row count (must equal changed orders only) and that no `orders` xmin moved.
- Interface tab render with 50 batches and a 5,000-row deletion list in the confirm modal (capped at 200 rows displayed; confirm the cap).

**Pass bar:** apply of 10,000 orders under 2 minutes; no query without an index on `plant`; the UI stays responsive.

---

## 9. Admin UI walk-through (browser)

Nobody has opened these panels. Walk every control in Admin › Interface as an admin, then as a plant-restricted admin:
- Rail: staging objects first; no enable switch; status line correct for `loading`, `ready`, `held`, `applied`, `error`.
- Apply-mode select + hint; change persists; reflected after reload.
- Batch list per status: the right buttons only (no Validate on `rejected`; Retry on `error`); Refresh triggers a poll and the list updates.
- Rejected-rows drawer; CSV download opens in Excel with correct columns and no formula injection (`=1+1` in a reason text stays literal).
- Confirm & Apply modal: lists held reasons; lists deletions with order/material/machine/end/firmed; for master objects shows keys; "+N more" cap.
- Upload zone: disabled without a plant; a bad file gives a readable 400; a good file lands as `validated`.
- Outbound: tiles; Send confirm wording; error CSV.
- Archive: list; Restore confirm; restored row marked.
- Plant-restricted admin: cannot see or act on other plants' batches (403 surfaced as a toast, not a blank screen).
- All five locales: switch language; no raw keys; no English leaking in de/es/fr/pt.
- Keyboard: every button reachable by Tab; modals close on Escape.
- Dark theme and phone width (per `DESIGN.md` rules).

**Pass bar:** no console errors; every action gives feedback; nothing requires reading the code to understand.

---

## 10. Documentation vs. code

- `NIMBUS_INTERFACE_ARCHITECTURE.md` §7 column lists == `schema.sql` (diff them mechanically).
- Every route in `backend/integration/CLAUDE.md` exists with the stated guard (grep `_ADMIN_WRITE_OPERATIONS`).
- Every rejection/warning code in the docs is emitted somewhere, and every emitted code is documented (grep both ways).
- `docs/SAP_STAGING_DESIGN.md` D1–D35 match behaviour; D20 carries the refinement; D21 (running orders deleted) is stated plainly where planners will read it.
- `DEPLOYMENT.md` steps can be followed by someone who did not build this: have a reviewer do it on the DB copy without asking questions.
- The FSD change requests (Material Description, routing SAP field names) are filed with SAP Development and referenced.

---

## 11. Exit criteria (merge gate)

1. Tracks 1–10 complete with findings logged in §12.
2. Every `pg` test executed and green on a local Postgres.
3. All High findings from track 3 fixed with regression tests; Mediums fixed or explicitly accepted by the owner in §12.
4. Cutover rehearsal numbers (first-apply resets, vanish count, timings) reviewed and accepted by the owner.
5. Assumptions A1–A12 answered in writing; any "no" resolved.
6. Owner decides: merge to `main`, and whether to deploy with the poll **off** (`NIMBUS_SAP_STAGING_POLL_SECONDS=0`) until Mulesoft is ready — recommended.

---

## 12. Findings log

| Date | Track | Severity | Finding | Status |
|---|---|---|---|---|
| | | | | |

---

## Appendix — Context

**Brief (owner, 2026-10-07):** "Draw up a validation plan to validate everything that we just did. To look for bad code, poor assumptions, weak code."

**Why this shape:** the branch was built in one day by delegated agents, reviewed once by the same model family, and never touched a database or a browser. The weakest evidence is for the most destructive paths (vanish deletion, master deletions, echo), so the plan front-loads the human-fact audit and the database-backed tests, and uses differently-framed reviewers so the second review is not a replay of the first.

**Known limits already accepted (not re-validated here):** global poll endpoint; 413 after read; no-timezone plants skip conversion; requeue race benign; midnight-crossing echo miss (quantified in S15, not fixed).

**Things learned along the way:** both new migrations trip the deploy runner's destructive filter; `apscheduler` is in `requirements.txt` but was missing from the dev venv; `generate:api-types` calls bare `python` and needs the venv interpreter on this machine; the worktree has no `.env`, which is why the whole Python suite collected without the Azure guard refusing.
