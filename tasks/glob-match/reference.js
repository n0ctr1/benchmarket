function globMatch(pattern, path) {
  if (typeof pattern !== "string" || typeof path !== "string") return null;
  const lit = (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  let re = "";
  let i = 0;
  const p = pattern;
  while (i < p.length) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*" && (i === 0 || p[i - 1] === "/") && (i + 2 === p.length || p[i + 2] === "/")) {
      if (i + 2 === p.length) {
        re += i === 0 ? "[\\s\\S]*" : "[\\s\\S]*";
        i += 2;
      } else {
        re += "(?:[\\s\\S]*/)?";
        i += 3;
      }
    } else if (c === "*") {
      re += "[^/]*";
      while (p[i] === "*") i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "\\") {
      if (i + 1 >= p.length) return null;
      re += lit(p[i + 1]);
      i += 2;
    } else if (c === "[") {
      let j = i + 1;
      let neg = false;
      if (p[j] === "!") {
        neg = true;
        j++;
      }
      const items = [];
      let first = true;
      for (;;) {
        if (j >= p.length) return null;
        let ch = p[j];
        if (ch === "]" && !first) break;
        if (ch === "\\") {
          if (j + 1 >= p.length) return null;
          ch = p[j + 1];
          j++;
        }
        j++;
        first = false;
        if (p[j] === "-" && j + 1 < p.length && p[j + 1] !== "]") {
          let hi = p[j + 1];
          j += 2;
          if (hi === "\\") {
            if (j >= p.length) return null;
            hi = p[j];
            j++;
          }
          if (hi.charCodeAt(0) < ch.charCodeAt(0)) return null;
          items.push(lit(ch) + "-" + lit(hi));
        } else items.push(lit(ch));
      }
      re += neg ? "[^/" + items.join("") + "]" : "(?:(?!/)[" + items.join("") + "])";
      i = j + 1;
    } else {
      re += lit(c);
      i++;
    }
  }
  return new RegExp("^" + re + "$").test(path);
}
