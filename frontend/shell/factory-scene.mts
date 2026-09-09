import { createFactoryProducts } from './factory-products.mjs';
import type { ProductDef } from './factory-products.mjs';
import { FACTORY_GEOMETRY as G, factoryLaneLayout, sampleFactoryLane } from './factory-scene-model.mjs';
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

  private housing(x: number, y: number, w: number, h: number, face = '#294358'): void {
    this.box(face, x, y - h, w, h);
    this.path('#3b5569', [[x, y - h], [x + 10, y - h - 7], [x + w + 10, y - h - 7], [x + w, y - h]]);
    this.path('#1d3347', [[x + w, y - h], [x + w + 10, y - h - 7], [x + w + 10, y - 7], [x + w, y]]);
    this.line('#536b7d', 0.8, [[x + 1, y - h + 1], [x + w - 1, y - h + 1]]);
  }

  private draw(): void {
    const c = this.ctx;
    c.clearRect(0, 0, this.width, this.height);
    this.box('#0c1c30', 0, 0, this.width, this.height);
    // Architectural structure is quiet and stationary; the process is the focal motion.
    const beamY = Math.max(42, this.height * 0.12);
    this.box('#14293c', 0, beamY, this.width, 8);
    this.line('#20384b', 1, [[0, beamY + 8.5], [this.width, beamY + 8.5]]);
    for (let x = 80; x < this.width; x += 220) {
      this.box('#102236', x, beamY + 10, 7, this.height - beamY - 10);
      this.box('#263b4c', x - 3, beamY - 2, 13, 3);
      this.box('#14293c', x - 6, this.height * 0.88, 21, 5);
    }
    for (const lane of this.lanes) {
      c.save(); c.translate(lane.x, lane.y); c.scale(lane.scale, lane.scale);
      c.beginPath(); c.rect(-30, -220, 1130, 320); c.clip();
      const sample = sampleFactoryLane(this.elapsed, lane.index, this.widths);
      this.infrastructure();
      this.belt();
      // Items are behind enclosures: material changes happen completely under a guard.
      for (const item of sample.items) this.item(item);
      this.assembly(sample, lane.index);
      this.inspection(sample);
      this.packing(sample);
      this.stageLabels(lane.index);
      c.restore();
    }
  }

  private infrastructure(): void {
    // Utility conduit, junction box and pneumatic line down to the assembly cell.
    this.line('#294253', 3, [[130, -181], [514, -181], [514, -39]]);
    this.line('#3d5566', 0.8, [[130, -183], [516, -183], [516, -40]]);
    for (const x of [150, 350, 490]) this.box('#536675', x, -185, 3, 8);
    this.box('#294253', 493, -84, 40, 29);
    this.box('#3d5566', 496, -81, 34, 1);
    this.circle('#728594', 526, -69, 1.5);
    this.line('#294253', 3, [[891, -150], [891, -123]]);
    this.box('#354e60', 872, -156, 39, 6);
    // Floor anchors and braces keep the line visibly supported.
    this.line('#183044', 1, [[-20, 79], [1094, 79]]);
    for (const x of [50, 195, 470, 738, 993]) {
      this.box('#294253', x, 23, 7, 54);
      this.line('#243c4f', 3, [[x + 6, 68], [x + 39, 26]]);
      this.box('#3d5262', x - 8, 75, 24, 4);
      this.circle('#81909a', x - 4, 77, 1); this.circle('#81909a', x + 12, 77, 1);
    }
  }

  private belt(): void {
    // One direction and one surface speed. Roller centers never translate.
    this.path('#263b46', [[-30, 0], [1100, 0], [1112, -8], [-18, -8]]);
    const offset = this.elapsed * G.speed % 24;
    for (let x = -54 + offset; x < 1110; x += 24) {
      this.line('#374a53', 0.7, [[x, 0], [x + 12, -8]]);
    }
    this.box('#3a5262', -30, 1, 1130, 4);
    this.box('#1c3346', -30, 5, 1130, 19);
    this.line('#546977', 1, [[-30, 24], [1100, 24]]);
    for (let x = -12; x < 1100; x += 30) {
      this.circle('#0d2134', x, 14, 6);
      this.circle('#4b6271', x, 14, 4.5);
      const angle = this.elapsed * G.speed / 4.5;
      const dx = Math.cos(angle) * 3.5, dy = Math.sin(angle) * 3.5;
      this.line('#203a4c', 1.2, [[x - dx, 14 - dy], [x + dx, 14 + dy]]);
      this.circle('#8a9ba5', x, 14, 1.2);
    }
    // Drive motors and guarded gearbox, kept beneath the transport surface.
    for (const x of [114, 763]) {
      this.box('#2d485b', x, 26, 38, 19); this.circle('#3d5769', x + 38, 35.5, 9.5);
      for (let dx = 5; dx < 30; dx += 5) this.box('#526979', x + dx, 29, 1.3, 13);
      this.circle('#203a4c', x + 39, 35.5, 4);
      this.line('#294253', 2, [[x + 9, 45], [x + 9, 52], [x - 20, 52]]);
    }
  }

  private item(item: FactoryItem): void {
    const c = this.ctx, p = this.products[item.productIndex];
    if (item.x < -82 || item.x > 1100) return;
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
      const w = Math.max(44, Math.min(74, p.w + 8)), h = p.id === 'STROLLER-S2' ? 51 : 39;
      this.box('#967f60', item.x, -h, w, h);
      this.path('#b39b77', [[item.x, -h], [item.x + 8, -h - 5], [item.x + w + 8, -h - 5], [item.x + w, -h]]);
      this.path('#736044', [[item.x + w, -h], [item.x + w + 8, -h - 5], [item.x + w + 8, -5], [item.x + w, 0]]);
      this.box('#c1ae8a', item.x + w * 0.47, -h, 5, h);
      this.path('#d0bf9c', [[item.x + w * 0.47, -h], [item.x + w * 0.47 + 8, -h - 5], [item.x + w * 0.47 + 13, -h - 5], [item.x + w * 0.47 + 5, -h]]);
      this.box('#e0ddd0', item.x + 6, -h + 9, 16, 11);
      for (let b = 0; b < 5; b++) this.box('#64717a', item.x + 8 + b * 2.3, -h + 11, b % 2 ? 0.7 : 1.2, 6);
      this.line('#6b5a43', 0.7, [[item.x + 2, -2], [item.x + w - 2, -2]]);
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
    const c = this.ctx, x = G.assemblyX, w = G.assemblyW;
    this.housing(x, 0, w, 136);
    this.box('#1c3346', x + 7, -7, w - 14, 7);
    this.box('#142b3d', x + 10, -111, 144, 78);
    this.line('#607787', 1, [[x + 10, -33], [x + 10, -111], [x + 154, -111], [x + 154, -33]]);
    // Tooling cycle is tied to the kit currently under the enclosure.
    c.save(); c.beginPath(); c.rect(x + 12, -109, 140, 74); c.clip();
    this.box('#233e50', x + 17, -47, 132, 7);
    for (let i = 0; i < 6; i++) this.circle('#536e7d', x + 27 + i * 22, -40, 3);
    const phase = sample.assembly;
    const press = phase === null ? 0 : Math.sin(Math.PI * phase) ** 2 * 25;
    this.box('#657d8b', x + 75, -108, 7, 28 + press);
    this.box('#8fa1ab', x + 60, -82 + press, 36, 8);
    this.box('#3d5769', x + 67, -74 + press, 22, 5);
    if (phase !== null) {
      this.box('#718a98', x + 63, -55, 30, 8);
      this.circle('#bac6cb', x + 117, -54, 4);
      const arm = Math.sin(phase * Math.PI) * 12;
      this.line('#8198a5', 3, [[x + 140, -85], [x + 125 - arm, -76], [x + 120 - arm, -56]]);
      this.circle('#bdc9cf', x + 125 - arm, -76, 2.5);
    }
    this.line('rgba(171,198,211,0.09)', 7, [[x + 24, -105], [x + 45, -40]]);
    c.restore();
    // Separate access/control cabinet, fasteners and ventilation slots.
    this.line('#192f42', 1.4, [[x + 166, -129], [x + 166, -12]]);
    this.box('#142b3d', x + 177, -109, 41, 24);
    this.box('#335567', x + 180, -106, 35, 12);
    this.box('#8caeac', x + 184, -102, phase === null ? 6 : 26 * phase + 4, 3);
    this.circle('#91aeb2', x + 183, -77, 3); this.circle('#b58b4c', x + 198, -77, 3);
    this.circle('#7a4e43', x + 213, -77, 3);
    this.box('#708694', x + 173, -57, 3, 15);
    for (let j = 0; j < 4; j++) this.box('#152d40', x + 185, -47 + j * 5, 30, 2);
    for (const dx of [5, 160, w - 5]) for (const y of [-129, -14]) this.circle('#667f8e', x + dx, y, 1.2);
    // Hazard markings are confined to the mechanical threshold.
    for (let dx = 13; dx < 145; dx += 13) this.path('#96834f', [[x + dx, -24], [x + dx + 5, -24], [x + dx + 10, -18], [x + dx + 5, -18]]);
    this.label('A-0' + (laneIndex + 1), x + 13, -119, 9, '#bdc9cf');
    this.label('01', x + 196, -119, 9, '#8198a5');
    // Steady stack lamps; amber indicates the actual assembly interval.
    this.box('#506b7a', x + w - 12, -167, 3, 24);
    this.box(phase === null ? '#749b85' : '#304d43', x + w - 16, -171, 11, 5);
    this.box(phase === null ? '#564c32' : '#b29659', x + w - 16, -164, 11, 5);
  }

  private inspection(sample: FactoryLaneSample): void {
    const x = G.scanX;
    // Rigid inspection portal, tall enough for the stroller and lantern bail.
    this.box('#304a5c', x - 20, -91, 5, 91);
    this.housing(x - 24, -83, 56, 12, '#405c6e');
    this.box('#263f51', x + 22, -83, 7, 83);
    this.box('#758a98', x - 9, -82, 15, 7);
    this.circle('#142b3d', x - 1.5, -78.5, 2.5);
    if (sample.inspecting) {
      this.path('rgba(147,184,190,0.07)', [[x, -75], [x - 7, 0], [x + 7, 0]]);
      this.line('rgba(148,189,196,0.5)', 0.7, [[x, -75], [x, 0]]);
    }
    this.circle(sample.inspecting ? '#8fb39b' : '#355447', x + 21, -91, 2.2);
    this.box('#1b3346', x + 34, -44, 22, 24);
    this.box('#456575', x + 37, -41, 16, 12);
    if (sample.inspecting) this.line('#a7c4ad', 1.5, [[x + 40, -36], [x + 44, -32], [x + 50, -38]]);
    this.line('#354f61', 2, [[x + 44, -20], [x + 44, 4]]);
  }

  private packing(sample: FactoryLaneSample): void {
    const x = G.packX, phase = sample.packing;
    // Carton blanks feed a squarer, lower enclosure than the assembly machine.
    this.box('#30495a', x - 32, -31, 39, 26);
    for (let i = 0; i < 4; i++) this.path(i % 2 ? '#8a7657' : '#ac9470', [[x - 28, -33 - i * 3], [x - 13, -39 - i * 3], [x + 3, -33 - i * 3], [x - 12, -27 - i * 3]]);
    this.housing(x, -76, G.packW, 37, '#354d5d');
    this.box('#253d4e', x, -76, 11, 76);
    // Solid exit guard hides the change from finished product to sealed carton.
    this.housing(x + 44, 0, 82, 76, '#294253');
    this.box('#152d3e', x + 55, -62, 54, 32);
    const stroke = phase === null ? 0 : Math.sin(Math.PI * phase) ** 2 * 12;
    this.box('#8a9da7', x + 76, -61, 4, 11 + stroke);
    this.box('#b8a17b', x + 66, -44, 25, 11);
    this.box('#8095a2', x + 65, -52 + stroke, 27, 5);
    // Tape reel and its feed path make the packing function recognizable.
    this.circle('#b7a17b', x + 71, -129, 13);
    this.circle('#d2c3a5', x + 71, -129, 7);
    this.circle('#526b7c', x + 71, -129, 3);
    this.line('#a39474', 2, [[x + 82, -124], [x + 93, -114], [x + 93, -94]]);
    this.box('#1e3749', x + 14, -103, 34, 14);
    this.label('03', x + 21, -93, 9, '#a7b8ca');
    this.circle(phase === null ? '#355447' : '#8fb39b', x + 108, -95, 3);
    for (const dx of [6, 120]) for (const y of [-106, -8]) this.circle('#778f9d', x + dx, y, 1.2);
    this.box('#647b89', x + 115, -53, 3, 14);
    for (let dx = 52; dx < 115; dx += 13) this.path('#96834f', [[x + dx, -20], [x + dx + 5, -20], [x + dx + 10, -14], [x + dx + 5, -14]]);
  }

  private stageLabels(laneIndex: number): void {
    this.label('01 / ' + this.labels.assembly, G.assemblyX + 12, 49, 9, '#8fa3b1');
    this.label('02 / ' + this.labels.inspection, G.scanX - 24, 49, 9, '#8fa3b1');
    this.label('03 / ' + this.labels.packing, G.packX + 8, 49, 9, '#8fa3b1');
    this.line('#31485a', 1, [[G.assemblyX + 12, 55], [G.assemblyX + 177, 55]]);
    this.label('WO-' + (48213 + laneIndex), G.assemblyX + 12, 70, 8, '#536d80');
  }
}
