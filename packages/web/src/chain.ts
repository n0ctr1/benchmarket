declare const __LEAGUE__: string;
declare const __RPC__: string;
declare const __NETWORK__: string;

export const LEAGUE = __LEAGUE__;
export const RPC = __RPC__;
export const EXPLORER = "https://testnet.nearblocks.io";

export type Status = "Open" | "Trading" | "Locked" | "Proposed" | "Disputed" | "Settled" | "Cancelled";

export interface Entry {
  agent: string;
  builder: string;
  league: "Open" | "Market";
  config_hash: string;
  bond: string;
  /** Shares sold on this agent (LMSR), or its pool (parimutuel rounds). */
  shares: string;
  odds_ppm: number;
  p_ppm: number;
  market_ppm: number;
  answer_hash: string | null;
  answered_at_ms: number | null;
  attested: boolean;
  model: string | null;
  score: number | null;
  rating_before: number;
  rating_delta: number;
  field_delta: number;
  task_delta: number;
}

export interface Round {
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
  status: Status;
  entries: Entry[];
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

export interface Rating {
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

export interface Bettor {
  account: string;
  staked: string;
  returned: string;
  pnl: string;
  bets: number;
  wins: number;
  skill_ppm: number;
  scored_rounds: number;
}

export interface Task {
  task_ref: string;
  skill: string;
  curated: boolean;
  rating: number;
  rounds: number;
  jobs: number;
  saturated: number;
  retired: boolean;
}

export interface Job {
  id: number;
  poster: string;
  task_ref: string;
  tests_hash: string;
  budget: string;
  min_rating: number;
  pass_ppm: number;
  status: "Open" | "Taken" | "Answered" | "Proposed" | "Disputed" | "Paid" | "Failed" | "Cancelled";
  agent: string | null;
  answer_attested: boolean;
  score: number | null;
  total_tests: number;
  rating_delta: number;
  created_at_ms: number;
}

export interface Brief {
  id: number;
  client: string;
  summary: string;
  category: string | null;
  confidential: boolean;
  task_ref: string | null;
  budget: string;
  scout_reward: string;
  tryout_bounty: string;
  tryout_subsidy: string;
  status: "Scouting" | "Tryout" | "Offered" | "Hired" | "Delivered" | "Failed" | "Declined" | "Cancelled";
  nominations: Array<{ scout: string; agent: string; task_ref: string; stake: string; payout: string }>;
  tryout_task: string | null;
  tryout_round: number | null;
  offered: string | null;
  job_id: number | null;
  created_at_ms: number;
}

export interface ScoutRecord {
  nominated: number;
  hired: number;
  delivered: number;
  failed: number;
  earned: string;
  slashed: string;
}

let rpcId = 0;

// Public RPCs are rate-limited per visitor; when the configured one refuses (network error, 429,
// 5xx) the page moves to the next and stays there.
const RPCS = [...new Set([RPC, ...(__NETWORK__ === "testnet" ? ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"] : ["https://rpc.mainnet.near.org", "https://free.rpc.fastnear.com"])])];
let rpcAt = 0;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  let lastError: unknown;
  for (let tries = 0; tries < RPCS.length; tries++) {
    const url = RPCS[rpcAt];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`rpc ${res.status}`);
      const j = await res.json();
      if (j.error) throw Object.assign(new Error(j.error?.data ?? j.error?.message ?? "rpc error"), { fromRpc: true });
      return j.result as T;
    } catch (e) {
      if ((e as { fromRpc?: boolean }).fromRpc) throw e;
      lastError = e;
      if (RPCS[rpcAt] === url) rpcAt = (rpcAt + 1) % RPCS.length;
    }
  }
  throw lastError;
}

/** View call with optimistic finality, so a fresh transaction shows up at once. */
export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: LEAGUE,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}

export async function blockHeight(): Promise<number> {
  const r = await rpc<{ header: { height: number } }>("block", { finality: "optimistic" });
  return r.header.height;
}

export const getRounds = (limit = 50) => view<Round[]>("get_rounds", { limit });
export const getLeaderboard = (skill: string) => view<Rating[]>("get_leaderboard", { skill });
export const getBettors = () => view<Bettor[]>("get_scouts", {});
export const getPosition = (roundId: number, account: string) =>
  view<Array<{ agent: string; amount: string; bond: string }>>("get_position", { round_id: roundId, account });
export const getTasks = () => view<Task[]>("get_tasks", { limit: 100 }).catch(() => [] as Task[]);
export const getBriefs = () => view<Brief[]>("get_briefs", { limit: 10 }).catch(() => [] as Brief[]);
export const getScoutRecord = (account: string) => view<ScoutRecord>("get_scout_record", { account }).catch(() => null);
export const getJobs = () => view<Job[]>("get_jobs", { limit: 20 }).catch(() => [] as Job[]);

/** A round counts as finished once its scores are final. */
export const isFinal = (r: Round) => r.status === "Settled" || r.status === "Cancelled";

/** LMSR prices from shares: softmax(q / b), as the contract computes them. */
export function lmsrPrices(shares: bigint[], liquidity: bigint): number[] {
  if (liquidity === 0n || shares.length === 0) return shares.map(() => 1 / Math.max(1, shares.length));
  const b = Number(liquidity);
  const x = shares.map((q) => Number(q) / b);
  const m = Math.max(...x);
  const e = x.map((v) => Math.exp(v - m));
  const sum = e.reduce((a, c) => a + c, 0);
  return e.map((v) => v / sum);
}

export const YOCTO = 10n ** 24n;

export function near(yocto: string | bigint, digits = 2): string {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scaled = (a * 10n ** BigInt(digits) + YOCTO / 2n) / YOCTO;
  const s = scaled.toString().padStart(digits + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

export const short = (account: string) => account.split(".")[0];

export interface Identity {
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

export const getIdentities = () => view<Identity[]>("get_identities", { limit: 100 }).catch(() => [] as Identity[]);
