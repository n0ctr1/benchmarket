import { near, short, type Identity, type Round } from "./chain";
import { taskOf, type RosterAgent, type RoundRecord } from "./offchain";

/** A winner priced under this at the lock is an upset. */
export const UPSET = 0.15;

export const SCOUT_FACES: Record<string, string> = {
  "scout-fav": "(^.^)",
  "scout-value": "($.$)",
  "scout-spec": "(o.O)",
  "scout-llm": "[*_*]",
};
export const scoutFace = (account: string) => SCOUT_FACES[short(account)] ?? "(._.)";

export interface Names {
  name: (account: string) => string;
  identity: (account: string) => Identity | undefined;
  roster: (account: string) => RosterAgent | undefined;
}

export function names(roster: RosterAgent[], identities: Identity[]): Names {
  return {
    name: (a) => roster.find((r) => r.id === short(a))?.name ?? short(a),
    identity: (a) => identities.find((i) => i.agent === a),
    roster: (a) => roster.find((r) => r.id === short(a)),
  };
}

export const roundTitle = (r: Round, rec: RoundRecord | null | undefined) => taskOf(rec ?? null)?.title ?? r.task_ref;

/** Price at the lock: the market's win probability for this agent. */
export const lockPrice = (r: Round, agent: string) => (r.entries.find((e) => e.agent === agent)?.market_ppm ?? 0) / 1e6;

export const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export interface Story {
  headline: string;
  text: string;
  tags: string[];
  upset: boolean;
  winner: string | null;
  price: number | null;
  score: string;
}

/** What happened in a round, in one line, from the contract's own fields. */
export function story(r: Round, n: Names): Story {
  const tags: string[] = [];
  const outside = r.entries.some((e) => !n.roster(e.agent));
  if (r.status === "Cancelled") return { headline: "cancelled", text: "Cancelled before scoring; every stake refunded.", tags: ["cancelled"], upset: false, winner: null, price: null, score: "" };
  if (r.market === "lmsr") tags.push(r.rated ? "rated" : "unrated");
  else tags.push("rated");
  if (r.market === "lmsr") tags.push("lmsr");
  if (r.attested) tags.push("attested");
  if (outside) tags.push("outside");
  if (r.dispute) tags.push("dispute");
  const live = r.status !== "Settled";
  const w = r.winners[0] ?? null;
  const total = r.total_tests;
  const top = w ? r.entries.find((e) => e.agent === w)?.score ?? 0 : 0;
  const price = w ? lockPrice(r, w) : null;
  const upset = !live && price !== null && price < UPSET;
  const score = w && !live ? `${top}/${total}` : "";
  if (live) {
    const what = ({ Open: "registration open", Trading: "market open", Locked: "agents solving", Proposed: "scores posted, dispute window open", Disputed: "disputed, arbiters re-running" } as Record<string, string>)[r.status] ?? r.status;
    return { headline: `live · ${what}`, text: `${r.entries.length} agents on ${r.task_ref}.`, tags: ["live", ...tags], upset: false, winner: null, price: null, score: "" };
  }
  let text: string;
  if (r.dispute?.overturned) text = `Disputed by ${short(r.dispute.by)}: the arbiters overturned the posted scores and slashed the verifier.`;
  else if (r.dispute) text = `Disputed by ${short(r.dispute.by)}; the arbiters upheld the scores.`;
  else if (r.winners.length > 1) text = `${r.winners.map(n.name).join(", ")} tie at ${top}/${total} and share the win.`;
  else if (w && upset && outside && !n.roster(w)) text = `${n.name(w)}, an outside agent, wins from ${pct(price!)} with ${top}/${total}.`;
  else if (w && upset) text = `${n.name(w)} wins from ${pct(price!)}: the market had it as an outsider.`;
  else if (w) text = `${n.name(w)} wins with ${top}/${total} at ${pct(price!)}.`;
  else text = "No winner.";
  const headline = r.dispute?.overturned ? "scores overturned" : w && upset ? `${n.name(w)} wins from ${pct(price!)}` : w ? `${n.name(w)} wins ${top}/${total}` : "settled";
  return { headline, text, tags, upset, winner: w, price, score };
}

/** The round the home screen leads with: a live one, else the latest with a story. */
export function featured(rounds: Round[], n: Names): Round | null {
  const live = rounds.filter((r) => r.status !== "Settled" && r.status !== "Cancelled").sort((a, b) => b.id - a.id)[0];
  if (live) return live;
  const settled = rounds.filter((r) => r.status === "Settled").sort((a, b) => b.id - a.id);
  return settled.find((r) => story(r, n).upset || !!r.dispute) ?? settled[0] ?? null;
}

export interface LeagueStats {
  settled: number;
  cancelled: number;
  agents: number;
  outside: number;
  traded: string;
  upsets: number;
}

export function stats(rounds: Round[], n: Names): LeagueStats {
  const agents = new Set(rounds.flatMap((r) => r.entries.map((e) => e.agent)));
  const volume = rounds.reduce((s, r) => s + BigInt(r.total_pool), 0n);
  return {
    settled: rounds.filter((r) => r.status === "Settled").length,
    cancelled: rounds.filter((r) => r.status === "Cancelled").length,
    agents: agents.size,
    outside: [...agents].filter((a) => !n.roster(a)).length,
    traded: near(volume, 1),
    upsets: rounds.filter((r) => r.status === "Settled" && story(r, n).upset).length,
  };
}
