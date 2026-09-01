# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. **Domain internals live in a per-domain `CLAUDE.md` network** (directory table below), auto-loaded from whatever folder you're editing — this root doc is the repo-wide remainder only.

## Project

**NIMBUS** (Newell Integrated Batch & Unified Scheduling) — a production scheduling and order optimization tool for Newell Brands manufacturing. It renders a Gantt timeline, an AG Grid orders table, a KPI dashboard, a calendar manager for working hours and blackout blocks, a master-data admin area, and a sequence-dependent **setup (changeover) matrix** feeding the optimizer.

## Domain Directory

The codebase is organized into `web/<domain>/` (frontend) and `server/<domain>/` (backend routers) folders. Each domain has a `CLAUDE.md` on both sides — substantive on whichever side carries the load-bearing invariants (both sides for scheduling and setup), a 3-line pointer on the other. `brain.py` is now a ~700-line thin assembly — middleware, lifespan, `api.include_router(...)` for nine domain routers, then the `StaticFiles` mount last. `db.py`/`master_data.py` stay unsplit at repo root; see "Deferred" below.

| Domain | Folder(s) | Covers | Substantive side |
|---|---|---|---|
| Platform | `web/platform/` | `Config`/`Util`/`Toast`/`Modal`/`ErrorLog` + `Store`, the reactive source of truth every domain subscribes to | `web/platform/` |
| Scheduling | `web/scheduling/` + `server/scheduling/` | Gantt, orders grid, drag/keyboard interaction, explicit save; `/tasks` + the `xmin`/`base_version` concurrency contract | both sides |
| Optimization | `web/optimization/` | `Engine.runAndApply` dispatch, setup-aware evaluator, Optimize dialog/preview, Sandbox what-if | `web/optimization/` |
| Setup | `web/setup/` + `server/setup/` | Changeover signatures, matrices, machine states, overrides (observation-only); Setup Matrix admin | both sides |
| Calendar | `web/calendar/` + `server/calendars/` | Working hours, blackouts, capacity-math engine (mirrored in `nimbus-compute-core.js`) | `web/calendar/` |
| Insights | `web/insights/` | Alerts, Utilization matrix, Dashboard KPIs, the off-thread `Compute` worker client | `web/insights/` |
| Priority Lists | `web/priority-lists/` + `server/priority_lists/` | Per-plant rankable lists (color, PRT tooling, production version) feeding optimizer sort terms | `server/priority_lists/` |
| Master Data | `web/master-data/` + `server/master_data/` | CRUD/DDL for the nine `ALLOWED_TABLES`, cascade preview, schema export, table browser | `server/master_data/` |
| Labor | `web/labor/` + `server/labor/` | Aggregate and line-level available-labor-hours planning | `server/labor/` |
| Security | `web/security/` + `server/security/` | Login, RBAC guards, users/roles, `role_plants` scoping, per-user settings | `server/security/` |
| Integration | `web/integration/` + `server/integration/` | Excel order/BOM ingest, purge, upload audit, missing-master-data reports, SAP sync skeleton | `server/integration/` |
| Admin Ops | `web/admin-ops/` + `server/admin_ops/` | Diagnostics, DB maintenance, `_BACKEND_LOG` ring buffer, System Configuration | `server/admin_ops/` |
| Shell | `web/shell/` | Boot, tab chrome, login screen, the intelligence layer, and the root-pinned classic scripts (`app.js`, `index.html`, `locales/`) | `web/shell/` |

> **Compiled output is gitignored, not committed.** Each `.mts` file compiles to a `.mjs` twin next to it — `.gitignore` lists every compiled path and `git ls-files` confirms none are tracked. `npm run build` compiles fresh locally; the Dockerfile's `webbuild` stage compiles fresh before copying into the image. Nothing depends on a committed compiled artifact.

## Git Branch Conventions

**`main` is the active trunk**; feature branches fork from its tip and merge back into it. `feature/user-first-last-name` — which had quietly become the de facto trunk while `main` went stale — is retired as a trunk (left in place, not deleted). Don't fork new work from it or treat it as the merge base.

## Design Context

Strategic and visual design decisions live in **`PRODUCT.md`** (register, users, positioning, brand personality, anti-references, design principles) and **`DESIGN.md`** (color/typography/component tokens, elevation, do's and don'ts — machine-readable frontmatter plus a sidecar at `.impeccable/design.json`). Read both before any UI/UX work; they were generated via `/impeccable` against the existing `styles.css` token system, not invented. Both stay at the project root by `/impeccable`'s own hardcoded convention — don't move them.

## Production Scale Roadmap

NIMBUS is designed to grow to enterprise scale. **All UI and data design decisions must anticipate this:**

| Dimension | Current (prototype) | Target scale |
|-----------|--------------------|--------------:|
| Plants | 1–3 | **50+** |
| Machines per plant | ~5 | **70+** |
| Total machines across system | ~15 | **3,500+** |

**Design implications:**
- **Never use bubble/chip selectors for plants or machines** — these break past ~10 entries. Use searchable, filterable dropdowns (comboboxes); scrolling is not enough at 50+ plants and 70+ machines.
- **Hierarchy navigation** (plant → machine) must be scoped, and **API endpoints returning plant or machine lists** must support server-side pagination or filtering.
- **Priority lists (color, PRT tooling, production version), setup definitions/matrices, blackout blocks, and calendar configs are per-plant** — storage and retrieval keyed by plant ID, never assumed global.
- **Utilization and dashboard charts** must be filterable and aggregatable by plant, not rendered for all plants at once.
- **The setup matrix is O(states²) per plant** — never render or fetch a full plant matrix snapshot for a UI that needs only one from-state's rows (`GET /setup/{plant}/matrix-rows` exists precisely to avoid that; see `docs/Setup_matrix_redesign.md`).

This is the primary long-term scalability constraint for every feature in NIMBUS — per-domain implications live in each domain's own `CLAUDE.md`.

## Running the App

The backend serves both the JSON API and the static frontend (a `StaticFiles` mount at `/`, registered last), so local dev is a single process. `brain.py` has **no `if __name__ == "__main__"` block** — the entrypoint is always `uvicorn brain:api` (also the container `CMD`).

```bash
pip install -r requirements.txt
uvicorn brain:api --port 8000      # add --reload for auto-reload during dev
# Then open http://localhost:8000/
```

Most of the frontend has no build step — JS/CSS load directly, libraries come from CDN. **Exception:** a growing set of modules is real TypeScript compiled in place by `tsc` (module-by-module status in `docs/archive/typescript_migration.md`, now historical — see its own P6 note for current per-domain ownership). **If you edit a `.ts`/`.mts` file, run `npm run build` before `uvicorn` will serve the updated output.**

## Build, Lint, Test

```bash
npm run build          # tsc: worker then main project (required after any .ts/.mts edit)
npm run build:watch    # worker project only, watch mode (pair with uvicorn --reload)
npm run typecheck      # both tsc projects, --noEmit
npm run lint           # ESLint over app.js, intelligence, compute-core, locales, *.mjs/*.mts, scripts, tests
npm run test           # pretest runs build; then test:legacy (tests/js) + test:modules (tests/modules)
node --test tests/modules/setup-scheduler.test.mjs   # single JS test file
npm run check:static-assets   # local imports from a web/ .mjs must resolve inside web/
npm run check:legacy-surface  # pins the app.js legacy compatibility surface
npm run generate:api-types    # OpenAPI dump -> web/types/api-generated.d.mts

python -m pytest tests/ -q                         # Python suite
python -m pytest tests/test_setup_data.py::test_x  # single Python test (drop ::test_x for the file)
```

> App dependencies live in the repo `.venv`, not a bare `py` install.

## Database Setup

Postgres must be running locally. `schema.sql` is **safe to re-apply** — one-time data-mutating migrations are guarded by a `schema_migrations` ledger (the former `plants` horizon ×1440 landmine, which re-multiplied any value `<= 365` on every run, is recorded as applied and no longer re-mutates).

```bash
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE nimbus;"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d nimbus -f schema.sql
```

`migrations/` holds dated, additive, idempotent `.sql` files mirroring what `schema.sql` also carries. **Deploys apply `migrations/`, never `schema.sql`** (see the `promote-azure` skill). Credentials come from `.env` (`python-dotenv`): `PG_HOST`, `PG_PORT`, `PG_DB`, `PG_USER`, `PG_PASS`, plus optional pool/timeout knobs.

> **pytest is guarded against the live Azure DB:** `tests/conftest.py` + `tests/support/db_safety.py` validate `PG_HOST`/`PG_DB` at collection time and raise `pytest.UsageError` — not a per-test skip — unless the host is local and `NIMBUS_TEST_DB=1` is set. The entire pytest run fails to collect whenever `.env`'s `PG_HOST` points at a non-local host, which it may on this machine. Deliberate; not a bug to work around by pointing `.env` at Azure. This exact hazard bit the refactor itself in Phase P5 via a different gap (`db.py`'s own unscoped `load_dotenv()` letting a bare `import db` from a worktree reach the live DB) — since fixed by pinning that call to `db.py`'s own directory.

## Deployment Notes

- **Hosted on Azure (single-container pilot, live since 2026-06-30)** — one container on **Azure Container Apps**; FastAPI serves API and static UI from the same origin against Azure Database for PostgreSQL. Live URL: `https://ca-nimbus-dev.delightfulwater-7252cdf0.eastus2.azurecontainerapps.io/`. Resources (RG `rg-nimbus-dev`, `eastus2`): ACR `acrnimbusdev` (image `nimbus:vN`), Container App `ca-nimbus-dev`, Postgres `pgdb-nimbus-dev`/`nimbus`. **Deploy via the `promote-azure` skill** — it builds/rolls the image and applies pending `migrations/` through the ledger, never `schema.sql`. Runbook + gotchas in **`docs/DEPLOYMENT.md`**; remaining hardening in **`docs/MIGRATION.md`**. Single-replica pilot; CORS is vestigial since the UI is same-origin.
- **When verifying a deploy, cache-bust the request** (random query param + `no-cache` header) — the corporate proxy caches keyed on URL and will serve a pre-roll response, faking a failed deploy.

**Deferred:** `db.py`/`master_data.py` are intentionally not split into `server/<domain>/` — every router still imports them whole from repo root, and each affected domain's `CLAUDE.md` references them by current line range. See `docs/MIGRATION.md` → "Domain refactor — deferred backend data-layer split."

> **Doc staleness is real and recurring** — several planning docs track progress with checkboxes never updated after the work shipped, and past audit reports list findings already fixed. **Verify any doc claim against live code and git log before acting on it**; this refactor's own execution hit that warning repeatedly, surfacing staleness the source plan itself didn't know about.
