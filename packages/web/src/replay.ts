import { getPosition, LEAGUE, lmsrPrices, short, type Round } from "./chain";
import type { RoundRecord } from "./offchain";

export type Phase = "market" | "locked" | "solving" | "scored" | "window" | "settled";

export interface Bet {
  bettor: string;
  agent: string;
  amount: bigint;
  /** Shares bought (LMSR) or the amount (parimutuel). */
  shares: bigint;
  reasoning?: string;
  kind?: string;
}

/** One frame of a round as it happened. */
export interface Frame {
  phase: Phase;
  label: string;
  /** Market win probability per agent account at this moment, 0..1. */
  odds: Record<string, number>;
  /** Money in the market at this moment (pool, or LMSR purchases), yoctoNEAR. */
  volume: bigint;
  /** Index into `bets` of the bet just placed, if any. */
  bet?: number;
  /** Agents that have submitted an answer by this frame. */
  answered: Set<string>;
  /** Chain time of the step, when known (used to pace the replay). */
  at?: number;
}

export interface Replay {
  bets: Bet[];
  frames: Frame[];
}

/**
 * Rebuilds the round step by step from on-chain positions (amounts or shares per account) and
 * the round log (order and reasoning of each scout's purchase). For LMSR rounds the prices
 * after each purchase are recomputed from the shares, exactly as the contract does.
 */
export async function buildReplay(round: Round, rec: RoundRecord | null): Promise<Replay> {
  const agents = round.entries.map((e) => e.agent);
  const lmsr = round.market === "lmsr";
  const b = BigInt(round.liquidity);

  const betEvents = (rec?.events ?? []).filter((e) => e.kind === "scout_bet");
  const scoutIds = [...new Set(betEvents.map((e) => e.data.scout as string))];
  const [agentPos, seedPos, scoutPos] = await Promise.all([
    lmsr ? Promise.resolve([] as Array<Array<{ agent: string; amount: string }>>) : Promise.all(agents.map((a) => getPosition(round.id, a).catch(() => []))),
    lmsr ? Promise.resolve([] as Array<{ agent: string; amount: string }>) : getPosition(round.id, LEAGUE).catch(() => []),
    Promise.all(scoutIds.map((s) => getPosition(round.id, s).catch(() => []))),
  ]);

  // `held` is the pool (parimutuel) or the shares sold (LMSR) per agent.
  const held: Record<string, bigint> = Object.fromEntries(agents.map((a) => [a, 0n]));
  let volume = 0n;
  const odds = (): Record<string, number> => {
    if (lmsr) {
      const p = lmsrPrices(agents.map((a) => held[a]), b);
      return Object.fromEntries(agents.map((a, i) => [a, p[i]]));
    }
    return Object.fromEntries(agents.map((a) => [a, share(held, a)]));
  };
  const frames: Frame[] = [];
  const snap = (f: Omit<Frame, "odds" | "volume" | "answered"> & { answered?: Set<string> }) =>
    frames.push({ ...f, odds: odds(), volume, answered: f.answered ?? new Set() });

  if (lmsr) {
    snap({ phase: "market", label: "Agents register and post bonds" });
    if (b > 0n) snap({ phase: "market", label: "Market maker funded: every agent starts at an equal price" });
  } else {
    agents.forEach((a, i) => {
      const own = agentPos[i].find((p) => p.agent === a);
      if (own) held[a] += BigInt(own.amount);
    });
    volume = Object.values(held).reduce((x, y) => x + y, 0n);
    snap({ phase: "market", label: "Agents register and stake on themselves" });
    for (const p of seedPos) held[p.agent] = (held[p.agent] ?? 0n) + BigInt(p.amount);
    volume = Object.values(held).reduce((x, y) => x + y, 0n);
    if (seedPos.length) snap({ phase: "market", label: "Seeder adds equal liquidity" });
  }

  // Each scout trades once per round in the demo; its position holds the amount (or shares).
  const bets: Bet[] = betEvents.map((e) => {
    const s = e.data.scout as string;
    const pos = scoutPos[scoutIds.indexOf(s)] ?? [];
    const held = BigInt(pos.find((p) => p.agent === e.data.agent)?.amount ?? "0");
    const amount = e.data.amount ? BigInt(e.data.amount) : lmsr ? 0n : held;
    return { bettor: s, agent: e.data.agent, amount, shares: held, reasoning: e.data.reasoning, kind: e.data.kind };
  });
  bets.forEach((bet, i) => {
    held[bet.agent] = (held[bet.agent] ?? 0n) + bet.shares;
    volume += bet.amount;
    snap({ phase: "market", label: `${short(bet.bettor)} ${lmsr ? "buys" : "backs"} ${short(bet.agent)}`, bet: i });
  });

  // Whatever the log did not explain (trades from other accounts) is added before the lock.
  for (const e of round.entries) held[e.agent] = BigInt(e.shares);
  volume = BigInt(round.total_pool);
  if (round.status === "Open" || round.status === "Trading") {
    return { bets, frames: frames.length ? frames : [{ phase: "market", label: "Market open", odds: odds(), volume, answered: new Set() }] };
  }

  snap({ phase: "locked", label: "Market locked: expected scores frozen" });
  const order = [...round.entries].filter((e) => e.answered_at_ms).sort((a, b) => a.answered_at_ms! - b.answered_at_ms!);
  const answered = new Set<string>();
  snap({ phase: "solving", label: "Agents solve independently", answered: new Set(answered), at: round.locked_at_ms ?? undefined });
  for (const e of order) {
    answered.add(e.agent);
    snap({ phase: "solving", label: `${short(e.agent)} submits an answer${e.attested ? " (attested)" : ""}`, answered: new Set(answered), at: e.answered_at_ms! });
  }
  if (round.proposal || round.status === "Settled") {
    snap({ phase: "scored", label: "Verifier runs the hidden tests", answered });
  }
  if (round.status === "Proposed" || round.status === "Disputed" || (round.status === "Settled" && round.proposal)) {
    snap({ phase: "window", label: round.dispute ? `Disputed by ${short(round.dispute.by)}: arbiters re-run` : "Scores posted: anyone can re-run and dispute", answered });
  }
  if (round.status === "Settled") {
    snap({ phase: "settled", label: round.dispute?.overturned ? "Arbiters overturned the scores; verifier slashed" : "Final: payouts, ratings, task difficulty", answered });
  }
  return { bets, frames };
}

export function share(pools: Record<string, bigint>, agent: string): number {
  const total = Object.values(pools).reduce((a, b) => a + b, 0n);
  if (total === 0n) return 0;
  return Number((pools[agent] ?? 0n) * 1_000_000n / total) / 1_000_000;
}
