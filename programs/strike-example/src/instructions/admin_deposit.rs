use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use super::accounts::*;
use super::errors::ErrorCode;
use super::models::*;
use super::util::validate_sigs;

pub fn admin_deposit<'info>(
    ctx: Context<'_, '_, 'info, 'info, AdminDeposit<'info>>,
    ticket: AdminDepositTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
) -> Result<()> {
    require!(!ticket.deposits.is_empty(), ErrorCode::NoDepositsProvided);

    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;

    require!(ticket.vault == vault.key(), ErrorCode::InvalidVault);
    require!(
        vault.network_id == ticket.network_id,
        ErrorCode::InvalidNetwork
    );
    require!(
        clock.unix_timestamp <= ticket.expiry,
        ErrorCode::TicketExpired
    );

    // Validate the signatures. Check at lease one signer.
    require!(
        signers_with_sigs.len() >= 1,
        ErrorCode::InsufficientSignatures
    );
    let validated_sigs = validate_sigs(&ticket, &signers_with_sigs, &vault.signers);
    require!(
        validated_sigs.len() >= 1,
        ErrorCode::InsufficientValidSignatures
    );

    // Check nonce hasn't been used (replay protection)
    let nonce_account = &mut ctx.accounts.nonce_account;
    require!(!nonce_account.used, ErrorCode::NonceAlreadyUsed);

    // Mark nonce as used BEFORE transfer (prevent reentrancy)
    nonce_account.used = true;

    let vault = &ctx.accounts.vault;

    for deposit_item in ticket.deposits {
        require!(deposit_item.amount > 0, ErrorCode::InvalidAmount);

        require!(
            vault.whitelisted_assets.contains(&deposit_item.asset),
            ErrorCode::AssetNotWhitelisted
        );

        match deposit_item.asset {
            Asset::Sol => {
                // Instruct trasfer from user -> treasury.
                let ix = anchor_lang::solana_program::system_instruction::transfer(
                    &ctx.accounts.payer.key(),
                    &ctx.accounts.treasury.key(),
                    deposit_item.amount,
                );

                anchor_lang::solana_program::program::invoke(
                    &ix,
                    &[
                        ctx.accounts.payer.to_account_info(),
                        ctx.accounts.treasury.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;

                msg!(
                    "Admin Deposit SOL: request_id={}, payer={}, amount={}, treasury_balance={}",
                    ticket.request_id,
                    ctx.accounts.payer.key(),
                    deposit_item.amount,
                    ctx.accounts.treasury.to_account_info().lamports(),
                );
            }
            Asset::SplToken { mint } => {
                let mut user_token_account: Option<Account<'info, TokenAccount>> = None;
                let mut vault_token_account: Option<Account<'info, TokenAccount>> = None;

                for acc in ctx.remaining_accounts.iter() {
                    if let Ok(token_acc) = Account::<TokenAccount>::try_from(acc) {
                        if token_acc.mint == mint {
                            if token_acc.owner == ctx.accounts.payer.key() {
                                user_token_account = Some(token_acc);
                            } else if token_acc.owner == vault.key() {
                                vault_token_account = Some(token_acc);
                            }
                        }
                    }
                }

                let user_token = user_token_account.ok_or(ErrorCode::TokenAccountNotFound)?;
                let vault_token = vault_token_account.ok_or(ErrorCode::TokenAccountNotFound)?;

                let cpi_accounts = Transfer {
                    from: user_token.to_account_info(),
                    to: vault_token.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                };
                let cpi_program = ctx.accounts.token_program.to_account_info();
                let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

                token::transfer(cpi_ctx, deposit_item.amount)?;

                msg!(
                    "Admin Deposit SPL: request_id={}, mint={}, user={}, amount={}, vault_token_balance={}",
                    ticket.request_id,
                    mint,
                    user_token.key(),
                    deposit_item.amount,
                    vault_token.amount,
                );
            }
        }
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(ticket: AdminDepositTicket)]
pub struct AdminDeposit<'info> {
    #[account(
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

    #[account(
        init,
        payer = payer,
        space = 8 + NonceAccount::INIT_SPACE,
        seeds = [b"admin_nonce", vault.key().as_ref(), &ticket.request_id.to_le_bytes()],
        bump
    )]
    pub nonce_account: Account<'info, NonceAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}
