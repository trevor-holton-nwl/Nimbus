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

### Track 4 results (2026-10-07)

Run on the local test database `nimbus_sapstage_test` with the real app on port 8021 (poll 10 s, SAP system zone UTC, admin identity by header) and a throwaway fake Mulesoft that connected as `nimbus_mulesoft` and followed `NIMBUS_INTERFACE_ARCHITECTURE.md` section 7 literally (header without status, rows, mark ready with the row count, outbound `FOR UPDATE SKIP LOCKED`). Dates `YYYYMMDD` and times `HHMMSS` in UTC, materials padded to 18 characters, order numbers to 10. Test plant `ZZS` (America/Chicago): machine M1 on single work center WC1; machines M2 and M3 on distributed work center WCD (weights 1:1); 24-hour calendar; horizon 30 days, frozen 2 days; routing runtime on with production versions and routing operations; 30 plain orders plus 6 aggregates (42 order rows) loaded through the real Excel ingest, then planner state through the real `/tasks/update` route (26 orders with a slot, 4 firmed, 3 with two segments, both children of three aggregates scheduled, one order running right now). Every scenario re-seeded the plant unless it says it continued the previous one. First runs of S2, E2 and E3b failed and led to the fixes F2 to F4 in section 12; the table shows the final run after the fixes.

| # | Verdict | What was observed |
|---|---|---|
| S1 | PASS | 50 padded Material Plant rows: poll validated them, two further polls did not apply (manual); Apply wrote 50 rows (status, lot sizes, subnetwork cut to 3 characters); the master-data grid shows the new values. |
| S2 | PASS (after fix F3) | Same snapshot again: 50 `unchanged`, `xmin` identical on all 50 rows, no new `admin_audit` row, previous batch gone (one batch left, the new one). First run failed: all 50 re-written. |
| S3 | PASS | 40-row snapshot (20 % missing, not held): 5 unreferenced deleted with one `sap_snapshot_vanish` audit row, 5 referenced kept and flagged `sap_missing_since`; the next full snapshot cleared all 5 flags. |
| S4 | PASS | Material Plant (55), Production Versions (15), Routing Operations (30), then Planned Orders (36 echoed + 5 new): the 5 new orders were scheduled with routing run times (4, 6, 8, 10, 12 h = quantity / 50), none at the 1.0 h default. Extra: a sixth new order with a blank production version on a material with no default went to Needs Planning (`runtime_unknown`), as designed. |
| S5 | PASS | Routing off: batch `held` with `routing_required`; after switching routing on, Validate gave `validated`. |
| S6 | PASS | Snapshot without 11 parents (the running order, 9 plain, 1 aggregate = 12 of 42 rows): `held` (`vanish_threshold`); the deletion list holds exactly those 12 rows; Confirm archived and deleted 12 (header and shares of the aggregate gone, 4 segments cascaded); Restore of one order put it back on `/tasks`. |
| S7 | PASS | Send queued 36 rows (17 firmed, 6 rolled-up aggregates); Mulesoft marked 18 `sent` / 18 `error` with an SAP-log reason; tiles 0/18/18; error CSV 18 lines; `order_sap_sent` has a row for all 42 order rows. |
| S8 | PASS | **Protects planners.** All 36 finishes echoed with the start back-scheduled 14 h earlier: slot, firm flag, segments and status identical on 42 of 42 rows (26 had a slot); the SAP start baseline moved on 30 of 30 plain orders. |
| S9 | PASS | One slotted plain order and one aggregate finishing 2 h later: exactly those three rows reset (the plain order and both children of the aggregate, together); 39 others untouched. |
| S10 | PASS | **Protects planners.** Auto mode: echo batch auto-applied; planner loaded `/tasks`; SAP then moved one order's finish and the poll auto-applied it (`xmin` changed for that order only, its slot was reset). The planner's save with the old versions: the bulk call returned that order in `stale` and persisted the other drag (the untouched order, `xmin` unchanged); the single-order route also returned `stale`; the server's slot stayed; no error in the app log. |
| S11 | PASS | Excel with SAP headers uploaded on an auto object: `validated`, source `upload`, still `validated` 28 s (two polls) later. |
| S12 | PASS | Retry 30 s later with a new UUID: older batch `superseded`, Apply on it returns 409, newest applied once (one `sap:sap` audit row). |
| S13 | PASS | The order running right now, absent from the snapshot: deleted (D21), archived, shown in the Archive. |
| S14 | PASS | A new order with total = reduced and a scheduled order whose reduced quantity was raised to its total: both in Needs Planning (`zero_open_quantity`), slot cleared, status visible on `/tasks`. |
| S15 | PASS (measured) | Six slotted orders were moved to finish at 19:00 Chicago (= 00:00:00 SAP time); five of them kept that finish (one had segments); SAP echoed every finish exactly as sent (midnight ones arrive as date + `000000`): **5 orders reset, exactly the 5 sent at SAP midnight**; none of the other 31. In the seeded plant (finishes at :15) the natural number is 0 of 36. |
| E1 | PASS | Snapshot built from the plant's own 36 parent orders (their SAP baselines): first apply **0 slots reset**, 0 rows removed; but every one of the 42 rows was written once (SAP-sent production version NULL becomes blank, so `xmin` moved on 42 of 42, see F5). A second identical snapshot: 42 `unchanged`, `xmin` identical for all 42, first batch removed. |
| E2 | PASS (after fix F2) | Description, labor hours and FTE identical on 42 of 42 orders (16 carry labor/FTE). First run: the 12 distribution children lost them. |
| E3 | PASS (after fix F4) | Send twice: `xmin` unchanged on 42 of 42 both times, `order_sap_sent` on 42 rows. Echo with back-scheduled starts keeps every slot (S8). Partial conversion (reduced quantity up by 50, total same) on 4 plain orders and 1 aggregate keeps all slots; first run reset all of them. |
| E4 | PASS | App started with `NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN=1`: a header never marked ready was rejected `stale_loading` after 67 s. |
| E5 | PASS | `GET /sap/staging/batches/{id}/deletions` returns `running` on every item (true for the running order). |

**S15 number: 5 orders reset** (all five with a finish at exactly 00:00:00 SAP time while plant and SAP zones differ; the rule is "an order whose sent finish falls on the SAP-zone midnight minute resets on echo", about 1 order in 1,440 minute positions, far more often where shifts end on the hour and the zone offset is a whole number of hours). **E1 reset count: 0** slots on first apply when SAP's snapshot equals the Excel baselines; D19's one-time reset therefore only happens where real SAP data differs from the loaded Excel data.

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

### Track 5 results (2026-10-07)

Run on the local test database `nimbus_sapstage_test` (never Azure). Test plant `ZZF` (America/Chicago, 24 h, horizon 30 days, frozen 2 days, routing runtime on with production versions and routing operations): 100 plain orders and 20 aggregates (120 planned orders, 140 order rows with the 40 sub-orders), loaded through the real Excel ingest. Snapshots were built from the plant's own orders with each total raised (so every upsert chunk really writes) and 15 parents left out (17 order rows vanish). The throwaway fake Mulesoft from Track 4 delivered the batches. **Kills and crashes:** `apply_batch` ran in a separate Python process with a crash hook in a wrapper script (`os._exit(1)` from a patched `db.purge_orders_by_ids` / `db._purge_order_ids_on_cursor` / `psycopg.Cursor.executemany`); no hook is in repo code. **F2 chunking:** the real chunk is 500 rows and the plant has 140, so the crashing child set `db._UPSERT_CHUNK = 30` (5 chunks) instead of inserting 500+ rows. **F3:** the Postgres Windows service was not restarted; `pg_terminate_backend` on the session that holds the lock is the stand-in. **F6:** two real uvicorn instances on 8021 and 8022, poll 5 s, planned orders in `auto` mode (reset to `manual` afterwards).

| # | Verdict | What was observed |
|---|---|---|
| F1 | PASS | Crash after the upsert and zero-open steps, before the vanish delete: batch `applying`, step `vanish`; 140 orders intact, archive empty, no advisory locks left (the dead process's session lock died with its connection). `poll_once` did **not** pick the batch up (the poll only visits `ready`/`validated`; resume is the admin's Apply, as documented, see finding below). Apply resumed it: 17 deleted, 17 archived, orders 123 (= 140 - 17), exactly one `sap_snapshot_vanish` audit row, one archive row per vanished order (17 distinct ids, equal to the expected set), 0 duplicate orders; a second Apply was refused (`batch is applied`). **F1b (extra):** crash inside the purge transaction (archive copy and delete executed, not committed): Postgres rolled both back, 140 orders and 0 archive rows; the resume deleted 17 once. |
| F2 | PASS | Crash while chunk 2 of 5 was being written (chunk size 30): chunk 1 committed (30 rows written), chunk 2 rolled back, batch `applying`, step `upsert`, nothing deleted. Resume: 93 updated + 30 unchanged = 123 rows, 17 deleted and archived, 123 orders, no duplicates, every kept order carries the new total. Note: the batch's final `counts` describe the resume run only (see finding). |
| F3 | PASS (stand-in) | A session held the poll lock: `poll_once` reported `another poll is running`; after `pg_terminate_backend` on that session the next poll ran with no skip and no error, and no advisory lock was left. Same for the apply lock (`sap:apply:stage_planned_orders:ZZF`): Apply refused with `apply_in_progress` while held, then applied after the holder was terminated. |
| F4 | PASS | Rows 120, `row_count_expected` 132 (10 % too high), loading timeout 1 minute: the poll skipped it every tick and the batch stayed `ready`; `GET /sap/staging/batches/{id}` showed `row_count_expected 132`, `actual_rows 120`, **no warning yet**; a manual Validate gave 409 `incomplete_rows` ("expected 132 rows, found 120"); a manual Apply gave 409 `not_applicable`. After the timeout: `rejected`, error `incomplete rows: expected 132, found 120`, warning `incomplete_rows`. Nothing applied. |
| F5 | PASS | Eight rows for plant 1006 under a header for ZZF: all eight `plant_mismatch`, batch `rejected` (`no valid rows in batch`), Apply refused, ZZF orders 140 -> 140 and unchanged, plant 1006 still 0 orders. |
| F6 | PASS | Two instances, same database, poll 5 s. One ready batch (F6a): validated once and applied once (`upload_audit` one row), by one instance. Five batches arriving 7 s apart (F6b): each validated once and applied once, one `upload_audit` row each, 0 error events. Five batches in one burst (F6c): the newest applied once, the other four `superseded`, one `upload_audit` row in total. Over the whole run the second instance logged 6 skipped polls (`another poll is running`) and applied nothing; the first applied 7 of 7. |
| F7 | PASS (after fix, section 12) | App started with `NIMBUS_SAP_SYSTEM_TZ=Not/AZone`, `..._POLL_SECONDS=abc`, `..._LOADING_TIMEOUT_MIN=-5`, `..._STATEMENT_TIMEOUT_MS=x`: it boots; warnings in the log for the zone (loud, at import), `abc` (default 0 used, poll off), `x` (default 600000) and, after the fix, for `-5` (floored to 1). **Defined behaviour for an unknown or blank SAP zone: batches still validate, every batch carries the error-level warning `sap_system_tz_invalid`, planned-order Apply is refused (409, code `sap_system_tz_invalid`, nothing written), Send to SAP is refused (400); material, production-version and routing batches are not time-dependent and still apply.** Verified over HTTP on the running app. Before the fix the same batch applied with no conversion and no warning. |
| F8 | PASS (after fix, section 12) | Material Plant batch: 50 good rows plus one with a 19-character material: the long row `key_too_long`, the other 50 applied. Planned orders: before the fix a 19-character material was accepted and a **new** order was created (`orders.material_number` is TEXT); after the fix that row is `key_too_long` and the rest of the batch (119 rows) applies. Production-version and routing staging columns are `VARCHAR(18)`, so Mulesoft's own insert fails there before NIMBUS sees it. |
| F9 | PASS | Dropped the default of `materials.material_description` (the bare-row insert only names `material_id`): Apply ended `error` with `create_materials: NotNullViolation: null value in column "material_description" ...`; no material or material-plant row written, no lock left. After restoring the default, Apply resumed and finished (2 materials created, 52 material-plant rows). |
| F10 | PASS | (a) A `BEFORE INSERT` trigger on `sap_stage_vanished_order` raised: Apply ended `error` at step `vanish`, the 17 orders still live, 0 archive rows, 0 vanish audit rows (the purge is one transaction: archive copy, delete, audit). After dropping the trigger the resume deleted and archived 17. (b) The same trigger sleeping 3 s with a 1.5 s statement timeout on the purge connection: `QueryCanceled`, same clean rollback, same resume. Note the knob that applies there is the pool's `NIMBUS_PG_STATEMENT_TIMEOUT_MS`: the purge runs on its own pool connection, not on the staging module's raised-timeout connection, and `NIMBUS_SAP_STAGING_STATEMENT_TIMEOUT_MS=1` is floored to 1000. |

**Cleanup:** plant `ZZF` and all its rows, the test admin user, test audit rows from this run and the F9/F10 schema changes (column default, trigger, function) were removed; an `information_schema` columns / triggers / indexes comparison before and after shows no difference. No app instance is running. Full suite after the fixes (pg env, apps stopped): `1266 passed, 1 skipped` (1263 + 3 new tests).

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

### Track 8 results (2026-10-07)

**Verdict: all three bars pass; no code or schema change was needed.** Run on a scratch local database (`nimbus_perf_test`, 204 MB, dropped afterwards) with the app on port 8031 against it; the fake Mulesoft logged in as `nimbus_mulesoft`. Everything below is a local single-process uvicorn on a developer laptop, so read ratios, not absolute numbers.

**Data synthesized** (about 13 s of seeding: master data and the 50 background plants by set-based SQL, the ZP01 orders through the real fake-Mulesoft, validate, apply path, then shaped by SQL):

| What | Volume |
|---|---|
| ZP01 (America/Chicago, 30-day horizon, 2-day frozen, routing on, 24x7 calendar) | 70 work centers and machines, 10,000 planned orders spread over 29 days, 2,500 scheduled with slots (25 %), 500 firmed, 400 with firming indicator `X`, 250 scheduled orders with two segments (500 segment rows) |
| ZP01 master data | 5,000 material plants, 2,000 production versions, 20,000 routing operations (10 per routing, on 10 work centers each) |
| ZP02-ZP51 | 50 plants x 500 orders (25,000 rows, one in four scheduled), 10 work centers each, 100 material plants / production versions each, 10 operations per routing (all plants: 10,000 material plants, 7,000 production versions, 70,000 routing operations, 35,000 orders, 570 machines) |

The initial load of the 10,000 ZP01 orders through the real path (insert 0.5 s, validate 0.6 s, apply 8.1 s, all 10,000 inserted, all given a routing run time) doubles as the first-ever-apply number.

**Timings** (seconds; median of three cycles for items 1 and 2, three runs for item 3; "first" = the batch changes data, "again" = an identical batch right after):

| Object | Mulesoft insert | Validate | Apply, first | Apply, identical re-apply |
|---|---|---|---|---|
| Material plants, 5,000 | 0.29 | 0.12 | 0.43 (5,000 updated) | 0.19 (5,000 `unchanged`) |
| Production versions, 2,000 | 0.17 | 0.07 | 1.14 | 1.09 (still 2,000 `updated`, the known open Track 4 F3 behaviour) |
| Routing operations, 20,000 | 0.88 | 1.38 | 4.14 | 4.27 (scoped replace rewrites all 20,000 by design, then a plant recompute) |
| Planned orders, about 9,700 sent (5 % changed total, 3 % absent, 2 % new) | 0.46 | 0.48 | 8.08 (200 inserted, about 480 updated, about 300 deleted and archived; runs 4.3, 8.9, 8.1) | 7.9 (all `unchanged`) |

Planned-order breakdown of one apply: shared `db.upsert_orders` 7.0 s (6.8 to 7.8, the cost is the chunked `executemany` round trips and per-row comparisons, not any one query), `build_order_rows` 0.5 s, vanish candidates 0.01 to 0.03 s, **vanish delete (`purge_orders_by_ids`, archive then delete 300 orders) 0.07 to 0.13 s**, the gate queries 0.01 to 0.03 s. Validation of a planned-order batch: 0.4 to 0.7 s (python verdicts 0.19 s, set-based write 0.12 to 0.25 s). That cost is inherent to the shared upsert path (item 3 of the plan's rule) and was left alone: apply is about 15 times under the 2-minute bar.

**Apply while the app is in use** (apply and validate through the HTTP routes on 8031; a probe thread called `GET /tasks?plant=ZP01` back to back, which returns the full 10,000-order plant, 14.2 MB, and once a second `GET /sap/staging/batches`, `GET /tasks/horizons?plant=ZP01` and `GET /health`; another thread sampled `pg_stat_activity` every 0.5 s):

| Window | `/tasks` full p50 / p95 / max | `/sap/staging/batches` p95 | `/tasks/horizons` p95 | `/health` p95 | non-200 | DB connections (max total / active / idle in transaction / waiting on a lock) |
|---|---|---|---|---|---|---|
| Idle, 30 s | 1.86 / 1.97 / 2.16 s | 0.38 s | 0.37 s | 0.30 s | 0 | 2 / 1 / 1 / 0 |
| First apply (18.8 s over HTTP) | 2.03 / 2.54 / 2.54 s (9 calls) | 0.66 s | 0.30 s | 0.33 s | 0 | 4 / 3 / 2 / 0 |
| Identical re-apply (18.4 s over HTTP) | 2.05 / 2.47 / 2.47 s (8 calls) | 0.35 s | 0.30 s | 0.15 s | 0 | 4 / 3 / 2 / 0 |

p99 equals the max at these sample sizes (no request in any window exceeded 2.6 s, and the four light endpoints never exceeded 0.66 s). **No request on a light endpoint took over 1 s during apply**; the full `/tasks` load (itself about 2 s idle) grew about 25 %. The apply itself slowed from about 8 s to about 18.5 s because it shares the one Python process with a continuous 14 MB serialization loop; it never starved the app and never held more than 4 DB connections of the pool's 20. The apply, validate and poll routes all run their work in the thread pool (`run_in_threadpool`), so a long apply does not block the event loop, `/upload` or `/tasks`.

**Plans (`EXPLAIN (ANALYZE, BUFFERS)`, 26 statements, plant volume above plus 5,054 batch headers, 9,605 outbound rows, about 1,200 archive rows):**

| Statement | Execution | Plan |
|---|---|---|
| Vanish candidates (main, 5,000 hits) | 2.5 ms | `idx_orders_plant` bitmap scan, then filter (the `<> ALL (array)` filter is cheap at 4,600 sent keys) |
| Vanish family lookup | 0.03 ms | `idx_orders_parent (plant, parent_production_order)` |
| Validation gate count / in-horizon live count | 2.8 ms / 2.2 ms | `idx_orders_plant` |
| `held_deletions` detail with segments (5,000 rows) | 29 ms | `idx_orders_plant` AND primary key bitmap, segments by `idx_order_schedule_segments_order_start` |
| Outbound candidate rows (9,605) | 52 ms | `idx_orders_plant`, segments lateral by index |
| Validate set-based UPDATE, planned orders (4,605) / material plants (2,000) | 20 ms / 9 ms | primary key join to `unnest` |
| Stage row fetch, sent order numbers | 1.3 ms / 2.5 ms | `idx_sap_stage_planned_order_batch` |
| Sweeps: archive / outbound / dead batches | 0.04 / 5.6 / 1.5 ms | sequential scans of small tables (see note) |
| `list_batches`: default / status / object+plant / 5-plant scope | 1.3 / 0.7 / 0.08 / 0.7 ms | `idx_sap_stage_batch_lookup` or a top-N sort of the headers |
| Poll candidates, apply newer-batch check, supersede, previous-applied delete (cascading 4,605 rows) | 0.24 / 0.10 / 0.28 / 5.1 ms | `idx_sap_stage_batch_lookup` |
| Routing live keys (20,000 rows) / material plant live keys | 3.9 ms / 0.4 ms | plant-prefixed primary keys |

Flags: **no sequential scan on `orders` or `order_schedule_segments` anywhere, and every `orders` statement has `plant` in an index condition**, so no index was added. Four estimate-versus-actual mismatches above 10x, all harmless: the `<> ALL (array)` filter (estimated 1 row, actual 5,000, no choice of plan depends on it), the plant-plus-id-list bitmap AND (estimated 1,391, actual 5,000), and the top-N sort and sweep scans of the small `sap_stage_*` tables (estimated 300 to 9,600, actual 0 to 50). The two sweeps that scan (`sap_stage_planned_order_out` by status and age, `sap_stage_batch` by status and age) are bounded by the 30-day and 7-day retention; at the plan's own scale (a 10,000-order Send twice a day) the outbound table holds about 600,000 rows at steady state, which is a half-second scan once a poll tick, so an index on `queued_at` was not added (reopen if Send volume grows).

**Poll tick, 50 ready batches** (one per plant ZP02-ZP51, material plants, 100 rows each, apply mode `auto`): one tick validated and applied all 50 in **1.9 s** (changed data), 1.7 s (changed again), 1.2 s (unchanged); an empty tick takes 0.003 to 0.12 s; inserting the 50 batches took about 5 s. While the first tick ran, a second `poll_once` in the same process and a `POST /sap/staging/poll` to the app returned in 4 ms and 10 ms with `skipped: another poll is running`, `processed: 0`.

**`GET /sap/staging/batches` with 5,000 synthetic headers added** (4 objects, 51 plants, mixed `applied` / `rejected` / `superseded`, spread over 10 days): default call 8.6 ms and 36 KB (50 headers); `limit=500` 34 ms and 325 KB; `status=applied` 8 ms; object plus plant 5.7 ms; `limit=501` is a 422, so **the endpoint is bounded (default 50, maximum 500)**. Worst case, if the newest 50 headers each carry the full 5,000-key frozen deletion list, the query still reads that JSON from the database (877 KB) before `_header_dict` strips it: 32 ms, same 36 KB response. Retention: one poll tick (0.07 s) deleted the 1,011 rejected / superseded headers older than 7 days; none older remain. Normal operation keeps this table small by design: the latest applied batch per object and plant (at most 4 x 51 = 204 at 50 plants) plus 7 days of dead ones; 5,000 headers only appear if Mulesoft delivers hundreds of failing batches a day.

**Outbound, 10,000-order plant** (9,605 orders at that moment, all with an end): first Send 2.8 s, 9,605 outbound rows queued (1,379 firmed), 9,605 `order_sap_sent` rows, **0 `orders` rows with a moved `xmin`**. Second Send, nothing changed: 4.7 s, 9,605 new rows queued and the 9,605 previous `ready` rows retired as `requeued`, **0 of 9,605 side-table rows rewritten**, 0 `xmin` moves. Third Send after 50 scheduled orders were moved one hour: 4.6 s, **exactly 50 side-table rows rewritten**, 0 `xmin` moves. `outbound_status` and `outbound_rows` answered in under 50 ms at about 29,000 outbound rows.

**Deletions payload.** A held batch that omits 5,000 of 9,605 live orders (52 %, `vanish_threshold`) returns all **5,000 rows in `GET /sap/staging/batches/{id}/deletions`: 1.3 MB (261 bytes a row), 0.25 s median**. The "about 2,000" cap in the plan exists only for master-object batches (`held_deletions`: `absent[:2000]`; measured 3,000 candidates, 2,000 returned, 110 KB). **Planned-order deletions are not capped by the API** (the UI caps display at 200, and the frozen key list stored in the batch is capped at 5,000, `_FROZEN_KEYS_CAP`). The payload is bounded by the in-horizon order count of one plant (about 10,000 rows, 2.6 MB at the plan's scale), so it was left as is and recorded in section 12.

**Also noticed (not a Track 8 bar):** `GET /tasks?plant=ZP01` returns the whole 10,000-order plant (14.2 MB) in about 1.9 s; `limit` / `offset` exist but the UI does not use them. That is the existing scheduling contract, not part of this branch.

**Pass bars:** apply of 10,000 orders under 2 minutes: **pass** (8 s unloaded, 18.5 s with a continuous full-plant `/tasks` loop on the same process). No plant-unindexed hot query: **pass**. App responsive during apply: **pass** (light endpoints p95 and p99 at most 0.66 s, none over 1 s, no errors).

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

### Track 9 results (2026-10-07)

**Mechanism.** Playwright 1.64 driving a real Chromium (headless, real mouse / keyboard events, real file downloads, `page.on('console' / 'pageerror' / 'dialog')` capture) against the app on `127.0.0.1:8041` (poll off, SAP zone `UTC`), logged in through the real login screen. The Claude-in-Chrome extension was reachable, but a scripted browser was far quicker for 13 checklist items with downloads and five locales; screenshots are in the scratch folder. Test data: plants `ZUI` (routing on, 50 orders including one running) and `ZUI2` (routing off, 20 orders); an admin and a user whose role is limited to `ZUI`; batches in every status (real ones through the fake Mulesoft, `error` / `superseded` / `discarded` / `applied` / one extra `held` by SQL), a rejected batch whose material ids are `=1+1`, `@SUM(A1)`, `-2+3`; a 260-row master-data hold; outbound rows `sent` and `error` (via the fake Mulesoft); archive entries from a real apply that deleted 12 orders including the running one. Everything was removed afterwards.

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Rail: staging objects first, no enable switch, status line per state | PASS | Four staging rows under "Staging (Mulesoft)" before the seven connectors; `[data-enable]` only on connectors; the line shows the newest batch, e.g. `HELD · 20/0 ZUI2`, `APPLIED · 18/2`, `REJECTED · 0/8`. |
| 2 | Apply-mode select + hint persist | PASS | `<select>` (not pills); `auto` stays after a full reload and the hint switches between the manual / automatic sentence. |
| 3 | Buttons per status; Refresh polls; confirm only with deletions | PASS | validated: Apply + Discard; held: Confirm & Apply + Discard; ready: Validate + Discard; rejected: Discard only; error: Retry apply + Discard; loading / applied / superseded / discarded: none. Refresh moved a `ready` routing batch to `validated`. Plain Apply with 12 deletions opened the modal; with zero deletions it applied at once (no modal). Two fixes below (poll toast, empty counts). |
| 4 | Rejected drawer text; CSV literal | PASS after fix | Reasons read "The row's plant differs from the batch's plant." / "A key field is blank."; CSV has the BOM, raw code and a text column, and `=1+1`, `@SUM(A1)`, `-2+3` come out as `'=1+1` etc. (`csv_cell`; regression test already in `test_integration_routes.py`). The drawer also showed `row_status` and a raw timestamp column: removed. |
| 5 | Confirm & Apply modal | PASS after fix | Planned orders: order / material / machine / end / firmed / Running columns, the "deleted even if running, recoverable for 30 days" banner and "Running now" on order 4000001; master objects: key list capped at 200 with "...and 60 more." for 260 keys; held reasons listed. Fixed: wrong noun ("orders") for master objects, "1 of them are running now". |
| 6 | Upload zone | PASS after fix | Disabled with no plant ("Choose a plant first."); a non-spreadsheet and a CSV with foreign headers each give a toast with a readable 400 (the first had pandas wording, fixed); a 50-row SAP-header CSV on an `auto` object landed `validated` and stayed so after Refresh (never auto-applied). A 3-row file correctly landed `held` (94 % missing). |
| 7 | Outbound panel + invalid SAP zone | PASS | Tiles ready / sent / error; Send confirm names the plant and says every scheduled order is queued and firm flags are only added (no count in the dialog; the toast gives "Queued 32 orders for SAP (10 firm)"); error-rows CSV downloads. With `NIMBUS_SAP_SYSTEM_TZ=Bad/Zone` (second app on 8042, stopped) the batch shows the zone warning, Send gives a toast "...not a valid time zone name..." and Apply gives "Apply failed: The SAP time zone setting ... is not a valid zone name...". |
| 8 | Archive | PASS | 12 entries listed; Restore confirm names the order; after Restore the row shows "Restored <time>"; with the order id present again Restore gives "An order with this id already exists, so the archived order was not restored." |
| 9 | Plant-restricted user | PASS with finding | A user limited to `ZUI` has the Admin tab hidden and every `/sap/staging/*` call (list, apply, send, archive, both plants) returns 403 "Admin role required". A stale admin tab whose user was demoted shows the toast "Admin role required" and then "Could not load interface objects / HTTP 403", not a blank screen. See finding on plant scoping below. |
| 10 | Locales | PASS with findings | No raw `ui.` / `toast.` keys in any of the five locales across rail, all four objects, drawer, modals, toasts, outbound, archive. English seen in de / es / fr / pt: the shared confirm dialog's Cancel and Close (fixed); the free-text batch error "no valid rows in batch" (fixed); the backend's own database error text on an `error` batch (admin-facing, left); and the older connector chrome (subtitle, ribbon tiles, "Sync objects", Mapping / History tabs, "details") because 71 `ui.sap_*` / `toast.sap_*` keys exist only in `en.js` (pre-existing, logged). |
| 11 | Keyboard | PASS | 25 focusable controls, none with `tabindex=-1`; Tab reached 13 distinct controls in the staging pane in 60 presses, each with a visible focus ring; the plant combobox works with arrows + Enter; Escape closes the confirm dialog and focus returns to the clicked Apply / Confirm / Send / Restore button. |
| 12 | Dark theme and 390 px | PASS after fix | Dark (body class) renders cleanly. At 390 px the page has no horizontal scroll; the tables scroll inside their containers; the confirm dialog fits (350 px) with its buttons visible. Fixed: a wide rejected-rows table pushed the batch buttons off the right edge of the panel (grid `1fr` columns could not shrink). |
| 13 | 50 batches | PASS | 50 rows rendered 2.2 s after clicking the object (including two fetches and the plant pick), 0.29 s to re-render; zero long tasks (over 50 ms) recorded. |

Console: only the expected 400 / 403 / 409 network lines for the actions that were meant to fail; no page errors, no JS dialogs. Final checks: `npm run lint` 0 errors (35 existing warnings), `npm run typecheck` clean, `check:static-assets` and `check:legacy-surface` OK, the two node test files 27 / 27, full `pytest` (app stopped) `1267 passed, 1 skipped`.

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
| 2026-10-07 | 7 residual | Medium | The Mulesoft login could move its own outbound rows backwards (`sent` to `ready`, `error` to `sent`), so SAP would receive a row twice. | Fixed `a7ac1ed`: a `BEFORE UPDATE` trigger lets that login move a row only `ready` to `sent` or `error`; tested as `nimbus_mulesoft` (allowed and forbidden moves; NIMBUS's requeue still works); documented in architecture 7.7 / 7.8. |
| 2026-10-07 | 7 residual | Low | Any login can take advisory locks, so a leaked Mulesoft session could hold the poll lock and make NIMBUS skip each poll until that session ends. | Accepted: mitigated by the connection cap and `pg_terminate_backend`; code fix deferred (architecture 7.8). |
| 2026-10-07 | 4 (F2, E2) | Medium | The first SAP planned-order apply blanked description, labor hours, FTE and form size on every distribution child (the aggregate's header facts were rebuilt from the SAP row alone); plain orders already kept them. | Fixed `6661338` (`_plan_one_parent` keeps a value the incoming row does not carry); regression `test_sap_apply_keeps_excel_only_values_on_distributed_children`; E2 re-run PASS. |
| 2026-10-07 | 4 (F3, S2) | Low | A repeat Material Plant snapshot re-wrote every row (`updated_at` / `xmin` churn, counts said all rows `updated`, one empty `bulk_apply` audit row per apply). | Fixed `e29fd1f` (unchanged rows are dropped before the write, new `unchanged` count); regression `test_repeat_material_snapshot_rewrites_nothing`. Production versions have the same behavior (S4 showed `updated: 10` for 10 identical versions, plus a routing recompute); not changed, open and low. |
| 2026-10-07 | 4 (F4, E3b) | High | A partial conversion (SAP raises the reduced quantity, total unchanged) unscheduled the order, and the children of an aggregate: `upsert_orders` never passed the total to the change check (so the "judge the total" rule of D15 / A3 never took effect), and aggregates were judged on the open quantity at header level. Every partial conversion would have cost a planner the slot. | Fixed `f0df33e` (total passed for plain orders; header total compared when both sides know it); regression `test_partial_conversion_keeps_the_slot_for_plain_and_distributed_orders`; a changed total still resets. E3b re-run PASS. |
| 2026-10-07 | 4 (E1) | Low | The first SAP apply on an Excel-loaded plant writes every order once (the SAP production-version baseline goes from NULL to blank), so `xmin` moves on all rows: a planner's unsaved edit open at that moment gets one `stale` conflict. No slot is reset (0 of 26). | Accepted, one time per plant (D19 / D35); add to the cutover checklist: apply first at a quiet moment. |
| 2026-10-07 | 4 (S15) | Info | Known limit L1 measured: orders whose sent finish is exactly 00:00:00 SAP time, with plant and SAP zones different, reset on the echo. Plant ZZS: 5 of the 5 engineered orders reset, 0 of 36 naturally. | Reported to the owner (number above); no change. |
| 2026-10-07 | 4 | Info | A blank production version on a brand-new material (no default version in NIMBUS) lands in Needs Planning (`runtime_unknown`), not at a default run time. | As designed (D23). |
| 2026-10-07 | 4 | Low | `tests/test_setup_data.py::test_upload_captures_observation_before_ingesting_replacement` was already failing at the starting tip: review round 4 made the unknown-line lookup run through `run_in_threadpool`, and the test's stand-in recorded it as a second ingest. | Fixed `e855336` (test only). Full suite after Track 4: 1263 passed, 1 skipped. |
| 2026-10-07 | 4 (env) | Info | A running app with the poll on shares the test database: its poll picks up the batches that `pytest` creates and can fail timing-sensitive tests (`test_same_instant_batches_have_exactly_one_winner`, the >5,000-header scale test). Stop the app before running the suite. | Noted; the full run above was made with the app stopped and the test data removed. |
| 2026-10-07 | 5 (F8) | Medium | A planned-order row whose material was longer than 18 characters was accepted: `orders.material_number` is TEXT, so an order was created that no `materials` / `material_plants` / routing row (all `VARCHAR(18)`) can ever match; with a changed material for a known order number it also left a second order under the same number. | Fixed: `validate_planned_order_rows` rejects it `key_too_long` like the material-plant validator (order number still protected from the vanish sweep); regression `test_planned_order_material_longer_than_18_is_key_too_long_and_still_protected`; F8 re-run PASS. |
| 2026-10-07 | 5 (F7) | Medium | An invalid or blank `NIMBUS_SAP_SYSTEM_TZ` silently disabled all SAP time conversion (no log, no warning), shifting every imported and sent date by the real zone's offset. | Fixed: loud boot warning, warning `sap_system_tz_invalid` on every batch, planned-order Apply refused (409) and Send to SAP refused (400) until fixed; `env_int` also warns when it floors a too-small value (`LOADING_TIMEOUT_MIN=-5`). Tests `test_sap_system_tz_invalid_flag`, `test_invalid_sap_system_tz_warns_on_every_batch_and_refuses_planned_order_apply_and_send`, `test_env_int_never_raises_and_floors`; i18n `ui.sap_stage_warn_sap_system_tz_invalid` in five locales; docs in `backend/integration/CLAUDE.md` / `AGENTS.md` and `DEPLOYMENT.md`. |
| 2026-10-07 | 5 (F1, F2) | Medium | **Owner decision.** A killed or crashed apply leaves the batch `applying` with no warning, and the poll never picks it up (it visits only `ready` / `validated`), so in `auto` mode nothing resumes it until an admin presses Apply. The plan expected "the poll resumes". The state is safe (live tables consistent, deletes only after every upsert, resume tested three ways), but a planner would see stale SAP data indefinitely. | Open, not changed (designed behaviour: resume is the admin's Apply). Option for the owner: let the poll resume an `applying` / `error` batch whose apply lock is free (a live apply holds it), or at least raise an alert when a batch has been `applying` longer than the statement timeout. |
| 2026-10-07 | 5 (F1, F2) | Low | A resumed apply's `counts` describe the resume run only (F1: `updated 0, unchanged 123` although the first run wrote 123; F2: `updated 93, unchanged 30`). The live data is right; the admin screen undercounts the batch's writes. | Open, cosmetic; the first run's counts could be merged into the resume's. |
| 2026-10-07 | 5 (F4) | Low | While a batch waits for its missing rows it shows `ready` with expected / actual row counts but **no warning**; the `incomplete_rows` warning appears only at rejection (the Validate click gives a 409 with the numbers). The plan expected the warning during the wait. | Open, UI could flag expected != actual while `ready`; no code change. |
| 2026-10-07 | 5 (F10) | Info | The archive copy and delete run on `db.purge_orders_by_ids`' own pool connection, so `NIMBUS_SAP_STAGING_STATEMENT_TIMEOUT_MS` (default 600 s) does not cover them; the pool default (30 s) applies. A very large vanish set could time out and end `error`; the rollback is clean and the resume works. | Accepted; documented here. |
| 2026-10-07 | 5 (env) | Info | The first full `pytest` run after the Track 5 cleanup stopped at one `psycopg.errors.QueryCanceled` (statement timeout; the failing test was not captured because that run used `-x` and its output was cut). The next complete run was green (`1266 passed, 1 skipped`) and nothing was changed in between. | Not reproduced; if it recurs, suspect stale planner statistics on the test database after the bulk deletes. |
| 2026-10-07 | 8 | Info | Performance at target scale passes all three bars with no code or schema change: apply of 10,000 planned orders 8 s unloaded and 18.5 s under a continuous 14 MB `/tasks` loop (bar 120 s); every hot query uses the plant index (no Seq Scan on `orders` / `order_schedule_segments`); light endpoints p95 at most 0.66 s during apply, no errors, at most 4 DB connections held. Poll tick with 50 batches 1.2 to 1.9 s; a second poll skips. Full tables in section 8. | Closed. |
| 2026-10-07 | 8 | Low | `GET /sap/staging/batches/{id}/deletions` returns every deletion of a planned-order batch: 5,000 rows are 1.3 MB / 0.25 s. The "about 2,000" cap exists only for master-object batches; the UI caps display at 200 but the API does not cap planned orders. | Open, accepted at pilot scale (bounded by one plant's in-horizon orders, about 2.6 MB at 10,000). If it ever matters, add `limit` plus a `total` to the route; the UI already shows "+N more". |
| 2026-10-07 | 8 | Low | `list_batches` reads the whole `counts` JSON of each header, including the up-to-5,000-key frozen deletion list, and strips it in Python: worst case 877 KB read per 50 headers (8 ms becomes 32 ms; response unchanged at 36 KB). | Open, not worth a change at this size; fix would be `counts - 'vanish_keys'` in the list query only. |
| 2026-10-07 | 8 | Info | Costs inherent to the shared `db.upsert_orders` path, left alone: an identical re-apply of 10,000 orders still costs 7 to 8 s (chunked `executemany` round trips and per-row comparisons, about 6 s of it waiting on Postgres); production versions and routing operations rewrite every row on an identical re-apply (1.1 s and 4.3 s; Track 4 F3 / by-design scoped replace); Send to SAP is 2 statements per order (2.8 to 4.7 s at 9,605 orders). | Reported, no change. |
| 2026-10-07 | 8 | Info | Retention sweeps for outbound `sent` / `error` rows and dead batches sequentially scan their (small) tables; at a 10,000-order Send twice a day the outbound table settles near 600,000 rows (about a half-second scan once per poll tick). | Accepted; add an index on `queued_at` if Send volume grows. |
| 2026-10-07 | 8 (env) | Info | Full suite after Track 8 on the small test database, app stopped: `1266 passed, 1 skipped`. | Noted. |
| 2026-10-07 | 9 (item 3) | Medium (bug) | The Refresh button's toast read "Staging checked: [object Object],[object Object],[object Object] processed, applied, held": the poll returns lists, the UI treated them as counts. Nothing wrong with the poll itself. | Fixed (Track 9 commit): the toast uses the list lengths and turns amber when the pass had errors; regression `Track 9: the Refresh toast counts the poll result lists`. |
| 2026-10-07 | 9 (item 10) | Low | The shared Confirm dialog (Cancel button, Close label) is English-only static markup, so every confirm in the app, including Confirm & Apply, Send and Restore, showed "Cancel" in de / es / fr / pt. | Fixed: `_runConfirm` localizes both on every open (`btn.cancel`, `btn.close`); test in `foundation.test.mjs`. |
| 2026-10-07 | 9 (item 5) | Low (UX) | The 25 % hold on a Material Plant / Production Version / Routing batch said "in-horizon orders are missing" and the running line read "1 of them are running now". | Fixed: object-aware wording (`ui.sap_stage_warn_vanish_threshold_rows`) and "Running right now: N." in five locales; tests added. |
| 2026-10-07 | 9 (items 3, 4, 10) | Low (cosmetic) | Batches not yet validated showed "0 rows · 0 valid · 0 rejected"; a "0 missing from snapshot (0 %)" chip appeared on every master batch; the rejected-rows drawer showed `row_status` and a raw timestamp for every row; the all-rejected batch error was the raw English "no valid rows in batch". | Fixed: counts hidden until validation, chip only when something would be deleted, bookkeeping columns dropped from the drawer, the error mapped to `ui.sap_stage_err_no_valid_rows` (five locales). |
| 2026-10-07 | 9 (item 6) | Low (UX) | A file that is not a spreadsheet gave "Excel file format cannot be determined, you must specify an engine manually." | Fixed in `stage_rows_from_upload`: "Could not read the file: it is not a valid .xlsx or .csv file." (detail goes to the log); `test_unreadable_upload_says_so_in_plain_words`. |
| 2026-10-07 | 9 (item 12) | Medium (layout) | A wide rejected-rows table made the Interface console wider than its panel (grid columns `340px 1fr` / `1fr` do not shrink), pushing a batch row's Discard button past the right edge at 1440 px and breaking the 390 px layout. | Fixed in `styles.css` (`minmax(0, 1fr)` and `min-width: 0` on the console's children); re-checked at 1440 light / dark and 390 light / dark. |
| 2026-10-07 | 9 (item 9) | Medium (design gap) | Plant scoping for staging can never take effect: every `/sap/staging/*` route needs the `admin` role, and `get_allowed_plants` returns "all plants" for `admin`, so `_assert_stage_plant_allowed` is always called with no restriction. A plant-limited user is not "restricted to their plant", they are refused entirely (Admin tab hidden, API 403). That is safe, but it means a per-plant staging admin does not exist and the plant checks in the routes are untested-by-reachability. | Open, owner decision: either keep staging global-admin only (and say so in the docs), or add a permission (like `setup_scheduler`) that lets a plant-scoped role use the panel; the scoping code is then live. |
| 2026-10-07 | 9 (item 10) | Low | 71 `ui.sap_*` / `toast.sap_*` keys of the older connector screens (page subtitle, KPI ribbon, "Sync objects", Overview / Mapping / History tabs, "details", mapping editor, run history) exist only in `en.js`, so the Interface page chrome is English in de / es / fr / pt (the staging keys are complete). Pre-existing; the locale ratchet allows it. | Open; a translation pass, not code. |
| 2026-10-07 | 9 | Info | Left as is: the Send confirm dialog shows no order count (only the toast does, because the count is known after queuing); the native file input is light in dark theme; an `error` batch shows the database's own message (admin-facing). Demoting the only admin re-opens the first-run admin grace for everyone (designed; a second admin is needed to test a 403). | Noted. |
| 2026-10-07 | 9 (env) | Info | Full suite after Track 9, app stopped, test data removed: `1267 passed, 1 skipped`. | Noted. |

---

## Appendix — Context

**Brief (owner, 2026-10-07):** "Draw up a validation plan to validate everything that we just did. To look for bad code, poor assumptions, weak code."

**Why this shape:** the branch was built in one day by delegated agents, reviewed once by the same model family, and never touched a database or a browser. The weakest evidence is for the most destructive paths (vanish deletion, master deletions, echo), so the plan front-loads the human-fact audit and the database-backed tests, and uses differently-framed reviewers so the second review is not a replay of the first.

**Known limits already accepted (not re-validated here):** global poll endpoint; 413 after read; no-timezone plants skip conversion; requeue race benign; midnight-crossing echo miss (quantified in S15, not fixed).

**Things learned along the way:** both new migrations trip the deploy runner's destructive filter; `apscheduler` is in `requirements.txt` but was missing from the dev venv; `generate:api-types` calls bare `python` and needs the venv interpreter on this machine; the worktree has no `.env`, which is why the whole Python suite collected without the Azure guard refusing.
