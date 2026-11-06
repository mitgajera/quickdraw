use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::error::QuickdrawError;
use crate::state::Player;
use crate::{MINT_DECIMALS, MINT_SEED, PLAYER_SEED, VAULT_SEED, VAULT_TOKENS_SEED};

/// Longest a session key may stay valid.
pub const MAX_SESSION_SECONDS: i64 = 7 * 24 * 60 * 60;

/// Opens a player account (base layer, once per wallet).
pub fn init_player_handler(ctx: Context<InitPlayer>) -> Result<()> {
    let player = &mut ctx.accounts.player;
    player.owner = ctx.accounts.owner.key();
    player.bump = ctx.bumps.player;
    Ok(())
}

/// Moves test USD from the wallet into the game balance (base layer, player not delegated).
pub fn deposit_handler(ctx: Context<MoveFunds>, amount: u64) -> Result<()> {
    require!(amount > 0, QuickdrawError::ZeroAmount);
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.user_tokens.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault_tokens.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        MINT_DECIMALS,
    )?;
    let player = &mut ctx.accounts.player;
    player.balance = player
        .balance
        .checked_add(amount)
        .ok_or(QuickdrawError::Overflow)?;
    Ok(())
}

/// Moves free game balance back to the wallet (base layer, player not delegated).
pub fn withdraw_handler(ctx: Context<MoveFunds>, amount: u64) -> Result<()> {
    require!(amount > 0, QuickdrawError::ZeroAmount);
    let player = &mut ctx.accounts.player;
    player.balance = player
        .balance
        .checked_sub(amount)
        .ok_or(QuickdrawError::InsufficientBalance)?;
    let bump = [ctx.bumps.vault];
    let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_tokens.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_tokens.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            seeds,
        ),
        amount,
        MINT_DECIMALS,
    )
}

/// Authorises a browser-held key to tap until `expires_at` (owner only, base or ER).
pub fn set_session_handler(
    ctx: Context<SetSession>,
    session: Pubkey,
    expires_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        expires_at <= now + MAX_SESSION_SECONDS,
        QuickdrawError::InvalidParams
    );
    let player = &mut ctx.accounts.player;
    player.session = session;
    player.session_expires = expires_at;
    Ok(())
}

/// Hands the player account to the ER for popup-free, millisecond taps.
pub fn delegate_player_handler(ctx: Context<DelegatePlayer>) -> Result<()> {
    let validator = ctx.remaining_accounts.first().map(|account| account.key());
    let owner = ctx.accounts.payer.key();
    ctx.accounts.delegate_player(
        &ctx.accounts.payer,
        &[PLAYER_SEED, owner.as_ref()],
        DelegateConfig {
            validator,
            ..Default::default()
        },
    )?;
    Ok(())
}

/// Commits the player back to Solana so the owner can deposit or withdraw (owner only, ER).
pub fn undelegate_player_handler(ctx: Context<UndelegatePlayer>) -> Result<()> {
    // open taps can only settle on the ER, so they must resolve first
    require!(
        ctx.accounts.player.open_taps() == 0,
        QuickdrawError::SettleTooEarly
    );
    MagicIntentBundleBuilder::new(
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.player.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitPlayer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Player::INIT_SPACE,
        seeds = [PLAYER_SEED, owner.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MoveFunds<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    /// CHECK: PDA that owns the vault.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub user_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_TOKENS_SEED], bump)]
    pub vault_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetSession<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePlayer<'info> {
    /// The player's owner; the PDA seeds tie the account to this signer.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the payer's player PDA, delegated to the ER.
    #[account(mut, del, seeds = [PLAYER_SEED, payer.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegatePlayer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}
