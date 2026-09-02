"""
NIMBUS 2.0 — setup (changeover) matrix domain routes: plant setup-signature
definitions, from-state x to-state matrices, machine physical state, and
one-off occurrence overrides. Observation-only — this module never changes
an order's schedule (the scheduler reads it).

P5 relocation: pure move from brain.py (lines 2517-2832 as verified against
the pre-split file), per docs/architecture/domain-refactor-plan.md §4. Route
paths and payload/response shapes are byte-identical to before. Local helpers
(`_setup_plant_guard`, `_setup_error`, `_setup_freshness`, `_setup_observed_at`,
`_setup_coverage_payload`) are used only within this domain and moved along
with their callers.
"""
import csv
import io
import json
from datetime import datetime

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response

import master_data as md
import backend.setup.data as setup_data
from backend.admin_ops.logbuffer import _current_rid, _set_admin_log_details
from backend.security import auth
from backend.security.auth import require_api_key
from backend.setup.models import PlantSetupActiveResult, SetupEnvelope, SetupLineCompatibilityResult

router = APIRouter()
require_admin = auth.require_admin


def _setup_plant_guard(plant: str, allowed_plants: list[str] | None) -> None:
    """Translate the shared plant scope choke point for setup routes."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _setup_error(exc: ValueError) -> HTTPException:
    """Keep setup signature conflicts distinct from malformed request data."""
    status = 409 if "signature version is stale" in str(exc).lower() else 400
    return HTTPException(status_code=status, detail=str(exc))


def _setup_freshness(result: dict) -> dict:
    """Attach only a correlation token and current signature marker to responses."""
    version = result.get("signature_version")
    if version is None and isinstance(result.get("definition"), dict):
        version = result["definition"].get("signature_version")
    return {**result, "freshness": {"signature_version": version, "request_id": _current_rid()}}


def _setup_observed_at(value) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("observed_at is required as an ISO datetime")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("observed_at is required as an ISO datetime") from exc


@router.put("/setup/{plant}/active", response_model=SetupEnvelope,
           dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                 Depends(require_admin)])
def set_setup_active(plant: str, request: Request, body: dict = Body(default={}),
                     allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                     actor: str = Depends(auth.require_authenticated)):
    """VESTIGIAL BUT RETAINED (Workstream D2, 2026-08-20): this used to be the
    "Include Setup Times in Optimizer" checkbox's write path. That checkbox
    now writes plants.setup_active via PUT /plant/{plant}/setup-active
    instead — no UI or optimizer gate reads setup_definition.active any
    more. Kept, unchanged, because removing it means also removing every
    caller/test of it, which was judged higher blast radius than leaving one
    unread write path in place."""
    _setup_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, active=bool(body.get("active")))
    try:
        result = setup_data.set_definition_active(
            plant, bool(body.get("active")), actor,
            expected_signature_version=body.get("expected_signature_version"),
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    return _setup_freshness(result)


@router.get("/setup/{plant}", response_model=SetupEnvelope, dependencies=[Depends(auth.require_authenticated)])
def get_setup(plant: str, request: Request,
              allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Return one authorized plant's complete setup snapshot, never a cross-plant aggregate."""
    _setup_plant_guard(plant, allowed_plants)
    try:
        snapshot = setup_data.get_setup_snapshot(plant)
        # Workstream D2: the real "include setup times in optimizer" gate is
        # plants.setup_active, not setup_definition.active (which is
        # vestigial-but-retained — see schema.sql). Surfaced as its own
        # top-level field rather than overloading `definition.active`, so it
        # stays independently inspectable alongside machine.setup_compatible
        # and the snapshot's own plant-identity check.
        snapshot["plant_active"] = md.get_plant_setup_active(plant)
        return _setup_freshness(snapshot)
    except ValueError as exc:
        raise _setup_error(exc) from exc


@router.put("/plant/{plant}/setup-active", response_model=PlantSetupActiveResult,
           dependencies=[Depends(require_api_key), Depends(require_admin)])
def set_plant_setup_active_route(plant: str, request: Request, body: dict = Body(default={}),
                                  actor: str = Depends(auth.require_authenticated)):
    """Persist the plant-level "include setup times in optimizer" flag.

    Payload: { subnetwork?, active: bool }. Relocated off the per-signature-
    version setup_definition.active (see PUT /setup/{plant}/active above,
    now vestigial-but-retained) onto a durable plant-level setting, following
    the machine.setup_compatible precedent: unregistered column, dedicated
    validated endpoint. This is intentionally separate from that route and
    from machine.setup_compatible — three independent gates, never conflated."""
    active = body.get("active")
    if not isinstance(active, bool):
        raise HTTPException(status_code=400, detail="active must be boolean")
    _set_admin_log_details(request, plant=plant, active=active)
    try:
        return md.set_plant_setup_active(
            plant, active,
            subnetwork=body.get("subnetwork", ""),
            user_email=actor,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _setup_coverage_payload(result: dict, *, machine: str | None = None, offset: int = 0, limit: int = 100) -> dict:
    """Keep coverage totals useful without embedding an unbounded missing-edge list."""
    payload = {"plant": result["plant"], "signature_version": result.get("definition", {}).get("signature_version")
               if result.get("definition") else None}
    for kind in ("observed", "reachable"):
        summary = result[kind]
        page = setup_data.page_missing_pairs(summary["missing"], machine=machine, offset=offset, limit=limit)
        payload[kind] = {key: value for key, value in summary.items() if key != "missing"}
        payload[kind]["missing_page"] = page
    return _setup_freshness(payload)


@router.get("/setup/{plant}/coverage", response_model=SetupEnvelope, dependencies=[Depends(auth.require_authenticated)])
def get_setup_coverage(plant: str, machine: str | None = Query(default=None), offset: int = Query(default=0, ge=0),
                       limit: int = Query(default=100, ge=1, le=500),
                       allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Bounded Stage 0 transition coverage; this observes, never changes, schedules."""
    _setup_plant_guard(plant, allowed_plants)
    try:
        return _setup_coverage_payload(setup_data.get_setup_coverage(plant), machine=machine, offset=offset, limit=limit)
    except ValueError as exc:
        raise _setup_error(exc) from exc


@router.get("/setup/{plant}/matrix-rows", response_model=SetupEnvelope, dependencies=[Depends(auth.require_authenticated)])
def get_setup_matrix_rows(plant: str, machine: str = Query(default=""), from_key: str | None = Query(default=None),
                          offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=500),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Bounded, from-state-scoped page of effective matrix rows for the List view."""
    _setup_plant_guard(plant, allowed_plants)
    try:
        # This is raw caller JSON, not yet case-folded — page_matrix_rows()
        # canonicalizes it (via setup_data.canonical_state_key, using this
        # plant's definition fields) before comparing against stored JSONB, so
        # a hand-typed "black" here still matches a stored "BLACK" key.
        parsed_from_key = json.loads(from_key) if from_key else None
        signature_version = setup_data.current_signature_version(plant)
        if signature_version is None:
            return _setup_freshness({"plant": plant, "machine": machine, "signature_version": None, "rows": [],
                                     "meta": {"total": 0, "offset": offset, "limit": limit}})
        return _setup_freshness(setup_data.page_matrix_rows(
            plant, machine, signature_version, from_key=parsed_from_key, offset=offset, limit=limit,
        ))
    except (ValueError, json.JSONDecodeError) as exc:
        raise _setup_error(exc) from exc


@router.get("/setup/{plant}/missing-pairs.csv", dependencies=[Depends(auth.require_authenticated)])
def export_setup_missing_pairs(plant: str, kind: str = Query(default="observed"), machine: str | None = Query(default=None),
                               offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=500),
                               allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Export one bounded, selectable page of missing canonical long-form pairs."""
    _setup_plant_guard(plant, allowed_plants)
    if kind not in {"observed", "reachable"}:
        raise HTTPException(status_code=400, detail="kind must be observed or reachable")
    try:
        coverage = setup_data.get_setup_coverage(plant)
        page = setup_data.page_missing_pairs(coverage[kind]["missing"], machine=machine, offset=offset, limit=limit)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Plant", "Machine", "Scope", "Signature version", "From setup state", "To setup state"])
    version = coverage.get("definition", {}).get("signature_version") if coverage.get("definition") else ""
    for row in page["rows"]:
        writer.writerow([plant, row["machine"], row["scope"], version,
                         json.dumps(row["from_key"], separators=(",", ":")),
                         json.dumps(row["to_key"], separators=(",", ":"))])
    headers = {"Content-Disposition": f'attachment; filename="setup-missing-{kind}-{plant}.csv"',
               "X-Total-Count": str(page["meta"]["total"])}
    return Response(content=output.getvalue(), media_type="text/csv", headers=headers)


@router.put("/setup/{plant}/definition", response_model=SetupEnvelope,
           dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                     Depends(require_admin)])
def save_setup_definition(plant: str, request: Request, body: dict = Body(default={}),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                          actor: str = Depends(auth.require_authenticated)):
    """Master-data-owner write for a plant's ordered signature definition."""
    _setup_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, field_count=len(body.get("fields", []))
                           if isinstance(body.get("fields"), list) else 0)
    try:
        result = setup_data.save_definition(
            plant, body.get("fields"), body.get("strict_blanks"), actor,
            expected_signature_version=body.get("expected_signature_version"),
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, signature_version=result["signature_version"])
    return _setup_freshness(result)


@router.post("/setup/{plant}/matrix/import", response_model=SetupEnvelope,
            dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                         Depends(require_admin)])
def import_setup_matrix(plant: str, request: Request, body: dict = Body(default={}),
                        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                        actor: str = Depends(auth.require_authenticated)):
    """Write canonical long-form plant rows or sparse rows for one owned machine."""
    _setup_plant_guard(plant, allowed_plants)
    machine = body.get("machine", "")
    rows = body.get("rows")
    _set_admin_log_details(request, plant=plant, machine=machine, row_count=len(rows) if isinstance(rows, list) else 0)
    try:
        if machine:
            result = setup_data.upsert_machine_matrix_rows(plant, machine, rows, body.get("signature_version"), actor)
        else:
            result = setup_data.replace_plant_matrix(plant, rows, body.get("signature_version"), actor)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, signature_version=result["signature_version"], rows=result.get("rows", 0))
    return _setup_freshness(result)


@router.delete("/setup/{plant}/matrix", response_model=SetupEnvelope,
              dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                     Depends(require_admin)])
def delete_setup_matrix_rows(plant: str, request: Request, body: dict = Body(default={}),
                             allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                             actor: str = Depends(auth.require_authenticated)):
    """Delete only selected cells; a sparse machine deletion exposes inherited plant truth."""
    _setup_plant_guard(plant, allowed_plants)
    machine = body.get("machine", "")
    rows = body.get("rows")
    # `scope` is an optional audit-only passenger field (Workstream D3): the
    # Setup Matrix admin UI's per-row/bulk/delete-all actions send 'row' /
    # 'bulk' / 'all' respectively so an auditor can tell a single-cell delete
    # from a scope-wide wipe without a brittle row-count heuristic. The
    # pre-existing minute-clear-via-Save path sends no `scope` at all, so it
    # is logged distinctly as 'edit' rather than defaulting to 'row'.
    _set_admin_log_details(request, plant=plant, machine=machine, scope=body.get("scope") or "edit",
                           row_count=len(rows) if isinstance(rows, list) else 0)
    try:
        if machine:
            result = setup_data.delete_machine_matrix_rows(plant, machine, rows, body.get("signature_version"), actor)
        else:
            result = setup_data.delete_plant_matrix_rows(plant, rows, body.get("signature_version"), actor)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, signature_version=result["signature_version"], deleted=result.get("deleted", 0))
    return _setup_freshness(result)


@router.put("/setup/{plant}/lines/{machine}/state", response_model=SetupEnvelope,
           dependencies=[Depends(require_api_key), Depends(auth.require_setup_scheduler)])
def save_setup_line_state(plant: str, machine: str, request: Request, body: dict = Body(default={}),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                          actor: str = Depends(auth.require_setup_scheduler)):
    """Authorized plant schedulers assert current physical state for an owned machine."""
    _setup_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, machine=machine)
    try:
        result = setup_data.set_machine_state(
            plant, machine, body.get("values"), body.get("signature_version"),
            _setup_observed_at(body.get("observed_at")), body.get("source"), body.get("reason"), actor,
            body.get("physical_mold_id"),
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, signature_version=result["signature_version"], accepted=result.get("accepted"))
    return _setup_freshness(result)


@router.put("/setup/{plant}/lines/{machine}/compatibility", response_model=SetupLineCompatibilityResult,
           dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                                      Depends(require_admin)])
def save_setup_line_compatibility(plant: str, machine: str, request: Request, body: dict = Body(default={}),
                                  allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                                  actor: str = Depends(auth.require_authenticated)):
    """Admin-only setup-signature opt-out, distinct from global optimizer exclusion."""
    _setup_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, machine=machine)
    try:
        result = md.set_setup_line_compatibility(plant, machine, body.get("setup_compatible"), body.get("reason"), actor)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, setup_compatible=result["setup_compatible"])
    return result


@router.get("/setup/{plant}/lines/{machine}/compatibility", response_model=SetupLineCompatibilityResult,
           dependencies=[Depends(auth.require_authenticated)])
def get_setup_line_compatibility(plant: str, machine: str,
                                 allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    _setup_plant_guard(plant, allowed_plants)
    try:
        result = md.get_setup_line_compatibility(plant, machine)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    return result


@router.post("/setup/{plant}/overrides", response_model=SetupEnvelope,
            dependencies=[Depends(require_api_key), Depends(auth.require_setup_scheduler)])
def create_setup_override(plant: str, request: Request, body: dict = Body(default={}),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                          actor: str = Depends(auth.require_setup_scheduler)):
    """Create one occurrence-specific override; its stable resource ID is server-assigned."""
    _setup_plant_guard(plant, allowed_plants)
    if "predecessor_order_id" not in body:
        raise _setup_error(ValueError("Predecessor order id is required; use null for initial state"))
    machine = body.get("machine")
    _set_admin_log_details(request, plant=plant, machine=machine)
    try:
        result = setup_data.upsert_occurrence_override(
            plant, machine, body.get("predecessor_order_id"), body.get("successor_order_id"),
            body.get("predecessor_values"), body.get("successor_values"), body.get("standard_min"),
            body.get("remaining_min"), body.get("signature_version"), body.get("reason"), actor,
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, machine=result["machine"], signature_version=result["signature_version"],
                           persisted_override_id=result["id"])
    return _setup_freshness(result)


@router.put("/setup/{plant}/overrides/{override_id}", response_model=SetupEnvelope,
           dependencies=[Depends(require_api_key), Depends(auth.require_setup_scheduler)])
def save_setup_override(plant: str, override_id: int, request: Request, body: dict = Body(default={}),
                        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                        actor: str = Depends(auth.require_setup_scheduler)):
    """Update the exact occurrence override identified by the URL; never rebind its adjacency."""
    _setup_plant_guard(plant, allowed_plants)
    machine = body.get("machine")
    _set_admin_log_details(request, plant=plant, machine=machine, override_id=override_id)
    try:
        result = setup_data.update_occurrence_override(
            plant, machine, override_id, body.get("standard_min"), body.get("remaining_min"),
            body.get("signature_version"), body.get("reason"), actor,
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, machine=result["machine"], signature_version=result["signature_version"],
                           persisted_override_id=result["id"])
    return _setup_freshness(result)


@router.delete("/setup/{plant}/overrides/{override_id}", response_model=SetupEnvelope,
              dependencies=[Depends(require_api_key), Depends(auth.require_setup_scheduler)])
def clear_setup_override(plant: str, override_id: int, request: Request, body: dict = Body(default={}),
                         allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                         actor: str = Depends(auth.require_setup_scheduler)):
    """Clear an active occurrence override while retaining its audit reason and history."""
    _setup_plant_guard(plant, allowed_plants)
    machine = body.get("machine")
    _set_admin_log_details(request, plant=plant, machine=machine, override_id=override_id)
    try:
        result = setup_data.clear_occurrence_override(
            plant, machine, override_id, body.get("signature_version"), actor, body.get("reason")
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, machine=result["machine"], cleared=result["cleared"],
                           signature_version=result.get("signature_version"))
    return _setup_freshness(result)
