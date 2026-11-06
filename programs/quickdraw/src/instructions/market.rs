use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::error::QuickdrawError;
use crate::oracle::{self, read_oracle_price};
use crate::state::{Candles, Market, CANDLE_SLOTS};
use crate::{CANDLES_SEED, MARKET_SEED, MAX_ORACLE_AGE_SECONDS};

/// Grid shape and volatility floor for a market.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct MarketParams {
    pub symbol: [u8; 8],
    pub band: u64,
    pub col_secs: u32,
    pub sigma_floor: u64,
}

impl MarketParams {
    fn validate(&self) -> Result<()> {
        // a column (plus settlement slack) must fit comfortably inside the candle ring
        require!(
            self.band > 0
                && self.col_secs > 0
                && (self.col_secs as usize) * 8 <= CANDLE_SLOTS
                && self.sigma_floor > 0,
            QuickdrawError::InvalidParams
        );
        Ok(())
    }

    fn apply(&self, market: &mut Market) {
        market.symbol = self.symbol;
        market.band = self.band;
        market.col_secs = self.col_secs;
        market.sigma_floor = self.sigma_floor;
    }
}

/// Creates a market for one oracle feed and its empty candle ring (base layer).
pub fn init_market_handler(ctx: Context<InitMarket>, params: MarketParams) -> Result<()> {
    params.validate()?;
    let market = &mut ctx.accounts.market;
    market.authority = ctx.accounts.authority.key();
    market.oracle = ctx.accounts.oracle.key();
    market.candles = ctx.accounts.candles.key();
    market.bump = ctx.bumps.market;
    params.apply(market);
    ctx.accounts.candles.load_init()?.market = market.key().to_bytes();
    Ok(())
}

/// Retunes a market's grid or volatility floor (base layer, market authority).
pub fn update_market_handler(ctx: Context<UpdateMarket>, params: MarketParams) -> Result<()> {
    params.validate()?;
    params.apply(&mut ctx.accounts.market);
    Ok(())
}

/// Hands the candle ring to the ephemeral rollup so ticks are written in milliseconds.
pub fn delegate_candles_handler(ctx: Context<DelegateCandles>) -> Result<()> {
    let validator = ctx.remaining_accounts.first().map(|account| account.key());
    let market_key = ctx.accounts.market.key();
    ctx.accounts.delegate_candles(
        &ctx.accounts.payer,
        &[CANDLES_SEED, market_key.as_ref()],
        DelegateConfig {
            validator,
            ..Default::default()
        },
    )?;
    Ok(())
}

/// Records the oracle's latest price into the current second's high/low (ER, permissionless).
pub fn record_tick_handler(ctx: Context<RecordTick>) -> Result<()> {
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

/// Commits the candle ring back to Solana and returns it to the base layer.
pub fn undelegate_candles_handler(ctx: Context<UndelegateCandles>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.candles.to_account_info()])
    .build_and_invoke()?;
    Ok(())
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
pub struct UpdateMarket<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ QuickdrawError::Unauthorized)]
    pub market: Account<'info, Market>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateCandles<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.oracle.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: the market's candle ring, delegated to the ER.
    #[account(mut, del, seeds = [CANDLES_SEED, market.key().as_ref()], bump)]
    pub candles: UncheckedAccount<'info>,
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

#[commit]
#[derive(Accounts)]
pub struct UndelegateCandles<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.oracle.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, address = market.candles)]
    pub candles: AccountLoader<'info, Candles>,
}
