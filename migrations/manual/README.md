# Hand-applied migrations

These three files were applied by hand to the live database and are not safe to
re-run against a current-schema database (they target pre-cutover
`production_lines`/`line_*` names or are one-time data backfills). The Azure
runner (`apply-migrations.ps1`) lists `migrations/*.sql` non-recursively, so
this folder is never applied automatically. Keep them as the historical record.
