# P1-9 Setup Snapshot Machine-Roster Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close P1-9 (`Code_Review_09_01.md` §2, §11 item 13) — `GET /setup/{plant}`'s unbounded matrix fetch — by scoping `backend/setup/data.py`'s `get_setup_snapshot` to the plant's live machine roster instead of every machine code that has ever recorded a setup-matrix row for that plant.

**Architecture:** One backend-only change. `get_setup_snapshot(plant)` first resolves the plant's live machine set (machines registered in master data for this plant, unioned with any machine already appearing on a loaded order for this plant), then scopes the `setup_matrix`/`machine_setup_state`/`setup_occurrence_override` queries to `machine = '' OR machine = ANY(live_machines)`. The response shape, the route (`GET /setup/{plant}`), and every frontend consumer (`Persistence.loadSetupSnapshot`, `Store.setupSnapshot`, `resolveSetup`, `deriveSetupObservation`, `Engine.runAndApply('changeover', …)`) are **completely unchanged** — this plan touches zero frontend files. No new endpoint, no new query params, no caller-visible contract change.

**Tech Stack:** Python, psycopg (parameterized SQL), pytest (mocked-cursor unit tests + a real-Postgres regression test).

**Spec:** `Code_Review_09_01.md` — P1-9 (§2, currently reads "confirmed still needed, plan pending" per the 2026-09-04 re-ask checkpoint), §11 item 13, §0.3 (records why literal per-call lazy fetching inside `resolveSetup` was investigated and rejected — this plan implements the machine-roster-bounding alternative confirmed at the follow-up checkpoint instead).

## Global Constraints

- `resolveSetup` (`frontend/setup/setup-domain.mts`) stays untouched — it is a pure, synchronous function with zero network/cache dependency by design (its own header comment), and this plan does not change that contract.
- The `SetupSnapshot` response shape (`plant`, `definition`, `plant_rows`, `machine_rows`, `machine_states`, `overrides`, `plant_active`) is unchanged — only which rows populate `machine_rows`/`machine_states`/`overrides` changes (a subset, never a superset, never a different shape).
- `plant_rows` (rows where `machine = ''`, the plant-default tier) are **never** machine-scoped — they are the single fallback tier every machine on the plant inherits from, not multiplied per machine, and excluding them would silently break the plant-default resolution path.
- The live-machine-set query must use only `plant` as the filter (no `subnetwork`) — every other query in this domain (and `orders`, `idx_lines_plant_only`) filters `machine`/`orders` by `plant` alone; introducing a stricter `(subnetwork, plant)` join here would be a new, untested constraint no sibling query relies on.
- Do not touch `get_setup_coverage`/`/coverage` — already bounded (`26f82d3`, `08ff97e`, per `Code_Review_09_01.md` §0.5) and out of scope for this plan.
- Verification per task: `python -m pytest tests/test_setup_data.py tests/test_setup_coverage.py tests/test_setup_endpoints.py -q` (per `backend/setup/CLAUDE.md`'s documented test command for this domain), plus a full-suite run before considering the plan done.

---

### Task 1: Scope `get_setup_snapshot`'s machine-dimension queries to the plant's live machine roster

**Files:**
- Modify: `backend/setup/data.py:665-720` (`get_setup_snapshot`)
- Test: `tests/test_setup_data.py`

**Interfaces:**
- Consumes: nothing new — same `plant: str` parameter `get_setup_snapshot` already takes.
- Produces: `get_setup_snapshot(plant: str) -> dict` — same return shape as today (`{"plant", "definition", "plant_rows", "machine_rows", "machine_states", "overrides"}`), with `machine_rows`/`machine_states`/`overrides` now filtered to machines in the plant's live roster. No caller (routes.py's `get_setup`, or anything else in the codebase — grep-verified `get_setup_snapshot` has exactly one caller, `backend/setup/routes.py`'s `get_setup`) needs any change.

- [ ] **Step 1: Read the current function once more to confirm line numbers before editing**

```bash
grep -n "^def get_setup_snapshot" backend/setup/data.py
```
Expected: `665:def get_setup_snapshot(plant: str) -> dict:` (if this has drifted, re-read the function body before editing — line numbers in this plan are a starting point, not gospel).

- [ ] **Step 2: Add the live-machine-set query and thread it into the three downstream queries**

Replace the body of `get_setup_snapshot` (currently `backend/setup/data.py:665-720`) with:

```python
def get_setup_snapshot(plant: str) -> dict:
    """Return exactly one plant's versioned setup truth; no cross-plant rows leak.

    machine_rows/machine_states/overrides are scoped to the plant's LIVE
    machine roster (registered in master data for this plant, or already
    appearing on a loaded order for this plant) -- not every machine code
    that has ever recorded a setup-matrix row for this plant. This bounds
    the payload to the plant's actual current machine count (the Production
    Scale Roadmap's "70+ machines per plant" target) instead of an unbounded
    historical superset that can accumulate renamed/decommissioned/typo'd
    machine codes over time -- see Code_Review_09_01.md P1-9. plant_rows
    (machine = '') are the single plant-default fallback tier and are never
    machine-scoped -- every machine on the plant inherits from them.

    A machine that is neither registered nor yet on a loaded order (e.g. a
    brand-new machine added to master data and immediately assigned a task
    within the same session, before the next snapshot refetch) resolves to
    setup-domain.mts's existing 'uncovered' fallback rather than a wrong
    non-zero value -- the same honest fallback a genuinely unconfigured
    machine already gets today.
    """
    plant = _required_text(plant, "Plant")
    with _pool.connection() as conn, conn.cursor() as cur:
        # One repeatable-read transaction prevents a definition edit from
        # interleaving with its version-filtered dependent rows mid-snapshot.
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        definition = _definition(cur, plant)
        if definition is None:
            return {"plant": plant, "definition": None, "plant_rows": [], "machine_rows": [],
                    "machine_states": [], "overrides": []}
        version = definition["signature_version"]
        cur.execute(
            """SELECT machine FROM machine WHERE plant = %s
               UNION
               SELECT DISTINCT machine FROM orders WHERE plant = %s AND machine IS NOT NULL""",
            (plant, plant),
        )
        live_machines = [r[0] for r in cur.fetchall()]
        cur.execute(
            """SELECT machine, signature_version, from_key, to_key, setup_min, source, source_metadata,
                      source_reference, created_by, created_at, updated_by, updated_at
                 FROM setup_matrix
                WHERE plant = %s AND signature_version = %s AND (machine = '' OR machine = ANY(%s))
                ORDER BY machine, from_key, to_key""",
            (plant, version, live_machines),
        )
        matrix = [
            {"machine": r[0], "signature_version": int(r[1]), "from_key": r[2], "to_key": r[3],
             "setup_min": int(r[4]), "source": r[5], "source_metadata": r[6], "source_reference": r[7],
             "created_by": r[8], "created_at": _iso(r[9]), "updated_by": r[10], "updated_at": _iso(r[11])}
            for r in cur.fetchall()
        ]
        cur.execute(
            """SELECT machine, state_key, signature_version, physical_mold_id, observed_at, source, reason,
                      created_by, created_at, updated_by, updated_at
                 FROM machine_setup_state
                WHERE plant = %s AND signature_version = %s AND machine = ANY(%s)
                ORDER BY machine""", (plant, version, live_machines)
        )
        states = [
            {"machine": r[0], "state_key": r[1], "signature_version": int(r[2]), "physical_mold_id": r[3],
             "observed_at": _iso(r[4]), "source": r[5], "reason": r[6], "created_by": r[7],
             "created_at": _iso(r[8]), "updated_by": r[9], "updated_at": _iso(r[10])}
            for r in cur.fetchall()
        ]
        cur.execute(
            """SELECT id, machine, signature_version, predecessor_order_id, successor_order_id,
                      predecessor_state_key, successor_state_key, standard_min, remaining_min, status, reason,
                      created_by, created_at, updated_by, updated_at
                 FROM setup_occurrence_override
                WHERE plant = %s AND signature_version = %s AND status IN ('active', 'inactive')
                  AND machine = ANY(%s)
                ORDER BY id""",
            (plant, version, live_machines),
        )
        overrides = [
            {"id": int(r[0]), "machine": r[1], "signature_version": int(r[2]),
             "predecessor_order_id": r[3], "successor_order_id": r[4],
             "predecessor_state_key": r[5], "successor_state_key": r[6], "standard_min": int(r[7]),
             "remaining_min": int(r[8]), "status": r[9], "reason": r[10], "created_by": r[11],
             "created_at": _iso(r[12]), "updated_by": r[13], "updated_at": _iso(r[14])}
            for r in cur.fetchall()
        ]
    definition = {**definition, "plant": plant}
    return {"plant": plant, "definition": definition,
            "plant_rows": [row for row in matrix if row["machine"] == ""],
            "machine_rows": [row for row in matrix if row["machine"] != ""],
            "machine_states": states, "overrides": overrides}
```

Note the ordering: the live-machine-set query runs **before** the `setup_matrix` query and reuses its result (`live_machines`) across all three downstream queries — one extra round trip per snapshot fetch, not three, and no duplicated SQL fragment across the three (the exact "duplication pattern the codebase has already been bitten by once" this domain's own review calls out — see `Code_Review_09_01.md` §5's `COALESCE` duplication finding for the precedent this avoids repeating).

- [ ] **Step 3: Update the existing mocked-cursor test to match the new query shape**

`tests/test_setup_data.py`'s `_SnapshotCursor` (around line 496) currently returns canned rows for `"FROM setup_matrix"`/`"FROM machine_setup_state"`/`"FROM setup_occurrence_override"` queries and doesn't handle the new live-machine-set query. Update it:

```python
class _SnapshotCursor(_DefinitionCursor):
    def fetchone(self):
        if "SELECT fields" in self.executed[-1][0]:
            return (["colorWheel"], 4, True, False)
        return None

    def fetchall(self):
        query = self.executed[-1][0]
        if "SELECT machine FROM machine" in query:
            return [("LINE-1",)]
        if "FROM setup_matrix" in query:
            return [("", 4, [], [], 12, "manual", {}, None, "owner", None, "owner", None)]
        if "FROM machine_setup_state" in query:
            return [("LINE-1", [], 4, None, None, "manual", "floor", "owner", None, "owner", None)]
        if "FROM setup_occurrence_override" in query:
            return [(9, "LINE-1", 4, "before", "after", [], [], 12, 4, "active", "floor", "owner", None,
                     "owner", None)]
        return []
```

(Only the added `"SELECT machine FROM machine" in query` branch is new — everything else is unchanged, since the existing test's fixture data already used `"LINE-1"` as the machine, which the new live-machine-set branch now also returns, so `test_snapshot_reads_only_one_current_signature_version_in_a_repeatable_transaction` (the test that consumes `_SnapshotCursor`) keeps passing unmodified.)

- [ ] **Step 4: Add a new test asserting the machine-scoping clause is actually present and threaded correctly**

Add to `tests/test_setup_data.py`, near the existing snapshot test:

```python
def test_snapshot_scopes_machine_rows_states_and_overrides_to_the_live_machine_roster(monkeypatch):
    """machine_rows/machine_states/overrides must be bounded to the plant's live
    machine set (Code_Review_09_01.md P1-9) -- plant_rows (machine = '') stay
    unscoped, since they're the single fallback tier every machine inherits from."""
    cursor = _SnapshotCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    setup_data.get_setup_snapshot("5512")
    statements = [sql for sql, _params in cursor.executed]
    live_machine_query = next(sql for sql in statements if "SELECT machine FROM machine" in sql)
    assert "UNION" in live_machine_query
    assert "FROM orders" in live_machine_query

    matrix_query, matrix_params = next(
        (sql, params) for sql, params in cursor.executed if "FROM setup_matrix" in sql
    )
    assert "machine = '' OR machine = ANY(%s)" in matrix_query
    assert matrix_params[-1] == ["LINE-1"]

    states_query, states_params = next(
        (sql, params) for sql, params in cursor.executed if "FROM machine_setup_state" in sql
    )
    assert "machine = ANY(%s)" in states_query
    assert states_params[-1] == ["LINE-1"]

    overrides_query, overrides_params = next(
        (sql, params) for sql, params in cursor.executed if "FROM setup_occurrence_override" in sql
    )
    assert "machine = ANY(%s)" in overrides_query
    assert overrides_params[-1] == ["LINE-1"]
```

- [ ] **Step 5: Run the domain's test command**

```bash
python -m pytest tests/test_setup_data.py tests/test_setup_coverage.py tests/test_setup_endpoints.py -q
```
Expected: all pass, including the new test and the unmodified `test_snapshot_reads_only_one_current_signature_version_in_a_repeatable_transaction`.

- [ ] **Step 6: Commit**

```bash
git add backend/setup/data.py tests/test_setup_data.py
git commit -m "fix: scope get_setup_snapshot's machine rows to the plant's live machine roster (P1-9)"
```

---

### Task 2: Add a real-Postgres regression test proving a stale machine code is excluded while a registered-but-idle machine and an order-only machine are both included

**Files:**
- Create: `tests/test_setup_snapshot_machine_scoping.py`

**Interfaces:**
- Consumes: `pg` fixture (returns `db` module — note `setup_data` is a **separate** module from `db`; import `backend.setup.data as setup_data` directly, matching this domain's own test convention per `backend/setup/CLAUDE.md`); real Postgres via `NIMBUS_TEST_DB=1`.
- Produces: durable proof that the SQL in Task 1 behaves correctly against a real database, not just a mocked cursor — this is the one place a subtle SQL mistake (e.g. `machine = ANY(%s)` silently matching nothing because of an array/NULL edge case) would actually surface.

- [ ] **Step 1: Write the test**

```python
"""
Real-DB proof that get_setup_snapshot's machine-roster scoping (Code_Review_09_01.md
P1-9) actually excludes a stale machine code and includes both a registered-but-idle
machine and an order-only machine, against a real Postgres connection -- not just the
mocked-cursor unit test in tests/test_setup_data.py.

Requires a local Postgres with NIMBUS_TEST_DB=1 (see tests/conftest.py) --
auto-skipped otherwise.
"""
import datetime as dt

import pytest
from psycopg.types.json import Jsonb

import backend.setup.data as setup_data


@pytest.mark.pg
class TestSnapshotMachineRosterScopingRealDb:
    PLANT = "ZZTEST_SNAP_PLANT"
    REGISTERED_IDLE = "ZZTEST_SNAP_REGISTERED_IDLE"
    ORDER_ONLY = "ZZTEST_SNAP_ORDER_ONLY"
    STALE = "ZZTEST_SNAP_STALE_CODE"
    SUBNETWORK = "ZZT"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            # plants.subnetwork FKs to subnetworks(code); subnetworks.name is
            # NOT NULL with no default (see Code_Review_09_01.md's newly-recorded
            # subnetworks fixture bug elsewhere in this suite) -- supply it here
            # too, rather than repeating that exact gap in a new test.
            cur.execute(
                "INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.SUBNETWORK, "ZZTEST Subnetwork"),
            )
            cur.execute(
                "INSERT INTO plants (subnetwork, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.SUBNETWORK, self.PLANT),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine) VALUES (%s, %s, %s) "
                "ON CONFLICT DO NOTHING",
                (self.SUBNETWORK, self.PLANT, self.REGISTERED_IDLE),
            )
            cur.execute(
                "INSERT INTO setup_definition (plant, fields, signature_version, strict_blanks, active) "
                "VALUES (%s, %s, 1, TRUE, TRUE) ON CONFLICT (plant) DO NOTHING",
                (self.PLANT, Jsonb(["colorWheel"])),
            )
            oid = db_.make_id("ZZTEST_SNAP_ORD", "ZZTEST_SNAP_MAT")
            now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (oid, "ZZTEST_SNAP_ORD", "ZZTEST_SNAP_MAT", self.ORDER_ONLY, self.PLANT,
                 now, now + dt.timedelta(hours=1)),
            )
            for machine in (self.REGISTERED_IDLE, self.ORDER_ONLY, self.STALE):
                cur.execute(
                    "INSERT INTO setup_matrix (plant, machine, signature_version, from_key, to_key, "
                    "setup_min, source) VALUES (%s, %s, 1, %s, %s, 5, 'manual') ON CONFLICT DO NOTHING",
                    (self.PLANT, machine,
                     Jsonb([{"fieldKey": "colorWheel", "value": "RED"}]),
                     Jsonb([{"fieldKey": "colorWheel", "value": "BLUE"}])),
                )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM setup_matrix WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM setup_definition WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute(
                "DELETE FROM machine WHERE subnetwork = %s AND plant = %s", (self.SUBNETWORK, self.PLANT)
            )
            cur.execute("DELETE FROM plants WHERE subnetwork = %s AND plant = %s", (self.SUBNETWORK, self.PLANT))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUBNETWORK,))
            conn.commit()

    def test_registered_and_order_only_machines_included_stale_code_excluded(self, pg):
        snapshot = setup_data.get_setup_snapshot(self.PLANT)
        machines_in_snapshot = {row["machine"] for row in snapshot["machine_rows"]}
        assert self.REGISTERED_IDLE in machines_in_snapshot, \
            "a registered-but-idle machine (no loaded order) must still be included"
        assert self.ORDER_ONLY in machines_in_snapshot, \
            "a machine with a loaded order but no master-data registration must still be included"
        assert self.STALE not in machines_in_snapshot, \
            "a machine code with neither a master-data registration nor a loaded order must be excluded"
```

- [ ] **Step 2: Self-check without a live DB connection (no credentials needed for this step)**

```bash
"/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  -m pytest tests/test_setup_snapshot_machine_scoping.py --collect-only -v
```
Expected: 1 test collected, no import/syntax errors.

- [ ] **Step 3: Run it against real Postgres**

```bash
PG_HOST=localhost PG_PORT=5432 PG_DB=nimbus PG_USER=postgres PG_PASS='<local password>' NIMBUS_TEST_DB=1 \
  "/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  -m pytest tests/test_setup_snapshot_machine_scoping.py -v
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/test_setup_snapshot_machine_scoping.py
git commit -m "test: add real-DB regression test for P1-9 machine-roster snapshot scoping"
```

---

### Task 3: Update `Code_Review_09_01.md` and the domain docs

**Files:**
- Modify: `Code_Review_09_01.md`
- Modify: `frontend/setup/CLAUDE.md`, `backend/setup/CLAUDE.md` (only if their existing O(states²) framing would otherwise read as contradicting this fix — see Step 2)

**Interfaces:** none — doc-only task.

- [ ] **Step 1: Update `Code_Review_09_01.md`'s P1-9 entry and §11 item 13**

Find the P1-9 finding (search for `P1-9 — `GET /setup/{plant}`) and its current status line (last edited 2026-09-04 to read "confirmed still needed, plan pending"). Update the status to record resolution, e.g.:

> **✅ RESOLVED (2026-09-04).** `get_setup_snapshot` now scopes `machine_rows`/`machine_states`/`overrides` to the plant's live machine roster (registered in master data for this plant, or already on a loaded order for that plant) instead of every historical machine code ever recorded — bounding the payload to the plant's actual current machine count. `plant_rows` stay unscoped (single fallback tier). Literal per-call lazy fetching inside `resolveSetup` was investigated and rejected as infeasible (`resolveSetup` is a pure synchronous function, and the Gantt shows every plant machine simultaneously, so "not yet needed" never actually applies within a loaded plant) — see the plan this closes, `docs/superpowers/plans/2026-09-04-p1-9-setup-snapshot-machine-scoping.md`, for the investigation and the confirmed-alternative shape.

Update §11 item 13's line similarly (from "OPEN — confirmed still needed, plan pending (2026-09-04)" to resolved, same commit reference).

- [ ] **Step 2: Check whether the domain `CLAUDE.md`s need a one-line addition (not a rewrite)**

Read `frontend/setup/CLAUDE.md`'s "O(states²) hazard" bullet and `backend/setup/CLAUDE.md`'s route list for `GET /setup/{plant}`. Neither currently claims `get_setup_snapshot` is *itself* the from-state-scoped mitigation (that's `matrix-rows`'s job, and remains accurate) — so no correction is needed for a false claim. Add one short factual sentence to `backend/setup/CLAUDE.md`'s `GET /setup/{plant}` (`get_setup`) bullet noting the machine-roster scoping, so a future reader doesn't have to rediscover it by reading the SQL:

Example addition to the existing bullet:
> `GET /setup/{plant}` (`get_setup`) — one authorized plant's complete setup snapshot (definition + matrix + machine states), never a cross-plant aggregate; attaches `plant_active` (from `plants.setup_active`, the real activation gate). `machine_rows`/`machine_states`/`overrides` are scoped to the plant's live machine roster (registered machines, or machines already on a loaded order) — not every machine code ever recorded for this plant (Code_Review_09_01.md P1-9, resolved 2026-09-04).

- [ ] **Step 3: Commit**

```bash
git add Code_Review_09_01.md backend/setup/CLAUDE.md
git commit -m "docs: record P1-9 resolution (get_setup_snapshot machine-roster scoping)"
```

---

### Task 4: Full verification pass

**Files:** none — verification only.

- [ ] **Step 1: Run the full Python suite with real Postgres**

```bash
PG_HOST=localhost PG_PORT=5432 PG_DB=nimbus PG_USER=postgres PG_PASS='<local password>' NIMBUS_TEST_DB=1 \
  "/c/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude/.venv/Scripts/python.exe" \
  -m pytest tests/ -q
```
Expected: same baseline as the last recorded run (469 passed, 1 skipped, 2 pre-existing errors — the known, unrelated `test_schema_idempotent.py` `subnetworks` fixture bug, still not this plan's concern) plus the new tests from Tasks 1 and 2, zero new failures.

- [ ] **Step 2: Confirm no frontend build is needed**

This plan touches no `.ts`/`.mts` file — `npm run build`/`typecheck`/`lint` are not required, but running them once is a cheap sanity check that nothing else drifted:
```bash
npm run build && npm run typecheck && npm run lint
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 → the actual P1-9 fix. Task 2 → proves it against real Postgres, closing the same "written but never run for real" gap this session already fixed once for two other tests. Task 3 → keeps `Code_Review_09_01.md` and the domain docs from going stale the way P1-7/P1-8/P1-9's inline entries already did once this session (a pattern this doc has now hit three times — worth being deliberate about it here).
- **Placeholder scan:** no TBD/"add appropriate handling"; Task 1's SQL and Task 2's test are complete, runnable code, not sketches.
- **Type/name consistency:** `get_setup_snapshot`'s return shape keys (`plant_rows`, `machine_rows`, `machine_states`, `overrides`) match `frontend/platform/types.mts`'s `SetupSnapshot` interface exactly (verified by direct read); the mocked-cursor test's `_SnapshotCursor` query-text branches match the real SQL strings verbatim (`"FROM setup_matrix"`, `"FROM machine_setup_state"`, `"FROM setup_occurrence_override"`, and the new `"SELECT machine FROM machine"`).
- **Correctness bar carried over from the original investigation:** the review's own §0.3 warned that truncating the matrix payload must never produce a wrong non-zero value silently. This design preserves that: the only degraded case (a machine neither registered nor yet ordered) resolves to `resolveSetup`'s existing `uncovered` fallback — the same honest "no data" result an unconfigured machine already gets today, never a wrong number.
- **Schema verification done while drafting this plan (worth recording since it caught two real mistakes before dispatch):** `setup_definition`'s primary key is `plant` alone, not `(plant, signature_version)` — Task 2's test uses `ON CONFLICT (plant) DO NOTHING`. `plants.subnetwork` FKs to `subnetworks(code)`, and `subnetworks.name` is `NOT NULL` with no default (the same gap already found and left open as a separate backlog item during the prior verification pass on this repo) — Task 2's test seeds a `subnetworks` row with a `name` explicitly, rather than tripping over that same gap in a new test. `setup_matrix.from_key`/`to_key` and `setup_definition.fields` are `JSONB` columns and need `psycopg.types.json.Jsonb(...)` wrapping on insert (matching `_insert_matrix_rows`'s own pattern in `backend/setup/data.py`), not a bare Python list.
