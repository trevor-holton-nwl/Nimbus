// optimization/headless-codec.mts: JSON text for graphs that carry Dates and Sets (a candidate result, a worker
// request), shared by the headless runner and the golden-capture script. Dates are written as {"$d": <ISO instant>}
// (null for an invalid Date) and Sets as {"$set": [...]}, so a value round-trips exactly.

export function encodeTagged(value: unknown, indent?: number): string {
  return JSON.stringify(value, function replacer(this: Record<string, unknown>, key: string, v: unknown) {
    const raw = this[key];
    if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? { $d: raw.toISOString() } : { $d: null };
    if (raw instanceof Set) return { $set: [...raw] };
    return v;
  }, indent);
}

export function decodeTagged(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      const record = v as Record<string, unknown>;
      if (keys.length === 1 && keys[0] === '$d') return record.$d === null ? new Date(Number.NaN) : new Date(record.$d as string);
      if (keys.length === 1 && keys[0] === '$set') return new Set(record.$set as unknown[]);
    }
    return v;
  });
}
