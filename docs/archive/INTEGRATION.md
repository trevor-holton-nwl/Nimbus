I# NIMBUS Login — Integration Guide

Source of truth: `Nimbus Login.dc.html`. Two independent pieces: the **login panel** (plain form markup + a small state object) and the **factory scene** (one self-contained canvas module). No libraries, no assets — everything is inline code plus three Google Fonts.

## 1. Dependencies

- Fonts: `Archivo` (600/700), `Public Sans` (400/500/600), `JetBrains Mono` (400/500/600) — already in your app per design.md.
- No JS dependencies. The scene is vanilla Canvas 2D at 60fps (`requestAnimationFrame` + `ResizeObserver`).

## 2. Layout contract

```
flex row, 100vh
├─ .scene   flex:1, position:relative, border-right: 1px solid var(--chrome-border)
│           <canvas> absolutely filling it
└─ .panel   width:34%, min 400px, max 520px, background: var(--chrome-bg)
```

- Below 860px: hide `.scene`, panel goes full width (CSS media query only).
- The panel is fixed-dark chrome (`--chrome-*` tokens) in both themes — do not theme it.

## 3. Token mapping (hardcoded hex → your CSS vars)

| In the prototype | Your token |
|---|---|
| `#12263f` panel bg | `--chrome-bg` |
| `#0c1c30` scene bg / btn text | `--chrome-bg-deep` |
| `#2c4a6b` panel hairlines, scene strokes | `--chrome-border` |
| `#1f3a5c` machine/belt fills | `--chrome-panel` |
| `#ffffff` / `#a7b8ca` / `#7e93ab` / `#56677c` text tiers | `--chrome-fg` / `-mute` / `-faint` (+ one step fainter) |
| `#4d9fff` Sign In fill, focus rings, laser/scanner beams | `--chrome-accent` |
| `#d5dce4` input borders | `--line` |
| `#1c2b3a` input text | `--fg` |
| `#1e7a4a` / `#f39c12` / `#b02a20` LEDs, error | `--ok` / `--warn-vivid` / `--err` |

Per the CTA/Chrome Color Rule, the Sign In button is `--chrome-accent` fill with `--chrome-accent-fg` text **because it sits on dark chrome** — don't swap it to `.btn-primary` navy.

## 4. Auth wiring (the only stub)

In the logic class, `onSubmit` currently fakes a request:

```js
this.setState({ signingIn: true, error: null });
setTimeout(() => this.setState({ signingIn: false, error: "Directory service unreachable…" }), 1600);
```

Replace with your call:

```js
try {
  await auth.login({ username, password, rememberWorkstation: remember });
  location.assign("/schedule");           // or router
} catch (e) {
  setState({ signingIn: false, error: mapAuthError(e) });
}
```

State fields: `username`, `password`, `remember` (bool), `signingIn` (disables button, swaps label to "Authenticating…"), `error` (string | null → renders the `role="alert"` banner). "Remember this workstation" is UI-only; persist it however your auth layer expects (device token / localStorage key).

Version string in the footer (`NIMBUS v4.2.1`) — inject from your build (e.g. `import.meta.env.APP_VERSION`).

## 5. The scene module

All scene code lives in `initScene()` and is framework-agnostic — it only needs a `<canvas>` and reads nothing from React. To port, lift it into a class:

```js
export class FactoryScene {
  constructor(canvas, opts = {}) { /* body of initScene, `cv` = canvas */ }
  destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); }
}
new FactoryScene(el, { speed: 1, machineCycle: 2.6, spawnGap: 1.2, overlays: true });
```

Config (currently DC props): `animSpeed` (0.2–2.5×), `machineCycle` (s inside the cell), `spawnGap` (s between blanks), `showOverlays` (WO chips).

Internals you may want to touch:
- **`PRODUCTS` array** — each `{ id, w, draw(x, y, k, T, hue) }`. `T(lightness, sat?)` returns a hex in the item's random hue; use it for brand-tintable surfaces, fixed hex for neutrals. BRUTE ignores `T` and picks from a fixed gray/black/white set (`hue % 4`). Add a product = add one entry; it enters the random rotation automatically.
- **`WOS`** — fake work-order IDs shown in overlay chips.
- **Lanes** — `build()` makes 2 lanes when width > 700 and height > 480, else 1.
- **Reduced motion** — `prefers-reduced-motion: reduce` renders a single static frame (raw blank inbound, product outbound, cells idle). Keep this branch.
- **Perf** — DPR capped at 2, `dt` clamped to 50ms, no offscreen allocations per frame. Pause when hidden if you want: wrap `tick` with a `document.visibilitychange` check.

## 6. Accessibility checklist (already in place — keep it)

- `<form aria-label="Sign in to NIMBUS">`, real `<label for>` on both inputs, `autocomplete="username"/"current-password"`, error banner has `role="alert"`.
- Canvas has `role="img"` + descriptive `aria-label`; all HUD text near it is `aria-hidden`.
- Focus: inputs get `--chrome-accent` border + 3px 25%-alpha ring; button gets a 35%-alpha ring. Tab order is DOM order (username → password → forgot → remember → submit).

## 7. Gotchas

- The canvas fills via `ResizeObserver` — its parent must be `position:relative` with a real height, or you get a 0×0 canvas.
- Canvas text uses JetBrains Mono; if fonts load after first paint the labels render in fallback for a frame. Preload the fonts (`<link rel="preload">`) or call `document.fonts.ready.then(...)` before starting the loop if that bothers you.
- Transitions on inputs/button are 0.15s per the system's brisk-motion rule — don't slow them.
