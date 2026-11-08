//! Wallet play: the player's USDC never leaves their wallet until a tap needs it.
//!
//! - On sign-in the wallet approves the house vault PDA to spend its USDC and opens a `Ledger`
//!   (base layer, never delegated).
//! - `place_wallet_tap` (ER, milliseconds) checks the wallet's live balance and allowance, records
//!   the tap, and schedules a MagicBlock Magic Action that runs `collect_stake` on Solana: the
//!   stake moves from the wallet to the vault and the ledger marks it collected.
//! - `settle_wallet` (ER) judges taps from the on-chain candles. A win pays only once its stake is
//!   collected, through a second Magic Action, `pay_out`, that sends the payout straight back to the
//!   wallet. A stake that never arrives voids its tap.
//!
//! `collect_stake` and `pay_out` move value, so they only run when invoked by the delegation
//! program with the escrow of this program's own `escrow-auth` PDA as signer.

use anchor_lang::prelude::*;
use anchor_lang::InstructionData;
use anchor_spl::token::{self, TokenAccount, TransferChecked};
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

use crate::error::QuickdrawError;
use crate::events::{TapPlaced, TapSettled};
use crate::oracle::read_oracle_price;
use crate::state::{Book, Candles, Ledger, Market, Outcome, Player, TapSlot, MAX_TAPS, WALLET_TAP_FLAG};
use crate::tap::{has_capacity, quote};
use crate::{
    BOOK_SEED, ESCROW_AUTH_SEED, ESCROW_INDEX, LEDGER_SEED, MARKET_SEED, MINT_DECIMALS, PLAYER_SEED,
    SETTLE_TIMEOUT_SECS, TAP_ORACLE_MAX_AGE, USDC_MINT, VAULT_SEED, VAULT_TOKENS_SEED,
};

/// MagicBlock's delegation program: it executes Magic Actions on Solana and signs for the escrow.
pub const DELEGATION_PROGRAM_ID: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// Compute budget for each Magic Action on Solana.
const ACTION_COMPUTE_UNITS: u32 = 120_000;

pub fn ledger_address(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[LEDGER_SEED, owner.as_ref()], &crate::ID).0
}

pub fn usdc_ata(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token::ID.as_ref(), USDC_MINT.as_ref()], &ATA_PROGRAM_ID).0
}

/// The escrow PDA the delegation program signs for when it runs an action we scheduled.
pub fn action_escrow(escrow_auth: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"balance", escrow_auth.as_ref(), &[ESCROW_INDEX]], &DELEGATION_PROGRAM_ID).0
}

/// The base-layer accounts every wallet action touches, in the order the handlers look for them.
fn action_accounts(owner: &Pubkey) -> Vec<ShortAccountMeta> {
    let meta = |pubkey: Pubkey, is_writable: bool| ShortAccountMeta { pubkey: pubkey.to_bytes().into(), is_writable };
    vec![
        meta(ledger_address(owner), true),
        meta(usdc_ata(owner), true),
        meta(Pubkey::find_program_address(&[VAULT_TOKENS_SEED], &crate::ID).0, true),
        meta(Pubkey::find_program_address(&[VAULT_SEED], &crate::ID).0, false),
        meta(USDC_MINT, false),
        meta(token::ID, false),
    ]
}

/// Schedules one Magic Action on Solana, signed for by this program's escrow-auth PDA.
fn schedule_action<'info>(
    payer: AccountInfo<'info>,
    magic_context: AccountInfo<'info>,
    magic_program: AccountInfo<'info>,
    escrow_auth: AccountInfo<'info>,
    escrow_auth_bump: u8,
    owner: &Pubkey,
    data: Vec<u8>,
) -> Result<()> {
    // the builder copies `is_signer` from the AccountInfo into the CPI; this PDA signs via the seeds
    let mut escrow_auth = escrow_auth;
    escrow_auth.is_signer = true;
    let action = CallHandler {
        args: ActionArgs::new(data),
        compute_units: ACTION_COMPUTE_UNITS,
        escrow_authority: escrow_auth,
        destination_program: crate::ID,
        accounts: action_accounts(owner),
    };
    MagicIntentBundleBuilder::new(payer, magic_context, magic_program)
        .add_standalone_actions([action])
        .build_and_invoke_signed(&[&[ESCROW_AUTH_SEED, &[escrow_auth_bump]]])?;
    Ok(())
}

/// Opens the player's wallet-play ledger (base layer, once per wallet).
pub fn init_ledger_handler(ctx: Context<InitLedger>) -> Result<()> {
    let ledger = &mut ctx.accounts.ledger;
    ledger.owner = ctx.accounts.owner.key();
    ledger.bump = ctx.bumps.ledger;
    Ok(())
}

/// Taps a box with USDC that stays in the player's wallet until this tap claims it (ER). The tap pays
/// the program's own price for the box, but never more than `quoted_mult_bps` (the multiplier the
/// player saw) and never less than `min_mult_bps`, so what you tap is what you get.
#[allow(clippy::too_many_arguments)]
pub fn place_wallet_tap_handler<'info>(
    mut ctx: Context<'info, PlaceWalletTap<'info>>,
    band_index: i64,
    column: i64,
    zoom: u8,
    stake: u64,
    min_mult_bps: u32,
    quoted_mult_bps: u32,
) -> Result<()> {
    require!(stake > 0, QuickdrawError::ZeroAmount);
    let clock = Clock::get()?.unix_timestamp;
    let accounts = &mut ctx.accounts;
    let owner = accounts.player.owner;
    require!(accounts.player.can_tap(&accounts.signer.key(), clock), QuickdrawError::Unauthorized);

    // the wallet must cover this stake plus every stake still waiting to be collected
    let pending: u64 = accounts
        .player
        .taps
        .iter()
        .filter(|t| t.open && t.id & WALLET_TAP_FLAG != 0 && !accounts.ledger.has_collected(t.id))
        .map(|t| t.stake)
        .sum();
    let needed = pending.checked_add(stake).ok_or(QuickdrawError::Overflow)?;
    let wallet = &accounts.user_tokens;
    require!(wallet.amount >= needed, QuickdrawError::WalletTooLow);
    require!(
        Option::<Pubkey>::from(wallet.delegate) == Some(accounts.vault.key()) && wallet.delegated_amount >= needed,
        QuickdrawError::AllowanceTooLow
    );

    let reading = read_oracle_price(&accounts.oracle)?;
    require!(clock - reading.publish_time <= TAP_ORACLE_MAX_AGE, QuickdrawError::StaleOracle);
    let mut q = {
        let candles = accounts.candles.load()?;
        quote(&accounts.market, &accounts.book, &candles, reading.price, reading.publish_time, band_index, column, zoom, stake)?
    };
    require!(q.mult_bps >= min_mult_bps, QuickdrawError::Slippage);
    if quoted_mult_bps < q.mult_bps {
        q.mult_bps = quoted_mult_bps.max(accounts.book.min_mult_bps);
        q.payout = u64::try_from(stake as u128 * q.mult_bps as u128 / crate::odds::ONE_X_BPS as u128)
            .map_err(|_| QuickdrawError::Overflow)?;
    }
    require!(has_capacity(&accounts.book, stake, q.payout), QuickdrawError::ExposureLimit);

    let player = &mut accounts.player;
    require!(!player.has_tap_in_column(&accounts.market.key(), q.start), QuickdrawError::ColumnTaken);
    let slot = player.free_slot().ok_or(QuickdrawError::TooManyTaps)?;
    let id = (player.next_id & !WALLET_TAP_FLAG) | WALLET_TAP_FLAG;
    player.next_id = player.next_id.wrapping_add(1) & !WALLET_TAP_FLAG;
    player.taps_placed = player.taps_placed.saturating_add(1);
    player.taps[slot] = TapSlot {
        market: accounts.market.key(),
        lo: q.lo,
        hi: q.hi,
        start: q.start,
        end: q.end,
        stake,
        mult_bps: q.mult_bps,
        id,
        open: true,
    };

    // the book counts the stake now; settle_wallet takes it back out if it never arrives
    let book = &mut accounts.book;
    book.liquidity += stake;
    book.exposure += q.payout;
    book.volume = book.volume.saturating_add(stake);
    book.taps = book.taps.saturating_add(1);

    emit!(TapPlaced {
        player: player.key(),
        market: accounts.market.key(),
        id,
        slot: slot as u8,
        lo: q.lo,
        hi: q.hi,
        start: q.start,
        end: q.end,
        stake,
        mult_bps: q.mult_bps,
        price: reading.price,
        publish_time: reading.publish_time,
        sigma: q.sigma as u64,
    });

    schedule_action(
        accounts.signer.to_account_info(),
        accounts.magic_context.to_account_info(),
        accounts.magic_program.to_account_info(),
        accounts.escrow_auth.to_account_info(),
        ctx.bumps.escrow_auth,
        &owner,
        crate::instruction::CollectStake { owner, tap_id: id, amount: stake }.data(),
    )
}

/// Settles this player's decidable wallet taps in this market (ER, permissionless) and pays the
/// total straight to their wallet with one Magic Action.
pub fn settle_wallet_handler<'info>(ctx: Context<'info, SettleWallet<'info>>) -> Result<()> {
    let clock = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let player_key = ctx.accounts.player.key();
    let owner = ctx.accounts.player.owner;
    let mut to_pay: u64 = 0;
    let mut settled = 0;
    {
        let candles = ctx.accounts.candles.load()?;
        let ledger = &ctx.accounts.ledger;
        let (player, book) = (&mut ctx.accounts.player, &mut ctx.accounts.book);
        for slot in 0..MAX_TAPS {
            let tap = player.taps[slot];
            if !tap.open || tap.market != market_key || tap.id & WALLET_TAP_FLAG == 0 {
                continue;
            }
            let timed_out = clock >= tap.end + SETTLE_TIMEOUT_SECS;
            let mut now = candles.last_publish_time;
            if timed_out {
                now = now.max(tap.end);
            }
            let mut outcome = candles.judge(tap.lo, tap.hi, tap.start, tap.end, now);
            if outcome == Outcome::Pending {
                continue;
            }
            let payout = tap.payout();
            let collected = ledger.has_collected(tap.id);
            if !collected && !timed_out {
                continue; // the stake is still on its way from the wallet
            }
            let paid = if !collected {
                // the stake never arrived: the tap is void and the book forgets it
                book.liquidity = book.liquidity.checked_sub(tap.stake).ok_or(QuickdrawError::Overflow)?;
                outcome = Outcome::Void;
                0
            } else {
                match outcome {
                    Outcome::Win => {
                        player.wins = player.wins.saturating_add(1);
                        player.streak = player.streak.saturating_add(1);
                        player.best_streak = player.best_streak.max(player.streak);
                        player.pnl = player.pnl.saturating_add((payout - tap.stake) as i64);
                        payout
                    }
                    Outcome::Lose => {
                        player.streak = 0;
                        player.pnl = player.pnl.saturating_sub(tap.stake as i64);
                        0
                    }
                    _ => tap.stake,
                }
            };
            book.liquidity = book.liquidity.checked_sub(paid).ok_or(QuickdrawError::Overflow)?;
            book.exposure = book.exposure.checked_sub(payout).ok_or(QuickdrawError::Overflow)?;
            player.taps[slot].open = false;
            to_pay = to_pay.checked_add(paid).ok_or(QuickdrawError::Overflow)?;
            let (low, high) = candles.window_range(tap.start, tap.end.min(now + 1)).unwrap_or((0, 0));
            emit!(TapSettled {
                player: player_key,
                market: market_key,
                id: tap.id,
                outcome: match outcome {
                    Outcome::Win => 1,
                    Outcome::Lose => 2,
                    _ => 3,
                },
                lo: tap.lo,
                hi: tap.hi,
                start: tap.start,
                end: tap.end,
                stake: tap.stake,
                payout: paid,
                low,
                high,
            });
            settled += 1;
        }
    }
    require!(settled > 0, QuickdrawError::SettleTooEarly);
    if to_pay > 0 {
        let accounts = &ctx.accounts;
        schedule_action(
            accounts.payer.to_account_info(),
            accounts.magic_context.to_account_info(),
            accounts.magic_program.to_account_info(),
            accounts.escrow_auth.to_account_info(),
            ctx.bumps.escrow_auth,
            &owner,
            crate::instruction::PayOut { owner, amount: to_pay }.data(),
        )?;
    }
    Ok(())
}

/// Finds an account by address among the instruction's accounts, so the handlers do not depend on
/// where the delegation program puts its own accounts.
fn find<'a, 'info>(accounts: &'a [AccountInfo<'info>], key: &Pubkey) -> Result<&'a AccountInfo<'info>> {
    accounts.iter().find(|a| a.key == key).ok_or_else(|| error!(QuickdrawError::NotMagicAction))
}

struct ActionAccounts<'a, 'info> {
    ledger: &'a AccountInfo<'info>,
    user_tokens: &'a AccountInfo<'info>,
    vault_tokens: &'a AccountInfo<'info>,
    vault: &'a AccountInfo<'info>,
    mint: &'a AccountInfo<'info>,
    token_program: &'a AccountInfo<'info>,
    vault_bump: u8,
}

/// Checks the caller is a Magic Action this program scheduled, and gathers the accounts.
fn action_accounts_for<'a, 'info>(all: &'a [AccountInfo<'info>], owner: &Pubkey) -> Result<ActionAccounts<'a, 'info>> {
    let escrow_auth = Pubkey::find_program_address(&[ESCROW_AUTH_SEED], &crate::ID).0;
    let escrow = find(all, &action_escrow(&escrow_auth))?;
    require!(escrow.is_signer, QuickdrawError::NotMagicAction);
    let (vault, vault_bump) = Pubkey::find_program_address(&[VAULT_SEED], &crate::ID);
    Ok(ActionAccounts {
        ledger: find(all, &ledger_address(owner))?,
        user_tokens: find(all, &usdc_ata(owner))?,
        vault_tokens: find(all, &Pubkey::find_program_address(&[VAULT_TOKENS_SEED], &crate::ID).0)?,
        vault: find(all, &vault)?,
        mint: find(all, &USDC_MINT)?,
        token_program: find(all, &token::ID)?,
        vault_bump,
    })
}

/// Magic Action (Solana): moves a wallet tap's stake from the wallet to the vault using the
/// allowance the player approved, and records it as collected.
pub fn collect_stake_handler<'info>(
    ctx: Context<'info, WalletAction>,
    owner: Pubkey,
    tap_id: u32,
    amount: u64,
) -> Result<()> {
    let a = action_accounts_for(ctx.remaining_accounts, &owner)?;
    let bump = [a.vault_bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.user_tokens.clone(),
                mint: a.mint.clone(),
                to: a.vault_tokens.clone(),
                authority: a.vault.clone(),
            },
            &[&[VAULT_SEED, &bump]],
        ),
        amount,
        MINT_DECIMALS,
    )?;
    let mut ledger: Account<Ledger> = Account::try_from(a.ledger)?;
    require_keys_eq!(ledger.owner, owner, QuickdrawError::Unauthorized);
    ledger.push_collected(tap_id);
    ledger.collected_total = ledger.collected_total.saturating_add(amount);
    ledger.exit(&crate::ID)?;
    Ok(())
}

/// Magic Action (Solana): pays a settled wallet tap's winnings or refund straight to the wallet.
pub fn pay_out_handler<'info>(ctx: Context<'info, WalletAction>, owner: Pubkey, amount: u64) -> Result<()> {
    let a = action_accounts_for(ctx.remaining_accounts, &owner)?;
    let bump = [a.vault_bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.vault_tokens.clone(),
                mint: a.mint.clone(),
                to: a.user_tokens.clone(),
                authority: a.vault.clone(),
            },
            &[&[VAULT_SEED, &bump]],
        ),
        amount,
        MINT_DECIMALS,
    )?;
    let mut ledger: Account<Ledger> = Account::try_from(a.ledger)?;
    require_keys_eq!(ledger.owner, owner, QuickdrawError::Unauthorized);
    ledger.paid_total = ledger.paid_total.saturating_add(amount);
    ledger.exit(&crate::ID)?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitLedger<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Ledger::INIT_SPACE, seeds = [LEDGER_SEED, owner.key().as_ref()], bump)]
    pub ledger: Account<'info, Ledger>,
    pub system_program: Program<'info, System>,
}

#[commit]
#[derive(Accounts)]
pub struct PlaceWalletTap<'info> {
    /// The player's owner or their active session key; pays nothing (rollup transactions are free).
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, Player>>,
    #[account(mut, seeds = [BOOK_SEED], bump = book.bump)]
    pub book: Box<Account<'info, Book>>,
    #[account(
        seeds = [MARKET_SEED, market.oracle.as_ref()],
        bump = market.bump,
        constraint = market.authority == book.authority @ QuickdrawError::Unauthorized
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(address = market.candles)]
    pub candles: AccountLoader<'info, Candles>,
    /// CHECK: this market's oracle feed; owner and layout are verified when it is read.
    #[account(address = market.oracle @ QuickdrawError::WrongOracle)]
    pub oracle: UncheckedAccount<'info>,
    /// Live copy of the base-layer ledger: which earlier stakes have been collected.
    #[account(seeds = [LEDGER_SEED, player.owner.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// Live copy of the player's USDC token account on Solana.
    #[account(address = usdc_ata(&player.owner), token::mint = USDC_MINT, token::authority = player.owner)]
    pub user_tokens: Box<Account<'info, TokenAccount>>,
    /// CHECK: the vault PDA the wallet approved as its spender.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: signs the Magic Action that collects the stake on Solana.
    #[account(seeds = [ESCROW_AUTH_SEED], bump)]
    pub escrow_auth: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct SettleWallet<'info> {
    /// Whoever cranks settlement (the keeper or the player's own app).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, Player>>,
    #[account(mut, seeds = [BOOK_SEED], bump = book.bump)]
    pub book: Box<Account<'info, Book>>,
    #[account(seeds = [MARKET_SEED, market.oracle.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(address = market.candles)]
    pub candles: AccountLoader<'info, Candles>,
    #[account(seeds = [LEDGER_SEED, player.owner.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: signs the Magic Action that pays the wallet on Solana.
    #[account(seeds = [ESCROW_AUTH_SEED], bump)]
    pub escrow_auth: UncheckedAccount<'info>,
}

/// Magic Action entrypoint on Solana. Every account (ours and the delegation program's escrow) is
/// read from `remaining_accounts` by address and checked in the handler.
#[derive(Accounts)]
pub struct WalletAction {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::LEDGER_RING;

    #[test]
    fn ledger_remembers_recent_collections_and_forgets_the_oldest() {
        let mut l = Ledger { owner: Pubkey::default(), collected: [0; LEDGER_RING], head: 0, collected_total: 0, paid_total: 0, bump: 0 };
        assert!(!l.has_collected(0), "empty slots never count as collected");
        for i in 0..(LEDGER_RING as u32 + 3) {
            l.push_collected(i | WALLET_TAP_FLAG);
        }
        assert!(!l.has_collected(WALLET_TAP_FLAG), "oldest id was overwritten");
        assert!(l.has_collected(3 | WALLET_TAP_FLAG));
        assert!(l.has_collected((LEDGER_RING as u32 + 2) | WALLET_TAP_FLAG));
    }

    #[test]
    fn action_escrow_matches_the_delegation_program_derivation() {
        let auth = Pubkey::find_program_address(&[ESCROW_AUTH_SEED], &crate::ID).0;
        let expected = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(&auth.to_bytes().into(), ESCROW_INDEX);
        assert_eq!(action_escrow(&auth).to_bytes(), expected.to_bytes());
    }
}
