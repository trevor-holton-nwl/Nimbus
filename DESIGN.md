---
name: NIMBUS
description: Industrial console for production scheduling — dense, precise, built for expert schedulers.
colors:
  foundry-amber: "#b8791a"
  foundry-amber-hot: "#a26615"
  foundry-amber-soft: "#f0dcb4"
  foundry-amber-wash: "#faf3e3"
  deep-slate: "#1f2430"
  deep-slate-hot: "#2a3040"
  deep-slate-fg: "#fcfbf6"
  warm-mill-white: "#f5f4ef"
  panel-white: "#ffffff"
  subtle-grain: "#ecebe4"
  header-rail: "#e0dfd6"
  hairline: "#d9d8cf"
  hairline-strong: "#c7c6bd"
  near-black-ink: "#1a1b1f"
  mute-iron-gray: "#6b6c73"
  faint-iron-gray: "#9a9ba1"
  signal-ok: "#2f7a4d"
  signal-ok-soft: "#d8ecdf"
  signal-warn: "#b57a0a"
  signal-warn-soft: "#f6e5bd"
  signal-warn-vivid: "#f39c12"
  signal-err: "#b1362a"
  signal-err-soft: "#f4d5d0"
  signal-info: "#2d5f8c"
  signal-info-soft: "#d7e5f2"
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
  md: "6px"
  lg: "10px"
  xl: "14px"
components:
  button-primary:
    backgroundColor: "{colors.deep-slate}"
    textColor: "{colors.deep-slate-fg}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.deep-slate-hot}"
  button-secondary:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.near-black-ink}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "30px"
  button-secondary-hover:
    backgroundColor: "{colors.subtle-grain}"
  input:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.near-black-ink}"
    rounded: "{rounded.md}"
    padding: "5px 10px"
    height: "30px"
---

# Design System: NIMBUS

## 1. Overview

**Creative North Star: "The Foundry Console"**

NIMBUS is a control-room instrument, not a consumer app that happens to render a Gantt chart. The palette is deep slate shot through with a single molten-amber accent — the visual grammar of a foundry control panel, not a SaaS dashboard. Every surface is dense with real information (order counts, due dates, line utilization) because the people using it are experts scheduling production every day, not casual visitors who need to be onboarded gently.

The system is deliberately restrained: one accent color, hairline borders as the default separator, shadows reserved for the handful of surfaces that genuinely float above the page (modals, the welcome splash). It rejects two failure modes explicitly — the bubbly, gradient-hero gloss of generic consumer SaaS, and the dated grid-of-forms clunkiness of legacy ERP screens. NIMBUS sits between them: modern craft applied to an industrial, information-dense tool.

**Key Characteristics:**
- Deep slate + warm amber, nothing else competing for identity
- Hairline borders and flat surfaces by default; shadows are the exception, not the rule
- JetBrains Mono for anything numeric or machine-generated (IDs, timestamps, stat figures)
- Brisk, exact motion — nothing lingers, nothing bounces

## 2. Colors

The palette is a warm-neutral console (off-white to near-black) carrying exactly one saturated accent, plus a fixed 10-color palette reserved for distinguishing production lines on the Gantt.

### Primary
- **Foundry Amber** (`#b8791a` light / `#d4920f` dark): the system's one identity color. Used for the topbar's bottom rail, active-tab outline and icon, focus rings, and any "this is the important thing" highlight. Its rarity is the point — it does not appear as a background fill at any scale.

### Secondary
- **Deep Slate** (`#1f2430` light / same in dark, since it doubles as the dark-mode accent): the action color. Used for primary CTA buttons (`.btn-primary`) and the active state of segmented controls (`.seg-btn.active`). Distinct from Foundry Amber so "the brand" and "the action you can take" never compete for the same visual weight.

### Neutral
- **Warm Mill White** (`#f5f4ef`): page background.
- **Panel White** (`#ffffff`): cards, panels, inputs, modals — anything that sits one level above the page.
- **Subtle Grain** (`#ecebe4`): input/subtle fills, hover states on buttons and tabs.
- **Header Rail** (`#e0dfd6`): the topbar's structural tint.
- **Hairline** (`#d9d8cf`) / **Hairline Strong** (`#c7c6bd`): the default border — NIMBUS separates regions with a 1px line, not a shadow.
- **Near-Black Ink** (`#1a1b1f`): body text.
- **Mute Iron Gray** (`#6b6c73`) / **Faint Iron Gray** (`#9a9ba1`): secondary and tertiary text.

### Semantic
- **Signal OK** (`#2f7a4d`), **Signal Warn** (`#b57a0a`, with a vivid `#f39c12` variant for higher-urgency amber-adjacent warnings), **Signal Err** (`#b1362a`), **Signal Info** (`#2d5f8c`) — each paired with a `-soft` tint for badge/alert backgrounds. These are the only places color carries meaning beyond brand identity; keep new status colors inside this set rather than inventing a fifth.

### Data / Line Palette
- **line-0 … line-9**: a fixed 10-color qualitative palette (`#89419f #2d5f8c #4f7a3c #8b4c7e #b14a3e #3c6e7a #7a5a2a #5e498b #ae4268 #4a7a5e`) used exclusively to distinguish production lines in the Gantt, utilization strip, and dashboard charts. Saturated but not neon, chosen to stay distinguishable under common color-vision deficiencies — treat this as a closed, ordered set; don't recolor a line outside it. (line-0 and line-8 were re-derived 2026-07-13 — line-0 was previously byte-identical to `--accent`, violating the One-Accent Rule below, and line-8 was a near-duplicate of line-4.)

### Named Rules
**The One-Accent Rule.** Foundry Amber never becomes a background fill or a large surface. It is a line, an outline, an icon, a focus ring — never a wash of color.

**The Hairline-Over-Shadow Rule.** Regions are separated by a 1px border by default. A shadow is a deliberate signal that something is floating above the page (a modal, a popover), not a decorative default on every card.

**The Dark-Mode Remap, Not Reversal.** In dark mode, Foundry Amber shifts brighter (`#d4920f`) and quietly takes over the Secondary/primary-button role too — dark mode is not a naive color inversion, it's a re-tuned palette on the same structure. Note: dark-mode coverage is incomplete today — some newer components still hardcode light-mode colors, and a few token names are referenced in dark-mode CSS without a matching `:root` definition. Check `:root` and `body.dark` in `styles.css` before assuming a token exists.

## 3. Typography

**Display Font:** Archivo (falls back to Public Sans, sans-serif)
**Body Font:** Public Sans (falls back to system-ui, sans-serif)
**Label/Mono Font:** JetBrains Mono (falls back to monospace)

**Character:** A geometric display face paired with a humanist body face — enough contrast to feel designed, not two similar sans-serifs pretending to be different weights of the same thing. Mono is a third, distinct voice reserved for anything that reads as data rather than prose.

### Hierarchy
- **Display** (700, h1–h4, letter-spacing -0.015em): Archivo. Page/section titles, the brand mark, modal headings.
- **Body** (400–500, 13px base, line-height 1.45): Public Sans. The default for nearly everything — this is a dense-information product, not an editorial one, so body text is smaller and tighter than a marketing site's.
- **Label** (600–700, 11px, uppercase, letter-spacing 0.04–0.08em): Public Sans or Archivo depending on context. Form field labels, section eyebrows inside panels.
- **Control** (400–500, 12.5px): Public Sans. Interactive chrome that isn't quite body prose and isn't a tracked-uppercase label — buttons, tabs, inputs, filter dropdowns. This is the app's most common text size by volume (`.btn`, `.tab-btn`, `.input` all ship at it); documented here because it's an established step, not a one-off.
- **Mono** (400–700, 10–14px): JetBrains Mono. IDs, timestamps, stat numbers, changeover/duration figures, version strings — anything the user would expect to line up in a monospaced column.

### Named Rules
**The Mono-Means-Machine Rule.** If a string was generated, measured, or timestamped rather than written by a person, it renders in JetBrains Mono. This is the fastest visual cue in the system for "this is data, not copy."

## 4. Elevation

NIMBUS is flat by default. Depth is conveyed almost entirely through the Hairline border, not shadows — a panel sits next to another panel, not above it. Shadows are reserved for surfaces that are genuinely transient or floating: modals, the welcome-splash card, and a couple of glow effects used to draw the eye (the plant selector's onboarding ring, an active segmented-control button). In dark mode, shadow opacity increases (up to `rgba(0,0,0,0.5)` at the `lg` step) since a dark background can't rely on ambient contrast the way a light one does.

### Shadow Vocabulary
- **sm** (`0 1px 2px rgba(26,27,31,0.06)` light / `rgba(0,0,0,0.35)` dark): the barest lift — icon-button hover states, small popovers.
- **md** (`0 2px 6px rgba(26,27,31,0.08), 0 1px 2px rgba(26,27,31,0.04)` light / `rgba(0,0,0,0.4)…` dark): dropdowns, tooltips, small floating panels.
- **lg** (`0 8px 24px rgba(26,27,31,0.12), 0 2px 6px rgba(26,27,31,0.06)` light / `rgba(0,0,0,0.5)…` dark): modals and the welcome-splash card — the only "clearly floating above everything" surfaces in the system.

### Named Rules
**The Floating-Means-Floating Rule.** A shadow above the `sm` step is reserved for something the user should read as temporarily suspended over the interface (a modal, an overlay). Don't reach for `shadow-lg` on a static panel just to make it feel "premium" — that's the legacy-ERP-meets-consumer-SaaS mistake this system explicitly avoids.

## 5. Components

Components are brisk and exact: 6px corner radius almost everywhere, 1px hairline borders, minimal or no shadow, and fast 0.12–0.18s transitions. Nothing bounces or lingers — a hover state should feel like a mechanical switch registering, not a soft fade.

### Buttons
- **Shape:** 6px radius (`--r-md`), 30px height by default, 38px for `.btn-lg`, 24px for `.btn.sm`.
- **Primary** (`.btn-primary`): Deep Slate background, off-white text, Deep Slate border; hover darkens to `#2a3040`.
- **Secondary/default** (`.btn`): Panel White background, Hairline border, Near-Black Ink text; hover fills with Subtle Grain.
- **Ghost** (`.btn-ghost`): transparent background, same border/text logic.
- **Icon buttons** (`.icon-btn`): 30px square, transparent by default, Subtle Grain + Hairline on hover; carries an optional Signal-Err notification dot.
- **Segmented** (`.seg-btn`): pill-free, Hairline-bordered toggle group; the active state fills Deep Slate (or Foundry Amber specifically for the Gantt's timeline/orders sub-toggle, with a soft amber glow — the one place a button gets a colored shadow).

### Tabs
- **Style:** transparent by default, 6px radius, Mute Iron Gray text. Active tab gets Subtle Grain fill, a Hairline border, and a 2px Foundry Amber outline — the outline (not the fill) is what marks "current tab."
- **Named sub-tints:** the Admin and Master Data top-level tabs each carry their own idle/hover/active tint (cool gray for Admin, green for Master Data) so a user can locate them by color before reading the label, even though neither tint appears anywhere else in the system.

### Filter-Trigger Buttons
- **Style:** Hairline border, transparent/`--bg-elev` fill by default (`.dash-filter-btn`, `.gantt-line-btn` — the Dashboard's and Gantt's Line/Color/Form filter-dropdown triggers).
- **Active:** a soft-tint treatment distinct from both the Tabs outline and the Segmented fill — Foundry-Amber border, `--accent-wash` background, `--accent-hot` text, 600 weight. Shared verbatim between `.dash-filter-btn.active` and `.gantt-line-btn.active` (2026-07-13 — the latter previously referenced an undefined `--amber` token) so every filter-trigger button in the app reads as one component regardless of which screen it's on.

### Inputs
- **Style:** Panel White background, Hairline border, 6px radius, 30px height (60px min for textarea).
- **Focus:** border shifts to Foundry Amber plus a 3px Foundry-Amber-Wash glow (`box-shadow: 0 0 0 3px var(--accent-wash)`) — the same accent that marks "active tab" marks "active input."
- **Date/time:** always Flatpickr, never a native `<input type="date">`/`datetime-local`/`time` — see `CLAUDE.md`'s Flatpickr standard for the exact per-type configs. The one sanctioned exception is the AG Grid inline date-cell editor.

### Modals
- **Corner Style:** 10px radius (`--r-lg`).
- **Background:** Panel White, Hairline border, `shadow-lg`.
- **Structure:** head (14px/18px padding, Hairline bottom border) → body (18px padding, scrollable) → foot (12px/18px padding, Subtle Grain background, Hairline top border, right-aligned actions).
- **Backdrop:** `rgba(26,27,31,0.42)` with a 3px blur — dark and blurred enough to focus attention without a heavy black scrim.

### Toasts / Badges
- **Toasts:** solid Signal color fill (`ok`/`err`/`warn`/`info`), white text, slide-and-fade transitions.
- **Badges:** `-soft` tint background with the matching Signal text color — the soft/solid split is how NIMBUS distinguishes "a status label" (soft) from "an ephemeral notification" (solid toast).

### Signature Component: The Gantt (vis-timeline)
The production timeline is a third-party vis-timeline instance re-skinned to the token system rather than left in its default library styling — panel backgrounds, the time axis, and line-group labels are all explicitly overridden (especially in dark mode, where the library's own white background is force-overridden). Blackout blocks render as a diagonal red hatch, not a solid fill, so they read as "unavailable" rather than "an order." This re-skinning discipline — never ship a third-party component in its default look — is itself a rule worth carrying forward for any future library integration (AG Grid, Flatpickr, etc.).

## 6. Do's and Don'ts

### Do:
- **Do** keep Foundry Amber to lines, outlines, icons, and focus rings — never a background wash (The One-Accent Rule).
- **Do** separate regions with a 1px Hairline border by default; reach for a shadow only when something is genuinely floating above the page (modal, popover, splash card).
- **Do** render anything generated/measured/timestamped in JetBrains Mono (IDs, durations, stat numbers, version strings).
- **Do** use Flatpickr for every date/time input — never native `<input type="date">`, `datetime-local`, or `time` (the one exception is the AG Grid inline date-cell editor).
- **Do** use searchable/filterable comboboxes for plant and line selection, scoped to the plant→line hierarchy — this system is built to hold 50+ plants and 3,500+ lines, not the pilot's handful.
- **Do** re-skin third-party components (vis-timeline, Flatpickr, AG Grid) to the token system rather than shipping their default look.
- **Do** keep transitions fast (0.12–0.18s) and exponential-ease — a hover state should register like a mechanical switch, not a soft fade.

### Don't:
- **Don't** use bubble or chip selectors for plants or lines — they break down past ~10 entries and this system must scale to thousands.
- **Don't** add gradient-hero sections, gradient text, or glassmorphism as a decorative default — that's the generic-consumer-SaaS gloss this system explicitly rejects.
- **Don't** use dated grid-of-forms ERP layouts, oversized bordered table cells, or beige/gray corporate-form styling — that's the legacy-ERP clunk this system explicitly rejects.
- **Don't** use `border-left`/`border-right` as a colored accent stripe on cards or list rows — full borders, background tints, or a leading icon instead.
- **Don't** reference a CSS variable name that isn't defined in `:root` or `body.dark` — dark-mode coverage is incomplete today, and a few token names (`--border`, `--border-subtle`, `--font-mono`, `--nimbus-amber`, `--bg-float`) are referenced somewhere without a definition. Check before reusing one. (`--amber` was one of these until 2026-07-13, when its sole use — `.gantt-line-btn.active` — was moved onto the real `--accent`/`--accent-wash`/`--accent-hot` tokens.)
- **Don't** reach for `--shadow-lg` on a static, non-floating panel just to make it feel more "premium" — see The Floating-Means-Floating Rule.
