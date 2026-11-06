use anchor_lang::prelude::*;

/// Seconds of per-second high/low history kept on-chain. Taps settle within this window.
pub const CANDLE_SLOTS: usize = 256;

/// One tradable asset (SOL/USD, BTC/USD, ...), keyed by its oracle price account.
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub candles: Pubkey,
    pub bump: u8,
}

/// Ring buffer of per-second price ranges, written on the ER by `record_tick`.
/// Slot `sec % CANDLE_SLOTS` holds the high and low the oracle published during `sec`.
#[account(zero_copy)]
#[repr(C)]
pub struct Candles {
    /// Market key as raw bytes: `Pubkey` is not `Pod` in this dependency set.
    pub market: [u8; 32],
    pub last_price: i64,
    pub last_publish_time: i64,
    pub ticks: u64,
    pub secs: [i64; CANDLE_SLOTS],
    pub highs: [i64; CANDLE_SLOTS],
    pub lows: [i64; CANDLE_SLOTS],
}

impl Candles {
    pub const LEN: usize = 32 + 8 + 8 + 8 + CANDLE_SLOTS * 8 * 3;

    /// Folds one oracle observation into the ring. Re-sending the same publish second just
    /// widens that second's range, so the crank can be called as often as it likes.
    pub fn record(&mut self, price: i64, publish_time: i64) {
        let idx = (publish_time.rem_euclid(CANDLE_SLOTS as i64)) as usize;
        if self.secs[idx] != publish_time {
            self.secs[idx] = publish_time;
            self.highs[idx] = price;
            self.lows[idx] = price;
        } else {
            self.highs[idx] = self.highs[idx].max(price);
            self.lows[idx] = self.lows[idx].min(price);
        }
        if publish_time >= self.last_publish_time {
            self.last_price = price;
            self.last_publish_time = publish_time;
        }
        self.ticks = self.ticks.wrapping_add(1);
    }

    /// The (high, low) recorded for a given second, if that second is still in the ring.
    pub fn range_at(&self, sec: i64) -> Option<(i64, i64)> {
        let idx = (sec.rem_euclid(CANDLE_SLOTS as i64)) as usize;
        (self.secs[idx] == sec).then(|| (self.highs[idx], self.lows[idx]))
    }

    /// Per-second volatility (price units per sqrt(second)) from the moves between the midpoints
    /// of recorded seconds in `(now - window, now]`. `None` with fewer than `MIN_VOL_SAMPLES` moves.
    pub fn sigma(&self, now: i64, window: i64) -> Option<f64> {
        let mut prev: Option<(i64, f64)> = None;
        let (mut sum, mut moves) = (0.0f64, 0u32);
        for sec in (now - window + 1)..=now {
            if let Some((high, low)) = self.range_at(sec) {
                let mid = (high as f64 + low as f64) / 2.0;
                if let Some((prev_sec, prev_mid)) = prev {
                    sum += (mid - prev_mid).powi(2) / (sec - prev_sec) as f64;
                    moves += 1;
                }
                prev = Some((sec, mid));
            }
        }
        (moves >= MIN_VOL_SAMPLES).then(|| (sum / moves as f64).sqrt())
    }

    /// Decides a tap on the band `[lo, hi]` for the seconds `[start, end)`, given that the ring holds
    /// data up to second `now`. Prices move continuously, so every price between the lowest low and
    /// the highest high seen in the window was traded: the box wins if that range meets the band.
    /// Wins are final as soon as they happen; a loss needs the whole window to have passed.
    pub fn judge(&self, lo: i64, hi: i64, start: i64, end: i64, now: i64) -> Outcome {
        match self.window_range(start, end.min(now + 1)) {
            Some((low, high)) if high >= lo && low <= hi => Outcome::Win,
            _ if now < end => Outcome::Pending,
            Some(_) => Outcome::Lose,
            None => Outcome::Void,
        }
    }

    /// Lowest low and highest high recorded for the seconds `[start, end)`.
    pub fn window_range(&self, start: i64, end: i64) -> Option<(i64, i64)> {
        (start..end)
            .filter_map(|sec| self.range_at(sec))
            .fold(None, |acc, (high, low)| match acc {
                None => Some((low, high)),
                Some((min, max)) => Some((min.min(low), max.max(high))),
            })
    }
}

/// Moves needed before the candle ring's volatility estimate is trusted over the market floor.
pub const MIN_VOL_SAMPLES: u32 = 5;

/// How a tap resolves against the recorded candles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The window is still open and the price has not touched the box yet.
    Pending,
    Win,
    Lose,
    /// No price data was recorded for the window: the stake is refunded.
    Void,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> Candles {
        Candles {
            highs: [0; CANDLE_SLOTS],
            last_price: 0,
            last_publish_time: 0,
            lows: [0; CANDLE_SLOTS],
            market: [0; 32],
            secs: [0; CANDLE_SLOTS],
            ticks: 0,
        }
    }

    #[test]
    fn tracks_high_and_low_within_a_second() {
        let mut c = empty();
        c.record(100, 1_000);
        c.record(104, 1_000);
        c.record(97, 1_000);
        assert_eq!(c.range_at(1_000), Some((104, 97)));
        assert_eq!(c.last_price, 97);
        assert_eq!(c.ticks, 3);
    }

    #[test]
    fn overwrites_a_slot_when_the_ring_wraps() {
        let mut c = empty();
        c.record(100, 1_000);
        c.record(200, 1_000 + CANDLE_SLOTS as i64);
        assert_eq!(c.range_at(1_000), None);
        assert_eq!(c.range_at(1_000 + CANDLE_SLOTS as i64), Some((200, 200)));
    }

    fn walk(c: &mut Candles, from: i64, prices: &[(i64, i64)]) {
        for (i, (high, low)) in prices.iter().enumerate() {
            c.record(*high, from + i as i64);
            c.record(*low, from + i as i64);
        }
    }

    #[test]
    fn judges_wins_losses_and_voids() {
        let mut c = empty();
        // seconds 100..=104 trade between 1_000 and 1_030
        walk(
            &mut c,
            100,
            &[
                (1_010, 1_000),
                (1_020, 1_005),
                (1_030, 1_015),
                (1_025, 1_012),
                (1_018, 1_010),
            ],
        );
        // band touched by the second-102 high: win as soon as that second is recorded
        assert_eq!(c.judge(1_028, 1_040, 101, 104, 102), Outcome::Win);
        // not touched yet and the window is still open
        assert_eq!(c.judge(1_028, 1_040, 101, 104, 101), Outcome::Pending);
        // never touched once the window passed
        assert_eq!(c.judge(1_031, 1_040, 101, 104, 104), Outcome::Lose);
        // price crossed the band between two recorded seconds (continuity)
        let mut gap = empty();
        walk(&mut gap, 200, &[(1_000, 1_000)]);
        walk(&mut gap, 202, &[(1_100, 1_100)]);
        assert_eq!(gap.judge(1_040, 1_060, 200, 203, 203), Outcome::Win);
        // no data for the window at all
        assert_eq!(c.judge(1_000, 1_100, 150, 154, 160), Outcome::Void);
    }

    #[test]
    fn estimates_volatility_from_recent_seconds() {
        let mut c = empty();
        assert_eq!(c.sigma(110, 30), None);
        // midpoints alternate by 10 each second -> sigma = 10
        for s in 0..12 {
            let p = if s % 2 == 0 { 1_000 } else { 1_010 };
            c.record(p, 100 + s);
        }
        let sigma = c.sigma(111, 30).unwrap();
        assert!((sigma - 10.0).abs() < 1e-9);
    }

    #[test]
    fn keeps_the_latest_price_when_updates_arrive_out_of_order() {
        let mut c = empty();
        c.record(110, 1_001);
        c.record(100, 1_000);
        assert_eq!(c.last_price, 110);
        assert_eq!(c.range_at(1_000), Some((100, 100)));
    }
}
