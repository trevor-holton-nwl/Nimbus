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
use `refined` by default. The bottle slot alternates between a Contigo West Loop
travel mug and a classic Bubba keg. The approved stroller and existing pen are retained.

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
Refined drinkware reserves 46px so the keg handle clears the scanner and neighboring
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
items use shallow ellipses. The refined scene fits a 1420-unit production/dispatch line to
the available canvas; its back lane is 84% of the front lane scale. The previous
scene retains its 1x/0.72x scales. Brand marks are part of the illustration.

The user chose the earlier navy mechanical style with visible assembly, inspection
and packing stages. Twin-window assembly enclosures, roof actuators, fixed rotating
rollers, straight steel legs, an inspection portal and a carton/tape station support
that direction. Enclosures use the earlier face/top/side colors
`#1a3252` / `#24446c` / `#132844`; blue scanning light and green/amber lamps follow
the NIMBUS signal palette. Fine vertical guides replace the heavier warehouse framing.
Products move at a steady 34 scene units per second; material
changes happen behind machine guards. The scene starts populated with six kits,
products or cartons per lane. Wide canvases show two staggered lines; compact
desktop canvases show one. Existing mobile CSS hides the illustration.

The two-row layout fits complete envelopes (185 units above each belt and 85 below)
with at least 110 screen pixels between them, shrinking both rows on shorter desktop
canvases. A-02 has an additional horizontal offset, and both infeed belts extend to
the viewport's left edge with the same component spacing. Assembly/Inspection/Packing
captions appear only beneath the upper A-02
line; the compact A-01-only layout has no stage captions. Floating navy work-order
callouts follow one finished product per row and fade as it traverses the open span.
Drinkware callouts identify CONTIGO or BUBBA-KEG instead of the legacy bottle slot ID.

Packing has no external blue carton magazine. Sealed cartons leave the belt through
a small Cartesian transfer arm: lift, traverse, lower, release, and return. Four
standard illustrated cartons accumulate in a two-by-two stack on a wooden pallet.
A counterbalance forklift approaches from the right, raises the completed pallet,
and reverses offscreen before the next carton arrives. The load follows the forks
while the chassis remains at floor level. `sampleFactoryDispatch()` derives all
positions from the same belt crossings and clock as the production flow; there are
no independent pickup timers or accumulated mutable box counts. The cycle continues
across product-loop wraps and retains the existing pause/reduced-motion behavior.

The first three-stage treatment, before this navy correction, is preserved in commit
`5c4ed81`. Its versions of `factory-scene.mts`, `factory-scene-model.mts`, and the
`BOTTLE-40OZ` drawing in `factory-product-styles.mts` provide the intermediate style
if needed. The `classic` switches above still restore the original scene and bottle
independently; no login setting or runtime preference is added.

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
| Drinkware | Contigo West Loop curved steel body and tall AUTOSEAL button; classic black Bubba barrel with a broad steel band and deep curved handle |

Shape references: [Coleman hard cooler](https://coleman.com/s/colemanca/coolers-drinkware/hard-coolers/316-series-hard-coolers/316-series-52-quart-hard-cooler/SP_271359.html),
[Coleman twin-mantle lantern](https://www.coleman.com/camp-sports/lighting/lanterns/gas-lanterns/powerhouse-dual-fuel-lantern/SP_270738.html),
[Rubbermaid BRUTE](https://www.rubbermaidcommercial.com/utility-refuse/brute-containers/brute-vented-containers/44-gallon/?sku=FG264307BLUE),
and [Yankee Candle Original Jar](https://www.yankeecandle.com/yankee-candle/candles/original-jar-candles/large-jar-candles/beautiful-day/SAP_1630609.html).
The illustrations simplify these product families; the animation IDs are existing
scene labels rather than exact product model specifications.
The drinkware was compared visually with official front photographs of the
[Contigo West Loop 470ml](https://www.mycontigo.com/products/thermal-mugs/west-loop-autoseal-travel-mug-470-ml/SP_2195835.html)
and [Bubba Classic 52oz](https://www.bubbabrands.com/SAP_1953391.html).

## Verification

`tests/modules/factory-product-styles.test.mjs` checks full rollback, individual
rollback, reserved drinkware width, and untouched products.
`factory-scene-model.test.mjs` checks continuous transport, stable identity, spacing,
inspection gating, responsive row clearance, carton transfer positions, four-carton
pickup gating and reset before the next arrival. `factory-scene.test.mjs` checks reduced
motion, redraw on resize, hidden/collapsed pause, resume, DPR, sign-in cleanup,
single-row stage captions and floating work-order text.
After editing, build, run the shell and artwork tests, and inspect the rendered canvas.
Compiled `.mjs` files are ignored and regenerated by the build.
