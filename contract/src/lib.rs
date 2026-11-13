//! Benchmarket contract.
//!
//! Rounds with an LMSR prediction market, verifier-signed settlement behind a dispute window,
//! per-skill ratings measured against the task and the field, inference attestation, passports
//! and hiring jobs with escrow. The rules live in RULES.md.

pub mod attest;
pub mod briefs;
pub mod identity;
pub mod legacy;
pub mod math;

mod jobs;
mod passports;
mod rounds;
mod settle;

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, CurveType, PanicOnDefault, PublicKey};

pub use attest::Attestation;
pub use briefs::{Brief, BriefStatus, BriefView, ScoutRecord};
pub use jobs::{Job, JobStatus, JobView};
use legacy::{PositionV1, RoundV1};
use math::INITIAL_RATING;

pub const ONE_NEAR: u128 = 10u128.pow(24);
pub const PROVISIONAL_ROUNDS: u32 = 3;
pub const MAX_AGENTS: u8 = 16;
/// Rounds in a row in which every entrant passed every test before a task is retired.
pub const SATURATION_LIMIT: u32 = 2;
/// Storage paid by the agent for its passport.
pub const IDENTITY_DEPOSIT: u128 = ONE_NEAR / 50;

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
    RoundsV2,
    PositionsV2,
    RatingsV2,
    ScoutsV2,
    Tasks,
    Jobs,
    VerifierStakes,
    Briefs,
    JobBrief,
    ScoutRecords,
    Categories,
    TaskCategory,
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
    /// Agents register.
    Open,
    /// The market maker is funded; scouts buy shares.
    Trading,
    /// Odds are fixed; agents answer.
    Locked,
    /// Verifier scores are posted; anyone may dispute until `dispute_until_ms`.
    Proposed,
    /// Under dispute; arbiters decide.
    Disputed,
    Settled,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayoutMode {
    /// Not settled yet.
    Pending,
    /// Shares on the winners pay out.
    Winners,
    /// Every purchase is refunded.
    Refund,
}

/// Owner-tunable parameters.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// Fee on every market purchase and on paid jobs, basis points.
    pub fee_bps: u16,
    /// Market volume at which prices get full weight in the expected score.
    pub min_pool: U128,
    /// Bond a builder posts when registering an agent; returned if the agent answers.
    pub min_builder_stake: U128,
    pub min_bet: U128,
    /// K of the update against the field (market-expected share of points).
    pub k_field: u32,
    /// K of the update against the task (expected pass rate).
    pub k_task: u32,
    pub answer_window_ms: u64,
    pub dispute_window_ms: u64,
    pub resolve_timeout_ms: u64,
    /// After the answer deadline, how long the verifier has to post scores before anyone may cancel.
    pub settle_timeout_ms: u64,
    pub dispute_bond: U128,
    /// Stake a verifier key needs for its signature to count.
    pub min_verifier_stake: U128,
    pub unstake_delay_ms: u64,
    /// Distinct traders per round (their scores are updated at settlement).
    pub max_bettors: u32,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            fee_bps: 200,
            min_pool: U128(10 * ONE_NEAR),
            min_builder_stake: U128(ONE_NEAR / 2),
            min_bet: U128(ONE_NEAR / 100),
            k_field: 16,
            k_task: 16,
            answer_window_ms: 15 * 60_000,
            dispute_window_ms: 24 * 3_600_000,
            resolve_timeout_ms: 3 * 24 * 3_600_000,
            settle_timeout_ms: 24 * 3_600_000,
            dispute_bond: U128(ONE_NEAR),
            min_verifier_stake: U128(ONE_NEAR),
            unstake_delay_ms: 7 * 24 * 3_600_000,
            max_bettors: 64,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Entry {
    pub agent: AccountId,
    pub builder: AccountId,
    pub league: League,
    pub config_hash: String,
    pub bond: u128,
    /// Shares sold on this entrant.
    pub shares: u128,
    /// Expected share of points at lock time, ppm.
    pub p_ppm: u64,
    /// Market price at lock time, ppm.
    pub price_ppm: u64,
    pub answer_hash: Option<String>,
    pub answered_at_ms: Option<u64>,
    /// Set when the answer came with a valid inference attestation.
    pub attested: bool,
    pub model: Option<String>,
    pub request_hash: Option<String>,
    pub score: Option<u32>,
    pub rating_before: i64,
    pub field_delta: i64,
    pub task_delta: i64,
}

/// Scores posted by verifiers, waiting out the dispute window.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Proposal {
    pub total_tests: u32,
    pub scores: Vec<u32>,
    pub signers: Vec<PublicKey>,
    pub proposed_at_ms: u64,
    pub dispute_until_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Dispute {
    pub by: AccountId,
    pub bond: u128,
    pub at_ms: u64,
    /// Set once arbiters rule: true when they changed the scores.
    pub overturned: Option<bool>,
}

#[near(serializers = [borsh])]
pub struct Round {
    pub id: u64,
    pub manager: AccountId,
    pub skill: String,
    pub task_ref: String,
    pub tests_hash: String,
    pub bet_deadline_ms: u64,
    pub answer_deadline_ms: u64,
    pub max_agents: u8,
    /// Answers must carry an inference attestation.
    pub attested: bool,
    /// The task is curated, so the round moves ratings.
    pub rated: bool,
    pub bounty: u128,
    pub status: RoundStatus,
    pub entries: Vec<Entry>,
    /// LMSR liquidity and the subsidy that funds it.
    pub liquidity: u128,
    pub subsidy: u128,
    /// Sum of purchases net of fees.
    pub volume: u128,
    pub fees: u128,
    pub bettors: Vec<AccountId>,
    pub payout_mode: PayoutMode,
    pub winners: Vec<u8>,
    /// What the winning shares are owed in total, and what claims have taken so far.
    pub payout_budget: u128,
    pub paid_out: u128,
    pub total_tests: u32,
    pub task_rating_before: i64,
    pub task_delta: i64,
    pub proposal: Option<Proposal>,
    pub dispute: Option<Dispute>,
    pub created_at_ms: u64,
    pub locked_at_ms: Option<u64>,
    pub settled_at_ms: Option<u64>,
}

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Position {
    /// Shares held on each entry, indexed like `Round::entries`.
    pub shares: Vec<u128>,
    /// Builder bonds on each entry.
    pub bonds: Vec<u128>,
    /// Everything paid for shares, fees included (refunded on cancel).
    pub paid: u128,
    /// Paid for shares net of fees.
    pub spent: u128,
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
    /// Rounds and jobs whose answer carried a valid inference attestation.
    pub attested: u32,
    pub jobs_done: u32,
    pub jobs_failed: u32,
}

impl Default for Rating {
    fn default() -> Self {
        Self { rating: INITIAL_RATING, rounds: 0, wins: 0, last_round: 0, attested: 0, jobs_done: 0, jobs_failed: 0 }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Scout {
    pub staked: u128,
    pub returned: u128,
    pub bets: u32,
    pub wins: u32,
    /// Sum over scored rounds of (gross payout - spent) / liquidity, ppm. With an LMSR maker
    /// this is the trader's logarithmic-score improvement: a proper score of forecasting skill
    /// that does not grow with bet size.
    pub skill_ppm: i64,
    pub scored_rounds: u32,
}

/// Difficulty record of a task (one `task_ref`).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TaskRecord {
    pub skill: String,
    /// Curated tasks are added by the owner with their tests hash. Only they move ratings:
    /// anyone can run a round or post a job on any task, but a task its own author wrote
    /// would let them farm rating.
    pub curated: bool,
    pub tests_hash: String,
    /// Centi-points, like agent ratings: an agent rated the same is expected to pass half the tests.
    pub rating: i64,
    pub rounds: u32,
    pub jobs: u32,
    /// Consecutive rounds where every entrant passed every test.
    pub saturated: u32,
    pub retired: bool,
}

/// A kind of work a client can ask for; curated tasks are filed under one.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Category {
    pub title: String,
    pub description: String,
}

#[near(serializers = [json])]
pub struct CategoryView {
    pub id: String,
    pub title: String,
    pub description: String,
    pub skill_tasks: Vec<String>,
}

/// Prefix of a curated task's `tests_hash` when the task is a family: every round commits fresh
/// tests generated from a secret seed (revealed with the report) instead of one fixed set.
pub const FAMILY_PREFIX: &str = "family:";

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct VerifierStake {
    pub owner: AccountId,
    pub amount: u128,
    /// Set by `request_unstake`; the key's signatures stop counting at once.
    pub unlock_at_ms: Option<u64>,
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

// ---------- JSON views ----------

#[near(serializers = [json])]
pub struct EntryView {
    pub agent: AccountId,
    pub builder: AccountId,
    pub league: League,
    pub config_hash: String,
    pub bond: U128,
    pub shares: U128,
    /// Current market price, ppm.
    pub odds_ppm: u64,
    pub p_ppm: u64,
    /// Price at lock, ppm (pool share for parimutuel rounds).
    pub market_ppm: u64,
    pub answer_hash: Option<String>,
    pub answered_at_ms: Option<u64>,
    pub attested: bool,
    pub model: Option<String>,
    pub request_hash: Option<String>,
    pub score: Option<u32>,
    pub rating_before: i64,
    pub rating_delta: i64,
    pub field_delta: i64,
    pub task_delta: i64,
}

#[near(serializers = [json])]
pub struct ProposalView {
    pub total_tests: u32,
    pub scores: Vec<(AccountId, u32)>,
    pub signers: Vec<PublicKey>,
    pub proposed_at_ms: u64,
    pub dispute_until_ms: u64,
}

#[near(serializers = [json])]
pub struct DisputeView {
    pub by: AccountId,
    pub bond: U128,
    pub at_ms: u64,
    pub overturned: Option<bool>,
}

#[near(serializers = [json])]
pub struct RoundView {
    pub id: u64,
    /// "lmsr" for V6 rounds, "parimutuel" for rounds created before.
    pub market: String,
    pub manager: AccountId,
    pub skill: String,
    pub task_ref: String,
    pub tests_hash: String,
    pub bet_deadline_ms: u64,
    pub answer_deadline_ms: u64,
    pub max_agents: u8,
    pub attested: bool,
    pub rated: bool,
    pub bounty: U128,
    pub status: RoundStatus,
    pub entries: Vec<EntryView>,
    pub liquidity: U128,
    pub subsidy: U128,
    /// Purchases net of fees (the pool for parimutuel rounds).
    pub total_pool: U128,
    pub fee: U128,
    pub bettors: u32,
    pub payout_mode: PayoutMode,
    pub winners: Vec<AccountId>,
    /// First winner, for clients that show one.
    pub winner: Option<AccountId>,
    pub total_tests: u32,
    pub task_rating_before: i64,
    pub task_delta: i64,
    pub proposal: Option<ProposalView>,
    pub dispute: Option<DisputeView>,
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
    pub attested: u32,
    pub jobs_done: u32,
    pub jobs_failed: u32,
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
    pub skill_ppm: i64,
    pub scored_rounds: u32,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub agent: AccountId,
    /// Shares (V6) or amount bet (parimutuel).
    pub amount: U128,
    pub bond: U128,
}

#[near(serializers = [json])]
pub struct TaskView {
    pub task_ref: String,
    pub category: Option<String>,
    #[serde(flatten)]
    pub record: TaskRecord,
}

#[near(serializers = [json])]
pub struct StakeView {
    pub public_key: PublicKey,
    pub owner: AccountId,
    pub amount: U128,
    pub unlock_at_ms: Option<u64>,
    pub active: bool,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub verifiers: Vec<PublicKey>,
    pub threshold: u8,
    pub arbiters: Vec<PublicKey>,
    pub arbiter_threshold: u8,
    pub inference_signers: Vec<String>,
    pub params: Params,
    pub next_round_id: u64,
    pub first_lmsr_round: u64,
    pub next_job_id: u64,
    pub next_brief_id: u64,
    /// Kept for clients of the V5 view.
    pub fee_bps: u16,
    pub min_pool: U128,
    pub min_builder_stake: U128,
    pub min_bet: U128,
    pub k_factor: u32,
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
    arbiters: Vec<PublicKey>,
    arbiter_threshold: u8,
    /// Hex ed25519 keys whose inference signatures the league trusts (NEAR AI Cloud).
    inference_signers: Vec<String>,
    params: Params,
    next_round_id: u64,
    /// Rounds below this id live in the legacy (parimutuel) storage.
    first_lmsr_round: u64,
    legacy_rounds: LookupMap<u64, RoundV1>,
    legacy_positions: LookupMap<(u64, AccountId), PositionV1>,
    rounds: LookupMap<u64, Round>,
    positions: LookupMap<(u64, AccountId), Position>,
    ratings: IterableMap<RatingKey, Rating>,
    scouts: IterableMap<AccountId, Scout>,
    tasks: IterableMap<String, TaskRecord>,
    jobs: LookupMap<u64, Job>,
    next_job_id: u64,
    verifier_stakes: LookupMap<PublicKey, VerifierStake>,
    identities: IterableMap<AccountId, Identity>,
    next_identity: u32,
    /// Every issued face packed into a u64, in passport order, `PAGE` faces per storage entry.
    /// The uniqueness check reads these pages instead of every passport.
    face_pages: Vector<Vec<u64>>,
    agent_by_number: LookupMap<u32, AccountId>,
    briefs: LookupMap<u64, Brief>,
    next_brief_id: u64,
    /// Jobs created from a brief's accepted offer.
    job_brief: LookupMap<u64, u64>,
    scout_records: LookupMap<AccountId, ScoutRecord>,
    categories: IterableMap<String, Category>,
    task_category: LookupMap<String, String>,
}

pub(crate) fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let log = json!({
        "standard": "benchmarket",
        "version": "2.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

pub(crate) fn identity_view(agent: &AccountId, id: &Identity) -> IdentityView {
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

pub(crate) fn ed25519_bytes(pk: &PublicKey) -> [u8; 32] {
    require!(pk.curve_type() == CurveType::ED25519, "keys must be ed25519");
    let raw = pk.as_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw[1..33]);
    out
}

fn check_keys(keys: &[PublicKey], threshold: u8, allow_empty: bool) {
    if keys.is_empty() && allow_empty && threshold == 0 {
        return;
    }
    require!(threshold >= 1 && threshold as usize <= keys.len(), "bad threshold");
    keys.iter().for_each(|v| {
        ed25519_bytes(v);
    });
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, verifiers: Vec<PublicKey>, threshold: u8) -> Self {
        check_keys(&verifiers, threshold, false);
        Self {
            owner,
            verifiers,
            threshold,
            arbiters: vec![],
            arbiter_threshold: 0,
            inference_signers: vec![],
            params: Params::default(),
            next_round_id: 1,
            first_lmsr_round: 1,
            legacy_rounds: LookupMap::new(StorageKey::Rounds),
            legacy_positions: LookupMap::new(StorageKey::Positions),
            rounds: LookupMap::new(StorageKey::RoundsV2),
            positions: LookupMap::new(StorageKey::PositionsV2),
            ratings: IterableMap::new(StorageKey::RatingsV2),
            scouts: IterableMap::new(StorageKey::ScoutsV2),
            tasks: IterableMap::new(StorageKey::Tasks),
            jobs: LookupMap::new(StorageKey::Jobs),
            next_job_id: 1,
            verifier_stakes: LookupMap::new(StorageKey::VerifierStakes),
            identities: IterableMap::new(StorageKey::IdentitiesV4),
            next_identity: 1,
            face_pages: Vector::new(StorageKey::FacePages),
            agent_by_number: LookupMap::new(StorageKey::AgentByNumber),
            briefs: LookupMap::new(StorageKey::Briefs),
            next_brief_id: 1,
            job_brief: LookupMap::new(StorageKey::JobBrief),
            scout_records: LookupMap::new(StorageKey::ScoutRecords),
            categories: IterableMap::new(StorageKey::Categories),
            task_category: LookupMap::new(StorageKey::TaskCategory),
        }
    }

    /// Upgrades V6 state in place: everything is kept; briefs start empty. (V5 to V6 was the
    /// previous migration; V5 rounds stay readable as legacy.)
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: legacy::ContractV6 = env::state_read().expect("no state to migrate");
        Self {
            owner: old.owner,
            verifiers: old.verifiers,
            threshold: old.threshold,
            arbiters: old.arbiters,
            arbiter_threshold: old.arbiter_threshold,
            inference_signers: old.inference_signers,
            params: old.params,
            next_round_id: old.next_round_id,
            first_lmsr_round: old.first_lmsr_round,
            legacy_rounds: old.legacy_rounds,
            legacy_positions: old.legacy_positions,
            rounds: old.rounds,
            positions: old.positions,
            ratings: old.ratings,
            scouts: old.scouts,
            tasks: old.tasks,
            jobs: old.jobs,
            next_job_id: old.next_job_id,
            verifier_stakes: old.verifier_stakes,
            identities: old.identities,
            next_identity: old.next_identity,
            face_pages: old.face_pages,
            agent_by_number: old.agent_by_number,
            briefs: LookupMap::new(StorageKey::Briefs),
            next_brief_id: 1,
            job_brief: LookupMap::new(StorageKey::JobBrief),
            scout_records: LookupMap::new(StorageKey::ScoutRecords),
            categories: IterableMap::new(StorageKey::Categories),
            task_category: LookupMap::new(StorageKey::TaskCategory),
        }
    }

    // ----- owner -----

    pub fn set_verifiers(&mut self, verifiers: Vec<PublicKey>, threshold: u8) {
        self.assert_owner();
        check_keys(&verifiers, threshold, false);
        self.verifiers = verifiers;
        self.threshold = threshold;
    }

    /// Arbiters decide disputes. An empty list means disputes can only expire (full refund).
    pub fn set_arbiters(&mut self, arbiters: Vec<PublicKey>, threshold: u8) {
        self.assert_owner();
        check_keys(&arbiters, threshold, true);
        self.arbiters = arbiters;
        self.arbiter_threshold = threshold;
    }

    /// Inference signing keys trusted after checking their attestation reports:
    /// `model:<key>` for a model's own enclave, `gateway:<key>` (or a bare key) for the NEAR AI
    /// gateway; a key is 64 hex (ed25519) or a 0x address (ECDSA).
    pub fn set_inference_signers(&mut self, signers: Vec<String>) {
        self.assert_owner();
        require!(signers.len() <= 64, "at most 64 signers");
        for s in &signers {
            require!(attest::parse_signer(s).is_some(), "signer must be [model:|gateway:]<64 hex or 0x address>");
        }
        self.inference_signers = signers.into_iter().map(|s| s.to_ascii_lowercase()).collect();
    }

    /// Hands the contract to a new owner (a DAO, for a live league).
    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        emit("owner_changed", json!({ "from": self.owner, "to": owner }));
        self.owner = owner;
    }

    pub fn set_params(&mut self, params: Params) {
        self.assert_owner();
        require!(params.fee_bps <= 1_000, "fee too high");
        require!(params.max_bettors >= 1 && params.max_bettors <= 256, "max_bettors must be 1..=256");
        require!(params.answer_window_ms > 0, "answer window must be positive");
        require!(
            params.unstake_delay_ms >= params.dispute_window_ms + params.resolve_timeout_ms,
            "unstake delay must cover the dispute window and the resolve timeout"
        );
        self.params = params;
    }

    /// Adds a curated task to the rated pool. Rounds and jobs on it must commit `tests_hash`.
    pub fn add_task(&mut self, task_ref: String, skill: String, tests_hash: String) {
        self.assert_owner();
        require!(!task_ref.is_empty() && task_ref.len() <= 64, "bad task_ref");
        require!(!skill.is_empty() && skill.len() <= 64, "bad skill");
        require!(!tests_hash.is_empty() && tests_hash.len() <= 136, "bad tests hash");
        require!(!self.tasks.contains_key(&task_ref), "task already exists");
        self.tasks.insert(
            task_ref.clone(),
            TaskRecord { skill: skill.clone(), curated: true, tests_hash, rating: INITIAL_RATING, rounds: 0, jobs: 0, saturated: 0, retired: false },
        );
        emit("task_added", json!({ "task_ref": task_ref, "skill": skill }));
    }

    /// Adds or updates a category clients can pick for a brief.
    pub fn set_category(&mut self, id: String, title: String, description: String) {
        self.assert_owner();
        require!(!id.is_empty() && id.len() <= 32 && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'), "category id: lowercase, digits, dashes");
        require!(!title.is_empty() && title.len() <= 64 && description.len() <= 300, "bad title or description");
        self.categories.insert(id.clone(), Category { title, description });
        emit("category_set", json!({ "category": id }));
    }

    /// Re-pins a curated task's tests: a new fixed set, or `family:<hash of generator and
    /// reference>` to run every round on fresh tests. Its rating history is kept.
    pub fn set_task_tests(&mut self, task_ref: String, tests_hash: String) {
        self.assert_owner();
        require!(!tests_hash.is_empty() && tests_hash.len() <= 136, "bad tests hash");
        let t = self.tasks.get_mut(&task_ref).unwrap_or_else(|| env::panic_str("no such task"));
        require!(t.curated, "only curated tasks are pinned");
        t.tests_hash = tests_hash.clone();
        emit("task_tests_set", json!({ "task_ref": task_ref, "tests_hash": tests_hash }));
    }

    /// Files a curated task under a category.
    pub fn set_task_category(&mut self, task_ref: String, category: String) {
        self.assert_owner();
        require!(self.tasks.get(&task_ref).map_or(false, |t| t.curated), "no such curated task");
        require!(self.categories.contains_key(&category), "no such category");
        self.task_category.insert(task_ref, category);
    }

    /// Retires a task (or brings it back), e.g. after its tests leaked.
    pub fn set_task_retired(&mut self, task_ref: String, retired: bool) {
        self.assert_owner();
        let t = self.tasks.get_mut(&task_ref).unwrap_or_else(|| env::panic_str("no such task"));
        t.retired = retired;
        if !retired {
            t.saturated = 0;
        }
    }

    // ----- views -----

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            verifiers: self.verifiers.clone(),
            threshold: self.threshold,
            arbiters: self.arbiters.clone(),
            arbiter_threshold: self.arbiter_threshold,
            inference_signers: self.inference_signers.clone(),
            params: self.params.clone(),
            next_round_id: self.next_round_id,
            first_lmsr_round: self.first_lmsr_round,
            next_job_id: self.next_job_id,
            next_brief_id: self.next_brief_id,
            fee_bps: self.params.fee_bps,
            min_pool: self.params.min_pool,
            min_builder_stake: self.params.min_builder_stake,
            min_bet: self.params.min_bet,
            k_factor: self.params.k_field + self.params.k_task,
        }
    }

    pub fn get_rating(&self, agent: AccountId, skill: String) -> RatingView {
        let r = self.rating_of(&agent, &skill);
        rating_view(agent, skill, &r)
    }

    /// True when the agent has at least `min_rating` (whole points) and `min_rounds` rated
    /// rounds and jobs in the skill, and, if asked, `min_attested` attested ones.
    pub fn is_qualified(&self, agent: AccountId, skill: String, min_rating: u32, min_rounds: Option<u32>, min_attested: Option<u32>) -> bool {
        let r = self.rating_of(&agent, &skill);
        let played = r.rounds + r.jobs_done + r.jobs_failed;
        played >= min_rounds.unwrap_or(PROVISIONAL_ROUNDS).max(1) && r.rating >= min_rating as i64 * 100 && r.attested >= min_attested.unwrap_or(0)
    }

    pub fn get_leaderboard(&self, skill: String, limit: Option<u32>) -> Vec<RatingView> {
        let mut rows: Vec<RatingView> = self
            .ratings
            .iter()
            .filter(|(k, _)| k.skill == skill)
            .map(|(k, r)| rating_view(k.agent.clone(), k.skill.clone(), r))
            .collect();
        rows.sort_by(|a, b| b.rating.cmp(&a.rating).then(a.agent.cmp(&b.agent)));
        rows.truncate(limit.unwrap_or(50).min(200) as usize);
        rows
    }

    /// Scouts by forecasting skill (`skill_ppm`), then PnL.
    pub fn get_scouts(&self, limit: Option<u32>) -> Vec<ScoutView> {
        let mut rows: Vec<ScoutView> = self.scouts.iter().map(|(a, s)| scout_view(a, s)).collect();
        rows.sort_by(|a, b| {
            let pa: i128 = a.pnl.parse().unwrap_or(0);
            let pb: i128 = b.pnl.parse().unwrap_or(0);
            b.skill_ppm.cmp(&a.skill_ppm).then(pb.cmp(&pa)).then(a.account.cmp(&b.account))
        });
        rows.truncate(limit.unwrap_or(50).min(200) as usize);
        rows
    }

    pub fn get_scout(&self, account: AccountId) -> ScoutView {
        let s = self.scouts.get(&account).cloned().unwrap_or_default();
        scout_view(&account, &s)
    }

    pub fn get_task(&self, task_ref: String) -> Option<TaskRecord> {
        self.tasks.get(&task_ref).cloned()
    }

    pub fn get_tasks(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<TaskView> {
        self.tasks
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(k, t)| TaskView { task_ref: k.clone(), category: self.task_category.get(k).cloned(), record: t.clone() })
            .collect()
    }

    pub fn get_categories(&self) -> Vec<CategoryView> {
        self.categories
            .iter()
            .map(|(id, c)| CategoryView {
                id: id.clone(),
                title: c.title.clone(),
                description: c.description.clone(),
                skill_tasks: self
                    .tasks
                    .iter()
                    .filter(|(k, t)| t.curated && !t.retired && self.task_category.get(*k) == Some(id))
                    .map(|(k, _)| k.clone())
                    .collect(),
            })
            .collect()
    }
}

pub(crate) fn rating_view(agent: AccountId, skill: String, r: &Rating) -> RatingView {
    RatingView {
        agent,
        skill,
        rating: r.rating,
        rounds: r.rounds,
        wins: r.wins,
        provisional: r.rounds + r.jobs_done + r.jobs_failed < PROVISIONAL_ROUNDS,
        last_round: r.last_round,
        attested: r.attested,
        jobs_done: r.jobs_done,
        jobs_failed: r.jobs_failed,
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
        skill_ppm: s.skill_ppm,
        scored_rounds: s.scored_rounds,
    }
}

impl Contract {
    pub(crate) fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    pub(crate) fn rating_of(&self, agent: &AccountId, skill: &str) -> Rating {
        let key = RatingKey { skill: skill.to_string(), agent: agent.clone() };
        self.ratings.get(&key).cloned().unwrap_or_default()
    }

    /// Task record for `task_ref`, created uncurated at 1500 on first use. Returns its rating
    /// and whether it is curated (rated). Panics if the task belongs to another skill, is
    /// retired, or is curated with other tests.
    pub(crate) fn use_task(&mut self, task_ref: &str, skill: &str, tests_hash: &str) -> (i64, bool) {
        require!(!task_ref.is_empty() && task_ref.len() <= 64, "bad task_ref");
        if !self.tasks.contains_key(task_ref) {
            self.tasks.insert(
                task_ref.to_string(),
                TaskRecord {
                    skill: skill.to_string(),
                    curated: false,
                    tests_hash: tests_hash.to_string(),
                    rating: INITIAL_RATING,
                    rounds: 0,
                    jobs: 0,
                    saturated: 0,
                    retired: false,
                },
            );
        }
        let t = self.tasks.get(task_ref).unwrap();
        require!(t.skill == skill, "task belongs to another skill");
        require!(!t.retired, "task is retired");
        // A family commits fresh tests every round; a fixed task pins its one set.
        if t.curated && !t.tests_hash.starts_with(FAMILY_PREFIX) {
            require!(t.tests_hash == tests_hash, "tests hash does not match the curated task");
        }
        (t.rating, t.curated)
    }

    /// Applies rating changes from a finished round or job and moves the task the other way.
    pub(crate) fn apply_ratings(&mut self, skill: &str, task_ref: &str, agents: &[AccountId], deltas: &[i64], task_delta: i64, round_id: u64) {
        for (a, d) in agents.iter().zip(deltas.iter()) {
            let key = RatingKey { skill: skill.to_string(), agent: a.clone() };
            let mut r = self.ratings.get(&key).cloned().unwrap_or_default();
            let old = r.rating;
            r.rating += d;
            if round_id > 0 {
                r.last_round = round_id;
            }
            emit("rating_updated", json!({ "agent": a, "skill": skill, "old_rating": old, "new_rating": r.rating, "delta": d, "round_id": round_id }));
            self.ratings.insert(key, r);
        }
        if let Some(t) = self.tasks.get_mut(task_ref) {
            t.rating += task_delta;
        }
    }
}

#[cfg(test)]
mod tests;
