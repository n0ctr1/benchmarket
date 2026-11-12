import fs from "node:fs";
import path from "node:path";
import { generateKeyPair } from "@agent-league/shared";
import { LeagueChain } from "./chain.js";
import { config, formatNear, near, REPO_ROOT } from "./config.js";
import { agentAccount, ROSTER } from "./roster.js";
import { ALL_SCOUT_IDS } from "./scouts.js";

const WASM_CANDIDATES = [
  path.join(REPO_ROOT, "contract/target/near/agent_league.wasm"),
  path.join(REPO_ROOT, "contract/target/wasm32-unknown-unknown/release/agent_league.wasm"),
];

/** Creates sub-accounts, deploys and initializes the contract. Safe to re-run. */
export async function setup(opts: { agentBalance?: string; scoutBalance?: string } = {}): Promise<void> {
  const chain = new LeagueChain();
  const league = config.leagueAccount;
  const parent = chain.account(league);
  const state = await parent.getState();
  console.log(`${league}: ${formatNear(state.balance.available)} NEAR available`);

  // Contract.
  const code = await parent.getContractCode().catch(() => null);
  const deployed = code && code.code && code.code.length > 0;
  if (!deployed) {
    const wasm = WASM_CANDIDATES.find((p) => fs.existsSync(p));
    if (!wasm) throw new Error("build the contract first: npm run build:contract");
    console.log(`deploying ${path.relative(REPO_ROOT, wasm)} (${fs.statSync(wasm).size} bytes)`);
    await parent.deployContract(new Uint8Array(fs.readFileSync(wasm)));
    await parent.callFunction({
      contractId: league,
      methodName: "new",
      args: { owner: league, verifiers: config.verifierPublicKeys, threshold: config.verifierThreshold },
    });
    // Demo-sized parameters so a faucet account can run several rounds.
    await parent.callFunction({
      contractId: league,
      methodName: "set_params",
      args: { min_pool: near("1.5").toString(), min_builder_stake: config.builderStake.toString(), min_bet: near("0.01").toString() },
    });
    console.log("contract deployed and initialized");
  } else {
    console.log("contract already deployed");
  }

  // Agent and scout sub-accounts with their own balances.
  const wanted = [
    ...ROSTER.map((a) => ({ id: agentAccount(a, league), balance: near(opts.agentBalance ?? "0.6") })),
    ...ALL_SCOUT_IDS.map((s) => ({ id: `${s}.${league}`, balance: near(opts.scoutBalance ?? "0.4") })),
  ];
  for (const w of wanted) {
    if (chain.keys.has(w.id)) {
      console.log(`${w.id} exists`);
      continue;
    }
    const kp = generateKeyPair();
    await parent.createSubAccount({ accountOrPrefix: w.id, publicKey: kp.publicKey, nearToTransfer: w.balance });
    chain.keys.save(w.id, kp.publicKey, kp.secretKey);
    console.log(`created ${w.id} with ${formatNear(w.balance)} NEAR`);
  }
}
