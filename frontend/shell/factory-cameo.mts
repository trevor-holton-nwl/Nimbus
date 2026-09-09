import type { FactoryLaneLayout } from './factory-scene-model.mjs';
import { FACTORY_GEOMETRY } from './factory-scene-model.mjs';

export interface CameoPose { mode: 'enter' | 'wave' | 'leave'; progress: number; frame: number }

// A short greeting at each complete minute of visible login-screen time.
export function sampleFactoryCameo(elapsed: number): CameoPose | null {
  if (!Number.isFinite(elapsed) || elapsed < 60) return null;
  const age = elapsed % 60;
  if (age >= 10.8) return null;
  if (age < 3.6) return { mode: 'enter', progress: age / 3.6, frame: Math.floor(age * 7) % 4 };
  if (age < 7.2) {
    const wave = age - 3.6;
    return { mode: 'wave', progress: 1,
      frame: wave < 0.35 || wave > 3.2 ? 4 : [5, 6, 7, 6][Math.floor((wave - 0.35) * 5) % 4] };
  }
  return { mode: 'leave', progress: (age - 7.2) / 3.6, frame: Math.floor((age - 7.2) * 7) % 4 };
}

export class FactoryCameo {
  private image: HTMLImageElement | null = null;
  private atlas: HTMLCanvasElement | null = null;
  private requested = false;
  private destroyed = false;

  destroy(): void {
    this.destroyed = true;
    if (this.image) { this.image.onload = null; this.image.onerror = null; }
    this.image = null; this.atlas = null;
  }

  private prepare(): void {
    this.requested = true;
    const image = new Image();
    this.image = image;
    const release = (): void => { image.onload = null; image.onerror = null; this.image = null; };
    image.onerror = release;
    image.onload = (): void => {
      if (this.destroyed) return;
      try {
        const atlas = document.createElement('canvas');
        atlas.width = image.naturalWidth; atlas.height = image.naturalHeight;
        const ctx = atlas.getContext('2d', { willReadFrequently: true });
        if (!ctx || !atlas.width || !atlas.height) return;
        ctx.drawImage(image, 0, 0);
        // Composite the approved green-screen atlas once in memory. Preserve the
        // original artwork and reuse the keyed canvas for every animation frame.
        const pixels = ctx.getImageData(0, 0, atlas.width, atlas.height), data = pixels.data;
        for (let i = 0; i < data.length; i += 4) {
          const excess = data[i + 1] - Math.max(data[i], data[i + 2]);
          if (excess <= 20) continue;
          const coverage = 1 - Math.min(1, (excess - 20) / 65);
          data[i + 3] = Math.round(255 * coverage);
          if (coverage > 0) data[i + 1] = Math.min(data[i + 1], Math.max(data[i], data[i + 2]));
        }
        ctx.putImageData(pixels, 0, 0);
        this.atlas = atlas;
      } catch {
        // Optional decoration must never interrupt login or the production scene.
        this.atlas = null;
      } finally { release(); }
    };
    image.src = new URL('./assets/chris-peterson-cameo.png', import.meta.url).href;
  }

  draw(ctx: CanvasRenderingContext2D, lane: FactoryLaneLayout, elapsed: number, width: number): void {
    if (this.destroyed) return;
    // Avoid downloading the artwork for short visits to the login screen.
    if (!this.requested && elapsed >= 50) this.prepare();
    const pose = sampleFactoryCameo(elapsed);
    if (!pose || !this.atlas) return;
    const left = -lane.x / lane.scale - 95, target = FACTORY_GEOMETRY.assemblyX - 62;
    const x = pose.mode === 'enter' ? left + (target - left) * pose.progress
      : pose.mode === 'leave' ? target + (left - target) * pose.progress : target;
    const age = elapsed % 60, bob = pose.mode === 'wave' ? 0 : Math.sin(age * 14) * 0.65;
    const cellW = this.atlas.width / 4, cellH = this.atlas.height / 2;
    const frame = pose.frame, anchor = [202, 194, 194, 194, 198, 192, 192, 192][frame];
    const height = 190;
    ctx.save(); ctx.translate(lane.x, lane.y); ctx.scale(lane.scale, lane.scale);
    ctx.beginPath(); ctx.rect(-lane.x / lane.scale, -220, width / lane.scale, 320); ctx.clip();
    ctx.translate(x, 79 + bob);
    if (pose.mode === 'leave') ctx.scale(-1, 1);
    ctx.drawImage(this.atlas, frame % 4 * cellW, Math.floor(frame / 4) * cellH, cellW, cellH,
      -anchor / cellH * height, -(frame < 4 ? 482 : 483) / cellH * height, height * cellW / cellH, height);
    ctx.restore();
  }
}
