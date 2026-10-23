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
