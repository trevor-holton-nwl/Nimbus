# Admin Ops — diagnostics, health/liveness, DB maintenance, log sinks, and two cross-cutting shared modules

## What lives here

- `routes.py` (371 lines, 13 routes) — `GET /diagnostics`, `GET /health`, `GET /livez`, `GET /diagnostics/deep`, `POST /reload` (refreshes the priority-list cache — see `server/priority_lists/CLAUDE.md`), `GET|POST /system-settings`, `GET /diagnostics/db`, `POST /maintenance/vacuum-analyze`, `POST /maintenance/analyze`, `GET /logs/backend`, `POST /logs/backend/clear`, `POST /logs/frontend`. Also owns the private `_diag_snapshot()`, `_truncate()`, and the `_FE_MAX_*` frontend-log-ingest size caps.
- `logbuffer.py` (155 lines) — `_BACKEND_LOG` (a 2000-entry `collections.deque` ring buffer), `_log_event()` (structured event → ring buffer + JSON log line), `_log_admin_action()` (admin-write audit event), `_set_admin_log_details()` (per-route safe-context accumulator read by `brain.py`'s `request_id_mw`), `_RID_CTX`/`_current_rid()` (the per-request-id `ContextVar`, shared with `brain.py`'s middleware).
- `diagnostics_state.py` (48 lines) — `DIAGNOSTICS` (the load-metadata bag: `loaded_at`, `color_merge_misses`, `missed_colors`, `emitted_task_count`, `warnings`, etc.) and `_warn()`.

## Counterpart

Frontend half: `web/admin-ops/admin-ui.mts` (`AdminCockpit` — the ops console, Postgres diagnostics panel, log viewer, PerfMonitor thread tab).

No deferred-split root-file line ranges to cite for this domain's *own* logic — `logbuffer.py`/`diagnostics_state.py` were extracted whole from `brain.py` in Phase P5 and are complete here. This domain's routes do call into root `db.py`'s DB-maintenance allowlist: `db._get_maint_table_allowlist()` / `run_vacuum_analyze()` / `run_analyze()` (`db.py` lines 1612–1652), which validate the requested table against `pg_stat_user_tables`, fetched fresh (with a lazy process-level cache for the allowlist itself — distinct from `server/master_data/browser.py`'s deliberately *never*-cached catalog reads).

## Key invariants & hazards

- **`_BACKEND_LOG` is per-process and lost on restart** — a 2000-entry ring buffer, not a durable store. The pilot is single-replica, so this is a known, accepted limitation, not a bug.
- **`x-request-id` threading:** every request carries one (set by `brain.py`'s `request_id_mw`, read via `_RID_CTX`/`_current_rid()`); only requests slower than 1500 ms are logged as JSON lines to stdout, but every `_log_event()` call always appends to the ring buffer regardless of duration.
- **Admin-route actions are auto-audited.** `request_id_mw` → `_log_admin_action()` records `actor`/`route`/`method`/`duration_ms`/`outcome` for every admin-gated write, reading whatever the route handler stashed via `_set_admin_log_details()`. `_SENSITIVE_LOG_KEYS` in `logbuffer.py` defensively drops anything that looks like a credential/secret/raw-payload key before it reaches either the ring buffer or the JSON log line.
- **Maintenance DDL allowlists against `pg_stat_user_tables`**, not a hardcoded table list — `db._get_maint_table_allowlist()` (`db.py` lines 1615–1624) builds this set lazily and caches it at module level (unlike `server/master_data/browser.py`'s per-call catalog reads, which are deliberately never cached).
- **`GET /health` no longer means "DataFrame loaded in RAM"** — the app is stateless (no in-memory order cache), so `memory.loaded` now means "DB reachable." The `color_wheel` key in the response is a back-compat name; `GLOBAL_CW`/`COLOR_FILE` are retired, so only `.misses`/`.missed_colors` (sourced from `DIAGNOSTICS`) are meaningful — there's no file-path/reachable check anymore.
- **`GET /diagnostics/deep`'s color-merge stats are stale by construction at load time** — `pipeline["color_merge_is_per_request"] = True` signals the frontend to prefer the *last `/tasks` response's* `meta` (which reflects `apply_priority_merge`'s per-request computation) over these load-time defaults.

## Integration points

**Imports in:** `db`, `master_data as md`, `server.admin_ops.diagnostics_state.DIAGNOSTICS` (self-package), `server.admin_ops.logbuffer` (`_BACKEND_LOG`, `_current_rid`, `_log_event`, self-package), `server.priority_lists.cache as plcache` (for `POST /reload` and `GET /diagnostics/deep`'s color-wheel-vs-orders comparison), `server.security.auth` (`require_admin`, `require_api_key`).

**`logbuffer.py` and `diagnostics_state.py` are genuinely cross-domain, despite living in this folder — a future editor changing either module's shape needs to know the blast radius reaches well beyond admin-ops:**

- **`logbuffer.py`** (`_log_event`/`_current_rid`/`_set_admin_log_details`/`_BACKEND_LOG`) is imported by, confirmed via grep: `server/calendars/routes.py`, `server/integration/routes.py`, `server/master_data/routes.py`, `server/priority_lists/cache.py`, `server/priority_lists/routes.py`, `server/scheduling/routes.py`, `server/setup/routes.py`, plus `brain.py` itself (for the `request_id_mw` middleware's `_RID_CTX`/`_log_admin_action`). That's every other domain router in the backend.
- **`diagnostics_state.py`** (`DIAGNOSTICS`/`_warn`) is imported by: `server/priority_lists/cache.py` (`apply_priority_merge` calls `_warn` on a merge failure), `server/scheduling/routes.py` (`GET /tasks` builds its response `meta` from `DIAGNOSTICS`), plus `brain.py`'s lifespan. Narrower blast radius than `logbuffer.py`, but still two domains outside this one.

**Endpoints:** see the 13-route list above.

## Tests

`tests/test_log_event.py`, `tests/test_logs_endpoints.py`. `tests/test_setup_endpoints.py` also exercises `logbuffer`/`diagnostics_state` incidentally through its own admin-gated routes.

```
python -m pytest tests/test_log_event.py tests/test_logs_endpoints.py -q
```

## Gotchas

- `DIAGNOSTICS` and `_BACKEND_LOG` are **never reassigned wholesale** by any function in this codebase — only mutated in place (`DIAGNOSTICS["key"] = value`, `_BACKEND_LOG.append`/`.clear()`). This is *why* every cross-module importer can safely do `from server.admin_ops.logbuffer import _BACKEND_LOG` (a bound-name import) without the staleness hazard that applies to `server/priority_lists/cache.PLANT_LISTS` (which *is* wholesale-reassigned on reload, and therefore must be accessed via `plcache.PLANT_LISTS`, never a bound import — see that domain's doc). Don't "fix" this asymmetry by making the two modules consistent; they're consistent with their own reassignment semantics, not with each other.
- Excluded from `/maintenance/*` on purpose: `VACUUM FULL` (exclusive lock), `REINDEX TABLE` (ShareLock), terminate-idle (would kill the app's own pool connections), reset-stats (destroys forensic history). Don't add these without reconsidering why they were left out.
