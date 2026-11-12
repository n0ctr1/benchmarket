function generate(seed, n) {
  const r = rngFrom(seed);
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const element = (lo, hi) => {
    const k = r.int(0, 9);
    if (k < 3) return "*";
    if (k < 5) return String(r.int(lo, hi));
    if (k < 7) { const a = r.int(lo, hi); return `${a}-${r.int(a, hi)}`; }
    if (k < 8) return `*/${r.int(1, Math.max(2, Math.floor((hi - lo) / 2)))}`;
    const a = r.int(lo, hi);
    return `${a}-${r.int(a, hi)}/${r.int(1, 5)}`;
  };
  const fieldOf = (i) => {
    const [lo, hi] = bounds[i];
    return Array.from({ length: r.chance(0.2) ? 2 : 1 }, () => element(lo, hi)).join(",");
  };
  const expr = () => bounds.map((_, i) => fieldOf(i)).join(r.pick([" ", "  ", "\t"]));
  const from = () => {
    const t = Date.UTC(r.int(2025, 2030), r.int(0, 11), r.int(1, 28), r.int(0, 23), r.int(0, 59), r.int(0, 59), r.chance(0.5) ? 0 : r.int(0, 999));
    const s = new Date(t).toISOString();
    return r.chance(0.2) ? s.replace(/\.\d{3}Z$/, "Z") : s;
  };
  const bad = [
    () => expr().split(/\s+/).slice(0, 4).join(" "),
    () => `${r.int(60, 99)} * * * *`,
    () => `* * ${r.int(32, 40)} * *`,
    () => `${r.int(1, 30)}/5 * * * *`,
    () => `0 0 * * ${r.pick(["MON", "8", "1-9"])}`,
    () => `* * * ${r.pick(["JAN", "0", "13"])} *`,
    () => `${r.int(10, 20)}-${r.int(0, 9)} * * * *`,
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1) out.push(["0 0 * * *", r.pick(["2026-13-01T00:00:00Z", "not a date", "2026-02-30T00:00:00.000Z"])]);
    else if (r.chance(0.2)) out.push([r.pick(bad)(), from()]);
    else out.push([expr(), from()]);
  }
  return out;
}
