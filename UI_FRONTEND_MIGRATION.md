# NIMBUS Visual Re-skin — "Command Band" Frontend Migration

## Context

`Nimbus Dashboard.dc.html` is a design-concept mockup for a new NIMBUS visual system. It keeps NIMBUS's dense, industrial, mono-for-data character but replaces the current **"Foundry Console"** identity (warm off-white + molten-amber accent, light topbar, horizontal tab strip) with a **cool navy/blue "Command Band"** system:

- A permanently **dark navy command band** (brand, confidence ring, alerts bell, Save, avatar) over a **cool gray-blue page** with flat white cards.
- Navigation moves into a **left slide-in drawer** (Dashboard / Scheduling / Labor / Master Data / Admin), replacing the horizontal `.tab-btn` strip.
- A thin **context bar** under the command band carries the plant/line scope.
- **Blue as a highlight + CTA color and navy as chrome fill** — a deliberate departure from the old "One-Accent Rule" (amber never a fill).

**Goal:** apply the mockup's colors, type roles, spacing, and component patterns to the *existing* NIMBUS components **without changing their logic or breaking any interaction** — explicitly including the paste-into-filter, searchable comboboxes, AG Grid copy-range, command palette, and Gantt marquee. Filters may **move on screen**, but the same DOM nodes/IDs/handlers must survive.

> **This plan was audited against the live frontend** (three exploration passes over `web/` + a re-read of the mockup). The audit found the token-remap thesis sound but the structural header swap **under-scoped** — the header's coupling leaks across the stylesheet and into JS in ~10 places. Every gap it surfaced is folded into the steps below (search for **[audit]** markers). None are blockers.

**Scope decisions (confirmed with the user across two rounds):**
1. **Full chrome swap** — build the dark command band **and** the left drawer nav.
2. **Rewrite the design docs** — `DESIGN.md`, `PRODUCT.md`, `.impeccable/design.json` to the navy/blue system.
3. **Keep current fonts** — Archivo / Public Sans / JetBrains Mono. Map the mockup's IBM Plex *roles* onto them; do **not** load IBM Plex.
4. **Re-derive dark mode** for the new palette (command band/drawer stay dark in both themes).
5. **Chrome elements to build:** plan-confidence **ring** (wired to the existing `Confidence` module), the **context bar** (Plant/Lines), and the **user avatar chip**. **Do NOT** build the "PLAN v128 · BASELINE SAP…" version/baseline readout. Keep the Confidence module's existing **line-graph** (it stays in the breakdown popover; only the header shows the ring — see Step 6 for the precise mechanics).
6. **Admin nav = visible + admin-gated.** Add it to the drawer as `.tab-btn[data-tab="admin"]`; this activates the (currently dormant) `Session.isAdmin()` gate automatically. Admins see it, others don't.
7. **"Lines" context pill = context-aware.** It dispatches to the current tab's existing line filter (no new global line-filter data path).
8. **Avatar = initials from first/last name** (icon fallback), keeping `#user-settings-btn` id, click, and hidden-until-login.
9. **Welcome funnel = dropped — the WHOLE `.welcome-splash` overlay.** Remove the plant-pointing arrow, the header dim/glow, **and the greeting-card overlay** (rely on the existing `EmptyState`); keep plant-gating and the auto-dismiss. *(Confirmed: drop the entire overlay, not just the funnel — this also dissolves the `.welcome-splash{z-index:1500}` vs new-drawer stacking conflict; see R3-3.)*
10. **Alerts UI = keep the existing off-canvas drawer** (re-skinned), not the mockup's popover.
11. **Plant picker = keep the inline searchable combobox**, moved into the context bar as-is.
12. **Color repoint = all hardcoded JS color surfaces** (minimap viewport, plant heatmap, confidence chart, status/color dictionaries) — **but leave the main Gantt timeline's line-block coloring alone.**

---

## Design system: the token layer is the lever

NIMBUS's entire theme lives in **one `:root` block** (`web/styles.css:40–90`) plus **one `body.dark` block** (`~4429–4465`). Colors, radii, shadows, transitions are tokens; **fonts and spacing are hardcoded literals** (no `--font-*`/`--space-*` tokens exist). `var(--accent…)` is referenced **~198×** in `styles.css`, neutrals heavily too — so remapping the tokens re-skins most of the *CSS-driven* app automatically. The remaining work is: (a) net-new chrome (command band + drawer + context bar), (b) type/spacing literals that need per-component edits, (c) the components that hardcode colors **in CSS**, and (d) **[audit]** the surfaces that hardcode colors **in JS** — the token remap silently misses these (see Step 7).

### Step 1 — Retune the token palette (`web/styles.css` `:root`, lines ~40–90)

Remap in place (keep the token **names** — that's what preserves the 198 references):

| Token | Current (amber/warm) | New (navy/blue) | Role |
|---|---|---|---|
| `--bg` | `#f5f4ef` | `#e9edf2` | page background (cool) |
| `--bg-elev` | `#ffffff` | `#ffffff` | cards/panels (unchanged) |
| `--bg-subtle` | `#ecebe4` | `#f4f7fa` | table-head / subtle fill |
| `--bg-strong` | `#e0dfd6` | `#eef1f5` | quiet rail tint |
| `--line` | `#d9d8cf` | `#d5dce4` | card/region border |
| `--line-strong` | `#c7c6bd` | `#c6d0db` | stronger border |
| `--fg` | `#1a1b1f` | `#1c2b3a` | body ink |
| `--fg-mute` | `#6b6c73` | `#5d7186` | secondary text / eyebrows |
| `--fg-faint` | `#9a9ba1` | `#8fa1b3` | tertiary / hints |
| `--accent` | `#b8791a` | `#1f5fbf` | links, active outlines, focus (on light) |
| `--accent-hot` | `#a26615` | `#1a4fa0` | accent hover/pressed |
| `--accent-soft` | `#f0dcb4` | `#c9ddf7` | soft accent fill |
| `--accent-wash` | `#faf3e3` | `#dde9f8` | focus-ring glow / soft fill |
| `--primary` | `#1f2430` | `#12263f` | content-area CTA fill (navy) |
| `--primary-hot` | `#2a3040` | `#1f3a5c` | CTA hover |
| `--primary-fg` | `#fcfbf6` | `#ffffff` | CTA text |
| `--ok` / `--ok-soft` | `#2f7a4d` / `#d8ecdf` | `#1e7a4a` / `#dff0e6` | status |
| `--warn` / `--warn-soft` | `#b57a0a` / `#f6e5bd` | `#93610a` / `#f8ecd0` | status (keep AA `--warn-text`) |
| `--err` / `--err-soft` | `#b1362a` / `#f4d5d0` | `#b02a20` / `#f7ddd9` | status |
| `--info` / `--info-soft` | `#2d5f8c` / `#d7e5f2` | `#1f5fbf` / `#dde9f8` | status |

**Keep the 10-color line palette `--l0..--l9` as-is.** DESIGN.md treats it as a closed, CVD-tuned set of 10; the mockup's 8 illustrative dots are close but fewer. Order-block/line distinction is a core product function — do not swap it to the mockup's array. **[audit] Note:** `--l0..--l9` are **never read by JS** — the palette JS actually draws with is the hardcoded `Config.COLORS` array (`application-foundation.mjs:27–30`). Since line colors are kept unchanged, leave both alone; they only need to stay in lockstep if line colors ever change.

**Radii — retune toward the mockup's crisper feel:** `--r-md: 6px → 4px` (cards/buttons/inputs, the mockup's dominant radius), `--r-lg: 10px → 8px` (modals). `--r-sm` (4px) and `--r-xl` unchanged. *(Flag: `--r-md`→4px is a global visual shift; confirm it feels right in-app.)*

**Shadows — restyle onto the navy base** (mockup uses navy-tinted shadows, still flat cards + shadow only on float surfaces, consistent with the Hairline-over-Shadow rule): base the `rgba` on `12,28,48`; bump `--shadow-lg` toward the mockup's modal depth (`0 24px 60px rgba(12,28,48,0.4)`), popover ≈ `0 12px 32px rgba(12,28,48,0.28)`.

### Step 2 — Add the new "chrome" token group (fixed dark in both themes)

The command band and drawer are **always dark**, independent of light/dark theme. Add a dedicated group so they don't ride the `--bg` tokens:

```
--chrome-bg:        #12263f;   /* command band, drawer */
--chrome-bg-deep:   #0c1c30;   /* drawer header, scrim base */
--chrome-panel:     #1f3a5c;   /* raised bits on the band: conf pill, active nav, avatar */
--chrome-border:    #2c4a6b;
--chrome-fg:        #ffffff;
--chrome-fg-mute:   #a7b8ca;
--chrome-fg-faint:  #7e93ab;
--chrome-accent:    #4d9fff;   /* Save button, active-nav rail, plant code */
--chrome-accent-fg: #0c1c30;   /* text on the bright-blue Save button */
```

In `body.dark`, nudge `--chrome-bg`/`--chrome-panel` a touch deeper if needed, but they remain dark in both.

### Step 3 — Define the currently-undefined tokens (decide intentionally)

These are referenced only via inline fallbacks today; while rewriting tokens, define them:
- `--border` → same as `--line`. **[correction] `--border-subtle` is a NEW token** (`#eef1f5`, row dividers) — it is **not referenced anywhere in live code today**, so define it as a token the restyle *introduces*, not a "currently-referenced-via-fallback" one.
- **[audit] `--accent-rgb`** → define to the navy accent RGB `31, 95, 191`. Undefined today with an **amber fallback** at `styles.css:3453` (`.opt-plant-item.selected { background: rgba(var(--accent-rgb,210,140,0),0.08) }`) — after the remap the row *text* goes navy but the tint stays amber unless this is defined.
- **[audit] `--bg-hover`** → define it. Undefined with **no fallback** at `styles.css:2936` (`.lines-nav-item:hover` — a silently-dead highlight today) and with a fallback at `nimbus-intelligence.js:195`; relevant because the new "Lines" affordance may reuse `.lines-nav-*`.
- `--font-mono` → `'JetBrains Mono', ui-monospace, monospace`.
- `--nimbus-amber` / `--amber` (used in `nimbus-intelligence.js:266,316,317,324` and `styles.css:862,923`) → repoint to `--accent`/`--chrome-accent` as appropriate (they're no longer amber).
- `--bg-float` (`styles.css:518`) → a dark float surface; map to `--chrome-panel` or a dark elev token.
- **[audit] Leave-alone / don't-"fix":** `--danger` (`schedule-workbench.mjs:6256`, red fallback `#c0392b`) is harmless semantic red; **`--sap-mono` is NOT undefined** — it's scoped-defined at `styles.css:5261` for `.sap-*` descendants, so don't add it to `:root`.

**⚠ Caveat:** two references have **no fallback** and currently render an empty/invalid border — `index.html:1575` and `schedule-workbench.mjs:7209` (`var(--border)`). Once `--border` is defined they will **start rendering a visible border**. Verify that's intended at those two spots.

### Step 3b — [audit] Header-height variable + repoint the coupled constants

**There is no header-height variable today — `52px` is a hardcoded literal in ~7 places.** A two-tier command band (~46px) + context bar (~40px) ≈ **86px** vs. the current 52px. The main content flow self-corrects (it's flexbox: `.app` / `.tab-panel` / `#ag-grid` / `#vis-timeline` are all `flex:1; min-height:0`), so the breakage is confined to fixed/`calc` constants that bake in `52px`:

- `.alert-drawer { top: 52px }` (`styles.css:1502`) — the alerts drawer will gap/overlap.
- `#sandbox-banner { top: 52px }` (`styles.css:2001`; rule opens 1999) — What-If banner slides under the wrong tier.
- `#toast-stack { top: 64px }` (`styles.css:1788`; rule opens 1787, `z-index:3000`) — toasts render over the taller chrome.
- `.lp-card-scroll { max-height: calc(100vh - 205px) }` (`styles.css:5088`) — labor scroll clips / double-scrollbar.
- `.topbar` / `.brand` height & line-height `52px` (`styles.css:100,119–120`).
- **⚠ [invariant — do NOT repoint] `.sandbox-mode .tab-panel/.alert-drawer { margin-top: 34px }`** (`styles.css:2021–2022`). The `34px` is the **sandbox-banner's own height**, *not* the header height — it must **stay 34px**. Bumping it to `--chrome-h` would double-push the panel/alert-drawer under the taller chrome (a bug the "repoint every 52px constant" wording invites).

**Closure:** add `--band-h: 46px; --context-h: 40px; --chrome-h: calc(var(--band-h) + var(--context-h));` and **repoint the top-anchored header constants above** to `var(--chrome-h)` (± the small existing gaps) — i.e. `.alert-drawer`, `#sandbox-banner`, `#toast-stack`, `.lp-card-scroll`, `.topbar`/`.brand` — **but NOT the `margin-top:34px` rule** (banner-height, invariant). This is the single knob the doc's "TOP BAR section 95–168" scope was missing.

---

## Build the new chrome (the one structural change)

### Step 4 — Command band + context bar + drawer (`web/index.html` + `web/styles.css`)

**Replace** `<header class="topbar">` (`index.html:1099–1139`) with:

1. **Command band** (`.cmd-band`, `--chrome-bg`): hamburger (drawer toggle) · `NIMBUS` brand + "SCHEDULING" mono tag · active-section label · **right cluster** → **confidence ring** · **alerts bell** · **Save** · **avatar chip**.
2. **Context bar** (`.context-bar`, white, `--line` bottom border): the **existing `#header-plant-selector` node moved here verbatim** (all `.hps-*` IDs/classes/behavior intact) + a "Lines" context pill (see Step 5). **No** plan-version/baseline text.
3. **Left drawer** (`.nav-drawer`, `--chrome-bg`) + scrim: `NAVIGATE` section with nav items for `home` / `gantt` / `labor` / `masterdata` / `admin`, a `PLANT` row, and a version footer. Active item gets the inset `--chrome-accent` rail.

**[audit] Preserve these mounts EXACTLY — renaming/moving them silently kills features (or hard-crashes boot):**
- The right cluster **must keep `class="topbar-actions"`** and **must contain `#alert-bell`**. `Confidence._injectBadge()` mounts the ring by `querySelector('.topbar-actions')` (`nimbus-intelligence.js:1374`) and **early-returns at `:1375`** if absent (the `insertBefore` mount is `:1384`); the **admin error-log button** uses the same host, appending via `alert-bell.parentElement` (`application-foundation.mjs:989–991`). **[correction] Both are fully guarded** — the error-log host chain is `getElementById('alert-bell')?.parentElement || querySelector('.topbar-actions') || document.body`, so renaming `.topbar-actions` does **not** crash. The failure mode is *silent*: the Confidence ring disappears (early return) and the error-log button orphans onto the bell's parent or `<body>`. Keep the class → **zero JS change** for these mounts.
- `#alert-bell` (with nested `#alert-badge`) has **no null-guards** — `application-shell.mjs:1259` sets `.onclick` at `App.init` (throws immediately on a rename); `schedule-workbench.mjs:7215–7228` touches `.textContent`/`.style` on **first `renderBell()`** (callers `application-shell.mjs:1318`, `plant-and-administration.mjs:925`, `schedule-workbench.mjs:3612` — near-boot). A typo/rename **throws**. Carry the ids verbatim.
- **Save** is JS-invisible — its only wiring is the inline `onclick="NIMBUS.Persistence.saveAll()"` (`index.html:1136`). Carry the inline handler verbatim (restyle to the bright-blue `--chrome-accent` treatment).
- **Avatar** = `#user-settings-btn`, kept (see JS below).

**JS wiring (state/wiring only — no business logic changes), `web/application-shell.mjs`:**
- **[audit] Drawer nav items are `<button class="tab-btn" data-tab="home|gantt|labor|masterdata|admin">`** — reusing `.tab-btn` + `data-tab` means the existing query sites need **zero JS change**: the click wiring (`:1229–1230`) and the active-class toggle (`:1383–1384`) pick up the drawer buttons automatically, and the admin gate (query `:154`, guarded assignment `if (adminBtn) adminBtn.hidden = !Session.isAdmin()` at `:155`) finds a real node for the first time (next bullet). CSS restyles `.tab-btn` for the vertical drawer + inset active rail — **and must scope-off the inherited responsive/active/chip rules that would otherwise bleed in (see R3-1).**
- **[audit] Admin item — a NEW behavior, not a preserved one:** today the gate targets a **non-existent** node (no `.tab-btn[data-tab="admin"]` exists in the DOM), so `_applyGates` (`:154–155`) is a guarded no-op. Adding the drawer's admin item makes that node *exist*, so the gate **activates for the first time** and hides Admin from non-admins — exactly the desired effect, but state it as newly-lit, not "unchanged." The other Admin entry points stay: Ctrl+Alt+L (`app.js:543`) and the error-log badge (`app.js:304`). Label reuses `tab.admin` ("Admin Cockpit", already in every locale).
- `App.init()` (`~1216–1259`): bind drawer nav items → `App.goto(dataset.tab)` and close the drawer; add drawer open/close + scrim state and the hamburger toggle.
- `App.goto()` (`~1364–1400`): **keep tab-panel toggling identical**; additionally update the command-band active-section label and close the drawer. (Tab IDs unchanged.)
- **[audit] Avatar initials — `SessionUIAdapter._renderUserButton()` (`~162–186`):** render initials into `#user-settings-btn` from `Session.currentUser().first_name` / `last_name` (fields confirmed present, `:179–180`); fall back to username initials, then the `/Images/user.png` icon if no name. **Keep `btn.hidden = !u` (`:166`)** (hidden until login) and the once-wired click (`:168`, opens User Settings). No id change.
- **[audit] What-If mode indicator:** re-home `.sandbox-mode .topbar { border-top: 3px solid var(--warn) }` (`styles.css:1996`) onto the command band; `#sandbox-banner` offset via `--chrome-h` (Step 3b).

### Step 5 — Plant / Lines in the context bar

- **Plant:** relocate the whole `#header-plant-selector` combobox into `.context-bar` — preserves the mandated searchable-combobox pattern and all `PlantSelector` behavior (`application-shell.mjs:861–1044`), which caches `_root = #header-plant-selector` (`:873`) then `#hps-input`/`#hps-dropdown`/`#hps-clear`/`#hps-combobox` (`:874–877`). **[correction] There IS a root guard** — `if (!PlantSelector._root) return;` (`:878`) — so **removing the whole `#header-plant-selector` is safe** (early return), but **renaming any inner id while the root survives is fatal** (`_input.addEventListener` throws at `:880`; also `:897–898`/`:930`/`:940`). Relocate the node **verbatim, inner ids intact**. The drawer's `PLANT` row is a secondary affordance that focuses/opens it.
  - **[audit] Dropdown clipping:** `.hps-dropdown` is `position:absolute; top:calc(100%+4px); z-index:80` anchored to `.hps-combobox` (`styles.css:3866`). The context bar **must be `overflow:visible`** and must not create a stacking context that traps the dropdown below the tab-panel content. Verify the plant dropdown paints over the page during build.
- **Lines (context-aware trigger):** a context-bar pill that dispatches on `App._currentTab` to the current tab's **existing** line filter — no new data path:
  - `home` → click `#line-filter-btn` (`Dashboard._toggleDropdown('line-filter-dropdown','line-filter-btn')`).
  - `gantt` (timeline) → `GanttFilter._toggleLineDropdown()` (`#gantt-flt-line-btn`).
  - `gantt` (orders sub-pane) → the orders line chip dropdown (`_toggleChipDropdown`).
  - `labor` → the group filter (`#lp-group-btn`) or inert if not applicable.
  - `masterdata` / `admin` → inert (hide or disable the pill).

### Step 5b — [audit] Drawer / scrim stacking

`.topbar` is `z-index:100` (a stacking context); the existing alert drawer is `500`, the sandbox banner `450`, and the only scrim today is `.modal-backdrop` (`2000`). Header dropdowns live at `80/90/200/300`.

**Closure:** put the nav scrim + drawer in a high band **below `.modal-backdrop` (2000)** so modals still win — e.g. scrim `1400`, drawer `1401`. On drawer open, **mutually-exclude the alert drawer + command palette** (mirror the FAB's `document.getElementById('alert-drawer')?.classList.remove('open')` at `nimbus-intelligence.js:803`). `Config.ANIM_MS` (`application-foundation.mjs:23`) is documented as coupled to the drawer/`.side-right` 0.22s transition — keep them in sync if you change timing.

### Step 6 — Confidence ring (`web/nimbus-intelligence.js`)

The `Confidence` module exposes `_score` (0–100), `_history`, `_injectBadge()`, `_sparkline()`, and `showBreakdown()`, and auto-recomputes on Store events.

- Rework `Confidence._injectBadge()` (`~1373–1385`) to render the **conic-gradient ring** in the command band (mounted into `.topbar-actions`, see Step 4): `conic-gradient(var(--conf-color) 0 <deg>, var(--chrome-border) …)` where `deg = _score/100*360`, color by threshold (≥80 green / ≥60 amber / else orange, per mockup). Update the badge's inline CSS strings (`nimbus-intelligence.js:228–237`) for the ring/pill.
  - **[audit] Preserve the badge's live wiring** (verified `nimbus-intelligence.js:1373–1386`): (a) keep `badge.addEventListener('click', () => Confidence.showBreakdown())` (`:1380`) — the whole badge is the click target that opens the breakdown popover we're keeping; a ring that renders but doesn't re-bind this **silently loses click-to-open**. (b) Keep the inline `t('tip.schedule_confidence')` title (`:1379`) and `t('ui.confidence_label')` label (`:1381`) — already inline `t()`, so they localize; don't hardcode a string. (c) Keep the `#ni-conf-score` id (`:1382`) — the `plant:selected` reset writes `'—'` to it (`:1357–1358`); if the ring's `%` text replaces that element, update the reset too (the `#ni-conf-spark` clear at `:1359–1360` is already optional-chained and becomes dead — see R2-4).
- **[audit] Precision fix:** the header widget today is a **sparkline canvas** (`#ni-conf-spark`, drawn by `_sparkline()` at `:1509`), **not** a ring. The ring **replaces** the sparkline, so `_sparkline()` becomes dead code (remove or leave unused). The **line graph the user wants kept is the breakdown popover's own chart** (`showBreakdown`, `:1616–1757`) — a *separate* method that stays intact. (Earlier drafts said "keep `_sparkline()`"; that was wrong.)
- **[audit] Color:** the breakdown chart bakes a **semantic threshold triad** `#22c55e / #f59e0b / #ef4444` (`:1517`, `:1618`, `:1699`) — **[decision] repoint to `--ok`/`--warn`/`--err`** (keep the green/amber/red meaning, drive from tokens), consistent with the `.opt-pv-*` verdict decision in R2-1.

---

## Step 7 — [audit] Repoint the JS-drawn color surfaces the token remap misses

The token remap reaches only (a) CSS-classed order blocks, (b) the two `_cssVar`-driven heatmaps (`schedule-workbench.mjs:3896,4203`), and (c) token-based inline styles. Everything that bakes hex **in JS** stays amber/warn-tinted in the new blue theme. **Repoint these to the new palette (per decision) — but leave the main Gantt timeline's line-block coloring alone:**

- **TimelineNav minimap** — `navWindow #ffb84d` viewport rect, `SEV_COLORS`, `navBg`/dividers (`schedule-workbench.mjs:993–1074`). Keep the DarkMode repaint hook that re-draws it (`nimbus-intelligence.js:2237`).
- **Plant-tab utilization heatmap** — hardcoded isDark-forked ramp (`plant-and-administration.mjs:1882–1883, 2018–2026`). (This is *separate* from the dashboard heatmaps in Step "Restyle components", which do read tokens.)
- **Confidence sparkline/breakdown chart** — see Step 6.
- **Status/color/log dictionaries** with raw amber — e.g. buffer `highlight:'#b8791a'` (`schedule-workbench.mjs:1159`), the log-source amber (`plant-and-administration.mjs:5214`). (Categorical colors like purple/teal may stay.)
- **Do NOT touch:** `Config.COLORS` line palette (`application-foundation.mjs:27–30`) and the `lc-*` order-block coloring on the main vis-timeline — "leave the Gantt timeline itself alone." `var(--x, #amberfallback)` sites are safe (the defined token wins over the fallback).

---

## Restyle existing components to the mockup patterns (CSS-first)

Almost everything is CSS-class + token driven, so most of this is `styles.css` + the `index.html` inline `<style>` block (`58–1091`) — **no JS**. Type roles map onto the *kept* fonts: **JetBrains Mono** for uppercase tracked eyebrows / KPI values / codes / times (mockup's IBM Plex Mono role); **Public Sans** for body/controls; **Archivo** for display headings.

- **KPI cards** (`.kpi-tile` + `.k`/`.v`/`.d`; severity `.warn`/`.err`): add `border-top: 3px solid <severity>` keyed off the existing modifier classes (pure CSS — the DOM-built tiles in `schedule-workbench.mjs:3748` need no change). Value `.v` → JetBrains Mono ~24px; label `.k` → mono uppercase 10px tracked `--fg-mute`.
- **Panels** (`.panel`, `.panel-head h3`, `.panel-hint`, `.panel-body`): header eyebrow → mono uppercase 11px tracked; hairline `--border-subtle` divider; flat card with `--line`.
- **Tables:**
  - **AG Grid orders** (`ag-theme-quartz`, `#ag-grid`): re-skin via the Quartz CSS variables (`--ag-header-background-color: var(--bg-subtle)`, header text mono/tracked/`--fg-mute`, row hover, borders `--border-subtle`, font). Keep `row-alert`/`row-warn` row classes → err/warn soft tints. **Do not change the theme class or grid options.**
  - **MasterData** hand-built table (`.md-*`, `plant-and-administration.mjs:2268+`): header row → mono tracked on `--bg-subtle`; code cells → `--accent` mono; keep `md-row-new/-dirty/-deleted` state classes; add the mockup's **status chips** to the STATUS column via the existing `.badge`/soft-tint pattern.
  - **Labor** `.lp-table`: header + gap cells → the mockup's assigned/required soft-tint scheme (`--err-soft`/`--warn-soft`).
- **Status chips / badges** (`.badge`, `.ac-chip`, `.admin-health-chip`, MasterData status): soft-tint bg + matching signal text, mono 9.5–10px uppercase tracked — matches both the mockup and the existing "soft = label" convention.
- **Buttons/inputs:** `.btn-primary` → navy `--primary` fill; `.btn` → white + `--line`; `.seg-btn.active` → navy fill; `.icon-btn` on the band → `--chrome-panel` hover. `.input` focus ring → `0 0 0 3px var(--accent-wash)` (now blue). Filter-trigger buttons `.dash-filter-btn`/`.gantt-line-btn` active → blue border + `--accent-wash` bg + `--accent-hot` text.
- **Heatmaps** (`.hm-*`, `.lh-*`, the dashboard/lateness heatmaps that read `_cssVar`): retune the capacity ramp to the mockup's 5-stop scheme (neutral → info-blue → warn → err); grad legend accordingly. *(The Plant-tab heatmap is JS-hardcoded — see Step 7.)*
- **Line-status list** (`.ls-*`): dot + code (mono) + hours (mono faint) + bar (`--bg` track, severity fill) + pct (severity) — direct match to the mockup's LINE STATUS panel.
- **Modals** (`.modal-*`): white, `--r-lg` (8px), `--shadow-lg`, navy-tinted backdrop; head/body/foot structure unchanged.
- **Gantt (vis-timeline):** re-skin panel bg / time axis / line-group labels to the new tokens (extend the existing vendor overrides). **Keep NIMBUS's line-color scheme for order blocks** — do not adopt the mockup's flat "blue=scheduled" coloring, which would erase line distinction. Adopt the mockup's **legend** styling and apply err/warn tints to late-risk/changeover overlays NIMBUS already computes. Blackout diagonal-hatch treatment stays.

---

## Localize the new chrome (`web/locales/*.js`) — [audit]

Every existing chrome string is localized via `data-i18n`; the new chrome must be too (all 5 languages: en/de/es/fr/pt).

- **Reuse existing keys:** drawer nav labels → `tab.home` / `tab.gantt` / `tab.labor` / `tab.masterdata` / `tab.admin` (all present); plant pill label → `ui.plant_label`.
- **Add new keys** (en + de + es + fr + pt): hamburger `aria-label`, drawer "NAVIGATE" heading, context-bar "CONTEXT" eyebrow, the active-section label (or derive from `tab.*`), the "Lines" pill label, and the drawer version-footer label.
- Wire every new node with `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` so `LangSwitcher` translates them.

---

## Preserve interactivity — the "do not break" contract

Re-skin = **CSS + additive chrome only**. When a control moves, **move the same DOM node** (don't rebuild). Keep every one of these verbatim (from the interaction audit):

- **Paste-into-filter** (the headline concern; **lives in the tab panels, not the header — untouched by the chrome swap**): keep the `.dash-filter-dropdown` › `.dash-filter-paste-input` **above** `.dash-filter-checklist` nesting and every ID (`#gantt-*` / `#tbl-flt-*`: `-btn/-dropdown/-checklist/-paste-input/-textarea/-clear`). Paste wiring lives in `Util.wirePasteToCheckboxes`/`parsePasteList` (`application-foundation.mjs:478–520`) and matches on checkbox **`value`** — don't alter checkbox values or the paste/`input` dual listeners. Same for the PO/Material textareas.
- **Comboboxes:** `#header-plant-selector` and all `.hps-*`; MasterData `_mkCombobox` (`.md-bom-combobox`, reuses `.hps-*` — `plant-and-administration.mjs:2440`); the Security "sec-plant" combobox (also reuses `.hps-*` — `:6806`); the AG Grid `_SearchableLineEditor` (`.nse-*`, `styles.css:1207–1237`). **[audit] Renaming any `hps-*` class also restyles those two secondary comboboxes — restyle, don't rename; and do NOT delete `.hps-*` or `.nse-*` as "header-only" CSS** (both back tab-panel comboboxes that live outside the header).
- **Chrome mounts (Step 4 [audit]):** keep `.topbar-actions`, `#alert-bell`+`#alert-badge`, `#user-settings-btn`, and the Save inline handler.
- **AG Grid:** theme `ag-theme-quartz`, quick filter `#quick-filter`, external chip filters, **copy-range mode** (`nimbus-range-mode`, `ag-cell-copy-flash`, `#orders-copy-badge`), custom editors, saved-layout handlers — all untouched.
- **Command palette** (`#ni-cmd-panel`/`#ni-cp-input`/`#ni-cmd-fab`, `.ni-cp-*`) — restyle only. It is **body-mounted** and hosts the **dark-mode + language toggles** in its footer, so it travels independently of the header. It stays **locked until a plant is selected** (driven by `plant:selected`, which the moved plant selector still emits).
- **Gantt marquee & interactions:** `.nimbus-marquee` on `.vis-panel.vis-center`, hit-testing on vis internals, `#vis-timeline` id — leave vendor `.vis-*` classes alone.
- **Alert drawer** (`#alert-drawer`/`#alert-drawer-body`, `schedule-workbench.mjs:7148–7208`) with inline handlers (`NIMBUS.Alerts.dismissAll()`, `NIMBUS.AlertsUIAdapter.toggleDrawer()`) — kept, re-skinned, offset fixed via `--chrome-h`.
- **Inline `onclick`/`onchange="NIMBUS.…"` handlers** and the global `window.NIMBUS` namespace must remain.

---

## Dark mode re-derivation (`body.dark`, `~4429–4465`)

- Rebuild the `body.dark` token overrides for the new navy/blue palette (deep navy `--bg`, elevated slate cards, blue `--accent` brighter for contrast, signal `-soft` tints darkened). The **chrome tokens stay dark** in both themes.
- Fix the components that hardcode light colors (they won't follow the token remap):
  - `.cw-active-card` (`styles.css:3300`) + its `body.dark` patch — repoint off the amber literal.
  - `.lp-hm-grad` (`styles.css:5187`) — **has no dark override at all**; add one (four hardcoded hex stops → ramp tokens).
  - JS `--amber`/`--nimbus-amber`/`--bg-float` refs (Step 3) and the JS-drawn surfaces (Step 7).
- **[audit] Welcome funnel — DROP the whole `.welcome-splash` overlay** (per decision). Remove the plant-pointing arrow (`WelcomeSplash` `_buildArrowSVG`/`_positionArrow` measuring `#header-plant-selector`, `application-shell.mjs:1076–1142`; its amber stroke/fill at `:1091/1100` goes with it), the **greeting-card overlay itself**, and the three header rules: `.welcome-active .topbar > *:not(#header-plant-selector)` dim (`styles.css:1672`), the plant glow (`:1677`/`:1682`), and `.welcome-active .topbar { z-index:1600 }` (`:1670`). **Keep** the plant-gating (command-palette FAB locked until a plant) and the `plant:selected` → `WelcomeSplash.dismiss()` (`:1171`).

---

## Update the design docs (`DESIGN.md`, `PRODUCT.md`, `.impeccable/design.json`)

Rewrite to the navy/blue "Command Band" system so code and docs stay in sync:
- **Colors:** new navy/blue palette + chrome group; keep the 10-color line palette section.
- **Retire the "One-Accent Rule"** → new rule: **navy is chrome/structure, bright blue is the on-chrome highlight + primary CTA-on-band, content CTAs are navy fill, `--accent` blue is links/active-outline/focus on light.**
- **Add the KPI colored-top-border pattern** (and reconcile the "no colored side-stripe" don't — top-border for KPI severity is now sanctioned).
- **Typography section unchanged** (Archivo / Public Sans / JetBrains Mono kept); document the mono-eyebrow / mono-KPI-value roles.
- **Elevation:** navy-tinted shadows; note command band/drawer are fixed-dark chrome.
- Keep `.impeccable/design.json` in lockstep with the DESIGN.md frontmatter.

---

## Files to change

- **`web/styles.css`** — token `:root` + `body.dark`; **[audit]** `--band-h`/`--context-h`/`--chrome-h` + repoint the far-flung constants (`1502`, `1787`, `1999`, `2021–2022`, `5088`); TOP BAR section (`95–168`) → command band / context bar / drawer; **[audit]** remove the three `.welcome-active .topbar…` rules (`1670–1684`) and re-home the `.sandbox-mode` border (`1996`); drawer/scrim z-index (Step 5b); buttons, inputs, tabs→drawer-nav, `.panel`, `.kpi-tile`, `.seg-btn`, modal, AG Grid Quartz vars, dashboard/heatmap/line-status/chip sections. (Highest-volume file.)
- **`web/index.html`** — replace `<header class="topbar">` (`1099–1139`) with command band + context bar + drawer; **[audit]** keep `class="topbar-actions"`, `#alert-bell`+`#alert-badge`, `#user-settings-btn`, Save inline handler; relocate `#header-plant-selector`; add the Lines pill + drawer + scrim with `data-i18n`; retune the inline `<style>` block (`58–1091`); **bump `NIMBUS_BUILD_ID`** (busts every `?v=` asset URL).
- **`web/application-shell.mjs`** — `App.init` drawer wiring + hamburger/scrim state, `App.goto` active-state + section label + drawer close, **[audit]** `SessionUIAdapter._renderUserButton` initials, **[audit]** remove the whole `WelcomeSplash` overlay (arrow + greeting card), **[audit]** the Lines-pill context dispatcher.
- **`web/nimbus-intelligence.js`** — `Confidence._injectBadge` → ring (keep the `.topbar-actions` mount); retire `_sparkline()`; **[audit]** repoint the breakdown-chart hex; repoint `--amber` refs.
- **`web/schedule-workbench.mjs`** — verify KPI top-border is CSS-only; vis-timeline token re-skin (**order-block line colors left alone**); **[audit]** repoint the TimelineNav minimap + buffer-status hex; keep the alert bell/badge render ids; check the no-fallback `var(--border)` at `7209`.
- **`web/plant-and-administration.mjs`** — **[audit]** repoint the Plant-tab heatmap ramp + log-source amber.
- **`web/locales/*.js`** — **[audit]** add the new chrome i18n keys (en/de/es/fr/pt).
- **`DESIGN.md`, `PRODUCT.md`, `.impeccable/design.json`** — rewrite to the new system.

---

## Verification (end-to-end)

1. **Run the app:** `uvicorn brain:api --port 8000 --reload`, open `http://localhost:8000/`. (No TypeScript touched, so no `npm run build` needed; if any `.ts` is edited, run `npm run build` first.)
2. **Boot clean:** no console errors (proves the `.topbar-actions` mount + `#alert-bell`/`#alert-badge` ids survived). Confidence **ring** renders the live score and opens the breakdown popover **with its line graph**.
3. **Nav:** hamburger opens/closes the drawer + scrim; each drawer item routes (`App.goto`) and highlights via the active rail; the active-section label updates; **Admin appears only for admins and is hidden for non-admins; Ctrl+Alt+L still reaches Admin.**
4. **Alignment:** the alert drawer opens flush under the taller header (no 52px gap/overlap); toasts + sandbox banner aligned; **the plant dropdown is not clipped** in the context bar.
5. **Preserved interactions (must all still work):**
   - Paste a column of order numbers into the **Orders** and **Gantt** filter paste boxes → matching checkboxes/rows select; type-to-filter still narrows.
   - Plant combobox: search + keyboard nav + pinned section; MasterData BOM combobox; AG Grid line-editor search popup.
   - AG Grid **copy-range** (Ctrl+Y toggle, drag-select, Ctrl+C), quick filter, column filters.
   - **Cmd/Ctrl+K** command palette opens/searches; Gantt **Ctrl+drag marquee** selects; double-click-label isolate.
   - **The "Lines" pill opens the correct filter on each tab.**
6. **Color:** no amber islands in the **minimap viewport, Plant-tab heatmap, or confidence chart** — check **light and dark**; the main Gantt line-block colors are unchanged.
7. **Avatar/session:** initials render for a logged-in user; the chip is hidden pre-login; the welcome funnel is gone but a plant is still selectable and the FAB unlocks on `plant:selected`.
8. **Theme:** toggle dark mode (⌘K → Dark Mode / User Settings) — command band stays dark; cards/tables/heatmaps/`.lp-hm-grad`/`.cw-active-card` all themed (no leftover amber/beige).
9. **i18n:** switch language (palette or User Settings) and confirm all **new** chrome text translates in all 5 locales.
10. **Static-asset guard + tests:** `npm run check:static-assets`; run the JS compute/core tests and ESLint. Confirm the app fails fast if a bridge/global is missing (it does at boot).
11. Spot-check the two now-defined no-fallback `var(--border)` sites (`index.html:1575`, `schedule-workbench.mjs:7209`).

**Flagged for confirmation during build:**
- **Welcome splash scope — RESOLVED:** drop the **whole** `.welcome-splash` overlay (arrow + `.welcome-active` dim/glow + greeting card) and rely on `EmptyState`; keep plant-gating + `plant:selected` auto-dismiss. This removes the `z-index:1500` overlay entirely, so it can't sit over the new drawer (see R3-3).
- **`--r-md` 6→4px** global radius tightening — a visible global shift; confirm in-app.
- Whether the "Lines" pill should be **hidden vs. disabled** on tabs with no line filter (masterdata/admin).

---

## Round-2 Audit — additional gaps

A second audit pass (three targeted `web/` sweeps + spot re-verification of the highest-impact items against live code) surfaced the items below, **beyond** the `[audit]` markers already folded into the steps above. The token-remap + header-swap thesis still holds — these are additional **amber-island**, **dark-mode**, and **doc-accuracy** gaps, plus a set of "verified safe" confirmations worth stating so they aren't re-litigated or "fixed." Each item notes the Step it extends and is `file:line`-cited. None are blockers.

> **Headline:** the three items the reviewer worried about most — **Flatpickr**, the **Inspector pane**, and **content spilling out of sections** — came back *almost entirely clean* (see **R2-0**). The real regressions are elsewhere: whole modals and JS surfaces that hardcode the old amber as raw `rgba(184,121,26,…)` (which the `:root` token remap **cannot** reach), and undefined tokens that fall back to **light** colors and break the re-derived dark mode.

### R2-0 — Verified SAFE (no action beyond the noted comment fix) — state so they're not "fixed"

- **Flatpickr re-skins for free.** The `/* Flatpickr calendar — NIMBUS amber theme */` label at `styles.css:2480` is a **stale comment, not stale code** — the calendar theme (light `2480–2555`, dark `4492–4520`) is **almost entirely** `var(--accent/--accent-wash/--accent-soft/--fg*/--bg*/--line)`, so Step 1's remap re-skins it to navy automatically. **[correction] It is not *purely* `var()`:** three neutral hexes are hardcoded — `.flatpickr-calendar{background:#fff}` (`styles.css:2486`, light popup bg) and selected-day `color:#fff` (`2529` light, `4507` dark). These **read correctly** in the new palette (the white popup matches the white `--bg-elev` card; white-on-`#1f5fbf` selected-day is AA), so **no repoint is needed** — but the "no hardcoded hex" phrasing was inaccurate. The selected-day contrast actually **improves** (white on the new `--accent` `#1f5fbf` ≈ 6.1:1 AA, vs the old amber `#b8791a` ≈ 3.6:1). **Only action: fix the misleading comment.** (This covers every Flatpickr instance, including the 14 in Edit-Calendar and the Inspector `start_date` — the vendor popup is one shared themed component.)
- **Inspector pane is safe on both axes.** Layout: `.side-right #right-sidebar` (`index.html:1376`) is `position:absolute; top:0; bottom:0` **inside `.main-row`** (`styles.css:667–678`, `.main-row` is `flex:1; min-height:0; position:relative` within the gantt tab-panel *below* the header), so it tracks the content area — **not** the viewport — and the taller chrome cannot misalign it; body is `.inspector-body{overflow:auto}`. Color: `.inspector-body`/`.insp-*` are fully token-driven. It's in the right sidebar, collapsed on load.
- **Content flow self-corrects.** The main flex chain (`.app`→`.tab-panel`→`#vis-timeline`/`#ag-grid`/`.home-scroll`, all `flex:1;min-height:0`) absorbs the 52→86px delta; every sticky table/section header is `top:0` relative to its **own** scroll container; every JS-positioned popover/menu/tooltip/hover-card uses live `getBoundingClientRect()` + `innerHeight` clamps. `#dep-overlay top:43px` is the minimap height (42+1), not the header.
- **Header fully enumerated; nothing orphaned.** `index.html:1099–1139` contains exactly: `.brand` (`.brand-mark`, `.brand-name` "NIMBUS 🧹", **empty `.brand-ver`** — JS never populates it, safe to drop), `#header-plant-selector`, `nav.tabs` with **only 4** `.tab-btn` (home/gantt/labor/masterdata — **no admin**, **no sub-tab controls**), and `.topbar-actions` (bell/Save/user). There is **no** search box, help button, status/connection dot, reload button, or build-id readout to relocate. All sub-tab switchers (`_ganttSub`/`_laborSub`/`_currentMasterSub`) live in the panels — none is orphaned by the swap. No `data-tab` collision: Interface/Security render `[data-tab]` buttons with class `.sap-tab` (host-scoped), while the global wiring selects `.tab-btn`.
- **CSP + Print safe.** `index.html:17` is `Content-Security-Policy-Report-Only` with `'unsafe-inline'` in `script-src`/`style-src`, so JS-wiring the hamburger/drawer/scrim in `App.init` adds no new-handler or CSP risk. Print (`@media print`, `styles.css:2027–2071`) targets `#modal-print` and hardcodes `#fff` (correct for paper); the Print dialog is a `.modal-backdrop` → gets the modal restyle. **"UtilStrip" does not exist** as a component (utilization = the dashboard `.hm-*` heatmap + the Step-7 Plant-tab heatmap).

### R2-1 — Amber islands the token remap CANNOT reach (extends Step 7 + the component-restyle "Modals" bullet)

The remap only reaches `var(--…)` sites. **~34+ surfaces hardcode the old accent `#b8791a` as raw `rgba(184,121,26,…)` (or sibling warm hex)** and will stay amber/beige in the navy theme. Repoint them to the new palette (restyle **in place** — no refactor onto `.modal-*`).

- **Three prominent modals bypass the `.modal-*` restyle entirely** (the doc's "Modals (`.modal-*`)… structure unchanged" assumes all modals share `.modal-*`; these don't):
  - **Optimize dialog `#modal-optimize`** — card is `.opt-header`/`.opt-body`/`.opt-card` (backdrop `.opt-backdrop`), `styles.css:2360–2652`. Amber header glow (`2373`), amber icon chip (`2385–2386`), warm off-white titles (`2394/2413`), amber active ring (`2603`), and the **amber-gradient primary CTA `.opt-run-btn`** (`2640/2643/2647/2651`). This is the user-facing "Optimize with preview" flow — it would render fully amber in a navy app.
  - **Edit-Calendar modal `#modal-edit-calendar`** — **fully custom** `.cal-edit-backdrop` + `.cal-edit-modal`/`.cal-day-*` (`styles.css:2659–2966`), **not `.modal-*` at all** (backdrop included). Hosts the 14 Flatpickr pickers. Amber plant tag (`2700–2701`), amber "on" toggle glow (`2770`), amber focus rings / time tints (`2810/2833/2851/2966`).
  - **Color-Wheel viewer** — backdrop **is** `.modal-backdrop` (covered). **[correction] `.cw-viewer-modal`/`.cw-viewer-toolbar`/`.cw-search-*`/`.cw-sort-btn`/`.cw-viewer-list`/`.cw-viewer-row` (`styles.css:3664–3740`) is fully TOKENIZED — no amber literals**, so it re-skins for free (an earlier draft wrongly put it in the repoint scope; the `rgba(177,54,42,…)` at `3318` is a semantic err-red delete-hover, not amber). The real color-wheel amber is the **launcher tile `.cw-active-card` at `3300–3648`**: var→amber **gradient** `3303` (`linear-gradient(135deg, var(--accent-wash) 0%, #fdf8ee 100%)`), amber border `3304`, the drop-zone focus-ring **box-shadow** halos `3341/3373` (rings, *not* gradients), glow `3489`/`3648`, and warm text `3582`.
  - **→ Add `.opt-*`, `.cal-edit-*`/`.cal-day-*`, and `.cw-active-card` (NOT `.cw-viewer-*`, which is already tokenized — see the correction above) to the restyle scope** and repoint their literals.
- **Mixed `var(--accent)` → amber gradients (render BLUE-NEXT-TO-AMBER after remap — the worst visual break):** `.opt-header::after` (`styles.css:2379`), `.admin-db-hbar-fill` (`4779`, blends the remapped-blue `--accent` into `#e0a018`), and `.cw-active-card` (`3303`, `var(--accent-wash)→#fdf8ee`). **[correction]** the `.cw-dropzone`/`.ord-dropzone` "hover glows" at `3341/3373` are **box-shadow focus rings, not gradients** — border/bg go blue via `var(--accent)` but the outer `rgba(184,121,26,0.10)` halo stays amber; repoint the halo.
- **Sub-tab pill specificity DEFEATS the doc's `.seg-btn.active → navy` restyle.** Base `.seg-btn.active{background:var(--primary)}` (`styles.css:270–272`, navy — the doc's target) is overridden by the **more-specific** `.gantt-toolbar .seg-btn[data-gantt-sub].active` (`273–277`) and `.labor-toolbar .seg-btn[data-labor-sub].active` (`5033–5037`), which force `background:var(--accent)` (→ **blue, not navy**) plus `box-shadow:0 2px 8px rgba(184,121,26,0.28)` (**amber, unreachable**). → Repoint these two selectors explicitly, or the Timeline/Orders + Labor sub-tab pills read blue-with-amber-glow, inconsistent with every other seg-btn.
- **Gantt dependency-overlay arrows** — `schedule-workbench.mjs:1159` (inside `DependencyOverlay.render()`, module at `:1087`; SVG `#dep-overlay`) is the arrow-marker palette `{ok,tight,gap,critical,highlight}` with **two amber values** `tight:'#b57a0a'` and `highlight:'#b8791a'`. These are a Gantt **overlay** (not line blocks), so repointing them is consistent with "leave the line-block coloring alone." *(See R2-4 — Step 7 currently mislabels this line.)*
- **Accent-glow drop-shadows** on otherwise-blue buttons/badges: `styles.css:276/3489/3648/5036` (`rgba(184,121,26,0.28–0.32)`); **MasterData "new row" amber tint** `4117/4197`.
- **JS-drawn amber badges beyond Step 7's list** — Plant tab (`plant-and-administration.mjs`): bottleneck badge `#f59e0b` (`582`), legend square `#d97706` (`1249`), pale-amber "Plant" line-tag `#fef3c7/#d97706` (`1251`). Command-palette / FAB (`nimbus-intelligence.js`): amber glow `rgba(184,121,26,0.45)` (`56`), warm off-white panel bg `#faf9f6` (`74`) / `#f0ede4` (`150`).
- **Inline `<style>` amber** (`index.html`, block `58–1091`): **OptimizerPreview `.opt-pv-*` verdict triad** — a **semantic green/amber/red set**, not a brand-amber island: green `#16a34a` (`641/764/799`), amber `#ca8a04`/`#a16207` (`643/766/801/818`), red `#dc2626` (`642/765/800`). **[decision] Repoint all three to `--ok`/`--warn`/`--err`** so the verdict stays semantic *and* follows the theme (do **not** blue-wash the warn); **Labor line-hours drill-down `.lh-drill-*`** amber-tinted table (`435/460/475/476/524`); warm tooltip text `.opt-pv-tip` (`698–699`).
- **Cosmetic warm-neutrals** (low severity, listed for completeness): warm off-white text `#f8f5ef`/`#f5f4ef`/`#f5f2ea` (`styles.css:2394/2413/3582/4477`, `index.html:699`); warm-taupe dropdown empty-text `#9a9285` (`schedule-workbench.mjs:3170/3228/3278`); `.md-warn-banner` `#a04000` + `rgba(230,126,34,.3)` (`styles.css:4358/4361`).

### R2-2 — Undefined tokens with warm/LIGHT fallbacks (extends Step 3 — **one is a dark-mode break**)

Step 3 defines `--border/--border-subtle/--font-mono/--nimbus-amber/--amber/--bg-float`, but **four more referenced-but-undefined tokens** render their (warm or light) fallback literally. Define these while rewriting the token layer:

- **`--surface` → `#fff` (dark-mode break):** `plant-and-administration.mjs:565–566` (`var(--surface,#fff)`; **[correction] only 565/566** — `1069/1236` are `var(--text-muted,…)`, the next bullet, not `--surface`) paints **WHITE sticky headers** on the plant capacity / optimization table in the **re-derived dark mode** — exactly the "hardcoded light color that won't follow the remap" class the dark-mode step's `.cw-active-card`/`.lp-hm-grad` fixes exist to catch.
- **`--text-muted`** (same JS sites) — undefined; define alongside `--surface`.
- **`--line-subtle` → `#e8e7e1`:** `styles.css:4169` (`.md-td` MasterData row hairline) stays beige.
- **`--surface-2` → `#f8f7f2`:** `schedule-workbench.mjs:7460` (table zebra stripe) stays warm off-white.

### R2-3 — Header-height coupling: one missed fixed panel (extends Step 3b)

- **Time Machine panel** — `nimbus-intelligence.js:210` `.ni-tm-panel{ position:fixed; top:60px; z-index:500 }` is anchored `60px` = old 52px header + 8px gap. At `--chrome-h` ≈ 86px it lands ~26px **inside** the command band/context bar and, being `z-index:500` > header `100`, renders **over** the chrome — the same failure Step 3b fixes for `.alert-drawer`/`#sandbox-banner`. It's live (command palette → "Time Machine"). → **Repoint `top` to `calc(var(--chrome-h) + 8px)`** and add it to Step 3b's list.
- *Note-only (not a break):* `#ni-cmd-panel{ max-height:calc(100vh - 104px) }` (`nimbus-intelligence.js:73`) — the `104 ≈ 2×52` reads as an old-header assumption, but the panel is **bottom-anchored** (`bottom:80px`), so header growth doesn't move it.

### R2-4 — Doc-accuracy corrections (fix the existing steps' citations)

- **Step 7 mislabels `schedule-workbench.mjs:1159`.** It is **not** a "buffer" dict — it is `DependencyOverlay.render()`'s arrow-marker palette, and it has **two** amber keys (`tight`, `highlight`), not just `highlight`. Correct the label and repoint both (see R2-1).
- **Step 6 Confidence line numbers drift.** `_injectBadge`/`_sparkline`/`#ni-conf-spark` claims are correct, but `showBreakdown()` starts at `nimbus-intelligence.js:1526` (the doc's `1616–1757` is that method's inline `<style>`+HTML). The **kept line-graph** is `#ni-conf-chart` (`:1673`) drawn by a separate `_drawChart` (`:1681`) — re-cite it so "keep the breakdown line graph" points at the right code. Also account for a **second `#ni-conf-spark` reference** — a canvas-clear at `:1357–1360` (fires on `plant:selected`); it's optional-chained (`?.getContext`) so it won't crash after the ring replaces the sparkline, but the "retire `_sparkline()`" note should acknowledge it as now-dead.
- **Step 6 ring color hex** (doc says "per mockup" without values): the mockup uses `#4ddb9f` (≥80) / `#f0c04a` (≥60) / `#f08a6a` (else).

### R2-5 — Do-NOT-touch guardrail (extends Step 7's "Do NOT touch" list)

So a blanket amber sweep doesn't corrupt data-driven color:
- **`schedule-workbench.mjs:6740–6746` color-name → hex map** (`GOLD:'#b8791a'`, `AMBER`, `BEIGE:'#e8dcc8'`, `TAN:'#d4a96a'`, `ORANGE:'#e67e22'`, plus BLUE/GREEN/PURPLE/TEAL) encodes **literal SAP product-color names** — GOLD must stay gold.
- **`Config.COLORS[0]`** (`application-foundation.mjs:27–30`) is intentionally the old amber (line palette — already "leave alone").
- Purple/teal/green **categoricals** (e.g. `plant-and-administration.mjs:585 #6366f1`, `5215/5218/5219`) are fine.

### R2-6 — Minor verify

- Admin/Master/Plant sub-tab strips (`.admin-subtab`/`.sub-subtab`/`.plant-inner-tabs`/`.md-master-subtabs`/`.admin-ov-tabs`) are mostly token-driven (follow the remap), but `.admin-subtab.active{ color:#000 }` (`styles.css:4012–4019`, `body.dark` override `4842`) on the new light `--bg-strong` rail is unverified — check legibility in both themes.

### R2-7 — Additions to the "Verification (end-to-end)" checklist

- Open **Optimize**, **Edit-Calendar**, and the **Color-Wheel viewer** in **navy + dark mode** — no amber card, header, CTA, tag, or toggle survives.
- **No white/beige table headers in dark mode** — specifically the Plant-tab capacity/optimization table (`--surface` fallback).
- **Gantt Timeline/Orders and Labor sub-tab pills read navy**, not blue-with-amber-glow.
- **Dependency-overlay arrows** (toggle `#chk-show-deps`) are not amber.
- The **Time Machine panel** (command palette → Time Machine) sits flush **below** the taller chrome, not over it.

---

## Round-3 Audit — corrections + gaps from the third pass

A third pass (three targeted `web/` sweeps that **verified the earlier rounds' claims against live code**, plus two spot re-reads) produced two kinds of output: **inline corrections** already folded into the steps above (summarized in R3-CH as a change-log so the trail is explicit), and the **new gaps** below. The token-remap + header-swap thesis still holds. Every new claim is `file:line`-cited. **None are blockers.**

### R3-CH — Corrections applied in-place this pass (change-log)

These were fixed directly in the steps they belong to (not left as separate notes):
- **Step 3b:** `.sandbox-mode … margin-top:34px` is **banner-height, invariant** — removed from the "repoint every 52px constant" set (bumping it to `--chrome-h` double-pushes the panel/alert-drawer). Tightened cites: `#sandbox-banner top` is `styles.css:2001`; `#toast-stack top` is `1788`.
- **Step 4:** admin gate is guarded (`if (adminBtn)`, `:155`); the error-log button is **fully guarded** (removed from the "no null-guard, throws at boot" list — its real risk is a *silent* Confidence-ring disappearance if `.topbar-actions` is renamed); plant-selector has a **root guard at `:878`** (whole-selector removal is safe; only inner-id rename is fatal); Confidence early-return is `:1375`. Reconciled the admin-gate contradiction (it **newly activates**, it was not "working unchanged").
- **Step 6:** added an explicit preserve-list for `_injectBadge()` (click→`showBreakdown`, inline `t()`, `#ni-conf-score`); the breakdown triad repoints to `--ok/--warn/--err`.
- **R2-0:** Flatpickr is not *purely* `var()` (hardcoded `#fff` at `2486/2529/4507`) — benign, no action, phrasing corrected.
- **R2-1:** `.cw-viewer-*` is fully tokenized (no amber) — the real color-wheel amber is `.cw-active-card` `3300–3648`; `3341/3373` are box-shadow rings, not gradients; `.opt-pv-*`/Confidence are a **semantic triad** repointed to `--ok/--warn/--err`.
- **R2-2:** `--surface` is only at `plant-and-administration.mjs:565/566` (`1069/1236` are `--text-muted`).
- **Step 3:** `--border-subtle` is a *new* token (referenced nowhere today); added `--accent-rgb` and `--bg-hover`; noted `--danger`/`--sap-mono` as leave-alone.
- **Decisions #9 / dark-mode / Flagged:** the welcome decision is closed to **drop the whole `.welcome-splash` overlay**.

### R3-0 — Verified SAFE / resolved (so they're not re-litigated or "fixed")

- The amber arrow at `application-shell.mjs:1091/1100` is inside `_buildArrowSVG()` (the WelcomeSplash `ws-arrow-svg`) — **deleted** with the funnel (Decision 9). No repoint needed.
- The main flex chain confirmed absorbs the 52→~86px delta: `.app` (`styles.css:93`), `.tab-panel` (`313`), `.main-row` (`644–650`), `#vis-timeline` (`746–748`), `#ag-grid` (`1135`), `.home-scroll` (`319`) all flex-grow with `min-height:0`/`overflow:auto`. The one true viewport-coupled exception is `.lp-card-scroll` (`5088`), already in Step 3b.
- Inspector pane confirmed safe: `.side-right #right-sidebar` is `position:absolute` inside `.main-row` (**`styles.css:644–650`** — the doc's earlier `667–678` is actually the `.side-right` rule) and fully token-driven (`.insp-*`, `1050–1105`).
- The five headline interactions (paste-into-filter `application-foundation.mjs:478/508`, `.hps-*`/`.nse-*` comboboxes, AG-Grid copy-range, body-mounted command palette, Gantt `.nimbus-marquee`) all live **outside** the header and are untouched by the swap.

### R3-1 — Responsive `.tab-btn` rules bleed into the drawer (extends Step 4)

`styles.css:234–244` (`@media max-width:1200px`) sets `.tabs{overflow:hidden}`, `.tab-btn{min-width:0}`, and `.tab-btn span:not(.tab-ico){max-width:90px;text-overflow:ellipsis}`. Because the drawer **reuses `class="tab-btn"`** (the chosen approach — zero JS change), at ≤1200px viewports its labels get force-truncated to 90px with an ellipsis, unwanted in a full-width slide-in drawer. Also riding the class into the drawer: `.tab-btn.active{outline:2px solid var(--accent)}` (`141–148`), the masterdata green-chip rules (`153–164`, dark `4841`), and `.tab-btn[hidden]{display:none}` (`139`, which the admin gate relies on — keep this one). **Closure:** add **drawer-scoped** overrides (e.g. `.nav-drawer .tab-btn span{max-width:none;text-overflow:clip}`, and reset the outline/chip) so none of these bleed into the vertical drawer.

### R3-2 — i18n mechanism (extends "Localize the new chrome")

`LangSwitcher.set()` does `location.reload()` (`nimbus-intelligence.js:2277`), **not** an in-place rescan; the `data-i18n` sweep is a **one-shot** pass in `App.init()` (`application-shell.mjs:1218–1226`) that never re-runs on dynamically-inserted nodes. Consequences the doc must honor:
- New chrome must be **static in `index.html`** (present at boot so the sweep catches it) **or** call `Util.t()` inline. A JS-injected drawer with `data-i18n` inserted *after* init never translates.
- The **active-section label** (updated by `App.goto` on every nav) must be set via inline `Util.t()`, not the one-shot sweep.
- **There is no `data-i18n-aria-label` sweep branch** (only text/title/placeholder) — the hamburger's `aria-label` won't localize via `data-i18n`. Apply it inline with `Util.t()` (as existing `aria.*` keys are, `en.js:1074–1077`) or add a new sweep branch + key.
- The "Lines" pill label can **reuse the existing `ui.lines_section`** key ("Lines", `en.js:349`) rather than a new key. Do **not** key the `.brand-name`/`.brand-ver` strings (intentionally un-i18n'd).

### R3-3 — Overlay-stacking inventory (extends Step 5b)

With the welcome overlay dropped (Decision 9), the plan's `1400`/`1401` scrim/drawer band is now clear of the welcome cluster that otherwise sat inside it: `.welcome-splash{z-index:1500}` (`styles.css:1588`), `.welcome-active .topbar{1600}` (`1670`), `.ws-arrow-svg{1601}` (`1661`) — all removed. Remaining notes: the command-palette **FAB** (`#ni-cmd-fab` z:9990, `nimbus-intelligence.js:37`) and the 9999+ popovers sit **above** the 1400 scrim, so the scrim will not dim the FAB — Step 5b already closes the palette **panel** on drawer open; the FAB staying lit over the scrim is acceptable, but **state it**. Modals correctly outrank the drawer: `.modal-backdrop` 2000, `#toast-stack` 3000, `.cal-edit-backdrop`/`.md-col-menu` 3000, `.cw-viewer-backdrop` 3100, the opt date sub-modals 4000.

### R3-4 — Additional amber/token islands the remap misses (extends Step 7 / R2-1)

- **`--accent-rgb` undefined + amber fallback** — `styles.css:3453` (`.opt-plant-item.selected` row tint stays amber while its text goes navy). Define to `31, 95, 191` (see Step 3).
- **`--bg-hover` undefined, no fallback** — `styles.css:2936` (`.lines-nav-item:hover`, a dead highlight today). Define it; matters if the Lines affordance reuses `.lines-nav-*`.
- **`.nimbus-marquee` amber FILL** — the border (`styles.css:862`) fixes via `--nimbus-amber`, but `863` is a hardcoded `background:rgba(217,119,6,0.10)` the token fix can't reach; the Gantt Ctrl+drag rubber-band stays amber-filled. Repoint `863`.
- **Admin-log amber chips** — `.admin-log-warn` bg `rgba(181,122,10,0.04)` (`styles.css:2189`) and `.admin-log-code` chip bg/border/hover (`2223/2224/2230`, `#b57a0a`) with `var(--accent)` text (`2222`) → navy text on an amber chip after remap.
- **`.opt-header-plant .opt-plant-trigger` warm text `#f8f5ef`** — `styles.css:3582` (outside the doc's `2360–2652` opt-* range).

### R3-5 — Latent admin-health-dot CSS targets a phantom node (extends Step 4)

`.tab-btn.badge-warn/.badge-error::after` ("set by AdminCockpit", `styles.css:4411–4422`) and `#data-integrity-badge` ("appended alongside tabs", `1865`) reference a `.tab-btn[data-tab="admin"]`-style node that has **no JS driver today** (dead styles — grep finds nothing that adds those classes/nodes). Adding a real admin tab-btn to the drawer means a **decision**: wire these health dots to AdminCockpit, or leave them dead. Don't treat the CSS comments as live behavior to preserve.

### R3-6 — Net-new drawer behavior the doc is silent on (recommend; not a regression)

The drawer/scrim/hamburger are new UI. The doc specs open/close/route but not standard drawer a11y: **ESC-to-close, focus-trap while open, `aria-expanded` on the hamburger, body scroll-lock, and focus-restore on close.** This is purely additive — verified the *current* tabs have **no** interactive keyboard behavior (no `aria-selected` sync, no arrow-key nav, no roving `tabindex`; active state is conveyed only by `.active`), so **nothing is lost** by moving to the drawer — but the new component should spec the above rather than inherit nothing.

### R3-7 — Low-severity / optional (cosmetic + hygiene, listed for completeness)

- Warm off-white text `#f8f5ef`/`#f5f4ef`/`#f5f2ea` (`styles.css:2394/2413/3582/4477`, `index.html:699`); warm-taupe empty-text `#9a9285` (`schedule-workbench.mjs:3170/3228/3278`, already in R2-1); the dark tooltip `.adm-help-tip{background:#1a1a2e}` (`styles.css:4960`, intentionally dark).
- **Dead fallbacks that never fire** (their tokens are defined, so reskin correctly — clean up only to avoid confusing future readers): `.perf-warn var(--warn,#b8791a)` (`styles.css:5253`, wrong fallback value), `.btn-optimize:hover var(--accent,#60a5fa)` (`282`, stray *blue* fallback), `.brand-mark var(--accent,#b8791a)` (`index.html:346`), `plant-and-administration.mjs:5216/5472`.
- **Data-color note (don't "reconcile"):** `Config.COLORS[0]='#b8791a'` (`application-foundation.mjs:28`) differs from CSS `--l0='#89419f'` (`styles.css:78`) — both are "leave alone" line-palette entries; flagged so a blanket sweep doesn't try to align them.

### R3-8 — Scope boundary (what was NOT deep-audited)

Print (`@media print`, `#modal-print`, hardcodes `#fff` for paper — correct), the AdminCockpit internal consoles, and mobile/touch layout were assessed as **low functional-loss risk** (token-driven, in-panel, below the header) and **not** exhaustively re-audited. Call these out if they later matter.

### R3-9 — Additions to the "Verification (end-to-end)" checklist

- Click the confidence **ring** → the breakdown popover opens (proves the `:1380` click survived); its title/label are localized.
- Resize to ≤1200px → drawer nav labels are **not** truncated to 90px (proves R3-1 scoping).
- Switch language → the **active-section label** and hamburger **aria-label** translate (proves inline `Util.t()`, not the one-shot sweep).
- Optimize-preview and Confidence "AT RISK" verdicts are `--ok/--warn/--err`-driven — re-skin in dark mode.
- No amber survives in: `.opt-plant-item.selected` tint, the Gantt marquee **fill**, the admin-log chips — check **light and dark**.
