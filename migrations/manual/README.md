# Hand-applied migrations

These files were applied by hand to the live database and are not safe to
re-run against a current-schema database (they target pre-cutover
`production_lines`/`line_*` names or are one-time data backfills). The Azure
runner (`apply-migrations.ps1`) lists `migrations/*.sql` non-recursively, so
this folder is never applied automatically. Keep them as the historical record.

Quarantined in the 2026-10-05 review round (they fail with
`relation "production_lines" does not exist` on a database built from the
current `schema.sql`, which has no `production_lines` table; `schema.sql`
already carries their end state):

- `2026-07-03-production-line-optimizer-flags.sql`
- `2026-08-13-changeover-matrix-stage-0.sql`
