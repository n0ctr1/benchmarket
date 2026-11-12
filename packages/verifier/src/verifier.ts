import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  checkCompletion,
  clientKey,
  completionContent,
  modelX25519,
  openField,
  openWithEphemeral,
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
import { FRESH_TESTS, generateTests } from "./families.js";

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
  /**
   * A confidential exchange (NEAR AI end-to-end encryption): the enclave key it was sealed to and
   * the one-time keys that open exactly this exchange, revealed by the client to the verifier.
   */
  sealed?: SealedKeys;
  /** Free-form evidence from the runtime, e.g. a NEAR AI Cloud completion signature. */
  meta?: Record<string, unknown>;
}

export interface SealedKeys {
  /** The model enclave's ed25519 key (hex) the request fields were encrypted to. */
  modelPub: string;
  /** Ephemeral secret (hex) of each request message, in order. */
  fieldSecrets: string[];
  /** Seed of the one-time client key the response was encrypted to. */
  clientSeed: string;
}

/** Opens a sealed exchange into its plaintext request and response bodies. */
export function openSealed(request: string, response: string, keys: SealedKeys): { request: string; response: string } {
  const req = JSON.parse(request) as { messages?: Array<{ role: string; content: string }> };
  const recipient = modelX25519(keys.modelPub);
  const messages = (req.messages ?? []).map((m, i) => ({ ...m, content: openWithEphemeral(keys.fieldSecrets[i], recipient, m.content) }));
  const res = JSON.parse(response) as { choices?: Array<{ message?: { content?: string } }> };
  const me = clientKey(hexBytes(keys.clientSeed));
  for (const ch of res.choices ?? []) {
    if (ch.message?.content) ch.message.content = openField(me.x25519Secret, ch.message.content);
  }
  return { request: JSON.stringify({ ...req, messages }), response: JSON.stringify(res) };
}

function hexBytes(h: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
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
  /** For a family task: the seed and the code that turn it into `rawTests`. */
  family?: { seed: string; count: number; generator: string; reference: string; familyHash: string };
  /** Set for confidential work: answers and tests are not published. */
  withheld?: boolean;
}

/** Fresh tests generated for a round or job before it exists, bound to it once created. */
interface PreparedTests {
  taskId: string;
  seed: string;
  raw: string;
  hash: string;
}

/** The code to run for one entrant, or why there is none. */
export function answerCode(entry: ChainEntry, stored: StoredAnswer | undefined, tag: string): { code: string | null; check: string | null } {
  if (!stored) return { code: null, check: entry.answer_hash ? "answer committed on chain but never delivered" : "no answer" };
  if (entry.answer_hash !== stored.answerHash) return { code: null, check: "delivered answer does not match the hash on chain" };
  if (entry.attested) {
    if (!stored.request) return { code: null, check: "attested answer without its request" };
    let exchange = { request: stored.request, response: stored.answer };
    let requestHash = entry.request_hash;
    if (stored.sealed) {
      // The signature covers the encrypted bodies; check that hash, then read the plaintext.
      if (requestHash && sha256Tagged(stored.request).slice(7) !== requestHash) return { code: null, check: "request does not match the signed request hash" };
      try {
        exchange = openSealed(stored.request, stored.answer, stored.sealed);
      } catch (e) {
        return { code: null, check: `the revealed keys do not open the exchange: ${e instanceof Error ? e.message : e}` };
      }
      requestHash = null;
    }
    const c = checkCompletion(exchange, { requestHash, model: entry.model, configHash: entry.config_hash ?? "", config: stored.config, tag });
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
  private pending = new Map<string, PreparedTests>();
  private bound = new Map<string, PreparedTests>();
  /** Rounds or jobs whose task, tests and answers stay private: only scores and hashes are published. */
  private private = new Set<string>();

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
    extra: { request?: string; config?: PublicConfig; kind?: Kind; sealed?: SealedKeys } = {},
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
      ...(extra.sealed ? { sealed: extra.sealed } : {}),
      meta,
    };
    round.set(agent, stored);
    this.answers.set(k, round);
    this.save();
    return stored;
  }

  /**
   * Generates fresh hidden tests for a family task from a new secret seed and returns their hash,
   * to be committed on chain. The seed stays secret until the report is published.
   */
  async prepareTests(taskId: string): Promise<string> {
    const seed = randomBytes(32).toString("hex");
    const fresh = await generateTests(loadTask(taskId), seed);
    this.pending.set(fresh.hash, { taskId, seed, raw: fresh.raw, hash: fresh.hash });
    this.save();
    return fresh.hash;
  }

  /**
   * The client's own hidden tests for a job, handed to the verifier privately. Accepted only if
   * they hash to what the job committed on chain.
   */
  provideTests(kind: Kind, id: number, raw: string, committedHash: string, taskId: string): void {
    if (sha256Tagged(raw) !== committedHash) throw new Error("tests do not match the hash committed on chain");
    this.bound.set(key(kind, id), { taskId, seed: "", raw, hash: committedHash });
    this.private.add(key(kind, id));
    this.save();
  }

  /** Binds prepared tests to the round (or job) that committed their hash. */
  bindTests(kind: Kind, id: number, hash: string): void {
    const p = this.pending.get(hash);
    if (!p) throw new Error(`no prepared tests with hash ${hash}`);
    this.pending.delete(hash);
    this.bound.set(key(kind, id), p);
    this.save();
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
    if (this.private.has(key(kind, id))) {
      // Confidential: the signed scores only. The client may reveal the rest to arbiters.
      return { report, answers: [], function: "", rawTests: "", withheld: true };
    }
    const task = loadTask(report.taskId);
    const fresh = this.bound.get(key(kind, id));
    return {
      report,
      answers: [...(this.answers.get(key(kind, id))?.values() ?? [])],
      function: task.function,
      rawTests: fresh ? fresh.raw : task.rawTests,
      ...(fresh && task.generator
        ? { family: { seed: fresh.seed, count: FRESH_TESTS, generator: task.generator, reference: fs.readFileSync(task.referencePath, "utf8"), familyHash: task.familyHash! } }
        : {}),
    };
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
    const fresh = this.bound.get(key(kind, id));
    const tests = fresh ? (JSON.parse(fresh.raw) as TestCase[]) : task.tests;
    const answers = this.answers.get(key(kind, id)) ?? new Map<string, StoredAnswer>();
    const details = await scoreAnswers(task.function, tests, entries, answers, roundTag(kind, id), this.sandbox);
    const scores: Array<[string, number]> = details.map((d) => [d.agent, d.score]);
    const { message, signatures } = signScores(this.secretKeys, kind === "round" ? DOMAINS.round : DOMAINS.job, id, tests.length, scores);
    const report: ScoreReport = {
      kind,
      roundId: id,
      taskId,
      testsHash: fresh ? fresh.hash : task.testsHash,
      totalTests: tests.length,
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
      pending: [...this.pending],
      bound: [...this.bound],
      private: [...this.private],
    };
    fs.writeFileSync(f, JSON.stringify(state, null, 2));
  }

  private load(): void {
    const f = this.file();
    if (!f || !fs.existsSync(f)) return;
    const state = JSON.parse(fs.readFileSync(f, "utf8")) as {
      answers: Array<[number | string, StoredAnswer[]]>;
      reports: Array<[number | string, ScoreReport]>;
      pending?: Array<[string, PreparedTests]>;
      bound?: Array<[string, PreparedTests]>;
      private?: string[];
    };
    // Version 1 keyed rounds by number.
    const k = (id: number | string) => (typeof id === "number" ? key("round", id) : id);
    for (const [id, list] of state.answers) this.answers.set(k(id), new Map(list.map((a) => [a.agent, a])));
    for (const [id, r] of state.reports) this.reports.set(k(id), { ...r, kind: r.kind ?? "round" });
    for (const [h, p] of state.pending ?? []) this.pending.set(h, p);
    for (const [id, p] of state.bound ?? []) this.bound.set(id, p);
    for (const id of state.private ?? []) this.private.add(id);
  }
}
