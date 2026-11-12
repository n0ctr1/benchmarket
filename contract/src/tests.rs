use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 10u128.pow(24);
const SKILL: &str = "code.js";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn near_pk(k: &SigningKey) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, k.verifying_key().to_bytes().to_vec()).unwrap()
}

fn ctx(caller: &str, deposit: u128, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("league.testnet"))
        .predecessor_account_id(acc(caller))
        .signer_account_id(acc(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ms * 1_000_000)
        .account_balance(NearToken::from_near(1_000));
    testing_env!(b.build());
}

fn sign(k: &SigningKey, round_id: u64, total: u32, scores: &[(AccountId, u32)]) -> Base64VecU8 {
    let pairs: Vec<(&str, u32)> = scores.iter().map(|(a, s)| (a.as_str(), *s)).collect();
    let msg = math::settlement_message(round_id, total, &pairs);
    let digest = near_sdk::env::sha256_array(msg.as_bytes());
    Base64VecU8(k.sign(&digest).to_bytes().to_vec())
}

fn setup(threshold: u8) -> (Contract, Vec<SigningKey>) {
    ctx("owner.testnet", 0, 1_000);
    let keys = vec![key(1), key(2), key(3)];
    let c = Contract::new(acc("owner.testnet"), keys.iter().map(near_pk).collect(), threshold);
    (c, keys)
}

/// Creates a round with agents a, b, c registered by their builders (0.5 NEAR stake each).
fn round_with_agents(c: &mut Contract) -> u64 {
    ctx("manager.testnet", 10 * NEAR, 1_000);
    let id = c.create_round(SKILL.into(), "parseDuration".into(), "sha256:tests".into(), 5_000, 5);
    for (agent, builder) in [("a.testnet", "ba.testnet"), ("b.testnet", "bb.testnet"), ("c.testnet", "bc.testnet")] {
        ctx(builder, NEAR / 2, 1_100);
        c.register_agent(id, acc(agent), League::Open, format!("cfg-{agent}"));
    }
    id
}

fn answer_all(c: &mut Contract, id: u64) {
    for (i, a) in ["a.testnet", "b.testnet", "c.testnet"].iter().enumerate() {
        ctx(a, 0, 6_000 + i as u64);
        c.submit_answer(id, format!("hash-{a}"));
    }
}

#[test]
fn full_round_pays_backers_and_updates_ratings() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);

    // Seeder adds 3 NEAR equally, a scout backs b with 4.5 NEAR.
    ctx("seeder.testnet", 3 * NEAR, 1_200);
    c.seed(id);
    ctx("scout.testnet", 9 * NEAR / 2, 1_300);
    c.place_bet(id, acc("b.testnet"));

    // Pools: a 1.5, b 6, c 1.5 -> total 9 NEAR (below min_pool 10 NEAR, w = 0.9).
    ctx("anyone.testnet", 0, 5_000);
    c.lock_round(id);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.status, RoundStatus::Locked);
    assert_eq!(r.total_pool.0, 9 * NEAR);
    let p: Vec<u64> = r.entries.iter().map(|e| e.p_ppm).collect();
    // 0.9 * market + 0.1 * prior(1/3 each).
    assert_eq!(p, vec![183_332, 633_332, 183_332]);

    answer_all(&mut c, id);

    // Underdog a wins with 18/20.
    let scores = vec![(acc("a.testnet"), 18), (acc("b.testnet"), 15), (acc("c.testnet"), 0)];
    let sig = sign(&keys[0], id, 20, &scores);
    ctx("verifier.testnet", 0, 7_000);
    c.settle(id, 20, scores, vec![sig]);

    let r = c.get_round(id).unwrap();
    assert_eq!(r.status, RoundStatus::Settled);
    assert_eq!(r.winner, Some(acc("a.testnet")));
    assert_eq!(r.payout_mode, PayoutMode::Winners);
    assert_eq!(r.fee.0, 9 * NEAR * 2 / 100);

    // Ratings: zero-sum, winner gains 32 * (1 - p).
    let ra = c.get_rating(acc("a.testnet"), SKILL.into());
    let rb = c.get_rating(acc("b.testnet"), SKILL.into());
    let rc = c.get_rating(acc("c.testnet"), SKILL.into());
    assert_eq!(rb.rating, 150_000 - 2_026);
    assert_eq!(rc.rating, 150_000 - 586);
    assert_eq!(ra.rating, 150_000 + 2_026 + 586);
    assert_eq!(ra.wins, 1);
    assert!(ra.provisional);

    // Backers of a: builder ba (0.5) and seeder (1.0 incl. remainder) share net 8.82 NEAR on a 1.5 NEAR pool.
    let net = 9 * NEAR - 9 * NEAR * 2 / 100;
    ctx("ba.testnet", 0, 8_000);
    let got = c.claim(id).0;
    assert_eq!(got, math::payout(NEAR / 2, 3 * NEAR / 2, net));
    ctx("seeder.testnet", 0, 8_000);
    let got_seed = c.claim(id).0;
    assert_eq!(got_seed, math::payout(NEAR, 3 * NEAR / 2, net));
    // The scout lost.
    ctx("scout.testnet", 0, 8_000);
    assert_eq!(c.claim(id).0, 0);
    assert!(c.get_scout(acc("scout.testnet")).pnl.starts_with('-'));

    // Leaderboard and qualification.
    let lb = c.get_leaderboard(SKILL.into(), None);
    assert_eq!(lb[0].agent, acc("a.testnet"));
    assert!(c.is_qualified(acc("a.testnet"), SKILL.into(), 1500, Some(1)));
    assert!(!c.is_qualified(acc("a.testnet"), SKILL.into(), 1500, None));

    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"payout_claimed\"")));
}

#[test]
#[should_panic(expected = "already claimed")]
fn double_claim_fails() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    ctx("manager.testnet", 0, 1_500);
    c.lock_round(id);
    answer_all(&mut c, id);
    let scores = vec![(acc("a.testnet"), 20), (acc("b.testnet"), 1), (acc("c.testnet"), 1)];
    let sig = sign(&keys[0], id, 20, &scores);
    c.settle(id, 20, scores, vec![sig]);
    ctx("ba.testnet", 0, 8_000);
    c.claim(id);
    c.claim(id);
}

#[test]
#[should_panic(expected = "not enough valid verifier signatures")]
fn settle_rejects_wrong_scores() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    ctx("manager.testnet", 0, 1_500);
    c.lock_round(id);
    answer_all(&mut c, id);
    let signed = vec![(acc("a.testnet"), 5), (acc("b.testnet"), 20), (acc("c.testnet"), 1)];
    let sig = sign(&keys[0], id, 20, &signed);
    // Submit different scores than the ones signed.
    let claimed = vec![(acc("a.testnet"), 20), (acc("b.testnet"), 5), (acc("c.testnet"), 1)];
    c.settle(id, 20, claimed, vec![sig]);
}

#[test]
#[should_panic(expected = "not enough valid verifier signatures")]
fn threshold_counts_distinct_keys() {
    let (mut c, keys) = setup(2);
    let id = round_with_agents(&mut c);
    ctx("manager.testnet", 0, 1_500);
    c.lock_round(id);
    answer_all(&mut c, id);
    let scores = vec![(acc("a.testnet"), 20), (acc("b.testnet"), 1), (acc("c.testnet"), 1)];
    let sig = sign(&keys[0], id, 20, &scores);
    // The same key twice is still one signature.
    c.settle(id, 20, scores, vec![sig.clone(), sig]);
}

#[test]
fn two_of_three_settles() {
    let (mut c, keys) = setup(2);
    let id = round_with_agents(&mut c);
    ctx("manager.testnet", 0, 1_500);
    c.lock_round(id);
    answer_all(&mut c, id);
    let scores = vec![(acc("a.testnet"), 20), (acc("b.testnet"), 1), (acc("c.testnet"), 1)];
    let sigs = vec![sign(&keys[2], id, 20, &scores), sign(&keys[0], id, 20, &scores)];
    c.settle(id, 20, scores, sigs);
    assert_eq!(c.get_round(id).unwrap().status, RoundStatus::Settled);
}

#[test]
fn no_winner_refunds_everything() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    ctx("manager.testnet", 0, 1_500);
    c.lock_round(id);
    // Nobody answers: every score must be 0.
    let scores = vec![(acc("a.testnet"), 0), (acc("b.testnet"), 0), (acc("c.testnet"), 0)];
    let sig = sign(&keys[0], id, 20, &scores);
    c.settle(id, 20, scores, vec![sig]);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.winner, None);
    assert_eq!(r.payout_mode, PayoutMode::Refund);
    ctx("bb.testnet", 0, 8_000);
    assert_eq!(c.claim(id).0, NEAR / 2);
    // Ratings untouched.
    assert_eq!(c.get_rating(acc("a.testnet"), SKILL.into()).rounds, 0);
}

#[test]
#[should_panic(expected = "agent without an answer must score 0")]
fn missing_answer_cannot_score() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    ctx("manager.testnet", 0, 1_500);
    c.lock_round(id);
    let scores = vec![(acc("a.testnet"), 3), (acc("b.testnet"), 0), (acc("c.testnet"), 0)];
    let sig = sign(&keys[0], id, 20, &scores);
    c.settle(id, 20, scores, vec![sig]);
}

#[test]
#[should_panic(expected = "builder stake below minimum")]
fn builder_must_stake() {
    let (mut c, _) = setup(1);
    ctx("manager.testnet", 0, 1_000);
    let id = c.create_round(SKILL.into(), "t".into(), "h".into(), 5_000, 5);
    ctx("builder.testnet", NEAR / 10, 1_100);
    c.register_agent(id, acc("x.testnet"), League::Open, "cfg".into());
}

#[test]
fn manager_registers_market_agents_without_stake() {
    let (mut c, _) = setup(1);
    ctx("manager.testnet", 0, 1_000);
    let id = c.create_round(SKILL.into(), "t".into(), "h".into(), 5_000, 5);
    c.register_agent(id, acc("m1.testnet"), League::Market, "market:handle1".into());
    c.register_agent(id, acc("m2.testnet"), League::Market, "market:handle2".into());
    let r = c.get_round(id).unwrap();
    assert_eq!(r.entries.len(), 2);
    assert_eq!(r.total_pool.0, 0);
    assert!(c.get_position(id, acc("manager.testnet")).is_empty());
}

#[test]
#[should_panic(expected = "betting closed")]
fn no_bets_after_deadline() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    ctx("scout.testnet", NEAR, 5_000);
    c.place_bet(id, acc("a.testnet"));
}

#[test]
#[should_panic(expected = "only the manager can lock before the deadline")]
fn early_lock_only_by_manager() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    ctx("anyone.testnet", 0, 2_000);
    c.lock_round(id);
}

#[test]
fn cancel_refunds() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    ctx("manager.testnet", 0, 2_000);
    c.cancel_round(id);
    ctx("bc.testnet", 0, 2_100);
    assert_eq!(c.claim(id).0, NEAR / 2);
}

#[test]
fn ratings_carry_over_and_shape_the_prior() {
    let (mut c, keys) = setup(1);
    // Round 1: a wins with an empty market (pure prior, equal ratings).
    let id = round_with_agents(&mut c);
    ctx("manager.testnet", 0, 1_500);
    c.lock_round(id);
    answer_all(&mut c, id);
    let scores = vec![(acc("a.testnet"), 20), (acc("b.testnet"), 1), (acc("c.testnet"), 1)];
    let sig = sign(&keys[0], id, 20, &scores);
    c.settle(id, 20, scores, vec![sig]);

    // Round 2: with only builder stakes (1.5 NEAR, w = 0.15) the prior now favors a.
    let id2 = round_with_agents(&mut c);
    ctx("manager.testnet", 0, 1_500);
    c.lock_round(id2);
    let r = c.get_round(id2).unwrap();
    assert!(r.entries[0].p_ppm > r.entries[1].p_ppm);
    assert_eq!(r.entries[0].rating_before, c.get_rating(acc("a.testnet"), SKILL.into()).rating);
}

/// Signature produced by the TypeScript verifier (packages/shared signMessage) for seed [7; 32].
/// Guards against the two sides drifting apart on message format or hashing.
#[test]
fn accepts_signature_from_typescript_verifier() {
    let pk: PublicKey = "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB".parse().unwrap();
    let sig = near_sdk::base64::Engine::decode(
        &near_sdk::base64::engine::general_purpose::STANDARD,
        "RMZ3mnm56nWl5CyP2Qw1mZAyboqzNaGhbzqtXVVVF+AbehS+AxFveSr8+ad37L5TSOUt+z7AO+y81WD0utPbCw==",
    )
    .unwrap();
    ctx("owner.testnet", 0, 1_000);
    let msg = math::settlement_message(3, 20, &[("a.testnet", 20), ("b.testnet", 7)]);
    let digest = near_sdk::env::sha256_array(msg.as_bytes());
    let sig: [u8; 64] = sig.try_into().unwrap();
    assert!(near_sdk::env::ed25519_verify(&sig, &digest, &ed25519_bytes(&pk)));
}
