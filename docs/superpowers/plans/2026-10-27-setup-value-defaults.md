# Setup value defaults: implementation plan

> **Status (2026-10-27): plan written, nothing built.** Governing spec: `docs/superpowers/specs/2026-10-27-setup-value-defaults-design.md` (rev. 3). Base commit `831bbf2`, branch `worktree-setup-value-defaults`. Owner decisions 1-6 in the spec are settled; do not re-ask.

## Execution rules

- **One Sonnet implementer and one Sonnet reviewer per wave. The orchestrator never codes**; it dispatches, rules on deviations and merges. Implementers and reviewers append their own progress lines to the ledger.
- Waves run in order A, B, C, D (B needs A's snapshot key; C needs B's resolver; D documents the shipped behaviour). Each wave ends with its gates and a reviewer pass before the next starts.
- **Local Postgres credentials are owed** (the `.env` may point at the live Azure DB and pytest refuses a non-local host). Real-Postgres `pg` tests need local `PG_*` creds, a local `nimbus` DB and `NIMBUS_TEST_DB=1`; without them they skip silently and look green, so the implementer reports skipped counts explicitly and Wave A is not "gated" until they have run once.
- Do not touch anything outside the listed files without a ledger note. Every file:line anchor is in the spec.

## Wave A: backend

**Tasks**

1. Migration `migrations/2026-10-27-1-setup-value-defaults.sql` and the mirrored block after `setup_matrix` in `schema.sql` (~1884-1899). `CREATE TABLE IF NOT EXISTS`; comments free of ALTER/DROP/DELETE/UPDATE/TRUNCATE/RENAME/GRANT/REVOKE.
2. `backend/setup/data.py`: canonical-value helper (client rule); `get_setup_snapshot` adds `value_defaults` (and `[]` on the no-definition return); `save_value_defaults` (lock via `_require_definition`, validate `field_key in definition["fields"]`, upsert/delete, cap 2,000); carry-forward in `save_definition`; `value_defaults_values` (listed + observed via `RANKABLE_FIELDS`, 400 on unknown field or no definition).
3. `backend/setup/routes.py`: `PUT /setup/{plant}/value-defaults` (copy of `import_setup_matrix`), `GET /setup/{plant}/value-defaults/values`.
4. `brain.py`: `_ADMIN_WRITE_OPERATIONS["/setup/{plant}/value-defaults"] = "setup.value_defaults_write"`.
5. Coverage: `_coverage_pair` tier and `covered_by`; `_coverage_counts` default-covered maths (grouping, bounded SQL row query, canonicalised states, observed Python pass, `default_covered_pairs` for reachable and observed); lazy to-state-major missing-page generator replacing `_page_reachable_missing_pairs` and `_COVERAGE_SCAN_SIZE`; observed page and CSV default-aware; `missing-pairs.csv` reuses the page.

**Files:** `migrations/2026-10-27-1-setup-value-defaults.sql`, `schema.sql`, `backend/setup/data.py`, `backend/setup/routes.py`, `brain.py`; tests below.

**Tests**

- Fakes: extend `tests/test_setup_data.py` (carry-forward positive assertion near 500-515; fake cursor tolerates `INSERT ... SELECT`; teardown `DELETE FROM setup_value_default WHERE plant = %s` like 976-996), `tests/test_setup_endpoints.py` (PUT 400/409/200, values 400, admin-only), `tests/test_rbac_plant_scoping.py` (the audit-map entry, pattern at 365), `tests/test_domain_setup_contract_coverage.py` if it enumerates routes, `tests/test_schema_idempotent.py:458-528`.
- Rewrite deliberately `tests/test_setup_coverage.py` (121-131, 154-158, 169-190, 227, 285, 306; `_CoverageCursor` 113-160 answers the new row query; to-state-major ordering).
- **Real-Postgres (`@pytest.mark.pg`)**: migration applies twice; upsert/delete round trip; carry-forward incl. a `strict_blanks`-only bump and a removed field; exact reachable and observed counts; the bounded row query (seed a 70-machine, 50k-row plant); lazy page offsets and limits; true/false canonicalisation end to end.
- **Brute-force coverage oracle** (new, runs without Postgres on the pure grouping function): 500 random cases (states, 1-4 fields, defaults, rows) where the grouping maths and the lazy generator equal naive pair enumeration, including offset/limit windows and the diagonal.
- Latency checks: `_coverage_counts` < 2 s and a missing-page request < 500 ms on the seeded plant.

**Gates:** `python -m pytest tests/ -q` (with local PG and `NIMBUS_TEST_DB=1`, report skipped count), `npm run generate:api-types` then `npm run typecheck` (the OpenAPI dump gains the routes).

## Wave B: domain and optimizer

**Tasks**

1. `frontend/platform/types.mts`: `SetupValueDefault`; optional `SetupSnapshot.value_defaults`; add `'value-default'` to the source union (`:453`).
2. `frontend/setup/setup-domain.mts`: tier in `resolveSetup` (both indexed and linear path) incl. the occurrence-override `currentStandard` branch; required-in-type, runtime-defensive `valueDefaults`; `SetupResolutionIndex.valueDefaults` (per-field precomputed maps, normalised keys, machine-state from-keys normalised once); `buildSetupResolutionIndex` input; `computeShadowDiagnostics` (widen snapshot type, add default minutes to `totalStandardMinutes`); correct the `normalizedValue` doc comment.
3. Thread every call site: `setup-scheduler.mts` 2276, 3205, 3351, 3430, 5049, 6987, 7436, 7683, 7712 and `buildRunContext` 663-668; `engine.mts` 688, 1987, 3230 and `setupResolutionIndexFor` 547-562 (memo key stores the array reference and length); `orders.mts` 2457, 2486.
4. Display: `setupSourceLabel` (`frontend/scheduling/gantt.mts:127-129`) and `ui.setup_source_value_default` (all five locales + `BRANCH_KEYS`); reword the `setup-uncovered` alert text at `frontend/nimbus-compute-core.js:1273` to mention defaults.
5. Synthetic snapshot `engine.mts:1177-1196` and fixtures treat absent `value_defaults` as `[]`.

**Tests:** extend `tests/modules/setup/` (domain resolver: the worked check, partial sum with the no-default field named in `reason`, 0-minute default, row beats default, identical zero, blank to-value, true/false, undefined `valueDefaults`); `setup-resolution-index.test.mjs:181, 527-557`; `tests/modules/setup/setup-resolution-scale.test.mjs` (reads <= 3 x queries, index fields enumerated); scheduler tests (default-covered pair is covered, excludeFromSearch admits it, charged the summed default not the plant default); an agreement test that the Gantt bar, Inspector and optimizer give the same minutes; a setup-off Inspector test; compute-core alert text test.

**Gates:** `npm run build`, `npm run typecheck` (fails on any missed call site by design), `npm run lint`, `npm run test`, `npm run check:static-assets`, `npm run check:legacy-surface`; **benchmark** `node scripts/bench-optimizer.mjs` before and after (record both in the ledger; no regression beyond noise with zero defaults and a documented delta with defaults).

## Wave C: admin UI and i18n

**Tasks**

1. `frontend/setup/setup-admin.mts`: the "Default changeover by value" panel (own mount, `paintValueDefaults()`, Save/Reset bar, `_vdField/_vdFilter/_vdDirty`); repaint hook after every `render()` and on `master-data-changed`; field picker, value union (listed/observed/stored), filter, 200-row cap, "Set all N matching"; Save via `Util.fetchTraced` then snapshot invalidate/reload, `invalidatePlant`, `render`; `'value-default'` kind in `setupWriteKind`; edge states (no definition, dirty on signature bump, read-only disabled, setup-off note, line-scope note); accessibility labels.
2. `activationStatus` inputs: `matrixVersion` counts value defaults for the current version; reworded reason text.
3. Grid: `gridCellState` sixth parameter `defaultMin`, `'value-default'` state, `data-missing=false`, placeholder sum; `.setup-grid-value-default` in `styles.css` (~7177-7181; mind the file's CRLF) with DESIGN.md tokens; hint key `ui.setup_grid_value_default_hint`.
4. List view: `listRowView` `value-default` state, Gap filter/count exclude it; line-scope precedence.
5. Coverage tiles: Recorded / By default / Gaps; stop deriving recorded as `total - missing` (~1029/1042).
6. i18n: ~20 keys in all five `frontend/locales/*.js` and the `BRANCH_KEYS` hand list; measure de/fr lengths against the card first.

**Tests:** `tests/modules/setup/setup-admin.test.mjs` (`gridCellState` cases, `listRowView`, `activationStatus` defaults-only activates, `setupWriteKind`, dirty-map behaviour with the DOM stubs the file already uses); `locale-completeness.test.mjs` (ratchet and `BRANCH_KEYS`); legacy-surface and eslint no `on*=`/fetch rules.

**Gates:** `npm run build`, `typecheck`, `lint`, `test`, `check:legacy-surface`, `check:static-assets`. Browser check is owner-owed (card, grid shade, list view, tiles in a real plant).

## Wave D: docs

**Tasks:** update every item in the spec's "Docs to update" list and each `AGENTS.md` twin (`docs/changeover_matrix.md`, `backend/setup/`, `frontend/setup/`, `frontend/optimization/`, `frontend/scheduling/`, `frontend/platform/` CLAUDE/AGENTS, `docs/architecture/optimizer-dispatch.md`, `docs/MIGRATION.md`, root `CLAUDE.md` Setup row); add the release note (covered pairs admitted under `excludeFromSearch`, no release of queued unrecorded rows, ranking changes, activation on defaults alone, to-state ordering, no kill switch); update the spec status banner to "built".

**Gates:** doc-only diff review; `npm run check:static-assets` unaffected; reviewer verifies each anchor against the shipped code.

## Rollout

Merge to local main, then `/promote-azure` (migrations apply through the ledger; the additive table needs no destructive flag; the deploy also ships unpushed local-main commits 01a1021, 6d9d994, 831bbf2). Rollback is the previous image (stored defaults are then inert); there is no kill switch. Owner browser checks follow the deploy.

---

## Appendix A: Context

The owner wants to mass-populate changeover coverage (tens of thousands of from/to pairs) without entering rows one by one. The settled model is "default charged when a transition arrives at a value", summed across changed fields, partial sums allowed, carried forward on signature bump, with exact rows always winning. The first design was verified by a builder check and seven Sonnet verifiers (rev. 2), then double-checked by three reviewers on 2026-10-27 (rev. 3), which produced the corrections this plan implements. Pilot context: Azure Container Apps single replica, image `nimbus:v138` live; Postgres is shared with the pilot, local pytest must use a local DB.

## Appendix B: Things learned along the way

- Activation has two gates (`matrixVersion`, then `coveragePass`); both must count defaults.
- The Python test suite is mostly fakes, and `pg` tests skip silently; local Postgres credentials are a prerequisite, not a nicety.
- The existing `_coverage_counts` is SQL, so default coverage needs grouping maths plus a bounded row query; the maths needs an oracle test because nothing else can validate it.
- True/false canonical forms differ between server and client; every boundary needs the client rule applied.
- The locale ratchet (`locale-completeness.test.mjs:554-563`) leaves 4 keys of headroom, so all five locales are mandatory.
- `styles.css` is CRLF; edit with care (see the local test gate quirks note).
- The admin log map in `brain.py` is opt-in per route; a new write route silently goes unlogged without an entry.
