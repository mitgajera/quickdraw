//! Golden columns, drawn with MagicBlock VRF on the ephemeral rollup.
//!
//! - `init_lucky` / `delegate_lucky` (Solana, once): create the round account and move it to the ER.
//! - `request_lucky` (ER, permissionless, free): asks the VRF oracle for the seed of the current or
//!   next round. The keeper calls it every round; anyone may.
//! - `callback_lucky` (ER): the VRF program delivers the randomness, signed with this program's
//!   scoped VRF identity (checked by `#[vrf_callback]`). The seed is stored once and never replaced,
//!   so nobody, not even the house, can reroll a round.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{delegate, vrf, vrf_callback};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE;
use ephemeral_rollups_sdk::vrf::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;

use crate::error::QuickdrawError;
use crate::events::LuckyRound;
use crate::state::Lucky;
use crate::{GOLDEN_AUTH_SEED, GOLDEN_MINT, LUCKY_SEED, ROUND_SECS};

pub fn init_lucky_handler(ctx: Context<InitLucky>) -> Result<()> {
    let lucky = &mut ctx.accounts.lucky;
    lucky.authority = ctx.accounts.authority.key();
    lucky.bump = ctx.bumps.lucky;
    Ok(())
}

pub fn delegate_lucky_handler(ctx: Context<DelegateLucky>) -> Result<()> {
    {
        let data = ctx.accounts.lucky.try_borrow_data()?;
        let lucky = Lucky::try_deserialize(&mut &data[..])?;
        require_keys_eq!(lucky.authority, ctx.accounts.payer.key(), QuickdrawError::Unauthorized);
    }
    let validator = ctx.remaining_accounts.first().map(|account| account.key());
    ctx.accounts.delegate_lucky(
        &ctx.accounts.payer,
        &[LUCKY_SEED],
        DelegateConfig { validator, ..Default::default() },
    )?;
    Ok(())
}

/// Requests the VRF seed for `round` (the current round or one of the next two), unless it is drawn.
pub fn request_lucky_handler(ctx: Context<RequestLucky>, round: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp.div_euclid(ROUND_SECS);
    require!(round >= now && round <= now + 2, QuickdrawError::RoundNotOpen);
    require!(ctx.accounts.lucky.seed_for(round).is_none(), QuickdrawError::RoundDrawn);

    let mut caller_seed = [0u8; 32];
    caller_seed[..8].copy_from_slice(&round.to_le_bytes());
    caller_seed[8..16].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::CallbackLucky::DISCRIMINATOR.to_vec(),
        caller_seed,
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: ctx.accounts.lucky.key(),
            is_signer: false,
            is_writable: true,
        }]),
        // the VRF program appends these bytes after `randomness` in the callback's data
        callback_args: Some(round.to_le_bytes().to_vec()),
    });
    ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    Ok(())
}

/// VRF callback: stores the round's seed (first delivery wins; later ones are ignored).
pub fn callback_lucky_handler(ctx: Context<CallbackLucky>, randomness: [u8; 32], round: i64) -> Result<()> {
    if ctx.accounts.lucky.set_seed(round, randomness) {
        emit!(LuckyRound { round, seed: randomness });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct InitLucky<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Lucky::INIT_SPACE, seeds = [LUCKY_SEED], bump)]
    pub lucky: Account<'info, Lucky>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateLucky<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the lucky PDA; only its authority may delegate it.
    #[account(mut, del, seeds = [LUCKY_SEED], bump)]
    pub lucky: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestLucky<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [LUCKY_SEED], bump = lucky.bump)]
    pub lucky: Account<'info, Lucky>,
    /// CHECK: MagicBlock's VRF queue inside the ephemeral rollup (requests there are free).
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE @ QuickdrawError::Unauthorized)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackLucky<'info> {
    #[account(mut, seeds = [LUCKY_SEED], bump = lucky.bump)]
    pub lucky: Account<'info, Lucky>,
}

/// Metaplex Token Metadata: gives the Golden Tap its name and image in every wallet.
pub const TOKEN_METADATA_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/// Names the Golden Tap collectible (Metaplex metadata). Only the program can sign for the mint, so it
/// signs here as `golden-auth`; only the golden columns' authority (the house) may call it, and it
/// becomes the metadata's update authority, so later edits need no program change.
pub fn golden_metadata_handler(ctx: Context<GoldenMetadata>, name: String, symbol: String, uri: String) -> Result<()> {
    {
        // the lucky account lives on the rollup; its Solana copy still carries the authority set at init
        let data = ctx.accounts.lucky.try_borrow_data()?;
        let lucky = Lucky::try_deserialize(&mut &data[..])?;
        require_keys_eq!(lucky.authority, ctx.accounts.authority.key(), QuickdrawError::Unauthorized);
    }
    // CreateMetadataAccountV3 (discriminator 33), Borsh: DataV2 { name, symbol, uri, seller fee,
    // creators: None, collection: None, uses: None }, is_mutable: true, collection_details: None
    let mut data = vec![33u8];
    for s in [&name, &symbol, &uri] {
        data.extend((s.len() as u32).to_le_bytes());
        data.extend(s.as_bytes());
    }
    data.extend(0u16.to_le_bytes());
    data.extend([0u8, 0, 0, 1, 0]);

    use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
    let a = &ctx.accounts;
    let ix = Instruction {
        program_id: TOKEN_METADATA_ID,
        accounts: vec![
            AccountMeta::new(a.metadata.key(), false),
            AccountMeta::new_readonly(a.mint.key(), false),
            AccountMeta::new_readonly(a.golden_auth.key(), true),
            AccountMeta::new(a.authority.key(), true),
            AccountMeta::new_readonly(a.authority.key(), true),
            AccountMeta::new_readonly(a.system_program.key(), false),
            AccountMeta::new_readonly(a.rent.key(), false),
        ],
        data,
    };
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            a.metadata.to_account_info(),
            a.mint.to_account_info(),
            a.golden_auth.to_account_info(),
            a.authority.to_account_info(),
            a.system_program.to_account_info(),
            a.rent.to_account_info(),
            a.token_metadata_program.to_account_info(),
        ],
        &[&[GOLDEN_AUTH_SEED, &[ctx.bumps.golden_auth]]],
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct GoldenMetadata<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: the lucky PDA (delegated, so read raw); its authority must sign.
    #[account(seeds = [LUCKY_SEED], bump)]
    pub lucky: UncheckedAccount<'info>,
    /// CHECK: the Golden Tap's Metaplex metadata PDA, created by the Token Metadata program.
    #[account(mut, seeds = [b"metadata", TOKEN_METADATA_ID.as_ref(), GOLDEN_MINT.as_ref()], bump, seeds::program = TOKEN_METADATA_ID)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: the Golden Tap mint.
    #[account(address = GOLDEN_MINT)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the mint authority PDA; signs through the program.
    #[account(seeds = [GOLDEN_AUTH_SEED], bump)]
    pub golden_auth: UncheckedAccount<'info>,
    /// CHECK: Metaplex Token Metadata.
    #[account(address = TOKEN_METADATA_ID)]
    pub token_metadata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
