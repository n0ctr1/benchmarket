import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = path.join(ROOT, ".data");

/**
 * Off-chain round data the contract does not store: scout reasoning, answer code, per-test
 * results and completion signatures. Served at /data/* in dev and written into the build.
 */
function offChain(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const roster = loadRoster();
  out["roster.json"] = roster;
  const logsDir = path.join(DATA, "rounds");
  const ids = fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir).filter((f) => f.endsWith(".json")).map((f) => Number(f.slice(0, -5))).sort((a, b) => a - b)
    : [];
  const statePath = path.join(DATA, "verifier", "verifier-state.json");
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { answers: [], reports: [] };
  // Version 1 of the state keyed rounds by number, version 2 by "round:<id>" (jobs: "job:<id>").
  const roundKey = (k: number | string) => (typeof k === "number" ? k : k.startsWith("round:") ? Number(k.slice(6)) : null);
  const answers = new Map<number, Array<Record<string, any>>>(state.answers.map(([k, v]: [any, any]) => [roundKey(k), v]).filter(([k]: [any]) => k !== null));
  const reports = new Map<number, Record<string, any>>(state.reports.map(([k, v]: [any, any]) => [roundKey(k), v]).filter(([k]: [any]) => k !== null));
  // Everything a browser needs to re-check a round: signed report, answers, tests, seed. The same
  // as the verifier's GET /rounds/:id/report.
  const bound = new Map<number, Record<string, any>>((state.bound ?? []).map(([k, v]: [any, any]) => [roundKey(k), v]).filter(([k]: [any]) => k !== null));
  const sha = (t: string) => "sha256:" + createHash("sha256").update(t, "utf8").digest("hex");
  for (const [id, report] of reports) {
    const dir = path.join(ROOT, "tasks", report.taskId);
    if (!fs.existsSync(dir)) continue;
    const fn = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")).function;
    const fresh = bound.get(id);
    const pub: Record<string, unknown> = { report, answers: answers.get(id) ?? [], function: fn, rawTests: fresh ? fresh.raw : fs.readFileSync(path.join(dir, "tests.json"), "utf8") };
    if (fresh && fs.existsSync(path.join(dir, "generator.js"))) {
      const generator = fs.readFileSync(path.join(ROOT, "tasks", "_rng.js"), "utf8") + "\n" + fs.readFileSync(path.join(dir, "generator.js"), "utf8");
      const reference = fs.readFileSync(path.join(dir, "reference.js"), "utf8");
      pub.family = { seed: fresh.seed, count: 24, generator, reference, familyHash: "family:" + sha(generator + "\n" + reference) };
    }
    out[`reports/${id}.json`] = pub;
  }
  for (const id of ids) {
    const log = JSON.parse(fs.readFileSync(path.join(logsDir, `${id}.json`), "utf8"));
    const report = reports.get(id);
    // Answers are published only after the round is scored, like the verifier API does.
    const agents = report
      ? Object.fromEntries(
          (answers.get(id) ?? []).map((a) => {
            const d = report.details?.find((x: any) => x.agent === a.agent);
            return [
              a.agent,
              {
                code: a.answer,
                meta: a.meta ?? null,
                receivedAt: a.receivedAt,
                passed: d?.run?.passed ?? 0,
                total: d?.run?.total ?? report.totalTests,
                compileError: d?.run?.compileError ?? null,
                tests: (d?.run?.results ?? []).map((r: any) => (r.pass ? 1 : 0)),
              },
            ];
          }),
        )
      : {};
    out[`rounds/${id}.json`] = { ...log, report: report ? { message: report.message, signatures: report.signatures, totalTests: report.totalTests } : null, agents };
  }
  out["index.json"] = { rounds: ids };
  // How each agent chose its face: attempts, rejections, reasoning.
  const idDir = path.join(DATA, "identities");
  out["identities.json"] = fs.existsSync(idDir)
    ? Object.fromEntries(
        fs.readdirSync(idDir).filter((f) => f.endsWith(".json")).map((f) => {
          const r = JSON.parse(fs.readFileSync(path.join(idDir, f), "utf8"));
          return [
            r.agent,
            {
              model: r.model,
              zeroPromptHash: r.zeroPromptHash,
              attempts: (r.attempts ?? []).map((a: any) => ({
                face: a.face ?? null,
                seed: a.choice?.seed ?? null,
                motto: a.choice?.motto ?? null,
                rejected: a.rejected ?? null,
                signatureKind: a.signature?.signature_kind ?? null,
              })),
            },
          ];
        }),
      )
    : {};
  return out;
}

function loadRoster(): unknown {
  // The roster is TypeScript; read the fields we need without executing it.
  const src = fs.readFileSync(path.join(ROOT, "packages/orchestrator/src/roster.ts"), "utf8");
  const base = /const BASE_PROMPT = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
  const blocks = src.split(/\n  \{\n/).slice(1);
  return blocks.map((b) => {
    const get = (k: string) => new RegExp(`${k}: "([^"]*)"`).exec(b)?.[1] ?? "";
    const extra = /systemPrompt:\s*(?:BASE_PROMPT\s*\+\s*)?([\s\S]*?),\n    tools/.exec(b)?.[1] ?? "";
    const extraText = [...extra.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
    const strengths = [...(/strengths: \[([^\]]*)\]/.exec(b)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return { id: get("id"), name: get("name"), model: get("model"), systemPrompt: base + extraText, strengths };
  });
}

function dataPlugin(): Plugin {
  return {
    name: "benchmarket-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/data/")) return next();
        const key = req.url.slice("/data/".length).split("?")[0];
        const data = offChain()[key];
        if (data === undefined) {
          res.statusCode = 404;
          return res.end("not found");
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      });
    },
    generateBundle() {
      for (const [key, data] of Object.entries(offChain())) {
        this.emitFile({ type: "asset", fileName: `data/${key}`, source: JSON.stringify(data) });
      }
    },
  };
}

// The site reads the same .env as the orchestrator (contract account, RPC, network).
const ENV = { ...loadEnv("production", ROOT, ""), ...process.env };

export default defineConfig({
  plugins: [react(), dataPlugin()],
  define: {
    __LEAGUE__: JSON.stringify(ENV.LEAGUE_ACCOUNT ?? "benchmarket.testnet"),
    __RPC__: JSON.stringify(ENV.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com"),
    __NETWORK__: JSON.stringify(ENV.NEAR_NETWORK ?? "testnet"),
    __VERIFIER__: JSON.stringify(ENV.PUBLIC_VERIFIER_URL ?? "http://localhost:8787"),
  },
  server: { port: 5180 },
});
