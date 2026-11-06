use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::error::QuickdrawError;
use crate::odds::ONE_X_BPS;
use crate::state::Book;
use crate::{BOOK_SEED, USDC_MINT, VAULT_SEED, VAULT_TOKENS_SEED};

/// Risk settings of the house.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct BookParams {
    pub edge_bps: u16,
    pub min_mult_bps: u32,
    pub max_mult_bps: u32,
    pub max_exposure_bps: u16,
    pub max_profit: u64,
}

impl BookParams {
    fn validate(&self) -> Result<()> {
        require!(
            (self.edge_bps as u32) < ONE_X_BPS
                && self.min_mult_bps > ONE_X_BPS
                && self.max_mult_bps >= self.min_mult_bps
                && self.max_exposure_bps > 0
                && self.max_exposure_bps as u32 <= ONE_X_BPS
                && self.max_profit > 0,
            QuickdrawError::InvalidParams
        );
        Ok(())
    }

    fn apply(&self, book: &mut Book) {
        book.edge_bps = self.edge_bps;
        book.min_mult_bps = self.min_mult_bps;
        book.max_mult_bps = self.max_mult_bps;
        book.max_exposure_bps = self.max_exposure_bps;
        book.max_profit = self.max_profit;
    }
}

/// Creates the house book and its devnet-USDC vault (base layer, once).
pub fn init_book_handler(ctx: Context<InitBook>, params: BookParams) -> Result<()> {
    params.validate()?;
    let book = &mut ctx.accounts.book;
    book.authority = ctx.accounts.authority.key();
    book.mint = ctx.accounts.mint.key();
    book.bump = ctx.bumps.book;
    params.apply(book);
    Ok(())
}

/// Retunes the house risk settings (ER, book authority).
pub fn update_book_handler(ctx: Context<UpdateBook>, params: BookParams) -> Result<()> {
    params.validate()?;
    params.apply(&mut ctx.accounts.book);
    Ok(())
}

/// Hands the book to the ER so every tap and settlement can update it.
pub fn delegate_book_handler(ctx: Context<DelegateBook>) -> Result<()> {
    {
        // the book is unchecked here (the delegate macro needs it raw): read its authority by hand
        let data = ctx.accounts.book.try_borrow_data()?;
        let book = Book::try_deserialize(&mut &data[..])?;
        require_keys_eq!(
            book.authority,
            ctx.accounts.payer.key(),
            QuickdrawError::Unauthorized
        );
    }
    let validator = ctx.remaining_accounts.first().map(|account| account.key());
    ctx.accounts.delegate_book(
        &ctx.accounts.payer,
        &[BOOK_SEED],
        DelegateConfig {
            validator,
            ..Default::default()
        },
    )?;
    Ok(())
}

/// Commits the book back to Solana and returns it to the base layer.
pub fn undelegate_book_handler(ctx: Context<UndelegateBook>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.book.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitBook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Book::INIT_SPACE, seeds = [BOOK_SEED], bump)]
    pub book: Account<'info, Book>,
    /// CHECK: PDA that owns the vault; holds no data.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    /// Circle's devnet USDC: the only token the house takes.
    #[account(address = USDC_MINT @ QuickdrawError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_TOKENS_SEED],
        bump,
        token::mint = mint,
        token::authority = vault
    )]
    pub vault_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateBook<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [BOOK_SEED], bump = book.bump, has_one = authority @ QuickdrawError::Unauthorized)]
    pub book: Account<'info, Book>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the book PDA; only its authority may delegate it.
    #[account(mut, del, seeds = [BOOK_SEED], bump)]
    pub book: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateBook<'info> {
    #[account(mut, address = book.authority @ QuickdrawError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BOOK_SEED], bump = book.bump)]
    pub book: Account<'info, Book>,
}
