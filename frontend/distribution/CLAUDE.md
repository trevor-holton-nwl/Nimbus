# Distribution — SAP aggregate work center ↔ NIMBUS per-machine sub-order split UI

## What lives here

Order Distribution owns the frontend surfaces for splitting SAP aggregate work centers into per-machine sub-orders in NIMBUS. **P1 (Work Centers master-data tab) is complete;** P2 (Distribution Scheduling Board sub-tab with list + detail panel and dry-run share editor) is not yet built. The Work Centers tab allows admins to configure per-plant work-center policies (distribution mode, default machine, max separation, tooled-material handling, review gates) and assign machines with weights; the Distribution tab will display distributed parents, their shares, and a weight editor with live quantity preview.

Source design: `aggregate_to_detail.md` at the repo root (DRAFT, 2026-09-17) — see its §4.3 (Work Centers admin tab, complete in P1) and §6 (Distribution Scheduling Board UI, P2).

## Counterpart

Backend half carries the load-bearing data, routes, and ingest logic: `backend/distribution/CLAUDE.md`.
