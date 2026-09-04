# Code Review Verification & Backlog Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two items keeping `Code_Review_09_01.md` at 🟡 instead of 🟢 — run the two written-but-unverified DB tests for real, and add the still-missing test coverage for the Excel/BOM ingest data layer — then, before touching anything else in the backlog, explicitly re-confirm with the user whether P1-9 (unbounded setup snapshot) and P1-7 (optimizer preview staleness) are still worth doing rather than assuming they are.

**Architecture:** Tasks 1–3 are verification-only against a local Postgres instance (`NIMBUS_TEST_DB=1`) — no production code changes unless a real bug is found, in which case fix root cause + rerun. Task 4 adds one new pytest file exercising the real (non-mocked) ingest functions in `db.py`/`master_data.py` against real Postgres, following the exact `@pytest.mark.pg` / `pg` fixture / `ZZTEST_`-prefixed-row pattern already established in `tests/test_task_concurrency.py` and `tests/test_frozen_horizon.py`. Task 5 is a hard stop: an `AskUserQuestion` checkpoint re-litigating scope for P1-9/P1-7 before any implementation plan is written for either.

**Tech Stack:** Python, pytest, psycopg (via `db._pool`), pandas (`.xlsx` fixture generation), local PostgreSQL 18.

**Spec:** `Code_Review_09_01.md` (the review this plan closes out) — §0/§0.4 remediation history, §10 "Testing Gaps" items 1, 2, 4, §12 "Overall Assessment" (states items 1 and 4 below are what's blocking the 🟢 rating).

## Global Constraints

- DB-integration tests **require** `NIMBUS_TEST_DB=1` and a **local** Postgres host (`localhost`/`127.0.0.1`/`::1`/`postgres` only) — enforced by `tests/support/db_safety.py`'s `validate_test_database`. Never point `.env`'s `PG_HOST` at the Azure pilot to satisfy this.
- All new/existing DB-integration tests follow the repo's established real-DB pattern: `@pytest.mark.pg`, the session-scoped `pg` fixture (`tests/conftest.py:112-117`, returns the `db` module, auto-skips if Postgres is unreachable), and self-contained `ZZTEST_`-prefixed rows created and deleted by the test itself (see `tests/test_task_concurrency.py`, `tests/test_frozen_horizon.py`).
- No code changes to production logic in Tasks 1–4 unless a test run surfaces a genuine bug — if that happens, fix the root cause, add/extend the regression test inline, and record the correction in the commit message (matching this doc's own convention of recording "real corrections found during implementation").
- Do not start any implementation work on P1-9 or P1-7 before Task 5's checkpoint resolves — that is the whole point of this plan's ordering.
- Verification commands for every task: `npm run build && npm run typecheck && npm run lint` are **not** required for these Python-only changes; only `python -m pytest tests/ -q` (plus the specific `-k`/file-scoped run named in each task) is required per task.
- **This worktree has no `.env` and no `.venv` of its own** (both are gitignored/untracked, so a fresh worktree checkout starts without them). Every Python invocation in this plan must (a) use the main checkout's interpreter directly via its absolute path — `"C:\Users\PJ29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Claude\.venv\Scripts\python.exe"` — and (b) set `PG_HOST`, `PG_PORT`, `PG_DB`, `PG_USER`, `PG_PASS`, and `NIMBUS_TEST_DB=1` explicitly as environment variables on the command line (never read from a `.env` file, since none exists here and the shared repo's `.env` points at a non-local host anyway — see §0 note below). **The controller (not the implementer subagent) supplies `PG_PASS`/`PGPASSWORD`** — no task in this plan passes the database password to an implementer; the controller runs any command that needs real DB credentials itself.

---

### Task 1: Confirm a safe local Postgres is reachable for `NIMBUS_TEST_DB=1`

**Files:**
- Read-only check: local Postgres connectivity only (not `.env` — see Global Constraints).
- No file modifications expected in this task.

**Interfaces:**
- Consumes: `tests/support/db_safety.py`'s `validate_test_database(host, database, *, opted_in)` — raises `UnsafeTestDatabase` if `host` isn't in `LOCAL_TEST_HOSTS` or `opted_in` is falsy.
- Produces: a confirmed-safe local Postgres reachable at `PG_HOST=localhost` for Tasks 2–4.

- [x] **Step 1: Confirm the local server is running and a `nimbus` database with the full schema exists**

Already confirmed by the controller directly (2026-09-04): `psql -U postgres -h localhost -l` lists a local `nimbus` database, and `\dt` against it shows the full schema (`orders`, `bom_items`, `material_plants`, `materials`, `machine`, `schema_migrations`, etc.) already loaded. No `schema.sql` bootstrap needed.

- [x] **Step 2: Confirm the shared repo `.env` is NOT local (informational only — do not edit it)**

Already confirmed by the controller directly (2026-09-04): loading the shared repo `.env` via `python-dotenv` resolves `PG_HOST` to a non-local value. This does **not** block anything in this plan — every command below sets `PG_HOST=localhost` (and the other `PG_*` vars) explicitly as real process environment variables, and `python-dotenv`'s `load_dotenv()` (used with its default `override=False`) never replaces an already-set environment variable. So passing these on the command line safely wins over whatever `.env` contains, with no file edits.

- [ ] **Step 3: Confirm pytest actually collects the `pg`-marked tests when opted in, from THIS worktree**

Run from this worktree's root, using the main checkout's interpreter and explicit local env vars (controller runs this step — it needs `PG_PASS`):

```bash
PG_HOST=localhost PG_PORT=5432 PG_DB=nimbus PG_USER=postgres PG_PASS='<local password>' NIMBUS_TEST_DB=1 \
  "/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  -m pytest tests/ -q --collect-only -m pg
```
Expected: a nonzero list of collected test items (not "0 tests collected", and no `pytest.UsageError` from the DB-safety guard).

- [ ] **Step 4: No commit** — this task only confirms environment state; nothing changed in the repo.

---

### Task 2: Run and verify `tests/test_task_concurrency.py` against real Postgres

**Files:**
- Test (existing, run only): `tests/test_task_concurrency.py`
- Possible fix target if a bug is found: `db.py` (`update_task_dates_bulk`, `get_task_versions`)
- Doc update: `Code_Review_09_01.md` (§10 item 1, §12)

**Interfaces:**
- Consumes: `pg` fixture from Task 1; `db.update_task_dates_bulk(list[dict]) -> {"persisted": int, "stale": list, "versions": dict}`; `db.get_task_versions(ids: list[str]) -> list[dict]` (each row has `row_version`).
- Produces: a verified-passing (or verified-and-fixed) xmin-conflict regression test — the primary claim blocking this review's 🟢 rating.

**Note: this task's commands require `PG_PASS` — the controller runs Steps 1–3 directly rather than delegating to a subagent.** If Step 2b's fix is needed, a fix subagent may be dispatched for the code change itself (no DB credentials required to edit `db.py`), but the controller reruns the test to confirm.

- [ ] **Step 1: Run the test file directly**

```bash
PG_HOST=localhost PG_PORT=5432 PG_DB=nimbus PG_USER=postgres PG_PASS='<local password>' NIMBUS_TEST_DB=1 \
  "/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  -m pytest tests/test_task_concurrency.py -v
```
Expected: both tests in `TestUpdateTaskDatesBulkXminConflict` PASS. If Postgres is reachable but the test is `SKIPPED`, re-check Task 1 Step 3 (env vars not actually exported on this exact command) before treating it as a pass.

- [ ] **Step 2a (if PASS): Update the review doc's status inline**

Edit `Code_Review_09_01.md` in this worktree, the §10 item 1 line (currently `🟡 PARTIAL: ... unverified by an actual run`) to read verified, and note the run date. Then commit (this worktree's branch merges back into `main` at the end via `finishing-a-development-branch`, so the doc update travels with the code changes rather than editing `main` directly out from under an active worktree):
```bash
git add Code_Review_09_01.md
git commit -m "docs: confirm xmin-conflict test verified passing against real Postgres"
```

- [ ] **Step 2b (if FAIL): Diagnose before touching test code**

Read the failure output carefully — this test exercises the exact bug class ("the bug class that has already fired twice" per the file's own docstring). Do **not** loosen the assertion to make it pass. Likely failure shapes and what they'd mean:
- `first["versions"][self.oid] == base_version` (xmin didn't bump) → a real regression in `update_task_dates_bulk`'s `RETURNING xmin::text::bigint` clause or the `UPDATE`'s `WHERE` predicate silently matching zero rows.
- Second write's `base_version` not landing in `stale` → the optimistic-concurrency `WHERE xmin::text::bigint = %s` guard itself is broken.

Fix the root cause in `db.py` (in this worktree), rerun Step 1 until it passes, then:
```bash
git add db.py tests/test_task_concurrency.py
git commit -m "fix: restore xmin optimistic-concurrency guard on update_task_dates_bulk"
```
(Only touch `tests/test_task_concurrency.py` if the test itself had a genuine bug, not to relax a correct assertion.) The `Code_Review_09_01.md` doc update happens separately in this worktree as in Step 2a.

- [ ] **Step 3: Run the full Python suite once to confirm no collateral breakage**

```bash
PG_HOST=localhost PG_PORT=5432 PG_DB=nimbus PG_USER=postgres PG_PASS='<local password>' NIMBUS_TEST_DB=1 \
  "/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  -m pytest tests/ -q
```
Expected: same pass/skip counts as this doc's last recorded baseline (313 passed, 104 skipped as of §0.4) plus these newly-unskipped `pg` tests, zero new failures.

---

### Task 3: Run and verify `scripts/schema_bootstrap_smoke.py` against scratch Postgres

**Files:**
- Script (existing, run only): `scripts/schema_bootstrap_smoke.py`
- Possible fix target if a bug is found: `schema.sql`, `migrations/*.sql`
- Doc update: `Code_Review_09_01.md` (§10 item 4, §12)

**Interfaces:**
- Consumes: a local `psql` (found at `"C:\Program Files\PostgreSQL\18\bin\psql.exe"` on this machine), `PGPASSWORD` in the environment, and a Postgres server reachable at `--host`/`--port`/`--user` (defaults to `localhost`/`5432`/`postgres` per the script's own usage docstring). **This script CREATEs and DROPs its own scratch databases — never point it at anything but local Postgres.**
- Produces: confirmation that `schema.sql` bootstraps a truly empty database end-to-end (the literal P0-3 regression) and that the current-schema-compatible migration subset replays idempotently on top of it.

**Note: this task requires `PGPASSWORD` — the controller runs it directly.**

- [ ] **Step 1: Run the smoke script from this worktree**

```bash
PGPASSWORD='<local password>' \
  "/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  scripts/schema_bootstrap_smoke.py --host localhost --port 5432 --user postgres \
  --psql "C:\Program Files\PostgreSQL\18\bin\psql.exe"
```
Expected: exit code `0`. The script prints which frozen legacy/hand-applied cutover migrations it skips (expected, by design — not a failure) and then reports the `orders` column-shape match, the structural fingerprint match, and the data/ledger contract match.

- [ ] **Step 2a (if exit 0): Update the review doc's status inline**

Edit `Code_Review_09_01.md` in this worktree's §10 item 4 line (currently `🟡 PARTIAL ... unverified by an actual run`) to record the verified pass and the date. Then commit:
```bash
git add Code_Review_09_01.md
git commit -m "docs: confirm schema_bootstrap_smoke.py verified passing against real Postgres"
```

- [ ] **Step 2b (if nonzero exit): Diagnose which of the three checks failed**

The script's own output names which step failed (the `schema.sql` bootstrap itself, the migration replay, or one of the three comparisons). This is the literal P0-3 class of bug (index/column ordering, or a migration that isn't actually idempotent) — fix `schema.sql` or the offending file under `migrations/` in this worktree, rerun Step 1, then:
```bash
git add schema.sql migrations/
git commit -m "fix: correct schema bootstrap ordering found by schema_bootstrap_smoke.py"
```

---

### Task 4: Add real-DB test coverage for the Excel/BOM ingest data layer

**Context:** `tests/test_integration_routes.py` only exercises the `/upload`, `/bom/upload`, `/purge` **routes** with `db.ingest_orders_from_excel` / `master_data.ingest_bom_from_excel` mocked out (verified directly: `monkeypatch.setattr(int_routes.db, "ingest_orders_from_excel", fake_ingest)` at `tests/test_integration_routes.py:83`). The actual parsing/upsert logic inside `db.ingest_orders_from_excel` (`db.py:2190`), `master_data.ingest_bom_from_excel` (`master_data.py:2474`), and `db.purge_orders_by_date` (`db.py:1242`) has never been driven against a real database — this is §10 item 2's "P0-equivalent gap."

**This is the one task in this plan suited to an implementer subagent.** It is pure file creation from a fully-specified test (the plan below contains the complete, runnable code — this is transcription, not design), and it needs NO database credentials to write. The subagent writes the file and self-checks it with `--collect-only` (which does not require a live DB connection or `NIMBUS_TEST_DB=1`). The controller runs the real DB pass/fail afterward.

**Files:**
- Create: `tests/test_ingest_data_layer.py`
- Test (real-DB, `@pytest.mark.pg`)

**Interfaces:**
- Consumes: `pg` fixture (returns `db` module); `db.ingest_orders_from_excel(file_bytes: bytes, filename: str) -> dict` (keys: `status`, `batch_id`, `raw_row_count`, `inserted`, `updated`, `warnings`); `master_data.ingest_bom_from_excel(file_bytes: bytes, filename: str, user_email: str|None) -> dict` (keys: `status`, `raw_row_count`, `inserted`, `updated`, `rejected`, `warnings`); `db.purge_orders_by_date(start, end) -> {"status": "ok", "deleted": int}`.
- Produces: durable regression coverage on the widest bulk-write blast radius in the app, closing §10 item 2.

- [ ] **Step 1: Write the test file**

```python
"""
Real-DB coverage for the Excel/BOM ingest data layer (db.ingest_orders_from_excel,
master_data.ingest_bom_from_excel, db.purge_orders_by_date).

Plan reference: docs/superpowers/plans/2026-09-04-code-review-verification-triage.md,
Task 4 -- Code_Review_09_01.md section 10 item 2 ("backend/integration/ has zero
coverage ... the widest bulk-write blast radius in the app"). Existing
tests/test_integration_routes.py only exercises the /upload, /bom/upload, /purge
ROUTES with these three functions mocked out -- this file drives the real
parsing/upsert SQL against a real Postgres connection instead.

Requires a local Postgres with NIMBUS_TEST_DB=1 (see tests/conftest.py) --
auto-skipped otherwise.
"""
import datetime as dt
import io

import pandas as pd
import pytest

import master_data


def _xlsx(rows: list[dict]) -> bytes:
    buf = io.BytesIO()
    pd.DataFrame(rows).to_excel(buf, index=False)
    return buf.getvalue()


@pytest.mark.pg
class TestIngestOrdersFromExcelRealDb:
    ORDER, MATERIAL, PLANT, MACHINE = (
        "ZZTEST_ING_ORD", "ZZTEST_ING_MAT", "ZZTEST_ING_PLANT", "ZZTEST_ING_LINE",
    )

    @pytest.fixture(autouse=True)
    def _cleanup(self, pg):
        db_ = pg
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM orders WHERE production_order = %s", (self.ORDER,)
            )
            cur.execute(
                "DELETE FROM upload_audit WHERE filename LIKE 'zztest_ingest%%'"
            )
            conn.commit()

    def test_insert_then_reupload_updates_same_row_not_a_duplicate(self, pg):
        """First upload inserts one row; a second upload of the SAME
        production_order/material with a changed start date must UPDATE that
        row in place, not insert a second one -- this is the literal
        replace-on-reupload contract the ingest path is supposed to honor."""
        db_ = pg
        start_1 = "2026-09-10 08:00"
        workbook_1 = _xlsx([{
            "PRODUCTION_ORDER": self.ORDER,
            "MATERIAL_NUMBER": self.MATERIAL,
            "WERKS": self.PLANT,
            "MACHINE": self.MACHINE,
            "BASIC_START_DATE": start_1,
        }])

        result_1 = db_.ingest_orders_from_excel(workbook_1, "zztest_ingest_1.xlsx")
        assert result_1["status"] == "ok"
        assert result_1["inserted"] == 1
        assert result_1["updated"] == 0

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*), MIN(basic_start_date) FROM orders WHERE production_order = %s",
                (self.ORDER,),
            )
            count, first_start = cur.fetchone()
        assert count == 1

        start_2 = "2026-09-11 09:00"
        workbook_2 = _xlsx([{
            "PRODUCTION_ORDER": self.ORDER,
            "MATERIAL_NUMBER": self.MATERIAL,
            "WERKS": self.PLANT,
            "MACHINE": self.MACHINE,
            "BASIC_START_DATE": start_2,
        }])
        result_2 = db_.ingest_orders_from_excel(workbook_2, "zztest_ingest_2.xlsx")
        assert result_2["status"] == "ok"
        assert result_2["updated"] == 1
        assert result_2["inserted"] == 0

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*), MIN(basic_start_date) FROM orders WHERE production_order = %s",
                (self.ORDER,),
            )
            count_after, start_after = cur.fetchone()
        assert count_after == 1, "reupload must UPDATE the existing row, not insert a duplicate"
        assert start_after != first_start, "the updated start date must actually persist"

    def test_missing_required_column_rejects_with_zero_rows_written(self, pg):
        """A workbook missing BASIC_START_DATE must be rejected before any
        row is written -- the required-columns guard at db.py:2248-2256."""
        db_ = pg
        workbook = _xlsx([{
            "PRODUCTION_ORDER": self.ORDER,
            "MATERIAL_NUMBER": self.MATERIAL,
        }])
        result = db_.ingest_orders_from_excel(workbook, "zztest_ingest_bad.xlsx")
        assert result["status"] == "error"
        assert result["inserted"] == 0
        assert result["updated"] == 0

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM orders WHERE production_order = %s", (self.ORDER,)
            )
            (count,) = cur.fetchone()
        assert count == 0


@pytest.mark.pg
class TestIngestBomFromExcelRealDb:
    MATERIAL, COMPONENT, UNKNOWN_COMPONENT, PLANT = (
        "ZZTEST_BOM_MAT", "ZZTEST_BOM_COMP", "ZZTEST_BOM_NOPE", "ZZTEST_BOM_PLANT",
    )

    @pytest.fixture(autouse=True)
    def _seed_and_cleanup(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            for mat in (self.MATERIAL, self.COMPONENT):
                cur.execute(
                    "INSERT INTO materials (material_id) VALUES (%s) "
                    "ON CONFLICT (material_id) DO NOTHING",
                    (mat,),
                )
                cur.execute(
                    "INSERT INTO material_plants (material_id, plant) VALUES (%s, %s) "
                    "ON CONFLICT (material_id, plant) DO NOTHING",
                    (mat, self.PLANT),
                )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM bom_items WHERE material_id = %s", (self.MATERIAL,)
            )
            cur.execute(
                "DELETE FROM material_plants WHERE material_id IN (%s, %s)",
                (self.MATERIAL, self.COMPONENT),
            )
            cur.execute(
                "DELETE FROM materials WHERE material_id IN (%s, %s)",
                (self.MATERIAL, self.COMPONENT),
            )
            conn.commit()

    def test_valid_row_inserts_and_unknown_pair_is_rejected_not_hard_failed(self, pg):
        """A row referencing a real (material, plant) / (component, plant)
        pair in material_plants must insert into bom_items; a row referencing
        an unknown component must be individually rejected (warnings +
        rejected count) WITHOUT failing the rest of the upload -- the
        documented per-row-reject behavior at master_data.py:2474-2486."""
        workbook = _xlsx([
            {
                "MATERIAL": self.MATERIAL, "PLANT": self.PLANT,
                "ALTERNATIVE_BOM": "01", "LEVEL": 1, "ITEM_NUMBER": "0010",
                "COMPONENT": self.COMPONENT,
            },
            {
                "MATERIAL": self.MATERIAL, "PLANT": self.PLANT,
                "ALTERNATIVE_BOM": "01", "LEVEL": 1, "ITEM_NUMBER": "0020",
                "COMPONENT": self.UNKNOWN_COMPONENT,
            },
        ])

        result = master_data.ingest_bom_from_excel(workbook, "zztest_bom.xlsx", "tester@example.com")
        assert result["status"] == "ok"
        assert result["inserted"] == 1
        assert result["rejected"] == 1
        assert any("not found at plant" in w["msg"] for w in result["warnings"])

        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT component_id FROM bom_items WHERE material_id = %s AND plant = %s",
                (self.MATERIAL, self.PLANT),
            )
            rows = [r[0] for r in cur.fetchall()]
        assert rows == [self.COMPONENT]


@pytest.mark.pg
class TestPurgeOrdersByDateRealDb:
    ORDER, MATERIAL, PLANT, MACHINE = (
        "ZZTEST_PURGE_ORD", "ZZTEST_PURGE_MAT", "ZZTEST_PURGE_PLANT", "ZZTEST_PURGE_LINE",
    )

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        self.oid = db_.make_id(self.ORDER, self.MATERIAL)
        self.finish = now + dt.timedelta(days=2)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (self.oid,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (self.oid, self.ORDER, self.MATERIAL, self.MACHINE, self.PLANT,
                 self.finish - dt.timedelta(hours=4), self.finish),
            )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (self.oid,))
            conn.commit()

    def test_deletes_only_rows_in_range_by_effective_end_date(self, pg):
        db_ = pg
        out_of_range_start = self.finish + dt.timedelta(days=30)
        out_of_range_end = self.finish + dt.timedelta(days=31)
        result_miss = db_.purge_orders_by_date(out_of_range_start, out_of_range_end)
        assert result_miss["status"] == "ok"
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = %s", (self.oid,))
            (still_there,) = cur.fetchone()
        assert still_there == 1, "purge must not delete rows outside the requested range"

        in_range_start = self.finish - dt.timedelta(days=1)
        in_range_end = self.finish + dt.timedelta(days=1)
        result_hit = db_.purge_orders_by_date(in_range_start, in_range_end)
        assert result_hit["status"] == "ok"
        assert result_hit["deleted"] >= 1
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = %s", (self.oid,))
            (gone,) = cur.fetchone()
        assert gone == 0
```

- [ ] **Step 2: Self-check the file WITHOUT a live DB connection (implementer runs this — no credentials needed)**

```bash
"/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  -m pytest tests/test_ingest_data_layer.py --collect-only -v
```
Expected: 4 tests collected with no import/syntax errors (they will not RUN — `NIMBUS_TEST_DB` is not set for this step, so they're skip-eligible, but `--collect-only` never executes them, so no DB connection is attempted). If this errors, fix the import/syntax issue and retry — this is the implementer's own self-check gate.

- [ ] **Step 3: Commit**

```bash
git add tests/test_ingest_data_layer.py
git commit -m "test: add real-DB coverage for Excel/BOM ingest and purge data layer"
```

- [ ] **Step 4 (controller only, after the implementer's report — requires `PG_PASS`): Run it against real Postgres**

```bash
PG_HOST=localhost PG_PORT=5432 PG_DB=nimbus PG_USER=postgres PG_PASS='<local password>' NIMBUS_TEST_DB=1 \
  "/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  -m pytest tests/test_ingest_data_layer.py -v
```
Expected: all 4 tests PASS.

- [ ] **Step 5a (if PASS): commit the doc update in this worktree**

Update `Code_Review_09_01.md` §10 item 2's line from "OPEN, not addressed this pass" to record this file and the date, then:
```bash
git add Code_Review_09_01.md
git commit -m "docs: record ingest data-layer test coverage closing section 10 item 2"
```

- [ ] **Step 5b (if a test fails against real Postgres): diagnose before assuming the test is wrong**

Read the actual column names/constraints the failure reports against the real schema (it may have drifted from what's described above if migrations were applied out of order). If the failure reveals a genuine defect in `db.ingest_orders_from_excel` / `master_data.ingest_bom_from_excel` / `db.purge_orders_by_date`, that is real, code-fixable work — dispatch a fix subagent for the production-code fix (it needs no DB credentials to edit `db.py`/`master_data.py`), then the controller reruns Step 4 to confirm. If the failure is a legitimate schema/column mismatch in the test itself (e.g. a column renamed since this plan was written), the same fix subagent can correct the test — note the correction in the commit message.

- [ ] **Step 6: Run the full suite once more and record the new totals**

```bash
PG_HOST=localhost PG_PORT=5432 PG_DB=nimbus PG_USER=postgres PG_PASS='<local password>' NIMBUS_TEST_DB=1 \
  "/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  -m pytest tests/ -q
```

---

### Task 5: Checkpoint — re-ask whether P1-9 and P1-7 are still needed

**This is a decision gate, not an implementation task. Do not write a plan, open a branch, or touch any P1-9/P1-7 code in this task.**

**Files:** none.

**Interfaces:** none — this step produces a decision, which becomes the input to whatever plan (if any) comes next.

- [ ] **Step 1: Re-state the current facts for each item, since the ground may have shifted after Tasks 1–4**

- **P1-9** (`backend/setup/data.py:656-711,888-922`): `GET /setup/{plant}` and `/coverage` remain unbounded O(states²) fetches. Last investigated 2026-09-02 (`Code_Review_09_01.md` §0.3): deliberately not implemented because the frontend's `resolveSetup` genuinely needs the full snapshot today, and a real fix means restructuring `resolveSetup` to fetch lazily per-machine — a redesign, not a quick bound. Nothing in Tasks 1–4 changes this calculus.
- **P1-7** (`frontend/optimization/optimize-ui.mts:1141-1361,1764-1842`): `OptimizerPreview.stale` doesn't detect a concurrent `tasks:bulkUpdate` while a preview is open. Still open, scoped as a P2 refactor. Note: the *related* What-If sandbox side-effect gaps (discard not restoring `Store.lastOptimize`/alert dismissals/Confidence) were separately **resolved** on 2026-09-03 (`0d2ad4f`, `98a50b1`, `6e518b2`, `8aa0906` — see `Code_Review_09_01.md` §0.5) — confirm P1-7 itself is genuinely still unaddressed and not accidentally closed as a side effect of that work before asking.

- [ ] **Step 2: Ask the user directly with `AskUserQuestion`, one question per item (or combined if they'd rather answer together), covering at minimum:**
  - Is this still worth doing now, given current priorities (vs. deferring further, downgrading the severity, or closing as accepted/won't-fix)?
  - If yes: does it get its own plan now, or queue behind something else?
  - If P1-9: is the real redesign (lazy per-machine fetch integrated into `resolveSetup`) still the right shape, or has the setup-matrix admin UI's usage pattern changed since 2026-09-02 in a way that changes the fix?

- [ ] **Step 3: Record the outcome**

Whatever the answer, update `Code_Review_09_01.md`'s §11 action-plan lines 13/14 (currently `⏳ OPEN, unchanged`) to reflect the decision — either "confirmed still needed, plan pending" with a date, or "downgraded/closed by explicit user decision on <date>" with the reasoning, matching this doc's existing convention for recording decisions (see how OD-E2/OD-E3's rationale was recorded in §0.2). Commit the doc update only, in this worktree:
```bash
git add Code_Review_09_01.md
git commit -m "docs: record P1-9/P1-7 scope decision after re-ask checkpoint"
```

- [ ] **Step 4: Stop here.** Do not proceed to plan or implement P1-9/P1-7 in this plan — that is deliberately a separate plan, scoped only after Step 2's answer is in hand.

---

## Self-Review Notes

- **Spec coverage:** Task 1 → environment precondition for all `pg`-marked tests (§0.4/§0/§10's repeated blocker). Task 2 → §10 item 1 / §12's stated blocker to 🟢. Task 3 → §10 item 4 / §12's other stated blocker. Task 4 → §10 item 2, the one testing gap with zero prior work across all five remediation passes. Task 5 → directly answers the user's "re-ask if 3/4 are genuinely needed" instruction for P1-9/P1-7 before any further plan is drafted.
- **Placeholder scan:** no TBD/"add appropriate handling" left in any step; Task 4's test code is complete and runnable, not sketched.
- **Type/name consistency:** `pg` fixture returns the `db` module throughout (matches `tests/conftest.py:112-117`); `db._pool.connection()` / `cur.execute` pattern matches every existing real-DB test cited; `master_data.ingest_bom_from_excel`'s return-dict keys (`status`, `inserted`, `rejected`, `warnings`) match the real function body read directly from `master_data.py:2474-2560`.
- **Worktree correction (added when this plan was copied into its execution worktree):** the worktree has no `.env`/`.venv` of its own — every command now sets `PG_*`/`NIMBUS_TEST_DB` explicitly and uses the main checkout's `.venv` interpreter by absolute path, and no task passes DB credentials to an implementer subagent (Global Constraints, Task 3/4 notes).
