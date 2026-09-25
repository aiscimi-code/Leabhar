/**
 * `Map.prototype.getOrInsert` / `getOrInsertComputed` (TC39 "upsert") and
 * `Math.sumPrecise`, which PDF.js 6 uses and which browsers do not all ship
 * yet. Installed on the page before PDF.js loads, and prepended to the PDF.js
 * worker when it is served. PDF.js uses `sumPrecise` for glyph geometry when
 * drawing a page; no figure the app records passes through it.
 */
export const MAP_UPSERT_POLYFILL = `
for (const C of [Map, WeakMap]) {
  if (!C.prototype.getOrInsert) {
    Object.defineProperty(C.prototype, 'getOrInsert', { configurable: true, writable: true,
      value(key, value) { if (!this.has(key)) this.set(key, value); return this.get(key); } });
  }
  if (!C.prototype.getOrInsertComputed) {
    Object.defineProperty(C.prototype, 'getOrInsertComputed', { configurable: true, writable: true,
      value(key, compute) { if (!this.has(key)) this.set(key, compute(key)); return this.get(key); } });
  }
}
if (!Math.sumPrecise) {
  Math.sumPrecise = function (values) { let total = 0; for (const v of values) total += v; return total; };
}
`;

type Upsert = { getOrInsert?: unknown; getOrInsertComputed?: unknown };

export function installMapUpsertPolyfill(): void {
  const math = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };
  if (!math.sumPrecise) {
    math.sumPrecise = (values) => { let total = 0; for (const v of values) total += v; return total; };
  }
  for (const C of [Map, WeakMap] as unknown as Array<{ prototype: Upsert & { has(k: unknown): boolean; get(k: unknown): unknown; set(k: unknown, v: unknown): unknown } }>) {
    if (!C.prototype.getOrInsert) {
      Object.defineProperty(C.prototype, 'getOrInsert', {
        configurable: true, writable: true,
        value(this: Map<unknown, unknown>, key: unknown, value: unknown) {
          if (!this.has(key)) this.set(key, value);
          return this.get(key);
        },
      });
    }
    if (!C.prototype.getOrInsertComputed) {
      Object.defineProperty(C.prototype, 'getOrInsertComputed', {
        configurable: true, writable: true,
        value(this: Map<unknown, unknown>, key: unknown, compute: (k: unknown) => unknown) {
          if (!this.has(key)) this.set(key, compute(key));
          return this.get(key);
        },
      });
    }
  }
}
