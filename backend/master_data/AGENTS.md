# Master Data — CRUD/DDL for the nine registered tables + the read-only universal table browser

## What lives here

- `routes.py` (23 routes) — the audit-log family (`GET /audit/log`, `POST /audit/log`, `POST /audit/log/clear`), schema export (`GET /master-data/_schema-export`), the admin universal table browser routes (`GET /admin/tables`, `GET /admin/tables/{table}`, `GET /admin/tables/{table}/export.csv`), the plant-scoped material grids (`GET /master-data/_material-grid`, `GET /master-data/_material-plant-grid`), the generic `{table}` CRUD/DDL family (`GET /master-data/{table}`, `POST .../cascade-preview`, `POST .../bulk`, `POST .../columns`, `DELETE .../columns/{column}`, `PATCH .../columns/{column}`), the per-plant policy family (`constraints`, `split-order-policy`, `max-pull-forward-days`, `max-push-forward-days`, `min-productive-segment-minutes`, `frozen-horizon-days`, `unknown-setup-policy`), and role page-access (`POST /master-data/roles/{role}/page-access`). (`GET /master-data/_audit` and `POST /master-data/plants/{plant}/visibility-horizon` were removed 2026-09 as confirmed dead — zero frontend callers; `master_data.list_audit()`/`set_plant_visibility_horizon()` were removed with them, having no other caller.)
- `browser.py` (388 lines) — whole-file move of the former `admin_tables.py`. A read-only, catalog-driven universal table browser: `list_tables()`, `fetch_rows()`, `stream_csv_rows()`, `validate_table_and_filters()`, plus the `UnknownTable`/`UnknownColumn` exceptions. Every table/column name is validated fresh, per call, against `information_schema`/`pg_constraint` — never against a hardcoded or cached list (unlike `db._get_maint_table_allowlist`, which lazily caches).

**Route-ordering hazard preserved from `brain.py`:** the literal-path routes (`_schema-export`, `_material-grid`, `_material-plant-grid`) are registered in `routes.py` *before* the generic `GET /master-data/{table}` — FastAPI/Starlette matches in registration order, not by specificity, so a literal route declared after `{table}` is permanently shadowed. (A former sibling, `_audit`, was actually unreachable in production before this was fixed, and was itself later removed entirely — see the comment preserved in `routes.py`.) `POST /master-data/material-plants/attributes` lives in `backend/integration/routes.py`, not here, and is NOT at this risk since it's a two-segment path the `{table}` `str` converter can't capture.

## Counterpart

Frontend half: `frontend/master-data/admin-ui.mts` (`MasterData` — CRUD grids, plant policy forms, role page-access) and `frontend/master-data/material-grids.mts` (`MaterialGrids` — Material / Material Plant grid UI).

Deferred split — the data layer itself stays in root `master_data.py`:
- `ALLOWED_TABLES` (the nine registered tables: `subnetworks`, `plants`, `machine`, `materials`, `material_plants`, `bom_items`, `roles`, `role_plants`, `workcenter_mapping`) — `master_data.py` lines 29–33.
- `PLANT_SCOPED_TABLES` (`{'plants', 'machine', 'material_plants', 'bom_items', 'workcenter_mapping'}`) — `master_data.py` line 43.
- `add_column()` (DDL for the "Add Column" wizard) — `master_data.py` lines 931 onward.
- `_get_maint_table_allowlist()` / `run_vacuum_analyze()` / `run_analyze()` — `db.py` lines 1612–1652 (these back `backend/admin_ops`'s maintenance routes, not this domain's, but validate against the same `pg_stat_user_tables` catalog pattern `browser.py` also uses independently).

## Key invariants & hazards

- **`PLANT_SCOPED_TABLES` is a static allowlist, deliberately not derived.** A dynamic "does this table have a `plant` column" check would let the Add-Column DDL wizard (`md.add_column`) widen a security boundary just by adding a column literally named `plant` to any table. `role_plants` itself is deliberately excluded — its `plant` column means "which plant this role can see," a different concept from "which plant this record belongs to."
- **Composite keys are the norm, not the exception.** Plants are keyed by `(subnetwork, plant)`, not plant alone (`master_data._KEY_COLUMNS`); `machine` by `(subnetwork, plant, machine)`; several others similarly. A common trap for a new plant-scoped query is assuming a bare `plant` primary key.
- **DDL-injection history, resolved.** `add_column()`'s `NUMERIC(length)` fragment was once a real DDL-injection sink (a raw user-supplied `length` string composed into SQL text). It is now validated with a regex (`precision[,scale]`, bounded 1–1000) and rebuilt via `psycopg.sql.Literal` (`master_data.py` lines 963–980) — `sql.SQL()` is a trusted-literal wrapper, not an escaper, so the raw value is never composed in directly.
- **`export_schema_sql()` (`GET /master-data/_schema-export`) is the schema-drift recovery path.** It dumps every column registered in `column_metadata` as idempotent `ADD COLUMN IF NOT EXISTS` + `column_metadata INSERT ... ON CONFLICT DO NOTHING` SQL — this is how several `machine` columns were reconstructed after going missing from both `schema.sql` and Azure (`docs/DEPLOYMENT.md`). `add_column`/`drop_column`/`rename_label` mutate the live DB directly with **no other git record** — this export is the only way to fold that drift back into `schema.sql`/a migration.
- **The admin table browser (`browser.py`) is deliberately unscoped by plant and deliberately read-only** (documented in-file as OD-E2/OD-E3): a catalog-wide "list every table" view has no single-plant version, so plant-scoping is deliberately skipped. Access is gated on `require_admin` **and** `require_api_key` (added in the 2026-09-02 `require_api_key` sweep — the plant-scoping decision (OD-E2) is unrelated to and unaffected by this), same posture as `GET /diagnostics/db` and `GET /master-data/_schema-export`. It never builds an INSERT/UPDATE/DELETE or DDL statement.
- CSV export (`GET /admin/tables/{table}/export.csv`) soft-caps at `browser.EXPORT_ROW_CAP` (250,000 rows) and signals truncation via a trailing `# NIMBUS_TRUNCATED,resume_offset=<N>,rows_written=<N>` line in the stream itself — a response header can't work here since the cap-hit fact isn't known until the body is already underway.

## Integration points

**Imports in:** `db` (`reattribute_null_plant_orders`, `backfill_machine_keys`), `master_data as md` (essentially the whole grid/DDL/policy API surface), `backend.admin_ops.logbuffer` (`_current_rid`, `_log_event`, `_set_admin_log_details`), `backend.master_data.browser as admin_tables`, `backend.priority_lists.audit_log` (`_cw_append_audit`, `_cw_audit_path` — this domain owns the `/audit/log` *endpoints*, priority_lists owns the file), `backend.security.auth` (`require_admin`, `require_api_key`).

**Imported by:** `backend/integration/routes.py` imports `master_data as md` directly for `POST /master-data/material-plants/attributes` and `POST /master-data/resync-order-attributes` (those two routes are integration-domain, not here, despite the `/master-data/*` path prefix). No other domain imports `backend.master_data.routes` or `browser` directly.

**Endpoints:** see the route list above; full paths are `/audit/log*`, `/master-data/_schema-export`, `/admin/tables*`, `/master-data/_material-grid`, `/master-data/_material-plant-grid`, `/master-data/{table}*`, `/master-data/plants/{plant}/*`, `/master-data/roles/{role}/page-access`.

## Tests

`tests/test_master_data.py`, `tests/test_admin_tables.py`, `tests/test_material_plant_attributes.py`, `tests/test_master_data_setup_policy.py`, `tests/test_system_settings.py`, `tests/test_data_integrity.py`.

```
python -m pytest tests/test_master_data.py tests/test_admin_tables.py tests/test_material_plant_attributes.py tests/test_master_data_setup_policy.py -q
```

## Gotchas

- Don't confuse this domain's `{table}` CRUD family with the `browser.py` universal browser — they look similar (both are generic-table routes) but have opposite security postures: `{table}` is allowlisted (`ALLOWED_TABLES`) and plant-scoped for writes; `browser.py` is catalog-wide, read-only, and admin-gated only.
- `master_data.py` and `db.py` are NOT split into this folder — the line numbers cited above (`master_data.py` 29–33, 43, 931+; `db.py` 1612–1652) are current as of this doc's writing but will drift; grep fresh before citing them elsewhere.
