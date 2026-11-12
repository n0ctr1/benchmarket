function generate(seed, n) {
  const r = rngFrom(seed);
  const units = ["w", "d", "h", "m", "s"];
  const ws = () => r.pick(["", "", " ", "  ", "\t", " \t "]);
  const num = () => {
    const v = String(r.pick([0, 1, 2, 7, 12, 30, 59, 60, 99, 365, 1000, r.int(0, 99999)]));
    return r.chance(0.15) ? "0".repeat(r.int(1, 2)) + v : v;
  };
  const unit = (u) => (r.chance(0.3) ? u.toUpperCase() : u);
  const valid = () => {
    const us = r.shuffle(units).slice(0, r.int(1, 5));
    return (r.chance(0.2) ? " " : "") + us.map((u) => num() + unit(u)).join(ws()) + (r.chance(0.2) ? "\n" : "");
  };
  const bad = [
    () => { const u = r.pick(units); return `${num()}${u}${ws()}${num()}${u}`; },
    () => `${r.int(1, 9)}.${r.int(1, 9)}${r.pick(units)}`,
    () => `${r.pick(["-", "+"])}${num()}${r.pick(units)}`,
    () => num(),
    () => `${num()}${r.pick(["y", "ms", "x", "sec", "min"])}`,
    () => `${num()} ${r.pick(units)}`,
    () => r.pick(["", "   ", "\t"]),
    () => `${r.int(9007199, 9999999)}${"9".repeat(r.int(9, 11))}w`,
    () => `${num()}${r.pick(units)},${num()}${r.pick(units)}`,
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1) out.push([r.pick([5, null, ["1h"]])]);
    else out.push([r.chance(0.55) ? valid() : r.pick(bad)()]);
  }
  return out;
}
