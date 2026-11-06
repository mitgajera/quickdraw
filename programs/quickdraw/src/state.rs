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

    #[test]
    fn keeps_the_latest_price_when_updates_arrive_out_of_order() {
        let mut c = empty();
        c.record(110, 1_001);
        c.record(100, 1_000);
        assert_eq!(c.last_price, 110);
        assert_eq!(c.range_at(1_000), Some((100, 100)));
    }
}
