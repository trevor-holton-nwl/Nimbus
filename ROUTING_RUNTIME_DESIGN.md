# NIMBUS Routing & Production Version Runtime — Design

Status: **DRAFT for review** · rev. 2, 2026-09-24 · Author: Trevor Holton with Claude
Original: 2026-09-16. Amended 2026-09-17 by `aggregate_to_detail.md` — the machine → work center link lives on `machine.sap_workcenter`, maintained on the Machines tab (see §3.3); routing's own decisions were unchanged by that amendment.
Rev. 2 (2026-09-24) follows a planning-expert review and a code-vs-doc review plus several rounds of decisions; see the Appendix for the full record. This revision narrows scope to repetitive manufacturing (planned orders only — there are no production orders and nothing here concerns released-order behavior), drops the SAP field-level material entirely (business terms only from here on), adds a per-plant on/off switch, and corrects several places where the draft's assumptions didn't match the live code.
Supersedes: the run-time open item in `docs/SAP_INTEGRATION_ROADMAP.md` §2/§6. This design says nothing about how routing or production-version data reaches NIMBUS from SAP — that is a separate, not-yet-built concern.
Related: `docs/scheduling_priority.md` (PV as "eventual join anchor"), `docs/MIGRATION.md` (PRT_02 → production version → BOM + routing), `aggregate_to_detail.md` §1.3 (relationship to this design).

## 1. Context

NIMBUS schedules an order for `orders.run_time` hours. Today that number is read verbatim from a run-time column on the order upload (default `1.0` when absent), never derived from quantity, and overwritten on every re-upload. There is no rate, routing, or work-center concept in the calculation path (`db.py` `_EFF_END_SQL`, `nimbus-compute-core.js` `runHours`).

This design adds two new NIMBUS master-data tables — **routing operations** and **production versions** — and computes run time from them for repetitive-manufacturing, planned orders. `orders.machine_hours` (already ingested from the order file) exists today and serves as this design's fallback when a routing calculation can't be produced. Both new tables are hand-loaded via Excel, admin-editable, and plant-scoped like every other NIMBUS master-data table; nothing in this design concerns how the underlying values get into that Excel file.

The behavior below only applies once a plant's own switch is turned on (§3.6). Until then, a plant behaves as it does today, except that a manual Excel upload now takes the file's Machine Hours (MEINH) as the run time when present and > 0, else `RUN_TIME`, else 1 h (owner decision 2026-10-13).

## 2. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Which operations count | Operations at the SAP work center that the order's NIMBUS machine maps to (via `machine.sap_workcenter`; see `aggregate_to_detail.md`). Several machines may share one work center; each adopts that work center's operations. Scope is repetitive manufacturing, planned orders only — there is no production-order concept anywhere in this design. |
| D2 | Which time counts, and how it's picked | Fixed logic read off each operation row, evaluated **per operation**, never a per-plant rule: work center category **0001 (Machine)** uses that row's machine value; category **0003 (Labor)** uses its labor value; any other category is skipped and reported. There is no fallback between machine and labor time, and setup time is never used. See the worked example in §5.4. |
| D3 | Production version on the order | Upload column `PRODUCTION_VERSION`, fallback `material_plants.default_production_version`; planner-editable in NIMBUS, and already an editable field today. |
| D4 | Lookup failure and fallback | Not fail-closed. Resolution order (§5.2): (1) compute from the routing; (2) the order file's machine-hours value (always read as machine time, source `sap_order`); (3) the order's existing run time (`legacy`); (4) otherwise hold in Needs Planning. A **missing production version** — neither the order nor the Material Plant default has one — skips this chain entirely: it always holds, with no guess and no fallback (§5.2 step 1). Manual run time is accepted only to release an order that is currently held for a routing reason; routing-sourced and file-sourced hours stay read-only. No "fudged" badge in the UI; provenance is stored, not surfaced. |
| D5 | Transition | From the day a plant's switch (`plants.routing_runtime_enabled`, §3.6) is turned on. Off: today's file run time, unchanged. On: existing scheduled orders get the new hours and are re-placed from their current start; firmed and frozen-window orders get the new hours but stay put, with an alert (§5.5). New orders on an enabled plant resolve via §5.2 or hold. |
| D6 | Recompute triggers | Whenever a production version, routing operation, routing rule, or a machine's work-center mapping changes (recompute the affected plant); whenever a planner edits an order's production version. **Not** on a quantity or machine edit — quantity has no edit feature in NIMBUS today, and a machine move doesn't yet persist on save (§8.2, §12 P3), so neither is a recompute trigger. |
| D7 | Machine move to a work center with no operation | Block the drop, toast explains; this only matters for a planner's manual move — the optimizer doesn't reassign an order's machine at all (§8.4), so there's no candidate-machine loop to guard there. |
| D8 | Production-version validity | Enforce `valid_from`/`valid_to` against the order's **SAP basic start date**, never the NIMBUS scheduled start — a drag in NIMBUS doesn't invalidate a version. Lot-size range violation is a warning only, never a hold. |
| D9 | Loading | Excel upload; **scoped replace** for routing operations (each upload replaces operations only for the routings present in that file — routings not in the file are untouched); plain upsert-by-key for production versions and rules. Uploads **reject** rows whose plant, material, or SAP work center isn't already known to NIMBUS (counted as rejected, with the reason) — this reverses the earlier idea of warning and keeping such rows. Plus a filtered mass-delete so whole routings/versions can be cleared without one-at-a-time deletes. |
| D10 | Operation filtering | Standard sequence only; admin-editable control-key exclude list; deleted operations skipped at upload time; header-status include-list when configured. `routing_rules` carries only these two rule kinds — there is no per-plant rule for which category counts (that's fixed logic, D2). |
| D11 | Calc location | Server authoritative (ingest, save, master changes). Client mirrors via a per-plant rate map, active only for enabled plants, for instant local recompute and drop blocking — same pattern as priority rank maps. |
| D12 | Master Data view | Read-only "Routing & Production Versions" sub-tab next to Material Plant and Work Centers; one row per production version × operation; loaded per plant and filtered in the browser, the same way the Material Plant grid works (§7.3). |
| D13 | Admin cockpit | Three tables in Manage Data Tables — Production Versions, Routing Operations, Routing Rules — **editable, admin only**: per-row edit, Paste Rows, Excel upload, "Delete filtered rows…". Every save or upload recomputes that plant. Plant is a filter that follows the top-bar plant, not a gate card: the grid renders at once, and with no plant chosen only the columns load and Add Row, Paste Rows, Upload and Delete Filtered stay disabled. The two large tables load their whole plant. Paste Rows on Production Versions and Routing Operations pre-checks the pasted rows through `POST /routing/validate/{table}` (the Excel upload's cleaning and rejections, no write); the operations upload asks before replacing. The machine → work center link stays on the Machines tab (`aggregate_to_detail.md`). |
| D14 | Per-plant switch | A column on the **Plants** table in Manage Data Tables: `routing_runtime_enabled`, default off (§3.6). Enabling while some machines in the plant have no work-center mapping is allowed, with a warning listing them — those machines simply can't adopt a routing until mapped. |

## 3. Data model

Two migration files under `migrations/`: `2026-09-24-routing-production-version-structure.sql` (the table and column DDL below, mirrored verbatim in `schema.sql`) and `2026-09-24-routing-production-version-backfill.sql` (the one-time `run_time_source` legacy backfill, §3.5 — guarded by the `schema_migrations` ledger, deploy-time only, never mirrored in `schema.sql`, per root `CLAUDE.md`'s rule that data-mutating steps stay ledger-guarded rather than re-appliable DDL). The structure file touches an existing table's named constraint (§3.5) and so ships through the standard destructive-change approval path rather than a plain additive migration. Timestamps follow the newer `TIMESTAMPTZ DEFAULT now()` convention (also used by `aggregate_to_detail.md`).

### 3.1 `production_version`

```sql
-- One row per (plant, material, production version) — the repetitive-manufacturing
-- routing link. There is no production-order concept in NIMBUS; this table and
-- routing_operation are the whole of "routing" as NIMBUS understands it.
CREATE TABLE IF NOT EXISTS production_version (
    plant                    TEXT        NOT NULL,
    material_id              VARCHAR(18) NOT NULL,
    production_version       VARCHAR(4)  NOT NULL,
    valid_from               DATE,
    valid_to                 DATE,
    alternative_bom          VARCHAR(2),   -- carried as delivered; not used in the calculation
    bom_usage                VARCHAR(1),   -- carried as delivered; not used in the calculation
    task_list_type           VARCHAR(1),   -- identifies which routing this version uses
    routing_group            VARCHAR(8),   -- together with task_list_type + group_counter
    group_counter            VARCHAR(2),   -- (see routing_operation's own key below)
    procurement_type         VARCHAR(1),   -- carried as delivered; not used in the calculation
    special_procurement_type VARCHAR(2),   -- carried as delivered; not used in the calculation
    costing_lot_size         NUMERIC(13,3), -- carried as delivered; not used in the calculation
    sap_workcenter           TEXT,         -- the work center this version nominally runs at
    production_version_text  VARCHAR(40),
    repetitive_mfg           BOOLEAN NOT NULL DEFAULT FALSE,
    -- Lot-size range is a warning only (§5.2) — never a hold, never a routing choice.
    lot_size_from            NUMERIC(13,3),
    lot_size_to              NUMERIC(13,3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, material_id, production_version)
);
CREATE INDEX IF NOT EXISTS idx_pv_routing_key
    ON production_version (plant, task_list_type, routing_group, group_counter);
```
Soft reference to `material_plants(material_id, plant)` by convention (no FK), matching the other plant-scoped tables — but see D9: an upload row for an unknown (plant, material) pair is now rejected outright rather than warned-and-kept. Material stays `VARCHAR(18)` to match `materials.material_id`; some source systems allow longer values, and widening is a repo-wide change, out of scope, tracked in §11 item 9. Alternative BOM, BOM usage, procurement type, special procurement type and costing lot size are carried as delivered in the template; they do not participate in the run-time calculation.

### 3.2 `routing_operation`

```sql
-- One row per operation of one routing, for one material. `group` is a reserved
-- word in Postgres, so the column is routing_group everywhere in this design.
CREATE TABLE IF NOT EXISTS routing_operation (
    plant                 TEXT        NOT NULL,
    material_id           VARCHAR(18) NOT NULL,
    task_list_type        VARCHAR(1)  NOT NULL,   -- a routing is only unique together
    routing_group         VARCHAR(8)  NOT NULL,   -- with its type, so it's in the key
    group_counter         VARCHAR(2)  NOT NULL,
    sequence_no           VARCHAR(6)  NOT NULL DEFAULT '0',
    activity               VARCHAR(4)  NOT NULL,   -- the operation number within the routing
    sap_workcenter        TEXT,                    -- where this operation runs
    -- 0001 = Machine, 0003 = Labor. Fixed logic (D2) reads this value and picks
    -- the matching value/unit pair below; any other category is skipped.
    workcenter_category   VARCHAR(4),
    base_quantity         NUMERIC(13,3),
    control_key           VARCHAR(4),
    operation_text        VARCHAR(40),
    operation_unit        VARCHAR(3),
    activity_type_machine VARCHAR(6), std_value_machine NUMERIC(9,3), std_value_unit_machine VARCHAR(3),
    activity_type_labor   VARCHAR(6), std_value_labor NUMERIC(9,3), std_value_unit_labor VARCHAR(3),
    required_overlap      BOOLEAN NOT NULL DEFAULT FALSE,
    optional_overlap      BOOLEAN NOT NULL DEFAULT FALSE,
    required_split        BOOLEAN NOT NULL DEFAULT FALSE,
    field_key             VARCHAR(7),
    num_splits            INTEGER,
    task_list_text        VARCHAR(40),
    sequence_category     VARCHAR(1) NOT NULL DEFAULT '0',  -- '0' = standard sequence (D10)
    sequence_text          VARCHAR(40),
    num_employees          NUMERIC(5,2),   -- stored, never used (§11 item 7)
    setup_group_category   VARCHAR(6),
    setup_group_key        VARCHAR(6),
    deleted                BOOLEAN NOT NULL DEFAULT FALSE,
    header_status          VARCHAR(3),
    header_valid_from      DATE,
    header_valid_to        DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, material_id, task_list_type, routing_group, group_counter, sequence_no, activity)
);
CREATE INDEX IF NOT EXISTS idx_routing_op_lookup
    ON routing_operation (plant, task_list_type, routing_group, group_counter, sap_workcenter);
```

### 3.3 Machine → work center link — `machine.sap_workcenter` (owned by `aggregate_to_detail.md`)

The retired `workcenter_mapping` table stays deregistered — dropping the physical table is deferred, not part of this change. The live link is the `machine.sap_workcenter TEXT` column — one work center per machine — maintained on the Master Data › Machines tab. The resolver reads that column. Work-center columns are `TEXT` throughout this design, matching that convention.

### 3.4 `routing_rules` (per plant)

```sql
-- Only two kinds of rule exist. Which time an operation contributes (machine or
-- labor) is fixed logic read from the operation's own category (D2) — it is
-- never a rule here.
CREATE TABLE IF NOT EXISTS routing_rules (
    plant     TEXT NOT NULL,
    rule_kind TEXT NOT NULL CHECK (rule_kind IN ('control_key','header_status')),
    code      TEXT NOT NULL,
    action    TEXT NOT NULL CHECK (action IN ('exclude','include')),
    note      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, rule_kind, code)
);
```
- `control_key` rules: `action = exclude` — operations with that control key never count.
- `header_status` rules: `action = include`. If a plant has zero `header_status` rules, every status counts; otherwise only the listed ones.
- Strictly per plant (no global rows) so `PLANT_SCOPED_TABLES` scoping stays exact. Typical plant needs a handful of rows via Paste Rows.

### 3.5 `orders` additions

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS run_time_source TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS run_time_basis JSONB;

-- A named constraint (rather than an inline CHECK) so a future value can be
-- added the same idempotent way: drop it if present, then re-add it.
DO $$
BEGIN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_run_time_source_check;
    ALTER TABLE orders ADD CONSTRAINT orders_run_time_source_check
        CHECK (run_time_source IS NULL OR run_time_source IN
            ('routing', 'manual', 'legacy', 'distributed', 'sap_order'));
END $$;
```
- `run_time_source`: `routing` = computed from a routing; `sap_order` = the order file's machine-hours fallback (§5.2's fallback order); `legacy` = carried from before the plant's switch was turned on, or from a fallback to the order's existing value; `manual` = planner-keyed while the order was held; `distributed` = a proportional share of the parent's file hours, written by Order Distribution onto a sub-order (`aggregate_to_detail.md` §5.8) — the resolver treats it exactly like `legacy` (overwritten when it resolves, kept without a flag when it can't). `NULL` only when `run_time IS NULL`.
- `run_time_basis`: JSONB — which production version was used and where it came from (the order's own value or the Material Plant default), the routing identifiers, the per-operation category and hours that were summed, any lot-size warning, and which fallback (if any) produced the number. Shown read-only in the Inspector (§8.2); never used for placement.
- Runtime-held state reuses `planning_status = 'needs_planning'` with `planning_reason = {code:'runtime_unknown', step:<§5.2 code>, message:<i18n'd text>}`. No new status value; the existing CHECK constraint permits extra keys.
- Backfill (deploy-time only, ledger-guarded, `routing_runtime_legacy_backfill`): every existing row with a non-null `run_time` and a null `run_time_source` gets `run_time_source = 'legacy'`, once.

### 3.6 `plants` — the routing-runtime switch

```sql
-- Off (default) leaves a plant's ingest and scheduling exactly as they are
-- today. On hands the plant to this design's resolver (§5) from that point on.
ALTER TABLE plants ADD COLUMN IF NOT EXISTS routing_runtime_enabled BOOLEAN NOT NULL DEFAULT FALSE;
```
Turning this on triggers the cutover described in D5/§5.5: scheduled orders in that plant get recomputed hours and are re-placed from their current start; firmed and frozen-window orders get the new hours but keep their position, with an alert. Enabling while some machines in the plant have no `sap_workcenter` mapping is allowed, with a warning listing them (D14) — an unmapped machine just can't adopt a routing until it's mapped, same as any other `no_operation_at_workcenter` case.

### 3.7 Registration (root `master_data.py`)

- `ALLOWED_TABLES` += `production_version`, `routing_operation`, `routing_rules`.
- `PLANT_SCOPED_TABLES` += the same three (all carry a physical `plant` column).
- `_KEY_COLUMNS` entries matching the primary keys above (`routing_operation`'s now includes `task_list_type`). Update the pin in `tests/test_material_plant_attributes.py` deliberately.
- `column_metadata` seed rows for every non-system column (labels — `routing_group` is labelled "Group" — `is_locked=TRUE` for key columns, `column_order`). Without these the generic grid renders empty.
- Explicit, fixed search columns for each of the three tables (today's generic table search otherwise falls back to an arbitrary column) — e.g. `production_version` searches material and version; `routing_operation` searches material, group, and operation number; `routing_rules` searches code.
- `cascade_preview`: no branch needed (nothing depends on these tables); they get the stable zero-shaped result.
- `MASS_DELETABLE_TABLES = frozenset({'production_version','routing_operation','routing_rules'})` — allowlist for §6.3.
- Nothing here registers any of this with a sync mechanism of any kind — this design defines NIMBUS's own tables and behavior only; how the data reaches NIMBUS from an upstream source is out of scope (see the header cross-reference).

## 4. Ingest changes (`db.ingest_orders_from_excel` / `db.upsert_orders` / `db._stamp_order_attributes`)

Everything below applies only to a plant whose `routing_runtime_enabled` switch is on (§3.6). For a disabled plant, ingest takes the order file's Machine Hours (MEINH) as `orders.run_time` when present and > 0, else `RUN_TIME`, else 1 h (manual Excel upload only; owner decision 2026-10-13).

1. **Stop sourcing run time from the file** for enabled plants. Inserts leave `run_time NULL`; the conflict-update `SET` no longer copies the file's run-time column. The finish-date repair that used it runs after resolution, using the resolved hours, and leaves `basic_finish_date` untouched when the order ends up held.
2. **Read `PRODUCTION_VERSION`** into `orders.production_version` (upper/strip). `_stamp_order_attributes` becomes `production_version = COALESCE(NULLIF(o.production_version,''), mp.default_production_version)`, so a planner's NIMBUS edit survives a blank upload but an explicit value in the file wins.
3. **Zero-pad textual code fields** so a spreadsheet's numeric coercion (which drops leading zeros) never creates a mismatched key: production version to 4 characters, group counter to 2, operation number to 4, sequence to 6 — left-padded with `'0'`.
4. **Resolve after Order Distribution's plan/apply step, not before.** Distribution creates or re-weights sub-orders first; the resolver then runs over the resulting rows, so each sub-order resolves at its own machine and quantity (`aggregate_to_detail.md` §5.8). Distribution's own write path (`backend/distribution/data.py`'s `plan()`/`apply()`) must never overwrite an order whose `run_time_source` is `routing` or `manual`; re-weighting a parent (`backend/distribution/data.py`'s `reweight_shares()`) calls the resolver itself for the affected sub-orders afterward.
5. **New orders on an enabled plant arrive already held** (`planning_status = 'needs_planning'`, a placeholder "runtime pending" reason) before the resolver runs, so a resolver error or a sequencing gap leaves the order visibly held instead of silently looking normal; the resolver then overwrites that placeholder with the real outcome.
6. **Do not carry forward the existing upsert behavior that flags every already-scheduled order "runtime changed" on every re-upload regardless of whether the value moved.** The resolver's write (§5.5) is the only thing allowed to set `runtime_schedule_mismatch`, and only when the number it writes actually differs from what's stored.
7. `upload_audit.warnings` gains per-batch counts: `runtime_resolved`, `runtime_unknown` (by step), `runtime_legacy_retained`, `sap_order_fallback_count`, `pv_lot_size_warnings`, `rows_rejected_unknown_reference` (§6.1).

## 5. Runtime resolution

Lives in **`backend/routing/resolver.py`** as pure functions over plain rows (unit-testable without a DB) plus a thin DB wrapper.

### 5.1 Inputs per order
`plant`, `material_number`, `production_version`, `machine`, `order_quantity`, and the order's **SAP basic start date** (not the NIMBUS scheduled start).

### 5.2 Steps and failure codes
| Step | Rule | On failure |
|---|---|---|
| 1 | A production version is present (the order's own value, or the Material Plant default) | **Hold, no fallback.** Reason `pv_missing`. |
| 2 | A `production_version` row exists for (plant, material, version) | Fall back (below) — reason `pv_not_found` if nothing rescues it |
| 3 | The version's `valid_from`/`valid_to` contains the order's SAP basic start date (inclusive; open when a bound is `NULL`) | Fall back — reason `pv_expired` |
| 4 | The order's machine has a work center (`machine.sap_workcenter`) | Fall back — reason `workcenter_unmapped` (or `no_machine` if the order has no machine at all) |
| 5 | Routing operations exist for (plant, material, task_list_type, routing_group, counter) | Fall back — reason `no_routing` |
| 6 | At least one operation survives filtering — not deleted, standard sequence, control key not excluded, header status included, at the machine's work center | Fall back — reason `no_operation_at_workcenter` |
| 7 | Each surviving operation's category is read: `0001` counts its machine value, `0003` its labor value; any other category is skipped and listed in the recompute report | (filtering, not a failure by itself) |
| 8 | The sum of hours from step 7 is greater than zero | Fall back — reason `zero_runtime` |

**Fallback order** when steps 2–8 fail: (1) the order file's machine-hours value, always read as machine time regardless of category, source `sap_order`; (2) if that's blank too, the order's existing run time, source `legacy`; (3) if that's blank too, hold in Needs Planning with the real failure step recorded. Step 1 failing skips this chain entirely — a missing production version always holds, with no guess.

**Lot size:** `order_quantity` outside `[lot_size_from, lot_size_to]` on the resolved version → warning `pv_lot_size` only; the order still resolves.

### 5.3 Units
Time-unit conversion to hours: hour-equivalent units convert at 1, minutes at 1/60, seconds at 1/3600. Any other unit on a counted operation → that operation is skipped and reported (`unit_not_time`).

### 5.4 Formula
For each operation that survives §5.2 step 6, at the machine's work center:
```
hours(op) = to_hours(value for op's category, its unit) × order_quantity / base_quantity(op)
run_time  = Σ_ops hours(op), rounded to the nearest minute
```
Category `0001` (Machine) reads that operation's machine value/unit; category `0003` (Labor) reads its labor value/unit. There is no fallback between the two, no other category counts, and setup time is never used at any step. This is fixed logic read off each row (D2) — not a per-plant rule.

**Worked example** — a routing at work center PACK01, two operations:
- operation 0010, category `0001` (Machine), 2.0 hours per 1,000 units → machine time counts;
- operation 0020, category `0003` (Labor), 1.5 hours per 1,000 units → labor time counts.

For a 2,000-unit order: (2.0 × 2000/1000) + (1.5 × 2000/1000) = 4.0 h + 3.0 h = **7.0 h**.

A simpler case shows two operations at the same work center landing on the same category and simply adding: 2.0 h + 0.5 h = **2.5 h**.

Setup- and labor-role hours that don't count toward `run_time` are still recorded in `run_time_basis` for traceability; they never affect placement.

### 5.5 Outcome writes (one set-based update, touching only rows whose value actually changes)
- **Resolved from routing:** `run_time = computed`, `run_time_source = 'routing'`, `run_time_basis = …`. If the order was held for a routing reason, it re-enters at `planning_status = 'scheduled'` exactly like a fresh ingest. **Cutover:** the first time a plant's switch turns on, this same write applies to every already-scheduled order in the plant — each is re-placed from its current start with the new hours. A firmed or frozen-window order gets the new hours but is **not** moved; it keeps its position and an alert is raised.
- **Resolved via the order-file fallback:** `run_time` = the file's machine-hours value, `run_time_source = 'sap_order'`.
- **Unresolved, order already has a `run_time`** (`legacy`, `manual`, `distributed`, or a prior `sap_order`): left untouched, no flag.
- **Unresolved, `run_time IS NULL`:** `planning_status = 'needs_planning'`, `planning_reason = {code:'runtime_unknown', step, message}`. A planner may key a value in only while the order is in this held state (D4) — that is the only time `run_time` is editable outside the resolver; once resolved from a routing or the file, it goes back to read-only.
- Never changes planning state on a scheduled, firmed, or frozen-window order except the one-time cutover described above.
- Writes use `WHERE … IS DISTINCT FROM …` so untouched rows don't bump `orders.xmin`. A plant-wide recompute can still conflict with unsaved planner edits on rows that do change — the same documented hazard as `resync-order-attributes`; recompute is admin- or master-data-triggered, never ambient.

### 5.6 Recompute report
Every resolve run returns `{resolved, unknown_by_step, legacy_retained, sap_order_fallback_count, skipped_other_category, unmapped_workcenters, lot_size_warnings}`; logged via `_log_event` and returned to the caller (upload response / recompute endpoint).

## 6. Backend API — new domain `backend/routing/`

Files: `routes.py` (router, registered in `brain.py`), `resolver.py`, `ingest.py` (Excel parsers), `models.py`, `CLAUDE.md`. Imports `db`, `master_data as md`, `backend.security.auth`, `backend.admin_ops.logbuffer`.

| Route | Guard | Purpose |
|---|---|---|
| `POST /routing/upload/production-versions` | `require_api_key + require_admin` | `.xlsx` → upsert-by-key `production_version`; returns `{inserted, updated, rejected, warnings, plants}` (`plants` = sorted distinct plants the file touched); triggers §6.4 recompute for affected plants. |
| `POST /routing/upload/operations` | same | `.xlsx` → scoped-replace `routing_operation` (§6.2); same response shape; same trigger. |
| `POST /routing/validate/{table}` | `require_api_key + require_admin` | `table ∈ {production_version, routing_operation}` else 404; body `{rows}`, over 20,000 rows → 413. Read-only Paste Rows pre-check: applies the Excel upload's header mapping, cleaning and validation to pasted rows; returns `{rows, rejected, warnings}`. |
| `GET /routing/{plant}/rate-map` | `require_authenticated` + `role_plants` check on `plant` | §8.1 payload. `Cache-Control: no-store` (corporate proxy caches by URL). |
| `POST /routing/{plant}/recompute` | `require_api_key + require_admin` + plant scope | Runs §5 over all orders in the plant; returns §5.6 report. Also the hook target after any bulk save / upload / delete touching the three tables (or a machine's work center, or the plant's switch) for that plant. |
| `GET /master-data/_routing-pv-grid` | like `_material-plant-grid` (`plant` required, scope-checked) | §7.3 married view; paged (`limit`/`offset`/`search`). **Register before `GET /master-data/{table}`** (single-segment route-shadowing hazard, `backend/master_data/routes.py`). |
| `POST /master-data/{table}/delete-filtered` | `require_api_key + require_admin` | §6.3. `table ∈ MASS_DELETABLE_TABLES` else 404. Body `{plant, search, expected_count}` mirroring `list_rows` filters; returns `{deleted}`; triggers recompute. |

Add the two upload routes, `delete-filtered`, and the recompute route to `brain.py`'s `_ADMIN_WRITE_OPERATIONS` allowlist.

### 6.1 Excel column mapping
Headers are normalized with `db.clean()` (upper, spaces→underscores). Column values are read as plain text. Required headers = the primary-key columns for that table. Material goes through `db._str_id`. The production-version upload template's headers map directly to columns, including `ALTERNATE_BOM→alternative_bom`, `BOM_USAGE`, `PROCUREMENT_TYPE`, `SPECIAL_PROCUREMENT_TYPE`, and `COSTING_LOT_SIZE` — carried as delivered, per §3.1. Unknown headers are ignored, with a warning listing them. A row with a duplicate key within the same file is rejected (reason `duplicate_key`); a row whose deletion flag is set is skipped entirely rather than stored (it could never count anyway — the column stays on the table so a planner can still mark a row deleted directly in the admin grid). **A row whose plant, material, or SAP work center isn't already known to NIMBUS is rejected** (reason `unknown_plant`, `unknown_material`, or `unknown_workcenter`), counted and listed (first 50) in `warnings` — this reverses the earlier "warn and keep" idea (D9). Rows failing key presence or numeric coercion are rejected per row the same way, never the whole file.

### 6.2 Upsert / scoped-replace semantics
`production_version` and `routing_rules`: plain `INSERT … ON CONFLICT (pk) DO UPDATE SET <all non-key cols>, updated_at = now()`, via `md.bulk_apply(table, {"upserts": rows, "deletes": []})` so the write allowlist (`column_metadata`) and readable-error mapping are reused. `routing_operation`: **scoped replace** — every (plant, material, task_list_type, routing_group, counter) combination present in the uploaded file has its existing operations deleted and replaced by that file's rows for the same combination; a routing not mentioned in the file is left untouched (a plain upsert can't remove an operation that dropped out of a re-upload, since nothing in the file would ever delete it). The replace and the resulting recompute run as two transactions, serialized per plant with a lock, so two uploads to the same plant can't interleave their recomputes.

### 6.3 Filtered mass delete
`DELETE FROM <table> WHERE plant = %s [AND <search predicate identical to list_rows>]`, available on all three tables. Server recomputes the count first and refuses if the client-supplied `expected_count` (from the grid's `meta.total`) differs, to prevent deleting a changed set. UI: toolbar button "Delete filtered rows…" with a confirm modal showing table, plant, filter text, and count.

### 6.4 Recompute hook
After `POST /master-data/{table}/bulk`, either upload, `delete-filtered`, or a `plants.routing_runtime_enabled` flip, when the write touches `{production_version, routing_operation, routing_rules, machine}` or `plants`: collect the distinct affected plants and call `resolver.resolve_orders(plant=…)` for each, after commit. Extends the existing `machine` post-write hook in `backend/master_data/routes.py`.

## 7. Frontend — master-data surfaces

### 7.1 Admin Cockpit › Manage Data Tables (`frontend/master-data/admin-ui.mts`, `frontend/index.html`)
- Three new `md-tab` buttons after Bill of Materials: `production_version`, `routing_operation`, `routing_rules` (each `data-i18n="tab.<table>"`).
- Extend `MasterDataTable`, `TABLE_LABELS`, `KEY_COLS` (must equal `_KEY_COLUMNS`). Fixed-option dropdowns for `routing_rules.rule_kind`/`action` are a small new grid mechanism (the existing `FK_SOURCE` pattern doesn't cover a fixed, hardcoded option list).
- Generalize the BOM-only upload button into an `UPLOAD_ENDPOINT: Partial<Record<MasterDataTable, string>>` map (`bom_items → /bom/upload`, `production_version → /routing/upload/production-versions`, `routing_operation → /routing/upload/operations`); the existing handler becomes table-agnostic. `routing_operation` and `production_version` require a plant pick before loading, like `bom_items` (tables are large); reuse `_renderBomGate` generalized to a `SCOPED_TABLES` set.
- "Delete filtered rows…" button for `MASS_DELETABLE_TABLES` (§6.3).
- Paste Rows and per-row edit work unchanged (generic grid); every save or upload recomputes the affected plant (§6.4).

### 7.2 Table Browser
Automatic: `backend/master_data/browser.py` lists `information_schema.tables` per request. No change.

### 7.3 Master Data view › "Routing & Production Versions" (read-only)
- Sub-tab next to Material Plant and Work Centers: button + pane in `index.html`; `MasterSubTab` union in `frontend/platform/types.mts`; one entry appended to `App._MASTER_SUBS` and `_landingSubDefs('masterdata')` in `frontend/shell/application-shell.mts`.
- Implemented as a `GridSpec` in `frontend/master-data/material-grids.mts` `SPECS` (`routing-pv`): `editableFields: []`, no `saveUrl`, endpoint `_routing-pv-grid`, `rowKey = material|pv|group|counter|seq|activity`, loaded per plant and filtered in the browser the same way the Material Plant grid works — server-side paging is deferred (§11). **Filters:** Plant (scope picker), Material, Task List Type, Group, Group Counter, SAP Work Center. Hint `ui.md_grid_admin_hint_ro`. Plant-change eviction reuses the existing `plant:selected` handler.
- Backend query: `production_version pv LEFT JOIN routing_operation ro` on (plant, material_id, task_list_type, routing_group, group_counter), plus a list of machines whose `sap_workcenter` matches the operation's work center, and a boolean `counts_toward_runtime` computed from the same category-and-filter rules as §5.2 step 6/7 (so admins can see why an operation is or isn't counted). A production version with no operations yields one row with null operation columns — a visible gap.

### 7.4 i18n
All new tab labels, grid headers, toasts, alert texts, Inspector labels via `data-i18n` / `Util.t()`, added to all five locale files (`tests/modules/locale-completeness.test.mjs` enforces an English superset). `TABLE_LABELS` stays plain English per existing convention.

## 8. Frontend — runtime behavior

### 8.1 `frontend/routing/runtime-client.mts` (new domain folder, with `CLAUDE.md`)
```
Runtime.load(plant)                    → fetches GET /routing/{plant}/rate-map, only for a plant whose switch is on (per selected plant, on plant:selected; cached; invalidated by a Store event after master saves)
Runtime.resolve(task, machine?)        → { ok:true, hours, basis } | { ok:false, step }
Runtime.eligible(task, machine)        → boolean (resolve(...).ok)
Runtime.hoursFor(task, machine?)       → number | null
```
Rate-map payload: `{ plant, generated_at, machines: { [machine]: workcenter }, pv: { "<material>|<pv>": { valid_from, valid_to, lot_from, lot_to, key:"<type>|<group>|<counter>" } }, ops: { "<type>|<group>|<counter>|<workcenter>": { minutes_per_unit } } }`. The map ships **minutes** per unit; the client multiplies by quantity and rounds to the nearest minute, matching the server's own rounding (§5.4). Sized by the plant's production versions × work centers with operations; fetched only for the selected, enabled plant. `RUN_TIME` on the task DTO stays the materialized truth for every existing consumer (`Util.runHours`, `nimbus-compute-core.js`, worker); the rate map only serves local edits and eligibility.

### 8.2 Edit hooks (`frontend/scheduling/orders.mts`, grid + Inspector)
- Quantity stays read-only in NIMBUS today, so there is no quantity-edit recompute trigger — nothing to build here.
- `MACHINE` edit: guard with `Runtime.eligible`; ineligible → reject the edit, toast `toast.no_routing_at_workcenter`. Machine-move **persistence** on save is a separate prerequisite (today a manual machine move reverts on reload, §12 P3) — the drag/edit guard blocks a move to an ineligible machine regardless of when that prerequisite ships.
- `PRODUCTION_VERSION` edit (already an editable field, not new): resolve on change; ok → update `RUN_TIME`/basis; not ok → toast + mark the task `needs_planning`/`runtime_unknown` locally (explicit planner act; server confirms on save).
- `RUN_TIME` cell/Inspector input: editable **only while the task is held for a routing reason**. A manual value sets `run_time_source = 'manual'` and releases the hold, re-entering at `basic_start_date`. Once resolved from a routing or the order file, the field goes back to read-only. Inspector shows a single read-only "Runtime basis" line built from `run_time_basis`, e.g. *"Routing · PV 0001 · Group 50001234/01 · WC MOLD01 · 2 ops · 5.9 h"* or *"Order file machine hours"* — no grid column.
- `run_time_source`, `run_time_basis` join the TaskDTO (`db.py` SELECT, `backend/scheduling/models.py`'s `NimbusTask`, `frontend/scheduling/order-field-catalog.mjs` hidden-by-default) and the `/tasks/update` payload.
- Sub-orders: Order Distribution already rejects a quantity or machine edit on a task carrying `PARENT_ORDER` (`aggregate_to_detail.md` §5.8/§8), independent of this design — nothing additional is needed here now that quantity is read-only everywhere.

### 8.3 Re-place call sites (`frontend/scheduling/gantt.mts`, `frontend/scheduling/orders.mts`)
Any edit that recomputes `RUN_TIME` on an already-scheduled task must go back through the same segment-aware re-place helper (`Engine.manualSchedulePatchFor`) it always does for a manual move. There are **six** such call sites in total: the Gantt's drag and multi-drag handling (`gantt.mts` — the drag drop, the multi-drag drop, and the split-order re-place), plus the Orders grid's cell-edit handler, the Inspector's field-change handler, and the Override dialog's `applyOverride` (all three in `orders.mts`). Before placing, each site checks `Runtime.eligible(task, targetLine)`; false → revert and toast (multi-drag: revert the whole drag with one toast naming the first offender). The Override dialog can today reassign a sub-order to a different machine, which conflicts with Order Distribution's own machine lock on sub-orders — that is an existing gap tracked in `aggregate_to_detail.md`, not something this design fixes.

### 8.4 Optimizer (`frontend/optimization/engine.mts`, `setup-scheduler.mts`)
The optimizer decides **when** an order runs on the line it's already on — it has no loop that reassigns an order to a different machine, so there is no candidate-machine loop to add an eligibility check to. `Runtime.eligible` only matters for a planner's manual drag, edit, or override (§8.2, §8.3). Tasks with `planning_reason.code === 'runtime_unknown'` are skipped entirely by the optimizer (never re-queued as `no_fit_found`), preserving the reason. A held order stays out of optimizer scope until a planner or the resolver releases it.

### 8.5 Server side of edits (`backend/scheduling/routes.py` `/tasks/update`, `db.update_task_dates_bulk`)
When a payload item carries `MACHINE` or `PRODUCTION_VERSION` for an order on an enabled plant whose `run_time_source` is `routing` (or `run_time` is `NULL`), the server re-resolves and writes its own `run_time`/basis; the client's `RUN_TIME` is ignored for such items. A sub-order's `MACHINE` is already rejected by Order Distribution's own rule (`aggregate_to_detail.md` §5.5, §8); nothing new is added here. A machine change that fails eligibility returns the existing conflict shape with `reason: 'no_operation_at_workcenter'`. Manual `RUN_TIME` is accepted only while the order is held for a routing reason. If the client thought a move was eligible and the server disagrees, the item is rejected and the client refreshes that row.

### 8.6 Alerts (`frontend/nimbus-compute-core.js` `computeAlerts`, shared by worker and sync fallback)
Alert kind `runtime-unknown`, one per affected task, severity high, text from `planning_reason.step`, fix action opens the Inspector on `RUN_TIME`. Warning kind `pv-lot-size` from `run_time_basis`'s lot-size flag. Held orders use the existing Needs Planning queue and its alert — there is no separate filter or queue for a routing-specific hold. The Dashboard "Needs Planning" KPI already counts these tasks; the alert distinguishes them by reason.

## 9. Security / RBAC
- Reads (`rate-map`, `_routing-pv-grid`, `GET /master-data/{table}`) honor `role_plants` via the existing `allowed_plants` mechanics; all three new tables are in `PLANT_SCOPED_TABLES`.
- Writes (uploads, bulk edit, delete-filtered, recompute, flipping a plant's switch) are `require_api_key + require_admin`, matching every other master-data write.
- `delete-filtered` is allowlisted by table and count-checked (§6.3). Nothing widens `EDITABLE_MATERIAL_PLANT_ATTRS`.

## 10. Tests
- `tests/test_routing_resolver.py` — pure-function coverage over `tests/modules/fixtures/routing_cases.json`: category selection, unit conversion, base-quantity scaling, sequence/control-key/deleted/header filters, production-version validity, lot-size warning, every failure step and its fallback, legacy-retained rule, minute rounding.
- `tests/modules/routing/runtime-client.test.mjs` — same fixture through the client formula (parity pin, like `tests/js/compute-core.test.js`).
- `tests/test_routing_ingest.py` — Excel header mapping, zero-padding, `_str_id`, row rejection for an unknown plant/material/work center, duplicate-key rejection, deleted-row skip (fake cursor pattern from `tests/test_master_data.py`).
- Ingest: the file's run-time column ignored on an enabled plant, unchanged on a disabled one; `PRODUCTION_VERSION` read; existing `run_time` retained; new order flagged; `upload_audit` counters.
- Plant-scoping test coverage for the enabled/disabled switch, and for the distribution-then-resolve ordering (a re-weight must not clobber a routing-sourced hour, and must itself call the resolver).
- `tests/test_material_plant_attributes.py` pin updated for `PLANT_SCOPED_TABLES`.
- `tests/test_schema_idempotent.py` + `scripts/schema_bootstrap_smoke.py` pass with the new DDL and seeds.
- `tests/modules/locale-completeness.test.mjs`, `static-assets` unchanged and green. `scripts/legacy-surface.mjs`'s pinned snapshot needs regenerating once the Override dialog and grid/Inspector edit paths pick up the new fields.
- Manual: turn the switch on for the pilot plant with one machine left unmapped (confirm the warning), upload production versions + routing operations, ingest an order file with `PRODUCTION_VERSION`, confirm the bar width matches the formula, confirm an order file's machine-hours value is used when the routing can't resolve, drag to an unmapped machine is blocked, an order with no production version at all holds with "production version missing," and cutover re-places a previously scheduled order while leaving a firmed one in place with an alert.

## 11. Flagged for review before P2 go-live
1. Confirm the order file's machine-hours value is genuinely in hours — the fallback order in §5.2 assumes so.
2. Work-center efficiency isn't modeled; a work center that runs below its rated speed would make NIMBUS's bars shorter than reality.
3. Parallel and alternative sequences aren't handled — only the standard sequence counts (D10).
4. No setup time from a routing ever counts, at any step (D2).
5. The order-file machine-hours fallback isn't rescaled by quantity — it's used exactly as uploaded.
6. No unit conversion — order quantity is assumed to already be in the routing's unit.
7. Headcount (`num_employees`) is stored but ignored, same as the overlap/split fields.
8. Operations whose category isn't Machine or Labor are skipped and reported (D2).
9. `material_id` at 18 characters vs. longer values some source systems allow — repo-wide, separate change.
10. Runtime-held reuses `needs_planning` (no new status) — the KPI lumps it in; Alerts separates it out (§8.6).
11. Legacy `run_time` values persist indefinitely until a routing resolves or a planner edits them; no expiry or badge (D5).
12. Deferred follow-ons recorded in `docs/MIGRATION.md`: custom NIMBUS-authored routings (out of scope here), server-side paging for the read-only routing view (§7.3), upload history/restore, background (non-request-synchronous) recompute, and unit conversion.

## 12. Phasing
- **P1 — Data foundation (no scheduling behavior change).** The plant switch column; migration + `schema.sql`; registration (§3.7); cockpit tabs, generalized upload button, two upload endpoints, delete-filtered; Master Data read-only sub-tab; locales; docs (`backend/routing/CLAUDE.md`, `frontend/routing/CLAUDE.md`, root `CLAUDE.md` domain row). Shippable alone: admins can load, edit, and inspect data, and the switch defaults off, so nothing schedules differently yet.
- **P2 — Resolver + ingest cutover.** `resolver.py`; `orders` columns + legacy backfill; ingest changes (§4), including the resolve-after-distribution sequencing; recompute endpoint + hooks; runtime-held flagging; alert kind; DTO fields; manual-entry gating; Inspector basis line; the cutover re-place/alert behavior when a plant's switch is turned on. Requires §11 items 1–3 confirmed for the pilot plant.
- **P3 — Client mirror.** `runtime-client.mts`; edit hooks; the six-site drop/edit guard; server-side re-resolve on `/tasks/update`. Depends on the machine-move-persistence prerequisite (today a manual machine move reverts on reload) shipping first as its own separate piece of work — the drag guard itself doesn't need it, but a persisted move is what makes the guard meaningful day to day.

## 13. Files touched (representative)
- New: `migrations/2026-09-24-routing-production-version-structure.sql`, `migrations/2026-09-24-routing-production-version-backfill.sql`, `backend/routing/{routes.py,resolver.py,ingest.py,models.py,CLAUDE.md}`, `frontend/routing/{runtime-client.mts,CLAUDE.md}`, `tests/test_routing_resolver.py`, `tests/test_routing_ingest.py`, `tests/modules/routing/runtime-client.test.mjs`, `tests/modules/fixtures/routing_cases.json`.
- Modified: `schema.sql`, `master_data.py` (registries, `_routing_pv_grid`, `delete_filtered`), `db.py` (ingest, stamp, DTO SELECT, update path), `backend/master_data/routes.py`, `backend/scheduling/{routes.py,models.py}`, `backend/distribution/data.py` (`plan`/`apply`/`reweight_shares` ordering and guard), `brain.py` (`include_router`, `_ADMIN_WRITE_OPERATIONS`, the `/tasks` wire dict), `frontend/index.html`, `frontend/master-data/{admin-ui.mts,material-grids.mts}`, `frontend/shell/application-shell.mts`, `frontend/platform/types.mts`, `frontend/scheduling/{orders.mts,gantt.mts,order-field-catalog.mjs,persistence.mts}`, `frontend/optimization/engine.mts`, `frontend/insights/insights-ui.mts`, `frontend/nimbus-compute-core.js`, `frontend/locales/*.js`, `frontend/types/api-generated.d.mts` (generated), `NimbusTask` type declarations, `tests/test_material_plant_attributes.py`, `scripts/legacy-surface.mjs` (regenerated snapshot), `docs/MIGRATION.md`, `aggregate_to_detail.md`, root `CLAUDE.md`, `backend/distribution/CLAUDE.md`.

## Appendix — Review record (2026-09-24)

**Review briefs.**
- *Planning-expert review:* a manufacturing-planning specialist read the original draft against how repetitive-manufacturing routings and production versions are actually used on the shop floor, and flagged that summing every value on an operation would double-count labor and mis-scale setup, that a routing can carry parallel/alternate sequences the draft ignored, and that "production order" concepts didn't belong in a repetitive-manufacturing shop.
- *Code-vs-doc review:* a second reviewer read the draft against the live NIMBUS codebase and found several places where its assumptions didn't match what the code does — a reserved-word column name, an ingest flag that fires on every re-upload regardless of change, Order Distribution's write ordering, six re-place call sites instead of three, and no machine-reassignment loop in the optimizer to guard.

**Decisions and reasoning.**
1. Repetitive manufacturing, planned orders only — NIMBUS's plants run repetitive manufacturing; there is no production order to route against.
2. `routing_group` naming, routing type back in the key — `group` is a reserved word in Postgres, and a routing is only unique together with its type.
3. The work-center category on the line picks the time, per operation, fixed logic, no fallback — this matches how the routing itself marks which resource performs each operation; a rule table would only recreate what the row already says.
4. Sum same-work-center operations — an order can require more than one operation at the machine it's scheduled on.
5. Labor time is crew elapsed time, headcount ignored — NIMBUS schedules machine time; headcount is a capacity question for the Labor domain, not this design.
6. Trim unit conversion, a locked flag, and lot-size/usage-based routing selection — none of it is used anywhere in the calculation, and each only adds a field nobody reads.
7. Rules keep only control-key excludes and header-status includes — the category rule is gone (decision 3), so nothing else needs a per-plant table.
8. Reject an unknown plant/material/work center on upload — silently keeping such a row just produces a silent zero-runtime order later; better to say so at upload time.
9. Scoped replace for routing operations — a plain upsert can't remove an operation that dropped out of a re-upload; only a scoped replace can.
10. Fallback order: routing → order-file machine hours → existing run time → hold — gives every order the best available number instead of failing closed the moment routing data is incomplete.
11. A missing production version holds with no fallback — a guessed version is a wrong version, while every other failure at least has the order file's own machine-hours number to fall back to.
12. Validity checked against the SAP basic start date — a NIMBUS drag isn't a new order date; using the scheduled start would make validity depend on planner behavior in NIMBUS.
13. Manual run time only releases a held order — routing- and file-sourced hours are numbers NIMBUS trusts; a planner silently overriding them would be indistinguishable from a bug.
14. Quantity stays read-only — NIMBUS has no quantity-edit feature today, so there's no trigger to build; machine-move persistence is a separate prerequisite this design doesn't include.
15. Cutover re-places scheduled orders, keeps firmed/frozen orders put with an alert — a firmed or frozen order is a planner's committed decision; the number behind it can be corrected without moving it.
16. Per-plant on/off switch on Plants — this can't turn on everywhere at once; each plant's data has to be loaded and checked first.
17. The three tables are admin-editable, not read-only, and every save recomputes — planners need to fix bad master data in place, and a stale computed number after a fix is worse than a slower save.
18. Master Data view sits next to Material Plant and Work Centers, filtered like Material Plant — that's where a planner already looks for this kind of reference data.
19. Table Browser needs no change — it already lists every table generically.
20. Held orders use the existing Needs Planning queue — a second queue for the same status would just be two places to look.
21. One read-only Inspector line, no grid column — a planner needs to see why a number is what it is, not sort or filter a whole grid by it.
22. No tie-in to how the data reaches NIMBUS from an upstream source — this design defines NIMBUS's own tables and behavior; that connector is separate, not-yet-built work.

**Findings and disposition.**
| Finding | Disposition |
|---|---|
| `group` is a reserved word | Applied — renamed to `routing_group` everywhere. |
| The ingest upsert's "runtime changed" flag fires on every re-upload, not just on an actual change | Applied — §4 now says explicitly that only the resolver's own write may set the flag, and only when the value differs. |
| Order Distribution's write step overwrites the resolver's output | Applied — resolve now runs after distribution's plan/apply, and distribution's write path is barred from touching a routing- or manual-sourced run time. |
| The save payload has no way to carry machine/quantity edits | Dropped as drift — quantity was never going to be editable in this design; decision 14 makes that explicit instead of half-building it. |
| The optimizer has no machine-reassignment loop | Applied — §8.4 now says eligibility only matters for manual moves; nothing was bolted onto a loop that doesn't exist. |
| Six re-place call sites, not three | Applied — §8.3 lists all six (Gantt ×3, grid, Override dialog, Inspector). |
| The Override dialog can still reassign a sub-order's machine | Deferred — tracked as an existing gap in Order Distribution's machine lock (`aggregate_to_detail.md`), not fixed by this design. |
| Production-version fallback to the Material Plant default | Applied — kept: a blank file value never overwrites a planner's edit. |
| Codes lose leading zeros through spreadsheet numeric coercion | Applied — §4 now zero-pads version, group counter, operation number, and sequence on ingest. |
| Whole-file upsert can't clear a dropped operation | Applied — routing-operation uploads replace by routing, not by individual row. |
| Resolver writes should be set-based, not row-by-row | Applied — one set-based update per resolve run, unchanged from the original draft. |
| A resolver error partway through could leave an order looking normal | Applied — new orders arrive held with a placeholder reason before the resolver runs. |
| No described behavior for turning a plant's switch on for the first time | Applied — decision 15; scheduled orders re-place, firmed/frozen orders stay put with an alert. |
| Unit conversion | Dropped — order quantity is assumed to already be in the routing's unit; flagged in §11. |
| A locked flag, and lot-size/usage-based routing selection | Dropped — none of it participates in the calculation. |
| Released-order / production-order handling | Dropped — repetitive manufacturing has no production orders; the concept doesn't apply. |

**Confirmed correct** (kept unchanged through both reviews): the server-authoritative calculation with a client-side rate map for instant drag feedback; reusing Needs Planning for a held order rather than adding a new status; the plant-scoped, admin-only write model matching every other master-data table; and the set-based, change-only resolver write pattern.
