import fs from "node:fs";
import path from "node:path";
import { generateKeyPair, publicKeyOf, signMessage } from "@benchmarket/shared";
import type { LeagueChain } from "./chain.js";
import { config, formatNear, near, REPO_ROOT } from "./config.js";

/**
 * Nominal outside participants. In this demo the team runs them, each on its own top-level
 * account with its own key, so the roles that should not belong to the league operator do not:
 * three verifier operators who stake their own keys (two of three must sign), three arbiters
 * (two of three must rule), an outside agent and an outside scout. The README says plainly that
 * the same team holds these keys; the point is that the contract treats them as strangers.
 */
export const NOMINAL = {
  verifierOperators: ["vera-quorum.testnet", "ledgerline-ops.testnet", "northwatch-audit.testnet"],
  arbiters: ["halden-court.testnet", "okafor-arb.testnet", "maple-ruling.testnet"],
  agent: "kestrel-labs.testnet",
  scout: "marlow-odds.testnet",
};

/** Accounts left from the deployment before the rename: they fund the nominal ones. */
const FUNDERS = ["echo.agent-league.testnet", "scout-fav.agent-league.testnet", "scout-spec.agent-league.testnet", "bolt.agent-league.testnet", "atlas.agent-league.testnet"];

const OPERATOR_KEYS = path.join(REPO_ROOT, ".data", "keys", "verifier-operators.json");

async function exists(id: string): Promise<boolean> {
  const r = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }),
  }).then((x) => x.json() as Promise<{ result?: unknown }>);
  return !!r.result;
}

/** Creates a top-level testnet account through the `testnet` registrar, funded by a funder. */
async function ensureAccount(chain: LeagueChain, id: string, amount: bigint, say: (l: string) => void): Promise<void> {
  if (await exists(id)) {
    if (!chain.keys.has(id)) throw new Error(`${id} exists but its key is not here`);
    return;
  }
  let funder: string | undefined;
  for (const f of FUNDERS) {
    if ((await chain.available(f).catch(() => 0n)) >= amount + near("0.05")) {
      funder = f;
      break;
    }
  }
  if (!funder) throw new Error(`no funder has ${formatNear(amount)} NEAR free for ${id}`);
  const kp = generateKeyPair();
  chain.keys.save(id, kp.publicKey, kp.secretKey);
  await chain.account(funder).callFunction({ contractId: "testnet", methodName: "create_account", args: { new_account_id: id, new_public_key: kp.publicKey }, deposit: amount, gas: 100_000_000_000_000n });
  say(`created ${id} with ${formatNear(amount)} NEAR`);
}

/** Replaces (or adds) KEY=value lines in .env. */
function setEnv(values: Record<string, string>): void {
  const file = path.join(REPO_ROOT, ".env");
  let text = fs.readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${text.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
}

export async function setupNominal(chain: LeagueChain, say: (l: string) => void = console.log): Promise<void> {
  const league = config.leagueAccount;
  const stake = config.verifierStake;

  for (const op of NOMINAL.verifierOperators) await ensureAccount(chain, op, stake + near("0.15"), say);
  for (const a of NOMINAL.arbiters) await ensureAccount(chain, a, near("0.05"), say);
  await ensureAccount(chain, NOMINAL.agent, near("0.4"), say);
  await ensureAccount(chain, NOMINAL.scout, near("0.3"), say);

  // Each operator's own verifier key (not its account key): the public verifier signs with it.
  const opKeys: Record<string, string> = fs.existsSync(OPERATOR_KEYS) ? JSON.parse(fs.readFileSync(OPERATOR_KEYS, "utf8")) : {};
  for (const op of NOMINAL.verifierOperators) opKeys[op] ??= generateKeyPair().secretKey;
  fs.mkdirSync(path.dirname(OPERATOR_KEYS), { recursive: true, mode: 0o700 });
  fs.writeFileSync(OPERATOR_KEYS, JSON.stringify(opKeys, null, 2), { mode: 0o600 });

  // Each operator stakes its key with the key's proof that this operator holds it.
  const stakes = new Map((await chain.getVerifierStakes()).map((s) => [s.public_key, s]));
  const cfg = await chain.getConfig();
  const newKeys = NOMINAL.verifierOperators.map((op) => publicKeyOf(opKeys[op]));
  // Old keys stay listed so earlier rounds still verify in the browser, but stop counting.
  const verifiers = [...new Set([...cfg.verifiers, ...newKeys])];
  if (verifiers.length !== cfg.verifiers.length || cfg.threshold !== 2) {
    await chain.account(league).callFunction({ contractId: league, methodName: "set_verifiers", args: { verifiers, threshold: 2 }, gas: 100_000_000_000_000n });
    say(`verifier keys: ${verifiers.length} listed, 2 must sign`);
  }
  for (const op of NOMINAL.verifierOperators) {
    const pk = publicKeyOf(opKeys[op]);
    const s = stakes.get(pk);
    if (s && BigInt(s.amount) >= stake) continue;
    const proof = s ? undefined : signMessage(opKeys[op], `benchmarket:stake:v1:${league}:${op}`);
    await chain.stakeVerifier(op, pk, stake - BigInt(s?.amount ?? "0"), proof);
    say(`${op} staked ${formatNear(stake)} NEAR on its verifier key`);
  }
  for (const pk of cfg.verifiers) {
    const s = stakes.get(pk);
    if (!s || s.owner !== league || s.unlock_at_ms !== null || newKeys.includes(pk)) continue;
    await chain.account(league).callFunction({ contractId: league, methodName: "request_unstake", args: { public_key: pk }, gas: 30_000_000_000_000n });
    say(`the league's own key ${pk.slice(0, 16)}... stops counting (unstake requested)`);
  }

  // Arbiters: each arbiter account's own access key rules; two of three.
  const arbiterSecrets = NOMINAL.arbiters.map((a) => chain.keys.get(a));
  const arbiterKeys = arbiterSecrets.map(publicKeyOf);
  if (JSON.stringify(arbiterKeys) !== JSON.stringify(cfg.arbiters) || cfg.arbiter_threshold !== 2) {
    await chain.setArbiters(league, arbiterKeys, 2);
    say(`arbiters: ${NOMINAL.arbiters.join(", ")}; 2 of 3 must rule`);
  }

  setEnv({
    VERIFIER_SECRET_KEYS: NOMINAL.verifierOperators.map((op) => opKeys[op]).join(","),
    VERIFIER_PUBLIC_KEYS: newKeys.join(","),
    VERIFIER_THRESHOLD: "2",
    ARBITER_SECRET_KEYS: arbiterSecrets.join(","),
    ARBITER_THRESHOLD: "2",
  });
  say(".env now signs with the operators' verifier keys and the three arbiters' keys");
}
