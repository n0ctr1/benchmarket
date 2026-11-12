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

const GAS = teraToGas("100");

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

  private async call<T>(signer: string, methodName: string, args: Record<string, unknown>, deposit: bigint = 0n): Promise<T> {
    return (await this.account(signer).callFunction({
      contractId: this.contractId,
      methodName,
      args,
      deposit,
      gas: GAS,
    })) as T;
  }

  private async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.provider.callFunction({ contractId: this.contractId, method, args })) as T;
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
    return this.call<void>(caller, "settle", { round_id: roundId, total_tests: totalTests, scores, signatures });
  }

  claim(caller: string, roundId: number) {
    return this.call<string>(caller, "claim", { round_id: roundId });
  }

  // ----- views -----

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

  getConfig() {
    return this.view<Record<string, unknown>>("get_config", {});
  }
}
