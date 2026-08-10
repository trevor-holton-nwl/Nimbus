# NIMBUS — Microsoft Entra ID Authentication: Migration Design

> **Status: DESIGN ONLY — none of this is built.** Nothing in this document describes shipped behavior. Target window is months out; it exists so the work can be wired deliberately rather than improvised under deadline.
>
> **Relationship to other docs.** This **supersedes `docs/MIGRATION.md` Workstream 3** (lines 98–122), which planned MSAL.js in the browser plus backend JWT validation. That plan predates the CQ-1 module split, the TypeScript migration, and the local-password feature; its `app.js` line references no longer resolve. WS3's *protection matrix* (which routes to gate) remains useful and is carried forward here. `docs/DEPLOYMENT.md` stays the operational runbook — the `az` commands here are additions to it, not replacements.
>
> **Deliberately a skeleton.** Section 4 (identity model) and section 7 (authorization) are the parts that need real decisions and are specified accordingly. Everything else is structural: the shape to build into, not line-for-line instructions against today's tree.

## Context

The pilot has no security boundary. `docs/DEPLOYMENT.md:10` says so plainly — "anyone with the URL can use it." Two facts make that concrete:

1. **The login screen is real but the session is not.** `auth.py` genuinely verifies passwords with PBKDF2-HMAC-SHA256 at 600,000 iterations. But what the browser keeps afterward is an unsigned JSON blob in `localStorage` under `nimbus.session` (`web/schedule-data.mts:1690`). Anyone can open devtools and write `localStorage['nimbus.session'] = JSON.stringify({username:'<any admin>', role:'admin', loggedInAt:Date.now()})`, reload, and be an admin. The 12-hour expiry (`Config.SESSION_MAX_AGE_MS`) is a client-side check on a client-controlled timestamp.
2. **The backend trusts a request header.** `auth._actor_email()` (`auth.py:480-485`) reads `x-user-email` or `X-User` with no verification of any kind. Every authorization decision, every audit row, and every per-plant scope in the application derives from that string. Its own docstring calls out that this is the line that changes when SSO lands.

Newell requires authentication through Azure → Container Apps, with the URL reachable only from the enterprise VPN.

### Decisions locked (2026-08-06)

| Decision | Choice | Consequence |
|---|---|---|
| Auth mechanism | **Container Apps built-in auth ("Easy Auth")** with Entra ID as provider | No MSAL.js, no JWT validation code, no new crypto dependency |
| Network reachability | **VPN-only** | Independent of auth; see §3. Infra change, not app code |
| Login screen | **Visual preserved**; the form becomes a single "Sign in with Microsoft" button | `#login-username` and `#login-password` are removed |
| Identity key | **Migrate to email / UPN** (`preferred_username`) | Schema change plus backfill. Not a one-line swap — see §4 |
| Provisioning | **Just-in-time** — first sign-in creates the row; an admin grants role and plants after | New "access pending" state |
| Local passwords | **Kept as break-glass, fail-closed in production** | `auth.py` password machinery stays; refuses to run in Azure unless explicitly enabled |
| Scope | Sign-in **plus** making `roles` / `role_plants` genuinely enforce | The three fail-open behaviors in §1.3 become fail-closed |

### In scope

Entra sign-in via Easy Auth · VPN-only reachability · the identity-key migration and backfill · JIT provisioning and the access-pending state · login screen and sign-out rework · verified actor identity across all three audit mechanisms · role-based route gating · per-plant scoping tightened from fail-open to fail-closed · a local-development identity path.

### Out of scope

Key Vault secret migration · managed identity for Postgres · a service principal for the SAP sync job · durability for the file-based audit log · multi-tab sign-out synchronization · Entra-group-driven role assignment (considered and rejected — see §11) · credential forwarding to Entra (considered and rejected — see §11).

## 1. Current state

### 1.1 What is trustworthy today

| Layer | Mechanism | Trustworthy? |
|---|---|---|
| Password verification | PBKDF2-HMAC-SHA256, 600k iterations (`auth.py:117-142`) | **Yes** — the hashing itself is sound |
| Session after login | Unsigned `localStorage` JSON (`nimbus.session`) | **No** — forgeable in devtools |
| Session expiry | Client-side `Date.now()` check at boot only (`Config.SESSION_MAX_AGE_MS`) | **No** — client-controlled, and not re-checked while the tab is open |
| Backend identity | `x-user-email` / `X-User` request header (`auth.py:480-485`) | **No** — unverified |
| Admin gate | `require_admin` → 403 (`auth.py:488-497`) | Logic is correct; **input is not** |
| Per-plant scoping | `get_allowed_plants` on `GET /tasks`, `GET /master-data/{table}` | Enforced server-side; **input is not trustworthy**, and fails open |
| Page access | `roles.settings.pages` | **UI visibility only** — no endpoint enforcement |
| Audit actor | Header-derived, in all three audit paths | **No** |

### 1.2 The tables

| Table | Key | Notes |
|---|---|---|
| `user_security` | `username` **TEXT PK** | Holds Newell network IDs (`PJ29587`). Columns: `password_hash`, `role` → `roles`, `first_name`, `last_name`, `last_login`. Case-insensitive unique index `ux_user_security_lower_username` is load-bearing — every lookup and upsert matches `lower(username)` |
| `user_settings` | `username` **FK** → `user_security` | One JSONB blob per user, `ON DELETE CASCADE` |
| `roles` | `role` TEXT PK | Plus a `settings` JSONB carrying `pages` page-access flags |
| `role_plants` | `(role, plant)` | The plant-scoping join |
| `admin_audit` | `id` BIGSERIAL | `user_email` is free-text TEXT and in practice receives the *username* |

There is **no `users` table** and **no `email` column anywhere in the schema**. `user_security` and `user_settings` are deliberately excluded from `master_data.ALLOWED_TABLES` so the generic CRUD grid can never reach password hashes.

### 1.3 The three fail-open behaviors

Each is deliberate and documented as a stopgap. Each becomes a behavior change under this migration, and each needs a rollout path rather than a flip.

| Behavior | Where | Today | Under Entra |
|---|---|---|---|
| Admin first-run grace | `auth.py:495` — `if role == "admin" or not admin_exists()` | **Every admin route is open to everyone** while zero admin rows exist | Retire. The grace exists so bootstrap can't lock itself out; Entra plus a seeded admin removes the need |
| Zero-assignment plant scope | `auth.py:456-471` | A role with **no** `role_plants` rows sees **all** plants — restriction is opt-in per role | Invert to fail-closed: no assignment means no access, with an explicit unrestricted flag for roles that genuinely need it |
| Page access | `master_data.py:667`, `web/schedule-data.mts:1731` | Hides tabs in the UI; the endpoints behind them are wide open | Add endpoint-level enforcement. Note the default is **duplicated in three places** and they must move together |

## 2. Target architecture

### 2.1 Request path

```
Browser (on VPN)
    │
    ▼
Container Apps ingress ── Easy Auth (unauthenticatedClientAction: AllowAnonymous)
    │                          │
    │                          ├─ GET /.auth/login/aad  → login.microsoftonline.com → callback
    │                          ├─ GET /.auth/me         → claims JSON
    │                          └─ GET /.auth/logout     → clears cookie + IdP sign-out
    │
    │  authenticated requests arrive with platform-injected headers:
    │      X-MS-CLIENT-PRINCIPAL-NAME   user@newellco.com
    │      X-MS-CLIENT-PRINCIPAL-ID     <entra object id>
    │      X-MS-CLIENT-PRINCIPAL-IDP    aad
    │      X-MS-CLIENT-PRINCIPAL        <base64 JSON of all claims>
    ▼
FastAPI (brain.py)
    │  auth.require_user()  — reads the injected headers, 401 if absent
    │  auth.require_admin() — role lookup, unchanged logic
    │  auth.get_allowed_plants_for_request() — unchanged logic
    ▼
Postgres
```

Authentication is terminated at the ingress. `brain.py` never sees a token, never validates a signature, and stays stateless.

### 2.2 Why Easy Auth rather than MSAL.js

WS3's original MSAL.js plan is dropped for reasons that have hardened since it was written:

- **No frontend bundler exists.** `package.json` is dev-tooling only (`tsc`, `eslint`, `openapi-typescript`). MSAL could not be npm-installed and bundled — it would have to be a CDN `<script>` or a vendored file. `docs/MIGRATION.md:504-515` already flags CDN dependency as a **blocker for network-restricted plant rollout**; adding the authentication library to that risk set is the wrong direction.
- **No new crypto dependency.** MSAL's backend leg needs `PyJWT[crypto]` plus `cryptography`. `requirements.txt` today has ten packages and no third-party crypto at all — password hashing is stdlib `hashlib`. Easy Auth adds zero Python dependencies. (Correction for the record: `docs/MIGRATION.md:90` states `PyJWT==2.10.1` and `cryptography` are in `requirements.txt`. They are not, and never were.)
- **Materially smaller CSP surface.** See §8.
- **Boot-order pressure disappears.** MSAL would have to be synchronously available before `app-entry.mjs` — which is `type="module"`, therefore deferred, with static imports resolving before any of its code runs. Easy Auth needs no library in the page at all.

The trade is portability: this couples authentication to Azure Container Apps. Given Newell mandates Azure hosting, that coupling is acceptable and worth stating rather than discovering later.

### 2.3 The allow-anonymous requirement

**This is the single configuration detail that determines whether the login screen survives.**

Easy Auth's default `unauthenticatedClientAction` is `RedirectToLoginPage`, which bounces the browser to Microsoft **before NIMBUS serves a single byte**. The NIMBUS login screen would never render. To keep it, the app must be configured `AllowAnonymous`:

```bash
az containerapp auth update -g rg-nimbus-dev -n ca-nimbus-dev \
    --unauthenticated-client-action AllowAnonymous
```

`AllowAnonymous` defers the authorization decision to application code — which is exactly what we want, and it means **the actual gate moves into a FastAPI dependency**. Unauthenticated requests reach `brain.py` with no principal headers; a new `auth.require_user()` returns 401 when they're absent.

Two consequences worth having in writing:

- **`GET /health` stays reachable** for the Container Apps liveness probe with no `--excluded-paths` gymnastics. Under `RedirectToLoginPage` the probe would need an explicit exclusion.
- **Static assets are served unauthenticated.** `index.html`, `styles.css`, and the compiled `.mjs` bundles are fetchable without signing in. This is correct and not a leak — they contain no data — but it must be a conscious choice, because every API route now carries its own gate rather than inheriting one from the platform.

### 2.4 Header spoofing

The design rests on the platform stripping client-supplied `X-MS-CLIENT-PRINCIPAL-*` headers. Under `AllowAnonymous` a forged header would otherwise be a complete bypass — worse than today, because the app would *believe* it had verified identity.

Microsoft's documentation is explicit: *"External requests aren't allowed to set these headers, so they're present only if set by Container Apps."*

**Verify it anyway before cutover.** From a machine on the VPN, with authentication enabled:

```bash
curl -H "X-MS-CLIENT-PRINCIPAL-NAME: someone.else@newellco.com" https://<app-url>/security/me
```

The response must **not** identify that user. This is a five-minute test guarding the entire boundary; treat a skipped verification as a blocker, not a formality.

### 2.5 What does not change

`brain.py` stays stateless with no server-side session store · the `Store` → `publish` → render pipeline is untouched · `Util.fetchTraced` remains the single outbound choke point · `require_admin` and `get_allowed_plants` keep their logic and only change their *input* · the localStorage app-data cache (`nimbus.state.v3`) is unrelated to auth and unaffected · single-replica deployment stays viable, since Easy Auth's cookie is validated at the ingress rather than in process.

## 3. Network isolation — VPN-only access

**Authentication answers *who you are*. It says nothing about *where you connected from*.** These are independent mechanisms and both are required: Easy Auth alone leaves the URL reachable from the public internet by anyone with a Newell account; a VPN restriction alone leaves the app open to everyone on the corporate network. Neither substitutes for the other.

One complication to surface early: Microsoft's own framing describes built-in auth as securing "your **external ingress**-enabled container app." Whether Easy Auth is supported on an *internal*-ingress app is **not clearly documented**, and the answer shapes the choice below. Confirm with Microsoft support or a throwaway test app before committing to option C.

| Option | Mechanism | Isolation | Easy Auth compatible | Cost |
|---|---|---|---|---|
| **A. IP allowlist** (recommended first step) | `az containerapp ingress access-restriction set` with the VPN's egress ranges | Moderate — anyone spoofing/originating from those ranges reaches it | **Yes** — ingress stays external | Minutes. No redeploy, no new resources |
| **B. Private endpoint on the environment** (recommended target) | Private endpoint + private DNS zone, public network access disabled | **Strong** — no public route exists | Ingress stays "external" in config, so very likely yes; **verify** | New VNet, subnet, private DNS, endpoint. Workload-profile environment required |
| **C. Internal ingress** | `--ingress internal` + VNet integration | **Strong** | **Unverified** — this is where the external-ingress caveat bites | Ingress mode is **not changeable in place** — needs a new Container Apps environment and a full redeploy |

**Recommendation: A now, B as the target.** Option A satisfies the requirement immediately with no architectural risk and buys time to validate B properly. Do not adopt C without first resolving the Easy Auth question, because discovering the incompatibility after rebuilding the environment is expensive.

### 3.1 What network lockdown breaks

| Thing | Impact | Handling |
|---|---|---|
| Entra redirect | Browser-driven, so it works from the VPN — **but the app registration's redirect URI must match the hostname users actually reach.** Under B or C that is the private hostname, not the `*.azurecontainerapps.io` one | Register both, or register the private one exclusively at cutover |
| `az acr build` / `az containerapp update` | Control-plane operations, unaffected by data-plane restrictions | No change to the redeploy runbook |
| `az containerapp logs show` | Already fails behind the corporate TLS-inspecting proxy (`docs/DEPLOYMENT.md:104`) | Pre-existing; use the portal or `GET /logs/backend` |
| Deploy verification | The corporate proxy caches by URL and will report a stale "failed" deploy | Cache-bust with a random query param and a no-cache header — an established gotcha on this project |
| Health probe | Internal to the Container Apps environment; unaffected by ingress restrictions | No change |

## 4. Identity model — the real migration work

Three documents in this repo state that the SSO cutover is a one-line change to `auth._actor_email()`. **That is true of the plumbing and wrong about the data.**

`user_security.username` is the primary key, and it holds network IDs — the live bootstrap admin is `PJ29587`. Entra's `preferred_username` claim returns `trevor.holton@newellco.com`. **Every existing row is keyed on a different string than the one Entra will supply.** `user_settings` has a foreign key to it, `admin_audit.user_email` records it, `color_wheel.uploaded_by` stores it, and the role join reaches `roles` and `role_plants` through it. Swapping the header read without migrating the data produces a silent mass-provisioning event: every returning user appears brand new, loses their settings, and drops to no role.

### 4.1 Schema changes

```sql
ALTER TABLE user_security ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE user_security ADD COLUMN IF NOT EXISTS entra_oid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_security_lower_email
    ON user_security (lower(email)) WHERE email IS NOT NULL;
```

`email` becomes the identity the application matches on. `entra_oid` is carried alongside as the immutable Entra object ID — not the key, but recorded, because it is the only claim that survives a name change, an email change, or a re-hire. If email churn ever becomes a real problem, `entra_oid` is the escape hatch and it costs nothing to populate now.

Keep `username` as the primary key. Re-keying the table would cascade through `user_settings`, and `username` remains genuinely useful as the human-readable handle the Security tab displays.

### 4.2 Backfill

The mapping from network ID to email is **not derivable from the database** — nothing in NIMBUS knows that `PJ29587` is `trevor.holton@newellco.com`. It has to come from outside:

1. Export the roster from Entra or ask IT for a network-ID → UPN mapping (Graph exposes both `onPremisesSamAccountName` and `userPrincipalName`).
2. Populate `email` for every existing row.
3. Verify no row is left with a NULL `email`, and no two rows collide on `lower(email)`.
4. Only then enable Entra.

A row whose `email` never gets backfilled behaves as an unprovisioned user at first sign-in: they keep their `username` row but land in access-pending with their old role stranded on an unreachable row. Cheap to prevent, tedious to untangle after the fact.

### 4.3 Historical audit rows

`admin_audit.user_email` rows written before cutover hold network IDs; rows after hold email addresses. **This split is accepted, not fixed.** Rewriting historical audit rows to new identifiers defeats the point of an audit log. The doc records the cutover date so anyone reading old rows knows why the format changes. This is the one place where the migration deliberately leaves a seam.

### 4.4 JIT provisioning

```
Easy Auth authenticates user@newellco.com  ✓
        ▼
auth.require_user() → email from X-MS-CLIENT-PRINCIPAL-NAME
        ▼
SELECT ... WHERE lower(email) = lower(<claim>)
        │
        ├─ found ──────────► normal request, role + plants resolve as today
        │
        └─ not found ─────► INSERT user_security
                              (username = <email>, email, entra_oid,
                               first_name, last_name from claims,
                               role = NULL, password_hash = NULL)
                            → access-pending state
```

The insert is idempotent (`ON CONFLICT DO NOTHING` on the email index) because concurrent first requests are entirely normal — a browser fires several API calls during boot.

`role = NULL` is what makes JIT safe: existing code already treats a null role as non-admin, so a freshly-created user has no admin access by construction rather than by a new check. Note that `password_hash` stays NULL, which the schema already permits — an Entra-provisioned user has no local password and cannot use the break-glass path.

### 4.5 The access-pending state

A user who is authenticated but has no role needs a real destination. Today `_domReadyGate()` in `web/app.js:701-724` has two outcomes: show the login screen, or boot the app. This adds a third.

The screen shows their verified email, states that access is pending, and names who to contact. Reusing the login screen's shell is the cheap path — the `FactoryScene` canvas and `.login-panel` layout are already there and already handle a message region via `#login-error`.

There is a rollout hazard: **if `email` backfill is incomplete when Entra is enabled, every affected user lands here at once.** That is the correct failure mode — fail-closed, legible, recoverable — but it is also a support event, which is why §9 sequences backfill and verification ahead of the cutover.

## 5. Login screen

The visual is preserved. What changes is that Microsoft owns the credential prompt.

| Element | Fate |
|---|---|
| `FactoryScene` animated canvas (`web/application-shell.mts:1044+`) | **Kept** |
| `.login-scene` / `.login-panel` split layout | **Kept** |
| `.login-panel-brand` — badge, NIMBUS wordmark, `SCHED CONSOLE` tag | **Kept** |
| `.login-panel-footer` build ID | **Kept** |
| `#login-error` region | **Kept**, repurposed for sign-in failure and access-pending messaging |
| `#login-username`, `#login-password`, their labels | **Removed** |
| `#login-submit-btn` | **Kept** as the element; becomes a navigation rather than a form submit |
| `Session.signIn()` call, `_submit()`, the lowercasing input handler | **Removed** from this path (retained for break-glass, §6.3) |

Sign-in becomes a navigation, not a `fetch`:

```js
window.location.assign('/.auth/login/aad?post_login_redirect_uri=' +
                       encodeURIComponent(window.location.pathname));
```

On a domain-joined machine with a live Entra session this round-trip is usually invisible: the user clicks once and lands in NIMBUS without seeing a Microsoft page. When Conditional Access or MFA applies, Microsoft handles it — which is precisely the value of not owning the password prompt.

### 5.1 The cache-bust guard collision

`runCacheBustGuard()` in `web/app-entry.mjs:76-89` runs **before** `bootEntry()` and, on a build-ID change, calls:

```js
win.location.replace(base + sep + '_v=' + version);
```

`base` is `location.pathname + location.search` with `_v=` stripped. On the return leg from Easy Auth this fires a redirect during boot. Two failure modes to design against:

- It **discards `location.hash`** entirely, and preserves `search` only incidentally. Any state Easy Auth round-trips through the URL is lost.
- It fires exactly once per build ID per session (guarded by `sessionStorage`), so the symptom is intermittent — it appears only on the first load after a deploy, which is the worst possible signature to debug.

This is a known collision to resolve during implementation, not a surprise to discover. The likely fix is to skip the guard when the URL carries Easy Auth callback markers, or to run it only after authentication is settled.

### 5.2 Sign-out and expiry

| Concern | Today | Under Entra |
|---|---|---|
| Sign-out | `localStorage.removeItem('nimbus.session')` + `location.reload()`. Nothing server-side (`web/schedule-data.mts:1780-1784`) | Navigate to `/.auth/logout?post_logout_redirect_uri=/`, which clears the platform cookie, drops the token-store entry, **and performs IdP-side sign-out** |
| Expiry | Client-checked 12h `loggedInAt` comparison, at boot only | Easy Auth cookie lifetime, enforced at the ingress. `Config.SESSION_MAX_AGE_MS` and `Session.isExpired()` become dead code on this path |
| Revocation | None — a forged blob never expires | Entra-side account disable takes effect at cookie refresh |

Note that sign-out becoming a real IdP sign-out is a **behavior change users will notice**: it may sign them out of other Microsoft properties in that browser session. Worth a line in release notes.

## 6. Backend changes

### 6.1 The identity read

`auth._actor_email()` (`auth.py:480-485`) is the swap point its docstring advertises:

```python
def _actor_email(request: Request) -> str | None:
    principal = request.headers.get("x-ms-client-principal-name")
    if principal:
        return principal.strip()
    if _break_glass_enabled():          # §6.3
        raw = request.headers.get("x-user-email") or request.headers.get("X-User")
        return raw.strip() if raw else None
    return None
```

The header fallback must be **conditional on break-glass being enabled**, not unconditional. Leaving it always-on preserves today's bypass verbatim and makes the entire migration cosmetic.

A companion `require_user()` dependency is new — the gate that `AllowAnonymous` moves into application code:

```python
def require_user(request: Request) -> dict:
    """401 unless the platform (or an enabled break-glass path) identified the caller."""
```

### 6.2 Endpoint reclassification

Six `/security/*` endpoints are ungated **by construction** — they have to be, because today they precede identity. Under Entra, identity precedes them, so most of the reasoning inverts.

| Endpoint | Today | Under Entra |
|---|---|---|
| `POST /security/login` | Ungated (establishes identity) | Break-glass only; 403 in production unless explicitly enabled |
| `GET /security/bootstrap-status` | Ungated | Retire with the first-run grace (§6.5) |
| `GET /security/me` | Ungated by design | `require_user`. The design intent — a client can always discover it is *not* admin — is preserved, since callers are authenticated by then |
| `PATCH /security/me` | Ungated, header-scoped | `require_user`. Self-scoped writes become genuinely self-scoped |
| `PATCH /security/me/settings` | Ungated, header-scoped | `require_user` |
| `PATCH /security/me/password` | Ungated, re-verifies current password | Break-glass only — meaningless for Entra users, who have no local password |

Two more are ungated **by omission**, which is a different problem:

| Endpoint | Issue |
|---|---|
| `POST /audit/log` | Writes audit entries with a **self-asserted actor** (`X-User`, defaulting to `"system"`). The optimizer's own audit trail is written by the browser to an unauthenticated endpoint. Needs `require_user` and a server-derived actor |
| `POST /logs/frontend` | Ungated error-log ingest | Needs `require_user` |

Carry forward WS3's protection matrix (`docs/MIGRATION.md:112-114`) for the rest: all mutating routes and all reads exposing business or infrastructure data get `require_user`; **`GET /health` stays open** for the liveness probe.

### 6.3 Break-glass local password

The PBKDF2 machinery stays, gated fail-closed:

```python
def _break_glass_enabled() -> bool:
    """Local password auth. Enabled by default locally; in Azure it requires
    NIMBUS_BREAK_GLASS=1 to be set deliberately."""
    if os.getenv("NIMBUS_BREAK_GLASS") == "1":
        return True
    return not _running_in_azure()      # CONTAINER_APP_NAME et al.
```

Detection should key on a Container Apps environment marker rather than a NIMBUS-defined `NIMBUS_ENV`, so the guard cannot be defeated by forgetting to set a variable. **Fail-closed means the absence of configuration produces the safe outcome** — that property is the entire point, and an env-var-presence check inverts it.

Break-glass exists for a real scenario: Entra outage, tenant misconfiguration, or a VPN change that locks everyone out including the admin who would fix it. Enabling it is a deliberate `az containerapp update` — recorded, revertible, and visible in revision history.

### 6.4 Local development

There is no Easy Auth proxy in front of `uvicorn brain:api` on localhost, so no principal headers ever arrive. Local dev gets identity two ways, both already implied above: break-glass is on by default off-Azure, so the existing login screen and password flow keep working unchanged; and `_actor_email`'s header fallback stays live locally, so the current `x-user-email` path continues to work for scripted testing.

This means **local development is unaffected by this migration** — the same local-first guarantee `docs/MIGRATION.md` makes for every other workstream.

### 6.5 Retiring the first-run grace

`require_admin`'s `or not admin_exists()` (`auth.py:495`) opens every admin route whenever no admin row exists. It exists so bootstrap cannot lock itself out. Under Entra the grace is both unnecessary and dangerous: a database restored without its `user_security` rows would silently grant every authenticated user full admin.

Retire it, and replace it with an explicit seed: `NIMBUS_BOOTSTRAP_ADMIN_EMAIL`, applied idempotently at startup the way `ensure_bootstrap_admin()` already works. (Correction for the record: `docs/MIGRATION.md:284-286` describes the bootstrap password as a hardcoded hash literal in `auth.py`. It is not — `auth.py:571-601` reads `NIMBUS_BOOTSTRAP_ADMIN_PASSWORD` from the environment and seeds nothing when unset.)

### 6.6 `NIMBUS_API_KEY`

`require_api_key` (`brain.py:300-302`) is a shared-secret stopgap that is a **no-op in the pilot** because the variable is unset. Once `require_user` plus `require_admin` gate the same routes with verified identity, it is redundant. Keep it for one release as belt-and-braces, then remove it — tracked in §11 rather than done here, since it touches ~35 route decorators and is better as its own change.

## 7. Authorization — making roles real

### 7.1 Fail-open to fail-closed

Both inversions in §1.3 will lock people out if flipped without a rollout path. `docs/MIGRATION.md:217-221` already carries this warning about `role_plants`; it applies with equal force here.

The safe sequence: add an explicit `roles.unrestricted` boolean; set it `TRUE` for every existing role that currently has zero `role_plants` rows, which **preserves today's behavior exactly**; deploy; then walk roles one at a time, assigning plants and clearing the flag. The inversion becomes per-role and reversible instead of global and abrupt.

### 7.2 Page access needs endpoint enforcement

`roles.settings.pages` hides tabs. The endpoints behind those tabs answer anyone. A user without `masterdata` access simply calls `GET /master-data/plants` directly.

Two things to fix together:

- Add a `require_page(page)` dependency and attach it to the route families corresponding to each of the five page keys.
- The `DEFAULT_PAGE_ACCESS` map is **duplicated in three places** — `master_data.py:667`, `web/schedule-data.mts:1731`, and the Security → Roles tab in `web/plant-and-administration.mts`. All three carry a comment saying to keep them in sync, which is a standing invitation to drift. Adding a fourth consumer without consolidating first makes it worse. Prefer serving the defaults from one source at boot.

### 7.3 Plant scoping

The mechanism already works server-side on `GET /tasks` and `GET /master-data/{table}` for the four tables in `master_data.PLANT_SCOPED_TABLES`. Only its *input* becomes trustworthy. (Correction for the record: `docs/MIGRATION.md:192` lists three plant-scoped tables; `master_data.py:43` has four — `bom_items` was added later.)

`Store.knownPlants()`'s intersection with `Session.allowedPlants()` and the `PlantSelector` filtering stay exactly as they are — they were always UX rather than the boundary, and their own comments say so. What changes is that the boundary behind them is now real.

### 7.4 The audit actor

Three separate mechanisms, all header-derived today, all becoming verified:

| Mechanism | Storage | Change |
|---|---|---|
| `admin_audit` table | Durable Postgres | Actor becomes the verified claim. ~15 `user_email=` threading sites in `brain.py` pass through `_actor_email`, so they inherit the fix without individual edits |
| `_log_admin_action` (`brain.py:511-533`) | Process-local ring buffer, lost on restart | Same inheritance. Durability remains deferred |
| `_audit_log.json` | File on ephemeral `/data` | Same, **plus** `POST /audit/log` needs a gate and a server-derived actor — a claim swap alone leaves the self-asserted-actor hole open |

Worth noting: `_SENSITIVE_LOG_KEYS` (`brain.py:505-508`) already drops `authorization`, `token`, and `cookie` from logged payloads. That was written for a different reason and happens to be exactly right here.

## 8. CSP implications

The Report-Only tag at `web/index.html:17` currently ends `connect-src 'self'; report-uri /csp-report`.

Easy Auth's flow is **browser-level navigation to a first-party path** (`/.auth/login/aad`), not a cross-origin `fetch`. The redirect to `login.microsoftonline.com` is a top-level document navigation, which CSP governs via `form-action` and `navigate-to` — not `connect-src`, and not `frame-src` since there's no iframe.

| Directive | Needed | Why |
|---|---|---|
| `connect-src` | **No change** | `/.auth/me` is same-origin |
| `script-src` | **No change** | No auth library is loaded |
| `frame-src` | **No change** | No hidden-iframe silent renewal — the platform refreshes its own cookie |
| `form-action` | Currently unset, inherits `default-src 'self'` | Add `https://login.microsoftonline.com` if the flow POSTs to Microsoft |

Compare the MSAL.js path, which would have needed a `script-src` CDN origin, `connect-src https://login.microsoftonline.com`, **and** `frame-src` for silent renewal. Easy Auth's CSP cost is close to zero — a genuine argument for it, independent of the others in §2.2.

Two pre-existing facts to keep in view: the tag is Report-Only and nothing is enforced; and `report-uri` is inert twice over — `/csp-report` is not a real endpoint, and `http-equiv` meta CSP ignores `report-uri` regardless. Neither blocks this migration, but neither should be mistaken for working coverage.

## 9. How to go live

Ordered. Each step is independently verifiable, and the sequence is chosen so no step can lock anyone out.

1. **IT: register the app.** One Entra app registration, Web platform, redirect URI `https://<app-host>/.auth/login/aad/callback`, a client secret, admin consent. Record tenant ID and client ID. See §12.
2. **Confirm the claims.** Verify the tenant emits `preferred_username` as the corporate email, and capture `oid`. Do this before the backfill depends on it.
3. **Schema migration.** Add `email`, `entra_oid`, `roles.unrestricted`, and the email unique index. Additive and safe to apply ahead of everything else.
4. **Backfill `email`.** From the Entra roster. Verify zero NULLs and zero case-collisions. **This is the step that determines whether cutover is quiet or a support event.**
5. **Set `roles.unrestricted = TRUE`** for every role with zero `role_plants` rows. Preserves current behavior exactly.
6. **Deploy the code** with Entra support present but break-glass still primary. Nothing changes for users yet.
7. **Enable Easy Auth** with `--unauthenticated-client-action AllowAnonymous`.
8. **Verify header stripping** (§2.4). Blocker if it fails.
9. **Flip the login screen** to the Microsoft button. First user-visible change.
10. **Enable fail-closed:** break-glass off in Azure, header fallback disabled, `require_user` enforced.
11. **Restrict the network** — IP allowlist first (§3, option A).
12. **Retire the fail-opens** — first-run grace, then per-role plant scoping one role at a time.
13. **Later:** private endpoint (option B), `NIMBUS_API_KEY` removal, page-access endpoint enforcement.

Steps 1–8 are invisible to users. Step 9 is the visible cutover. Steps 10–12 are the ones that can lock someone out, which is why they come last and are individually reversible.

## 10. Security posture

| Control | Implementation |
|---|---|
| Authentication | Entra ID via Container Apps built-in auth; terminated at the ingress |
| Identity integrity | Platform-injected `X-MS-CLIENT-PRINCIPAL-*` headers; external requests cannot set them (verified per §2.4) |
| Session integrity | Platform-issued encrypted cookie, validated at the ingress. Replaces the forgeable `localStorage` blob |
| Transport | HTTPS only; `allowInsecure` disabled on ingress |
| Network reachability | VPN-only via IP allowlist, private endpoint as the target state |
| MFA / Conditional Access | Inherited from the tenant. NIMBUS neither implements nor can weaken it |
| Authorization — admin | `require_admin` against a verified identity; first-run grace retired |
| Authorization — plants | `role_plants`, fail-closed, with an explicit unrestricted flag |
| Authorization — pages | `roles.settings.pages`, enforced at endpoints rather than UI-only |
| Audit integrity | Verified actor across all three audit mechanisms; `POST /audit/log` gated |
| Credential storage | No corporate passwords in NIMBUS. Break-glass hashes remain PBKDF2-HMAC-SHA256 at 600k iterations |
| Break-glass | Fail-closed off-by-default in Azure; requires a deliberate, revision-recorded change |
| Secrets | Client secret as a Container App secret. Key Vault deferred (§11) |

## 11. Deferred and not scoped

| Item | Status |
|---|---|
| Key Vault for secrets (`PG_PASS`, Entra client secret) | Deferred. Container App secrets today. Pre-existing item in `docs/MIGRATION.md` |
| Managed identity for Postgres | Deferred. Password auth via `secretref` today |
| Service principal for the SAP sync job | Deferred — the connectors are stubs; no live SAP calls exist to authenticate |
| `_audit_log.json` durability | Deferred. Still file-based on ephemeral `/data`. Entra makes its *actor* trustworthy, not its *storage* |
| `NIMBUS_API_KEY` removal | Deferred one release past cutover (§6.6) |
| Multi-tab sign-out sync | Deferred. Pre-existing gap (`docs/MIGRATION.md:287-290`); the platform cookie improves it incidentally |
| Token-refresh UX | Not needed — the platform refreshes its own cookie. No token lifetime for the app to manage |
| Token store | Not enabled. Only needed for `X-MS-TOKEN-AAD-*` headers, and NIMBUS calls no downstream Microsoft APIs |
| **Entra-group-driven roles** | **Considered and rejected.** Roles and plants stay NIMBUS-admin-managed. Group-driven access would put every access change behind an IT ticket and make the Security tab read-only. Revisit if administration becomes a burden |
| **Credential forwarding to Entra (ROPC)** | **Considered and rejected.** Collecting the password on the NIMBUS page and posting it to Entra's token endpoint fails under MFA and Conditional Access, is blocked by default in most tenants, is discouraged by Microsoft, and would put corporate passwords in NIMBUS's request path. Recorded here so the IT conversation has the reasoning on file |
| Task-ID plant collision | Unrelated to auth, but adjacent in `docs/MIGRATION.md:446-447`. `make_id` is plant-independent; ids collide if a `(production_order, material_number)` pair exists in two plants |

## 12. What IT must provide

Nothing in this document can be completed without these. None can be scripted from inside the repo.

| Item | Detail |
|---|---|
| Entra app registration | One app. Platform: **Web** (not SPA — Easy Auth uses the confidential-client flow). Redirect URI `https://<app-host>/.auth/login/aad/callback` |
| Client secret | Stored as a Container App secret |
| Admin consent | For the default `openid profile email` scopes |
| Tenant ID + client ID | For `az containerapp auth microsoft update` |
| Claim confirmation | Which claim carries the corporate email (`preferred_username` expected), and that `oid` is present |
| Network-ID → UPN roster | The §4.2 backfill input. Graph exposes `onPremisesSamAccountName` and `userPrincipalName` |
| VPN egress ranges | For option A. Or a VNet, subnet, and private DNS zone for option B |
| Conditional Access confirmation | Which policies apply to this app, so sign-in behavior is predictable at rollout |

If the hostname changes under option B or C, the redirect URI must be re-registered — worth flagging to IT up front so it isn't a second round-trip.

## 13. Verification

Run at cutover. Each item proves one layer, and they are ordered so a failure localizes.

1. **Sign-in.** Visit the app on the VPN. The NIMBUS login screen renders (proving `AllowAnonymous`). Click Sign in with Microsoft. Land back in NIMBUS authenticated.
2. **Identity.** `GET /security/me` returns the signed-in user's real email, correct role, and correct `allowed_plants`.
3. **Header stripping.** The §2.4 `curl` with a forged `X-MS-CLIENT-PRINCIPAL-NAME` does **not** impersonate. **Blocker if it fails.**
4. **Unauthenticated rejection.** With no cookie, `POST /task/update` returns 401. `GET /health` still returns 200.
5. **Break-glass is closed.** `POST /security/login` returns 403 in Azure. Set `NIMBUS_BREAK_GLASS=1`, confirm it works, unset it, confirm it closes again.
6. **JIT provisioning.** A user with no NIMBUS row signs in, gets a row created with `role = NULL`, and sees access-pending. An admin grants role and plants; on reload they have full access.
7. **Audit.** A master-data edit writes an `admin_audit` row whose `user_email` is the verified email — not `system`, not a network ID, not `trevor.holton@` hardcoded.
8. **Plant scoping.** A user on a restricted role sees only their plants in `GET /tasks` and in the plant picker. A direct `GET /tasks?plant=<unassigned>` returns 403.
9. **Network.** From off-VPN, the URL is unreachable. From on-VPN, it loads. Cache-bust the check — the corporate proxy caches by URL and will lie.
10. **Sign-out.** `/.auth/logout` clears the session; returning to the app shows the login screen rather than a live session.
11. **Cache-bust guard.** Bump `NIMBUS_BUILD_ID`, deploy, sign in fresh. Confirm the §5.1 redirect does not break the callback — this is the intermittent one, so test it deliberately.
12. **Local dev unaffected.** `uvicorn brain:api` on localhost still boots, still shows the login screen, still accepts a local password.
