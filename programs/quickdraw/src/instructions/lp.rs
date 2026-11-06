use anchor_lang::prelude::*;

use crate::error::QuickdrawError;
use crate::state::{Book, Player};
use crate::{BOOK_SEED, PLAYER_SEED};

/// Shares minted for adding `amount` to a pool worth `liquidity` with `total_shares` outstanding.
pub fn shares_for(amount: u64, liquidity: u64, total_shares: u64) -> Option<u64> {
    if total_shares == 0 || liquidity == 0 {
        return Some(amount);
    }
    u64::try_from(amount as u128 * total_shares as u128 / liquidity as u128).ok()
}

/// Value of `shares` in a pool worth `liquidity` with `total_shares` outstanding.
pub fn value_of(shares: u64, liquidity: u64, total_shares: u64) -> Option<u64> {
    if total_shares == 0 {
        return None;
    }
    u64::try_from(shares as u128 * liquidity as u128 / total_shares as u128).ok()
}

/// Moves game balance into the house and mints LP shares (ER, owner only).
pub fn lp_add_handler(ctx: Context<Liquidity>, amount: u64) -> Result<()> {
    require!(amount > 0, QuickdrawError::ZeroAmount);
    let (book, player) = (&mut ctx.accounts.book, &mut ctx.accounts.player);
    let shares =
        shares_for(amount, book.liquidity, book.total_shares).ok_or(QuickdrawError::Overflow)?;
    require!(shares > 0, QuickdrawError::ZeroAmount);
    player.balance = player
        .balance
        .checked_sub(amount)
        .ok_or(QuickdrawError::InsufficientBalance)?;
    player.shares = player
        .shares
        .checked_add(shares)
        .ok_or(QuickdrawError::Overflow)?;
    book.liquidity = book
        .liquidity
        .checked_add(amount)
        .ok_or(QuickdrawError::Overflow)?;
    book.total_shares = book
        .total_shares
        .checked_add(shares)
        .ok_or(QuickdrawError::Overflow)?;
    Ok(())
}

/// Burns LP shares and returns their value to the game balance (ER, owner only).
/// Liquidity backing open payouts stays in the pool until those taps settle.
pub fn lp_remove_handler(ctx: Context<Liquidity>, shares: u64) -> Result<()> {
    require!(shares > 0, QuickdrawError::ZeroAmount);
    let (book, player) = (&mut ctx.accounts.book, &mut ctx.accounts.player);
    require!(player.shares >= shares, QuickdrawError::InsufficientShares);
    let amount =
        value_of(shares, book.liquidity, book.total_shares).ok_or(QuickdrawError::Overflow)?;
    let remaining = book
        .liquidity
        .checked_sub(amount)
        .ok_or(QuickdrawError::Overflow)?;
    require!(remaining >= book.exposure, QuickdrawError::LiquidityLocked);
    book.liquidity = remaining;
    book.total_shares -= shares;
    player.shares -= shares;
    player.balance = player
        .balance
        .checked_add(amount)
        .ok_or(QuickdrawError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Liquidity<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[account(mut, seeds = [BOOK_SEED], bump = book.bump)]
    pub book: Account<'info, Book>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_deposit_sets_one_share_per_unit() {
        assert_eq!(shares_for(500, 0, 0), Some(500));
    }

    #[test]
    fn shares_track_pool_value() {
        // pool grew from 1000 to 1100 on 1000 shares: 110 units buy 100 shares
        assert_eq!(shares_for(110, 1_100, 1_000), Some(100));
        assert_eq!(value_of(100, 1_100, 1_000), Some(110));
        assert_eq!(value_of(1, 1, 0), None);
    }
}
