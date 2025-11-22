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
        &ticket,
        &signers_with_sigs,
        &ticket.vault,
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
    ctx: Context<RemoveAsset>,
    ticket: RemoveAssetTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
) -> Result<()> {
    check_before_admin_update(
        &ctx.accounts.vault,
        &ticket,
        &signers_with_sigs,
        &ticket.vault,
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
    require!(
        ticket.admin_threshold > 0 && (ticket.admin_threshold as usize) <= signers_len,
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
        &ticket,
        &signers_with_sigs,
        &ticket.vault,
        ticket.expiry,
        ticket.network_id,
    )?;

    let nonce_account = &mut ctx.accounts.nonce_account;
    require!(!nonce_account.used, ErrorCode::NonceAlreadyUsed);

    nonce_account.used = true;

    let vault = &mut ctx.accounts.vault;
    vault.m_threshold = ticket.m_threshold;
    vault.admin_threshold = ticket.admin_threshold;
    vault.signers = ticket.signers;

    msg!(
        "Admin request {:?}: rotate validators: {:?}, m_threshold: {:?}, admin_threshold: {:?}",
        ticket.request_id,
        signers_len,
        ticket.m_threshold,
        ticket.admin_threshold,
    );

    Ok(())
}

fn check_before_admin_update(
    vault: &Account<Vault>,
    ticket: &dyn Ticket,
    signers_with_sigs: &Vec<SignerWithSignature>,
    ticket_vault: &Pubkey,
    ticket_expire: i64,
    ticket_network_id: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    require!(ticket_vault == &vault.key(), ErrorCode::InvalidVault);
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

    // admin update required admin_threshold's signers approve.
    let validated_sigs = validate_sigs(ticket, signers_with_sigs, &vault.signers);
    require!(
        validated_sigs.len() >= vault.admin_threshold as usize,
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
        seeds = [b"admin_nonce", vault.key().as_ref(), &ticket.request_id.to_le_bytes()],
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
        seeds = [b"admin_nonce", vault.key().as_ref(), &ticket.request_id.to_le_bytes()],
        bump
    )]
    pub nonce_account: Account<'info, NonceAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
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
        seeds = [b"admin_nonce", vault.key().as_ref(), &ticket.request_id.to_le_bytes()],
        bump
    )]
    pub nonce_account: Account<'info, NonceAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
