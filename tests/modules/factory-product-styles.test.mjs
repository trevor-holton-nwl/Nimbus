import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFactoryProductStyles, FACTORY_PRODUCT_STYLES } from '../../frontend/shell/factory-product-styles.mjs';

const ids = ['COOLER-65Q', 'BRUTE-44G', 'BLENDER-PRO', 'CANDLE-22OZ', 'BREW-12C', 'LANTERN-LED', 'BOTTLE-40OZ'];
const originals = [...ids, 'STROLLER-S2', 'PEN-GEL07'].map((id, i) => ({
  id, w: 30 + i, draw() {},
}));

test('classic mode restores every original drawing without changing product order or identity', () => {
  const styles = Object.fromEntries(ids.map(id => [id, 'classic']));
  const products = applyFactoryProductStyles({}, originals, styles);
  products.forEach((product, i) => assert.equal(product, originals[i]));
});

test('refined defaults replace selected drawings and reserve space for the handled mug', () => {
  const products = applyFactoryProductStyles({}, originals);
  assert.deepEqual(Object.keys(FACTORY_PRODUCT_STYLES).sort(), [...ids].sort());
  products.forEach((product, i) => {
    assert.equal(product.id, originals[i].id);
    assert.equal(product.w, product.id === 'BOTTLE-40OZ' ? Math.max(originals[i].w, 46) : originals[i].w);
    if (ids.includes(product.id)) assert.notEqual(product.draw, originals[i].draw);
    else assert.equal(product, originals[i]);
  });
});

test('an individual product can revert while other products retain their refined drawings', () => {
  const products = applyFactoryProductStyles({}, originals, { ...FACTORY_PRODUCT_STYLES, 'COOLER-65Q': 'classic' });
  assert.equal(products[0], originals[0]);
  assert.notEqual(products[1].draw, originals[1].draw);
  assert.equal(originals[0].id, 'COOLER-65Q');
});
