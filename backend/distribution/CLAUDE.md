# backend/distribution — SAP aggregate work center <-> NIMBUS per-machine sub-orders

## What lives here

Order Distribution bridges SAP's aggregate work centers (one SAP work center standing in for several physical machines) with NIMBUS's discrete-machine scheduling model. `routes.py` holds this domain's FastAPI router; `data.py` holds the plain psycopg write logic over the shared pool (`db._pool`), mirroring `backend/setup/data.py`'s convention; `models.py` holds the route's typed response DTO.

**Mid-implementation: P1 (write) + P2-2/P2-3 (ingest seam) + P2-6/P2-7 (read routes) shipped; the planner write routes (`shares`/`review`/`reset`/`reapply-defaults`/`resolve`) are still future work.**

- `PUT /distribution/{plant}/workcenters/{wc}` (`save_workcenter`) — a validated create-or-replace of one plant's `sap_workcenter` policy row and its member machines' `machine.distribution_weight`, in one transaction with an `admin_audit` row. Enforces the four §3.1 write-path rules (`wc_code_shadowed_by_machine`, `default_machine_not_member`, `single_mode_without_default`, `distribute_mode_thin`) as 400s with a structured `{"code": ...}` detail, plus an additional `weight_machine_not_member` guard. No `base_version`/optimistic-concurrency token on this route — that belongs to the `order_distribution` header table.
- `plan()`/`apply()` (`data.py`) — the ingest transaction seam (§5), wired into `db.upsert_orders` via its optional `plan_fn`/`apply_fn` parameters.
- Five read-only routes, all `require_authenticated` + plant scope, `Cache-Control: no-store` (§7): `GET /distribution/{plant}` (paged list, `list_headers_for_plant`), `GET /distribution/{plant}/{order}/{material}` (`get_header_detail`, carries `base_version`), `GET /distribution/{plant}/summary` (`get_summary`), `GET /distribution/{plant}/aggregate` (`get_aggregate`, the §10.2 roll-up built from `db._EFF_END_SQL`/`db._SCHEDULE_SEGMENTS_LATERAL_SQL`, `?format=csv` export), `GET /distribution/{plant}/unresolved` (`get_unresolved`, the `missing_master_data_for_plant` analogue). The list route's `bucket` filter and the summary route's counts share one classification helper, `data.classify_bucket_membership`/`status_matches_filter`, so the two bucket definitions (§6 "Data") can never drift apart.

Source design: `aggregate_to_detail.md` at the repo root (DRAFT, 2026-09-17) — see its §3 (data model: `sap_workcenter`, `order_distribution`, `order_distribution_share`, the `machine`/`orders` column additions), §4.3 (the workcenters route's exact Save contract), §5 (ingest/materialization), §6 ("Data" — the bucket definitions), §7 (the full backend API table this domain grows into), and §10.2 (the aggregate roll-up).

## Counterpart

Frontend half does not exist yet — the Work Centers master-data sub-tab described in §4.3 is future work, as is the Distribution tab itself (§10).
