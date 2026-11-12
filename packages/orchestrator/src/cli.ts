import { listTaskIds } from "@agent-league/shared";
import { createServer, normalizeCode, recheck, rpcChain, runTests, signScores, Verifier, type PublishedReport } from "@agent-league/verifier";
import { DOMAINS } from "@agent-league/shared";
import { loadTask } from "@agent-league/shared";
import fs from "node:fs";
import { llmSolve } from "./llm.js";
import { ROSTER } from "./roster.js";
import { LeagueChain } from "./chain.js";
import { config, DATA_DIR } from "./config.js";
import { llmSolver, runRound, simSolver, type RoundOptions } from "./round.js";
import { llmScout, SCRIPTED_SCOUTS } from "./scouts.js";
import { scoutChat } from "./llm.js";
import { configure, setup, upgrade } from "./setup.js";
import { runJob } from "./job.js";
import { near } from "./config.js";
import { issueIdentity } from "./identity.js";
import path from "node:path";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function withVerifier<T>(fn: (v: Verifier) => Promise<T>): Promise<T> {
  const verifier = new Verifier(config.verifierSecretKeys, path.join(DATA_DIR, "verifier"));
  const port = Number(process.env.VERIFIER_PORT ?? 8787);
  const server = createServer(verifier, rpcChain(config.rpcUrl, config.leagueAccount)).listen(port);
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
    const jobs = r.jobs_done + r.jobs_failed ? `  jobs ${r.jobs_done}/${r.jobs_done + r.jobs_failed}` : "";
    console.log(`  ${r.agent.split(".")[0].padEnd(8)} ${(r.rating / 100).toFixed(1).padStart(7)}  rounds ${r.rounds}  wins ${r.wins}  attested ${r.attested}${jobs}${r.provisional ? "  (provisional)" : ""}`);
  }
  const tasks = await chain.getTasks();
  if (tasks.length) {
    console.log("\ntasks by difficulty");
    for (const t of [...tasks].sort((a, b) => b.rating - a.rating)) {
      console.log(`  ${t.task_ref.padEnd(18)} ${(t.rating / 100).toFixed(1).padStart(7)}  rounds ${t.rounds}  jobs ${t.jobs}${t.curated ? "" : "  uncurated"}${t.retired ? "  retired" : ""}`);
    }
  }
  const scouts = await chain.getScouts();
  console.log("\nscouts by forecasting skill (LMSR profit per unit of liquidity)");
  for (const s of scouts) {
    console.log(`  ${s.account.split(".")[0].padEnd(12)} skill ${(s.skill_ppm / 1e6).toFixed(3).padStart(7)} over ${s.scored_rounds} rounds  pnl ${(Number(BigInt(s.pnl)) / 1e24).toFixed(3)} NEAR`);
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

/** The verifier's published report: from its HTTP API, or from the local verifier state. */
async function published(roundId: number): Promise<PublishedReport> {
  try {
    const res = await fetch(`${config.verifierUrl}/rounds/${roundId}/report`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) return (await res.json()) as PublishedReport;
  } catch {
    // fall back to local state
  }
  const local = new Verifier(config.verifierSecretKeys, path.join(DATA_DIR, "verifier")).published(roundId);
  if (!local) throw new Error(`no published report for round ${roundId}`);
  return local;
}

/** Re-runs a round's published answers on its published tests; disputes on a mismatch if asked. */
async function watch(chain: LeagueChain, roundId: number, dispute: boolean): Promise<void> {
  if (!roundId) throw new Error("--round <id> is required");
  const round = await chain.getRound(roundId);
  if (!round) throw new Error(`no round ${roundId}`);
  const check = await recheck(await published(roundId), round);
  console.log(`round ${roundId} (${round.status}): ${check.ok ? "posted scores match an independent re-run" : "MISMATCH"}`);
  for (const p of check.problems) console.log(`  ${p}`);
  if (!check.ok && dispute) {
    if (round.status !== "Proposed") throw new Error(`round is ${round.status}; disputes are only possible while Proposed`);
    const bond = BigInt((await chain.getConfig()).params.dispute_bond);
    await chain.dispute(config.leagueAccount, roundId, bond);
    console.log(`disputed with a ${(Number(bond) / 1e24).toFixed(2)} NEAR bond; arbiters now re-run and rule`);
  }
}

/** Arbiter: re-runs the round independently and rules on the dispute with its own signature. */
async function arbitrate(chain: LeagueChain, roundId: number): Promise<void> {
  if (!roundId) throw new Error("--round <id> is required");
  const keys = config.arbiterSecretKeys;
  if (keys.length === 0) throw new Error("set ARBITER_SECRET_KEYS");
  const round = await chain.getRound(roundId);
  if (round?.status !== "Disputed") throw new Error(`round ${roundId} is not disputed`);
  const check = await recheck(await published(roundId), round);
  const { signatures } = signScores(keys, DOMAINS.roundArbiter, roundId, check.totalTests, check.scores);
  await chain.resolveDispute(config.leagueAccount, roundId, check.totalTests, check.scores, signatures);
  const after = (await chain.getRound(roundId))!;
  console.log(`ruled: scores ${after.dispute?.overturned ? "overturned, verifier stake slashed" : "upheld, bond forfeited"}; winners ${after.winners.join(", ") || "none"}`);
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
      await withVerifier((verifier) => runRound({ chain, verifier, taskId, taskRef: arg("ref"), openSeconds: Number(arg("open-seconds", "0")), lie: process.argv.includes("--lie"), ...mode(), marketSeconds: Number(arg("market-seconds", "20")) }));
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
    case "configure":
      await configure(chain);
      break;
    case "job": {
      const taskId = arg("task", "parse-duration")!;
      const solver = process.argv.includes("--llm") ? llmSolver : simSolver;
      await withVerifier((verifier) => runJob({ chain, verifier, taskId, taskRef: arg("ref"), solver, minRating: Number(arg("min-rating", "1490")), budget: near(arg("budget", "0.3")!) }));
      await leaderboard(chain);
      break;
    }
    case "watch":
      await watch(chain, Number(arg("round")), process.argv.includes("--dispute"));
      break;
    case "arbitrate":
      await arbitrate(chain, Number(arg("round")));
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
      console.log("usage: league <setup|upgrade|configure|identities|round|demo|job|watch|arbitrate|status|bench> [--task id] [--rounds n] [--offset k] [--market-seconds s] [--llm] [--round n] [--dispute]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
