function evalExpr(s) {
  if (typeof s !== "string") return null;
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if ("+-*/()".includes(c)) {
      tokens.push(c);
      i++;
    } else if (c >= "0" && c <= "9") {
      let j = i;
      while (j < s.length && s[j] >= "0" && s[j] <= "9") j++;
      if (s[j] === ".") {
        j++;
        const start = j;
        while (j < s.length && s[j] >= "0" && s[j] <= "9") j++;
        if (j === start) return null;
      }
      tokens.push(Number(s.slice(i, j)));
      i = j;
    } else {
      return null;
    }
  }
  if (tokens.length === 0) return null;
  let pos = 0;
  const fail = {};
  const peek = () => tokens[pos];
  function expr() {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[pos++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function term() {
    let v = unary();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[pos++];
      const r = unary();
      if (op === "/") {
        if (r === 0) throw fail;
        v = v / r;
      } else {
        v = v * r;
      }
    }
    return v;
  }
  function unary() {
    if (peek() === "-") {
      pos++;
      return -unary();
    }
    if (peek() === "+") {
      pos++;
      return unary();
    }
    return primary();
  }
  function primary() {
    const t = peek();
    if (typeof t === "number") {
      pos++;
      return t;
    }
    if (t === "(") {
      pos++;
      const v = expr();
      if (peek() !== ")") throw fail;
      pos++;
      return v;
    }
    throw fail;
  }
  try {
    const v = expr();
    if (pos !== tokens.length) return null;
    return v;
  } catch (e) {
    if (e === fail) return null;
    throw e;
  }
}
