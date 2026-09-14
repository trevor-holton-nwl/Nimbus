# frontend/ — the served browser client

Side-wide conventions for everything under `frontend/`. Domain specifics live one level down in each `frontend/<domain>/CLAUDE.md` — see the directory table in root `CLAUDE.md` for the full domain list and which side (frontend/backend/both) carries the load-bearing detail for each.

## What lives at this level

Root-pinned classic scripts and boot assets, owned by the `shell` domain (`frontend/shell/CLAUDE.md`): `index.html`, `app.js`, `nimbus-intelligence.js`, `nimbus-compute-core.js`/`.d.ts`, `nimbus-worker.ts`, `styles.css`, `app-entry.mjs` (the boot bridge that wires `window.__NIMBUS_*` namespace objects), `locales/`, `Images/`. Everything else lives inside a `frontend/<domain>/` folder.

## Build model

- This is a directly-served static directory (`brain.py`'s `StaticFiles` mount, registered at `/` — the folder name is never part of a URL). Most of it has no build step; JS/CSS load directly and third-party libraries come from CDN.
- A growing set of modules is real TypeScript, compiled **in place** by `tsc` — each `.mts` file produces a `.mjs` twin next to it (module-by-module status in `docs/archive/typescript_migration.md`, now historical). **Compiled output is gitignored, not committed** — `.gitignore` lists every compiled path individually; `npm run build` compiles fresh locally, and the Dockerfile's `frontendbuild` stage compiles fresh before copying into the image. If you edit a `.mts` file, run `npm run build` before `uvicorn` serves the updated output.
- Classic scripts (`app.js`, `nimbus-intelligence.js`) bridge to the `.mts`/`.mjs` module world through `window.__NIMBUS_*` namespace objects constructed in `app-entry.mjs` — see `frontend/shell/CLAUDE.md` for the bridge contract, and `scripts/legacy-surface.mjs` for the shrinking-allowlist scanner that tracks what's left to migrate off it.
- `scripts/check-static-assets.mjs` enforces two invariants over this whole tree: no local import escapes `frontend/`, and no backend source/config filename (`brain.py`, `db.py`, `master_data.py`, etc.) ever appears under it — this is a real security boundary on the live Azure pilot, not just a lint nicety.

## Cross-cutting hazards

- **Never render/fetch data for all plants or all machines at once** — see root `CLAUDE.md`'s Production Scale Roadmap. This applies across every domain here, not just one.
- **ESM import cycles between sibling `.mts` files are common and generally safe** as long as every cross-reference is inside a function/method body invoked after both modules finish top-level evaluation — never at module-init/top-level. Each domain's `CLAUDE.md` documents its own cycles; when adding a new cross-domain call, verify it's lazy the same way before assuming it's fine.
- Two domains keep a small piece of logic **deliberately duplicated rather than shared** (e.g. `_mkCombobox` between `setup` and `master-data`) to avoid adding another edge onto an existing cycle — check a domain's own file before assuming a helper should be extracted into a shared module.

## Counterpart

Backend half: `backend/CLAUDE.md`.
