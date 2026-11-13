//! Pure functions behind the league rules (see RULES.md).
//! Everything here is deterministic and free of contract state, so it is unit tested directly.

/// 100% in parts per million.
pub const PPM: u64 = 1_000_000;
/// Starting rating in centi-points (1500.00).
pub const INITIAL_RATING: i64 = 150_000;

/// Market-implied win probability of every entrant, in ppm.
/// With an empty pool every entrant gets an equal share.
pub fn market_odds_ppm(pools: &[u128]) -> Vec<u64> {
    let n = pools.len() as u64;
    if n == 0 {
        return vec![];
    }
    let total: u128 = pools.iter().sum();
    if total == 0 {
        return vec![PPM / n; pools.len()];
    }
    pools
        .iter()
        .map(|p| (p * PPM as u128 / total) as u64)
        .collect()
}

/// Rating-implied win probability among the entrants, in ppm:
/// `10^(r_i / 400) / sum_j 10^(r_j / 400)` with ratings in centi-points.
pub fn prior_odds_ppm(ratings_centi: &[i64]) -> Vec<u64> {
    if ratings_centi.is_empty() {
        return vec![];
    }
    let max = *ratings_centi.iter().max().unwrap();
    // Shift by the max rating so the largest weight is exactly 1.0 and nothing overflows.
    let weights: Vec<f64> = ratings_centi
        .iter()
        .map(|r| 10f64.powf((r - max) as f64 / 40_000.0))
        .collect();
    let sum: f64 = weights.iter().sum();
    weights
        .iter()
        .map(|w| (w / sum * PPM as f64) as u64)
        .collect()
}

/// Expected score `p_i = w * market_i + (1 - w) * prior_i`, `w = min(1, volume / min_pool)`.
pub fn blend_ppm(market: &[u64], prior: &[u64], volume: u128, min_pool: u128) -> Vec<u64> {
    let w_ppm: u128 = if min_pool == 0 || volume >= min_pool { PPM as u128 } else { volume * PPM as u128 / min_pool };
    market
        .iter()
        .zip(prior.iter())
        .map(|(m, p)| ((w_ppm * *m as u128 + (PPM as u128 - w_ppm) * *p as u128) / PPM as u128) as u64)
        .collect()
}

/// Parimutuel form used by rounds settled before the LMSR market: pools are the market.
pub fn blended_odds_ppm(pools: &[u128], ratings_centi: &[i64], min_pool: u128) -> Vec<u64> {
    let total: u128 = pools.iter().sum();
    blend_ppm(&market_odds_ppm(pools), &prior_odds_ppm(ratings_centi), total, min_pool)
}

/// Rating deltas in centi-points for one settled round with a winner.
///
/// The outcome is each agent's share of all points scored, `s_i = score_i / sum(scores)`, so
/// an agent that solved as much as the winner is not treated like one that solved nothing.
/// `delta_i = k * (s_i - p_i)`, rounded toward zero for everyone except `absorber` (the
/// winner), which takes minus the sum of the others, so the total change is exactly zero.
pub fn rating_deltas(p_ppm: &[u64], scores: &[u32], absorber: usize, k_factor: u32) -> Vec<i64> {
    let k_centi = k_factor as i128 * 100;
    let total: u128 = scores.iter().map(|s| *s as u128).sum();
    let mut deltas: Vec<i64> = p_ppm
        .iter()
        .zip(scores.iter())
        .enumerate()
        .map(|(i, (p, sc))| {
            if i == absorber || total == 0 {
                0
            } else {
                let s_ppm = (*sc as u128 * PPM as u128 / total) as i128;
                (k_centi * (s_ppm - *p as i128) / PPM as i128) as i64
            }
        })
        .collect();
    let others: i64 = deltas.iter().sum();
    deltas[absorber] = -others;
    deltas
}

/// Indices of every entrant with the highest score, in entry order. Empty when the highest
/// score is 0. Ties are not broken: tied winners share the bounty and the market pays each of
/// them a share of a unit.
pub fn winners(scores: &[u32]) -> Vec<usize> {
    let best = scores.iter().copied().max().unwrap_or(0);
    if best == 0 {
        return vec![];
    }
    (0..scores.len()).filter(|i| scores[*i] == best).collect()
}

/// Expected pass rate of an agent against a task, ppm: `1 / (1 + 10^((T - R) / 400))`.
pub fn expected_vs_task_ppm(agent_centi: i64, task_centi: i64) -> u64 {
    let e = 1.0 / (1.0 + 10f64.powf((task_centi - agent_centi) as f64 / 40_000.0));
    (e * PPM as f64).round() as u64
}

/// Rating change against the task: `k * (passed / total - expected)` per agent, rounded toward
/// zero, and minus their sum for the task, so agents and tasks together stay zero-sum.
pub fn task_deltas(agent_centi: &[i64], task_centi: i64, scores: &[u32], total: u32, k: u32) -> (Vec<i64>, i64) {
    let k_centi = k as i128 * 100;
    let deltas: Vec<i64> = agent_centi
        .iter()
        .zip(scores.iter())
        .map(|(r, s)| {
            let a_ppm = if total == 0 { 0 } else { *s as i128 * PPM as i128 / total as i128 };
            let e_ppm = expected_vs_task_ppm(*r, task_centi) as i128;
            (k_centi * (a_ppm - e_ppm) / PPM as i128) as i64
        })
        .collect();
    let task = -deltas.iter().sum::<i64>();
    (deltas, task)
}

/// Market fee for a pool.
pub fn fee(total: u128, fee_bps: u16) -> u128 {
    total * fee_bps as u128 / 10_000
}

// ----- LMSR market maker -----
//
// Prices `p_i = exp(q_i / b) / sum_j exp(q_j / b)` where `q_i` is the number of shares sold on
// entrant i (one share pays 1 yoctoNEAR if i wins). The cost of the market is
// `C(q) = b * ln(sum_j exp(q_j / b))`; the maker's worst-case loss is `b * ln(n)`, which the
// manager deposits as the subsidy. Floats are deterministic on NEAR; every result is rounded
// against the trader, so the maker never owes more than it holds.

/// Liquidity parameter for a subsidy over `n` entrants: `b = subsidy / ln(n)`, rounded down.
pub fn lmsr_b(subsidy: u128, n: usize) -> u128 {
    if n < 2 || subsidy == 0 {
        return 0;
    }
    (subsidy as f64 / (n as f64).ln() * (1.0 - 1e-9)) as u128
}

fn lmsr_probs(shares: &[u128], b: u128) -> Vec<f64> {
    let n = shares.len();
    if n == 0 {
        return vec![];
    }
    if b == 0 {
        return vec![1.0 / n as f64; n];
    }
    let x: Vec<f64> = shares.iter().map(|q| *q as f64 / b as f64).collect();
    let m = x.iter().cloned().fold(f64::MIN, f64::max);
    let e: Vec<f64> = x.iter().map(|v| (v - m).exp()).collect();
    let s: f64 = e.iter().sum();
    e.iter().map(|v| v / s).collect()
}

/// Current prices in ppm (uniform when there is no liquidity).
pub fn lmsr_prices_ppm(shares: &[u128], b: u128) -> Vec<u64> {
    lmsr_probs(shares, b).iter().map(|p| (p * PPM as f64).round() as u64).collect()
}

/// Shares of entrant `i` that `spend` buys: `b * ln(1 + expm1(spend / b) / p_i)`, rounded down
/// with a small safety margin for float error.
pub fn lmsr_buy(shares: &[u128], b: u128, i: usize, spend: u128) -> u128 {
    if b == 0 || spend == 0 {
        return 0;
    }
    let bf = b as f64;
    let x: Vec<f64> = shares.iter().map(|q| *q as f64 / bf).collect();
    let m = x.iter().cloned().fold(f64::MIN, f64::max);
    // ln(1 / p_i) = logsumexp(x) - x_i
    let lse = m + x.iter().map(|v| (v - m).exp()).sum::<f64>().ln();
    let l = lse - x[i];
    let z = spend as f64 / bf;
    let log_expm1 = if z > 30.0 { z } else { z.exp_m1().ln() };
    let y = log_expm1 + l;
    let softplus = if y > 30.0 { y } else { y.exp().ln_1p() };
    let d = softplus * bf * (1.0 - 1e-9);
    if d.is_finite() && d > 0.0 {
        d as u128
    } else {
        0
    }
}

/// Cost function `C(q)` in yoctoNEAR, for tests and views.
pub fn lmsr_cost(shares: &[u128], b: u128) -> f64 {
    let bf = b as f64;
    let x: Vec<f64> = shares.iter().map(|q| *q as f64 / bf).collect();
    let m = x.iter().cloned().fold(f64::MIN, f64::max);
    bf * (m + x.iter().map(|v| (v - m).exp()).sum::<f64>().ln())
}

/// Gross payout of a position: one unit per share on a winner, split evenly between tied winners.
pub fn position_payout(shares: &[u128], winners: &[usize]) -> u128 {
    if winners.is_empty() {
        return 0;
    }
    winners.iter().map(|w| shares.get(*w).copied().unwrap_or(0)).sum::<u128>() / winners.len() as u128
}

uint::construct_uint! {
    /// 256-bit unsigned integer for overflow-free `a * b / c` on yoctoNEAR amounts.
    pub struct U256(4);
}

/// `a * b / c` rounded down, without intermediate overflow.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    assert!(c != 0, "division by zero");
    (U256::from(a) * U256::from(b) / U256::from(c)).as_u128()
}

/// Payout of one backer of the winner.
pub fn payout(position_on_winner: u128, pool_of_winner: u128, net: u128) -> u128 {
    if pool_of_winner == 0 {
        return 0;
    }
    mul_div(position_on_winner, net, pool_of_winner)
}

/// Message the verifiers sign (before hashing) for a round.
pub fn settlement_message(round_id: u64, total_tests: u32, scores: &[(&str, u32)]) -> String {
    signed_message("benchmarket:v1", round_id, total_tests, scores)
}

/// Messages for arbiters (`benchmarket:arbiter:v1`) and jobs (`benchmarket:job:v1`,
/// `benchmarket:job-arbiter:v1`) share the round format with another domain.
pub fn signed_message(domain: &str, id: u64, total_tests: u32, scores: &[(&str, u32)]) -> String {
    let body: Vec<String> = scores.iter().map(|(a, s)| format!("{a}={s}")).collect();
    format!("{domain}:{id}:{total_tests}:{}", body.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEAR: u128 = 10u128.pow(24);

    #[test]
    fn market_odds_follow_pools() {
        assert_eq!(market_odds_ppm(&[40, 25, 20, 10, 5]), vec![400_000, 250_000, 200_000, 100_000, 50_000]);
        assert_eq!(market_odds_ppm(&[0, 0]), vec![500_000, 500_000]);
    }

    #[test]
    fn prior_is_uniform_for_equal_ratings_and_favors_higher() {
        let p = prior_odds_ppm(&[150_000, 150_000]);
        assert_eq!(p, vec![500_000, 500_000]);
        // 400 points apart: 10x the weight.
        let p = prior_odds_ppm(&[190_000, 150_000]);
        assert!((p[0] as i64 - 909_090).abs() <= 1, "{p:?}");
    }

    #[test]
    fn blend_uses_prior_when_pool_is_thin() {
        let ratings = [150_000, 150_000];
        // Empty market weight: pure prior.
        assert_eq!(blended_odds_ppm(&[0, 0], &ratings, 10 * NEAR), vec![500_000, 500_000]);
        // Half of min_pool: half market, half prior.
        let p = blended_odds_ppm(&[5 * NEAR, 0], &ratings, 10 * NEAR);
        assert_eq!(p, vec![750_000, 250_000]);
        // Full pool: pure market.
        let p = blended_odds_ppm(&[30 * NEAR, 10 * NEAR], &ratings, 10 * NEAR);
        assert_eq!(p, vec![750_000, 250_000]);
    }

    #[test]
    fn deltas_match_the_spec_example_and_sum_to_zero() {
        let p = [400_000, 250_000, 200_000, 100_000, 50_000];
        // Shares 50%, 25%, 25%, 0, 0 against expectations 40%, 25%, 20%, 10%, 5%.
        let d = rating_deltas(&p, &[20, 10, 10, 0, 0], 0, 32);
        assert_eq!(d, vec![320, 0, 160, -320, -160]);
        assert_eq!(d.iter().sum::<i64>(), 0);
        // A perfect score that loses only on time still gains when it beat its expectation.
        let d = rating_deltas(&[333_333, 111_111, 555_556], &[36, 36, 36], 0, 32);
        assert!(d[1] > 0 && d[2] < 0);
        assert_eq!(d.iter().sum::<i64>(), 0);
        // Rounding residue goes to the absorber, so the sum is still zero.
        let d = rating_deltas(&[333_333, 333_333, 333_334], &[7, 5, 3], 2, 32);
        assert_eq!(d.iter().sum::<i64>(), 0);
    }

    #[test]
    fn ties_are_shared_not_broken() {
        assert_eq!(winners(&[10, 12, 3]), vec![1]);
        assert_eq!(winners(&[12, 12, 3]), vec![0, 1]);
        assert_eq!(winners(&[0, 0, 0]), Vec::<usize>::new());
        assert_eq!(position_payout(&[9, 6, 1], &[0, 1]), 7);
        assert_eq!(position_payout(&[9, 6, 1], &[]), 0);
    }

    #[test]
    fn task_rating_is_zero_sum_and_saturates() {
        // Equal ratings: expected pass rate 50%.
        assert_eq!(expected_vs_task_ppm(150_000, 150_000), 500_000);
        // 400 points stronger than the task: 10/11.
        assert_eq!(expected_vs_task_ppm(190_000, 150_000), 909_091);
        let (d, t) = task_deltas(&[150_000, 150_000, 150_000], 150_000, &[20, 10, 0], 20, 16);
        assert_eq!(d, vec![800, 0, -800]);
        assert_eq!(t, 0);
        // Everyone solves everything: agents gain, the task loses what they gained.
        let (d, t) = task_deltas(&[150_000, 160_000], 150_000, &[20, 20], 20, 16);
        assert!(d[0] > d[1] && d[1] > 0);
        assert_eq!(t, -(d[0] + d[1]));
        // A single agent can be rated: no field needed.
        let (d, _) = task_deltas(&[150_000], 170_000, &[15], 20, 16);
        assert!(d[0] > 0);
    }

    #[test]
    fn lmsr_prices_buys_and_bounded_loss() {
        let subsidy = 10 * NEAR;
        let b = lmsr_b(subsidy, 4);
        let mut q = vec![0u128; 4];
        assert_eq!(lmsr_prices_ppm(&q, b), vec![250_000; 4]);
        // Cost of the empty market is b ln n, at most the subsidy.
        assert!(lmsr_cost(&q, b) <= subsidy as f64);
        let mut spent = 0u128;
        for (i, amount) in [(0usize, 3 * NEAR), (1, NEAR), (0, 5 * NEAR), (2, NEAR / 100), (0, 40 * NEAR)] {
            let before = lmsr_prices_ppm(&q, b)[i];
            let d = lmsr_buy(&q, b, i, amount);
            // A buy costs exactly what the cost function says (up to the safety margin).
            let mut q2 = q.clone();
            q2[i] += d;
            let paid = lmsr_cost(&q2, b) - lmsr_cost(&q, b);
            assert!(paid <= amount as f64 && paid > amount as f64 * 0.999_999, "{paid} vs {amount}");
            // Each share costs less than a unit, and the price moves up.
            assert!(d > amount);
            q = q2;
            spent += amount;
            assert!(lmsr_prices_ppm(&q, b)[i] > before);
        }
        // Whoever wins, the maker can pay every share from subsidy + collected.
        for w in 0..4 {
            assert!(q[w] <= subsidy + spent, "outcome {w}: {} > {}", q[w], subsidy + spent);
        }
        let p = lmsr_prices_ppm(&q, b);
        assert!((p.iter().sum::<u64>() as i64 - 1_000_000).abs() <= 2);
        // No liquidity, no shares.
        assert_eq!(lmsr_buy(&[0, 0], 0, 0, NEAR), 0);
    }

    #[test]
    fn payout_matches_the_spec_example() {
        let total = 100 * NEAR;
        let f = fee(total, 200);
        assert_eq!(f, 2 * NEAR);
        let net = total - f;
        // 1 NEAR on a 40 NEAR winning pool returns 2.45 NEAR.
        assert_eq!(payout(NEAR, 40 * NEAR, net), 2_450_000_000_000_000_000_000_000);
        // All winning backers together never get more than net.
        let a = payout(13 * NEAR, 40 * NEAR, net);
        let b = payout(27 * NEAR, 40 * NEAR, net);
        assert!(a + b <= net);
    }

    #[test]
    fn message_format() {
        let m = settlement_message(7, 20, &[("a.testnet", 20), ("b.testnet", 3)]);
        assert_eq!(m, "benchmarket:v1:7:20:a.testnet=20,b.testnet=3");
        assert_eq!(signed_message("benchmarket:job:v1", 4, 9, &[("x.near", 9)]), "benchmarket:job:v1:4:9:x.near=9");
    }
}
