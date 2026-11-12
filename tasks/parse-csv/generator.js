function generate(seed, n) {
  const r = rngFrom(seed);
  const plain = () => r.pick(["", "a", "b c", "42", "x y z", " pad ", "é", "tab\there"]);
  const special = () => r.pick(["a,b", "say \"hi\"", "line1\nline2", "crlf\r\nend", ",", "\"", ""]);
  const field = () => {
    if (r.chance(0.35)) return '"' + special().replace(/"/g, '""') + '"';
    if (r.chance(0.15)) return '"' + plain() + '"';
    return plain();
  };
  const record = () => Array.from({ length: r.int(1, 4) }, field).join(",");
  const valid = () => {
    const eol = r.pick(["\n", "\r\n"]);
    const body = Array.from({ length: r.int(1, 4) }, record).join(eol);
    return body + (r.chance(0.3) ? eol : "");
  };
  const bad = [
    () => record() + "\r" + record(),
    () => "ab\"c," + record(),
    () => '"abc"x,' + record(),
    () => record() + ',"unterminated',
    () => '"a""' ,
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1) out.push([r.pick([1, null, ["a,b"]])]);
    else out.push([r.chance(0.65) ? valid() : r.pick(bad)()]);
  }
  return out;
}
