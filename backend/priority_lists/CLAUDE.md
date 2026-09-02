# Priority Lists — per-plant rankable-field upload/read/delete + legacy color-wheel compat

## What lives here

- `routes.py` (9 routes) — the generic priority-list family (`GET /priority-fields`, `GET /priority-rank-maps`, `GET /priority-lists`, `POST|GET|DELETE /priority-list/{plant}/{field_key}`), the legacy color-wheel-shaped compat family (`POST|GET|DELETE /color-wheel/{plant}`), plus the shared helpers `_resolve_priority_list_columns` (column/value/rank resolution + validation, shared by both upload paths) and `_persist_priority_list` (shared upsert+audit+cache-reload step). (`GET /color-wheels` was removed 2026-09 as confirmed dead — zero frontend callers; its own docstring cited a `frontend/plant-and-administration.mts` that no longer exists in this tree.)
- `cache.py` (207 lines) — `PLANT_LISTS` (`{plant: {machine_or_'': {field_key: {VALUE: RANK}}}}`), `load_priority_lists()`, `_reload_one_plant_lists(plant)`, and `apply_priority_merge(df, plant=None)` + its private helper `_apply_priority_scope`. `apply_priority_merge` deliberately lives in the *same* module as `PLANT_LISTS` (not a separate reader module) because `load_priority_lists`/`_reload_one_plant_lists` **reassign** `PLANT_LISTS` wholesale — a cross-module `from ... import PLANT_LISTS` binding would go stale across a reload; every cross-module reader instead does `from backend.priority_lists import cache as plcache; plcache.PLANT_LISTS...`.
- `audit_log.py` (59 lines) — `COLOR_WHEEL_DIR`, `_cw_audit_path()`, `_cw_append_audit()`, `_migrate_audit_log()` (JSON-array → JSON-Lines, idempotent, runs once at startup). This is the `_audit_log.json` trail shared with `master_data`'s `GET/POST /audit/log` endpoints (see `backend/master_data/CLAUDE.md`) and with `optimization_run` events posted from the frontend.

`brain.py` still exposes a `PLANT_LISTS`-shaped attribute via a PEP 562 module `__getattr__` shim for backward compat with any code that did `brain.PLANT_LISTS` — this file (`cache.py`) is the real owner now.

## Counterpart

Frontend half: `frontend/priority-lists/mapping.mts` (`PriorityListMapping` — the upload/column-mapping modal) and `frontend/priority-lists/viewers.mts` (`ColorWheelViewer` — the legacy preview modal).

Deferred split: `RANKABLE_FIELDS` and `CONFIGURABLE_PRIORITY_FIELDS` — the single source of truth for which fields are rankable (`colorWheel`/`prt01`/`prt02`/`productionVersion`, with `productionVersion` excluded from `CONFIGURABLE_PRIORITY_FIELDS`) — still physically live in root `master_data.py` (lines 120–145, current as of this doc). `routes.py` imports them as `md.RANKABLE_FIELDS`/`md.CONFIGURABLE_PRIORITY_FIELDS`. This extraction is explicitly deferred per `docs/MIGRATION.md`.

## Key invariants & hazards

- **No global fallback tier.** A plant with nothing uploaded just has no `PLANT_LISTS` entry — `GLOBAL_CW`/`COLOR_FILE` are retired (2026-08-11 generalization from the old color-only `color_wheel` table).
- **Ranks are never stamped onto `orders` or the task DTO.** They resolve client-side from per-plant maps via `GET /priority-rank-maps`, precisely because a stamped rank goes stale the instant an order changes machine (drag-between-machines, or the editable Orders-grid machine column).
- **`PLANT_LISTS` cache lifecycle:** loaded at startup, on `POST /reload` (in `backend/admin_ops/routes.py`, which calls `plcache.load_priority_lists()`), and inline (`plcache._reload_one_plant_lists(plant)`) after every priority-list/color-wheel upload or delete.
- **`PLANT_LISTS` is per-process, and so is `POST /reload`'s effect.** On a multi-replica deployment, `POST /reload` only refreshes the replica that handled the request — every other replica keeps serving whatever `PLANT_LISTS` it loaded at its own last startup/reload until it independently receives its own `/reload` call or restarts. The pilot is single-replica, so this is a known, accepted limitation, not a bug — same posture as `backend/admin_ops/CLAUDE.md`'s `_BACKEND_LOG` note.
- **`_audit_log.json` durability caveat:** a flat append-only JSONL file, not a database table — ephemeral, a known durability gap (see `docs/MIGRATION.md`).
- **This domain owns Seam 2's *reader* side, not the writer.** `docs/scheduling_priority.md`'s Seam 2 (attribute materialization) is `db._stamp_order_attributes`, which copies `material_plants.{color,prt_01,prt_02,default_production_version}` onto `orders.{color,prt_01,prt_02,production_version}` — that function lives in root `db.py` and is described in depth in `backend/integration/CLAUDE.md` (it runs from `/upload` and `/master-data/resync-order-attributes`, both integration-domain routes). `apply_priority_merge` here is downstream of that stamp: it reads the already-materialized `orders.color` (etc.) and the `PLANT_LISTS` rank maps to compute `ORDER_Y` for presentation/link-building order.
- **Nobody has validated real `prt_01`/`prt_02` values against a real uploaded list** — per-field coverage (`GET /priority-lists`' `coverage` key, backed by `db.priority_list_coverage`) is the only guard against a misspelled list silently ranking everything 999999. Read `docs/scheduling_priority.md` for the three-stage architecture and open risks; don't duplicate it here.
- `ROW_ORDER_SENTINEL = "__row_order__"` in `routes.py` must stay in sync with the mapping modal's "— use row order —" `<option>` value in `frontend/priority-lists/mapping.mts` / `frontend/index.html`.

## Integration points

**Imports in:** `db` (query/upsert/coverage functions), `master_data as md` (`RANKABLE_FIELDS`, `CONFIGURABLE_PRIORITY_FIELDS`, `_assert_plant_allowed`, `known_line_codes_for_plant`), `backend.admin_ops.logbuffer._log_event`, `backend.security.auth` (`require_admin`, `get_allowed_plants_for_request`) and `backend.security.auth.require_api_key`.

**Imported by:** `backend/admin_ops/routes.py` (`from backend.priority_lists import cache as plcache`, for `POST /reload` and diagnostics color-merge stats), `backend/master_data/routes.py` (`from backend.priority_lists.audit_log import _cw_append_audit, _cw_audit_path`, for `GET/POST/POST-clear /audit/log`). `apply_priority_merge` is called once per `GET /tasks` request from `backend/scheduling/routes.py` (not vice versa — `scheduling` doesn't need a `cache` re-export, per the same-module-reader design above).

**Endpoints:** `GET /priority-fields`, `GET /priority-rank-maps`, `GET /priority-lists`, `POST|GET|DELETE /priority-list/{plant}/{field_key}`, `POST|GET|DELETE /color-wheel/{plant}`.

## Tests

`tests/test_priority_lists.py` (generic + legacy color-wheel upload/read/delete contracts, mapping resolution, coverage), `tests/test_color_wheel_store.py` (older color-wheel-store-shaped assertions).

```
python -m pytest tests/test_priority_lists.py tests/test_color_wheel_store.py -q
```

## Gotchas

- `docs/scheduling_priority.md` is the design-of-record for this domain's three stages; all three shipped (generic upload + mapping UI, per-field coverage, `/priority-fields` registry + optimizer wiring) — trust git log over any stale checkbox there.
- The legacy `/color-wheel/{plant}` upload route deliberately preserves *looser* validation than the generic `/priority-list/{plant}/{field_key}` route (no `needs_mapping` round-trip, `reject_conflicts=False`, no empty-file rejection) — this is intentional back-compat (Decision 9b in the referenced plan doc), not an inconsistency to "fix."
