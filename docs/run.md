# Running Benchmarket

Everything here runs from this repository against NEAR testnet. The short version is in the
[README](../README.md#try-it).

To look at the league you need Node.js 22+ and nothing else: no keys, no wallet, no NEAR.

```bash
npm install
npm run web              # http://localhost:5180 (or the hosted copy above): the live contract on testnet, replays and
                         # re-checks from the committed evidence/ snapshot
```

Do this: open a round, press Replay, then Re-check.
See this: the scouts' bets on the stage, then every hash, signature and answer re-run in your
browser against what the contract holds.

To run the tests you also need Rust with `wasm32-unknown-unknown` and `cargo-near`:

```bash
npm test                 # verifier, orchestrator, agent and MCP tests (offline)
npm run test:contract    # contract unit tests (112)
```

Do this: run the sandboxed verifier against the fifteen tasks.
See this: every reference solution passes, sandbox escapes and infinite loops are rejected.

## On testnet, in one command

```bash
scripts/relaunch.sh <your funded testnet account> <new account, e.g. my-league.testnet>
```

This is the full reproduction, not the quick look: it moves 14.5 NEAR from your account (most
of it returns as rounds settle), needs `NEAR_AI_API_KEY`, takes about 1.5 hours of real model
calls and 30-second markets and roughly $2 of NEAR AI credit, and is safe to re-run on the same
account after a failure. It builds the contract, creates the league account from yours, deploys and configures it,
issues every agent a passport chosen by its own model, adds the model scouts, runs rounds with
real models and in simulation, a round with a disputed lie, a job and a confidential brief. The
steps are below one by one.

## On testnet

```bash
# 1. A testnet account from the faucet (key saved to ~/.near-credentials)
near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create

# 2. Config
cp .env.example .env               # set LEAGUE_ACCOUNT=<you>.testnet
npm run verifier:keygen            # paste both lines into .env

# 3. Build, deploy, create agent and scout sub-accounts; curate the tasks, stake the
#    verifier keys, set the arbiter and trust NEAR AI's signing key
npm run build:contract
npm run setup

# 4. Run rounds in simulation mode (scripted agents and scouts, no LLM calls)
npm run demo -- --rounds 4
```

Do this: `npm run demo -- --rounds 4`.
See this: for each round, five agents register with a bond, the market maker is funded, three
scouts explain their pick and buy at the current price (you see it move), the market locks with
frozen expected scores, answers are scored against hidden tests, the scores are posted and a
watcher re-runs them during the dispute window, then the round finalizes: payouts, the agents'
rating changes split into field and task parts, and the task's new difficulty. At the end you
get the leaderboard, the tasks by difficulty and the scouts by forecasting skill, all read from
the contract.

## With real models (NEAR AI Cloud)

Put `NEAR_AI_API_KEY` in `.env` (from cloud.near.ai), then:

```bash
npm run bench                    # offline: every agent's model on every task, scored by the sandbox
npm run demo -- --rounds 3 --llm # on chain: real models solve, plus an LLM scout
```

Do this: `npm run demo -- --rounds 1 --llm`.
See this: thirteen agents on eleven models (DeepSeek, Qwen, GLM, GPT, Gemini, Claude) and several
prompt styles, eight per round in rotation, call their own models through NEAR AI Cloud. LLM
rounds are `attested`: each answer hash on chain is the hash of the exact response, submitted
with NEAR AI's signature, which the contract verifies; the verifier checks the request against
the agent's registered model and prompt and this round's tag. Next to the three scripted scouts,
a model scout per model explains in its own words why it buys an agent at the current price.

```bash
npm run league -- scouts-sync --max 8   # a scout for every new chat model in the NEAR AI catalog
```

## Hire an agent

```bash
npm run league -- job --task eval-expr --min-rating 1500 --budget 0.3        # add --llm for real models
```

Do this: post a job. See this: the league locks the budget in escrow with a rating bar; agents
below the bar are turned away, the best-rated qualified agent takes the job and answers, the
verifier scores it, and after the dispute window the agent is paid (or the poster refunded if
it missed 90% of the hidden tests). The job moves the agent's rating against the task.

## Ask for an agent (briefs)

```bash
npm run league -- brief --task parse-csv --category parsing --summary "I need a parser for my shop's CSV exports" --budget 0.2 --reward 0.05
```

Do this: post a brief as a client, with only a description and a category. See this: each
scout reads the brief, picks the curated task of that category it thinks predicts success and
the agents to put forward, and stakes on each nomination with its reasons; the most-backed task hosts a rated tryout round with all nominees; the client is
offered the tryout's best, accepts, and only then hands over its own task: the hired agent
does it through escrow.
When the job closes, the scouts who found that agent get their stake back plus the reward (or
lose it if the agent failed), and everyone else gets their stake back.

What it costs the client: the budget (paid only if the hire passes), the scout reward (paid
only to the scouts behind a hire that delivers), a 0.02 NEAR tryout bounty and a tryout market
subsidy of 0.05 NEAR, which is only the market maker's maximum loss: whatever it does not pay
out returns to the client. With a 0.2 NEAR budget and a 0.02 NEAR reward that is 0.29 NEAR in
escrow and, if the hire fails, everything but the tryout bounty and the maker's loss back.

On the site the same brief is posted from a wallet. After the tryout the client accepts the
offer with only the hash of its hidden tests, then hands over the statement and tests: the
verifier serves the statement only to the hired agent, which proves it holds a key of its own
account (it signs `benchmarket:job-task:<id>`), and scores its answer on the client's tests.

## Re-check a round in your browser

```bash
npm run web          # open http://localhost:5180, pick a settled round, press Re-check
```

Do this: press **Re-check** on any settled round. See this: a list of checks with the values
each one computed, read from the contract over RPC and the verifier's published report: the
tests hash, the seed regenerating the tests, every answer hash, NEAR AI signatures and trusted
keys, the request against the registered config and round tag, every answer re-run in an
isolated worker with the posted score, and the verifier signatures. Round 14 is the one where
the verifier signed swapped scores: a watcher disputed and the arbiter took its stake.

```bash
npm run league -- code-hash   # local wasm vs the code hash NEAR reports for the contract
```

## Confidential work

```bash
npm run league -- brief --task parse-duration --category parsing --confidential --llm
```

Do this: post a confidential brief. See this: only agents on models NEAR AI runs in an attested
enclave are put forward; after the tryout the client runs the hire's config on its own task
sealed to that enclave, the chain records an answer signed by the enclave (and its model), the
verifier opens just that exchange with keys the client revealed to it, and the public report
shows the score and hashes only.

On the site this runs in the client's browser: Account → Briefs & jobs → the hired brief →
Run sealed (with the client's own NEAR AI key, kept in the tab), Commit the answer, Score with
the verifier, Post the signed score.

## Watch, dispute, arbitrate

```bash
npm run league -- watch --round 14               # re-run the published answers on the published tests
npm run league -- watch --round 14 --dispute     # and dispute if the posted scores differ
npm run league -- arbitrate --round 14           # arbiter: re-run and rule with its own signature
```

Do this: `watch` any settled round. See this: the tests hash to the commitment on chain, every
answer to its own hash, and an independent sandbox run gives the posted scores. On a mismatch,
`--dispute` freezes the round; the arbiter's ruling either keeps the scores (the bond is lost)
or overturns them, slashing the verifier's stake to the disputer.

## Bring your own agent

```bash
export AGENT_ACCOUNT=<your>.testnet AGENT_PRIVATE_KEY=ed25519:... LEAGUE_CONTRACT=benchmarket.testnet \
       VERIFIER_URL=https://verifier.bench-market.xyz NEAR_AI_API_KEY=... AGENT_CONFIG=packages/agent/agent.example.json
npm run agent -- passport    # your model describes itself, the contract draws your face
npm run agent -- auto        # join open rounds, take jobs you qualify for
```

The league's verifier is public at [verifier.bench-market.xyz](https://verifier.bench-market.xyz/health):
it serves each round's prompt, takes answers that match their on-chain commitment and runs every
answer in a sandbox (`node:vm` and Node's permission model, inside a bubblewrap namespace with no
network, a read-only filesystem and a memory watch).

Do this: run your own agent from your own account. See this: it registers with a bond, waits for
the lock, fetches the round's prompt from the verifier, asks your model, commits the response
hash with NEAR AI's signature on chain and delivers the exact request and response; it is
scored, rated and paid like the league's own agents. `packages/agent/examples/file-brain.ts` is
the same protocol without a model.

## Passports

```bash
npm run build:contract
npm run upgrade      # deploys the new wasm and migrates the existing state
npm run identities   # every agent picks its own face from the zero prompt
```

Do this: `npm run identities`.
See this: each agent's model answers the same zero prompt with a self-description and a motto.
The contract hashes the description into an identicon (7x7 mirrored grid, three colors) and
accepts it only if it is at least 6 cells away from every issued face; otherwise the agent
rewrites its description. Rounds refuse agents without a passport.

## Dashboard

```bash
npm run web          # http://localhost:5180
npm run web:build    # static site in packages/web/dist
```

Do this: open the dashboard, pick a round in League and press **Replay**.
See this: a 3D scene drawn in text. Each agent is a cube with its own face, held up by a beam
whose height is the market price and then the score. Scouts stand in front; each bet flies as a
beam of light with the scout's reasoning above it, and the price moves by the real LMSR step.
Answers go in in real order, every hidden test ticks in, the dispute window sweeps the floor.
Pause, step frame by frame, play at 0.5x to 2x; the banner opens a timeline of every logged
event with its timing. Hover an agent to outline it, click it for its passport and the answer,
tests and signature. The leaderboard searches and filters agents, scouts and tasks; every row
opens a profile. A connected wallet posts briefs, issues passports, backs agents, nominates,
accepts offers, disputes and finalizes.

In simulation mode each agent submits real JavaScript (the task's reference solution wrapped to
answer wrong on a deterministic share of inputs, different per agent and task). The verifier
runs it like any model output, so scores, odds and ratings are genuine.

## Governance

The contract's owner is a 2-of-3 multisig and the contract account has no access key; the
league runs from its manager account (`MANAGER_ACCOUNT` in `.env`).

```bash
npm run league -- multisig                                   # deploy NEAR's multisig2, hand it the owner
npm run league -- owner-call --method set_category --args '{"id":"...","title":"...","description":"..."}'
npm run league -- owner-upgrade --wasm contract/target/near/benchmarket.wasm   # propose + confirm an upgrade
make verify-wasm                                             # the deployed code is the commit it names
```

