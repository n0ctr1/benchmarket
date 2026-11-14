import { loadTask, publicView, roundTag, sha256Tagged, taskPrompt } from "@benchmarket/shared";
import type { Verifier } from "@benchmarket/verifier";
import type { BriefView, LeagueChain } from "./chain.js";
import { config, formatNear, near } from "./config.js";
import { workJob } from "./job.js";
import { attestationArg, attestedSigners, sealedChat } from "./nearai.js";
import { agentAccount, configHash, publicConfig, ROSTER } from "./roster.js";
import { runRound, type Solver } from "./round.js";
import { SCRIPTED_SCOUTS, type Scout } from "./scouts.js";
import { CATEGORIES } from "./categories.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (a: string) => a.split(".")[0];

export interface BriefOptions {
  chain: LeagueChain;
  verifier: Verifier;
  /** The client's own task. It is handed over only to the agent it hires. */
  taskId: string;
  summary: string;
  /** Category from the league's list; by default the one the client's task is filed under. */
  category?: string;
  /**
   * Confidential: the client's task goes end-to-end encrypted to the hire's model enclave only.
   * Needs real models (--llm): only agents on models NEAR AI runs in a TEE are eligible.
   */
  confidential?: boolean;
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
  const bounty = config.tryoutBounty;
  const subsidy = config.tryoutSubsidy;
  const nominateSeconds = 60;

  // The client and the scouts need funds for the escrow and the stakes.
  const escrow = opts.budget + opts.scoutReward + bounty + subsidy;
  const sent = await chain.topUp(league, client, escrow + near("0.05"));
  if (sent > 0n) say(`  topped up the client with ${formatNear(sent)} NEAR`);

  const category = opts.category ?? CATEGORIES.find((c) => c.tasks.includes(task.id))?.id;
  const cat = CATEGORIES.find((c) => c.id === category);
  const briefId = Number(
    await chain.postBrief(client, {
      skill: task.skill,
      summary: opts.summary,
      category,
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
      confidential: opts.confidential,
    }),
  );
  say(`brief ${briefId}: "${opts.summary}"${cat ? ` [${cat.title}]` : ""}`);
  say(opts.confidential ? "  confidential: the task will go end-to-end encrypted to the hire's model enclave, and nowhere else" : "  the client keeps its task to itself: only the agent it hires will see it");
  say(`  escrow: budget ${formatNear(opts.budget)}, scout reward ${formatNear(opts.scoutReward)}, tryout ${formatNear(bounty)} bounty + ${formatNear(subsidy)} market NEAR`);

  // Scouts see the brief, the curated tasks of its category and every agent with a passport. (In
  // this demo the league also knows the client's task, and keeps it out of the tryout.)
  const curated = (await chain.getTasks()).filter((t) => t.curated && !t.retired && t.skill === task.skill && t.task_ref !== task.id && (!category || t.category === category));
  if (curated.length === 0) throw new Error(`no curated tryout task in category ${category}`);
  const tryoutTasks = curated.map((t) => {
    const p = publicView(loadTask(t.task_ref));
    return { id: t.task_ref, title: p.title, statement: p.statement, rating: t.rating };
  });
  // Confidential work can only go to agents whose model runs in an enclave NEAR AI attests.
  let eligible = ROSTER;
  if (opts.confidential) {
    if (!solver.attests) throw new Error("a confidential brief needs real models: add --llm");
    const enclaves = new Set((await attestedSigners([...new Set(ROSTER.map((a) => a.model))])).models.map((m) => m.model));
    eligible = ROSTER.filter((a) => enclaves.has(a.model));
    say(`  eligible (model in an attested enclave): ${eligible.map((a) => a.name).join(", ") || "none"}`);
  }
  const field = await Promise.all(
    eligible.map(async (a) => {
      const acc = agentAccount(a, league);
      const r = await chain.getRating(acc, task.skill);
      return { agent: acc, config: a, rating: r.rating, rounds: r.rounds, odds: 0 };
    }),
  );
  for (const scout of scouts) {
    if (!scout.nominate) continue;
    const account = `${scout.id}.${league}`;
    const picks = await scout.nominate({ summary: opts.summary, skill: task.skill, category: cat ? `${cat.title}: ${cat.description}` : undefined }, field, tryoutTasks);
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
  // A family tryout runs on fresh tests the verifier generates now; their hash goes on chain.
  const next = await chain.nextTryoutTask(briefId);
  const nextRecord = next ? (await chain.getTasks()).find((t) => t.task_ref === next) : undefined;
  const fresh = next && nextRecord?.tests_hash.startsWith("family:") ? await verifier.prepareTests(next) : undefined;
  await chain.startTryout(league, briefId, fresh);
  let b = (await chain.getBrief(briefId))!;
  if (fresh && b.tryout_round) verifier.bindTests("round", b.tryout_round, fresh);
  if (b.tryout_round) {
    say(`  tryout: round ${b.tryout_round} on ${b.tryout_task} (most stake behind it)`);
    await runRound({
      chain,
      verifier,
      taskId: b.tryout_task!,
      solver,
      scouts,
      existingRoundId: b.tryout_round,
      freshTests: !!fresh,
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
  const clientRef = `${task.id}@brief-${briefId}`;
  const jobId = Number(await chain.acceptOffer(client, briefId, clientRef, task.testsHash));
  say(`  the client accepts and hands over its task (${clientRef}) to ${short(b.offered!)} only: job ${jobId}, ${formatNear(b.budget)} NEAR in escrow`);
  if (!hired) {
    say("  the hire is an outside agent; it does the job on its own");
    return (await chain.getBrief(briefId))!;
  }
  if (opts.confidential) await confidentialJob({ chain, verifier, jobId, client, agent: hired, taskId: task.id, say });
  else await workJob({ chain, verifier, jobId, agent: hired, solver, say: (l) => say(`  ${l.trimStart()}`) });

  b = (await chain.getBrief(briefId))!;
  say(`  brief ${b.status.toLowerCase()}:`);
  for (const n of b.nominations) {
    const won = BigInt(n.payout) - BigInt(n.stake);
    const verdict = n.agent !== b.offered ? "stake back" : BigInt(n.payout) === 0n ? "stake lost to the client" : `stake back + ${formatNear(won)} reward`;
    say(`    ${short(n.scout).padEnd(12)} on ${short(n.agent).padEnd(7)} ${verdict}`);
  }
  return b;
}

/**
 * The client runs the hire's public config (model and system prompt) on its own task through
 * NEAR AI end-to-end encryption, commits the answer with the enclave's signature, and hands the
 * verifier its private tests and the one-time keys of this exchange. Nothing about the task
 * reaches the chain, the agent's operator or the public report.
 */
async function confidentialJob(o: { chain: LeagueChain; verifier: Verifier; jobId: number; client: string; agent: (typeof ROSTER)[number]; taskId: string; say: (l: string) => void }) {
  const { chain, verifier, jobId, client, agent, say } = o;
  const task = loadTask(o.taskId);
  const league = config.leagueAccount;
  const acc = agentAccount(agent, league);
  const tag = roundTag("job", jobId);
  const out = await sealedChat(agent.model, [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: taskPrompt(publicView(task), tag) },
  ]);
  if (out.signature?.signature_kind !== "provider_tee") throw new Error(`no enclave signature for ${agent.model}`);
  say(`  the client ran ${agent.name}'s config in the ${agent.model} enclave (${(out.latencyMs / 1000).toFixed(1)}s), sealed to the key from its attestation report`);
  await chain.submitJob(client, jobId, sha256Tagged(out.responseBody), attestationArg(out.signature));
  const job = (await chain.getJob(jobId))!;
  say(`  answer committed with the enclave's signature (${job.model})`);
  verifier.provideTests("job", jobId, task.rawTests, job.tests_hash, task.id);
  verifier.submit(jobId, acc, task.id, out.responseBody, { mode: "llm", confidential: true, signature: out.signature }, { kind: "job", request: out.requestBody, config: publicConfig(agent), sealed: out.sealed });
  const entry = { agent: acc, answer_hash: job.answer_hash, attested: job.answer_attested, request_hash: job.request_hash, model: job.model, config_hash: configHash(agent) };
  const report = await verifier.scoreJob(jobId, task.id, entry);
  const d = report.details[0];
  say(`  verifier opened only this exchange with the revealed one-time keys: ${d.score}/${report.totalTests}${d.check ? ` (${d.check})` : ""}`);
  await chain.settleJob(league, jobId, report.totalTests, d.score, report.signatures.slice(0, config.verifierThreshold));
  let j = (await chain.getJob(jobId))!;
  if (j.status === "Proposed") {
    const wait = (j.dispute_until_ms ?? 0) - Date.now() + 2000;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await chain.finalizeJob(league, jobId);
    j = (await chain.getJob(jobId))!;
  }
  say(`  ${j.status === "Paid" ? `paid ${agent.name}` : "failed the bar, client refunded"}; the public report holds the score and hashes only`);
}
