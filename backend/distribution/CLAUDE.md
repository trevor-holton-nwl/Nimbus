# backend/distribution — SAP aggregate work center <-> NIMBUS per-machine sub-orders

## What lives here

Order Distribution bridges SAP's aggregate work centers (one SAP work center standing in for several physical machines) with NIMBUS's discrete-machine scheduling model. `routes.py` holds this domain's FastAPI router; `data.py` holds the plain psycopg write logic over the shared pool (`db._pool`), mirroring `backend/setup/data.py`'s convention; `models.py` holds the route's typed response DTO.

**Mid-implementation: P1 only so far.** The only route today is `PUT /distribution/{plant}/workcenters/{wc}` (`save_workcenter`) — a validated create-or-replace of one plant's `sap_workcenter` policy row and its member machines' `machine.distribution_weight`, in one transaction with an `admin_audit` row. It enforces the four §3.1 write-path rules (`wc_code_shadowed_by_machine`, `default_machine_not_member`, `single_mode_without_default`, `distribute_mode_thin`) as 400s with a structured `{"code": ...}` detail, plus an additional `weight_machine_not_member` guard on the weights payload. No `base_version`/optimistic-concurrency token on this route — that belongs to the future `order_distribution` header table (P2+), not this policy row.

Source design: `aggregate_to_detail.md` at the repo root (DRAFT, 2026-09-17) — see its §3 (data model: `sap_workcenter`, `order_distribution`, `order_distribution_share`, the `machine`/`orders` column additions), §4.3 (this route's exact Save contract), and §7 (the full backend API table this domain grows into: ingest, re-weight, roll-up, review-queue summary).

## Counterpart

Frontend half does not exist yet — the Work Centers master-data sub-tab described in §4.3 is future work, as is the Distribution tab itself (§10).
