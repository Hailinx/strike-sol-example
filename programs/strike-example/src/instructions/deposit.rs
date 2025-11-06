use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use super::accounts::*;
use super::errors::ErrorCode;
use super::models::*;

pub fn deposit<'info>(
    ctx: Context<'_, '_, 'info, 'info, Deposit<'info>>,
    deposits: Vec<AssetAmount>,
    request_id: u64,
) -> Result<()> {
    require!(!deposits.is_empty(), ErrorCode::NoDepositsProvided);

    let vault = &ctx.accounts.vault;

    for deposit_item in deposits {
        require!(deposit_item.amount > 0, ErrorCode::InvalidAmount);

        require!(
            ctx.accounts.vault.whitelisted_assets.contains(&deposit_item.asset), 
            ErrorCode::AssetNotWhitelisted
        );

        match deposit_item.asset {
            Asset::Sol => {
                require!(
                    ctx.accounts.treasury.owner == &system_program::ID,
                    ErrorCode::InvalidTreasuryOwner
                );

                // Instruct trasfer from user -> treasury.
                let ix = anchor_lang::solana_program::system_instruction::transfer(
                    &ctx.accounts.user.key(),
                    &ctx.accounts.treasury.key(),
                    deposit_item.amount,
                );

                anchor_lang::solana_program::program::invoke(
                    &ix,
                    &[
                        ctx.accounts.user.to_account_info(),
                        ctx.accounts.treasury.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;

                msg!(
                    "Deposit SOL: request_id={}, user={}, amount={}, treasury_balance={}",
                    request_id,
                    ctx.accounts.user.key(),
                    deposit_item.amount,
                    ctx.accounts.treasury.to_account_info().lamports()
                );
            }
            Asset::SplToken { mint } => {
                let mut user_token_account: Option<Account<'info, TokenAccount>> = None;
                let mut vault_token_account: Option<Account<'info, TokenAccount>> = None;

                for acc in ctx.remaining_accounts.iter() {
                    if let Ok(token_acc) = Account::<TokenAccount>::try_from(acc) {
                        if token_acc.mint == mint {
                            if token_acc.owner == ctx.accounts.user.key() {
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
                    authority: ctx.accounts.user.to_account_info(),
                };
                let cpi_program = ctx.accounts.token_program.to_account_info();
                let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

                token::transfer(cpi_ctx, deposit_item.amount)?;

                msg!(
                    "Deposit SPL: request_id={}, mint={}, user={}, amount={}, vault_token_balance={}",
                    request_id,
                    mint,
                    user_token.key(),
                    deposit_item.amount,
                    vault_token.to_account_info().lamports()
                );
            }
        }
    }

    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
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

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}
