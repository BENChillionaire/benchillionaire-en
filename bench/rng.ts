/**
 * Seeded randomness. Every random outcome is drawn from a stream keyed by the run
 * seed plus a stable description of *what* is being drawn (game, rung, lifeline),
 * never by call order, so every decider faces identical outcomes.
 */

export type Rand = () => number;

/** FNV-1a over the joined key parts; turns a run seed + label into a stream seed. */
function hashKey(seed: number, parts: (string | number)[]): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (const ch of `${parts.join("\u0001")}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for benchmark sampling. */
function mulberry32(seed: number): Rand {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stream(seed: number, ...key: (string | number)[]): Rand {
  return mulberry32(hashKey(seed, key));
}

/** Seeded Fisher–Yates over a copy; returns the first `n` items of the permutation. */
export function sample<T>(items: readonly T[], n: number, rand: Rand): T[] {
  const copy = items.slice();
  const take = Math.min(n, copy.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, take);
}
