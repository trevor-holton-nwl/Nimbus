# SAP ECC Staging Tables in NIMBUS — Design of Record

| | |
|---|---|
| **Status** | Design of record — implementation in progress on `feature/sap-staging` |
| **Date** | 2026-10-07 |
| **Source FSD** | `Nimbus_ECC_Integration_FSD.docx` ("Nimbus – SAP ECC Integration", v2.0, 2026-10-02) |
| **Companion docs** | `docs/NIMBUS_INTERFACE_ARCHITECTURE.md`, `docs/SAP_INTEGRATION_ROADMAP.md` |

Decisions D1–D35 are settled with the owner (§2). Code anchors were verified against live `main` (e6567a0) by two verification passes. Designed after a stress test (owner request: "this is our first interfacing attempt, it must not jeopardize the application").

## 1. Context

**Why.** The FSD "Nimbus – SAP ECC Integration" (v2.0, 2026-10-02, `Nimbus_ECC_Integration_FSD.docx`, submitted to SAP Development) defines the SAP-side build: a Nimbus plant control table, a Material Plant export, a Routing export, a Planned Order export (SAP → NIMBUS) and a Planned Order import (NIMBUS → SAP). Each export is written to an SAP staging table and transmitted; Mulesoft carries both directions.

**Gap.** NIMBUS has no landing zone. Orders and master data arrive by Excel upload straight into live tables. The SAP interface skeleton (`backend/integration/sap_sync.py`, tables `sap_sync_config` / `sap_sync_run` / `sap_field_map`, the Admin › Interface tab) exists but every connector is a stub, and NIMBUS has never written anything back to SAP.

**Outcome.** Matching staging tables on the NIMBUS side. SAP data **lands first, is validated, and is promoted ("applied") into live tables under admin control**. Inbound staging columns are named by their SAP field (the contract Mulesoft fills); NIMBUS adds resolved key columns in its own terms. Nothing flows automatically unless an admin has switched that object to automatic. One outbound table carries the plant schedule back to SAP, and NIMBUS remembers what it sent so SAP's echo never wipes a schedule.

**What users see.** A Staging section in Admin › Interface: batches per object and plant with counts, rejections with reasons, the list of orders a batch would delete, Apply / Confirm / Discard buttons, a manual/auto switch per object, an Excel upload into staging for testing, a Send to SAP button per plant with ready / sent / error status, and a 30-day archive of deleted orders with Restore.

## 2. Decisions settled with the owner (2026-10-07) — do not re-ask

### 2.1 From the design round

| # | Topic | Decision |
|---|---|---|
| D1 | Gate | Per-object `apply_mode`: **manual** (default) or **auto**. Rows land pending; manual = admin reviews then clicks Apply; auto = applied right after validation. Only field-map rows marked active flow into live columns. |
| D2 | Transport in | **Mulesoft writes directly into the Postgres staging tables** using its own restricted DB role. No inbound HTTP endpoint. An Excel/CSV upload into staging (SAP column headers) exists for testing and fallback. |
| D3 | Detection | NIMBUS **polls** the staging tables on a timer (own env knob, independent of the per-object cron) and re-checks on demand when the Interface tab opens. |
| D4 | Snapshot | Every batch is a **full snapshot per plant** for that object. Absence from the snapshot is meaningful. |
| D5 | Naming | Inbound staging columns are the **SAP field names, lowercased**. Housekeeping columns plus **resolved NIMBUS key columns** (`material_id`, `plant`, `production_order`) are filled at validation. `sap_field_map` records SAP column → live column. |
| D6 | Routing | **Two** staging tables mirroring live `production_version` (18 columns) and `routing_operation` (34 columns), **NIMBUS column names for now**; SAP names arrive from SAP Development later as a rename. Field list: Appendix B. |
| D7 | Unmapped fields | Fields with no live home **stay staging-only** until a feature needs them. |
| D8 | Horizon | Planning horizon = existing `plants.visibility_horizon_days`; order scope = visibility horizon **+ 1 day**. No new plant column. `plants` is the approved-plant gate. |
| D9 | Outbound scope | Send to SAP queues **all orders in the plant that have a scheduled end**. |
| D10 | Firm rule out | Firm Indicator = 'X' if planner-firmed **or** inside the frozen horizon **or** SAP already had it firmed. Add-only. |
| D11 | Retention | **Latest batch per object + plant only.** |
| D12 | Vanished orders | Orders absent from the latest complete snapshot (same plant, in horizon) are **deleted on apply**, whatever their origin (SAP or Excel). Safeguards: batch complete (row count matches) and a **25 %** hold threshold with admin confirmation. |
| D13 | Vanished master rows | Material-plant / production-version rows absent from the snapshot: **delete when unreferenced, otherwise flag**. Routing operations: absent routings **are deleted**; dependent orders go on hold. |
| D14 | Permissions | Apply and Send to SAP are **admin only**, plant-scoped. |
| D15 | Order quantity | Scheduled quantity = **total minus reduced**; initial and reduced stored as today. Quantity reset is judged on total quantity, not open quantity — a partial conversion does not unschedule. |
| D16 | New material | Material-plant apply **creates a bare `materials` row** when unknown. |
| D17 | Sub-orders out | Distribution sub-orders **roll up to one parent row**. |
| D18 | Test upload | Excel-to-staging upload uses **SAP field names** and **never auto-applies**. |
| D19 | First apply | The one-time slot reset on a plant's first SAP batch is **accepted**. |

### 2.2 From the stress test

| # | Topic | Decision |
|---|---|---|
| D20 | Echo loop | **Remember what was sent.** At Send, NIMBUS records per order the end date/time, version and firm flag it sent. On import, a finish equal to the sent finish (and a version equal to the sent version) is **not** an SAP change even if SAP back-scheduled the start; only a finish, version or work center that differs from what NIMBUS sent re-plans the order. Refined after review: the sent values are not cleared by a planner edit; they are overwritten by the next Send. Reason: clearing let SAP's echo of the old send wipe the planner's newer edit. Stored in the side table `order_sap_sent`, not on `orders`, so a Send never bumps an order's xmin. |
| D21 | Converted orders | A planned order converted to a production order leaves the export and is **deleted like any vanished order — including running ones**. (The existing "running orders are never reset" protection applies to SAP changes, not to vanish deletes; the archive (D29) is the recovery path.) |
| D22 | Window | **Trust that SAP's planning horizon and NIMBUS's visibility horizon are kept equal** by hand; NIMBUS uses its own. Guard: a plant with unlimited visibility horizon never deletes, with a warning. Documented operational rule. |
| D23 | Run time | The planned-order export has no run time. A batch for a plant whose **routing-runtime switch is off, or that has no routings loaded, is held** with a clear warning until routing is enabled. |
| D24 | Material format | NIMBUS stores materials **without leading zeros**. The SAP path **strips leading zeros from numeric materials** (orders, material plants, routing keys) so SAP rows update existing data instead of duplicating it. Alphanumeric materials are kept as-is. |
| D25 | Subnetwork | SAP's 4-character subnetwork is **truncated to its first 3 characters** when mapped to NIMBUS's subnetwork. |
| D26 | Zero open quantity | Total minus reduced ≤ 0 → the order lands in **Needs Planning with reason `zero_open_quantity`** and is never auto-scheduled. |
| D27 | Plant | Planning plant **is** the producing plant; it is the NIMBUS plant. |
| D28 | Auto timing | Auto mode **applies immediately**, any time (SAP schedules the feed off-hours; ad-hoc runs are expected to land at once). |
| D29 | Archive | Vanish-deleted orders (with their schedule segments) are **copied to an archive table for 30 days**; admins can view and restore. |
| D30 | Description | **FSD change request:** add Material Description to the Material Plant export. Until then new materials have blank descriptions; existing ones are kept. |
| D31 | Mulesoft facts | Runtime location, egress IPs and per-row write-back are **unknown**; design for both, code assumes Mulesoft can update row status; the facts are go-live prerequisites. |
| D32 | Machine field | The export's production line (MDV01) **is** the work-center value today's MACHINE column carries; distribution resolves it. |
| D33 | Material Plant scope | The export carries **all materials regardless of status**, so delete-when-unreferenced is safe. |
| D34 | Time zone | SAP times are in the **SAP system time zone**, not plant-local. NIMBUS converts in and out using a configurable zone (`NIMBUS_SAP_SYSTEM_TZ`, IANA name, value to be confirmed with SAP Development) and each plant's own time zone. |
| D35 | Live refresh | Open planner sessions learn of applied batches only on save or reload. **Accepted for the pilot**; a "data changed, refresh" banner is deferred work. |

## 3. Design

### 3.1 Tables (all new, additive, `TIMESTAMPTZ DEFAULT now()`)

| Table | Role | Key points |
|---|---|---|
| `sap_stage_batch` | Batch header, one per (object, plant, snapshot) | `batch_id UUID PK`, `object_key`, `plant`, `source` (mulesoft / upload), `status` (loading → ready → validated / held / rejected → applying → applied / error / superseded / discarded), `row_count_expected`, timestamps, `applied_by`, `counts JSONB`, `warnings JSONB`, `error`. |
| `sap_stage_material_plant` | Material Plant export | 13 SAP-named columns + housekeeping + resolved `material_id`, `plant`. |
| `sap_stage_planned_order` | Planned Order export | 25 SAP-named columns; dates/times as **raw text** (a malformed value is a row rejection, never a failed Mulesoft insert); quantities NUMERIC(13,3). Resolved `production_order`, `material_id`, `plant`. |
| `sap_stage_production_version` | Routing part 1 | Live `production_version` columns + housekeeping. |
| `sap_stage_routing_operation` | Routing part 2 | Live `routing_operation` columns + housekeeping. |
| `sap_stage_planned_order_out` | Planned Order import (NIMBUS → SAP) | `send_batch_id`, `plant`, `matnr`, `plwrk`, `plnum`, `verid`, `pedtr DATE`, `pedti TIME` (SAP system zone), `auffx`, `row_status` (ready / sent / error), `queued_at/by`, `sent_at`, `error_text`, `nimbus_order_id`. |
| `sap_stage_vanished_order` | Archive (D29) | `batch_id`, `plant`, `order_row JSONB` (full `orders` row), `segments JSONB`, `shares JSONB`, `deleted_at`, `restored_at`, `restored_by`. Purged after 30 days by the poll. |

Row housekeeping on every inbound table: `id BIGSERIAL`, `batch_id` (FK, cascade), `row_status` (new / valid / rejected / applied / superseded), `reject_reason`, `received_at`, `applied_at`.

Column additions (separate migration file; `ALTER` trips the deploy runner's destructive filter): `sap_sync_config.apply_mode`; `material_plants.sap_missing_since`, `production_version.sap_missing_since`. What was last sent (D20) is **not** columns on `orders` (a write to an orders row bumps its xmin and would discard planners' unsaved edits): it lives in the side table **`order_sap_sent`** (`order_id` PK referencing `orders` ON DELETE CASCADE, `plant`, `sent_finish`, `sent_version`, `sent_firm`, `sent_at`; index on `plant`), created in the tables migration.

Seeds: `sap_sync_config` rows for the four inbound objects; `sap_field_map` rows per Appendix C. Material and planned-order material columns use a **new transform `alpha_strip`** (strip leading zeros when the value is all digits, else unchanged) so numeric materials match NIMBUS's stored form (D24).

### 3.2 Mulesoft contract (the staging tables ARE the interface)

Per object, per plant, one full snapshot, **a fresh UUID per attempt**:
1. Insert a `sap_stage_batch` header: own UUIDv4, `status='loading'`, `source='mulesoft'`.
2. Insert rows carrying that `batch_id`; never set `row_status`, `reject_reason` or resolved columns.
3. Update the header to `status='ready'`, `ready_at=now()`, `row_count_expected=N` where N = rows actually inserted.

Rules: header plant must equal every row's plant field (`plant_mismatch`); an empty snapshot (`row_count_expected=0`) is legal and means "nothing in horizon" (for planned orders it would delete every in-horizon order and will therefore always trip the 25 % hold); on a Mulesoft-side failure set `status='rejected'` + `error`, and **retry with a new batch_id**, never by re-using or appending to a batch; never modify rows after `ready`; a batch left in `loading` longer than `NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN` (default 120) is rejected as stale. Object dependency: Mulesoft should deliver Material Plant, then Routing, then Planned Orders; NIMBUS applies ready batches in that object order within one poll regardless.

Outbound: Mulesoft selects `row_status='ready'` rows (`FOR UPDATE SKIP LOCKED`), then sets `sent` + `sent_at` or `error` + `error_text` per row (SAP import log reasons land in `error_text`). Mulesoft never deletes; NIMBUS purges `sent` rows older than 30 days.

Restricted role `nimbus_mulesoft`: USAGE on schema; SELECT + INSERT on the five inbound tables and the header; column-level UPDATE on the header (`status`, `ready_at`, `row_count_expected`, `error`) and on the outbound table (`row_status`, `sent_at`, `error_text`); sequence usage; nothing else. Lives in `migrations/manual/` (environment-specific; password set out of band; SSL required; firewall rule for Mulesoft's egress IPs once known — the current pilot server is public with an allow-all-Azure rule and the app itself connects as the server admin, both already tracked in `docs/MIGRATION.md`).

### 3.3 Poll → validate → apply lifecycle (`backend/integration/sap_staging.py`, new)

- **Poll** (interval job on the existing lifespan scheduler, env `NIMBUS_SAP_STAGING_POLL_SECONDS`, 0 = off; the scheduler object is created when either the sync flag or this knob is on; body guarded by `pg_try_advisory_lock(hashtext('sap:staging-poll'))`, acquire-or-skip): expire stale `loading` → pick `ready` batches whose actual row count equals `row_count_expected` (mismatch persisting past the timeout → `rejected`) → for each (object, plant) keep the newest, mark older un-applied ones `superseded` → validate → if `apply_mode='auto'` and status `validated` → apply, in object order material plant → production versions → routing operations → planned orders. Also sweeps: archive rows > 30 days, `sent` outbound rows > 30 days, `rejected`/`discarded` batches > 7 days.
- **Validate** (set-based row update): `unknown_plant`, `plant_mismatch`, `missing_key`, `duplicate_key`, `invalid_date`, `invalid_time`, `invalid_number`, `invalid_int`. Resolved keys via `alpha_strip` (materials) and `strip_zeros` (planned order number); an all-zero planned order number is `missing_key` (would otherwise hit NOT NULL mid-upsert). Missing material-plant master data is **not** a rejection for orders (today's rule). Routing rows reuse the routing validators. Batch-level checks for planned orders: plant routing switch on and at least one routing present, else **held** `routing_required` (D23); vanish pre-count = in-horizon live orders (SAP start, fallback basic start, ≤ visibility end + 1 day) not in the batch → > 25 % → **held** `vanish_threshold`; unlimited horizon → no deletes + warning. The held view lists the exact orders that would be deleted.
- **Apply** (`validated`, or `held` + explicit confirm; 409 if a newer complete batch exists). **Not one transaction for planned orders**: the shared upsert commits every 500 rows by design, so the batch moves to `applying`, each step is idempotent, and on failure the batch becomes `error` with the step name; re-running Apply resumes safely. Deletions run **only after every upsert chunk succeeded**.
  - Field-map filter through the existing `map_records` layer (active rows only). Composite rules in code, documented: start = SAP date + time converted from `NIMBUS_SAP_SYSTEM_TZ` to the plant zone (D34; time `000000` or missing = date-only); finish likewise; `order_quantity = gsmng − abmng`; `planned_order_initial_quantity = gsmng`; `reduced_quantity = abmng`; blank version = material default; open quantity ≤ 0 → `planning_status='needs_planning'`, reason `zero_open_quantity` (D26), still upserted so SAP state is visible.
  - **Date hygiene** (today only inside the Excel ingest: missing finish → start; finish ≤ start or exactly midnight → start + run time; unparseable start → row dropped) is **extracted into a shared `db.apply_order_date_hygiene(rows)`** and run on the staging path before the upsert.
  - Material plants: create bare `materials` rows, then `md.bulk_apply("material_plants", …)` (int-cast lot sizes with `lot_size_rounded` warning; subnetwork first 3 chars). Absent rows: delete when no orders / BOM items / production versions / routing operations reference them, else stamp `sap_missing_since`; present rows clear it.
  - Planned orders: setup-state snapshot, then **the same `db.upsert_orders(rows, source="sap", plan_fn, apply_fn, resolve_fn)` call** Excel uses. Then vanish deletion via `purge_orders_by_ids` (shared purge core: segments cascade, shares retired, headers cleaned, `admin_audit`), whole families together, **archived first** (D29).
  - Production versions: `md.bulk_apply` + routing recompute; absent versions deleted when unreferenced, else flagged. Routing operations: existing scoped-replace writer + delete routings absent from the batch + recompute.
  - Retention: delete the previous `applied` batch for that object + plant; stamp rows `applied`; batch `applied`.
- **Echo suppression (D20)** inside `db.sap_changed_fields`: when the order has a remembered sent finish (`order_sap_sent.sent_finish`, read into the before-image as `sap_sent_finish`) and the incoming finish equals it (minute precision, after zone conversion) **and** the incoming version equals the remembered `sent_version` (or none was sent), dates and version are not a change; the new SAP baselines (including SAP's back-scheduled start) are still written. Work-center and quantity changes are judged as today. The remembered values are NOT cleared by a planner edit (refined after review); they are overwritten only by the next Send, and Send rewrites a side-table row only when its values change (never an `orders` row, so no xmin churn). A finish SAP returns as a date only (time 000000) also counts as an echo when its date equals the sent finish's date.
- **Upload into staging**: Excel/CSV with SAP headers → header + rows + `ready` → validate; never auto-applies.

### 3.4 Send to SAP (outbound)

`queue_send_to_sap(plant, actor)`: all plant orders with an effective end and not on hold, grouped by parent planned order (distribution children roll up; reuse the distribution aggregate read for the end roll-up plus one query for firm/version fields). Firm = 'X' if planner-firmed OR SAP already firmed OR effective start before the plant's frozen-horizon end (None = no frozen firming). End date/time converted from plant-local to `NIMBUS_SAP_SYSTEM_TZ` (D34). Still-`ready` rows for the plant from an earlier click are retired first. Upserts `order_sap_sent` for every sent order (D20; only when the values differ; no `orders` row is written). One `send_batch_id` per click, `admin_audit` row, status read returns ready / sent / error counts.

### 3.5 UI (Admin › Interface tab, `frontend/integration/sap-interface-ui.mts`)

Staging objects first in the rail ("Staging (Mulesoft)"), legacy stub connectors below. Detail pane tabs **Staging / Mapping / History**: plant combobox (searchable, never chips), batch list with status pill and counts, held reason with the **list of orders to be deleted**, buttons Validate / Apply / Confirm & Apply / Discard, rejected-rows drawer with CSV download, upload zone, manual/auto toggle, Refresh (on-demand poll). Planned-orders object adds an **Outbound** panel (ready / sent / error tiles, Send to SAP with confirm modal stating count and add-only firming, error-rows CSV) and an **Archive** panel (vanished orders of the last 30 days, Restore per order). All text through i18n keys in five locales.

## Appendix A — Context: brief, Q&A, findings, rejected alternatives

**Brief (owner, 2026-10-07).** Investigate the FSD; create staging tables for Material Plant, Routing, Planned Order Export and Planned Order Import with the listed SAP fields; SAP field as primary naming, NIMBUS term as secondary; be exhaustive and ask questions; purpose is to gate and map columns rather than let everything auto-fly in. Then: "Stress test any assumptions… this is our integration/interfacing first attempt. This needs to be robust and not jeopardize the application."

**Q&A record.** 18 design questions (→ D1–D19) and 16 stress-test questions (→ D20–D35), all answered; see §2.

**Findings from code verification (two passes).**
- Field map is 1:1 by `(object_key, sap_field)` → composite rules live in code.
- `upload_audit_log(source='sap')` filters on `filename = 'sap:sap'` exactly → staging must call `upsert_orders(..., source="sap")`.
- No delete-orders-by-id helper; `purge_orders_by_date` (db.py:1854) holds the correct side-effect chain and extracts cleanly.
- `_str_id` (db.py:94) does not strip zeros and the seeded `alpha` transform is the same function → SAP's padded materials would duplicate Excel-loaded orders (hence D24 / `alpha_strip`). `strip_zeros` on an all-zero value returns None → NOT NULL failure mid-upsert (hence the `missing_key` rejection).
- Excel date hygiene (db.py:3774-3820) is not in `upsert_orders`; `_t_dats` yields midnight → every SAP finish would be "exactly midnight" with no repair (hence the shared `apply_order_date_hygiene` extraction).
- `upsert_orders` commits per 500-row chunk (db.py:3345-3429) and opens its own connections; comment at L3565: "never fold ingest into one transaction" (hence the idempotent step ladder).
- Reset trigger (db.py:2445-2496): start OR finish change resets; existing `dates_echo` only covers exact start+finish match; reset clears slot, segments, `manual_firmed`; running orders are protected from reset (L3406-3413) but frozen-horizon orders are not.
- `scheduled_*` are naive plant-local wall-clock (db.py:433-438); SAP times are system-zone (D34) → conversion both ways.
- `material_plants.subnetwork` is VARCHAR(3) (schema.sql:748) and `bulk_apply` does not catch truncation errors (hence D25). `min_lot_size` / `incremental_lot_size` INTEGER; `orders.bom_usage` / `bom_alternative` INTEGER.
- `status_pl` is stored and displayed only, never filtered on.
- Planner concurrency: a server-side rewrite bumps xmin; the planner's save returns 200 with `stale` ids, the server version wins and a toast is shown (persistence.mts:1615-1618). `/tasks/refresh` + `Store.removeTask` exist; no polling, so deletions surface on save/reload (D35).
- App connects as `TempAdmin` (server admin) with `sslmode=require`; public endpoint with `AllowAzure` 0.0.0.0 rule; lifespan runs `ensure_*` DDL at boot (MIGRATION.md's "lifespan only reads" is wrong).
- No `pg_try_advisory_lock` anywhere yet; three `pg_advisory_xact_lock` uses exist.
- `visibility_horizon_days` NULL = unlimited; past-start orders are always in horizon; the `/tasks` filter applies only with a single `plant=`.
- Threadpool: anyio default 40 threads, shared with `/upload`; single replica, no uvicorn workers.

**Rejected alternatives.** Inbound HTTP endpoint for Mulesoft; a fifth staging table for the SAP plant control table; every field stored twice; delta feeds; flag-only for vanished orders (owner chose delete + archive); blocking Excel uploads on SAP plants; first-apply baseline-only special case; scoped replace for routing operations; sending Start Date/Time to SAP (not needed once echo is remembered); a per-plant quiet window for auto mode (owner: feed runs off-hours, ad-hoc must land at once); SAP stating the export window per batch (owner trusts equal horizons); a live refresh banner (deferred).

## Appendix B — Routing staging field list (D6)

Production versions (key: plant, material, version): plant, material_id, production_version, valid_from, valid_to, alternative_bom, bom_usage, task_list_type, routing_group, group_counter, procurement_type, special_procurement_type, costing_lot_size, sap_workcenter, production_version_text, repetitive_mfg, lot_size_from, lot_size_to.

Routing operations (key: plant, material, task list type, group, counter, sequence, operation): plant, material_id, task_list_type, routing_group, group_counter, sequence_no, activity, sap_workcenter, workcenter_category, base_quantity, control_key, operation_text, operation_unit, activity_type_machine, std_value_machine, std_value_unit_machine, activity_type_labor, std_value_labor, std_value_unit_labor, required_overlap, optional_overlap, required_split, field_key, num_splits, task_list_text, sequence_category, sequence_text, num_employees, setup_group_category, setup_group_key, deleted, header_status, header_valid_from, header_valid_to.

SAP field names for both tables: owed by SAP Development (follow-up rename migration).

## Appendix C — Field-map seeds (SAP column → live column)

**Material Plant** (`stage_material_plants` → `material_plants`): matnr → material_id (`alpha_strip`), werks → plant, mmsta → status_pl, minls → min_lot_size (decimal, int-cast), ltinc → incremental_lot_size (decimal, int-cast), zz_subnet → subnetwork (first 3 chars). Staging-only: webaz, verkz, stlal, stlan, plnnr, aplal, sauft. Requested addition (D30): material description.

**Planned Order export** (`stage_planned_orders` → `orders`): plnum → production_order (`strip_zeros`), matnr → material_number (`alpha_strip`), plwrk → plant, mdv01 → machine (work-center value; distribution resolves), psttr + pstti → basic_start_date (composite, zone-converted), pedtr + pedti → basic_finish_date and the SAP finish baseline (composite, zone-converted), gsmng − abmng → order_quantity (composite; ≤ 0 → needs_planning `zero_open_quantity`), gsmng → planned_order_initial_quantity, abmng → reduced_quantity, verid → production_version and SAP version baseline, auffx → firming_indicator, stlan → bom_usage (int), stalt → bom_alternative (int). Staging-only: prvbe, paart, umskz, kdauf, rsnum, knttp, vfmng, gsbtr, kzavc, badi, dac_creation_date.

**Planned Order import** (`orders` → `sap_stage_planned_order_out`): material_number → matnr, plant → plwrk, production_order → plnum, production_version → verid, effective end (zone-converted) → pedtr + pedti, firm rule D10 → auffx. Note for Mulesoft: SAP may require 18-character zero-padding of `matnr` and 10-character padding of `plnum`; NIMBUS sends its stored (unpadded) form.

## Appendix D — i18n keys (all five locales)

`ui.sap_staging`, `ui.sap_stage_batches`, `ui.sap_stage_apply`, `ui.sap_stage_confirm_apply`, `ui.sap_stage_validate`, `ui.sap_stage_discard`, `ui.sap_stage_refresh`, `ui.sap_stage_apply_mode`, `ui.sap_stage_mode_manual`, `ui.sap_stage_mode_auto`, `ui.sap_stage_rejected_rows`, `ui.sap_stage_download_csv`, `ui.sap_stage_upload`, `ui.sap_stage_held_banner`, `ui.sap_stage_held_routing`, `ui.sap_stage_vanish`, `ui.sap_stage_deletions`, `ui.sap_stage_status_{loading,ready,validated,held,applying,applied,error,rejected,superseded,discarded}`, `ui.sap_send_to_sap`, `ui.sap_send_confirm`, `ui.sap_send_status_{ready,sent,error}`, `ui.sap_archive`, `ui.sap_archive_restore`, `toast.sap_stage_applied`, `toast.sap_stage_apply_failed`, `toast.sap_sent_queued`, `toast.sap_archive_restored`, `ui.sap_map_primer_staging`, `alert.zero_open_quantity`.

## Appendix E — Things learned along the way / open items for durable docs

- **Environment:** the planning checkout was `feature/optimizer-f1-f4` with unrelated uncommitted changes; work forks from `main` and leaves them alone. The FSD at the repo root could not be opened in place (OneDrive lock); a scratchpad copy was used.
- **Doc staleness confirmed:** `docs/SAP_INTEGRATION_ROADMAP.md` says NIMBUS never writes back (superseded); `docs/NIMBUS_INTERFACE_ARCHITECTURE.md` describes the stub only; `aggregate_to_detail.md` L597 still calls the refresh/removeTask prerequisites missing (they exist); `docs/MIGRATION.md` L597 says the lifespan only reads (it runs DDL).
- **Skeleton discrepancies (not fixed here, record in MIGRATION.md):** sync watermark never advances; no `sap_sync_config` seed for `sap_workcenter`; Interface tab `MASTER_KEYS` lacks `sap_workcenter`, header says "6 objects"; `rows_failed` always 0; `_t_alpha` is misnamed (does no ALPHA conversion).
- **Owed by others before go-live:** SAP field names for the routing tables (SAP Development); FSD change request for Material Description on the Material Plant export (D30); SAP system time zone value for `NIMBUS_SAP_SYSTEM_TZ` (SAP Development); Mulesoft runtime location, egress IPs, SSL, per-row write-back capability and the role password (integration team / Basis); confirmation that SAP accepts unpadded material / order numbers or Mulesoft pads them.
- **Operational rules to publish:** SAP planning horizon and NIMBUS visibility horizon must be kept equal per plant (D22); a plant on SAP snapshots must not also receive Excel order uploads, since Excel-only orders vanish on the next apply (D12); routing runtime must be on with routings loaded before planned orders can apply (D23); the first SAP apply on a plant resets most scheduled slots (D19); converted or cancelled planned orders disappear at the next apply even if running (D21), recoverable from the archive for 30 days (D29); the pilot DB endpoint is public with an allow-all-Azure rule and the app runs as server admin — the Mulesoft role adds a second login to that surface; private networking remains the MIGRATION.md hardening item.
- **Unverified at design time:** DB-backed tests could not run (no local Postgres credentials; `.env` may point at Azure). The `@pytest.mark.pg` cases must run with local Postgres and `NIMBUS_TEST_DB=1` before ship.
- **Deferred:** live "data changed" banner for open planner sessions (D35); multi-replica safety beyond the poll's advisory lock; dry-run apply for planned orders (`upsert_orders` has no plan-only mode); 7-day retention of rejected/discarded batches is fixed in code.
