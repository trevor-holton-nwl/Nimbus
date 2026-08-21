# Workstream D+E — Setup Matrix Hygiene & Admin Table Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** D1–D4 make the setup (changeover) matrix trustworthy — one canonical case for state values, the "include setup times" toggle relocated off the per-signature-version `setup_definition` row, explicit matrix deletion, and honest derived-setup detail for zero-minute covered transitions. E adds a read-only, catalog-driven universal table browser + CSV export for every Postgres table, independent of the editable Master Data CRUD surface.

**Architecture:** D1–D4 are surgical fixes/relocations inside the existing setup subsystem (`setup_data.py`, `brain.py`, `web/setup-domain.mts`, `web/schedule-services.mts`, `web/plant-and-administration.mts`). E is a net-new, deliberately separate read-only surface (new endpoints, new admin sub-tab) that composes two existing-but-previously-uncombined patterns: per-request catalog discovery (`pg_stat_user_tables`) and `psycopg.sql.Identifier`-safe dynamic SQL.

**Tech Stack:** Same as Workstream A — PostgreSQL, FastAPI/Python backend, TS/JS frontend, AG Grid for E's table view (matching `MaterialGrids`' filter model).

**Spec:** `docs/multi_change_spec_08.20.26.md` — §D (D1–D4, lines ~503–630) and §E (lines ~633–679), plus Locked Decisions for Change #8/#9, PT-4/PT-5/PT-6, and Consolidated Open Decisions OD-D1a/OD-D3a/OD-D4a/OD-E1/OD-E2/OD-E3.

## Global Constraints

- **Model policy:** Sonnet or Haiku only — never Opus, never Fable. This workstream is judgment-heavy (case-folding correctness, cross-table writes, safe dynamic SQL) — expect mostly Sonnet, minimal mechanical Haiku work.
- **D1 identifiers stay case-sensitive.** Only attribute *values* (color/PRT/production-version state tokens) get uppercased — `plant`/`machine`/`actor` and all other identifiers are untouched.
- **D1 booleans are exempt from folding** — `_normalise_value` emits `"true"`/`"false"`; folding those to `"TRUE"`/`"FALSE"` breaks stored keys and the TS side's `String(true)`.
- **D2 adopted defaults:** real BOOLEAN, deliberately **unregistered** (not in `column_metadata`/`ALLOWED_TABLES`-editable-grid), written through a dedicated validated endpoint, surfaced as a checkbox — the `machine.setup_compatible` precedent. The "Setup-aware optimization active/inactive" status chip **stays in the Setup Matrix header**; only the checkbox relocates to plant-level settings.
- **D3 adopted default (OD-D3a):** a scope-level "delete all matrix rows" action is in scope, behind a typed confirmation (type the plant/scope name to confirm).
- **D4 adopted default (OD-D4a):** new locale key `ui.setup_source_no_change` in all 5 locales for a no-change (identical-signature, 0-minute) transition's source label.
- **E adopted defaults:** OD-E1 streaming CSV export, ~250k soft cap, offset-resume affordance (never a silent cut, `log()`/response header states the cap). OD-E2 admin-only and unscoped (cross-plant by design — a data-exposure decision, gated the same way other maintenance routes are, e.g. `NIMBUS_API_KEY`/admin role). OD-E3 truly read-only — no write path of any kind.
- **Never fetch a full plant setup-matrix snapshot for a UI that needs one from-state's rows** — this constraint (already in `CLAUDE.md`) still applies; D1's case-fold fixes must not regress `GET /setup/{plant}/matrix-rows`' from-state scoping.
- **E composes two patterns that don't share code today** — per-request (not process-cached) catalog discovery, and `psycopg.sql.Identifier`-based dynamic SQL. Do not copy `db._get_maint_table_allowlist` (process-global cache, bare f-string interpolation) as-is; do not copy `master_data.ALLOWED_TABLES` as-is (hardcoded frozenset) — E's allowlist must be catalog-derived per request.

---

## D1 — One canonical case (uppercase) for setup attribute values

**Files:** `setup_data.py`, `web/setup-domain.mts`, `brain.py`, a new `migrations/2026-08-20-setup-value-case-fold-backfill.sql` (backfill for Azure; local DB is fresh from workstream A so has no mixed-case rows to backfill, but the migration must still exist for the Azure cutover), `web/locales/*.js` if any new admin-audit-facing label is needed.

- [ ] **Step 1 — Python fold.** `setup_data._normalise_value` uppercases string values (after strip), **except** when the value is exactly `"true"`/`"false"` (case-insensitive) — those pass through lowercase, matching the TS side's `String(true)`/`String(false)`. Confirm `canonical_state_key` (the sole caller) routes every server-side write path through this: matrix import, `machine_setup_state` writes, override state keys.
- [ ] **Step 2 — Client fold.** `web/setup-domain.mts`'s state-key normalization (currently trim-only) gains the same uppercase-except-boolean fold. `statesEqual` must keep comparing with `===` (it's correct once both sides are canonicalized — don't switch to a case-insensitive comparator, fix the input instead). Converge the fourth convention: `web/setup-scheduler.mts`'s rank-lookup uppercase — confirm it now agrees with `setup-domain.mts`'s fold (same case-folding function if practical, or independently verified identical behavior).
- [ ] **Step 3 — Raw-JSON bypass.** `brain.py`'s `json.loads` of a query-string value handed to `setup_data.page_matrix_rows` must route the parsed value through `canonical_state_key` before comparing against stored JSONB — it currently compares byte-wise with no canonicalization.
- [ ] **Step 4 — Ingest parity.** `brain.py` already uppercases priority-list values and `COLOR` in the `/tasks` payload. Add the same uppercase fold for `PRT_01`, `PRT_02`, `PRODUCTION_VERSION` at ingest.
- [ ] **Step 5 — Backfill migration (authored, not run — same one-shot-at-cutover model as workstream A's rename migration).** Existing mixed-case rows in `setup_matrix`, `machine_setup_state`, `setup_occurrence_override` on Azure survive as unreachable duplicates once the fold ships (their JSONB state keys sit *inside* primary keys, so there's no automatic collapse). Write `migrations/2026-08-20-setup-value-case-fold-backfill.sql`: for each of the 3 tables, find PK-colliding rows that differ only by case-folding their JSONB key(s), keep the most-recently-`updated_at` row, delete the rest, and `INSERT INTO admin_audit` a summary row per table with a discard count (OD-D1a). Header comment matching the rename migration's conventions (hand-applied once, not idempotent, not ledger-tracked). Do not run it.
- [ ] **Step 6 — Verify the false-alert regression this was chasing is actually gone.** After steps 1–4, a hand-typed `Black` and an ingested `BLACK` must resolve to the same JSONB key end-to-end (write via one path, read via the other, assert equality) — add or confirm a test exercising this, not just unit-testing the fold function in isolation.

---

## D2 — Relocate the "include setup times" toggle + D3 — explicit matrix deletion

*(Combined into one task/agent — both touch `web/plant-and-administration.mts`'s Setup Matrix admin surface, so keep them in the same pass to avoid file conflicts.)*

**Files:** `schema.sql` (new column), `master_data.py`, `brain.py`, `web/plant-and-administration.mts`, `web/schedule-services.mts` (gate-check + `SetupSnapshot` shape), `web/schedule-state.mts` (`SetupSnapshot` type if the definition shape changes), `web/locales/*.js`.

### D2 — toggle relocation
- [ ] **Step 1.** Add a new **unregistered** `plants.setup_active BOOLEAN NOT NULL DEFAULT FALSE` column to `schema.sql` (do **not** add a `column_metadata` row for it — that's what "unregistered" means; it must never appear in the generic Master Data grid). Apply locally (`schema.sql` re-run is safe/idempotent per `CREATE ...IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` conventions already used elsewhere in the file — follow the existing pattern for adding a column to `plants`).
- [ ] **Step 2.** New dedicated validated endpoint, e.g. `PUT /plant/{plant}/setup-active` — body `{active: bool}`, real boolean validation (reject non-bool the way `production_lines`(`machine`)`.setup_compatible`'s endpoint does — confirm that precedent's exact validation approach in `master_data.py` and mirror it), writes `plants.setup_active`, audit-logged.
- [ ] **Step 3.** Keep `setup_definition.active`'s existing force-reset-to-FALSE-on-signature-bump behavior in `setup_data.save_definition` (don't remove it — it may still be meaningful for whatever `setup_definition.active` continues to represent), but the **eight backend sites** that currently gate optimizer behavior on `setup_definition.active` must be re-pointed to also (or instead — resolve by reading each site's actual purpose) consult `plants.setup_active`. Enumerate and fix each of the eight sites explicitly in the implementation; don't assume — the spec flags this as non-obvious.
- [ ] **Step 4.** `Store.setupSnapshot`'s cached payload (`brain.py` → `web/schedule-state.mts`) currently embeds `definition.active`. Decide (and document the decision in the code) whether `SetupSnapshot` gains a new top-level `plant_active` (or similar) field sourced from `plants.setup_active`, or whether `definition.active` is repointed to mean the plant-level flag — given `production_lines.setup_compatible`(now `machine.setup_compatible`) also gates independently and the snapshot-identity check (`setupSnapshot.plant === plant`) gates as hard as either flag, prefer **adding** a new field rather than overloading the existing one, so all three gates stay independently inspectable in the UI/diagnostics.
- [ ] **Step 5.** Update the gate check in `web/schedule-services.mts` (`setupSnapshot && setupSnapshot.plant === plant && setupSnapshot.definition?.active`) to read whichever field Step 4 decided on.
- [ ] **Step 6.** Relocate the checkbox in `web/plant-and-administration.mts` from the Setup Matrix header to the plant-level settings area (near `visibility_horizon_days`/`frozen_horizon_days` from workstream C if that's landed, or wherever plant-level Scheduling Rules live today) — gated on `permissions.definitionWrite` same as before. The status chip ("Setup-aware optimization active/inactive") **stays** in the Setup Matrix header, now driven by whichever field(s) actually gate (per Step 4), reusing `activationStatus`'s four-reason logic, extended if a new reason is needed for the relocated flag.

### D3 — explicit deletion
- [ ] **Step 7.** Wire the existing, currently-dead `deleteRequest` helper (`web/plant-and-administration.mts`) to real UI: a per-row delete button and multi-select bulk delete in the Setup Matrix admin grid, calling the already-shipped `DELETE /setup/{plant}/matrix` backend.
- [ ] **Step 8.** Add a scope-level "delete all rows" action (OD-D3a) behind a **typed confirmation** (user must type the plant code or a literal confirmation phrase — match whatever typed-confirmation pattern already exists elsewhere in the admin UI, e.g. a destructive plant/table action, for consistency; if none exists, a simple "type the plant code to confirm" input is sufficient).
- [ ] **Step 9.** New i18n keys for both actions in all 5 locale files (delete-row confirm, bulk-delete confirm, delete-all typed-confirmation prompt and its placeholder/hint text).
- [ ] **Step 10.** Verify every delete path lands in the admin audit map (`brain.py`'s `_ADMIN_WRITE_OPERATIONS`/`_ADMIN_TARGET_PARAMS`-equivalent, same mechanism workstream A's setup-endpoint renames already touched) — add an entry if the bulk/delete-all action doesn't already have one.

---

## D4 — Always populate derived setup detail for zero-minute covered transitions

**Files:** `web/schedule-services.mts` (`deriveSetupObservation`), `web/schedule-workbench.mts` (Inspector's setup detail card — no gate change needed, per spec), `web/locales/*.js`.

- [ ] **Step 1.** In `deriveSetupObservation`, a covered transition that resolves to 0 minutes (identical predecessor/successor signature) must still push an **observation** — predecessor id, predecessor state, successor state, required/effective/standard minutes (all 0), and a source — but explicitly **no interval** (so no bar is drawn and nothing consumes capacity). Today it pushes neither.
- [ ] **Step 2.** Confirm the Inspector's `hasObservedEntry` gate now finds this observation and populates all seven detail rows (six from the source doc + the seventh, `ui.setup_override`) instead of blanking to `—`. No change to the gate itself — the fix is entirely in step 1 producing an observation to find.
- [ ] **Step 3.** `ui.setup_override`'s seventh row: on a no-change transition, render an explicit "none" state, distinguishable from the unknown-value `—` placeholder used elsewhere.
- [ ] **Step 4.** New locale key `ui.setup_source_no_change` (OD-D4a) in all 5 locale files — the source label for a no-change transition, distinct from any matrix-source label (using a matrix-source label here would wrongly imply a matrix row was consulted for a same-signature transition).
- [ ] **Step 5.** Add/confirm a test pinning the distinction table from the spec: identical-signature+covered → 0 min, no bar, no alert, fully populated detail; different-signature+no-matrix-row → 0 min, yellow `!` bar (already renders per workstream B3b, not this workstream), alert, fully populated detail. Both are zero minutes; the test must assert they are not the same state.

---

## E — Admin UI: universal table browser & export

**Files:** new backend surface in `brain.py` (+ possibly a new small module if `brain.py` would otherwise balloon — your call at implementation time, but `brain.py` is already large and this is a clean seam, so a new `admin_tables.py` module is likely the better fit, mirroring how `setup_data.py`/`master_data.py` are already split out), a new frontend module (likely `web/admin-tables.mts` following the `.mts`-compiled-in-place convention, or a new section inside an existing admin module if that fits the codebase's actual module boundaries better — check `web/plant-and-administration.mts`'s `AdminCockpit` structure first), `web/index.html` (new `data-sub` tab), `web/locales/*.js`.

- [ ] **Step 1 — Per-request catalog discovery.** A function that queries `pg_stat_user_tables` (or `information_schema.tables`) **fresh on every request** (not process-cached like `db._get_maint_table_allowlist`) to get the current list of every table in the database, flagging system tables (`schema_migrations`, `admin_audit`, `column_metadata`, `sap_sync_*`) as internal via a naming-pattern or explicit small denylist-for-flagging (they're still shown, just marked).
- [ ] **Step 2 — Safe dynamic SQL.** For any table name returned by Step 1's catalog query, build `SELECT`/`COUNT`/paginated queries using `psycopg.sql.Identifier` for every table/column name (never an f-string) — this is the first place in the codebase these two patterns (catalog-per-request + `Identifier`-safety) are combined; don't assume a shortcut exists, build it explicitly.
- [ ] **Step 3 — Primary/foreign-key metadata.** For each table, resolve its PK columns and any FK columns (via `information_schema`/`pg_constraint`) so the frontend can present them as first-class filter inputs. Read the columns' PK/FK-ness fresh per request alongside Step 1's table list.
- [ ] **Step 4.** New endpoints:
  - `GET /admin/tables` — the catalog list (table name, row-count estimate, internal-flag, PK/FK column names).
  - `GET /admin/tables/{table}` — paginated rows (`limit`/`offset`, `meta.total` mirroring `GET /tasks`' contract) + column metadata, with **PK/FK filter params as first-class**: accept multi-value inputs (comma/newline/tab-split on the client before sending, or accept a repeated query param / JSON body — your call on transport, document it), where an unmatched value simply matches nothing (never a query error).
  - `GET /admin/tables/{table}/export.csv` — streaming CSV of all columns/rows for the current filter, honoring the OD-E1 ~250k soft cap with a truncation indicator (e.g. a trailing comment row or a response header) stating the resume offset.
  - All three: admin-only (OD-E2), gated the same way other maintenance/DDL routes are (check the existing pattern — likely `require_admin` plus whatever `NIMBUS_API_KEY` convention destructive routes use; read-only here, but still admin-gated per the explicit data-exposure decision), and **cross-plant/unscoped** by design (do not apply `_assert_plant_allowed` — this is the one deliberate exception, documented as such in a code comment).
- [ ] **Step 5 — Frontend.** New admin sub-tab (6th `data-sub` in `web/index.html`, branch in `AdminCockpit.render()`) using AG Grid (not an HTML table — "as close to an Excel grid view as possible"), reusing `MaterialGrids`' filter model (`FilterMode = 'checklist' | 'bigset'`) for the PK/FK multi-value paste-aware filter inputs, a clear-all control, and a CSV export button/link. Server-side pagination wired to Step 4's `limit`/`offset`/`meta.total` contract.
- [ ] **Step 6 — i18n.** All new UI strings routed through `data-i18n`/`t()` in all 5 locale files — the standing project rule, not optional.
- [ ] **Step 7 — Confirm true read-only (OD-E3).** No code path in this feature ever issues an `INSERT`/`UPDATE`/`DELETE`. This is what makes the catalog-wide auto-discovery safe to leave unscoped — verify by reading the finished endpoint code, not just by intent.

---

## Sequencing (file-conflict-driven, not spec-driven)

D1 and D4 touch disjoint files from each other and from D2+D3 — safe to implement concurrently. D2+D3 touch `brain.py`/`master_data.py`/`schema.sql` (shared with D1) and `web/plant-and-administration.mts` (not touched by D1/D4) — sequence **after** D1 to avoid concurrent edits to `brain.py`. E is additive/new-file-heavy but its backend half still touches `brain.py` (new routes) — sequence **after** D2+D3's `brain.py` work lands, or use a dedicated new module (`admin_tables.py`) mounted from `brain.py` with a single small integration edit at the end to minimize contention.

## Validation checklist (mirror workstream A's, don't skip)

- [ ] `npm run typecheck`, `npm run build`, `npm run lint`, `npm run check:static-assets`, `npm run check:legacy-surface` all clean.
- [ ] `node --test tests/modules/*.test.mjs tests/js/*.test.js` — no new failures beyond the pre-existing, already-documented ones from workstream A's completion report.
- [ ] `NIMBUS_TEST_DB=1 pytest tests/ -q` — same bar.
- [ ] `node --test tests/modules/locale-completeness.test.mjs` passes after every locale edit.
- [ ] Manually re-verify D1's fix with a real round-trip (hand-typed vs. ingested casing collapsing to one row), not just a unit test of the fold function.
- [ ] Manually re-verify E never fetches/renders a full setup-matrix snapshot for any UI — it's a generic table browser, not a setup-matrix-specific view, so this constraint is about *other* features, not E itself; just confirm E doesn't accidentally become a second, unscoped way to dump `setup_matrix` that bypasses the `matrix-rows` from-state scoping design.

---

## Completion Report (2026-08-20) — parked for review

**Status: implemented, validated, tested. Not committed. Not reviewed by a human yet.**

### What shipped
- **D1** — one canonical uppercase fold for setup attribute values across all 4 layers (Python
  `_normalise_value`, client `web/setup-domain.mts`, the `page_matrix_rows` raw-JSON bypass, and
  ingest-parity uppercasing for `PRT_01`/`PRT_02`/`PRODUCTION_VERSION` alongside the existing `COLOR`
  fold), plus an authored-not-run backfill migration
  (`migrations/2026-08-20-setup-value-case-fold-backfill.sql`) for Azure's existing mixed-case rows.
- **D2** — the "include setup times" flag relocated to a new, unregistered `plants.setup_active`
  boolean, written through a dedicated validated endpoint (`PUT /plant/{plant}/setup-active`,
  mirroring `machine.setup_compatible`'s precedent), surfaced via a new `SetupSnapshot.plant_active`
  field, with all ~9 call sites re-pointed. `setup_definition.active` kept (not removed) and
  documented as vestigial — the safer of the two options given the plan's own guidance.
- **D3** — explicit setup-matrix deletion UI: per-row delete, multi-select bulk delete, and a
  scope-level "delete all" behind a typed plant-code confirmation, all audit-logged with a
  distinguishing `scope` field (`row`/`bulk`/`all`/`edit`).
- **D4** — a covered, identical-signature, zero-minute transition now produces a real observation
  (no bar, no capacity consumed, no alert) instead of an empty detail card — reusing the domain
  layer's existing `'implicit-zero'` source value rather than inventing a redundant one, with a new
  `ui.setup_source_no_change` display label and a distinct `ui.setup_override_none` state.
- **E** — a new, deliberately separate, read-only universal table browser: `admin_tables.py` (new
  module) composes per-request catalog discovery with `psycopg.sql.Identifier` safety for the first
  time in this codebase; PK/FK resolved via `pg_constraint` (not the naive `information_schema` join,
  which cross-products composite keys); three endpoints (`GET /admin/tables`,
  `GET /admin/tables/{table}`, `GET /admin/tables/{table}/export.csv`) — admin-only, unscoped by
  plant (a documented data-exposure decision), streaming CSV export with a soft 250k-row cap signaled
  by a trailing `# NIMBUS_TRUNCATED,resume_offset=N` marker line. Frontend: new `web/admin-tables.mts`
  module, 6th admin sub-tab, AG Grid with paste-aware multi-value PK/FK filters (reusing the
  `Table`/`GanttFilter` "pomat" pattern), server-side pagination, CSV export via `Util.fetchTraced` →
  blob → temporary download link (matching this repo's existing identity-header-aware download
  pattern, since a plain link would 403).

### Model discipline
Sonnet for every implementation task (schema/DDL, wire contracts, safe dynamic SQL, cross-file
reconciliation, translation). No Haiku dispatch was needed this round — D+E's tasks were each
judgment-heavy enough that a mechanical pre-pass wasn't the right shape. No Opus, no Fable.

### Validation (all clean, same as workstream A's bar)
`npm run typecheck`, `npm run build`, `npm run lint` (0 errors, the same 51 pre-existing warnings),
`npm run check:static-assets`, `npm run check:legacy-surface`.

### Testing
- JS suite: **405/410 pass.** All 5 non-passing tests are pre-existing and confirmed unrelated —
  **verified against a true pristine-HEAD checkout** (via a temporary `git worktree`, not `git stash`
  — see the incident note below) rather than assumed: 2 hardcode dates now past the sandbox clock, 2
  hit the already-documented `OptimizerPreview` quirk, and **1 newly-discovered pre-existing
  failure** (`runAndApply ... resolves real ranks from Store state`) that was already broken at HEAD
  before this entire session — root-caused by direct debugging (a standalone script confirmed
  `_sortTerms`'s rank resolution itself is correct; the bug is downstream in dispatch/placement,
  untouched by any of D1/D2/D4/E's diffs) and then conclusively reproduced on pristine HEAD in an
  isolated worktree. Not fixed — genuinely pre-existing and out of this workstream's scope, but now
  documented here since it wasn't caught in workstream A's baseline (that baseline undercounted by
  one; corrected here).
- Python suite: 329 passed / 1 skipped (documented pre-existing skip) / 4 errors — the same
  `subnetworks.name` NOT NULL fixture bug from workstream A's report, still unrelated and unfixed.

### Incident: a `git stash`/`git stash pop` round-trip left the repo in a confusing state
Mid-investigation, `git stash --include-untracked` followed by `git stash pop` partially failed
(permission errors cleaning a couple of `.claude/skills/` directories and one `.docx` file blocked
the working-tree checkout step), leaving two redundant stash entries and a temporarily confusing
staged/unstaged split. **No data was lost** — verified by direct content checks (`schema.sql`,
`brain.py`, `admin_tables.py`, etc. all still had every session change intact) before proceeding. Two
harmless leftover stash entries remain in `git stash list` (`stash@{0}`, `stash@{1}`, both
`WIP on main: 101e743`) — safe to `git stash drop` both, or ignore; deliberately left alone rather
than risk a further git operation mid-session. Lesson applied immediately after: switched to
`git worktree add` (isolated, no shared-index risk) for the subsequent pristine-HEAD verification
instead of `git stash` again.

### Deliberately not done
- The newly-found pre-existing `runAndApply`/rank-resolution bug (above) — flagged, not fixed, out of
  scope for this workstream.
- The `subnetworks.name` bug from workstream A — still not fixed, still flagged.
- Two harmless stray `git stash` entries — left for the user to drop or ignore.

### Not committed
Nothing in this workstream has been committed. The working tree now carries both workstream A and
D+E's changes together (69 total changed/new files at last count), still fully uncommitted.
