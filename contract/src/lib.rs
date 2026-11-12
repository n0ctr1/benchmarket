//! Agent League contract.
//!
//! Rounds, entries, a parimutuel market per round, verifier-signed settlement and
//! per-skill ratings driven by the market's expected score. The rules live in RULES.md.

pub mod identity;
pub mod math;

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, CurveType, NearToken, PanicOnDefault, Promise,
    PublicKey,
};

use crate::math::INITIAL_RATING;

const ONE_NEAR: u128 = 10u128.pow(24);
const PROVISIONAL_ROUNDS: u32 = 3;
const MAX_AGENTS: u8 = 16;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Rounds,
    Positions,
    Ratings,
    Scouts,
    Identities,
    IdentitiesV3,
    IdentitiesV4,
    FacePages,
    AgentByNumber,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum League {
    Open,
    Market,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RoundStatus {
    Open,
    Locked,
    Settled,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayoutMode {
    /// Not settled yet.
    Pending,
    /// Backers of the winner share `net`.
    Winners,
    /// Every bet is refunded.
    Refund,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Entry {
    pub agent: AccountId,
    pub builder: AccountId,
    pub league: League,
    pub config_hash: String,
    pub pool: u128,
    /// Expected score at lock time, ppm.
    pub p_ppm: u64,
    /// Market share at lock time, ppm.
    pub market_ppm: u64,
    pub answer_hash: Option<String>,
    pub answered_at_ms: Option<u64>,
    pub score: Option<u32>,
    pub rating_before: i64,
    pub rating_delta: i64,
}

#[near(serializers = [borsh])]
pub struct Round {
    pub id: u64,
    pub manager: AccountId,
    pub skill: String,
    pub task_ref: String,
    pub tests_hash: String,
    pub bet_deadline_ms: u64,
    pub max_agents: u8,
    pub bounty: u128,
    pub status: RoundStatus,
    pub entries: Vec<Entry>,
    pub total_pool: u128,
    pub fee: u128,
    pub net: u128,
    pub payout_mode: PayoutMode,
    pub winner: Option<u8>,
    pub total_tests: u32,
    pub created_at_ms: u64,
    pub locked_at_ms: Option<u64>,
    pub settled_at_ms: Option<u64>,
}

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Position {
    /// Amount bet on each entry, indexed like `Round::entries`.
    pub amounts: Vec<u128>,
    pub claimed: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RatingKey {
    pub skill: String,
    pub agent: AccountId,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Rating {
    pub rating: i64,
    pub rounds: u32,
    pub wins: u32,
    pub last_round: u64,
}

impl Default for Rating {
    fn default() -> Self {
        Self { rating: INITIAL_RATING, rounds: 0, wins: 0, last_round: 0 }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Scout {
    pub staked: u128,
    pub returned: u128,
    pub bets: u32,
    pub wins: u32,
}

// ---------- JSON views ----------

#[near(serializers = [json])]
pub struct EntryView {
    pub agent: AccountId,
    pub builder: AccountId,
    pub league: League,
    pub config_hash: String,
    pub pool: U128,
    pub odds_ppm: u64,
    pub p_ppm: u64,
    pub market_ppm: u64,
    pub answer_hash: Option<String>,
    pub answered_at_ms: Option<u64>,
    pub score: Option<u32>,
    pub rating_before: i64,
    pub rating_delta: i64,
}

#[near(serializers = [json])]
pub struct RoundView {
    pub id: u64,
    pub manager: AccountId,
    pub skill: String,
    pub task_ref: String,
    pub tests_hash: String,
    pub bet_deadline_ms: u64,
    pub max_agents: u8,
    pub bounty: U128,
    pub status: RoundStatus,
    pub entries: Vec<EntryView>,
    pub total_pool: U128,
    pub fee: U128,
    pub net: U128,
    pub payout_mode: PayoutMode,
    pub winner: Option<AccountId>,
    pub total_tests: u32,
    pub created_at_ms: u64,
    pub locked_at_ms: Option<u64>,
    pub settled_at_ms: Option<u64>,
}

#[near(serializers = [json])]
pub struct RatingView {
    pub agent: AccountId,
    pub skill: String,
    /// Centi-points: 150000 = 1500.00.
    pub rating: i64,
    pub rounds: u32,
    pub wins: u32,
    pub provisional: bool,
    pub last_round: u64,
}

#[near(serializers = [json])]
pub struct ScoutView {
    pub account: AccountId,
    pub staked: U128,
    pub returned: U128,
    /// returned - staked, yoctoNEAR, as a decimal string (can be negative).
    pub pnl: String,
    pub bets: u32,
    pub wins: u32,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub agent: AccountId,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub verifiers: Vec<PublicKey>,
    pub threshold: u8,
    pub fee_bps: u16,
    pub min_pool: U128,
    pub min_builder_stake: U128,
    pub min_bet: U128,
    pub k_factor: u32,
    pub next_round_id: u64,
}

/// An agent's passport. The face (cells, palette) is derived on chain from the agent's seed.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Identity {
    pub number: u32,
    pub seed: String,
    pub cells: Vec<u8>,
    pub palette: [u16; 3],
    pub motto: String,
    pub config_hash: String,
    /// Off-chain evidence of how the seed was produced (completion id and signature digest).
    pub proof: String,
    pub issuer: AccountId,
    pub issued_at_ms: u64,
}

#[near(serializers = [json])]
pub struct IdentityView {
    pub agent: AccountId,
    pub number: u32,
    pub seed: String,
    pub cells: Vec<u8>,
    pub palette: [u16; 3],
    pub face_code: String,
    pub motto: String,
    pub config_hash: String,
    pub proof: String,
    pub issuer: AccountId,
    pub issued_at_ms: u64,
}

#[near(serializers = [json])]
pub struct FaceCheck {
    pub ok: bool,
    pub reason: Option<String>,
    pub cells: Vec<u8>,
    pub palette: [u16; 3],
    /// Closest existing face, if any, and how many cells apart.
    pub nearest: Option<AccountId>,
    pub distance: Option<u32>,
}

// ---------- Contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    verifiers: Vec<PublicKey>,
    threshold: u8,
    fee_bps: u16,
    min_pool: u128,
    min_builder_stake: u128,
    min_bet: u128,
    k_factor: u32,
    next_round_id: u64,
    rounds: LookupMap<u64, Round>,
    positions: LookupMap<(u64, AccountId), Position>,
    ratings: IterableMap<RatingKey, Rating>,
    scouts: IterableMap<AccountId, Scout>,
    identities: IterableMap<AccountId, Identity>,
    next_identity: u32,
    /// Every issued face packed into a u64, in passport order, `PAGE` faces per storage entry.
    /// The uniqueness check reads these pages instead of every passport.
    face_pages: Vector<Vec<u64>>,
    agent_by_number: LookupMap<u32, AccountId>,
}

/// State layout before the face index; read once by `migrate`.
#[near(serializers = [borsh])]
struct ContractV4 {
    owner: AccountId,
    verifiers: Vec<PublicKey>,
    threshold: u8,
    fee_bps: u16,
    min_pool: u128,
    min_builder_stake: u128,
    min_bet: u128,
    k_factor: u32,
    next_round_id: u64,
    rounds: LookupMap<u64, Round>,
    positions: LookupMap<(u64, AccountId), Position>,
    ratings: IterableMap<RatingKey, Rating>,
    scouts: IterableMap<AccountId, Scout>,
    identities: IterableMap<AccountId, Identity>,
    next_identity: u32,
}

/// Storage paid by the agent for its passport.
pub const IDENTITY_DEPOSIT: u128 = ONE_NEAR / 50;

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let log = json!({
        "standard": "agent-league",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

fn identity_view(agent: &AccountId, id: &Identity) -> IdentityView {
    IdentityView {
        agent: agent.clone(),
        number: id.number,
        seed: id.seed.clone(),
        cells: id.cells.clone(),
        palette: id.palette,
        face_code: identity::face_code(&identity::Face { cells: id.cells.clone(), palette: id.palette }),
        motto: id.motto.clone(),
        config_hash: id.config_hash.clone(),
        proof: id.proof.clone(),
        issuer: id.issuer.clone(),
        issued_at_ms: id.issued_at_ms,
    }
}

fn ed25519_bytes(pk: &PublicKey) -> [u8; 32] {
    require!(pk.curve_type() == CurveType::ED25519, "verifier keys must be ed25519");
    let raw = pk.as_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw[1..33]);
    out
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, verifiers: Vec<PublicKey>, threshold: u8) -> Self {
        require!(threshold >= 1 && threshold as usize <= verifiers.len(), "bad threshold");
        verifiers.iter().for_each(|v| {
            ed25519_bytes(v);
        });
        Self {
            owner,
            verifiers,
            threshold,
            fee_bps: 200,
            min_pool: 10 * ONE_NEAR,
            min_builder_stake: ONE_NEAR / 2,
            min_bet: ONE_NEAR / 100,
            k_factor: 32,
            next_round_id: 1,
            rounds: LookupMap::new(StorageKey::Rounds),
            positions: LookupMap::new(StorageKey::Positions),
            ratings: IterableMap::new(StorageKey::Ratings),
            scouts: IterableMap::new(StorageKey::Scouts),
            identities: IterableMap::new(StorageKey::IdentitiesV4),
            next_identity: 1,
            face_pages: Vector::new(StorageKey::FacePages),
            agent_by_number: LookupMap::new(StorageKey::AgentByNumber),
        }
    }

    /// Upgrades V4 state in place: keeps everything and builds the packed face index from the
    /// issued passports, in passport order.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV4 = env::state_read().expect("no state to migrate");
        let mut list: Vec<(AccountId, u32, Vec<u8>)> = old.identities.iter().map(|(a, i)| (a.clone(), i.number, i.cells.clone())).collect();
        list.sort_by_key(|(_, n, _)| *n);
        let mut c = Self {
            owner: old.owner,
            verifiers: old.verifiers,
            threshold: old.threshold,
            fee_bps: old.fee_bps,
            min_pool: old.min_pool,
            min_builder_stake: old.min_builder_stake,
            min_bet: old.min_bet,
            k_factor: old.k_factor,
            next_round_id: old.next_round_id,
            rounds: old.rounds,
            positions: old.positions,
            ratings: old.ratings,
            scouts: old.scouts,
            identities: old.identities,
            next_identity: old.next_identity,
            face_pages: Vector::new(StorageKey::FacePages),
            agent_by_number: LookupMap::new(StorageKey::AgentByNumber),
        };
        for (agent, number, cells) in list {
            c.index_face(identity::pack(&cells), number, agent);
        }
        c
    }

    fn index_face(&mut self, packed: u64, number: u32, agent: AccountId) {
        let len = self.face_pages.len();
        match self.face_pages.get_mut(len.wrapping_sub(1)) {
            Some(page) if page.len() < identity::PAGE => page.push(packed),
            _ => self.face_pages.push(vec![packed]),
        }
        self.agent_by_number.insert(number, agent);
    }

    /// Closest issued face: (passport number, cells apart). Stops early on an exact repeat.
    fn nearest_face(&self, packed: u64) -> Option<(u32, u32)> {
        let mut best: Option<(u32, u32)> = None;
        let mut number = 0u32;
        for page in self.face_pages.iter() {
            for f in page {
                number += 1;
                let d = identity::packed_apart(packed, *f);
                if best.map_or(true, |(_, b)| d < b) {
                    best = Some((number, d));
                    if d == 0 {
                        return best;
                    }
                }
            }
        }
        best
    }

    // ----- identities -----

    /// Issues the agent's passport. The face is derived here from `seed`, the agent's own
    /// self-description, and must be at least `MIN_CELLS` cells away from every issued face.
    /// Called by the agent itself, or by the owner for agents that cannot sign (Market League).
    #[payable]
    pub fn register_identity(&mut self, agent: AccountId, seed: String, motto: String, config_hash: String, proof: String) -> u32 {
        let caller = env::predecessor_account_id();
        require!(caller == agent || caller == self.owner, "only the agent or the owner can issue its identity");
        require!(env::attached_deposit().as_yoctonear() >= IDENTITY_DEPOSIT, "attach 0.02 NEAR for storage");
        require!(!self.identities.contains_key(&agent), "identity already issued");
        require!(proof.len() <= 256 && config_hash.len() <= 128, "proof or config hash too long");
        if let Err(e) = identity::validate_motto(&motto) {
            env::panic_str(&e);
        }
        let check = self.check_face(seed.clone());
        if !check.ok {
            env::panic_str(&check.reason.unwrap_or_else(|| "face rejected".into()));
        }
        let number = self.next_identity;
        self.next_identity += 1;
        let face = identity::Face { cells: check.cells.clone(), palette: check.palette };
        let id = Identity {
            number,
            seed,
            cells: check.cells,
            palette: check.palette,
            motto: motto.trim().to_string(),
            config_hash,
            proof,
            issuer: caller,
            issued_at_ms: env::block_timestamp_ms(),
        };
        self.identities.insert(agent.clone(), id);
        self.index_face(identity::pack(&face.cells), number, agent.clone());
        emit(
            "identity_issued",
            json!({
                "agent": agent,
                "number": number,
                "cells": face.cells,
                "palette": face.palette,
                "face_code": identity::face_code(&face),
                "motto": motto.trim(),
            }),
        );
        number
    }

    /// The face this seed would produce and whether it would be accepted.
    pub fn check_face(&self, seed: String) -> FaceCheck {
        let seed_ok = identity::validate_seed(&seed);
        let face = if seed_ok.is_ok() { identity::derive(&seed) } else { identity::Face { cells: vec![], palette: [0; 3] } };
        let reject = |reason: String, face: identity::Face| FaceCheck {
            ok: false,
            reason: Some(reason),
            cells: face.cells,
            palette: face.palette,
            nearest: None,
            distance: None,
        };
        if let Err(e) = seed_ok {
            return reject(e, face);
        }
        if let Err(e) = identity::validate_fill(&face.cells) {
            return reject(e, face);
        }
        let nearest = self
            .nearest_face(identity::pack(&face.cells))
            .and_then(|(n, d)| self.agent_by_number.get(&n).map(|a| (a.clone(), d)));
        let clash = nearest.as_ref().filter(|(_, d)| *d < identity::MIN_CELLS);
        FaceCheck {
            ok: clash.is_none(),
            reason: clash.map(|(a, d)| format!("face too close to {a}: {d} cells apart, needs {}", identity::MIN_CELLS)),
            cells: face.cells,
            palette: face.palette,
            distance: nearest.as_ref().map(|n| n.1),
            nearest: nearest.map(|n| n.0),
        }
    }

    /// Number of faces in the uniqueness index (equals the number of issued passports).
    pub fn face_count(&self) -> u32 {
        self.face_pages.iter().map(|p| p.len() as u32).sum()
    }

    pub fn get_identity(&self, agent: AccountId) -> Option<IdentityView> {
        self.identities.get(&agent).map(|id| identity_view(&agent, id))
    }

    pub fn get_identities(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<IdentityView> {
        self.identities
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(a, id)| identity_view(a, id))
            .collect()
    }

    // ----- owner -----

    pub fn set_verifiers(&mut self, verifiers: Vec<PublicKey>, threshold: u8) {
        self.assert_owner();
        require!(threshold >= 1 && threshold as usize <= verifiers.len(), "bad threshold");
        verifiers.iter().for_each(|v| {
            ed25519_bytes(v);
        });
        self.verifiers = verifiers;
        self.threshold = threshold;
    }

    pub fn set_params(
        &mut self,
        fee_bps: Option<u16>,
        min_pool: Option<U128>,
        min_builder_stake: Option<U128>,
        min_bet: Option<U128>,
        k_factor: Option<u32>,
    ) {
        self.assert_owner();
        if let Some(v) = fee_bps {
            require!(v <= 1_000, "fee too high");
            self.fee_bps = v;
        }
        if let Some(v) = min_pool {
            self.min_pool = v.0;
        }
        if let Some(v) = min_builder_stake {
            self.min_builder_stake = v.0;
        }
        if let Some(v) = min_bet {
            self.min_bet = v.0;
        }
        if let Some(v) = k_factor {
            self.k_factor = v;
        }
    }

    // ----- manager -----

    #[payable]
    pub fn create_round(
        &mut self,
        skill: String,
        task_ref: String,
        tests_hash: String,
        bet_deadline_ms: u64,
        max_agents: u8,
    ) -> u64 {
        require!(!skill.is_empty() && skill.len() <= 64, "bad skill");
        require!(max_agents >= 2 && max_agents <= MAX_AGENTS, "max_agents must be 2..=16");
        require!(bet_deadline_ms > env::block_timestamp_ms(), "deadline in the past");
        let id = self.next_round_id;
        self.next_round_id += 1;
        let bounty = env::attached_deposit().as_yoctonear();
        let round = Round {
            id,
            manager: env::predecessor_account_id(),
            skill,
            task_ref,
            tests_hash,
            bet_deadline_ms,
            max_agents,
            bounty,
            status: RoundStatus::Open,
            entries: vec![],
            total_pool: 0,
            fee: 0,
            net: 0,
            payout_mode: PayoutMode::Pending,
            winner: None,
            total_tests: 0,
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
            }),
        );
        self.rounds.insert(id, round);
        id
    }

    #[payable]
    pub fn register_agent(&mut self, round_id: u64, agent: AccountId, league: League, config_hash: String) {
        let builder = env::predecessor_account_id();
        let stake = env::attached_deposit().as_yoctonear();
        let min_stake = self.min_builder_stake;
        let has_identity = self.identities.contains_key(&agent);
        let round = self.round_mut(round_id);
        require!(round.status == RoundStatus::Open, "round is not open");
        require!(env::block_timestamp_ms() < round.bet_deadline_ms, "registration closed");
        require!((round.entries.len() as u8) < round.max_agents, "round is full");
        require!(round.entries.iter().all(|e| e.agent != agent), "agent already registered");
        require!(has_identity, "agent has no identity: call register_identity first");
        if builder != round.manager {
            require!(stake >= min_stake, "builder stake below minimum");
        }
        round.entries.push(Entry {
            agent: agent.clone(),
            builder: builder.clone(),
            league,
            config_hash: config_hash.clone(),
            pool: 0,
            p_ppm: 0,
            market_ppm: 0,
            answer_hash: None,
            answered_at_ms: None,
            score: None,
            rating_before: 0,
            rating_delta: 0,
        });
        let index = round.entries.len() - 1;
        emit(
            "agent_registered",
            json!({
                "round_id": round_id,
                "agent": agent,
                "builder": builder,
                "league": league,
                "config_hash": config_hash,
                "stake": U128(stake),
            }),
        );
        if stake > 0 {
            self.add_bet(round_id, &builder, index, stake);
        }
    }

    pub fn lock_round(&mut self, round_id: u64) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let min_pool = self.min_pool;
        let mut round = self.rounds.remove(&round_id).unwrap_or_else(|| env::panic_str("no such round"));
        require!(round.status == RoundStatus::Open, "round is not open");
        require!(caller == round.manager || now >= round.bet_deadline_ms, "only the manager can lock before the deadline");
        require!(round.entries.len() >= 2, "need at least 2 agents");
        let pools: Vec<u128> = round.entries.iter().map(|e| e.pool).collect();
        let ratings: Vec<i64> = round
            .entries
            .iter()
            .map(|e| self.rating_of(&e.agent, &round.skill).rating)
            .collect();
        let market = math::market_odds_ppm(&pools);
        let p = math::blended_odds_ppm(&pools, &ratings, min_pool);
        for (i, e) in round.entries.iter_mut().enumerate() {
            e.market_ppm = market[i];
            e.p_ppm = p[i];
            e.rating_before = ratings[i];
        }
        round.status = RoundStatus::Locked;
        round.locked_at_ms = Some(now);
        emit(
            "round_locked",
            json!({
                "round_id": round_id,
                "total_pool": U128(round.total_pool),
                "odds": round.entries.iter().map(|e| json!({
                    "agent": e.agent,
                    "market_ppm": e.market_ppm,
                    "p_ppm": e.p_ppm,
                    "rating": e.rating_before,
                })).collect::<Vec<_>>(),
            }),
        );
        self.rounds.insert(round_id, round);
    }

    pub fn cancel_round(&mut self, round_id: u64) {
        let caller = env::predecessor_account_id();
        let round = self.round_mut(round_id);
        require!(caller == round.manager, "only the manager can cancel");
        require!(
            round.status == RoundStatus::Open || round.status == RoundStatus::Locked,
            "round already finished"
        );
        round.status = RoundStatus::Cancelled;
        round.payout_mode = PayoutMode::Refund;
        round.settled_at_ms = Some(env::block_timestamp_ms());
        let bounty = round.bounty;
        let manager = round.manager.clone();
        emit("round_cancelled", json!({ "round_id": round_id }));
        if bounty > 0 {
            Promise::new(manager).transfer(NearToken::from_yoctonear(bounty)).detach();
        }
    }

    // ----- market -----

    #[payable]
    pub fn seed(&mut self, round_id: u64) {
        let caller = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        let round = self.round_ref(round_id);
        require!(round.status == RoundStatus::Open, "round is not open");
        require!(env::block_timestamp_ms() < round.bet_deadline_ms, "betting closed");
        let n = round.entries.len() as u128;
        require!(n > 0, "no agents to seed");
        require!(amount >= n, "deposit too small");
        let share = amount / n;
        let rest = amount % n;
        for i in 0..n as usize {
            let a = if i == 0 { share + rest } else { share };
            self.add_bet(round_id, &caller, i, a);
        }
    }

    #[payable]
    pub fn place_bet(&mut self, round_id: u64, agent: AccountId) {
        let caller = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= self.min_bet, "bet below minimum");
        let round = self.round_ref(round_id);
        require!(round.status == RoundStatus::Open, "round is not open");
        require!(env::block_timestamp_ms() < round.bet_deadline_ms, "betting closed");
        let index = round
            .entries
            .iter()
            .position(|e| e.agent == agent)
            .unwrap_or_else(|| env::panic_str("agent not in this round"));
        self.add_bet(round_id, &caller, index, amount);
    }

    // ----- agents -----

    pub fn submit_answer(&mut self, round_id: u64, answer_hash: String) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        require!(!answer_hash.is_empty() && answer_hash.len() <= 128, "bad answer hash");
        let round = self.round_mut(round_id);
        require!(round.status == RoundStatus::Locked, "answers are accepted only after lock");
        let entry = round
            .entries
            .iter_mut()
            .find(|e| e.agent == caller)
            .unwrap_or_else(|| env::panic_str("caller is not an agent in this round"));
        require!(entry.answer_hash.is_none(), "answer already submitted");
        entry.answer_hash = Some(answer_hash.clone());
        entry.answered_at_ms = Some(now);
        emit(
            "answer_submitted",
            json!({ "round_id": round_id, "agent": caller, "answer_hash": answer_hash, "at_ms": now }),
        );
    }

    // ----- verifier -----

    pub fn settle(&mut self, round_id: u64, total_tests: u32, scores: Vec<(AccountId, u32)>, signatures: Vec<Base64VecU8>) {
        let now = env::block_timestamp_ms();
        let mut round = self.rounds.remove(&round_id).unwrap_or_else(|| env::panic_str("no such round"));
        require!(round.status == RoundStatus::Locked, "round is not locked");
        require!(total_tests > 0, "total_tests must be positive");
        require!(scores.len() == round.entries.len(), "scores must cover every agent");
        for (i, (agent, score)) in scores.iter().enumerate() {
            let e = &round.entries[i];
            require!(*agent == e.agent, "scores must follow registration order");
            require!(*score <= total_tests, "score above total");
            if e.answer_hash.is_none() {
                require!(*score == 0, "agent without an answer must score 0");
            }
        }

        // Signatures over the canonical message.
        let pairs: Vec<(&str, u32)> = scores.iter().map(|(a, s)| (a.as_str(), *s)).collect();
        let message = math::settlement_message(round_id, total_tests, &pairs);
        let digest = env::sha256_array(message.as_bytes());
        let mut used = vec![false; self.verifiers.len()];
        let mut valid = 0u8;
        for sig in signatures.iter() {
            let bytes: [u8; 64] = match sig.0.as_slice().try_into() {
                Ok(b) => b,
                Err(_) => continue,
            };
            for (k, pk) in self.verifiers.iter().enumerate() {
                if !used[k] && env::ed25519_verify(&bytes, &digest, &ed25519_bytes(pk)) {
                    used[k] = true;
                    valid += 1;
                    break;
                }
            }
        }
        require!(valid >= self.threshold, "not enough valid verifier signatures");

        for (i, (_, score)) in scores.iter().enumerate() {
            round.entries[i].score = Some(*score);
        }
        round.total_tests = total_tests;
        round.status = RoundStatus::Settled;
        round.settled_at_ms = Some(now);

        let score_list: Vec<u32> = scores.iter().map(|(_, s)| *s).collect();
        let times: Vec<Option<u64>> = round.entries.iter().map(|e| e.answered_at_ms).collect();
        let ids: Vec<&str> = round.entries.iter().map(|e| e.agent.as_str()).collect();
        let winner = math::pick_winner(&score_list, &times, &ids);

        let mut transfers: Vec<(AccountId, u128)> = vec![];
        match winner {
            None => {
                round.payout_mode = PayoutMode::Refund;
                if round.bounty > 0 {
                    transfers.push((round.manager.clone(), round.bounty));
                }
            }
            Some(w) => {
                round.winner = Some(w as u8);
                if round.entries[w].pool == 0 {
                    round.payout_mode = PayoutMode::Refund;
                } else {
                    round.payout_mode = PayoutMode::Winners;
                    round.fee = math::fee(round.total_pool, self.fee_bps);
                    round.net = round.total_pool - round.fee;
                    if round.fee > 0 {
                        transfers.push((self.owner.clone(), round.fee));
                    }
                }
                if round.bounty > 0 {
                    transfers.push((round.entries[w].agent.clone(), round.bounty));
                }
                // Ratings.
                let p: Vec<u64> = round.entries.iter().map(|e| e.p_ppm).collect();
                let deltas = math::rating_deltas(&p, w, self.k_factor);
                let skill = round.skill.clone();
                for (i, e) in round.entries.iter_mut().enumerate() {
                    let key = RatingKey { skill: skill.clone(), agent: e.agent.clone() };
                    let mut r = self.ratings.get(&key).cloned().unwrap_or_default();
                    let old = r.rating;
                    r.rating += deltas[i];
                    r.rounds += 1;
                    if i == w {
                        r.wins += 1;
                    }
                    r.last_round = round_id;
                    e.rating_delta = deltas[i];
                    emit(
                        "rating_updated",
                        json!({
                            "round_id": round_id,
                            "agent": e.agent,
                            "skill": skill,
                            "old_rating": old,
                            "new_rating": r.rating,
                            "delta": deltas[i],
                            "p_ppm": e.p_ppm,
                        }),
                    );
                    self.ratings.insert(key, r);
                }
            }
        }

        emit(
            "round_settled",
            json!({
                "round_id": round_id,
                "winner": winner.map(|w| round.entries[w].agent.clone()),
                "total_tests": total_tests,
                "scores": scores.iter().map(|(a, s)| json!({ "agent": a, "score": s })).collect::<Vec<_>>(),
                "total_pool": U128(round.total_pool),
                "fee": U128(round.fee),
                "payout_mode": round.payout_mode,
                "message": message,
            }),
        );
        self.rounds.insert(round_id, round);
        for (to, amount) in transfers {
            Promise::new(to).transfer(NearToken::from_yoctonear(amount)).detach();
        }
    }

    // ----- claims -----

    pub fn claim(&mut self, round_id: u64) -> U128 {
        let caller = env::predecessor_account_id();
        let round = self.round_ref(round_id);
        require!(
            round.status == RoundStatus::Settled || round.status == RoundStatus::Cancelled,
            "round not finished"
        );
        let mode = round.payout_mode;
        let winner = round.winner.map(|w| w as usize);
        let net = round.net;
        let winner_pool = winner.map(|w| round.entries[w].pool).unwrap_or(0);

        let key = (round_id, caller.clone());
        let pos = self.positions.get_mut(&key).unwrap_or_else(|| env::panic_str("no position"));
        require!(!pos.claimed, "already claimed");
        pos.claimed = true;
        let amount = match mode {
            PayoutMode::Refund => pos.amounts.iter().sum(),
            PayoutMode::Winners => {
                let w = winner.unwrap();
                let on_winner = pos.amounts.get(w).copied().unwrap_or(0);
                math::payout(on_winner, winner_pool, net)
            }
            PayoutMode::Pending => env::panic_str("round not finished"),
        };
        let won = mode == PayoutMode::Winners && amount > 0;
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

    // ----- views -----

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            verifiers: self.verifiers.clone(),
            threshold: self.threshold,
            fee_bps: self.fee_bps,
            min_pool: U128(self.min_pool),
            min_builder_stake: U128(self.min_builder_stake),
            min_bet: U128(self.min_bet),
            k_factor: self.k_factor,
            next_round_id: self.next_round_id,
        }
    }

    pub fn get_round(&self, round_id: u64) -> Option<RoundView> {
        self.rounds.get(&round_id).map(|r| self.round_view(r))
    }

    /// Rounds in descending id order, starting below `before` (exclusive) if given.
    pub fn get_rounds(&self, before: Option<u64>, limit: Option<u64>) -> Vec<RoundView> {
        let start = before.unwrap_or(self.next_round_id).min(self.next_round_id);
        let limit = limit.unwrap_or(10).min(50);
        (1..start)
            .rev()
            .take(limit as usize)
            .filter_map(|id| self.rounds.get(&id).map(|r| self.round_view(r)))
            .collect()
    }

    pub fn get_position(&self, round_id: u64, account: AccountId) -> Vec<PositionView> {
        let round = match self.rounds.get(&round_id) {
            Some(r) => r,
            None => return vec![],
        };
        let pos = match self.positions.get(&(round_id, account)) {
            Some(p) => p,
            None => return vec![],
        };
        round
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| PositionView { agent: e.agent.clone(), amount: U128(pos.amounts.get(i).copied().unwrap_or(0)) })
            .collect()
    }

    pub fn get_rating(&self, agent: AccountId, skill: String) -> RatingView {
        let r = self.rating_of(&agent, &skill);
        RatingView {
            agent,
            skill,
            rating: r.rating,
            rounds: r.rounds,
            wins: r.wins,
            provisional: r.rounds < PROVISIONAL_ROUNDS,
            last_round: r.last_round,
        }
    }

    /// True when the agent has at least `min_rating` (whole points) and `min_rounds` rounds in the skill.
    pub fn is_qualified(&self, agent: AccountId, skill: String, min_rating: u32, min_rounds: Option<u32>) -> bool {
        let r = self.rating_of(&agent, &skill);
        r.rounds >= min_rounds.unwrap_or(PROVISIONAL_ROUNDS).max(1) && r.rating >= min_rating as i64 * 100
    }

    pub fn get_leaderboard(&self, skill: String, limit: Option<u32>) -> Vec<RatingView> {
        let mut rows: Vec<RatingView> = self
            .ratings
            .iter()
            .filter(|(k, _)| k.skill == skill)
            .map(|(k, r)| RatingView {
                agent: k.agent.clone(),
                skill: k.skill.clone(),
                rating: r.rating,
                rounds: r.rounds,
                wins: r.wins,
                provisional: r.rounds < PROVISIONAL_ROUNDS,
                last_round: r.last_round,
            })
            .collect();
        rows.sort_by(|a, b| b.rating.cmp(&a.rating).then(a.agent.cmp(&b.agent)));
        rows.truncate(limit.unwrap_or(50).min(200) as usize);
        rows
    }

    pub fn get_scouts(&self, limit: Option<u32>) -> Vec<ScoutView> {
        let mut rows: Vec<ScoutView> = self.scouts.iter().map(|(a, s)| scout_view(a, s)).collect();
        rows.sort_by(|a, b| {
            let pa: i128 = a.pnl.parse().unwrap_or(0);
            let pb: i128 = b.pnl.parse().unwrap_or(0);
            pb.cmp(&pa).then(a.account.cmp(&b.account))
        });
        rows.truncate(limit.unwrap_or(50).min(200) as usize);
        rows
    }

    pub fn get_scout(&self, account: AccountId) -> ScoutView {
        let s = self.scouts.get(&account).cloned().unwrap_or_default();
        scout_view(&account, &s)
    }
}

fn scout_view(account: &AccountId, s: &Scout) -> ScoutView {
    ScoutView {
        account: account.clone(),
        staked: U128(s.staked),
        returned: U128(s.returned),
        pnl: (s.returned as i128 - s.staked as i128).to_string(),
        bets: s.bets,
        wins: s.wins,
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    fn round_ref(&self, round_id: u64) -> &Round {
        self.rounds.get(&round_id).unwrap_or_else(|| env::panic_str("no such round"))
    }

    fn round_mut(&mut self, round_id: u64) -> &mut Round {
        self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("no such round"))
    }

    fn rating_of(&self, agent: &AccountId, skill: &str) -> Rating {
        let key = RatingKey { skill: skill.to_string(), agent: agent.clone() };
        self.ratings.get(&key).cloned().unwrap_or_default()
    }

    fn add_bet(&mut self, round_id: u64, bettor: &AccountId, index: usize, amount: u128) {
        let round = self.round_mut(round_id);
        round.entries[index].pool += amount;
        round.total_pool += amount;
        let new_pool = round.entries[index].pool;
        let total = round.total_pool;
        let agent = round.entries[index].agent.clone();
        let n = round.entries.len();
        let pos = self.positions.entry((round_id, bettor.clone())).or_default();
        if pos.amounts.len() < n {
            pos.amounts.resize(n, 0);
        }
        pos.amounts[index] += amount;
        let scout = self.scouts.entry(bettor.clone()).or_default();
        scout.staked += amount;
        scout.bets += 1;
        emit(
            "bet_placed",
            json!({
                "round_id": round_id,
                "bettor": bettor,
                "agent": agent,
                "amount": U128(amount),
                "agent_pool": U128(new_pool),
                "total_pool": U128(total),
            }),
        );
    }

    fn round_view(&self, r: &Round) -> RoundView {
        let pools: Vec<u128> = r.entries.iter().map(|e| e.pool).collect();
        let odds = math::market_odds_ppm(&pools);
        RoundView {
            id: r.id,
            manager: r.manager.clone(),
            skill: r.skill.clone(),
            task_ref: r.task_ref.clone(),
            tests_hash: r.tests_hash.clone(),
            bet_deadline_ms: r.bet_deadline_ms,
            max_agents: r.max_agents,
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
                    pool: U128(e.pool),
                    odds_ppm: odds[i],
                    p_ppm: e.p_ppm,
                    market_ppm: e.market_ppm,
                    answer_hash: e.answer_hash.clone(),
                    answered_at_ms: e.answered_at_ms,
                    score: e.score,
                    rating_before: e.rating_before,
                    rating_delta: e.rating_delta,
                })
                .collect(),
            total_pool: U128(r.total_pool),
            fee: U128(r.fee),
            net: U128(r.net),
            payout_mode: r.payout_mode,
            winner: r.winner.map(|w| r.entries[w as usize].agent.clone()),
            total_tests: r.total_tests,
            created_at_ms: r.created_at_ms,
            locked_at_ms: r.locked_at_ms,
            settled_at_ms: r.settled_at_ms,
        }
    }
}

#[cfg(test)]
mod tests;
