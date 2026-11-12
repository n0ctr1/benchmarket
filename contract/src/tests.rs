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

/// A seed for `name` whose face is accepted right now (tries suffixes until one fits).
fn seed_for(c: &Contract, name: &str) -> String {
    (0..500)
        .map(|n| format!("I am {name}, a careful agent, variant {n}."))
        .find(|s| c.check_face(s.clone()).ok)
        .expect("no acceptable seed")
}

/// Issues a passport as the agent itself.
fn issue(c: &mut Contract, agent: &str) -> u32 {
    let seed = seed_for(c, agent);
    ctx(agent, IDENTITY_DEPOSIT, 900);
    c.register_identity(acc(agent), seed, format!("I am {agent}"), "cfg".into(), "proof".into())
}

/// Creates a round with agents a, b, c registered by their builders (0.5 NEAR stake each).
fn round_with_agents(c: &mut Contract) -> u64 {
    for a in ["a.testnet", "b.testnet", "c.testnet"] {
        if c.get_identity(acc(a)).is_none() {
            issue(c, a);
        }
    }
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

    // Ratings: zero-sum, each agent moves by 32 * (share of points - p).
    // Shares: a 18/33, b 15/33, c 0. b solved most tests and loses far less than c.
    let ra = c.get_rating(acc("a.testnet"), SKILL.into());
    let rb = c.get_rating(acc("b.testnet"), SKILL.into());
    let rc = c.get_rating(acc("c.testnet"), SKILL.into());
    assert_eq!(rb.rating, 150_000 - 572);
    assert_eq!(rc.rating, 150_000 - 586);
    assert_eq!(ra.rating, 150_000 + 572 + 586);
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
    issue(&mut c, "x.testnet");
    ctx("manager.testnet", 0, 1_000);
    let id = c.create_round(SKILL.into(), "t".into(), "h".into(), 5_000, 5);
    ctx("builder.testnet", NEAR / 10, 1_100);
    c.register_agent(id, acc("x.testnet"), League::Open, "cfg".into());
}

#[test]
fn manager_registers_market_agents_without_stake() {
    let (mut c, _) = setup(1);
    // Market agents cannot sign: the owner issues their passports.
    for m in ["m1.testnet", "m2.testnet"] {
        let seed = seed_for(&c, m);
        ctx("owner.testnet", IDENTITY_DEPOSIT, 900);
        c.register_identity(acc(m), seed, "market agent".into(), "market:handle".into(), "".into());
    }
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

// ----- identities -----

#[test]
fn identities_are_numbered_and_derived_on_chain() {
    let (mut c, _) = setup(1);
    assert_eq!(issue(&mut c, "a.testnet"), 1);
    assert_eq!(issue(&mut c, "b.testnet"), 2);
    let all = c.get_identities(None, None);
    assert_eq!(all.len(), 2);
    let a = c.get_identity(acc("a.testnet")).unwrap();
    let f = identity::derive(&a.seed);
    assert_eq!((a.cells.clone(), a.palette), (f.cells.clone(), f.palette));
    assert_eq!(a.face_code, identity::face_code(&f));
    assert!(identity::cells_apart(&all[0].cells, &all[1].cells) >= identity::MIN_CELLS);
    assert!(get_logs().iter().any(|l| l.contains("identity_issued")));
}

#[test]
#[should_panic(expected = "face too close to a.testnet: 0 cells apart")]
fn same_seed_is_rejected() {
    let (mut c, _) = setup(1);
    let seed = seed_for(&c, "a.testnet");
    ctx("a.testnet", IDENTITY_DEPOSIT, 900);
    c.register_identity(acc("a.testnet"), seed.clone(), "a".into(), "cfg".into(), "".into());
    ctx("b.testnet", IDENTITY_DEPOSIT, 900);
    c.register_identity(acc("b.testnet"), seed, "b".into(), "cfg".into(), "".into());
}

#[test]
fn near_identical_face_is_rejected() {
    let (mut c, _) = setup(1);
    issue(&mut c, "a.testnet");
    let taken = c.get_identity(acc("a.testnet")).unwrap().cells;
    // The same seed again is 0 cells away and rejected; a face 2 cells off is under the limit.
    let check = c.check_face(c.get_identity(acc("a.testnet")).unwrap().seed);
    assert!(!check.ok);
    assert_eq!(check.distance, Some(0));
    let mut close = taken.clone();
    close[0] = (close[0] + 1) % 4;
    close[1] = (close[1] + 1) % 4;
    assert_eq!(identity::cells_apart(&close, &taken), 2);
    assert!(identity::cells_apart(&close, &taken) < identity::MIN_CELLS);
}

#[test]
fn check_face_validates_seed_and_fill() {
    let (c, _) = setup(1);
    assert!(!c.check_face("short".into()).ok);
    let sparse = (0..200_000)
        .map(|n| format!("Sparse face search, attempt number {n}."))
        .find(|s| identity::fill(&identity::derive(s).cells) < identity::MIN_FILL)
        .unwrap();
    let r = c.check_face(sparse);
    assert!(!r.ok && r.reason.unwrap().contains("cells lit"));
}

#[test]
#[should_panic(expected = "identity already issued")]
fn identity_is_issued_once() {
    let (mut c, _) = setup(1);
    issue(&mut c, "a.testnet");
    issue(&mut c, "a.testnet");
}

#[test]
#[should_panic(expected = "only the agent or the owner")]
fn others_cannot_issue_an_identity() {
    let (mut c, _) = setup(1);
    let seed = seed_for(&c, "a.testnet");
    ctx("mallory.testnet", IDENTITY_DEPOSIT, 900);
    c.register_identity(acc("a.testnet"), seed, "hi".into(), "cfg".into(), "".into());
}

#[test]
#[should_panic(expected = "agent has no identity")]
fn registration_needs_an_identity() {
    let (mut c, _) = setup(1);
    ctx("manager.testnet", 0, 1_000);
    let id = c.create_round(SKILL.into(), "t".into(), "h".into(), 5_000, 5);
    ctx("builder.testnet", NEAR, 1_100);
    c.register_agent(id, acc("nobody.testnet"), League::Open, "cfg".into());
}

#[test]
fn migrate_builds_the_face_index() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    // The deployed V4 state: the same rounds and passports, no face index yet.
    c.rounds.flush();
    c.positions.flush();
    c.identities.flush();
    let v4 = ContractV4 {
        owner: c.owner.clone(),
        verifiers: c.verifiers.clone(),
        threshold: c.threshold,
        fee_bps: c.fee_bps,
        min_pool: c.min_pool,
        min_builder_stake: c.min_builder_stake,
        min_bet: c.min_bet,
        k_factor: c.k_factor,
        next_round_id: c.next_round_id,
        rounds: LookupMap::new(StorageKey::Rounds),
        positions: LookupMap::new(StorageKey::Positions),
        ratings: IterableMap::new(StorageKey::Ratings),
        scouts: IterableMap::new(StorageKey::Scouts),
        identities: std::mem::replace(&mut c.identities, IterableMap::new(StorageKey::IdentitiesV4)),
        next_identity: c.next_identity,
    };
    env::state_write(&v4);
    ctx("league.testnet", 0, 2_000);
    let mut m = Contract::migrate();
    assert_eq!(m.get_round(id).unwrap().entries.len(), 3);
    assert_eq!(m.get_identities(None, None).len(), 3);
    assert_eq!(m.face_count(), 3);
    // The index knows the old faces: reusing a seed is rejected and names its owner.
    let a = m.get_identity(acc("a.testnet")).unwrap();
    let check = m.check_face(a.seed);
    assert!(!check.ok);
    assert_eq!(check.nearest, Some(acc("a.testnet")));
    assert_eq!(issue(&mut m, "d.testnet"), 4);
}

/// Fills the face index directly with `n` random valid faces, as if `n` passports existed.
fn fill_index(c: &mut Contract, n: u32) {
    // Setup only: lift the gas limit so filling is not counted against the measured calls.
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("league.testnet")).prepaid_gas(near_sdk::Gas::from_tgas(10_000_000));
    testing_env!(b.build());
    let mut number = c.next_identity;
    let mut i = 0u64;
    while number < c.next_identity + n {
        i += 1;
        if i % 4_000 == 0 {
            // The mock caps a context at 300 Tgas; start a fresh one now and then.
            c.face_pages.flush();
            testing_env!(b.build());
        }
        let cells = identity::derive(&format!("filler agent {i} with a long enough seed")).cells;
        if identity::validate_fill(&cells).is_ok() {
            c.index_face(identity::pack(&cells), number, acc(&format!("f{number}.testnet")));
            number += 1;
        }
    }
    c.next_identity = number;
    c.face_pages.flush();
}

#[test]
fn face_check_gas_scales_with_the_index() {
    // Host-side gas (storage reads and writes, hashing) of check_face and register_identity as
    // the registry grows. Wasm execution is not metered in unit tests; see RULES.md for the
    // estimate of that part.
    for n in [1_000u32, 10_000, 50_000] {
        // Each size in its own thread: the mocked storage is per thread.
        std::thread::spawn(move || measure(n)).join().unwrap();
    }
}

fn measure(n: u32) {
    let (mut c, _) = setup(1);
    fill_index(&mut c, n);
    let seed = seed_for(&c, "probe.testnet");
    c.identities.flush();
    env::state_write(&c);
    std::mem::forget(c);
    // A fresh contract object, as on chain: nothing cached, every page is read from storage.
    ctx("probe.testnet", IDENTITY_DEPOSIT, 900);
    let fresh: Contract = env::state_read().unwrap();
    let before = env::used_gas().as_gas();
    let check = fresh.check_face(seed.clone());
    let view = env::used_gas().as_gas() - before;
    assert!(check.ok);
    std::mem::forget(fresh);
    ctx("probe.testnet", IDENTITY_DEPOSIT, 900);
    let mut fresh: Contract = env::state_read().unwrap();
    let before = env::used_gas().as_gas();
    fresh.register_identity(acc("probe.testnet"), seed, "probe".into(), "cfg".into(), "".into());
    fresh.face_pages.flush();
    fresh.identities.flush();
    fresh.agent_by_number.flush();
    let call = env::used_gas().as_gas() - before;
    std::mem::forget(fresh);
    println!("faces {n:>6}: check_face {:.2} Tgas, register_identity {:.2} Tgas (host side)", view as f64 / 1e12, call as f64 / 1e12);
}
