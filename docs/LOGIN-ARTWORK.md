# Login conveyor artwork

The login animation is a Canvas 2D illustration, not an image or video asset.
`frontend/shell/application-shell.mts` mounts the selected scene and retains the
previous `FactoryScene` for rollback. `frontend/shell/factory-scene.mts` owns the
refined renderer and its lifecycle; `factory-scene-model.mts` owns the deterministic
assembly → inspection → packing flow and responsive lane layout.

`frontend/shell/factory-products.mts` holds the original `CLASSIC_PRODUCTS` paths
and exports `createFactoryProducts(ctx)`, shared by both scenes.
`factory-product-styles.mts` contains the refined product drawings and the
`FACTORY_PRODUCT_STYLES` table. The six approved refinements and the bottle slot
use `refined` by default. The bottle slot alternates between a Contigo-style travel
mug and a Bubba-style handled keg. The approved stroller and existing pen are retained.

## Restore the previous scene

Set `FACTORY_SCENE.style` to `classic` at the top of
`frontend/shell/factory-scene.mts`, run `npm run build`, and reload:

```ts
export const FACTORY_SCENE = { style: 'classic' as 'classic' | 'refined' };
```

This restores the previous conveyors, machine animation, random spawning and
overlays, while keeping the current product-style choices. The new scene is the
default (`refined`). Scene rollback and individual product rollback are independent.

## Restore a previous drawing

Change the desired entry from `refined` to `classic`, then run `npm run build`
and reload the local login screen. For example:

```ts
  'COOLER-65Q': 'classic',
```

Set `'BOTTLE-40OZ': 'classic'` to restore the previous bottle and its 24px width.
Refined drinkware reserves 42px so the keg handle clears the scanner and neighboring
products. Its variant is stable for the whole product journey, selected from the
item hue; the production loop naturally includes both shapes.

Set every entry to `classic` to restore all pre-refinement product drawings.
Each original remains intact, including its colors and geometry. Product IDs and
library order are preserved. Only the refined bottle slot reserves additional width.
These are source-level artwork choices, not user settings or login controls.
Hosted changes require the normal deployment process and build-ID bump.

The approved stroller refinement is preserved in commit `1546c70`. The new
selection table does not change it. Its earlier drawing can be recovered from
that commit's parent if needed; restore just its `STROLLER-S2` drawing, not the
whole shell file. The drawings now live in `factory-products.mts`.

## Visual direction

Compact silhouettes, muted materials, restrained highlights, and the existing
navy factory background. The cooler retains an up-right side face; cylindrical
items use shallow ellipses. The refined scene fits a 1080-unit production line to
the available canvas; its back lane is 84% of the front lane scale. The previous
scene retains its 1x/0.72x scales. Brand marks are part of the illustration.

The user chose visible assembly, inspection and packing stages, with both types
of drinkware. Square metal enclosures, fixed rotating rollers, utility conduit,
braced legs, press tooling, an inspection portal and a carton/tape station support
that direction. Products move at a steady 34 scene units per second; material
changes happen behind machine guards. The scene starts populated with six kits,
products or cartons per lane. Wide canvases show two staggered lines; compact
desktop canvases show one. Existing mobile CSS hides the illustration.

Reduced motion renders a stable populated frame, including after resize. Browser
visibility changes and zero-size canvases stop frame scheduling. The renderer
responds to motion-preference changes and removes its observers/listeners on sign-in.
DPR is capped at 2. Stage labels and the canvas description use all five locales.
This is a decorative illustration: work-order markings do not represent live data.

| Product | Refined treatment |
| --- | --- |
| Cooler | Rounded molded chest, white lid, cup recesses, swing handles, Coleman badge; green/red/blue variants |
| BRUTE | Tapered cylindrical body, rolled open rim, molded handles, reinforcing ribs, BRUTE mark; neutral variants |
| Blender | Faceted glass pitcher, spout, open handle, measurement marks, weighted motor base and dial |
| Coffee maker | Reservoir, brew head, control panel, glass carafe, open handle and coffee fill |
| Lantern | Green enamel tank and vented cap, wire bail, glass globe and twin mantles |
| Candle | Broad glass shoulders, narrow neck, domed glass lid, tinted wax and classic paper label |
| Drinkware | Contigo-style tapered steel travel mug and asymmetric lid; Bubba-style broad keg, steel band and open handle |

Shape references: [Coleman hard cooler](https://coleman.com/s/colemanca/coolers-drinkware/hard-coolers/316-series-hard-coolers/316-series-52-quart-hard-cooler/SP_271359.html),
[Coleman twin-mantle lantern](https://www.coleman.com/camp-sports/lighting/lanterns/gas-lanterns/powerhouse-dual-fuel-lantern/SP_270738.html),
[Rubbermaid BRUTE](https://www.rubbermaidcommercial.com/utility-refuse/brute-containers/brute-vented-containers/44-gallon/?sku=FG264307BLUE),
and [Yankee Candle Original Jar](https://www.yankeecandle.com/yankee-candle/candles/original-jar-candles/large-jar-candles/beautiful-day/SAP_1630609.html).
The illustrations simplify these product families; the animation IDs are existing
scene labels rather than exact product model specifications.
The travel-mug shape also references the [Contigo West Loop](https://www.gocontigo.com/explore-products/mugs/contigo-west-loop-stainless-steel-travel-mug-with--autoseal-lid-16-oz/SAP_2173387.html).

## Verification

`tests/modules/factory-product-styles.test.mjs` checks full rollback, individual
rollback, reserved drinkware width, and untouched products.
`factory-scene-model.test.mjs` checks continuous transport, stable identity, spacing,
inspection gating and responsive layout. `factory-scene.test.mjs` checks reduced
motion, redraw on resize, hidden/collapsed pause, resume, DPR and sign-in cleanup.
After editing, build, run the shell and artwork tests, and inspect the rendered canvas.
Compiled `.mjs` files are ignored and regenerated by the build.
