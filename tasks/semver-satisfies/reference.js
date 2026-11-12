function semverSatisfies(version, range) {
  if (typeof version !== "string" || typeof range !== "string") return null;
  const num = "(0|[1-9]\\d*)";
  const ident = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
  const verRe = new RegExp(`^${num}\\.${num}\\.${num}(?:-(${ident}(?:\\.${ident})*))?$`);

  function parse(v) {
    const m = verRe.exec(v);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] === undefined ? [] : m[4].split(".") };
  }

  function cmpIdent(a, b) {
    const an = /^\d+$/.test(a);
    const bn = /^\d+$/.test(b);
    if (an && bn) return Math.sign(Number(a) - Number(b));
    if (an) return -1;
    if (bn) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function cmp(a, b) {
    for (const k of ["major", "minor", "patch"]) {
      if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
    }
    if (a.pre.length === 0 && b.pre.length === 0) return 0;
    if (a.pre.length === 0) return 1;
    if (b.pre.length === 0) return -1;
    const n = Math.min(a.pre.length, b.pre.length);
    for (let i = 0; i < n; i++) {
      const c = cmpIdent(a.pre[i], b.pre[i]);
      if (c !== 0) return c;
    }
    return Math.sign(a.pre.length - b.pre.length);
  }

  const v = parse(version);
  if (!v) return null;

  function expand(token) {
    const m = /^(<=|>=|<|>|=|\^|~)?(.*)$/.exec(token);
    const op = m[1] || "=";
    const base = parse(m[2]);
    if (!base) return null;
    const plain = (major, minor, patch) => ({ major, minor, patch, pre: [] });
    if (op === "^") {
      let upper;
      if (base.major > 0) upper = plain(base.major + 1, 0, 0);
      else if (base.minor > 0) upper = plain(0, base.minor + 1, 0);
      else upper = plain(0, 0, base.patch + 1);
      return [{ op: ">=", v: base }, { op: "<", v: upper }];
    }
    if (op === "~") {
      return [{ op: ">=", v: base }, { op: "<", v: plain(base.major, base.minor + 1, 0) }];
    }
    return [{ op, v: base }];
  }

  const sets = range.split("||").map((s) => s.trim());
  const parsed = [];
  for (const s of sets) {
    if (s === "") return null;
    const comps = [];
    for (const token of s.split(/\s+/)) {
      const e = expand(token);
      if (!e) return null;
      comps.push(...e);
    }
    parsed.push(comps);
  }

  const test = (c) => {
    const r = cmp(v, c.v);
    switch (c.op) {
      case "=": return r === 0;
      case "<": return r < 0;
      case "<=": return r <= 0;
      case ">": return r > 0;
      case ">=": return r >= 0;
    }
    return false;
  };

  for (const comps of parsed) {
    if (!comps.every(test)) continue;
    if (v.pre.length > 0) {
      const allowed = comps.some(
        (c) => c.v.pre.length > 0 && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch
      );
      if (!allowed) continue;
    }
    return true;
  }
  return false;
}
