# Scheduling Priority — multi-field priority lists

Tracks NIMBUS's move from a single per-plant **color wheel** to **per-plant, per-field priority
lists** arranged in a configurable priority tree, and the optimizer work to honor them. This is a
multi-stage effort — update the stage table below as work lands, the same way
`docs/archive/typescript_migration.md` tracks its phases.

> **This document is deliberately front-loaded.** The [Decisions](#decisions) and
> [Review findings](#review-findings) sections capture two full design-review passes done against
> the live code before any implementation, including the options that were *rejected* and why.
> Each stage should read findings *here* instead of re-deriving them. When a stage lands, correct
> anything here that turned out wrong rather than letting it rot.

> **Stale-mode notice:** measurements and code excerpts below reference `Engine.runAndApply('combined')`,
> `Engine._sortTerms('combined')`, and `Engine._dispatchDayIntegrity` as they existed on 2026-08-11.
> **`'combined'`/"Smart" mode was removed in commit `b002b32`, and `_dispatchDayIntegrity` was deleted
> in commit `1678865`** — see `CLAUDE.md`'s Key Patterns section. Treat every `'combined'`-mode claim
> here as a historical snapshot, not current behavior; the priority-list/rank-map architecture itself
> is still current.

## Stages

| Stage | Scope | Status |
|---|---|---|
| **1** | Data plumbing — `priority_list` table, values materialized onto `orders` at ingest, `color_wheel` migrated in, exception report, resync endpoint, `GLOBAL_CW` retired | **Code complete 2026-08-11, not yet applied to any database** — see below |
| **2** | Upload + column-mapping UI, per-field coverage, generic list viewer, resync prompt. Non-color fields visibly inert | **Code complete 2026-08-10, pre-ship checks outstanding** — see below |
| **3** | The priority tree, effective-sequence panel, generic optimizer sort terms. **The only stage that changes sequencing.** | **Code complete 2026-08-11, verified by code-trace + executable differential only — no live-data or browser run** — see below |

Each stage is independently deployable. Staging exists so the risky data work settles on the pilot
before anything about sequencing behavior depends on it.

**Stage 3's sequencing-impact audit** —
`docs/superpowers/plans/2026-08-11-stage-3-sequencing-audit.md` — is now a two-part document.
**§1-8 (pre-implementation, 2026-08-11)** re-verified this document's load-bearing claims against
live code *before* any Stage 3 code was written: it confirmed that Stage 1+2 changed sequencing not
at all and that `_dispatchDayIntegrity` needs zero changes, and produced the corrections now folded
into the sections below (Seam 1's map shape, R1, R6, R7, R8, R11, R19, N2, the xmin section's `db.py`
line, and Stage 2's status item 2). **§9-14 (post-implementation, 2026-08-11)** re-runs the same
checks against the shipped code, and carries the Risk 2 before/after differential, the R11 wall-clock
numbers, and the two residual findings the implementation left open. Read §9-14 for what Stage 3
actually does today; read §1-8 for why it was built that way.

**Stage 1 status (2026-08-11):** all code from `docs/superpowers/plans/archive/2026-08-10-priority-lists-stage-1.md`
is written, tested at the pure-logic level, and both `npm run build`/`typecheck` and the Python test
suite pass. **Not done:** the migration has not been applied to any database (local or Azure), and
pre-ship check #1 (population counts for `material_plants.color`/`prt_01`/`prt_02` per plant) was
explicitly waived by the user rather than run before this landed — see Risk 3. The `@pytest.mark.pg`
tests in `tests/test_priority_lists.py` have not been executed against a live database either.
Applying the migration and running that check remain open steps before this is genuinely "shipped."

**Stage 2 status (2026-08-10):** all 15 implementation tasks land — backend (Tasks 1-8: `master_data.RANKABLE_FIELDS` default labels, `known_line_codes_for_plant`, `db.missing_master_data_for_plant`, the six new endpoints below, and `POST /color-wheel/{plant}` rewritten onto the shared `_resolve_priority_list_columns`/`_persist_priority_list` helpers per Decision 9b) and frontend (Tasks 9-15: new TS types, the mapping + generic viewer modals, `PriorityListMapping`, `PriorityListViewer` — which delegates to the untouched `ColorWheelViewer` for `colorWheel` only when no line override is requested — the rewritten per-field Optimization tab with its missing-master-data panel and Resync Now button, CSS, and i18n across all 5 locales). `npm run build`/`typecheck` are clean and the new `locale-completeness` test passes. Several real bugs were found and fixed during implementation, verified by code review at each step: a pandas-3 landmine where `Series.astype(str)` no longer stringifies `NaN` the way pandas 2 did (fixed throughout the new upload-parsing code via `.fillna("")` before `.astype(str)` — see `docs/MIGRATION.md`), two back-compat breaks on the rewritten `/color-wheel/{plant}` route that contradicted Decision 9b's own "no previously-valid file can start failing" principle (duplicate-value-conflict rejection and empty-file rejection, both restored for that route only), and a production-breaking bug where the new Optimization tab's missing-master-data fetch used bare `fetch()` instead of `Util.fetchTraced` against an admin-gated, plant-scoped endpoint — invisible locally (no auth), but it would have silently failed to render for real admin users on the Azure pilot and mis-scoped a plant-restricted user's request; both fixed.
**Not done, and not to be treated as shipped until they are:** (1) the `@pytest.mark.pg` tests in `tests/test_priority_lists.py` were never executed against a real Postgres this session — this machine's `.env` currently points `PG_HOST` at the live Azure pilot DB, so the test harness's own collection-time guard (see `AGENTS.md`/`CLAUDE.md` → Database Setup) auto-skips the entire pg-marked suite; verification instead relied on careful manual code-tracing and, for the pandas-3 fix, empirically running equivalent snippets against the installed dependency versions. Run `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -v` against working local credentials before calling this verified. (2) ~~`tests/modules/legacy-surface.test.mjs`'s contract-snapshot test is currently failing because the new onclick handlers added in Tasks 10-12 aren't reflected in `tests/contracts/cq1-legacy-surface.json` yet — run `node scripts/legacy-surface.mjs --write` and commit the regenerated fixture before merge.~~ **DONE** — the fixture was regenerated in `f8e7269`; the test passes 10/10 (verified by running it, 2026-08-11, Stage 3 Task 0 audit). Note for Stage 3: its tree-UI task adds more inline handlers, so this fixture will need regenerating again — a failure there will be newly introduced, not this leftover. (3) No task did a real browser/visual check of the new UI — the mapping modal against a genuinely ambiguous-column file (not just the pytest fixture), the upload flow end-to-end, and dark mode across all the new surfaces all remain to be done by hand. (4) `POST /color-wheel/{plant}` has no verified external-caller check — a manual curl/Postman test against a real `.xlsx` (with and without `ORDER_Y`) confirming the back-compat contract holds is still outstanding.

**Stage 3 status (2026-08-11):** all 11 tasks land (`de2f528`..`e71e986`). `Engine._sortTerms` is now a
generic term factory over `flattenConstraints`' key list, reading ranks from `Store.priorityRankMaps`
(`GET /priority-rank-maps`, served from the in-process `PLANT_LISTS`); `colorMap` and the `ORDER_Y`
optimizer fallback are **gone** (`grep -rn "colorMap\|if (key ===" web/` → zero matches, `.mjs`
build outputs included; the only remaining `ORDER_Y` references in `web/` are the upload drop-hint
locale strings, the `NimbusTask`/`TaskDTO` type declarations, and two comments recording the
retirement). `set_plant_constraints` preserves and depth-caps nested `children`; Scheduling Constraints
is an indented tree with an effective-sequence panel; the `/priority-fields` registry drives
`CONSTRAINT_CATALOG`, the field→task-field map, and the field descriptions at boot. `npm run
build`/`typecheck` clean, `npm run lint:errors` shows **47 errors, all pre-existing `no-dupe-keys` in
`web/locales/*.js`** (byte-identical count when the same rule is run against those files at the
Stage 2 tip `8bf2f94` — Stage 3 added none), `node --test` is 15/15 legacy + 138/139 modules, and
`pytest` is 128 passed / 68 skipped / 0 failed. `_dispatchDayIntegrity` was **not** modified.

**Verified by executable code-level evidence** (see the audit doc §9-14): the Risk 2 before/after
differential (below), the four registered field-key → task-field mappings, the N12 padded-key
encoding including the fractional/oversized-rank clamp, line-override-beats-plant-wide resolution,
per-task line resolution surviving a cross-line move with no refetch, the tree flatten/duplicate-
collapse/disabled-subtree semantics, `runAndApply` with **no** explicit plant or map resolving real
ranks from `Store` state (the alert auto-fix path's mechanism), and the R11 wall-clock delta.

**Not done, and not to be treated as shipped until they are:**
1. **No live-data or browser run of any kind.** Risk 2's before/after, the alert auto-fix check, the
   cross-line drag check and the R11 timing were all produced by running the *real shipped module*
   under Node against synthetic orders, not by driving the app. Nothing was verified against real
   plant data, a real `priority_list` table, a real stored `plants.constraints` tree, or a rendered
   Scheduling Constraints tree. Stage 1's own pre-ship check #1 (how populated
   `material_plants.color`/`prt_01`/`prt_02` actually are per plant) is **still outstanding and still
   waived**, and it now gates *sequencing behavior*, not just displayed values.
2. **The `@pytest.mark.pg` tests still auto-skip** (40 of 57 in `tests/test_priority_lists.py`,
   including Task 2's `test_set_plant_constraints_preserves_nested_children`). This machine's `.env`
   sets `PG_SSLMODE=require` against a local Postgres that has no SSL (`server does not support SSL,
   but SSL was required`) and carries Azure credentials, so the harness's collection-time guard skips
   them by design. The non-pg half — including Task 3's two `/priority-rank-maps` tests and Task 2's
   depth-cap test — does pass.
3. ~~**Two residual findings the implementation left open**~~ **RESOLVED in a same-day fix round** —
   Task 10's verification found three defects and all three were fixed rather than handed off (audit
   doc §14): (a) the **stale-plant window on the alert auto-fix path** — `Persistence.load()`,
   `_loadCache()` and `_loadDemo()` now drop `Store.priorityRankMaps` + `_rankMapsPlant` the moment a
   plant change is detected, so the window degrades to "nothing ranked yet" instead of "ranked by the
   previous plant"; (b) `GET /priority-rank-maps` **now carries the same `allowed_plants` gate** as
   every sibling in its block, with `Persistence.loadPriorityRankMaps` switched from bare `fetch` to
   `Util.fetchTraced` in the same change so the identity header the gate reads actually arrives (and
   `x-request-id` correlation is restored); (c) the **"not yet used in sequencing" badge was removed**
   now that all four fields really are used.
4. **The non-color fields are wired but unproven against real values.** Risk 3 (free-text
   `prt_01`/`prt_02` spelling mismatches degrading to all-999999) is now live rather than latent, and
   coverage is the only guard. Nobody has yet run the Stage 2 coverage readout against a real plant's
   tooling data with the optimizer depending on it.
5. **The final whole-branch review (2026-08-11) found 3 Important + 6 Minor issues; 8 were fixed in
   one closing wave, 1 parked.** All three Important ones were *cross-task* gaps — real in the union
   of the tasks, invisible inside any single task's diff — which is the case for keeping that review
   step: (a) **N11 was never implemented** (see the finding's own entry below): both inert-config
   warnings were still `colorWheel`-only, so a plant sequencing purely on `prt01`/`prt02`/
   `productionVersion` got no warning at all, including on an outright failed rank fetch;
   (b) the **"Effective sequence" panel mis-attributed duplicated keys** — it credited the first
   occurrence in tree order via `flat.includes(key)`, so a disabled duplicate ahead of an enabled one
   was labelled effective while the enabled one read "(no effect)", inverted, in the one panel whose
   job is honesty about the collapse. `Engine._walkPriorityTree` is now the single traversal behind
   both `flattenConstraints` and the new `effectiveConstraintPaths`, so per-key and per-node answers
   cannot diverge again; (c) **`Util.countChangeovers` was blind to the three new fields** while
   backing the Optimizer Preview's Apply/Discard KPI, so a run that genuinely cut tooling changeovers
   could show a flat-or-worse number — it now resolves its field set from
   `Engine.changeoverTaskFields(plant)` through a new `Util.setChangeoverFieldsResolver` DI seam
   (Foundation may not import Domain), and the alert cell-briefing's duplicate count shares it.
   Minors fixed: `Store.setPriorityRankMaps` no longer `emit()`s (it was tripping
   `Persistence.autosave`'s unfiltered subscriber on every rank load — the same rule
   `setLastOptimize` already documents); an **empty line-override no longer shadows** a working
   plant-wide list (`??` does not bridge `{}`); an unregistered constraint key no longer contributes a
   constant dead sort term; the late-arriving `/priority-fields` registry now actually re-renders the
   Scheduling Constraints pane via `Plant.onPriorityFieldsLoaded()` (a comment claimed this already
   happened — it did not, and without it a slow/failed boot fetch left every add-field picker disabled
   for the whole session with no recovery but a reload); and the stale "color -> form -> runHours ->
   material" comment on the phase-2 comparator was corrected. **Parked deliberately:** the
   `POST /master-data/plants/{plant}/constraints` per-plant RBAC gap — pre-existing, broader than this
   stage, recorded in `docs/MIGRATION.md`.
6. ~~**The Optimization tab's "not yet used in sequencing" badge was not removed**~~ **DONE** — the
   badge, its `.pl-inert-badge` CSS rule, and the `ui.not_yet_used_in_sequencing` key in all five
   locales were all deleted once the label became false. Note this removes a *warning*, so item 4's
   coverage caveat is now carried only here and by the Stage 2 coverage readout itself; a replacement
   "verify your coverage" caution on the field card was considered and deliberately left as a separate
   copy decision.

## Why

Today NIMBUS can rank orders by exactly one attribute: color. One `.xlsx` per plant (`COLOR` +
`ORDER_Y`) uploads through Master Data → Plant → Optimization into the `color_wheel` table, and
Plant → System Settings → Scheduling Constraints shows a flat on/off + ▲▼ list whose catalog
(`Engine.CONSTRAINT_CATALOG`) has a single entry. `Engine._sortTerms` carries a
`// future: if (key === 'tooling')` placeholder — the extension point was anticipated, never built.

`material_plants` already holds three more planner attributes — `prt_01`, `prt_02` (Production
Resource Tools, i.e. machine tooling) and `color` — editable in the Material Plant grid since
2026-08-07, but **unreachable by the optimizer**. Plants also need different precedence from one
another, with sub-ordering inside each level: one plant sequences Color → PRT01 → PRT02, another
PRT01 → PRT02 → Color.

Stage 1 materializes a fourth field alongside those three: `production_version`, from
`material_plants.default_production_version` (a base column that predates this feature — unlike
`prt_01`/`prt_02`/`color`, it was never behind the special attributes-only write endpoint, since
it's plain-editable through the generic Material Plant grid already). See the **Materialized
fields (Stage 1)** row in [Decisions](#decisions) for why.

**Outcome:** an admin uploads one priority list per rankable field per plant (with column mapping,
so an arbitrary spreadsheet works, and an optional per-line override), arranges those fields into a
per-plant priority tree, sees the exact effective sort sequence that tree produces, and the
optimizer honors it — without weakening the day-integrity dispatch that protects due dates.

## Decisions

Every locked call, with the reasoning and what it displaced. Two review passes fed this; the
findings themselves are in [Review findings](#review-findings).

| Decision | Resolution | Why / what was rejected |
|---|---|---|
| **Sub-sort model** | **Nested UI, flat engine.** Build and see an indented tree; NIMBUS flattens it (pre-order DFS, duplicate keys dropped) and displays the effective sequence with duplicates marked "(no effect)". | A field nested under a field is *mathematically identical* to the next key in a lexicographic sort — a tree of fields flattens with no loss. Nesting would only differ if the sub-order varied **per value**. Rejected: per-value sub-orders (needs per-value config UI + storage) and weighted scoring (a real optimizer rewrite). The effective-sequence panel is what keeps the presentational tree honest rather than a fiction. |
| **Vs. due dates** | **Priority sequences *inside* each calendar day**, exactly as color does now. Due-date tiering in `_dispatchDayIntegrity` keeps winning. | Preserves the v18/v19 day-integrity redesign. **Held true through Stage 3, which shipped without touching `_dispatchDayIntegrity` at all** — both `seqCompare` (`schedule-services.mts:1345-1351`) and `rankForDay`'s `wheelFirst` (`:1360-1370`) iterate `tieBreakTerms` generically, and `tieBreakTerms` is injected by the sole caller (`runAndApply`, `:1630-1632`, forwarding `_sortTerms`' own output). Growing the term list from 1 conditional color term to N generic per-field terms was invisible to it. Verified pre-implementation by Stage 3's Task 0 audit (reading the entire body, correcting the `:1069-1230` earlier notes cited) and **settled conclusively post-implementation by Task 10: the 252-line body is byte-identical between `8bf2f94` (`:1060-1311`) and Stage 3's tip (`:1285-1536`) — `diff` returns nothing.** No field name is hardcoded anywhere in it. Rejected: letting a field cross day boundaries to hold a tool campaign together (weakens due-date adherence); hierarchy outranking due dates entirely. |
| **Attribute source** | **Materialized onto `orders` at ingest from `material_plants`.** No read-path join. Excel `COLOR` stops being a source. | User's call: *"rather than frequently doing joins we do a join on ingest based on mp.color and it sets that value… I'm trying to optimize and keep this clean."* Rejected: a `LEFT JOIN material_plants` on the `/tasks` hot path (the original draft). |
| **Ranked value** | **The field's own values, at plant scope** (`{DOG:1, CAT:2}`) — not per material. | `material_plants` PK is `(material_id, plant)` — one `prt_01` per material per plant, and only one is being allowed for now. So material → tool is 1:1, and a per-material tool rank collapses to a per-material rank, making the ranked field redundant. If material priority is ever wanted it is a `MATERIAL_NUMBER` registry entry, **not** a compound key. |
| **List scope** | **Plant-wide, with an optional per-line override.** Line row wins for that line; otherwise the plant row. Mirrors plant calendars/blackouts (`line: null` = whole plant). | Justified by the domain, not speculation: the coming PRT setup/teardown matrix is keyed by *workcenter/production line*, so PRT data is inherently line-scoped. |
| **Uploaded file** | **One file per plant.** A mapped `Plant` column is **validation** that the file matches the plant being uploaded to. Optional `Line` column selects the override scope. Other columns (Material, …) are validation-only or ignored. | User: *"I want plant in the upload as an extra validation."* Rejected: one file seeding many plants by splitting on the Plant column. |
| **Storage** | **One `priority_list` table**; `color_wheel` rows migrated in; `/color-wheel/*` kept read-compatible. | Color stops being a special case with its own upload path. Keeping the old routes read-compatible is what lets `ColorWheelViewer` and the Admin Cockpit coverage panel survive the change untouched. Rejected: a separate table for the new fields only (Color would keep a different UX forever); retiring `color_wheel` and its routes in the same change (too much at once). |
| **Default tier** | **Per-plant only.** The global `COLOR_FILE` / `GLOBAL_CW` fallback is **retired**. | It is an ephemeral file lost on container restart (`docs/MIGRATION.md` WS5) — a fallback nobody can rely on. Rejected: a `plant = '*'` shared default row, and a three-tier default → subnetwork → plant resolution. |
| **Unmatched MP rows** | **Never block the upload.** A missing-master-data **exception report** instead: distinct `(plant, material_number)` pairs with no `material_plants` row, order counts, and the reason — viewable and CSV-exportable. | The blocking threshold originally proposed would have refused the *first* upload to every new plant (empty `material_plants` ⇒ 100% unmatched), training everyone to always pass the override and destroying the guard. Making the gap **actionable** beats refusing work. Rejected: block past a threshold; block only on genuine mismatch; keeping Excel `COLOR` as a gap-filler. |
| **Keeping orders fresh** | **Batch-scoped ingest stamp + a Resync prompt right after upload + a manual Resync button.** No propagation from the Material Plant grid, no scheduler. | Grid auto-propagation is **unsafe at any cost** — see [the `xmin` hazard](#the-xmin-hazard-general). Batch scoping keeps the row-version blast radius small; the post-upload prompt puts the consistency decision at the moment it is created, with full information, rather than letting drift go unnoticed. Rejected: whole-plant stamp on every upload (bumps row versions on untouched orders); a passive drift indicator (nobody reads it); a nightly scheduler. |
| **Materialized fields (Stage 1)** | `color`, `prt_01`, `prt_02`, and **`production_version`** (from `material_plants.default_production_version`). | **Correction, 2026-08-11:** an earlier draft of this stage materialized `default_workcenter` as the fourth field. The user caught this during implementation: `default_workcenter` is a plain admin-editable `material_plants` column unrelated to routing, and doesn't belong here. `production_version` is the right fourth field — it's the eventual PRT_02 join anchor once PRT_02 moves from a single TEXT value to a production-version-keyed table (see the **PRT_02** decision below), and materializing it now costs nothing. Bonus: `PRODUCTION_VERSION` is already a *dead* entry in `web/order-field-catalog.mjs` (`db.py` never wrote it) — this fixes that pre-existing drift instead of adding a new dead entry for `default_workcenter`. |
| **Unranked / equal-rank values** | **Grouped by value, placed after ranked ones.** Sort key = `pad(rank) + '\|' + normalizedValue`. Applies to Color too. | A bare rank makes all unranked values tie, so they scatter under later terms — **maximum** changeovers among exactly the orders whose changeover cost is the point. Also fixes the equal-rank case (DOG=1, CAT=1 currently scatter). Encoded as one fixed-width **string** key rather than a `{rank, value}` object, so each term still costs the Schwartzian decorate exactly **one scalar per term per task per day** (R11). *(Corrected 2026-08-11: this row previously claimed the encoding kept the decorate "allocation-free," which was never true — the padded string is itself an allocation. R11's real constraint was one **scalar** key per term instead of an object with two fields; the code comment at `web/schedule-services.mts:1181-1183` was fixed in `ddaf587`, this row was not until now.)* **This changes existing color output** for any plant with an incomplete wheel — see Risk 2 for the measured before/after. |
| **PRT vs. cost** | **Ordinal ranks now, behind a term-factory seam.** | The setup/teardown matrix is **1–2 years out** per the user, so waiting is not viable — but cost *is* coming, so the seam lets `setupCostTerm(field)` replace `ordinalTerm(field)` per field with no tree, storage, or UI change. It bounds *code* churn, not the re-tuning plants will need. Rejected: shipping Color-only and deferring all PRT ranking; building ordinal with no abstraction. |
| **PRT_02 shape** | **Single-valued now.** | Matches what the column holds and what the user is allowing (*"for now, lets just assume there is only one mold (PRT02)"*). Logged as known rework: the long-term model is PRT_02 → production version → BoM + routing. |
| **Production Version table** | **Out of scope**, though it lands in weeks. | Asked directly by the user. The design ranks the value *on the order* and is indifferent to provenance — when PRT_02 moves to production versions, only [`_stamp_order_attributes`](#seam-2--_stamp_order_attributes) changes. **Nothing built here gets undone.** Pre-empting would pull a new master-data table (CRUD registration, BoM/routing FKs, admin grid, cascade-delete preview) into an already-large change and risk conflicting with the real design. |
| **Delivery** | **Three stages**, each independently deployable. | Isolates the migration and ingest risk from the visible behavior change. |

## Architecture — the three seams

These are the load-bearing boundaries. Each exists so a foreseeable future change touches one
place instead of many.

### Seam 1 — values on the order, ranks on the client

Values materialize onto the order row at ingest: no hot-path join, and they display as Orders-grid
columns. **Ranks never touch the order row.** They resolve on the client from per-plant rank maps
loaded with plant state and refreshed after any upload.

The map shape is **line-first**: `{line|'': {field_key: {VALUE: RANK}}}`. That is the native shape of
`brain.PLANT_LISTS` (`brain.py:123`) and `db.load_all_priority_lists()` (`db.py:2036`), and Stage 3's
`GET /priority-rank-maps` returns it verbatim rather than transposing on the optimizer's hot path.
*(Corrected 2026-08-11 by Stage 3's Task 0 audit — this paragraph previously stated the inner
ordering field-first, which no code has ever produced.)*

A rank is therefore always looked up against the order's **current** line — which is what makes
line overrides survive a cross-line drag. `ORDER_Y` is still stamped server-side, for color
compatibility only (the emitted row sort at `brain.py:1026`, `ColorWheelViewer`, the coverage panel).

Why not the alternatives:
- *Materializing ranks onto orders* would rewrite the whole `orders` table on every list upload,
  and break the current behavior where re-uploading a wheel takes effect on the next `GET /tasks`.
- *Stamping ranks per-order in the response* (the original design) goes stale on every line change
  — see [N2](#pass-2--review-of-the-revised-plan). It also put a dict on every one of thousands of
  orders where a few hundred map entries per plant suffice.

### Seam 2 — `_stamp_order_attributes`

The single place attribute provenance lives: one `UPDATE orders … FROM material_plants` keyed
`(plant, material_number = material_id)`. When PRT_02 moves to production versions, **this query
changes and nothing else does.** `material_plants.default_production_version` (`schema.sql:260`) is
the eventual join anchor.

It runs *post*-upsert because `orders.plant` is itself backfilled after the upsert and the stamp
must see the derived value. Shared by the Excel and `sap_sync` ingest paths, and it **wins over any
color `sap_field_map` maps** (no live conflict — the SAP connectors are stubs — but a recorded
decision, not an accident).

### Seam 3 — the term factory

`_sortTerms` asks a factory for each field's optimizer term. `ordinalTerm(field)` today;
`setupCostTerm(field)` when the matrix exists. The tree, storage, and UI are indifferent to which
is active.

**Built in Stage 3** (`web/schedule-services.mts:1191-1245`). The shape it actually took: rather than
a named `ordinalTerm(field)` function, `_sortTerms` inlines one loop over
`Engine.activeConstraintKeys(plant)` (→ `flattenConstraints`, so tree-aware for free) that pushes one
`{get, cmp}` per key, with `_taskFieldFor(key)` supplying the task field and the N12 padded-string key
as the ordinal encoding. Substituting a cost-based term per field is therefore a change to the body of
that one loop — the seam's guarantee (tree, storage, UI, and `_dispatchDayIntegrity` all indifferent)
holds, but a caller wanting to *mix* ordinal and cost terms per field would want the loop body
extracted into the named factory first. Nothing outside `_sortTerms` knows how many terms there are or
what they read.

Setup/teardown data belongs in its **own** `(line, from_prt, to_prt)` matrix table — deliberately
*not* columns on `priority_list`.

## Review findings

Two passes against the live code before implementation. Verified claims cite the file that proves
them. `R*` = pass 1, `N*` = pass 2.

### Pass 1 — review of the first draft

**Would have shipped as bugs:**

- **R1 — `Config.SCHEMA_VERSION` was never bumped** (`web/application-foundation.mts:137`, was
  `4` → must be `5`). The localStorage cache is discarded only on version mismatch
  (`schedule-data.mts:837`). Without the bump, returning users rehydrate old-shape tasks missing
  the new fields → every order ranks 999999 → every priority list silently ignored, no error. The
  worst class of bug: looks configured, does nothing.
  **RESOLVED in Stage 1** — `Config.SCHEMA_VERSION` is now `5` (verified at
  `web/application-foundation.mts:137` by Stage 3's Task 0 audit, 2026-08-11). Left in place because
  N17 refers back to it.
- **R2 — auto-propagating Material Plant edits into `orders` would destroy planner work.** See
  [the `xmin` hazard](#the-xmin-hazard-general). Dropped entirely.
- **R3 — ledger-guard trap.** If the backfill migration runs before `material_plants` is populated,
  the `schema_migrations` row records it applied and it **never runs again** → orders permanently
  blank. Same shape as the ×1440 landmine (`schema.sql:135-143`), inverted. Resolution: the
  backfill is *convenience*; `POST /master-data/resync-order-attributes` is the mechanism.

**Gaps:**

- **R4** — `web/order-field-catalog.mjs` needs `PRT_01`/`PRT_02` entries, or the materialized values
  are not selectable as Orders-grid columns. **Correction (2026-08-11):** the fourth materialized
  field is `production_version` (from `material_plants.default_production_version`), not
  `default_workcenter` — see the [Decisions](#decisions) table. `PRODUCTION_VERSION` needs no new
  catalog entry; it already exists (dead) at `web/order-field-catalog.mjs:78`, one of the ~10 fields
  `db.py` never writes — see [cross-cutting findings](#cross-cutting-findings-lift-these-out). This
  stage fixes that one entry rather than adding a new dead one for `default_workcenter`.
- **R5** — SAP precedence must be stated (seam 2).
- **R6** — the emitted row sort (`brain.py:1026`, keyed on `ORDER_Y`) is **presentation and
  link-building order only**, never the optimizer's order. Documented so nobody "fixes" it by
  reading `plants.constraints` on the hot path for an ordering the optimizer overwrites anyway.
- **R8** — `_renderSettingsPane`'s `initConstraints` is **synchronous**
  (still is — `Plant._renderSettingsPane` `plant-and-administration.mts:1210`, `initConstraints`
  `:1680`); sourcing the field list from a fetch needs a loading state
  and a `CONSTRAINT_CATALOG` fallback, or a slow first paint renders an empty list. **Sharpened by
  Stage 3's Task 0 audit (2026-08-11):** a `CONSTRAINT_CATALOG` fallback is *not sufficient on its
  own*, because the tree's keys come from the plant's stored `constraints` (`Store.masterData`), not
  from the catalog — so the **field-key → task-field** map needs its own hardcoded fallback too, or a
  plant with `prt01` configured resolves against a nonexistent task field and silently ranks every
  order 999999. Never derive the task field as `key.toUpperCase()`: `prt01` → `PRT01`, not `PRT_01`.
  **RESOLVED as specified.** `Engine._fieldTaskFields` (`schedule-services.mts:1125-1130`) hardcodes
  all four real mappings as the offline default; `setFieldTaskFields` **merges** over them so a
  partial or failed `/priority-fields` response cannot wipe them; `_taskFieldFor` `ErrorLog.warn`s on
  an unregistered key instead of guessing. Same merge-not-replace treatment for
  `setConstraintCatalog` and a local `_fieldDescriptions` fallback (the backend carries no
  description). All covered by tests, including the four literal mappings.
- **R9** — `column_metadata.display_label` is single-language, so de/es/fr/pt would show English.
  Resolve labels as `t('constraint.<field_key>')` with the DB label as fallback.
- **R14** — reject a multi-file drop with two files targeting the same field+scope (otherwise silent
  last-write-wins).
- **R16** — superseded by the exception-report decision.

**Perf / scale:**

- **R10** — prune the new task fields from the `Compute` worker snapshot; the `postMessage`
  structured clone is the documented dominant main-thread compute cost and Alerts/Utilization never
  read ranks. *(Unverified: confirm the snapshot ships whole task objects.)*
- **R11** — `tieBreakTerms.map()` runs per task **per calendar day** (`schedule-services.mts:1370`);
  term count goes 4 → 7 with all fields enabled. Opt-in cost (terms are only added for configured
  fields), but it constrained the N12 encoding to a scalar key.
  **Measured 2026-08-11 (Task 10, audit doc §12) — term count confirmed 4 → 7, and the cost is in
  the anticipated ballpark end to end but the per-term estimate was low.** Real
  `Engine.runAndApply('combined')` on 1,200 orders / 12 lines / 20-day due spread:
  **12.2 ms median with 1 field, 18.5 ms with all 4 → 1.52x**, comfortably inside R11's accepted
  ~1.75x. But the *isolated* `tieBreakTerms.map()` loop is **2.75x**, not 1.75x: R11 estimated from
  term **count** alone, and a priority term (`Util.norm` + two map lookups + `Number.isFinite` +
  `Math.round`/clamp + `String()` + `padStart` + concat) is materially more work per call than the
  `FORM_SIZE`/`MATERIAL_NUMBER`/`runHours` tail terms it is being counted against. End-to-end stays
  under the estimate only because the decoration is a fraction of total run cost. Numbers are Node/V8
  on synthetic data with `respectCalendar: false`; a real run adds term-count-**independent**
  `Calendar` work to both arms, so 1.52x is an **upper bound** on the real end-to-end ratio.
- **R12** — coverage must not be one query per (line, field); see N3.

**Operational / debt:**

- **R13** — `PLANT_LISTS` is per-process, like today's `PLANT_CWS`, but **widened from 1 field to 4
  × line scopes**: on multi-replica, an upload to replica A leaves B stale. Pilot is single-replica,
  so not blocking. → `docs/MIGRATION.md`.
- **R17** — three accepted compat shims to track: the dead `color_wheel` table, `/color-wheel/*`
  serving a differently-named table, and `ORDER_Y` aliasing the color rank. → `docs/MIGRATION.md`.
- **R18** — `CLAUDE.md` and `AGENTS.md` are twins; both document this architecture and both must be
  updated or they drift.
- **R19 — WRONG, corrected 2026-08-11 by Stage 3's Task 0 audit.** The claim was that
  `tests/modules/schedule-services.test.mjs` will **break** on the `_sortTerms` signature change.
  It will not: `grep -rn "colorMap\|_sortTerms\|_comparator" tests/` returns **zero matches** —
  nothing in the test tree references any of the three. That file's Engine test
  (`tests/modules/schedule-services.test.mjs:128-133`) makes only positive `typeof` assertions, so
  adding methods won't break it either. The real situation is worse in a different way: **`_sortTerms`
  has never had any test coverage at all**, so Stage 3's new tests are its first. Budget for new
  tests, not for repairing old ones.
  **Outcome (2026-08-11):** confirmed — no existing test broke, and Stage 3 added `_sortTerms`'
  first-ever coverage: 5 term-factory tests, 11 `flattenConstraints`/`constraintEnabled` tests, 5
  registry merge/no-op tests, and one end-to-end `runAndApply`-with-no-explicit-plant test standing in
  for the alert auto-fix path. **Unrelated pre-existing failure to expect:** that same file's
  `Engine.autoReflow` test (`:158`) has been red since 2026-08-04 — its dates are hardcoded to
  `2026-08-03` and expired. Every task in Stage 3 reproduced it, including at the pre-stage baseline.
  It is test debt, not a Stage 3 regression; fix belongs in its own housekeeping change.

**Corrected in pass 1:**

- **R7 downgraded from risk to note.** `wheelFirst` (`schedule-services.mts:1360`; the name is now a
  misnomer — it iterates *all* configured priority terms, not a color wheel) already spans
  `[color, FORM_SIZE, MATERIAL_NUMBER, runHours]`, so due date was *already* the last resort in
  `changeover`'s tier-2 and those three terms already discriminate nearly every pair. Extra PRT
  terms make due date matter marginally less often, not qualitatively less.

### Pass 2 — review of the revised plan

Mostly consequences of the two things that changed after pass 1: line scope became a built feature,
and delivery became staged.

**The significant one:**

- **N2 — CONFIRMED in code, and it forced an architecture change.**
  `web/schedule-workbench.mts:250` sets vis-timeline `editable: { updateGroup: true }`, so orders
  can be dragged **between lines**; `:1641` makes the Orders grid `PRODUCTION_LINE` column
  `editable: true`. Line changes are first-class through two surfaces, so a line-scoped rank stamped
  onto the order row is wrong the instant a planner moves that order. `OptimizeDialog` loads rank
  maps and would self-correct, but the **alert auto-fix path** (`schedule-services.mts:706`) loads
  none and would sequence off the stale value. Plant-scoped color never had this failure mode.
  **Re-verified 2026-08-11 (Stage 3 Task 0), with one narrowing:** that call site passes no `plant`
  either, but `runAndApply` defaults `plant` to `Store.selectedPlant`
  (`schedule-services.mts:1548`), so the *constraint tree* already resolves correctly there — only
  the *rank map* was missing. Every `runAndApply` caller's effective plant is always
  `Store.selectedPlant` (`OptimizeDialog.selectPlant` sets it at `schedule-workbench.mts:6190`),
  which is why a single non-plant-keyed `Store.priorityRankMaps` cache is safe.
  **RESOLVED in Stage 3, mechanism verified by test.** Ranks are no longer stamped on the order at
  all: each term resolves `byLine[t.PRODUCTION_LINE]?.[key] ?? byLine['']?.[key]` **inside `get()`**,
  per task, per call (`schedule-services.mts:1211-1214`), so mutating `PRODUCTION_LINE` — via the
  timeline drag (`schedule-workbench.mts:5666`/`:5703`), the Table override modal (`:2429`), or the
  Orders-grid editable line column (`:1641`) — changes the resolved rank with no refetch and no
  `_sortTerms` rebuild. Confirmed by executable check (audit doc §11.2). N2's two load-bearing
  citations (`schedule-workbench.mts:250` `updateGroup: true`, `:1641` `editable: true`) both still
  hold verbatim.
  **The race guard was replaced, not deleted** (Task 6): `OptimizeDialog.run()` now does
  `if (Persistence._rankMapsPlant !== plant) await Persistence.loadPriorityRankMaps(plant)` and
  confirms with the user when it is still not fresh, and `_updatePlantBadge` prefetches the same
  cache. **Residual, still open:** the alert auto-fix path cannot await it (`schedule-services.mts`
  must not import `schedule-data.mts` — layer direction), and `Store.priorityRankMaps` is not
  cleared when the selected plant changes, so there is a window during a plant switch where auto-fix
  would sequence the new plant's orders against the **previous** plant's ranks. See the audit doc
  §11.1.
- **N2b — resolution: drop the per-order rank payload entirely** (now [seam 1](#seam-1--values-on-the-order-ranks-on-the-client)).
  Adopted rather than offered because it is better on every axis: eliminates N1 and N2, eliminates
  N14, removes the worker-snapshot concern in R10, and shrinks the `/tasks` payload.

**Other line-scope consequences:**

- **N1** — dissolved by N2b (the server no longer resolves scope for ranks at all).
- **N4** — validate a mapped `Line` column against `production_lines` for that plant; reuse
  `master_data.known_plant_line_codes()`, which `/upload` already uses. A typo'd line code otherwise
  creates a list that never matches anything, indistinguishable from a working override.
- **N3** — coverage must be **one aggregate query per plant**. 70 lines × 4 fields is up to 280
  lookups per Optimization render; R12's "cache it" was written when the cardinality was 4.

**Ingest:**

- **N5/N6/N7** — the threshold, override, and override-audit requirement are all **removed** in
  favor of the exception report. See [Decisions](#decisions).
- **N9** — separate "order has no plant" from "order has a plant but no MP row" in the report.
  `orders.plant` derivation can fail on an ambiguous multi-plant line code (already a warning path);
  one signal for two unrelated failures sends people to the wrong fix.
- **N10** — `make_id` is not plant-aware (a known `docs/MIGRATION.md` gap) and a stamp keyed
  `(plant, material_number)` **amplifies** it: colliding ids across reused line codes now affect
  sequencing attributes, not just dates.

**Sequencing:**

- **N12** — adopted, including for Color. See [Decisions](#decisions).
- **N11** — the tree must show "enabled but no list uploaded" per field, generalizing the existing
  `cons-warn` / `ui.constraint_no_wheel` hint. Harmless at runtime, but silently inert config is
  what people file bugs about.
  **RESOLVED in Stage 3's final-review fix wave (2026-08-11), not in Task 8 as intended.** Stage 3
  shipped both halves of this warning still hardcoded to `colorWheel` — the whole-branch review
  caught it, since neither the task that built the tree nor the task that generalized
  `hasPriorityRanks` could see the gap from inside its own scope. Now: `Engine.unrankedActiveFields(plant)`
  (`web/schedule-services.mts`) is the one generic answer to "which active fields would rank
  nothing", derived from `flattenConstraints` + `hasPriorityRanks`; the tree hint
  (`ui.constraint_no_list`, replacing the colorWheel-only `ui.constraint_no_wheel`) renders per node
  for any enabled field with no list; and `OptimizeDialog`'s pre-Run confirm
  (`modal.no_priority_ranks_confirm_msg`, replacing `modal.no_color_wheel_confirm_msg`) fires when
  **any** active field is unranked, naming them. Because `unrankedActiveFields` reads the same cache
  the sort terms read, a failed/non-ok rank fetch surfaces as "every active field unranked" through
  the same call — so the confirm now also covers "ranks unavailable", including the previously-parked
  case where a failed *refetch* emptied the cache while `Persistence._rankMapsPlant` still matched
  the plant (that combination used to run unranked and unannounced). The optimization_run audit row
  gained `active_priority_fields` / `unranked_priority_fields` alongside the historical
  colorWheel-only `wheel_used`.
- **N14** — dissolved by N2b (`Sandbox` mutates the live Store, so it had the same staleness).

**Stage boundaries — two of these were my own contradictions:**

- **N15** — Stage 1 claimed "no visible behavior change" while re-sourcing color from Material
  Plant, retiring `GLOBAL_CW`, and adding a blocking guard. All three are visible; the rollback
  story rested on a false premise. Corrected to a checkable invariant: the *mechanism* is unchanged
  (one ordinal list per plant, color the only ranked field), so **every ordering difference must
  trace to a material where `material_plants.color` disagrees with `orders.color`**.
- **N21** — Stage 2's field card had a Preview button while "generalize `ColorWheelViewer`" sat in
  Out of scope. A Preview that works for color and breaks for tooling is worse than none, so a
  minimal generic viewer moved into Stage 2.
- **N16** — resolved: all field cards ship in Stage 2, non-color explicitly labelled "not yet used
  in sequencing", so real tooling data and its coverage can be validated *before* the optimizer
  depends on it — which is exactly when free-text spelling mismatches should be found.
- **N17** — Stage 3's `ConstraintConfig.children` is purely additive, so cached `plants` rows still
  parse: **no** second `SCHEMA_VERSION` bump. (Stated so nobody assumes one is needed and then skips
  it where it *was* — Stage 1, R1.)

**Debt this plan introduces:**

- **N19** — `priority_list.source_column` duplicates `RANKABLE_FIELDS[field]['source_column']`. Make
  the registry authoritative and the column audit-only, or drop it; two sources of truth for one
  fact will drift.
- **N20** — `value_column`/`rank_column` are upload provenance only; nothing re-parses from them.
- **N18** — the Admin Cockpit color-coverage panel and the new per-field coverage must share one
  function; two implementations of "which values are unranked" drift apart.
- **N22** — `t('constraint.' + key)` defeats static i18n extraction. Needs a fallback chain plus a
  test asserting every registered field has a locale key in all five locales.
- **N8** — batch-scoped stamping leaves a plant with orders stamped at different times from
  different Material Plant values. Resolved by the post-upload Resync prompt.

## Risks

1. **Master data must load before orders, and nothing enforces it.** Excel `COLOR` is no longer a
   source and the upload no longer blocks, so an orders-first load produces a schedule with no color
   or tooling sequencing at all. The exception report makes it *actionable*, not *impossible*.
   Accepted deliberately — blocking was self-defeating (N5). Re-enabling an Excel fallback remains a
   one-line `COALESCE` in seam 2.
2. **N12 changes existing color sequencing.** Any plant whose wheel does not cover every color in
   its orders sees a different (better-grouped) sequence after Stage 3. Expected — so "the schedule
   changed" is a legitimate observation rather than a bug.
   **Before/after captured 2026-08-11** (audit doc §10). Not a live-plant run — no browser or
   Postgres was available — but an executable differential of the **real shipped**
   `Engine._sortTerms('combined')` against the pre-Stage-3 color term taken verbatim from
   `8bf2f94`, over one order set, with the same lexicographic-over-terms comparator both
   `_dispatchDayIntegrity` phases use. On 12 orders / 6 distinct colors / 3 ranked:
   - **The ranked orders' relative order is byte-identical** before and after. Stage 3 cannot
     reorder a color the wheel actually ranks.
   - **All 7 positional differences fall entirely in the unranked tail.** Every one is an
     unranked-vs-unranked swap.
   - The unranked tail went from **5 color runs across 3 distinct colors**
     (`SLATE→BLACK→TAUPE→BLACK→SLATE`) to **3 runs across 3 colors** (`BLACK→SLATE→TAUPE`) — i.e.
     **2 fewer color changeovers**, which is N12's entire point and the minimum achievable.
   So the answer to "why did the schedule change?" is: *only* orders whose color is missing from the
   wheel moved, and they moved to sit next to their own color. **The fix is to complete the wheel**,
   which collapses the difference to nothing.
   **One caveat a live run still needs to confirm:** the differential above characterizes the
   *within-day resequence*. **Day assignment can also shift**, because the same terms drive
   `rankForDay`'s intra-tier ordering (`schedule-services.mts:1372-1383`) and admission follows that
   ranking — so on a day that fills or fragments, a changed key changes which order is admitted and
   which spills. Tier 0 (native) and tier 3 (floater) rank on the priority terms **alone**, in both
   modes; tier 2 (pull-in) does too under `'changeover'` (`wheelFirst || due`) but only breaks
   due-date ties under `'combined'`/Smart (`due || wheelFirst`); tier 1 (carry) is tie-break only.
   Expect `'combined'`/Smart to be the more stable mode, but do not expect either to be day-stable on
   a plant with many unranked values or many orders with no due date. Not measurable without real due
   dates and real capacity — see audit doc §11.3.
3. **Free-text values.** `prt_01`/`prt_02` are planner-typed TEXT; a misspelled list matches nothing
   and degrades to all-999999 — *appears* configured, does nothing. Coverage is the guard; both
   sides normalize via `Util.norm`.
4. **Resync bumps row versions** — a deliberate action, never a hot path.
5. **PRT ordinal ranks will need re-tuning** when the setup/teardown matrix lands. Seam 3 bounds the
   *code* churn, not the re-tuning.
6. **PRT_02 single-value rework** is accepted, logged debt.

## Pre-ship checks

Do these **before** Stage 1, not after:

1. **How populated `material_plants.color` / `prt_01` / `prt_02` actually are, per plant.** These
   columns were added via the Add Column wizard on 2026-08-07. If they are sparse, Stage 1's
   re-sourcing blanks live color sequencing — and with the guard removed, nothing stops it. This is
   the single most important check. **Not done** — explicitly waived by the user during
   implementation (2026-08-11); still outstanding before applying the migration anywhere real. Two
   ready-to-run queries are in the implementation session's record; someone with local Postgres
   access needs to actually run them.
2. **Whether any plant relies on the global wheel.** Confirm via `GET /diagnostics` rather than
   assuming. `COLOR_FILE` on the pilot is `/data/color_wheel.xlsx`, ephemeral and documented as lost
   on restart, so it is likely already empty. **Not done** — GLOBAL_CW/COLOR_FILE were retired in
   code regardless, per the locked "Default tier: Per-plant only" decision; this check would only
   have added confidence before that irreversible-feeling step, not gated whether to do it.
3. **R10's premise** — whether the `Compute` worker snapshot ships whole task objects. **Done and
   confirmed true** (`Compute._snap()` in `web/schedule-services.mts` sends full `NimbusTask[]`
   objects with no field pruning) — fixed by stripping `PRT_01`/`PRT_02`/`PRODUCTION_VERSION` before
   the `postMessage` structured-clone via a new `_stripPriorityFields` helper.

## Out of scope

- Per-**value** sub-orders and weighted changeover scoring (seam 3 is the entry point).
- **Tool routing** — choosing which PRT an order uses. Needs alternative-tool master data, an
  optimizer that can reassign tooling, and per-tool cost modeling. None exist. Note this is what
  the "material A can run on Dog or Cat, prefer Dog" case actually requires.
- The setup/teardown matrix table itself.
- A Material Plant Production Version table (seam 2 is why waiting is safe).
- Priority fields crossing day boundaries (tool campaigns).
- Retiring `color_wheel` / `/color-wheel/*` / the `ORDER_Y` alias (R17 tracks them).
- Fixing `order-field-catalog.mjs`'s pre-existing declared-but-unwritten fields (R4).

## Cross-cutting findings — lift these out

Discovered during this review but **not specific to this feature**. They belong in the durable docs
so the next person to touch `orders` finds them.

### The `xmin` hazard (general)

`orders.xmin` is the optimistic-concurrency `base_version` surfaced as `ROW_VERSION`
(`db.py:219`). **Any `UPDATE orders` bumps it** — including one that only touches an unrelated
column. The affected ids then return in the `stale` list on the next `POST /tasks/update`, and the
frontend reconciles with **last-writer-loses**: it discards the local edit and refetches server
truth.

So a background or incidental write to `orders` silently destroys planners' unsaved drags. This is
why Material Plant grid edits do **not** propagate to orders here, and why resync is an explicit,
warned action. → belongs in `CLAUDE.md` / `AGENTS.md`.

### `order-field-catalog.mjs` declares fields `db.py` never writes

`web/order-field-catalog.mjs` lists ~10 order fields whose `dbColumn`s the ingest path never
populates (`order_category`, `production_version`, `planned_order_initial_quantity`,
`labor_hours`, … — confirmed by grepping `db.py` for them and finding nothing). The catalog is a
*declaration* layer, so a declared-but-unwritten field renders as a silently blank column. Worth
either reconciling or annotating.

### The inverse ledger trap

`schema.sql` already documents the ×1440 landmine — a data mutation that re-ran on every apply. The
**inverse** is equally dangerous and not yet documented: a ledger-guarded migration that runs
*before* its source data exists records itself as applied and never re-runs, leaving the target
permanently empty. Any ledger-guarded backfill needs an idempotent re-run path (here,
`POST /master-data/resync-order-attributes`) rather than relying on the migration alone.
