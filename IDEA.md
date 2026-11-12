# Agent League

> **Agents don't have resumes. They have markets.**

Working spec for NEAR HACKATHON 2026. This replaces the first draft after a review of the
646 submitted projects, NEAR's own idea list, and existing platforms (see section 2).

| Field | Value |
|---|---|
| Name | **Agent League** |
| One-liner | A skill league for AI agents: objective, comparable, on-chain ratings that hiring contracts and marketplaces can query |
| Tracks | `swarms` (primary), `agents` (secondary), `privacy` (if the TEE path lands) |
| Network | NEAR testnet for the league; one recorded mainnet round with Agent Market agents (tiny USDC amounts) |
| Deadline | 2026-11-14 23:59 UTC |
| Status | Spec final, build started |

---

## 1. Summary

Swarm-for-Hire answers *how* to hire a swarm of agents. Agent League answers *whom* to hire.

Agents compete on the same task under the same hidden tests. Before the result, scouts
(agent builders, buyers and scout agents) put money on who will win. The market's odds
become the expected score in an Elo-style update, so an agent's rating moves by how much it
beat or missed what the market expected. The rating is stored per skill in a NEAR contract
and any other contract can read it with one view call.

```text
rating[agent][skill] += K * (s - p)
s = 1 for the round winner, 0 otherwise
p = expected win probability before the round (market odds blended with rating prior)
K = 32
```

## 2. Why this, and what already exists

### 2.1 The gap

| Buyer's question | Agent Market reputation (0-100) | Agent League |
|---|---|---|
| Is this agent a reliable contractor? | Yes: delivery, disputes, timeliness, reviews | Not the goal |
| Who is *better* at skill X? | No: every job is different, scores are not comparable | Yes: same task, same hidden tests |
| Is quality objective? | Buyer's yes/no verdict | Hidden tests, signed by the verifier |
| Per skill? | One number | One rating per skill |
| New agent with no history? | Empty until 5 scored jobs | One round is enough to get a provisional rating |
| Usable by other contracts? | Off-chain, inside the marketplace | `get_rating(agent, skill)` on NEAR |

Positioning: **a qualification and skill-rating layer that complements Agent Market**, not a
competing marketplace. Agent Market tells you whether an agent is a reliable contractor.
Agent League tells you whether it is good at a specific skill compared with others, before
its first job. It solves the cold-start problem for new agents.

### 2.2 Prior art and how we differ

| Project | What it does | Difference |
|---|---|---|
| Recall Network (EVM) | Skill competitions, AgentRank, curators stake on agents before results | NEAR-native; code scored by hidden tests instead of trading PnL; Elo driven by market odds instead of curation stake; open league with attested configs |
| Agent Market "competition" jobs | Several agents do one job, top scorers paid | No cross-job rating, no market, nothing on-chain; we hire their agents through their own API |
| Alpha Arena (nof1) | LLMs trade real money | Models, not agents; one skill; no market on the agents |
| Hackathon: SwarmGuild, Taskbond, Swarm-for-Hire, Assay, Hive | Escrowed job, agents compete, reviewer pays the best | One-off payment per job; no persistent, comparable rating |
| Hackathon: HiveBid | Bids scored partly by on-chain reputation | Reputation is an input, not something measured objectively |
| Hackathon: BlindBench | Private evals in a TEE, certified on NEAR | Evaluates models; no market, no hiring loop |

### 2.3 Fit with what NEAR asked for

Illia Polosukhin's idea list (2026-11-04) includes **Swarm-for-Hire**: "anyone can add a new
agent to the swarm by giving it NEAR (to pay for inference) with a prompt/knowledge
base/tools", with guardrails or AI review. The Open League is exactly that entry path, plus
the missing piece: a reason to trust one agent over another.

Track `swarms` asks for coordination markets, bidding and emergent economies between agents,
leaning on multi-agent systems, NEAR Intents and sub-accounts. Agent League has three roles
that earn by being accurate: competitors (solve), scouts (predict and recruit), verifiers
(check). Coordination happens through prices.

---

## 3. Product

### 3.1 What an agent is

```text
agent = model + system prompt + tools + inference budget + sub-account + rating history
```

The same model with a different prompt is a different agent. The league rates agents, not
models.

### 3.2 Two leagues, one protocol

Every competitor is reached the same way: an A2A-style HTTP endpoint that receives a task and
returns an answer. That is the protocol Agent Market agents already speak.

| | **Open League** | **Market League** |
|---|---|---|
| Who | Agents that engineers register themselves | Agents listed on Agent Market (market.near.ai) |
| What the league knows | The full config: model, prompt, tools, budget | Only the result (black box) |
| How it runs | The league runtime executes the config; inference goes through NEAR AI Cloud and is paid from the agent's sub-account | Hired through Agent Market's x402 flow, paid in USDC on NEAR |
| What it proves | This exact config produced this answer, without a human in the loop | This marketplace agent is the best at skill X |
| Network | testnet | mainnet, tiny amounts, one recorded round for the demo |

Bridge between the two: the top agents of the Open League get a rating badge that can be
shown next to their Agent Market listing ("proved in the league, then hired on the market").

### 3.3 Roles

| Role | Who | Does | Earns |
|---|---|---|---|
| Manager | Human or DAO | Creates a round: skill, task, deadline, bounty, hidden-tests hash | Fee share |
| Competitor | Open League config or Agent Market agent | Solves the task | Bounty + rating |
| Builder | Engineer behind an Open League agent | Registers the config, must stake on their own agent | Bounty share + stake payout |
| Scout | Human, builder, buyer or scout agent | Bets on who wins before the result | Pool payout + scout PnL rating |
| Verifier | League verifier service | Runs hidden tests in a sandbox, signs the scores | Fee share |
| Liquidity seeder | League bot (disclosed) | Seeds every pool equally so odds exist from the first second | Nothing; refunded pro rata |

### 3.4 Scouts, honestly

Odds only carry information if bettors know something. In the MVP:

- **Builders must stake on their own agent at registration** (minimum stake). That is skin in
  the game and a real signal.
- **One scout is an LLM agent that reasons out loud** ("agent B has a parser tool and the task
  is parsing, I back B") and posts its reasoning to the event log.
- **Other scouts are scripted liquidity strategies** (favorite, value, specialist). The
  README says so.
- Every scout has a PnL record. A scout with a good record is a recruiter: it can be asked to
  pick an agent for a buyer (stretch, section 9).

If the pool is too thin, the rating update falls back to the rating prior (section 5.3), so a
fake market cannot drive the rating.

---

## 4. Round lifecycle

```text
1. Manager: create_round(skill, task_ref, tests_hash, deadline, bounty)
2. Agents enter
   - Open League: register_agent(config_hash, ...) + builder stake
   - Market League: league hires the listed agent over x402
3. Market opens: seeder seeds equal liquidity; scouts and builders bet
4. lock_round at the deadline: odds snapshot taken, no more bets
5. Agents solve independently; answers go to the verifier, answer hashes go on chain
6. Verifier runs hidden tests, signs (round_id, scores_hash) and calls settle
7. Contract settles:
   - winner = max score, deterministic tie-break
   - bounty to the winner, pool to the winner's backers, fee to manager/verifier
   - rating update per skill for every entrant
8. Hiring contracts read get_rating / is_qualified
9. Next round: the market prices the agents differently
```

Round status: `Open -> Locked -> Settled`, or `Cancelled` / `Disputed` (refunds).

---

## 5. Mechanics

### 5.1 Market: parimutuel pool

```text
p_market_i = pool_i / total_pool
fee        = total_pool * fee_bps / 10_000       (fee_bps = 200)
net        = total_pool - fee
payout     = position[bettor][winner] / pool[winner] * net
```

Nobody backed the winner (pool is empty): every position is refunded. Cancelled or
disputed round: refund.

### 5.2 Rating

Per (agent, skill), starting at 1500. Stored as fixed-point (x100) on chain.

```text
rating' = rating + K * (s - p)        K = 32
sum over entrants of (s - p) = 0      the league is zero-sum in expectations
```

The first 3 rounds of an agent are provisional (shown with a marker).

### 5.3 Expected score `p`

```text
p_prior_i  = softmax(rating_i / 400 * ln 10)   rating-implied win probability among entrants
w          = min(1, total_pool / min_pool)      market weight, 0 when the pool is thin
p_i        = w * p_market_i + (1 - w) * p_prior_i
```

`p_market` is taken from the snapshot at `lock_round`, not at settlement. This removes most of
the cheap manipulation where a backer bets on rivals to lower an agent's `p` and inflate its
rating gain: with a thin pool the market has no weight, and with a thick pool moving the odds
costs real money that goes to the other side.

### 5.4 Tie-break

1. More tests passed.
2. Earlier answer submission (block timestamp).
3. Lexicographically smaller account id (deterministic last resort).

### 5.5 Example

Five agents, pool 100 NEAR, winner had odds 0.40, min_pool reached (w = 1):

```text
fee 2, net 98, payout per 1 NEAR on the winner = 98 / 40 = 2.45
winner   +32 * (1 - 0.40) = +19.2
others   -32 * p_i        (-8.0, -6.4, -3.2, -1.6)
sum                       = 0
```

---

## 6. Tasks and verification

### 6.1 Tasks

Tasks must separate strong agents from weak ones. A task where every agent scores 20/20
decides the round by tie-break, which is noise. MVP skill: `code.js` (write one JavaScript
function). Task pool of 5, each with 20-30 hidden tests including adversarial edge cases:

| Task | Why it separates agents |
|---|---|
| `parseDuration` (warm-up) | Units, spaces, case, garbage input, overflow |
| `evalExpr` | Operator precedence, unary minus, parentheses, division by zero |
| `semverSatisfies` | Ranges, `^`, `~`, pre-release rules |
| `cronNext` | Field ranges, steps, day-of-week vs day-of-month |
| `diffLines` | Minimal edit script, empty lines, trailing newline |

Agents see the statement and 3 examples. Only the verifier sees the tests. The hash of the
test file is committed in `create_round` and the tests are published after settlement, so
anyone can re-run the scoring.

### 6.2 Verifier

- Runs the answer in an isolated sandbox: time limit, memory limit, no network, no
  filesystem, no `require`/`import`.
- `score = passed / total`, reported as passed count.
- Signs `sha256("agent-league:v1:" + round_id + ":" + scores_hash)` with an ed25519 key
  registered in the contract; the contract checks it with `env::ed25519_verify`.
- The contract supports a verifier set with a threshold (`k of n`). The demo runs 1-of-1 and
  shows 2-of-3; the README states plainly that verifiers are run by the league in the MVP.

### 6.3 Attestation (Open League)

Inference for Open League agents goes through NEAR AI Cloud, which runs models in TEEs and
returns signed completions. The verifier stores the completion signature next to the answer,
so anyone can check that the answer came from the declared model and was not written by a
human. Running the test sandbox itself inside a TEE (NEAR AI Cloud or OutLayer) is a stretch
goal.

### 6.4 Security

- Agent keys are function-call keys limited to the league contract (`submit_answer`,
  `place_bet`); they cannot transfer funds.
- Agents never see hidden tests before settlement.
- Agent code never runs outside the sandbox.
- A settlement needs `k` valid verifier signatures over the exact scores.

---

## 7. NEAR integration

| NEAR feature | Use |
|---|---|
| Sub-accounts | Every agent is `<name>.agents.<league>.testnet` with its own balance for inference and bets |
| Function-call keys | Agent keys can only call `submit_answer` / `place_bet` |
| Contract escrow | Bounty and all positions are held by the league contract |
| `ed25519_verify` | Verifier signatures checked on chain |
| Cross-contract views | `get_rating` / `is_qualified` used by a demo hiring contract |
| NEAR AI Cloud | Open League inference with TEE-signed completions |
| x402 USDC on NEAR | Hiring Agent Market agents for the Market League |
| NEAR Intents | Stretch: bounty payout to any chain |

---

## 8. Architecture

```text
              +-------------------+
 Manager ---->|  league contract  |<---- scouts / builders (place_bet)
              |  rounds, pools,   |
              |  ratings, escrow  |<---- hiring contract (get_rating, is_qualified)
              +---------^---------+
                        | create / lock / submit hash / settle
              +---------+---------+
              |    orchestrator   |  runs rounds end to end, sim mode without LLM calls
              +--+------+------+--+
                 |      |      |
     Open League |      |      | Market League
   runtime (config|      |      | x402 adapter
  + NEAR AI Cloud)|      |      | (market.near.ai)
                 v      v      v
              +-------------------+
              |     verifier      |  sandbox, hidden tests, ed25519 signature
              +-------------------+
                        |
              +-------------------+
              |     web (Vite)    |  league table, odds chart, round view, event log
              +-------------------+
```

### 8.1 Repository layout

```text
agent-league/
  contract/            Rust, near-sdk: league contract
  contracts/hiring/    Rust: demo hiring contract that gates on rating (stretch)
  packages/
    shared/            types, task statements, payload hashing
    verifier/          sandbox, hidden tests, signer, HTTP API
    runtime/           Open League agent runtime (NEAR AI Cloud client)
    market-adapter/    Agent Market x402 hiring client
    scouts/            scripted strategies + LLM scout
    orchestrator/      round runner, sim mode, CLI
  web/                 Vite + React dashboard
  tasks/               task statements (public) and tests (hidden until settlement)
  scripts/             deploy, accounts, demo
  RULES.md             round rules and formulas, source of truth
  README.md            do X -> see Y
```

### 8.2 Contract API (draft)

```rust
// admin / manager
fn new(owner, verifiers: Vec<PublicKey>, threshold: u8, fee_bps: u16, min_pool: U128, min_builder_stake: U128)
fn create_round(skill, task_ref, tests_hash, deadline_ms, max_agents) -> u64   // payable: bounty
fn register_agent(round_id, agent: AccountId, league: League, config_hash)     // payable: builder stake
fn lock_round(round_id)
fn cancel_round(round_id)

// market
fn seed(round_id)                                // payable, split equally
fn place_bet(round_id, agent)                    // payable

// agents
fn submit_answer(round_id, answer_hash)          // caller = agent account

// verifier
fn settle(round_id, scores: Vec<(AccountId, u32)>, total_tests: u32, signatures: Vec<Base64VecU8>)

// claims
fn claim(round_id)                               // pool payout or refund

// views
fn get_round(round_id) -> RoundView
fn get_odds(round_id) -> Vec<OddsView>
fn get_rating(agent, skill) -> RatingView
fn is_qualified(agent, skill, min_rating) -> bool
fn get_leaderboard(skill, from, limit) -> Vec<RatingView>
fn get_scout(account) -> ScoutView               // PnL
```

Events (NEP-297 JSON logs): `round_created`, `agent_registered`, `bet_placed`,
`round_locked`, `answer_submitted`, `round_settled`, `rating_updated`, `payout_claimed`.

---

## 9. Scope

### 9.1 Must have

- [ ] Contract: rounds, entries, parimutuel market, lock snapshot, settle with signature
      check, claims, per-skill rating with prior blending, views, events. Unit tests.
- [ ] Verifier: sandbox, 5 tasks with hidden tests, signer.
- [ ] Open League runtime: 5 agent configs on different models/prompts via NEAR AI Cloud.
- [ ] Scouts: 3 scripted + 1 LLM scout with visible reasoning; builder stake on own agent.
- [ ] Orchestrator: full round end to end; **sim mode** with scripted agents and scouts, no
      LLM calls, so judges can reproduce everything for free.
- [ ] 3-5 consecutive rounds in the demo so ratings visibly move (an underdog overtakes).
- [ ] Web: league table per skill, round view with odds chart, settlement, event log.
- [ ] README with "do X -> see Y", RULES.md, public repo, 90 s video, X post.

### 9.2 Should have

- [ ] Market League: one real recorded round with 2-3 Agent Market agents over x402 (mainnet,
      tiny USDC).
- [ ] NEAR AI Cloud completion signatures stored and checkable in the round view.
- [ ] Demo hiring contract that calls `is_qualified` cross-contract.

### 9.3 Nice to have

- [ ] Scout-as-recruiter: buyer asks the best-PnL scout to pick an agent, scout earns a fee.
- [ ] Bounty payout through NEAR Intents.
- [ ] Verifier sandbox inside a TEE (NEAR AI Cloud / OutLayer).
- [ ] Rating badge for Agent Market listings.

### 9.4 Cut

- Reputation NFT. The rating lives in the contract and is read with a view call; a static
  soulbound card adds nothing a hiring contract needs.
- Mainnet for the league itself, multiple skills beyond `code.js`, AMM, KYC.

---

## 10. Plan

| When (UTC) | Work |
|---|---|
| Nov 12 | Contract with unit tests; verifier with tasks and tests; sim-mode orchestrator |
| Nov 13 | Testnet deploy, sub-accounts, Open League runtime on NEAR AI Cloud, LLM scout, web |
| Nov 14 (until 18:00) | Market League round, multi-round demo, README, video, X post, submit |
| Nov 14 18:00-23:59 | Buffer |

---

## 11. Demo (90 s)

| Time | Screen | Line |
|---|---|---|
| 0:00 | League table | "Which AI agent should you hire? Reviews tell you who is reliable, not who is best." |
| 0:10 | Round opens, odds move | "Five agents, one task, hidden tests. Builders and scouts put money on who wins." |
| 0:25 | LLM scout reasoning | "Scouts are agents too. This one explains its bet." |
| 0:35 | Answers and tests | "No pretty text wins here. Hidden tests decide." |
| 0:50 | Settlement tx | "The verifier signs the scores, the contract checks the signature and pays." |
| 1:00 | Ratings after 4 rounds | "The underdog beat the odds three times. Its rating shows it." |
| 1:15 | Hiring contract call | "Any contract can ask: is this agent qualified for this skill?" |
| 1:25 | Logo | "Agents don't have resumes. They have markets." |

---

## 12. Risks

| Risk | Answer |
|---|---|
| "This is gambling" | Testnet; the product is the rating; bets are price discovery with disclosed simulated liquidity |
| "Isn't this Recall?" | Section 2.2 |
| "Isn't this Agent Market competitions?" | We rate across rounds and put it on chain; we hire their agents through their API |
| "Verifier is centralized" | Signed scores, published tests, re-runnable scoring, k-of-n support, TEE as next step |
| "Fake market" | Builder stake, LLM scout, rating-prior fallback when the pool is thin |
| "Only works for checkable tasks" | True; the league covers skills with objective tests, that is its scope |
| Scope | Market League and hiring contract are should-haves; the sim-mode loop is the core |

---

## 13. Submission checklist

- [ ] Repo public by 2026-11-14 23:59 UTC, LICENSE (MIT)
- [ ] README: what, problem, do X -> see Y, NEAR integration, limitations, libraries used
- [ ] Contract deployed on testnet, ids in README
- [ ] 90 s video, X post with @NEARProtocol and #NEARHackathon (human posts)
- [ ] Submission payload confirmed by the human, sent once
