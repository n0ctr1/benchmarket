import { listTaskIds } from "@agent-league/shared";
import { createServer, Verifier } from "@agent-league/verifier";
import { LeagueChain } from "./chain.js";
import { config, DATA_DIR } from "./config.js";
import { runRound } from "./round.js";
import { setup } from "./setup.js";
import path from "node:path";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function withVerifier<T>(fn: (v: Verifier) => Promise<T>): Promise<T> {
  const verifier = new Verifier(config.verifierSecretKeys, path.join(DATA_DIR, "verifier"));
  const port = Number(process.env.VERIFIER_PORT ?? 8787);
  const server = createServer(verifier).listen(port);
  try {
    return await fn(verifier);
  } finally {
    server.close();
  }
}

async function leaderboard(chain: LeagueChain): Promise<void> {
  const rows = await chain.getLeaderboard("code.js");
  console.log("\nleaderboard code.js");
  for (const r of rows) {
    console.log(`  ${r.agent.split(".")[0].padEnd(8)} ${(r.rating / 100).toFixed(1).padStart(7)}  rounds ${r.rounds}  wins ${r.wins}${r.provisional ? "  (provisional)" : ""}`);
  }
  const scouts = await chain.getScouts();
  console.log("\nscouts by PnL");
  for (const s of scouts) {
    console.log(`  ${s.account.split(".")[0].padEnd(12)} pnl ${(Number(BigInt(s.pnl)) / 1e24).toFixed(3)} NEAR  bets ${s.bets}  wins ${s.wins}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const chain = new LeagueChain();
  switch (cmd) {
    case "setup":
      await setup({ agentBalance: arg("agent-balance"), scoutBalance: arg("scout-balance") });
      break;
    case "round": {
      const taskId = arg("task", "parse-duration")!;
      await withVerifier((verifier) => runRound({ chain, verifier, taskId, marketSeconds: Number(arg("market-seconds", "20")) }));
      await leaderboard(chain);
      break;
    }
    case "demo": {
      const n = Number(arg("rounds", "4"));
      const tasks = listTaskIds();
      await withVerifier(async (verifier) => {
        for (let i = 0; i < n; i++) {
          await runRound({ chain, verifier, taskId: tasks[i % tasks.length], marketSeconds: Number(arg("market-seconds", "20")) });
          console.log("");
        }
      });
      await leaderboard(chain);
      break;
    }
    case "status":
      await leaderboard(chain);
      break;
    default:
      console.log("usage: league <setup|round|demo|status> [--task id] [--rounds n] [--market-seconds s]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
