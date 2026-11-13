function lruTrace(capacity, ops) {
  if (!Number.isInteger(capacity) || capacity < 0 || !Array.isArray(ops)) return null;
  const cache = new Map();
  const out = [];
  for (const op of ops) {
    if (!Array.isArray(op)) return null;
    if (op[0] === "get" && op.length === 2 && typeof op[1] === "string") {
      if (cache.has(op[1])) {
        const v = cache.get(op[1]);
        cache.delete(op[1]);
        cache.set(op[1], v);
        out.push(v);
      } else out.push(null);
    } else if (op[0] === "put" && op.length === 3 && typeof op[1] === "string" && Number.isInteger(op[2])) {
      if (capacity === 0) continue;
      if (cache.has(op[1])) cache.delete(op[1]);
      else if (cache.size >= capacity) cache.delete(cache.keys().next().value);
      cache.set(op[1], op[2]);
    } else if (op[0] === "del" && op.length === 2 && typeof op[1] === "string") {
      out.push(cache.delete(op[1]));
    } else if (op[0] === "keys" && op.length === 1) {
      out.push([...cache.keys()].reverse());
    } else return null;
  }
  return out;
}
