use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use super::accounts::*;
use super::errors::ErrorCode;
use super::models::*;
use super::util::validate_sigs;

pub fn withdraw<'info>(
    ctx: Context<'_, '_, 'info, 'info, Withdraw<'info>>,
    ticket: WithdrawalTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
) -> Result<()> {
    require!(
        !ticket.withdrawals.is_empty(),
        ErrorCode::NoWithdrawalsProvided
    );

    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;

    require!(ticket.vault == vault.key(), ErrorCode::InvalidVault);
    require!(
        vault.network_id == ticket.network_id,
        ErrorCode::InvalidNetwork
    );
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

    // Validate the signatures.
    let validated_sigs = validate_sigs(&ticket, &signers_with_sigs, &vault.signers);

    // Normal recipient. Check M of N.
    require!(
        validated_sigs.len() >= vault.m_threshold as usize,
        ErrorCode::InsufficientValidSignatures
    );

    // Check nonce hasn't been used (replay protection)
    let nonce_account = &mut ctx.accounts.nonce_account;
    require!(!nonce_account.used, ErrorCode::NonceAlreadyUsed);

    // Mark nonce as used BEFORE transfer (prevent reentrancy)
    nonce_account.used = true;

    for withdrawal in ticket.withdrawals {
        require!(withdrawal.amount > 0, ErrorCode::InvalidAmount);

        // Don't check whitelist since withdraw is always allowed.
        match withdrawal.asset {
            Asset::Sol => {
                // Check sufficient balance
                let treasury_balance = ctx.accounts.treasury.lamports();
                let rent_exempt_minimum = Rent::get()?
                    .minimum_balance(ctx.accounts.treasury.to_account_info().data_len());
                let available = treasury_balance.saturating_sub(rent_exempt_minimum);

                require!(available >= withdrawal.amount, ErrorCode::InsufficientFunds);

                // Execute transfer
                **ctx.accounts.treasury.try_borrow_mut_lamports()? -= withdrawal.amount;
                **ctx.accounts.recipient.try_borrow_mut_lamports()? += withdrawal.amount;

                msg!(
                    "Withdrawal SOL: request_id={}, recipient={}, amount={}, valid_signers={}",
                    ticket.request_id,
                    ticket.recipient,
                    withdrawal.amount,
                    validated_sigs.len()
                );
            }
            Asset::SplToken { mint } => {
                let mut recipient_token_account: Option<Account<'info, TokenAccount>> = None;
                let mut vault_token_account: Option<Account<'info, TokenAccount>> = None;

                for acc in ctx.remaining_accounts.iter() {
                    if let Ok(token_acc) = Account::<TokenAccount>::try_from(acc) {
                        if token_acc.mint == mint {
                            if token_acc.owner == ctx.accounts.recipient.key() {
                                recipient_token_account = Some(token_acc);
                            } else if token_acc.owner == vault.key() {
                                vault_token_account = Some(token_acc);
                            }
                        }
                    }
                }

                let vault_token = vault_token_account.ok_or(ErrorCode::TokenAccountNotFound)?;
                let recipient_token =
                    recipient_token_account.ok_or(ErrorCode::TokenAccountNotFound)?;

                require!(
                    vault_token.amount >= withdrawal.amount,
                    ErrorCode::InsufficientFunds
                );

                let seeds = &[b"vault", vault.vault_seed.as_bytes(), &[vault.bump]];
                let signer_seeds = &[&seeds[..]];

                let cpi_accounts = Transfer {
                    from: vault_token.to_account_info(),
                    to: recipient_token.to_account_info(),
                    authority: vault.to_account_info(),
                };
                let cpi_program = ctx.accounts.token_program.to_account_info();
                let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

                token::transfer(cpi_ctx, withdrawal.amount)?;

                msg!(
                    "Withdraw SPL Token: request_id={}, mint={}, recipient={}, amount={}, valid_signers={}",
                    ticket.request_id,
                    mint,
                    ticket.recipient,
                    withdrawal.amount,
                    validated_sigs.len()
                );
            }
        }
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(ticket: WithdrawalTicket)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.vault_seed.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"treasury", vault.key().as_ref()],
        bump = vault.treasury_bump
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
    pub token_program: Program<'info, Token>,
}
