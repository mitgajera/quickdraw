use anchor_lang::prelude::*;

pub mod error;
pub mod oracle;
pub mod state;

use error::QuickdrawError;
use oracle::read_oracle_price;
use state::{Candles, Market};

declare_id!("ALSvgxDgSnXBdHYVgZtBW69CBusRn6s5Q17Wzn36aT8D");

pub const MARKET_SEED: &[u8] = b"market";
pub const CANDLES_SEED: &[u8] = b"candles";
/// Reject oracle readings older than this (seconds, compared with the ER clock).
pub const MAX_ORACLE_AGE_SECONDS: i64 = 30;

#[program]
pub mod quickdraw {
    use super::*;

    /// Creates a market for one oracle feed and its empty candle ring (base layer).
    pub fn init_market(ctx: Context<InitMarket>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.oracle = ctx.accounts.oracle.key();
        market.candles = ctx.accounts.candles.key();
        market.bump = ctx.bumps.market;
        ctx.accounts.candles.load_init()?.market = market.key().to_bytes();
        Ok(())
    }

    /// Records the oracle's latest price into the current second's high/low (ER, permissionless).
    pub fn record_tick(ctx: Context<RecordTick>) -> Result<()> {
        let reading = read_oracle_price(&ctx.accounts.oracle)?;
        let now = Clock::get()?.unix_timestamp;
        require!(
            now - reading.publish_time <= MAX_ORACLE_AGE_SECONDS,
            QuickdrawError::StaleOracle
        );
        ctx.accounts
            .candles
            .load_mut()?
            .record(reading.price, reading.publish_time);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: a MagicBlock oracle feed. On the base layer the feed is delegated to the ER, so it
    /// is owned by the delegation program here; `record_tick` verifies owner and data on the ER.
    #[account(constraint = oracle::is_oracle_owner(oracle.owner) @ QuickdrawError::InvalidOracle)]
    pub oracle: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, oracle.key().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = authority,
        space = 8 + Candles::LEN,
        seeds = [CANDLES_SEED, market.key().as_ref()],
        bump
    )]
    pub candles: AccountLoader<'info, Candles>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordTick<'info> {
    #[account(seeds = [MARKET_SEED, market.oracle.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, address = market.candles)]
    pub candles: AccountLoader<'info, Candles>,
    /// CHECK: must be this market's oracle feed; parsed and verified in the handler.
    #[account(address = market.oracle @ QuickdrawError::WrongOracle)]
    pub oracle: UncheckedAccount<'info>,
}
