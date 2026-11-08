use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod error;
pub mod events;
pub mod instructions;
pub mod odds;
pub mod oracle;
pub mod state;

pub use instructions::*;

declare_id!("7TBHSjenh1DFt7C8vnNVfXDLbZ3cCgEeAa4XcTUvF6Au");

pub const MARKET_SEED: &[u8] = b"mkt";
pub const CANDLES_SEED: &[u8] = b"candles";
pub const BOOK_SEED: &[u8] = b"book";
pub const PLAYER_SEED: &[u8] = b"player";
pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_TOKENS_SEED: &[u8] = b"vault-tokens";
pub const LEDGER_SEED: &[u8] = b"ledger";
/// PDA that schedules this program's Magic Actions; base-layer handlers only trust its escrow.
pub const ESCROW_AUTH_SEED: &[u8] = b"escrow-auth";
/// Escrow index `ActionArgs::new` uses; the keeper funds this escrow with SOL for base fees.
pub const ESCROW_INDEX: u8 = 255;
/// Circle's devnet USDC: the only token the house takes. 6 decimals.
pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
pub const MINT_DECIMALS: u8 = 6;

/// `record_tick` rejects oracle readings older than this (seconds, against the ER clock).
pub const MAX_ORACLE_AGE_SECONDS: i64 = 30;
/// Taps need a fresher price than ticks.
pub const TAP_ORACLE_MAX_AGE: i64 = 10;
/// A column stops taking taps this many seconds before it opens.
pub const TAP_LOCK_SECS: i64 = 1;
/// Largest grid zoom: rows up to `band << MAX_ZOOM` (16x the market's base row).
pub const MAX_ZOOM: u8 = 4;
/// Furthest ahead a column can be tapped.
pub const MAX_AHEAD_SECS: i64 = 120;
/// Seconds of candles used for the volatility estimate behind the odds.
pub const VOL_WINDOW_SECS: i64 = 30;
/// Scales on the candle volatility estimate (per-second midpoint moves, which read low): how far the
/// price drifts before a column opens, and how far it wanders inside the 4-second column. Fitted on
/// recorded devnet oracle data (SOL/BTC/ETH): hit rates match by row and by column, and realised
/// return-to-player sits at 0.8-1.06 in every multiplier range (about 1 - edge overall).
pub const DRIFT_VOL_SCALE: f64 = 2.5;
pub const WINDOW_VOL_SCALE: f64 = 1.0;
/// After this long past a column, taps settle on whatever the ring holds (refund if nothing).
pub const SETTLE_TIMEOUT_SECS: i64 = 30;

#[ephemeral]
#[program]
pub mod quickdraw {
    use super::*;

    // --- markets and the price recorder ---

    pub fn init_market(ctx: Context<InitMarket>, params: MarketParams) -> Result<()> {
        instructions::init_market_handler(ctx, params)
    }

    pub fn update_market(ctx: Context<UpdateMarket>, params: MarketParams) -> Result<()> {
        instructions::update_market_handler(ctx, params)
    }

    pub fn delegate_candles(ctx: Context<DelegateCandles>) -> Result<()> {
        instructions::delegate_candles_handler(ctx)
    }

    pub fn record_tick(ctx: Context<RecordTick>) -> Result<()> {
        instructions::record_tick_handler(ctx)
    }

    pub fn undelegate_candles(ctx: Context<UndelegateCandles>) -> Result<()> {
        instructions::undelegate_candles_handler(ctx)
    }

    // --- the house ---

    pub fn init_book(ctx: Context<InitBook>, params: BookParams) -> Result<()> {
        instructions::init_book_handler(ctx, params)
    }

    pub fn update_book(ctx: Context<UpdateBook>, params: BookParams) -> Result<()> {
        instructions::update_book_handler(ctx, params)
    }

    pub fn delegate_book(ctx: Context<DelegateBook>) -> Result<()> {
        instructions::delegate_book_handler(ctx)
    }

    pub fn undelegate_book(ctx: Context<UndelegateBook>) -> Result<()> {
        instructions::undelegate_book_handler(ctx)
    }

    pub fn lp_add(ctx: Context<Liquidity>, amount: u64) -> Result<()> {
        instructions::lp_add_handler(ctx, amount)
    }

    pub fn lp_remove(ctx: Context<Liquidity>, shares: u64) -> Result<()> {
        instructions::lp_remove_handler(ctx, shares)
    }

    // --- players ---

    pub fn init_player(ctx: Context<InitPlayer>) -> Result<()> {
        instructions::init_player_handler(ctx)
    }

    pub fn deposit(ctx: Context<MoveFunds>, amount: u64) -> Result<()> {
        instructions::deposit_handler(ctx, amount)
    }

    pub fn withdraw(ctx: Context<MoveFunds>, amount: u64) -> Result<()> {
        instructions::withdraw_handler(ctx, amount)
    }

    pub fn set_session(ctx: Context<SetSession>, session: Pubkey, expires_at: i64) -> Result<()> {
        instructions::set_session_handler(ctx, session, expires_at)
    }

    pub fn delegate_player(ctx: Context<DelegatePlayer>) -> Result<()> {
        instructions::delegate_player_handler(ctx)
    }

    pub fn undelegate_player(ctx: Context<UndelegatePlayer>) -> Result<()> {
        instructions::undelegate_player_handler(ctx)
    }

    // --- trading ---

    pub fn place_tap(
        ctx: Context<PlaceTap>,
        band_index: i64,
        column: i64,
        zoom: u8,
        stake: u64,
        min_mult_bps: u32,
    ) -> Result<()> {
        instructions::place_tap_handler(ctx, band_index, column, zoom, stake, min_mult_bps)
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle_handler(ctx)
    }

    // --- wallet play: stakes come straight from the wallet, winnings go straight back ---

    pub fn init_ledger(ctx: Context<InitLedger>) -> Result<()> {
        instructions::init_ledger_handler(ctx)
    }

    pub fn place_wallet_tap<'info>(
        ctx: Context<'info, PlaceWalletTap<'info>>,
        band_index: i64,
        column: i64,
        zoom: u8,
        stake: u64,
        min_mult_bps: u32,
    ) -> Result<()> {
        instructions::place_wallet_tap_handler(ctx, band_index, column, zoom, stake, min_mult_bps)
    }

    pub fn settle_wallet<'info>(ctx: Context<'info, SettleWallet<'info>>) -> Result<()> {
        instructions::settle_wallet_handler(ctx)
    }

    pub fn collect_stake<'info>(
        ctx: Context<'info, WalletAction>,
        owner: Pubkey,
        tap_id: u32,
        amount: u64,
    ) -> Result<()> {
        instructions::collect_stake_handler(ctx, owner, tap_id, amount)
    }

    pub fn pay_out<'info>(
        ctx: Context<'info, WalletAction>,
        owner: Pubkey,
        amount: u64,
    ) -> Result<()> {
        instructions::pay_out_handler(ctx, owner, amount)
    }
}
