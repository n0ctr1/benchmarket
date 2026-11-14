function generate(seed, n) {
  const r = rngFrom(seed);
  const out = [];
  for (let t = 0; t < n; t++) {
    const sql = ["CREATE TABLE hits (user_id INTEGER, ts INTEGER);"];
    const users = r.int(0, 4);
    for (let u = 0; u < users; u++) {
      const uid = r.int(1, 50);
      let ts = r.int(0, 100000);
      for (let k = r.int(1, 8); k > 0; k--) {
        sql.push(`INSERT INTO hits VALUES (${uid}, ${ts});`);
        // Gaps at and around the 1800-second boundary, and repeated timestamps.
        ts += r.pick([0, 60, 600, 1799, 1800, 1801, 3600, r.int(1, 7200)]);
      }
    }
    // Rows go in shuffled: the order of insertion carries no meaning.
    const head = sql.shift();
    out.push([[head, ...r.shuffle(sql)].join("\n")]);
  }
  return out;
}
