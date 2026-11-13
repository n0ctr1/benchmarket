function generate(seed, n) {
  const r = rngFrom(seed);
  const vocab = ["a", "an", "the", "ledger", "agent", "market", "x", "supercalifragilistic", "ok", "NEAR", "tests", "0123456789abcdef", "edge"];
  const sep = () => r.pick([" ", " ", "  ", "\t", " \t "]);
  const para = () => {
    if (r.chance(0.1)) return r.pick(["", "   ", "\t"]);
    const w = Array.from({ length: r.int(1, 9) }, () => r.pick(vocab));
    return (r.chance(0.2) ? sep() : "") + w.join(sep()) + (r.chance(0.2) ? sep() : "");
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const text = Array.from({ length: r.int(1, 3) }, para).join("\n");
    if (i === n - 1) out.push(r.pick([[text, 0], [text, 2.5], [5, 10]]));
    else out.push([text, r.pick([1, 3, 4, 5, 8, 10, 12, 20, 40])]);
  }
  return out;
}
