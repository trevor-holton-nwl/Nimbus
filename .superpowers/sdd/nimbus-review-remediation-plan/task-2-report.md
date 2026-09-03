# Task 2 report — Bounded setup coverage

## Status

Implemented the bounded setup coverage read path. `GET /setup/{plant}` and
`get_setup_snapshot()` are unchanged; optimizer hydration still receives the
complete setup snapshot. Coverage now loads only the current definition and
linear order-state inputs, computes totals without building a Python reachable
Cartesian product or fetching a full matrix snapshot, and asks PostgreSQL for
aggregate effective-row counts plus only the requested missing-pair page.

## Files changed

- `backend/setup/data.py`
  - Added `load_setup_coverage()` for one repeatable-read definition/order-state
    context. It does not call `get_setup_snapshot()` or read machine state and
    occurrence override tables.
  - Added `_coverage_counts()` and `summarize_setup_coverage()`. Reachable totals
    are computed arithmetically from each machine's unique state count; effective
    explicit coverage is aggregated in SQL with machine rows taking precedence
    over plant rows. Complete diagonals remain implicitly covered.
  - Added `page_setup_missing_pairs()`, with server-side offset/limit validation
    and a hard maximum of 500. Stable order is machine order, then first-seen
    from/to state order. Only the requested page is returned to Python.
  - Retained `get_setup_coverage()` as a bounded totals-only compatibility
    wrapper. Existing pure `build_setup_coverage()` and `page_missing_pairs()`
    remain available and unchanged.
- `backend/setup/routes.py`
  - `GET /setup/{plant}/coverage` now reuses one linear coverage context for its
    observed/reachable summaries and bounded pages while preserving the existing
    JSON wire shape.
  - `GET /setup/{plant}/missing-pairs.csv` now calls the same
    `page_setup_missing_pairs()` path as JSON coverage and preserves the CSV
    columns, signature version, content disposition, and `X-Total-Count` header.
- `tests/test_setup_coverage.py`
  - Added database-boundary coverage proving the new path never calls the full
    snapshot, does not query setup machine-state/override tables, preserves
    representative observed/reachable totals and stable filtered paging, uses
    bounded SQL paging, and rejects `limit=501` before database access.
- `tests/test_setup_endpoints.py`
  - Added a live `TestClient` contract proving JSON coverage and CSV both use
    the bounded helper, never call `get_setup_snapshot()`, and retain the
    frontend-compatible payload/CSV shape.

No schema migration, frontend source, generated artifact, optimizer snapshot
route, or unrelated Task 1 file was changed.

## TDD evidence

### RED

The first invocation was rejected at collection because the checkout `.env`
points at Azure PostgreSQL. This was the repository's intended safety guard and
was not counted as RED evidence. The same command was rerun with `PG_HOST` set
to `localhost`, `NIMBUS_PG_POOL_MIN=0`, and database-test opt-in absent, affecting
that process only:

```text
python -m pytest <three new Task 2 tests> -q
exit 1
3 failed

- AttributeError: load_setup_coverage did not exist
- AttributeError: page_setup_missing_pairs did not exist
- coverage endpoint called the AssertionError-raising get_setup_snapshot guard
```

These were the expected missing-production-behavior failures.

### GREEN

After the minimal data/route implementation:

```text
python -m pytest <three new Task 2 tests> -q
exit 0
3 passed, 1 existing Starlette deprecation warning
```

## Verification

- Focused setup suite:

  ```text
  & '.\.venv\Scripts\python.exe' -m pytest tests/test_setup_data.py tests/test_setup_coverage.py tests/test_setup_endpoints.py -q
  exit 0
  88 passed, 34 warnings in 4.33s
  ```

  The fresh verification rerun used the isolated `C:\\tmp\\nimbus-task2-pytest-verify-20260902`
  pytest base directory because Windows denied pytest access to its default
  user temp directory. The temporary directory was removed afterward. Warnings
  are existing Starlette `TestClient` and pandas `Timestamp.utcnow()`
  deprecations.

- Full non-database Python suite:

  ```text
  & '.\.venv\Scripts\python.exe' -m pytest -q
  exit 0
  318 passed, 104 skipped, 121 warnings in 5.93s
  ```

  Collection was process-scoped to `PG_HOST=localhost` with
  `NIMBUS_TEST_DB` absent, so PostgreSQL tests remained safely skipped. The
  run used an isolated `C:\\tmp\\nimbus-task2-full-pytest-verify-20260902`
  base directory to avoid the same OneDrive temp-directory permission issue;
  that directory was removed afterward.

- Ruff:

  ```text
  python -m ruff check backend/setup/data.py backend/setup/routes.py tests/test_setup_coverage.py tests/test_setup_endpoints.py
  exit 0
  All checks passed!
  ```

- `git diff --check`: exit 0; only Git's existing LF-to-CRLF checkout notices
  were emitted.
- Scoped diff review confirmed `get_setup_snapshot()` and the
  `GET /setup/{plant}` handler body were not edited.

## Semantic and security review

- Plant scope is a bound SQL parameter on every definition, order, and matrix
  lookup. Dynamic order columns still come only from the server-owned
  `RANKABLE_FIELDS` registry; no HTTP-controlled SQL identifier was added.
- Effective coverage gives a matching machine row precedence over the plant
  row. A plant row applies only when no matching machine override exists.
- Diagonal state pairs count as covered without requiring persisted zero rows.
  Missing-page queries exclude diagonals and both machine- and plant-covered
  pairs.
- Reachable total count is `state_count²` per machine, but no Python list of
  those pairs is created. Missing rows are returned only through SQL
  `LIMIT %s OFFSET %s`, capped at 500 by both FastAPI and the data helper.
- The context caches only per-machine integer counts, not matrix rows or a
  Cartesian product. Both JSON and CSV reuse the same context/page contract.
- Coverage remains authenticated and plant-authorized through the unchanged
  route dependencies and `_setup_plant_guard()`.

## Concerns

- No local PostgreSQL service was used in this task. The JSONB aggregate/page
  SQL boundary is exercised with deterministic cursor doubles and the existing
  pure semantic fixtures, but live PostgreSQL execution remains appropriate for
  Task 3's database-verification wave.
- The focused suite emits 34 pre-existing deprecation warnings. No warning is
  introduced by the Task 2 implementation.
