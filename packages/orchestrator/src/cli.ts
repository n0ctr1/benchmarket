import { listTaskIds } from "@agent-league/shared";
import { createServer, normalizeCode, runTests, Verifier } from "@agent-league/verifier";
import { loadTask } from "@agent-league/shared";
import fs from "node:fs";
import { llmSolve } from "./llm.js";
import { ROSTER } from "./roster.js";
import { LeagueChain } from "./chain.js";
import { config, DATA_DIR } from "./config.js";
import { llmSolver, runRound, type RoundOptions } from "./round.js";
import { llmScout, SCRIPTED_SCOUTS } from "./scouts.js";
import { scoutChat } from "./llm.js";
import { setup, upgrade } from "./setup.js";
import { issueIdentity } from "./identity.js";
import path from "node:path";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function withVerifier<T>(fn: (v: Verifier) => Promise<T>): Promise<T> {
  const verifier = new Verifier(config.verifierSecretKeys, path.join(DATA_DIR, "verifier"));
  const port = Number(process.env.VERIFIER_PORT ?? 8787);
  const server = createServer(verifier).listen(port);
  try {
    return await fn(verifier);
  } finally {
    server.close();
  }
}

/** `--llm`: real models on NEAR AI Cloud for agents, plus an LLM scout next to the scripted ones. */
function mode(): Pick<RoundOptions, "solver" | "scouts"> {
  if (!process.argv.includes("--llm")) return {};
  if (!config.nearAiApiKey) throw new Error("--llm needs NEAR_AI_API_KEY in .env");
  return { solver: llmSolver, scouts: [...SCRIPTED_SCOUTS, llmScout(scoutChat)] };
}

async function leaderboard(chain: LeagueChain): Promise<void> {
  const rows = await chain.getLeaderboard("code.js");
  console.log("\nleaderboard code.js");
  for (const r of rows) {
    console.log(`  ${r.agent.split(".")[0].padEnd(8)} ${(r.rating / 100).toFixed(1).padStart(7)}  rounds ${r.rounds}  wins ${r.wins}${r.provisional ? "  (provisional)" : ""}`);
  }
  const scouts = await chain.getScouts();
  console.log("\nbettors by PnL (scouts, builders, seeder)");
  for (const s of scouts) {
    console.log(`  ${s.account.split(".")[0].padEnd(12)} pnl ${(Number(BigInt(s.pnl)) / 1e24).toFixed(3)} NEAR  bets ${s.bets}  wins ${s.wins}`);
  }
}

/** Offline: every agent's real model on every task, scored by the sandbox. No chain, no NEAR. */
async function bench(taskIds: string[]): Promise<void> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const taskId of taskIds) {
    const task = loadTask(taskId);
    console.log(`\n${taskId} (${task.tests.length} hidden tests)`);
    const only = arg("agents")?.split(",");
    await Promise.all(
      ROSTER.filter((a) => !only || only.includes(a.id)).map(async (a) => {
        try {
          const { answer, meta } = await llmSolve(a, taskId);
          const r = await runTests(normalizeCode(answer), task.function, task.tests);
          console.log(`  ${a.name.padEnd(7)} ${String(r.passed).padStart(2)}/${r.total}  ${a.model}${r.compileError ? "  compile error" : ""}${meta.signature ? "  signed" : ""}`);
          (out[taskId] ??= {})[a.id] = { passed: r.passed, total: r.total, model: a.model, signed: !!meta.signature };
        } catch (e) {
          console.log(`  ${a.name.padEnd(7)} failed: ${e instanceof Error ? e.message : e}`);
          (out[taskId] ??= {})[a.id] = { error: String(e) };
        }
      }),
    );
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "bench.json");
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  for (const [t, rows] of Object.entries(out)) prev[t] = { ...(prev[t] ?? {}), ...rows };
  fs.writeFileSync(file, JSON.stringify(prev, null, 2));
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const chain = new LeagueChain();
  switch (cmd) {
    case "setup":
      await setup({ agentBalance: arg("agent-balance"), scoutBalance: arg("scout-balance") });
      break;
    case "round": {
      const taskId = arg("task", "parse-duration")!;
      await withVerifier((verifier) => runRound({ chain, verifier, taskId, ...mode(), marketSeconds: Number(arg("market-seconds", "20")) }));
      await leaderboard(chain);
      break;
    }
    case "demo": {
      const n = Number(arg("rounds", "4"));
      const tasks = listTaskIds();
      await withVerifier(async (verifier) => {
        for (let i = 0; i < n; i++) {
          await runRound({ chain, verifier, taskId: tasks[(i + Number(arg("offset", "0"))) % tasks.length], ...mode(), marketSeconds: Number(arg("market-seconds", "20")) });
          console.log("");
        }
      });
      await leaderboard(chain);
      break;
    }
    case "upgrade":
      await upgrade();
      break;
    case "identities": {
      // One agent at a time: each face is checked against the passports issued before it.
      const only = arg("agents")?.split(",");
      for (const a of ROSTER.filter((x) => !only || only.includes(x.id))) await issueIdentity(chain, a);
      break;
    }
    case "bench":
      await bench(arg("task") ? [arg("task")!] : listTaskIds());
      break;
    case "status":
      await leaderboard(chain);
      break;
    default:
      console.log("usage: league <setup|upgrade|identities|round|demo|status|bench> [--task id] [--rounds n] [--offset k] [--market-seconds s] [--llm]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
