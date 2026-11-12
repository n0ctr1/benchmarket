function generate(seed, n) {
  const r = rngFrom(seed);
  const ws = () => r.pick(["", "", " ", "  ", "\t", "\n"]);
  const number = () => (r.chance(0.7) ? String(r.int(0, 99)) : `${r.int(0, 20)}.${r.pick(["5", "25", "75", "125", "1"])}`);
  const expr = (d) => {
    if (d <= 0 || r.chance(0.25)) {
      let x = number();
      if (r.chance(0.2)) x = r.pick(["-", "+", "--", "-+"]) + ws() + x;
      return x;
    }
    if (r.chance(0.2)) return "(" + ws() + expr(d - 1) + ws() + ")";
    return expr(d - 1) + ws() + r.pick(["+", "-", "*", "/"]) + ws() + expr(d - 1);
  };
  const bad = [
    () => expr(2) + ws() + r.pick(["+", "*", "/"]),
    () => "(" + expr(2),
    () => expr(2) + ")",
    () => expr(1) + " " + number(),
    () => expr(1) + r.pick(["%", "^", "x", "&"]) + expr(1),
    () => expr(1) + " / (" + number() + " - " + "$" + ")",
    () => r.pick(["1.", ".5", "1..2", "1e3", "()"]),
    () => expr(1) + " / " + r.pick(["0", "(2 - 2)", "0.0", "(1 - 1) * 3"]),
    () => r.pick(["", "   "]),
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1) out.push([r.pick([42, null, ["1+1"]])]);
    else out.push([r.chance(0.6) ? expr(r.int(1, 4)) : r.pick(bad)().replace("$", String(r.int(1, 5)))]);
  }
  return out;
}
