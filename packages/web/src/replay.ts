import { getPosition, LEAGUE, short, type Round } from "./chain";
import type { RoundRecord } from "./offchain";

export type Phase = "market" | "locked" | "solving" | "scored" | "settled";

export interface Bet {
  bettor: string;
  agent: string;
  amount: bigint;
  reasoning?: string;
  kind?: string;
}

/** One frame of a round as it happened. */
export interface Frame {
  phase: Phase;
  label: string;
  /** Pool per agent account at this moment, yoctoNEAR. */
  pools: Record<string, bigint>;
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
 * Rebuilds the round step by step. Amounts come from on-chain positions (self-stakes, the
 * seeder's equal split, each scout's bet); the order and reasoning of bets from the round log.
 */
export async function buildReplay(round: Round, rec: RoundRecord | null): Promise<Replay> {
  const agents = round.entries.map((e) => e.agent);
  const zero = () => Object.fromEntries(agents.map((a) => [a, 0n])) as Record<string, bigint>;

  const betEvents = (rec?.events ?? []).filter((e) => e.kind === "scout_bet");
  const scoutIds = [...new Set(betEvents.map((e) => e.data.scout as string))];
  const [agentPos, seedPos, scoutPos] = await Promise.all([
    Promise.all(agents.map((a) => getPosition(round.id, a).catch(() => []))),
    getPosition(round.id, LEAGUE).catch(() => []),
    Promise.all(scoutIds.map((s) => getPosition(round.id, s).catch(() => []))),
  ]);

  const frames: Frame[] = [];
  const pools = zero();
  const snap = (f: Omit<Frame, "pools" | "answered"> & { answered?: Set<string> }) =>
    frames.push({ ...f, pools: { ...pools }, answered: f.answered ?? new Set() });

  agents.forEach((a, i) => {
    const own = agentPos[i].find((p) => p.agent === a);
    if (own) pools[a] += BigInt(own.amount);
  });
  snap({ phase: "market", label: "Agents register and stake on themselves" });

  for (const p of seedPos) pools[p.agent] = (pools[p.agent] ?? 0n) + BigInt(p.amount);
  if (seedPos.length) snap({ phase: "market", label: "Seeder adds equal liquidity" });

  // Each scout bets once per round in the demo; its position holds the amount.
  const bets: Bet[] = betEvents.map((e) => {
    const s = e.data.scout as string;
    const pos = scoutPos[scoutIds.indexOf(s)] ?? [];
    const amt = pos.find((p) => p.agent === e.data.agent)?.amount ?? "0";
    return { bettor: s, agent: e.data.agent, amount: BigInt(amt), reasoning: e.data.reasoning, kind: e.data.kind };
  });
  bets.forEach((b, i) => {
    pools[b.agent] = (pools[b.agent] ?? 0n) + b.amount;
    snap({ phase: "market", label: `${short(b.bettor)} backs ${short(b.agent)}`, bet: i });
  });

  // Whatever the log did not explain (bets from other accounts) is added before the lock.
  for (const e of round.entries) pools[e.agent] = BigInt(e.pool);
  if (round.status === "Open") return { bets, frames: frames.length ? frames : [{ phase: "market", label: "Market open", pools: { ...pools }, answered: new Set() }] };

  snap({ phase: "locked", label: "Market locked: expected scores frozen" });
  const order = [...round.entries].filter((e) => e.answered_at_ms).sort((a, b) => a.answered_at_ms! - b.answered_at_ms!);
  const answered = new Set<string>();
  snap({ phase: "solving", label: "Agents solve independently", answered: new Set(answered), at: round.locked_at_ms ?? undefined });
  for (const e of order) {
    answered.add(e.agent);
    snap({ phase: "solving", label: `${short(e.agent)} submits an answer`, answered: new Set(answered), at: e.answered_at_ms! });
  }
  if (round.status === "Settled") {
    snap({ phase: "scored", label: "Verifier runs the hidden tests", answered });
    snap({ phase: "settled", label: "Contract checks signatures, pays out, updates ratings", answered });
  }
  return { bets, frames };
}

export function share(pools: Record<string, bigint>, agent: string): number {
  const total = Object.values(pools).reduce((a, b) => a + b, 0n);
  if (total === 0n) return 0;
  return Number((pools[agent] ?? 0n) * 1_000_000n / total) / 1_000_000;
}
