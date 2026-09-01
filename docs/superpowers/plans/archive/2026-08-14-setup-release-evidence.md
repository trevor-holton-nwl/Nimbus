# Setup release-evidence implementation plan

## Scope

Implement the approved release-evidence sidecar and server gate, connect it to
the existing Stage 2 Plant Settings surface, repair null-predecessor override
persistence, and address only local quality failures that are proven related
or mechanically safe. Keep all setup policy flags disabled until evidence is
actually recorded.

## Tasks

1. Add failing Python contracts for evidence defaults, normalization, version
   conflicts, plant scope, and policy activation rejection. Add the idempotent
   schema/migration sidecar and master-data/API functions; run focused tests and
   commit the server slice.
2. Add failing frontend contracts for evidence readiness, payload preservation,
   and failed/cross-plant hydration. Extend types, persistence, and SetupAdmin
   with the evidence panel and guarded switches; add locale/CSS coverage and
   commit the UI slice.
3. Trace the existing setup override write path and add a failing null-
   predecessor round-trip test. Make the smallest parameter/validation fix,
   then run setup endpoint/data tests and commit it separately.
4. Reproduce the CQ-1 snapshot failure and lint findings. Fix only changes
   attributable to this branch or unambiguous baseline defects without
   weakening contracts; otherwise document them as inherited. Run focused
   tests, build, typecheck, ESLint, and Ruff.
5. Attempt local DB and browser verification. If the host/session is still
   unavailable, record exact blockers and do not enable, deploy, or claim
   owner approval. Update Stage 2/MIGRATION evidence and commit the record.

## Invariants

- Server-side activation gate is authoritative; UI disabling is supplementary.
- Release evidence is plant-scoped and optimistic-versioned.
- Disable-only policy writes remain safe and side-effect-free.
- Candidate evaluators remain detached and no new placement path is created.
- No external evidence is fabricated.
