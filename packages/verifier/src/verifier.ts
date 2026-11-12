import fs from "node:fs";
import path from "node:path";
import {
  checkCompletion,
  completionContent,
  DOMAINS,
  loadTask,
  publicKeyOf,
  roundTag,
  sha256Tagged,
  signedMessage,
  signMessage,
  type Domain,
  type PublicConfig,
  type TestCase,
} from "@agent-league/shared";
import { normalizeCode, runTests, type RunResult, type SandboxOptions } from "./sandbox.js";

export type Kind = "round" | "job";

export interface StoredAnswer {
  agent: string;
  taskId: string;
  /** The answer text, or for a completion the exact response body (its hash is the answer hash). */
  answer: string;
  answerHash: string;
  receivedAt: number;
  /** Exact request body, for a completion. */
  request?: string;
  /** The agent's public config (its hash is registered on chain). */
  config?: PublicConfig;
  /** Free-form evidence from the runtime, e.g. a NEAR AI Cloud completion signature. */
  meta?: Record<string, unknown>;
}

/** What the chain says about one entrant (a subset of the contract's EntryView / JobView). */
export interface ChainEntry {
  agent: string;
  answer_hash: string | null;
  attested?: boolean;
  request_hash?: string | null;
  model?: string | null;
  config_hash?: string;
}

export interface AgentScore {
  agent: string;
  score: number;
  answerHash: string | null;
  /** Why the answer scored 0 without running, if it did. */
  check: string | null;
  attested: boolean;
  run: RunResult | null;
}

export interface ScoreReport {
  kind: Kind;
  /** Round id or job id. */
  roundId: number;
  taskId: string;
  testsHash: string;
  totalTests: number;
  scores: Array<[string, number]>;
  details: AgentScore[];
  message: string;
  signatures: string[];
  publicKeys: string[];
}

/** Everything a watcher needs to re-run the scoring: answers, raw tests, the signed report. */
export interface PublishedReport {
  report: ScoreReport;
  answers: StoredAnswer[];
  function: string;
  rawTests: string;
}

/** The code to run for one entrant, or why there is none. */
export function answerCode(entry: ChainEntry, stored: StoredAnswer | undefined, tag: string): { code: string | null; check: string | null } {
  if (!stored) return { code: null, check: entry.answer_hash ? "answer committed on chain but never delivered" : "no answer" };
  if (entry.answer_hash !== stored.answerHash) return { code: null, check: "delivered answer does not match the hash on chain" };
  if (entry.attested) {
    if (!stored.request) return { code: null, check: "attested answer without its request" };
    const c = checkCompletion(
      { request: stored.request, response: stored.answer },
      { requestHash: entry.request_hash, model: entry.model, configHash: entry.config_hash ?? "", config: stored.config, tag },
    );
    return c.ok ? { code: normalizeCode(c.content!), check: null } : { code: null, check: c.reason ?? "completion check failed" };
  }
  const content = stored.request ? completionContent(stored.answer) ?? stored.answer : stored.answer;
  return { code: normalizeCode(content), check: null };
}

/**
 * Scores entrants against tests. Pure apart from the sandbox: the verifier, watchers and
 * arbiters all call this on the same inputs and must get the same numbers.
 */
export async function scoreAnswers(
  fn: string,
  tests: TestCase[],
  entries: ChainEntry[],
  answers: Map<string, StoredAnswer>,
  tag: string,
  sandbox: SandboxOptions = {},
): Promise<AgentScore[]> {
  const out: AgentScore[] = [];
  for (const e of entries) {
    const stored = answers.get(e.agent);
    const { code, check } = answerCode(e, stored, tag);
    if (code === null) {
      out.push({ agent: e.agent, score: 0, answerHash: stored?.answerHash ?? null, check, attested: !!e.attested, run: null });
      continue;
    }
    const run = await runTests(code, fn, tests, sandbox);
    out.push({ agent: e.agent, score: run.passed, answerHash: stored!.answerHash, check: null, attested: !!e.attested, run });
  }
  return out;
}

export function signScores(secretKeys: string[], domain: Domain, id: number, totalTests: number, scores: Array<[string, number]>) {
  const message = signedMessage(domain, id, totalTests, scores);
  return { message, signatures: secretKeys.map((k) => signMessage(k, message)) };
}

const key = (kind: Kind, id: number) => `${kind}:${id}`;

/**
 * Holds answers per round and per job, runs hidden tests and signs the scores.
 * One instance can hold several verifier keys to demo k-of-n; in production each key
 * would live in a separate verifier process run by a different party.
 */
export class Verifier {
  private answers = new Map<string, Map<string, StoredAnswer>>();
  private reports = new Map<string, ScoreReport>();

  constructor(
    private readonly secretKeys: string[],
    private readonly dataDir?: string,
    private readonly sandbox: SandboxOptions = {},
  ) {
    if (secretKeys.length === 0) throw new Error("verifier needs at least one secret key");
    if (dataDir) this.load();
  }

  get publicKeys(): string[] {
    return this.secretKeys.map(publicKeyOf);
  }

  submit(
    roundId: number,
    agent: string,
    taskId: string,
    answer: string,
    meta?: Record<string, unknown>,
    extra: { request?: string; config?: PublicConfig; kind?: Kind } = {},
  ): StoredAnswer {
    const k = key(extra.kind ?? "round", roundId);
    if (this.reports.has(k)) throw new Error(`${k} already scored`);
    const round = this.answers.get(k) ?? new Map<string, StoredAnswer>();
    if (round.has(agent)) throw new Error(`answer from ${agent} already received`);
    const stored: StoredAnswer = {
      agent,
      taskId,
      answer,
      answerHash: sha256Tagged(answer),
      receivedAt: Date.now(),
      ...(extra.request ? { request: extra.request } : {}),
      ...(extra.config ? { config: extra.config } : {}),
      meta,
    };
    round.set(agent, stored);
    this.answers.set(k, round);
    this.save();
    return stored;
  }

  getAnswer(roundId: number, agent: string, kind: Kind = "round"): StoredAnswer | undefined {
    return this.answers.get(key(kind, roundId))?.get(agent);
  }

  getReport(roundId: number, kind: Kind = "round"): ScoreReport | undefined {
    return this.reports.get(key(kind, roundId));
  }

  /** Report with answers and raw tests, once scored: anyone can re-run it. */
  published(id: number, kind: Kind = "round"): PublishedReport | undefined {
    const report = this.reports.get(key(kind, id));
    if (!report) return undefined;
    const task = loadTask(report.taskId);
    return { report, answers: [...(this.answers.get(key(kind, id))?.values() ?? [])], function: task.function, rawTests: task.rawTests };
  }

  /**
   * Scores every entrant of a round in registration order. Entries come from the chain; an
   * agent scores 0 without a delivered answer matching its hash, or, for an attested answer,
   * when the completion does not match its registered config and this round.
   */
  async score(roundId: number, taskId: string, entries: ChainEntry[]): Promise<ScoreReport> {
    return this.scoreKind("round", roundId, taskId, entries);
  }

  async scoreJob(jobId: number, taskId: string, entry: ChainEntry): Promise<ScoreReport> {
    return this.scoreKind("job", jobId, taskId, [entry]);
  }

  private async scoreKind(kind: Kind, id: number, taskId: string, entries: ChainEntry[]): Promise<ScoreReport> {
    const existing = this.reports.get(key(kind, id));
    if (existing) return existing;
    const task = loadTask(taskId);
    const answers = this.answers.get(key(kind, id)) ?? new Map<string, StoredAnswer>();
    const details = await scoreAnswers(task.function, task.tests, entries, answers, roundTag(kind, id), this.sandbox);
    const scores: Array<[string, number]> = details.map((d) => [d.agent, d.score]);
    const { message, signatures } = signScores(this.secretKeys, kind === "round" ? DOMAINS.round : DOMAINS.job, id, task.tests.length, scores);
    const report: ScoreReport = {
      kind,
      roundId: id,
      taskId,
      testsHash: task.testsHash,
      totalTests: task.tests.length,
      scores,
      details,
      message,
      signatures,
      publicKeys: this.publicKeys,
    };
    this.reports.set(key(kind, id), report);
    this.save();
    return report;
  }

  private file(): string | null {
    return this.dataDir ? path.join(this.dataDir, "verifier-state.json") : null;
  }

  private save(): void {
    const f = this.file();
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const state = {
      version: 2,
      answers: [...this.answers].map(([id, m]) => [id, [...m.values()]]),
      reports: [...this.reports],
    };
    fs.writeFileSync(f, JSON.stringify(state, null, 2));
  }

  private load(): void {
    const f = this.file();
    if (!f || !fs.existsSync(f)) return;
    const state = JSON.parse(fs.readFileSync(f, "utf8")) as {
      answers: Array<[number | string, StoredAnswer[]]>;
      reports: Array<[number | string, ScoreReport]>;
    };
    // Version 1 keyed rounds by number.
    const k = (id: number | string) => (typeof id === "number" ? key("round", id) : id);
    for (const [id, list] of state.answers) this.answers.set(k(id), new Map(list.map((a) => [a.agent, a])));
    for (const [id, r] of state.reports) this.reports.set(k(id), { ...r, kind: r.kind ?? "round" });
  }
}
