import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import { config } from "./config.js";
import { KeyStore } from "./keystore.js";

export type League = "Open" | "Market";

export interface EntryView {
  agent: string;
  builder: string;
  league: League;
  config_hash: string;
  bond: string;
  shares: string;
  /** Current market price, ppm. */
  odds_ppm: number;
  p_ppm: number;
  /** Price at lock, ppm. */
  market_ppm: number;
  answer_hash: string | null;
  answered_at_ms: number | null;
  attested: boolean;
  model: string | null;
  request_hash: string | null;
  score: number | null;
  rating_before: number;
  rating_delta: number;
  field_delta: number;
  task_delta: number;
}

export type RoundStatus = "Open" | "Trading" | "Locked" | "Proposed" | "Disputed" | "Settled" | "Cancelled";

export interface RoundView {
  id: number;
  market: "lmsr" | "parimutuel";
  manager: string;
  skill: string;
  task_ref: string;
  tests_hash: string;
  bet_deadline_ms: number;
  answer_deadline_ms: number;
  max_agents: number;
  attested: boolean;
  rated: boolean;
  bounty: string;
  status: RoundStatus;
  entries: EntryView[];
  liquidity: string;
  subsidy: string;
  total_pool: string;
  fee: string;
  bettors: number;
  payout_mode: "Pending" | "Winners" | "Refund";
  winners: string[];
  winner: string | null;
  total_tests: number;
  task_rating_before: number;
  task_delta: number;
  proposal: { total_tests: number; scores: Array<[string, number]>; signers: string[]; proposed_at_ms: number; dispute_until_ms: number } | null;
  dispute: { by: string; bond: string; at_ms: number; overturned: boolean | null } | null;
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
  attested: number;
  jobs_done: number;
  jobs_failed: number;
}

export interface ScoutView {
  account: string;
  staked: string;
  returned: string;
  pnl: string;
  bets: number;
  wins: number;
  skill_ppm: number;
  scored_rounds: number;
}

export interface TaskView {
  task_ref: string;
  skill: string;
  curated: boolean;
  tests_hash: string;
  rating: number;
  rounds: number;
  jobs: number;
  saturated: number;
  retired: boolean;
}

export type JobStatus = "Open" | "Taken" | "Answered" | "Proposed" | "Disputed" | "Paid" | "Failed" | "Cancelled";

export interface JobView {
  id: number;
  poster: string;
  skill: string;
  task_ref: string;
  tests_hash: string;
  budget: string;
  min_rating: number;
  min_rounds: number;
  pass_ppm: number;
  attested: boolean;
  rated: boolean;
  work_window_ms: number;
  status: JobStatus;
  agent: string | null;
  deadline_ms: number;
  answer_hash: string | null;
  answer_attested: boolean;
  model: string | null;
  request_hash: string | null;
  score: number | null;
  total_tests: number;
  dispute_until_ms: number | null;
  disputed_by: string | null;
  rating_delta: number;
  created_at_ms: number;
  closed_at_ms: number | null;
}

export interface Params {
  fee_bps: number;
  min_pool: string;
  min_builder_stake: string;
  min_bet: string;
  k_field: number;
  k_task: number;
  answer_window_ms: number;
  dispute_window_ms: number;
  resolve_timeout_ms: number;
  settle_timeout_ms: number;
  dispute_bond: string;
  min_verifier_stake: string;
  unstake_delay_ms: number;
  max_bettors: number;
}

export interface ConfigView {
  owner: string;
  verifiers: string[];
  threshold: number;
  arbiters: string[];
  arbiter_threshold: number;
  inference_signers: string[];
  params: Params;
  next_round_id: number;
  first_lmsr_round: number;
  next_job_id: number;
}

export type BriefStatus = "Scouting" | "Tryout" | "Offered" | "Hired" | "Delivered" | "Failed" | "Declined" | "Cancelled";

export interface BriefView {
  id: number;
  client: string;
  skill: string;
  summary: string;
  task_ref: string;
  tests_hash: string;
  pass_ppm: number;
  attested: boolean;
  budget: string;
  scout_reward: string;
  tryout_bounty: string;
  tryout_subsidy: string;
  min_stake: string;
  nominate_until_ms: number;
  status: BriefStatus;
  nominations: Array<{ scout: string; agent: string; task_ref: string; stake: string; payout: string }>;
  tryout_task: string | null;
  tryout_round: number | null;
  offered: string | null;
  offer_until_ms: number;
  job_id: number | null;
  created_at_ms: number;
  closed_at_ms: number | null;
}

export interface ScoutRecordView {
  nominated: number;
  hired: number;
  delivered: number;
  failed: number;
  earned: string;
  slashed: string;
}

/** NEAR AI Cloud signature, as the contract takes it. */
export interface AttestationArg {
  text: string;
  signature: string;
  signer: string;
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

  createRound(manager: string, p: { skill: string; taskRef: string; testsHash: string; betDeadlineMs: number; maxAgents: number; bounty: bigint; attested?: boolean }) {
    return this.call<number>(manager, "create_round", {
      skill: p.skill,
      task_ref: p.taskRef,
      tests_hash: p.testsHash,
      bet_deadline_ms: p.betDeadlineMs,
      max_agents: p.maxAgents,
      attested: p.attested ?? false,
    }, p.bounty);
  }

  registerAgent(builder: string, roundId: number, agent: string, league: League, configHash: string, bond: bigint) {
    return this.call<void>(builder, "register_agent", { round_id: roundId, agent, league, config_hash: configHash }, bond);
  }

  openMarket(manager: string, roundId: number, subsidy: bigint) {
    return this.call<void>(manager, "open_market", { round_id: roundId }, subsidy);
  }

  buy(bettor: string, roundId: number, agent: string, amount: bigint, minShares?: bigint) {
    return this.call<string>(bettor, "buy", { round_id: roundId, agent, min_shares: minShares?.toString() ?? null }, amount);
  }

  lockRound(caller: string, roundId: number) {
    return this.call<void>(caller, "lock_round", { round_id: roundId });
  }

  submitAnswer(agent: string, roundId: number, answerHash: string, attestation?: AttestationArg) {
    return this.call<void>(agent, "submit_answer", { round_id: roundId, answer_hash: answerHash, attestation: attestation ?? null }, 0n, teraToGas("50"));
  }

  settle(caller: string, roundId: number, totalTests: number, scores: Array<[string, number]>, signatures: string[]) {
    return this.call<void>(caller, "settle", { round_id: roundId, total_tests: totalTests, scores, signatures }, 0n, HEAVY_GAS);
  }

  finalize(caller: string, roundId: number) {
    return this.call<void>(caller, "finalize", { round_id: roundId }, 0n, HEAVY_GAS);
  }

  dispute(caller: string, roundId: number, bond: bigint) {
    return this.call<void>(caller, "dispute", { round_id: roundId }, bond);
  }

  resolveDispute(caller: string, roundId: number, totalTests: number, scores: Array<[string, number]>, signatures: string[]) {
    return this.call<void>(caller, "resolve_dispute", { round_id: roundId, total_tests: totalTests, scores, signatures }, 0n, HEAVY_GAS);
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

  // ----- owner and verifiers -----

  addTask(owner: string, taskRef: string, skill: string, testsHash: string) {
    return this.call<void>(owner, "add_task", { task_ref: taskRef, skill, tests_hash: testsHash });
  }

  setParams(owner: string, params: Params) {
    return this.call<void>(owner, "set_params", { params });
  }

  setArbiters(owner: string, arbiters: string[], threshold: number) {
    return this.call<void>(owner, "set_arbiters", { arbiters, threshold });
  }

  setInferenceSigners(owner: string, signers: string[]) {
    return this.call<void>(owner, "set_inference_signers", { signers });
  }

  stakeVerifier(staker: string, publicKey: string, amount: bigint) {
    return this.call<void>(staker, "stake_verifier", { public_key: publicKey }, amount);
  }

  // ----- jobs -----

  postJob(poster: string, p: { skill: string; taskRef: string; testsHash: string; minRating: number; minRounds?: number; passPpm?: number; workWindowMs: number; attested?: boolean; budget: bigint }) {
    return this.call<number>(poster, "post_job", {
      skill: p.skill,
      task_ref: p.taskRef,
      tests_hash: p.testsHash,
      min_rating: p.minRating,
      min_rounds: p.minRounds ?? null,
      pass_ppm: p.passPpm ?? null,
      work_window_ms: p.workWindowMs,
      attested: p.attested ?? false,
    }, p.budget);
  }

  takeJob(agent: string, jobId: number) {
    return this.call<void>(agent, "take_job", { job_id: jobId });
  }

  submitJob(agent: string, jobId: number, answerHash: string, attestation?: AttestationArg) {
    return this.call<void>(agent, "submit_job", { job_id: jobId, answer_hash: answerHash, attestation: attestation ?? null }, 0n, teraToGas("50"));
  }

  settleJob(caller: string, jobId: number, totalTests: number, score: number, signatures: string[]) {
    return this.call<void>(caller, "settle_job", { job_id: jobId, total_tests: totalTests, score, signatures }, 0n, HEAVY_GAS);
  }

  finalizeJob(caller: string, jobId: number) {
    return this.call<void>(caller, "finalize_job", { job_id: jobId }, 0n, HEAVY_GAS);
  }

  // ----- briefs -----

  postBrief(client: string, p: { skill: string; summary: string; taskRef: string; testsHash: string; budget: bigint; scoutReward: bigint; tryoutBounty: bigint; tryoutSubsidy: bigint; minStake: bigint; nominateWindowMs: number; tradeWindowMs: number; workWindowMs: number; passPpm?: number; attested?: boolean }) {
    const total = p.budget + p.scoutReward + p.tryoutBounty + p.tryoutSubsidy;
    return this.call<number>(client, "post_brief", {
      skill: p.skill,
      summary: p.summary,
      task_ref: p.taskRef,
      tests_hash: p.testsHash,
      budget: p.budget.toString(),
      scout_reward: p.scoutReward.toString(),
      tryout_bounty: p.tryoutBounty.toString(),
      tryout_subsidy: p.tryoutSubsidy.toString(),
      min_stake: p.minStake.toString(),
      nominate_window_ms: p.nominateWindowMs,
      trade_window_ms: p.tradeWindowMs,
      work_window_ms: p.workWindowMs,
      pass_ppm: p.passPpm ?? null,
      attested: p.attested ?? false,
      offer_window_ms: null,
    }, total);
  }

  nominate(scout: string, briefId: number, agent: string, taskRef: string, stake: bigint) {
    return this.call<void>(scout, "nominate", { brief_id: briefId, agent, task_ref: taskRef }, stake);
  }

  startTryout(caller: string, briefId: number) {
    return this.call<void>(caller, "start_tryout", { brief_id: briefId }, 0n, HEAVY_GAS);
  }

  offer(caller: string, briefId: number) {
    return this.call<void>(caller, "offer", { brief_id: briefId }, 0n, HEAVY_GAS);
  }

  acceptOffer(client: string, briefId: number) {
    return this.call<number>(client, "accept_offer", { brief_id: briefId }, 0n, HEAVY_GAS);
  }

  declineOffer(client: string, briefId: number) {
    return this.call<void>(client, "decline_offer", { brief_id: briefId }, 0n, HEAVY_GAS);
  }

  getBrief(briefId: number) {
    return this.view<BriefView | null>("get_brief", { brief_id: briefId });
  }

  getBriefs() {
    return this.view<BriefView[]>("get_briefs", { limit: 20 });
  }

  getScoutRecord(account: string) {
    return this.view<ScoutRecordView>("get_scout_record", { account });
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
    return this.view<Array<{ agent: string; amount: string; bond: string }>>("get_position", { round_id: roundId, account });
  }

  getTasks() {
    return this.view<TaskView[]>("get_tasks", { limit: 100 });
  }

  getJob(jobId: number) {
    return this.view<JobView | null>("get_job", { job_id: jobId });
  }

  getJobs(status?: JobStatus) {
    return this.view<JobView[]>("get_jobs", { status: status ?? null, limit: 50 });
  }

  isQualified(agent: string, skill: string, minRating: number, minRounds?: number) {
    return this.view<boolean>("is_qualified", { agent, skill, min_rating: minRating, min_rounds: minRounds ?? null, min_attested: null });
  }

  getVerifierStakes() {
    return this.view<Array<{ public_key: string; owner: string; amount: string; unlock_at_ms: number | null; active: boolean }>>("get_verifier_stakes", {});
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
    return this.view<ConfigView>("get_config", {});
  }
}
