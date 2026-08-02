# NIMBUS Login Screen Redesign — Design

## Context

`Nimbus Login.dc.html` (a DC-format mockup) and `Login INTEGRATION.md` (the accompanying integration guide) were dropped into the repo root with a fully designed replacement for the current login screen: a split layout with an animated Canvas 2D "factory scene" on the left and a dark-chrome sign-in panel on the right. The integration guide specifies the layout contract, token mapping, auth stub, scene-porting notes, and an accessibility checklist. This spec covers folding that design into the existing NIMBUS frontend and wiring it to the real auth backend.

## Current state (verified against the live codebase)

- `showLoginScreen()` in `web/application-shell.mts` builds the login overlay as JS-only DOM (no static `index.html` markup), invoked by the boot gate in `_bootMain` when no session is cached. On success it removes the overlay and calls `App._bootMain()`.
- Auth: `Session.signIn(username, password)` (`web/schedule-data.mts`) already does what the integration guide's `auth.login()` stub describes — `POST /security/login` → `auth.authenticate()` against the `user_security` table (`brain.py` line ~1908, `auth.py`), persists the session to `localStorage`, emits `session:changed`. This is the "correct credentials and table" — no backend changes needed.
- Design tokens: every `--chrome-*` token the mockup's token-mapping table calls for (`--chrome-bg`, `--chrome-bg-deep`, `--chrome-panel`, `--chrome-border`, `--chrome-fg`, `--chrome-fg-mute`, `--chrome-fg-faint`, `--chrome-accent`, `--chrome-accent-fg`) already exists in `web/styles.css`.
- Fonts: Archivo (500/600/700/800), Public Sans (400/500/600/700), JetBrains Mono (400/500/600) are already loaded in `index.html` — covers everything the mockup needs (600/700, 400/500/600, 400/500/600).
- i18n: `sec.login_title`, `sec.username`, `sec.password`, `sec.sign_in`, `sec.login_invalid` already exist in all 5 locale files (`web/locales/{en,de,es,fr,pt}.js`).
- `Config.BUILD_ID` already exists as the single source of truth for version strings elsewhere in the app (CLAUDE.md).

## Decisions made with the user

- **"Remember this workstation" checkbox: dropped entirely.** The mockup's own integration guide called this UI-only ("persist however your auth layer expects"). NIMBUS has no session-only persistence tier today (always `localStorage`), and the user confirmed they don't need this control — so it's cut from the panel rather than wired to fake or new behavior.
- **Footer version string: real `Config.BUILD_ID`**, not the mockup's hardcoded "NIMBUS v4.2.1".
- **Error messaging:** keep the existing deliberately-generic policy for bad credentials (never reveal whether the username itself was wrong) via `sec.login_invalid`. Add one distinction the mockup's own flavor text implied but current code doesn't have: a genuine network failure (fetch itself throws — e.g. offline) shows a distinct "can't reach the server" message rather than being folded into the generic invalid-credentials copy. Client-side empty-field validation (mirroring the mockup's own guard) happens before any network call, using one new i18n key added to all 5 locales.
- **Footer "one step fainter" text color (`#56677c`):** not promoted to a new CSS variable — it's a single-use footer caption in the mockup, inlined as a literal rather than adding a token for one caller.

## Architecture

No new file or module. `web/application-shell.mts` already owns `showLoginScreen` (and `Settings`/`SessionUIAdapter`/`EmptyState`/`PlantSelector`/`App`) — this stays inside that module, preserving the CQ-1 "no new module bodies" boundary.

Two pieces, matching the mockup's own separation:

1. **Login panel** — rebuilt DOM inside `showLoginScreen()`: brand bar (N badge + "NIMBUS" + "SCHED CONSOLE" mono label), sign-in form (username, password, submit), `role="alert"` error banner, footer with real `Config.BUILD_ID`. All copy via `Util.t()`.
2. **`FactoryScene` class** — new class in the same module, ported near-verbatim from the mockup's `initScene()` per the integration guide's own suggested refactor shape (`constructor(canvas, opts)`, `destroy()`). Zero `Store`/DOM dependency beyond the canvas element it's given — matches the project's rule that canvas/compute code never reaches into `app.js` or the reactive `Store`.

## Component breakdown

**Layout** (`.login-screen` root, replacing today's centered-card layout):
```
flex row, 100vh
├─ .login-scene   flex:1, position:relative, border-right: 1px solid var(--chrome-border)
│                 <canvas> absolutely filling it, role="img", descriptive aria-label
└─ .login-panel   width:34%, min 400px, max 520px, background: var(--chrome-bg)
```
Below 860px: `.login-scene` hidden, `.login-panel` goes full width — CSS media query only, no JS.

**Form fields:** username (`autocomplete="username"`, lowercased on input — matches current behavior), password (`autocomplete="current-password"`), submit button (disabled + label swapped to "Authenticating…" while in flight — reuses the `signingIn`-style boolean the current code already tracks via `submitBtn.disabled`).

**Scene internals** (ported as-is per the integration guide): `PRODUCTS` array (8 product draws), `RAW` blank, lane builder (`build()` — 2 lanes above 700×480, else 1), belt/machine/scanner rendering, WO overlay chips (`showOverlays`), reduced-motion branch (renders one static frame — kept per the guide's explicit "keep this branch" note), DPR capped at 2, `dt` clamped to 50ms, `ResizeObserver`-driven `fit()`.

## Data flow / auth wiring

Replace the mockup's fake `setTimeout` stub:
```js
this.setState({ signingIn: true, error: null });
setTimeout(() => this.setState({ signingIn: false, error: "Directory service unreachable…" }), 1600);
```
with the real call already used by the current login screen:
```js
submitBtn.disabled = true; // + label swap
try {
  await Session.signIn(username, password);
  root.remove();
  App._bootMain!();
} catch (e) {
  errEl.textContent = isNetworkError(e) ? Util.t('sec.login_unreachable') : Util.t('sec.login_invalid');
  submitBtn.disabled = false;
}
```
Client-side guard before the call: if username or password is empty, show a new `sec.login_missing_fields` message and skip the network round-trip (mirrors the mockup's own `onSubmit` guard).

## Lifecycle

`FactoryScene` is instantiated once the canvas node is in the DOM (after `root.appendChild(card)` / `document.body.appendChild(root)`), and `destroy()` (cancels the rAF, disconnects the `ResizeObserver`) is called when the login overlay tears down on successful sign-in. In practice `showLoginScreen()` is only invoked once per page load (sign-out reloads the page via `location.reload()`), but calling `destroy()` on success keeps the class correct if that ever changes.

## Testing

Manual only (no existing automated coverage touches `showLoginScreen`, and this is a visual/canvas component — not adding new Node test infra for it):
- `npm run build` (TypeScript compile), then `uvicorn brain:api --reload`.
- Clear cached session, load `/`, verify desktop layout and sub-860px layout (panel full-width, scene hidden).
- OS-level reduced-motion setting → verify the scene renders a single static frame instead of animating.
- Sign-in paths: correct credentials → boots into the app; wrong password → generic invalid-credentials message; empty fields → client-side validation message before any network call; simulate offline (e.g. dev tools network throttling → "offline") → distinct unreachable message.
- Footer shows the real running `Config.BUILD_ID`, not a hardcoded string.

## Out of scope

- Any change to `/security/login`, `auth.py`, or the `user_security` table — the existing backend is already correct.
- "Remember this workstation" — dropped, not deferred; no persistence-tier work follows from this spec.
- Promoting the footer's one-off fainter text color to a new design token.
