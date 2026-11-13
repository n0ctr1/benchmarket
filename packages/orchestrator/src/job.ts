import { loadTask, roundTag, sha256Tagged } from "@benchmarket/shared";
import { recheck, taskIdOf, type Verifier } from "@benchmarket/verifier";
import type { JobView, LeagueChain } from "./chain.js";
import { config, formatNear } from "./config.js";
import { attestationArg } from "./nearai.js";
import { agentAccount, publicConfig, ROSTER, type AgentConfig } from "./roster.js";
import type { Solver } from "./round.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (a: string) => a.split(".")[0];

export interface JobOptions {
  chain: LeagueChain;
  verifier: Verifier;
  taskId: string;
  /** On-chain task_ref; defaults to the task id (curated, rated). */
  taskRef?: string;
  solver: Solver;
  /** Whole rating points an agent needs to take the job. */
  minRating: number;
  budget: bigint;
  log?: (line: string) => void;
}

/**
 * A hire through the league: the league posts a job with a rating bar, the best-rated agent
 * that qualifies takes it, answers, the verifier scores it, and after the dispute window the
 * escrow pays the agent (or refunds the poster). The result moves the agent's rating.
 */
export async function runJob(opts: JobOptions): Promise<JobView> {
  const { chain, verifier, taskId, solver } = opts;
  const say = opts.log ?? ((l: string) => console.log(l));
  const league = config.leagueAccount;
  const task = loadTask(taskId);
  const jobId = Number(
    await chain.postJob(league, {
      skill: task.skill,
      taskRef: opts.taskRef ?? task.id,
      testsHash: task.testsHash,
      minRating: opts.minRating,
      minRounds: 3,
      passPpm: 900_000,
      workWindowMs: 20 * 60_000,
      attested: !!solver.attests,
      budget: opts.budget,
    }),
  );
  say(`job ${jobId}: ${task.title}, budget ${formatNear(opts.budget)} NEAR, needs rating ${opts.minRating}+ and 90% of hidden tests`);

  // The best-rated agent that clears the bar takes it.
  const board = await chain.getLeaderboard(task.skill);
  let hired: (typeof ROSTER)[number] | undefined;
  for (const row of board) {
    const a = ROSTER.find((x) => agentAccount(x, league) === row.agent);
    if (a && (await chain.isQualified(row.agent, task.skill, opts.minRating))) {
      hired = a;
      break;
    }
    say(`  ${short(row.agent)} (${(row.rating / 100).toFixed(1)}) does not qualify`);
  }
  if (!hired) throw new Error("no agent clears the rating bar");
  // The bar is the contract's, not the runner's: the lowest-rated agent below it tries anyway
  // and the contract refuses it.
  const below = [...board].reverse().find((row) => row.rating / 100 < opts.minRating && ROSTER.some((x) => agentAccount(x, league) === row.agent));
  if (below) {
    try {
      await chain.takeJob(below.agent, jobId);
      throw new Error(`${short(below.agent)} took a job below its bar`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("rating bar")) throw e;
      say(`  ${short(below.agent)} (${(below.rating / 100).toFixed(1)}) tries to take it: refused on chain, "agent does not meet the rating bar"`);
    }
  }
  const acc = agentAccount(hired, league);
  await chain.takeJob(acc, jobId);
  say(`  ${hired.name} takes the job`);
  return workJob({ chain, verifier, jobId, agent: hired, solver, say });
}

/** The hired agent does the job; the verifier scores it; after the dispute window it closes. */
export async function workJob(o: { chain: LeagueChain; verifier: Verifier; jobId: number; agent: AgentConfig; solver: Solver; say: (l: string) => void }): Promise<JobView> {
  const { chain, verifier, jobId, solver, say } = o;
  const hired = o.agent;
  const league = config.leagueAccount;
  const acc = agentAccount(hired, league);
  const posted = (await chain.getJob(jobId))!;
  const task = loadTask(taskIdOf(posted.task_ref));
  const out = await solver(hired, task.id, roundTag("job", jobId), `job:${jobId}`);
  const body = out.completion ? out.completion.response : out.answer;
  if (solver.attests && !out.signature) throw new Error("the cloud returned no signature for this completion");
  await chain.submitJob(acc, jobId, sha256Tagged(body), out.signature ? attestationArg(out.signature) : undefined);
  verifier.submit(jobId, acc, task.id, body, out.meta, { kind: "job", request: out.completion?.request, config: publicConfig(hired) });
  say(`  ${hired.name} answered${out.signature ? " (attested)" : ""}`);

  const job = (await chain.getJob(jobId))!;
  const identity = await chain.getIdentity(acc);
  const entry = { agent: acc, answer_hash: job.answer_hash, attested: job.answer_attested, request_hash: job.request_hash, model: job.model, config_hash: identity?.config_hash };
  const report = await verifier.scoreJob(jobId, task.id, entry);
  const d = report.details[0];
  say(`  verifier: ${d.score}/${report.totalTests}${d.check ? ` (${d.check})` : ""}`);
  await chain.settleJob(league, jobId, report.totalTests, d.score, report.signatures.slice(0, config.verifierThreshold));
  let j = (await chain.getJob(jobId))!;
  if (j.status === "Proposed") {
    const check = await recheck(verifier.published(jobId, "job")!, { id: jobId, tests_hash: j.tests_hash, entries: [entry], proposal: { total_tests: report.totalTests, scores: [[acc, j.score ?? d.score]] } }, "job");
    say(`  watcher re-run: ${check.ok ? "score matches" : check.problems.join("; ")}`);
    const wait = (j.dispute_until_ms ?? 0) - Date.now() + 2000;
    if (wait > 0) await sleep(wait);
    await chain.finalizeJob(league, jobId);
    j = (await chain.getJob(jobId))!;
  }
  const sign = j.rating_delta >= 0 ? "+" : "";
  say(`  ${j.status === "Paid" ? `paid ${hired.name}` : "failed the bar, poster refunded"}; rating ${sign}${(j.rating_delta / 100).toFixed(1)}`);
  return j;
}
