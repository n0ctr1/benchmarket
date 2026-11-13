function splitBill(total, weights) {
  if (!Number.isInteger(total) || total < 0 || total > 1e12) return null;
  if (!Array.isArray(weights) || weights.length < 1 || weights.length > 100) return null;
  if (!weights.every((w) => Number.isInteger(w) && w >= 0 && w <= 1e6)) return null;
  const W = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (W === 0n) return null;
  const T = BigInt(total);
  const shares = weights.map((w) => (T * BigInt(w)) / W);
  const rems = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % W }));
  let left = T - shares.reduce((a, s) => a + s, 0n);
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rems) {
    if (left === 0n) break;
    shares[i] += 1n;
    left -= 1n;
  }
  return shares.map(Number);
}
