import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestCase } from "@benchmarket/shared";

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "runner.mjs");

export interface SandboxOptions {
  perTestMs?: number;
  totalMs?: number;
  memoryMb?: number;
}

export interface TestResult {
  pass: boolean;
  /** Serialized output (with markers for undefined / non-finite values), or null on error. */
  output: string | null;
  error: string | null;
  ms: number;
}

export interface RunResult {
  passed: number;
  total: number;
  compileError: string | null;
  results: TestResult[];
  /** Wall time of the whole run, ms. */
  wallMs: number;
}

/**
 * Pulls the code out of an LLM answer: the first fenced block if there is one, otherwise the
 * whole text. Strips `export` keywords so `export function f` and `export default function f`
 * still define `f`.
 */
export function normalizeCode(answer: string): string {
  const fence = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(answer);
  const code = fence ? fence[1] : answer;
  return code.replace(/^\s*export\s+default\s+/gm, "").replace(/^\s*export\s+/gm, "");
}

/** Deep equality on parsed JSON values; numbers compare with an absolute tolerance. */
export function sameValue(got: unknown, expected: unknown, tol = 1e-9): boolean {
  if (typeof got === "number" && typeof expected === "number") return Math.abs(got - expected) <= tol;
  if (Array.isArray(got) || Array.isArray(expected)) {
    if (!Array.isArray(got) || !Array.isArray(expected) || got.length !== expected.length) return false;
    return got.every((g, i) => sameValue(g, expected[i], tol));
  }
  if (got && expected && typeof got === "object" && typeof expected === "object") {
    const gk = Object.keys(got).sort();
    const ek = Object.keys(expected).sort();
    if (gk.length !== ek.length || gk.some((k, i) => k !== ek[i])) return false;
    return gk.every((k) => sameValue((got as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], tol));
  }
  return got === expected;
}

export interface RawRun {
  compileError: string | null;
  /** Per input: the serialized output, or null with an error. Empty when the run crashed. */
  results: Array<{ output: string | null; error: string | null; ms: number }>;
  wallMs: number;
}

/** What Node itself needs in the child besides the answer's heap (code, stacks, buffers). */
const RUNTIME_OVERHEAD_MB = 96;

/** Runs `fn` from `code` on each input in the isolated child process; returns raw outputs. */
export async function runRaw(code: string, fn: string, inputs: unknown[][], opts: SandboxOptions = {}): Promise<RawRun> {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fn)) throw new Error(`bad function name ${fn}`);
  const perTestMs = opts.perTestMs ?? 2000;
  const totalMs = opts.totalMs ?? perTestMs * inputs.length + 3000;
  const memoryMb = opts.memoryMb ?? 128;
  const started = performance.now();

  const child = spawn(
    process.execPath,
    ["--permission", `--allow-fs-read=${RUNNER}`, `--max-old-space-size=${memoryMb}`, RUNNER],
    { stdio: ["pipe", "pipe", "pipe"], env: {} },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), totalMs);
  // The heap flag does not cover ArrayBuffer memory, so watch the child's resident memory too
  // and kill it past the cap plus Node's own footprint (Linux /proc; elsewhere the heap cap only).
  const rssCapKb = (memoryMb + RUNTIME_OVERHEAD_MB) * 1024;
  const watch = setInterval(() => {
    try {
      const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${child.pid}/status`, "utf8"));
      if (m && Number(m[1]) > rssCapKb) child.kill("SIGKILL");
    } catch {
      // The child has exited, or this is not Linux.
    }
  }, 50);
  child.stdin.end(JSON.stringify({ code, fn, inputs, perTestMs }));
  const exitCode: number | null = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  clearInterval(watch);
  const wallMs = performance.now() - started;

  try {
    const parsed = JSON.parse(stdout) as { compileError: string | null; results: RawRun["results"] };
    return { compileError: parsed.compileError, results: parsed.results, wallMs };
  } catch {
    const reason = exitCode === null ? "killed: time or memory limit" : `runner crashed (exit ${exitCode}): ${stderr.slice(0, 200)}`;
    return { compileError: reason, results: [], wallMs };
  }
}

/** Runs `fn` from `code` against `tests` in an isolated child process and scores it. */
export async function runTests(code: string, fn: string, tests: TestCase[], opts: SandboxOptions = {}): Promise<RunResult> {
  const parsed = await runRaw(code, fn, tests.map((t) => t.args), opts);
  const wallMs = parsed.wallMs;
  if (parsed.results.length === 0 && parsed.compileError) {
    return { passed: 0, total: tests.length, compileError: parsed.compileError, results: [], wallMs };
  }

  const results: TestResult[] = tests.map((t, i) => {
    const r = parsed.results[i];
    if (!r) return { pass: false, output: null, error: parsed.compileError ?? "not run", ms: 0 };
    let pass = false;
    if (r.error === null && r.output !== null) {
      try {
        pass = sameValue(JSON.parse(r.output), t.expected);
      } catch {
        pass = false;
      }
    }
    return { pass, output: r.output, error: r.error, ms: r.ms };
  });
  return {
    passed: results.filter((r) => r.pass).length,
    total: tests.length,
    compileError: parsed.compileError,
    results,
    wallMs,
  };
}
