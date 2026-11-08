use anchor_lang::prelude::*;

#[error_code]
pub enum QuickdrawError {
    #[msg("Price account is not a MagicBlock oracle feed")]
    InvalidOracle,
    #[msg("Price account does not match this market")]
    WrongOracle,
    #[msg("Oracle price is too old")]
    StaleOracle,
    #[msg("Invalid market or book parameters")]
    InvalidParams,
    #[msg("Signer may not act for this player")]
    Unauthorized,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Not enough balance")]
    InsufficientBalance,
    #[msg("Not enough LP shares")]
    InsufficientShares,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("This column is locked or too far ahead")]
    ColumnClosed,
    #[msg("The box is outside the tradable multiplier range")]
    MultiplierOutOfRange,
    #[msg("The multiplier moved below the minimum you accepted")]
    Slippage,
    #[msg("This tap would win more than the per-tap limit")]
    ProfitTooLarge,
    #[msg("The house cannot cover this tap right now")]
    ExposureLimit,
    #[msg("All tap slots are in use")]
    TooManyTaps,
    #[msg("You already have a tap in this column")]
    ColumnTaken,
    #[msg("No open tap in this slot")]
    NoOpenTap,
    #[msg("This tap cannot be settled yet")]
    SettleTooEarly,
    #[msg("Liquidity is committed to open taps")]
    LiquidityLocked,
    #[msg("Only devnet USDC is accepted")]
    WrongMint,
    #[msg("Not enough USDC in the wallet for this stake")]
    WalletTooLow,
    #[msg("Approve Quickdraw to spend your USDC first")]
    AllowanceTooLow,
    #[msg("Only a Quickdraw Magic Action may call this")]
    NotMagicAction,
}
