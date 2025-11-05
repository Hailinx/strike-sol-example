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

    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        instructions::deposit_sol(ctx, amount)
    }

    pub fn withdraw_sol(
        ctx: Context<WithdrawSol>,
        ticket: WithdrawalTicket,
        signers_with_sigs: Vec<SignerWithSignature>,
    ) -> Result<()> {
        instructions::withdraw_sol(ctx, ticket, signers_with_sigs)
    }
}
