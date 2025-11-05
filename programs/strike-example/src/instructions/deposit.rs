use anchor_lang::prelude::*;

use super::accounts::*;
use super::errors::ErrorCode;

pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);

    // Validate treasury is system-owned.
    require!(
        ctx.accounts.treasury.owner == &system_program::ID,
        ErrorCode::InvalidTreasuryOwner
    );

    // Instruct trasfer from user -> treasury.
    let ix = anchor_lang::solana_program::system_instruction::transfer(
        &ctx.accounts.user.key(),
        &ctx.accounts.treasury.key(),
        amount,
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
        "Deposit: user={}, amount={}, treasury_balance={}",
        ctx.accounts.user.key(),
        amount,
        ctx.accounts.treasury.to_account_info().lamports()
    );

    Ok(())
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
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
}
