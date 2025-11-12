use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::accounts::*;
use super::constant::*;
use super::errors::ErrorCode;
use super::models::*;
use super::util::validate_sigs;

pub fn add_asset(
    ctx: Context<AddAsset>,
    ticket: AddAssetTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
) -> Result<()> {
    check_before_admin_update(
        &ctx.accounts.vault,
        &ctx.accounts.payer,
        &ticket,
        &signers_with_sigs,
        ticket.expiry,
        ticket.network_id,
    )?;

    let nonce_account = &mut ctx.accounts.nonce_account;
    require!(!nonce_account.used, ErrorCode::NonceAlreadyUsed);

    nonce_account.used = true;

    let vault = &mut ctx.accounts.vault;

    for existing in &vault.whitelisted_assets {
        if *existing == ticket.asset {
            msg!(
                "Admin request {:?}: asset exists in whitelist: {:?}",
                ticket.request_id,
                ticket.asset
            );
            return Ok(()); // early return since exist.
        }
    }

    vault.whitelisted_assets.push(ticket.asset.clone());
    msg!(
        "Admin request {:?}: asset added to whitelist: {:?}",
        ticket.request_id,
        ticket.asset
    );

    Ok(())
}

pub fn remove_asset(
    ctx: Context<AddAsset>,
    ticket: RemoveAssetTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
) -> Result<()> {
    check_before_admin_update(
        &ctx.accounts.vault,
        &ctx.accounts.payer,
        &ticket,
        &signers_with_sigs,
        ticket.expiry,
        ticket.network_id,
    )?;

    let nonce_account = &mut ctx.accounts.nonce_account;
    require!(!nonce_account.used, ErrorCode::NonceAlreadyUsed);

    nonce_account.used = true;

    let vault = &mut ctx.accounts.vault;

    let pos = vault
        .whitelisted_assets
        .iter()
        .position(|a| *a == ticket.asset);

    if let Some(pos) = pos {
        vault.whitelisted_assets.remove(pos);
        msg!(
            "Admin request {:?}: asset removed from whitelist: {:?}",
            ticket.request_id,
            ticket.asset
        );
    } else {
        msg!(
            "Admin request {:?}: asset not found: {:?}",
            ticket.request_id,
            ticket.asset
        );
    }

    Ok(())
}

pub fn create_vault_token_account(ctx: Context<CreateVaultTokenAccount>) -> Result<()> {
    require!(
        &ctx.accounts.vault.authority == ctx.accounts.payer.key,
        ErrorCode::UnauthorizedUser
    );

    msg!(
        "Vault token account created for mint: {}",
        ctx.accounts.mint.key()
    );
    Ok(())
}

pub fn rotate_validators(
    ctx: Context<RotateValidator>,
    ticket: RotateValidatorTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
) -> Result<()> {
    let signers_len = ticket.signers.len();

    require!(
        signers_len > 0 && signers_len <= MAX_SIGNERS,
        ErrorCode::InvalidSignersCount
    );
    require!(
        ticket.m_threshold > 0 && (ticket.m_threshold as usize) <= signers_len,
        ErrorCode::InvalidThreshold
    );

    // Check for duplicate signers
    for i in 0..signers_len {
        for j in (i + 1)..signers_len {
            require!(
                ticket.signers[i] != ticket.signers[j],
                ErrorCode::DuplicateSigner
            );
        }
    }

    check_before_admin_update(
        &ctx.accounts.vault,
        &ctx.accounts.payer,
        &ticket,
        &signers_with_sigs,
        ticket.expiry,
        ticket.network_id,
    )?;

    let nonce_account = &mut ctx.accounts.nonce_account;
    require!(!nonce_account.used, ErrorCode::NonceAlreadyUsed);

    nonce_account.used = true;

    let vault = &mut ctx.accounts.vault;
    vault.m_threshold = ticket.m_threshold;
    vault.signers = ticket.signers;

    msg!(
        "Admin request {:?}: rotate validators: {:?}, m_threshold: {:?}",
        ticket.request_id,
        signers_len,
        ticket.m_threshold
    );

    Ok(())
}

fn check_before_admin_update(
    vault: &Account<Vault>,
    payer: &Signer,
    ticket: &dyn Ticket,
    signers_with_sigs: &Vec<SignerWithSignature>,
    ticket_expire: i64,
    ticket_network_id: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    require!(
        clock.unix_timestamp <= ticket_expire,
        ErrorCode::TicketExpired
    );
    require!(
        vault.network_id == ticket_network_id,
        ErrorCode::InvalidNetwork
    );
    require!(
        signers_with_sigs.len() == vault.signers.len(),
        ErrorCode::InsufficientSignatures
    );
    require!(&vault.authority == payer.key, ErrorCode::UnauthorizedUser);

    // admin update required all signers approve.
    let validated_sigs = validate_sigs(ticket, signers_with_sigs, &vault.signers);
    require!(
        validated_sigs.len() == vault.signers.len(),
        ErrorCode::InsufficientValidSignatures
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(ticket: AddAssetTicket)]
pub struct AddAsset<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.vault_seed.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

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

#[derive(Accounts)]
#[instruction(ticket: RemoveAssetTicket)]
pub struct RemoveAsset<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.vault_seed.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

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

#[derive(Accounts)]
pub struct CreateVaultTokenAccount<'info> {
    #[account(
        seeds = [b"vault", vault.vault_seed.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(ticket: RotateValidatorTicket)]
pub struct RotateValidator<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.vault_seed.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

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
