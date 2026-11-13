function parseQuery(qs) {
  if (typeof qs !== "string") return null;
  const s = qs.startsWith("?") ? qs.slice(1) : qs;
  const utf8 = (cp, out) => {
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  };
  const decodeBytes = (b) => {
    let text = "";
    for (let i = 0; i < b.length; ) {
      const x = b[i];
      let need, cp, lo = 0x80, hi = 0xbf;
      if (x < 0x80) { text += String.fromCharCode(x); i++; continue; }
      else if (x >= 0xc2 && x <= 0xdf) { need = 1; cp = x & 31; }
      else if (x >= 0xe0 && x <= 0xef) { need = 2; cp = x & 15; if (x === 0xe0) lo = 0xa0; if (x === 0xed) hi = 0x9f; }
      else if (x >= 0xf0 && x <= 0xf4) { need = 3; cp = x & 7; if (x === 0xf0) lo = 0x90; if (x === 0xf4) hi = 0x8f; }
      else return null;
      for (let k = 1; k <= need; k++) {
        const y = b[i + k];
        if (y === undefined || y < (k === 1 ? lo : 0x80) || y > (k === 1 ? hi : 0xbf)) return null;
        cp = (cp << 6) | (y & 63);
      }
      text += String.fromCodePoint(cp);
      i += need + 1;
    }
    return text;
  };
  const decode = (t) => {
    const bytes = [];
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === "+") bytes.push(0x20);
      else if (c === "%") {
        const h = t.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) return null;
        bytes.push(parseInt(h, 16));
        i += 2;
      } else {
        const cp = t.codePointAt(i);
        if (cp > 0xffff) i++;
        utf8(cp, bytes);
      }
    }
    return decodeBytes(bytes);
  };
  const out = {};
  for (const piece of s.split("&")) {
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    const k = decode(eq < 0 ? piece : piece.slice(0, eq));
    const v = decode(eq < 0 ? "" : piece.slice(eq + 1));
    if (k === null || v === null) return null;
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
}
