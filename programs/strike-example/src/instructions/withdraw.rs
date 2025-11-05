use std::collections::HashSet;

use anchor_lang::prelude::*;

use super::accounts::*;
use super::errors::ErrorCode;
use super::models::{SignerWithSignature, WithdrawalTicket};
use super::util::validate_sigs;

pub fn withdraw_sol(
    ctx: Context<WithdrawSol>,
    ticket: WithdrawalTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;

    require!(ticket.amount > 0, ErrorCode::InvalidAmount);
    require!(ticket.vault == vault.key(), ErrorCode::InvalidVault);
    require!(
        ticket.recipient == ctx.accounts.recipient.key(),
        ErrorCode::InvalidRecipient
    );
    require!(
        clock.unix_timestamp <= ticket.expiry,
        ErrorCode::TicketExpired
    );
    require!(
        signers_with_sigs.len() >= vault.m_threshold as usize,
        ErrorCode::InsufficientSignatures
    );

    // Check nonce hasn't been used (replay protection)
    let nonce_account = &mut ctx.accounts.nonce_account;
    require!(!nonce_account.used, ErrorCode::NonceAlreadyUsed);

    // Validate the signatures and M of N.
    let mut validated_sigs = HashSet::new();
    for sig in validate_sigs(&ticket, &signers_with_sigs).into_iter() {
        if vault.signers.contains(&sig) {
            validated_sigs.insert(sig);
        }
    }
    require!(
        validated_sigs.len() >= vault.m_threshold as usize,
        ErrorCode::InsufficientValidSignatures
    );

    // Validate treasury ownership
    require!(
        ctx.accounts.treasury.owner == &system_program::ID,
        ErrorCode::InvalidTreasuryOwner
    );

    // Check sufficient balance
    let treasury_balance = ctx.accounts.treasury.lamports();
    let rent_exempt_minimum =
        Rent::get()?.minimum_balance(ctx.accounts.treasury.to_account_info().data_len());
    let available = treasury_balance.saturating_sub(rent_exempt_minimum);

    require!(available >= ticket.amount, ErrorCode::InsufficientFunds);

    // Mark nonce as used BEFORE transfer (prevent reentrancy)
    nonce_account.used = true;

    // Execute transfer
    let vault_key = vault.key();
    let seeds = &[b"treasury", vault_key.as_ref(), &[ctx.bumps.treasury]];
    let signer_seeds = &[&seeds[..]];

    let ix = anchor_lang::solana_program::system_instruction::transfer(
        &ctx.accounts.treasury.key(),
        &ctx.accounts.recipient.key(),
        ticket.amount,
    );

    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.treasury.to_account_info(),
            ctx.accounts.recipient.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    msg!(
        "Withdrawal executed: request_id={}, recipient={}, amount={}, valid_signers={}",
        ticket.request_id,
        ticket.recipient,
        ticket.amount,
        validated_sigs.len()
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(ticket: WithdrawalTicket)]
pub struct WithdrawSol<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"treasury", vault.key().as_ref()],
        bump
    )]
    /// CHECK: Treasury PDA verified by seeds
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Recipient verified against ticket
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + NonceAccount::INIT_SPACE,
        seeds = [b"nonce", vault.key().as_ref(), &ticket.request_id.to_le_bytes()],
        bump
    )]
    pub nonce_account: Account<'info, NonceAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
