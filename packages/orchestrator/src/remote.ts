import type { PublishedReport } from "@benchmarket/verifier";

/**
 * The public verifier, driven by the league operator: it prepares a round's fresh tests (and
 * keeps the seed), binds them once the round exists, takes every entrant's answer (outside agents
 * post theirs to it directly) and scores the round. The operator calls carry a bearer token.
 */
export class RemoteVerifier {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {
    if (token.length < 32) throw new Error("VERIFIER_OPERATOR_TOKEN must be at least 32 characters");
  }

  private async post<T>(path: string, body: unknown, operator = true): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(operator ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`public verifier ${path}: ${j.error ?? res.status}`);
    return j;
  }

  async prepareTests(taskId: string): Promise<string> {
    return (await this.post<{ tests_hash: string }>("/operator/prepare", { taskId })).tests_hash;
  }

  async bindTests(roundId: number, hash: string): Promise<void> {
    await this.post("/operator/rounds/" + roundId + "/bind", { tests_hash: hash });
  }

  /** The same public call an outside agent makes: accepted only if it matches the commitment. */
  async submit(roundId: number, agent: string, answer: string, extra: { request?: string; config?: unknown; meta?: unknown }): Promise<void> {
    await this.post(`/rounds/${roundId}/answers`, { agent, answer, ...extra }, false);
  }

  async score(roundId: number): Promise<PublishedReport> {
    return this.post<PublishedReport>(`/operator/rounds/${roundId}/score`, {});
  }
}
