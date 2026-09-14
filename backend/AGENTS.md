# backend/ — FastAPI domain routers

Side-wide conventions for everything under `backend/`. Domain specifics live one level down in each `backend/<domain>/CLAUDE.md` — see the directory table in root `CLAUDE.md` for the full domain list and which side (frontend/backend/both) carries the load-bearing detail for each.

## Shape

- `backend/<domain>/routes.py` holds each domain's FastAPI router, imported and registered in `brain.py` via `import backend.<domain>.routes as <domain>_routes` + `api.include_router(...)`. `brain.py` itself is a thin assembly (~700 lines) — middleware, lifespan, the nine `include_router` calls, then the `StaticFiles` mount last.
- A handful of domains also have a narrow accessor/data module alongside `routes.py` (e.g. `backend/setup/data.py`, `backend/security/auth.py`, `backend/master_data/browser.py`, `backend/priority_lists/{cache,audit_log}.py`, `backend/admin_ops/{logbuffer,diagnostics_state}.py`) — these hold genuinely cross-domain shared state or logic that more than one router reaches into, imported the same `import backend.<domain>.<module> as <alias>` way.
- **`db.py` and `master_data.py` are intentionally NOT split into `backend/<domain>/`** — every router still imports them whole, bare, from repo root (`import db`, `import master_data as md`). This is deferred work, not an oversight — see root `CLAUDE.md`'s "Deferred" note and `docs/MIGRATION.md` → "Domain refactor — deferred backend data-layer split" for the target shape when it eventually happens.
- Cross-domain imports inside this package always use the full `backend.<domain>.<module>` dotted path (never a relative `from . import`) — this is what every domain's own `CLAUDE.md` "Imports in"/"Imported by" section documents by name, so a domain's real dependency graph is grep-able rather than inferred.

## Back-compat re-exports

`brain.py` re-exports a number of names (`# noqa: E402,F401 — back-compat`) so pre-refactor test files and tools that still do `import brain` and reach into it directly (`brain.TaskDTO`, `brain._to_pydt(...)`, `brain._BACKEND_LOG`, `brain.PLANT_LISTS`, etc.) keep working without edits. `PLANT_LISTS` specifically needs a PEP 562 module-level `__getattr__` rather than a plain re-export, because `load_priority_lists()`/`_reload_one_plant_lists()` **reassign** it wholesale on reload — a plain `from backend.priority_lists.cache import PLANT_LISTS` binding would go stale. This is intentional scaffolding, not leftover duplication — don't "clean it up" without checking what still reaches through it.

## Testing

Python tests import `backend.<domain>.<module>` the same way the app does — e.g. `tests/test_setup_data.py`/`tests/test_setup_coverage.py`/`tests/test_priority_lists.py` do `import backend.setup.data as setup_data` directly, while route-level coverage generally goes through a live `TestClient`/`brain` app instance rather than importing a router module by name. Check a domain's own `CLAUDE.md` "Tests" section before assuming which style applies.

**Standing DB-safety hazard:** `.env` on dev machines can point at the live Azure pilot database. `tests/conftest.py` + `tests/support/db_safety.py` guard pytest collection; a bare `import db`/`import brain` outside pytest has no such guard — always set `NIMBUS_PG_POOL_MIN=0` and confirm `PG_HOST` is local before running one ad hoc.

## Counterpart

Frontend half: `frontend/CLAUDE.md`.
