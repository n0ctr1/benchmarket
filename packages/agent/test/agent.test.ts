import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateKeyPair, keyPairFromSeed, loadTask, roundTag, sha256Tagged } from "@benchmarket/shared";
import { createServer, Verifier } from "@benchmarket/verifier";
import { LeagueAgent, type Brain } from "../src/agent.js";

const ME = "outsider.testnet";

/** The league contract, faked: one locked round the agent is entered in. */
class OfflineAgent extends LeagueAgent {
  committed: string | null = null;
  calls: string[] = [];
  override async view<T>(method: string): Promise<T> {
    if (method === "get_round") return { id: 4, status: "Locked", attested: false, entries: [{ agent: ME, answer_hash: this.committed }] } as T;
    throw new Error(`unexpected view ${method}`);
  }
  protected override async call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push(method);
    if (method === "submit_answer") this.committed = args.answer_hash as string;
    return undefined as T;
  }
}

test("an outside agent answers a round through the public verifier API", async () => {
  const verifier = new Verifier([generateKeyPair().secretKey]);
  let agent!: OfflineAgent;
  const chain = { get: async () => ({ task_ref: "parse-duration", status: "Locked", entries: [{ agent: ME, answer_hash: agent.committed }] }) };
  const server = createServer(verifier, chain).listen(0);
  const url = `http://localhost:${(server.address() as { port: number }).port}`;
  const code = fs.readFileSync(loadTask("parse-duration").referencePath, "utf8");
  let seenPrompt = "";
  const brain: Brain = async (_s, prompt) => {
    seenPrompt = prompt;
    return { content: "```js\n" + code + "\n```", request: "", response: "", signature: null };
  };
  const key = keyPairFromSeed(new Uint8Array(32).fill(5));
  agent = new OfflineAgent(
    { account: ME, privateKey: key.secretKey, contract: "league.testnet", rpcUrl: "http://unused", verifierUrl: url, nearAiUrl: "", bond: 0n },
    { name: "Out", model: "none", systemPrompt: "x", tools: [] },
    brain,
    () => {},
  );
  try {
    const hash = await agent.playRound(4, { pollMs: 1 });
    // The prompt names the round, the hash went on chain, the verifier holds the same answer.
    assert.ok(seenPrompt.startsWith(roundTag("round", 4)));
    assert.deepEqual(agent.calls, ["submit_answer"]);
    assert.equal(hash, agent.committed);
    const stored = verifier.getAnswer(4, ME)!;
    assert.equal(sha256Tagged(stored.answer), hash);
    const r = await verifier.score(4, "parse-duration", [{ agent: ME, answer_hash: hash }]);
    assert.equal(r.scores[0][1], r.totalTests);
  } finally {
    server.close();
  }
});
