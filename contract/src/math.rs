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

/// Expected score `p_i = w * market_i + (1 - w) * prior_i`, `w = min(1, total / min_pool)`.
pub fn blended_odds_ppm(pools: &[u128], ratings_centi: &[i64], min_pool: u128) -> Vec<u64> {
    let market = market_odds_ppm(pools);
    let prior = prior_odds_ppm(ratings_centi);
    let total: u128 = pools.iter().sum();
    let w_ppm: u128 = if min_pool == 0 || total >= min_pool {
        PPM as u128
    } else {
        total * PPM as u128 / min_pool
    };
    market
        .iter()
        .zip(prior.iter())
        .map(|(m, p)| {
            let v = (w_ppm * *m as u128 + (PPM as u128 - w_ppm) * *p as u128) / PPM as u128;
            v as u64
        })
        .collect()
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

/// Index of the winner: highest score, then earliest answer, then smallest account id.
/// Returns `None` when the highest score is 0.
pub fn pick_winner(scores: &[u32], answered_at_ms: &[Option<u64>], ids: &[&str]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for i in 0..scores.len() {
        if scores[i] == 0 {
            continue;
        }
        best = match best {
            None => Some(i),
            Some(b) => {
                let key_i = (scores[i], std::cmp::Reverse(answered_at_ms[i].unwrap_or(u64::MAX)), std::cmp::Reverse(ids[i]));
                let key_b = (scores[b], std::cmp::Reverse(answered_at_ms[b].unwrap_or(u64::MAX)), std::cmp::Reverse(ids[b]));
                if key_i > key_b {
                    Some(i)
                } else {
                    Some(b)
                }
            }
        };
    }
    best
}

/// Market fee for a pool.
pub fn fee(total: u128, fee_bps: u16) -> u128 {
    total * fee_bps as u128 / 10_000
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

/// Message the verifiers sign (before hashing).
pub fn settlement_message(round_id: u64, total_tests: u32, scores: &[(&str, u32)]) -> String {
    let body: Vec<String> = scores.iter().map(|(a, s)| format!("{a}={s}")).collect();
    format!("agent-league:v1:{round_id}:{total_tests}:{}", body.join(","))
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
    fn winner_tie_breaks() {
        let ids = ["b.near", "a.near", "c.near"];
        // Highest score wins.
        assert_eq!(pick_winner(&[10, 12, 3], &[Some(1), Some(2), Some(3)], &ids), Some(1));
        // Same score: earlier answer.
        assert_eq!(pick_winner(&[12, 12, 3], &[Some(1), Some(2), Some(3)], &ids), Some(0));
        // Same score and time: smaller account id.
        assert_eq!(pick_winner(&[12, 12, 3], &[Some(5), Some(5), Some(3)], &ids), Some(1));
        // All zero: no winner.
        assert_eq!(pick_winner(&[0, 0, 0], &[None, None, None], &ids), None);
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
        assert_eq!(m, "agent-league:v1:7:20:a.testnet=20,b.testnet=3");
    }
}
