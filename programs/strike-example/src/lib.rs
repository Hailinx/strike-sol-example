use anchor_lang::prelude::*;

pub mod instructions;

declare_id!("Aq18qW6eoU9ugFtUBcsknFzXpaTapfPL1vSNrxLEieBm");

#[program]
pub mod strike_example {
    use super::*;
    pub use instructions::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        m_threshold: u8,
        signers: Vec<[u8; 20]>, // Ethereum addresses (20 bytes)
    ) -> Result<()> {
        instructions::initialize(ctx, m_threshold, signers)
    }

    pub fn deposit<'info>(
        ctx: Context<'_, '_, 'info, 'info, Deposit<'info>>,
        deposits: Vec<AssetAmount>,
        request_id: u64,
    ) -> Result<()> {
        instructions::deposit(ctx, deposits, request_id)
    }

    pub fn withdraw<'info>(
        ctx: Context<'_, '_, 'info, 'info, Withdraw<'info>>,
        ticket: WithdrawalTicket,
        signers_with_sigs: Vec<SignerWithSignature>,
    ) -> Result<()> {
        instructions::withdraw(ctx, ticket, signers_with_sigs)
    }

    pub fn add_asset(
        ctx: Context<AddAsset>,
        ticket: AddAssetTicket,
        signers_with_sigs: Vec<SignerWithSignature>,
    ) -> Result<()> {
        instructions::add_asset(ctx, ticket, signers_with_sigs)
    }

    pub fn remove_asset(
        ctx: Context<AddAsset>,
        ticket: RemoveAssetTicket,
        signers_with_sigs: Vec<SignerWithSignature>,
    ) -> Result<()> {
        instructions::remove_asset(ctx, ticket, signers_with_sigs)
    }

    pub fn create_vault_token_account(ctx: Context<CreateVaultTokenAccount>) -> Result<()> {
        instructions::create_vault_token_account(ctx)
    }

    pub fn rotate_validators(
        ctx: Context<RotateValidator>,
        ticket: RotateValidatorTicket,
        signers_with_sigs: Vec<SignerWithSignature>,
    ) -> Result<()> {
        instructions::rotate_validators(ctx, ticket, signers_with_sigs)
    }
}
