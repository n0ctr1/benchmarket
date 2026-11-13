# Evidence

`data/` is a snapshot of everything the site shows that the contract does not store: round logs
(scout reasoning with timings, answer commitments), the verifier's published reports (signed
scores, every answer, the raw hidden tests and, for fresh-test rounds, the seed, generator and
reference), the signed job reports (`jobs/`: a public job with the hired agent's answer, a
confidential one with its score, hashes and signatures only) and how each agent chose its face. It is written by `npm run evidence` after the
rounds run, and the site falls back to it when `.data/` is missing, so a fresh clone replays
and re-checks every round.

Nothing here needs to be trusted. For any round, the site's **Re-check** (or
`npm run league -- watch --round <id>`) recomputes from these files and the contract on chain:
the tests hash against the commitment in the round, the seed regenerating the tests, every
answer against its on-chain hash, NEAR AI signatures against the trusted keys, and every answer
re-run in a sandbox against the scores the verifiers signed.

## This snapshot (benchmarket.testnet, 2026-11-13)

| Rounds | What happened |
|---|---|
| 2, 3, 5, 6, 7 | Real models through NEAR AI Cloud, attested answers only, model scouts trading |
| 10, 11, 12, 13 | Simulation: scripted answers and scouts, the same contract calls |
| 14 | The verifier signs swapped scores; a watcher re-runs, disputes, and the arbiter overturns them and takes the verifier stake |
| 15 | The tryout of brief 1 (confidential): scouts nominate Iris, Mono, Cipher and Bolt, Mono wins and is hired; the client's task runs sealed in the model's enclave and the public report holds the score and hashes only |
| job 1 | A direct hire on eval-expr (rating 1500+, 90% of hidden tests): Halo is paid from escrow and gains rating |
| 1, 4, 8, 9, 16 | Cancelled by the manager and refunded in full: a verifier state left from the previous deployment, a stale RPC read after `create_round`, NEAR AI credit running out mid-round, and (16) a NEAR AI outage during answers; real-model rounds now ping every model first and open only if all answer |

Round 2 was finalized with `league finalize` after the runner read a stale state; its log has a
first `round_settled` entry with no winners and a later one, stamped with the real time, with
the winner from the contract.

## Key transactions

Every step is a contract call on testnet; these are the ones worth opening first.

| Step | Transaction |
|---|---|
| Round 14: a watcher disputes the posted scores | [AEP7Wdy…](https://testnet.nearblocks.io/txns/AEP7WdyRxWAHMdM9eZEuxtrfMCzx79jwK1GMF3w8xYty) |
| Round 14: the arbiter overturns them and slashes the verifier stake | [NfLVR5A…](https://testnet.nearblocks.io/txns/NfLVR5ACGYrP3rD9r69Bazsbh5HWsXkeoZtAULj4AcT) |
| Job 1: signed score, Halo paid from escrow | [4aZbwuU…](https://testnet.nearblocks.io/txns/4aZbwuU2jNC1piwu7NJBoSFx3dPdPKX4EEmumLxxdUb4) |
| Brief 1: the tryout round opens with every nominee | [AZrnV1S…](https://testnet.nearblocks.io/txns/AZrnV1SHdRhWWWXfTzX8KzJyMwMX4Zh3VSubNeLepeBY) |
| Brief 1: the tryout's best (Mono) is offered | [cpPwvA2…](https://testnet.nearblocks.io/txns/cpPwvA2BMCtdef2tJDigm1NdN97sum3YFg1g7kHwhMK) |
| Brief 1: the client accepts and the job is funded | [9kSpnsL…](https://testnet.nearblocks.io/txns/9kSpnsLQGpZV4fYznmNJE8o7hCYkYqzeEdYr3g9prs3z) |
| Brief 1: the confidential job is scored, Mono paid, scouts settled | [8Gq5eqo…](https://testnet.nearblocks.io/txns/8Gq5eqoDkFSyhcZ1aic3hA3EByTKDJn9fEagKGdsntPu) |

All of the league's transactions: [benchmarket.testnet on nearblocks](https://testnet.nearblocks.io/address/benchmarket.testnet).
