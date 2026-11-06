use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::error::QuickdrawError;
use crate::odds::ONE_X_BPS;
use crate::state::Book;
use crate::{BOOK_SEED, MINT_DECIMALS, MINT_SEED, VAULT_SEED, VAULT_TOKENS_SEED};

/// Faucet mints this much test USD per call (1,000 with 6 decimals).
pub const FAUCET_AMOUNT: u64 = 1_000 * 10u64.pow(MINT_DECIMALS as u32);
/// Faucet refuses wallets already holding at least this much.
pub const FAUCET_CAP: u64 = 5_000 * 10u64.pow(MINT_DECIMALS as u32);

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

/// Creates the house book, the test-USD mint and the token vault (base layer, once).
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

/// Mints 1,000 test USD to the caller's wallet (devnet only, base layer).
pub fn faucet_handler(ctx: Context<Faucet>) -> Result<()> {
    require!(
        ctx.accounts.user_tokens.amount < FAUCET_CAP,
        QuickdrawError::FaucetLimit
    );
    let bump = [ctx.bumps.vault];
    let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_tokens.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            seeds,
        ),
        FAUCET_AMOUNT,
    )
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
    /// CHECK: PDA that signs for the mint and the vault; holds no data.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [MINT_SEED],
        bump,
        mint::decimals = MINT_DECIMALS,
        mint::authority = vault
    )]
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

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: PDA mint authority.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user
    )]
    pub user_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
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
