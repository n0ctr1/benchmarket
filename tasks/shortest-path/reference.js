function shortestPath(n, edges, from, to) {
  const okInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
  if (!okInt(n, 1, 1000) || !Array.isArray(edges) || !okInt(from, 0, n - 1) || !okInt(to, 0, n - 1)) return null;
  const adj = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 3 || !okInt(e[0], 0, n - 1) || !okInt(e[1], 0, n - 1) || !okInt(e[2], 1, 1e6)) return null;
    adj[e[0]].push([e[1], e[2]]);
    adj[e[1]].push([e[0], e[2]]);
  }
  // Dijkstra on (cost, path) with paths compared lexicographically as number arrays.
  const less = (a, b) => {
    if (a.cost !== b.cost) return a.cost < b.cost;
    for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) if (a.path[i] !== b.path[i]) return a.path[i] < b.path[i];
    return a.path.length < b.path.length;
  };
  const best = new Array(n).fill(null);
  best[from] = { cost: 0, path: [from] };
  const done = new Array(n).fill(false);
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && best[i] && (u < 0 || less(best[i], best[u]))) u = i;
    if (u < 0) break;
    done[u] = true;
    if (u === to) break;
    for (const [v, w] of adj[u]) {
      if (done[v]) continue;
      const cand = { cost: best[u].cost + w, path: [...best[u].path, v] };
      if (!best[v] || less(cand, best[v])) best[v] = cand;
    }
  }
  return best[to] ? { cost: best[to].cost, path: best[to].path } : null;
}
