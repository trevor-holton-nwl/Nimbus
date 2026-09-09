import { applyFactoryProductStyles } from './factory-product-styles.mjs';

export type ProductDraw = (x: number, y: number, k: number, tint: (l: number, s?: number) => string, hue: number) => void;
export interface ProductDef { id: string; w: number; draw: ProductDraw }

// Original product paths are retained verbatim so individual styles remain reversible.
export function createFactoryProducts(ctx: CanvasRenderingContext2D): ProductDef[] {
    // iso constants: top faces offset up-right
    const IX = 11, IY = -7;
    const shade = (hex: string, f: number): string => {
      const n = parseInt(hex.slice(1), 16);
      const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
      const r = c(((n >> 16) & 255) * f), g = c(((n >> 8) & 255) * f), b = c((n & 255) * f);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    };
    const quad = (a: number[], b: number[], c: number[], d: number[], fill: string): void => {
      ctx.fillStyle = fill; ctx.beginPath();
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
      ctx.closePath(); ctx.fill();
    };
    // front face at (x, y-h .. y), plus top + right side
    const isoBox = (x: number, y: number, w: number, h: number, color: string, opts?: { top?: string; side?: string }): void => {
      const o = opts || {};
      ctx.fillStyle = color;
      ctx.fillRect(x, y - h, w, h);
      quad([x, y - h], [x + w, y - h], [x + w + IX, y - h + IY], [x + IX, y - h + IY], o.top || shade(color, 1.22));
      quad([x + w, y - h], [x + w + IX, y - h + IY], [x + w + IX, y + IY], [x + w, y], o.side || shade(color, 0.78));
    };
    const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    };

    const CLASSIC_PRODUCTS: ProductDef[] = [
      { id: 'COOLER-65Q', w: 70, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        // body: Coleman-style box in the item's tint
        isoBox(0, 0, 66, 32, T(40));
        ctx.fillStyle = T(32); ctx.fillRect(0, -10, 66, 2.5); // molded body groove
        // white lid: overhangs, rounded
        ctx.fillStyle = '#e8edf3'; roundRect(-3, -43, 72, 12, 3); ctx.fill();
        quad([-1, -43], [70, -43], [70 + IX, -43 + IY], [-1 + IX, -43 + IY], '#ffffff');
        quad([69, -42], [69 + IX, -42 + IY], [69 + IX, -32 + IY], [69, -31], shade('#e8edf3', 0.8));
        // lid handle recess (front center)
        ctx.fillStyle = shade('#e8edf3', 0.78); roundRect(22, -40, 22, 6, 3); ctx.fill();
        ctx.fillStyle = shade('#e8edf3', 0.9); roundRect(24, -39, 18, 4, 2); ctx.fill();
        // drain plug, bottom front corner
        ctx.fillStyle = '#e8edf3'; ctx.beginPath(); ctx.arc(9, -5, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = shade('#e8edf3', 0.7); ctx.beginPath(); ctx.arc(9, -5, 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.restore(); } },
      { id: 'BRUTE-44G', w: 46, draw(x, y, k, T, hue) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        const B = ['#3a4148', '#6b7278', '#9aa1a7', '#e2e5e8'][hue % 4]; // BRUTE ships gray/black/white only
        quad([4, 0], [42, 0], [46, -48], [0, -48], B);                  // tapered body
        quad([0, -48], [46, -48], [46 + IX, -48 + IY], [IX, -48 + IY], shade(B, 1.22));
        ctx.fillStyle = shade(B, 0.8);
        ctx.fillRect(-3, -50, 52, 5);                                   // rim
        ctx.fillRect(8, -38, 4, 26); ctx.fillRect(34, -38, 4, 26);      // ribs
        ctx.restore(); } },
      { id: 'BLENDER-PRO', w: 34, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        isoBox(0, 0, 34, 16, T(24));
        ctx.globalAlpha = 0.75; quad([4, -16], [30, -16], [26, -50], [8, -50], '#c9ddf7'); ctx.globalAlpha = 1;
        ctx.strokeStyle = '#8fa1b3'; ctx.strokeRect(9.5, -46.5, 15, 27); // jar marks
        isoBox(7, -50, 20, 6, T(24));                                   // lid
        ctx.fillStyle = T(55); ctx.fillRect(6, -12, 8, 5);              // dial
        ctx.restore(); } },
      { id: 'STROLLER-S2', w: 58, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        // Right-facing stroller: open seat profile above a folding chassis.
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        // Under-seat shopping basket, behind the frame.
        ctx.fillStyle = '#33485e'; ctx.beginPath();
        ctx.moveTo(15, -21); ctx.lineTo(41, -20); ctx.lineTo(37, -12);
        ctx.quadraticCurveTo(27, -10, 18, -14); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#56677c'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(16, -20); ctx.lineTo(40, -19); ctx.stroke();
        // Slender crossed tubes: push handle to front fork, rear axle to seat.
        ctx.strokeStyle = '#8fa1b3'; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.moveTo(6, -58); ctx.lineTo(10, -58);
        ctx.quadraticCurveTo(12, -58, 13, -54);
        ctx.lineTo(25, -32); ctx.lineTo(47, -12); ctx.lineTo(49, -6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(12, -9); ctx.lineTo(31, -35); ctx.stroke();
        // Padded horizontal push grip.
        ctx.strokeStyle = '#56677c'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(2, -59); ctx.lineTo(8, -59); ctx.stroke();
        // Reclined backrest, seat cushion and downward-sloping leg support.
        // The space above the cushion stays open beneath the canopy.
        ctx.fillStyle = T(39, 42); ctx.beginPath();
        ctx.moveTo(17, -47); ctx.quadraticCurveTo(21, -48, 23, -43);
        ctx.lineTo(28, -32); ctx.lineTo(37, -32);
        ctx.quadraticCurveTo(39, -32, 41, -29); ctx.lineTo(46, -21);
        ctx.lineTo(42, -19); ctx.lineTo(35, -27); ctx.lineTo(25, -27);
        ctx.quadraticCurveTo(22, -27, 21, -31);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = T(62, 38); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(21, -43); ctx.lineTo(27, -31); ctx.lineTo(36, -31); ctx.stroke();
        // Bumper bar and footplate project forward from the open seat.
        ctx.strokeStyle = '#56677c'; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(30, -37); ctx.lineTo(39, -38);
        ctx.quadraticCurveTo(43, -38, 43, -34); ctx.lineTo(40, -29); ctx.stroke();
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(42, -19); ctx.lineTo(49, -19); ctx.stroke();
        // Full fabric hood: rounded crown, extended visor and one panel seam.
        ctx.fillStyle = T(47, 46); ctx.beginPath();
        ctx.moveTo(16, -43); ctx.lineTo(16, -50);
        ctx.bezierCurveTo(16, -59, 22, -64, 30, -63);
        ctx.bezierCurveTo(39, -63, 44, -57, 48, -48);
        ctx.lineTo(30, -47); ctx.closePath(); ctx.fill();
        ctx.fillStyle = T(35, 42); ctx.beginPath();
        ctx.moveTo(16, -43); ctx.lineTo(16, -50);
        ctx.quadraticCurveTo(16, -61, 27, -63);
        ctx.quadraticCurveTo(22, -56, 26, -46); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = T(65, 40); ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(30, -61);
        ctx.quadraticCurveTo(37, -56, 38, -49); ctx.stroke();
        ctx.strokeStyle = T(29, 38); ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(30, -47); ctx.lineTo(48, -48); ctx.stroke();
        // Folding hinge and wheels sit in front of the tubes, hiding their ends.
        ctx.fillStyle = '#c6d0db'; ctx.beginPath(); ctx.arc(25, -30, 2.3, 0, Math.PI * 2); ctx.fill();
        const wheel = (wx: number, r: number) => {
          ctx.fillStyle = '#1c2b3a'; ctx.beginPath(); ctx.arc(wx, -r, r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#56677c'; ctx.lineWidth = 0.8; ctx.stroke();
          ctx.fillStyle = '#8fa1b3'; ctx.beginPath(); ctx.arc(wx, -r, r * 0.54, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#1c2b3a'; ctx.beginPath(); ctx.arc(wx, -r, r * 0.16, 0, Math.PI * 2); ctx.fill();
        };
        wheel(12, 9); wheel(49, 6);
        ctx.restore(); } },
      { id: 'BOTTLE-40OZ', w: 24, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        // stainless body: tapered base like a tumbler-bottle
        ctx.fillStyle = T(42); ctx.beginPath();
        ctx.moveTo(3, 0); ctx.lineTo(1, -34);            // body side (slightly wider up top)
        ctx.quadraticCurveTo(1, -40, 5, -42);            // shoulder
        ctx.lineTo(19, -42); ctx.quadraticCurveTo(23, -40, 23, -34);
        ctx.lineTo(21, 0); ctx.closePath(); ctx.fill();
        // brushed-steel highlight + darker edge
        ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(4.5, -39, 3, 37);
        ctx.fillStyle = T(30); ctx.fillRect(19, -38, 2.5, 37);
        // neck + cap with carry loop
        ctx.fillStyle = T(36); ctx.fillRect(6, -45, 12, 3);
        ctx.fillStyle = '#1c2b3a'; roundRect(7, -52, 10, 7, 2); ctx.fill();
        ctx.strokeStyle = '#1c2b3a'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(12, -53, 4.5, Math.PI, 0); ctx.stroke(); ctx.lineWidth = 1;
        ctx.restore(); } },
      { id: 'CANDLE-22OZ', w: 30, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        // glass jar: gently tapered cylinder, shoulder curving into a narrower neck
        ctx.fillStyle = 'rgba(201,221,247,0.35)'; ctx.beginPath();
        ctx.moveTo(2, 0); ctx.lineTo(1, -30);            // straight body sides
        ctx.quadraticCurveTo(1, -37, 6, -39);            // shoulder
        ctx.lineTo(24, -39); ctx.quadraticCurveTo(29, -37, 29, -30);
        ctx.lineTo(28, 0); ctx.closePath(); ctx.fill();
        // wax fill visible through glass
        ctx.fillStyle = T(48); ctx.globalAlpha = 0.8;
        ctx.fillRect(3, -29, 24, 28); ctx.globalAlpha = 1;
        // paper label band
        ctx.fillStyle = '#f4f7fa'; ctx.fillRect(5, -25, 20, 15);
        ctx.strokeStyle = '#c6d0db'; ctx.strokeRect(5.5, -24.5, 19, 14);
        ctx.fillStyle = '#8fa1b3'; ctx.fillRect(9, -20, 12, 1.5); ctx.fillRect(11, -16, 8, 1.5); // label text lines
        // glass highlight
        ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(4, -36, 3, 34);
        // domed metal lid with knob
        ctx.fillStyle = '#7a5a2a'; ctx.beginPath();
        ctx.moveTo(4, -39); ctx.quadraticCurveTo(15, -47, 26, -39); ctx.closePath(); ctx.fill();
        ctx.fillRect(3, -41, 24, 3);
        ctx.fillStyle = shade('#7a5a2a', 1.25); ctx.beginPath(); ctx.arc(15, -45, 2.2, 0, Math.PI * 2); ctx.fill();
        ctx.restore(); } },
      { id: 'BREW-12C', w: 42, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        const B = T(22);
        isoBox(0, 0, 42, 8, B);                                         // base
        isoBox(24, -8, 18, 40, B);                                      // tower
        quad([24, -48], [42, -48], [10, -48], [10, -44], shade(B, 1.2));
        isoBox(8, -44, 18, 5, B);                                       // head
        ctx.globalAlpha = 0.7; quad([6, -8], [24, -8], [22, -30], [8, -30], '#c9ddf7'); ctx.globalAlpha = 1; // carafe
        ctx.fillStyle = '#1e7a4a'; ctx.fillRect(30, -20, 4, 4);         // LED
        ctx.restore(); } },
      { id: 'LANTERN-LED', w: 30, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        const B = T(38);
        // base (cylinder hint: rounded + darker sides)
        ctx.fillStyle = B; roundRect(1, -12, 28, 12, 3); ctx.fill();
        ctx.fillStyle = shade(B, 0.75); ctx.fillRect(1, -12, 3, 12); ctx.fillRect(26, -12, 3, 12);
        // glass globe with inner glow + vertical supports
        const glow = ctx.createLinearGradient(0, -34, 0, -12);
        glow.addColorStop(0, '#fdf6dd'); glow.addColorStop(1, '#f0ddac');
        ctx.fillStyle = glow; roundRect(4, -34, 22, 22, 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(12, -31, 6, 16); // hot core
        ctx.fillStyle = shade(B, 0.8); ctx.fillRect(4, -34, 2, 22); ctx.fillRect(24, -34, 2, 22);
        // cap: vented dome
        ctx.fillStyle = B; roundRect(2, -41, 26, 7, 3); ctx.fill();
        ctx.fillStyle = shade(B, 1.2); ctx.beginPath();
        ctx.moveTo(6, -41); ctx.quadraticCurveTo(15, -47, 24, -41); ctx.closePath(); ctx.fill();
        ctx.fillStyle = shade(B, 0.7); ctx.fillRect(8, -39, 14, 1.5); // vent slit
        // wire bail handle, hinged at sides
        ctx.strokeStyle = '#8fa1b3'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(5, -42); ctx.quadraticCurveTo(15, -54, 25, -42); ctx.stroke(); ctx.lineWidth = 1;
        ctx.fillStyle = '#8fa1b3'; ctx.fillRect(4, -43, 2.5, 2.5); ctx.fillRect(23.5, -43, 2.5, 2.5);
        ctx.restore(); } },
      { id: 'PEN-GEL07', w: 58, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        isoBox(0, 0, 50, 7, T(28));
        quad([50, 0], [58, -3.5], [50, -7], [50, -7], T(28));           // nose cone
        ctx.fillStyle = T(55); ctx.fillRect(38, -7, 4, 7);              // grip band
        ctx.fillStyle = '#8fa1b3'; ctx.fillRect(4, -9, 14, 3);          // clip
        ctx.restore(); } },
    ];
    return applyFactoryProductStyles(ctx, CLASSIC_PRODUCTS);
}
