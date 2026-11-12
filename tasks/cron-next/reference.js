function cronNext(expr, from) {
  if (typeof expr !== "string" || typeof from !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(from)) return null;
  const start = new Date(from);
  if (isNaN(start.getTime())) return null;

  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

  function parseField(text, [lo, hi]) {
    const set = new Set();
    for (const el of text.split(",")) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(el);
      if (!m) return null;
      let a, b;
      if (m[1] === "*") {
        a = lo;
        b = hi;
      } else {
        a = Number(m[2]);
        b = m[3] !== undefined ? Number(m[3]) : a;
        if (m[4] !== undefined && m[3] === undefined) return null;
      }
      const step = m[4] !== undefined ? Number(m[4]) : 1;
      if (step < 1 || a < lo || b > hi || a > b) return null;
      for (let x = a; x <= b; x += step) set.add(x);
    }
    return set;
  }

  const sets = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(fields[i], bounds[i]);
    if (!s) return null;
    sets.push(s);
  }
  const [mins, hours, doms, months, dows] = sets;
  if (dows.has(7)) dows.add(0);
  const domRestricted = !fields[2].startsWith("*");
  const dowRestricted = !fields[4].startsWith("*");

  function dayMatches(d) {
    const domOk = doms.has(d.getUTCDate());
    const dowOk = dows.has(d.getUTCDay());
    if (domRestricted && dowRestricted) return domOk || dowOk;
    return domOk && dowOk;
  }

  // First candidate minute: the minute after `from`, truncated to the minute.
  const first = new Date(start.getTime());
  first.setUTCSeconds(0, 0);
  first.setUTCMinutes(first.getUTCMinutes() + 1);
  const limit = start.getTime() + 5 * 366 * 86400000;

  const day = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()));
  while (day.getTime() <= limit) {
    if (months.has(day.getUTCMonth() + 1) && dayMatches(day)) {
      for (let h = 0; h < 24; h++) {
        if (!hours.has(h)) continue;
        for (let mi = 0; mi < 60; mi++) {
          if (!mins.has(mi)) continue;
          const t = day.getTime() + h * 3600000 + mi * 60000;
          if (t >= first.getTime() && t <= limit) return new Date(t).toISOString();
        }
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return null;
}
