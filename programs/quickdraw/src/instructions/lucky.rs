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
use crate::{LUCKY_SEED, ROUND_SECS};

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
