// Deterministic, decorative production flow. No live scheduling data or timers.
export const FACTORY_GEOMETRY = {
  width: 1420, speed: 34, run: 1260, spacing: 210,
  assemblyX: 222, assemblyW: 230, scanX: 650, packX: 830, packW: 126,
  beltEnd: 1018, palletX: 1076, palletY: 66, transferTime: 1.4,
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
  if (width > 760 && height > 560) {
    // Fit complete row envelopes (roof/callouts through feet), not belt baselines.
    const above = 185, below = 85, depth = 0.84;
    const gap = Math.max(110, height * 0.15);
    const k = Math.min(scale, (height - 96 - gap) / ((above + below) * (1 + depth)));
    const total = (above + below) * k * (1 + depth) + gap;
    const top = (height - total) / 2;
    const back = lane(top + above * k * depth, k * depth, 1);
    back.x += 48 * k;
    return [back, lane(top + (above + below) * k * depth + gap + above * k, k, 0)];
  }
  return [lane(height * 0.62, scale, 0)];
}

export interface FactoryDispatch {
  placed: number;
  transfer: { x: number; y: number } | null;
  head: { x: number; y: number };
  forklift: { offset: number; lift: number; loaded: boolean } | null;
  collected: boolean;
}

// Derive dispatch from the same carton crossings as the conveyor, so resize,
// reduced motion and pause cannot duplicate a carton or drift the pickup cycle.
export function sampleFactoryDispatch(time: number, laneIndex: number, exitX = 1550): FactoryDispatch {
  const g = FACTORY_GEOMETRY, period = g.spacing / g.speed;
  const travel = Math.max(0, time) + (960 + laneIndex * 103 - g.beltEnd) / g.speed;
  if (travel < 0) return { placed: 0, transfer: null, head: { x: g.beltEnd, y: -52 }, forklift: null, collected: false };
  const event = Math.floor(travel / period), age = travel - event * period, slot = event % 4;
  const targetX = g.palletX + slot % 2 * 50, targetY = g.palletY - Math.floor(slot / 2) * 34;
  let transfer: FactoryDispatch['transfer'] = null;
  if (age < g.transferTime) {
    const p = age / g.transferTime;
    // Straight lift, traverse, lower: no bounce or airborne ballistic motion.
    transfer = p < 0.25 ? { x: g.beltEnd, y: -52 * p / 0.25 }
      : p < 0.7 ? { x: g.beltEnd + (targetX - g.beltEnd) * (p - 0.25) / 0.45, y: -52 }
        : { x: targetX, y: -52 + (targetY + 52) * (p - 0.7) / 0.3 };
  }
  const placed = slot + (transfer ? 0 : 1);
  const returning = Math.max(0, age - g.transferTime);
  const head = transfer ?? (returning < 0.4 ? { x: targetX, y: targetY + (-52 - targetY) * returning / 0.4 }
    : { x: targetX + (g.beltEnd - targetX) * Math.min(1, (returning - 0.4) / 0.4), y: -52 });
  if (slot !== 3 || transfer) return { placed, transfer, head, forklift: null, collected: false };
  const pickupAge = age - g.transferTime, distance = Math.max(300, exitX - g.palletX + 80);
  const approach = 1.1, liftTime = 0.6, depart = 2.4;
  if (pickupAge >= approach + liftTime + depart) return { placed: 0, transfer: null, head, forklift: null, collected: true };
  const lift = Math.max(0, Math.min(1, (pickupAge - approach) / liftTime)) * 12;
  const offset = pickupAge < approach ? distance * (1 - pickupAge / approach)
    : pickupAge < approach + liftTime ? 0 : distance * (pickupAge - approach - liftTime) / depart;
  return { placed, transfer: null, head, forklift: { offset, lift, loaded: pickupAge >= approach }, collected: false };
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
