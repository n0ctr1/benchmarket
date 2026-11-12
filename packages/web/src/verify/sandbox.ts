/**
 * Runs untrusted answer code in the viewer's browser without giving it the page or the network.
 * A sandboxed iframe (opaque origin, CSP with no connections) starts a Worker per run; the worker
 * compiles the answer, then disables code generation from strings (as the verifier's Node sandbox
 * does) and calls the function on each input. A test that runs too long is cut by terminating the
 * worker; the run resumes on a fresh worker from the next input.
 */

export interface RawResult {
  output: string | null;
  error: string | null;
}

export interface RawRun {
  compileError: string | null;
  results: RawResult[];
}

const WORKER = String.raw`
for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "BroadcastChannel"]) {
  try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
}
const ser = (v) => JSON.stringify(v, function (k, x) {
  if (x === undefined) return "__undefined__";
  if (typeof x === "number" && !isFinite(x)) return "__nonfinite__" + String(x);
  if (typeof x === "bigint") return "__bigint__" + String(x);
  if (typeof x === "function") return "__function__";
  return x;
});
onmessage = (ev) => {
  const { code, fn, inputs, start } = ev.data;
  let f;
  try {
    f = new Function(code + "\n;return typeof " + fn + " === 'function' ? " + fn + " : undefined;")();
  } catch (e) {
    postMessage({ type: "compile", error: String((e && e.message) || e).slice(0, 300) });
    return;
  }
  if (!f) { postMessage({ type: "compile", error: fn + " is not defined as a function" }); return; }
  const blocked = function () { throw new EvalError("code generation from strings is disabled"); };
  for (const C of [Function, Object.getPrototypeOf(function* () {}).constructor, Object.getPrototypeOf(async function () {}).constructor]) {
    try { Object.defineProperty(C.prototype, "constructor", { value: blocked }); } catch (e) {}
  }
  self.eval = blocked;
  self.Function = blocked;
  for (let i = start; i < inputs.length; i++) {
    postMessage({ type: "start", i });
    let output = null, error = null;
    try { output = ser(f(...JSON.parse(JSON.stringify(inputs[i])))); } catch (e) { error = String((e && e.message) || e).slice(0, 200); }
    postMessage({ type: "result", i, output: typeof output === "string" ? output : null, error });
  }
  postMessage({ type: "done" });
};
`;

const FRAME = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:">
<script>
const WORKER = ${JSON.stringify(WORKER)};
const url = URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" }));
onmessage = (ev) => {
  const { id, code, fn, inputs, perTestMs } = ev.data;
  const results = new Array(inputs.length).fill(null);
  let w, timer, current = -1;
  const finish = (compileError) => { clearTimeout(timer); if (w) w.terminate(); parent.postMessage({ id, compileError: compileError || null, results }, "*"); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => {
    w.terminate();
    if (current < 0) return finish("timed out while compiling");
    results[current] = { output: null, error: "timed out" };
    if (current + 1 < inputs.length) launch(current + 1); else finish(null);
  }, perTestMs); };
  const launch = (start) => {
    w = new Worker(url);
    current = -1;
    w.onmessage = (m) => {
      const d = m.data;
      if (d.type === "compile") return finish(d.error);
      if (d.type === "start") { current = d.i; arm(); }
      if (d.type === "result") results[d.i] = { output: d.output, error: d.error };
      if (d.type === "done") finish(null);
    };
    w.onerror = (e) => { e.preventDefault(); finish(String(e.message || "worker error")); };
    arm();
    w.postMessage({ code, fn, inputs, start });
  };
  launch(0);
};
</script>`;

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let seq = 0;
const waiting = new Map<number, (r: RawRun) => void>();

function ensureFrame(): Promise<void> {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.display = "none";
    frame.srcdoc = FRAME;
    frame.onload = () => resolve();
    document.body.appendChild(frame);
    window.addEventListener("message", (ev) => {
      if (ev.source !== frame?.contentWindow) return;
      const d = ev.data as { id: number } & RawRun;
      const done = waiting.get(d.id);
      if (done) {
        waiting.delete(d.id);
        done({ compileError: d.compileError, results: d.results.map((r) => r ?? { output: null, error: "not run" }) });
      }
    });
  });
  return ready;
}

/** Runs `fn` from `code` on every input, isolated; returns serialized outputs. */
export async function runInBrowser(code: string, fn: string, inputs: unknown[][], perTestMs = 2000): Promise<RawRun> {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fn)) throw new Error(`bad function name ${fn}`);
  await ensureFrame();
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    frame!.contentWindow!.postMessage({ id, code, fn, inputs, perTestMs }, "*");
  });
}
