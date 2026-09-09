// Login canvas artwork only. Originals remain in FactoryScene's CLASSIC_PRODUCTS.
// Change any entry to 'classic' and run npm run build to restore that item.
type ProductStyle = 'classic' | 'refined';
type RefinedProductId = 'COOLER-65Q' | 'BRUTE-44G' | 'BLENDER-PRO' | 'CANDLE-22OZ' | 'BREW-12C' | 'LANTERN-LED';
export const FACTORY_PRODUCT_STYLES: Readonly<Record<RefinedProductId, ProductStyle>> = {
  'COOLER-65Q': 'refined',
  'BRUTE-44G': 'refined',
  'BLENDER-PRO': 'refined',
  'CANDLE-22OZ': 'refined',
  'BREW-12C': 'refined',
  'LANTERN-LED': 'refined',
};

type Tint = (lightness: number, saturation?: number) => string;
type ProductDraw = (x: number, y: number, scale: number, tint: Tint, hue: number) => void;
interface ProductDef { id: string; w: number; draw: ProductDraw }

export function applyFactoryProductStyles(
  ctx: CanvasRenderingContext2D,
  originals: readonly ProductDef[],
  styles: Readonly<Partial<Record<RefinedProductId, ProductStyle>>> = FACTORY_PRODUCT_STYLES,
): ProductDef[] {
  const fill = (color: string, path: () => void): void => {
    ctx.fillStyle = color; ctx.beginPath(); path(); ctx.closePath(); ctx.fill();
  };
  const line = (color: string, width: number, path: () => void): void => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); path(); ctx.stroke();
  };
  const oval = (color: string, x: number, y: number, rx: number, ry: number): void => {
    fill(color, () => ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2));
  };
  const box = (color: string, x: number, y: number, w: number, h: number, r = 0): void => {
    fill(color, () => ctx.roundRect(x, y, w, h, r));
  };
  // These are illustrated product badges, not interface labels.
  const badge = (text: string, x: number, y: number, color: string, size: number): void => {
    ctx.fillStyle = color; ctx.font = `700 ${size}px Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y);
  };
  const drawings: Record<RefinedProductId, (tint: Tint, hue: number) => void> = {
    'COOLER-65Q': (_tint, hue) => {
      const body = ['#35664f', '#a5473e', '#3d6487'][hue % 3];
      const side = ['#24463b', '#70352f', '#2b475f'][hue % 3];
      // Molded chest with rounded corners and the scene's up-right depth.
      fill(side, () => {
        ctx.moveTo(59, -32); ctx.lineTo(69, -38); ctx.lineTo(68, -8);
        ctx.quadraticCurveTo(67, -4, 58, -1);
      });
      fill(body, () => {
        ctx.moveTo(2, -33); ctx.lineTo(61, -33); ctx.lineTo(59, -5);
        ctx.quadraticCurveTo(59, 0, 54, 0); ctx.lineTo(9, 0);
        ctx.quadraticCurveTo(4, 0, 4, -5);
      });
      line('rgba(255,255,255,0.16)', 1, () => { ctx.moveTo(8, -28); ctx.lineTo(9, -7); ctx.lineTo(55, -7); });
      // Thick white lid, shallow inset and paired cup recesses.
      fill('#f4f7fa', () => {
        ctx.moveTo(1, -39); ctx.lineTo(10, -45); ctx.lineTo(70, -45);
        ctx.lineTo(62, -39);
      });
      box('#e8edf3', 0, -39, 63, 8, 2);
      fill('#b7c6ce', () => { ctx.moveTo(63, -39); ctx.lineTo(71, -45); ctx.lineTo(71, -37); ctx.lineTo(63, -31); });
      oval('#c6d0db', 19, -41.5, 5.5, 1.6); oval('#c6d0db', 49, -41.5, 5.5, 1.6);
      line('#ffffff', 1, () => { ctx.moveTo(5, -38); ctx.lineTo(58, -38); });
      box('#b7c6ce', 25, -35, 13, 3, 1);
      // Swing handles on each end, hung below the lid.
      line('#dce4e9', 2.5, () => {
        ctx.moveTo(2, -28); ctx.lineTo(0, -27); ctx.lineTo(0, -18); ctx.lineTo(5, -18);
        ctx.moveTo(65, -30); ctx.lineTo(69, -30); ctx.lineTo(69, -21); ctx.lineTo(65, -19);
      });
      box('#e8edf3', 23, -25, 21, 8, 1.3); box('#a5473e', 24, -24, 19, 6, 0.7);
      badge('Coleman', 33.5, -20.7, '#ffffff', 4.1);
      oval('#dce4e9', 53, -7, 2.2, 2.2); oval('#728698', 53, -7, 0.9, 0.9);
    },
    'BRUTE-44G': (_tint, hue) => {
      const body = ['#66727d', '#89949c', '#4b5863', '#c9d0d4'][hue % 4];
      // Cylindrical, slightly tapered body; curved base and rolled elliptical rim.
      fill(body, () => {
        ctx.moveTo(4, -46); ctx.lineTo(42, -46); ctx.lineTo(38, -5);
        ctx.bezierCurveTo(38, 1, 8, 1, 8, -5);
      });
      fill('rgba(12,28,48,0.22)', () => { ctx.moveTo(35, -44); ctx.lineTo(42, -46); ctx.lineTo(38, -5); ctx.quadraticCurveTo(37, -2, 32, -1); });
      line('rgba(255,255,255,0.22)', 1.2, () => { ctx.moveTo(10, -39); ctx.lineTo(13, -8); });
      // Molded lifting handles sit outside the rim; their openings stay hollow.
      line('#a7b4bf', 3, () => {
        ctx.moveTo(5, -42); ctx.lineTo(1, -42); ctx.lineTo(1, -36); ctx.lineTo(6, -36);
        ctx.moveTo(41, -42); ctx.lineTo(45, -42); ctx.lineTo(45, -36); ctx.lineTo(40, -36);
      });
      oval('#9aa7b2', 23, -46, 21.5, 5.5);
      oval('#263848', 23, -47, 18.2, 3.4);
      line('#bdc7cf', 1.5, () => { ctx.ellipse(23, -46, 21, 5, 0, 0, Math.PI); });
      line('rgba(12,28,48,0.25)', 1.7, () => {
        ctx.moveTo(15, -24); ctx.lineTo(16, -8); ctx.moveTo(31, -24); ctx.lineTo(30, -8);
        ctx.moveTo(11, -5); ctx.quadraticCurveTo(23, -1, 35, -5);
      });
      badge('BRUTE', 23, -32, '#e8edf3', 6);
      line('rgba(232,237,243,0.5)', 0.8, () => { ctx.moveTo(18, -27); ctx.lineTo(28, -27); });
    },
    'BLENDER-PRO': tint => {
      // Loop handle behind the pitcher, with visible negative space.
      line('#91a8b8', 3, () => {
        ctx.moveTo(25, -44); ctx.lineTo(31, -44); ctx.quadraticCurveTo(34, -44, 33, -39);
        ctx.lineTo(31, -29); ctx.quadraticCurveTo(30, -26, 25, -27);
      });
      // Tapered glass jar, pouring spout, translucent facets and measure marks.
      fill('rgba(184,216,230,0.32)', () => {
        ctx.moveTo(5, -18); ctx.lineTo(1, -47); ctx.lineTo(-1, -50);
        ctx.lineTo(27, -50); ctx.lineTo(24, -18);
      });
      line('#a7bfcd', 1, () => { ctx.moveTo(1, -47); ctx.lineTo(5, -18); ctx.lineTo(24, -18); ctx.lineTo(27, -47); });
      fill('rgba(224,241,248,0.26)', () => { ctx.moveTo(5, -46); ctx.lineTo(9, -46); ctx.lineTo(11, -21); ctx.lineTo(8, -21); });
      line('#b8ceda', 0.8, () => {
        for (let y = -40; y <= -26; y += 7) { ctx.moveTo(16, y); ctx.lineTo(21, y); }
      });
      line('#c6d0db', 1.1, () => { ctx.moveTo(9, -22); ctx.lineTo(19, -20); ctx.moveTo(10, -20); ctx.lineTo(19, -23); });
      box('#a7b8ca', 5, -20, 19, 4, 1); // jar collar
      box('#34495e', 0, -53, 28, 5, 2); box('#718697', 10, -56, 9, 3, 1);
      // Weighted motor base with brushed front and a single physical dial.
      fill(tint(29, 24), () => { ctx.moveTo(6, -16); ctx.lineTo(23, -16); ctx.lineTo(29, -3); ctx.quadraticCurveTo(30, 0, 26, 0); ctx.lineTo(2, 0); ctx.quadraticCurveTo(-1, 0, 0, -3); });
      box('#8fa1b3', 4, -12, 20, 9, 2);
      oval('#263848', 14, -7.5, 3.5, 3.5); oval('#b7c6ce', 14, -7.5, 2.2, 2.2);
      line('#34495e', 0.8, () => { ctx.moveTo(14, -9.2); ctx.lineTo(14, -7.5); });
      box('#263848', 2, -2, 25, 2, 0.8);
    },
    'BREW-12C': tint => {
      // Rear reservoir and curved brew head make a continuous appliance silhouette.
      box(tint(27, 18), 26, -50, 15, 47, 3);
      box('#5d7186', 35, -39, 3, 21, 1);
      line('#a7b8ca', 0.6, () => {
        for (let y = -34; y <= -22; y += 6) { ctx.moveTo(35, y); ctx.lineTo(38, y); }
      });
      box('#283c50', 0, -7, 42, 7, 2); box('#718697', 1, -6, 39, 1.5, 0.5);
      oval('#12263f', 15, -7, 12.5, 2);
      // Open carafe handle, clear glass body and dark coffee fill.
      line('#8fa1b3', 2.8, () => {
        ctx.moveTo(25, -28); ctx.lineTo(29, -28); ctx.quadraticCurveTo(32, -28, 31, -23);
        ctx.lineTo(29, -15); ctx.lineTo(25, -15);
      });
      fill('rgba(184,216,230,0.3)', () => {
        ctx.moveTo(7, -29); ctx.lineTo(23, -29); ctx.lineTo(27, -15);
        ctx.quadraticCurveTo(29, -8, 21, -8); ctx.lineTo(8, -8);
        ctx.quadraticCurveTo(2, -8, 4, -15);
      });
      fill('#624634', () => { ctx.moveTo(5, -18); ctx.lineTo(26, -18); ctx.lineTo(26, -13); ctx.quadraticCurveTo(26, -10, 21, -10); ctx.lineTo(9, -10); ctx.quadraticCurveTo(4, -10, 5, -18); });
      line('#c9dce6', 1, () => { ctx.moveTo(8, -25); ctx.lineTo(6, -16); ctx.quadraticCurveTo(5, -12, 9, -12); });
      box('#566c80', 5, -31, 20, 3, 1); // carafe lid
      box('#34495e', 3, -50, 36, 14, 3);
      box('#9aaab7', 5, -48, 32, 9, 1.5);
      box('#23394b', 18, -46, 12, 5, 0.6); box('#8fb6aa', 21, -44.5, 6, 1.2);
      oval('#b8c5cf', 10, -43.5, 1.7, 1.7);
      fill('#263848', () => { ctx.moveTo(8, -36); ctx.lineTo(26, -36); ctx.lineTo(23, -32); ctx.lineTo(11, -32); });
    },
    'LANTERN-LED': () => {
      // Coleman pressure-lantern silhouette: wire bail, vented hat, twin mantles, tank.
      line('#91a4b3', 1.2, () => {
        ctx.moveTo(5, -40); ctx.lineTo(3, -53); ctx.bezierCurveTo(1, -68, 29, -68, 27, -53); ctx.lineTo(25, -40);
      });
      box('#2e644d', 2, -17, 26, 17, 5);
      oval('#4b8066', 15, -15, 12.5, 3.2); box('#244d3d', 2, -3, 26, 3, 1);
      oval('#a7b8ca', 26, -10, 2.5, 2); // filler cap
      box('#a5473e', 7, -12, 16, 6, 0.8); badge('Coleman', 15, -9, '#ffffff', 3.8);
      // Glass globe uses flat translucent layers to match the other products.
      fill('rgba(218,230,218,0.22)', () => { ctx.moveTo(5, -40); ctx.lineTo(25, -40); ctx.lineTo(24, -20); ctx.quadraticCurveTo(15, -16, 6, -20); });
      box('#f1ddb0', 10, -36, 4, 12, 2); box('#f1ddb0', 17, -36, 4, 12, 2);
      box('#fff4d6', 11, -34, 1.5, 8, 0.6); box('#fff4d6', 18, -34, 1.5, 8, 0.6);
      line('#8fa1a5', 1.4, () => { ctx.moveTo(6, -40); ctx.lineTo(7, -20); ctx.moveTo(24, -40); ctx.lineTo(23, -20); });
      line('rgba(240,248,244,0.55)', 1, () => { ctx.moveTo(9, -38); ctx.lineTo(9, -24); });
      oval('#427458', 15, -20, 11, 2); oval('#a7b8ca', 15, -17, 2, 1.5);
      // Broad enamel brim, raised ventilator crown and small top nut.
      fill('#356e50', () => { ctx.moveTo(0, -42); ctx.quadraticCurveTo(2, -45, 6, -46); ctx.lineTo(8, -51); ctx.quadraticCurveTo(15, -55, 22, -51); ctx.lineTo(24, -46); ctx.quadraticCurveTo(28, -45, 30, -42); });
      oval('#244d3d', 15, -42, 15, 2);
      line('#5a9370', 1, () => { ctx.moveTo(8, -50); ctx.quadraticCurveTo(15, -53, 22, -50); });
      box('#183b2d', 9, -48, 3, 2, 0.5); box('#183b2d', 14, -48, 3, 2, 0.5); box('#183b2d', 19, -48, 3, 2, 0.5);
      oval('#b7c6ce', 15, -54, 1.6, 1);
    },
    'CANDLE-22OZ': tint => {
      // Classic apothecary jar: broad shoulders, narrow neck, heavy glass base.
      fill('rgba(201,221,235,0.27)', () => {
        ctx.moveTo(7, -43); ctx.lineTo(23, -43); ctx.lineTo(23, -38);
        ctx.bezierCurveTo(23, -34, 30, -35, 30, -28); ctx.lineTo(30, -5);
        ctx.quadraticCurveTo(30, 0, 25, 0); ctx.lineTo(5, 0);
        ctx.quadraticCurveTo(0, 0, 0, -5); ctx.lineTo(0, -28);
        ctx.bezierCurveTo(0, -35, 7, -34, 7, -38);
      });
      box(tint(63, 34), 2, -29, 26, 26, 3); oval(tint(72, 30), 15, -29, 13, 2.4);
      // Ivory paper label with a quiet landscape vignette and the two-line wordmark.
      box('#f3eddd', 5, -26, 20, 19, 0.8);
      badge('YANKEE', 15, -22.5, '#49535a', 3.3); badge('CANDLE', 15, -19, '#49535a', 3.1);
      box(tint(43, 27), 7, -16, 16, 6, 0.3);
      fill(tint(65, 25), () => { ctx.moveTo(7, -10); ctx.lineTo(12, -14); ctx.lineTo(17, -11); ctx.lineTo(21, -13); ctx.lineTo(23, -10); });
      // Transparent glass lid, with a rounded mushroom profile instead of metal.
      fill('rgba(200,223,234,0.48)', () => {
        ctx.moveTo(4, -44); ctx.quadraticCurveTo(3, -49, 7, -51);
        ctx.bezierCurveTo(10, -54, 20, -54, 23, -51);
        ctx.quadraticCurveTo(27, -49, 26, -44);
      });
      oval('#8fa9ba', 15, -43.5, 12, 2); oval('rgba(221,238,247,0.55)', 15, -44.5, 11, 1.2);
      line('#d4e6ef', 1, () => { ctx.moveTo(7, -47); ctx.quadraticCurveTo(8, -52, 18, -51); });
      line('rgba(232,244,250,0.65)', 1.2, () => {
        ctx.moveTo(8, -38); ctx.quadraticCurveTo(2, -34, 3, -28); ctx.lineTo(3, -8);
        ctx.moveTo(27, -28); ctx.lineTo(27, -8); ctx.moveTo(6, -2); ctx.lineTo(24, -2);
      });
    },
  };

  return originals.map(product => {
    const id = product.id as RefinedProductId;
    if (styles[id] !== 'refined' || !Object.hasOwn(drawings, id)) return product;
    return { ...product, draw(x, y, scale, tint, hue) {
      ctx.save();
      try {
        ctx.translate(x, y); ctx.scale(scale, scale);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        drawings[id](tint, hue);
      } finally { ctx.restore(); }
    } };
  });
}
