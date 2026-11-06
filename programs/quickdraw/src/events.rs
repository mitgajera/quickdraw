use anchor_lang::prelude::*;

/// A tap was placed. `price` and `sigma` are the inputs the on-chain odds were computed from.
#[event]
pub struct TapPlaced {
    pub player: Pubkey,
    pub market: Pubkey,
    pub id: u32,
    pub slot: u8,
    pub lo: i64,
    pub hi: i64,
    pub start: i64,
    pub end: i64,
    pub stake: u64,
    pub mult_bps: u32,
    pub price: i64,
    pub publish_time: i64,
    pub sigma: u64,
}

/// A tap was settled. `low`/`high` are the price range recorded during the window: the evidence
/// anyone can re-check against the candle ring.
#[event]
pub struct TapSettled {
    pub player: Pubkey,
    pub market: Pubkey,
    pub id: u32,
    /// 1 = win, 2 = lose, 3 = void (refunded).
    pub outcome: u8,
    pub lo: i64,
    pub hi: i64,
    pub start: i64,
    pub end: i64,
    pub stake: u64,
    pub payout: u64,
    pub low: i64,
    pub high: i64,
}
