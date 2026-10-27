# Setup matrix: default changeover by value ("value defaults")

> **Status (2026-10-27): design settled, nothing built.** Design rev. 3: rev. 2 (builder check + seven read-only Sonnet verifiers) amended after a three-reviewer double-check against live code that corrected the activation claim, the true/false rule, the values endpoint, the audit map, the locale plan and added performance, UI edge-state, docs, risk, rollout and verification sections. File:line anchors were re-verified on 2026-10-27; a few are marked approximate. The implementation plan is `docs/superpowers/plans/2026-10-27-setup-value-defaults.md`. Base commit: `831bbf2` (the base includes unpushed local-main commits 01a1021, 6d9d994, 831bbf2).

---

## Context

A plant's setup matrix only knows exact (from-state, to-state) pairs. Possible states are the cross product of priority-list values; a real signature is ~1,600 states per axis (`setup-admin.mts:185`), so a full matrix is millions of pairs. Nobody can fill that cell by cell, and the only fallback today is one flat per-plant "unknown setup" number. The owner wants to pick values of a signature attribute (PRT01 = A, B, C), type one number next to each, and have every pair covered so the optimizer "has SOMETHING" everywhere, then refine the pairs that matter.

Materializing that as rows does not survive scale: plant-level import is delete-then-insert with one INSERT per row and no row cap (`backend/setup/data.py:301-363`), a 50k-row snapshot is ~20-25 MB and is `structuredClone`d on every optimize run (`engine.mts:269`), and review item P1-9 already flags that fetch as unbounded. So: **store the rule, not the rows**.

## Intent

Add a small per-plant "value defaults" layer: for one signature field and one value, a number of minutes charged whenever a transition *arrives at* that value. The optimizer resolves it on the fly below exact rows. Storage is O(values), never O(states²).

## Decisions made with the owner (do not re-ask)

1. **Direction: arriving at.** The number on PRT01 = C is the cost of any transition whose to-state has PRT01 = C and whose from-state does not. Same value on a field never charges that field. Asymmetry (A to C = 60, C to A = 10) is by design.
2. **Several changed fields add up.** PRT01 and COLOR both change, both to-values have defaults: the minutes are summed.
3. **Exact rows win.** Occurrence override, machine row and plant row all beat a value default. Identical complete states stay implicit zero. A hand-entered row lower than the default silently wins.
4. **Goal is coverage, not precision**; the grid must show which cells are rows and which come from a default, and typing into a default cell creates a real row.
5. **Partial sums count (owner, 2026-10-27).** If tooling and color both change but only one to-value has a default, the pair is covered at that one number. The resolution `reason` names the changed fields that had no default so a planner can see it is partial.
6. **Defaults carry forward on a signature bump (owner, 2026-10-27).** `save_definition` (`backend/setup/data.py:254-296`) copies every value default whose `field_key` is still in the new `fields` list to the new version. A removed field's defaults stay on the old version and are ignored. Matrix rows keep today's reset behavior.

## Calls made by the orchestrator (owner can veto)

- **Blank or incomplete states never get a default.** The tier needs a non-empty to-value on the field; on `strict_blanks = false` plants a blank value is in the state set and is simply never a contributing field.
- **Default coverage counts toward activation, in two places.** (a) `activationStatus`'s `coveragePass` reads `reachable.missing_pairs === 0` (`setup-admin.mts:271-277, 1010`); `missing_pairs` becomes "true gaps" (no row, no default, off-diagonal). (b) `matrixVersion` is `rows.length ? version : null` (`setup-admin.mts:1008`), and `activationStatus` returns "version-matched matrix required" at `:273` before `coveragePass` is read. A defaults-only plant has zero rows, so (a) alone would leave it un-activatable. `matrixVersion` therefore becomes `(rows.length || valueDefaultsForCurrentVersion > 0) ? version : null`, where the count is `value_defaults` entries whose `signature_version` equals the definition's. The "version-matched matrix required" reason text is reworded to mention defaults. That is the point of the feature; the release note says so.
- **The missing-pairs page order changes** from row-major (by from-state) to to-state-major. It is a deliberate change pinned by rewritten tests.
- **Observed order values are offered alongside priority-list values** (see Admin UI), since nothing forces every order value into a list and an unlisted value would stay uncovered.
- **The summed default is intentionally uncapped.** A single default is capped at 10,080 minutes (one week) like a matrix row, but a sum over 3-4 changed fields can reach 30,240-40,320. Rows cap at 10,080, occurrence overrides are uncapped and the scheduler has no clamp, so the spec adds none. The card shows a hint when a to-value's default exceeds one week and the Inspector reason shows the sum. This is an orchestrator call; the owner can veto it and ask for a 10,080 cap on the sum (a one-line `Math.min` in the resolver; the SQL coverage maths is unaffected because coverage only asks "is there a default").
- Matrix import, export and plant replace ignore defaults in v1. No machine-scoped defaults in v1. Plant deletion orphans defaults exactly like the four sibling setup tables (no FK; `plants` PK is `(subnetwork, plant)` so a bare FK is impossible).

## Goals / non-goals / anti-goals

- **Goals:** tens of thousands of pairs covered from one screen in under a minute; storage and payload stay tiny; coverage, the missing-pairs list, the Gantt setup bars and the Inspector all agree with the optimizer; the setup domain stays observation-only.
- **Non-goals (v1):** machine-scoped defaults; from-value defaults; "fan out into rows"; changes to the unknown-setup policy (it stays as the tier below defaults).
- **Anti-goals:** any O(states²) fetch/render/enumeration for this feature; an uncovered pair reading as zero (`docs/changeover_matrix.md:81-83` stands); silently writing rows.

## Resolution semantics (normative)

Precedence in `resolveSetup` (`frontend/setup/setup-domain.mts:339-409`) becomes:

1. occurrence override
2. machine (line) row
3. plant row
4. implicit zero (both states complete and identical)
5. **value default** (new)
6. uncovered (then the plant unknown-setup policy applies in `chargedSetupMinutesFor`, `setup-scheduler.mts:2925-2934`, which keys on `covered`; unchanged)

Rule, given definition fields F, from-state a, to-state b (both canonical shape):

- changed = { f in F : a[f] != b[f] }, comparing `normalizedValue`d strings. The from-state is normalised too: a machine-state `state_key` is a raw server string (server `_normalise_value` upper-folds "true"), and `statesEqual` compares raw values, so the index builder normalises machine-state from-keys once per run, never per lookup.
- contributing = { f in changed : b[f] non-empty and a default exists for (f, b[f]) }
- contributing empty: fall through to uncovered
- else covered = true, requiredMin = effectiveMin = standardMin = sum, source = `'value-default'`, reason e.g. "Default by value: prt01=C (60) + colorWheel=RED (15); no default: prt02=T9".

Also: the occurrence-override branch's `currentStandard` (`setup-domain.mts:373-377`) gets the same tier between identical-zero and `override.standard_min`, so the Inspector "Standard" row and the override editor baseline (`orders.mts:2463, 2502, 2730`) agree. A 0-minute default behaves exactly like a 0-minute plant row (covered, no interval, no diagnostic).

**`setup_active = false`.** The optimizer never resolves on a setup-off plant (gated at `engine.mts:1129/1912/3223`), and the Gantt bars and alerts are already hidden there (setup-off suppression, merged 6d9d994). The Inspector override editor and `deriveSetupObservation` are ungated (`ce29ad5`), so they will show default-derived minutes on a setup-off plant. That is accepted and pinned by a test; the admin card states that defaults are inert for scheduling while setup is off.

**Worked check** (signature [PRT01, COLOR]; PRT01 A=10 B=30 C=60; COLOR RED=15):

- (A,RED)->(B,RED) = 30
- (B,RED)->(A,BLUE) = 10 (partial)
- (C,BLUE)->(C,RED) = 15
- (A,RED)->(A,RED) = 0 (implicit)
- plant row (A,RED)->(B,RED) = 5 wins at 5

## Storage and API

**Table** `setup_value_default`, in `migrations/2026-10-27-1-setup-value-defaults.sql` (filename convention `YYYY-MM-DD-N-name.sql`) and mirrored after the `setup_matrix` block in `schema.sql:1884-1899`. `CREATE TABLE IF NOT EXISTS`, no `schema_migrations` row (additive). Keep the file's comments free of ALTER/DROP/DELETE/UPDATE/TRUNCATE/RENAME/GRANT/REVOKE: the deploy runner's destructive regex scans comments too.

```
plant TEXT NOT NULL,
signature_version INTEGER NOT NULL CHECK (signature_version > 0),
field_key TEXT NOT NULL,
value TEXT NOT NULL,
setup_min INTEGER NOT NULL CHECK (setup_min BETWEEN 0 AND 10080),
created_by TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
updated_by TEXT, updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
PRIMARY KEY (plant, signature_version, field_key, value)
```

Not in `ALLOWED_TABLES`; maintenance lists are catalog-driven; no purge touches setup tables. New backend tests add `DELETE FROM setup_value_default WHERE plant = %s` teardown like `tests/test_setup_data.py:976-996`.

**Canonical value.** Server-side `_normalise_value` upper-folds the string "true" to "TRUE" while the client `normalizedValue` keeps "true"/"false" lowercase (its doc comment claiming a server mirror is true only for real booleans and is corrected in Wave D). The stored default key is the **client** form. The route canonicalizes with a small helper that mirrors the client rule (strip; lowercase if "true"/"false"; else upper). The UI runs every key through `normalizedValue` before sending and dedupes on it. Everything that arrives from the server in the other form applies the same client rule before a default lookup: server state values (`_coverage_*` state sets, stored matrix rows) and the `observed` list from `db.distinct_order_values` (which returns `UPPER(TRIM)`, so "TRUE"). The coverage maths therefore canonicalises each state's field values with the helper before building D(b) and the projection groups.

**Snapshot.** `get_setup_snapshot` (`data.py:692-794`) adds `value_defaults: [{field_key, value, setup_min, signature_version, updated_by, updated_at}]` inside the existing REPEATABLE READ transaction, before `plant_matrix_token` (which needs no change). The no-definition early return (`data.py:733-734`) returns `"value_defaults": []`. `SetupSnapshot.value_defaults?` is **optional** in `types.mts:418-437`; every reader treats absent as `[]` (synthetic snapshot `engine.mts:1177-1196`, test fixtures).

**Write.** `PUT /setup/{plant}/value-defaults`, body `{signature_version, field_key, entries: [{value, setup_min | null}]}` (null deletes), cap 2,000 entries. Copy `import_setup_matrix` (`routes.py:233-253`) exactly: same decorator (`require_api_key`, `require_authenticated`, `require_admin`), `_setup_plant_guard`, `_set_admin_log_details(request, plant=, field_key=, entry_count=)` before and `(signature_version=, upserted=, deleted=)` after, `ValueError -> _setup_error` (409 on "is stale"), `_setup_freshness(result)` so the result must carry `signature_version`. Data function: one transaction, `_require_definition(cur, plant, version, lock=True)` (`data.py:214-219`; the row lock also serializes against a concurrent `save_definition` bump), validate `field_key in definition["fields"]` (a `ValueError` that `_setup_error` maps to 400; not validated against either registry), then `INSERT ... ON CONFLICT DO UPDATE` / `DELETE` per entry.

**Audit.** Add `"/setup/{plant}/value-defaults": "setup.value_defaults_write"` to `_ADMIN_WRITE_OPERATIONS` (`brain.py:748-813`, next to `"/setup/{plant}/matrix/import": "setup.matrix_import"` at `:796`); without the entry the admin-log middleware (`brain.py:825`) never records the write, and there is no setup history table, so the admin log is the only trail. Mirror the pattern pinned at `tests/test_rbac_plant_scoping.py:365`.

**Values endpoint.** `GET /setup/{plant}/value-defaults/values?field_key=` (authenticated, plant-guarded) returns `{listed: [...], observed: [...]}`: priority-list keys and `db.distinct_order_values(plant, RANKABLE_FIELDS[field]["orders_column"])` (`db.py:5717`). One cheap DISTINCT; not in the snapshot. Validation: `field_key` must be in the plant's `definition["fields"]`, else 400 (a bare `RANKABLE_FIELDS[field]` raises `KeyError`, a 500); no definition is also 400. It uses `RANKABLE_FIELDS`, not the priority-list template route's `CONFIGURABLE_PRIORITY_FIELDS`, which excludes `productionVersion` (a legal signature field on legacy definitions). The `observed` values are returned in the client canonical form (see Canonical value).

**Carry-forward.** In `save_definition`'s `elif current is not None:` branch, after the `UPDATE setup_definition` and before `conn.commit()` (`data.py:254-298`, branch at ~283-296): `INSERT INTO setup_value_default (...) SELECT ..., %s FROM setup_value_default WHERE plant=%s AND signature_version=%s AND field_key = ANY(%s) ON CONFLICT DO NOTHING`. Note a `strict_blanks`-only change also bumps (fields equal) and copies everything; test it. Not in the first-create branch. Extend `tests/test_setup_data.py:500-515` with a positive assertion and check the fake cursor tolerates `INSERT ... SELECT`.

**Coverage** (`backend/setup/data.py`; `_coverage_pair` 828-843; `_coverage_counts` 1039-~1132 is SQL over `jsonb_to_recordset` with an `effective_rows` CTE; `_page_reachable_missing_pairs` 1170-1237; states per machine come from observed orders 979-1022, complete states only):

- `_coverage_pair` gains the tier and reports `covered_by: 'row'|'implicit_zero'|'value_default'|null` (pure path only; missing-page rows do not get the field).
- Reachable counts per machine: `total = S²`; `covered_pairs` = rows + diagonal (unchanged); new `default_covered_pairs`; `missing_pairs = total - covered - default_covered`. Compute default coverage exactly with no pair enumeration: for each state b let D(b) = fields (non-blank) whose b-value has a default; (a,b), a != b, is NOT default-covered iff a agrees with b on every field in D(b). Group S by projection per D-mask (<= 2^|F| masks; |F| is 1-3 on a modern definition and can be **4** on a legacy definition that includes `productionVersion`, so up to 16 masks): `nonCovered = sum_b (|group(D(b), proj(b))| - 1)`; `defaultCoveredAll = (S²-S) - nonCovered`; then subtract `|rows that are also default-covered|` using a second query that returns the effective off-diagonal (from,to) pairs per machine. The state values are canonicalised with the client rule first (see Canonical value). **To be verified, not yet verified:** the maths is checked by a brute-force oracle test to be built in Wave A (random states, fields, defaults and rows, 500 cases, grouping result equals naive pair enumeration); no script or test exists today.
- **The row query is bounded.** The `effective_rows` CTE joins plant rows once per machine (50k rows x 70 machines is ~3.5M tuples), so the second query intersects in SQL: it returns only effective rows whose to-key has a default on some field (the to-key's field values joined against `setup_value_default`) and whose from-key is in S, never the whole matrix per machine. Latency targets (tracked in the Wave A gate, measured on a seeded 70-machine, 50k-row plant): `_coverage_counts` under 2 s, a missing-page request under 500 ms.
- **Observed kind.** `_coverage_counts` also produces the `observed` counts (and the `coverage.observed` tile), the observed missing page (`data.py:1262-1285`) and the observed CSV (default `kind=observed`, `routes.py:183`). All three would list default-covered pairs as missing. The observed pair set is small, so a plain Python pass applies `_coverage_pair`'s new tier per observed pair, and `default_covered_pairs` is reported for `observed` too.
- The reachable missing page is enumerated from the same grouping, **to-state-major**, as a lazy generator: iterate b in `state_order`, skip whole b's by `partners(b) - rowHits(b)` to honour `offset`, then yield partners from the projection group in `state_order`, dropping diagonal and row-covered, up to `limit`. Never materialize a b's partner list for the offset. Delete `_page_reachable_missing_pairs` and `_COVERAGE_SCAN_SIZE` (the no-defaults case is the empty-mask group). `missing-pairs.csv` reuses the page.
- Tests: `tests/test_setup_coverage.py:121-131, 154-158, 169-190, 227, 285, 306` pin the old shape/SQL exactly and are rewritten deliberately; `_CoverageCursor` (113-160) must answer the new row query. Response model `SetupEnvelope` is `extra="allow"`, so the key is additive.

## Frontend

**Types** (`frontend/platform/types.mts`): `SetupValueDefault`; `SetupSnapshot.value_defaults?`; add `'value-default'` to the source union at `:453`.

**Domain** (`setup-domain.mts`): `ResolveSetupInput.valueDefaults` is **required** in the type (callers pass `snapshot.value_defaults ?? []`), so `npm run typecheck` fails on any call site that forgets it; both the indexed and the linear path apply the rule. It is **defensive at runtime**: `.mjs` tests are not typechecked and call `resolveSetup` without it, so the resolver treats `undefined` as `[]`. `SetupResolutionIndex.valueDefaults: ReadonlyMap<fieldKey, ReadonlyMap<value, min>>` (version-filtered, keys normalized, built once per run) and `buildSetupResolutionIndex`'s input gains `valueDefaults`. There is no per-pair memo in the optimizer hot loop, so the lookup is precomputed per-field maps keyed by already-normalised strings (two Map reads per changed field, no per-call normalisation or array scan); a benchmark step compares `scripts/bench-optimizer.mjs` before and after. Existing tests deep-compare `source` strings only with no defaults present, so they pass; `setup-resolution-index.test.mjs:181, 527-557` tolerate the added index field.

**Call sites to thread** (exact): `setup-scheduler.mts` 2276, 3205, 3351, 3430, 5049, 6987, 7436, 7683, 7712 (all via `bounds.runContext?.resolutionIndex`) plus `buildRunContext` 663-668; `engine.mts` 688, 1987, 3230 plus `setupResolutionIndexFor` 547-562 (the memo key stores the `value_defaults` array **reference and its length**); `engine.mts:3230` is an extra index-less call site joining `orders.mts` 2457 and 2486 (none passes an index; the `orders.mts` pair feeds the Inspector and must agree with the Gantt bar); `computeShadowDiagnostics` (`setup-domain.mts:474-478`, also add default minutes to `totalStandardMinutes`, and widen its snapshot parameter type so it accepts `value_defaults`). Worker: whole-snapshot clone/serialize (`engine.mts:269, 3011`, `optimizer-worker-contract.mts:73`), stale-candidate diff is `JSON.stringify` of the whole snapshot (`setup-scheduler.mts:6880-6884`), so nothing to add.

**Display**: `setupSourceLabel` (`frontend/scheduling/gantt.mts:127-129`) prints raw source strings except `implicit-zero`; add a branch and `ui.setup_source_value_default` in all five locales. The `setup-uncovered` alert text (`frontend/nimbus-compute-core.js:1273`, "Add a setup rule to the matrix.") is reworded to "Add a setup rule or a default by value" (compute-core is a root-pinned mirror; keep its test and any en string in step). `engine.mts:722` (`implicit-zero` guard) and `orders.mts:2507` (`occurrence`/`implicit-zero` status) fall through correctly. Every frontend "missing" signal (`engine.mts:692-697`, `setup-scheduler.mts:3217/6993/7440/7724`, `optimize-ui.mts:1239-1259`, `alert-leverage.mts:260-299`) derives from `covered`, so default-covered pairs drop out automatically. `hypotheticalSetupSnapshot` spreads the snapshot, fine.

**Admin UI** (`setup-admin.mts`): a third `panel setup-panel` between the definition panel (1063-1096) and the matrix panel (1098-1131), titled "Default changeover by value":

- Own mount, own `paintValueDefaults()`, own Save/Reset bar (the bar at 1124 is grid-only), module-level `_vdField`, `_vdFilter`, `_vdDirty: Map<value, number|null>` next to the other state (~175), reset on plant / signature version / field change. Typing never calls `renderSnapshot` (it would drop focus). Grid and card saves do not interfere (`_gridDirty` survives `render`; only `discardStagedEdits` clears it).
- Field picker: `<select>` over `definition.fields`. Values: union of `fieldValueSet(rankMaps, field, '')` (plant scope only; show a note when `_lineScope` is set), the values endpoint's `observed`, and stored defaults; each row badged listed / observed-only / stored-only. Plain `<input type="search">` substring filter like `filterStates` (389-393); render at most ~200 rows with "N more, refine the filter"; the mass-fill control reads "Set all N matching to [x]" and applies to every matching value, not just rendered rows.
- Minutes input per row with `parseGridMinutes` rules; blank = remove; a hint shows when a value exceeds one week (10,080) and a note that sums over several fields are not capped. Gate inputs, helper and Save on `permissions.matrixWrite` (253), matching the admin-only PUT; a read-only user sees the card disabled with the reason ("Admin only"), never hidden.
- **Repaint hook.** `render()` rebuilds `target.innerHTML` (`setup-admin.mts:1136`), so the card's mount is re-created each time. `paintValueDefaults()` is called after every `render()` and on `master-data-changed` (priority-list edits change the listed values), re-applying `_vdDirty` to the fresh DOM and the filter text/focus.
- **Edge states.** No definition: the card shows an empty state ("Define a signature first") and no PUT is attempted (it would 4xx). Signature bump while `_vdDirty` is non-empty: warn with a confirm (discard or keep) and never drop silently; if a save races a bump the server answers 409 and the card refetches and keeps the dirty map. Matrix Replace and "Delete all" leave defaults untouched (stated in their confirm text). `setup_active = false`: the card says defaults are inert for scheduling until setup is on.
- **Accessibility.** The card is a labelled region; the field picker, filter and each minutes input have programmatic labels (value name in the input's `aria-label`); badges carry text, not colour alone; Save reports via the existing toast/live region; the 200-row cap announces "N more" in a text node.
- Save: `Util.fetchTraced` (eslint fetch rule), only dirty entries; then `Persistence._invalidateSetupSnapshot` + `loadSetupSnapshot`, `invalidatePlant(plant)` (the existing grid save at 2001-2002 never invalidates coverage, so tiles are stale today; the card must not copy that), then `render`. Add a `'value-default'` kind to `setupWriteKind` (527-533) so an open optimizer preview is staled. No `on*=` attributes (legacy-surface ratchet + eslint); `data-*` + delegated listeners.
- `Store.replaceSetupSnapshot` emits `setup-snapshot:replace`; Gantt, orders, alert monitor and shell already subscribe, so bars update once threading is done.

**Grid**: there is no legend to extend (verified: zero `legend` hits; only four cell classes at `styles.css:7177-7181`; three hint keys `en.js:2076-2078`). Add state `'value-default'` to `gridCellState` (427-434) via a new `defaultMin: number|null` parameter; resolve default cells by calling `resolveSetup` with empty row/override arrays plus `valueDefaults` (O(1), no index); one CSS class `.setup-grid-value-default`; one hint key `ui.setup_grid_value_default_hint` with the contributing defaults; `data-missing=false` for the state (1722 would otherwise flag it); placeholder shows the sum, editor opens empty, typing follows the existing dirty/`buildSaveRequests` path unchanged. Clearing a real row on a default-covered pair shows blank until save+refetch, then the default shade returns. Ctrl+C on a default cell copies empty (accepted). `gridCellState` is exported with 5 parameters (`setup-admin.mts:428`); the new `defaultMin` is a sixth, and `tests/modules/setup/setup-admin.test.mjs` gains cases for it.

**List view.** The default view is the list (`_setupView = 'list'`, `setup-admin.mts:188`), and `listRowView` (1324-1345) would label a default-covered pair "Gap". It gains a `value-default` state with the source label (`ui.setup_source_value_default`) and the contributing defaults as its detail; the list's Gap filter and count exclude default-covered pairs.

**Line scope.** With a machine selected, precedence is the resolver's: a line override (row) beats the value default; `gridCellState`/`listRowView` return `line-override` before `value-default`, and a plant row shown at line scope stays `plant-row`. The "By default" tile and the card are plant-wide (defaults are plant-scoped in v1), and the card shows a note when `_lineScope` is set.

**Coverage UI**: tiles become Recorded (`covered_pairs`) / By default (`default_covered_pairs`) / Gaps (`missing_pairs`); the inline label and 1029/1042 stop deriving "recorded" as `total - missing`.

**i18n**: ~20 keys added to **all five** `frontend/locales/*.js` (English text is allowed as the non-English placeholder, but the keys must exist: the ratchet at `tests/modules/locale-completeness.test.mjs:554-563` has only 4 keys of headroom, so "en only" is not an option). The new keys are also added to the hand key list `BRANCH_KEYS` (`:635`) so the completeness test covers them. Reuse `btn.save`, `btn.discard`, `toast.setup_saved`, `toast.save_failed`. Measure de/fr lengths against the card before fixing the layout.

## Release note

- Pairs with no row but a default are **covered**: under `excludeFromSearch` they are now admitted; under any policy they are charged the summed default, not the plant default.
- Already-queued `setup_transition_unrecorded` rows are not released by saving defaults; run Optimize or place them manually.
- Min Changeover / SPT rankings change once defaults exist (covered edges compete on minutes).
- A plant can now reach activation on default coverage alone.
- Missing-pairs list and CSV are ordered by to-state.
- Value-level history is not kept: the admin log records the written `field_key` and the upsert/delete counts only, never the values or minutes, and there is no history table.
- The observed missing page is cut in Python when any value default exists (the SQL returns the row-uncovered observed pairs, defaults are filtered in Python, then the page is sliced); this is acceptable because the observed pair set is small. Without defaults the SQL `LIMIT/OFFSET` is the page.

## Docs to update (Wave D)

Each `CLAUDE.md` edit is mirrored in its `AGENTS.md` twin (the repo keeps both in step):

- `docs/changeover_matrix.md` 81-83 (uncovered never zero; add the default tier), 111-117, 126, 414-442
- `backend/setup/CLAUDE.md` 9, 11, 19, 59-65 (+ `AGENTS.md`)
- `frontend/setup/CLAUDE.md` 8, 10, 12, 23, 26, 39 (+ `AGENTS.md`); correct the `normalizedValue` doc comment in `setup-domain.mts`
- `frontend/optimization/CLAUDE.md:34` (+ `AGENTS.md`); `frontend/scheduling/CLAUDE.md` (+ `AGENTS.md`); `frontend/platform/CLAUDE.md` (+ `AGENTS.md`)
- `docs/architecture/optimizer-dispatch.md`
- `docs/MIGRATION.md:1083-1136`
- root `CLAUDE.md` Domain Directory row for Setup (one clause) and its `AGENTS.md` twin

## Risks and hazards

- **Hot path cost.** The resolver runs inside the optimizer's inner loop with no per-pair memo; mitigated by per-field precomputed maps and a `bench-optimizer` gate.
- **Missed call site.** every call site listed above, incl. the index-less `engine.mts:3230`; the required type catches typed code, but untyped `.mjs` tests and the runtime default `[]` could mask a miss. Gate: a test that a default affects Gantt bar, Inspector and optimizer identically.
- **True/false drift** between server and client forms silently disables defaults for boolean fields (see Canonical value); covered by tests on both sides.
- **Stale optimize previews and queued rows** after saving defaults (release note); `setupWriteKind` stales an open preview.
- **Coverage maths errors** are invisible in fakes; the oracle test and real-Postgres tests are the only guards.
- **Unbounded sums** (see calls above); owner-vetoable.
- **Deploy base.** The worktree base includes unpushed local-main commits 01a1021, 6d9d994 and 831bbf2; a deploy ships them too.
- **Test-suite blind spot.** The Python suite is mostly fakes and `pg` tests skip silently without the opt-in; local Postgres credentials are owed before Wave A can be gated.

## Rollout and rollback

- The migration is additive (`CREATE TABLE IF NOT EXISTS`); old code ignores the table and the extra snapshot key, so a code rollback to the previous image is safe and leaves stored defaults inert. Deploy via `promote-azure` (applies `migrations/`, not `schema.sql`; no destructive flag needed).
- **There is no kill switch.** Once deployed, a default on a plant affects resolution immediately; to neutralise one, delete the entries (admin card) or roll the image back. No feature flag is added (lean scope); say so in the release note.
- Order: migration, backend, frontend in one image; the frontend treats an absent `value_defaults` as `[]`, so a frontend served before the new backend degrades to today's behaviour.

## Verification gates

`npm run lint`, `npm run typecheck`, `npm run build`, `npm run test`, `npm run check:legacy-surface`, `npm run check:static-assets`; `python -m pytest tests/ -q` incl. `tests/test_schema_idempotent.py:458-528` (schema re-apply) and the real-Postgres `pg` tests (migration, upsert/delete, carry-forward incl. a `strict_blanks`-only bump, exact and observed coverage counts, bounded row query, lazy missing page, 400/409 paths); the brute-force coverage oracle test; `tests/modules/setup/setup-resolution-scale.test.mjs` (asserts reads <= 3 x queries and enumerates index fields; updated for `valueDefaults`); `scripts/bench-optimizer.mjs` before/after; `gridCellState` cases in `tests/modules/setup/setup-admin.test.mjs`; locale completeness; a setup-off Inspector test. Browser checks are owner-owed.

## Left to the builder

- Card layout/CSS (DESIGN.md tokens); exact wording of the partial-sum reason.
- Audit detail field names; interval `source` on `deriveSetupObservation` output (accept the existing `'resolved'` bar label).

---

## Appendix A: Context

On 2026-10-27 the owner asked for a way to mass-populate changeover coverage for tens of thousands of (from-state, to-state) pairs without entering them one by one. A brainstorm settled the model: a default charged when a transition "arrives at" a value, summed across changed fields, partial sums allowed, and defaults carried forward on a signature bump. A builder check and seven read-only Sonnet verifiers then checked the first design against live code on 2026-10-27 and corrected it (rev. 2); their findings are in Appendix B. The base commit is `831bbf2` on branch `worktree-setup-value-defaults`.

Two owner decisions dated 2026-10-27 are recorded above: partial sums count (decision 5) and defaults carry forward on a signature bump (decision 6). Decisions 1-4 came out of the brainstorm the same day.

The implementation plan (waves, verification) is at `docs/superpowers/plans/2026-10-27-setup-value-defaults.md`.

## Appendix B: Things learned along the way

- **No grid legend exists.** There is nothing to extend: only four cell classes (`styles.css:7177-7181`) and three hint keys (`en.js:2076-2078`), so the design adds a cell state, a class and a hint key instead.
- **15 `resolveSetup` call sites, several with no index.** Two in `orders.mts` (2457, 2486) pass no resolution index, so the defaults input is required in the type and `npm run typecheck` catches any missed site.
- **Coverage counts are SQL; the default tier is a Python pass.** `_coverage_counts` is SQL over `jsonb_to_recordset`, so default coverage needs the exact grouping math plus a second row query, not a pair enumeration.
- **The missing-pair page order must change to to-state-major.** The old row-major window scan cannot honour offsets against default coverage, so the lazy to-state-major generator replaces it and the pinned coverage tests are rewritten.
- **Priority lists do not contain every order value.** Nothing forces an order value into a list, so the values endpoint also returns observed order values.
- **The existing grid save never invalidates coverage tiles.** The grid save at `setup-admin.mts:2001-2002` leaves tiles stale today; the new card must call `invalidatePlant(plant)` and not copy that.
- **The Python suite is mostly fakes.** Real-Postgres (`@pytest.mark.pg`) tests are required for the migration, upsert/delete, carry-forward and exact coverage counts; without the opt-in they skip silently and look green.
- **Migration conventions.** The filename convention is `YYYY-MM-DD-N-name.sql`, and the deploy runner's destructive-word regex scans comments too, so the migration file's comments must avoid those words.
- **"true"/"false" edge.** Server `_normalise_value` upper-folds "true" to "TRUE" while the client `normalizedValue` keeps it lowercase; the route uses a helper mirroring the client rule so keys match. Server state values, stored matrix rows and `db.distinct_order_values` (`UPPER(TRIM)`) all produce "TRUE", so the coverage maths and the `observed` list apply the client rule before any default lookup, and the `normalizedValue` doc comment (mirrors the server only for real booleans) is stale.
- **Activation had two gates, not one.** `matrixVersion` (`setup-admin.mts:1008`) is null with zero rows, so a defaults-only plant failed "version-matched matrix required" before `coveragePass` was read; rev. 2 only fixed the second gate.
- **The values endpoint cannot trust the field name.** `RANKABLE_FIELDS[field]` raises `KeyError` (500); validate against `definition["fields"]` and use `RANKABLE_FIELDS`, because the priority-list template route's `CONFIGURABLE_PRIORITY_FIELDS` omits `productionVersion`.
- **The admin log is the only setup audit trail.** No setup history table exists, and the `_ADMIN_WRITE_OPERATIONS` map (`brain.py:748-813`) decides what is logged, so a new write route needs its entry.
- **|F| can be 4.** A legacy definition with `productionVersion` gives 16 masks, not 8.
- **The locale ratchet has 4 keys of headroom** (`locale-completeness.test.mjs:554-563`), so ~20 new keys must go into all five locales plus `BRANCH_KEYS`.
- **The "500 random cases" claim had no backing.** Neither script nor test existed; the oracle test is now an explicit Wave A item.
- **Sums are unbounded by construction.** Rows cap at 10,080 but a 3-4 field sum reaches 30,240-40,320; overrides are uncapped and the scheduler never clamps, so the spec says so rather than leaving it implicit.
- **Observed coverage is a separate code path.** The `observed` counts, page and CSV need their own default pass; the SQL grouping covers only reachable.
- **`setup_active=false` is only half gated.** The optimizer never resolves, but the Inspector override editor and `deriveSetupObservation` are ungated (`ce29ad5`).
- **Default view is the list, not the matrix** (`setup-admin.mts:188`), so `listRowView` needs the new state, not just the grid.
- **The index-less call sites are three**, not two: `engine.mts:3230` joins `orders.mts:2457/2486`; `.mjs` tests are not typechecked, hence the runtime-defensive `valueDefaults`.
