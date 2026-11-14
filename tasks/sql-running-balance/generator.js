function generate(seed, n) {
  const r = rngFrom(seed);
  const accounts = ["acme", "bolt", "core", "dune", "echo"];
  const out = [];
  for (let t = 0; t < n; t++) {
    const sql = ["CREATE TABLE ledger (id INTEGER PRIMARY KEY, account TEXT, day INTEGER, delta INTEGER);"];
    const rows = r.int(0, 18);
    const used = accounts.slice(0, r.int(1, accounts.length));
    // Inserted out of day order, several entries on one day, and negative balances along the way.
    for (let i = 1; i <= rows; i++) {
      sql.push(`INSERT INTO ledger VALUES (${i}, '${r.pick(used)}', ${r.int(1, 9)}, ${r.pick([-500, -120, -40, 0, 25, 100, 300, r.int(-999, 999)])});`);
    }
    out.push([sql.join("\n")]);
  }
  return out;
}
