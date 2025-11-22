use anchor_lang::prelude::*;

use super::accounts::*;
use super::constant::*;
use super::errors::ErrorCode;

pub fn initialize(
    ctx: Context<Initialize>,
    vault_seed: String,
    network_id: u64,
    m_threshold: u8,
    admin_threshold: u8,
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
    require!(
        admin_threshold > 0 && (admin_threshold as usize) <= signers_len,
        ErrorCode::InvalidThreshold
    );

    // Check for duplicate signers
    for i in 0..signers_len {
        for j in (i + 1)..signers_len {
            require!(signers[i] != signers[j], ErrorCode::DuplicateSigner);
        }
    }

    let vault = &mut ctx.accounts.vault;
    vault.version = CURRENT_VERSION;
    vault.authority = ctx.accounts.authority.key();
    vault.vault_seed = vault_seed;
    vault.network_id = network_id;
    vault.m_threshold = m_threshold;
    vault.admin_threshold = admin_threshold;
    vault.signers = signers;
    vault.bump = ctx.bumps.vault;
    vault.treasury_bump = ctx.bumps.treasury;

    msg!(
        "Vault initialized: m_threshold={}, admin_threshold={}, N={}, authority={}",
        m_threshold,
        admin_threshold,
        signers_len,
        vault.authority
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(vault_seed: String)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", vault_seed.as_bytes()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = authority,
        space = 8,
        seeds = [b"treasury", vault.key().as_ref()],
        bump
    )]
    /// CHECK: Treasury PDA initialized as system-owned account with no data
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
