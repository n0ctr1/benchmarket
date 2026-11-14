function generate(seed, n) {
  const r = rngFrom(seed);
  const names = ["Ada", "Bo", "Chen", "Dara", "Eli", "Fay", "Gus", "Hana", "Ivo", "Juno", "Kai", "Lea", "O'Neil", "Mo", "Nia"];
  const countries = ["DE", "FR", "JP", "BR", "US", "KE"];
  const statuses = ["paid", "paid", "paid", "refunded", "pending"];
  const q = (s) => "'" + s.replace(/'/g, "''") + "'";
  const out = [];
  for (let t = 0; t < n; t++) {
    const nc = r.int(0, 9);
    const sql = ["CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, country TEXT);", "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount_cents INTEGER, status TEXT);"];
    const ids = r.shuffle(Array.from({ length: 40 }, (_, i) => i + 1)).slice(0, nc);
    for (const id of ids) sql.push(`INSERT INTO customers VALUES (${id}, ${q(r.pick(names))}, ${q(r.pick(countries.slice(0, r.int(2, countries.length))))});`);
    let oid = 1;
    for (const id of ids) {
      // Equal totals are common on purpose: ties go to the smaller customer id.
      for (let k = r.int(0, 4); k > 0; k--) sql.push(`INSERT INTO orders VALUES (${oid++}, ${id}, ${r.pick([500, 1000, 1500, 2500, r.int(1, 9999)])}, ${q(r.pick(statuses))});`);
    }
    // An order for a customer that does not exist counts for nobody.
    if (r.chance(0.3)) sql.push(`INSERT INTO orders VALUES (${oid++}, 99, 7777, 'paid');`);
    out.push([sql.join("\n")]);
  }
  return out;
}
