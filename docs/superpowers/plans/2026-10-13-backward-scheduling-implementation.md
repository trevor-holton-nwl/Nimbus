# Backward Scheduling Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every implementation task is dispatched to the model named in its **Model:** line (Sonnet by default; Haiku only where the task says so). Every Haiku task gets a Sonnet review before its commit. The orchestrator never writes code. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move NIMBUS from forward scheduling (stored start + run time = finish) to finish-anchored scheduling (stored placed finish; start derived backward through working hours), with the SAP finish kept as an immutable due date, reversal to forward-from-now for orders whose derived start is in the past, and a global cutover that re-derives every order from its due date.

**Architecture:** The server stores the placed finish in the existing `orders.scheduled_end` column and a derived start in `scheduled_start`; it never walks a calendar. The browser owns derivation: a new backward primitive in `calendar-engine.mts` walks back from a held finish, and the load-time reconcile re-derives every row flagged "start may be stale". A row with no stored finish anchors on its due date (OQ33 A), so the cutover is one ledger-guarded migration that nulls every placed finish, drops stored segments and flags every row stale; the first browser to load each plant under the new image re-derives it from due dates and the first Save persists it (owner choice 2026-10-13: "automatic on first load"; the flag survives an unsaved tab, so the pass is idempotent). Two new immutable columns hold the SAP start and finish as received; the echo rule freezes them once SAP's finish matches what NIMBUS sent. Phase 1 (due-date protection) ships to the pilot alone from `main`; Phases 2–3 live on `feature/backward-scheduling` (sequential, one implementer at a time) and ship with the Phase 4 cutover in one image.

**Tech Stack:** FastAPI + psycopg (`db.py`, `backend/<domain>/`), Postgres 16 (`schema.sql` + ledger-guarded `migrations/*.sql`), TypeScript `.mts` compiled in place by `tsc` (`npm run build`), node:test (`tests/modules`, `tests/js`), pytest (`tests/*.py`, Postgres-backed tests need local Postgres + `NIMBUS_TEST_DB=1`).

**Spec:** `BACKWARD_SCHEDULING_MIGRATION.md` (repo root). §1.6 (owner decisions of 2026-10-14) governs wherever it differs from §4–§11; §12 holds the full decision text under each OQ. This plan argues from §1.6 + §12 and uses §4–§8 only for mechanism and anchors.

---

## Global Constraints

Copied from the spec; every task's requirements implicitly include these.

- **O1–O4 are fixed.** Finish-anchored everywhere (Reading A); Reading B deferred. Past start → forward from now with a late alert ("reversal"). Global cutover, all plants, forward paths replaced (no per-plant switch, no dormant-code flag). The SAP finish as received is the due date and is never rewritten; the planner's placed finish is the anchor and is what Send transmits.
- **Release mechanism = option B (§7.1.1):** Phase 1 merges to `main` and may deploy alone. Phases 2–3 merge only into `feature/backward-scheduling` (draft PR for CI). That branch merges to `main` as the first step of Phase 4. Nothing from Phases 2–3 reaches `main` before that.
- **Compiled output is gitignored.** After any `.mts`/`.ts` edit run `npm run build`. Never commit `.mjs` twins.
- **Locale ratchet has zero headroom** (§4.12, test group 32): every new or reworded English key lands in all five locales (`en`, + 4) in the same commit.
- **Deploy runner treats ALTER/UPDATE/DELETE/DROP/TRUNCATE/RENAME/GRANT/REVOKE as destructive by text, comments included** (`.claude/skills/promote-azure/scripts/apply-migrations.ps1`). Any migration carrying those words must say so in its PR description; `-AllowDestructive` releases every pending matching file, so each destructive file ships in its own deploy run.
- **Every new column, index, constraint or ledger id in a migration must also be mirrored in `schema.sql`** or `scripts/schema_bootstrap_smoke.py` fails CI (§10.6).
- **pytest refuses to collect unless `PG_HOST` is local and `NIMBUS_TEST_DB=1`.** Never point `.env` at Azure. Node tests (`npm test`) need no database.
- **`TaskDTO` key-set is pinned** (`tests/test_task_response_models.py`): any new wire field edits sample row + route dict literal + DTO + `frontend/types/api-generated.d.mts` (`npm run generate:api-types`) together. This plan adds exactly **one new `TaskDTO` field**, `placement_exception` (Task 2.3); the locked SAP columns are served through the existing `original_start_date` / `original_end_date` wire names, and `server_now` travels in the `/tasks` envelope or a header, not on the DTO.
- **Run-time cap:** 336 h, measured on run time (working hours), not drawn span (OQ28). (Planned as "or the plant's planning horizon, whichever is smaller"; built as a flat 336 h, senior review U5.) The schema check `chk_orders_run_time_bounds` rises to `< 336`.
- **One clock:** server instant projected into the plant zone, delivered on each task load; a plant with no `timezone` is blocked with an alert (OQ52). Window math for any stored backward walk is in the plant zone (OQ46).
- **"Contiguous" on 24/7 plants:** touching intervals merge across midnight, as the optimizer already does (OQ47).
- **Send transmits only firmed orders** (planner-firmed, SAP-firmed, or starting inside the frozen horizon); the firm rule itself is unchanged and add-only (OQ54, OQ61).
- **Plain-language UI text, i18n via `data-i18n`/`t()`;** no hardcoded English; no SAP field codes in docs or UI strings.
- **Sonnet for all implementation; Haiku only for tasks marked `Model: Haiku`** (docs rewrites, pinned translations, mechanical mirrors, one-line fixes with a pinned test). Every Haiku commit is reviewed by Sonnet before it lands.
- **Sequential execution within a phase; no two agents commit to the same checkout concurrently** (shared-index races observed 2026-10-13).
- **(Task 0 ruling) Every new `migrations/*.sql` file is added to the pinned file list in `tests/test_schema_idempotent.py` (~137-189, `expected_replayable` / exact-set assertion) in the same commit**, or that test fails.
- **(Task 0 ruling) The queue column is `orders.planning_status` with literal `'needs_planning'`** (never `planning_state` / `'queued'`); the CHECK `orders_planning_state_check` requires `scheduled_start` and `scheduled_end` NULL on a queued row, so any writer that queues a row also nulls both dates and deletes its segments. The reason lives in `orders.planning_reason` (JSONB `{code, message}`).
- **(Task 0 ruling) `frontend/nimbus-compute-core.js` is a hand-written UMD, not compiled:** new helpers are added to its `return {...}` object and hand-mirrored in `frontend/nimbus-compute-core.d.ts`; the worker `importScripts` the file directly (no build mirror). Never write `export function` there.
- **(Task 0 ruling) `finish_echoes` lives in `db.py`** (beside `sap_changed_fields`) and is re-exported by `backend/integration/sap_staging.py` (`from db import finish_echoes`) so callers in `db.py`, `sap_staging.py` and `backend/distribution/data.py` share one definition without a circular import (`sap_staging.py` imports `db` at module top).

## Review Focus

Inputs the spec implies but no task's tests exercise, most likely to bite first. Each line names the task that owns its pinning test.

1. **A date-only SAP finish that falls on a closed day or inside a blackout** (Sunday due date on a Mon–Fri plant): the OQ23 reading "end of that date's working window" has no window; expected: the previous open day's close, never midnight (and, once derived, the OQ13 "finish moved earlier" issue). → Task 1.5 test.
2. **A firmed order with no placement (never dragged) at Send time:** Send now transmits firmed orders only; a firmed-but-unplaced row's placed finish falls back to the due date, so Send would echo SAP's own finish back. Expected: it is sent with that finish and the echo rule treats the return as a match (no original rewrite). → Task 2.7 test.
3. **A running order at cutover whose start + run time, walked forward through the calendar, now ends after its due date:** expected: start kept, finish moved later, late alert fires, no reversal, no overlap repair. → Task 2.6 test.
4. **Two tabs: one saves a re-derived start computed on default (7–19) hours because the calendar fetch timed out:** expected: derive-and-save is paused for that plant (OQ51) and the save never carries a default-hours start. → Task 2.6 test.
5. **An overlong order (run time longer than the longest window) on a `never` plant that a planner releases from Needs Planning with the approved-exception marker, then its run time shrinks below the window:** expected: the marker keeps the bar as one continuous bar at the held finish until a planner clears it; the reconcile does not re-walk it. → Task 2.5 test.

---

## 0. Shape, branches, gates

### 0.1 Phase map

| Phase | Branch | Ships alone? | Content | Gate to leave |
|---|---|---|---|---|
| 0 | n/a | n/a | Owner facts and decisions (§1.5). **No code.** | Items 0.2 below |
| 1 | `main` via short-lived `p1/*` branches + PRs | Yes (first) | Locked original-date columns + echo match rule, distribution baseline-write stop, hygiene inversion (finish side), OQ23 date-only read rule, OQ24 rejection, retire baseline-correct relay, legacy due-date repair (never-sent only), run-time cap 336 h + Needs Planning route, purge preview fix, dead counters | Test groups 6 + 13(hygiene); flipped hygiene tests; owner check §7.1.2 signed before first live Send |
| 2 | `feature/backward-scheduling` | No | Stored-finish read rule and save contract; backward calendar primitives; one clock; manual placement + run-time triggers hold the finish; reconcile on finish with running/firmed/frozen guards and reversal queue; stale-flag semantics; ingest finish-required; Send reads stored finish; markers for OQ50/OQ63 | Groups 1,2,3,4a,5,10,11,13,14,17,18,21 + flipped tests of §10.2 |
| 3 | `feature/backward-scheduling` | No | Optimizer A-lite output = placed finish, instability key on finish, undo re-derives, dead walk deleted; setup rule at 12 sites; late alert; day attribution; "today" tiles; grid/Inspector/Override/i18n; distribution shared finish, collapse carry, separation alert, CSV due column | Groups 4b,7,8,12,15,16,19,22–26,28–33 |
| 4 | merge → `main`; migrations | Yes (single flip) | Pilot-copy rehearsal; cutover migration (null placed finishes, drop segments, flag stale, ledger id); cutover image; operator opens each plant once in the window so the load-time reconcile runs and saves (counts shown in a cutover toast); verification; go/no-go; post-roll watch; per-plant SAP staging first apply later | Group 9 + 32 re-run; runbook gates G-1…G-12 (§8.13) |
| 5 | deferred | — | Reading B | not planned here |

### 0.2 Phase 0 — owner gates (no code; listed so no task starts without them)

All OQ decisions are taken (§1.6). Still owed by the owner before the phase named:

| # | Item | Blocks |
|---|---|---|
| a | Identify the live image (`az containerapp show` tag + `NIMBUS_BUILD_ID` in the served page → commit); confirm whether any Send to SAP has happened on the pilot | Phase 1 deploy |
| b | Snapshot `basic_finish_date`, `sap_basic_start_date`, `sap_basic_finish_date`, `order_sap_sent` before any Send and before the backfill migration of Task 1.1 is applied to the pilot (8.13 step 2) | Task 1.1's migration on the pilot (deploy step, owner-run) and first Send |
| c | Pilot `pg_dump` + local restore; run profile Q0–Q17 (§8.12) on the copy; review Q1, Q8, Q13, Q15, Q16, Q17 | Phase 1 deploy (Q1, Q8); Phase 4 (rest) |
| d | Real-SAP echo test (blocker 18, assumption A9) and the Appendix D questions to SAP Development, in writing or accepted as assumptions | first production Send; Phase 4 |
| e | Five-minute browser check of vis-timeline resize handles (OQ1) | Task 2.8 |
| f | Platform operator facts: PITR enabled + retention; Mulesoft role/firewall/poll/clock | first Send; Phase 4 |
| g | Caller list for `POST /tasks/bulk_update` (OQ59) | Phase 4 |
| h | Named roles (decider, deploy operator, platform operator, dump owner, SAP contact, watcher, capturer) and abort thresholds N | Phase 4 |
| i | Name the planning-horizon setting the 336 h cap compares against (plant setting; what if shorter than 336 h) | Task 1.7 — **assumption in this plan:** the plant's existing optimizer horizon setting (35 days default); cap = min(336 h, horizon_days × 24 h); if the owner names a different setting, only Task 1.7's constant changes |

### 0.2a Autonomy charter (owner instructions of 2026-10-13: run Phases 1–4 without stopping)

**Scope decisions (owner, 2026-10-13):** build and test everything locally; **deploy nothing** (no `az`, no `psql` against the pilot, no `/promote-azure`); **branches only, no merge to `main`**; Postgres-backed tests run against the local database using `.env` for host/db and the owner-supplied `postgres` credentials passed as environment variables on each command (never written to any file, commit, log or report).

**Branch model under "branches only":**
- `feature/backward-scheduling-phase1` forks from `main` at HEAD; Tasks 1.1–1.9 commit there in order (no `p1/*` sub-branches).
- `feature/backward-scheduling` forks from the **tip of the phase1 branch** when Phase 1's gate is green; Phases 2–4 commit there.
- Nothing is pushed unless the owner says so. The owner merges `feature/backward-scheduling-phase1` → `main` (deployable alone) and later `feature/backward-scheduling` → `main` (cutover). Task 4.3 becomes a written runbook, not an executed step.

**Proceed without asking** (routine gap-filling; each instance is logged in Appendix C of this plan **and** appended to `BACKWARD_SCHEDULING_MIGRATION.md` under a new final section "Implementation log and gap decisions (2026-10)"): naming, helper placement, test fixture shapes, which existing utility to reuse, flipping a test the spec did not list when the new rule makes it wrong, wording of UI copy and locale text, column/index names, migration file naming within the stated order, any `file:line` drift, the five open owner questions of Appendix A (defaults: optimizer horizon setting; keep the two evaluator labels; left-edge drag reverted with a toast; reworded-key list extended as needed; A9 tolerance = minute, SAP frame).

**Stop and ask only for a truly large deviation**, defined as: (1) an owner decision in spec §1.6 cannot be implemented as stated and the only way forward changes what a planner sees or what SAP receives; (2) a step would write to the live pilot or push to `origin` (never done in this run); (3) a test suite cannot be made green without reversing an owner decision; (4) a dependency, tool or environment failure blocks a whole phase for longer than two repair attempts (for example local Postgres down, `npm run build` broken by something outside this work). Everything else is a gap to fill and log.

**Reporting:** each phase ends with a short written gate report in Appendix C (tests run, counts, flips, gaps); the final report to the owner repeats the gap list verbatim.

### 0.3 Execution rules for the orchestrator

1. Record `git rev-parse HEAD` at the start of each phase; re-verify every `file:line` anchor in a task against the live file before dispatching it (the owner commits to `main` from other sessions mid-run).
2. One implementer at a time per checkout. Phase 2 and Phase 3 run sequentially on the feature branch. If parallelism is wanted, use `EnterWorktree` per agent and merge by PR; never two agents committing into one working tree.
3. Each task: implementer (Sonnet, or Haiku where marked) → `npm run build` + scoped tests → Sonnet reviewer (fresh context, given the diff and the task text, not the implementer's summary) → commit. Reviewer gates: spec conformance, no forward-path left behind in the touched files, locale parity, no new wire field.
4. Test scope per task is the scoped command in the task; the full `npm test` and `python -m pytest tests/ -q` run once at the end of each phase. Known baseline noise: 1 flaky optimizer spawn probe, 3 knownFailure todos, 1 pre-existing pytest failure in the schema-idempotent skip-set (verify at phase start; don't chase).
5. Commit messages: conventional prefix (`feat(scheduling):`, `fix(integration):`, `test:`, `docs:`), one logical change per commit, ending with the attribution line.

---

## 1. Phase 1 — Protect the due date (ships alone from `main`)

Branch: `feature/backward-scheduling-phase1` from `main` (see 0.2a); one commit series per task, in order. Anchors verified at HEAD `0317dd8` on 2026-10-13. Local Postgres is up (`pg_isready` ok). Python test commands set `NIMBUS_TEST_DB=1`, `PG_HOST=localhost`, `PG_DB` (from `.env` or `nimbus`), `PG_USER=postgres`, `PG_PASS=<owner-supplied, env var only>` on the command line; `.env` is never edited.

**Naming fixed for every task below** (do not vary): DB columns `orders.original_start_received`, `orders.original_finish_received`, `order_distribution.original_finish_received` (all `TIMESTAMP`, nullable); wire names unchanged (`original_start_date`, `original_end_date` are now served from the locked columns with a fallback to `basic_*`); Python helper `finish_echoes(...)` defined in `db.py` and re-exported from `backend/integration/sap_staging.py` (Task 0 ruling, circular import); JS helper `dueDateInstant(...)` on the UMD return object of `frontend/nimbus-compute-core.js`, hand-mirrored in `nimbus-compute-core.d.ts` (the worker `importScripts` the same file).

**Execution order (Task 0 ruling):** 1.1 → **1.4** → 1.2 → 1.3 → 1.5 → 1.6 → 1.7 → 1.8 → 1.9. Task 1.4 runs before 1.2 so the locked columns never store a hygiene-fabricated finish (date-only or blank finishes were rewritten by `_date_hygiene_df` until 1.4). Task numbers are unchanged.

### Task 1.1: Locked original-date columns, backfill, and read projection

**Model:** Sonnet
**Files:**
- Create: `migrations/2026-10-15-1-orders-original-dates.sql`
- Modify: `schema.sql:41-45` (orders columns), `schema.sql:181` (header), ledger mirror near `schema.sql:1787-1796` pattern
- Modify: `db.py` GET `/tasks` projection = `_ORDERS_SELECT` (`db.py:548-595`; the aliases are `"ORIGINAL_START_DATE"`/`"ORIGINAL_END_DATE"` at 557-558, copied to the wire at `backend/scheduling/routes.py:195-196`), `/tasks/refresh` projection `db.py:839-853` (`get_task_versions`), `backend/scheduling/models.py:170-195` (`TaskVersionRow`), `backend/distribution/data.py:3010-3013` (child read emits the raw due as `o.basic_finish_date` → COALESCE of the new column). `backend/integration/sap_staging.py` vanish detail (~786-802) does **not** emit the due date — no change there.
- Modify: `frontend/scheduling/persistence.mts:1731-1737` (apply `original_end_date` from refresh)
- Test: `tests/test_task_response_models.py` (DTO key-set stays pinned — no new `TaskDTO` field here), refresh-row shape tests live in `tests/test_audit_routing_contracts.py:78`, `tests/test_audit_routing_db.py:235,243,357,364,629`, `tests/test_planning_exceptions.py:117,121` (extend whichever pins the refresh row's column order), `tests/test_ingest_data_layer.py` (new class `TestOriginalDatesBackfill`), `tests/test_schema_idempotent.py` (**add the new file name to the pinned migration list ~137-189** in the same commit — Task 0 ruling)

**Interfaces:**
- Produces: columns above; wire `original_end_date = COALESCE(original_finish_received, basic_finish_date)`, `original_start_date = COALESCE(original_start_received, basic_start_date)`; `TaskVersionRow.original_end_date: datetime | None` (new field on the refresh row only — not on `TaskDTO`).
- Backfill rule (ledger id `orders_original_dates_backfill`): for rows with **no** `order_sap_sent` row → `original_finish_received = COALESCE(sap_basic_finish_date, basic_finish_date)`, `original_start_received = COALESCE(sap_basic_start_date, basic_start_date)`; for rows **with** a sent row → `original_* = basic_*` (original lost; listed for the owner by the SELECT in step 6). Header: `original_finish_received = basic_finish_date`.

- [ ] **Step 1: Write the failing migration test** in `tests/test_schema_idempotent.py` style: apply `schema.sql` twice, assert `information_schema.columns` has the three columns and `schema_migrations` has `orders_original_dates_backfill` once.
- [ ] **Step 2: Run** `python -m pytest tests/test_schema_idempotent.py -q -k original_dates` → FAIL (column missing).
- [ ] **Step 3: Write the migration** (ALTER + ledger-guarded UPDATE in one file; name sorts after every existing file):

```sql
-- migrations/2026-10-15-1-orders-original-dates.sql
-- Locked copies of the SAP start/finish as received (OQ31 b, OQ26). Destructive by text (ALTER, UPDATE).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_start_received  TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_finish_received TIMESTAMP;
ALTER TABLE order_distribution ADD COLUMN IF NOT EXISTS original_finish_received TIMESTAMP;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'orders_original_dates_backfill') THEN
    UPDATE orders o SET
      original_finish_received = CASE WHEN s.order_id IS NULL THEN COALESCE(o.sap_basic_finish_date, o.basic_finish_date) ELSE o.basic_finish_date END,
      original_start_received  = CASE WHEN s.order_id IS NULL THEN COALESCE(o.sap_basic_start_date,  o.basic_start_date)  ELSE o.basic_start_date  END
    FROM orders o2 LEFT JOIN order_sap_sent s ON s.order_id = o2.id
    WHERE o2.id = o.id;
    UPDATE order_distribution SET original_finish_received = basic_finish_date WHERE original_finish_received IS NULL;
    INSERT INTO schema_migrations (id) VALUES ('orders_original_dates_backfill');
  END IF;
END
$mig$;
```
  The orders UPDATE is a real LEFT JOIN (verified: `order_sap_sent.order_id TEXT PRIMARY KEY REFERENCES orders(id)` at `migrations/2026-10-08-sap-staging-tables.sql:210`). Rows without a sent row take the as-received `sap_basic_*` when present.
- [ ] **Step 4: Mirror in `schema.sql`** (columns + the same guarded DO block) and run `python scripts/schema_bootstrap_smoke.py` locally → PASS.
- [ ] **Step 5: Switch the wire** — every projection that emits `original_end_date`/`original_start_date` reads the COALESCE; add `original_end_date` to `TaskVersionRow` + the refresh SELECT + `persistence.mts:1731-1737` apply; `npm run generate:api-types`.
- [ ] **Step 6: Write the owner list query** into `docs/MIGRATION.md` (SELECT id, plant, basic_finish_date, sap_basic_finish_date FROM orders o JOIN order_sap_sent s … WHERE sent rows differ) — SELECT-only, never executed by agents.
- [ ] **Step 7: Run** `python -m pytest tests/test_schema_idempotent.py tests/test_task_response_models.py -q` and `npm run build && node --test tests/modules/scheduling/persistence.test.mjs` → PASS.
- [ ] **Step 8: Commit** `feat(scheduling): add locked original SAP date columns and serve the due date from them`

### Task 1.2: One echo rule, written once; the order upsert writes the locked columns

**Model:** Sonnet
**Files:**
- Modify: `db.py` (define `finish_echoes` beside `sap_changed_fields`; Task 0 ruling — `backend/integration/sap_staging.py:184-242` re-exports it with `from db import finish_echoes`), staging row build (carry `_finish_date_only` from `_parse_sap_time` → `None`), `db.py:2602-2700` (`sap_changed_fields`: replace the plant-frame midnight branch 2654-2659 with `finish_echoes`), `db.py:3168-3195` (`_CHUNK_READ_SQL` also selects `original_start_received`, `original_finish_received`), tuple patch: the tuples are built at `db.py:3537-3545` **before** the chunk before-image is read (3592) and executed (3595) — apply the in-memory patch (set the two original values per row) **between 3592 and 3595, per chunk**, where the stored originals and `sap_sent_finish` are known; `db.py:2791-2921` (`_UPSERT_SQL`: INSERT cols 2793-2802, SET 2828-2836, WHERE 2914; SET `original_* = COALESCE(EXCLUDED.original_*, orders.original_*)`; never SET from `EXCLUDED.basic_*`)
- Test: `tests/test_orders_routing_ingest.py` (pure echo class ~436-640; add M1 cross-zone case), `tests/test_ingest_data_layer.py::TestSapTruthReupload` (Postgres)

**Interfaces:**
- Produces:
```python
def finish_echoes(incoming_finish_plant_local: datetime | None, incoming_date_only: bool,
                  sent_finish_plant_local: datetime | None, sap_tz: str, plant_tz: str | None) -> bool:
    """True when SAP's incoming finish is the finish NIMBUS last sent, judged in the SAP frame.
    date_only: compare the SAP-frame calendar date of the sent value with the incoming date.
    timed: compare to the minute after converting both to the SAP frame."""
```
- Rule for the locked columns per incoming row (computed in Python before the chunk upsert):
  - `echo = sent_finish is not None and finish_echoes(...)`
  - `echo` → tuple carries the **stored** `original_*` (unchanged).
  - not echo → tuple carries incoming `basic_start_date`/`basic_finish_date` (first ingest or genuine SAP change). Note: only the finish decides echo (OQ31). **Task 0 ruling (OQ26/OQ31):** on an echo **both** locked columns keep their stored values — a start-only SAP change whose finish echoes does **not** refresh `original_start_received` (SAP back-scheduling its start after an echo must not move "first received"); `original_start_received` refreshes only when the finish is not an echo (never-sent order, or a genuine finish change). The placement is not wiped by a start-only change (OQ25 c, Task 2.7).
- Consumes: Task 1.1 columns.

- [ ] **Step 1: Failing pure tests** in `tests/test_orders_routing_ingest.py`: (a) M1 — plant **`America/Chicago`** (UTC-5 in October; 19:00 CDT = 00:00 UTC Friday — the spec's own M1 example; New York would be UTC-4 and correctly yield *no* echo), SAP zone `UTC`, sent finish Thu 22 Oct 19:00 plant-local, incoming date-only Fri 23 Oct → `finish_echoes` True and `sap_changed_fields` reports no `dates`; (b) genuine change — incoming Sat 24 Oct date-only → False; (c) timed echo to the minute → True; (d) no sent row → False; (e) the New York variant of (a) → False (documents the frame rule).
- [ ] **Step 2: Run** `python -m pytest tests/test_orders_routing_ingest.py -q -k "echo"` → FAIL (`finish_echoes` undefined).
- [ ] **Step 3: Implement** `finish_echoes`; wire into `sap_changed_fields`; carry `_finish_date_only` from the staging parser and from the Excel path (time == 00:00:00 ⇒ date-only — the two cannot be told apart there; document in the docstring).
- [ ] **Step 4: Failing Postgres tests** in `TestSapTruthReupload`: (e) first ingest sets `original_*`; (f) send → echo upload leaves `original_finish_received` unchanged while `basic_finish_date` may move; (g) send → genuinely later SAP finish updates `original_finish_received`; (h) existing `test_baseline_correct_then_same_file_resets_nothing` (840-856) is **deleted** in Task 1.5, not here.
- [ ] **Step 5: Implement** the chunk read + tuple patch + upsert SET; run `python -m pytest tests/test_ingest_data_layer.py -q -k "SapTruth or Original"` → PASS.
- [ ] **Step 6: Commit** `fix(integration): judge the SAP finish echo in the SAP frame and lock the received dates against it`

### Task 1.3: Distribution writers — stop the baseline writes, lock header and child dates (OQ29)

**Model:** Sonnet
**Files:**
- Modify: `backend/distribution/data.py:1509-1510` (remove `setdefault(sap_basic_*, basic_*)`), `1326-1418` `_CHILD_UPSERT_SQL` (SET `original_finish_received`/`original_start_received` via COALESCE-from-EXCLUDED, never from re-weight facts; stop SET of `basic_finish_date` from non-ingest callers — split the SQL into ingest and planner variants or pass NULL for the date columns on planner paths), `1161-1194` `_write_header_facts` (write `original_finish_received` only on ingest and only when not echo), `1124-1158` `_insert_new_header`, `3719-3800` `_resolve_machines` (header due from the plain order's `original_finish_received`, not `basic_finish_date`), `784-785`, `898-900` (children inherit the header's `original_*`), `2668-2703` `_parent_facts_from_header`
- Test: `tests/test_distribution.py::TestSapTruthDistributionReupload` (~4595) — add the false-reset case

**Interfaces:** consumes `finish_echoes` (Task 1.2). Children's echo judgement uses the aggregate's remembered sent finish (roll-up end) from `order_sap_sent`, which is keyed per member **child id** with the roll-up end as the value (verified `sap_staging.py:2256-2272`). **Task 0 ruling:** the header has no sent row of its own — its echo judgement uses the sent finish of **any** member child (all members carry the same roll-up end); a family with no sent row on any member is not an echo. After collapse/re-weight the lettered child's sent row cascades away; the resulting one-cycle detection gap is the accepted OQ29 gap. The `_finish_date_only` flag (Task 1.2) is carried into `parent_facts` from the staging/Excel row so the header judgement can use the date-only compare.

- [ ] **Step 1: Failing Postgres test** `test_reweight_then_unchanged_dateonly_upload_resets_no_sibling`: ingest aggregate with date-only finish Fri 23 Oct, re-weight 60/40 → 50/50, upload the same file → no sibling slot reset, `original_finish_received` unchanged on header and children, `sap_basic_finish_date` on the new child NULL (filled by the next upload).
- [ ] **Step 2: Run** `python -m pytest tests/test_distribution.py -q -k reweight_then_unchanged` → FAIL (siblings reset).
- [ ] **Step 3: Implement** the writer changes above. Keep `_collapse_to_survivor` carrying no baseline (as today). Known one-cycle detection gap after collapse/re-weight/1-to-N is accepted (OQ29 evidence).
- [ ] **Step 4: Run** `python -m pytest tests/test_distribution.py -q -k "SapTruth or header or resolve"` → PASS; whole file once.
- [ ] **Step 5: Commit** `fix(distribution): re-weight, reset, repair and work-center resolve no longer write SAP baselines or the due date`

### Task 1.4: Hygiene inversion — finish side (OQ23 store-as-received, OQ24 rejection)

**Model:** Sonnet
**Files:**
- Modify: `db.py:3941-4014` `_date_hygiene_df` — delete the fill at 3962, the ≤-start rewrite at 3982-3988 (replace with: finish **date** earlier than start date → drop row with `error` warning naming the row; same-date midnight stays), the midnight rewrite at 4005-4012 (delete); unparseable finish → drop with `error` warning (fixes A.3 #13 at `db.py:3436-3442`, `3847-3852`); `backend/integration/sap_staging.py:522-527` (blank `pedtr` → `invalid_date`). The staging path's midnight rewrite is **not** in `sap_staging.py` (392-397 are plain `sap_to_plant_local` conversions, Task 0 finding): it is `db.apply_order_date_hygiene_rows` (`db.py:4017-4047`) called from `sap_staging.py:434-436` — fix it there, once, for both paths; `backend/admin_ops/diagnostics_state.py:30-31` counters incremented at the drop sites (rename the finish counter to `dropped_no_finish_date`); `frontend/admin-ops/admin-ui.mts:87-88, 783, 894, 968` label — **the renamed label is a new/reworded English key: land it in all five locale files in the same commit** (zero ratchet headroom).
- Keep: start required (`db.py:4118`) until Phase 2; `_RUN_TIME_DEFAULTED` 1.0 h rule.
- Test: `tests/test_ingest_data_layer.py::TestApplyOrderDateHygieneRows` (flip 568, 574, 579; keep 586, 606 with updated `PARITY_CASES`), **`tests/test_ingest_data_layer.py:1000-1009`** (`test_finish_column_absent_…`: flip — a file with no finish column now drops every row with a warning; Task 0 finding), `tests/test_sap_staging.py:292` (flip: blank finish → `invalid_date`), `tests/test_setup_data.py:419, 430-466` (flip: finish required / stored as received)

- [ ] **Step 1: Rewrite the three hygiene tests** to the new expectations (midnight kept; finish-before-start-same-date kept; missing finish dropped with warning + counter incremented), flip the finish-column-absent test, and add `test_excel_unparseable_finish_is_dropped_with_warning`.
- [ ] **Step 2: Run** `python -m pytest tests/test_ingest_data_layer.py -q -k Hygiene` → FAIL.
- [ ] **Step 3: Implement**; run the three test files scoped → PASS.
- [ ] **Step 4: Commit** `fix(integration): store the SAP finish as received; reject rows with no usable finish`

### Task 1.5: Date-only due reading in the browser; retire the due-date rewrite relay

**Model:** Sonnet
**Files:**
- Modify: `frontend/nimbus-compute-core.js` (add `dueDateInstant(raw, dayWindowFor)` to the UMD `return {...}` object and hand-mirror the signature in `frontend/nimbus-compute-core.d.ts`), `frontend/platform/foundation.mts:611-647` (`Util.sapDueDate` → instant via `dueDateInstant`; the day window comes from the compute core's own day-window helper (`NimbusComputeCore._dayWindow`/`workWindow`-style, the route `foundation.mts:473` already uses) fed with the line's calendar rows held in `Store` — **never import `Calendar`/`calendar-engine` into the platform layer**; `latenessHours` is called per row in grid filters and tile loops, so keep the per-call cost O(1): cache the day window per line+date for the call; `Util.scheduledEnd`, `latenessHours` unchanged in shape), `frontend/optimization/setup-scheduler.mts:1197, 6223` (worker reads the due through the same helper with its own window index), `engine.mts:1092, 1118` (1156 is `latestAllowedEnd`, a consumer — no change)
- Delete (**surgically — Task 0 ruling B3: the working-hours snap stays live until Task 2.5**): in `frontend/scheduling/persistence.mts` remove only the due-date-baseline **phase** body (997-1111 region), `_dueEndOfShift` (1125-1137), `_relayDueDateCorrections` (1147-1193), the cache restore of `pristineOriginalStart` (890-891), the `corrections` return/plumbing and line 48's phase constant — **keep** `_snapToWorkingHours` (915-996 + its `finally {endRun}` tail 1111-1123) and its call at 578, returning only `{movedIds}`; in `frontend/calendar/calendar-sync.mts` keep the call at 250 (destructure `movedIds` only) and remove the relay at 259-266 + import 13; `backend/scheduling/routes.py:621-655` + imports 23/25, `backend/scheduling/models.py:209-220, 299-311, 314-315`, `db.py:1657-1788` + comments 2738-2740, 3529-3531, `backend/distribution/data.py:1394-1396` comment, `tests/test_ingest_data_layer.py:840-856`, `tests/test_task_response_models.py:670` entry; `npm run generate:api-types`
- Docs (Haiku follow-up in Task 1.9): `backend/scheduling/CLAUDE.md:13,15,30` + AGENTS twin, `frontend/scheduling/CLAUDE.md:61,79`, `backend/integration/CLAUDE.md:73` + `AGENTS.md:72`, `docs/MIGRATION.md:260, 979`
- Test: `tests/js/compute-core.test.js` (new `dueDateInstant` cases), `tests/modules/scheduling/persistence.test.mjs` (remove relay expectations; the snap expectation at 563 **stays** until 2.5), `tests/modules/setup-scheduler.test.mjs` ("hard bounds never use a scheduled finish as a missing SAP due baseline" must stay green)

**Interfaces:**
```js
// nimbus-compute-core.js — inside the UMD factory; exposed via the return object as NimbusComputeCore.dueDateInstant
/** raw: Date (naive plant wall-clock). dayWindowFor(date) -> {open: Date, close: Date} | null for that calendar date.
 *  Returns raw when raw is not exactly 00:00:00. For an exact-midnight raw: the close of that date's window;
 *  if that date has no window, the close of the latest open date before it (bounded 30 days; else raw + 23:59:59). */
function dueDateInstant(raw, dayWindowFor) { ... }
```
Review-focus item 1 pins the closed-day case here.

- [ ] **Step 1: Failing tests** in `tests/js/compute-core.test.js`: timed raw returned as-is; midnight on an open 06:00–22:00 day → 22:00; midnight on Sunday (closed) → previous Friday close; midnight on a 24/7 line → 23:59:59 of that date (window close = end of day); no calendar at all → 23:59:59.
- [ ] **Step 2: Run** `node --test tests/js/compute-core.test.js` → FAIL.
- [ ] **Step 3: Implement** helper + `Util.sapDueDate`; worker path uses the optimizer's `jointWindowForDay`-style index (name per `setup-scheduler.mts`).
- [ ] **Step 4: Remove the relay** end-to-end per the file list; delete the two tests; regenerate types.
- [ ] **Step 5: Run** `npm run build && npm run lint && node --test tests/modules/scheduling/persistence.test.mjs tests/modules/setup-scheduler.test.mjs tests/js/compute-core.test.js` and `python -m pytest tests/test_task_response_models.py tests/test_ingest_data_layer.py -q` → PASS.
- [ ] **Step 6: Commit** (two commits) `feat(platform): read a date-only due date as the end of that day's working window` and `refactor(scheduling): retire the client due-date rewrite and the baseline-correct route`

### Task 1.6: Run-time cap → 336 h / planning horizon; over-cap rows go to Needs Planning (OQ28)

**Model:** Sonnet
**Files:**
- Create: `migrations/2026-10-15-2-orders-run-time-bounds-336.sql` (DROP CONSTRAINT + ADD `CHECK (run_time >= 0 AND run_time < 8760) NOT VALID` + VALIDATE, following `migrations/2026-09-25-orders-run-time-bounds.sql` + `2026-09-26-...-validate.sql`); mirror `schema.sql:114-123` — **the existing `schema.sql` DO block is `IF NOT EXISTS` on the constraint name (115-122), so a plain mirror would leave the old `< 168` bound on any already-initialised database: the mirror must `DROP CONSTRAINT IF EXISTS` and re-ADD under a ledger id (`orders_run_time_bounds_8760`) so re-applying `schema.sql` raises the bound exactly once** (Task 0 finding); add the file to the pinned list in `tests/test_schema_idempotent.py`
- Modify: `backend/scheduling/models.py:277-278` (`RUN_TIME < 8760`, message), `db.py` ingest (after hygiene, before upsert: rows with `run_time > cap_hours(plant)` get `planning_status = 'needs_planning'` with `planning_reason = {code: 'run_time_over_cap', message: ...}`, **with `scheduled_start`/`scheduled_end` NULL and segments deleted** (the CHECK `orders_planning_state_check` requires it) — reuse the existing routing-hold queue shape; locate the writer with `rg -n "planning_reason" db.py backend/routing/resolver.py` (hold shape at `resolver.py:583-610, 725-770`)), `db.py:4141-4158` Machine Hours (unchanged rule; over-cap handled by the same queue step; a per-row representation check (`>= 8760`) rejects the row by number instead of failing the chunk — fixes A.3 #14), **(Task 0 ruling, OQ28 a3) the same cap applies to every run-time writer, not only ingest:** `update_task_dates_bulk` (`db.py` ~1483-1585, planner run-time edits from grid/Inspector/Override) rejects a `run_time > cap_hours(plant)` with a 422-style per-id reason `run_time_over_cap` (no silent accept of a 7,000 h edit now that the representation bound is 8760), and the routing resolver's hold writer (`resolver.py:725-770`) queues a recomputed run time over the cap with the same reason; `frontend/locales/*.js` (new reason key + the rejection toast key in 5 locales), the push-cap help text at `frontend/locales/en.js:741` + 4 locales (A.3 #7, stale "soft limit" wording)
- Test: `tests/test_ingest_data_layer.py` (new: 400 h row → queued with reason, dates NULL; 9,000 h row → rejected by row number, chunk committed), `tests/test_task_concurrency.py` (new: bulk update with run_time 400 on a default plant → rejected with `run_time_over_cap`), `tests/test_routing_resolver.py` (new: recomputed run time over cap → hold with `run_time_over_cap`), `tests/test_task_response_models.py` (bound), locale parity: `tests/modules/locale-completeness.test.mjs` + `tests/js/locale-keys.test.js` (there is no `tests/modules/i18n` directory)

**Interfaces (Task 0 ruling, Phase 0 item i / Appendix A open question 1):** no "planning-horizon setting" exists on `plants` — the optimizer's 35 days is a hard-coded constant (`engine.mts:671, 2052`). Rule: `cap_hours(plant_row) -> float = min(336.0, plant_row.visibility_horizon_days * 24.0) if visibility_horizon_days is a positive number else 336.0` (`plants.visibility_horizon_days` is nullable; NULL → 336 h). If the owner later names a different setting only this function changes. Produces reason code `run_time_over_cap` consumed by the Needs Planning list (existing UI renders `planning_reason.message`).

- [ ] **Step 1: Failing tests** (queue + reject-by-row + bulk-update reject + resolver hold).
- [ ] **Step 2: Run** scoped pytest → FAIL.
- [ ] **Step 3: Implement**; locale keys in all five files.
- [ ] **Step 4: Run** `python -m pytest tests/test_ingest_data_layer.py tests/test_task_concurrency.py tests/test_routing_resolver.py tests/test_task_response_models.py tests/test_schema_idempotent.py -q` and `node --test tests/modules/locale-completeness.test.mjs tests/js/locale-keys.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(integration): raise the order length cap to 336 h or the planning horizon; longer orders wait in Needs Planning`

### Task 1.7: Send transmits firmed orders only (OQ61)

**Model:** Sonnet
**Files:**
- Modify: `backend/integration/sap_staging.py` — **Task 0 ruling:** `_outbound_candidate_rows(cur, plant)` (2206-2215) has no `frozen_end` in scope; `frozen_end` is computed in `queue_send_to_sap` and `build_outbound_groups(rows, frozen_end)` (2161-2203) already calls `firm_flag` per row, so the firm filter goes in `build_outbound_groups` (drop unfirmed plain rows; an aggregate stays a candidate if any member child is firmed, and its roll-up end is still the latest end over **all** members, firmed or not — unchanged), `2218-2286` summary (`skipped_unfirmed` count), `docs/SAP_STAGING_DESIGN.md` D9
- Test: `tests/test_sap_staging.py:827-875` (seed firm on the sent order; add an unfirmed order that must not be queued), `tests/test_domain_sap_staging_edges_coverage.py:60-99`

- [ ] **Step 1: Failing test** `test_send_skips_unfirmed_orders`.
- [ ] **Step 2: Run** `python -m pytest tests/test_sap_staging.py -q -k "send or queue"` → FAIL.
- [ ] **Step 3: Implement**; D9 rewritten.
- [ ] **Step 4: Run** scoped → PASS. **Step 5: Commit** `feat(integration): Send to SAP transmits firmed orders only`

### Task 1.8: Purge preview range (OQ45)

**Model:** Haiku (Sonnet review before commit)
**Files:** `frontend/admin-ops/admin-ui.mts:1304-1312` (send `T00:00:00` / `T23:59:59` exactly as line 1534 does); test `tests/modules/admin-ops/*.test.mjs` if a preview test exists, else add one asserting the request body.

- [ ] Step 1 failing test → Step 2 run → Step 3 fix → Step 4 `npm run build && node --test tests/modules/admin-ops/` → Step 5 commit `fix(admin-ops): purge preview counts the whole last day`

### Task 1.9: Phase 1 docs

**Model:** Haiku (Sonnet review)
**Files:** the CLAUDE.md/AGENTS.md/docs lines listed in Task 1.5; `backend/integration/CLAUDE.md` hygiene line numbers (now `db.py:3941`, `4017`); `docs/MIGRATION.md` new section "Backward scheduling — Phase 1 shipped / Phases 2–4 pending" with the owner list query from Task 1.1 and the deploy order below; `docs/DEPLOYMENT.md` note that `2026-10-15-1` and `-2` are destructive-by-text and need their own `-AllowDestructive` run after reading every pending file.

- [ ] Rewrite → Sonnet review → commit `docs: record Phase 1 of the backward-scheduling migration`

### Phase 1 close-out (orchestrator; deploy steps are written for the owner, not executed)

- [ ] Full `npm test` and `python -m pytest tests/ -q` on the phase1 branch after the last task; compare with the baseline noted in 0.3; gate report in Appendix C.
- [ ] Fresh Sonnet review of the whole phase1 branch diff against spec §7.3 + §1.6 consequence 7.
- [ ] Write the owner's Phase 1 deploy runbook into `docs/MIGRATION.md` (Task 1.9): merge the branch to `main`; Phase 0 items a, b, c(Q1/Q8); planner notice ("save and close tabs"; lateness figures will change; no bar moves except rows with NULL run time and no stored end); `promote-azure` with `-AllowDestructive` in a run whose pending set is exactly `2026-10-15-1` and `-2` (read `migration_files_applied` first); owner check §7.1.2 before any admin presses Send; rollback = previous image (the locked columns are inert to old code; `basic_finish_date` is never rewritten in Phase 1).

---

## 2. Phase 2 — Stored-finish contract, backward calendar, manual placement, reconcile (feature branch)

Branch: `feature/backward-scheduling` cut from `main` after Phase 1 merges. Draft PR to `main` opened immediately for CI. Tasks run in the order given; each is one commit series on the branch.

**Naming fixed for Phase 2 and 3** (do not vary):
- SQL fragments in `db.py`: `_EFF_START_SQL` (queued (`planning_status = 'needs_planning'`) → NULL, else `COALESCE(seg.first_start, scheduled_start, basic_start_date)`), `_EFF_END_SQL = COALESCE(seg.last_end, scheduled_end, original_finish_received, basic_finish_date)` (no run-time arm) — **note `_EFF_END_SQL` already exists (db.py:212-217, 12 call sites) and is redefined with the segment arm: every caller must join `_SCHEDULE_SEGMENTS_LATERAL_SQL` (conflict scan 1037-1056, save prefetch 1272-1300, `distribution/data.py:2451-2462` already do; audit the other sites), and `distribution/data.py`'s unqualified header-vs-orders regex rewrite breaks on `original_finish_received` (exists on both tables) so importing the fragments there is required**; `_SAP_START_RECEIVED_SQL = COALESCE(original_start_received, basic_start_date, original_finish_received)` (visibility/vanish key), `_PLACED_SQL = (seg.segment_count >= 2 OR scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL)`.
- New column `orders.placement_exception TEXT NULL CHECK (placement_exception IN ('overtime','overlong'))`; wire field `placement_exception` (the **one** new `TaskDTO` field of this migration; add to `_ORDERS_SELECT` (db.py:548-595), the refresh SELECT `get_task_versions` (839-853) + `TaskVersionRow`, sample row, route dict literal, DTO, generated types together — Task 0 finding: the projection was unlisted).
- Shared wall-clock helpers `plantWallClockFromInstant(tz, instant)` and `plantInstantFromWallClock(tz, wall)` live in the compute core UMD (`frontend/nimbus-compute-core.js` return object + `.d.ts`) from Task 2.1 on, because `Store.plantNow` (platform layer) and the worker both need them; `engine.mts:579-594` becomes a re-export/thin wrapper.
- Python `db._order_is_running(row, now)` keeps its name; never-placed rows return False.
- TS: `Calendar.allocateRuntimeBackward`, `Calendar.latestAvailable`, `Calendar._freeIntervalsBackward`, type `BackwardResult`; `Engine.manualSchedulePatchFor(task, line, requestedFinish, policy, opts)` (third argument is now the **finish**); `Engine.finishAnchoredPatchFor(task, line, finish, policy, opts)`; `Engine.placeForwardSequence(line, items, from, policy)`; `Store.plantNow(plant): Date | null`; `Util.dueInstant(task)` (alias of the Phase 1 `Util.sapDueDate` instant); reason codes `overlong_never`, `run_time_over_cap`; alert types `finish_moved_earlier`, `reversal_forward`, `plant_no_timezone`, `line_no_calendar`, `placement_exception`, `setup_override_orphaned`, `pull_floor_crossed`, `late`, `start_may_be_stale`; session-only task field `derivationIssue: {code, from?, to?, detail?} | null` (set by the engine in Phase 2, rendered as alerts by the worker in Task 3.3); Store source tag `'engine-runtime-reconcile'` unchanged.

### Task 2.1: Backward calendar primitives (pure, Node-tested)

**Model:** Sonnet
**Files:**
- Modify: `frontend/calendar/calendar-engine.mts` (new functions beside `nextAvailable` 261-333, `_freeIntervals` 495-516, `allocateRuntime` 531-597; export the new type), `frontend/nimbus-compute-core.js:72-78` (add `prevCalendarDay` twin of `nextCalendarDay`, on the UMD return object + `.d.ts`), **move** `plantWallClockFromInstant` (module-private at `frontend/optimization/engine.mts:579-594`) **and** its new inverse `plantInstantFromWallClock(tz, wall)` into the compute core UMD (return object + `.d.ts`); `engine.mts` keeps thin wrappers so its call sites are untouched (Task 0 ruling — `Store.plantNow` in Task 2.4 needs them from the platform layer)
- Test: `tests/modules/calendar/calendar-engine.test.mjs` (new describe blocks), `tests/modules/calendar/capacity-allocation-integration.test.mjs`

**Interfaces (produces):**
```ts
export type BackwardResult =
  | { kind: 'placed'; start: Date; end: Date; scheduleSegments: ScheduleSegmentLike[];
      finishMoved: boolean; moveReason?: 'closed_finish' | 'no_slot_at_finish' | 'min_piece' | 'blackout' }
  | { kind: 'reached_now' }   // the walk hit `floor` before placing every minute → caller reverses
  | { kind: 'overlong' }      // policy never / overlong_only and run time > longest merged window (OQ50)
  | { kind: 'unavailable' };  // no operating window within the lookback

Calendar.allocateRuntimeBackward(line: LineId, finish: Date, runtimeMinutes: number, policy: SplitOrderPolicy,
  opts: { floor: Date; minSegmentMinutes: number; plantTz: string | null; lookbackDays?: number /* default 90 */ }): BackwardResult
Calendar.latestAvailable(line, finish, durationMs, opts): { start: Date; end: Date } | null  // contiguous twin of nextAvailable
Calendar._freeIntervalsBackward(line, finish, floor): Array<{start: Date; end: Date}>      // right-clipped at finish, left-bounded by floor, merged across midnight (OQ47)
```
Rules the implementation must follow (each is a test): finish after close → clamp to close (`finishMoved`, `closed_finish`); finish on a closed day or inside a blackout → latest operating instant before it (blackout **start** rounds down to the minute); finish exactly at window close is valid; finish exactly at window open hops to the previous open day's close; pieces fill from the latest fragment backward, each piece anchored at its fragment's end; a piece ending at the finish shorter than `minSegmentMinutes` is skipped and the finish moves earlier (`min_piece`, OQ55); under `never`, the latest merged free interval of at least the run time that ends at or before the finish is used, and if its end is earlier than the finish → `finishMoved` with `no_slot_at_finish` (OQ13); run time > longest merged window under `never`/`overlong_only` → `overlong`; the walk reaching `floor` → `reached_now`; day hops by calendar date (`prevCalendarDay`), never minus 24 h; when `plantTz` is given, all elapsed arithmetic runs on plant-zone instants (`plantInstantFromWallClock`) and results are returned as naive wall-clock Dates (OQ46); touching free intervals across midnight merge (OQ47). Forward helpers are untouched in this task.

- [ ] **Step 1: Failing tests** (one `it` per rule above plus: the 4.2.3 case — 8 h order, fragments Wed 06–18, Thu 06–10/12–18, Fri 06–18, finish Fri 10:00 under `never` → Wed 18:00 with `no_slot_at_finish`; under `partial_allowed` → pieces Thu 14–18 + Fri 06–10; the 4.2.7 minimum-piece mirror — 4 h 20 m, finish Fri 10:00, `partial_allowed`, min 30 → Thu 17:30–18:00 + Fri 06:10–10:00; the DST case of 4.2.5 (Chicago, Sun 8 Mar 2026, 5 h finishing 04:00 → start Sat 22:00); the `reached_now` case of 4.2.4).
- [ ] **Step 2: Run** `npm run build && node --test tests/modules/calendar/calendar-engine.test.mjs` → FAIL.
- [ ] **Step 3: Implement.** Reuse `_blockingIntervals`, `workWindow`, `_ceilMinute`/`_floorMinute`, `_beginRun`/`_endRun` caches. Keep every function pure.
- [ ] **Step 4: Run** both calendar test files → PASS; `npm run lint`.
- [ ] **Step 5: Commit** `feat(calendar): backward allocation from a held finish (latestAvailable, allocateRuntimeBackward)`

### Task 2.2: Server read rule — the placed finish wins; shared start/end fragments; running test on stored values; horizon keys

**Model:** Sonnet
**Files:**
- Modify: `db.py:212-217` (`_EFF_END_SQL` → new definition), `247-263` (`_EFF_END_WITH_RUNTIME_MISMATCH_SQL` → alias of `_EFF_END_SQL`, keep the computed mismatch arm 247-252), `553-559`, `652-658`, `699-702`, `841-842`, `1037-1056` (conflict scan: end from `_EFF_END_SQL`, lookback fixed at the 30-day cap — OQ27 e), `1281-1282`, `3209-3226` (`_order_is_running`: start = first segment else `scheduled_start`; end = last segment else `scheduled_end`; both must be non-NULL, else False), `3468-3472` (dup sort key: finish fallback), `backend/integration/sap_staging.py:709-710` (vanish key → `_SAP_START_RECEIVED_SQL`), `2206-2215` (candidate `eff_end` → `_EFF_END_SQL`; `eff_start` = first segment else `scheduled_start` else SAP start), `backend/distribution/data.py:2451-2462` (regex rewrite → import the fragments instead), `3025-3027`, `backend/setup/data.py:497-511` (use `_EFF_END_SQL` + exclude `planning_status = 'needs_planning'`), `993-997` (order by `_EFF_START_SQL`), the purge selector `_PURGE_WHERE_SQL` (`db.py:1829`, 1919, 2188-2189: `COALESCE(scheduled_end, basic_finish_date)` → `COALESCE(scheduled_end, original_finish_received, basic_finish_date)`; segments not joined there — Task 0 finding, spec S:2645), `frontend/scheduling/orders.mts:760-761` (client visibility filter reads `original_start_date`), `backend/routing/resolver.py:277, 764-778` + the resolver SELECT lists at `resolver.py:557, 566, 621` + the `check_eligibility` parameter path (399-460) + `db.py:1295, 1322, 1444` + `frontend/routing/runtime-client.mts:192` (production-version validity judged on `original_start_received` / wire `original_start_date`, OQ26)
- Test: `tests/test_task_concurrency.py:511` (flip: lookback fixed 30 d; end from stored finish), `tests/test_ingest_data_layer.py:796, 810` (flip: never-placed row is never running), `tests/test_sap_staging.py:576-580, 827-875, 1026-1040` (flip: Send reads stored finish; seed stores one), `tests/test_distribution.py:741-745, 4035` (V2 hold cases), `tests/test_setup_data.py` (observer reads shared fragment), `tests/test_visibility_horizon.py:159`, resolver validity tests

**Interfaces:** produces the fragments named above; consumed by Tasks 2.3, 2.7, 3.x.

- [ ] **Step 1: Flip/add the Postgres tests** named above to the new rule (a placed row's `end_date` equals its stored `scheduled_end` whatever the run time; a never-placed row's `end_date` equals `original_end_date`; `_order_is_running` False for a row with no stored dates even if SAP start < now; validity unchanged by an echo that moves `basic_start_date`).
- [ ] **Step 2: Run** `python -m pytest tests/test_task_concurrency.py tests/test_ingest_data_layer.py tests/test_sap_staging.py tests/test_distribution.py tests/test_setup_data.py tests/test_visibility_horizon.py -q` → FAIL on the flipped cases.
- [ ] **Step 3: Implement**; grep `run_time \* INTERVAL` / `INTERVAL '1 hour'` across `db.py backend/` to confirm no end copy remains (`rg -n "INTERVAL '1 hour'" db.py backend/`).
- [ ] **Step 4: Run** the same files → PASS. **Step 5: Commit** `feat(scheduling): the stored finish is the order's finish; one start and one end fragment server-wide`

### Task 2.3: Save contract, duration validator, stale-flag semantics, `placement_exception` column

**Model:** Sonnet
**Files:**
- Create: `migrations/2026-10-16-1-orders-placement-exception.sql` (ALTER ADD COLUMN + CHECK; destructive by text); mirror `schema.sql`
- Modify: `db.py:1092-1137` (`_order_update_shape`: write `placement_exception` when sent; queued → NULL it), `1483-1495` + `1551-1558` (single-edge writes rejected for non-segment rows: both edges or segments, always — drop the edge-completion borrow), new `_validate_continuous_width(start, end, run_time, placement_exception, plant_tz)` with 60 s tolerance, called at 1551 for non-segment rows unless `placement_exception IS NOT NULL` or `run_time IS NULL` — **Task 0 ruling (e7): the width is measured in elapsed plant-zone time: convert both naive edges to instants with `zoneinfo.ZoneInfo(plant_tz)` before diffing when the plant has a zone (a 24/7 bar across a DST gap — Task 2.1's Chicago case, naive width 6 h for a 5 h run — must pass); naive diff only when the plant has no zone**; `1585` + `1128-1129` (clear `runtime_schedule_mismatch` only when the validator passed), `2838-2852` (Excel re-upload flag CASE applies to every placed order, not children only), `3661-3667` (SAP-change reset also sets `runtime_schedule_mismatch = FALSE, placement_exception = NULL`), `backend/routing/resolver.py:673-679` (set the flag on **any** run-time change for a placed order; `718` SQL) and **delete the one-time routing-cutover branch at `resolver.py:825-829` (`is_cutover`) — the general rule subsumes it (Task 0 ruling, OQ34 a4)**, `768-769` (holds clear the flag and the exception), `backend/integration/sap_staging.py:1797-1799` (zero-open sweep UPDATE clears both), `backend/scheduling/models.py:235-261` (`TaskDateUpdate.placement_exception: Literal['overtime','overlong'] | None`; an explicit `null` clears the marker), `routes.py:193-197` + `_ORDERS_SELECT` (db.py:557 region) + `get_task_versions` (839-853) + `TaskVersionRow` + `tests/test_task_response_models.py` sample row + `npm run generate:api-types`, `frontend/scheduling/persistence.mts:1410-1430` (`_taskEditSnapshot` sends `placement_exception` when dirty, including an explicit `null` to clear), the task type `NimbusTask` in `frontend/platform/types.mts:34` (not store.mts)
- Test: `tests/test_task_concurrency.py` (new: end-only save rejected; both-edges save with width ≠ run time rejected with reason `width_mismatch`; width within 60 s accepted and flag cleared; `placement_exception='overtime'` save with width ≠ run time accepted and flag untouched), `tests/test_planning_exceptions.py` (queued rows null the exception), `tests/test_ingest_data_layer.py` (re-upload run-time change flags a placed plain order), `tests/test_schema_idempotent.py`, `tests/modules/scheduling/persistence.test.mjs` (payload carries the field)

- [ ] Step 1 failing tests → Step 2 run (FAIL) → Step 3 implement → Step 4 run `python -m pytest tests/test_task_concurrency.py tests/test_planning_exceptions.py tests/test_ingest_data_layer.py tests/test_schema_idempotent.py tests/test_task_response_models.py -q && npm run build && node --test tests/modules/scheduling/persistence.test.mjs` → PASS → Step 5 commit `feat(scheduling): save both edges or segments; width validator gates the stale flag; placement_exception marker`

### Task 2.4: One clock — server instant, plant zone, blocked plants (OQ52, OQ18 rounding)

**Model:** Sonnet
**Files:**
- Modify: `backend/scheduling/routes.py` `/tasks` response (add `server_now` ISO-UTC to the response envelope/meta the client already reads for horizons — locate with `rg -n "horizons" backend/scheduling/routes.py frontend/scheduling/persistence.mts`; if `/tasks` returns a bare list, use a response header `X-Nimbus-Server-Now` and read it in `persistence.mts`), `frontend/platform/store.mts` (`Store.serverOffsetMs`, `Store.plantNow(plant)` = `plantWallClockFromInstant(tz, new Date(Date.now() + offset))`, `null` when the plant has no valid zone), `frontend/optimization/engine.mts:1015-1027` (`isFrozenHorizon`/`isInProgress` default `now` → `Store.plantNow(task.plant)`; `null` zone → throw-free: treat as not frozen/not running and raise `plant_no_timezone` once per plant), `2028-2032` (`liveClock` uses `Store.plantNow`, floored to the minute), `1293-1311` (`_plantWallNow` delegates), `frontend/optimization/optimize-ui.mts:2115-2118` (`applyNow = Store.plantNow(plant)`), `frontend/platform/foundation.mts:749-767` (`plantNowParts` uses the offset), `frontend/insights/services.mts` payload builder `_snap()` 238-250 + `alerts()` post 256-261 + the sync `computeAlerts` call at 331 (worker payload carries `now` per plant; 187-190 is `_stripPriorityFields`, not the payload), `frontend/nimbus-compute-core.js:414-416` (alert clock reads the payload `now`); `server_now` goes in the `/tasks` `meta` dict (`models.py:95-107` is a loose dict; also add it to `empty_meta`, `routes.py:~160`), `calendar-engine.mts:264` (15-minute snap stays for forward searches; the reversal forward leg in Task 2.6 floors to the minute instead — OQ18)
- Test: `tests/modules/optimization/engine.test.mjs` (frozen/running with injected offset; no-zone plant → alert, not throw), `tests/js/compute-core.test.js` (alert horizon uses payload `now`), `tests/modules/scheduling/persistence.test.mjs` (offset captured from the response), `tests/test_task_response_models.py` if the envelope is a model

- [ ] Step 1 failing tests → 2 run → 3 implement → 4 `npm run build && node --test tests/modules/optimization/engine.test.mjs tests/js/compute-core.test.js tests/modules/scheduling/persistence.test.mjs` → 5 commit `feat(platform): one plant-zone clock from the server instant; plants without a zone are blocked with an alert`

### Task 2.5: Manual placement and every run-time trigger hold the finish (OQ1, OQ7, OQ8, OQ13 b, OQ15, OQ17, OQ50 release, OQ63)

**Model:** Sonnet
**Files:**
- Modify: `frontend/optimization/engine.mts:1169-1182` (`schedulePatchFor` stays forward — used for running orders and reversal), new `finishAnchoredPatchFor(task, line, finish, policy, opts)` (backward via Task 2.1; `reached_now` → by default forward from `Store.plantNow` floored to the minute via `allocateRuntime`/`findContiguousSlot`, **but with `opts.deferReversal: true` (Task 2.6's reconcile) it returns `{kind:'reached_now'}` unresolved so the caller can batch reversals per line in held-finish order — Task 0 ruling**; `overlong` → `{kind:'refuse', reason:'overlong_never'}`; run time ≤ 0 or missing → `{kind:'refuse', reason:'run_time_zero'}` (OQ13 "places nothing and reports it"); `placement_exception` set → translate verbatim), `1208-1245` (`manualSchedulePatchFor(task, line, requestedFinish, …)`: segments ≥ 2 → rigid translation by the dragged piece's **same-edge** delta (OQ17 b); otherwise `finishAnchoredPatchFor(snap(finish))`; a manual drop whose result has `finishMoved` → return `null` and `Toast` key `toast.finish_cannot_hold` (OQ13 b: the Gantt reverts); firmed task + drop outside hours + `opts.confirmedOvertime` → raw placement with `placement_exception='overtime'` (OQ63)), `1186-1199` (`manualRoutingSchedulePatchFor` passes the finish), `1038-1046` (`plannerUnscheduleChanges` also nulls `placement_exception`)
- Modify callers: `frontend/scheduling/gantt.mts:4321-4327, 4346, 4389, 4483-4498, 4437-4457` (anchor = `newEnd`; `deltaMs = newEnd - t.end_date`; a left-edge-only change (start moved, end unchanged) is reverted with `toast.left_edge_locked` unless Phase 0 item e shows the handle can be hidden via vis `editable.updateTime` + `onMoving`; `moved` compares end + group), `frontend/scheduling/orders.mts:550-559` (Updated Start `editable:false`, Updated End `editable:true` with `_DateTimeEditor`), `1264-1269` (`_runtimeEditAnchor` → returns the **finish**: `task.end_date` if placed else `Util.dueInstant(task)`), `1291-1378` + `2410-2497` (S5 removed: typing a start is no longer possible; S6/S7/S8 and Inspector: if `Engine.isInProgress(task)` → `schedulePatchFor(task, line, task.start_date)` (OQ3) else `manualSchedulePatchFor(task, line, anchorFinish)`; the `manualRoutingSchedulePatchFor` call at 1378 passes the finish), **`orders.mts:1465-1532` Override `applyOverride` (1517 passes a start today): Task 0 ruling — the Override modal's date input becomes the finish in this task (field, `index.html:2317-2350` label, keys `modal.override_finish*` in 5 locales); Task 3.4 keeps the rest of the modal rework**, `frontend/nimbus-intelligence.js:1230-1263` (Push +1h: finish + 1 h, start re-derived; skip firmed/frozen/running), `frontend/scheduling/persistence.mts:915-991` (delete `_snapToWorkingHours` and its calls at 578 and `calendar-sync.mts:250`; the reconcile of Task 2.6 covers never-placed rows), the Needs Planning release path (locate: `rg -n "needs_planning" frontend/scheduling/*.mts frontend/shell/*.mts | rg -i release`): a row queued with reason `overlong_never` releases as one continuous elapsed bar ending at `Util.dueInstant(task)` with `placement_exception='overlong'` and alert `placement_exception`; a row queued with `run_time_over_cap` releases through `finishAnchoredPatchFor`
- Test: `tests/modules/optimization/engine.test.mjs:3158` (flip: finish held, start derived), `3206` (keep), `tests/modules/scheduling/gantt.test.mjs:971` (flip: end-only change is a real move), `1041` (flip: same-edge delta), `tests/modules/routing/machine-edit-contract.test.mjs:122-147` (flip: release holds the due instant), `tests/modules/scheduling/orders.test.mjs` (Updated Start read-only; End editable; run-time edit on a running order holds the start), `tests/modules/scheduling/persistence.test.mjs:563` (delete the snap expectation), new: Push +1h skips firmed; firmed overtime confirm stores the marker; overlong-never release draws one bar with the marker; marked order's run-time shrink leaves the bar (Review Focus 5)

- [ ] Step 1 flip/add tests → 2 run `npm run build && node --test tests/modules/optimization/engine.test.mjs tests/modules/scheduling/gantt.test.mjs tests/modules/scheduling/orders.test.mjs tests/modules/routing/machine-edit-contract.test.mjs tests/modules/scheduling/persistence.test.mjs` (FAIL) → 3 implement → 4 same command → PASS; `npm run check:legacy-surface` (the surface must shrink or stay; never grow) → 5 commit in two: `feat(scheduling): manual placement anchors on the finish and walks the calendar backward` and `feat(scheduling): run-time, machine and version edits hold the finish; running orders hold the start`

### Task 2.6: Reconcile on the finish — stale rows, never-placed rows, reversal queue, guards, cutover path (OQ3, OQ4, OQ33, OQ34, OQ51, OQ53, OQ62)

**Model:** Sonnet
**Files:**
- Modify: `frontend/optimization/engine.mts:1252-1275` (`reconcileRuntimeSchedules(plant, opts?: {reason?: string})`), new `placeForwardSequence` (extract the cursor loop of `removeBacklog` ~1377-1436 so both use it), `2777-2791` (subscriptions unchanged in kind: calendar hydration + refresh; **never** ordinary calendar edits), `frontend/calendar/calendar-sync.mts:96-104, 165-198, 231-233` (expose `calendarState(plant): 'hydrated' | 'pending' | 'failed'`; `failed`/`pending` → reconcile is skipped and the banner `ui.derive_paused` shows), `frontend/distribution/distribution-pane.mts:1428` (call shape), `frontend/platform/types.mts:34` `NimbusTask` (per-task session notes, not persisted: `systemMove: {from: Date, to: Date, reason: string} | null` and **`derivationIssue: {code, from?, to?, detail?} | null` — this task SETS `derivationIssue` on every task it touches or skips (Task 0 finding: 3.3 consumes it); plant-level conditions (`plant_no_timezone`, `line_no_calendar`) are recorded on every affected task and the worker de-duplicates them to one alert per plant/line in Task 3.3**)
- Selection: `task.runtime_schedule_mismatch || !task.user_scheduled`, excluding queued rows and rows with `placement_exception`. **Task 0 ruling (steady state vs cutover):** a never-placed row that is **not** stale-flagged is derived for display only — its patch is committed through `Store.updateMany` with the non-dirty session source (same visibility as today's `_snapToWorkingHours` result; Save does not persist it, the server row stays never-placed, Review Focus 2 holds); a row **with** `runtime_schedule_mismatch = TRUE` (a stale placed row, or every row after the Task 4.1 cutover flag) gets a dirty patch that the next Save persists. The batch toast counts dirty patches only.
- Per row: `anchor = task.user_scheduled ? task.end_date : Util.dueInstant(task)`; if `task.user_scheduled && Engine.isInProgress(task, plantNow)` → hold start, `schedulePatchFor(task, line, task.start_date)` (OQ3; finish may move later); else `finishAnchoredPatchFor(task, line, anchor, policy, {deferReversal: true, setupMinutes})`; firmed orders are re-derived like any other and keep `firmed` (OQ4) — **a derived start that lands inside the frozen window records `derivationIssue.code = 'frozen_window_crossed'` (alert only, nothing un-firmed; OQ4 a, Task 0 a2)**; line with no calendar row (`Store` has no row for the line **from the server**, not the default) → skip + `line_no_calendar` (OQ62); plant with no zone → skip whole plant + `plant_no_timezone` (OQ52); `overlong` → `plannerUnscheduleChanges` + reason `overlong_never` (OQ50); `run_time_zero` → no bar + `derivationIssue.code = 'run_time_zero'` (OQ13); `reached_now` rows are collected per line, sorted by anchor finish then id, placed by `placeForwardSequence(line, items, plantNow)` (OQ53 b), each with `derivationIssue = {code:'reversal_forward', detail}` where `detail` is `'run_time_grew'` (the row was stale because its run time changed), `'due_date_past'` (never-placed/past due) or `'cutover'` (Task 4.2 passes `reason:'cutover'`) — the Remove Backlog dialog of Task 3.1 counts `detail === 'run_time_grew'` (OQ56 a); derived start below `earliestAllowedStart` → `pull_floor_crossed` (OQ20); `finishMoved` → `derivationIssue = {code:'finish_moved_earlier', from, to}`; every patch records `systemMove` and the batch ends with one `Toast` (`toast.system_moved_n`, OQ53 e / OQ57 a). Patches set `runtime_schedule_mismatch: false` locally and commit through `Store.updateMany(patches, 'engine-runtime-reconcile')` (dirty for stale rows; explicit Save persists). No undo entry (OQ57).
- Test: `tests/modules/split-order.test.mjs:275` (flip: backward from the 20:00 finish into the previous day), `308` (keep), `tests/modules/optimization/engine.test.mjs` new describe `reconcile (finish-anchored)`: never-placed row derives from the due instant; stale placed row holds its stored finish; running stale row keeps its start and moves its finish later (Review Focus 3); firmed row re-derived and still firmed; three reversing orders on one line land X at now, Y after X, Z next window (the OQ53 example); calendar `failed` → nothing moves and the banner key is set (Review Focus 4); line without a server calendar row → untouched + alert; plant without zone → untouched + alert; `placement_exception` row untouched; batch toast count equals patches

- [ ] Step 1 tests → 2 run `node --test tests/modules/split-order.test.mjs tests/modules/optimization/engine.test.mjs` (FAIL) → 3 implement → 4 PASS → 5 commit `feat(optimization): reconcile derives starts from the held finish, reverses past-due walks in finish order, and leaves marked or unanchored rows alone`

### Task 2.7: Ingest under the new rule — finish required, start optional; reset/hold/wipe rules; Send remembers the stored finish (OQ24, OQ25, OQ59)

**Model:** Sonnet
**Files:**
- Modify: `db.py:4118` (required Excel columns: `PRODUCTION_ORDER, MATERIAL_NUMBER, BASIC_FINISH_DATE`; start optional), `3990-3996` (unparseable **start** → warning, keep row with NULL start), `3468-3472` (dup sort: finish fallback), `2602-2700` (`sap_changed_fields`: the `dates` field fires only when the finish changed and is not an echo; a start-only change does not wipe the placement — OQ25 c — and (Task 0 ruling B2) refreshes `original_start_received` **only when the finish is not an echo**, i.e. on a never-sent order or alongside a genuine finish change; quantity rule 2674-2688 unchanged — OQ25 a), `backend/integration/sap_staging.py:522-527` (start optional, finish required), `backend/scheduling/routes.py:531-545` + `db.py` bulk route (`/tasks/bulk_update`: accept both edges, read `end_date` as the placed finish, set `runtime_schedule_mismatch = TRUE` when the sent start is not trusted — **this bulk-route flag write takes precedence over Task 2.3's validator clearing: the route passes a `trust_start=False` argument and the validator is skipped for it**, return `start_derived: true` per id in `BulkUpdateResult` (`models.py:142-168`) + `npm run generate:api-types` — OQ59 b), `backend/distribution/data.py:3102-3112, 3141-3142, 1383, 1555, 2295, 2336, 2388` + `frontend/distribution/distribution-pane.mts:116` ("scheduled" = `_PLACED_SQL` shape), `data.py:1457` (new child from re-weight: copy the siblings' stored finish, set the stale flag; no forward start+run-time write — OQ58 inference)
- Test: `tests/test_ingest_data_layer.py` (flip the start-required cases; new: start-only SAP change on a **never-sent** order keeps the slot and updates `original_start_received`; start-only change on a sent order whose finish echoes keeps the slot and leaves **both** locked columns unchanged), `tests/test_sap_staging.py:280-287` (flip: missing start valid, missing finish `invalid_date`), `tests/test_orders_routing_ingest.py:628` (flip for OQ25 c), `tests/test_distribution.py:1349, 1514, 1539` (flip: carry reads the placed finish), `tests/test_task_concurrency.py` (bulk route response carries `start_derived`), `tests/test_distribution.py` (finish-only placed child counts as scheduled → 409 guard fires on re-weight removal), `tests/test_sap_staging.py` (Review Focus 2: a firmed never-placed order is sent with `original_finish_received` as its finish, and the echo of that value is a match in `finish_echoes`)

- [ ] Step 1 tests → 2 run scoped (FAIL) → 3 implement → 4 PASS → 5 commit `feat(integration): finish required and start optional at ingest; start-only SAP changes keep the placement; external date writes read the finish as placed`

### Task 2.8: Phase 2 flipped-test sweep, i18n keys, docs

**Model:** Sonnet (tests) then Haiku (locale rows + docs, Sonnet-reviewed)
**Files:** every test named in §10.2 lines 3450-3462 not already flipped in 1.4 or 2.1–2.7 (`tests/test_setup_data.py:419, 430-466` and the nine hygiene cases were flipped in Task 1.4 — verify, do not redo; `tests/modules/scheduling/persistence.test.mjs:578` and anything still pinning a forward rule); all new keys of Phase 2 (`toast.finish_cannot_hold`, `toast.left_edge_locked`, `toast.system_moved_n`, `ui.derive_paused`, `alert.finish_moved_earlier`, `alert.reversal_forward`, `alert.plant_no_timezone`, `alert.line_no_calendar`, `alert.placement_exception`, `reason.overlong_never`, `modal.confirm_overtime_*`) present in all five locale files; `frontend/scheduling/CLAUDE.md`, `frontend/calendar/CLAUDE.md`, `frontend/optimization/CLAUDE.md`, `backend/scheduling/CLAUDE.md` + AGENTS twins rewritten for the finish anchor (the REWRITE rows of §11.2 that belong to these domains).

- [ ] Run full `npm test` and `python -m pytest tests/ -q` on the branch; fix or flip until green except the known baseline noise; commit `test: flip forward-rule pins to the finish anchor` then `docs: scheduling, calendar and optimization CLAUDE.md describe the finish anchor`.

### Phase 2 gate
- Groups 1, 2, 3, 4a, 5, 10, 11, 13, 14, 17, 18, 21 present (map each group to the test names added above in the PR description).
- `npm test`, `python -m pytest tests/ -q` green on the branch; CI green on the draft PR.
- Not released. Rollback = the branch is not merged.

---

## 3. Phase 3 — Optimizer output, setup rule, consumers, UI, i18n, distribution (feature branch, after Phase 2)

**Alert plumbing rule for Phases 2–3:** engine-side findings (finish moved earlier, reversal, blocked plant/line, marker, orphaned override, pull-floor crossing) are recorded on the task as a session-only field `derivationIssue: {code, from?, to?, detail?} | null` in Phase 2 (Task 2.6 records; the user sees a Toast). Task 3.3 turns those fields into alerts in the worker so they appear in the Alerts panel like every other alert. No alert is computed on the main thread.

### Task 3.1: Optimizer under Reading A — A-lite, finish-keyed instability, undo re-derives, dead walk deleted (OQ14, OQ20, OQ21, OQ22; groups 16, 22–26)

**Model:** Sonnet
**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts:2999-3000, 7202-7203` (instability = |new last end − prior end| in minutes), `6876-6880` (keep; "changed" already compares both edges), `frontend/optimization/engine.mts:2216-2221` + `frontend/optimization/optimize-ui.mts:2125-2126` + `frontend/platform/store.mts:1005-1016` (`UndoStack.restoreTasks` restores the finish, sets `runtime_schedule_mismatch: true` on each restored row and calls `Engine.reconcileRuntimeSchedules(plant, {reason:'undo'})` so the start follows the current run time — OQ21; `TimeMachine.restore` at `frontend/nimbus-intelligence.js:1449-1467` gets the same flag-and-reconcile treatment — group 15), delete `engine.mts:2357-2619` and `_dispatchPolicyAware` (1872) with `tests/modules/optimization/engine.test.mjs:938, 1167` (review the shared group 147-180; keep `capAwareSequence` tests) — OQ22 (the evaluator labels `throughput`/`due-date-first` at `engine.mts:871-893` **stay**; owner confirmation still open, Appendix B), `engine.mts:1084-1108` + Task 2.6 reconcile (derived start below `earliestAllowedStart` → `derivationIssue.code = 'pull_floor_crossed'` — OQ20), `optimize-ui.mts` preview (a `Store` event with source `'engine-runtime-reconcile'` while a preview is open marks it stale: Apply disabled + banner key `ui.preview_stale` — group 26), `optimize-ui.mts:348-360` (Remove Backlog dialog shows "N orders are backlog because their run time grew" = count of tasks with `derivationIssue.code === 'reversal_forward' && detail === 'run_time_grew'` — OQ56 a), **(Task 0 ruling, OQ63 a1) every optimizer entry point leaves `placement_exception` rows alone: the snapshot builder / fixed-vs-free split in `runAndApply`, Remove Backlog, autoReflow and the Alerts Fix cascade treat a marked row as fixed exactly like a firmed row under "Respect firmed" (regardless of that toggle); test: a marked unfirmed row keeps its edges through `runAndApply` with respectFirmed off**, **(OQ50 c, a7) an optimizer/Remove Backlog `'overlong'` result on a `never` plant is refused to Needs Planning via `plannerUnscheduleChanges` + reason `overlong_never` (no continuous elapsed bar on any retained forward path); `engine.mts:1395-1405` `diagnostics.overlongIds` keeps reporting them**, `tests/modules/optimization/scheduler-plant-scale.test.mjs` (add the finish-first output check: every placed task's `end_date` equals its last segment end / start + productive minutes; Reading A needs no fixture change)
- Test: `tests/modules/setup-scheduler.test.mjs:5056` (flip to finish key), `tests/modules/optimization/optimize-ui.test.mjs:1629` (keep; uses `Store.plantNow`), new undo-re-derive test, new preview-stale test, new pull-floor-crossed test, legacy tests deleted

- [ ] Step 1 flip/add → 2 `npm run build && node --test tests/modules/setup-scheduler.test.mjs tests/modules/optimization/` (FAIL) → 3 implement → 4 PASS; `node scripts/bench-optimizer.mjs` digest unchanged within noise → 5 commit `feat(optimization): optimizer result is the placed finish; instability keyed on the finish; undo re-derives the start; legacy walk removed`

### Task 3.2: Setup rule at its 12 sites (OQ2 V1, OQ40; group 7)

**Model:** Sonnet
**Files:**
- Modify: `frontend/calendar/calendar-engine.mts` (`allocateRuntimeBackward` gains `opts.setupMinutes`: the earliest piece's fragment must hold `setupMinutes` immediately before the productive start; if not, that fragment is clipped and the walk continues into the previous fragment — V1), Task 2.6 reconcile (passes `setupMinutes` from the setup domain's required changeover for the predecessor pair on that line, `frontend/setup/setup-domain.mts:467` adjacency; manual drops pass 0 — OQ40 alert-only), `frontend/optimization/engine.mts:320-379` (`setupAvailabilityMinutes` counts across midnight on merged intervals — fixes A.3 #9), `434-437` (adjacency by start — unchanged, but when an override's pair no longer sits adjacent after a re-derive record `derivationIssue.code='setup_override_orphaned'` on the successor), `setup-scheduler.mts:307-374, 3032, 3102-3107, 4581-4598, 6577-6585, 7003-7012, 7217-7228` (review only: forward placement in the optimizer is retained; confirm each site reads the task's wire edges and not start + run time; change nothing that the review finds correct), `frontend/nimbus-compute-core.js:858-873` (setup alert text → locale key, 5 locales)
- Test: `tests/modules/calendar/calendar-engine.test.mjs` (the OQ2 V1 example: window 06–18, A Mon 08–16, B 8 h held Tue 14:00, 30 min setup → `partial_allowed`: Mon 17:30–18:00 + Tue 06:30–14:00; `never`: `no_slot_at_finish` → Mon 18:00), `tests/modules/optimization/engine.test.mjs` (midnight availability 23:50 → 00:10 with 30 min = 20 available; orphaned override issue), `tests/modules/setup-scheduler.test.mjs:4548` (keep)

- [ ] Step 1 tests → 2 run (FAIL) → 3 implement → 4 PASS → 5 commit `feat(setup): backward derivation reserves changeover ahead of the productive start in the same window`

### Task 3.3: Alerts, KPIs, utilization, labor — late alert, one day-attribution rule, "today", engine findings as alerts (OQ6, OQ12, OQ41, OQ42; groups 4b, 8, 14)

**Model:** Sonnet
**Files:**
- Modify: `frontend/nimbus-compute-core.js` (new alert `late`: `end > dueDateInstant(...)` → warning; also beyond the push ceiling → error, using the payload's per-plant push-cap days; new `workingMinutesByDay(task, dayWindowFor)` used by the utilization matrix 1023, the overload rule 585-587 and exported for the cell briefing; alerts from `task.derivationIssue` codes `finish_moved_earlier`, `reversal_forward`, `plant_no_timezone`, `line_no_calendar`, `placement_exception`, `setup_override_orphaned`, `pull_floor_crossed`, `frozen_window_crossed`, `run_time_zero` (plant-/line-level codes de-duplicated to one alert per plant or line); mismatch alert 781-787 reworded via key `alert.start_may_be_stale`; the clock at 414-416 reads the payload `now` from Task 2.4), `frontend/platform/types.mts:469-477` + `frontend/nimbus-compute-core.d.ts:28-32` (add the new members and the missing `distribution-separation` so the two unions agree), `frontend/insights/insights-ui.mts:390, 400-402` + `frontend/scheduling/orders.mts:751-754` + `frontend/scheduling/gantt.mts:2744` ("today" = overlaps today — OQ42), `insights-ui.mts:1250-1251` (cell briefing uses `workingMinutesByDay`), `frontend/insights/services.mts:842, 836, 907` (delete `dayByLine`/`todayByLine` and their tests — OQ41 — **also the characterization pin `tests/modules/legacy-app-characterization.test.mjs:79` and the doc lines `frontend/insights/CLAUDE.md:9, 28` + AGENTS twin**), `frontend/labor/labor-planning.mts:279` (no change; verify it reads the matrix), `frontend/platform/foundation.mts:696-735` (`scheduleKpis` late count via `dueInstant`), locale keys in 5 files
- Test: `tests/js/compute-core.test.js` (late alert warning/error; day attribution: a 14 h order held Fri 00:00 with start Wed 22:00 on an 08–18 calendar puts 14 h on Thursday in matrix, overload and briefing alike; derivation-issue alerts; midnight overlap "today"), `tests/modules/insights/*.test.mjs` tiles, `tests/modules/labor/*` unchanged green

- [ ] Step 1 tests → 2 run `node --test tests/js/compute-core.test.js tests/modules/insights/ tests/modules/labor/` (FAIL) → 3 implement → 4 PASS → 5 commit `feat(insights): late alert on the due instant; one calendar-aware day-attribution rule; engine findings surface as alerts`

### Task 3.4: Grid, Inspector, Override, hover/print copy, i18n (OQ16, OQ43, OQ57; groups 19, 28, 30, 31, 32, 33)

**Model:** Sonnet (code) + Haiku (the four non-English locale rows and the encoding fix, Sonnet-reviewed)
**Files:**
- Modify: `frontend/scheduling/orders.mts:534-549` (retire the Original Start column; Original End relabelled key `col.due_date`), `550-558` (Updated End → key `col.planned_finish`, editable with its own `_DateTimeEditor` instance; Updated Start → key `col.planned_start`, read-only), `230-255` (saved layouts: ignore unknown column ids on restore; add a unit test that a layout naming `original_start_date` loads) and the field-visibility setting `Table._fieldHidden` (`orders.mts:391, 534`: an admin visibility choice naming the retired column is ignored the same way — OQ16, Task 0 a11), `2212-2224` (Inspector: End input editable, Start text; explain-the-move line from `task.derivationIssue`/`systemMove` with key `ui.insp_system_move`), `2392-2408` (`_varianceBadge` = planned finish − due instant; key `ui.insp_variance_*`), `1465-1532` + `frontend/index.html:2317-2350` (Override modal: the finish field itself landed in Task 2.5; here: line, firm, every remaining string keyed), `1383, 1519, 2486, 568` (failure toasts and "Click to view alerts" keyed), `2652` (print range = overlap), `2689, 2736` (CSV/print headers unchanged — OQ43 a), `frontend/scheduling/order-field-catalog.mjs:51-53` (remove `original_start_date` entry; keep the wire field), `frontend/scheduling/gantt.mts` hover card strings keyed; `toast.order_moved` text reads the finish (group 33); `frontend/locales/{en,de,es,fr,pt}.js` (reworded keys `col.orig_end→col.due_date`, `col.updated_*→col.planned_*`, `ui.insp_orig_end`, `ui.insp_updated_*`, `ui.insp_variance_shifted`, `ui.diff_kind_*`, `toast.order_moved`, `toast.commit_failed`; new modal/inspector keys; `de.js:851`/`pt.js:851` encoding fix — A.3 #10), `tests/modules/locale-completeness.test.mjs:506` (baseline stays 231; add `REWORDED_KEYS` pinned list asserting each reworded key exists in all five files with the new English text — group 32)
- Test: `tests/modules/scheduling/orders.test.mjs` (`:1202` Flatpickr start-field → end field; badge: due Tue 09:00, 6 h, finish Tue 09:00 → "0.0h"; Override writes a finish), `tests/modules/scheduling/gantt.test.mjs` (resize right edge = finish move; no-op resize no undo entry — A.3 #18), locale tests

- [ ] Step 1 tests → 2 run `node --test tests/modules/scheduling/orders.test.mjs tests/modules/scheduling/gantt.test.mjs tests/modules/locale-completeness.test.mjs tests/js/locale-keys.test.js` (FAIL) → 3 implement (Sonnet), then Haiku fills `de/es/fr/pt` rows from the pinned English list → Sonnet review → 4 PASS → 5 commits `feat(scheduling): Planned finish is the editable date; Due date and Planned start are read-only; Override sets a finish` and `i18n: reworded and new scheduling keys in five locales`

### Task 3.5: Distribution — shared finish, collapse carry, separation alert, CSV due column, guards (OQ11, OQ37, OQ38, OQ39; group 12)

**Model:** Sonnet
**Files:**
- Modify: `backend/distribution/data.py:2827-2866` (`_collapse_to_survivor` — **OQ37 R2 as the owner accepted it, Task 0 ruling B1: carry "the end the planner sees today" = the survivor's kept start + its full (100 %-share) run time, computed as `scheduled_end = scheduled_start + run_time * INTERVAL '1 hour'` (plain arithmetic, no calendar); keep `scheduled_start`; delete segments; set `runtime_schedule_mismatch = TRUE` so the browser re-derives the start backward from that finish through the calendar. Never carry the old partial-share `scheduled_end` verbatim (that is R1, rejected).** Test: the spec example (Wed 12:00 partial end, start Tue 18:00 → stored end Wed 16:00, flag TRUE), `3822` (repair passes through the `scheduled_removed` 409 guard — A.3 #16), the collapse dry-run listing at `data.py:3100-3112` + `3141-3142` (lists the survivor in `removed_scheduled` when firmed — A.3 #15; 2839-2840 are the carried date columns, not the listing), CSV writer `backend/distribution/routes.py:213-231` with rows from `data.py:2441-2462` (add `due_date` column from `original_finish_received`; window key unchanged — OQ39), `frontend/nimbus-compute-core.js:541-543` + `frontend/optimization/setup-scheduler.mts:6722-6731` (separation buckets on the finish — OQ38; keep the "mirror" comments pointing at each other), `frontend/distribution/distribution-pane.mts` (list badge reads the shared finish; A.3 #23 badge/response disagreement resolved by reading the wire flag only)
- Test: `tests/test_distribution.py` (collapse carries finish and flags; repair 409; dry-run firmed survivor listed; CSV has `due_date`), `tests/js/compute-core.test.js` + `tests/modules/setup-scheduler.test.mjs` (separation on finish: 70/30 family finishing together raises nothing)

- [ ] Step 1 tests → 2 run → 3 implement → 4 `python -m pytest tests/test_distribution.py -q && node --test tests/js/compute-core.test.js tests/modules/setup-scheduler.test.mjs` PASS → 5 commit `feat(distribution): siblings share the finish; collapse carries the finish; separation judged on finishes`

### Task 3.6: Phase 3 docs and remaining doc rewrites (§11.2, §11.2a, §11.3, §11.8)

**Model:** Haiku (Sonnet review)
**Files:** the REWRITE/DELETE lines verified at HEAD: `aggregate_to_detail.md:29, 54, 297, 310, 320, 322, 374, 375, 429, 439, 560, 669`; `backend/distribution/CLAUDE.md:11, 65`; `backend/integration/CLAUDE.md:25, 26, 127` + `AGENTS.md:126`; `backend/routing/CLAUDE.md:38`; `frontend/scheduling/CLAUDE.md:31, 37, 44` + AGENTS twin `31, 37`; `frontend/calendar/CLAUDE.md:22` + twin; `frontend/routing/CLAUDE.md:20`; `docs/MIGRATION.md:888-896`; `ROUTING_RUNTIME_DESIGN.md:25, 174, 244, 321, 392`; `docs/SAP_STAGING_DESIGN.md:36, 108, 118, 163`; `docs/SAP_STAGING_VALIDATION_PLAN.md:401`; `docs/architecture/optimizer-dispatch.md:14, 92`; `docs/NIMBUS_INTERFACE_ARCHITECTURE.md:105, 367, 596`; `docs/SAP_INTEGRATION_ROADMAP.md:25, 122, 287`; `PRODUCT.md:21`; `DESIGN.md:211`; `frontend/scheduling/gantt.mts:3349` comment; `schema.sql:75` index comment; root `CLAUDE.md` Scheduling/Calendar/Optimization rows. HISTORICAL files get a one-line "superseded by the finish anchor, 2026-10" note at the top, not edits.

- [ ] Rewrite → Sonnet review (each statement checked against the Phase 2/3 code) → commit `docs: finish-anchored scheduling across domain docs`

### Phase 3 gate
- Groups 4b, 7, 8, 12, 15, 16, 19, 22–26, 28–33 present; the REVIEW tests of §10.4 resolved per owner decision.
- Full `npm test` + `python -m pytest tests/ -q` green on the branch; CI green on the draft PR; `npm run check:static-assets`, `npm run check:legacy-surface`, `npm run lint` clean.
- A **fresh Sonnet whole-branch review** of `feature/backward-scheduling` against spec §1.6 + §12 (not against the implementer summaries): every forward path either replaced or on the retained list (optimizer forward placement, Alerts Fix/autoReflow cascade, Remove Backlog, reversal forward leg).

---

## 4. Phase 4 — Global cutover (one image, one migration run)

### Task 4.1: Cutover migration files + group 9 test

**Model:** Sonnet
**Files:**
- Create: `migrations/2026-10-20-0-orders-precutover-snapshot.sql` (CREATE TABLE … AS SELECT of `orders` date/flag columns + `order_schedule_segments` + `order_sap_sent`; **no** destructive word anywhere, comments included; ledger id `backward_cutover_snapshot`), `migrations/2026-10-20-1-backward-cutover.sql` (ledger id `backward_scheduling_cutover`; destructive by text); mirror both in `schema.sql`
- Test: `tests/test_backward_cutover.py` (new, Postgres; seeds its own fleet: running placed, future placed, never placed, queued, split, firmed, marked, distribution family; applies both files twice; asserts the write set and ledger idempotence — group 9)

**Migration content (the owner-chosen "automatic on first load" mechanism):**
```sql
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'backward_scheduling_cutover') THEN
    -- running = a planner-placed start at or before plant-local now and the old effective end after it
    -- (Task 0 ruling: real column names — plants.plant (PK is (subnetwork, plant); MIN(timezone) per plant as
    --  sap_staging.py does, a plant may sit in two subnetworks), orders.planning_status = 'needs_planning',
    --  order_schedule_segments.scheduled_end; plant-local naive now is simply now() AT TIME ZONE tz.)
    WITH plant_now AS (
      SELECT p.plant, now() AT TIME ZONE COALESCE(NULLIF(MIN(p.timezone),''),'UTC') AS pnow
      FROM plants p GROUP BY p.plant
    ), old_end AS (
      SELECT o.id, COALESCE(MAX(s.scheduled_end), o.scheduled_start + (o.run_time * INTERVAL '1 hour'), o.scheduled_end) AS old_end
      FROM orders o LEFT JOIN order_schedule_segments s ON s.order_id = o.id GROUP BY o.id
    ), running AS (
      SELECT o.id, e.old_end FROM orders o JOIN plant_now pn ON pn.plant = o.plant JOIN old_end e ON e.id = o.id
      WHERE o.scheduled_start IS NOT NULL AND o.scheduled_start <= pn.pnow AND e.old_end > pn.pnow
    )
    UPDATE orders o SET
      -- Task 0 ruling B4 (OQ3/OQ5): a running row keeps BOTH its start and its old forward end so it still
      -- reads as running (server _order_is_running needs both edges; client isInProgress needs now < end)
      -- even when its due date is already past. Every other row loses both edges and re-derives from its due date.
      scheduled_start = CASE WHEN r.id IS NOT NULL THEN o.scheduled_start ELSE NULL END,
      scheduled_end   = CASE WHEN r.id IS NOT NULL THEN r.old_end        ELSE NULL END,
      placement_exception = NULL,
      runtime_schedule_mismatch = TRUE,
      updated_at = now()
    FROM (SELECT id FROM orders) a LEFT JOIN running r ON r.id = a.id
    WHERE o.id = a.id AND o.planning_status <> 'needs_planning';
    DELETE FROM order_schedule_segments s USING orders o WHERE s.order_id = o.id AND o.planning_status <> 'needs_planning';
    INSERT INTO schema_migrations (id) VALUES ('backward_scheduling_cutover');
  END IF;
END
$mig$;
```
Column names verified by Task 0 (c4). A plant with no `timezone` falls back to UTC here; the runbook (Task 4.3) gates the cutover on profile Q15 = 0 such plants (OQ52 d), so the fallback never decides a real row. Consequence (verified against Phase 2's read rule): every non-queued row now reads as never placed (due date = finish on the wire) except running rows, which keep their start **and** their old end; the Phase 2 reconcile (Task 2.6, with `reason:'cutover'`) derives all of them on the first load of each plant under the new image, in the OQ53 order (running rows hold their start and may move their finish later), and the first Save persists them. Every row's version moves, so the cached-edit overlay (`persistence.mts:885`) skips every row: no online-path discard is needed. **The `schema.sql` mirror of this ledger-guarded block runs once on any developer database that re-applies `schema.sql` (it nulls local placed finishes and segments once); say so in `docs/DEPLOYMENT.md` and `docs/MIGRATION.md`.**

- [ ] Step 1 test (fleet must include: running row whose due date is already past → keeps start and end; running row with future due → keeps start and end; future placed → both NULL; never placed → untouched dates, flag TRUE; queued → untouched; split → segments deleted; firmed → flag TRUE, firm kept; marked → `placement_exception` NULL; distribution family) → 2 `python -m pytest tests/test_backward_cutover.py -q` (FAIL) → 3 write files + schema mirror + pinned-list entries in `tests/test_schema_idempotent.py` → 4 PASS; `python scripts/schema_bootstrap_smoke.py` PASS (the smoke's sentinel order is seeded after `schema.sql`, when the ledger id already exists: assert it is untouched) → 5 commit `feat(migrations): backward-scheduling cutover — null placed finishes, keep running starts and ends, flag every order stale`

### Task 4.2: Cutover image client bits

**Model:** Sonnet
**Files:** `frontend/platform/foundation.mts:144` (`SCHEMA_VERSION: 7` — §8.6a option a; the offline fallback is lost once, accepted. **Task 0 note B5:** OQ36 chose "operational notice only"; the bump is a logged gap decision (Appendix C) and the planner notice names it: unsaved offline edits in a pre-cutover cache are discarded), Task 2.6 reconcile (first-load cutover counts: the batch Toast reads "N bars re-anchored on due dates, M reversed from now, K kept their running start, J blocked — Save to keep", key `toast.cutover_summary`, shown when more than 50 % of a plant's rows were stale), `frontend/nimbus-intelligence.js` Time Machine (no code: the planner notice says "do not restore a snapshot dated before the cutover" — §8.7a option a), `docs/DEPLOYMENT.md` cutover section.
- [ ] Tests: persistence cache discard on version 6 → 7; toast text keyed in 5 locales. Commit `feat(shell): cutover summary toast; cache schema version 7`

### Task 4.3: Cutover runbook (written into `docs/DEPLOYMENT.md` by Task 4.2; **not executed in this run** — owner decision "deploy nothing", 2026-10-13)

- [ ] Merge `feature/backward-scheduling` into `main` by PR (one merge; CI green). Pending migration set on the pilot must then be exactly: `2026-10-16-1-orders-placement-exception.sql`, `2026-10-20-0-…snapshot.sql`, `2026-10-20-1-backward-cutover.sql` (read `migration_files_applied` first; `-DryRun` shows apply order). **Task 0 ruling (Global Constraint: one destructive file per `-AllowDestructive` run; spec 7.8 #9): three separate runs, in order — (1) `2026-10-16-1` alone with `-AllowDestructive` (additive ALTER, inert to the old image; may run days before the window), (2) the snapshot file in a plain run (no destructive word in it), (3) the cutover file alone with `-AllowDestructive` inside the window. Never one run for all three.**
- [ ] Gate (OQ52 d): profile Q15 = 0 plants without a `timezone` on the pilot before step (3); the cutover SQL falls back to UTC for such a plant and must never have to.
- [ ] G-10 part 2: fresh pilot dump → local restore → apply the three files twice with explicit `-PgHost localhost` → run `uvicorn` against the copy → open each plant in a browser → record the reconcile toast counts per plant → owner reviews.
- [ ] G-9: build the image **before** the migration (`az acr build` under a fresh tag; CI green for that commit; record the previous tag as rollback target). Hold the roll.
- [ ] G-11: quiet window from profile Q12; planner notice (save and close tabs; hard reload after; do not restore old Time Machine snapshots; every bar will move to its due-date position; late warnings will fire); `NIMBUS_SAP_STAGING_POLL_SECONDS = 0`; all `sap_sync_config.apply_mode = manual`; Excel uploads frozen; outbound `ready` queue count zero per plant (operator-run statement from §8.13 step 1 with the owner's go).
- [ ] Pre-roll capture (alerts by type, tiles, utilization 14 d, Late filter count) per plant.
- [ ] Apply the cutover file (run 3 above) through `promote-azure` with `-AllowDestructive` (exit 3 = stop); runs 1 and 2 precede it as separate invocations. G-6 here = row count updated equals the non-queued order count.
- [ ] Roll the image; cache-busted verification of `NIMBUS_BUILD_ID`.
- [ ] Operator opens each plant once under the new image (admin tab), lets the reconcile run, records the toast counts, presses Save. Expect a stale answer only if a tab was left open.
- [ ] G-12 go/no-go by the named decider; then planners resume. Post-roll watch per §8.13 step 6 with the owner's N values.
- [ ] Rollback matrix per §8.8 + 8.8a: image-only until the first Save; after that, snapshot restore (operator-run, loses later edits). Retire any `ready` outbound rows at rollback.
- [ ] Later, per plant, in its own window: SAP staging first apply (OQ10); its reset nulls placed finishes where SAP's dates differ, and those rows re-derive from the due date on the next load by the same path.

---

## 5. Model assignment summary

| Task | Model | Why |
|---|---|---|
| 0 (plan audit, see 0.4) | Sonnet | fresh-eyes check of this plan against §1.6/§12 before any code |
| 1.1–1.7, 2.1–2.7, 3.1–3.5, 4.1–4.2 | Sonnet | data-destructive, contract-defining, or cross-cutting |
| 1.8 (purge preview one-liner), 1.9, 2.8 locale rows + docs, 3.4 locale rows, 3.6 docs | Haiku, Sonnet-reviewed before commit | pinned text, mechanical, reversible, a test or reviewer catches a miss |
| Every reviewer | Sonnet (fresh context, diff + task text only) | never the implementer's summary |

### 0.4 Task 0 — plan audit (runs first)
**Model:** Sonnet. Read spec §1.6, §12 and §7, then this plan. Report: (a) any §1.6 decision with no task; (b) any task that contradicts an owner decision; (c) any `file:line` that no longer resolves (HEAD may have moved). Orchestrator fixes the plan before Task 1.1. No code.

---

## Verification (end-to-end)

- Per task: the scoped commands in each task; `npm run build` after any `.mts` edit.
- Per phase: `npm test`, `python -m pytest tests/ -q` (local Postgres, `NIMBUS_TEST_DB=1`), `npm run lint`, `npm run check:static-assets`, `npm run check:legacy-surface`.
- Phase 1 live: cache-busted `GET /tasks` after the roll; `original_end_date` for a known never-sent row equals its as-sent SAP finish; lateness tiles change, bars do not (except profile-Q1 rows).
- Phase 4 rehearsal (G-10 part 2) is the only end-to-end run of the cutover before the real one; the browser pass over each plant on the restored copy is the acceptance test.
- Manual browser checks owed after Phase 2 (Phase 0 item e): drag body → finish held; right-edge resize → finish moves; left edge locked; firmed drop outside hours → confirm → marker shown.

---

## Appendix A — Things learned along the way

**Environment**
- HEAD `0317dd8` on `main`; the only commit since the spec's anchor commit `757dd86` is docs-only; no code anchor in §4–§8 has moved (three independent verifications, 2026-10-13). Working tree: `.dockerignore` modified, two root review docs staged for deletion, the spec and an FSD `.docx` untracked.
- Local Postgres 18 is up (`pg_isready` ok). The verification agent was denied read access to `.env`; confirm `PG_HOST=localhost` and `NIMBUS_TEST_DB=1` before Task 1.1 (pytest refuses to collect otherwise, by design).
- Python runs from the repo `.venv`, not a bare `py`.

**Corrected spec claims (anchor drift found while planning)**
- "Machine Hours rule and the 168 h check at `db.py:3887-3892`": that range is the generic chunk-failure `except`. The Machine Hours rule is `db.py:4141-4158`; **there is no 168 h check in db.py** — the bound lives only in `schema.sql:121`, the two 2026-09-25/26 migrations and `models.py:277-278`.
- `backend/distribution/data.py:3719-3800` (`_resolve_machines`) is a **fourth** header-due-date writer the spec's OQ29/§4.7.6 lists omit (writes the header from the plain order's possibly client-rewritten `basic_finish_date`). Covered in Task 1.3.
- `Util.scheduledEnd` (`foundation.mts:616-619`) and `orders.mts:200` are lateness/due readers §4.6.3 omits. Covered in Task 1.5.
- `tests/test_sap_staging.py:292` pins today's blank-finish acceptance and is not in the spec's FLIP list; it flips under OQ24. Covered in Task 1.4.
- The dead legacy optimizer walk is `engine.mts:2357-2619`, not "~2262-2619" (2262 is inside the live apply branch).
- `SCHEMA_VERSION` is `foundation.mts:144`, read by `persistence.mts:1210-1212` and `1902`.
- `nimbus-compute-core.d.ts:28-32` lists 18 alert types and lacks `distribution-separation`; `types.mts:469-475` lists 19. They already disagree.
- The save prefetch (`db.py:1282`) and the conflict scan (`1049`, `1056`) use `_EFF_END_SQL` while `/tasks`, refresh and Send use the mismatch-hold variant; §8.4 lists the copies but not this read/save disagreement. Task 2.2 collapses them.
- `engine.mts:2782-2790` listens to `tasks:bulkUpdate` with source `'refresh'` (the concurrency refresh), not a "conflict refresh".
- No mismatch-flag clearing exists in `persistence.mts` (the spec's `~1423` is the `schedule_segments` payload key); clearing is server-side (`db.py:1585→1128-1129`) and in `engine.mts:1268`.
- `backend/integration/AGENTS.md:72, 126` are the twins the §11 lists mean by "AGENTS.md"; the root `AGENTS.md` lines are blank.

**Design choices made in this plan (not in the spec)**
- The locked SAP dates reuse the existing wire names `original_start_date`/`original_end_date` (served with a fallback to `basic_*`); the Phase 1 "repair" is therefore a backfill of the new columns and never rewrites `basic_finish_date`.
- `placement_exception` ('overtime' | 'overlong') is the single per-order marker for OQ50 + OQ63 and the one new `TaskDTO` field.
- The run-time cap is enforced in application logic (a flat 336 h, planned as `min(336 h, horizon)` and simplified by senior review U5 → Needs Planning); the DB check becomes a representation bound (`< 8760`), because a 400 h order could not otherwise be stored at all.
- The cutover nulls `scheduled_start` too (except running rows) so that a date-only due date is read through the OQ23 window rule by the browser rather than as literal midnight from the server.
- OQ27 lookback: fixed 30-day window now (option e); the finish-indexed select (option f) is deferred.
- Forward calendar helpers (`nextAvailable`, `allocateRuntime`) are not converted to plant-zone arithmetic; **only the backward walk is** (Task 0 correction: the reversal forward leg reuses the untouched forward helpers on naive wall-clock, so a reversed order across a DST change can drift by one hour of elapsed time — accepted, rare, logged). The divergence is the spec's own accepted one for retained forward paths; recorded for `docs/MIGRATION.md`.
- Task 0 audit (2026-10-13, Sonnet, `.superpowers/sdd/.../task-0-report.md`) found 11 half-covered decisions, 5 contradictions, ~25 drifted anchors and 12 implementability defects; every one is ruled on in Appendix C (G-0.x) and folded into the task text above. Headline corrections: `plants.plant`/`planning_status='needs_planning'`/`segments.scheduled_end` (not `plants.id`/`planning_state='queued'`/`end_date`); the compute core is an uncompiled UMD; `finish_echoes` cannot live in `sap_staging.py` (circular import); every new migration file must be added to the pinned list in `tests/test_schema_idempotent.py`; there is no plant planning-horizon setting (the 35 days is a constant).

**Pre-existing defects fixed on the way (A.3 numbers):** 1, 2, 4, 5, 6, 7, 9, 10, 13, 14, 15, 16, 18, 23, 25 (partly), 26 (partly). **Left open:** 3 (echo flips validity — mitigated by OQ26's locked start), 8 (dead echo shield — removed), 11 (first Send of an untouched aggregate — moot under OQ61), 12, 17, 19, 20, 21, 22, 24 (midnight staleness), 27, 28, 29, 30 (snap loop deleted).

**Open questions for the owner (do not block Phase 1)**
1. Which plant setting is "the planning horizon" for the 336 h cap (Phase 0 item i; plan assumes the optimizer horizon, 35 days default).
2. Delete the unreachable evaluator labels `throughput` / `due-date-first` with the dead walk, or keep (plan keeps; §4.8.3a).
3. Whether the vis-timeline left resize handle can be hidden (Phase 0 item e); the plan falls back to revert-with-toast.
4. Group 32's reworded-key list is pinned to the keys named in §10.5; any further rewording in Task 3.4 extends it.
5. The SAP echo tolerance for the locked-column match (minute precision, SAP frame) assumes assumption A9 holds; blocker 18's real-SAP test may change the compare rule in `finish_echoes` only.

## Appendix C — Gap decisions and gate reports (filled during execution)

Every routine decision the plan did not spell out is logged here as it is made (task, gap, choice, why, where it shows), and the same entries are appended to `BACKWARD_SCHEDULING_MIGRATION.md` under "Implementation log and gap decisions (2026-10)". Each phase ends with a gate report: commands run, pass/fail counts against the baseline, tests flipped or added, review findings and their fixes.

### Task 0 — plan audit rulings (2026-10-13)

Audit: Sonnet, report at `.superpowers/sdd/2026-10-13-backward-scheduling-implementation/task-0-report.md`. Each ruling below was folded into the task text above; the plan text is the binding version.

| # | Task | Gap found | Ruling | Why | Shows in |
|---|---|---|---|---|---|
| G-0.1 | 1.2 | `finish_echoes` in `sap_staging.py` makes `db.py → sap_staging` a circular import | define in `db.py`, re-export from `sap_staging.py` | `sap_staging.py` imports `db` at module top; one definition for three callers | import path only |
| G-0.2 | 1.5, 3.3 | `nimbus-compute-core.js` is an uncompiled UMD; `export function` and "mirrored by the build" are wrong | add helpers to the UMD return object, hand-mirror `.d.ts` | the worker `importScripts` the file | code shape only |
| G-0.3 | 1.1, 1.6, 2.3, 4.1 | `tests/test_schema_idempotent.py` pins the exact migration file list | each new migration file is added to the pin in the same commit (Global Constraint) | otherwise every migration commit is red | tests |
| G-0.4 | 1.6, 2.2, 2.3, 4.1 | plan used `planning_state = 'queued'`; real column is `planning_status = 'needs_planning'` with a CHECK forcing NULL dates | corrected everywhere; queue writers null both dates and delete segments | schema fact | SQL |
| G-0.5 | 1.6 | no plant "planning-horizon setting" exists (35 days is a constant) | `cap_hours = min(336, visibility_horizon_days×24)` when that nullable column is positive, else 336 h (superseded by senior review U5: flat 336 h) | only existing per-plant horizon-like setting; one function to change if the owner names another | Needs Planning reason, 422 on planner edits |
| G-0.6 | 1.6 | OQ28 cap applied only at ingest; a 7,000 h planner edit would pass the widened 8760 bound | the same cap rejects planner run-time edits in the bulk route (`run_time_over_cap`) and queues resolver recomputes | owner: "an order with more than the cap goes to Needs Planning" | planner sees a rejection toast for over-cap edits |
| G-0.7 | 1.2 | test (a) used New York (UTC-4): 19:00 Thu local = 23:00 UTC Thu, so no echo — the test would fail against a correct rule | M1 case uses `America/Chicago` (the spec's own example); New York variant added asserting no echo | arithmetic | tests |
| G-0.8 | 1.2, 2.7 | start-only SAP change "refreshes `original_start_received`" contradicts OQ26/OQ31 (locked on echo) | on an echo both locked columns stay; the start refreshes only when the finish is not an echo | OQ26 example: SAP back-scheduling its start after an echo must not move "first received" | due/start columns |
| G-0.9 | order | Task 1.2 before 1.4 would lock hygiene-fabricated finishes in tests | execute 1.4 before 1.2 (numbers unchanged) | locked columns must hold as-received values | none |
| G-0.10 | 1.3 | header echo judgement undefined; date-only flag not carried into `parent_facts` | header uses any member child's sent roll-up end; flag carried | `order_sap_sent` is keyed per child id with the roll-up end | distribution echo |
| G-0.11 | 1.4 | `sap_staging.py:392-397` has no rewrite; `test_finish_column_absent` not flipped; renamed counter label needs 5 locales | fix the shared hygiene function once; flip the test; add the key in all locales | anchor facts, ratchet | admin diagnostics label |
| G-0.12 | 1.5 | delete list included the live working-hours snap (`persistence.mts:578`, `calendar-sync.mts:250`) — Phase 1 would move bars | keep the snap until Task 2.5; delete only the due-date phase, `_dueEndOfShift`, the relay, the pristine capture | Phase 1 promise: no bar moves | none in Phase 1 |
| G-0.13 | 1.5 | `Util.sapDueDate` layering (platform cannot import `Calendar`) and per-row cost | day window via the compute core's helper over `Store` calendar rows, cached per line+date | existing `foundation.mts:473` route; `latenessHours` runs in grid filters | none |
| G-0.14 | 1.7 | `_outbound_candidate_rows` has no `frozen_end` | firm filter in `build_outbound_groups`, where `firm_flag` already runs; aggregate roll-up end unchanged | code shape | Send summary `skipped_unfirmed` |
| G-0.15 | 2.1, 2.4 | `plantWallClockFromInstant` is private to `engine.mts`; `Store.plantNow` needs it | move it and its inverse to the compute core UMD in 2.1; engine keeps wrappers | platform layer cannot import optimization | none |
| G-0.16 | 2.2 | `_EFF_END_SQL` already exists with 12 call sites; purge selector and resolver SELECT lists unlisted | redefine in place; every caller joins the segment lateral; purge selector reads `COALESCE(scheduled_end, original_finish_received, basic_finish_date)`; resolver lists extended | contract change must reach every reader | purge preview counts |
| G-0.17 | 2.2, 2.3 | `placement_exception` had no read projection | add to `_ORDERS_SELECT`, refresh SELECT, `TaskVersionRow`, DTO | the one new wire field must be served | wire |
| G-0.18 | 2.3 | naive width validator rejects Task 2.1's own DST case (Chicago 5 h run, 6 h naive width) | width measured in plant-zone elapsed time via `zoneinfo` when the plant has a zone | 24/7 bars across DST are legal | none |
| G-0.19 | 2.3 | routing one-time cutover branch (`resolver.py:825-829`) vs "flag on any run-time change" | delete the cutover branch; the general rule subsumes it | OQ34 a: redefinition replaces the marker | none |
| G-0.20 | 2.5, 2.6 | `finishAnchoredPatchFor` resolved `reached_now` internally, but the reconcile must batch reversals per line | `opts.deferReversal: true` returns `{kind:'reached_now'}` unresolved | OQ53 b ordering | reversal order |
| G-0.21 | 2.5 | callers `gantt.mts:4389`, `orders.mts:1378`, Override `orders.mts:1517` still pass a start | all three switched in 2.5; the Override modal's date input becomes the finish in 2.5 (field + keys), 3.4 keeps the rest | a start passed into a finish parameter would misplace bars | Override modal shows "Planned finish" |
| G-0.22 | 2.6 | selection dirtied every never-placed row on every load | never-placed, non-stale rows derive for display only (non-dirty source); stale-flagged rows (and every row after the cutover) get dirty patches | today's snap is display-only; cutover persists by owner choice; Review Focus 2 holds | Save button state |
| G-0.23 | 2.6, 3.3 | 2.6 never set `derivationIssue`; plant-level conditions had no per-task field | 2.6 sets it on every touched or skipped task; worker de-duplicates plant/line codes; new codes `frozen_window_crossed` (OQ4 a), `run_time_zero` (OQ13); `reversal_forward.detail` ∈ {run_time_grew, due_date_past, cutover} for OQ56 a | alerts must come from the worker | Alerts panel |
| G-0.24 | 2.7 | `start_derived` had no model edit; bulk-route flag vs validator precedence unstated | add to `BulkUpdateResult` + types; the bulk route passes `trust_start=False` and skips the validator | OQ59 b | API types |
| G-0.25 | 3.1 | nothing made the optimizer, Remove Backlog, autoReflow or alert Fix skip `placement_exception` rows (OQ63); forward `'overlong'` on a `never` plant still drew a bar (OQ50 c) | marked rows are fixed like firmed-under-respect regardless of the toggle; forward overlong on `never` → Needs Planning `overlong_never` | owner decisions are explicit | optimizer leaves marked bars |
| G-0.26 | 3.3 | `dayByLine`/`todayByLine` deletion misses the characterization pin and insights docs | both added to the task | test would fail | none |
| G-0.27 | 3.4 | OQ16 field-visibility setting naming the retired column | `_fieldHidden` ignores unknown ids like layouts do | consistency | none |
| G-0.28 | 3.5 | collapse carry as written was OQ37 R1 (rejected) | carry start + full run time as the stored end, keep start, flag stale (R2 as accepted) | owner accepted R2 | survivor bar ends where the planner saw it |
| G-0.29 | 4.1 | wrong column names, wrong timezone expression, running rows lost their end (late running order would be re-derived from the past due date) | SQL rewritten; running rows keep start **and** old end | OQ3/OQ5 | running bars untouched at cutover |
| G-0.30 | 4.1 | `schema.sql` mirror of the cutover runs once on any re-applied developer DB | accepted; documented in DEPLOYMENT.md/MIGRATION.md | ledger guard makes it one-time | docs |
| G-0.31 | 4.2 | `SCHEMA_VERSION` bump vs OQ36 "notice only" | keep the bump, name it in the planner notice | one-time loss of an offline cache is cheaper than serving pre-cutover rows | planner notice |
| G-0.32 | 4.3 | three migration files in one `-AllowDestructive` run | three runs in order; Q15 = 0 no-zone plants gate | Global Constraint; OQ52 d | runbook |
| G-0.33 | App. A | "reversal leg is plant-zone" was wrong | only the backward walk is; forward leg naive, DST drift accepted | forward helpers untouched by design | none |
| G-0.34 | 1.4 | OQ45 a per-upload counts (derived starts, repaired finishes, reversals) | Phase 1 shows the dropped-row counters only; derived/repaired counts are moot (no server derivation); reversal counts live in the 2.6/4.2 toast | nothing to count server-side | admin diagnostics |

### Phase 1 — gap decisions (2026-10-14)

Copied from the implementation ledger (`.superpowers/sdd/2026-10-13-backward-scheduling-implementation/progress.md`): every line that starts with `Task 1.N: gap filled:` or is a `Ruling:` for a Phase 1 task. The Task 1.1 to 1.4 rows come from the composite ledger lines and the task reports' gap sections, because those tasks logged their gaps inside one line or in the report.

| Task | Gap | Choice | Why |
|---|---|---|---|
| 1.1 | `TaskVersionRow.original_end_date` type (the brief said a datetime or None) | a string or None, like `original_start_date` and every other date on that model | the DB layer already emits strftime strings; a `datetime` field would serialise differently and give an inconsistent generated type |
| 1.1 | brief named only the finish for the distribution child read | both `basic_start_date` and `basic_finish_date` output keys now read the locked columns (key names kept) | the pane maps both keys to `original_*`; `orders` has both locked columns |
| 1.1 | refresh row's `original_start_date` | also reads `COALESCE(original_start_received, basic_start_date)` | the brief says every projection that emits an original start or end follows the wire rule |
| 1.1 | owner list query wording ("sent rows that differ") | lists sent orders where `basic_finish_date` differs from the SAP baseline or from the sent finish | the reading that surfaces rows whose due date NIMBUS may have overwritten |
| 1.1 | backfill block placement in `schema.sql` | at the end of the file; the three column statements sit with the `sap_basic_*` columns | the backfill reads `order_sap_sent`, created late in the file |
| 1.1 | `scripts/schema_bootstrap_smoke.py` exits 1 (the brief asked it to pass) | parked as pre-existing: it fails identically on the commit before Task 1.1 | a fingerprint drift on `run_time_source` unrelated to this work; the CI gate was already red on `main` |
| 1.2 | the SAP zone inside `sap_changed_fields` and `upsert_orders` | optional `sap_tz` argument; `None` means the plant's frame (Excel); the staging apply passes `SAP_SYSTEM_TZ` | the Excel path has no SAP zone of its own; `db.py` does not import `sap_staging` |
| 1.2 | the Excel path cannot say a finish is date-only | inferred from an exact 00:00:00 when the row carries no date-only flag | one place (`_row_finish_echo`) both consumers read, so they cannot drift |
| 1.2 | an echo whose stored original is NULL | carry the incoming value, per column | nothing stored to keep; the backfill makes this rare |
| 1.3 | the brief's "siblings reset" RED no longer reproduces after Task 1.4 | kept the brief's test and added tests whose RED is real (header original finish missing; re-weight rewriting a child's baselines) | after 1.4 the header finish equals the received finish, so the green is not proof of a reproduced reset |
| 1.3 | the echo judgement needs the SAP zone inside `apply()` | `apply(..., sap_tz=None)`, passed by `upsert_orders` on the SAP path only | a plan-dict key broke a contract test that pins the plan structure |
| 1.3 | planner writes versus ingest writes in `_apply_children` | `parent["_ingest"]` mark set by `apply()` instead of a new parameter | tests that patch `_apply_children(cur, parent)` keep their signature |
| 1.3 | `order_distribution` has no start column | a planner-created child inherits the earliest locked start of its living siblings, else the header's `basic_start_date` | no header original start exists to inherit |
| 1.3 | `_resolve_wc_codes` was not in the brief's line list | its synthetic rows carry the plain order's locked dates and baselines | otherwise a client-rewritten `basic_finish_date` would be locked as the due date |
| 1.3 | standalone `plan()` + `apply()` used to default `sap_basic_*` from `basic_*` | NULL unless the row carries them; the next upload fills the baseline without counting as a change | real ingest through `upsert_orders` always carries them |
| 1.3 | `_row_finish_echo` signature | extra `finish_key` argument | the ingest row and the before-image name the finish differently |
| 1.3 | header echo across a distribution family | judged by any member child's sent finish (`_header_finish_echo`, one extra query per parent) | `order_sap_sent` is per child; the one-cycle gap after collapse or 1-to-N is the accepted OQ29 gap |
| 1.4 | `dropped_no_*` counters were never incremented | both start and finish counters bumped inside `_date_hygiene_df`; the finish counter also on a finish dated before the start | one place covers the Excel and SAP staging paths |
| 1.4 | the finish counter was never shown | new cockpit row "Dropped (no finish)", DB Load turns `warn` on either counter, key `ui.diag_dropped_no_finish` in all five locales | there was no prior key to rename |
| 1.4 | pandas infers one format and turns the rest to NaT | `_parse_finish_dates` retries missed values with `format="mixed"` | a row is now dropped on NaT, so a mixed-format column would otherwise lose rows silently |
| 1.4 | naming the dropped rows | the warning lists up to five order numbers plus "+N more" when an order column exists | the start warning text is pinned by a test and left unchanged |
| 1.4 | a test relied on the derived finish shape | re-seeded through SQL (the test was deleted in Task 1.5) | preserves what it checked until the relay it covered was retired |
| 1.4 | the unparseable-date warnings in `upsert_orders` | left untouched | only the non-live SAP sync stub can still reach them |
| 1.5 | platform cannot import Store/Calendar | new DI seam Util.setDueCalendarResolver wired in app.js (rows from Store, rev = Store.rev()) | same pattern as the other four seams, no legacy-surface growth |
| 1.5 | per-batch caching of the day window | per line+date cache invalidated on Store revision change | per-row callers stay O(1) with no staleness |
| 1.5 | missing plant hours | use the line window alone (no default 7-19) | brief only defined the missing line calendar case (raw + 23:59:59) |
| 1.5 | worker jointWindowForDay defaults missing calendars to 7-19 | separate ctx._dueWindow memo returning null for a missing line row | keeps worker and main thread consistent with ruling (b) |
| 1.5 | dueTimestamp had no snapshot access | required DueScope {snapshot, plant?, ctx?} param at all 12 call sites | compiler-enforced, no module-level mutable state |
| 1.5 | Engine.earliestAllowedStart/latestAllowedEnd | routed through the same dueInstant (sourceDueInstant) | otherwise Engine and worker bounds disagree and the tighter silently wins |
| 1.5 | brief's "pristineOriginalStart cache restore (890-891)" is actually the cached original_end_date restore in _overlayUserMoves (pristineOriginalStart is the capture in the snap) | removed both | a stale cached due must not override the server's locked SAP finish |
| 1.5 (Ruling) | optimizer pull-forward floor / push ceiling on a closed due day now follow the OQ23 window rule (Sunday due, N=0 → floor Fri 00:00, ceiling Sat 00:00) | accepted as the spec's consequence, optimizer-only, to be named in the Phase 1 gate report and the owner report | cost if wrong: optimizer places some orders one weekend earlier than before Phase 1 |
| 1.6 | brief's "422-style" bulk rejection | reused the existing per-id envelope (invalid_ids + rejection_reasons[id]='run_time_over_cap', HTTP 200) | a 422 would reject the whole batch and the save path already renders rejection_reasons per id (toast needs no new key; ui.reject_run_time_over_cap added) |
| 1.6 | migration split across two files in the 2026-09 pair | one file/one transaction (DROP + ADD NOT VALID + VALIDATE + ledger row) | widening cannot fail validation and a split would leave a window with no constraint |
| 1.6 | releasing a queued over-cap order | added run_time_over_cap to the resolver's _is_routing_hold vocabulary and a symmetric release in the ingest queue step (never releases/overwrites another hold reason) | each run-time owner releases only its own reason |
| 1.6 | row number for >=8760 rejection | check runs before date hygiene resets the index (row = index+2); also rejects negative/non-finite values | matches the Excel row the planner sees and those values would fail the chunk at the CHECK too |
| 1.6 | running order over the cap | not queued (only when it holds a slot), counted as running_kept in the upload warning | honours the SAP-truth rule that an upload never un-schedules a running order |
| 1.6 | localised reason label | reason JSON carries run_time/cap_hours and orders.mts renders planning_reason.run_time_over_cap via the locale for this code (server English message remains fallback) | same pattern as planner_unscheduled |
| 1.6 | plant cap lookup in update_task_dates_bulk | lazy per-plant query (_plant_caps) instead of widening the locked eff-row SELECT | keeps fake-cursor tests that pin that row shape untouched |
| 1.6 (Ruling, flagged) | whether a queued run_time_over_cap row can re-enter the schedule via a date-only edit/optimizer | owned by Phase 2 Task 2.5 (Needs Planning release path: run_time_over_cap releases through finishAnchoredPatchFor; queued rows are excluded from reconcile/optimizer intake); no Phase 1 action | cost if wrong: an over-cap row could be dragged back onto the Gantt before Phase 2 ships (planner-visible, reversible) |
| 1.6 (Ruling) | migration header wording ('the brief for this task asked for exactly this') | reworded by Task 1.9 (docs/Haiku) together with the other durable-text nits | cost if wrong: none |
| 1.7 | summary shape for skipped_unfirmed | build_outbound_groups now returns a 3-tuple (groups, skipped_no_end, skipped_unfirmed) and callers/tests updated | the pure function is the only place that knows which groups were dropped |
| 1.7 | unit of skipped_unfirmed | counted per planned order (group), not per child row | matches "queued" semantics; firmed-but-no-end counts only in skipped_no_end |

### Phase 2 — gap decisions (2026-10-14)

Copied from the implementation ledger (`.superpowers/sdd/2026-10-13-backward-scheduling-implementation/progress.md`): every line that starts with `Task 2.N: gap filled:` or is a `Ruling:` for a Phase 2 task (Tasks 2.1 to 2.8), one row each, in ledger order. For a Ruling, Gap is the situation, Choice is what was ruled, and Why is the stated reason followed by its `Cost if wrong:` line, copied from the ledger; where a ruling states no reason, the Why cell is only the cost line. The Phase 2 gate ruling in the ledger (no separate whole-branch review before the Phase 3 gate) is not a task ruling; it is listed last, as "Phase 2 gate".

| Task | Gap | Choice | Why |
|---|---|---|---|
| 2.1 | _freeIntervalsBackward order | chronological (allocator walks from the end) | matches forward _freeIntervals |
| 2.1 | reason when several causes apply | the last cause reached names the move (no_slot_at_finish / min_piece override closed_finish / blackout) | the later cause explains the final distance |
| 2.1 | overlong test | run time vs longest merged nominal window (blackouts ignored, finish window measured whole) | mirrors forward hasNominalWindow and avoids false overlong from a clipped window |
| 2.1 | overlong_only with an overlong order | returns overlong (forward splits) | brief says overlong for never and overlong_only; caller decides OQ50 |
| 2.1 | lookback/floor exhausted with windows present but no capacity | reached_now | brief's unavailable means no window at all; lets the caller try forward from now |
| 2.1 | invalid run time or unusable timezone | unavailable | union has no exhausted kind; non-throwing, non-placing is conservative |
| 2.1 | latestAvailable snapping | minute-level only, no 15-minute snap | second snap would break start + run time = finish |
| 2.2 | client visibility key (brief says original_start_date) | BASIC_START_DATE ?? original_start_date | original_start_date is the calendar-snapped display baseline, BASIC_START_DATE is the raw copy of the locked wire start |
| 2.2 | runtime-client.mts:192 | kept BASIC_START_DATE-first precedence, added comment + node pin | it already reads the raw copy of the wire locked start, switching to the snapped field would diverge from the server |
| 2.2 | _EFF_END_SQL has no queued CASE | added _EFF_END_UNLESS_QUEUED_SQL for wire/refresh/prefetch/distribution readers | replaces four inline copies |
| 2.2 | dup sort key finish fallback | module-level _duplicate_id_sort_key, finish used only when start is None | rows with a start must sort as before or ingest ids permute |
| 2.2 | _load_setup_coverage order key | _EFF_START_SQL (queued rows sort last per machine) | brief says order by _EFF_START_SQL |
| 2.2 (Ruling) | plan text mandated _EFF_END_SQL for neighbours, which makes a never-placed row occupy [SAP start, due date] | the scan's neighbour set is restricted to _PLACED_SQL rows (never-placed and queued rows cannot conflict server-side; the browser's overlap alert still covers display overlaps) | a conflict is between placements, and OQ33 A gives a never-placed row no server placement Cost if wrong: a server-side overlap against a never-placed row goes unreported (client alert remains). |
| 2.3 | browser always sends schedule_segments (`[]` when continuous) | width gate applies to any continuous saved shape (no segments, [] or one piece), segments ≥ 2 keep the segment rules | otherwise the validator never runs from the real client |
| 2.3 | marker precedence for the width gate | item's value if sent (None clears), else the stored one | explicit null re-enables the check, a marked bar leaves the flag untouched |
| 2.3 | single-edge rejection reason | `single_edge` (+ `width_mismatch`) translated in 5 locales | describeRejections shows plain language, not raw codes |
| 2.3 | zero run time | width gate does not apply | a bar cannot have zero width |
| 2.3 | trust_start=False (Task 2.7) | no parameter added, gate is one block in the validation loop | avoids dead code, a keyword arg can gate it later |
| 2.1 (Ruling) | optimize-ui.test.mjs regression (first bad 2f2ec27) | is fixed as Task 2.1 fix round 1 (test bootstrap line only, matching the other optimization test files) — the wrapper keeps reading the compute-core global (one code path) | Cost if wrong: another future Node test importing engine.mjs alone hits the same hazard; mitigated by the comment the fix adds. |
| 2.3 (Ruling) | plan text implied the gate on every non-segment save | skip the gate when the sent start/end equal the stored RAW scheduled_start/scheduled_end (both non-NULL) and the run time is not changed; width_passed stays False so runtime_schedule_mismatch is untouched; compare raw columns (never the effective/SAP-fallback edges) so an unplaced row's SAP window can never be stamped as a placement | a planner's PRT/machine-only edit on a stale bar the engine could not re-derive (no zone / no calendar) must not be rejected Cost if wrong: a legacy mismatched bar can be re-saved unchanged (flag stays TRUE, so the reconcile still re-derives it). |
| 2.4 | where blocked plants are recorded | Store._blockedPlants Set + one toast per plant from Store.plantNow | simplest shape; Task 3.3 reads the Set for the alert |
| 2.4 | plant not yet in master data | plantNow returns null without recording or toasting | avoids a false no-timezone report before master data loads |
| 2.4 | optimizer liveClock for a blocked plant | keeps the viewer-clock fallback but records the plant | refusing to run is placement-blocking (Tasks 2.6/3.3) and would break many fixtures |
| 2.4 | Util.plantNowParts cannot import Store | Util.setServerNowResolver self-wired at the bottom of store.mts | no cycle, no app.js edit |
| 2.4 | compute-core payload now | Record<plant, Date> read per order plant, thread clock when absent | per-plant brief wording, other callers unchanged |
| 2.1 (Ruling) | optimizer-worker.test.mjs worker_threads realm failure | test-only (real worker imports the core first); fixed as Task 2.1 fix round 2 in the test bridge strings; no production change | Cost if wrong: none at runtime. |
| 2.5 | refusal channel for a null placement | Engine.lastManualRefusal + opts.quiet | callers must tell "engine already toasted" from "say something" and ask the overtime confirm without changing the return type |
| 2.5 | overlong_only policy with an overlong order | retry the backward walk as partial_allowed | Task 2.1 returns overlong but the forward allocator splits such an order |
| 2.5 | blocked plant for a rigid segment translation | translation never needs a zone, only derivation refuses | a translation is not a derivation |
| 2.5 | no Needs Planning release action exists | release happens through the machine/run-time/version edit surfaces on rows queued runtime_unknown/overlong_never/run_time_over_cap, anchored at Util.dueInstant | the only planner re-placement path today |
| 2.5 | alert placement_exception on release | not computed on the main thread, Task 3.3 reads the wire field | shared alert-plumbing rule |
| 2.5 | OQ3 at six run-time-edit sites | one holdStartIfRunning option inside the engine | routing machine moves still need the resolver path in manualRoutingSchedulePatchFor |
| 2.5 | label for overlong_never | planning_reason.overlong_never rendered in the Planning reason cell | matches run_time_over_cap |
| 2.5 | toast.commit_failed said "requested start" | reworded in all five locales | placement is finish-anchored now |
| 2.5 | dead calendar seam after deleting the snap | removed Persistence.setCalendarService, its interface and the app.js wiring | nothing else called it, legacy surface shrinks |
| 2.5 | left-handle veto | vis onMoving (lockLeftEdge) snaps a start-only drag back, commit-time revert + toast kept as fallback | possible and cheap, handle stays visible, not browser-verified |
| 2.5 (Ruling) | planner run-time/machine/version edits route through manualSchedulePatchFor | so a held finish that cannot be reached is refused with toast.finish_cannot_hold (same as a drop, OQ13 b) rather than accepting the walk's moved finish; the walk's own answer is reserved for system re-derivations (Task 2.6 reconcile, with the finish_moved_earlier alert) **[Corrected in the Phase 3 fix wave: the refusal applies only when the walk would move the finish EARLIER; a backward start before now reverses forward from now with `reversal_forward` (O2, OQ3, OQ7 a, OQ19 c).]** | Cost if wrong: planners must drag the bar to a reachable finish before changing run time/machine on a closed-day finish (reversible; owner can flip the reading later). |
| 2.5 (Ruling) | a Needs Planning release (overlong_never / run_time_over_cap) whose due instant is already past | is NOT a finishMoved refusal: the release has no held finish to protect, so reached_now resolves forward from now (reversal) and the row carries derivationIssue reversal_forward (detail due_date_past) | Cost if wrong: a late released order lands at now instead of being refused (planner-visible, reversible). |
| 2.6 | no server-calendar-row predicate | CalendarSync.hasServerLineCalendar reads the line_work_hours keys of GET /plant-calendar | the client default is never a server row |
| 2.6 | no calendar hydration state | per-plant _hydration (pending/hydrated/failed) in calendar-sync, hydrated set before the calendar:change emit | reconcile must never derive on default hours |
| 2.6 | no non-dirty source for task writes | new 'engine-runtime-reconcile-display' added to App._trackDirty skip list | never-placed rows derive for display only, Save leaves the server row never-placed |
| 2.6 | banner ui.derive_paused | #derive-paused-banner driven by Engine.derivePausedPlants | same band as the concurrency banner |
| 2.6 | run_time_zero "no bar" | row left as is plus derivationIssue run_time_zero | nothing can be placed |
| 2.6 | running row whose start the allocator would move | keep start, end = start + run time, no segments | start never moves and width equals run time for the server width check |
| 2.6 | frozen_window_crossed scope | manually firmed rows only | SAP firm is display-only and unfirmed never-placed rows would flood alerts |
| 2.6 | calendar cannot place a row | untouched + derivationIssue no_operating_window + error-log warn | visible instead of a silent stale flag |
| 2.6 | setupMinutes | FinishAnchoredOptions.setupMinutes passed as 0 | Task 3.2 only fills it |
| 2.6 (Ruling) | user_scheduled is a server wire flag the client never updated | any client schedule write that is not display/refresh (drop, edit, optimizer apply, release) sets user_scheduled=true locally and save success keeps it; the reconcile candidate filter also skips Persistence._dirtyIds | the dirty-vs-display split must never let a display derivation clobber or save a planner placement Cost if wrong: a row the planner edited is treated as placed for the session (safe direction). |
| 2.7 | /tasks/bulk_update trust_start caller list (Phase 0 item g unanswered) | optional request field trust_start: bool = True, forwarded in the item dict only when False, honoured by /tasks/update and /tasks/bulk_update | keeps every existing item shape and test pin unchanged; browser's own save never sends it |
| 2.7 | dropped_no_start_date cockpit counter | renamed unreadable_start_date, counts only unreadable (non-blank) starts, label reworded in 5 locales (ui.diag_unreadable_start) | rows are no longer dropped; a blank start is normal |
| 2.7 | malformed start on SAP staging | still invalid_date (Excel keeps the row with a warning) | 'start optional' means absent; a malformed value is corrupt data and the existing validator/builder already reject it |
| 2.7 | dates_echo vs planner slot | now in_f == scheduled_end only | the finish is the anchor, the start no longer decides |
| 2.7 | basic_start_date on a re-upload sending no start | COALESCE(EXCLUDED, stored) | NULL means not sent everywhere else in the upsert |
| 2.7 | new-child carry (1->N and re-weight) | copy placed finish (plain order's stored finish / latest sibling stored finish) as scheduled_end, start NULL, stale flag TRUE; no placed finish = child stays unplaced | OQ58 inference, no forward start+run_time write left in db.py/backend |
| 2.7 | GET /tasks drop-filter on NULL BASIC_START_DATE | keeps any row with a finish | otherwise a NULL-start never-placed order vanishes from the browser |
| 2.7 | start_derived shape | sparse {id: True} map of persisted ids on BulkUpdateResult (not on TaskDTO) | like rejection_reasons |
| 2.7 (Ruling) | /tasks/bulk_update default trust_start=True (the browser save is the main caller and sends starts it derived) | external callers pass trust_start=false to get the start flagged instead of width-checked; flipping the default waits on the Phase 0 item g caller list (owner question) | Cost if wrong: an external writer that omits the flag gets width_mismatch rejections instead of a flagged placement (visible, reversible). |
| 2.8 | baseline test_sap_staging::test_same_instant_batches_have_exactly_one_winner | instants made relative to now (date_trunc('second', now()) - 1 hour) | hard-coded 2026-10-07 fell outside the 7-day retention window |
| 2.8 | i18n parity | no edits needed | every Phase 2 key (and the reworded commit_failed/diag_unreadable_start) is already in all five locales with real translations; node --check clean; locale tests green inside npm test |
| 2.8 | status-only 'scheduled' save on a never-placed row (db.py guard) | rejected as rejection_reasons single_edge, guard reads the RAW stored edges + segment_count (not the SAP-window fallback) | consistent with Task 2.3 (never complete an edge from anything but what the planner sent; no new wire reason, no new locale key since ui.reject_single_edge already exists); a placed row's status-only save still passes and rewrites no edge |
| 2.8 | distribution header/child basic_start_date | COALESCE(incoming, stored) in the child upsert, header SET and header change-guard (guard uses %(bs)s::timestamp, Postgres cannot infer the bare parameter type) | matches db._UPSERT_SQL; pin drives _apply_children directly because the ingest seam writes children via db._UPSERT_SQL first, which made an upload-only pin non-discriminating for the child half |
| Phase 2 gate (Ruling) | whether Phase 2 gets its own whole-branch review | no separate Phase 2 whole-branch review: the plan puts the fresh whole-branch review at the Phase 3 gate (covers Phases 2+3); the Phase 2 gate = suites green + gate report | Cost if wrong: a Phase 2 cross-task defect waits until the Phase 3 review (same branch, nothing released). |

### Phase 3 — gap decisions (2026-10-14)

Copied from the implementation ledger (`.superpowers/sdd/2026-10-13-backward-scheduling-implementation/progress.md`, Phase 3 lines extracted to `phase3-ledger-extract.md`): every line that starts with `Task 3.N: gap filled:` or is a `Ruling:` for a Phase 3 task (Tasks 3.1 to 3.5), one row each, in ledger order. For a Ruling, Gap is the review finding or gate label, Choice is what was ruled, and Why is the cost line copied from the ledger. Task 3.6 (this documentation pass) is not a ledger task. The Phase 3 gate report is not written yet (the whole-branch review is still running); its placeholder heading follows the Phase 2 gate report.

| Task | Gap | Choice | Why |
|---|---|---|---|
| 3.1 | reconcile on undo vs dirty rows | new ReconcileOptions.ids bypasses the unsaved-edit skip for restored ids | undo rows are dirty by construction |
| 3.1 | toast after undo re-derivation | suppressed (reason 'undo') | undo already announces itself |
| 3.1 | G-0.25 in Remove Backlog | marked rows excluded from the move set | Remove Backlog ignores firmed, so "fixed" must mean not moved |
| 3.1 | OQ50 c elapsed bar | placeForwardSequence refuses never-policy overlong (queued overlong_never via Engine.overlongNeverChanges; reconcile reversal queue too) | only remaining continuous-bar path |
| 3.1 | legacy walk callers | none in production (only 'legacy-compat' tests); unknown modes now take the setup-aware path | nothing to re-route |
| 3.1 (Ruling) | I1 | the implementer gap-fill "the optimizer has no overlong path" is overturned: a never-policy order the setup-aware scheduler cannot fit because its run time exceeds every contiguous window is queued with reason overlong_never (brief OQ50 c/a7), not no_fit_found/search_limit, so the release path keyed on overlong_never can act on it; a genuine no-window-at-all failure keeps no_fit_found | cost if wrong: an order mislabelled overlong_never could be released as an elapsed bar when it was really unplaceable for another reason (visible, reversible). |
| 3.1 | never-policy overlong detection | longer than every contiguous window while the line has windows (hasNominalWindow false for run time, true for 1 minute) | separates overlong from no-window and plain no-fit |
| 3.2 | adjacency helper at setup-domain.mts:467 does not exist | used by-start adjacency (as deriveSetupObservation) via a per-pass line index in the reconcile | brief anchor stale, same rule the setup bars use |
| 3.2 | issue priority when several findings apply | finish_moved_earlier > setup_override_orphaned > frozen_window_crossed > pull_floor_crossed | one derivationIssue field; orphaned loses planner data so outranks the advisory two |
| 3.2 | no predecessor on the line | asserted machine state if any, else 0; a display-only predecessor also gives 0 | mirrors observation "initial" and the orchestrator ruling |
| 3.2 | setup-scheduler.test.mjs O(n^2) availability reference | updated to merge across midnight | it mirrors production and would disagree by design after the A.3 #9 fix |
| 3.2 (Ruling) | I1 | when the setup-aware second walk in the reconcile cannot place (contiguous policy, run within setupMinutes of the longest window), the zero-setup placement with the held finish stands and the setup-violated alert fires; the row is never pushed to the forward reversal by the setup reservation alone (setup is a preference the V1 rule tries to honour, not a reason to reverse) | cost if wrong: a planner sees a held-finish bar with too little changeover room flagged by an alert instead of a reversed bar. |
| 3.3 | day-attribution rule | working-window-weighted spread; split exact; closed-time-only bar falls back to wall-clock | keeps hours visible so the closed alert fires, matrix sums to run time |
| 3.3 | plant-level alert line | plant smallest affected line, emitted only when in scope | incremental merges never duplicate the plant alert |
| 3.3 | late alert scope and ceiling | non-queued orders in the alert horizon; ceiling = due midnight + (N+1) days from max_push_forward_days; no-calendar line reads raw+23:59:59 | matches Util.dueInstant and the optimizer ceiling |
| 3.3 | mismatch alert type | kept runtime-schedule-mismatch, reworded via alert.start_may_be_stale | existing tests and CAT_MAP depend on the type |
| 3.3 | severity table | error: late beyond cap, reversal_forward, placement_exception, plant_no_timezone, line_no_calendar, no_anchor; warning: late, finish_moved_earlier, pull_floor_crossed, frozen_window_crossed, setup_override_orphaned, run_time_zero, no_operating_window, unknown code | orchestrator ruling |
| 3.3 | unknown derivationIssue code | generic type derivation_issue with key alert.derivation_issue | never silently dropped |
| 3.3 (Ruling) | gate 14 | the Task 2.6 scope of frozen_window_crossed (manually firmed rows only) is widened to placed, unfirmed rows whose derived start moves from outside to inside the frozen window in that reconcile (a from->to transition); never-placed / display-only / queued rows stay excluded, so the 2.6 flood concern holds while spec R26 (an unfirmed order flipping frozen is sent firm irreversibly) becomes visible to the planner | cost if wrong: extra warnings on rows a planner already expected to firm (noise, no data change). |
| 3.4 | keyboard move path | no keyboard bar-move exists, so tests pin that arrows write no dates and that drag, grid End and Inspector End all call manualRoutingSchedulePatchFor with the finish | the Gantt keyboard handler only selects (G6) |
| 3.4 | retired Original/Updated locale keys | deleted from all five files by the implementer, Haiku only adds the new-name keys | keeps the superset test green and avoids stale wrong-meaning translations |
| 3.4 | explain-the-move line | ui.insp_system_move plus six ui.insp_move_reason_* keys; codes that are not moves render nothing | matches the orchestrator ruling |
| 3.4 | no-op resize | a patch equal to the stored bar writes nothing, pushes no undo entry, rebuilds the item | A.3 #18 |
| 3.5 | CSV due_date column position | appended last | keeps existing column indices stable |
| 3.5 | "firmed" survivor in collapse dry-run | manual_firmed or SAP firming X, listed and needs confirm | start may move under R2 |
| 3.5 | gate 17 layer | calendar-engine test (allocateRuntimeBackward vs allocateRuntime) | the allocators are where the 10-minute drift lives |
| 3.5 | separation alert wording | reworded in five locales (start→finish) | message must match the finish judgement |
| 3.5 (Ruling) | minor "commit trailer reads Claude Fable 5.1" | not a defect: the session attribution rule mandates that trailer for every commit of this run; no change. |  |
| 3.5 (Ruling) | minor "manual run time carried into the R2 end" | stands as pre-existing D11 behaviour (R2 builds the end from whatever run time the collapse re-weight leaves on the survivor; whether a planner-typed partial-share run time should be rescaled on collapse is an owner question for the final report) | cost if wrong: a collapsed survivor with a manual run time gets a finish that is too early by the share ratio, visible on the Gantt and reversible by re-typing the run time. |

**Deferred minors from Phase 3 reviews** (verbatim from the ledger):

- Task 3.1: minor (deferred): setup-scheduler.test.mjs:5113 title still says "moved starts" (brief said flip it).
- Task 3.1: minor (deferred): no tests for autoReflow/Alerts.applyFix marked-row guard, Remove Backlog dialog note, TimeMachine.restore.
- Task 3.1: minor (deferred): stale "legacy" comments in engine.mts (864-871, 909-915, 962, 1721, 2423, 2477, 2568).
- Task 3.1: minor (deferred): the plain no-fit-with-windows side of neverOverlongReason has no explicit test (returns null by construction).
- Task 3.2: minor (deferred): reconcile predecessor search ties by id but the observation sorts by start only (same-start rows may differ).
- Task 3.2: minor (deferred): no test pins msgKey/msgVars on the emitted setup-violated alert.
- Task 3.2: minor (deferred): stray blank line at end of the midnight availability test in engine.test.mjs.
- Task 3.3: minor (deferred): services.mts:872 _prewarm uses the viewer today while Dashboard keys the matrix on the plant clock (cache miss only when zones differ).
- Task 3.3: minor (deferred): nimbus-intelligence.js:1836 shows English a.msg for worker alerts (t() is reachable; pre-existing, one-line fix).
- Task 3.3: minor (deferred): alert card headlines for new types are title-cased English from the type code (no ui.alert_headline_* keys).
- Task 3.3: minor (deferred): workingMinutesByDay ignores blackout blocks (matrix/overload/briefing still agree).
- Task 3.4: minor (deferred): Util.impliedOriginalStart (foundation.mts:701) now has no callers; delete.
- Task 3.4: minor (deferred): stale "Updated End" comment at orders.mts:1948.
- Task 3.4: minor (deferred): Alerts auto-fix toast (services.mts ~469) reads the finish before autoReflow runs.
- Task 3.4: minor (deferred): _varianceBadge gives a 0.0h variance the "early" class (cosmetic).
- Task 3.4: minor (deferred): still-unkeyed English: Inspector setup-override editor, Productive schedule/Part N card, hover alert type ids, modal close aria-label.
- Task 3.5: minor (deferred): stale "start" wording remains in en.js:2178 ui.dist_status_separation_violated_tip and hardcoded optimize-ui.mts:2005 beside the reworded finish alert.
- Task 3.5: minor (deferred): collapse carries a planner-typed MANUAL partial-share run_time (D11) as the survivor run time, which now drives the R2 end; confirm intended "full-share run time".
- Task 3.5: minor (deferred): untested branches: NULL/0 run-time collapse arm, SAP firming X in `firmed`, repair guard is a kwarg-capture mock.
- Task 3.5: minor (deferred): get_aggregate due_date value has no DB-backed round-trip test (mocked rows only).
- Task 3.5: minor (deferred): commit trailer reads "Claude Fable 5.1" instead of "Claude Sonnet 5.5".

**Unverified in Phase 3** (verbatim from the ledger, one per cannot-verify line):

- Task 3.1: ⚠️ cannot verify: bench wall time (after run under load; digests identical per report only) and full-suite status.
- Task 3.2: ⚠️ cannot verify: test results (read-only review); DST behaviour of the 14-day touching-window loop in setupAvailabilityMinutes.
- Task 3.3: ⚠️ cannot verify: browser rendering of msgKey alert text and plant-clock today in Gantt/orders (no smoke).
- Task 3.3: ⚠️ cannot verify: payload calendars absent-row reading always equals Util.dueInstant no-calendar reading when Store auto-creates default calendars.
- Task 3.4: ⚠️ cannot verify: Override modal / hover card in a browser; system-move line only tested against a stub locale.
- Task 3.5: ⚠️ cannot verify: pytest/node results (read-only review; relied on the implementer report).

### Phase gate reports

_(appended at the end of each phase)_

#### Phase 1 gate report (2026-10-14)

**Branch and range.** `feature/backward-scheduling-phase1`, `0317dd8` (main at phase start) to `0c145b6`: 19 commits, 58 code and doc files, +2493 / -823. Nothing was pushed, merged or deployed (owner charter, plan section 0.2a). Gate numbers below were taken at `643b7eb` (the last code commit); `69dffac` and `0c145b6` are docs only.

**Commands run and counts** (from the ledger `Phase 1 gate` lines; the whole-branch reviewer re-ran only focused checks).

| Command | Result | Baseline |
|---|---|---|
| `npm test` legacy (`tests/js`) | 46 / 46 pass | 40 / 40 |
| `npm test` modules (`tests/modules`) | 1214 pass, 0 fail, 3 todo (knownFailure in `calendar-sync-boundaries.test.mjs`) | 1202 pass, 3 fail (optimizer spawn probes `ETIMEDOUT` under load), 3 todo |
| `npm run lint` | 0 errors, 35 warnings | same 35 warnings |
| `npm run check:static-assets` | OK | OK |
| `npm run check:legacy-surface` | no drift (re-run by the reviewer: "matches contract") | n/a |
| `node --check frontend/locales/{en,de,es,fr,pt}.js` | all five parse (reviewer) | n/a |
| `pytest tests/` on `nimbus_sdd` | 1685 passed, 2 failed, 1 skipped, 13 xfailed, 145 s | 1626 passed, 2 failed, 1 skipped, 13 xfailed |

The two pytest failures are `tests/test_scale_catalog_paging.py::test_material_grids_traverse_every_material_once_with_constant_query_budget[material_grid]` and `[material_plant_grid]`: identical on the baseline commit (collation ordering of material ids), unrelated to this work. The branch adds 59 passing Python tests and 12 module tests.

**Tests flipped or added, by task.**
- 1.1 locked columns: new `TestOriginalDatesBackfill` (pg), two schema tests (static text in both files; apply twice, ledger once), refresh-row and `/tasks` wire tests serve `COALESCE(original_*_received, basic_*)`, refresh copy-back test in `persistence.test.mjs`; both new migrations pinned in `test_schema_idempotent.py`.
- 1.4 hygiene (ran before 1.2): three Hygiene tests flipped (midnight kept, same-date finish before start kept, missing finish dropped with warning and counter), finish-column-absent flipped, `test_sap_staging.py:292` flipped (blank finish is `invalid_date`), `test_setup_data.py` flipped; added earlier-date drop, unparseable finish (Excel path), mixed-format parse; dead counters now incremented and asserted.
- 1.2 echo rule: 12 pure `finish_echoes` tests (Chicago M1 echo, New York variant is not an echo, timed echo, genuine change, no sent row) and six Postgres tests in `TestSapTruthReupload` (first ingest sets originals; echo keeps both; genuine later finish updates both; start-only change after an echo keeps the stored start).
- 1.3 distribution: five new tests in `TestSapTruthDistributionReupload` (re-weight then unchanged date-only upload resets no sibling; re-weight never rewrites a child's dates or baseline; new child has no SAP baseline; header original follows the echo rule, in the SAP frame; `_resolve_machines` header due comes from the plain order's locked original); the brief's named test was found vacuous after 1.4 and replaced by a discriminating one (mutation-checked both ways).
- 1.5 due reading: six `dueDateInstant` cases (compute core), foundation test for `Util.sapDueDate` (open day, Sunday to Friday close, timed as-is, no-calendar line, revision invalidation), setup-scheduler test (Sunday due, N = 0); the two baseline-correct tests and the relay expectations deleted.
- 1.6 run-time cap: 15 new tests (400 h row queued with reason and NULL dates, 336 h scheduled, horizon-5-days cap of 120 h, Machine Hours 500 queued, row over 8760 rejected by number with the chunk committed, bulk edit rejected with `run_time_over_cap`, resolver hold and release, schema re-apply raises the old bound once); bound tests in `test_task_response_models.py` re-pointed from 168 to 8760.
- 1.7 Send: `test_send_skips_unfirmed_orders` (pure and Postgres), existing send tests re-seeded with firm; per-locale `vm.Script` syntax test added after the French apostrophe defect.
- 1.8 purge preview: one request-body test in `admin-ui.test.mjs` (RED then GREEN).
- 1.9 docs: no test logic changed.

**Review findings per task and their fixes.**
- 1.1 approved, 0 Critical or Important. 1.2 approved. 1.5, 1.6, 1.8 approved (spec and quality).
- 1.3: one Important (named test vacuous after 1.4). Fix round: discriminating test, SAP-frame header echo test, replan carries SAP keys and the date-only flag (`4e8eb00`..`5b7bd30`).
- 1.4: spec miss (row-dict twin instead of the Excel path). Fix round: Excel-path unparseable-finish test, mixed-format parse unit test, wording (`ae99ec8`..`239c502`).
- 1.7: one Critical. `fr.js:750` had an unescaped apostrophe, so the whole French locale failed to load; the locale tests had not parsed the files. Fixed in `f2a6275` with the escape and a syntax-compile test for all five locales.
- 1.9 (Haiku, docs): Sonnet review checked 64 statements, corrected 12, added 26 (`0c145b6`).

**Whole-branch review (fresh Sonnet pass, 2026-10-14): NEEDS FIX WAVE. 0 Critical, 2 Important.**

Important findings (details and fixes are in the review message; recorded here verbatim):
1. Optimizer hot path is 30 to 50 percent slower on real (date-only) due dates. `frontend/optimization/setup-scheduler.mts:1254` `dueTimestamp` calls `dueInstant` (1219) on every comparison and, in `candidateForSequence` (3063) and `urgencyKeyFor` (6381), allocates a fresh `DueScope` per task per candidate. Measured with `scripts/bench-optimizer.mjs` (copy with due dates floored to midnight, `--shape large --no-deadline`, three modes, two runs): 1.7 to 2.1 s with timed dues (the old fast path), 2.3 to 3.8 s with midnight dues; `dueInstant` costs 1.6 to 2.4 microseconds per call with a midnight due against 0.2 with a timed one. A scratch copy with a per-task memo in `dueTimestamp` returned to 1.8 to 2.4 s with identical result digests. Fix: memoise the due instant per task (WeakMap keyed on the task, validated against the raw due and the snapshot), hoist `dueScopeFor` out of per-task loops, and add a midnight-due variant to the bench.
2. The Phase 1 deploy runbook (`docs/MIGRATION.md`, step 3 of "(b) Owner deploy runbook", line 1418) never rehearses the two migrations on the restored dump. `migrations/2026-10-15-1-orders-original-dates.sql` UPDATEs every `orders` row, and `chk_orders_sched_range` (`schema.sql:94-97`, `NOT VALID`) is still enforced on every updated row, so one pilot row with `scheduled_end` not after `scheduled_start` aborts the whole migration (it rolls back safely, but only at deploy time). Fix: add to step 3 "apply both migration files to the restored copy with psql, read the result, and run `SELECT count(*) FROM orders WHERE scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL AND scheduled_end <= scheduled_start`; the count must be 0 or the rows repaired before the window".

Conformance verdicts (file:line evidence is in the review message): spec section 7.3 items 1 to 7 present, nothing from Phases 2 to 4 leaked (no new wire field on `TaskDTO`; `TaskVersionRow.original_end_date` is the spec-listed refresh addition), `basic_finish_date` is written only by ingest (`db.py:2830`, `backend/distribution/data.py:1230,1419`), the working-hours snap is live (`persistence.mts` loop 1 and `calendar-sync.mts` re-snap), the due date and locked columns have no planner-action writer.

**Deferred-minor triage** (every `minor (deferred)`, `parked`, `concern` and unresolved line of the ledger). MUST = before merge; P2 = fix in the named Phase 2/3 task; ACCEPT = no action.

| Source | Item | Verdict |
|---|---|---|
| 1.1 | `persistence.mts` copies locked original start into `BASIC_START_DATE`; server PV validity reads `basic_start_date` | P2, Task 2.2 (OQ26: validity on `original_start_received`) |
| 1.1 | child read emits locked values under `basic_*` keys (naming trap) | ACCEPT: SQL comment added in 1.3 |
| 1.1 | refresh guard asymmetry (start unconditional, end guarded) | ACCEPT: harmless |
| 1.1 | `schema_bootstrap_smoke.py` exits 1 | ACCEPT: pre-existing on `88c2879` (sentinel `run_time_source` fingerprint drift); CI is already red on main; owner to know |
| 1.2 | echo docs still say minute precision (`docs/SAP_STAGING_DESIGN.md:113`, `docs/MIGRATION.md:847` "deferred" note, `docs/NIMBUS_INTERFACE_ARCHITECTURE.md:672` midnight rewrite reason) | MUST (docs, one line each; ride in the fix wave) |
| 1.2 | `fold=0` on DST-ambiguous local times; dormant `sap_sync.py:774` stub passes no `sap_tz`; no >500-row chunk test; no child start-only echo test | ACCEPT / P2 Task 2.7 for the tests |
| 1.2 | Excel path judges the echo in the plant frame (`sap_tz=None`) | ACCEPT: matches the old rule; revisit with the real-SAP echo test (assumption A9) in Task 2.7 |
| 1.3 | +2 round trips per distribution parent at ingest; f-string child SQL fragile; no mutation-hole test for the planner variant; `MAX(sent_finish)` arbitrary under a partial re-send | ACCEPT (sub-second at pilot scale); batch the queries in Task 2.7 if profiling asks |
| 1.3 | named test would not catch a planner rewrite of `basic_finish_date` from header facts | ACCEPT: sibling test covers it |
| 1.4 | staging validator accepts a finish before the start (rejected at apply) | P2, Task 2.7 |
| 1.4 | `_dropped_rows_label` renders float ids as `1000012345.0` | P2, Task 2.7 (use `_str_id`) |
| 1.4 | dropped-row counters are process-cumulative; DB Load stays `warn` until restart | ACCEPT |
| 1.4 | inactive `pedtr` field-map row drops every staged order | ACCEPT: document in Task 2.8 |
| 1.5 | stale comments (`persistence.mts`, `tests/test_distribution.py`, `cq1-compatibility-inventory.md`) | ACCEPT: 1.9 corrected them; two test-comment leftovers are harmless |
| 1.5 | `_calendarService.workWindow` seam member unused | P2, Task 2.5 (snap deleted there) |
| 1.5 | no direct test of `Engine.earliestAllowedStart` / `latestAllowedEnd` with a midnight or Sunday due | P2, Task 3.1 |
| 1.5 | silent raw fallback if `NimbusComputeCore.dueDateInstant` is absent | ACCEPT: the worker `importScripts` the same file |
| 1.5 | look-back loop 31 dates; no-calendar line does 31 cheap resolver calls | ACCEPT |
| 1.5 | optimizer hot-path cost unmeasured (⚠️) | MUST: measured by this review, Important 1 |
| 1.5 | grid and Inspector show the raw midnight (12 AM) in Original End | P3, Task 3.4 |
| 1.5 | optimizer floor and ceiling on a closed due day move to the previous open day | ACCEPT: ruled; named in the runbook |
| 1.6 | cap follows `plants.visibility_horizon_days`; plants with a horizon under 7 days get a cap under 168 h and an existing longer order is queued when next uploaded | ACCEPT with owner check: list pilot plants with `visibility_horizon_days < 14` before the window (runbook (c) already says no sweep) |
| 1.6 | `_apply_run_time_cap` imports the resolver's private `_write_holds` | P2, Task 2.6 (promote to a shared helper) |
| 1.6 | migration: ADD plus VALIDATE in one transaction | ACCEPT at pilot size |
| 1.6 | Excel row check (>= 8760 or negative) runs before plant resolution, so a junk run-time cell on a routing plant now drops the row | ACCEPT: visible as a named error warning; revisit when the Machine Hours unit is confirmed (Task 2.7) |
| 1.6 | only the grid localises `run_time_over_cap`; other surfaces show the English message | P3, Task 3.4 |
| 1.6 | no test that an unchanged over-cap run time never blocks a save | P2, Task 2.3 |
| 1.6 | queued over-cap row re-entering the schedule (⚠️) | ACCEPT: the bulk route checks `queued` on the requested status only (`db.py:1412,1562`), so a planner who releases an over-cap row through the existing Needs Planning path can place it; OQ28 allows planner release by design, and the explicit approve-and-release path is Task 2.5 (cost: a long bar appears before Phase 2 ships, reversible) |
| 1.6 | Excel row number after index resets (⚠️); runner per-file transaction (⚠️) | ACCEPT / resolved: runner uses `--single-transaction` (read by the reviewer); only a clean 3-row file is tested |
| 1.7 | toast `(N firm)` redundant; a zero-queued Send gives no hint that unfirmed orders were skipped | P3, Task 3.4 (surface `skipped_unfirmed`) |
| 1.7 | aggregate whose only firmed child has no end is dropped as unfirmed | ACCEPT: documented in test |
| 1.9 | runbook commands read, not executed; rollback reasoned, not run; `SAP_STAGING_VALIDATION_PLAN.md` describes the old Send dialog | ACCEPT: reviewer confirmed the runner flags, `-MigrationsDir`, exit code 3 and single transaction match the script; add the rehearsal step (Important 2) |

**Parked pre-existing items (not caused by this branch).**
- `scripts/schema_bootstrap_smoke.py` exits 1 on `88c2879` and earlier: the sentinel order's `run_time_source` is NULL on a schema.sql-only database and `'legacy'` after the migration replay. The new columns' mirror is covered instead by `test_schema_idempotent.py` and the reviewer's column and ledger check.
- `tests/test_scale_catalog_paging.py` (two parametrised cases) fails identically on the baseline.
- `tests/test_distribution.py::test_summary_counts_past_5000_headers` failed once in a 34 s run (timing and scale), passed on rerun and in the whole-file run.
- One flaky optimizer spawn probe (`engine.test.mjs`) failed three times in the baseline run under load; it did not fail in the gate run. Three `knownFailure` todos in `calendar-sync-boundaries.test.mjs`.

Post-fix-wave addendum: fix wave 2ca9ea4 + 5fbdfb7 (optimizer due-instant memo; runbook rehearsal + three doc fixes), re-review clean; Phase 1 tip 5fbdfb7.

#### Phase 2 gate report (2026-10-14)

**Branch and range.** `feature/backward-scheduling`, cut from the Phase 1 tip `5fbdfb7`. Range `5fbdfb7..HEAD`: 19 commits to `1d2888a` (85 files, +5820 / -1357) plus the final docs-verification commit that carries this report (documentation, and one comment edit in `frontend/scheduling/persistence.mts`). Nothing was pushed, merged or deployed (owner charter, plan section 0.2a). Gate numbers below were taken at `60bfdfe` (the last code or test commit); `1d2888a` and the verification commit change documentation only.

**Commands run and counts** (from the ledger `Phase 2 gate` line; Phase 1 gate shown for comparison).

| Command | Result | Phase 1 gate |
|---|---|---|
| `npm test` legacy (`tests/js`) | 47 / 47 pass | 46 / 46 |
| `npm test` modules (`tests/modules`) | 1329 tests: 1326 pass, 0 fail, 3 todo (the `knownFailure` baseline in `calendar-sync-boundaries.test.mjs`) | 1214 pass, 0 fail, 3 todo |
| `npm run lint` | 0 errors (35 pre-existing warnings at Task 2.1; the gate line does not restate the warning count) | 0 errors, 35 warnings |
| `npm run typecheck`, `check:static-assets`, `check:legacy-surface` | clean (the legacy surface shrank in Task 2.5 and was re-recorded) | clean |
| `python -m pytest tests/ -q` | 1772 passed, 2 failed (baseline `test_scale_catalog_paging` x2), 1 skipped, 13 xfailed | 1685 passed, 2 failed, 1 skipped, 13 xfailed |
| Forward-rule pins left to flip | 0 (the sweep found none; every §10.2 test was already flipped in Tasks 1.4 and 2.1 to 2.7) | n/a |

**Gate test groups** (plan "Phase 2 gate": groups 1, 2, 3, 4a, 5, 10, 11, 13, 14, 17, 18 and 21 of §10.5), mapped to the tests added in Tasks 2.1 to 2.8. Test names are abbreviated; "not found" means no test with that assertion was added in Phase 2.

| Group | Covered by | Gaps |
|---|---|---|
| 1 Backward calendar walk | `calendar-engine.test.mjs` (Task 2.1): closed-finish clamp, closed-day hop to the previous close, blackout start rounds down, finish exactly at close and at open, Monday-open lands on Friday close, the 4.2.3 case under never / overlong_only / partial_allowed, the no window / overlong / reached-now split, lookback bounded from the finish, `latestAvailable`, `_freeIntervalsBackward`; `capacity-allocation-integration.test.mjs` (six backward blackout, plant-hours and boundary cases) | none |
| 2 Backward DST | `calendar-engine.test.mjs`: the spring-forward case of 4.2.5 (Chicago, three viewer zones), day hop by calendar date across fall-back, `prevCalendarDay`, wall-clock round trip with gap and fall-back edges | the Task 2.1 review notes no test for `partial_allowed` under a plant zone across DST (deferred minor) |
| 3 Finish-anchored drag, resize, split, firmed echo | `gantt.test.mjs`: firmed unchanged-edges echo swallowed, end-only change holds the finish, left-edge-only change reverted with `toast.left_edge_locked`, a finish that cannot be held reverts, firmed overtime confirm, one segment of a split order moves every segment (OQ17 b), `lockLeftEdge`, off-grid echo ignored; `engine.test.mjs`: `manualSchedulePatchFor` finish held, snapped, refused, overtime, marked order; the existing multi-drag companion tests were re-pointed at the finish anchor | no test of the keyboard move path was added (not found); no new multi-drag test beyond the re-pointed companion tests |
| 4a Reversal in non-optimizer paths | `engine.test.mjs`: `finishAnchoredPatchFor` placed / refuse / reversal results, reconcile reversals in finish order (three orders on one line), `run_time_grew` and `cutover` tags, past-due release (`reversal_forward`), release-reversal only for releasable codes; `orders.test.mjs` release cases | "resulting running status" of a reversed order: not found as an explicit assertion |
| 5 Running-order rule | `engine.test.mjs` (a running stale row keeps its start and moves its finish); `confidence-lifecycle.test.mjs` (Push +1 h leaves firmed, frozen and running orders where they are); `orders.test.mjs` S6 (a run-time edit on a running order holds the start); `split-order.test.mjs` (a mismatch stays diagnostic until the reconcile re-derives from the held finish); `test_ingest_data_layer.py::TestOrderIsRunningOnStoredEdges` (six cases, stored edges only) | none |
| 10 Save contract | `test_task_concurrency.py::TestSaveContractWidthValidator` (single edge, both edges, 60 s tolerance, marker, null clear, daylight-saving elapsed width, segment rules, browser-shaped save, unmoved-bar skip, never-placed row stays gated, status-only save) and `TestUntrustedStartSave`; `test_task_response_models.py` (the marker is the one new wire field, forwarded only when sent); `persistence.test.mjs` (marker in the save payload); `test_planning_exceptions.py` | "refresh carries the due date" was added in Phase 1 (Task 1.1), not re-added here |
| 11 Outbound Send reads the stored finish | `test_sap_staging.py`: outbound rows read the shared stored finish, Send transmits the stored finish whatever the run time or flag, a firmed never-placed order is sent with its SAP finish and the echo matches; `test_orders_routing_ingest.py`: finish echo of the placed finish | none |
| 13 Ingest under the new rule | `test_ingest_data_layer.py` (no start column loads NULL starts, a blank start is absent, an unreadable start warns, a finish with no start is not judged, a start-only SAP change keeps the slot, a re-upload without a start keeps it, a missing finish column is rejected); `test_sap_staging.py` (missing start kept, missing finish dropped); `test_distribution.py` (a re-upload keeps the basic start on header and children) | the time-of-day, Excel unparseable-finish and machine-hours-bound cases of this group were added in Phase 1 (Tasks 1.2, 1.4, 1.6) |
| 14 Frozen, visibility and vanish on the derived start | `test_visibility_horizon.py` (the locked SAP start decides); `orders.test.mjs` (the visibility filter reads the SAP start as first received); `test_sap_staging.py` (the vanish key is the locked start); `engine.test.mjs` OQ4 (a firmed row is re-derived, a start inside the frozen window is flagged) | "start below the pull floor" (`pull_floor_crossed`): not found; "unfirmed order flipping frozen and sent firm irreversibly": not found |
| 17 Backward split allocation | `calendar-engine.test.mjs`: pieces filled from the latest fragment, 4.2.3 under partial_allowed, the 4.2.7 minimum-piece mirror, a piece shorter than the minimum skipped (`min_piece`), a whole order shorter than the minimum placed as one piece, `reached_now` when the walk would pass the floor | the 620-minute forward-versus-backward 10-minute drift case: not found |
| 18 Rounding | `engine.test.mjs` (requested finish snapped to the 15-minute step before the walk); `calendar-engine.test.mjs` (a sub-minute finish is floored without a move; closed-finish clamp into the window); `gantt.test.mjs` (an off-grid derived start does not read as a move) | nothing specific to "vis 15-minute snap against a finish drag" beyond the off-grid test |
| 21 Per-path reversal rounding | the reversal paths are covered by the group 4a tests; the reconcile and the manual path both floor the plant "now" to the minute | no test compares the optimizer's ceil-to-minute reversal with the manual 15-minute snap: not found (the optimizer path is Phase 3) |

**Review findings per task and their fix rounds** (from the ledger).
- 2.1 backward primitives: approved (0 Critical, 0 Important, 4 deferred minors). Two late test-only fixes after a regression probe on the Phase 2 branch: fix round 1 `a9e9aed` (`optimize-ui.test.mjs` never loaded the compute core onto the global, so 13 preview tests failed from `2f2ec27`) and fix round 2 `95ecb59` (the worker-thread bridge strings in `optimizer-worker.test.mjs` did the same). No production change. Complete `5fbdfb7..95ecb59`.
- 2.2 server read rule: spec met, 1 Important (plan-mandated: the conflict scan's neighbours came from `_EFF_END_SQL`, so a never-placed order's whole SAP window counted as an overlap). Fix round 1 `adbb53b` restricted neighbours to placed rows and deleted an unused SQL alias. Complete `2f2ec27..adbb53b`.
- 2.3 save contract: 1 Important (the width gate ran on saves that did not move the bar and rejected an unrelated edit on a stale bar). Fix round 1 `1396cb9`: skip the gate for an unmoved bar (raw stored edges), non-vacuous atomic test. Complete `adbb53b..1396cb9`.
- 2.4 one clock: approved, 0 findings. Complete `1396cb9..65d8014`.
- 2.5 manual placement: spec not met, 1 Important (a typed End on an order carrying the marker computed a zero delta and stretched the bar). Fix round 1 `74d5c05` (five items): the typed End places from the pre-edit end, past-due releases reverse forward, the off-grid edge compare is snapped, the refusal text is keyed in five locales, Push +1 h runs on one calendar run cache. Complete `95ecb59..74d5c05`.
- 2.6 reconcile: spec not met, 1 Critical (the client never updated `user_scheduled`, so a planner-placed, unsaved row was re-derived from its due date and then saved). Fix round 1 `a7cf567` (three items): `Store._markPlaced`, the reconcile skips dirty ids, the display source is skipped by the conflict-generation and autosave subscribers, `no_anchor` note. One minor note: the dirty-id skip was not exercised by that pin (the mark already removes the row); carried into Task 2.8 and pinned by `819b678`. Complete `74d5c05..a7cf567`.
- 2.7 ingest: approved, 0 findings (5 deferred minors). Complete `a7cf567..d15e250`.
- 2.8 sweep (tests, locales): approved, 0 findings (2 deferred minors); commits `fa003b3`, `819b678`, `369831e`, `60bfdfe`. Complete `d15e250..60bfdfe`.
- 2.8 docs: Haiku rewrote the five CLAUDE.md / AGENTS.md pairs and the two gap tables (`1d2888a`); the verification pass (the commit carrying this report) checked each factual statement against the live code, corrected stale line references and counts, added the status-only save rule and the read-fragment note to `backend/scheduling`, fixed three out-of-scope docs and the `tests/README.md` test-file references, and added the Phase 2 gate ruling to the gap table.
- No separate Phase 2 whole-branch review (ruling below): the fresh whole-branch review runs at the Phase 3 gate and covers Phases 2 and 3.

**Deferred minors for the Phase 3 whole-branch review to triage** (every `Task 2.N: minor (deferred)` ledger line, verbatim; the bracketed status was added at Phase 2 close).
- Task 2.1: minor (deferred): _backwardFrame always walks ~92 nominal days regardless of floor and each span edge costs 2-6 Intl formatToParts calls in plantInstantFromWallClock; cache or bound before a hot optimizer loop calls it per order. _[open (the reconcile, multi-drag and Push +1 h now batch with `_beginRun`/`_endRun`; about 370 ms per pass at 300 never-placed orders was measured in Task 2.6)]_
- Task 2.1: minor (deferred): exhausting the lookback (not the floor) with windows present but fully blacked out returns reached_now; the name is imprecise (caller reverses forward, which then fails visibly). _[open]_
- Task 2.1: minor (deferred): no test for multi-cause moveReason precedence, for partial_allowed under plantTz across DST, for fall-back, or a Sunday-night to Monday-morning merge (midnight merge is tested Mon-Tue and in _freeIntervalsBackward only). _[open]_
- Task 2.1: minor (deferred): engine.mts plantWallClockFromInstant wrapper now needs globalThis.NimbusComputeCore at call time (was self-contained); fine in the browser and in the current tests, a bootstrap-order hazard for any new Node test importing engine.mjs alone. _[mitigated: file-level compute-core bootstrap in `optimize-ui.test.mjs` (a9e9aed), worker bridge in `optimizer-worker.test.mjs` (95ecb59), wrapper comment]_
- Task 2.2: minor (deferred): tests/test_sap_staging.py:1410 test_same_instant_batches_have_exactly_one_winner hard-codes 2026-10-07 and is swept by the 7-day dead-batch retention from 2026-10-14 08:00Z; confirmed date-dependent, not caused by this diff; make the instants relative to now(). _[fixed in `fa003b3` (instants relative to now)]_
- Task 2.2: minor (deferred): backend/integration/sap_staging.py:2222 candidate eff_start falls back to basic_start_date (echo-movable planning copy), not the locked SAP start; firm_flag's frozen-horizon test reads it for never-placed rows. _[open]_
- Task 2.2: minor (deferred): backend/setup/data.py:987-992 _load_setup_coverage now joins the full segments lateral (jsonb aggregate per order) just to read first_start, and queued rows now sort last per machine (NULL start) so they form observed transitions after the scheduled ones; observer lookup (data.py:497-507) also evaluates the lateral for every machine order before LIMIT 1. _[open]_
- Task 2.2: minor (deferred): backend/distribution/data.py:2484 and 2337 still read c.scheduled_start IS NOT NULL / scheduled_start as "placed" (and db.py:2854, distribution/data.py:1487 in unaliased UPSERTs where _PLACED_SQL cannot be used); one-definition-of-placed is not literally universal. _[open]_
- Task 2.2: minor (deferred): db.py:264 _EFF_END_WITH_RUNTIME_MISMATCH_SQL now has zero callers (kept only because the brief says keep); remove or use it in Task 2.3. _[fixed in `adbb53b` (alias deleted)]_
- Task 2.2: minor (deferred): single-edge save to a never-placed row (db.py:1549-1551) now judges the inverted range against the SAP finish and leaves scheduled_end NULL (finish reads as the due date) after a start-only write; browser always sends both edges, Task 2.3 must own it. _[resolved by Task 2.3 (single-edge saves are rejected as `single_edge`)]_
- Task 2.3: minor (deferred): tests/test_planning_exceptions.py::test_atomic_db_validation_writes_nothing is now vacuous (its `good` item is single-edge, rejected on its own); give both items both edges. _[fixed in `1396cb9` (both items carry both edges)]_
- Task 2.3: minor (deferred): zoneinfo fold=0 makes a 24/7 bar starting in the repeated fall-back hour measure 1 h too long (false width_mismatch, ~1 h/yr); gap wall times are accepted (pre-transition offset), no exception. _[open]_
- Task 2.3: minor (deferred): unknown zone name / missing tzdata silently falls back to naive width (db.py _elapsed_seconds); status-only 'scheduled' guard compares EFFECTIVE edges (SAP fallback) so it cannot fire for unplaced rows. _[status-only guard fixed in `369831e` (reads the raw stored edges); the unknown-zone naive-width fallback is open and now documented in `backend/scheduling/CLAUDE.md`]_
- Task 2.4: minor (deferred): Gantt lock-band/firm styling (gantt.mts:368/415/740/1020/1149) still uses the viewer clock while Engine defaults now use the plant clock; a cross-zone viewer can see a bar styled unlocked that the engine/drag path treats as frozen/running. Display only, nothing persisted; route to a Gantt follow-up (pass Store.plantNow(t.PLANT) as `now`). _[fixed in Task 2.5 (`Timeline._nowFor` / `_plantNow`; pinned by the Task 2.4 carry-in test in `gantt.test.mjs`)]_
- Task 2.4: minor (deferred): Util.latenessHours queued-order `new Date()` (foundation.mts:699) and Utilization/alert day keys (services.mts:474-475, 852, 859, 943) stay on the viewer day; display/grouping only, but Task 3.x `late`/utilization must not build on them. _[open (Task 3.3)]_
- Task 2.4: minor (deferred): Store._blockedPlants (store.mts) is never pruned: after an admin sets a zone, plantNow succeeds but the plant stays in the set, so Task 3.3's plant_no_timezone alert would be stale until reload. Fix: delete the plant from the set on a successful plantNow (or on setMasterData). _[open (Task 3.3 carry-in)]_
- Task 2.4: minor (deferred): offset = server_now minus Date.now() taken AFTER the response is parsed (persistence.mts Store.setServerNow call), so it understates by the request round trip (seconds on a large /tasks); capture Date.now() before the fetch and pass it as receivedAtMs. _[open]_
- Task 2.4: minor (deferred): no test pins that Compute.alerts/Alerts._recomputeSync actually send `now` (only the core reading it is tested); removing `_plantClocks` would pass the suite. _[open]_
- Task 2.5: minor (deferred): Table._explainManualRefusal keeps the hardcoded English 'Could not regenerate the order in the available calendar window.' (moved, not new; use toast.commit_failed / t()) _[fixed in `74d5c05` (`toast.manual_refusal_generic`, five locales)]_
- Task 2.5: minor (deferred): stale mentions of the removed seam/snap remain in frontend/calendar/AGENTS.md:22 and tests/README.md:33 (CLAUDE.md twin was updated) _[fixed in the 2.8 docs commit `1d2888a` and its verification]_
- Task 2.5: minor (deferred): Push +1 hour (nimbus-intelligence.js) walks each selected order without a Calendar._beginRun/_endRun batch cache (the multi-drag path has one) _[fixed in `74d5c05` (`Engine.pushFinishPatches` on one run cache per plant)]_
- Task 2.5: minor (deferred): a Release (overlong_never / run_time_over_cap) of a late order whose due instant is already past is refused finish_cannot_hold (reversal counts as finishMoved); brief says over-cap goes through finishAnchoredPatchFor _[resolved by the Task 2.5 ruling and `74d5c05` (a past-due release reverses forward, `reversal_forward`)]_
- Task 2.5: minor (deferred): between 2.5 and 2.6 a firm/notes edit on a never-placed row resends raw SAP edges and is rejected width_mismatch by the server (raw stored edges are NULL so the unmoved skip cannot fire; nothing is stamped) _[open (same shape as the Task 2.6 concern about firm- or notes-only edits on a never-placed row; re-check in Phase 3)]_
- Task 2.5: minor (deferred): gantt _onDataSetUpdate startMoved/endMoved compare snap(v.*) with the unsnapped expectedItem edges; derived starts are now commonly off the 15-min grid, so an echo or a vetoed left-edge drag on such a bar can show toast.left_edge_locked _[fixed in `74d5c05` (both sides snapped before comparing)]_
- Task 2.6: minor (deferred): Persistence.conflictGenerations (persistence.mts:1710) and the autosave subscriber (application-shell.mts:2119) skip only 'refresh'; the -display source bumps edit generations and triggers cache writes. _[fixed in `a7cf567` (conflict-generation and autosave subscribers skip the display source)]_
- Task 2.6: minor (deferred): measured ~370 ms per pass at 300 never-placed orders (Node, 5 lines, never-split), re-run in full on every hydration/refresh/distribution save even when nothing changes; add an unchanged-inputs skip before Phase 4 / larger plants. _[open (add an unchanged-inputs skip before Phase 4 or larger plants)]_
- Task 2.6: minor (deferred): a row with no anchor (engine.mts ~1594) is skipped with no derivationIssue; CalendarSync._hydration.lines is set only at fetch, so a line given a server hours row later stays line_no_calendar until the next fetch; optimization/CLAUDE.md "Imports in" omits calendar-sync; commit() emits two tasks:bulkUpdate events per batch. _[`no_anchor` note fixed in `a7cf567`; the optimization `CLAUDE.md` imports list fixed in the 2.8 docs verification; stale `_hydration.lines` after a later server hours row, and two `tasks:bulkUpdate` events per batch, are open]_
- Task 2.6: minor (deferred): Task 3.3 must render no_operating_window (justified: reuses the FinishRefusal vocabulary), frozen_window_crossed and run_time_zero; none is in the shared-context alert list. _[open (Task 3.3)]_
- Task 2.7: minor (deferred): db.py:1706-1711 status-only 'scheduled' save is rejected for a non-queued NULL-start row and its comment ("cannot fire for an unplaced row") is now false. _[fixed in `369831e`]_
- Task 2.7: minor (deferred): backend/distribution/data.py:1418 (and header _write_header_facts ~1229) still write basic_start_date = EXCLUDED, not COALESCE like db._UPSERT_SQL, so a re-upload that sends no start erases a child's stored basic start (display fallback only). _[fixed in `60bfdfe` (COALESCE in the child upsert, header SET and header guard)]_
- Task 2.7: minor (deferred): staging rejects a malformed non-blank start as invalid_date while Excel keeps the row with a NULL start; justified, pinned at tests/test_sap_staging.py:309, but not in the Task 1.4 Excel/SAP parity test. _[open]_
- Task 2.7: minor (deferred): trust_start is also honoured on the browser's /tasks/update (shared _apply_task_date_updates), not only /tasks/bulk_update. _[open (documented in `backend/scheduling/CLAUDE.md`)]_
- Task 2.7: minor (deferred): backend/integration/AGENTS.md still carries the old dropped_no_start_date text (AGENTS.md already out of sync with CLAUDE.md). _[fixed in the 2.8 docs commit `1d2888a`]_
- Task 2.8: minor (deferred): the new status-only guard (db.py ~1706) also rejects an attribute+status save (e.g. PRT_01 + planning_status 'scheduled', no edges, no schedule_segments key) on a never-placed row, and the reused `single_edge` text ("start and finish must be saved together") is slightly off when no edge was sent; the browser always sends schedule_segments so it never reaches this guard. _[open]_
- Task 2.8: minor (deferred): the header change-guard (`%(bs)s::timestamp IS NOT NULL AND ...`, backend/distribution/data.py ~1240) has no isolating pin (the pin also changes finish/quantity so the WHERE fires regardless); the SET COALESCE, which is what protects the stored start, is pinned and verified discriminating. _[open]_

**Rulings made in Phase 2** (full text in the "Phase 2 gap decisions" table).
- 2.2: the conflict scan's neighbour set is placed rows only (`_PLACED_SQL`); never-placed and queued rows cannot conflict server-side (the browser's overlap alert still covers display overlaps).
- 2.3: the width gate is skipped for an unmoved bar (both sent edges equal the stored raw edges, run time unchanged); raw columns only, so an unplaced row's SAP window is never stamped as a placement.
- 2.1 (fix round 1): the `optimize-ui.test.mjs` regression is fixed in the test bootstrap, not by changing the engine wrapper.
- 2.1 (fix round 2): the worker-thread realm failure is test-only; fixed in the test bridge strings.
- 2.5: planner run-time, machine and version edits hold the finish; a finish that cannot be reached is refused with `toast.finish_cannot_hold` (same as a drop); the walk's own answer is for system re-derivations only.
- 2.5: a Needs Planning release whose due instant is already past is not refused; it reverses forward from now and carries `reversal_forward` (`due_date_past`).
- 2.6: any client schedule write that is not display or refresh marks the row placed locally (`user_scheduled`), and the reconcile skips ids with unsaved edits.
- 2.7: `/tasks/bulk_update` defaults to `trust_start` true; external callers pass false to have the start flagged instead of width-checked; flipping the default waits on the Phase 0 item g caller list.
- Phase 2 gate: no separate Phase 2 whole-branch review; the Phase 3 gate review covers Phases 2 and 3.

**Concerns carried into Phases 3 and 4.**
- Task 3.3 must render the `derivationIssue` codes `no_operating_window`, `frozen_window_crossed`, `run_time_zero` and `no_anchor`, and turn `Store._blockedPlants` (pruned on a successful `plantNow`) into the `plant_no_timezone` alert.
- Plants with no timezone are not running and not frozen wherever the default clock is used (a toast only, until Task 3.3); rows on a line with no server hours row are skipped even when plant-level hours exist.
- Display-only derivation re-runs on every refresh or hydration event (one backward walk per never-placed row); unmeasured at plant scale beyond the 370 ms at 300 orders.
- `/diagnostics/deep` renamed its pipeline key from `dropped_no_start_date` to `unreadable_start_date`; any outside reader of that JSON loses the old key.
- The optimizer's own output and the Alerts one-click fixes are still forward until Tasks 3.1 and 3.3.

**Parked pre-existing items (not caused by this branch).**
- `tests/test_scale_catalog_paging.py` (material-grid paging, two parametrised cases) fails identically on the baseline (local collation ordering).
- `tests/test_distribution.py::TestSqlStatusClassificationParityAndScale::test_summary_counts_past_5000_headers` hit a statement timeout once when pytest ran concurrently with lint and tsc; it passes alone and in the gate run (load-sensitive).
- Three `knownFailure` todos in `calendar-sync-boundaries.test.mjs` (the 3 todo in the module count).
- One flaky optimizer spawn probe in `engine.test.mjs` (timeouts under load); it did not fail in the gate run.
- `test_same_instant_batches_have_exactly_one_winner` was a date-bomb (a hard-coded 2026-10-07 fell outside the 7-day retention); fixed in Task 2.8 (`fa003b3`), so it is no longer parked.

**Owner-facing items.**
- Phase 0 item g: the caller list for `POST /tasks/bulk_update` is still unanswered. Until then `trust_start` defaults to true, so an external or integration writer that sends a start it computed under the old rule should pass `trust_start: false`.
- Before cutover, run the profile counts Q13 (lines with no server hours row, which the reconcile skips) and Q15 (plants with no timezone, which derive nothing and show a toast) on the restored copy.
- Browser checks owed (not run by this session; code and unit tests only): the left-handle veto while dragging (`lockLeftEdge` through the timeline's move hook; the commit-time revert is the fallback), the derive-paused banner (appearance, and overlap with the concurrency banner), the overtime confirm for a firmed order dropped outside working hours, and display-only never-placed rows (rows with no start are derived for display, and Save leaves them never-placed).

**Not released.** Rollback = the branch is not merged.

### Phase 3 — gate report

**Branch and range.** `feature/backward-scheduling` (Phase 2 complete at `e86a8b1`; Phase 1 tip `5fbdfb7`). Range `5fbdfb7..HEAD`: 40 commits to `5bb605b` (112 files, +9424 / -2591) plus the docs commit that carries this report. Phase 3 itself is Tasks 3.1 to 3.6 (commits `63795d0..4a53356`); the whole-branch review (Phases 2 and 3, `5fbdfb7..f671657`) and its single fix wave (`c23c0ac..5bb605b`, 7 commits) follow. Nothing was pushed, merged or deployed (owner charter, plan section 0.2a).

**Commands run and counts.**

| Command | Pre-fix, at `f671657` (ledger "Phase 3 gate") | Post-fix, at `5bb605b` | Phase 2 gate |
|---|---|---|---|
| `npm test` legacy (`tests/js`) | 68 / 68 pass | 68 / 68 pass | 47 / 47 |
| `npm test` modules (`tests/modules`) | 1387 tests: 1384 pass, 0 fail, 3 todo | 1403 tests: 1400 pass, 0 fail, 3 todo (the `knownFailure` baseline) | 1326 pass, 3 todo |
| `npm run lint` | 0 errors, 35 warnings | 0 errors, 35 warnings (none in code this wave added) | 0 errors |
| `npm run typecheck`, `check:static-assets`, `check:legacy-surface` | clean | clean (a first attempt at the F8 fix added one legacy-surface consumer, `Util.alertMessage`; reworked to use the local `t()` so the ratchet holds) | clean |
| `python -m pytest tests/ -q` | 1777 passed, 2 failed (baseline `test_scale_catalog_paging` x2), 1 skipped, 13 xfailed | 1779 passed, 2 failed (same baseline pair), 1 skipped, 13 xfailed | 1772 passed |

One module test (`changeover advances to a future order pull-forward floor ...`, the known load-sensitive optimizer probe) failed once in a run that overlapped other work and passed on rerun and in the gate run.

**Tests flipped and added in Phase 3.** Module tests grew from 1329 (Phase 2 gate) to 1387 at the review point and 1403 after the fix wave; pytest from 1772 to 1777 to 1779. Phase 3 flipped the tests that pinned start-keyed behaviour (instability, separation and the collapse carry now judged or written on the finish), added the day-attribution, late/reversal alert, setup-reservation, variance-badge and locale-guard tests, and the fix wave added the missing gate-group tests listed below.

**Whole-branch review (fresh Sonnet, read-only; Phases 2 and 3, `5fbdfb7..f671657`).** 1 Critical, 5 Important, 13 Minor; forward-path leaks: none (one sanctioned-but-unlisted path); scoped gate groups met 22 of 30, 5 partial, 3 with no discriminating test.
- Fixed: F1 (Critical): a planner edit or drop whose backward start falls before now now places forward from the plant's now with `reversal_forward` (`due_date_past` or `run_time_grew`) and the late alert; only a finish that would have to move earlier is still refused (`c23c0ac`). F2: the manual running-order edit keeps the real start through the shared `Engine.heldStartPatchFor` (`c23c0ac`). F3: the collapse carry with a NULL or 0 run time writes `scheduled_end = scheduled_start + 1 minute` and keeps the stale flag, so `chk_orders_sched_range` holds (`b3d1798`). F4: the multi-drag ghost preview takes the finish delta (`e0377c6`). F5 and F6: every missing or partial gate group has a test now (`160f2d2`). F7, F8, F12 (impliedOriginalStart, stale comments, test title, `_markPlaced` comment), F15, F16 (the refresh-triggered reconcile only wakes plants whose refreshed rows hold a candidate) and F13 (docs) are fixed as the "cheap" triage set (`b00e79d`, `6c5679e`, `5bb605b`).
- Left, with reasons: F9 (alert-card headlines for the new types are English title-cased type codes; 8 types x 5 locales, not cheap); F10 (undo of a never-placed row persists a placement on the next Save; needs a design call on `_markPlaced` and the reconcile's dirty flag); F11 (`_overlayUserMoves` drops the placement marker on a reload before Save); F12 remainder (`Calendar.latestAvailable` has tests only; deleting it deletes its tests); F14 (display only); F16 remainder (`Store.plantNow` is un-memoised, the full-plant pass is unmeasured at plant scale: Phase 4 gate); F17 (DST residual on forward legs, 24/7 lines, about twice a year, risk not reproduced); F18 (sticky placement marker, owner to confirm); F19 (three adapters of one shape, refactor).
- Rulings: the Task 2.5 ruling "a held finish that cannot be reached is refused ... the walk's own answer is reserved for system re-derivations" was applied to the later-finish reversal as well, which contradicts O2, OQ3, OQ7(a) and OQ19(c). Corrected: the refusal applies only when the walk would move the finish earlier; a start before now reverses forward from now (the second Task 2.5 ruling, the release of a late over-cap row, generalised). The Task 3.5 ruling "a collapse carry with no run time keeps end = start" is amended to start + 1 minute (F3).

**Missing gate-group tests now added** (`160f2d2` unless noted; each fails without the behaviour it pins).
- 23 a: `engine.test.mjs`, restoring an Apply snapshot brings back the finish and the run time together. 23 b: `services.test.mjs`, the overload auto-fix leaves exactly two undo entries and one Ctrl+Z restores the line.
- 24: `optimize-ui.test.mjs`, Apply drops a candidate whose derived bar started by the plant clock at Apply time (no `isInProgress` stub; the viewer clock is months away, so a viewer-clock filter fails it).
- 33: `services.test.mjs`, the "order moved" toast date equals `Util.fmtDT(finish)` and not the start.
- 4a: `engine.test.mjs` and `orders.test.mjs` (`c23c0ac`), the OQ7(a) GAP06 example (`runtime_unknown` hold, due Monday 18:00, now Wednesday 10:00, RUN_TIME 6 -> Wednesday 10:00-16:00, `due_date_past`), a not-started order whose start falls before now (`run_time_grew`), and the refused side (a finish on a closed day still toasts `finish_cannot_hold`).
- 4b: `locale-completeness.test.mjs`, every `alert.*` key the compute core can emit (literals, the derivation-issue switch, the three reversal details) exists in all five locales.
- 15: `confidence-lifecycle.test.mjs`, `TimeMachine.restore` restores the finish, flags the row stale and calls `Engine.reconcileRestored` for existing ids only.
- 16: `optimizer-worker.test.mjs`, a worker-produced patch has `end_date` equal to its last productive edge and pieces that add up to the run time (segmented and continuous order); 23 a doubles as the Apply-undo test.
- 30: `gantt.test.mjs` (`e0377c6`), a right-edge resize ghosts the companions by the finish delta.
- 2: `calendar-engine.test.mjs`, a `partial_allowed` walk under a Chicago plant zone across the spring-forward and the fall-back night places pieces whose plant-zone elapsed total is the run time; also the Sunday-night merge and multi-cause `moveReason` precedence (2.1 minor).
- 7: `compute-core.test.js`, the setup-violated alert carries `msgKey` and the required / available / short vars.
- G-0.25 and 3.1 minors: `services.test.mjs` (`Alerts.applyFix` never moves a marked row), `optimize-ui.test.mjs` (the Remove Backlog dialog names the run-time-grew count).

**Open owner items carried forward.**
- Appendix A questions 1 to 5.
- Phase 0 item g: the caller list for `POST /tasks/bulk_update` (`trust_start` defaults to true until answered).
- Profile counts Q13 (lines with no server hours row, skipped by the reconcile) and Q15 (plants with no timezone) must be 0 on the restored copy before cutover.
- The Phase 1 hard-bound shift (the optimizer's floor and ceiling on a closed due day).
- ~~Plants with `visibility_horizon_days` below 14 get a run-time cap below 336 h.~~ Not so as built (senior review U5): the cap is a flat 336 h.
- Task 3.5: a planner-typed MANUAL partial-share run time is carried onto the survivor by the distribution collapse (D11) and now drives the carried finish; confirm that the full-share run time is what is intended.
- F18: a placement marker (overtime / overlong) is sticky until Unschedule even when the bar is dragged back into normal hours; confirm.
- F10 and F11 are open defects awaiting a design call (undo of a never-placed row persists a placement; a reload before Save drops a placement marker). F17 (DST on forward legs) is an accepted residual to measure in Phase 4.
- Browser checks still owed (not run by this session): the Phase 2 list (left-handle veto through vis `onMoving`, the derive-paused banner, the overtime confirm for a firmed order, display-only never-placed rows), and for Phase 3 and the fix wave the multi-drag ghost on a right-edge resize, the reversal toast and alert on a planner run-time edit of a late order, the alert cards and glossary in all five locales, and the distribution separation wording.

**Not released.** Rollback = the branch is not merged.

### Phase 4 — gap decisions (2026-10-14)

Copied from the implementation ledger (`.superpowers/sdd/2026-10-13-backward-scheduling-implementation/progress.md`, Phase 4 lines extracted to `phase4-ledger-extract.md`): every line that starts with `Task 4.N: gap filled:` or is a `Ruling:` for a Phase 4 task (Tasks 4.1 and 4.2), one row each, in ledger order. For a Ruling, Gap is the review finding label, Choice is what was ruled, and Why is the cost line copied from the ledger. Task 4.3 (the runbook text) logged no gap line.

| Task | Gap | Choice | Why |
|---|---|---|---|
| 4.1 | snapshot omits original_*_received | omitted | existing test_original_dates_schema_applies_twice pins which tables carry those columns and cutover never writes them |
| 4.1 | test isolation | single rolled-back transaction | now() is txn-stable so plant-local now is exact, no residue |
| 4.2 | who triggers the cutover pass (nobody passed reason 'cutover') | first-load pass with stale*2 > non-queued rows (queued excluded) is the cutover pass; explicit reason wins; undo never (narrowed by the I1 ruling below: the data signature, not the ratio alone) | keeps the brief's >50 % rule without a new call site; reversals then carry detail 'cutover' |
| 4.2 | count sources | stale rows only: re-anchored = backward-placed, reversed = forward-from-now placed, kept running = held-start patches, blocked = plant_no_timezone/line_no_calendar/no_anchor; toast only if counts sum > 0 | matches the brief's list; other refusals are in no bucket |
| 4.2 | F10 never-placed predicate | !task.user_scheduled after restore (the reconcile's own display-only test); reconcileRestored clears stale flag via display source and drops ids from _dirtyIds/_forceIds | so Save cannot persist a placement the row never had |
| 4.2 | placeholder syntax | {{n}}/{{m}}/{{k}}/{{j}} | the repo's Util.t only interpolates double braces |
| 4.2 (Ruling) | I1 | the cutover pass is detected by the data signature the cutover SQL leaves, not by a stale ratio alone: a first-load pass counts as the cutover pass when the stale rows that are never-placed (both edges NULL, !user_scheduled) plus the running rows that kept start and end exceed 50% of the plant non-queued rows; stale rows that still carry a placement (an ordinary SAP/routing re-upload) never count, so such a load keeps the per-row Toasts and detail run_time_grew; an explicit reason:cutover still wins | cost if wrong: a plant whose cutover rows were somehow placed before first load shows per-row Toasts instead of the summary (cosmetic). |
| 4.2 (Ruling) | I2 | the F10 fix must drop only the placement from what Save persists: on undo / Time Machine restore of a never-placed row, the row stays dirty if it carried an unsaved non-date edit before the Apply (the undo entry records per-id pre-Apply dirtiness, or the restore compares non-date fields against the server copy), and only the derived dates/segments are excluded from the save payload; the placement side of the existing F10 test stands | cost if wrong: an unsaved attribute edit on a never-placed row is silently lost on undo (the current behaviour the reviewer found). |
| 4.2 | I2 mechanism | record pre-edit dirtiness on the undo snapshot and omit dates/segments from a never-placed row's save payload | keeps unsaved attribute edits while dropping only the placement |

**Concerns recorded in Phase 4** (verbatim from the ledger, one per concern line):

- Task 4.1: schema_bootstrap_smoke still exits 1 (pre-existing routing_runtime_legacy_backfill ledger drift), nothing new from this task.
- Task 4.1: nimbus_sdd holds no orders, so the migrations were hand-applied to an empty table; data effect proven only by the rolled-back test fleet.
- Task 4.2: four existing reconcile tests had 1-2 stale rows of 3 and tripped the new >50 % threshold; each got one placed non-stale row (no behaviour assertion changed). A tiny plant with one stale row will show the cutover toast. (Superseded by fix round 1: the signature rule reverted those fixture rows.)
- Task 4.2: de/es/fr/pt toast copy is machine-quality, not native-reviewed.
- Task 4.2: F10 drops dirtiness of a never-placed row that had an unrelated unsaved non-date edit before the undo. (Fixed by the I2 ruling.)
- Task 4.2: any dirty never-placed row (not only undone ones) now saves without dates; server treats omitted dates as leave-alone (read in routes.py), not exercised against Postgres.
- Task 4.2: a snapshot not taken via snapshotTasks (Time Machine restore of stored snapshots) has no dirtiness record, so its never-placed rows are made clean as in round 0.

**Deferred minors from Phase 4 reviews** (verbatim from the ledger):

- Task 4.1: minor (deferred): test run-futuredue row cannot discriminate old_end arms, plus a stray `- _h(0)` in the assertion
- Task 4.1: minor (deferred): no boundary rows (start == now, old_end == now) pin the `<=` / `>` semantics
- Task 4.1: minor (deferred): updated_at compared via str() > OLD in the test; use datetime compare
- Task 4.1: minor (deferred): running rows with run_time and no segments get end = start + run_time, replacing a differing stored scheduled_end; mention in Task 4.3 runbook
- Task 4.2: minor (deferred): no once-per-plant guard; blocked-heavy plants re-fire the summary toast on each later pass.
- Task 4.2: minor (deferred): runbook G-6 SQL timestamp is database-session time, say so.
- Task 4.2: minor (deferred): rehearsal step 3 should say to apply the 2026-10-15 files to the copy if the pilot lacks them.
- Task 4.2: minor (deferred): Time Machine stored-snapshot restore has no dirtiness record, so a never-placed row's earlier unsaved attribute edit is not re-saved.
- Phase 4: minor (deferred): two eslint warnings in engine.test.mjs (unused `hours`, shadowed `fresh`) added by the Phase 3 fix wave; 0 errors so the gate holds. (Cleared by the fix round: the final lint run has 34 warnings, down from 36.)

**Unverified in Phase 4** (verbatim from the ledger, one per cannot-verify line, plus the unverified list of the Task 4.3 review):

- Task 4.1: ⚠️ cannot verify: did not run tests or the smoke script (read-only); test evidence taken from the implementer report
- Task 4.2: ⚠️ cannot verify: runbook gates (sslmode locally, proxy cache, revision on env change, Excel freeze, PITR) are platform facts the repo does not answer.
- Task 4.3 (runbook): review — 19 commands audited, 1 corrected (4c3df45); unverified left: local server accepting sslmode=require, proxy caching index.html, env-var change creating a revision, Excel upload freeze switch, platform PITR window, previous image's handling of flagged never-placed rows
- Task 4.3 (implementer report): the G-6 SQL and the Q15 SQL were not run against any database.

### Phase 4 — gate report

**Branch and range.** `feature/backward-scheduling` (Phase 3 complete at `96018a6`; Phase 1 tip `5fbdfb7`). Phase 4 itself is commits `96018a6..0b45e85` (Tasks 4.1 to 4.3: `41c8f0f`, `157f7da`, `b9ea599`, the review correction `4c3df45`, the fix round `0b45e85`). Range `5fbdfb7..0b45e85`: 46 commits, 116 files, +10237 / -2602. Whole-run range `0317dd8..0b45e85` (main at the start of the run to the branch tip): 68 commits, of which 22 are Phase 1 on `feature/backward-scheduling-phase1` (up to `5fbdfb7`) and 46 are on this branch. Nothing was pushed, merged or deployed (owner charter, plan section 0.2a).

**Tasks.**
- Task 4.1 (cutover migrations and the group 9 test; commits `96018a6..41c8f0f`): two migration files (`2026-10-20-0-orders-precutover-snapshot.sql`, `2026-10-20-1-backward-cutover.sql`), mirrored into `schema.sql`, pinned in `tests/test_schema_idempotent.py`, and `tests/test_backward_cutover.py` (one rolled-back transaction, both files run twice, the second run proven a no-op). Review: spec pass, quality Approved, 0 Critical, 0 Important (clean, no fix round). Both files were hand-applied to `nimbus_sdd`, which holds 0 orders.
- Task 4.2 (cutover image client bits; commits `41c8f0f..0b45e85`): `SCHEMA_VERSION` 7, `toast.cutover_summary` in five locales, the cutover pass and its four counts in the reconcile, the F10 fix (undo of a never-placed row stays display-only). Review: spec pass, quality Needs work, 0 Critical, 2 Important (I1 cutover pass inferred from a ratio, I2 F10 dropped the dirtiness of unrelated unsaved edits). One fix round (`0b45e85`) addressed both; the scoped re-review found no new Critical or Important. Complete after 1 fix round.
- Task 4.3 (cutover runbook, text only): written into `docs/DEPLOYMENT.md` ("Backward-scheduling cutover", 17 steps) in `b9ea599`. Never executed. The reviewer audited 19 commands and corrected one claim (`4c3df45`).

**Commands run and counts.**

| Command | At `b9ea599` (last code commit `157f7da`) | Final, at `0b45e85` |
|---|---|---|
| `npm test` legacy (`tests/js`) | 68 / 68 pass | 68 / 68 pass (implementer full run after the fix round) |
| `npm test` modules (`tests/modules`) | 1408 tests: 1403 pass, 2 fail, 3 todo; both fails are the known load-flaky optimizer spawn probe (`spawnSync ETIMEDOUT`, 8 lines; the Task 4.2 reviewer was running concurrently); `engine.test.mjs` rerun alone 162 / 162, 0 `ETIMEDOUT` | 1408 pass, 0 fail, 3 todo (implementer full run; the total test count is not recorded); `engine.test.mjs` rerun 162 / 162 |
| `python -m pytest tests/ -q` | 1780 passed, 2 failed (baseline `test_scale_catalog_paging` x2), 1 skipped, 13 xfailed | 1780 passed, 2 failed (same baseline pair), 1 skipped, 13 xfailed (re-run by the orchestrator at `0b45e85`) |
| `npm run lint` | 0 errors, 36 warnings (two new in `tests/modules/optimization/engine.test.mjs`: unused `hours`, shadowed `fresh`, from the Phase 3 fix wave) | 0 errors, 34 warnings (both cleared by the fix round; re-run by the orchestrator) |
| `npm run typecheck`, `check:static-assets`, `check:legacy-surface` | clean | clean at `b9ea599` and unchanged by `0b45e85` (the implementer ran them) |

Phase 3 gate for comparison: legacy 68 / 68; modules 1400 pass, 0 fail, 3 todo; pytest 1779 passed; lint 0 errors, 35 warnings.

**Baseline noise (pre-existing, not chased).** `tests/test_scale_catalog_paging.py` x2 (material-grid paging; local collation ordering, identical on the baseline commit); the three `knownFailure` todos in `calendar-sync-boundaries.test.mjs`; one load-flaky optimizer spawn probe in `engine.test.mjs` (`spawnSync ETIMEDOUT` when other work runs at the same time); one load-flaky `test_distribution.py::test_summary_counts_past_5000_headers` (passes alone); `scripts/schema_bootstrap_smoke.py` exits 1 on `main` already (ledger drift: `routing_runtime_legacy_backfill` is in the migrations-replay database and not in the `schema.sql`-only one; this branch adds nothing to it).

**Profile gates and the data effect.** The runbook makes Q13 (lines with no server hours row, which the reconcile skips) and Q15 (plants with no timezone, which the cutover and the reconcile cannot place) zero-count gates on the restored pilot copy before cutover. `nimbus_sdd` has 0 orders, so the cutover's data effect (placed finishes nulled, running rows keep start and end, every non-queued row flagged stale) is proven only by the rolled-back test fleet in `tests/test_backward_cutover.py`; it has not run against order data of any size.

**What was NOT done (owner charter: deploy nothing).** No `az` command, no `psql` against the pilot, no `/promote-azure`, no push, no merge to `main`, no browser run (every UI item is code and unit tests only), and the Task 4.3 runbook was written and audited but never executed, so the commands in it (including the Q15 and G-6 SQL) have not been run against any database.

**Open owner items carried forward.** Appendix A questions 1 to 5; Phase 0 item g (`trust_start` default); Q13 and Q15 = 0 before cutover; the Phase 1 hard-bound shift; the Task 3.5 manual run time carried into the collapse finish; the Phase 3 findings left per triage (F9, F11, F14, F17, F18, F19 and the F12 and F16 remainders; F10 was fixed in Task 4.2); the unverified runbook items above; the browser checks owed (Phase 2 and Phase 3 lists, plus the cutover summary toast and the G-10 rehearsal on a restored copy). The final owner report (`docs/superpowers/plans/2026-10-14-backward-scheduling-final-report.md`) lists them all.

**Not released.** Rollback = the branch is not merged.

### Resume point — start of Phase 3 (2026-10-14)

Phase 2 is complete at `e86a8b1` on `feature/backward-scheduling` (Phase 1 tip `5fbdfb7` on `feature/backward-scheduling-phase1`; `main` untouched; nothing pushed, merged or deployed). The run was paused here by the owner to clear context. To resume: read `.superpowers/sdd/2026-10-13-backward-scheduling-implementation/RESUME-PHASE-3.md` (operational brief: environment facts, the per-task dispatch/review loop and ledger contract, the Phase 3 order with every carry-in from the Phase 2 reviews, the Phase 3 gate, Phase 4 and the final-report contents), then the ledger `progress.md` in the same folder as needed. The Phase 3–4 task briefs are already extracted there (`task-3.1-brief.md` … `task-4.3-brief.md`) with the shared context `phase2-3-shared-context.md`. First dispatch on resume: Task 3.1 with BASE `e86a8b1`. The Postgres password is supplied by the owner at session start and is never written down.

Final owner report (every gap table above verbatim, the 30 rulings, open owner questions, browser checks owed, how to take it live): `docs/superpowers/plans/2026-10-14-backward-scheduling-final-report.md`.

## Appendix B — Context

**Brief.** Owner (2026-10-13): "I want to implement Backward_Scheduling_Migration. Draw up an implementation plan that has Sonnet do ALL the work except for very low risk changes for Haiku."

**Owner answers during planning (2026-10-13).**
- Cutover run: "Automatic on first load" — the migration flags every row stale; the first browser to load a plant under the new image re-derives and the first Save persists (over the recommended admin button and the offline-precompute script).
- Phase 2/3 parallelism: "Sequential" — one implementer at a time on the feature branch.
- Autonomy (second prompt): run Phases 1–4 completely autonomously; stop only for a truly large deviation; fill small gaps and record them in an appended section of the .md and in the final report; deploy nothing; branches only, no merge to `main`; local Postgres via `.env` plus owner-supplied `postgres` credentials (env vars only).

**Findings that shaped the plan.** No server calendar (every derivation is browser-side, so the cutover is a flag-and-reconcile, not an identity write); the echo overwrites the due date in four places plus a fifth writer found during planning; only ~4 % of tests pin the forward rule, so the 33 new-test groups are the gate; every deploy ships all of `main`, hence the feature branch; the deploy runner's destructive-by-text filter dictates file naming and separate runs; the locale ratchet has zero headroom.

**Rejected alternatives.** Per-plant switch or dormant code (ruled out by O3); new placed-finish column (OQ32 rejected by owner; re-purpose `scheduled_end`); identity-preserving cutover (OQ5 rejected; bulk re-derive from due dates); admin-run cutover action and offline SQL precompute (owner chose first-load); guard-only due-date protection (OQ31 rejected; locked columns); Send of unfirmed orders with a split summary (OQ61 rejected; firmed only); parallel worktrees for Phases 2/3 (owner chose sequential); Reading B in any form (deferred).

**Spec sections this plan relies on.** §1.6 (decisions), §12 (decision text), §7 (phases and gates), §8.4–8.8 and §8.13 (runner, first-load paths, rollback, runbook), §10.2 and §10.5 (tests to flip and add), §6.2 (never-placed read rule, superseded by OQ33 A), §4.1–4.12 (anchors; verified at HEAD 0317dd8).
