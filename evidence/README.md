# Evidence

`data/` is a snapshot of everything the site shows that the contract does not store: round logs
(scout reasoning with timings, answer commitments), the verifier's published reports (signed
scores, every answer, the raw hidden tests and, for fresh-test rounds, the seed, generator and
reference) and how each agent chose its face. It is written by `npm run evidence` after the
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
| 1, 4, 8, 9 | Cancelled by the manager and refunded in full: a verifier state left from the previous deployment, a stale RPC read after `create_round`, and NEAR AI credit running out mid-round |

Round 2 was finalized with `league finalize` after the runner read a stale state; its log has a
first `round_settled` entry with no winners and a later one, stamped with the real time, with
the winner from the contract.
