use anchor_lang::prelude::*;

use crate::error::QuickdrawError;
use crate::events::TapPlaced;
use crate::odds::{multiplier_bps, window_touch_probability, ONE_X_BPS};
use crate::oracle::read_oracle_price;
use crate::state::{Book, Candles, Market, Player, TapSlot};
use crate::{
    BOOK_SEED, DRIFT_VOL_SCALE, MARKET_SEED, MAX_AHEAD_SECS, PLAYER_SEED, TAP_LOCK_SECS,
    TAP_ORACLE_MAX_AGE, VOL_WINDOW_SECS, WINDOW_VOL_SCALE,
};

/// A priced box: its band, its column window and the multiplier the house offers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quote {
    pub lo: i64,
    pub hi: i64,
    pub start: i64,
    pub end: i64,
    pub mult_bps: u32,
    pub payout: u64,
    pub sigma: f64,
}

/// Prices the box at `band_index` x `column` from the oracle price at `now` (its publish time).
/// Rows are `[i * band, (i + 1) * band)` in price units; columns are `[k * col, (k + 1) * col)`
/// in unix seconds. Volatility comes from the recorded candles, floored by the market.
#[allow(clippy::too_many_arguments)]
pub fn quote(
    market: &Market,
    book: &Book,
    candles: &Candles,
    price: i64,
    now: i64,
    band_index: i64,
    column: i64,
    stake: u64,
) -> Result<Quote> {
    let band = i64::try_from(market.band).map_err(|_| QuickdrawError::Overflow)?;
    let lo = band_index
        .checked_mul(band)
        .ok_or(QuickdrawError::Overflow)?;
    let hi = lo.checked_add(band - 1).ok_or(QuickdrawError::Overflow)?;
    let col = market.col_secs as i64;
    let start = column.checked_mul(col).ok_or(QuickdrawError::Overflow)?;
    let end = start + col;
    let lead = start - now;
    require!(
        (TAP_LOCK_SECS..=MAX_AHEAD_SECS).contains(&lead),
        QuickdrawError::ColumnClosed
    );

    let sigma = candles
        .sigma(now, VOL_WINDOW_SECS)
        .unwrap_or(0.0)
        .max(market.sigma_floor as f64);
    let probability = window_touch_probability(
        price,
        lo,
        hi,
        lead as f64,
        col as f64,
        sigma * DRIFT_VOL_SCALE,
        sigma * WINDOW_VOL_SCALE,
    );
    let mult_bps = multiplier_bps(probability, book.edge_bps)
        .filter(|m| (book.min_mult_bps..=book.max_mult_bps).contains(m))
        .ok_or(QuickdrawError::MultiplierOutOfRange)?;
    let payout = u64::try_from(stake as u128 * mult_bps as u128 / ONE_X_BPS as u128)
        .map_err(|_| QuickdrawError::Overflow)?;
    require!(
        payout - stake <= book.max_profit,
        QuickdrawError::ProfitTooLarge
    );
    Ok(Quote {
        lo,
        hi,
        start,
        end,
        mult_bps,
        payout,
        sigma,
    })
}

/// Whether the pool, after taking `stake`, can still cover every open payout plus this one.
pub fn has_capacity(book: &Book, stake: u64, payout: u64) -> bool {
    let liquidity = book.liquidity as u128 + stake as u128;
    let exposure = book.exposure as u128 + payout as u128;
    exposure * ONE_X_BPS as u128 <= liquidity * book.max_exposure_bps as u128
}

/// Taps a box: prices it on-chain, checks slippage and house limits, and locks the stake (ER).
pub fn place_tap_handler(
    mut ctx: Context<PlaceTap>,
    band_index: i64,
    column: i64,
    stake: u64,
    min_mult_bps: u32,
) -> Result<()> {
    require!(stake > 0, QuickdrawError::ZeroAmount);
    let clock = Clock::get()?.unix_timestamp;
    let accounts = &mut ctx.accounts;
    require!(
        accounts.player.can_tap(&accounts.signer.key(), clock),
        QuickdrawError::Unauthorized
    );
    let reading = read_oracle_price(&accounts.oracle)?;
    require!(
        clock - reading.publish_time <= TAP_ORACLE_MAX_AGE,
        QuickdrawError::StaleOracle
    );
    let q = {
        let candles = accounts.candles.load()?;
        quote(
            &accounts.market,
            &accounts.book,
            &candles,
            reading.price,
            reading.publish_time,
            band_index,
            column,
            stake,
        )?
    };
    require!(q.mult_bps >= min_mult_bps, QuickdrawError::Slippage);
    require!(
        has_capacity(&accounts.book, stake, q.payout),
        QuickdrawError::ExposureLimit
    );

    let player = &mut accounts.player;
    let slot = player.free_slot().ok_or(QuickdrawError::TooManyTaps)?;
    player.balance = player
        .balance
        .checked_sub(stake)
        .ok_or(QuickdrawError::InsufficientBalance)?;
    let id = player.next_id;
    player.next_id = id.wrapping_add(1);
    player.taps_placed = player.taps_placed.saturating_add(1);
    player.taps[slot] = TapSlot {
        market: accounts.market.key(),
        lo: q.lo,
        hi: q.hi,
        start: q.start,
        end: q.end,
        stake,
        mult_bps: q.mult_bps,
        id,
        open: true,
    };

    let book = &mut accounts.book;
    book.liquidity += stake;
    book.exposure += q.payout;
    book.volume = book.volume.saturating_add(stake);
    book.taps = book.taps.saturating_add(1);

    emit!(TapPlaced {
        player: player.key(),
        market: accounts.market.key(),
        id,
        slot: slot as u8,
        lo: q.lo,
        hi: q.hi,
        start: q.start,
        end: q.end,
        stake,
        mult_bps: q.mult_bps,
        price: reading.price,
        publish_time: reading.publish_time,
        sigma: q.sigma as u64,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct PlaceTap<'info> {
    /// The player's owner or their active session key.
    pub signer: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[account(mut, seeds = [BOOK_SEED], bump = book.bump)]
    pub book: Account<'info, Book>,
    #[account(
        seeds = [MARKET_SEED, market.oracle.as_ref()],
        bump = market.bump,
        constraint = market.authority == book.authority @ QuickdrawError::Unauthorized
    )]
    pub market: Account<'info, Market>,
    #[account(address = market.candles)]
    pub candles: AccountLoader<'info, Candles>,
    /// CHECK: this market's oracle feed; owner and layout are verified when it is read.
    #[account(address = market.oracle @ QuickdrawError::WrongOracle)]
    pub oracle: UncheckedAccount<'info>,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::state::CANDLE_SLOTS;

    pub fn market() -> Market {
        Market {
            authority: Pubkey::default(),
            oracle: Pubkey::default(),
            candles: Pubkey::default(),
            symbol: *b"SOL\0\0\0\0\0",
            band: 4_000_000, // $0.04
            col_secs: 4,
            sigma_floor: 1_800_000, // $0.018 per sqrt(second)
            bump: 0,
        }
    }

    pub fn book() -> Book {
        Book {
            authority: Pubkey::default(),
            mint: Pubkey::default(),
            liquidity: 10_000_000_000,
            total_shares: 10_000_000_000,
            exposure: 0,
            edge_bps: 700,
            min_mult_bps: 11_000,
            max_mult_bps: 250_000,
            max_exposure_bps: 5_000,
            max_profit: 500_000_000,
            volume: 0,
            taps: 0,
            bump: 0,
        }
    }

    pub fn candles() -> Candles {
        Candles {
            market: [0; 32],
            last_price: 0,
            last_publish_time: 0,
            ticks: 0,
            secs: [0; CANDLE_SLOTS],
            highs: [0; CANDLE_SLOTS],
            lows: [0; CANDLE_SLOTS],
        }
    }

    const PRICE: i64 = 8_998_000_000; // $89.98, inside band 2249 ($89.96..$90.00)
    const NOW: i64 = 1_000_001; // column 250_000 starts at 1_000_000, next at 1_000_004

    #[test]
    fn prices_a_box_two_bands_above() {
        let q = quote(
            &market(),
            &book(),
            &candles(),
            PRICE,
            NOW,
            2251,
            250_001,
            5_000_000,
        )
        .unwrap();
        assert_eq!((q.lo, q.hi), (9_004_000_000, 9_007_999_999));
        assert_eq!((q.start, q.end), (1_000_004, 1_000_008));
        assert!(
            q.mult_bps > 11_000 && q.mult_bps < 250_000,
            "{}",
            q.mult_bps
        );
        assert_eq!(q.payout, 5_000_000 * q.mult_bps as u64 / 10_000);
    }

    #[test]
    fn far_boxes_pay_more_and_the_current_band_pays_least() {
        // one and two bands above, window opening in 7s: ~3.7x and ~4.7x (dense-integration refs)
        let near = quote(&market(), &book(), &candles(), PRICE, NOW, 2251, 250_002, 1).unwrap();
        let far = quote(&market(), &book(), &candles(), PRICE, NOW, 2252, 250_002, 1).unwrap();
        assert!(far.mult_bps > near.mult_bps);
        assert!(
            (34_500..38_500).contains(&near.mult_bps),
            "{}",
            near.mult_bps
        );
        assert!((45_000..50_000).contains(&far.mult_bps), "{}", far.mult_bps);
        // seven bands above in the next column is beyond the 25x cap: not offered
        assert!(quote(&market(), &book(), &candles(), PRICE, NOW, 2256, 250_001, 1).is_err());
        // the band holding today's price is far from certain three seconds out: ~2.1x
        let inside = quote(&market(), &book(), &candles(), PRICE, NOW, 2249, 250_001, 1).unwrap();
        assert!(
            (19_500..21_500).contains(&inside.mult_bps),
            "{}",
            inside.mult_bps
        );
    }

    #[test]
    fn locked_and_distant_columns_are_rejected() {
        // the column already running, and one more than two minutes ahead
        assert!(quote(&market(), &book(), &candles(), PRICE, NOW, 2251, 250_000, 1).is_err());
        assert!(quote(&market(), &book(), &candles(), PRICE, NOW, 2251, 250_040, 1).is_err());
    }

    #[test]
    fn caps_profit_per_tap_and_total_exposure() {
        let mut b = book();
        b.max_profit = 1_000;
        let capped = quote(
            &market(),
            &b,
            &candles(),
            PRICE,
            NOW,
            2251,
            250_001,
            1_000_000,
        );
        assert_eq!(capped.unwrap_err(), QuickdrawError::ProfitTooLarge.into());
        let b = book();
        assert!(has_capacity(&b, 1_000, 4_000_000_000));
        assert!(!has_capacity(&b, 1_000, 6_000_000_000));
    }
}
