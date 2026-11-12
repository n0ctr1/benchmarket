function parseDuration(s) {
  if (typeof s !== "string") return null;
  const units = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  const text = s.trim();
  if (text === "") return null;
  const re = /\s*(\d+)([a-zA-Z])/y;
  const seen = new Set();
  let total = 0n;
  let pos = 0;
  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) return null;
    const unit = m[2].toLowerCase();
    if (!(unit in units) || seen.has(unit)) return null;
    seen.add(unit);
    total += BigInt(m[1]) * BigInt(units[unit]);
    pos = re.lastIndex;
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(total);
}
