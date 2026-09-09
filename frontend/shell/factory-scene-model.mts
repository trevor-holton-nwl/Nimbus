// Deterministic, decorative production flow. No live scheduling data or timers.
export const FACTORY_GEOMETRY = {
  width: 1080, speed: 34, run: 1260, spacing: 210,
  assemblyX: 222, assemblyW: 230, scanX: 650, packX: 830, packW: 126,
} as const;

export interface FactoryItem {
  x: number; productIndex: number; serial: number; hue: number;
  material: 'raw' | 'finished' | 'carton';
}
export interface FactoryLaneSample {
  items: FactoryItem[]; inspecting: boolean; assembly: number | null; packing: number | null;
}
export interface FactoryLaneLayout { x: number; y: number; scale: number; index: number }

export function factoryLaneLayout(width: number, height: number): FactoryLaneLayout[] {
  if (width <= 0 || height <= 0) return [];
  const scale = Math.min(1.18, (width - 32) / FACTORY_GEOMETRY.width, height / 360);
  if (scale <= 0) return [];
  const lane = (y: number, k: number, index: number): FactoryLaneLayout => ({
    x: (width - FACTORY_GEOMETRY.width * k) / 2, y, scale: k, index,
  });
  if (width > 760 && height > 560) return [lane(height * 0.39, scale * 0.84, 1), lane(height * 0.72, scale, 0)];
  return [lane(height * 0.62, scale, 0)];
}

export function sampleFactoryLane(time: number, laneIndex: number, widths: readonly number[]): FactoryLaneSample {
  const g = FACTORY_GEOMETRY;
  if (!widths.length) return { items: [], inspecting: false, assembly: null, packing: null };
  const items: FactoryItem[] = Array.from({ length: 6 }, (_, i) => {
    const distance = Math.max(0, time) * g.speed + i * g.spacing + laneIndex * 103;
    const lap = Math.floor(distance / g.run);
    const serial = i + lap * 6 + laneIndex * 3;
    const x = distance % g.run - 90;
    return {
      x, serial, productIndex: serial % widths.length, hue: (serial * 47 + 210) % 360,
      material: x < g.assemblyX + 105 ? 'raw' : x < g.packX + 50 ? 'finished' : 'carton',
    };
  });
  const progress = (x: number, span: number): number | null => {
    const item = items.find(candidate => candidate.x >= x && candidate.x < x + span);
    return item ? (item.x - x) / span : null;
  };
  return {
    items,
    assembly: progress(g.assemblyX + 35, 135),
    packing: progress(g.packX + 8, 97),
    inspecting: items.some(item => item.material === 'finished' && item.x <= g.scanX &&
      item.x + widths[item.productIndex] >= g.scanX),
  };
}
