import fs from "node:fs";
import path from "node:path";
import { loadTask, publicKeyOf, settlementMessage, sha256Tagged, signMessage } from "@agent-league/shared";
import { normalizeCode, runTests, type RunResult, type SandboxOptions } from "./sandbox.js";

export interface StoredAnswer {
  agent: string;
  taskId: string;
  answer: string;
  answerHash: string;
  receivedAt: number;
  /** Free-form evidence from the runtime, e.g. a NEAR AI Cloud completion signature. */
  meta?: Record<string, unknown>;
}

export interface AgentScore {
  agent: string;
  score: number;
  answerHash: string | null;
  run: RunResult | null;
}

export interface ScoreReport {
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

/**
 * Holds answers per round, runs hidden tests and signs the scores.
 * One instance can hold several verifier keys to demo k-of-n; in production each key
 * would live in a separate verifier process run by a different party.
 */
export class Verifier {
  private answers = new Map<number, Map<string, StoredAnswer>>();
  private reports = new Map<number, ScoreReport>();

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

  submit(roundId: number, agent: string, taskId: string, answer: string, meta?: Record<string, unknown>): StoredAnswer {
    if (this.reports.has(roundId)) throw new Error(`round ${roundId} already scored`);
    const round = this.answers.get(roundId) ?? new Map<string, StoredAnswer>();
    if (round.has(agent)) throw new Error(`answer from ${agent} already received`);
    const stored: StoredAnswer = { agent, taskId, answer, answerHash: sha256Tagged(answer), receivedAt: Date.now(), meta };
    round.set(agent, stored);
    this.answers.set(roundId, round);
    this.save();
    return stored;
  }

  getAnswer(roundId: number, agent: string): StoredAnswer | undefined {
    return this.answers.get(roundId)?.get(agent);
  }

  getReport(roundId: number): ScoreReport | undefined {
    return this.reports.get(roundId);
  }

  /**
   * Scores every agent of a round in registration order. Agents without an answer, or whose
   * answer hash differs from the one on chain (when `onChainHashes` is given), score 0.
   */
  async score(roundId: number, taskId: string, agents: string[], onChainHashes?: Record<string, string | null>): Promise<ScoreReport> {
    const existing = this.reports.get(roundId);
    if (existing) return existing;
    const task = loadTask(taskId);
    const round = this.answers.get(roundId) ?? new Map<string, StoredAnswer>();
    const details: AgentScore[] = [];
    for (const agent of agents) {
      const a = round.get(agent);
      const chainHash = onChainHashes ? onChainHashes[agent] ?? null : undefined;
      if (!a || a.taskId !== taskId || (chainHash !== undefined && chainHash !== a.answerHash)) {
        details.push({ agent, score: 0, answerHash: a?.answerHash ?? null, run: null });
        continue;
      }
      const run = await runTests(normalizeCode(a.answer), task.function, task.tests, this.sandbox);
      details.push({ agent, score: run.passed, answerHash: a.answerHash, run });
    }
    const scores: Array<[string, number]> = details.map((d) => [d.agent, d.score]);
    const message = settlementMessage(roundId, task.tests.length, scores);
    const report: ScoreReport = {
      roundId,
      taskId,
      testsHash: task.testsHash,
      totalTests: task.tests.length,
      scores,
      details,
      message,
      signatures: this.secretKeys.map((k) => signMessage(k, message)),
      publicKeys: this.publicKeys,
    };
    this.reports.set(roundId, report);
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
      answers: [...this.answers].map(([id, m]) => [id, [...m.values()]]),
      reports: [...this.reports],
    };
    fs.writeFileSync(f, JSON.stringify(state, null, 2));
  }

  private load(): void {
    const f = this.file();
    if (!f || !fs.existsSync(f)) return;
    const state = JSON.parse(fs.readFileSync(f, "utf8")) as {
      answers: Array<[number, StoredAnswer[]]>;
      reports: Array<[number, ScoreReport]>;
    };
    for (const [id, list] of state.answers) this.answers.set(id, new Map(list.map((a) => [a.agent, a])));
    for (const [id, r] of state.reports) this.reports.set(id, r);
  }
}
