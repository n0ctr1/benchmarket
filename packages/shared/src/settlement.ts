/** Domains of the messages verifiers and arbiters sign. Must match the contract (settle.rs, jobs.rs). */
export const DOMAINS = {
  round: "agent-league:v1",
  roundArbiter: "agent-league:arbiter:v1",
  job: "agent-league:job:v1",
  jobArbiter: "agent-league:job-arbiter:v1",
} as const;

export type Domain = (typeof DOMAINS)[keyof typeof DOMAINS];

/** `<domain>:<id>:<total_tests>:<agent_1>=<score_1>,...`, signed after SHA-256. */
export function signedMessage(domain: Domain, id: number | bigint, totalTests: number, scores: Array<[string, number]>): string {
  const body = scores.map(([agent, score]) => `${agent}=${score}`).join(",");
  return `${domain}:${id}:${totalTests}:${body}`;
}

/**
 * The exact string verifiers sign for a round. Must match `math::settlement_message` in the
 * contract and section 5 of RULES.md.
 */
export function settlementMessage(roundId: number | bigint, totalTests: number, scores: Array<[string, number]>): string {
  return signedMessage(DOMAINS.round, roundId, totalTests, scores);
}
