//! Briefs: a person with a task asks the league for an agent.
//!
//! 1. The client posts a brief with escrow: what it needs in words and, optionally, a category
//!    from the league's list; the budget for the work, a reward for scouts, and a tryout budget
//!    (bounty and market subsidy). The task itself can stay with the client until it hires.
//! 2. Scouts nominate agents, each with a stake and a curated tryout task (of the brief's
//!    category, if it has one) they think predicts success on this brief.
//! 3. The league runs a rated tryout round on the most-backed task with every nominee.
//! 4. The tryout's best (top score, then rating) is offered to the client, who accepts by handing
//!    over its task (a job is created for that agent only, from the escrow) or declines (refund).
//! 5. When the job closes, the scouts who nominated the hired agent are paid the reward pro rata
//!    to their stake if it delivered, and lose their stake to the client if it failed. Scouts of
//!    other nominees get their stake back. A scout vouches for its pick with money.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::jobs::{Job, JobStatus};
use crate::*;

/// Nominations per brief.
pub const MAX_NOMINATIONS: usize = 32;
pub const DEFAULT_OFFER_WINDOW_MS: u64 = 3 * 24 * 3_600_000;
/// No brief window may exceed this, so a brief can never lock the scouts' stakes for good.
pub const MAX_WINDOW_MS: u64 = 30 * 24 * 3_600_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BriefStatus {
    /// Scouts nominate agents.
    Scouting,
    /// The tryout round is running.
    Tryout,
    /// The tryout's best is offered to the client.
    Offered,
    /// The client accepted; the job is running.
    Hired,
    /// The hired agent delivered; scouts were paid.
    Delivered,
    /// The hired agent failed; its scouts' stakes went to the client.
    Failed,
    /// The client declined the offer or let it expire.
    Declined,
    /// Nobody nominated, nobody scored in the tryout, or the job was voided.
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Nomination {
    pub scout: AccountId,
    pub agent: AccountId,
    pub task_ref: String,
    pub stake: u128,
    /// What the scout got back when the brief closed (stake plus reward, or 0 if slashed).
    pub payout: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Brief {
    pub id: u64,
    pub client: AccountId,
    pub skill: String,
    pub summary: String,
    pub category: Option<String>,
    /// The client's own task and its hidden tests; may be given only when hiring.
    pub task_ref: Option<String>,
    pub tests_hash: Option<String>,
    pub pass_ppm: u32,
    pub attested: bool,
    /// Confidential: the task goes end-to-end encrypted to the hired agent's model enclave and
    /// nowhere else. The client runs the hire's public config itself and commits the answer; it
    /// must carry a model-enclave signature.
    pub confidential: bool,
    pub budget: u128,
    pub scout_reward: u128,
    pub tryout_bounty: u128,
    pub tryout_subsidy: u128,
    pub min_stake: u128,
    pub nominate_until_ms: u64,
    pub trade_window_ms: u64,
    pub work_window_ms: u64,
    pub offer_window_ms: u64,
    pub status: BriefStatus,
    pub nominations: Vec<Nomination>,
    pub tryout_task: Option<String>,
    pub tryout_round: Option<u64>,
    pub offered: Option<AccountId>,
    pub offer_until_ms: u64,
    pub job_id: Option<u64>,
    pub created_at_ms: u64,
    pub closed_at_ms: Option<u64>,
}

/// How good a scout's recommendations have been.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct ScoutRecord {
    pub nominated: u32,
    /// Nominations whose agent was hired.
    pub hired: u32,
    pub delivered: u32,
    pub failed: u32,
    pub earned: U128,
    pub slashed: U128,
}

#[near(serializers = [json])]
pub struct NominationView {
    pub scout: AccountId,
    pub agent: AccountId,
    pub task_ref: String,
    pub stake: U128,
    pub payout: U128,
}

#[near(serializers = [json])]
pub struct BriefView {
    pub id: u64,
    pub client: AccountId,
    pub skill: String,
    pub summary: String,
    pub category: Option<String>,
    pub task_ref: Option<String>,
    pub tests_hash: Option<String>,
    pub pass_ppm: u32,
    pub attested: bool,
    pub confidential: bool,
    pub budget: U128,
    pub scout_reward: U128,
    pub tryout_bounty: U128,
    pub tryout_subsidy: U128,
    pub min_stake: U128,
    pub nominate_until_ms: u64,
    pub trade_window_ms: u64,
    pub work_window_ms: u64,
    pub offer_window_ms: u64,
    pub status: BriefStatus,
    pub nominations: Vec<NominationView>,
    pub tryout_task: Option<String>,
    pub tryout_round: Option<u64>,
    pub offered: Option<AccountId>,
    pub offer_until_ms: u64,
    pub job_id: Option<u64>,
    pub created_at_ms: u64,
    pub closed_at_ms: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Delivered,
    Failed,
    /// Failed, but on work the client controlled: the brief closes Failed, every stake back.
    Unslashed,
    Void,
}

#[near]
impl Contract {
    /// Posts a brief. The attached deposit must equal budget + scout_reward + tryout_bounty +
    /// tryout_subsidy. Scouts nominate for `nominate_window_ms`; the tryout market stays open
    /// for `trade_window_ms`; the hired agent gets `work_window_ms`.
    #[payable]
    pub fn post_brief(
        &mut self,
        skill: String,
        summary: String,
        category: Option<String>,
        task_ref: Option<String>,
        tests_hash: Option<String>,
        budget: U128,
        scout_reward: U128,
        tryout_bounty: U128,
        tryout_subsidy: U128,
        min_stake: U128,
        nominate_window_ms: u64,
        trade_window_ms: u64,
        work_window_ms: u64,
        pass_ppm: Option<u32>,
        attested: Option<bool>,
        offer_window_ms: Option<u64>,
        confidential: Option<bool>,
    ) -> u64 {
        let deposit = env::attached_deposit().as_yoctonear();
        let total = budget.0 + scout_reward.0 + tryout_bounty.0 + tryout_subsidy.0;
        require!(deposit == total, "attach exactly budget + scout_reward + tryout_bounty + tryout_subsidy");
        require!(budget.0 > 0, "the budget must be positive");
        require!(!skill.is_empty() && skill.len() <= 64, "bad skill");
        require!(!summary.is_empty() && summary.len() <= 500, "summary must be 1..=500 bytes");
        require!(min_stake.0 >= self.params.min_bet.0, "min_stake below the minimum bet");
        if let Some(c) = &category {
            require!(self.categories.contains_key(c), "no such category");
        }
        let offer_window_ms = offer_window_ms.unwrap_or(DEFAULT_OFFER_WINDOW_MS);
        let windows = [nominate_window_ms, trade_window_ms, work_window_ms, offer_window_ms];
        require!(windows.iter().all(|w| (60_000..=MAX_WINDOW_MS).contains(w)), "every window must be between a minute and 30 days");
        let pass = pass_ppm.unwrap_or(math::PPM as u32);
        require!(pass > 0 && pass as u64 <= math::PPM, "pass_ppm must be 1..=1000000");
        match (&task_ref, &tests_hash) {
            (Some(t), Some(h)) => {
                require!(!h.is_empty() && h.len() <= 128, "bad tests hash");
                self.use_task(t, &skill, h);
            }
            (None, None) => {}
            _ => env::panic_str("give task_ref and tests_hash together, or neither until hiring"),
        }
        let now = env::block_timestamp_ms();
        let id = self.next_brief_id;
        self.next_brief_id += 1;
        let brief = Brief {
            id,
            client: env::predecessor_account_id(),
            skill,
            summary,
            category,
            task_ref,
            tests_hash,
            pass_ppm: pass,
            attested: attested.unwrap_or(false) || confidential.unwrap_or(false),
            confidential: confidential.unwrap_or(false),
            budget: budget.0,
            scout_reward: scout_reward.0,
            tryout_bounty: tryout_bounty.0,
            tryout_subsidy: tryout_subsidy.0,
            min_stake: min_stake.0,
            nominate_until_ms: now + nominate_window_ms,
            trade_window_ms,
            work_window_ms,
            offer_window_ms,
            status: BriefStatus::Scouting,
            nominations: vec![],
            tryout_task: None,
            tryout_round: None,
            offered: None,
            offer_until_ms: 0,
            job_id: None,
            created_at_ms: now,
            closed_at_ms: None,
        };
        emit(
            "brief_posted",
            json!({ "brief_id": id, "client": brief.client, "skill": brief.skill, "category": brief.category, "budget": budget, "scout_reward": scout_reward, "nominate_until_ms": brief.nominate_until_ms }),
        );
        self.briefs.insert(id, brief);
        id
    }

    /// A scout nominates an agent and the curated task to try it out on, staking on the pick.
    #[payable]
    pub fn nominate(&mut self, brief_id: u64, agent: AccountId, task_ref: String) {
        let scout = env::predecessor_account_id();
        let stake = env::attached_deposit().as_yoctonear();
        require!(self.identities.contains_key(&agent), "agent has no identity");
        let task = self.tasks.get(&task_ref).cloned().unwrap_or_else(|| env::panic_str("no such task"));
        let task_cat = self.task_category.get(&task_ref).cloned();
        let brief = self.briefs.get_mut(&brief_id).unwrap_or_else(|| env::panic_str("no such brief"));
        require!(brief.status == BriefStatus::Scouting, "nominations are closed");
        require!(env::block_timestamp_ms() < brief.nominate_until_ms, "nominations are closed");
        require!(stake >= brief.min_stake, "stake below the brief's minimum");
        require!(scout != brief.client, "the client cannot nominate");
        require!(task.curated && !task.retired && task.skill == brief.skill, "the tryout task must be a curated task of this skill");
        require!(Some(&task_ref) != brief.task_ref.as_ref(), "the tryout cannot be the client's own task");
        if brief.category.is_some() {
            require!(task_cat == brief.category, "the tryout task must be in the brief's category");
        }
        require!(brief.nominations.len() < MAX_NOMINATIONS, "too many nominations");
        require!(!brief.nominations.iter().any(|n| n.scout == scout && n.agent == agent), "already nominated this agent");
        let new_agent = !brief.nominations.iter().any(|n| n.agent == agent);
        let distinct = brief.nominations.iter().map(|n| &n.agent).collect::<std::collections::BTreeSet<_>>().len();
        require!(!new_agent || distinct < MAX_AGENTS as usize, "the tryout is full");
        brief.nominations.push(Nomination { scout: scout.clone(), agent: agent.clone(), task_ref: task_ref.clone(), stake, payout: 0 });
        emit("agent_nominated", json!({ "brief_id": brief_id, "scout": scout, "agent": agent, "task_ref": task_ref, "stake": U128(stake) }));
        self.scout_records.entry(scout).or_default().nominated += 1;
    }

    /// After the nomination window, anyone starts the tryout: a rated round on the most-backed
    /// task with every nominee, funded by the brief. With one nominee it is offered directly;
    /// with none the brief is cancelled and refunded.
    pub fn start_tryout(&mut self, brief_id: u64, tests_hash: Option<String>) {
        let now = env::block_timestamp_ms();
        let brief = self.briefs.get(&brief_id).cloned().unwrap_or_else(|| env::panic_str("no such brief"));
        require!(brief.status == BriefStatus::Scouting, "brief is not scouting");
        require!(now >= brief.nominate_until_ms, "nominations are still open");
        let mut agents: Vec<AccountId> = vec![];
        for n in &brief.nominations {
            if !agents.contains(&n.agent) {
                agents.push(n.agent.clone());
            }
        }
        if agents.is_empty() {
            let back = brief.budget + brief.scout_reward + brief.tryout_bounty + brief.tryout_subsidy;
            self.close_brief(brief_id, Outcome::Void, back);
            return;
        }
        if agents.len() == 1 {
            // Nothing to compare: offer the only nominee, return the tryout funds.
            let back = brief.tryout_bounty + brief.tryout_subsidy;
            let b = self.briefs.get_mut(&brief_id).unwrap();
            b.status = BriefStatus::Offered;
            b.offered = Some(agents[0].clone());
            b.offer_until_ms = now + b.offer_window_ms;
            emit("agent_offered", json!({ "brief_id": brief_id, "agent": agents[0], "tryout": false }));
            if back > 0 {
                Promise::new(brief.client.clone()).transfer(NearToken::from_yoctonear(back)).detach();
            }
            return;
        }
        let task_ref = most_backed(&brief).unwrap();
        let task = self.tasks.get(&task_ref).cloned().unwrap();
        require!(!task.retired, "the chosen tryout task was retired meanwhile");
        // A family task runs on fresh tests: the league's verifier generates them and commits
        // their hash here. A fixed task uses its pinned set.
        let round_tests = if task.tests_hash.starts_with(FAMILY_PREFIX) {
            let caller = env::predecessor_account_id();
            require!(caller == self.owner || caller == brief.client, "only the league or the client starts a tryout on fresh tests");
            let h = tests_hash.unwrap_or_else(|| env::panic_str("this tryout task is a family: commit the fresh tests hash"));
            require!(!h.is_empty() && h.len() <= 128 && !h.starts_with(FAMILY_PREFIX), "bad tests hash");
            h
        } else {
            require!(tests_hash.as_ref().map_or(true, |h| *h == task.tests_hash), "tests hash does not match the curated task");
            task.tests_hash.clone()
        };
        let entries: Vec<Entry> = agents
            .iter()
            .map(|a| Entry {
                agent: a.clone(),
                builder: brief.nominations.iter().find(|n| n.agent == *a).unwrap().scout.clone(),
                league: League::Open,
                config_hash: self.identities.get(a).map(|i| i.config_hash.clone()).unwrap_or_default(),
                bond: 0,
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
            })
            .collect();
        let liquidity = math::lmsr_b(brief.tryout_subsidy, entries.len());
        let round_id = self.next_round_id;
        self.next_round_id += 1;
        let round = Round {
            id: round_id,
            manager: brief.client.clone(),
            skill: brief.skill.clone(),
            task_ref: task_ref.clone(),
            tests_hash: round_tests,
            bet_deadline_ms: now + brief.trade_window_ms,
            answer_deadline_ms: 0,
            max_agents: entries.len() as u8,
            attested: brief.attested,
            rated: true,
            bounty: brief.tryout_bounty,
            status: if liquidity > 0 { RoundStatus::Trading } else { RoundStatus::Open },
            entries,
            liquidity,
            subsidy: if liquidity > 0 { brief.tryout_subsidy } else { 0 },
            volume: 0,
            fees: 0,
            bettors: vec![],
            payout_mode: PayoutMode::Pending,
            winners: vec![],
            payout_budget: 0,
            paid_out: 0,
            total_tests: 0,
            task_rating_before: task.rating,
            task_delta: 0,
            proposal: None,
            dispute: None,
            created_at_ms: now,
            locked_at_ms: None,
            settled_at_ms: None,
        };
        self.rounds.insert(round_id, round);
        if liquidity == 0 && brief.tryout_subsidy > 0 {
            Promise::new(brief.client.clone()).transfer(NearToken::from_yoctonear(brief.tryout_subsidy)).detach();
        }
        let b = self.briefs.get_mut(&brief_id).unwrap();
        b.status = BriefStatus::Tryout;
        b.tryout_task = Some(task_ref.clone());
        b.tryout_round = Some(round_id);
        env::storage_write(&tryout_key(round_id), &brief_id.to_le_bytes());
        emit("tryout_started", json!({ "brief_id": brief_id, "round_id": round_id, "task_ref": task_ref, "agents": agents }));
    }

    /// Once the tryout is settled, offers its best agent: a winner, the highest-rated if several
    /// tie. If nobody scored, or the tryout was cancelled, the brief is cancelled and refunded.
    pub fn offer(&mut self, brief_id: u64) {
        let now = env::block_timestamp_ms();
        let brief = self.briefs.get(&brief_id).cloned().unwrap_or_else(|| env::panic_str("no such brief"));
        require!(brief.status == BriefStatus::Tryout, "brief has no running tryout");
        let round = self.round_ref(brief.tryout_round.unwrap());
        match round.status {
            RoundStatus::Settled => {}
            RoundStatus::Cancelled => {
                // The tryout funds went back to the client with the cancellation.
                self.close_brief(brief_id, Outcome::Void, brief.budget + brief.scout_reward);
                return;
            }
            _ => env::panic_str("the tryout is not finished"),
        }
        let skill = round.skill.clone();
        let candidates: Vec<AccountId> = round.winners.iter().map(|w| round.entries[*w as usize].agent.clone()).collect();
        if candidates.is_empty() {
            self.close_brief(brief_id, Outcome::Void, brief.budget + brief.scout_reward);
            return;
        }
        let best = candidates
            .iter()
            .fold(None::<(&AccountId, i64)>, |acc, a| {
                let r = self.rating_of(a, &skill).rating;
                match acc {
                    Some((_, br)) if br >= r => acc,
                    _ => Some((a, r)),
                }
            })
            .unwrap()
            .0
            .clone();
        let b = self.briefs.get_mut(&brief_id).unwrap();
        b.status = BriefStatus::Offered;
        b.offered = Some(best.clone());
        b.offer_until_ms = now + b.offer_window_ms;
        emit("agent_offered", json!({ "brief_id": brief_id, "agent": best, "tryout": true }));
    }

    /// The client hires the offered agent: a job is created from the escrow, already taken by it.
    /// The client hires the offered agent and, if it has not yet, hands over its task now: only
    /// the hired agent ever works on it.
    pub fn accept_offer(&mut self, brief_id: u64, task_ref: Option<String>, tests_hash: Option<String>) -> u64 {
        let now = env::block_timestamp_ms();
        let mut brief = self.briefs.get(&brief_id).cloned().unwrap_or_else(|| env::panic_str("no such brief"));
        require!(brief.client == env::predecessor_account_id(), "only the client");
        require!(brief.status == BriefStatus::Offered, "nothing to accept");
        require!(now <= brief.offer_until_ms, "the offer expired");
        if brief.task_ref.is_none() {
            let (t, h) = match (task_ref, tests_hash) {
                (Some(t), Some(h)) => (t, h),
                _ => env::panic_str("hand over the task: task_ref and tests_hash"),
            };
            require!(!h.is_empty() && h.len() <= 128, "bad tests hash");
            require!(Some(&t) != brief.tryout_task.as_ref(), "the client's task cannot be the tryout task");
            self.use_task(&t, &brief.skill, &h);
            brief.task_ref = Some(t);
            brief.tests_hash = Some(h);
            let b = self.briefs.get_mut(&brief_id).unwrap();
            b.task_ref = brief.task_ref.clone();
            b.tests_hash = brief.tests_hash.clone();
        } else {
            require!(task_ref.is_none() && tests_hash.is_none(), "the task was given with the brief");
        }
        let client_task = brief.task_ref.clone().unwrap();
        let client_tests = brief.tests_hash.clone().unwrap();
        let agent = brief.offered.clone().unwrap();
        // A confidential hire is run by the client, who commits the answer: it must never move the
        // agent's public rating.
        let rated = !brief.confidential && self.tasks.get(&client_task).map_or(false, |t| t.curated);
        let job_id = self.next_job_id;
        self.next_job_id += 1;
        let job = Job {
            id: job_id,
            poster: brief.client.clone(),
            skill: brief.skill.clone(),
            task_ref: client_task,
            tests_hash: client_tests,
            budget: brief.budget,
            min_rating: 0,
            min_rounds: 0,
            pass_ppm: brief.pass_ppm,
            attested: brief.attested,
            rated,
            work_window_ms: brief.work_window_ms,
            status: JobStatus::Taken,
            agent: Some(agent.clone()),
            deadline_ms: now + brief.work_window_ms,
            timed_out: vec![],
            answer_hash: None,
            answer_attested: false,
            model: None,
            request_hash: None,
            proposal: None,
            dispute: None,
            score: None,
            total_tests: 0,
            rating_delta: 0,
            created_at_ms: now,
            closed_at_ms: None,
        };
        emit("job_posted", json!({ "job_id": job_id, "poster": job.poster, "skill": job.skill, "task_ref": job.task_ref, "budget": U128(job.budget), "brief_id": brief_id }));
        emit("job_taken", json!({ "job_id": job_id, "agent": agent, "deadline_ms": job.deadline_ms }));
        self.jobs.insert(job_id, job);
        self.job_brief.insert(job_id, brief_id);
        let b = self.briefs.get_mut(&brief_id).unwrap();
        b.status = BriefStatus::Hired;
        b.job_id = Some(job_id);
        for n in b.nominations.clone() {
            if n.agent == agent {
                self.scout_records.entry(n.scout).or_default().hired += 1;
            }
        }
        emit("offer_accepted", json!({ "brief_id": brief_id, "agent": agent, "job_id": job_id }));
        job_id
    }

    /// The client declines the offer: budget and scout reward come back, every stake returns.
    pub fn decline_offer(&mut self, brief_id: u64) {
        let brief = self.briefs.get(&brief_id).cloned().unwrap_or_else(|| env::panic_str("no such brief"));
        require!(brief.client == env::predecessor_account_id(), "only the client");
        require!(brief.status == BriefStatus::Offered, "nothing to decline");
        self.decline(brief_id);
    }

    /// An offer the client did not answer in time counts as declined.
    pub fn expire_offer(&mut self, brief_id: u64) {
        let brief = self.briefs.get(&brief_id).cloned().unwrap_or_else(|| env::panic_str("no such brief"));
        require!(brief.status == BriefStatus::Offered, "nothing to expire");
        require!(env::block_timestamp_ms() > brief.offer_until_ms, "the offer is still open");
        self.decline(brief_id);
    }

    /// The tryout task `start_tryout` would pick now (most stake behind it).
    pub fn next_tryout_task(&self, brief_id: u64) -> Option<String> {
        self.briefs.get(&brief_id).and_then(most_backed)
    }

    pub fn get_brief(&self, brief_id: u64) -> Option<BriefView> {
        self.briefs.get(&brief_id).map(brief_view)
    }

    /// Briefs in descending id order.
    pub fn get_briefs(&self, before: Option<u64>, limit: Option<u32>) -> Vec<BriefView> {
        let start = before.unwrap_or(self.next_brief_id).min(self.next_brief_id);
        (1..start).rev().filter_map(|id| self.briefs.get(&id)).take(limit.unwrap_or(20).min(50) as usize).map(brief_view).collect()
    }

    pub fn get_scout_record(&self, account: AccountId) -> ScoutRecord {
        self.scout_records.get(&account).cloned().unwrap_or_default()
    }
}

impl Contract {
    fn decline(&mut self, brief_id: u64) {
        let b = self.briefs.get_mut(&brief_id).unwrap();
        b.status = BriefStatus::Declined;
        let back = b.budget + b.scout_reward;
        let client = b.client.clone();
        emit("offer_declined", json!({ "brief_id": brief_id }));
        Promise::new(client).transfer(NearToken::from_yoctonear(back)).detach();
        self.return_stakes(brief_id, None);
        self.briefs.get_mut(&brief_id).unwrap().closed_at_ms = Some(env::block_timestamp_ms());
    }

    /// Pays every nomination its stake back, except those on `except` (handled by the caller).
    fn return_stakes(&mut self, brief_id: u64, except: Option<&AccountId>) {
        let b = self.briefs.get_mut(&brief_id).unwrap();
        let mut pay = vec![];
        for n in b.nominations.iter_mut() {
            if Some(&n.agent) != except {
                n.payout = n.stake;
                pay.push((n.scout.clone(), n.stake));
            }
        }
        for (to, amount) in pay {
            Promise::new(to).transfer(NearToken::from_yoctonear(amount)).detach();
        }
    }

    /// Closes a brief. `refund` goes back to the client. Delivered: the hired agent's scouts
    /// share the reward pro rata to stake. Failed: their stakes go to the league and the reward
    /// back to the client. Void: everything back. Other nominations always get their stake back.
    pub(crate) fn close_brief(&mut self, brief_id: u64, outcome: Outcome, refund: u128) {
        let brief = self.briefs.get(&brief_id).cloned().unwrap();
        let hired = brief.offered.clone();
        let mut to_client = refund;
        // A failure can cost the scouts their stake only when it is the agent's: a rated job
        // (curated task, not confidential), which the agent ran itself on tests it could not
        // choose. Otherwise the client controlled the outcome, and the stakes go back.
        let job_rated = brief.job_id.and_then(|j| self.jobs.get(&j)).map_or(false, |j| j.rated);
        let outcome = if outcome == Outcome::Failed && !job_rated { Outcome::Unslashed } else { outcome };
        if let (Some(agent), true) = (hired.as_ref(), matches!(outcome, Outcome::Delivered | Outcome::Failed)) {
            let backing: u128 = brief.nominations.iter().filter(|n| n.agent == *agent).map(|n| n.stake).sum();
            let mut paid = 0u128;
            let b = self.briefs.get_mut(&brief_id).unwrap();
            let mut pay = vec![];
            let backers: Vec<usize> = (0..b.nominations.len()).filter(|i| b.nominations[*i].agent == *agent).collect();
            for (k, i) in backers.iter().enumerate() {
                let n = &mut b.nominations[*i];
                if outcome == Outcome::Delivered {
                    let mut share = math::mul_div(brief.scout_reward, n.stake, backing.max(1));
                    if k == backers.len() - 1 {
                        share = brief.scout_reward - paid;
                    }
                    paid += share;
                    n.payout = n.stake + share;
                    pay.push((n.scout.clone(), n.payout, share, 0u128));
                } else {
                    n.payout = 0;
                    pay.push((n.scout.clone(), 0, 0, n.stake));
                }
            }
            // The client gets its reward back; the slashed stakes go to the league, never to the
            // client, who could otherwise profit from a failure it caused.
            let mut to_league = 0u128;
            if outcome == Outcome::Failed {
                to_client += brief.scout_reward;
                to_league = backing;
            }
            if to_league > 0 {
                Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(to_league)).detach();
            }
            for (scout, amount, earned, slashed) in pay {
                let r = self.scout_records.entry(scout.clone()).or_default();
                if outcome == Outcome::Delivered {
                    r.delivered += 1;
                    r.earned = U128(r.earned.0 + earned);
                } else {
                    r.failed += 1;
                    r.slashed = U128(r.slashed.0 + slashed);
                }
                if amount > 0 {
                    Promise::new(scout).transfer(NearToken::from_yoctonear(amount)).detach();
                }
            }
            self.return_stakes(brief_id, Some(agent));
        } else {
            to_client += if brief.status == BriefStatus::Hired { brief.scout_reward } else { 0 };
            self.return_stakes(brief_id, None);
        }
        let b = self.briefs.get_mut(&brief_id).unwrap();
        b.status = match outcome {
            Outcome::Delivered => BriefStatus::Delivered,
            Outcome::Failed | Outcome::Unslashed => BriefStatus::Failed,
            Outcome::Void => BriefStatus::Cancelled,
        };
        b.closed_at_ms = Some(env::block_timestamp_ms());
        emit("brief_closed", json!({ "brief_id": brief_id, "status": b.status, "agent": hired, "to_client": U128(to_client) }));
        if to_client > 0 {
            Promise::new(brief.client).transfer(NearToken::from_yoctonear(to_client)).detach();
        }
    }
}

/// The nominated tryout task with the most stake behind it; the first nominated wins a tie.
fn most_backed(brief: &Brief) -> Option<String> {
    let mut tally: Vec<(String, u128)> = vec![];
    for n in &brief.nominations {
        match tally.iter_mut().find(|(t, _)| *t == n.task_ref) {
            Some((_, s)) => *s += n.stake,
            None => tally.push((n.task_ref.clone(), n.stake)),
        }
    }
    tally.iter().fold(None::<&(String, u128)>, |best, x| match best {
        Some(b) if b.1 >= x.1 => Some(b),
        _ => Some(x),
    }).map(|x| x.0.clone())
}

fn brief_view(b: &Brief) -> BriefView {
    BriefView {
        id: b.id,
        client: b.client.clone(),
        skill: b.skill.clone(),
        summary: b.summary.clone(),
        category: b.category.clone(),
        task_ref: b.task_ref.clone(),
        tests_hash: b.tests_hash.clone(),
        pass_ppm: b.pass_ppm,
        attested: b.attested,
        confidential: b.confidential,
        budget: U128(b.budget),
        scout_reward: U128(b.scout_reward),
        tryout_bounty: U128(b.tryout_bounty),
        tryout_subsidy: U128(b.tryout_subsidy),
        min_stake: U128(b.min_stake),
        nominate_until_ms: b.nominate_until_ms,
        trade_window_ms: b.trade_window_ms,
        work_window_ms: b.work_window_ms,
        offer_window_ms: b.offer_window_ms,
        status: b.status,
        nominations: b
            .nominations
            .iter()
            .map(|n| NominationView { scout: n.scout.clone(), agent: n.agent.clone(), task_ref: n.task_ref.clone(), stake: U128(n.stake), payout: U128(n.payout) })
            .collect(),
        tryout_task: b.tryout_task.clone(),
        tryout_round: b.tryout_round,
        offered: b.offered.clone(),
        offer_until_ms: b.offer_until_ms,
        job_id: b.job_id,
        created_at_ms: b.created_at_ms,
        closed_at_ms: b.closed_at_ms,
    }
}
