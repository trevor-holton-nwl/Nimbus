# Workstream A — Production Line → Machine Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the domain concept "Production Line" to "Machine" end-to-end — schema, backend, frontend, wire contracts, locales, and docs — with zero relationship breakage (every FK, generated column, index, unique constraint, registry entry, and wire contract intact and exercised).

**Architecture:** Straight identifier rename across four layers (Postgres DDL, Python backend, TS/JS frontend, i18n locales), done layer-by-layer so each layer can be typechecked/tested before the next depends on it: schema → backend Python → OpenAPI type regen → frontend → docs/locales → tests → validation → testing. No new architecture; this is a rename, not a redesign. Local Postgres only — the Azure pilot DB is untouched; a separate hand-applied migration file is authored (not run) for that cutover.

**Tech Stack:** PostgreSQL 18, Python/FastAPI (`brain.py`, `db.py`, `master_data.py`, `setup_data.py`, `sap_sync.py`), TypeScript compiled in place (`web/*.mts`), vanilla JS (`web/app.js`, `web/nimbus-intelligence.js`), i18n JSON locales (`en`, `de`, `es`, `fr`, `pt`).

**Spec:** `docs/multi_change_spec_08.20.26.md` — Workstream A (§A, lines ~140–264), plus Locked Decisions, Reconciliation #10, PT-log entries PT-12/PT-13, and Consolidated Open Decisions OD-A3–OD-A7.

## Global Constraints

- **Model policy:** implementation and mechanical work via Sonnet or Haiku only — never Opus, never Fable. Haiku only for pure mechanical/bulk find-replace passes with an explicit token list; Sonnet for anything requiring judgment (schema, wire contracts, DDL allowlists, translation, prose).
- **Data loss is acceptable; relationship breakage is not** (spec acceptance criterion). Local DB is dropped and rebuilt from scratch — never patched in place.
- **Never touch the Azure pilot DB in this workstream.** Author `migrations/2026-08-__-line-to-machine.sql` but do not run it. Do not run `promote-azure`.
- **Never blind-rename the English word "line."** Only rename the exact identifiers the spec enumerates: `production_line(s)`, `PRODUCTION_LINE`, `line_key`, `pl_group`, `default_workcenter`, and the `line` column specifically inside `priority_list` / `setup_matrix` / `setup_occurrence_override` / `line_setup_state` / setup-endpoint bodies. Do **not** touch `Timeline`, `TimelineNav`, `baseline`, `deadline`, `outline`, `inline`, `Store.selectedLines`, `ProdLines`, `known_plant_line_codes`, or any other identifier not named in the spec's rename map or wire-format table — these are out of scope for this workstream (see Assumption A below).
- **Excel upload headers keep accepting `PRODUCTION_LINE`** via a mapping shim (also accept `MACHINE`) — the SAP-side spreadsheet format is not ours to change.
- **`machine_key` is a generated column on 4 tables** (`machine`, `labor_plan_machine`, `machine_calendar`, `machine_blackout`) — Postgres will not rename a column a generation expression references. Each needs DROP + re-ADD, plus recreating its unique constraint. `orders.machine_key` is different: plain `TEXT`, backfilled, not generated.
- **Adopted open-decision defaults** (per spec's own recommendations, since none block starting except OD-A5 which is now resolved below):
  - OD-A3: rename **both** `production_lines.pl_group` and `labor_plan.pl_group` → `wc_group`.
  - OD-A4: `material_plants.default_machine` is a soft reference to `machine(plant, machine)` — validated in the UI, not FK-enforced.
  - OD-A5: `workcenter_mapping` PK is `(plant, machine)` — one SAP workcenter per machine per plant.
  - OD-A6: `wc_group` is a pure rename, not an FK to `workcenter_mapping.sap_workcenter`.
  - OD-A7: git worktrees are out of scope — no mass-rename inside them.

**Assumption A (flag if wrong):** The spec's own "~960 identifier occurrences" effort count is scoped to five literal tokens (`production_line` 118+109, `production_lines` 62+57, `line_key` 25, `pl_group` 14+57, `default_workcenter` 12+35, `PRODUCTION_LINE` 13+342) plus the wire-format table's listed surfaces. That is treated here as the authoritative scope boundary. Purely-internal frontend identifiers that mean "line" in the English sense but aren't in that enumeration (`Store.selectedLines`, `ProdLines`, `Timeline`) are **not** renamed in this workstream — renaming them would multiply blast radius for no wire/DB benefit and isn't what the acceptance criterion (FK/index/constraint/wire-contract integrity) is protecting.

---

## Prerequisite (blocks Task 2 only — user-owned, not delegated)

`.env` currently points `PG_HOST` at the live Azure pilot DB. The user has chosen to switch `.env` to local Postgres values themselves (a local `postgresql-x64-18` service is confirmed running). **Do not run `schema.sql` or drop/create the `nimbus` DB until the user confirms `.env` now points at `localhost`.** Tasks 1, 3–17 do not depend on this and can proceed; Task 2 must wait for explicit confirmation.

---

### Task 1: Rewrite `schema.sql` with Machine naming

**Model:** Sonnet (DDL correctness, generated-column semantics, index/constraint recreation — highest blast radius if wrong).

**Files:**
- Modify: `schema.sql` (all ~119 identifier occurrences plus the four generated-column blocks, five `orders` indexes, `column_metadata` seed rows, and the new table)

**Interfaces:**
- Produces: the canonical new names every later task renames Python/TS code to match — `machine`, `machine.machine`, `machine.machine_key`, `machine.wc_group`, `machine_calendar`, `machine_blackout`, `machine_setup_state`, `labor_plan_machine`, `labor_plan.wc_group`, `orders.machine`, `orders.machine_key`, `priority_list(plant, machine, field_key)`, `setup_matrix(plant, machine, signature_version, from_key, to_key)`, `setup_occurrence_override.machine`, `material_plants.default_machine`, new `workcenter_mapping(plant, machine, sap_workcenter)` PK `(plant, machine)`.

- [ ] **Step 1: Rename `production_lines` → `machine`, its columns, and its generated column**
  - `production_line` → `machine` column; `pl_group` → `wc_group`.
  - `line_key` is `GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || production_line) STORED` — drop it and re-add as `machine_key GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED`, referencing the new column name. Recreate `uq_lines_line_key` (rename to e.g. `uq_machine_machine_key`) against the new generated column.
  - Leave `bottleneck`, `excl_optimizer`, `buffer_*`, `setup_compatible`, `setup_compatibility_reason` untouched.

- [ ] **Step 2: Rename `line_calendar` → `machine_calendar`, `line_blackout` → `machine_blackout`, `labor_plan_line` → `labor_plan_machine`**
  - Each: `production_line` → `machine` (stays NULLable on `machine_blackout` — NULL still means "all machines in plant"); drop + re-add each table's generated `line_key` → `machine_key`; recreate each table's unique constraint under the new name.
  - `labor_plan.pl_group` → `labor_plan.wc_group` (separate column from `machine.wc_group` — both renamed per OD-A3).

- [ ] **Step 3: Rename `line_setup_state` → `machine_setup_state`**
  - Column `line` → `machine`. (`physical_mold_id` and other columns untouched.)

- [ ] **Step 4: Rename `orders` columns and rebuild its 5 dependent indexes**
  - `production_line` → `machine`; `line_key` → `machine_key` (plain `TEXT`, backfilled — not generated; keep the backfill logic/value format `{subnetwork}_{plant}_{machine}`).
  - Rebuild the 5 indexes that reference these columns (the two/three-way coalesce and line-key indexes) under the new column names — locate by searching for `production_line` and `line_key` inside `CREATE INDEX` statements in this file; keep index *names* stable where they don't literally embed "line" in a way that would be confusing, otherwise rename to match (e.g. `idx_orders_line_eff_start` → `idx_orders_machine_eff_start`).

- [ ] **Step 5: Rename `priority_list`, `setup_matrix`, `setup_occurrence_override` columns**
  - `priority_list`: `line` → `machine`; PK becomes `(plant, machine, field_key)` (`''` still means plant-wide).
  - `setup_matrix`: `line` → `machine`; PK becomes `(plant, machine, signature_version, from_key, to_key)`.
  - `setup_occurrence_override`: `line` → `machine`.
  - Note: the JSONB from/to state keys inside these rows are untouched by this task (that's Workstream D1's case-folding, not this rename).

- [ ] **Step 6: Rename `material_plants.default_workcenter` → `default_machine`**
  - Plain column, soft reference per OD-A4 — no FK constraint added.

- [ ] **Step 7: Add new `workcenter_mapping` table**
  ```sql
  CREATE TABLE IF NOT EXISTS workcenter_mapping (
      plant           TEXT NOT NULL,
      machine         TEXT NOT NULL,
      sap_workcenter  TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (plant, machine)
  );
  ```
  Place it near the `machine` table definition, following this file's existing conventions for `updated_at` triggers if other per-plant tables have one (match the pattern used by `production_lines` today, e.g. `setup_compatible`'s neighbors).

- [ ] **Step 8: Update every `column_metadata` seed row that names a renamed table or column**
  - Locate all `INSERT INTO column_metadata ...` (or equivalent seed) rows whose `table_name`/`column_name` reference `production_lines`, `line_calendar`, `line_blackout`, `line_setup_state`, `labor_plan_line`, `production_line`, `line_key`, `pl_group`, `default_workcenter`. Update `table_name`/`column_name` to the new names. This is the PT-12 hazard — miss one and `master_data._column_meta`'s INNER JOIN silently returns zero columns for that table.
  - Add a `column_metadata` row set for the new `workcenter_mapping` table (plant, machine, sap_workcenter) so it's visible in the Add-Column/label-rename admin surface consistent with siblings.

- [ ] **Step 9: Grep-verify zero stragglers**
  Run: `grep -nE "production_line|line_key|pl_group|default_workcenter" schema.sql`
  Expected: no matches outside of comments/history notes that are explicitly about the *pre-rename* state (e.g. a migration-note comment explaining what used to exist — those may stay, but must read unambiguously as historical, e.g. "formerly `production_line`").

- [ ] **Step 10: Self-review against Task 1's Interfaces list**
  Confirm every name in the Interfaces block above actually exists in the file with that exact spelling before moving to Task 2.

---

### Task 2: Rebuild the local `nimbus` database

**Model:** none — orchestrator (Sonnet, this session) runs this directly; not delegated. **Blocked on the Prerequisite above.**

**Files:** none (operational step)

- [ ] **Step 1: Confirm with the user that `.env`'s `PG_HOST`/`PG_DB`/`PG_USER`/`PG_PASS` now point at the local `postgresql-x64-18` service**, not Azure.
- [ ] **Step 2: Drop and recreate the local `nimbus` database**
  ```
  & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "DROP DATABASE IF EXISTS nimbus;"
  & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE nimbus;"
  ```
- [ ] **Step 3: Apply the rewritten schema**
  ```
  & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d nimbus -f schema.sql
  ```
- [ ] **Step 4: Verify the new tables exist with expected columns**
  ```
  & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d nimbus -c "\d machine" -c "\d workcenter_mapping" -c "\d orders"
  ```
  Expected: `machine.machine`, `machine.machine_key` (generated), `machine.wc_group`; `orders.machine`, `orders.machine_key`; `workcenter_mapping` with PK `(plant, machine)`.

---

### Task 3: Rename Python identifiers in `db.py`

**Model:** Sonnet (owns `make_id`, upsert, `query_orders`, the `TaskDTO` alias, the Excel-header shim, `clean()` — all wire-contract-adjacent).

**Files:**
- Modify: `db.py`

**Interfaces:**
- Consumes: Task 1's new schema column/table names.
- Produces: `db.py` functions read/write `machine`/`machine_key`/`wc_group`/`default_machine` throughout; `TaskDTO`'s Python-side field aliased for the wire as `MACHINE` (final JSON emission renamed in `brain.py`, Task 5 — `db.py` supplies the underlying value).

- [ ] **Step 1: Rename all SQL column/table references** — every `production_line`, `production_lines`, `line_key`, `pl_group`, `default_workcenter` token in SQL strings and Python identifiers becomes `machine`, `machine`, `machine_key`, `wc_group`, `default_machine` respectively, matching Task 1's schema exactly.
- [ ] **Step 2: Keep the Excel ingest shim backward-compatible** — `db.py`'s upload-header normalization (near the existing `ORDER`→`PRODUCTION_ORDER` / `WERKS`→`PLANT` shim) must continue accepting an incoming `PRODUCTION_LINE` column header and map it to the new internal `machine` field, and additionally accept `MACHINE` as a header. Do not change what the *Excel format* accepts — only what it's mapped to internally.
- [ ] **Step 3: `make_id` and the upsert conflict target are unaffected** — confirm `make_id()` still hashes `f"{PRODUCTION_ORDER}|{MATERIAL_NUMBER}"` (no line/machine component) and `ON CONFLICT (id)` is untouched. This is a negative check, not a change — record it as verified.
- [ ] **Step 4: Grep-verify**
  Run: `grep -nE "production_line|line_key|pl_group|default_workcenter" db.py`
  Expected: no matches except inside a comment explicitly describing the Excel header shim's accepted *input* spelling (`PRODUCTION_LINE` as an incoming column name is legitimate to keep verbatim in that one shim).

---

### Task 4: Rename Python identifiers in `master_data.py`

**Model:** Sonnet (highest-risk file per PT-6/PT-12 — `ALLOWED_TABLES`, the `column_metadata` INNER JOIN, `export_schema_sql`, DDL allowlists, and the duplicated generated-column expression).

**Files:**
- Modify: `master_data.py`

**Interfaces:**
- Consumes: Task 1's schema, Task 3's `db.py` conventions.
- Produces: `ALLOWED_TABLES` containing `machine` (renamed from `production_lines`) plus `workcenter_mapping` added as a new entry; `_column_meta`/`export_schema_sql`/`bulk_apply` all resolve the new table name correctly.

- [ ] **Step 1: Rename `ALLOWED_TABLES` entry** `production_lines` → `machine`. Confirm the frozenset still has exactly the original 8 entries renamed in place (not accidentally dropped), and **add `workcenter_mapping` as a 9th entry** so the new table is reachable through the existing generic CRUD grid — `PLANT_SCOPED_TABLES` should include it too (`workcenter_mapping.plant` is a real plant-scoping column).
- [ ] **Step 2: Rename every `production_line`/`pl_group`/`default_workcenter`/`line_key` reference** in bulk-CRUD, cascade-preview, DDL wizard, constraint config, and Labor Planning code paths.
- [ ] **Step 3: Fix the duplicated generated-column expression** at the line matching `master_data.py:1692` (subnetwork || '_' || plant || '_' || production_line) — update to reference `machine` and rename the local Python constant/string if it's named after `line_key`.
- [ ] **Step 4: Update `master_data.ensure_*` hooks** (`brain.py:188-212` calls these — confirm the hook *definitions* live in `master_data.py`) that provision `labor_plan`, `labor_plan_line`→`labor_plan_machine`, `line_calendar`→`machine_calendar`, `line_blackout`→`machine_blackout`, `plant_blackout`, the `plants` extension columns, `material_plants` attributes, and the three `line_key`→`machine_key` generated columns. **This is the dual-provisioning hazard (PT/Reconciliation #4 in §A)** — every table/column this touches must match Task 1's schema exactly, or a future redeploy silently regresses the rename.
- [ ] **Step 5: Grep-verify**
  Run: `grep -nE "production_line|line_key|pl_group|default_workcenter" master_data.py`
  Expected: zero matches.
- [ ] **Step 6: Confirm `export_schema_sql()` iterates the renamed `ALLOWED_TABLES`** and now includes `workcenter_mapping` in its dump — this is the schema-drift recovery path (PT-12); a silent `continue` on a missing table must not apply to any renamed or new table here.

---

### Task 5: Rename Python identifiers + wire contracts in `brain.py`

**Model:** Sonnet (endpoint bodies, URL segments, and the `TaskDTO` field are the actual wire contract the frontend depends on — get this wrong and every frontend task breaks).

**Files:**
- Modify: `brain.py`

**Interfaces:**
- Consumes: Task 3/4's renamed `db.py`/`master_data.py` functions.
- Produces the wire contract Task 9 (frontend) codes against:
  - `TaskDTO.MACHINE` (renamed from `PRODUCTION_LINE`) — field name, `brain.py` emit site, groupby site.
  - Body key `machine` (renamed from `production_line`).
  - Body key `wc_group` (renamed from `pl_group`).
  - URL segment `/master-data/machine` (renamed from `/master-data/production_lines`).
  - Blackout response key `machine` (renamed from the existing `line` alias-of-`production_line`).
  - `/setup/{plant}/...` request/response bodies use `machine` (renamed from `line`).

- [ ] **Step 1: Rename `TaskDTO`'s field** `PRODUCTION_LINE` → `MACHINE` (the Pydantic field declaration, the emit site, and the groupby site — search for all three; they are not adjacent lines).
- [ ] **Step 2: Rename body keys** `production_line` → `machine`, `pl_group` → `wc_group` at every request-parsing and response-construction site.
- [ ] **Step 3: Rename the URL segment** `/master-data/production_lines` → `/master-data/machine` at every route decorator that declares it.
- [ ] **Step 4: Rename the blackout response key** from `line` (currently aliasing `production_line`) → `machine`.
- [ ] **Step 5: Rename `/setup/{plant}/...` bodies** — every site using `line` as a request/response key for the setup endpoints → `machine`.
- [ ] **Step 6: Fix the misleading local variable — do not blind-rename it**
  There is a local variable literally named `line_key` that is **not** the DB `line_key` — it's a priority-list scope key holding a `PRODUCTION_LINE`-shaped value. Rename this local variable to something unambiguous like `priority_scope_key` (its *value* now comes from the machine field, but its identity was never the generated-column `line_key`, so it must not be renamed to `machine_key`, which would misleadingly imply it *is* the generated column).
- [ ] **Step 7: Grep-verify**
  Run: `grep -nE "PRODUCTION_LINE|production_line|pl_group" brain.py`
  Expected: zero matches except inside a comment describing the Excel/SAP-side header the upload shim still accepts, and any string literal that is itself an Excel column-header constant (handled in Task 3, referenced not redefined here).

---

### Task 6: Rename Python identifiers in `setup_data.py`

**Model:** Sonnet (writes are gated by the `setup_scheduler` permission and this module is the sole write path for setup tables — get the column names wrong and every write 500s).

**Files:**
- Modify: `setup_data.py`

- [ ] **Step 1: Rename every `line` column reference** across `setup_definition`, `setup_matrix`, `line_setup_state`→`machine_setup_state` (table name too, in any raw SQL), `setup_occurrence_override` to `machine`, matching Task 1's schema.
- [ ] **Step 2: Do not touch `_normalise_value` or `canonical_state_key`'s case-folding behavior** — that's Workstream D1, out of scope here. Only column/table *names* change in this task, not value normalization.
- [ ] **Step 3: Grep-verify**
  Run: `grep -nE "\bline\b" setup_data.py | grep -v "line_setup_state\|_required_text\|# "` and manually confirm every remaining hit is a column/param that should have become `machine` — this file uses `line` densely, so eyeball each hit rather than trusting a clean grep pass.

---

### Task 7: Update `sap_sync.py` renamed-value references

**Model:** Sonnet (this module stores table/column *names as data* — the trap PT flagged as "a data migration, not just DDL").

**Files:**
- Modify: `sap_sync.py`

- [ ] **Step 1: Update any code-level default/seed values** for `sap_sync_config.object_key` == `"production_lines"` and `sap_field_map.nimbus_column` values naming `production_line`/`pl_group`/`default_workcenter` to their new names, wherever these appear as Python string literals (defaults, docstrings, stub connector logic) rather than live DB rows.
- [ ] **Step 2: Confirm no data migration is needed for local dev** — since Task 2 rebuilds the local DB from empty, any *existing rows* in `sap_sync_config`/`sap_sync_run`/`sap_field_map` are gone. Record explicitly in this task's completion note that the Azure migration file (Task 13) must separately handle updating any live `sap_field_map.nimbus_column` row values that name the old columns, or those rows will silently point at columns that no longer exist after the Azure cutover rename.
- [ ] **Step 3: Grep-verify**
  Run: `grep -nE "production_line|pl_group|default_workcenter" sap_sync.py`
  Expected: zero matches, or matches only inside a comment explaining historical SAP-side naming.

---

### Task 8: Regenerate OpenAPI-derived TS types

**Model:** Sonnet (needs the backend importable/bootable to run correctly; diagnose failures if the schema/backend rename left a mismatch).

**Files:**
- Regenerate: `web/types/api-generated.d.mts`

**Interfaces:**
- Consumes: Task 5's `TaskDTO.MACHINE` field and any other `response_model=`-backed contract changes.
- Produces: the TS ambient types Task 9's frontend work imports.

- [ ] **Step 1:** Boot the backend locally against the rebuilt DB (`uvicorn brain:api --port 8000`), confirm no import-time or startup errors.
- [ ] **Step 2:** Run `npm run generate:api-types`.
- [ ] **Step 3:** Diff `web/types/api-generated.d.mts` — confirm `MACHINE` appears where `PRODUCTION_LINE` did, and no other field regressed.
- [ ] **Step 4:** Stop the server.

---

### Task 9: Rename frontend identifiers across `web/`

**Model:** Two-pass. **Haiku** for the mechanical bulk pass (Step 1); **Sonnet** for the correctness review (Steps 2–4).

**Files:**
- Modify: every file under `web/` matching the grep in Step 1 — expect hits concentrated in `web/schedule-data.mts`, `web/schedule-services.mts`, `web/schedule-workbench.mts`, `web/schedule-state.mts`, `web/plant-and-administration.mts`, `web/master-data-grids.mts`, `web/setup-domain.mts`, `web/setup-scheduler.mts`, `web/application-foundation.mts`, `web/types.mts`, `web/index.html`, `web/app.js`, `web/nimbus-intelligence.js`.

**Interfaces:**
- Consumes: Task 5's wire contract (`MACHINE`, `machine`, `wc_group`, `/master-data/machine`, setup-body `machine`), Task 8's regenerated types.

- [ ] **Step 1 (Haiku): mechanical token rename, restricted to an exact allowlist**
  Rename **only** these exact tokens, case-sensitive, wherever they appear as identifiers, string literals, or object keys — do **not** touch any other occurrence of the substring "line":
  - `PRODUCTION_LINE` → `MACHINE`
  - `production_line` → `machine` (as a wire/body key or DB-shaped field name — not as part of an unrelated compound word)
  - `production_lines` → `machine` (URL segment `/master-data/production_lines` → `/master-data/machine`; any variable holding that table name)
  - `pl_group` → `wc_group`
  - `default_workcenter` → `default_machine`
  - The `line` field specifically where it's read from or written to a setup/priority-list API payload (`GET/PUT /setup/{plant}/...` request/response bodies, `priority_list`/`setup_matrix`/`setup_occurrence_override` row shapes) → `machine`
  Run `grep -nE "PRODUCTION_LINE|production_lines?\b|pl_group|default_workcenter" web/*.mts web/*.mjs web/*.js web/index.html` first to get the exact hit list, apply the rename, then re-run the same grep and confirm zero remaining matches (excluding comments that explicitly describe the pre-rename Excel header shim).

- [ ] **Step 2 (Sonnet): confirm no collateral damage**
  Diff the Haiku pass against a blind-rename risk list: `Timeline`, `TimelineNav`, `baseline`, `deadline`, `outline`, `inline`, `Store.selectedLines`, `ProdLines`, `known_plant_line_codes`, `GanttFilter`, `DependencyOverlay` must all be **byte-identical** to before the pass. Run `git diff --stat web/` and spot-check any file touching those symbols.

- [ ] **Step 3 (Sonnet): fix the setup-body `line`→`machine` sites precisely**
  The Haiku pass in Step 1 is instructed to only touch `line` inside setup/priority-list API payload shapes — verify it did so correctly in `web/setup-domain.mts`, `web/setup-scheduler.mts`, and `web/plant-and-administration.mts` (Setup Matrix admin UI), since these files use `line` for both the wire field *and* unrelated local variables (e.g. loop variables, UI labels) in the same file. Fix any place the mechanical pass missed a wire site or wrongly touched a local variable.

- [ ] **Step 4 (Sonnet): typecheck**
  Run: `npm run typecheck`
  Expected: PASS. Any type error names the exact file/line where a rename was missed or a type import (`web/types.mts`, `web/types/api-generated.d.mts`) wasn't updated to match.

---

### Task 10: Update locale files (5 languages)

**Model:** Sonnet (translation correctness matters; not mechanical).

**Files:**
- Modify: `locales/en.*`, `locales/de.*`, `locales/es.*`, `locales/fr.*`, `locales/pt.*` (exact filenames/format per what's already in the `locales/` directory)

- [ ] **Step 1:** Grep all 5 locale files for any key or **value** containing "Production Line" (English) or the DB-shaped tokens (`production_line`, `pl_group`).
- [ ] **Step 2:** For every user-facing string whose value is "Production Line" (or a label built from it, e.g. "Production Line Group"), change the **value** to "Machine" (en), "Maschine" (de), "Máquina" (es), "Machine" (fr — same word), "Máquina" (pt). Leave i18n **keys** alone unless a key name itself is a wire-adjacent token from the allowlist in Task 9 (unlikely — i18n keys are typically semantic, e.g. `label.production_line`, which should still be renamed to `label.machine` for consistency across all 5 files).
- [ ] **Step 3:** Run `node --test tests/modules/locale-completeness.test.mjs` — this test pins locale coverage; it must still pass with identical key sets across all 5 languages after the rename.

---

### Task 11: Update `docs/nimbus-data-model.html` (ERD) and finish `CLAUDE.md`

**Model:** Sonnet (prose + diagram authoring, not mechanical).

**Files:**
- Modify: `docs/nimbus-data-model.html` (hand-authored Mermaid ER diagrams + prose, 13 diagram sections, ~1512 lines)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update every Mermaid ER diagram section** in `docs/nimbus-data-model.html` that names a renamed table/column (`production_lines`→`machine`, `line_calendar`→`machine_calendar`, `line_blackout`→`machine_blackout`, `line_setup_state`→`machine_setup_state`, `labor_plan_line`→`labor_plan_machine`, `line_key`→`machine_key`, `pl_group`→`wc_group`, `default_workcenter`→`default_machine`) and add a new diagram section (or extend the closest existing one) for `workcenter_mapping`.
- [ ] **Step 2: Update the prose paragraphs** that reference the old names by line-anchored `<code>` tags (e.g. the paragraph currently reading `production_lines.line_key` is a generated column..., and the one about `line_blackout.production_line` being nullable) to describe the new names and confirm the semantics (nullable-means-plant-wide) still read correctly.
- [ ] **Step 3: `CLAUDE.md` — remove the stale `DataIntegrity` module reference** from the Infrastructure layer table row (`ErrorLog`, `DataIntegrity`, `Toast`, `Modal`, `UndoStack` → drop `DataIntegrity`; no such module exists anywhere in `web/`, confirmed by the spec's Reconciliation #10).
- [ ] **Step 4: `CLAUDE.md` — update every "Production Line"/`production_line`/`line`-shaped reference** to Machine vocabulary: the rename map's table names in "Data Sources", the endpoint list (`/master-data/production_lines` → `/master-data/machine`, setup endpoint bodies), `TaskDTO.PRODUCTION_LINE` → `TaskDTO.MACHINE`, and `Config.KNOWN_PLANTS`/`known_plant_line_codes()` description (rename the *described* concept to machine without renaming the actual function symbol per Assumption A — describe it accurately as "known plant/machine codes" without claiming the symbol itself was renamed, or note explicitly if Task 9 did rename that specific symbol).
- [ ] **Step 5:** Read the full diff of both files once more against `docs/multi_change_spec_08.20.26.md` §A and Reconciliation #10 to confirm nothing was missed.

---

### Task 12: Author the Azure cutover migration file (not run)

**Model:** Sonnet (DDL correctness against a live prod DB later — highest-stakes single file in this workstream despite never being executed now).

**Files:**
- Create: `migrations/2026-08-__-line-to-machine.sql` (use today's actual date in the filename)

- [ ] **Step 1:** Write a plain, **non-idempotent** SQL script containing `ALTER TABLE ... RENAME TO ...` and `ALTER TABLE ... RENAME COLUMN ... TO ...` statements mirroring every rename in Task 1, in dependency order (rename tables before renaming columns that depend on them if Postgres requires it; drop+re-add the 4 generated `machine_key` columns exactly as Task 1 did, since `ALTER ... RENAME COLUMN` cannot retarget a generation expression either).
- [ ] **Step 2:** Add the `workcenter_mapping` table creation (`CREATE TABLE IF NOT EXISTS ...`, matching Task 1 Step 7 verbatim).
- [ ] **Step 3:** Add `UPDATE column_metadata SET table_name = ..., column_name = ...` statements for every seed row Task 1 Step 8 touched, so Azure's `column_metadata` table (which is live data, not something `schema.sql` reseeds against an existing DB) stays in sync.
- [ ] **Step 4:** Add `UPDATE sap_field_map SET nimbus_column = ...` / `UPDATE sap_sync_config SET object_key = ...` statements per Task 7 Step 2's finding, so any live SAP-sync config rows on Azure aren't left pointing at columns that no longer exist.
- [ ] **Step 5:** Add a header comment stating this file is hand-applied exactly once at cutover, is deliberately **not** idempotent, and is **not** part of the guarded `migrations/` ledger flow — do not add a `schema_migrations` ledger entry for it (that ledger is for the additive, idempotent migrations `promote-azure` applies automatically; this one is a manual one-shot per the spec's Locked Decisions).
- [ ] **Step 6:** Do **not** run this file. Do **not** invoke the `promote-azure` skill in this workstream.

---

### Task 13: Update test suites for the new names

**Model:** Two-pass. **Haiku** for mechanical rename in test fixtures/assertions (Step 1); **Sonnet** for semantic review (Step 2).

**Files:**
- Modify: `tests/*.py` (Python suite), `tests/js/*.js`, `tests/modules/*.mjs` — every file whose grep hit matches Task 9's Step 1 allowlist.

- [ ] **Step 1 (Haiku):** Apply the exact same token allowlist from Task 9 Step 1 to every file under `tests/`. Run the same before/after grep verification.
- [ ] **Step 2 (Sonnet):** Read every changed test file's surrounding assertions (not just the renamed line) to confirm the test still asserts something meaningful — a mechanically-renamed fixture can still be semantically wrong if, e.g., a test fixture built a `production_lines` row shape that's now missing a required `workcenter_mapping` counterpart the new schema expects.

---

### Task 14: Validation pass

**Model:** Sonnet.

- [ ] **Step 1:** `npm run typecheck` — PASS required.
- [ ] **Step 2:** `npm run lint` — PASS required.
- [ ] **Step 3:** `npm run check:static-assets` — PASS required.
- [ ] **Step 4:** `npm run check:legacy-surface` — PASS required (confirms the legacy `app.js` compatibility surface wasn't accidentally widened/narrowed by the rename).
- [ ] **Step 5:** Manually re-verify the PT-12 hazard: `grep -n "machine" master_data.py | grep -i allowed_tables` and confirm `export_schema_sql()`'s output (run it against the local rebuilt DB, or read the code path) includes `machine` and `workcenter_mapping`, with no silent `continue`.
- [ ] **Step 6:** Manually re-verify the dual-provisioning hazard: read `master_data.ensure_*` hooks side-by-side with `schema.sql`'s new table/column definitions and confirm every name matches exactly (this is the single highest-value manual check in this workstream — a mismatch here silently regresses on the next redeploy with no error).
- [ ] **Step 7:** Full repo grep for stragglers: `grep -rnE "production_line|PRODUCTION_LINE|pl_group|default_workcenter" --include="*.py" --include="*.mts" --include="*.mjs" --include="*.js" --include="*.sql" --include="*.html" .` (excluding `migrations/2026-08-__-line-to-machine.sql`, which legitimately still names both old and new). Every remaining hit must be justified (Excel-header shim comment, or historical prose) — if not, it's a missed rename.

---

### Task 15: Testing pass

**Model:** **Haiku** runs the suites (Step 1–2); **Sonnet** fixes any failures (Step 3).

- [ ] **Step 1 (Haiku):** Run `npm run test` (this triggers `pretest`'s build first, then `test:legacy` + `test:modules`). Report pass/fail per file, with full failure output for any failure.
- [ ] **Step 2 (Haiku):** Confirm `.env` now points at the local rebuilt DB (per the Prerequisite/Task 2), then run `NIMBUS_TEST_DB=1 python -m pytest tests/ -q`. Report pass/fail per file, with full failure output for any failure.
- [ ] **Step 3 (Sonnet):** For every reported failure, read the failing test and the code it exercises, determine whether the fix belongs in the test (a legitimately outdated assertion) or the implementation (a missed rename or a genuine logic bug introduced by this workstream), fix it, and re-run only the affected test file to confirm the fix before moving to the next failure.

---

### Task 16: Final self-review against the spec

**Model:** Sonnet.

- [ ] **Step 1:** Re-read `docs/multi_change_spec_08.20.26.md` §A "Deliverables" list and confirm each bullet has a corresponding completed task above.
- [ ] **Step 2:** Re-read the "Wire-format surfaces" table and confirm every row's "Decision" column is reflected in the current code (not just planned).
- [ ] **Step 3:** Report a summary to the user: what changed, what was explicitly deferred (nothing should be — this workstream has no parked items), which grep verifications came back clean, and the exact validation/test command output from Tasks 14–15.
- [ ] **Step 4:** Do **not** commit. Present the diff summary and ask the user whether to commit (and at what granularity) before this workstream is considered done.

---

## Completion Report (2026-08-20) — parked for review

**Status: implemented, validated, tested. Not committed. Not reviewed by a human yet.**

### What changed
52 modified files + 5 new: `schema.sql`, all 5 backend Python modules (`brain.py`, `db.py`,
`master_data.py`, `setup_data.py`, `sap_sync.py`), ~15 frontend `.mts`/`.mjs`/`.js` modules, all 5
locale files, `CLAUDE.md`, `docs/nimbus-data-model.html`, plus a new, never-run Azure cutover
migration (`migrations/2026-08-20-line-to-machine.sql`) and this plan file.

### Model discipline
Every implementation/validation/testing step ran on Sonnet or Haiku — Haiku only for two purely
mechanical token-substitution passes (exact allowlist, no free-form judgment), Sonnet for everything
requiring judgment (schema DDL, wire contracts, translation, docs, cross-file reconciliation). No
Opus, no Fable. The orchestrating session (Sonnet) did validation, DB operations, and gap-reconciliation
directly rather than delegating those.

### Validation (all clean)
`npm run typecheck`, `npm run build`, `npm run lint`, `npm run check:static-assets`,
`npm run check:legacy-surface`. Confirmed the two acceptance-critical hazards by hand: the
`column_metadata`/`ALLOWED_TABLES`/`export_schema_sql` chain includes `machine` and the new
`workcenter_mapping` with no silent `continue`, and the `master_data.ensure_*` startup-provisioning
hooks match `schema.sql`'s table/column/index definitions exactly (confirmed by actually booting
`uvicorn` once against the freshly-rebuilt local DB and watching every hook run without error).

### Testing
- JS suite: 389/393 pass. The 4 non-passing tests are pre-existing and unrelated: 2 hardcode dates
  now in the past relative to the sandbox clock (`2026-08-20`), tripping an "aged task" guard; 2 hit an
  already-`git diff`-confirmed unrelated `OptimizerPreview` quirk (`summarizeCandidate` design +
  `stateForOrder` formatting).
- Python suite: 284 passed / 1 skipped (documented pre-existing skip) / 4 errors. All 4 errors are the
  *same* pre-existing bug — a test fixture (`INSERT INTO subnetworks (code) VALUES (...)`, omitting the
  NOT NULL `name` column) in `tests/test_priority_lists.py::TestStampOrderAttributesAndTheInverseLedgerTrap`
  and `tests/test_schema_idempotent.py::TestHorizonMigrationIdempotent`. Confirmed via `git show HEAD`
  that both fixtures predate this session untouched. **Trivial one-line fix if wanted (add `name`
  to each INSERT), left alone because it's genuinely unrelated to the rename** — flagging rather than
  silently fixing or silently leaving unmentioned.

### Gaps found beyond the spec's literal wire-format-surfaces table (each closed — every one would have
silently broken something otherwise, since the spec's own enumerated list turned out non-exhaustive)
- Priority-list API's `line` field → `machine` (query params, form fields, response keys including
  `line_overrides`→`machine_overrides`) across `brain.py` and the frontend — necessary because the
  frontend rename (already planned) would otherwise have broken priority-list uploads/reads.
- `GET /tasks`'s `?line=` query parameter → `?machine=` (backend `brain.py` only — turned out to have
  zero live frontend callers today; the two `?line=` sites I initially suspected were actually
  `/priority-list/{plant}/{field_key}` callers, fixed under the priority-list item above).
- Plant-calendar blackout wire shape: top-level `line_blackouts`→`machine_blackouts`, item field
  `line`→`machine` on `GET /plant-calendar` and `POST /plant-calendar/line-blackouts` (URL path itself
  intentionally unchanged, matching the spec's narrow URL-rename scope). `NimbusBlock.line` was
  deliberately kept as the frontend-internal Store field name (translated only at the wire boundary)
  since it's used far beyond this one endpoint.
- Setup-compatibility (`GET`/`PUT /setup/{plant}/lines/{machine}/compatibility`) response key
  `line`→`machine` in `master_data.py` (two functions), with brain.py's now-redundant defensive remap
  removed once the root was fixed.
- An ambient `web/nimbus-compute-core.d.ts` type file (not mentioned anywhere in the spec) was silently
  blocking the entire TS build via `noEmitOnError` — found and fixed during the frontend pass.
- `default_workcenter`→`default_machine` docstring stragglers in 3 `brain.py` endpoints (leaked into
  the generated OpenAPI types) and one orphaned locale key (`col.default_workcenter`, whose frontend
  consumer had already moved to `col.default_machine`, i.e. it was rendering a missing-translation
  fallback until fixed) across all 5 locale files.
- `test_materials_was_not_added_to_plant_scoped_tables` updated to include `workcenter_mapping` in its
  expected `PLANT_SCOPED_TABLES` set — this was checking exactly the intentional Task 4 addition.
- `tests/test_schema_idempotent.py`'s cross-file check against the historical
  `migrations/2026-08-13-changeover-matrix-stage-0.sql` retired for 3 sub-tests (with a documented
  reason inline) — that dated migration is a frozen record of pre-rename Azure state and is
  intentionally never rewritten; the new one-shot cutover migration is what reconciles Azure, not this
  file staying in lockstep with `schema.sql`'s current naming.

### Deliberately not done
- Local DB is schema-correct but empty — no sample orders re-uploaded (ask if you want a test file
  uploaded).
- Azure untouched. The cutover migration file is authored, self-contained, and has never been run.
- The `subnetworks.name` pre-existing test bug (above) — flagged, not fixed, out of scope for this
  workstream.

### Not committed
Nothing in this workstream has been committed. Working tree has 52 modified + 5 new files.
