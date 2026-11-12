declare const __LEAGUE__: string;
declare const __RPC__: string;

export const LEAGUE = __LEAGUE__;
export const RPC = __RPC__;
export const EXPLORER = "https://testnet.nearblocks.io";

export type Status = "Open" | "Locked" | "Settled" | "Cancelled";

export interface Entry {
  agent: string;
  builder: string;
  league: "Open" | "Market";
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

export interface Round {
  id: number;
  manager: string;
  skill: string;
  task_ref: string;
  tests_hash: string;
  bet_deadline_ms: number;
  max_agents: number;
  bounty: string;
  status: Status;
  entries: Entry[];
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

export interface Rating {
  agent: string;
  skill: string;
  rating: number;
  rounds: number;
  wins: number;
  provisional: boolean;
  last_round: number;
}

export interface Bettor {
  account: string;
  staked: string;
  returned: string;
  pnl: string;
  bets: number;
  wins: number;
}

let rpcId = 0;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error?.data ?? j.error?.message ?? "rpc error");
  return j.result as T;
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
  view<Array<{ agent: string; amount: string }>>("get_position", { round_id: roundId, account });

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
  pattern: number;
  hue: number;
  face_code: string;
  motto: string;
  config_hash: string;
  proof: string;
  issuer: string;
  issued_at_ms: number;
}

export const getIdentities = () => view<Identity[]>("get_identities", { limit: 100 }).catch(() => [] as Identity[]);
