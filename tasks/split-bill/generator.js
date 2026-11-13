function generate(seed, n) {
  const r = rngFrom(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const total = r.pick([0, 1, 7, 100, 999, 10000, 123457, r.int(0, 1e6), 999999999999, 1e12, r.int(1, 9) * 1e11 + r.int(0, 999)]);
    const k = r.int(1, 8);
    const weights = Array.from({ length: k }, () => r.pick([0, 1, 1, 2, 3, 7, 10, 333, 1000000, r.int(0, 1000000)]));
    if (weights.every((w) => w === 0)) weights[0] = 1;
    if (i === n - 1) out.push(r.pick([[-1, [1]], [10, []], [10, [1.5, 1]], [1e12 + 1, [1]], [10, [0, 0, 0]]]));
    else out.push([total, weights]);
  }
  return out;
}
