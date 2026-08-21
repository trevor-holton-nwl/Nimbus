# NIMBUS Multi-Change Spec — 2026-08-20

**Source:** `Nimbus Mega-Spec document.docx` (repo root, untracked, ~8,900 words, 10 numbered
changes). That file is the untouched original brain-dump; **this document is the spec-of-record.**

**Why this document exists.** The source doc interleaves concerns — one "change" is a destructive
schema rename, another bundles four separate optimizer behaviors — and, checked against the live
code, **eight of its items describe work that is already partly or wholly shipped** while `CLAUDE.md`
and several `docs/` files still say otherwise. Building straight from the .docx would mean
re-implementing existing behavior and mis-scoping the rest.

**Status: pressure-tested.** Every load-bearing claim below has been through an adversarial
refutation pass against the code. **Eighteen claims were tested; seven were refuted or partly
refuted, and three of those invalidated a *recommendation*, not merely a citation.** The verdict log
is in §PT and the divergences from the .docx are in §DR. Where a claim was refuted, the claim *and*
its recommendation were rewritten — not hedged.

**How to read it.** Six workstreams (A–F). Each item states *intent* (from the source), *current
state* (cited), *scope*, and *open decisions*. Every open decision carries a recommended default.

---

## Locked decisions

| Decision | Answer |
|---|---|
| Change #1 migration posture | **Rebuild locally + a one-shot `ALTER … RENAME` for Azure.** `schema.sql` is rewritten with Machine naming and dropped/re-applied locally; a separate **non-idempotent** rename migration is hand-applied exactly once at pilot cutover, so Azure keeps its data and we skip ~30 ledger-guarded blocks. |
| Change #1 rename depth | **DB + API + UI labels**, including all five locale files. Excel upload headers keep accepting the SAP-side `PRODUCTION_LINE` through a mapping shim — we don't control the source spreadsheet. |
| Machine table name | **Singular `machine`** (the .docx's literal "a table called Machine"). |
| `line_*` tables | **Renamed too** → `machine_calendar`, `machine_blackout`, `machine_setup_state`, `labor_plan_machine`. Singular makes the whole family internally consistent. |
| Singular convention scope | **Only what Change #1 touches.** `plants`, `materials`, `orders`, `subnetworks`, `bom_items`, `roles` stay plural. The repo is already mixed; not in scope to fix. |
| Change #2 minimize-changeover objective | **The priority sort *is* the objective.** The setup matrix is respected for **capacity**, never as the primary search term. |
| Change #2 changeover vs lateness | **Ordering unchanged** — priority, then lateness, then setup minutes. Lateness outranking setup *is* "never push a today order to tomorrow to simply benefit a changeover", expressed in the objective function. |
| Change #2 split floor | **Per free-interval, as built** (see PT-7). Scope reduces to unifying the two duplicate 30-minute constants. |
| Change #2 out-of-hours feedback | **Extend the `closed` / `out-of-hours` alerts to unpinned orders** — without this, free placement is silent (see PT-1). |
| Change #2 bounded optimizer | **Parked** as a named future phase — §F2. |
| Change #4 `firming_indicator` → fixed | **Parked** — §F1. Flagged as unusually cheap if pulled back in. |
| Change #5 finite PRT tooling | **Parked entirely — not in this implementation.** Open questions preserved in §F3; no design work. |
| Changes #6/#7 column names | **Unit-suffixed** `visibility_horizon_days` / `frozen_horizon_days`, storing days. A **labelled deviation** from the .docx's literal names (see DR-4). |
| Change #7 enforcement | **Full placement floor at ~8 sites** — nothing may be scheduled into the frozen window (see PT-2; the one-line seam I originally proposed does not exist). |
| Change #8 casing | **Uppercase end-to-end** — but see PT-3: this is a four-layer change, not one `.upper()`. Deliberate deviation from the .docx's "lowercase" (DR-11). |
| Change #9 toggle shape | **Real BOOLEAN, deliberately unregistered, written through a dedicated validated endpoint, surfaced as a checkbox** — the `production_lines.setup_compatible` precedent. A registered BOOLEAN would 500 (PT-4). |
| Change #9 status chip | The "Setup-aware optimization active/inactive" chip **stays in the Setup Matrix header**. Only the checkbox relocates. |
| ERD regeneration | `docs/nimbus-data-model.html` is invalidated wholesale by the rename — regenerating it is a **deliverable of workstream A**. |

---

## Traceability — all 10 source changes

| # | Source title | Workstream | Status |
|---|---|---|---|
| 1 | Change ids — Production Line → Machine | **A** | In scope. ~960 identifier occurrences; touches every file the others do. |
| 2 | Optimization logic | **B1–B4** + **F2** | In scope, split into four items. Final paragraph parked as F2. |
| 3 | Admin tab for viewing all tables | **E** | In scope. Cannot reuse the existing CRUD grid, and the safe-dynamic-SQL pattern doesn't exist yet (PT-6). |
| 4 | Map `firming_indicator` to the fixing | **F1** | **Parked.** The backend half already ships. |
| 5 | Finite PRT_01/PRT_02 inventory capacity | **F3** | **Parked** — explicitly withdrawn from this implementation. |
| 6 | Plant visibility/pagination horizon | **C1** | In scope. |
| 7 | Plant-level "auto-fix" (frozen) horizon | **C2** | In scope. Larger than first drafted (PT-2). |
| 8 | Setup matrix — reclassify inputs as lowercase | **D1** | In scope, **as uppercase**, and four layers deep (PT-3). |
| 9 | Setup matrix UI changes | **D2**, **D3** | In scope, two items: toggle relocation, explicit delete. |
| 10 | Always show derived setup detail | **D4** | In scope. Root cause identified. |

---

## Reconciliation — what the source doc (and our own docs) get wrong

Read this before planning any workstream. Each line is a place where the source asks for something
that already exists, or where our documentation would actively mislead an implementer.

1. **`'combined'` optimizer mode does not exist.** `OptimizerMode = 'spt' | 'changeover' | 'backlog'`
   (`web/types.mts:344`). `CLAUDE.md` and `docs/scheduling_priority.md:306,476,495` describe a
   `'combined'` mode; passing it falls through `Engine._sortTerms`' final `return []`
   (`web/schedule-services.mts:2515`) and silently preserves input order.
2. **Setup already consumes machine capacity — on one path only.** `placeWithSetup`
   (`web/setup-scheduler.mts:244`) reserves the full derived transition before any productive segment,
   and is used by `Engine.autoReflow` (`web/schedule-services.mts:3319`) and every setup-aware
   evaluator. `Engine._dispatchDayIntegrity` (`web/schedule-services.mts:2556-2853`) contains **zero**
   setup references — every duration comes from `Util.runHours`, an unpadded `parseFloat`
   (`web/application-foundation.mts:404-407`). On that path the bar is drawn *backwards from the
   successor's start* (`web/schedule-services.mts:425-426`) and visually overlaps the predecessor.
   **There is also a third dispatcher** — `_dispatchPolicyAware` at
   `web/schedule-services.mts:2860` — which the first draft of this spec never mentioned.
3. **Order splitting is fully built, and its floor applies to every segment.**
   `SplitOrderPolicy = 'never' | 'overlong_only' | 'partial_allowed'` on `plants.split_order_policy`
   (`schema.sql:151`); `MIN_PRODUCTIVE_SEGMENT_MINUTES = 30` (`web/setup-scheduler.mts:34`) is
   enforced on *every* productive segment (`:176`, `:187`, `:190`, `:211`, `:224`, `:300`), not just
   the first. Two caveats that matter: the unit is a calendar **free-interval**, which merges across
   midnight (`normalizedIntervals`, `:136-144`); and a **second, duplicated constant**
   `MIN_SPLIT_SEGMENT_MINUTES = 30` (`web/schedule-services.mts:119`) governs the non-setup-aware
   path via `Calendar.allocateRuntime` (`:1031-1095`).
4. **Free drag placement already works — under the default policy.** With
   `split_order_policy = 'never'` (`web/schedule-services.mts:1863`), a drop commits verbatim at
   `Store.updateTask` (`web/schedule-workbench.mts:6581`) from a `Util.snap` 15-minute grid round
   (`web/application-foundation.mts:208-211`) — no calendar read. The grid editor
   (`web/schedule-workbench.mts:2778-2787`) and Inspector (`:3681-3714`) share that free path, and
   **nothing downstream re-snaps or rejects**: `Store._normalizeDates` grid-rounds only
   (`web/schedule-state.mts:750-778`), and the backend rejects only inverted ranges
   (`brain.py:1573-1622`). *But* split orders are excluded — `_dragRequiresRegeneration` returns true
   whenever `scheduleSegments.length >= 2`, regardless of policy (`:6423-6426`).
5. **`plants.max_pull_forward_days` already exists** (`schema.sql:152`,
   `Engine.earliestAllowedStart` at `web/schedule-services.mts:1869`, UI
   `#sys-max-pull-forward-days`) — half of the bounded optimizer the source asks for. The max-lateness
   half exists only as **unreachable code**: `evaluatorMode = mode === 'spt' ? 'spt' :
   'min-changeover'` (`web/schedule-services.mts:2976`) is the only production call site, so the
   `'throughput'` branch and its `throughputMaxSlipMin: 1440` default literal (`:1848`) cannot be
   selected. (`evaluateThroughput` itself is not dead — it is exercised directly by
   `tests/modules/setup-scheduler.test.mjs:205-246`.)
6. **"I am unable to do any deletions" is a UI gap, not a backend one.**
   `DELETE /setup/{plant}/matrix` exists (`brain.py:2516` → `setup_data.py:329/349`). Deletion today
   is *implicit* — blanking a grid cell becomes a delete via `buildSaveRequests`
   (`web/plant-and-administration.mts:411-431`) — and the `deleteRequest` helper (`:253`) is exported
   with **no call site** anywhere.
7. **Change #10 has a single root cause.** A *covered* transition resolving to 0 minutes pushes
   neither an interval nor a diagnostic (`web/schedule-services.mts:434-436`). The Inspector's
   `hasObservedEntry` gate then blanks all seven rows (`web/schedule-workbench.mts:3376-3382`). The
   card itself is deliberately still rendered — it's just empty. The fix belongs upstream, in
   `deriveSetupObservation`.
8. **Change #8's casing problem spans four conventions, and the decisive one is client-side.**
   `setup_data._normalise_value` (`setup_data.py:67-72`) strips and preserves case. The **matrix
   lookup that actually matters runs in the browser** — `web/setup-domain.mts:26` trims only, and
   `statesEqual` (`:53-57`) compares with case-sensitive `===`. Meanwhile priority-list values are
   uppercased at ingest (`brain.py:826`), `COLOR` is uppercased in the `/tasks` payload
   (`brain.py:1024`) but `PRT_01` / `PRT_02` / `PRODUCTION_VERSION` are not, and the frontend rank
   lookup uppercases separately (`web/setup-scheduler.mts:619`). Result: the grid axis reads `BLACK`
   from data while a hand-typed state stays `Black` — distinct JSONB keys, distinct `setup_matrix` PK
   rows, and a spurious uncovered-transition alert.
9. **`plants.alt_flag_horizon` / `conf_score_horizon` store MINUTES but are labelled "(days)".**
   Defaults 43200 and 20160 (`schema.sql:133-134`); the `column_metadata` labels say "(days)"
   (`schema.sql:480-481`, `:676-677`). Same family as the ×1440 landmine (`schema.sql:166-186`).
   Note these two **are** registered `column_metadata` columns, so a new plant scheduling column would
   not be the first.
10. **`CLAUDE.md` is stale in three ways.** It omits `web/setup-scheduler.mts` (~4,130 lines, where
    nearly all setup-aware optimizer behavior lives), `web/setup-domain.mts`,
    `web/master-data-grids.mts`, and `web/order-field-catalog.mjs`; it describes a `'combined'` mode
    that doesn't exist; and it lists a **`DataIntegrity` module that is not present in `web/` at all**.
    Refreshing it is a workstream-A deliverable.

---

# A. Domain rename: Production Line → Machine

**Intent (Change #1).** Every identifier for the concept "Production Line" becomes "Machine". Data
loss is explicitly acceptable — the DB holds only virtual/test data. A new `workcenter_mapping` table
carries the SAP workcenter, which stops being an attribute and becomes its own relation.

**Acceptance criterion (from the source, verbatim intent):** *"I don't want the swapping out of a
field to delete everything."* Data loss is acceptable; **relationship breakage is not.** Every FK,
generated column, index, unique constraint, registry entry, and wire contract must be intact and
exercised after the rename — that is the pass/fail bar for this workstream, not "the columns are
renamed."

**The asymmetry the source doesn't know about.** Operational tables use a column named
`production_line`; the setup/priority tables use a column named plain **`line`**. Two identifiers,
one concept. Both collapse to `machine`.

### Rename map

| Table (current → new) | Column changes |
|---|---|
| `production_lines` → `machine` | `production_line` → `machine`; `line_key` → `machine_key`; `pl_group` → `wc_group` (OD-A3). Unchanged: `bottleneck`, `excl_optimizer`, `buffer_*`, `setup_compatible`, `setup_compatibility_reason` |
| `line_calendar` → `machine_calendar` | `production_line` → `machine`; generated `line_key` → `machine_key` |
| `line_blackout` → `machine_blackout` | `production_line` → `machine` (stays NULLable = all machines in plant); generated `line_key` → `machine_key` |
| `line_setup_state` → `machine_setup_state` | `line` → `machine` |
| `labor_plan_line` → `labor_plan_machine` | `production_line` → `machine`; generated `line_key` → `machine_key` |
| `labor_plan` | `pl_group` → `wc_group` |
| `orders` | `production_line` → `machine`; `line_key` → `machine_key`. Five indexes rebuild: `schema.sql:63`, `:67`, `:70`, `:240`, `:269` |
| `priority_list` | `line` → `machine` (PK `(plant, machine, field_key)`; `''` still means plant-wide) |
| `setup_matrix` | `line` → `machine` (PK `(plant, machine, signature_version, from_key, to_key)`) |
| `setup_occurrence_override` | `line` → `machine` |
| `material_plants` | `default_workcenter` → `default_machine` (OD-A4) |
| **new** `workcenter_mapping` | `plant`, `machine`, `sap_workcenter` (OD-A5) |

### Effort reality

**~960 identifier occurrences**, counted directly: **244** in `*.py` (`production_line` 118,
`production_lines` 62, `line_key` 25, `pl_group` 14, `default_workcenter` 12, `PRODUCTION_LINE` 13),
**~600** in `web/` (`PRODUCTION_LINE` **342**, `production_line` 109, `production_lines` 57,
`pl_group` 57, `default_workcenter` 35), and **119** in `schema.sql`.

**The migration mechanism is a rounding error against that.** `ALTER TABLE … RENAME` does not remove
a single code edit — `db.py` still says `production_line` in 55 places either way. And "rebuild"
never meant creating a new table and re-pointing references at it: FKs, indexes, and constraints are
*declared* in `schema.sql` and are recreated with the new names automatically.

### The four hard mechanical parts

1. **`machine_key` is a generated column on four tables.** `line_key` is
   `GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || production_line) STORED` on
   `production_lines` (`schema.sql:220-222`), `labor_plan_line` (`:562`), `line_calendar` (`:605`),
   and `line_blackout` (`:632`). Postgres will not rename a column a generation expression
   references, so each needs **DROP + re-ADD**, plus recreation of `uq_lines_line_key` and siblings.
   The expression is duplicated a fifth time at `master_data.py:1692`.
   `orders.line_key` is different: plain `TEXT`, backfilled (`schema.sql:267`), carrying the value
   format `{subnetwork}_{plant}_{machine}` as data.
2. **The rename is a data migration, not just DDL.** `production_lines` is stored as a row *value* in
   `sap_sync_config` / `sap_sync_run` / `sap_field_map.object_key` (`sap_sync.py:53,64`),
   `sap_field_map.nimbus_column` (which stores target column names as data, `sap_sync.py:274-278`),
   and `column_metadata.table_name` (`schema.sql:386,404-409,483-485,679-681`).
3. **`column_metadata`'s JOIN makes a half-done rename look like data loss — confirmed.**
   `master_data._column_meta` (`master_data.py:196-210`) INNER JOINs `column_metadata` against
   `information_schema.columns` on `table_name`; the docstring at `:188-195` says the INNER-ness is
   deliberate. Rename the table and neither name matches → **zero columns**, so the grid becomes
   read-nothing *and* write-nothing (`bulk_apply` derives its writable set from the same call,
   `:733`). `_assert_table` (`:169-171`) errors even earlier off the hardcoded `ALLOWED_TABLES`. And
   `export_schema_sql` iterates `ALLOWED_TABLES` (`master_data.py:1388`) with
   `if not rows: continue` (`:1404-1405`) — a renamed table missing from that set **silently drops out
   of the schema-export recovery path with no error**. The repo already documents this exact failure
   mode twice (`schema.sql:389-398`, `:413-422`). This is the concrete form of the acceptance
   criterion above.
4. **Dual provisioning.** `schema.sql` reaches a prod DB once at provisioning; the
   `master_data.ensure_*` hooks (`brain.py:188-212`) run on **every** redeploy and are authoritative
   for `labor_plan`, `labor_plan_line`, `line_calendar`, `line_blackout`, `plant_blackout`, the
   `plants` extension columns, `material_plants` attributes, and the three `line_key` columns
   (`master_data.py:1680-1696`). A rename applied to only one **silently regresses on redeploy**.

### Wire-format surfaces

| Surface | Location | Decision |
|---|---|---|
| `TaskDTO.PRODUCTION_LINE` | `db.py:330` alias, `brain.py:1163` field, `:1480` emit, `:1460` groupby; **342 uppercase hits in `web/`** | Rename to `MACHINE`. |
| Excel header `PRODUCTION_LINE` | `db.py:2019`, `:2042-2043`; normalize `db.clean()` `:74-83` | **Keep accepting `PRODUCTION_LINE`** via a shim beside the existing `ORDER`→`PRODUCTION_ORDER` / `WERKS`→`PLANT` renames (`db.py:1933-1938`). Also accept `MACHINE`. |
| Body key `production_line` | `brain.py:3422`, `:3475`; consumed `master_data.py:1574,1584,1597,1863` | → `machine`. |
| Body key `pl_group` | `brain.py:3400`; consumed `master_data.py:1501,1511,1522`; returned `:1492` | → `wc_group`. |
| URL segment `/master-data/production_lines` | `brain.py:2785,2798,2805,2821` | → `/master-data/machine`. |
| Response key `line` on blackouts | `master_data.py:1996-1998` already exposes `production_line` as `line` | → `machine`; gets *more* consistent. |
| `/setup/{plant}/...` bodies use `line` | `brain.py:2502,2526,2537,2556,2572` | → `machine`. |

**Order identity survives the rename** — `make_id` is `MD5("{PRODUCTION_ORDER}|{MATERIAL_NUMBER}")`
(`db.py:95-98`), the upsert conflict target is `ON CONFLICT (id)` (`db.py:1458`), and there is **no
UNIQUE constraint on `orders` at all**. But record the adjacent hazard: `upsert_orders` appends a
positional `_<n>` suffix on in-batch id collisions (`db.py:1726-1742`), so when the *same*
order+material appears on two machines, which one keeps the bare id — and therefore the preserved
`scheduled_start` — depends on **row order in the uploaded file**.

**Do not mass-rename blindly:** `brain.py:1031-1036` uses a local variable named `line_key` that is
*not* the DB `line_key` — it's a priority-list scope key holding a `PRODUCTION_LINE` value.

### Deliverables

- `schema.sql` rewritten with Machine naming; local DB dropped and re-applied; test data re-uploaded.
- A dated `migrations/2026-08-__-line-to-machine.sql` — plain, **non-idempotent** `ALTER … RENAME`,
  hand-applied once at Azure cutover.
- `docs/nimbus-data-model.html` regenerated (13 diagram sections, all invalidated).
- `CLAUDE.md` refreshed — Machine vocabulary, the four missing frontend modules, the phantom
  `DataIntegrity` module, and the corrected `OptimizerMode` values.
- All five locale files updated. No new or changed UI string may be hardcoded.

### Open decisions

- **OD-A3 — `pl_group` appears twice.** Both `production_lines.pl_group` (`schema.sql:384`) and
  `labor_plan.pl_group` (`:513`) exist; the source names only the Labor Plan one. *Recommend: rename
  both to `wc_group`.*
- **OD-A4 — `default_machine` semantics.** *Recommend a soft reference to `machine(plant, machine)` —
  validated in the UI, not FK-enforced, matching the other `material_plants` attributes.*
- **OD-A5 — `workcenter_mapping` cardinality. Still open and still blocking table creation.**
  *Recommend PK `(plant, machine)`* — one SAP workcenter per machine per plant. If a machine can map
  to several, the PK becomes `(plant, machine, sap_workcenter)` and every consumer needs a
  disambiguation rule.
- **OD-A6 — Does `wc_group` become an FK to `workcenter_mapping.sap_workcenter`?** *Recommend no —
  pure rename, no semantic change to Labor Planning.*
- **OD-A7 — Worktrees.** Six worktrees carry near-identical duplicates. *Recommend: out of scope —
  rebase or discard, don't mass-rename.*

---

# B. Optimizer & scheduling behavior

**Intent (Change #2).** Four separable behaviors: let planners place orders anywhere; stop
auto-nudging neighbors; make the optimizer produce a day that actually fits, with setup treated as
real machine capacity; and group by the configured priority lists when minimizing changeover.

## B1 — Free manual placement, unconditionally — *plus the alert it needs*

*Current:* free under `split_order_policy = 'never'` for single-segment orders (Reconciliation #4);
calendar-corrected under the other two policies and for any multi-segment order.

*Scope:*
- A manual drag or grid/Inspector date edit always commits verbatim at `Util.snap`, regardless of
  split policy and regardless of segment count.
- **Add the missing feedback.** This is the part the first draft got wrong. Working-hours violations
  are **not** currently alerted for unpinned orders: `fixed-closed`
  (`web/nimbus-compute-core.js:517`) and `fixed-out-of-hours` (`:532`) both open with
  `if (!t.fixed) continue`, and they are the only rules that compare an order's interval against the
  work window. `closed` (`:440`) fires for anyone but requires `cap === 0` — the whole day at zero
  capacity. So today, an unpinned order dragged to Monday 03:00 on an 07:00–19:00 line raises
  **nothing**. Drop those guards so the rules fire for any order. `overlap` (`:366`) and `blackout`
  (`:484`) already do.
- Splitting becomes an optimizer-only outcome.

*Expect an alert wave* on first deploy: any existing schedule already containing out-of-hours work
will light up. That is correct behavior surfacing, not a regression.

*Open decisions:*
- **OD-B1a — Dragging an already-split order.** Current behavior is worse than "regenerates":
  dragging *segment 3* of a 3-day split sets the whole order's first start to that instant
  (`web/schedule-workbench.mts:6514`), and under `never` `manualSchedulePatchFor` flattens it into one
  continuous calendar-ignoring block with `scheduleSegments: []`
  (`web/schedule-services.mts:1906-1913`). *Recommend: shift all segments by the drag delta,
  preserving the split.*

## B2 — Stop auto-de-overlapping siblings

*Current:* `Engine.autoReflow(changedId)` (`web/schedule-services.mts:3268-3390`) walks line peers
sorted by start, pushing each unfixed, non-aged peer to `cursor + resolved setup minutes` via
`Calendar.placeWithSetup`. Exactly four call sites, confirmed exhaustively: Orders-grid cell edit
(`web/schedule-workbench.mts:2791`), Inspector commit (`:3717`), Timeline single-item drag (`:6586`),
Alerts auto-fix (`web/schedule-services.mts:1483`).

*Scope:* strip `autoReflow` from the three manual-edit callers. **Keep** the Alerts quick action — an
explicit, user-invoked repair, which is the model Change #2 describes.

*Two details the first draft missed:* the Alerts action fires for `blackout` alerts as well as
`overlap` (`web/schedule-services.mts:1444`); and a multi-select **resize** (zero delta, same line)
falls through the multi-select branch and *does* reach `autoReflow` at `:6586`. So "multi-drag never
reflows" holds only for real moves.

## B3 — Setup as real capacity, and a day that actually fits

**B3a — Setup consumes capacity on every path.** `_dispatchDayIntegrity`
(`web/schedule-services.mts:2556-2853`) is setup-blind. *Recommend: route all non-`spt` optimization
through the setup-aware evaluator, using a zero-cost matrix when setup is inactive, and retire
`_dispatchDayIntegrity`'s independent placement.* `docs/MIGRATION.md:863` already anticipates this
rewrite. Note the third dispatcher `_dispatchPolicyAware` (`:2860`) must be reconciled in the same
pass. **The real exposure to close:** the gate is
`setupSnapshot && setupSnapshot.plant === plant && setupSnapshot.definition?.active` (`:2975`), so a
plant with setup active *in the DB* but a null or wrong-plant snapshot in `Store` silently falls
through to the setup-blind walk.

**B3b — Missing setup data means 0 minutes, and the warning already renders — verify, don't rebuild.**
`placeUnknownTail` (`web/setup-scheduler.mts:2769`) charges zero minutes purely as a placement
mechanism. Independently, the observation layer already produces the yellow `!` bar: an uncovered
transition pushes a `setup-uncovered` diagnostic (`web/schedule-services.mts:417-422`), rendered as a
`setup-missing` item with a `.setup-missing-marker` `!` glyph over a **synthetic 10-minute span**
(`web/schedule-workbench.mts:713-716`; presentation map `:208-215`; CSS `styles.css:6050-6073`).
*Scope reduces to verification:* confirm the diagnostic survives every dispatch path — in particular
tail-placed orders, whose `MissingSetupEdge` (`web/setup-scheduler.mts:390-395`) surfaces only as a
post-run `Toast` (`web/schedule-services.mts:3023-3045`) — and pin the bar with a test so B3a's
rewrite can't silently drop it.

**B3c — The day must fit, including setup.** Post-optimization, every day's assigned orders plus their
setups must be ≤ that day's capacity. Overflow pushes to the next day — **lateness from capacity is
allowed; lateness to benefit a changeover is not.**

**Split rule — resolved as per-interval.** The floor is already enforced on *every* productive
segment, and it already implements the exact pathology the source describes: `placeWithSetup`
advances to the next free interval when the current one can't hold `setup + 30`
(`web/setup-scheduler.mts:296-305`), so a setup-only day is unconstructible. The unit is a calendar
free-interval rather than a calendar day — intervals merge across midnight (`:136-144`), so a 24/7
line can emit one multi-day segment. **That is accepted:** a merged interval means the order is simply
running continuously, so there is no starved or setup-only day to prevent. Scope reduces to
**unifying the two duplicate constants** (`web/setup-scheduler.mts:34` and
`web/schedule-services.mts:119`) so raising the floor can't be done in one place only.

*Open decisions:*
- **OD-B3a — Retire `_dispatchDayIntegrity` or teach it setup?** *Recommend retire* — one cost-aware
  pass, removing the class of bug where two dispatchers disagree about whether setup costs time.
- **OD-B3b — Make the minimum productive block configurable?** *Recommend: after unifying the two
  constants, expose `plants.min_productive_segment_minutes` (default 30) so a plant can choose 15.*
  Note the existing under-30 whole-order exemption (`web/setup-scheduler.mts:289-294`) must be
  preserved.
- **OD-B3c — Does a resumed segment re-incur setup?** **Already answered by the code: no.**
  `placeWithSetup` emits at most one setup interval per call (`:263-274`) and the persisted patch
  anchors `start_date` to the first productive segment (`:1571`). Keep it that way.
- **OD-B3d — May setup straddle a shift close?** `docs/MIGRATION.md:870-873` records this as
  deferred and as the blocker on a real setup/teardown split. *Recommend: contiguous, inside working
  hours — matching `placeWithSetup` today.*

## B4 — Changeover grouping by the configured priority lists

**Locked: the priority sort is the objective.** The priority ordering *is* the changeover
minimization — grouping all blacks together is what avoids the changeover. The setup matrix is
respected for capacity (B3a) but is never the primary search term.

*Current — and this is where the first draft was least accurate:*

- **Setup-inactive path: a pure comparator, no search.** `seqCompare`
  (`web/schedule-services.mts:2655-2660`) iterates `tieBreakTerms` — which *is*
  `Engine._sortTerms('changeover', { plant })` (`:2958`, passed at `:3171`) — then due date, then id.
  Nothing counts or minimizes changeovers anywhere; attribute grouping is an emergent side effect.
- **Setup-active path: it genuinely searches.** `evaluateMinChangeover`
  (`web/setup-scheduler.mts:4009`) runs an exact DFS over state-group interleavings when there are
  ≤8 groups (`:1820-1873`, bounded by a 20,000-iteration cap and a 5 s deadline), otherwise an
  adjacent-swap hill-climb seeded by the policy sort (`:1877-1998`).
- **Priority is more dominant than "tie-break".** In `compareCandidate` (`:1341-1370`) the comparison
  order is: hard constraints (`score[0]`) → **`policyKey`** → uncovered-edge count → then the
  mode-permuted `terms`, which for `min-changeover` is `[2, 3, 5, 4]` — late count, lateness minutes,
  **then** setup minutes. So setup minutes are the **sixth** tier overall. In the greedy path it's
  starker still: the seed is already `policyKey`-sorted, so any swap that changes `policyKey` is
  rejected (`:1976`) and only orders with *identical* rank vectors can ever be reordered.

*Consequence to state plainly in any planning doc:* **"min-changeover" barely minimizes changeovers
today, and that is the intended trade-off.** Lateness outranking setup savings is exactly the "never
push a today order to tomorrow to simply benefit a changeover" rule expressed in the objective.
`docs/MIGRATION.md:866-869` predicted this would surface as a policy question; the answer is
"leave it".

*Scope:* make the priority sort hold **inside** the setup-aware evaluator, unify the two priority
sources (below), and pin the ordering with tests. Not new sorting logic.

**Two screens feed the priority order — the source doc conflates them, and so did this spec:**

| Screen | Configures | Consumed by |
|---|---|---|
| Plant → **System Settings** → "Scheduling Constraints" (`#sys-constraints-list`, `web/plant-and-administration.mts:3019`) | *Which fields* sequence, and in what nested order → `plants.constraints` | `Engine.activeConstraintKeys` → `flattenConstraints` → `constraintsFor` (`web/schedule-services.mts:2325`, `:2265`, `:2183`) |
| Plant → **Optimization** (`web/index.html:1694`, `Plant._renderOptimization` at `web/plant-and-administration.mts:2581`) | *Which values rank first* within a field → uploaded priority lists / color wheel | `Store.priorityRankMaps` → `_sortTerms` (`:2480-2505`), `rankForTask` (`web/setup-scheduler.mts:650-664`) |

The source's "priorities provided in the optimization tab" means the **uploaded rank lists**. Both
screens are load-bearing and neither substitutes for the other.

---

# C. Planning horizons

## C1 — Plant visibility horizon (Change #6)

**Intent.** A plant-level field gating how far into the future a planner can see, on both the Gantt
and the Orders tab. The far edge runs to midnight and advances a whole day at a time (at ~19:00 UTC),
so the horizon doesn't creep minute-by-minute.

*Current:* nothing like it exists. The Gantt renders every task with dates, unbounded
(`web/schedule-workbench.mts:808-809`); its only temporal limits are zoom bounds (`:316-317`). The
Orders grid's `dateKey` filter matches a **single exact day** (`:2731-2734`), not a range.

*Scope:*
- New `plants.visibility_horizon_days INTEGER` (NULL = unlimited) and
  `plants.horizon_roll_hour_utc INTEGER NOT NULL DEFAULT 19`.
- Window end = plant-local midnight of `anchor_day + visibility_horizon_days`, where `anchor_day`
  advances when UTC passes `horizon_roll_hour_utc`.
- Gantt: clamp the vis-timeline `max` option; do not clamp the past edge.
- Orders grid: hide rows beyond the window.
- Server-side enforcement on `GET /tasks`, so the horizon bounds the payload, not just the view.
- Surfaced in the plant Scheduling Rules panel.

**Three implementation facts the first draft got wrong:**

1. **The gating expression is a three-way coalesce, not two-way.** `GET /tasks` reports
   `COALESCE(seg.first_start, scheduled_start, basic_start_date) AS "BASIC_START_DATE"`
   (`db.py:332`), sourced from the `order_schedule_segments` LATERAL (`db.py:194-214`) and matching
   the `ORDER BY` at `:402`. Filtering on `scheduled_start`-then-`basic_start_date` would disagree
   with the date the row actually reports for any split order.
2. **`meta.total` comes from a second, duplicated WHERE builder.** `db.count_orders`
   (`db.py:416-435`) is a separate `SELECT COUNT(*) FROM orders o` with **no segments lateral**, and
   it is only invoked when paging (`paging = limit is not None or offset is not None`,
   `brain.py:1420`). Add the bound to one builder and not the other and the totals lie.
3. **Indexing.** `idx_orders_line_eff_start` (`schema.sql:70`) covers the *two*-way coalesce only;
   there is no index on the three-way expression and no `(plant, effective_start)` composite — so a
   plant-scoped, date-bounded query still scans the plant's rows.

**Also record:** a horizon truncates the finish-to-start link chain built at `brain.py:1460-1510` —
the same incoherence the docstring already warns about for `limit`/`offset` (`:1408-1409`).

*Open decisions:*
- **OD-C1b — Which expression gates a row?** *Recommend the same three-way coalesce the endpoint
  already reports*, and add the segments lateral to `count_orders` so both agree.
- **OD-C1c — Plant-local midnight with a UTC roll hour?** *Recommend yes* — deliberate, but the two
  clocks disagree for most plants, so confirm.
- **OD-C1d — Orders starting inside but ending outside.** *Recommend include* (gate on start).
- **OD-C1e — Hide, or merely block scrolling?** *Recommend hide* on both surfaces, else the Orders
  tab and the Gantt disagree about what exists.

## C2 — Plant frozen horizon (Change #7)

**Intent.** A plant-level window inside which the optimizer will not touch orders, drawn on the Gantt
as a darker green band over the existing alert-horizon band.

*Current:* the band it layers over is `.vis-item.alert-horizon-zone` (`styles.css:1177`) — **one
background item per visible line**, not one band across the chart — built in `Timeline.rebuild`
(`web/schedule-workbench.mts:920-943`) from `plants.alt_flag_horizon`, tracked in
`Timeline._alertHorizonIds` (`:260`) and re-advanced every second (`:378-395`). Prior art: a "frozen
fence" was designed and declined as an *Optimize-dialog* setting (`docs/MIGRATION.md:839`).

**Corrected mechanism — this is the largest single correction in this document.** The first draft
proposed reusing `bounds.notBefore` as a one-line floor. **That seam does not exist.** `notBefore` is
bound to `Engine.earliestAllowedStart(task, plant)` (`web/schedule-services.mts:2986`, `:1869-1878`)
and is:
- **per-order**, derived from that order's own SAP due date minus `max_pull_forward_days`;
- **`null`** when the plant setting is unset *or when the order has no due date* (`:1871`, `:1873`);
- read in only **two** places (`web/setup-scheduler.mts:1413`, `:2813`), where it merely raises a
  local cursor, and documented as optional — "absent retains detached legacy behavior" (`:356`).

Every other placement path bypasses it: the legacy walk calls `earliestAllowedStart` directly
(`web/schedule-services.mts:2597`, `:2623`, `:2635`, `:2644`, `:2876`, `:3197`), `autoReflow` passes
no floor (`:3319`, `:3363`), `Calendar.placeWithSetup` and `Calendar.allocateRuntime` never see one,
and all manual paths ignore it.

*Scope (locked: full placement floor):*
- New `plants.frozen_horizon_days INTEGER` (NULL/0 = off), in the Scheduling Rules panel.
- An order whose start falls inside the window is treated as implicitly pinned — same effect as
  `Store.isFixed`, but a distinct reason so the UI can explain *why* it didn't move.
- **Nothing may be scheduled into the window.** A single shared floor helper, applied at all ~8
  placement sites listed above. Budget for this explicitly — it is not a one-line change.
- Timeline: a `.frozen-horizon-zone` background item per visible line, layered above
  `.alert-horizon-zone`, on the same one-second ticker via a `Timeline._frozenHorizonIds` list.

*Open decisions:*
- **OD-C2a — Straddling orders.** *Recommend: frozen iff the order's **start** is inside* (consistent
  with OD-C1d).
- **OD-C2c — Does frozen block manual drags?** *Recommend no* — it constrains the optimizer only.
  The planner is always free to move things (B1).

---

# D. Setup matrix: hygiene, controls, transparency

## D1 — One canonical case (Change #8, resolved as uppercase)

**Intent.** Stop `Black` / `black` / `BLACK` behaving as three values, and stop the false alert
"there is an error because Black doesn't have setup for BLACK."

**Corrected scope — "add `.upper()` to one function" was wrong.** All four sub-items are required:

1. **Python.** `setup_data._normalise_value` (`setup_data.py:67-72`) gains the fold. Its only caller
   is `canonical_state_key` (`:92-102`), which all server-side write paths route through: matrix
   import (`:156-157`), `line_setup_state` (`:405`, `:470`), override state keys (`:524-525`).
   **Boolean values must be exempted** — `_normalise_value` emits `"true"`/`"false"` (`:70-71`), and
   folding those to `"TRUE"`/`"FALSE"` breaks both stored keys and the TS side's `String(true)`.
2. **The client, which is where the decisive comparison happens.** `web/setup-domain.mts:26` trims
   only; `statesEqual` (`:53-57`) compares case-sensitively with `===`, feeding `matchingMatrixRow`
   (`:63-78`) and `stateForOrder` (`:132-138`). A Python-only fold would make **every lookup miss**.
   Fold here too — and note `web/setup-scheduler.mts:619` already uppercases for rank lookups, a
   fourth convention to converge.
3. **The raw-JSON read bypass.** `brain.py:2437` `json.loads` a query-string value and hands it to
   `setup_data.page_matrix_rows`, which compares it byte-wise against stored JSONB
   (`setup_data.py:828-830`) with no canonicalization. Route it through `canonical_state_key`.
4. **Ingest parity.** `brain.py:826` uppercases priority-list values and `:1024` uppercases `COLOR`,
   but `PRT_01` / `PRT_02` / `PRODUCTION_VERSION` are **not** uppercased. Fold all four.

**Backfill.** The JSONB keys sit *inside* primary keys — `setup_matrix` (`schema.sql:1036`),
`line_setup_state` (`:1055`), `setup_occurrence_override` (`:1084`) — so existing mixed-case rows
survive as unreachable duplicates without a migration. Needed for Azure even though workstream A
rebuilds locally.

**Identifiers are not folded.** `_required_text` (`setup_data.py:24-27`) keeps plant / machine / actor
case-sensitive. The complaint is about attribute *values*.

The false alert disappears as a consequence, not as a separate fix.

*Open decision:*
- **OD-D1a — Backfill collisions.** `Black`→`BLACK` can collide with an existing `BLACK`.
  *Recommend: keep the most recently updated row, log discards to `admin_audit`, report a count* —
  silent loss here is a scheduling-correctness bug.

## D2 — Move the "Include setup times in optimizer" toggle to the plant level (Change #9)

*Current:* the checkbox lives in the **Setup Matrix header** — Plant → Settings → Setup Matrix, at
`web/plant-and-administration.mts:834`, gated on `permissions.definitionWrite` — and writes
`setup_definition.active` via `PUT /setup/{plant}/active` (`brain.py:2376`).

**Note the source doc's premise is factually wrong:** Change #9 says to move the toggle "away from
the Master Data Tables", but it has never been in a Master Data table. That matters for reading "the
Plant Tables" — see OD-D2a.

**Corrected scope — three things the first draft understated:**

1. **A registered BOOLEAN would 500, not merely render oddly.** The Master Data grid renders every
   editable cell as a `contentEditable` div emitting `textContent`
   (`web/plant-and-administration.mts:5806`), with no per-type editor, and `bulk_apply` passes values
   through uncoerced (`master_data.py:793`). A blank BOOLEAN cell sends `""` → Postgres `22P02`,
   which is **not** in `db._SQLSTATE_ERROR_CODES` (`db.py:109-117`) → generic 500. `"X"` fails too.
   **Locked: real BOOLEAN, unregistered, dedicated validated endpoint, surfaced as a checkbox** —
   exactly the `production_lines.setup_compatible` precedent (`schema.sql:1002`,
   `master_data.py:1105-1135`, `brain.py:2556-2570`).
2. **`active` is not the only gate.** `production_lines.setup_compatible` also gates, **per line**
   (`schema.sql:1002`; consumed `web/setup-scheduler.mts:2255`, `:3734`, `:3887`), and the
   snapshot-identity check `setupSnapshot.plant === plant` (`web/schedule-services.mts:2975`)
   disables setup as hard as `active=false`. A plant-level flag does not subsume either.
3. **Eight backend sites, and one non-obvious invariant.** `save_definition` **force-writes
   `active=FALSE` on a signature-version bump** (`setup_data.py:256-278`) — moving the flag to
   `plants` turns that into a cross-table write. The flag is also embedded in the cached
   `Store.setupSnapshot` payload (`brain.py:2401` → `web/schedule-state.mts:57`), so the migration
   changes `SetupSnapshot.definition`'s shape and every reader of it. Also worth knowing: **no
   backend path gates on `active` at all** — the optimizer is client-side; the backend only stores
   and serves the flag.

The status chip **stays in the Setup Matrix header** (locked), still driven by `activationStatus`'
four reasons.

*Open decision:*
- **OD-D2a — Resolved: do not register it in the grid.** The source's "binary X vs. Blank in the
  Plant Tables" wording came from a mistaken belief about where the toggle lives (above). Combined
  with the 500 hazard and the `setup_compatible` precedent, the checkbox-plus-endpoint shape is
  correct. Record the deviation from the literal ask.

## D3 — Explicit setup-matrix deletion (Change #9)

*Current:* backend done — `DELETE /setup/{plant}/matrix` (`brain.py:2516`) →
`delete_line_matrix_rows` / `delete_plant_matrix_rows` (`setup_data.py:329/349`). No UI affordance;
deletion is implicit via blanking a cell, and the exported `deleteRequest`
(`web/plant-and-administration.mts:253`) has no call site.

*Scope:* explicit per-row delete plus multi-select bulk delete in `SetupAdmin`, wired to
`deleteRequest`. New i18n keys in all five locale files. Verify the operation lands in the admin audit
map (`brain.py:584-591`).

*Open decision:*
- **OD-D3a — A scope-level "delete all rows"?** *Recommend yes, behind a typed confirmation* —
  plant-scope import is already destructive (`replace_plant_matrix`, `setup_data.py:303-314`), so the
  capability exists today only as a side effect of uploading.

## D4 — Always populate the derived setup detail (Change #10)

*Current:* a covered 0-minute transition pushes neither an interval nor a diagnostic
(`web/schedule-services.mts:434-436`); the Inspector's `hasObservedEntry` gate
(`web/schedule-workbench.mts:3376-3382`) blanks every row to `—` (`:3440`). The card is deliberately
still rendered — just empty.

*Scope:* in `deriveSetupObservation`, a covered 0-minute transition still records an observation
carrying predecessor id, predecessor state, successor state, required/effective/standard minutes (all
0), and source — but **no interval**, so no bar is drawn and nothing consumes capacity. The Inspector
then populates with no change to its gate.

**Note the field count.** The source lists **six** fields; the Inspector renders **seven**
(`web/schedule-workbench.mts:3538-3544`) — the seventh being `ui.setup_override`. *Recommend: Override
shows an explicit "none" state on a no-change transition rather than the `—` placeholder, so an empty
value is distinguishable from an unknown one.*

**The distinction this makes explicit** (and which D1 depends on):

| Situation | Minutes | Bar | Alert | Detail rows |
|---|---|---|---|---|
| Identical predecessor signature, covered | 0 | none | none | **fully populated** |
| Different signature, no matrix row | 0 | yellow `!` (already renders, B3b) | yes | fully populated |

Both are zero minutes; they are not the same state.

*Open decision:*
- **OD-D4a — Source label for a no-change transition.** *Recommend a new `ui.setup_source_no_change`
  key in all five locales*, rather than reusing a matrix-source label that would imply a matrix row
  was consulted.

---

# E. Admin UI: universal table browser & export (Change #3)

**Intent.** An audit-oriented tab showing every NIMBUS table in tabular form, new tables appearing
automatically. SE16-like: filter using **a primary key or foreign key as input**, multi-select with
paste, clear all inputs, and a pasted value that doesn't exist returns nothing rather than erroring
the query. Per-table CSV export of all columns and rows, with a sensible row limit and a sane way to
get the rest. **"As close to an Excel grid view as possible without being too poor"** — i.e. AG Grid,
not an HTML table.

*Current — and why nothing here can simply be extended:*
- `master_data.ALLOWED_TABLES` is a hardcoded 8-table `frozenset` (`master_data.py:29-33`) gating an
  **editable** CRUD surface; `orders` is excluded on purpose (`schema.sql:493-504`).
- `MasterData` (`web/plant-and-administration.mts:5394`) shows 6 tables, has **no pagination**
  (explicit comment at `:5430-5433`), **no CSV export**, and one naive whole-row substring filter
  (`_applyFilter`, `:6281`).
- **The safe-dynamic-SQL pattern this needs does not exist yet.** `db._get_maint_table_allowlist`
  (`db.py:1404-1416`) *is* catalog-derived (`pg_stat_user_tables`) but is a **process-global cache** —
  a table created after startup stays invisible until restart — and it does **not** use
  `sql.Identifier`: `db.py:1432` and `:1443` are bare f-strings. The genuine `Identifier` discipline
  lives in `master_data.py` (`:266-299`, `:738-791`) but its allowlist is the hardcoded frozenset.
  **E composes the two for the first time**, which is real design work, not copying a precedent.

*Scope:*
- New **read-only** surface, deliberately separate from `ALLOWED_TABLES`.
- Per-request catalog discovery (not a process-global cache) so a new table appears with no code
  change and no restart. System tables (`schema_migrations`, `admin_audit`, `column_metadata`,
  `sap_sync_*`) shown but flagged as internal.
- New endpoints: `GET /admin/tables`, `GET /admin/tables/{table}` (paginated rows + column metadata),
  `GET /admin/tables/{table}/export.csv` (streaming).
- Identifier safety: allowlist from the catalog **per request**, then `psycopg.sql.Identifier`.
- Filtering: **PK and FK inputs are first-class and required** — multi-value, paste-aware (split on
  newline/comma/tab), clear-all, unmatched values simply not matching. Other columns are a secondary
  nicety. Reuse the `MaterialGrids` filter model (`web/master-data-grids.mts:25`,
  `FilterMode = 'checklist' | 'bigset'`) — the one real precedent, and it's AG Grid.
- Pagination: server-side `limit`/`offset` with a total, mirroring `GET /tasks`' `meta.total`.
- Placement: a 6th `data-sub` tab in `web/index.html:1796-1801` plus a branch in
  `AdminCockpit.render()`.

*Open decisions:*
- **OD-E1 — Export cap.** *Recommend streaming server-side CSV, soft cap ~250k rows, with an explicit
  "truncated at N — resume from offset N" affordance*, never a silent cut.
- **OD-E2 — Per-user plant scoping.** Every sibling admin route honors `_assert_plant_allowed`; a
  catalog-wide browser is cross-plant by nature. *Recommend admin-only and unscoped*, gated by the
  same `NIMBUS_API_KEY`/role check — recorded explicitly because it is a data-exposure decision.
- **OD-E3 — Truly read-only?** *Recommend yes.* Read-only is what makes catalog-wide auto-discovery
  safe; editing is what `MasterData` is for.

---

# F. Parked

Recorded so nothing from the source is lost. **No design or implementation work in this round.**

## F1 — `firming_indicator` → fixed (Change #4)

Parked per the scope call. Worth knowing how cheap it is: `FIRMING_INDICATOR` (SAP FIXKZ) is already
ingested (`db.py:2026`), stored (`schema.sql:52`), served (`db.py:345`), and already exposed as a
boolean — `brain.py:1494` computes `"firmed": row.get("FIRMING_INDICATOR") == "X"`, declared as
`TaskDTO.firmed` (`brain.py:1177`). `docs/MIGRATION.md:838` notes it is "currently read nowhere in the
optimizer." The only missing piece is wiring `firmed` into `Store.isFixed`.

*Open question if revived:* does a re-upload overwrite a planner's manual pin, and does the resulting
`UPDATE orders` bump `xmin` and make in-flight edits come back `stale`?

## F2 — True bounded minimize-changeover (Change #2, final paragraph)

Parked as a named future phase. `plants.max_pull_forward_days` (`schema.sql:152`) is the pull-forward
bound the source asks for. The max-lateness bound exists only as **unreachable** code —
`throughputMaxSlipMin: 1440` (`web/schedule-services.mts:1848`) feeds the `'throughput'` evaluator,
which `evaluatorMode` at `:2976` can never select.

*Open questions if revived:* where the max-lateness bound lives (plant column, per-order, or Optimize
dialog); hard constraints or scored penalties; heuristic or real solver. Note the existing
`min-changeover` search (B4) is already an exact DFS for ≤8 state groups — a bounded solver would
extend that machinery, not start from nothing.

## F3 — Finite PRT_01 / PRT_02 tooling capacity (Change #5)

**Explicitly withdrawn from this implementation.** Intent preserved: PRT_01 and PRT_02 are tooling;
inventory is limited, so four machines needing one tool cannot all run it simultaneously; the
constraint would be enforced at day granularity only.

*Current state, for whenever this returns:* `prt_01` / `prt_02` are bare `TEXT` on `material_plants`
(`schema.sql:424-425`), materialized onto `orders` (`:962-963`). **No tooling inventory table
exists.** The only physical-tooling column anywhere is `line_setup_state.physical_mold_id`
(`schema.sql:1048`) — one current-mold id per plant/machine, no quantity, no catalog, no FK.
`docs/MIGRATION.md:361-363` notes PRT_02 was always intended to become a production-version-keyed
relation.

*Open questions preserved:* the counting rule (distinct machines per tool per day vs. distinct orders
vs. counting remounts); shared catalog vs. two namespaces; per-plant vs. global inventory; which order
loses when a day is infeasible; hard constraint or alert-only.

---

# PT — Pressure-test log

Eighteen load-bearing claims tested adversarially against the code. **Seven refuted or partly
refuted.** The three marked ⚠ invalidated a recommendation, not just a citation.

| ID | Claim as first drafted | Verdict |
|---|---|---|
| PT-1 ⚠ | Working-hours violations become alert conditions for unpinned orders | **REFUTED** — `fixed-closed` (`nimbus-compute-core.js:517`) and `fixed-out-of-hours` (`:532`) both `if (!t.fixed) continue`; `closed` (`:440`) needs `cap === 0`. B1 gained the alert-guard work. Bonus: `near-capacity` (`:433`) is permanently dead behind `SHOW_NEAR_CAPACITY_ALERTS = false` (`:42`) |
| PT-2 ⚠ | `bounds.notBefore` is a general floor a frozen horizon can reuse | **REFUTED** — per-order, due-date-derived, `null` without a due date, two consumers, every other path bypasses it. C2's mechanism replaced with a ~8-site floor |
| PT-3 ⚠ | Adding `.upper()` to `_normalise_value` folds all setup values | **REFUTED** — the decisive comparison is client-side (`setup-domain.mts:26`, `:53-57`); `page_matrix_rows` compares raw JSON; three ingest fields un-uppercased; booleans would break; JSONB keys sit inside PKs. D1 became four layers plus a backfill |
| PT-4 | `include_setup_times` as a registered BOOLEAN, X/blank in the grid | **PARTLY REFUTED** — a blank BOOLEAN cell 500s (`22P02` absent from `db._SQLSTATE_ERROR_CODES`). Also miscounted "five" then listed six, and `alt_flag_horizon`/`conf_score_horizon` are already registered. OD-D2a reversed |
| PT-5 | `setup_definition.active` is the only gate; four readers | **REFUTED** — `setup_compatible` also gates per-line; snapshot-identity also gates; eight backend sites; `save_definition` force-deactivates on signature bump; embedded in a cached payload |
| PT-6 | A catalog-allowlist + `sql.Identifier` precedent exists to copy | **REFUTED** — the catalog allowlist is process-cached and uses bare f-strings (`db.py:1432`, `:1443`); the `Identifier` pattern uses a hardcoded allowlist. E composes them for the first time |
| PT-7 | The 30-minute floor guarantees productive time on every **day** | **PARTLY TRUE** — every *segment*, but the unit is a free interval that merges across midnight (`setup-scheduler.mts:136-144`). Accepted as satisfying intent; a second duplicate constant found at `schedule-services.mts:119` |
| PT-8 | `_dispatchDayIntegrity` is setup-blind, `2556-2905` | **CONFIRMED**, range corrected to `2556-2853`; `2860-2905` is a **third dispatcher**, `_dispatchPolicyAware` |
| PT-9 | `'throughput'` is unreachable dead code | **CONFIRMED** (`:2976`), with the precision that `evaluateThroughput` itself is test-exercised |
| PT-10 | Setup is never re-charged on a resumed segment | **CONFIRMED** (`setup-scheduler.mts:263-274`, `:1571`) |
| PT-11 | Exactly four `autoReflow` call sites; multi-drag never reflows | **CONFIRMED**, plus: it also fires for `blackout` alerts, and a multi-select **resize** does reach `:6586` |
| PT-12 | Renaming a table hides its columns; `export_schema_sql` drops it silently | **CONFIRMED** (`master_data.py:196-210`, `:1388`, `:1404-1405`) |
| PT-13 | Order identity is line-independent | **CONFIRMED**, with the `_<n>` in-batch dedupe caveat (`db.py:1726-1742`) now recorded |
| PT-14 | Priority order comes from the constraint tree | **CONFIRMED for the tree**, but the spec conflated two screens — see DR-3 |
| PT-15 | Within-day sequence is a priority sort, not a search | **PARTLY TRUE** — correct for the setup-inactive path; the setup-active path genuinely searches (exact DFS ≤8 groups, else hill-climb), with `policyKey` as objective tier 2 and setup minutes only sixth |
| PT-16 | `GET /tasks` can cleanly gain a date-horizon filter | **PARTLY TRUE** — duplicated `count_orders` builder, `meta.total` only when paging, three-way vs two-way coalesce mismatch, no supporting composite index, link-chain truncation |
| PT-17 | Setup already consumes capacity on setup-aware paths | **CONFIRMED** (`setup-scheduler.mts:244`) |
| PT-18 | The yellow `!` bar already renders for uncovered transitions | **CONFIRMED** (`schedule-services.mts:417-422` → `schedule-workbench.mts:713-716`), over a synthetic 10-minute span |

---

# DR — Drift from the source document

Where this spec and the .docx differ, and why. The three marked **deviation** are deliberate and must
not be silently "fixed" back.

| ID | Drift | Resolution |
|---|---|---|
| DR-1 | Spec applied the split floor to the **first** day; .docx says "each day" | Per-interval semantics accepted as satisfying the intent (PT-7); stated explicitly rather than glossed |
| DR-2 | .docx defines minimize-changeover twice — "sort of priorities" *and* "sequence in such a way that minimizes changeover"; spec captured only the first | Resolved: the priority sort **is** the objective. B4 rewritten to say so, and to state that setup minutes rank sixth today |
| DR-3 | .docx says priorities come from "the optimization tab"; spec sourced them from `plants.constraints` | **Both screens are real and distinct** — see the table in B4. Plant → Optimization holds the uploaded rank lists; System Settings → Scheduling Constraints holds the field tree. The spec no longer conflates them |
| DR-4 | Spec renamed `visibility_horizon` / `plant_frozen_horizon` to `*_days` | **Deviation.** Taken because the two existing horizon columns store minutes behind "(days)" labels — the ×1440 landmine's cause |
| DR-5 | Spec used plural `machines`; .docx says "a table called Machine" | Fixed — singular `machine`, and the whole `machine_*` family follows |
| DR-6 | .docx: "I don't want the swapping out of a field to delete everything" — captured only implicitly | Now an explicit workstream-A **acceptance criterion**: data loss acceptable, relationship breakage not |
| DR-7 | Change #9's premise is wrong — the toggle is not in Master Data Tables (`plant-and-administration.mts:834`) | Flagged in D2; combined with PT-4 it resolves OD-D2a to *not* registering the column |
| DR-8 | Change #10 lists **six** fields; the Inspector renders **seven** (`schedule-workbench.mts:3544`) | D4 now specifies Override's behavior on a no-change transition |
| DR-9 | .docx: "As close to an excel grid view as possible" — never captured | Added to E: AG Grid, with `MaterialGrids` as the precedent |
| DR-10 | .docx scopes Change #3's filters to "a Primary Key or Foreign Key as input"; spec generalised to per-column | **Deviation, narrowed.** PK/FK first-class and required; other columns secondary |
| DR-11 | .docx asks **lowercase**; we locked **uppercase** | **Deviation.** Chosen for least churn against the three ingest sites that already uppercase |

---

# Unrelated cleanups found on the way

Not part of any workstream; recorded so they aren't lost.

- **Hardcoded English in the Inspector.** The setup action buttons "Correct actual setup state" and
  "Adjust setup time" (`web/schedule-workbench.mts:3547`) bypass `data-i18n`/`t()`, against the
  standing rule that all UI text is localized.
- **`CLAUDE.md` documents a module that doesn't exist.** `DataIntegrity` appears in the
  Infrastructure layer table; there is no such file or symbol anywhere in `web/`.
- **Dead alert rule.** `near-capacity` can never fire —
  `const SHOW_NEAR_CAPACITY_ALERTS = false` (`web/nimbus-compute-core.js:42`) is a hardcoded literal.
- **Bare f-string DDL.** `db.py:1432` (`VACUUM ANALYZE {t}`) and `:1443` (`ANALYZE {table}`) build
  statements by interpolation. Allowlisted today, but the odd ones out against the
  `psycopg.sql.Identifier` discipline used in `master_data.py`.
- **Stale-by-design `plants` columns.** `setup_policy_config` and `setup_release_evidence`
  (`schema.sql:162-165`) have zero Python and zero `.mts` readers — their endpoints were deleted when
  the `active` checkbox replaced them (`docs/Setup_matrix_redesign.md`). Candidates to drop.

---

# Recommended implementation sequence

| Order | Workstream | Why here |
|---|---|---|
| 1 | **A** — rename | ~960 identifier occurrences touching every file the others do. Doing it first avoids renaming freshly written code. |
| 2 | **D** and **E** in parallel | Independent of each other, and D1/D4 make setup data trustworthy before B makes setup a hard capacity constraint. E shares no code with the rest — but is larger than first drafted (PT-6). |
| 3 | **C** — horizons | C1 is contained and additive. C2 is now a ~8-site change (PT-2) and touches the same placement paths as B, so land it before B rather than concurrently. |
| 4 | **B** — optimizer | Riskiest. B3a is an architectural decision (OD-B3a) and benefits from correct setup data (D1), honest setup detail (D4), and the frozen-window floor (C2) already being in place. |

---

# Consolidated open decisions

Each has a recommended default above; none blocks starting work, except OD-A5 which blocks creating
one table.

| ID | Decision | Recommendation |
|---|---|---|
| **OD-A5** | `workcenter_mapping` cardinality — one workcenter per machine? | PK `(plant, machine)` — **needs a real answer before the table is created** |
| OD-A3 | `pl_group` exists on two tables — rename both? | Yes, both → `wc_group` |
| OD-A4 | `material_plants.default_machine` — FK to `machine`? | Soft reference, validated not enforced |
| OD-A6 | `wc_group` becomes an FK to `sap_workcenter`? | No — pure rename |
| OD-A7 | Worktrees in scope for the rename? | No — rebase or discard |
| OD-B1a | Dragging an already-split order | Shift segments by delta; today it flattens the split entirely |
| OD-B3a | Retire `_dispatchDayIntegrity` or teach it setup? | Retire — one cost-aware pass; reconcile `_dispatchPolicyAware` too |
| OD-B3b | Configurable minimum productive block? | Unify the two constants first, then expose `plants.min_productive_segment_minutes` (default 30) |
| OD-B3d | May setup straddle a shift close? | No — contiguous, inside working hours |
| OD-C1b | Which expression gates an Orders row? | The three-way coalesce the endpoint already reports; add the segments lateral to `count_orders` |
| OD-C1c | Plant-local midnight with a UTC roll hour? | Yes — deliberate, worth confirming |
| OD-C1d | Orders starting inside but ending outside | Include (gate on start) |
| OD-C1e | Hide beyond-horizon orders, or just block scrolling? | Hide, on both surfaces |
| OD-C2a | Frozen-window straddling orders | Frozen iff start is inside |
| OD-C2c | Does frozen block manual drags? | No — optimizer only |
| OD-D1a | Uppercase-backfill PK collisions | Keep most recent, log discards to `admin_audit`, report a count |
| OD-D3a | A scope-level "delete all matrix rows" action? | Yes, behind typed confirmation |
| OD-D4a | Source label for a no-change transition | New `ui.setup_source_no_change` key, all 5 locales |
| OD-E1 | Export row cap and overflow handling | Streaming CSV, ~250k soft cap, offset-resume affordance |
| OD-E2 | Does the table browser honor per-user plant scoping? | Admin-only and unscoped — **explicit data-exposure call** |
| OD-E3 | Read-only? | Yes — read-only is what makes auto-discovery safe |
