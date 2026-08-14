# Setup policy release-evidence design

## Goal

Give Stage 2 setup policies a durable, auditable activation gate without
turning setup-aware optimization on during observation-only work. A policy may
be enabled only when every required release-evidence item is recorded for the
same plant and the policy write passes the server-side gate.

## Evidence contract

`plants.setup_release_evidence` is a versioned JSONB sidecar with these fields:

- `stage1Validated`
- `localDbVerified`
- `performanceVerified`
- `browserUatVerified`
- `representativeReplayVerified`
- `nullPredecessorVerified`
- `ownerApproved`
- `ownerEmail`, `approvedAt`, and `notes`
- positive `version`

All booleans default to `false`; identity and approval metadata default to
`null`/empty. The server normalizes and validates the shape, scopes reads and
writes to one plant, uses optimistic `expected_version`, and records an admin
audit entry for every write. The evidence record is an attestation register,
not a claim that this environment has performed the external checks.

## Activation rule

The server derives `ready` from all seven booleans plus nonblank owner email,
approval timestamp, and notes. `PUT /setup/{plant}/policy` rejects any request
that enables a policy while `ready` is false. Disable-only writes always remain
available and do not mutate orders, setup bars, setup truth, diagnostics, or
alerts. Existing defaults remain disabled.

The frontend hydrates evidence per plant and renders each gate and its current
reason. It enables policy switches only when the server-provided record is
ready; readers see a read-only status, while admins can maintain the evidence
record and policy thresholds. Failed or cross-plant hydration clears stale
values.

## Null-predecessor persistence

Initial-state setup overrides must preserve a genuine `null` predecessor ID.
Validation distinguishes a missing key from an explicit `null`; SQL writes use
the parameterized value without coercing it to an empty string. The regression
contract covers round-tripping `null`, rejecting absent predecessor identity
where the API requires it, and keeping the override inactive when its state
binding is invalid.

## Verification

Pure/API tests cover defaults, plant scope, optimistic versions, activation
rejection, disable-only writes, and evidence normalization. Frontend tests
cover hydration clearing, gate readiness, and safe payload construction.
Build/typecheck and local static checks run after each implementation slice.
Local PostgreSQL, browser UAT, representative replay, and scheduling-owner
approval remain external evidence and are never synthesized by tests.
