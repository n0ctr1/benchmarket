function generate(seed, n) {
  const r = rngFrom(seed);
  const segs = ["src", "a", "b", "lib", "x.ts", "index.ts", "README.md", ".env", "a-b", "z", "[", "*", "?"];
  const path = () => Array.from({ length: r.int(0, 4) }, () => r.pick(segs)).join("/");
  const atom = () => r.pick(["*", "?", "**", "*.ts", "a*", "[ab]", "[!a]", "[a-c]", "[]x]", "[!]]", "\\*", "\\?", "src", "a", "b", "lib", "*.md", "[-a]", "x[0-9]"]);
  const pattern = () => Array.from({ length: r.int(1, 4) }, atom).join("/");
  const bad = () => r.pick(["a\\", "[abc", "[z-a]", "src/[!", "**/[b-a].ts"]);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1) out.push(r.pick([[null, "a"], ["a", 5], [bad(), "a"]]));
    else if (r.chance(0.1)) out.push([bad(), path()]);
    else {
      const pt = pattern();
      // Half the paths are built to fit the pattern's shape.
      const fit = pt.split("/").map((s) => (s === "**" ? Array.from({ length: r.int(0, 2) }, () => r.pick(segs)).join("/") : s.replace(/\*+/g, () => r.pick(["", "x", "ab"])).replace(/\?/g, "q").replace(/\[!?\]?[^\]]*\]/g, "a").replace(/\\/g, ""))).filter((s, k, a) => s !== "" || a.length === 1).join("/");
      out.push([pt, r.chance(0.5) ? fit : path()]);
    }
  }
  return out;
}
