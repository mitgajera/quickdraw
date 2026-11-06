//! On-chain odds for a box: the probability that the price touches a price band before the box's
//! column closes, priced with the reflection principle for a driftless random walk:
//! `P(touch) = 2 * (1 - Phi(d / (sigma * sqrt(T))))`, where `d` is the distance from the current
//! price to the nearest band edge and `T` the seconds left until the column closes.
//!
//! Using "touch by the end of the column" (not "touch inside the column window") slightly
//! overstates the win chance for later columns, so multipliers err in the house's favour.

/// Basis points that mean a 1.0x multiplier.
pub const ONE_X_BPS: u32 = 10_000;

/// Complementary error function (Numerical Recipes `erfcc`, |relative error| < 1.2e-7).
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.5 * z);
    let poly = -z * z - 1.265_512_23
        + t * (1.000_023_68
            + t * (0.374_091_96
                + t * (0.096_784_18
                    + t * (-0.186_288_06
                        + t * (0.278_868_07
                            + t * (-1.135_203_98
                                + t * (1.488_515_87 + t * (-0.822_152_23 + t * 0.170_872_77))))))));
    let r = t * poly.exp();
    if x >= 0.0 {
        r
    } else {
        2.0 - r
    }
}

/// Standard normal CDF.
pub fn norm_cdf(z: f64) -> f64 {
    0.5 * erfc(-z / core::f64::consts::SQRT_2)
}

/// Probability that a price starting at `price` touches `[lo, hi]` within `secs` seconds, given a
/// per-second volatility `sigma` in the same units as the price.
pub fn touch_probability(price: i64, lo: i64, hi: i64, secs: f64, sigma: f64) -> f64 {
    let distance = if price < lo {
        lo - price
    } else if price > hi {
        price - hi
    } else {
        return 1.0;
    };
    if sigma <= 0.0 || secs <= 0.0 {
        return 0.0;
    }
    let z = distance as f64 / (sigma * secs.sqrt());
    (2.0 * (1.0 - norm_cdf(z))).clamp(0.0, 1.0)
}

/// Fair multiplier minus the house edge, in basis points. `None` when the box is unpriceable.
pub fn multiplier_bps(probability: f64, edge_bps: u16) -> Option<u32> {
    if probability <= 0.0 || edge_bps as u32 >= ONE_X_BPS {
        return None;
    }
    let bps = (ONE_X_BPS - edge_bps as u32) as f64 / probability;
    (bps.is_finite() && bps < u32::MAX as f64).then_some(bps as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    #[test]
    fn normal_cdf_matches_known_values() {
        assert!(close(norm_cdf(0.0), 0.5, 1e-7));
        assert!(close(norm_cdf(1.0), 0.841_344_75, 1e-6));
        assert!(close(norm_cdf(-1.96), 0.024_997_9, 1e-6));
        assert!(close(norm_cdf(3.0), 0.998_650_1, 1e-6));
    }

    #[test]
    fn inside_the_band_is_certain() {
        assert_eq!(touch_probability(100, 90, 110, 4.0, 1.0), 1.0);
        assert_eq!(touch_probability(90, 90, 110, 4.0, 1.0), 1.0);
    }

    #[test]
    fn farther_and_sooner_boxes_are_less_likely() {
        let sigma = 1_800_000.0; // $0.018 per sqrt(second), price units are 1e-8 USD
        let price = 9_000_000_000;
        let near = touch_probability(price, price + 2_000_000, price + 6_000_000, 8.0, sigma);
        let far = touch_probability(price, price + 10_000_000, price + 14_000_000, 8.0, sigma);
        let far_later =
            touch_probability(price, price + 10_000_000, price + 14_000_000, 16.0, sigma);
        assert!(near > far && far_later > far);
        // one band below is symmetric with one band above
        let below = touch_probability(price, price - 6_000_000, price - 2_000_000, 8.0, sigma);
        assert!(close(near, below, 1e-12));
    }

    #[test]
    fn touch_probability_is_twice_the_tail() {
        // d / (sigma * sqrt(T)) = 1  ->  2 * (1 - Phi(1)) = 0.3173
        let p = touch_probability(0, 200, 300, 4.0, 100.0);
        assert!(close(p, 0.317_310_5, 1e-6));
    }

    #[test]
    fn multiplier_applies_the_edge() {
        assert_eq!(multiplier_bps(0.5, 700), Some(18_600));
        assert_eq!(multiplier_bps(1.0, 700), Some(9_300));
        assert_eq!(multiplier_bps(0.0, 700), None);
        assert_eq!(multiplier_bps(0.5, 10_000), None);
    }
}
