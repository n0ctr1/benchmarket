import fs from "node:fs";
import path from "node:path";
import type { LeagueChain } from "./chain.js";
import { config, near, REPO_ROOT } from "./config.js";
import { ensureAccount } from "./nominal.js";

/**
 * The contract's owner as a 2-of-3 multisig: NEAR's own multisig contract (near/core-contracts
 * multisig2, vendored in contract/vendor) on `council-ms.testnet`, with three nominal signers.
 * Owner calls (verifier and arbiter lists, parameters, task curation, inference signers, the
 * owner itself) then need one signer to propose and a second to confirm; round fees and slashed
 * stakes accrue to the multisig, a treasury no single key controls.
 */
export const COUNCIL = {
  multisig: "council-ms.testnet",
  signers: ["tessa-sig.testnet", "ivo-keys.testnet", "rowan-sign.testnet"],
  confirmations: 2,
};

const WASM = path.join(REPO_ROOT, "contract", "vendor", "multisig2.wasm");

async function view<T>(contract: string, method: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
  }).then((x) => x.json() as Promise<{ result?: { result: number[] }; error?: unknown }>);
  if (!r.result) throw new Error(`${contract}.${method}: ${JSON.stringify(r.error)}`);
  return JSON.parse(Buffer.from(r.result.result).toString()) as T;
}

export async function setupMultisig(chain: LeagueChain, say: (l: string) => void = console.log): Promise<void> {
  const league = config.leagueAccount;
  for (const s of COUNCIL.signers) await ensureAccount(chain, s, near("0.1"), say);
  // About 3.4 NEAR of the account pays for the contract's storage.
  await ensureAccount(chain, COUNCIL.multisig, near("3.8"), say);
  const members = await view<unknown[]>(COUNCIL.multisig, "get_members", {}).catch(() => null);
  if (!members) {
    const ms = chain.account(COUNCIL.multisig);
    await ms.deployContract(new Uint8Array(fs.readFileSync(WASM)));
    await ms.callFunction({ contractId: COUNCIL.multisig, methodName: "new", args: { members: COUNCIL.signers.map((account_id) => ({ account_id })), num_confirmations: COUNCIL.confirmations }, gas: 100_000_000_000_000n });
    say(`${COUNCIL.multisig}: multisig2 with ${COUNCIL.signers.join(", ")}; ${COUNCIL.confirmations} of ${COUNCIL.signers.length} must confirm`);
  }
  const cfg = await chain.getConfig();
  if (cfg.owner !== COUNCIL.multisig) {
    await chain.account(league).callFunction({ contractId: league, methodName: "set_owner", args: { owner: COUNCIL.multisig }, gas: 30_000_000_000_000n });
    say(`owner of ${league} is now ${COUNCIL.multisig}`);
  }
}

/** An owner call through the multisig: the first signer proposes and confirms, a second confirms. */
export async function ownerCall(chain: LeagueChain, method: string, args: Record<string, unknown>, say: (l: string) => void = console.log): Promise<number> {
  const league = config.leagueAccount;
  const request = {
    receiver_id: league,
    actions: [{ type: "FunctionCall", method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: "0", gas: "150000000000000" }],
  };
  const [first, second] = COUNCIL.signers;
  const id = Number(await chain.account(first).callFunction({ contractId: COUNCIL.multisig, methodName: "add_request_and_confirm", args: { request }, gas: 200_000_000_000_000n }));
  say(`${first} proposes request ${id}: ${method}`);
  await chain.account(second).callFunction({ contractId: COUNCIL.multisig, methodName: "confirm", args: { request_id: id }, gas: 250_000_000_000_000n });
  say(`${second} confirms request ${id}: executed`);
  return id;
}
