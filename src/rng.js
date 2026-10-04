/** Small seeded PRNG (mulberry32) so a house can be regenerated from its seed. */
export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.s = this.seed || 1;
  }

  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a, b) {
    return a + (b - a) * this.next();
  }

  /** Integer in [a, b] inclusive. */
  int(a, b) {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

export function randomSeed() {
  return (Math.random() * 900000 + 100000) | 0;
}

const MAX_SEED = 2147483647;

/**
 * House number from what the player typed: a number is used as-is (so
 * "333772" is house #333772 again), anything else ("spooky") is turned into a
 * 6-digit house number the same way every time. Empty -> null (random).
 */
export function seedFromText(text) {
  const t = String(text || '').trim().replace(/^#/, '');
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= MAX_SEED) return n;
  }
  // FNV-1a hash of the (lower-cased) text.
  let h = 0x811c9dc5;
  for (const ch of t.toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 100000 + (h % 900000);
}

/** The seed in the page address (?seed=...), if any. */
export function seedFromUrl() {
  const n = Number(new URLSearchParams(window.location.search).get('seed'));
  return Number.isInteger(n) && n >= 1 && n <= MAX_SEED ? n : null;
}
