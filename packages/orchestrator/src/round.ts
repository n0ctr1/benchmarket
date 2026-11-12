import fs from "node:fs";
import path from "node:path";
import { loadTask, publicView } from "@agent-league/shared";
import type { Verifier } from "@agent-league/verifier";
import type { LeagueChain, RoundView } from "./chain.js";
import { config, DATA_DIR, formatNear } from "./config.js";
import { agentAccount, configHash, ROSTER, type AgentConfig } from "./roster.js";
import { SCRIPTED_SCOUTS, type Scout } from "./scouts.js";
import { simAnswer } from "./sim.js";
import { llmSolve } from "./llm.js";

export type Solver = (agent: AgentConfig, taskId: string, roundSalt: string) => Promise<{ answer: string; meta?: Record<string, unknown> }>;

export const simSolver: Solver = async (agent, taskId, salt) => ({
  answer: simAnswer(agent, loadTask(taskId), salt),
  meta: { mode: "sim" },
});

/** Calls each agent's model on NEAR AI Cloud. */
export const llmSolver: Solver = async (agent, taskId) => llmSolve(agent, taskId);

export interface RoundOptions {
  chain: LeagueChain;
  verifier: Verifier;
  taskId: string;
  solver?: Solver;
  scouts?: Scout[];
  agents?: AgentConfig[];
  /** Seconds the market stays open before the manager locks it. */
  marketSeconds?: number;
  log?: (line: string) => void;
}

export interface RoundLog {
  roundId: number;
  taskId: string;
  events: Array<{ at: number; kind: string; data: Record<string, unknown> }>;
}

function saveLog(log: RoundLog): void {
  const dir = path.join(DATA_DIR, "rounds");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${log.roundId}.json`), JSON.stringify(log, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs one full round on chain: create, register, seed, bets, lock, answers, settle, claims. */
export async function runRound(opts: RoundOptions): Promise<RoundView> {
  const { chain, verifier, taskId } = opts;
  const solver = opts.solver ?? simSolver;
  const scouts = opts.scouts ?? SCRIPTED_SCOUTS;
  const agents = opts.agents ?? ROSTER;
  const say = opts.log ?? ((l: string) => console.log(l));
  const league = config.leagueAccount;
  const task = loadTask(taskId);
  const marketSeconds = opts.marketSeconds ?? 120;

  // Every agent needs a passport before it can enter (npm run identities).
  for (const a of agents) {
    if (!(await chain.getIdentity(agentAccount(a, league)))) throw new Error(`${a.name} has no passport yet: run npm run identities`);
  }

  // 1. Create.
  const roundId = Number(
    await chain.createRound(league, {
      skill: task.skill,
      taskRef: task.id,
      testsHash: task.testsHash,
      betDeadlineMs: Date.now() + marketSeconds * 1000 + 60_000,
      maxAgents: agents.length,
      bounty: config.bounty,
    }),
  );
  const log: RoundLog = { roundId, taskId, events: [] };
  const note = (kind: string, data: Record<string, unknown>) => {
    log.events.push({ at: Date.now(), kind, data });
    saveLog(log);
  };
  say(`round ${roundId}: ${task.title} (${task.id}), bounty ${formatNear(config.bounty)} NEAR`);
  note("round_created", { task: publicView(task) });

  // 2. Agents register themselves and stake on themselves. The league tops up agents and scouts
  // that ran low, so a demo can run many rounds from one faucet account.
  const reserve = 0.05;
  for (const id of [...agents.map((a) => agentAccount(a, league)), ...scouts.map((s) => `${s.id}.${league}`)]) {
    const need = id.startsWith("scout") ? config.scoutBet : config.builderStake;
    const sent = await chain.topUp(league, id, need + BigInt(Math.round(reserve * 1e6)) * 10n ** 18n);
    if (sent > 0n) say(`  topped up ${id.split(".")[0]} with ${formatNear(sent)} NEAR`);
  }
  for (const a of agents) {
    const acc = agentAccount(a, league);
    await chain.registerAgent(acc, roundId, acc, "Open", configHash(a), config.builderStake);
    say(`  ${a.name.padEnd(7)} registered (${a.model}), stakes ${formatNear(config.builderStake)} NEAR on itself`);
  }

  // 3. Seed liquidity.
  await chain.seed(league, roundId, config.seed);
  say(`  seeder added ${formatNear(config.seed)} NEAR split equally`);

  // 4. Scouts bet one by one, each seeing the odds the previous bets produced.
  for (const scout of scouts) {
    const round = (await chain.getRound(roundId))!;
    const field = await Promise.all(
      round.entries.map(async (e) => {
        const cfg = agents.find((a) => agentAccount(a, league) === e.agent)!;
        const r = await chain.getRating(e.agent, task.skill);
        return { agent: e.agent, config: cfg, rating: r.rating, rounds: r.rounds, odds: e.odds_ppm / 1e6 };
      }),
    );
    const d = await scout.decide(publicView(task), field);
    const account = `${scout.id}.${league}`;
    await chain.placeBet(account, roundId, d.agent, config.scoutBet);
    say(`  ${scout.id.padEnd(12)} backs ${d.agent.split(".")[0]}: ${d.reasoning}`);
    note("scout_bet", { scout: account, kind: scout.kind, agent: d.agent, reasoning: d.reasoning });
    await sleep(1500);
  }

  // 5. Lock: odds and expected scores are frozen.
  await chain.lockRound(league, roundId);
  const locked = (await chain.getRound(roundId))!;
  say(`  market locked, pool ${formatNear(locked.total_pool)} NEAR`);
  for (const e of locked.entries) {
    say(`    ${e.agent.split(".")[0].padEnd(7)} market ${(e.market_ppm / 1e4).toFixed(1)}%  expected ${(e.p_ppm / 1e4).toFixed(1)}%`);
  }

  // 6. Agents solve independently; the answer goes to the verifier, its hash on chain.
  const salt = `${roundId}:${task.testsHash}`;
  await Promise.all(
    agents.map(async (a) => {
      const acc = agentAccount(a, league);
      try {
        const { answer, meta } = await solver(a, task.id, salt);
        const stored = verifier.submit(roundId, acc, task.id, answer, meta);
        await chain.submitAnswer(acc, roundId, stored.answerHash);
        const kind = (meta?.signature as { signature_kind?: string } | null | undefined)?.signature_kind;
        const signed = kind === "provider_tee" ? ", TEE-signed completion" : kind ? `, ${kind}-signed completion` : "";
        const took = typeof meta?.latencyMs === "number" ? ` in ${(meta.latencyMs / 1000).toFixed(1)}s` : "";
        if (meta?.mode === "llm") say(`  ${a.name.padEnd(7)} answered${took}${signed}`);
        note("answer_submitted", { agent: acc, answer_hash: stored.answerHash, meta: meta ?? null });
      } catch (e) {
        say(`  ${a.name} failed to answer: ${e instanceof Error ? e.message : e}`);
        note("answer_failed", { agent: acc, error: String(e) });
      }
    }),
  );

  // 7. Verifier scores against the hidden tests and signs; the contract checks the signatures.
  const answered = (await chain.getRound(roundId))!;
  const onChain = Object.fromEntries(answered.entries.map((e) => [e.agent, e.answer_hash]));
  const report = await verifier.score(roundId, task.id, answered.entries.map((e) => e.agent), onChain);
  for (const [agent, score] of report.scores) say(`    ${agent.split(".")[0].padEnd(7)} ${score}/${report.totalTests}`);
  await chain.settle(league, roundId, report.totalTests, report.scores, report.signatures.slice(0, config.verifierThreshold));
  const settled = (await chain.getRound(roundId))!;
  note("round_settled", { winner: settled.winner, scores: report.scores, message: report.message });
  say(`  winner: ${settled.winner ?? "none"} (${settled.payout_mode})`);
  for (const e of settled.entries) {
    const sign = e.rating_delta >= 0 ? "+" : "";
    say(`    ${e.agent.split(".")[0].padEnd(7)} rating ${((e.rating_before + e.rating_delta) / 100).toFixed(1)} (${sign}${(e.rating_delta / 100).toFixed(1)})`);
  }

  // 8. Everybody with a position claims.
  const bettors = new Set<string>([league, ...agents.map((a) => agentAccount(a, league)), ...scouts.map((s) => `${s.id}.${league}`)]);
  for (const b of bettors) {
    const pos = await chain.getPosition(roundId, b);
    if (pos.length === 0) continue;
    const got = await chain.claim(b, roundId);
    if (BigInt(got ?? "0") > 0n) say(`  ${b.split(".")[0]} claimed ${formatNear(got)} NEAR`);
  }
  return settled;
}

