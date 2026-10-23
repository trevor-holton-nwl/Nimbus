# Workload relief, backend track: implementation log (2026-10-22)

## Context

`GET /tasks` took ~5 s and 12.6 MB for ~9,500 rows (`docs/frontend-audit/2026-10-16/scale-api.json`), most of it a pandas DataFrame/`iterrows` builder plus pydantic validation, JSON encoding and gzip level 9 running on the request path. The frontend aborts at 8 s. Source plan: `C:\Users\PJ29587\.claude\plans\are-there-any-new-generic-cook.md`. Frontend track runs separately (`feature/workload-relief-fe`).

## Scope

In: per-stage timing, gzip level 6, priority-list column resolver in the threadpool, a pandas-free `/tasks` builder with a golden test, explicit validate/encode/gzip in the threadpool handler. Out (by instruction): orjson, uvicorn workers/process pools, pagination, any write to `orders` on the read path.

Branch: `worktree-agent-a31525a1a839c0b9b` (see Deviations 1). Base `4c37368`.

## Status ledger

- [x] 1. `perf(backend): per-stage timing log` : `tasks.timing` event; handler split into `build_tasks_payload`.
- [x] 2. gzip level 6 in `brain.py`; `_resolve_priority_list_columns` runs via `run_in_threadpool` at both upload routes.
- [x] 3. Golden test `tests/test_tasks_builder_golden.py` (frozen legacy pandas copy) committed green against the unchanged builder (it also caught a kwarg bug in the step-1 timing line, fixed in the same commit).
- [x] 4. Pandas-free builder `_build_task_rows` + `db.query_orders_rows`; golden test unchanged and green.
- [x] 5. Explicit `TypeAdapter` validate + `dump_json(by_alias=True)` + gzip 6 in the handler; `tests/test_tasks_route_encoding.py`; `generate:api-types` shows no `/tasks` drift.
- [x] 6. Extended `test_task_response_models.py` (builder keys == TaskDTO wire fields), `test_task_concurrency.py` (pg round-trip, owed), `test_rbac_plant_scoping.py` (limit pull bounded to allowed plants).
- [x] 7. Synthetic benchmark (below).
- [x] 8. Full gate run; `backend/scheduling/CLAUDE.md` updated.

- [x] 9. Fix wave (Opus validator, SHIP AFTER FIXES): see "Fix wave" below.

## Fix wave (post-validation)

- F1 (required): pydantic `ValidationError` is a `ValueError`, which `brain._value_error_handler` maps to HTTP 400 echoing row values. `encode_tasks_response` now raises `fastapi.exceptions.ResponseValidationError(errors=exc.errors(include_input=False))` (500, no input values). Test: FORM_SIZE=5 row -> 500, no `FORM_SIZE`/`input_value`/row id in the body.
- F2: `tasks.timing` goes to the `nimbus.perf` logger only; it enters the `_BACKEND_LOG` ring (as `warn`) only when total > 1500 ms (`_SLOW_TASKS_MS`, same as the slow-request rule). Chosen as the simplest option that keeps every timing in the container JSON log while protecting the 2000-entry ring.
- F3: `_timings["sql"]` is recorded before the no-rows early return.
- F4: the golden test now freezes the old `_to_pydt`-based segments-to-wire (`legacy_segments_to_wire`), so segment parity is pinned against legacy code, not the live `fromisoformat` version.
- F5: `backend/scheduling/CLAUDE.md` line ~25 now names `query_orders_rows` (~db.py:696) and `query_orders` (~:653); `AGENTS.md` mirrored (the new section and the line; the two files already differed at base, only this content was synced).
- F6: `Vary: Accept-Encoding` is set once: by the handler when it gzips or the body is under 1000 bytes; for an uncompressed body at or over the floor the middleware's IdentityResponder adds it. Tested for gzip, identity, and small bodies.
- F7: stale "(db.query_orders)" docstrings fixed. The `get_tasks` one is the OpenAPI description, so the one-line change was applied to `frontend/types/api-generated.d.mts` by hand; regenerating shows no other `/tasks` drift (other unrelated drift in that file is pre-existing and uncommitted).
- F8: unused `db.query_orders` patch and frame removed from `live_build`.
- F9 (optional) skipped: parsing `Accept-Encoding: gzip;q=0` in the handler would not help, because starlette's middleware tests `"gzip" in accept_encoding` and would compress the body itself regardless. Fixing it properly means replacing the middleware; out of scope.
- F10: `_rank_value` coerces a non-numeric rank to unlisted (999999) and counts it in `color_merge_misses`, same as the old `to_numeric(errors="coerce")` path; no change needed.

## Owed DB verification (needs a local Postgres with working credentials, schema applied)

1. `python -m pytest tests/test_task_concurrency.py -q -k row_version_round_trips`
2. DB-backed set with `NIMBUS_TEST_DB=1 PG_HOST=localhost PG_DB=nimbus_test`: `tests/test_task_concurrency.py tests/test_task_response_models.py tests/test_rbac_plant_scoping.py tests/test_priority_lists.py tests/test_planning_exceptions.py tests/test_visibility_horizon.py tests/test_frozen_horizon.py tests/test_audit_routing_db.py tests/test_integration_routes.py`
3. Real-row parity: on a seeded plant with `order_schedule_segments` and priority lists, compare `legacy_build_tasks` (tests/test_tasks_builder_golden.py) against `build_tasks_payload`, including each row's `schedule_segments` against the old `_to_pydt` conversion of the raw `SCHEDULE_SEGMENTS`.
4. One cache-busted `GET /tasks?plant=<P>` with and without `Accept-Encoding: gzip`: check `Content-Encoding`, a single `Vary`, identical decoded JSON, and a `tasks.timing` event in the container log.

## Results

Test gate (`PG_HOST=localhost NIMBUS_TEST_DB=1`, but the local Postgres refuses the available credentials, so every DB-marked test skipped): `1460 passed, 626 skipped, 13 xfailed, 2 failed`. The 2 failures are `tests/test_integration_routes.py::test_lifespan_*`: the app lifespan opens the DB pool and times out on password auth in this environment (not touched by this work). **DB tests are owed**, notably the new pg test in `tests/test_task_concurrency.py` and the other `/tasks`-adjacent pg tests.

Synthetic benchmark (in-process, no DB, 9,500 rows, 70 machines, median of 3-5 runs, one noisy Windows laptop, so indicative only; script not committed):

| Stage | Before | After |
|---|---|---|
| builder (frame + merge + sort + rows + links) | ~4,330 ms | ~530 ms |
| builder + validate + JSON + gzip (approximation of the old whole path: pydantic validate, `jsonable_encoder`+`json.dumps`, gzip 9) | ~5,960 ms | ~830 ms (validate ~200, dump ~120, gzip 6 ~110) |

The "before" whole-path figure is my reconstruction, not a capture of the real FastAPI serialisation. SQL time and network are not included. Real timings per request are now in the `tasks.timing` log events.

## Deviations / additions

1. **Branch name.** `feature/workload-relief-be` already exists and is checked out in another worktree (`.claude/worktrees/workload-relief-be`), so it cannot be checked out here and I may not write there. I reset my own isolated branch `worktree-agent-a31525a1a839c0b9b` to `4c37368` and committed on it. Merge or rename as needed.
2. `build_tasks_payload` and `encode_tasks_response` added as public helpers; `get_tasks` is now a thin wrapper (the HTTP guards 400/403 live in the builder). Tests that called `get_tasks(...)` directly or patched `db.query_orders` were repointed to `build_tasks_payload` / `db.query_orders_rows`.
3. `db.query_orders` now delegates to a shared `_fetch_orders` (same SQL). Rows for `query_orders_rows` are `dict(zip(cols, row))`, not a psycopg `dict_row` cursor, because the horizon lookup on the same cursor unpacks tuple rows. Not exercised against a live DB (owed).
4. `_schedule_segments_to_wire` (shared with `/tasks/refresh`) now parses with `datetime.fromisoformat` and falls back to `_to_pydt` on anything else; a parity test covers common formats. Exotic formats accepted by `fromisoformat` but read differently by pandas (e.g. ISO week dates) would differ; the JSONB is written by this app in ISO form.
5. Timing is emitted from the handler as one event including validate/encode/gzip; the empty-result path logs only validate/encode/gzip (no sql/build keys). `_timings` is a keyword-only argument.
6. Handler also skips gzip for bodies under 1000 bytes (same floor as the middleware) and uses `mtime=0` for deterministic gzip bytes.
7. Pandas-3 behaviour pinned empirically: a null COLOR/PRT/PRODUCTION_VERSION stays null (the old code's `astype(str)` leaves NaN in pandas 3). A null `MATERIAL_DESCRIPTION` still yields the text `"None"` (legacy quirk kept on purpose, flagged for a product decision).
8. `generate:api-types` produced a large diff unrelated to this work (priority-list template route, calendar docstring): the committed `api-generated.d.mts` was already behind. No `/tasks` lines changed; I did not commit the regenerated file.
9. `node_modules` junction created in this worktree (gitignored, not committed).

## Riskiest spots for review

Ordering parity (only start-time ties may differ; compare against the golden test's tie rule); `row_version` int/None; gzip headers (`Content-Encoding` + `Vary`, no double compression through the middleware); NaN/None handling for numeric columns (`_nn`); `query_orders_rows` against a real Postgres.
