//! State layout before V6 (parimutuel market, single winner). Rounds created before the
//! upgrade stay in their old storage and keep working: their views are converted and their
//! positions can still be claimed under the old rules.

use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{near, AccountId, PublicKey};

use crate::{Identity, League, PayoutMode, RatingKey};

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RoundStatusV1 {
    Open,
    Locked,
    Settled,
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct EntryV1 {
    pub agent: AccountId,
    pub builder: AccountId,
    pub league: League,
    pub config_hash: String,
    pub pool: u128,
    pub p_ppm: u64,
    pub market_ppm: u64,
    pub answer_hash: Option<String>,
    pub answered_at_ms: Option<u64>,
    pub score: Option<u32>,
    pub rating_before: i64,
    pub rating_delta: i64,
}

#[near(serializers = [borsh])]
pub struct RoundV1 {
    pub id: u64,
    pub manager: AccountId,
    pub skill: String,
    pub task_ref: String,
    pub tests_hash: String,
    pub bet_deadline_ms: u64,
    pub max_agents: u8,
    pub bounty: u128,
    pub status: RoundStatusV1,
    pub entries: Vec<EntryV1>,
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
pub struct PositionV1 {
    pub amounts: Vec<u128>,
    pub claimed: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct RatingV1 {
    pub rating: i64,
    pub rounds: u32,
    pub wins: u32,
    pub last_round: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct ScoutV1 {
    pub staked: u128,
    pub returned: u128,
    pub bets: u32,
    pub wins: u32,
}

/// The deployed V5 state; read once by `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV5 {
    pub owner: AccountId,
    pub verifiers: Vec<PublicKey>,
    pub threshold: u8,
    pub fee_bps: u16,
    pub min_pool: u128,
    pub min_builder_stake: u128,
    pub min_bet: u128,
    pub k_factor: u32,
    pub next_round_id: u64,
    pub rounds: LookupMap<u64, RoundV1>,
    pub positions: LookupMap<(u64, AccountId), PositionV1>,
    pub ratings: IterableMap<RatingKey, RatingV1>,
    pub scouts: IterableMap<AccountId, ScoutV1>,
    pub identities: IterableMap<AccountId, Identity>,
    pub next_identity: u32,
    pub face_pages: Vector<Vec<u64>>,
    pub agent_by_number: LookupMap<u32, AccountId>,
}

/// Payout of a legacy position: its share of `net` on the single winner, or a full refund.
pub fn legacy_claim_amount(round: &RoundV1, pos: &PositionV1) -> u128 {
    match round.payout_mode {
        PayoutMode::Refund => pos.amounts.iter().sum(),
        PayoutMode::Winners => {
            let w = round.winner.expect("winner") as usize;
            crate::math::payout(pos.amounts.get(w).copied().unwrap_or(0), round.entries[w].pool, round.net)
        }
        PayoutMode::Pending => near_sdk::env::panic_str("round not finished"),
    }
}
