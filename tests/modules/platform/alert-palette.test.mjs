// Palette gate for the nine alert swatches (--pal-*) and the seven --bar-pm-<category> tokens in frontend/styles.css.
// The tokens are parsed out of the real stylesheet (:root and body.dark), so a later palette edit is judged as written.
// Gates (per theme): swatch set == PALETTE; fill/label >= 4.5:1; every fill pair >= dE2000 15; each fill >= dE 15 from
// --bar-standard and --bar-firmed, and >= dE 6 from both under Machado 2009 (severity 1.0) protan and deutan; light
// fills >= 1.8:1 against --bg and --bg-elev; each warn ring >= 2:1 against its fill, or equal to the fill's label colour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PALETTE, DEFAULT_CATEGORY_COLORS, ALERT_CATEGORY_ORDER } from '../../../frontend/insights/alert-profiles.mjs';
import { contrast, deltaE2000, deltaECvd, MACHADO_PROTAN, MACHADO_DEUTAN } from '../../support/color-metrics.mjs';

const css = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8');

function blockOf(re) {
  const m = css.match(re);
  assert.ok(m, `block not found: ${re}`);
  const decls = new Map();
  for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(d[1], d[2].trim());
  return decls;
}
const BLOCKS = {
  light: blockOf(/^:root \{\n([\s\S]*?)^\}/m),
  dark: blockOf(/^body\.dark \{\n([\s\S]*?)^\}/m),
};

/** Resolve a declaration to a hex, following var(--x) inside the same block. */
function resolve(block, name, depth = 0) {
  const v = block.get(name);
  assert.ok(v !== undefined, `${name} is not declared`);
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  if (ref) { assert.ok(depth < 5, `var() loop at ${name}`); return resolve(block, ref[1], depth + 1); }
  assert.match(v, /^#[0-9a-fA-F]{6}$/, `${name} must resolve to a hex, got ${v}`);
  return v.toLowerCase();
}

// Minimums measured when the palette was finalised (2026-10-30). A palette change that lowers one of these shows which
// gate moved; raise the constant only on purpose. Pairs: light amber/sand dE 15.34, dark sky/slate dE 15.56.
const GATE = {
  labelContrast: 4.5,
  pairDE: 15,
  barDE: 15,
  barCvdDE: 6,           // measured floor: light magenta vs --bar-standard (protan/deutan) 6.01; the 6.0 gate is 8-bit quantised (light magenta vs blue is 6.0059)
  lightBgContrast: 1.8,  // measured floor: light amber vs --bg 1.83
  ringContrast: 2,
};

const swatches = theme => {
  const b = BLOCKS[theme];
  return PALETTE.map(name => ({
    name,
    fill: resolve(b, `--pal-${name}`),
    fg: resolve(b, `--pal-${name}-fg`),
    ring: resolve(b, `--pal-${name}-ring`),
  }));
};

test('both token blocks declare exactly the PALETTE swatches', () => {
  for (const theme of ['light', 'dark']) {
    const names = [...BLOCKS[theme].keys()].filter(k => /^--pal-[a-z]+$/.test(k)).map(k => k.slice(6)).sort();
    assert.deepEqual(names, [...PALETTE].sort(), `${theme} swatch set`);
    for (const n of PALETTE) {
      assert.ok(BLOCKS[theme].has(`--pal-${n}-fg`) && BLOCKS[theme].has(`--pal-${n}-ring`), `${theme} ${n} fg/ring`);
    }
  }
});

test('--bar-pm-<category> points at the default swatch in both blocks (var() must be restated in body.dark)', () => {
  for (const theme of ['light', 'dark']) {
    const b = BLOCKS[theme];
    for (const cat of ALERT_CATEGORY_ORDER) {
      const name = DEFAULT_CATEGORY_COLORS[cat];
      assert.equal(b.get(`--bar-pm-${cat}`), `var(--pal-${name})`, `${theme} ${cat} fill`);
      assert.equal(b.get(`--bar-pm-${cat}-fg`), `var(--pal-${name}-fg)`, `${theme} ${cat} fg`);
      assert.equal(b.get(`--bar-pm-${cat}-ring`), `var(--pal-${name}-ring)`, `${theme} ${cat} ring`);
    }
  }
});

for (const theme of ['light', 'dark']) {
  test(`${theme}: label ink reads on every fill (>= ${GATE.labelContrast}:1)`, () => {
    for (const s of swatches(theme)) assert.ok(contrast(s.fill, s.fg) >= GATE.labelContrast, `${s.name} ${contrast(s.fill, s.fg).toFixed(2)}`);
  });

  test(`${theme}: every fill pair is >= dE2000 ${GATE.pairDE} apart`, () => {
    const sw = swatches(theme);
    for (let i = 0; i < sw.length; i++) for (let j = i + 1; j < sw.length; j++) {
      const d = deltaE2000(sw[i].fill, sw[j].fill);
      assert.ok(d >= GATE.pairDE, `${sw[i].name}/${sw[j].name} dE ${d.toFixed(2)}`);
    }
  });

  test(`${theme}: each fill is separable from the firming bars (normal and red-green CVD)`, () => {
    const b = BLOCKS[theme];
    const bars = [resolve(b, '--bar-standard'), resolve(b, '--bar-firmed')];
    for (const s of swatches(theme)) for (const bar of bars) {
      const d = deltaE2000(s.fill, bar);
      assert.ok(d >= GATE.barDE, `${s.name} vs ${bar} dE ${d.toFixed(2)}`);
      for (const [label, m] of [['protan', MACHADO_PROTAN], ['deutan', MACHADO_DEUTAN]]) {
        const c = deltaECvd(s.fill, bar, m);
        assert.ok(c >= GATE.barCvdDE, `${s.name} vs ${bar} ${label} dE ${c.toFixed(2)}`);
      }
    }
  });

  test(`${theme}: each warn ring reads on its fill (>= ${GATE.ringContrast}:1) or is the label ink`, () => {
    for (const s of swatches(theme)) {
      const ok = s.ring === s.fg || contrast(s.ring, s.fill) >= GATE.ringContrast;
      assert.ok(ok, `${s.name} ring ${s.ring} on ${s.fill} = ${contrast(s.ring, s.fill).toFixed(2)}`);
    }
  });
}

test('light: each fill stands off the page and panel (>= 1.8:1 against --bg and --bg-elev)', () => {
  const b = BLOCKS.light;
  for (const s of swatches('light')) for (const surface of ['--bg', '--bg-elev']) {
    const c = contrast(s.fill, resolve(b, surface));
    assert.ok(c >= GATE.lightBgContrast, `${s.name} on ${surface} ${c.toFixed(2)}`);
  }
});

test('color-metrics sanity: known reference values', () => {
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(deltaE2000('#336699', '#336699') < 1e-9);
  // Sharma 2005 test pair 1 in Lab (50, 2.6772, -79.7751) vs (50, 0, -82.7485) is dE 2.0425; hex-converted pairs differ,
  // so pin the symmetry and ordering instead.
  assert.ok(Math.abs(deltaE2000('#e0a800', '#14b8a6') - deltaE2000('#14b8a6', '#e0a800')) < 1e-9);
  assert.ok(deltaE2000('#ff0000', '#00ff00') > deltaE2000('#ff0000', '#ee0000'));
});
