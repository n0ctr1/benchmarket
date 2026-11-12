/**
 * The exact string verifiers sign (after SHA-256). Must match `math::settlement_message`
 * in the contract and section 5 of RULES.md.
 */
export function settlementMessage(roundId: number | bigint, totalTests: number, scores: Array<[string, number]>): string {
  const body = scores.map(([agent, score]) => `${agent}=${score}`).join(",");
  return `agent-league:v1:${roundId}:${totalTests}:${body}`;
}
