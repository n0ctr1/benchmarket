// Deterministic random source for test generators, the same in Node and browsers.
// `rngFrom(seed)` takes a hex seed and returns helpers; a generator defines
// `generate(seed, n)` and returns n argument arrays.
function rngFrom(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let a = h ^ 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (xs) => xs[int(0, xs.length - 1)];
  const chance = (p) => next() < p;
  const shuffle = (xs) => {
    const a2 = xs.slice();
    for (let i = a2.length - 1; i > 0; i--) {
      const j = int(0, i);
      const t = a2[i];
      a2[i] = a2[j];
      a2[j] = t;
    }
    return a2;
  };
  return { next, int, pick, chance, shuffle };
}
