function generate(seed, n) {
  const r = rngFrom(seed);
  const digits = (k) => {
    let s = String(r.int(1, 9));
    for (let j = 1; j < k; j++) s += String(r.int(0, 9));
    return s;
  };
  const num = () => {
    const kind = r.int(0, 9);
    let s;
    if (kind === 0) s = "0";
    else if (kind === 1) s = "0." + "0".repeat(r.int(0, 6)) + digits(r.int(1, 4));
    else if (kind === 2) s = digits(r.int(18, 40));
    else if (kind === 3) s = digits(r.int(1, 12)) + "." + digits(r.int(1, 20)).split("").reverse().join("");
    else if (kind === 4) s = String(r.pick([1, 2, 3, 5, 8, 10, 25, 125]));
    else if (kind === 5) s = digits(r.int(1, 3)) + ".5";
    else if (kind === 6) s = digits(r.int(1, 6)) + "." + "0".repeat(r.int(1, 3));
    else s = digits(r.int(1, 9)) + (r.chance(0.5) ? "." + String(r.int(0, 999)).padStart(3, "0") : "");
    return r.chance(0.35) ? "-" + s : s;
  };
  const ties = () => {
    // Quotients that land exactly halfway at the requested precision.
    const p = r.int(0, 4);
    const q = digits(r.int(1, 6)) + (r.chance(0.5) ? "" : "");
    const half = BigInt(q) * 10n + 5n;
    const a = (r.chance(0.5) ? "-" : "") + (half * 2n).toString();
    const b = "2" + "0".repeat(p + 1);
    return [a, b, p];
  };
  const bad = [
    () => [r.pick(["", "1.", ".5", "01", "+1", "1e3", "1,5", "--1", " 1", "0x10", "-", "1.2.3", "-0.", "00.5"]), "3", 2],
    () => ["10", r.pick(["0", "0.000", "-0", "-0.0"]), 2],
    () => ["1", "3", r.pick([-1, 1.5, 41, "2", null])],
    () => [r.pick([1, null, ["1"]]), "2", 0],
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = r.int(0, 9);
    if (k === 0) out.push(r.pick(bad)());
    else if (k <= 2) out.push(ties());
    else if (k === 3) out.push([r.pick(["-0.0001", "-0.004", "0.004", "-1", "-0"]), r.pick(["3", "7", "1000"]), r.int(0, 2)]);
    else out.push([num(), num().replace(/^-?0$/, "7"), r.pick([0, 1, 2, 2, 3, 6, 10, 20, r.int(0, 40)])]);
  }
  return out;
}
