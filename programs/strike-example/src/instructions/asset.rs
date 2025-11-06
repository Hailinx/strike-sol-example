use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::accounts::*;
use super::errors::ErrorCode;
use super::models::*;
use super::util::validate_sigs;

pub fn add_asset(
    ctx: Context<AddAsset>,
    ticket: AddAssetTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
) -> Result<()> {
    check_before_update_asset(
        &ctx.accounts.vault,
        &ticket,
        &signers_with_sigs,
        ticket.expiry,
    )?;

    let nonce_account = &mut ctx.accounts.nonce_account;
    require!(!nonce_account.used, ErrorCode::NonceAlreadyUsed);

    nonce_account.used = true;

    let vault = &mut ctx.accounts.vault;

    for existing in &vault.whitelisted_assets {
        if *existing == ticket.asset {
            msg!("Asset exists in whitelist: {:?}", ticket.asset);
            return Ok(()); // early return since exist.
        }
    }

    vault.whitelisted_assets.push(ticket.asset.clone());
    msg!("Asset added to whitelist: {:?}", ticket.asset);

    Ok(())
}

pub fn remove_asset(
    ctx: Context<AddAsset>,
    ticket: RemoveAssetTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
) -> Result<()> {
    check_before_update_asset(
        &ctx.accounts.vault,
        &ticket,
        &signers_with_sigs,
        ticket.expiry,
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
        msg!("Asset removed from whitelist: {:?}", ticket.asset);
    } else {
        msg!("Asset not found: {:?}", ticket.asset);
    }

    Ok(())
}

pub fn create_vault_token_account(ctx: Context<CreateVaultTokenAccount>) -> Result<()> {
    msg!(
        "Vault token account created for mint: {}",
        ctx.accounts.mint.key()
    );
    Ok(())
}

fn check_before_update_asset(
    vault: &Account<Vault>,
    ticket: &dyn Ticket,
    signers_with_sigs: &Vec<SignerWithSignature>,
    ticket_expire: i64,
) -> Result<()> {
    let clock = Clock::get()?;

    require!(
        clock.unix_timestamp <= ticket_expire,
        ErrorCode::TicketExpired
    );
    require!(
        signers_with_sigs.len() != vault.signers.len(),
        ErrorCode::InsufficientSignatures
    );

    let validated_sigs = validate_sigs(ticket, signers_with_sigs, &vault.signers);
    require!(
        validated_sigs.len() != vault.signers.len(),
        ErrorCode::InsufficientValidSignatures
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(ticket: AddAssetTicket)]
pub struct AddAsset<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref()],
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
        seeds = [b"vault", vault.authority.as_ref()],
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
        seeds = [b"vault", vault.authority.as_ref()],
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
