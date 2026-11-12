/**
 * agent <passport|round|job|auto> — run your own agent in Agent League.
 *
 * Needs: AGENT_ACCOUNT and AGENT_PRIVATE_KEY (your account, ed25519:...), LEAGUE_CONTRACT,
 * VERIFIER_URL, NEAR_AI_API_KEY, and AGENT_CONFIG (a JSON file with name, model, systemPrompt,
 * tools; see agent.example.json). Optional: NEAR_RPC_URL, NEAR_AI_BASE_URL, BOND_NEAR.
 */
import fs from "node:fs";
import type { PublicConfig } from "@agent-league/shared";
import { LeagueAgent, nearAiBrain, type AgentEnv } from "./agent.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function yocto(near: string): bigint {
  const [w, f = ""] = near.split(".");
  return BigInt(w || "0") * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24));
}

async function main(): Promise<void> {
  const env: AgentEnv = {
    account: need("AGENT_ACCOUNT"),
    privateKey: need("AGENT_PRIVATE_KEY"),
    contract: need("LEAGUE_CONTRACT"),
    rpcUrl: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
    verifierUrl: need("VERIFIER_URL"),
    nearAiKey: need("NEAR_AI_API_KEY"),
    nearAiUrl: process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1",
    bond: yocto(process.env.BOND_NEAR ?? "0.1"),
  };
  const config = JSON.parse(fs.readFileSync(need("AGENT_CONFIG"), "utf8")) as PublicConfig;
  const agent = new LeagueAgent(env, config, nearAiBrain(config.model, env.nearAiKey!, env.nearAiUrl));
  switch (process.argv[2]) {
    case "passport":
      await agent.passport();
      break;
    case "round":
      await agent.playRound(Number(arg("id")));
      break;
    case "job":
      await agent.playJob(Number(arg("id")));
      break;
    case "claim":
      for (const id of arg("id") ? [Number(arg("id"))] : await agent.claimable()) await agent.claim(id);
      break;
    case "auto":
      // Joins every open round, answers tryouts scouts entered it in, takes every job it
      // qualifies for (or was hired for through a brief), and claims what it is owed.
      for (;;) {
        const { rounds, jobs, entered } = await agent.open();
        for (const id of [...entered, ...rounds]) await agent.playRound(id).catch((e) => console.log(`round ${id}: ${e.message}`));
        for (const id of jobs) await agent.playJob(id).catch((e) => console.log(`job ${id}: ${e.message}`));
        for (const id of await agent.claimable()) await agent.claim(id).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 15_000));
      }
    default:
      console.log("usage: agent <passport|round --id n|job --id n|claim [--id n]|auto>");
      process.exit(process.argv[2] ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
