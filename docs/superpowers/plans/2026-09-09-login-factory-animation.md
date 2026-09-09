# Login factory animation implementation plan

**Goal:** Flesh out the login factory scene in the approved rigid industrial illustration style, adding recognizable Contigo/Bubba drinkware and preserving rollback.

**Direction:** Retain two staggered production lines on wide screens and one on smaller desktop screens. Calm linear transport, mechanically linked processing and inspection, square machinery, restrained steel highlights, muted navy background. No bounce, glass panels, ambient spark showers, or decorative glowing effects. User approved using judgment on composition and specifically requested visible assembly, inspection and packing stages, plus both Contigo and Bubba shapes.

**Architecture:** Extract the existing product library without redrawing approved items. Preserve the existing FactoryScene as a selectable classic scene. Add an isolated refined canvas renderer and a pure model for layout, product transport, cycle/inspection timing. Both renderers share the product library and per-product style choices.

**Motion thesis:** A raw tray enters an enclosed assembly cell and emerges as a finished product, then passes a quality sensor and enters a packing unit, emerging as a sealed carton. Belts translate steadily; fixed rollers rotate at transport speed. A short press stroke and inspection lamp acknowledge process state. The scene is populated on arrival. Bound work to visible lanes and items, cap DPR at 2, pause when hidden, render a stable reduced-motion composition, and release all listeners/frames on sign-in.

## Tasks

- [x] Extract `createFactoryProducts(ctx)` to `frontend/shell/factory-products.mts`, preserving original product functions and the classic renderer. Ignore compiled output.
- [x] Add drinkware refinement and rollback in `factory-product-styles.mts`; reserve enough width for the handled mug and extend rollback tests.
- [x] Add `factory-scene-model.mts` with deterministic lane layout and continuous product progress; test transport direction, bounded spacing, visibility, inspection and cycle continuity.
- [x] Implement `factory-scene.mts` using the shared products and model: structural factory backdrop, fixed conveyors/rollers, enclosed cell, synchronized tooling, input trays, inspection portal and output. Integrate a scene style switch in `application-shell.mts`.
- [x] Test reduced motion, resize, visibility pause/resume, animation cleanup and canvas state isolation using controlled runtime fixtures; inspect real rendered frames at both scales and desktop/mobile sizes.
- [x] Build, typecheck, lint, run focused and full frontend tests and static boundary checks. Document rollback and verification outcomes in `docs/LOGIN-ARTWORK.md`; update shell documentation.

**Scope:** Login scene only; preserve the sign-in flow, product designs approved in commits `1546c70` and `d63f705`, current index.html edits, and unrelated user files. Do not deploy or commit without the user's request.

**Verification:** Build, typecheck, lint (0 errors, 42 existing warnings), static asset boundary and 21 focused shell/artwork/locale tests passed. The full frontend run passed 526 tests and reproduced the same two existing Engine.autoReflow setup-reservation failures at engine.test.mjs:561 and :598. Rendered initial/later desktop frames, a compact layout and both drinkware shapes. Lifecycle coverage verifies hidden/mobile canvas pause; original product paths were compared with HEAD and match exactly. No commit or deployment performed.
