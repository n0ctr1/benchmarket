import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import { config } from "./config.js";
import { KeyStore } from "./keystore.js";

export type League = "Open" | "Market";

export interface EntryView {
  agent: string;
  builder: string;
  league: League;
  config_hash: string;
  pool: string;
  odds_ppm: number;
  p_ppm: number;
  market_ppm: number;
  answer_hash: string | null;
  answered_at_ms: number | null;
  score: number | null;
  rating_before: number;
  rating_delta: number;
}

export interface RoundView {
  id: number;
  manager: string;
  skill: string;
  task_ref: string;
  tests_hash: string;
  bet_deadline_ms: number;
  max_agents: number;
  bounty: string;
  status: "Open" | "Locked" | "Settled" | "Cancelled";
  entries: EntryView[];
  total_pool: string;
  fee: string;
  net: string;
  payout_mode: "Pending" | "Winners" | "Refund";
  winner: string | null;
  total_tests: number;
  created_at_ms: number;
  locked_at_ms: number | null;
  settled_at_ms: number | null;
}

export interface RatingView {
  agent: string;
  skill: string;
  rating: number;
  rounds: number;
  wins: number;
  provisional: boolean;
  last_round: number;
}

export interface ScoutView {
  account: string;
  staked: string;
  returned: string;
  pnl: string;
  bets: number;
  wins: number;
}

export interface IdentityView {
  agent: string;
  number: number;
  seed: string;
  cells: number[];
  palette: [number, number, number];
  face_code: string;
  motto: string;
  config_hash: string;
  proof: string;
  issuer: string;
  issued_at_ms: number;
}

export interface FaceCheck {
  ok: boolean;
  reason: string | null;
  cells: number[];
  palette: [number, number, number];
  nearest: string | null;
  distance: number | null;
}

export const IDENTITY_DEPOSIT = 10n ** 24n / 50n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries a request the RPC rejected with 429 (rate limit). A rejected request never reached
 * the network, so retrying a transaction cannot execute it twice.
 */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const limited = /429|Rate limits exceeded/i.test(msg) || (e as { cause?: unknown })?.cause === 429;
      if (!limited || attempt >= 6) throw e;
      const wait = 1500 * 2 ** attempt;
      console.warn(`  rpc rate limit on ${what}, retrying in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }
  }
}

const GAS = teraToGas("30");
const HEAVY_GAS = teraToGas("150");

/** Thin typed wrapper around the league contract. */
export class LeagueChain {
  readonly provider: JsonRpcProvider;
  readonly keys: KeyStore;
  private accounts = new Map<string, Account>();

  constructor(readonly contractId = config.leagueAccount) {
    this.provider = new JsonRpcProvider({ url: config.rpcUrl });
    this.keys = new KeyStore(config.network);
  }

  account(id: string): Account {
    let a = this.accounts.get(id);
    if (!a) {
      const override = id === config.leagueAccount ? config.leaguePrivateKey : undefined;
      a = new Account(id, this.provider, this.keys.get(id, override) as KeyPairString);
      this.accounts.set(id, a);
    }
    return a;
  }

  private async call<T>(signer: string, methodName: string, args: Record<string, unknown>, deposit: bigint = 0n, gas = GAS): Promise<T> {
    return (await withRetry(methodName, () =>
      this.account(signer).callFunction({
        contractId: this.contractId,
        methodName,
        args,
        deposit,
        gas,
      }),
    )) as T;
  }

  private async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    // Optimistic finality: read our own writes right after the transaction executed.
    return (await withRetry(method, () =>
      this.provider.callFunction({ contractId: this.contractId, method, args, blockQuery: { finality: "optimistic" } }),
    )) as T;
  }

  // ----- calls -----

  createRound(manager: string, p: { skill: string; taskRef: string; testsHash: string; betDeadlineMs: number; maxAgents: number; bounty: bigint }) {
    return this.call<number>(manager, "create_round", {
      skill: p.skill,
      task_ref: p.taskRef,
      tests_hash: p.testsHash,
      bet_deadline_ms: p.betDeadlineMs,
      max_agents: p.maxAgents,
    }, p.bounty);
  }

  registerAgent(builder: string, roundId: number, agent: string, league: League, configHash: string, stake: bigint) {
    return this.call<void>(builder, "register_agent", { round_id: roundId, agent, league, config_hash: configHash }, stake);
  }

  seed(seeder: string, roundId: number, amount: bigint) {
    return this.call<void>(seeder, "seed", { round_id: roundId }, amount);
  }

  placeBet(bettor: string, roundId: number, agent: string, amount: bigint) {
    return this.call<void>(bettor, "place_bet", { round_id: roundId, agent }, amount);
  }

  lockRound(caller: string, roundId: number) {
    return this.call<void>(caller, "lock_round", { round_id: roundId });
  }

  submitAnswer(agent: string, roundId: number, answerHash: string) {
    return this.call<void>(agent, "submit_answer", { round_id: roundId, answer_hash: answerHash });
  }

  settle(caller: string, roundId: number, totalTests: number, scores: Array<[string, number]>, signatures: string[]) {
    return this.call<void>(caller, "settle", { round_id: roundId, total_tests: totalTests, scores, signatures }, 0n, HEAVY_GAS);
  }

  cancelRound(caller: string, roundId: number) {
    return this.call<void>(caller, "cancel_round", { round_id: roundId });
  }

  claim(caller: string, roundId: number) {
    return this.call<string>(caller, "claim", { round_id: roundId });
  }

  registerIdentity(signer: string, agent: string, seed: string, motto: string, configHash: string, proof: string) {
    return this.call<number>(signer, "register_identity", { agent, seed, motto, config_hash: configHash, proof }, IDENTITY_DEPOSIT, teraToGas("50"));
  }

  // ----- views -----

  getIdentity(agent: string) {
    return this.view<IdentityView | null>("get_identity", { agent });
  }

  getIdentities() {
    return this.view<IdentityView[]>("get_identities", { limit: 100 });
  }

  faceCount() {
    return this.view<number>("face_count", {});
  }

  checkFace(seed: string) {
    return this.view<FaceCheck>("check_face", { seed });
  }

  getRound(roundId: number) {
    return this.view<RoundView | null>("get_round", { round_id: roundId });
  }

  getRounds(limit = 10) {
    return this.view<RoundView[]>("get_rounds", { limit });
  }

  getRating(agent: string, skill: string) {
    return this.view<RatingView>("get_rating", { agent, skill });
  }

  getLeaderboard(skill: string) {
    return this.view<RatingView[]>("get_leaderboard", { skill });
  }

  getScouts() {
    return this.view<ScoutView[]>("get_scouts", {});
  }

  getPosition(roundId: number, account: string) {
    return this.view<Array<{ agent: string; amount: string }>>("get_position", { round_id: roundId, account });
  }

  /** Available (spendable) balance of an account, yoctoNEAR. */
  async available(id: string): Promise<bigint> {
    const s = await withRetry("get_state", () => this.account(id).getState());
    return BigInt(s.balance.available);
  }

  /** Tops `to` up from `from` so it has at least `min` available. Returns the amount sent. */
  async topUp(from: string, to: string, min: bigint): Promise<bigint> {
    const have = await this.available(to);
    if (have >= min) return 0n;
    const amount = min - have;
    await withRetry("transfer", () => this.account(from).transfer({ receiverId: to, amount }));
    return amount;
  }

  getConfig() {
    return this.view<Record<string, unknown>>("get_config", {});
  }
}
