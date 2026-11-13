function generate(seed, n) {
  const r = rngFrom(seed);
  const keys = ["a", "b", "c", "d", "e", "", "A"];
  const op = () =>
    r.pick([
      () => ["put", r.pick(keys), r.int(-5, 99)],
      () => ["put", r.pick(keys), r.int(-5, 99)],
      () => ["get", r.pick(keys)],
      () => ["get", r.pick(keys)],
      () => ["del", r.pick(keys)],
      () => ["keys"],
    ])();
  const bad = () =>
    r.pick([
      ["put", "a"],
      ["put", "a", 1.5],
      ["put", 1, 2],
      ["get"],
      ["peek", "a"],
      ["keys", "a"],
      "get",
      ["GET", "a"],
    ]);
  const out = [];
  for (let i = 0; i < n; i++) {
    const cap = r.pick([0, 1, 2, 3, 3, 4, 5]);
    const ops = Array.from({ length: r.int(1, 14) }, op);
    if (i === n - 1) out.push([r.pick([-1, 1.5, "2"]), ops]);
    else if (r.chance(0.12)) out.push([cap, [...ops.slice(0, 3), bad(), ...ops.slice(3)]]);
    else out.push([cap, ops]);
  }
  return out;
}
