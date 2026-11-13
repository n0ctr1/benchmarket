function resolvePointer(doc, pointer) {
  if (typeof pointer !== "string") return null;
  if (pointer === "") return { found: true, value: doc };
  if (pointer[0] !== "/") return null;
  const parts = pointer.slice(1).split("/");
  let cur = doc;
  for (const raw of parts) {
    if (/~(?![01])/.test(raw)) return null;
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return { found: false };
      const i = Number(key);
      if (i >= cur.length) return { found: false };
      cur = cur[i];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return { found: false };
      cur = cur[key];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}
