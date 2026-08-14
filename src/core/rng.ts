import type { RngLike } from "./types";

/** xmur3 string hash — produces the 32-bit seed for mulberry32. */
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 PRNG stream over a 32-bit state. */
function mulberry32(state: number): () => number {
  let a = state | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic seeded RNG with label-path forking.
 *
 * fork(label) derives its child purely from `hash(labelPath + ":" + label)` —
 * never by consuming parent draws — so adding a fork, or drawing from any
 * stream, can never reshuffle a sibling stream for the same seed.
 */
export class Rng implements RngLike {
  readonly labelPath: string;
  private readonly draw: () => number;

  constructor(seed: string, labelPath?: string) {
    this.labelPath = labelPath ?? seed;
    this.draw = mulberry32(xmur3(seed));
  }

  next(): number {
    return this.draw();
  }

  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new Error(`Rng.int: bounds must be integers (got ${min}, ${max})`);
    }
    if (max < min) {
      throw new Error(`Rng.int: max (${max}) < min (${min})`);
    }
    return min + Math.floor(this.draw() * (max - min + 1));
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) {
      throw new Error("Rng.pick: cannot pick from an empty array");
    }
    return arr[this.int(0, arr.length - 1)] as T;
  }

  chance(p: number): boolean {
    return this.draw() < p;
  }

  fork(label: string): Rng {
    const childPath = `${this.labelPath}:${label}`;
    // Child seed IS the full label path — a pure function of identity,
    // independent of how many draws the parent (or anyone else) has made.
    return new Rng(childPath, childPath);
  }
}
