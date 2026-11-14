// Child process that runs one answer against a list of inputs.
// Started by sandbox.ts with --permission (no filesystem, no child processes, no workers)
// and a small heap. The answer runs inside a vm context with code generation from strings
// disabled, so eval and Function are unavailable. Expected outputs never reach this process.
import vm from "node:vm";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const { code, fn, inputs, perTestMs, sqljs } = JSON.parse(input);

const out = { compileError: null, results: [] };

// SQL tasks (`fn` is `sql:<name>`): the answer is one SQLite SELECT statement, data rather than
// code. Each test's first argument builds a fresh in-memory database; the result rows are the
// output. SQLite runs in WebAssembly in this process; the vm context is not involved.
if (typeof fn === "string" && fn.startsWith("sql:")) {
  // SQL comments (`-- ...` to the end of a line, `/* ... */`) are not part of the statement.
  const query = String(code)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, "")
    .trim()
    .replace(/;\s*$/, "");
  if (!/^(with|select)\b/i.test(query) || query.includes(";")) {
    out.compileError = "the answer must be one SELECT (or WITH ... SELECT) statement, without semicolons inside";
  } else {
    const { default: initSqlJs } = await import(sqljs.module);
    const SQL = await initSqlJs({ locateFile: () => sqljs.wasm });
    for (const args of inputs) {
      const started = performance.now();
      const db = new SQL.Database();
      try {
        db.run(String(args[0]));
        const res = db.exec(query);
        const rows = res.length ? res[res.length - 1].values : [];
        out.results.push({ output: JSON.stringify(rows), error: null, ms: performance.now() - started });
      } catch (e) {
        out.results.push({ output: null, error: String(e && e.message ? e.message : e).slice(0, 200), ms: performance.now() - started });
      } finally {
        db.close();
      }
    }
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
const ctx = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});

// Serializer defined inside the context so it handles the context's own values.
// Non-finite numbers and undefined get explicit markers so they never pass as null.
vm.runInContext(
  `globalThis.__ser = function (v) {
     return JSON.stringify(v, function (k, x) {
       if (x === undefined) return "__undefined__";
       if (typeof x === "number" && !isFinite(x)) return "__nonfinite__" + String(x);
       if (typeof x === "bigint") return "__bigint__" + String(x);
       if (typeof x === "function") return "__function__";
       return x;
     });
   };`,
  ctx,
);

try {
  new vm.Script(code, { filename: "answer.js" }).runInContext(ctx, { timeout: perTestMs });
  const kind = vm.runInContext(`typeof ${fn}`, ctx, { timeout: perTestMs });
  if (kind !== "function") out.compileError = `${fn} is not defined as a function`;
} catch (e) {
  out.compileError = String(e && e.message ? e.message : e).slice(0, 300);
}

if (!out.compileError) {
  const call = new vm.Script(`__out = __ser(${fn}(...JSON.parse(__in)))`, { filename: "call.js" });
  for (const args of inputs) {
    ctx.__in = JSON.stringify(args);
    ctx.__out = undefined;
    const started = performance.now();
    try {
      call.runInContext(ctx, { timeout: perTestMs });
      const raw = ctx.__out;
      out.results.push({ output: typeof raw === "string" ? raw : null, error: null, ms: performance.now() - started });
    } catch (e) {
      out.results.push({ output: null, error: String(e && e.message ? e.message : e).slice(0, 200), ms: performance.now() - started });
    }
  }
}

process.stdout.write(JSON.stringify(out));
