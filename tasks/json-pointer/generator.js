function generate(seed, n) {
  const r = rngFrom(seed);
  const names = ["a", "b", "foo", "", " ", "a/b", "m~n", "~", "0", "10", "x y", "A", "-"];
  const leaf = () => r.pick([0, 1, -3, 2.5, "s", "", true, false, null]);
  const value = (d) => {
    if (d <= 0 || r.chance(0.3)) return leaf();
    if (r.chance(0.5)) return Array.from({ length: r.int(0, 4) }, () => value(d - 1));
    const o = {};
    for (const k of r.shuffle(names).slice(0, r.int(0, 4))) o[k] = value(d - 1);
    return o;
  };
  const esc = (k) => k.replace(/~/g, "~0").replace(/\//g, "~1");
  const walk = (doc) => {
    const toks = [];
    let cur = doc;
    for (let i = 0; i < r.int(0, 4); i++) {
      if (Array.isArray(cur) && cur.length) {
        const j = r.int(0, cur.length - 1);
        toks.push(String(j));
        cur = cur[j];
      } else if (cur && typeof cur === "object" && Object.keys(cur).length) {
        const k = r.pick(Object.keys(cur));
        toks.push(esc(k));
        cur = cur[k];
      } else break;
    }
    return toks.length ? "/" + toks.join("/") : "";
  };
  const mutate = (p) =>
    r.pick([
      () => p + "/" + r.pick(["zz", "9", "01", "-", "", "1.0"]),
      () => p.slice(1),
      () => p + "/~2",
      () => p + "/a~",
      () => (p || "/") + "~1",
      () => p.toUpperCase(),
    ])();
  const out = [];
  for (let i = 0; i < n; i++) {
    const doc = value(3);
    if (i === n - 1) out.push([doc, r.pick([7, null, ["/a"]])]);
    else out.push([doc, r.chance(0.5) ? walk(doc) : mutate(walk(doc))]);
  }
  return out;
}
