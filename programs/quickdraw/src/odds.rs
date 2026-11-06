//! On-chain odds for a box: the probability that the price trades inside a price band during the
//! box's column, for a driftless random walk with per-second volatility `sigma`.
//!
//! The building block is the reflection principle, `P(touch within T) = 2 * (1 - Phi(d / (sigma *
//! sqrt(T))))` for a band `d` away. A future column only counts touches inside its own window, so
//! `window_touch_probability` averages that formula over where the price may be when the window
//! opens. (Pricing "touch by the end of the column" instead overstated near boxes about twofold on
//! live data, paying players roughly half of fair.)

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

/// 12-point Gauss-Legendre rule on [-1, 1] (positive half; the rule is symmetric).
const GL_X: [f64; 6] = [
    0.125_233_408_511_468_94,
    0.367_831_498_998_180_2,
    0.587_317_954_286_617_5,
    0.769_902_674_194_304_7,
    0.904_117_256_370_474_8,
    0.981_560_634_246_719_2,
];
const GL_W: [f64; 6] = [
    0.249_147_045_813_402_88,
    0.233_492_536_538_354_58,
    0.203_167_426_723_065_84,
    0.160_078_328_543_346_33,
    0.106_939_325_995_318_18,
    0.047_175_336_386_508_46,
];
const INV_SQRT_2PI: f64 = 0.398_942_280_401_432_7;
/// Normal tail beyond which the opening price is ignored.
const Z_MAX: f64 = 7.0;
/// Distance (in window standard deviations) beyond which a touch within the window is ignored.
const REACH: f64 = 6.0;

/// Chance of touching a band `z_distance` window-sigmas away within the window (reflection).
fn touch_within(z_distance: f64) -> f64 {
    if z_distance <= 0.0 {
        1.0
    } else {
        erfc(z_distance / core::f64::consts::SQRT_2)
    }
}

/// `∫_a^b φ(z) · touch_within(dist(z)) dz` by Gauss-Legendre; the integrand is smooth on [a, b].
fn side_integral(a: f64, b: f64, dist: impl Fn(f64) -> f64) -> f64 {
    if b <= a {
        return 0.0;
    }
    let (mid, half) = ((a + b) / 2.0, (b - a) / 2.0);
    let mut sum = 0.0;
    for i in 0..GL_X.len() {
        for z in [mid - half * GL_X[i], mid + half * GL_X[i]] {
            sum += GL_W[i] * INV_SQRT_2PI * (-z * z / 2.0).exp() * touch_within(dist(z));
        }
    }
    sum * half
}

/// Probability that the price trades inside `[lo, hi]` at some moment of a window that opens in
/// `lead` seconds and lasts `window` seconds — exactly what a tap on a future column wins on.
///
/// Live oracle prices move in steps and then hold: over several seconds they spread out by their
/// full volatility (`sigma_drift`), but inside one short window they wander much less
/// (`sigma_window`). So the price when the window opens is normal around today's price with
/// `sigma_drift * sqrt(lead)`, and from there the reflection principle with `sigma_window` gives
/// the chance of reaching the band within the window. The integral over the opening price is
/// split at the band edges (the part inside is exact) and each smooth side uses 12-point
/// Gauss-Legendre: worst-case relative error about 0.3%.
pub fn window_touch_probability(
    price: i64,
    lo: i64,
    hi: i64,
    lead: f64,
    window: f64,
    sigma_drift: f64,
    sigma_window: f64,
) -> f64 {
    if sigma_drift <= 0.0 || sigma_window <= 0.0 || window <= 0.0 {
        return if (lo..=hi).contains(&price) { 1.0 } else { 0.0 };
    }
    if lead <= 0.0 {
        return touch_probability(price, lo, hi, window, sigma_window);
    }
    let s1 = sigma_drift * lead.sqrt();
    let ratio = s1 / (sigma_window * window.sqrt()); // opening-price sigma in window-sigma units
    let zl = (lo - price) as f64 / s1;
    let zh = (hi - price) as f64 / s1;
    let inside = (norm_cdf(zh) - norm_cdf(zl)).max(0.0);
    let reach = REACH / ratio;
    // opened below the band: distance to `lo`; opened above: distance to `hi` (in window sigmas)
    let below = side_integral((zl - reach).max(-Z_MAX), zl.min(Z_MAX), |z| {
        (zl - z) * ratio
    });
    let above = side_integral(zh.max(-Z_MAX), (zh + reach).min(Z_MAX), |z| {
        (z - zh) * ratio
    });
    (inside + below + above).clamp(0.0, 1.0)
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
    fn window_probability_matches_dense_integration() {
        // references from a 200k-point integration of the same model
        let cases: [(i64, i64, i64, f64, f64, f64, f64); 5] = [
            (0, 200, 300, 4.0, 4.0, 100.0, 0.401_162_26),
            (0, 0, 100, 4.0, 4.0, 100.0, 0.619_074_13),
            (-30, 0, 100, 1.0, 4.0, 100.0, 0.775_868_11),
            (0, 1_000, 1_100, 8.0, 4.0, 100.0, 0.003_827_99),
            (0, -300, -200, 2.0, 4.0, 100.0, 0.392_145_75),
        ];
        for (price, lo, hi, lead, window, sigma, want) in cases {
            let got = window_touch_probability(price, lo, hi, lead, window, sigma, sigma);
            assert!(
                (got - want).abs() / want < 0.005,
                "{lo}..{hi} lead {lead}: {got} vs {want}"
            );
        }
    }

    #[test]
    fn separate_drift_and_window_volatility_match_dense_integration() {
        let cases: [(i64, i64, i64, f64, f64); 3] = [
            (0, 200, 300, 2.0, 0.281_980_04),
            (0, 0, 100, 4.0, 0.313_720_61),
            (0, -300, -200, 2.0, 0.346_055_52),
        ];
        let leads = [4.0, 4.0, 2.0];
        for ((price, lo, hi, _, want), lead) in cases.into_iter().zip(leads) {
            let got = window_touch_probability(price, lo, hi, lead, 4.0, 250.0, 100.0);
            assert!(
                (got - want).abs() / want < 0.005,
                "{lo}..{hi}: {got} vs {want}"
            );
        }
    }

    #[test]
    fn a_window_is_less_likely_than_touching_by_its_end() {
        let by_end = touch_probability(0, 200, 300, 8.0, 100.0);
        let in_window = window_touch_probability(0, 200, 300, 4.0, 4.0, 100.0, 100.0);
        assert!(in_window < by_end);
        // the band holding today's price is no longer a sure thing a few seconds out
        let own_band = window_touch_probability(50, 0, 100, 4.0, 4.0, 100.0, 100.0);
        assert!(own_band < 1.0 && own_band > 0.5);
    }

    #[test]
    fn multiplier_applies_the_edge() {
        assert_eq!(multiplier_bps(0.5, 700), Some(18_600));
        assert_eq!(multiplier_bps(1.0, 700), Some(9_300));
        assert_eq!(multiplier_bps(0.0, 700), None);
        assert_eq!(multiplier_bps(0.5, 10_000), None);
    }
}
