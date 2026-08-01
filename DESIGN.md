---
name: NIMBUS
description: Industrial console for production scheduling — dense, precise, built for expert schedulers.
colors:
  command-blue: "#1f5fbf"
  command-blue-hot: "#1a4fa0"
  command-blue-soft: "#c9ddf7"
  command-blue-wash: "#dde9f8"
  deep-navy: "#12263f"
  deep-navy-hot: "#1f3a5c"
  deep-navy-fg: "#ffffff"
  cool-mist: "#e9edf2"
  panel-white: "#ffffff"
  mist-subtle: "#f4f7fa"
  header-rail: "#eef1f5"
  hairline: "#d5dce4"
  hairline-strong: "#c6d0db"
  ink-navy: "#1c2b3a"
  mute-steel-blue: "#5d7186"
  faint-steel-blue: "#8fa1b3"
  signal-ok: "#1e7a4a"
  signal-ok-soft: "#dff0e6"
  signal-warn: "#93610a"
  signal-warn-soft: "#f8ecd0"
  signal-warn-vivid: "#f39c12"
  signal-err: "#b02a20"
  signal-err-soft: "#f7ddd9"
  signal-info: "#1f5fbf"
  signal-info-soft: "#dde9f8"
  chrome-navy: "#12263f"
  chrome-navy-deep: "#0c1c30"
  chrome-panel: "#1f3a5c"
  chrome-border: "#2c4a6b"
  chrome-fg: "#ffffff"
  chrome-fg-mute: "#a7b8ca"
  chrome-fg-faint: "#7e93ab"
  chrome-accent: "#4d9fff"
  chrome-accent-fg: "#0c1c30"
  line-0: "#89419f"
  line-1: "#2d5f8c"
  line-2: "#4f7a3c"
  line-3: "#8b4c7e"
  line-4: "#b14a3e"
  line-5: "#3c6e7a"
  line-6: "#7a5a2a"
  line-7: "#5e498b"
  line-8: "#ae4268"
  line-9: "#4a7a5e"
typography:
  display:
    fontFamily: "Archivo, Public Sans, sans-serif"
    fontWeight: 700
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: 1.45
  label:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "11px"
  control:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "12.5px"
rounded:
  sm: "4px"
  md: "4px"
  lg: "8px"
  xl: "14px"
components:
  button-primary:
    backgroundColor: "{colors.deep-navy}"
    textColor: "{colors.deep-navy-fg}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.deep-navy-hot}"
  button-secondary:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "30px"
  button-secondary-hover:
    backgroundColor: "{colors.mist-subtle}"
  input:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.md}"
    padding: "5px 10px"
    height: "30px"
---

# Design System: NIMBUS

## 1. Overview

**Creative North Star: "Command Band"**

NIMBUS is a control-room instrument, not a consumer app that happens to render a Gantt chart. The chrome is a permanently-dark navy command band and left drawer wrapping a cool gray-blue page of flat white cards, with a bright signal-blue accent for anything that needs to read as "the important action" — the visual grammar of a mission-control console, not a SaaS dashboard. Every surface is dense with real information (order counts, due dates, line utilization) because the people using it are experts scheduling production every day, not casual visitors who need to be onboarded gently.

The system is still deliberately restrained on structure — hairline borders as the default separator, shadows reserved for the handful of surfaces that genuinely float above the page (modals, popovers). But color now does more work than the old single-accent system: navy is chrome/structure, a bright blue is the on-chrome highlight and CTA, and a darker navy fill is the CTA anywhere in the light content area (the exact rule is in §2, "The CTA/Chrome Color Rule"). It rejects the same two failure modes as before — the bubbly, gradient-hero gloss of generic consumer SaaS, and the dated grid-of-forms clunkiness of legacy ERP screens. NIMBUS sits between them: modern craft applied to an industrial, information-dense tool.

**Key Characteristics:**
- Navy chrome (command band + left drawer) fixed dark in both light/dark theme, wrapping a cool gray-blue content area; bright blue is the on-chrome CTA/highlight
- Hairline borders and flat surfaces by default; shadows are the exception, not the rule — now navy-tinted rather than the old warm tint
- JetBrains Mono for anything numeric or machine-generated (IDs, timestamps, stat figures), including the Mono-Eyebrow label and Mono-KPI-Value numeric patterns used throughout KPI tiles and panel headers
- Brisk, exact motion — nothing lingers, nothing bounces

## 2. Colors

The palette is a cool navy/blue console: a permanently-dark chrome layer (command band + left drawer) wrapping a light blue-gray content area, plus a fixed 10-color palette reserved for distinguishing production lines on the Gantt.

### Chrome (Command Band / Drawer — new token group)
- **Chrome Navy** (`--chrome-bg` `#12263f`) / **Chrome Navy Deep** (`--chrome-bg-deep` `#0c1c30`): the command band and left nav-drawer's structural fill. **Fixed dark in both light and dark theme** — this is chrome, not themed content. See §4 Elevation for why that's deliberate.
- **Chrome Panel** (`--chrome-panel` `#1f3a5c`): raised surfaces inside the chrome — the confidence pill, the active nav-drawer row, hover states on the hamburger/icon buttons.
- **Chrome Border** (`--chrome-border` `#2c4a6b`): hairlines inside the chrome (brand divider, drawer section rules).
- **Chrome Foreground** (`--chrome-fg` `#ffffff`) / **Chrome Foreground Mute** (`--chrome-fg-mute` `#a7b8ca`) / **Chrome Foreground Faint** (`--chrome-fg-faint` `#7e93ab`): the same three-tier text/icon mute pattern as the content area's Ink Navy / Mute Steel Blue / Faint Steel Blue, recalibrated for a dark background.
- **Chrome Accent** (`--chrome-accent` `#4d9fff`, text pairing `--chrome-accent-fg` `#0c1c30`): the bright-blue on-chrome highlight — the Save button in the command band, the active nav-drawer row's inset rail, the active drawer tab's icon. This is the "chrome CTA" in the rule below.

### Primary (accent)
- **Command Blue** (`--accent` `#1f5fbf` light / `#4d9fff` dark): links, active-tab outlines, focus rings, and the filter-trigger "active" treatment — all in the light content area. Same blue family as Chrome Accent, but a distinct token with a distinct job (content vs. chrome — see the rule below).

### Secondary (content-area CTA)
- **Deep Navy** (`--primary` `#12263f` light / `#2b4f78` dark): the content-area action color. Used for primary CTA buttons (`.btn-primary`) and the active state of segmented controls (`.seg-btn.active`) everywhere OUTSIDE the command band. Unlike the old system, Deep Navy is no longer identical light/dark — dark mode gets its own lighter navy so a CTA still reads as a distinct "action" color against a dark page.

### Neutral
- **Cool Mist** (`--bg` `#e9edf2` light / `#0a1420` dark): page background.
- **Panel White** (`--bg-elev` `#ffffff` light / `#1c2a3c` dark): cards, panels, inputs, modals — anything that sits one level above the page.
- **Mist Subtle** (`--bg-subtle` `#f4f7fa` light / `#16212f` dark): input/subtle fills, hover states on buttons and tabs.
- **Header Rail** (`--bg-strong` `#eef1f5` light / `#101b28` dark): structural tint (table heads, quiet rails).
- **Hairline** (`--line` `#d5dce4` light / `#263850` dark) / **Hairline Strong** (`--line-strong` `#c6d0db` light / `#344965` dark): the default border — NIMBUS still separates regions with a 1px line, not a shadow.
- **Ink Navy** (`--fg` `#1c2b3a` light / `#e8edf3` dark): body text.
- **Mute Steel Blue** (`--fg-mute` `#5d7186` light / `#90a2b8` dark) / **Faint Steel Blue** (`--fg-faint` `#8fa1b3` light / `#56677c` dark): secondary and tertiary text.

### Semantic
- **Signal OK** (`--ok` `#1e7a4a` light / `#3d9962` dark), **Signal Warn** (`--warn` `#93610a` light / `#d09010` dark, with a vivid `#f39c12` light / `#e0a018` dark variant for higher-urgency warnings), **Signal Err** (`--err` `#b02a20` light / `#d94a3a` dark), **Signal Info** (`--info` `#1f5fbf` light / `#4a88c8` dark) — each paired with a `-soft` tint for badge/alert backgrounds. Note: in light mode, Signal Info is now byte-identical to Command Blue (both `#1f5fbf`) — a coincidence of the new palette, not a merge of the two concepts; dark mode keeps them distinct (`#4a88c8` vs `#4d9fff`). These remain the only places color carries meaning beyond chrome/CTA; keep new status colors inside this set rather than inventing a fifth.

### Data / Line Palette
- **line-0 … line-9**: a fixed 10-color qualitative palette (`#89419f #2d5f8c #4f7a3c #8b4c7e #b14a3e #3c6e7a #7a5a2a #5e498b #ae4268 #4a7a5e`) used exclusively to distinguish production lines in the Gantt, utilization strip, and dashboard charts. **Unchanged by the Command Band re-skin** — saturated but not neon, chosen to stay distinguishable under common color-vision deficiencies — treat this as a closed, ordered set; don't recolor a line outside it. (line-0 and line-8 were re-derived 2026-07-13, under the prior amber-accent system: line-0 was previously byte-identical to that system's single accent color, and line-8 was a near-duplicate of line-4. Both stay unchanged in this re-skin — line-0's now-purple value has no relationship to the new Command Blue accent, so there's nothing left to reconcile there.)

### Named Rules
**The CTA/Chrome Color Rule** (replaces the old One-Accent Rule below — this re-skin explicitly departs from "one accent color, never a fill"). Four zones, four jobs — a reader should be able to place any button from this alone:
1. **Navy is chrome/structure.** `--chrome-bg`/`--chrome-panel` (deep navy) fill the command band and left drawer — the app's permanent, always-dark structural layer. Never themed light/dark (see §4 Elevation).
2. **Bright blue (`--chrome-accent`) is the on-chrome highlight *and* the primary CTA that lives ON the band/drawer.** The Save button in the command band, the active nav-drawer row's inset rail, the active drawer-tab icon — anything that needs to pop against the dark chrome.
3. **Content-area CTAs are navy fill.** `.btn-primary` and `.seg-btn.active` anywhere in the light content area use `--primary` (Deep Navy) as a solid fill — not blue. This is the biggest visual departure from the chrome: the same "primary action" semantic gets a different color depending on whether it's on the dark band or the light page.
4. **`--accent` blue is for links, active-tab outlines, and focus rings in the light content area** — never a solid CTA fill there. Same hue family as Chrome Accent, separate token, separate job: `--accent` marks "this is active/focused," `--primary` marks "click this to act," `--chrome-accent` marks "the important thing on the dark band."

To place any button: is it inside `.cmd-band`/`.nav-drawer` (dark chrome)? → bright blue (`--chrome-accent`) if it's the CTA, a chrome neutral otherwise. Is it in the light content area? → navy fill (`--primary`) if it's the primary action, hairline-bordered white if it's secondary, `--accent` outline/ring if it's a link/focus/active-tab marker — never a blue fill there.

**The One-Accent Rule (retired).** The old rule — a single accent color (Foundry Amber) that was never a background fill, only a line/outline/icon/focus ring — no longer holds. This re-skin intentionally introduces a second, filled CTA color (Deep Navy) and a chrome-scoped bright-blue CTA (Chrome Accent) alongside the outline-only accent. Kept here as a historical marker, not an active rule — see The CTA/Chrome Color Rule above for what replaced it.

**The Hairline-Over-Shadow Rule.** Regions are separated by a 1px border by default. A shadow is a deliberate signal that something is floating above the page (a modal, a popover), not a decorative default on every card.

**The Dark-Mode Remap, Not Reversal.** Dark mode re-lights the same navy/blue structure rather than inverting it: `--accent` brightens (`#1f5fbf` → `#4d9fff`) for legibility on a dark page, and `--primary` gets its own lighter navy (`#12263f` → `#2b4f78`) rather than reusing the light-mode value — so content-area CTAs still read as a distinct "action" color against a dark background (a change from the old system, where Deep Slate was literally the same hex in both themes). The `--chrome-*` tokens do not change between themes at all — the command band and drawer are fixed-dark chrome, a deliberate structural exception (see §4 Elevation). Dark-mode coverage elsewhere is still incomplete: some newer components hardcode light-mode colors, and a few token names may be referenced in dark-mode CSS without a matching `:root` definition. Check `:root` and `body.dark` in `styles.css` before assuming a token exists.

## 3. Typography

**Display Font:** Archivo (falls back to Public Sans, sans-serif)
**Body Font:** Public Sans (falls back to system-ui, sans-serif)
**Label/Mono Font:** JetBrains Mono (falls back to monospace)

**Character:** A geometric display face paired with a humanist body face — enough contrast to feel designed, not two similar sans-serifs pretending to be different weights of the same thing. Mono is a third, distinct voice reserved for anything that reads as data rather than prose. **Unchanged by the Command Band re-skin** — no new font was introduced; only color changed.

### Hierarchy
- **Display** (700, h1–h4, letter-spacing -0.015em): Archivo. Page/section titles, the brand mark, modal headings.
- **Body** (400–500, 13px base, line-height 1.45): Public Sans. The default for nearly everything — this is a dense-information product, not an editorial one, so body text is smaller and tighter than a marketing site's.
- **Label** (600–700, 11px, uppercase, letter-spacing 0.04–0.08em): Public Sans (occasionally inherits Archivo, since bare `h3`/`h4` tags default to the Display font unless overridden). Plain uppercase section headings and form-field labels that aren't meant to read as a mono "readout" — e.g. `.form-row label`, `.side-head h4`, `.insp-card h4`, `.ac-cat-head`. Distinct from the mono-eyebrow pattern below.
- **Control** (400–500, 12.5px): Public Sans. Interactive chrome that isn't quite body prose and isn't a tracked-uppercase label — buttons, tabs, inputs, filter dropdowns. This is the app's most common text size by volume (`.btn`, `.tab-btn`, `.input` all ship at it); documented here because it's an established step, not a one-off.
- **Mono** (400–700, 8.5–14px): JetBrains Mono. IDs, timestamps, stat numbers, changeover/duration figures, version strings — anything the user would expect to line up in a monospaced column. Two specific sub-patterns are now used extensively enough across the re-skinned chrome and KPI surfaces to name directly:
  - **Mono-Eyebrow** (9.5–11px, 600–700 weight, uppercase, letter-spacing 0.06–0.1em): the tracked mono "readout tag" used for panel section headers (`.panel-head h3`), KPI category labels (`.kpi-tile .k`), the command-band brand tag (`.cmd-brand-tag`), drawer section eyebrows (`.nav-drawer-eyebrow`), and AG Grid column headers (`.ag-header-cell-text`) — anywhere a label should feel like an instrument readout rather than a plain section title. Both this and the sans-serif Label role above are uppercase-tracked; Mono-Eyebrow is reserved for chrome/structural or identifier-like labels specifically.
  - **Mono-KPI-Value** (13–24px, 600 weight, tight letter-spacing -0.02em): the large numeric readout in KPI/stat tiles — `.kpi-tile .v` (24px, Dashboard), `.lp-kpi-val` (13px, Labor Planning), `.ac-stat-num` (14px, Admin Cockpit). Almost always paired with a Mono-Eyebrow label directly above or beside it, and on the Dashboard, with the colored top-border severity pattern (see §5 Components → KPI Tiles).

### Named Rules
**The Mono-Means-Machine Rule.** If a string was generated, measured, or timestamped rather than written by a person, it renders in JetBrains Mono. This is the fastest visual cue in the system for "this is data, not copy." The Mono-Eyebrow/Mono-KPI-Value pairing on every KPI tile is the most consistent, highest-visibility application of this rule today.

## 4. Elevation

NIMBUS is flat by default in the content area. Depth is conveyed almost entirely through the Hairline border, not shadows — a panel sits next to another panel, not above it. Shadows are reserved for surfaces that are genuinely transient or floating: modals, popovers, dropdowns. Shadows are now **navy-tinted** (base `rgba(12,28,48,…)`) rather than the old warm-neutral tint, matching the cool palette; dark mode keeps a plain black tint (`rgba(0,0,0,…)`), unchanged from before — a dark background doesn't need a hue-matched shadow to read as "floating."

**Structural exception — the chrome is fixed-dark regardless of theme.** The command band (`.cmd-band`) and left nav drawer (`.nav-drawer`) are always the dark navy `--chrome-*` palette, in both light AND dark mode — they do not participate in the light/dark toggle at all (the `--chrome-*` tokens are defined once in `:root` and are never redefined in `body.dark`). This is deliberate: the Command Band chrome is meant to read as one fixed console shell regardless of the content area's theme. It is not a bug or an incomplete dark-mode pass — don't "fix" it by adding chrome overrides to `body.dark`.

### Shadow Vocabulary
- **sm** (`0 1px 2px rgba(12,28,48,0.06)` light / `rgba(0,0,0,0.35)` dark): the barest lift — icon-button hover states, small popovers.
- **md** (`0 2px 6px rgba(12,28,48,0.08), 0 1px 2px rgba(12,28,48,0.04)` light / `0 2px 6px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.28)` dark): dropdowns, tooltips, small floating panels.
- **lg** (`0 24px 60px rgba(12,28,48,0.4), 0 12px 32px rgba(12,28,48,0.28)` light / `0 8px 24px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.3)` dark): modals — the only "clearly floating above everything" surface in the system. Light mode's `lg` step got noticeably deeper in this re-skin (a 24px/60px spread, vs. the old 8px/24px) to match the new chrome's modal depth; dark mode's `lg` did not change.

### Named Rules
**The Floating-Means-Floating Rule.** A shadow above the `sm` step is reserved for something the user should read as temporarily suspended over the interface (a modal, an overlay). Don't reach for `shadow-lg` on a static panel just to make it feel "premium" — that's the legacy-ERP-meets-consumer-SaaS mistake this system explicitly avoids.

## 5. Components

Components are brisk and exact: 4px corner radius almost everywhere (8px for modals), 1px hairline borders, minimal or no shadow, and fast 0.12–0.18s transitions. Nothing bounces or lingers — a hover state should feel like a mechanical switch registering, not a soft fade.

### Buttons
- **Shape:** 4px radius (`--r-md`), 30px height by default, 38px for `.btn-lg`, 24px for `.btn.sm`.
- **Primary** (`.btn-primary`): Deep Navy background, white text, Deep Navy border; hover darkens to `#1f3a5c` (light) / lightens to `#35618f` (dark) — this is the content-area CTA. **Exception:** inside the command band, the Save button (`.topbar-actions .btn-primary`) instead fills bright Chrome Accent blue with dark-navy text — see the CTA/Chrome Color Rule in §2.
- **Secondary/default** (`.btn`): Panel White background, Hairline border, Ink Navy text; hover fills with Mist Subtle.
- **Ghost** (`.btn-ghost`): transparent background, same border/text logic.
- **Icon buttons** (`.icon-btn`): 30px square, transparent by default, Mist Subtle + Hairline on hover; carries an optional Signal-Err notification dot.
- **Segmented** (`.seg-btn`): pill-free, Hairline-bordered toggle group; the active state fills Deep Navy **uniformly everywhere it appears** — including the Gantt's Timeline/Orders sub-toggle and the Labor sub-tabs, which no longer get a special-cased colored glow (that was an amber-only treatment, retired in this re-skin — every `.seg-btn.active` now reads as one component).

### Tabs
- **Style:** transparent by default, 4px radius, Mute Steel Blue text. Active tab gets Mist Subtle fill, a Hairline border, and a 2px Command Blue (`--accent`) outline — the outline (not the fill) is what marks "current tab." Note: the app's top-level navigation itself moved into the dark left drawer in this re-skin (`#nav-drawer .tab-btn` gets its own dark-chrome treatment — an inset Chrome Accent rail instead of an outline, per the CTA/Chrome Color Rule). The base `.tab-btn` styling described here now governs in-content sub-tab strips: Admin, Master Data, the Gantt's Timeline/Orders toggle, Labor.
- **Named sub-tints:** unchanged by this re-skin — the Admin and Master Data top-level tabs each still carry their own idle/hover/active tint (cool gray for Admin, green for Master Data) so a user can locate them by color before reading the label, even though neither tint appears anywhere else in the system.

### Filter-Trigger Buttons
- **Style:** Hairline border, transparent/`--bg-elev` fill by default (`.dash-filter-btn`, `.gantt-line-btn` — the Dashboard's and Gantt's Line/Color/Form filter-dropdown triggers).
- **Active:** a soft-tint treatment distinct from both the Tabs outline and the Segmented fill — Command Blue (`--accent`) border, `--accent-wash` background, `--accent-hot` text, 600 weight. Shared verbatim between `.dash-filter-btn.active` and `.gantt-line-btn.active` (2026-07-13 — the latter previously referenced an undefined `--amber` token; `--amber` is now defined, as an alias for `--accent`, as part of the Command Band re-skin) so every filter-trigger button in the app reads as one component regardless of which screen it's on.

### KPI Tiles
- **Style:** `.kpi-tile` — Panel White background, Hairline border, 8px radius (`--r-lg`), and a **3px colored top-border** (`border-top: 3px solid <severity>`) that defaults to a neutral Faint Steel Blue and switches to Signal Warn or Signal Err via `.kpi-tile.warn` / `.kpi-tile.err`. This is a **sanctioned exception** to the "no colored side-stripe" don't in §6 — a top-border reads as a status flag on a horizontal card, not a directional accent stripe on a list row; `border-left`/`border-right` stripes are still off-limits. The label (`.kpi-tile .k`) uses the Mono-Eyebrow pattern; the number (`.kpi-tile .v`) uses Mono-KPI-Value (see §3 Typography).

### Inputs
- **Style:** Panel White background, Hairline border, 4px radius, 30px height (60px min for textarea).
- **Focus:** border shifts to Command Blue plus a 3px `--accent-wash` glow (`box-shadow: 0 0 0 3px var(--accent-wash)`) — the same accent that marks "active tab" marks "active input."
- **Date/time:** always Flatpickr, never a native `<input type="date">`/`datetime-local`/`time` — see `CLAUDE.md`'s Flatpickr standard for the exact per-type configs. The one sanctioned exception is the AG Grid inline date-cell editor.

### Modals
- **Corner Style:** 8px radius (`--r-lg`).
- **Background:** Panel White, Hairline border, `shadow-lg`.
- **Structure:** head (14px/18px padding, Hairline bottom border) → body (18px padding, scrollable) → foot (12px/18px padding, Mist Subtle background, Hairline top border, right-aligned actions).
- **Backdrop:** `rgba(12,28,48,0.42)` with a 3px blur — navy-tinted now (was warm near-black); still dark and blurred enough to focus attention without a heavy black scrim.

### Toasts / Badges
- **Toasts:** solid Signal color fill (`ok`/`err`/`warn`/`info`), white text, slide-and-fade transitions.
- **Badges:** `-soft` tint background with the matching Signal text color — the soft/solid split is how NIMBUS distinguishes "a status label" (soft) from "an ephemeral notification" (solid toast).

### Signature Component: The Gantt (vis-timeline)
The production timeline is a third-party vis-timeline instance re-skinned to the token system rather than left in its default library styling — panel backgrounds, the time axis, and line-group labels are all explicitly overridden (especially in dark mode, where the library's own white background is force-overridden). Blackout blocks render as a diagonal red hatch, not a solid fill, so they read as "unavailable" rather than "an order." This re-skinning discipline — never ship a third-party component in its default look — is itself a rule worth carrying forward for any future library integration (AG Grid, Flatpickr, etc.), and held true through this re-skin as well: the Gantt's own line-block coloring (`--l0`..`--l9`) was deliberately left untouched.

## 6. Do's and Don'ts

### Do:
- **Do** follow the CTA/Chrome Color Rule: navy chrome, bright-blue on-chrome CTA/highlight, navy-fill content-area CTAs, blue outline/ring for links and focus in the content area — never mix the four up (§2).
- **Do** separate regions with a 1px Hairline border by default; reach for a shadow only when something is genuinely floating above the page (modal, popover, splash card).
- **Do** render anything generated/measured/timestamped in JetBrains Mono (IDs, durations, stat numbers, version strings) — including the Mono-Eyebrow label and Mono-KPI-Value numeric patterns now used throughout KPI tiles and panel headers (§3).
- **Do** use a colored top-border for KPI/stat-tile severity (`border-top: 3px solid var(--warn|--err)`) — the one sanctioned exception to the no-colored-accent-stripe don't below (top-border, not side).
- **Do** use Flatpickr for every date/time input — never native `<input type="date">`, `datetime-local`, or `time` (the one exception is the AG Grid inline date-cell editor).
- **Do** use searchable/filterable comboboxes for plant and line selection, scoped to the plant→line hierarchy — this system is built to hold 50+ plants and 3,500+ lines, not the pilot's handful.
- **Do** re-skin third-party components (vis-timeline, Flatpickr, AG Grid) to the token system rather than shipping their default look.
- **Do** keep transitions fast (0.12–0.18s) and exponential-ease — a hover state should register like a mechanical switch, not a soft fade.

### Don't:
- **Don't** use bubble or chip selectors for plants or lines — they break down past ~10 entries and this system must scale to thousands.
- **Don't** add gradient-hero sections, gradient text, or glassmorphism as a decorative default — that's the generic-consumer-SaaS gloss this system explicitly rejects.
- **Don't** use dated grid-of-forms ERP layouts, oversized bordered table cells, or beige/gray corporate-form styling — that's the legacy-ERP clunk this system explicitly rejects.
- **Don't** use `border-left`/`border-right` as a colored accent stripe on cards or list rows — full borders, background tints, or a leading icon instead. (The one sanctioned exception is the KPI-tile `border-top` severity pattern in §5 — top, not side, and only on `.kpi-tile`.)
- **Don't** reference a CSS variable name that isn't defined in `:root` or `body.dark` without checking first. The specific tokens this used to warn about (`--border`, `--border-subtle`, `--font-mono`, `--nimbus-amber`/`--amber`, `--bg-float`) are now all defined in `:root` as of the Command Band re-skin — but dark-mode coverage is still not complete for every token (e.g. `--bg-hover` is only defined in `:root`, with no `body.dark` re-tune), so the caution still applies to anything new you introduce.
- **Don't** reach for `--shadow-lg` on a static, non-floating panel just to make it feel more "premium" — see The Floating-Means-Floating Rule.
