// Child process that runs one answer against a list of inputs.
// Started by sandbox.ts with --permission (no filesystem, no child processes, no workers)
// and a small heap. The answer runs inside a vm context with code generation from strings
// disabled, so eval and Function are unavailable. Expected outputs never reach this process.
import vm from "node:vm";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const { code, fn, inputs, perTestMs } = JSON.parse(input);

const out = { compileError: null, results: [] };
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
