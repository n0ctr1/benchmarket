function decodeUtf8(bytes) {
  if (!Array.isArray(bytes)) return null;
  for (const b of bytes) if (!Number.isInteger(b) || b < 0 || b > 255) return null;
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out.push(b);
      i++;
      continue;
    }
    let need = 0;
    let cp = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      cp = b & 0x0f;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      cp = b & 0x07;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else {
      out.push(0xfffd);
      i++;
      continue;
    }
    let j = i + 1;
    let ok = true;
    for (let k = 0; k < need; k++, j++) {
      const c = bytes[j];
      const min = k === 0 ? lo : 0x80;
      const max = k === 0 ? hi : 0xbf;
      if (c === undefined || c < min || c > max) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (ok) {
      out.push(cp);
      i = j;
    } else {
      out.push(0xfffd);
      i = j;
    }
  }
  return out;
}
