import { loadTask, publicView } from "@agent-league/shared";
import type { Verifier } from "@agent-league/verifier";
import type { BriefView, LeagueChain } from "./chain.js";
import { config, formatNear, near } from "./config.js";
import { workJob } from "./job.js";
import { agentAccount, ROSTER } from "./roster.js";
import { runRound, type Solver } from "./round.js";
import { SCRIPTED_SCOUTS, type Scout } from "./scouts.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (a: string) => a.split(".")[0];

export interface BriefOptions {
  chain: LeagueChain;
  verifier: Verifier;
  /** The client's own task (its hidden tests stay with the verifier). */
  taskId: string;
  summary: string;
  solver: Solver;
  scouts?: Scout[];
  budget: bigint;
  scoutReward: bigint;
  log?: (line: string) => void;
}

export const CLIENT_ID = "client";

/**
 * A client asks for an agent: post a brief with escrow, scouts nominate agents and tryout tasks
 * with a stake, a rated tryout round runs on the most-backed task, the client is offered the
 * best and hires it, and the scouts behind the hire are paid or slashed by how the job goes.
 */
export async function runBrief(opts: BriefOptions): Promise<BriefView> {
  const { chain, verifier, solver } = opts;
  const say = opts.log ?? ((l: string) => console.log(l));
  const scouts = opts.scouts ?? SCRIPTED_SCOUTS;
  const league = config.leagueAccount;
  const client = `${CLIENT_ID}.${league}`;
  const task = loadTask(opts.taskId);
  const bounty = config.bounty;
  const subsidy = config.subsidy;
  const nominateSeconds = 60;

  // The client and the scouts need funds for the escrow and the stakes.
  const escrow = opts.budget + opts.scoutReward + bounty + subsidy;
  const sent = await chain.topUp(league, client, escrow + near("0.05"));
  if (sent > 0n) say(`  topped up the client with ${formatNear(sent)} NEAR`);

  const briefId = Number(
    await chain.postBrief(client, {
      skill: task.skill,
      summary: opts.summary,
      taskRef: `${task.id}@brief`,
      testsHash: task.testsHash,
      budget: opts.budget,
      scoutReward: opts.scoutReward,
      tryoutBounty: bounty,
      tryoutSubsidy: subsidy,
      minStake: config.scoutStake,
      nominateWindowMs: nominateSeconds * 1000,
      tradeWindowMs: 20 * 60_000,
      workWindowMs: 20 * 60_000,
      passPpm: 900_000,
      attested: !!solver.attests,
    }),
  );
  say(`brief ${briefId}: "${opts.summary}"`);
  say(`  escrow: budget ${formatNear(opts.budget)}, scout reward ${formatNear(opts.scoutReward)}, tryout ${formatNear(bounty)} bounty + ${formatNear(subsidy)} market NEAR`);

  // Scouts see the brief, the curated tasks (not the client's own) and every agent with a passport.
  const curated = (await chain.getTasks()).filter((t) => t.curated && !t.retired && t.skill === task.skill && t.task_ref !== task.id);
  const tryoutTasks = curated.map((t) => {
    const p = publicView(loadTask(t.task_ref));
    return { id: t.task_ref, title: p.title, statement: p.statement, rating: t.rating };
  });
  const field = await Promise.all(
    ROSTER.map(async (a) => {
      const acc = agentAccount(a, league);
      const r = await chain.getRating(acc, task.skill);
      return { agent: acc, config: a, rating: r.rating, rounds: r.rounds, odds: 0 };
    }),
  );
  for (const scout of scouts) {
    if (!scout.nominate) continue;
    const account = `${scout.id}.${league}`;
    const picks = await scout.nominate({ summary: opts.summary, skill: task.skill }, field, tryoutTasks);
    await chain.topUp(league, account, config.scoutStake * BigInt(picks.length) + config.scoutBet + near("0.05"));
    for (const p of picks) {
      try {
        await chain.nominate(account, briefId, p.agent, p.task, config.scoutStake);
        say(`  ${scout.id.padEnd(12)} nominates ${short(p.agent)} on ${p.task}, stakes ${formatNear(config.scoutStake)}: ${p.reasoning}`);
        if (p.fallback) say(`    (${scout.id} fallback: ${p.fallback.reason})`);
      } catch (e) {
        say(`  ${scout.id} could not nominate ${short(p.agent)}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      }
    }
  }

  // Tryout.
  const b0 = (await chain.getBrief(briefId))!;
  const wait = b0.nominate_until_ms - Date.now() + 2000;
  if (wait > 0) {
    say(`  nominations close in ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
  }
  await chain.startTryout(league, briefId);
  let b = (await chain.getBrief(briefId))!;
  if (b.tryout_round) {
    say(`  tryout: round ${b.tryout_round} on ${b.tryout_task} (most stake behind it)`);
    await runRound({
      chain,
      verifier,
      taskId: b.tryout_task!,
      solver,
      scouts,
      existingRoundId: b.tryout_round,
      log: (l) => say(`  | ${l}`),
    });
    await chain.offer(league, briefId);
    b = (await chain.getBrief(briefId))!;
  }
  if (b.status !== "Offered") {
    say(`  brief ${b.status.toLowerCase()}: no candidate, the client is refunded`);
    return b;
  }
  const hired = ROSTER.find((a) => agentAccount(a, league) === b.offered);
  say(`  offer: ${short(b.offered!)} (best of the tryout)`);
  const jobId = Number(await chain.acceptOffer(client, briefId));
  say(`  the client accepts: job ${jobId} on its own task ${b.task_ref}, ${formatNear(b.budget)} NEAR in escrow`);
  if (!hired) {
    say("  the hire is an outside agent; it does the job on its own");
    return (await chain.getBrief(briefId))!;
  }
  await workJob({ chain, verifier, jobId, agent: hired, solver, say: (l) => say(`  ${l.trimStart()}`) });

  b = (await chain.getBrief(briefId))!;
  say(`  brief ${b.status.toLowerCase()}:`);
  for (const n of b.nominations) {
    const won = BigInt(n.payout) - BigInt(n.stake);
    const verdict = n.agent !== b.offered ? "stake back" : BigInt(n.payout) === 0n ? "stake lost to the client" : `stake back + ${formatNear(won)} reward`;
    say(`    ${short(n.scout).padEnd(12)} on ${short(n.agent).padEnd(7)} ${verdict}`);
  }
  return b;
}
