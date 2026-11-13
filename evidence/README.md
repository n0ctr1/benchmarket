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
