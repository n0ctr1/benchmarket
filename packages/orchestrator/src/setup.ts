import fs from "node:fs";
import path from "node:path";
import { generateKeyPair, listTaskIds, loadTask, publicKeyOf } from "@benchmarket/shared";
import { LeagueChain } from "./chain.js";
import { config, formatNear, near, REPO_ROOT } from "./config.js";
import { attestedSigners } from "./nearai.js";
import { CATEGORIES } from "./categories.js";
import { agentAccount, ROSTER } from "./roster.js";
import { ALL_SCOUT_IDS } from "./scouts.js";

const WASM_CANDIDATES = [
  path.join(REPO_ROOT, "contract/target/near/benchmarket.wasm"),
  path.join(REPO_ROOT, "contract/target/wasm32-unknown-unknown/release/benchmarket.wasm"),
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
    console.log("contract deployed and initialized");
    await configure(chain);
  } else {
    console.log("contract already deployed");
  }

  // Agent and scout sub-accounts with their own balances.
  const wanted = [
    ...ROSTER.map((a) => ({ id: agentAccount(a, league), balance: near(opts.agentBalance ?? "0.6") })),
    ...ALL_SCOUT_IDS.map((s) => ({ id: `${s}.${league}`, balance: near(opts.scoutBalance ?? "0.4") })),
    // A client who posts briefs in the demo.
    { id: `client.${league}`, balance: near("0.1") },
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

/** Deploys the current wasm over the existing contract; migrates V5 state to V6 once. */
export async function upgrade(): Promise<void> {
  const chain = new LeagueChain();
  const league = config.leagueAccount;
  const parent = chain.account(league);
  const wasm = WASM_CANDIDATES.find((p) => fs.existsSync(p));
  if (!wasm) throw new Error("build the contract first: npm run build:contract");
  // A V7 contract reports next_brief_id; V6 reports params; older ones need an earlier release.
  const cfg = await chain.getConfig().catch(() => null);
  if (cfg && !cfg.params) throw new Error("state is older than V6: upgrade with the V6 release first");
  const current = cfg ? (cfg as { next_brief_id?: number }).next_brief_id !== undefined : false;
  console.log(`deploying ${path.relative(REPO_ROOT, wasm)} (${fs.statSync(wasm).size} bytes)`);
  await parent.deployContract(new Uint8Array(fs.readFileSync(wasm)));
  if (current) {
    console.log("state layout is current, no migration needed");
  } else {
    await parent.callFunction({ contractId: league, methodName: "migrate", args: {}, gas: 300_000_000_000_000n });
    const c = await chain.getConfig();
    console.log(`migrated to V7: everything kept (rounds from ${c.first_lmsr_round} on LMSR, earlier ones as history); briefs enabled`);
  }
  await configure(chain);
}

/**
 * Brings the deployed contract to the demo configuration. Safe to re-run: curated tasks,
 * testnet-sized parameters, verifier stakes, arbiters and the trusted NEAR AI signing key.
 */
export async function configure(chain = new LeagueChain()): Promise<void> {
  const league = config.leagueAccount;
  const cfg = await chain.getConfig();

  // Curated tasks: the rated pool. Their tests hash is pinned.
  const known = new Map((await chain.getTasks()).map((t) => [t.task_ref, t]));
  for (const id of listTaskIds()) {
    const t = loadTask(id);
    const have = known.get(id);
    if (have?.curated) continue;
    if (have) {
      console.log(`task ${id} exists uncurated; leaving it`);
      continue;
    }
    await chain.addTask(league, id, t.skill, t.testsHash);
    console.log(`curated task ${id}`);
  }

  // Tasks with a generator become families: every round runs on fresh tests from a new seed.
  const tasksNow = new Map((await chain.getTasks()).map((t) => [t.task_ref, t]));
  for (const id of listTaskIds()) {
    const t = loadTask(id);
    const have = tasksNow.get(id);
    if (t.familyHash && have?.curated && have.tests_hash !== t.familyHash) {
      await chain.setTaskTests(league, id, t.familyHash);
      console.log(`task ${id} is now a family: fresh tests every round`);
    }
  }

  // Categories clients pick from, with their tasks.
  const cats = new Map((await chain.getCategories().catch(() => [])).map((c) => [c.id, c]));
  for (const c of CATEGORIES) {
    if (!cats.has(c.id)) {
      await chain.setCategory(league, c.id, c.title, c.description);
      console.log(`category ${c.id}`);
    }
    for (const t of c.tasks) {
      if (!cats.get(c.id)?.skill_tasks.includes(t) && tasksNow.get(t)?.curated) await chain.setTaskCategory(league, t, c.id);
    }
  }

  // Testnet-sized parameters: short dispute window, small bonds and stakes.
  const window = config.disputeWindowSeconds * 1000;
  const want = {
    ...cfg.params,
    min_pool: near("1.5").toString(),
    min_builder_stake: config.builderStake.toString(),
    min_bet: near("0.01").toString(),
    answer_window_ms: 15 * 60_000,
    dispute_window_ms: window,
    resolve_timeout_ms: 3_600_000,
    settle_timeout_ms: 3_600_000,
    dispute_bond: near("0.1").toString(),
    min_verifier_stake: config.verifierStake.toString(),
    unstake_delay_ms: window + 2 * 3_600_000,
  };
  if (JSON.stringify(want) !== JSON.stringify(cfg.params)) {
    await chain.setParams(league, want);
    console.log(`params set: dispute window ${config.disputeWindowSeconds}s, verifier stake ${formatNear(config.verifierStake)} NEAR`);
  }

  // Each verifier key needs its stake for its signature to count.
  const stakes = new Map((await chain.getVerifierStakes()).map((s) => [s.public_key, s]));
  for (const pk of cfg.verifiers) {
    const s = stakes.get(pk);
    if (s && BigInt(s.amount) >= config.verifierStake && s.unlock_at_ms === null) continue;
    const add = config.verifierStake - BigInt(s?.amount ?? "0");
    await chain.stakeVerifier(league, pk, add > 0n ? add : config.verifierStake);
    console.log(`staked ${formatNear(add > 0n ? add : config.verifierStake)} NEAR on verifier ${pk.slice(0, 16)}...`);
  }

  // Arbiters decide disputes. In this demo the league holds the arbiter key; in production it
  // belongs to independent parties (or a DAO).
  const arbiters = config.arbiterSecretKeys.map(publicKeyOf);
  if (arbiters.length > 0 && JSON.stringify(arbiters) !== JSON.stringify(cfg.arbiters)) {
    await chain.setArbiters(league, arbiters, 1);
    console.log(`arbiters set: ${arbiters.length} key(s)`);
  }

  // Trusted inference signing keys, read from NEAR AI Cloud's attestation reports: the gateway's
  // (ed25519 and ECDSA) and, for models NEAR AI hosts in a TEE, each model enclave's key.
  if (config.nearAiApiKey) {
    const keys = await attestedSigners([...new Set(ROSTER.map((a) => a.model))]);
    const want = [...keys.gateway.map((k) => `gateway:${k}`), ...keys.models.map((m) => `model:${m.key}`)];
    const merged = [...new Set([...cfg.inference_signers.map((k) => (k.includes(":") ? k : `gateway:${k}`)), ...want])];
    if (merged.length !== cfg.inference_signers.length || merged.some((k, i) => k !== cfg.inference_signers[i])) {
      await chain.setInferenceSigners(league, merged);
      console.log(`trusted NEAR AI keys: ${keys.gateway.length} gateway, ${keys.models.map((m) => m.model).join(", ") || "no"} model enclaves`);
    }
  }
}
