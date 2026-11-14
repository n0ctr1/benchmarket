import { completionContent, loadTask, publicView, taskPrompt } from "@benchmarket/shared";
import type { Verifier } from "@benchmarket/verifier";
import type { LeagueChain } from "./chain.js";
import { config, formatNear } from "./config.js";
import { workJob } from "./job.js";
import { chat, completionSignature } from "./nearai.js";
import { agentAccount, ROSTER, type AgentConfig } from "./roster.js";
import type { Solver } from "./round.js";

const short = (a: string) => a.split(".")[0];

/**
 * Agents hiring agents. The league posts a job; the best-rated agent that clears its bar takes
 * it, then hires another agent by rating on chain for a first draft, paying from its own account
 * (a sub-job linked to the parent on chain). The hired agent answers and is scored and paid like
 * any hire; the contractor reviews the draft with its own model and delivers the parent job,
 * attested, and is paid the parent budget. Every step is a contract call.
 */
export async function runSubcontract(o: {
  chain: LeagueChain;
  verifier: Verifier;
  taskId: string;
  solver: Solver;
  minRating: number;
  subMinRating: number;
  budget: bigint;
  subBudget: bigint;
  say?: (l: string) => void;
}): Promise<{ parent: number; sub: number }> {
  const { chain, verifier, taskId, solver } = o;
  const say = o.say ?? ((l: string) => console.log(l));
  const league = config.leagueAccount;
  const task = loadTask(taskId);
  if (o.subBudget >= o.budget) throw new Error("the sub-job must pay less than the parent job");

  const parent = Number(
    await chain.postJob(config.managerAccount, { skill: task.skill, taskRef: task.id, testsHash: task.testsHash, minRating: o.minRating, minRounds: 3, passPpm: 900_000, workWindowMs: 40 * 60_000, attested: !!solver.attests, budget: o.budget }),
  );
  say(`job ${parent}: ${task.title}, ${formatNear(o.budget)} NEAR, rating ${o.minRating}+`);

  const board = await chain.getLeaderboard(task.skill);
  const roster = (acc: string) => ROSTER.find((x) => agentAccount(x, league) === acc);
  const pick = async (bar: number, except: string[]) => {
    for (const row of board) {
      const a = roster(row.agent);
      if (a && !except.includes(row.agent) && (await chain.isQualified(row.agent, task.skill, bar))) return a;
    }
    throw new Error(`no agent clears ${bar}`);
  };

  const contractor = await pick(o.minRating, []);
  const cAcc = agentAccount(contractor, league);
  await chain.takeJob(cAcc, parent);
  say(`  ${contractor.name} takes job ${parent}`);

  // The contractor pays for the sub-job itself: top it up only to cover the budget and gas.
  await chain.topUp(config.managerAccount, cAcc, o.subBudget + 50_000_000_000_000_000_000_000n);
  const sub = Number(
    await chain.postJob(cAcc, { skill: task.skill, taskRef: task.id, testsHash: task.testsHash, minRating: o.subMinRating, minRounds: 3, passPpm: 900_000, workWindowMs: 20 * 60_000, attested: !!solver.attests, budget: o.subBudget, parentJob: parent }),
  );
  say(`  ${contractor.name} subcontracts a first draft: job ${sub} (parent ${parent}), ${formatNear(o.subBudget)} NEAR from its own account, rating ${o.subMinRating}+`);

  const hire = await pick(o.subMinRating, [cAcc]);
  await chain.takeJob(agentAccount(hire, league), sub);
  say(`  ${hire.name} takes job ${sub}`);
  const subResult = await workJob({ chain, verifier, jobId: sub, agent: hire, solver, say });

  // The draft the contractor paid for, as the verifier received it.
  const stored = verifier.getAnswer(sub, agentAccount(hire, league), "job");
  const draft = stored ? completionContent(stored.answer) ?? stored.answer : "";
  say(`  ${contractor.name} reviews ${hire.name}'s draft (${subResult.score ?? 0}/${subResult.total_tests} on the hidden tests, which it does not see)`);

  // The contractor's own completion: its registered config and the job's prompt, plus the draft.
  const review: Solver = Object.assign(
    async (agent: AgentConfig, tId: string, tag: string) => {
      const prompt = taskPrompt(publicView(loadTask(tId)), tag);
      const messages = [
        { role: "system" as const, content: agent.systemPrompt },
        { role: "user" as const, content: prompt },
        {
          role: "user" as const,
          content: `You subcontracted a first draft of this function to another agent (job ${sub}). Its draft is below. Check it against the statement and the examples, fix anything wrong, and reply with the final function only.\n\n${draft}`,
        },
      ];
      const r = await chat(agent.model, messages);
      const signature = await completionSignature(r.id, agent.model);
      return { answer: r.content, completion: { request: r.requestBody, response: r.responseBody }, signature, meta: { mode: "llm", model: r.model, completionId: r.id, usage: r.usage, reviewOf: sub, signature } };
    },
    { attests: solver.attests },
  );
  const parentResult = await workJob({ chain, verifier, jobId: parent, agent: contractor, solver: solver.attests ? review : solver, say });
  const margin = (parentResult.status === "Paid" ? o.budget : 0n) - (subResult.status === "Paid" ? o.subBudget : 0n);
  say(`  ${short(cAcc)} margin: ${formatNear(margin)} NEAR (before fees); ${hire.name} ${subResult.status === "Paid" ? "was paid by an agent" : "failed its bar"}`);
  return { parent, sub };
}
