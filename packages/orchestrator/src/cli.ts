import { generateKeyPair, listTaskIds } from "@benchmarket/shared";
import { createServer, normalizeCode, recheck, rpcChain, runTests, signScores, Verifier, type PublishedReport } from "@benchmarket/verifier";
import { DOMAINS } from "@benchmarket/shared";
import { loadTask } from "@benchmarket/shared";
import fs from "node:fs";
import { llmSolve } from "./llm.js";
import { agentAccount, ROSTER, type AgentConfig } from "./roster.js";
import { LeagueChain } from "./chain.js";
import { config, DATA_DIR } from "./config.js";
import { llmSolver, runRound, simSolver, type RoundOptions } from "./round.js";
import { allScoutIds, llmScout, modelScouts, SCRIPTED_SCOUTS, scoutableModels, syncModelScouts } from "./scouts.js";
import { scoutChat } from "./llm.js";
import { chat } from "./nearai.js";
import { configure, setup, upgrade } from "./setup.js";
import { runJob } from "./job.js";
import { runBrief } from "./brief.js";
import { formatNear, near } from "./config.js";
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

/** `--llm`: real models on NEAR AI Cloud for agents, and a scout per model next to the scripted ones. */
function mode(): Pick<RoundOptions, "solver" | "scouts"> {
  if (!process.argv.includes("--llm")) return {};
  if (!config.nearAiApiKey) throw new Error("--llm needs NEAR_AI_API_KEY in .env");
  return { solver: llmSolver, scouts: [...SCRIPTED_SCOUTS, ...modelScouts().map((m) => llmScout(scoutChat, m.model, m.id))] };
}

/**
 * Agents for the n-th round: a window of `--field` agents (default 8) that moves by five each
 * round, so with 13 agents every one plays most rounds and no two rounds field the same set.
 */
function fieldFor(n: number): AgentConfig[] {
  const size = Math.min(ROSTER.length, Number(arg("field", "8")));
  return Array.from({ length: size }, (_, k) => ROSTER[(n * 5 + k) % ROSTER.length]);
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
/** Every league-run account with a position in the round claims it. */
async function claimAll(chain: LeagueChain, id: number): Promise<void> {
  const league = config.leagueAccount;
  const holders = [league, ...ROSTER.map((a) => agentAccount(a, league)), ...allScoutIds().map((s) => `${s}.${league}`)];
  for (const h of holders) {
    if ((await chain.getPosition(id, h)).length === 0) continue;
    try {
      const got = String(await chain.claim(h, id));
      if (BigInt(got) > 0n) console.log(`  ${h} claimed ${formatNear(got)} NEAR`);
    } catch (e) {
      console.log(`  ${h}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

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
      await withVerifier((verifier) => runRound({ chain, verifier, taskId, agents: fieldFor(Number(arg("rotation", String(Math.floor(Date.now() / 1000))))), taskRef: arg("ref"), openSeconds: Number(arg("open-seconds", "0")), lie: process.argv.includes("--lie"), ...mode(), marketSeconds: Number(arg("market-seconds", "20")) }));
      await leaderboard(chain);
      break;
    }
    case "demo": {
      const n = Number(arg("rounds", "4"));
      const tasks = listTaskIds();
      await withVerifier(async (verifier) => {
        for (let i = 0; i < n; i++) {
          const k = i + Number(arg("offset", "0"));
          await runRound({ chain, verifier, taskId: tasks[k % tasks.length], agents: fieldFor(k), ...mode(), marketSeconds: Number(arg("market-seconds", "20")) });
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
    case "quote": {
      // What a payout would arrive as through NEAR Intents (1Click dry quotes, nothing moves).
      const { payoutQuote, PAYOUT_ASSETS } = await import("@benchmarket/shared");
      const amount = near(arg("amount", "0.1")!);
      for (const a of arg("to") ? PAYOUT_ASSETS.filter((x) => x.id === arg("to")) : PAYOUT_ASSETS) {
        const q = await payoutQuote(amount, a.id, arg("recipient"));
        console.log(`${q.amountIn} NEAR -> ${q.amountOut} ${a.label} (about $${Number(q.amountOutUsd).toFixed(2)}, ~${q.timeEstimateSec}s)`);
      }
      break;
    }
    case "subcontract": {
      // An agent takes a job and hires another agent by rating for a first draft.
      const solver = process.argv.includes("--llm") ? llmSolver : simSolver;
      const { runSubcontract } = await import("./subcontract.js");
      await withVerifier((verifier) =>
        runSubcontract({
          chain,
          verifier,
          taskId: arg("task", "utf8-decode")!,
          solver,
          minRating: Number(arg("min-rating", "1540")),
          subMinRating: Number(arg("sub-min-rating", "1520")),
          budget: near(arg("budget", "0.1")!),
          subBudget: near(arg("sub-budget", "0.06")!),
        }),
      );
      break;
    }
    case "brief": {
      const taskId = arg("task", "parse-csv")!;
      const m = mode();
      await withVerifier((verifier) =>
        runBrief({
          chain,
          verifier,
          taskId,
          summary: arg("summary", "I need a function that parses the CSV exports of my shop, quoted fields and all.")!,
          category: arg("category"),
          confidential: process.argv.includes("--confidential"),
          solver: m.solver ?? simSolver,
          scouts: m.scouts,
          budget: near(arg("budget", "0.2")!),
          scoutReward: near(arg("reward", "0.05")!),
        }),
      );
      await leaderboard(chain);
      break;
    }
    case "code-hash": {
      // NEAR reports a contract's code hash as base58(sha256(wasm)): compare with the local build.
      const { createHash } = await import("node:crypto");
      const { base58 } = await import("@scure/base");
      const wasm = path.join(DATA_DIR, "..", "contract/target/near/benchmarket.wasm");
      const local = base58.encode(createHash("sha256").update(fs.readFileSync(wasm)).digest());
      const acct = (await chain.provider.viewAccount({ accountId: config.leagueAccount, blockQuery: { finality: "final" } })) as { code_hash?: string; codeHash?: string };
      const onChain = acct.code_hash ?? acct.codeHash;
      console.log(`local build  ${local}\non chain     ${onChain}\n${local === onChain ? "the deployed code is this build" : "different code is deployed (build the commit that was deployed to compare)"}`);
      break;
    }
    case "watch":
      await watch(chain, Number(arg("round")), process.argv.includes("--dispute"));
      break;
    case "cancel": {
      // The manager cancels an unsettled round; every purchase, bond, subsidy and bounty goes back.
      const id = Number(arg("round"));
      if ((await chain.getRound(id))?.status !== "Cancelled") await chain.cancelRound(config.leagueAccount, id);
      console.log(`round ${id} cancelled`);
      await claimAll(chain, id);
      break;
    }
    case "finalize": {
      // Closes a round whose dispute window passed without a dispute, then pays every position.
      const id = Number(arg("round"));
      const before = (await chain.getRound(id))!;
      // The re-check and the outcome go into the round's record, stamped with the real time.
      const logPath = path.join(DATA_DIR, "rounds", `${id}.json`);
      const log = fs.existsSync(logPath) ? (JSON.parse(fs.readFileSync(logPath, "utf8")) as { events: Array<{ at: number; kind: string; data: Record<string, unknown> }> }) : null;
      if (before.proposal) {
        const check = await recheck(await published(id), before);
        log?.events.push({ at: Date.now(), kind: "watcher_check", data: { ok: check.ok, problems: check.problems } });
        if (!check.ok) throw new Error(`posted scores do not match a re-run: ${check.problems.join("; ")}`);
      }
      if (before.status === "Proposed") await chain.finalize(config.leagueAccount, id);
      const r = (await chain.getRound(id))!;
      log?.events.push({ at: Date.now(), kind: "round_settled", data: { winners: r.winners, scores: r.proposal?.scores ?? [], finalized_late: true } });
      if (log) fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
      console.log(`round ${id} ${r.status}, winners: ${r.winners.join(", ") || "none"} (${r.payout_mode})`);
      await claimAll(chain, id);
      break;
    }
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
    case "nominal":
      // Outside roles on accounts of their own: verifier operators, arbiters, an agent, a scout.
      await (await import("./nominal.js")).setupNominal(chain);
      break;
    case "bootstrap": {
      // Creates a fresh top-level testnet account for the league, funded from an existing one.
      const from = arg("from")!;
      const to = arg("to", "benchmarket.testnet")!;
      const amount = near(arg("amount", "17")!);
      if (!from) throw new Error("bootstrap needs --from <funded account>");
      const exists = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: to } }),
      }).then((r) => r.json() as Promise<{ result?: unknown }>).then((r) => !!r.result);
      if (exists && chain.keys.has(to)) {
        console.log(`${to} exists and its key is here; skipping account creation`);
        break;
      }
      if (exists) throw new Error(`${to} already exists and its key is not here: pick another name (scripts/relaunch.sh <funded> <new-name>)`);
      const kp = generateKeyPair();
      chain.keys.save(to, kp.publicKey, kp.secretKey);
      await chain.account(from).callFunction({ contractId: config.network === "mainnet" ? "near" : "testnet", methodName: "create_account", args: { new_account_id: to, new_public_key: kp.publicKey }, deposit: amount, gas: 100_000_000_000_000n });
      console.log(`created ${to} with ${arg("amount", "17")} NEAR from ${from}; set LEAGUE_ACCOUNT=${to} in .env and run npm run setup`);
      break;
    }
    case "scouts-sync": {
      // A scout for every new chat model in the NEAR AI catalog, up to --max, cheapest first.
      const res = await fetch(`${config.nearAiBaseUrl}/models`, { headers: { Authorization: `Bearer ${config.nearAiApiKey}` } });
      const list = ((await res.json()) as { data: Array<{ id: string; pricing?: { output?: number } }> }).data;
      // The catalog does not say which models answer plain chat; a one-line probe does.
      const answers: string[] = [];
      const known = new Set(modelScouts().map((m) => m.model));
      for (const model of scoutableModels(list, Number(arg("max-price", "2")))) {
        if (known.has(model)) {
          answers.push(model);
          continue;
        }
        if (answers.length >= Number(arg("max", "8"))) break;
        try {
          await chat(model, [{ role: "user", content: "Reply with OK." }], { maxTokens: 400, timeoutMs: 60_000 });
          answers.push(model);
        } catch (e) {
          console.log(`skip ${model}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
        }
      }
      const added = syncModelScouts(answers, Number(arg("max", "8")));
      console.log(added.length ? added.map((a) => `new scout ${a.id} on ${a.model}`).join("\n") : "no new models to scout with");
      if (added.length) await setup();
      break;
    }
    case "status":
      await leaderboard(chain);
      break;
    default:
      console.log("usage: league <setup|upgrade|configure|identities|round|demo|job|brief|watch|arbitrate|cancel|finalize|code-hash|status|bench> [--task id] [--rounds n] [--offset k] [--market-seconds s] [--llm] [--round n] [--dispute]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
