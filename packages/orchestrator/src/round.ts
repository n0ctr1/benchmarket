import fs from "node:fs";
import path from "node:path";
import { loadTask, publicView, roundTag, sha256Tagged, type Completion } from "@benchmarket/shared";
import { recheck, signScores, type Verifier } from "@benchmarket/verifier";
import { DOMAINS } from "@benchmarket/shared";
import type { LeagueChain, RoundView } from "./chain.js";
import type { RemoteVerifier } from "./remote.js";
import { config, DATA_DIR, formatNear } from "./config.js";
import { attestationArg, chat, type CompletionSignature } from "./nearai.js";
import { agentAccount, configHash, publicConfig, ROSTER, type AgentConfig } from "./roster.js";
import { SCRIPTED_SCOUTS, type Scout } from "./scouts.js";
import { simAnswer } from "./sim.js";
import { llmSolve } from "./llm.js";

export interface SolverAnswer {
  answer: string;
  meta?: Record<string, unknown>;
  /** Present for model answers: the exact bodies and the cloud's signature over them. */
  completion?: Completion;
  signature?: CompletionSignature | null;
}

export type Solver = ((agent: AgentConfig, taskId: string, tag: string, salt: string) => Promise<SolverAnswer>) & { attests?: boolean };

export const simSolver: Solver = async (agent, taskId, _tag, salt) => ({
  answer: simAnswer(agent, loadTask(taskId), salt),
  meta: { mode: "sim" },
});

/** Calls each agent's model on NEAR AI Cloud; rounds it runs require attested answers. */
export const llmSolver: Solver = Object.assign(async (agent: AgentConfig, taskId: string, tag: string) => llmSolve(agent, taskId, tag), { attests: true });

export interface RoundOptions {
  chain: LeagueChain;
  verifier: Verifier;
  taskId: string;
  solver?: Solver;
  scouts?: Scout[];
  agents?: AgentConfig[];
  /** Seconds the market stays open before the manager locks it. */
  marketSeconds?: number;
  /** On-chain task_ref; a variant like `parse-duration@smoke` runs the same tests unrated. */
  taskRef?: string;
  /** Keep registration open this long so outside agents can enter (they answer through the verifier API). */
  openSeconds?: number;
  /** Demo of the dispute path: the verifier posts swapped scores, the watcher catches it. */
  lie?: boolean;
  /** Play a round that already exists and is trading (a brief's tryout) instead of creating one. */
  existingRoundId?: number;
  /** Set when the caller committed fresh tests for an existing round (a family tryout). */
  freshTests?: boolean;
  /** Extra balance scouts need on top of their bet (brief nominations). */
  extraScoutFunds?: bigint;
  /** The public verifier prepares the tests, takes every answer and scores (an open round). */
  remote?: RemoteVerifier;
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
/** What scouts know about an agent the league does not run: only its account. */
const outsider = (account: string): AgentConfig => ({
  id: account.split(".")[0],
  name: account.split(".")[0],
  model: "unknown (outside agent)",
  systemPrompt: "",
  tools: [],
  strengths: [],
  sim: { failPermille: 0, strengthBonus: 0 },
});
const short = (a: string) => a.split(".")[0];
const pct = (ppm: number) => `${(ppm / 1e4).toFixed(1)}%`;

/**
 * Runs one full round on chain: create, register, fund the market maker, scouts buy, lock,
 * answers, verifier scores, dispute window with a watcher re-check, finalize, claims.
 */
export async function runRound(opts: RoundOptions): Promise<RoundView> {
  const { chain, verifier, taskId } = opts;
  const solver = opts.solver ?? simSolver;
  const scouts = opts.scouts ?? SCRIPTED_SCOUTS;
  const existing = opts.existingRoundId ? await chain.getRound(opts.existingRoundId) : null;
  // In an existing round, the league plays the entrants it runs; outsiders answer on their own.
  const agents = existing ? (opts.agents ?? ROSTER).filter((a) => existing.entries.some((e) => e.agent === agentAccount(a, config.leagueAccount))) : opts.agents ?? ROSTER;
  const say = opts.log ?? ((l: string) => console.log(l));
  const league = config.leagueAccount;
  const task = loadTask(taskId);
  const marketSeconds = opts.marketSeconds ?? 120;
  const attested = !!solver.attests;

  // A cloud outage must not pass for agents failing the task: before a real-model round opens,
  // every model in the field answers a ping, or the round is not created at all.
  if (attested && !existing) {
    const models = [...new Set(agents.map((a) => a.model))];
    const down: string[] = [];
    await Promise.all(
      models.map((m) =>
        chat(m, [{ role: "user", content: "Reply with OK." }], { maxTokens: 400, timeoutMs: 90_000 }).catch((e) => {
          if (!(e instanceof Error && /empty completion/.test(e.message))) down.push(`${m}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
        }),
      ),
    );
    if (down.length) throw new Error(`NEAR AI models unavailable, no round opened:\n  ${down.join("\n  ")}`);
  }

  // Every agent needs a passport before it can enter (npm run identities).
  for (const a of agents) {
    if (!(await chain.getIdentity(agentAccount(a, league)))) throw new Error(`${a.name} has no passport yet: run npm run identities`);
  }

  // 0. The league tops up agents and scouts that ran low, so a demo can run many rounds from one
  // faucet account. Done before the round exists so it never eats into the market window.
  const reserve = 0.05;
  for (const id of [...agents.map((a) => agentAccount(a, league)), ...scouts.map((s) => `${s.id}.${league}`)]) {
    const need = id.startsWith("scout") ? config.scoutBet : config.builderStake;
    const sent = await chain.topUp(config.managerAccount, id, need + (opts.extraScoutFunds && id.startsWith("scout") ? opts.extraScoutFunds : 0n) + BigInt(Math.round(reserve * 1e6)) * 10n ** 18n);
    if (sent > 0n) say(`  topped up ${short(id)} with ${formatNear(sent, sent < 10n ** 21n ? 6 : 3)} NEAR`);
  }

  // 1. Create. The deadline is a generous upper bound; the manager locks as soon as the last
  // scout has bought.
  const deadlineMs = Date.now() + Math.max(marketSeconds * 1000, 15 * 60_000);
  // A family task runs on fresh hidden tests: the verifier draws a secret seed, generates them
  // and the round commits their hash. The seed is published with the report.
  const record = existing ? null : (await chain.getTasks()).find((t) => t.task_ref === (opts.taskRef ?? task.id));
  const remote = opts.remote;
  const isFamily = !existing && task.familyHash && (record ? record.tests_hash === task.familyHash : false);
  const fresh = isFamily ? await (remote ? remote.prepareTests(task.id) : verifier.prepareTests(task.id)) : null;
  const roundId = existing ? existing.id : Number(
    await chain.createRound(config.managerAccount, {
      skill: task.skill,
      taskRef: opts.taskRef ?? task.id,
      testsHash: fresh ?? task.testsHash,
      betDeadlineMs: deadlineMs,
      maxAgents: Math.min(16, agents.length + (opts.openSeconds ? 4 : 0)),
      bounty: config.bounty,
      attested,
      // Only rounds on real, attested answers move ratings; simulated ones are played unrated.
      rated: attested,
    }),
  );
  if (fresh) await (remote ? remote.bindTests(roundId, fresh) : verifier.bindTests("round", roundId, fresh));
  const tag = roundTag("round", roundId);
  const log: RoundLog = { roundId, taskId, events: [] };
  const note = (kind: string, data: Record<string, unknown>) => {
    log.events.push({ at: Date.now(), kind, data });
    saveLog(log);
  };
  const created = (await chain.getRound(roundId))!;
  say(`round ${roundId}: ${task.title} (${task.id}), bounty ${formatNear(created.bounty)} NEAR${created.attested ? ", attested answers only" : ""}`);
  say(`  task difficulty ${(created.task_rating_before / 100).toFixed(1)}${created.rated ? "" : " (uncurated: no rating changes)"}${fresh || opts.freshTests ? ", fresh hidden tests from a secret seed" : ""}`);
  note("round_created", { task: publicView(task), attested: created.attested, task_rating: created.task_rating_before, tryout: !!existing });
  if (existing) {
    say(`  tryout: ${existing.entries.map((e) => short(e.agent)).join(", ")} entered by the scouts who nominated them; market maker funded with ${formatNear(existing.subsidy)} NEAR from the brief`);
  }

  // 2. Agents register themselves; the bond comes back if they answer.
  for (const a of existing ? [] : agents) {
    const acc = agentAccount(a, league);
    await chain.registerAgent(acc, roundId, acc, "Open", configHash(a), config.builderStake);
    say(`  ${a.name.padEnd(7)} registered (${a.model}), bond ${formatNear(config.builderStake)} NEAR`);
  }

  // Outside agents register themselves while registration is open.
  if (opts.openSeconds && !existing) {
    say(`  registration open for ${opts.openSeconds}s: any agent with a passport can enter (round ${roundId})`);
    await sleep(opts.openSeconds * 1000);
    const r = (await chain.getRound(roundId))!;
    for (const e of r.entries.filter((x) => !agents.some((a) => agentAccount(a, league) === x.agent))) {
      say(`  ${short(e.agent).padEnd(7)} entered from outside (builder ${short(e.builder)}, bond ${formatNear(e.bond)} NEAR)`);
    }
  }

  // 3. The manager funds the market maker. Its subsidy is its maximum loss.
  if (!existing) {
    await chain.openMarket(config.managerAccount, roundId, config.subsidy);
    say(`  market maker funded with ${formatNear(config.subsidy)} NEAR (LMSR)`);
  }

  // 4. Scouts buy one by one, each seeing the prices the previous purchases produced.
  for (const scout of scouts) {
    const round = (await chain.getRound(roundId))!;
    const field = await Promise.all(
      round.entries.map(async (e) => {
        const cfg = agents.find((a) => agentAccount(a, league) === e.agent) ?? outsider(e.agent);
        const r = await chain.getRating(e.agent, task.skill);
        return { agent: e.agent, config: cfg, rating: r.rating, rounds: r.rounds, odds: e.odds_ppm / 1e6 };
      }),
    );
    const d = await scout.decide(publicView(task), field);
    const account = `${scout.id}.${league}`;
    const before = field.find((f) => f.agent === d.agent)!.odds;
    const shares = await chain.buy(account, roundId, d.agent, config.scoutBet);
    const after = (await chain.getRound(roundId))!.entries.find((e) => e.agent === d.agent)!.odds_ppm;
    say(`  ${scout.id.padEnd(12)} buys ${short(d.agent)} at ${(before * 100).toFixed(1)}% -> ${pct(after)}: ${d.reasoning}`);
    note("scout_bet", { scout: account, kind: scout.kind, ...(scout.model ? { model: scout.model } : {}), agent: d.agent, reasoning: d.reasoning, amount: config.scoutBet.toString(), shares, price_before: before, price_after_ppm: after, ...(d.fallback ? { fallback: d.fallback } : {}) });
    if (d.fallback) say(`    (${scout.id} fallback: ${d.fallback.reason})`);
    await sleep(1500);
  }

  // 5. Lock: prices and expected scores are frozen.
  await chain.lockRound(created.manager, roundId);
  const locked = (await chain.getRound(roundId))!;
  say(`  market locked, volume ${formatNear(locked.total_pool)} NEAR`);
  for (const e of locked.entries) say(`    ${short(e.agent).padEnd(7)} price ${pct(e.market_ppm)}  expected ${pct(e.p_ppm)}`);

  // 6. Agents solve independently: hash (and attestation) on chain, the answer to the verifier.
  const salt = `${roundId}:${task.testsHash}`;
  await Promise.all(
    agents.map(async (a) => {
      const acc = agentAccount(a, league);
      try {
        const out = await solver(a, task.id, tag, salt);
        const body = out.completion ? out.completion.response : out.answer;
        const hash = sha256Tagged(body);
        if (created.attested && !out.signature) throw new Error("the cloud returned no signature for this completion");
        await chain.submitAnswer(acc, roundId, hash, out.signature ? attestationArg(out.signature) : undefined);
        if (remote) await remote.submit(roundId, acc, body, { request: out.completion?.request, config: publicConfig(a), meta: out.meta });
        else verifier.submit(roundId, acc, task.id, body, out.meta, { request: out.completion?.request, config: publicConfig(a) });
        const took = typeof out.meta?.latencyMs === "number" ? ` in ${(out.meta.latencyMs / 1000).toFixed(1)}s` : "";
        if (out.meta?.mode === "llm") say(`  ${a.name.padEnd(7)} answered${took}${out.signature ? `, ${out.signature.signature_kind ?? "cloud"}-signed and attested on chain` : ""}`);
        note("answer_submitted", { agent: acc, answer_hash: hash, attested: !!out.signature, meta: out.meta ?? null });
      } catch (e) {
        say(`  ${a.name} failed to answer: ${e instanceof Error ? e.message : e}`);
        note("answer_failed", { agent: acc, error: String(e) });
      }
    }),
  );

  // Outside agents answer on their own; give them until every entrant has answered (or the deadline).
  // With the public verifier, an outside agent's commitment on chain is the signal; it posts its
  // answer to the verifier right after.
  let answered = (await chain.getRound(roundId))!;
  const delivered = (e: { agent: string; answer_hash: string | null }) => !!e.answer_hash && (remote ? true : !!verifier.getAnswer(roundId, e.agent));
  while (!answered.entries.every(delivered) && Date.now() < answered.answer_deadline_ms) {
    await sleep(5000);
    answered = (await chain.getRound(roundId))!;
  }
  if (remote) await sleep(15_000);

  // 7. The verifier scores against the hidden tests and signs; the contract checks the signatures.
  // An open round is scored by the public verifier; its signed report is checked and kept here too.
  let report;
  if (remote) {
    const pub = await remote.score(roundId);
    verifier.importPublished("round", roundId, pub);
    report = pub.report;
    say(`  scored by the public verifier at ${remote.url}`);
  } else report = await verifier.score(roundId, task.id, answered.entries);
  for (const d of report.details) say(`    ${short(d.agent).padEnd(7)} ${d.score}/${report.totalTests}${d.check ? `  (${d.check})` : ""}`);
  // If an agent never answered, the contract waits for the answer deadline.
  const waitAnswers = answered.entries.every((e) => e.answer_hash) ? 0 : answered.answer_deadline_ms - Date.now() + 2000;
  if (waitAnswers > 0) {
    say(`  waiting ${Math.ceil(waitAnswers / 1000)}s for the answer deadline`);
    await sleep(waitAnswers);
  }
  let posted = { scores: report.scores, signatures: report.signatures };
  if (opts.lie) {
    // A dishonest verifier swaps the best and the worst score and signs that instead.
    const s = report.scores.map(([a, v]) => [a, v] as [string, number]);
    const hi = s.reduce((b, x, i) => (x[1] > s[b][1] ? i : b), 0);
    const lo = s.reduce((b, x, i) => (x[1] < s[b][1] ? i : b), 0);
    [s[hi][1], s[lo][1]] = [s[lo][1], s[hi][1]];
    posted = { scores: s, signatures: signScores(config.verifierSecretKeys, DOMAINS.round, roundId, report.totalTests, s).signatures };
    say(`  (demo) the verifier signs swapped scores: ${short(s[hi][0])} ${s[hi][1]}, ${short(s[lo][0])} ${s[lo][1]}`);
  }
  await chain.settle(config.managerAccount, roundId, report.totalTests, posted.scores, posted.signatures.slice(0, config.verifierThreshold));
  // The RPC node may answer from a block before the settle landed; read until it shows.
  let round = (await chain.getRound(roundId))!;
  for (let i = 0; i < 20 && round.status === "Locked"; i++) {
    await sleep(1500);
    round = (await chain.getRound(roundId))!;
  }
  note("scores_proposed", { scores: report.scores, message: report.message, dispute_until_ms: round.proposal?.dispute_until_ms ?? null });

  // 8. Dispute window: a watcher re-runs the published answers against the published tests.
  if (round.status === "Proposed") {
    const published = verifier.published(roundId)!;
    const check = await recheck(published, round);
    say(`  scores posted; dispute window until ${new Date(round.proposal!.dispute_until_ms).toISOString().slice(11, 19)} UTC`);
    say(`  watcher re-ran ${published.answers.length} answers on the published tests: ${check.ok ? "scores match" : `MISMATCH: ${check.problems.join("; ")}`}`);
    note("watcher_check", { ok: check.ok, problems: check.problems });
    if (check.ok) {
      const wait = round.proposal!.dispute_until_ms - Date.now() + 2000;
      if (wait > 0) await sleep(wait);
      await chain.finalize(config.managerAccount, roundId);
    } else {
      // The watcher disputes; arbiters re-run on their own and rule with their signature.
      const bond = BigInt((await chain.getConfig()).params.dispute_bond);
      await chain.dispute(config.managerAccount, roundId, bond);
      say(`  watcher disputes with a ${formatNear(bond)} NEAR bond`);
      note("disputed", { bond: bond.toString(), problems: check.problems });
      if (config.arbiterSecretKeys.length) {
        const disputed = (await chain.getRound(roundId))!;
        const ruling = await recheck(published, disputed);
        const sig = signScores(config.arbiterSecretKeys, DOMAINS.roundArbiter, roundId, ruling.totalTests, ruling.scores).signatures;
        await chain.resolveDispute(config.managerAccount, roundId, ruling.totalTests, ruling.scores, sig);
        const r = (await chain.getRound(roundId))!;
        say(`  arbiter re-ran and ruled: ${r.dispute?.overturned ? "scores overturned, the signing verifier keys lost their stake to the disputer" : "scores upheld"}`);
        note("dispute_resolved", { overturned: r.dispute?.overturned ?? null, scores: ruling.scores });
      } else {
        say("  no arbiter keys here: the round waits for arbiters or refunds after the resolve timeout");
      }
    }
    round = (await chain.getRound(roundId))!;
  }
  note("round_settled", { winners: round.winners, scores: report.scores, message: report.message });
  say(`  winners: ${round.winners.length ? round.winners.map(short).join(", ") : "none"} (${round.payout_mode})`);
  for (const e of round.entries) {
    const signed = (v: number) => `${v >= 0 ? "+" : ""}${(v / 100).toFixed(1)}`;
    say(`    ${short(e.agent).padEnd(7)} rating ${((e.rating_before + e.rating_delta) / 100).toFixed(1)} (${signed(e.rating_delta)}: field ${signed(e.field_delta)}, task ${signed(e.task_delta)})`);
  }
  if (round.rated) say(`    task ${task.id} difficulty ${((round.task_rating_before + round.task_delta) / 100).toFixed(1)} (${round.task_delta >= 0 ? "+" : ""}${(round.task_delta / 100).toFixed(1)})`);

  // 9. Everybody with a position or a bond claims.
  // Outside agents claim their own bonds.
  const holders = new Set<string>([league, ...agents.map((a) => agentAccount(a, league)), ...scouts.map((s) => `${s.id}.${league}`)]);
  for (const h of holders) {
    const pos = await chain.getPosition(roundId, h);
    if (pos.length === 0) continue;
    const got = await chain.claim(h, roundId);
    if (BigInt(got ?? "0") > 0n) say(`  ${short(h)} claimed ${formatNear(got)} NEAR`);
  }
  return round;
}
