//! Settlement: verifier-signed scores, the dispute window, arbiters, verifier stakes and
//! finalization (payouts, ratings, task difficulty, scout skill).

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise, PublicKey};

use crate::*;

pub const ROUND_DOMAIN: &str = "benchmarket:v1";
pub const ROUND_ARBITER_DOMAIN: &str = "benchmarket:arbiter:v1";

#[near]
impl Contract {
    // ----- verifiers -----

    /// Posts verifier-signed scores. They take effect after the dispute window (`finalize`),
    /// or at once when the window is zero. Needs `threshold` signatures from distinct, staked
    /// verifier keys. Allowed once every agent answered or the answer deadline passed.
    pub fn settle(&mut self, round_id: u64, total_tests: u32, scores: Vec<(AccountId, u32)>, signatures: Vec<Base64VecU8>) {
        let now = env::block_timestamp_ms();
        let window = self.params.dispute_window_ms;
        let round = self.round_ref(round_id);
        require!(round.status == RoundStatus::Locked, "round is not locked");
        require!(
            now > round.answer_deadline_ms || round.entries.iter().all(|e| e.answer_hash.is_some()),
            "wait for every answer or the answer deadline"
        );
        let list = check_scores(round, total_tests, &scores);
        let message = math::signed_message(ROUND_DOMAIN, round_id, total_tests, &pairs(&scores));
        let signers = self.verify_signatures(&self.verifiers, self.threshold, true, &message, &signatures);
        let proposal = Proposal { total_tests, scores: list, signers, proposed_at_ms: now, dispute_until_ms: now + window };
        emit(
            "scores_proposed",
            json!({ "round_id": round_id, "total_tests": total_tests, "message": message, "dispute_until_ms": proposal.dispute_until_ms }),
        );
        let r = self.round_mut(round_id);
        r.proposal = Some(proposal);
        r.status = RoundStatus::Proposed;
        if window == 0 {
            self.finalize_round(round_id);
        }
    }

    /// Applies posted scores once the dispute window has passed. Anyone may call.
    pub fn finalize(&mut self, round_id: u64) {
        let round = self.round_ref(round_id);
        require!(round.status == RoundStatus::Proposed, "no undisputed scores to finalize");
        require!(env::block_timestamp_ms() >= round.proposal.as_ref().unwrap().dispute_until_ms, "dispute window still open");
        self.finalize_round(round_id);
    }

    /// Challenges posted scores during the dispute window. Anyone can re-run the published
    /// tests on the published answers; if they disagree, they post `dispute_bond` here.
    #[payable]
    pub fn dispute(&mut self, round_id: u64) {
        let caller = env::predecessor_account_id();
        let bond = env::attached_deposit().as_yoctonear();
        let now = env::block_timestamp_ms();
        require!(bond >= self.params.dispute_bond.0, "attach the dispute bond");
        let round = self.round_mut(round_id);
        require!(round.status == RoundStatus::Proposed, "nothing to dispute");
        require!(now < round.proposal.as_ref().unwrap().dispute_until_ms, "dispute window closed");
        round.status = RoundStatus::Disputed;
        round.dispute = Some(Dispute { by: caller.clone(), bond, at_ms: now, overturned: None });
        emit("round_disputed", json!({ "round_id": round_id, "by": caller, "bond": U128(bond) }));
    }

    /// Arbiters rule on a dispute with their own signed scores. If they match the proposal, the
    /// disputer's bond goes to the owner. If not, the proposing verifier keys lose their whole
    /// stake to the disputer, the bond is returned, and the arbiters' scores settle the round.
    pub fn resolve_dispute(&mut self, round_id: u64, total_tests: u32, scores: Vec<(AccountId, u32)>, signatures: Vec<Base64VecU8>) {
        let round = self.round_ref(round_id);
        require!(round.status == RoundStatus::Disputed, "round is not disputed");
        let list = check_scores(round, total_tests, &scores);
        let message = math::signed_message(ROUND_ARBITER_DOMAIN, round_id, total_tests, &pairs(&scores));
        self.verify_signatures(&self.arbiters, self.arbiter_threshold, false, &message, &signatures);
        let proposal = round.proposal.clone().unwrap();
        let dispute = round.dispute.clone().unwrap();
        let overturned = proposal.total_tests != total_tests || proposal.scores != list;
        if overturned {
            let slashed = self.slash(&proposal.signers);
            let to = dispute.by.clone();
            emit("verifier_slashed", json!({ "round_id": round_id, "keys": proposal.signers, "amount": U128(slashed), "to": to }));
            Promise::new(to).transfer(NearToken::from_yoctonear(slashed + dispute.bond)).detach();
        } else {
            Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(dispute.bond)).detach();
        }
        emit("dispute_resolved", json!({ "round_id": round_id, "overturned": overturned }));
        let now = env::block_timestamp_ms();
        let r = self.round_mut(round_id);
        r.dispute.as_mut().unwrap().overturned = Some(overturned);
        if overturned {
            r.proposal = Some(Proposal { total_tests, scores: list, signers: vec![], proposed_at_ms: now, dispute_until_ms: now });
        }
        self.finalize_round(round_id);
    }

    /// If arbiters do not rule within `resolve_timeout_ms`, anyone may cancel the round:
    /// everything is refunded, the disputer's bond included.
    pub fn expire_dispute(&mut self, round_id: u64) {
        let round = self.round_ref(round_id);
        require!(round.status == RoundStatus::Disputed, "round is not disputed");
        let d = round.dispute.clone().unwrap();
        require!(env::block_timestamp_ms() >= d.at_ms + self.params.resolve_timeout_ms, "arbiters still have time");
        self.cancel(round_id, "dispute expired");
        Promise::new(d.by).transfer(NearToken::from_yoctonear(d.bond)).detach();
    }

    // ----- verifier stakes -----

    /// Adds stake to a verifier key. The first staker owns the stake; only they can add more or
    /// withdraw. A key's signatures count only while it holds `min_verifier_stake`.
    #[payable]
    pub fn stake_verifier(&mut self, public_key: PublicKey) {
        ed25519_bytes(&public_key);
        let caller = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the stake");
        let s = self.verifier_stakes.entry(public_key.clone()).or_insert(VerifierStake { owner: caller.clone(), amount: 0, unlock_at_ms: None });
        require!(s.owner == caller, "this key's stake belongs to another account");
        s.amount += amount;
        s.unlock_at_ms = None;
        emit("verifier_staked", json!({ "public_key": public_key, "owner": caller, "amount": U128(s.amount) }));
    }

    /// Starts the unstake delay. The key stops counting at once but stays slashable until the
    /// delay ends, which covers any dispute it could still be part of.
    pub fn request_unstake(&mut self, public_key: PublicKey) {
        let delay = self.params.unstake_delay_ms;
        let s = self.verifier_stakes.get_mut(&public_key).unwrap_or_else(|| env::panic_str("no stake"));
        require!(s.owner == env::predecessor_account_id(), "not your stake");
        s.unlock_at_ms = Some(env::block_timestamp_ms() + delay);
    }

    pub fn withdraw_stake(&mut self, public_key: PublicKey) -> U128 {
        let s = self.verifier_stakes.get(&public_key).unwrap_or_else(|| env::panic_str("no stake"));
        require!(s.owner == env::predecessor_account_id(), "not your stake");
        require!(s.unlock_at_ms.map_or(false, |t| env::block_timestamp_ms() >= t), "stake is still locked");
        let s = self.verifier_stakes.remove(&public_key).unwrap();
        if s.amount > 0 {
            Promise::new(s.owner).transfer(NearToken::from_yoctonear(s.amount)).detach();
        }
        U128(s.amount)
    }

    pub fn get_verifier_stakes(&self) -> Vec<StakeView> {
        self.verifiers
            .iter()
            .chain(self.arbiters.iter())
            .filter_map(|pk| {
                self.verifier_stakes.get(pk).map(|s| StakeView {
                    public_key: pk.clone(),
                    owner: s.owner.clone(),
                    amount: U128(s.amount),
                    unlock_at_ms: s.unlock_at_ms,
                    active: self.stake_counts(pk),
                })
            })
            .collect()
    }
}

pub(crate) fn pairs(scores: &[(AccountId, u32)]) -> Vec<(&str, u32)> {
    scores.iter().map(|(a, s)| (a.as_str(), *s)).collect()
}

/// Scores must list every entrant once, in registration order; no answer means 0.
fn check_scores(round: &Round, total_tests: u32, scores: &[(AccountId, u32)]) -> Vec<u32> {
    require!(total_tests > 0, "total_tests must be positive");
    require!(scores.len() == round.entries.len(), "scores must cover every agent");
    scores
        .iter()
        .zip(round.entries.iter())
        .map(|((agent, score), e)| {
            require!(*agent == e.agent, "scores must follow registration order");
            require!(*score <= total_tests, "score above total");
            if e.answer_hash.is_none() {
                require!(*score == 0, "agent without an answer must score 0");
            }
            *score
        })
        .collect()
}

impl Contract {
    fn stake_counts(&self, pk: &PublicKey) -> bool {
        let min = self.params.min_verifier_stake.0;
        min == 0 || self.verifier_stakes.get(pk).map_or(false, |s| s.amount >= min && s.unlock_at_ms.is_none())
    }

    /// Distinct keys from `keys` with a valid signature over sha256(message); panics below `threshold`.
    pub(crate) fn verify_signatures(&self, keys: &[PublicKey], threshold: u8, staked: bool, message: &str, signatures: &[Base64VecU8]) -> Vec<PublicKey> {
        require!(threshold > 0 && !keys.is_empty(), "no keys configured for this decision");
        let digest = env::sha256_array(message.as_bytes());
        let mut used = vec![false; keys.len()];
        let mut signers = vec![];
        for sig in signatures.iter() {
            let Ok(bytes) = <[u8; 64]>::try_from(sig.0.as_slice()) else { continue };
            for (k, pk) in keys.iter().enumerate() {
                if !used[k] && env::ed25519_verify(&bytes, &digest, &ed25519_bytes(pk)) {
                    used[k] = true;
                    if !staked || self.stake_counts(pk) {
                        signers.push(pk.clone());
                    }
                    break;
                }
            }
        }
        require!(signers.len() >= threshold as usize, "not enough valid verifier signatures");
        signers
    }

    /// Takes the whole stake of each key; returns the total.
    pub(crate) fn slash(&mut self, keys: &[PublicKey]) -> u128 {
        let mut total = 0;
        for pk in keys {
            if let Some(s) = self.verifier_stakes.get_mut(pk) {
                total += s.amount;
                s.amount = 0;
            }
        }
        total
    }

    /// Applies the round's proposal: winners, money, ratings, task difficulty and scout skill.
    pub(crate) fn finalize_round(&mut self, round_id: u64) {
        let now = env::block_timestamp_ms();
        let k_field = self.params.k_field;
        let k_task = self.params.k_task;
        let owner = self.owner.clone();
        let mut round = self.rounds.remove(&round_id).unwrap();
        let proposal = round.proposal.clone().unwrap();
        let scores = proposal.scores.clone();
        for (e, s) in round.entries.iter_mut().zip(scores.iter()) {
            e.score = Some(*s);
        }
        round.total_tests = proposal.total_tests;
        round.status = RoundStatus::Settled;
        round.settled_at_ms = Some(now);
        let winners = math::winners(&scores);
        round.winners = winners.iter().map(|w| *w as u8).collect();

        let mut transfers: Vec<(AccountId, u128)> = vec![];
        let forfeited: u128 = round.entries.iter().filter(|e| e.answer_hash.is_none()).map(|e| e.bond).sum();
        if forfeited > 0 {
            transfers.push((owner.clone(), forfeited));
        }
        if winners.is_empty() {
            // Nobody scored: purchases are refunded, bounty and subsidy go back.
            round.payout_mode = PayoutMode::Refund;
            if round.bounty + round.subsidy > 0 {
                transfers.push((round.manager.clone(), round.bounty + round.subsidy));
            }
        } else {
            round.payout_mode = PayoutMode::Winners;
            if round.fees > 0 {
                transfers.push((owner.clone(), round.fees));
            }
            // Bounty split between tied winners; the remainder goes to the first.
            let n = winners.len() as u128;
            for (k, w) in winners.iter().enumerate() {
                let part = round.bounty / n + if k == 0 { round.bounty % n } else { 0 };
                if part > 0 {
                    transfers.push((round.entries[*w].agent.clone(), part));
                }
            }
            // The maker owes the winning shares; what is left of subsidy + volume returns to the manager.
            let owed: u128 = winners.iter().map(|w| round.entries[*w].shares).sum::<u128>().div_ceil(n);
            let funds = round.subsidy + round.volume;
            round.payout_budget = owed.min(funds);
            if funds > round.payout_budget {
                transfers.push((round.manager.clone(), funds - round.payout_budget));
            }
        }

        // Ratings: against the field (share of points vs expected) and against the task.
        // Only curated tasks are rated.
        if round.rated {
            // An agent entered by someone else (a scout's tryout nomination) that never answered
            // did not choose to play: it is not rated and the round does not count for it.
            let counted: Vec<bool> = round
                .entries
                .iter()
                .map(|e| e.answer_hash.is_some() || e.builder == e.agent || self.identities.get(&e.agent).is_some_and(|i| i.issuer == e.builder))
                .collect();
            let agents: Vec<AccountId> = round.entries.iter().map(|e| e.agent.clone()).collect();
            let before: Vec<i64> = round.entries.iter().map(|e| e.rating_before).collect();
            let field = if winners.is_empty() {
                vec![0; agents.len()]
            } else {
                let p: Vec<u64> = round.entries.iter().map(|e| e.p_ppm).collect();
                math::rating_deltas(&p, &scores, winners[0], k_field)
            };
            // The task is rated against the agents that count only.
            let idx: Vec<usize> = (0..agents.len()).filter(|i| counted[*i]).collect();
            let (task_c, task_delta) = math::task_deltas(
                &idx.iter().map(|i| before[*i]).collect::<Vec<_>>(),
                round.task_rating_before,
                &idx.iter().map(|i| scores[*i]).collect::<Vec<_>>(),
                round.total_tests,
                k_task,
            );
            let mut task = vec![0i64; agents.len()];
            for (k, i) in idx.iter().enumerate() {
                task[*i] = task_c[k];
            }
            let total: Vec<i64> = (0..agents.len()).map(|i| if counted[i] { field[i] + task[i] } else { 0 }).collect();
            for (i, e) in round.entries.iter_mut().enumerate() {
                e.field_delta = if counted[i] { field[i] } else { 0 };
                e.task_delta = task[i];
            }
            round.task_delta = task_delta;
            let rated_agents: Vec<AccountId> = idx.iter().map(|i| agents[*i].clone()).collect();
            let rated_deltas: Vec<i64> = idx.iter().map(|i| total[*i]).collect();
            self.apply_ratings(&round.skill, &round.task_ref, &rated_agents, &rated_deltas, task_delta, round_id);
            for (i, e) in round.entries.iter().enumerate() {
                if !counted[i] {
                    continue;
                }
                let key = RatingKey { skill: round.skill.clone(), agent: e.agent.clone() };
                let r = self.ratings.get_mut(&key).unwrap();
                r.rounds += 1;
                if winners.contains(&i) {
                    r.wins += 1;
                }
                if e.attested {
                    r.attested += 1;
                }
            }
            let all_solved = scores.iter().all(|s| *s == round.total_tests);
            if let Some(t) = self.tasks.get_mut(&round.task_ref) {
                t.rounds += 1;
                t.saturated = if all_solved { t.saturated + 1 } else { 0 };
                if t.saturated >= SATURATION_LIMIT {
                    t.retired = true;
                    emit("task_retired", json!({ "task_ref": round.task_ref, "reason": "every entrant passed every test" }));
                }
            }

        }

        // Scout skill: LMSR profit in units of liquidity (a log-score improvement). Like ratings,
        // only rated rounds count: a manager could otherwise farm a scout's record on rounds
        // whose outcome it controls.
        if round.rated && round.payout_mode == PayoutMode::Winners && round.liquidity > 0 {
            for b in &round.bettors {
                let Some(pos) = self.positions.get(&(round_id, b.clone())) else { continue };
                let gross = math::position_payout(&pos.shares, &winners) as i128;
                let skill = (gross - pos.spent as i128) * math::PPM as i128 / round.liquidity as i128;
                let scout = self.scouts.entry(b.clone()).or_default();
                scout.skill_ppm += skill as i64;
                scout.scored_rounds += 1;
                if gross > pos.spent as i128 {
                    scout.wins += 1;
                }
            }
        }

        emit(
            "round_settled",
            json!({
                "round_id": round_id,
                "winners": round.winners.iter().map(|w| round.entries[*w as usize].agent.clone()).collect::<Vec<_>>(),
                "total_tests": round.total_tests,
                "scores": round.entries.iter().map(|e| json!({ "agent": e.agent, "score": e.score })).collect::<Vec<_>>(),
                "payout_mode": round.payout_mode,
                "task_ref": round.task_ref,
                "task_delta": round.task_delta,
            }),
        );
        self.rounds.insert(round_id, round);
        for (to, amount) in transfers {
            Promise::new(to).transfer(NearToken::from_yoctonear(amount)).detach();
        }
    }
}
