/**
 * An Agent League competitor that runs on its own: its own NEAR account and key, its own
 * public config, its own NEAR AI Cloud key. It talks only to the league contract and to the
 * verifier's public HTTP API, the same interfaces the league's own agents use.
 *
 * Flow for a round: register with a bond, wait for the lock, fetch the round's prompt from the
 * verifier, ask the model, commit the response hash on chain together with NEAR AI's signature
 * over it, then deliver the exact request and response to the verifier, which accepts them only
 * if they hash to what is on chain.
 */
import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import {
  conflictPrompt,
  configHash,
  parseIdentityReply,
  sha256Tagged,
  viewCall,
  zeroPrompt,
  type PublicConfig,
} from "@agent-league/shared";

export interface AgentEnv {
  account: string;
  privateKey: string;
  contract: string;
  rpcUrl: string;
  verifierUrl: string;
  nearAiKey?: string;
  nearAiUrl: string;
  /** Bond posted at registration, yoctoNEAR; returned if the agent answers. */
  bond: bigint;
}

export interface Completion {
  content: string;
  request: string;
  response: string;
  signature: { text: string; signature: string; signing_address: string; signature_kind?: string } | null;
}

/** Produces an answer for a prompt. The default asks the configured model on NEAR AI Cloud. */
export type Brain = (system: string, prompt: string) => Promise<Completion>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function nearAiBrain(model: string, apiKey: string, baseUrl: string): Brain {
  // Canonical model ids and uncompressed bodies: models NEAR AI hosts in a TEE then sign from
  // their own enclave, over exactly the bytes we keep.
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "x-no-aliasing": "true", "Accept-Encoding": "identity" };
  return async (system, prompt) => {
    const request = JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 32000 });
    const res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: request, signal: AbortSignal.timeout(300_000) });
    const response = await res.text();
    if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${response.slice(0, 200)}`);
    const j = JSON.parse(response);
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("empty completion");
    let signature: Completion["signature"] = null;
    for (let i = 0; i < 4 && !signature; i++) {
      await sleep(1500 * (i + 1));
      const s = await fetch(`${baseUrl}/signature/${encodeURIComponent(j.id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers }).catch(() => null);
      if (s?.ok) signature = await s.json();
    }
    return { content, request, response, signature };
  };
}

export class LeagueAgent {
  private readonly account: Account;

  constructor(
    readonly env: AgentEnv,
    readonly config: PublicConfig,
    readonly brain: Brain,
    private readonly say: (line: string) => void = console.log,
  ) {
    this.account = new Account(env.account, new JsonRpcProvider({ url: env.rpcUrl }), env.privateKey as KeyPairString);
  }

  get configHash(): string {
    return configHash(this.config);
  }

  view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return viewCall<T>(this.env.rpcUrl, this.env.contract, method, args);
  }

  protected call<T>(methodName: string, args: Record<string, unknown>, deposit = 0n, tgas = 50): Promise<T> {
    return this.account.callFunction({ contractId: this.env.contract, methodName, args, deposit, gas: teraToGas(tgas) }) as Promise<T>;
  }

  /** Issues the passport: the model describes itself from the zero prompt; the contract derives the face. */
  async passport(motto?: string): Promise<number> {
    const have = await this.view<{ number: number } | null>("get_identity", { agent: this.env.account });
    if (have) return have.number;
    let prompt = zeroPrompt();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const c = await this.brain(this.config.systemPrompt, prompt);
      const choice = parseIdentityReply(c.content);
      const check = await this.view<{ ok: boolean; reason: string | null }>("check_face", { seed: choice.seed });
      if (!check.ok) {
        this.say(`face rejected: ${check.reason}`);
        prompt = `${zeroPrompt()}\n\n${conflictPrompt(check.reason ?? "rejected")}`;
        continue;
      }
      const proof = c.signature ? `nearai:${c.signature.signature_kind ?? "signed"}:${c.signature.text.slice(0, 40)}` : "self";
      const n = await this.call<number>("register_identity", { agent: this.env.account, seed: choice.seed, motto: motto ?? choice.motto, config_hash: this.configHash, proof }, 10n ** 24n / 50n);
      this.say(`passport #${n}: "${choice.motto}"`);
      return Number(n);
    }
    throw new Error("no unique face after 5 attempts");
  }

  /** Enters a round, waits for the lock, answers. Returns the committed answer hash. */
  async playRound(roundId: number, opts: { pollMs?: number } = {}): Promise<string> {
    const poll = opts.pollMs ?? 5000;
    let round = await this.view<RoundLike>("get_round", { round_id: roundId });
    if (!round) throw new Error(`no round ${roundId}`);
    if (!round.entries.some((e) => e.agent === this.env.account)) {
      if (round.status !== "Open") throw new Error(`round ${roundId} is ${round.status}; registration is closed`);
      await this.call("register_agent", { round_id: roundId, agent: this.env.account, league: "Open", config_hash: this.configHash }, this.env.bond, 30);
      this.say(`registered in round ${roundId} with a bond`);
    }
    while (round.status === "Open" || round.status === "Trading") {
      await sleep(poll);
      round = (await this.view<RoundLike>("get_round", { round_id: roundId }))!;
    }
    if (round.status !== "Locked") throw new Error(`round ${roundId} is ${round.status}`);
    return this.answer("rounds", roundId, round.attested, (hash, attestation) => this.call("submit_answer", { round_id: roundId, answer_hash: hash, attestation }));
  }

  /** Takes an open job this agent qualifies for and answers it. */
  async playJob(jobId: number): Promise<string> {
    const job = await this.view<{ status: string; attested: boolean; agent: string | null } | null>("get_job", { job_id: jobId });
    if (!job) throw new Error(`no job ${jobId}`);
    if (job.status === "Open") await this.call("take_job", { job_id: jobId }, 0n, 30);
    else if (job.agent !== this.env.account) throw new Error(`job ${jobId} is ${job.status}`);
    return this.answer("jobs", jobId, job.attested, (hash, attestation) => this.call("submit_job", { job_id: jobId, answer_hash: hash, attestation }));
  }

  /** Claims winnings and the bond of a finished round. Returns yoctoNEAR paid. */
  async claim(roundId: number): Promise<bigint> {
    const got = await this.call<string>("claim", { round_id: roundId }, 0n, 30);
    this.say(`claimed ${(Number(BigInt(got ?? "0")) / 1e24).toFixed(3)} NEAR from round ${roundId}`);
    return BigInt(got ?? "0");
  }

  /** Finished rounds where this account still has something to claim. */
  async claimable(): Promise<number[]> {
    const out: number[] = [];
    for (const r of await this.view<RoundLike[]>("get_rounds", { limit: 20 })) {
      if (r.status !== "Settled" && r.status !== "Cancelled") continue;
      const pos = await this.view<Array<{ amount: string; bond: string }>>("get_position", { round_id: r.id, account: this.env.account });
      if (pos.some((p) => BigInt(p.amount) > 0n || BigInt(p.bond ?? "0") > 0n)) out.push(r.id);
    }
    return out;
  }

  /** Open rounds and jobs this agent could enter right now, and rounds it was entered in
   *  (by a scout, for a brief's tryout) that still wait for its answer. */
  async open(): Promise<{ rounds: number[]; jobs: number[]; entered: number[] }> {
    const all = await this.view<RoundLike[]>("get_rounds", { limit: 20 });
    const rounds = all.filter((r) => r.status === "Open" && !r.entries.some((e) => e.agent === this.env.account)).map((r) => r.id);
    const entered = all
      .filter((r) => (r.status === "Trading" || r.status === "Locked") && r.entries.some((e) => e.agent === this.env.account && !e.answer_hash))
      .map((r) => r.id);
    const jobs: number[] = [];
    for (const j of await this.view<Array<{ id: number; skill: string; min_rating: number; min_rounds: number }>>("get_jobs", { status: "Open", limit: 20 })) {
      if (await this.view<boolean>("is_qualified", { agent: this.env.account, skill: j.skill, min_rating: j.min_rating, min_rounds: j.min_rounds, min_attested: null })) jobs.push(j.id);
    }
    // Jobs from a brief's accepted offer are already taken by this agent.
    for (const j of await this.view<Array<{ id: number; agent: string | null }>>("get_jobs", { status: "Taken", limit: 20 })) {
      if (j.agent === this.env.account) jobs.push(j.id);
    }
    return { rounds, jobs, entered };
  }

  private async answer(kind: "rounds" | "jobs", id: number, attested: boolean, commit: (hash: string, attestation: unknown) => Promise<unknown>): Promise<string> {
    const t = await this.http<{ prompt: string; tag: string }>(`/${kind}/${id}/task`);
    const c = await this.brain(this.config.systemPrompt, t.prompt);
    if (attested && !c.signature) throw new Error("this round needs an attested answer and the cloud returned no signature");
    // With a signature the committed hash is the response hash NEAR AI signed; otherwise the plain answer.
    const body = c.signature ? c.response : c.content;
    const hash = sha256Tagged(body);
    const attestation = c.signature ? { text: c.signature.text, signature: c.signature.signature, signer: c.signature.signing_address } : null;
    await commit(hash, attestation);
    await this.http(`/${kind}/${id}/answers`, { agent: this.env.account, answer: body, ...(c.signature ? { request: c.request } : {}), config: this.config });
    this.say(`answered ${kind.slice(0, -1)} ${id}${c.signature ? " (attested)" : ""}: ${hash.slice(0, 20)}...`);
    return hash;
  }

  private async http<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.env.verifierUrl}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) throw new Error(`verifier ${path}: ${j.error ?? res.status}`);
    return j as T;
  }
}

interface RoundLike {
  id: number;
  status: string;
  attested: boolean;
  entries: Array<{ agent: string; answer_hash?: string | null }>;
}
