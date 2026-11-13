use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::Base64VecU8;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

const NEAR: u128 = 10u128.pow(24);
const SKILL: &str = "code.js";
const TASK: &str = "parse-duration";
const LOCK: u64 = 5_000;
/// Answers land well inside the window that starts at lock.
const ANSWER: u64 = 6_000;

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

fn sign_with(k: &SigningKey, domain: &str, id: u64, total: u32, scores: &[(AccountId, u32)]) -> Base64VecU8 {
    let msg = math::signed_message(domain, id, total, &settle::pairs(scores));
    let digest = near_sdk::env::sha256_array(msg.as_bytes());
    Base64VecU8(k.sign(&digest).to_bytes().to_vec())
}

fn sign(k: &SigningKey, round_id: u64, total: u32, scores: &[(AccountId, u32)]) -> Base64VecU8 {
    sign_with(k, settle::ROUND_DOMAIN, round_id, total, scores)
}

/// Three staked verifier keys, no dispute window (scores settle at once) unless a test sets one.
fn setup(threshold: u8) -> (Contract, Vec<SigningKey>) {
    ctx("owner.testnet", 0, 1_000);
    let keys = vec![key(1), key(2), key(3)];
    let mut c = Contract::new(acc("owner.testnet"), keys.iter().map(near_pk).collect(), threshold);
    let mut p = c.get_config().params;
    p.dispute_window_ms = 0;
    p.unstake_delay_ms = p.resolve_timeout_ms;
    c.set_params(p);
    for k in &keys {
        ctx("staker.testnet", NEAR, 1_000);
        c.stake_verifier(near_pk(k));
    }
    curate(&mut c);
    (c, keys)
}

/// The rated pool used by the tests.
fn curate(c: &mut Contract) {
    ctx("owner.testnet", 0, 1_000);
    for t in [TASK, "t1", "t2", "t3"] {
        c.add_task(t.into(), SKILL.into(), "sha256:tests".into());
    }
    c.add_task("job-task".into(), SKILL.into(), "sha256:jobtests".into());
}

fn set_window(c: &mut Contract, ms: u64) {
    ctx("owner.testnet", 0, 1_000);
    let mut p = c.get_config().params;
    p.dispute_window_ms = ms;
    p.unstake_delay_ms = ms + p.resolve_timeout_ms;
    c.set_params(p);
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

const AGENTS: [&str; 3] = ["a.testnet", "b.testnet", "c.testnet"];

/// A round on `task` with agents a, b, c, each entering itself with a 0.5 NEAR bond.
fn round_on(c: &mut Contract, task: &str, attested: bool) -> u64 {
    round_rated(c, task, attested, None)
}

fn round_rated(c: &mut Contract, task: &str, attested: bool, rated: Option<bool>) -> u64 {
    for a in AGENTS {
        if c.get_identity(acc(a)).is_none() {
            issue(c, a);
        }
    }
    ctx("manager.testnet", 3 * NEAR, 1_000);
    let id = c.create_round(SKILL.into(), task.into(), "sha256:tests".into(), LOCK, 5, Some(attested), rated);
    for (agent, builder) in [("a.testnet", "a.testnet"), ("b.testnet", "b.testnet"), ("c.testnet", "c.testnet")] {
        ctx(builder, NEAR / 2, 1_100);
        c.register_agent(id, acc(agent), League::Open, format!("cfg-{agent}"));
    }
    id
}

fn round_with_agents(c: &mut Contract) -> u64 {
    round_on(c, TASK, false)
}

fn open(c: &mut Contract, id: u64, subsidy: u128) {
    ctx("manager.testnet", subsidy, 1_150);
    c.open_market(id);
}

fn lock(c: &mut Contract, id: u64) {
    ctx("manager.testnet", 0, LOCK);
    c.lock_round(id);
}

fn answer_all(c: &mut Contract, id: u64) {
    for (i, a) in AGENTS.iter().enumerate() {
        ctx(a, 0, ANSWER + i as u64);
        c.submit_answer(id, format!("hash-{a}"), None);
    }
}

fn scores(v: [u32; 3]) -> Vec<(AccountId, u32)> {
    AGENTS.iter().zip(v).map(|(a, s)| (acc(a), s)).collect()
}

fn settle_now(c: &mut Contract, keys: &[SigningKey], id: u64, total: u32, v: [u32; 3]) {
    let s = scores(v);
    let sig = sign(&keys[0], id, total, &s);
    ctx("verifier.testnet", 0, 7_000);
    c.settle(id, total, s, vec![sig]);
}

fn claim(c: &mut Contract, who: &str, id: u64) -> u128 {
    ctx(who, 0, 9_000_000);
    c.claim(id).0
}

fn rating(c: &Contract, a: &str) -> i64 {
    c.get_rating(acc(a), SKILL.into()).rating
}

// ----- rounds and the LMSR market -----

#[test]
fn full_round_pays_shares_and_rates_against_field_and_task() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    open(&mut c, id, 3 * NEAR);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.status, RoundStatus::Trading);
    assert_eq!(r.entries.iter().map(|e| e.odds_ppm).collect::<Vec<_>>(), vec![333_333; 3]);

    // A scout backs b, another backs a; prices move with every purchase.
    ctx("scout.testnet", 4 * NEAR, 1_300);
    let got_b = c.buy(id, acc("b.testnet"), None).0;
    ctx("fan.testnet", NEAR, 1_400);
    let got_a = c.buy(id, acc("a.testnet"), None).0;
    assert!(got_b > 4 * NEAR * 98 / 100 && got_a > NEAR * 98 / 100);
    let r = c.get_round(id).unwrap();
    assert!(r.entries[1].odds_ppm > r.entries[0].odds_ppm && r.entries[0].odds_ppm > r.entries[2].odds_ppm);
    assert_eq!(r.total_pool.0, 5 * NEAR * 98 / 100);
    assert_eq!(r.bettors, 2);

    lock(&mut c, id);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.status, RoundStatus::Locked);
    // Volume 4.9 NEAR of min_pool 10: p = 0.49 * price + 0.51 * prior (1/3 each).
    for e in &r.entries {
        let want = (490_000 * e.market_ppm as u128 + 510_000 * 333_333) / 1_000_000;
        assert!((e.p_ppm as i128 - want as i128).abs() <= 1, "{} vs {want}", e.p_ppm);
    }

    answer_all(&mut c, id);
    // The underdog a wins 18/20.
    settle_now(&mut c, &keys, id, 20, [18, 15, 0]);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.status, RoundStatus::Settled);
    assert_eq!(r.winners, vec![acc("a.testnet")]);
    assert_eq!(r.payout_mode, PayoutMode::Winners);

    // Field part is zero-sum among agents; task part is zero-sum with the task.
    let field: i64 = r.entries.iter().map(|e| e.field_delta).sum();
    let task: i64 = r.entries.iter().map(|e| e.task_delta).sum();
    assert_eq!(field, 0);
    assert_eq!(task + r.task_delta, 0);
    // Against a fresh task (1500) every agent was expected to pass half: a and b beat that, c did not.
    assert!(r.entries[0].task_delta > 0 && r.entries[1].task_delta > 0 && r.entries[2].task_delta < 0);
    assert_eq!(c.get_task(TASK.into()).unwrap().rating, 150_000 + r.task_delta);
    assert_eq!(rating(&c, "a.testnet"), 150_000 + r.entries[0].rating_delta);
    // b solved most tests: it ends above c despite losing.
    assert!(rating(&c, "b.testnet") > rating(&c, "c.testnet"));
    assert_eq!(c.get_rating(acc("a.testnet"), SKILL.into()).wins, 1);

    // The fan holds the only winning shares and is paid one yocto per share.
    assert_eq!(claim(&mut c, "fan.testnet", id), got_a);
    assert_eq!(claim(&mut c, "scout.testnet", id), 0);
    // Builders get their bonds back: every agent answered.
    assert_eq!(claim(&mut c, "c.testnet", id), NEAR / 2);
    // Scout skill: the fan gained, the scout lost, in units of liquidity.
    assert!(c.get_scout(acc("fan.testnet")).skill_ppm > 0);
    assert!(c.get_scout(acc("scout.testnet")).skill_ppm < 0);
    assert_eq!(c.get_scouts(None)[0].account, acc("fan.testnet"));
}

#[test]
fn maker_stays_solvent_for_any_winner() {
    // Each winner in its own thread: the mocked storage is per thread.
    for winner in 0..3 {
        std::thread::spawn(move || solvent_with(winner)).join().unwrap();
    }
}

fn solvent_with(winner: usize) {
    {
        let (mut c, keys) = setup(1);
        let id = round_with_agents(&mut c);
        open(&mut c, id, 2 * NEAR);
        for (i, (who, amt)) in [("s1.testnet", 7 * NEAR), ("s2.testnet", NEAR / 3), ("s3.testnet", 12 * NEAR), ("s1.testnet", NEAR)].iter().enumerate() {
            ctx(who, *amt, 1_300 + i as u64);
            c.buy(id, acc(AGENTS[i % 3]), None);
        }
        lock(&mut c, id);
        answer_all(&mut c, id);
        let mut v = [1, 1, 1];
        v[winner] = 9;
        settle_now(&mut c, &keys, id, 10, v);
        let r = c.get_round(id).unwrap();
        let owed = r.entries[winner].shares.0;
        // Winning shares never exceed subsidy + volume.
        assert!(owed <= r.subsidy.0 + r.total_pool.0, "winner {winner}");
        let paid: u128 = ["s1.testnet", "s2.testnet", "s3.testnet"].iter().map(|s| claim(&mut c, s, id)).sum();
        assert_eq!(paid, owed);
    }
}

#[test]
fn tied_winners_share_bounty_and_shares() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    open(&mut c, id, NEAR);
    ctx("s.testnet", NEAR, 1_300);
    let sa = c.buy(id, acc("a.testnet"), None).0;
    ctx("s.testnet", NEAR, 1_301);
    let sb = c.buy(id, acc("b.testnet"), None).0;
    lock(&mut c, id);
    answer_all(&mut c, id);
    settle_now(&mut c, &keys, id, 20, [20, 20, 5]);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.winners, vec![acc("a.testnet"), acc("b.testnet")]);
    // Speed no longer decides: both count a win.
    assert_eq!(c.get_rating(acc("a.testnet"), SKILL.into()).wins, 1);
    assert_eq!(c.get_rating(acc("b.testnet"), SKILL.into()).wins, 1);
    assert_eq!(claim(&mut c, "s.testnet", id), (sa + sb) / 2);
}

#[test]
fn no_winner_refunds_and_still_rates_against_the_task() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    open(&mut c, id, NEAR);
    ctx("s.testnet", 2 * NEAR, 1_300);
    c.buy(id, acc("a.testnet"), None);
    lock(&mut c, id);
    answer_all(&mut c, id);
    settle_now(&mut c, &keys, id, 20, [0, 0, 0]);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.payout_mode, PayoutMode::Refund);
    assert!(r.winners.is_empty());
    assert_eq!(claim(&mut c, "s.testnet", id), 2 * NEAR);
    // Nobody passed: agents drop, the task is now rated harder.
    assert!(rating(&c, "a.testnet") < 150_000);
    assert!(c.get_task(TASK.into()).unwrap().rating > 150_000);
}

#[test]
fn round_without_a_market_uses_the_prior() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    // No open_market: lock straight from registration.
    lock(&mut c, id);
    assert_eq!(c.get_round(id).unwrap().entries[0].p_ppm, 333_333);
    answer_all(&mut c, id);
    settle_now(&mut c, &keys, id, 20, [20, 1, 1]);
    // Round 2: the prior now favors a.
    let id2 = round_with_agents(&mut c);
    lock(&mut c, id2);
    let r = c.get_round(id2).unwrap();
    assert!(r.entries[0].p_ppm > r.entries[1].p_ppm);
    assert_eq!(r.entries[0].rating_before, rating(&c, "a.testnet"));
}

#[test]
fn saturated_task_is_retired() {
    let (mut c, keys) = setup(1);
    for _ in 0..SATURATION_LIMIT {
        let id = round_with_agents(&mut c);
        lock(&mut c, id);
        answer_all(&mut c, id);
        settle_now(&mut c, &keys, id, 10, [10, 10, 10]);
    }
    let t = c.get_task(TASK.into()).unwrap();
    assert!(t.retired);
    assert!(t.rating < 150_000, "a task everyone solves gets easier");
    assert!(get_logs().iter().any(|l| l.contains("task_retired")));
}

#[test]
#[should_panic(expected = "task is retired")]
fn retired_task_cannot_open_a_round() {
    let (mut c, _) = setup(1);
    round_with_agents(&mut c);
    ctx("owner.testnet", 0, 1_000);
    c.set_task_retired(TASK.into(), true);
    round_with_agents(&mut c);
}

#[test]
fn bond_is_forfeited_without_an_answer() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    for a in ["a.testnet", "b.testnet"] {
        ctx(a, 0, ANSWER);
        c.submit_answer(id, format!("hash-{a}"), None);
    }
    // c never answers; after the deadline the verifier may settle.
    let s = scores([5, 3, 0]);
    let sig = sign(&keys[0], id, 10, &s);
    ctx("verifier.testnet", 0, LOCK + 15 * 60_000 + 1);
    c.settle(id, 10, s, vec![sig]);
    assert_eq!(claim(&mut c, "a.testnet", id), NEAR / 2);
    assert_eq!(claim(&mut c, "c.testnet", id), 0);
}

#[test]
#[should_panic(expected = "wait for every answer")]
fn settle_waits_for_answers() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    ctx("a.testnet", 0, ANSWER);
    c.submit_answer(id, "hash-a".into(), None);
    settle_now(&mut c, &keys, id, 10, [5, 0, 0]);
}

#[test]
fn identical_answers_are_both_accepted() {
    // Two agents can write the same correct code; the hash alone is useless to a copier, who
    // would still have to hand the verifier code that matches it.
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    ctx("a.testnet", 0, ANSWER);
    c.submit_answer(id, "sha256:same".into(), None);
    ctx("b.testnet", 0, ANSWER);
    c.submit_answer(id, "sha256:same".into(), None);
    assert!(c.get_round(id).unwrap().entries.iter().take(2).all(|e| e.answer_hash.as_deref() == Some("sha256:same")));
}

#[test]
#[should_panic(expected = "only the agent or its passport issuer can enter it")]
fn stranger_cannot_enter_an_agent() {
    // A missed answer costs rating, so a round's manager cannot drag an agent in.
    let (mut c, _) = setup(1);
    issue(&mut c, "a.testnet");
    ctx("griefer.testnet", NEAR, 1_000);
    let id = c.create_round(SKILL.into(), TASK.into(), "sha256:tests".into(), LOCK, 5, None, None);
    ctx("griefer.testnet", 0, 1_100);
    c.register_agent(id, acc("a.testnet"), League::Open, "cfg".into());
}

#[test]
#[should_panic(expected = "entrants and their builders cannot trade this round")]
fn entrant_cannot_trade_its_round() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    open(&mut c, id, NEAR);
    ctx("a.testnet", NEAR / 10, 1_300);
    c.buy(id, acc("b.testnet"), None);
}

#[test]
fn nominee_that_skips_a_tryout_is_not_rated() {
    // Scouts nominate agents without asking them; one that does not show up loses nothing.
    let (mut c, keys) = setup(1);
    let id = scouted(&mut c);
    ctx("anyone.testnet", 0, 3_000_000 + 600_000);
    c.start_tryout(id, None);
    let round = c.get_brief(id).unwrap().tryout_round.unwrap();
    let start = 3_600_000 + 600_000;
    ctx("anyone.testnet", 0, start);
    c.lock_round(round);
    let entrants: Vec<AccountId> = c.get_round(round).unwrap().entries.iter().map(|e| e.agent.clone()).collect();
    assert!(entrants.contains(&acc("c.testnet")));
    for (i, a) in entrants.iter().enumerate().filter(|(_, a)| a.as_str() != "c.testnet") {
        ctx(a.as_str(), 0, start + 10 + i as u64);
        c.submit_answer(round, format!("tryout-{a}"), None);
    }
    let before = c.get_rating(acc("c.testnet"), SKILL.into());
    let s: Vec<(AccountId, u32)> = entrants.iter().map(|a| (a.clone(), if a.as_str() == "c.testnet" { 0 } else { 8 })).collect();
    let deadline = c.get_round(round).unwrap().answer_deadline_ms;
    ctx("verifier.testnet", 0, deadline + 1);
    c.settle(round, 10, s.clone(), vec![sign(&keys[0], round, 10, &s)]);
    let after = c.get_rating(acc("c.testnet"), SKILL.into());
    assert_eq!((after.rating, after.rounds), (before.rating, before.rounds));
    assert!(rating(&c, "a.testnet") != 150_000);
}

#[test]
fn anyone_cancels_a_round_the_verifier_abandoned() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    open(&mut c, id, NEAR);
    ctx("s.testnet", NEAR, 1_300);
    c.buy(id, acc("a.testnet"), None);
    lock(&mut c, id);
    answer_all(&mut c, id);
    let late = LOCK + 15 * 60_000 + 24 * 3_600_000 + 1;
    ctx("stranger.testnet", 0, late);
    c.cancel_round(id);
    assert_eq!(c.get_round(id).unwrap().status, RoundStatus::Cancelled);
    // The full purchase comes back, fee included, and the bond too.
    assert_eq!(claim(&mut c, "s.testnet", id), NEAR);
    assert_eq!(claim(&mut c, "a.testnet", id), NEAR / 2);
}

#[test]
#[should_panic(expected = "only the manager can cancel")]
fn stranger_cannot_cancel_early() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    ctx("stranger.testnet", 0, 1_200);
    c.cancel_round(id);
}

#[test]
#[should_panic(expected = "builder stake below minimum")]
fn builder_must_post_a_bond() {
    let (mut c, _) = setup(1);
    issue(&mut c, "a.testnet");
    ctx("manager.testnet", 0, 1_000);
    let id = c.create_round(SKILL.into(), TASK.into(), "sha256:tests".into(), LOCK, 5, None, None);
    ctx("a.testnet", NEAR / 10, 1_100);
    c.register_agent(id, acc("a.testnet"), League::Open, "cfg".into());
}

#[test]
#[should_panic(expected = "betting closed")]
fn no_purchases_after_the_deadline() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    open(&mut c, id, NEAR);
    ctx("s.testnet", NEAR, LOCK);
    c.buy(id, acc("a.testnet"), None);
}

#[test]
#[should_panic(expected = "fewer shares than min_shares")]
fn slippage_guard() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    open(&mut c, id, NEAR);
    ctx("s.testnet", NEAR, 1_300);
    let q = c.quote(id, acc("a.testnet"), U128(NEAR)).0;
    ctx("front.testnet", NEAR, 1_301);
    c.buy(id, acc("a.testnet"), None);
    ctx("s.testnet", NEAR, 1_302);
    c.buy(id, acc("a.testnet"), Some(U128(q)));
}

#[test]
fn uncurated_task_pays_but_does_not_rate() {
    let (mut c, keys) = setup(1);
    let id = round_on(&mut c, "my-own-easy-task", false);
    assert!(!c.get_round(id).unwrap().rated);
    lock(&mut c, id);
    answer_all(&mut c, id);
    settle_now(&mut c, &keys, id, 10, [10, 0, 0]);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.winners, vec![acc("a.testnet")]);
    assert_eq!(rating(&c, "a.testnet"), 150_000);
    assert_eq!(c.get_rating(acc("a.testnet"), SKILL.into()).rounds, 0);
}

#[test]
fn uncurated_round_does_not_score_scouts() {
    let (mut c, keys) = setup(1);
    let id = round_on(&mut c, "my-own-easy-task", false);
    open(&mut c, id, NEAR);
    ctx("insider.testnet", NEAR, 1_300);
    c.buy(id, acc("a.testnet"), None);
    lock(&mut c, id);
    answer_all(&mut c, id);
    settle_now(&mut c, &keys, id, 10, [10, 0, 0]);
    // The trade still pays, but it is no evidence of forecasting skill.
    assert!(claim(&mut c, "insider.testnet", id) > NEAR);
    let s = c.get_scout(acc("insider.testnet"));
    assert_eq!((s.skill_ppm, s.scored_rounds), (0, 0));
}

#[test]
#[should_panic(expected = "tests hash does not match the curated task")]
fn curated_task_pins_its_tests() {
    let (mut c, _) = setup(1);
    ctx("manager.testnet", 0, 1_000);
    c.create_round(SKILL.into(), TASK.into(), "sha256:other".into(), LOCK, 5, None, None);
}

// ----- verifiers, disputes, stakes -----

#[test]
fn two_of_three_settles_and_keys_count_once() {
    let (mut c, keys) = setup(2);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    answer_all(&mut c, id);
    let s = scores([10, 5, 0]);
    let sigs = vec![sign(&keys[0], id, 10, &s), sign(&keys[2], id, 10, &s)];
    ctx("verifier.testnet", 0, 7_000);
    c.settle(id, 10, s, sigs);
    assert_eq!(c.get_round(id).unwrap().status, RoundStatus::Settled);
}

#[test]
#[should_panic(expected = "not enough valid verifier signatures")]
fn same_key_twice_is_not_two_signatures() {
    let (mut c, keys) = setup(2);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    answer_all(&mut c, id);
    let s = scores([10, 5, 0]);
    let sig = sign(&keys[0], id, 10, &s);
    ctx("verifier.testnet", 0, 7_000);
    c.settle(id, 10, s, vec![sig.clone(), sig]);
}

#[test]
#[should_panic(expected = "not enough valid verifier signatures")]
fn unstaking_key_stops_counting() {
    let (mut c, keys) = setup(1);
    ctx("staker.testnet", 0, 1_000);
    c.request_unstake(near_pk(&keys[0]));
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    answer_all(&mut c, id);
    settle_now(&mut c, &keys, id, 10, [10, 5, 0]);
}

#[test]
#[should_panic(expected = "agent without an answer must score 0")]
fn missing_answer_cannot_score() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    ctx("a.testnet", 0, ANSWER);
    c.submit_answer(id, "hash-a".into(), None);
    let s = scores([5, 3, 0]);
    let sig = sign(&keys[0], id, 10, &s);
    ctx("verifier.testnet", 0, LOCK + 15 * 60_000 + 1);
    c.settle(id, 10, s, vec![sig]);
}

#[test]
fn scores_wait_out_the_dispute_window() {
    let (mut c, keys) = setup(1);
    set_window(&mut c, 600_000);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    answer_all(&mut c, id);
    settle_now(&mut c, &keys, id, 10, [9, 3, 0]);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.status, RoundStatus::Proposed);
    assert_eq!(r.proposal.as_ref().unwrap().dispute_until_ms, 7_000 + 600_000);
    // Ratings do not move until finalization.
    assert_eq!(rating(&c, "a.testnet"), 150_000);
    ctx("anyone.testnet", 0, 7_000 + 600_000);
    c.finalize(id);
    assert_eq!(c.get_round(id).unwrap().status, RoundStatus::Settled);
    assert!(rating(&c, "a.testnet") > 150_000);
}

#[test]
#[should_panic(expected = "dispute window still open")]
fn finalize_too_early() {
    let (mut c, keys) = setup(1);
    set_window(&mut c, 600_000);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    answer_all(&mut c, id);
    settle_now(&mut c, &keys, id, 10, [9, 3, 0]);
    ctx("anyone.testnet", 0, 8_000);
    c.finalize(id);
}

fn disputed_round(c: &mut Contract, keys: &[SigningKey]) -> u64 {
    set_window(c, 600_000);
    ctx("owner.testnet", 0, 1_000);
    c.set_arbiters(vec![near_pk(&key(9))], 1);
    let id = round_with_agents(c);
    lock(c, id);
    answer_all(c, id);
    // The verifier claims b won; a watcher re-runs the tests and disagrees.
    settle_now(c, keys, id, 10, [2, 9, 0]);
    ctx("watcher.testnet", NEAR, 60_000);
    c.dispute(id);
    assert_eq!(c.get_round(id).unwrap().status, RoundStatus::Disputed);
    id
}

#[test]
fn overturned_dispute_slashes_the_verifier() {
    let (mut c, keys) = setup(1);
    let id = disputed_round(&mut c, &keys);
    let fixed = scores([9, 2, 0]);
    let sig = sign_with(&key(9), settle::ROUND_ARBITER_DOMAIN, id, 10, &fixed);
    ctx("arbiter.testnet", 0, 70_000);
    c.resolve_dispute(id, 10, fixed, vec![sig]);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.status, RoundStatus::Settled);
    assert_eq!(r.winners, vec![acc("a.testnet")]);
    assert_eq!(r.dispute.unwrap().overturned, Some(true));
    // The lying key lost its stake and no longer counts.
    let stakes = c.get_verifier_stakes();
    let s0 = stakes.iter().find(|s| s.public_key == near_pk(&keys[0])).unwrap();
    assert_eq!(s0.amount.0, 0);
    assert!(!s0.active);
    assert!(get_logs().iter().any(|l| l.contains("verifier_slashed")));
}

#[test]
fn upheld_dispute_keeps_the_scores() {
    let (mut c, keys) = setup(1);
    let id = disputed_round(&mut c, &keys);
    let same = scores([2, 9, 0]);
    let sig = sign_with(&key(9), settle::ROUND_ARBITER_DOMAIN, id, 10, &same);
    ctx("arbiter.testnet", 0, 70_000);
    c.resolve_dispute(id, 10, same, vec![sig]);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.winners, vec![acc("b.testnet")]);
    assert_eq!(r.dispute.unwrap().overturned, Some(false));
    assert_eq!(c.get_verifier_stakes()[0].amount.0, NEAR);
}

#[test]
#[should_panic(expected = "not enough valid verifier signatures")]
fn verifier_signature_is_not_an_arbiter_ruling() {
    let (mut c, keys) = setup(1);
    let id = disputed_round(&mut c, &keys);
    let s = scores([2, 9, 0]);
    let sig = sign_with(&keys[0], settle::ROUND_ARBITER_DOMAIN, id, 10, &s);
    ctx("verifier.testnet", 0, 70_000);
    c.resolve_dispute(id, 10, s, vec![sig]);
}

#[test]
fn unresolved_dispute_expires_into_a_refund() {
    let (mut c, keys) = setup(1);
    let id = disputed_round(&mut c, &keys);
    ctx("anyone.testnet", 0, 60_000 + 3 * 24 * 3_600_000);
    c.expire_dispute(id);
    assert_eq!(c.get_round(id).unwrap().status, RoundStatus::Cancelled);
    assert_eq!(claim(&mut c, "a.testnet", id), NEAR / 2);
}

#[test]
fn stake_withdraws_only_after_the_delay() {
    let (mut c, keys) = setup(1);
    let pk = near_pk(&keys[1]);
    ctx("staker.testnet", 0, 1_000);
    c.request_unstake(pk.clone());
    let delay = c.get_config().params.unstake_delay_ms;
    ctx("staker.testnet", 0, 1_000 + delay);
    assert_eq!(c.withdraw_stake(pk).0, NEAR);
}

// ----- inference attestation -----

// A real NEAR AI Cloud gateway signature (see attest.rs).
const ATT_TEXT: &str = "ed12232d4055873a813ccdb6da40c818b64cd5367b223f8ced7cc1a437034d85:c3ab0df85ed4b729076352f92d719772f3b7621a31aa6b549aafe6189638cf1d";
const ATT_SIG: &str = "f72bb8505169c56230c3eaff6e1a8f0b1516a69cb9d27b596ec037113428310138cf6f1366058e52eda4211734c090e9711617aeaba58987e0286df9729e0401";
const ATT_SIGNER: &str = "40599fb284f43953bb356b09080fd803c960fc10285ad90eca462ca711ad4acb";
const ATT_HASH: &str = "sha256:c3ab0df85ed4b729076352f92d719772f3b7621a31aa6b549aafe6189638cf1d";

fn attestation() -> Attestation {
    Attestation { text: ATT_TEXT.into(), signature: ATT_SIG.into(), signer: ATT_SIGNER.into() }
}

fn attested_round(c: &mut Contract) -> u64 {
    ctx("owner.testnet", 0, 1_000);
    c.set_inference_signers(vec![ATT_SIGNER.into()]);
    let id = round_on(c, TASK, true);
    lock(c, id);
    id
}

#[test]
fn attested_answer_is_recorded_and_counted() {
    let (mut c, keys) = setup(1);
    let id = attested_round(&mut c);
    ctx("a.testnet", 0, ANSWER);
    c.submit_answer(id, ATT_HASH.into(), Some(attestation()));
    let e = &c.get_round(id).unwrap().entries[0];
    assert!(e.attested);
    assert_eq!(e.model, None);
    let s = scores([4, 0, 0]);
    let sig = sign(&keys[0], id, 10, &s);
    ctx("verifier.testnet", 0, LOCK + 15 * 60_000 + 1);
    c.settle(id, 10, s, vec![sig]);
    assert_eq!(c.get_rating(acc("a.testnet"), SKILL.into()).attested, 1);
    assert!(!c.is_qualified(acc("b.testnet"), SKILL.into(), 0, Some(1), Some(1)));
    assert!(c.is_qualified(acc("a.testnet"), SKILL.into(), 0, Some(1), Some(1)));
}

#[test]
#[should_panic(expected = "requires an inference attestation")]
fn attested_round_rejects_bare_answers() {
    let (mut c, _) = setup(1);
    let id = attested_round(&mut c);
    ctx("a.testnet", 0, ANSWER);
    c.submit_answer(id, ATT_HASH.into(), None);
}

#[test]
#[should_panic(expected = "must be the attested response hash")]
fn attestation_must_cover_the_answer() {
    let (mut c, _) = setup(1);
    let id = attested_round(&mut c);
    ctx("a.testnet", 0, ANSWER);
    c.submit_answer(id, "sha256:something-else".into(), Some(attestation()));
}

#[test]
#[should_panic(expected = "attestation signer is not trusted")]
fn untrusted_signer_is_rejected() {
    let (mut c, _) = setup(1);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    ctx("a.testnet", 0, ANSWER);
    c.submit_answer(id, ATT_HASH.into(), Some(attestation()));
}

// ----- jobs -----

/// Makes a.testnet qualified: three rounds where it solves everything and the others little.
fn veteran(c: &mut Contract, keys: &[SigningKey]) {
    for t in ["t1", "t2", "t3"] {
        let id = round_on(c, t, false);
        lock(c, id);
        answer_all(c, id);
        settle_now(c, keys, id, 10, [10, 2, 1]);
    }
}

fn post(c: &mut Contract, min_rating: u32) -> u64 {
    ctx("client.testnet", 5 * NEAR, 2_000_000);
    c.post_job(SKILL.into(), "job-task".into(), "sha256:jobtests".into(), min_rating, Some(3), Some(900_000), 3_600_000, None)
}

fn job_sig(k: &SigningKey, id: u64, total: u32, agent: &str, score: u32) -> Base64VecU8 {
    sign_with(k, jobs::JOB_DOMAIN, id, total, &[(acc(agent), score)])
}

#[test]
fn qualified_agent_is_hired_paid_and_rated() {
    let (mut c, keys) = setup(1);
    veteran(&mut c, &keys);
    let bar = (rating(&c, "a.testnet") / 100) as u32;
    let job = post(&mut c, bar);
    ctx("a.testnet", 0, 2_000_100);
    c.take_job(job);
    ctx("a.testnet", 0, 2_000_200);
    c.submit_job(job, "sha256:job-answer".into(), None);
    let before = rating(&c, "a.testnet");
    ctx("verifier.testnet", 0, 2_000_300);
    c.settle_job(job, 10, 10, vec![job_sig(&keys[0], job, 10, "a.testnet", 10)]);
    let j = c.get_job(job).unwrap();
    assert_eq!(j.status, JobStatus::Paid);
    assert!(j.rating_delta > 0);
    assert_eq!(rating(&c, "a.testnet"), before + j.rating_delta);
    let r = c.get_rating(acc("a.testnet"), SKILL.into());
    assert_eq!(r.jobs_done, 1);
    assert_eq!(c.get_task("job-task".into()).unwrap().jobs, 1);
}

#[test]
fn failed_job_refunds_the_poster_and_costs_rating() {
    let (mut c, keys) = setup(1);
    veteran(&mut c, &keys);
    let job = post(&mut c, 1_400);
    ctx("a.testnet", 0, 2_000_100);
    c.take_job(job);
    ctx("a.testnet", 0, 2_000_200);
    c.submit_job(job, "sha256:job-answer".into(), None);
    ctx("verifier.testnet", 0, 2_000_300);
    c.settle_job(job, 10, 8, vec![job_sig(&keys[0], job, 10, "a.testnet", 8)]);
    let j = c.get_job(job).unwrap();
    // 8/10 is below the 90% bar.
    assert_eq!(j.status, JobStatus::Failed);
    assert_eq!(c.get_rating(acc("a.testnet"), SKILL.into()).jobs_failed, 1);
}

#[test]
#[should_panic(expected = "does not meet the rating bar")]
fn unqualified_agent_cannot_take_a_job() {
    let (mut c, keys) = setup(1);
    veteran(&mut c, &keys);
    let job = post(&mut c, 1_500);
    // c lost every round.
    ctx("c.testnet", 0, 2_000_100);
    c.take_job(job);
}

#[test]
fn timed_out_job_reopens_and_counts_as_a_failure() {
    let (mut c, keys) = setup(1);
    veteran(&mut c, &keys);
    let job = post(&mut c, 1_400);
    ctx("a.testnet", 0, 2_000_100);
    c.take_job(job);
    let before = rating(&c, "a.testnet");
    ctx("anyone.testnet", 0, 2_000_100 + 3_600_001);
    c.release_job(job);
    let j = c.get_job(job).unwrap();
    assert_eq!(j.status, JobStatus::Open);
    assert!(rating(&c, "a.testnet") < before);
    assert_eq!(c.get_rating(acc("a.testnet"), SKILL.into()).jobs_failed, 1);
}

#[test]
fn uncurated_job_pays_but_builds_no_record() {
    let (mut c, keys) = setup(1);
    veteran(&mut c, &keys);
    ctx("friend.testnet", NEAR, 2_000_000);
    let job = c.post_job(SKILL.into(), "friendly-task".into(), "sha256:x".into(), 0, Some(1), None, 3_600_000, None);
    ctx("a.testnet", 0, 2_000_100);
    c.take_job(job);
    ctx("a.testnet", 0, 2_000_200);
    c.submit_job(job, "sha256:job-answer".into(), None);
    let before = c.get_rating(acc("a.testnet"), SKILL.into());
    ctx("verifier.testnet", 0, 2_000_300);
    c.settle_job(job, 10, 10, vec![job_sig(&keys[0], job, 10, "a.testnet", 10)]);
    assert_eq!(c.get_job(job).unwrap().status, JobStatus::Paid);
    let after = c.get_rating(acc("a.testnet"), SKILL.into());
    // Paid, but neither the rating nor the job count (which feeds is_qualified) moved.
    assert_eq!((after.rating, after.jobs_done), (before.rating, before.jobs_done));
}

#[test]
fn poster_cancels_an_untaken_job() {
    let (mut c, _) = setup(1);
    let job = post(&mut c, 0);
    ctx("client.testnet", 0, 2_000_100);
    c.cancel_job(job);
    assert_eq!(c.get_job(job).unwrap().status, JobStatus::Cancelled);
    assert_eq!(c.get_jobs(Some(JobStatus::Cancelled), None, None).len(), 1);
}

// ----- migration -----

#[test]
fn migrate_v6_keeps_everything_and_adds_briefs() {
    let (mut c, keys) = setup(1);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    answer_all(&mut c, id);
    settle_now(&mut c, &keys, id, 10, [9, 3, 0]);
    let job = post(&mut c, 0);
    let before = c.get_rating(acc("a.testnet"), SKILL.into()).rating;
    // Write the V6 layout (everything but the brief fields) and migrate.
    let v6 = legacy::ContractV6 {
        owner: c.owner.clone(),
        verifiers: c.verifiers.clone(),
        threshold: c.threshold,
        arbiters: c.arbiters.clone(),
        arbiter_threshold: c.arbiter_threshold,
        inference_signers: c.inference_signers.clone(),
        params: c.params.clone(),
        next_round_id: c.next_round_id,
        first_lmsr_round: c.first_lmsr_round,
        legacy_rounds: std::mem::replace(&mut c.legacy_rounds, LookupMap::new(StorageKey::Rounds)),
        legacy_positions: std::mem::replace(&mut c.legacy_positions, LookupMap::new(StorageKey::Positions)),
        rounds: std::mem::replace(&mut c.rounds, LookupMap::new(StorageKey::RoundsV2)),
        positions: std::mem::replace(&mut c.positions, LookupMap::new(StorageKey::PositionsV2)),
        ratings: std::mem::replace(&mut c.ratings, IterableMap::new(StorageKey::RatingsV2)),
        scouts: std::mem::replace(&mut c.scouts, IterableMap::new(StorageKey::ScoutsV2)),
        tasks: std::mem::replace(&mut c.tasks, IterableMap::new(StorageKey::Tasks)),
        jobs: std::mem::replace(&mut c.jobs, LookupMap::new(StorageKey::Jobs)),
        next_job_id: c.next_job_id,
        verifier_stakes: std::mem::replace(&mut c.verifier_stakes, LookupMap::new(StorageKey::VerifierStakes)),
        identities: std::mem::replace(&mut c.identities, IterableMap::new(StorageKey::IdentitiesV4)),
        next_identity: c.next_identity,
        face_pages: std::mem::replace(&mut c.face_pages, Vector::new(StorageKey::FacePages)),
        agent_by_number: std::mem::replace(&mut c.agent_by_number, LookupMap::new(StorageKey::AgentByNumber)),
    };
    std::mem::forget(c);
    let mut v6 = v6;
    v6.legacy_rounds.flush();
    v6.legacy_positions.flush();
    v6.rounds.flush();
    v6.positions.flush();
    v6.ratings.flush();
    v6.scouts.flush();
    v6.tasks.flush();
    v6.jobs.flush();
    v6.verifier_stakes.flush();
    v6.identities.flush();
    v6.face_pages.flush();
    v6.agent_by_number.flush();
    env::state_write(&v6);
    std::mem::forget(v6);
    ctx("league.testnet", 0, 2_000);
    let m = Contract::migrate();
    assert_eq!(m.get_round(id).unwrap().status, RoundStatus::Settled);
    assert_eq!(m.get_rating(acc("a.testnet"), SKILL.into()).rating, before);
    assert_eq!(m.get_job(job).unwrap().status, JobStatus::Open);
    assert_eq!(m.get_tasks(None, None).len(), 5);
    assert_eq!(m.get_identities(None, None).len(), 3);
    assert_eq!(m.get_verifier_stakes().len(), 3);
    assert!(m.get_briefs(None, None).is_empty());
    assert_eq!(m.get_config().next_brief_id, 1);
}

// ----- briefs: scouts find the agent for a client's task -----

const CLIENT: &str = "client.testnet";

fn post_brief(c: &mut Contract) -> u64 {
    ctx(CLIENT, 3 * NEAR + NEAR + NEAR / 2 + NEAR, 3_000_000);
    c.post_brief(
        SKILL.into(),
        "I need a parser for the CSV exports of my shop.".into(),
        None,
        Some("client-csv".into()),
        Some("sha256:client".into()),
        U128(3 * NEAR),
        U128(NEAR),
        U128(NEAR / 2),
        U128(NEAR),
        U128(NEAR / 10),
        600_000,
        600_000,
        3_600_000,
        Some(900_000),
        None,
        None,
        None,
    )
}

fn nominate(c: &mut Contract, brief: u64, scout: &str, agent: &str, task: &str, stake: u128) {
    ctx(scout, stake, 3_000_100);
    c.nominate(brief, acc(agent), task.into());
}

/// Brief with nominations: s1 and s3 back a (on t1 and t2), s2 backs b on t1, s4 backs c on t2.
fn scouted(c: &mut Contract) -> u64 {
    for a in AGENTS {
        if c.get_identity(acc(a)).is_none() {
            issue(c, a);
        }
    }
    let id = post_brief(c);
    nominate(c, id, "s1.testnet", "a.testnet", "t1", NEAR);
    nominate(c, id, "s2.testnet", "b.testnet", "t1", NEAR / 2);
    nominate(c, id, "s3.testnet", "a.testnet", "t2", 3 * NEAR);
    nominate(c, id, "s4.testnet", "c.testnet", "t2", NEAR / 5);
    id
}

/// Runs the tryout with scores [a, b, c] and returns its round id.
fn tryout(c: &mut Contract, keys: &[SigningKey], brief: u64, v: [u32; 3]) -> u64 {
    ctx("anyone.testnet", 0, 3_000_000 + 600_000);
    c.start_tryout(brief, None);
    let round = c.get_brief(brief).unwrap().tryout_round.unwrap();
    let start = 3_600_000 + 600_000;
    ctx("anyone.testnet", 0, start);
    c.lock_round(round);
    // Scores are given per agent a, b, c; only the nominees are in the round.
    let entrants: Vec<AccountId> = c.get_round(round).unwrap().entries.iter().map(|e| e.agent.clone()).collect();
    for (i, a) in entrants.iter().enumerate() {
        ctx(a.as_str(), 0, start + 10 + i as u64);
        c.submit_answer(round, format!("tryout-{a}"), None);
    }
    let s: Vec<(AccountId, u32)> = entrants.iter().map(|a| (a.clone(), v[AGENTS.iter().position(|x| acc(x) == *a).unwrap()])).collect();
    let sig = sign(&keys[0], round, 10, &s);
    ctx("verifier.testnet", 0, start + 100);
    c.settle(round, 10, s, vec![sig]);
    ctx("anyone.testnet", 0, start + 200);
    c.offer(brief);
    round
}

/// Accept, answer and score the client's job; returns the job id.
fn deliver(c: &mut Contract, keys: &[SigningKey], brief: u64, score: u32) -> u64 {
    ctx(CLIENT, 0, 5_000_000);
    let job = c.accept_offer(brief, None, None);
    let agent = c.get_job(job).unwrap().agent.unwrap();
    ctx(agent.as_str(), 0, 5_000_100);
    c.submit_job(job, "sha256:client-answer".into(), None);
    ctx("verifier.testnet", 0, 5_000_200);
    c.settle_job(job, 10, score, vec![job_sig(&keys[0], job, 10, agent.as_str(), score)]);
    job
}

#[test]
fn brief_funnel_pays_the_scouts_who_found_the_agent() {
    let (mut c, keys) = setup(1);
    let id = scouted(&mut c);
    let round = tryout(&mut c, &keys, id, [9, 6, 2]);
    // Most stake sat behind t2 (3.2 NEAR vs 1.5): the tryout ran there, rated, with all nominees.
    let r = c.get_round(round).unwrap();
    assert_eq!(r.task_ref, "t2");
    assert!(r.rated);
    assert_eq!(r.entries.len(), 3);
    assert_eq!(r.manager, acc(CLIENT));
    let b = c.get_brief(id).unwrap();
    assert_eq!(b.status, BriefStatus::Offered);
    assert_eq!(b.offered, Some(acc("a.testnet")));

    let job = deliver(&mut c, &keys, id, 10);
    assert_eq!(c.get_job(job).unwrap().status, JobStatus::Paid);
    let b = c.get_brief(id).unwrap();
    assert_eq!(b.status, BriefStatus::Delivered);
    // a's scouts split the 1 NEAR reward 1:3 by stake; the others get their stake back.
    let pay: Vec<u128> = b.nominations.iter().map(|n| n.payout.0).collect();
    assert_eq!(pay, vec![NEAR + NEAR / 4, NEAR / 2, 3 * NEAR + 3 * NEAR / 4, NEAR / 5]);
    let rec = c.get_scout_record(acc("s3.testnet"));
    assert_eq!((rec.nominated, rec.hired, rec.delivered, rec.earned.0), (1, 1, 1, 3 * NEAR / 4));
    assert_eq!(c.get_scout_record(acc("s2.testnet")).hired, 0);
}

#[test]
fn failed_hire_costs_its_scouts_their_stake() {
    let (mut c, keys) = setup(1);
    let id = scouted(&mut c);
    tryout(&mut c, &keys, id, [9, 6, 2]);
    deliver(&mut c, &keys, id, 5);
    let b = c.get_brief(id).unwrap();
    assert_eq!(b.status, BriefStatus::Failed);
    let pay: Vec<u128> = b.nominations.iter().map(|n| n.payout.0).collect();
    assert_eq!(pay, vec![0, NEAR / 2, 0, NEAR / 5]);
    let rec = c.get_scout_record(acc("s1.testnet"));
    assert_eq!((rec.failed, rec.slashed.0), (1, NEAR));
    assert!(get_logs().iter().any(|l| l.contains("brief_closed")));
}

#[test]
fn tied_tryout_offers_the_higher_rated_winner() {
    let (mut c, keys) = setup(1);
    veteran(&mut c, &keys);
    let id = scouted(&mut c);
    // b ties a on the tryout, but a has the better record.
    tryout(&mut c, &keys, id, [8, 8, 1]);
    assert!(rating(&c, "a.testnet") > rating(&c, "b.testnet"));
    assert_eq!(c.get_brief(id).unwrap().offered, Some(acc("a.testnet")));
}

#[test]
fn single_nominee_is_offered_without_a_tryout_and_can_be_declined() {
    let (mut c, _) = setup(1);
    issue(&mut c, "a.testnet");
    let id = post_brief(&mut c);
    nominate(&mut c, id, "s1.testnet", "a.testnet", "t1", NEAR);
    ctx("anyone.testnet", 0, 3_600_000);
    c.start_tryout(id, None);
    let b = c.get_brief(id).unwrap();
    assert_eq!((b.status, b.tryout_round), (BriefStatus::Offered, None));
    ctx(CLIENT, 0, 3_700_000);
    c.decline_offer(id);
    let b = c.get_brief(id).unwrap();
    assert_eq!(b.status, BriefStatus::Declined);
    assert_eq!(b.nominations[0].payout.0, NEAR);
}

#[test]
fn brief_without_nominations_is_refunded() {
    let (mut c, _) = setup(1);
    let id = post_brief(&mut c);
    ctx("anyone.testnet", 0, 3_600_000);
    c.start_tryout(id, None);
    assert_eq!(c.get_brief(id).unwrap().status, BriefStatus::Cancelled);
}

#[test]
fn hire_that_misses_its_deadline_fails_the_brief() {
    let (mut c, keys) = setup(1);
    let id = scouted(&mut c);
    tryout(&mut c, &keys, id, [9, 6, 2]);
    ctx(CLIENT, 0, 5_000_000);
    let job = c.accept_offer(id, None, None);
    ctx("anyone.testnet", 0, 5_000_000 + 3_600_001);
    c.release_job(job);
    assert_eq!(c.get_job(job).unwrap().status, JobStatus::Failed);
    assert_eq!(c.get_brief(id).unwrap().status, BriefStatus::Failed);
}

#[test]
#[should_panic(expected = "the tryout task must be a curated task")]
fn tryout_task_must_be_curated() {
    let (mut c, _) = setup(1);
    issue(&mut c, "a.testnet");
    let id = post_brief(&mut c);
    ctx("owner.testnet", 0, 1_000);
    round_on(&mut c, "loose-task", false);
    nominate(&mut c, id, "s1.testnet", "a.testnet", "loose-task", NEAR);
}

/// A brief that names only a category: the task is handed over at hire.
fn category_brief(c: &mut Contract) -> u64 {
    ctx("owner.testnet", 0, 1_000);
    c.set_category("parsing".into(), "Parsing text".into(), "Turn messy text into data.".into());
    c.set_category("math".into(), "Math".into(), "Expressions and numbers.".into());
    c.set_task_category("t1".into(), "parsing".into());
    c.set_task_category("t2".into(), "math".into());
    for a in AGENTS {
        if c.get_identity(acc(a)).is_none() {
            issue(c, a);
        }
    }
    ctx(CLIENT, 3 * NEAR + NEAR + NEAR / 2 + NEAR, 3_000_000);
    c.post_brief(SKILL.into(), "Parse my shop exports.".into(), Some("parsing".into()), None, None, U128(3 * NEAR), U128(NEAR), U128(NEAR / 2), U128(NEAR), U128(NEAR / 10), 600_000, 600_000, 3_600_000, None, None, None, None)
}

#[test]
fn client_hands_over_its_task_only_to_the_hire() {
    let (mut c, keys) = setup(1);
    let id = category_brief(&mut c);
    assert_eq!(c.get_categories().iter().find(|x| x.id == "parsing").unwrap().skill_tasks, vec!["t1".to_string()]);
    nominate(&mut c, id, "s1.testnet", "a.testnet", "t1", NEAR);
    nominate(&mut c, id, "s2.testnet", "b.testnet", "t1", NEAR);
    assert_eq!(c.next_tryout_task(id), Some("t1".into()));
    let b = c.get_brief(id).unwrap();
    assert_eq!((b.task_ref, b.category.as_deref()), (None, Some("parsing")));
    tryout(&mut c, &keys, id, [9, 4, 0]);
    // The task is named only now, with the hire.
    ctx(CLIENT, 0, 5_000_000);
    let job = c.accept_offer(id, Some("client-csv".into()), Some("sha256:client".into()));
    let j = c.get_job(job).unwrap();
    assert_eq!((j.task_ref.as_str(), j.agent), ("client-csv", Some(acc("a.testnet"))));
    assert_eq!(c.get_brief(id).unwrap().task_ref.as_deref(), Some("client-csv"));
}

#[test]
#[should_panic(expected = "hand over the task")]
fn hire_needs_the_task() {
    let (mut c, keys) = setup(1);
    let id = category_brief(&mut c);
    nominate(&mut c, id, "s1.testnet", "a.testnet", "t1", NEAR);
    nominate(&mut c, id, "s2.testnet", "b.testnet", "t1", NEAR);
    tryout(&mut c, &keys, id, [9, 4, 0]);
    ctx(CLIENT, 0, 5_000_000);
    c.accept_offer(id, None, None);
}

#[test]
#[should_panic(expected = "must be in the brief's category")]
fn tryout_task_must_fit_the_category() {
    let (mut c, _) = setup(1);
    let id = category_brief(&mut c);
    nominate(&mut c, id, "s1.testnet", "a.testnet", "t2", NEAR);
}

#[test]
fn family_task_runs_on_fresh_tests_each_round() {
    let (mut c, _) = setup(1);
    ctx("owner.testnet", 0, 1_000);
    c.add_task("fam".into(), SKILL.into(), "family:sha256:generator".into());
    issue(&mut c, "a.testnet");
    ctx("manager.testnet", 0, 1_000);
    let r1 = c.create_round(SKILL.into(), "fam".into(), "sha256:tests-seed-1".into(), LOCK, 5, None, None);
    let r2 = c.create_round(SKILL.into(), "fam".into(), "sha256:tests-seed-2".into(), LOCK, 5, None, None);
    assert!(c.get_round(r1).unwrap().rated && c.get_round(r2).unwrap().rated);
    assert_ne!(c.get_round(r1).unwrap().tests_hash, c.get_round(r2).unwrap().tests_hash);
}

#[test]
#[should_panic(expected = "commit the fresh tests hash")]
fn family_tryout_needs_a_fresh_tests_hash() {
    let (mut c, _) = setup(1);
    ctx("owner.testnet", 0, 1_000);
    c.add_task("fam".into(), SKILL.into(), "family:sha256:generator".into());
    for a in AGENTS {
        issue(&mut c, a);
    }
    let id = post_brief(&mut c);
    nominate(&mut c, id, "s1.testnet", "a.testnet", "fam", NEAR);
    nominate(&mut c, id, "s2.testnet", "b.testnet", "fam", NEAR);
    ctx("owner.testnet", 0, 3_600_000);
    c.start_tryout(id, None);
}

#[test]
fn family_tryout_takes_the_league_tests_hash() {
    let (mut c, _) = setup(1);
    ctx("owner.testnet", 0, 1_000);
    c.add_task("fam".into(), SKILL.into(), "family:sha256:generator".into());
    for a in AGENTS {
        issue(&mut c, a);
    }
    let id = post_brief(&mut c);
    nominate(&mut c, id, "s1.testnet", "a.testnet", "fam", NEAR);
    nominate(&mut c, id, "s2.testnet", "b.testnet", "fam", NEAR);
    ctx("owner.testnet", 0, 3_600_000);
    c.start_tryout(id, Some("sha256:fresh".into()));
    let r = c.get_round(c.get_brief(id).unwrap().tryout_round.unwrap()).unwrap();
    assert_eq!(r.tests_hash, "sha256:fresh");
}

#[test]
fn model_enclave_attestation_records_the_model() {
    let (mut c, _) = setup(1);
    ctx("owner.testnet", 0, 1_000);
    c.set_inference_signers(vec!["model:0x3b753b4406613c5e70ae640508632b600424fa0c".into()]);
    let id = round_with_agents(&mut c);
    lock(&mut c, id);
    let att = Attestation {
        text: "z-ai/glm-5.3-flash:7d948ea65843e5895371355867545313ff2b8ceb12c16674eba1a9f96f568d03:3539d3009b9e81f56db30373f34cd5b4886399d7c752ad9808f715fe9bc39d26".into(),
        signature: "0x44cdcfe83cacc9c01d9221852d81d68fe8ea49262c82a5536eab3dc5b445f0d50aab1b4c0952ec2e4b3f4a8fa99588da4d1d78dba683ad6b90788f06fce918361c".into(),
        signer: "0x3b753b4406613c5e70ae640508632b600424fa0c".into(),
    };
    ctx("a.testnet", 0, ANSWER);
    c.submit_answer(id, "sha256:3539d3009b9e81f56db30373f34cd5b4886399d7c752ad9808f715fe9bc39d26".into(), Some(att));
    let e = &c.get_round(id).unwrap().entries[0];
    assert!(e.attested);
    assert_eq!(e.model.as_deref(), Some("z-ai/glm-5.3-flash"));
}

const ENCLAVE_SIGNER: &str = "0x3b753b4406613c5e70ae640508632b600424fa0c";

fn enclave_attestation() -> Attestation {
    Attestation {
        text: "z-ai/glm-5.3-flash:7d948ea65843e5895371355867545313ff2b8ceb12c16674eba1a9f96f568d03:3539d3009b9e81f56db30373f34cd5b4886399d7c752ad9808f715fe9bc39d26".into(),
        signature: "0x44cdcfe83cacc9c01d9221852d81d68fe8ea49262c82a5536eab3dc5b445f0d50aab1b4c0952ec2e4b3f4a8fa99588da4d1d78dba683ad6b90788f06fce918361c".into(),
        signer: ENCLAVE_SIGNER.into(),
    }
}

/// A confidential job, accepted, ready for the client's answer.
fn confidential_job(c: &mut Contract) -> u64 {
    ctx("owner.testnet", 0, 1_000);
    c.set_inference_signers(vec![format!("model:{ENCLAVE_SIGNER}"), ATT_SIGNER.into()]);
    issue(c, "a.testnet");
    ctx(CLIENT, 3 * NEAR + NEAR + NEAR / 2 + NEAR, 3_000_000);
    let id = c.post_brief(SKILL.into(), "Private work.".into(), None, None, None, U128(3 * NEAR), U128(NEAR), U128(NEAR / 2), U128(NEAR), U128(NEAR / 10), 600_000, 600_000, 3_600_000, None, None, None, Some(true));
    nominate(c, id, "s1.testnet", "a.testnet", "t1", NEAR);
    ctx("anyone.testnet", 0, 3_600_000);
    c.start_tryout(id, None);
    ctx(CLIENT, 0, 3_700_000);
    c.accept_offer(id, Some("secret-task".into()), Some("sha256:secret".into()))
}

#[test]
fn confidential_job_is_committed_by_the_client_with_an_enclave_signature() {
    let (mut c, _) = setup(1);
    let job = confidential_job(&mut c);
    assert!(c.get_job(job).unwrap().attested);
    ctx(CLIENT, 0, 3_800_000);
    c.submit_job(job, "sha256:3539d3009b9e81f56db30373f34cd5b4886399d7c752ad9808f715fe9bc39d26".into(), Some(enclave_attestation()));
    let j = c.get_job(job).unwrap();
    assert_eq!(j.status, JobStatus::Answered);
    assert_eq!(j.model.as_deref(), Some("z-ai/glm-5.3-flash"));
}

#[test]
#[should_panic(expected = "needs a model-enclave attestation")]
fn confidential_job_refuses_a_gateway_signature() {
    let (mut c, _) = setup(1);
    let job = confidential_job(&mut c);
    ctx(CLIENT, 0, 3_800_000);
    c.submit_job(job, ATT_HASH.into(), Some(attestation()));
}

#[test]
#[should_panic(expected = "only the agent that took the job")]
fn ordinary_job_is_not_answered_by_the_poster() {
    let (mut c, keys) = setup(1);
    veteran(&mut c, &keys);
    let job = post(&mut c, 0);
    ctx("a.testnet", 0, 2_000_100);
    c.take_job(job);
    ctx("client.testnet", 0, 2_000_200);
    c.submit_job(job, "sha256:x".into(), None);
}

#[test]
fn owner_can_hand_over_to_a_dao() {
    let (mut c, _) = setup(1);
    ctx("owner.testnet", 0, 1_000);
    c.set_owner(acc("league.sputnik-dao.testnet"));
    assert_eq!(c.get_config().owner, acc("league.sputnik-dao.testnet"));
}

#[test]
#[should_panic(expected = "the client cannot nominate")]
fn client_cannot_nominate() {
    let (mut c, _) = setup(1);
    issue(&mut c, "a.testnet");
    let id = post_brief(&mut c);
    nominate(&mut c, id, CLIENT, "a.testnet", "t1", NEAR);
}

#[test]
#[should_panic(expected = "attach exactly")]
fn brief_escrow_must_match() {
    let (mut c, _) = setup(1);
    ctx(CLIENT, NEAR, 3_000_000);
    c.post_brief(SKILL.into(), "x".into(), None, Some("client-csv".into()), Some("h".into()), U128(3 * NEAR), U128(0), U128(0), U128(0), U128(NEAR / 10), 600_000, 600_000, 600_000, None, None, None, None);
}

/// Signature produced by the TypeScript verifier (packages/shared signMessage) for seed [7; 32].
/// Guards against the two sides drifting apart on message format or hashing.
#[test]
fn accepts_signature_from_typescript_verifier() {
    let pk: PublicKey = "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB".parse().unwrap();
    let sig = near_sdk::base64::Engine::decode(
        &near_sdk::base64::engine::general_purpose::STANDARD,
        "Uhy2nc8pcLvqBg/EAcphv1WXZlz/TVaWgNKGZScqB4rHLq0sqNmJBuGCDEFXKT7H0YaI7aiKqEV3XZSO7kBZAQ==",
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
    let id = c.create_round(SKILL.into(), "t".into(), "h".into(), 5_000, 5, None, None);
    ctx("builder.testnet", NEAR, 1_100);
    c.register_agent(id, acc("nobody.testnet"), League::Open, "cfg".into());
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

#[test]
fn unrated_round_on_a_curated_task_moves_no_rating() {
    let (mut c, keys) = setup(1);
    let id = round_rated(&mut c, TASK, false, Some(false));
    assert!(!c.get_round(id).unwrap().rated);
    lock(&mut c, id);
    answer_all(&mut c, id);
    let task_before = c.get_tasks(None, None).into_iter().find(|t| t.task_ref == TASK).unwrap().record.rating;
    settle_now(&mut c, &keys, id, 10, [10, 3, 0]);
    for a in AGENTS {
        assert_eq!(rating(&c, a), 150_000);
        assert_eq!(c.get_rating(acc(a), SKILL.into()).rounds, 0);
    }
    let task_after = c.get_tasks(None, None).into_iter().find(|t| t.task_ref == TASK).unwrap().record.rating;
    assert_eq!(task_before, task_after);
}

#[test]
#[should_panic(expected = "never a brief's tryout")]
fn client_cannot_cancel_its_tryout() {
    let (mut c, _) = setup(1);
    let id = scouted(&mut c);
    ctx("anyone.testnet", 0, 3_000_000 + 600_000);
    c.start_tryout(id, None);
    let round = c.get_brief(id).unwrap().tryout_round.unwrap();
    ctx(CLIENT, 0, 3_000_000 + 700_000);
    c.cancel_round(round);
}

#[test]
fn stale_tryout_can_still_be_cancelled_and_refunds_the_client() {
    let (mut c, _) = setup(1);
    let id = scouted(&mut c);
    ctx("anyone.testnet", 0, 3_000_000 + 600_000);
    c.start_tryout(id, None);
    let round = c.get_brief(id).unwrap().tryout_round.unwrap();
    let start = 3_600_000 + 600_000;
    ctx("anyone.testnet", 0, start);
    c.lock_round(round);
    let deadline = c.get_round(round).unwrap().answer_deadline_ms;
    ctx("anyone.testnet", 0, deadline + c.get_config().params.settle_timeout_ms + 1);
    c.cancel_round(round);
    c.offer(id);
    assert_eq!(c.get_brief(id).unwrap().status, BriefStatus::Cancelled);
}
