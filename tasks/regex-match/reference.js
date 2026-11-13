function regexMatch(pattern, text) {
  if (typeof pattern !== "string" || typeof text !== "string") return null;
  const p = pattern;
  let i = 0;
  const fail = {};
  const sets = {
    d: (c) => c >= "0" && c <= "9",
    w: (c) => /[A-Za-z0-9_]/.test(c),
    s: (c) => " \t\n\r\f\v".includes(c),
  };
  // AST nodes: {t:"char", test}, {t:"seq", xs}, {t:"alt", xs}, {t:"rep", x, lo, hi}.
  function alternation() {
    const xs = [sequence()];
    while (p[i] === "|") {
      i++;
      xs.push(sequence());
    }
    return xs.length === 1 ? xs[0] : { t: "alt", xs };
  }
  function sequence() {
    const xs = [];
    while (i < p.length && p[i] !== "|" && p[i] !== ")") {
      let a = atom();
      let quantified = false;
      while (i < p.length && "*+?{".includes(p[i])) {
        if (quantified) throw fail;
        a = quantifier(a);
        quantified = true;
      }
      xs.push(a);
    }
    return { t: "seq", xs };
  }
  function quantifier(x) {
    const c = p[i++];
    if (c === "*") return { t: "rep", x, lo: 0, hi: Infinity };
    if (c === "+") return { t: "rep", x, lo: 1, hi: Infinity };
    if (c === "?") return { t: "rep", x, lo: 0, hi: 1 };
    const m = /^(\d+)(,(\d*))?\}/.exec(p.slice(i));
    if (!m) throw fail;
    i += m[0].length;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : m[3] === "" ? Infinity : Number(m[3]);
    if (lo > 1000 || (hi !== Infinity && hi > 1000) || hi < lo) throw fail;
    return { t: "rep", x, lo, hi };
  }
  const char = (test) => ({ t: "char", test });
  function atom() {
    const c = p[i];
    if (c === "*" || c === "+" || c === "?" || c === "{" || c === "}") throw fail;
    if (c === "(") {
      i++;
      const inner = alternation();
      if (p[i] !== ")") throw fail;
      i++;
      return inner;
    }
    if (c === "[") return cls();
    i++;
    if (c === ".") return char(() => true);
    if (c === "\\") {
      const d = p[i++];
      if (d === undefined) throw fail;
      if (sets[d]) return char(sets[d]);
      return char((x) => x === d);
    }
    return char((x) => x === c);
  }
  function classItem() {
    const c = p[i];
    if (c === undefined) throw fail;
    i++;
    if (c !== "\\") return { ch: c };
    const d = p[i++];
    if (d === undefined) throw fail;
    return sets[d] ? { set: sets[d] } : { ch: d };
  }
  function cls() {
    i++;
    let neg = false;
    if (p[i] === "^") {
      neg = true;
      i++;
    }
    const tests = [];
    for (;;) {
      if (i >= p.length) throw fail;
      if (p[i] === "]") break;
      const a = classItem();
      if (!a.set && p[i] === "-" && p[i + 1] !== undefined && p[i + 1] !== "]") {
        i++;
        const b = classItem();
        if (b.set || b.ch < a.ch) throw fail;
        tests.push((x) => x >= a.ch && x <= b.ch);
      } else {
        tests.push(a.set ?? ((x) => x === a.ch));
      }
    }
    i++;
    if (tests.length === 0) throw fail;
    return char((x) => tests.some((t) => t(x)) !== neg);
  }
  let root;
  try {
    root = alternation();
    if (i < p.length) throw fail;
  } catch (e) {
    if (e === fail) return null;
    throw e;
  }
  // Set-based matching: ends(node, start) is every position the node can stop at. No
  // backtracking, so every pattern runs in polynomial time.
  const L = text.length;
  const memo = new Map();
  let ids = 0;
  function ends(node, start) {
    node.id ??= ids++;
    const key = node.id * (L + 1) + start;
    if (memo.has(key)) return memo.get(key);
    let out;
    if (node.t === "char") {
      out = start < L && node.test(text[start]) ? [start + 1] : [];
    } else if (node.t === "seq") {
      let cur = new Set([start]);
      for (const x of node.xs) {
        const next = new Set();
        for (const q of cur) for (const e of ends(x, q)) next.add(e);
        cur = next;
      }
      out = [...cur];
    } else if (node.t === "alt") {
      const s = new Set();
      for (const x of node.xs) for (const e of ends(x, start)) s.add(e);
      out = [...s];
    } else {
      // Past lo + L repetitions nothing new is reachable (at most L of them consume input).
      const cap = Math.min(node.hi, node.lo + L + 1);
      const s = new Set();
      let cur = new Set([start]);
      if (node.lo === 0) s.add(start);
      for (let k = 1; k <= cap && cur.size > 0; k++) {
        const next = new Set();
        for (const q of cur) for (const e of ends(node.x, q)) next.add(e);
        cur = next;
        if (k >= node.lo) for (const e of cur) s.add(e);
      }
      out = [...s];
    }
    memo.set(key, out);
    return out;
  }
  return ends(root, 0).includes(L);
}
