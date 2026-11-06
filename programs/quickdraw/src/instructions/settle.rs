use anchor_lang::prelude::*;

use crate::error::QuickdrawError;
use crate::events::TapSettled;
use crate::state::{Book, Candles, Market, Outcome, Player, TapSlot, MAX_TAPS};
use crate::{BOOK_SEED, MARKET_SEED, PLAYER_SEED, SETTLE_TIMEOUT_SECS};

/// Moves money for a decided tap and closes it. Returns what was paid back to the player.
pub fn apply_outcome(
    player: &mut Player,
    book: &mut Book,
    slot: usize,
    outcome: Outcome,
) -> Result<u64> {
    let tap: TapSlot = player.taps[slot];
    require!(tap.open, QuickdrawError::NoOpenTap);
    let payout = tap.payout();
    let paid = match outcome {
        Outcome::Pending => return err!(QuickdrawError::SettleTooEarly),
        Outcome::Win => {
            player.wins = player.wins.saturating_add(1);
            player.streak = player.streak.saturating_add(1);
            player.best_streak = player.best_streak.max(player.streak);
            player.pnl = player.pnl.saturating_add((payout - tap.stake) as i64);
            payout
        }
        Outcome::Lose => {
            player.streak = 0;
            player.pnl = player.pnl.saturating_sub(tap.stake as i64);
            0
        }
        Outcome::Void => tap.stake,
    };
    book.liquidity = book
        .liquidity
        .checked_sub(paid)
        .ok_or(QuickdrawError::Overflow)?;
    book.exposure = book
        .exposure
        .checked_sub(payout)
        .ok_or(QuickdrawError::Overflow)?;
    player.balance = player
        .balance
        .checked_add(paid)
        .ok_or(QuickdrawError::Overflow)?;
    player.taps[slot].open = false;
    Ok(paid)
}

/// Settles every decidable tap this player holds in this market against the candle ring (ER,
/// permissionless: the keeper or the player's own app calls it). Wins pay the moment the price
/// touches the box; losses after the column closes. If the ring has no data for a window once
/// `SETTLE_TIMEOUT_SECS` passed, the stake is refunded.
pub fn settle_handler(ctx: Context<Settle>) -> Result<()> {
    let clock = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let player_key = ctx.accounts.player.key();
    let candles = ctx.accounts.candles.load()?;
    let (player, book) = (&mut ctx.accounts.player, &mut ctx.accounts.book);

    let mut settled = 0;
    for slot in 0..MAX_TAPS {
        let tap = player.taps[slot];
        if !tap.open || tap.market != market_key {
            continue;
        }
        // the ring is complete up to its last publish second; after the timeout, close the window
        let mut now = candles.last_publish_time;
        if clock >= tap.end + SETTLE_TIMEOUT_SECS {
            now = now.max(tap.end);
        }
        let outcome = candles.judge(tap.lo, tap.hi, tap.start, tap.end, now);
        if outcome == Outcome::Pending {
            continue;
        }
        let paid = apply_outcome(player, book, slot, outcome)?;
        let (low, high) = candles
            .window_range(tap.start, tap.end.min(now + 1))
            .unwrap_or((0, 0));
        emit!(TapSettled {
            player: player_key,
            market: market_key,
            id: tap.id,
            outcome: match outcome {
                Outcome::Win => 1,
                Outcome::Lose => 2,
                _ => 3,
            },
            lo: tap.lo,
            hi: tap.hi,
            start: tap.start,
            end: tap.end,
            stake: tap.stake,
            payout: paid,
            low,
            high,
        });
        settled += 1;
    }
    require!(settled > 0, QuickdrawError::SettleTooEarly);
    Ok(())
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[account(mut, seeds = [BOOK_SEED], bump = book.bump)]
    pub book: Account<'info, Book>,
    #[account(seeds = [MARKET_SEED, market.oracle.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(address = market.candles)]
    pub candles: AccountLoader<'info, Candles>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instructions::tap::tests::book;
    use crate::state::TapSlot;

    fn player_with_tap(stake: u64, mult_bps: u32) -> (Player, Book) {
        let mut player = Player {
            owner: Pubkey::default(),
            session: Pubkey::default(),
            session_expires: 0,
            balance: 0,
            shares: 0,
            next_id: 1,
            taps_placed: 1,
            wins: 0,
            streak: 2,
            best_streak: 2,
            pnl: 0,
            taps: [TapSlot::default(); MAX_TAPS],
            bump: 0,
        };
        player.taps[3] = TapSlot {
            stake,
            mult_bps,
            open: true,
            ..Default::default()
        };
        let mut b = book();
        // as if place_tap ran: stake joined the pool, payout is owed
        b.liquidity += stake;
        b.exposure += player.taps[3].payout();
        (player, b)
    }

    #[test]
    fn a_win_pays_the_multiplier_from_the_pool() {
        let (mut p, mut b) = player_with_tap(5_000_000, 32_000);
        let before = b.liquidity;
        assert_eq!(
            apply_outcome(&mut p, &mut b, 3, Outcome::Win).unwrap(),
            16_000_000
        );
        assert_eq!(
            (p.balance, p.wins, p.streak, p.best_streak, p.pnl),
            (16_000_000, 1, 3, 3, 11_000_000)
        );
        assert_eq!((b.liquidity, b.exposure), (before - 16_000_000, 0));
        assert!(!p.taps[3].open);
        assert!(apply_outcome(&mut p, &mut b, 3, Outcome::Win).is_err());
    }

    #[test]
    fn a_loss_keeps_the_stake_in_the_pool_and_a_void_refunds_it() {
        let (mut p, mut b) = player_with_tap(5_000_000, 32_000);
        let before = b.liquidity;
        assert_eq!(apply_outcome(&mut p, &mut b, 3, Outcome::Lose).unwrap(), 0);
        assert_eq!(
            (p.balance, p.streak, p.pnl, b.liquidity, b.exposure),
            (0, 0, -5_000_000, before, 0)
        );

        let (mut p, mut b) = player_with_tap(5_000_000, 32_000);
        let before = b.liquidity;
        assert_eq!(
            apply_outcome(&mut p, &mut b, 3, Outcome::Void).unwrap(),
            5_000_000
        );
        assert_eq!(
            (p.balance, p.streak, b.liquidity, b.exposure),
            (5_000_000, 2, before - 5_000_000, 0)
        );
    }

    #[test]
    fn pending_taps_stay_open() {
        let (mut p, mut b) = player_with_tap(5_000_000, 32_000);
        assert!(apply_outcome(&mut p, &mut b, 3, Outcome::Pending).is_err());
        assert!(p.taps[3].open);
    }
}
