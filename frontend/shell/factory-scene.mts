import { createFactoryProducts } from './factory-products.mjs';
import type { ProductDef } from './factory-products.mjs';
import { FACTORY_GEOMETRY as G, factoryLaneLayout, sampleFactoryLane, sampleFactoryDispatch } from './factory-scene-model.mjs';
import type { FactoryLaneLayout, FactoryLaneSample, FactoryItem } from './factory-scene-model.mjs';

// Set style to 'classic' and rebuild to restore the previous scene composition.
export const FACTORY_SCENE = { style: 'refined' as 'classic' | 'refined' };
export interface FactorySceneLabels { assembly: string; inspection: string; packing: string }

export class RefinedFactoryScene {
  private ctx: CanvasRenderingContext2D;
  private products: ProductDef[];
  private widths: number[];
  private ro: ResizeObserver;
  private motion: MediaQueryList;
  private lanes: FactoryLaneLayout[] = [];
  private width = 0;
  private height = 0;
  private elapsed = 0;
  private last = 0;
  private raf = 0;
  private destroyed = false;

  constructor(private canvas: HTMLCanvasElement, private labels: FactorySceneLabels) {
    this.ctx = canvas.getContext('2d')!;
    this.products = createFactoryProducts(this.ctx);
    this.widths = this.products.map(product => product.w);
    this.motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.motion.addEventListener('change', this.sync);
    document.addEventListener('visibilitychange', this.sync);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(canvas);
    this.resize();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.ro.disconnect();
    this.motion.removeEventListener('change', this.sync);
    document.removeEventListener('visibilitychange', this.sync);
  }

  private resize = (): void => {
    if (this.destroyed) return;
    const { width, height } = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = width; this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lanes = factoryLaneLayout(width, height);
    this.sync();
  };

  private sync = (): void => {
    if (this.destroyed) return;
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.last = performance.now();
    if (this.lanes.length) this.draw();
    if (!document.hidden && !this.motion.matches && this.lanes.length) {
      this.raf = requestAnimationFrame(this.tick);
    }
  };

  private tick = (now: number): void => {
    this.raf = 0;
    if (this.destroyed || document.hidden || this.motion.matches || !this.lanes.length) return;
    this.elapsed += Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  private box(color: string, x: number, y: number, w: number, h: number): void {
    this.ctx.fillStyle = color; this.ctx.fillRect(x, y, w, h);
  }

  private path(color: string, points: number[][]): void {
    const c = this.ctx; c.fillStyle = color; c.beginPath(); c.moveTo(points[0][0], points[0][1]);
    for (const point of points.slice(1)) c.lineTo(point[0], point[1]);
    c.closePath(); c.fill();
  }

  private line(color: string, width: number, points: number[][]): void {
    const c = this.ctx; c.strokeStyle = color; c.lineWidth = width; c.beginPath();
    c.moveTo(points[0][0], points[0][1]);
    for (const point of points.slice(1)) c.lineTo(point[0], point[1]);
    c.stroke();
  }

  private circle(color: string, x: number, y: number, radius: number): void {
    const c = this.ctx; c.fillStyle = color; c.beginPath(); c.arc(x, y, radius, 0, Math.PI * 2); c.fill();
  }

  private label(text: string, x: number, y: number, size = 9, color = '#a7b8ca'): void {
    const c = this.ctx; c.fillStyle = color;
    c.font = `500 ${size}px 'JetBrains Mono', monospace`;
    c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillText(text, x, y);
  }

  private housing(x: number, y: number, w: number, h: number, face = '#1a3252'): void {
    this.box(face, x, y - h, w, h);
    this.path('#24446c', [[x, y - h], [x + 10, y - h - 7], [x + w + 10, y - h - 7], [x + w, y - h]]);
    this.path('#132844', [[x + w, y - h], [x + w + 10, y - h - 7], [x + w + 10, y - 7], [x + w, y]]);
    this.line('#2c4a6b', 0.8, [[x + 1, y - h + 1], [x + w - 1, y - h + 1]]);
  }

  private draw(): void {
    const c = this.ctx;
    c.clearRect(0, 0, this.width, this.height);
    this.box('#0c1c30', 0, 0, this.width, this.height);
    // Retain the original scene's quiet drafting guides.
    for (let x = 0; x < this.width; x += 80) this.box('#102338', x, 0, 1, this.height);
    for (const lane of this.lanes) {
      c.save(); c.translate(lane.x, lane.y); c.scale(lane.scale, lane.scale);
      const left = -lane.x / lane.scale, right = (this.width - lane.x) / lane.scale;
      c.beginPath(); c.rect(left, -220, right - left, 320); c.clip();
      const sample = sampleFactoryLane(this.elapsed, lane.index, this.widths);
      this.infrastructure();
      this.belt(left - 16);
      // Extend the same cadence upstream to the viewport boundary. Components
      // enter from offscreen even when the back line is shifted far to the right.
      const first = Math.min(...sample.items.map(item => item.x));
      for (let x = first - G.spacing; x > left - G.spacing; x -= G.spacing) {
        this.item({ x, productIndex: 0, serial: 0, hue: 210, material: 'raw' });
      }
      // Items are behind enclosures: material changes happen completely under a guard.
      for (const item of sample.items) this.item(item);
      this.assembly(sample, lane.index);
      this.inspection(sample);
      this.packing(sample);
      this.dispatch(lane.index, right);
      if (lane.index === 1) this.stageLabels();
      this.workOrder(sample);
      c.restore();
    }
  }

  private infrastructure(): void {
    // Simple steel legs leave the products and operating cells prominent.
    for (const x of [50, 195, 470, 738, 993]) {
      this.box('#142d49', x, 23, 5, 54);
      this.box('#1b3655', x - 5, 75, 15, 3);
    }
  }

  private belt(left: number): void {
    // One direction and one surface speed. Roller centers never translate.
    const end = G.beltEnd + 46;
    this.path('#193451', [[left, 0], [end, 0], [end + 12, -8], [left + 12, -8]]);
    const offset = this.elapsed * G.speed % 24;
    for (let x = Math.floor(left / 24) * 24 - 24 + offset; x < end; x += 24) {
      this.line('#2c4a6b', 0.7, [[x, 0], [x + 12, -8]]);
    }
    this.box('#24446c', left, 1, end - left, 3);
    this.box('#10263f', left, 4, end - left, 20);
    this.line('#1f3a5c', 1, [[left, 24], [end, 24]]);
    for (let x = Math.floor(left / 30) * 30; x < end; x += 30) {
      this.circle('#0d2134', x, 14, 6);
      this.circle('#2c4a6b', x, 14, 4.5);
      const angle = this.elapsed * G.speed / 4.5;
      const dx = Math.cos(angle) * 3.5, dy = Math.sin(angle) * 3.5;
      this.line('#203a4c', 1.2, [[x - dx, 14 - dy], [x + dx, 14 + dy]]);
      this.circle('#56677c', x, 14, 1);
    }
  }

  private item(item: FactoryItem): void {
    const c = this.ctx, p = this.products[item.productIndex];
    if (item.x >= G.beltEnd) return;
    if (item.material === 'raw') {
      // Component kit on a shallow returnable tray.
      this.path('#546c7b', [[item.x, -3], [item.x + 43, -3], [item.x + 49, -7], [item.x + 6, -7]]);
      this.box('#354e60', item.x, -3, 43, 3);
      this.box('#8b9da6', item.x + 5, -19, 18, 14);
      this.path('#adbcc2', [[item.x + 5, -19], [item.x + 11, -23], [item.x + 29, -23], [item.x + 23, -19]]);
      this.path('#637c8a', [[item.x + 23, -19], [item.x + 29, -23], [item.x + 29, -9], [item.x + 23, -5]]);
      this.circle('#acbac0', item.x + 34, -11, 6);
      this.circle('#435d6e', item.x + 34, -11, 2.5);
    } else if (item.material === 'carton') {
      this.carton(item.x, 0);
    } else {
      p.draw(item.x, 0, 1, (lightness, saturation = 58) => this.tint(item.hue, saturation, lightness), item.hue);
    }
    // Product drawing must not leak its line or font settings to the machinery.
    c.lineCap = 'butt'; c.lineJoin = 'miter';
  }

  private tint(hue: number, saturation: number, lightness: number): string {
    // Existing classic product helpers expect hex rather than CSS hsl strings.
    const s = saturation / 100, l = lightness / 100;
    const component = (n: number): string => {
      const k = (n + hue / 30) % 12;
      return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
        .toString(16).padStart(2, '0');
    };
    return '#' + component(0) + component(8) + component(4);
  }

  private assembly(sample: FactoryLaneSample, laneIndex: number): void {
    const c = this.ctx, x = G.assemblyX, w = G.assemblyW, phase = sample.assembly;
    this.housing(x, 0, w, 126);
    // Restore the earlier twin-window enclosure and roof actuator.
    for (const dx of [35, 133]) {
      this.box('#0a1626', x + dx, -94, 55, 36);
      this.line('#2c4a6b', 1, [[x + dx, -58], [x + dx, -94], [x + dx + 55, -94], [x + dx + 55, -58]]);
      c.save(); c.beginPath(); c.rect(x + dx + 1, -93, 53, 34); c.clip();
      const stroke = phase === null ? 0 : Math.sin(phase * Math.PI) * 10;
      this.line('#56677c', 3, [[x + dx + 12, -58], [x + dx + 23 + stroke, -77], [x + dx + 38, -68]]);
      this.circle('#7e93ab', x + dx + 23 + stroke, -77, 2);
      if (phase !== null) {
        const scan = x + dx + (phase * 2 + dx / 100) % 1 * 55;
        this.line('rgba(77,159,255,0.8)', 1, [[scan, -94], [scan, -58]]);
        if (phase > 0.45 && phase < 0.7) {
          for (let i = 0; i < 4; i++) {
            const angle = i * Math.PI / 2 + phase * 20;
            this.line('#f39c12', 0.8, [[x + dx + 38, -68],
              [x + dx + 38 + Math.cos(angle) * 5, -68 + Math.sin(angle) * 5]]);
          }
        }
      }
      c.restore();
    }
    for (const door of [x, x + w - 9]) {
      this.box('#0a1626', door, -39, 9, 39);
      for (let flap = 0; flap < 3; flap++) this.box('#2c4a6b', door + 1, -37 + flap * 3, 7, 1);
    }
    const lift = phase === null ? 0 : Math.sin(phase * Math.PI) ** 2 * 7;
    this.box('#2c4a6b', x + 108, -146 - lift, 6, 20 + lift);
    this.housing(x + 101, -146 - lift, 17, 6, '#2c4a6b');
    this.label('A-0' + (laneIndex + 1), x + 12, -109, 10, '#a7b8ca');
    this.box('#12263f', x + w - 40, -119, 30, 13);
    this.circle(phase === null ? '#1e7a4a' : '#f39c12', x + w - 31, -112.5, 2.5);
    this.label('01', x + w - 24, -109, 8, '#7e93ab');
    this.box('#1f3a5c', x + w + 11, -73, 6, 29);
    for (const [i, color] of ['#1e7a4a', '#f39c12', '#b02a20'].entries()) {
      c.save(); c.globalAlpha = i === (phase === null ? 0 : 1) ? 1 : 0.2;
      this.circle(color, x + w + 14, -67 + i * 9, 2.4); c.restore();
    }
  }

  private inspection(sample: FactoryLaneSample): void {
    const x = G.scanX;
    // Rigid inspection portal, tall enough for the stroller and lantern bail.
    this.box('#1f3a5c', x - 20, -91, 5, 91);
    this.housing(x - 24, -83, 56, 12, '#24446c');
    this.box('#193451', x + 22, -83, 7, 83);
    this.box('#56677c', x - 9, -82, 15, 7);
    this.circle('#0a1626', x - 1.5, -78.5, 2.5);
    if (sample.inspecting) {
      this.path('rgba(77,159,255,0.07)', [[x, -75], [x - 7, 0], [x + 7, 0]]);
      this.line('rgba(77,159,255,0.8)', 0.7, [[x, -75], [x, 0]]);
    }
    this.circle(sample.inspecting ? '#1e7a4a' : '#183b35', x + 21, -91, 2.2);
    this.box('#12263f', x + 34, -44, 22, 24);
    this.box('#24446c', x + 37, -41, 16, 12);
    if (sample.inspecting) this.line('#4d9fff', 1.5, [[x + 40, -36], [x + 44, -32], [x + 50, -38]]);
    this.line('#2c4a6b', 2, [[x + 44, -20], [x + 44, 4]]);
  }

  private packing(sample: FactoryLaneSample): void {
    const x = G.packX, phase = sample.packing;
    // Compact packing enclosure; no external carton magazine.
    this.housing(x, -76, G.packW, 37, '#1a3252');
    this.box('#132844', x, -76, 11, 76);
    // Solid exit guard hides the change from finished product to sealed carton.
    this.housing(x + 44, 0, 82, 76, '#1a3252');
    this.box('#0a1626', x + 55, -62, 54, 32);
    const stroke = phase === null ? 0 : Math.sin(Math.PI * phase) ** 2 * 12;
    this.box('#8a9da7', x + 76, -61, 4, 11 + stroke);
    this.box('#b8a17b', x + 66, -44, 25, 11);
    this.box('#8095a2', x + 65, -52 + stroke, 27, 5);
    // Tape reel and its feed path make the packing function recognizable.
    this.circle('#b7a17b', x + 71, -129, 13);
    this.circle('#d2c3a5', x + 71, -129, 7);
    this.circle('#526b7c', x + 71, -129, 3);
    this.line('#a39474', 2, [[x + 82, -124], [x + 93, -114], [x + 93, -94]]);
    this.box('#12263f', x + 14, -103, 34, 14);
    this.label('03', x + 21, -93, 9, '#a7b8ca');
    this.circle(phase === null ? '#183b35' : '#1e7a4a', x + 108, -95, 3);
    for (const dx of [6, 120]) for (const y of [-106, -8]) this.circle('#778f9d', x + dx, y, 1.2);
    this.box('#56677c', x + 115, -53, 3, 14);
  }

  private carton(x: number, y: number): void {
    const w = 46, h = 34;
    this.box('#967f60', x, y - h, w, h);
    this.path('#b39b77', [[x, y - h], [x + 8, y - h - 5], [x + w + 8, y - h - 5], [x + w, y - h]]);
    this.path('#736044', [[x + w, y - h], [x + w + 8, y - h - 5], [x + w + 8, y - 5], [x + w, y]]);
    this.box('#c1ae8a', x + 21, y - h, 4, h);
    this.path('#d0bf9c', [[x + 21, y - h], [x + 29, y - h - 5], [x + 33, y - h - 5], [x + 25, y - h]]);
    this.box('#e0ddd0', x + 5, y - 26, 12, 9);
    for (let i = 0; i < 4; i++) this.box('#64717a', x + 7 + i * 2.3, y - 24, 1, 5);
    this.line('#6b5a43', 0.7, [[x + 1, y - 1], [x + w - 1, y - 1]]);
  }

  private dispatch(laneIndex: number, right: number): void {
    const state = sampleFactoryDispatch(this.elapsed, laneIndex, right);
    const c = this.ctx, fork = state.forklift;
    // A small Cartesian transfer bridge gives each carton a supported path
    // from the belt to its stack position.
    this.box('#142d49', G.beltEnd - 9, -111, 4, 186);
    this.box('#1f3a5c', G.beltEnd - 13, -116, G.palletX - G.beltEnd + 112, 6);
    this.line('#2c4a6b', 1, [[G.beltEnd - 13, -110], [G.palletX + 99, -110]]);
    const carriageX = state.head.x + 23;
    const carriageY = state.head.y - 40;
    this.box('#2c4a6b', carriageX - 9, -119, 18, 10);
    this.line('#56677c', 3, [[carriageX, -109], [carriageX, carriageY]]);
    this.line('#7e93ab', 2, [[carriageX - 25, carriageY + 9], [carriageX - 25, carriageY],
      [carriageX + 25, carriageY], [carriageX + 25, carriageY + 9]]);
    // The pallet and all four cartons share the forks' transform after pickup.
    if (!state.collected) {
      c.save();
      if (fork?.loaded) c.translate(fork.offset, -fork.lift);
      this.pallet(G.palletX - 5, G.palletY);
      for (let i = 0; i < state.placed; i++) this.carton(G.palletX + i % 2 * 50, G.palletY - Math.floor(i / 2) * 34);
      c.restore();
    }
    if (state.transfer) this.carton(state.transfer.x, state.transfer.y);
    if (fork) this.forklift(G.palletX + 108 + fork.offset, fork.lift);
  }

  private pallet(x: number, y: number): void {
    this.box('#a38a62', x, y, 111, 5);
    this.path('#bda57e', [[x, y], [x + 8, y - 5], [x + 119, y - 5], [x + 111, y]]);
    this.box('#736044', x, y + 10, 111, 3);
    for (const dx of [3, 51, 99]) this.box('#8a7150', x + dx, y + 5, 9, 5);
    for (const dx of [26, 54, 82]) this.line('#8a7150', 0.8, [[x + dx, y], [x + dx + 8, y - 5]]);
  }

  private forklift(x: number, lift: number): void {
    // Left-facing counterbalance truck. It approaches left and reverses right
    // with the load; chassis/wheels remain at floor level while the forks rise.
    this.line('#7e93ab', 3, [[x - 109, 72 - lift], [x + 1, 72 - lift], [x + 1, 36 - lift]]);
    this.box('#2c4a6b', x, -38, 5, 107);
    this.box('#56677c', x + 8, -38, 3, 107);
    this.box('#7e93ab', x - 3, 35 - lift, 17, 7);
    this.path('#93610a', [[x + 15, 42], [x + 36, 42], [x + 45, 30], [x + 86, 30],
      [x + 100, 42], [x + 100, 63], [x + 15, 63]]);
    this.box('#b08b3c', x + 49, 32, 38, 4);
    this.box('#12263f', x + 18, 57, 82, 8);
    this.box('#1f3a5c', x + 93, 42, 8, 15);
    // Upright guard, open cab, seat and steering column.
    this.line('#56677c', 3, [[x + 20, 44], [x + 20, -23], [x + 74, -23], [x + 80, 32]]);
    this.box('#24446c', x + 13, -28, 69, 5);
    this.box('#0a1626', x + 46, 24, 20, 6);
    this.box('#263848', x + 60, 7, 7, 20);
    this.line('#7e93ab', 2, [[x + 32, 40], [x + 28, 18]]);
    this.line('#7e93ab', 2, [[x + 22, 17], [x + 34, 19]]);
    this.box('#c6d0db', x + 15, 40, 5, 4);
    this.box('#b02a20', x + 96, 42, 4, 4);
    this.box('#f39c12', x + 65, -32, 5, 4);
    for (const dx of [26, 83]) {
      this.circle('#081522', x + dx, 67, 12);
      this.circle('#56677c', x + dx, 67, 6);
      const angle = (x - G.palletX - 108) / 12;
      this.line('#a7b8ca', 1, [[x + dx - Math.cos(angle) * 4, 67 - Math.sin(angle) * 4],
        [x + dx + Math.cos(angle) * 4, 67 + Math.sin(angle) * 4]]);
    }
  }

  private stageLabels(): void {
    this.label('01 / ' + this.labels.assembly, G.assemblyX + 12, 49, 10, '#7e93ab');
    this.label('02 / ' + this.labels.inspection, G.scanX - 24, 49, 10, '#7e93ab');
    this.label('03 / ' + this.labels.packing, G.packX + 8, 49, 10, '#7e93ab');
  }

  private workOrder(sample: FactoryLaneSample): void {
    // One drifting callout per lane, tied to a visible outbound product.
    const out = sample.items.find(item => item.material === 'finished' && item.x > 475 && item.x < 790);
    if (!out) return;
    const c = this.ctx, product = this.products[out.productIndex];
    const productLabel = product.id === 'BOTTLE-40OZ'
      ? (out.hue % 2 === 0 ? 'CONTIGO' : 'BUBBA-KEG') : product.id;
    const text = 'WO-' + (48213 + out.serial) + ' · ' + productLabel + ' · ' + (82 + out.serial % 15) + '%';
    c.save();
    c.globalAlpha = Math.max(0, Math.min(1, (out.x - 475) / 25, (790 - out.x) / 25));
    c.font = "500 10px 'JetBrains Mono', monospace";
    const width = c.measureText(text).width + 16;
    const x = Math.max(475, Math.min(G.packX - 24 - width, out.x - 10)), y = -139;
    c.fillStyle = 'rgba(18,38,63,0.92)'; c.strokeStyle = '#2c4a6b'; c.lineWidth = 1;
    c.beginPath(); c.roundRect(x, y, width, 22, 3); c.fill(); c.stroke();
    this.label(text, x + 8, y + 14.5, 10);
    const anchor = out.x + product.w / 2;
    this.line('#2c4a6b', 1, [[Math.max(x + 12, Math.min(x + width - 12, anchor)), y + 22], [anchor, -84]]);
    c.restore();
  }
}
