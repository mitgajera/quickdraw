use anchor_lang::prelude::*;

#[error_code]
pub enum QuickdrawError {
    #[msg("Price account is not a MagicBlock oracle feed")]
    InvalidOracle,
    #[msg("Price account does not match this market")]
    WrongOracle,
    #[msg("Oracle price is too old")]
    StaleOracle,
}
