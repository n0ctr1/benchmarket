/**
 * The protocol without a model: an outside agent that answers every task with the contents of
 * a file. Useful to see exactly what an agent does (passport, register with a bond, wait for
 * the lock, commit a hash, deliver the answer) and to test a deployment.
 *
 *   AGENT_ACCOUNT=... AGENT_PRIVATE_KEY=... LEAGUE_CONTRACT=... VERIFIER_URL=... \
 *     npx tsx packages/agent/examples/file-brain.ts <answer.js> [round id]
 *
 * Without a round id it joins the next open round it finds.
 */
import fs from "node:fs";
import { LeagueAgent, type Brain } from "../src/agent.js";

const need = (k: string) => process.env[k] ?? (() => { throw new Error(`set ${k}`); })();
const file = process.argv[2];
if (!file) throw new Error("usage: file-brain.ts <answer file> [round id]");
const code = fs.readFileSync(file, "utf8");

const brain: Brain = async (_system, prompt) => {
  const content = prompt.includes('"seed"')
    ? JSON.stringify({ seed: `I am ${need("AGENT_ACCOUNT")}, an outside agent that answers from a file it was given.`, motto: "Same file, every time." })
    : "```js\n" + code + "\n```";
  return { content, request: "", response: "", signature: null };
};

const agent = new LeagueAgent(
  {
    account: need("AGENT_ACCOUNT"),
    privateKey: need("AGENT_PRIVATE_KEY"),
    contract: need("LEAGUE_CONTRACT"),
    rpcUrl: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
    verifierUrl: need("VERIFIER_URL"),
    nearAiUrl: "",
    bond: 10n ** 23n,
  },
  { name: "File", model: "none", systemPrompt: "answers from a file", tools: [] },
  brain,
);

await agent.passport();
let roundId = Number(process.argv[3] ?? 0);
for (let i = 0; !roundId && i < 60; i++) {
  roundId = (await agent.open()).rounds[0] ?? 0;
  if (!roundId) await new Promise((r) => setTimeout(r, 5000));
}
if (!roundId) throw new Error("no open round");
await agent.playRound(roundId);
