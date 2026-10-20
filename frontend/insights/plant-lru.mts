/* Tiny per-plant cache shared by the alert-profile and alert-ack clients: LRU of
   at most 3 plants plus a per-plant request token for the stale-response guard.
   Pure — no Store, no fetch. */

export const MAX_CACHED_PLANTS = 3;

export interface PlantLru<T> {
  get(plant: string): T | null;
  set(plant: string, value: T): void;
  /** Start a request for a plant; only the latest token for that plant is current. */
  begin(plant: string): number;
  isCurrent(plant: string, token: number): boolean;
  /** Drop the cached value and orphan any in-flight request for the plant. */
  invalidate(plant: string): void;
}

export function createPlantLru<T>(max: number = MAX_CACHED_PLANTS): PlantLru<T> {
  const data = new Map<string, T>();
  const tokens = new Map<string, number>();
  let seq = 0;
  return {
    get(plant) {
      if (!data.has(plant)) return null;
      const v = data.get(plant) as T;
      data.delete(plant); data.set(plant, v); // touch
      return v;
    },
    set(plant, value) {
      data.delete(plant); data.set(plant, value);
      while (data.size > max) data.delete(data.keys().next().value as string);
    },
    begin(plant) { seq += 1; tokens.set(plant, seq); return seq; },
    isCurrent(plant, token) { return tokens.get(plant) === token; },
    invalidate(plant) { data.delete(plant); seq += 1; tokens.set(plant, seq); },
  };
}

/** Thrown by the clients for a non-2xx response; `code` is the backend's string detail
 *  (e.g. 'name_taken', 'stale') when it sent one. */
export class AlertApiError extends Error {
  code: string | null;
  status: number;
  constructor(message: string, code: string | null, status: number) {
    super(message);
    this.name = 'AlertApiError';
    this.code = code;
    this.status = status;
  }
}
