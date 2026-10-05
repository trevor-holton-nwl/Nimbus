# Integration — order/BOM ingest, purge, attribute resync, and the SAP sync skeleton

## What lives here

- `routes.py` (515 lines, 17 routes) — `POST /upload` (Excel order ingest), `POST /bom/upload`, `POST /purge`, `GET /upload/audit`, `GET /upload/{batch_id}/missing-master-data`, `GET /master-data/{plant}/missing-master-data` (live, non-batch version), `POST /upload/audit/clear`, `POST /master-data/material-plants/attributes` (planner-editable prt_01/prt_02/color/default_machine), `POST /master-data/resync-order-attributes`, plus all 8 SAP interface routes (`GET /sap/interface/objects`, `GET|POST /sap/interface/mappings/{object}`, `GET|POST /sap/interface/config/{object}`, `POST /sap/interface/test-connection`, `POST /sap/interface/sync/{object}`, `GET /sap/interface/runs`).
- `sap_sync.py` (725 lines) — whole-file move. The transport-agnostic SAP→NIMBUS sync engine: the object catalog (`SAP_OBJECTS`, 6 objects — 5 master tables + `orders`), SAP value transforms (`_t_alpha`, `_t_dats`, `_t_tims`, `_t_decimal`, `_t_bool_x`, etc.), field-map persistence (`load_field_map`/`replace_field_map` against `sap_field_map`), `map_records()`, the connector classes (`SapConnector` base + `FileDropConnector`/`ODataConnector`/`RfcConnector`, all **stubs today** — `extract()` returns `[]`, network libs `httpx`/`pyrfc` imported lazily inside method bodies, never at module top), config persistence (`get_config`/`set_config` against `sap_sync_config`), run-history persistence (`sap_sync_run`), and the orchestrator `sync_object()`.

**Necessary internal adjustment from the pure-move otherwise promised elsewhere in this refactor:** `sap_objects()` in `routes.py` used to read the scheduler off `api.state` (brain.py's module-level FastAPI instance). Since this route no longer lives in `brain.py` and importing `api` back from `brain.py` would be circular (brain.py imports every router), it now takes `request: Request` and reads `request.app.state.sap_scheduler` instead — the same object at runtime (FastAPI stores state on the one shared app instance), so this is zero-behavior-change, not a functional change.

## Counterpart

Frontend half: `frontend/integration/sap-interface-ui.mts` (the SAP Interface admin sub-tab UI).

Deferred split — the shared ingest/upsert machinery stays in root `db.py`:
- **`db.upsert_orders`** (`db.py` lines 1897–2113) — the single upsert function **shared** by `/upload` (via `db.ingest_orders_from_excel`, which calls it) and the SAP sync path (`sap_sync.sync_object` calls `db.upsert_orders` directly for the `orders` object kind). This is the single most important cross-reference in this domain: any change to `upsert_orders`'s contract affects both the Excel upload path and SAP sync simultaneously.
- **`db._stamp_order_attributes`** (`db.py` lines 1751–1850) — Seam 2 of `docs/scheduling_priority.md`: the one place that copies `material_plants.{color,prt_01,prt_02,default_production_version}` onto `orders.{color,prt_01,prt_02,production_version}`, matched on `(plant, material_number = material_id)`. Called two ways: batch-scoped (`batch_id=...`, from inside `upsert_orders` right after every ingest upsert) and plant-scoped (`plant=...`, from `db.resync_order_attributes`, the function backing `POST /master-data/resync-order-attributes`).
- `db.ingest_orders_from_excel` (parses + normalizes the `.xlsx`, then calls `upsert_orders`) also stays in `db.py`, immediately after `upsert_orders` (starts at line 2117).

## Key invariants & hazards

- **Uploads never block on missing `material_plants` rows.** The batch-scoped attribute stamp runs automatically right after every `/upload` upsert; unmatched `(plant, material_number)` pairs become a per-batch exception report at `GET /upload/{batch_id}/missing-master-data` (`?format=csv` for a downloadable CSV) rather than failing the ingest.
- **The ingest-time stamp is convenience only.** `POST /master-data/resync-order-attributes` is the *real* mechanism for re-stamping a plant's orders on demand (e.g. after fixing `material_plants` rows) — call it rather than waiting for a re-upload. **It bumps `orders.xmin` for every matched row**, which *is* the optimistic-concurrency `base_version` — any planner's unsaved edit to an affected order is discarded on their next save (last-writer-loses reconciliation). It is both admin-gated and `role_plants`-scoped for exactly that reason; run it at a quiet moment, not mid-shift.
- **`orders.runtime_schedule_mismatch`** flags an ingest-side `RUN_TIME` change that would otherwise make prior NIMBUS timing look valid without actually reflecting the new runtime.
- **The Stage 0 observation seam:** both `/upload` and `/purge` (and SAP's order sync) call `setup_data.capture_setup_states_before_schedule_mutation(...)` immediately before the operation that would otherwise destroy the prior schedule's setup-state observability. This never changes orders, dates, capacity, alerts, or optimizer behavior — it's read-only capture.
- **SAP sync is a non-live skeleton.** All three connectors return `[]` from `extract()` and report "not configured" from `test_connection()`. No live SAP call is ever made from this code today. `NIMBUS_SAP_SYNC_ENABLED` (default off) gates the in-process APScheduler started in `brain.py`'s lifespan hook.
- **The APScheduler is safe single-replica only.** A multi-replica deployment needs a `pg_try_advisory_lock` guard so only one replica runs a given object's sync at a time (documented, not solved here — see `docs/MIGRATION.md` lines ~776–778, "Multi-replica scheduler safety").
- **Secrets discipline in `sap_sync.py`/`routes.py`:** `_SAP_SECRET_KEYS` names the `source_params` keys that must never be returned by `GET /sap/interface/config/{object}` (only `has_secret: bool` is exposed) or passed to `_log_event`. `POST .../config/{object}` merges `source_params` into the stored value rather than replacing it wholesale, so omitted keys (including secrets) survive.
- **`POST /master-data/material-plants/attributes` is deliberately NOT admin-gated** — planners, not just admins, are its users. Its write surface is a hard server-side allowlist (`md.EDITABLE_MATERIAL_PLANT_ATTRS`); it can never insert new rows, only update existing ones.

## Integration points

**Imports in:** `db`, `master_data as md`, `backend.integration.sap_sync as sap_sync` (self-package import — used for the object-catalog/mapping/config/sync routes), **`backend.setup.data as setup_data`** (a cross-domain import into the `setup` domain, for `capture_setup_states_before_schedule_mutation` — used by `/upload`, `/purge`, and `sap_sync.sync_object`), `backend.admin_ops.logbuffer` (`_log_event`, `_set_admin_log_details`), `backend.security.auth` (`require_admin`, `require_api_key`, `get_allowed_plants_for_request`).

**Imported by:** no other domain router imports `backend.integration.routes` or `backend.integration.sap_sync` directly — this domain is a consumer of `setup`, `master_data`, and `security`, not a dependency of them.

**Endpoints:** see the 17-route list above.

## Tests

No dedicated `sap_sync`-focused test file exists. `tests/test_admin_tables.py` and `tests/test_setup_data.py` each reference `sap_sync`/`SAP_OBJECTS` incidentally (the former because SAP sync tables appear in the universal table browser's catalog; the latter because of the `capture_setup_states_before_schedule_mutation` seam). Upload/purge/resync behavior is exercised through `tests/test_material_plant_attributes.py` (the resync path) and `tests/test_data_integrity.py`.

```
python -m pytest tests/test_material_plant_attributes.py tests/test_data_integrity.py tests/test_admin_tables.py -q
```

## Gotchas

- If you're tracing "who else can write to `orders`," don't stop at this domain's `/upload` — `sap_sync.sync_object` reaches the exact same `db.upsert_orders` function for the `orders` SAP object, and both routes through the identical `_stamp_order_attributes` seam afterward.
- The SAP sync engine having zero live connectors today means `POST /sap/interface/sync/{object}` and the scheduled jobs are functionally no-ops in production — don't assume "SAP sync ran" means real SAP data arrived; check `rows_read` in the run record (it will be 0 for every stub transport).
- `docs/SAP_INTEGRATION_ROADMAP.md` describes the intended live-connector future state — don't confuse it with what's actually implemented (the stub skeleton described here).

Optimizer queue state (`orders.planning_status`/`planning_reason`) is planner-owned and excluded from `_UPSERT_SQL` conflict updates, just like scheduled dates. SAP/Excel refresh updates baselines without restoring a queued schedule.

## Upload/ingest contracts added in the 2026-10 review/audit rounds

- **`csv_util` guard on every backend CSV stream.** `backend/csv_util.py` (`csv_cell`/`csv_row`/`CSV_BOM`) prefixes `'` to TEXT cells starting `= + - @ <tab> <CR>` (formula injection); numbers/dates/None pass through. It is applied by the master-data browser export, both missing-master-data CSVs (`GET /upload/{batch_id}/missing-master-data?format=csv` and the per-plant variant), the distribution aggregate CSV and the setup missing-pairs CSV, each with a UTF-8 BOM. A new CSV endpoint must use it. (The frontend/AG Grid exporters are guarded separately.)
- **`GET /upload/audit` takes `?source=sap|excel`**, filtered in SQL *before* `limit` (`db.upload_audit_log(limit, source)`; `sap` = filename `sap:sap`, `excel` = everything else; anything else is 400). The SAP Interface History tab uses `?source=sap&limit=50` instead of filtering the newest 50 of all uploads client-side.
- **`pv_kept_on_blank` (info) counts only non-distribution rows** (`parent_production_order IS NULL`): distribution children always arrive without a production version, so counting them warned on every unchanged re-upload.
- **Distribution summary entry** reports the sub-orders the parents *call for* (`counters["children_total"]`), not the rows written (`children_upserted`, which is 0 for an unchanged re-upload): "N aggregate order(s) distributed into M sub-order(s)".
- **Re-upload keeps a manual run time on routing plants and re-derives the rest** (see `backend/routing/CLAUDE.md`); a failed post-upload resolve is an `upload_audit` warning, and `POST /routing/{plant}/recompute` repairs it.
