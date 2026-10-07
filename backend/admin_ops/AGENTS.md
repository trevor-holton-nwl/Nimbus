# Admin Ops — diagnostics, health/liveness, DB maintenance, log sinks, and two cross-cutting shared modules

## What lives here

- `routes.py` (13 routes) — `GET /health`, `GET /livez`, `GET /diagnostics/deep`, `POST /reload` (refreshes the priority-list cache — see `backend/priority_lists/CLAUDE.md`), `GET|POST /system-settings`, `GET /diagnostics/db`, `POST /maintenance/vacuum-analyze`, `POST /maintenance/analyze`, `GET /logs/backend`, `POST /logs/backend/clear`, `POST /logs/csp-report` (see the 2026-10 section below), `POST /logs/frontend`. Also owns the private `_diag_snapshot()`, `_truncate()`, and the `_FE_MAX_*` frontend-log-ingest size caps. (Plain `GET /diagnostics` was removed 2026-09 as confirmed dead — zero frontend callers, superseded by `/diagnostics/deep` and `/diagnostics/db`.)
- `logbuffer.py` (155 lines) — `_BACKEND_LOG` (a 2000-entry `collections.deque` ring buffer), `_log_event()` (structured event → ring buffer + JSON log line), `_log_admin_action()` (admin-write audit event), `_set_admin_log_details()` (per-route safe-context accumulator read by `brain.py`'s `request_id_mw`), `_RID_CTX`/`_current_rid()` (the per-request-id `ContextVar`, shared with `brain.py`'s middleware).
- `diagnostics_state.py` (48 lines) — `DIAGNOSTICS` (the load-metadata bag: `loaded_at`, `color_merge_misses`, `missed_colors`, `emitted_task_count`, `warnings`, etc.) and `_warn()`.

## Counterpart

Frontend half: `frontend/admin-ops/admin-ui.mts` (`AdminCockpit` — the ops console, Postgres diagnostics panel, log viewer, PerfMonitor thread tab).

No deferred-split root-file line ranges to cite for this domain's *own* logic — `logbuffer.py`/`diagnostics_state.py` were extracted whole from `brain.py` in Phase P5 and are complete here. This domain's routes do call into root `db.py`'s DB-maintenance allowlist: `db._get_maint_table_allowlist()` / `run_vacuum_analyze()` / `run_analyze()` (`db.py` lines 2363–2404), which validate the requested table against `pg_stat_user_tables`, fetched fresh (with a lazy process-level cache for the allowlist itself — distinct from `backend/master_data/browser.py`'s deliberately *never*-cached catalog reads).

## Key invariants & hazards

- **`_BACKEND_LOG` is per-process and lost on restart** — a 2000-entry ring buffer, not a durable store. The pilot is single-replica, so this is a known, accepted limitation, not a bug.
- **`x-request-id` threading:** every request carries one (set by `brain.py`'s `request_id_mw`, read via `_RID_CTX`/`_current_rid()`); only requests slower than 1500 ms are logged as JSON lines to stdout, but every `_log_event()` call always appends to the ring buffer regardless of duration.
- **Admin-route actions are auto-audited.** `request_id_mw` → `_log_admin_action()` records `actor`/`route`/`method`/`duration_ms`/`outcome` for every admin-gated write, reading whatever the route handler stashed via `_set_admin_log_details()`. `_SENSITIVE_LOG_KEYS` in `logbuffer.py` defensively drops anything that looks like a credential/secret/raw-payload key before it reaches either the ring buffer or the JSON log line.
- **Maintenance DDL allowlists against `pg_stat_user_tables`**, not a hardcoded table list — `db._get_maint_table_allowlist()` (`db.py` lines 2363–2372) builds this set lazily and caches it at module level (unlike `backend/master_data/browser.py`'s per-call catalog reads, which are deliberately never cached).
- **`GET /health` no longer means "DataFrame loaded in RAM"** — the app is stateless (no in-memory order cache), so `memory.loaded` now means "DB reachable." The `color_wheel` key in the response is a back-compat name; `GLOBAL_CW`/`COLOR_FILE` are retired, so only `.misses`/`.missed_colors` (sourced from `DIAGNOSTICS`) are meaningful — there's no file-path/reachable check anymore.
- **`GET /diagnostics/deep`'s color-merge stats are stale by construction at load time** — `pipeline["color_merge_is_per_request"] = True` signals the frontend to prefer the *last `/tasks` response's* `meta` (which reflects `apply_priority_merge`'s per-request computation) over these load-time defaults.

## Integration points

**Imports in:** `db`, `master_data as md`, `backend.admin_ops.diagnostics_state.DIAGNOSTICS` (self-package), `backend.admin_ops.logbuffer` (`_BACKEND_LOG`, `_current_rid`, `_log_event`, self-package), `backend.priority_lists.cache as plcache` (for `POST /reload` and `GET /diagnostics/deep`'s color-wheel-vs-orders comparison), `backend.security.auth` (`require_admin`, `require_api_key`).

**`logbuffer.py` and `diagnostics_state.py` are genuinely cross-domain, despite living in this folder — a future editor changing either module's shape needs to know the blast radius reaches well beyond admin-ops:**

- **`logbuffer.py`** (`_log_event`/`_current_rid`/`_set_admin_log_details`/`_BACKEND_LOG`) is imported by, confirmed via grep: `backend/calendars/routes.py`, `backend/distribution/routes.py`, `backend/integration/routes.py`, `backend/master_data/models.py`, `backend/master_data/routes.py`, `backend/priority_lists/cache.py`, `backend/priority_lists/routes.py`, `backend/routing/routes.py`, `backend/scheduling/routes.py`, `backend/setup/routes.py`, plus `brain.py` itself (for the `request_id_mw` middleware's `_RID_CTX`/`_log_admin_action`). That is nearly every other domain router in the backend (not `labor` or `security`).
- **`diagnostics_state.py`** (`DIAGNOSTICS`/`_warn`) is imported by: `backend/priority_lists/cache.py` (`apply_priority_merge` calls `_warn` on a merge failure), `backend/priority_lists/audit_log.py`, `backend/scheduling/routes.py` (`GET /tasks` builds its response `meta` from `DIAGNOSTICS`), plus `brain.py`'s lifespan. Narrower blast radius than `logbuffer.py`, but still two domains outside this one.

**Endpoints:** see the 13-route list above.

## Tests

`tests/test_log_event.py`, `tests/test_logs_endpoints.py`. `tests/test_setup_endpoints.py` also exercises `logbuffer`/`diagnostics_state` incidentally through its own admin-gated routes.

```
python -m pytest tests/test_log_event.py tests/test_logs_endpoints.py -q
```

## Gotchas

- `DIAGNOSTICS` and `_BACKEND_LOG` are **never reassigned wholesale** by any function in this codebase — only mutated in place (`DIAGNOSTICS["key"] = value`, `_BACKEND_LOG.append`/`.clear()`). This is *why* every cross-module importer can safely do `from backend.admin_ops.logbuffer import _BACKEND_LOG` (a bound-name import) without the staleness hazard that applies to `backend/priority_lists/cache.PLANT_LISTS` (which *is* wholesale-reassigned on reload, and therefore must be accessed via `plcache.PLANT_LISTS`, never a bound import — see that domain's doc). Don't "fix" this asymmetry by making the two modules consistent; they're consistent with their own reassignment semantics, not with each other.
- Excluded from `/maintenance/*` on purpose: `VACUUM FULL` (exclusive lock), `REINDEX TABLE` (ShareLock), terminate-idle (would kill the app's own pool connections), reset-stats (destroys forensic history). Don't add these without reconsidering why they were left out.

## Log-sink and diagnostics contracts added in the 2026-10 review/audit rounds

- **Body caps.** `brain.py`'s `body_size_cap_mw` checks `Content-Length` for the three free-form sinks before Starlette buffers the body: `POST /logs/frontend` 1 MB, `POST /audit/log` 64 KB, `POST /logs/csp-report` 16 KB. Over the cap is 413; a missing or non-numeric length is 411 (a chunked body is refused rather than buffered).
- **`POST /logs/frontend` caps** each entry's `ctx` at 20 keys, key length 64, value 1 KB (values truncated with `...[truncated]`); `POST /audit/log` entries are capped at 50 keys / 32 KB serialized.
- **`GET /diagnostics/deep` is `require_api_key` + `require_admin`** (the frontend already sends `x-api-key` via `fetchTraced`).
- **`POST /logs/csp-report` (report-only CSP sink).** Unauthenticated by necessity (browsers send no credentials), tolerant (always 204, junk dropped), reads <= 8 KB, <= 10 reports per request. Reports are **de-duplicated** by (directive, blocked-uri, source-file, line) with a counter -- a repeat is logged only at its 10th/100th/1000th... occurrence with an `occurrences` field -- and **rate-limited** to `_CSP_MAX_DISTINCT_PER_MIN` (20) distinct reports per minute per process; drops are summarised once per window as a `csp.rate_limited` entry. State is per-process (`_CSP_SEEN`, `_CSP_RATE`, bounded to 500 keys); tests reset it in an autouse fixture. Reason: the report-only policy is chatty by design and used to evict real errors from the 2,000-entry `_BACKEND_LOG` ring. See `docs/MIGRATION.md` (CSP/SRI).
- **Tests never write the repo's `data/color_wheels/`**: `tests/conftest.py` points `COLOR_WHEEL_DIR` at a temp dir before app import (the on-disk `_audit_log.json` is gitignored runtime state).
