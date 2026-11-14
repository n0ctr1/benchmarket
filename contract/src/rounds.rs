//! Round lifecycle: registration, the LMSR market, answers, cancellation and claims.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::legacy::{RoundStatusV1, RoundV1};
use crate::*;

/// What a round created by anyone but the league pays for its storage (about 1 kB, kept for good).
pub const ROUND_STORAGE_FEE: u128 = 10_000_000_000_000_000_000_000;
/// The longest betting window a round may set, so a builder's bond cannot be held for years.
pub const MAX_BET_WINDOW_MS: u64 = 30 * 24 * 3_600_000;

#[near]
impl Contract {
    // ----- manager -----

    /// Opens a round on `task_ref` (its difficulty record is created on first use). The
    /// attached deposit is the bounty. `attested` rounds accept only answers that carry an
    /// inference attestation. A round on a curated task moves ratings unless `rated` is false
    /// (the league plays its simulated rounds unrated).
    #[payable]
    pub fn create_round(
        &mut self,
        skill: String,
        task_ref: String,
        tests_hash: String,
        bet_deadline_ms: u64,
        max_agents: u8,
        attested: Option<bool>,
        rated: Option<bool>,
    ) -> u64 {
        require!(!skill.is_empty() && skill.len() <= 64, "bad skill");
        require!(!tests_hash.is_empty() && tests_hash.len() <= 128, "bad tests hash");
        require!(max_agents >= 2 && max_agents <= MAX_AGENTS, "max_agents must be 2..=16");
        require!(bet_deadline_ms > env::block_timestamp_ms(), "deadline in the past");
        require!(bet_deadline_ms <= env::block_timestamp_ms() + MAX_BET_WINDOW_MS, "the betting window is at most 30 days");
        // A round and its task record stay in state for good: anyone but the league pays for that
        // storage up front, a fee that is not part of the bounty and is never refunded.
        let deposit = env::attached_deposit().as_yoctonear();
        let fee = if env::predecessor_account_id() == self.owner { 0 } else { ROUND_STORAGE_FEE };
        require!(deposit >= fee, "attach the round storage fee (0.01 NEAR) plus any bounty");
        let (task_rating, curated) = self.use_task(&task_ref, &skill, &tests_hash);
        let rated = curated && rated.unwrap_or(true);
        let id = self.next_round_id;
        self.next_round_id += 1;
        let bounty = deposit - fee;
        let round = Round {
            id,
            manager: env::predecessor_account_id(),
            skill,
            task_ref,
            tests_hash,
            bet_deadline_ms,
            answer_deadline_ms: 0,
            max_agents,
            attested: attested.unwrap_or(false),
            rated,
            bounty,
            status: RoundStatus::Open,
            entries: vec![],
            liquidity: 0,
            subsidy: 0,
            volume: 0,
            fees: 0,
            bettors: vec![],
            payout_mode: PayoutMode::Pending,
            winners: vec![],
            payout_budget: 0,
            paid_out: 0,
            total_tests: 0,
            task_rating_before: task_rating,
            task_delta: 0,
            proposal: None,
            dispute: None,
            created_at_ms: env::block_timestamp_ms(),
            locked_at_ms: None,
            settled_at_ms: None,
        };
        emit(
            "round_created",
            json!({
                "round_id": id,
                "manager": round.manager,
                "skill": round.skill,
                "task_ref": round.task_ref,
                "tests_hash": round.tests_hash,
                "bet_deadline_ms": bet_deadline_ms,
                "bounty": U128(bounty),
                "attested": round.attested,
                "task_rating": task_rating,
                "rated": rated,
            }),
        );
        self.rounds.insert(id, round);
        id
    }

    /// Enters an agent that holds a passport. Only the agent itself or the account that issued
    /// its passport may enter it: a non-answer costs rating, so nobody can drag an agent into a
    /// round it did not choose. The caller is its builder and posts a bond (at least
    /// `min_builder_stake`), returned if the agent answers. The manager posts no bond.
    #[payable]
    pub fn register_agent(&mut self, round_id: u64, agent: AccountId, league: League, config_hash: String) {
        let builder = env::predecessor_account_id();
        let bond = env::attached_deposit().as_yoctonear();
        let min_bond = self.params.min_builder_stake.0;
        let issuer = self.identities.get(&agent).map(|i| i.issuer.clone()).unwrap_or_else(|| env::panic_str("agent has no identity: call register_identity first"));
        require!(builder == agent || builder == issuer, "only the agent or its passport issuer can enter it");
        require!(config_hash.len() <= 128, "config hash too long");
        let round = self.round_mut(round_id);
        require!(round.status == RoundStatus::Open, "registration is closed");
        require!(env::block_timestamp_ms() < round.bet_deadline_ms, "registration closed");
        require!((round.entries.len() as u8) < round.max_agents, "round is full");
        require!(round.entries.iter().all(|e| e.agent != agent), "agent already registered");
        if builder != round.manager {
            require!(bond >= min_bond, "builder stake below minimum");
        }
        round.entries.push(Entry {
            agent: agent.clone(),
            builder: builder.clone(),
            league,
            config_hash: config_hash.clone(),
            bond,
            shares: 0,
            p_ppm: 0,
            price_ppm: 0,
            answer_hash: None,
            answered_at_ms: None,
            attested: false,
            model: None,
            request_hash: None,
            score: None,
            rating_before: 0,
            field_delta: 0,
            task_delta: 0,
        });
        let index = round.entries.len() - 1;
        emit(
            "agent_registered",
            json!({ "round_id": round_id, "agent": agent, "builder": builder, "league": league, "config_hash": config_hash, "stake": U128(bond) }),
        );
        if bond > 0 {
            let pos = self.positions.entry((round_id, builder)).or_default();
            if pos.bonds.len() <= index {
                pos.bonds.resize(index + 1, 0);
            }
            pos.bonds[index] += bond;
        }
    }

    /// Closes registration and funds the market maker. The attached deposit is the subsidy,
    /// the maker's maximum loss: liquidity `b = subsidy / ln(n)`.
    #[payable]
    pub fn open_market(&mut self, round_id: u64) {
        let caller = env::predecessor_account_id();
        let subsidy = env::attached_deposit().as_yoctonear();
        let round = self.round_mut(round_id);
        require!(caller == round.manager, "only the manager opens the market");
        require!(round.status == RoundStatus::Open, "round is not open");
        require!(env::block_timestamp_ms() < round.bet_deadline_ms, "betting closed");
        require!(round.entries.len() >= 2, "need at least 2 agents");
        let b = math::lmsr_b(subsidy, round.entries.len());
        require!(b > 0, "attach a subsidy for the market maker");
        round.subsidy = subsidy;
        round.liquidity = b;
        round.status = RoundStatus::Trading;
        emit("market_opened", json!({ "round_id": round_id, "subsidy": U128(subsidy), "liquidity": U128(b), "agents": round.entries.len() }));
    }

    // ----- market -----

    /// Buys shares of `agent` with the attached deposit (minus the fee). Each share pays one
    /// yoctoNEAR if the agent wins (split between tied winners). `min_shares` guards against
    /// the price moving before the call lands.
    #[payable]
    pub fn buy(&mut self, round_id: u64, agent: AccountId, min_shares: Option<U128>) -> U128 {
        let caller = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        let fee_bps = self.params.fee_bps;
        let max_bettors = self.params.max_bettors as usize;
        require!(amount >= self.params.min_bet.0, "bet below minimum");
        let round = self.round_mut(round_id);
        require!(round.status == RoundStatus::Trading, "market is not open");
        require!(env::block_timestamp_ms() < round.bet_deadline_ms, "betting closed");
        let i = round.entries.iter().position(|e| e.agent == agent).unwrap_or_else(|| env::panic_str("agent not in this round"));
        // Entrants and the builders who staked them do not trade their own round: buying a rival
        // raises its expected share and so cuts the rival's rating gain.
        require!(round.entries.iter().all(|e| e.agent != caller && (e.bond == 0 || e.builder != caller)), "entrants and their builders cannot trade this round");
        let fee = amount * fee_bps as u128 / 10_000;
        let spend = amount - fee;
        let shares: Vec<u128> = round.entries.iter().map(|e| e.shares).collect();
        let before = math::lmsr_prices_ppm(&shares, round.liquidity)[i];
        let got = math::lmsr_buy(&shares, round.liquidity, i, spend);
        require!(got > 0, "purchase too small");
        require!(got >= min_shares.map_or(0, |m| m.0), "price moved: fewer shares than min_shares");
        if !round.bettors.contains(&caller) {
            require!(round.bettors.len() < max_bettors, "too many traders in this round");
            round.bettors.push(caller.clone());
        }
        round.entries[i].shares += got;
        round.volume += spend;
        round.fees += fee;
        let n = round.entries.len();
        let after: Vec<u128> = round.entries.iter().map(|e| e.shares).collect();
        let prices = math::lmsr_prices_ppm(&after, round.liquidity);
        let pos = self.positions.entry((round_id, caller.clone())).or_default();
        if pos.shares.len() < n {
            pos.shares.resize(n, 0);
        }
        pos.shares[i] += got;
        pos.paid += amount;
        pos.spent += spend;
        let scout = self.scouts.entry(caller.clone()).or_default();
        scout.staked += amount;
        scout.bets += 1;
        emit(
            "bet_placed",
            json!({
                "round_id": round_id,
                "bettor": caller,
                "agent": agent,
                "amount": U128(amount),
                "shares": U128(got),
                "price_before_ppm": before,
                "prices_ppm": prices,
            }),
        );
        U128(got)
    }

    /// Fixes the odds. The manager may lock at any time; anyone may after the deadline.
    /// Expected scores blend market prices with the rating prior by market volume.
    pub fn lock_round(&mut self, round_id: u64) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let min_pool = self.params.min_pool.0;
        let window = self.params.answer_window_ms;
        let mut round = self.rounds.remove(&round_id).unwrap_or_else(|| env::panic_str("no such round"));
        require!(round.status == RoundStatus::Open || round.status == RoundStatus::Trading, "round is not open");
        require!(caller == round.manager || now >= round.bet_deadline_ms, "only the manager can lock before the deadline");
        require!(round.entries.len() >= 2, "need at least 2 agents");
        let shares: Vec<u128> = round.entries.iter().map(|e| e.shares).collect();
        let ratings: Vec<i64> = round.entries.iter().map(|e| self.rating_of(&e.agent, &round.skill).rating).collect();
        let prices = math::lmsr_prices_ppm(&shares, round.liquidity);
        let p = math::blend_ppm(&prices, &math::prior_odds_ppm(&ratings), round.volume, min_pool);
        for (i, e) in round.entries.iter_mut().enumerate() {
            e.price_ppm = prices[i];
            e.p_ppm = p[i];
            e.rating_before = ratings[i];
        }
        round.task_rating_before = self.tasks.get(&round.task_ref).map_or(INITIAL_RATING, |t| t.rating);
        round.status = RoundStatus::Locked;
        round.locked_at_ms = Some(now);
        round.answer_deadline_ms = now + window;
        emit(
            "round_locked",
            json!({
                "round_id": round_id,
                "volume": U128(round.volume),
                "answer_deadline_ms": round.answer_deadline_ms,
                "task_rating": round.task_rating_before,
                "odds": round.entries.iter().map(|e| json!({
                    "agent": e.agent,
                    "market_ppm": e.price_ppm,
                    "p_ppm": e.p_ppm,
                    "rating": e.rating_before,
                })).collect::<Vec<_>>(),
            }),
        );
        self.rounds.insert(round_id, round);
    }

    // ----- agents -----

    /// Commits the agent's answer by hash; the answer itself goes to the verifier. With an
    /// attestation, the hash must be the response hash NEAR AI signed.
    pub fn submit_answer(&mut self, round_id: u64, answer_hash: String, attestation: Option<Attestation>) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        require!(!answer_hash.is_empty() && answer_hash.len() <= 128, "bad answer hash");
        let proof = attestation.map(|a| attest::verify(&a, &self.inference_signers).unwrap_or_else(|e| env::panic_str(&e)));
        let round = self.round_mut(round_id);
        require!(round.status == RoundStatus::Locked, "answers are accepted only after lock");
        require!(now <= round.answer_deadline_ms, "answer deadline passed");
        let attested_round = round.attested;
        let entry = round
            .entries
            .iter_mut()
            .find(|e| e.agent == caller)
            .unwrap_or_else(|| env::panic_str("caller is not an agent in this round"));
        require!(entry.answer_hash.is_none(), "answer already submitted");
        match &proof {
            Some(p) => {
                require!(answer_hash == format!("sha256:{}", p.response_hash), "answer hash must be the attested response hash");
                entry.attested = true;
                entry.model = p.model.clone();
                entry.request_hash = Some(p.request_hash.clone());
            }
            None => require!(!attested_round, "this round requires an inference attestation"),
        }
        entry.answer_hash = Some(answer_hash.clone());
        entry.answered_at_ms = Some(now);
        emit(
            "answer_submitted",
            json!({ "round_id": round_id, "agent": caller, "answer_hash": answer_hash, "at_ms": now, "attested": proof.is_some() }),
        );
    }

    // ----- cancel -----

    /// The manager may cancel before scores are posted. Anyone may cancel a round whose
    /// verifier missed the settle timeout. Every purchase, bond, subsidy and bounty is returned.
    pub fn cancel_round(&mut self, round_id: u64) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let timeout = self.params.settle_timeout_ms;
        let round = self.round_ref(round_id);
        // A brief's tryout cannot be called off by its client, who would see it play out and then
        // walk away refunded: only the settle timeout cancels it.
        let by_manager = caller == round.manager
            && !env::storage_has_key(&tryout_key(round_id))
            && matches!(round.status, RoundStatus::Open | RoundStatus::Trading | RoundStatus::Locked);
        let stale = round.status == RoundStatus::Locked && now > round.answer_deadline_ms + timeout;
        // A round that never filled can never lock: after the betting deadline plus the settle
        // timeout anyone may call it off, so an absent manager cannot hold the bonds.
        let unfilled = matches!(round.status, RoundStatus::Open | RoundStatus::Trading) && round.entries.len() < 2 && now > round.bet_deadline_ms + timeout;
        require!(by_manager || stale || unfilled, "only the manager can cancel (never a brief's tryout), or anyone after the settle timeout");
        self.cancel(round_id, "cancelled");
    }

    // ----- claims -----

    /// Pays the caller's position: winning shares (or a refund) and bonds of agents that answered.
    pub fn claim(&mut self, round_id: u64) -> U128 {
        if round_id < self.first_lmsr_round {
            return self.claim_legacy(round_id);
        }
        let caller = env::predecessor_account_id();
        let key = (round_id, caller.clone());
        let pos = self.positions.get(&key).unwrap_or_else(|| env::panic_str("no position"));
        require!(!pos.claimed, "already claimed");
        let round = self.round_ref(round_id);
        require!(matches!(round.status, RoundStatus::Settled | RoundStatus::Cancelled), "round not finished");
        let cancelled = round.status == RoundStatus::Cancelled;
        let bonds: u128 = pos
            .bonds
            .iter()
            .enumerate()
            .filter(|(i, _)| cancelled || round.entries[*i].answer_hash.is_some())
            .map(|(_, b)| *b)
            .sum();
        let market = if cancelled || round.payout_mode == PayoutMode::Refund {
            pos.paid
        } else {
            let winners: Vec<usize> = round.winners.iter().map(|w| *w as usize).collect();
            math::position_payout(&pos.shares, &winners).min(round.payout_budget - round.paid_out)
        };
        let refund = cancelled || round.payout_mode == PayoutMode::Refund;
        let r = self.round_mut(round_id);
        if !refund {
            r.paid_out += market;
        }
        self.positions.get_mut(&key).unwrap().claimed = true;
        if market > 0 || refund {
            let scout = self.scouts.entry(caller.clone()).or_default();
            scout.returned += market;
        }
        let amount = market + bonds;
        emit("payout_claimed", json!({ "round_id": round_id, "account": caller, "amount": U128(amount), "bonds": U128(bonds) }));
        if amount > 0 {
            Promise::new(caller).transfer(NearToken::from_yoctonear(amount)).detach();
        }
        U128(amount)
    }

    // ----- views -----

    pub fn get_round(&self, round_id: u64) -> Option<RoundView> {
        if round_id < self.first_lmsr_round {
            return self.legacy_rounds.get(&round_id).map(legacy_view);
        }
        self.rounds.get(&round_id).map(round_view)
    }

    /// Rounds in descending id order, starting below `before` (exclusive) if given.
    pub fn get_rounds(&self, before: Option<u64>, limit: Option<u64>) -> Vec<RoundView> {
        let start = before.unwrap_or(self.next_round_id).min(self.next_round_id);
        let limit = limit.unwrap_or(10).min(50);
        (1..start).rev().filter_map(|id| self.get_round(id)).take(limit as usize).collect()
    }

    pub fn get_position(&self, round_id: u64, account: AccountId) -> Vec<PositionView> {
        if round_id < self.first_lmsr_round {
            let (Some(r), Some(p)) = (self.legacy_rounds.get(&round_id), self.legacy_positions.get(&(round_id, account))) else {
                return vec![];
            };
            return r
                .entries
                .iter()
                .enumerate()
                .map(|(i, e)| PositionView { agent: e.agent.clone(), amount: U128(p.amounts.get(i).copied().unwrap_or(0)), bond: U128(0) })
                .collect();
        }
        let (Some(r), Some(p)) = (self.rounds.get(&round_id), self.positions.get(&(round_id, account))) else {
            return vec![];
        };
        r.entries
            .iter()
            .enumerate()
            .map(|(i, e)| PositionView {
                agent: e.agent.clone(),
                amount: U128(p.shares.get(i).copied().unwrap_or(0)),
                bond: U128(p.bonds.get(i).copied().unwrap_or(0)),
            })
            .collect()
    }

    /// Shares that `amount` (before the fee) would buy right now.
    pub fn quote(&self, round_id: u64, agent: AccountId, amount: U128) -> U128 {
        let round = self.round_ref(round_id);
        let i = round.entries.iter().position(|e| e.agent == agent).unwrap_or_else(|| env::panic_str("agent not in this round"));
        let spend = amount.0 - amount.0 * self.params.fee_bps as u128 / 10_000;
        let shares: Vec<u128> = round.entries.iter().map(|e| e.shares).collect();
        U128(math::lmsr_buy(&shares, round.liquidity, i, spend))
    }
}

impl Contract {
    pub(crate) fn round_ref(&self, round_id: u64) -> &Round {
        self.rounds.get(&round_id).unwrap_or_else(|| env::panic_str("no such round"))
    }

    pub(crate) fn round_mut(&mut self, round_id: u64) -> &mut Round {
        self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("no such round"))
    }

    /// Cancels a round: claims become refunds; bounty and subsidy go back to the manager.
    pub(crate) fn cancel(&mut self, round_id: u64, reason: &str) {
        let now = env::block_timestamp_ms();
        let round = self.round_mut(round_id);
        round.status = RoundStatus::Cancelled;
        round.payout_mode = PayoutMode::Refund;
        round.settled_at_ms = Some(now);
        let back = round.bounty + round.subsidy;
        let manager = round.manager.clone();
        emit("round_cancelled", json!({ "round_id": round_id, "reason": reason }));
        if back > 0 {
            Promise::new(manager).transfer(NearToken::from_yoctonear(back)).detach();
        }
    }

    fn claim_legacy(&mut self, round_id: u64) -> U128 {
        let caller = env::predecessor_account_id();
        let round = self.legacy_rounds.get(&round_id).unwrap_or_else(|| env::panic_str("no such round"));
        require!(matches!(round.status, RoundStatusV1::Settled | RoundStatusV1::Cancelled), "round not finished");
        let key = (round_id, caller.clone());
        let pos = self.legacy_positions.get(&key).unwrap_or_else(|| env::panic_str("no position"));
        require!(!pos.claimed, "already claimed");
        let amount = legacy::legacy_claim_amount(round, pos);
        let won = round.payout_mode == PayoutMode::Winners && amount > 0;
        self.legacy_positions.get_mut(&key).unwrap().claimed = true;
        let scout = self.scouts.entry(caller.clone()).or_default();
        scout.returned += amount;
        if won {
            scout.wins += 1;
        }
        emit("payout_claimed", json!({ "round_id": round_id, "account": caller, "amount": U128(amount) }));
        if amount > 0 {
            Promise::new(caller).transfer(NearToken::from_yoctonear(amount)).detach();
        }
        U128(amount)
    }
}

pub(crate) fn round_view(r: &Round) -> RoundView {
    let shares: Vec<u128> = r.entries.iter().map(|e| e.shares).collect();
    let odds = math::lmsr_prices_ppm(&shares, r.liquidity);
    let winners: Vec<AccountId> = r.winners.iter().map(|w| r.entries[*w as usize].agent.clone()).collect();
    RoundView {
        id: r.id,
        market: "lmsr".into(),
        manager: r.manager.clone(),
        skill: r.skill.clone(),
        task_ref: r.task_ref.clone(),
        tests_hash: r.tests_hash.clone(),
        bet_deadline_ms: r.bet_deadline_ms,
        answer_deadline_ms: r.answer_deadline_ms,
        max_agents: r.max_agents,
        attested: r.attested,
        rated: r.rated,
        bounty: U128(r.bounty),
        status: r.status,
        entries: r
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| EntryView {
                agent: e.agent.clone(),
                builder: e.builder.clone(),
                league: e.league,
                config_hash: e.config_hash.clone(),
                bond: U128(e.bond),
                shares: U128(e.shares),
                odds_ppm: odds[i],
                p_ppm: e.p_ppm,
                market_ppm: e.price_ppm,
                answer_hash: e.answer_hash.clone(),
                answered_at_ms: e.answered_at_ms,
                attested: e.attested,
                model: e.model.clone(),
                request_hash: e.request_hash.clone(),
                score: e.score,
                rating_before: e.rating_before,
                rating_delta: e.field_delta + e.task_delta,
                field_delta: e.field_delta,
                task_delta: e.task_delta,
            })
            .collect(),
        liquidity: U128(r.liquidity),
        subsidy: U128(r.subsidy),
        total_pool: U128(r.volume),
        fee: U128(r.fees),
        bettors: r.bettors.len() as u32,
        payout_mode: r.payout_mode,
        winner: winners.first().cloned(),
        winners,
        total_tests: r.total_tests,
        task_rating_before: r.task_rating_before,
        task_delta: r.task_delta,
        proposal: r.proposal.as_ref().map(|p| ProposalView {
            total_tests: p.total_tests,
            scores: r.entries.iter().zip(p.scores.iter()).map(|(e, s)| (e.agent.clone(), *s)).collect(),
            signers: p.signers.clone(),
            proposed_at_ms: p.proposed_at_ms,
            dispute_until_ms: p.dispute_until_ms,
        }),
        dispute: r.dispute.as_ref().map(|d| DisputeView { by: d.by.clone(), bond: U128(d.bond), at_ms: d.at_ms, overturned: d.overturned }),
        created_at_ms: r.created_at_ms,
        locked_at_ms: r.locked_at_ms,
        settled_at_ms: r.settled_at_ms,
    }
}

fn legacy_view(r: &RoundV1) -> RoundView {
    let pools: Vec<u128> = r.entries.iter().map(|e| e.pool).collect();
    let odds = math::market_odds_ppm(&pools);
    let winner = r.winner.map(|w| r.entries[w as usize].agent.clone());
    RoundView {
        id: r.id,
        market: "parimutuel".into(),
        manager: r.manager.clone(),
        skill: r.skill.clone(),
        task_ref: r.task_ref.clone(),
        tests_hash: r.tests_hash.clone(),
        bet_deadline_ms: r.bet_deadline_ms,
        answer_deadline_ms: 0,
        max_agents: r.max_agents,
        attested: false,
        rated: true,
        bounty: U128(r.bounty),
        status: match r.status {
            RoundStatusV1::Open => RoundStatus::Open,
            RoundStatusV1::Locked => RoundStatus::Locked,
            RoundStatusV1::Settled => RoundStatus::Settled,
            RoundStatusV1::Cancelled => RoundStatus::Cancelled,
        },
        entries: r
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| EntryView {
                agent: e.agent.clone(),
                builder: e.builder.clone(),
                league: e.league,
                config_hash: e.config_hash.clone(),
                bond: U128(0),
                shares: U128(e.pool),
                odds_ppm: odds[i],
                p_ppm: e.p_ppm,
                market_ppm: e.market_ppm,
                answer_hash: e.answer_hash.clone(),
                answered_at_ms: e.answered_at_ms,
                attested: false,
                model: None,
                request_hash: None,
                score: e.score,
                rating_before: e.rating_before,
                rating_delta: e.rating_delta,
                field_delta: e.rating_delta,
                task_delta: 0,
            })
            .collect(),
        liquidity: U128(0),
        subsidy: U128(0),
        total_pool: U128(r.total_pool),
        fee: U128(r.fee),
        bettors: 0,
        payout_mode: r.payout_mode,
        winners: winner.iter().cloned().collect(),
        winner,
        total_tests: r.total_tests,
        task_rating_before: 0,
        task_delta: 0,
        proposal: None,
        dispute: None,
        created_at_ms: r.created_at_ms,
        locked_at_ms: r.locked_at_ms,
        settled_at_ms: r.settled_at_ms,
    }
}
