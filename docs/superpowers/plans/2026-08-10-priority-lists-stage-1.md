# Scheduling Priority — Stage 1 (Data Plumbing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `priority_list` table, materialize the four `material_plants` planner
attributes onto `orders` at ingest, migrate the existing per-plant color wheels into the new table,
replace the color-merge read path with a generalized one, add the missing-master-data exception
report and the resync endpoint, and retire the global color wheel — completing Stage 1 of
`docs/scheduling_priority.md`. **No UI for priority lists and no optimizer change.**

**Architecture:** Read `docs/scheduling_priority.md` first — its
[Decisions](../../scheduling_priority.md#decisions) table and
[three seams](../../scheduling_priority.md#architecture--the-three-seams) are the contract this
stage implements, and its [Review findings](../../scheduling_priority.md#review-findings) record
why several obvious-looking approaches were rejected. In short: values are stamped onto the order
row at ingest through one seam (`_stamp_order_attributes`); ranks are **never** stamped per order
(they resolve client-side from per-plant maps, which is Stage 3's work); `ORDER_Y` survives as a
color-compat alias only.

**Tech Stack:** Python 3.12 / FastAPI / psycopg 3 / pandas (all existing), Postgres. No new
dependencies. One `.mts` edit requiring `npm run build`.

## The Stage 1 invariant (read this before claiming success)

This stage is **not** invisible — it re-sources color from Material Plant, retires the global wheel,
and adds an exception report. What it does **not** change is the *mechanism*: still one ordinal list
per plant, still color as the only ranked field, still the same optimizer terms.

So the acceptance test is narrower and checkable: **diff one plant's `GET /tasks` task ordering
before and after, and every single difference must trace to a specific material where
`material_plants.color` disagrees with `orders.color`.** Nothing else may move.

⚠️ **Run pre-ship check #1 from `docs/scheduling_priority.md` BEFORE Task 1.** If
`material_plants.color` is sparse, "every difference" is "everything", and this stage blanks live
color sequencing on the pilot with nothing to stop it. Get per-plant population counts for
`color` / `prt_01` / `prt_02` first and report them.

## Global Constraints

- **`schema.sql` must stay pure idempotent DDL.** Every statement that mutates existing row data
  goes behind a `schema_migrations` ledger row (`schema.sql:20`, pattern at `:143`). This stage adds
  two such mutations — both must be guarded, or re-applying `schema.sql` re-runs them.
- **Beware the *inverse* ledger trap (R3).** A guarded backfill that runs before its source data
  exists records itself applied and never re-runs. The backfill here is **convenience only**; the
  real mechanism is `POST /master-data/resync-order-attributes`. Do not present the migration as
  sufficient.
- **Never write `RANKS` onto the task DTO (N2b).** Ranks are resolved client-side in Stage 3 from
  per-plant maps, precisely because a stamped rank goes stale when an order changes line — and it
  can, via vis-timeline `updateGroup: true` (`web/schedule-workbench.mts:250`) and the editable
  Orders-grid `PRODUCTION_LINE` column (`:1641`). Stamp `ORDER_Y` only.
- **`GET /tasks` has `response_model=TasksResponse`.** A field absent from `TaskDTO` is **silently
  stripped at runtime**. Adding columns to `_ORDERS_SELECT` without adding them to `TaskDTO`
  produces a response that looks right in `db.py` and is wrong on the wire.
- **`Config.SCHEMA_VERSION` MUST be bumped (R1).** `web/application-foundation.mts:137`, `4` → `5`.
  **Corrected rationale (2026-08-11):** R1 originally justified this by a Stage-3 "every priority
  list silently ignored" failure — stale reasoning once N2b (adopted later in the same review pass)
  moved rank resolution off the cached task DTO entirely onto separate per-plant maps that are
  re-fetched, never cached (see N2b). The bump is still required, for a Stage-1-local reason: the
  localStorage cache is discarded only on version mismatch (`schedule-data.mts:837`), and Stage 1
  changes what `orders.color` *means* (re-sourced from `material_plants`, not Excel) plus adds three
  new `TaskDTO` fields. Without the bump, a returning user's stale cached snapshot keeps showing the
  OLD color values and is missing the new fields until something else forces a refetch.
- **Do not touch `Engine._dispatchDayIntegrity`, `_sortTerms`, or `_comparator`.** All optimizer work
  is Stage 3. Verified: the dispatch already iterates `tieBreakTerms` generically and needs no
  change at all.
- **Do not touch `master_data.set_material_plant_attributes` (R2).** Adding an `orders` write there
  bumps `xmin`, which **is** the optimistic-concurrency `base_version` (`db.py:215`), so affected ids
  return `stale` and the frontend's last-writer-loses reconciliation **discards planners' unsaved
  drags**. This is why propagation is explicit-only.
- **Do not add `set_plant_constraints` `children` support here** — that is Stage 3, with the tree UI
  it serves.
- **pytest safety:** the suite refuses to collect unless `PG_HOST` is local **and**
  `NIMBUS_TEST_DB=1` (`tests/conftest.py`, `tests/support/db_safety.py`). If `.env` points at the
  Azure pilot the whole run fails by design — **do not "fix" that by repointing `.env` at Azure.**
- **Dynamic SQL** goes through `psycopg.sql.Identifier` / parameterized placeholders, matching
  `master_data.py`'s existing discipline. No f-string interpolation of anything caller-supplied.
- **`docs/scheduling_priority.md` is the durable record.** If something here turns out wrong, correct
  that document as part of the task rather than leaving it stale.

---

## Task 1: Migration + `schema.sql`

**Files:**
- Create: `migrations/2026-08-11-priority-lists.sql`
- Modify: `schema.sql` (append the same block at the drift section)

- [ ] Create `priority_list` with `PRIMARY KEY (plant, line, field_key)`, `line TEXT NOT NULL
      DEFAULT ''` (`''` = plant-wide). Columns: `entries JSONB NOT NULL`, `source_column TEXT NOT
      NULL`, `value_column TEXT`, `rank_column TEXT`, `filename TEXT`, `row_count INTEGER NOT NULL
      DEFAULT 0`, `uploaded_by TEXT`, `uploaded_at`/`updated_at TIMESTAMP NOT NULL DEFAULT NOW()`.
- [ ] `ALTER TABLE orders ADD COLUMN IF NOT EXISTS prt_01 / prt_02 / default_workcenter TEXT`.
      (`color` already exists.)
- [ ] Ledger-guarded step `priority_list_from_color_wheel`: copy `color_wheel` → `priority_list` as
      `(plant_label, '', 'colorWheel', entries, 'color', …)`. **Key on `plant_label`** — the raw
      plant name — not `plant_key`, which is a `_cw_safe_name()` slug. Leave `color_wheel` in place,
      unread.
- [ ] Ledger-guarded step `orders_mp_attrs_backfill`: backfill the four columns from
      `material_plants`. Header comment must state it is convenience only and name the resync
      endpoint as the mechanism (R3).
- [ ] Header comment must also warn that both steps bump `orders.xmin`, so they are deploy-time
      only, never mid-shift.
- [ ] Note in the header that the file contains `ALTER`, which trips `apply-migrations.ps1`'s blind
      destructive-verb match: confirm with `-DryRun`, then apply with `-AllowDestructive` — the same
      note the two existing `material_plants` migrations carry.
- [ ] Apply to local Postgres **twice**; confirm the second run is a no-op and both ledger rows exist.

## Task 2: `db.py` — read path, ingest stamp, exception report

**Files:** Modify `db.py`

- [ ] `_ORDERS_SELECT` (`:192`) — add `prt_01 AS "PRT_01"`, `prt_02 AS "PRT_02"`,
      `production_version AS "PRODUCTION_VERSION"` (**not** `default_workcenter` — see the
      correction note below). **No JOIN** — plain column reads, so `query_orders` keeps its
      `idx_orders_line_eff_start` plan.
- [ ] Extend `_UPSERT_SQL` (`:1192`) and `_UPSERT_ROW_COLS` (`:1242`) for the three new columns.
      Leave the `scheduled_start`/`scheduled_end` non-overwrite exactly as-is.
- [ ] **`_stamp_order_attributes(conn, *, batch_id=None, plant=None)`** — seam 2. One
      `UPDATE orders … FROM material_plants` keyed `(plant, material_number = material_id)`, scoped
      by `upload_batch_id` when called from ingest or by `plant` when called from resync. Must run
      **post**-upsert, because `orders.plant` is itself backfilled after the upsert and the stamp
      must see the derived value. Document in the docstring that this is the one place attribute
      provenance lives and that PRT_02 moving to production versions changes only this query.
- [ ] Return from that function the exception data: distinct `(plant, material_number)` pairs it
      could not resolve, the order count each affects, and a reason — `no_mp_row` vs
      `no_plant_derived` (N9: `orders.plant` derivation can fail on an ambiguous multi-plant line
      code, which is a different problem with a different fix).
- [ ] Wire the stamp into `upsert_orders` (`:1249`) after the existing plant backfill. **The upload
      always succeeds** — no threshold, no blocking, no override (N5/N6/N7). Persist the exception
      data alongside the batch in `upload_audit` and include a summary in the return dict.
- [ ] `ensure_priority_list_table()` — idempotent `CREATE TABLE IF NOT EXISTS`, mirroring
      `ensure_color_wheel_table()` (`:1616`), for lifespan self-heal.
- [ ] CRUD mirroring the `color_wheel` block (`:1608-1712`) one-for-one: `upsert_priority_list`,
      `get_priority_list`, `delete_priority_list`, `load_all_priority_lists`,
      `list_priority_lists_meta`.
- [ ] `priority_list_coverage(plant)` — **one aggregate query per plant** returning, per (line,
      field), the distinct-value count and how many are ranked (N3: 70 lines × 4 fields would be up
      to 280 separate lookups). Cache it (R12).

## Task 3: `master_data.py` — the rankable-field registry

**Files:** Modify `master_data.py`

- [ ] Add `RANKABLE_FIELDS` — `colorWheel`/`prt01`/`prt02`/`productionVersion` → `{source_column,
      task_field}`, all sourced from `material_plants`. **Correction (2026-08-11):** the fourth
      field is `production_version` (`material_plants.default_production_version` →
      `orders.production_version` → `TaskDTO.PRODUCTION_VERSION`), **not** `default_workcenter`.
      `default_workcenter` stays a plain admin-editable `material_plants` column and is
      deliberately excluded from this feature — it is not materialized onto `orders` and is not
      rankable. `production_version` doubles as the eventual PRT_02 join anchor (see
      docs/scheduling_priority.md's PRT_02 decision), and `PRODUCTION_VERSION` is already a dead
      entry in `web/order-field-catalog.mjs` (`db.py` never wrote it) — this fixes that drift
      rather than adding a new speculative field. Only **three** of the four source columns
      (`prt_01`, `prt_02`, `color`) are in `EDITABLE_MATERIAL_PLANT_ATTRS` (`:78`); this is a
      correction, not a new write-allowlist surface — `default_production_version` is a plain
      base `material_plants` column, already editable through the generic Material Plant grid.
- [ ] Make the registry the **single** source of truth for a field's source column (N19) — anything
      stored in `priority_list.source_column` is audit metadata, not configuration.
- [ ] Add a docstring stating the "add a field" recipe: one registry entry + one `orders` column +
      one line in the stamp + one `order-field-catalog.mjs` entry. No frontend change required.
- [ ] Extend `ensure_material_plant_attributes()` (`:912`) only if it does not already cover the
      three columns it is actually responsible for (`prt_01`/`prt_02`/`color`) — verify rather
      than assume. `production_version`'s column existence is guaranteed by the base
      `material_plants` table in `schema.sql` directly, not by this bootstrap function.

## Task 4: `brain.py` — generalized merge, retire the global wheel, endpoints

**Files:** Modify `brain.py`

- [ ] `apply_color_merge` (`:756`) → **`apply_priority_merge(df, plant)`**. Resolve ranks from the
      cache per configured (line, field) at that plant. **Stamp `ORDER_Y` only** — no generic
      `RANKS` field (N2b). Unlisted values → `999999`, sequenced last, never dropped.
- [ ] Leave the trailing row sort `["BASIC_START_DATE","PRODUCTION_LINE","ORDER_Y"]` (`:823`)
      **unchanged**, and add a comment that it is presentation and finish-to-start-link-building
      order only, never the optimizer's order (R6) — so nobody later "fixes" it by reading
      `plants.constraints` on the hot path for an ordering the optimizer overwrites anyway.
- [ ] `PLANT_CWS` → `PLANT_LISTS: {plant: {line: {field_key: {VALUE: RANK}}}}`, keyed by raw plant
      name (drop `_cw_safe_name()` from the lookup path; keep the function for the legacy file path).
      `_reload_one_plant_wheel` → `_reload_one_plant_lists`.
- [ ] **Retire `GLOBAL_CW` / `COLOR_FILE`**: the merge fallback (`:800`), the `/diagnostics`
      file-reachable probe (`:979-994`), the coverage panel's `GLOBAL_CW.keys()` source
      (`:1018-1038` — repoint at `priority_list`, sharing one function with Task 2's coverage per
      N18), and the `load_color_wheels(COLOR_FILE)` calls at `:183` and `:1065`.
      ⚠️ Run pre-ship check #2 first — confirm via `GET /diagnostics` that no plant leans on it.
- [ ] `POST /master-data/resync-order-attributes` — re-stamp a plant via seam 2. Response must state
      that it bumped row versions and how many orders were affected (R2).
- [ ] `GET /upload/{batch_id}/missing-master-data` (+ `?format=csv`) — the exception report, grouped
      by reason, listing materials and affected order counts so someone can go collect the master
      data.
- [ ] Keep `/color-wheel/{plant}` (GET/POST/DELETE) and `/color-wheels` working, now reading and
      writing `priority_list` rows with `field_key='colorWheel', line=''`. `ColorWheelViewer` and the
      Admin Cockpit coverage panel must keep working untouched.
- [ ] `TaskDTO` (`:862`) — add `PRT_01`, `PRT_02`, `PRODUCTION_VERSION`. **No `RANKS`.** Then
      regenerate `web/types/api-generated.d.mts` per `docs/typescript_migration.md` Phase 4.
- [ ] Call `db.ensure_priority_list_table()` from the lifespan hook alongside the existing
      `ensure_*` bootstraps.

## Task 5: Minimal frontend

**Files:** Modify `web/application-foundation.mts`, `web/order-field-catalog.mjs`, `web/types.mts`,
`web/index.html`, and the `Compute` snapshot builder

- [ ] **`web/application-foundation.mts:137` — `SCHEMA_VERSION: 4` → `5`** (R1). Non-negotiable.
- [ ] `web/order-field-catalog.mjs` — add `PRT_01`/`PRT_02` entries (`{key, dbColumn, type}`,
      following `COLOR` at `:34`) so the values are selectable as Orders-grid columns (R4).
      `PRODUCTION_VERSION` needs **no new entry** — it already exists at `:64` as one of the
      catalog's dead fields; this stage is what makes it live (`db.py` starts writing it). While
      there, note — do not fix — that the catalog still declares ~9 other fields `db.py` never
      writes.
- [ ] `web/types.mts` — add `PRT_01` / `PRT_02` / `PRODUCTION_VERSION` to `NimbusTask` (not already
      declared there, despite the catalog entry). **Do not add `RANKS`.**
- [ ] **First verify R10's premise**: check whether the `Compute` worker snapshot ships whole task
      objects. If it does, prune the three new fields from it — Alerts and Utilization never read
      them, and the structured clone is the documented dominant main-thread compute cost.
- [ ] `web/index.html` — bump `NIMBUS_BUILD_ID`.
- [ ] `npm run build`, then `npm run typecheck`.

## Task 6: Tests

**Files:** Create/modify under `tests/`

- [ ] Migration idempotency: apply twice, assert no-op and both ledger rows.
- [ ] The **R3 trap** explicitly: apply against an empty `material_plants`, assert orders are blank,
      then assert resync fixes them. This is the regression test for the inverse ledger trap.
- [ ] `_stamp_order_attributes`: values stamped from `material_plants`; batch scoping honored;
      resync-by-plant path; unmatched counts correct and split by reason (N9).
- [ ] Upload **never blocks** regardless of unmatched count, and the exception report content +
      CSV shape are correct.
- [ ] `priority_list` CRUD + `list_priority_lists_meta` + coverage aggregate.
- [ ] `/color-wheel/*` compatibility against migrated rows.
- [ ] `apply_priority_merge`: `ORDER_Y` stamped, unlisted → 999999, no `RANKS` key present.
- [ ] Confirm `GET /tasks` actually returns the three new fields (guards the `response_model`
      stripping trap).
- [ ] Run the full suite with `npm test` (which has the `pretest` → build hook) and pytest with
      `NIMBUS_TEST_DB=1` against **local** Postgres.

## Task 7: Docs

**Files:** Modify `CLAUDE.md`, `AGENTS.md`, `docs/MIGRATION.md`, `docs/scheduling_priority.md`

- [ ] `CLAUDE.md` **and** `AGENTS.md` (twins — update both or they drift, R18): the `priority_list`
      table and seam 2 in the Data Sources section; the retired `GLOBAL_CW`/`COLOR_FILE`; the new
      `orders` columns; and — independent of this feature — **the `xmin` hazard**: any `UPDATE orders`
      bumps the optimistic-concurrency `base_version`, so an incidental write silently discards
      planners' unsaved edits via last-writer-loses reconciliation.
- [ ] `docs/MIGRATION.md`: `PLANT_LISTS` is per-process and the staleness surface is now wider (R13);
      the three compat shims to retire (R17); PRT_02 multi-value rework; and the **inverse ledger
      trap** as a general pattern next to the existing ×1440 note.
- [ ] `docs/scheduling_priority.md`: mark Stage 1 complete in the stage table, and correct anything
      in its findings that turned out wrong.

## Not in this stage

Upload UI, column mapping, coverage cards, the generic list viewer, the resync *prompt* (the
endpoint and manual button are here; the post-upload prompt is Stage 2), the priority tree,
`set_plant_constraints` `children`, `flattenConstraints`, the term factory, and the N12 unranked
grouping — all Stage 2 and Stage 3.
