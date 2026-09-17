# NIMBUS Routing & Production Version Runtime — Design

Status: **DRAFT for review** · Date: 2026-09-16 · Author: Trevor Holton with Claude
Amended: 2026-09-17 by `aggregate_to_detail.md` — the machine → work center link no longer lives in `workcenter_mapping` (retired) but on `machine.sap_workcenter`; updated at D1, D13, §4.3, §4.5, §4.6, §5, §6.2 step 4, §7.4, §8.1, §8.3, §9.2, §9.5. Routing's own decisions (run_time_source, the resolver logic, etc.) are unchanged.
Supersedes: the `run_time` **OPEN** item in `docs/SAP_INTEGRATION_ROADMAP.md` §2/§6.
Related: `docs/scheduling_priority.md` (PV as "eventual join anchor"), `docs/MIGRATION.md` (PRT_02 → production version → BOM + routing), `aggregate_to_detail.md` §1.3 (relationship to this design).

## 1. Context

NIMBUS schedules an order for `orders.run_time` hours. Today that number is read verbatim from a `RUN_TIME` column on the order upload (default `1.0` when absent), never derived from quantity, and overwritten on every re-upload. There is no rate, routing, or work-center concept in the calculation path (`db.py` `_EFF_END_SQL`, `nimbus-compute-core.js` `runHours`).

SAP holds the real answer in **routings** (task lists: PLKO header, PLPO operations, MAPL material assignment) selected through a material/plant **production version** (MKAL). This design adds both as NIMBUS master data, computes run time from them at ingest and on every relevant edit, and stops sourcing run time from the order file. Orders whose run time cannot be derived are flagged and excluded from the Gantt until a planner keys a value in or master data is fixed.

Both tables are hand-loaded (Excel) now and SAP-synced later; the design registers them so the existing SAP sync skeleton can carry them without rework.

## 2. Decisions (from planning Q&A, 2026-09-16)

| # | Decision | Choice |
|---|---|---|
| D1 | Which operations count | Only operations at the SAP work center that the order's NIMBUS machine maps to (via `machine.sap_workcenter` — see `aggregate_to_detail.md`, which retires `workcenter_mapping`). Several machines may share one work center; each adopts that work center's operations. |
| D2 | Which standard values count | Slots identified **by Activity Type code** through an admin-editable rules table. Machine-role slots drive run time. **Formula flagged for PP review (§6.4).** |
| D3 | PV on the order | Upload column `PRODUCTION_VERSION` (SAP `AFPO-VERID`), fallback `material_plants.default_production_version`; planner-editable in NIMBUS. |
| D4 | Lookup failure | Not a fudge. Order flagged **runtime unknown**, excluded from Gantt/optimizer, listed in Alerts and the orders grid, planner may key a run time manually. |
| D5 | Transition | Upload `RUN_TIME` is ignored from day one. Existing orders keep their current `run_time`. New orders resolve via routing or are flagged. A successful routing calc always overwrites a manual/legacy value. No "fudged" badge in the UI; provenance is stored, not surfaced. |
| D6 | Recompute | On every input change: quantity, machine, PV edits; and PV / routing / mapping / rules table changes (recompute affected orders in that plant). |
| D7 | Machine move to a work center with no operation | Block the drop, toast explains; optimizer treats the machine as ineligible for that order. |
| D8 | PV validity | Enforce `valid_from`/`valid_to` against the order's basic start date (violation = runtime unknown, step `pv_expired`). Lot size range violation = warning alert only. |
| D9 | Loading | Excel upload, **upsert** on primary key, per file. Plus a filtered mass-delete so rows can be cleared without one-at-a-time deletes. Work-center mapping and rules are paste/edit only. |
| D10 | Operation filtering | Standard sequence only (sequence category `0`); admin-editable control-key exclude list; deleted operations (LOEKZ) skipped; header status include-list when configured. |
| D11 | Calc location | Server authoritative (ingest, save, master changes). Client mirrors via a per-plant **rate map** for instant local recompute and drop blocking — same pattern as priority rank maps. |
| D12 | Master tab view | Read-only "Routing & Production Versions" sub-tab after Material Plant; one row per PV × operation; plant-scoped. |
| D13 | Cockpit | Three tables in Manage Data Tables: Production Versions, Routing Operations, Routing Rules. The machine → work center link is the `machine.sap_workcenter` column, maintained on the Machines tab per `aggregate_to_detail.md`. All appear in the Table Browser automatically. |
| D14 | Extract fixes accepted | Last two spec rows are Standard Value 1 + unit 1; add PLPO-LOEKZ, PLKO-STATU, PLKO-DATUV/DATUB. Standard value key (VLSCH) not added. |

## 3. SAP field review (rigor pass)

Types below follow the SAP data dictionary. Where the supplied spec differed, the SAP type wins.

**Routing (PLPO / PLKO / MAPL / CRHD)**
- Standard value units `VGE01..06` are `UNIT CHAR 3` (`MIN`, `H`, `STD`), not `Varchar 1`. All unit columns become `VARCHAR(3)`.
- Activity types `LAR01..06` are `CHAR 6` (spec said 7).
- No. of splits `SPLIM` is `NUMC 3` → `INTEGER`.
- Overlap/split flags `UEMUS`, `UEKAN`, `SPMUS` are `CHAR 1` X/blank → `BOOLEAN`.
- Field key `SLWID` is `CHAR 7`; Sequence `PLNFL` is `CHAR 6`; Sequence category `FLGAT` is `CHAR 1`; Work center category `VERWE` is `CHAR 4`; Setup group category/key `RFGRP`/`RFSCH` are `CHAR 6`; Number of employees `ANZMA` is `DEC 5,2`; Base quantity `BMSCH` is `QUAN 13,3`; Standard values `VGW0x` are `QUAN 9,3`; Operation unit `MEINH` is `CHAR 3`.
- SAP allows **six** standard values; the spec listed five. The table carries six; the sixth may be empty in the extract.
- Material on a routing row comes from `MAPL`, so the extract is MAPL × PLPO (operations repeat per assigned material). Kept denormalized as delivered; PK includes material. Row volume is bounded by the plant filter everywhere it is fetched.
- Added (per D14): `deleted` (PLPO-LOEKZ), `header_status` (PLKO-STATU, CHAR 3), `header_valid_from`/`header_valid_to` (PLKO-DATUV/DATUB).

**Production version (MKAL, with MARC fields)**
- All MKAL fields match: `VERID CHAR 4`, `ADATU/BDATU DATS`, `STLAL CHAR 2`, `STLAN CHAR 1`, `PLTYG CHAR 1`, `PLNNG CHAR 8`, `PLNAL CHAR 2`, `TEXT1 CHAR 40`, `SERKZ CHAR 1`, `BSTMI/BSTMA QUAN 13,3`. `SAP Work Center` is `MDV01` (production line, `CHAR 8`).
- `Procurement type` (MARC-BESKZ), `Special procurement` (MARC-SOBSL), `Costing lot size` (MARC-LOSGR) are material-plant attributes, not PV attributes. Carried as delivered; they do not participate in the calculation.
- Material stays `VARCHAR(18)` to match `materials.material_id`. S/4HANA allows 40; widening is a repo-wide change, out of scope, noted in §12.
- Plant is stored `TEXT` like `machine` (SAP `CHAR 4`; `material_plants.plant` is `VARCHAR(10)`).

**Identity normalization.** Joins to `orders` are plain string equality (`orders.material_number TEXT`, `orders.plant TEXT`). Uploads run material through `db._str_id` (strips the Excel `.0` suffix only). No zero-padding either way. Extracts must deliver material numbers in the same form as the order file.

## 4. Data model

Migration: `migrations/2026-09-16-routing-production-version.sql`, mirrored verbatim in `schema.sql` (pure idempotent DDL, no ledger entry needed; `column_metadata` seeds use `ON CONFLICT DO NOTHING`). Timestamps follow the newer `TIMESTAMPTZ DEFAULT now()` convention (also used by `aggregate_to_detail.md`).

### 4.1 `production_version` (MKAL)
```sql
CREATE TABLE IF NOT EXISTS production_version (
    plant                    TEXT        NOT NULL,
    material_id              VARCHAR(18) NOT NULL,
    production_version       VARCHAR(4)  NOT NULL,
    valid_from               DATE,
    valid_to                 DATE,
    alternative_bom          VARCHAR(2),
    bom_usage                VARCHAR(1),
    task_list_type           VARCHAR(1),
    task_list_group          VARCHAR(8),
    group_counter            VARCHAR(2),
    procurement_type         VARCHAR(1),
    special_procurement_type VARCHAR(2),
    costing_lot_size         NUMERIC(13,3),
    sap_workcenter           VARCHAR(8),
    production_version_text  VARCHAR(40),
    repetitive_mfg           BOOLEAN NOT NULL DEFAULT FALSE,
    lot_size_from            NUMERIC(13,3),
    lot_size_to              NUMERIC(13,3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, material_id, production_version)
);
CREATE INDEX IF NOT EXISTS idx_pv_routing_key
    ON production_version (plant, task_list_type, task_list_group, group_counter);
```
Soft reference to `material_plants(material_id, plant)` by convention (no FK), matching the other plant-scoped tables. Upload warns on unknown pairs, never rejects.

### 4.2 `routing_operation` (MAPL × PLPO + PLKO header fields)
```sql
CREATE TABLE IF NOT EXISTS routing_operation (
    plant               TEXT        NOT NULL,
    material_id         VARCHAR(18) NOT NULL,
    task_list_type      VARCHAR(1)  NOT NULL,
    task_list_group     VARCHAR(8)  NOT NULL,
    group_counter       VARCHAR(2)  NOT NULL,
    sequence_no         VARCHAR(6)  NOT NULL DEFAULT '0',
    activity            VARCHAR(4)  NOT NULL,
    sap_workcenter      VARCHAR(8),
    base_quantity       NUMERIC(13,3),
    control_key         VARCHAR(4),
    operation_text      VARCHAR(40),
    operation_unit      VARCHAR(3),
    activity_type_1 VARCHAR(6), std_value_1 NUMERIC(9,3), std_value_unit_1 VARCHAR(3),
    activity_type_2 VARCHAR(6), std_value_2 NUMERIC(9,3), std_value_unit_2 VARCHAR(3),
    activity_type_3 VARCHAR(6), std_value_3 NUMERIC(9,3), std_value_unit_3 VARCHAR(3),
    activity_type_4 VARCHAR(6), std_value_4 NUMERIC(9,3), std_value_unit_4 VARCHAR(3),
    activity_type_5 VARCHAR(6), std_value_5 NUMERIC(9,3), std_value_unit_5 VARCHAR(3),
    activity_type_6 VARCHAR(6), std_value_6 NUMERIC(9,3), std_value_unit_6 VARCHAR(3),
    required_overlap    BOOLEAN NOT NULL DEFAULT FALSE,
    optional_overlap    BOOLEAN NOT NULL DEFAULT FALSE,
    required_split      BOOLEAN NOT NULL DEFAULT FALSE,
    field_key           VARCHAR(7),
    num_splits          INTEGER,
    task_list_text      VARCHAR(40),
    sequence_category   VARCHAR(1) NOT NULL DEFAULT '0',
    sequence_text       VARCHAR(40),
    workcenter_category VARCHAR(4),
    num_employees       NUMERIC(5,2),
    setup_group_category VARCHAR(6),
    setup_group_key     VARCHAR(6),
    deleted             BOOLEAN NOT NULL DEFAULT FALSE,   -- PLPO-LOEKZ
    header_status       VARCHAR(3),                        -- PLKO-STATU
    header_valid_from   DATE,                              -- PLKO-DATUV
    header_valid_to     DATE,                              -- PLKO-DATUB
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, material_id, task_list_type, task_list_group, group_counter, sequence_no, activity)
);
CREATE INDEX IF NOT EXISTS idx_routing_op_lookup
    ON routing_operation (plant, task_list_type, task_list_group, group_counter, sap_workcenter);
```

### 4.3 Machine → work center link — `machine.sap_workcenter` (owned by `aggregate_to_detail.md`)
`workcenter_mapping` is retired by the Order Distribution design (2026-09-17). The link is the `machine.sap_workcenter TEXT` column — one work center per machine, FK to the per-plant `sap_workcenter` table — maintained on the Master Data › Machines tab. The resolver reads that column. Work-center codes stay `TEXT`.

### 4.4 `routing_rules` (per plant)
```sql
CREATE TABLE IF NOT EXISTS routing_rules (
    plant     TEXT NOT NULL,
    rule_kind TEXT NOT NULL CHECK (rule_kind IN ('activity_type','control_key','header_status')),
    code      TEXT NOT NULL,
    action    TEXT NOT NULL CHECK (action IN ('machine','setup','labor','ignore','exclude','include')),
    note      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, rule_kind, code)
);
```
- `activity_type` rules: `action ∈ {machine, setup, labor, ignore}`. An activity type with no rule is treated as `ignore` and surfaced in the recompute report (§6.6) so admins see unmapped codes.
- `control_key` rules: `action = exclude` (operations with that control key never count).
- `header_status` rules: `action = include`. If a plant has zero `header_status` rules, all statuses count; otherwise only listed ones.
- Strictly per plant (no global rows) so `PLANT_SCOPED_TABLES` scoping stays exact. Typical plant needs 3–6 rows via Paste Rows.

### 4.5 `orders` additions
```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS run_time_source TEXT
    CHECK (run_time_source IS NULL OR run_time_source IN ('routing','manual','legacy','distributed'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS run_time_basis JSONB;
```
- `run_time_source`: `routing` = computed; `manual` = planner keyed; `legacy` = carried from a pre-cutover upload (backfilled once for every row with non-null `run_time`, via a `schema_migrations`-guarded statement `routing_runtime_legacy_backfill`); `distributed` = a proportional share of the parent's uploaded run time written by Order Distribution onto a sub-order (`aggregate_to_detail.md` §5.8) — the resolver treats it exactly like `legacy` (overwritten when it resolves, kept without a flag when it cannot); `NULL` only when `run_time IS NULL`.
- `run_time_basis`: `{pv, task_list_type, group, counter, workcenter, ops:[activity…], hours_per_unit, base_qty_note, computed_at}` for traceability; shown read-only in the Inspector; never used for placement.
- Runtime-unknown state reuses `planning_status = 'needs_planning'` with `planning_reason = {code:'runtime_unknown', step:<§6.2 failure code>, message:<i18n'd text>}`. No new status value; the existing CHECK constraint permits extra keys.

### 4.6 Registration (root `master_data.py`)
- `ALLOWED_TABLES` += `production_version`, `routing_operation`, `routing_rules` (`workcenter_mapping` is removed and `sap_workcenter` registered by `aggregate_to_detail.md`).
- `PLANT_SCOPED_TABLES` += the same three (all carry a physical `plant` column). Update the pin in `tests/test_material_plant_attributes.py` deliberately.
- `_KEY_COLUMNS` entries matching the PKs above.
- `column_metadata` seed rows for every non-system column (labels, `is_locked=TRUE` for key columns, `column_order`). Without these the generic grid renders empty.
- `cascade_preview`: no branch needed (nothing depends on these tables); they get the stable zero-shaped result.
- `MASS_DELETABLE_TABLES = frozenset({'production_version','routing_operation','routing_rules'})` — allowlist for §7.3 (`aggregate_to_detail.md` adds `sap_workcenter` if this ships).
- `sap_sync.SAP_OBJECTS` += `production_version`, `routing_operation` (kind `master`), plus `_MASTER_KEY_COLUMNS` entries and a `sap_sync_config` seed row each, so future connectors flow through `md.bulk_apply` unchanged.

## 5. Ingest changes (`db.ingest_orders_from_excel` / `db.upsert_orders` / `db._stamp_order_attributes`)

1. **Stop sourcing run time from the file.** `RUN_TIME` parsing is removed; `run_time = EXCLUDED.run_time` leaves the conflict-update SET; inserts write `run_time NULL`. The finish-date repair that used `RUN_TIME` runs after resolution using the resolved hours, and leaves `basic_finish_date` untouched when unresolved.
2. **Read `PRODUCTION_VERSION`** (alias `VERID`) into `orders.production_version` (upper/strip). `_stamp_order_attributes` becomes `production_version = COALESCE(NULLIF(o.production_version,''), mp.default_production_version)`, so a planner's NIMBUS edit survives a blank upload but an explicit SAP value wins.
3. **Resolve.** Immediately after stamping (both batch- and plant-scoped variants) call `backend.routing.resolver.resolve_orders(plant=…, batch_id=… | order_ids=…)`; semantics in §6. The SAP order sync reaches the same seam through `upsert_orders`. Sub-orders created by Order Distribution are already ordinary rows in the batch at this point (its `plan` step runs before the upsert), so each resolves at its own quantity with no special case — `aggregate_to_detail.md` §5.8.
4. `runtime_schedule_mismatch` keeps its meaning: set when a resolution changes `run_time` under an order that already has `scheduled_start`; the frontend's `Engine.reconcileRuntimeSchedules` re-derives segments as today.
5. `upload_audit.warnings` gains per-batch counts: `runtime_resolved`, `runtime_unknown` (by step), `runtime_legacy_retained`, `pv_lot_size_warnings`.

## 6. Runtime resolution

Lives in **`backend/routing/resolver.py`** as pure functions over plain rows (unit-testable without a DB) plus a thin DB wrapper.

### 6.1 Inputs per order
`plant`, `material_number`, `production_version`, `machine`, `order_quantity`, `basic_start_date`.

### 6.2 Steps and failure codes
| Step | Rule | Failure `step` |
|---|---|---|
| 1 | `production_version` present | `no_pv` |
| 2 | `production_version` row for (plant, material, pv) | `pv_not_found` |
| 3 | `basic_start_date::date` within `[valid_from, valid_to]` (NULL bounds are open) | `pv_expired` |
| 4 | `machine.sap_workcenter` non-null for (plant, machine) | `workcenter_unmapped` (also `no_machine` when order has no machine) |
| 5 | `routing_operation` rows for (plant, material, task_list_type, group, counter) | `no_routing` |
| 6 | Filter: `deleted = FALSE`, `sequence_category = '0'`, control key not `exclude`d, header status included, `sap_workcenter = mapped`, header validity contains basic start when both dates present | `no_operation_at_workcenter` |
| 7 | Sum machine hours per unit (§6.4) > 0 | `zero_runtime` (e.g. all slots ignored/unmapped) |
Lot size: `order_quantity` outside `[lot_size_from, lot_size_to]` → warning `pv_lot_size` (order still resolves).

### 6.3 Units
Time-unit conversion to hours: `H`/`HR`/`STD` → 1, `MIN` → 1/60, `S`/`SEC` → 1/3600. Any other unit on a machine-role slot → that slot is skipped and reported (`unit_not_time`).

### 6.4 Formula (**flagged for PP review**)
For each surviving operation `op`:
```
machine_hours_per_unit(op) = Σ over slots i where rule(activity_type_i) = 'machine' and unit_i is a time unit:
                             to_hours(std_value_i, std_value_unit_i) / base_quantity(op)
hours_per_unit(order)      = Σ_ops machine_hours_per_unit(op)
run_time                   = hours_per_unit × order_quantity          (hours, rounded to 0.01)
```
Why machine-only and quantity-scaled: SAP's own scheduling formulas treat the three SAP1 slots differently — setup (`SAP_001`) is a fixed per-operation time not scaled by quantity, machine/processing (`SAP_002`) is `value × op qty / base qty`, and labor (`SAP_003`) runs parallel to machine time for capacity and costing rather than adding to the operation's duration. Summing all slots and scaling them all by quantity would mis-scale setup and double-count labor. Setup is NIMBUS's setup-matrix concern; labor is the Labor domain's. **This deviates from the "sum every time-unit slot" intent stated in planning and must be confirmed by Newell PP before P2 go-live** (§12 item 1). `num_splits` and overlap flags are ignored (§12).

Setup- and labor-role slot hours are computed alongside and stored in `run_time_basis` (`setup_hours`, `labor_hours_per_unit`) for later use; they do not affect placement.

### 6.5 Outcome writes (single UPDATE per order, only when something changes)
- **Resolved:** `run_time = computed`, `run_time_source = 'routing'`, `run_time_basis = …`; if the order was `needs_planning` with `runtime_unknown`, set `planning_status = 'scheduled'`, `planning_reason = NULL` (it re-enters at `basic_start_date` exactly like a fresh ingest); set `runtime_schedule_mismatch` per §5.4.
- **Unresolved, order has a `run_time` already** (`legacy`, `manual` or `distributed`): leave `run_time`/source untouched; no flag (D5).
- **Unresolved, `run_time IS NULL`:** `planning_status = 'needs_planning'`, `planning_reason = {code:'runtime_unknown', step, message}`. Replaces any prior `no_fit_found` reason (runtime is the more fundamental blocker).
- Writes use `WHERE … IS DISTINCT FROM …` so untouched rows do not bump `orders.xmin` (the optimistic-concurrency `base_version`). Plant-wide recomputes still can conflict with unsaved planner edits on changed rows — same documented hazard as `resync-order-attributes`; recompute is admin-triggered or master-data-triggered, not ambient.

### 6.6 Recompute report
Every resolve run returns `{resolved, unknown_by_step, legacy_retained, unmapped_activity_types:[…], unmapped_workcenters:[…], lot_size_warnings}`; logged via `_log_event` and returned to the caller (upload response / recompute endpoint).

## 7. Backend API — new domain `backend/routing/`

Files: `routes.py` (router, registered in `brain.py`), `resolver.py`, `ingest.py` (Excel parsers), `CLAUDE.md`. Imports `db`, `master_data as md`, `backend.security.auth`, `backend.admin_ops.logbuffer`.

| Route | Guard | Purpose |
|---|---|---|
| `POST /routing/upload/production-versions` | `require_api_key + require_admin` | `.xlsx` → upsert `production_version`; returns `{inserted, updated, rejected, warnings}`; triggers §7.4 recompute for affected plants. |
| `POST /routing/upload/operations` | same | `.xlsx` → upsert `routing_operation`; same shape; same trigger. |
| `GET /routing/{plant}/rate-map` | `require_authenticated` + `role_plants` check on `plant` | §9.1 payload. `Cache-Control: no-store` (corporate proxy caches by URL). |
| `POST /routing/{plant}/recompute` | `require_api_key + require_admin` + plant scope | Runs §6 over all orders in the plant; returns §6.6 report. Also the hook target after any bulk save / upload / delete touching the four tables for that plant. |
| `GET /master-data/_routing-pv-grid` | like `_material-plant-grid` (`plant` required, scope-checked) | §8.3 married view; paged (`limit`/`offset`/`search`). **Register before `GET /master-data/{table}`** (single-segment route-shadowing hazard, `backend/master_data/routes.py`). |
| `POST /master-data/{table}/delete-filtered` | `require_api_key + require_admin` | §7.3. `table ∈ MASS_DELETABLE_TABLES` else 404. Body `{plant, search}` mirroring `list_rows` filters; returns `{deleted}`; triggers recompute. |

### 7.1 Excel column mapping
Headers are normalized with `db.clean()` (upper, spaces→underscores). Accepted header → column, e.g. `PLANT→plant`, `MATERIAL→material_id`, `TASK_LIST_TYPE`, `GROUP→task_list_group`, `GROUP_COUNTER`, `SAP_WORK_CENTER→sap_workcenter`, `BASE_QUANTITY`, `ACTIVITY`, `CONTROL_KEY`, `OPERATION_SHORT_TEXT→operation_text`, `OPERATION_UNIT`, `ACTIVITY_TYPE_n`, `STANDARD_VALUE_n→std_value_n`, `STANDARD_VALUE_UNIT_n→std_value_unit_n`, `REQUIRED_OVERLAPPING→required_overlap` (X→TRUE), `SEQUENCE→sequence_no`, `SEQUENCE_CATEGORY`, `DELETION_INDICATOR→deleted`, `STATUS→header_status`, `VALID_FROM/VALID_TO→header_valid_from/_to`; PV file: `PRODUCTION_VERSION`, `VALID_FROM`, `VALID_TO`, `ALTERNATE_BOM→alternative_bom`, `BOM_USAGE`, `REPETITIVE_MFG` (X→TRUE), `LOT_SIZE_FROM/TO`, `PRODUCTION_VERSION_TEXT`, etc. Required headers = PK columns. Material through `db._str_id`. Unknown headers are ignored with a warning listing them. Rows failing PK presence or numeric coercion are rejected per row (count + first 50 in `warnings`), never the whole file. Unknown `(plant, material)` pairs (not in `material_plants`) → warning, row kept.

### 7.2 Upsert semantics
`INSERT … ON CONFLICT (pk) DO UPDATE SET <all non-key cols>, updated_at = now()` in one transaction per file, via `md.bulk_apply(table, {"upserts": rows, "deletes": []})` so the write allowlist (`column_metadata`) and readable-error mapping are reused rather than duplicated.

### 7.3 Filtered mass delete
`DELETE FROM <table> WHERE plant = %s [AND <search predicate identical to list_rows>]`. Server recomputes the count first and refuses if the client-supplied `expected_count` (from the grid's `meta.total`) differs, to prevent deleting a changed set. UI: toolbar button "Delete filtered rows…" on the four tables, confirm modal shows table, plant, filter text, count.

### 7.4 Recompute hook
After `POST /master-data/{table}/bulk`, the two uploads, and `delete-filtered`, when `table ∈ {production_version, routing_operation, machine, routing_rules}` (a `machine` save may change `sap_workcenter`): collect distinct plants in the write set and call `resolver.resolve_orders(plant=…)` for each, in the same request, after commit. Extends the existing `machine` post-write hook in `backend/master_data/routes.py`.

## 8. Frontend — master data surfaces

### 8.1 Admin Cockpit › Manage Data Tables (`frontend/master-data/admin-ui.mts`, `frontend/index.html`)
- Three new `md-tab` buttons after Bill of Materials: `production_version`, `routing_operation`, `routing_rules` (each `data-i18n="tab.<table>"`); the `sap_workcenter` tab comes from `aggregate_to_detail.md`.
- Extend `MasterDataTable`, `TABLE_LABELS`, `KEY_COLS` (must equal `_KEY_COLUMNS`), `FK_SOURCE` (`routing_rules.action`/`rule_kind` render as fixed-option selects).
- Generalize the BOM-only upload button into a `UPLOAD_ENDPOINT: Partial<Record<MasterDataTable, string>>` map (`bom_items → /bom/upload`, `production_version → /routing/upload/production-versions`, `routing_operation → /routing/upload/operations`); the existing handler becomes table-agnostic. `routing_operation` and `production_version` require a plant pick before loading, like `bom_items` (tables are large); reuse `_renderBomGate` generalized to a `SCOPED_TABLES` set.
- "Delete filtered rows…" button for `MASS_DELETABLE_TABLES` (§7.3).
- Paste Rows and per-row edit work unchanged (generic grid).

### 8.2 Table Browser
Automatic: `backend/master_data/browser.py` lists `information_schema.tables` per request. No change.

### 8.3 Master tab › "Routing & Production Versions" (read-only)
- Sub-tab after Material Plant: button + pane in `index.html`; `MasterSubTab` union in `frontend/platform/types.mts`; one entry appended to `App._MASTER_SUBS` and `_landingSubDefs('masterdata')` in `frontend/shell/application-shell.mts`.
- Implemented as a third `GridSpec` in `frontend/master-data/material-grids.mts` `SPECS` (`routing-pv`): `editableFields: []`, no `saveUrl`, endpoint `_routing-pv-grid`, `rowKey = material|pv|group|counter|seq|activity`, filters (checklist/bigset) on material, PV, work center, activity, control key; hint `ui.md_grid_admin_hint_ro`. Plant-change eviction reuses the existing `plant:selected` handler.
- Backend query: `production_version pv LEFT JOIN routing_operation ro ON (plant, material_id, task_list_type, task_list_group, group_counter)` plus a `string_agg` of `machine.machine` where `machine.sap_workcenter` equals the op's work center (`nimbus_machines`) and a boolean `counts_toward_runtime` computed from the same filter rules as §6.2 step 6 (so admins can see why an op is ignored). A PV with no operations yields one row with NULL operation columns — a visible gap.

### 8.4 i18n
All new tab labels, grid headers, toasts, alert texts, Inspector labels via `data-i18n` / `Util.t()`, added to all five locale files (`tests/modules/locale-completeness.test.mjs` enforces en superset). `TABLE_LABELS` stays plain English per existing convention.

## 9. Frontend — runtime behavior

### 9.1 `frontend/routing/runtime-client.mts` (new domain folder, with `CLAUDE.md`)
```
Runtime.load(plant)                    → fetches GET /routing/{plant}/rate-map (per selected plant, on plant:selected; cached; invalidated by a Store event after master saves)
Runtime.resolve(task, machine?)        → { ok:true, hours, hoursPerUnit, basis } | { ok:false, step }
Runtime.eligible(task, machine)        → boolean (resolve(...).ok)
Runtime.hoursFor(task, machine?)       → number | null
```
Rate-map payload: `{ plant, generated_at, machines: { [machine]: workcenter }, pv: { "<material>|<pv>": { valid_from, valid_to, lot_from, lot_to, key:"<type>|<group>|<counter>" } }, ops: { "<type>|<group>|<counter>|<workcenter>": { hours_per_unit, ops:[activity…] } } }`. Sized by the plant's PVs × work centers with operations; fetched only for the selected plant. The client formula is the same pinned §6.4 math, tested against the shared fixture (§11). `RUN_TIME` on the task DTO stays the materialized truth for every existing consumer (`Util.runHours`, `nimbus-compute-core.js`, worker); the rate map only serves local edits and eligibility.

### 9.2 Edit hooks (`frontend/scheduling/orders.mts`, grid + Inspector)
- `ORDER_QUANTITY_(GMEIN)` edit: if `run_time_source === 'routing'`, set `changes.RUN_TIME = Runtime.hoursFor(task)` and re-place from the existing start via `manualSchedulePatchFor` (today a qty edit changes nothing).
- `MACHINE` edit: guard with `Runtime.eligible`; ineligible → reject the edit, toast `toast.no_routing_at_workcenter`. Eligible → recompute `RUN_TIME` then place.
- `PRODUCTION_VERSION` edit (new editable field): resolve; ok → update `RUN_TIME`; not ok → toast + mark the task `needs_planning`/`runtime_unknown` locally (explicit planner act; server confirms on save).
- `RUN_TIME` cell/Inspector input: editable only when `run_time_source !== 'routing'`; a manual value sets `run_time_source = 'manual'`, and if the task was `runtime_unknown` it re-enters as `scheduled` at `basic_start_date`. Inspector shows a read-only "Runtime basis" line from `run_time_basis` (PV, group/counter, work center, ops).
- `run_time_source`, `run_time_basis` join the TaskDTO (`db.py` SELECT, `backend/scheduling/models.py`, `frontend/scheduling/order-field-catalog.mjs` hidden-by-default) and the `/tasks/update` payload.
- **Sub-orders are excluded from the quantity and machine edit paths.** A task with `PARENT_ORDER` (Order Distribution, `aggregate_to_detail.md` §8) owns neither its quantity nor its machine — both belong to its distribution shares — so the `ORDER_QUANTITY_(GMEIN)` and `MACHINE` edits above are rejected for it with the distribution toasts, before this design's eligibility guard runs. Re-weighting a parent calls `resolver.resolve_orders(order_ids=…)` for its sub-orders itself (`aggregate_to_detail.md` §5.8).

### 9.3 Gantt drop guard (`frontend/scheduling/gantt.mts`, the three `manualSchedulePatchFor` call sites)
Before placing, `Runtime.eligible(task, newLine)`; false → revert the item to its prior position and toast. Multi-drag: if any dragged task is ineligible on its target, revert the whole drag with one toast naming the first offender.

### 9.4 Optimizer (`frontend/optimization/engine.mts`, `setup-scheduler.mts`)
- Candidate-machine loops (the `allowedLines` filters) additionally skip machines where `Runtime.eligible(task, line)` is false for routing-sourced tasks.
- Tasks with `planning_reason.code === 'runtime_unknown'` are skipped entirely (never re-queued as `no_fit_found`), preserving the reason.

### 9.5 Server side of edits (`backend/scheduling/routes.py` `/tasks/update`, `db.update_task_dates_bulk`)
When a payload item carries `MACHINE`, `ORDER_QUANTITY`, or `PRODUCTION_VERSION` for an order whose `run_time_source` is `routing` (or `run_time` is NULL), the server re-resolves and writes its own `run_time`/basis; the client's `RUN_TIME` is ignored for such items. For a sub-order (`parent_production_order IS NOT NULL`) a payload `MACHINE` or `ORDER_QUANTITY` is rejected with 400 `distribution_locked` — those values are written only by `backend/distribution/` (`aggregate_to_detail.md` §5.5, §8). A machine change that fails eligibility returns the existing `409`-style conflict shape with `reason: 'no_operation_at_workcenter'`. Manual `RUN_TIME` is accepted only when `run_time_source !== 'routing'`.

### 9.6 Alerts (`frontend/nimbus-compute-core.js` `computeAlerts`, shared by worker and sync fallback)
New alert kind `runtime-unknown`, one per affected task, severity high, text from `planning_reason.step`, fix action opens the Inspector on `RUN_TIME`. New warning kind `pv-lot-size` from `run_time_basis.lot_size_warning`. Dashboard "Needs Planning" KPI already counts these tasks; the alert distinguishes them.

## 10. Security / RBAC
- Reads (`rate-map`, `_routing-pv-grid`, `GET /master-data/{table}`) honor `role_plants` via the existing `allowed_plants` mechanics; all three new tables are in `PLANT_SCOPED_TABLES`.
- Writes (uploads, bulk, delete-filtered, recompute) are `require_api_key + require_admin`, matching `/bom/upload`.
- `delete-filtered` is allowlisted by table and count-checked (§7.3). Nothing widens `EDITABLE_MATERIAL_PLANT_ATTRS`.

## 11. Tests
- `tests/test_routing_resolver.py` — pure-function coverage over `tests/fixtures/routing_cases.json`: role mapping, unit conversion, base-quantity scaling, sequence/control-key/deleted/header filters, PV validity, lot-size warning, every failure step, legacy-retained rule, rounding.
- `tests/modules/routing/runtime-client.test.mjs` — same fixture through the client formula (parity pin, like `tests/js/compute-core.test.js`).
- `tests/test_routing_ingest.py` — Excel header mapping, X→boolean, `_str_id`, row rejection, unknown-pair warning (fake cursor pattern from `tests/test_master_data.py`).
- Ingest: `RUN_TIME` column ignored; `PRODUCTION_VERSION` read; existing `run_time` retained; new order flagged; upload_audit counters.
- `tests/test_material_plant_attributes.py` pin updated for `PLANT_SCOPED_TABLES`.
- `tests/test_schema_idempotent.py` + `scripts/schema_bootstrap_smoke.py` pass with new DDL and seeds.
- `tests/modules/locale-completeness.test.mjs`, `static-assets`, `legacy-surface` unchanged and green.
- Manual: upload PV + routing for the pilot plant, map one machine, ingest an order file with `PRODUCTION_VERSION`, confirm bar width = formula, drag to an unmapped machine is blocked, unknown order appears in Alerts and keys in manually.

## 12. Flagged for review before P2 go-live
1. **Formula** (§6.4): machine-only, quantity-scaled, setup and labor excluded — confirm with Newell PP against how the plants' work centers are actually configured (standard value key and scheduling formula per work center).
2. **Activity type codes** per role (machine/setup/labor) — needed to seed `routing_rules`; until present, every slot is `ignore` and every order is `zero_runtime`.
3. **Control keys** to exclude and **header statuses** to include, per plant.
4. Six standard value slots vs. the five in the extract.
5. Order quantity is assumed in the operation's unit; no UoM conversion.
6. `num_splits`, overlap flags, and `num_employees` are stored but ignored.
7. Runtime-unknown reuses `needs_planning` (no new status) — KPI lumps them; Alerts separate them.
8. `material_id VARCHAR(18)` vs S/4 40-char materials (repo-wide, separate change).
9. Legacy `run_time` values persist indefinitely until a routing resolves or a planner edits; no expiry or badge (per D5).
10. PV `sap_workcenter` (MDV01) vs the machine's mapped work center disagreeing is not checked; candidate for a later warning.
11. Deferred follow-ons recorded in `docs/MIGRATION.md`: labor-role hours → Labor domain; setup-role hours → setup matrix `derived` source; SAP connectors for the two new objects; BOM join via `alternative_bom`/`bom_usage` (note `orders.bom_alternative` is INTEGER vs SAP CHAR 2).

## 13. Phasing
- **P1 — Data foundation (no scheduling behavior change).** Migration + `schema.sql`; registration (§4.6); cockpit tabs, generalized upload button, two upload endpoints, delete-filtered; Master married sub-tab; SAP object registration; locales; docs (`backend/routing/CLAUDE.md`, `frontend/routing/CLAUDE.md`, root `CLAUDE.md` domain row). Shippable alone: admins can load and inspect data.
- **P2 — Resolver + ingest cutover.** `resolver.py`; `orders` columns + legacy backfill; ingest changes (§5); recompute endpoint + hooks; runtime-unknown flagging; alert kind; DTO fields; manual-entry gating; Inspector basis line. Requires §12 items 1–3 answered for the pilot plant.
- **P3 — Client mirror.** `runtime-client.mts`; edit hooks; drop guard; optimizer eligibility; server-side re-resolve on `/tasks/update`.

## 14. Files touched (representative)
- New: `migrations/2026-09-16-routing-production-version.sql`, `backend/routing/{routes.py,resolver.py,ingest.py,CLAUDE.md}`, `frontend/routing/{runtime-client.mts,CLAUDE.md}`, `tests/test_routing_resolver.py`, `tests/test_routing_ingest.py`, `tests/modules/routing/runtime-client.test.mjs`, `tests/fixtures/routing_cases.json`.
- Modified: `schema.sql`, `master_data.py` (registries, `_routing_pv_grid`, `delete_filtered`), `db.py` (ingest, stamp, DTO SELECT, update path), `backend/master_data/routes.py`, `backend/scheduling/{routes.py,models.py}`, `backend/integration/sap_sync.py`, `brain.py` (include_router), `frontend/index.html`, `frontend/master-data/{admin-ui.mts,material-grids.mts}`, `frontend/shell/application-shell.mts`, `frontend/platform/types.mts`, `frontend/scheduling/{orders.mts,gantt.mts,order-field-catalog.mjs,persistence.mts}`, `frontend/optimization/{engine.mts,setup-scheduler.mts}`, `frontend/nimbus-compute-core.js`, `frontend/locales/*.js`, `tests/test_material_plant_attributes.py`, `docs/SAP_INTEGRATION_ROADMAP.md`, `docs/MIGRATION.md`, root `CLAUDE.md`.
