function generate(seed, n) {
  const r = rngFrom(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const nodes = r.int(1, 9);
    const edges = [];
    for (let k = 0; k < r.int(0, nodes * 2); k++) edges.push([r.int(0, nodes - 1), r.int(0, nodes - 1), r.pick([1, 1, 1, 2, 2, 3, 5, 10, r.int(1, 20)])]);
    const from = r.int(0, nodes - 1);
    const to = r.int(0, nodes - 1);
    if (i === n - 1) out.push(r.pick([[0, [], 0, 0], [3, [[0, 1, 0]], 0, 1], [3, [[0, 1]], 0, 1], [2, [], 0, 2]]));
    else out.push([nodes, edges, from, to]);
  }
  return out;
}
