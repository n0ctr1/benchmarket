//! Hiring with escrow. A poster locks a budget on a task with hidden tests and a rating bar.
//! A qualified agent takes the job, answers, and verifiers score it like a round. If the
//! answer passes `pass_ppm` of the tests, the agent is paid; otherwise the poster is refunded.
//! Either way the result moves the agent's rating against the task: paid work is evidence too.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::*;

pub const JOB_DOMAIN: &str = "benchmarket:job:v1";
pub const JOB_ARBITER_DOMAIN: &str = "benchmarket:job-arbiter:v1";

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JobStatus {
    Open,
    Taken,
    Answered,
    Proposed,
    Disputed,
    /// Passed: the agent was paid.
    Paid,
    /// Failed the bar: the poster was refunded.
    Failed,
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub poster: AccountId,
    pub skill: String,
    pub task_ref: String,
    pub tests_hash: String,
    pub budget: u128,
    pub min_rating: u32,
    pub min_rounds: u32,
    /// Share of tests the answer must pass to be paid, ppm.
    pub pass_ppm: u32,
    pub attested: bool,
    /// Curated task: the result moves the agent's rating.
    pub rated: bool,
    pub work_window_ms: u64,
    pub status: JobStatus,
    pub agent: Option<AccountId>,
    pub deadline_ms: u64,
    /// Agents that took the job and let it time out; they cannot take it again.
    pub timed_out: Vec<AccountId>,
    pub answer_hash: Option<String>,
    pub answer_attested: bool,
    pub model: Option<String>,
    pub request_hash: Option<String>,
    pub proposal: Option<Proposal>,
    pub dispute: Option<Dispute>,
    pub score: Option<u32>,
    pub total_tests: u32,
    pub rating_delta: i64,
    pub created_at_ms: u64,
    pub closed_at_ms: Option<u64>,
}

#[near(serializers = [json])]
pub struct JobView {
    pub id: u64,
    /// The job this one subcontracts, if an agent posted it for part of its own work.
    pub parent_job: Option<u64>,
    pub poster: AccountId,
    pub skill: String,
    pub task_ref: String,
    pub tests_hash: String,
    pub budget: U128,
    pub min_rating: u32,
    pub min_rounds: u32,
    pub pass_ppm: u32,
    pub attested: bool,
    pub rated: bool,
    pub work_window_ms: u64,
    pub status: JobStatus,
    pub agent: Option<AccountId>,
    pub deadline_ms: u64,
    pub answer_hash: Option<String>,
    pub answer_attested: bool,
    pub model: Option<String>,
    pub request_hash: Option<String>,
    pub score: Option<u32>,
    pub total_tests: u32,
    pub dispute_until_ms: Option<u64>,
    pub disputed_by: Option<AccountId>,
    pub rating_delta: i64,
    pub created_at_ms: u64,
    pub closed_at_ms: Option<u64>,
}

#[near]
impl Contract {
    /// Posts a job; the attached deposit is the budget. Agents need `min_rating` (whole points)
    /// and `min_rounds` rated rounds or jobs in `skill` to take it.
    #[payable]
    pub fn post_job(
        &mut self,
        skill: String,
        task_ref: String,
        tests_hash: String,
        min_rating: u32,
        min_rounds: Option<u32>,
        pass_ppm: Option<u32>,
        work_window_ms: u64,
        attested: Option<bool>,
        parent_job: Option<u64>,
    ) -> u64 {
        let budget = env::attached_deposit().as_yoctonear();
        require!(budget > 0, "attach the budget");
        // A subcontract: the agent working on `parent_job` hires another agent for part of it,
        // paying from its own account. The link is recorded on chain.
        if let Some(p) = parent_job {
            let parent = self.jobs.get(&p).unwrap_or_else(|| env::panic_str("no such parent job"));
            require!(parent.agent.as_ref() == Some(&env::predecessor_account_id()), "only the agent working on the parent job can subcontract it");
            require!(parent.status == JobStatus::Taken, "the parent job is not being worked on");
        }
        require!(!skill.is_empty() && skill.len() <= 64, "bad skill");
        require!(!tests_hash.is_empty() && tests_hash.len() <= 128, "bad tests hash");
        require!(work_window_ms >= 60_000, "work window must be at least a minute");
        let pass = pass_ppm.unwrap_or(math::PPM as u32);
        require!(pass > 0 && pass as u64 <= math::PPM, "pass_ppm must be 1..=1000000");
        let (_, rated) = self.use_task(&task_ref, &skill, &tests_hash);
        let id = self.next_job_id;
        self.next_job_id += 1;
        let job = Job {
            id,
            poster: env::predecessor_account_id(),
            skill,
            task_ref,
            tests_hash,
            budget,
            min_rating,
            min_rounds: min_rounds.unwrap_or(PROVISIONAL_ROUNDS),
            pass_ppm: pass,
            attested: attested.unwrap_or(false),
            rated,
            work_window_ms,
            status: JobStatus::Open,
            agent: None,
            deadline_ms: 0,
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
            created_at_ms: env::block_timestamp_ms(),
            closed_at_ms: None,
        };
        emit(
            "job_posted",
            json!({ "job_id": id, "poster": job.poster, "skill": job.skill, "task_ref": job.task_ref, "budget": U128(budget), "min_rating": min_rating, "parent_job": parent_job }),
        );
        if let Some(p) = parent_job {
            env::storage_write(&parent_key(id), &p.to_le_bytes());
        }
        self.jobs.insert(id, job);
        id
    }

    /// The poster may withdraw a job nobody has taken.
    pub fn cancel_job(&mut self, job_id: u64) {
        let job = self.job_mut(job_id);
        require!(job.poster == env::predecessor_account_id(), "only the poster");
        require!(job.status == JobStatus::Open, "job is not open");
        job.status = JobStatus::Cancelled;
        job.closed_at_ms = Some(env::block_timestamp_ms());
        let (to, amount) = (job.poster.clone(), job.budget);
        emit("job_cancelled", json!({ "job_id": job_id }));
        Promise::new(to).transfer(NearToken::from_yoctonear(amount)).detach();
    }

    /// An agent with a passport and a qualifying rating takes the job; it has `work_window_ms`.
    pub fn take_job(&mut self, job_id: u64) {
        let agent = env::predecessor_account_id();
        require!(self.identities.contains_key(&agent), "agent has no identity");
        let job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("no such job"));
        require!(job.status == JobStatus::Open, "job is not open");
        require!(!job.timed_out.contains(&agent), "this agent already let the job time out");
        require!(job.poster != agent, "the poster cannot take its own job");
        require!(
            self.is_qualified(agent.clone(), job.skill.clone(), job.min_rating, Some(job.min_rounds), None),
            "agent does not meet the rating bar"
        );
        let now = env::block_timestamp_ms();
        let job = self.job_mut(job_id);
        job.status = JobStatus::Taken;
        job.agent = Some(agent.clone());
        job.deadline_ms = now + job.work_window_ms;
        emit("job_taken", json!({ "job_id": job_id, "agent": agent, "deadline_ms": job.deadline_ms }));
    }

    /// Reopens a job whose agent missed the deadline. Counts as a failed job for that agent:
    /// a zero score against the task.
    pub fn release_job(&mut self, job_id: u64) {
        let job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("no such job")).clone();
        require!(job.status == JobStatus::Taken, "job is not taken");
        require!(env::block_timestamp_ms() > job.deadline_ms, "the agent still has time");
        let agent = job.agent.clone().unwrap();
        if let Some(brief_id) = self.job_brief.get(&job_id).copied() {
            // A hire from a brief is accepted by the client, not by the agent (and on a
            // confidential hire the client submits the answer), so a missed deadline is not the
            // agent's failure: no rating change, the budget and every stake go back.
            let j = self.job_mut(job_id);
            j.status = JobStatus::Failed;
            j.score = Some(0);
            j.closed_at_ms = Some(env::block_timestamp_ms());
            let (poster, budget) = (j.poster.clone(), j.budget);
            emit("job_closed", json!({ "job_id": job_id, "agent": agent, "passed": false, "reason": "deadline missed, unrated" }));
            Promise::new(poster).transfer(NearToken::from_yoctonear(budget)).detach();
            self.close_brief(brief_id, briefs::Outcome::Void, 0);
            return;
        }
        let delta = self.rate_job(&job, &agent, 0, 1);
        if job.rated {
            let r = self.ratings.get_mut(&RatingKey { skill: job.skill.clone(), agent: agent.clone() }).unwrap();
            r.jobs_failed += 1;
        }
        let j = self.job_mut(job_id);
        j.status = JobStatus::Open;
        j.agent = None;
        j.timed_out.push(agent.clone());
        emit("job_released", json!({ "job_id": job_id, "agent": agent, "rating_delta": delta }));
    }

    pub fn submit_job(&mut self, job_id: u64, answer_hash: String, attestation: Option<Attestation>) {
        let caller = env::predecessor_account_id();
        require!(!answer_hash.is_empty() && answer_hash.len() <= 128, "bad answer hash");
        let proof = attestation.map(|a| attest::verify(&a, &self.inference_signers).unwrap_or_else(|e| env::panic_str(&e)));
        // A confidential hire is run by the client on the agent's public config, so the client
        // commits the answer; only a model-enclave signature proves the enclave produced it.
        let confidential = self.job_brief.get(&job_id).and_then(|b| self.briefs.get(b)).map_or(false, |b| b.confidential);
        let job = self.job_mut(job_id);
        require!(job.status == JobStatus::Taken, "job is not taken");
        require!(
            job.agent.as_ref() == Some(&caller) || (confidential && job.poster == caller),
            "only the agent that took the job"
        );
        if confidential {
            require!(proof.as_ref().map_or(false, |p| p.model.is_some()), "a confidential job needs a model-enclave attestation");
        }
        require!(env::block_timestamp_ms() <= job.deadline_ms, "work window passed");
        match &proof {
            Some(p) => {
                require!(answer_hash == format!("sha256:{}", p.response_hash), "answer hash must be the attested response hash");
                job.answer_attested = true;
                job.model = p.model.clone();
                job.request_hash = Some(p.request_hash.clone());
            }
            None => require!(!job.attested, "this job requires an inference attestation"),
        }
        job.answer_hash = Some(answer_hash.clone());
        job.status = JobStatus::Answered;
        emit("job_answered", json!({ "job_id": job_id, "agent": caller, "answer_hash": answer_hash, "attested": proof.is_some() }));
    }

    /// Verifier-signed result: `benchmarket:job:v1:<job_id>:<total_tests>:<agent>=<score>`.
    pub fn settle_job(&mut self, job_id: u64, total_tests: u32, score: u32, signatures: Vec<Base64VecU8>) {
        let now = env::block_timestamp_ms();
        let window = self.params.dispute_window_ms;
        let job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("no such job"));
        require!(job.status == JobStatus::Answered, "job has no answer to score");
        require!(total_tests > 0 && score <= total_tests, "bad score");
        let agent = job.agent.clone().unwrap();
        let message = math::signed_message(JOB_DOMAIN, job_id, total_tests, &[(agent.as_str(), score)]);
        let signers = self.verify_signatures(&self.verifiers, self.threshold, true, &message, &signatures);
        // A wrong score must cost more than it can move: the signing keys' stake, which a dispute
        // slashes, has to cover the budget it releases.
        let backing: u128 = signers.iter().filter_map(|pk| self.verifier_stakes.get(pk)).map(|s| s.amount).sum();
        require!(backing >= job.budget, "the signing verifiers' stake does not cover the job budget");
        emit("job_scored", json!({ "job_id": job_id, "score": score, "total_tests": total_tests, "message": message }));
        let job = self.job_mut(job_id);
        job.proposal = Some(Proposal { total_tests, scores: vec![score], signers, proposed_at_ms: now, dispute_until_ms: now + window });
        job.status = JobStatus::Proposed;
        if window == 0 {
            self.finalize_job_inner(job_id);
        }
    }

    pub fn finalize_job(&mut self, job_id: u64) {
        let job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("no such job"));
        require!(job.status == JobStatus::Proposed, "no undisputed score to finalize");
        require!(env::block_timestamp_ms() >= job.proposal.as_ref().unwrap().dispute_until_ms, "dispute window still open");
        self.finalize_job_inner(job_id);
    }

    #[payable]
    pub fn dispute_job(&mut self, job_id: u64) {
        let caller = env::predecessor_account_id();
        let bond = env::attached_deposit().as_yoctonear();
        let now = env::block_timestamp_ms();
        require!(bond >= self.params.dispute_bond.0, "attach the dispute bond");
        let job = self.job_mut(job_id);
        require!(job.status == JobStatus::Proposed, "nothing to dispute");
        require!(now < job.proposal.as_ref().unwrap().dispute_until_ms, "dispute window closed");
        job.status = JobStatus::Disputed;
        job.dispute = Some(Dispute { by: caller.clone(), bond, at_ms: now, overturned: None });
        emit("job_disputed", json!({ "job_id": job_id, "by": caller }));
    }

    pub fn resolve_job_dispute(&mut self, job_id: u64, total_tests: u32, score: u32, signatures: Vec<Base64VecU8>) {
        let job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("no such job")).clone();
        require!(job.status == JobStatus::Disputed, "job is not disputed");
        require!(total_tests > 0 && score <= total_tests, "bad score");
        let agent = job.agent.clone().unwrap();
        let message = math::signed_message(JOB_ARBITER_DOMAIN, job_id, total_tests, &[(agent.as_str(), score)]);
        self.verify_signatures(&self.arbiters, self.arbiter_threshold, false, &message, &signatures);
        let proposal = job.proposal.clone().unwrap();
        let dispute = job.dispute.clone().unwrap();
        let overturned = proposal.total_tests != total_tests || proposal.scores != vec![score];
        if overturned {
            let slashed = self.slash(&proposal.signers);
            emit("verifier_slashed", json!({ "job_id": job_id, "keys": proposal.signers, "amount": U128(slashed), "to": dispute.by }));
            Promise::new(dispute.by.clone()).transfer(NearToken::from_yoctonear(slashed + dispute.bond)).detach();
        } else {
            Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(dispute.bond)).detach();
        }
        let now = env::block_timestamp_ms();
        let j = self.job_mut(job_id);
        j.dispute.as_mut().unwrap().overturned = Some(overturned);
        if overturned {
            j.proposal = Some(Proposal { total_tests, scores: vec![score], signers: vec![], proposed_at_ms: now, dispute_until_ms: now });
        }
        self.finalize_job_inner(job_id);
    }

    /// Unresolved disputes end in a refund to the poster; the disputer gets the bond back.
    pub fn expire_job_dispute(&mut self, job_id: u64) {
        let timeout = self.params.resolve_timeout_ms;
        let job = self.job_mut(job_id);
        require!(job.status == JobStatus::Disputed, "job is not disputed");
        let d = job.dispute.clone().unwrap();
        require!(env::block_timestamp_ms() >= d.at_ms + timeout, "arbiters still have time");
        // No fault was shown: the verifier-signed score stands (a passing agent is paid) and the
        // disputer gets its bond back.
        emit("job_dispute_expired", json!({ "job_id": job_id, "by": d.by }));
        Promise::new(d.by).transfer(NearToken::from_yoctonear(d.bond)).detach();
        self.finalize_job_inner(job_id);
    }

    pub fn get_job(&self, job_id: u64) -> Option<JobView> {
        self.jobs.get(&job_id).map(job_view)
    }

    /// Jobs in descending id order, optionally only those with `status`.
    pub fn get_jobs(&self, status: Option<JobStatus>, before: Option<u64>, limit: Option<u32>) -> Vec<JobView> {
        let start = before.unwrap_or(self.next_job_id).min(self.next_job_id);
        (1..start)
            .rev()
            .filter_map(|id| self.jobs.get(&id))
            .filter(|j| status.map_or(true, |s| j.status == s))
            .take(limit.unwrap_or(20).min(50) as usize)
            .map(job_view)
            .collect()
    }
}

impl Contract {
    fn job_mut(&mut self, job_id: u64) -> &mut Job {
        self.jobs.get_mut(&job_id).unwrap_or_else(|| env::panic_str("no such job"))
    }

    /// Moves the agent's rating against the task by a single result; returns the agent's delta.
    /// Uncurated tasks move nothing.
    fn rate_job(&mut self, job: &Job, agent: &AccountId, score: u32, total: u32) -> i64 {
        if !job.rated {
            return 0;
        }
        let k = self.params.k_task;
        let agent_rating = self.rating_of(agent, &job.skill).rating;
        let task_rating = self.tasks.get(&job.task_ref).map_or(INITIAL_RATING, |t| t.rating);
        let (d, t) = math::task_deltas(&[agent_rating], task_rating, &[score], total, k);
        self.apply_ratings(&job.skill, &job.task_ref, &[agent.clone()], &d, t, 0);
        if let Some(task) = self.tasks.get_mut(&job.task_ref) {
            task.jobs += 1;
        }
        d[0]
    }

    fn finalize_job_inner(&mut self, job_id: u64) {
        let job = self.jobs.get(&job_id).unwrap().clone();
        let p = job.proposal.clone().unwrap();
        let score = p.scores[0];
        let agent = job.agent.clone().unwrap();
        let passed = score as u64 * math::PPM >= job.pass_ppm as u64 * p.total_tests as u64;
        let delta = self.rate_job(&job, &agent, score, p.total_tests);
        // Like ratings, the job record counts only on curated tasks: it feeds `is_qualified`.
        if job.rated {
            let key = RatingKey { skill: job.skill.clone(), agent: agent.clone() };
            let r = self.ratings.get_mut(&key).unwrap();
            if passed {
                r.jobs_done += 1;
            } else {
                r.jobs_failed += 1;
            }
            if job.answer_attested {
                r.attested += 1;
            }
        }
        let fee = if passed { job.budget * self.params.fee_bps as u128 / 10_000 } else { 0 };
        let owner = self.owner.clone();
        let j = self.job_mut(job_id);
        j.score = Some(score);
        j.total_tests = p.total_tests;
        j.rating_delta = delta;
        j.status = if passed { JobStatus::Paid } else { JobStatus::Failed };
        j.closed_at_ms = Some(env::block_timestamp_ms());
        emit("job_closed", json!({ "job_id": job_id, "agent": agent, "passed": passed, "score": score, "total_tests": p.total_tests, "rating_delta": delta }));
        if passed {
            Promise::new(agent).transfer(NearToken::from_yoctonear(job.budget - fee)).detach();
            if fee > 0 {
                Promise::new(owner).transfer(NearToken::from_yoctonear(fee)).detach();
            }
        } else {
            Promise::new(job.poster).transfer(NearToken::from_yoctonear(job.budget)).detach();
        }
        if let Some(brief_id) = self.job_brief.get(&job_id).copied() {
            self.close_brief(brief_id, if passed { briefs::Outcome::Delivered } else { briefs::Outcome::Failed }, 0);
        }
    }
}

fn job_view(j: &Job) -> JobView {
    JobView {
        id: j.id,
        parent_job: env::storage_read(&parent_key(j.id)).and_then(|v| v.try_into().ok()).map(u64::from_le_bytes),
        poster: j.poster.clone(),
        skill: j.skill.clone(),
        task_ref: j.task_ref.clone(),
        tests_hash: j.tests_hash.clone(),
        budget: U128(j.budget),
        min_rating: j.min_rating,
        min_rounds: j.min_rounds,
        pass_ppm: j.pass_ppm,
        attested: j.attested,
        rated: j.rated,
        work_window_ms: j.work_window_ms,
        status: j.status,
        agent: j.agent.clone(),
        deadline_ms: j.deadline_ms,
        answer_hash: j.answer_hash.clone(),
        answer_attested: j.answer_attested,
        model: j.model.clone(),
        request_hash: j.request_hash.clone(),
        score: j.score,
        total_tests: j.total_tests,
        dispute_until_ms: j.proposal.as_ref().map(|p| p.dispute_until_ms),
        disputed_by: j.dispute.as_ref().map(|d| d.by.clone()),
        rating_delta: j.rating_delta,
        created_at_ms: j.created_at_ms,
        closed_at_ms: j.closed_at_ms,
    }
}

/// Raw storage key linking a subcontract to its parent job (no state migration needed).
fn parent_key(job_id: u64) -> Vec<u8> {
    [b"parent:".as_slice(), &job_id.to_le_bytes()].concat()
}
