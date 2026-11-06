//! Reads MagicBlock's ephemeral-oracle price accounts (Pyth Lazer feeds pushed into the ER).
//!
//! The account is *not* a standard Pyth `PriceUpdateV2`: it has its own discriminator and stores
//! the exponent as a positive magnitude. Layout (verified against devnet, Nov 2026):
//! `disc[8] | write_authority[32] | verification(1 = Full) | feed_id[32] | price i64 @73 |
//! conf u64 @81 | exponent i32 @89 | publish_time i64 @93 | ...`
use anchor_lang::prelude::*;

use crate::error::QuickdrawError;

/// Program that owns the oracle price accounts.
pub const ORACLE_PROGRAM_ID: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
/// First 8 bytes of every oracle price account.
pub const ORACLE_DISCRIMINATOR: [u8; 8] = [0xea, 0xa1, 0x0e, 0x24, 0xac, 0xef, 0x0f, 0xe8];

const VERIFICATION_OFFSET: usize = 40;
const FULL_VERIFICATION: u8 = 1;
const PRICE_OFFSET: usize = 73;
const PUBLISH_TIME_OFFSET: usize = 93;
const MIN_LEN: usize = PUBLISH_TIME_OFFSET + 8;

/// A price in feed units (8 decimals for the crypto feeds we use) and its publish time in seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OraclePrice {
    pub price: i64,
    pub publish_time: i64,
}

/// Delegation program that owns oracle feeds on the base layer while they live on the ER.
pub const DELEGATION_PROGRAM_ID: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

/// True for the oracle program (on the ER) or the delegation program (on the base layer).
pub fn is_oracle_owner(owner: &Pubkey) -> bool {
    *owner == ORACLE_PROGRAM_ID || *owner == DELEGATION_PROGRAM_ID
}

/// Parses an oracle account after checking who owns it and what it is.
pub fn read_oracle_price(account: &AccountInfo) -> Result<OraclePrice> {
    require_keys_eq!(
        *account.owner,
        ORACLE_PROGRAM_ID,
        QuickdrawError::InvalidOracle
    );
    let data = account.try_borrow_data()?;
    parse_oracle_price(&data)
}

/// Pure parser, split out so it can be unit tested without an AccountInfo.
pub fn parse_oracle_price(data: &[u8]) -> Result<OraclePrice> {
    require!(data.len() >= MIN_LEN, QuickdrawError::InvalidOracle);
    require!(
        data[..8] == ORACLE_DISCRIMINATOR,
        QuickdrawError::InvalidOracle
    );
    require!(
        data[VERIFICATION_OFFSET] == FULL_VERIFICATION,
        QuickdrawError::InvalidOracle
    );
    let price = i64::from_le_bytes(data[PRICE_OFFSET..PRICE_OFFSET + 8].try_into().unwrap());
    let publish_time = i64::from_le_bytes(
        data[PUBLISH_TIME_OFFSET..PUBLISH_TIME_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    require!(price > 0, QuickdrawError::InvalidOracle);
    Ok(OraclePrice {
        price,
        publish_time,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(price: i64, publish_time: i64) -> Vec<u8> {
        let mut data = vec![0u8; 134];
        data[..8].copy_from_slice(&ORACLE_DISCRIMINATOR);
        data[VERIFICATION_OFFSET] = FULL_VERIFICATION;
        data[PRICE_OFFSET..PRICE_OFFSET + 8].copy_from_slice(&price.to_le_bytes());
        data[89..93].copy_from_slice(&8i32.to_le_bytes());
        data[PUBLISH_TIME_OFFSET..PUBLISH_TIME_OFFSET + 8]
            .copy_from_slice(&publish_time.to_le_bytes());
        data
    }

    #[test]
    fn parses_a_devnet_shaped_account() {
        let parsed = parse_oracle_price(&sample(8_957_222_466, 1_793_955_310)).unwrap();
        assert_eq!(
            parsed,
            OraclePrice {
                price: 8_957_222_466,
                publish_time: 1_793_955_310
            }
        );
    }

    #[test]
    fn rejects_wrong_discriminator_short_data_and_bad_prices() {
        let mut wrong = sample(1, 1);
        wrong[0] ^= 0xff;
        assert!(parse_oracle_price(&wrong).is_err());
        assert!(parse_oracle_price(&[0u8; 50]).is_err());
        assert!(parse_oracle_price(&sample(0, 1)).is_err());
        let mut partial = sample(1, 1);
        partial[VERIFICATION_OFFSET] = 0;
        assert!(parse_oracle_price(&partial).is_err());
    }
}
