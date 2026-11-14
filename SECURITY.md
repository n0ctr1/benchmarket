# Security

Benchmarket is a hackathon project on NEAR **testnet**. Do not put mainnet value into it.

Report a vulnerability through a private GitHub security advisory on this repository (Security →
Report a vulnerability), not a public issue.

## What holds money

The contract `benchmarket.testnet` (`contract/src`) holds every deposit: round bounties and
market subsidies, LMSR purchases, builder bonds, scout stakes on briefs, verifier stakes, dispute
bonds, job and brief budgets. Nothing off chain holds funds; the site, the verifier and the
orchestrator only send transactions signed by the account that pays.

## Trust model

| Party | Trusted for | Bounded by |
|---|---|---|
| **Owner** (`council-ms.testnet`, a 2-of-3 multisig on NEAR's multisig2 contract) | Curating tasks, setting parameters, the verifier, arbiter and inference-signer lists; fees and slashed stakes accrue to it | Every owner call is proposed by one signer and executed only on a second signer's confirmation, all public transactions. The signers are nominal (the team) in this demo. Code upgrades are deployed with the `benchmarket.testnet` account key, outside the multisig. |
| **Verifiers** (2 of 3 keys, each staked by its own operator account) | Running answers against the hidden tests and signing the scores | Their combined stake must cover any job budget they release; a wrong score is disputable during the dispute window and an overturned one slashes every signing key to the disputer. The tests, answers and seed are published so anyone can recompute the scores. |
| **Arbiters** (2 of 3 keys) | Ruling disputes | A ruling is a signed score set checked on chain; an unresolved dispute expires into the verifier-signed result with the bond returned. |
| **NEAR AI Cloud** | Attesting that a completion came from a given model (gateway or model-enclave keys the owner registered from NEAR AI's attestation reports) | The contract checks the signature over the exact request and response hashes. The TDX quote and GPU evidence behind the keys are **not verified** by the contract or the client, so a confidential task's privacy depends on that report being honest. |
| **Scouts, agents, clients** | Nothing | They act with their own deposits; the contract enforces bars, deadlines and payouts. |

## What the contract guarantees (tested in `contract/src/tests.rs`)

- Escrow conservation: every deposit is paid out, refunded or slashed exactly once.
- The LMSR market maker's loss is bounded by its subsidy; purchases cannot drain a round.
- Only distinct, staked verifier keys count toward the threshold; a key in its unstake delay
  stays slashable; the first stake on a key needs the key's own signature (no key squatting).
- A job's score releases at most the stake of the keys that signed it.
- A rating bar on a job is enforced by the contract (`take_job` refuses an agent below it).
- A brief's scouts lose their stake only on work that was the agent's own; a failure the client
  controlled (its own uncurated tests, a confidential run it commits) returns every stake.
- An answer that scores 0 while others scored forfeits its builder's bond; an attested answer
  counts toward an agent's record only if it scored.
- Every window (brief, betting) is capped, so no deposit can be held for good.

## The verifier service

`packages/verifier` runs untrusted code. Each answer runs in a separate Node process with
`node:vm`, Node's permission model, a 128 MB heap, a resident-memory watch and time limits; the
public instance (verifier.bench-market.xyz) also runs each answer inside a bubblewrap namespace
(no network, read-only filesystem, own pid space) under a systemd service with its own user. That
is defence in depth, not a proven sandbox: a `node:vm` escape would still need a kernel or
bubblewrap escape to reach the signing keys.

Requests about a client's task (`/client-task`, `/sealed`) must carry the job poster's NEP-413
wallet signature over the exact body, with a one-time nonce and a full-access key. The
operator's calls (`/operator/*`) need a bearer token.

## Known limits

- Testnet only; the build is reproducible (`cargo near build reproducible-wasm`) but no mainnet
  deployment exists.
- The nominal verifier operators, arbiters and outside participants are run by the team for the
  demo; the contract treats them as independent, but they are not.
- Confidential briefs trust NEAR AI's attestation report (see above).
- A full security audit of this repository (Cloudflare's security-audit-skill) found no critical
  or high findings; its medium and low findings are fixed in the code and the open items are the
  ones listed here.
