use anchor_lang::prelude::*;

use super::accounts::*;
use super::constant::*;
use super::errors::ErrorCode;

pub fn initialize(
    ctx: Context<Initialize>,
    m_threshold: u8,
    signers: Vec<[u8; 20]>, // Ethereum addresses (20 bytes)
) -> Result<()> {
    let signers_len = signers.len();

    require!(
        signers_len > 0 && signers_len <= MAX_SIGNERS,
        ErrorCode::InvalidSignersCount
    );
    require!(
        m_threshold > 0 && (m_threshold as usize) <= signers_len,
        ErrorCode::InvalidThreshold
    );

    // Check for duplicate signers
    for i in 0..signers_len {
        for j in (i + 1)..signers_len {
            require!(signers[i] != signers[j], ErrorCode::DuplicateSigner);
        }
    }

    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.m_threshold = m_threshold;
    vault.signers = signers;
    vault.bump = ctx.bumps.vault;

    msg!(
        "Vault initialized: m={}, n={}, authority={}",
        m_threshold,
        signers_len,
        vault.authority
    );

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = authority,
        space = 0,
        owner = system_program::ID,
        seeds = [b"treasury", vault.key().as_ref()],
        bump
    )]
    /// CHECK: Treasury PDA initialized as system-owned account with no data
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
