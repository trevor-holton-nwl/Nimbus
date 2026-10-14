# Hand-applied migrations

These files target the pre-2026-08-20 database shape (`production_lines`,
`line_*`, `material_plants.default_workcenter`) or are one-time cutover
steps. They are **not** safe to run against a database built from the current
`schema.sql`, and the Azure runner (`apply-migrations.ps1`) lists
`migrations/*.sql` non-recursively, so this folder is **never applied
automatically**. `schema.sql` already carries the end state of every file
here. They are kept as the historical record and as the recipe for a database
that predates the 2026-08-20 Production Line -> Machine cutover.

## Why each file is quarantined

| File | Why it is here |
|---|---|
| `2026-07-03-production-line-optimizer-flags.sql` | Adds optimizer-flag columns to `production_lines`, a table that no longer exists (renamed to `machine`). Fails with `relation "production_lines" does not exist` on a current-schema database. |
| `2026-08-10-material-plant-default-workcenter.sql` | Adds `material_plants.default_workcenter`, a column the 2026-08-20 cutover renamed to `default_machine`. Run against a current-schema database it silently re-creates the retired column (a "ghost" column that also gets a stale `column_metadata` row). It is a prerequisite of the rename on an old database, never of a current one. |
| `2026-08-13-changeover-matrix-stage-0.sql` | Creates the setup tables with pre-rename `line`/`production_lines` naming and alters `production_lines`. Fails on a current-schema database. |
| `2026-08-17-line-key-columns.sql` | Adds a generated `line_key` column and indexes on `production_lines` (plus `orders.line_key`); `production_lines` no longer exists, so it fails on a current-schema database. |
| `2026-08-20-line-to-machine.sql` | The one-way, non-repeatable Production Line -> Machine rename (tables, columns, indexes, metadata, SAP seed keys). Errors on re-run by design. Must be applied by hand, exactly once, and is not recorded in `schema_migrations`. |
| `2026-08-20-setup-value-case-fold-backfill.sql` | One-time data backfill that upper-cases setup attribute values inside JSONB state keys (may merge PK-colliding rows). Data-mutating, intended to run alongside the deploy of the matching application fold, not as routine maintenance. |
| `2026-10-20-restore-precutover-snapshot.sql` | Rollback for the backward-scheduling cutover: restores placements, firm flags and segments from the `*_precutover_snapshot` tables. Manual-only, destructive by design; see the rollback matrix in `docs/DEPLOYMENT.md`. |
| `2026-10-08-nimbus-mulesoft-role.sql` | Environment-specific, not a legacy file: creates the least-privilege `nimbus_mulesoft` login and its grants on the `sap_stage_*` tables. The password and network rules are set per environment, so a DB admin applies it by hand after `2026-10-08-sap-staging-tables.sql`. |

## Which databases need these

* A database built from the current `schema.sql` (or created on/after
  2026-08-20) needs **none** of them: `schema.sql` is the end state.
* A database **older than 2026-08-20** (any pre-cutover Azure/dev copy) cannot
  be brought forward by the top-level `migrations/` files alone, because those
  assume the post-cutover names. Either **rebuild it from `schema.sql`** (the
  recommended path for any non-production copy) or first apply these files by
  hand, in date order, with the cutover discipline described in each file's own
  header: `2026-07-03`, `2026-08-10`, `2026-08-13`, `2026-08-17`,
  `2026-08-20-line-to-machine`, `2026-08-20-setup-value-case-fold-backfill`.
  Only then apply the top-level `migrations/*.sql` through the ledger.

The `schema_bootstrap_smoke.py` script and `tests/test_schema_idempotent.py`
pin this folder's contents; moving a file in or out requires updating both.
