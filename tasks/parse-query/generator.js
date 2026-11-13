function generate(seed, n) {
  const r = rngFrom(seed);
  const names = ["a", "b", "q", "", "A", "x y", "k%20", "id", "%C3%A9", "+"];
  const vals = ["1", "", "two+words", "%2B", "a=b", "%E2%9C%93", "%e2%9c%93", "x%26y", "%F0%9F%98%80", "caf%C3%A9"];
  const piece = () => (r.chance(0.15) ? r.pick(names) : r.pick(names) + "=" + r.pick(vals));
  const bad = () => r.pick(["a=%", "a=%4", "%zz=1", "a=%C3", "a=%FF", "b=%E2%9C", "%80"]);
  const out = [];
  for (let i = 0; i < n; i++) {
    const parts = Array.from({ length: r.int(0, 6) }, () => (r.chance(0.1) ? "" : piece()));
    if (r.chance(0.12)) parts.splice(r.int(0, parts.length), 0, bad());
    const s = (r.chance(0.3) ? "?" : "") + parts.join("&");
    if (i === n - 1) out.push([r.pick([null, 12, ["a=1"]])]);
    else out.push([s]);
  }
  return out;
}
