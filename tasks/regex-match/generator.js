function generate(seed, n) {
  const r = rngFrom(seed);
  const alpha = ["a", "b", "c"];
  const rep = (s, k) => Array.from({ length: k }, s).join("");
  // Each node returns [pattern, sample text the pattern matches].
  const lit = () => {
    const c = r.pick(["a", "b", "c", "a", "b", "-", "^", "$", "]", " "]);
    return [c, c];
  };
  const escaped = () => {
    const c = r.pick(["\\.", "\\*", "\\(", "\\[", "\\\\", "\\n", "\\t", "\\|", "\\{", "\\a"]);
    return [c, c[1]];
  };
  const short = () => {
    const k = r.pick(["d", "w", "s"]);
    return ["\\" + k, k === "d" ? String(r.int(0, 9)) : k === "w" ? r.pick(["a", "Z", "_", "7"]) : r.pick([" ", "\t", "\n"])];
  };
  const klass = () => {
    const items = r.pick([["a-c"], ["x", "y"], ["0-9", "_"], ["-", "a"], ["a", "-"], ["a-c", "-", "e"], ["\\]", "b"], ["\\d", "-", "z"], ["^", "a"], ["b-b"], [".", "*"]]);
    const neg = r.chance(0.3);
    const inside = { "a-c": "b", x: "x", y: "y", "0-9": "5", _: "_", "-": "-", a: "a", e: "e", "\\]": "]", b: "b", "\\d": "3", z: "z", "^": "^", "b-b": "b", ".": ".", "*": "*" };
    const pick = inside[r.pick(items)];
    return ["[" + (neg ? "^" : "") + items.join("") + "]", neg ? "q" : pick];
  };
  const atom = (d) => {
    const k = r.int(0, d > 0 ? 7 : 5);
    if (k <= 1) return lit();
    if (k === 2) return [".", r.pick(["a", "\n", "."])];
    if (k === 3) return r.chance(0.5) ? escaped() : short();
    if (k <= 5) return klass();
    const [p, s] = alt(d - 1);
    return ["(" + p + ")", s];
  };
  const quant = ([p, s]) => {
    const k = r.int(0, 9);
    if (k === 0) return [p + "*", rep(() => s, r.int(0, 3))];
    if (k === 1) return [p + "+", rep(() => s, r.int(1, 3))];
    if (k === 2) return [p + "?", r.chance(0.5) ? s : ""];
    if (k === 3) {
      const m = r.int(0, 3);
      return [p + "{" + m + "}", rep(() => s, m)];
    }
    if (k === 4) {
      const m = r.int(0, 2);
      const x = m + r.int(0, 2);
      return [p + "{" + m + "," + x + "}", rep(() => s, r.int(m, x))];
    }
    if (k === 5) {
      const m = r.int(0, 2);
      return [p + "{" + m + ",}", rep(() => s, m + r.int(0, 2))];
    }
    return [p, s];
  };
  const seq = (d) => {
    const k = r.int(d >= 2 ? 1 : 0, 3);
    let p = "";
    let s = "";
    for (let j = 0; j < k; j++) {
      const [ap, as] = quant(atom(d));
      p += ap;
      s += as;
    }
    return [p, s];
  };
  const alt = (d) => {
    const k = r.chance(0.3) ? r.int(2, 3) : 1;
    const parts = Array.from({ length: k }, () => seq(d));
    const chosen = r.pick(parts);
    return [parts.map((x) => x[0]).join("|"), chosen[1]];
  };
  const mutate = (s) => {
    const k = r.int(0, 3);
    if (k === 0 || s === "") return s + r.pick(alpha);
    const j = r.int(0, s.length - 1);
    if (k === 1) return s.slice(0, j) + s.slice(j + 1);
    if (k === 2) return s.slice(0, j) + r.pick(["a", "b", "z", "-", "\n"]) + s.slice(j + 1);
    return s + s;
  };
  const invalid = [
    "a**", "a+?", "*a", "a|*", "(?:a)", "a{2}{3}", "a{3,1}", "a{", "a{,2}", "a{1,x}", "a}", "(ab", "ab)", "[]", "[^]",
    "[abc", "[z-a]", "[a-\\d]", "a\\", "[a\\", "(|*)", "{2}", "a{1001}", "x(?=a)", "(a)(b))",
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      out.push(r.pick([[null, "a"], ["a", 5], [["a"], "a"], ["a"]]));
      continue;
    }
    if (r.chance(0.22)) {
      const bad = r.pick(invalid);
      out.push([r.chance(0.5) ? bad : "a" + bad, "aa"]);
      continue;
    }
    const [p, s] = alt(2);
    const text = (r.chance(0.55) ? s : mutate(s)).slice(0, 14);
    out.push([p, text]);
  }
  return out;
}
