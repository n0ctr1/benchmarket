function decimalDiv(a, b, places) {
  const re = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
  if (typeof a !== "string" || typeof b !== "string" || !re.test(a) || !re.test(b)) return null;
  if (!Number.isInteger(places) || places < 0 || places > 40) return null;
  const parse = (s) => {
    const neg = s[0] === "-";
    const [ip, fp = ""] = s.replace("-", "").split(".");
    return { n: BigInt(ip + fp) * (neg ? -1n : 1n), scale: fp.length };
  };
  const x = parse(a);
  const y = parse(b);
  if (y.n === 0n) return null;
  // a / b * 10^places = (x.n * 10^(y.scale + places)) / (y.n * 10^x.scale)
  let num = x.n * 10n ** BigInt(y.scale + places);
  let den = y.n * 10n ** BigInt(x.scale);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const neg = num < 0n;
  if (neg) num = -num;
  let q = num / den;
  const r = num % den;
  // Round half to even.
  if (2n * r > den || (2n * r === den && q % 2n === 1n)) q += 1n;
  let digits = q.toString().padStart(places + 1, "0");
  const out = places === 0 ? digits : digits.slice(0, -places) + "." + digits.slice(-places);
  return q === 0n || !neg ? out : "-" + out;
}
