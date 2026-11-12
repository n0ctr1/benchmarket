function generate(seed, n) {
  const r = rngFrom(seed);
  const core = () => [r.int(0, 3), r.int(0, 5), r.int(0, 12)];
  const pre = () => (r.chance(0.3) ? "-" + Array.from({ length: r.int(1, 2) }, () => r.pick(["alpha", "beta", "rc", "0", "1", "2", "11", "x-y"])).join(".") : "");
  const version = (c) => (c || core()).join(".") + pre();
  const near = (c) => {
    const d = c.slice();
    const k = r.int(0, 2);
    d[k] = Math.max(0, d[k] + r.pick([-1, 0, 1]));
    return d;
  };
  const comparator = (c) => r.pick(["", "=", "<", "<=", ">", ">=", "^", "~"]) + version(near(c));
  const set = (c) => Array.from({ length: r.int(1, 2) }, () => comparator(c)).join(r.pick([" ", "  "]));
  const range = (c) => Array.from({ length: r.int(1, 2) }, () => set(c)).join(r.pick(["||", " || "]));
  const badVersion = () => r.pick(["1.2", "01.2.3", "1.2.3-", "1.2.3-01", "v1.2.3", "1.2.3.4", "1.2.3-a..b", ""]);
  const badRange = () => r.pick(["1.x", "1.2.3 - 2.0.0", "^1.2", "||", ">=1.0.0 ||", "~>1.2.3", "*", ">= 1.2.3"]);
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = core();
    if (i === n - 1) out.push([r.pick([1, null]), "1.0.0"]);
    else if (r.chance(0.12)) out.push([badVersion(), range(c)]);
    else if (r.chance(0.12)) out.push([version(c), badRange()]);
    else out.push([version(c), range(c)]);
  }
  return out;
}
